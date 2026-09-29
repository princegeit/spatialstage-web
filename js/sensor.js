// Phone turn -> rotation, ported from the Pd rig's control page
// (bridge/public/index.html, "headingOf" and the turn calibration), so the
// phone behaves the same on both rigs:
//
//   - The heading is where the phone POINTS - its top edge when flat, its
//     back (camera) when upright, blended by how horizontal each is - taken
//     from the full rotation matrix, so tilting or rolling the phone is not
//     read as turning. (Plain e.alpha is only right for a phone lying flat.)
//   - Compass (absolute) or gyro (relative) mode. The compass is anchored:
//     a direction always gives the same position. The gyro is smoother but
//     drifts. Compass is the default where the browser has it.
//   - Turn calibration (gyro only): some phones' gyros read a full turn as
//     ~340 degrees. Press, turn exactly once, press again; the ratio is kept
//     for this device.
//   - Invert: for a phone whose heading runs the other way.
//
// onTurn(deg) gets the rotation since the last zero, -180..180, already
// scaled and signed. onReading(text) gets a throttled diagnostic line.
(function () {
  'use strict';
  const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180;
  const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const put = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} };
  const K_ABS = 'spatialstage.sensorAbsolute', K_SCALE = 'spatialstage.turnScale', K_INV = 'spatialstage.phoneInvert';

  class PhoneTurn {
    constructor() {
      this.absoluteAvailable = typeof window !== 'undefined' && ('ondeviceorientationabsolute' in window);
      const abs = get(K_ABS);
      this.useAbsolute = abs === null ? this.absoluteAvailable : (abs === '1' && this.absoluteAvailable);
      const sc = Number(get(K_SCALE));
      this.turnScale = sc > 0.5 && sc < 2 ? sc : 1;
      this.invert = get(K_INV) === '1';
      this.bound = false;
      this.seen = false;        // a real reading has arrived since bind()
      this.onTurn = null; this.onFirst = null; this.onReading = null;
      this.gyroPresent = null;
      this._raw = 0; this._last = null; this._unwrapped = 0; this._zero = 0; this._needZero = true;
      this.calStart = null;
      this._handle = (e) => this._event(e);
      if (typeof window !== 'undefined') {
        // Without a gyroscope, Android's orientation is a plain magnetometer
        // compass, which bends near speakers and power supplies - shown in
        // the diagnostic line so a jumpy phone can be explained.
        window.addEventListener('devicemotion', (e) => {
          if (this.gyroPresent === null) this.gyroPresent = !!(e.rotationRate && e.rotationRate.alpha !== null);
        });
      }
    }

    setAbsolute(on) {
      this.useAbsolute = !!on && this.absoluteAvailable;
      put(K_ABS, this.useAbsolute ? '1' : '0');
      if (this.bound) this.bind();   // onto the other event stream
    }
    setInvert(on) { this.invert = !!on; put(K_INV, this.invert ? '1' : '0'); }

    bind() {
      this._detach();
      this._needZero = true; this._last = null; this.seen = false;
      window.addEventListener(this.useAbsolute && this.absoluteAvailable ? 'deviceorientationabsolute' : 'deviceorientation', this._handle);
      this.bound = true;
    }
    unbind() { this._detach(); this.bound = false; this.calStart = null; }
    _detach() {
      window.removeEventListener('deviceorientation', this._handle);
      window.removeEventListener('deviceorientationabsolute', this._handle);
    }

    // Wherever the phone points now becomes 0.
    zero() { this._zero = this._unwrapped; }

    // Turn calibration: start, one full turn, finish. Returns a message.
    calibrate() {
      if (this.calStart === null) { this.calStart = this._unwrapped; return 'turning... sensor 0°'; }
      const measured = Math.abs(this._unwrapped - this.calStart);
      this.calStart = null;
      if (measured < 270 || measured > 450) return 'sensor read ' + Math.round(measured) + '° - not one turn, kept scale ' + this.turnScale.toFixed(3);
      this.turnScale = 360 / measured;
      put(K_SCALE, String(this.turnScale));
      this._zero = this._unwrapped;   // the calibration turn itself is not a rotation
      return this.scaleText();
    }
    resetCalibration() { this.turnScale = 1; this.calStart = null; put(K_SCALE, null); return this.scaleText(); }
    scaleText() {
      return this.turnScale === 1 ? 'scale 1.000 (uncalibrated)'
        : 'scale ' + this.turnScale.toFixed(3) + ' (sensor turn = ' + Math.round(360 / this.turnScale) + '°)';
    }

    // True heading (yaw about the world's vertical axis), degrees clockwise
    // seen from above. Rotation matrix in the spec's order: Z alpha, then X
    // beta, then Y gamma.
    headingOf(e) {
      if (this.useAbsolute && typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
        return e.webkitCompassHeading;   // iOS: already a clockwise magnetic heading of the phone's top
      }
      const r = Math.PI / 180;
      const a = (e.alpha || 0) * r, b = (e.beta || 0) * r, g = (e.gamma || 0) * r;
      const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
      // Columns of R = Rz(a)·Rx(b)·Ry(g): the device's y axis (top edge) and
      // z axis (out of the screen) in world x=east, y=north, z=up.
      const top = [-sA * cB, cA * cB, sB];
      const back = [-(cA * sG + sA * sB * cG), -(sA * sG - cA * sB * cG), -cB * cG];  // minus device z
      // Flat phone -> the top edge alone (rolling it cannot leak in through
      // the screen normal); upright -> the back alone; smoothly in between.
      const wt = top[0] * top[0] + top[1] * top[1];
      const wb = top[2] * top[2];
      const fx = top[0] * wt + back[0] * wb, fy = top[1] * wt + back[1] * wb;
      if (fx * fx + fy * fy < 1e-6) return this._raw;   // no horizontal direction to read: hold
      return (Math.atan2(fx, fy) * 180 / Math.PI + 360) % 360;
    }

    _event(e) {
      if (e.alpha === null && typeof e.webkitCompassHeading !== 'number') return;
      this._raw = this.headingOf(e);
      if (this._last !== null) this._unwrapped += wrap180(this._raw - this._last);
      this._last = this._raw;
      // The first reading is the zero: stems must not jump to wherever the
      // phone happens to point when motion is switched on.
      if (this._needZero) { this._zero = this._unwrapped; this._needZero = false; }
      if (!this.seen) { this.seen = true; if (this.onFirst) this.onFirst(); }
      let turn = wrap180((this._unwrapped - this._zero) * (this.useAbsolute ? 1 : this.turnScale));
      if (this.invert) turn = -turn;
      if (this.onTurn) this.onTurn(turn);
      if (this.onReading) {
        const h = this._rate || (this._rate = { n: 0, t: 0, hz: 0 });
        h.n++;
        const now = Date.now();
        if (!h.t || now - h.t > 500) {
          if (h.t) h.hz = Math.round(h.n * 1000 / (now - h.t));
          h.t = now; h.n = 0;
          const cal = this.calStart !== null ? ' · calibrating: ' + Math.round(this._unwrapped - this.calStart) + '°' : '';
          this.onReading('sensor ' + (h.hz || '?') + ' Hz · gyro ' + (this.gyroPresent === null ? '?' : this.gyroPresent ? 'yes' : 'NO') +
            (e.absolute || (this.useAbsolute && typeof e.webkitCompassHeading === 'number') ? ' · compass' : ' · gyro') +
            ' · heading ' + Math.round(this._raw) + '°, turn ' + Math.round(turn) + '°' + cal);
        }
      }
    }
  }

  window.SSPhoneTurn = PhoneTurn;
})();
