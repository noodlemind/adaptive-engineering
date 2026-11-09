import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanSecrets, redactSecrets } from '../lib/secret-scan.mjs';

test('scanSecrets flags common credential shapes with line numbers', () => {
  const text = ['title: ok', 'key=AKIAIOSFODNN7EXAMPLE', 'token: ghp_' + 'a'.repeat(36)].join('\n');
  const hits = scanSecrets(text);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.id).sort(), ['aws-access-key', 'github-token']);
  assert.equal(hits.find((h) => h.id === 'aws-access-key').line, 2);
});

test('scanSecrets passes clean markdown', () => {
  assert.deepEqual(scanSecrets('# Fix\n\nUse two-step backfill for NOT NULL columns.'), []);
});

test('scanSecrets flags PEM, JWT, connection strings, bearer and slack tokens', () => {
  const samples = [
    ['-----BEGIN RSA PRIVATE KEY-----', 'private-key'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123_-', 'jwt'],
    ['postgres://user:s3cret@db.internal:5432/app', 'connection-string'],
    ['Authorization: Bearer abcdef1234567890abcdef', 'bearer-token'],
        ['xox' + 'b-1234567890' + '12-abcdefghijklmnop', 'slack-token'],
  ];
  for (const [sample, id] of samples) {
    assert.equal(scanSecrets(sample)[0]?.id, id, `expected ${id} for: ${sample}`);
  }
});

test('scanSecrets flags generic api key assignments but not prose about keys', () => {
  assert.equal(scanSecrets('api_key = "' + 'Zx9'.repeat(8) + '"')[0]?.id, 'generic-api-key');
  assert.deepEqual(scanSecrets('Rotate the api key quarterly and store it in the vault.'), []);
});

test('scanSecrets handles empty and non-string input', () => {
  assert.deepEqual(scanSecrets(''), []);
  assert.deepEqual(scanSecrets(null), []);
});

test('redactSecrets (sweep P3): replaces a secret-shaped field with a pattern-named marker, and passes clean/empty text through unchanged', () => {
  const aws = 'AKIAIOSFODNN7EXAMPLE';
  const out = redactSecrets(`leaked ${aws} here`);
  assert.ok(!out.includes(aws), 'the raw secret is never returned');
  assert.equal(out, '[redacted: aws-access-key]');
  // Multiple distinct patterns on one line are named once each, de-duplicated.
  const multi = redactSecrets(`${aws} and ghp_${'a'.repeat(36)}`);
  assert.equal(multi, '[redacted: aws-access-key, github-token]');
  // No false redaction of benign content, and null/empty are safe passthroughs.
  assert.equal(redactSecrets('a normal recall title'), 'a normal recall title');
  assert.equal(redactSecrets(''), '');
  assert.equal(redactSecrets(null), '');
});

test('scanSecrets flags temporary AWS, npm, GitLab, Google and Basic auth credentials', () => {
  const lines = ['ASIAABCDEFGHIJKLMNOP', 'npm_' + 'a'.repeat(36), 'glpat-' + 'a'.repeat(20), 'AIza' + 'a'.repeat(35), 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'aws_secret_access_key = ' + 'A'.repeat(40)];
  const ids = scanSecrets(lines.join('\n')).map(hit => hit.id);
  assert.deepEqual(ids, ['aws-access-key', 'npm-token', 'gitlab-token', 'google-api-key', 'basic-auth', 'generic-api-key']);
});
