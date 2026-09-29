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
// bridge/led.json: host, port, startIndex, count, frontIndex, clockwise,
// brightness, timeoutSeconds, and per stem { on, color, spread, tail }.
// L/R swap mirrors the strip together with the sound, as on the rig.
(function () {
  'use strict';
  const KEY = 'spatialstage.led';
  const TICK_MS = 40;   // 25 fps: an HTTP hop per frame, kept well inside what the helper and WLED take
  const DEFAULTS = {
    host: '', port: 21324, startIndex: 0, count: 150, frontIndex: 0, clockwise: true,
    brightness: 1, timeoutSeconds: 2, stems: {},
  };
  const fromHex = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

  class LedStrip {
    constructor(stems, colors) {
      this.stems = stems;
      this.cfg = Object.assign({}, DEFAULTS);
      try { Object.assign(this.cfg, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) {}
      this.cfg.stems = this.cfg.stems || {};
      for (const s of stems) {
        this.cfg.stems[s] = Object.assign({ on: true, color: colors[s] || '#ffffff', spread: 12, tail: 0 }, this.cfg.stems[s] || {});
      }
      this.running = false;
      this.timer = null;
      this.inFlight = false;
      this.lastError = null;
      this.onError = null;       // (message) => void, once per failure streak
      this.getState = null;      // () => { azimuth: {stem: deg}, gain: {stem: 0..1}, mirror }
      this._alloc();
    }

    get configured() { return !!this.cfg.host && this.cfg.count > 0; }

    save() { try { localStorage.setItem(KEY, JSON.stringify(this.cfg)); } catch (e) {} }

    set(patch) {
      const layoutChanged = ['count', 'startIndex'].some((k) => k in patch && patch[k] !== this.cfg[k]);
      Object.assign(this.cfg, patch);
      if (layoutChanged) this._alloc();
      this.save();
    }
    setStem(stem, patch) { Object.assign(this.cfg.stems[stem], patch); this.save(); }

    _alloc() {
      // DRGB carries at most 490 LEDs, counted from the start of the strip.
      const start = Math.max(0, Math.min(489, Math.round(this.cfg.startIndex) || 0));
      const n = Math.max(1, Math.min(490 - start, Math.round(this.cfg.count) || 1));
      this.offset = 2 + 3 * start;
      this.frame = new Uint8Array(this.offset + 3 * n);
      this.accum = new Float32Array(3 * n);
      this.trail = {};
      for (const s of this.stems) this.trail[s] = new Float32Array(3 * n);
    }

    start() {
      if (this.running || !this.configured) return;
      this.running = true;
      this.timer = setInterval(() => this._tick(), TICK_MS);
    }

    // Blacks the strip out and hands it back to WLED's own effect.
    stop() {
      if (!this.running) return;
      this.running = false;
      clearInterval(this.timer);
      this.frame.fill(0, 2);
      this.frame[0] = 2; this.frame[1] = 1;
      SSHelper.led(this.frame, this.cfg.host, this.cfg.port).catch(() => {});
    }

    // The rig's renderLedFrame, line for line.
    render(state) {
      const cfg = this.cfg, n = this.accum.length / 3;
      const degPerLed = 360 / n;
      this.accum.fill(0);
      for (const stem of this.stems) {
        const look = cfg.stems[stem];
        const buf = this.trail[stem];
        // Trails fade to 5% over `tail` seconds; a stem muted mid-move fades
        // out rather than vanishing.
        const decay = look.tail > 0 ? Math.pow(0.05, TICK_MS / 1000 / look.tail) : 0;
        if (decay > 0) { for (let i = 0; i < buf.length; i++) buf[i] *= decay; } else buf.fill(0);
        const gain = look.on ? (state.gain[stem] || 0) * cfg.brightness : 0;
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
            idx = ((idx + Math.round(cfg.frontIndex)) % n + n) % n;
            for (let c = 0; c < 3; c++) {
              const v = color[c] * w;
              if (v > buf[3 * idx + c]) buf[3 * idx + c] = v;
            }
          }
        }
        for (let i = 0; i < buf.length; i++) { if (buf[i] < 1) buf[i] = 0; else this.accum[i] += buf[i]; }
      }
      this.frame[0] = 2;   // DRGB
      this.frame[1] = Math.max(1, Math.min(255, Math.round(cfg.timeoutSeconds)));
      for (let i = 0; i < this.accum.length; i++) this.frame[this.offset + i] = this.accum[i] > 255 ? 255 : this.accum[i];
      return this.frame;
    }

    _tick() {
      if (!this.getState) return;
      this.render(this.getState());
      // One request at a time: if the helper is slow, frames are dropped
      // rather than queued up behind each other.
      if (this.inFlight) return;
      this.inFlight = true;
      SSHelper.led(this.frame, this.cfg.host, this.cfg.port)
        .then(() => { this.lastError = null; })
        .catch((e) => {
          if (!this.lastError && this.onError) this.onError(e.message);
          this.lastError = e.message;
        })
        .finally(() => { this.inFlight = false; });
    }
  }

  window.SSLedStrip = LedStrip;
})();
