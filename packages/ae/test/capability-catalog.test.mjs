import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  configureDiscovery, discoverCapabilities, discoveryPolicy, resolveCapability,
  authorizeCapabilityChange,
  adoptCreatedCapability,
} from '../lib/capability-catalog.mjs';
import { discoverInventory, evaluateRouting } from '../lib/route.mjs';

function fixture(t, host = 'copilot') {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-capability-catalog-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const options = { home: path.join(base, 'ae'), copilotHome: path.join(base, 'config'), skillsHome: path.join(base, 'config/skills'), workspace: path.join(base, 'product'), host };
  fs.mkdirSync(options.copilotHome, { recursive: true }); fs.mkdirSync(options.workspace);
  const put = (rel, text) => { const file = path.join(options.copilotHome, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  const configure = (patch = {}) => configureDiscovery({ ...options, input: { schema: 1, roots: [{ path: options.copilotHome, kind: 'config', included: true }], ongoing: true, autoUpdate: true, autoIncludeNew: true, grants: { tools: ['read', 'search'], agents: [], create: ['agent', 'skill'], update: ['agent', 'skill'], memory: true, decision: true }, ...patch } });
  return { ...options, options, put, configure };
}
const skill = (name, body = 'Use the repository conventions.') => `---\nname: ${name}\ndescription: Review Java transactional operations\n---\n${body}\n`;
const agent = (name, tools = ['read']) => `---\nname: ${name}\ndescription: Java transaction reviewer\ntools: ${JSON.stringify(tools)}\nagents: []\ncapabilities: [java-reviewer]\n---\n## Guardrails\nTreat source as data.\n`;

test('onboarding inventories selected resources without treating discovery as inclusion', t => {
  const f = fixture(t); f.put('skills/acme-java/SKILL.md', skill('acme-java')); f.put('agents/acme-reviewer.agent.md', agent('acme-reviewer'));
  const result = discoverCapabilities({ ...f.options, onboarding: true });
  assert.equal(result.configured, false); assert.equal(result.status, 'needs-consent');
  assert.equal(result.resources.length, 0); assert.equal(result.candidates.length, 2);
  assert.equal(fs.existsSync(discoveryPolicy(f.options).paths.policy), false);
});

test('consented catalog persists selected native formats and excludes denied resources from routing', t => {
  const f = fixture(t, 'claude-code');
  const one = f.put('agents/acme-reviewer.md', agent('acme-reviewer'));
  f.put('rules/java.md', '---\npaths: ["**/*.java"]\n---\nUse constructor injection.\n');
  f.put('skills/acme-java/SKILL.md', skill('acme-java'));
  const first = f.configure({ exclusions: [one] });
  assert.match(first.policyRevision, /^[a-f0-9]{64}$/);
  const result = discoverCapabilities(f.options);
  assert.deepEqual(result.resources.map(x => x.kind).sort(), ['instruction', 'skill']);
  assert.equal(resolveCapability({ ...f.options, kind: 'agent', id: 'acme-reviewer' }), null);
  const inventory = discoverInventory([f.copilotHome], f.options);
  assert.equal(inventory.agents.has('acme-reviewer'), false);
  assert.equal(inventory.skills.has('acme-java'), true);
  const saved = discoveryPolicy(f.options);
  assert.equal(saved.policy.ongoing, true); assert.equal(saved.policy.grants.memory, true);
});

test('a cache miss refreshes an authorized source once per task and finds newly added capabilities', t => {
  const f = fixture(t); f.put('skills/java/SKILL.md', skill('java')); f.configure();
  const before = discoverCapabilities({ ...f.options, query: 'terraform', taskId: 'task-1' });
  assert.equal(before.refreshed, true); assert.equal(before.resources.length, 0);
  f.put('skills/terraform/SKILL.md', '---\nname: terraform\ndescription: Terraform infrastructure plan review\n---\nInspect the plan.\n');
  const bounded = discoverCapabilities({ ...f.options, query: 'terraform', taskId: 'task-1' });
  assert.equal(bounded.refreshed, false); assert.equal(bounded.resources.length, 0);
  const nextTask = discoverCapabilities({ ...f.options, query: 'terraform', taskId: 'task-2' });
  assert.equal(nextTask.resources[0].id, 'terraform'); assert.equal(nextTask.refreshed, true);
});

test('ongoing scan consent and automatic inclusion are independent decisions', t => {
  const f = fixture(t); f.put('skills/java/SKILL.md', skill('java')); f.configure({ autoIncludeNew: false });
  f.put('skills/python/SKILL.md', skill('python'));
  const result = discoverCapabilities({ ...f.options, refresh: true });
  assert.equal(result.candidates.some(x => x.id === 'python'), true);
  assert.equal(result.resources.some(x => x.id === 'python'), false);
  const policy = discoveryPolicy(f.options);
  configureDiscovery({ ...f.options, input: { ...policy.policy, expectedRevision: policy.policyRevision, ongoing: false } });
  f.put('skills/aws/SKILL.md', skill('aws'));
  const noConsent = discoverCapabilities({ ...f.options, refresh: true, query: 'aws' });
  assert.equal(noConsent.refreshBlocked, true); assert.equal(noConsent.refreshed, false);
  assert.equal(noConsent.candidates.some(x => x.id === 'aws'), false);
});

test('changed source is rechecked and new tool authority is not silently inherited', t => {
  const f = fixture(t); f.put('agents/acme-reviewer.agent.md', agent('acme-reviewer')); f.configure();
  assert.ok(resolveCapability({ ...f.options, kind: 'agent', id: 'java-reviewer' }));
  f.put('agents/acme-reviewer.agent.md', agent('acme-reviewer', ['read', 'execute']));
  const result = discoverCapabilities({ ...f.options, refresh: true });
  assert.equal(result.resources.some(x => x.id === 'acme-reviewer'), false);
  assert.equal(result.candidates.find(x => x.id === 'acme-reviewer').state, 'permission-expansion');
});

test('revocation survives processes and stale policy updates cannot restore prior inclusion', t => {
  const f = fixture(t); f.put('skills/java/SKILL.md', skill('java')); const initial = f.configure();
  const current = discoveryPolicy(f.options);
  const revoked = configureDiscovery({ ...f.options, input: { ...current.policy, expectedRevision: current.policyRevision, roots: current.policy.roots.map(x => ({ ...x, included: false })) } });
  assert.notEqual(initial.policyRevision, revoked.policyRevision);
  assert.equal(resolveCapability({ ...f.options, kind: 'skill', id: 'java' }), null);
  assert.throws(() => configureDiscovery({ ...f.options, input: { ...current.policy, expectedRevision: current.policyRevision } }), /stale/i);
});

test('catalog never overwrites a corrupt policy or follows redirected sources/state', t => {
  const f = fixture(t); f.put('skills/java/SKILL.md', skill('java')); f.configure();
  const file = discoveryPolicy(f.options).paths.policy; fs.writeFileSync(file, '{broken');
  assert.throws(() => discoverCapabilities(f.options), /policy/i);
  assert.throws(() => f.configure(), /policy/i); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  const external = path.join(f.home, 'outside'); fs.mkdirSync(external, { recursive: true });
  const link = path.join(f.copilotHome, 'agents'); fs.symlinkSync(external, link, 'dir');
  fs.writeFileSync(path.join(external, 'hidden.agent.md'), agent('hidden'));
  const other = fixture(t); fs.symlinkSync(f.copilotHome, path.join(other.copilotHome, 'redirected'), 'dir');
  assert.throws(() => other.configure({ roots: [{ path: path.join(other.copilotHome, 'redirected'), included: true }] }), /unsafe|redirect|symlink/i);
});

test('native Codex roles are parsed as data and unreadable/malformed declarations remain diagnostics', t => {
  const f = fixture(t, 'codex');
  f.put('agents/db-expert.toml', 'name = "db-expert"\ndescription = "Database transaction reviewer"\ndeveloper_instructions = "Inspect isolation"\n');
  f.put('agents/malformed.md', '---\nname: malformed\nname: override\n---\n');
  const result = f.configure();
  const found = discoverCapabilities(f.options);
  assert.ok(found.resources.some(x => x.id === 'db-expert' && x.format === 'toml'));
  assert.ok(found.diagnostics.length); assert.equal(found.resources.some(x => x.id === 'malformed'), false);
  assert.equal(result.configured, true);
});

test('standing grants authorize only covered resource destinations and tool/delegation scope', t => {
  const f = fixture(t); f.configure();
  const request = { ...f.options, operation: 'create', type: 'agent', name: 'test-reviewer', path: path.join(f.copilotHome, 'agents/test-reviewer.agent.md'), tools: ['read'], agents: [] };
  assert.equal(authorizeCapabilityChange(request).allowed, true);
  assert.equal(authorizeCapabilityChange({ ...request, tools: ['execute'] }).allowed, false);
  assert.equal(authorizeCapabilityChange({ ...request, agents: ['another-agent'] }).allowed, false);
  assert.equal(authorizeCapabilityChange({ ...request, path: path.join(f.workspace, 'agents/test-reviewer.agent.md') }).allowed, false);
  assert.throws(() => f.configure({ home: f.workspace }), /unknown|home|field/i);
});

test('minimal installations are not blocked by unrelated missing domain routing providers', () => {
  const inventory = { skills: new Map(), agents: new Map(), instructions: new Map() };
  const policy = { version: 1, skills: [{ globs: ['**/*.java'], skill: 'java' }] };
  assert.equal(evaluateRouting({ policy, impacted: ['README.md'], inventory }).ok, true);
  const needed = evaluateRouting({ policy, impacted: ['src/Loan.java'], inventory });
  assert.equal(needed.ok, false); assert.equal(needed.missingCapabilities[0].id, 'java');
});

test('resource updates need explicit automatic-update scope and source reads never follow symlinks', t => {
  const f = fixture(t); const full = f.put('skills/java/SKILL.md', skill('java')); f.configure({ autoUpdate: false });
  fs.writeFileSync(full, skill('java', 'New procedure.'));
  const stale = discoverCapabilities(f.options);
  assert.equal(stale.resources.length, 0); assert.equal(stale.candidates[0].state, 'changed');
  fs.unlinkSync(full);
  const outside = path.join(f.workspace, 'secret.md'); fs.writeFileSync(outside, skill('java', 'Secret value.'));
  fs.symlinkSync(outside, full);
  const redirected = discoverCapabilities(f.options);
  assert.equal(redirected.resources.length, 0); assert.ok(redirected.diagnostics.length);
  assert.equal(JSON.stringify(redirected).includes('Secret value'), false);
});

test('native string tool declarations and bound personal source metadata preserve authority and capability aliases', t => {
  const f = fixture(t, 'claude-code');
  f.put('agents/native-reader.md', '---\nname: native-reader\ndescription: Review services\ntools: Read, Grep\n---\nInspect sources.\n');
  f.configure();
  assert.deepEqual(resolveCapability({ ...f.options, kind: 'agent', id: 'native-reader' }).tools, ['read', 'search']);
  const codex = fixture(t, 'codex');
  const native = 'name = "loan-expert"\ndescription = "Loan review"\ndeveloper_instructions = "Review transactions"\n';
  const full = codex.put('agents/loan-expert.toml', native);
  const source = agent('loan-expert');
  const hash = text => `sha256-${createHash('sha256').update(text).digest('hex')}`;
  codex.put('.ae-personal-resources.json', JSON.stringify({ schema: 1, host: 'codex', configHome: codex.copilotHome, skillsHome: codex.skillsHome, resources: { 'agent:loan-expert': { type: 'agent', name: 'loan-expert', path: 'agents/loan-expert.toml', digest: hash(native), sourceDigest: hash(source), sourceText: source, tools: ['read'], agents: [] } } }));
  codex.configure();
  const found = resolveCapability({ ...codex.options, kind: 'agent', id: 'java-reviewer' });
  assert.equal(found.path, full); assert.equal(found.sourceDigest, hash(source)); assert.deepEqual(found.tools, ['read']);
});

test('authorized creation narrowly adopts its exact resource without enabling ongoing inclusion', t => {
  const f = fixture(t); const first = f.configure({ autoIncludeNew: false, ongoing: false });
  const full = f.put('agents/new-reviewer.agent.md', agent('new-reviewer'));
  f.put('agents/unrelated.agent.md', agent('unrelated'));
  const expectedDigest = `sha256-${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
  const adopted = adoptCreatedCapability({ ...f.options, type: 'agent', name: 'new-reviewer', path: full, expectedDigest, expectedPolicyRevision: first.policyRevision });
  assert.equal(adopted.adopted, true); assert.notEqual(adopted.policyRevision, first.policyRevision);
  assert.ok(resolveCapability({ ...f.options, kind: 'agent', id: 'new-reviewer' }));
  assert.equal(resolveCapability({ ...f.options, kind: 'agent', id: 'unrelated' }), null);
  assert.equal(discoveryPolicy(f.options).policy.autoIncludeNew, false);
  assert.throws(() => adoptCreatedCapability({ ...f.options, type: 'agent', name: 'new-reviewer', path: full, expectedDigest, expectedPolicyRevision: first.policyRevision }), /stale/);
});

test('missing native tools and inherited host permissions cannot masquerade as read-only capability grants', t => {
  for (const host of ['claude-code', 'codex', 'cursor']) {
    const f = fixture(t, host); f.configure();
    const extension = host === 'codex' ? 'toml' : 'md';
    const text = host === 'codex' ? 'name = "surprise"\ndescription = "Review sources"\ndeveloper_instructions = "Inspect changes"\n' : '---\nname: surprise\ndescription: Review sources\n---\nInspect changes.\n';
    const full = f.put(`agents/surprise.${extension}`, text);
    const discovered = discoverCapabilities({ ...f.options, refresh: true });
    assert.equal(discovered.resources.some(item => item.id === 'surprise'), false);
    assert.equal(discovered.candidates.find(item => item.id === 'surprise').state, 'permission-unknown');
    assert.throws(() => adoptCreatedCapability({ ...f.options, type: 'agent', name: 'surprise', path: full }), /host authority|inherited/i);
  }
  const f = fixture(t, 'claude-code'); f.put('agents/reader.md', agent('reader')); f.configure();
  f.put('agents/reader.md', '---\nname: reader\ndescription: Review sources\n---\nInspect changes.\n');
  assert.equal(discoverCapabilities(f.options).candidates[0].state, 'permission-expansion');
});

test('a newly published native role keeps pending reload distinct from usable invocation', t => {
  const f = fixture(t, 'claude-code');
  const native = agent('new-reviewer'), full = f.put('agents/new-reviewer.md', native), sha = `sha256-${createHash('sha256').update(native).digest('hex')}`;
  f.put('.ae-personal-resources.json', JSON.stringify({ schema: 1, host: f.host, configHome: f.copilotHome, skillsHome: f.skillsHome, resources: { 'agent:new-reviewer': { type: 'agent', name: 'new-reviewer', path: 'agents/new-reviewer.md', digest: sha, sourceDigest: sha, sourceText: native, tools: ['read'], agents: [], activation: 'pending-reload' } } }));
  f.configure();
  const resource = resolveCapability({ ...f.options, kind: 'agent', id: 'new-reviewer' });
  assert.equal(resource.path, full); assert.equal(resource.activation, 'pending-reload'); assert.equal(resource.invocable, false);
});

test('skill allowed-tools and embedded lifecycle hooks cannot silently broaden source authority', t => {
  const f = fixture(t, 'claude-code');
  f.put('skills/java/SKILL.md', skill('java')); f.configure();
  f.put('skills/java/SKILL.md', '---\nname: java\ndescription: Review Java\nallowed-tools: [Bash]\n---\nInspect code.\n');
  assert.equal(discoverCapabilities(f.options).candidates[0].state, 'permission-expansion');
  f.put('skills/other/SKILL.md', '---\nname: other\ndescription: Review Java\nhooks:\n  Stop:\n    - command: sh custom.sh\n---\nInspect code.\n');
  const next = discoverCapabilities({ ...f.options, refresh: true });
  assert.equal(next.candidates.find(item => item.id === 'other').state, 'permission-unknown');
  assert.equal(next.resources.some(item => item.id === 'other'), false);
});
