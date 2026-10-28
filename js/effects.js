// Effects: a second motion per stem that turns an effect's knob instead of moving the stem.
// The web app (motion.js FxMotion + engine.js setEffect / setFxKnob), the rig page and the bridge
// (bridge/server.js -> pd/spatial/fx-control.pd + stem-fx.pd) all read this one file, the same
// way events.js is shared.
//
// Per stem the Effects menu holds which effect (fx), how much of it at most (fxMix), who turns
// its knob (ctl: 'spatial' | 'phone' | 'cam' | null) and a full set of Motion control settings
// (FFT / Presets / Mixed, algorithm, source stem, smoothing, Beat steps). That motion gives an
// angle like a stem's; the angle is the knob: straight ahead (0 deg) = knob at minimum, behind
// (+-180) = knob at maximum, linear in between, so a full circle sweeps the knob up and down
// with no jump. The "Rest" slider (base) is where the knob sits before any motion is added.
(function () {
  'use strict';

  // id is what Pd and the bridge see (address 160+i, first float). Order = the menu's order.
  const LIST = [
    { id: 0, key: 'off', name: 'Off', knob: '' },
    { id: 1, key: 'reverb', name: 'Reverb', knob: 'how much reverb' },
    { id: 2, key: 'echo', name: 'Echo', knob: 'echo level and how long it repeats' },
    { id: 3, key: 'flanger', name: 'Flanger', knob: 'the sweep (comb delay 1 to 10 ms)' },
    { id: 4, key: 'phaser', name: 'Phaser', knob: 'the sweep (notches 200 Hz to 5 kHz)' },
    { id: 5, key: 'chorus', name: 'Chorus', knob: 'how deep the chorus is' },
    { id: 6, key: 'lowpass', name: 'Low-pass', knob: 'closes the filter, 20 kHz down to 150 Hz' },
    { id: 7, key: 'highpass', name: 'High-pass', knob: 'opens the filter, 20 Hz up to 5 kHz' },
    { id: 8, key: 'drive', name: 'Drive', knob: 'how hard the stem is overdriven' },
    { id: 9, key: 'crush', name: 'Bit crush', knob: 'bits, 16 down to 3' },
  ];
  const COUNT = LIST.length;

  // The knob from an angle in degrees: 0 at front, 1 behind.
  const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180;
  const knobOf = (deg) => Math.min(1, Math.abs(wrap180(deg)) / 180);

  // Motion settings, the same names and meaning as a stem's Motion control (the bridge's
  // spatialDefaults, motion.js StemMotion), minus sound events. Presets on by default with a
  // slow circle: picking an effect and Spatial is enough to hear the knob move.
  function motionDefaults(index, stemCount) {
    return {
      fftMode: 0, presetMode: 0, presetRate: 0.1, blendMode: 0,
      blendWeights2: [0, 1], blendWeights3: [0.333, 0.333, 0.334],
      tempoSource: 0, tempoBpm: 120, base: 0, fftSrc: index, smoothing: 1, smoothingMode: 0,
      beatSrc: stemCount, beatEvery: 1, beatSteps: 4, beatPattern: 0, beatNudge: 0, beatFollow: 0, beatSense: 1,
    };
  }
  function defaults(index, stemCount) {
    return Object.assign({ fx: 0, fxMix: 1, ctl: null }, motionDefaults(index, stemCount));
  }

  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  // One value, checked; undefined if it is not acceptable. Shared by the bridge and both pages.
  function clean(param, value, stemCount) {
    const v = Number(value);
    switch (param) {
      case 'fx': return Number.isInteger(v) && v >= 0 && v < COUNT ? v : undefined;
      case 'fxMix': return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : undefined;
      case 'ctl': return value === 'spatial' || value === 'phone' || value === 'cam' ? value : value === null ? null : undefined;
      case 'fftMode': return [0, 1, 2, 4, 5, 6].includes(v) ? v : undefined;
      case 'presetMode': return Number.isFinite(v) ? (v >= 0.5 ? 1 : 0) : undefined;
      case 'presetRate': return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : undefined;
      case 'blendMode': return v === 0 || v === 1 ? v : undefined;
      case 'blendWeights2': return Array.isArray(value) && value.length === 2 ? value.map((x) => Math.max(0, Math.min(1, num(x, 0)))) : undefined;
      case 'blendWeights3': {
        if (!Array.isArray(value) || value.length !== 3) return undefined;
        const raw = value.map((x) => Math.max(0, num(x, 0))), sum = raw.reduce((a, b) => a + b, 0) || 1;
        return raw.map((x) => x / sum);
      }
      case 'tempoSource': return [0, 1, 2].includes(v) ? v : undefined;
      case 'tempoBpm': return Number.isFinite(v) ? Math.max(20, Math.min(300, v)) : undefined;
      case 'base': return Number.isFinite(v) ? wrap180(v) : undefined;
      case 'fftSrc': return Number.isInteger(v) && v >= 0 && v < stemCount ? v : undefined;
      case 'smoothing': return Number.isFinite(v) ? Math.max(0.01, Math.min(1, v)) : undefined;
      case 'smoothingMode': return [0, 1, 2].includes(v) ? v : undefined;
      case 'beatSrc': return Number.isInteger(v) && v >= 0 && v <= stemCount ? v : undefined;
      case 'beatEvery': return [1, 2, 4, 8].includes(v) ? v : undefined;
      case 'beatSteps': return [2, 3, 4, 6, 8].includes(v) ? v : undefined;
      case 'beatPattern': return [0, 1, 2, 3].includes(v) ? v : undefined;
      case 'beatNudge': return Number.isFinite(v) ? Math.max(-200, Math.min(200, v)) : undefined;
      case 'beatFollow': return v === 0 || v === 1 ? v : undefined;
      case 'beatSense': return [0, 1, 2].includes(v) ? v : undefined;
      default: return undefined;
    }
  }
  // A whole stem's settings from anywhere (a saved file, an older version): valid values kept,
  // the rest default.
  function normalise(st, index, stemCount) {
    const out = defaults(index, stemCount);
    if (!st || typeof st !== 'object') return out;
    for (const k of Object.keys(out)) {
      if (st[k] === undefined) continue;
      const v = clean(k, st[k], stemCount);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  // Is the knob being turned at all? Only then does anything run (Pd switches the stem's effect
  // motion off, the web app skips it).
  const isOn = (st) => !!st && st.fx > 0 && !!st.ctl;

  // What the knob (0..1) and the mix do to each effect: the numbers both rigs use. Every effect
  // plays dry * the stem + wet * the effect's output. pd/spatial/generate_effects.py has the same
  // formulas, written as Pd objects.
  const ECHO_S = 0.33, CHORUS_MS = 18, CHORUS_HZ = 0.9;
  const params = {
    reverb: (k, mix) => ({ wet: k * mix, dry: 1 - 0.5 * k * mix }),
    echo: (k, mix) => ({ wet: k * mix, dry: 1, feedback: 0.2 + 0.55 * k }),
    flanger: (k, mix) => ({ delayMs: 1 + 9 * k * k, wet: 0.5 * mix, dry: 1 - 0.5 * mix }),
    phaser: (k, mix) => ({ freq: 200 * Math.pow(25, k), wet: 0.5 * mix, dry: 1 - 0.5 * mix }),
    chorus: (k, mix) => { const w = 0.5 * mix * Math.min(1, 3 * k); return { depthMs: 7 * k, wet: w, dry: 1 - w }; },
    lowpass: (k, mix) => ({ freq: 20000 * Math.pow(150 / 20000, k), wet: mix, dry: 1 - mix }),
    highpass: (k, mix) => ({ freq: 20 * Math.pow(5000 / 20, k), wet: mix, dry: 1 - mix }),
    drive: (k, mix) => { const g = 1 + 29 * k; return { pre: g, post: 1 / Math.sqrt(g), wet: mix, dry: 1 - mix }; },
    crush: (k, mix) => ({ bits: 16 - 13 * k, wet: mix, dry: 1 - mix }),
  };

  const api = { LIST, COUNT, knobOf, defaults, motionDefaults, clean, normalise, isOn, params, ECHO_S, CHORUS_MS, CHORUS_HZ };
  if (typeof window !== 'undefined') window.SSEffects = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
