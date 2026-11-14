import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { gitExecutable } from '../corpus/hooks/lib/git-executable.mjs';
import { scriptedFlowLedger } from './helpers/cli-fixtures.mjs';
import { projectStoreDir } from '../lib/project-layout.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/ae.mjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t, { shared = true, populated = false } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-delivery-recovery-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let workspace = path.join(root, 'product');
  const home = path.join(root, 'state'), copilotHome = path.join(root, 'copilot');
  fs.mkdirSync(workspace);
  const globalGitConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(globalGitConfig, '');
  const env = { ...process.env, AE_HOME: home, HARNESS_HOME: home, AE_BIN: bin, HARNESS_BIN: bin, COPILOT_HOME: copilotHome,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalGitConfig, HARNESS_NO_EVENTS: '1', HARNESS_ENFORCEMENT: 'enforce' };
  const git = args => {
    const result = spawnSync(gitExecutable(), args, { cwd: workspace, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git(['init', '-q', '-b', 'feature/recovery']);
  git(['config', 'user.name', 'Recovery fixture']);
  git(['config', 'user.email', 'recovery@example.test']);
  git(['config', 'core.autocrlf', 'false']);
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, '.gitignore'), '.harness/\n');
  fs.writeFileSync(path.join(workspace, 'src/value.mjs'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(workspace, 'test/value.test.mjs'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { value } from '../src/value.mjs';\ntest('accepted value is observable', () => assert.equal(value, 2));\n");
  const checks = { 'value-behavior': { command: [process.execPath, '--test', 'test/value.test.mjs'], proof: 'behavior', timeout_seconds: 60 } };
  const config = shared ? path.join(workspace, '.github/harness/checks.yaml') : path.join(projectStoreDir(workspace, { home }), 'authority/checks.yaml');
  if (shared) {
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, `${JSON.stringify({ version: 1, checks: populated ? checks : {} }, null, 2)}\n`);
    fs.writeFileSync(path.join(path.dirname(config), 'policy.yaml'), 'version: 1\nenforcement: enforce\n');
  }
  git(['add', '.']); git(['commit', '-qm', 'existing product and behavioral assertion']);
  const argvFor = args => [bin, ...args, '--workspace', workspace, '--copilot-home', copilotHome, '--ae-home', home, '--json', '--no-events'];
  const raw = (args, input) => spawnSync(process.execPath, argvFor(args),
    { cwd: workspace, env, input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 60_000 });
  const cli = (args, input) => {
    const result = raw(args, input);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout);
  };
  const toolHook = (name, payload) => {
    const result = spawnSync(process.execPath, [path.join(packageRoot, 'corpus/hooks', name)], {
      cwd: workspace, env, encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ workspace, session_id: 'upgrade-recovery-fixture', ...payload }),
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  };
  const hook = command => toolHook('require-plan-gate.mjs', { tool_name: 'run_in_terminal', tool_input: { command } });
  const control = (args, input) => {
    const admission = hook([process.execPath, ...argvFor(args)].map(quote).join(' '));
    assert.equal(admission.continue, true, JSON.stringify(admission));
    return cli(args, input);
  };
  let approvals = 0;
  const personApprovesFixturePolicy = () => {
    // This call simulates a person in a disposable fixture. No agent path approves trust.
    approvals++;
    assert.equal(cli(['trust', 'approve']).trusted, true);
  };
  const configure = () => {
    const argv = [process.execPath, bin, 'checks', 'configure', '--workspace', workspace, '--file', '-', '--json'];
    const admission = hook(argv.map(quote).join(' '));
    assert.equal(admission.continue, true, JSON.stringify(admission));
    const input = { schema: 1, expectedDigest: fs.existsSync(config) ? digest(fs.readFileSync(config)) : null, checks,
      rationale: 'Bind the existing value assertion to the requested observable value change.' };
    const result = spawnSync(argv[0], argv.slice(1), { cwd: workspace, env, encoding: 'utf8', timeout: 30_000, input: JSON.stringify(input) });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  return { root, get workspace() { return workspace; }, useWorkspace(value) { workspace = value; }, home, copilotHome, env, config, checks, git, raw, cli, hook, toolHook, control, configure, personApprovesFixturePolicy, approvals: () => approvals };
}

for (const shared of [true, false]) {
  test(`upgraded ${shared ? 'shared' : 'private'} authority completes worktree delivery without renewed approval`, { timeout: 180_000 }, t => {
    const f = fixture(t, { shared, populated: true });
    if (!shared) f.configure();
    f.personApprovesFixturePolicy();
    const primary = f.workspace;
    const approved = f.cli(['trust', 'status']);
    const policy = fs.readFileSync(f.config);
    const upgraded = f.cli(['upgrade', '--target', 'cli']);
    assert.equal(upgraded.workspace.status, 'prerequisites-ready');
    assert.equal(upgraded.workspace.trust.approvedDigest, approved.approvedDigest);
    const createdWorktree = f.cli(['worktree', '--slug', 'upgraded-delivery']);
    assert.equal(createdWorktree.workspace.trust.inherited, true);
    assert.equal(createdWorktree.workspace.status, 'prerequisites-ready');
    f.useWorkspace(createdWorktree.path);
    const reused = f.cli(['worktree', '--slug', 'upgraded-delivery']);
    assert.equal(reused.created, false);
    assert.equal(reused.workspace.trust.inherited, true);
    assert.equal(f.raw(['checks', 'run', 'value-behavior']).status, 1);
    const created = f.control(['plan-new', '--file', '-'], {
      version: 1, format: 'full', slug: 'upgraded-worktree', status: 'planned', goal: 'Make the observable value equal two.',
      acceptance: ['The value assertion passes in the worktree and the primary remains unchanged.'],
      constraints: ['Change only the exported value in the worktree.'], scope: ['src/value.mjs'], check: 'value-behavior', skillsUsed: ['engineer'],
    });
    f.cli(['orient', '--read', '--context-version', '2', '--plan', created.path, '--query', 'Make the observable value equal two.', '--file', 'src/value.mjs']);
    const decide = (id, action, extra = {}) => f.control(['plan-update', '--plan', created.path, '--file', '-'], {
      version: 1, id, action, expect: digest(fs.readFileSync(created.path)), ...extra,
    });
    assert.equal(decide('worktree-start', 'start').status, 'ok');
    const edit = { tool_name: 'replace_string_in_file', tool_input: { filePath: 'src/value.mjs', oldString: 'export const value = 1;', newString: 'export const value = 2;' } };
    for (const name of ['block-destructive-commands.mjs', 'guard-critical-files.mjs', 'require-plan-gate.mjs']) {
      assert.equal(f.toolHook(name, edit).continue, true, name);
    }
    fs.writeFileSync(path.join(f.workspace, 'src/value.mjs'), 'export const value = 2;\n');
    assert.equal(f.toolHook('record-successful-edit.mjs', { ...edit, hook_event_name: 'PostToolUse', success: true }).continue, true);
    decide('worktree-progress', 'progress', { progress: { criteria: ['AC1'], tasks: ['P1T1'] } });
    const packet = f.cli(['review', 'prepare', '--plan', created.path, '--base', 'HEAD']);
    assert.deepEqual(packet.scope.changedFiles, ['src/value.mjs']);
    f.cli(['review', 'assemble', '--plan', created.path, '--packet', packet.id, '--file', '-'], {
      packet: packet.id,
      results: packet.required.map(reviewer => ({ ...scriptedFlowLedger(packet, reviewer), reviewer, status: 'completed', findings: [],
        residual_risks: ['Synthetic review protocol fixture; no claim of native reviewer identity.'], testing_gaps: [] })),
    });
    const proof = f.cli(['verify', '--plan', created.path, '--base', 'HEAD']);
    assert.equal(proof.checks.find(check => check.id === 'value-behavior').status, 'passed');
    f.cli(['compound', '--plan', created.path, '--learning-decision', '-'], {
      operation: 'worktree-no-learning', decision: 'no-learning', rationale: 'Disposable protocol fixture has no durable product learning.',
    });
    assert.equal(decide('worktree-complete', 'complete').status, 'ok');
    assert.equal(f.approvals(), 1);
    assert.deepEqual(fs.readFileSync(f.config), policy);
    assert.equal(fs.readFileSync(path.join(primary, 'src/value.mjs'), 'utf8'), 'export const value = 1;\n');
    assert.equal(f.cli(['trust', 'status']).approvedDigest, approved.approvedDigest);
  });
}

test('trusted empty shared setup recovers through upgrade, hooks and the complete delivery lifecycle', { timeout: 180_000 }, t => {
  const f = fixture(t);
  f.personApprovesFixturePolicy();
  const original = fs.readFileSync(f.config), initialTrust = f.cli(['trust', 'status']);
  const upgraded = f.cli(['upgrade', '--target', 'cli']);
  assert.equal(upgraded.checkReadiness.status, 'empty');
  assert.equal(upgraded.checkReadiness.source, f.config);
  assert.equal(upgraded.checkReadiness.remediation.owner, 'engineer');
  assert.ok(upgraded.checkReadiness.remediation.command.includes('configure'));
  assert.deepEqual(fs.readFileSync(f.config), original, 'upgrade must preserve existing executable policy');
  assert.equal(f.cli(['trust', 'status']).approvedDigest, initialTrust.approvedDigest);
  const oriented = f.cli(['orient', '--read', '--query', 'Make the observable value equal two.', '--file', 'src/value.mjs']);
  assert.equal(oriented.trust.trusted, true);
  assert.equal(oriented.checkReadiness.status, 'empty');
  assert.equal(oriented.checkReadiness.source, f.config);
  const deniedEdit = f.hook("node -e 'require(\"fs\").writeFileSync(\"src/value.mjs\",\"unchecked\")'");
  assert.equal(deniedEdit.permissionDecision, 'deny', 'empty setup cannot grant arbitrary product mutation');
  assert.equal(f.configure().changed, true);
  assert.equal(f.cli(['trust', 'status']).state, 'stale', 'configuration must not approve its own commands');
  const agentApproval = f.hook([process.execPath, bin, 'trust', 'approve', '--workspace', f.workspace, '--json'].map(quote).join(' '));
  assert.equal(agentApproval.permissionDecision, 'deny', 'configuration recovery must not admit agent approval of executable policy');
  assert.notEqual(f.raw(['checks', 'run', 'value-behavior']).status, 0);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'src/value.mjs'), 'utf8'), 'export const value = 1;\n');
  assert.match(f.git(['status', '--porcelain']), /\.github\/harness\/checks\.yaml/, 'prepared shared checks stay dirty for the same delivery plan');
  f.personApprovesFixturePolicy();
  const beforeChange = f.raw(['checks', 'run', 'value-behavior']);
  assert.notEqual(beforeChange.status, 0, `the real check must reject the unchanged behavior: ${beforeChange.stdout}\n${beforeChange.stderr}`);
  const ready = f.cli(['orient', '--read', '--query', 'Make the observable value equal two.', '--file', 'src/value.mjs']);
  assert.equal(ready.checkReadiness.status, 'ready');
  assert.equal(ready.trust.trusted, true);
  const created = f.control(['plan-new', '--file', '-'], {
    version: 1, format: 'full', slug: 'upgrade-recovery', status: 'planned', goal: 'Make the observable value equal two.',
    acceptance: ['The exported value is two and the existing behavioral assertion passes.'],
    constraints: ['Change only the exported product value and its exact named-check declaration.'],
    scope: ['src/value.mjs', '.github/harness/checks.yaml'], check: 'value-behavior', skillsUsed: ['engineer'],
  });
  f.cli(['orient', '--read', '--context-version', '2', '--plan', created.path, '--query', 'Make the observable value equal two.',
    '--file', 'src/value.mjs', '--file', '.github/harness/checks.yaml']);
  const decide = (id, action, extra = {}) => {
    const revision = digest(fs.readFileSync(created.path));
    return f.control(['plan-update', '--plan', created.path, '--file', '-'], { version: 1, id, action, expect: revision, ...extra });
  };
  const started = decide('recovery-start', 'start');
  assert.equal(started.status, 'ok', JSON.stringify(started));
  const edit = { tool_name: 'replace_string_in_file', tool_input: { filePath: 'src/value.mjs', oldString: 'export const value = 1;', newString: 'export const value = 2;' } };
  for (const name of ['block-destructive-commands.mjs', 'guard-critical-files.mjs', 'require-plan-gate.mjs']) {
    const admission = f.toolHook(name, edit);
    assert.equal(admission.continue, true, `${name}: ${JSON.stringify(admission)}`);
  }
  fs.writeFileSync(path.join(f.workspace, 'src/value.mjs'), 'export const value = 2;\n');
  assert.equal(f.toolHook('record-successful-edit.mjs', { ...edit, hook_event_name: 'PostToolUse', success: true }).continue, true);
  const progress = decide('recovery-progress', 'progress', { progress: { criteria: ['AC1'], tasks: ['P1T1'] } });
  assert.equal(progress.status, 'ok');
  const packet = f.cli(['review', 'prepare', '--plan', created.path, '--base', 'HEAD']);
  assert.deepEqual(packet.scope.changedFiles, ['.github/harness/checks.yaml', 'src/value.mjs']);
  const review = f.cli(['review', 'assemble', '--plan', created.path, '--packet', packet.id, '--file', '-'], {
    packet: packet.id,
    results: packet.required.map(reviewer => ({ ...scriptedFlowLedger(packet, reviewer), reviewer, status: 'completed', findings: [],
      residual_risks: ['Synthetic protocol fixture only; this does not attest to host reviewer identity or model quality.'], testing_gaps: [] })),
  });
  assert.equal(review.coverage.complete, true);
  const verified = f.cli(['verify', '--plan', created.path, '--base', 'HEAD']);
  assert.ok(verified.checks.some(check => check.id === 'value-behavior' && check.status === 'passed' && check.proof === 'behavior'));
  assert.match(verified.checks.find(check => check.id === 'value-behavior').stdout, /accepted value is observable/);
  f.cli(['compound', '--plan', created.path, '--learning-decision', '-'], {
    operation: 'recovery-no-learning', decision: 'no-learning', rationale: 'Disposable protocol fixture has no durable product learning.',
  });
  const completed = decide('recovery-complete', 'complete');
  assert.equal(completed.status, 'ok', JSON.stringify(completed));
  assert.ok(completed.completion);
  assert.equal(f.cli(['trust', 'status']).state, 'trusted');
  assert.equal(f.approvals(), 2, 'only the initial fixture setup and changed executable policy require person approval');
});

test('upgrade preserves populated shared checks and approval without asking for setup again', { timeout: 120_000 }, t => {
  const f = fixture(t, { populated: true });
  f.personApprovesFixturePolicy();
  const original = fs.readFileSync(f.config), trust = f.cli(['trust', 'status']);
  const upgraded = f.cli(['upgrade', '--target', 'cli']);
  assert.equal(upgraded.checkReadiness.status, 'ready');
  assert.equal(upgraded.checkReadiness.source, f.config);
  assert.deepEqual(fs.readFileSync(f.config), original);
  const current = f.cli(['trust', 'status']);
  assert.equal(current.state, 'trusted');
  assert.equal(current.approvedDigest, trust.approvedDigest);
  assert.equal(f.approvals(), 1);
});

test('fresh private check recovery uses the selected external source and never creates a shared overlay', { timeout: 120_000 }, t => {
  const f = fixture(t, { shared: false });
  const oriented = f.cli(['orient', '--read', '--query', 'Make the observable value equal two.', '--file', 'src/value.mjs']);
  assert.equal(oriented.checkReadiness.status, 'missing');
  assert.equal(oriented.checkReadiness.source, f.config);
  assert.equal(f.configure().changed, true);
  assert.equal(f.cli(['trust', 'status']).trusted, false);
  assert.equal(fs.existsSync(path.join(f.workspace, '.github')), false);
  f.personApprovesFixturePolicy();
  assert.equal(f.cli(['trust', 'status']).trusted, true);
  assert.equal(f.approvals(), 1);
  assert.equal(f.cli(['checks', 'list']).checks[0].name, 'value-behavior');
});
