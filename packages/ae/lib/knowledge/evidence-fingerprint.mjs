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
export const EVIDENCE_PREFIX_LENGTH = 12;
/** The most check output a match reads. */
export const EVIDENCE_OUTPUT_CAP = 8 * 1024 * 1024;

// CR, LF, NEL (U+0085) and the Unicode line and paragraph separators.
const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;
const LINE_SPLIT = /\r\n|[\r\n\u0085\u2028\u2029]/;
// Every C0 and C1 control and DEL, except tab.
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/;
// Whole terminal escape sequences: CSI (ESC [ or the C1 CSI byte) with its
// parameters and final byte, OSC (ESC ] or the C1 OSC byte) up to its
// terminator, and any other ESC-introduced sequence.
const ANSI_SEQUENCE = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b[ -/]*[0-~]?/g;
const SHA256 = /^[0-9a-f]{64}$/;
const PREFIX = new RegExp(`^[0-9a-f]{${EVIDENCE_PREFIX_LENGTH},64}$`);

/**
 * The one normalisation used at capture and at verification: terminal escape
 * sequences removed and trailing whitespace (including a CR) trimmed.
 */
export function normalizeEvidenceLine(line) {
  return String(line ?? '').replace(ANSI_SEQUENCE, '').trimEnd();
}

const digest = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** Returns null when the line is acceptable, otherwise why it is not. Never echoes the line. */
export function evidenceLineError(value) {
  if (typeof value !== 'string' || !value.trim()) return 'evidence_quote must be nonempty text';
  if (LINE_BREAK.test(value)) return 'evidence_quote must be a single line; pick the single most specific failing line of the check output';
  if (Buffer.byteLength(value, 'utf8') > EVIDENCE_LINE_CAP) return `evidence_quote must be at most ${EVIDENCE_LINE_CAP} bytes`;
  const normalized = normalizeEvidenceLine(value);
  if (!normalized.trim()) return 'evidence_quote must be nonempty text';
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

/** Returns null when the value can name a fingerprint (12 to 64 lowercase hex characters), otherwise why not. */
export function evidencePrefixError(value) {
  return PREFIX.test(String(value ?? '')) ? null : `--match-evidence takes ${EVIDENCE_PREFIX_LENGTH} to 64 lowercase hex characters of an evidence sha256`;
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
