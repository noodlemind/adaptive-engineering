import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';
import * as decisions from '../lib/plan-decisions.mjs';
import { collectOrientationFacts } from '../lib/orientation-facts.mjs';
import { buildContextRecord } from '../lib/context-record.mjs';
import { buildTaskHandoff } from '../lib/task-handoff.mjs';
import { unwrapOrientSlice } from '../corpus/hooks/lib/orient-slice.mjs';
import { observeHostIntent, inspectHostIntent } from '../lib/host-intent.mjs';
import { initGit, writeVersionedPlan } from './helpers/cli-fixtures.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/ae.mjs');
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-workflow-state-'));
  const workspace = path.join(root, 'workspace'), home = path.join(root, 'ae'), copilotHome = path.join(root, 'copilot');
  for (const directory of [workspace, home, copilotHome]) fs.mkdirSync(directory);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = writeVersionedPlan(workspace, { taskChecked: false });
  const full = path.join(workspace, plan);
  initGit(workspace);
  assert.equal(spawnSync('git', ['checkout', '-b', 'feature/workflow'], { cwd: workspace }).status, 0);
  const invoke = (args, input) => {
    const result = spawnSync(process.execPath, [bin, ...args, '--workspace', workspace, '--ae-home', home, '--copilot-home', copilotHome, '--json', '--no-events'], {
      cwd: workspace, input: input ? JSON.stringify(input) : undefined, encoding: 'utf8', timeout: 20000,
    });
    return { ...result, value: result.stdout.trim() ? JSON.parse(result.stdout) : null };
  };
  const revision = () => hash(fs.readFileSync(full));
  const update = (action, fields = {}) => invoke(['plan-update', '--plan', plan, '--file', '-'], { version: 1, id: `${action}-workflow`, action, expect: revision(), ...fields });
  return { workspace, home, copilotHome, plan, full, invoke, revision, update };
}

test('workflow decisions carry the observed revision without granting mutation authority', () => {
  const plan = { path: 'docs/plans/example.md', text: 'observed bytes', status: 'planned', phase: 1, plan_lock: true, sections: { plan: '- [ ] **T1** Implement.\n' } };
  const value = decisions.planWorkflow(plan, { missing: ['Read the accepted source'], evaluatedAction: 'start' });
  assert.equal(value.version, 1);
  assert.equal(value.plan.revision, hash(plan.text));
  assert.equal(value.mutationAuthority, 'none');
  const start = value.actions.find(item => item.action === 'start');
  assert.equal(start.prerequisites.state, 'blocked');
  assert.deepEqual(start.prerequisites.missing, ['Read the accepted source']);
  assert.equal(start.arguments.decision.expect, value.plan.revision);
  assert.equal(start.tool, 'ae_plan_update');
  assert.ok(!Object.hasOwn(start.arguments.decision, 'id'));
  assert.ok(start.required.includes('id'));
  assert.equal(value.actions.find(item => item.action === 'complete').prerequisites.state, 'not-evaluated');
});

test('workflow without a plan describes creation rather than an invented next revision', () => {
  const value = decisions.planWorkflow(null);
  assert.equal(value.plan, null);
  assert.equal(value.actions.length, 1);
  assert.equal(value.actions[0].tool, 'ae_plan_new');
  assert.equal(value.actions[0].action, 'create');
  assert.equal(value.actions[0].arguments.decision.version, 1);
  assert.ok(value.actions[0].required.includes('goal'));
});

test('resumed orientation and status expose the same exact plan revision', t => {
  const f = fixture(t);
  for (const args of [[], ['--read'], ['--read', '--context-version', '2']]) {
    const result = f.invoke(['orient', '--plan', f.plan, ...args]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(result.value.workflow.plan.revision, f.revision());
    assert.equal(result.value.workflow.plan.path, f.plan);
    assert.equal(result.value.workflow.mutationAuthority, 'none');
  }
  const status = f.invoke(['status', '--contract-digest', '--plan', f.plan]);
  assert.equal(status.status, 0, status.stderr + status.stdout);
  assert.equal(status.value.workflow.plan.revision, status.value.revision);
  assert.equal(buildTaskHandoff({ workspace: f.workspace, home: f.home }).workflow.plan.revision, f.revision());
});

test('context read barriers preserve bounded workflow state', t => {
  const f = fixture(t);
  const flags = { plan: f.plan, harnessHome: f.home, contextVersion: 2 };
  const facts = collectOrientationFacts({ workspace: f.workspace, copilotHome: f.copilotHome, flags });
  facts.slice.planGoal = { intent: 'Bounded workflow survives. '.repeat(3000) };
  const result = buildContextRecord({ workspace: f.workspace, flags, facts });
  assert.equal(result.coverage.renderBarrier, true);
  assert.equal(result.slice, null);
  assert.equal(result.workflow.plan.revision, f.revision());
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
  assert.equal(unwrapOrientSlice(result, {}).workflow.plan.revision, f.revision());
  facts.slice.workflow.actions[0].prerequisites.missing.push('Unbounded check diagnostic '.repeat(3000));
  const oversized = buildContextRecord({ workspace: f.workspace, flags, facts });
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) <= 32768);
  assert.equal(oversized.workflow.plan.revision, f.revision());
  assert.equal(oversized.workflow.requiresRead, true);
});

test('amend and progress return current decisions while stale or replayed work remains explicit', t => {
  const f = fixture(t), oldRevision = f.revision();
  const amended = f.update('amend', { rationale: 'User added a stable API requirement.', changes: { constraints: ['Preserve the API.'] } });
  assert.equal(amended.status, 0, amended.stderr + amended.stdout);
  assert.notEqual(amended.value.revision, oldRevision);
  assert.equal(amended.value.workflow.plan.revision, f.revision());
  assert.equal(amended.value.workflow.actions.find(item => item.action === 'start').arguments.decision.expect, f.revision());
  const stale = f.invoke(['plan-update', '--plan', f.plan, '--file', '-'], { version: 1, id: 'stale-context', action: 'finding', expect: oldRevision, finding: { id: 'stale', text: 'Old intent.' } });
  assert.equal(stale.status, 2);
  const beforeProgress = YAML.parse(fs.readFileSync(f.full, 'utf8').split('---')[1]);
  const progressInput = { version: 1, id: 'progress-workflow', action: 'progress', expect: f.revision(), progress: { tasks: ['T1'] } };
  const progress = f.invoke(['plan-update', '--plan', f.plan, '--file', '-'], progressInput);
  assert.equal(progress.status, 0, progress.stderr + progress.stdout);
  assert.equal(progress.value.workflow.plan.completedTasks, 1);
  const afterProgress = YAML.parse(fs.readFileSync(f.full, 'utf8').split('---')[1]);
  assert.deepEqual(afterProgress.intent_sources, beforeProgress.intent_sources);
  assert.equal(afterProgress.intent_source_policy, beforeProgress.intent_source_policy);
  const replay = f.invoke(['plan-update', '--plan', f.plan, '--file', '-'], progressInput);
  assert.equal(replay.status, 0, replay.stderr + replay.stdout);
  assert.equal(replay.value.replayed, true);
  assert.equal(replay.value.workflow.plan.revision, f.revision());
});

test('blocked start returns actual missing prerequisites and unchanged revision', t => {
  const f = fixture(t);
  fs.writeFileSync(f.full, fs.readFileSync(f.full, 'utf8').replace('plan_lock: true', 'plan_lock: false').replace('status: in-progress', 'status: open').replace('required: ["unit-tests"]', 'required: []'));
  const before = f.revision(), result = f.update('start');
  assert.equal(result.value.status, 'blocked', result.stderr + result.stdout);
  assert.equal(result.value.workflow.plan.revision, before);
  const start = result.value.workflow.actions.find(item => item.action === 'start');
  assert.equal(start.prerequisites.state, 'blocked');
  assert.deepEqual(start.prerequisites.missing, result.value.missing);
  assert.equal(f.revision(), before);
});

test('observed context is reconciled by successful decisions and old replays cannot accept a new turn', t => {
  const f = fixture(t);
  const observe = eventId => observeHostIntent({ workspace: f.workspace, sessionId: 'workflow-host-session', prompt: `User request ${eventId}`, eventId, host: 'copilot' });
  const first = observe('turn-one');
  const initial = f.invoke(['orient', '--read', '--context-version', '2', '--plan', f.plan]);
  const workflow = initial.value.workflow;
  assert.equal(workflow.observedIntent.source, 'host-event');
  assert.equal(workflow.observedIntent.id, first.id);
  assert.equal(workflow.observedIntent.state, 'pending');
  const candidate = workflow.actions.find(item => item.action === 'amend');
  assert.deepEqual(candidate.arguments.decision.observedIntent, { id: first.id });
  assert.ok(candidate.required.includes('observedIntent.disposition'));
  const input = { version: 1, id: 'accept-added-context', action: 'amend', expect: f.revision(), rationale: 'Accept the added API constraint.', changes: { constraints: ['Preserve the API.'] }, observedIntent: { id: first.id, disposition: 'amend', rationale: 'The user added a constraint to this plan.' } };
  const accepted = f.invoke(['plan-update', '--plan', f.plan, '--file', '-'], input);
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
  assert.equal(accepted.value.workflow.observedIntent.state, 'accepted');
  assert.equal(accepted.value.workflow.observedIntent.revision, f.revision());
  const progress = f.update('progress', { progress: { tasks: ['T1'] } });
  assert.equal(progress.status, 0, progress.stderr + progress.stdout);
  assert.equal(progress.value.workflow.observedIntent.state, 'accepted');
  const second = observe('turn-two');
  const replay = f.invoke(['plan-update', '--plan', f.plan, '--file', '-'], input);
  assert.equal(replay.status, 0, replay.stderr + replay.stdout);
  assert.equal(replay.value.replayed, true);
  assert.equal(replay.value.workflow.observedIntent.state, 'pending');
  assert.equal(replay.value.workflow.observedIntent.id, second.id);
  const stale = f.update('amend', { rationale: 'Old turn cannot accept new work.', changes: { constraints: ['Preserve the API.'] }, observedIntent: input.observedIntent });
  assert.equal(stale.status, 2);
  assert.match(stale.stderr + stale.stdout, /stale host intent/i);
  const completed = f.update('complete');
  assert.equal(completed.status, 2);
  assert.match(completed.stderr + completed.stdout, /reconcile.*observed intent/i);
  const unchanged = { version: 1, id: 'accept-unchanged-dry-run', action: 'finding', expect: f.revision(), finding: { id: 'clarification', text: 'No accepted contract change.' }, observedIntent: { id: second.id, disposition: 'unchanged', rationale: 'This is a clarification within the current accepted scope.' } };
  const dryRun = f.invoke(['plan-update', '--plan', f.plan, '--file', '-', '--dry-run'], unchanged);
  assert.equal(dryRun.status, 0, dryRun.stderr + dryRun.stdout);
  assert.equal(dryRun.value.workflow.observedIntent.state, 'pending');
  assert.equal(inspectHostIntent({ workspace: f.workspace, planPath: f.plan, revision: f.revision() }).state, 'pending');
});
