import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { decisionInputStaging, nativeDecisionInputStaging } from '../corpus/hooks/lib/decision-staging.mjs';
import { normalizeToolPayload } from '../corpus/hooks/lib/tool-payload.mjs';
import { guardDecisionTool } from '../lib/decision-agent.mjs';
import { observeHostIntent, inspectHostIntent, validateObservedIntent } from '../lib/host-intent.mjs';

const hooks = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../corpus/hooks');
function fixture(t) {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-decision-staging-')));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const payload = (content = { schema: 1, operation: 'status', taskId: 'work' }, target = '.harness/decisions/start.v1.json', tool = 'Write') => ({ workspace, session_id: 'stage-session', tool_name: tool, tool_input: { file_path: `${workspace}/${target}`, content: typeof content === 'string' ? content : JSON.stringify(content) } });
  const allowed = value => decisionInputStaging(value, normalizeToolPayload(value));
  return { workspace, payload, allowed };
}

test('bounded whole decision input stages before plan/critical gates without opening receipt state', t => {
  const f = fixture(t), payload = f.payload();
  assert.equal(f.allowed(payload), true);
  const copilot = { cwd: f.workspace, toolName: 'create', toolArgs: { path: `${f.workspace}/.harness/decisions/copilot.json`, file_text: JSON.stringify({ schema: 1, operation: 'status', taskId: 'work' }) } };
  assert.equal(f.allowed(copilot), true, 'the official Copilot create schema uses file_text');
  for (const script of ['guard-critical-files.mjs', 'require-plan-gate.mjs']) {
    const result = spawnSync(process.execPath, [path.join(hooks, script)], { cwd: f.workspace, env: { ...process.env, HARNESS_NO_EVENTS: '1' }, input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).continue, true, `${script}: ${result.stdout}`);
  }
  assert.equal(fs.existsSync(path.join(f.workspace, '.harness')), false, 'staging predicates must not create authorization state');
});

test('decision staging rejects executable changes, extra authority, malformed JSON, traversal and oversized inputs', t => {
  const f = fixture(t);
  for (const payload of [f.payload({ schema: 1, operation: 'status', approved: true }), f.payload('{'), f.payload({ schema: 1, operation: 'record', requestId: 'x', provenance: 'native' }),
    f.payload({ schema: 1, operation: 'policy' }), f.payload(' '.repeat(65537)), f.payload(undefined, '.harness/session.json'),
    f.payload(undefined, '.harness/decisions/../decisions/start.json'), f.payload(undefined, '.harness/decisions/start.json', 'Edit')]) assert.equal(f.allowed(payload), false);
});

test('decision staging rejects symlink roots and ancestor links and existing hardlinked destinations', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.workspace, '.harness/decisions'), { recursive: true });
  const source = path.join(f.workspace, 'source.json'); fs.writeFileSync(source, '{}');
  fs.linkSync(source, path.join(f.workspace, '.harness/decisions/start.v1.json'));
  assert.equal(f.allowed(f.payload()), false);
  fs.unlinkSync(path.join(f.workspace, '.harness/decisions/start.v1.json'));
  fs.rmdirSync(path.join(f.workspace, '.harness/decisions'));
  fs.symlinkSync(f.workspace, path.join(f.workspace, '.harness/decisions'));
  assert.equal(f.allowed(f.payload()), false);
});

test('legacy plan creation, plan operations and learning inputs remain authorable without becoming native verdicts', t => {
  const f = fixture(t);
  const decisions = [
    { version: 1, format: 'full', goal: 'Preserve existing service behavior.', acceptance: ['The behavioral check passes.'], scope: ['src/service.mjs'] },
    { version: 1, id: 'start-accepted-work', action: 'start', expect: 'a'.repeat(64) },
    { operation: 'record-verified-learning', decision: 'publish', rationale: 'Retain the verified service convention.', title: 'Service convention', body: 'Use integer minor currency units.' },
  ];
  for (const decision of decisions) {
    const payload = f.payload(decision);
    assert.equal(nativeDecisionInputStaging(payload, normalizeToolPayload(payload)), false, 'lifecycle authoring is not a native judgment receipt');
    assert.equal(f.allowed(payload), true);
    const guarded = guardDecisionTool({ workspace: f.workspace, home: `${f.workspace}-state`, policy: { enabled: true, revision: 'staging-consent', tools: [] }, payload });
    assert.equal(guarded.mediation, 'bounded-decision-input-staging', 'configured decisions must not recursively require an action verdict to author CLI input');
    assert.equal(guarded.permissionDecision, undefined, 'authoring data confers no tool execution approval');
    for (const script of ['guard-critical-files.mjs', 'require-plan-gate.mjs']) {
      const result = spawnSync(process.execPath, [path.join(hooks, script)], { cwd: f.workspace, env: { ...process.env, HARNESS_NO_EVENTS: '1' }, input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).continue, true, `${script}: ${result.stdout}`);
    }
  }
});

test('closed resource input authoring cannot smuggle new grants, receipt provenance or unknown lifecycle authority', t => {
  const f = fixture(t), draft = { schema: 1, text: 'A canonical primitive draft.', expectedDigest: `sha256-${'a'.repeat(64)}` };
  assert.equal(f.allowed(f.payload(draft)), true);
  for (const decision of [
    { ...draft, approved: true },
    { ...draft, provenance: { kind: 'native' } },
    { version: 1, action: 'start', id: 'start-work', expect: 'a'.repeat(64), authority: { scope: 'tool-permissions', basis: 'Self approval', grants: { tools: ['execute'] } } },
    { version: 1, action: 'amend', id: 'amend-work', expect: 'a'.repeat(64), authority: { scope: 'plan-intent', basis: 'Task scope', approved: true } },
  ]) {
    const payload = f.payload(decision);
    assert.equal(f.allowed(payload), false);
    assert.equal(guardDecisionTool({ workspace: f.workspace, home: `${f.workspace}-state`, policy: { enabled: true, revision: 'staging-consent', tools: [] }, payload }).permissionDecision, 'deny');
  }
});

test('Write and Add File can author closed host-intent reconciliations while the actual observation stays pending', t => {
  const f = fixture(t), options = { workspace: f.workspace, sessionId: 'stage-session' };
  const observed = observeHostIntent({ ...options, prompt: 'Continue the accepted task.', eventId: 'user-turn-1', host: 'copilot' });
  for (const action of ['start', 'progress', 'amend']) {
    const decision = { version: 1, id: `reconcile-${action}`, action, expect: 'a'.repeat(64),
      observedIntent: { id: observed.id, disposition: action === 'amend' ? 'amend' : 'unchanged', rationale: 'The current user request is covered by this authored plan decision.' },
      ...(action === 'amend' ? { rationale: 'Reflect the user request.', changes: { goal: 'Preserve the updated service contract.' } } : {}) };
    const patch = `*** Begin Patch\n*** Add File: .harness/decisions/reconcile-${action}.json\n+${JSON.stringify(decision)}\n*** End Patch\n`;
    for (const payload of [f.payload(decision), { workspace: f.workspace, session_id: 'stage-session', tool_name: 'apply_patch', tool_input: { input: patch } }]) {
      assert.equal(f.allowed(payload), true);
      assert.equal(nativeDecisionInputStaging(payload, normalizeToolPayload(payload)), false);
      const guarded = guardDecisionTool({ workspace: f.workspace, home: `${f.workspace}-state`, policy: { enabled: true, revision: 'staging-consent', tools: [] }, payload });
      assert.equal(guarded.mediation, 'bounded-decision-input-staging');
      assert.equal(guarded.permissionDecision, undefined, 'authoring data grants no execution or acceptance authority');
      for (const script of ['guard-critical-files.mjs', 'require-plan-gate.mjs']) {
        const result = spawnSync(process.execPath, [path.join(hooks, script)], { cwd: f.workspace, env: { ...process.env, HARNESS_NO_EVENTS: '1' }, input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000 });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).continue, true, `${script}: ${result.stdout}`);
      }
      assert.equal(inspectHostIntent(options).state, 'pending');
    }
    const stale = { ...decision, observedIntent: { ...decision.observedIntent, id: `${'b'.repeat(32)}.${'c'.repeat(64)}` } };
    assert.equal(f.allowed(f.payload(stale)), true, 'staging validates shape; the consumer owns observation identity checks');
    assert.throws(() => validateObservedIntent({ ...options, input: stale }), /stale/);
    assert.equal(inspectHostIntent(options).state, 'pending');
  }
});

test('host-intent input staging rejects malformed reconciliation data and extra authority', t => {
  const f = fixture(t), observedIntent = { id: `${'a'.repeat(32)}.${'b'.repeat(64)}`, disposition: 'unchanged', rationale: 'Continue within the accepted task.' };
  const decision = { version: 1, id: 'reconcile-work', action: 'progress', expect: 'a'.repeat(64), observedIntent };
  const malformed = [null, [], { ...observedIntent, approved: true }, { ...observedIntent, authority: { tools: ['execute'] } },
    { ...observedIntent, id: 'claimed-observation' }, { ...observedIntent, id: 'a'.repeat(129) }, { ...observedIntent, id: `${'A'.repeat(32)}.${'b'.repeat(64)}` },
    { ...observedIntent, disposition: 'allow' }, { ...observedIntent, rationale: '' }, { ...observedIntent, rationale: 'x'.repeat(1001) },
    { ...observedIntent, rationale: 'Untrusted\nsecond line.' }, { ...observedIntent, rationale: 'Hidden\tcontrol.' }];
  const invalid = [...malformed.map(value => ({ ...decision, observedIntent: value })), { ...decision, action: 'complete' }, { ...decision, action: 'convert' },
    { ...decision, observedIntent: { ...observedIntent, disposition: 'amend' } },
    { ...decision, action: 'amend', rationale: 'No actual amendment.', observedIntent: { ...observedIntent, disposition: 'amend' } },
    { ...decision, authority: { scope: 'tool-permissions', basis: 'Self approval.' } },
    { ...decision, action: 'amend', changes: { notes: { context: 'x'.repeat(1024 * 1024) } } }];
  for (const input of invalid) {
    const patch = `*** Begin Patch\n*** Add File: .harness/decisions/reconcile.json\n+${JSON.stringify(input)}\n*** End Patch\n`;
    for (const payload of [f.payload(input), { workspace: f.workspace, session_id: 'stage-session', tool_name: 'apply_patch', tool_input: { input: patch } }]) assert.equal(f.allowed(payload), false);
  }
  assert.equal(fs.existsSync(path.join(f.workspace, '.harness')), false, 'rejection cannot create an observation or receipt');
});

test('a well-formed native judgment input cannot bypass either gate through hardlinked lifecycle state', t => {
  const f = fixture(t), protectedFile = path.join(f.workspace, '.harness/session.json');
  fs.mkdirSync(path.join(f.workspace, '.harness/decisions'), { recursive: true });
  fs.writeFileSync(protectedFile, '{"protected":true}\n');
  fs.linkSync(protectedFile, path.join(f.workspace, '.harness/decisions/start.v1.json'));
  for (const script of ['guard-critical-files.mjs', 'require-plan-gate.mjs']) {
    const result = spawnSync(process.execPath, [path.join(hooks, script)], { cwd: f.workspace, env: { ...process.env, HARNESS_NO_EVENTS: '1' }, input: JSON.stringify(f.payload()), encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).permissionDecision, 'deny', `${script}: ${result.stdout}`);
  }
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), '{"protected":true}\n');
});

test('Codex stages only one new whole Add File JSON input through the same closed authoring protocol', t => {
  const f = fixture(t), makePatch = (value, name = 'codex.json') => `*** Begin Patch\n*** Add File: .harness/decisions/${name}\n+${JSON.stringify(value)}\n*** End Patch\n`;
  const payload = patch => ({ workspace: f.workspace, session_id: 'stage-session', tool_name: 'apply_patch', tool_input: { input: patch } });
  for (const decision of [
    { schema: 1, operation: 'status', taskId: 'task' },
    { version: 1, format: 'full', goal: 'Preserve the selected behavior.', acceptance: ['Required checks pass.'] },
    { version: 1, action: 'start', id: 'start-work', expect: 'a'.repeat(64) },
    { operation: 'retain-learning', decision: 'no-learning', rationale: 'No reusable pattern was observed.' },
    { schema: 1, text: 'A canonical primitive draft.' },
  ]) {
    const input = payload(makePatch(decision));
    assert.equal(f.allowed(input), true);
    assert.equal(f.allowed({ ...input, tool_name: 'Edit', ae_native_tool_name: 'apply_patch' }), true, 'native adapters retain the actual patch tool identity');
    assert.equal(guardDecisionTool({ workspace: f.workspace, home: `${f.workspace}-state`, policy: { enabled: true, revision: 'staging-consent', tools: [] }, payload: input }).mediation, 'bounded-decision-input-staging');
  }
  const input = payload(makePatch({ schema: 1, operation: 'status', taskId: 'task' }));
  for (const script of ['guard-critical-files.mjs', 'require-plan-gate.mjs']) {
    const result = spawnSync(process.execPath, [path.join(hooks, script)], { cwd: f.workspace, env: { ...process.env, HARNESS_NO_EVENTS: '1' }, input: JSON.stringify(input), encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).continue, true, `${script}: ${result.stdout}`);
  }
  const valid = makePatch({ schema: 1, operation: 'status', taskId: 'task' });
  for (const patch of [
    valid.replace('*** Add File:', '*** Update File:'),
    valid.replace('*** Add File:', '*** Delete File:'),
    valid.replace('*** End Patch', '*** Move to: src/other.json\n*** End Patch'),
    valid.replace('*** End Patch', '*** Add File: src/unrelated.json\n+{}\n*** End Patch'),
    valid + valid,
    valid.replace('codex.json', '../session.json'),
    makePatch({ schema: 1, operation: 'record', requestId: 'a'.repeat(64), approved: true }),
  ]) assert.equal(f.allowed(payload(patch)), false);
  for (const invalid of [makePatch({}), makePatch({ schema: 1, operation: 'record', requestId: 'a'.repeat(64), approved: true }), valid.replace(/\n\+[^\n]*\n/, '\n+not JSON\n')]) {
    for (const script of ['guard-critical-files.mjs', 'require-plan-gate.mjs']) {
      const result = spawnSync(process.execPath, [path.join(hooks, script)], { cwd: f.workspace, env: { ...process.env, HARNESS_NO_EVENTS: '1' }, input: JSON.stringify(payload(invalid)), encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).permissionDecision, 'deny', `${script}: ${result.stdout}`);
    }
  }
  fs.mkdirSync(path.join(f.workspace, '.harness/decisions'), { recursive: true });
  const target = path.join(f.workspace, '.harness/decisions/codex.json');
  fs.writeFileSync(target, '{}\n');
  assert.equal(f.allowed(input), false, 'Add File cannot replace an existing staging file');
  fs.unlinkSync(target);
  const protectedFile = path.join(f.workspace, '.harness/session.json');
  fs.writeFileSync(protectedFile, '{"protected":true}\n');
  fs.linkSync(protectedFile, target);
  assert.equal(f.allowed(input), false);
});

// Copilot review of PR #130: finding prepares and learning feedback fields stage through Write and Add File.
test('finding prepare inputs and learning decisions with feedback fields stage in both native write formats', t => {
  const f = fixture(t);
  const inputs = [
    { schema: 1, operation: 'prepare', taskId: 'verify', sessionId: 's', type: 'finding', intent: 'Verify one finding.', finding: { packet: 'a'.repeat(64), id: 'b'.repeat(64), file: 'src/a.mjs', line: 1, severity: 'P2', title: 'T' } },
    { operation: 'record-learning', decision: 'no-learning', rationale: 'Nothing new.', recalled: [], findings: [], missed: [{ file: 'src/a.mjs', title: 'Missed check', source: 'copilot' }] },
  ];
  for (const input of inputs) {
    const patch = `*** Begin Patch\n*** Add File: .harness/decisions/staged.json\n+${JSON.stringify(input)}\n*** End Patch\n`;
    for (const payload of [f.payload(input), { workspace: f.workspace, session_id: 'stage-session', tool_name: 'apply_patch', tool_input: { input: patch } }]) assert.equal(f.allowed(payload), true, `${payload.tool_name}: ${Object.keys(input).join(',')}`);
  }
  assert.equal(f.allowed(f.payload({ ...inputs[1], approved: true })), false, 'the learning allowlist stays closed');
});
