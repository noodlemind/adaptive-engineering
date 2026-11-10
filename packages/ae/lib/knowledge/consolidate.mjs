import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { storeDir, readLedger, listLearnings, readStoreConfig, readGovernance, inertLine } from './store.mjs';
import { readFileNoFollow, assertNoSymlinkAncestors } from '../fs-safe.mjs';
import { solutionsScanRoots } from '../project-layout.mjs';
import { resolveWriteLayer, episodeEligibleForLayer, storeHasBuckets } from './layer.mjs';
import { bucketDirFor, isSafeBucketKey, listBuckets, loadLayeredLearnings } from './overlay.mjs';
import { feedbackState, feedbackSummary } from '../learning-feedback.mjs';
import { recheckState, recheckSummary, recheckDue, RECHECK_STATUS_PRESELECT } from '../learning-recheck.mjs';

export const CONSOLIDATION_THRESHOLD = 5;
export const MAX_OPS_PER_RUN = 5;
export const LEARNING_BYTE_CAP = 1200;
export const QUARANTINE_THRESHOLD = 3;
export const DOMAIN_ACTIVE_CAP = 25;
const LEARNING_BODY_BUDGET_BYTES = 30_000;
const CANDIDATE_EPISODE_BUDGET_BYTES = 30_000;
const CANDIDATE_TITLE_CAP = 200;
const CANDIDATE_TAGS_TOTAL_CAP = 500;
export const PROMOTION_FIX_THRESHOLD = 3;
export const PROMOTION_PLAN_THRESHOLD = 2;
export const episodeId = e => crypto.createHash('sha256').update(JSON.stringify({ path: e.path, sha256: e.sha256, kind: e.kind })).digest('hex');

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

// Bound the rendered `tags` array to a total character budget so even the
// always-admitted first packet entry can never balloon from a pathological
// frontmatter `tags:` line. Each tag is inertLine-normalized (control chars →
// spaces) as before; admission stops once the running total would exceed the
// cap.
function capTags(tags, totalCap) {
  const out = [];
  let used = 0;
  for (const t of tags || []) {
    const clean = inertLine(t);
    if (used + clean.length > totalCap) break;
    out.push(clean);
    used += clean.length;
  }
  return out;
}

function excerpt(text) {
  const body = text.replace(/^---[\s\S]*?---\n/, '').trim();
  // inertLine (store.mjs) runs AFTER the \s+ collapse: \s only covers
  // whitespace control chars (tab/newline/CR/FF/VT) — a NUL byte or another
  // non-whitespace C0 control char embedded in the body would otherwise
  // survive this collapse verbatim (Important #2, adversarial review).
  return inertLine(body.replace(/\s+/g, ' ').slice(0, 240));
}

/**
 * Collect episodes from the same roots the knowledge index scans. Every
 * candidate path — the scanned root directory itself, each category
 * directory, and each file — is validated with `assertNoSymlinkAncestors`
 * (fs-safe.mjs) against the WORKSPACE or `copilotHome/knowledge` BASE, the
 * exact same base purge already resolves against — never against a
 * realpath of the scanned subdir itself. An earlier version of this
 * function computed containment against `realpathSync(dir)` (the scanned
 * docs/solutions directory) — but when `dir` itself is a symlink, its
 * realpath IS the resolved-through target, so every file underneath passed
 * containment against itself trivially (adversarial review, probe A): a
 * symlinked `docs/solutions` leaked outside content straight into a
 * candidate's excerpt, pre-hashed, with zero attacker foreknowledge needed.
 * Checking from the BASE down (docs -> solutions -> category -> file) is
 * what actually catches a symlink at ANY of those levels. A rejected
 * component (or the whole scan root) is simply skipped — for a symlinked
 * root, skipped BEFORE any directory listing is ever read, so not even a
 * category/filename can leak through it.
 */
export function collectEpisodes({ workspace, copilotHome, home }) {
  const roots = [];
  const globalSol = copilotHome ? path.join(copilotHome, 'knowledge', 'solutions') : null;
  if (globalSol && fs.existsSync(globalSol)) {
    roots.push({ dir: globalSol, base: path.join(copilotHome, 'knowledge') });
  }
  roots.push(...solutionsScanRoots(workspace, { home }));

  const episodes = [];
  for (const { dir, base } of roots) {
    const dirRel = path.relative(base, dir);
    if (!assertNoSymlinkAncestors(base, dirRel)) continue;
    for (const cat of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!cat.isDirectory()) continue;
      const catRel = path.join(dirRel, cat.name);
      if (!assertNoSymlinkAncestors(base, catRel)) continue; // symlinked category directory
      const catPath = path.join(dir, cat.name);
      for (const f of fs.readdirSync(catPath)) {
        if (!f.endsWith('.md') || f === 'README.md') continue;
        const fileRel = path.join(catRel, f);
        const full = assertNoSymlinkAncestors(base, fileRel);
        if (!full) continue; // symlinked leaf (or any ancestor) — never follow
        const text = readFileNoFollow(full, { root: base });
        if (text === null) continue;
        const fm = parseFrontmatter(text);
        episodes.push({
          path: fileRel.split(path.sep).join('/'),
          sha256: crypto.createHash('sha256').update(text).digest('hex'),
          kind: fm.kind === 'insight' ? 'insight' : fm.kind === 'human-teaching' ? 'human-teaching' : 'fix',
          category: cat.name,
          title: fm.title || f.replace(/\.md$/, ''),
          tags: fm.tags ? fm.tags.split(',').map((t) => t.trim()) : [],
          excerpt: excerpt(text),
          date: fm.date || null,
                    branch: fm.branch || null,
        });
      }
    }
  }
  return episodes;
}

export function splitLedger(ledger) {
  const consumed = new Set();
  const quarantined = [];
  for (const e of ledger) {
    if (e.quarantined) {
      quarantined.push(e);
      consumed.add(`${e.path}@${e.sha256}`);
    } else if ('learning' in e) {
      consumed.add(`${e.path}@${e.sha256}`);
    }
  }
  return { consumed, quarantined };
}

export function isActiveFm(fm) {
  return !fm.superseded_by && !fm.promoted_to && !fm.promoted_to_golden && !['retired', 'disputed'].includes(fm.status);
}

export function activeLearnings(learnings) {
  return learnings.filter((l) => isActiveFm(l.fm));
}

export function bucketCounts(learnings) {
  let active = 0;
  let promoted = 0;
  for (const l of learnings) {
    if (l.fm.promoted_to_golden) promoted += 1;
    else if (isActiveFm(l.fm)) active += 1;
  }
  return { active, promoted, total: learnings.length };
}

function domainPressure(learnings) {
  const counts = new Map();
  for (const l of activeLearnings(learnings)) {
    counts.set(l.domain, (counts.get(l.domain) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([domain, active]) => ({ domain, active, cap: DOMAIN_ACTIVE_CAP, atCap: active >= DOMAIN_ACTIVE_CAP }));
}

export function verifiedAndPlans(fm) {
  const fixes = (fm.episodes || []).filter((e) => e.kind === 'fix');
  const plans = new Set(fixes.map((e) => e.plan).filter(Boolean));
  return { verified: fixes.length, plans: plans.size };
}

export function isPromotionEligible(verified, plans) {
  return verified >= PROMOTION_FIX_THRESHOLD && plans >= PROMOTION_PLAN_THRESHOLD;
}

/** Computed, never stored: ≥3 fix links across ≥2 distinct plans. */
export function promotionCandidates(learnings) {
  const out = [];
  for (const l of activeLearnings(learnings)) {
    const { verified, plans } = verifiedAndPlans(l.fm);
    if (isPromotionEligible(verified, plans)) {
      out.push({ id: l.id, verified, plans });
    }
  }
  return out;
}

function layerView({ workspace, home, dir, writeLayer = false, layerOverride = null }) {
  const hasBuckets = storeHasBuckets(dir);
  let routing = null;
  if (hasBuckets || writeLayer) {
    try {
      routing = resolveWriteLayer({ workspace, home, layerOverride });
    } catch {
      routing = null;
    }
  }
  const layer = routing?.layer === 'branch' && routing.bucketKey ? 'branch' : 'golden';
  const bucketKey = layer === 'branch' ? routing.bucketKey : null;
  const layerRoot = layer === 'branch' ? bucketDirFor(dir, bucketKey) : dir;
  return {
    layer,
    bucketKey,
    layerRoot,
    eligibility: {
      layer,
      currentBranch: routing?.context?.branch || null,
      defaultBranchName: routing?.defaultBranch?.name || null,
      storeHasBuckets: hasBuckets || writeLayer && layer === 'branch',
    },
  };
}

export function consolidateStatus(options) {
  return statusWithRecheck(options).status;
}

/**
 * `withRecheck: false` skips the re-check scan for callers that read neither `due` nor `recheck` (doctor,
 * the growth report, the retrieval tree, resource candidates, the learning listing, archive and init, which
 * read only `quarantined`, `promotionCandidates` or `debt`): the status then names the re-check state without counts, as `suggest` does, and
 * re-check never adds to `due`. Orient and `ae consolidate` keep the default.
 */
function statusWithRecheck({ workspace, copilotHome, home, writeLayer = false, layerOverride = null, withFeedback = false, recheckRequested = false, withRecheck = true }) {
    const dir = storeDir(workspace, { home });
  const { mode } = readStoreConfig(workspace, { home });
  const episodes = collectEpisodes({ workspace, copilotHome, home });
  const view = layerView({ workspace, home, dir, writeLayer, layerOverride });
  const { consumed, quarantined } = splitLedger(readLedger(dir));
  let layerQuarantined = [];
  if (view.layer === 'branch') {
    // The current bucket's ledger consumes (and quarantines) too.
    const bucketSplit = splitLedger(readLedger(view.layerRoot));
    for (const key of bucketSplit.consumed) consumed.add(key);
    layerQuarantined = bucketSplit.quarantined;
  }
  const unconsolidated = episodes
    .filter((e) => episodeEligibleForLayer(e.branch, view.eligibility))
    .filter((e) => !consumed.has(`${e.path}@${e.sha256}`))
    .map(({ path: p, sha256, kind, title }) => ({ path: p, sha256, kind, title }));
    const learnings = listLearnings(view.layerRoot);
  const active = activeLearnings(learnings);
  const debt = unconsolidated.length;
  const feedback = feedbackView({ workspace, home, learnings: active, withFeedback });
  let recheckMode = 'off';
  try { recheckMode = recheckState({ workspace, home }); } catch { recheckMode = 'off'; }
  // Only `on` needs the scan for due; `suggest` pays for it only when a packet asks. A status that
  // shows no packet opens only the newest RECHECK_STATUS_PRESELECT evidence records.
  const recheck = (recheckMode === 'on' && withRecheck) || (recheckMode === 'suggest' && recheckRequested)
    ? recheckView({ workspace, home, state: recheckMode, resolved: answeredClusters(dir), preselect: recheckRequested ? undefined : RECHECK_STATUS_PRESELECT })
    : null;
  const recheckIsDue = recheck?.state === 'on' && recheckDue(recheck);
  const due = ['on', 'suggest'].includes(mode) && (debt >= CONSOLIDATION_THRESHOLD || (feedback?.state === 'on' && feedback.review_required.length > 0) || recheckIsDue);
  const status = {
    mode,
    debt,
    threshold: CONSOLIDATION_THRESHOLD,
    due,
    unconsolidated,
    quarantined: [...quarantined, ...layerQuarantined],
    learnings: { active: active.length, total: learnings.length },
    domains: domainPressure(learnings),
    promotionCandidates: promotionCandidates(learnings),
    ...(feedback ? { feedback } : {}),
    ...(recheckMode !== 'off' ? { recheck: { state: recheckMode, ...(recheck ? { counts: recheck.counts } : {}), ...(recheck?.unavailable ? { unavailable: recheck.unavailable } : {}) } } : {}),
    storeDir: dir,
    layer: view.layer,
    ...(view.bucketKey ? { bucketKey: view.bucketKey } : {}),
    nextTools: due ? [recheckIsDue ? 'ae consolidate --candidates --recheck' : 'ae consolidate --candidates'] : [],
  };
  return { status, recheck };
}

/**
 * Cluster ID -> latest time a learning-writing op consumed an episode that
 * answers it. Apply records `answers` and `answeredAt` on the ledger entry, so
 * the answer survives edits or purges of the episode and is read from the
 * golden ledger and every branch bucket. NOOP and quarantine entries carry no
 * learning and never answer a cluster. Bucket ancestry is not checked: an
 * answer recorded on any branch clears the cluster everywhere, because the
 * cluster is keyed by check name rather than by branch.
 */
const ANSWER_FUTURE_SKEW_MS = 5 * 60 * 1000;

function answeredClusters(dir, now = Date.now()) {
  const answered = new Map();
  const ledgers = [readLedger(dir), ...listBuckets(dir).filter(bucket => isSafeBucketKey(bucket.key)).map(bucket => readLedger(bucket.dir))];
  for (const entry of ledgers.flat()) {
    if (typeof entry?.learning !== 'string' || entry.quarantined || !/^[a-f0-9]{16}$/.test(entry.answers || '') || typeof entry.answeredAt !== 'string') continue;
    // Compared as times, not strings: offsets and precision vary. An unparseable time answers nothing, and
    // neither does one more than five minutes ahead (the same skew limit failure timestamps get), so a
    // future-dated entry cannot hide failures that have not happened yet.
    const at = Date.parse(entry.answeredAt);
    if (!Number.isFinite(at) || at > now + ANSWER_FUTURE_SKEW_MS) continue;
    if (!answered.has(entry.answers) || at > Date.parse(answered.get(entry.answers))) answered.set(entry.answers, entry.answeredAt);
  }
  return answered;
}

/**
 * Feedback evidence for packets and status; absent when the effective state is
 * `off`, so output stays byte-identical. The history is read under `on`, where
 * `due` depends on it, or under `suggest` only for a caller that shows it.
 */
function feedbackView({ workspace, home, learnings, withFeedback }) {
  let state = 'off';
  try { state = feedbackState({ workspace, home }); } catch { state = 'off'; }
  if (state === 'off' || (state === 'suggest' && !withFeedback)) return null;
  try {
    return { state, ...feedbackSummary({ workspace, home, learnings }) };
  } catch (error) {
    return { state, records: 0, learnings: [], review_required: [], reviewers: [], unavailable: inertLine(error.message).slice(0, 200) };
  }
}

/**
 * Re-check evidence (plan Phase 2); absent when the effective state is `off`,
 * so output stays byte-identical. `review_required` is shared with feedback
 * and read here whatever the feedback key says: enabling re-check opts in.
 */
function recheckView({ workspace, home, state, resolved, preselect }) {
  // Golden plus the current branch bucket, whichever layer the caller routes to,
  // so status and packets see the same learnings. A subordinate branch twin of
  // a protected golden learning is not a separate learning.
  let learnings = [], allLearnings = [];
  try {
    const layered = loadLayeredLearnings({ workspace, home });
    learnings = activeLearnings(layered.learnings.filter(l => !l.subordinate));
    const dir = storeDir(workspace, { home });
    const key = layered.context?.branchKey;
    // Reference targets include inactive learnings from both layers.
    // Only a bucket the overlay accepted (not one excluded for ancestry).
    allLearnings = [...listLearnings(dir), ...(layered.layered && key && isSafeBucketKey(key) ? listLearnings(bucketDirFor(dir, key)) : [])];
  } catch { learnings = []; allLearnings = []; }
  let reviewRequired = [];
  try { reviewRequired = feedbackSummary({ workspace, home, learnings }).review_required; } catch { reviewRequired = []; }
  try {
    return { state, ...recheckSummary({ workspace, home, learnings, allLearnings, reviewRequired, resolved, preselect }) };
  } catch (error) {
    // The error text can name paths or record content, so only a fixed sentence and a Node error code are shown.
    const counts = { stale_exposed: 0, review_required: 0, failure_clusters: 0, finding_clusters: 0, broken_references: 0 };
    const code = typeof error?.code === 'string' && /^E[A-Z0-9_]{1,30}$/.test(error.code) ? ` (${error.code})` : '';
    return { state, stale_exposed: [], review_required: [], failure_clusters: [], finding_clusters: [], broken_references: [], counts, omitted: counts, max_cluster_plans: 0, unavailable: `re-check scan failed${code}` };
  }
}

export function consolidateCandidates({ workspace, copilotHome, home, withIds = false, writeLayer = false, layerOverride = null, recheck: recheckRequested = false }) {
  const { status, recheck: computedRecheck } = statusWithRecheck({ workspace, copilotHome, home, writeLayer, layerOverride, withFeedback: true, recheckRequested });
  const episodes = collectEpisodes({ workspace, copilotHome, home });
  const bySha = new Map(episodes.map((e) => [`${e.path}@${e.sha256}`, e]));

    const fullUnconsolidated = [];
  for (const u of status.unconsolidated) {
    const full = bySha.get(`${u.path}@${u.sha256}`);
    if (full) fullUnconsolidated.push(full);
  }
  fullUnconsolidated.sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      String(a.date || '').localeCompare(String(b.date || '')) ||
      a.path.localeCompare(b.path)
  );

    let usedBytes = 0;
  const includedEntries = [];
  for (const full of fullUnconsolidated) {
    const entry = {
      path: full.path,
      sha256: full.sha256,
      kind: full.kind,
      ...(withIds ? { id: episodeId(full) } : {}),
            title: inertLine(full.title).slice(0, CANDIDATE_TITLE_CAP),
      tags: capTags(full.tags, CANDIDATE_TAGS_TOTAL_CAP),
      excerpt: full.excerpt,
    };
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
    if (includedEntries.length > 0 && usedBytes + entryBytes > CANDIDATE_EPISODE_BUDGET_BYTES) break;
    usedBytes += entryBytes;
    includedEntries.push({ category: full.category, entry });
  }
  const truncated = includedEntries.length < fullUnconsolidated.length;
  const remaining = fullUnconsolidated.length - includedEntries.length;

    const clusters = new Map();
  for (const { category, entry } of includedEntries) {
    if (!clusters.has(category)) clusters.set(category, []);
    clusters.get(category).push(entry);
  }

    const dir = storeDir(workspace, { home });
  const view = layerView({ workspace, home, dir, writeLayer, layerOverride });
  const active = activeLearnings(listLearnings(view.layerRoot));
  const totalBytes = active.reduce((n, l) => n + l.bytes, 0);
  const includeBodies = totalBytes <= LEARNING_BODY_BUDGET_BYTES;
  const feedback = status.feedback || null;
  const recheck = recheckRequested ? computedRecheck : null;
  const reviewFirst = feedback?.state === 'on' ? new Set(feedback.review_required) : null;
  const ordered = reviewFirst ? active.toSorted((a, b) => Number(reviewFirst.has(b.id)) - Number(reviewFirst.has(a.id))) : active;
  const learnings = ordered.map((l) => ({
    id: l.id,
        trigger: inertLine(l.fm.trigger || ''),
    status: l.fm.status || 'active',
    bytes: l.bytes,
        ...(includeBodies ? { body: l.body.split('\n').map(inertLine).join('\n') } : {}),
  }));

    const governed = [...readGovernance(dir).values()]
    .filter((e) => ['retire', 'dispute', 'promote'].includes(e.action))
    .map((e) => ({ id: e.id, action: e.action }));

  return {
    schema: 1,
    contract: {
      maxOps: MAX_OPS_PER_RUN,
      byteCap: LEARNING_BYTE_CAP,
      threshold: CONSOLIDATION_THRESHOLD,
      domainCap: DOMAIN_ACTIVE_CAP,
    },
    clusters: [...clusters.entries()].map(([id, eps]) => ({ id, episodes: eps })),
    learnings,
    domains: status.domains,
    governed,
    ...(feedback ? { feedback } : {}),
    ...(recheck ? { recheck } : {}),
    storeDir: dir,
    layer: view.layer,
    ...(view.bucketKey ? { bucketKey: view.bucketKey } : {}),
        ...(truncated ? { truncated: true, remaining } : {}),
  };
}
