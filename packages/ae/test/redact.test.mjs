import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRedactor, redactedJson } from '../lib/redact.mjs';

function redactor(overrides = {}) {
  return createRedactor({ env: {}, ...overrides });
}

test('URL userinfo is masked in values and mapping keys without changing public locations', () => {
  const uri = 'https://canary-reader:canary-private-pass@example.invalid/skills';
  const clean = 'https://example.invalid/skills';
  const value = redactor().redactValue({ origin: uri, overrides: { [uri]: true }, public: clean });
  const raw = JSON.stringify(value);
  assert.doesNotMatch(raw, /canary-reader|canary-private-pass/);
  assert.match(raw, /redacted:url-credentials/);
  assert.equal(value.public, clean);
});

test('URL credentials containing an unescaped at sign are completely masked', () => {
  const uri = 'https://reader:initial@private-tail@example.invalid/product.git';
  assert.equal(new URL(uri).password, 'initial%40private-tail');
  const value = redactor().redactValue({ origin: uri, locations: { [uri]: true } });
  assert.doesNotMatch(JSON.stringify(value), /reader|initial|private-tail/);
  assert.match(value.origin, /example\.invalid/);
});

test('protocol-relative and special-scheme authority forms mask credentials', () => {
  for (const prefix of ['//', 'https:\\\\', 'https:\\', 'https:/', 'https:', 'https:/\\']) {
    const uri = `${prefix}reader:private-tail-canary@example.invalid/skills`;
    assert.equal((prefix === '//' ? new URL(uri, 'https://base.invalid') : new URL(uri)).password, 'private-tail-canary');
    const value = redactor().redactValue({ origin: uri, locations: { [uri]: true } });
    assert.doesNotMatch(JSON.stringify(value), /reader|private-tail-canary/);
  }
});

test('github-token: masks ghp_/gho_/github_pat_ tokens', () => {
  const { redactText } = redactor();
  const ghp = 'ghp_' + 'a'.repeat(36);
  const gho = 'gho_' + 'b'.repeat(36);
  const pat = 'github_pat_' + 'c'.repeat(30);
  assert.equal(redactText(`token: ${ghp}`), 'token: «redacted:github-token»');
  assert.equal(redactText(`token: ${gho}`), 'token: «redacted:github-token»');
  assert.equal(redactText(`token: ${pat}`), 'token: «redacted:github-token»');
  assert.ok(!redactText(`leak ${ghp} here`).includes(ghp), 'raw token never survives');
});

test('api-key: masks sk- style secret keys (including sk-proj- project keys)', () => {
  const { redactText } = redactor();
  const key = 'sk-' + 'X'.repeat(40);
  assert.equal(redactText(`key=${key}`), 'key=«redacted:api-key»');
  const proj = 'sk-proj-' + 'y'.repeat(30) + '_-Z9';
  assert.equal(redactText(`key=${proj}`), 'key=«redacted:api-key»');
});

test('slack-token: masks xox[abprs]- style tokens', () => {
  const { redactText } = redactor();
    const token = 'xox' + 'b-123456789012-abcdefghijklmnop';
  assert.equal(redactText(`slack ${token} end`), 'slack «redacted:slack-token» end');
});

test('aws-access-key: masks AKIA[0-9A-Z]{16}', () => {
  const { redactText } = redactor();
  const key = 'AKIAIOSFODNN7EXAMPLE';
  assert.equal(redactText(`aws_key=${key}`), 'aws_key=«redacted:aws-access-key»');
});

test('jwt: masks three-segment base64url JWTs', () => {
  const { redactText } = redactor();
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123_-';
  assert.equal(redactText(`Authorization: ${jwt}`), 'Authorization: «redacted:jwt»');
    assert.ok(!redactText(jwt).includes('-'), 'no leftover signature fragment survives');
});

test('private-key: masks a full PEM block, BEGIN through END inclusive', () => {
  const { redactText } = redactor();
  const pem = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAtestbase64line1',
    'MIIEowIBAAKCAQEAtestbase64line2',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const out = redactText(`before\n${pem}\nafter`);
  assert.equal(out, 'before\n«redacted:private-key»\nafter');
  assert.ok(!out.includes('MIIEow'), 'key body never survives');
});

test('bearer-token: masks the token after "Bearer ", keeping the scheme word', () => {
  const { redactText } = redactor();
  const out = redactText('Authorization: Bearer abcDEF1234567890_supersecretTokenValue');
  assert.equal(out, 'Authorization: Bearer «redacted:bearer-token»');
});

test('kv-secret: masks password=/token= values, preserving the key name', () => {
  const { redactText } = redactor();
  assert.equal(redactText('password=Sup3rSecret!'), 'password=«redacted:kv-secret»');
  assert.equal(redactText('token=abcdef1234567890'), 'token=«redacted:kv-secret»');
  // Case-insensitive key match, key casing preserved in the output.
  assert.equal(redactText('Token = abcdef1234567890'), 'Token = «redacted:kv-secret»');
});

test('kv-secret: masks colon, JSON and prefixed secret keys without touching look-alikes', () => {
  const { redactText } = redactor();
  const masked = [
    ['password: hunter2hunter2', 'password: «redacted:kv-secret»'],
    ['{"password": "hunter2hunter2"}', '{"password": "«redacted:kv-secret»"}'],
    ['api_key=abcd1234efgh5678', 'api_key=«redacted:kv-secret»'],
    ['secret=abcd1234efgh5678', 'secret=«redacted:kv-secret»'],
    ['DB_PASSWORD=x1', 'DB_PASSWORD=«redacted:kv-secret»'],
    ['aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'aws_secret_access_key = «redacted:kv-secret»'],
    ['client_secret: abc123', 'client_secret: «redacted:kv-secret»'],
  ];
  for (const [input, expected] of masked) assert.equal(redactText(input), expected, input);
  for (const clean of ['tokens: 1200', 'TOKEN_BUDGET=5', 'secrets are never committed', 'SECRET=undefined', '"token": null']) assert.equal(redactText(clean), clean);
  assert.equal(redactText('secret=nullable-value'), 'secret=«redacted:kv-secret»');
});

test('provider token shapes are masked by kind', () => {
  const { redactText } = redactor();
  const cases = [
    ['ASIAABCDEFGHIJKLMNOP', 'aws-access-key'],
    ['npm_' + 'a'.repeat(36), 'npm-token'],
    ['glpat-' + 'a'.repeat(20), 'gitlab-token'],
    ['AIza' + 'a'.repeat(35), 'google-api-key'],
  ];
  for (const [token, kind] of cases) assert.equal(redactText(`value ${token} end`), `value «redacted:${kind}» end`, kind);
});

test('basic-auth: masks Authorization Basic credentials but not the English word', () => {
  const { redactText } = redactor();
  assert.equal(redactText('Authorization: Basic dXNlcjpwYXNzd29yZA=='), 'Authorization: Basic «redacted:basic-auth»');
  assert.equal(redactText('Basic configuration works'), 'Basic configuration works');
});

test('clean text with no secret shapes passes through unchanged', () => {
  const { redactText } = redactor();
  const text = '# Fix\n\nUse two-step backfill for NOT NULL columns.';
  assert.equal(redactText(text), text);
});

test('mask format is «redacted:<kind>» and does not encode the secret length', () => {
  const { redactText } = redactor();
  const shortJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123_-';
  const longJwt =
    'eyJhbGciOiJIUzI1NiJ9' + 'x'.repeat(500) + '.' + 'y'.repeat(500) + '.' + 'z'.repeat(200);
  const outShort = redactText(shortJwt);
  const outLong = redactText(longJwt);
  assert.equal(outShort, '«redacted:jwt»');
  // Same mask, same length, regardless of how long the real secret was.
  assert.equal(outShort, outLong);
});

test('env-derived: masks a secret-shaped env var value wherever it appears, keyed by name', () => {
  const value = 'ghp_' + 'a'.repeat(40);
  const { redactText } = createRedactor({ env: { GITHUB_TOKEN: value } });
  assert.equal(redactText(`leaked: ${value} in the log`), 'leaked: «redacted:env:GITHUB_TOKEN» in the log');
  assert.ok(!redactText(value).includes(value), 'raw env value never survives');
});

test('env-derived: excludes known-benign PATH/FILE/DIR/SOCK-suffixed names', () => {
  const path = '/home/user/.ssh/id_rsa.pub';
  const { redactText } = createRedactor({
    env: {
      PUBLIC_KEY_PATH: path,
      CREDENTIAL_FILE: '/etc/app/creds.json',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock12345',
    },
  });
  assert.equal(redactText(`key path: ${path}`), `key path: ${path}`);
  assert.equal(redactText('/etc/app/creds.json'), '/etc/app/creds.json');
});

test('env-derived: ignores values shorter than the 8-char floor', () => {
  const { redactText } = createRedactor({ env: { API_KEY: 'short1' } });
  assert.equal(redactText('key is short1 here'), 'key is short1 here');
});

test('env-derived: ignores non-secret-shaped names and non-string values', () => {
  const { redactText } = createRedactor({
    env: { HOME: '/home/someone/with/a/long/path', PORT: 3000, DEBUG: undefined },
  });
  assert.equal(redactText('/home/someone/with/a/long/path'), '/home/someone/with/a/long/path');
});

test('env-derived: longer overlapping values are masked before shorter substrings of them', () => {
  const short = 'tokentokentoken1';
  const long = short + 'EXTRA_SUFFIX_MATERIAL';
  const { redactText } = createRedactor({
    env: { SHORT_TOKEN: short, LONG_TOKEN: long },
  });
  const out = redactText(long);
    assert.equal(out, '«redacted:env:LONG_TOKEN»');
});

test('env-derived and pattern-derived layers compose in one pass', () => {
  const envSecret = 'ghp_' + 'a'.repeat(40);
  const { redactText } = createRedactor({ env: { GITHUB_TOKEN: envSecret } });
  const patternSecret = 'ghp_' + 'b'.repeat(40); // shape matches, but not the env value
  const out = redactText(`${envSecret} and ${patternSecret}`);
  assert.equal(out, '«redacted:env:GITHUB_TOKEN» and «redacted:github-token»');
});

test('env-derived: masks a percent-encoded (encodeURIComponent) occurrence of a secret embedded in a URL', () => {
  const secret = 'abc+DEF/ghi=123 xyz'; // chars that change under encodeURIComponent
  const { redactText } = createRedactor({ env: { AWS_SECRET_ACCESS_KEY: secret } });
  const encoded = encodeURIComponent(secret);
  const url = `https://example.com/webhook?key=${encoded}`;
  const out = redactText(url);
  assert.equal(out, 'https://example.com/webhook?key=«redacted:env:AWS_SECRET_ACCESS_KEY»');
  assert.ok(!out.includes(secret), 'raw secret never survives');
  assert.ok(!out.includes(encoded), 'percent-encoded secret never survives');
});

test('env-derived: the raw (unencoded) form is still masked after adding the encoded needle', () => {
  const secret = 'abc+DEF/ghi=123 xyz';
  const { redactText } = createRedactor({ env: { AWS_SECRET_ACCESS_KEY: secret } });
  const out = redactText(`plain: ${secret} end`);
  assert.equal(out, 'plain: «redacted:env:AWS_SECRET_ACCESS_KEY» end');
});

test('env-derived: both the raw and percent-encoded forms are masked when both appear in the same text', () => {
  const secret = 'abc+DEF/ghi=123 xyz';
  const { redactText } = createRedactor({ env: { AWS_SECRET_ACCESS_KEY: secret } });
  const encoded = encodeURIComponent(secret);
  const out = redactText(`${secret} and ${encoded}`);
  assert.equal(out, '«redacted:env:AWS_SECRET_ACCESS_KEY» and «redacted:env:AWS_SECRET_ACCESS_KEY»');
});

test('env-derived: a value that is identical under encodeURIComponent is not double-registered', () => {
    const { redactText } = createRedactor({ env: { API_KEY: 'plainAlnumSecret1234' } });
  assert.equal(redactText('key=plainAlnumSecret1234'), 'key=«redacted:env:API_KEY»');
});

test('createRedactor() with no args defaults to process.env and never throws', () => {
  const { redactText, redactValue } = createRedactor();
  assert.equal(typeof redactText, 'function');
  assert.equal(typeof redactValue, 'function');
  assert.equal(redactText('nothing secret about this line'), 'nothing secret about this line');
});

test('redactValue walks strings inside plain objects and arrays, preserving structure', () => {
  const { redactValue } = redactor();
  const input = {
    id: 1,
    active: true,
    note: null,
    creds: ['token=abcdef1234567890', 'clean string'],
    nested: { password: 'password=hunter22222' },
  };
  const out = redactValue(input);
  assert.deepEqual(out, {
    id: 1,
    active: true,
    note: null,
    creds: ['token=«redacted:kv-secret»', 'clean string'],
    nested: { password: 'password=«redacted:kv-secret»' },
  });
});

test('redactValue does not mutate its input', () => {
  const { redactValue } = redactor();
  const input = { secret: 'token=abcdef1234567890' };
  const snapshotBefore = JSON.stringify(input);
  redactValue(input);
  assert.equal(JSON.stringify(input), snapshotBefore, 'input object must be unchanged');
});

test('redactValue leaves numbers, booleans, null, undefined, and non-plain objects untouched', () => {
  const { redactValue } = redactor();
  const date = new Date('2024-01-01T00:00:00Z');
  const out = redactValue({ n: 42, b: false, u: undefined, nul: null, d: date });
  assert.equal(out.n, 42);
  assert.equal(out.b, false);
  assert.equal(out.u, undefined);
  assert.equal(out.nul, null);
  assert.equal(out.d, date); // same reference — non-plain objects pass through
});

test('redactValue on a bare string behaves like redactText', () => {
  const { redactValue } = redactor();
  assert.equal(redactValue('token=abcdef1234567890'), 'token=«redacted:kv-secret»');
});

test('redactValue on a circular structure never throws or hangs', () => {
  const { redactValue } = redactor();
  const circular = { name: 'token=abcdef1234567890' };
  circular.self = circular;
  assert.doesNotThrow(() => redactValue(circular));
});

test('redactValue redacts a shared (non-cyclic) object reference on every occurrence, not just the first', () => {
  const { redactValue } = redactor();
  const shared = { secret: 'token=abcdef1234567890' };
  const out = redactValue({ a: shared, b: shared });
  assert.deepEqual(out, {
    a: { secret: 'token=«redacted:kv-secret»' },
    b: { secret: 'token=«redacted:kv-secret»' },
  });
    assert.equal(out.a, out.b);
});

test('redactValue still terminates on a genuine cycle and redacts the reachable, non-cyclic secret', () => {
  const { redactValue } = redactor();
  const circular = { name: 'token=abcdef1234567890' };
  circular.self = circular;
  let out;
  assert.doesNotThrow(() => {
    out = redactValue(circular);
  });
  assert.equal(out.name, 'token=«redacted:kv-secret»');
    assert.equal(out.self, '«redacted:cycle»');
});

function buildDiamond(depth, leafSecret) {
  let node = { secret: leafSecret };
  for (let i = 0; i < depth; i++) {
    const shared = node;
    node = { left: shared, right: shared };
  }
  return node;
}

test('redactValue on a binary-diamond DAG at depth 22 completes fast and redacts every path', () => {
  const { redactValue } = redactor();
  const leafSecret = 'token=abcdef1234567890';
  const root = buildDiamond(22, leafSecret);

  const start = performance.now();
  const out = redactValue(root);
  const durationMs = performance.now() - start;

    assert.ok(durationMs < 2000, `redactValue took ${durationMs.toFixed(1)}ms at DAG depth 22, expected < 2000ms`);

    let left = out;
  let right = out;
  for (let i = 0; i < 22; i++) {
    left = left.left;
    right = right.right;
  }
  assert.deepEqual(left, { secret: 'token=«redacted:kv-secret»' });
  assert.deepEqual(right, { secret: 'token=«redacted:kv-secret»' });
    assert.equal(left, right);
});

test('a shared node inside a small diamond is redacted identically on both branches (memo correctness)', () => {
  const { redactValue } = redactor();
  const shared = { a: 'token=abcdef1234567890', b: 'password=hunter2222' };
  const out = redactValue({ left: shared, right: shared });
  const expected = { a: 'token=«redacted:kv-secret»', b: 'password=«redacted:kv-secret»' };
  assert.deepEqual(out.left, expected);
  assert.deepEqual(out.right, expected);
});

test('never throws on binary-ish strings with control/null bytes', () => {
  const { redactText, redactValue } = redactor();
  const hostile = 'a\x00b\x1fc\x7f' + String.fromCharCode(0xffff);
  assert.doesNotThrow(() => redactText(hostile));
  assert.doesNotThrow(() => redactValue({ blob: hostile }));
});

test('never throws on lone UTF-16 surrogates', () => {
  const { redactText } = redactor();
  const lone = 'abc\uD800def\uDC00ghi';
  assert.doesNotThrow(() => redactText(lone));
});

test('never throws on a huge single line with no newlines', () => {
  const { redactText } = redactor();
  const huge = 'a'.repeat(2 * 1024 * 1024);
  let out;
  assert.doesNotThrow(() => {
    out = redactText(huge);
  });
  assert.equal(out.length, huge.length);
});

test('non-string / nullish input passes through unchanged rather than throwing', () => {
  const { redactText } = redactor();
  assert.equal(redactText(42), 42);
  assert.equal(redactText(null), null);
  assert.equal(redactText(undefined), undefined);
  assert.equal(redactText(''), '');
  assert.deepEqual(redactText({ not: 'a string' }), { not: 'a string' });
});

test('a throwing custom pattern falls back to a conservative full-line mask, never raw content', () => {
  const { redactText } = createRedactor({
    env: {},
    patterns: [{ kind: 'boom', re: /BOOM/, mask: () => { throw new Error('boom'); } }],
  });
  const out = redactText('line one has BOOM in it\nline two is clean\n\nlast line');
  assert.doesNotThrow(() => redactText('line one has BOOM in it'));
    assert.equal(out, '«redacted:error»\n«redacted:error»\n\n«redacted:error»');
});

test('malformed custom patterns are skipped without breaking the defaults', () => {
  const { redactText } = createRedactor({
    env: {},
    patterns: [null, {}, { kind: 'no-regex', re: 'not-a-regexp' }, { re: /whatever/ }],
  });
  const ghp = 'ghp_' + 'a'.repeat(36);
  assert.equal(redactText(ghp), '«redacted:github-token»');
});

test('custom patterns extend (do not replace) the defaults', () => {
  const { redactText } = createRedactor({
    env: {},
    patterns: [{ kind: 'internal-id', re: /\bINT-\d{6}\b/ }],
  });
  const ghp = 'ghp_' + 'a'.repeat(36);
  const out = redactText(`${ghp} and INT-123456`);
  assert.equal(out, '«redacted:github-token» and «redacted:internal-id»');
});

test('handles a 2 MiB string well under a generous time budget', () => {
  const { redactText } = createRedactor({ env: { GITHUB_TOKEN: 'ghp_' + 'a'.repeat(40) } });
  const filler = 'the quick brown fox jumps over the lazy dog in a benign log line. ';
  const parts = [];
  let bytes = 0;
  let i = 0;
  while (bytes < 2 * 1024 * 1024) {
    let line = filler;
    if (i % 5000 === 0) line += 'token=' + 'x'.repeat(20) + ' ';
    if (i % 7000 === 0) line += 'ghp_' + 'b'.repeat(36) + ' ';
    parts.push(line);
    bytes += line.length;
    i++;
  }
  const text = parts.join('\n');
  assert.ok(Buffer.byteLength(text, 'utf8') >= 2 * 1024 * 1024, 'fixture is at least 2 MiB');

  const start = performance.now();
  const out = redactText(text);
  const durationMs = performance.now() - start;

    assert.ok(durationMs < 1000, `redactText took ${durationMs.toFixed(1)}ms on 2 MiB, expected < 1000ms`);
  assert.ok(!out.includes('ghp_' + 'b'.repeat(36)), 'secrets are actually redacted, not just fast');
});

test('redactValue masks secret-shaped OBJECT KEYS, not just values', () => {
  const { redactValue } = redactor();
  const out = redactValue({ 'token=abcdef1234567890': 'v' });
  assert.deepEqual(out, { 'token=«redacted:kv-secret»': 'v' });
  assert.ok(!JSON.stringify(out).includes('abcdef1234567890'), 'the raw secret must not survive in any key');
});

test('redactValue masks secret keys at every nesting level, alongside secret values', () => {
  const { redactValue } = redactor();
  const ghp = 'ghp_' + 'a'.repeat(36);
  const out = redactValue({ outer: { [ghp]: 'x', clean: 'token=abcdef1234567890' } });
  assert.deepEqual(out, {
    outer: { '«redacted:github-token»': 'x', clean: 'token=«redacted:kv-secret»' },
  });
});

test('redactValue key collision after masking is last-wins (documented trade: losing data beats leaking it)', () => {
  const { redactValue } = redactor();
  // Two DISTINCT secret-shaped keys that both mask to the same string.
  const input = {};
  input['token=abcdef1234567890'] = 'first';
  input['token=zyxwvu9876543210'] = 'second';
  const out = redactValue(input);
  assert.deepEqual(Object.keys(out), ['token=«redacted:kv-secret»']);
  assert.equal(out['token=«redacted:kv-secret»'], 'second', 'later entry wins the collided masked key');
});

test('redactValue keys of secret-free objects are byte-identical (no false rewrites)', () => {
  const { redactValue } = redactor();
  const input = { command: 'orient', checks: [{ id: 'plan-schema', pass: true }] };
  assert.equal(JSON.stringify(redactValue(input)), JSON.stringify(input));
});

test('redactValue depth guard yields a masked sentinel, never the raw subtree', () => {
  const { redactValue } = redactor();
  // Build a chain 60 levels deep with a secret at the bottom.
  let node = { secret: 'token=abcdef1234567890' };
  for (let i = 0; i < 60; i++) node = { child: node };
  const out = redactValue(node);
  const text = JSON.stringify(out);
  assert.ok(!text.includes('abcdef1234567890'), 'the deep secret must never survive the depth guard');
  assert.ok(text.includes('«redacted:depth-limit»'), 'the guard must leave a visible sentinel, not silently drop or leak');
});

test('redactValue cycle guard yields a masked sentinel, never the raw subtree (secret in the cyclic node)', () => {
  const { redactValue } = redactor();
  const a = { secret: 'token=abcdef1234567890' };
  a.self = a;
  const out = redactValue({ wrap: a });
  assert.equal(out.wrap.secret, 'token=«redacted:kv-secret»');
  assert.equal(out.wrap.self, '«redacted:cycle»');
  assert.ok(!JSON.stringify(out).includes('abcdef1234567890'));
});

test('redactedJson serializes with redaction applied (compact and pretty)', async () => {
  const { redactedJson } = await import('../lib/redact.mjs');
  const value = { why: 'token=abcdef1234567890', ok: true };
  const compact = redactedJson(value, { redactor: redactor() });
  assert.equal(compact, '{"why":"token=«redacted:kv-secret»","ok":true}');
  const pretty = redactedJson(value, { pretty: true, redactor: redactor() });
  assert.equal(pretty, JSON.stringify({ why: 'token=«redacted:kv-secret»', ok: true }, null, 2));
});

test('redactedJson is byte-identical to bare JSON.stringify for secret-free data', async () => {
  const { redactedJson } = await import('../lib/redact.mjs');
  const value = {
    schema: 1,
    command: 'orient',
    status: 'ok',
    recall: [{ id: 'a', score: 0.4 }],
    nested: { deep: { list: [1, 2, 3], flag: false, note: null } },
  };
  assert.equal(redactedJson(value, { redactor: redactor() }), JSON.stringify(value));
  assert.equal(redactedJson(value, { pretty: true, redactor: redactor() }), JSON.stringify(value, null, 2));
});

test('redactedJson: a toJSON() that emits a secret at serialize time is still masked', async () => {
  const { redactedJson } = await import('../lib/redact.mjs');
    const sneaky = { toJSON() { return 'token=abcdef1234567890'; } };
  const out = redactedJson({ payload: sneaky }, { redactor: redactor() });
  assert.ok(!out.includes('abcdef1234567890'), 'a serialize-time secret must never survive the boundary');
  assert.equal(out, '{"payload":"token=«redacted:kv-secret»"}');
});

test('redactedJson: a getter that emits a secret at serialize time is masked, and secret-free toJSON stays byte-identical', async () => {
  const { redactedJson } = await import('../lib/redact.mjs');
  const gh = 'ghp_' + 'a'.repeat(36);
  const sneaky = { toJSON() { return { leak: gh }; } };
  const out = redactedJson({ nested: sneaky }, { redactor: redactor() });
  assert.ok(!out.includes(gh), 'a serialize-time github token must be masked');
  assert.equal(out, `{"nested":{"leak":"«redacted:github-token»"}}`);
  // Byte-identity: a Date's toJSON (secret-free) is untouched by the text pass.
  const d = new Date('2026-08-06T00:00:00.000Z');
  assert.equal(redactedJson({ at: d }, { redactor: redactor() }), JSON.stringify({ at: d }));
});

test('redactedJson: an own __proto__ key survives the redaction rebuild byte-identically', async () => {
  const { redactedJson } = await import('../lib/redact.mjs');
  const withProto = JSON.parse('{"__proto__": {"x": 1}, "keep": 2}');
  const out = redactedJson(withProto, { redactor: redactor() });
  assert.equal(out, '{"__proto__":{"x":1},"keep":2}', 'the own __proto__ key must survive, in order');
});

test('redactValue: a secret nested under an own __proto__ key is still masked and the key survives', () => {
  const { redactValue } = redactor();
  const input = JSON.parse('{"__proto__": {"leak": "token=abcdef1234567890"}}');
  const out = redactValue(input);
  assert.ok(Object.prototype.hasOwnProperty.call(out, '__proto__'), 'the own __proto__ key must not vanish');
  assert.equal(JSON.stringify(out), '{"__proto__":{"leak":"token=«redacted:kv-secret»"}}');
});

const GHP = 'ghp_' + 'a'.repeat(36);

const ADVERSARIAL_JSON_CASES = [
  {
    name: 'secret immediately followed by an escaped quote (verified pre-fix leak)',
    value: { message: 'no learning "token=abcdef1234567890" found' },
  },
  {
    name: 'check stdout: secret immediately followed by an escaped quote (verified pre-fix leak, E_TARGET shape)',
    value: { stdout: 'FAIL expected "token=abcdef1234567890" got x' },
  },
  {
    name: 'password= variant immediately followed by an escaped quote',
    value: { message: 'rejected "password=Sup3rSecret!" for user' },
  },
  {
    name: 'secret containing a "," sequence in its captured value',
    value: { note: 'bad "token=abcdef1234567890,x" here' },
  },
  {
    name: 'secret immediately adjacent to a literal backslash (not an escaped quote)',
    value: { path: String.raw`prefix token=abcdef1234567890\ trailing backslash` },
  },
  {
    name: 'secret at the very end of a string value (no trailing text)',
    value: { tail: 'find token=abcdef1234567890' },
  },
  {
    name: 'secret as the entire string value',
    value: { whole: 'token=abcdef1234567890' },
  },
  {
    name: 'secret nested inside an array placement',
    value: { rows: ['clean', 'no learning "token=abcdef1234567890" found', 'also clean'] },
  },
  {
    name: 'secret nested two levels deep inside an object',
    value: { outer: { inner: { deep: 'no learning "token=abcdef1234567890" found' } } },
  },
  {
    name: 'multiple quoted secret shapes in the same string (kv-secret and github-token)',
    value: { combo: `bad "token=abcdef1234567890" and "${GHP}" both quoted` },
  },
];

test('redactedJson: adversarial secret/quote/backslash placements never produce malformed JSON (compact)', () => {
  for (const { name, value } of ADVERSARIAL_JSON_CASES) {
    const out = redactedJson(value, { redactor: redactor() });
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(out);
    }, `[${name}] JSON.parse must not throw on: ${out}`);
    const roundTripped = JSON.stringify(parsed);
    assert.ok(!roundTripped.includes('abcdef1234567890'), `[${name}] raw kv-secret must not survive`);
    assert.ok(!roundTripped.includes('Sup3rSecret!'), `[${name}] raw password must not survive`);
    assert.ok(!roundTripped.includes('a'.repeat(36)), `[${name}] raw github token must not survive`);
  }
});

test('redactedJson: adversarial secret/quote/backslash placements never produce malformed JSON (pretty)', () => {
  for (const { name, value } of ADVERSARIAL_JSON_CASES) {
    const out = redactedJson(value, { pretty: true, redactor: redactor() });
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(out);
    }, `[${name}] pretty JSON.parse must not throw on: ${out}`);
    const roundTripped = JSON.stringify(parsed);
    assert.ok(!roundTripped.includes('abcdef1234567890'), `[${name}] raw kv-secret must not survive (pretty)`);
  }
});

test('redactedJson: secret-free adversarial-shaped text (quotes, backslashes, commas) stays byte-identical', () => {
  const value = {
    message: 'no learning "clean value" found',
    path: String.raw`C:\Users\example\file.txt`,
    note: 'a,b","c irrelevant punctuation',
    rows: ['clean "quoted" text', 'a\\b\\c'],
  };
  assert.equal(redactedJson(value, { redactor: redactor() }), JSON.stringify(value));
  assert.equal(redactedJson(value, { pretty: true, redactor: redactor() }), JSON.stringify(value, null, 2));
});

// --- P3D1: glued-secret boundaries (Phase 1 debt, assigned to Phase 3) ---

test('a secret glued onto a preceding word is still masked', () => {
  const { redactText } = createRedactor();
  const cases = [
    ['prefixghp_abcdefghijklmnopqrstuvwxyz012345', 'github-token'],
    ['xAKIAIOSFODNN7EXAMPLE', 'aws-access-key'],
    ['zzxoxb-1234567890-abcdef', 'slack-token'],
    ['id:42github_pat_abcdefghijklmnopqrstuvwx', 'github-token'],
  ];
  for (const [input, kind] of cases) {
    const out = redactText(input);
    assert.match(out, new RegExp(`redacted:${kind}`), `${input} must be masked`);
    assert.equal(/abcdefghijklmnopqrst|IOSFODNN7EXAMPLE|1234567890-abcdef/.test(out), false,
      `${input} must not leave any of the secret behind`);
  }
});

test('dropping the boundary did not start masking ordinary prose', () => {
  const { redactText } = createRedactor();
  for (const prose of [
    'the task-oriented-refactoring-notes file',
    'a risk-assessment-document-here',
    'disk-usage-report-generated-today',
  ]) {
    assert.equal(redactText(prose), prose, `${prose} is not a secret and must survive untouched`);
  }
  // …while a genuine sk- key still masks.
  assert.match(redactText('sk-abcdefghijklmnopqrstuvwxyz'), /redacted:api-key/);
});
