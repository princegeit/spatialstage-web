// UI: bridge/public/index.html's control surface, with every send({...})
// to the bridge replaced by a direct call into engine.js / motion.js. The
// page IS the player now - no WebSocket, no OSC, no Pd. Layout, dials,
// radar and panels follow the rig's page so it feels the same on a phone,
// and the state model is the rig's too:
//   - A dial, the radar, CENTER, the Position slider or a grabbing hand
//     PLACE a stem: the spot becomes its reference point (stem-control's
//     base) and its phone offset restarts from 0, so phone, fft and preset
//     motion carry on around where it was put (the bridge's handlePlace).
//   - The rotate slider, the phone and group gestures ROTATE: they add to
//     each armed stem's phone offset (the bridge's phoneRotate).
//   - Stem setups: numbered presets plus setups attached to songs; a song
//     loads its own setup, or preset 0 (js/setups.js, the bridge's model).
const { STEMS: ALL_STEMS, DRUM_PARTS, INPUT_STEMS, GEOMETRY, COLOR: STEM_COLOR, ICONS, LEFTOVER } = SSStems;
const IS_PART = new Set(DRUM_PARTS);
// The input stems have no file: they play a sound input (the EXT option, engine.setLive) and stay out
// of the window until added with "+ Add stem". Every stem can take a sound input too.
const IS_INPUT = new Set(INPUT_STEMS);
const stemTitle = (s) => (IS_INPUT.has(s) ? 'INPUT ' + s.slice(5) : s.toUpperCase());

const $ = (id) => document.getElementById(id);
const status = $('status'), val = $('val'), stemLabel = $('stemLabel');
const stemGrid = $('stemGrid'), stemLayer = $('stemLayer');
const songList = $('songList'), songHint = $('songHint');
const prevBtn = $('prevBtn'), playPauseBtn = $('playPauseBtn'), stopBtn = $('stopBtn'), nextBtn = $('nextBtn');
const seekBar = $('seekBar'), posTimeEl = $('posTime'), durTimeEl = $('durTime');
const masterVolSlider = $('masterVolSlider'), masterVolLabel = $('masterVolLabel');
const recordBtn = $('recordBtn'), recordStatus = $('recordStatus');
const slider = $('slider'), sensorBtn = $('sensorBtn'), calibrateBtn = $('calibrateBtn');
const startOverlay = $('startOverlay'), startBtn = $('startBtn');
const dropZone = $('dropZone'), fileInput = $('fileInput'), folderInput = $('folderInput'), folderBtn = $('folderBtn');
const radar = $('radar'), toastEl = $('toast');

const engine = new SSEngine(ALL_STEMS, GEOMETRY);
const motion = new SSMotion(engine);

// base: each stem's layout azimuth (the patch's). azim: what a dial shows
// while a finger is on it. phone: the rotation offset per stem.
const base = {}, widthDeg = {}, azim = {}, volume = {}, phone = {};
for (const s of ALL_STEMS) { base[s] = GEOMETRY[s].azimuth; widthDeg[s] = GEOMETRY[s].width; azim[s] = base[s]; volume[s] = 1; phone[s] = 0; }
let mutedStems = new Set();
let selectedStems = new Set(ALL_STEMS);
// Who moves a stem: its phone, the camera, its spatial motion, or nobody -
// one at a time. Phone and camera leave the spatial motion sources off (the
// phone-only blend); spatial turns them on (the stem's last spatial setup, or
// its Auto role the first time). The spatial menu shows the same choice.
const ctlName = [null, 'phone', 'cam', 'spatial'];
const ctl = {};
for (const s of ALL_STEMS) ctl[s] = 'phone';
const savedBlend = {};
let songs = [], songIndex = -1;
let loadedSong = null;   // the songs[] entry whose audio is in the engine
let loading = null;      // { song, pct, autoplay } while one is decoding
let seeking = false, seekDirty = false;
const spatial = {};
for (const s of ALL_STEMS) spatial[s] = motion.stems[s].params;
let activeSpatialStem = null, activeLedStem = null, activeExtStem = null;
let lastSliderValue = 0;
let dragging = null;
const cards = {};

const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180;
const buzz = (p) => { if (navigator.vibrate) navigator.vibrate(p); };
const pref = (k, dflt) => { try { const v = localStorage.getItem('spatialstage.' + k); return v === null ? dflt : JSON.parse(v); } catch (e) { return dflt; } };
const setPref = (k, v) => { try { localStorage.setItem('spatialstage.' + k, JSON.stringify(v)); } catch (e) {} };

let toastTimer = null;
function toast(msg, ms) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms || 2800);
}

/* ---------------- start gate ---------------- */

startBtn.addEventListener('click', async () => {
  try {
    await engine.ensure();
  } catch (e) { alert('Could not start audio: ' + e.message); return; }
  motion.start();
  applyOutputPrefs();
  restoreLiveInputs();
  startOverlay.hidden = true;
  status.classList.add('connected');
  refreshStatus();
  buzz(20);
});

// The top line of the radar column: what is loaded and whether it plays.
function refreshStatus() {
  if (!engine.ctx) { status.textContent = 'tap Start to enable audio'; return; }
  if (loading) status.textContent = 'loading ' + loading.song.name + ' ' + Math.round(loading.pct * 100) + '%';
  else if (engine.song && loadedSong) status.textContent = (engine.playing ? '▶ ' : '❚❚ ') + loadedSong.name;
  else status.textContent = songs.length ? 'audio ready · pick a song' : 'audio ready · add a song';
}

/* ---------------- stem cards ---------------- */

function buildCards() {
  stemGrid.textContent = '';
  for (const stem of ALL_STEMS) {
    const c = STEM_COLOR[stem];
    const card = document.createElement('div');
    card.className = 'stem-card' + (IS_PART.has(stem) ? ' part' : '');
    card.style.color = c;
    card.innerHTML =
      '<div class="card-head">' +
        '<svg viewBox="0 0 24 24" stroke="' + c + '">' + ICONS[stem] + '</svg>' +
        '<span class="stem-name">' + stemTitle(stem) + '</span>' +
        '<span class="stem-note"></span>' +
      '</div>' +
      '<div class="level"><div class="level-fill"></div></div>' +
      '<div class="card-row">' +
        '<div class="knob" data-stem="' + stem + '" tabindex="0" role="slider" aria-label="' + stem + ' position, degrees"' +
          ' aria-valuemin="-180" aria-valuemax="180" title="Drag or tap to place · arrow keys nudge · Home centres">' +
          '<svg viewBox="0 0 64 64">' +
            '<circle class="knob-track" cx="32" cy="32" r="29"></circle>' +
            '<circle class="knob-sel" cx="32" cy="32" r="29" stroke="' + c + '"></circle>' +
            '<line class="knob-ptr" x1="32" y1="32" x2="32" y2="7" stroke="' + c + '"></line>' +
            '<circle class="knob-hub" cx="32" cy="32" r="4" stroke="' + c + '"></circle>' +
          '</svg>' +
        '</div>' +
        '<div class="fader" data-stem="' + stem + '" tabindex="0" role="slider" aria-label="' + stem + ' level, percent"' +
          ' aria-valuemin="0" aria-valuemax="100" title="Level · double-click resets to 100%">' +
          '<div class="fader-fill"></div><div class="fader-cap"></div>' +
        '</div>' +
      '</div>' +
      '<div class="card-meta">' +
        '<span class="stem-az">0&deg;</span>' +
        '<button class="tog-btn arm-btn" title="Armed: follows the rotate slider, phone and hands. Unarmed: parks at centre.">ARM</button>' +
        '<button class="tog-btn mute-btn">MUTE</button>' +
      '</div>' +
      '<div class="card-row2">' +
        '<button class="tog-btn phone-btn" title="Phone motion turns this stem (when armed)">PHONE</button>' +
        '<button class="tog-btn cam-btn" title="Camera hand tracking moves this stem (when armed)">CAM</button>' +
      '</div>' +
      '<div class="card-row2">' +
        '<button class="tog-btn center-btn">CENTER</button>' +
        '<button class="tog-btn spatial-btn" title="Spatial motion on/off (FFT / preset motion, set in the spatial menu)">SPATIAL</button>' +
      '</div>' +
      '<div class="card-row2">' +
        '<button class="tog-btn led-btn" hidden><span class="swatch"></span>LED</button>' +
        '<button class="tog-btn ext-btn" title="External input: sound from a mic or line-in into this stem">EXT</button>' +
      '</div>';
    stemGrid.appendChild(card);
    cards[stem] = {
      card,
      knob: card.querySelector('.knob'),
      fader: card.querySelector('.fader'),
      ptr: card.querySelector('.knob-ptr'),
      sel: card.querySelector('.knob-sel'),
      az: card.querySelector('.stem-az'),
      fill: card.querySelector('.fader-fill'),
      cap: card.querySelector('.fader-cap'),
      arm: card.querySelector('.arm-btn'),
      mute: card.querySelector('.mute-btn'),
      phone: card.querySelector('.phone-btn'),
      cam: card.querySelector('.cam-btn'),
      spatial: card.querySelector('.spatial-btn'),
      led: card.querySelector('.led-btn'),
      ext: card.querySelector('.ext-btn'),
      level: card.querySelector('.level-fill'),
      note: card.querySelector('.stem-note'),
    };
    cards[stem].mute.addEventListener('click', () => setMuted(stem, !mutedStems.has(stem)));
    cards[stem].arm.addEventListener('click', () => setArmed(stem, !selectedStems.has(stem)));
    cards[stem].phone.addEventListener('click', () => toggleControl('phone', stem));
    cards[stem].cam.addEventListener('click', () => toggleControl('cam', stem));
    card.querySelector('.center-btn').addEventListener('click', () => centerStem(stem));
    cards[stem].spatial.addEventListener('click', () => toggleControl('spatial', stem));
    // An audio file dropped on a card becomes that stem (adds it, or replaces what it had).
    card.addEventListener('dragover', (ev) => {
      if (!draggingFiles(ev)) return;
      ev.preventDefault(); ev.stopPropagation();
      ev.dataTransfer.dropEffect = 'copy';
      card.classList.add('drop-over');
    });
    card.addEventListener('dragleave', (ev) => { if (!card.contains(ev.relatedTarget)) card.classList.remove('drop-over'); });
    card.addEventListener('drop', (ev) => {
      card.classList.remove('drop-over');
      if (!draggingFiles(ev)) return;
      ev.preventDefault(); ev.stopPropagation();
      dragDepth = 0; dropZone.classList.remove('over');
      if (IS_INPUT.has(stem)) { toast(stemTitle(stem) + ' plays a sound input, not a file.'); return; }
      dropOnStem(stem, [...ev.dataTransfer.files].find((f) => /\.(wav|wave|flac|mp3|m4a|aac|mp4|ogg|oga|opus|webm|aif|aiff|caf)$/i.test(f.name) || (f.type || '').startsWith('audio/')));
    });
    card.addEventListener('click', (ev) => {   // anywhere on the card but its controls
      if (ev.target.closest('button, .knob, .fader')) return;
      if (activeSpatialStem !== stem) openSpatialPanel(stem);
    });
    cards[stem].led.addEventListener('click', () => openLedPanel(stem));
    cards[stem].ext.addEventListener('click', () => openExtPanel(stem));
    bindKnob(card.querySelector('.knob'), stem);
    bindFader(card.querySelector('.fader'), stem);
  }
}

// Does the loaded song have drum-kit parts? Their cards (and radar dots)
// are only shown when it does - twelve cards for a song with six stems is
// a screen of dead controls on a phone.
const songHasParts = () => DRUM_PARTS.some((p) => engine.hasStem(p));
// A stem the loaded song has no audio for (with no song loaded: the drum parts) is
// collapsed to its heading and left off the radar and the hands.
const stemAbsent = (stem) => IS_INPUT.has(stem) ? !inputAdded[stem] : engine.song ? stemNote(stem) === 'silent' : IS_PART.has(stem);
const stemShown = (stem) => !stemAbsent(stem);

// Why a stem has no sound right now, or '' if it has.
function stemNote(stem) {
  if (IS_INPUT.has(stem)) return '';   // plays a sound input, not the song
  if (!engine.song) return '';
  if (stem === 'drums' && songHasParts()) return 'rest';
  if (!engine.hasStem(stem)) return 'silent';
  return '';
}

// Dial pointer + degree readout show where the stem really is (fft/preset
// motion and smoothing included), except while a finger is on that dial,
// when they follow the finger. Called from the motion tick too, so the
// cards animate along with the radar.
function refreshPointers() {
  for (const stem of ALL_STEMS) {
    const k = cards[stem];
    if (!k) continue;
    const a = dragging === stem ? (azim[stem] || 0) : motion.stems[stem].effective;
    const rad = a * Math.PI / 180;
    k.ptr.setAttribute('x2', 32 + 24 * Math.sin(rad));
    k.ptr.setAttribute('y2', 32 - 24 * Math.cos(rad));
    const deg = Math.round(a);
    if (k.shown !== deg) { k.shown = deg; k.az.textContent = deg + '°'; k.knob.setAttribute('aria-valuenow', deg); }
  }
}

function refreshMeters() {
  for (const stem of ALL_STEMS) {
    const k = cards[stem];
    if (k) k.level.style.width = (engine.levelOf(stem) * 100) + '%';
  }
}

function refreshCards() {
  refreshPointers();
  stemGrid.classList.toggle('no-parts', !songHasParts());
  const ledOn = led.configured;
  for (const stem of ALL_STEMS) {
    const k = cards[stem];
    if (!k) continue;
    k.card.hidden = IS_INPUT.has(stem) && !inputAdded[stem];
    const liveOn = !!engine.live[stem];
    k.ext.classList.toggle('on', liveOn);
    k.ext.classList.toggle('open', stem === activeExtStem);
    k.ext.title = liveOn ? 'External input on: ' + (liveSettings[stem].label || 'default input') + ', channels ' + (2 * liveSettings[stem].pair - 1) + '-' + (2 * liveSettings[stem].pair)
                         : 'External input: sound from a mic or line-in into this stem (off)';
    const armed = selectedStems.has(stem);
    k.sel.setAttribute('opacity', armed ? 1 : 0.12);
    k.arm.classList.toggle('armed', armed);
    k.arm.setAttribute('aria-pressed', armed);
    syncControl(stem);
    for (const via of ['phone', 'cam', 'spatial']) {
      const on = ctl[stem] === via;
      k[via].classList.toggle('on', on);
      k[via].setAttribute('aria-pressed', on);
    }
    k.card.classList.toggle('sel', stem === activeSpatialStem);
    const v = volume[stem] === undefined ? 1 : volume[stem];
    k.fill.style.height = (v * 100) + '%';
    k.cap.style.bottom = 'calc(' + (v * 100) + '% - 1.5px)';
    k.fader.setAttribute('aria-valuenow', Math.round(v * 100));
    const m = mutedStems.has(stem);
    k.mute.classList.toggle('muted', m);
    k.mute.setAttribute('aria-pressed', m);
    k.card.classList.toggle('muted', m);
    const gone = stemAbsent(stem);
    const note = gone ? 'empty' : stemNote(stem);
    k.note.textContent = note;
    k.note.title = note === 'rest' ? 'Whatever the drum parts did not catch' : gone ? 'Not in this song - drop an audio file on this card to add it' : '';
    k.card.classList.toggle('absent', gone);
    const look = led.cfg.stems[stem];
    k.led.hidden = !ledOn;
    k.led.classList.toggle('open', stem === activeLedStem);
    k.led.style.color = look.on ? look.color : '';
    k.led.querySelector('.swatch').style.background = look.on ? look.color : '#333';
  }
}

// One place for "put this stem at this angle", shared by dial, radar,
// keyboard, CENTER, the Position slider and hand tracking: the angle
// becomes the stem's reference point and its phone offset restarts.
function placeStem(stem, deg) {
  azim[stem] = wrap180(deg);
  motion.setParam(stem, 'base', Math.round(wrap180(azim[stem] - base[stem])));
  phone[stem] = 0;
  motion.setPhone(stem, 0);
  markModified();
  refreshCards(); requestRadar();
  if (stem === activeSpatialStem) refreshSpatialPanel();
}

// Rotation (slider, phone, group drags): adds to each armed stem's phone
// offset. Not a setup change - the rig does not count it as one either.
// `via` ('phone' or 'cam') limits it to stems with that input switched on;
// the slider and the radar ring (no `via`) turn every armed stem.
function rotateArmedBy(d, via) {
  if (!d) return;
  for (const stem of selectedStems) {
    if (via && ctl[stem] !== via) continue;
    phone[stem] = wrap180(phone[stem] + d);
    motion.setPhone(stem, Math.round(phone[stem]));
  }
}

// Placing an unarmed stem does nothing audible (it stays parked at centre),
// which read as a broken dial - say why once per drag.
function hintIfParked(stem) {
  if (!selectedStems.has(stem)) toast(stem.toUpperCase() + ' is unarmed, so it stays at centre - tap ARM to hear it where you put it.', 3600);
}

function bindKnob(el, stem) {
  let id = null, startX = 0, startY = 0, active = false;
  const angleAt = (ev) => {
    const r = el.getBoundingClientRect();
    const dx = ev.clientX - (r.left + r.width / 2);
    const dy = ev.clientY - (r.top + r.height / 2);
    return Math.round(Math.atan2(dx, -dy) * 180 / Math.PI / 5) * 5;
  };
  el.addEventListener('pointerdown', (ev) => {
    if (ev.button > 0) return;
    id = ev.pointerId; startX = ev.clientX; startY = ev.clientY; active = false;
    el.setPointerCapture(id);
  });
  el.addEventListener('pointermove', (ev) => {
    if (id === null) return;
    if (!active) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      active = true; dragging = stem;
      hintIfParked(stem);
    }
    placeStem(stem, angleAt(ev));
  });
  const end = () => { if (id !== null) { try { el.releasePointerCapture(id); } catch (e) {} } id = null; active = false; dragging = null; };
  // A tap without a drag places the stem where the tap landed.
  el.addEventListener('pointerup', (ev) => {
    if (id !== null && !active) { placeStem(stem, angleAt(ev)); hintIfParked(stem); buzz(10); }
    end();
  });
  el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 15 : 5;
    let d = 0;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') d = step;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') d = -step;
    else if (ev.key === 'Home') { ev.preventDefault(); centerStem(stem); return; }
    else return;
    ev.preventDefault();
    placeStem(stem, motion.stems[stem].effective + d);
  });
}

function setArmed(stem, on, quiet) {
  if (on) selectedStems.add(stem); else selectedStems.delete(stem);
  motion.setArmed(stem, on);
  markModified();
  updateStemLabel(); refreshCards(); requestRadar();
  if (!quiet) buzz(15);
}

// A stem with a spatial source in its blend is under spatial control, whatever
// set it (this page, a loaded setup, the Auto role, the sliders).
function syncControl(stem) {
  const st = spatial[stem];
  if (!st) return;
  if (fftWeight(st) > W_ON || presetWeight(st) > W_ON) ctl[stem] = 'spatial';
  else if (ctl[stem] === 'spatial') ctl[stem] = 'phone';
}

function phoneOnlyBlend(stem) {
  const st = spatial[stem];
  st.blendWeights2 = [0, 0]; sendSpatial(stem, 'blendWeights2', [0, 0]);
  st.blendWeights3 = [1, 0, 0]; sendSpatial(stem, 'blendWeights3', [1, 0, 0]);
}

function setControl(stem, to) {   // 'phone' | 'cam' | 'spatial' | null
  const st = spatial[stem];
  const wasSpatial = ctl[stem] === 'spatial';
  if (to === 'spatial') {
    if (!wasSpatial) {
      const b = savedBlend[stem];
      if (b) {
        st.blendMode = b.mode; sendSpatial(stem, 'blendMode', b.mode);
        st.blendWeights2 = b.w2.slice(); sendSpatial(stem, 'blendWeights2', b.w2.slice());
        st.blendWeights3 = b.w3.slice(); sendSpatial(stem, 'blendWeights3', b.w3.slice());
      } else {
        applyRole(stem);
      }
      if (fftWeight(st) <= W_ON && presetWeight(st) <= W_ON) setSourceOn(stem, 'preset', true);
    }
  } else if (wasSpatial) {
    savedBlend[stem] = { mode: st.blendMode, w2: st.blendWeights2.slice(), w3: st.blendWeights3.slice() };
    phoneOnlyBlend(stem);
  }
  ctl[stem] = to;
  refreshCards(); refreshSpatialPanel();
}

function toggleControl(via, stem) {
  setControl(stem, ctl[stem] === via ? null : via);
  buzz(15);
}

function centerStem(stem) {
  placeStem(stem, 0);
  buzz(15);
}

function setVolume(stem, v) {
  volume[stem] = Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
  engine.setVolume(stem, volume[stem]);
  markModified();
  refreshCards();
}

// The fader leaves `dragging` alone: that flag makes the dial pointer follow
// the raw dial value instead of the stem's real position, so setting it
// here made the pointer jump whenever a level was touched on a stem that
// was moving (or parked because it was unarmed).
function bindFader(el, stem) {
  let id = null;
  const levelAt = (ev) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height));
  };
  el.addEventListener('pointerdown', (ev) => { if (ev.button > 0) return; id = ev.pointerId; el.setPointerCapture(id); setVolume(stem, levelAt(ev)); });
  el.addEventListener('pointermove', (ev) => { if (id !== null) setVolume(stem, levelAt(ev)); });
  el.addEventListener('pointerup', () => { if (id !== null) { try { el.releasePointerCapture(id); } catch (e) {} id = null; } });
  el.addEventListener('pointercancel', () => { id = null; });
  el.addEventListener('dblclick', () => setVolume(stem, 1));
  el.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 0.1 : 0.05;
    const v = volume[stem];
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowRight') setVolume(stem, v + step);
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowLeft') setVolume(stem, v - step);
    else if (ev.key === 'Home') setVolume(stem, 1);
    else if (ev.key === 'End') setVolume(stem, 0);
    else return;
    ev.preventDefault();
  });
}

function setMuted(stem, m, quiet) {
  if (m) mutedStems.add(stem); else mutedStems.delete(stem);
  engine.setMuted(stem, m);
  markModified();
  refreshCards(); requestRadar();
  if (!quiet) buzz(15);
}

/* ---------------- spatial (motion) advanced panel ---------------- */

const spatialPanel = $('spatialPanel'), spatialStemName = $('spatialStemName');
const blendModeRow = $('blendModeRow'), blendTwoRow = $('blendTwoRow'), blendThreeRow = $('blendThreeRow');
const fftModeRow = $('fftModeRow'), fftSrcRow = $('fftSrcRow'), presetModeRow = $('presetModeRow'), tempoSourceRow = $('tempoSourceRow');
const smoothingModeRow = $('smoothingModeRow'), smoothingLabel = $('smoothingLabel'), smoothingHint = $('smoothingHint');
const fftSrcBlock = $('fftSrcBlock'), presetRateBlock = $('presetRateBlock'), tempoBlock = $('tempoBlock');
const ts1El = $('ts1'), ts2El = $('ts2'), w1El = $('w1'), w2El = $('w2'), w3El = $('w3');
const presetRateEl = $('presetRate'), smoothingSliderEl = $('smoothingSlider');
const spatialBpmEl = $('spatialBpm'), spatialBaseEl = $('spatialBase');
const beatBlock = $('beatBlock'), beatSrcRow = $('beatSrcRow'), beatEveryRow = $('beatEveryRow'), beatFollowRow = $('beatFollowRow');
const beatSenseRow = $('beatSenseRow'), beatSenseBlock = $('beatSenseBlock'), beatStepsRow = $('beatStepsRow'), beatPatternRow = $('beatPatternRow');
const beatNudgeEl = $('beatNudge'), beatNudgeOutEl = $('beatNudgeOut'), beatsHintEl = $('beatsHint');
// One button per stem, then the whole mix (value = number of stems).
[...ALL_STEMS, null].forEach((s, i) => {
  if (s && IS_INPUT.has(s)) return;   // a live input has no beats analysed offline
  const btn = document.createElement('button');
  btn.className = 'seg-btn';
  btn.dataset.value = i;
  btn.textContent = s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Whole mix';
  beatSrcRow.appendChild(btn);
});

ALL_STEMS.forEach((s, i) => {
  const btn = document.createElement('button');
  btn.className = 'seg-btn';
  btn.dataset.value = i;
  btn.textContent = s.charAt(0).toUpperCase() + s.slice(1);
  fftSrcRow.appendChild(btn);
});

function sendSpatial(stem, param, value) { motion.setParam(stem, param, value); markModified(); }

function setSegActive(row, value) {
  row.querySelectorAll('.seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value == value);
  });
}
function bindSegRow(row, onPick) {
  row.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => onPick(isNaN(Number(btn.dataset.value)) ? btn.dataset.value : Number(btn.dataset.value)));
  });
}

// How much the FFT and preset sources actually reach the output (the
// rig's fftWeight/presetWeight): two-stage is
// final = blend(blend(phone, fft, ts1), preset, ts2); three-way is plain
// weights. A mode button is only lit while its source is really in the mix.
const fftWeight = (st) => st.blendMode === 1 ? st.blendWeights3[1] : st.blendWeights2[0] * (1 - st.blendWeights2[1]);
const presetWeight = (st) => st.blendMode === 1 ? st.blendWeights3[2] : st.blendWeights2[1];
const W_ON = 0.005;

// Off -> that source's weight to 0. A mode while the source is off -> pick
// it AND give the source a half share, since choosing a motion is asking
// to hear it.
function setSourceOn(stem, which, on) {
  const st = spatial[stem];
  if (st.blendMode === 1) {
    const w = st.blendWeights3.slice();
    const i = which === 'fft' ? 1 : 2;
    w[i] = on ? 0.5 : 0;
    if (!on && w[0] + w[1] + w[2] <= 0) w[0] = 1;   // never leave nothing at all
    sendSpatial(stem, 'blendWeights3', w);
  } else {
    const w = st.blendWeights2.slice();
    if (which === 'fft') {
      w[0] = on ? 0.5 : 0;
      if (on && w[1] > 0.5) w[1] = 0.5;   // a full preset share would still drown it out
    } else {
      w[1] = on ? 0.5 : 0;
    }
    sendSpatial(stem, 'blendWeights2', w);
  }
}

bindSegRow($('ctlRow'), (v) => { if (activeSpatialStem) setControl(activeSpatialStem, ctlName[v]); });
bindSegRow(blendModeRow, (v) => { if (activeSpatialStem) { sendSpatial(activeSpatialStem, 'blendMode', v); refreshSpatialPanel(); } });
bindSegRow(fftModeRow, (v) => {
  const stem = activeSpatialStem;
  if (!stem) return;
  if (v < 0) setSourceOn(stem, 'fft', false);
  else {
    sendSpatial(stem, 'fftMode', v);
    if (fftWeight(spatial[stem]) <= W_ON) setSourceOn(stem, 'fft', true);
    if (v === 6) {
      // Beat steps are positions: blended with the phone or a preset they would land halfway
      // between speakers, so give the FFT source all of it (the blend rows can still be changed).
      sendSpatial(stem, 'blendMode', 0);
      sendSpatial(stem, 'blendWeights2', [1, 0]);
      engine.beatsOf();   // start analysing the song now rather than at the first tick
    }
  }
  refreshSpatialPanel();
});
for (const [row, param] of [[beatSrcRow, 'beatSrc'], [beatEveryRow, 'beatEvery'], [beatStepsRow, 'beatSteps'], [beatPatternRow, 'beatPattern'], [beatFollowRow, 'beatFollow'], [beatSenseRow, 'beatSense']]) {
  bindSegRow(row, (v) => { if (activeSpatialStem) { sendSpatial(activeSpatialStem, param, v); refreshSpatialPanel(); } });
}
beatNudgeEl.addEventListener('input', () => {
  if (!activeSpatialStem) return;
  const v = Number(beatNudgeEl.value);
  sendSpatial(activeSpatialStem, 'beatNudge', v);
  beatNudgeOutEl.textContent = v + ' ms';
});

// What the Beat steps block says about the song's analysis and the chosen source.
function beatsHintText(st) {
  const entry = engine.song ? engine.beatsOf() : null;
  if (!entry) return 'Load a song to find its beats.';
  if (entry.status === 'analysing') return 'Analysing this song for beats (' + entry.progress + '%)...';
  if (entry.status === 'error') return 'Could not analyse this song: ' + (entry.message || 'unknown error');
  const name = st.beatSrc >= ALL_STEMS.length ? 'song' : ALL_STEMS[st.beatSrc];
  const src = name === 'song' ? entry.data.song : entry.data.stems[name];
  const what = name === 'song' ? 'the mix' : 'the ' + name + ' stem';
  if (st.beatFollow === 1) {
    const n = src ? SSMotion.peakTimes(src, st.beatSense).length : 0;
    return n ? n + ' peaks in ' + what + ' at this sensitivity' : 'No peaks found in ' + what + ' — this stem will sit still. Try a higher sensitivity or the whole mix.';
  }
  if (!src || !src.beats.length) return 'No steady beat found in ' + what + ' — this stem will sit still. Try Every peak, or the whole mix.';
  return src.bpm.toFixed(1) + ' BPM · ' + src.beats.length + ' beats · ' + Math.round(src.confidence * 100) + '% sure' +
    (src.forced ? ' · following the song tempo' : '');
}
bindSegRow(fftSrcRow, (v) => { if (activeSpatialStem) { sendSpatial(activeSpatialStem, 'fftSrc', v); refreshSpatialPanel(); } });
bindSegRow(presetModeRow, (v) => {
  const stem = activeSpatialStem;
  if (!stem) return;
  if (v < 0) setSourceOn(stem, 'preset', false);
  else { sendSpatial(stem, 'presetMode', v); if (presetWeight(spatial[stem]) <= W_ON) setSourceOn(stem, 'preset', true); }
  refreshSpatialPanel();
});
// Auto role: the whole role table (js/roles.js) sent through the ordinary
// spatial setters, so the panel then shows - and can adjust - exactly what it set.
function applyRole(stem) {
  SSRoles.plan(stem, ALL_STEMS.indexOf(stem)).forEach(([param, value]) => sendSpatial(stem, param, value));
}
bindSegRow($('roleRow'), (v) => {
  if (!activeSpatialStem) return;
  if (v === 'all') ALL_STEMS.forEach(applyRole); else applyRole(activeSpatialStem);
  refreshSpatialPanel();
});

bindSegRow(smoothingModeRow, (v) => { if (activeSpatialStem) { sendSpatial(activeSpatialStem, 'smoothingMode', v); refreshSpatialPanel(); } });
bindSegRow(tempoSourceRow, (v) => { if (activeSpatialStem) { sendSpatial(activeSpatialStem, 'tempoSource', v); refreshSpatialPanel(); } });

function wireWeightSlider(el, out, apply) {
  el.addEventListener('input', () => {
    if (!activeSpatialStem) return;
    apply(activeSpatialStem, Number(el.value));
    out.textContent = Number(el.value).toFixed(2);
    refreshSpatialRows();   // a weight dragged to or from 0 turns a source off or on
  });
}
const weightAt = (param, i) => (stem, v) => {
  const arr = spatial[stem][param].slice(); arr[i] = v; sendSpatial(stem, param, arr);
};
wireWeightSlider(ts1El, $('ts1Out'), weightAt('blendWeights2', 0));
wireWeightSlider(ts2El, $('ts2Out'), weightAt('blendWeights2', 1));
wireWeightSlider(w1El, $('w1Out'), weightAt('blendWeights3', 0));
wireWeightSlider(w2El, $('w2Out'), weightAt('blendWeights3', 1));
wireWeightSlider(w3El, $('w3Out'), weightAt('blendWeights3', 2));
wireWeightSlider(presetRateEl, $('presetRateOut'), (stem, v) => sendSpatial(stem, 'presetRate', v));
wireWeightSlider(smoothingSliderEl, $('smoothingOut'), (stem, v) => sendSpatial(stem, 'smoothing', v));
// Shown as the stem's actual direction (layout azimuth + reference offset),
// the same number the dial and radar show, rather than the raw offset.
spatialBaseEl.addEventListener('input', () => {
  const stem = activeSpatialStem;
  if (!stem) return;
  $('spatialBaseOut').textContent = Math.round(Number(spatialBaseEl.value)) + '°';
  placeStem(stem, Number(spatialBaseEl.value));
});
spatialBpmEl.addEventListener('change', () => {
  if (!activeSpatialStem) return;
  const v = Math.max(20, Math.min(300, Number(spatialBpmEl.value) || 120));
  spatialBpmEl.value = v; // show what was actually applied, not the typo
  sendSpatial(activeSpatialStem, 'tempoBpm', v);
});

function openSpatialPanel(stem) {
  activeSpatialStem = (activeSpatialStem === stem) ? null : stem;
  spatialPanel.hidden = activeSpatialStem === null;
  if (activeSpatialStem) {
    if (activeLedStem) openLedPanel(activeLedStem);   // one panel at a time
    if (activeExtStem) openExtPanel(activeExtStem);
    spatialStemName.textContent = stemTitle(stem);
    spatialStemName.style.color = STEM_COLOR[stem];
    refreshSpatialPanel();
  }
  syncSideCol();
  refreshCards();
}
$('spatialCloseBtn').addEventListener('click', () => { if (activeSpatialStem) openSpatialPanel(activeSpatialStem); });

// The SPATIAL and LED panels live in a side column (a left drawer on a
// narrower desktop, a bottom sheet on a phone) so they open beside the cards
// instead of under all of them.
function syncSideCol() {
  const open = activeSpatialStem !== null || activeLedStem !== null || activeExtStem !== null;
  $('sideCol').hidden = !open;
  $('app').classList.toggle('has-side', open);
  if (typeof railSync === 'function') railSync();
}

// Which choices are lit and which sub-rows are shown. Only what is actually
// shaping the stem's motion is highlighted: an FFT or preset source with no
// weight in the blend shows "Off", and the rows that only matter for it
// (audio source, rate, tempo) are hidden until it is on.
function refreshSpatialRows() {
  if (!activeSpatialStem) return;
  const st = spatial[activeSpatialStem];
  syncControl(activeSpatialStem);
  setSegActive($('ctlRow'), Math.max(0, ctlName.indexOf(ctl[activeSpatialStem])));
  const fftOn = fftWeight(st) > W_ON, presetOn = presetWeight(st) > W_ON;
  setSegActive(blendModeRow, st.blendMode);
  setSegActive(fftModeRow, fftOn ? st.fftMode : -1);
  setSegActive(fftSrcRow, st.fftSrc);
  setSegActive(presetModeRow, presetOn ? st.presetMode : -1);
  setSegActive(tempoSourceRow, st.tempoSource);
  const levelMode = st.smoothingMode === 1 || st.smoothingMode === 2;
  setSegActive(smoothingModeRow, st.smoothingMode || 0);
  smoothingLabel.textContent = levelMode ? 'Max' : 'Amount';
  smoothingHint.hidden = !levelMode;
  if (levelMode) {
    smoothingHint.textContent = (st.smoothingMode === 1 ? 'Quiet = smooth glide, loud = up to Max.' : 'Loud = smooth glide, quiet = up to Max.') +
      ' Now ' + motion.stems[activeSpatialStem].smoothingNow.toFixed(2) + '.';
  }
  $('roleLabel').textContent = (SSRoles.ROLES[activeSpatialStem] || {}).label || '';
  const beatsOn = fftOn && st.fftMode === 6;
  fftSrcBlock.hidden = !fftOn || beatsOn;   // Beat steps has its own source row
  beatBlock.hidden = !beatsOn;
  if (beatsOn) {
    setSegActive(beatSrcRow, st.beatSrc);
    setSegActive(beatEveryRow, st.beatEvery);
    setSegActive(beatStepsRow, st.beatSteps);
    setSegActive(beatPatternRow, st.beatPattern);
    setSegActive(beatFollowRow, st.beatFollow);
    setSegActive(beatSenseRow, st.beatSense);
    beatSenseBlock.hidden = st.beatFollow !== 1;
    if (document.activeElement !== beatNudgeEl) beatNudgeEl.value = st.beatNudge;
    beatNudgeOutEl.textContent = st.beatNudge + ' ms';
    beatsHintEl.textContent = beatsHintText(st);
  }
  presetRateBlock.hidden = !presetOn;
  tempoBlock.hidden = !(presetOn && st.presetMode === 2);
  blendTwoRow.hidden = st.blendMode !== 0;
  blendThreeRow.hidden = st.blendMode !== 1;
}

function refreshSpatialPanel() {
  if (!activeSpatialStem) return;
  const st = spatial[activeSpatialStem];
  refreshSpatialRows();
  ts1El.value = st.blendWeights2[0]; $('ts1Out').textContent = st.blendWeights2[0].toFixed(2);
  ts2El.value = st.blendWeights2[1]; $('ts2Out').textContent = st.blendWeights2[1].toFixed(2);
  w1El.value = st.blendWeights3[0]; $('w1Out').textContent = st.blendWeights3[0].toFixed(2);
  w2El.value = st.blendWeights3[1]; $('w2Out').textContent = st.blendWeights3[1].toFixed(2);
  w3El.value = st.blendWeights3[2]; $('w3Out').textContent = st.blendWeights3[2].toFixed(2);
  presetRateEl.value = st.presetRate; $('presetRateOut').textContent = st.presetRate.toFixed(2);
  spatialBpmEl.value = st.tempoBpm;
  const pos = Math.round(wrap180(base[activeSpatialStem] + st.base));
  if (document.activeElement !== spatialBaseEl) spatialBaseEl.value = pos;
  $('spatialBaseOut').textContent = pos + '°';
  smoothingSliderEl.value = st.smoothing; $('smoothingOut').textContent = st.smoothing.toFixed(2);
  refreshTempoHint();
}

// Under the tempo row: what the Tempo-Sync motion is actually following.
const tempoHint = $('tempoHint');
function refreshTempoHint() {
  const st = activeSpatialStem && spatial[activeSpatialStem];
  let t = '';
  if (st && st.tempoSource === 1) {
    const clock = motion.midiClock;
    if (!navigator.requestMIDIAccess) t = 'MIDI clock needs Chrome or Edge (Web MIDI) - using the manual BPM above.';
    else if (clock.bpm) t = 'Following MIDI clock: ' + clock.bpm.toFixed(1) + ' BPM';
    else t = 'Waiting for MIDI clock... using the manual BPM above until it arrives.';
  } else if (st && st.tempoSource === 2) {
    t = 'Ableton Link is not implemented yet (on either rig) - using the manual BPM above.';
  }
  if (tempoHint.textContent !== t) tempoHint.textContent = t;
  tempoHint.hidden = !t;
}

/* ---------------- stem setups: presets + song-attached (js/setups.js) ---------------- */

const presetSel = $('presetSel'), presetNameEl = $('presetName'), presetUpdateBtn = $('presetUpdateBtn');
const attachBtn = $('attachBtn'), detachBtn = $('detachBtn'), presetHint = $('presetHint');
const PRESET_HINT = 'Songs with nothing attached load preset 0. Saved: positions, spatial settings, smoothing, volume, mute, arm. Export opens on the Pd rig too.';
let setupStore = SSSetups.load();
// What the stems are set from: { source: 'preset', n } or { source: 'song',
// song }, plus modified once anything was touched since (the bridge's `loaded`).
let loaded = { source: 'preset', n: 0, modified: false };

const presetLabel = (p) => 'P' + p.n + (p.name ? ' · ' + p.name : '');
const currentSongName = () => (songs[songIndex] ? songs[songIndex].name : null);
const hasAttached = (name) => !!(name && setupStore.songs[name]);

function storeSetups() {
  const err = SSSetups.save(setupStore);
  if (err) alert('Could not save in this browser: ' + err);
  return !err;
}

function markModified() {
  if (loaded.modified) return;
  loaded.modified = true;
  renderPresetPanel();
}

// The current state as a setup. The phone offset is folded into the
// reference point, so the setup brings each stem back to where it sits now.
function captureSetup(name) {
  const setup = { name: name || '', spatial: motion.snapshot(), stems: {} };
  for (const s of ALL_STEMS) {
    setup.spatial[s].base = Math.round(wrap180(spatial[s].base + phone[s]));
    setup.stems[s] = { volume: volume[s], muted: mutedStems.has(s), armed: selectedStems.has(s) };
  }
  return setup;
}

function applySetup(setup) {
  setup = SSSetups.normalise(setup);
  motion.restore(setup.spatial);
  for (const s of ALL_STEMS) {
    phone[s] = 0; motion.setPhone(s, 0);
    azim[s] = wrap180(base[s] + setup.spatial[s].base);
    const st = setup.stems[s];
    volume[s] = st.volume; engine.setVolume(s, st.volume);
    if (st.muted) mutedStems.add(s); else mutedStems.delete(s);
    engine.setMuted(s, st.muted);
    if (st.armed) selectedStems.add(s); else selectedStems.delete(s);
    motion.setArmed(s, st.armed);
  }
  updateStemLabel(); refreshCards(); refreshSpatialPanel(); requestRadar();
}

function applyPreset(n) {
  let setup = SSSetups.readPreset(setupStore, n);
  if (!setup) { n = 0; setup = SSSetups.readPreset(setupStore, 0); }
  applySetup(setup);
  loaded = { source: 'preset', n, modified: false };
  renderPresetPanel();
}

// A song's own attached setup if it has one, otherwise preset 0.
function applySongSetup(name) {
  if (hasAttached(name)) {
    applySetup(setupStore.songs[name]);
    loaded = { source: 'song', song: name, modified: false };
    renderPresetPanel();
  } else applyPreset(0);
}

// The selector always shows what the stems are set from: a library preset,
// "Custom (attached)" for a song's own setup, or "Custom (unsaved)" once
// anything has been changed since loading.
function renderPresetPanel() {
  const cur = currentSongName();
  const custom = loaded.modified || loaded.source === 'song';
  if (document.activeElement !== presetSel) {
    presetSel.textContent = '';
    if (custom) {
      const opt = document.createElement('option');
      opt.value = 'custom'; opt.disabled = true;
      opt.textContent = loaded.modified ? 'Custom (unsaved changes)' : 'Custom (attached to this song)';
      presetSel.appendChild(opt);
    }
    for (const p of SSSetups.listPresets(setupStore)) {
      const opt = document.createElement('option');
      opt.value = p.n; opt.textContent = presetLabel(p);
      presetSel.appendChild(opt);
    }
    presetSel.value = custom ? 'custom' : String(loaded.n);
  }
  presetSel.classList.toggle('custom', custom);
  const fromPreset = loaded.source === 'preset';
  presetUpdateBtn.disabled = !fromPreset;
  presetUpdateBtn.textContent = fromPreset ? 'Update P' + loaded.n : 'Update';
  attachBtn.disabled = !cur;
  attachBtn.textContent = hasAttached(cur) ? 'Re-attach' : 'Attach to song';
  detachBtn.hidden = !hasAttached(cur);
  if (!flashPresetHint.t) presetHint.textContent = cur ? PRESET_HINT : 'Load a song to attach a setup to it. ' + PRESET_HINT;
}

function flashPresetHint(text) {
  presetHint.textContent = text;
  clearTimeout(flashPresetHint.t);
  flashPresetHint.t = setTimeout(() => { flashPresetHint.t = null; renderPresetPanel(); }, 3000);
}

const unsavedOk = () => !loaded.modified || confirm('Discard the unsaved changes to the stems?');

presetSel.addEventListener('change', () => {
  const n = Number(presetSel.value);
  presetSel.blur();
  if (!unsavedOk()) { renderPresetPanel(); return; }
  applyPreset(n);
  flashPresetHint('Loaded preset ' + n + '.');
});
$('presetNewBtn').addEventListener('click', () => {
  const name = presetNameEl.value.trim();
  if (!name) { presetNameEl.focus(); flashPresetHint('Type a name for the new preset first.'); return; }
  const n = SSSetups.nextPresetNumber(setupStore);
  setupStore.presets[n] = captureSetup(name);
  if (!storeSetups()) return;
  presetNameEl.value = '';
  loaded = { source: 'preset', n, modified: false };
  renderPresetPanel();
  flashPresetHint('Saved as new preset P' + n + ' "' + name + '".');
  buzz(25);
});
presetUpdateBtn.addEventListener('click', () => {
  if (loaded.source !== 'preset') return;
  const n = loaded.n;
  if (n === 0 && !confirm('Overwrite preset 0? Every song without an attached setup loads preset 0.')) return;
  const old = SSSetups.listPresets(setupStore).find((p) => p.n === n);
  const name = presetNameEl.value.trim() || (old ? old.name : '');
  setupStore.presets[n] = captureSetup(name);
  if (!storeSetups()) return;
  presetNameEl.value = '';
  loaded = { source: 'preset', n, modified: false };
  renderPresetPanel();
  flashPresetHint('Updated preset ' + n + '.');
  buzz(25);
});
attachBtn.addEventListener('click', () => {
  const cur = currentSongName();
  if (!cur) return;
  if (hasAttached(cur) && !confirm('Replace the setup already attached to this song?')) return;
  setupStore.songs[cur] = captureSetup('');
  if (!storeSetups()) return;
  loaded = { source: 'song', song: cur, modified: false };
  renderPresetPanel(); renderSongs();
  flashPresetHint('Attached to "' + cur + '".');
  buzz(25);
});
detachBtn.addEventListener('click', () => {
  const cur = currentSongName();
  if (!cur || !confirm('Detach the setup from this song? It will load preset 0 next time.')) return;
  delete setupStore.songs[cur];
  storeSetups();
  if (loaded.source === 'song') loaded.modified = true;
  renderPresetPanel(); renderSongs();
  flashPresetHint('Detached - this song loads preset 0 from now on.');
});
$('presetRevertBtn').addEventListener('click', () => {
  if (!unsavedOk()) return;
  if (loaded.source === 'song' && hasAttached(loaded.song)) applySongSetup(loaded.song);
  else applyPreset(loaded.n || 0);
  flashPresetHint('Reverted.');
  buzz([20, 20, 20]);
});
$('presetExportBtn').addEventListener('click', () => {
  const file = SSSetups.exportFile(setupStore);
  if (!file.presets.length && !Object.keys(file.songs).length) { flashPresetHint('Nothing saved yet - save a preset or attach a setup first.'); return; }
  download(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }), 'spatialstage-setups.json');
});
// Merges a file from Export - this page's, another browser's, or the Pd
// rig's - into this browser's setups; same number / same song replaces.
const presetFileInput = $('presetFileInput');
$('presetImportBtn').addEventListener('click', () => presetFileInput.click());
presetFileInput.addEventListener('change', async () => {
  const f = presetFileInput.files[0];
  presetFileInput.value = '';
  if (!f) return;
  let parsed;
  try { parsed = SSSetups.parseFile(JSON.parse(await f.text())); }
  catch (e) { alert(e instanceof SyntaxError ? 'That file is not valid JSON: ' + e.message : e.message); return; }
  const n = SSSetups.merge(setupStore, parsed);
  if (!storeSetups()) return;
  renderPresetPanel(); renderSongs();
  toast('Imported ' + n.presets + (n.presets === 1 ? ' preset' : ' presets') + ' and ' + n.songs + (n.songs === 1 ? ' song setup' : ' song setups'));
});

/* ---------------- radar ---------------- */

const CX = 150, CY = 150, RING = 86;
const polar = (deg, r) => {
  const a = deg * Math.PI / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
};
function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

let radarPending = false;
function requestRadar() {
  if (radarPending) return;
  radarPending = true;
  requestAnimationFrame(() => { radarPending = false; drawRadar(); refreshPointers(); refreshMeters(); });
}

// Stem labels, laid out so that stems sharing a spot (every stem parks at 0
// deg after Arm None) do not print on top of each other. Each label gets its
// natural spot beside its dot; labels whose boxes collide are merged into a
// group, drawn as a vertical list at the sides of the ring or as one
// coloured line (two if it would not fit) at the front and back, where
// there is width but no height to spare.
// Label metrics for 11px bold, measured with getBBox: 5.7-6.3 units per
// character (6.4 keeps a margin); the line box runs from 11.6 above the
// baseline to 2.9 below it.
const LABEL_CHAR_W = 6.4, LABEL_H = 14.6, LABEL_R = RING + 22;
const DEG_RAD = Math.PI / 180;
const labelText = (stem, a) => stem.toUpperCase() + ' ' + Math.round(a) + '°';
const boxesHit = (p, q) => p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3];

function lineBox(line) {
  const w = line.spans.reduce((n, s) => n + s.text.length, 0) * LABEL_CHAR_W;
  const x0 = line.anchor === 'start' ? line.x : line.anchor === 'end' ? line.x - w : line.x - w / 2;
  return [x0 - 1, line.y - 11.6, x0 + w + 1, line.y + 2.9];
}

// Lines for one group of { stem, a }: a lone stem sits beside its dot as
// before; a crowd becomes a list (sides) or one or two lines (front/back).
function layoutGroup(g) {
  const span = (l, text) => ({ stem: l.stem, text });
  if (g.length === 1) {
    const { stem, a } = g[0];
    const [lx, ly] = polar(a, LABEL_R);
    const near = Math.abs(wrap180(a)) < 8 || Math.abs(Math.abs(wrap180(a)) - 180) < 8;
    const anchor = near ? 'middle' : (Math.sin(a * DEG_RAD) >= 0 ? 'start' : 'end');
    return [{ x: lx, y: ly + 4, anchor, spans: [span(g[0], labelText(stem, a))] }];
  }
  // Circular mean of the group's angles.
  let sx = 0, sy = 0;
  for (const l of g) { sx += Math.sin(l.a * DEG_RAD); sy += Math.cos(l.a * DEG_RAD); }
  const m = Math.atan2(sx, sy) / DEG_RAD;
  const [mx, my] = polar(m, LABEL_R);
  if (Math.abs(Math.sin(m * DEG_RAD)) > 0.55) {
    // A list reading top to bottom in the same order as the dots, kept
    // inside the drawing.
    const sorted = g.slice().sort((p, q) => polar(p.a, RING)[1] - polar(q.a, RING)[1]);
    const anchor = Math.sin(m * DEG_RAD) >= 0 ? 'start' : 'end';
    let top = my + 4 - (sorted.length - 1) * LABEL_H / 2;
    top = Math.max(12, Math.min(top, 296 - (sorted.length - 1) * LABEL_H));
    return sorted.map((l, i) => ({ x: mx, y: top + i * LABEL_H, anchor, spans: [span(l, labelText(l.stem, l.a))] }));
  }
  // Front or back: left to right in the same order as the dots, with one
  // shared degree reading when they all sit at the same angle.
  const sorted = g.slice().sort((p, q) => polar(p.a, RING)[0] - polar(q.a, RING)[0]);
  const same = sorted.every(l => Math.round(l.a) === Math.round(sorted[0].a));
  const perLine = (sorted.length > 3 && !same) ? Math.ceil(sorted.length / 2) : sorted.length;
  const rows = [];
  for (let i = 0; i < sorted.length; i += perLine) rows.push(sorted.slice(i, i + perLine));
  // Front groups grow upward from the ring, back groups downward.
  const front = Math.cos(m * DEG_RAD) >= 0;
  const y0 = my + 4 + (front ? -(rows.length - 1) * LABEL_H : 0);
  return rows.map((row, r) => ({
    x: mx, y: y0 + r * LABEL_H, anchor: 'middle',
    spans: row.map((l, i) => span(l, (i ? '  ' : '') + (same
      ? l.stem.toUpperCase() + (r === rows.length - 1 && i === row.length - 1 ? ' ' + Math.round(l.a) + '°' : '')
      : labelText(l.stem, l.a)))),
  }));
}

// Start with every stem on its own; while any two groups' lines touch,
// merge them and lay the merged group out again.
function layoutLabels(items) {
  let groups = items.map(it => [it]);
  for (;;) {
    const laid = groups.map(layoutGroup);
    const boxes = laid.map(lines => lines.map(lineBox));
    let hit = null;
    for (let i = 0; i < boxes.length && !hit; i++) for (let j = i + 1; j < boxes.length && !hit; j++) {
      if (boxes[i].some(p => boxes[j].some(q => boxesHit(p, q)))) hit = [i, j];
    }
    if (!hit) return laid;
    groups[hit[0]] = groups[hit[0]].concat(groups[hit[1]]);
    groups.splice(hit[1], 1);
  }
}

function drawLabels(items) {
  for (const lines of layoutLabels(items)) for (const line of lines) {
    const t = svgEl('text', { class: 'stem-label', x: line.x, y: line.y, 'text-anchor': line.anchor });
    for (const s of line.spans) {
      const muted = mutedStems.has(s.stem);
      const ts = svgEl('tspan', { fill: muted ? '#777' : STEM_COLOR[s.stem], opacity: muted ? 0.3 : 1 });
      ts.textContent = s.text;
      t.appendChild(ts);
    }
    stemLayer.appendChild(t);
  }
}

function drawRadar() {
  stemLayer.textContent = '';
  const labelItems = [];
  for (const stem of ALL_STEMS) {
    if (!stemShown(stem)) continue;
    // Where the stem actually is, motion and smoothing included.
    const a = motion.stems[stem].effective;
    const w = widthDeg[stem] || 0;
    const muted = mutedStems.has(stem);
    const colour = muted ? '#777' : STEM_COLOR[stem];
    const alpha = muted ? 0.3 : 1;
    if (w >= 2) {
      const [x1, y1] = polar(a - w / 2, RING);
      const [x2, y2] = polar(a + w / 2, RING);
      stemLayer.appendChild(svgEl('path', {
        class: 'width-arc', stroke: colour, opacity: muted ? 0.15 : 0.45,
        d: 'M ' + x1 + ' ' + y1 + ' A ' + RING + ' ' + RING + ' 0 ' + (w > 180 ? 1 : 0) + ' 1 ' + x2 + ' ' + y2,
      }));
    }
    const [dx, dy] = polar(a, RING);
    stemLayer.appendChild(svgEl('circle', { class: 'stem-dot', cx: dx, cy: dy, r: muted ? 4 : 6, fill: colour, opacity: alpha }));
    if (selectedStems.has(stem) && !muted) {
      stemLayer.appendChild(svgEl('circle', { class: 'sel-ring', cx: dx, cy: dy, r: 11, stroke: colour }));
    }
    labelItems.push({ stem, a });
  }
  drawLabels(labelItems);
}

// Drag a dot to place that stem. With a mouse, dragging empty space inside
// the ring turns the whole armed group, like the rotate slider. On touch
// only a dot starts a drag, so the radar (which fills a phone's first
// screen) can still be used to scroll the page.
const DOT_HIT = 20;
let radarDrag = null;
function radarPoint(ev) {
  const pt = radar.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  return pt.matrixTransform(radar.getScreenCTM().inverse());
}
const angleOfPoint = (p) => wrap180(Math.atan2(p.x - CX, CY - p.y) * 180 / Math.PI);
function stemAtPoint(p) {
  let best = null, bestD = DOT_HIT;
  for (const s of ALL_STEMS) {
    if (mutedStems.has(s) || !stemShown(s)) continue;
    const [x, y] = polar(motion.stems[s].effective, RING);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}
radar.addEventListener('pointerdown', (ev) => {
  if (ev.button > 0) return;
  const p = radarPoint(ev);
  let target = stemAtPoint(p);
  if (!target) {
    const r = Math.hypot(p.x - CX, p.y - CY);
    if (ev.pointerType === 'touch' || r > 122 || r < 14 || !selectedStems.size) return;
    target = 'group';
  }
  radarDrag = { id: ev.pointerId, target, lastAz: angleOfPoint(p) };
  radar.setPointerCapture(ev.pointerId);
  radar.classList.add('dragging');
  if (target !== 'group') { dragging = target; hintIfParked(target); }
  ev.preventDefault();
});
radar.addEventListener('pointermove', (ev) => {
  if (!radarDrag || ev.pointerId !== radarDrag.id) return;
  const az = angleOfPoint(radarPoint(ev));
  if (radarDrag.target === 'group') { rotateArmedBy(wrap180(az - radarDrag.lastAz)); refreshCards(); requestRadar(); }
  else placeStem(radarDrag.target, Math.round(az));
  radarDrag.lastAz = az;
});
const endRadarDrag = (ev) => {
  if (!radarDrag || ev.pointerId !== radarDrag.id) return;
  try { radar.releasePointerCapture(ev.pointerId); } catch (e) {}
  radarDrag = null; dragging = null;
  radar.classList.remove('dragging');
};
radar.addEventListener('pointerup', endRadarDrag);
radar.addEventListener('pointercancel', endRadarDrag);
// Touch: claim the gesture (no page scroll) only when it starts on a dot.
radar.addEventListener('touchstart', (ev) => {
  if (ev.touches.length === 1 && stemAtPoint(radarPoint(ev.touches[0]))) ev.preventDefault();
}, { passive: false });

// Redraw the radar, dial pointers and level meters at 20 Hz; the measured
// MIDI clock tempo and the level-driven smoothing value twice a second
// while the panel shows them.
let tickN = 0;
motion.onTick = () => {
  if ((++tickN & 1) === 0) requestRadar();
  if (tickN % 20 === 0 && activeSpatialStem) {
    const st = spatial[activeSpatialStem];
    if (st.tempoSource === 1) refreshTempoHint();
    if (st.smoothingMode) refreshSpatialRows();
  }
};

/* ---------------- songs + playlist order ---------------- */

// The playlist's order, by song name, kept in this browser: songs have to
// be added again each visit (a page cannot keep file handles), but they
// come back in the order they were left in. New songs go to the end.
const ORDER_KEY = 'playlistOrder';
let savedOrder = pref(ORDER_KEY, []);
function saveOrder() {
  const names = songs.map((s) => s.name);
  const rest = savedOrder.filter((n) => !names.includes(n));
  savedOrder = names.concat(rest).slice(0, 2000);
  setPref(ORDER_KEY, savedOrder);
}
function sortByOrder(list) {
  const rank = new Map(savedOrder.map((n, i) => [n, i]));
  return list.map((s, i) => [s, i]).sort((a, b) => {
    const ra = rank.has(a[0].name) ? rank.get(a[0].name) : Infinity, rb = rank.has(b[0].name) ? rank.get(b[0].name) : Infinity;
    return ra !== rb ? ra - rb : a[1] - b[1];
  }).map((x) => x[0]);
}
// songs[] was reordered: find the current song again.
function reindex(current) { songIndex = current ? songs.indexOf(current) : -1; }

$('playlistResetBtn').addEventListener('click', () => {
  if (!songs.length || !confirm('Put the playlist back in A-Z order?')) return;
  const current = songs[songIndex];
  songs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  reindex(current);
  saveOrder(); renderSongs();
});

function renderSongs() {
  songList.textContent = '';
  if (songs.length === 0) {
    songList.innerHTML = '<div class="empty-songs">No songs yet. Drop a show WAV, a folder of stems, or any song on the box above.</div>';
    renderPresetPanel();
    return;
  }
  songs.forEach((song, i) => {
    const row = document.createElement('div');
    const isLoading = loading && loading.song === song;
    row.className = 'song-item' + (i === songIndex ? ' playing' : '') + (isLoading ? ' loading' : '');
    if (isLoading) row.style.setProperty('--p', Math.round(loading.pct * 100) + '%');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-current', i === songIndex ? 'true' : 'false');
    const handle = document.createElement('span');
    handle.className = 'song-handle';
    handle.textContent = '⋮⋮';
    handle.title = 'Drag to reorder';
    const mark = document.createElement('span');
    mark.className = 'song-mark';
    if (isLoading) mark.innerHTML = '<span class="spin"></span>';
    else paintMark(mark, song);
    const label = document.createElement('span');
    label.className = 'song-name';
    label.textContent = song.name;
    label.title = song.name + ' - double-click to rename';
    label.addEventListener('dblclick', (e) => { e.stopPropagation(); renameSong(i); });
    row.append(handle, mark, label);
    if (hasAttached(song.name)) {
      const tag = document.createElement('span');
      tag.className = 'song-preset'; tag.textContent = 'CUSTOM'; tag.title = 'Has its own stem setup attached';
      row.appendChild(tag);
    }
    if (song.slots.some((on, k) => on && IS_PART.has(ALL_STEMS[k]))) {
      const kit = document.createElement('span');
      kit.className = 'song-kit'; kit.textContent = 'KIT'; kit.title = 'Drum parts: kick, snare, toms, hi-hat, ride, crash';
      row.appendChild(kit);
    }
    const slots = document.createElement('span');
    slots.className = 'stem-slots';
    ALL_STEMS.forEach((s, k) => {
      if (IS_PART.has(s) || IS_INPUT.has(s)) return;   // the KIT tag stands for all six; inputs are not in a song
      const dot = document.createElement('i');
      dot.style.background = STEM_COLOR[s];
      if (song.slots[k]) dot.classList.add('on');
      dot.title = s + (song.slots[k] ? '' : ' (silent)');
      slots.appendChild(dot);
    });
    const dur = document.createElement('span');
    dur.className = 'song-duration';
    dur.textContent = isLoading ? Math.round(loading.pct * 100) + '%' : song.duration == null ? '—' : formatTime(song.duration);
    const remove = document.createElement('button');
    remove.className = 'song-remove';
    remove.innerHTML = '&times;';
    remove.title = 'Remove from the list';
    remove.setAttribute('aria-label', 'Remove ' + song.name);
    remove.addEventListener('click', (e) => { e.stopPropagation(); removeSong(i); });
    row.append(slots, dur);
    // Plain songs get a split button, helper songs a drum-parts one, each
    // showing its progress while it runs (stem splitter below).
    if (canSplit(song) || canSplitParts(song) || song.split) {
      const split = document.createElement('button');
      split.className = 'song-split';
      split.addEventListener('click', (e) => { e.stopPropagation(); onSplitClick(song); });
      row.appendChild(split);
      paintSplit(row, split, song);
    }
    row.appendChild(remove);
    row.addEventListener('click', (ev) => { if (ev.target === handle) return; loadSongIndex(i, true); buzz(25); });
    row.addEventListener('keydown', (e) => {
      if (e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); loadSongIndex(i, true); }
    });
    bindSongDrag(handle, row, song);
    songList.appendChild(row);
  });
  renderPresetPanel();
}

// Reorder by dragging a row's handle - pointer events, as on the rig's
// page, since HTML5 drag-and-drop does nothing on a touch screen. Near the
// top or bottom of the screen the page scrolls so a song can be carried
// the length of a long list.
let songDrag = null;
function bindSongDrag(handle, row, song) {
  handle.addEventListener('pointerdown', (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    handle.setPointerCapture(ev.pointerId);
    songDrag = { song, row, target: null, after: false, y: ev.clientY };
    row.classList.add('drag-src');
    songDrag.scroller = setInterval(() => {
      if (!songDrag) return;
      if (songDrag.y < 60) window.scrollBy(0, -12);
      else if (songDrag.y > window.innerHeight - 60) window.scrollBy(0, 12);
    }, 30);
  });
  handle.addEventListener('pointermove', (ev) => {
    if (!songDrag || songDrag.song !== song) return;
    songDrag.y = ev.clientY;
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const over = under && under.closest('.song-item');
    songList.querySelectorAll('.drop-before, .drop-after').forEach(r => r.classList.remove('drop-before', 'drop-after'));
    if (!over || over === row) { songDrag.target = null; return; }
    const r = over.getBoundingClientRect();
    songDrag.target = songs[[...songList.children].indexOf(over)];
    songDrag.after = ev.clientY > r.top + r.height / 2;
    over.classList.add(songDrag.after ? 'drop-after' : 'drop-before');
  });
  const end = () => {
    if (!songDrag || songDrag.song !== song) return;
    clearInterval(songDrag.scroller);
    const { target, after } = songDrag;
    songDrag = null;
    row.classList.remove('drag-src');
    if (!target) { renderSongs(); return; }
    const current = songs[songIndex];
    const from = songs.indexOf(song);
    songs.splice(from, 1);
    songs.splice(songs.indexOf(target) + (after ? 1 : 0), 0, song);
    reindex(current);
    saveOrder(); renderSongs();
    buzz(20);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// ▶ / ❚❚ only on the song actually in the engine; ⚠ on one that failed to
// load (the reason is on hover and in the hint line).
function paintMark(mark, song) {
  mark.textContent = song === loadedSong && engine.song ? (engine.playing ? '▶' : '❚❚') : song.loadError ? '⚠' : '';
  mark.title = song.loadError || '';
  mark.classList.toggle('err', !!song.loadError && song !== loadedSong);
}

// Progress ticks arrive every slice of the decode; only touch the DOM when
// the whole-percent value changes.
function showLoadProgress(x) {
  const pct = Math.round(x * 100);
  if (!loading || Math.round(loading.pct * 100) === pct) { if (loading) loading.pct = x; return; }
  loading.pct = x;
  const row = songList.children[songs.indexOf(loading.song)];
  if (row) {
    row.style.setProperty('--p', pct + '%');
    const d = row.querySelector('.song-duration');
    if (d) d.textContent = pct + '%';
  }
  refreshStatus();
}

let loadSeq = 0;
// startAt (seconds) resumes a song part-way - used when a song's stems
// arrive while it is playing as one sound; keepSetup leaves the stems as
// they are then, rather than loading the song's setup over them.
async function loadSongIndex(i, autoplay, startAt, keepSetup) {
  if (i < 0 || i >= songs.length) return;
  const song = songs[i];
  // Already in memory (clicking the current song, or a one-song list
  // looping at its end): restart it instead of decoding it all again.
  if (song === loadedSong && engine.song && !loading) {
    songIndex = i;
    engine.seek(0);
    if (autoplay && !engine.playing) engine.play();
    renderSongs(); refreshTransportButtons();
    return;
  }
  const seq = ++loadSeq;
  songIndex = i;
  song.loadError = null;
  loading = { song, pct: 0, autoplay: !!autoplay };
  // Let go of the previous song before decoding this one: two long
  // multichannel songs in memory at once is what gets a phone tab killed.
  loadedSong = null;
  engine.unload();
  songHint.textContent = '';
  renderSongs(); refreshTransportButtons();
  try {
    const decoded = await SSSongs.decodeSong(song, engine, (x) => { if (seq === loadSeq) showLoadProgress(x); });
    if (seq !== loadSeq) return; // a newer selection superseded this one
    const loaded_ = await engine.loadSong(decoded);
    if (seq !== loadSeq) { if (engine.song === loaded_) engine.unload(); return; }
    song.duration = loaded_.duration;
    loadedSong = song;
    const play = loading.autoplay;
    loading = null;
    // A song change loads that song's setup, as on the rig.
    if (!keepSetup) applySongSetup(song.name);
    if (decoded.fallback) { toast(song.name + ': ' + decoded.fallback + ' - playing the original as one sound. Start SpatialStage Helper for the stems.', 5200); checkHelper(); }
    if (startAt) engine.seek(startAt);
    renderSongs(); refreshTransportButtons(); refreshCards(); requestRadar();
    if (play) engine.play();
  } catch (e) {
    if (seq !== loadSeq) return;
    loading = null;
    song.loadError = 'Could not load: ' + e.message;
    renderSongs(); refreshTransportButtons();
    songHint.textContent = 'Could not load ' + song.name + ': ' + e.message;
    if (song.kind === 'helper') checkHelper();
  }
}

function removeSong(i) {
  const song = songs[i];
  songs.splice(i, 1);
  cancelSplit(song);
  if (song === loadedSong || (loading && loading.song === song)) {
    loadSeq++; // abandons a decode in flight
    loading = null; loadedSong = null;
    engine.unload();
    songIndex = -1;
  } else if (i < songIndex) songIndex--;
  else if (i === songIndex) songIndex = -1;
  renderSongs(); refreshTransportButtons(); refreshCards();
}

// Setups attach by song name, so a rename carries the attached one along.
function renameSong(i) {
  const song = songs[i];
  const name = (prompt('Song name (its attached setup is kept under it):', song.name) || '').trim();
  if (!name || name === song.name) return;
  if (setupStore.songs[song.name] && !setupStore.songs[name]) {
    setupStore.songs[name] = setupStore.songs[song.name];
    delete setupStore.songs[song.name];
    storeSetups();
  }
  if (loaded.source === 'song' && loaded.song === song.name) loaded.song = name;
  savedOrder = savedOrder.map((n) => (n === song.name ? name : n));
  song.name = name;
  saveOrder();
  renderSongs(); refreshStatus();
}

let busyAdding = false;
async function addFiles(files) {
  files = files.filter(f => f.size > 0);
  if (!files.length) return;
  busyAdding = true;
  dropZone.classList.add('busy');
  try {
    const found = await SSSongs.scanFiles(files);
    if (!found.length) toast('No audio files in that selection');
    const current = songs[songIndex];
    songs = sortByOrder(songs.concat(found));
    reindex(current);
    saveOrder();
    renderSongs(); refreshTransportButtons();
    const added = found.length === 1 ? found[0].name : found.length + ' songs';
    const plain = found.filter(canSplit);
    if (plain.length && helperReadyNow() && helperPrefs.auto) {
      plain.forEach(s => queueSplit(s, true));
      toast('Added ' + added + ' - splitting into stems in the background; it plays as one sound until then.', 4200);
    } else if (found.length) {
      toast('Added ' + added);
      if (plain.length) offerSplitting();
    }
    if (!engine.song && !loading && found.length) loadSongIndex(songs.indexOf(found[0]), false);
  } catch (e) {
    alert('Could not add: ' + e.message);
  }
  busyAdding = false;
  dropZone.classList.remove('busy');
}

// Dropped folders are walked (Demucs writes one folder per song, with bare
// vocals.wav / drums.wav ... inside), and each file remembers its folder
// path so songs.js can name the song after it. The entries have to be
// taken synchronously inside the drop event - the list is emptied as soon
// as the handler returns - so this collects them before its first await.
function filesFromDataTransfer(dt) {
  const items = [...(dt.items || [])].filter(it => it.kind === 'file');
  const entries = items.map(it => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null));
  const plain = [...dt.files];
  if (!entries.length || entries.some(e => !e)) return Promise.resolve(plain);
  const readAll = (reader) => new Promise((res, rej) => {
    const all = [];
    const next = () => reader.readEntries((batch) => { if (!batch.length) res(all); else { all.push(...batch); next(); } }, rej);
    next();
  });
  const out = [];
  const walk = async (entry, dir) => {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      if (dir) f.ssPath = dir + '/' + f.name;
      out.push(f);
    } else if (entry.isDirectory) {
      const sub = (dir ? dir + '/' : '') + entry.name;
      for (const e of await readAll(entry.createReader())) await walk(e, sub);
    }
  };
  return (async () => {
    try { for (const e of entries) await walk(e, ''); return out; }
    catch (err) { return plain; }
  })();
}

dropZone.addEventListener('click', () => { if (!busyAdding) fileInput.click(); });
dropZone.addEventListener('keydown', (e) => { if (e.target === dropZone && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
// A folder picker where the browser has one (desktop, mostly).
if ('webkitdirectory' in folderInput) {
  folderBtn.hidden = false;
  folderBtn.addEventListener('click', (e) => { e.stopPropagation(); folderInput.click(); });
  folderInput.addEventListener('change', () => { addFiles([...folderInput.files]); folderInput.value = ''; });
}
// The whole page takes drops; the box lights up while files are over it.
let dragDepth = 0;
const draggingFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
document.addEventListener('dragenter', (e) => { if (!draggingFiles(e)) return; dragDepth++; dropZone.classList.add('over'); });
document.addEventListener('dragleave', (e) => { if (!draggingFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; dropZone.classList.remove('over'); } });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0; dropZone.classList.remove('over');
  if (e.dataTransfer) filesFromDataTransfer(e.dataTransfer).then(addFiles);
});

// Drop an audio file on a stem card: it becomes that stem of the loaded song,
// live (placing a stem the song lacked, or replacing the one it had). It is
// not saved with the song - loading the song again brings back the original.
async function dropOnStem(stem, file) {
  if (!file) { toast('Drop an audio file (wav, mp3, flac, ...) on a stem to put it there.', 3600); return; }
  if (!engine.song) { toast('Load a song first, then drop a file on one of its stems.', 3600); return; }
  toast('Loading ' + file.name + ' into ' + stem.toUpperCase() + '...', 60000);
  try {
    const d = await SSSongs.decodeStemFile(file, engine);
    if (!engine.setStemAudio(stem, d.pair, d.sampleRate)) throw new Error('no song loaded');
    if (loadedSong) loadedSong.slots[ALL_STEMS.indexOf(stem)] = true;
    renderSongs(); updateStemLabel(); refreshCards(); requestRadar();
    toast(file.name + ' is now ' + stem.toUpperCase() + ' (until the song is loaded again)', 4200);
    buzz(20);
  } catch (e) {
    toast('Could not use ' + file.name + ': ' + (e.message || e.name), 4600);
  }
}

/* ---------------- stem splitter (SpatialStage Helper) ---------------- */

// A plain song (kind 'single': one stereo mix) can be split into stems by
// SpatialStage Helper - a small program the user installs once (helper/),
// which runs Demucs on their own PC (js/helper.js talks to it). A split
// song's drums can then be split into kit parts the same way (helper 1.1+).
// Jobs run one at a time; a song keeps playing until its new stems are
// back, then swaps over at the same position.
const helperBar = $('helperBar'), helperDot = $('helperDot'), helperText = $('helperText'), helperOpenBtn = $('helperOpenBtn');
const helperDialog = $('helperDialog'), helperStatusLine = $('helperStatusLine');
const helperSetup = $('helperSetup'), helperReady = $('helperReady');
const helperAutoEl = $('helperAuto'), helperModelRow = $('helperModelRow'), helperModelHint = $('helperModelHint');
const helperPartsEl = $('helperParts'), helperPartsRow = $('helperPartsRow');
const libraryList = $('libraryList'), libraryCount = $('libraryCount');
const HELPER_PREFS_KEY = 'spatialstage.helper.prefs';
const helperPrefs = { auto: true, model: 'htdemucs_6s', parts: false };
try { Object.assign(helperPrefs, JSON.parse(localStorage.getItem(HELPER_PREFS_KEY) || '{}')); } catch (e) {}
const saveHelperPrefs = () => { try { localStorage.setItem(HELPER_PREFS_KEY, JSON.stringify(helperPrefs)); } catch (e) {} };
// The helper runs on a PC; on a phone 127.0.0.1 is the phone itself.
const isPhone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const canSplit = (song) => song.kind === 'single' && !!song.file;
const helperReadyNow = () => !!SSHelper.info && !SSHelper.outdated;
const hasParts = (stems) => DRUM_PARTS.some((p) => stems.includes(p));
// A helper song with a drums stem and no parts yet, on a helper that can
// split drums.
const canSplitParts = (song) => song.kind === 'helper' && song.stems.includes('drums') && !hasParts(song.stems) && SSHelper.supports('parts');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let helperChecked = false, helperChecking = false, splitHintShown = false;
const splitQueue = [];
let splitting = null; // the song being worked on right now
let helperPoll = null;

async function checkHelper() {
  if (helperChecking) return helperReadyNow();
  helperChecking = true;
  const was = helperReadyNow();
  if (!helperChecked) { helperChecked = true; refreshHelperUi(); }
  await SSHelper.probe();
  helperChecking = false;
  refreshHelperUi();
  if (helperReadyNow() && !was) {
    // Plain songs added while it was away get their turn now.
    if (helperPrefs.auto) songs.filter(s => canSplit(s) && !s.split).forEach(s => queueSplit(s, true));
    pumpSplits();
    if (helperDialog.open) refreshLibrary();
    renderSongs();
    refreshLed();
  }
  return helperReadyNow();
}

// Keep an eye on the helper: quickly while the dialog is open or songs are
// waiting for it, lazily otherwise. A split in progress polls its own job.
function scheduleHelperPoll() {
  clearTimeout(helperPoll);
  if (!helperChecked) return;
  const quick = helperDialog.open || (!helperReadyNow() && splitQueue.length > 0);
  helperPoll = setTimeout(async () => {
    if (!document.hidden && !splitting) await checkHelper();
    scheduleHelperPoll();
  }, quick ? 3000 : 15000);
}

function helperSummary() {
  const info = SSHelper.info;
  const waiting = splitQueue.length;
  if (splitting && splitting.split) {
    const s = splitting.split;
    const what = s.parts ? 'Splitting the drums of ' : 'Splitting ';
    const pct = s.state === 'running' ? ' ' + Math.round(s.pct * 100) + '%' : '...';
    return { dot: 'busy', text: what + splitting.name + pct + (waiting ? ' · ' + waiting + ' waiting' : ''), btn: 'Open' };
  }
  if (info && SSHelper.outdated) return { dot: 'missing', text: 'Your SpatialStage Helper is out of date', btn: 'Update' };
  if (info) return { dot: 'ready', text: 'Stem splitter ready (' + (info.device === 'cuda' ? 'GPU' : 'CPU') + ')' + (helperPrefs.auto ? ' · splits new songs' : ''), btn: 'Library' };
  if (helperChecking && !SSHelper.seen) return { dot: '', text: 'Looking for the helper...', btn: 'Open' };
  if (helperChecked && SSHelper.seen) return { dot: 'missing', text: 'Stem splitter not running' + (waiting ? ' · ' + waiting + ' waiting' : ''), btn: 'Start' };
  return { dot: '', text: 'Split plain songs into stems - free helper for your PC', btn: 'Set up' };
}

function refreshHelperUi() {
  helperBar.hidden = isPhone;
  const sum = helperSummary();
  helperDot.className = 'helper-dot' + (sum.dot ? ' ' + sum.dot : '');
  helperText.textContent = sum.text;
  helperText.title = sum.text;
  helperOpenBtn.textContent = sum.btn;
  if (!helperDialog.open) return;
  const info = SSHelper.info, ready = helperReadyNow();
  helperSetup.hidden = ready;
  helperReady.hidden = !ready;
  helperStatusLine.className = 'helper-status' + (ready ? ' ready' : helperChecked && !helperChecking ? ' missing' : '');
  if (ready) {
    helperStatusLine.textContent = 'Connected: SpatialStage Helper ' + info.version + ' on this PC, splitting on the ' +
      (info.device === 'cuda' ? 'GPU (' + (info.deviceName || 'NVIDIA') + ')' : 'CPU') + '.' + (splitting ? ' Busy: ' + helperText.textContent + '.' : '');
  } else if (info && SSHelper.outdated) {
    helperStatusLine.textContent = 'Your helper (' + info.version + ') is older than this page needs. Download it again and run the installer - it updates in place and keeps your split songs.';
  } else if (helperChecking || !helperChecked) {
    helperStatusLine.textContent = 'Looking for the helper on this PC...';
  } else {
    helperStatusLine.textContent = 'Not found on this PC: it is not installed, not running, or the browser was not allowed to reach it.';
  }
  helperAutoEl.checked = !!helperPrefs.auto;
  helperPartsEl.checked = !!helperPrefs.parts;
  // Drum parts need helper 1.1: say so rather than offer a box that does nothing.
  helperPartsEl.disabled = !SSHelper.supports('parts');
  helperPartsRow.title = SSHelper.supports('parts') ? '' : 'Needs SpatialStage Helper 1.1 - download it again and run the installer';
  setSegActive(helperModelRow, helperPrefs.model);
  const m = info && (info.models || []).find(x => x.id === helperPrefs.model);
  helperModelHint.textContent = m ? m.label + (m.downloaded ? '' : ' - its model downloads the first time it is used') : '';
}

function openHelperDialog() {
  if (!helperDialog.open) helperDialog.showModal();
  refreshHelperUi();
  checkHelper().then(() => { if (helperReadyNow()) refreshLibrary(); scheduleHelperPoll(); });
}
helperDialog.addEventListener('close', () => scheduleHelperPoll());
$('helperCloseBtn').addEventListener('click', () => helperDialog.close());
// Clicking the dimmed area outside closes it too.
helperDialog.addEventListener('click', (e) => { if (e.target === helperDialog) helperDialog.close(); });
helperOpenBtn.addEventListener('click', () => { if (helperOpenBtn.textContent === 'Start') launchHelper(); openHelperDialog(); });
$('helperRetryBtn').addEventListener('click', () => { helperStatusLine.textContent = 'Looking for the helper on this PC...'; checkHelper().then(() => { if (helperReadyNow()) refreshLibrary(); }); });
$('helperStartBtn').addEventListener('click', launchHelper);
helperAutoEl.addEventListener('change', () => {
  helperPrefs.auto = helperAutoEl.checked; saveHelperPrefs();
  if (helperPrefs.auto && helperReadyNow()) songs.filter(s => canSplit(s) && !s.split).forEach(s => queueSplit(s, true));
  refreshHelperUi();
});
helperPartsEl.addEventListener('change', () => { helperPrefs.parts = helperPartsEl.checked; saveHelperPrefs(); });
bindSegRow(helperModelRow, (v) => { helperPrefs.model = v; saveHelperPrefs(); refreshHelperUi(); });

// The installer registers spatialstage-helper:// to start the helper; the
// browser asks before opening it. Not installed, nothing happens - and the
// setup steps are right there in the dialog.
function launchHelper() {
  window.location.href = 'spatialstage-helper://start';
  helperStatusLine.className = 'helper-status';
  helperStatusLine.textContent = 'Starting the helper... If nothing happens, start "SpatialStage Helper" from the Start menu.';
  let tries = 0;
  const again = async () => {
    if (await checkHelper()) { refreshLibrary(); return; }
    if (++tries < 12) setTimeout(again, 2000);
  };
  setTimeout(again, 2000);
}

// The first plain song added without the helper gets one pointer to it.
function offerSplitting() {
  if (isPhone) return;
  if (SSHelper.seen && !helperReadyNow()) { checkHelper(); return; } // set up before - look for it now
  if (splitHintShown) return;
  splitHintShown = true;
  setTimeout(() => {
    if (helperDialog.open || helperReadyNow()) return; // already on it
    toast('Plain songs play as one sound. To move vocals, drums and bass separately, split them with the free Stem splitter (below the song list).', 5600);
  }, 1500);
}

async function refreshLibrary() {
  if (!helperReadyNow()) return;
  let list;
  try { list = await SSHelper.songs(); }
  catch (e) { libraryList.innerHTML = '<div class="lib-empty"></div>'; libraryList.firstChild.textContent = 'Could not read the library: ' + e.message; return; }
  libraryCount.textContent = list.length ? '(' + list.length + ')' : '';
  libraryList.textContent = '';
  if (!list.length) { libraryList.innerHTML = '<div class="lib-empty">Nothing split yet - drop a song on the page.</div>'; return; }
  for (const meta of list) {
    const row = document.createElement('div');
    row.className = 'lib-item';
    const name = document.createElement('span');
    name.className = 'lib-name'; name.textContent = meta.name; name.title = meta.name;
    const info = document.createElement('span');
    info.className = 'lib-meta';
    const own = meta.stems.filter((s) => !IS_PART.has(s) && s !== LEFTOVER).length;
    info.textContent = formatTime(meta.duration) + ' · ' + own + ' stems' + (hasParts(meta.stems) ? ' + kit' : '');
    const inList = songs.some(s => s.helperId === meta.id);
    const add = document.createElement('button');
    add.className = 'dlg-btn'; add.textContent = inList ? 'In list' : 'Add'; add.disabled = inList;
    add.addEventListener('click', () => { addFromLibrary(meta); refreshLibrary(); });
    const del = document.createElement('button');
    del.className = 'song-remove'; del.innerHTML = '&times;'; del.title = 'Delete these stems from this PC';
    del.addEventListener('click', async () => {
      if (!confirm('Delete the stems of "' + meta.name + '" from this PC? The original song file is not touched.')) return;
      try { await SSHelper.removeSong(meta.id); } catch (e) { toast('Could not delete: ' + e.message); }
      refreshLibrary();
    });
    row.append(name, info, add, del);
    libraryList.appendChild(row);
  }
}

// A song the helper holds the stems of. stems is the helper's own list
// (drums_rest included); songs.js picks the files per card from it.
function helperDescriptor(meta, file) {
  const stems = meta.stems.slice();
  const parts = hasParts(stems);
  const slots = ALL_STEMS.map((s) => (s === 'drums' && parts ? stems.includes(LEFTOVER) : stems.includes(s)));
  return { name: meta.name, kind: 'helper', helperId: meta.id, stems, file: file || null, duration: meta.duration, slots };
}

function addFromLibrary(meta) {
  if (songs.some(s => s.helperId === meta.id)) return;
  const song = helperDescriptor(meta, null);
  songs = sortByOrder(songs.concat([song]));
  reindex(loadedSong || (loading && loading.song) || null);
  saveOrder();
  renderSongs(); refreshTransportButtons();
  toast('Added ' + meta.name);
  if (!engine.song && !loading) loadSongIndex(songs.indexOf(song), false);
}

// What a song's split button says and does, by state.
function paintSplit(row, btn, song) {
  const s = song.split;
  const kit = canSplitParts(song) || (s && s.parts);
  let text = kit ? '✂ kit' : '✂';
  let title = kit ? 'Split the drums into kick, snare, toms, hi-hat, ride and crash (slow - several times the song\'s length)' : 'Split into stems with SpatialStage Helper';
  let cls = '';
  if (s && s.state === 'queued') { text = '✂ ' + (helperReadyNow() ? 'queued' : 'waiting'); title = helperReadyNow() ? 'Waiting for the song before it - click to take it out of the queue' : 'Waiting for SpatialStage Helper - click to cancel'; cls = 'active'; }
  else if (s && s.state === 'running') { text = '✂ ' + Math.round(s.pct * 100) + '%'; title = (s.message || 'splitting') + ' - click to stop'; cls = 'active'; }
  else if (s && s.state === 'preparing') { text = '✂ ...'; title = (s.message || 'preparing') + ' - click to stop'; cls = 'active'; }
  else if (s && s.state === 'error') { text = '✂ failed'; title = 'Could not split: ' + s.message + ' - click to try again'; cls = 'failed'; }
  btn.textContent = text;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.className = 'song-split' + (cls ? ' ' + cls : '');
  const busy = s && (s.state === 'running' || s.state === 'preparing');
  row.classList.toggle('splitting', !!busy);
  row.style.setProperty('--s', busy ? Math.round((s.pct || 0) * 100) + '%' : '0%');
}

function refreshSongSplit(song) {
  const row = songList.children[songs.indexOf(song)];
  const btn = row && row.querySelector('.song-split');
  if (btn) paintSplit(row, btn, song); else renderSongs();
  refreshHelperUi();
}

function onSplitClick(song) {
  const s = song.split;
  if (!s || s.state === 'error') {
    const parts = canSplitParts(song) || (s && s.parts);
    song.split = null;
    queueSplit(song, !helperReadyNow(), parts);
    if (!helperReadyNow()) openHelperDialog();
    return;
  }
  if (s.state === 'queued') { cancelSplit(song); refreshSongSplit(song); return; }
  if (confirm('Stop splitting "' + song.name + '"?')) { cancelSplit(song); refreshSongSplit(song); }
}

// parts: split this (helper) song's drums rather than the song.
function queueSplit(song, quiet, parts) {
  if (!(parts ? canSplitParts(song) : canSplit(song)) || splitQueue.includes(song) || splitting === song) return;
  song.split = { state: 'queued', pct: 0, message: 'waiting', parts: !!parts };
  splitQueue.push(song);
  refreshSongSplit(song);
  if (!quiet) toast(parts ? 'Splitting the drums of ' + song.name + ' in the background' : 'Splitting ' + song.name + ' into stems in the background');
  pumpSplits();
  scheduleHelperPoll();
}

function cancelSplit(song) {
  const i = splitQueue.indexOf(song);
  if (i >= 0) splitQueue.splice(i, 1);
  if (song.split && splitting === song) {
    song.split.cancelled = true;
    if (song.split.jobId) SSHelper.cancel(song.split.jobId).catch(() => {});
  } else if (song.split) song.split = null;
}

async function followJob(song, job, set) {
  song.split.jobId = job.id;
  if (song.split.cancelled) SSHelper.cancel(job.id).catch(() => {});
  while (job.state === 'queued' || job.state === 'running') {
    set({ state: 'running', pct: job.progress || 0, message: job.message });
    await sleep(1000);
    job = await SSHelper.job(job.id);
  }
  if (job.state === 'cancelled' || song.split.cancelled) throw new Error('cancelled');
  if (job.state !== 'done') throw new Error(job.error || 'the split failed');
}

async function pumpSplits() {
  if (splitting || !splitQueue.length || !helperReadyNow()) return;
  const song = splitQueue.shift();
  splitting = song;
  const parts = !!(song.split && song.split.parts);
  const model = helperPrefs.model;
  const set = (patch) => { if (song.split) Object.assign(song.split, patch); refreshSongSplit(song); };
  try {
    let meta;
    if (parts) {
      set({ state: 'preparing', pct: 0, message: 'asking the helper' });
      await followJob(song, await SSHelper.startParts(song.helperId), set);
      meta = await SSHelper.song(song.helperId);
    } else {
      set({ state: 'preparing', pct: 0, message: 'reading the song' });
      const key = await SSHelper.fileKey(song.file);
      const id = key + '-' + model;
      meta = await SSHelper.song(id);  // split before (maybe under another name)
      if (!meta && !song.split.cancelled) {
        set({ message: 'decoding the song' });
        const wav = await SSHelper.toWav(song.file);
        if (song.split.cancelled) throw new Error('cancelled');
        set({ message: 'sending it to the helper' });
        await followJob(song, await SSHelper.startJob(wav, key, song.name, model), set);
        meta = await SSHelper.song(id);
      }
    }
    if (!meta) throw new Error('the helper lost the stems');
    if (song.split.cancelled) throw new Error('cancelled');
    applySplit(song, meta);
  } catch (e) {
    const cancelled = song.split && song.split.cancelled;
    song.split = cancelled ? null : { state: 'error', pct: 0, message: e.message, parts };
    if (!cancelled && songs.includes(song)) toast('Could not split ' + song.name + ': ' + e.message, 5000);
    if (!cancelled) checkHelper(); // it may have been closed mid-split
  } finally {
    splitting = null;
    if (songs.includes(song)) refreshSongSplit(song);
    refreshHelperUi();
    if (helperDialog.open) refreshLibrary();
    pumpSplits();
  }
}

// The song becomes a stem song (or gains its drum parts). If it is the one
// loaded, reload it from its stems at the same spot, playing if it was,
// with the stems left exactly as they are set.
function applySplit(song, meta) {
  const hadParts = song.kind === 'helper' && hasParts(song.stems);
  const next = helperDescriptor(meta, song.file);
  next.name = song.name; // keep a rename made while it was splitting
  Object.assign(song, next);
  song.split = null;
  if (!songs.includes(song)) return;
  renderSongs();
  const gotParts = hasParts(song.stems) && !hadParts;
  toast(song.name + (gotParts ? ': drums split into kit parts' : ': split into ' + meta.stems.length + ' stems'));
  if (song === loadedSong || (loading && loading.song === song)) {
    const pos = engine.position(), was = engine.playing || !!(loading && loading.autoplay);
    loadedSong = null;
    loadSongIndex(songs.indexOf(song), was, pos, true);
  }
  // Kit parts next, if asked for and this was a plain split.
  if (!gotParts && helperPrefs.parts && canSplitParts(song)) queueSplit(song, true, true);
}

/* ---------------- transport ---------------- */

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function tickPosition() {
  if (!seeking) {
    const dur = engine.song ? engine.song.duration : 0;
    const shown = engine.position();
    seekBar.max = dur > 0 ? dur : 1;
    seekBar.value = shown;
    posTimeEl.textContent = formatTime(shown);
    durTimeEl.textContent = formatTime(dur);
  }
  requestAnimationFrame(tickPosition);
}
requestAnimationFrame(tickPosition);

const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5.5h3.6v13H7zM13.4 5.5H17v13h-3.6z"/></svg>';
function refreshTransportButtons() {
  const icon = engine.playing ? ICON_PAUSE : ICON_PLAY;
  if (playPauseBtn.dataset.icon !== icon) { playPauseBtn.innerHTML = icon; playPauseBtn.dataset.icon = icon; }
  playPauseBtn.setAttribute('aria-label', engine.playing ? 'Pause' : 'Play');
  playPauseBtn.classList.toggle('playing', engine.playing);
  recordBtn.classList.toggle('recording', engine.isRecording);
  recordBtn.setAttribute('aria-label', engine.isRecording ? 'Stop recording' : 'Record');
  prevBtn.disabled = nextBtn.disabled = songs.length === 0;
  stopBtn.disabled = !engine.song;
  seekBar.disabled = !engine.song;
  // The ▶ / ❚❚ mark on the current song row follows play/pause.
  const current = songs[songIndex];
  const row = current && !(loading && loading.song === current) ? songList.children[songIndex] : null;
  const mark = row && row.querySelector('.song-mark');
  if (mark) paintMark(mark, current);
  refreshStatus();
}
engine.onStateChange = () => {
  refreshTransportButtons();
  // the beat analysis reports progress through here
  if (activeSpatialStem && spatial[activeSpatialStem].fftMode === 6 && !beatBlock.hidden) beatsHintEl.textContent = beatsHintText(spatial[activeSpatialStem]);
};
engine.onEnded = () => { if (songs.length) loadSongIndex((songIndex + 1) % songs.length, true); };

// Keep playing across a skip if we were playing, or were about to be.
const wantsPlay = () => engine.playing || !!(loading && loading.autoplay);
prevBtn.addEventListener('click', () => {
  if (!songs.length) return;
  // Like any player: back to the top of this song first, previous song on
  // a second press.
  if (engine.song && engine.position() > 3) engine.seek(0);
  else loadSongIndex(songIndex < 0 ? 0 : (songIndex - 1 + songs.length) % songs.length, wantsPlay());
  buzz(15);
});
nextBtn.addEventListener('click', () => { if (songs.length) loadSongIndex(songIndex < 0 ? 0 : (songIndex + 1) % songs.length, wantsPlay()); buzz(15); });
stopBtn.addEventListener('click', () => { engine.stop(); buzz(15); });
playPauseBtn.addEventListener('click', async () => {
  await engine.ensure();
  if (engine.playing) engine.pause();
  else if (engine.song) engine.play();
  else if (loading) { loading.autoplay = true; toast('Will play as soon as ' + loading.song.name + ' has loaded'); }
  else if (songs.length) loadSongIndex(songIndex < 0 ? 0 : songIndex, true);
  else nudgeAddSongs();
  buzz(15);
});
// Play with an empty list used to do nothing at all; point at the box.
function nudgeAddSongs() {
  toast('Add a song first - drop files on the box, or tap it to choose');
  dropZone.classList.remove('nudge'); void dropZone.offsetWidth; dropZone.classList.add('nudge');
  dropZone.addEventListener('animationend', () => dropZone.classList.remove('nudge'), { once: true });
  const r = dropZone.getBoundingClientRect();
  if (r.top < 0 || r.bottom > window.innerHeight) dropZone.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// WAV or MP3 (the rig's bridge makes an MP3 of every take with ffmpeg; here
// LAME runs in the page - js/mp3.js).
let recordFormat = pref('recordFormat', 'wav') === 'mp3' ? 'mp3' : 'wav';
setSegActive($('recordFormatRow'), recordFormat);
bindSegRow($('recordFormatRow'), (v) => { recordFormat = v; setPref('recordFormat', v); setSegActive($('recordFormatRow'), v); });

function offerTake(blob, name, secs) {
  recordStatus.hidden = false;
  recordStatus.classList.remove('live');
  recordStatus.innerHTML = 'Take ready (' + formatTime(secs) + ', ' + (blob.size / 1048576).toFixed(1) + ' MB): <a href="#" id="takeLink"></a>';
  const link = $('takeLink');
  link.textContent = 'download ' + name;
  link.addEventListener('click', (e) => { e.preventDefault(); download(blob, name); });
}

let recTimer = null;
recordBtn.addEventListener('click', async () => {
  await engine.ensure();
  if (engine.isRecording) {
    clearInterval(recTimer); recTimer = null;
    const secs = engine.recordingSeconds;
    const take = engine.stopRecording();
    const stamp = 'spatialstage-take-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    buzz(15);
    refreshTransportButtons();
    const wav = () => new Blob([SSWav.encodeWav(take.channels, take.sampleRate)], { type: 'audio/wav' });
    if (recordFormat === 'mp3') {
      recordStatus.hidden = false; recordStatus.classList.remove('live');
      recordStatus.textContent = 'Encoding MP3...';
      try {
        const blob = await SSMp3.encode(take, (x) => { recordStatus.textContent = 'Encoding MP3... ' + Math.round(x * 100) + '%'; });
        offerTake(blob, stamp + '.mp3', secs);
      } catch (e) {
        toast('MP3 failed (' + e.message + ') - here is the WAV instead.', 4500);
        offerTake(wav(), stamp + '.wav', secs);
      }
    } else offerTake(wav(), stamp + '.wav', secs);
    return;
  }
  engine.startRecording();
  recordStatus.hidden = false;
  recordStatus.classList.add('live');
  // A running clock, so a take left recording is noticed.
  const tick = () => { recordStatus.textContent = '● REC ' + formatTime(engine.recordingSeconds) + (engine.playing ? '' : ' (paused - recording silence)') + ' · tap ● to stop'; };
  tick();
  recTimer = setInterval(tick, 500);
  buzz([15, 60, 15]);
  if (recordFormat === 'mp3') SSMp3.load().catch(() => {});   // fetch the encoder now, not at the end
  refreshTransportButtons();
});

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);
}

// `seeking` holds the bar still under the finger. It is cleared by any
// release, and a seek happens only if the value was actually dragged.
const commitSeek = () => {
  if (seekDirty) engine.seek(Number(seekBar.value));
  seeking = false; seekDirty = false;
};
seekBar.addEventListener('pointerdown', () => { seeking = true; seekDirty = false; });
seekBar.addEventListener('input', () => { seeking = true; seekDirty = true; posTimeEl.textContent = formatTime(Number(seekBar.value)); });
seekBar.addEventListener('change', commitSeek);
seekBar.addEventListener('pointerup', commitSeek);
seekBar.addEventListener('pointercancel', commitSeek);

masterVolSlider.addEventListener('input', () => {
  const v = Number(masterVolSlider.value);
  masterVolLabel.textContent = 'Master ' + Math.round(v * 100) + '%';
  engine.setMasterVolume(v);
});

bindSegRow($('panModeRow'), (v) => { engine.setPanMode(v); setSegActive($('panModeRow'), v); });

/* ---------------- output: quad speakers, L/R swap ---------------- */

const quadOutputRow = $('quadOutputRow'), lrSwapRow = $('lrSwapRow');
const outputPrefs = Object.assign({ quad: false, lrSwap: false }, pref('output', {}));
function showOutput() {
  setSegActive(quadOutputRow, engine.quad ? 1 : 0);
  setSegActive(lrSwapRow, engine.lrSwap ? 1 : 0);
}
function setQuad(on, quiet) {
  const ok = engine.setQuad(on);
  if (!ok) {
    if (!quiet) toast('This output has ' + engine.maxChannels + ' channels. Quad needs a 4-channel (or 5.1/7.1) sound card set as the default playback device.', 6000);
    engine.setQuad(false);
  }
  outputPrefs.quad = engine.quad; setPref('output', outputPrefs);
  showOutput();
}
// Called once audio has started (the device's channel count is only known then).
function applyOutputPrefs() {
  engine.setLrSwap(outputPrefs.lrSwap);
  if (outputPrefs.quad) setQuad(true, true);
  showOutput();
}
bindSegRow(quadOutputRow, async (v) => { await engine.ensure(); setQuad(v === 1); buzz(15); });
bindSegRow(lrSwapRow, (v) => {
  engine.setLrSwap(v === 1);
  outputPrefs.lrSwap = v === 1; setPref('output', outputPrefs);
  showOutput(); buzz(15);
});

/* ---------------- LED strip (through the helper) ---------------- */

const led = new SSLedStrip(ALL_STEMS, STEM_COLOR);
led.getState = () => {
  const azimuth = {}, gain = {};
  for (const s of ALL_STEMS) {
    azimuth[s] = motion.stems[s].effective;
    gain[s] = ((engine.song && engine.hasStem(s)) || engine.live[s]) && !mutedStems.has(s) ? volume[s] : 0;
  }
  return { azimuth, gain, mirror: engine.lrSwap };
};
const ledStatus = $('ledStatus'), ledSetup = $('ledSetup');
let ledWanted = pref('ledOn', false);
led.onError = (msg) => { ledStatus.textContent = 'Not reaching the strip: ' + msg; };

let stripEditorKey = '';
function refreshLed() {
  ledSetup.hidden = isPhone;
  renderStripEditor();
  const can = led.configured && helperReadyNow() && SSHelper.supports('led');
  if (ledWanted && can) led.start(); else led.stop();
  setSegActive($('ledRunRow'), led.running ? 1 : 0);
  const live = led.strips.filter((x) => x.host);
  ledStatus.textContent = !led.configured ? 'Add a strip and enter its WLED address and LED count.'
    : !helperReadyNow() ? 'Start SpatialStage Helper to drive the strips.'
    : !SSHelper.supports('led') ? 'Your helper is too old for the LED strip - download it again and run the installer (1.1).'
    : led.running ? 'Sending to ' + live.map((x) => x.name + ' (' + x.host + ', ' + x.count + ' LEDs)').join(', ') + '.' : 'Off.';
  refreshCards();
}

// The strip list's editor: one card per strip. Rebuilt only when the list changes, and never
// under a field that is being edited.
function renderStripEditor() {
  const box = $('ledStripEditor');
  const key = JSON.stringify(led.strips);
  if (key === stripEditorKey) return;
  if (box.contains(document.activeElement) && document.activeElement !== document.body) return;
  stripEditorKey = key;
  box.textContent = '';
  const commit = () => { led.setStrips(led.strips); stripEditorKey = JSON.stringify(led.strips); if (!SSHelper.info) checkHelper(); refreshLed(); refreshLedPanel(); };
  led.strips.forEach((strip, idx) => {
    const card = document.createElement('div');
    card.className = 'strip-card';
    const head = document.createElement('div');
    head.className = 'strip-head';
    const name = document.createElement('input');
    name.type = 'text'; name.value = strip.name; name.maxLength = 40; name.setAttribute('aria-label', 'Strip name');
    name.addEventListener('change', () => { strip.name = name.value.trim() || 'Strip ' + (idx + 1); commit(); });
    const del = document.createElement('button');
    del.className = 'close-btn'; del.textContent = '\u00d7'; del.title = 'Remove this strip';
    del.addEventListener('click', () => { led.strips.splice(idx, 1); commit(); stripEditorKey = ''; renderStripEditor(); });
    head.append(name, del);
    card.appendChild(head);
    const grid = document.createElement('div');
    grid.className = 'strip-grid';
    const field = (label, el) => { const l = document.createElement('label'); l.textContent = label; grid.append(l, el); };
    const input = (key, type, ph) => {
      const i = document.createElement('input');
      i.type = type; i.value = strip[key]; if (ph) i.placeholder = ph;
      i.addEventListener('change', () => { strip[key] = type === 'number' ? Number(i.value) || 0 : i.value.trim(); commit(); });
      return i;
    };
    field('WLED address', input('host', 'text', '192.168.1.50'));
    field('LEDs in the ring', input('count', 'number'));
    field('First ring LED', input('startIndex', 'number'));
    field('LED straight ahead', input('frontIndex', 'number'));
    const dir = document.createElement('select');
    for (const [v, t] of [[true, 'Clockwise (to the listener\u2019s right)'], [false, 'Anticlockwise']]) {
      const o = document.createElement('option'); o.value = String(v); o.textContent = t; if (strip.clockwise === v) o.selected = true; dir.appendChild(o);
    }
    dir.addEventListener('change', () => { strip.clockwise = dir.value === 'true'; commit(); });
    field('LED numbers go', dir);
    const br = document.createElement('input');
    br.type = 'range'; br.min = 0; br.max = 1; br.step = 0.05; br.value = strip.brightness;
    br.addEventListener('input', () => { strip.brightness = Number(br.value); led.save(); });
    field('Brightness', br);
    card.appendChild(grid);
    box.appendChild(card);
  });
}
$('ledStripAddBtn').addEventListener('click', () => {
  if (led.strips.length >= 8) { toast('Up to 8 strips'); return; }
  led.strips.push({ id: 's' + Date.now().toString(36), name: 'Strip ' + (led.strips.length + 1) });
  led.setStrips(led.strips);
  stripEditorKey = ''; refreshLed(); refreshLedPanel();
});
bindSegRow($('ledRunRow'), (v) => {
  ledWanted = v === 1; setPref('ledOn', ledWanted);
  if (ledWanted && !helperReadyNow()) checkHelper().then(refreshLed);
  refreshLed();
});
ledSetup.addEventListener('toggle', () => { if (ledSetup.open && !SSHelper.info && SSHelper.seen) checkHelper(); });

/* ---------------- external input (EXT) and added stems ---------------- */

// Per stem: which sound input, which of its channel pairs, how loud. Saved in this browser (not in a
// setup: it belongs to this computer's hardware). The input stems are shown once added.
const liveSettings = {};
for (const s of ALL_STEMS) liveSettings[s] = { deviceId: '', label: '', pair: 0, gain: 1 };
const inputAdded = {};
{
  const saved = pref('live', {}), added = pref('inputsAdded', {});
  for (const s of ALL_STEMS) if (saved[s]) Object.assign(liveSettings[s], saved[s]);
  for (const s of INPUT_STEMS) inputAdded[s] = !!added[s];
}
const saveLive = () => { setPref('live', liveSettings); setPref('inputsAdded', inputAdded); };

const extPanel = $('extPanel'), extPairRow = $('extPairRow'), extGainEl = $('extGain'), extDeviceEl = $('extDevice'), extHint = $('extHint');
const addStemBtn = $('addStemBtn');
let extGainTouched = 0;

// Turn a saved choice into a running input (needs the tap that started audio, or any other tap).
async function applyLive(stem, quiet) {
  const l = liveSettings[stem];
  try {
    const r = await engine.setLive(stem, { deviceId: l.deviceId, pair: l.pair, gain: l.gain });
    if (l.pair && r.channels && 2 * (l.pair - 1) >= r.channels) toast(stemTitle(stem) + ': that device has only ' + r.channels + ' channel' + (r.channels > 1 ? 's' : '') + ' - using the first.', 4200);
    return true;
  } catch (e) {
    l.pair = 0;
    saveLive();
    if (!quiet) toast('Could not open the input: ' + (e.message || e.name), 5000);
    return false;
  } finally { refreshCards(); refreshExtPanel(); }
}
async function restoreLiveInputs() {
  for (const s of ALL_STEMS) if (liveSettings[s].pair) await applyLive(s, true);
}

async function fillDevices() {
  const list = await engine.inputDevices().catch(() => []);
  const cur = activeExtStem ? liveSettings[activeExtStem].deviceId : '';
  extDeviceEl.textContent = '';
  const def = document.createElement('option');
  def.value = ''; def.textContent = 'Default input';
  extDeviceEl.appendChild(def);
  for (const d of list) {
    if (!d.deviceId || d.deviceId === 'default') continue;
    const o = document.createElement('option');
    o.value = d.deviceId; o.textContent = d.label;
    extDeviceEl.appendChild(o);
  }
  extDeviceEl.value = [...extDeviceEl.options].some((o) => o.value === cur) ? cur : '';
}

function openExtPanel(stem) {
  activeExtStem = (activeExtStem === stem) ? null : stem;
  if (activeExtStem) {
    if (activeSpatialStem) openSpatialPanel(activeSpatialStem);   // one panel at a time
    if (activeLedStem) openLedPanel(activeLedStem);
    $('extStemName').textContent = stemTitle(stem);
    $('extStemName').style.color = STEM_COLOR[stem];
    fillDevices();
  }
  extPanel.hidden = activeExtStem === null;
  refreshExtPanel();
  syncSideCol();
  refreshCards();
}
function refreshExtPanel() {
  if (!activeExtStem) return;
  const l = liveSettings[activeExtStem];
  setSegActive(extPairRow, l.pair);
  if (Date.now() - extGainTouched > 1000) extGainEl.value = l.gain;
  $('extGainOut').textContent = Math.round(l.gain * 100) + '%';
  if ([...extDeviceEl.options].some((o) => o.value === l.deviceId)) extDeviceEl.value = l.deviceId;
  $('extRemoveBlock').hidden = !IS_INPUT.has(activeExtStem);
  const e = engine.live[activeExtStem];
  extHint.textContent = !navigator.mediaDevices ? 'This browser cannot open audio inputs here: it needs an https:// page (or localhost).'
    : e ? 'On. If it sounds doubled or echoes, use headphones.' : l.pair ? 'Starting...' : 'Off - pick the channels of the input to use.';
}
bindSegRow(extPairRow, async (v) => {
  if (!activeExtStem) return;
  const l = liveSettings[activeExtStem];
  l.pair = v;
  l.label = extDeviceEl.selectedOptions[0] ? extDeviceEl.selectedOptions[0].textContent : '';
  saveLive(); refreshExtPanel();
  await applyLive(activeExtStem);
  if (v) fillDevices();   // device names appear once permission is given
  buzz(15);
});
extDeviceEl.addEventListener('change', async () => {
  if (!activeExtStem) return;
  const l = liveSettings[activeExtStem];
  l.deviceId = extDeviceEl.value;
  l.label = extDeviceEl.selectedOptions[0].textContent;
  saveLive();
  if (l.pair) await applyLive(activeExtStem);
});
extGainEl.addEventListener('input', () => {
  extGainTouched = Date.now();
  if (!activeExtStem) return;
  liveSettings[activeExtStem].gain = Number(extGainEl.value);
  engine.setLiveGain(activeExtStem, liveSettings[activeExtStem].gain);
  saveLive(); refreshExtPanel();
});
$('extCloseBtn').addEventListener('click', () => { if (activeExtStem) openExtPanel(activeExtStem); });
$('extRemoveBtn').addEventListener('click', async () => {
  const stem = activeExtStem;
  if (!stem) return;
  openExtPanel(stem);
  liveSettings[stem].pair = 0;
  inputAdded[stem] = false;
  saveLive();
  await engine.setLive(stem, { pair: 0 }).catch(() => {});
  refreshAddStem(); refreshCards(); requestRadar(); updateStemLabel();
});
function refreshAddStem() { addStemBtn.hidden = !INPUT_STEMS.some((s) => !inputAdded[s]); }
addStemBtn.addEventListener('click', () => {
  const stem = INPUT_STEMS.find((s) => !inputAdded[s]);
  if (!stem) return;
  inputAdded[stem] = true;
  if (!liveSettings[stem].pair) liveSettings[stem].pair = 0;
  saveLive();
  refreshAddStem(); refreshCards(); requestRadar(); updateStemLabel();
  openExtPanel(stem);
  buzz(15);
});
refreshAddStem();

// Per-stem LED look: one shared panel, like the rig's.
const ledPanel = $('ledPanel'), ledColorEl = $('ledColor'), ledSpreadEl = $('ledSpread'), ledTailEl = $('ledTail');
function openLedPanel(stem) {
  activeLedStem = (activeLedStem === stem) ? null : stem;
  ledPanel.hidden = activeLedStem === null;
  if (activeLedStem) {
    if (activeSpatialStem) openSpatialPanel(activeSpatialStem);   // one panel at a time
    if (activeExtStem) openExtPanel(activeExtStem);
    $('ledStemName').textContent = stemTitle(stem);
    refreshLedPanel();
  }
  syncSideCol();
  refreshCards();
}
function refreshLedPanel() {
  if (!activeLedStem) return;
  const look = led.cfg.stems[activeLedStem];
  setSegActive($('ledOnRow'), look.on ? 1 : 0);
  ledColorEl.value = look.color; $('ledColorHex').textContent = look.color;
  ledSpreadEl.value = look.spread; $('ledSpreadOut').textContent = Math.round(look.spread) + '°';
  ledTailEl.value = look.tail; $('ledTailOut').textContent = look.tail > 0 ? look.tail.toFixed(1) + 's' : 'off';
  refreshStripChips();
}

// Which strips this stem lights: one toggle per strip. Rebuilt only when something changed.
let stripChipsKey = '';
function refreshStripChips() {
  const row = $('ledStripsRow'), look = led.cfg.stems[activeLedStem];
  const key = activeLedStem + '|' + JSON.stringify(led.strips.map((x) => [x.id, x.name, !!x.host])) + '|' + JSON.stringify(look.strips);
  if (key === stripChipsKey) return;
  stripChipsKey = key;
  const on = new Set(Array.isArray(look.strips) ? look.strips : led.strips.map((x) => x.id));
  row.textContent = '';
  if (!led.strips.length) {
    const hint = document.createElement('div');
    hint.className = 'hint left'; hint.textContent = 'No strips yet - add one under "LED strips" in the Songs window.';
    row.appendChild(hint);
  }
  for (const strip of led.strips) {
    const b = document.createElement('button');
    b.className = 'seg-btn' + (on.has(strip.id) ? ' active' : ' off');
    b.textContent = strip.name + (strip.host ? '' : ' (no address)');
    b.addEventListener('click', () => {
      const next = new Set(on);
      if (next.has(strip.id)) next.delete(strip.id); else next.add(strip.id);
      const all = led.strips.every((x) => next.has(x.id));
      setLed({ strips: all ? null : led.strips.filter((x) => next.has(x.id)).map((x) => x.id) });
      buzz(15);
    });
    row.appendChild(b);
  }
}
const setLed = (patch) => { if (activeLedStem) { led.setStem(activeLedStem, patch); refreshLedPanel(); refreshCards(); } };
bindSegRow($('ledOnRow'), (v) => setLed({ on: v === 1 }));
ledColorEl.addEventListener('input', () => setLed({ color: ledColorEl.value }));
ledSpreadEl.addEventListener('input', () => setLed({ spread: Number(ledSpreadEl.value) }));
ledTailEl.addEventListener('input', () => setLed({ tail: Number(ledTailEl.value) }));
$('ledCloseBtn').addEventListener('click', () => { if (activeLedStem) openLedPanel(activeLedStem); });

/* ---------------- rotation ---------------- */

function updateStemLabel() {
  const shown = ALL_STEMS.filter(stemShown);
  const armed = shown.filter((s) => selectedStems.has(s));
  if (armed.length === 0) stemLabel.textContent = 'NONE ARMED';
  else if (armed.length === shown.length) stemLabel.textContent = 'ALL ARMED';
  else stemLabel.textContent = armed.map(s => s.toUpperCase()).join(', ');
}

// Applies the CHANGE in the control, not its absolute value, so a placed
// stem rotates from where it was put rather than snapping to the slider.
function applyRotation(value, via) {
  const d = value - lastSliderValue;
  lastSliderValue = value;
  if (!d) return;
  rotateArmedBy(d, via);
  val.textContent = Math.round(value) + '°';
  refreshCards(); requestRadar();
}

// One buzz per button press, not one per stem.
$('selectAllBtn').addEventListener('click', () => { ALL_STEMS.forEach(s => setArmed(s, true, true)); buzz(15); });
$('selectNoneBtn').addEventListener('click', () => { ALL_STEMS.forEach(s => setArmed(s, false, true)); buzz(15); });
$('muteNoneBtn').addEventListener('click', () => { ALL_STEMS.forEach(s => setMuted(s, false, true)); buzz(15); });
$('muteAllBtn').addEventListener('click', () => { ALL_STEMS.forEach(s => setMuted(s, true, true)); buzz(15); });
slider.addEventListener('input', () => applyRotation(Number(slider.value)));

/* ---------------- phone motion (js/sensor.js) ---------------- */

let wakeLock = null, wantWakeLock = false;
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); }
  catch (e) { console.warn('wakeLock request failed:', e.message); }
}
document.addEventListener('visibilitychange', () => {
  if (wantWakeLock && document.visibilityState === 'visible') requestWakeLock();
});

function releaseWakeLockIfUnused() {
  wantWakeLock = phoneTurn.bound || hand.running;
  if (!wantWakeLock && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

const phoneTurn = new SSPhoneTurn();
const sensorOptions = $('sensorOptions'), sensorModeRow = $('sensorModeRow'), phoneInvertRow = $('phoneInvertRow');
const turnCalBtn = $('turnCalBtn'), turnCalOut = $('turnCalOut'), sensorDbg = $('sensorDbg');
let motionProbe = null;
phoneTurn.onTurn = (turn) => { slider.value = turn; applyRotation(turn, 'phone'); };
phoneTurn.onReading = (text) => { sensorDbg.textContent = text; };
// The first real reading: a desktop browser happily accepts the listener
// and then never fires it, so the button only claims "active" after one.
phoneTurn.onFirst = () => {
  lastSliderValue = Number(slider.value);   // carry on from the slider's rotation
  sensorBtn.textContent = 'Phone motion: on';
  wantWakeLock = true; requestWakeLock();
  sensorOptions.hidden = false;
  buzz([40, 40, 40]);
};

function showSensorOptions() {
  setSegActive(sensorModeRow, phoneTurn.useAbsolute ? 1 : 0);
  sensorModeRow.querySelector('[data-value="1"]').disabled = !phoneTurn.absoluteAvailable;
  setSegActive(phoneInvertRow, phoneTurn.invert ? 1 : 0);
  turnCalOut.textContent = phoneTurn.scaleText();
}
bindSegRow(sensorModeRow, (v) => { phoneTurn.setAbsolute(v === 1); showSensorOptions(); buzz(15); });
bindSegRow(phoneInvertRow, (v) => { phoneTurn.setInvert(v === 1); showSensorOptions(); buzz(15); });
turnCalBtn.addEventListener('click', () => {
  if (!phoneTurn.bound) { toast('Turn motion on first'); return; }
  const text = phoneTurn.calibrate();
  turnCalBtn.textContent = phoneTurn.calStart === null ? 'Calibrate 360°' : 'Finish (after 1 full turn)';
  turnCalOut.textContent = text;
  if (phoneTurn.calStart === null) { lastSliderValue = 0; slider.value = 0; val.textContent = '0°'; }
  buzz(30);
});
$('turnCalResetBtn').addEventListener('click', () => { turnCalOut.textContent = phoneTurn.resetCalibration(); turnCalBtn.textContent = 'Calibrate 360°'; });

// Motion follows the stems' control setting: it turns itself on while any
// stem is set to Phone and off when none is (syncSources, below).
let motionBlocked = false;
let pairLive = false;   // a phone is paired (js/pair.js) and sending its turn
async function startMotion() {
  if (phoneTurn.bound) return;
  if (!window.isSecureContext) { motionBlocked = true; sensorBtn.textContent = 'Phone motion needs an https:// page (or localhost)'; return; }
  if (typeof DeviceOrientationEvent === 'undefined') { motionBlocked = true; sensorBtn.textContent = 'No motion sensor in this browser'; return; }
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res === 'granted') bindOrientation(); else { motionBlocked = true; sensorBtn.textContent = 'Motion permission denied - tap the page to ask again'; }
    } catch (e) { motionBlocked = true; sensorBtn.textContent = 'Phone motion: tap anywhere to allow'; }
  } else {
    bindOrientation();
  }
}

function bindOrientation() {
  phoneTurn.bind();
  sensorBtn.classList.add('active');
  sensorBtn.textContent = 'Phone motion: waiting for sensor...';
  showSensorOptions();
  clearTimeout(motionProbe);
  motionProbe = setTimeout(probeMotion, 3000);
}

// No reading yet. Many phones have the plain orientation sensor but not the
// compass-fused "absolute" one, so that stream never fires: try the gyro
// (relative) stream once before deciding there is no sensor at all.
function probeMotion() {
  if (!phoneTurn.bound || phoneTurn.seen) return;
  if (phoneTurn.useAbsolute) {
    phoneTurn.useAbsolute = false;   // not saved: it is a fallback, not a choice
    phoneTurn.bind();
    showSensorOptions();
    sensorBtn.textContent = 'Phone motion: no compass data, trying the gyro...';
    motionProbe = setTimeout(probeMotion, 3000);
    return;
  }
  motionBlocked = true;
  unbindOrientation();
  sensorBtn.textContent = 'No motion data received - allow Motion sensors for this site in the browser settings, then tap the page';
  toast('No motion data from this device - allow "Motion sensors" in the browser site settings, or use the rotate slider / dials.', 5200);
}

function unbindOrientation() {
  phoneTurn.unbind();
  clearTimeout(motionProbe);
  sensorBtn.classList.remove('active');
  sensorBtn.textContent = 'Phone motion: off (set a stem to Phone)';
  sensorDbg.textContent = '';
  turnCalBtn.textContent = 'Calibrate 360°';
  releaseWakeLockIfUnused();
}

// Zero / Centre all: every stem goes to the centre and becomes its own anchor
// point, and the sensor's current heading becomes 0, so every movement -
// phone, camera, FFT, preset - restarts from the centre.
calibrateBtn.addEventListener('click', () => {
  phoneTurn.zero();
  lastSliderValue = 0;
  slider.value = 0;
  val.textContent = '0\u00b0';
  for (const stem of ALL_STEMS) placeStem(stem, 0);
  buzz(50);
});

/* ---------------- hand tracking (camera) ---------------- */

// A hand is a cursor on the radar: the camera frame is the room seen from
// above, with you at the centre - left/right in the frame is left/right
// around your head, up in the frame is in front, down is behind. Reach
// scales how far a hand has to travel. Two gesture modes:
//   0 pinch-to-grab: a pinch that starts near a stem's dot picks that stem
//     up; it follows the hand until release (placing it, like a dial). A
//     pinch in empty space rotates the whole armed group by the hand's
//     movement, like the slider. Each hand grabs independently.
//   1 open-hand steers: the first hand's movement rotates the armed group
//     while it is open; a fist freezes it (and re-anchors on reopen).
const handBtn = $('handBtn'), handPanel = $('handPanel'), handStatus = $('handStatus');
const handVideo = $('handVideo'), handCanvas = $('handCanvas'), camBox = $('camBox');
const handModeRow = $('handModeRow'), handModeHint = $('handModeHint');
const handReachEl = $('handReach'), handReachOut = $('handReachOut');
const handLayer = $('handLayer');
const HAND_COLOUR = ['#00ff88', '#ffcc33'];
const GRAB_RADIUS_DEG = 30;
const hand = new SSHandTracker();
let handMode = 0, handReach = 1.4;
const handState = [{ grab: null, lastAz: 0 }, { grab: null, lastAz: 0 }];
let handHint = null;

function handToRadar(h) {
  const rx = (h.x - 0.5) * 2 * handReach;
  const ry = (0.5 - h.y) * 2 * handReach;
  return { az: wrap180(Math.atan2(rx, ry) * 180 / Math.PI), r: Math.min(1, Math.hypot(rx, ry)) };
}

function nearestStemTo(az) {
  let best = null, bestD = GRAB_RADIUS_DEG;
  for (const s of ALL_STEMS) {
    if (mutedStems.has(s) || !stemShown(s) || ctl[s] !== 'cam') continue;
    if (handState.some(st => st.grab === s)) continue; // the other hand has it
    const d = Math.abs(wrap180(motion.stems[s].effective - az));
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

function handleHands(hands) {
  const seen = new Set(hands.map(h => h.index));
  for (let i = 0; i < 2; i++) if (!seen.has(i)) handState[i].grab = null;
  if (handMode === 0) {
    for (const h of hands) {
      const st = handState[h.index];
      const { az } = handToRadar(h);
      if (h.pinch && !st.grab) {
        st.grab = nearestStemTo(az) || 'group';
        st.lastAz = az;
        if (st.grab !== 'group') hintIfParked(st.grab);
        buzz(10);
      } else if (h.pinch && st.grab) {
        if (st.grab === 'group') rotateArmedBy(wrap180(az - st.lastAz), 'cam');
        else placeStem(st.grab, Math.round(az));
        st.lastAz = az;
      } else if (!h.pinch && st.grab) {
        st.grab = null;
      }
    }
  } else {
    // The first hand steers, whichever tracker slot it is in.
    const h = hands[0];
    if (h) {
      const st = handState[h.index];
      const { az } = handToRadar(h);
      if (h.fist) { st.grab = null; }
      else if (!st.grab) { st.grab = 'group'; st.lastAz = az; }
      else { rotateArmedBy(wrap180(az - st.lastAz), 'cam'); st.lastAz = az; }
    }
  }
  refreshCards(); requestRadar();
}

function drawHandCursors(hands) {
  handLayer.textContent = '';
  for (const h of hands) {
    const st = handState[h.index];
    const { az, r } = handToRadar(h);
    const [x, y] = polar(az, r * RING);
    const colour = HAND_COLOUR[h.index];
    const active = handMode === 0 ? h.pinch : !h.fist;
    handLayer.appendChild(svgEl('circle', { class: 'hand-cursor' + (active ? ' pinch' : ''), cx: x, cy: y, r: active ? 9 : 12, fill: colour, stroke: colour }));
    const t = svgEl('text', { class: 'hand-cursor-label', x, y: y + 3.5 });
    t.textContent = h.handedness ? h.handedness[0] : String(h.index + 1);
    handLayer.appendChild(t);
    if (st.grab && st.grab !== 'group') {
      const [sx, sy] = polar(motion.stems[st.grab].effective, RING);
      handLayer.appendChild(svgEl('line', { x1: x, y1: y, x2: sx, y2: sy, stroke: colour, 'stroke-width': 1.5, 'stroke-dasharray': '3 3', opacity: 0.8 }));
    }
  }
}

hand.onHands = (hands) => { handleHands(hands); drawHandCursors(hands); refreshHandStatus(hands); };
hand.onStatus = (t) => { handHint = t; refreshHandStatus(hand.hands); };

function refreshHandStatus(hands) {
  if (!hand.running) { handStatus.textContent = handHint || 'off'; handStatus.classList.remove('on'); return; }
  const grabs = handState.filter(st => st.grab).map(st => st.grab === 'group' ? 'armed group' : st.grab);
  handStatus.textContent = 'tracking · ' + Math.round(hand.fps) + ' fps · ' + hands.length + (hands.length === 1 ? ' hand' : ' hands') + (grabs.length ? ' · holding ' + grabs.join(', ') : '');
  handStatus.classList.add('on');
}

// Camera tracking follows the stems' control setting like motion does: it
// starts when a stem is set to CAM and stops when none is (syncSources).
let handBlocked = false, handStarting = false;
function stopHands() {
  hand.stop();
  handBtn.classList.remove('active'); handBtn.textContent = 'Camera tracking: off (set a stem to Camera)';
  handLayer.textContent = '';
  for (const st of handState) st.grab = null;
  handPanel.hidden = true; // a black camera box with nothing in it is just clutter
  releaseWakeLockIfUnused();
}
async function startHands() {
  if (handStarting || hand.running) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    handBlocked = true; handBtn.textContent = 'Camera needs https:// (or localhost)';
    return;
  }
  handStarting = true;
  handPanel.hidden = false;
  handBtn.textContent = 'Starting camera...';
  try {
    await hand.start(handVideo, handCanvas);
    camBox.classList.toggle('mirror', hand.mirror);
    $('handMirrorBtn').textContent = 'Mirror: ' + (hand.mirror ? 'on' : 'off');
    handBtn.classList.add('active'); handBtn.textContent = 'Camera tracking: on';
    wantWakeLock = true; requestWakeLock();
    buzz([30, 30, 30]);
  } catch (e) {
    handBlocked = true;
    handStatus.textContent = 'could not start: ' + e.message;
    handBtn.textContent = 'Camera could not start - tap the page to retry';
  }
  handStarting = false;
}

// Keep the sensors matched to what the stems are set to. Blocked sources
// (no permission, no https) retry on the next tap, which iOS needs anyway.
function syncSources() {
  const anyPhone = ALL_STEMS.some((s) => ctl[s] === 'phone');
  const anyCam = ALL_STEMS.some((s) => ctl[s] === 'cam');
  if (anyPhone && !phoneTurn.bound && !motionBlocked && !pairLive) startMotion();
  else if (!anyPhone && phoneTurn.bound) { unbindOrientation(); toast('Motion off - the stems stay where they are'); }
  if (anyCam && !hand.running && !handStarting && !handBlocked) startHands();
  else if (!anyCam && hand.running) stopHands();
  else if (!anyCam && !handStarting && !handPanel.hidden && !hand.running) handPanel.hidden = true;
}
document.addEventListener('pointerdown', () => { motionBlocked = false; handBlocked = false; syncSources(); });
setInterval(syncSources, 1000);

/* ---------------- pair a phone (WebRTC, no server) ---------------- */

// The phone (remote.html in its browser, or the Rig app) sends its turn straight to this page;
// it steers the stems exactly like this device's own sensor would: armed stems set to Phone.
// Zero / Centre on the phone presses this page's Zero / Centre all.
(function () {
  const host = new SSPair.Host();
  const btn = $('pairBtn'), box = $('pairBox'), offerEl = $('pairOffer'), answerEl = $('pairAnswer'), st = $('pairStatus');
  const say = (t) => { st.textContent = t; };
  function live(on) {
    pairLive = on;
    if (on) { sensorBtn.classList.add('active'); sensorBtn.textContent = 'Phone motion: remote phone connected'; }
    else if (!phoneTurn.bound) { sensorBtn.classList.remove('active'); sensorBtn.textContent = 'Phone motion: off (set a stem to Phone)'; }
  }
  btn.addEventListener('click', async () => {
    box.hidden = false; answerEl.value = ''; offerEl.value = '';
    say('Making a code (a few seconds)...');
    btn.disabled = true;
    try {
      if (room) { room.close(); room = null; }
      offerEl.value = await host.offer();
      // Listen on a one-time relay room first: the phone drops its reply there after one scan.
      const name = SSPair.newRoom();
      room = await SSPair.relayListen(name, (reply) => { host.accept(reply).then(() => say('Reply received - connecting...')).catch(() => {}); });
      try { SSQR.render($('pairQr'), SSQR.remoteUrl(offerEl.value, name)); } catch (e) { $('pairQr').hidden = true; }
      say('Scan the QR with the phone - that is all. (If it does not connect, use the reply from the phone below.)');
    }
    catch (e) { say('Could not make a code: ' + (e.message || e)); }
    btn.disabled = false;
  });
  $('pairCopyBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(offerEl.value); say('Code copied.'); }
    catch (e) { offerEl.select(); say('Select the code and copy it.'); }
  });
  let stopScan = null, room = null;
  $('pairScanBtn').addEventListener('click', async () => {
    const video = $('pairVideo');
    if (stopScan) { stopScan(); stopScan = null; video.hidden = true; return; }
    video.hidden = false;
    say('Hold the reply QR from the phone up to the camera...');
    stopScan = await SSQR.scan(video, (text) => {
      stopScan = null; video.hidden = true;
      answerEl.value = SSQR.codeFrom(text);
      $('pairConnectBtn').click();
    }, (e) => { stopScan = null; video.hidden = true; say('Could not open the camera: ' + (e.message || e.name)); });
  });
  $('pairConnectBtn').addEventListener('click', async () => {
    try { await host.accept(SSQR.codeFrom(answerEl.value)); say('Connecting...'); }
    catch (e) { say(e.message || String(e)); }
  });
  host.onState = (state, connected) => {
    if (connected) { say('Phone connected. Set a stem to Phone and turn.'); live(true); if (room) { room.close(); room = null; } }
    else if (state === 'failed' || state === 'closed' || state === 'disconnected') { say('Phone disconnected (' + state + ').'); live(false); }
    else say('Connecting (' + state + ')...');
  };
  host.onMessage = (m) => {
    if (m.t === 'turn' && Number.isFinite(m.v)) { slider.value = m.v; applyRotation(m.v, 'phone'); }
    else if (m.t === 'zero') calibrateBtn.click();
    else if (m.t === 'hello') host.send({ t: 'hello' });
  };
})();

/* ---------------- phone as remote (through the bridge) ---------------- */

// Open this page from the bridge (https://<PC>:8443/app/) and the phone - its browser, or the
// SpatialStage Rig app with the screen off - can steer the stems from the bridge's own rig
// page: the bridge keeps each stem's phone offset (phoneRotate) and this page follows it.
// Which stems move (armed, set to Phone) is decided on the phone. Zero / Centre there puts the
// offsets back to 0. Served from anywhere else (GitHub Pages, file) there is no bridge: nothing
// happens here.
(function () {
  if (!/^\/app(\/|$)/.test(location.pathname)) return;
  const status = $('remoteStatus');
  let ws = null, last = null, retry = null;
  function show(text) { status.hidden = false; status.textContent = text; }
  function connect() {
    clearTimeout(retry);
    try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host); }
    catch (e) { retry = setTimeout(connect, 3000); return; }
    show('Phone remote: connecting to the bridge...');
    ws.onopen = () => show('Phone remote: connected. Open the bridge address on your phone (or the Rig app) and turn a stem to Phone.');
    ws.onclose = () => { show('Phone remote: bridge not reachable, retrying...'); last = null; retry = setTimeout(connect, 3000); };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type !== 'state' || !msg.phoneRotate) return;
      const now = msg.phoneRotate;
      if (last) {
        let moved = false;
        for (const stem of ALL_STEMS) {
          const v = now[stem];
          if (typeof v !== 'number' || v === last[stem]) continue;
          phone[stem] = wrap180(v);
          motion.setPhone(stem, Math.round(phone[stem]));
          moved = true;
        }
        if (moved) { refreshCards(); requestRadar(); }
      }
      last = Object.assign({}, now);   // the first snapshot only records where the phone offsets are
    };
  }
  connect();
})();

// Dim: a black cover that keeps the page running and the screen awake, so
// phone control carries on while it looks switched off.
const dimOverlay = $('dimOverlay');
$('dimBtn').addEventListener('click', () => {
  dimOverlay.hidden = false;
  wantWakeLock = true; requestWakeLock();
});
dimOverlay.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  dimOverlay.hidden = true;
  releaseWakeLockIfUnused();
});

bindSegRow(handModeRow, (v) => {
  handMode = v;
  setSegActive(handModeRow, v);
  for (const st of handState) st.grab = null;
  handModeHint.textContent = v === 0
    ? 'Pinch thumb + index near a stem on the radar to pick it up and drag it round your head; pinch in empty space to rotate every armed stem together. Two hands, two stems.'
    : 'Hold an open hand up and move it: every armed stem turns with it. Make a fist to freeze; open again to continue from there.';
});
handReachEl.addEventListener('input', () => { handReach = Number(handReachEl.value); handReachOut.textContent = handReach.toFixed(2); });
$('handFlipBtn').addEventListener('click', async () => {
  const flip = $('handFlipBtn');
  if (!hand.running) { toast('Start hand tracking first'); return; }
  flip.disabled = true;
  try { await hand.switchCamera(); }
  catch (e) { toast('Could not switch camera: ' + (e.message || e.name) + (hand.running ? ' - staying on this one' : ''), 4000); }
  flip.disabled = false;
  camBox.classList.toggle('mirror', hand.mirror);
  $('handMirrorBtn').textContent = 'Mirror: ' + (hand.mirror ? 'on' : 'off');
  if (!hand.running) {
    handBtn.classList.remove('active'); handBtn.textContent = 'Camera tracking: off (set a stem to Camera)';
    handLayer.textContent = '';
    releaseWakeLockIfUnused();
  }
});
$('handMirrorBtn').addEventListener('click', () => {
  hand.mirror = !hand.mirror;
  camBox.classList.toggle('mirror', hand.mirror);
  $('handMirrorBtn').textContent = 'Mirror: ' + (hand.mirror ? 'on' : 'off');
});

/* ---------------- keyboard ---------------- */

// Space plays/pauses from anywhere that does not already use the key
// (buttons, fields and the dial/fader sliders keep their own meaning).
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !startOverlay.hidden) return;
  if (e.target.closest && e.target.closest('input, textarea, select, button, [role="slider"], [role="button"]')) return;
  if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); playPauseBtn.click(); }
});

/* ---------------- init ---------------- */

buildCards();
applyPreset(0);
updateStemLabel(); refreshCards(); drawRadar(); renderSongs(); refreshTransportButtons(); showOutput();
// Reconnect to the stem splitter only where it has been used before: on a
// first visit the browser would otherwise ask about "local network access"
// before the user knows there is a helper at all.
refreshHelperUi(); refreshLed();
if (SSHelper.seen && !isPhone) checkHelper().then(() => { scheduleHelperPoll(); refreshLed(); });

/* ---------------- app shell: window rail ---------------- */
// One icon per window down the right edge: tap to show or hide it (a phone
// shows one at a time). Identical in the web app and the rig page - PARITY.md.
(function () {
  const ICON = {
    stemCol: '<path d="M6 4v16M12 4v16M18 4v16"/><circle cx="6" cy="9" r="2"/><circle cx="12" cy="15" r="2"/><circle cx="18" cy="8" r="2"/>',
    centerCol: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
    songCol: '<path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="16" r="2"/>',
    sepCol: '<path d="M12 3v6l-6 4v8M12 9l6 4v8"/>',
    spatial: '<circle cx="12" cy="12" r="2.5"/><path d="M6.5 12a5.5 5.5 0 0 1 11 0M3 12a9 9 0 0 1 18 0"/>',
  };
  const LABEL = { stemCol: 'Stems', centerCol: 'Control', songCol: 'Songs', sepCol: 'Split', spatial: 'Spatial' };
  const ids = ['stemCol', 'centerCol', 'songCol', 'sepCol'].filter((id) => document.getElementById(id));
  const KEY = 'spatialstage.panels';
  const narrow = window.matchMedia('(max-width: 899px)');
  let shown = new Set(['stemCol', 'centerCol', 'songCol']);
  try { const v = JSON.parse(localStorage.getItem(KEY)); if (Array.isArray(v) && v.length) shown = new Set(v); } catch (e) {}
  let pick = 'centerCol';          // the one window a phone shows
  let lastStem = null;
  const rail = document.createElement('nav');
  rail.id = 'rail'; rail.setAttribute('aria-label', 'Windows');
  const btns = {};
  for (const id of [...ids, 'spatial']) {
    const b = document.createElement('button');
    b.className = 'rail-btn'; b.type = 'button';
    b.title = id === 'spatial' ? 'Spatial / LED settings for a stem' : 'Show or hide the ' + LABEL[id] + ' window';
    b.innerHTML = '<svg viewBox="0 0 24 24">' + ICON[id] + '</svg><span>' + LABEL[id] + '</span>';
    b.addEventListener('click', () => id === 'spatial' ? toggleSide() : toggle(id));
    rail.appendChild(b); btns[id] = b;
  }
  document.body.appendChild(rail);
  for (const id of ids) {
    const el = document.getElementById(id);
    const h = document.createElement('button');
    h.className = 'pn-hide'; h.type = 'button'; h.innerHTML = '&minus;'; h.title = 'Collapse this window (bring it back from the rail)';
    h.addEventListener('click', () => toggle(id));
    el.appendChild(h);
  }
  function visible(id) { return narrow.matches ? id === pick : shown.has(id); }
  function toggle(id) {
    if (narrow.matches) pick = id;
    else if (shown.has(id)) shown.delete(id); else shown.add(id);
    try { localStorage.setItem(KEY, JSON.stringify([...shown])); } catch (e) {}
    apply();
  }
  function sideOpen() { return activeSpatialStem !== null || activeLedStem !== null || activeExtStem !== null; }
  function toggleSide() {
    if (sideOpen()) { if (activeSpatialStem) openSpatialPanel(activeSpatialStem); if (activeLedStem) openLedPanel(activeLedStem); if (activeExtStem) openExtPanel(activeExtStem); }
    else openSpatialPanel(lastStem || ALL_STEMS[0]);
  }
  function apply() {
    for (const id of ids) {
      document.getElementById(id).hidden = !visible(id);
      btns[id].classList.toggle('on', visible(id));
    }
    railSync();
  }
  window.railSync = function () {
    if (activeSpatialStem) lastStem = activeSpatialStem;
    btns.spatial.classList.toggle('on', sideOpen());
  };
  narrow.addEventListener('change', apply);
  apply();
})();
