import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareDecision, observeDecisionInvocation, recordDecision, inspectDecisionAction, decisionStatus } from '../lib/decision-agent.mjs';

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-decision-archive-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'state');
  fs.mkdirSync(workspace); fs.mkdirSync(home);
  fs.writeFileSync(path.join(workspace, 'test.mjs'), 'console.log("test");\n');
  const policy = { enabled: true, revision: 'consent-1', tools: ['execute'], budgets: { maxDecisions: 1, maxRepairs: 1, maxAcquisitions: 1, maxSeconds: 60 } };
  const action = { tool: 'Bash', input: { command: 'node test.mjs' }, cwd: workspace };
  return { workspace, home, policy, action };
}
function prepare(f, index) {
  const input = { schema: 1, taskId: `task-${index}`, sessionId: `session-${index}`, type: 'action', intent: 'Run the selected behavior check.', action: f.action, sources: ['test.mjs'], context: { inspectedEvidence: 'x'.repeat(30000) } };
  return { input, prepared: prepareDecision({ ...f, input, now: 1000 }) };
}
function consume(f, item) {
  const { input, prepared } = item;
  const judgment = { schema: 1, requestId: prepared.requestId, verdict: 'allow', reason: 'The source-bound check matches the current task.', evidence: ['test.mjs'] };
  assert.equal(observeDecisionInvocation({ ...f, now: 1001, payload: { cwd: f.workspace, session_id: input.sessionId, tool_name: 'Agent', tool_input: { subagent_type: 'decision-agent' }, tool_use_id: `call-${input.sessionId}`, tool_response: judgment, success: true } }).observed, true);
  const receipt = recordDecision({ ...f, now: 1002, input: { schema: 1, requestId: prepared.requestId } });
  assert.equal(inspectDecisionAction({ ...f, now: 1003, sessionId: input.sessionId, action: f.action, consume: true }).authorized, true);
  return receipt;
}

test('retired decision contexts archive before workspace capacity fills while session budgets and receipts remain durable', t => {
  const f = fixture(t), first = prepare(f, 0), firstReceipt = consume(f, first);
  for (let index = 1; index < 80; index++) consume(f, prepare(f, index));
  assert.ok(fs.statSync(first.prepared.storePath).size < 2 * 1024 * 1024);
  const archive = path.join(f.home, 'decision-archives', path.basename(first.prepared.storePath, '.json'), 'requests', `${first.prepared.requestId}.json`);
  assert.ok(fs.existsSync(archive), 'terminal request evidence is retained separately');
  const replayed = recordDecision({ ...f, now: 1004, input: { schema: 1, requestId: first.prepared.requestId } });
  assert.equal(replayed.id, firstReceipt.id);
  assert.equal(replayed.consumedAt, 1003);
  assert.equal(inspectDecisionAction({ ...f, now: 1004, sessionId: first.input.sessionId, action: f.action }).authorized, false);
  assert.equal(prepareDecision({ ...f, now: 1004, input: first.input }).requestId, first.prepared.requestId);
  assert.equal(decisionStatus({ ...f, now: 1004, requestId: first.prepared.requestId }).counts.decisions, 1);
  assert.throws(() => prepareDecision({ ...f, now: 1004, input: { ...first.input, taskId: 'renamed', intent: 'Attempt to reset an archived budget.' } }), /budget/i);
  consume(f, prepare(f, 80));
  fs.writeFileSync(archive, '{"schema":1,"approved":true}\n');
  assert.throws(() => decisionStatus({ ...f, now: 1004, requestId: first.prepared.requestId }), /archive|integrity|binding/i);
});

test('expired unrecorded contexts retire without renewing the original task time budget', t => {
  const f = fixture(t);
  f.policy.budgets.maxSeconds = 1;
  let first;
  for (let index = 0; index < 80; index++) {
    const input = { schema: 1, taskId: `task-${index}`, sessionId: `session-${index}`, type: 'action', intent: 'Run the selected check.', action: f.action, context: { evidence: 'x'.repeat(30000) } };
    const item = prepareDecision({ ...f, now: 1000 + index * 2000, input });
    first ||= { input, prepared: item };
  }
  assert.throws(() => prepareDecision({ ...f, now: 200000, input: first.input }), /time|expired/i);
  assert.equal(decisionStatus({ ...f, now: 200000, requestId: first.prepared.requestId }).current, false);
});

// Isolated review of PR #127 at 38f4e745.

test('a late observation or child spawn for an archived, expired request is refused and leaves no archive fault', t => {
  const f = fixture(t), short = { ...f, policy: { ...f.policy, budgets: { ...f.policy.budgets, maxSeconds: 1 } } };
  let first;
  for (let index = 0; index < 80; index++) {
    const input = { schema: 1, taskId: `task-${index}`, sessionId: `session-${index}`, type: 'action', intent: 'Run the selected behavior check.', action: f.action, sources: ['test.mjs'], context: { inspectedEvidence: 'x'.repeat(30000) } };
    const prepared = prepareDecision({ ...short, input, now: 1000 + index * 2000 });
    first ||= { input, prepared };
  }
  const stored = () => JSON.parse(fs.readFileSync(first.prepared.storePath, 'utf8'));
  assert.equal(Object.hasOwn(stored().requests, first.prepared.requestId), false, 'the expired request was archived');
  const judgment = { schema: 1, requestId: first.prepared.requestId, verdict: 'allow', reason: 'A late judgment.', evidence: ['test.mjs'] };
  const late = observeDecisionInvocation({ ...short, now: 200000, payload: { cwd: f.workspace, session_id: first.input.sessionId, tool_name: 'Agent', tool_input: { subagent_type: 'decision-agent' }, tool_use_id: 'call-late', tool_response: judgment, success: true } });
  assert.equal(late.observed, false);
  const spawn = observeDecisionInvocation({ ...short, now: 200001, payload: { cwd: f.workspace, session_id: first.input.sessionId, tool_name: 'think', ae_native_tool_name: 'spawn_agent', tool_use_id: 'spawn-late', tool_input: { agent_type: 'decision-agent', message: JSON.stringify(first.prepared.packet) }, tool_response: { agent_id: 'child-late' }, success: true } });
  assert.equal(spawn.observed, false);
  assert.equal(spawn.pending, undefined, 'no child invocation is bound');
  const after = stored();
  assert.equal(Object.hasOwn(after.requests, first.prepared.requestId), false, 'the request stays archived');
  assert.equal(after.archiveFaults, undefined);
  assert.equal(decisionStatus({ ...short, now: 200002, requestId: first.prepared.requestId }).warnings, undefined);
});

test('a task record that cannot be used: status reports it and uses the live task; prepare and record refuse naming the file', t => {
  for (const kind of ['directory', 'newer schema', 'empty without a live copy']) {
    const f = fixture(t);
    const input = { schema: 1, taskId: 't', sessionId: 's', type: 'action', intent: 'Run the selected behavior check.', action: f.action, sources: ['test.mjs'] };
    const prepared = prepareDecision({ ...f, now: 1000, input });
    const key = prepared.packet.budgetKey, archive = path.join(f.home, 'decision-archives', path.basename(prepared.storePath, '.json'));
    const file = path.join(archive, 'tasks', `${key}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (kind === 'directory') fs.mkdirSync(file);
    else if (kind === 'newer schema') fs.writeFileSync(file, '{"schema":2}');
    else {
      fs.writeFileSync(file, '');
      const state = JSON.parse(fs.readFileSync(prepared.storePath, 'utf8'));
      delete state.tasks[key];
      fs.writeFileSync(prepared.storePath, JSON.stringify(state));
    }
    const reason = { directory: 'not-regular', 'newer schema': 'unknown-schema', 'empty without a live copy': 'invalid-task' }[kind];
    const status = decisionStatus({ ...f, now: 1001, requestId: prepared.requestId });
    const warning = status.warnings?.find(item => item.fault === 'archive');
    assert.deepEqual(warning?.offenders, [{ file: `tasks/${key}.json`, reason }], `${kind}: status names the task record`);
    if (kind !== 'empty without a live copy') assert.equal(status.status, 'current', `${kind}: the live task is used`);
    const refusal = error => error.message.includes(file) && /cannot be used, so the budget cannot be verified/.test(error.message)
      && (kind !== 'empty without a live copy' || /delete it, which resets that task's budget/.test(error.message));
    assert.throws(() => prepareDecision({ ...f, now: 1002, input: { ...input, intent: 'Run it again.' } }), refusal, `${kind}: prepare refuses`);
    assert.throws(() => recordDecision({ ...f, now: 1003, input: { schema: 1, requestId: prepared.requestId } }), refusal, `${kind}: record refuses`);
  }
});

test('record on a request archived without a receipt refuses: archived evidence is read-only, even under a raised budget', t => {
  const f = fixture(t), budgets = seconds => ({ ...f, policy: { ...f.policy, budgets: { ...f.policy.budgets, maxDecisions: 2, maxSeconds: seconds } } });
  const input = { schema: 1, taskId: 't0', sessionId: 's0', type: 'action', intent: 'Run the selected behavior check.', action: f.action, sources: ['test.mjs'] };
  const prepared = prepareDecision({ ...budgets(1), now: 1000, input });
  const judgment = { schema: 1, requestId: prepared.requestId, verdict: 'allow', reason: 'ok', evidence: ['test.mjs'] };
  assert.equal(observeDecisionInvocation({ ...budgets(1), now: 1500, payload: { cwd: f.workspace, session_id: 's0', tool_name: 'Agent', tool_input: { subagent_type: 'decision-agent' }, tool_use_id: 'c1', tool_response: judgment, success: true } }).observed, true);
  for (let index = 0; index < 25; index++) prepareDecision({ ...budgets(86400), now: 5000 + index, input: { ...input, taskId: `b${index}`, sessionId: `bs${index}`, context: { evidence: 'x'.repeat(30000) } } });
  const stored = () => JSON.parse(fs.readFileSync(prepared.storePath, 'utf8'));
  assert.equal(Object.hasOwn(stored().requests, prepared.requestId), false, 'the expired request was archived');
  assert.throws(() => recordDecision({ ...budgets(86400), now: 6000, input: { schema: 1, requestId: prepared.requestId } }), /archived without a receipt, and archived evidence is read-only/);
  assert.equal(Object.hasOwn(stored().requests, prepared.requestId), false);
  assert.equal(stored().archiveFaults, undefined);
  assert.equal(decisionStatus({ ...budgets(86400), now: 6001, requestId: prepared.requestId }).receipt, null);
  assert.equal(inspectDecisionAction({ ...budgets(86400), now: 6002, sessionId: 's0', action: f.action, consume: true }).authorized, false);
});

test('a regular file or a symlink to one at requests makes prepare and record refuse with the remedy, not a raw lookup error', t => {
  for (const kind of ['file', 'symlink to a file']) {
    const f = fixture(t);
    const input = { schema: 1, taskId: 't', sessionId: 's', type: 'action', intent: 'Run the selected behavior check.', action: f.action, sources: ['test.mjs'] };
    const prepared = prepareDecision({ ...f, now: 1000, input });
    const archive = path.join(f.home, 'decision-archives', path.basename(prepared.storePath, '.json'));
    fs.mkdirSync(archive, { recursive: true });
    if (kind === 'file') fs.writeFileSync(path.join(archive, 'requests'), 'x');
    else { const target = path.join(path.dirname(f.home), 'plain'); fs.writeFileSync(target, 'x'); fs.symlinkSync(target, path.join(archive, 'requests')); }
    const refusal = /the archived request record .* cannot be read .*a regular file or another non-directory stands where a directory on the record's path belongs: move it out of the way/;
    assert.throws(() => prepareDecision({ ...f, now: 1001, input: { ...input, intent: 'Run it again.' } }), refusal, `${kind}: prepare`);
    assert.throws(() => recordDecision({ ...f, now: 1002, input: { schema: 1, requestId: 'a'.repeat(64) } }), refusal, `${kind}: record`);
  }
});
