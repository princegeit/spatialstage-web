// Hand tracking source: camera -> MediaPipe Hand Landmarker -> per-hand
// { position, pinch, fist } at video rate. Everything runs on-device in the
// browser (WASM + WebGL); no frame ever leaves the page.
//
// Library: @mediapipe/tasks-vision, pinned to the last 0.10.x (1.0.0 shipped
// the day before this was written; the 0.10 API below is the documented
// one). Loaded lazily with a dynamic import() the first time the user turns
// hand tracking on, so the page costs nothing extra for people who never
// use it. The ~11 MB WASM and ~8 MB model are fetched from jsDelivr /
// Google's model bucket and cached by the browser.
//
// Coordinates handed to the caller are normalised to the video frame,
// 0..1, origin top-left, x already MIRRORED for a front camera so moving
// your hand to your right moves the cursor to the right on screen.
//
// Gestures (derived from the 21 landmarks, see LANDMARK indices):
//   pinch - thumb tip (4) to index tip (8) distance, relative to palm size
//           (wrist 0 to middle-finger MCP 9), with hysteresis so a held
//           pinch does not flicker on the boundary.
//   fist  - all four fingertips (8/12/16/20) closer to the wrist than their
//           own PIP joints (6/10/14/18): fingers curled.
(function () {
  const MP_VERSION = '0.10.35';
  const MP_BUNDLE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + MP_VERSION + '/vision_bundle.mjs';
  const MP_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + MP_VERSION + '/wasm';
  const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

  const PINCH_ON = 0.32, PINCH_OFF = 0.48;
  const SMOOTH = 0.55; // per-frame lerp on the palm position; the motion smoother adds more downstream

  // Landmark pairs to draw as bones on the preview canvas.
  const BONES = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
  ];

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  class HandTracker {
    constructor() {
      this.landmarker = null;
      this.stream = null;
      this.video = null; this.canvas = null;
      this.running = false;
      this.mirror = true;
      this.facing = 'user';
      this.onHands = null;      // (hands: Hand[]) => void, called every processed frame
      this.onStatus = null;     // (text) => void
      this.hands = [];
      this._state = [{}, {}];   // per-slot smoothing + pinch hysteresis
      this.fps = 0; this._frames = 0; this._fpsAt = 0;
      this.lastTs = -1;
    }

    _status(t) { if (this.onStatus) this.onStatus(t); }

    async load() {
      if (this.landmarker) return;
      this._status('loading hand model...');
      const vision = await import(MP_BUNDLE);
      const fileset = await vision.FilesetResolver.forVisionTasks(MP_WASM);
      const make = (delegate) => vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      // The model is an 8 MB download from a Google bucket; a dropped
      // connection mid-way throws, so one retry before giving up. A GPU
      // delegate failure (no WebGL2) falls back to CPU, which is slower but
      // still real-time for two hands.
      let lastErr = null;
      for (let attempt = 0; attempt < 2 && !this.landmarker; attempt++) {
        try { this.landmarker = await make('GPU'); }
        catch (e) {
          lastErr = e;
          try { this.landmarker = await make('CPU'); }
          catch (e2) { lastErr = e2; this._status('model download failed, retrying...'); }
        }
      }
      if (!this.landmarker) throw new Error('could not load the hand model (' + (lastErr && lastErr.message) + ')');
    }

    async start(video, canvas, facing) {
      if (this.running) return;
      this.video = video; this.canvas = canvas;
      if (facing) this.facing = facing;
      this.mirror = this.facing === 'user';
      await this.load();
      this._status('opening camera...');
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      video.srcObject = this.stream;
      video.muted = true; video.playsInline = true;
      await video.play();
      this.running = true;
      this._fpsAt = performance.now(); this._frames = 0;
      this._status('tracking');
      this._loop();
    }

    stop() {
      this.running = false;
      if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); this.stream = null; }
      if (this.video) this.video.srcObject = null;
      this.hands = [];
      if (this.canvas) { const g = this.canvas.getContext('2d'); g.clearRect(0, 0, this.canvas.width, this.canvas.height); }
      if (this.onHands) this.onHands([]);
      this._status('off');
    }

    async switchCamera() {
      const was = this.running;
      const v = this.video, c = this.canvas;
      this.stop();
      this.facing = this.facing === 'user' ? 'environment' : 'user';
      if (was) await this.start(v, c);
    }

    _loop() {
      if (!this.running) return;
      const video = this.video;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        // detectForVideo requires strictly increasing timestamps.
        const ts = Math.max(performance.now(), this.lastTs + 1);
        this.lastTs = ts;
        let result = null;
        try { result = this.landmarker.detectForVideo(video, ts); } catch (e) { console.warn('hand detect failed:', e.message); }
        if (result) this._process(result);
        this._frames++;
        const now = performance.now();
        if (now - this._fpsAt >= 1000) { this.fps = this._frames * 1000 / (now - this._fpsAt); this._frames = 0; this._fpsAt = now; }
      }
      // rAF stalls in a background tab, which is fine: nothing to track then.
      requestAnimationFrame(() => this._loop());
    }

    _process(result) {
      const lms = result.landmarks || [];
      const hands = [];
      for (let i = 0; i < Math.min(2, lms.length); i++) {
        const lm = lms[i];
        const label = result.handedness && result.handedness[i] && result.handedness[i][0] ? result.handedness[i][0].categoryName : '';
        // Palm centre: mean of wrist and the four finger MCPs - steadier
        // than the wrist alone, and does not jump when fingers curl.
        let px = 0, py = 0;
        for (const k of [0, 5, 9, 13, 17]) { px += lm[k].x; py += lm[k].y; }
        px /= 5; py /= 5;
        if (this.mirror) px = 1 - px;
        const palm = dist(lm[0], lm[9]) || 1e-6;
        const pinchRatio = dist(lm[4], lm[8]) / palm;
        const st = this._state[i];
        // Hysteresis on pinch.
        if (st.pinch) { if (pinchRatio > PINCH_OFF) st.pinch = false; }
        else if (pinchRatio < PINCH_ON) st.pinch = true;
        let curled = 0;
        for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) if (dist(lm[tip], lm[0]) < dist(lm[pip], lm[0])) curled++;
        const fist = curled >= 4;
        if (st.x === undefined) { st.x = px; st.y = py; }
        st.x += SMOOTH * (px - st.x); st.y += SMOOTH * (py - st.y);
        hands.push({ index: i, x: st.x, y: st.y, pinch: !!st.pinch, fist, pinchRatio, handedness: this.mirror ? label : (label === 'Left' ? 'Right' : label === 'Right' ? 'Left' : label), landmarks: lm });
      }
      // Slots for hands no longer seen forget their smoothing state.
      for (let i = hands.length; i < 2; i++) this._state[i] = {};
      this.hands = hands;
      this._draw(lms, hands);
      if (this.onHands) this.onHands(hands);
    }

    _draw(lms, hands) {
      const c = this.canvas; if (!c) return;
      const v = this.video;
      if (c.width !== v.videoWidth || c.height !== v.videoHeight) { c.width = v.videoWidth; c.height = v.videoHeight; }
      const g = c.getContext('2d');
      g.clearRect(0, 0, c.width, c.height);
      g.save();
      if (this.mirror) { g.translate(c.width, 0); g.scale(-1, 1); }
      g.lineWidth = 3; g.lineCap = 'round';
      lms.forEach((lm, i) => {
        const h = hands[i];
        const colour = i === 0 ? '#00ff88' : '#ffcc33';
        g.strokeStyle = h && h.pinch ? '#fff' : colour;
        g.beginPath();
        for (const [a, b] of BONES) { g.moveTo(lm[a].x * c.width, lm[a].y * c.height); g.lineTo(lm[b].x * c.width, lm[b].y * c.height); }
        g.stroke();
        g.fillStyle = h && h.fist ? '#f55' : colour;
        for (const p of lm) { g.beginPath(); g.arc(p.x * c.width, p.y * c.height, 4, 0, Math.PI * 2); g.fill(); }
        if (h && h.pinch) {
          g.strokeStyle = '#fff'; g.lineWidth = 2;
          g.beginPath(); g.arc(lm[8].x * c.width, lm[8].y * c.height, 14, 0, Math.PI * 2); g.stroke();
          g.lineWidth = 3;
        }
      });
      g.restore();
    }
  }

  window.SSHandTracker = HandTracker;
})();
