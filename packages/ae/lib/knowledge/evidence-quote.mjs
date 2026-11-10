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
// One exception: emoji presentation. VARIATION SELECTOR-16 (U+FE0F) is
// allowed anywhere, and ZERO WIDTH JOINER (U+200D) between two pictographs
// (a VS16 or a skin-tone modifier may sit before it), so `Warning ⚠️` and
// `dev 👨‍💻` are accepted. A joiner anywhere else, such as between two
// letters of a token, is still refused. Screening removes both (see
// stripInvisible), so neither can hide a token from the secret scan.
const EMOJI_PRESENTATION = /\ufe0f|(?<=\p{Extended_Pictographic}(?:\ufe0f|[\u{1f3fb}-\u{1f3ff}])?)\u200d(?=\p{Extended_Pictographic})/gu;
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

// The shared inertLine blanks only C0 controls and DEL, so it never changes
// how a path or title displays. A quote also has every C1 control (such as NEL
// and the CSI byte) and the Unicode line and paragraph separators blanked, so
// it always renders as one line wherever it is shown.
const QUOTE_LINE_BREAKERS = /[\x80-\x9f\u2028\u2029]/g;
const inertQuoteLine = text => inertLine(text).replace(QUOTE_LINE_BREAKERS, ' ');
const secretIds = forms => [...new Set(forms.flatMap(form => scanSecrets(form).map(hit => hit.id)))];

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

// A run of token characters (what a key, token or password is made of) this
// long that only exists once lines are joined is a split secret, when a
// wrapped-token fragment sits next to one of its joins (see splitIds).
export const SPLIT_TOKEN_MIN = 20;
// A whole line of token characters this long reads as a fragment of a wrapped
// token rather than a word.
export const SPLIT_FRAGMENT_MIN = 8;
const TOKEN_RUN = new RegExp(`[A-Za-z0-9_+/=.-]{${SPLIT_TOKEN_MIN},}`, 'g');
const TOKEN_LINE = /^[A-Za-z0-9_+/=.-]+$/;
// An identifier or dotted name, such as `AssertionError`,
// `expected_checksum_value` or `java.lang.NullPointerException`. Stack traces
// and test output put these on lines of their own, so they are not fragments.
const IDENTIFIER_OR_DOTTED = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
// The prefixes of the identifier-shaped credentials in SECRET_PATTERNS.
const SECRET_PREFIX = /gh[pousr]_|github_pat_|AKIA|ASIA|npm_|glpat-|xox[abprs]-|sk-/;

// Whether a whole-token line (or the join of a run of them) is shaped like a
// token rather than a name: anything that is not an identifier or dotted name
// (it holds `+`, `/`, `=` or `-`, or starts with a digit), an undotted
// identifier that holds a digit, or anything that holds a credential prefix.
// So a dotted name is never a fragment, and neither is a letters-only
// identifier such as `AssertionError` or `abcdabcdabcdabcdabcd`: mixed case
// cannot tell `NullPointerException` from a random token, so it is not used.
const tokenShaped = text => !IDENTIFIER_OR_DOTTED.test(text) || SECRET_PREFIX.test(text) || (!text.includes('.') && /\d/.test(text));

// Which lines are wrapped-token fragments: a token-shaped whole line of token
// characters that is SPLIT_FRAGMENT_MIN or longer, or a line in a maximal
// sequence of consecutive whole-token lines whose join is token-shaped and
// SPLIT_TOKEN_MIN or longer (a token wrapped over many short lines).
function fragmentLines(lines) {
  const fragment = lines.map(() => false);
  for (let i = 0; i < lines.length;) {
    if (!TOKEN_LINE.test(lines[i])) { i++; continue; }
    let j = i;
    let chain = '';
    while (j < lines.length && TOKEN_LINE.test(lines[j])) chain += lines[j++];
    const chained = chain.length >= SPLIT_TOKEN_MIN && tokenShaped(chain);
    for (let k = i; k < j; k++) fragment[k] = chained || (lines[k].length >= SPLIT_FRAGMENT_MIN && tokenShaped(lines[k]));
    i = j;
  }
  return fragment;
}

// Whether a run of SPLIT_TOKEN_MIN or more token characters crosses a join
// with a fragment line on either side of that join. A whole-token line lies
// entirely inside any run that touches it, since runs are maximal.
function splitTokenRun(text, lines, joins) {
  const fragment = fragmentLines(lines);
  // lineStart[i] is where line i begins in the joined text.
  const lineStart = [0, ...joins];
  TOKEN_RUN.lastIndex = 0;
  let line = 0;
  let m;
  while ((m = TOKEN_RUN.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    while (line + 1 < lines.length && lineStart[line + 1] <= start) line++;
    // Each join inside the run sits between line k - 1 and line k.
    for (let k = line + 1; k < lines.length && lineStart[k] < end; k++) {
      if (fragment[k - 1] || fragment[k]) return true;
    }
  }
  return false;
}

// A line ends at CRLF, CR, LF, NEL (U+0085) or the Unicode line and paragraph
// separators. Before a line is trimmed, every control character but tab and
// every invisible character is removed from it: trim() keeps NUL, DEL and the
// C1 controls, so one left at a line's edge would turn into a space at the
// join and hide the split. Removing them can only join more text, so the
// screen fails closed.
const LINE_BREAK = /\r\n|[\r\n\u0085\u2028\u2029]/;
const LINE_NOISE = /[\x00-\x08\x0a-\x1f\x7f-\x9f\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;

// Separators source code and shells put at a line edge to continue a string
// on the next line: quotes (Python implicit concatenation, `'a' +` in JS), a
// `+` operator, a trailing backslash, and a comma. They are removed from
// each line's edges before the join. A `+` counts only when it stands apart
// or next to a quote, since `+` inside a base64 run is token text.
const JOIN_EDGE_END = /(?:[\s'"`\\,]|(?<=^|[\s'"`])\+)+$/;
const JOIN_EDGE_START = /^(?:[\s'"`\\,]|\+(?=$|[\s'"`]))+/;
const NON_TOKEN = /[^A-Za-z0-9_+/=.-]/;

// The longest prefix every line shares, cut back to end at its last non-token
// character (such as `[stderr] ` or `stdout | `), when that is 3 or more
// characters; otherwise ''. Cutting at a non-token character keeps the
// shared first characters of the lines' own text.
function commonLinePrefix(lines) {
  let prefix = lines[0];
  for (const line of lines) {
    let n = 0;
    while (n < prefix.length && n < line.length && prefix[n] === line[n]) n++;
    prefix = prefix.slice(0, n);
    if (!prefix) return '';
  }
  let end = prefix.length;
  while (end > 0 && !NON_TOKEN.test(prefix[end - 1])) end--;
  return end >= 3 ? prefix.slice(0, end) : '';
}

// The ids of what only shows once a form's lines are joined with nothing
// between them, which is how a credential wrapped across lines reads. The
// form is split into lines, each line loses its controls and invisible
// characters and is trimmed, empty lines are dropped (so blank lines cannot
// pad a split apart), and the rest are joined once. Two rules apply, neither
// bounded by a line count:
//
// - `split-token`: a maximal run of token characters ([A-Za-z0-9_+/=.-]) of
//   SPLIT_TOKEN_MIN or more that crosses a join, where a line on either side
//   of that join is a wrapped-token fragment: a whole line of token characters
//   of SPLIT_FRAGMENT_MIN or more, or part of a sequence of consecutive
//   whole-token lines whose joined length is SPLIT_TOKEN_MIN or more. This
//   does not depend on any secret pattern, so a key wrapped over any number of
//   lines is caught whatever its shape. A line ending in a long path followed
//   by a short word line (`FAIL test/retry.test.mjs` then `  retry`) is
//   ordinary output: neither line is a fragment.
// - a secret pattern that matches across a join. This keeps connection
//   strings fail-closed: `@`, `:` and `//` are not token characters, so a
//   line ending in `scheme://host:port` followed by a line starting with an
//   email address or an `@scope/` package reads the same as a password
//   wrapped after its leading digits (`postgres://svc.user:2024` then
//   `WinterPass@prod.example.com`). A dotted user name cannot be told from a
//   host, so that log shape fails closed on purpose.
//
// Before the join, a prefix that every line shares (see commonLinePrefix) is
// removed, and so are continuation separators at each line's edges (see
// JOIN_EDGE_END), so `[stderr] ` on every line, `"ab"` then `"cd"`, `'ab' +`
// then `'cd'`, and `ab\` then `cd` all join to `abcd`.
//
// What still defeats the join, by design or for now: a prefix that differs
// from line to line (line numbers, timestamps) or is shorter than 3
// characters; continuation operators other than the ones above (`.` in PHP,
// `..` in Lua, `||` in SQL, `&` in VB, `)` or `;` at an edge); a separator
// inside a line rather than at its edge (a tab or space between two halves on
// one line), which no renderer joins; and a token split into letters-only or
// dotted pieces, which tokenShaped reads as names (a letters-only credential
// with no known prefix wrapped over lines passes, such as `abcd` five times).
//
// Splitting, trim() and one scan per pattern keep the cost linear.
function splitIds(form) {
  let lines = form.split(LINE_BREAK).map(line => inertQuoteLine(line.replace(LINE_NOISE, '').trim())).filter(Boolean);
  if (lines.length < 2) return [];
  const prefix = commonLinePrefix(lines);
  if (prefix) lines = lines.map(line => line.slice(prefix.length));
  lines = lines.map(line => line.replace(JOIN_EDGE_END, '').replace(JOIN_EDGE_START, '')).filter(Boolean);
  if (lines.length < 2) return [];
  const joins = [];
  let text = lines[0];
  for (let i = 1; i < lines.length; i++) {
    joins.push(text.length);
    text += lines[i];
  }
  const ids = GLOBAL_PATTERNS.filter(({ re }) => matchesAcrossJoin(re, text, joins)).map(({ id }) => id);
  if (!ids.length && splitTokenRun(text, lines, joins)) ids.push('split-token');
  return ids;
}

/**
 * Screens a quote in every form a reader or model might reassemble: as
 * written, with terminal escape sequences removed, with bare colour-code
 * remnants spaced apart from what follows (a remnant right before a token)
 * and removed entirely (a remnant inside a token), and each of those joined
 * to one line with each break as a space. Each form is also screened with
 * every invisible character removed (see stripInvisible), so a token broken
 * by one is seen whole, and in Unicode compatibility form (NFKC), so a
 * fullwidth or other compatibility look-alike of a credential is seen as the
 * ASCII token it reads as. Any match there is a direct hit.
 *
 * Only when no such form matches is the compact form checked (see splitIds):
 * the nonblank lines joined with nothing between them, which is how a
 * credential wrapped across lines reads. A compact match counts as a split
 * secret only if it spans a join point, so it cannot be seen on any one line.
 * Returns null when no form holds a secret; `split` is true when only the
 * compact form does.
 */
export function screenSecrets(value) {
  const raw = String(value ?? '');
  const stripped = stripAnsi(raw);
  const written = [raw, stripped, stripped.replace(SGR_REMNANT, ' '), stripped.replace(SGR_REMNANT, ''), stripEscapeIntroducers(raw)];
  const visible = [...written, ...written.map(stripInvisible)];
  const bases = [...new Set([...visible, ...visible.map(form => form.normalize('NFKC'))])];
  const direct = secretIds([...bases, ...bases.map(inertQuoteLine)]);
  if (direct.length) return { ids: direct, split: false };
  const split = [...new Set(bases.flatMap(splitIds))];
  return split.length ? { ids: split, split: true } : null;
}

/** Returns null when the quote is acceptable, otherwise the reason it is not. */
export function evidenceQuoteError(value) {
  if (typeof value !== 'string' || !value.trim()) return 'evidence_quote must be nonempty text';
  if (Buffer.byteLength(value, 'utf8') > EVIDENCE_QUOTE_CAP) return `evidence_quote must be at most ${EVIDENCE_QUOTE_CAP} bytes of verbatim error, test or diff text`;
  if (DISALLOWED.test(value.replace(EMOJI_PRESENTATION, ''))) return 'evidence_quote may contain tabs, newlines and carriage returns but no other control, bidirectional formatting, line separator, zero-width or tag characters, nor any other invisible character; strip terminal color codes';
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
 * any screening. Otherwise the quote is screened in every form screenSecrets
 * checks, including the compact form where a credential split across a line
 * break is joined back together. Any hit withholds the whole quote behind a
 * marker naming the matched patterns, or `split-secret` when only the compact
 * form matched. A quote with no hit that still holds ESC or any C1 control
 * (which a write refuses, so only a foreign or hand-edited file has one) is
 * withheld whole as `[redacted: control-sequence]`, so no escape sequence is
 * ever interpreted or half-removed on display. Otherwise invisible characters (default-ignorable and format characters)
 * are removed outright, exactly as in the form screened without them, and the
 * quote is joined to one line (C0, DEL, C1 and the line and paragraph
 * separators become spaces) and capped in bytes at a code-point boundary.
 */
export function inertEvidenceQuote(value) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') > EVIDENCE_QUOTE_READ_CAP) return '[redacted: oversize]';
  const screen = screenSecrets(text);
  if (screen) return screen.split ? '[redacted: split-secret]' : `[redacted: ${screen.ids.join(', ')}]`;
  if (READ_CONTROL.test(text)) return '[redacted: control-sequence]';
  return capBytes(inertQuoteLine(stripInvisible(stripAnsi(text))), EVIDENCE_QUOTE_CAP);
}
