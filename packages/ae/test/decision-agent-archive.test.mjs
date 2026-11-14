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
  // A tampered record is never trusted: status reports it, record refuses with the file and the remedy.
  const tampered = decisionStatus({ ...f, now: 1004, requestId: first.prepared.requestId });
  assert.equal(tampered.status, 'missing');
  assert.deepEqual(tampered.warnings.find(item => item.fault === 'archive').offenders, [{ file: `requests/${first.prepared.requestId}.json`, reason: 'invalid-record' }]);
  assert.throws(() => recordDecision({ ...f, now: 1004, input: { schema: 1, requestId: first.prepared.requestId } }), /integrity|binding/i);
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
    const refusal = /the archived request record .* cannot be used .*a regular file or another non-directory stands where a directory on the record's path belongs: move it out of the way/;
    assert.throws(() => prepareDecision({ ...f, now: 1001, input: { ...input, intent: 'Run it again.' } }), refusal, `${kind}: prepare`);
    assert.throws(() => recordDecision({ ...f, now: 1002, input: { schema: 1, requestId: 'a'.repeat(64) } }), refusal, `${kind}: record`);
  }
});

// Isolated review of PR #127 at 1c2bde4a.

function archivedFirst(t, maxDecisions = 1) {
  const f = fixture(t);
  f.policy.budgets.maxDecisions = maxDecisions;
  const first = prepare(f, 0);
  consume(f, first);
  for (let index = 1; index < 40; index++) consume(f, prepare(f, index));
  const record = path.join(f.home, 'decision-archives', path.basename(first.prepared.storePath, '.json'), 'requests', `${first.prepared.requestId}.json`);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(first.prepared.storePath, 'utf8')).requests, first.prepared.requestId), false, 'the request was archived');
  return { f, first, record };
}

test('an archived request record left empty, truncated or as a symlink is reported by status and refused by record and prepare with the file and the remedy', t => {
  for (const kind of ['empty', 'truncated', 'symlink']) {
    const { f, first, record } = archivedFirst(t, 2);
    const kept = `${record}.kept`;
    fs.renameSync(record, kept);
    if (kind === 'symlink') fs.symlinkSync(kept, record);
    else fs.writeFileSync(record, kind === 'empty' ? '' : '{"schema":1,"trunc');
    const status = decisionStatus({ ...f, now: 1004, requestId: first.prepared.requestId });
    assert.equal(status.status, 'missing', kind);
    assert.deepEqual(status.warnings.find(item => item.fault === 'archive').offenders, [{ file: `requests/${first.prepared.requestId}.json`, reason: 'invalid-record' }], kind);
    const refusal = error => error.message.includes(record) && /restore it from a backup, or move it out of the archive/.test(error.message);
    assert.throws(() => recordDecision({ ...f, now: 1004, input: { schema: 1, requestId: first.prepared.requestId } }), refusal, `${kind}: record`);
    assert.throws(() => prepareDecision({ ...f, now: 1004, input: first.input }), refusal, `${kind}: prepare`);
    // What the remedy says happens after moving it out: unknown to status and record; the same input starts fresh.
    fs.rmSync(record);
    const moved = decisionStatus({ ...f, now: 1005, requestId: first.prepared.requestId });
    assert.equal(moved.status, 'missing');
    assert.equal(moved.warnings, undefined);
    assert.throws(() => recordDecision({ ...f, now: 1005, input: { schema: 1, requestId: first.prepared.requestId } }), /unknown decision request/);
    const fresh = prepareDecision({ ...f, now: 1006, input: first.input });
    assert.equal(fresh.requestId, first.prepared.requestId);
    assert.equal(decisionStatus({ ...f, now: 1007, requestId: fresh.requestId }).counts.decisions, 2, 'it counts against the task\'s remaining budget');
  }
});

test('a symlinked requests directory is named as redirected by status and by record', t => {
  const { f, first, record } = archivedFirst(t);
  const directory = path.dirname(record), moved = path.join(path.dirname(f.home), 'moved');
  fs.renameSync(directory, moved);
  fs.symlinkSync(moved, directory);
  const status = decisionStatus({ ...f, now: 1004, requestId: first.prepared.requestId });
  assert.deepEqual(status.warnings.find(item => item.fault === 'archive').offenders, [{ file: `requests/${first.prepared.requestId}.json`, reason: 'redirected' }]);
  assert.throws(() => recordDecision({ ...f, now: 1004, input: { schema: 1, requestId: first.prepared.requestId } }), /replace it with a real directory/);
});

test('a repeated prepare and a record replay of an archived request leave no orphan task in live state', t => {
  const { f, first } = archivedFirst(t);
  const key = first.prepared.packet.budgetKey, tasks = () => JSON.parse(fs.readFileSync(first.prepared.storePath, 'utf8')).tasks;
  assert.equal(Object.hasOwn(tasks(), key), false);
  prepareDecision({ ...f, now: 1004, input: first.input });
  recordDecision({ ...f, now: 1005, input: { schema: 1, requestId: first.prepared.requestId } });
  assert.equal(Object.hasOwn(tasks(), key), false, 'the archived task budget does not come back');
  assert.equal(decisionStatus({ ...f, now: 1006, requestId: first.prepared.requestId }).counts.decisions, 1, 'and still counts from its retained record');
});

// Copilot review of PR #130: finding judgments retire once recorded, and the finding counter survives archive reconciliation.
test('recorded finding judgments retire from live state and the finding budget survives archive reconciliation', async t => {
  const { findingVerification, MAX_FINDING_DECISIONS } = await import('../lib/decision-agent.mjs');
  const f = fixture(t);
  const policy = { ...f.policy, types: ['finding'], budgets: { ...f.policy.budgets, maxDecisions: 1 } };
  const finding = index => ({ packet: 'a'.repeat(64), id: index.toString(16).padStart(64, '0'), file: 'test.mjs', line: 1, severity: 'P2', title: `Finding ${index}` });
  const input = index => ({ schema: 1, taskId: 'verify', sessionId: 'session-v', type: 'finding', intent: 'Verify one review finding against the code.', finding: finding(index), context: { inspectedEvidence: 'x'.repeat(30000) } });
  let first;
  for (let index = 0; index < MAX_FINDING_DECISIONS; index++) {
    const prepared = prepareDecision({ ...f, policy, now: 1000, input: input(index) });
    first ||= prepared;
    const judgment = { schema: 1, requestId: prepared.requestId, verdict: index % 2 ? 'deny' : 'allow', reason: 'Checked against the code.', evidence: ['test.mjs:1'] };
    assert.equal(observeDecisionInvocation({ ...f, policy, now: 1001, payload: { cwd: f.workspace, session_id: 'session-v', tool_name: 'Agent', tool_input: { subagent_type: 'decision-agent' }, tool_use_id: `call-${index}`, tool_response: judgment, success: true } }).observed, true);
    recordDecision({ ...f, policy, now: 1002, input: { schema: 1, requestId: prepared.requestId } });
  }
  assert.ok(fs.statSync(first.storePath).size < 1024 * 1024, 'confirmed finding receipts do not stay live until the task expires');
  const archive = path.join(f.home, 'decision-archives', path.basename(first.storePath, '.json'), 'requests', `${first.requestId}.json`);
  assert.ok(fs.existsSync(archive), 'a recorded finding judgment is archived');
  assert.equal(findingVerification({ ...f, requestId: first.requestId }).verdict, 'allow', 'exact-ID lookup still reads an archived judgment');
  assert.throws(() => prepareDecision({ ...f, policy, now: 1003, input: input(MAX_FINDING_DECISIONS) }), /finding verification budget exhausted/);
  assert.equal(decisionStatus({ ...f, policy, now: 1003, requestId: first.requestId }).counts.findings, MAX_FINDING_DECISIONS);
});

test('a live finding counter merged with a retained task budget keeps the greater count', async t => {
  const { decisionTask } = await import('../lib/decision-archive.mjs');
  const { createHash } = await import('node:crypto');
  const f = fixture(t);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const stable = value => JSON.stringify(value, (_, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  const hash = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
  const key = 'e'.repeat(64), loc = { home: f.home, workspace: f.workspace };
  const retain = task => {
    const dir = path.join(f.home, 'decision-archives', hash(f.workspace), 'tasks');
    fs.mkdirSync(dir, { recursive: true });
    const value = { schema: 1, workspace: f.workspace, budgetKey: key, task };
    fs.writeFileSync(path.join(dir, `${key}.json`), `${stable({ ...value, id: hash(value) })}\n`);
  };
  retain({ startedAt: 1000, counts: { decisions: 0, repairs: 0, acquisitions: 0, findings: 64 } });
  const live = { tasks: { [key]: { startedAt: 1500, counts: { decisions: 0, repairs: 0, acquisitions: 0, findings: 1 } } } };
  assert.equal(decisionTask(loc, live, key).counts.findings, 64, 'the retained finding count is never dropped');
  const legacy = { tasks: { [key]: { startedAt: 1500, counts: { decisions: 2, repairs: 0, acquisitions: 0 } } } };
  assert.deepEqual(decisionTask(loc, legacy, key).counts, { decisions: 2, repairs: 0, acquisitions: 0, findings: 64 }, 'a legacy live task counts findings as zero');
  retain({ startedAt: 1000, counts: { decisions: 3, repairs: 0, acquisitions: 0 } });
  assert.deepEqual(decisionTask(loc, { tasks: { [key]: { startedAt: 1500, counts: { decisions: 1, repairs: 0, acquisitions: 0 } } } }, key).counts, { decisions: 3, repairs: 0, acquisitions: 0 }, 'records without the counter keep their shape');
});
