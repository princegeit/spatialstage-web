# SpatialStage web app

A browser-only version of the live rig. No Pd, no bridge server, no install:
the page decodes the stems itself and does the spatialization with Web
Audio. Anyone with a modern browser and headphones can use it.

Nothing in here is used by, or changes, the Pd rig in `../pd`, `../bridge`
or `../pipeline` - both can be used side by side. Delete this folder and the
rest of the project is untouched.

## Run it

Locally, for yourself:

    serve.bat            (then open http://localhost:8090)

or just double-click `index.html` - everything works from `file://` except
phone motion sensors, which browsers only allow on `https://` or
`localhost`.

For other people, it is live at **https://princegeit.github.io/spatialstage-web/**
(https, so phone motion works). That site is a mirror of this folder,
hosted from the separate public repo `princegeit/spatialstage-web`; after
changing anything here, run `publish.bat` to push the update.

## Use it

1. Tap **Start** (browsers require a tap before audio can play).
2. **Add songs** - tap the box or drop files on it:
   - a 12-channel show WAV from `../show_ready/` (the pipeline's output), or
   - separate stem files from any splitter, named with the stem in the
     filename (`vocals.wav`, `Song - drums.wav`, `keys.mp3`...). Files that
     share a folder or a name prefix become one song; missing stems stay
     silent. Any un-split song loads as a single movable source.
3. Press play, drag the dials or move the rotate slider. On a phone, tap
   **Enable Motion** and turn around: the armed stems stay put in the room
   while you turn.
4. **SPATIAL** on a stem card opens the motion panel: FFT-driven motion,
   preset orbits, tempo sync, blend weights, smoothing - the same controls
   and the same math as the Pd rig's `pd/spatial` abstractions.
5. **●** records exactly what you hear to a WAV download.

Presets save in the browser under the current song's name (Export downloads
them all as JSON).

## What matches the Pd rig, what differs

| | Pd rig | Web app |
|---|---|---|
| Panner | `stem_spatializer.pd`: constant-power pan + ±0.3 ms inter-aural delay | Identical math (`js/engine.js`), plus an optional **HRTF** mode using the browser's head-related response |
| Stereo width per stem | `stem_spatializer_stereo.pd`, widths from `binaural_pan_live_v1.pd` | Same values, hard-coded in `js/app.js` `GEOMETRY` |
| Motion (phone / fft / preset / blend / smoothing / arm gate) | `pd/spatial/*.pd` | Ported line for line in `js/motion.js`, ticked at the same 40 Hz |
| Unarmed stem | Parks at its base azimuth | Parks at centre (0°, straight ahead) |
| FFT pitch mode | `sigmund~` | Autocorrelation pitch tracker (same 36..84 MIDI mapping, median-of-3) |
| FFT onset mode | `bonk~` | Energy-jump onset detector (same velocity→azimuth formula) |
| FFT precalc mode | Table from `precompute_fft_envelope.py` | Computed automatically when a song loads (same envelope) |
| Tempo: MIDI clock | `midirealtimein` | Web MIDI (Chrome/Edge only) |
| Tempo: Link | stub | stub |
| Songs | Streamed from disk by `readsf~` | Decoded fully into memory when selected (~2 MB/s of song for 12 channels; fine on a laptop, keep phones to one song at a time) |
| Presets | Per song index, files on disk | Per song name, browser localStorage + JSON export |
| Recording | `writesf~` + ffmpeg MP3 | WAV download |
| Phone | Remote control over LAN | The phone *is* the player (open the page on it) |

Not done: PC↔phone remote control (would need WebRTC or a relay), and
in-browser stem separation (Demucs is a server job - see the top-level
ROADMAP for the bring-your-own-stems discussion).

## Files

    index.html     UI (same layout as bridge/public/index.html)
    js/wav.js      RIFF parser for 12-channel 24-bit show files; WAV encoder for recordings
    js/engine.js   Web Audio graph, transport, recording, precalc envelope
    js/motion.js   stem-control / blend-mixer / preset-source / tempo-source / fft-source / smooth-azimuth
    js/songs.js    file scanning + on-demand decoding
    js/app.js      UI wiring
    serve.bat      local http server for testing
    publish.bat    mirror this folder to the public GitHub Pages repo
