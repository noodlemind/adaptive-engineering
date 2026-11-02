import { spawnGitSync } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { storeDir } from './knowledge/store.mjs';
import { gitMetadataEnvironment } from '../corpus/hooks/lib/product-diff.mjs';

const BRANCH_SLUG_CAP = 64;
const DETACHED_SHORT_SHA_LEN = 12;

function gitOut(cwd, args) {
  try {
    const res = spawnGitSync(args, { cwd, encoding: 'utf8', timeout: 10_000, env: gitMetadataEnvironment() });
    return res.status === 0 ? res.stdout.trim() : null;
  } catch {
    return null;
  }
}

export function branchSlug(branch) {
  return (
    String(branch)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, BRANCH_SLUG_CAP) || 'branch'
  );
}

export function branchKeyFor(branch) {
  const hash = crypto.createHash('sha256').update(String(branch)).digest('hex').slice(0, 8);
  return `${branchSlug(branch)}-${hash}`;
}

/** The non-promotable bucket key for a detached HEAD at `headSha`. */
export function detachedKeyFor(headSha) {
  return `detached-${String(headSha).slice(0, DETACHED_SHORT_SHA_LEN)}`;
}

/** True for the `detached-<12hex>` key shape — never promotable, derived from
 * the key at decision time (bucket meta.json is a cache, never authority). */
export function isDetachedKey(key) {
  return /^detached-[0-9a-f]{12}$/.test(String(key || ''));
}

export function resolveDefaultBranch(workspace, { home } = {}) {
  try {
    const dir = storeDir(workspace, { home });
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    if (parsed && typeof parsed.defaultBranch === 'string' && parsed.defaultBranch.trim()) {
      return { name: parsed.defaultBranch.trim(), source: 'config' };
    }
  } catch {
    // absent/corrupt config — fall through to origin/HEAD
  }
  const originHead = gitOut(workspace, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (originHead && originHead.startsWith('refs/remotes/origin/')) {
    return { name: originHead.slice('refs/remotes/origin/'.length), source: 'origin-head' };
  }
  return null;
}

function mergeBaseWithDefault(workspace, defaultBranch) {
  if (!defaultBranch) return null;
  for (const ref of [`refs/remotes/origin/${defaultBranch.name}`, `refs/heads/${defaultBranch.name}`]) {
    if (gitOut(workspace, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) === null) continue;
    const base = gitOut(workspace, ['merge-base', 'HEAD', ref]);
    if (base) return base;
  }
  return null;
}

export function deriveGitContext({ workspace, home } = {}) {
  const empty = { branch: null, branchKey: null, worktree: null, detached: false, headSha: null, baseSha: null };
  if (!workspace) return empty;
  const worktree = gitOut(workspace, ['rev-parse', '--show-toplevel']);
  if (!worktree) return empty;

  const headSha = gitOut(workspace, ['rev-parse', 'HEAD']);
  const branch = gitOut(workspace, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const detached = !branch && Boolean(headSha);

  let branchKey = null;
  if (branch) branchKey = branchKeyFor(branch);
  else if (detached) branchKey = detachedKeyFor(headSha);

  const baseSha = headSha ? mergeBaseWithDefault(workspace, resolveDefaultBranch(workspace, { home })) : null;

  return { branch: branch || null, branchKey, worktree, detached, headSha: headSha || null, baseSha };
}
