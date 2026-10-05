// Song loading, with no server in the loop.
//
//   scanFiles(files)        -> song descriptors (cheap: names + WAV headers only)
//   decodeSong(desc, engine)-> { name, sampleRate, stems: { vocals: [L, R], ... } }
//
// Decoding is deferred until a song is actually selected because a decoded
// show file is ~2 MB per second of audio per six stems (float32 x 12 x 44.1
// kHz) - a 5-minute track is ~600 MB, twice that with drum parts, which is
// fine once at a time on a desktop and survivable on a phone, but not
// multiplied by a whole set list. The descriptor keeps the File handles; the
// engine drops the previous song's buffers when the next one loads.
//
// Two shapes are accepted:
//   1. A show WAV from pipeline/showfile.py - channels are stem pairs in
//      stems.txt order (2i = left, 2i+1 = right): 12 channels for the six
//      Demucs stems, 24 once the drums have been split into kit parts.
//   2. Separate stem files, matched to slots by a stem name in the file
//      name (SSStems.stemOfName - the same rule the Pd rig's import uses):
//      Demucs' vocals.wav / drums.wav ..., "Song - drums.wav", a
//      "melody"/"keys" export from an online splitter, kick/snare/... from a
//      drum splitter. Files in one folder with the same non-stem name are
//      grouped into one song; bare vocals.wav / drums.wav ... take their
//      folder's name (drop the folder). Slots with no file stay silent -
//      ROADMAP item 0's bring-your-own-stems path, done in the browser.
//      With kit parts present the drums card plays drums_rest.wav (what the
//      parts did not catch) - or nothing if there is no leftover, since the
//      full drums on top of the parts would play the kit twice. Same rule as
//      pipeline/showfile.py's plan().
// Anything else (a plain stereo song, no stem name) loads as a single
// "other" stem, so an un-split track still plays and can still be moved -
// until SpatialStage Helper splits it (app.js), which turns the descriptor
// into kind 'helper': { helperId, stems, file } with the stems fetched from
// the helper at load time.
(function () {
  const { STEMS, BASE_STEMS, DRUM_PARTS, LEFTOVER, stemOfName } = SSStems;

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
    return { key: pathOf(file).split('/').slice(0, -1).join('/') + '|' + name.toLowerCase(), name: name || folder, titled: !!name };
  }

  // Which file plays in each slot of a stem group ({ stem|drums_rest: File }),
  // following showfile.py: with kit parts, the drums slot is the leftover.
  function slotFiles(files) {
    const out = {};
    const parts = DRUM_PARTS.some((p) => files[p]);
    for (const s of STEMS) {
      if (s === 'drums' && parts) { if (files[LEFTOVER]) out.drums = files[LEFTOVER]; }
      else if (files[s]) out[s] = files[s];
    }
    return out;
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

  // Stems a show file with this many channels carries: a pair each, in
  // stems.txt order.
  const showStems = (channels) => STEMS.slice(0, Math.min(STEMS.length, Math.floor(channels / 2)));

  async function scanFiles(files) {
    const songs = [];
    const groups = {};
    const plain = [];
    for (const f of files) {
      if (!isAudio(f)) continue;
      const match = stemOfName(f.name);
      if (match) {
        const g = groupOf(f, match);
        const grp = groups[g.key] = groups[g.key] || { name: g.name, files: {}, all: [], bare: !g.titled };
        // Two files claiming one slot (vocals.wav and vocals.mp3): keep the
        // first rather than silently swapping in whichever came last.
        if (!grp.files[match.stem]) grp.files[match.stem] = f;
        grp.all.push(f);
        continue;
      }
      plain.push(f);
    }
    // A lone file with a stem word somewhere in its title ("Bass Head.mp3",
    // "Rest of My Life.flac") is a song, not one stem of a song called
    // "Head" - it only counts as a stem when it has siblings, or when its
    // name is nothing but the stem ("vocals.wav").
    for (const key in groups) {
      const g = groups[key];
      if (g.all.length === 1 && !g.bare) { plain.push(g.all[0]); delete groups[key]; }
    }
    for (const f of plain) {
      const info = await probeWav(f);
      const name = f.name.replace(/\.[^.]+$/, '');
      if (info && info.channels >= 12) {
        const has = showStems(info.channels);
        songs.push({ name, kind: 'show', file: f, duration: info.duration, slots: STEMS.map((s) => has.includes(s)) });
      } else if (info && info.channels === 6) {
        songs.push({ name, kind: 'show-mono', file: f, duration: info.duration, slots: STEMS.map((s) => BASE_STEMS.includes(s)) });
      } else {
        songs.push({ name, kind: 'single', file: f, duration: info ? info.duration : null, slots: STEMS.map((s) => s === 'other') });
      }
    }
    for (const key in groups) {
      const g = groups[key];
      const files = slotFiles(g.files);
      // Stems from different files can differ in length; the song lasts as
      // long as the longest one.
      let duration = null;
      for (const s of STEMS) if (files[s]) { const info = await probeWav(files[s]); if (info) duration = Math.max(duration || 0, info.duration); }
      songs.push({ name: g.name || 'Untitled stems', kind: 'stems', files, duration, slots: STEMS.map((s) => !!files[s]) });
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

  // A pair that is silent from start to end (a drum-part slot of a song
  // whose parts are all rests, say) is not worth an AudioBuffer.
  function silent(pair) {
    for (const ch of pair) for (let i = 0; i < ch.length; i += 7) if (ch[i] !== 0) return false;
    return true;
  }

  // One file per stem, from wherever getFile(stem) finds it.
  async function decodeStems(desc, todo, getFile, engine, report) {
    const stems = {};
    let rate = null;
    for (let k = 0; k < todo.length; k++) {
      const s = todo[k];
      report(k / todo.length, s);
      const f = await getFile(s);
      const d = await decodeFile(f, engine, (x) => report((k + x) / todo.length, f.name));
      if (rate === null) rate = d.sampleRate;
      stems[s] = matchRate(pairFrom(d.channels), d.sampleRate, rate);
    }
    report(1, desc.name);
    return { name: desc.name, sampleRate: rate, stems };
  }

  // onProgress(fraction 0..1, label) - fraction covers the whole song, so a
  // six-file stem set reports one steady bar rather than six resets.
  async function decodeSong(desc, engine, onProgress) {
    const report = (x, label) => { if (onProgress) onProgress(Math.max(0, Math.min(1, x)), label); };
    const stems = {};
    if (desc.kind === 'stems') {
      return decodeStems(desc, STEMS.filter((s) => desc.files[s]), (s) => desc.files[s], engine, report);
    }
    // Split by SpatialStage Helper (js/helper.js): the stems live on this
    // PC's helper, not in the page. If the helper has been closed since,
    // the song still plays - from the original file, as one sound. With
    // drum parts, the helper's drums_rest plays on the drums card.
    if (desc.kind === 'helper') {
      const parts = DRUM_PARTS.some((p) => desc.stems.includes(p));
      const fileOf = (s) => (s === 'drums' && parts ? LEFTOVER : s);
      const todo = STEMS.filter((s) => desc.stems.includes(fileOf(s)));
      try {
        return await decodeStems(desc, todo, (s) => SSHelper.stemFile(desc.helperId, fileOf(s)), engine, report);
      } catch (e) {
        if (!desc.file) throw new Error(e.message + ' - start SpatialStage Helper to play this song');
        const d = await decodeFile(desc.file, engine, (x) => report(x, desc.file.name));
        return { name: desc.name, sampleRate: d.sampleRate, stems: { other: pairFrom(d.channels) }, fallback: e.message };
      }
    }
    report(0, desc.file.name);
    const d = await decodeFile(desc.file, engine, (x) => report(x, desc.file.name));
    report(1, desc.file.name);
    if (d.channels.length >= 12) {
      showStems(d.channels.length).forEach((s, i) => {
        const pair = [d.channels[2 * i], d.channels[2 * i + 1]];
        if (!silent(pair)) stems[s] = pair;   // a stem with no sound is not in the song
      });
    } else if (d.channels.length === 6) {
      BASE_STEMS.forEach((s, i) => { stems[s] = [d.channels[i], d.channels[i]]; });
    } else {
      stems.other = pairFrom(d.channels);
    }
    return { name: desc.name, sampleRate: d.sampleRate, stems };
  }

  // One dropped file for one stem slot: { sampleRate, pair: [L, R] }.
  async function decodeStemFile(file, engine) {
    const d = await decodeFile(file, engine, () => {});
    return { sampleRate: d.sampleRate, pair: pairFrom(d.channels) };
  }

  window.SSSongs = { scanFiles, decodeSong, decodeStemFile, STEMS, slotFiles };
})();
