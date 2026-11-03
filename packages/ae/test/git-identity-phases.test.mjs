import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { gitExecutable } from '../corpus/hooks/lib/git-executable.mjs';
import { withGitIdentityCache } from '../lib/git-observation-cache.mjs';
import { workspaceStorageId, repoId } from '../lib/knowledge/store.mjs';
import { projectStoreDir } from '../lib/project-layout.mjs';
import { resolveProjectAuthority } from '../lib/project-authority.mjs';
import { loadNamedChecks } from '../lib/checks.mjs';
import { approveProject, policyDigest, trustStatus } from '../lib/trust.mjs';
import { runGate } from '../lib/gate.mjs';
import { collectOrientationFacts } from '../lib/orientation-facts.mjs';
import { statusDomainResult } from '../lib/commands.mjs';
import { writeVersionedPlan } from './helpers/cli-fixtures.mjs';
import { retentionDaysFor } from '../lib/retention-config.mjs';
import { DEFAULT_RETENTION_DAYS } from '../lib/retention.mjs';

const ORIGIN_A = 'https://example.invalid/team/identity-a.git';
const ORIGIN_B = 'https://example.invalid/team/identity-b.git';

function write(directory, name, bytes) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name), bytes);
}

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-identity-phases-')));
  const workspace = path.join(root, 'product'), home = path.join(root, 'state'), copilotHome = path.join(root, 'copilot');
  for (const directory of [workspace, home, copilotHome]) fs.mkdirSync(directory);
  const old = Object.fromEntries(['AE_HOME', 'HARNESS_HOME', 'LANG', 'GIT_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'].map(key => [key, process.env[key]]));
  process.env.AE_HOME = home; process.env.HARNESS_HOME = home;
  t.after(() => {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const git = args => {
    const result = childProcess.spawnSync(gitExecutable(), args, { cwd: workspace, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const plan = writeVersionedPlan(workspace);
  fs.rmSync(path.join(workspace, '.github'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src/example.js'), 'export const value = 1;\n');
  git(['init', '-q', '-b', 'feature/identity']);
  git(['config', 'user.name', 'Identity fixture']); git(['config', 'user.email', 'identity@example.test']);
  git(['config', 'core.autocrlf', 'false']); git(['add', '.']); git(['commit', '-qm', 'baseline']);
  git(['remote', 'add', 'origin', ORIGIN_A]);
  const authority = () => resolveProjectAuthority(workspace, { home });
  const checks = () => write(authority().directory, 'checks.yaml', `version: 1\nchecks:\n  unit-tests:\n    command: ${JSON.stringify([process.execPath, '-e', "require('node:assert/strict').match(require('node:fs').readFileSync('src/example.js','utf8'), /value = 1/)"])}\n`);
  return { root, workspace, home, copilotHome, plan, git, authority, checks };
}

function observeOrigins(t) {
  const original = childProcess.spawnSync, executable = gitExecutable();
  let calls = 0;
  t.mock.method(childProcess, 'spawnSync', function(command, args) {
    if (command === executable && args?.join('\0') === 'remote\0get-url\0origin') calls++;
    return original.apply(this, arguments);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => calls;
}

test('one synchronous identity phase observes origin once across storage and authority readers', t => {
  const f = fixture(t), calls = observeOrigins(t);
  const id = withGitIdentityCache(() => {
    const first = workspaceStorageId(f.workspace, { home: f.home });
    assert.equal(repoId(f.workspace), first);
    assert.equal(f.authority().directory, path.join(f.home, 'projects', first, 'authority'));
    assert.equal(projectStoreDir(f.workspace, { home: f.home }), path.join(f.home, 'projects', first));
    return first;
  });
  assert.equal(calls(), 1, 'repeated readers must share one sanitized origin observation');
  f.git(['remote', 'set-url', 'origin', ORIGIN_B]);
  const current = withGitIdentityCache(() => workspaceStorageId(f.workspace, { home: f.home }));
  assert.notEqual(current, id, 'the next phase must observe the changed repository identity');
  assert.equal(calls(), 2);
});

test('identity reuse leaves alias publication, selected homes and authority bytes live', t => {
  const f = fixture(t);
  withGitIdentityCache(() => {
    const id = repoId(f.workspace), initial = f.authority().directory;
    const storageId = 'local-123456789abc', selected = path.join(f.home, 'projects', storageId, 'authority');
    write(selected, 'checks.yaml', 'version: 1\nchecks: {}\n');
    write(path.join(f.home, 'storage-aliases'), `${id}.json`, JSON.stringify({ schema: 1, repoId: id, storageId }));
    assert.notEqual(selected, initial);
    assert.equal(f.authority().directory, selected, 'new alias selection must not be hidden by a cached derived store path');
    const before = policyDigest(f.workspace, undefined, { home: f.home });
    write(selected, 'checks.yaml', 'version: 1\nchecks:\n  behavior:\n    command: [node, assertion.mjs]\n');
    assert.notEqual(policyDigest(f.workspace, undefined, { home: f.home }), before);
    assert.deepEqual(loadNamedChecks(f.workspace, { home: f.home }).checks.behavior.command, ['node', 'assertion.mjs']);
    const otherHome = path.join(f.root, 'other-state');
    assert.notEqual(resolveProjectAuthority(f.workspace, { home: otherHome }).directory, selected);
    write(path.join(f.workspace, '.github/harness'), 'policy.yaml', 'version: 1\nenforcement: enforce\n');
    assert.throws(() => f.authority(), /both local and shared/i, 'competing authority must remain visible within the phase');
  });
});

test('identity keys ignore sanitized Git overrides but refresh when the actual child environment changes', t => {
  const f = fixture(t), calls = observeOrigins(t);
  withGitIdentityCache(() => {
    const first = repoId(f.workspace);
    process.env.GIT_DIR = path.join(f.root, 'foreign-git');
    process.env.GIT_CONFIG_COUNT = '1'; process.env.GIT_CONFIG_KEY_0 = 'remote.origin.url'; process.env.GIT_CONFIG_VALUE_0 = ORIGIN_B;
    assert.equal(repoId(f.workspace), first, 'ambient Git overrides must not change metadata authority');
    assert.equal(calls(), 1, 'stripped overrides are not a different metadata environment');
    process.env.LANG = process.env.LANG === 'C' ? 'C.UTF-8' : 'C';
    assert.equal(repoId(f.workspace), first);
    assert.equal(calls(), 2, 'a changed passed-through child environment requires a new observation');
  });
});

test('retention reads reuse only identity while policy changes still require a fresh approval', t => {
  const f = fixture(t), directory = f.authority().directory;
  write(directory, 'config.yaml', 'version: 1\nruns.retention_days: 7\n');
  // These approvals simulate a person only inside this disposable fixture.
  approveProject({ workspace: f.workspace, home: f.home, copilotHome: f.copilotHome });
  const calls = observeOrigins(t);
  const read = expected => {
    const before = calls();
    assert.equal(retentionDaysFor(f.workspace, { workspace: f.workspace, harnessHome: f.home, copilotHome: f.copilotHome }), expected);
    assert.equal(calls() - before, 1, 'one retention read must share its trust and configuration identity observation');
  };
  read(7);
  write(directory, 'config.yaml', 'version: 1\nruns.retention_days: 45\n');
  read(DEFAULT_RETENTION_DAYS);
  assert.equal(trustStatus({ workspace: f.workspace, home: f.home, copilotHome: f.copilotHome }).state, 'stale');
  approveProject({ workspace: f.workspace, home: f.home, copilotHome: f.copilotHome });
  read(45);
});

for (const reader of ['gate', 'orientation', 'contract']) test(`${reader} starts a fresh identity phase for each public call`, t => {
  const f = fixture(t);
  f.checks();
  const initialSource = f.authority().files['checks.yaml'];
  const flags = { plan: f.plan, workspace: f.workspace, harnessHome: f.home, copilotHome: f.copilotHome, allowInplace: true, phase: 'implement', contractDigest: true };
  let externalPlan;
  if (reader === 'contract') {
    externalPlan = path.join(projectStoreDir(f.workspace, { home: f.home }), 'plans', path.basename(f.plan));
    write(path.dirname(externalPlan), path.basename(externalPlan), fs.readFileSync(path.join(f.workspace, f.plan)));
    flags.plan = externalPlan;
  }
  const read = () => reader === 'gate' ? runGate({ workspace: f.workspace, flags })
    : reader === 'orientation' ? collectOrientationFacts({ workspace: f.workspace, copilotHome: f.copilotHome, flags, files: ['src/example.js'] })
      : statusDomainResult(flags, f.copilotHome);
  const first = read();
  if (reader === 'gate') assert.equal(first.checks.find(check => check.id === 'C-configured-checks').pass, true);
  else if (reader === 'orientation') { assert.equal(first.slice.checkReadiness.source, initialSource); assert.equal(first.slice.checkReadiness.status, 'ready'); }
  else assert.match(first.digest, /^[a-f0-9]{64}$/);
  f.git(['remote', 'set-url', 'origin', ORIGIN_B]);
  write(f.authority().directory, 'checks.yaml', 'version: 1\nchecks: {}\n');
  const second = read();
  if (reader === 'gate') assert.equal(second.checks.find(check => check.id === 'C-configured-checks').pass, false);
  else if (reader === 'orientation') { assert.notEqual(second.slice.checkReadiness.source, initialSource); assert.equal(second.slice.checkReadiness.status, 'empty'); }
  else { assert.equal(second.digest, null); assert.match(second.message, /outside|missing|authority/i); }
});
