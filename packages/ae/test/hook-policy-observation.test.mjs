import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { approveProject } from '../lib/trust.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/ae.mjs');
const scripts = ['guard-critical-files.mjs', 'block-destructive-commands.mjs', 'require-plan-gate.mjs'];
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-hook-policy-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'state'), copilotHome = path.join(root, 'copilot');
  for (const directory of [workspace, home, copilotHome]) fs.mkdirSync(directory);
  const source = path.join(workspace, '.github/harness');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'checks.yaml'), 'version: 1\nchecks: {}\n');
  const setPolicy = enforcement => fs.writeFileSync(path.join(source, 'policy.yaml'), `version: 1\nenforcement: ${enforcement}\n`);
  setPolicy('enforce');
  const marker = path.join(root, 'policy-spawns.jsonl'), probe = path.join(root, 'probe.mjs');
  fs.writeFileSync(probe, `import fs from 'node:fs';\nimport childProcess from 'node:child_process';\nimport { syncBuiltinESMExports } from 'node:module';\nconst spawn = childProcess.spawnSync;\nchildProcess.spawnSync = function(command, args, options) {\n  if (Array.isArray(args) && args.includes('--effective-policy')) fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(args) + '\\n');\n  return spawn.call(this, command, args, options);\n};\nsyncBuiltinESMExports();\n`);
  const env = { ...process.env, AE_HOME: home, HARNESS_HOME: home, COPILOT_HOME: copilotHome, AE_BIN: bin, HARNESS_BIN: bin, HARNESS_NO_EVENTS: '1', NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(probe).href}`].filter(Boolean).join(' ') };
  delete env.AE_ENFORCEMENT;
  delete env.HARNESS_ENFORCEMENT;
  const setEnforcement = value => { env.AE_ENFORCEMENT = value; env.HARNESS_ENFORCEMENT = value; };
  const run = (script, tool, input, raw) => {
    const result = spawnSync(process.execPath, [path.join(packageRoot, 'corpus/hooks', script)], { cwd: workspace, env, input: raw ?? JSON.stringify({ workspace, session_id: 'policy-observation', tool_name: tool, tool_input: input }), encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  };
  const observations = () => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  return { workspace, home, copilotHome, setPolicy, setEnforcement, run, observations };
}

for (const script of scripts) test(`${script} admits an installed control without bootstrapping policy authority`, t => {
  const f = fixture(t);
  const command = [process.execPath, bin, 'checks', 'list', '--workspace', f.workspace, '--ae-home', f.home, '--copilot-home', f.copilotHome, '--json'].map(quote).join(' ');
  assert.equal(f.run(script, 'run_in_terminal', { command }).continue, true);
  assert.equal(f.observations(), 0, 'a candidate-free control must not start a policy CLI process');
});

for (const script of scripts) test(`${script} observes current enforcement for a denied mutation instead of reusing its old verdict`, t => {
  const f = fixture(t);
  const tool = script === 'block-destructive-commands.mjs' ? 'run_in_terminal' : 'create_file';
  const input = script === 'block-destructive-commands.mjs' ? { command: 'git reset --hard' } : { filePath: path.join(f.workspace, '.env'), content: 'value' };
  f.setPolicy('observe');
  f.setEnforcement('observe');
  approveProject(f); // A person is simulated only inside this disposable fixture.
  const observed = f.run(script, tool, input);
  assert.equal(observed.continue, true, JSON.stringify(observed));
  assert.match(observed.systemMessage, /harness hook/);
  assert.equal(f.observations(), 1);
  f.setPolicy('enforce');
  f.setEnforcement('enforce');
  approveProject(f);
  const denied = f.run(script, tool, input);
  assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(denied));
  assert.equal(f.observations(), 2, 'changed policy and approval must refresh the observation');
  assert.equal(fs.existsSync(path.join(f.workspace, '.env')), false);
});

test('malformed hook input still fails closed without consulting an approved observe policy', t => {
  const f = fixture(t);
  f.setPolicy('observe');
  f.setEnforcement('observe');
  approveProject(f);
  for (const script of scripts) assert.equal(f.run(script, null, null, '{').hookSpecificOutput?.permissionDecision, 'deny', script);
  assert.equal(f.observations(), 0);
});
