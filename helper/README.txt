SpatialStage Helper
===================

Splits songs into stems (vocals, drums, bass, guitar, piano, other) on your
own PC, for the SpatialStage web app:

    https://princegeit.github.io/spatialstage-web/

The web page cannot split songs itself at a usable speed. With the helper
running, you drop an ordinary MP3 (or WAV, FLAC, M4A...) on the page and it
comes back as six stems you can move around your head. Your songs never
leave your PC: the helper only accepts connections from this computer.


Install (Windows 10/11, 64-bit)
-------------------------------
1. Extract this zip (right-click > Extract All).
2. Double-click "Install SpatialStage Helper.bat".
   If Windows asks whether to run it, choose Run (More info > Run anyway).
3. It downloads about 1 GB (Python, PyTorch, Demucs and the 6-stem model)
   into %LOCALAPPDATA%\SpatialStage\Helper - no admin rights needed.
   With an NVIDIA graphics card it offers GPU support (about 3.5 GB,
   and many times faster).
4. When it finishes it starts the helper. Go back to the SpatialStage page:
   it connects by itself. If Chrome or Edge asks to "look for and connect to
   devices on your local network", click Allow - that is the page talking to
   the helper on this PC.


Use
---
Start it from the Start menu or desktop ("SpatialStage Helper"), or with
the "Start helper" button on the page. A window opens; keep it open while
you use the page, close it to stop the helper.

Splitting takes roughly 1-3x the song's length on an average PC without an
NVIDIA card (a 4-minute song: 4-12 minutes), much less with one. Each song
is only split once - it is kept and shows up in the page's library.

Drum parts: a split song's drums can be split again into kick, snare, toms,
hi-hat, ride and crash ("scissors kit" on the song, or the option in the
stem splitter dialog). The first time, the helper installs the drum
splitter (audio-separator) into its own Python and downloads its model
(about 420 MB). It is slow without an NVIDIA card: roughly 5x the length of
the parts of the song where the drums play.

LED strip: the page can light a WLED strip around you. Browsers cannot talk
to WLED directly, so the page hands each frame to the helper, which sends
it on - only ever to an address on your own local network.


Remove
------
Settings > Apps > SpatialStage Helper > Uninstall, or run Uninstall.bat in
%LOCALAPPDATA%\SpatialStage\Helper. You can keep your split songs.


What is inside
--------------
install.ps1              the installer (readable PowerShell)
spatialstage_helper.py   the helper: a small web server on 127.0.0.1:47800
separate_worker.py       runs Demucs on one song
drums_worker.py          splits a song's drums into kit parts (MDX23C DrumSep)
uninstall.ps1            the uninstaller

Demucs is by Meta AI Research (MIT licence): https://github.com/adefossez/demucs
