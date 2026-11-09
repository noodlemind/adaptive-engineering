import fs from 'node:fs';
import { storeDir, listLearnings, readStoreConfig } from './store.mjs';
import { isActiveFm, bucketCounts } from './consolidate.mjs';
import { listBuckets, bucketAncestryOk, safeBranchName, isBucketBaseSha } from './overlay.mjs';
import { deriveGitContext, isDetachedKey } from '../git-context.mjs';
import { indexStatus } from '../index-status.mjs';
import { loadLayeredLearnings } from './overlay.mjs';
import { feedbackState, feedbackStatusView } from '../learning-feedback.mjs';

export function knowledgeStatus({ workspace, copilotHome, home } = {}) {
  const dir = storeDir(workspace, { home });
  const storeExists = fs.existsSync(dir);
  const { mode, commit } = readStoreConfig(workspace, { home });

  let context = null;
  try {
    const derived = deriveGitContext({ workspace, home });
    if (derived.branch || derived.detached) {
      context = { branch: safeBranchName(derived.branch), branchKey: derived.branchKey, detached: derived.detached };
    }
  } catch {
    context = null;
  }

  const domainsMap = new Map();
  let goldenActive = 0;
  let goldenTotal = 0;
  if (storeExists) {
    for (const l of listLearnings(dir)) {
      goldenTotal += 1;
      const bucket = domainsMap.get(l.domain) || { domain: l.domain, active: 0, total: 0 };
      bucket.total += 1;
      if (isActiveFm(l.fm)) {
        bucket.active += 1;
        goldenActive += 1;
      }
      domainsMap.set(l.domain, bucket);
    }
  }
  const domains = [...domainsMap.values()].sort((a, b) => a.domain.localeCompare(b.domain));

  const buckets = [];
  if (storeExists) {
    for (const { key, dir: bucketDir, meta } of listBuckets(dir)) {
      let active = 0;
      let total = 0;
      let promoted = 0;
      try {
        ({ active, promoted, total } = bucketCounts(listLearnings(bucketDir)));
      } catch {
        // unreadable bucket — counts stay zero, the row still surfaces
      }
      const createdAt = typeof meta?.createdAt === 'string' ? meta.createdAt : null;
      const ageDays = createdAt && !Number.isNaN(Date.parse(createdAt))
        ? Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 86_400_000))
        : null;
      buckets.push({
        key,
        branch: safeBranchName(meta?.branch),
                baseSha: isBucketBaseSha(meta?.baseSha) ? meta.baseSha : null,
        createdAt,
        ageDays,
        // Derived from the key shape, never trusted from meta (cache only).
        promotable: !isDetachedKey(key),
        active,
        total,
        promoted,
        prunable: total > 0 && active === 0,
        ancestryOk: bucketAncestryOk(workspace, meta),
      });
    }
  }

  let drift = null;
  try {
    const status = indexStatus({ workspace, copilotHome, home });
    drift = {
      indexed: Boolean(status.indexed),
      stale: Boolean(status.stale),
      commitsSince: status.commitsSince ?? null,
      filesChanged: status.filesChanged ?? null,
      recommendation: status.recommendation,
    };
  } catch {
    drift = null;
  }

  const feedback = knowledgeFeedbackStatus({ workspace, home });

  return {
    pass: true,
    exitCode: 0,
    storeExists,
    storeDir: dir,
    mode,
    commit,
    context,
    golden: { active: goldenActive, total: goldenTotal, domains },
    buckets,
    drift,
    ...(feedback ? { feedback } : {}),
  };
}

/**
 * Recall feedback columns for the learnings the current layer delivers.
 * Null under effective `knowledge.feedback=off`, so status stays byte-identical.
 */
export function knowledgeFeedbackStatus({ workspace, home } = {}) {
  try {
    if (feedbackState({ workspace, home }) === 'off') return null;
  } catch {
    return null;
  }
  let learnings = [];
  try {
    learnings = loadLayeredLearnings({ workspace, home }).learnings.filter((l) => isActiveFm(l.fm));
  } catch {
    learnings = [];
  }
  return feedbackStatusView({ workspace, home, learnings });
}
