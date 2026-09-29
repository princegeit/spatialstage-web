#!/usr/bin/env python3
"""
Splits a split song's drums into kit parts for spatialstage_helper.py - the
web app's copy of the Pd rig's pipeline/split_drums.py (same model, same
sectioning, same crossfades), writing into the helper's song folder instead
of the rig's stem cache.

  drums_worker.py --song-dir DIR --model-dir DIR [--overlap 2]

DIR/drums.wav (Demucs' drums stem) -> MDX23C DrumSep -> DIR/kick, snare,
toms, hihat, ride, crash .wav, plus DIR/drums_rest.wav: the drums minus the
six parts - whatever the model did not assign (shakers, claps, bleed). The
page plays drums_rest on the drums card once a song has parts, so nothing is
heard twice and nothing is lost.

Only the sections where the drums play go through the model, in pieces of
up to a minute, crossfaded at the seams - on a CPU the model runs at roughly
7x the length of what it is given, so skipping silence matters.

Needs audio-separator (the helper installs it the first time drum parts are
asked for) and downloads the model (~420 MB) on first use into --model-dir.

Talks to the helper on stdout exactly like separate_worker.py:
  STATUS <text> / PROGRESS <0..1> / RESULT <json> / ERROR <text>
and exits when the helper process has gone.
"""

import argparse
import json
import logging
import os
import re
import shutil
import sys
import threading
import time
import traceback
from pathlib import Path

import numpy as np

PARTS = ["kick", "snare", "toms", "hihat", "ride", "crash"]
LEFTOVER = "drums_rest"
MODEL = "MDX23C-DrumSep-aufr33-jarredou.ckpt"
PART_LABELS = {
    "kick": "kick", "snare": "snare", "toms": "toms", "tom": "toms",
    "hh": "hihat", "hihat": "hihat", "hi-hat": "hihat",
    "ride": "ride", "crash": "crash",
}
# split_drums.py's numbers - see its comments for how they were chosen.
SILENCE_DB = -60.0
SECTION_MARGIN_S = 1.0
SECTION_GAP_S = 3.0
PIECE_S = 60.0
PIECE_OVERLAP_S = 2.0


def say(kind, text):
    print(f"{kind} {text}", flush=True)


def watch_parent():
    """Exit when the helper does. Not by reading stdin to its end, as
    separate_worker.py does: on Windows a thread blocked reading stdin makes
    every subprocess started meanwhile hang (CPython duplicating the std
    handles waits on the pending read), and audio-separator starts ffmpeg
    while it sets up - the worker froze there. Waiting on the parent
    process itself touches no handle anyone else uses."""
    ppid = os.getppid()
    if os.name == "nt":
        import ctypes
        k32 = ctypes.windll.kernel32
        handle = k32.OpenProcess(0x00100000, False, ppid)   # SYNCHRONIZE
        if not handle:
            return
        k32.WaitForSingleObject(handle, 0xFFFFFFFF)
    else:
        while os.getppid() == ppid:
            time.sleep(2)
    os._exit(3)


def fit(x, frames):
    if x.shape[1] == 1:
        x = np.repeat(x, 2, axis=1)
    x = x[:, :2]
    if len(x) < frames:
        x = np.concatenate([x, np.zeros((frames - len(x), 2), dtype=x.dtype)])
    return x[:frames]


def find_sections(drums, sr):
    hop = int(sr * 0.05)
    n = len(drums) // hop
    if n == 0:
        return []
    rms = np.sqrt(np.mean(drums[: n * hop].reshape(n, hop, -1) ** 2, axis=(1, 2)))
    playing = 20 * np.log10(rms + 1e-12) > SILENCE_DB
    pad, gap = int(SECTION_MARGIN_S / 0.05), int(SECTION_GAP_S / 0.05)
    sections = []
    i = 0
    while i < n:
        if not playing[i]:
            i += 1
            continue
        j = i
        while j < n and playing[j]:
            j += 1
        s, e = max(0, i - pad), min(n, j + pad)
        if sections and s - sections[-1][1] < gap:
            sections[-1][1] = max(sections[-1][1], e)
        else:
            sections.append([s, e])
        i = j
    return [(s * hop, len(drums) if e == n else e * hop) for s, e in sections]


def pieces_of(start, end, sr):
    length, ov = int(PIECE_S * sr), int(PIECE_OVERLAP_S * sr)
    if end - start <= length:
        return [(start, end)]
    out, s = [], start
    while True:
        e = min(end, s + length)
        out.append((s, e))
        if e == end:
            return out
        s = e - ov


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--song-dir", required=True)
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--overlap", type=int, default=2)
    args = ap.parse_args()
    threading.Thread(target=watch_parent, daemon=True).start()

    import soundfile as sf

    song_dir = Path(args.song_dir)
    work = song_dir / "_drumsep"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    say("STATUS", "reading the drums")
    drums, sr = sf.read(song_dir / "drums.wav", always_2d=True, dtype="float32")
    drums = fit(drums, len(drums))
    sections = find_sections(drums, sr)
    pieces = [p for s, e in sections for p in pieces_of(s, e, sr)]
    to_run = sum(e - s for s, e in pieces)
    skipped = 100 - 100 * sum(e - s for s, e in sections) / max(1, len(drums))

    started = time.time()
    outs = []
    if pieces:
        say("STATUS", "loading the drum model (the first run downloads ~420 MB)")
        from audio_separator.separator import Separator
        Path(args.model_dir).mkdir(parents=True, exist_ok=True)
        sep = Separator(output_dir=str(work), model_file_dir=args.model_dir,
                        output_format="WAV", log_level=logging.WARNING,
                        mdxc_params={"segment_size": 256, "override_model_segment_size": False,
                                     "batch_size": None, "overlap": args.overlap, "pitch_shift": 0})
        sep.load_model(model_filename=MODEL)
    done_frames = 0
    for k, (s, e) in enumerate(pieces, 1):
        left = ""
        if done_frames:
            rate = (time.time() - started) / done_frames
            left = f", about {max(1, round((to_run - done_frames) * rate / 60))} min left"
        say("STATUS", f"splitting drums: piece {k} of {len(pieces)}{left} ({skipped:.0f}% skipped as silent)")
        say("PROGRESS", f"{0.98 * done_frames / max(1, to_run):.4f}")
        src = work / f"piece{k}.wav"
        sf.write(src, drums[s:e], sr, subtype="FLOAT")
        found = {}
        for out in sep.separate(str(src)):
            path = Path(out)
            if not path.is_absolute():
                path = work / path.name
            m = re.search(r"_\(([^)]+)\)", path.name)
            key = PART_LABELS.get(m.group(1).strip().lower()) if m else None
            if key:
                found[key] = path
        missing = [p for p in PARTS if p not in found]
        if missing:
            raise RuntimeError(f"the drum model gave no {', '.join(missing)}")
        outs.append(((s, e), found))
        done_frames += e - s

    say("STATUS", "writing the drum parts")
    ov = int(PIECE_OVERLAP_S * sr)
    parts = {p: np.zeros_like(drums) for p in PARTS}
    weight = np.zeros(len(drums), dtype=np.float32)
    spans = [span for span, _ in outs]
    for (s, e), found in outs:
        win = np.ones(e - s, dtype=np.float32)
        if any(pe > s and ps < s for ps, pe in spans):
            win[:ov] = np.linspace(0, 1, ov, dtype=np.float32)
        if any(ps < e and pe > e for ps, pe in spans):
            win[-ov:] = np.minimum(win[-ov:], np.linspace(1, 0, ov, dtype=np.float32))
        for p in PARTS:
            x, sr_p = sf.read(found[p], always_2d=True, dtype="float32")
            if sr_p != sr:
                raise RuntimeError(f"{p} came back at {sr_p} Hz, the drums are {sr} Hz")
            parts[p][s:e] += fit(x, e - s) * win[:, None]
        weight[s:e] += win
    scale = np.where(weight > 0, 1.0 / np.maximum(weight, 1e-6), 0.0).astype(np.float32)[:, None]
    total = np.zeros_like(drums)
    staged = []
    for p in PARTS:
        x = parts[p] * scale
        total += x
        staged.append((p, x))
    staged.append((LEFTOVER, drums - total))
    # Temporary names first, renamed at the end: a crash halfway never leaves
    # a folder that looks as if it had its parts.
    for name, x in staged:
        sf.write(song_dir / f"{name}.tmp.wav", np.clip(x, -1.0, 1.0), sr, subtype="PCM_16")
    for name, _ in staged:
        os.replace(song_dir / f"{name}.tmp.wav", song_dir / f"{name}.wav")
    shutil.rmtree(work, ignore_errors=True)
    say("PROGRESS", "1")
    say("RESULT", json.dumps({"stems": PARTS + [LEFTOVER], "seconds": round(time.time() - started, 1),
                              "skippedPercent": round(skipped)}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        say("ERROR", str(e) or e.__class__.__name__)
        sys.exit(1)
