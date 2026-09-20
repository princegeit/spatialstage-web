// Audio engine: the Web Audio port of pd/binaural_pan_live_v1.pd's signal
// path. Everything here is per-stem graph plumbing and transport; azimuth
// *decisions* (phone/fft/preset blending) live in motion.js and arrive
// through setAzimuth().
//
// Panner math is a 1:1 port of pd/stem_spatializer.pd, wrapped the way
// pd/stem_spatializer_stereo.pd wraps it: each stem's own L and R channels
// get their own panner chain, anchored half a width either side of the
// stem's azimuth, so the recorded stereo image rotates as a whole instead
// of collapsing to a point. Per chain, with s = sin(angle):
//   constant-power gains  gL = cos(t), gR = sin(t), t = (pi/2) * (s+1)/2
//   inter-aural delay     dL = 5 + 0.3*s ms, dR = 5 - 0.3*s ms
// The 5 ms base delay is Pd's delread~ minimum-latency offset; only the
// +-0.3 ms difference is audible. An optional 'hrtf' mode swaps that for a
// PannerNode with panningModel 'HRTF' - a real head-related response the
// Pd rig never had live (it only used the KEMAR set offline, in
// pipeline/binaural_render.py).
(function () {
  const BASE_DELAY_S = 0.005;
  const ITD_S = 0.0003;
  const RAMP_TAU = 0.012;   // setTargetAtTime time constant; ~40 ms to settle, no clicks at 40 Hz updates
  const BRANCH_GAIN = 0.5;  // stereo build's per-branch gain, matches level with the mono build
  const ENV_FRAME = 2048, ENV_HOP = 512, ENV_POINTS = 1000; // precompute_fft_envelope.py

  const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180;

  class Engine {
    constructor(stems, geometry) {
      this.stems = stems;
      this.geometry = geometry;            // { stem: { azimuth, width } }
      this.ctx = null;
      this.nodes = {};                     // per-stem graph
      this.panMode = 'pd';                 // 'pd' | 'hrtf'
      this.volume = {}; this.muted = {};
      for (const s of stems) { this.volume[s] = 1; this.muted[s] = false; }
      this.masterVolume = 0.4;
      this.song = null;                    // { name, buffers: {stem: AudioBuffer}, duration, envelopes: {stem: Float32Array} }
      this.sources = null;
      this.playing = false;
      this.offset = 0; this.startedAt = 0;
      this.onEnded = null;
      this.onStateChange = null;
      this.recorder = null;
      this.azimuth = {};
      for (const s of stems) this.azimuth[s] = geometry[s].azimuth;
    }

    // The AudioContext must be created/resumed from a user gesture on every
    // mobile browser, so this is called from a tap handler, not at load.
    async ensure() {
      if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return this.ctx; }
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.masterVolume;
      this.master.connect(ctx.destination);
      for (const s of this.stems) this.nodes[s] = this._buildStem(s);
      if (ctx.state !== 'running') await ctx.resume();
      return ctx;
    }

    _buildStem(stem) {
      const ctx = this.ctx;
      const n = { input: ctx.createGain(), split: ctx.createChannelSplitter(2), out: ctx.createGain(), chains: [] };
      n.input.channelCount = 2; n.input.channelCountMode = 'explicit';
      n.input.connect(n.split);
      // Level: BRANCH_GAIN * volume * (muted ? 0 : 1), ramped like Pd's line~ 20 ms.
      n.out.gain.value = BRANCH_GAIN;
      n.out.connect(this.master);

      // Analysis taps for motion.js's fft-source port: a mono sum of the
      // stem (Pd downmixes each stem before fft-source too), one wideband
      // time-domain analyser for pitch/onset, one bandpassed analyser for
      // the band-energy mode (bp~ 1000 4 -> env~).
      n.mono = ctx.createGain(); n.mono.channelCount = 1; n.mono.channelCountMode = 'explicit';
      n.input.connect(n.mono);
      n.analyser = ctx.createAnalyser(); n.analyser.fftSize = 2048; n.analyser.smoothingTimeConstant = 0;
      n.mono.connect(n.analyser);
      n.bp = ctx.createBiquadFilter(); n.bp.type = 'bandpass'; n.bp.frequency.value = 1000; n.bp.Q.value = 4;
      n.bandAnalyser = ctx.createAnalyser(); n.bandAnalyser.fftSize = 1024; n.bandAnalyser.smoothingTimeConstant = 0;
      n.mono.connect(n.bp); n.bp.connect(n.bandAnalyser);

      const merger = ctx.createChannelMerger(2);
      merger.connect(n.out);
      for (let c = 0; c < 2; c++) {
        const ch = {};
        // --- Pd-match chain: two delays + two gains ---
        ch.dL = ctx.createDelay(0.05); ch.dR = ctx.createDelay(0.05);
        ch.gL = ctx.createGain(); ch.gR = ctx.createGain();
        ch.dL.delayTime.value = BASE_DELAY_S; ch.dR.delayTime.value = BASE_DELAY_S;
        ch.pdIn = ctx.createGain();
        ch.pdIn.connect(ch.dL); ch.pdIn.connect(ch.dR);
        ch.dL.connect(ch.gL); ch.dR.connect(ch.gR);
        ch.gL.connect(merger, 0, 0); ch.gR.connect(merger, 0, 1);
        // --- HRTF chain ---
        ch.hrtfIn = ctx.createGain();
        ch.panner = ctx.createPanner();
        ch.panner.panningModel = 'HRTF'; ch.panner.distanceModel = 'inverse';
        ch.panner.refDistance = 1; ch.panner.rolloffFactor = 0;
        ch.hrtfIn.connect(ch.panner); ch.panner.connect(n.out);
        // Mode select is just which input gain is open.
        ch.pdIn.gain.value = this.panMode === 'pd' ? 1 : 0;
        ch.hrtfIn.gain.value = this.panMode === 'hrtf' ? 1 : 0;
        n.split.connect(ch.pdIn, c); n.split.connect(ch.hrtfIn, c);
        n.chains.push(ch);
      }
      this.nodes[stem] = n;
      this._applyAzimuth(stem, this.azimuth[stem], true);
      this._applyLevel(stem, true);
      return n;
    }

    setPanMode(mode) {
      this.panMode = mode;
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      for (const s of this.stems) for (const ch of this.nodes[s].chains) {
        ch.pdIn.gain.setTargetAtTime(mode === 'pd' ? 1 : 0, t, 0.02);
        ch.hrtfIn.gain.setTargetAtTime(mode === 'hrtf' ? 1 : 0, t, 0.02);
      }
    }

    // Absolute azimuth in degrees, 0 = front, +90 = right, +-180 = behind.
    setAzimuth(stem, deg) {
      const a = wrap180(deg);
      // motion.js calls this every tick for every stem; skip the automation
      // scheduling when nothing moved.
      if (Math.abs(a - this.azimuth[stem]) < 0.01 && this.nodes[stem]) return;
      this.azimuth[stem] = a;
      if (this.ctx) this._applyAzimuth(stem, a, false);
    }

    _applyAzimuth(stem, deg, immediate) {
      const n = this.nodes[stem];
      const w = this.geometry[stem].width || 0;
      const t = this.ctx.currentTime;
      for (let c = 0; c < 2; c++) {
        const angle = deg + (c === 0 ? -w / 2 : w / 2);
        const rad = angle * Math.PI / 180;
        const s = Math.sin(rad);
        const theta = (s * 0.5 + 0.5) * Math.PI / 2;
        const ch = n.chains[c];
        const set = (param, v) => immediate ? (param.value = v) : param.setTargetAtTime(v, t, RAMP_TAU);
        set(ch.gL.gain, Math.cos(theta));
        set(ch.gR.gain, Math.sin(theta));
        set(ch.dL.delayTime, BASE_DELAY_S + ITD_S * s);
        set(ch.dR.delayTime, BASE_DELAY_S - ITD_S * s);
        // Listener faces -Z in Web Audio; our 0 deg is straight ahead.
        const px = Math.sin(rad), pz = -Math.cos(rad);
        if (ch.panner.positionX) { set(ch.panner.positionX, px); set(ch.panner.positionZ, pz); }
        else ch.panner.setPosition(px, 0, pz);
      }
    }

    // 0..1 meter value for the UI: RMS of the last 512 samples of the stem's
    // own (pre-fader) audio on a -60..0 dB scale.
    levelOf(stem) {
      const n = this.nodes[stem];
      if (!n || !this.playing) return 0;
      if (!this._meterBuf) this._meterBuf = new Float32Array(n.analyser.fftSize);
      n.analyser.getFloatTimeDomainData(this._meterBuf);
      let e = 0;
      for (let i = 0; i < 512; i++) e += this._meterBuf[i] * this._meterBuf[i];
      const db = 20 * Math.log10(Math.sqrt(e / 512) + 1e-9);
      const v = (db + 60) / 60;
      return Math.max(0, Math.min(1, v)) * (this.muted[stem] ? 0 : this.volume[stem]);
    }

    setVolume(stem, v) { this.volume[stem] = v; if (this.ctx) this._applyLevel(stem, false); }
    setMuted(stem, m) { this.muted[stem] = !!m; if (this.ctx) this._applyLevel(stem, false); }
    _applyLevel(stem, immediate) {
      const g = BRANCH_GAIN * (this.muted[stem] ? 0 : this.volume[stem]);
      const p = this.nodes[stem].out.gain;
      if (immediate) p.value = g; else p.setTargetAtTime(g, this.ctx.currentTime, 0.02);
    }
    setMasterVolume(v) {
      this.masterVolume = v;
      if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    }

    /* ---------------- song loading ---------------- */

    // song: { name, sampleRate, stems: { stem: [Float32Array L, Float32Array R] } }
    async loadSong(song) {
      await this.ensure();
      this.stop();
      const buffers = {}, envelopes = {};
      let duration = 0;
      for (const s of this.stems) {
        const pair = song.stems[s];
        if (!pair) continue; // unmapped slot stays silent
        const frames = pair[0].length;
        const buf = this.ctx.createBuffer(2, frames, song.sampleRate);
        buf.copyToChannel(pair[0], 0); buf.copyToChannel(pair[1], 1);
        buffers[s] = buf;
        duration = Math.max(duration, frames / song.sampleRate);
        envelopes[s] = computeEnvelope(pair[0], pair[1]);
      }
      this.song = { name: song.name, buffers, duration, envelopes }; // previous buffers are now unreferenced
      this.offset = 0;
      this._changed();
      return this.song;
    }

    /* ---------------- transport ---------------- */

    play() {
      if (!this.song || this.playing) return;
      const ctx = this.ctx;
      const when = ctx.currentTime + 0.05;
      this.sources = {};
      let first = true;
      for (const s of this.stems) {
        const buf = this.song.buffers[s];
        if (!buf) continue;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.nodes[s].input);
        src.start(when, Math.min(this.offset, buf.duration));
        if (first) {
          // One stem's end is every stem's end - they are the same length.
          src.onended = () => { if (this.sources && this.sources[s] === src && this.playing) this._finished(); };
          first = false;
        }
        this.sources[s] = src;
      }
      this.startedAt = when;
      this.playing = true;
      this._changed();
    }

    pause() {
      if (!this.playing) return;
      this.offset = this.position();
      this._stopSources();
      this.playing = false;
      this._changed();
    }

    stop() {
      this._stopSources();
      this.playing = false;
      this.offset = 0;
      this._changed();
    }

    seek(sec) {
      const was = this.playing;
      if (was) this._stopSources();
      this.playing = false;
      this.offset = Math.max(0, Math.min(sec, this.song ? this.song.duration : 0));
      if (was) this.play(); else this._changed();
    }

    position() {
      if (!this.song) return 0;
      if (!this.playing) return this.offset;
      return Math.min(this.offset + Math.max(0, this.ctx.currentTime - this.startedAt), this.song.duration);
    }

    _stopSources() {
      if (!this.sources) return;
      for (const s in this.sources) { try { this.sources[s].onended = null; this.sources[s].stop(); } catch (e) {} }
      this.sources = null;
    }

    _finished() {
      this.sources = null;
      this.playing = false;
      this.offset = 0;
      this._changed();
      if (this.onEnded) this.onEnded();
    }

    _changed() { if (this.onStateChange) this.onStateChange(); }

    /* ---------------- recording (writesf~ port) ---------------- */

    // Taps the master bus - exactly what the headphones hear, motion and
    // all - and hands back a 16-bit stereo WAV blob on stop.
    startRecording() {
      if (this.recorder || !this.ctx) return;
      const ctx = this.ctx;
      // ScriptProcessorNode is deprecated but works everywhere without a
      // separate worklet file, which file:// pages cannot load.
      const sp = ctx.createScriptProcessor(4096, 2, 2);
      const chunksL = [], chunksR = [];
      sp.onaudioprocess = (e) => {
        chunksL.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        chunksR.push(new Float32Array(e.inputBuffer.getChannelData(1)));
      };
      this.master.connect(sp);
      // A ScriptProcessor only runs when connected to the destination; a
      // zero gain keeps it out of the audible mix.
      const sink = ctx.createGain(); sink.gain.value = 0;
      sp.connect(sink); sink.connect(ctx.destination);
      this.recorder = { sp, sink, chunksL, chunksR, startedAt: ctx.currentTime };
      this._changed();
    }

    stopRecording() {
      const r = this.recorder;
      if (!r) return null;
      this.master.disconnect(r.sp); r.sp.disconnect(); r.sink.disconnect();
      this.recorder = null;
      const total = r.chunksL.reduce((n, c) => n + c.length, 0);
      const L = new Float32Array(total), R = new Float32Array(total);
      let p = 0;
      for (let i = 0; i < r.chunksL.length; i++) { L.set(r.chunksL[i], p); R.set(r.chunksR[i], p); p += r.chunksL[i].length; }
      this._changed();
      return new Blob([SSWav.encodeWav([L, R], this.ctx.sampleRate)], { type: 'audio/wav' });
    }

    get isRecording() { return !!this.recorder; }
  }

  // Port of precompute_fft_envelope.py: short-time energy per hop over a
  // Hann-windowed frame (Parseval makes the rfft power sum equal the
  // windowed time-domain energy, so no FFT needed), resampled to
  // ENV_POINTS, sqrt-compressed, min/max normalized to [0, 1].
  function computeEnvelope(L, R) {
    const n = L.length;
    const nFrames = Math.max(1, Math.floor((n - ENV_FRAME) / ENV_HOP) + 1);
    const win = new Float32Array(ENV_FRAME);
    for (let i = 0; i < ENV_FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / ENV_FRAME);
    const energy = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      const o = f * ENV_HOP;
      let e = 0;
      for (let i = 0; i < ENV_FRAME && o + i < n; i++) {
        const v = 0.5 * (L[o + i] + R[o + i]) * win[i];
        e += v * v;
      }
      energy[f] = e;
    }
    const out = new Float32Array(ENV_POINTS);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < ENV_POINTS; i++) {
      const x = (i / (ENV_POINTS - 1)) * (nFrames - 1);
      const a = Math.floor(x), b = Math.min(a + 1, nFrames - 1), t = x - a;
      const v = Math.sqrt(Math.max(0, energy[a] * (1 - t) + energy[b] * t));
      out[i] = v; if (v < lo) lo = v; if (v > hi) hi = v;
    }
    if (hi - lo < 1e-12) { out.fill(0.5); return out; }
    for (let i = 0; i < ENV_POINTS; i++) out[i] = (out[i] - lo) / (hi - lo);
    return out;
  }

  window.SSEngine = Engine;
})();
