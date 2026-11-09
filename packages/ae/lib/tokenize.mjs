const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was',
  'has', 'have', 'not', 'but', 'you', 'your', 'our', 'can', 'will', 'need',
]);

/** Split an identifier into its parts: camelCase, snake_case, kebab-case, digits. */
function identifierParts(token) {
  return token
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ACRONYMBoundary
    .split(/[-_]+/) // snake / kebab
    .join(' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Light, deterministic suffix stemmer — collapses common morphology only. */
function stem(word) {
  if (word.length <= 4) return word;
  for (const suffix of ['ications', 'ization', 'izations', 'ing', 'ers', 'ies', 'ied', 'es', 'ed', 's']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      let base = word.slice(0, -suffix.length);
      if (suffix === 'ies') base += 'y';
      if (suffix === 'ications') base += 'y';
      return base;
    }
  }
  return word;
}

export function tokenize(s) {
    const raw = String(s ?? '')
    .replace(/[^A-Za-z0-9_\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const out = new Set();
  for (const token of raw) {
    const lower = token.toLowerCase();
    const parts = identifierParts(token);
    if (lower.length > 2 && !STOPWORDS.has(lower)) out.add(stem(lower));
    if (parts.length > 1) {
      for (const part of parts) {
        if (part.length > 2 && !STOPWORDS.has(part)) out.add(stem(part));
      }
    }
  }
  return [...out];
}

export const FIELD_BOOSTS = {
  symptom: 3.0,
  title: 2.5,
  tags: 2.0,
  module: 1.5,
  summary: 1.2,
  excerpt: 1.0,
};
