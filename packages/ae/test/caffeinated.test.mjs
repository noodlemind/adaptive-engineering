import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';
import { bindPlaybook, caffeinatedPointer } from '../lib/playbook-binding.mjs';
import { dispatchToolCall, runAgentLoop, DELIVER_PROFILE } from '../lib/agent-loop.mjs';
import { approveProject } from '../lib/trust.mjs';
import { tempDir } from './helpers/temp.mjs';
import { initGit, writeVersionedPlan, scriptedFlowLedger } from './helpers/cli-fixtures.mjs';

const shouldLoad = [
  ['Resume the accepted feature.', 'feature', 'planned'],
  ['Implement the scoped feature.', 'feature', 'in-progress'],
  ['Address the required review.', 'feature', 'review'],
  ['Repair the reproduced bug.', 'bug-fix', 'in-progress'],
  ['Resume bug review.', 'bug-fix', 'review'],
  ['Apply the accepted refactor.', 'refactor', 'planned'],
  ['Run the bounded performance work.', 'perf', 'in-progress'],
  ['Resume the same accepted procedure.', 'refactor', 'in-progress'],
];
for (const [prompt, playbook, status] of shouldLoad) test(`procedure pointer: ${prompt}`, t => {
  const home = tempDir('caffeinated-home-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const plan = { status, plan_lock: true, fm: { plan_id: randomUUID(), playbook, playbook_binding: bindPlaybook(playbook, { copilotHome: home }) } };
  const pointer = caffeinatedPointer(plan, { copilotHome: home });
  assert.equal(pointer.id, 'caffeinated');
  assert.ok(pointer.path.endsWith(path.join('skills', 'caffeinated', 'SKILL.md')));
  assert.match(fs.readFileSync(pointer.path, 'utf8'), /todo sync/);
});

const shouldNotLoad = [
  ['Answer a quick question.', null],
  ['Investigate without edits.', 'investigation'],
  ['Clarify high uncertainty.', 'needs-info'],
  ['Finish a completed task.', 'done'],
  ['Draft an unaccepted plan.', 'open'],
  ['Resolve a hard prerequisite.', 'blocked-capability'],
  ['Use an unbound recommendation.', 'unbound'],
  ['Use an unlocked procedure.', 'unlocked'],
];
for (const [prompt, state] of shouldNotLoad) test(`no procedure pointer: ${prompt}`, t => {
  const home = tempDir('caffeinated-no-load-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const plan = state === null ? null : { status: ['unbound', 'unlocked', 'investigation'].includes(state) ? 'in-progress' : state, plan_lock: state !== 'unlocked', fm: { plan_id: randomUUID(), playbook: state === 'investigation' ? state : 'feature' } };
  if (plan && state !== 'unbound') plan.fm.playbook_binding = bindPlaybook(plan.fm.playbook, { copilotHome: home });
  assert.equal(caffeinatedPointer(plan, { copilotHome: home }), null);
});

test('changed accepted playbook content cannot activate the internal procedure', t => {
  const home = tempDir('caffeinated-drift-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = path.join(home, 'skills/references/playbooks/feature.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, '# Feature\n\n1. Read behavior.\n');
  const plan = { status: 'in-progress', plan_lock: true, fm: { plan_id: randomUUID(), playbook: 'feature', playbook_binding: bindPlaybook('feature', { copilotHome: home }) } };
  fs.appendFileSync(source, '2. Accepted amendment required.\n');
  assert.equal(caffeinatedPointer(plan, { copilotHome: home }), null);
});


test('core governed skills fit a complete model-visible Deliver read', async t => {
  const workspace = tempDir('caffeinated-complete-workspace-'), home = tempDir('caffeinated-complete-home-'), copilotHome = tempDir('caffeinated-complete-copilot-');
  t.after(() => { for (const dir of [workspace, home, copilotHome]) fs.rmSync(dir, { recursive: true, force: true }); });
  const sessionId = randomUUID();
  for (const name of ['caffeinated', 'create-primitive']) {
    const read = await dispatchToolCall({ id: `load-${name}`, name: 'read', input: { path: `skills/${name}/SKILL.md` } }, { workspace, harnessHome: home, copilotHome, profile: DELIVER_PROFILE, sessionId });
    assert.equal(read.dispatched, true, read.reason);
    assert.equal(read.result.status, 'ok');
    assert.equal(read.result.truncated, false, `${name} needs a complete visible read`);
    const session = JSON.parse(fs.readFileSync(path.join(workspace, '.harness/session.json'), 'utf8'));
    assert.equal(session.activatedSkills[name].sessionId, sessionId);
  }
});

test('explicit plan selection loads one procedure without arming a query', t => {
  const workspace = tempDir('caffeinated-orient-'), home = tempDir('caffeinated-orient-home-'), copilotHome = tempDir('caffeinated-orient-copilot-');
  t.after(() => { for (const dir of [workspace, home, copilotHome]) fs.rmSync(dir, { recursive: true, force: true }); });
  const rel = writeVersionedPlan(workspace), full = path.join(workspace, rel);
  const text = fs.readFileSync(full, 'utf8'), parts = text.split('---'), fm = YAML.parse(parts[1]);
  fm.plan_id = randomUUID();
  fm.playbook = 'feature';
  fm.playbook_binding = bindPlaybook('feature', { copilotHome });
  fs.writeFileSync(full, `---\n${YAML.stringify(fm)}---${parts.slice(2).join('---')}`);
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/ae.mjs'), 'orient', '--read', '--plan', rel, '--workspace', workspace, '--harness-home', home, '--copilot-home', copilotHome, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.skills.filter(skill => skill.id === 'caffeinated').length, 1);
  assert.equal(fs.existsSync(path.join(workspace, '.harness/session.json')), false, 'plan path is not a query');
});

test('Deliver traces procedure loading, scoped work, review, proof and completion', async t => {
  const root = tempDir('caffeinated-journey-'), workspace = path.join(root, 'workspace'), home = path.join(root, 'harness'), copilotHome = path.join(root, 'copilot');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(workspace);
  const source = path.join(copilotHome, 'skills/references/playbooks/feature.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, '# Feature\n\n1. Implement the accepted change.\n2. Prove and complete the change.\n');
  const plan = writeVersionedPlan(workspace), full = path.join(workspace, plan);
  const text = fs.readFileSync(full, 'utf8'), parts = text.split('---'), fm = YAML.parse(parts[1]);
  fm.plan_id = randomUUID(); fm.playbook = 'feature'; fm.playbook_binding = bindPlaybook('feature', { copilotHome });
  fm.reviews.required = ['code-review'];
  fs.writeFileSync(full, `---\n${YAML.stringify(fm)}---${parts.slice(2).join('---')}`);
  initGit(workspace);
  assert.equal(spawnSync('git', ['checkout', '-b', 'feature/caffeinated-journey'], { cwd: workspace }).status, 0);
  approveProject({ workspace, copilotHome, home });
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/ae.mjs'), ...args, '--workspace', workspace, '--harness-home', home, '--copilot-home', copilotHome, '--json', '--no-events'], { cwd: workspace, encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const orientation = cli('orient', '--read', '--query', 'Return two and prove it.', '--file', 'src/example.js', '--plan', plan);
  cli('gate', '--phase', 'implement', '--plan', plan);
  let callId = 0;
  const call = (name, input) => ({ text: '', toolCalls: [{ id: `journey-${++callId}`, name, input }] });
  const decide = (id, action, fields = {}) => call('harness', { argv: ['plan-update', '--plan', plan], decision: { version: 1, id, action, expect: createHash('sha256').update(fs.readFileSync(full)).digest('hex'), ...fields } });
  const steps = [
    () => call('read', { path: orientation.skills.find(skill => skill.id === 'caffeinated').path }),
    () => decide('loaded-caffeinated', 'amend', { rationale: 'The procedure was read in this run.', changes: { skillsUsed: ['caffeinated'] } }),
    () => call('harness', { argv: ['gate', '--phase', 'implement', '--plan', plan] }),
    () => call('todo', { verb: 'sync', plan }),
    () => call('edit', { path: 'src/example.js', old: 'value = 1', new: 'value = 2' }),
    () => call('todo', { verb: 'complete', plan, id: cli('todo', 'list', '--plan', plan).items[0].id }),
    () => call('todo', { verb: 'sync', plan }),
    () => call('harness', { argv: ['review', 'prepare', '--plan', plan, '--base', 'HEAD'] }),
    () => {
      const packets = path.join(workspace, '.harness/reviews/packets');
      const packet = JSON.parse(fs.readFileSync(path.join(packets, fs.readdirSync(packets)[0])));
      return call('harness', { argv: ['review', 'assemble', '--plan', plan, '--packet', packet.id], decision: { packet: packet.id, results: packet.required.map(reviewer => ({ ...scriptedFlowLedger(packet, reviewer), reviewer, status: 'completed', findings: [], residual_risks: ['Scripted provider fixture does not measure model quality.'], testing_gaps: [] })) } });
    },
    () => call('harness', { argv: ['verify', '--plan', plan, '--base', 'HEAD'] }),
    () => call('harness', { argv: ['compound', '--plan', plan], decision: { operation: 'journey-no-learning', decision: 'no-learning', rationale: 'Disposable behavior fixture.' } }),
    () => call('todo', { verb: 'complete', plan, id: cli('todo', 'list', '--plan', plan).items[1].id }),
    () => decide('journey-complete', 'complete'),
    () => ({ text: 'Completed the accepted change.', toolCalls: [] }),
  ];
  let turn = 0;
  const result = await runAgentLoop({ task: 'Return two and prove it.', workspace, copilotHome, ctx: { harnessHome: home }, persona: { name: 'engineer', text: fs.readFileSync(path.resolve(import.meta.dirname, '../corpus/agents/engineer.agent.md'), 'utf8') }, profile: DELIVER_PROFILE, maxTurns: steps.length, maxSeconds: 60,
    startProviderFn: () => ({ async complete() { return { ...steps[turn++](), blocks: [], usage: {} }; }, close() {} }),
  });
  assert.equal(result.status, 'ok', result.detail || JSON.stringify(result.turns));
  assert.equal(result.stopReason, 'done');
  assert.equal(YAML.parse(fs.readFileSync(full, 'utf8').split('---')[1]).status, 'done');
  assert.ok(YAML.parse(fs.readFileSync(full, 'utf8').split('---')[1]).skills_used.includes('caffeinated'));
  assert.equal(cli('todo', 'list', '--plan', plan).performedCount, 2);
});
