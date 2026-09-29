// MP3 for the record button - what the Pd rig's bridge makes with ffmpeg
// (convertTakeToMp3, -q:a 2), done in the page with LAME compiled to
// JavaScript (lamejs). Loaded from jsDelivr the first time an MP3 take is
// made, so nobody who records WAV (or never records) downloads it.
//
// encode({ channels: [L, R], sampleRate }, onProgress) -> Promise<Blob>.
// Encodes in slices with a yield between them, so a long take does not
// freeze the page; about 10-20x faster than real time on a laptop.
(function () {
  'use strict';
  const LAME_URL = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
  const KBPS = 192;               // ffmpeg -q:a 2 averages ~190 kbit/s
  const FRAME = 1152;             // samples per MP3 frame
  const SLICE = FRAME * 200;      // per yield
  const yieldNow = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

  let loading = null;
  function loadLame() {
    if (window.lamejs) return Promise.resolve(window.lamejs);
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = LAME_URL;
        s.onload = () => (window.lamejs ? resolve(window.lamejs) : reject(new Error('the MP3 encoder did not load')));
        s.onerror = () => { loading = null; reject(new Error('could not download the MP3 encoder (offline?)')); };
        document.head.appendChild(s);
      });
    }
    return loading;
  }

  const toInt16 = (f32, from, to) => {
    const out = new Int16Array(to - from);
    for (let i = from; i < to; i++) { const v = Math.max(-1, Math.min(1, f32[i])); out[i - from] = v < 0 ? v * 32768 : v * 32767; }
    return out;
  };

  // MP3 only knows 32, 44.1 and 48 kHz (at MPEG-1 rates); a device running
  // its audio at 88.2/96 kHz is brought down to 48 (linear - it is a
  // listening copy, not a master).
  function fitRate(take) {
    if ([32000, 44100, 48000].includes(take.sampleRate)) return take;
    const to = 48000, ratio = take.sampleRate / to;
    const channels = take.channels.map((src) => {
      const out = new Float32Array(Math.floor(src.length / ratio));
      for (let i = 0; i < out.length; i++) {
        const x = i * ratio, a = Math.floor(x), t = x - a;
        out[i] = src[a] * (1 - t) + (src[Math.min(a + 1, src.length - 1)] || 0) * t;
      }
      return out;
    });
    return { channels, sampleRate: to };
  }

  async function encode(take, onProgress) {
    const lame = await loadLame();
    take = fitRate(take);
    const [L, R] = take.channels;
    const enc = new lame.Mp3Encoder(2, take.sampleRate, KBPS);
    const chunks = [];
    for (let from = 0; from < L.length; from += SLICE) {
      const to = Math.min(L.length, from + SLICE);
      for (let f = from; f < to; f += FRAME) {
        const e = Math.min(to, f + FRAME);
        const buf = enc.encodeBuffer(toInt16(L, f, e), toInt16(R, f, e));
        if (buf.length) chunks.push(new Uint8Array(buf));
      }
      if (onProgress) onProgress(to / L.length);
      await yieldNow();
    }
    const end = enc.flush();
    if (end.length) chunks.push(new Uint8Array(end));
    return new Blob(chunks, { type: 'audio/mpeg' });
  }

  window.SSMp3 = { encode, load: loadLame };
})();
