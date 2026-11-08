import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { tempDir, binPath } from './helpers/index.mjs';
import { writeChecks, writeVersionedPlan } from './helpers/cli-fixtures.mjs';
import { approveProject } from '../lib/trust.mjs';
import { buildContextPack } from '../lib/context-pack.mjs';
import { harnessControlCommand, normalizeToolPayload } from '../corpus/hooks/lib/tool-payload.mjs';
import { NEEDS_NO_LAZY_FETCH } from './helpers/git-features.mjs';

test('optional flow context yields pack space to accepted intent', () => {
  const options = { recall: [], plans: [], intentSources: [], gatePreview: { pass: true },
    planGoal: { intent: 'Keep accepted products searchable', constraints: ['c'.repeat(1350)] },
    trust: { state: 'trusted', trusted: true, reason: 'approved' } };
  const baseline = buildContextPack(options);
  assert.match(baseline, /Keep accepted products searchable/);
  const withFlow = buildContextPack({ ...options, flowModel: { state: 'current', flowIds: ['checkout'], reference: `/private/${'p'.repeat(130)}/model.json` } });
  assert.match(withFlow, /Keep accepted products searchable/);
  assert.doesNotMatch(withFlow, /Context blocked/);
  assert.ok(Buffer.byteLength(withFlow) <= 2048);
});

function fixture(t) {
  const root = tempDir('ae-flow-cli-'), workspace = path.join(root, 'repo'), home = path.join(root, 'ae'), copilotHome = path.join(root, 'copilot');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src/app.js'), 'export const state = "idle";\n');
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git('init', '-q', '-b', 'trunk'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  git('remote', 'add', 'origin', 'https://example.test/flow-cli.git');
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); git('update-ref', 'refs/remotes/origin/trunk', 'HEAD'); };
  commit(); git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [binPath, ...args, '--workspace', workspace, '--harness-home', home, '--copilot-home', copilotHome, '--json'], { encoding: 'utf8', timeout: 30000 });
    let body; try { body = JSON.parse(r.stdout); } catch { body = null; }
    return { ...r, body };
  };
  const ok = (...args) => { const r = cli(...args); assert.equal(r.status, 0, r.stderr || r.stdout); return r.body; };
  const write = (rel, data) => { fs.writeFileSync(path.join(workspace, rel), JSON.stringify(data)); return rel; };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, home, copilotHome, git, commit, cli, ok, write };
}

function publish(f) {
  const prepared = f.ok('flows', 'prepare', '--file', f.write('scope.json', { watchPaths: ['src'] }));
  const input = { version: 1, preparation: prepared.preparation, model: { version: 1, format: 'statechart', flows: [{
    id: 'checkout', title: 'Checkout', sources: ['src/app.js'], initial: 'idle', states: [{ id: 'idle' }, { id: 'done', kind: 'terminal' }],
    transitions: [{ from: 'idle', to: 'done', event: 'finish' }],
  }] } };
  f.ok('flows', 'publish', '--file', f.write('candidate.json', input));
  return input;
}

test('flows CLI is read-only when cold, validates inputs, and loads only relevant context', { skip: NEEDS_NO_LAZY_FETCH }, t => {
  const f = fixture(t);
  assert.equal(f.ok('flows', 'status').state, 'absent');
  assert.equal(fs.existsSync(f.home), false);
  assert.equal(f.cli('flows', 'publish').status, 2);
  assert.equal(f.cli('flows', 'status', '--file', 'scope.json').status, 2);
  assert.equal(f.cli('flows', 'prepare', '--file', '../outside.json').status, 2);
  assert.equal(f.cli('flows', 'status', '--json').status, 2, 'duplicate flags are rejected');
  publish(f);
  const relevant = f.ok('orient', '--read', '--file', 'src/app.js');
  assert.equal(relevant.flowModel.state, 'current');
  assert.deepEqual(relevant.flowModel.flowIds, ['checkout']);
  assert.equal(relevant.flowModel.model, undefined);
  assert.equal(relevant.intentSources.some(source => source.path.includes('flow-models')), false);
  const unrelated = f.ok('orient', '--read', '--file', 'README.md');
  assert.equal(Object.hasOwn(unrelated, 'flowModel'), false);
  f.ok('orient', '--file', 'src/app.js');
  const pack = fs.readFileSync(path.join(f.workspace, '.harness/context-pack.md'), 'utf8');
  assert.match(pack, /Application flows/);
  assert.ok(Buffer.byteLength(pack) <= 2048);
  assert.equal(f.ok('flows', 'show').model.flows[0].id, 'checkout');
});

test('verified compound advises regeneration after relevant default advance without changing intent authority', { skip: NEEDS_NO_LAZY_FETCH }, t => {
  const f = fixture(t);
  const plan = writeVersionedPlan(f.workspace);
  writeChecks(f.workspace, { 'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] } });
  f.commit(); const candidate = publish(f);
  fs.appendFileSync(path.join(f.workspace, 'src/app.js'), '// a new transition\n'); f.commit();
  assert.equal(f.ok('flows', 'status').state, 'stale');
  assert.notEqual(f.cli('flows', 'publish', '--file', f.write('candidate.json', candidate)).status, 0);
  assert.equal(f.cli('compound', '--plan', plan).body.flowMaintenance, undefined);
  approveProject({ workspace: f.workspace, copilotHome: f.copilotHome, home: f.home });
  const decision = f.write('.harness/no-learning.json', { operation: 'flow-advisory', decision: 'no-learning', rationale: 'A synthetic fixture has no durable product learning.' });
  f.ok('verify', '--plan', plan, '--base', 'HEAD');
  const compounded = f.ok('compound', '--plan', plan);
  assert.equal(compounded.pass, true);
  assert.equal(compounded.flowMaintenance.state, 'refresh-required');
  assert.deepEqual(compounded.flowMaintenance.nextTools, ['ae flows prepare --json']);
  const learned = f.ok('compound', '--plan', plan, '--learning-decision', decision);
  assert.equal(learned.flowMaintenance.state, 'refresh-required');
  assert.equal(f.ok('compound', '--plan', plan, '--learning-decision', decision).flowMaintenance.state, 'refresh-required');
  assert.equal(f.ok('compound', '--plan', plan, '--learning-decision', decision, '--dry-run').flowMaintenance, undefined);
});

test('canonical flow controls remain available through real hooks before and after a failed gate', { skip: NEEDS_NO_LAZY_FETCH }, t => {
  const f = fixture(t);
  const hook = (command, payload = {}) => {
    const result = spawnSync(process.execPath, [path.resolve(path.dirname(binPath), '../corpus/hooks/require-plan-gate.mjs')], {
      cwd: f.workspace, input: JSON.stringify({ cwd: f.workspace, workspace: f.workspace, session_id: 'flow-controls', tool_name: 'run_in_terminal', tool_input: { command }, ...payload }), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, AE_HOME: f.home, HARNESS_HOME: f.home, COPILOT_HOME: f.copilotHome, AE_BIN: binPath, HARNESS_BIN: binPath, HARNESS_ENFORCEMENT: 'enforce' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const controls = ['ae flows status --json', 'ae flows show --json', 'ae flows prepare --json', 'ae flows prepare --file scope.json --json', 'ae flows publish --file candidate.json --json', `node "${binPath}" flows status --json`];
  assert.equal(f.ok('flows', 'status').state, 'absent');
  for (const command of controls) {
    const normalized = normalizeToolPayload({ cwd: f.workspace, tool_name: 'run_in_terminal', tool_input: { command } });
    assert.equal(normalized.mutation, false, command);
    assert.equal(normalized.terminalEffects.hasOpaque, false, command);
    assert.equal(hook(command).continue, true, command);
  }
  publish(f);
  assert.equal(hook('ae flows publish --file candidate.json --json').continue, true);
  assert.equal(f.ok('flows', 'publish', '--file', 'candidate.json').replayed, true);
  const plan = writeVersionedPlan(f.workspace, { impacted: ['src/app.js'] });
  const planFile = path.join(f.workspace, plan);
  fs.writeFileSync(planFile, fs.readFileSync(planFile, 'utf8').replace('plan_lock: true', 'plan_lock: false'));
  approveProject({ workspace: f.workspace, copilotHome: f.copilotHome, home: f.home });
  const failed = f.cli('gate', '--phase', 'implement', '--plan', plan);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.equal(failed.body.checks.find(check => check.id === 'C3').pass, false);
  for (const command of controls) assert.equal(hook(command).continue, true, command);
  for (const command of ['ae flows show --json; node src/app.js', 'ae flows show --json; ae status --json', 'env ae flows show --json', 'ae flows status --json --json', 'ae flows publish', 'ae flows status --file scope.json', 'ae flows prepare --file ../outside.json', 'ae flows status --unknown', 'node src/app.js']) {
    assert.equal(hook(command).hookSpecificOutput?.permissionDecision, 'deny', command);
  }
  assert.equal(hook(null, { tool_name: 'replace_string_in_file', tool_input: { filePath: path.join(f.workspace, 'src/app.js'), oldString: 'idle', newString: 'done' } }).hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'src/app.js'), 'utf8'), 'export const state = "idle";\n');
});

test('flow control admission keeps CLI bounds, file restrictions and duplicate handling', () => {
  const admitted = [
    ['prepare', '--file=scope.json', '--dry-run'], ['publish', '--file', '.harness/decisions/flow.json', '-v'],
    ['show', '--json', '--no-events'], ['status', '--workspace', process.cwd(), '--ae-home', '/private/state', '--copilot-home', '/private/copilot'],
  ];
  for (const args of admitted) assert.equal(harnessControlCommand(['ae', 'flows', ...args], process.cwd()), 'flows', args.join(' '));
  const refused = [
    ['publish'], ['show', '--file', 'candidate.json'], ['prepare', '--file', '/absolute.json'], ['publish', '--file', 'src\\candidate.json'],
    ['prepare', '--file', 'C:/candidate.json'], ['prepare', '--file', './candidate.json'], ['prepare', '--file', 'src/../candidate.json'],
    ['status', '--verbose', '-v'], ['status', '--json=true'], ['status', '--json', '--json'], ['show', '--unexpected'],
    ['prepare', '--file'], ['prepare', '--file', '--json'], ['status', '--ae-home', 'x'.repeat(4097)], ['status', '--ae-home', 'bad\npath'],
    ['status', '--workspace', path.dirname(process.cwd())],
  ];
  for (const args of refused) assert.equal(harnessControlCommand(['ae', 'flows', ...args], process.cwd()), null, args.join(' '));
});
