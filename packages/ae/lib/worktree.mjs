import { spawnGitSync } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readGitArgs } from '../corpus/hooks/lib/product-diff.mjs';
import { EXIT } from './style.mjs';
import { deriveGitContext, resolveDefaultBranch } from './git-context.mjs';
import { readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { ensureLocalGitExclude } from './git-local-exclude.mjs';
import { externalPlansDir, SESSION_PLANS_REL, WORKSPACE_PLANS_REL } from './project-layout.mjs';
import { linkedPrimaryCheckout } from './knowledge/store.mjs';
import { withPlanUpdateLock } from './plan-update.mjs';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CI_TRUE = new Set(['1', 'true', 'TRUE', 'yes', 'YES']);

function gitOut(cwd, args) {
  try {
    const res = spawnGitSync(args, { cwd, encoding: 'utf8', timeout: 15_000 });
    return res.status === 0 ? String(res.stdout || '').trim() : null;
  } catch {
    return null;
  }
}

function usage(message) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint: 'ae help worktree' });
}

function isLinkedWorktree(workspace) {
  return linkedPrimaryCheckout(workspace) != null;
}

function primaryRoot(workspace) {
  return linkedPrimaryCheckout(workspace) || workspace;
}

function currentBranch(workspace) {
  return gitOut(workspace, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
}

function originDefaultName(workspace) {
  const originHead = gitOut(workspace, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (!originHead || !originHead.startsWith('refs/remotes/origin/')) return null;
  return originHead.slice('refs/remotes/origin/'.length);
}

function ensureWorktreeIgnore(root) {
  const local = ensureLocalGitExclude(root, ['/.worktrees/']);
  if (!local?.git) throw usage('worktree: Git-local exclude metadata is unsafe or unavailable; inspect info/exclude before retrying');
}

function carryCheckoutPlans(primary, dest) {
  const storeRoot = path.dirname(externalPlansDir(primary));
  for (const rel of [WORKSPACE_PLANS_REL, SESSION_PLANS_REL]) {
    const dir = path.join(primary, rel);
    let names = [];
    try {
      const dirStat = fs.lstatSync(dir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.md') || name.startsWith('_') || name === 'README.md') continue;
      const src = path.join(dir, name);
      let srcStat = null;
      try {
        srcStat = fs.lstatSync(src);
      } catch {
        continue;
      }
      if (!srcStat.isFile()) continue;
      const destFile = path.join(dest, rel, name);
      try {
        if (fs.lstatSync(destFile).isFile()) continue;
      } catch {
        // The new checkout does not have this plan.
      }
      const target = path.join(storeRoot, 'plans', name);
      const text = readFileNoFollow(src, { root: primary });
      if (text == null) continue;
      let storeStat = null;
      try {
        storeStat = fs.lstatSync(target);
      } catch {
        storeStat = null;
      }
      if (!storeStat) {
        writeFileContained(storeRoot, path.join('plans', name), text);
        continue;
      }
      if (!storeStat.isFile()) continue;
      try {
        withPlanUpdateLock(target, () => {
          let held = null;
          try {
            held = fs.lstatSync(target);
          } catch {
            held = null;
          }
          if (!held?.isFile()) return;
          const existing = readFileNoFollow(target, { root: storeRoot });
          if (existing == null || existing === text || !(srcStat.mtimeMs > held.mtimeMs)) return;
          writeFileContained(storeRoot, path.join('plans', name), text);
        });
      } catch (error) {
        if (error?.code !== 'E_USAGE') throw error;
      }
    }
  }
}

function resolveStartPoint(workspace, from) {
  if (from) return from;
  const def = resolveDefaultBranch(workspace);
  if (def?.name) {
    if (gitOut(workspace, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${def.name}^{commit}`])) {
      return `origin/${def.name}`;
    }
    if (gitOut(workspace, ['rev-parse', '--verify', '--quiet', `refs/heads/${def.name}^{commit}`])) {
      return def.name;
    }
  }
  return 'HEAD';
}

export function planSlugFromPath(planPath) {
  const base = path.posix.basename(String(planPath || '').replace(/\\/g, '/'));
  const match = base.match(/^\d{4}-\d{2}-\d{2}-(?:feat|fix|docs|refactor|chore)-(.+)-plan\.md$/);
  return match ? match[1] : 'issue';
}

export function isolatedWorktreeDestination(workspace, slug) {
  return path.join(primaryRoot(workspace), '.worktrees', slug);
}

function physicalPath(value) {
  // A Windows drive-less rooted path still depends on the caller's current drive.
  if (!path.isAbsolute(value) || process.platform === 'win32' && path.parse(value).root.length === 1) return null;
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
}

function gitCommonDir(workspace) {
  const raw = gitOut(workspace, ['rev-parse', '--git-common-dir']);
  return raw ? physicalPath(path.resolve(workspace, raw)) : null;
}

function worktreeRecordFile(workspace) {
  const common = gitCommonDir(workspace);
  return common ? path.join(common, 'ae-worktrees') : null;
}

export function recordAeWorktree(primary, dest) {
  const file = worktreeRecordFile(primary);
  const real = physicalPath(path.resolve(dest));
  if (!file || !real) return;
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  if (!current.some(entry => physicalPath(entry) === real)) fs.appendFileSync(file, `${real}\n`);
}

/** Primary checkout when this path is a linked worktree recorded by `ae worktree`. */
export function aeWorktreePrimary(workspace) {
  const primary = linkedPrimaryCheckout(workspace);
  if (!primary) return null;
  const file = worktreeRecordFile(workspace);
  if (!file || !fs.existsSync(file)) return null;
  const real = physicalPath(path.resolve(workspace));
  if (!real) return null;
  const listed = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (!listed.some(entry => physicalPath(entry) === real)) return null;
  const primaryCommon = gitCommonDir(primary);
  const here = gitCommonDir(workspace);
  if (!primaryCommon || primaryCommon !== here) return null;
  return primary;
}

export function inspectIsolation({ workspace, home, env = process.env, allowInplace = false } = {}) {
  const ctx = deriveGitContext({ workspace, home });
  if (!ctx.worktree) {
    return {
      blocked: false,
      linked: false,
      onDefault: false,
      isolated: false,
      branch: null,
      defaultBranch: null,
      skipReason: 'not-git',
    };
  }
  const linked = isLinkedWorktree(workspace);
  // A knowledge-store defaultBranch is not origin/HEAD. No remote means the checkout stays editable.
  const originDefault = originDefaultName(workspace);
  const onDefault = Boolean(originDefault && ctx.branch && ctx.branch === originDefault);
  const ci = CI_TRUE.has(String(env.CI || ''));
  const inplace = allowInplace || env.HARNESS_ALLOW_INPLACE === '1';
  let skipReason = null;
  if (ci) skipReason = 'ci';
  else if (inplace) skipReason = 'allow-inplace';
  else if (!originDefault) skipReason = 'no-default-branch';
  else if (!onDefault) skipReason = 'feature-branch';
  else if (linked) skipReason = 'linked-worktree';
  const blocked = skipReason === null;
  return {
    blocked,
    linked,
    onDefault,
    isolated: linked && !onDefault,
    branch: ctx.branch,
    defaultBranch: originDefault,
    skipReason: blocked ? null : skipReason,
  };
}

export function addIsolatedWorktree({ workspace, slug, from, dryRun = false, record = true } = {}) {
  if (!slug || !SLUG_RE.test(slug)) {
    throw usage('worktree: --slug is required and must be lowercase-hyphen (a-z0-9-)');
  }
  const ctx = deriveGitContext({ workspace });
  if (!ctx.worktree) throw usage('worktree: workspace is not a git checkout');
  const root = primaryRoot(workspace);
  const dest = path.join(root, '.worktrees', slug);
  const branch = `harness/${slug}`;
  let start = resolveStartPoint(workspace, from);
  if (from !== undefined) {
    if (typeof from !== 'string' || !from || from.startsWith('-') || /[\0\r\n]/.test(from)) throw usage('worktree: --from requires a commit or revision');
    start = gitOut(workspace, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${from}^{commit}`]);
    if (!start) throw usage(`worktree: --from ${from} could not be resolved to a commit`);
  }
  const requireStart = (head, existing) => {
    if (from !== undefined && (!head || gitOut(root, ['merge-base', '--is-ancestor', start, head]) === null)) {
      throw usage(`worktree: ${existing} does not contain requested --from ${from} (${start}), or its ancestry could not be verified; choose a fresh --slug for this start point`);
    }
  };
  let reuse = false;
  if (fs.existsSync(dest)) {
    const destReal = physicalPath(path.resolve(dest));
    const listed = gitOut(root, ['worktree', 'list', '--porcelain']) || '';
    const listedHit = destReal && listed.split('\n').some((line) => {
      if (!line.startsWith('worktree ')) return false;
      const entry = line.slice('worktree '.length);
      return physicalPath(entry) === destReal;
    });
    const primaryCommon = gitCommonDir(root);
    if (destReal && primaryCommon && (listedHit || isLinkedWorktree(dest)) && gitCommonDir(dest) === primaryCommon) {
      requireStart(gitOut(dest, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']), dest);
      reuse = true;
    } else throw usage(`worktree: ${dest} exists and is not a worktree of this repository`);
  }
  const branchHead = reuse ? null : gitOut(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  if (branchHead) requireStart(branchHead, branch);
  if (dryRun) {
    return { path: dest, branch, created: false, isolated: true, dryRun: true };
  }
  const prefix = readGitArgs(root);
  if (!prefix) throw usage('worktree: Git helper configuration could not be resolved safely');
  ensureWorktreeIgnore(root);
  if (reuse) {
    carryCheckoutPlans(root, dest);
    if (record) recordAeWorktree(root, dest);
    return { path: dest, branch: currentBranch(dest) || branch, created: false, isolated: true };
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const args = branchHead
    ? ['worktree', 'add', '--no-checkout', dest, branch]
    : ['worktree', 'add', '--no-checkout', '-b', branch, dest, start];
  const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-worktree-hooks-'));
  const safeArgs = ['--no-pager', ...prefix, '-c', `core.hooksPath=${hooksDir}`];
  let added = false;
  try {
    const res = spawnGitSync([...safeArgs, ...args], { cwd: root, encoding: 'utf8', timeout: 15_000 });
    if (res.status !== 0) {
      throw Object.assign(new Error(`worktree: git worktree add failed: ${(res.stderr || res.stdout || '').trim()}`), { exit: 1 });
    }
    added = true;
    // Branch-conditional includes become active only after the target HEAD exists.
    const checkoutPrefix = readGitArgs(dest);
    if (!checkoutPrefix) throw usage('worktree: target Git helper configuration could not be resolved safely');
    const checkout = spawnGitSync(['--no-pager', ...checkoutPrefix, '-c', `core.hooksPath=${hooksDir}`, 'reset', '--hard', 'HEAD'], {
      cwd: dest, encoding: 'utf8', timeout: 15_000,
    });
    if (checkout.status !== 0) {
      throw Object.assign(new Error(`worktree: git checkout failed: ${(checkout.stderr || checkout.stdout || '').trim()}`), { exit: 1 });
    }
  } catch (error) {
    if (added) {
      const cleanup = spawnGitSync([...safeArgs, 'worktree', 'remove', '--force', dest], { cwd: root, encoding: 'utf8', timeout: 15_000 });
      if (cleanup.status !== 0) error.message += `; cleanup failed: ${(cleanup.stderr || cleanup.stdout || '').trim()}`;
    }
    throw error;
  } finally {
    fs.rmSync(hooksDir, { recursive: true, force: true });
  }
  carryCheckoutPlans(root, dest);
  if (record) recordAeWorktree(root, dest);
  return { path: dest, branch, created: true, isolated: true };
}

export function worktreeGateMessage(isolation) {
  if (isolation.blocked) {
    return 'Do not edit the current branch in place. Run `ae worktree --slug <issue-slug>` and continue with --workspace <path>. Pass --allow-inplace to override.';
  }
  if (isolation.isolated) return 'issue worktree isolated';
  if (isolation.skipReason === 'ci') return 'worktree isolation skipped (CI)';
  if (isolation.skipReason === 'allow-inplace') return 'worktree isolation skipped (--allow-inplace)';
  if (isolation.skipReason === 'feature-branch') return 'worktree isolation skipped (non-default branch)';
  if (isolation.skipReason === 'linked-worktree') return 'worktree isolation skipped (linked worktree)';
  if (isolation.skipReason === 'no-default-branch') return 'worktree isolation skipped (no default branch)';
  return 'worktree isolation skipped';
}
