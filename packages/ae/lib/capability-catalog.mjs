import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { assertNoSymlinkAncestors, readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { harnessGlobalHome, resolveCopilotHome } from './paths.mjs';

const MAX_FILES = 2000, MAX_FILE_BYTES = 65536, MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const TYPES = ['skill', 'agent', 'instruction'];
const HOSTS = ['copilot', 'vscode', 'cli', 'intellij', 'claude-code', 'codex', 'cursor', 'terminal'];
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const fail = message => Object.assign(new Error(`Capability discovery: ${message}`), { code: 'E_TARGET', exit: 1 });
const usage = message => Object.assign(new Error(`Capability discovery: ${message}`), { code: 'E_USAGE', exit: 2 });
const within = (root, full) => full === root || full.startsWith(root + path.sep);
const fields = (value, keys, label) => { if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw usage(`${label} has unknown or malformed fields`); };
const toolAliases = { Read: 'read', ReadFile: 'read', Glob: 'search', Grep: 'search', ListDir: 'search', Bash: 'execute', Shell: 'execute', Edit: 'edit', Write: 'edit', WebFetch: 'web/fetch', Agent: 'agent', Task: 'agent' };
const normalizedTools = tools => [...new Set(tools.map(tool => Object.hasOwn(toolAliases, tool) ? toolAliases[tool] : tool))].sort();
export const normalizeCapabilityTools = normalizedTools;

function absolute(value, label) {
  if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) throw usage(`${label} needs an absolute directory`);
  const full = path.resolve(value), anchor = path.parse(full).root;
  if (full === anchor || !assertNoSymlinkAncestors(anchor, path.relative(anchor, full))) throw fail(`${label} is unsafe, redirected or a filesystem root`);
  return full;
}

function bindingOf(options = {}) {
  const config = absolute(options.copilotHome || resolveCopilotHome(), 'configuration home');
  const skills = absolute(options.skillsHome || process.env.AE_SKILLS_HOME || path.join(config, 'skills'), 'skills home');
  let host = options.host || process.env.AE_HOST;
  if (!host) {
    const manifest = readFileNoFollow(path.join(config, '.ae-host.json'), { root: config, maxBytes: MAX_FILE_BYTES });
    if (manifest !== null) { try { host = JSON.parse(manifest).host; } catch { throw fail('host setup manifest is malformed'); } }
    else if (fs.lstatSync(path.join(config, '.ae-host.json'), { throwIfNoEntry: false })) throw fail('host setup manifest is unsafe or unreadable');
  }
  host ||= 'copilot';
  if (!HOSTS.includes(host)) throw usage('unsupported selected host');
  const home = absolute(options.home || harnessGlobalHome(), 'AE home');
  if (options.workspace && within(path.resolve(options.workspace), home)) throw fail('AE home must be outside the product workspace');
  const binding = { host, configHome: config, skillsHome: skills };
  const directory = path.join('capabilities', hash(binding).slice(0, 24));
  return { home, binding, directory, paths: { policy: path.join(home, directory, 'policy.json'), catalog: path.join(home, directory, 'catalog.json') } };
}

function readState(state, kind) {
  const relative = path.join(state.directory, `${kind}.json`), full = path.join(state.home, relative);
  if (!assertNoSymlinkAncestors(state.home, relative)) throw fail(`${kind} path is unsafe or redirected`);
  if (!fs.lstatSync(full, { throwIfNoEntry: false })) return null;
  const text = readFileNoFollow(full, { root: state.home, maxBytes: MAX_STATE_BYTES });
  if (text === null) throw fail(`${kind} is unsafe, unreadable or oversized`);
  try { const value = JSON.parse(text); if (object(value)) return value; } catch { /* fail closed */ }
  throw fail(`${kind} is malformed; refusing to replace it`);
}

function publish(state, kind, value) {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_STATE_BYTES) throw fail(`${kind} exceeds the state limit`);
  if (!writeFileContained(state.home, path.join(state.directory, `${kind}.json`), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })) throw fail(`${kind} publication was refused`);
}

function locked(state, operation) {
  if (!assertNoSymlinkAncestors(state.home, state.directory)) throw fail('state directory is unsafe');
  fs.mkdirSync(path.join(state.home, state.directory), { recursive: true, mode: 0o700 });
  const lock = path.join(state.home, state.directory, '.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw fail('catalog is being updated; retry after the active operation'); throw error; }
  try { return operation(); } finally { fs.rmdirSync(lock); }
}

function strings(value, label, { limit = 128, allowed } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit || value.some(item => typeof item !== 'string' || !item || item.length > 1024 || /[\u0000-\u001f\u007f]/.test(item) || allowed && !allowed.includes(item))) throw usage(`${label} must be a bounded list of names`);
  return [...new Set(value)];
}

function normalizeRoots(roots, binding) {
  if (!Array.isArray(roots) || !roots.length || roots.length > 32) throw usage('roots requires 1–32 explicitly selected directories');
  const seen = new Set();
  return roots.map(root => {
    fields(root, ['path', 'kind', 'host', 'scope', 'included'], 'root');
    const full = absolute(root.path, 'source root'), kind = root.kind || 'config', host = root.host || binding.host, scope = root.scope || 'personal';
    if (!['config', 'skills'].includes(kind) || !HOSTS.includes(host) || !['personal', 'project', 'enterprise'].includes(scope) || typeof root.included !== 'boolean') throw usage('root kind, host, scope or inclusion is invalid');
    const key = `${kind}:${full}`; if (seen.has(key)) throw usage('duplicate selected root'); seen.add(key);
    return { path: full, kind, host, scope, included: root.included };
  });
}

function normalizeGrants(input) {
  const grants = input || {};
  fields(grants, ['create', 'update', 'memory', 'decision', 'hostAuthority', 'tools', 'agents', 'budgets'], 'grants');
  for (const key of ['memory', 'decision', 'hostAuthority']) if (grants[key] !== undefined && typeof grants[key] !== 'boolean') throw usage(`grants.${key} must be boolean`);
  const budgets = grants.budgets || {};
  fields(budgets, ['maxDecisions', 'maxRepairs', 'maxAcquisitions', 'maxSeconds', 'maxSpend'], 'budgets');
  if (budgets.maxSpend !== undefined) throw usage('maxSpend is unsupported because native hosts do not expose model spend');
  const limits = { maxDecisions: [100, 1000], maxRepairs: [3, 1000], maxAcquisitions: [5, 1000], maxSeconds: [3600, 86400] };
  const normalized = {};
  for (const [name, [fallback, max]] of Object.entries(limits)) {
    const value = budgets[name] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw usage(`invalid ${name} budget`);
    normalized[name] = value;
  }
  return { create: strings(grants.create, 'grants.create', { allowed: TYPES }), update: strings(grants.update, 'grants.update', { allowed: TYPES }), memory: grants.memory === true, decision: grants.decision === true, hostAuthority: grants.hostAuthority === true, tools: normalizedTools(strings(grants.tools, 'grants.tools')), agents: strings(grants.agents, 'grants.agents'), budgets: normalized };
}

function readPolicy(state) {
  const policy = readState(state, 'policy'); if (!policy) return null;
  try {
    fields(policy, ['schema', 'binding', 'roots', 'ongoing', 'autoIncludeNew', 'autoUpdate', 'exclusions', 'grants', 'approved', 'revision'], 'policy');
    if (policy.schema !== 1 || JSON.stringify(policy.binding) !== JSON.stringify(state.binding) || typeof policy.revision !== 'string' || !Array.isArray(policy.approved) || policy.approved.length > MAX_FILES) throw new Error();
    const { revision, ...body } = policy;
    if (hash(body) !== revision) throw new Error();
    normalizeRoots(policy.roots, state.binding); normalizeGrants(policy.grants); strings(policy.exclusions, 'exclusions');
    if (['ongoing', 'autoIncludeNew', 'autoUpdate'].some(key => typeof policy[key] !== 'boolean')) throw new Error();
    for (const item of policy.approved) if (!object(item) || !Number.isInteger(item.rootIndex) || !policy.roots[item.rootIndex] || typeof item.relative !== 'string' || typeof item.digest !== 'string' || !Array.isArray(item.tools) || !Array.isArray(item.agents)) throw new Error();
  } catch { throw fail('policy is malformed or its revision does not match; refusing to replace it'); }
  return policy;
}

/** User-owned policy; project configuration and model verdicts cannot grant discovery consent. */
export function discoveryPolicy(options = {}) {
  const state = bindingOf(options), policy = readPolicy(state);
  return { configured: Boolean(policy), policyRevision: policy?.revision || null, policy, binding: state.binding, paths: state.paths };
}
export const readDiscoveryPolicy = discoveryPolicy;

function metadata(text, format) {
  if (format === 'toml') {
    const result = {};
    // Decode only bounded literal metadata. TOML bodies and instructions are never evaluated.
    for (const key of ['name', 'description']) {
      const match = new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*$`, 'm').exec(text);
      if (match) result[key] = match[1][0] === '"' ? JSON.parse(match[1]) : match[1].slice(1, -1);
    }
    return result;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  const parsed = YAML.parse(match[1], { maxAliasCount: 20 });
  if (!object(parsed)) throw new Error('frontmatter must be a mapping');
  return parsed;
}

function permissionsFromMetadata(fm, { host, kind, format }) {
  const values = key => {
    let value = fm[key];
    if (typeof value === 'string' && (key === 'allowed-tools' || format !== 'copilot')) value = value.split(/,(?![^()]*\))/).map(item => item.trim()).filter(Boolean);
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 128 || value.some(item => typeof item !== 'string' || !item || item.length > 512 || /[\u0000-\u001f\u007f]/.test(item))) throw usage(`${key} requires bounded permission names`);
    return value;
  };
  const tools = normalizedTools([...values('tools'), ...values('allowed-tools')]), agents = [...values('agents')];
  if (fm.context === 'fork' && typeof fm.agent === 'string' && !agents.includes(fm.agent)) agents.push(fm.agent);
  const auxiliary = { hooks: fm.hooks || null, mcpServers: fm.mcpServers || null, permissionMode: fm.permissionMode || 'default' };
  const elevated = Boolean(fm.hooks || fm.mcpServers || fm.permissionMode && fm.permissionMode !== 'default');
  const authority = elevated || kind === 'agent' && (!Object.hasOwn(fm, 'tools') || ['codex', 'cursor', 'terminal'].includes(host)) ? 'host-inherited' : 'declared';
  return { tools, agents, authority, authorityFingerprint: hash(auxiliary), permissionIsolation: authority === 'host-inherited' ? 'inherits-host-authority' : 'declared-tools' };
}

/** The same declaration snapshot is used before publication and during catalog admission. */
export function declaredCapabilityPermissions({ text, host = 'copilot', kind = 'skill', format = 'markdown' }) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_FILE_BYTES) throw usage('permission source is absent or oversized');
  return permissionsFromMetadata(metadata(text, format), { host, kind, format });
}

function resourceShape(root, relative) {
  const rel = relative.replaceAll('\\', '/');
  const skillMatch = (root.kind === 'skills' ? /^([a-z0-9-]+)\/SKILL\.md$/ : /^skills\/([a-z0-9-]+)\/SKILL\.md$/).exec(rel);
  if (skillMatch && NAME.test(skillMatch[1])) return { kind: 'skill', id: skillMatch[1], format: 'markdown' };
  if (root.kind !== 'config') return null;
  const role = /^agents\/([a-z0-9-]+)(\.agent\.md|\.md|\.toml)$/.exec(rel);
  if (role && NAME.test(role[1])) return { kind: 'agent', id: role[1], format: role[2] === '.toml' ? 'toml' : role[2] === '.agent.md' ? 'copilot' : 'markdown' };
  const instruction = /^(instructions|rules)\/([a-z0-9-]+)(\.instructions\.md|\.md|\.mdc)$/.exec(rel);
  if (instruction && NAME.test(instruction[2])) return { kind: 'instruction', id: instruction[2], format: instruction[3] === '.mdc' ? 'mdc' : instruction[3] === '.instructions.md' ? 'copilot' : 'markdown' };
  return null;
}

function activationSource(entry, digest, sourceDigest = null) {
  const value = typeof entry.activation === 'string' ? { state: entry.activation } : entry.activation;
  if (!object(value) || typeof value.state !== 'string') return null;
  const result = { state: value.state.slice(0, 80), reason: typeof value.reason === 'string' ? value.reason.slice(0, 512) : null };
  if (result.state === 'available') {
    const identity = ['sessionId', 'requestId', 'receiptId', 'toolUseId', 'policyRevision'].every(key => typeof value[key] === 'string' && value[key] && value[key].length <= 512);
    const timestamp = Number.isFinite(value.observedAt) && value.observedAt >= 0 || typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt));
    if (!identity || !timestamp || value.nativeQualification !== 'observed-invocation' || value.digest !== digest || (value.sourceDigest || null) !== sourceDigest || value.loadedSourceHash !== 'unverified') return { state: 'pending-reload', reason: 'Native availability observation does not bind the current source and invocation identity.' };
    for (const key of ['nativeQualification', 'loadedSourceHash', 'sessionId', 'requestId', 'receiptId', 'toolUseId', 'digest', 'sourceDigest', 'policyRevision', 'observedAt']) {
      const item = value[key];
      if (typeof item === 'string' && item.length <= 512 || Number.isFinite(item) || item === null) result[key] = item;
    }
  }
  return result;
}

function personalSource(root, relative, text, registries) {
  if (['copilot', 'vscode', 'cli', 'intellij'].includes(root.host)) {
    const relativeRegistry = 'harness/registered.yaml', file = path.join(root.path, relativeRegistry);
    const raw = assertNoSymlinkAncestors(root.path, relativeRegistry) ? readFileNoFollow(file, { root: root.path, maxBytes: 1024 * 1024 }) : null;
    if (raw === null) {
      if (!assertNoSymlinkAncestors(root.path, relativeRegistry) || fs.lstatSync(file, { throwIfNoEntry: false })) throw new Error('personal Copilot registration is unsafe or unreadable');
      return null;
    }
    const registry = YAML.parse(raw, { maxAliasCount: 50 }), entry = registry?.primitives?.[relative.replaceAll('\\', '/')];
    if (!entry) return null;
    if (entry.digest !== `sha256-${hash(text)}`) throw new Error('personal Copilot registration source has changed');
    return { metadata: metadata(text, 'markdown'), activation: activationSource(entry, entry.digest) };
  }
  if (root.kind !== 'config' || !['claude-code', 'codex', 'cursor', 'terminal'].includes(root.host)) return null;
  if (!registries.has(root.path)) {
    const file = '.ae-personal-resources.json';
    const raw = assertNoSymlinkAncestors(root.path, file) ? readFileNoFollow(path.join(root.path, file), { root: root.path, maxBytes: 1024 * 1024 }) : null;
    if (raw === null) {
      if (fs.lstatSync(path.join(root.path, file), { throwIfNoEntry: false })) throw new Error('personal source registry is unsafe or unreadable');
      registries.set(root.path, null);
    } else {
      const value = JSON.parse(raw);
      if (!object(value) || value.schema !== 1 || value.host !== root.host || value.configHome !== root.path || !object(value.resources)) throw new Error('personal source registry does not match the selected root');
      registries.set(root.path, value);
    }
  }
  const registry = registries.get(root.path); if (!registry) return null;
  const entry = Object.values(registry.resources).find(item => object(item) && item.path === relative.replaceAll('\\', '/'));
  if (!entry) return null;
  if (entry.digest !== `sha256-${hash(text)}` || typeof entry.sourceText !== 'string' || Buffer.byteLength(entry.sourceText) > MAX_FILE_BYTES || entry.sourceDigest !== `sha256-${hash(entry.sourceText)}`) throw new Error('personal native asset or canonical source binding has changed');
  const activation = activationSource(entry, entry.digest, entry.sourceDigest);
  return { metadata: metadata(entry.sourceText, 'markdown'), sourceDigest: entry.sourceDigest, activation };
}

function readResource(root, rootIndex, relative, diagnostics, registries = new Map()) {
  const shape = resourceShape(root, relative); if (!shape) return null;
  const full = assertNoSymlinkAncestors(root.path, relative);
  const text = full ? readFileNoFollow(full, { root: root.path, maxBytes: MAX_FILE_BYTES }) : null;
  if (text === null) { diagnostics.push({ path: path.join(root.path, relative), reason: 'resource is missing, redirected, unreadable or exceeds 64 KiB' }); return null; }
  try {
    const personal = personalSource(root, relative, text, registries);
    const fm = personal?.metadata || metadata(text, shape.format);
    if (typeof fm.tools === 'string' && shape.format !== 'copilot') fm.tools = fm.tools.split(/,(?![^()]*\))/).map(value => value.trim()).filter(Boolean);
    if (typeof fm['allowed-tools'] === 'string') fm['allowed-tools'] = fm['allowed-tools'].split(/,(?![^()]*\))/).map(value => value.trim()).filter(Boolean);
    for (const key of ['tools', 'allowed-tools', 'agents', 'capabilities', 'perspectives', 'triggers']) if (fm[key] !== undefined && (!Array.isArray(fm[key]) || fm[key].length > 128 || fm[key].some(value => typeof value !== 'string' || value.length > 512))) throw new Error(`${key} must be a bounded array of strings`);
    if (fm.description !== undefined && (typeof fm.description !== 'string' || fm.description.length > 4096)) throw new Error('description is invalid');
    const permission = permissionsFromMetadata(fm, { host: root.host, kind: shape.kind, format: shape.format });
    const activation = personal?.activation?.state || (root.host === 'terminal' ? 'manual' : 'host-dependent');
    const capabilities = strings([...(fm.capabilities || []), ...(fm.perspectives || [])], 'capabilities');
    const key = `${shape.kind}:${hash(root.path).slice(0, 12)}:${shape.id}`;
    return { ...shape, key, path: full, root: root.path, rootIndex, relative, host: root.host, scope: root.scope,
      provenance: root.scope === 'enterprise' ? 'enterprise' : root.scope === 'project' ? 'project' : 'selected-host',
      digest: `sha256-${hash(text)}`, ...(personal ? { sourceDigest: personal.sourceDigest } : {}), description: fm.description || (shape.kind === 'instruction' ? text.replace(/^---[\s\S]*?---\s*/, '').slice(0, 512) : shape.id), ...permission, capabilities,
      triggers: fm.triggers || [], patterns: fm.applyTo || fm.appliesTo || fm.paths || fm.globs || null, valid: true, current: true,
      invocable: shape.kind !== 'agent' || root.host !== 'terminal' && !['pending-reload', 'context-routed'].includes(activation), activation, ...(personal?.activation ? { activationEvidence: personal.activation } : {}), nativeQualification: personal?.activation?.nativeQualification || 'unverified',
      ...(personal?.activation?.loadedSourceHash ? { loadedSourceHash: personal.activation.loadedSourceHash } : {}), bytes: Buffer.byteLength(text) };
  } catch (error) { diagnostics.push({ path: full, reason: `resource metadata is invalid: ${error.message}` }); return null; }
}

function scan(roots) {
  const candidates = [], diagnostics = [], registries = new Map(); let count = 0, bytes = 0, omitted = 0;
  const entries = (root, relative = '') => {
    const full = assertNoSymlinkAncestors(root.path, relative);
    if (!full) { diagnostics.push({ path: path.join(root.path, relative), reason: 'source directory is redirected' }); return []; }
    try { return fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch (error) { if (error.code !== 'ENOENT') diagnostics.push({ path: full, reason: 'source directory is unreadable' }); return []; }
  };
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
    const root = roots[rootIndex];
    const skillsRelative = root.kind === 'skills' ? '' : 'skills';
    const paths = entries(root, skillsRelative).filter(entry => entry.isDirectory() && NAME.test(entry.name)).map(entry => path.join(skillsRelative, entry.name, 'SKILL.md'))
      .filter(relative => fs.lstatSync(path.join(root.path, relative), { throwIfNoEntry: false }));
    if (root.kind === 'config') for (const directory of ['agents', 'instructions', 'rules']) for (const entry of entries(root, directory)) {
      const relative = path.join(directory, entry.name);
      if (resourceShape(root, relative)) paths.push(relative);
    }
    for (const relative of paths) {
      if (count++ >= MAX_FILES || bytes >= MAX_TOTAL_BYTES) { omitted++; continue; }
      const value = readResource(root, rootIndex, relative, diagnostics, registries);
      if (value) { bytes += value.bytes; if (bytes <= MAX_TOTAL_BYTES) candidates.push(value); else omitted++; }
    }
  }
  return { candidates, diagnostics: diagnostics.slice(0, 100), omitted, scanned: Math.min(count, MAX_FILES), bytes };
}

const approvedRecord = item => ({ key: item.key, rootIndex: item.rootIndex, relative: item.relative, digest: item.digest, ...(item.sourceDigest ? { sourceDigest: item.sourceDigest } : {}), tools: item.tools, agents: item.agents, authority: item.authority, authorityFingerprint: item.authorityFingerprint,
  ...(item.kind === 'agent' && item.activationEvidence && ['pending-reload', 'available'].includes(item.activation) ? { requiresNativeObservation: true } : {}) });
const excluded = (policy, item) => policy.exclusions.some(value => value === item.key || value === item.id || value === item.path || path.isAbsolute(value) && within(path.resolve(value), item.path));

/** Persist consent only from the explicit setup/resource operation, never from a project or discovered file. */
export function configureDiscovery(options) {
  const { input, dryRun = false } = options;
  fields(input, ['schema', 'expectedRevision', 'binding', 'revision', 'approved', 'roots', 'ongoing', 'autoIncludeNew', 'autoUpdate', 'exclusions', 'grants'], 'configuration');
  if (input.schema !== 1) throw usage('configuration requires schema 1');
  const state = bindingOf(options);
  const perform = () => {
    const prior = readPolicy(state); readState(state, 'catalog');
    if (prior && input.expectedRevision !== prior.revision) throw fail('policy revision is stale; inspect current consent before updating');
    if (!prior && input.expectedRevision !== undefined && input.expectedRevision !== null) throw fail('policy revision is stale');
    for (const key of ['ongoing', 'autoIncludeNew', 'autoUpdate']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw usage(`${key} must be boolean`);
    const roots = normalizeRoots(input.roots, state.binding), observed = scan(roots);
    const body = { schema: 1, binding: state.binding, roots, ongoing: input.ongoing === true, autoIncludeNew: input.autoIncludeNew === true, autoUpdate: input.autoUpdate === true, exclusions: strings(input.exclusions, 'exclusions'), grants: normalizeGrants(input.grants), approved: [] };
    body.approved = observed.candidates.filter(item => roots[item.rootIndex].included && !excluded(body, item)).map(approvedRecord);
    const policy = { ...body, revision: hash(body) };
    const catalog = { schema: 1, binding: state.binding, policyRevision: policy.revision, candidates: observed.candidates, diagnostics: observed.diagnostics, omitted: observed.omitted, misses: [], generation: hash(observed.candidates.map(approvedRecord)) };
    if (!dryRun) { publish(state, 'policy', policy); publish(state, 'catalog', catalog); }
    return { schema: 1, configured: true, status: dryRun ? 'preview' : 'configured', policyRevision: policy.revision, policy, binding: state.binding, paths: state.paths, counts: { candidates: observed.candidates.length, included: body.approved.length }, diagnostics: observed.diagnostics, dryRun: Boolean(dryRun) };
  };
  return dryRun ? perform() : locked(state, perform);
}

function eligibility(policy, item) {
  if (!policy.roots[item.rootIndex]?.included || excluded(policy, item)) return { included: false, state: 'excluded' };
  const approved = policy.approved.find(entry => entry.key === item.key);
  if (!approved) {
    if (item.authority === 'host-inherited' && !policy.grants.hostAuthority) return { included: false, state: 'permission-unknown' };
    const permitted = policy.autoIncludeNew && item.tools.every(tool => policy.grants.tools.includes(tool)) && item.agents.every(agent => policy.grants.agents.includes(agent));
    return { included: permitted, state: permitted ? 'included' : 'pending' };
  }
  if (approved.requiresNativeObservation && (!item.activationEvidence || !['pending-reload', 'available'].includes(item.activation))) return { included: false, state: 'activation-binding-missing' };
  if (item.tools.some(tool => !approved.tools.includes(tool)) || item.agents.some(agent => !approved.agents.includes(agent)) || approved.authority !== item.authority || approved.authorityFingerprint !== item.authorityFingerprint) return { included: false, state: 'permission-expansion' };
  const unchanged = item.digest === approved.digest && item.sourceDigest === approved.sourceDigest;
  if (!unchanged && !policy.autoUpdate) return { included: false, state: 'changed' };
  return { included: true, state: unchanged ? 'included' : 'updated' };
}

function refreshCurrent(policy, candidates, diagnostics) {
  let bytes = 0; const registries = new Map();
  return candidates.flatMap(item => {
    if (bytes >= MAX_TOTAL_BYTES) { diagnostics.push({ path: item.path, reason: 'source-byte budget exhausted; remaining resources omitted' }); return []; }
    const root = policy.roots[item.rootIndex];
    if (!root || item.path !== path.resolve(root.path, item.relative || '') || !resourceShape(root, item.relative || '')) throw fail('catalog contains a source outside its selected roots');
    const value = readResource(root, item.rootIndex, item.relative, diagnostics, registries);
    bytes += value?.bytes || 0;
    return value ? [{ ...value, ...eligibility(policy, value) }] : [];
  });
}

function score(item, query) {
  const tokens = String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [];
  if (!tokens.length) return 1;
  const haystack = `${item.id} ${item.description} ${item.capabilities.join(' ')} ${item.triggers.join(' ')}`.toLowerCase();
  return [...new Set(tokens)].reduce((value, token) => value + (haystack.includes(token) ? item.id === token || item.capabilities.includes(token) ? 4 : 1 : 0), 0);
}

/** Bounded local discovery. Cache misses refresh only consented roots, once per supplied task identity. */
export function discoverCapabilities(options = {}) {
  const state = bindingOf(options), policy = readPolicy(state), limit = options.limit ?? 24;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FILES) throw usage('limit must be 1–2000');
  if (!policy) {
    const roots = [{ path: state.binding.configHome, kind: 'config', host: state.binding.host, scope: 'personal', included: false }];
    if (state.binding.skillsHome !== path.join(state.binding.configHome, 'skills')) roots.push({ path: state.binding.skillsHome, kind: 'skills', host: state.binding.host, scope: 'personal', included: false });
    const observed = options.onboarding === false ? { candidates: [], diagnostics: [], omitted: 0 } : scan(roots);
    return { schema: 1, status: 'needs-consent', configured: false, policyRevision: null, binding: state.binding, resources: [], candidates: observed.candidates.slice(0, limit).map(item => ({ ...item, included: false, state: 'pending' })), diagnostics: observed.diagnostics, omitted: observed.omitted + Math.max(0, observed.candidates.length - limit), refreshed: false, refreshBlocked: Boolean(options.refresh), onboarding: { inclusion: 'Choose which existing resources AE may consider', ongoing: 'Choose whether AE may refresh these sources', roots }, assurance: 'Discovery metadata is not activation, execution authority or native invocation proof' };
  }
  let catalog = readState(state, 'catalog');
  if (catalog && (catalog.schema !== 1 || JSON.stringify(catalog.binding) !== JSON.stringify(state.binding) || !Array.isArray(catalog.candidates) || catalog.candidates.length > MAX_FILES || !Array.isArray(catalog.misses))) throw fail('catalog is malformed; refusing to replace it');
  if (!catalog || catalog.policyRevision !== policy.revision) catalog = { schema: 1, binding: state.binding, policyRevision: policy.revision, candidates: policy.approved.map(item => ({ ...item, path: path.resolve(policy.roots[item.rootIndex].path, item.relative) })), diagnostics: [], omitted: 0, misses: [] };
  const diagnostics = [...(catalog.diagnostics || [])];
  let candidates = refreshCurrent(policy, catalog.candidates, diagnostics), refreshed = false;
  const missKey = hash({ task: options.taskId || `query:${String(options.query || '')}`, policy: policy.revision });
  const needsRefresh = Boolean(options.refresh) || Boolean(options.query) && !candidates.some(item => item.included && score(item, options.query) > 0) && !catalog.misses.includes(missKey);
  if (needsRefresh && policy.ongoing) {
    const update = () => {
      const currentPolicy = readPolicy(state); if (currentPolicy.revision !== policy.revision) throw fail('policy changed during refresh');
      const currentCatalog = readState(state, 'catalog');
      if (currentCatalog && currentCatalog.policyRevision === policy.revision && !options.refresh && currentCatalog.misses?.includes(missKey)) return;
      const observed = scan(policy.roots);
      catalog = { schema: 1, binding: state.binding, policyRevision: policy.revision, candidates: observed.candidates, diagnostics: observed.diagnostics, omitted: observed.omitted, misses: [...new Set([...(currentCatalog?.policyRevision === policy.revision ? currentCatalog.misses || [] : []), missKey])].slice(-128), generation: hash(observed.candidates.map(approvedRecord)) };
      publish(state, 'catalog', catalog); candidates = refreshCurrent(policy, catalog.candidates, observed.diagnostics); refreshed = true;
    };
    locked(state, update);
  }
  const selected = [], seen = new Set();
  for (const item of candidates) {
    const identity = `${item.kind}:${item.id}`;
    if (item.included && seen.has(identity)) { item.included = false; item.state = 'shadowed'; }
    else if (item.included) { seen.add(identity); selected.push(item); }
  }
  const matches = selected.map(item => ({ ...item, score: score(item, options.query) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (readPolicy(state).revision !== policy.revision) throw fail('consent changed during capability selection; refresh the task context');
  return { schema: 1, status: 'ok', configured: true, policyRevision: policy.revision, binding: state.binding, generation: catalog.generation || null,
    resources: matches.slice(0, limit), candidates: candidates.slice(0, limit), counts: { discovered: candidates.length, included: selected.length, matched: matches.length },
    diagnostics: [...new Map(diagnostics.map(item => [JSON.stringify(item), item])).values()].slice(0, 100), omitted: (catalog.omitted || 0) + Math.max(0, candidates.length - limit), refreshed, refreshBlocked: needsRefresh && !policy.ongoing,
    assurance: 'Included source metadata; actual native activation, invocation and usefulness require their own evidence' };
}

export function resolveCapability(options) {
  if (!TYPES.includes(options.kind) || typeof options.id !== 'string') throw usage('resolve requires a resource kind and id');
  const result = discoverCapabilities({ ...options, query: options.id, limit: MAX_FILES });
  return result.resources.find(item => item.kind === options.kind && (item.id === options.id || item.key === options.id || item.capabilities.includes(options.id))) || null;
}

/** A null inventory preserves legacy installations until the user explicitly configures discovery. */
export function capabilityInventory(options = {}) {
  if (!discoveryPolicy(options).configured) return null;
  const result = discoverCapabilities({ ...options, query: '', limit: MAX_FILES });
  const inventory = { skills: new Map(), agents: new Map(), instructions: new Map() };
  for (const item of result.resources) inventory[`${item.kind}s`].set(item.id, item.path);
  return inventory;
}

/** Scope matching for native personal writers; a model's approved field never expands these grants. */
export function authorizeCapabilityChange(options) {
  const { policy, policyRevision } = discoveryPolicy(options);
  const denied = reason => ({ allowed: false, reason, policyRevision });
  if (!policy) return denied('Standing capability authorization is not configured');
  if (!['create', 'update'].includes(options.operation) || !TYPES.includes(options.type) || !policy.grants[options.operation].includes(options.type)) return denied('Resource operation is outside standing authorization');
  if (!NAME.test(options.name || '') || typeof options.path !== 'string' || !path.isAbsolute(options.path)) return denied('Resource destination is invalid');
  if ((options.authority === 'host-inherited' || options.type === 'agent' && ['codex', 'cursor', 'terminal'].includes(options.host || policy.binding.host)) && !policy.grants.hostAuthority) return denied('Inherited host authority is outside standing authorization');
  const full = path.resolve(options.path);
  if (!policy.roots.some(root => root.included && within(root.path, full) && resourceShape(root, path.relative(root.path, full))?.kind === options.type && !excluded(policy, { id: options.name, key: `${options.type}:${hash(root.path).slice(0, 12)}:${options.name}`, path: full }) && assertNoSymlinkAncestors(root.path, path.relative(root.path, full)))) return denied('Resource destination is outside included source roots');
  if (!Array.isArray(options.tools || []) || normalizedTools(options.tools || []).some(tool => !policy.grants.tools.includes(tool))) return denied('Tool expansion is outside standing authorization');
  if (!Array.isArray(options.agents || []) || (options.agents || []).some(agent => !policy.grants.agents.includes(agent))) return denied('Delegation expansion is outside standing authorization');
  return { allowed: true, reason: 'Covered by standing capability authorization', policyRevision };
}

/** A permitted personal writer may adopt only the exact bytes it just published. */
export function adoptCreatedCapability(options) {
  const state = bindingOf(options);
  return locked(state, () => {
    const policy = readPolicy(state);
    if (!policy) throw fail('resource adoption requires standing authorization');
    if (options.expectedPolicyRevision !== undefined && options.expectedPolicyRevision !== policy.revision) throw fail('resource adoption consent is stale');
    const full = absolute(options.path, 'resource path');
    const rootIndex = policy.roots.findIndex(root => root.included && within(root.path, full) && resourceShape(root, path.relative(root.path, full))?.kind === options.type);
    if (rootIndex < 0) throw fail('resource adoption destination is outside included roots');
    const diagnostics = [], resource = readResource(policy.roots[rootIndex], rootIndex, path.relative(policy.roots[rootIndex].path, full), diagnostics);
    if (!resource || resource.id !== options.name) throw fail(diagnostics[0]?.reason || 'resource adoption identity is invalid');
    const prior = policy.approved.find(item => item.key === resource.key);
    const permission = authorizeCapabilityChange({ ...options, operation: prior ? 'update' : 'create', tools: resource.tools, agents: resource.agents });
    if (!permission.allowed) throw fail(permission.reason);
    if (resource.authority === 'host-inherited' && !policy.grants.hostAuthority) throw fail('Inherited host authority is outside standing authorization');
    if (typeof options.expectedDigest !== 'string' || resource.digest !== options.expectedDigest || options.expectedSourceDigest !== undefined && resource.sourceDigest !== options.expectedSourceDigest) throw fail('Created resource bytes changed or expectedDigest is missing; adoption requires the writer result');
    const { revision: oldRevision, ...body } = policy;
    body.approved = [...policy.approved.filter(item => item.key !== resource.key), approvedRecord(resource)];
    if (body.approved.length > MAX_FILES) throw fail('approved resource limit reached');
    const next = { ...body, revision: hash(body) };
    const existing = readState(state, 'catalog');
    const candidates = [...(existing?.policyRevision === oldRevision ? existing.candidates || [] : []).filter(item => item.key !== resource.key), resource];
    if (candidates.length > MAX_FILES) throw fail('catalog resource limit reached');
    publish(state, 'policy', next);
    publish(state, 'catalog', { schema: 1, binding: state.binding, policyRevision: next.revision, candidates, diagnostics: existing?.diagnostics || [], omitted: existing?.omitted || 0, misses: [], generation: hash(candidates.map(approvedRecord)) });
    return { schema: 1, configured: true, adopted: true, policyRevision: next.revision, resource: { ...resource, included: true, state: 'included' } };
  });
}
