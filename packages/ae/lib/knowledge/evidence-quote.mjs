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

/** Returns null when the quote is acceptable, otherwise the reason it is not. */
export function evidenceQuoteError(value) {
  if (typeof value !== 'string' || !value.trim()) return 'evidence_quote must be nonempty text';
  if (Buffer.byteLength(value, 'utf8') > EVIDENCE_QUOTE_CAP) return `evidence_quote must be at most ${EVIDENCE_QUOTE_CAP} bytes of verbatim error, test or diff text`;
  // Tab, newline and CR are escaped on write. Other control characters, such
  // as terminal color codes, would land raw in frontmatter.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return 'evidence_quote must not contain control characters other than tab and newline; strip terminal color codes';
  const secrets = scanSecrets(value);
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

/** Quoted evidence as inert data for an agent-facing packet: one line, secrets redacted, capped. */
export function inertEvidenceQuote(value) {
  return inertLine(redactSecrets(value)).slice(0, EVIDENCE_QUOTE_CAP);
}
