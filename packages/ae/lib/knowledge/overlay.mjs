import { spawnGitSync } from '../../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { storeDir, listLearnings, readGovernance, inertLine } from './store.mjs';
import { deriveGitContext } from '../git-context.mjs';
import { redactSecrets } from '../secret-scan.mjs';
import { readStoreFile } from './store-io.mjs';

const GOVERNED_EXCLUSION_ACTIONS = new Set(['retire', 'dispute', 'promote']);
const PROTECTED_FIX_THRESHOLD = 3;
const SHA_RE = /^[0-9a-f]{40}$/;

/** The write path's protected-target predicate (apply.mjs's
 * isDisputedTargetFm), re-stated for the read path: too well-evidenced or
 * human-taught to be displaced without a human. */
export function isProtectedFm(fm) {
  const fixes = (fm.episodes || []).filter((e) => e.kind === 'fix').length;
  return fixes >= PROTECTED_FIX_THRESHOLD || fm.source === 'human';
}

export function branchesRoot(dir) {
  return path.join(dir, 'branches');
}

export function isSafeBucketKey(key) {
  if (typeof key !== 'string' || !key) return false;
  if (key === '.' || key === '..') return false;
  if (/[\\/:]/.test(key)) return false;
  if (key.includes('..')) return false;
  if (/[\x00-\x1f\x7f]/.test(key)) return false;
  return !path.isAbsolute(key);
}

export function bucketDirFor(dir, key) {
  return path.join(branchesRoot(dir), key);
}

export const BRANCH_DISPLAY_CAP = 80;
export function safeBranchName(value) {
  if (typeof value !== 'string' || !value) return null;
  return inertLine(redactSecrets(value)).slice(0, BRANCH_DISPLAY_CAP);
}

/** Parsed bucket meta.json, or null. Meta is a CACHE, never authority —
 * promotability and detachment are re-derived from the key shape at decision
 * time; meta only carries display/ancestry hints. */
export function readBucketMeta(bucketDir) {
  try {
    const parsed = JSON.parse(readStoreFile(path.join(bucketDir, 'meta.json')));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Every bucket under `branches/`, sorted by key: `[{ key, dir, meta }]`. */
export function listBuckets(dir) {
  const root = branchesRoot(dir);
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const bucketDir = path.join(root, e.name);
    out.push({ key: e.name, dir: bucketDir, meta: readBucketMeta(bucketDir) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export function isBucketBaseSha(value) {
  return typeof value === 'string' && SHA_RE.test(value);
}

export function bucketAncestryOk(workspace, meta) {
  if (!meta || !isBucketBaseSha(meta.baseSha)) return null;
  try {
    const res = spawnGitSync(['merge-base', '--is-ancestor', meta.baseSha, 'HEAD'], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (res.error) return null;
    if (typeof res.status !== 'number') return null;
    return res.status === 0;
  } catch {
    return null;
  }
}

export function loadLayeredLearnings({ workspace, home } = {}) {
  let dir;
  try {
    dir = storeDir(workspace, { home });
  } catch {
    return { learnings: [], layered: false, context: null };
  }
  if (!fs.existsSync(dir)) return { learnings: [], layered: false, context: null };
  const golden = listLearnings(dir);

    if (!fs.existsSync(branchesRoot(dir))) return { learnings: golden, layered: false, context: null };

  let context = null;
  try {
    context = deriveGitContext({ workspace, home });
  } catch {
    context = null;
  }
    if (!context?.branchKey || !isSafeBucketKey(context.branchKey)) {
    return { learnings: golden, layered: false, context };
  }

  const bucketDir = bucketDirFor(dir, context.branchKey);
  if (!fs.existsSync(path.join(bucketDir, 'learnings'))) {
    return { learnings: golden, layered: false, context };
  }

    const meta = readBucketMeta(bucketDir);
  if (bucketAncestryOk(workspace, meta) === false) {
    return { learnings: golden, layered: false, context, excludedBucket: { key: context.branchKey, reason: 'ancestry' } };
  }

  let bucketLearnings;
  try {
    bucketLearnings = listLearnings(bucketDir);
  } catch {
    return { learnings: golden, layered: false, context };
  }
  if (!bucketLearnings.length) return { learnings: golden, layered: false, context };

  const governance = readGovernance(dir);
  const goldenById = new Map(golden.map((l) => [l.id, l]));
  const merged = new Map(goldenById);

  for (const b of bucketLearnings) {
    if (
      b.fm.superseded_by ||
      b.fm.promoted_to ||
      b.fm.promoted_to_golden ||
      ['retired', 'disputed'].includes(b.fm.status)
    ) {
      continue;
    }
    const decision = governance.get(b.id);
    if (decision && GOVERNED_EXCLUSION_ACTIONS.has(decision.action)) continue;

    const goldenTwin = goldenById.get(b.id);
    if (goldenTwin && isProtectedFm(goldenTwin.fm)) {
      merged.set(`${b.id}#branch`, { ...b, layer: 'branch', subordinate: true });
      continue;
    }
    // Shadow (or plain addition): the branch-local claim IS the candidate.
    merged.set(b.id, { ...b, layer: 'branch' });
  }

  const learnings = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id) || (a.subordinate ? 1 : 0) - (b.subordinate ? 1 : 0));
  return { learnings, layered: true, context };
}

export function layerTieRank(entry) {
  if (entry?.subordinate) return 2;
  return entry?.layer === 'branch' ? 0 : 1;
}
