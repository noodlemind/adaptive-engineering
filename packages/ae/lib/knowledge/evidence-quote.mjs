import { scanSecrets, SECRET_PATTERNS } from '../secret-scan.mjs';
import { inertLine } from './store.mjs';

/**
 * Optional verbatim evidence on an episode: the exact error, test or diff text
 * that showed the lesson. It is stored as one escaped frontmatter line so the
 * episode body, summary and recall excerpt stay unchanged. It never enters a
 * learning file, so the learning byte cap keeps measuring the claim only.
 * Absent means no line at all, so episodes without it keep their bytes.
 */
export const EVIDENCE_QUOTE_CAP = 600;

/**
 * The most a quote read back from an episode may hold before it is screened.
 * Writes are capped at EVIDENCE_QUOTE_CAP, so only a hand-edited file goes
 * past this; such a quote is withheld whole rather than screened, so screening
 * cost stays bounded and nothing unscreened is ever shown.
 */
export const EVIDENCE_QUOTE_READ_CAP = 4096;

// Tab, newline and carriage return are escaped on write. Every other C0 or C1
// control, every bidirectional override, isolate or mark (U+200E, U+200F,
// U+061C), the Unicode line and paragraph separators (U+2028, U+2029), the
// zero-width and invisible format characters (U+200B-U+200D, U+2060-U+2064,
// U+FEFF, U+00AD, U+180E, U+206A-U+206F, U+FFF9-U+FFFB) and the tag
// characters (U+E0000-U+E007F) are refused: they would
// land raw in frontmatter, break a line, reorder what a reader or model sees,
// or hide text from a reader while a model still reads it.
const DISALLOWED = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029\u200e\u200f\u061c\u200b-\u200d\u2060-\u2064\ufeff\u{e0000}-\u{e007f}\u00ad\u180e\u206a-\u206f\ufff9-\ufffb]/u;

// Whole terminal escape sequences: CSI (ESC [ or the C1 CSI byte) with its
// parameters and final byte, OSC (ESC ] or the C1 OSC byte) up to its
// terminator, and any other ESC-introduced sequence.
const ANSI_SEQUENCE = /(?:\x1b\[|\x9b)[0-?]*[ -\/]*[@-~]|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b[ -\/]*[0-~]?/g;
// What is left of a colour code once its ESC is gone, such as `[33m`. Its
// final `m` is a word character, so a pattern that starts with \b would not
// see a token that follows it. Used only on screening copies, never output.
const SGR_REMNANT = /\[[0-9;]*m/g;

const stripAnsi = text => text.replace(ANSI_SEQUENCE, '');
const secretIds = forms => [...new Set(forms.flatMap(form => scanSecrets(form).map(hit => hit.id)))];

// Joins a form's lines with nothing between them, trimming the blanks at the
// edges of each line, and records each join point. Splitting and trim() are
// linear; a single regex for "blanks, break, blanks" backtracks quadratically
// over a long run of blanks with no break.
function compactLines(form) {
  const lines = form.split(/\r\n|\r|\n/).map(line => inertLine(line.trim()));
  let text = '';
  const joins = [];
  lines.forEach((line, i) => {
    if (i) joins.push(text.length);
    text += line;
  });
  return { text, joins };
}

// A split connection-string match counts as credentials unless it has the
// one benign shape that compacting manufactures: a line ending in
// `scheme://host:port` followed by a line that starts with an email address
// (`admin@example.com`) or an `@scope/` package (`@types/node`). Compacted,
// that reads as `scheme://host:port...@...`, with the port as the start of
// the password. The match is let through only when all of these hold:
//   - no break falls between the `://` and the password (a break inside the
//     scheme word only means the previous line ended in a word character;
//     the scheme proper starts at that break);
//   - what sits in the user position looks like a host: `localhost` or a
//     dotted name or address, not a bare user name. A dotless host (`api`,
//     `cache`, a compose service) cannot be told from a user name, so it
//     fails closed; so does a bracketed IPv6 host, whose first `:` ends the
//     user position;
//   - the first break inside the password (or right after its `@`) comes
//     straight after a 1-5 digit run that opens it;
//   - the text after that break is an `@scope/` package or a dotted email.
// Everything else fails closed. The remaining gap is a dotted user name with
// a password that opens with 1-5 digits, wrapped before an email-like rest
// or before an `@host/path` that reads as an `@scope/` package.
const SPLIT_SCOPE = /^@[A-Za-z0-9][\w.-]*\//;
const SPLIT_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/;
const HOST_LIKE = /^(?:localhost|[\w-]+(?:\.[\w-]+)+)$/;
const CONNECTION_PARTS = /^(\w+):\/\/([^\s:@/]+):([^\s@/]+)@/;

// Returns where the benign shape's `@` sits in the compacted text, so the
// scan can look again just after it, or -1 when the match is credentials.
function benignSplitConnection(match, start, joins, text) {
  const parts = match.match(CONNECTION_PARTS);
  if (!parts) return -1;
  const schemeEnd = start + parts[1].length;
  const userStart = schemeEnd + 3;
  const passStart = userStart + parts[2].length + 1;
  const at = passStart + parts[3].length;
  if (joins.some(j => j >= schemeEnd && j <= passStart)) return -1;
  if (!HOST_LIKE.test(parts[2])) return -1;
  const first = joins.find(j => j > passStart && j <= at + 1);
  if (first === undefined) return -1;
  if (!/^\d{1,5}$/.test(text.slice(passStart, first))) return -1;
  const rest = text.slice(first);
  return SPLIT_SCOPE.test(rest) || SPLIT_EMAIL.test(rest) ? at : -1;
}

// Pattern ids that match a compacted form only across a join point. After a
// benign connection-string match the scan resumes just past its `@`, because
// that match's host part can swallow the scheme of a credential that follows.
function splitIds(form) {
  const { text, joins } = compactLines(form);
  if (!joins.length) return [];
  const ids = [];
  for (const { id, re } of SECRET_PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m;
    while ((m = global.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!m[0].length) { global.lastIndex = start + 1; continue; }
      if (!joins.some(j => j > start && j < end)) continue;
      if (id === 'connection-string') {
        const at = benignSplitConnection(m[0], start, joins, text);
        if (at >= 0) { global.lastIndex = at + 1; continue; }
      }
      ids.push(id);
      break;
    }
  }
  return ids;
}

/**
 * Screens a quote in every form a reader or model might reassemble: as
 * written, with terminal escape sequences removed, with bare colour-code
 * remnants spaced apart from what follows (a remnant right before a token)
 * and removed entirely (a remnant inside a token), and each of those joined
 * to one line with each break as a space. Any match there is a direct hit.
 *
 * Only when no such form matches is the compact form checked: each form's
 * lines joined with nothing between them and the blanks at their edges
 * trimmed, which is how a credential wrapped across lines reads. A compact
 * match counts as a split secret only if it spans a join point (so it cannot
 * be seen on any one line) and, for connection-string, only if it looks like
 * real credentials (see splitConnectionCredentials). Returns null when no form
 * holds a secret; `split` is true when only the compact form does.
 */
export function screenSecrets(value) {
  const raw = String(value ?? '');
  const stripped = stripAnsi(raw);
  const bases = [raw, stripped, stripped.replace(SGR_REMNANT, ' '), stripped.replace(SGR_REMNANT, '')];
  const direct = secretIds([...bases, ...bases.map(inertLine)]);
  if (direct.length) return { ids: direct, split: false };
  const split = [...new Set(bases.flatMap(splitIds))];
  return split.length ? { ids: split, split: true } : null;
}

/** Returns null when the quote is acceptable, otherwise the reason it is not. */
export function evidenceQuoteError(value) {
  if (typeof value !== 'string' || !value.trim()) return 'evidence_quote must be nonempty text';
  if (Buffer.byteLength(value, 'utf8') > EVIDENCE_QUOTE_CAP) return `evidence_quote must be at most ${EVIDENCE_QUOTE_CAP} bytes of verbatim error, test or diff text`;
  if (DISALLOWED.test(value)) return 'evidence_quote may contain tabs, newlines and carriage returns but no other control, bidirectional formatting, line separator, zero-width or tag characters; strip terminal color codes';
  // Screen the joined forms too (see screenSecrets): a credential split
  // across lines must not pass here and then reassemble when the quote is
  // rendered as one line.
  const screen = screenSecrets(value);
  if (screen) return `evidence_quote looks like it contains a secret${screen.split ? ' split across lines' : ''} (${screen.ids.join(', ')}); redact it`;
  return null;
}

/** The frontmatter line for an accepted quote, escaped like the other quoted fields. */
export function evidenceQuoteLine(value) {
  return `evidence_quote: ${JSON.stringify(value)}`;
}

/** Reads the quote back from episode text, or null when the episode has none. */
export function readEvidenceQuote(text) {
  const fm = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = fm?.[1].split('\n').find(l => l.startsWith('evidence_quote:'));
  if (!line) return null;
  const raw = line.slice('evidence_quote:'.length).trim();
  try {
    const value = JSON.parse(raw);
    return typeof value === 'string' ? value : null;
  } catch {
    return raw.replace(/^["']|["']$/g, '');
  }
}

function capBytes(text, max) {
  let out = '';
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > max) break;
    out += ch;
    used += size;
  }
  return out;
}

/**
 * Quoted evidence as inert data for an agent-facing packet. A quote over
 * EVIDENCE_QUOTE_READ_CAP bytes is withheld as `[redacted: oversize]` before
 * any screening. Otherwise terminal escape sequences are removed whole, then
 * the quote is screened in every form screenSecrets checks, including the
 * compact form where a credential split across a line break is joined back
 * together. Any hit withholds the whole quote behind a marker naming the
 * matched patterns, or `split-secret` when only the compact form matched. Otherwise the quote is joined to one line by inertLine (which
 * also blanks C0, C1, bidi and invisible format characters) and capped in
 * bytes at a code-point boundary.
 */
export function inertEvidenceQuote(value) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') > EVIDENCE_QUOTE_READ_CAP) return '[redacted: oversize]';
  const screen = screenSecrets(text);
  if (screen) return screen.split ? '[redacted: split-secret]' : `[redacted: ${screen.ids.join(', ')}]`;
  return capBytes(inertLine(stripAnsi(text)), EVIDENCE_QUOTE_CAP);
}
