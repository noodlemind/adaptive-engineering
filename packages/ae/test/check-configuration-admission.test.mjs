import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';
import { runHostSetup } from '../lib/hosts/setup.mjs';
import { approveProject, trustStatus } from '../lib/trust.mjs';
import { nativeHookConfig } from '../lib/hosts/native-hook.mjs';
import { resolveProjectAuthority } from '../lib/project-authority.mjs';
import { checkConfigurationRecoveryControl, harnessControlCommand, normalizeToolPayload } from '../corpus/hooks/lib/tool-payload.mjs';
import { spawnGitSync } from '../corpus/hooks/lib/git-executable.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/ae.mjs');
const slash = value => value.replaceAll('\\', '/');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const commandOf = argv => argv.map(quote).join(' ');

function withEnv(env, action) {
  const keys = ['AE_BIN', 'HARNESS_BIN', 'AE_HOME', 'HARNESS_HOME', 'AE_SKILLS_HOME', 'HARNESS_SKILLS_HOME', 'AE_HOST', 'HARNESS_HOST', 'COPILOT_HOME'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    return action();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function fixture(t, host = null) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-check-admission-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), copilotHome = path.join(root, 'config'), skillsHome = path.join(root, 'skills'), home = path.join(root, 'state');
  for (const directory of [workspace, copilotHome, skillsHome]) fs.mkdirSync(directory);
  assert.equal(spawnGitSync(['init', '-q'], { cwd: workspace }).status, 0);
  if (host) assert.equal(runHostSetup({ verb: 'setup', host, packageRoot, configHome: copilotHome, skillsHome, home }).exitCode, 0);
  const config = path.join(workspace, '.github/harness');
  fs.mkdirSync(config, { recursive: true });
  const source = path.join(config, 'checks.yaml');
  fs.writeFileSync(source, 'version: 1\nchecks: {}\n');
  fs.writeFileSync(path.join(config, 'policy.yaml'), 'version: 1\nenforcement: enforce\n');
  const executed = path.join(workspace, 'check-executed');
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'app.json'), '{"value":7}\n');
  fs.writeFileSync(path.join(workspace, 'test/app.test.mjs'), `import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nassert.equal(JSON.parse(fs.readFileSync('app.json', 'utf8')).value, 7);\nfs.writeFileSync(${JSON.stringify(executed)}, 'executed');\n`);
  const env = { ...process.env, AE_BIN: bin, HARNESS_BIN: bin, AE_HOME: home, HARNESS_HOME: home, COPILOT_HOME: copilotHome, HARNESS_NO_EVENTS: '1', HARNESS_ENFORCEMENT: 'enforce' };
  if (host) Object.assign(env, { AE_HOST: host, HARNESS_HOST: host, AE_SKILLS_HOME: skillsHome, HARNESS_SKILLS_HOME: skillsHome });
  else for (const key of ['AE_HOST', 'HARNESS_HOST', 'AE_SKILLS_HOME', 'HARNESS_SKILLS_HOME']) delete env[key];
  const argv = [slash(process.execPath), slash(bin), 'checks', 'configure', '--workspace', slash(workspace), '--file', '-', '--json'];
  const decision = { schema: 1, expectedDigest: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), checks: { 'unit-tests': { command: [process.execPath, '--test', 'test/app.test.mjs'] } }, rationale: 'Register the existing product behavior test before delivery.' };
  const payload = command => ({ cwd: workspace, session_id: 'configure-bootstrap', tool_name: 'run_in_terminal', tool_input: { command } });
  const pre = command => {
    if (host) {
      const native = nativeHookConfig({ host, packageRoot, configHome: copilotHome, skillsHome, home });
      const launcher = host === 'cursor' ? native.value.hooks.preToolUse[0].command : native.value.hooks.PreToolUse[0].hooks[0].command;
      const result = spawnSync(launcher, { shell: true, cwd: workspace, input: JSON.stringify({ ...payload(command), tool_name: host === 'cursor' ? 'Shell' : 'Bash' }), env, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    }
    let output;
    for (const script of ['guard-critical-files.mjs', 'block-destructive-commands.mjs', 'require-plan-gate.mjs']) {
      const result = spawnSync(process.execPath, [path.join(packageRoot, 'corpus/hooks', script)], { cwd: workspace, input: JSON.stringify(payload(command)), env, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, result.stderr);
      output = JSON.parse(result.stdout);
      if (output.hookSpecificOutput?.permissionDecision === 'deny') break;
    }
    return output;
  };
  const admitted = command => {
    const output = pre(command);
    assert.notEqual(output.permission ?? output.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(output));
  };
  return { root, workspace, copilotHome, skillsHome, home, host, env, argv, source, decision, payload, pre, admitted, executed };
}

for (const host of [null, 'claude-code', 'codex', 'cursor']) test(`${host || 'Copilot'} admits only the installed check writer before a gate and executes identical argv`, t => {
  const f = fixture(t, host);
  // This is a disposable simulation of a person's prior approval of an empty
  // shared configuration, not approval of a real checkout.
  assert.equal(approveProject(f).trusted, true);
  const trustBefore = fs.readFileSync(path.join(f.home, 'trust.yaml'));
  const argv = [...f.argv, '--ae-home', slash(f.home), '--copilot-home', slash(f.copilotHome), ...(host ? ['--skills-home', slash(f.skillsHome)] : [])];
  f.admitted(commandOf(argv));
  const result = spawnSync(argv[0], argv.slice(1), { cwd: f.workspace, env: f.env, input: JSON.stringify(f.decision), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(YAML.parse(fs.readFileSync(f.source, 'utf8')).checks['unit-tests'].command, f.decision.checks['unit-tests'].command);
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'trust.yaml')), trustBefore, 'configuration must never approve trust');
  assert.equal(trustStatus(f).state, 'stale');
  assert.equal(fs.existsSync(f.executed), false, 'configuration must never execute the proposed check');
});

test('an untrusted workspace can prepare private checks without a gate or new product policy', t => {
  const f = fixture(t);
  fs.rmSync(path.dirname(f.source), { recursive: true });
  const authority = resolveProjectAuthority(f.workspace, { home: f.home });
  assert.equal(authority.mode, 'local');
  assert.equal(trustStatus(f).trusted, false);
  f.admitted(commandOf(f.argv));
  const result = spawnSync(f.argv[0], f.argv.slice(1), { cwd: f.workspace, env: f.env, input: JSON.stringify({ ...f.decision, expectedDigest: null }), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(YAML.parse(fs.readFileSync(authority.files['checks.yaml'], 'utf8')).checks['unit-tests'].command, f.decision.checks['unit-tests'].command);
  assert.equal(fs.existsSync(f.source), false);
  assert.equal(fs.existsSync(path.join(f.home, 'trust.yaml')), false);
  assert.equal(trustStatus(f).trusted, false);
  assert.equal(fs.existsSync(f.executed), false);
});

test('check bootstrap keeps a closed installed CLI grammar and selected workspace/homes', t => {
  const f = fixture(t);
  const packageAlias = path.join(f.workspace, 'package-alias'), nodeAlias = path.join(f.workspace, 'node-alias');
  fs.symlinkSync(packageRoot, packageAlias, process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(path.dirname(process.execPath), nodeAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const relativeBin = path.relative(f.workspace, path.join(packageAlias, 'bin/ae.mjs'));
  const relativeNode = path.relative(f.workspace, path.join(nodeAlias, path.basename(process.execPath)));
  for (const [relative, installed] of [[relativeBin, bin], [relativeNode, process.execPath]]) {
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(fs.realpathSync.native(path.resolve(f.workspace, relative)), fs.realpathSync.native(installed));
  }
  const replace = (flag, value) => { const argv = [...f.argv]; argv[argv.indexOf(flag) + 1] = slash(value); return argv; };
  const omit = flag => { const argv = [...f.argv]; argv.splice(argv.indexOf(flag), 2); return argv; };
  const bound = [...f.argv, '--ae-home', slash(f.home), '--copilot-home', slash(f.copilotHome)];
  withEnv(f.env, () => {
    assert.equal(harnessControlCommand(f.argv, f.workspace), 'checks');
    assert.equal(harnessControlCommand(bound, f.workspace), 'checks');
    const refused = [
      ['ae', ...f.argv.slice(2)], ['harness', ...f.argv.slice(2)], ['node', ...f.argv.slice(1)],
      [f.argv[0], slash(path.join(f.root, 'other.mjs')), ...f.argv.slice(2)],
      [f.argv[0], slash(relativeBin), ...f.argv.slice(2)], [slash(relativeNode), ...f.argv.slice(1)],
      [f.argv[0], slash(path.join(packageAlias, 'bin/ae.mjs')), ...f.argv.slice(2)],
      replace('--workspace', f.root), replace('--workspace', '.'), omit('--workspace'),
      replace('--file', 'decision.json'), omit('--file'), [...f.argv, '--file', '-'],
      [...f.argv, '--yes'], [...f.argv, '--', 'extra'], [...f.argv, 'extra'],
      [...f.argv, '--ae-home', slash(f.root)], [...bound, '--harness-home', slash(f.home)],
      [...f.argv, '--copilot-home', slash(f.root)], [...f.argv, '--skills-home', slash(f.root)],
      [...f.argv.slice(0, 2), 'trust', 'approve', '--workspace', slash(f.workspace)],
      [...f.argv.slice(0, 2), 'checks', 'run', 'unit-tests'],
    ];
    for (const argv of refused) assert.equal(harnessControlCommand(argv, f.workspace), null, commandOf(argv));
    const command = commandOf(f.argv);
    for (const wrapped of [`env ${command}`, `sh -c ${quote(command)}`, `${command}; node -e 'process.exit(0)'`, `${command} > output.json`, `${command} < decision.json`]) {
      assert.equal(normalizeToolPayload(f.payload(wrapped)).terminalEffects.hasOpaque, true, wrapped);
    }
    assert.equal(normalizeToolPayload(f.payload(command)).mutation, false);
  });
});

test('native check bootstrap refuses changed root aliases and retains stdin decision validation', t => {
  const f = fixture(t, 'codex');
  const changed = { ...f.env, HARNESS_HOME: f.root };
  for (const env of [changed, { ...f.env, HARNESS_SKILLS_HOME: f.root }, { ...f.env, HARNESS_HOST: 'cursor' }]) {
    withEnv(env, () => assert.throws(() => harnessControlCommand(f.argv, f.workspace), { code: 'E_USAGE' }));
  }
  const before = fs.readFileSync(f.source);
  f.admitted(commandOf(f.argv));
  const invalid = spawnSync(f.argv[0], f.argv.slice(1), { cwd: f.workspace, env: f.env, input: JSON.stringify({ ...f.decision, schema: 2 }), encoding: 'utf8', timeout: 15000 });
  assert.notEqual(invalid.status, 0);
  assert.deepEqual(fs.readFileSync(f.source), before);
});

test('a changed check binding admits bounded recovery and keeps execution blocked', t => {
  const f = fixture(t), roots = ['--workspace', slash(f.workspace), '--ae-home', slash(f.home), '--copilot-home', slash(f.copilotHome), '--json'];
  fs.mkdirSync(path.join(f.workspace, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(f.workspace, '.harness/session.json'), JSON.stringify({ gatedChecksDigest: '0'.repeat(64) }));
  const prefix = f.argv.slice(0, 2);
  const recovery = [
    f.argv,
    [...prefix, 'checks', 'list', ...roots],
    [...prefix, 'checks', 'show', 'unit-tests', ...roots],
    [...prefix, 'trust', 'status', ...roots],
    [...prefix, 'orient', '--read', '--context-version', '2', '--query', 'Repair verification readiness', ...roots],
    [...prefix, 'plan-new', '--file', '-', ...roots],
    [...prefix, 'plan-update', '--plan', '/fixture/plan.md', '--file', '-', ...roots],
  ];
  for (const argv of recovery) {
    withEnv(f.env, () => assert.ok(checkConfigurationRecoveryControl(argv, f.workspace), commandOf(argv)));
    f.admitted(commandOf(argv));
  }
  for (const argv of [
    [...prefix, 'verify', '--plan', '/fixture/plan.md', ...roots],
    [...prefix, 'checks', 'run', 'unit-tests', ...roots],
    [...prefix, 'trust', 'approve', ...roots],
    [...prefix, 'plan-new', '--file', 'decision.json', ...roots],
    [...prefix, 'plan-new', '--file', '-', '--plan', '/fixture/plan.md', ...roots],
    [...prefix, 'plan-new', '--file', '-', 'unexpected', ...roots],
    [...prefix, 'plan-new', '--file', '-', '--execute', 'unit-tests', ...roots],
    [...prefix, 'plan-update', '--plan', '/fixture/plan.md', '--file', 'decision.json', ...roots],
    ['ae', 'orient', ...roots],
  ]) {
    withEnv(f.env, () => assert.equal(checkConfigurationRecoveryControl(argv, f.workspace), null));
    const output = f.pre(commandOf(argv));
    assert.equal(output.permission ?? output.hookSpecificOutput?.permissionDecision, 'deny', commandOf(argv));
  }
});

test('a stale prior check binding permits a new authored plan after check preparation', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.workspace, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(f.workspace, '.harness/session.json'), JSON.stringify({ gatedChecksDigest: '0'.repeat(64) }));
  f.admitted(commandOf(f.argv));
  const configured = spawnSync(f.argv[0], f.argv.slice(1), { cwd: f.workspace, env: f.env, input: JSON.stringify(f.decision), encoding: 'utf8', timeout: 15000 });
  assert.equal(configured.status, 0, configured.stdout + configured.stderr);
  const argv = [...f.argv.slice(0, 2), 'plan-new', '--file', '-', '--workspace', slash(f.workspace), '--ae-home', slash(f.home), '--copilot-home', slash(f.copilotHome), '--json'];
  const decision = {
    version: 1, format: 'full', slug: 'prepared-check-recovery', status: 'planned', goal: 'Keep the product value equal to seven.',
    acceptance: ['The existing value assertion passes.'], constraints: ['Use the prepared behavioral check.'],
    scope: ['app.json', '.github/harness/checks.yaml'], check: 'unit-tests', skillsUsed: ['engineer'],
  };
  withEnv(f.env, () => assert.equal(checkConfigurationRecoveryControl(argv, f.workspace), 'plan-new'));
  f.admitted(commandOf(argv));
  f.admitted(`${commandOf(argv)} <<'AE_PLAN'\n${JSON.stringify(decision)}\nAE_PLAN`);
  const created = spawnSync(argv[0], argv.slice(1), { cwd: f.workspace, env: f.env, input: JSON.stringify(decision), encoding: 'utf8', timeout: 15000 });
  assert.equal(created.status, 0, created.stdout + created.stderr);
  const plan = JSON.parse(created.stdout);
  assert.ok(plan.path.startsWith(f.home + path.sep));
  const document = fs.readFileSync(plan.path, 'utf8');
  assert.match(document, /status: planned/);
  assert.match(document, /unit-tests/);
  assert.match(document, /\.github\/harness\/checks\.yaml/);
  assert.equal(fs.existsSync(path.join(f.home, 'trust.yaml')), false);
  assert.equal(fs.existsSync(f.executed), false);
});

test('a literal stdin decision remains a single recovery operation', t => {
  const f = fixture(t);
  const command = `${commandOf(f.argv)} <<'AE_DECISION'\n${JSON.stringify(f.decision)}\nAE_DECISION`;
  withEnv(f.env, () => {
    const effects = normalizeToolPayload(f.payload(command)).terminalEffects;
    assert.equal(effects.hasOpaque, false);
    assert.equal(effects.ambiguous, false);
    assert.equal(effects.invocations.length, 1);
  });
  fs.mkdirSync(path.join(f.workspace, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(f.workspace, '.harness/session.json'), JSON.stringify({ gatedChecksDigest: '0'.repeat(64) }));
  f.admitted(command);
});
