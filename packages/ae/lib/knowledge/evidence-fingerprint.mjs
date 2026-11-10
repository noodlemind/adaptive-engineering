import crypto from 'node:crypto';

/**
 * Evidence for an episode: the single failing line of check or test output
 * that showed the lesson. The line itself is never stored or shown. Harness
 * keeps only its fingerprint, the SHA-256 of the normalised line
 * (`evidence_sha256`) and that line's length in bytes (`evidence_bytes`), as
 * two frontmatter fields. Agents see the first EVIDENCE_PREFIX_LENGTH hex
 * characters and the length, re-run the check themselves, and match its
 * output against the fingerprint (see matchEvidence). No raw check output
 * reaches an agent through Harness, so no secret screening of it is needed.
 */
export const EVIDENCE_LINE_CAP = 600;
/** The most raw input accepted before normalisation (colour codes can be long). */
export const EVIDENCE_RAW_CAP = 4096;
export const EVIDENCE_PREFIX_LENGTH = 12;
/** The most check output a match reads. */
export const EVIDENCE_OUTPUT_CAP = 8 * 1024 * 1024;

// CR, LF, NEL (U+0085) and the Unicode line and paragraph separators.
const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;
const LINE_SPLIT = /\r\n|[\r\n\u0085\u2028\u2029]/;
// Every C0 and C1 control and DEL, except tab.
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/;
// Terminal escape sequences, removed whole: an OSC (ESC ] or the C1 OSC byte)
// only with its terminator (BEL, ESC \\ or ST), a CSI (ESC [ or the C1 CSI
// byte) with its parameters and final byte, and any other ESC sequence except
// an unterminated OSC. What is left of an unterminated OSC loses only its ESC,
// so it cannot swallow the rest of the line; a C1 OSC byte stays and is
// refused as a control character.
const ANSI_SEQUENCE = /(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b(?!\])[ -/]*[0-~]?|\x1b/g;
const SHA256 = /^[0-9a-f]{64}$/;
const PREFIX = new RegExp(`^[0-9a-f]{${EVIDENCE_PREFIX_LENGTH},64}$`, 'i');

/**
 * The one normalisation used at capture and at verification: a leading BOM
 * (U+FEFF) and terminal escape sequences removed, Unicode NFC applied, and
 * whitespace at both ends trimmed.
 */
export function normalizeEvidenceLine(line) {
  return String(line ?? '').replace(/^\ufeff/, '').replace(ANSI_SEQUENCE, '').normalize('NFC').trim();
}

const digest = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** Returns null when the line is acceptable, otherwise why it is not. Never echoes the line. */
export function evidenceLineError(value) {
  if (typeof value !== 'string' || !value.trim()) return 'evidence_quote must be nonempty text';
  if (LINE_BREAK.test(value)) return 'evidence_quote must be a single line; pick the single most specific failing line of the check output';
  if (Buffer.byteLength(value, 'utf8') > EVIDENCE_RAW_CAP) return `evidence_quote must be at most ${EVIDENCE_LINE_CAP} bytes`;
  const normalized = normalizeEvidenceLine(value);
  if (!normalized) return 'evidence_quote must be nonempty text';
  if (Buffer.byteLength(normalized, 'utf8') > EVIDENCE_LINE_CAP) return `evidence_quote must be at most ${EVIDENCE_LINE_CAP} bytes`;
  if (CONTROL.test(normalized)) return 'evidence_quote may contain tabs but no other control characters';
  return null;
}

/** The fingerprint of an accepted line: `{ sha256, bytes }` of its normalised form. */
export function evidenceFingerprint(value) {
  const normalized = normalizeEvidenceLine(value);
  return { sha256: digest(normalized), bytes: Buffer.byteLength(normalized, 'utf8') };
}

/** The frontmatter lines that store a fingerprint. */
export function evidenceFrontmatterLines({ sha256, bytes }) {
  return [`evidence_sha256: ${sha256}`, `evidence_bytes: ${bytes}`];
}

/**
 * The fingerprint stored in an episode's frontmatter fields, or null. Only
 * `evidence_sha256` and `evidence_bytes` are read; a hand-written
 * `evidence_quote` key is never read.
 */
export function readEvidenceFingerprint(fm) {
  const sha256 = String(fm?.evidence_sha256 ?? '').trim();
  const bytes = Number(String(fm?.evidence_bytes ?? '').trim());
  if (!SHA256.test(sha256) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > EVIDENCE_LINE_CAP) return null;
  return { sha256, bytes };
}

/** What an agent sees of a fingerprint: its prefix and byte length. */
export function evidenceSummary({ sha256, bytes }) {
  return { sha256_prefix: sha256.slice(0, EVIDENCE_PREFIX_LENGTH), bytes };
}

/** Returns null when the value can name a fingerprint (12 to 64 hex characters), otherwise why not. */
export function evidencePrefixError(value) {
  return PREFIX.test(String(value ?? '')) ? null : `--match-evidence takes ${EVIDENCE_PREFIX_LENGTH} to 64 hex characters of an evidence sha256`;
}

/** Returns null when the value can be a stored evidence length, otherwise why not. */
export function evidenceBytesError(value) {
  const n = Number(value);
  return /^\d+$/.test(String(value ?? '')) && n >= 1 && n <= EVIDENCE_LINE_CAP ? null : `--evidence-bytes takes a whole number from 1 to ${EVIDENCE_LINE_CAP}`;
}

const placeholder = value => (value === '-' ? '-' : '<evidence>');

/**
 * The run-journal argv of `ae compound`: every flag kept, the value of
 * --evidence-quote (either form) replaced by `<evidence>` (or kept when it is
 * `-`, which names stdin), so no evidence line, accepted or refused, is
 * journaled. The value is literal, so the token after the space form is
 * always the value, whatever it looks like.
 */
export function compoundJournalArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.push(...argv.slice(i)); break; }
    if (a.startsWith('--evidence-quote=')) out.push(`--evidence-quote=${placeholder(a.slice('--evidence-quote='.length))}`);
    else if (a === '--evidence-quote') {
      out.push(a);
      if (i + 1 < argv.length) out.push(placeholder(argv[++i]));
    } else out.push(a);
  }
  return out;
}

/**
 * Whether any line of check output, normalised as at capture, has a SHA-256
 * starting with `prefix` (and, when given, the stored byte length). Returns
 * `{ matched, line }` with the 1-based line number of the first match, or
 * null. The output is read, never stored or echoed.
 */
export function matchEvidence(output, prefix, { bytes = null } = {}) {
  const want = String(prefix ?? '').toLowerCase();
  const lines = String(output ?? '').split(LINE_SPLIT);
  for (let i = 0; i < lines.length; i++) {
    const normalized = normalizeEvidenceLine(lines[i]);
    if (!normalized) continue;
    if (bytes !== null && Buffer.byteLength(normalized, 'utf8') !== bytes) continue;
    if (digest(normalized).startsWith(want)) return { matched: true, line: i + 1 };
  }
  return { matched: false, line: null };
}
