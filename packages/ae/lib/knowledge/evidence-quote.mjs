import { scanSecrets, SECRET_PATTERNS } from '../secret-scan.mjs';
import { inertLine, splitFrontmatter, stripInvisible } from './store.mjs';

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
// characters (U+E0000-U+E007F), and every other default-ignorable code point
// or format (Cf) character (such as U+034F, the variation selectors
// U+FE00-U+FE0F, the Hangul fillers U+115F, U+1160, U+3164, U+FFA0, U+17B4 and
// U+1D173-U+1D17A) are refused: they would
// land raw in frontmatter, break a line, reorder what a reader or model sees,
// or hide text from a reader while a model still reads it.
const DISALLOWED = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029\u200e\u200f\u061c\u200b-\u200d\u2060-\u2064\ufeff\u{e0000}-\u{e007f}\u00ad\u180e\u206a-\u206f\ufff9-\ufffb\p{Default_Ignorable_Code_Point}\p{Cf}]/u;

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

// The most lines one compact span joins. A span starts at a real line start,
// so text on an earlier line cannot glue onto a credential and hide the \b a
// pattern opens with, and every shorter span is tried too, so text on a later
// line cannot hide the \b it closes with. The bound keeps the cost linear in
// the quote: each line takes part in fewer than SPAN_LINES * SPAN_LINES spans
// of at most SPAN_LINES lines each.
const SPAN_LINES = 5;

const GLOBAL_PATTERNS = SECRET_PATTERNS.map(({ id, re }) => ({ id, re: new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`) }));

// Whether the pattern matches the text somewhere that spans a join point.
function matchesAcrossJoin(re, text, joins) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (!m[0].length) { re.lastIndex = start + 1; continue; }
    if (joins.some(j => j > start && j < end)) return true;
  }
  return false;
}

// Pattern ids that match only across a join point in some compact span of a
// form: lines i..j (fewer than SPAN_LINES of them) joined with nothing between
// them and the blanks at the edges of each line trimmed, which is how a
// credential wrapped across lines reads. Splitting and trim() are linear; a
// single regex for "blanks, break, blanks" backtracks quadratically over a
// long run of blanks with no break.
//
// Every match that spans a join counts, connection strings included. A line
// ending in `scheme://host:port` followed by a line starting with an email
// address or an `@scope/` package compacts to the same text as a password
// wrapped after its leading digits (`postgres://svc.user:2024` then
// `WinterPass@prod.example.com`), and a dotted user name cannot be told from
// a host. The two shapes cannot be told apart, so that log shape fails closed
// on purpose.
function splitIds(form) {
  const lines = form.split(/\r\n|\r|\n/).map(line => inertLine(line.trim()));
  const ids = new Set();
  for (let i = 0; i < lines.length - 1; i++) {
    let text = lines[i];
    const joins = [];
    for (let j = i + 1; j < lines.length && j < i + SPAN_LINES; j++) {
      joins.push(text.length);
      text += lines[j];
      for (const { id, re } of GLOBAL_PATTERNS) {
        if (!ids.has(id) && matchesAcrossJoin(re, text, joins)) ids.add(id);
      }
    }
  }
  return [...ids];
}

/**
 * Screens a quote in every form a reader or model might reassemble: as
 * written, with terminal escape sequences removed, with bare colour-code
 * remnants spaced apart from what follows (a remnant right before a token)
 * and removed entirely (a remnant inside a token), and each of those joined
 * to one line with each break as a space. Each form is also screened with
 * every invisible character removed (see stripInvisible), so a token broken
 * by one is seen whole. Any match there is a direct hit.
 *
 * Only when no such form matches are the compact spans checked (see
 * splitIds): short runs of lines joined with nothing between them, which is
 * how a credential wrapped across lines reads. A compact match counts as a
 * split secret only if it spans a join point, so it cannot be seen on any one
 * line. Returns null when no form holds a secret; `split` is true when only a
 * compact span does.
 */
export function screenSecrets(value) {
  const raw = String(value ?? '');
  const stripped = stripAnsi(raw);
  const written = [raw, stripped, stripped.replace(SGR_REMNANT, ' '), stripped.replace(SGR_REMNANT, '')];
  const bases = [...new Set([...written, ...written.map(stripInvisible)])];
  const direct = secretIds([...bases, ...bases.map(inertLine)]);
  if (direct.length) return { ids: direct, split: false };
  const split = [...new Set(bases.flatMap(splitIds))];
  return split.length ? { ids: split, split: true } : null;
}

/** Returns null when the quote is acceptable, otherwise the reason it is not. */
export function evidenceQuoteError(value) {
  if (typeof value !== 'string' || !value.trim()) return 'evidence_quote must be nonempty text';
  if (Buffer.byteLength(value, 'utf8') > EVIDENCE_QUOTE_CAP) return `evidence_quote must be at most ${EVIDENCE_QUOTE_CAP} bytes of verbatim error, test or diff text`;
  if (DISALLOWED.test(value)) return 'evidence_quote may contain tabs, newlines and carriage returns but no other control, bidirectional formatting, line separator, zero-width or tag characters, nor any other invisible character; strip terminal color codes';
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
  const { frontmatter } = splitFrontmatter(text);
  const line = frontmatter?.split('\n').find(l => l.startsWith('evidence_quote:'));
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
 * matched patterns, or `split-secret` when only the compact form matched.
 * Otherwise invisible characters (default-ignorable and format characters)
 * are removed outright, exactly as in the form screened without them, and the
 * quote is joined to one line by inertLine (which also blanks C0, C1 and line
 * separator characters) and capped in bytes at a code-point boundary.
 */
export function inertEvidenceQuote(value) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') > EVIDENCE_QUOTE_READ_CAP) return '[redacted: oversize]';
  const screen = screenSecrets(text);
  if (screen) return screen.split ? '[redacted: split-secret]' : `[redacted: ${screen.ids.join(', ')}]`;
  return capBytes(inertLine(stripInvisible(stripAnsi(text))), EVIDENCE_QUOTE_CAP);
}
