import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readFileNoFollow, assertNoSymlinkAncestors } from '../fs-safe.mjs';
import { redactSecrets } from '../secret-scan.mjs';
import { readJournal, foldRuns } from '../run-journal.mjs';
import { readRecheckConfig, readStoreConfig, repoId, inertLine } from './store.mjs';
import { learningApplicability, APPLICABILITY_VERSION } from './applicability.mjs';

// Consolidation re-check (agent memory plan, Phase 2). Every signal here is
// evidence for judgment built only from Harness-owned records in the
// checkout (exposure records, verification evidence, the run journal, review
// observations) and the learning store. Nothing in this module writes, and no
// state of `knowledge.recheck` grants authority. Host transcripts are never
// read: they are not authenticated.

export const RECHECK_PLAN_THRESHOLD = 2;
export const RECHECK_SECTION_CAP = 10;
export const RECHECK_DUE_STALE_EXPOSED = 3;
export const RECHECK_DUE_CLUSTER_PLANS = 3;
export const RECHECK_EXCERPT_CAP = 400;
/** `derived_from` reference to a failure cluster. The ID is a stable digest of the cluster key. */
export const FAILURE_CLUSTER_REF = /^failure-cluster:[a-f0-9]{16}$/;
const SCAN_CAP = 512;
const PLAN_LIST_CAP = 5;
const REF_LIST_CAP = 8;
const FINDING_TITLE_CAP = 120;
const HASH_FILE = /^[a-f0-9]{64}\.json$/;

/** Cluster IDs are digests of the cluster key, so they can be recomputed from the same evidence at any time. */
export const failureClusterId = key => crypto.createHash('sha256').update(`failure-cluster\0${key}`).digest('hex').slice(0, 16);
const findingClusterId = key => crypto.createHash('sha256').update(`finding-cluster\0${key}`).digest('hex').slice(0, 16);

/**
 * Effective read state. Knowledge modes keep priority: `off`, `freeze` and
 * `capture-only` read re-check as `off` whatever the key says.
 */
export function recheckState({ workspace, home }) {
  const { mode } = readStoreConfig(workspace, { home });
  if (!['on', 'suggest'].includes(mode)) return 'off';
  return readRecheckConfig(workspace, { home });
}

function listRecordNames(root, rel, pattern) {
  if (!assertNoSymlinkAncestors(root, rel)) return { names: [], omitted: 0 };
  let names = [];
  try { names = fs.readdirSync(path.join(root, rel)).filter(name => pattern.test(name)).sort(); } catch { return { names: [], omitted: 0 }; }
  return { names: names.slice(0, SCAN_CAP), omitted: Math.max(0, names.length - SCAN_CAP) };
}

function readJson(root, rel) {
  const text = readFileNoFollow(path.join(root, rel), { root, maxBytes: 1024 * 1024 });
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Bounded, secret-screened tail of a failing check's retained output. */
export function failureExcerpt(check) {
  const raw = [check?.stderr, check?.stdout, check?.message].find(value => typeof value === 'string' && value.trim());
  if (!raw) return null;
  const tail = raw.trim().slice(-RECHECK_EXCERPT_CAP);
  return inertLine(redactSecrets(tail)).replace(/\s+/g, ' ').trim();
}

const byStrength = (a, b) => b.plans.length - a.plans.length || String(b.last_seen || '').localeCompare(String(a.last_seen || '')) || a.id.localeCompare(b.id);

function finishCluster(row) {
  const plans = [...row.plans].sort();
  return { ...row, plans: plans.slice(0, PLAN_LIST_CAP), plan_count: plans.length };
}

/** Failed `ae verify` checks, grouped by check ID across plans, from current and historical evidence records. */
function evidenceClusters(workspace) {
  const records = [];
  const history = listRecordNames(workspace, '.harness/evidence/history', HASH_FILE);
  for (const name of history.names) records.push({ rel: `.harness/evidence/history/${name}`, value: readJson(workspace, `.harness/evidence/history/${name}`) });
  const latest = listRecordNames(workspace, '.harness/evidence', /\.json$/);
  for (const name of latest.names) records.push({ rel: `.harness/evidence/${name}`, value: readJson(workspace, `.harness/evidence/${name}`) });
  const seen = new Set(), clusters = new Map();
  for (const { rel, value } of records) {
    if (!value || typeof value.plan !== 'string' || !value.plan || !Array.isArray(value.checks)) continue;
    const at = typeof value.verifiedAt === 'string' ? value.verifiedAt : null;
    const observation = `${value.plan}\0${at}`;
    if (seen.has(observation)) continue; // the latest record duplicates one history record
    seen.add(observation);
    for (const check of value.checks) {
      if (!check || typeof check.id !== 'string' || !check.id || !['failed', 'timeout'].includes(check.status)) continue;
      const checkId = inertLine(check.id).slice(0, 200);
      const key = `check:${checkId}`;
      const row = clusters.get(key) || { id: failureClusterId(key), source: 'evidence', check: checkId, plans: new Set(), failures: 0, first_seen: null, last_seen: null, excerpt: null, evidence: [] };
      row.plans.add(value.plan);
      row.failures += 1;
      if (at && (!row.first_seen || at < row.first_seen)) row.first_seen = at;
      if (at && (!row.last_seen || at >= row.last_seen)) { row.last_seen = at; row.excerpt = failureExcerpt(check); }
      if (!row.evidence.includes(rel)) row.evidence.push(rel);
      clusters.set(key, row);
    }
  }
  return { clusters: [...clusters.values()], omitted: history.omitted + latest.omitted };
}

/** Failed runs per command across plans, from the run journal's `run.result` records. */
function journalClusters(workspace) {
  let runs = [];
  try { runs = foldRuns(readJournal(workspace), { isAlive: () => false }); } catch { return []; }
  const clusters = new Map();
  for (const run of runs) {
    if (run.status !== 'failed' || typeof run.plan !== 'string' || !run.plan || typeof run.command !== 'string' || !run.command) continue;
    const command = inertLine(run.command).slice(0, 80);
    const key = `command:${command}`;
    const at = run.finishedAt || run.startedAt || null;
    const row = clusters.get(key) || { id: failureClusterId(key), source: 'run-journal', command, plans: new Set(), failures: 0, first_seen: null, last_seen: null };
    row.plans.add(run.plan);
    row.failures += 1;
    if (at && (!row.first_seen || at < row.first_seen)) row.first_seen = at;
    if (at && (!row.last_seen || at > row.last_seen)) row.last_seen = at;
    clusters.set(key, row);
  }
  return [...clusters.values()];
}

/** Recurring review findings grouped by perspective (the finding category) and file across plans. */
function findingClusters(workspace) {
  const { names, omitted } = listRecordNames(workspace, '.harness/reviews/observations', HASH_FILE);
  const packetPlans = new Map(), clusters = new Map();
  for (const name of names) {
    const input = readJson(workspace, `.harness/reviews/observations/${name}`);
    if (!input || !/^[a-f0-9]{64}$/.test(input.packet || '') || !Array.isArray(input.results)) continue;
    if (!packetPlans.has(input.packet)) packetPlans.set(input.packet, readJson(workspace, `.harness/reviews/packets/${input.packet}.json`)?.plan ?? null);
    const plan = packetPlans.get(input.packet);
    if (typeof plan !== 'string' || !plan) continue; // standalone reviews belong to no plan
    for (const result of input.results) {
      if (typeof result?.reviewer !== 'string' || !Array.isArray(result.findings)) continue;
      for (const finding of result.findings) {
        const file = typeof finding?.file === 'string' ? path.posix.normalize(finding.file.replace(/\\/g, '/')) : '';
        if (!file || file.startsWith('../') || /[\0\r\n]/.test(file)) continue;
        const category = inertLine(result.reviewer).slice(0, 80);
        const key = `${category}\0${file}`;
        const row = clusters.get(key) || { id: findingClusterId(key), category, file: inertLine(file).slice(0, 512), plans: new Set(), findings: 0, titles: [] };
        row.plans.add(plan);
        row.findings += 1;
        const title = typeof finding.title === 'string' ? inertLine(redactSecrets(finding.title.trim())).slice(0, FINDING_TITLE_CAP) : '';
        if (title && row.titles.length < 3 && !row.titles.includes(title)) row.titles.push(title);
        clusters.set(key, row);
      }
    }
  }
  return { clusters: [...clusters.values()], omitted };
}

/** Exposure entries across every plan's record: learning ID -> last exposure, total count, plans. */
function exposureIndex(workspace) {
  const { names } = listRecordNames(workspace, '.harness/learning/exposures', /^plan-[a-f0-9]{64}\.json$/);
  const index = new Map();
  for (const name of names) {
    const record = readJson(workspace, `.harness/learning/exposures/${name}`);
    if (record?.version !== 1 || typeof record.plan !== 'string' || !Array.isArray(record.entries)) continue;
    for (const entry of record.entries) {
      if (typeof entry?.id !== 'string') continue;
      const row = index.get(entry.id) || { last: null, count: 0, plans: new Set() };
      if (typeof entry.lastExposedAt === 'string' && (!row.last || entry.lastExposedAt > row.last)) row.last = entry.lastExposedAt;
      row.count += Number.isInteger(entry.count) ? entry.count : 0;
      row.plans.add(record.plan);
      index.set(entry.id, row);
    }
  }
  return index;
}

/** Exposed learnings whose recorded source bindings no longer match the checkout. */
function staleExposed(workspace, learnings) {
  const exposed = exposureIndex(workspace);
  if (!exposed.size) return [];
  const repository = learnings.some(l => String(l.fm.applicability_version) === String(APPLICABILITY_VERSION)) ? repoId(workspace) : null;
  const cache = new Map(), out = [];
  for (const learning of learnings) {
    const exposure = exposed.get(learning.id);
    if (!exposure) continue;
    const applicability = learningApplicability({ workspace, fm: learning.fm, repository, cache });
    if (applicability.state !== 'needs-review') continue;
    out.push({
      id: learning.id,
      changed_paths: applicability.bindings.filter(b => ['changed', 'missing', 'excluded'].includes(b.state)).map(b => ({ path: b.path, state: b.state })).slice(0, REF_LIST_CAP),
      last_exposed: exposure.last,
      exposures: exposure.count,
      plan_count: exposure.plans.size,
    });
  }
  return out.sort((a, b) => String(b.last_exposed || '').localeCompare(String(a.last_exposed || '')) || a.id.localeCompare(b.id));
}

const CODE_SPAN = /`([^`\n]{1,300})`/g;
const LEARNING_REF = /^([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9._-]*)$/;

function pathLike(token) {
  return token.includes('/') && !/\s/.test(token) && !/[*?{}<>$~:|"'\\]/.test(token)
    && !token.startsWith('/') && !token.startsWith('-') && !token.startsWith('.harness/')
    && !token.split('/').includes('..') && path.posix.normalize(token).replace(/\/$/, '') === token.replace(/\/$/, '');
}

function pathExists(workspace, rel) {
  const clean = rel.replace(/\/$/, '');
  const full = assertNoSymlinkAncestors(workspace, clean);
  if (!full) return true; // unsafe paths are not reported as missing; they are not ours to judge
  try { fs.lstatSync(full); return true; } catch { return false; }
}

/**
 * Inline code spans in a learning body that name another learning (`domain/slug`
 * with a known domain) or a repository path that no longer exists. Learning
 * references are checked against every learning in the store, active or not.
 */
function brokenReferences(workspace, learnings, allLearnings) {
  const ids = new Set(allLearnings.map(l => l.id));
  const domains = new Set(allLearnings.map(l => l.domain));
  const out = [];
  for (const learning of learnings) {
    const refs = [];
    for (const [, span] of String(learning.body || '').matchAll(CODE_SPAN)) {
      const token = span.trim();
      if (refs.some(ref => ref.ref === token)) continue;
      const asLearning = token.match(LEARNING_REF);
      if (asLearning && domains.has(asLearning[1]) && !/\.[a-z0-9]{1,8}$/i.test(token)) {
        if (!ids.has(token) && !pathExists(workspace, token)) refs.push({ kind: 'learning', ref: token });
        continue;
      }
      if (pathLike(token) && !pathExists(workspace, token)) refs.push({ kind: 'path', ref: inertLine(token) });
    }
    if (refs.length) out.push({ id: learning.id, references: refs.slice(0, REF_LIST_CAP) });
  }
  return out;
}

const plansAtLeast = n => row => row.plans.size >= n;

/**
 * The `recheck` packet section. `reviewRequired` is the Phase 1 feedback list
 * of learnings judged `wrong` in their current version, shared with the
 * feedback section. Each list is capped with an omission count.
 */
export function recheckSummary({ workspace, learnings, allLearnings = learnings, reviewRequired = [] }) {
  const evidence = evidenceClusters(workspace);
  const failures = [...evidence.clusters, ...journalClusters(workspace)].filter(plansAtLeast(RECHECK_PLAN_THRESHOLD)).map(finishCluster).sort(byStrength);
  const findings = findingClusters(workspace);
  const findingRows = findings.clusters.filter(plansAtLeast(RECHECK_PLAN_THRESHOLD)).map(finishCluster).sort(byStrength);
  const stale = staleExposed(workspace, learnings);
  const broken = brokenReferences(workspace, learnings, allLearnings);
  const cap = list => list.slice(0, RECHECK_SECTION_CAP);
  const over = list => Math.max(0, list.length - RECHECK_SECTION_CAP);
  return {
    contract: { planThreshold: RECHECK_PLAN_THRESHOLD, cap: RECHECK_SECTION_CAP, dueStaleExposed: RECHECK_DUE_STALE_EXPOSED, dueClusterPlans: RECHECK_DUE_CLUSTER_PLANS },
    stale_exposed: cap(stale),
    review_required: cap(reviewRequired),
    failure_clusters: cap(failures),
    finding_clusters: cap(findingRows),
    broken_references: cap(broken),
    counts: { stale_exposed: stale.length, review_required: reviewRequired.length, failure_clusters: failures.length, finding_clusters: findingRows.length, broken_references: broken.length },
    omitted: {
      stale_exposed: over(stale), review_required: over(reviewRequired), failure_clusters: over(failures), finding_clusters: over(findingRows), broken_references: over(broken),
      ...(evidence.omitted || findings.omitted ? { scannedRecords: evidence.omitted + findings.omitted } : {}),
    },
    max_cluster_plans: failures.reduce((n, row) => Math.max(n, row.plan_count), 0),
  };
}

/** Only with `knowledge.recheck=on`: three stale exposed learnings, or one failure cluster across three plans. */
export function recheckDue(summary) {
  return summary.counts.stale_exposed >= RECHECK_DUE_STALE_EXPOSED || summary.max_cluster_plans >= RECHECK_DUE_CLUSTER_PLANS;
}
