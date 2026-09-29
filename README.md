# SpatialStage web app

A browser-only version of the live rig. No Pd, no bridge server, no install:
the page decodes the stems itself and does the spatialization with Web
Audio. Anyone with a modern browser and headphones can use it.

The two rigs are separate programs used side by side, but they share on
purpose: the same stems, layout, motion math and setup file format, and one
file outright - the Pd rig's control page runs `js/hands.js` from here (the
bridge serves it at `/shared/hands.js`), so keep that file standalone.
`js/stems.js`'s naming rule and `../pipeline/showfile.py`'s NAME_RULES are
two copies of one table: change both.

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
2. **Add songs** - tap the box, drop files or whole folders anywhere on the
   page, or use *choose a folder of stems* (desktop browsers):
   - a show WAV from `../show_ready/` (the pipeline's output: 12 channels,
     or 24 once its drums are split into kit parts), or
   - separate stem files from any splitter, named with the stem in the
     filename (`vocals.wav`, `Song - drums.wav`, `keys.mp3`, `kick.wav`...).
     The names are read by the same rule as the Pd rig's stem-folder import
     (`js/stems.js` = `pipeline/showfile.py`'s NAME_RULES: the stem word
     furthest right wins). Files in one folder with the same name apart
     from the stem word become one song; Demucs-style bare `vocals.wav` /
     `drums.wav` take their folder's name (so drop or choose the folder, not
     the files). A lone file with a stem word in its title ("Bass Head.mp3")
     stays a song. Missing stems stay silent. With kit parts present, the
     drums card plays `drums_rest.wav` (what the parts did not catch).
   Double-click a song name to rename it (its attached setup follows); **×**
   removes it; drag **⋮⋮** to reorder - the order is remembered in this
   browser for the next visit (**Reset A-Z** sorts it). A plain song (one
   stereo mix, e.g. an MP3) plays as one movable sound until the **stem
   splitter** splits it - see below.
3. Press play (or **Space**), then place stems: drag or tap a dial, or drag
   a stem's dot on the radar (with a mouse, dragging empty space inside the
   ring turns every armed stem). The rotate slider turns the armed group.
   As on the rig, *placing* a stem (dial, radar, CENTER, Position slider, a
   grabbing hand) moves its reference point; the slider, the phone and
   group gestures *rotate* the armed stems from wherever they were put.
   Dials and faders also take the keyboard: arrows nudge (Shift for bigger
   steps), Home centres a dial or resets a fader; double-click a fader for
   100%. The six drum-part cards appear only for a song that has parts.
4. **Enable Motion** on a phone: turn around and the armed stems stay put in
   the room. The phone code is the rig's: the heading comes from the full
   rotation matrix (tilting is not turning), with a **Compass/Gyro** choice,
   **Calibrate 360°** for a gyro that reads a full turn short, and
   **Inverted** for a phone whose heading runs the other way.
5. **SPATIAL** on a stem card opens the motion panel: FFT-driven motion,
   preset orbits, tempo sync, blend weights, smoothing (fixed, or following
   the stem's level) - the same controls and the same math as the Pd rig's
   `pd/spatial` abstractions. **Off** takes a source out of the blend.
6. **Output**: *Headphones* or *Quad speakers* (a 4-channel sound card as
   the default playback device - the rig's `quad_pan.pd`, speakers at ±45
   and ±135 degrees), and *Swap L/R* (sound and LED strip together).
7. **Hand Tracking (camera)** turns on the webcam and tracks up to two
   hands (MediaPipe, on-device - no video leaves the page). The camera
   frame is the room seen from above with you in the middle: your hand is
   a cursor on the radar. Two gestures:
   - *Pinch to grab* - pinch thumb + index near a stem's dot to pick it up
     and carry it round your head; pinch in empty space to rotate every
     armed stem together. Each hand can hold its own stem.
   - *Open hand steers* - an open hand turns the whole armed group as it
     moves; a fist freezes it.
   *Reach* sets how far a hand has to travel; *Flip camera* / *Mirror* for
   rear cameras or a laptop pointed at the audience. The rig's control page
   runs this same file (the bridge serves it at `/shared/hands.js`).
8. **●** records exactly what you hear (after L/R swap) as a WAV, or as an
   MP3 (*Record as*: LAME in the page, `js/mp3.js`, fetched from jsDelivr
   the first time).
9. **LED strip** (desktop, below the panner choice): a WLED strip around
   you lights in each stem's direction and colour - the rig's LED renderer,
   with the same per-stem colour/width/trail panel (LED button on each
   card). Browsers cannot send UDP, so the frames go through SpatialStage
   Helper 1.1, which passes them on to WLED (local network addresses only).

**Stem setups** work as on the rig: numbered presets (*Save as new*,
*Update*), plus a setup *attached* to a song; a song loads its attached
setup, or preset 0. A setup is everything about the stems - positions,
motion settings, smoothing, levels, mutes, arming - kept in this browser.
**Export** writes every preset and attached setup to one JSON file in the
rig's own format (`js/setups.js`): **Import** on the rig's page reads it,
and this page imports the rig's export, so a setup built on one plays the
same on the other. Presets from the first version of this page are
converted (to attached setups) the first time the page loads.

## Stem splitter (SpatialStage Helper)

Browsers cannot run Demucs at a usable speed, so splitting a plain song into
stems is done by **SpatialStage Helper**, a small program each user installs
once on their own PC (Windows 10/11 64-bit for now). The page talks to it on
`http://127.0.0.1:47800`; songs never leave the user's computer.

- **Setup:** *Stem splitter* (below the song list) → *Download the helper*
  → extract → double-click `Install SpatialStage Helper.bat`. It installs
  per-user into `%LOCALAPPDATA%\SpatialStage\Helper` (no admin): portable
  Python 3.11, PyTorch 2.14 (CPU, or CUDA with an NVIDIA card), Demucs
  4.1.0 and the 6-stem model - about 1 GB, 3.5 GB with GPU support. Start
  menu / desktop shortcuts, a Settings > Apps entry with an uninstaller,
  and a `spatialstage-helper://` link for the page's *Start helper* button.
- **Use:** with the helper running, a dropped MP3 is split automatically
  (or with its ✂ button). **Drum parts** (helper 1.1): *✂ kit* on a split
  song, or *Also split drums into kit parts* in the dialog, runs the Pd
  rig's drum splitter (MDX23C DrumSep via audio-separator,
  `helper/drums_worker.py`) on the song's drums - kick, snare, toms, hi-hat,
  ride, crash plus the leftover. Slow on a CPU (about 5x the length of the
  drummed sections); the first time, the helper installs audio-separator
  into its own Python and downloads the ~420 MB model. It plays as one sound meanwhile, then swaps to its
  stems at the same position. On the author's Ryzen 5 3400G (CPU) a split
  takes ~2.2x the song's length. Split songs are cached by the helper (keyed
  by a SHA-256 of the file), so a song is only split once, under any name,
  and the dialog's library can add it back without the original file.
- **Browsers:** Chrome/Edge ask once whether the page may "connect to
  devices on your local network" - that is the page reaching the helper.
  The page never contacts the helper until the user opens the stem splitter
  (or has used it before), so first-time visitors never see that question.
- **Security:** the helper binds to 127.0.0.1 only, answers only pages from
  `https://princegeit.github.io`, `localhost`/`127.0.0.1` and `file://`,
  checks the Host header (no DNS rebinding), and only ever writes inside its
  own folder. Splits run at below-normal priority in a separate process
  that is killed on cancel and exits if the helper is closed.

Source is in `helper/` (`spatialstage_helper.py`, `separate_worker.py`,
`install.ps1`, `uninstall.ps1`); `helper/build-zip.ps1` packs the download,
and `serve.bat` / `publish.bat` run it so the zip always matches the code.

## What matches the Pd rig, what differs

| | Pd rig | Web app |
|---|---|---|
| Panner | `stem_spatializer.pd`: constant-power pan + ±0.3 ms inter-aural delay, or live **HRTF** (`pd/spatial/hrtf-mix.pd`: the browser's responses, captured by `capture_browser_hrtf.js`) | Identical classic math (`js/engine.js`), or the browser's own **HRTF** - the same sound |
| Stems | 12, `pd/spatial/stems.txt` (6 Demucs + 6 drum-kit parts) | Same 12, same order (`js/stems.js`) |
| Layout (base azimuth, width) | `generate_live_patch.py` LAYOUT | Same values (`js/stems.js` LAYOUT) |
| Motion (phone / fft / preset / blend / smoothing / arm gate) | `pd/spatial/*.pd` | Ported line for line in `js/motion.js`, ticked at the same 40 Hz |
| Level-driven smoothing | Bridge, from Pd's meters | `js/motion.js`, from the stem's own level |
| Placing vs rotating | Place = stem-control base, rotate = phone offset | Same |
| Unarmed stem | Parks at its base azimuth | Parks at centre (0°, straight ahead) |
| FFT pitch mode | `sigmund~` | Autocorrelation pitch tracker (same 36..84 MIDI mapping, median-of-3) |
| FFT onset mode | `bonk~` | Energy-jump onset detector (same velocity→azimuth formula) |
| FFT precalc mode | Table from `precompute_fft_envelope.py` | Computed the first time a stem uses it (same envelope) |
| Tempo: MIDI clock | `midirealtimein` | Web MIDI (Chrome/Edge only) |
| Tempo: Link | stub | stub |
| Songs | Streamed from disk by `readsf~` | Decoded fully into memory when selected, with progress shown (~2 MB/s of song per six stems; the previous song is freed first, so only one is ever in memory) |
| Playlist | Drag to reorder, `bridge/playlist.json` | Drag to reorder, remembered in the browser |
| Stem setups | Numbered presets + song-attached, files on disk | Same model, browser storage; **same export file** both ways |
| Output | Headphones / quad, L/R swap | Same (quad needs a 4-channel default device) |
| Recording | `writesf~` + ffmpeg MP3 | WAV or MP3 download |
| Drum parts | `pipeline/split_drums.py` | Helper 1.1, same model and method |
| LED strip | WLED over UDP from the bridge | Same renderer, through the helper |
| Phone | Remote control over LAN, compass/gyro, 360° calibration | The phone *is* the player; same sensor code |
| Hand tracking | Same `hands.js`, placing through the bridge | Camera + MediaPipe Hand Landmarker 0.10.35 (loaded from CDN on first use, ~19 MB cached) |

Not done: PC↔phone remote control (would need WebRTC or a relay), and the
stem splitter's Mac/Linux installers (the helper code itself is portable).

## Files

    index.html     UI (same layout as bridge/public/index.html)
    js/stems.js    the 12 stems, layout, colours, and the stem-file naming rule
    js/wav.js      RIFF parser for multichannel show files; WAV encoder for recordings
    js/engine.js   Web Audio graph (stereo + quad), L/R swap, transport, recording, precalc envelope
    js/motion.js   stem-control / blend-mixer / preset-source / tempo-source / fft-source / smooth-azimuth
    js/songs.js    file scanning + on-demand decoding
    js/hands.js    camera + MediaPipe hand landmarks -> pinch/fist gestures
    js/helper.js   client for SpatialStage Helper (the local stem splitter + LED relay)
    js/setups.js   stem setups: presets, song-attached, the shared export format
    js/sensor.js   phone heading, compass/gyro, turn calibration (the rig's code)
    js/mp3.js      MP3 encoding for recordings (lamejs, loaded on first use)
    js/led.js      WLED strip renderer (the rig's), sent through the helper
    js/app.js      UI wiring
    helper/        SpatialStage Helper: server, Demucs + drum-part workers, installer, uninstaller
    serve.bat      local http server for testing
    publish.bat    mirror this folder to the public GitHub Pages repo
