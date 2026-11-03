import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';
import { configureCheckConfiguration, inspectCheckConfiguration } from '../lib/check-configuration.mjs';
import { approveProject, trustStatus } from '../lib/trust.mjs';
import { projectStoreDir } from '../lib/project-layout.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const behavior = { command: [process.execPath, '--test', 'test/behavior.mjs'], proof: 'behavior' };
function fixture(t, bytes = 'version: 1\nchecks: {}\n') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-check-config-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'ae'), copilotHome = path.join(root, 'copilot');
  fs.mkdirSync(workspace); fs.mkdirSync(home); fs.mkdirSync(copilotHome);
  const source = path.join(workspace, '.github/harness/checks.yaml');
  if (bytes !== null) { fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, bytes); }
  const input = { schema: 1, expectedDigest: bytes === null ? null : digest(bytes), checks: { behavior }, rationale: 'Register the existing behavior assertions before delivery.' };
  return { root, workspace, home, copilotHome, source, input };
}

test('configuration prepares concrete checks, preserves unrelated YAML and invalidates prior trust without execution', t => {
  const bytes = '# team checks\nversion: 1\nowner: app-team\nchecks:\n  # keep the existing assertion\n  existing:\n    command: [node, existing.mjs]\n    timeout_seconds: 45\n';
  const f = fixture(t, bytes), marker = path.join(f.workspace, 'executed');
  approveProject(f);
  assert.equal(trustStatus(f).trusted, true);
  f.input.checks.behavior = { command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`] };
  const result = configureCheckConfiguration({ ...f, input: f.input });
  const written = fs.readFileSync(f.source, 'utf8'), parsed = YAML.parse(written);
  assert.equal(result.changed, true);
  assert.equal(result.previousDigest, f.input.expectedDigest);
  assert.equal(result.sourceDigest, digest(written));
  assert.equal(result.config, f.source);
  assert.equal(result.approvalRequired, true);
  assert.equal(result.trust.state, 'stale');
  assert.deepEqual(result.changes, [{ name: 'behavior', previous: null, current: f.input.checks.behavior }]);
  assert.equal(parsed.owner, 'app-team');
  assert.deepEqual(parsed.checks.existing, { command: ['node', 'existing.mjs'], timeout_seconds: 45 });
  assert.match(written, /# team checks/); assert.match(written, /# keep the existing assertion/);
  assert.equal(fs.existsSync(marker), false);
});

test('missing configuration selects private authority and never creates product configuration', t => {
  const f = fixture(t, null), before = inspectCheckConfiguration(f);
  assert.equal(before.sourceDigest, null);
  assert.equal(before.sourceMode, 'local');
  assert.deepEqual(before.checks, {});
  const result = configureCheckConfiguration({ ...f, input: f.input });
  assert.equal(result.sourceMode, 'local');
  assert.ok(result.config.startsWith(path.join(f.home, 'projects') + path.sep));
  assert.deepEqual(YAML.parse(fs.readFileSync(result.config, 'utf8')).checks, { behavior });
  assert.equal(fs.existsSync(path.join(f.workspace, '.github')), false);
  assert.equal(trustStatus(f).state, 'untrusted');
});

test('semantic no-op preserves exact bytes, comments and current approval', t => {
  const bytes = '# preserved formatting\nversion: 1\nchecks:\n  behavior: { command: [node, test.mjs], timeout_seconds: 30 }\n';
  const f = fixture(t, bytes); approveProject(f);
  f.input.checks.behavior = { timeout_seconds: 30, command: ['node', 'test.mjs'] };
  const before = fs.statSync(f.source), result = configureCheckConfiguration({ ...f, input: f.input });
  assert.equal(result.changed, false); assert.deepEqual(result.changes, []);
  assert.equal(result.approvalRequired, false); assert.equal(result.trust.trusted, true);
  assert.equal(fs.readFileSync(f.source, 'utf8'), bytes); assert.equal(fs.statSync(f.source).ino, before.ino);
});

test('dry run returns concrete proposed changes without file or trust changes', t => {
  const f = fixture(t); approveProject(f);
  const bytes = fs.readFileSync(f.source), result = configureCheckConfiguration({ ...f, input: f.input, dryRun: true });
  assert.equal(result.changed, true); assert.equal(result.dryRun, true);
  assert.equal(result.approvalRequired, true);
  assert.deepEqual(fs.readFileSync(f.source), bytes); assert.equal(trustStatus(f).trusted, true);
});

test('stale digest and malformed decisions preserve configuration', t => {
  const f = fixture(t), bytes = fs.readFileSync(f.source);
  const cases = [
    { ...f.input, expectedDigest: null }, { ...f.input, expectedDigest: 'sha256-' + digest(bytes) },
    { ...f.input, approved: true }, { ...f.input, schema: 2 }, { ...f.input, rationale: '' },
    { ...f.input, checks: {} }, { ...f.input, checks: { '../escape': behavior } },
    { ...f.input, checks: { behavior: { command: [] } } },
    { ...f.input, checks: { behavior: { ...behavior, shell: true } } },
    { ...f.input, checks: { behavior: { ...behavior, timeout_seconds: -1 } } },
  ];
  for (const input of cases) {
    assert.throws(() => configureCheckConfiguration({ ...f, input }));
    assert.deepEqual(fs.readFileSync(f.source), bytes);
  }
});

test('malformed, duplicate-key and redirected selected sources are refused', t => {
  for (const bytes of ['version: 2\nchecks: {}\n', 'version: 1\nchecks: []\n', 'version: 1\nchecks: {}\nchecks: {}\n']) {
    const f = fixture(t, bytes);
    assert.throws(() => configureCheckConfiguration({ ...f, input: f.input }));
    assert.equal(fs.readFileSync(f.source, 'utf8'), bytes);
  }
  const f = fixture(t), outside = path.join(f.root, 'outside.yaml'), original = fs.readFileSync(f.source);
  fs.writeFileSync(outside, original); fs.unlinkSync(f.source); fs.symlinkSync(outside, f.source);
  assert.throws(() => configureCheckConfiguration({ ...f, input: f.input }));
  assert.deepEqual(fs.readFileSync(outside), original);
});

test('concurrent edits while acquiring the selected-source lock are preserved', t => {
  const f = fixture(t), original = fs.mkdirSync, external = '# user edit\nversion: 1\nchecks: {}\n'; let changed = false;
  fs.mkdirSync = function (full, ...args) {
    if (!changed && String(full).endsWith('checks.yaml.lock')) { changed = true; fs.writeFileSync(f.source, external); }
    return original.call(this, full, ...args);
  };
  try { assert.throws(() => configureCheckConfiguration({ ...f, input: f.input }), /changed|stale/i); }
  finally { fs.mkdirSync = original; }
  assert.equal(changed, true); assert.equal(fs.readFileSync(f.source, 'utf8'), external);
});

test('a successor published during replacement is never overwritten or deleted', t => {
  const f = fixture(t), original = fs.renameSync, external = '# successor\nversion: 1\nchecks: {}\n'; let changed = false;
  fs.renameSync = function (from, to, ...args) {
    const value = original.call(this, from, to, ...args);
    if (!changed && String(from) === f.source) { changed = true; fs.writeFileSync(f.source, external); }
    return value;
  };
  try { assert.throws(() => configureCheckConfiguration({ ...f, input: f.input }), /changed|publication|conflict/i); }
  finally { fs.renameSync = original; }
  assert.equal(changed, true); assert.equal(fs.readFileSync(f.source, 'utf8'), external);
});

test('a competing authority appearing under the lock is refused without modifying either source', t => {
  const f = fixture(t), original = fs.mkdirSync, local = path.join(projectStoreDir(f.workspace, { home: f.home }), 'authority/checks.yaml');
  const bytes = fs.readFileSync(f.source), localBytes = '# newly authored private policy\nversion: 1\nchecks: {}\n'; let changed = false;
  fs.mkdirSync = function (full, ...args) {
    if (!changed && String(full).endsWith('checks.yaml.lock')) {
      changed = true; original.call(this, path.dirname(local), { recursive: true }); fs.writeFileSync(local, localBytes);
    }
    return original.call(this, full, ...args);
  };
  try { assert.throws(() => configureCheckConfiguration({ ...f, input: f.input }), /Both local and shared/); }
  finally { fs.mkdirSync = original; }
  assert.equal(changed, true); assert.deepEqual(fs.readFileSync(f.source), bytes); assert.equal(fs.readFileSync(local, 'utf8'), localBytes);
});

test('CLI stdin preparation returns the exact changed commands and never executes or approves them', t => {
  const f = fixture(t), marker = path.join(f.workspace, 'must-not-run');
  f.input.checks.behavior = { command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`] };
  const bin = fileURLToPath(new URL('../bin/ae.mjs', import.meta.url));
  const args = [bin, 'checks', 'configure', '--file', '-', '--json', '--workspace', f.workspace, '--ae-home', f.home, '--copilot-home', f.copilotHome];
  const result = spawnSync(process.execPath, args, { input: JSON.stringify(f.input), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.changed, true); assert.equal(output.approvalRequired, true); assert.equal(output.trust.trusted, false);
  assert.deepEqual(output.changes[0].current.command, f.input.checks.behavior.command);
  assert.equal(fs.existsSync(marker), false); assert.equal(fs.existsSync(path.join(f.home, 'trust.yaml')), false);
  const listed = spawnSync(process.execPath, [bin, 'checks', 'list', '--json', '--workspace', f.workspace, '--ae-home', f.home], { encoding: 'utf8', timeout: 15000 });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).sourceDigest, output.sourceDigest);
});
