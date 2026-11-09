const ENV_SECRET_NAME_RE = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)/i;

const ENV_BENIGN_SUFFIX_RE = /_(PATH|FILE|DIR|SOCK)$/i;

const ENV_MIN_SECRET_LENGTH = 8;

const MASK_PREFIX = '«redacted:';
const MASK_SUFFIX = '»'; // «redacted:kind»

function mask(kind) {
  return `${MASK_PREFIX}${kind}${MASK_SUFFIX}`;
}

export function redactionMarker(kind) {
  return mask(kind);
}

const FALLBACK_MASK = mask('error');

const DEFAULT_PATTERNS = [
  {
    kind: 'url-credentials',
    re: /((?:\b(?:https?|wss?|ftp):[\\/]*|\b[a-z][a-z0-9+.-]*:[\\/]{2,}|(?<![:\w])[\\/]{2,}))[^\\/?#\s]+@/i,
    mask: (_match, scheme) => `${scheme}${mask('url-credentials')}@`,
  },
  {
    kind: 'github-token',
    re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,255}\b|github_pat_[A-Za-z0-9_]{20,255}\b/,
  },
  {
    kind: 'api-key',
    re: /\bsk-[A-Za-z0-9_-]{16,255}\b/,
  },
  {
    // Slack bot/user tokens.
    kind: 'slack-token',
    re: /xox[abprs]-[A-Za-z0-9-]{10,255}\b/,
  },
  {
    // Long-lived (AKIA) and temporary STS (ASIA) access key IDs. No leading `\b`,
    // so a key glued to a preceding word character is still caught.
    kind: 'aws-access-key',
    re: /(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    kind: 'npm-token',
    re: /\bnpm_[A-Za-z0-9]{36}\b/,
  },
  {
    kind: 'gitlab-token',
    re: /\bglpat-[A-Za-z0-9_-]{20,255}\b/,
  },
  {
    kind: 'google-api-key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    kind: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,20000}\.[A-Za-z0-9_-]{8,20000}\.[A-Za-z0-9_-]{4,2000}/,
  },
  {
    kind: 'private-key',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[^]{0,4096}?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    kind: 'bearer-token',
    re: /(?<=\bBearer\s)[A-Za-z0-9._~+/=-]{8,255}/i,
  },
  {
    kind: 'basic-auth',
    re: /(?<=\bAuthorization["']?\s*[:=]\s*["']?Basic\s+)[A-Za-z0-9+/]{8,1000}={0,2}/i,
  },
  {
    // `key=value`, `key: value` and JSON `"key": "value"` for secret-named keys,
    // including prefixed names such as DB_PASSWORD or aws_secret_access_key.
    // Literal undefined/null/true/false values carry no secret and stay readable.
    kind: 'kv-secret',
    re: /\b((?:[A-Za-z0-9]+[_-])*(?:password|passwd|passphrase|secret[_-]?access[_-]?key|client[_-]?secret|private[_-]?key|access[_-]?key|api[_-]?key|apikey|secret|token))(["']?\s*[:=]\s*["']?)(?!«|(?:undefined|null|true|false)(?![^\s&"',;}]))[^\s&"',;}]{1,500}/i,
    mask: (_match, key, sep) => `${key}${sep}${mask('kv-secret')}`,
  },
];

function normalizePattern({ kind, re, mask: maskFn }) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const compiled = new RegExp(re.source, flags);
  const replacer = typeof maskFn === 'function' ? maskFn : () => mask(kind);
  return { kind, re: compiled, replacer };
}

const NORMALIZED_DEFAULT_PATTERNS = DEFAULT_PATTERNS.map(normalizePattern);

/** Normalize caller-supplied patterns, silently dropping malformed entries
 * rather than letting one bad custom pattern break every default one. */
function normalizeCustomPatterns(patterns) {
  const normalized = [];
  if (!Array.isArray(patterns)) return normalized;
  for (const p of patterns) {
    if (!p || typeof p.kind !== 'string' || !(p.re instanceof RegExp)) continue;
    try {
      normalized.push(normalizePattern(p));
    } catch {
      // Malformed regex source/flags on a custom entry — skip it, defaults
      // and every other valid custom pattern still apply.
    }
  }
  return normalized;
}

/** Build the env-derived mask table once per createRedactor call. Two literal
 * needles per qualifying env var — the raw value AND its
 * `encodeURIComponent` form, when they differ — both mapped to the SAME
 * `«redacted:env:NAME»` marker. A secret embedded in a URL (a git remote,
 * a webhook, `AWS_SECRET_ACCESS_KEY` in a query string) is routinely
 * percent-encoded wherever it carries `/`, `+`, spaces, or other reserved
 * characters; a literal-only check never finds that form (real gap, fixed
 * per review). Every needle (raw and encoded, across every var) is sorted
 * longest-first so a needle that happens to be a substring of another
 * needle is never partially destroyed before the longer, more specific
 * match gets a chance to run. */
function buildEnvMasks(env) {
  const masks = [];
  if (!env || typeof env !== 'object') return masks;
  let entries;
  try {
    entries = Object.entries(env);
  } catch {
    return masks;
  }
  for (const [name, rawValue] of entries) {
    if (!ENV_SECRET_NAME_RE.test(name)) continue;
    if (ENV_BENIGN_SUFFIX_RE.test(name)) continue;
    if (typeof rawValue !== 'string') continue;
    if (rawValue.length < ENV_MIN_SECRET_LENGTH) continue;
    const maskText = mask(`env:${name}`);
    masks.push({ value: rawValue, mask: maskText });
    let encoded;
    try {
      encoded = encodeURIComponent(rawValue);
    } catch {
      // A lone surrogate in the value makes encodeURIComponent throw
      // (URIError) — fall back to the raw value so nothing is added twice.
      encoded = rawValue;
    }
    if (encoded && encoded !== rawValue) {
      masks.push({ value: encoded, mask: maskText });
    }
  }
  masks.sort((a, b) => b.value.length - a.value.length);
  return masks;
}

function applyEnvMasks(text, envMasks) {
  let out = text;
  for (const { value, mask: m } of envMasks) {
    if (out.includes(value)) out = out.replaceAll(value, m);
  }
  return out;
}

function applyPatternMasks(text, patterns) {
  let out = text;
  for (const { re, replacer } of patterns) {
    out = out.replace(re, replacer);
  }
  return out;
}

/** Last-resort, conservative fallback for redactText's non-throw guarantee
 * (req #3): mask every non-empty line wholesale rather than risk returning
 * a partially masked — or, worse, entirely unmasked — secret because some
 * step of the normal pipeline broke. Deliberately coarse: correctness of
 * WHAT triggered the failure is secondary to never leaking raw content. */
function fullLineFallback(text) {
  try {
    return text
      .split('\n')
      .map((line) => (line.length ? FALLBACK_MASK : line))
      .join('\n');
  } catch {
    return FALLBACK_MASK;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Depth guard against a pathologically deep (but non-cyclic, so a WeakSet
// alone wouldn't catch it) nested structure blowing the call stack.
const MAX_WALK_DEPTH = 50;

// Fix-wave Important #4: the depth and cycle guards used to RETURN THE
// ORIGINAL subtree — the one place in the walk where unredacted content
// could sail straight through to a sink. A guard trip now yields a fixed
// masked sentinel instead: coarse (the whole subtree is replaced), but a
// guard trip only happens on hostile/degenerate input, where losing detail
// beats leaking a secret buried 51 levels deep or behind a self-reference.
const DEPTH_LIMIT_MASK = mask('depth-limit');
const CYCLE_MASK = mask('cycle');

// Two distinct pieces of state, doing two distinct jobs:
//
// - `seen` (a WeakSet) is the CYCLE guard — the current recursion PATH (this
//   node's ancestors), not every node ever visited. Added on entry, deleted
//   on exit. A true cycle (a node that is its own ancestor) is caught
//   because the ancestor is still in `seen` while its own descendants are
//   being walked.
// - `memo` (a WeakMap) is the SHARING guard — every node whose redaction has
//   already been FULLY computed, keyed to its finished result. Consulted
//   before `seen`/depth, so once a node's subtree is done, every OTHER path
//   that reaches the same node reuses the cached result in O(1) instead of
//   re-walking it. Safe because `redactText`/`walk` are pure and
//   deterministic — the same input node always produces the same output.
//
// Both are required together, not either alone:
//   - `seen` alone (round 1 of this fix) correctly redacts a shared,
//     non-cyclic node on every occurrence, but re-WALKS it from scratch each
//     time — fine for a handful of duplicate references, but a diamond-
//     shaped DAG (a node reachable via 2^k distinct paths at depth k, e.g.
//     `{left: shared, right: shared}` nested k times) turns that repeated
//     work exponential: measured ~34ms at depth 15 → ~7.8s at depth 23 on
//     this module's own dev machine, effectively a hang, and well below
//     MAX_WALK_DEPTH — an input-shaped denial-of-service that violates the
//     "never throw/hang on hostile input" guarantee just as much as an
//     uncaught exception would. Fixed per review round 2.
//   - `memo` alone, without `seen`, would treat "currently being computed"
//     (not yet in the memo) the same as "never seen" and recurse forever on
//     a genuine cycle — `seen` is what stops that.
function walk(value, redactText, seen, memo, depth) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) {
    if (memo.has(value)) return memo.get(value);
    if (depth >= MAX_WALK_DEPTH) return DEPTH_LIMIT_MASK;
    if (seen.has(value)) return CYCLE_MASK;
    seen.add(value);
    const out = value.map((item) => walk(item, redactText, seen, memo, depth + 1));
    seen.delete(value);
    memo.set(value, out);
    return out;
  }
  if (isPlainObject(value)) {
    if (memo.has(value)) return memo.get(value);
    if (depth >= MAX_WALK_DEPTH) return DEPTH_LIMIT_MASK;
    if (seen.has(value)) return CYCLE_MASK;
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Fix-wave Important #4: object KEYS are free text too — a payload
      // shaped `{'token=<secret>': ...}` used to persist its key verbatim
      // because only values ever passed through redactText. Keys are now
      // masked with the same text redactor. Collision note (documented
      // trade): if two distinct keys mask to the SAME string, last-wins —
      // the later entry overwrites the earlier one, which loses a value but
      // can only happen when BOTH keys carried secret-shaped content, and
      // losing data always beats leaking it.
      const mk = redactText(k);
      const mv = walk(v, redactText, seen, memo, depth + 1);
      // Fix-wave P2 (__proto__ byte-identity): a bare `out[mk] = mv` when
      // mk === '__proto__' hits Object.prototype's __proto__ SETTER — it
      // reassigns the clone's prototype and drops the own key entirely, so
      // `redactedJson({"__proto__": ...})` silently lost it. defineProperty
      // installs a genuine own, enumerable data property named exactly mk
      // (the literal "__proto__" included) without invoking any setter, so
      // every own key survives and JSON.stringify emits it byte-identically.
      // Normal keys keep the plain assignment (fast path; the clone stays an
      // ordinary Object.prototype object, so deepEqual/deepStrictEqual on
      // secret-free output is unchanged).
      if (mk === '__proto__') {
        Object.defineProperty(out, mk, { value: mv, enumerable: true, writable: true, configurable: true });
      } else {
        out[mk] = mv;
      }
    }
    seen.delete(value);
    memo.set(value, out);
    return out;
  }
  // Numbers, booleans, null, undefined, and non-plain objects (Date, Map,
  // class instances, …) are not the free-text carriers this module targets
  // — pass through unchanged rather than guess at how to redact them.
  return value;
}

/**
 * Build a redactor bound to one environment snapshot and one pattern set.
 * All inputs are injectable for tests; defaults read the real process env.
 *
 * @param {object} [opts]
 * @param {object} [opts.env] - Source of env-derived secrets. Defaults to
 *   `process.env`. Pass `{}` to disable env-derived masking entirely.
 * @param {Array<{kind: string, re: RegExp, mask?: Function}>} [opts.patterns]
 *   - Additional pattern rules, appended after the built-in defaults (so a
 *   value already classified by a default pattern keeps that kind). Each
 *   entry needs `kind` (string) and `re` (RegExp); `mask` is an optional
 *   `(match, ...groups) => string` replacer, defaulting to the whole match
 *   becoming `«redacted:<kind>»`. Malformed entries are silently skipped.
 * @returns {{redactText: (text: any) => any, redactValue: (value: any) => any}}
 */
export function createRedactor({ env = process.env, patterns = [] } = {}) {
  let envMasks;
  try {
    envMasks = buildEnvMasks(env);
  } catch {
    envMasks = [];
  }
  const allPatterns = [...NORMALIZED_DEFAULT_PATTERNS, ...normalizeCustomPatterns(patterns)];

  /** Pure function of `text`: no network, no model, no mutation of input.
   * Never throws — on any internal failure, falls back to a conservative
   * full-line mask (req #3) instead of propagating the error or returning
   * the unredacted original. */
  function redactText(text) {
    if (typeof text !== 'string' || !text) return text;
    try {
      const envMasked = applyEnvMasks(text, envMasks);
      return applyPatternMasks(envMasked, allPatterns);
    } catch {
      return fullLineFallback(text);
    }
  }

  /** Walk a plain object/array (or a bare string), applying `redactText` to
   * every string leaf while preserving the original shape. Numbers,
   * booleans, null, and non-plain-object values pass through untouched.
   * Never mutates the input; never throws — on internal failure, returns
   * the fixed error mask rather than the possibly-unredacted original. A
   * fresh `seen`/`memo` pair is created per call, so this stays a pure
   * function of `value` — no state (and no memory) survives between calls.
   *
   * Output-aliasing note (P1.6 carry-list d): `memo` (see `walk` below) means
   * every input reference to the SAME node produces the SAME output
   * reference too — `out.a === out.b` for `redactValue({a: shared, b:
   * shared})` — not independent copies. The output object graph mirrors the
   * input's own sharing rather than expanding it into a tree; a caller that
   * mutates one occurrence of a redacted shared subtree in place would see
   * that mutation reflected at every other occurrence that pointed at the
   * same input node. This is what makes a diamond-shaped input graph
   * O(distinct nodes) instead of O(paths) to redact (see the module's fix
   * round 2 notes) — a deliberate trade, not an oversight. */
  function redactValue(value) {
    try {
      return walk(value, redactText, new WeakSet(), new WeakMap(), 0);
    } catch {
      return FALLBACK_MASK;
    }
  }

  return { redactText, redactValue };
}

/**
 * THE shared redacting emission boundary (fix-wave C2/C3): serialize any
 * JSON-shaped value for a sink — stdout `--json`/envelope output, a JSONL
 * stream row, an events.jsonl append — redacting FIRST, in one place, so no
 * individual output lane can forget to. Every sink that writes command
 * output or persists an event must route through this (or through
 * `redactValue` directly) immediately before serialization.
 *
 * Byte-identity guarantee: for secret-free input, `redactValue` preserves
 * shape, key order, and every value, so the serialized JSON is byte-for-byte
 * what a bare `JSON.stringify` would have produced — redaction at this
 * boundary is invisible unless something actually needed masking.
 *
 * @param {*} value - the JSON-shaped value to serialize.
 * @param {object} [opts]
 * @param {boolean} [opts.pretty] - `JSON.stringify(..., null, 2)` when true.
 * @param {{redactValue: Function}} [opts.redactor] - injectable for tests /
 *   reuse of an already-built instance; defaults to a fresh `createRedactor()`
 *   bound to the live process env (secure by default, never stale).
 * @returns {string} the redacted JSON text (no trailing newline).
 */
export function redactedJson(value, { pretty = false, redactor } = {}) {
  const active = redactor || createRedactor();
  // Structural walk first: this masks free-text VALUES and rewrites
  // secret-shaped OBJECT KEYS. Keys matter here because a JSON.stringify
  // replacer (below) can only rewrite a property's VALUE, never its key
  // name, so `redactValue`'s key-masking has no serialize-time equivalent
  // and must run as its own pass regardless of how values get masked.
  const safe = active.redactValue(value);
  // Fix-wave (JSON-validity regression): masking used to run as a TEXT pass
  // over the ALREADY-SERIALIZED JSON string (`redactText(JSON.stringify(...))`).
  // That is unsound: `redactText`'s pattern matching has no notion of JSON
  // string escaping, so a secret-shaped match immediately followed by an
  // escaped quote (`\"`) could consume the escaping backslash as part of the
  // match, destroying the escape and terminating the JSON string early.
  // Verified pre-fix leak: `redactedJson({message: 'no learning "token=…"
  // found'})` produced `{"message":"no learning \"token=«redacted:kv-secret»"
    const replacer = (_key, val) => (typeof val === 'string' ? active.redactText(val) : val);
  return pretty ? JSON.stringify(safe, replacer, 2) : JSON.stringify(safe, replacer);
}
