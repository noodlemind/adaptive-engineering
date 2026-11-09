const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[0-Z\\-_])/g;
/** Just the SGR form — the one kind of escape clip and wrap PRESERVE, because
 * colour survives a cut and everything else must not. */
const SGR_RE = /^\x1b\[[0-9;]*m/;
/** Any escape sequence at the start of a string, for consuming without keeping. */
const ESCAPE_RE = /^\x1b(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[0-Z\\-_])/;

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '');
}

const WIDE_RANGES = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2329, 0x232a], // angle brackets
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compat, CJK compat
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f300, 0x1f64f], // emoji: symbols & pictographs, emoticons
  [0x1f900, 0x1f9ff], // emoji: supplemental symbols & pictographs
  [0x1fa70, 0x1faff], // emoji: extended-A
  [0x20000, 0x2fffd], // CJK Extension B..F
  [0x30000, 0x3fffd], // CJK Extension G
];

function isWideCodePoint(cp) {
  let lo = 0;
  let hi = WIDE_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = WIDE_RANGES[mid];
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

function isZeroWidthCodePoint(cp) {
  return (
    (cp >= 0x0300 && cp <= 0x036f) // combining diacritical marks
    || (cp >= 0x1ab0 && cp <= 0x1aff)
    || (cp >= 0x20d0 && cp <= 0x20ff) // combining marks for symbols
    || (cp >= 0xfe00 && cp <= 0xfe0f) // variation selectors
    || (cp >= 0xfe20 && cp <= 0xfe2f) // combining half marks
    || cp === 0x200b || cp === 0x200c || cp === 0x200d // ZW space / non-joiner / joiner
    || cp === 0xfeff // BOM / ZWNBSP
    || (cp >= 0xe0100 && cp <= 0xe01ef) // variation selectors supplement
  );
}

const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

export function graphemes(text) {
  const s = String(text ?? '');
  if (!s) return [];
  if (!segmenter) return [...s];
  const out = [];
  for (const { segment } of segmenter.segment(s)) out.push(segment);
  return out;
}

/** Cells one grapheme cluster occupies: 0, 1, or 2. */
export function clusterWidth(cluster) {
  const s = String(cluster ?? '');
  if (!s) return 0;
  let width = 0;
  let sawBase = false;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isZeroWidthCodePoint(cp)) continue;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue;
    const w = isWideCodePoint(cp) ? 2 : 1;
    if (sawBase) width = Math.max(width, w);
    else { width = w; sawBase = true; }
  }
  return width;
}

/** Display width of a string, ignoring colour. */
export function displayWidth(text) {
  let total = 0;
  for (const g of graphemes(stripAnsi(text))) total += clusterWidth(g);
  return total;
}

export function padTo(text, width) {
  const gap = width - displayWidth(text);
  return gap > 0 ? `${text}${' '.repeat(gap)}` : String(text ?? '');
}

function* tokens(text) {
  const s = String(text ?? '');
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const sgr = SGR_RE.exec(s.slice(i));
      if (sgr) {
        yield { ansi: sgr[0] };
        i += sgr[0].length;
        continue;
      }
      const esc = ESCAPE_RE.exec(s.slice(i));
      i += esc ? esc[0].length : 1;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== '\x1b') j += 1;
    for (const g of graphemes(s.slice(i, j))) yield { cluster: g, width: clusterWidth(g) };
    i = j;
  }
}

export function clipTo(text, width) {
  if (width <= 0) return '';
  let used = 0;
  let out = '';
  let sawAnsi = false;
  let dropped = false;
  for (const t of tokens(text)) {
    if (t.ansi) {
      if (!dropped) { out += t.ansi; sawAnsi = true; }
      continue;
    }
    if (used + t.width > width) { dropped = true; break; }
    out += t.cluster;
    used += t.width;
  }
  return dropped && sawAnsi ? `${out}\x1b[39m` : out;
}

export function wrapCells(line, width) {
  if (width <= 0) return [''];
  const rows = [];
  let current = '';
  let used = 0;
  let open = '';
  let openInRow = false;

  const flush = () => {
    rows.push(openInRow ? `${current}\x1b[39m` : current);
    current = open;
    openInRow = Boolean(open);
    used = 0;
  };

  for (const t of tokens(line)) {
    if (t.ansi) {
      open = /^\x1b\[(0|39|49)?m$/.test(t.ansi) ? '' : `${open}${t.ansi}`;
      current += t.ansi;
      openInRow = openInRow || Boolean(open);
      continue;
    }
    if (used + t.width > width && used > 0) flush();
    current += t.cluster;
    used += t.width;
  }
  if (used > 0 || !rows.length) rows.push(openInRow ? `${current}\x1b[39m` : current);
  return rows;
}

export function cellOffset(line, clusterIndex) {
  let cells = 0;
  const clusters = graphemes(String(line ?? ''));
  for (let i = 0; i < Math.min(clusterIndex, clusters.length); i += 1) {
    cells += clusterWidth(clusters[i]);
  }
  return cells;
}
