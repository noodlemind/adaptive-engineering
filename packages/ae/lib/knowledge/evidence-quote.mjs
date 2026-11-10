import { scanSecrets } from '../secret-scan.mjs';
import { inertLine, splitFrontmatter, stripInvisible } from './store.mjs';

/**
 * Optional verbatim evidence on an episode: the single most specific line of
 * error, test or diff output that showed the lesson. It is stored as one
 * escaped frontmatter line so the episode body, summary and recall excerpt
 * stay unchanged. It never enters a learning file, so the learning byte cap
 * keeps measuring the claim only. Absent means no line at all, so episodes
 * without it keep their bytes.
 *
 * A quote is one line. A credential wrapped across lines cannot be told from
 * ordinary multi-line output by any heuristic that does not also refuse real
 * output, so a line break is refused on write and withheld whole on read.
 */
export const EVIDENCE_QUOTE_CAP = 600;

/**
 * The most a quote read back from an episode may hold before it is screened.
 * Writes are capped at EVIDENCE_QUOTE_CAP, so only a hand-edited file goes
 * past this; such a quote is withheld whole rather than screened, so screening
 * cost stays bounded and nothing unscreened is ever shown.
 */
export const EVIDENCE_QUOTE_READ_CAP = 4096;

// CR, LF, NEL (U+0085) and the Unicode line and paragraph separators.
const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;

// Tab is the only control a quote may hold. Every other C0 or C1 control,
// every bidirectional override, isolate or mark (U+200E, U+200F, U+061C), the
// zero-width and invisible format characters (U+200B-U+200D, U+2060-U+2064,
// U+FEFF, U+00AD, U+180E, U+206A-U+206F, U+FFF9-U+FFFB), the tag characters
// (U+E0000-U+E007F), and every other default-ignorable code point or format
// (Cf) character (such as U+034F, the variation selectors U+FE00-U+FE0F, the
// Hangul fillers U+115F, U+1160, U+3164, U+FFA0, U+17B4 and U+1D173-U+1D17A)
// are refused: they would land raw in frontmatter, reorder what a reader or
// model sees, or hide text from a reader while a model still reads it.
// One exception: emoji presentation. VARIATION SELECTOR-16 (U+FE0F) is
// allowed anywhere, and ZERO WIDTH JOINER (U+200D) between two pictographs
// (a VS16 or a skin-tone modifier may sit before it), so `Warning \u26a0\ufe0f`
// and `dev \u{1f468}\u200d\u{1f4bb}` are accepted and displayed as written.
// A joiner anywhere else, such as between two letters of a token, is still
// refused. Screening removes both (see stripInvisible), so neither can hide a
// token from the secret scan.
const EMOJI_PRESENTATION = /\ufe0f|(?<=\p{Extended_Pictographic}(?:\ufe0f|[\u{1f3fb}-\u{1f3ff}])?)\u200d(?=\p{Extended_Pictographic})/gu;
const DISALLOWED = /[\x00-\x08\x0a-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029\u200e\u200f\u061c\u200b-\u200d\u2060-\u2064\ufeff\u{e0000}-\u{e007f}\u00ad\u180e\u206a-\u206f\ufff9-\ufffb\p{Default_Ignorable_Code_Point}\p{Cf}]/u;
// Private-use and unassigned code points: a font or a later Unicode version
// may draw them as anything, or as nothing.
const OPAQUE = /[\p{Co}\p{Cn}]/u;
const OPAQUE_ALL = /[\p{Co}\p{Cn}]/gu;
// What the display string removes: every invisible character (as in
// stripInvisible) and every private-use or unassigned one, except the VS16
// and ZWJ the emoji allowance permits, which the first branch keeps.
const DISPLAY_HIDDEN = new RegExp(`(${EMOJI_PRESENTATION.source})|[\\p{Default_Ignorable_Code_Point}\\p{Cf}\\p{Co}\\p{Cn}]`, 'gu');

// Whole terminal escape sequences: CSI (ESC [ or the C1 CSI byte) with its
// parameters and final byte, OSC (ESC ] or the C1 OSC byte) up to its
// terminator, and any other ESC-introduced sequence.
const ANSI_SEQUENCE = /(?:\x1b\[|\x9b)[0-?]*[ -\/]*[@-~]|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b[ -\/]*[0-~]?/g;
// What is left of a colour code once its ESC is gone, such as `[33m`. Its
// final `m` is a word character, so a pattern that starts with \b would not
// see a token that follows it. Used only on screening copies, never output.
const SGR_REMNANT = /\[[0-9;]*m/g;

const stripAnsi = text => text.replace(ANSI_SEQUENCE, '');
// Only the bytes that open an escape sequence (ESC, ESC [, ESC ], and the C1
// CSI and OSC bytes), with everything after them kept. Removing whole
// sequences can eat a token's first characters as parameters or a final byte
// (`ghp_\x1b[A1b2...` loses its `A`), so this screening form keeps them.
const ESCAPE_INTRODUCER = /\x1b[\[\]]?|[\x9b\x9d]/g;
const stripEscapeIntroducers = text => text.replace(ESCAPE_INTRODUCER, '');
// ESC or any C1 control in a quote read back from an episode. Writes refuse
// these, so only a foreign or hand-edited file has one; such a quote is
// withheld whole (see inertEvidenceQuote).
const READ_CONTROL = /[\x1b\x80-\x9f]/;

// Common Cyrillic and Greek look-alikes of Latin letters (U+0410 CYRILLIC
// CAPITAL A for `A`, U+0440 CYRILLIC SMALL ER for `p`, and so on). NFKC keeps
// them distinct, so `AKIA` or `ghp_` spelled with one would read as a
// credential to a person but not to the scan.
const CONFUSABLES = new Map(Object.entries({
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041a': 'K', '\u041c': 'M', '\u041d': 'H', '\u041e': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T', '\u0425': 'X', '\u0405': 'S', '\u0406': 'I', '\u0408': 'J',
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0456': 'i', '\u0455': 's', '\u0458': 'j',
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H', '\u0399': 'I', '\u039a': 'K', '\u039c': 'M', '\u039d': 'N', '\u039f': 'O', '\u03a1': 'P', '\u03a4': 'T', '\u03a5': 'Y', '\u03a7': 'X',
  '\u03bf': 'o', '\u03bd': 'v', '\u03c1': 'p',
}));
const CONFUSABLE = new RegExp(`[${[...CONFUSABLES.keys()].join('')}]`, 'gu');
const skeleton = text => text.replace(CONFUSABLE, ch => CONFUSABLES.get(ch));

const stripHidden = text => stripInvisible(text).replace(OPAQUE_ALL, '');

/**
 * Screens a one-line quote in every form a reader or model might read it as:
 * as written, with terminal escape sequences removed, with bare colour-code
 * remnants spaced apart from what follows (a remnant right before a token)
 * and removed entirely (a remnant inside a token), and with only the escape
 * introducers removed. Each form is also screened with every invisible,
 * private-use and unassigned character removed, so a token broken by one is
 * seen whole; in Unicode compatibility form (NFKC), so a fullwidth look-alike
 * is seen as the ASCII token it reads as; and with Cyrillic and Greek
 * look-alikes mapped to Latin (see CONFUSABLES). Returns null when no form
 * holds a secret, otherwise the matched pattern ids.
 */
export function screenSecrets(value) {
  const raw = String(value ?? '');
  const stripped = stripAnsi(raw);
  const written = [raw, stripped, stripped.replace(SGR_REMNANT, ' '), stripped.replace(SGR_REMNANT, ''), stripEscapeIntroducers(raw)];
  const visible = [...written, ...written.map(stripHidden)];
  const folded = [...visible, ...visible.map(form => form.normalize('NFKC'))];
  const forms = [...new Set([...folded, ...folded.map(skeleton)])];
  const ids = [...new Set([...forms, ...forms.map(inertLine)].flatMap(form => scanSecrets(form).map(hit => hit.id)))];
  return ids.length ? { ids } : null;
}

/** Returns null when the quote is acceptable, otherwise the reason it is not. */
export function evidenceQuoteError(value) {
  if (typeof value !== 'string' || !value.trim()) return 'evidence_quote must be nonempty text';
  if (LINE_BREAK.test(value)) return 'evidence_quote must be a single line; pick the single most specific failing line (the assertion, error or diff line that shows the lesson) and quote only that';
  if (Buffer.byteLength(value, 'utf8') > EVIDENCE_QUOTE_CAP) return `evidence_quote must be at most ${EVIDENCE_QUOTE_CAP} bytes of verbatim error, test or diff text`;
  if (DISALLOWED.test(value.replace(EMOJI_PRESENTATION, ''))) return 'evidence_quote may contain tabs but no other control, bidirectional formatting, zero-width or tag characters, nor any other invisible character; strip terminal color codes';
  if (OPAQUE.test(value)) return 'evidence_quote may not contain private-use or unassigned characters';
  const screen = screenSecrets(value);
  if (screen) return `evidence_quote looks like it contains a secret (${screen.ids.join(', ')}); redact it`;
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
 * Quoted evidence as inert data for an agent-facing packet. Writes accept
 * only one line, so anything else came from a legacy or hand-edited file and
 * is withheld whole before screening: over EVIDENCE_QUOTE_READ_CAP bytes as
 * `[redacted: oversize]`, and any line break as `[redacted: multi-line]`.
 * Otherwise the quote is screened in every form screenSecrets checks, and any
 * hit withholds it behind a marker naming the matched patterns. A quote with
 * no hit that still holds ESC or any C1 control is withheld whole as
 * `[redacted: control-sequence]`, so no escape sequence is ever interpreted or
 * half-removed on display. Otherwise invisible, private-use and unassigned
 * characters are removed (keeping the VS16 and ZWJ the emoji allowance
 * permits), C0 controls become spaces, and the quote is capped in bytes at a
 * code-point boundary.
 */
export function inertEvidenceQuote(value) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') > EVIDENCE_QUOTE_READ_CAP) return '[redacted: oversize]';
  if (LINE_BREAK.test(text)) return '[redacted: multi-line]';
  const screen = screenSecrets(text);
  if (screen) return `[redacted: ${screen.ids.join(', ')}]`;
  if (READ_CONTROL.test(text)) return '[redacted: control-sequence]';
  return capBytes(inertLine(text.replace(DISPLAY_HIDDEN, (_, keep) => keep ?? '')), EVIDENCE_QUOTE_CAP);
}
