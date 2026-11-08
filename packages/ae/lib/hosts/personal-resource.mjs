import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { createHash } from 'node:crypto';
import { assertNoSymlinkAncestors, readFileNoFollow, writeFileContained } from '../fs-safe.mjs';
import { validatePrimitiveContent } from '../resource-validation.mjs';
import { createHostSkill, personalHostBinding } from './personal-skill.mjs';
import { nativeAgentAsset, nativeInstructionAsset, splitNativeSource } from './native-resource.mjs';
import { discoverCapabilities, discoveryPolicy } from '../capability-catalog.mjs';
import { runHostSetup } from './setup.mjs';
import { personalResourceAuthorization, personalResourcePermissions } from './personal-authorization.mjs';
import { registeredPath } from '../local-primitives.mjs';
import { withPlanUpdateLock } from '../plan-update.mjs';
import { getCorpusRoot } from '../assets.mjs';
import { LOCK_NAME, readLock } from '../lock.mjs';

export const PERSONAL_RESOURCES_FILE = '.ae-personal-resources.json';
const canonical = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hash = text => `sha256-${createHash('sha256').update(text).digest('hex')}`;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => Object.assign(new Error(message), { code: 'E_USAGE', exit: 2, hint: 'ae host status --host <host>; ae resources list' });

export function readPersonalResources({ configHome, skillsHome, host }) {
  if (!assertNoSymlinkAncestors(configHome, PERSONAL_RESOURCES_FILE)) throw fail('Personal resource registry is unsafe or redirected');
  const full = path.join(configHome, PERSONAL_RESOURCES_FILE), exists = fs.lstatSync(full, { throwIfNoEntry: false });
  const text = readFileNoFollow(full, { root: configHome, maxBytes: 1024 * 1024 });
  if (!exists) return { schema: 1, host, configHome, skillsHome, resources: {} };
  let value;
  try { value = JSON.parse(text); } catch { throw fail('Personal resource registry is malformed or unreadable'); }
  if (!object(value) || value.schema !== 1 || value.host !== host || value.configHome !== configHome || value.skillsHome !== skillsHome || !object(value.resources)) throw fail('Personal resource registry does not match selected roots');
  for (const [key, entry] of Object.entries(value.resources)) {
    if (!object(entry) || !['agent', 'instruction'].includes(entry.type) || !canonical.test(entry.name || '') || key !== `${entry.type}:${entry.name}`
      || typeof entry.path !== 'string' || path.isAbsolute(entry.path) || entry.path.includes('\\') || entry.path.split('/').some(part => !part || part === '.' || part === '..')
      || !/^sha256-[a-f0-9]{64}$/.test(entry.digest || '') || !/^sha256-[a-f0-9]{64}$/.test(entry.sourceDigest || '')
      || typeof entry.sourceText !== 'string' || Buffer.byteLength(entry.sourceText) > 65536 || hash(entry.sourceText) !== entry.sourceDigest) throw fail('Personal resource registry contains an invalid source binding');
  }
  return value;
}

const translated = (text, configHome, skillsHome) => text.replaceAll('<copilot-home>/skills', skillsHome).replaceAll('~/.copilot/skills', skillsHome)
  .replaceAll('<copilot-home>', configHome).replaceAll('~/.copilot', configHome).replaceAll('<skills-root>', skillsHome);

/** A native personal writer; installation, authorization and live invocation remain distinct. */
export function createHostResource({ type, name, input, configHome, skillsHome, home, yes = false, dryRun = false, authorize }) {
  if (type === 'skill') return createHostSkill({ name, input, configHome, skillsHome, home, yes, dryRun, authorize });
  if (!['agent', 'instruction'].includes(type) || !canonical.test(name || '')) throw fail('Use a personal agent or instruction with a canonical kebab-case name');
  if (!object(input) || input.schema !== 1 || Object.keys(input).some(key => !['schema', 'text', 'expectedDigest', 'expectedSourceDigest'].includes(key))) throw fail('Personal resource input requires schema 1, text and optional expectedDigest/expectedSourceDigest; payload approval is not authority');
  input = { ...input };
  if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > 65536) throw fail('Canonical personal resource text must be UTF-8 text of at most 64 KiB');
  if (input.expectedDigest !== undefined && !/^sha256-[a-f0-9]{64}$/.test(input.expectedDigest)) throw fail('Personal resource expectedDigest must be a sha256 digest');
  if (input.expectedSourceDigest !== undefined && !/^sha256-[a-f0-9]{64}$/.test(input.expectedSourceDigest)) throw fail('Personal resource expectedSourceDigest must be a sha256 digest');
  const binding = personalHostBinding({ configHome, skillsHome });
  const { manifest } = binding; configHome = binding.configHome; skillsHome = binding.skillsHome;
  let doc;
  try { doc = splitNativeSource(input.text); }
  catch (error) { throw fail(`Canonical personal resource frontmatter is invalid: ${error.message}`); }
  if (!object(doc.metadata)) throw fail('Canonical personal resource frontmatter must be a mapping');
  const permissions = personalResourcePermissions({ text: input.text, metadata: doc.metadata, host: manifest.host, type });
  const asset = type === 'agent'
    ? nativeAgentAsset({ host: manifest.host, name, metadata: doc.metadata, body: translated(doc.body, configHome, skillsHome) })
    : nativeInstructionAsset({ host: manifest.host, name, metadata: doc.metadata, body: translated(doc.body, configHome, skillsHome) });
  const full = path.join(configHome, asset.path), key = `${type}:${name}`;
  const validation = validatePrimitiveContent({ type, name, text: input.text, root: configHome, rel: asset.path });
  if (!validation.valid) throw fail(validation.errors.join('; '));
  if (type === 'agent' && validation.frontmatter.agents.length && !validation.frontmatter.tools.includes('agent')) throw fail('Delegation targets require declared agent tool authority');
  const perform = () => {
    const ownership = [[configHome, '.ae-host.json'], [skillsHome, '.ae-host-skills.json']].map(([root, rel]) => ({ root, rel, text: readFileNoFollow(path.join(root, rel), { root, maxBytes: 1024 * 1024 }) }));
    const assertOwnership = () => {
      if (ownership.some(item => item.text === null || readFileNoFollow(path.join(item.root, item.rel), { root: item.root, maxBytes: 1024 * 1024 }) !== item.text)) throw fail('Host ownership binding changed during personal resource publication');
    };
    const currentBinding = personalHostBinding({ configHome, skillsHome });
    assertOwnership();
    if (currentBinding.manifest.host !== manifest.host) throw fail('Host binding changed before publication');
    if (currentBinding.manifest.files.some(file => file.root === 'config' && file.path === asset.path)) throw fail(`${name} is a setup-managed shipped resource; personal writes cannot replace it`);
    if (!assertNoSymlinkAncestors(configHome, asset.path)) throw fail('Personal resource destination is unsafe or redirected');
    const registryPath = path.join(configHome, PERSONAL_RESOURCES_FILE);
    const registryBefore = readFileNoFollow(registryPath, { root: configHome, maxBytes: 1024 * 1024 });
    const registry = readPersonalResources({ configHome, skillsHome, host: manifest.host });
    if (readFileNoFollow(registryPath, { root: configHome, maxBytes: 1024 * 1024 }) !== registryBefore) throw fail('Personal source registry changed during inspection');
    const record = registry.resources[key];
    if (record && record.path !== asset.path) throw fail('Personal resource destination differs from its source binding');
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    const prior = stat ? readFileNoFollow(full, { root: configHome, maxBytes: 65536 }) : null;
    if (stat && prior === null) throw fail('Personal resource destination is unsafe or unreadable');
    if (prior !== null && !record) throw fail('Existing native resource is unowned; adopt it explicitly before personal replacement');
    const previousDigest = prior === null ? null : hash(prior);
    if (input.expectedDigest !== undefined && previousDigest !== input.expectedDigest) throw fail('Expected personal resource bytes are stale');
    if (input.expectedSourceDigest !== undefined && record?.sourceDigest !== input.expectedSourceDigest) throw fail('Expected personal resource source metadata is stale');
    if (record && previousDigest !== record.digest) throw fail('Personal resource changed outside its recorded source binding; inspect before replacement');
    if (prior !== null && asset.content !== prior && input.expectedDigest === undefined) throw fail('Replacing a personal resource requires its expectedDigest');
    if (record && asset.content === prior && record.sourceDigest !== hash(input.text) && input.expectedSourceDigest === undefined) throw fail('Changing source metadata without changing native bytes requires expectedSourceDigest');
    const operation = prior === null ? 'create' : 'update';
    const permission = { operation, type, name, path: full, ...permissions, previousDigest, home, copilotHome: configHome, skillsHome, host: manifest.host };
    const authorization = personalResourceAuthorization({ home, configHome, skillsHome, host: manifest.host, request: permission, yes, authorize });
    assertOwnership();
    for (const target of type === 'agent' ? validation.frontmatter.agents : []) {
      const targetPath = nativeAgentAsset({ host: manifest.host, name: target, metadata: {}, body: '' }).path;
      if (readFileNoFollow(path.join(configHome, targetPath), { root: configHome, maxBytes: 65536 }) === null) throw fail(`Delegation target is absent or unsafe: ${target}`);
    }
    const changed = prior !== asset.content || record?.sourceDigest !== hash(input.text);
    const primitive = { path: full, name, kind: type, digest: hash(asset.content), sourceDigest: hash(input.text), state: dryRun ? 'preview' : !changed ? 'unchanged' : prior === null ? 'created' : 'replaced' };
    const activation = { state: dryRun ? 'preview' : asset.mode === 'manual' ? 'manual' : asset.mode === 'context-routed' ? 'context-routed' : 'pending-reload',
      reason: asset.mode === 'native' ? 'Native asset is published; confirm host reload and actual invocation before claiming activation.' : 'Supply this instruction or role through selected task context; no native scoped loader is claimed.' };
    if (!dryRun && changed) {
      registry.resources[key] = { type, name, path: asset.path, digest: primitive.digest, sourceDigest: primitive.sourceDigest, sourceText: input.text, tools: permission.tools, agents: permission.agents, activation };
      const registryText = `${JSON.stringify(registry, null, 2)}\n`;
      if (Buffer.byteLength(registryText) > 1024 * 1024) throw fail('Personal resource registry exceeds 1 MiB');
      const current = fs.lstatSync(full, { throwIfNoEntry: false }) ? readFileNoFollow(full, { root: configHome, maxBytes: 65536 }) : null;
      if (current !== prior) throw fail('Personal resource changed before publication');
      assertOwnership();
      authorization.assertCurrent();
      if (readFileNoFollow(registryPath, { root: configHome, maxBytes: 1024 * 1024 }) !== registryBefore) throw fail('Personal source registry changed before publication');
      if (!writeFileContained(configHome, asset.path, asset.content, { exclusive: prior === null, mode: 0o600 })) throw fail('Personal resource publication was refused');
      let registryPublished = false;
      try {
        assertOwnership();
        authorization.assertCurrent();
        if (readFileNoFollow(registryPath, { root: configHome, maxBytes: 1024 * 1024 }) !== registryBefore) throw fail('Personal source registry changed during publication');
        if (!writeFileContained(configHome, PERSONAL_RESOURCES_FILE, registryText, { mode: 0o600 })) throw fail('Personal resource source binding could not be published');
        registryPublished = true;
        assertOwnership();
        authorization.assertCurrent();
      } catch (error) {
        // Never restore over a concurrent external edit.
        if (registryPublished && readFileNoFollow(registryPath, { root: configHome, maxBytes: 1024 * 1024 }) === registryText) {
          if (registryBefore === null) fs.unlinkSync(registryPath);
          else writeFileContained(configHome, PERSONAL_RESOURCES_FILE, registryBefore, { mode: 0o600 });
        }
        if (readFileNoFollow(full, { root: configHome, maxBytes: 65536 }) === asset.content) {
          if (prior === null) fs.unlinkSync(full);
          else writeFileContained(configHome, asset.path, prior, { mode: 0o600 });
        }
        throw error;
      }
    }
    return { schema: 1, verb: 'create', status: 'ok', exitCode: 0, validation, dryRun: Boolean(dryRun), primitive, activated: false, activation,
      authorization: authorization.record,
      nativeQualification: 'unverified', permissionIsolation: manifest.host === 'claude-code' ? 'declared-native-tools' : 'inherits-host-authority',
      delegation: type === 'agent' ? { state: manifest.host === 'claude-code' ? 'requires-approved-reconciliation' : activation.state, agent: name } : null };
  };
  if (dryRun) return perform();
  const locks = [...new Set([path.join(configHome, '.ae-host.lock'), path.join(skillsHome, '.ae-host-skills.lock')])].sort(), acquired = [];
  try {
    for (const lock of locks) {
      const root = lock.startsWith(skillsHome + path.sep) ? skillsHome : configHome;
      if (!assertNoSymlinkAncestors(root, path.relative(root, lock))) throw fail('Personal resource ownership lock is unsafe');
      try { fs.mkdirSync(lock, { mode: 0o700 }); acquired.push(lock); }
      catch (error) { if (error.code === 'EEXIST') throw fail('Host resources are being updated; retry after setup or removal finishes'); throw error; }
    }
    return perform();
  } finally { for (const lock of acquired.reverse()) fs.rmdirSync(lock); }
}

/** Source-bound extra roles shared by consent, setup and upgrade; factory roles stay in the corpus projection. */
export function personalDelegationSelection({ configHome, skillsHome = path.join(configHome, 'skills'), home, host, packageRoot, expectedPolicyRevision }) {
  configHome = path.resolve(configHome); skillsHome = path.resolve(skillsHome);
  const options = { home, copilotHome: configHome, skillsHome, host };
  const consent = discoveryPolicy(options);
  if (expectedPolicyRevision !== undefined && consent.policyRevision !== expectedPolicyRevision) throw fail('Discovery policy revision changed before delegation selection');
  const corpus = packageRoot ? path.join(packageRoot, 'corpus') : getCorpusRoot();
  const factory = new Set(fs.readdirSync(path.join(corpus, 'agents')).filter(file => file.endsWith('.agent.md')).map(file => file.slice(0, -9)));
  const legacy = ['copilot', 'vscode', 'cli', 'intellij'].includes(host);
  const agentsNow = () => !consent.configured ? [] : discoverCapabilities({ ...options, query: '', limit: 2000, onboarding: false }).resources.filter(resource => {
    if (resource.kind !== 'agent' || !resource.current || !resource.valid || !resource.included || resource.host !== host || factory.has(resource.id)) return false;
    const relative = legacy ? `agents/${resource.id}.agent.md` : nativeAgentAsset({ host, name: resource.id, metadata: {}, body: '' }).path;
    return resource.path === path.join(configHome, relative);
  }).sort((a, b) => a.path.localeCompare(b.path));
  const agents = agentsNow();
  const binding = values => JSON.stringify(values.map(resource => ({ id: resource.id, path: resource.path, digest: resource.digest, sourceDigest: resource.sourceDigest || null })));
  const expected = binding(agents);
  const validatePublication = () => {
    const current = discoveryPolicy(options);
    if (current.configured !== consent.configured || current.policyRevision !== consent.policyRevision) throw fail('Discovery policy revision changed during delegation publication');
    if (binding(agentsNow()) !== expected) throw fail('Approved specialist source changed during delegation publication');
  };
  validatePublication();
  return { configured: consent.configured, policyRevision: consent.policyRevision, agents, personalAgents: agents.map(resource => resource.id), validatePublication };
}

/** Reconcile approved native agent delegation through setup's existing ownership transaction. */
export function reconcilePersonalDelegation({ configHome, skillsHome, home, name, expectedPolicyRevision, dryRun = false }) {
  const { manifest, configHome: config, skillsHome: skills } = personalHostBinding({ configHome, skillsHome });
  const options = { home, copilotHome: config, skillsHome: skills, host: manifest.host };
  const consent = discoveryPolicy(options);
  const pending = reason => ({ status: 'pending', state: 'requires-approved-reconciliation', agent: name, reason, activated: false, nativeQualification: 'unverified' });
  if (!consent.configured) return pending('Configure source inclusion before changing Engineer delegation.');
  if (expectedPolicyRevision !== undefined && expectedPolicyRevision !== consent.policyRevision) throw fail('Discovery policy revision changed before delegation reconciliation');
  const selection = personalDelegationSelection({ configHome: config, skillsHome: skills, home, host: manifest.host, packageRoot: manifest.packageRoot, expectedPolicyRevision });
  const agents = selection.agents;
  if (name && !agents.some(resource => resource.id === name)) return pending('The created agent is not currently included under selected native host consent.');
  if (manifest.host === 'terminal') return { ...pending('Terminal integration has no isolated native agent invocation.'), state: 'manual' };
  const validatePublication = () => {
    selection.validatePublication();
    if (discoveryPolicy(options).policyRevision !== consent.policyRevision) throw fail('Discovery policy revision changed during delegation reconciliation');
    const personal = readPersonalResources({ configHome: config, skillsHome: skills, host: manifest.host });
    for (const resource of agents) {
      const text = readFileNoFollow(resource.path, { root: config, maxBytes: 65536 });
      if (text === null || hash(text) !== resource.digest) throw fail('Approved native agent changed during delegation reconciliation');
      const source = personal.resources[`agent:${resource.id}`];
      if (resource.sourceDigest && (!source || source.sourceDigest !== resource.sourceDigest || source.digest !== resource.digest || path.join(config, source.path) !== resource.path)) throw fail('Approved native agent source metadata changed during delegation reconciliation');
    }
  };
  validatePublication();
  const status = runHostSetup({ verb: 'status', host: manifest.host, configHome: config, skillsHome: skills, home, packageRoot: manifest.packageRoot, requireExisting: true });
  if (status.status !== 'ok' || status.assetState !== 'current') return pending(status.reason || `Host assets are ${status.assetState}; preserve changes and reconcile the integration first.`);
  const result = runHostSetup({ verb: 'setup', host: manifest.host, configHome: config, skillsHome: skills, home,
    packageRoot: manifest.packageRoot, requireExisting: true, personalAgents: agents.map(resource => resource.id), dryRun, validatePublication });
  return { status: result.status, state: result.status === 'ok' ? dryRun ? 'preview' : 'pending-reload' : 'requires-approved-reconciliation', agent: name,
    reason: result.reason || 'Approved Engineer delegation was projected; confirm native reload and actual agent invocation.', actions: result.actions,
    conflicts: result.conflicts, activated: false, nativeQualification: 'unverified', policyRevision: consent.policyRevision };
}

/** Copilot's canonical frontmatter has a separate, source-bound managed projection. */
export function reconcileCopilotDelegation({ configHome, skillsHome = path.join(configHome, 'skills'), home, host = process.env.AE_HOST || 'copilot', name, expectedPolicyRevision, dryRun = false }) {
  configHome = path.resolve(configHome); skillsHome = path.resolve(skillsHome);
  const options = { home, copilotHome: configHome, skillsHome, host };
  const pending = reason => ({ status: 'pending', state: 'requires-approved-reconciliation', agent: name, reason, activated: false, nativeQualification: 'unverified' });
  const perform = () => {
    const consent = discoveryPolicy(options);
    if (!consent.configured) return pending('Configure source inclusion before changing Copilot Engineer delegation.');
    if (expectedPolicyRevision !== undefined && expectedPolicyRevision !== consent.policyRevision) throw fail('Discovery policy revision changed before Copilot delegation reconciliation');
    const lock = readLock(configHome, { strict: true }), engineerRel = 'agents/engineer.agent.md', projectionRel = 'harness/engineer-delegation.json';
    if (lock?.lockVersion !== 2 || !lock.files.includes(engineerRel) || !lock.targets.some(target => ['cli', 'vscode', 'intellij'].includes(target))) return pending('Copilot Engineer does not have current root-bound managed ownership.');
    const lockBefore = readFileNoFollow(path.join(configHome, LOCK_NAME), { root: configHome, maxBytes: 1024 * 1024 });
    const corpus = getCorpusRoot(), basePath = path.join(corpus, engineerRel), base = readFileNoFollow(basePath, { root: corpus, maxBytes: 65536 });
    const prior = readFileNoFollow(path.join(configHome, engineerRel), { root: configHome, maxBytes: 65536 });
    const projectionBefore = readFileNoFollow(path.join(configHome, projectionRel), { root: configHome, maxBytes: 1024 * 1024 });
    if (base === null || prior === null) return pending('The current shipped and installed Engineer sources are unavailable or unsafe.');
    const render = names => {
      if (!names.length) return base;
      const split = splitNativeSource(base);
      if (!Array.isArray(split.metadata.agents) || !split.metadata.tools?.includes('agent')) throw fail('Shipped Engineer lacks explicit native delegation authority');
      split.metadata.agents = [...new Set([...split.metadata.agents, ...names])].sort();
      return `---\n${YAML.stringify(split.metadata)}---\n${split.body}`;
    };
    if (prior !== base) {
      let previous;
      try { previous = JSON.parse(projectionBefore); } catch { return pending('Preserve the edited Engineer; its prior managed projection is unavailable.'); }
      if (previous?.schema !== 1 || previous.configHome !== configHome || previous.baseDigest !== hash(base) || previous.digest !== hash(prior)
        || !Array.isArray(previous.agents) || previous.agents.some(agent => !canonical.test(agent)) || prior !== render(previous.agents)) return pending('Preserve the edited or outdated Engineer and reconcile it with the current shipped source first.');
    }
    const selection = personalDelegationSelection({ configHome, skillsHome, home, host, expectedPolicyRevision });
    const agents = selection.agents;
    if (name && !agents.some(resource => resource.id === name)) return pending('The created Copilot role is not included under current source consent.');
    const names = agents.map(resource => resource.id).sort(), content = render(names);
    if (!names.length && prior === base && projectionBefore === null) return { status: 'ok', state: 'unchanged', activated: false, nativeQualification: 'unverified', policyRevision: consent.policyRevision };
    const after = `${JSON.stringify({ schema: 1, configHome, baseDigest: hash(base), digest: hash(content), agents: names, policyRevision: consent.policyRevision,
      sources: agents.map(resource => ({ id: resource.id, path: resource.path, digest: resource.digest, sourceDigest: resource.sourceDigest || null })) }, null, 2)}\n`;
    const validate = (engineer, projection) => {
      selection.validatePublication();
      if (discoveryPolicy(options).policyRevision !== consent.policyRevision) throw fail('Discovery policy revision changed during Copilot delegation publication');
      if (readFileNoFollow(path.join(configHome, LOCK_NAME), { root: configHome, maxBytes: 1024 * 1024 }) !== lockBefore || readFileNoFollow(basePath, { root: corpus, maxBytes: 65536 }) !== base) throw fail('Copilot ownership or shipped Engineer changed during delegation publication');
      if (readFileNoFollow(path.join(configHome, engineerRel), { root: configHome, maxBytes: 65536 }) !== engineer || readFileNoFollow(path.join(configHome, projectionRel), { root: configHome, maxBytes: 1024 * 1024 }) !== projection) throw fail('Copilot Engineer or delegation projection changed during publication');
      for (const resource of agents) {
        const text = readFileNoFollow(resource.path, { root: configHome, maxBytes: 65536 });
        if (text === null || hash(text) !== resource.digest) throw fail('Approved Copilot specialist source changed during delegation publication');
      }
    };
    validate(prior, projectionBefore);
    if (!dryRun && (content !== prior || after !== projectionBefore)) {
      if (!writeFileContained(configHome, engineerRel, content)) throw fail('Copilot Engineer delegation publication failed');
      try {
        validate(content, projectionBefore);
        if (!writeFileContained(configHome, projectionRel, after, { mode: 0o600 })) throw fail('Copilot delegation source binding publication failed');
        validate(content, after);
      } catch (error) {
        if (readFileNoFollow(path.join(configHome, projectionRel), { root: configHome, maxBytes: 1024 * 1024 }) === after) {
          if (projectionBefore === null) fs.unlinkSync(path.join(configHome, projectionRel));
          else writeFileContained(configHome, projectionRel, projectionBefore, { mode: 0o600 });
        }
        if (readFileNoFollow(path.join(configHome, engineerRel), { root: configHome, maxBytes: 65536 }) === content) writeFileContained(configHome, engineerRel, prior);
        throw error;
      }
    }
    return { status: 'ok', state: dryRun ? 'preview' : 'pending-reload', agent: name, activated: false, nativeQualification: 'unverified', policyRevision: consent.policyRevision,
      engineerDigest: hash(content), reason: 'Approved current specialists were projected into managed Copilot Engineer delegation; native reload and actual invocation remain unverified.' };
  };
  return dryRun ? perform() : withPlanUpdateLock(registeredPath(configHome), perform);
}

/** Bulk reconciliation after explicit inclusion or installation; preserve unsafe or edited ownership. */
export function reconcileApprovedDelegation(options) {
  try {
    const consent = discoveryPolicy({ home: options.home, copilotHome: options.configHome, skillsHome: options.skillsHome, host: options.host });
    if (!consent.configured) return { status: 'pending', state: 'needs-consent', activated: false, nativeQualification: 'unverified' };
    const selected = { ...options, host: consent.binding.host, expectedPolicyRevision: options.expectedPolicyRevision ?? consent.policyRevision };
    return ['copilot', 'vscode', 'cli', 'intellij'].includes(selected.host) ? reconcileCopilotDelegation(selected) : reconcilePersonalDelegation(selected);
  } catch (error) { return { status: 'pending', state: 'requires-approved-reconciliation', reason: error.message, activated: false, nativeQualification: 'unverified' }; }
}

/** Installed Copilot validation reads effective delegation without modifying factory registry data. */
export function inspectCopilotDelegation({ configHome, skillsHome = path.join(configHome, 'skills'), home, host }) {
  const relative = 'harness/engineer-delegation.json', file = path.join(configHome, relative);
  if (!assertNoSymlinkAncestors(configHome, relative)) return { present: true, valid: false, reason: 'Copilot delegation projection is redirected', personalAgents: [] };
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return { present: false, valid: true, personalAgents: [] };
  try {
    if (!assertNoSymlinkAncestors(configHome, relative)) throw fail('Copilot delegation projection is redirected');
    const raw = readFileNoFollow(file, { root: configHome, maxBytes: 1024 * 1024 }), projection = JSON.parse(raw);
    const snapshot = discoveryPolicy({ copilotHome: configHome, skillsHome, home, host });
    if (!snapshot.configured || projection?.policyRevision !== snapshot.policyRevision) throw fail('Copilot delegation projection consent is stale');
    const selected = personalDelegationSelection({ configHome, skillsHome, home, host: snapshot.binding.host, expectedPolicyRevision: snapshot.policyRevision });
    const expectedSources = selected.agents.map(resource => ({ id: resource.id, path: resource.path, digest: resource.digest, sourceDigest: resource.sourceDigest || null }));
    if (JSON.stringify(projection.agents) !== JSON.stringify([...selected.personalAgents].sort()) || JSON.stringify(projection.sources) !== JSON.stringify(expectedSources)) throw fail('Copilot delegation projection sources are stale or forged');
    const preview = reconcileCopilotDelegation({ configHome, skillsHome, home, host: snapshot.binding.host, expectedPolicyRevision: snapshot.policyRevision, dryRun: true });
    const current = readFileNoFollow(path.join(configHome, 'agents/engineer.agent.md'), { root: configHome, maxBytes: 65536 });
    if (preview.status !== 'ok' || !current || preview.engineerDigest !== hash(current)) throw fail(preview.reason || 'Copilot Engineer differs from its current approved projection');
    const base = readFileNoFollow(path.join(getCorpusRoot(), 'agents/engineer.agent.md'), { root: getCorpusRoot(), maxBytes: 65536 });
    selected.validatePublication();
    if (readFileNoFollow(file, { root: configHome, maxBytes: 1024 * 1024 }) !== raw) throw fail('Copilot delegation projection changed during validation');
    return { present: true, valid: true, personalAgents: selected.personalAgents, factoryAgents: splitNativeSource(base).metadata.agents };
  } catch (error) { return { present: true, valid: false, reason: error.message, personalAgents: [] }; }
}

/** Trusted native-event consumers call this; no CLI accepts authored activation evidence. */
export function activatePersonalResource({ home, configHome, skillsHome = path.join(configHome, 'skills'), host, name, expectedDigest, expectedSourceDigest, expectedPolicyRevision, validateObservation }) {
  if (!canonical.test(name || '') || typeof validateObservation !== 'function') throw fail('Native activation requires a correlated observed invocation verifier');
  configHome = path.resolve(configHome); skillsHome = path.resolve(skillsHome);
  if (host === 'terminal') throw fail('Terminal integration cannot establish isolated native agent activation');
  const legacy = ['copilot', 'vscode', 'cli', 'intellij'].includes(host);
  const options = { home, copilotHome: configHome, skillsHome, host };
  const perform = () => {
    const consent = discoveryPolicy(options);
    if (!consent.configured || expectedPolicyRevision !== consent.policyRevision) throw fail('Native activation consent revision changed or is absent');
    const selected = discoverCapabilities({ ...options, query: name, limit: 2000 }).resources.filter(resource => resource.kind === 'agent' && resource.id === name && resource.current && resource.included && resource.valid);
    const resource = selected.find(item => item.digest === expectedDigest && (item.sourceDigest || null) === (expectedSourceDigest || null));
    if (!resource || selected.filter(item => item.path === resource.path).length !== 1 || path.dirname(resource.path) !== path.join(configHome, 'agents')) throw fail('Observed native source is absent, changed or outside the selected host');
    const registryRel = legacy ? 'harness/registered.yaml' : PERSONAL_RESOURCES_FILE;
    const before = readFileNoFollow(path.join(configHome, registryRel), { root: configHome, maxBytes: 1024 * 1024 });
    let registry;
    try { registry = legacy ? YAML.parse(before, { maxAliasCount: 50 }) : readPersonalResources({ configHome, skillsHome, host }); }
    catch { throw fail('Observed native source registry is unavailable'); }
    const relative = path.relative(configHome, resource.path).replaceAll('\\', '/');
    const record = legacy ? registry?.primitives?.[relative] : registry.resources[`agent:${name}`];
    if (!record || record.digest !== resource.digest || !legacy && record.sourceDigest !== resource.sourceDigest) throw fail('Observed native source registration is stale');
    const binding = legacy ? null : personalHostBinding({ configHome, skillsHome });
    if (binding && binding.manifest.host !== host) throw fail('Native activation host binding differs');
    const ownership = legacy ? [] : [[configHome, '.ae-host.json'], [skillsHome, '.ae-host-skills.json']].map(([root, rel]) => ({ root, rel, text: readFileNoFollow(path.join(root, rel), { root, maxBytes: 1024 * 1024 }) }));
    const verify = () => {
      if (discoveryPolicy(options).policyRevision !== consent.policyRevision) throw fail('Native activation consent changed during publication');
      if (ownership.some(item => !item.text || readFileNoFollow(path.join(item.root, item.rel), { root: item.root, maxBytes: 1024 * 1024 }) !== item.text)) throw fail('Native activation ownership changed during publication');
      const source = readFileNoFollow(resource.path, { root: configHome, maxBytes: 65536 });
      if (source === null || hash(source) !== expectedDigest) throw fail('Observed native source bytes changed during publication');
      const observation = validateObservation({ ...resource, name, sourceDigest: resource.sourceDigest || null });
      if (!object(observation) || ['sessionId', 'requestId', 'receiptId', 'toolUseId'].some(key => typeof observation[key] !== 'string' || !observation[key] || observation[key].length > 512)
        || !(Number.isFinite(observation.observedAt) && observation.observedAt >= 0 || typeof observation.observedAt === 'string' && Number.isFinite(Date.parse(observation.observedAt)))
        || observation.resource?.id !== name || observation.resource.path !== resource.path || observation.resource.digest !== resource.digest
        || (observation.resource.sourceDigest || null) !== (resource.sourceDigest || null)) throw fail('Native invocation observation does not bind the exact current source');
      return observation;
    };
    const observation = verify();
    const activation = { state: 'available', reason: 'A correlated native invocation succeeded while this approved source was current; native loader source hash remains unverified.',
      nativeQualification: 'observed-invocation', loadedSourceHash: 'unverified', observedAt: observation.observedAt, sessionId: observation.sessionId,
      requestId: observation.requestId, receiptId: observation.receiptId, toolUseId: observation.toolUseId, digest: resource.digest, sourceDigest: resource.sourceDigest || null, policyRevision: consent.policyRevision };
    record.activation = activation;
    const after = legacy ? YAML.stringify(registry) : `${JSON.stringify(registry, null, 2)}\n`;
    if (before === null || readFileNoFollow(path.join(configHome, registryRel), { root: configHome, maxBytes: 1024 * 1024 }) !== before) throw fail('Native activation registry changed during observation');
    if (!writeFileContained(configHome, registryRel, after, { mode: 0o600 })) throw fail('Native activation registry publication failed');
    try {
      const latest = verify();
      if (JSON.stringify(latest) !== JSON.stringify(observation)) throw fail('Native invocation observation changed during publication');
      if (readFileNoFollow(path.join(configHome, registryRel), { root: configHome, maxBytes: 1024 * 1024 }) !== after) throw fail('Native activation registry changed during publication');
    } catch (error) {
      if (readFileNoFollow(path.join(configHome, registryRel), { root: configHome, maxBytes: 1024 * 1024 }) === after) writeFileContained(configHome, registryRel, before, { mode: 0o600 });
      throw error;
    }
    return { schema: 1, status: 'ok', resource: { id: name, path: resource.path, digest: resource.digest, sourceDigest: resource.sourceDigest || null }, activation };
  };
  if (legacy) return withPlanUpdateLock(registeredPath(configHome), perform);
  const locks = [...new Set([path.join(configHome, '.ae-host.lock'), path.join(skillsHome, '.ae-host-skills.lock')])].sort(), acquired = [];
  try {
    for (const lock of locks) {
      const root = lock.startsWith(skillsHome + path.sep) ? skillsHome : configHome;
      if (!assertNoSymlinkAncestors(root, path.relative(root, lock))) throw fail('Native activation ownership lock is unsafe');
      try { fs.mkdirSync(lock, { mode: 0o700 }); acquired.push(lock); }
      catch (error) { if (error.code === 'EEXIST') throw fail('Host resources are being updated; retry activation observation'); throw error; }
    }
    return perform();
  } finally { for (const lock of acquired.reverse()) fs.rmdirSync(lock); }
}
