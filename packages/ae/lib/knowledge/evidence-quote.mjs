import { scanSecrets } from '../secret-scan.mjs';
import { inertLine } from './store.mjs';

/**
 * Optional verbatim evidence on an episode: the exact error, test or diff text
 * that showed the lesson. It is stored as one escaped frontmatter line so the
 * episode body, summary and recall excerpt stay unchanged. It never enters a
 * learning file, so the learning byte cap keeps measuring the claim only.
 * Absent means no line at all, so episodes without it keep their bytes.
 */
export const EVIDENCE_QUOTE_CAP = 600;

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
// A line break and the spaces or tabs around it.
const LINE_BREAK = /[^\S\r\n]*[\r\n]+[^\S\r\n]*/g;

const stripAnsi = text => text.replace(ANSI_SEQUENCE, '');
const secretIds = forms => [...new Set(forms.flatMap(form => scanSecrets(form).map(hit => hit.id)))];

/**
 * Screens a quote in every form a reader or model might reassemble: as
 * written, with terminal escape sequences removed, with bare colour-code
 * remnants spaced apart from what follows, joined to one line with each break
 * as a space, and joined with each break (and the whitespace around it)
 * removed, which is how a credential wrapped across lines reads. Returns null
 * when no form holds a secret; `split` is true when only the break-removed
 * form does.
 */
function screenSecrets(value) {
  const raw = String(value ?? '');
  const stripped = stripAnsi(raw);
  const bases = [raw, stripped, stripped.replace(SGR_REMNANT, ' ')];
  const direct = secretIds([...bases, ...bases.map(inertLine)]);
  if (direct.length) return { ids: direct, split: false };
  const split = secretIds(bases.map(form => inertLine(form.replace(LINE_BREAK, ''))));
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
 * Quoted evidence as inert data for an agent-facing packet. Terminal escape
 * sequences are removed whole, then the quote is screened in every form
 * screenSecrets checks, including the forms where a credential split across a
 * line break is joined back together. Any hit withholds the whole quote behind
 * a marker naming the matched patterns, or `split-secret` when only a joined
 * form matched. Otherwise the quote is joined to one line by inertLine (which
 * also blanks C0, C1, bidi and invisible format characters) and capped in
 * bytes at a code-point boundary.
 */
export function inertEvidenceQuote(value) {
  const screen = screenSecrets(value);
  if (screen) return screen.split ? '[redacted: split-secret]' : `[redacted: ${screen.ids.join(', ')}]`;
  return capBytes(inertLine(stripAnsi(String(value ?? ''))), EVIDENCE_QUOTE_CAP);
}
