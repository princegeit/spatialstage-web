// UI: bridge/public/index.html's control surface, with every send({...})
// to the bridge replaced by a direct call into engine.js / motion.js. The
// page IS the player now - no WebSocket, no OSC, no Pd. Layout, dials,
// radar and the spatial panel are unchanged so it feels the same on a phone.
const ALL_STEMS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
const STEM_COLOR = {
  vocals: '#00ff88', drums: '#ffcc33', bass: '#44aaff',
  guitar: '#ff66aa', piano: '#ad6bff', other: '#00dddd',
};
// Base azimuth and stereo width per stem, from the stem_spatializer_stereo
// creation args in pd/binaural_pan_live_v1.pd (what /stems used to serve).
const GEOMETRY = {
  vocals: { azimuth: -15, width: 37 }, drums: { azimuth: -45, width: 1 },
  bass: { azimuth: 75, width: 0 }, guitar: { azimuth: -75, width: 2 },
  piano: { azimuth: 45, width: 8 }, other: { azimuth: 15, width: 50 },
};
const ICONS = {
  vocals: '<rect x="9" y="3" width="6" height="10" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v4"/><path d="M9 21h6"/>',
  drums:  '<ellipse cx="12" cy="10" rx="8" ry="3"/><path d="M4 10v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5"/><path d="M6 3.5l3.5 4M18 3.5l-3.5 4"/>',
  bass:   '<path d="M4 9.5v5h3l4.5 3.5v-12L7 9.5H4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
  guitar: '<circle cx="8.5" cy="15.5" r="5"/><circle cx="8.5" cy="15.5" r="1.5"/><path d="M12 12l6.5-6.5"/><path d="M17 4l3 3"/>',
  piano:  '<rect x="3" y="6.5" width="18" height="11" rx="1"/><path d="M7.5 6.5v6.5M12 6.5v6.5M16.5 6.5v6.5"/>',
  other:  '<path d="M6 20v-8M12 20V4M18 20v-5"/><circle cx="6" cy="9" r="2"/><circle cx="12" cy="17" r="2"/><circle cx="18" cy="12" r="2"/>',
};

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

// Absolute azimuth per stem as the dial shows it: base + phone rotate. The
// radar additionally shows where the stem really is once fft/preset motion
// and smoothing are folded in (motion.stems[s].effective).
let base = {}, widthDeg = {}, azim = {}, volume = {};
for (const s of ALL_STEMS) { base[s] = GEOMETRY[s].azimuth; widthDeg[s] = GEOMETRY[s].width; azim[s] = base[s]; volume[s] = 1; }
let mutedStems = new Set();
let selectedStems = new Set(ALL_STEMS);
let songs = [], songIndex = -1;
let loadedSong = null;   // the songs[] entry whose audio is in the engine
let loading = null;      // { song, pct, autoplay } while one is decoding
let seeking = false, seekDirty = false;
const spatial = {};
for (const s of ALL_STEMS) spatial[s] = motion.stems[s].params;
let activeSpatialStem = null;
let lastSliderValue = 0;
let zeroAlpha = 0, lastRawAlpha = 0;
let dragging = null;
const cards = {};

const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180;
const sendStem = (s) => motion.setPhone(s, Math.round(wrap180(azim[s] - base[s])));
const buzz = (p) => { if (navigator.vibrate) navigator.vibrate(p); };

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
    card.className = 'stem-card';
    card.style.color = c;
    card.innerHTML =
      '<div class="card-head">' +
        '<svg viewBox="0 0 24 24" stroke="' + c + '">' + ICONS[stem] + '</svg>' +
        '<span class="stem-name">' + stem.toUpperCase() + '</span>' +
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
        '<button class="tog-btn center-btn">CENTER</button>' +
        '<button class="tog-btn spatial-btn">SPATIAL</button>' +
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
      spatial: card.querySelector('.spatial-btn'),
      level: card.querySelector('.level-fill'),
    };
    cards[stem].mute.addEventListener('click', () => setMuted(stem, !mutedStems.has(stem)));
    cards[stem].arm.addEventListener('click', () => setArmed(stem, !selectedStems.has(stem)));
    card.querySelector('.center-btn').addEventListener('click', () => centerStem(stem));
    cards[stem].spatial.addEventListener('click', () => openSpatialPanel(stem));
    bindKnob(card.querySelector('.knob'), stem);
    bindFader(card.querySelector('.fader'), stem);
  }
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
  for (const stem of ALL_STEMS) {
    const k = cards[stem];
    if (!k) continue;
    const armed = selectedStems.has(stem);
    k.sel.setAttribute('opacity', armed ? 1 : 0.12);
    k.arm.classList.toggle('armed', armed);
    k.arm.setAttribute('aria-pressed', armed);
    const v = volume[stem] === undefined ? 1 : volume[stem];
    k.fill.style.height = (v * 100) + '%';
    k.cap.style.bottom = 'calc(' + (v * 100) + '% - 1.5px)';
    k.fader.setAttribute('aria-valuenow', Math.round(v * 100));
    const m = mutedStems.has(stem);
    k.mute.classList.toggle('muted', m);
    k.mute.setAttribute('aria-pressed', m);
    k.card.classList.toggle('muted', m);
    k.spatial.classList.toggle('open', stem === activeSpatialStem);
  }
}

// One place for "put this stem at this angle", shared by dial, radar,
// keyboard and hand tracking.
function placeStem(stem, deg) {
  azim[stem] = wrap180(deg);
  sendStem(stem);
  refreshCards(); requestRadar();
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
    placeStem(stem, (azim[stem] || 0) + d);
  });
}

function setArmed(stem, on, quiet) {
  if (on) selectedStems.add(stem); else selectedStems.delete(stem);
  motion.setArmed(stem, on);
  updateStemLabel(); refreshCards(); requestRadar();
  if (!quiet) buzz(15);
}

function centerStem(stem) {
  placeStem(stem, 0);
  buzz(15);
}

function setVolume(stem, v) {
  volume[stem] = Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
  engine.setVolume(stem, volume[stem]);
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
  refreshCards(); requestRadar();
  if (!quiet) buzz(15);
}

/* ---------------- spatial (motion) advanced panel ---------------- */

const spatialPanel = $('spatialPanel'), spatialStemName = $('spatialStemName');
const blendModeRow = $('blendModeRow'), blendTwoRow = $('blendTwoRow'), blendThreeRow = $('blendThreeRow');
const fftModeRow = $('fftModeRow'), fftSrcRow = $('fftSrcRow'), presetModeRow = $('presetModeRow'), tempoSourceRow = $('tempoSourceRow');
const ts1El = $('ts1'), ts2El = $('ts2'), w1El = $('w1'), w2El = $('w2'), w3El = $('w3');
const presetRateEl = $('presetRate'), smoothingSliderEl = $('smoothingSlider');
const spatialBpmEl = $('spatialBpm'), spatialBaseEl = $('spatialBase');

function sendSpatial(stem, param, value) { motion.setParam(stem, param, value); }

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
const segParam = (row, param) => bindSegRow(row, (v) => {
  if (!activeSpatialStem) return;
  sendSpatial(activeSpatialStem, param, v);
  refreshSpatialPanel();
});
segParam(blendModeRow, 'blendMode');
segParam(fftModeRow, 'fftMode');
segParam(fftSrcRow, 'fftSrc');
segParam(presetModeRow, 'presetMode');
segParam(tempoSourceRow, 'tempoSource');

function wireWeightSlider(el, out, apply) {
  el.addEventListener('input', () => {
    if (!activeSpatialStem) return;
    apply(activeSpatialStem, Number(el.value));
    out.textContent = Number(el.value).toFixed(2);
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
wireWeightSlider(spatialBaseEl, $('spatialBaseOut'), (stem, v) => sendSpatial(stem, 'base', v));
wireWeightSlider(smoothingSliderEl, $('smoothingOut'), (stem, v) => sendSpatial(stem, 'smoothing', v));
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
    spatialStemName.textContent = stem.toUpperCase();
    spatialStemName.style.color = STEM_COLOR[stem];
    refreshSpatialPanel();
    // The panel opens under all six cards; on a phone that is a screen or
    // more below the button that opened it.
    const top = spatialPanel.getBoundingClientRect().top;
    if (top > window.innerHeight - 120) spatialPanel.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  refreshCards();
}
$('spatialCloseBtn').addEventListener('click', () => {
  const stem = activeSpatialStem;
  if (!stem) return;
  openSpatialPanel(stem);
  // Back to the card it came from, so closing does not strand you at the bottom.
  const r = cards[stem].card.getBoundingClientRect();
  if (r.top < 0 || r.bottom > window.innerHeight) cards[stem].card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

function refreshSpatialPanel() {
  if (!activeSpatialStem) return;
  const st = spatial[activeSpatialStem];
  setSegActive(blendModeRow, st.blendMode);
  setSegActive(fftModeRow, st.fftMode);
  setSegActive(fftSrcRow, st.fftSrc);
  setSegActive(presetModeRow, st.presetMode);
  setSegActive(tempoSourceRow, st.tempoSource);
  blendTwoRow.hidden = st.blendMode !== 0;
  blendThreeRow.hidden = st.blendMode !== 1;
  ts1El.value = st.blendWeights2[0]; $('ts1Out').textContent = st.blendWeights2[0].toFixed(2);
  ts2El.value = st.blendWeights2[1]; $('ts2Out').textContent = st.blendWeights2[1].toFixed(2);
  w1El.value = st.blendWeights3[0]; $('w1Out').textContent = st.blendWeights3[0].toFixed(2);
  w2El.value = st.blendWeights3[1]; $('w2Out').textContent = st.blendWeights3[1].toFixed(2);
  w3El.value = st.blendWeights3[2]; $('w3Out').textContent = st.blendWeights3[2].toFixed(2);
  presetRateEl.value = st.presetRate; $('presetRateOut').textContent = st.presetRate.toFixed(2);
  spatialBpmEl.value = st.tempoBpm;
  spatialBaseEl.value = st.base; $('spatialBaseOut').textContent = Math.round(st.base) + '°';
  smoothingSliderEl.value = st.smoothing; $('smoothingOut').textContent = st.smoothing.toFixed(2);
  refreshTempoHint();
}

// Under the tempo row: what the Tempo-Sync motion is actually following.
// Previously MIDI status went to the song column's hint line, and choosing
// Link silently fell back to manual BPM.
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

/* ---------------- presets: localStorage keyed by song name ---------------- */

const PRESET_KEY = 'spatialstage.presets.v1';
function readPresets() { try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '{}'); } catch (e) { return {}; } }
function writePresets(p) { try { localStorage.setItem(PRESET_KEY, JSON.stringify(p)); return true; } catch (e) { alert('Could not save preset: ' + e.message); return false; } }
function presetName() { return songIndex >= 0 && songs[songIndex] ? songs[songIndex].name : '_default'; }
const presetLabel = () => presetName() === '_default' ? 'no song (default)' : '"' + presetName() + '"';

$('presetSaveBtn').addEventListener('click', () => {
  const all = readPresets();
  // azim (where each dial was put) is new in this format; older presets
  // without it still load, they just leave the dials where they are.
  all[presetName()] = { spatial: motion.snapshot(), volume: { ...volume }, muted: [...mutedStems], armed: [...selectedStems], azim: { ...azim } };
  if (writePresets(all)) toast('Saved preset for ' + presetLabel());
  buzz(25);
});
$('presetLoadBtn').addEventListener('click', () => {
  const p = readPresets()[presetName()];
  if (!p) { toast('No preset saved for ' + presetLabel() + ' yet'); return; }
  applyPreset(p);
  toast('Loaded preset for ' + presetLabel());
  buzz([20, 20, 20]);
});
$('presetExportBtn').addEventListener('click', () => {
  const all = readPresets();
  if (!Object.keys(all).length) { toast('No presets saved yet - Save one first'); return; }
  download(new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' }), 'spatialstage-presets.json');
});
// Export's other half: merges a file from Export (this or another browser)
// into this browser's presets; same-named songs take the imported version.
const presetFileInput = $('presetFileInput');
$('presetImportBtn').addEventListener('click', () => presetFileInput.click());
presetFileInput.addEventListener('change', async () => {
  const f = presetFileInput.files[0];
  presetFileInput.value = '';
  if (!f) return;
  let incoming;
  try { incoming = JSON.parse(await f.text()); } catch (e) { alert('That file is not valid JSON: ' + e.message); return; }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) { alert('That is not a SpatialStage preset export.'); return; }
  const names = Object.keys(incoming).filter(k => incoming[k] && typeof incoming[k] === 'object' && (incoming[k].spatial || incoming[k].volume));
  if (!names.length) { alert('No presets found in that file.'); return; }
  const all = readPresets();
  for (const k of names) all[k] = incoming[k];
  if (writePresets(all)) toast('Imported ' + names.length + (names.length === 1 ? ' preset' : ' presets'));
});
function applyPreset(p) {
  if (p.spatial) motion.restore(p.spatial);
  if (p.azim) for (const s of ALL_STEMS) if (typeof p.azim[s] === 'number' && isFinite(p.azim[s])) { azim[s] = wrap180(p.azim[s]); sendStem(s); }
  if (p.volume) for (const s of ALL_STEMS) if (typeof p.volume[s] === 'number') { volume[s] = p.volume[s]; engine.setVolume(s, volume[s]); }
  if (Array.isArray(p.muted)) for (const s of ALL_STEMS) { const m = p.muted.includes(s); if (m) mutedStems.add(s); else mutedStems.delete(s); engine.setMuted(s, m); }
  if (Array.isArray(p.armed)) for (const s of ALL_STEMS) { const a = p.armed.includes(s); if (a) selectedStems.add(s); else selectedStems.delete(s); motion.setArmed(s, a); }
  updateStemLabel(); refreshCards(); refreshSpatialPanel(); requestRadar();
}

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

// Stem labels, laid out so that stems sharing a spot (all six park at 0 deg
// after Arm None) do not print on top of each other. Each label gets its
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
// merge them and lay the merged group out again. Six stems means at most
// five merges.
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

// Drag a dot to place that stem - the radar is the one view that shows
// where everything is, and it was display-only. With a mouse, dragging
// empty space inside the ring turns the whole armed group, like the
// rotate slider. On touch only a dot starts a drag, so the radar (which
// fills a phone's first screen) can still be used to scroll the page.
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
    if (mutedStems.has(s)) continue;
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
// MIDI clock tempo twice a second while the panel shows it.
let tickN = 0;
motion.onTick = () => {
  if ((++tickN & 1) === 0) requestRadar();
  if (tickN % 20 === 0 && activeSpatialStem && spatial[activeSpatialStem].tempoSource === 1) refreshTempoHint();
};

/* ---------------- songs ---------------- */

function renderSongs() {
  songList.textContent = '';
  if (songs.length === 0) {
    songList.innerHTML = '<div class="empty-songs">No songs yet. Drop a 12-channel show WAV, or a folder of stems, on the box above.</div>';
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
    const mark = document.createElement('span');
    mark.className = 'song-mark';
    if (isLoading) mark.innerHTML = '<span class="spin"></span>';
    else mark.textContent = i === songIndex ? (engine.playing ? '▶' : '❚❚') : '';
    const label = document.createElement('span');
    label.className = 'song-name';
    label.textContent = song.name;
    label.title = song.name + ' - double-click to rename';
    label.addEventListener('dblclick', (e) => { e.stopPropagation(); renameSong(i); });
    const slots = document.createElement('span');
    slots.className = 'stem-slots';
    ALL_STEMS.forEach((s, k) => {
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
    row.appendChild(mark); row.appendChild(label); row.appendChild(slots); row.appendChild(dur); row.appendChild(remove);
    row.addEventListener('click', () => { loadSongIndex(i, true); buzz(25); });
    row.addEventListener('keydown', (e) => {
      if (e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); loadSongIndex(i, true); }
    });
    songList.appendChild(row);
  });
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
async function loadSongIndex(i, autoplay) {
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
  loading = { song, pct: 0, autoplay: !!autoplay };
  // Let go of the previous song before decoding this one: two long
  // 12-channel songs in memory at once is what gets a phone tab killed,
  // and until now the old song also stayed playable under the new title.
  loadedSong = null;
  engine.unload();
  songHint.innerHTML = '&nbsp;';
  renderSongs(); refreshTransportButtons();
  try {
    const decoded = await SSSongs.decodeSong(song, engine, (x) => { if (seq === loadSeq) showLoadProgress(x); });
    if (seq !== loadSeq) return; // a newer selection superseded this one
    const loaded = await engine.loadSong(decoded);
    if (seq !== loadSeq) { if (engine.song === loaded) engine.unload(); return; }
    song.duration = loaded.duration;
    loadedSong = song;
    const play = loading.autoplay;
    loading = null;
    renderSongs(); refreshTransportButtons();
    if (play) engine.play();
  } catch (e) {
    if (seq !== loadSeq) return;
    loading = null;
    renderSongs(); refreshTransportButtons();
    songHint.textContent = 'Could not load ' + song.name + ': ' + e.message;
  }
}

function removeSong(i) {
  const song = songs[i];
  songs.splice(i, 1);
  if (song === loadedSong || (loading && loading.song === song)) {
    loadSeq++; // abandons a decode in flight
    loading = null; loadedSong = null;
    engine.unload();
    songIndex = -1;
  } else if (i < songIndex) songIndex--;
  else if (i === songIndex) songIndex = -1;
  renderSongs(); refreshTransportButtons();
}

// Presets are keyed by song name, so a rename carries the preset along.
function renameSong(i) {
  const song = songs[i];
  const name = (prompt('Song name (presets are saved under it):', song.name) || '').trim();
  if (!name || name === song.name) return;
  const all = readPresets();
  if (all[song.name] && !all[name]) { all[name] = all[song.name]; writePresets(all); }
  song.name = name;
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
    songs.push(...found);
    renderSongs(); refreshTransportButtons();
    if (found.length) toast('Added ' + (found.length === 1 ? found[0].name : found.length + ' songs'));
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
// One document-level handler: the old box-level one also fired alongside
// it whenever the drop landed on the box's text, adding every file twice.
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
  const row = songIndex >= 0 && !(loading && loading.song === songs[songIndex]) ? songList.children[songIndex] : null;
  const mark = row && row.querySelector('.song-mark');
  if (mark) mark.textContent = engine.playing ? '▶' : '❚❚';
  refreshStatus();
}
engine.onStateChange = refreshTransportButtons;
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

let recTimer = null;
recordBtn.addEventListener('click', async () => {
  await engine.ensure();
  if (engine.isRecording) {
    clearInterval(recTimer); recTimer = null;
    const secs = engine.recordingSeconds;
    const blob = engine.stopRecording();
    const name = 'spatialstage-take-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.wav';
    recordStatus.hidden = false;
    recordStatus.classList.remove('live');
    recordStatus.innerHTML = 'Take ready (' + formatTime(secs) + ', ' + (blob.size / 1048576).toFixed(1) + ' MB): <a href="#" id="takeLink"></a>';
    const link = $('takeLink');
    link.textContent = 'download ' + name;
    link.addEventListener('click', (e) => { e.preventDefault(); download(blob, name); });
    buzz(15);
  } else {
    engine.startRecording();
    recordStatus.hidden = false;
    recordStatus.classList.add('live');
    // A running clock, so a take left recording is noticed.
    const tick = () => { recordStatus.textContent = '● REC ' + formatTime(engine.recordingSeconds) + (engine.playing ? '' : ' (paused - recording silence)') + ' · tap ● to stop'; };
    tick();
    recTimer = setInterval(tick, 500);
    buzz([15, 60, 15]);
  }
  refreshTransportButtons();
});

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);
}

// `seeking` holds the bar still under the finger. It used to be cleared
// only by 'change', which never fires for a press that does not move the
// thumb - and then the position display froze for good. Now any release
// ends it, and a seek happens only if the value was actually dragged.
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

/* ---------------- rotation ---------------- */

function updateStemLabel() {
  if (selectedStems.size === 0) stemLabel.textContent = 'NONE ARMED';
  else if (selectedStems.size === ALL_STEMS.length) stemLabel.textContent = 'ALL ARMED';
  else stemLabel.textContent = [...selectedStems].map(s => s.toUpperCase()).join(', ');
}

function applyRotation(value) {
  const d = value - lastSliderValue;
  lastSliderValue = value;
  if (!d) return;
  for (const stem of selectedStems) {
    azim[stem] = wrap180((azim[stem] || 0) + d);
    sendStem(stem);
  }
  val.textContent = Math.round(value) + '°';
  refreshCards(); requestRadar();
}

// One buzz per button press, not one per stem.
$('selectAllBtn').addEventListener('click', () => { ALL_STEMS.forEach(s => setArmed(s, true, true)); buzz(15); });
$('selectNoneBtn').addEventListener('click', () => { ALL_STEMS.forEach(s => setArmed(s, false, true)); buzz(15); });
$('muteNoneBtn').addEventListener('click', () => { ALL_STEMS.forEach(s => setMuted(s, false, true)); buzz(15); });
$('muteAllBtn').addEventListener('click', () => { ALL_STEMS.forEach(s => setMuted(s, true, true)); buzz(15); });
slider.addEventListener('input', () => applyRotation(Number(slider.value)));

/* ---------------- phone motion ---------------- */

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
  wantWakeLock = motionOn || hand.running;
  if (!wantWakeLock && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

// The button toggles. Turning it on waits for a first real reading: a
// desktop browser happily accepts the listener and then never fires it,
// which left the button saying "Motion Active" over a dead sensor.
let motionOn = false, motionSeen = false, motionProbe = null;
sensorBtn.addEventListener('click', async () => {
  if (motionOn) { unbindOrientation(); toast('Motion off - the stems stay where they are'); return; }
  if (!window.isSecureContext) {
    alert('Motion sensors need an https:// page (or localhost). Open this page over https to use phone rotation; the dials and slider still work.');
    return;
  }
  if (typeof DeviceOrientationEvent === 'undefined') { toast('This browser has no motion sensor support - use the rotate slider or the dials.', 3600); return; }
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res === 'granted') bindOrientation(); else alert('Motion permission denied');
    } catch (e) { alert('Error requesting motion permission: ' + e.message); }
  } else {
    bindOrientation();
  }
});

function bindOrientation() {
  motionOn = true; motionSeen = false;
  window.addEventListener('deviceorientation', handleOrientation);
  sensorBtn.classList.add('active');
  sensorBtn.textContent = 'Motion: waiting for sensor...';
  clearTimeout(motionProbe);
  motionProbe = setTimeout(() => {
    if (motionOn && !motionSeen) {
      unbindOrientation();
      toast('No motion sensor found on this device - use the rotate slider, the dials or hand tracking instead.', 4200);
    }
  }, 2500);
}

function unbindOrientation() {
  motionOn = false;
  clearTimeout(motionProbe);
  window.removeEventListener('deviceorientation', handleOrientation);
  sensorBtn.classList.remove('active');
  sensorBtn.textContent = 'Enable Motion';
  releaseWakeLockIfUnused();
}

calibrateBtn.addEventListener('click', () => {
  zeroAlpha = lastRawAlpha;
  lastSliderValue = 0;
  slider.value = 0;
  val.textContent = '0°';
  buzz(50);
});

function handleOrientation(e) {
  if (e.alpha === null) return;
  if (!motionSeen) {
    // Anchor to wherever the phone points now (keeping the slider's
    // current rotation), instead of the absolute alpha, which spun every
    // armed stem by the phone's arbitrary heading the moment motion began.
    motionSeen = true;
    zeroAlpha = e.alpha - lastSliderValue;
    sensorBtn.textContent = 'Motion Active (tap to turn off)';
    wantWakeLock = true; requestWakeLock();
    buzz([40, 40, 40]);
  }
  lastRawAlpha = e.alpha;
  let delta = (e.alpha - zeroAlpha + 360) % 360;
  if (delta > 180) delta -= 360;
  slider.value = delta;
  applyRotation(delta);
}

/* ---------------- hand tracking (camera) ---------------- */

// A hand is a cursor on the radar: the camera frame is the room seen from
// above, with you at the centre - left/right in the frame is left/right
// around your head, up in the frame is in front, down is behind. Reach
// scales how far a hand has to travel. Two gesture modes:
//   0 pinch-to-grab: a pinch that starts near a stem's dot picks that stem
//     up; it follows the hand until release. A pinch in empty space rotates
//     the whole armed group by the hand's movement, like the slider. Each
//     hand grabs independently.
//   1 open-hand steers: the first hand's movement rotates the armed group
//     while it is open; a fist freezes it (and re-anchors on reopen).
// Positions go in through the same path as a dial drag (azim + sendStem),
// so fft/preset blending and smoothing still apply downstream.
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
    if (mutedStems.has(s)) continue;
    if (handState.some(st => st.grab === s)) continue; // the other hand has it
    const d = Math.abs(wrap180(motion.stems[s].effective - az));
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

function rotateArmedBy(d) {
  if (!d) return;
  for (const stem of selectedStems) { azim[stem] = wrap180((azim[stem] || 0) + d); sendStem(stem); }
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
        if (st.grab === 'group') rotateArmedBy(wrap180(az - st.lastAz));
        else { azim[st.grab] = az; sendStem(st.grab); }
        st.lastAz = az;
      } else if (!h.pinch && st.grab) {
        st.grab = null;
      }
    }
  } else {
    // The first hand steers, whichever tracker slot it is in - hands keep
    // their slot now, so a lone hand can be slot 1, and reading slot 0's
    // state for it reset the anchor every frame and never turned anything.
    const h = hands[0];
    if (h) {
      const st = handState[h.index];
      const { az } = handToRadar(h);
      if (h.fist) { st.grab = null; }
      else if (!st.grab) { st.grab = 'group'; st.lastAz = az; }
      else { rotateArmedBy(wrap180(az - st.lastAz)); st.lastAz = az; }
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

handBtn.addEventListener('click', async () => {
  if (hand.running) {
    hand.stop();
    handBtn.classList.remove('active'); handBtn.textContent = 'Hand Tracking (camera)';
    handLayer.textContent = '';
    for (const st of handState) st.grab = null;
    handPanel.hidden = true; // a black camera box with nothing in it is just clutter
    releaseWakeLockIfUnused();
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('This browser cannot open the camera here. Hand tracking needs https:// (or localhost) and a camera.');
    return;
  }
  handPanel.hidden = false;
  handBtn.disabled = true; handBtn.textContent = 'Starting camera...';
  try {
    await hand.start(handVideo, handCanvas);
    camBox.classList.toggle('mirror', hand.mirror);
    $('handMirrorBtn').textContent = 'Mirror: ' + (hand.mirror ? 'on' : 'off');
    handBtn.classList.add('active'); handBtn.textContent = 'Hand Tracking: on (tap to stop)';
    wantWakeLock = true; requestWakeLock();
    buzz([30, 30, 30]);
  } catch (e) {
    handStatus.textContent = 'could not start: ' + e.message;
    handBtn.textContent = 'Hand Tracking (camera)';
  }
  handBtn.disabled = false;
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
  // Most laptops have one camera; the error used to vanish as an unhandled
  // rejection while the button still claimed tracking was on.
  try { await hand.switchCamera(); }
  catch (e) { toast('Could not switch camera: ' + (e.message || e.name) + (hand.running ? ' - staying on this one' : ''), 4000); }
  flip.disabled = false;
  camBox.classList.toggle('mirror', hand.mirror);
  $('handMirrorBtn').textContent = 'Mirror: ' + (hand.mirror ? 'on' : 'off');
  if (!hand.running) {
    handBtn.classList.remove('active'); handBtn.textContent = 'Hand Tracking (camera)';
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
updateStemLabel(); refreshCards(); drawRadar(); renderSongs(); refreshTransportButtons();
