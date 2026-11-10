const PATTERNS = [
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'basic-auth', re: /\bAuthorization["']?\s*[:=]\s*["']?Basic\s+[A-Za-z0-9+/]{8,}={0,2}/i },
  {
    id: 'github-token',
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/ },
  { id: 'connection-string', re: /\b\w+:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/ },
  { id: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/i },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    id: 'generic-api-key',
    re: /\b(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|secret[_-]?key|secret[_-]?access[_-]?key|client[_-]?secret|access[_-]?token)["']?\s*[=:]\s*["']?[A-Za-z0-9_\-/+]{20,}["']?/i,
  },
];

/**
 * The patterns scanSecrets applies, for callers that need match positions
 * (the evidence-quote split screen). Read-only: do not mutate.
 */
export const SECRET_PATTERNS = PATTERNS;

export function scanSecrets(text) {
  const hits = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { id, re } of PATTERNS) {
      if (re.test(lines[i])) hits.push({ id, line: i + 1 });
    }
  }
  return hits;
}

/**
 * Best-effort secret screen for a single rendered field (sweep P3): the recall/
 * manifest ingestion path never ran scanSecrets, so a credential committed into
 * a manifest title/snippet or a hand-authored solution doc could surface
 * verbatim on the agent-facing context pack and `ae recall`. On any hit,
 * return a marker naming the matched pattern(s) INSTEAD of the field's content,
 * so the secret is never rendered. Same regex-grade caveat as scanSecrets
 * itself — screening, not prevention; the never-pushed out-of-tree store stays
 * the real backstop (documented residual #5).
 */
// Default-ignorable and format characters, as stripInvisible in
// knowledge/store.mjs removes them. inertLine removes them from rendered
// text, so a token broken by one would render whole after redaction.
const INVISIBLE_CHARS = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;

export function redactSecrets(text) {
  const s = String(text ?? '');
  const visible = s.replace(INVISIBLE_CHARS, '');
  const hits = visible === s ? scanSecrets(s) : [...scanSecrets(s), ...scanSecrets(visible)];
  if (!hits.length) return s;
  return `[redacted: ${[...new Set(hits.map((h) => h.id))].join(', ')}]`;
}

const RECALL_UNTRUSTED_STRING_FIELDS = ['docid', 'path', 'title', 'summary', 'snippet'];

export function redactRecallEntry(entry) {
  const redacted = { ...entry };
  for (const field of RECALL_UNTRUSTED_STRING_FIELDS) {
    const value = redacted[field];
    if (typeof value === 'string' && value) redacted[field] = redactSecrets(value);
  }
  return redacted;
}
