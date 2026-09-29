#!/usr/bin/env python3
"""
SpatialStage Helper - splits songs into stems, on this PC, for the
SpatialStage web app (https://princegeit.github.io/spatialstage-web/).

The web page cannot run Demucs itself at a usable speed, so it hands the
song to this program: the page decodes the file the user dropped, sends it
here as a WAV, and fetches the stems back when Demucs is done. Nothing is
uploaded anywhere - the server only listens on 127.0.0.1, and only answers
pages from the SpatialStage site (plus localhost and file:// copies of it).

Split songs are kept in songs/<id>/ (one 16-bit WAV per stem, plus
meta.json), keyed by a hash of the original file and the model, so a song
is only ever split once and shows up in the page's library afterwards.

API, all under http://127.0.0.1:47800/v1 - JSON unless it says otherwise:
  GET    /status                    what this helper is and can do
  GET    /songs                     every song split so far, newest first
  GET    /songs/<id>                one of them; 404 if not split yet
  GET    /songs/<id>/<stem>.wav     one stem (audio/wav)
  DELETE /songs/<id>                forget a split song
  POST   /jobs?key=&model=&name=    body: the song as 16-bit PCM WAV
  POST   /songs/<id>/parts          split a song's drums into kit parts
                                    (kick, snare, toms, hihat, ride, crash +
                                    drums_rest); the first time, this also
                                    installs the drum splitter
  GET    /jobs/<id>                 a split's progress
  DELETE /jobs/<id>                 cancel it
  POST   /led?host=&port=           body: one WLED realtime UDP packet, sent
                                    on to host:port - the page's LED strip
                                    output (browsers cannot send UDP). Only
                                    to addresses on the local network.
<id> is "<key>-<model>", <key> being the page's SHA-256 (hex) of the file.

Environment:
  SPATIALSTAGE_HELPER_HOME     install folder (default: the folder above app/)
  SPATIALSTAGE_HELPER_PORT     default 47800
  SPATIALSTAGE_HELPER_ORIGINS  extra page origins to allow, comma separated
"""

import ipaddress
import json
import os
import re
import socket
import shutil
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.request import urlopen

VERSION = "1.1.0"
HOST = "127.0.0.1"
PORT = int(os.environ.get("SPATIALSTAGE_HELPER_PORT", "47800"))
APP_DIR = Path(__file__).resolve().parent
HOME = Path(os.environ.get("SPATIALSTAGE_HELPER_HOME") or APP_DIR.parent).resolve()
SONGS_DIR = HOME / "songs"
WORK_DIR = HOME / "work"
WORKER = APP_DIR / "separate_worker.py"
DRUMS_WORKER = APP_DIR / "drums_worker.py"
DRUM_MODEL_DIR = HOME / "models" / "drumsep"
DRUM_MODEL = "MDX23C-DrumSep-aufr33-jarredou.ckpt"
# The same audio-separator the Pd rig's drum splitter runs (pipeline/.venv-drumsep).
DRUMSEP_PACKAGE = "audio-separator[cpu]==0.47.0"
PARTS = ["kick", "snare", "toms", "hihat", "ride", "crash"]
LEFTOVER = "drums_rest"
MAX_UPLOAD = 1024 ** 3  # ~100 minutes of 16-bit stereo

MODELS = {
    "htdemucs_6s": {"label": "6 stems (vocals, drums, bass, guitar, piano, other)",
                    "stems": ["vocals", "drums", "bass", "guitar", "piano", "other"]},
    "htdemucs": {"label": "4 stems, a bit faster", "stems": ["vocals", "drums", "bass", "other"]},
    "htdemucs_ft": {"label": "4 stems, cleaner, about 4x slower", "stems": ["vocals", "drums", "bass", "other"]},
}
DEFAULT_MODEL = "htdemucs_6s"

ALLOWED_ORIGINS = {"https://princegeit.github.io", "null"}  # "null" = the page opened from a file
ALLOWED_ORIGINS |= {o.strip().rstrip("/") for o in os.environ.get("SPATIALSTAGE_HELPER_ORIGINS", "").split(",") if o.strip()}
LOCAL_ORIGIN = re.compile(r"^http://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")
KEY_RE = re.compile(r"^[0-9a-f]{16,64}$")
SONG_ID_RE = re.compile(r"^([0-9a-f]{16,64})-(" + "|".join(map(re.escape, MODELS)) + r")$")
STEM_RE = re.compile(r"^[a-z]+$")


def log(text):
    print(time.strftime("%H:%M:%S ") + text, flush=True)


def fmt_secs(s):
    s = int(round(s))
    return f"{s // 60}:{s % 60:02d}"


# ---------------------------------------------------------------- songs --

def read_meta(song_dir):
    try:
        with open(song_dir / "meta.json", encoding="utf-8") as f:
            meta = json.load(f)
    except (OSError, ValueError):
        return None
    if not all((song_dir / f"{s}.wav").is_file() for s in meta.get("stems", [])):
        return None
    return meta


def list_songs():
    out = []
    if SONGS_DIR.is_dir():
        for d in SONGS_DIR.iterdir():
            if d.is_dir() and SONG_ID_RE.match(d.name):
                meta = read_meta(d)
                if meta:
                    out.append(meta)
    return sorted(out, key=lambda m: m.get("created", 0), reverse=True)


# ----------------------------------------------------------------- jobs --

class Job:
    def __init__(self, song_id, key, model, name, wav_path, kind="split"):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind             # split: song -> stems; parts: drums -> kit parts
        self.song_id, self.key, self.model, self.name = song_id, key, model, name
        self.wav_path = wav_path
        self.state = "queued"        # queued | running | done | error | cancelled
        self.progress = 0.0
        self.message = "waiting for the song before it"
        self.error = None
        self.created = time.time()
        self.finished = None
        self.proc = None

    def view(self):
        return {"id": self.id, "kind": self.kind, "songId": self.song_id, "name": self.name, "model": self.model,
                "state": self.state, "progress": round(self.progress, 4), "message": self.message,
                "error": self.error, "queuePosition": queue_position(self)}


jobs = {}
pending = deque()
jobs_lock = threading.Lock()
wake = threading.Event()


def queue_position(job):
    with jobs_lock:
        return list(pending).index(job) + 1 if job in pending else 0


def active_job_for(song_id, kind="split"):
    with jobs_lock:
        for j in jobs.values():
            if j.song_id == song_id and j.kind == kind and j.state in ("queued", "running"):
                return j
    return None


def forget_old_jobs():
    cutoff = time.time() - 3600
    with jobs_lock:
        for jid in [k for k, j in jobs.items() if j.finished and j.finished < cutoff]:
            del jobs[jid]


def worker_env():
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")
    env.setdefault("HF_HOME", str(HOME / "models"))
    env.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    env.setdefault("HF_HUB_VERBOSITY", "error")
    return env


def worker_flags():
    # No console window of its own, and below-normal priority so the PC
    # (and the song playing in the browser) stay responsive while every
    # core works on the split.
    if os.name == "nt":
        return subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS
    return 0


def run_worker(job, cmd):
    """Runs one worker process for a job, relaying its STATUS/PROGRESS lines.
    Returns (exit code, result dict or None, error text or None, tail)."""
    result, error, tail = None, None, deque(maxlen=15)
    try:
        job.proc = subprocess.Popen(cmd, env=worker_env(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, creationflags=worker_flags())
        for raw in job.proc.stdout:
            line = raw.decode("utf-8", "replace").rstrip()
            kind, _, rest = line.partition(" ")
            if kind == "PROGRESS":
                try:
                    job.progress = max(job.progress, min(1.0, float(rest)))
                except ValueError:
                    pass
            elif kind == "STATUS":
                job.message = rest
            elif kind == "RESULT":
                try:
                    result = json.loads(rest)
                except ValueError:
                    error = "the worker sent an unreadable result"
            elif kind == "ERROR":
                error = rest
            elif line:
                tail.append(line)
        code = job.proc.wait()
    except OSError as e:
        code, error = -1, f"could not start the worker: {e}"
    return code, result, error, tail


def fail_job(job, error, code, tail):
    job.state = "error"
    job.error = error or (tail[-1] if tail else f"the worker stopped (exit code {code})")
    job.message = "failed"
    log(f"FAILED '{job.name}': {job.error}")
    for t in tail:
        log("   " + t)


def run_job(job):
    if job.kind == "parts":
        return run_parts_job(job)
    tmp = WORK_DIR / f"{job.id}.out"
    shutil.rmtree(tmp, ignore_errors=True)
    cmd = [sys.executable, "-u", str(WORKER), "--input", str(job.wav_path), "--out", str(tmp), "--model", job.model]
    started = time.time()
    job.state, job.message = "running", "starting"
    log(f"Splitting '{job.name}' ({job.model})...")
    try:
        code, result, error, tail = run_worker(job, cmd)
    finally:
        try:
            job.wav_path.unlink()
        except OSError:
            pass

    if job.state == "cancelled":
        shutil.rmtree(tmp, ignore_errors=True)
        log(f"Cancelled '{job.name}'.")
        return
    if code != 0 or not result:
        shutil.rmtree(tmp, ignore_errors=True)
        return fail_job(job, error, code, tail)

    meta = {"id": job.song_id, "key": job.key, "model": job.model, "name": job.name,
            "stems": result["stems"], "sampleRate": result["sampleRate"], "duration": result["duration"],
            "device": result.get("device"), "splitSeconds": result.get("seconds"), "created": time.time()}
    with open(tmp / "meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)
    final = SONGS_DIR / job.song_id
    shutil.rmtree(final, ignore_errors=True)
    tmp.replace(final)
    job.progress, job.state, job.message = 1.0, "done", "done"
    log(f"Done '{job.name}' in {fmt_secs(time.time() - started)} "
        f"({fmt_secs(result['duration'])} of audio, {result.get('device', 'cpu')}).")


# --------------------------------------------------------- drum parts --

drumsep = {"installed": None}   # None until checked


def drumsep_installed():
    if drumsep["installed"] is None:
        try:
            r = subprocess.run([sys.executable, "-c", "import audio_separator, soundfile"], capture_output=True,
                               timeout=120, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            drumsep["installed"] = r.returncode == 0
        except Exception:
            drumsep["installed"] = False
    return drumsep["installed"]


def install_drumsep(job):
    """pip install audio-separator into the helper's own Python, the first
    time drum parts are asked for - people who never split drums should not
    have to download it."""
    job.message = "installing the drum splitter (one time, a few minutes)"
    log("Installing the drum splitter (audio-separator)...")
    cmd = [sys.executable, "-m", "pip", "install", "--no-warn-script-location", "--disable-pip-version-check",
           DRUMSEP_PACKAGE]
    code, _, _, tail = run_worker(job, cmd)
    drumsep["installed"] = None
    if job.state == "cancelled":
        return False
    if code != 0 or not drumsep_installed():
        fail_job(job, "could not install the drum splitter: " + (tail[-1] if tail else f"pip exit code {code}"), code, tail)
        return False
    log("Drum splitter installed.")
    return True


def run_parts_job(job):
    song_dir = SONGS_DIR / job.song_id
    job.state, job.message = "running", "starting"
    if not drumsep_installed() and not install_drumsep(job):
        return
    if job.state == "cancelled":
        return
    job.progress = 0.0
    started = time.time()
    log(f"Splitting the drums of '{job.name}'...")
    cmd = [sys.executable, "-u", str(DRUMS_WORKER), "--song-dir", str(song_dir), "--model-dir", str(DRUM_MODEL_DIR)]
    code, result, error, tail = run_worker(job, cmd)
    shutil.rmtree(song_dir / "_drumsep", ignore_errors=True)
    if job.state == "cancelled":
        log(f"Cancelled the drums of '{job.name}'.")
        return
    if code != 0 or not result:
        return fail_job(job, error, code, tail)
    meta = read_meta(song_dir)
    if not meta:
        return fail_job(job, "the song's stems went missing", 0, tail)
    meta["stems"] = [s for s in meta["stems"] if s not in PARTS and s != LEFTOVER] + PARTS + [LEFTOVER]
    meta["parts"] = True
    with open(song_dir / "meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)
    job.progress, job.state, job.message = 1.0, "done", "done"
    log(f"Drum parts for '{job.name}' in {fmt_secs(time.time() - started)}.")


# ------------------------------------------------------------- LED relay --

led_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
led_hosts = {}   # name -> (address or None, checked at)


def led_address(host):
    """The IPv4 address to send to, or None unless it is on the local
    network - the relay must not become a way for a page to send packets
    to the internet."""
    now = time.time()
    hit = led_hosts.get(host)
    if hit and now - hit[1] < 60:
        return hit[0]
    try:
        addr = socket.gethostbyname(host)
        ip = ipaddress.ip_address(addr)
        ok = ip.version == 4 and (ip.is_private or ip.is_link_local) and not ip.is_loopback
    except (OSError, ValueError):
        ok, addr = False, None
    led_hosts[host] = (addr if ok else None, now)
    return addr if ok else None


def job_loop():
    while True:
        wake.wait()
        while True:
            with jobs_lock:
                job = pending.popleft() if pending else None
                if not job:
                    wake.clear()
                    break
            if job.state == "queued":
                try:
                    run_job(job)
                except Exception as e:  # never let one song stop the queue
                    job.state, job.error, job.message = "error", str(e), "failed"
                    log(f"FAILED '{job.name}': {e}")
                job.finished = time.time()
                job.proc = None
        forget_old_jobs()


# --------------------------------------------------------- device check --

device_info = {"device": "checking", "name": None}


def check_device():
    try:
        out = subprocess.run([sys.executable, "-c",
                              "import torch, json; c = torch.cuda.is_available(); "
                              "print(json.dumps({'device': 'cuda' if c else 'cpu', "
                              "'name': torch.cuda.get_device_name(0) if c else None, 'torch': torch.__version__}))"],
                             capture_output=True, timeout=180,
                             creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        device_info.update(json.loads(out.stdout.decode().strip().splitlines()[-1]))
    except Exception as e:
        device_info.update({"device": "unknown", "error": str(e)})
    d = device_info
    log(f"Separating on: {'GPU - ' + d['name'] if d.get('device') == 'cuda' else d.get('device', '?').upper()}"
        + (f" (torch {d['torch']})" if d.get("torch") else ""))


def model_downloaded(model):
    hub = Path(os.environ.get("HF_HOME", HOME / "models")) / "hub"
    repo = "HTDemucs" if model == "htdemucs" else "HTDemucs-" + model[len("htdemucs_"):]
    return (hub / f"models--adefossez--{repo}").is_dir()


# ----------------------------------------------------------------- HTTP --

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "SpatialStageHelper/" + VERSION

    def log_message(self, fmt, *args):  # the console shows splits, not every poll
        pass

    # --- access control ---

    def origin_ok(self):
        origin = self.headers.get("Origin")
        if origin is None:
            return True  # not a cross-site browser request (curl, the address bar)
        origin = origin.rstrip("/")
        return origin in ALLOWED_ORIGINS or bool(LOCAL_ORIGIN.match(origin))

    def host_ok(self):
        # Refuses DNS-rebinding tricks: a hostile page whose own domain has
        # been pointed at 127.0.0.1 still sends its domain as the Host.
        host = (self.headers.get("Host") or "").lower()
        return host in (f"127.0.0.1:{PORT}", f"localhost:{PORT}", f"[::1]:{PORT}")

    def cors_headers(self):
        origin = self.headers.get("Origin")
        if origin and self.origin_ok():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Expose-Headers", "Content-Length")

    # --- responses ---

    def send_json(self, code, obj, close=False):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def fail(self, code, text, close=False):
        self.send_json(code, {"error": text}, close=close)

    def guard(self, write=False):
        if not self.host_ok():
            self.fail(403, "wrong host", close=True)
            return False
        # Anything that changes state needs a page we trust; reads are
        # only refused to pages we do not.
        if not self.origin_ok() or (write and self.headers.get("Origin") is None and self.headers.get("Sec-Fetch-Site") == "cross-site"):
            self.fail(403, "this page is not allowed to use the SpatialStage helper", close=True)
            return False
        return True

    def do_OPTIONS(self):
        if not self.host_ok() or not self.origin_ok():
            self.fail(403, "not allowed", close=True)
            return
        self.send_response(204)
        self.cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Chrome's private/local network access preflight.
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def route(self):
        parts = urlsplit(self.path)
        segs = [s for s in parts.path.split("/") if s]
        if not segs or segs[0] != "v1":
            return None, parse_qs(parts.query)
        return segs[1:], parse_qs(parts.query)

    def do_GET(self):
        if not self.guard():
            return
        segs, _ = self.route()
        if segs == ["status"]:
            with jobs_lock:
                active = [j.view() for j in jobs.values() if j.state in ("queued", "running")]
            return self.send_json(200, {
                "app": "spatialstage-helper", "version": VERSION, "device": device_info.get("device"),
                "deviceName": device_info.get("name"), "torch": device_info.get("torch"),
                "models": [{"id": k, "label": v["label"], "stems": v["stems"], "downloaded": model_downloaded(k)}
                           for k, v in MODELS.items()],
                "defaultModel": DEFAULT_MODEL, "jobs": active, "songCount": len(list_songs()),
                "features": ["parts", "led"],
                "parts": {"installed": drumsep["installed"], "modelDownloaded": (DRUM_MODEL_DIR / DRUM_MODEL).is_file()},
            })
        if segs == ["songs"]:
            return self.send_json(200, {"songs": list_songs()})
        if segs and len(segs) in (2, 3) and segs[0] == "songs" and SONG_ID_RE.match(segs[1]):
            meta = read_meta(SONGS_DIR / segs[1])
            if not meta:
                return self.fail(404, "not split yet")
            if len(segs) == 2:
                return self.send_json(200, meta)
            stem = segs[2][:-4] if segs[2].endswith(".wav") else ""
            if not STEM_RE.match(stem) or stem not in meta["stems"]:
                return self.fail(404, "no such stem")
            return self.send_file(SONGS_DIR / segs[1] / f"{stem}.wav")
        if segs and len(segs) == 2 and segs[0] == "jobs":
            job = jobs.get(segs[1])
            return self.send_json(200, job.view()) if job else self.fail(404, "no such job")
        self.fail(404, "not found")

    def send_file(self, path):
        size = path.stat().st_size
        self.send_response(200)
        self.cors_headers()
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile, 1 << 20)

    def do_DELETE(self):
        if not self.guard(write=True):
            return
        segs, _ = self.route()
        if segs and len(segs) == 2 and segs[0] == "jobs":
            job = jobs.get(segs[1])
            if not job:
                return self.fail(404, "no such job")
            if job.state in ("queued", "running"):
                job.state, job.message = "cancelled", "cancelled"
                job.finished = time.time()
                with jobs_lock:
                    if job in pending:
                        pending.remove(job)
                if job.proc:
                    try:
                        job.proc.kill()
                    except OSError:
                        pass
            return self.send_json(200, job.view())
        if segs and len(segs) == 2 and segs[0] == "songs" and SONG_ID_RE.match(segs[1]):
            shutil.rmtree(SONGS_DIR / segs[1], ignore_errors=True)
            return self.send_json(200, {"deleted": segs[1]})
        self.fail(404, "not found")

    def do_POST(self):
        if not self.guard(write=True):
            return
        segs, q = self.route()
        if segs == ["led"]:
            return self.post_led(q)
        if segs and len(segs) == 3 and segs[0] == "songs" and segs[2] == "parts" and SONG_ID_RE.match(segs[1]):
            return self.post_parts(segs[1])
        if segs != ["jobs"]:
            return self.fail(404, "not found", close=True)
        key = (q.get("key") or [""])[0].lower()
        model = (q.get("model") or [DEFAULT_MODEL])[0]
        name = ((q.get("name") or ["Untitled"])[0] or "Untitled")[:200]
        if not KEY_RE.match(key) or model not in MODELS:
            return self.fail(400, "bad key or model", close=True)
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.fail(411, "Content-Length required", close=True)
        if length <= 44 or length > MAX_UPLOAD:
            return self.fail(413, "the song must be a WAV under 1 GB", close=True)
        song_id = f"{key}-{model}"

        existing = active_job_for(song_id)
        cached = read_meta(SONGS_DIR / song_id)
        if existing or cached:
            self.discard_body(length)
            if existing:
                return self.send_json(200, existing.view())
            job = Job(song_id, key, model, cached.get("name", name), None)
            job.state, job.progress, job.message, job.finished = "done", 1.0, "already split", time.time()
            with jobs_lock:
                jobs[job.id] = job
            return self.send_json(200, job.view())

        WORK_DIR.mkdir(parents=True, exist_ok=True)
        job = Job(song_id, key, model, name, None)
        wav_path = WORK_DIR / f"{job.id}.wav"
        remaining = length
        with open(wav_path, "wb") as f:
            first = True
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 1 << 20))
                if not chunk:
                    break
                if first and (chunk[:4] != b"RIFF" or chunk[8:12] != b"WAVE"):
                    f.close()
                    wav_path.unlink(missing_ok=True)
                    return self.fail(415, "expected a WAV file", close=True)
                first = False
                f.write(chunk)
                remaining -= len(chunk)
        if remaining:
            wav_path.unlink(missing_ok=True)
            return self.fail(400, "upload cut short", close=True)
        job.wav_path = wav_path
        with jobs_lock:
            jobs[job.id] = job
            pending.append(job)
        wake.set()
        log(f"Queued '{name}'.")
        self.send_json(202, job.view())

    def post_parts(self, song_id):
        self.discard_body(int(self.headers.get("Content-Length") or 0))
        meta = read_meta(SONGS_DIR / song_id)
        if not meta:
            return self.fail(404, "not split yet")
        if "drums" not in meta.get("stems", []):
            return self.fail(400, "this song has no drums stem to split")
        existing = active_job_for(song_id, "parts")
        if existing:
            return self.send_json(200, existing.view())
        job = Job(song_id, meta.get("key"), meta.get("model"), meta.get("name", "Untitled"), None, kind="parts")
        if meta.get("parts"):
            job.state, job.progress, job.message, job.finished = "done", 1.0, "already split", time.time()
            with jobs_lock:
                jobs[job.id] = job
            return self.send_json(200, job.view())
        with jobs_lock:
            jobs[job.id] = job
            pending.append(job)
        wake.set()
        log(f"Queued the drums of '{job.name}'.")
        self.send_json(202, job.view())

    def post_led(self, q):
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.fail(411, "Content-Length required", close=True)
        if length < 3 or length > 65000:
            self.discard_body(max(0, length))
            return self.fail(413, "not an LED packet")
        body = self.rfile.read(length)
        host = (q.get("host") or [""])[0].strip()
        try:
            port = int((q.get("port") or ["21324"])[0])
        except ValueError:
            port = 0
        if not 1024 <= port <= 65535:
            return self.fail(400, "the LED port must be 1024-65535 (WLED uses 21324)")
        addr = led_address(host) if host else None
        if not addr:
            return self.fail(400, "the LED host must be an address on your local network")
        try:
            led_sock.sendto(body, (addr, port))
        except OSError as e:
            return self.fail(502, f"could not send to {host}: {e}")
        self.send_response(204)
        self.cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def discard_body(self, length):
        while length > 0:
            chunk = self.rfile.read(min(length, 1 << 20))
            if not chunk:
                break
            length -= len(chunk)


# ----------------------------------------------------------------- main --

def already_running():
    try:
        with urlopen(f"http://{HOST}:{PORT}/v1/status", timeout=2) as r:
            return json.load(r).get("app") == "spatialstage-helper"
    except Exception:
        return False


def main():
    print(f"SpatialStage Helper {VERSION}")
    if already_running():
        print("It is already running - nothing to do. This window closes in a few seconds.")
        time.sleep(4)
        return 0
    SONGS_DIR.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(WORK_DIR, ignore_errors=True)  # leftovers from a run that was closed mid-split
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as e:
        print(f"Could not listen on {HOST}:{PORT} ({e}). Is another program using that port?")
        return 1
    server.daemon_threads = True
    threading.Thread(target=job_loop, daemon=True).start()
    threading.Thread(target=check_device, daemon=True).start()
    print(f"Listening on http://{HOST}:{PORT} - only this PC can reach it.")
    print(f"Split songs are kept in {SONGS_DIR}")
    print("Open the SpatialStage page and drop a song. Keep this window open while you use it;")
    print("close it (or press Ctrl+C) to stop the helper.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        with jobs_lock:
            running = [j for j in jobs.values() if j.proc]
        for j in running:
            try:
                j.proc.kill()
            except OSError:
                pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
