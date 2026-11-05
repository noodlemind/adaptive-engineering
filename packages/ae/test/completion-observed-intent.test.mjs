import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { completeWork } from '../lib/completion.mjs';
import { inspectHostIntent, observeHostIntent } from '../lib/host-intent.mjs';
import { applyPlanUpdate } from '../lib/plan-update.mjs';
import { loadPlan, planWithText } from '../lib/plan-parse.mjs';
import { approveProject } from '../lib/trust.mjs';
import { initGit, writeVersionedPlan, writeNoLearningDecision } from './helpers/cli-fixtures.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/ae.mjs');
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-completion-intent-'));
  const workspace = path.join(root, 'workspace'), home = path.join(root, 'ae'), copilotHome = path.join(root, 'copilot');
  for (const directory of [workspace, home, copilotHome]) fs.mkdirSync(directory);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, '.gitignore'), '.harness/\n');
  const planPath = writeVersionedPlan(workspace);
  const full = path.join(workspace, planPath);
  initGit(workspace);
  assert.equal(spawnSync('git', ['checkout', '-b', 'feature/completion-intent'], { cwd: workspace }).status, 0);
  const invoke = (args, input) => {
    const result = spawnSync(process.execPath, [bin, ...args, '--workspace', workspace, '--ae-home', home, '--copilot-home', copilotHome, '--json', '--no-events'], {
      cwd: workspace, input: input ? JSON.stringify(input) : undefined, encoding: 'utf8', timeout: 20000,
    });
    return { ...result, value: result.stdout.trim() ? JSON.parse(result.stdout) : null };
  };
  approveProject({ workspace, home, copilotHome });
  const verified = invoke(['verify', '--plan', planPath, '--base', 'HEAD']);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  const learning = invoke(['compound', '--plan', planPath, '--learning-decision', writeNoLearningDecision(workspace)]);
  assert.equal(learning.status, 0, learning.stdout + learning.stderr);
  const revision = () => hash(fs.readFileSync(full));
  const inspect = () => inspectHostIntent({ workspace, planPath, revision: revision() });
  const observe = eventId => observeHostIntent({ workspace, sessionId: JSON.parse(fs.readFileSync(path.join(workspace, '.harness/session.json'))).sessionId, host: 'copilot', eventId, prompt: `Current request ${eventId}` });
  const accept = observation => invoke(['plan-update', '--plan', planPath, '--file', '-'], {
    version: 1, id: `accept-${observation.id.slice(-12)}`, action: 'progress', expect: revision(),
    progress: { phase: 1 },
    observedIntent: { id: observation.id, disposition: 'unchanged', rationale: 'The accepted contract remains applicable.' },
  });
  return { workspace, home, copilotHome, planPath, full, invoke, revision, inspect, observe, accept };
}

test('shared completion refuses a pending host request despite current proof', t => {
  const f = fixture(t);
  f.observe('pending-direct');
  const current = loadPlan(f.workspace, f.planPath, { home: f.home });
  const proposed = planWithText(current, applyPlanUpdate(current.text, { status: 'done', activity: ['Complete the accepted work.'] }));
  assert.throws(() => completeWork({ workspace: f.workspace, plan: proposed, copilotHome: f.copilotHome }), /observed intent.*reconcil/i);
  assert.equal(loadPlan(f.workspace, f.planPath).status, 'in-progress');
});

test('legacy completion cannot consume proof before new intent is reconciled', t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.full, 'utf8');
  f.observe('pending-legacy');
  const result = f.invoke(['plan-update', '--plan', f.planPath, '--status', 'done']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /observed intent.*reconcil/i);
  assert.equal(fs.readFileSync(f.full, 'utf8'), before);
});

test('accepted intent uses on-disk revision for proposed completion and survives legacy bookkeeping', t => {
  const f = fixture(t);
  assert.equal(f.accept(f.observe('accepted')).status, 0);
  assert.equal(f.inspect().state, 'accepted');
  const current = loadPlan(f.workspace, f.planPath, { home: f.home });
  const proposed = planWithText(current, applyPlanUpdate(current.text, { status: 'done', activity: ['Complete the accepted work.'] }));
  assert.ok(completeWork({ workspace: f.workspace, plan: proposed, copilotHome: f.copilotHome }).id);
  const progress = f.invoke(['plan-update', '--plan', f.planPath, '--activity', 'Recorded current bookkeeping.']);
  assert.equal(progress.status, 0, progress.stdout + progress.stderr);
  assert.equal(f.inspect().state, 'accepted');
  const completed = f.invoke(['plan-update', '--plan', f.planPath, '--status', 'done']);
  assert.equal(completed.status, 0, completed.stdout + completed.stderr);
  assert.equal(f.inspect().state, 'accepted');
  const validated = f.invoke(['status', '--validate-completion', '--plan', f.planPath]);
  assert.equal(validated.value.pass, true, validated.stdout + validated.stderr);
});

test('legacy dry runs and bookkeeping cannot reconcile a later host request', t => {
  const f = fixture(t);
  assert.equal(f.accept(f.observe('first')).status, 0);
  const before = f.revision();
  assert.equal(f.invoke(['plan-update', '--plan', f.planPath, '--activity', 'Preview only.', '--dry-run']).status, 0);
  assert.equal(f.revision(), before);
  assert.equal(f.inspect().state, 'accepted');
  f.observe('second');
  assert.equal(f.invoke(['plan-update', '--plan', f.planPath, '--activity', 'Record pending context.']).status, 0);
  assert.equal(f.inspect().state, 'pending');
});

test('a read-only followup preserves historical completion without authorizing a fresh completion', t => {
  const f = fixture(t);
  assert.equal(f.accept(f.observe('delivered')).status, 0);
  const completed = f.invoke(['plan-update', '--plan', f.planPath, '--status', 'done']);
  assert.equal(completed.status, 0, completed.stdout + completed.stderr);
  const sessionFile = path.join(f.workspace, '.harness/session.json');
  const session = JSON.parse(fs.readFileSync(sessionFile));
  session.lastEditAt = new Date(Date.parse(session.lastVerifyAt) - 1000).toISOString();
  session.lastEditTargets = ['src/example.js'];
  fs.writeFileSync(sessionFile, JSON.stringify(session));
  f.observe('read-only-question');
  assert.equal(f.inspect().state, 'pending');
  assert.equal(f.invoke(['status', '--validate-completion', '--plan', f.planPath]).value.pass, true);
  const stopped = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../corpus/hooks/require-verification.mjs')], {
    cwd: f.workspace, encoding: 'utf8', input: JSON.stringify({ cwd: f.workspace, session_id: session.sessionId, hook_event_name: 'Stop' }),
    env: { ...process.env, AE_BIN: bin, HARNESS_BIN: bin, AE_HOME: f.home, HARNESS_HOME: f.home, COPILOT_HOME: f.copilotHome, HARNESS_ENFORCEMENT: 'enforce' },
    timeout: 20000,
  });
  assert.equal(stopped.status, 0, stopped.stderr + stopped.stdout);
  assert.equal(JSON.parse(stopped.stdout.trim().split('\n').at(-1)).continue, true, stopped.stderr + stopped.stdout);
  assert.throws(() => completeWork({ workspace: f.workspace, plan: loadPlan(f.workspace, f.planPath, { home: f.home }), copilotHome: f.copilotHome }), /observed intent.*reconcil/i);
  assert.notEqual(f.invoke(['plan-update', '--plan', f.planPath, '--status', 'done']).status, 0);
});
