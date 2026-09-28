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
//      or a "melody"/"keys" export from any online splitter). Files in one
//      folder with the same non-stem name are grouped into one song; bare
//      vocals.wav / drums.wav ... take their folder's name (drop the folder).
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

  const ALIAS_TO_STEM = {};
  for (const s of STEMS) for (const a of ALIASES[s]) ALIAS_TO_STEM[a] = s;

  // The stem a filename names, and where that word sits in it. Words are
  // runs of letters, so "drums" matches in "Song_drums", "song - drums",
  // "drums2" but "bassoon" does not. The LAST stem word wins: splitters put
  // the stem at the end ("Other Track - vocals", "1_Song_(Vocals)"), and a
  // stem word earlier on is usually part of the song title.
  function stemMatch(filename) {
    const base = filename.replace(/\.[^.]+$/, '');
    const re = /[a-z]+/gi;
    let m, hit = null;
    while ((m = re.exec(base))) {
      const stem = ALIAS_TO_STEM[m[0].toLowerCase()];
      if (stem) hit = { stem, index: m.index, length: m[0].length };
    }
    return hit;
  }
  // Where a file came from: set by the folder-drop walker in app.js, or by
  // a directory picker.
  const pathOf = (file) => file.ssPath || file.webkitRelativePath || '';
  const folderOf = (file) => { const parts = pathOf(file).split('/'); return parts.length > 1 ? parts[parts.length - 2] : ''; };

  // The song a stem file belongs to: the filename with its stem word cut
  // out ("Song - drums" -> "Song"), or, when that leaves nothing (Demucs'
  // bare vocals.wav / drums.wav ...), the folder it came from. Files from
  // different folders never merge, even when their names match.
  function groupOf(file, match) {
    const base = file.name.replace(/\.[^.]+$/, '');
    let name = base.slice(0, match.index) + base.slice(match.index + match.length);
    name = name.replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, '')      // "Song (Vocals)" -> "Song ()" -> "Song"
      .replace(/^[\s\-_.,]+|[\s\-_.,]+$/g, '')
      .replace(/\s{2,}/g, ' ');
    const folder = folderOf(file);
    return { key: pathOf(file).split('/').slice(0, -1).join('/') + '|' + name.toLowerCase(), name: name || folder };
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

  // Files the decoder cannot use at all - cover art, cue sheets, a
  // Demucs log - are skipped rather than listed as unplayable songs.
  const AUDIO_EXT = /\.(wav|wave|flac|mp3|m4a|aac|mp4|ogg|oga|opus|webm|aif|aiff|caf)$/i;
  const isAudio = (f) => AUDIO_EXT.test(f.name) || (f.type || '').startsWith('audio/');

  async function scanFiles(files) {
    const songs = [];
    const groups = {};
    for (const f of files) {
      if (!isAudio(f)) continue;
      const match = stemMatch(f.name);
      if (match) {
        const g = groupOf(f, match);
        const grp = groups[g.key] = groups[g.key] || { name: g.name, files: {} };
        // Two files claiming one slot (vocals.wav and vocals.mp3): keep the
        // first rather than silently swapping in whichever came last.
        if (!grp.files[match.stem]) grp.files[match.stem] = f;
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
      // Stems from different files can differ in length; the song lasts as
      // long as the longest one.
      let duration = null;
      for (const s of STEMS) if (g.files[s]) { const info = await probeWav(g.files[s]); if (info) duration = Math.max(duration || 0, info.duration); }
      songs.push({ name: g.name || 'Untitled stems', kind: 'stems', files: g.files, duration, slots: STEMS.map((s) => !!g.files[s]) });
    }
    // Pickers and drops hand files over in no particular order.
    return songs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }

  async function decodeFile(file, engine, onFraction) {
    const buf = await file.arrayBuffer();
    try {
      return await SSWav.parseWav(buf, onFraction); // { sampleRate, channels }
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

  // onProgress(fraction 0..1, label) - fraction covers the whole song, so a
  // six-file stem set reports one steady bar rather than six resets.
  async function decodeSong(desc, engine, onProgress) {
    const report = (x, label) => { if (onProgress) onProgress(Math.max(0, Math.min(1, x)), label); };
    const stems = {};
    if (desc.kind === 'stems') {
      let rate = null;
      const todo = STEMS.filter((s) => desc.files[s]);
      for (let k = 0; k < todo.length; k++) {
        const s = todo[k], f = desc.files[s];
        report(k / todo.length, f.name);
        const d = await decodeFile(f, engine, (x) => report((k + x) / todo.length, f.name));
        if (rate === null) rate = d.sampleRate;
        stems[s] = matchRate(pairFrom(d.channels), d.sampleRate, rate);
      }
      report(1, desc.name);
      return { name: desc.name, sampleRate: rate, stems };
    }
    report(0, desc.file.name);
    const d = await decodeFile(desc.file, engine, (x) => report(x, desc.file.name));
    report(1, desc.file.name);
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
