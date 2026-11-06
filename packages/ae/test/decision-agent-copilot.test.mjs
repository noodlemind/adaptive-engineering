import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { prepareDecision, observeDecisionInvocation, recordDecision, guardDecisionTool, decisionPolicyFromDiscovery } from '../lib/decision-agent.mjs';
import { configureDiscovery, discoveryPolicy, resolveCapability } from '../lib/capability-catalog.mjs';

// Published command-hook schemas: https://docs.github.com/en/copilot/reference/hooks-reference
// task(agent_type=...): https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/plugin-directories
const packageRoot = path.resolve(import.meta.dirname, '..');
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-copilot-decision-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'ae'), copilotHome = path.join(root, 'copilot');
  fs.mkdirSync(workspace); fs.mkdirSync(path.join(copilotHome, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'test.mjs'), 'console.log("test");\n');
  fs.writeFileSync(path.join(copilotHome, 'agents/decision-agent.agent.md'), '---\nname: decision-agent\ndescription: Bounded read-only decision role\ntools: [read]\nagents: []\n---\nJudge the supplied packet.\n');
  const options = { workspace, home, copilotHome };
  configureDiscovery({ ...options, input: { schema: 1, roots: [{ path: copilotHome, kind: 'config', included: true }], ongoing: true, grants: { decision: true, tools: ['execute'], budgets: { maxDecisions: 10 } } } });
  const policy = decisionPolicyFromDiscovery(discoveryPolicy(options));
  const input = { schema: 1, taskId: 'native-copilot', sessionId: 'session-copilot', type: 'action', intent: 'Run the accepted test.', action: { tool: 'Bash', input: { command: 'node test.mjs' }, cwd: workspace }, sources: ['test.mjs'] };
  const packet = prepareDecision({ ...options, policy, input });
  const judgment = { schema: 1, requestId: packet.requestId, verdict: 'allow', reason: 'The inspected test matches the accepted intent.', evidence: ['test.mjs'] };
  return { ...options, policy, input, packet, judgment };
}

test('documented Copilot camel task post output records an event identity without invented tool_call_id', t => {
  const f = fixture(t);
  const payload = { sessionId: 'session-copilot', timestamp: Date.now(), cwd: f.workspace, toolName: 'task', toolArgs: { agent_type: 'decision-agent', prompt: JSON.stringify(f.packet.packet) }, toolResult: { resultType: 'success', textResultForLlm: JSON.stringify(f.judgment) } };
  const observed = observeDecisionInvocation({ ...f, payload });
  assert.equal(observed.observed, true, observed.reason);
  assert.match(observed.invocationId, /^copilot-post-event:/);
  const receipt = recordDecision({ ...f, input: { schema: 1, requestId: f.packet.requestId } });
  assert.equal(receipt.authorized, true);
  assert.match(receipt.observationAssurance, /not.*authenticated/i);
});

test('documented Pascal task post output uses tool_result text_result_for_llm and actual session identity', t => {
  const f = fixture(t);
  const payload = { hook_event_name: 'PostToolUse', session_id: 'session-copilot', timestamp: new Date().toISOString(), cwd: f.workspace, tool_name: 'Agent', tool_input: { agent_type: 'decision-agent' }, tool_result: { result_type: 'success', text_result_for_llm: JSON.stringify(f.judgment) } };
  assert.equal(observeDecisionInvocation({ ...f, payload }).observed, true);
  assert.equal(recordDecision({ ...f, input: { schema: 1, requestId: f.packet.requestId } }).authorized, true);
});

test('documented Copilot SubagentStop uses full final response and actual child identity', t => {
  for (const camel of [true, false]) {
    const f = fixture(t);
    const payload = camel
      ? { sessionId: 'session-copilot', timestamp: Date.now(), cwd: f.workspace, transcriptPath: '/not-read-by-the-hook', agentId: 'actual-child-id', agentType: 'custom', agentName: 'decision-agent', response: JSON.stringify(f.judgment), stopReason: 'end_turn' }
      : { hook_event_name: 'SubagentStop', session_id: 'session-copilot', timestamp: new Date().toISOString(), cwd: f.workspace, transcript_path: '/not-read-by-the-hook', agent_id: 'actual-child-id', agent_type: 'custom', agent_name: 'decision-agent', last_assistant_message: JSON.stringify(f.judgment), stop_reason: 'end_turn' };
    const observed = observeDecisionInvocation({ ...f, payload });
    assert.equal(observed.observed, true, observed.reason);
    assert.equal(observed.invocationId, 'actual-child-id');
    assert.equal(recordDecision({ ...f, input: { schema: 1, requestId: f.packet.requestId } }).authorized, true);
  }
});

test('Copilot failed, clipped, conflicting, wrong-role and wrong-session envelopes never approve', t => {
  const f = fixture(t);
  const base = { sessionId: 'session-copilot', timestamp: Date.now(), cwd: f.workspace, toolName: 'task', toolArgs: { agent_type: 'decision-agent' }, toolResult: { resultType: 'success', textResultForLlm: JSON.stringify(f.judgment) } };
  for (const payload of [
    { ...base, toolResult: { ...base.toolResult, resultType: 'failure' } },
    { ...base, toolResult: { ...base.toolResult, result_type: 'failure' } },
    { ...base, toolResult: { ...base.toolResult, result_type: 'success', resultType: 'failure' } },
    { ...base, tool_use_id: 'conflicting-result-status', toolResult: { ...base.toolResult, result_type: 'success', resultType: 'failure' } },
    { ...base, truncated: true },
    { ...base, session_id: 'conflicting-session' },
    { ...base, tool_input: { agent_type: 'engineer' } },
    { ...base, toolArgs: { agent_type: 'engineer' } },
    { ...base, timestamp: undefined },
    { ...base, toolResult: { ...base.toolResult, text_result_for_llm: JSON.stringify({ ...f.judgment, verdict: 'deny' }) } },
    { ...base, tool_result: { result_type: 'success', text_result_for_llm: JSON.stringify({ ...f.judgment, verdict: 'deny' }) } },
  ]) assert.equal(observeDecisionInvocation({ ...f, payload }).observed, false);
  assert.throws(() => recordDecision({ ...f, input: { schema: 1, requestId: f.packet.requestId } }), /observed/);
});

test('camel task dispatch and native bash action use documented aliases without weakening authority', t => {
  const f = fixture(t), resolveAgent = id => resolveCapability({ ...f, kind: 'agent', id });
  const dispatch = { sessionId: 'session-copilot', timestamp: Date.now(), cwd: f.workspace, toolName: 'task', toolArgs: { agent_type: 'decision-agent' } };
  assert.equal(guardDecisionTool({ ...f, resolveAgent, payload: dispatch }).permissionDecision, undefined);
  assert.equal(guardDecisionTool({ ...f, resolveAgent, payload: { ...dispatch, toolArgs: { agent_type: 'unknown-agent' } } }).permissionDecision, 'deny');
  const payload = { ...dispatch, toolResult: { resultType: 'success', textResultForLlm: JSON.stringify(f.judgment) } };
  observeDecisionInvocation({ ...f, payload });
  recordDecision({ ...f, input: { schema: 1, requestId: f.packet.requestId } });
  const conflicting = { ...dispatch, toolName: 'bash', toolArgs: { command: 'node unrelated.mjs' }, tool_input: { command: 'node test.mjs' } };
  assert.equal(guardDecisionTool({ ...f, payload: conflicting }).permissionDecision, 'deny');
  assert.equal(guardDecisionTool({ ...f, payload: { ...dispatch, toolName: 'bash', toolArgs: { command: 'node test.mjs' } } }).permissionDecision, 'allow');
});

test('hydrated SubagentStop observer resolves installed authority and records documented output', t => {
  const f = fixture(t);
  const source = path.join(packageRoot, 'corpus/hooks'), hydrated = path.join(f.copilotHome, 'hooks');
  fs.cpSync(source, hydrated, { recursive: true });
  const payload = { hook_event_name: 'SubagentStop', session_id: 'session-copilot', timestamp: new Date().toISOString(), cwd: f.workspace, transcript_path: '/not-read-by-the-hook', agent_id: 'hydrated-child', agent_type: 'custom', agent_name: 'decision-agent', last_assistant_message: JSON.stringify(f.judgment), stop_reason: 'end_turn' };
  const bin = path.join(packageRoot, 'bin/ae.mjs');
  const env = { ...process.env, AE_HOME: f.home, HARNESS_HOME: f.home, AE_BIN: bin, HARNESS_BIN: bin, COPILOT_HOME: f.copilotHome };
  delete env.AE_SKILLS_HOME; delete env.HARNESS_SKILLS_HOME;
  const result = spawnSync(process.execPath, [path.join(hydrated, 'observe-decision.mjs')], { cwd: f.workspace, env, input: JSON.stringify(payload), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).observed, true);
  assert.equal(recordDecision({ ...f, input: { schema: 1, requestId: f.packet.requestId } }).authorized, true);
});
