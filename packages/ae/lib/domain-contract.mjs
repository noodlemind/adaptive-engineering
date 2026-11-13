import { spawnGitSync } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { harnessGlobalHome } from './paths.mjs';
import { assertNoSymlinkAncestors, canonicalPath, readFileNoFollow } from './fs-safe.mjs';
import { readGitArgs } from '../corpus/hooks/lib/product-diff.mjs';
import { cachedGitObservation } from './git-observation-cache.mjs';

const DOMAIN_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_REPOS = 32;
const MAX_REFERENCES = 64;
const GIT_TIMEOUT = 4000;
const GIT_MAX_BYTES = 64 * 1024;
const GIT_IDENTITY_ARGS = ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'];

function failure(message) {
  return Object.assign(new Error(`domain: ${message}`), { code: 'E_DOMAIN', exit: 1 });
}

function boundedText(value, max) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value);
}

function validName(name) {
  return typeof name === 'string' && name.length <= 64 && DOMAIN_NAME.test(name);
}

function objectWithKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(`${label} must be a mapping`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw failure(`${label} contains an unsupported field: ${key}`);
  }
}

function safeAbsolute(full, label) {
  if (!boundedText(full, 4096) || !path.isAbsolute(full)) throw failure(`${label} must be a bounded absolute path`);
  const resolved = path.resolve(full);
  const anchor = path.parse(resolved).root;
  if (!assertNoSymlinkAncestors(anchor, path.relative(anchor, resolved))) throw failure(`${label} is unsafe or symlinked`);
  return resolved;
}

function validateReferences(refs, repoIds, label) {
  if (refs === undefined) return [];
  if (!Array.isArray(refs) || refs.length > MAX_REFERENCES) throw failure(`${label} must contain at most ${MAX_REFERENCES} references`);
  const seen = new Set();
  return refs.map(ref => {
    objectWithKeys(ref, ['repo', 'path'], `${label} reference`);
    if (!repoIds.has(ref.repo)) throw failure(`${label} reference names an unknown repo`);
    if (!boundedText(ref.path, 1024) || path.isAbsolute(ref.path) || ref.path.includes('\\') || ref.path.includes(':') || ref.path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw failure(`${label} reference must use a safe relative path`);
    }
    const key = `${ref.repo}\0${ref.path}`;
    if (seen.has(key)) throw failure(`${label} contains a duplicate reference`);
    seen.add(key);
    return { repo: ref.repo, path: ref.path };
  });
}

function validateV1(config, name) {
  objectWithKeys(config, ['domain_version', 'name', 'repos', 'shared_specs', 'shared_conventions'], 'domain config');
  if (config.domain_version !== 1) throw failure('unsupported domain_version; this reader supports version 1 display only');
  if (config.name !== name) throw failure('config name does not match the selected domain name');
  if (!Array.isArray(config.repos) || config.repos.length < 1 || config.repos.length > MAX_REPOS) throw failure(`repos must contain 1-${MAX_REPOS} members`);
  const ids = new Set();
  const repos = config.repos.map(repo => {
    objectWithKeys(repo, ['id', 'origin', 'root'], 'domain repo');
    if (!validName(repo.id) || ids.has(repo.id)) throw failure('repo IDs must be unique lowercase names');
    if (!boundedText(repo.origin, 2048)) throw failure('repo origin must be a bounded nonempty expected origin');
    ids.add(repo.id);
    return { id: repo.id, origin: repo.origin, root: safeAbsolute(repo.root, `repo ${repo.id} root`) };
  });
  return {
    domain_version: 1,
    name,
    repos,
    shared_specs: validateReferences(config.shared_specs, ids, 'shared_specs'),
    shared_conventions: validateReferences(config.shared_conventions, ids, 'shared_conventions'),
  };
}

export function normalizeDomainOrigin(value) {
  if (!boundedText(value, 2048) || value.includes('\\')) throw failure('origin must be a bounded supported repository identity');
  let parsed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try { parsed = new URL(value); } catch { throw failure('origin must be a supported repository identity'); }
    if (parsed.password || (parsed.username && parsed.protocol !== 'ssh:')) throw failure('credential-bearing domain origins are unsupported; use a credential-free repository identity');
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol) || !parsed.hostname || parsed.search || parsed.hash) throw failure('origin must not contain query credentials, fragments or unsupported schemes');
  } else {
    const scp = value.match(/^(?:[^@/:\s]+@)?([^@/:\s]+):([^?#\s]+)$/);
    if (!scp || !scp[2] || scp[2].startsWith('/') || scp[2].includes('@')) throw failure('origin must be a supported repository identity without credentials');
    try { parsed = new URL(`ssh://${scp[1]}/${scp[2]}`); } catch { throw failure('origin must be a supported repository identity'); }
  }
  const pathname = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
  if (!pathname || pathname === '/') throw failure('origin must identify a repository path');
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

function descriptors(entries, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(entries) || entries.length < (allowEmpty ? 0 : 1) || entries.length > MAX_REPOS) throw failure(`${label} must contain ${allowEmpty ? '0' : '1'}-${MAX_REPOS} members`);
  const ids = new Set();
  return entries.map(entry => {
    objectWithKeys(entry, ['id', 'origin', 'local_identity'], `${label} member`);
    if (!validName(entry.id) || ids.has(entry.id)) throw failure(`${label} IDs must be unique lowercase names`);
    ids.add(entry.id);
    if ((entry.origin !== undefined) === (entry.local_identity !== undefined)) throw failure(`${label} member must specify exactly one origin or explicitly approved local identity`);
    if (entry.origin !== undefined) return { id: entry.id, origin: normalizeDomainOrigin(entry.origin) };
    objectWithKeys(entry.local_identity, ['id', 'approved'], 'local identity');
    if (!validName(entry.local_identity.id) || entry.local_identity.approved !== true) throw failure('local identity must have a bounded ID and explicit approved: true');
    return { id: entry.id, local_identity: { id: entry.local_identity.id, approved: true } };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function sourceReferences(refs, sourceIds, label, convention = false) {
  if (refs === undefined) return [];
  if (!Array.isArray(refs) || refs.length > MAX_REFERENCES) throw failure(`${label} must contain at most ${MAX_REFERENCES} references`);
  const seen = new Set();
  return refs.map(ref => {
    objectWithKeys(ref, convention ? ['source', 'path', 'authority'] : ['source', 'path'], `${label} reference`);
    if (!sourceIds.has(ref.source)) throw failure(`${label} reference names an unknown source`);
    if (!boundedText(ref.path, 1024) || path.isAbsolute(ref.path) || ref.path.includes('\\') || ref.path.includes(':') || ref.path.split('/').some(part => !part || part === '.' || part === '..')) throw failure(`${label} reference must use a safe relative path`);
    if (convention && !['authoritative', 'advisory'].includes(ref.authority)) throw failure('shared convention authority must be authoritative or advisory');
    const key = `${ref.source}\0${ref.path}`;
    if (seen.has(key)) throw failure(`${label} contains a duplicate reference`);
    seen.add(key);
    return { source: ref.source, path: ref.path, ...(convention ? { authority: ref.authority } : {}) };
  }).sort((a, b) => a.source.localeCompare(b.source) || a.path.localeCompare(b.path));
}

const MAX_ASSETS = 32;
const MAX_COMPONENTS = 64;
const MAX_SPEC_SOURCES = 64;
const MAX_INCLUDES = 16;
export const SPEC_AUTHORITIES = Object.freeze(['reference', 'authoritative']);

function safeRelative(value, max = 1024) {
  return boundedText(value, max) && !path.isAbsolute(value) && !value.includes('\\') && !value.includes(':') && !value.split('/').some(part => !part || part === '.' || part === '..');
}

function validateAssets(assets, repoIds) {
  if (assets === undefined) return { assets: [], assetIds: new Set(), componentIds: new Set() };
  if (!Array.isArray(assets) || assets.length > MAX_ASSETS) throw failure(`assets must contain at most ${MAX_ASSETS} members`);
  const assetIds = new Set(), componentIds = new Set();
  let total = 0;
  const result = assets.map(asset => {
    objectWithKeys(asset, ['id', 'components'], 'domain asset');
    if (!validName(asset.id) || assetIds.has(asset.id)) throw failure('asset IDs must be unique lowercase names');
    assetIds.add(asset.id);
    if (!Array.isArray(asset.components) || asset.components.length < 1) throw failure(`asset ${asset.id} must contain at least one component`);
    total += asset.components.length;
    if (total > MAX_COMPONENTS) throw failure(`assets must contain at most ${MAX_COMPONENTS} components in total`);
    const components = asset.components.map(component => {
      objectWithKeys(component, ['id', 'repo', 'path', 'role'], 'asset component');
      if (!validName(component.id) || componentIds.has(component.id)) throw failure('component IDs must be unique lowercase names across the domain');
      componentIds.add(component.id);
      if (!repoIds.has(component.repo)) throw failure(`component ${component.id} names an unknown repo`);
      if (component.path !== undefined && !safeRelative(String(component.path).replace(/\/$/, ''))) throw failure(`component ${component.id} path must be a safe relative path`);
      if (component.role !== undefined && !validName(component.role)) throw failure(`component ${component.id} role must be a lowercase name`);
      return { id: component.id, repo: component.repo, ...(component.path !== undefined ? { path: String(component.path).replace(/\/$/, '') } : {}), ...(component.role !== undefined ? { role: component.role } : {}) };
    });
    return { id: asset.id, components };
  });
  return { assets: result, assetIds, componentIds };
}

function validateSpecSources(refs, sourceIds, assetIds, componentIds) {
  if (refs === undefined) return [];
  if (!Array.isArray(refs) || refs.length > MAX_SPEC_SOURCES) throw failure(`spec_sources must contain at most ${MAX_SPEC_SOURCES} entries`);
  const seen = new Set();
  return refs.map(ref => {
    objectWithKeys(ref, ['source', 'scope', 'include', 'authority'], 'spec source');
    if (!sourceIds.has(ref.source)) throw failure('spec source names an unknown source');
    const scope = ref.scope ?? 'domain';
    const match = typeof scope === 'string' ? scope.match(/^(domain|asset|component)(?:\/(.+))?$/) : null;
    if (!match || (match[1] === 'domain') !== (match[2] === undefined)) throw failure('spec source scope must be domain, asset/<id> or component/<id>');
    if (match[1] === 'asset' && !assetIds.has(match[2])) throw failure('spec source scope names an unknown asset');
    if (match[1] === 'component' && !componentIds.has(match[2])) throw failure('spec source scope names an unknown component');
    const include = ref.include ?? [];
    if (!Array.isArray(include) || include.length > MAX_INCLUDES || include.some(pattern => !safeRelative(pattern, 256))) throw failure(`spec source include must list at most ${MAX_INCLUDES} safe relative patterns`);
    const authority = ref.authority ?? 'reference';
    if (!SPEC_AUTHORITIES.includes(authority)) throw failure('spec source authority must be reference or authoritative');
    const key = `${ref.source}\0${scope}`;
    if (seen.has(key)) throw failure('spec_sources contains a duplicate source and scope');
    seen.add(key);
    return { source: ref.source, scope, include: [...include], authority };
  });
}

/** Descriptive asset and spec-source membership. It is reference context:
 * it never enters the logical execution digest, so adding or editing it does
 * not invalidate accepted domain plans. */
export function descriptiveDomainContract(config, logical = logicalDomainContract(config)) {
  const repoIds = new Set(logical.repos.map(repo => repo.id));
  const { assets, assetIds, componentIds } = validateAssets(config.assets, repoIds);
  return { assets, spec_sources: validateSpecSources(config.spec_sources, new Set(logical.sources.map(source => source.id)), assetIds, componentIds) };
}

export function logicalDomainContract(config) {
  objectWithKeys(config, ['domain_version', 'name', 'repos', 'sources', 'bindings', 'shared_specs', 'shared_conventions', 'assets', 'spec_sources'], 'domain config');
  if (config.domain_version !== 2 || !validName(config.name)) throw failure('executable domain authority requires domain_version 2 and a valid name');
  const repos = descriptors(config.repos, 'repos');
  const sources = descriptors(config.sources, 'sources', { allowEmpty: true });
  const sourceIds = new Set(sources.map(source => source.id));
  return { domain_version: 2, name: config.name, repos, sources, shared_specs: sourceReferences(config.shared_specs, sourceIds, 'shared_specs'), shared_conventions: sourceReferences(config.shared_conventions, sourceIds, 'shared_conventions', true) };
}

export function validateDomainConfig(config, name) {
  if (config?.domain_version !== 2) throw failure('domain configuration requires domain_version 2');
  return validateV2(config, name);
}

function validateV2(config, name) {
  const logical = logicalDomainContract(config);
  const descriptive = descriptiveDomainContract(config, logical);
  if (logical.name !== name) throw failure('config name does not match the selected domain name');
  objectWithKeys(config.bindings, ['repos', 'sources'], 'domain bindings');
  const bindings = {};
  for (const kind of ['repos', 'sources']) {
    const members = logical[kind];
    objectWithKeys(config.bindings[kind], members.map(member => member.id), `${kind} bindings`);
    bindings[kind] = Object.fromEntries(members.map(member => [member.id, safeAbsolute(config.bindings[kind][member.id], `${kind} ${member.id} binding`)]));
  }
  return { ...logical, bindings, ...(descriptive.assets.length ? { assets: descriptive.assets } : {}), ...(descriptive.spec_sources.length ? { spec_sources: descriptive.spec_sources } : {}) };
}

export function readDomain(name, { home = harnessGlobalHome() } = {}) {
  if (!validName(name)) throw failure('name must be a lowercase hyphenated name of at most 64 characters');
  const requestedHome = safeAbsolute(path.resolve(home), 'Harness home');
  const selectedHome = fs.existsSync(requestedHome) ? canonicalPath(requestedHome) : requestedHome;
  const configPath = safeAbsolute(path.join(selectedHome, 'domains', `${name}.yaml`), 'domain config path');
  const source = readFileNoFollow(configPath, { root: selectedHome, maxBytes: MAX_CONFIG_BYTES });
  if (source === null) throw failure('config is missing, unreadable, oversized or not a regular file');
  let config;
  try {
    const doc = YAML.parseDocument(source, { uniqueKeys: true, merge: false, strict: true });
    if (doc.errors.length || doc.warnings.length) throw failure('config contains invalid or unsupported YAML');
    YAML.visit(doc, { Alias() { throw failure('YAML aliases are unsupported in domain config'); } });
    config = doc.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error?.code === 'E_DOMAIN') throw error;
    throw failure('config contains malformed YAML');
  }
  if (![1, 2].includes(config?.domain_version)) throw failure('unsupported domain_version; supported versions are 1 and 2');
  return { config: config.domain_version === 1 ? validateV1(config, name) : validateV2(config, name), configPath, home: selectedHome };
}

function gitEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0' };
}

function gitObservation(root, prefix, args) {
  try {
    const result = spawnGitSync(['--no-pager', ...prefix, ...args], {
      cwd: root, env: gitEnvironment(), encoding: 'utf8', timeout: GIT_TIMEOUT, maxBuffer: GIT_MAX_BYTES,
    });
    if (!result || result.error || result.signal || !Number.isInteger(result.status)) return null;
    const output = String(result.stdout || '');
    return Buffer.byteLength(output) <= GIT_MAX_BYTES ? { status: result.status, output } : null;
  } catch { return null; }
}

function gitCheckoutRecords(output, count) {
  if (!output.endsWith('\n')) return null;
  const ending = output.endsWith('\r\n') ? '\r\n' : '\n';
  const lines = output.slice(0, -ending.length).split(ending);
  if (lines.length !== count || lines.some(value => !boundedText(value, 4096))) return null;
  if (!path.isAbsolute(lines[0]) || !path.isAbsolute(lines[1])) return null;
  return lines;
}

function emptyObserved() {
  return { root: null, gitDir: null, commonDir: null, head: null, origin: null, branch: null, isLinkedWorktree: null, dirty: null, statusEntries: null };
}

function checksObservation(root) {
  // This is advisory file presence, not effective policy or execution authority.
  // Preserve the bounded repository metadata path without resolving private
  // project configuration or performing another Git identity read.
  const shared = path.join(root, '.github/harness/checks.yaml');
  if (fs.lstatSync(shared, { throwIfNoEntry: false })) {
    const full = assertNoSymlinkAncestors(root, '.github/harness/checks.yaml');
    const stat = full && fs.lstatSync(full, { throwIfNoEntry: false });
    return { path: shared, present: Boolean(stat?.isFile()), status: stat?.isFile() ? 'present' : 'unsafe' };
  }
  return { path: null, present: false, status: 'not-observed' };
}

function inspectRepo(repo, options = {}) {
  const normalizeIdentity = Boolean(options.normalizeIdentity);
  const diagnostics = options.diagnostics !== false;
  return cachedGitObservation(['inspect', repo.root, repo.id, repo.origin ?? null, normalizeIdentity, diagnostics], () => inspectRepoNow(repo, { normalizeIdentity, diagnostics }));
}

function inspectRepoNow(repo, { normalizeIdentity = false, diagnostics = true } = {}) {
  const warnings = [];
  const observed = emptyObserved();
  const result = { id: repo.id, status: 'unavailable', expected: { origin: repo.origin ?? null, root: repo.root, ...(repo.local_identity ? { local_identity: repo.local_identity } : {}) }, observed, checks: { path: path.join(repo.root, '.github/harness/checks.yaml'), present: false, status: 'unavailable' }, warnings };
  const stat = fs.lstatSync(repo.root, { throwIfNoEntry: false });
  if (!stat) { warnings.push('Local root is missing; repository observation is unavailable.'); return result; }
  if (!stat.isDirectory()) throw failure(`repo ${repo.id} root is not a directory`);
  if (diagnostics) {
    result.checks = checksObservation(repo.root);
    if (!result.checks.present) warnings.push(`Named checks file is ${result.checks.status}.`);
  }
  if (!assertNoSymlinkAncestors(repo.root, '.git')) throw failure(`repo ${repo.id} Git identity path is unsafe or symlinked`);
  const prefix = readGitArgs(repo.root, { timeout: GIT_TIMEOUT, env: gitEnvironment() });
  if (!prefix) { warnings.push('Git configuration metadata is unavailable or malformed.'); return result; }
  let identity = gitObservation(repo.root, prefix, [...GIT_IDENTITY_ARGS, '--verify', 'HEAD']);
  if (!identity || ![0, 128].includes(identity.status)) { warnings.push('Git checkout metadata is unavailable.'); return result; }
  const needsHeadFallback = identity.status === 128;
  let lines = gitCheckoutRecords(identity.output, needsHeadFallback ? 3 : 4);
  if (!lines || (!needsHeadFallback && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(lines[3]))) { warnings.push('Git checkout metadata is malformed.'); return result; }
  if (needsHeadFallback) {
    if (!assertNoSymlinkAncestors(repo.root, '.git')) throw failure(`repo ${repo.id} Git identity path is unsafe or symlinked`);
    identity = gitObservation(repo.root, prefix, GIT_IDENTITY_ARGS);
    if (!identity || identity.status !== 0) { warnings.push('Git checkout metadata is unavailable.'); return result; }
    lines = gitCheckoutRecords(identity.output, 3);
    if (!lines) { warnings.push('Git checkout metadata is malformed.'); return result; }
  }
  try {
    observed.root = canonicalPath(safeAbsolute(lines[0], 'observed checkout root'));
    observed.gitDir = canonicalPath(safeAbsolute(path.resolve(repo.root, lines[1]), 'observed Git directory'));
    observed.commonDir = canonicalPath(safeAbsolute(path.resolve(repo.root, lines[2]), 'observed common Git directory'));
  } catch { warnings.push('Git checkout identity paths are unavailable.'); return result; }
  if (observed.root !== canonicalPath(repo.root)) { warnings.push('Configured local root differs from the actual checkout root.'); return result; }
  observed.isLinkedWorktree = observed.gitDir !== observed.commonDir;
  if (needsHeadFallback) {
    const head = gitObservation(repo.root, prefix, ['rev-parse', '--verify', 'HEAD']);
    if (head?.status === 0 && /^[a-f0-9]{40}(?:[a-f0-9]{24})?\r?\n$/.test(head.output)) observed.head = head.output.replace(/\r?\n$/, '');
    else if (head?.status === 128 && head.output === '') warnings.push('HEAD is unavailable; the repository may have no commits.');
    else { warnings.push('Git HEAD metadata is unavailable or malformed.'); return result; }
  } else observed.head = lines[3];
  if (diagnostics) {
    const branch = gitObservation(repo.root, prefix, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch?.status === 0 && boundedText(branch.output.trimEnd(), 1024)) observed.branch = branch.output.trimEnd();
    else if (branch?.status !== 1) warnings.push('Branch metadata is unavailable.');
  }
  const origin = gitObservation(repo.root, prefix, ['config', '--null', '--get-all', 'remote.origin.url']);
  if (origin?.status === 0 && origin.output.endsWith('\0')) {
    const urls = origin.output.slice(0, -1).split('\0');
    if (urls.length === 1 && boundedText(urls[0], 2048)) observed.origin = urls[0];
  }
  if (repo.origin) {
    let originIdentity = observed.origin;
    if (normalizeIdentity && originIdentity !== null) {
      try { originIdentity = normalizeDomainOrigin(originIdentity); } catch { originIdentity = null; }
    }
    if (originIdentity === null) warnings.push(normalizeIdentity ? 'A single valid observed origin is unavailable.' : 'A single observed origin is unavailable.');
    else if (originIdentity !== repo.origin) warnings.push('Observed origin differs from expected origin.');
  }
  if (diagnostics) {
    const status = gitObservation(repo.root, prefix, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
    if (status?.status === 0 && (!status.output || status.output.endsWith('\0'))) {
      observed.dirty = status.output.length > 0;
      observed.statusEntries = status.output ? status.output.split('\0').length - 1 : 0;
    } else warnings.push('Working tree status is unavailable or exceeds the metadata bound.');
  }
  result.status = 'available';
  return result;
}

export function inspectDomain(record) {
  const { config, configPath, home } = record;
  const executable = config.domain_version === 2;
  const repos = config.repos.map(repo => inspectRepo(executable ? { ...repo, root: config.bindings.repos[repo.id] } : repo, { normalizeIdentity: executable }));
  return {
    schema: 1, mode: 'domain', verb: 'show', status: 'ok', exitCode: 0,
    name: config.name, domainVersion: config.domain_version, configPath, home,
    executionSupported: executable,
    repos,
    ...(executable ? { sources: config.sources.map(source => inspectRepo({ ...source, root: config.bindings.sources[source.id] }, { normalizeIdentity: true })) } : {}),
    sharedSpecs: config.shared_specs.map(ref => ({ ...ref, authority: executable ? 'spec' : 'advisory' })),
    sharedConventions: config.shared_conventions.map(ref => ({ ...ref, authority: executable ? ref.authority : 'advisory' })),
    ...(executable ? { assets: config.assets ?? [], specSources: config.spec_sources ?? [] } : {}),
    warnings: [executable ? 'Version 2 supports explicit accepted domain plans; these observations alone confer no execution authority.' : 'Version 1 membership and shared references are advisory; executable domain delivery is unavailable.'],
  };
}

export function observeDomainRepository(root, descriptor) {
  return inspectRepo({ ...descriptor, root: safeAbsolute(root, `${descriptor.id} checkout root`) }, { normalizeIdentity: true });
}

export function observeDomainRepositoryIdentity(root, descriptor) {
  return inspectRepo({ ...descriptor, root: safeAbsolute(root, `${descriptor.id} checkout root`) }, { normalizeIdentity: true, diagnostics: false });
}
