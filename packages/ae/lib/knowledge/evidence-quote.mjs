import { scanSecrets, redactSecrets } from '../secret-scan.mjs';
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

/** Returns null when the quote is acceptable, otherwise the reason it is not. */
export function evidenceQuoteError(value) {
  if (typeof value !== 'string' || !value.trim()) return 'evidence_quote must be nonempty text';
  if (Buffer.byteLength(value, 'utf8') > EVIDENCE_QUOTE_CAP) return `evidence_quote must be at most ${EVIDENCE_QUOTE_CAP} bytes of verbatim error, test or diff text`;
  if (DISALLOWED.test(value)) return 'evidence_quote may contain tabs, newlines and carriage returns but no other control, bidirectional formatting, line separator, zero-width or tag characters; strip terminal color codes';
  // Scan the line-joined form too: a credential split across lines must not
  // pass here and then reassemble when the quote is rendered as one line.
  const secrets = [...scanSecrets(value), ...scanSecrets(inertLine(value))];
  if (secrets.length) return `evidence_quote looks like it contains a secret (${[...new Set(secrets.map(s => s.id))].join(', ')}); redact it`;
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
 * Quoted evidence as inert data for an agent-facing packet: joined to one line
 * by inertLine (which also blanks C1 and bidirectional controls) before the
 * secret screen, so a split credential is caught, then capped in bytes at a
 * code-point boundary.
 */
export function inertEvidenceQuote(value) {
  return capBytes(redactSecrets(inertLine(value)), EVIDENCE_QUOTE_CAP);
}
