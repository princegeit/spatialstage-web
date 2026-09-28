// Minimal RIFF/WAVE parser for the pipeline's 12-channel show files.
//
// Written rather than relying on AudioContext.decodeAudioData because
// browser support for >8-channel WAV is inconsistent (Chrome decodes it,
// Safari historically truncates or rejects it), and the show files are
// plain PCM anyway - see pipeline/auto_stem_pipeline.py's merge step, which
// writes WAVE_FORMAT_EXTENSIBLE (0xFFFE) 24-bit at 44.1 kHz. Handles PCM
// 16/24/32-bit int and 32-bit float, with or without the EXTENSIBLE header.
//
// Returns (a promise of) { sampleRate, channels: Float32Array[] } - one array
// per channel, deinterleaved, in [-1, 1]. Anything that is not a WAV throws,
// and the caller falls back to decodeAudioData for compressed stems.
//
// The deinterleave runs in slices with a yield to the event loop between
// them: a 5-minute 12-channel show file is ~160 M samples, which as one
// synchronous loop froze the page for seconds with no way to show progress.
(function () {
  const SLICE_SAMPLES = 4000000; // per yield; ~20-40 ms of work
  // A MessageChannel hop instead of setTimeout(0): timers are clamped to
  // 1 s in a background tab, which would stretch a decode to minutes.
  const yieldNow = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

  async function parseWav(arrayBuffer, onProgress) {
    const dv = new DataView(arrayBuffer);
    const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');

    let fmt = null, dataOffset = -1, dataLength = 0;
    let off = 12;
    while (off + 8 <= dv.byteLength) {
      const id = tag(off);
      const size = dv.getUint32(off + 4, true);
      const body = off + 8;
      if (id === 'fmt ') {
        let format = dv.getUint16(body, true);
        const numChannels = dv.getUint16(body + 2, true);
        const sampleRate = dv.getUint32(body + 4, true);
        const bitsPerSample = dv.getUint16(body + 14, true);
        // WAVE_FORMAT_EXTENSIBLE: the real format tag is the first two bytes
        // of the 16-byte SubFormat GUID at offset 24 of the chunk body.
        if (format === 0xFFFE && size >= 40) format = dv.getUint16(body + 24, true);
        fmt = { format, numChannels, sampleRate, bitsPerSample };
      } else if (id === 'data') {
        dataOffset = body;
        // A streaming writer may leave the size as 0 or 0xFFFFFFFF; clamp to
        // what is actually in the buffer.
        dataLength = Math.min(size, dv.byteLength - body);
      }
      off = body + size + (size & 1);
    }
    if (!fmt) throw new Error('WAV has no fmt chunk');
    if (dataOffset < 0) throw new Error('WAV has no data chunk');

    const { format, numChannels, sampleRate, bitsPerSample } = fmt;
    const bytesPer = bitsPerSample / 8;
    const frames = Math.floor(dataLength / (bytesPer * numChannels));
    const channels = [];
    for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(frames));

    const isFloat = format === 3;
    if (format !== 1 && !isFloat) throw new Error('unsupported WAV format tag ' + format);

    // One reader per sample layout; each converts frames [from, to).
    let p = dataOffset, read;
    if (isFloat && bitsPerSample === 32) {
      read = (from, to) => { for (let i = from; i < to; i++) for (let c = 0; c < numChannels; c++) { channels[c][i] = dv.getFloat32(p, true); p += 4; } };
    } else if (!isFloat && bitsPerSample === 16) {
      read = (from, to) => { for (let i = from; i < to; i++) for (let c = 0; c < numChannels; c++) { channels[c][i] = dv.getInt16(p, true) / 32768; p += 2; } };
    } else if (!isFloat && bitsPerSample === 24) {
      const u8 = new Uint8Array(arrayBuffer);
      read = (from, to) => {
        for (let i = from; i < to; i++) for (let c = 0; c < numChannels; c++) {
          let v = u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16);
          if (v & 0x800000) v |= ~0xFFFFFF;
          channels[c][i] = v / 8388608; p += 3;
        }
      };
    } else if (!isFloat && bitsPerSample === 32) {
      read = (from, to) => { for (let i = from; i < to; i++) for (let c = 0; c < numChannels; c++) { channels[c][i] = dv.getInt32(p, true) / 2147483648; p += 4; } };
    } else {
      throw new Error('unsupported WAV ' + (isFloat ? 'float ' : '') + 'bit depth ' + bitsPerSample);
    }
    const step = Math.max(1, Math.floor(SLICE_SAMPLES / Math.max(1, numChannels)));
    for (let from = 0; from < frames; from += step) {
      read(from, Math.min(frames, from + step));
      if (from + step < frames) {
        if (onProgress) onProgress((from + step) / frames);
        await yieldNow();
      }
    }
    return { sampleRate, channels };
  }

  // Encodes interleaved Float32 channel data as 16-bit PCM WAV - used for
  // the record button so a take downloads as a file any DAW opens, instead
  // of MediaRecorder's browser-specific webm/opus.
  function encodeWav(channels, sampleRate) {
    const numChannels = channels.length;
    const frames = channels[0].length;
    const buf = new ArrayBuffer(44 + frames * numChannels * 2);
    const dv = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + frames * numChannels * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, numChannels, true); dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * numChannels * 2, true); dv.setUint16(32, numChannels * 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, frames * numChannels * 2, true);
    let p = 44;
    for (let i = 0; i < frames; i++) for (let c = 0; c < numChannels; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      dv.setInt16(p, v < 0 ? v * 32768 : v * 32767, true); p += 2;
    }
    return buf;
  }

  window.SSWav = { parseWav, encodeWav };
})();
