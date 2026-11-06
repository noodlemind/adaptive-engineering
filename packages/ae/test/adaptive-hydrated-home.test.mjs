import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { configureDiscovery, discoveryPolicy } from '../lib/capability-catalog.mjs';
import { decisionPolicyFromDiscovery, prepareDecision, recordDecision } from '../lib/decision-agent.mjs';
import { installHarnessBin } from '../lib/install-harness-bin.mjs';
import { writeLock } from '../lib/lock.mjs';

const packageRoot = path.resolve(import.meta.dirname, '..');
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-hydrated-home-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), copilotHome = path.join(root, 'custom-copilot'), home = path.join(root, 'state');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(copilotHome, 'skills/excluded-workflow'), { recursive: true });
  const source = path.join(copilotHome, 'skills/excluded-workflow/SKILL.md');
  const body = '---\nname: excluded-workflow\ndescription: An excluded enterprise procedure.\n---\nInspect the order behavior.\n';
  fs.writeFileSync(source, body);
  fs.writeFileSync(path.join(workspace, 'check.mjs'), 'console.log("check");\n');
  fs.cpSync(path.join(packageRoot, 'corpus/hooks'), path.join(copilotHome, 'hooks'), { recursive: true });
  const options = { workspace, copilotHome, home };
  configureDiscovery({ ...options, input: { schema: 1, roots: [{ path: copilotHome, included: true }], exclusions: ['excluded-workflow'], ongoing: true,
    grants: { decision: true, tools: ['execute'] } } });
  const policy = decisionPolicyFromDiscovery(discoveryPolicy(options));
  const env = { ...process.env, AE_HOME: home, HARNESS_HOME: home, AE_BIN: path.join(packageRoot, 'bin/ae.mjs'), HARNESS_BIN: path.join(packageRoot, 'bin/ae.mjs') };
  for (const key of ['COPILOT_HOME', 'AE_SKILLS_HOME', 'HARNESS_SKILLS_HOME', 'AE_HOST', 'HARNESS_HOST']) delete env[key];
  const hook = (script, payload, override = {}) => {
    const result = spawnSync(process.execPath, [path.join(copilotHome, 'hooks', script)], { cwd: workspace, env: { ...env, ...override }, input: JSON.stringify(payload), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  return { ...options, policy, source, body, hook };
}

test('a custom hydrated decision hook enforces its own consent without COPILOT_HOME', t => {
  const f = fixture(t);
  const result = f.hook('guard-decision.mjs', { cwd: f.workspace, session_id: 'custom-session', tool_name: 'Bash', tool_input: { command: 'node check.mjs' } });
  assert.equal(result.permissionDecision, 'deny');
  assert.match(result.permissionDecisionReason, /receipt|decision/i);
});

test('custom hydrated session startup carries its own consented catalog without COPILOT_HOME', t => {
  const f = fixture(t);
  const result = f.hook('load-context.mjs', { cwd: f.workspace, session_id: 'custom-session' });
  const marker = 'harness-orient-slice: ';
  const position = result.additionalContext.lastIndexOf(marker);
  assert.notEqual(position, -1);
  const slice = JSON.parse(result.additionalContext.slice(position + marker.length));
  assert.equal(slice.capabilities?.configured, true);
  assert.equal(slice.capabilities.policyRevision, f.policy.revision);
  assert.equal(slice.capabilities.resources.some(resource => resource.id === 'excluded-workflow'), false);
});

test('a configured Copilot hook admits only the selected installed acquisition writer', t => {
  const f = fixture(t);
  const runtime = installHarnessBin(packageRoot, f.copilotHome, {}, () => {});
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
  writeLock(f.copilotHome, { package: 'ae-harness', version, lockVersion: 2, installationRoot: f.copilotHome, targets: ['cli'], files: runtime.files }, false);
  const installedBin = path.join(f.copilotHome, '.ae-bin/bin/ae.mjs');
  const override = { AE_BIN: installedBin, HARNESS_BIN: installedBin };
  const input = path.join(f.workspace, '.harness/decisions/specialist.json');
  fs.mkdirSync(path.dirname(input), { recursive: true });
  fs.writeFileSync(input, JSON.stringify({ schema: 1, text: 'Prepared canonical resource body.' }));
  const argv = [process.execPath, installedBin, 'resources', 'create', 'agent', 'new-specialist', '--file', input, '--workspace', f.workspace, '--copilot-home', f.copilotHome, '--ae-home', f.home, '--json'];
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const invoke = args => f.hook('guard-decision.mjs', { cwd: f.workspace, session_id: 'custom-session', tool_name: 'Bash', tool_input: { command: args.map(quote).join(' ') } }, override);
  const allowed = invoke(argv);
  assert.equal(allowed.permissionDecision, undefined, JSON.stringify(allowed));
  assert.equal(allowed.mediation, 'bounded-writer-acquisition-receipt');
  assert.equal(invoke([...argv, '--yes']).permissionDecision, 'deny');
  const changedRoot = [...argv]; changedRoot[changedRoot.indexOf('--copilot-home') + 1] = path.dirname(f.copilotHome);
  assert.equal(invoke(changedRoot).permissionDecision, 'deny');
});

test('a custom hydrated post hook respects its own excluded skills without COPILOT_HOME', t => {
  const f = fixture(t);
  f.hook('record-successful-edit.mjs', { cwd: f.workspace, session_id: 'custom-session', tool_name: 'Read', tool_input: { file_path: f.source }, tool_response: { content: f.body, truncated: false }, success: true });
  const session = path.join(f.workspace, '.harness/session.json');
  const value = fs.existsSync(session) ? JSON.parse(fs.readFileSync(session, 'utf8')) : null;
  assert.equal(value?.activatedSkills?.['excluded-workflow'], undefined);
});

test('a custom hydrated observer records its own prepared request without COPILOT_HOME', t => {
  const f = fixture(t);
  const packet = prepareDecision({ ...f, input: { schema: 1, taskId: 'custom-task', sessionId: 'custom-session', type: 'action', intent: 'Run the accepted product check.',
    action: { tool: 'Bash', input: { command: 'node check.mjs' }, cwd: f.workspace }, sources: ['check.mjs'] } });
  const judgment = { schema: 1, requestId: packet.requestId, verdict: 'allow', reason: 'The selected product check is within the accepted task.', evidence: ['check.mjs'] };
  const result = f.hook('observe-decision.mjs', { hook_event_name: 'SubagentStop', cwd: f.workspace, session_id: 'custom-session', agent_id: 'actual-child-identity',
    agent_name: 'decision-agent', last_assistant_message: JSON.stringify(judgment), stop_reason: 'end_turn' });
  assert.equal(result.observed, true);
  assert.equal(recordDecision({ ...f, input: { schema: 1, requestId: packet.requestId } }).authorized, true);
});
