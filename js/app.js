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
const dropZone = $('dropZone'), fileInput = $('fileInput');

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
let seeking = false;
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

/* ---------------- start gate ---------------- */

startBtn.addEventListener('click', async () => {
  try {
    await engine.ensure();
  } catch (e) { alert('Could not start audio: ' + e.message); return; }
  motion.start();
  startOverlay.hidden = true;
  status.textContent = 'audio ready';
  status.classList.add('connected');
  buzz(20);
});

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
        '<div class="knob" data-stem="' + stem + '">' +
          '<svg viewBox="0 0 64 64">' +
            '<circle class="knob-track" cx="32" cy="32" r="29"></circle>' +
            '<circle class="knob-sel" cx="32" cy="32" r="29" stroke="' + c + '"></circle>' +
            '<line class="knob-ptr" x1="32" y1="32" x2="32" y2="7" stroke="' + c + '"></line>' +
            '<circle class="knob-hub" cx="32" cy="32" r="4" stroke="' + c + '"></circle>' +
          '</svg>' +
        '</div>' +
        '<div class="fader" data-stem="' + stem + '">' +
          '<div class="fader-fill"></div><div class="fader-cap"></div>' +
        '</div>' +
      '</div>' +
      '<div class="card-meta">' +
        '<span class="stem-az">0&deg;</span>' +
        '<button class="tog-btn arm-btn">ARM</button>' +
        '<button class="tog-btn mute-btn">MUTE</button>' +
      '</div>' +
      '<div class="card-row2">' +
        '<button class="tog-btn center-btn">CENTER</button>' +
        '<button class="tog-btn spatial-btn">SPATIAL</button>' +
      '</div>';
    stemGrid.appendChild(card);
    cards[stem] = {
      card,
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
    k.az.textContent = Math.round(a) + '°';
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
    const v = volume[stem] === undefined ? 1 : volume[stem];
    k.fill.style.height = (v * 100) + '%';
    k.cap.style.bottom = 'calc(' + (v * 100) + '% - 1.5px)';
    const m = mutedStems.has(stem);
    k.mute.classList.toggle('muted', m);
    k.card.classList.toggle('muted', m);
    k.spatial.classList.toggle('open', stem === activeSpatialStem);
  }
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
    id = ev.pointerId; startX = ev.clientX; startY = ev.clientY; active = false;
    el.setPointerCapture(id);
  });
  el.addEventListener('pointermove', (ev) => {
    if (id === null) return;
    if (!active) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      active = true; dragging = stem;
    }
    azim[stem] = wrap180(angleAt(ev));
    sendStem(stem);
    refreshCards(); requestRadar();
  });
  const end = () => { if (id !== null) { try { el.releasePointerCapture(id); } catch (e) {} } id = null; active = false; dragging = null; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function setArmed(stem, on) {
  if (on) selectedStems.add(stem); else selectedStems.delete(stem);
  motion.setArmed(stem, on);
  updateStemLabel(); refreshCards(); requestRadar();
  buzz(15);
}

function centerStem(stem) {
  azim[stem] = 0;
  sendStem(stem);
  refreshCards(); requestRadar();
  buzz(15);
}

function bindFader(el, stem) {
  let id = null;
  const levelAt = (ev) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height));
  };
  const apply = (ev) => {
    volume[stem] = Math.round(levelAt(ev) * 100) / 100;
    engine.setVolume(stem, volume[stem]);
    refreshCards();
  };
  el.addEventListener('pointerdown', (ev) => { id = ev.pointerId; dragging = stem; el.setPointerCapture(id); apply(ev); });
  el.addEventListener('pointermove', (ev) => { if (id !== null) apply(ev); });
  el.addEventListener('pointerup', () => { if (id !== null) { try { el.releasePointerCapture(id); } catch (e) {} id = null; dragging = null; } });
  el.addEventListener('pointercancel', () => { id = null; dragging = null; });
}

function setMuted(stem, m) {
  if (m) mutedStems.add(stem); else mutedStems.delete(stem);
  engine.setMuted(stem, m);
  refreshCards(); requestRadar();
  buzz(15);
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
  sendSpatial(activeSpatialStem, 'tempoBpm', v);
});

function openSpatialPanel(stem) {
  activeSpatialStem = (activeSpatialStem === stem) ? null : stem;
  spatialPanel.hidden = activeSpatialStem === null;
  if (activeSpatialStem) {
    spatialStemName.textContent = stem.toUpperCase();
    refreshSpatialPanel();
  }
  refreshCards();
}

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
  if (st.tempoSource === 1 && !motion.midiClock.available) {
    songHint.textContent = navigator.requestMIDIAccess ? 'waiting for MIDI clock...' : 'MIDI clock needs Chrome/Edge (Web MIDI) - using manual BPM';
  }
}

/* ---------------- presets: localStorage keyed by song name ---------------- */

const PRESET_KEY = 'spatialstage.presets.v1';
function readPresets() { try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '{}'); } catch (e) { return {}; } }
function writePresets(p) { try { localStorage.setItem(PRESET_KEY, JSON.stringify(p)); } catch (e) { alert('Could not save preset: ' + e.message); } }
function presetName() { return songIndex >= 0 && songs[songIndex] ? songs[songIndex].name : '_default'; }

$('presetSaveBtn').addEventListener('click', () => {
  const all = readPresets();
  all[presetName()] = { spatial: motion.snapshot(), volume: { ...volume }, muted: [...mutedStems], armed: [...selectedStems] };
  writePresets(all);
  songHint.textContent = 'saved preset for ' + presetName();
  buzz(25);
});
$('presetLoadBtn').addEventListener('click', () => {
  const p = readPresets()[presetName()];
  if (!p) { songHint.textContent = 'no preset saved for ' + presetName(); return; }
  applyPreset(p);
  songHint.textContent = 'loaded preset for ' + presetName();
  buzz([20, 20, 20]);
});
$('presetExportBtn').addEventListener('click', () => {
  download(new Blob([JSON.stringify(readPresets(), null, 2)], { type: 'application/json' }), 'spatialstage-presets.json');
});
function applyPreset(p) {
  if (p.spatial) motion.restore(p.spatial);
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

function drawRadar() {
  stemLayer.textContent = '';
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
    const [lx, ly] = polar(a, RING + 22);
    const near = Math.abs(wrap180(a)) < 8 || Math.abs(Math.abs(wrap180(a)) - 180) < 8;
    const t = svgEl('text', {
      class: 'stem-label', x: lx, y: ly + 4, fill: colour, opacity: alpha,
      'text-anchor': near ? 'middle' : (Math.sin(a * Math.PI / 180) >= 0 ? 'start' : 'end'),
    });
    t.textContent = stem.toUpperCase() + ' ' + Math.round(a) + '°';
    stemLayer.appendChild(t);
  }
}

// Redraw the radar, dial pointers and level meters at 20 Hz.
let tickN = 0;
motion.onTick = () => { if ((++tickN & 1) === 0) requestRadar(); };

/* ---------------- songs ---------------- */

function renderSongs() {
  songList.textContent = '';
  if (songs.length === 0) {
    songList.innerHTML = '<div class="hint">no songs loaded yet</div>';
    return;
  }
  songs.forEach((song, i) => {
    const row = document.createElement('div');
    row.className = 'song-item' + (i === songIndex ? ' playing' : '');
    const mark = document.createElement('span');
    mark.className = 'song-mark';
    mark.textContent = i === songIndex ? '▶' : '';
    const label = document.createElement('span');
    label.className = 'song-name';
    label.textContent = song.name;
    label.title = song.name;
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
    dur.textContent = song.duration == null ? '—' : formatTime(song.duration);
    row.appendChild(mark); row.appendChild(label); row.appendChild(slots); row.appendChild(dur);
    row.addEventListener('click', () => { loadSongIndex(i, true); buzz(25); });
    songList.appendChild(row);
  });
}

let loadSeq = 0;
async function loadSongIndex(i, autoplay) {
  if (i < 0 || i >= songs.length) return;
  const seq = ++loadSeq;
  songIndex = i;
  renderSongs();
  engine.stop();
  songHint.textContent = 'decoding ' + songs[i].name + '...';
  try {
    const decoded = await SSSongs.decodeSong(songs[i], engine, (m) => { songHint.textContent = m; });
    if (seq !== loadSeq) return; // a newer selection superseded this one
    const loaded = await engine.loadSong(decoded);
    songs[i].duration = loaded.duration;
    renderSongs();
    songHint.innerHTML = '&nbsp;';
    if (autoplay) engine.play();
  } catch (e) {
    songHint.textContent = 'could not load: ' + e.message;
  }
}

const DROP_HTML = '<strong>Add songs</strong> &mdash; tap or drop files here<br>12-channel show WAV, or separate stems named vocals / drums / bass / guitar / piano / other';
async function addFiles(fileList) {
  const files = [...fileList].filter(f => f.size > 0);
  if (!files.length) return;
  dropZone.textContent = 'reading...';
  try {
    const found = await SSSongs.scanFiles(files);
    songs.push(...found);
    renderSongs();
    if (songIndex < 0 && songs.length) loadSongIndex(0, false);
  } catch (e) {
    alert('Could not add: ' + e.message);
  }
  dropZone.innerHTML = DROP_HTML;
}

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('over'); }));
dropZone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); if (e.target !== dropZone) addFiles(e.dataTransfer.files); });

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

function refreshTransportButtons() {
  playPauseBtn.innerHTML = engine.playing ? '&#10073;&#10073;' : '&#9654;';
  playPauseBtn.classList.toggle('playing', engine.playing);
  recordBtn.classList.toggle('recording', engine.isRecording);
}
engine.onStateChange = refreshTransportButtons;
engine.onEnded = () => { if (songs.length) loadSongIndex((songIndex + 1) % songs.length, true); };

prevBtn.addEventListener('click', () => { if (songs.length) loadSongIndex((songIndex - 1 + songs.length) % songs.length, engine.playing); buzz(15); });
nextBtn.addEventListener('click', () => { if (songs.length) loadSongIndex((songIndex + 1) % songs.length, engine.playing); buzz(15); });
stopBtn.addEventListener('click', () => { engine.stop(); buzz(15); });
playPauseBtn.addEventListener('click', async () => {
  await engine.ensure();
  if (engine.playing) engine.pause(); else engine.play();
  buzz(15);
});

recordBtn.addEventListener('click', async () => {
  await engine.ensure();
  if (engine.isRecording) {
    const blob = engine.stopRecording();
    const name = 'spatialstage-take-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.wav';
    recordStatus.hidden = false;
    recordStatus.innerHTML = 'Take ready: <a href="#" id="takeLink">' + name + '</a> (' + (blob.size / 1048576).toFixed(1) + ' MB)';
    $('takeLink').addEventListener('click', (e) => { e.preventDefault(); download(blob, name); });
    buzz(15);
  } else {
    engine.startRecording();
    recordStatus.hidden = false;
    recordStatus.textContent = 'Recording the mix... tap again to stop.';
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

seekBar.addEventListener('pointerdown', () => { seeking = true; });
seekBar.addEventListener('input', () => { posTimeEl.textContent = formatTime(Number(seekBar.value)); });
seekBar.addEventListener('change', () => { engine.seek(Number(seekBar.value)); seeking = false; });

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

$('selectAllBtn').addEventListener('click', () => ALL_STEMS.forEach(s => setArmed(s, true)));
$('selectNoneBtn').addEventListener('click', () => ALL_STEMS.forEach(s => setArmed(s, false)));
$('muteNoneBtn').addEventListener('click', () => ALL_STEMS.forEach(s => setMuted(s, false)));
$('muteAllBtn').addEventListener('click', () => ALL_STEMS.forEach(s => setMuted(s, true)));
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

sensorBtn.addEventListener('click', async () => {
  if (!window.isSecureContext) {
    alert('Motion sensors need an https:// page (or localhost). Open this page over https to use phone rotation; the dials and slider still work.');
  }
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res === 'granted') bindOrientation(); else alert('Motion permission denied');
    } catch (e) { alert('Error requesting motion permission: ' + e.message); }
  } else {
    bindOrientation();
  }
});

function bindOrientation() {
  window.addEventListener('deviceorientation', handleOrientation);
  sensorBtn.classList.add('active');
  sensorBtn.textContent = 'Motion Active';
  wantWakeLock = true; requestWakeLock();
  buzz([40, 40, 40]);
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
  lastRawAlpha = e.alpha;
  let delta = (e.alpha - zeroAlpha + 360) % 360;
  if (delta > 180) delta -= 360;
  slider.value = delta;
  applyRotation(delta);
}

/* ---------------- init ---------------- */

buildCards();
updateStemLabel(); refreshCards(); drawRadar(); renderSongs(); refreshTransportButtons();
