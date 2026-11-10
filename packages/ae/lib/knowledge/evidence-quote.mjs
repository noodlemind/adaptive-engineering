import { scanSecrets } from '../secret-scan.mjs';
import { createRedactor } from '../redact.mjs';
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
// every bidirectional override, isolate or mark, the zero-width and
// invisible format characters, the tag characters, every other
// default-ignorable code point or format (Cf) character, and the blank glyph
// U+2800 are refused: they would land raw in frontmatter, reorder what a
// reader or model sees, or hide text from a reader while a model still reads
// it. One exception: emoji presentation. The variation selectors VS15
// (U+FE0E) and VS16 (U+FE0F) are allowed anywhere, and ZERO WIDTH JOINER
// (U+200D) between two pictographs (a variation selector or a skin-tone
// modifier may sit before it). Keycaps (`1️⃣`) need nothing more:
// U+20E3 is a combining mark, not a format character. Screening removes all
// of these (see fold), so none can hide a token from the screen.
const EMOJI_PRESENTATION = /[\ufe0e\ufe0f]|(?<=\p{Extended_Pictographic}(?:[\ufe0e\ufe0f]|[\u{1f3fb}-\u{1f3ff}])?)\u200d(?=\p{Extended_Pictographic})/gu;
const BLANK_GLYPH = '\u2800';
const BLANK_GLYPH_ALL = new RegExp(`[${BLANK_GLYPH}]`, 'gu');
const DISALLOWED = /[\x00-\x08\x0a-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029\u200e\u200f\u061c\u200b-\u200d\u2060-\u2064\ufeff\u{e0000}-\u{e007f}\u00ad\u180e\u206a-\u206f\ufff9-\ufffb\p{Default_Ignorable_Code_Point}\p{Cf}\u2800]/u;
// Private-use and unassigned code points: a font or a later Unicode version
// may draw them as anything, or as nothing. A lone surrogate (Cs) encodes no
// character at all, and each reader replaces or drops it differently.
const OPAQUE = /[\p{Co}\p{Cn}\p{Cs}]/u;
const OPAQUE_ALL = /[\p{Co}\p{Cn}\p{Cs}]/gu;
// What the display string removes: every invisible character and every
// private-use or unassigned one, except what the emoji allowance permits.
const DISPLAY_HIDDEN = new RegExp(`(${EMOJI_PRESENTATION.source})|[\\p{Default_Ignorable_Code_Point}\\p{Cf}\\p{Co}\\p{Cn}\\p{Cs}${BLANK_GLYPH}]`, 'gu');

// Whole terminal escape sequences: CSI (ESC [ or the C1 CSI byte) with its
// parameters and final byte, OSC (ESC ] or the C1 OSC byte) up to its
// terminator, and any other ESC-introduced sequence.
const ANSI_SEQUENCE = /(?:\x1b\[|\x9b)[0-?]*[ -\/]*[@-~]|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b[ -\/]*[0-~]?/g;
// What is left of a colour code once its ESC is gone, such as `[33m`.
const SGR_REMNANT = /\[[0-9;]*m/g;
const stripAnsi = text => text.replace(ANSI_SEQUENCE, '');
// Only the bytes that open an escape sequence, with everything after them
// kept: removing whole sequences can eat a token's first characters.
const ESCAPE_INTRODUCER = /\x1b[\[\]]?|[\x9b\x9d]/g;
const stripEscapeIntroducers = text => text.replace(ESCAPE_INTRODUCER, '');
// ESC or any C1 control in a quote read back from an episode. Writes refuse
// these, so only a foreign or hand-edited file has one; such a quote is
// withheld whole (see inertEvidenceQuote).
const READ_CONTROL = /[\x1b\x80-\x9f]/;

// Common Cyrillic and Greek look-alikes of Latin letters, mapped so the
// pattern layer sees `АKIA...` as `AKIA...`. The token shape rule does
// not need this table: it refuses long letter-and-digit tokens whatever their
// script.
const CONFUSABLES = new Map(Object.entries({
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041a': 'K', '\u041c': 'M', '\u041d': 'H', '\u041e': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T', '\u0425': 'X', '\u0405': 'S', '\u0406': 'I', '\u0408': 'J',
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0456': 'i', '\u0455': 's', '\u0458': 'j',
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H', '\u0399': 'I', '\u039a': 'K', '\u039c': 'M', '\u039d': 'N', '\u039f': 'O', '\u03a1': 'P', '\u03a4': 'T', '\u03a5': 'Y', '\u03a7': 'X',
  '\u03bf': 'o', '\u03bd': 'v', '\u03c1': 'p',
}));
const CONFUSABLE = new RegExp(`[${[...CONFUSABLES.keys()].join('')}]`, 'gu');
const skeleton = text => text.replace(CONFUSABLE, ch => CONFUSABLES.get(ch));

const stripHidden = text => stripInvisible(text).replace(OPAQUE_ALL, '').replace(BLANK_GLYPH_ALL, '');
// The screening copy of a form: invisible, private-use and unassigned
// characters removed, compatibility-folded (NFKC, so fullwidth letters read
// as ASCII), and every combining mark removed (so an overlay or accent on a
// token's characters does not hide them). Never shown.
const fold = text => stripHidden(stripHidden(text).normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '')).normalize('NFC');

// One pattern list: the scanSecrets patterns and the shared redactor's
// patterns (no environment values, so a screen gives the same answer on every
// machine). A form the redactor would change holds a secret.
const redactor = createRedactor({ env: {} });
const MASK_KIND = /\u00abredacted:([^\u00bb]+)\u00bb/g;

function patternIds(form) {
  const ids = scanSecrets(form).map(hit => hit.id);
  const redacted = redactor.redactText(form);
  if (redacted !== form) {
    const before = new Set([...form.matchAll(MASK_KIND)].map(m => m[1]));
    const kinds = [...redacted.matchAll(MASK_KIND)].map(m => m[1]).filter(kind => !before.has(kind));
    ids.push(...(kinds.length ? kinds : ['secret']));
  }
  return ids;
}

/**
 * The token shape rule, which needs no list of secret formats. A quote is
 * split into chunks on whitespace and on punctuation that no credential
 * format uses: quotes, backticks, brackets, parentheses, braces, `<` `>`,
 * `,` `;` `=` `:` `@` `|` `!` `?` `&` `#` `$` `*` `^` `~`. `_`, `-`, `.`, `+`
 * and `%` stay inside chunks, because credentials use them. Each chunk is
 * then split on `/` and `\` into tokens. A token of 20 or more characters
 * that holds both a letter and a digit is refused when one of its segments
 * (the parts between `.`, `-` and `_`):
 *  - is 16 or more characters and mixes letters and digits, unless it is
 *    hexadecimal in one letter case (a commit, digest or content hash);
 *  - is 8 or more characters and mixes upper case, lower case and digits;
 *  - holds a letter outside ASCII together with an ASCII digit.
 * A canonical UUID and a token that is all hexadecimal (7-64 characters) are
 * never refused. So `test_user_login_flow_v2`, `com.example.app.v1`, a git
 * SHA, a UUID or `/home/user/отчёт_2024.pdf` pass, while `ghp_…`, `…_prod`
 * glued to a key, Stripe or OpenAI style keys, and a look-alike token
 * written partly in another script are refused.
 *
 * Base64 secrets may hold `/` and `+`, which would split them into short
 * tokens. So a chunk is also refused when it holds a run of 32 or more
 * base64 characters (`A-Z a-z 0-9 + /`) with a `/` or `+`, upper case, lower
 * case and a digit, in which no piece between `/` and `+` reads as a word
 * (2+ lower-case letters, optionally capitalized). Real paths have word
 * pieces (`src`, `home`, `Users`).
 */
const CHUNK_DELIMITERS = /[\s"'`\u2018\u2019\u201c\u201d\u00ab\u00bb()[\]{}<>,;=:@|!?&#$*^~]+/u;
const PATH_SEPARATORS = /[\/\\]+/;
const SEGMENT_SEPARATORS = /[._-]+/;
const HEX_TOKEN = /^(?:[0-9a-f]{7,64}|[0-9A-F]{7,64})$/;
const HEX_SEGMENT = /^(?:[0-9a-f]+|[0-9A-F]+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;
const BASE64_RUN = /[A-Za-z0-9+/]{32,}/g;
const WORD_PIECE = /^[A-Z]?[a-z]{2,}$/;

function segmentLooksRandom(segment) {
  const length = [...segment].length;
  const letters = LETTER.test(segment);
  const digits = DIGIT.test(segment);
  if (!letters || !digits) return false;
  if (length >= 16 && !HEX_SEGMENT.test(segment)) return true;
  if (length >= 8 && /\p{Lu}/u.test(segment) && /\p{Ll}/u.test(segment)) return true;
  return /[0-9]/.test(segment) && /(?=\p{L})[^\x00-\x7f]/u.test(segment);
}

function tokenLooksRandom(token) {
  if ([...token].length < 20 || !LETTER.test(token) || !DIGIT.test(token)) return false;
  if (HEX_TOKEN.test(token) || UUID.test(token)) return false;
  return token.split(SEGMENT_SEPARATORS).some(segmentLooksRandom);
}

function base64RunLooksRandom(chunk) {
  for (const [run] of chunk.matchAll(BASE64_RUN)) {
    if (!/[+/]/.test(run) || !/[A-Z]/.test(run) || !/[a-z]/.test(run) || !/[0-9]/.test(run)) continue;
    if (!run.split(/[+/]+/).some(piece => WORD_PIECE.test(piece))) return true;
  }
  return false;
}

/** True when the screening form holds a token shaped like a credential (see above). */
export function holdsTokenShape(form) {
  return form.split(CHUNK_DELIMITERS).some(chunk => chunk && (base64RunLooksRandom(chunk) || chunk.split(PATH_SEPARATORS).some(tokenLooksRandom)));
}

/**
 * Screens a one-line quote in every form a reader or model might read it as:
 * as written, with terminal escape sequences removed, with bare colour-code
 * remnants spaced apart or removed, and with only escape introducers removed;
 * each also in its folded form (see fold). Every form goes through the one
 * pattern list (see patternIds), also with Cyrillic and Greek look-alikes
 * mapped to Latin; every folded form goes through the token shape rule (see
 * holdsTokenShape). Returns null when nothing is found, otherwise
 * `{ ids, shape }`: the matched pattern ids, and whether the shape rule
 * fired. Text over EVIDENCE_QUOTE_READ_CAP bytes is not scanned at all and
 * is reported as `oversize`, so the cost of the pattern scan stays bounded.
 */
export function screenSecrets(value) {
  const raw = String(value ?? '');
  if (Buffer.byteLength(raw, 'utf8') > EVIDENCE_QUOTE_READ_CAP) return { ids: ['oversize'], shape: false };
  const stripped = stripAnsi(raw);
  const written = [...new Set([raw, stripped, stripped.replace(SGR_REMNANT, ' '), stripped.replace(SGR_REMNANT, ''), stripEscapeIntroducers(raw)])];
  const folded = [...new Set(written.map(fold))];
  const forms = [...new Set([...written, ...folded, ...folded.map(skeleton)])];
  const ids = [...new Set(forms.flatMap(patternIds))];
  const shape = folded.some(holdsTokenShape);
  return ids.length || shape ? { ids, shape } : null;
}

/** Returns null when the quote is acceptable, otherwise the reason it is not. */
export function evidenceQuoteError(value) {
  if (typeof value !== 'string' || !value.trim()) return 'evidence_quote must be nonempty text';
  if (LINE_BREAK.test(value)) return 'evidence_quote must be a single line; pick the single most specific failing line (the assertion, error or diff line that shows the lesson) and quote only that';
  if (Buffer.byteLength(value, 'utf8') > EVIDENCE_QUOTE_CAP) return `evidence_quote must be at most ${EVIDENCE_QUOTE_CAP} bytes of verbatim error, test or diff text`;
  if (DISALLOWED.test(value.replace(EMOJI_PRESENTATION, ''))) return 'evidence_quote may contain tabs but no other control, bidirectional formatting, zero-width or tag characters, nor any other invisible character; strip terminal color codes';
  if (OPAQUE.test(value)) return 'evidence_quote may not contain private-use or unassigned characters or lone surrogates';
  const screen = screenSecrets(value);
  if (screen?.ids.length) return `evidence_quote looks like it contains a secret (${screen.ids.join(', ')}); redact it`;
  if (screen) return 'evidence_quote holds a token of 20 or more characters that mixes letters and digits like a credential (token-shaped); quote a different line, or one where such a token is not needed';
  return null;
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
 * with no indicator. A trailing YAML comment (` # ...` after the scalar) is
 * dropped, as YAML drops it. Null for anything else (empty, unclosed, flow,
 * block, anchored, aliased or tagged).
 */
function oneLineYamlScalar(raw) {
  const value = String(raw ?? '').trim();
  if (value.startsWith('"')) {
    const quoted = value.match(/^("(?:[^"\\]|\\.)*")(?:[ \t]+#.*)?$/);
    if (!quoted) return null;
    try {
      const parsed = JSON.parse(quoted[1]);
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'")) {
    const single = value.match(/^'((?:[^']|'')*)'(?:[ \t]+#.*)?$/);
    return single ? single[1].replaceAll("''", "'") : null;
  }
  const plain = value.replace(/(?:^|[ \t]+)#.*$/, '');
  return plain && !YAML_INDICATOR.test(plain) ? plain : null;
}

/** What readEvidenceQuote returns for a quote it will not read as one line. */
export const EVIDENCE_QUOTE_MULTI_LINE = '[redacted: multi-line]';

/** What readEvidenceQuote returns for a one-line value that is not one complete scalar. */
export const EVIDENCE_QUOTE_MALFORMED = '[redacted: malformed]';

/**
 * Reads the quote back from episode text, or null when the episode has none.
 * Fails closed: when the key appears more than once, or a line below it is
 * indented deeper than the key (which YAML would read as more of the value,
 * as when a long string is folded), the whole quote is withheld as
 * EVIDENCE_QUOTE_MULTI_LINE; when the value on the key's line is not a
 * complete one-line scalar (see oneLineYamlScalar), as
 * EVIDENCE_QUOTE_MALFORMED. Nothing is read in part.
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
  if (continues || keys.length > 1) return EVIDENCE_QUOTE_MULTI_LINE;
  return value === null ? EVIDENCE_QUOTE_MALFORMED : value;
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
 * Quoted evidence as inert data for an agent-facing packet, under the same
 * rules as a write. Anything a write refuses came from a legacy or
 * hand-edited file. Over EVIDENCE_QUOTE_READ_CAP bytes it is withheld whole
 * as `[redacted: oversize]` before any screening, and with a line break as
 * `[redacted: multi-line]`. Otherwise it is screened (see screenSecrets): a
 * pattern hit withholds it behind a marker naming the matched patterns, and a
 * token-shaped hit as `[redacted: token-shaped]`. A quote with no hit that
 * still holds ESC or any C1 control is withheld whole as
 * `[redacted: control-sequence]`. Otherwise invisible, private-use and
 * unassigned characters are removed (keeping the emoji allowance), C0
 * controls become spaces, and a quote still over EVIDENCE_QUOTE_CAP bytes is
 * cut at a code-point boundary and ends with ` [truncated]`, within the cap.
 */
export function inertEvidenceQuote(value) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') > EVIDENCE_QUOTE_READ_CAP) return '[redacted: oversize]';
  if (LINE_BREAK.test(text)) return '[redacted: multi-line]';
  const screen = screenSecrets(text);
  if (screen) return `[redacted: ${screen.ids.length ? screen.ids.join(', ') : 'token-shaped'}]`;
  if (READ_CONTROL.test(text)) return '[redacted: control-sequence]';
  const shown = inertLine(text.replace(DISPLAY_HIDDEN, (_, keep) => keep ?? ''));
  if (Buffer.byteLength(shown, 'utf8') <= EVIDENCE_QUOTE_CAP) return shown;
  return capBytes(shown, EVIDENCE_QUOTE_CAP - Buffer.byteLength(TRUNCATED)) + TRUNCATED;
}
