export const VALUE_FLAGS = Object.freeze(new Set([
  '--acceptance', '--activity', '--adapter', '--ae-home', '--agent', '--allow-env', '--applies', '--authority', '--autonomy', '--base', '--body', '--body-file', '--branch',
  '--category', '--changes', '--claim', '--classification', '--collection', '--command', '--constraint', '--content', '--copilot-home', '--criteria', '--critical-open',
  '--cursor', '--context-version', '--cwd', '--date', '--depth', '--docid', '--does-not-apply', '--domain', '--enforcement',
  '--expect', '--expected-output', '--file', '--from', '--from-home', '--from-id', '--gap', '--gap-fulfillment', '--goal', '--harness-home', '--host', '--id', '--ids', '--impacted', '--intent', '--intent-source', '--layer', '--learnings',
  '--intent-page', '--intent-page-size',
  '--editor', '--name', '--launcher', '--installation', '--user-data', '--config-root', '--plugins-root',
  '--config-home', '--host-home', '--skills-home', '--output-directory',
  '--limit', '--lines', '--match', '--max-bytes', '--max-seconds', '--max-turns',
  '--min-score', '--model', '--new', '--offset', '--old', '--ops', '--output', '--path', '--phase', '--plan',
  '--profile', '--provider', '--query', '--reason', '--reference', '--review-completed', '--risk', '--scope', '--session', '--shows', '--since',
  '--retention-policy',
  '--context-policy',
  '--question-kind', '--generation',
  '--slug', '--source', '--spec', '--stale', '--status', '--success-criterion', '--tags', '--target', '--text', '--timeout', '--verification-check',
  '--title', '--to', '--tool-timeout', '--trigger', '--type', '--until', '--verify-cmd', '--why',
  '--workspace', '--attempt',
  '--packet', '--learning-decision', '--reviewer',
  '--sources', '--renderer', '--layout', '--root', '--operation', '--flow', '--receipt', '--max-nodes', '--scale',
  '-c',
]));

export function isValueFlag(token, extra = null) {
  if (typeof token !== 'string' || !token.startsWith('-')) return false;
  if (token.includes('=')) return false; // `--limit=5` carries its own value
  return VALUE_FLAGS.has(token) || (extra ? extra.has(token) : false);
}

export function positionalsOf(argv, { limit = Infinity, extra = null } = {}) {
  const out = [];
  const widen = extra ? new Set(extra) : null;
  for (let i = 0; i < argv.length && out.length < limit; i += 1) {
    const token = argv[i];
    if (token === '--') break;
    if (typeof token !== 'string') continue;
    if (token.startsWith('-') && token !== '-') {
            if (isValueFlag(token, widen) && argv[i + 1] !== undefined && argv[i + 1] !== '--') i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

export function verbOf(argv, known, { fallback = null, extra = null } = {}) {
    const positionals = positionalsOf(argv, { extra });
  return positionals.length ? positionals[0] : fallback;
}
