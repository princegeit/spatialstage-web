// Audio engine: the Web Audio port of pd/spatialstage_live.pd's signal path
// (pd/generate_live_patch.py). Everything here is per-stem graph plumbing,
// output routing and transport; azimuth *decisions* (phone/fft/preset
// blending) live in motion.js and arrive through setAzimuth().
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
// PannerNode with panningModel 'HRTF' - the browser's own head-related
// response (the Pd rig plays the same one, captured from the browser by
// pd/spatial/capture_browser_hrtf.js, in pd/spatial/hrtf-mix.pd).
//
// Output, as in the live patch:
//   stereo mix -> master volume -> L/R swap ─┐
//                                            ├─ crossfade -> speakers 1-2
//   quad mix   -> master volume ─────────────┘            -> speakers 3-4 (quad only)
// The quad mix is pd/quad_pan.pd per chain: four speakers at -45, 45,
// -135, 135 degrees, gain cos(min(distance, 90)) each. Recording taps the
// stereo mix after the swap - what the headphones hear - as writesf~ does.
(function () {
  const BASE_DELAY_S = 0.005;
  const ITD_S = 0.0003;
  const RAMP_TAU = 0.012;   // setTargetAtTime time constant; ~40 ms to settle, no clicks at 40 Hz updates
  const BRANCH_GAIN = 0.5;  // stereo build's per-branch gain, matches level with the mono build
  const ENV_FRAME = 2048, ENV_HOP = 512, ENV_POINTS = 1000; // precompute_fft_envelope.py
  const SPEAKERS = [-45, 45, -135, 135];   // quad_pan.pd: FL, FR, RL, RR

  const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180;
  const quadGain = (angle, speaker) => Math.cos(Math.min(Math.abs(wrap180(angle - speaker)), 90) * Math.PI / 180);

  class Engine {
    constructor(stems, geometry) {
      this.stems = stems;
      this.geometry = geometry;            // { stem: { azimuth, width } }
      this.ctx = null;
      this.nodes = {};                     // per-stem graph
      this.panMode = 'pd';                 // 'pd' | 'hrtf'
      this.lrSwap = false;
      this.quad = false;
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
      this.live = {};                      // stem -> { deviceId, pair, gain } of a live input in use
      this.inputs = new Map();             // deviceId -> { stream, source, splitter, channels }
      this.azimuth = {};
      for (const s of stems) this.azimuth[s] = geometry[s].azimuth;
    }

    // The AudioContext must be created/resumed from a user gesture on every
    // mobile browser, so this is called from a tap handler, not at load.
    async ensure() {
      if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return this.ctx; }
      // iOS routes Web Audio through the ringer channel by default, so the
      // silent switch mutes the whole app; 'playback' makes it behave like a
      // music player instead (Safari 16.4+, ignored everywhere else).
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this._buildOutput();
      for (const s of this.stems) this.nodes[s] = this._buildStem(s);
      if (ctx.state !== 'running') await ctx.resume();
      return ctx;
    }

    _buildOutput() {
      const ctx = this.ctx;
      const g = (v, channels) => {
        const n = ctx.createGain(); n.gain.value = v;
        if (channels) { n.channelCount = channels; n.channelCountMode = 'explicit'; n.channelInterpretation = 'discrete'; }
        return n;
      };
      // Master volume, once per mix (the patch's two [*~] after each bus).
      this.master = g(this.masterVolume, 2);
      this.qmaster = g(this.masterVolume, 4);

      // L/R swap: L' = L(1-s) + Rs, R' = R(1-s) + Ls.
      const split = ctx.createChannelSplitter(2);
      this.master.connect(split);
      this.post = ctx.createChannelMerger(2);
      this.swap = { LL: g(1), RR: g(1), RL: g(0), LR: g(0) };
      split.connect(this.swap.LL, 0); this.swap.LL.connect(this.post, 0, 0);
      split.connect(this.swap.RL, 1); this.swap.RL.connect(this.post, 0, 0);
      split.connect(this.swap.RR, 1); this.swap.RR.connect(this.post, 0, 1);
      split.connect(this.swap.LR, 0); this.swap.LR.connect(this.post, 0, 1);

      // Stereo vs quad: speakers 1-2 crossfade from the stereo mix to the
      // quad front pair, 3-4 carry the quad rear pair only in quad mode.
      this.final = ctx.createChannelMerger(4);
      const postSplit = ctx.createChannelSplitter(2);
      this.post.connect(postSplit);
      this.stereoGate = [g(1), g(1)];
      this.stereoGate.forEach((n, k) => { postSplit.connect(n, k); n.connect(this.final, 0, k); });
      const qSplit = ctx.createChannelSplitter(4);
      this.qmaster.connect(qSplit);
      this.quadGate = [g(0), g(0), g(0), g(0)];
      this.quadGate.forEach((n, k) => { qSplit.connect(n, k); n.connect(this.final, 0, k); });
      // 'discrete' so a stereo device keeps speakers 1-2 as they are rather
      // than folding 3-4 into them at half level.
      const dest = ctx.destination;
      try { dest.channelInterpretation = 'discrete'; } catch (e) {}
      this.final.connect(dest);
    }

    _buildStem(stem) {
      const ctx = this.ctx;
      const n = { input: ctx.createGain(), split: ctx.createChannelSplitter(2), out: ctx.createGain(), chains: [] };
      // Live input (setLive) joins the stem's file audio here: this gain node is summed into n.input.
      n.liveGain = ctx.createGain(); n.liveGain.gain.value = 0;
      n.liveGain.channelCount = 2; n.liveGain.channelCountMode = 'explicit';
      n.liveGain.connect(n.input);
      n.input.channelCount = 2; n.input.channelCountMode = 'explicit';
      n.input.connect(n.split);
      // Level: BRANCH_GAIN * volume * (muted ? 0 : 1), ramped like Pd's line~ 20 ms.
      n.out.gain.value = BRANCH_GAIN;
      n.out.connect(this.master);
      // The quad mix of this stem, same level.
      n.qmerge = ctx.createChannelMerger(4);
      n.qout = ctx.createGain();
      n.qout.channelCount = 4; n.qout.channelCountMode = 'explicit'; n.qout.channelInterpretation = 'discrete';
      n.qout.gain.value = BRANCH_GAIN;
      n.qmerge.connect(n.qout); n.qout.connect(this.qmaster);

      // Analysis taps for motion.js's fft-source port: a mono sum of the
      // stem (Pd downmixes each stem before fft-source too), one wideband
      // time-domain analyser for pitch/onset/level, one bandpassed analyser
      // for the band-energy mode (bp~ 1000 4 -> env~).
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
        // --- quad_pan.pd: one gain per speaker ---
        ch.quad = SPEAKERS.map((_, k) => { const q = ctx.createGain(); n.split.connect(q, c); q.connect(n.qmerge, 0, k); return q; });
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

    // L/R swap (the rig's address 30), ramped like its 20 ms line~.
    setLrSwap(on) {
      this.lrSwap = !!on;
      if (!this.ctx) return;
      const t = this.ctx.currentTime, s = this.lrSwap ? 1 : 0;
      this.swap.LL.gain.setTargetAtTime(1 - s, t, 0.007); this.swap.RR.gain.setTargetAtTime(1 - s, t, 0.007);
      this.swap.RL.gain.setTargetAtTime(s, t, 0.007); this.swap.LR.gain.setTargetAtTime(s, t, 0.007);
    }

    // How many speakers the output device offers (after ensure()).
    get maxChannels() { return this.ctx ? this.ctx.destination.maxChannelCount : 2; }
    get quadSupported() { return this.maxChannels >= 4; }

    // Four-speaker output (the rig's address 31). False if the device the
    // browser is playing to has fewer than four channels - browsers only
    // expose what the OS reports for the default output.
    setQuad(on) {
      if (on && this.ctx && !this.quadSupported) return false;
      this.quad = !!on;
      if (!this.ctx) return true;
      const dest = this.ctx.destination;
      if (this.quad) {
        try { dest.channelCount = 4; } catch (e) { this.quad = false; return false; }
        for (const s of this.stems) this._applyQuad(s, this.azimuth[s], true);
      }
      const t = this.ctx.currentTime, q = this.quad ? 1 : 0;
      this.stereoGate.forEach((n) => n.gain.setTargetAtTime(1 - q, t, 0.007));
      this.quadGate.forEach((n) => n.gain.setTargetAtTime(q, t, 0.007));
      // Back to two channels once the ramp is over, so a stereo device is
      // not left driving four.
      if (!this.quad) setTimeout(() => { if (!this.quad) { try { dest.channelCount = 2; } catch (e) {} } }, 100);
      return true;
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
      if (this.quad || immediate) this._applyQuad(stem, deg, immediate);
    }

    _applyQuad(stem, deg, immediate) {
      const n = this.nodes[stem];
      const w = this.geometry[stem].width || 0;
      const t = this.ctx.currentTime;
      for (let c = 0; c < 2; c++) {
        const angle = deg + (c === 0 ? -w / 2 : w / 2);
        n.chains[c].quad.forEach((q, k) => {
          const v = quadGain(angle, SPEAKERS[k]);
          if (immediate) q.gain.value = v; else q.gain.setTargetAtTime(v, t, RAMP_TAU);
        });
      }
    }

    // RMS of the newest 512 samples of the stem's own (pre-fader) mono mix,
    // as env~ reports it: dB with 100 = full scale, 0 for silence.
    envDb(stem) {
      const n = this.nodes[stem];
      if (!n || !(this.playing || this.live[stem])) return 0;
      if (!this._meterBuf) this._meterBuf = new Float32Array(n.analyser.fftSize);
      n.analyser.getFloatTimeDomainData(this._meterBuf);
      // The analyser window is oldest-first; the newest 512 samples are the tail.
      const b = this._meterBuf, from = b.length - 512;
      let e = 0;
      for (let i = from; i < b.length; i++) e += b[i] * b[i];
      return Math.max(0, 100 + 20 * Math.log10(Math.sqrt(e / 512) + 1e-9));
    }

    // 0..1 meter value for the UI: envDb on a -60..0 dB scale, times the
    // stem's fader and mute.
    levelOf(stem) {
      if (!this.nodes[stem] || !this.playing) return 0;
      const v = (this.envDb(stem) - 40) / 60;
      return Math.max(0, Math.min(1, v)) * (this.muted[stem] ? 0 : this.volume[stem]);
    }

    setVolume(stem, v) { this.volume[stem] = v; if (this.ctx) this._applyLevel(stem, false); }
    setMuted(stem, m) { this.muted[stem] = !!m; if (this.ctx) this._applyLevel(stem, false); }
    _applyLevel(stem, immediate) {
      const g = BRANCH_GAIN * (this.muted[stem] ? 0 : this.volume[stem]);
      for (const p of [this.nodes[stem].out.gain, this.nodes[stem].qout.gain]) {
        if (immediate) p.value = g; else p.setTargetAtTime(g, this.ctx.currentTime, 0.02);
      }
    }
    setMasterVolume(v) {
      this.masterVolume = v;
      if (!this.ctx) return;
      this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
      this.qmaster.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    }

    /* ---------------- song loading ---------------- */

    // song: { name, sampleRate, stems: { stem: [Float32Array L, Float32Array R] } }
    async loadSong(song) {
      await this.ensure();
      this.unload();
      const buffers = {};
      let duration = 0;
      for (const s of this.stems) {
        const pair = song.stems[s];
        if (!pair) continue; // unmapped slot stays silent
        const frames = pair[0].length;
        const buf = this.ctx.createBuffer(2, frames, song.sampleRate);
        buf.copyToChannel(pair[0], 0); buf.copyToChannel(pair[1], 1);
        buffers[s] = buf;
        duration = Math.max(duration, frames / song.sampleRate);
        // Drop the decoded copy as soon as it is in an AudioBuffer, so a long
        // multichannel song does not sit in memory twice while the rest copy.
        delete song.stems[s];
      }
      // Envelopes are filled in by envelopeOf() the first time precalc mode
      // asks for one - most songs never use it, and computing them all up
      // front cost a noticeable pause on every load.
      this.song = { name: song.name, buffers, duration, envelopes: {}, curves: {}, beats: null };
      this.offset = 0;
      this._changed();
      return this.song;
    }

    // Forget the current song (and its buffers) - called before decoding the
    // next one so two full songs never have to fit in memory at once.
    unload() {
      this.stop();
      this.song = null;
      this._changed();
    }

    // Stems the loaded song has audio for.
    hasStem(stem) { return !!(this.song && this.song.buffers[stem]); }

    // Put (or replace) one stem's audio in the loaded song, live: if the song
    // is playing, that stem carries on from the current position with the new
    // audio. Lasts until the song is loaded again.
    setStemAudio(stem, pair, sampleRate) {
      if (!this.song || !this.ctx) return false;
      const buf = this.ctx.createBuffer(2, pair[0].length, sampleRate);
      buf.copyToChannel(pair[0], 0); buf.copyToChannel(pair[1], 1);
      const song = this.song;
      song.buffers[stem] = buf;
      delete song.envelopes[stem];
      for (const k of Object.keys(song.curves)) if (k.endsWith(':' + stem)) delete song.curves[k];
      song.beats = null;   // re-analysed the next time Beat steps asks
      song.duration = Math.max(song.duration, buf.duration);
      if (this.playing && this.sources) {
        const old = this.sources[stem];
        if (old) { try { old.onended = null; old.stop(); } catch (e) {} }
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.nodes[stem].input);
        src.start(0, Math.min(this.position(), buf.duration));
        this.sources[stem] = src;
        // the song ends with its longest stem, which may now be another one
        let longest = null;
        for (const s in this.sources) {
          this.sources[s].onended = null;
          if (!longest || this.sources[s].buffer.duration > longest.buffer.duration) longest = this.sources[s];
        }
        const end = longest;
        end.onended = () => { if (this.sources && Object.values(this.sources).includes(end) && this.playing) this._finished(); };
      }
      this._changed();
      return true;
    }

    envelopeOf(stem) {
      const song = this.song;
      if (!song || !song.buffers[stem]) return null;
      if (!song.envelopes[stem]) {
        const buf = song.buffers[stem];
        song.envelopes[stem] = computeEnvelope(buf.getChannelData(0), buf.getChannelData(1));
      }
      return song.envelopes[stem];
    }

    // Follow / Sections curves (curves.js), same 0..1 table format and the
    // same lazy per-song cache as the envelope above.
    curveOf(stem, kind) {
      const song = this.song;
      if (!song || !song.buffers[stem]) return null;
      const key = kind + ':' + stem;
      if (!song.curves[key]) {
        const buf = song.buffers[stem], L = buf.getChannelData(0), R = buf.getChannelData(1);
        song.curves[key] = kind === 'balance' ? SSCurves.balance(L, R) : SSCurves.sections(L, R, buf.sampleRate).curve;
      }
      return song.curves[key];
    }

    // Beat steps (beats.js): { status: 'analysing' | 'ready' | 'error', progress, data }, started
    // the first time a stem in that mode asks and kept for the song. Done in the page, stem by
    // stem with a pause between slices so playback and the UI stay smooth; a song takes a few
    // seconds. data is the shape the rig's .beats.json has: { stems, song }.
    beatsOf() {
      const song = this.song;
      if (!song) return null;
      if (!song.beats) {
        song.beats = { status: 'analysing', progress: 0, data: null, message: '' };
        this._analyseBeats(song, song.beats);
      }
      return song.beats;
    }

    async _analyseBeats(song, entry) {
      const pause = () => new Promise((r) => setTimeout(r, 0));
      try {
        const names = this.stems.filter((s) => song.buffers[s]);
        if (!names.length) throw new Error('no stems loaded');
        const CH = 1 << 17, mono = new Float32Array(CH), onsets = [];
        for (let si = 0; si < names.length; si++) {
          const buf = song.buffers[names[si]];
          const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
          const o = new SSBeats.OnsetEnvelope(buf.sampleRate);
          for (let off = 0; off < L.length; off += CH) {
            const m = Math.min(CH, L.length - off);
            for (let i = 0; i < m; i++) mono[i] = (L[off + i] + R[off + i]) * 0.5;
            o.push(mono.subarray(0, m));
            if (((off / CH) & 3) === 3) {
              entry.progress = Math.round(100 * (si + off / L.length) / names.length);
              this._changed();
              await pause();
              if (this.song !== song || song.beats !== entry) return;   // another song, or a stem was swapped
            }
          }
          onsets.push(o);
          await pause();
        }
        entry.data = SSBeats.describeSong(onsets, names);
        entry.status = 'ready';
      } catch (e) {
        entry.status = 'error'; entry.message = e.message || String(e);
      }
      entry.progress = 100;
      this._changed();
    }

    /* ---------------- live input ---------------- */

    // A sound input (microphone, line-in, a virtual cable, a USB interface) added to a stem, on top of
    // whatever the stem's file plays - the web app's version of the rig's EXT option (address 100+i).
    // deviceId '' is the browser's default input; pair 0 switches it off, 1..4 = the device's channels
    // 1-2 ... 7-8 (a mono device feeds both sides). Echo cancellation, noise suppression and automatic
    // gain are off: they are made for calls and would mangle music. Needs a tap/click (permission).
    // Resolves with { channels } of the device, or throws (permission refused, no such device).
    async setLive(stem, { deviceId = '', pair = 0, gain = 1 } = {}) {
      await this.ensure();
      const n = this.nodes[stem];
      if (!n) throw new Error('no such stem: ' + stem);
      const old = this.live[stem];
      if (old && old.merger) { try { old.merger.disconnect(); } catch (e) {} }
      if (!pair) {
        n.liveGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
        delete this.live[stem];
        this._releaseInput(old && old.deviceId);
        this._changed();
        return { channels: 0 };
      }
      const input = await this._openInput(deviceId);
      const merger = this.ctx.createChannelMerger(2);
      const left = 2 * (pair - 1), right = left + 1;
      const have = input.channels;
      const l = left < have ? left : 0;                     // a pair the device does not have: its first channel
      const r = right < have ? right : (left < have ? left : 0);   // a mono device (or odd count) feeds both sides
      input.splitter.connect(merger, l, 0);
      input.splitter.connect(merger, r, 1);
      merger.connect(n.liveGain);
      n.liveGain.gain.setTargetAtTime(Math.max(0, Math.min(2, gain)), this.ctx.currentTime, 0.01);
      this.live[stem] = { deviceId, pair, gain, merger };
      if (old && old.deviceId !== deviceId) this._releaseInput(old.deviceId);
      this._changed();
      return { channels: have };
    }

    setLiveGain(stem, gain) {
      const l = this.live[stem];
      if (!l) return;
      l.gain = gain;
      this.nodes[stem].liveGain.gain.setTargetAtTime(Math.max(0, Math.min(2, gain)), this.ctx.currentTime, 0.01);
    }

    async _openInput(deviceId) {
      let e = this.inputs.get(deviceId);
      if (e && e.stream.getAudioTracks().some((t) => t.readyState === 'live')) return e;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('this browser cannot open audio inputs here (it needs https:// or localhost)');
      const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 8 } };
      if (deviceId) audio.deviceId = { exact: deviceId };
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      const track = stream.getAudioTracks()[0];
      const channels = Math.max(1, (track && track.getSettings().channelCount) || 2);
      const source = this.ctx.createMediaStreamSource(stream);
      const splitter = this.ctx.createChannelSplitter(Math.max(2, Math.min(32, channels)));
      source.connect(splitter);
      e = { stream, source, splitter, channels };
      this.inputs.set(deviceId, e);
      return e;
    }

    // Close a device once no stem uses it any more.
    _releaseInput(deviceId) {
      if (deviceId === undefined || deviceId === null) return;
      if (Object.values(this.live).some((l) => l.deviceId === deviceId)) return;
      const e = this.inputs.get(deviceId);
      if (!e) return;
      try { e.source.disconnect(); } catch (err) {}
      e.stream.getTracks().forEach((t) => t.stop());
      this.inputs.delete(deviceId);
    }

    // The audio inputs the browser can see: [{ deviceId, label }]. Labels are empty until the page
    // has been given permission once (a call to setLive).
    async inputDevices() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === 'audioinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || ('Input ' + (i + 1)) }));
    }

    /* ---------------- transport ---------------- */

    play() {
      if (!this.song || this.playing) return;
      const ctx = this.ctx;
      const when = ctx.currentTime + 0.05;
      this.sources = {};
      let longest = null;
      for (const s of this.stems) {
        const buf = this.song.buffers[s];
        if (!buf) continue;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.nodes[s].input);
        src.start(when, Math.min(this.offset, buf.duration));
        this.sources[s] = src;
        if (!longest || buf.duration > longest.buffer.duration) longest = src;
      }
      // Stems from different files need not be the same length, so the song
      // ends when its longest stem does - ending on whichever came first
      // cut the song short and left the longer stems playing underneath the
      // next one.
      if (longest) {
        const src = longest;
        src.onended = () => { if (this.sources && Object.values(this.sources).includes(src) && this.playing) this._finished(); };
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
      this._stopSources();
      this.playing = false;
      this.offset = 0;
      this._changed();
      if (this.onEnded) this.onEnded();
    }

    _changed() { if (this.onStateChange) this.onStateChange(); }

    /* ---------------- recording (writesf~ port) ---------------- */

    // Taps the stereo mix after the L/R swap - exactly what the headphones
    // hear, motion and all.
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
      this.post.connect(sp);
      // A ScriptProcessor only runs when connected to the destination; a
      // zero gain keeps it out of the audible mix.
      const sink = ctx.createGain(); sink.gain.value = 0;
      sp.connect(sink); sink.connect(ctx.destination);
      this.recorder = { sp, sink, chunksL, chunksR, startedAt: ctx.currentTime };
      this._changed();
    }

    // The take as { channels: [L, R], sampleRate } - the page encodes it
    // (WAV here, MP3 in js/mp3.js).
    stopRecording() {
      const r = this.recorder;
      if (!r) return null;
      this.post.disconnect(r.sp); r.sp.disconnect(); r.sink.disconnect();
      this.recorder = null;
      const total = r.chunksL.reduce((n, c) => n + c.length, 0);
      const L = new Float32Array(total), R = new Float32Array(total);
      let p = 0;
      for (let i = 0; i < r.chunksL.length; i++) { L.set(r.chunksL[i], p); R.set(r.chunksR[i], p); p += r.chunksL[i].length; }
      this._changed();
      return { channels: [L, R], sampleRate: this.ctx.sampleRate };
    }

    get isRecording() { return !!this.recorder; }
    get recordingSeconds() { return this.recorder ? this.ctx.currentTime - this.recorder.startedAt : 0; }
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
