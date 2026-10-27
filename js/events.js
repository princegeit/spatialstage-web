// Sound events: live detection of whooshes, risers, impacts and pads in a
// stem's own audio, and the motion each one sets off. One file for both rigs,
// the way beats.js is: the web app runs it from motion.js on the page's own
// analysers; the Pd rig's bridge/server.js runs it on the band levels Pd
// reports ("levels" + "bands" on 9002) and sends the result to the patch's
// event layer (spatial/event-layer) and distance stage (spatial/dist-cue).
// Change the numbers here and both rigs change together.
//
// Nothing is precomputed: every decision is made from the last couple of
// seconds of three live readings per stem, all env~ dB (100 = full scale):
//   level - the stem's own mono mix
//   hi    - the same through a 3 kHz high-pass (air, hiss, noise sweeps)
//   lo    - the same through a 200 Hz low-pass (body, kicks, sub)
// brightness = hi - level, so "airy" means relative to the stem itself.
//
// What counts as what (sensitivity scales every threshold):
//   impact - the level jumps 10+ dB inside ~150 ms
//   whoosh - the level swells fast (15+ dB/s) while the sound is airy
//   riser  - the level keeps climbing (3+ dB/s) for most of a second while
//            it gets brighter; it ends at the drop (level falls 6 dB off its
//            peak) or when it stops rising
//   pad    - steady (under 5 dB of movement) for two seconds
//
// What each one does (Override mode; Offset draws the same path around the
// stem's own spot, Modulate leaves the direction alone and changes the
// stem's preset motion speed and its distance instead):
//   whoosh - flies past the listener: in from far away on one side, close
//            by, out the other. Steady, accelerating or braking speed.
//   riser  - spirals in, faster and closer as it climbs; at the drop it
//            snaps to the front, close, then lets go
//   impact - bursts outward from where the stem is, with a small kick to
//            one side, then settles back
//   pad    - drifts slowly around the circle, a little further away
//
// Distance (1 = the stem's normal ring) becomes three cues, each optional:
// gain (closer = louder), a low-pass (further = duller) and Doppler (a delay
// of the distance over the speed of sound, so a fly-by bends in pitch).
// Doppler keeps the stem a few ms late even at rest, so it is off by default.
(function () {
  'use strict';

  const TYPES = ['whoosh', 'riser', 'impact', 'pad'];
  const TYPE_BIT = { whoosh: 1, riser: 2, impact: 4, pad: 8 };
  const CUE_BIT = { gain: 1, filter: 2, doppler: 4 };
  const PRIORITY = { pad: 0, impact: 1, whoosh: 2, riser: 3 };

  // Per-stem settings, kept with the stem's other spatial settings (setups,
  // presets, the bridge's spatialState). Same names, ranges and defaults on
  // both rigs.
  const DEFAULTS = {
    evOn: 0,        // 0 off, 1 on
    evTypes: 15,    // bits: 1 whoosh, 2 riser, 4 impact, 8 pad
    evMode: 0,      // 0 override, 1 offset, 2 modulate
    evAim: 0,       // 0 front->back, 1 back->front, 2 left->right, 3 right->left, 4 from the stem, 5 where the phone points
    evCurve: 1,     // 0 steady, 1 accelerate, 2 brake
    evSpeed: 1,     // 0.25..3
    evSense: 0.5,   // 0..1
    evCues: 3,      // bits: 1 gain, 2 filter, 4 doppler
    evRoom: 8,      // metres across, for Doppler
  };
  const INT = new Set(['evOn', 'evTypes', 'evMode', 'evAim', 'evCurve', 'evCues']);
  const PARAMS = {
    evOn: (v) => v === 0 || v === 1,
    evTypes: (v) => Number.isInteger(v) && v >= 0 && v <= 15,
    evMode: (v) => [0, 1, 2].includes(v),
    evAim: (v) => [0, 1, 2, 3, 4, 5].includes(v),
    evCurve: (v) => [0, 1, 2].includes(v),
    evSpeed: (v) => Number.isFinite(v) && v >= 0.25 && v <= 3,
    evSense: (v) => Number.isFinite(v) && v >= 0 && v <= 1,
    evCues: (v) => Number.isInteger(v) && v >= 0 && v <= 7,
    evRoom: (v) => Number.isFinite(v) && v >= 2 && v <= 40,
  };
  // A value as it should be stored, or undefined if it is not valid.
  function clean(param, value) {
    if (!PARAMS[param]) return undefined;
    let v = Number(value);
    if (INT.has(param)) v = Math.round(v);
    return PARAMS[param](v) ? v : undefined;
  }
  // Any object's ev* values made whole: valid ones kept, the rest default.
  function normalise(sp) {
    const out = {};
    for (const k in DEFAULTS) {
      const v = sp ? clean(k, sp[k]) : undefined;
      out[k] = v === undefined ? DEFAULTS[k] : v;
    }
    return out;
  }

  const DEG = Math.PI / 180;
  const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function blend2(a, b, m) {
    const x = (1 - m) * Math.cos(a * DEG) + m * Math.cos(b * DEG);
    const y = (1 - m) * Math.sin(a * DEG) + m * Math.sin(b * DEG);
    return (x === 0 && y === 0) ? a : Math.atan2(y, x) / DEG;
  }
  function mulberry32(a) {
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------- detection ---------------- */

  const GATE = 50;        // env~ dB: below -50 dBFS a stem is treated as silent
  const HIST_S = 2.5;     // seconds of readings kept

  class Detector {
    constructor() { this.reset(); }
    reset() {
      this.h = [];                 // { t, raw, fast, bright }
      this.fast = null; this.bright = null; this.brightSlow = null;
      this.lastFire = { whoosh: -1e9, impact: -1e9 };
      this.riser = null;           // { start, startLevel, peak, stallFor }
      this.riserCand = 0;
      this.pad = false; this.padCand = 0; this.padLost = 0;
      this.lastT = null;
      this.warmUntil = -1e9;       // no new events until then: the stream (re)started
      this.silentSince = null;
      this.pendingImpact = null;   // { t, level }: an impact that may turn out to be a swell (raw level at the hit)
    }

    // Least-squares slope (per second) of one field over the last `win` seconds.
    _slope(key, win) {
      const h = this.h, t1 = h[h.length - 1].t;
      let n = 0, st = 0, sv = 0, stt = 0, stv = 0;
      for (let i = h.length - 1; i >= 0 && h[i].t >= t1 - win; i--) {
        const t = h[i].t - t1, v = h[i][key];
        n++; st += t; sv += v; stt += t * t; stv += t * v;
      }
      const den = n * stt - st * st;
      return n < 3 || den <= 1e-9 ? 0 : (n * stv - st * sv) / den;
    }
    _range(key, win) {
      const h = this.h, t1 = h[h.length - 1].t;
      let lo = Infinity, hi = -Infinity;
      for (let i = h.length - 1; i >= 0 && h[i].t >= t1 - win; i--) { lo = Math.min(lo, h[i][key]); hi = Math.max(hi, h[i][key]); }
      return { lo, hi, span: hi - lo };
    }
    _span() { return this.h.length ? this.h[this.h.length - 1].t - this.h[0].t : 0; }

    // One reading. t: seconds (any monotonic clock); level, hi, lo: env~ dB.
    // sense 0..1; types: the evTypes bits. Returns what happened at this reading:
    // { fire: null | { type, strength, rate }, riser: null | { progress }, riserEnd, pad, level, bright }
    push(t, level, hi, lo, sense, types) {
      // A gap in the readings (stopped, paused, a new song) or digital silence: start over, and
      // let the first 0.3 s of sound through without firing - the analysis window filling up
      // from nothing looks like a hit, and the start of a song is not one.
      if (this.lastT !== null && t - this.lastT > 0.5) this.reset();
      if (level < 20) {
        // Digital silence: nothing to measure. A riser that was playing ends here.
        const ended = !!this.riser;
        this.reset();
        this.silentSince = t; this.lastT = t;
        return { fire: null, riser: null, riserEnd: ended, pad: false, level, bright: -60 };
      }
      if (this.silentSince !== null || this.lastT === null) { this.silentSince = null; this.warmUntil = t + 0.3; }
      const dt = this.lastT === null ? 0.05 : clamp(t - this.lastT, 0.001, 0.5);
      this.lastT = t;
      const warming = t < this.warmUntil;
      const k = 1.6 - 1.2 * clamp(sense, 0, 1);       // threshold scale: 1.6 strict .. 0.4 eager
      const on = level > GATE;
      const bright = on ? clamp((hi || 0) - level, -60, 0) : -60;
      const ema = (prev, v, tau) => (prev === null ? v : prev + (1 - Math.exp(-dt / tau)) * (v - prev));
      this.fast = ema(this.fast, level, 0.06);
      this.bright = ema(this.bright, bright, 0.1);
      this.brightSlow = ema(this.brightSlow, bright, 2.0);
      this.h.push({ t, raw: level, fast: this.fast, bright: this.bright });
      while (this.h.length && this.h[0].t < t - HIST_S) this.h.shift();

      const out = { fire: null, riser: null, riserEnd: false, pad: this.pad, level, bright: this.bright };
      if (this.h.length < 3) return out;

      // --- riser: a sustained climb that gets brighter, until the drop ---
      if (this.riser) {
        const r = this.riser;
        r.peak = Math.max(r.peak, this.fast);
        const elapsed = t - r.start;
        const recent = this._slope('fast', 0.6);
        r.stallFor = this._slope('fast', 1.2) < 0.5 ? r.stallFor + dt : 0;
        const dropped = this.fast < r.peak - 6 || recent < -4 * k || !on;
        if (dropped || r.stallFor > 1.0 || elapsed > 20 || !(types & TYPE_BIT.riser)) {
          this.riser = null;
          out.riserEnd = true;
        } else {
          out.riser = { progress: clamp(Math.max((this.fast - r.startLevel) / 18, elapsed / 10), 0, 1) };
        }
      } else if ((types & TYPE_BIT.riser) && on && this._span() > 1.2) {
        const climb = this._slope('fast', 1.5);
        const lately = this._slope('fast', 0.5);
        const brighter = this._slope('bright', 1.5);
        const rising = climb >= 3 * k && lately >= 0 && (brighter >= 1 * k || climb >= 6 * k);
        this.riserCand = rising ? this.riserCand + dt : 0;
        if (this.riserCand >= 0.75 && !warming) {
          // Where the climb began, from its slope: progress is measured from there.
          this.riser = { start: t, startLevel: this.fast - climb * this.riserCand, peak: this.fast, stallFor: 0 };
          this.riserCand = 0;
          out.riser = { progress: 0 };
          out.fire = { type: 'riser', strength: clamp(climb / (8 * k), 0.3, 1), rate: climb };
        }
      }

      // --- a swell that began like a hit: it is a whoosh after all ---
      const pi = this.pendingImpact;
      if (pi && t - pi.t > 0.35) this.pendingImpact = null;
      else if (pi && !out.fire && (types & TYPE_BIT.whoosh) && level > pi.level + 4 && this._slope('raw', 0.2) > 10 * k) {
        this.pendingImpact = null;
        this.lastFire.whoosh = t;
        out.fire = { type: 'whoosh', strength: clamp(this._slope('fast', 0.4) / (30 * k), 0.3, 1), rate: this._slope('fast', 0.4) };
      }

      // --- impact: a sudden jump ---
      if (!out.fire && !warming && (types & TYPE_BIT.impact) && level > GATE + 5 && t - this.lastFire.impact > 0.25) {
        let floor = Infinity;
        for (let i = this.h.length - 2; i >= 0 && this.h[i].t >= t - 0.16; i--) floor = Math.min(floor, this.h[i].raw);
        const jump = level - floor;
        if (Number.isFinite(jump) && jump >= 10 * k) {
          this.lastFire.impact = t;
          this.pendingImpact = { t, level };
          out.fire = { type: 'impact', strength: clamp(0.4 + (jump - 10 * k) / 15, 0.3, 1), rate: jump };
        }
      }

      // --- whoosh: a fast airy swell ---
      if (!out.fire && !warming && !this.riser && (types & TYPE_BIT.whoosh) && level > GATE + 3 &&
          t - this.lastFire.whoosh > 0.9 && t - this.lastFire.impact > 0.15) {
        const swell = this._slope('fast', 0.4);
        const airy = this.bright >= this.brightSlow + 2 * k || this.bright > -10;
        if (swell >= 15 * k && airy) {
          this.lastFire.whoosh = t;
          out.fire = { type: 'whoosh', strength: clamp(swell / (30 * k), 0.3, 1), rate: swell };
        }
      }

      // --- pad: steady for two seconds ---
      if (types & TYPE_BIT.pad) {
        const steady = level > GATE + 5 && this._span() > 1.9 && !this.riser &&
          Math.abs(this._slope('fast', 2)) < 1.5 && this._range('fast', 2).span < 5;
        if (!this.pad) {
          this.padCand = steady ? this.padCand + dt : 0;
          if (this.padCand >= 2) { this.pad = true; this.padLost = 0; }
        } else {
          this.padLost = steady ? 0 : this.padLost + dt;
          if (this.padLost > 0.6) { this.pad = false; this.padCand = 0; }
        }
      } else this.pad = false;
      out.pad = this.pad;
      return out;
    }
  }

  /* ---------------- motion ---------------- */

  const FAR = 2.4;        // where a fly-by starts and ends (1 = the stem's ring)
  const PASS = 0.4;       // how close it passes
  const ATTACK_S = 0.12, RELEASE_S = 0.45, XFADE_S = 0.15;

  // Distance cues: { gain, cutoff (Hz), delayMs } for a distance, by the
  // stem's evCues bits. At distance 1 they are unity, 20 kHz and the Doppler
  // rest delay (only when Doppler is on).
  const MIN_DIST = 0.3;
  function cues(dist, p) {
    const d = Math.max(MIN_DIST, dist);
    const bits = p.evCues | 0;
    const gain = (bits & CUE_BIT.gain) ? clamp(Math.pow(d, -0.9), 0.15, 1.6) : 1;
    const cutoff = (bits & CUE_BIT.filter) && d > 1 ? clamp(20000 * Math.pow(d, -2.4), 500, 20000) : 20000;
    // 1 = half the room: a fly-by from FAR is FAR * room/2 metres away.
    const delayMs = (bits & CUE_BIT.doppler) ? (d - MIN_DIST) * (p.evRoom / 2) / 343 * 1000 : 0;
    return { gain, cutoff, delayMs };
  }

  const ease = (curve, x) => (curve === 1 ? x * x : curve === 2 ? 1 - (1 - x) * (1 - x) : x);

  // The direction a path is drawn from, by evAim: fixed directions, the stem
  // itself, or the phone. In Offset mode paths start at the stem's own spot.
  function frameOf(p, stemAz, phoneAz) {
    if (p.evMode === 1) return p.evAim === 5 ? phoneAz : stemAz;
    return [0, 180, -90, 90, stemAz, phoneAz][p.evAim] ?? 0;
  }
  // Which way round: front->back and left->right pass on the right / turn clockwise.
  const sideOf = (p) => ([1, 3].includes(p.evAim) ? -1 : 1);

  class EventLayer {
    constructor(seed) {
      this.det = new Detector();
      this.rnd = mulberry32((seed | 0) * 7919 + 17);
      this.beh = null;          // the behaviour playing
      this.w = 0;               // how much of it is heard, 0..1
      this.prevAz = null; this.xfade = 1;
      this.evAz = 0; this.evDist = 1; this.rate = 1;
      this.label = ''; this.flashAt = -1e9; this.lastType = null;
      this.level = 0; this.bright = -60;
      this.clock = 0;
    }

    reset() {
      this.det.reset(); this.beh = null; this.w = 0; this.prevAz = null; this.label = '';
    }

    // Start a behaviour now (from the detector, or the panel's test buttons).
    fire(type, strength, ctx, manual) {
      if (!TYPE_BIT[type]) return;
      const cur = this.beh;
      if (!manual && cur && !cur.ending && PRIORITY[cur.type] > PRIORITY[type]) return;
      const p = ctx.p;
      if (this.w > 0.01) { this.prevAz = this.evAz; this.xfade = 0; } else { this.prevAz = null; this.xfade = 1; }
      const frame = frameOf(p, ctx.stemAz, ctx.phoneAz);
      const side = sideOf(p) * (type === 'impact' && p.evAim >= 4 ? (this.rnd() < 0.5 ? -1 : 1) : 1);
      const s = clamp(strength || 0.7, 0.2, 1);
      const b = { type, t: 0, strength: s, frame, side, manual: !!manual, ending: false, progress: 0 };
      if (type === 'whoosh') b.dur = 1.4 / p.evSpeed / (0.6 + 0.8 * s);
      if (type === 'impact') { b.dur = 1.4; b.anchor = p.evAim === 5 ? ctx.phoneAz : ctx.stemAz; }
      if (type === 'riser') { b.phi = frame; b.r = 1.6; }
      if (type === 'pad') { b.anchor = ctx.stemAz; }
      this.beh = b;
      this.lastType = type;
      this.flashAt = this.clock;
    }

    // One motion tick. ctx: { p (the stem's settings), stemAz (absolute
    // direction before events), phoneAz (absolute), frame: null | { t, level,
    // hi, lo } (a NEW reading, or null if none since last tick), active (armed
    // and evOn) }. Returns { az, dist, w, rate, cues, label, type, level, bright }.
    tick(dt, ctx) {
      this.clock += dt;
      const p = ctx.p;
      const live = ctx.active && p.evOn === 1;
      if (ctx.frame && live) {
        const f = ctx.frame;
        const d = this.det.push(f.t, f.level, f.hi, f.lo, p.evSense, p.evTypes);
        this.level = d.level; this.bright = d.bright;
        if (d.fire) this.fire(d.fire.type, d.fire.strength, ctx, false);
        const b = this.beh;
        if (b && b.type === 'riser' && !b.manual) {
          if (d.riser) b.progress = d.riser.progress;
          if (d.riserEnd && !b.ending) this._endRiser(b);
        }
        if (d.pad && (!b || b.ending) && (p.evTypes & TYPE_BIT.pad)) this.fire('pad', 0.6, ctx, false);
        if (!d.pad && b && b.type === 'pad' && !b.ending) b.ending = true;
      } else if (ctx.frame) {
        this.level = ctx.frame.level;
      }
      if (!live && this.beh && !this.beh.manual) this.beh.ending = true;

      // --- the behaviour itself ---
      const b = this.beh;
      let rateTarget = 1;
      if (b) {
        b.t += dt;
        const r = this._step(b, dt, p);
        this.evAz = r.az; this.evDist = r.dist; rateTarget = r.rate;
        if (b.t >= (b.dur || Infinity)) b.ending = true;
      }
      const target = b && !b.ending ? 1 : 0;
      const tau = target > this.w ? ATTACK_S : RELEASE_S;
      this.w += (target - this.w) * (1 - Math.exp(-dt / (tau / 3)));
      if (target === 0 && this.w < 0.003) { this.w = 0; this.beh = null; this.prevAz = null; }
      if (this.xfade < 1) this.xfade = Math.min(1, this.xfade + dt / XFADE_S);

      // --- into the stem's own motion ---
      const w = this.w;
      let evAz = this.evAz;
      if (this.prevAz !== null && this.xfade < 1) evAz = blend2(this.prevAz, evAz, this.xfade);
      // target/offset are the same result in the form Pd's spatial/event-layer takes it:
      // out = blend(in + offset, target, mix), with mix = w in Override and 0 otherwise.
      let az = ctx.stemAz, offset = 0, mix = 0;
      if (w > 0) {
        if (p.evMode === 0) { az = blend2(ctx.stemAz, evAz, w); mix = w; }
        else if (p.evMode === 1) { offset = wrap180(evAz - (b ? b.frame : evAz)) * w; az = ctx.stemAz + offset; }
      }
      const dist = 1 + w * (this.evDist - 1);
      this.rate = 1 + w * (rateTarget - 1);
      this.label = b && w > 0.05 ? (b.type === 'riser' && !b.ending ? 'riser ' + Math.round(b.progress * 100) + '%' : b.type) : '';
      return {
        az: wrap180(az), dist, w, rate: this.rate, cues: cues(dist, p), label: this.label,
        target: wrap180(evAz), offset, mix,
        type: b ? b.type : null, flash: this.clock - this.flashAt < 0.4, level: this.level, bright: this.bright,
      };
    }

    _endRiser(b) {
      b.ending = false; b.type = 'riser'; b.peakAt = b.t; b.dur = b.t + 0.7;
      b.snapFrom = b.phi; b.snapR = b.r; b.peaking = true;
    }

    // Where the behaviour is now: { az (absolute), dist, rate (Modulate) }.
    _step(b, dt, p) {
      const sp = p.evSpeed;
      if (b.type === 'whoosh') {
        const u = ease(p.evCurve, clamp(b.t / b.dur, 0, 1));
        const th = b.frame * DEG, s = b.side;
        const dx = Math.sin(th), dy = Math.cos(th), px = Math.cos(th) * s, py = -Math.sin(th) * s;
        const x = (FAR * (1 - 2 * u)) * dx + PASS * px, y = (FAR * (1 - 2 * u)) * dy + PASS * py;
        return { az: Math.atan2(x, y) / DEG, dist: Math.hypot(x, y), rate: 1 + 3 * sp * b.strength * Math.sin(Math.PI * u) };
      }
      if (b.type === 'riser') {
        if (b.manual && !b.peaking) {
          b.progress = clamp(b.t / 3, 0, 1);
          if (b.t >= 3) this._endRiser(b);
        }
        if (b.peaking) {
          // At the drop: snap to the front (or the aim), close, then let go.
          const x = clamp((b.t - b.peakAt) / 0.15, 0, 1);
          const centre = p.evMode === 0 && p.evAim <= 3 ? 0 : b.frame;
          return { az: blend2(b.snapFrom, centre, x), dist: b.snapR + (0.5 - b.snapR) * x, rate: 1 };
        }
        const pr = b.progress;
        b.phi += b.side * (60 + 420 * pr * pr) * sp * dt;
        b.r = 1.6 - 1.0 * pr;
        return { az: b.phi, dist: b.r, rate: 1 + 5 * sp * pr * pr };
      }
      if (b.type === 'impact') {
        const t = b.t, s = b.strength;
        const kick = b.side * 50 * s * (1 - Math.exp(-t / 0.03)) * Math.exp(-t / 0.45);
        const dist = 1 - 0.5 * Math.exp(-t / 0.06) + 0.9 * s * (1 - Math.exp(-t / 0.06)) * Math.exp(-t / 0.5);
        return { az: b.anchor + kick, dist, rate: 1 + 3 * s * Math.exp(-t / 0.3) };
      }
      // pad
      return { az: b.anchor + b.side * 12 * sp * b.t, dist: 1.3, rate: 0.5 };
    }
  }

  const api = { TYPES, TYPE_BIT, CUE_BIT, DEFAULTS, PARAMS, clean, normalise, cues, Detector, EventLayer, GATE };
  if (typeof window !== 'undefined') window.SSEvents = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
