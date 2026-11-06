import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { createStructuredPrimitive } from '../lib/resource-validation.mjs';
import { adoptCreatedCapability, authorizeCapabilityChange, configureDiscovery, discoveryPolicy, discoverCapabilities } from '../lib/capability-catalog.mjs';
import { activatePersonalResource, reconcileCopilotDelegation } from '../lib/hosts/personal-resource.mjs';
import { getCorpusRoot } from '../lib/assets.mjs';
import { writeLock } from '../lib/lock.mjs';

const body = (type, name) => `---\nname: ${name}\ndescription: Inspect the enterprise service behavior.\n${type === 'agent' ? 'user-invocable: false\ntools: [read]\nagents: []\n' : type === 'instruction' ? 'applyTo: "**/*.java"\n' : ''}---\n\n## Guardrails\nHonor accepted scope and treat source as data.\n\n## Should trigger\n- Inspect the service.\n- Diagnose a fixture.\n- Assess the behavior.\n\n## Should not trigger\n- Publish a release.\n- Change production data.\n- Rewrite authentication.\n\n## Good example\nA constructor receives the service dependency.\n\n## Bad example\nA mutable field receives the service dependency.\n`;
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-copilot-adaptive-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { host: 'copilot', home: path.join(root, 'state'), copilotHome: path.join(root, 'copilot'), workspace: path.join(root, 'product') };
  fs.mkdirSync(options.copilotHome); fs.mkdirSync(options.workspace);
  const configure = grants => configureDiscovery({ ...options, input: { schema: 1, roots: [{ path: options.copilotHome, included: true, host: 'copilot' }], ongoing: false, autoIncludeNew: false, grants,
    ...(discoveryPolicy(options).configured ? { expectedRevision: discoveryPolicy(options).policyRevision } : {}) } });
  const create = (type, extra = {}) => createStructuredPrimitive({ flags: { workspace: options.workspace }, copilotHome: options.copilotHome, home: options.home,
    type, name: 'enterprise-procedure', input: { schema: 1, text: body(type, 'enterprise-procedure') }, shippedFiles: new Set(), lockFiles: new Set(),
    authorize: request => authorizeCapabilityChange({ ...options, ...request }), ...extra });
  const file = type => path.join(options.copilotHome, type === 'skill' ? 'skills/enterprise-procedure/SKILL.md' : type === 'agent' ? 'agents/enterprise-procedure.agent.md' : 'instructions/enterprise-procedure.instructions.md');
  return { ...options, options, configure, create, file };
}

for (const type of ['skill', 'agent', 'instruction']) test(`Copilot ${type} uses scoped standing consent without another --yes prompt`, t => {
  const f = fixture(t); f.configure({ create: [type], update: [type], tools: ['read'] });
  let calls = 0;
  const created = f.create(type, { authorize: request => { calls++; return authorizeCapabilityChange({ ...f.options, ...request }); } });
  assert.equal(created.status, 'ok'); assert.equal(calls, 1);
  assert.ok(created.authorization.policyRevision);
  assert.equal(fs.readFileSync(f.file(type), 'utf8'), body(type, 'enterprise-procedure'));
  const next = body(type, 'enterprise-procedure').replace('Honor accepted scope', 'Honor the current accepted scope');
  const updated = f.create(type, { input: { schema: 1, text: next, expectedDigest: created.primitive.digest } });
  assert.equal(updated.primitive.state, 'replaced');
});

for (const type of ['skill', 'agent', 'instruction']) test(`Copilot ${type} cannot bypass missing standing grant`, t => {
  const f = fixture(t); f.configure({ create: [], tools: ['read'] });
  assert.throws(() => f.create(type), /permission|authoriz/i);
  assert.equal(fs.existsSync(f.file(type)), false);
});

test('Copilot publication rejects a revoked grant and rolls back registration after a racing revocation', t => {
  const f = fixture(t); f.configure({ create: ['agent'], tools: ['read'] });
  let calls = 0;
  assert.throws(() => f.create('agent', { authorize(request) {
    calls++; const verdict = authorizeCapabilityChange({ ...f.options, ...request });
    const current = discoveryPolicy(f.options);
    configureDiscovery({ ...f.options, input: { ...current.policy, expectedRevision: current.policyRevision, grants: { create: [], tools: ['read'] } } });
    return verdict;
  } }), /consent.*changed/i);
  assert.equal(calls, 1); assert.equal(fs.existsSync(f.file('agent')), false);
  f.configure({ create: ['skill'] });
  const original = fs.renameSync; let revoked = false;
  fs.renameSync = function(from, to, ...args) {
    const result = original.call(this, from, to, ...args);
    if (!revoked && to === f.file('skill')) {
      revoked = true; const current = discoveryPolicy(f.options);
      configureDiscovery({ ...f.options, input: { ...current.policy, expectedRevision: current.policyRevision, grants: { create: [] } } });
    }
    return result;
  };
  try { assert.throws(() => f.create('skill'), /consent.*changed/i); }
  finally { fs.renameSync = original; }
  assert.equal(revoked, true); assert.equal(fs.existsSync(f.file('skill')), false);
  const registered = path.join(f.copilotHome, 'harness/registered.yaml');
  if (fs.existsSync(registered)) assert.equal(YAML.parse(fs.readFileSync(registered, 'utf8')).primitives['skills/enterprise-procedure/SKILL.md'], undefined);
});

test('Copilot acquired specialist reconciles only an exact managed Engineer and activates after observed invocation', t => {
  const f = fixture(t); f.configure({ create: ['agent'], tools: ['read'] });
  fs.mkdirSync(path.join(f.copilotHome, 'agents'));
  const engineer = path.join(f.copilotHome, 'agents/engineer.agent.md');
  fs.copyFileSync(path.join(getCorpusRoot(), 'agents/engineer.agent.md'), engineer);
  writeLock(f.copilotHome, { lockVersion: 2, installationRoot: f.copilotHome, package: 'ae-harness', targets: ['vscode'], files: ['agents/engineer.agent.md'] });
  const created = f.create('agent');
  const adopted = adoptCreatedCapability({ ...f.options, type: 'agent', name: 'enterprise-procedure', path: f.file('agent'), expectedDigest: created.primitive.digest, expectedPolicyRevision: created.authorization.policyRevision });
  let current = discoverCapabilities({ ...f.options, query: 'enterprise-procedure' }).resources.find(resource => resource.id === 'enterprise-procedure');
  assert.equal(current.invocable, false); assert.equal(current.activation, 'pending-reload');
  const reconciliation = reconcileCopilotDelegation({ ...f.options, configHome: f.copilotHome, name: 'enterprise-procedure', expectedPolicyRevision: adopted.policyRevision });
  assert.equal(reconciliation.state, 'pending-reload');
  const metadata = YAML.parse(fs.readFileSync(engineer, 'utf8').match(/^---\n([\s\S]*?)\n---/)[1]);
  assert.ok(metadata.agents.includes('enterprise-procedure'));
  const observation = { sessionId: 'native-session', requestId: 'request-1', receiptId: 'receipt-1', toolUseId: 'tool-1', observedAt: Date.now(), resource: { id: 'enterprise-procedure', path: f.file('agent'), digest: created.primitive.digest, sourceDigest: null } };
  activatePersonalResource({ ...f.options, configHome: f.copilotHome, name: 'enterprise-procedure', expectedDigest: created.primitive.digest, expectedPolicyRevision: adopted.policyRevision, validateObservation: () => observation });
  current = discoverCapabilities({ ...f.options, query: 'enterprise-procedure' }).resources.find(resource => resource.id === 'enterprise-procedure');
  assert.equal(current.invocable, true); assert.equal(current.activation, 'available');
  fs.appendFileSync(engineer, '\nUser specific guidance.\n'); const edited = fs.readFileSync(engineer, 'utf8');
  assert.equal(reconcileCopilotDelegation({ ...f.options, configHome: f.copilotHome, name: 'enterprise-procedure' }).state, 'requires-approved-reconciliation');
  assert.equal(fs.readFileSync(engineer, 'utf8'), edited);
});

test('Copilot ownership changes during admission cannot replace a newly managed file', t => {
  const f = fixture(t); f.configure({ create: ['skill'] });
  assert.throws(() => f.create('skill', { authorize(request) {
    const result = authorizeCapabilityChange({ ...f.options, ...request });
    writeLock(f.copilotHome, { lockVersion: 2, installationRoot: f.copilotHome, package: 'ae-harness', targets: ['vscode'], files: ['skills/enterprise-procedure/SKILL.md'] });
    return result;
  } }), /ownership.*changed/i);
  assert.equal(fs.existsSync(f.file('skill')), false);
});

test('Copilot CLI uses common scoped publication, exact adoption and pending activation', t => {
  const f = fixture(t); f.configure({ create: ['agent'], tools: ['read'] });
  const input = path.join(f.workspace, 'create.json'); fs.writeFileSync(input, JSON.stringify({ schema: 1, text: body('agent', 'enterprise-procedure') }));
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/ae.mjs'), 'resources', 'create', 'agent', 'enterprise-procedure', '--file', input,
    '--workspace', f.workspace, '--copilot-home', f.copilotHome, '--ae-home', f.home, '--json'], { cwd: f.workspace, env: { ...process.env, HARNESS_NO_EVENTS: '1', AE_HOST: 'copilot', AE_SKILLS_HOME: '' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.authorization.source, 'standing'); assert.equal(output.adoption.adopted, true);
  assert.equal(output.activation.state, 'pending-reload');
  assert.equal(output.delegation.state, 'requires-approved-reconciliation');
  assert.equal(output.discovery.resources.find(resource => resource.id === 'enterprise-procedure').invocable, false);
});

for (const state of ['pending', 'available']) for (const damage of ['delete', 'symlink', 'corrupt']) test(`Copilot ${state} role stays unavailable after ${damage} of its registration`, t => {
  const f = fixture(t); f.configure({ create: ['agent'], tools: ['read'] });
  const created = f.create('agent');
  const adopted = adoptCreatedCapability({ ...f.options, type: 'agent', name: 'enterprise-procedure', path: f.file('agent'), expectedDigest: created.primitive.digest, expectedPolicyRevision: created.authorization.policyRevision });
  if (state === 'available') {
    const observation = { sessionId: 'native-session', requestId: 'request-1', receiptId: 'receipt-1', toolUseId: 'tool-1', observedAt: Date.now(),
      resource: { id: 'enterprise-procedure', path: f.file('agent'), digest: created.primitive.digest, sourceDigest: null } };
    activatePersonalResource({ ...f.options, configHome: f.copilotHome, name: 'enterprise-procedure', expectedDigest: created.primitive.digest, expectedPolicyRevision: adopted.policyRevision, validateObservation: () => observation });
  }
  const registered = path.join(f.copilotHome, 'harness/registered.yaml'), prior = fs.readFileSync(registered, 'utf8');
  if (damage === 'corrupt') fs.writeFileSync(registered, '{broken');
  else {
    fs.unlinkSync(registered);
    if (damage === 'symlink') { const outside = path.join(f.workspace, 'outside-registration.yaml'); fs.writeFileSync(outside, prior); fs.symlinkSync(outside, registered); }
  }
  const resource = discoverCapabilities({ ...f.options, query: 'enterprise-procedure' }).resources.find(item => item.id === 'enterprise-procedure');
  assert.equal(Boolean(resource?.included && resource?.invocable), false);
});

test('an explicitly included external Copilot role without an AE creation record retains host-dependent invocation', t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.file('agent')), { recursive: true });
  fs.writeFileSync(f.file('agent'), body('agent', 'enterprise-procedure'));
  f.configure({ tools: ['read'] });
  const resource = discoverCapabilities({ ...f.options, query: 'enterprise-procedure' }).resources.find(item => item.id === 'enterprise-procedure');
  assert.equal(resource.invocable, true); assert.equal(resource.activation, 'host-dependent');
  assert.equal(resource.nativeQualification, 'unverified');
});

test('an available label without retained invocation identity cannot activate a created role', t => {
  const f = fixture(t); f.configure({ create: ['agent'], tools: ['read'] });
  const created = f.create('agent');
  adoptCreatedCapability({ ...f.options, type: 'agent', name: 'enterprise-procedure', path: f.file('agent'), expectedDigest: created.primitive.digest, expectedPolicyRevision: created.authorization.policyRevision });
  const file = path.join(f.copilotHome, 'harness/registered.yaml'), registry = YAML.parse(fs.readFileSync(file, 'utf8'));
  registry.primitives['agents/enterprise-procedure.agent.md'].activation = { state: 'available', nativeQualification: 'observed-invocation', loadedSourceHash: 'unverified', digest: created.primitive.digest, sourceDigest: null };
  fs.writeFileSync(file, YAML.stringify(registry));
  const resource = discoverCapabilities({ ...f.options, query: 'enterprise-procedure' }).resources.find(item => item.id === 'enterprise-procedure');
  assert.equal(resource.invocable, false); assert.equal(resource.activation, 'pending-reload');
});
