import { spawnGitSync } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { projectStoreDir } from './project-layout.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { resolveDefaultBranch } from './git-context.mjs';
import { assertNoSymlinkAncestors, readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { gitMetadataEnvironment } from '../corpus/hooks/lib/product-diff.mjs';

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const STATE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const MODEL_BYTES = 1024 * 1024;
const INDEX_BYTES = 128 * 1024;
const SOURCE_BYTES = 1024 * 1024;
const SOURCE_TOTAL = 16 * 1024 * 1024;
const SOURCE_COUNT = 2048;
const READ = 'codebase-context/references/flow-models.md';
const AUTHORITY = 'descriptive-context';
const SCOPE = 'committed-default-branch';
const error = message => Object.assign(new Error(`flow model: ${message}`), { code: 'E_FLOW_MODEL', exit: 2 });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const serialize = value => JSON.stringify(stable(value));
const same = (a, b) => serialize(a) === serialize(b);

function fields(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw error(`invalid ${label} fields`);
}
function text(value, limit, label) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit || /[\x00-\x1f\x7f]/.test(value)) throw error(`invalid ${label}`);
  return value;
}
function array(value, minimum, maximum, label) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw error(`invalid ${label} count`);
  return value;
}
function unique(values, label) {
  if (new Set(values).size !== values.length) throw error(`duplicate ${label}`);
  return values;
}
function relative(value, { root = false } = {}) {
  text(value, 512, 'source/watch path');
  if (root && value === '.') return value;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes('\\') || value.includes(':') || value.split('/').some(part => !part || part === '.' || part === '..')) throw error('source/watch path must be a contained relative path');
  return value;
}
function watches(value) {
  return unique(array(value, 1, 64, 'watch paths').map(item => relative(typeof item === 'string' ? item.replace(/\/$/, '') : item, { root: true })), 'watch path').sort();
}
const watchesPath = (watch, file) => watch === '.' || file === watch || file.startsWith(`${watch}/`);
function project(workspace, home) {
  if (typeof workspace !== 'string' || !workspace) throw error('workspace is required');
  const anchor = path.resolve(home || harnessGlobalHome());
  const store = projectStoreDir(workspace, { home: anchor });
  const rel = path.relative(anchor, path.join(store, 'knowledge', 'flow-models'));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw error('unsafe private project namespace');
  return { workspace: path.resolve(workspace), home: anchor, anchor, rel, id: path.basename(store) };
}
function location(owner, rel) {
  const full = assertNoSymlinkAncestors(owner.anchor, path.join(owner.rel, rel));
  if (!full) throw error('unsafe or symlinked private model path');
  return full;
}
function read(owner, rel, maxBytes) {
  const full = location(owner, rel);
  const stat = fs.lstatSync(full, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw error('private model is not a regular file');
  const bytes = readFileNoFollow(full, { root: owner.anchor, maxBytes, encoding: null });
  if (bytes === null) throw error('private model is unreadable or exceeds its byte limit');
  return bytes;
}
function parse(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw error(`invalid ${label} JSON`); }
}
function git(workspace, args, { input, maxBuffer = INDEX_BYTES, buffer = false } = {}) {
  const result = spawnGitSync(['--no-pager', '--no-replace-objects', '--no-lazy-fetch', '-c', 'core.fsmonitor=false', ...args], { cwd: workspace, input, ...(buffer ? {} : { encoding: 'utf8' }), maxBuffer, timeout: 10_000, env: { ...gitMetadataEnvironment(), GIT_NO_LAZY_FETCH: '1' } });
  if (result.status !== 0 && /unknown option:\s*--no-lazy-fetch\b/i.test(String(result.stderr || ''))) throw error('Upgrade Git to a version supporting --no-lazy-fetch before using application flow models. Reads remain disabled to prevent automatic fetches.');
  if (result.error || result.status !== 0) throw error('committed Git metadata is unavailable or exceeds its bounds');
  return result.stdout;
}
function observeDefault(owner) {
  const selected = resolveDefaultBranch(owner.workspace, { home: owner.home });
  if (!selected) throw error('default branch is unresolved; configure it or establish origin/HEAD');
  text(selected.name, 200, 'default branch name');
  git(owner.workspace, ['check-ref-format', `refs/heads/${selected.name}`]);
  for (const ref of [`refs/remotes/origin/${selected.name}`, `refs/heads/${selected.name}`]) {
    try {
      const commit = git(owner.workspace, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
      if (SHA.test(commit)) return { branch: { name: selected.name, source: selected.source, ref }, commit };
    } catch { /* A configured branch may exist only as a local ref. */ }
  }
  throw error('default branch has no available committed tip');
}

// Read raw committed blobs in one bounded Git process. Dirty worktree bytes,
// checkout filters, and executable source files never participate in generation.
function sourceBindings(owner, commit, watchPaths, { allowEmpty = false } = {}) {
  const selection = watchPaths.includes('.') ? [] : ['--', ...watchPaths];
  const tree = git(owner.workspace, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree', commit, ...selection], { maxBuffer: 4 * 1024 * 1024 });
  const selected = [];
  for (const row of tree.split('\0').filter(Boolean)) {
    const match = /^(\d+) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
    if (!match) throw error('malformed committed source inventory');
    const [, mode, kind, oid, file] = match;
    if (!watchPaths.some(watch => watchesPath(watch, file))) continue;
    relative(file);
    if (kind !== 'blob' || !['100644', '100755'].includes(mode) || !SHA.test(oid)) throw error(`watched source is not a regular committed file: ${file}`);
    selected.push({ path: file, mode, oid });
    if (selected.length > SOURCE_COUNT) throw error('watched source count exceeds 2048; select narrower watch paths');
  }
  if (!selected.length) {
    if (allowEmpty) return [];
    throw error('watch paths select no committed regular sources');
  }
  const batch = git(owner.workspace, ['cat-file', '--batch'], { input: selected.map(source => source.oid).join('\n') + '\n', buffer: true, maxBuffer: SOURCE_TOTAL + 1024 * 1024 });
  let offset = 0, total = 0;
  return selected.map(source => {
    const end = batch.indexOf(10, offset);
    if (end < 0) throw error('incomplete committed source batch');
    const header = /^([a-f0-9]+) blob (\d+)$/.exec(batch.subarray(offset, end).toString('utf8'));
    const size = header ? Number(header[2]) : -1;
    if (!header || header[1] !== source.oid || !Number.isSafeInteger(size) || size < 0 || size > SOURCE_BYTES || (total += size) > SOURCE_TOTAL) throw error('watched source bytes exceed generation bounds');
    offset = end + 1;
    if (offset + size >= batch.length || batch[offset + size] !== 10) throw error('incomplete committed source bytes');
    const sha256 = hash(batch.subarray(offset, offset + size));
    offset += size + 1;
    return { path: source.path, mode: source.mode, sha256 };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function preparation(value) {
  fields(value, ['version', 'projectId', 'generationCommit', 'defaultBranch', 'watchPaths', 'sources', 'digest'], [], 'preparation');
  if (value.version !== 1 || !SHA.test(value.generationCommit || '') || !HASH.test(value.digest || '')) throw error('invalid preparation version or digest');
  text(value.projectId, 512, 'preparation project identity');
  fields(value.defaultBranch, ['name', 'source', 'ref'], [], 'default branch');
  const { name, source, ref } = value.defaultBranch;
  text(name, 200, 'default branch name');
  if (!['config', 'origin-head'].includes(source) || ![`refs/remotes/origin/${name}`, `refs/heads/${name}`].includes(ref)) throw error('invalid default branch binding');
  const watchPaths = watches(value.watchPaths);
  const sources = array(value.sources, 1, SOURCE_COUNT, 'source bindings').map(item => {
    fields(item, ['path', 'mode', 'sha256'], [], 'source binding'); relative(item.path);
    if (!['100644', '100755'].includes(item.mode) || !HASH.test(item.sha256 || '') || !watchPaths.some(watch => watchesPath(watch, item.path))) throw error('invalid source binding');
    return item;
  });
  unique(sources.map(item => item.path), 'source binding');
  const packet = { version: 1, projectId: value.projectId, generationCommit: value.generationCommit, defaultBranch: { name, source, ref }, watchPaths, sources };
  if (hash(serialize(packet)) !== value.digest) throw error('preparation digest or source bindings changed');
  return { ...packet, digest: value.digest };
}
function statechart(value, packet) {
  fields(value, ['version', 'format', 'flows'], ['assumptions', 'limitations'], 'statechart');
  if (value.version !== 1 || value.format !== 'statechart') throw error('shared model requires version 1 structured statechart');
  const knownSources = new Set(packet.sources.map(source => source.path));
  const flows = array(value.flows, 1, 64, 'flows').map(flow => {
    fields(flow, ['id', 'title', 'sources', 'initial', 'states', 'transitions'], ['properties'], 'flow');
    if (typeof flow.id !== 'string' || !ID.test(flow.id) || flow.id.length > 64) throw error('invalid flow ID');
    text(flow.title, 200, 'flow title');
    unique(array(flow.sources, 1, 256, 'flow sources').map(source => {
      relative(source); if (!knownSources.has(source)) throw error('flow source has no captured source binding'); return source;
    }), 'flow source');
    const states = array(flow.states, 1, 128, 'states').map(state => {
      fields(state, ['id'], ['kind'], 'state');
      if (typeof state.id !== 'string' || !STATE_ID.test(state.id) || state.id.length > 64 || state.kind !== undefined && !['normal', 'initial', 'terminal', 'error'].includes(state.kind)) throw error('invalid state');
      return state;
    });
    const ids = new Set(unique(states.map(state => state.id), 'state'));
    if (!ids.has(flow.initial)) throw error('initial state is absent from the flow');
    array(flow.transitions, 0, 512, 'transitions').forEach(transition => {
      fields(transition, ['from', 'to', 'event'], ['guard'], 'transition');
      if (!ids.has(transition.from) || !ids.has(transition.to)) throw error('transition references an absent state');
      text(transition.event, 200, 'transition event');
      if (transition.guard !== undefined) text(transition.guard, 1000, 'transition guard');
    });
    if (flow.properties !== undefined) array(flow.properties, 0, 32, 'flow properties').forEach(item => text(item, 1000, 'property'));
    return flow;
  });
  unique(flows.map(flow => flow.id), 'flow ID');
  for (const name of ['assumptions', 'limitations']) if (value[name] !== undefined) array(value[name], 0, 64, name).forEach(item => text(item, 1000, name));
  return value;
}
function candidate(value) {
  let bytes;
  try { bytes = serialize(value); } catch { throw error('candidate must be bounded JSON'); }
  if (Buffer.byteLength(bytes) > MODEL_BYTES) throw error('candidate exceeds 1 MiB');
  fields(value, ['version', 'preparation', 'model'], [], 'candidate');
  if (value.version !== 1) throw error('unsupported candidate version');
  const packet = preparation(value.preparation);
  return { version: 1, preparation: packet, model: statechart(value.model, packet) };
}
function indexFor(record, bytes) {
  return { version: 1, projectId: record.preparation.projectId, generationCommit: record.preparation.generationCommit, sha256: hash(bytes), bytes: bytes.length, watchPaths: record.preparation.watchPaths, flows: record.model.flows.map(({ id, title, sources }) => ({ id, title, sources })) };
}
function readIndex(owner) {
  const bytes = read(owner, 'current.json', INDEX_BYTES);
  if (bytes === null) return null;
  const index = parse(bytes, 'current index');
  fields(index, ['version', 'projectId', 'generationCommit', 'sha256', 'bytes', 'watchPaths', 'flows'], [], 'current index');
  if (index.version !== 1 || index.projectId !== owner.id || !SHA.test(index.generationCommit || '') || !HASH.test(index.sha256 || '') || !Number.isSafeInteger(index.bytes) || index.bytes <= 0 || index.bytes > MODEL_BYTES) throw error('invalid current model identity');
  if (!same(watches(index.watchPaths), index.watchPaths)) throw error('invalid current watch index');
  array(index.flows, 1, 64, 'indexed flows').forEach(flow => {
    fields(flow, ['id', 'title', 'sources'], [], 'indexed flow');
    if (typeof flow.id !== 'string' || !ID.test(flow.id) || flow.id.length > 64) throw error('invalid indexed flow ID');
    text(flow.title, 200, 'indexed title');
    unique(array(flow.sources, 1, 256, 'indexed source paths').map(item => relative(item)), 'indexed source');
  });
  unique(index.flows.map(flow => flow.id), 'indexed flow');
  return index;
}
function readGeneration(owner, index) {
  const bytes = read(owner, `${index.generationCommit}/model.json`, MODEL_BYTES);
  if (bytes === null || bytes.length !== index.bytes || hash(bytes) !== index.sha256) throw error('model bytes changed or are missing');
  const record = candidate(parse(bytes, 'model generation'));
  if (!same(indexFor(record, bytes), index)) throw error('model generation and current index disagree');
  return record;
}
function baseStatus(owner, index) {
  return { projectId: owner.id, generationCommit: index.generationCommit, defaultCommit: null, reference: location(owner, `${index.generationCommit}/model.json`), sha256: index.sha256, scope: SCOPE, authority: AUTHORITY };
}
function changedSources(before, after) {
  const a = new Map(before.map(source => [source.path, source])), b = new Map(after.map(source => [source.path, source]));
  return [...new Set([...a.keys(), ...b.keys()])].filter(file => !same(a.get(file), b.get(file))).sort();
}
function inspect(owner, suppliedIndex) {
  let index = suppliedIndex, record = null, status = { state: 'unknown', projectId: owner.id };
  try {
    index ||= readIndex(owner);
    if (!index) return { status: { state: 'absent', projectId: owner.id }, record: null };
    status = { ...status, ...baseStatus(owner, index) };
    record = readGeneration(owner, index);
    status.defaultRef = record.preparation.defaultBranch.ref;
    const observed = observeDefault(owner);
    status.defaultCommit = observed.commit;
    if (!same(observed.branch, record.preparation.defaultBranch)) throw error('default branch resolution changed since generation');
    const original = sourceBindings(owner, index.generationCommit, index.watchPaths);
    if (!same(original, record.preparation.sources)) throw error('generation source bindings do not match committed bytes');
    if (observed.commit !== index.generationCommit) {
      try { git(owner.workspace, ['merge-base', '--is-ancestor', index.generationCommit, observed.commit]); }
      catch { throw error('default history diverged or generation ancestry is unavailable'); }
    }
    const changed = observed.commit === index.generationCommit ? [] : changedSources(original, sourceBindings(owner, observed.commit, index.watchPaths, { allowEmpty: true }));
    const after = observeDefault(owner);
    if (!same(after, observed) || !same(readIndex(owner), index)) throw error('default tip or current pointer changed during freshness inspection');
    status = { ...status, state: changed.length ? 'stale' : 'current', changedPaths: changed.slice(0, 64), omittedChangedPaths: Math.max(0, changed.length - 64), reason: changed.length ? 'Default branch advanced through watched source changes.' : observed.commit !== index.generationCommit ? 'Default branch advanced without watched source changes.' : 'Model matches the observed committed default tip.' };
    return { status, record };
  } catch (failure) {
    return { status: { ...status, state: 'unknown', reason: String(failure.message).slice(0, 500) }, record };
  }
}

function withPublication(owner, publish) {
  const lock = location(owner, '.publish.lock');
  const bytes = Buffer.from(`${JSON.stringify({ version: 1, pid: process.pid, token: crypto.randomUUID() })}\n`);
  const deadline = Date.now() + 5000;
  while (!writeFileContained(owner.anchor, path.join(owner.rel, '.publish.lock'), bytes, { exclusive: true })) {
    // Refuse unsafe existing lock paths, and never guess whether a prior writer
    // has died. Recovery of an interrupted owner is explicit inspection.
    // A lock can disappear, or be briefly unreadable, between the exclusive
    // create and this read. Windows hits that window when two publishers race.
    // Retry until the deadline. An oversized or non-file lock still fails now.
    try {
      read(owner, '.publish.lock', 1024);
    } catch (cause) {
      if (!String(cause.message).includes('unreadable or exceeds its byte limit')) throw cause;
      const stat = fs.lstatSync(lock, { throwIfNoEntry: false });
      if (stat?.isFile() && stat.size > 1024) throw cause;
    }
    if (Date.now() >= deadline) throw error(`publication is busy; retry after the active writer finishes. If it was interrupted, inspect ${lock} and remove that lock only after confirming its writer has stopped`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  let result, failure;
  try { result = publish(); } catch (cause) { failure = cause; }
  try {
    const current = read(owner, '.publish.lock', 1024);
    if (!current || !current.equals(bytes)) throw error('publication lock changed before release');
    fs.unlinkSync(location(owner, '.publish.lock'));
  } catch {
    failure = error(`${failure ? `${failure.message}; ` : ''}publication lock cleanup failed; inspect ${lock} before retrying`);
  }
  if (failure) throw failure;
  return result;
}

export function prepareFlowModel({ workspace, home, watchPaths } = {}) {
  const owner = project(workspace, home);
  const selected = watches(watchPaths === undefined ? readIndex(owner)?.watchPaths || ['.'] : watchPaths);
  const before = observeDefault(owner), sources = sourceBindings(owner, before.commit, selected);
  if (!same(before, observeDefault(owner))) throw error('default branch changed during preparation');
  const packet = { version: 1, projectId: owner.id, generationCommit: before.commit, defaultBranch: before.branch, watchPaths: selected, sources };
  return { ...packet, digest: hash(serialize(packet)) };
}

export function publishFlowModel({ workspace, home, input, dryRun = false } = {}) {
  const owner = project(workspace, home), record = candidate(input);
  if (record.preparation.projectId !== owner.id) throw error('preparation belongs to another project');
  if (!same(prepareFlowModel({ workspace, home, watchPaths: record.preparation.watchPaths }), record.preparation)) throw error('preparation is stale or its captured bindings changed');
  const bytes = Buffer.from(`${JSON.stringify(stable(record), null, 2)}\n`);
  if (bytes.length > MODEL_BYTES) throw error('serialized model exceeds 1 MiB');
  const index = indexFor(record, bytes), indexBytes = `${JSON.stringify(stable(index), null, 2)}\n`;
  if (Buffer.byteLength(indexBytes) > INDEX_BYTES) throw error('flow index exceeds 128 KiB');
  const generation = `${index.generationCommit}/model.json`;
  const perform = () => {
    const previous = readIndex(owner);
    if (previous) readGeneration(owner, previous);
    const existing = read(owner, generation, MODEL_BYTES);
    if (existing && !existing.equals(bytes)) throw error('conflicting retry: this generation already has different authored bytes');
    const replayed = Boolean(previous && same(previous, index));
    const result = { ...baseStatus(owner, index), state: 'current', defaultRef: record.preparation.defaultBranch.ref, defaultCommit: record.preparation.generationCommit, replayed, dryRun: Boolean(dryRun) };
    if (dryRun) return result;
    const publish = (rel, content, exclusive = false) => {
      location(owner, rel);
      if (!writeFileContained(owner.anchor, path.join(owner.rel, rel), content, { exclusive })) {
        const current = read(owner, rel, rel === 'current.json' ? INDEX_BYTES : MODEL_BYTES);
        if (!current || !current.equals(Buffer.from(content))) throw error('unsafe model destination or conflicting publication');
      }
    };
    if (!existing) publish(generation, bytes, true);
    const observed = observeDefault(owner);
    if (observed.commit !== record.preparation.generationCommit || !same(observed.branch, record.preparation.defaultBranch)) throw error('default tip changed before current model publication; prepare again');
    if (!same(readIndex(owner), previous)) throw error('current model pointer changed during publication; retry explicitly');
    if (!replayed) publish('current.json', indexBytes);
    if (!same(readIndex(owner), index)) throw error('current model pointer changed after publication');
    return { ...flowModelStatus({ workspace, home }), replayed, dryRun: false };
  };
  return dryRun ? perform() : withPublication(owner, perform);
}

export function flowModelStatus({ workspace, home } = {}) {
  try { return inspect(project(workspace, home)).status; }
  catch (failure) { return { state: 'unknown', reason: String(failure.message).slice(0, 500) }; }
}

export function showFlowModel({ workspace, home } = {}) {
  try {
    const { status, record } = inspect(project(workspace, home));
    return { ...status, model: record?.model || null, preparation: record?.preparation || null };
  } catch (failure) { return { state: 'unknown', reason: String(failure.message).slice(0, 500), model: null, preparation: null }; }
}

function requestedFiles(workspace, files) {
  return array(files || [], 0, 128, 'context files').map(file => {
    text(file, 4096, 'context path');
    const normalized = file.replace(/\\/g, '/');
    const rel = path.isAbsolute(normalized)
      ? path.relative(path.resolve(workspace), normalized).split(path.sep).join('/')
      : normalized.replace(/^(?:\.\/)+/, '').replace(/\/$/, '') || '.';
    return relative(rel, { root: true });
  });
}

export function flowModelContext({ workspace, home, files = [], query = '' } = {}) {
  if (!files?.length && !String(query).trim()) return null;
  let owner, index, matched;
  try {
    owner = project(workspace, home); index = readIndex(owner);
    if (!index) return null;
    const requested = requestedFiles(workspace, files), words = String(query).toLowerCase().slice(0, 4096).split(/[^a-z0-9-]+/);
    // Inventory watches bind freshness, including future writers. Only the
    // declared per-flow sources and explicit flow IDs establish task relevance.
    matched = index.flows.filter(flow => words.includes(flow.id) || requested.some(file => flow.sources.some(source => watchesPath(file, source))));
    if (!matched.length) return null;
  } catch { return null; }
  try {
    const status = inspect(owner, index).status;
    const context = { state: status.state, generationCommit: index.generationCommit, defaultCommit: status.defaultCommit || null, reference: location(owner, `${index.generationCommit}/model.json`), sha256: index.sha256, scope: SCOPE, authority: AUTHORITY, flowIds: matched.map(flow => flow.id), omittedFlows: 0, read: READ, ...(status.state === 'current' ? {} : { reason: status.reason }) };
    while (Buffer.byteLength(JSON.stringify(context)) > 4096 && context.flowIds.length) { context.flowIds.pop(); context.omittedFlows++; }
    return Buffer.byteLength(JSON.stringify(context)) <= 4096 ? context : { state: 'unknown', flowIds: [], read: READ, authority: AUTHORITY, reason: 'Flow model reference exceeds the bounded context budget.' };
  } catch {
    return { state: 'unknown', flowIds: [], read: READ, authority: AUTHORITY, reason: 'Flow model namespace changed during context inspection.' };
  }
}

export function flowMaintenance({ workspace, home } = {}) {
  const status = flowModelStatus({ workspace, home });
  return status.state === 'stale' ? { state: 'refresh-required', generationCommit: status.generationCommit, defaultCommit: status.defaultCommit, changedPaths: status.changedPaths, omittedChangedPaths: status.omittedChangedPaths, nextTools: ['ae flows prepare --json'], read: READ } : null;
}
