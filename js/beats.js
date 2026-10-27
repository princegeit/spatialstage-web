// Beat analysis for the "Beat steps" motion mode (shared: the web app runs it
// in the page, the rig's bridge/beats_worker.js requires this same file): from a stem's audio to a
// tempo estimate and a list of beat times. Pure functions plus one streaming
// class - no I/O - so beats_worker.js (the real song) and the tests (a
// synthetic click track) run the same code.
//
// Offline on purpose: the rig plays prepared show files, so the whole song is
// known before it starts. Analysing it once gives beats with no detection
// latency and a steady grid through breakdowns, which a live detector
// reacting to each hit cannot.
//
//   OnsetEnvelope   audio -> onset strength, 100 values a second: the
//                   positive change of the log-compressed spectrum, summed
//                   over all bins (spectral flux).
//   estimateTempo   envelope -> BPM and a 0..1 confidence: autocorrelation of
//                   the onset strength, with the strength at 2x and 4x the
//                   period added in (a real beat repeats at the bar), and a
//                   mild preference for tempi around 125 BPM so the half/
//                   double ambiguity falls on the usual side.
//   trackBeats      envelope + BPM -> beat times: Ellis's dynamic-programming
//                   beat tracker (D. Ellis, "Beat Tracking by Dynamic
//                   Programming", 2007). Every beat scores the onset strength
//                   under it, minus a penalty for the gap to the previous beat
//                   differing from the period - so it lands on onsets but
//                   keeps time through gaps.
(function () {
'use strict';

const FPS = 100;            // onset envelope frames per second
const FFT_SIZE = 1024;
const BPM_MIN = 60, BPM_MAX = 200;
const PERIODICITY_FULL = 0.5;   // autocorrelation that counts as fully confident
const MIN_ONSET_STD = 0.1;      // below this much onset activity there is no pulse to find

// Spectral flux summed over a few log-spaced bands instead of every bin. A
// bin-by-bin sum is dominated by the top octaves (most of the bins), so a
// hi-hat's noise would outweigh a kick - and a tracker that follows the
// strongest onsets would lock on the off-beat. Equal-width bands in log
// frequency, with the lows weighted up, put the kick back on top.
function makeBands(rate) {
  const edges = [];
  const lo = 30, hi = Math.min(16000, rate / 2 * 0.95), count = 24;
  for (let i = 0; i <= count; i++) edges.push(lo * Math.pow(hi / lo, i / count));
  const bands = [];
  for (let i = 0; i < count; i++) {
    const from = Math.max(1, Math.round(edges[i] / rate * FFT_SIZE));
    const to = Math.max(from + 1, Math.round(edges[i + 1] / rate * FFT_SIZE));
    const centre = Math.sqrt(edges[i] * edges[i + 1]);
    bands.push({ from, to, weight: centre < 250 ? 1.6 : centre < 2000 ? 0.8 : 0.45 });
  }
  return bands;
}

// In-place radix-2 FFT of (re, im), length a power of two.
function makeFft(n) {
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) if (i & (1 << b)) r |= 1 << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, w = 0; k < half; k++, w += step) {
          const a = start + k, b = a + half;
          const tr = re[b] * cos[w] + im[b] * sin[w];
          const ti = im[b] * cos[w] - re[b] * sin[w];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

class OnsetEnvelope {
  constructor(sampleRate) {
    this.rate = sampleRate;
    this.bands = makeBands(sampleRate);
    this.hop = Math.round(sampleRate / FPS);
    this.fps = sampleRate / this.hop;       // 100 at 44.1 / 48 kHz, slightly off at other rates
    this.fft = makeFft(FFT_SIZE);
    this.window = new Float64Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FFT_SIZE);
    this.ring = new Float32Array(FFT_SIZE);   // the last FFT_SIZE samples
    this.written = 0;                         // total samples seen
    this.re = new Float64Array(FFT_SIZE);
    this.im = new Float64Array(FFT_SIZE);
    this.prev = new Float64Array(this.bands.length);
    this.havePrev = false;
    this.values = [];                         // onset strength per frame
    this.nextFrameAt = FFT_SIZE;              // sample count at which the next frame is complete
  }

  push(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.written % FFT_SIZE] = samples[i];
      this.written++;
      if (this.written === this.nextFrameAt) {
        this.frame();
        this.nextFrameAt += this.hop;
      }
    }
  }

  frame() {
    const { re, im, ring, window } = this;
    const start = this.written - FFT_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) { re[i] = ring[(start + i) % FFT_SIZE] * window[i]; im[i] = 0; }
    this.fft(re, im);
    // |X| of a full-scale sine under this window is FFT_SIZE / 4: scale to ~1.
    const scale = 4 / FFT_SIZE;
    let flux = 0;
    for (let b = 0; b < this.bands.length; b++) {
      const { from, to, weight } = this.bands[b];
      let power = 0;
      for (let k = from; k < to; k++) power += re[k] * re[k] + im[k] * im[k];
      const m = Math.log1p(100 * scale * Math.sqrt(power / (to - from)));
      if (this.havePrev && m > this.prev[b]) flux += weight * (m - this.prev[b]);
      this.prev[b] = m;
    }
    this.havePrev = true;
    this.values.push(flux);
  }

  // Time in seconds of frame f - the middle of its window.
  frameTime(f) { return (f * this.hop + FFT_SIZE / 2) / this.rate; }
}

function mean(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; }

// Onset strength -> something the tempo and beat steps can compare across
// songs and stems: the slow level removed (a moving mean over ~0.5 s),
// negatives dropped, scaled to unit standard deviation.
function prepare(env) {
  const n = env.length, half = Math.round(FPS * 0.25);
  const out = new Float32Array(n);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(n, i + half + 1);
    const local = (prefix[hi] - prefix[lo]) / (hi - lo);
    out[i] = Math.max(0, env[i] - local);
  }
  let sq = 0;
  for (let i = 0; i < n; i++) sq += out[i] * out[i];
  const std = Math.sqrt(sq / Math.max(1, n));
  if (std > 0) for (let i = 0; i < n; i++) out[i] /= std;
  out.rawStd = std;      // before scaling: how much onset activity there really was
  return out;
}

// { bpm, confidence } for a prepared envelope; bpm 0 if there is nothing to
// measure (silence, or a signal too short for one beat period).
function estimateTempo(o, fps = FPS) {
  const n = o.length;
  const lagMin = Math.floor(fps * 60 / BPM_MAX), lagMax = Math.ceil(fps * 60 / BPM_MIN);
  if (n < 4 * lagMax + 10) return { bpm: 0, confidence: 0 };
  // Smooth first: a beat period is rarely a whole number of frames, and a
  // one-frame-wide onset loses most of its autocorrelation peak half a frame
  // off the grid - which made the exact half tempo (nearer to a whole
  // number of frames) win. Two passes of [1 2 1] / 4 widen the peak enough.
  let sm = Float32Array.from(o);
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(n);
    for (let i = 0; i < n; i++) next[i] = 0.25 * sm[Math.max(0, i - 1)] + 0.5 * sm[i] + 0.25 * sm[Math.min(n - 1, i + 1)];
    sm = next;
  }
  // Mean removed: the envelope is half-wave rectified, so it sits above
  // zero, and without this every lag correlates by about the square of that
  // mean - noise then looks periodic.
  let m = 0;
  for (let i = 0; i < n; i++) m += sm[i];
  m /= n;
  for (let i = 0; i < n; i++) sm[i] -= m;
  o = sm;
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += o[i] * o[i];
  if (e0 <= 0) return { bpm: 0, confidence: 0 };
  const maxLag = 4 * lagMax + 2;
  const ac = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += o[i] * o[i + lag];
    ac[lag] = s / e0 * (n / (n - lag));       // unbiased: long lags have fewer terms
  }
  const score = new Float64Array(lagMax + 2);
  let best = -1, bestScore = -Infinity, sum = 0, count = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = fps * 60 / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 125) / 1.3, 2));
    const s = (ac[lag] + 0.5 * ac[2 * lag] + 0.25 * ac[4 * lag]) * prior;
    score[lag] = s;
    sum += s; count++;
    if (s > bestScore) { bestScore = s; best = lag; }
  }
  if (best < 0) return { bpm: 0, confidence: 0 };
  // Parabolic interpolation around the peak for a sub-frame period.
  let lag = best;
  if (best > lagMin && best < lagMax) {
    const a = score[best - 1], b = score[best], c = score[best + 1];
    const d = a - 2 * b + c;
    if (d < 0) lag = best + 0.5 * (a - c) / d;
  }
  // How periodic the onsets really are at that tempo: the autocorrelation
  // at the period (and its multiples, as in the score), 1 for a perfectly
  // regular pulse, near 0 for noise.
  const l = Math.round(lag);
  const periodicity = (ac[l] + 0.5 * ac[2 * l] + 0.25 * ac[4 * l]) / 1.75;
  const confidence = Math.max(0, Math.min(1, periodicity / PERIODICITY_FULL));
  return { bpm: fps * 60 / lag, confidence, periodicity };
}

// Beat frames (indices into o) for a prepared envelope at a given tempo.
function trackBeats(o, bpm, fps = FPS) {
  const n = o.length;
  if (!bpm || n === 0) return [];
  const T = fps * 60 / bpm;
  const cum = new Float64Array(n), back = new Int32Array(n).fill(-1);
  const lo = Math.max(1, Math.round(T / 2)), hi = Math.round(2 * T);
  const ALPHA = 100;
  for (let t = 0; t < n; t++) {
    let best = 0, bestIdx = -1;      // a chain may always start fresh (best <= 0)
    for (let gap = lo; gap <= hi; gap++) {
      const p = t - gap;
      if (p < 0) break;
      const l = Math.log(gap / T);
      const s = cum[p] - ALPHA * l * l;
      if (s > best) { best = s; bestIdx = p; }
    }
    cum[t] = o[t] + best;
    back[t] = bestIdx;
  }
  // The chain's end: the best score within the last period or so.
  let end = n - 1, endScore = -Infinity;
  for (let t = Math.max(0, n - Math.ceil(T)); t < n; t++) if (cum[t] > endScore) { endScore = cum[t]; end = t; }
  const beats = [];
  for (let t = end; t >= 0; t = back[t]) { beats.push(t); if (back[t] < 0) break; }
  beats.reverse();
  // Trim weak beats off both ends (the chain runs through silence).
  const w = beats.map((f) => o[f]);
  const smooth = w.map((_, i) => {
    let s = 0, c = 0;
    for (let k = -2; k <= 2; k++) if (w[i + k] !== undefined) { s += w[i + k] * (1 - Math.abs(k) / 3); c += 1 - Math.abs(k) / 3; }
    return s / c;
  });
  let rms = 0;
  for (const v of smooth) rms += v * v;
  rms = Math.sqrt(rms / Math.max(1, smooth.length));
  const thresh = 0.5 * rms;
  let a = 0, b = beats.length;
  while (a < b && smooth[a] < thresh) a++;
  while (b > a && smooth[b - 1] < thresh) b--;
  return beats.slice(a, b);
}

// Every onset peak of a prepared envelope: [{ frame, strength }]. A local
// maximum within +-4 frames (40 ms), at least MIN_PEAK strong (in standard
// deviations of the envelope - hits are several, a hi-hat's flutter about
// one), and no two closer than 60 ms (the stronger wins). The strength is
// kept so the sensitivity can be chosen later without re-analysing.
const MIN_PEAK = 0.7;
function pickPeaks(o, fps = FPS) {
  const n = o.length, r = 4, minGap = Math.round(fps * 0.06);
  const peaks = [];
  for (let i = r; i < n - r; i++) {
    const v = o[i];
    if (v < MIN_PEAK) continue;
    let isMax = true;
    for (let k = -r; k <= r && isMax; k++) if (k !== 0 && (o[i + k] > v || (o[i + k] === v && k < 0))) isMax = false;
    if (!isMax) continue;
    const last = peaks[peaks.length - 1];
    if (last && i - last.frame < minGap) {
      if (v > last.strength) { last.frame = i; last.strength = v; }
      continue;
    }
    peaks.push({ frame: i, strength: v });
  }
  return peaks;
}

// One envelope -> { bpm, confidence, beats: [frame index...] }. Below
// minConfidence the stem has no steady beat of its own and gets none - unless
// `hint` (the whole song's result) is steady: a stem that has any onset
// activity at all is then tracked at the SONG's tempo, its beats placed by
// its own onsets. That is what makes a vocal or a pad step with the groove
// instead of at a tempo of its own that matches nothing (the autocorrelation
// of a vocal line often finds phrase lengths, not the beat, or double time).
// A stem whose own tempo already agrees with the song's keeps its own.
function analyse(env, minConfidence = 0.2, hint = null, fps = FPS) {
  const o = prepare(env);
  if (!(o.rawStd >= MIN_ONSET_STD)) return { bpm: 0, confidence: 0, beats: [], peaks: [] };
  const peaks = pickPeaks(o, fps);
  const est = estimateTempo(o, fps);
  let bpm = est.bpm, confidence = est.confidence, forced = false;
  const compatible = (a, b) => Math.abs(a / b - 1) < 0.04;
  if (hint && hint.bpm && hint.confidence >= 0.3 && (!bpm || confidence < minConfidence || !compatible(bpm, hint.bpm))) {
    bpm = hint.bpm; confidence = hint.confidence * 0.6; forced = true;
  }
  if (!bpm || (!forced && confidence < minConfidence)) {
    return { bpm: bpm || 0, confidence, periodicity: est.periodicity, beats: [], peaks };
  }
  const beats = trackBeats(o, bpm, fps);
  // The tracked beats give a finer tempo than the autocorrelation's whole
  // frames: the median span of eight beats.
  if (beats.length > 12) {
    const spans = [];
    for (let i = 0; i + 8 < beats.length; i++) spans.push((beats[i + 8] - beats[i]) / 8);
    spans.sort((a, b) => a - b);
    const period = spans[spans.length >> 1];
    if (Math.abs(period - fps * 60 / bpm) < 0.15 * fps * 60 / bpm) bpm = fps * 60 / period;
  }
  return { bpm, confidence, periodicity: est.periodicity, beats, peaks, forced };
}

// Everything the Beat steps mode needs from a song, from one OnsetEnvelope per
// stem (names[i] for onsets[i]): each stem's tempo, beats and peaks, and the
// same for the whole mix (the sum of every stem's onset strength), which is
// also the tempo hint every stem is held to. The one place the result's shape
// is defined - the rig's worker writes it to .beats.json, the web app keeps it.
function describeSong(onsets, names) {
  const round3 = (v) => Math.round(v * 1000) / 1000;
  const o0 = onsets[0];
  const describe = (env, hint) => {
    const r = analyse(env, undefined, hint, o0.fps);
    return {
      raw: r,
      info: {
        bpm: Math.round(r.bpm * 100) / 100,
        confidence: Math.round(r.confidence * 100) / 100,
        level: Math.round(prepare(env).rawStd * 1000) / 1000,
        forced: !!r.forced,
        beats: r.beats.map((f) => round3(o0.frameTime(f))),
        peaks: {
          t: r.peaks.map((p) => round3(o0.frameTime(p.frame))),
          s: r.peaks.map((p) => Math.round(p.strength * 100) / 100),
        },
      },
    };
  };
  const frames = Math.min(...onsets.map((o) => o.values.length));
  const envs = onsets.map((o) => Float32Array.from(o.values.slice(0, frames)));
  const sum = new Float32Array(frames);
  for (const env of envs) for (let i = 0; i < frames; i++) sum[i] += env[i];
  const song = describe(sum, null);
  const stems = {};
  for (let s = 0; s < onsets.length; s++) stems[names[s]] = describe(envs[s], song.raw).info;
  return { stems, song: song.info };
}

const api = { FPS, FFT_SIZE, OnsetEnvelope, prepare, estimateTempo, trackBeats, pickPeaks, analyse, mean, describeSong };
if (typeof window !== 'undefined') window.SSBeats = api;
if (typeof module !== 'undefined') module.exports = api;
})();

