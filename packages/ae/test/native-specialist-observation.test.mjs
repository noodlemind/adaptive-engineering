import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { test } from 'node:test';
import { observeNativeSpecialist, verifyNativeInvocationObservation, validateReviewObservation } from '../lib/native-specialist-observation.mjs';
import { prepareDecision, observeDecisionInvocation, recordDecision, guardDecisionTool, decisionPolicyFromDiscovery } from '../lib/decision-agent.mjs';
import { configureDiscovery, discoveryPolicy, resolveCapability } from '../lib/capability-catalog.mjs';
import { runHostSetup } from '../lib/hosts/setup.mjs';
import { createHostResource } from '../lib/hosts/personal-resource.mjs';

const hash = text => `sha256-${createHash('sha256').update(text).digest('hex')}`;
const packageRoot = path.resolve(import.meta.dirname, '..');
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-native-observation-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'state'), resourcePath = path.join(root, 'copilot/agents/personal-reviewer.md');
  fs.mkdirSync(workspace); fs.mkdirSync(home); fs.mkdirSync(path.dirname(resourcePath), { recursive: true }); fs.writeFileSync(resourcePath, 'Read-only reviewer.\n');
  const resource = { id: 'personal-reviewer', path: resourcePath, digest: hash('Read-only reviewer.\n'), sourceDigest: hash('Canonical reviewer.'), included: true, current: true, activation: 'pending-reload', host: 'claude-code', tools: ['read'], agents: [] };
  const action = { tool: 'Agent', input: { subagent_type: 'personal-reviewer', prompt: 'Review accepted task.' }, cwd: workspace };
  const probe = { authorized: true, requestId: 'a'.repeat(64), receiptId: 'b'.repeat(64), sessionId: 'session-1', role: resource.id, policyRevision: 'consent-1', consumedAt: 10, action, resource: { id: resource.id, path: resource.path, digest: resource.digest, sourceDigest: resource.sourceDigest } };
  let current = true;
  const calls = [];
  const options = { workspace, home, copilotHome: path.join(root, 'copilot'), skillsHome: path.join(root, 'skills'), policy: { enabled: true, revision: 'consent-1' }, now: 20,
    resolveAgent: id => id === resource.id && current ? resource : null,
    inspectProbe: query => current && query.sessionId === probe.sessionId && query.role === probe.role && (!query.action || isDeepStrictEqual(query.action, action)) ? probe : { authorized: false },
    activate: args => { calls.push(args); return { activated: true, activation: { state: 'available' } }; } };
  const payload = { cwd: workspace, session_id: 'session-1', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'call-1', tool_input: action.input, tool_response: { content: [{ type: 'text', text: 'No defects found.' }] }, success: true };
  return { options, payload, resource, probe, calls, revoke: () => { current = false; } };
}

test('successful native specialist completion requires a consumed exact pending probe and persists adapter evidence', async t => {
  const f = fixture(t);
  const result = await observeNativeSpecialist({ ...f.options, payload: f.payload });
  assert.equal(result.observed, true, result.reason);
  assert.equal(result.activated, true);
  assert.equal(f.calls.length, 1);
  const retained = verifyNativeInvocationObservation({ ...f.options, observationId: result.observationId, resource: f.resource });
  assert.equal(retained.requestId, f.probe.requestId);
  assert.equal(retained.toolUseId, 'call-1');
  assert.match(retained.assurance, /not.*authenticated/i);
  assert.equal(retained.loadedSourceHash, 'unverified');
  assert.equal(f.calls[0].validateObservation(f.resource).id, retained.id);
  f.revoke();
  assert.throws(() => verifyNativeInvocationObservation({ ...f.options, observationId: result.observationId, resource: f.resource }), /current|probe|resource/i);
});

test('missing probe, wrong args/session/role, failures and conflicting native aliases never activate', async t => {
  const f = fixture(t);
  for (const payload of [{ ...f.payload, success: false }, { ...f.payload, truncated: true }, { ...f.payload, tool_input: { ...f.payload.tool_input, prompt: 'Different request.' } }, { ...f.payload, session_id: 'other-session' }, { ...f.payload, tool_input: { subagent_type: 'unapproved-role' } }, { ...f.payload, sessionId: 'conflicting' }, { ...f.payload, toolArgs: { subagent_type: 'unapproved-role' } }, { ...f.payload, tool_response: { is_error: true, content: 'failed' } }]) {
    assert.equal((await observeNativeSpecialist({ ...f.options, payload })).observed, false);
  }
  assert.equal((await observeNativeSpecialist({ ...f.options, inspectProbe: () => ({ authorized: false }), payload: f.payload })).observed, false);
  assert.equal(f.calls.length, 0);
});

test('documented Copilot task output uses actual event fields and a labeled event digest without a call ID', async t => {
  const f = fixture(t), input = { agent_type: f.resource.id, prompt: 'Review accepted task.' };
  const probe = { ...f.probe, action: { ...f.probe.action, input } };
  const result = await observeNativeSpecialist({ ...f.options, inspectProbe: query => query.sessionId === 'session-1' && query.role === f.resource.id ? probe : { authorized: false }, payload: { sessionId: 'session-1', timestamp: 30, cwd: f.options.workspace, toolName: 'task', toolArgs: input, toolResult: { resultType: 'success', textResultForLlm: 'No defects found.' } } });
  assert.equal(result.observed, true, result.reason);
  const retained = verifyNativeInvocationObservation({ ...f.options, inspectProbe: () => probe, observationId: result.observationId, resource: f.resource });
  assert.match(retained.toolUseId, /^copilot-post-event:/);
});

test('documented SubagentStop can correlate only the single current pending role/session probe', async t => {
  for (const claude of [false, true]) {
    const f = fixture(t);
    const payload = { hook_event_name: 'SubagentStop', session_id: 'session-1', cwd: f.options.workspace, agent_id: 'actual-child', last_assistant_message: 'No defects found.', ...(claude ? { agent_type: f.resource.id, stop_hook_active: false, agent_transcript_path: '/not-read/subagents/child.jsonl' } : { timestamp: new Date().toISOString(), agent_type: 'custom', agent_name: f.resource.id, stop_reason: 'end_turn' }) };
    const result = await observeNativeSpecialist({ ...f.options, payload });
    assert.equal(result.observed, true, result.reason);
    const retained = verifyNativeInvocationObservation({ ...f.options, observationId: result.observationId, resource: f.resource });
    assert.equal(retained.toolUseId, 'actual-child');
    assert.match(retained.correlation, /single.*role.*session/i);
  }
});

test('Codex async completion must match a prior source-bound spawned child and exact parent session', async t => {
  const f = fixture(t), input = { agent_type: f.resource.id, message: 'Review accepted task.' };
  const probe = { ...f.probe, action: { ...f.probe.action, tool: 'spawn_agent', input } };
  const options = { ...f.options, inspectProbe: query => query.sessionId === 'session-1' && query.role === f.resource.id ? probe : { authorized: false } };
  const spawn = { ...f.payload, tool_name: 'think', ae_native_tool_name: 'spawn_agent', tool_input: input, tool_response: { agent_id: 'actual-codex-child' } };
  const wait = { ...f.payload, tool_use_id: 'wait-1', tool_name: 'think', ae_native_tool_name: 'wait_agent', tool_input: { ids: ['actual-codex-child'] }, tool_response: { status: { 'actual-codex-child': { completed: 'No defects found.' } }, timed_out: false } };
  assert.equal((await observeNativeSpecialist({ ...options, payload: wait })).observed, false);
  assert.equal((await observeNativeSpecialist({ ...options, payload: spawn })).pending, true);
  assert.equal((await observeNativeSpecialist({ ...options, payload: { ...wait, session_id: 'other-session' } })).observed, false);
  assert.equal((await observeNativeSpecialist({ ...options, payload: wait })).observed, true);
  const workspaceKey = createHash('sha256').update(options.workspace).digest('hex');
  const state = JSON.parse(fs.readFileSync(path.join(options.home, 'native-specialist-observations', `${workspaceKey}.json`), 'utf8'));
  assert.deepEqual(state.pending, {}, 'a durably completed child must not accumulate in the live pending ledger');
  assert.deepEqual(state.observations, {}, 'full observations live in exact-addressed immutable files');
});

test('actual native review output binds provider, packet, source, session and exact findings rather than authored provenance', async t => {
  const f = fixture(t), packetId = 'c'.repeat(64);
  f.resource.invocable = true;
  const provider = { name: f.resource.id, path: f.resource.path, digest: f.resource.digest, perspective: 'security-sentinel' };
  const result = { reviewer: 'security-sentinel', status: 'completed', findings: [], residual_risks: [], testing_gaps: [] };
  let binding = { packet: packetId, scope: 'source-1', policyRevision: 'consent-1' };
  const options = { ...f.options, configured: true, policy: { ...f.options.policy, enabled: false }, inspectProbe: () => ({ authorized: false }), packetBinding: () => ({ current: true, binding, providers: [provider] }) };
  const query = { ...options, packetId, sessionId: 'session-1', result: { ...result, provenance: { kind: 'host-invocation', agent: f.resource.id, via: 'engineer' } }, provider };
  assert.equal(validateReviewObservation(query).valid, false);
  const observed = await observeNativeSpecialist({ ...options, payload: { ...f.payload, tool_response: { content: [{ type: 'text', text: JSON.stringify({ schema: 1, packet: packetId, results: [result] }) }] } } });
  assert.equal(observed.reviewObserved, true, observed.reason);
  assert.equal(observed.activated, undefined);
  assert.equal(validateReviewObservation(query).valid, true);
  assert.equal(validateReviewObservation({ ...query, sessionId: 'forged-session' }).valid, false);
  assert.equal(validateReviewObservation({ ...query, result: { ...result, testing_gaps: ['Changed finding after native response.'] } }).valid, false);
  assert.equal(validateReviewObservation({ ...query, provider: { ...provider, name: 'another-role' } }).valid, false);
  binding = { ...binding, scope: 'changed-source-2' };
  assert.equal(validateReviewObservation(query).valid, false);
});

test('a real consumed decision receipt allows first native use and transitions only its current personal source to available', async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-native-activation-integration-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'state'), copilotHome = path.join(root, 'config'), skillsHome = path.join(root, 'skills');
  fs.mkdirSync(workspace);
  assert.equal(runHostSetup({ verb: 'setup', host: 'claude-code', packageRoot, configHome: copilotHome, skillsHome, home }).status, 'ok');
  const text = '---\nname: first-native-reviewer\ndescription: Review the selected service behavior using source evidence.\nuser-invocable: false\ntools: [read]\nagents: []\n---\n\n## Guardrails\nStay inside the accepted source question.\n\n## Mission\nInspect the selected service behavior.\n\n## Output\nReturn concrete findings with source references.\n';
  createHostResource({ type: 'agent', name: 'first-native-reviewer', input: { schema: 1, text }, configHome: copilotHome, skillsHome, home, yes: true });
  const base = { workspace, home, copilotHome, skillsHome };
  configureDiscovery({ ...base, input: { schema: 1, roots: [{ path: copilotHome, kind: 'config', host: 'claude-code', included: true }], ongoing: true, grants: { tools: ['read', 'agent'], agents: [], decision: true } } });
  const policy = decisionPolicyFromDiscovery(discoveryPolicy(base));
  const options = { ...base, policy, resolveAgent: id => resolveCapability({ ...base, kind: 'agent', id }) };
  assert.equal(options.resolveAgent('first-native-reviewer').invocable, false);
  const input = { subagent_type: 'first-native-reviewer', prompt: 'Inspect the accepted service question.' };
  const prepared = prepareDecision({ ...options, input: { schema: 1, taskId: 'first-specialist', sessionId: 'real-session', type: 'action', intent: 'Probe the newly published source in the native host.', action: { tool: 'Agent', input, cwd: workspace } } });
  observeDecisionInvocation({ ...options, payload: { cwd: workspace, session_id: 'real-session', tool_name: 'Agent', tool_use_id: 'decision-call', tool_input: { subagent_type: 'decision-agent' }, tool_response: { schema: 1, requestId: prepared.requestId, verdict: 'allow', reason: 'The bounded read-only probe fits standing authority.', evidence: [] }, success: true } });
  recordDecision({ ...options, input: { schema: 1, requestId: prepared.requestId } });
  const payload = { cwd: workspace, session_id: 'real-session', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'first-native-call', tool_input: input, tool_response: { content: [{ type: 'text', text: 'The selected source was reviewed.' }] }, success: true };
  assert.equal(guardDecisionTool({ ...options, payload }).mediation, 'receipt-bound-pending-native-probe');
  const observed = await observeNativeSpecialist({ ...options, payload });
  assert.equal(observed.activated, true, observed.reason);
  const available = options.resolveAgent('first-native-reviewer');
  assert.equal(available.invocable, true);
  assert.equal(available.activation, 'available');
  assert.equal(available.activationEvidence.loadedSourceHash, 'unverified');
});

test('configured native hooks retain actual session identity while preserving active plan and old activation provenance', t => {
  const f = fixture(t), { workspace, home, copilotHome } = f.options;
  configureDiscovery({ workspace, home, copilotHome, input: { schema: 1, roots: [{ path: copilotHome, kind: 'config', included: true }], ongoing: true, grants: { decision: false } } });
  fs.mkdirSync(path.join(workspace, '.harness'));
  const sessionFile = path.join(workspace, '.harness/session.json');
  const previous = { sessionId: 'old-session', activePlan: 'docs/plans/accepted.md', activatedSkills: { conventions: { sessionId: 'old-session', complete: true } } };
  fs.writeFileSync(sessionFile, JSON.stringify(previous));
  const env = { ...process.env, AE_HOME: home, HARNESS_HOME: home, AE_BIN: path.join(packageRoot, 'bin/ae.mjs'), HARNESS_BIN: path.join(packageRoot, 'bin/ae.mjs'), COPILOT_HOME: copilotHome };
  delete env.AE_SKILLS_HOME; delete env.HARNESS_SKILLS_HOME;
  const script = path.join(packageRoot, 'corpus/hooks/guard-decision.mjs');
  const payload = { cwd: workspace, session_id: 'actual-native-session', tool_name: 'Read', tool_input: { file_path: 'source.mjs' } };
  const run = value => spawnSync(process.execPath, [script], { cwd: workspace, env, encoding: 'utf8', input: JSON.stringify(value) });
  const result = run(payload);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).continue, true);
  const retained = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.equal(retained.sessionId, 'actual-native-session');
  assert.equal(retained.activePlan, previous.activePlan);
  assert.deepEqual(retained.activatedSkills, previous.activatedSkills);
  const denied = run({ ...payload, sessionId: 'conflicting-native-session' });
  assert.equal(JSON.parse(denied.stdout).permissionDecision, 'deny');
  assert.equal(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).sessionId, 'actual-native-session');
});

test('observation verification uses the configured global AE state home when home is omitted', async t => {
  const f = fixture(t), observed = await observeNativeSpecialist({ ...f.options, payload: f.payload });
  const prior = { AE_HOME: process.env.AE_HOME, HARNESS_HOME: process.env.HARNESS_HOME };
  t.after(() => { for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  process.env.AE_HOME = f.options.home; process.env.HARNESS_HOME = f.options.home;
  const retained = verifyNativeInvocationObservation({ ...f.options, home: undefined, observationId: observed.observationId, resource: f.resource });
  assert.equal(retained.id, observed.observationId);
});

test('native review history exceeding two MiB remains exact-addressable without a growing shared store', async t => {
  const f = fixture(t), packetId = 'd'.repeat(64);
  f.resource.invocable = true;
  const provider = { name: f.resource.id, path: f.resource.path, digest: f.resource.digest, perspective: 'security-sentinel' };
  let binding = { packet: packetId, scope: 'source-before', policyRevision: 'consent-1' };
  const options = { ...f.options, configured: true, inspectProbe: () => ({ authorized: false }), packetBinding: () => ({ current: true, binding, providers: [provider] }) };
  const results = [];
  for (let index = 0; index < 4; index++) {
    const result = { reviewer: 'security-sentinel', status: 'completed', findings: [], residual_risks: [`Evidence ${index}: ${'x'.repeat(600000)}`], testing_gaps: [] };
    results.push(result);
    const observed = await observeNativeSpecialist({ ...options, now: 100 + index, payload: { ...f.payload, tool_use_id: `review-${index}`, tool_response: { content: [{ type: 'text', text: JSON.stringify({ schema: 1, packet: packetId, results: [result] }) }] } } });
    assert.equal(observed.reviewObserved, true, observed.reason);
  }
  for (const result of results) assert.equal(validateReviewObservation({ ...options, packetId, sessionId: 'session-1', result, provider }).valid, true);
  binding = { ...binding, scope: 'changed-source' };
  assert.equal(validateReviewObservation({ ...options, packetId, sessionId: 'session-1', result: results[0], provider }).valid, false);
});

test('legacy bounded observation ledgers remain readable and migrate without losing exact native evidence', async t => {
  const f = fixture(t), observed = await observeNativeSpecialist({ ...f.options, payload: f.payload });
  const workspaceKey = createHash('sha256').update(f.options.workspace).digest('hex');
  const root = path.join(f.options.home, 'native-specialist-observations'), archived = path.join(root, 'archive', workspaceKey, 'activation', `${observed.observationId}.json`);
  const entry = JSON.parse(fs.readFileSync(archived, 'utf8'));
  fs.writeFileSync(path.join(root, `${workspaceKey}.json`), JSON.stringify({ schema: 1, workspace: f.options.workspace, pending: {}, observations: { [entry.id]: entry }, reviews: {} }));
  fs.unlinkSync(archived);
  assert.equal(verifyNativeInvocationObservation({ ...f.options, observationId: entry.id, resource: f.resource }).id, entry.id);
  f.resource.invocable = true;
  const spawn = { ...f.payload, tool_name: 'think', ae_native_tool_name: 'spawn_agent', tool_input: { agent_type: f.resource.id, message: 'A separate native inspection.' }, tool_response: { agent_id: 'migration-child' } };
  assert.equal((await observeNativeSpecialist({ ...f.options, payload: spawn })).pending, true);
  const state = JSON.parse(fs.readFileSync(path.join(root, `${workspaceKey}.json`), 'utf8'));
  assert.deepEqual(state.observations, {});
  assert.equal(verifyNativeInvocationObservation({ ...f.options, observationId: entry.id, resource: f.resource }).id, entry.id);
});

test('abandoned native children exceeding two MiB never exhaust a workspace ledger or lose exact oldest-child correlation', async t => {
  const f = fixture(t), packetId = 'e'.repeat(64);
  f.resource.invocable = true;
  const provider = { name: f.resource.id, path: f.resource.path, digest: f.resource.digest, perspective: 'security-sentinel' };
  const options = { ...f.options, inspectProbe: () => ({ authorized: false }), packetBinding: () => ({ current: true, binding: { packet: packetId, scope: 'source-1' }, providers: [provider] }) };
  for (let index = 0; index < 4; index++) {
    const spawn = { ...f.payload, tool_use_id: `abandoned-spawn-${index}`, tool_name: 'think', ae_native_tool_name: 'spawn_agent', tool_input: { agent_type: f.resource.id, message: `Context ${index}: ${'x'.repeat(600000)}` }, tool_response: { agent_id: `abandoned-child-${index}` } };
    const observed = await observeNativeSpecialist({ ...options, payload: spawn });
    assert.equal(observed.pending, true, observed.reason);
  }
  const result = { reviewer: 'security-sentinel', status: 'completed', findings: [], residual_risks: [], testing_gaps: [] };
  const wait = { ...f.payload, tool_use_id: 'oldest-wait', tool_name: 'think', ae_native_tool_name: 'wait_agent', tool_input: { ids: ['abandoned-child-0'] }, tool_response: { status: { 'abandoned-child-0': { completed: JSON.stringify({ schema: 1, packet: packetId, results: [result] }) } } } };
  assert.equal((await observeNativeSpecialist({ ...options, payload: wait })).reviewObserved, true);
  assert.equal((await observeNativeSpecialist({ ...options, payload: wait })).observed, false, 'a completed child cannot replay archived correlation');
  const workspaceKey = createHash('sha256').update(options.workspace).digest('hex');
  const stateFile = path.join(options.home, 'native-specialist-observations', `${workspaceKey}.json`);
  assert.ok(fs.statSync(stateFile).size < 4096);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pending, {});
});
