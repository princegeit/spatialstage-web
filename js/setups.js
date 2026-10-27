// Stem setups: numbered presets plus setups attached to a song - the same
// model, and the same file format, as the Pd rig's bridge (bridge/server.js,
// "stem setups"), so a setup exported from either rig imports into the other.
//
// A setup is the whole stem configuration:
//   { name, spatial: { <stem>: { fftMode, presetMode, presetRate, blendMode,
//       blendWeights2, blendWeights3, tempoSource, tempoBpm, base, fftSrc,
//       smoothing, smoothingMode, beatSrc, beatEvery, beatSteps, beatPattern,
//       beatNudge, beatFollow, beatSense, evOn, evTypes, evMode, evAim, evCurve,
//       evSpeed, evSense, evCues, evRoom } },
//     stems: { <stem>: { volume, muted, armed } } }
// `base` is where the stem sits, as an offset from its layout azimuth
// (SSStems.GEOMETRY / the Pd patch's creation arguments).
//
// Here they live in localStorage; on the rig, as files (bridge/presets/
// preset-<n>.json and show_ready/<song>.spatial.json). Export/import moves
// them between the two as one JSON file:
//   { format: 'spatialstage-setups', version: 2,
//     presets: [ { n, name, spatial, stems }, ... ],
//     songs: { '<song name>': { spatial, stems }, ... } }
// Song names are without extension on both sides.
(function () {
  'use strict';
  const S = (typeof SSStems !== 'undefined') ? SSStems : require('./stems.js');
  const EV = (typeof SSEvents !== 'undefined') ? SSEvents : require('./events.js');
  const KEY = 'spatialstage.setups.v2';
  const LEGACY_KEY = 'spatialstage.presets.v1';
  const FORMAT = 'spatialstage-setups';

  const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180;
  const num = (v, dflt) => (Number.isFinite(Number(v)) ? Number(v) : dflt);

  function spatialDefaults(stem) {
    return {
      fftMode: 0, presetMode: 0, presetRate: 0.05, blendMode: 0,
      blendWeights2: [0, 0], blendWeights3: [0.333, 0.333, 0.334],
      tempoSource: 0, tempoBpm: 120, base: 0, fftSrc: S.STEMS.indexOf(stem), smoothing: 1,
      smoothingMode: 0,
      beatSrc: S.STEMS.length, beatEvery: 1, beatSteps: 4, beatPattern: 0, beatNudge: 0, beatFollow: 0, beatSense: 1,
      ...EV.DEFAULTS,   // sound events (js/events.js)
    };
  }

  // The built-in preset 0 until one is saved: every stem at its layout
  // position, audible and armed. (The rig's built-in one starts every stem
  // at front instead - its base is minus the layout azimuth.)
  function defaultSetup() {
    const spatial = {}, stems = {};
    for (const s of S.STEMS) { spatial[s] = spatialDefaults(s); stems[s] = { volume: 1, muted: false, armed: true }; }
    return { name: 'Default', spatial, stems };
  }

  // Any setup from anywhere - this page, the rig, an older version, a
  // hand-edited file - made whole: every stem present, every value of the
  // right type and range, unknown keys dropped. The same checks as the
  // bridge's setSpatialValue.
  function normalise(setup) {
    const out = defaultSetup();
    out.name = setup && typeof setup.name === 'string' ? setup.name.slice(0, 60) : '';
    if (!setup || typeof setup !== 'object') return out;
    for (const s of S.STEMS) {
      const sp = (setup.spatial && setup.spatial[s]) || {};
      const d = out.spatial[s];
      for (const k of ['fftMode', 'presetMode', 'presetRate', 'blendMode', 'tempoSource', 'tempoBpm', 'fftSrc', 'smoothing']) d[k] = num(sp[k], d[k]);
      d.base = wrap180(num(sp.base, d.base));
      d.fftSrc = Math.max(0, Math.min(S.STEMS.length - 1, Math.round(d.fftSrc)));
      d.smoothing = Math.max(0.01, Math.min(1, d.smoothing));
      d.tempoBpm = Math.max(20, Math.min(300, d.tempoBpm));
      if ([0, 1, 2].includes(Math.round(num(sp.smoothingMode, 0)))) d.smoothingMode = Math.round(num(sp.smoothingMode, 0));
      // Beat steps settings, kept only when valid (the same checks as the bridge's BEAT_PARAMS).
      const pick = (k, ok) => { const v = Math.round(num(sp[k], d[k])); if (ok(v)) d[k] = v; };
      pick('beatSrc', (v) => v >= 0 && v <= S.STEMS.length);
      // Before the live-input stems there were twelve stems, and 12 meant the whole mix.
      if (d.beatSrc === S.STEMS.length - S.INPUT_STEMS.length) d.beatSrc = S.STEMS.length;
      pick('beatEvery', (v) => [1, 2, 4, 8].includes(v));
      pick('beatSteps', (v) => [2, 3, 4, 6, 8].includes(v));
      pick('beatPattern', (v) => [0, 1, 2, 3].includes(v));
      pick('beatFollow', (v) => v === 0 || v === 1);
      pick('beatSense', (v) => [0, 1, 2].includes(v));
      d.beatNudge = Math.max(-200, Math.min(200, num(sp.beatNudge, d.beatNudge)));
      Object.assign(d, EV.normalise(sp));   // sound events: valid values kept, the rest default
      if (Array.isArray(sp.blendWeights2) && sp.blendWeights2.length === 2) d.blendWeights2 = sp.blendWeights2.map((v) => num(v, 0));
      if (Array.isArray(sp.blendWeights3) && sp.blendWeights3.length === 3) {
        const raw = sp.blendWeights3.map((v) => num(v, 0));
        const sum = raw.reduce((a, b) => a + b, 0) || 1;
        d.blendWeights3 = raw.map((v) => v / sum);
      }
      const st = (setup.stems && setup.stems[s]) || {};
      out.stems[s] = {
        volume: Math.max(0, Math.min(1, num(st.volume, 1))),
        muted: !!st.muted,
        armed: st.armed !== false,
      };
    }
    return out;
  }

  // The first web version kept one preset per song name, in its own shape:
  // { spatial, volume: {stem: v}, muted: [stems], armed: [stems], azim: {stem: deg} },
  // with the dial position (azim) separate from spatial.base. Folded
  // together here the way the bridge folds the phone offset into base.
  function fromLegacy(p) {
    const setup = { name: '', spatial: {}, stems: {} };
    for (const s of S.STEMS) {
      const sp = Object.assign({}, (p.spatial && p.spatial[s]) || {});
      const azim = p.azim && Number.isFinite(p.azim[s]) ? p.azim[s] : S.GEOMETRY[s].azimuth;
      sp.base = Math.round(wrap180(num(sp.base, 0) + azim - S.GEOMETRY[s].azimuth));
      setup.spatial[s] = sp;
      setup.stems[s] = {
        volume: p.volume && Number.isFinite(p.volume[s]) ? p.volume[s] : 1,
        muted: Array.isArray(p.muted) && p.muted.includes(s),
        // That version had six stems; the drum parts it never knew stay armed.
        armed: !Array.isArray(p.armed) || p.armed.includes(s) || S.DRUM_PARTS.includes(s),
      };
    }
    return normalise(setup);
  }
  const isLegacy = (p) => p && typeof p === 'object' && !p.stems && (p.volume || p.azim || Array.isArray(p.muted));

  /* ---------------- storage ---------------- */

  function load() {
    let store = null;
    try { store = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
    if (!store || typeof store !== 'object') store = { presets: {}, songs: {} };
    store.presets = store.presets || {};
    store.songs = store.songs || {};
    // One-off: the per-song presets of the first version become setups
    // attached to those songs; its no-song "_default" becomes preset 0.
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
      if (legacy && typeof legacy === 'object') {
        for (const name in legacy) {
          if (!isLegacy(legacy[name])) continue;
          if (name === '_default') { if (!store.presets[0]) store.presets[0] = Object.assign(fromLegacy(legacy[name]), { name: 'Default' }); }
          else if (!store.songs[name]) store.songs[name] = fromLegacy(legacy[name]);
        }
        localStorage.setItem(KEY, JSON.stringify(store));
        localStorage.removeItem(LEGACY_KEY);
      }
    } catch (e) {}
    return store;
  }

  function save(store) {
    try { localStorage.setItem(KEY, JSON.stringify(store)); return null; }
    catch (e) { return e.message; }
  }

  function listPresets(store) {
    const found = new Map([[0, 'Default']]);
    for (const k in store.presets) {
      const n = Number(k);
      if (Number.isInteger(n) && n >= 0) found.set(n, store.presets[k].name || (n === 0 ? 'Default' : ''));
    }
    return [...found].sort((a, b) => a[0] - b[0]).map(([n, name]) => ({ n, name }));
  }

  const readPreset = (store, n) => (store.presets[n] ? normalise(store.presets[n]) : n === 0 ? defaultSetup() : null);
  const nextPresetNumber = (store) => Math.max(...listPresets(store).map((p) => p.n)) + 1;

  /* ---------------- files ---------------- */

  function exportFile(store) {
    return {
      format: FORMAT, version: 2, exported: new Date().toISOString(),
      stems: S.STEMS,
      presets: listPresets(store).filter((p) => store.presets[p.n]).map((p) => Object.assign({ n: p.n }, normalise(store.presets[p.n]))),
      songs: Object.fromEntries(Object.keys(store.songs).map((name) => [name, normalise(store.songs[name])])),
    };
  }

  // Reads an export from this page, from the rig, or the first web
  // version's. Returns { presets: [{n, setup}], songs: {name: setup} } or
  // throws with a message fit for the user.
  function parseFile(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('That is not a SpatialStage setups file.');
    const out = { presets: [], songs: {} };
    if (obj.format === FORMAT) {
      for (const p of Array.isArray(obj.presets) ? obj.presets : []) {
        const n = Math.round(Number(p && p.n));
        if (Number.isInteger(n) && n >= 0) out.presets.push({ n, setup: normalise(p) });
      }
      for (const name in (obj.songs || {})) if (name && obj.songs[name]) out.songs[name.replace(/\.wav$/i, '')] = normalise(obj.songs[name]);
    } else {
      // First web version: a plain map of song name -> preset.
      for (const name in obj) if (isLegacy(obj[name])) {
        if (name === '_default') out.presets.push({ n: 0, setup: Object.assign(fromLegacy(obj[name]), { name: 'Default' }) });
        else out.songs[name] = fromLegacy(obj[name]);
      }
    }
    if (!out.presets.length && !Object.keys(out.songs).length) throw new Error('No setups found in that file.');
    return out;
  }

  // Imported presets and song setups replace ones with the same number or
  // name; everything else is kept.
  function merge(store, parsed) {
    for (const p of parsed.presets) store.presets[p.n] = p.setup;
    for (const name in parsed.songs) store.songs[name] = parsed.songs[name];
    return { presets: parsed.presets.length, songs: Object.keys(parsed.songs).length };
  }

  const api = { load, save, listPresets, readPreset, nextPresetNumber, defaultSetup, spatialDefaults, normalise, exportFile, parseFile, merge, FORMAT };
  if (typeof window !== 'undefined') window.SSSetups = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
