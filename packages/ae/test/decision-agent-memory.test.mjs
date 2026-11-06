import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { prepareDecision, observeDecisionInvocation, recordDecision, inspectMemoryDecision } from '../lib/decision-agent.mjs';

const digest = value => `sha256-${createHash('sha256').update(value).digest('hex')}`;
function fixture(t, policyChanges = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-memory-decision-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'state');
  fs.mkdirSync(workspace); fs.mkdirSync(home);
  fs.writeFileSync(path.join(workspace, 'source.mjs'), 'const currency = "minor units";\n');
  const memoryContent = 'Currency uses integer minor units.\n';
  const memory = { operation: 'publish', kind: 'insight', scope: 'private', destination: path.join(home, 'projects/fixture/solutions/2026-11-06-currency.md'), contentDigest: digest(memoryContent), proofIdentity: null };
  const policy = { enabled: true, revision: 'consent-1', tools: [], memory: true, budgets: { maxDecisions: 4, maxSeconds: 60 }, ...policyChanges };
  const input = { schema: 1, taskId: 'currency-learning', sessionId: 'native-session', type: 'memory', intent: 'Retain the verified coding convention privately.', memory, context: { memoryContent }, sources: ['source.mjs'] };
  return { workspace, home, policy, memory, input };
}
function authorize(f, now) {
  const prepared = prepareDecision({ ...f, ...(now === undefined ? {} : { now }) });
  const judgment = { schema: 1, requestId: prepared.requestId, verdict: 'allow', reason: 'The selected private memory matches the task evidence.', evidence: ['source.mjs'] };
  const observed = observeDecisionInvocation({ ...f, ...(now === undefined ? {} : { now: now + 1 }), payload: { cwd: f.workspace, session_id: 'native-session', tool_name: 'Agent', tool_use_id: prepared.requestId, tool_input: { subagent_type: 'decision-agent' }, tool_response: judgment, success: true } });
  assert.equal(observed.observed, true, observed.reason);
  return { prepared, receipt: recordDecision({ ...f, ...(now === undefined ? {} : { now: now + 2 }), input: { schema: 1, requestId: prepared.requestId } }) };
}

test('memory publication requires a complete exact destination and serialized content binding', t => {
  const f = fixture(t);
  assert.throws(() => prepareDecision({ ...f, input: { ...f.input, memory: undefined } }), /memory/i);
  assert.throws(() => prepareDecision({ ...f, input: { ...f.input, context: { memoryContent: 'Benign description of different bytes.' } } }), /memory.*content|content.*memory/i);
  assert.throws(() => prepareDecision({ ...f, input: { ...f.input, context: {} } }), /memory.*content|content.*memory/i);
  for (const memory of [{ ...f.memory, destination: '../outside' }, { ...f.memory, contentDigest: 'claimed-safe' }, { ...f.memory, approved: true }, { ...f.memory, proofIdentity: 'claimed-proof' }]) {
    assert.throws(() => prepareDecision({ ...f, input: { ...f.input, memory } }), /memory|destination|digest|proof|unsupported/i);
  }
});

test('observed memory receipt matches exact bytes, destination, scope, proof and session and consumes once', t => {
  const f = fixture(t);
  assert.equal(authorize(f).receipt.authorized, true);
  for (const memory of [{ ...f.memory, contentDigest: digest('Changed preference.') }, { ...f.memory, destination: path.join(f.home, 'other.md') }, { ...f.memory, scope: 'global' }, { ...f.memory, proofIdentity: 'a'.repeat(64) }]) {
    assert.equal(inspectMemoryDecision({ ...f, sessionId: 'native-session', memory }).authorized, false);
  }
  assert.equal(inspectMemoryDecision({ ...f, sessionId: 'other-session', memory: f.memory }).authorized, false);
  assert.equal(inspectMemoryDecision({ ...f, sessionId: 'native-session', memory: f.memory, consume: true }).authorized, true);
  assert.equal(inspectMemoryDecision({ ...f, sessionId: 'native-session', memory: f.memory, consume: true }).authorized, false);
});

test('memory recommendations cannot broaden absent memory grants or private publication scope', t => {
  for (const changes of [{ policy: { memory: false } }, { memory: { scope: 'global' } }, { memory: { scope: 'ship-set-proposal' } }]) {
    const f = fixture(t, changes.policy);
    if (changes.memory) f.input = { ...f.input, memory: { ...f.memory, ...changes.memory } };
    const { receipt } = authorize(f);
    assert.equal(receipt.authorized, false);
    assert.equal(receipt.verdict, 'escalate');
  }
});

test('changed memory target, sources, consent or task timeout invalidates publication authority', t => {
  const f = fixture(t);
  authorize(f, 1000);
  assert.equal(inspectMemoryDecision({ ...f, now: 1003, sessionId: 'native-session', memory: f.memory }).authorized, true);
  assert.equal(inspectMemoryDecision({ ...f, now: 62000, sessionId: 'native-session', memory: f.memory }).authorized, false);
  assert.equal(inspectMemoryDecision({ ...f, now: 1003, policy: { ...f.policy, revision: 'revoked-2' }, sessionId: 'native-session', memory: f.memory }).authorized, false);
  fs.mkdirSync(path.dirname(f.memory.destination), { recursive: true });
  fs.writeFileSync(f.memory.destination, 'Concurrent external publication.\n');
  assert.equal(inspectMemoryDecision({ ...f, now: 1003, sessionId: 'native-session', memory: f.memory }).authorized, false);
  fs.unlinkSync(f.memory.destination);
  fs.appendFileSync(path.join(f.workspace, 'source.mjs'), 'Changed source.\n');
  assert.equal(inspectMemoryDecision({ ...f, now: 1003, sessionId: 'native-session', memory: f.memory }).authorized, false);
});

test('memory receipt replay and changed task labels cannot renew a native session budget', t => {
  const f = fixture(t, { budgets: { maxDecisions: 1, maxSeconds: 60 } });
  const { prepared, receipt } = authorize(f);
  assert.equal(recordDecision({ ...f, input: { schema: 1, requestId: prepared.requestId } }).id, receipt.id);
  assert.throws(() => prepareDecision({ ...f, input: { ...f.input, taskId: 'renamed', context: { memoryContent: 'A second inference.' }, memory: { ...f.memory, contentDigest: digest('A second inference.') } } }), /budget/i);
});
