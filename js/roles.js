// Auto roles: a starting motion for each stem, chosen by what the stem is.
// Vocals, kick and bass stay put; the kit follows its own stereo image;
// guitar, piano, pads and cymbals get slow movement. It only sets the
// ordinary spatial settings (FFT source, preset motion, smoothing, blend),
// so the result is what the panel shows afterwards and can be tweaked.
//
// Standalone and served to the rig's page at /shared/roles.js, like
// hands.js - both control pages apply the same table.
(function () {
  'use strict';
  const FOLLOW = 4, SECTIONS = 5;                // fftMode values (js/curves.js)
  const CIRCLE = 0, SINE = 1, TEMPO = 2;         // presetMode values

  // fft / preset: a mode number, or null for none. smoothing: the final
  // output smoothing (1 = instant, lower = glides).
  const ROLES = {
    vocals: { label: 'anchored',      fft: null,     preset: null,  smoothing: 1 },
    kick:   { label: 'anchored',      fft: null,     preset: null,  smoothing: 1 },
    bass:   { label: 'anchored',      fft: null,     preset: null,  smoothing: 1 },
    drums:  { label: 'follows stereo', fft: FOLLOW,  preset: null,  smoothing: 0.3 },
    snare:  { label: 'follows stereo', fft: FOLLOW,  preset: null,  smoothing: 0.3 },
    toms:   { label: 'follows stereo', fft: FOLLOW,  preset: null,  smoothing: 0.3 },
    guitar: { label: 'follows + sways', fft: FOLLOW, preset: SINE,  rate: 0.04, smoothing: 0.25 },
    piano:  { label: 'moves by section', fft: SECTIONS, preset: null, smoothing: 0.15 },
    other:  { label: 'slow orbit',    fft: null,     preset: CIRCLE, rate: 0.03, smoothing: 0.2 },
    hihat:  { label: 'tempo orbit',   fft: null,     preset: TEMPO, smoothing: 0.3 },
    ride:   { label: 'sways',         fft: null,     preset: SINE,  rate: 0.08, smoothing: 0.3 },
    crash:  { label: 'moves by section', fft: SECTIONS, preset: null, smoothing: 0.4 },
  };

  // [[param, value], ...] to send for one stem. opts.hasCurves = false (a
  // rig without the Follow / Sections modes) drops those and leaves the
  // stem's own motion to the preset part of its role.
  function plan(stem, stemIndex, opts) {
    const r = ROLES[stem];
    if (!r) return [];
    const hasCurves = !opts || opts.hasCurves !== false;
    const fft = (r.fft !== null && (hasCurves || r.fft < FOLLOW)) ? r.fft : null;
    const p = [['blendMode', 0], ['smoothingMode', 0], ['smoothing', r.smoothing], ['fftSrc', stemIndex]];
    if (fft !== null) p.push(['fftMode', fft]);
    if (r.preset !== null) {
      p.push(['presetMode', r.preset]);
      if (r.rate) p.push(['presetRate', r.rate]);
    }
    p.push(['blendWeights2', [fft !== null ? 0.5 : 0, r.preset !== null ? 0.5 : 0]]);
    return p;
  }

  const api = { ROLES, plan, FOLLOW, SECTIONS };
  if (typeof window !== 'undefined') window.SSRoles = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
