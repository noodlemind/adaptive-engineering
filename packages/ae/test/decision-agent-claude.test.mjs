import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareDecision, observeDecisionInvocation, recordDecision } from '../lib/decision-agent.mjs';

// Exact command-hook fields: https://code.claude.com/docs/en/hooks#subagentstop-input
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-claude-decision-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'state');
  fs.mkdirSync(workspace); fs.mkdirSync(home);
  const policy = { enabled: true, revision: 'consent-1', tools: ['read'] };
  const options = { workspace, home, policy };
  const prepared = prepareDecision({ ...options, input: { schema: 1, taskId: 'accepted-task', sessionId: 'claude-native-session', type: 'action', intent: 'Inspect accepted product source.', action: { tool: 'Read', input: { file_path: 'source.mjs' }, cwd: workspace } } });
  const judgment = { schema: 1, requestId: prepared.requestId, verdict: 'allow', reason: 'The selected read is within the task.', evidence: [] };
  const payload = { session_id: 'claude-native-session', transcript_path: '/not-read/main.jsonl', cwd: workspace, permission_mode: 'default', hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id: 'actual-claude-child', agent_type: 'decision-agent', agent_transcript_path: '/not-read/subagents/child.jsonl', last_assistant_message: JSON.stringify(judgment), background_tasks: [], session_crons: [] };
  return { ...options, payload, prepared };
}

test('documented Claude SubagentStop role is agent_type and does not require an invented stop_reason', t => {
  const f = fixture(t), observed = observeDecisionInvocation({ ...f, payload: f.payload });
  assert.equal(observed.observed, true, observed.reason);
  assert.equal(observed.invocationId, 'actual-claude-child');
  assert.equal(recordDecision({ ...f, input: { schema: 1, requestId: f.prepared.requestId } }).authorized, true);
});

test('Claude failed stops and conflicting identity aliases never authorize a decision', t => {
  const f = fixture(t);
  for (const payload of [{ ...f.payload, stop_reason: 'aborted' }, { ...f.payload, error: 'agent failed' }, { ...f.payload, agentType: 'engineer' }, { ...f.payload, agentId: 'another-child' }, { ...f.payload, sessionId: 'another-session' }, { ...f.payload, agent_type: '' }]) {
    assert.equal(observeDecisionInvocation({ ...f, payload }).observed, false);
  }
  assert.throws(() => recordDecision({ ...f, input: { schema: 1, requestId: f.prepared.requestId } }), /observed/i);
});
