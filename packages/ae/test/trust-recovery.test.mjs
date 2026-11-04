import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';
import { approveProject, revokeProject, trustStatus, trustStorePath, formatTrustRecovery } from '../lib/trust.mjs';
import { addIsolatedWorktree } from '../lib/worktree.mjs';
import { projectStoreDir } from '../lib/project-layout.mjs';
import { configureCheckConfiguration } from '../lib/check-configuration.mjs';
import { harnessGlobalHome } from '../lib/paths.mjs';

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/ae.mjs');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-trust-recovery-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product space'), home = path.join(root, 'authority home'), copilotHome = path.join(root, 'copilot home');
  for (const dir of [workspace, home, copilotHome]) fs.mkdirSync(dir);
  return { root, workspace, home, copilotHome };
}
function write(workspace, name, text) {
  const full = path.join(workspace, '.github/harness', name);
  fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text);
}
function git(workspace, args) {
  const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
function linkedFixture(t) {
  const s = fixture(t);
  write(s.workspace, 'policy.yaml', 'enforcement: enforce\n');
  git(s.workspace, ['init', '-q']); git(s.workspace, ['add', '.']);
  git(s.workspace, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'baseline']);
  approveProject(s);
  const linked = addIsolatedWorktree({ workspace: s.workspace, slug: 'recovery', from: 'HEAD' });
  t.after(() => fs.rmSync(linked.path, { recursive: true, force: true }));
  return { s, child: { ...s, workspace: linked.path } };
}
function run(args, s, cwd = s.root, env = process.env) {
  return spawnSync(process.execPath, [bin, ...args, '--workspace', s.workspace, '--harness-home', s.home, '--copilot-home', s.copilotHome, '--no-events'], { cwd, env, encoding: 'utf8' });
}

test('a stale child approval can inherit an exactly matching current primary approval', t => {
  const { s, child } = linkedFixture(t);
  approveProject(child);
  for (const target of [s, child]) write(target.workspace, 'policy.yaml', 'enforcement: observe\n');
  approveProject(s);
  const before = fs.readFileSync(trustStorePath(s));
  const result = trustStatus(child);
  assert.equal(result.trusted, true);
  assert.equal(result.inherited, true);
  assert.equal(result.cause, 'inherited');
  assert.equal(result.primary.state, 'trusted');
  assert.deepEqual(result.primary.differs, []);
  assert.equal(result.recovery, null);
  assert.deepEqual(fs.readFileSync(trustStorePath(s)), before, 'reading inherited trust never replaces the stale direct decision');
});

test('primary mismatch reports current files and requires engineer alignment', t => {
  const { s, child } = linkedFixture(t);
  approveProject(child);
  write(s.workspace, 'policy.yaml', 'enforcement: observe\n'); approveProject(s);
  write(child.workspace, 'policy.yaml', 'enforcement: warn\n');
  const result = trustStatus(child);
  assert.equal(result.trusted, false);
  assert.equal(result.cause, 'policy-mismatch');
  assert.equal(result.primary.state, 'trusted');
  assert.deepEqual(result.primary.differs, ['policy.yaml']);
  assert.equal(result.recovery.owner, 'engineer');
  assert.equal(result.recovery.kind, 'align-policy');
  assert.equal(result.recovery.command, null);
});

test('a stale primary cannot authorize a child that still matches its old approval', t => {
  const { s, child } = linkedFixture(t);
  write(s.workspace, 'policy.yaml', 'enforcement: observe\n');
  const result = trustStatus(child);
  assert.equal(result.trusted, false);
  assert.equal(result.cause, 'primary-not-current');
  assert.equal(result.primary.state, 'stale');
  assert.equal(result.recovery.owner, 'engineer');
  assert.equal(result.recovery.command, null);
});

test('direct revocation and conflicting decisions still block primary fallback', async t => {
  for (const conflict of [false, true]) await t.test(conflict ? 'conflict' : 'revocation', sub => {
    const { s, child } = linkedFixture(sub);
    revokeProject(child);
    if (conflict) {
      const file = trustStorePath(s), store = YAML.parse(fs.readFileSync(file, 'utf8'));
      store.projects[`${child.workspace}/.`] = { status: 'trusted', digest: trustStatus(s).digest };
      fs.writeFileSync(file, YAML.stringify(store));
    }
    const result = trustStatus(child);
    assert.equal(result.trusted, false); assert.equal(result.inherited, false);
    assert.equal(result.cause, conflict ? 'own-conflict' : 'own-revoked');
  });
});

test('a current independent child approval survives primary revocation', t => {
  const { s, child } = linkedFixture(t);
  approveProject(child); revokeProject(s);
  const result = trustStatus(child);
  assert.equal(result.trusted, true); assert.equal(result.inherited, false);
  assert.equal(result.cause, 'approved'); assert.equal(result.recovery, null);
});

test('unreadable stores and competing authority require inspection without an approval command', async t => {
  for (const kind of ['store', 'authority']) await t.test(kind, sub => {
    const s = fixture(sub);
    write(s.workspace, 'policy.yaml', 'enforcement: enforce\n'); approveProject(s);
    if (kind === 'store') fs.writeFileSync(trustStorePath(s), 'projects: [broken');
    else {
      const local = path.join(projectStoreDir(s.workspace, { home: s.home }), 'authority');
      fs.mkdirSync(local, { recursive: true }); fs.writeFileSync(path.join(local, 'config.yaml'), 'version: 1\n');
    }
    const result = trustStatus(s);
    assert.equal(result.trusted, false);
    assert.equal(result.cause, kind === 'store' ? 'store-unreadable' : 'authority-unavailable');
    assert.equal(result.recovery.owner, 'engineer'); assert.equal(result.recovery.command, null);
    if (kind === 'authority') assert.match(result.authority.error, /Both local and shared/);
    const human = run(['trust', 'status'], s);
    assert.equal(human.status, 0, human.stderr);
    assert.doesNotMatch(human.stdout, /ae trust approve/);
    assert.match(human.stdout, kind === 'store' ? /store.*read|inspect/i : /Both local and shared/);
  });
});

test('bound recovery approves the selected workspace and homes from another cwd', t => {
  const s = fixture(t), other = path.join(s.root, 'other'); fs.mkdirSync(other);
  const result = trustStatus(s);
  assert.deepEqual(result.binding, { workspace: s.workspace, home: s.home, copilotHome: s.copilotHome, store: path.join(s.home, 'trust.yaml') });
  assert.equal(result.recovery.owner, 'person');
  const command = result.recovery.command;
  assert.deepEqual(command, [fs.realpathSync(process.execPath), bin, 'trust', 'approve', '--workspace', s.workspace, '--ae-home', s.home, '--copilot-home', s.copilotHome, '--json']);
  const approved = spawnSync(command[0], [...command.slice(1), '--no-events'], { cwd: other, encoding: 'utf8' });
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(trustStatus(s).trusted, true);
  assert.equal(trustStatus({ ...s, workspace: other }).trusted, false);
});

test('a legacy split store and authority binding requires reconciliation', t => {
  const s = fixture(t), env = { ...process.env }; delete env.AE_HOME; delete env.HARNESS_HOME;
  const result = spawnSync(process.execPath, [bin, 'trust', 'status', '--json', '--workspace', s.workspace, '--copilot-home', s.copilotHome, '--no-events'], { cwd: s.root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  const before = { AE_HOME: process.env.AE_HOME, HARNESS_HOME: process.env.HARNESS_HOME };
  delete process.env.AE_HOME; delete process.env.HARNESS_HOME;
  let selectedHome;
  try { selectedHome = harnessGlobalHome(); } finally { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  assert.equal(status.binding.home, selectedHome);
  assert.equal(status.binding.store, path.join(s.copilotHome, 'trust.yaml'));
  assert.equal(status.recovery.owner, 'engineer');
  assert.equal(status.recovery.kind, 'select-binding'); assert.equal(status.recovery.command, null);
});

test('named check denial retains the bound recovery and never executes the check', t => {
  const s = fixture(t), marker = path.join(s.root, 'executed');
  write(s.workspace, 'checks.yaml', YAML.stringify({ version: 1, checks: { test: { command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] } } }));
  const result = run(['checks', 'run', 'test'], s);
  assert.equal(result.status, 4, result.stderr);
  assert.equal(fs.existsSync(marker), false);
  assert.ok(result.stderr.includes(s.workspace), result.stderr);
  assert.ok(result.stderr.includes(s.home), result.stderr);
  assert.ok(result.stderr.includes(s.copilotHome), result.stderr);
});

test('invalid trust-store versions and project records require inspection', async t => {
  for (const invalid of [{ version: 2, record: { status: 'revoked' } }, { version: 1, record: null }, { version: 1, record: { status: 'trusted', digest: 42 } }]) {
    await t.test(JSON.stringify(invalid), sub => {
      const s = fixture(sub);
      fs.writeFileSync(trustStorePath(s), YAML.stringify({ version: invalid.version, projects: { [s.workspace]: invalid.record } }));
      const result = trustStatus(s);
      assert.equal(result.trusted, false);
      assert.equal(result.cause, 'store-unreadable');
      assert.equal(result.recovery.owner, 'engineer'); assert.equal(result.recovery.command, null);
      assert.throws(() => approveProject(s), /unreadable trust store/);
    });
  }
});

test('uncommitted primary policy missing from a child requires engineer alignment', t => {
  const s = fixture(t);
  git(s.workspace, ['init', '-q']);
  git(s.workspace, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'baseline']);
  write(s.workspace, 'policy.yaml', 'enforcement: enforce\n'); approveProject(s);
  const linked = addIsolatedWorktree({ workspace: s.workspace, slug: 'missing-policy', from: 'HEAD' });
  t.after(() => fs.rmSync(linked.path, { recursive: true, force: true }));
  const result = trustStatus({ ...s, workspace: linked.path });
  assert.equal(result.trusted, false); assert.equal(result.cause, 'policy-mismatch');
  assert.equal(result.authority.mode, 'local'); assert.equal(result.primary.authority.mode, 'shared');
  assert.equal(result.recovery.afterInspection, undefined);
  assert.doesNotMatch(formatTrustRecovery(result.recovery), /trust.*approve/);
  assert.deepEqual(result.primary.differs, ['policy.yaml']);
  assert.equal(result.recovery.owner, 'engineer'); assert.equal(result.recovery.command, null);
});

test('read-only diagnosis reads legacy approvals without migrating the store', t => {
  const s = fixture(t);
  approveProject(s);
  const file = trustStorePath(s), legacy = path.join(s.copilotHome, 'harness', 'trust.yaml');
  fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.renameSync(file, legacy);
  const before = fs.readFileSync(legacy);
  assert.equal(trustStatus({ ...s, readOnly: true }).trusted, true);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readFileSync(legacy), before);
});

test('local worktree authority and approvals stay bound to the selected home', t => {
  const s = fixture(t);
  git(s.workspace, ['init', '-q']);
  git(s.workspace, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'baseline']);
  const local = path.join(projectStoreDir(s.workspace, { home: s.home }), 'authority');
  fs.mkdirSync(local, { recursive: true }); fs.writeFileSync(path.join(local, 'policy.yaml'), 'enforcement: enforce\n');
  approveProject(s);
  const linked = addIsolatedWorktree({ workspace: s.workspace, slug: 'local-authority', from: 'HEAD' });
  t.after(() => fs.rmSync(linked.path, { recursive: true, force: true }));
  const child = { ...s, workspace: linked.path };
  assert.equal(trustStatus(child).inherited, true);
  const other = path.join(s.root, 'other home'); fs.mkdirSync(other);
  const result = trustStatus({ ...child, home: other });
  assert.equal(result.trusted, false); assert.equal(result.cause, 'primary-not-current');
  assert.equal(result.binding.home, other); assert.equal(result.store, path.join(other, 'trust.yaml'));
  assert.equal(result.recovery.command, null);
});

test('named checks with competing authority return engineer inspection before loading commands', t => {
  const s = fixture(t);
  write(s.workspace, 'checks.yaml', 'version: 1\nchecks:\n  test:\n    command: [node, -e, "0"]\n');
  const local = path.join(projectStoreDir(s.workspace, { home: s.home }), 'authority');
  fs.mkdirSync(local, { recursive: true }); fs.writeFileSync(path.join(local, 'config.yaml'), 'version: 1\n');
  const result = run(['checks', 'run', 'test'], s);
  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stderr, /Inspect the selected project authority/);
  assert.match(result.stderr, /Both local and shared/);
  assert.doesNotMatch(result.stderr, /trust approve/);
});


test('intentional child check preparation offers one conditional person approval and then runs', t => {
  const { s, child } = linkedFixture(t), marker = path.join(s.root, 'child-check-ran');
  const result = configureCheckConfiguration({ ...child, input: {
    schema: 1, expectedDigest: null, rationale: 'Verify this worktree behavior',
    checks: { behavior: { command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`] } },
  } });
  assert.equal(result.trust.cause, 'policy-mismatch');
  assert.equal(result.trust.recovery.owner, 'engineer');
  assert.equal(result.trust.recovery.command, null);
  const handoff = result.trust.recovery.afterInspection;
  assert.equal(handoff.owner, 'person');
  assert.match(handoff.message, /intentional/);
  assert.equal(fs.existsSync(marker), false);
  const denied = run(['checks', 'run', 'behavior'], child);
  assert.equal(denied.status, 4, denied.stderr);
  const approved = spawnSync(handoff.command[0], [...handoff.command.slice(1), '--no-events'], { cwd: s.root, encoding: 'utf8' });
  assert.equal(approved.status, 0, approved.stderr);
  const executed = run(['checks', 'run', 'behavior'], child);
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ok');
  assert.equal(trustStatus(child).inherited, false);
});

test('unapproved matching primary exposes its own bound person handoff', t => {
  const { s, child } = linkedFixture(t);
  fs.rmSync(trustStorePath(s));
  const result = trustStatus(child);
  assert.equal(result.trusted, false);
  assert.equal(result.primary.recovery.owner, 'person');
  assert.ok(result.primary.recovery.command.includes(s.workspace));
  assert.deepEqual(result.recovery.afterInspection, result.primary.recovery);
});

test('recovery formatting renders Windows PowerShell invocation and escapes apostrophes', () => {
  const recovery = { message: 'Review.', command: [String.raw`C:\Program Files\node.exe`, String.raw`D:\Chai's tools\ae.mjs`, 'trust', 'approve'] };
  assert.equal(formatTrustRecovery(recovery, { platform: 'win32' }), String.raw`Review. & 'C:\Program Files\node.exe' 'D:\Chai''s tools\ae.mjs' 'trust' 'approve'`);
  assert.equal(formatTrustRecovery({ message: 'Review.', command: ['ae', "Chai's workspace $HOME"] }, { platform: 'linux' }), String.raw`Review. ae 'Chai'\''s workspace $HOME'`);
});

test('an explicit skills home is retained in the bound person approval command', t => {
  const s = fixture(t), skillsHome = path.join(s.root, 'native skills');
  const result = trustStatus({ ...s, skillsHome });
  assert.deepEqual(result.recovery.command.slice(-3), ['--skills-home', skillsHome, '--json']);
});
