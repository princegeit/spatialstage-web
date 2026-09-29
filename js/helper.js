// Talks to SpatialStage Helper (helper/spatialstage_helper.py): a small
// program the user installs once, which splits songs into stems with
// Demucs on their own PC. The page decodes the song itself (so anything the
// browser can play works, and the helper needs no ffmpeg), sends it as a
// 44.1 kHz 16-bit WAV to 127.0.0.1, and fetches the stems back.
//
// Chrome and Edge ask the user once before a page on the internet may talk
// to this PC ("look for and connect to devices on your local network"), so
// nothing here probes the helper until the user has asked for it, or has
// connected before (remembered in localStorage).
(function () {
  const PORT = 47800;
  const BASE = 'http://127.0.0.1:' + PORT + '/v1';
  const MIN_VERSION = '1.0.0';
  const SEEN_KEY = 'spatialstage.helper.seen';

  async function call(path, init, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 5000);
    try {
      return await fetch(BASE + path, Object.assign({ mode: 'cors', cache: 'no-store', signal: ctl.signal }, init));
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'the helper did not answer' : 'the helper is not running');
    } finally { clearTimeout(timer); }
  }

  async function json(path, init, timeoutMs) {
    const r = await call(path, init, timeoutMs);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(body.error || 'the helper answered ' + r.status); e.status = r.status; throw e; }
    return body;
  }

  const versionAtLeast = (v, min) => {
    const a = String(v || '0').split('.').map(Number), b = min.split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); }
    return true;
  };

  const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

  const Helper = {
    port: PORT,
    info: null, // the last /status answer, or null when it could not be reached

    get seen() { try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return false; } },

    async probe() {
      try {
        const s = await json('/status', {}, 2500);
        if (s.app !== 'spatialstage-helper') throw new Error('not the helper');
        this.info = s;
        try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) {}
      } catch (e) { this.info = null; }
      return this.info;
    },
    get outdated() { return !!this.info && !versionAtLeast(this.info.version, MIN_VERSION); },

    songs: () => json('/songs').then(r => r.songs || []),
    async song(id) {
      try { return await json('/songs/' + id); }
      catch (e) { if (e.status === 404) return null; throw e; }
    },
    removeSong: (id) => json('/songs/' + id, { method: 'DELETE' }),
    async stemFile(id, stem) {
      const r = await call('/songs/' + id + '/' + stem + '.wav', {}, 120000);
      if (!r.ok) throw new Error('the helper has no ' + stem + ' for this song');
      return new File([await r.blob()], stem + '.wav', { type: 'audio/wav' });
    },
    startJob: (wav, key, name, model) => json('/jobs?key=' + key + '&model=' + encodeURIComponent(model) + '&name=' + encodeURIComponent(name),
      { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav }, 300000),
    job: (id) => json('/jobs/' + id),
    cancel: (id) => json('/jobs/' + id, { method: 'DELETE' }),

    // Helper 1.1+: drum kit parts for a song it has split, and the LED relay.
    supports(feature) { return !!this.info && Array.isArray(this.info.features) && this.info.features.includes(feature); },
    startParts: (id) => json('/songs/' + id + '/parts', { method: 'POST' }, 30000),
    // One WLED packet, passed on as UDP by the helper. No JSON back (204).
    async led(frame, host, port) {
      const r = await call('/led?host=' + encodeURIComponent(host) + '&port=' + (port || 21324),
        { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: frame }, 2000);
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || 'the helper answered ' + r.status); }
    },

    // The helper's cache key: a hash of the file's bytes, so a song is
    // recognised as already split however it is named or wherever it
    // comes from. crypto.subtle only exists on https / localhost / file
    // pages; elsewhere a cheaper fingerprint of size + sampled bytes does.
    async fileKey(file) {
      const buf = await file.arrayBuffer();
      if (window.crypto && crypto.subtle) return hex(await crypto.subtle.digest('SHA-256', buf)).slice(0, 32);
      const u8 = new Uint8Array(buf);
      let h1 = 0x811c9dc5 ^ u8.length, h2 = 0x01000193 + u8.length;
      const step = Math.max(1, Math.floor(u8.length / 1000000));
      for (let i = 0; i < u8.length; i += step) { h1 = Math.imul(h1 ^ u8[i], 16777619); h2 = Math.imul(h2 + u8[i], 2246822519) ^ (h2 >>> 13); }
      return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).repeat(2);
    },

    // What the helper takes: the song decoded by the browser, resampled to
    // Demucs' 44.1 kHz, stereo, 16-bit.
    async toWav(file) {
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const ctx = new Ctx(2, 44100, 44100);
      const audio = await ctx.decodeAudioData(await file.arrayBuffer());
      const L = audio.getChannelData(0), R = audio.numberOfChannels > 1 ? audio.getChannelData(1) : L;
      return new Blob([SSWav.encodeWav([L, R], 44100)], { type: 'audio/wav' });
    },
  };

  window.SSHelper = Helper;
})();
