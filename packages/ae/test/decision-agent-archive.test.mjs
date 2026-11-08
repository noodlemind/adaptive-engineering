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
