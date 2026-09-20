// Motion: the control-rate port of pd/spatial/stem-control.pd and the four
// abstractions it composes (fft-source, preset-source, tempo-source,
// blend-mixer, plus smooth-azimuth). One StemMotion per stem, all ticked at
// 40 Hz (Pd's metro 25) by the Motion scheduler, each producing the final
// azimuth offset that the engine adds on top of the stem's fixed base.
//
// Signal flow per stem, exactly as generate_stem_control.py documents it:
//   phone ─┐
//   fft   ─┼─ blend-mixer ─ smooth(k) ─ arm gate ─ (+ base) ─ wrap ─> engine
//   preset─┘
// Every numeric mapping (pitch range, onset scale, band dB window, circle/
// sine shapes, vector-space blending) is copied from the generators rather
// than re-derived, so a saved preset means the same thing on both rigs.
(function () {
  const TICK_MS = 25;
  const DEG = Math.PI / 180;
  const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180;

  // smooth-azimuth.pd: first-order lerp on the unit vector, so a target
  // crossing +-180 glides the short way. k=1 is instant.
  class SmoothAzimuth {
    constructor(k) { this.k = k; this.x = 1; this.y = 0; }
    tick(targetDeg) {
      const tx = Math.cos(targetDeg * DEG), ty = Math.sin(targetDeg * DEG);
      this.x += this.k * (tx - this.x);
      this.y += this.k * (ty - this.y);
      return Math.atan2(this.y, this.x) / DEG;
    }
    snap(deg) { this.x = Math.cos(deg * DEG); this.y = Math.sin(deg * DEG); }
  }

  // blend-mixer.pd
  function blend2(a, b, m) {
    const x = (1 - m) * Math.cos(a * DEG) + m * Math.cos(b * DEG);
    const y = (1 - m) * Math.sin(a * DEG) + m * Math.sin(b * DEG);
    return Math.atan2(y, x) / DEG;
  }
  function blend3(a, b, c, w1, w2, w3) {
    const x = w1 * Math.cos(a * DEG) + w2 * Math.cos(b * DEG) + w3 * Math.cos(c * DEG);
    const y = w1 * Math.sin(a * DEG) + w2 * Math.sin(b * DEG) + w3 * Math.sin(c * DEG);
    return Math.atan2(y, x) / DEG;
  }

  // tempo-source.pd's MIDI clock branch, shared by every stem the way the
  // Pd rig shares one [midirealtimein]: 24 ticks per quarter, BPM measured
  // per full quarter to average out per-tick jitter, 20-300 sanity window.
  const midiClock = { bpm: null, ticks: 0, lastQuarterAt: 0, available: false, started: false };
  function startMidiClock() {
    if (midiClock.started) return;
    midiClock.started = true;
    if (!navigator.requestMIDIAccess) return;
    navigator.requestMIDIAccess().then((access) => {
      midiClock.available = true;
      const bind = (input) => {
        input.onmidimessage = (e) => {
          if (e.data[0] !== 0xF8) return;
          midiClock.ticks = (midiClock.ticks + 1) % 24;
          if (midiClock.ticks !== 0) return;
          const now = performance.now();
          if (midiClock.lastQuarterAt) {
            const bpm = 60000 / (now - midiClock.lastQuarterAt + 0.0001);
            if (bpm > 20 && bpm < 300) midiClock.bpm = bpm;
          }
          midiClock.lastQuarterAt = now;
        };
      };
      access.inputs.forEach(bind);
      access.onstatechange = (e) => { if (e.port.type === 'input' && e.port.state === 'connected') bind(e.port); };
    }).catch(() => {});
  }

  class StemMotion {
    constructor(stem, index) {
      this.stem = stem; this.index = index;
      // Same fields, same defaults, as bridge/server.js's spatialState and
      // the UI's spatial{} mirror - a preset file round-trips unchanged.
      this.params = {
        fftMode: 0, presetMode: 0, presetRate: 0.05, blendMode: 0,
        blendWeights2: [0, 0], blendWeights3: [0.333, 0.333, 0.334],
        tempoSource: 0, tempoBpm: 120, base: 0, fftSrc: index, smoothing: 1,
      };
      this.phone = 0;          // degrees, relative to the stem's base (the UI's "rotate")
      this.armed = true;
      this.presetPhase = 0;    // phasor~ 0..1
      this.presetBeats = 1; this.sineCenter = 0; this.sineWidth = 180;
      this.finalSmooth = new SmoothAzimuth(1);
      this.pitchSmooth = new SmoothAzimuth(0.15);
      this.bandSmooth = new SmoothAzimuth(0.15);
      this.pitchHist = [60, 60, 60];
      this.fftAz = 0; this.onsetAz = 0;
      this.onsetAvg = 0; this.lastOnsetAt = 0;
      this.tickCount = 0;
      this.out = 0;            // last output offset (degrees, pre-base)
      this.effective = 0;      // absolute azimuth sent to the engine
    }

    set(param, value) {
      if (Array.isArray(value)) this.params[param] = value.slice();
      else this.params[param] = value;
      if (param === 'smoothing') this.finalSmooth.k = Math.max(0.01, Math.min(1, value));
    }

    // Does anything downstream of the FFT branch actually reach the
    // output? If not, skip the analysis - pitch tracking in particular is
    // the one expensive thing here.
    fftContributes() {
      const p = this.params;
      return p.blendMode >= 0.5 ? p.blendWeights3[1] > 0 : p.blendWeights2[0] > 0;
    }

    tick(dt, engine, geometryBase, motion) {
      const p = this.params;
      this.tickCount++;

      // --- tempo-source ---
      let bpm = p.tempoBpm;
      if (p.tempoSource === 1 && midiClock.bpm) bpm = midiClock.bpm;
      // source 2 (Link) is a stub on both rigs: falls back to manual.

      // --- preset-source ---
      const rate = p.presetMode >= 1.5 ? (bpm / 60) / this.presetBeats : p.presetRate;
      this.presetPhase = (this.presetPhase + rate * dt) % 1;
      let presetAz;
      if (p.presetMode >= 0.5 && p.presetMode < 1.5) {
        presetAz = this.sineCenter + (this.sineWidth / 2) * Math.sin(2 * Math.PI * this.presetPhase);
      } else {
        presetAz = (this.presetPhase - 0.5) * 360;
      }

      // --- fft-source (analysing whichever stem fftSrc points at) ---
      if (this.fftContributes() && engine.ctx) {
        const srcStem = engine.stems[p.fftSrc] || this.stem;
        const nodes = engine.nodes[srcStem];
        if (p.fftMode < 0.5) {
          if (this.tickCount % 2 === 0) this._pitchTick(nodes.analyser, engine.ctx.sampleRate);
          // pitchSmooth ticks at 40 Hz on the held median value
          this.fftAz = this.pitchSmooth.tick(this.pitchTarget || 0);
        } else if (p.fftMode < 1.5) {
          this._onsetTick(nodes.analyser);
          this.fftAz = this.onsetAz;
        } else if (p.fftMode < 2.5) {
          this.fftAz = this.bandSmooth.tick(this._bandLevel(nodes.bandAnalyser));
        } else {
          const env = engine.song && engine.song.envelopes[srcStem];
          if (env && engine.song.duration > 0) {
            const idx = Math.min(env.length - 1, Math.max(0, Math.floor(engine.position() / engine.song.duration * env.length)));
            this.fftAz = Math.min(1, Math.max(0, env[idx])) * 360 - 180;
          }
        }
      }

      // --- blend-mixer ---
      let blended;
      if (p.blendMode >= 0.5) {
        const [w1, w2, w3] = p.blendWeights3;
        blended = blend3(this.phone, this.fftAz, presetAz, w1, w2, w3);
      } else {
        const [ts1, ts2] = p.blendWeights2;
        blended = blend2(blend2(this.phone, this.fftAz, ts1), presetAz, ts2);
      }
      if (!isFinite(blended)) blended = this.phone;

      // --- final smoothing, then the arm gate ---
      // An unarmed stem parks at true centre (0 deg, straight ahead) rather
      // than at its base azimuth as the Pd rig does: on this rig "not armed"
      // reads as "out of the picture", and the smoother is reset so re-arming
      // glides from centre rather than jumping.
      const smoothed = this.finalSmooth.tick(blended);
      if (this.armed) {
        this.out = wrap180(smoothed + p.base);
        this.effective = wrap180(geometryBase + this.out);
      } else {
        this.finalSmooth.snap(0);
        this.out = wrap180(-geometryBase);
        this.effective = 0;
      }
      engine.setAzimuth(this.stem, this.effective);
    }

    // sigmund~ pitch stand-in: normalized autocorrelation over 1024 samples,
    // lags limited to MIDI 36..84 (65 Hz - 1 kHz), which is the only range
    // the mapping uses anyway. Median-of-3 then clamp, as in the patch.
    _pitchTick(analyser, sr) {
      if (!this._buf) this._buf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(this._buf);
      const b = this._buf, N = 1024;
      let energy = 0;
      for (let i = 0; i < N; i++) energy += b[i] * b[i];
      if (energy / N < 1e-5) return; // silence: sigmund~ reports no pitch; moses drops it
      const minLag = Math.floor(sr / 1046.5), maxLag = Math.min(Math.ceil(sr / 65.4), analyser.fftSize - N);
      let best = -1, bestLag = 0;
      for (let lag = minLag; lag <= maxLag; lag++) {
        let c = 0;
        for (let i = 0; i < N; i++) c += b[i] * b[i + lag];
        if (c > best) { best = c; bestLag = lag; }
      }
      if (best / energy < 0.3) return; // no clear periodicity
      const midi = 69 + 12 * Math.log2((sr / bestLag) / 440);
      const clamped = Math.min(84, Math.max(36, midi));
      this.pitchHist.push(clamped); this.pitchHist.shift();
      const [a, c, d] = this.pitchHist;
      const med = Math.max(Math.min(a, c), Math.min(Math.max(a, c), d));
      this.pitchTarget = (med - 36) / (84 - 36) * 360 - 180;
    }

    // bonk~ stand-in: an RMS jump against a slow running average counts as
    // a hit; its "velocity" (0-100, dB-ish) becomes an azimuth that holds
    // until the next hit. Formula from generate_fft_source.py.
    _onsetTick(analyser) {
      if (!this._buf) this._buf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(this._buf);
      const b = this._buf;
      let e = 0;
      for (let i = 0; i < 512; i++) e += b[i] * b[i];
      const rms = Math.sqrt(e / 512);
      const now = performance.now();
      const avg = this.onsetAvg;
      this.onsetAvg = avg + 0.08 * (rms - avg);
      if (rms > 0.02 && rms > avg * 1.8 && now - this.lastOnsetAt > 100) {
        this.lastOnsetAt = now;
        const vel = Math.max(0, Math.min(100, 100 + 20 * Math.log10(rms + 1e-9)));
        this.onsetAz = ((vel * 3.7) % 360) - 180;
      }
    }

    // bp~ 1000 4 -> env~ : env~ reports dB with 100 = full-scale RMS.
    _bandLevel(analyser) {
      if (!this._bbuf) this._bbuf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(this._bbuf);
      const b = this._bbuf;
      let e = 0;
      for (let i = 0; i < b.length; i++) e += b[i] * b[i];
      const db = 100 + 20 * Math.log10(Math.sqrt(e / b.length) + 1e-9);
      return (Math.min(100, Math.max(40, db)) - 40) / 60 * 360 - 180;
    }
  }

  class Motion {
    constructor(engine) {
      this.engine = engine;
      this.stems = {};
      engine.stems.forEach((s, i) => { this.stems[s] = new StemMotion(s, i); });
      this.timer = null; this.lastAt = 0;
      this.onTick = null;
    }
    start() {
      if (this.timer) return;
      this.lastAt = performance.now();
      this.timer = setInterval(() => this._tick(), TICK_MS);
    }
    _tick() {
      const now = performance.now();
      const dt = Math.min(0.25, (now - this.lastAt) / 1000);
      this.lastAt = now;
      for (const s of this.engine.stems) {
        this.stems[s].tick(dt, this.engine, this.engine.geometry[s].azimuth, this);
      }
      if (this.onTick) this.onTick();
    }
    setPhone(stem, rotateDeg) { this.stems[stem].phone = rotateDeg; }
    setArmed(stem, on) { this.stems[stem].armed = !!on; }
    setParam(stem, param, value) {
      this.stems[stem].set(param, value);
      if (param === 'tempoSource' && value === 1) startMidiClock();
    }
    snapshot() {
      const o = {};
      for (const s in this.stems) o[s] = JSON.parse(JSON.stringify(this.stems[s].params));
      return o;
    }
    restore(snap) {
      for (const s in snap) if (this.stems[s]) for (const k in snap[s]) this.setParam(s, k, snap[s][k]);
    }
    get midiClock() { return midiClock; }
  }

  window.SSMotion = Motion;
})();
