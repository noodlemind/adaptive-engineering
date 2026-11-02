import { gitExecutable } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import { gitMetadataEnvironment } from '../corpus/hooks/lib/product-diff.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harnessGlobalHome } from './paths.mjs';
import { workspaceStorageId } from './knowledge/store.mjs';
import { createHash } from 'node:crypto';
import { readFileNoFollow, canonicalPath, assertNoSymlinkAncestors } from './fs-safe.mjs';

const objectHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textHash = value => createHash('sha256').update(value).digest('hex');
const CONVERSIONS_REL = '.harness/operations/plans/conversions';
const CONVERSION_GUARD_LIMIT = 256;
const CONVERSION_GUARD_BYTES = 8 * 1024 * 1024;
export function canonicalPlanFilePath(full) {
  const resolved = path.resolve(full);
  if (fs.existsSync(resolved)) return canonicalPath(resolved);
  const parent = canonicalPath(path.dirname(resolved));
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Plan parent has no regular canonical directory identity');
  return path.join(parent, path.basename(resolved));
}
export const conversionPointerRel = full => `${CONVERSIONS_REL}/${objectHash(canonicalPlanFilePath(full))}.json`;

function registeredLegacyPlanNamespaces(workspace, target, state) {
  const directory = full => {
    const raw = path.resolve(full), stat = fs.lstatSync(raw);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Registered plan root is unsafe');
    if (!assertNoSymlinkAncestors(path.parse(raw).root, path.relative(path.parse(raw).root, raw))) throw new Error('Registered plan root has a symlink');
    const real = canonicalPath(raw);
    if (!assertNoSymlinkAncestors(path.parse(real).root, path.relative(path.parse(real).root, real))) throw new Error('Registered plan root has a symlink');
    return real;
  };
  const stamp = full => { const s = fs.lstatSync(full, { bigint: true }); return `${s.dev}:${s.ino}:${s.birthtimeNs}`; };
  const git = (root, args) => {
    const remaining = state.deadline - Date.now();
    if (remaining <= 0) throw new Error('Registered plan metadata deadline expired');
    const result = gitSpawn(root, ['-c', 'core.fsmonitor=false', ...args], { timeout: remaining, maxBuffer: 64 * 1024 });
    if (result.error || result.status !== 0) throw new Error('Registered plan metadata unavailable');
    return String(result.stdout || '');
  };
  const observe = root => {
    const values = git(root, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']).trimEnd().split('\n');
    if (values.length !== 3) throw new Error('Registered plan metadata is malformed');
    const [top, gitDir, commonDir] = values.map(value => directory(path.resolve(root, value.trimEnd())));
    if (path.relative(root, top) !== '') throw new Error('Registered plan metadata has another root');
    return { root: top, gitDir, commonDir, commonStamp: stamp(commonDir) };
  };
  const registered = metadata => {
    if (!state.roots.includes(metadata.root)) return false;
    const dotGit = path.join(metadata.root, '.git'), stat = fs.lstatSync(dotGit);
    if (stat.isSymbolicLink()) return false;
    if (stat.isDirectory()) return path.relative(canonicalPath(dotGit), metadata.gitDir) === '' && path.relative(metadata.gitDir, metadata.commonDir) === '';
    const relative = path.relative(path.join(metadata.commonDir, 'worktrees'), metadata.gitDir);
    const pointer = readFileNoFollow(dotGit, { root: metadata.root, maxBytes: 4096 });
    const backlink = readFileNoFollow(path.join(metadata.gitDir, 'gitdir'), { root: metadata.gitDir, maxBytes: 4096 });
    const backPath = backlink && path.resolve(metadata.gitDir, backlink.trim());
    return stat.isFile() && relative && relative !== '.' && relative !== '..' && !path.isAbsolute(relative) && !relative.includes(path.sep) && pointer?.startsWith('gitdir: ') && backlink &&
      path.relative(directory(path.resolve(metadata.root, pointer.slice(8).trim())), metadata.gitDir) === '' &&
      assertNoSymlinkAncestors(path.parse(backPath).root, path.relative(path.parse(backPath).root, backPath)) &&
      path.relative(canonicalPath(backPath), canonicalPath(dotGit)) === '';
  };
  if (!state.owner) {
    state.deadline = Date.now() + 4000;
    state.owner = observe(directory(canonicalPath(workspace)));
    const listed = git(state.owner.root, ['worktree', 'list', '--porcelain', '-z']).split('\0').filter(value => value.startsWith('worktree '));
    if (!listed.length || listed.length > 128) throw new Error('Registered worktree listing is empty or capped');
    state.roots = listed.flatMap(value => { try { return [directory(value.slice(9))]; } catch { return []; } });
    state.accepted = new Map();
    if (!registered(state.owner)) throw new Error('Invoking checkout is not physically registered');
  }
  for (const candidate of state.roots) {
    const rel = path.relative(candidate, target).replace(/\\/g, '/');
    if (![WORKSPACE_PLANS_REL, SESSION_PLANS_REL].some(namespace => rel.startsWith(`${namespace}/`))) continue;
    if (!state.accepted.has(candidate)) {
      const metadata = observe(candidate);
      if (path.relative(metadata.commonDir, state.owner.commonDir) !== '' || metadata.commonStamp !== state.owner.commonStamp || !registered(metadata)) throw new Error('Legacy plan checkout has foreign Git authority');
      state.accepted.set(candidate, [WORKSPACE_PLANS_REL, SESSION_PLANS_REL].flatMap(namespace => {
        const full = path.join(candidate, namespace), stat = fs.lstatSync(full, { throwIfNoEntry: false });
        return stat?.isDirectory() && !stat.isSymbolicLink() && assertNoSymlinkAncestors(candidate, namespace) ? [canonicalPath(full)] : [];
      }));
    }
    if (Date.now() >= state.deadline || stamp(state.owner.commonDir) !== state.owner.commonStamp) throw new Error('Registered legacy authority changed or expired');
    return state.accepted.get(candidate);
  }
  return [];
}

export function readPlanConversionGuard(workspace, full, { home } = {}) {
  try {
    const root = projectStoreDir(workspace, { home });
    const old = canonicalPlanFilePath(full), expected = conversionPointerRel(old), dir = path.join(root, CONVERSIONS_REL);
    if (!assertNoSymlinkAncestors(root, CONVERSIONS_REL)) return { state: 'invalid' };
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { state: 'invalid' };
    const entries = fs.readdirSync(dir);
    if (entries.length > CONVERSION_GUARD_LIMIT) return { state: 'invalid' };
    const namespaces = [[home || harnessGlobalHome(), externalPlansDir(workspace, { home })], [workspace, path.join(workspace, WORKSPACE_PLANS_REL)], [workspace, path.join(workspace, SESSION_PLANS_REL)]]
      .flatMap(([anchor, candidate]) => {
        const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
        return stat?.isDirectory() && !stat.isSymbolicLink() && assertNoSymlinkAncestors(anchor, path.relative(anchor, candidate)) ? [canonicalPath(candidate)] : [];
      });
    const matches = [];
    let reservation = null;
    const registeredNamespaces = {};
    let bytes = 0;
    for (const name of entries) {
      const pointerRel = `${CONVERSIONS_REL}/${name}`;
      const invalid = () => ({ state: 'invalid', pointerRel });
      if (!/^[a-f0-9]{64}\.json$/.test(name)) return invalid();
      const pointerText = readFileNoFollow(path.join(root, pointerRel), { root, maxBytes: 4096 });
      bytes += Buffer.byteLength(pointerText || '');
      const pointer = JSON.parse(pointerText || 'null');
      if (!pointer || pointer.version !== 1 || !/^[a-f0-9]{64}$/.test(pointer.inputDigest || '') || !/^\.harness\/operations\/plans\/[a-f0-9]{64}\.json$/.test(pointer.record || '')) return invalid();
      const recordText = readFileNoFollow(path.join(root, pointer.record), { root, maxBytes: 1024 * 1024 });
      bytes += Buffer.byteLength(recordText || '');
      if (bytes > CONVERSION_GUARD_BYTES) return invalid();
      if (recordText === null && !fs.lstatSync(path.join(root, pointer.record), { throwIfNoEntry: false }) && pointerRel === expected) {
        reservation = { state: 'reserved', pointerRel, legacy: false };
        continue;
      }
      const record = JSON.parse(recordText || 'null');
      const value = record?.value;
      if (record?.version !== 1 || record.kind !== 'conversion' || record.inputDigest !== pointer.inputDigest || !['pending', 'completed'].includes(record.state) || record.id !== objectHash(value) || typeof value?.oldPath !== 'string' || !path.isAbsolute(value.oldPath) || !value.oldPath.endsWith('.md') || /[\0\r\n]/.test(value.oldPath) || value.newPath !== value.oldPath.replace(/\.md$/, '.hplan') || typeof value.original !== 'string' || textHash(value.original) !== value.oldRevision || typeof value.text !== 'string' || textHash(value.text) !== value.newRevision) return invalid();
      const anchor = path.parse(value.oldPath).root;
      if (!assertNoSymlinkAncestors(anchor, path.relative(anchor, value.oldPath))) return invalid();
      if (/~[0-9]+\.md$/i.test(path.basename(value.oldPath)) && !fs.lstatSync(value.oldPath, { throwIfNoEntry: false })) return invalid();
      const recordedOld = canonicalPlanFilePath(value.oldPath);
      const contains = namespace => {
        const relative = path.relative(namespace, recordedOld);
        return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      };
      if (!namespaces.some(contains) && !registeredLegacyPlanNamespaces(workspace, recordedOld, registeredNamespaces).some(contains)) return invalid();
      const rawKey = `${CONVERSIONS_REL}/${objectHash(path.resolve(value.oldPath))}.json`;
      if (![rawKey, conversionPointerRel(recordedOld)].includes(pointerRel) || path.relative(path.join(path.dirname(recordedOld), path.basename(recordedOld).replace(/\.md$/, '.hplan')), canonicalPlanFilePath(value.newPath)) !== '') return invalid();
      if (path.relative(old, recordedOld) === '') matches.push({ ...record, pointerRel, legacy: pointerRel !== conversionPointerRel(recordedOld) });
    }
    return matches.length > 1 || reservation && matches.length ? { state: 'invalid' } : matches[0] || reservation;
  } catch { return { state: 'invalid' }; }
}

export function planConversionPublished(workspace, full, options = {}) {
  return Boolean(readPlanConversionGuard(workspace, full, options));
}

export function planConversionPending(workspace, full, options = {}) {
  if (!full.endsWith('.hplan')) return false;
  const record = readPlanConversionGuard(workspace, full.replace(/\.hplan$/, '.md'), options);
  return Boolean(record && record.state !== 'completed');
}

/** Committed change-contract location (this library, teams that check plans in). */
export const WORKSPACE_PLANS_REL = 'docs/plans';
/** Session-local plans for app repos that gitignore harness artifacts. */
export const SESSION_PLANS_REL = '.harness/plans';
export const WORKSPACE_SOLUTIONS_REL = 'docs/solutions';
export const WORKSPACE_MAP_REL = 'docs/codebase-map.md';
export const SESSION_MAP_REL = '.harness/codebase-map.md';
export const WORKSPACE_AGENT_CTX_REL = 'docs/agent-context.md';
export const SESSION_AGENT_CTX_REL = '.harness/agent-context.md';

const PLAN_FILE = /^\d{4}-\d{2}-\d{2}-(?:feat|fix|docs|refactor|chore)-[a-z0-9]+(?:-[a-z0-9]+)*-plan\.(?:md|hplan)$/;

export function projectStoreDir(workspace, { home } = {}) {
  return path.join(home || harnessGlobalHome(), 'projects', workspaceStorageId(workspace, { home }));
}

export function dirExists(root, rel) {
  try {
    return fs.statSync(path.join(root, rel)).isDirectory();
  } catch {
    return false;
  }
}

export function fileExists(root, rel) {
  try {
    return fs.statSync(path.join(root, rel)).isFile();
  } catch {
    return false;
  }
}

function workspaceHasGitDir(workspace) {
  try {
    const st = fs.lstatSync(path.join(workspace, '.git'));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

function gitSpawn(workspace, args, { timeout = 10_000, maxBuffer } = {}) {
  try {
    return spawnSync(gitExecutable(), args, { cwd: workspace, encoding: 'utf8', timeout, ...(maxBuffer ? { maxBuffer } : {}), env: gitMetadataEnvironment() });
  } catch (err) {
    return { status: 1, stdout: '', stderr: String(err?.message || err || ''), error: err };
  }
}

/** 'inside' | 'outside' | 'unknown' — unknown is fail-closed (do not migrate). */
export function gitWorktreeState(workspace) {
  const res = gitSpawn(workspace, ['rev-parse', '--is-inside-work-tree']);
  if (res.error) return 'unknown';
  if (res.status === 0 && String(res.stdout).trim() === 'true') return 'inside';
  const err = String(res.stderr || '');
  if (/not a git repository/i.test(err) || String(res.stdout).trim() === 'false') {
    return workspaceHasGitDir(workspace) ? 'unknown' : 'outside';
  }
  return 'unknown';
}

export function gitLsFiles(workspace, rel) {
  const state = gitWorktreeState(workspace);
  if (state === 'unknown') return { ok: false, files: [] };
  if (state === 'outside') return { ok: true, files: [] };
  const res = gitSpawn(workspace, ['ls-files', '-z', '--', rel]);
  if (res.error || res.status !== 0) return { ok: false, files: [] };
  const files = String(res.stdout || '')
    .split('\0')
    .map((entry) => String(entry).replace(/\\/g, '/'))
    .filter(Boolean);
  return { ok: true, files };
}

export function gitHasTrackedFiles(workspace, rel) {
  const listed = gitLsFiles(workspace, rel);
  return listed.ok && listed.files.length > 0;
}

/** New plans live outside the repo so a reset or another commit cannot drop them. */
export const EXTERNAL_PLANS_REL = 'plans';

export function plansWriteTarget(workspace, { home } = {}) {
  return {
    base: projectStoreDir(workspace, { home }),
    dirRel: EXTERNAL_PLANS_REL,
    kind: 'user',
  };
}

export function externalPlansDir(workspace, { home } = {}) {
  const target = plansWriteTarget(workspace, { home });
  return path.join(target.base, target.dirRel);
}

/** @deprecated Writers use plansWriteTarget. Kept so older callers still name the in-repo session folder. */
export function plansWriteRel() {
  return EXTERNAL_PLANS_REL;
}

export function plansReadRels(workspace) {
  const rels = [];
  if (dirExists(workspace, WORKSPACE_PLANS_REL)) rels.push(WORKSPACE_PLANS_REL);
  if (dirExists(workspace, SESSION_PLANS_REL)) rels.push(SESSION_PLANS_REL);
  return rels;
}

/** Absolute plan directories. Includes the external project store when it exists. */
export function planReadDirs(workspace, { home } = {}) {
  const dirs = [];
  for (const rel of plansReadRels(workspace)) {
    const full = path.join(workspace, rel);
    try {
      if (!fs.lstatSync(full).isSymbolicLink()) dirs.push({ dir: full, label: rel });
    } catch {
      // disappeared between the existence check and the stat
    }
  }
  const external = externalPlansDir(workspace, { home });
  try {
    const st = fs.lstatSync(external);
    if (st.isDirectory() && !st.isSymbolicLink()) dirs.push({ dir: external, label: external });
  } catch {
    // no external plans yet
  }
  return dirs;
}

export function isPlanRel(rel) {
  const normalized = String(rel || '').replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) return true;
  return (
    normalized.startsWith(`${WORKSPACE_PLANS_REL}/`) ||
    normalized.startsWith(`${SESSION_PLANS_REL}/`) ||
    normalized.startsWith(`${EXTERNAL_PLANS_REL}/`)
  );
}

export function planBasename(rel) {
  return path.posix.basename(String(rel || '').replace(/\\/g, '/'));
}

export function isCanonicalPlanName(name) {
  return PLAN_FILE.test(String(name || ''));
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolve a --plan argument. Legacy docs/plans and .harness/plans stay readable.
 * A basename with no legacy file resolves to the external project store.
 */
export function normalizePlanRel(workspace, planPath, { home } = {}) {
  if (!planPath || typeof planPath !== 'string') return null;
  const external = externalPlansDir(workspace, { home });
  let absoluteFull = null;
  if (path.isAbsolute(planPath)) {
    const resolved = path.resolve(planPath);
    try {
      const full = canonicalPath(resolved);
      absoluteFull = full;
      const root = fs.existsSync(external) ? canonicalPath(external) : path.resolve(external);
      if (contained(root, full) && /\.(?:md|hplan)$/.test(full)) return full;
    } catch {
      if (contained(path.resolve(external), resolved) && /\.(?:md|hplan)$/.test(resolved)) return resolved;
    }
  }
  const root = fs.existsSync(workspace) ? canonicalPath(workspace) : path.resolve(workspace);
  const full = absoluteFull || path.resolve(root, planPath);
  const rel = path.relative(root, full).replace(/\\/g, '/');
  if (!rel.startsWith('..') && !path.isAbsolute(rel) && /\.(?:md|hplan)$/.test(rel) && isPlanRel(rel) && !rel.startsWith(`${EXTERNAL_PLANS_REL}/`)) {
    if (absoluteFull) {
      const raw = path.resolve(planPath);
      const rawWorkspace = rel.split('/').reduce(parent => path.dirname(parent), raw);
      try {
        if (canonicalPath(rawWorkspace) !== root || !assertNoSymlinkAncestors(rawWorkspace, path.relative(rawWorkspace, raw))) return null;
      } catch { return null; }
    }
    if (fileExists(workspace, rel)) return rel;
  }
  if (path.isAbsolute(planPath)) return null;
  const base = path.posix.basename((/\.(?:md|hplan)$/.test(rel) ? rel : `${path.posix.basename(planPath)}.md`).replace(/\\/g, '/'));
  if (!/\.(?:md|hplan)$/.test(base)) return null;
  for (const dirRel of plansReadRels(workspace)) {
    const candidate = `${dirRel}/${base}`;
    if (fileExists(workspace, candidate)) return candidate;
  }
  const outside = path.join(external, base);
  if (fs.existsSync(outside)) return outside;
  return outside;
}

export function listPlanRels(workspace, { home } = {}) {
  const seen = new Set();
  const out = [];
  const take = (dir, nameFor) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(?:md|hplan)$/.test(f) || f.startsWith('_') || f === 'README.md') continue;
      if (f.endsWith('.md') && planConversionPublished(workspace, path.join(dir, f), { home })) continue;
      if (seen.has(f)) continue;
      seen.add(f);
      out.push(nameFor(f));
    }
  };
  for (const dirRel of plansReadRels(workspace)) {
    take(path.join(workspace, dirRel), (f) => `${dirRel}/${f}`);
  }
  take(externalPlansDir(workspace, { home }), (f) => path.join(externalPlansDir(workspace, { home }), f));
  return out;
}

export function agentContextRel(workspace, { home } = {}) {
  if (fileExists(workspace, WORKSPACE_AGENT_CTX_REL)) return WORKSPACE_AGENT_CTX_REL;
  if (fileExists(workspace, SESSION_AGENT_CTX_REL)) return SESSION_AGENT_CTX_REL;
  const external = path.join(projectStoreDir(workspace, { home }), 'agent-context.md');
  if (fs.existsSync(external)) return external;
  return external;
}

export function codebaseMapWriteRel(workspace) {
  if (fileExists(workspace, WORKSPACE_MAP_REL)) return WORKSPACE_MAP_REL;
  const listed = gitLsFiles(workspace, WORKSPACE_PLANS_REL);
  if (!listed.ok && dirExists(workspace, WORKSPACE_PLANS_REL)) return WORKSPACE_MAP_REL;
  if (listed.ok && listed.files.length > 0) return WORKSPACE_MAP_REL;
  return SESSION_MAP_REL;
}

/** New episodes always go to the external project store. Tracked docs/solutions stay readable. */
export function solutionsWriteTarget(workspace, { home } = {}) {
  return {
    base: projectStoreDir(workspace, { home }),
    dirRel: WORKSPACE_SOLUTIONS_REL,
    kind: 'user',
  };
}

export function solutionsScanRoots(workspace, { home } = {}) {
  const roots = [];
  const ws = path.join(workspace, WORKSPACE_SOLUTIONS_REL);
  if (fs.existsSync(ws)) roots.push({ dir: ws, base: path.resolve(workspace), kind: 'workspace' });
  const overlay = projectStoreDir(workspace, { home });
  const user = path.join(overlay, WORKSPACE_SOLUTIONS_REL);
  if (fs.existsSync(user)) roots.push({ dir: user, base: overlay, kind: 'user' });
  return roots;
}

/**
 * Roots that may contain an episode relative path such as
 * `docs/solutions/<category>/<file>.md` or a global `solutions/...` path.
 * Workspace first, then copilotHome/knowledge, then the user project store.
 */
export function episodeResolveRoots(workspace, { home, copilotHome } = {}) {
  const roots = [path.resolve(workspace)];
  if (copilotHome) {
    const globalRoot = path.resolve(copilotHome, 'knowledge');
    if (!roots.includes(globalRoot)) roots.push(globalRoot);
  }
  const overlay = path.resolve(projectStoreDir(workspace, { home }));
  if (!roots.includes(overlay)) roots.push(overlay);
  return roots;
}

export function episodeAbsPath(workspace, rel, { home } = {}) {
  return path.join(solutionsWriteTarget(workspace, { home }).base, rel);
}

export function artifactSearchRoots(workspace, { home, copilotHome } = {}) {
  const roots = [];
  if (copilotHome) roots.push(path.join(copilotHome, 'knowledge'));
  roots.push(path.resolve(workspace));
  roots.push(path.join(workspace, 'knowledge'));
  roots.push(projectStoreDir(workspace, { home }));
  return [...new Set(roots)];
}
