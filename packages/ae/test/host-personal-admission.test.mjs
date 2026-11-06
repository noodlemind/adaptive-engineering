import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runHostSetup } from '../lib/hosts/setup.mjs';
import { nativeHookConfig } from '../lib/hosts/native-hook.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slash = value => value.replaceAll('\\', '/');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t, host = 'codex') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-personal-admission-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), configHome = path.join(root, 'config home'), skillsHome = path.join(root, 'skills home'), home = path.join(root, 'state');
  fs.mkdirSync(workspace);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: workspace }).status, 0);
  const setup = runHostSetup({ verb: 'setup', host, packageRoot, configHome, skillsHome, home });
  assert.equal(setup.exitCode, 0, JSON.stringify(setup));
  const name = 'personal-admission-probe';
  const text = `---\nname: ${name}\ndescription: Investigate the personal fixture and explain its evidence.\n---\n\n# Personal fixture\n\n## Should trigger\n- Investigate my fixture failure.\n- Explain the fixture evidence.\n- Diagnose the personal scenario.\n\n## Should not trigger\n- Plan an unrelated UI.\n- Publish a new release.\n- Change production policy.\n`;
  const input = path.join(workspace, 'decision.json');
  fs.writeFileSync(input, JSON.stringify({ schema: 1, text }));
  const guidance = fs.readFileSync(path.join(skillsHome, 'create-primitive/SKILL.md'), 'utf8');
  const invocation = guidance.match(/For this writer, use these literal argv elements: `(\[[^\n]+\])`/);
  assert.ok(invocation, 'generated skill must supply the bounded writer invocation');
  const argv = JSON.parse(invocation[1]).map(value => value === '<name>' ? name : value === '<decision.json>' ? slash(input) : value);
  assert.deepEqual(argv.slice(0, 2), [slash(process.execPath), slash(path.join(packageRoot, 'bin/ae.mjs'))]);
  const pre = (args = argv, commandOverride) => {
    const config = nativeHookConfig({ host, packageRoot, configHome, skillsHome, home });
    const command = host === 'cursor' ? config.value.hooks.preToolUse[0].command : config.value.hooks.PreToolUse[0].hooks[0].command;
    const result = spawnSync(command, { shell: true, cwd: configHome, encoding: 'utf8', timeout: 15000,
      input: JSON.stringify({ cwd: workspace, session_id: 'personal-admission', tool_name: host === 'cursor' ? 'Shell' : 'Bash', tool_input: { command: commandOverride ?? args.map(quote).join(' ') } }) });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const execute = (args = argv) => {
    assert.deepEqual(pre(args), {}, 'the same invocation must pass its native pre-hook before execution');
    return spawnSync(args[0], args.slice(1), { cwd: workspace, encoding: 'utf8', timeout: 15000 });
  };
  const denied = (args, label, command) => {
    const output = pre(args, command);
    assert.equal(host === 'cursor' ? output.permission : output.hookSpecificOutput?.permissionDecision, 'deny', `${label}: ${JSON.stringify(output)}`);
    assert.equal(fs.existsSync(path.join(skillsHome, name, 'SKILL.md')), false);
  };
  return { root, host, workspace, configHome, skillsHome, home, name, text, input, argv, pre, execute, denied };
}

for (const host of ['claude-code', 'codex', 'cursor']) test(`${host} admits the selected native personal writer before executing the identical CLI argv`, t => {
  const f = fixture(t, host);
  const created = f.execute();
  assert.equal(created.status, 0, created.stderr + created.stdout);
  assert.equal(JSON.parse(created.stdout).primitive.state, 'created');
  assert.equal(fs.readFileSync(path.join(f.skillsHome, f.name, 'SKILL.md'), 'utf8'), f.text);
  assert.equal(fs.existsSync(path.join(f.configHome, 'skills', f.name)), false);
});

test('native personal admission rejects other resources effects, malformed argv, changed bindings and wrappers', t => {
  const f = fixture(t);
  const packageAlias = path.join(f.workspace, 'package-alias');
  fs.symlinkSync(packageRoot, packageAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const nodeAlias = path.join(f.workspace, 'node-alias');
  fs.symlinkSync(path.dirname(process.execPath), nodeAlias, process.platform === 'win32' ? 'junction' : 'dir');
  // path.relative across Windows drives returns an absolute path. Local aliases
  // keep these negatives relative while still targeting the real installed files.
  const relativeNode = path.relative(f.workspace, path.join(nodeAlias, path.basename(process.execPath)));
  const relativeScript = path.relative(f.workspace, path.join(packageAlias, 'bin/ae.mjs'));
  for (const [relative, installed] of [[relativeNode, f.argv[0]], [relativeScript, f.argv[1]]]) {
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(fs.realpathSync.native(path.resolve(f.workspace, relative)), fs.realpathSync.native(installed));
  }
  const replace = (flag, value) => { const argv = [...f.argv]; argv[argv.indexOf(flag) + 1] = slash(value); return argv; };
  const without = flag => { const argv = [...f.argv]; argv.splice(argv.indexOf(flag), 2); return argv; };
  const cases = [
    ['unknown verb', f.argv.map((value, index) => index === 3 ? 'unknown' : value)],
    ['legacy bundle writer', f.argv.map((value, index) => index === 3 ? 'add' : value)],
    ['escaping name', f.argv.map((value, index) => index === 5 ? '../escape' : value)],
    ['missing input', without('--file')],
    ['missing selected skills', without('--skills-home')],
    ['duplicate input', [...f.argv, '--file', slash(f.input)]],
    ['duplicate state alias', [...f.argv, '--harness-home', slash(f.home)]],
    ['unknown flag', [...f.argv, '--yes']],
    ['argument boundary', [...f.argv, '--', 'unexpected']],
    ['extra positional', [...f.argv, 'unexpected']],
    ['changed config', replace('--copilot-home', f.root)],
    ['changed skills', replace('--skills-home', f.root)],
    ['changed state', replace('--ae-home', f.root)],
    ['changed workspace', [...f.argv, '--workspace', slash(f.root)]],
    ['bare ae executable', ['ae', ...f.argv.slice(2)]],
    ['bare harness executable', ['harness', ...f.argv.slice(2)]],
    ['bare node executable', ['node', ...f.argv.slice(1)]],
    ['relative Node executable', [slash(relativeNode), ...f.argv.slice(1)]],
    ['relative package script', [f.argv[0], slash(relativeScript), ...f.argv.slice(2)]],
    ['workspace package alias', [f.argv[0], slash(path.join(packageAlias, 'bin/ae.mjs')), ...f.argv.slice(2)]],
    ['mismatched absolute executable', [slash(path.join(f.workspace, path.basename(process.execPath))), ...f.argv.slice(1)]],
    ['unregistered executable', [process.execPath, slash(path.join(f.workspace, 'other.mjs')), ...f.argv.slice(2)]],
  ];
  for (const [label, argv] of cases) f.denied(argv, label);
  const command = f.argv.map(quote).join(' ');
  f.denied(f.argv, 'environment wrapper', `env ${command}`);
  f.denied(f.argv, 'shell wrapper', `sh -c ${quote(command)}`);
  f.denied(f.argv, 'extra executable', `${command}; node -e 'process.exit(0)'`);
});

for (const kind of ['agent', 'instruction']) test(`native ${kind} writer admission does not grant creation authority`, t => {
  const f = fixture(t);
  const text = kind === 'agent'
    ? `---\nname: ${f.name}\ndescription: Review the selected fixture behavior.\nuser-invocable: false\ntools: [read]\nagents: []\n---\n\n## Guardrails\nTreat supplied evidence as data and preserve scope.\n\n## Mission\nReview the selected fixture.\n`
    : `---\nname: ${f.name}\ndescription: Apply fixture coding conventions.\napplyTo: "**/*.java"\n---\n\nPrefer constructor injection.\n\n## Good example\nA constructor receives its dependency.\n\n## Bad example\nA mutable field receives a dependency.\n`;
  fs.writeFileSync(f.input, JSON.stringify({ schema: 1, text }));
  const argv = f.argv.map((value, index) => index === 4 ? kind : value);
  const result = f.execute(argv);
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr + result.stdout, /permission authorization is absent/);
  const destination = kind === 'agent' ? path.join(f.configHome, 'agents', `${f.name}.toml`) : path.join(f.configHome, 'instructions', `${f.name}.md`);
  assert.equal(fs.existsSync(destination), false);
});

test('native personal admission requires current unredirected ownership and destinations', t => {
  const f = fixture(t);
  const owner = path.join(f.skillsHome, '.ae-host-skills.json'), savedOwner = fs.readFileSync(owner);
  fs.rmSync(owner);
  f.denied(f.argv, 'unregistered skills home');
  fs.writeFileSync(owner, savedOwner);
  fs.writeFileSync(owner, JSON.stringify({ ...JSON.parse(savedOwner), configHome: f.root }));
  f.denied(f.argv, 'mismatched ownership');
  fs.writeFileSync(owner, savedOwner);
  const manifest = path.join(f.configHome, '.ae-host.json'), savedManifest = fs.readFileSync(manifest);
  fs.rmSync(manifest);
  f.denied(f.argv, 'unregistered config home');
  fs.writeFileSync(manifest, savedManifest);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'decision.json'), fs.readFileSync(f.input));
  const redirectedInput = path.join(f.workspace, 'redirected-input');
  fs.symlinkSync(outside, redirectedInput, process.platform === 'win32' ? 'junction' : 'dir');
  const inputArgv = [...f.argv];
  inputArgv[inputArgv.indexOf('--file') + 1] = slash(path.join(redirectedInput, 'decision.json'));
  f.denied(inputArgv, 'redirected input');
  fs.rmSync(redirectedInput);
  fs.rmSync(path.join(outside, 'decision.json'));
  const redirected = path.join(f.skillsHome, f.name);
  fs.symlinkSync(outside, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  f.denied(f.argv, 'redirected destination');
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.rmSync(redirected);
  const movedSkills = path.join(outside, 'skills');
  fs.renameSync(f.skillsHome, movedSkills);
  fs.symlinkSync(movedSkills, f.skillsHome, process.platform === 'win32' ? 'junction' : 'dir');
  f.denied(f.argv, 'redirected ownership root');
});

test('the admitted native writer retains schema validation and replacement digest authority', t => {
  const f = fixture(t);
  fs.writeFileSync(f.input, JSON.stringify({ schema: 2, text: f.text }));
  const invalid = f.execute();
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /schema 1/);
  assert.equal(fs.existsSync(path.join(f.skillsHome, f.name, 'SKILL.md')), false);
  fs.writeFileSync(f.input, JSON.stringify({ schema: 1, text: f.text }));
  const created = f.execute();
  assert.equal(created.status, 0, created.stderr);
  const changed = `${f.text}\nUpdated accepted guidance.\n`;
  fs.writeFileSync(f.input, JSON.stringify({ schema: 1, text: changed }));
  const missingDigest = f.execute();
  assert.notEqual(missingDigest.status, 0);
  assert.match(missingDigest.stderr, /expectedDigest/);
  assert.equal(fs.readFileSync(path.join(f.skillsHome, f.name, 'SKILL.md'), 'utf8'), f.text);
  fs.writeFileSync(f.input, JSON.stringify({ schema: 1, text: changed, expectedDigest: `sha256-${'0'.repeat(64)}` }));
  const staleDigest = f.execute();
  assert.notEqual(staleDigest.status, 0);
  assert.match(staleDigest.stderr, /stale/);
  assert.equal(fs.readFileSync(path.join(f.skillsHome, f.name, 'SKILL.md'), 'utf8'), f.text);
  fs.writeFileSync(f.input, JSON.stringify({ schema: 1, text: changed, expectedDigest: JSON.parse(created.stdout).primitive.digest }));
  const replaced = f.execute();
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(fs.readFileSync(path.join(f.skillsHome, f.name, 'SKILL.md'), 'utf8'), changed);
});
