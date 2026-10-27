// LED strip around the listener, like the Pd rig's (bridge/server.js,
// renderLedFrame): each stem lights the LEDs in the direction its audio is
// coming from, in its own colour, as a soft lobe that can leave a fading
// trail. Sent as WLED's DRGB realtime UDP packet ([2, timeout, r,g,b ...],
// port 21324) - a browser cannot send UDP, so the packet goes to
// SpatialStage Helper on this PC, which passes it on (POST /v1/led). So the
// strip works from a desktop browser with the helper running, not from a
// phone.
//
// Settings (this browser's localStorage), the same fields as the rig's
// bridge/led.json: a list of strips (host, port, startIndex, count, frontIndex,
// clockwise, brightness, timeoutSeconds) and per stem { on, color, spread, tail, strips }.
// L/R swap mirrors the strip together with the sound, as on the rig.
(function () {
  'use strict';
  const KEY = 'spatialstage.led';
  const TICK_MS = 40;   // 25 fps: an HTTP hop per frame, kept well inside what the helper and WLED take
  const MAX_STRIPS = 8;
  const STRIP_DEFAULTS = {
    name: '', host: '', port: 21324, startIndex: 0, count: 150, frontIndex: 0, clockwise: true,
    brightness: 1, timeoutSeconds: 2,
  };
  const fromHex = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

  // One strip's settings, made whole (the same checks as the rig bridge's normaliseStrips).
  function normaliseStrip(o, i, taken) {
    o = Object.assign({}, STRIP_DEFAULTS, o && typeof o === 'object' ? o : {});
    let id = String(o.id || '').replace(/[^\w-]/g, '').slice(0, 24) || 'strip' + (i + 1);
    while (taken.has(id)) id += 'x';
    taken.add(id);
    const startIndex = clampInt(o.startIndex, 0, 489, 0);
    return {
      id,
      name: String(o.name || '').slice(0, 40) || 'Strip ' + (i + 1),
      host: String(o.host || '').trim().slice(0, 80),
      port: clampInt(o.port, 1, 65535, 21324),
      startIndex,
      count: clampInt(o.count, 1, 490 - startIndex, Math.min(150, 490 - startIndex)),
      frontIndex: clampInt(o.frontIndex, 0, 489, 0),
      clockwise: o.clockwise !== false,
      brightness: Math.max(0, Math.min(1, Number.isFinite(Number(o.brightness)) ? Number(o.brightness) : 1)),
      timeoutSeconds: clampInt(o.timeoutSeconds, 1, 255, 2),
    };
  }

  // Any number of WLED strips, each with its own address and ring calibration; each stem
  // lights every strip (stems[s].strips = null) or only the ones listed there. Saved in
  // this browser's localStorage. An older single-strip save becomes one strip.
  class LedStrip {
    constructor(stems, colors) {
      this.stems = stems;
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) {}
      let list = Array.isArray(saved.strips) ? saved.strips : (saved.host ? [Object.assign({ id: 'main', name: 'Strip 1' }, saved)] : []);
      const taken = new Set();
      this.strips = list.slice(0, MAX_STRIPS).map((o, i) => normaliseStrip(o, i, taken));
      this.cfg = { stems: saved.stems || {}, mirror: false };
      for (const s of stems) {
        this.cfg.stems[s] = Object.assign({ on: true, color: colors[s] || '#ffffff', spread: 12, tail: 0, strips: null }, this.cfg.stems[s] || {});
      }
      this.running = false;
      this.timer = null;
      this.lastError = null;
      this.onError = null;       // (message) => void, once per failure streak
      this.getState = null;      // () => { azimuth: {stem: deg}, gain: {stem: 0..1}, mirror }
      this._alloc();
    }

    get configured() { return this.strips.some((x) => x.host && x.count > 0); }

    save() { try { localStorage.setItem(KEY, JSON.stringify({ strips: this.strips, stems: this.cfg.stems })); } catch (e) {} }

    // Replace the strip list (the editor's working copy). Stems keep their strip choice for the
    // ids that still exist.
    setStrips(list) {
      const taken = new Set();
      this.strips = list.slice(0, MAX_STRIPS).map((o, i) => normaliseStrip(o, i, taken));
      for (const s of this.stems) {
        const look = this.cfg.stems[s];
        if (Array.isArray(look.strips)) look.strips = look.strips.filter((id) => this.strips.some((x) => x.id === id));
      }
      this._alloc();
      this.save();
    }
    setStem(stem, patch) { Object.assign(this.cfg.stems[stem], patch); this.save(); }

    // Per strip: a DRGB packet (at most 490 LEDs from the start of the strip), a summing buffer
    // and a trail buffer per stem. Kept for a strip whose size did not change.
    _alloc() {
      const old = new Map((this.rt || []).map((r) => [r.cfg.id, r]));
      this.rt = this.strips.map((cfg) => {
        const prev = old.get(cfg.id);
        if (prev && prev.n === cfg.count && prev.cfg.startIndex === cfg.startIndex) { prev.cfg = cfg; return prev; }
        const n = cfg.count, offset = 2 + 3 * cfg.startIndex;
        const trail = {};
        for (const s of this.stems) trail[s] = new Float32Array(3 * n);
        return { cfg, n, offset, frame: new Uint8Array(offset + 3 * n), accum: new Float32Array(3 * n), trail, inFlight: false };
      });
    }

    start() {
      if (this.running || !this.configured) return;
      this.running = true;
      this.timer = setInterval(() => this._tick(), TICK_MS);
    }

    // Blacks the strips out and hands them back to WLED's own effect.
    stop() {
      if (!this.running) return;
      this.running = false;
      clearInterval(this.timer);
      for (const r of this.rt) {
        if (!r.cfg.host) continue;
        r.frame.fill(0, 2);
        r.frame[0] = 2; r.frame[1] = 1;
        SSHelper.led(r.frame, r.cfg.host, r.cfg.port).catch(() => {});
      }
    }

    // The rig's renderLedFrame, line for line, once per strip.
    render(state) { for (const r of this.rt) this._renderStrip(r, state); }

    _renderStrip(r, state) {
      const cfg = r.cfg, n = r.n, accum = r.accum, frame = r.frame;
      const degPerLed = 360 / n;
      accum.fill(0);
      for (const stem of this.stems) {
        const look = this.cfg.stems[stem];
        const buf = r.trail[stem];
        // Trails fade to 5% over `tail` seconds; a stem muted mid-move fades out rather than vanishing.
        const decay = look.tail > 0 ? Math.pow(0.05, TICK_MS / 1000 / look.tail) : 0;
        if (decay > 0) { for (let i = 0; i < buf.length; i++) buf[i] *= decay; } else buf.fill(0);
        const lit = !Array.isArray(look.strips) || look.strips.includes(cfg.id);
        const gain = look.on && lit ? (state.gain[stem] || 0) * cfg.brightness : 0;
        if (gain > 0) {
          const color = fromHex(look.color);
          const spread = Math.max(0.5, look.spread);
          const centre = state.azimuth[stem] / degPerLed;
          const nearest = Math.round(centre);
          const reach = Math.ceil(spread / degPerLed);
          for (let k = -reach; k <= reach; k++) {
            const d = Math.abs((nearest + k - centre) * degPerLed);
            if (d >= spread) continue;
            const w = gain * 0.5 * (1 + Math.cos(Math.PI * d / spread));
            let idx = nearest + k;
            if (cfg.clockwise === !!state.mirror) idx = -idx;
            idx = ((idx + cfg.frontIndex) % n + n) % n;
            for (let c = 0; c < 3; c++) {
              const v = color[c] * w;
              if (v > buf[3 * idx + c]) buf[3 * idx + c] = v;
            }
          }
        }
        for (let i = 0; i < buf.length; i++) { if (buf[i] < 1) buf[i] = 0; else accum[i] += buf[i]; }
      }
      frame[0] = 2;   // DRGB
      frame[1] = cfg.timeoutSeconds;
      for (let i = 0; i < accum.length; i++) frame[r.offset + i] = accum[i] > 255 ? 255 : accum[i];
    }

    _tick() {
      if (!this.getState) return;
      this.render(this.getState());
      for (const r of this.rt) {
        // One request per strip at a time: if the helper is slow, frames are dropped rather
        // than queued up behind each other.
        if (!r.cfg.host || r.inFlight) continue;
        r.inFlight = true;
        SSHelper.led(r.frame, r.cfg.host, r.cfg.port)
          .then(() => { this.lastError = null; })
          .catch((e) => {
            if (!this.lastError && this.onError) this.onError(e.message);
            this.lastError = e.message;
          })
          .finally(() => { r.inFlight = false; });
      }
    }
  }

  window.SSLedStrip = LedStrip;
})();
