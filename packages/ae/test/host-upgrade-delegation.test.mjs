import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { runHostSetup } from '../lib/hosts/setup.mjs';
import { hostResultOf, upgradeHostResultOf } from '../lib/hosts/command.mjs';
import { createHostResource, reconcilePersonalDelegation } from '../lib/hosts/personal-resource.mjs';
import { adoptCreatedCapability, authorizeCapabilityChange, configureDiscovery, discoveryPolicy } from '../lib/capability-catalog.mjs';
import { resourcesResultOf } from '../lib/resources-cmd.mjs';
import { createStructuredPrimitive } from '../lib/resource-validation.mjs';
import { reconcileCopilotDelegation } from '../lib/hosts/personal-resource.mjs';
import { writeLock } from '../lib/lock.mjs';

const packageRoot = path.resolve(import.meta.dirname, '..');
const canonical = name => `---\n${YAML.stringify({ name, description: 'Review the selected service behavior.', 'user-invocable': false, tools: ['read', 'search'], agents: [] })}---\n\n## Guardrails\nHonor the accepted scope and report concrete source evidence.\n`;
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-upgrade-delegation-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { host: 'claude-code', packageRoot, configHome: path.join(root, 'config'), skillsHome: path.join(root, 'skills'), home: path.join(root, 'state'), workspace: path.join(root, 'product') };
  fs.mkdirSync(options.workspace);
  assert.equal(runHostSetup({ ...options, verb: 'setup' }).status, 'ok');
  const external = path.join(root, 'external'); fs.mkdirSync(path.join(external, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(external, 'agents/foreign-reviewer.md'), '---\nname: foreign-reviewer\ndescription: Review external service behavior.\ntools: [Read]\n---\nReview supplied source evidence.\n');
  const catalog = { ...options, copilotHome: options.configHome };
  configureDiscovery({ ...catalog, input: { schema: 1, roots: [{ path: options.configHome, included: true, host: options.host }, { path: options.skillsHome, kind: 'skills', included: true, host: options.host }, { path: external, included: true, host: options.host }], ongoing: false, autoIncludeNew: false,
    grants: { create: ['agent'], tools: ['read', 'search'] } } });
  const name = 'delta-reviewer', created = createHostResource({ ...options, type: 'agent', name, input: { schema: 1, text: canonical(name) }, authorize: request => authorizeCapabilityChange({ ...catalog, ...request }) });
  const adopted = adoptCreatedCapability({ ...catalog, type: 'agent', name, path: created.primitive.path, expectedDigest: created.primitive.digest, expectedSourceDigest: created.primitive.sourceDigest, expectedPolicyRevision: created.authorization.policyRevision });
  assert.equal(reconcilePersonalDelegation({ ...options, name, expectedPolicyRevision: adopted.policyRevision }).status, 'ok');
  fs.writeFileSync(path.join(options.configHome, 'agents/unapproved-reviewer.md'), '---\nname: unapproved-reviewer\ndescription: Review unapproved behavior.\ntools: [Read]\n---\nReview supplied evidence.\n');
  const argv = ['--host', options.host, '--config-home', options.configHome, '--skills-home', options.skillsHome, '--ae-home', options.home, '--workspace', options.workspace, '--json'];
  const engineer = path.join(options.configHome, 'agents/engineer.md');
  return { ...options, catalog, name, argv, engineer, created };
}

test('native setup and upgrade preserve current approved acquired delegation and remove revoked targets', t => {
  const f = fixture(t);
  assert.ok(fs.readFileSync(f.engineer, 'utf8').includes('delta-reviewer'));
  const upgraded = upgradeHostResultOf(f.argv);
  assert.equal(upgraded.exitCode, 0, JSON.stringify(upgraded));
  assert.ok(fs.readFileSync(f.engineer, 'utf8').includes('delta-reviewer'));
  assert.doesNotMatch(fs.readFileSync(f.engineer, 'utf8'), /foreign-reviewer|unapproved-reviewer/);
  const setup = hostResultOf(['setup', ...f.argv]);
  assert.equal(setup.exitCode, 0, JSON.stringify(setup));
  assert.ok(fs.readFileSync(f.engineer, 'utf8').includes('delta-reviewer'));
  const current = discoveryPolicy(f.catalog);
  configureDiscovery({ ...f.catalog, input: { ...current.policy, expectedRevision: current.policyRevision, exclusions: [f.name, 'unapproved-reviewer'] } });
  assert.equal(upgradeHostResultOf(f.argv).exitCode, 0);
  assert.doesNotMatch(fs.readFileSync(f.engineer, 'utf8'), /delta-reviewer|foreign-reviewer|unapproved-reviewer/);
  assert.ok(fs.existsSync(f.created.primitive.path), 'revocation removes delegation without deleting a personal role');
});

test('native setup cannot publish a delegation selection after consent changes during projection', t => {
  const f = fixture(t), before = fs.readFileSync(f.engineer, 'utf8');
  const added = createHostResource({ ...f, type: 'agent', name: 'new-reviewer', input: { schema: 1, text: canonical('new-reviewer') }, authorize: request => authorizeCapabilityChange({ ...f.catalog, ...request }) });
  adoptCreatedCapability({ ...f.catalog, type: 'agent', name: 'new-reviewer', path: added.primitive.path, expectedDigest: added.primitive.digest, expectedSourceDigest: added.primitive.sourceDigest, expectedPolicyRevision: added.authorization.policyRevision });
  const original = fs.writeFileSync; let changed = false;
  fs.writeFileSync = function(file, ...args) {
    if (!changed && typeof file === 'string' && path.basename(file).startsWith('.engineer.md.ae-')) {
      changed = true; const current = discoveryPolicy(f.catalog);
      configureDiscovery({ ...f.catalog, input: { ...current.policy, expectedRevision: current.policyRevision, exclusions: [f.name] } });
    }
    return original.call(this, file, ...args);
  };
  let result;
  try { result = hostResultOf(['setup', ...f.argv]); }
  finally { fs.writeFileSync = original; }
  assert.equal(changed, true);
  assert.notEqual(result.exitCode, 0, result.reason);
  assert.match(result.reason, /consent|policy.*changed/i);
  assert.equal(fs.readFileSync(f.engineer, 'utf8'), before);
});

test('initial explicit consent reconciles an existing selected native role without a creation workflow', async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-existing-role-consent-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { host: 'claude-code', packageRoot, configHome: path.join(root, 'config'), skillsHome: path.join(root, 'skills'), home: path.join(root, 'state'), workspace: path.join(root, 'product') };
  fs.mkdirSync(options.workspace);
  assert.equal(runHostSetup({ ...options, verb: 'setup' }).status, 'ok');
  fs.writeFileSync(path.join(options.configHome, 'agents/enterprise-reviewer.md'), '---\nname: enterprise-reviewer\ndescription: Review enterprise behavior.\ntools: [Read]\n---\nReview the selected source evidence.\n');
  const input = path.join(options.workspace, 'consent.json'); fs.writeFileSync(input, JSON.stringify({ schema: 1, operation: 'configure', roots: [{ path: options.configHome, host: options.host, included: true }], ongoing: false, autoIncludeNew: false }));
  const result = await resourcesResultOf(['discover', '--file', input, '--copilot-home', options.configHome, '--skills-home', options.skillsHome, '--ae-home', options.home, '--workspace', options.workspace, '--json']);
  assert.equal(result.delegation.state, 'pending-reload', result.delegation.reason);
  assert.ok(fs.readFileSync(path.join(options.configHome, 'agents/engineer.md'), 'utf8').includes('enterprise-reviewer'));
});

test('explicit consented scan reconciles new allowed roles and revocation while queries leave profiles unchanged', async t => {
  const f = fixture(t), current = discoveryPolicy(f.catalog);
  configureDiscovery({ ...f.catalog, input: { ...current.policy, expectedRevision: current.policyRevision, ongoing: true, autoIncludeNew: true, exclusions: ['unapproved-reviewer'] } });
  fs.writeFileSync(path.join(f.configHome, 'agents/scanned-reviewer.md'), '---\nname: scanned-reviewer\ndescription: Review newly added enterprise behavior.\ntools: [Read]\n---\nReview the selected source evidence.\n');
  fs.writeFileSync(path.join(f.configHome, 'agents/power-reviewer.md'), '---\nname: power-reviewer\ndescription: Execute elevated enterprise commands.\ntools: [Bash]\n---\nExecute the selected commands.\n');
  const input = path.join(f.workspace, 'discovery.json');
  const call = async value => {
    fs.writeFileSync(input, JSON.stringify(value));
    return resourcesResultOf(['discover', '--file', input, '--copilot-home', f.configHome, '--skills-home', f.skillsHome, '--ae-home', f.home, '--workspace', f.workspace, '--json']);
  };
  const before = fs.readFileSync(f.engineer, 'utf8');
  const queried = await call({ schema: 1, operation: 'query', query: 'scanned-reviewer', taskId: 'scan-consultation' });
  assert.ok(queried.resources.some(resource => resource.id === 'scanned-reviewer'));
  assert.equal(fs.readFileSync(f.engineer, 'utf8'), before, 'catalog query must not publish profile delegation');
  await call({ schema: 1, operation: 'status' });
  assert.equal(fs.readFileSync(f.engineer, 'utf8'), before);
  const scan = () => {
    const result = spawnSync(process.execPath, [path.join(packageRoot, 'bin/ae.mjs'), 'resources', 'discover', '--refresh', '--query', 'scanned-reviewer', '--copilot-home', f.configHome, '--skills-home', f.skillsHome, '--ae-home', f.home, '--workspace', f.workspace, '--json'], { encoding: 'utf8', env: { ...process.env, HARNESS_NO_EVENTS: '1' }, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const controlArgs = ['resources', 'discover', '--refresh', '--query', 'scanned-reviewer', '--copilot-home', f.configHome, '--skills-home', f.skillsHome, '--ae-home', f.home, '--workspace', f.workspace, '--json'];
  const preHook = args => {
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const command = [process.execPath, path.join(packageRoot, 'bin/ae.mjs'), ...args].map(quote).join(' ');
    const result = spawnSync(process.execPath, [path.join(packageRoot, 'corpus/hooks/require-plan-gate.mjs')], { cwd: f.workspace, encoding: 'utf8',
      env: { ...process.env, AE_BIN: path.join(packageRoot, 'bin/ae.mjs'), AE_HOME: f.home, HARNESS_HOME: f.home, COPILOT_HOME: f.configHome, AE_SKILLS_HOME: f.skillsHome, AE_HOST: f.host, HARNESS_NO_EVENTS: '1' },
      input: JSON.stringify({ workspace: f.workspace, session_id: 'scan-native-session', tool_name: 'Bash', tool_input: { command } }), timeout: 15000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout.trim().split('\n').at(-1));
  };
  assert.equal(preHook(controlArgs).continue, true, 'the immutable scan can resolve a capability before the implement gate');
  const mutable = preHook(['resources', 'discover', '--file', input, '--copilot-home', f.configHome, '--skills-home', f.skillsHome, '--ae-home', f.home, '--workspace', f.workspace, '--json']);
  assert.equal(mutable.hookSpecificOutput?.permissionDecision, 'deny', 'a file cannot switch an admitted scan into consent configuration');
  const scanned = scan();
  assert.equal(scanned.delegation.state, 'pending-reload', scanned.delegation.reason);
  assert.equal(scanned.reload.observed, false);
  assert.ok(fs.readFileSync(f.engineer, 'utf8').includes('scanned-reviewer'));
  assert.equal(/foreign-reviewer|unapproved-reviewer|power-reviewer/.test(fs.readFileSync(f.engineer, 'utf8')), false);
  const policy = discoveryPolicy(f.catalog);
  configureDiscovery({ ...f.catalog, input: { ...policy.policy, expectedRevision: policy.policyRevision, exclusions: ['unapproved-reviewer', 'power-reviewer', 'scanned-reviewer'] } });
  const revoked = scan();
  assert.equal(revoked.delegation.state, 'pending-reload');
  assert.equal(fs.readFileSync(f.engineer, 'utf8').includes('scanned-reviewer'), false);
  await assert.rejects(() => call({ schema: 1, operation: 'scan', grants: { tools: ['execute'] } }), /unknown|schema|bounded/i);
  await assert.rejects(() => resourcesResultOf(['discover', '--refresh', '--file', input, '--copilot-home', f.configHome, '--ae-home', f.home, '--workspace', f.workspace]), /--refresh.*without --file/);
});

test('legacy Copilot upgrade carries approved acquired delegation forward and removes revoked roles', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-copilot-upgrade-delegation-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const copilotHome = path.join(root, 'copilot'), home = path.join(root, 'state'), workspace = path.join(root, 'product');
  fs.mkdirSync(path.join(copilotHome, 'agents'), { recursive: true }); fs.mkdirSync(workspace);
  const engineer = path.join(copilotHome, 'agents/engineer.agent.md'); fs.copyFileSync(path.join(packageRoot, 'corpus/agents/engineer.agent.md'), engineer);
  writeLock(copilotHome, { lockVersion: 2, installationRoot: copilotHome, package: 'ae-harness', targets: ['cli'], files: ['agents/engineer.agent.md'] });
  const options = { home, copilotHome, host: 'copilot', workspace };
  configureDiscovery({ ...options, input: { schema: 1, roots: [{ path: copilotHome, host: 'copilot', included: true }], ongoing: false, autoIncludeNew: false, grants: { create: ['agent'], tools: ['read', 'search'] } } });
  const created = createStructuredPrimitive({ copilotHome, home, flags: { workspace }, type: 'agent', name: 'delta-reviewer', input: { schema: 1, text: canonical('delta-reviewer') }, shippedFiles: new Set(), lockFiles: new Set(), authorize: request => authorizeCapabilityChange({ ...options, ...request }) });
  const adopted = adoptCreatedCapability({ ...options, type: 'agent', name: 'delta-reviewer', path: path.join(copilotHome, created.primitive.path), expectedDigest: created.primitive.digest, expectedPolicyRevision: created.authorization.policyRevision });
  assert.equal(reconcileCopilotDelegation({ configHome: copilotHome, home, name: 'delta-reviewer', expectedPolicyRevision: adopted.policyRevision }).status, 'ok');
  const upgrade = () => {
    const result = spawnSync(process.execPath, [path.join(packageRoot, 'bin/ae.mjs'), 'upgrade', '--target', 'cli', '--copilot-home', copilotHome, '--ae-home', home, '--workspace', workspace, '--json'], { encoding: 'utf8', env: { ...process.env, AE_HOST: 'copilot', AE_SKILLS_HOME: '', HARNESS_NO_EVENTS: '1' }, timeout: 30000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const updated = upgrade();
  assert.equal(updated.delegation[0].state, 'pending-reload');
  assert.ok(fs.readFileSync(engineer, 'utf8').includes('delta-reviewer'));
  const validate = () => spawnSync(process.execPath, [path.join(packageRoot, 'bin/ae.mjs'), 'resources', 'validate', '--copilot-home', copilotHome, '--ae-home', home, '--workspace', workspace, '--json'], { encoding: 'utf8', env: { ...process.env, AE_HOST: 'copilot', AE_SKILLS_HOME: '', HARNESS_NO_EVENTS: '1' }, timeout: 30000 });
  const valid = validate(); assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  const projection = path.join(copilotHome, 'harness/engineer-delegation.json'), projectionBefore = fs.readFileSync(projection, 'utf8'), engineerBefore = fs.readFileSync(engineer, 'utf8');
  const altered = JSON.parse(projectionBefore); altered.sources[0].digest = `sha256-${'0'.repeat(64)}`;
  fs.writeFileSync(projection, JSON.stringify(altered)); assert.notEqual(validate().status, 0, 'forged source projection must fail validation');
  fs.writeFileSync(projection, projectionBefore);
  fs.appendFileSync(engineer, '\nUnprojected user change.\n'); assert.notEqual(validate().status, 0, 'unprojected Engineer bytes must fail validation');
  fs.writeFileSync(engineer, engineerBefore);
  const current = discoveryPolicy(options);
  configureDiscovery({ ...options, input: { ...current.policy, expectedRevision: current.policyRevision, exclusions: ['delta-reviewer'] } });
  assert.notEqual(validate().status, 0, 'revoked source consent must invalidate the old dynamic projection');
  upgrade(); assert.equal(fs.readFileSync(engineer, 'utf8').includes('delta-reviewer'), false);
  assert.equal(validate().status, 0);
  assert.ok(fs.existsSync(path.join(copilotHome, created.primitive.path)));
});
