#!/usr/bin/env python3
"""
Splits one song into stems for spatialstage_helper.py.

  separate_worker.py --input SONG.wav --out DIR [--model htdemucs_6s]

Runs as its own process, once per song, so a split can be cancelled by
killing it, a crash never takes the helper down with it, and the model's
memory is handed back to the system when the song is done.

The input is always 16-bit PCM WAV: the web page decodes whatever the user
dropped (mp3, m4a, flac...) with the browser's own decoder and sends that,
so nothing here needs ffmpeg. The stems are written the same way, one
<stem>.wav per source the model produces, clipped the way the Demucs
command line does it by default (--clip-mode rescale).

Talks to the helper on stdout, one line per message:
  STATUS <text>          what it is doing now
  PROGRESS <0..1>        fraction of the separation done
  RESULT <json>          finished: { stems, sampleRate, duration, device }
  ERROR <text>           gave up (exit code 1)
It also watches stdin: the helper never writes to it, so end-of-file means
the helper has gone (window closed, crashed) and this exits instead of
carrying on as an orphan burning every CPU core.
"""

import argparse
import json
import os
import sys
import threading
import time
import traceback
import wave
from pathlib import Path

import numpy as np


def say(kind, text):
    print(f"{kind} {text}", flush=True)


def watch_parent():
    try:
        sys.stdin.read()
    except Exception:
        pass
    os._exit(3)


def read_wav(path):
    with wave.open(str(path), "rb") as w:
        channels, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        if w.getcomptype() != "NONE" or width != 2:
            raise ValueError("expected a 16-bit PCM WAV")
        raw = w.readframes(frames)
    data = np.frombuffer(raw, dtype="<i2").reshape(-1, channels).T.astype(np.float32) / 32768.0
    if channels == 1:
        data = np.vstack([data, data])
    elif channels > 2:
        data = data[:2]
    return np.ascontiguousarray(data), rate


def write_wav(path, x, rate):
    peak = float(np.abs(x).max()) if x.size else 0.0
    if peak > 0.999:
        x = x / (1.01 * peak)
    pcm = np.clip(np.round(x.T * 32767.0), -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(x.shape[0])
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="htdemucs_6s")
    args = ap.parse_args()
    threading.Thread(target=watch_parent, daemon=True).start()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    say("STATUS", "reading the song")
    wav, rate = read_wav(args.input)
    if wav.shape[1] < rate:
        raise ValueError("the song is shorter than a second")

    say("STATUS", "loading Demucs")
    import torch
    from demucs.api import Separator

    device = "cuda" if torch.cuda.is_available() else "cpu"

    # Demucs reports each ~8 s segment as it starts and ends; segments run
    # in order, so the last finished offset over the song length is the
    # fraction done, spread across the models of a bag (htdemucs_ft has 4).
    last = [0.0]

    def on_segment(d):
        if d.get("state") != "end":
            return
        models = max(1, int(d.get("models", 1)))
        length = max(1, int(d.get("audio_length", 1)))
        frac = min(1.0, d.get("segment_offset", 0) / length)
        done = (d.get("model_idx_in_bag", 0) + frac) / models
        if done - last[0] >= 0.005:
            last[0] = done
            say("PROGRESS", f"{min(done, 0.99):.4f}")

    say("STATUS", "loading the model (the first run downloads it)")
    separator = Separator(model=args.model, device=device, callback=on_segment, progress=False)
    say("STATUS", f"separating on {'the GPU' if device == 'cuda' else 'the CPU'}")
    started = time.time()
    _, stems = separator.separate_tensor(torch.from_numpy(wav), rate)

    say("STATUS", "saving stems")
    names = []
    for name, x in stems.items():
        write_wav(out / f"{name}.wav", x.detach().cpu().numpy(), separator.samplerate)
        names.append(name)
    say("PROGRESS", "1")
    say("RESULT", json.dumps({
        "stems": names,
        "sampleRate": separator.samplerate,
        "duration": wav.shape[1] / rate,
        "device": device,
        "seconds": round(time.time() - started, 1),
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # everything the helper needs to know is the message
        traceback.print_exc(file=sys.stderr)
        say("ERROR", str(e) or e.__class__.__name__)
        sys.exit(1)
