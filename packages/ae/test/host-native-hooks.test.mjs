import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nativeHookConfig } from '../lib/hosts/native-hook.mjs';
import { gitExecutable } from '../corpus/hooks/lib/git-executable.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = path.join(packageRoot, 'lib/hosts/native-hook.mjs');

function spawnWithDiagnostics(command, args, options) {
  const started = Date.now();
  const result = spawnSync(command, args, options);
  if (result.status !== 0) console.error(JSON.stringify({
    elapsedMs: Date.now() - started, status: result.status, signal: result.signal, pid: result.pid,
    errorCode: result.error?.code ?? null, errorMessage: result.error?.message ?? null,
    stdout: result.stdout, stderr: result.stderr,
  }));
  return result;
}

test('Windows native command formatting binds an absolute system launcher', async () => {
  const { nativeHookCommand } = await import('../lib/hosts/native-hook.mjs');
  assert.equal(typeof nativeHookCommand, 'function');
  const powerShellExecutable = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const invoke = nativeHookCommand(['C:\\Program Files\\nodejs\\node.exe', "C:\\AE's config\\hook.mjs"], { platform: 'win32', powerShellExecutable });
  assert.ok(invoke.startsWith(powerShellExecutable + ' '));
  const decoded = Buffer.from(invoke.match(/-EncodedCommand ([A-Za-z0-9+/=]+)$/)[1], 'base64').toString('utf16le');
  assert.equal(decoded, "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\AE''s config\\hook.mjs'");
});

function fixture(t, configName = 'config home') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-native-hook-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), configHome = path.join(root, configName), skillsHome = path.join(root, 'skills'), home = path.join(root, 'state');
  fs.mkdirSync(workspace); fs.mkdirSync(configHome);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: workspace }).status, 0);
  fs.writeFileSync(path.join(workspace, 'example.txt'), 'original\n');
  const run = (host, event, payload, extra = {}) => spawnWithDiagnostics(process.execPath, [bridge, '--host', host, '--event', event, '--config-home', configHome, '--skills-home', skillsHome, '--ae-home', home], {
    cwd: configHome, env: { ...process.env, AE_HOME: home, HARNESS_HOME: home }, encoding: 'utf8',
    input: typeof payload === 'string' ? payload : JSON.stringify(payload), timeout: 60000, ...extra,
  });
  return { root, workspace, configHome, skillsHome, home, run };
}

test('native hook configuration uses each host dialect and preserves selected roots', t => {
  const { configHome, skillsHome, home } = fixture(t);
  const roots = { configHome, skillsHome, home, packageRoot };
  const commandSource = command => process.platform === 'win32'
    ? Buffer.from(command.match(/-EncodedCommand ([A-Za-z0-9+/=]+)$/)[1], 'base64').toString('utf16le')
    : command;
  for (const host of ['claude-code', 'codex']) {
    const result = nativeHookConfig({ host, ...roots });
    assert.equal(result.path, host === 'codex' ? 'hooks.json' : 'settings.json');
    const source = commandSource(result.value.hooks.PreToolUse[0].hooks[0].command);
    assert.ok(source.includes('--skills-home'));
    assert.ok(source.includes('--ae-home'));
    for (const root of [configHome, skillsHome, home]) assert.ok(source.includes(root));
    assert.ok(result.value.hooks.Stop);
    assert.equal(result.value.trust, undefined);
  }
  const cursor = nativeHookConfig({ host: 'cursor', ...roots });
  assert.equal(cursor.value.version, 1);
  assert.equal(cursor.value.hooks.preToolUse[0].failClosed, true);
  assert.equal(cursor.value.hooks.preToolUse[0].hooks, undefined);
  assert.ok(commandSource(cursor.value.hooks.stop[0].command).includes('--event'));
  assert.throws(() => nativeHookConfig({ host: 'unknown', ...roots }), /Unsupported native host/);
});

for (const host of ['claude-code', 'codex', 'cursor']) test(`${host} denies unplanned native edits and binds workspace from payload, not hook cwd`, t => {
  const f = fixture(t);
  const result = f.run(host, 'pre', { cwd: f.workspace, session_id: 'native', tool_name: 'Write', tool_input: { file_path: path.join(f.workspace, 'example.txt'), content: 'changed\n' } });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  const reason = host === 'cursor' ? decision.agent_message : decision.hookSpecificOutput?.permissionDecisionReason;
  assert.match(reason, /missing-implement-gate/);
  assert.equal(host === 'cursor' ? decision.permission : decision.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'example.txt'), 'utf8'), 'original\n');
  assert.equal(fs.existsSync(path.join(f.configHome, '.harness')), false);
});

test('native read is admitted, but unknown and malformed pre payloads fail closed', t => {
  const f = fixture(t);
  const input = { cwd: f.workspace, session_id: 'native', tool_name: 'Read', tool_input: { file_path: path.join(f.workspace, 'example.txt') } };
  assert.equal(f.run('claude-code', 'pre', input).stdout.trim(), '{}');
  for (const payload of ['not JSON', {}, { ...input, cwd: 'relative' }, { ...input, tool_name: 'MysteryAction', tool_input: {} }, { ...input, tool_name: 'Bash', tool_input: {} }]) {
    const result = f.run('codex', 'pre', payload);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision, 'deny', result.stderr + result.stdout);
  }
});

test('generated command executes with quoted home paths and native workspace identity', t => {
  const f = fixture(t, "config ' quote $ home");
  const config = nativeHookConfig({ host: 'claude-code', ...f, packageRoot });
  const invoke = config.value.hooks.PreToolUse[0].hooks[0].command;
  const result = spawnWithDiagnostics(invoke, [], {
    shell: true, cwd: f.configHome, encoding: 'utf8', timeout: config.value.hooks.PreToolUse[0].hooks[0].timeout * 1000,
    input: JSON.stringify({ cwd: f.workspace, tool_name: 'Read', tool_input: { file_path: path.join(f.workspace, 'example.txt') } }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '{}');
  assert.equal(fs.existsSync(path.join(f.configHome, '.harness')), false);
});

test('Windows Git query classification refuses cwd and relative-PATH executable shadows without running them', t => {
  const f = fixture(t);
  const toolPayload = new URL('../corpus/hooks/lib/tool-payload.mjs', import.meta.url).href;
  const script = `import { analyzeTerminalEffects } from ${JSON.stringify(toolPayload)}; Object.defineProperty(process, 'platform', { value: 'win32' }); console.log(JSON.stringify(analyzeTerminalEffects('git version', process.argv[1])));`;
  const inspect = (pathValue = '') => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['PATH', 'PATHEXT'].includes(key.toUpperCase())));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.workspace], {
      cwd: f.workspace, env: { ...env, PATH: pathValue, PATHEXT: '.EXE;.AEFIXTURE' }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).hasOpaque;
  };
  assert.equal(inspect(), false, 'ordinary Git version remains a query');
  for (const name of ['git', 'git.exe', 'git.COM', 'git.cmd', 'git.bat', 'git.ps1', 'git.AEFIXTURE']) {
    const full = path.join(f.workspace, name);
    fs.writeFileSync(full, 'This planted executable must never run.\n');
    assert.equal(inspect(), true, name);
    fs.rmSync(full);
  }
  const directory = path.join(f.workspace, 'git.exe');
  fs.mkdirSync(directory);
  assert.equal(inspect(), false, 'an ordinary directory is not an executable shadow');
  fs.rmdirSync(directory);
  fs.mkdirSync(path.join(f.workspace, 'bin'));
  fs.writeFileSync(path.join(f.workspace, 'bin/git.cmd'), 'This relative PATH executable must never run.\n');
  assert.equal(inspect('bin'), true);
  fs.rmSync(path.join(f.workspace, 'bin/git.cmd'));
  assert.equal(inspect('bin'), false);
});

test('Windows SessionStart ignores repository-local Git and PowerShell executables', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const git = gitExecutable();
  // Query classification deliberately refuses configured Git helpers. Keep the
  // positive control independent of runner/user LFS, pager and fsmonitor setup.
  const gitConfig = path.join(f.root, 'empty.gitconfig');
  fs.writeFileSync(gitConfig, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')
    && !['PAGER', 'NODEFAULTCURRENTDIRECTORYINEXEPATH'].includes(key.toUpperCase())));
  Object.assign(env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_SYSTEM: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
  for (const args of [['add', 'example.txt'], ['-c', 'user.name=AE fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture']]) {
    const result = spawnSync(git, args, { cwd: f.workspace, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const name of ['git.exe', 'powershell.exe']) fs.writeFileSync(path.join(f.workspace, name), 'Invalid image: a repository executable must never be selected.\n');
  // A fresh Node process removes any inherited cwd-search opt-out, including on
  // Node 22. This control proves that bare lookup encounters the planted image.
  for (const name of ['git', 'powershell.exe']) {
    const control = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import { spawnSync } from "node:child_process"; const command = process.argv[1]; const args = command === "git" ? ["--version"] : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"]; const child = spawnSync(command, args); console.log(JSON.stringify({ status: child.status, error: child.error?.code }));', name],
    { cwd: f.workspace, env, encoding: 'utf8' });
    assert.equal(control.status, 0, control.stderr);
    const result = JSON.parse(control.stdout);
    assert.ok(result.error || result.status !== 0, `${name} control unexpectedly bypassed the planted image`);
  }
  assert.equal(spawnSync(git, ['--version'], { cwd: f.workspace, env }).status, 0);
  const preGit = (host, query) => {
    const native = nativeHookConfig({ host, ...f, packageRoot });
    const command = host === 'cursor' ? native.value.hooks.preToolUse[0].command : native.value.hooks.PreToolUse[0].hooks[0].command;
    const result = spawnSync(command, { shell: true, cwd: f.workspace, env, encoding: 'utf8', timeout: 20000,
      input: JSON.stringify({ cwd: f.workspace, session_id: 'untrusted-native-query', tool_name: host === 'cursor' ? 'Shell' : 'Bash', tool_input: { command: query } }) });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  for (const host of ['claude-code', 'codex', 'cursor']) for (const query of ['git status', 'git version']) {
    const decision = preGit(host, query);
    assert.equal(host === 'cursor' ? decision.permission : decision.hookSpecificOutput?.permissionDecision, 'deny', `${host}: ${query}`);
    assert.match(host === 'cursor' ? decision.agent_message : decision.hookSpecificOutput.permissionDecisionReason, /missing-implement-gate/);
  }
  const config = nativeHookConfig({ host: 'claude-code', ...f, packageRoot });
  const invoke = config.value.hooks.SessionStart[0].hooks[0].command;
  const started = spawnSync(invoke, { shell: true, cwd: f.workspace, env, encoding: 'utf8', timeout: 20000,
    input: JSON.stringify({ cwd: f.workspace, session_id: 'untrusted-native-start' }) });
  assert.equal(started.status, 0, started.stderr);
  const context = JSON.parse(started.stdout).hookSpecificOutput.additionalContext;
  const slice = JSON.parse(context.split('harness-orient-slice: ')[1]);
  assert.match(slice.contextEvidence.sourceState.digest, /^[a-f0-9]{64}$/);
  assert.equal(slice.trust.state, 'untrusted');
  fs.rmSync(path.join(f.workspace, 'git.exe'));
  for (const host of ['claude-code', 'codex', 'cursor']) for (const query of ['git status', 'git version']) {
    assert.deepEqual(preGit(host, query), {}, `${host}: ${query} without a Git shadow`);
  }
});

test('Codex apply_patch is treated as an edit rather than a read or shell exemption', t => {
  const f = fixture(t);
  const result = f.run('codex', 'pre', { cwd: f.workspace, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: example.txt\n@@\n-original\n+changed\n*** End Patch' } });
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision, 'deny');
});

test('native shell execution directories cannot replace the payload workspace authority', t => {
  const f = fixture(t), foreign = path.join(f.root, 'foreign-product');
  fs.mkdirSync(foreign);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: foreign }).status, 0);
  for (const host of ['claude-code', 'codex', 'cursor']) {
    for (const field of ['working_directory', 'workdir', 'cwd']) {
      for (const directory of [foreign, path.relative(f.workspace, foreign)]) {
        const result = f.run(host, 'pre', { cwd: f.workspace, tool_name: host === 'cursor' ? 'Shell' : 'Bash', tool_input: { command: 'git -C . status', [field]: directory } });
        const output = JSON.parse(result.stdout);
        assert.match(host === 'cursor' ? output.agent_message : output.hookSpecificOutput?.permissionDecisionReason, /execution directory conflicts with native workspace/, `${host}/${field}/${directory}`);
      }
      const same = f.run(host, 'pre', { cwd: f.workspace, tool_name: 'Bash', tool_input: { command: 'pwd', [field]: '.' } });
      assert.equal(same.stdout.trim(), '{}');
    }
  }
});

test('known Codex delegation dispatch does not grant child edit authority', t => {
  const f = fixture(t);
  for (const name of ['spawn_agent', 'wait_agent', 'send_input', 'close_agent', 'resume_agent']) {
    const result = f.run('codex', 'pre', { cwd: f.workspace, session_id: 'parent', tool_name: name, tool_input: { agent_type: 'security-sentinel', message: 'Review only' } });
    assert.equal(result.stdout.trim(), '{}', name);
  }
  const child = f.run('codex', 'pre', { cwd: f.workspace, session_id: 'child', tool_name: 'Write', tool_input: { file_path: path.join(f.workspace, 'example.txt'), content: 'changed' } });
  assert.equal(JSON.parse(child.stdout).hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'example.txt'), 'utf8'), 'original\n');
});

test('post hooks never synthesize complete skill-read evidence from success or missing output', t => {
  const f = fixture(t), skill = path.join(f.skillsHome, 'create-primitive/SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true }); fs.writeFileSync(skill, '# Full procedure\nRead all lines.\n');
  for (const response of [undefined, {}, { success: true }, { truncated: true, content: '# Full procedure\nRead all lines.\n' }]) {
    const result = f.run('claude-code', 'post', { cwd: f.workspace, session_id: 'native', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: skill }, tool_response: response });
    assert.equal(result.status, 0, result.stderr);
    const session = path.join(f.workspace, '.harness/session.json');
    assert.equal(fs.existsSync(session) ? JSON.parse(fs.readFileSync(session)).activatedSkills?.['create-primitive'] : undefined, undefined);
  }
});

for (const host of ['claude-code', 'codex', 'cursor']) test(`${host} binds an actual full skill read from a separately selected skills root`, t => {
  const f = fixture(t), skill = path.join(f.skillsHome, 'create-primitive/SKILL.md');
  const source = '# Full procedure\nRead all lines and preserve the source binding.\n';
  fs.mkdirSync(path.dirname(skill), { recursive: true }); fs.writeFileSync(skill, source);
  const payload = {
    cwd: f.workspace, session_id: 'split-root-native', hook_event_name: host === 'cursor' ? 'postToolUse' : 'PostToolUse',
    tool_name: 'Read', tool_input: { file_path: skill },
    ...(host === 'cursor' ? { tool_output: JSON.stringify({ content: source }) } : { tool_response: { content: source } }),
  };
  const result = f.run(host, 'post', payload);
  assert.equal(result.status, 0, result.stderr);
  const session = JSON.parse(fs.readFileSync(path.join(f.workspace, '.harness/session.json'), 'utf8'));
  const activation = session.activatedSkills['create-primitive'];
  assert.equal(activation.complete, true);
  assert.equal(activation.sessionId, 'split-root-native');
  assert.equal(activation.source.path, fs.realpathSync.native(skill));
  assert.match(activation.source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(path.join(f.configHome, 'skills/create-primitive/SKILL.md')), false);
});

test('Cursor stop is a bounded continuation hint, not a hard denial guarantee', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.workspace, '.harness'));
  fs.writeFileSync(path.join(f.workspace, '.harness/session.json'), JSON.stringify({ version: 1, lastEditAt: new Date().toISOString() }));
  const result = f.run('cursor', 'stop', { cwd: f.workspace, status: 'completed', loop_count: 0 });
  const output = JSON.parse(result.stdout);
  assert.equal(typeof output.followup_message, 'string');
  assert.equal(output.permission, undefined);
  assert.match(output.followup_message, /verification|verify/);
  for (const status of ['aborted', 'error']) {
    assert.deepEqual(JSON.parse(f.run('cursor', 'stop', { cwd: f.workspace, status }).stdout), {});
  }
});
