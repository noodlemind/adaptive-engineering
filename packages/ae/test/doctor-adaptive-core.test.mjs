import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inspectLifecycleSkillChecks } from '../lib/doctor.mjs';
import { configureDiscovery, discoveryPolicy } from '../lib/capability-catalog.mjs';

const core = ['engineer', 'ensure-plan', 'create-primitive', 'ensure-capability'];
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-doctor-adaptive-core-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { workspace: path.join(root, 'product'), home: path.join(root, 'state'), copilotHome: path.join(root, 'config') };
  fs.mkdirSync(options.workspace); fs.mkdirSync(options.copilotHome);
  const put = (base, name) => { const file = path.join(base, 'skills', name, 'SKILL.md'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `---\nname: ${name}\ndescription: Bootstrap ${name} procedure\n---\nFollow the selected task contract.\n`); return file; };
  const configure = (patch = {}) => configureDiscovery({ ...options, input: { schema: 1, roots: [{ path: options.copilotHome, kind: 'config', included: true }], ongoing: false, grants: {}, ...patch } });
  return { ...options, put, configure };
}

test('a consented four-skill bootstrap is healthy without optional automatic procedures', t => {
  const f = fixture(t); core.forEach(name => f.put(f.copilotHome, name)); f.configure();
  const checks = inspectLifecycleSkillChecks(f);
  assert.deepEqual(checks.filter(row => !row.optional).map(row => row.skill), core);
  assert.ok(checks.filter(row => !row.optional).every(row => row.pass && row.available));
  for (const skill of ['auto-compound', 'auto-skill-draft']) {
    const row = checks.find(item => item.skill === skill);
    assert.equal(row.optional, true); assert.equal(row.pass, true); assert.equal(row.available, false);
    assert.equal(row.status, 'unavailable'); assert.match(row.hint, /acquire|create-primitive/i);
    assert.doesNotMatch(row.hint, /upgrade|reinstall/i);
  }
});

test('adaptive doctor accepts selected enterprise core sources and rejects excluded installed copies', t => {
  const f = fixture(t), enterprise = path.join(path.dirname(f.home), 'enterprise'); fs.mkdirSync(enterprise);
  core.forEach(name => f.put(enterprise, name));
  f.put(f.copilotHome, 'create-primitive');
  f.configure({ roots: [{ path: enterprise, kind: 'config', scope: 'enterprise', included: true }, { path: f.copilotHome, kind: 'config', included: false }] });
  assert.ok(inspectLifecycleSkillChecks(f).filter(row => !row.optional).every(row => row.pass));
  const current = discoveryPolicy(f);
  configureDiscovery({ ...f, input: { ...current.policy, expectedRevision: current.policyRevision, exclusions: ['create-primitive'] } });
  const missing = inspectLifecycleSkillChecks(f).find(row => row.skill === 'create-primitive');
  assert.equal(missing.pass, false); assert.equal(missing.available, false);
  assert.equal(missing.remediation, 'capability-acquisition');
  assert.match(missing.hint, /consent|included/i);
});

test('source changes cannot make an unapproved core skill appear healthy', t => {
  const f = fixture(t); core.forEach(name => f.put(f.copilotHome, name)); f.configure();
  fs.appendFileSync(path.join(f.copilotHome, 'skills/ensure-plan/SKILL.md'), 'Changed after inclusion.\n');
  const row = inspectLifecycleSkillChecks(f).find(item => item.skill === 'ensure-plan');
  assert.equal(row.pass, false);
  assert.equal(row.available, false);
});

test('unconfigured doctor retains its original required autopilot presence checks', t => {
  const f = fixture(t);
  const legacy = ['ensure-plan', 'auto-compound', 'ensure-capability', 'auto-skill-draft'];
  const missing = inspectLifecycleSkillChecks(f);
  assert.equal(missing.length, legacy.length);
  assert.deepEqual(missing.map(row => row.name), legacy.map(name => `Autopilot skill /${name}`));
  assert.ok(missing.every(row => !row.optional && row.pass === false && row.hint === 'Run: ae upgrade'));
  legacy.forEach(name => f.put(f.copilotHome, name));
  assert.ok(inspectLifecycleSkillChecks(f).every(row => row.pass));
});
