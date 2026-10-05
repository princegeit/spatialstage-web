// Offline motion curves for the FFT source's "Follow" and "Sections" modes.
// Each yields POINTS values in 0..1 spread evenly over the whole song, in
// precompute_fft_envelope.py's table format: azimuth offset = value * 360 -
// 180, so the stem reads them through the same index-by-playback-position
// lookup as Precalc.
//
// Plain functions of the samples, no Web Audio or DOM. The rig's bridge
// loads this same file (it is served at /shared/curves.js and required by
// bridge/curves_worker.js), so a song gets the same motion on both sides.
//
// The analysis is split in two so a big multichannel show file never has to
// sit in memory: Features eats a stem's samples in chunks of any size and
// keeps only a few numbers per half second, and balanceCurve / sectionsCurve
// turn those into the curves. balance() / sections() do both at once for a
// stem already in memory.
(function () {
  'use strict';
  const POINTS = 1000;
  const BLOCK = 512;                 // balance: frames are 4 blocks (2048) hopping by 1
  const toValue = (azDeg) => Math.min(1, Math.max(0, (azDeg + 180) / 360));

  // Average of a per-frame series resampled to POINTS values (a box filter,
  // not a pick, so a short event between two samples is not skipped).
  function toPoints(series) {
    const out = new Float32Array(POINTS), n = series.length;
    for (let i = 0; i < POINTS; i++) {
      const a = Math.floor(i * n / POINTS), b = Math.max(a + 1, Math.floor((i + 1) * n / POINTS));
      let s = 0;
      for (let j = a; j < b && j < n; j++) s += series[j];
      out[i] = s / (Math.min(b, n) - a || 1);
    }
    return out;
  }

  // Running totals for one stem: left/right energy per 512-sample block,
  // and per half second the energy, the energy of the sample-to-sample
  // difference (a brightness measure) and the plain mean level.
  class Features {
    constructor(sampleRate) {
      this.sr = sampleRate || 44100;
      this.half = Math.round(this.sr * 0.5);
      this.eL = []; this.eR = [];                  // per BLOCK
      this.hE = []; this.hD = [];                  // per half second
      this._bl = 0; this._br = 0; this._bn = 0;
      this._he = 0; this._hd = 0; this._hn = 0; this._prev = 0;
    }
    push(L, R) {
      const n = Math.min(L.length, R.length);
      for (let i = 0; i < n; i++) {
        const l = L[i], r = R[i], v = 0.5 * (l + r);
        this._bl += l * l; this._br += r * r;
        if (++this._bn === BLOCK) { this.eL.push(this._bl); this.eR.push(this._br); this._bl = this._br = this._bn = 0; }
        this._he += v * v; this._hd += (v - this._prev) * (v - this._prev); this._prev = v;
        if (++this._hn === this.half) { this.hE.push(this._he); this.hD.push(this._hd); this._he = this._hd = this._hn = 0; }
      }
    }
  }

  // Follow: the stem's own stereo position over time. Left/right level
  // balance per 2048-sample frame, quiet frames pulled to centre (no level,
  // no position), then smoothed over about a third of a second. Full
  // left/right lands at +-90 degrees; most stems are near-mono, so the stem
  // mostly sits at its home spot and only leans where the mix itself does.
  function balanceCurve(f) {
    const nFrames = Math.max(1, f.eL.length - 3);
    const eL = new Float64Array(nFrames), eR = new Float64Array(nFrames);
    let peak = 0;
    for (let i = 0; i < nFrames; i++) {
      for (let k = 0; k < 4; k++) { eL[i] += f.eL[i + k] || 0; eR[i] += f.eR[i + k] || 0; }
      if (eL[i] + eR[i] > peak) peak = eL[i] + eR[i];
    }
    const raw = new Float64Array(nFrames);
    const gate = peak * 1e-4;    // -40 dB under the loudest frame
    for (let i = 0; i < nFrames; i++) {
      const sl = Math.sqrt(eL[i]), sr = Math.sqrt(eR[i]), total = eL[i] + eR[i];
      const b = total > gate ? (sr - sl) / (sr + sl + 1e-12) : 0;
      raw[i] = b * Math.min(1, total / (gate * 10 + 1e-12));    // fade in over the next 10 dB
    }
    const win = 28, sm = new Float64Array(nFrames), norm = Math.tanh(2);
    let acc = 0;
    for (let i = 0; i < nFrames; i++) {
      acc += raw[i];
      if (i >= win) acc -= raw[i - win];
      sm[i] = toValue(90 * Math.tanh(2 * acc / Math.min(i + 1, win)) / norm);
    }
    return toPoints(sm);
  }

  // Sections: where the song changes character, and how big each part is.
  // Per half second (over a one second window) the features are loudness and
  // brightness. Novelty is how far the next four seconds sit from the
  // previous four; its peaks, at least eight seconds apart, are the section
  // boundaries. Each section then parks the stem on alternating sides, wide
  // for the loud parts and close in for the quiet ones.
  function sectionsCurve(f) {
    const nF = Math.max(1, f.hE.length - 1), win = f.half * 2;
    const loud = new Float64Array(nF), bright = new Float64Array(nF);
    for (let t = 0; t < nF; t++) {
      const e = (f.hE[t] || 0) + (f.hE[t + 1] || 0), d = (f.hD[t] || 0) + (f.hD[t + 1] || 0);
      loud[t] = Math.log10(Math.sqrt(e / win) + 1e-5);
      bright[t] = Math.log10(d / (e + 1e-12) + 1e-4);
    }
    const z = (a) => {
      let m = 0, v = 0;
      for (const x of a) m += x;
      m /= a.length;
      for (const x of a) v += (x - m) * (x - m);
      const sd = Math.sqrt(v / a.length) || 1;
      return a.map((x) => (x - m) / sd);
    };
    const fl = z(loud), fb = z(bright);

    const SIDE = 8;    // 4 s each side
    const nov = new Float64Array(nF);
    for (let t = SIDE; t <= nF - SIDE; t++) {
      let dl = 0, db = 0;
      for (let k = 0; k < SIDE; k++) {
        dl += fl[t + k] - fl[t - 1 - k];
        db += fb[t + k] - fb[t - 1 - k];
      }
      nov[t] = Math.hypot(dl / SIDE, db / SIDE);
    }
    let mean = 0, sq = 0, cnt = 0;
    for (let t = SIDE; t <= nF - SIDE; t++) { mean += nov[t]; cnt++; }
    mean /= cnt || 1;
    for (let t = SIDE; t <= nF - SIDE; t++) sq += (nov[t] - mean) * (nov[t] - mean);
    const threshold = mean + 0.8 * Math.sqrt(sq / (cnt || 1));
    const cand = [];
    for (let t = SIDE; t <= nF - SIDE; t++) {
      let top = true;
      for (let k = -SIDE; k <= SIDE && top; k++) if (nov[t + k] > nov[t]) top = false;
      if (top && nov[t] > threshold) cand.push(t);
    }
    cand.sort((a, b) => nov[b] - nov[a]);
    const bounds = [];
    for (const t of cand) if (bounds.every((b) => Math.abs(b - t) >= 16)) bounds.push(t);
    bounds.sort((a, b) => a - b);

    const edges = [0, ...bounds, nF];
    const secLoud = [];
    for (let s = 0; s + 1 < edges.length; s++) {
      let m = 0;
      for (let t = edges[s]; t < edges[s + 1]; t++) m += loud[t];
      secLoud.push(m / Math.max(1, edges[s + 1] - edges[s]));
    }
    const lo = Math.min(...secLoud), hi = Math.max(...secLoud);
    const series = new Float64Array(nF);
    for (let s = 0; s < secLoud.length; s++) {
      const intensity = hi - lo > 1e-9 ? (secLoud[s] - lo) / (hi - lo) : 0.5;
      // A song with no detected change has no structure to follow: stay home.
      const az = secLoud.length === 1 ? 0 : (s % 2 === 0 ? 1 : -1) * (20 + 130 * intensity);
      for (let t = edges[s]; t < edges[s + 1]; t++) series[t] = toValue(az);
    }
    return { curve: toPoints(series), boundaries: bounds.map((t) => t * 0.5 + 0.25) };   // seconds
  }

  function features(L, R, sampleRate) {
    const f = new Features(sampleRate);
    f.push(L, R);
    return f;
  }
  const balance = (L, R, sampleRate) => balanceCurve(features(L, R, sampleRate));
  const sections = (L, R, sampleRate) => sectionsCurve(features(L, R, sampleRate));

  const api = { POINTS, Features, balanceCurve, sectionsCurve, balance, sections };
  if (typeof window !== 'undefined') window.SSCurves = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
