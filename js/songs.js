// Song loading, with no server in the loop.
//
//   scanFiles(files)        -> song descriptors (cheap: names + WAV headers only)
//   decodeSong(desc, engine)-> { name, sampleRate, stems: { vocals: [L, R], ... } }
//
// Decoding is deferred until a song is actually selected because a decoded
// 12-channel song is ~2 MB per second of audio (float32 x 12 x 44.1 kHz) -
// a 5-minute track is ~600 MB, which is fine once at a time on a desktop
// and survivable on a phone, but not multiplied by a whole set list. The
// descriptor keeps the File handles; the engine drops the previous song's
// buffers when the next one loads.
//
// Two shapes are accepted:
//   1. A 12-channel show WAV from pipeline/auto_stem_pipeline.py - channels
//      are stem pairs in CHANNEL_ORDER (2i = left, 2i+1 = right).
//   2. Separate stem files, matched to slots by a stem name appearing in
//      the filename (Demucs' vocals.wav / drums.wav ..., or "Song - drums.wav",
//      or a "melody"/"keys" export from any online splitter). Files that
//      share a folder or the same non-stem prefix are grouped into one song.
//      Slots with no file stay silent - ROADMAP item 0's bring-your-own-
//      stems path, done in the browser instead of a script.
// Anything else (a plain stereo song, no stem name) loads as a single
// "other" stem, so an un-split track still plays and can still be moved.
(function () {
  const STEMS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
  const ALIASES = {
    vocals: ['vocals', 'vocal', 'vox', 'voice'],
    drums: ['drums', 'drum', 'percussion'],
    bass: ['bass'],
    guitar: ['guitar', 'gtr'],
    piano: ['piano', 'keys', 'keyboard', 'melody'],
    other: ['other', 'others', 'rest', 'instrumental', 'music', 'accompaniment'],
  };

  function stemOf(filename) {
    const base = filename.toLowerCase().replace(/\.[^.]+$/, '');
    // Split on anything that is not a letter, so "drums" matches in
    // "Song_drums", "song - drums", "drums" but "bassoon" does not.
    const words = base.split(/[^a-z]+/).filter(Boolean);
    for (const stem of STEMS) for (const a of ALIASES[stem]) if (words.includes(a)) return stem;
    return null;
  }

  // The song name a stem file belongs to: its folder when picked via a
  // directory, otherwise the filename with the stem word stripped.
  function groupKeyOf(file, stem) {
    const rel = file.webkitRelativePath || '';
    if (rel.includes('/')) return rel.split('/').slice(-2, -1)[0];
    let base = file.name.replace(/\.[^.]+$/, '');
    for (const a of ALIASES[stem]) base = base.replace(new RegExp('(^|[^a-z])' + a + '($|[^a-z])', 'i'), '$1$2');
    base = base.replace(/[\s\-_.]+$/g, '').replace(/^[\s\-_.]+/g, '').trim();
    return base || 'stems';
  }

  // Reads just the RIFF header to learn channel count and duration without
  // decoding. Returns null for anything that is not a WAV.
  async function probeWav(file) {
    try {
      const head = new DataView(await file.slice(0, 4096).arrayBuffer());
      const tag = (o) => String.fromCharCode(head.getUint8(o), head.getUint8(o + 1), head.getUint8(o + 2), head.getUint8(o + 3));
      if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
      let off = 12, fmt = null, dataSize = null;
      while (off + 8 <= head.byteLength) {
        const id = tag(off), size = head.getUint32(off + 4, true);
        if (id === 'fmt ') fmt = { channels: head.getUint16(off + 10, true), rate: head.getUint32(off + 12, true), bits: head.getUint16(off + 22, true) };
        if (id === 'data') { dataSize = size; break; }
        off += 8 + size + (size & 1);
      }
      if (!fmt) return null;
      if (dataSize === null || dataSize === 0xFFFFFFFF) dataSize = file.size - 44;
      return { channels: fmt.channels, sampleRate: fmt.rate, duration: dataSize / (fmt.rate * fmt.channels * fmt.bits / 8) };
    } catch (e) { return null; }
  }

  async function scanFiles(files) {
    const songs = [];
    const groups = {};
    for (const f of files) {
      const stem = stemOf(f.name);
      if (stem) {
        const key = groupKeyOf(f, stem);
        (groups[key] = groups[key] || { name: key, files: {} }).files[stem] = f;
        continue;
      }
      const info = await probeWav(f);
      const name = f.name.replace(/\.[^.]+$/, '');
      if (info && info.channels >= 12) {
        songs.push({ name, kind: 'show', file: f, duration: info.duration, slots: STEMS.map(() => true) });
      } else if (info && info.channels === 6) {
        songs.push({ name, kind: 'show-mono', file: f, duration: info.duration, slots: STEMS.map(() => true) });
      } else {
        songs.push({ name, kind: 'single', file: f, duration: info ? info.duration : null, slots: STEMS.map((s) => s === 'other') });
      }
    }
    for (const key in groups) {
      const g = groups[key];
      let duration = null;
      for (const s of STEMS) if (g.files[s]) { const info = await probeWav(g.files[s]); if (info) { duration = info.duration; break; } }
      songs.push({ name: g.name, kind: 'stems', files: g.files, duration, slots: STEMS.map((s) => !!g.files[s]) });
    }
    return songs;
  }

  async function decodeFile(file, engine) {
    const buf = await file.arrayBuffer();
    try {
      return SSWav.parseWav(buf); // { sampleRate, channels }
    } catch (e) {
      // Compressed (mp3/m4a/flac/ogg) or a WAV flavour the parser skips:
      // the browser's decoder handles it (and resamples to the context).
      const ctx = await engine.ensure();
      const ab = await ctx.decodeAudioData(buf.slice(0));
      const channels = [];
      for (let c = 0; c < ab.numberOfChannels; c++) channels.push(ab.getChannelData(c));
      return { sampleRate: ab.sampleRate, channels };
    }
  }

  function pairFrom(channels) {
    if (channels.length >= 2) return [channels[0], channels[1]];
    return [channels[0], channels[0]];
  }

  // Linear resampler, used only when stems of one song disagree on rate.
  function matchRate(pair, from, to) {
    if (from === to) return pair;
    const ratio = from / to;
    const n = Math.floor(pair[0].length / ratio);
    return pair.map((src) => {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = i * ratio, a = Math.floor(x), t = x - a;
        out[i] = src[a] * (1 - t) + (src[Math.min(a + 1, src.length - 1)] || 0) * t;
      }
      return out;
    });
  }

  async function decodeSong(desc, engine, onProgress) {
    const stems = {};
    if (desc.kind === 'stems') {
      let rate = null;
      for (const s of STEMS) {
        const f = desc.files[s];
        if (!f) continue;
        onProgress && onProgress('decoding ' + f.name + '...');
        const d = await decodeFile(f, engine);
        if (rate === null) rate = d.sampleRate;
        stems[s] = matchRate(pairFrom(d.channels), d.sampleRate, rate);
      }
      return { name: desc.name, sampleRate: rate, stems };
    }
    onProgress && onProgress('decoding ' + desc.file.name + '...');
    const d = await decodeFile(desc.file, engine);
    if (d.channels.length >= 12) {
      STEMS.forEach((s, i) => { stems[s] = [d.channels[2 * i], d.channels[2 * i + 1]]; });
    } else if (d.channels.length === 6) {
      STEMS.forEach((s, i) => { stems[s] = [d.channels[i], d.channels[i]]; });
    } else {
      stems.other = pairFrom(d.channels);
    }
    return { name: desc.name, sampleRate: d.sampleRate, stems };
  }

  window.SSSongs = { scanFiles, decodeSong, STEMS };
})();
