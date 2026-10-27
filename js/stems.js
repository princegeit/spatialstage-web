// The stems, in pd/spatial/stems.txt order - the six Demucs stems, then the
// six drum-kit parts MDX23C DrumSep splits out of the drums stem. Shared by
// every other script here, so the stem list lives in one place on this side
// just as stems.txt is the one list on the Pd side.
//
// LAYOUT is pd/generate_live_patch.py's LAYOUT (base azimuth, stereo width
// in degrees). It has to match: a setup's `base` is an offset from these,
// so a setup exported from one rig puts the stems in the same places on
// the other only if both start from the same numbers.
//
// stemOfName() is the file-name rule both rigs use to decide which stem a
// file is - pipeline/showfile.py's stem_for() is the same table and the
// same "rightmost match wins" rule, so a stem folder imports identically
// on either side. Change one, change the other.
(function () {
  'use strict';
  // The last four have no file: they play a sound input (see engine.setLive) - pd/spatial/inputs.txt on
  // the Pd side. A show file's channels, the pipeline and every song only know the first twelve.
  const STEMS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other',
                 'kick', 'snare', 'toms', 'hihat', 'ride', 'crash',
                 'input1', 'input2', 'input3', 'input4'];
  const BASE_STEMS = STEMS.slice(0, 6);
  const DRUM_PARTS = STEMS.slice(6, 12);
  const INPUT_STEMS = STEMS.slice(12);

  const LAYOUT = {
    vocals: [-15, 37], drums: [-45, 1], bass: [75, 0],
    guitar: [-75, 2], piano: [45, 8], other: [15, 50],
    kick: [0, 0], snare: [-10, 10], toms: [-40, 60],
    hihat: [30, 10], ride: [-60, 20], crash: [60, 40],
    input1: [-30, 30], input2: [30, 30], input3: [-120, 30], input4: [120, 30],
  };
  const GEOMETRY = {};
  for (const s of STEMS) GEOMETRY[s] = { azimuth: LAYOUT[s][0], width: LAYOUT[s][1] };

  const COLOR = {
    vocals: '#00ff88', drums: '#ffcc33', bass: '#44aaff',
    guitar: '#ff66aa', piano: '#ad6bff', other: '#00dddd',
    kick: '#ff4d4d', snare: '#ffa64d', toms: '#c98a4b',
    hihat: '#b3e0ff', ride: '#66e0b3', crash: '#f2f2f2',
    input1: '#ffb347', input2: '#ff7ad9', input3: '#7ad7ff', input4: '#c4ff6a',
  };

  const ICONS = {
    vocals: '<rect x="9" y="3" width="6" height="10" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v4"/><path d="M9 21h6"/>',
    drums:  '<ellipse cx="12" cy="10" rx="8" ry="3"/><path d="M4 10v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5"/><path d="M6 3.5l3.5 4M18 3.5l-3.5 4"/>',
    bass:   '<path d="M4 9.5v5h3l4.5 3.5v-12L7 9.5H4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
    guitar: '<circle cx="8.5" cy="15.5" r="5"/><circle cx="8.5" cy="15.5" r="1.5"/><path d="M12 12l6.5-6.5"/><path d="M17 4l3 3"/>',
    piano:  '<rect x="3" y="6.5" width="18" height="11" rx="1"/><path d="M7.5 6.5v6.5M12 6.5v6.5M16.5 6.5v6.5"/>',
    other:  '<path d="M6 20v-8M12 20V4M18 20v-5"/><circle cx="6" cy="9" r="2"/><circle cx="12" cy="17" r="2"/><circle cx="18" cy="12" r="2"/>',
    kick:   '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3"/><path d="M5 21l2-3M19 21l-2-3"/>',
    snare:  '<ellipse cx="12" cy="11" rx="8" ry="2.5"/><path d="M4 11v5c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-5"/><path d="M6 3l5 6M18 3l-5 6"/>',
    toms:   '<ellipse cx="8" cy="9" rx="5" ry="1.8"/><path d="M3 9v5c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V9"/><ellipse cx="17" cy="12" rx="4" ry="1.5"/><path d="M13 12v4c0 .8 1.8 1.5 4 1.5s4-.7 4-1.5v-4"/>',
    hihat:  '<path d="M4 8.5h16M6 6.5h12M12 8.5V21M8 21h8"/>',
    ride:   '<ellipse cx="12" cy="9" rx="9" ry="2.5"/><circle cx="12" cy="8.4" r="1"/><path d="M12 11.5V21M9 21h6"/>',
    crash:  '<path d="M3 6.5l18 4"/><path d="M12 8.5V21M9 21h6"/><path d="M5 3.5l1.5 1M18 13.5l1.5.5"/>',
    input1: '<path d="M9 3v5M15 3v5"/><rect x="6" y="8" width="12" height="6" rx="2"/><path d="M12 14v7"/>',
  };
  ICONS.input2 = ICONS.input3 = ICONS.input4 = ICONS.input1;

  // What the drum splitter leaves in the drums slot once the parts are out
  // (pipeline/split_drums.py's LEFTOVER). Not a stem of its own: when a
  // song has parts, it is what plays on the drums card.
  const LEFTOVER = 'drums_rest';

  // [stem, pattern] - pipeline/showfile.py's NAME_RULES. Matched against the
  // file name without its extension, lower-cased, with _ - . ( ) [ ] turned
  // into spaces. Every rule is tried; the match that ends furthest to the
  // right wins (splitters put the stem last: "Kick It - vocals" is vocals),
  // and on a tie the earlier rule wins ("bass drum" is a kick, not a bass;
  // "drums rest" is the leftover, not Other).
  const NAME_RULES = [
    [LEFTOVER, /\bdrums? ?rest\b/g],
    ['kick', /\b(kick|bass ?drum|bd)\b/g],
    ['snare', /\bsnare\b/g],
    ['toms', /\btoms?\b/g],
    ['hihat', /\b(hi ?hats?|hh)\b/g],
    ['ride', /\bride\b/g],
    ['crash', /\b(crash|cymbals?)\b/g],
    ['vocals', /\b(vocals?|vox|voice|voices|singing|lead vocal|acapella)\b/g],
    ['drums', /\b(drums?|percussion|perc|beat)\b/g],
    ['bass', /\bbass\b/g],
    ['guitar', /\b(guitars?|gtr)\b/g],
    ['piano', /\b(piano|keys|keyboards?|melody)\b/g],
    ['other', /\b(other|others|rest|instrumental|inst|music|accompaniment)\b/g],
  ];

  // Python's re.sub(r"[_\-\.\(\)\[\]]+", " ", name.lower()), plus where each
  // character of the result came from in the original name - a run of
  // separators becomes one space, so positions shift.
  const SEPARATOR = /[_\-.()[\]]/;
  function normalise(base) {
    let words = '';
    const from = [];
    for (let i = 0; i < base.length; i++) {
      if (SEPARATOR.test(base[i])) {
        if (i > 0 && SEPARATOR.test(base[i - 1])) continue;
        words += ' ';
      } else words += base[i].toLowerCase();
      from.push(i);
    }
    return { words, from };
  }

  // { stem, index, length } of the winning match, as a span of the file
  // name without its extension - so the caller can cut the stem word out to
  // find the song it belongs to ("Song - drums" -> "Song - "). null if the
  // name says no stem at all.
  function stemOfName(filename) {
    const base = filename.replace(/\.[^.]+$/, '');
    const { words, from } = normalise(base);
    let best = null;
    NAME_RULES.forEach(([stem, re], order) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(words))) {
        const end = m.index + m[0].length;
        if (!best || end > best.end || (end === best.end && order < best.order)) {
          best = { stem, start: m.index, end, order };
        }
        if (m[0].length === 0) re.lastIndex++;
      }
    });
    if (!best) return null;
    const index = from[best.start], last = from[best.end - 1];
    return { stem: best.stem, index, length: last + 1 - index };
  }

  const api = { STEMS, BASE_STEMS, DRUM_PARTS, INPUT_STEMS, GEOMETRY, COLOR, ICONS, LEFTOVER, stemOfName };
  if (typeof window !== 'undefined') window.SSStems = api;
  if (typeof module !== 'undefined') module.exports = api;   // for the Node tests
})();
