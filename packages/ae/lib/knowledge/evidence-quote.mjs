import { scanSecretsInWords } from '../secret-scan.mjs';
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
 * Reading back is as strict: anything but one complete scalar on the key's
 * own line is withheld whole (see readEvidenceQuote).
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
// and every blank glyph (see BLANK_GLYPH) are refused: they would land raw in frontmatter, reorder what a reader or
// model sees, or hide text from a reader while a model still reads it.
// One exception: emoji presentation. VARIATION SELECTOR-16 (U+FE0F) is
// allowed anywhere, and ZERO WIDTH JOINER (U+200D) between two pictographs
// (a VS16 or a skin-tone modifier may sit before it), so `Warning \u26a0\ufe0f`
// and `dev \u{1f468}\u200d\u{1f4bb}` are accepted and displayed as written.
// A joiner anywhere else, such as between two letters of a token, is still
// refused. Screening removes both (see stripInvisible), so neither can hide a
// token from the secret scan.
const EMOJI_PRESENTATION = /\ufe0f|(?<=\p{Extended_Pictographic}(?:\ufe0f|[\u{1f3fb}-\u{1f3ff}])?)\u200d(?=\p{Extended_Pictographic})/gu;
// Characters that are not format or default-ignorable but are drawn as
// nothing: U+2800 BRAILLE PATTERN BLANK. They are treated as invisible:
// refused on write, removed from screening copies and from display.
const BLANK_GLYPH = '\u2800';
const BLANK_GLYPH_ALL = new RegExp(`[${BLANK_GLYPH}]`, 'gu');
const DISALLOWED = /[\x00-\x08\x0a-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029\u200e\u200f\u061c\u200b-\u200d\u2060-\u2064\ufeff\u{e0000}-\u{e007f}\u00ad\u180e\u206a-\u206f\ufff9-\ufffb\p{Default_Ignorable_Code_Point}\p{Cf}\u2800]/u;
// Private-use and unassigned code points: a font or a later Unicode version
// may draw them as anything, or as nothing. A lone surrogate (Cs) encodes no
// character at all, and each reader replaces or drops it differently.
const OPAQUE = /[\p{Co}\p{Cn}\p{Cs}]/u;
const OPAQUE_ALL = /[\p{Co}\p{Cn}\p{Cs}]/gu;
// What the display string removes: every invisible character (as in
// stripInvisible) and every private-use or unassigned one, except the VS16
// and ZWJ the emoji allowance permits, which the first branch keeps.
const DISPLAY_HIDDEN = new RegExp(`(${EMOJI_PRESENTATION.source})|[\\p{Default_Ignorable_Code_Point}\\p{Cf}\\p{Co}\\p{Cn}\\p{Cs}${BLANK_GLYPH}]`, 'gu');

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

const stripHidden = text => stripInvisible(text).replace(OPAQUE_ALL, '').replace(BLANK_GLYPH_ALL, '');
// Every combining mark removed after canonical decomposition, so a token with
// an overlay or accent on one of its characters is seen as its base letters.
const stripMarks = text => text.normalize('NFD').replace(/\p{M}/gu, '');

// Look-alikes are refused by structure, not listed: a confusables table can
// never be complete. Within one whitespace-delimited word, a Latin letter may
// not sit beside a letter of another script (Cyrillic, Greek, Armenian,
// Cherokee and so on), whatever that letter looks like. The scripts written
// with no space between words that customarily run into Latin text (Han,
// Hiragana, Katakana, Hangul, Bopomofo) are exempt; they hold no Latin
// look-alikes, and their fullwidth Latin forms are folded by NFKC. In a word
// that reads as an identifier (it holds an ASCII digit or underscore), an
// ASCII letter or digit may not sit beside a Latin letter that has no ASCII
// base (U+1D00 LATIN LETTER SMALL CAPITAL A, but not `é`, which is `e` and
// an accent). And a combining mark may sit only on a letter of a script other
// than Latin (a Devanagari vowel sign, say): on a Latin letter, digit or symbol
// it can overlay or disguise a token's characters, and precomposed Latin
// letters are written without one (the check runs after NFC).
const WORD_LATIN = /(?=\p{L})\p{Script_Extensions=Latin}/u;
const WORD_FOREIGN = /(?=\p{L})(?![\p{Script_Extensions=Latin}\p{Script=Common}\p{Script=Inherited}\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}])./u;
const MARK_BASE = /(?=\p{L})(?!\p{Script_Extensions=Latin})./u;
const ASCII_BASE = /^[\x00-\x7f]*$/;

function lookAlikeError(value) {
  const text = value.replace(EMOJI_PRESENTATION, '').normalize('NFC');
  let base = '';
  for (const ch of text) {
    if (/\p{M}/u.test(ch)) {
      if (!MARK_BASE.test(base)) return 'evidence_quote may put a combining mark only on a letter of a script other than Latin; write accented Latin letters precomposed and drop overlays';
    } else base = ch;
  }
  for (const word of text.split(/\s+/)) {
    if (WORD_LATIN.test(word) && WORD_FOREIGN.test(word)) return 'evidence_quote may not mix Latin letters with letters of another script in one word; retype the word in one script';
    if (/[0-9_]/.test(word) && /[A-Za-z0-9]/.test(word) && [...word].some(ch => WORD_LATIN.test(ch) && !ASCII_BASE.test(stripMarks(ch.normalize('NFKD'))))) {
      return 'evidence_quote may not mix ASCII with Latin letters that have no ASCII base in an identifier; retype it in ASCII';
    }
  }
  return null;
}

/**
 * Screens a one-line quote in every form a reader or model might read it as:
 * as written, with terminal escape sequences removed, with bare colour-code
 * remnants spaced apart from what follows (a remnant right before a token)
 * and removed entirely (a remnant inside a token), and with only the escape
 * introducers removed. Each form is also screened with every invisible,
 * private-use and unassigned character removed, so a token broken by one is
 * seen whole; in Unicode compatibility form (NFKC), so a fullwidth look-alike
 * is seen as the ASCII token it reads as; with every combining mark removed;
 * and with Cyrillic and Greek look-alikes mapped to Latin (see CONFUSABLES).
 * Every form is scanned without the word boundary before a pattern's literal
 * prefix (see scanSecretsInWords), so `TOKEN_ghp_...` is seen. Other
 * look-alikes are refused by structure on write (see lookAlikeError). Returns
 * null when no form holds a secret, otherwise the matched pattern ids.
 */
export function screenSecrets(value) {
  const raw = String(value ?? '');
  const stripped = stripAnsi(raw);
  const written = [raw, stripped, stripped.replace(SGR_REMNANT, ' '), stripped.replace(SGR_REMNANT, ''), stripEscapeIntroducers(raw)];
  const visible = [...written, ...written.map(stripHidden)];
  const folded = [...visible, ...visible.map(form => form.normalize('NFKC')), ...visible.map(stripMarks)];
  const forms = [...new Set([...folded, ...folded.map(skeleton)])];
  const ids = [...new Set([...forms, ...forms.map(inertLine)].flatMap(form => scanSecretsInWords(form).map(hit => hit.id)))];
  return ids.length ? { ids } : null;
}

/** Returns null when the quote is acceptable, otherwise the reason it is not. */
export function evidenceQuoteError(value) {
  if (typeof value !== 'string' || !value.trim()) return 'evidence_quote must be nonempty text';
  if (LINE_BREAK.test(value)) return 'evidence_quote must be a single line; pick the single most specific failing line (the assertion, error or diff line that shows the lesson) and quote only that';
  if (Buffer.byteLength(value, 'utf8') > EVIDENCE_QUOTE_CAP) return `evidence_quote must be at most ${EVIDENCE_QUOTE_CAP} bytes of verbatim error, test or diff text`;
  if (DISALLOWED.test(value.replace(EMOJI_PRESENTATION, ''))) return 'evidence_quote may contain tabs but no other control, bidirectional formatting, zero-width or tag characters, nor any other invisible character; strip terminal color codes';
  if (OPAQUE.test(value)) return 'evidence_quote may not contain private-use or unassigned characters or lone surrogates';
  const screen = screenSecrets(value);
  if (screen) return `evidence_quote looks like it contains a secret (${screen.ids.join(', ')}); redact it`;
  return lookAlikeError(value);
}

/** The frontmatter line for an accepted quote, escaped like the other quoted fields. */
export function evidenceQuoteLine(value) {
  return `evidence_quote: ${JSON.stringify(value)}`;
}

// A plain scalar may not start with a YAML indicator; one that does is a
// sequence, mapping, anchor, alias, tag, block scalar or comment, not text.
const YAML_INDICATOR = /^[-?:,[\]{}#&*!|>%@`]/;

/**
 * The text of a YAML value that is a complete scalar on its own line: a
 * double-quoted string JSON can read whole (what the writer emits), a
 * single-quoted string closed on the line, or a plain scalar that starts
 * with no indicator. Null for anything else (empty, unclosed, flow, block,
 * anchored, aliased or tagged), which a reader must treat as not one line.
 */
function oneLineYamlScalar(raw) {
  const value = String(raw ?? '').trim();
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'")) {
    const single = value.match(/^'((?:[^']|'')*)'$/);
    return single ? single[1].replaceAll("''", "'") : null;
  }
  return value && !YAML_INDICATOR.test(value) ? value : null;
}

/** What readEvidenceQuote returns for a quote it will not read as one line. */
export const EVIDENCE_QUOTE_MULTI_LINE = '[redacted: multi-line]';

/**
 * Reads the quote back from episode text, or null when the episode has none.
 * Fails closed: unless the key appears once and its value is a complete
 * one-line scalar (see oneLineYamlScalar) with no line below it indented
 * deeper than the key (which YAML would read as more of the value, as when a
 * long string is folded), the whole quote is withheld as
 * EVIDENCE_QUOTE_MULTI_LINE rather than read in part.
 */
export function readEvidenceQuote(text) {
  const { frontmatter } = splitFrontmatter(text);
  if (frontmatter === null) return null;
  const lines = frontmatter.split(/\r\n|\r|\n/);
  const keys = lines.flatMap((l, i) => (l.startsWith('evidence_quote:') ? [i] : []));
  if (!keys.length) return null;
  const at = keys[0];
  const raw = lines[at].slice('evidence_quote:'.length).trim();
  const next = lines.slice(at + 1).find(l => l.trim());
  const continues = next !== undefined && /^[ \t]/.test(next);
  if (!raw && !continues && keys.length === 1) return null;
  const value = oneLineYamlScalar(raw);
  return value === null || continues || keys.length > 1 ? EVIDENCE_QUOTE_MULTI_LINE : value;
}

// Ends a read-back quote cut to fit EVIDENCE_QUOTE_CAP, so the cut is visible.
const TRUNCATED = ' [truncated]';

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
 * permits), C0 controls become spaces, a quote that fails the write's
 * look-alike rules (see lookAlikeError) is withheld whole as
 * `[redacted: look-alike]`, and a quote still over EVIDENCE_QUOTE_CAP bytes is
 * cut at a code-point boundary and ends with ` [truncated]`, within the cap.
 */
export function inertEvidenceQuote(value) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') > EVIDENCE_QUOTE_READ_CAP) return '[redacted: oversize]';
  if (LINE_BREAK.test(text)) return '[redacted: multi-line]';
  const screen = screenSecrets(text);
  if (screen) return `[redacted: ${screen.ids.join(', ')}]`;
  if (READ_CONTROL.test(text)) return '[redacted: control-sequence]';
  const shown = inertLine(text.replace(DISPLAY_HIDDEN, (_, keep) => keep ?? ''));
  if (lookAlikeError(shown)) return '[redacted: look-alike]';
  if (Buffer.byteLength(shown, 'utf8') <= EVIDENCE_QUOTE_CAP) return shown;
  return capBytes(shown, EVIDENCE_QUOTE_CAP - Buffer.byteLength(TRUNCATED)) + TRUNCATED;
}
