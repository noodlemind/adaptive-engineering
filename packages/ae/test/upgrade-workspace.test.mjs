import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installHarnessBin } from '../lib/install-harness-bin.mjs';
import { approveProject, policyDigest, trustStorePath } from '../lib/trust.mjs';
import { hostResultOf } from '../lib/hosts/command.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-upgrade-workspace-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'state');
  const configHome = path.join(root, 'native config'), skillsHome = path.join(root, 'native skills');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'example.txt'), 'original\n');
  const env = { ...process.env, AE_HOME: home, HARNESS_HOME: home, AE_INTELLIJ_HOME: path.join(root, 'intellij'), COPILOT_HOME: configHome, AE_SKILLS_HOME: skillsHome,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'Upgrade fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Upgrade fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  delete env.AE_BIN; delete env.HARNESS_BIN;
  const git = args => {
    const result = spawnSync('git', args, { cwd: workspace, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q']);
  const cli = (runtime, args) => {
    const result = spawnSync(process.execPath, [path.join(runtime, 'bin/ae.mjs'), ...args, '--workspace', workspace, '--ae-home', home, '--json', '--no-events'], { cwd: workspace, env, encoding: 'utf8', timeout: 30000 });
    if (process.env.HARNESS_PROOF_LOG) fs.appendFileSync(process.env.HARNESS_PROOF_LOG, JSON.stringify({ args, runtime, status: result.status, stdout: result.stdout, stderr: result.stderr }) + '\n');
    return result;
  };
  const nativeArgs = host => ['--host', host, '--config-home', configHome, '--skills-home', skillsHome];
  const ok = (runtime, args) => {
    const result = cli(runtime, args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  return { root, workspace, home, configHome, skillsHome, env, git, cli, ok, nativeArgs };
}

function files(root) {
  if (!fs.existsSync(root)) return {};
  const result = {};
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else result[path.relative(root, full)] = fs.readFileSync(full).toString('base64');
    }
  };
  walk(root);
  return result;
}

test('native upgrade replaces installed A bindings with B and preserves selected roots after A is removed', t => {
  const f = fixture(t), oldHome = path.join(f.root, 'installation A'), newHome = path.join(f.root, 'installation B');
  installHarnessBin(packageRoot, oldHome, {}, () => {});
  installHarnessBin(packageRoot, newHome, {}, () => {});
  const oldRuntime = path.join(oldHome, '.ae-bin'), newRuntime = path.join(newHome, '.ae-bin');
  f.ok(oldRuntime, ['host', 'setup', ...f.nativeArgs('codex')]);
  const hookFile = path.join(f.configHome, 'hooks.json');
  const command = () => JSON.parse(fs.readFileSync(hookFile)).hooks.PreToolUse[0].hooks[0].command;
  const invoke = () => spawnSync(command(), { shell: true, cwd: f.configHome, env: f.env, encoding: 'utf8', timeout: 15000,
    input: JSON.stringify({ cwd: f.workspace, tool_name: 'Read', tool_input: { file_path: path.join(f.workspace, 'example.txt') } }) });
  assert.equal(invoke().status, 0);
  fs.renameSync(oldRuntime, `${oldRuntime}.removed`);
  const broken = invoke();
  assert.notEqual(broken.status, 0, 'control must fail when the package supplying the old native hook is removed');
  if (process.env.HARNESS_PROOF_LOG) fs.appendFileSync(process.env.HARNESS_PROOF_LOG, JSON.stringify({ control: 'A removed', status: broken.status, stderr: broken.stderr }) + '\n');
  fs.renameSync(`${oldRuntime}.removed`, oldRuntime);
  const upgraded = f.ok(newRuntime, ['upgrade', ...f.nativeArgs('codex')]);
  fs.rmSync(oldRuntime, { recursive: true, force: true });
  const recovered = invoke();
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.stdout.trim(), '{}');
  const manifest = JSON.parse(fs.readFileSync(path.join(f.configHome, '.ae-host.json')));
  assert.equal(manifest.packageRoot, newRuntime);
  assert.equal(manifest.configHome, f.configHome);
  assert.equal(manifest.skillsHome, f.skillsHome);
  assert.equal(manifest.home, f.home);
  const instructions = fs.readFileSync(path.join(f.skillsHome, 'engineer/references/ae-instructions.md'), 'utf8');
  const fallback = JSON.parse(instructions.match(/invoke the installed package directly with literal argv: `([^`]+)`/)[1]);
  const binding = JSON.parse(instructions.match(/append these literal argv elements before any `--` argument boundary: `([^`]+)`/)[1]);
  assert.equal(fallback[1], path.join(newRuntime, 'bin/ae.mjs'));
  assert.deepEqual(binding, ['--copilot-home', f.configHome, '--skills-home', f.skillsHome, '--ae-home', f.home]);
  const fallbackResult = spawnSync(fallback[0], [...fallback.slice(1), 'orient', '--read', ...binding, '--workspace', f.workspace, '--json', '--no-events'], { cwd: f.configHome, env: f.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(fallbackResult.status, 0, fallbackResult.stderr);
  assert.equal(JSON.parse(fallbackResult.stdout).checkReadiness.remediation.command[1], path.join(newRuntime, 'bin/ae.mjs'));
  assert.equal(upgraded.integration.assetState, 'current');
  assert.equal(upgraded.integration.nativeQualification, 'unverified');
  assert.equal(upgraded.workspace.path, f.workspace);
  assert.equal(upgraded.workspace.checkReadiness.status, 'missing');
  assert.equal(upgraded.workspace.status, 'blocked');
  assert.equal(upgraded.workspace.nextActions[0].owner, 'engineer');
  assert.deepEqual(upgraded.workspace.nextActions[0].command.slice(0, 2), [fs.realpathSync(process.execPath), path.join(newRuntime, 'bin/ae.mjs')]);
  assert.equal(fs.existsSync(path.join(f.workspace, '.github/harness')), false);
});

for (const host of ['codex', 'claude-code', 'cursor', 'terminal']) test(`${host} upgrade is bounded, repeatable, and preserves trusted policy`, t => {
  const f = fixture(t);
  f.ok(packageRoot, ['host', 'setup', ...f.nativeArgs(host)]);
  const authority = path.join(f.workspace, '.github/harness');
  fs.mkdirSync(authority, { recursive: true });
  fs.writeFileSync(path.join(authority, 'checks.yaml'), 'version: 1\nchecks:\n  behavior:\n    command: [node, "--test"]\n    proof: behavior\n');
  const trusted = approveProject({ workspace: f.workspace, home: f.home, copilotHome: f.configHome });
  const digest = policyDigest(f.workspace, undefined, { home: f.home });
  const trustFile = trustStorePath({ home: f.home, copilotHome: f.configHome }), approved = fs.readFileSync(trustFile);
  const policy = files(authority), config = files(f.configHome), skills = files(f.skillsHome);
  for (let i = 0; i < 2; i++) {
    const result = f.ok(packageRoot, ['upgrade', ...f.nativeArgs(host)]);
    assert.deepEqual(result.integration.actions, []);
    assert.equal(result.workspace.trust.state, 'trusted');
    assert.equal(result.workspace.trust.approvedAt, trusted.approvedAt);
    assert.equal(result.workspace.trust.digest, digest);
    assert.equal(result.workspace.status, 'prerequisites-ready');
    assert.equal(result.workspace.readyToDeliver, undefined);
  }
  assert.deepEqual(files(authority), policy);
  assert.deepEqual(files(f.configHome), config);
  assert.deepEqual(files(f.skillsHome), skills);
  assert.deepEqual(fs.readFileSync(trustFile), approved);
});

test('native upgrade requires existing matching ownership and rejects legacy configuration ambiguity', t => {
  const f = fixture(t);
  for (const extra of [[], ['--target', 'cli'], ['--configure-path'], ['--configure-vscode'], ['--autonomy', 'full'], ['--force-profile'], ['--config-home', f.configHome]]) {
    const result = f.cli(packageRoot, ['upgrade', ...f.nativeArgs('codex'), ...extra]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(f.configHome), false);
    assert.equal(fs.existsSync(f.skillsHome), false);
  }
  const ambiguous = f.cli(packageRoot, ['upgrade', '--config-home', f.configHome]);
  assert.notEqual(ambiguous.status, 0);
  assert.equal(fs.existsSync(f.configHome), false);
  f.ok(packageRoot, ['host', 'setup', ...f.nativeArgs('codex')]);
  const configured = files(f.root);
  for (const extra of [['--target', 'cli'], ['--configure-path'], ['--configure-vscode'], ['--autonomy', 'full'], ['--force-profile'], ['--config-home', f.configHome]]) {
    assert.notEqual(f.cli(packageRoot, ['upgrade', ...f.nativeArgs('codex'), ...extra]).status, 0);
    assert.deepEqual(files(f.root), configured);
  }
  fs.rmSync(path.join(f.skillsHome, '.ae-host-skills.json'));
  const before = files(f.root);
  assert.notEqual(f.cli(packageRoot, ['upgrade', ...f.nativeArgs('codex')]).status, 0);
  assert.deepEqual(files(f.root), before);
});

test('native upgrade preserves modified assets and the ownership manifest with a nonzero conflict result', t => {
  const f = fixture(t);
  f.ok(packageRoot, ['host', 'setup', ...f.nativeArgs('codex')]);
  const modified = path.join(f.skillsHome, 'engineer/SKILL.md');
  fs.appendFileSync(modified, '\nPersonal edit.\n');
  const config = files(f.configHome), skills = files(f.skillsHome);
  const result = f.cli(packageRoot, ['upgrade', ...f.nativeArgs('codex')]);
  assert.notEqual(result.status, 0);
  const data = JSON.parse(result.stdout);
  assert.equal(data.integration.status, 'conflict');
  assert.ok(data.integration.conflicts.includes(modified));
  assert.deepEqual(files(f.configHome), config);
  assert.deepEqual(files(f.skillsHome), skills);
});

test('native dry-run does not write host, policy, or trust state', t => {
  const f = fixture(t);
  f.ok(packageRoot, ['host', 'setup', ...f.nativeArgs('codex')]);
  const before = files(f.root);
  const result = f.ok(packageRoot, ['upgrade', ...f.nativeArgs('codex'), '--dry-run']);
  assert.equal(result.dryRun, true);
  assert.deepEqual(files(f.root), before);
});

test('host setup recovery argv retains explicit split roots without changing the process environment', t => {
  const f = fixture(t), previous = process.env.AE_SKILLS_HOME;
  const result = hostResultOf(['setup', ...f.nativeArgs('codex'), '--workspace', f.workspace, '--ae-home', f.home]);
  assert.equal(result.exitCode, 0);
  const command = result.workspace.checkReadiness.remediation.command;
  assert.equal(command[command.indexOf('--skills-home') + 1], f.skillsHome);
  assert.equal(command[command.indexOf('--copilot-home') + 1], f.configHome);
  assert.equal(command[command.indexOf('--ae-home') + 1], f.home);
  assert.equal(process.env.AE_SKILLS_HOME, previous);
});

test('legacy upgrade keeps installation success distinct from missing workspace prerequisites', t => {
  const f = fixture(t);
  const result = f.ok(packageRoot, ['upgrade', '--target', 'cli', '--copilot-home', f.configHome]);
  assert.equal(result.command, 'upgrade');
  assert.equal(result.installation.status, 'completed');
  assert.equal(result.checkReadiness.status, 'missing');
  assert.equal(result.workspace.checkReadiness.status, 'missing');
  assert.equal(result.workspace.trust.state, 'untrusted');
  assert.equal(result.workspace.status, 'blocked');
  assert.equal(result.workspace.nextActions[0].owner, 'engineer');
  assert.equal(result.workspace.nextActions.some(action => action.owner === 'person'), false);
});

test('failed native root selection withholds recovery for an unresolved binding', t => {
  const f = fixture(t);
  const args = ['--host', 'codex', '--config-home', f.configHome, '--skills-home', f.configHome];
  const setup = hostResultOf(['setup', ...args, '--workspace', f.workspace, '--ae-home', f.home]);
  assert.notEqual(setup.exitCode, 0);
  assert.equal(setup.workspace, undefined);
  const raw = f.cli(packageRoot, ['upgrade', ...args]);
  assert.notEqual(raw.status, 0);
  const upgraded = JSON.parse(raw.stdout);
  assert.equal(upgraded.integration.status, 'failed');
  assert.equal(upgraded.workspace, null);
  assert.equal(fs.existsSync(f.configHome), false);
  assert.equal(fs.existsSync(f.home), false);
});

test('legacy upgrade reports installation success while preserving a custom runner conflict', t => {
  const f = fixture(t), runner = path.join(f.workspace, '.harness/run.mjs');
  fs.mkdirSync(path.dirname(runner));
  fs.writeFileSync(runner, 'process.stdout.write("personal runner");\n');
  const before = fs.readFileSync(runner);
  const result = f.ok(packageRoot, ['upgrade', '--target', 'cli', '--copilot-home', f.configHome]);
  assert.equal(result.installation.status, 'completed');
  assert.equal(result.workspace.status, 'blocked');
  assert.equal(result.workspace.runner.state, 'custom');
  assert.deepEqual(fs.readFileSync(runner), before);
  assert.equal(result.runner.error.code, 'E_TARGET');
  assert.equal(fs.existsSync(path.join(f.configHome, '.ae-bin/bin/ae.mjs')), true);
});

test('host setup returns workspace prerequisites and worktree returns the actual destination snapshot', t => {
  const f = fixture(t);
  const setup = f.ok(packageRoot, ['host', 'setup', ...f.nativeArgs('terminal')]);
  assert.equal(setup.workspace.path, f.workspace);
  assert.equal(setup.workspace.checkReadiness.status, 'missing');
  const authority = path.join(f.workspace, '.github/harness');
  fs.mkdirSync(authority, { recursive: true });
  fs.writeFileSync(path.join(authority, 'checks.yaml'), 'version: 1\nchecks: {}\n');
  f.git(['add', '.']); f.git(['commit', '-qm', 'workspace fixture']);
  approveProject({ workspace: f.workspace, home: f.home, copilotHome: f.configHome });
  for (let i = 0; i < 2; i++) {
    const result = f.ok(packageRoot, ['worktree', '--slug', 'recover', '--copilot-home', f.configHome, '--skills-home', f.skillsHome]);
    assert.equal(result.created, i === 0);
    assert.equal(result.workspace.path, result.path);
    assert.equal(result.workspace.checkReadiness.source, path.join(result.path, '.github/harness/checks.yaml'));
    assert.equal(result.workspace.trust.state, 'trusted');
    assert.equal(result.workspace.trust.inherited, true);
    assert.equal(result.workspace.checkReadiness.status, 'empty');
    assert.equal(result.workspace.status, 'blocked');
  }
});

test('worktree text output preserves the conditional approval handoff for reviewed child changes', t => {
  const f = fixture(t);
  const checks = path.join(f.workspace, '.github/harness/checks.yaml');
  fs.mkdirSync(path.dirname(checks), { recursive: true });
  fs.writeFileSync(checks, 'version: 1\nchecks: {}\n');
  f.git(['add', '.']); f.git(['commit', '-qm', 'authority fixture']);
  approveProject({ workspace: f.workspace, home: f.home, copilotHome: f.configHome });
  const child = f.ok(packageRoot, ['worktree', '--slug', 'reviewed', '--copilot-home', f.configHome]);
  fs.writeFileSync(path.join(child.path, '.github/harness/checks.yaml'), 'version: 1\nchecks:\n  behavior:\n    command: [node, "--test"]\n');
  const printed = spawnSync(process.execPath, [path.join(packageRoot, 'bin/ae.mjs'), 'worktree', '--slug', 'reviewed',
    '--workspace', f.workspace, '--ae-home', f.home, '--copilot-home', f.configHome, '--no-events'], { cwd: f.workspace, env: f.env, encoding: 'utf8' });
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /If Engineer confirms the complete worktree policy changes are intentional/);
  assert.match(printed.stdout, /trust.*approve/);
  assert.ok(printed.stdout.includes(child.path));
});
