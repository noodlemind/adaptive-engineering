import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inspectCheckReadiness } from '../lib/check-readiness.mjs';
import { trustResultOf } from '../lib/trust-cmd.mjs';
import { approveProject } from '../lib/trust.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-check-readiness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'ae'), copilotHome = path.join(root, 'copilot');
  fs.mkdirSync(workspace);
  const source = path.join(workspace, '.github/harness/checks.yaml');
  const write = text => { fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, text); };
  return { workspace, home, copilotHome, source, write };
}

test('an empty shared config reports concrete check preparation independently of trust', t => {
  const f = fixture(t); f.write('version: 1\nchecks: {}\n');
  const result = inspectCheckReadiness(f);
  assert.equal(result.status, 'empty');
  assert.equal(result.ready, false);
  assert.equal(result.source, f.source);
  assert.match(result.sourceDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.checks, []);
  assert.equal(result.remediation.owner, 'engineer');
  assert.deepEqual(result.remediation.command.slice(2, 6), ['checks', 'configure', '--file', '-']);
  assert.ok(result.remediation.command.includes(f.workspace));
  assert.ok(result.remediation.command.includes(f.home));
  assert.equal(fs.existsSync(path.join(f.home, 'trust.yaml')), false);
});

test('missing private configuration is recoverable without creating files', t => {
  const f = fixture(t), result = inspectCheckReadiness(f);
  assert.equal(result.status, 'missing');
  assert.equal(result.sourceMode, 'local');
  assert.ok(result.source.startsWith(f.home + path.sep));
  assert.equal(result.sourceDigest, null);
  assert.equal(fs.existsSync(f.home), false);
  assert.equal(fs.existsSync(path.join(f.workspace, '.github')), false);
});

test('configured checks are not executed or confused with passed verification', t => {
  const f = fixture(t), marker = path.join(f.workspace, 'executed');
  f.write(JSON.stringify({ version: 1, checks: { behavior: { command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] } } }));
  const result = inspectCheckReadiness(f);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.behavioralChecks, ['behavior']);
  assert.equal(result.remediation, null);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(Object.hasOwn(result, 'passed'), false);
});

test('type-only and malformed entries are actionable without guessing a test command', t => {
  const f = fixture(t);
  f.write('version: 1\nchecks:\n  types:\n    command: [tsc, --noEmit]\n    proof: type-check\n');
  assert.equal(inspectCheckReadiness(f).status, 'unusable');
  f.write('version: 1\nchecks:\n  tests:\n    command: []\n');
  const invalid = inspectCheckReadiness(f);
  assert.equal(invalid.status, 'invalid');
  assert.match(invalid.invalid[0].reason, /non-empty/);
  assert.equal(invalid.remediation.command[3], 'configure');
  f.write('version: 1\nchecks: [broken\n');
  const malformed = inspectCheckReadiness(f);
  assert.equal(malformed.status, 'invalid');
  assert.equal(malformed.remediation.command[3], 'list');
});

test('an unused invalid declaration does not send a usable workspace through setup again', t => {
  const f = fixture(t);
  f.write(JSON.stringify({ version: 1, checks: { behavior: { command: [process.execPath, 'test.mjs'] }, old: { command: [] } } }));
  const result = inspectCheckReadiness(f);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.behavioralChecks, ['behavior']);
  assert.equal(result.invalid[0].name, 'old');
  assert.equal(result.remediation, null);
});

test('large check inventories remain bounded even when surfaced through a context barrier', t => {
  const f = fixture(t);
  f.write(JSON.stringify({ version: 1, checks: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`case-${i}`, { command: [] }])) }));
  const result = inspectCheckReadiness(f);
  assert.equal(result.status, 'invalid');
  assert.ok(result.checks.length <= 20);
  assert.ok(result.invalid.length <= 8);
  assert.equal(result.omitted.checks, 1980);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 6000);
});

test('trust and readiness use the same explicitly selected home through the callable command surface', async t => {
  const f = fixture(t);
  f.write('version: 1\nchecks: {}\n');
  approveProject(f); // Simulated person approval in this disposable fixture only.
  const result = await trustResultOf(['status', '--workspace', f.workspace, '--ae-home', f.home, '--copilot-home', f.copilotHome]);
  assert.equal(result.trusted, true);
  assert.equal(result.store, path.join(f.home, 'trust.yaml'));
  assert.equal(result.checkReadiness.source, f.source);
});
