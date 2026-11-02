import { gitExecutable } from '../../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deriveGitContext, resolveDefaultBranch, isDetachedKey } from '../git-context.mjs';
import { branchesRoot, bucketDirFor, listBuckets, bucketAncestryOk, isSafeBucketKey } from './overlay.mjs';
import { readSession } from '../session.mjs';
import { assertRealpathContained, assertNoSymlinkAncestors } from '../fs-safe.mjs';
import { writeStoreFile, storeFileState } from './store-io.mjs';

export function resolveWriteLayer({ workspace, home, layerOverride = null, log = () => {} } = {}) {
  const context = deriveGitContext({ workspace, home });
  const defaultBranch = resolveDefaultBranch(workspace, { home });

  // Orient-recorded branch is advisory: warn when write-time HEAD disagrees.
  let branchWarning = null;
  try {
    const session = readSession(workspace);
    const oriented = session?.gitBranch || null;
    const current = context.branch || (context.detached ? '(detached)' : null);
    if (oriented && current && oriented !== current) {
      branchWarning = `oriented on branch ${oriented} but writing from ${current} — layer routed from the write-time HEAD`;
      log(branchWarning);
    }
  } catch {
    branchWarning = null;
  }

  if (layerOverride === 'golden') {
    log('layer override: --layer golden (explicit) — writing to the golden layer');
    return { layer: 'golden', bucketKey: null, context, defaultBranch, override: true, branchWarning };
  }

  if (context.detached) {
    return { layer: 'branch', bucketKey: context.branchKey, context, defaultBranch, detached: true, branchWarning };
  }
  if (!context.branch) {
        return { layer: 'golden', bucketKey: null, context, defaultBranch, branchWarning };
  }
  if (defaultBranch && context.branch === defaultBranch.name) {
    return { layer: 'golden', bucketKey: null, context, defaultBranch, branchWarning };
  }
    return {
    layer: 'branch',
    bucketKey: context.branchKey,
    context,
    defaultBranch,
    failedClosed: !defaultBranch,
    branchWarning,
  };
}

export function ensureBucket(dir, { key, branch = null, baseSha = null }) {
  const bucketDir = bucketDirFor(dir, key);
  fs.mkdirSync(path.join(bucketDir, 'learnings'), { recursive: true });
    const seed = (file, content) => {
    const state = storeFileState(file);
    if (state !== 'absent' && state !== 'symlink') return;
    if (!writeStoreFile(file, content)) {
      throw new Error(`refused to create ${file} — the path does not resolve safely inside the knowledge store`);
    }
  };
  const ledgerPath = path.join(bucketDir, 'consolidated.jsonl');
  seed(ledgerPath, '');
  const indexPath = path.join(bucketDir, 'INDEX.md');
  seed(indexPath, '# Learnings Index (branch bucket)\n\n_Rebuilt by `ae consolidate --apply`._\n');
  const metaPath = path.join(bucketDir, 'meta.json');
  if (storeFileState(metaPath) !== 'file') {
    const meta = {
      branch,
      branchKey: key,
      baseSha,
      createdAt: new Date().toISOString(),
      promotable: !isDetachedKey(key),
    };
    seed(metaPath, JSON.stringify(meta) + '\n');
  }
  return bucketDir;
}

/** Every ref name (`refs/heads/...`, `refs/remotes/...`) in the workspace. */
function listRefs(workspace) {
  try {
    const res = spawnSync(gitExecutable(), ['show-ref'], { cwd: workspace, encoding: 'utf8', timeout: 10_000 });
    if (res.status !== 0) return null;
    return res.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' ')[1])
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** True when `branch` exists locally or on any remote; null when git state is
 * unreadable (callers treat null as "cannot verify", never as missing). */
export function branchExists(workspace, branch) {
  if (!branch) return null;
  const refs = listRefs(workspace);
  if (refs === null) return null;
  return refs.some((r) => {
    if (r === `refs/heads/${branch}`) return true;
        if (!r.startsWith('refs/remotes/')) return false;
    const rest = r.slice('refs/remotes/'.length);
    const slash = rest.indexOf('/');
    return slash !== -1 && rest.slice(slash + 1) === branch;
  });
}

export function migrateRenamedBucket(dir, { workspace, context }) {
  if (!context?.branchKey || !context.branch) return null;
  if (fs.existsSync(bucketDirFor(dir, context.branchKey))) return null;
  const candidates = [];
  for (const bucket of listBuckets(dir)) {
    if (isDetachedKey(bucket.key)) continue;
    const branch = bucket.meta?.branch;
    if (!branch || branch === context.branch) continue;
    if (branchExists(workspace, branch) !== false) continue; // exists or unverifiable — not a rename candidate
    if (bucketAncestryOk(workspace, bucket.meta) !== true) continue; // unrelated or unverifiable history
    candidates.push(bucket);
  }
  if (candidates.length !== 1) return null;
  const [source] = candidates;
    if (!isSafeBucketKey(source.key) || !isSafeBucketKey(context.branchKey)) return null;
  const containedSource = assertRealpathContained(dir, path.join('branches', source.key));
  if (!containedSource) return null;
  const target = assertNoSymlinkAncestors(dir, path.join('branches', context.branchKey));
  if (!target) return null;
  try {
        const meta = source.meta || {};
        if (!writeStoreFile(path.join(source.dir, 'meta.json'), JSON.stringify({ ...meta, branch: context.branch, branchKey: context.branchKey }) + '\n')) {
      return null;
    }
    fs.renameSync(containedSource, target);
    return { migrated: true, from: source.key, to: context.branchKey };
  } catch {
    return null;
  }
}

export function episodeEligibleForLayer(episodeBranch, { layer, currentBranch, defaultBranchName, storeHasBuckets }) {
  if (!storeHasBuckets) return true;
  if (layer === 'golden') {
    return Boolean(episodeBranch) && Boolean(defaultBranchName) && episodeBranch === defaultBranchName;
  }
  return !episodeBranch || episodeBranch === currentBranch;
}

export function storeHasBuckets(dir) {
  try {
    return fs.existsSync(branchesRoot(dir)) && listBuckets(dir).length > 0;
  } catch {
    return false;
  }
}
