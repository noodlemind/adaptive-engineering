import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { configureDiscovery, discoveryPolicy } from '../lib/capability-catalog.mjs';
import { decisionPolicyFromDiscovery, prepareDecision, recordDecision, inspectDecisionAction } from '../lib/decision-agent.mjs';
import { inspectHostIntent, validateObservedIntent, publishObservedIntent } from '../lib/host-intent.mjs';
import { nativeHookConfig } from '../lib/hosts/native-hook.mjs';
import { planContractText } from '../lib/work-contract.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = path.join(packageRoot, 'lib/hosts/native-hook.mjs');
const hash = text => createHash('sha256').update(text).digest('hex');

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-adaptive-intent-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), configHome = path.join(root, 'claude'), skillsHome = path.join(root, 'skills'), home = path.join(root, 'state');
  for (const directory of [workspace, configHome, skillsHome]) fs.mkdirSync(directory);
  const git = spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8', timeout: 15000 });
  assert.equal(git.status, 0, git.stderr || git.error?.message);
  fs.mkdirSync(path.join(workspace, '.github/harness'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.github/harness/policy.yaml'), 'version: 1\nenforcement: enforce\ngate_ttl_minutes: 30\n');
  fs.writeFileSync(path.join(workspace, 'example.txt'), 'original\n');
  const planPath = 'docs/plans/2026-11-07-adaptive-intent-plan.md';
  const plan = `---
plan_schema: 1
title: Adaptive host intent integration
type: fix
status: in-progress
plan_lock: true
phase: 1
risk: amber
intent: Preserve accepted product scope
expected_outputs: [example.txt]
success_criteria: [Scoped changes retain governance]
verification: {required: [behavior], criteria: {AC1: [behavior]}}
reviews: {required: [], completed: [], critical_open: []}
skills_used: [engineer]
capability_gaps: []
---
# Adaptive host intent integration
## Overview
Exercise the composition of the native judgment and plan ownership gates.
## Intent Contract
- Goal: Preserve accepted product scope.
## Acceptance Criteria
- [x] **AC1** Scoped changes retain governance.
## Plan
### Phase 1
- [x] Exercise the actual native bridge.
## Impacted Files
- \`example.txt\`
## Verification Plan
- Run the behavior check after the scoped edit.
## Risk & Review Routing
- Amber: preserve independent review and named proof prerequisites.
## Review Findings
- None.
## Activity
- Integration fixture.
`;
  fs.mkdirSync(path.dirname(path.join(workspace, planPath)), { recursive: true });
  fs.writeFileSync(path.join(workspace, planPath), plan);
  const sessionId = 'adaptive-intent-session';
  fs.mkdirSync(path.join(workspace, '.harness'));
  fs.writeFileSync(path.join(workspace, '.harness/session.json'), JSON.stringify({ version: 1, sessionId,
    activePlan: planPath, gatedPlan: planPath, gatedPlanDigest: hash(planContractText(plan)), gateStatus: 'pass',
    lastGateAt: new Date().toISOString(), gatedChecksDigest: null, gatedCheckCommands: [] }));
  const options = { workspace, home, copilotHome: configHome, skillsHome, host: 'claude-code' };
  configureDiscovery({ ...options, input: { schema: 1, roots: [{ path: configHome, included: true }],
    grants: { decision: true, tools: ['edit'], budgets: { maxDecisions: 10 } } } });
  const policy = decisionPolicyFromDiscovery(discoveryPolicy(options));
  const invoke = (event, payload = {}) => {
    const child = spawnSync(process.execPath, [bridge, '--host', 'claude-code', '--event', event,
      '--config-home', configHome, '--skills-home', skillsHome, '--ae-home', home], {
      cwd: configHome, input: JSON.stringify({ cwd: workspace, session_id: sessionId, ...payload }),
      env: { ...process.env, AE_HOME: home, HARNESS_HOME: home, HARNESS_NO_EVENTS: '1' }, encoding: 'utf8', timeout: 90000,
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    return JSON.parse(child.stdout);
  };
  let actions = 0;
  const approve = action => {
    const packet = prepareDecision({ ...options, policy, input: { schema: 1, taskId: `integration-action-${++actions}`,
      sessionId, type: 'action', intent: `Inspect exact scoped action ${actions}; independent lifecycle gates still apply.`, action } });
    const value = { schema: 1, requestId: packet.requestId, verdict: 'allow', reason: 'The action is within the supplied fixture scope.', evidence: [] };
    // This is deterministic native adapter evidence, not live model qualification.
    invoke('agent-stop', { hook_event_name: 'SubagentStop', agent_id: `decision-${packet.requestId}`, agent_type: 'decision-agent',
      last_assistant_message: JSON.stringify(value), stop_hook_active: false });
    assert.equal(recordDecision({ ...options, policy, input: { schema: 1, requestId: packet.requestId } }).authorized, true);
    assert.equal(inspectDecisionAction({ ...options, policy, sessionId, action }).authorized, true);
    return packet;
  };
  return { ...options, root, configHome, planPath, plan, sessionId, policy, invoke, approve };
}

test('native prompt and decision observations coexist while pending intent overrides an exact action allow', t => {
  const f = fixture(t);
  const hooks = nativeHookConfig({ host: 'claude-code', packageRoot, configHome: f.configHome, skillsHome: f.skillsHome, home: f.home }).value.hooks;
  assert.ok(hooks.UserPromptSubmit && hooks.SubagentStop, 'Both independently required native event routes must survive projection');
  f.invoke('prompt', { hook_event_name: 'UserPromptSubmit', prompt_id: 'request-1', prompt: 'Continue the scoped example change.' });
  const observed = inspectHostIntent({ workspace: f.workspace, sessionId: f.sessionId });
  assert.equal(observed.state, 'pending');
  const input = { file_path: path.join(f.workspace, 'example.txt'), content: 'changed\n' };
  const action = { tool: 'Write', input, cwd: f.workspace };
  f.approve(action);
  const blocked = f.invoke('pre', { tool_name: 'Write', tool_input: input });
  assert.equal(blocked.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(blocked));
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /unreconciled-host-intent/);
  assert.equal(inspectDecisionAction({ ...f, action }).authorized, false, 'The exact action verdict was consumed before the later host-intent gate refused');
  assert.equal(inspectHostIntent({ workspace: f.workspace, sessionId: f.sessionId }).state, 'pending', 'A model verdict cannot accept the host-observed turn');
  assert.equal(fs.readFileSync(input.file_path, 'utf8'), 'original\n');

  const options = { workspace: f.workspace, sessionId: f.sessionId, planPath: f.planPath };
  const acceptance = { action: 'progress', observedIntent: { id: observed.id, disposition: 'unchanged', rationale: 'The current accepted scope already covers this request.' } };
  const captured = validateObservedIntent({ ...options, input: acceptance });
  const revision = hash(f.plan);
  assert.equal(publishObservedIntent({ ...options, captured, input: acceptance, beforeRevision: revision, afterRevision: revision, operationId: 'reconcile-request-1' }), true);
  const contract = spawnSync(process.execPath, [path.join(packageRoot, 'bin/ae.mjs'), 'status', '--contract-digest', '--plan', f.planPath,
    '--workspace', f.workspace, '--ae-home', f.home, '--copilot-home', f.copilotHome, '--json'], { cwd: f.workspace,
    env: { ...process.env, AE_HOME: f.home, HARNESS_HOME: f.home }, encoding: 'utf8', timeout: 15000 });
  assert.equal(contract.status, 0, contract.stderr || contract.stdout);
  assert.equal(JSON.parse(contract.stdout).digest, hash(planContractText(f.plan)), contract.stdout);
  f.approve(action);
  const admitted = f.invoke('pre', { tool_name: 'Write', tool_input: input });
  assert.equal(admitted.hookSpecificOutput?.permissionDecision, 'allow', JSON.stringify(admitted));

  fs.writeFileSync(input.file_path, input.content);
  f.invoke('post', { tool_name: 'Write', tool_input: input, tool_response: { success: true }, success: true });
  const stop = f.invoke('stop');
  assert.equal(stop.decision, 'block', JSON.stringify(stop));
  assert.match(stop.reason, /verif|evidence|completion/i);
});

test('an observed native action allow cannot turn a managed-plan write into an ordinary product edit', t => {
  const f = fixture(t);
  const input = { file_path: path.join(f.workspace, f.planPath), content: `${f.plan}\nAn unowned plan edit.\n` };
  const action = { tool: 'Write', input, cwd: f.workspace };
  f.approve(action);
  const blocked = f.invoke('pre', { tool_name: 'Write', tool_input: input });
  assert.equal(blocked.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(blocked));
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /managed-plan-write/);
  assert.equal(fs.readFileSync(input.file_path, 'utf8'), f.plan);
});
