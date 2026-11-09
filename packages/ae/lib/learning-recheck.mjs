import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readFileNoFollow, readFileTailNoFollow, assertNoSymlinkAncestors } from './fs-safe.mjs';
import { redactSecrets, maskSecrets } from './secret-scan.mjs';
import { foldRuns, RUNS_FILE } from './run-journal.mjs';
import { readRecheckConfig, readStoreConfig, repoId, inertLine } from './knowledge/store.mjs';
import { learningApplicability, APPLICABILITY_VERSION } from './knowledge/applicability.mjs';

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
const RECHECK_MASK_WINDOW = 8 * RECHECK_EXCERPT_CAP;
const RECHECK_LONG_TOKEN = 1024;
const ANSI_CSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
/** `derived_from` reference to a failure cluster. The ID is a stable digest of the cluster key. */
export const FAILURE_CLUSTER_REF = /^failure-cluster:[a-f0-9]{16}$/;
const SCAN_CAP = 512;
const PLAN_LIST_CAP = 5;
const REF_LIST_CAP = 8;
const FINDING_TITLE_CAP = 120;
const HASH_FILE = /^[a-f0-9]{64}\.json$/;
const JOURNAL_BYTE_CAP = 8 * 1024 * 1024;

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

/**
 * Record names, newest first by modification time. Modification time only
 * preselects (twice the cap): callers that can order by the record's own
 * timestamp re-rank and cap with `newestRecords`, since copies and restores
 * reset mtime.
 */
function listRecordNames(root, rel, pattern, limit = SCAN_CAP * 2) {
  const dir = assertNoSymlinkAncestors(root, rel);
  if (!dir) return { names: [], omitted: 0 };
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile() && pattern.test(entry.name)).map(entry => {
      let mtime = 0;
      try { mtime = fs.lstatSync(path.join(dir, entry.name)).mtimeMs; } catch { mtime = 0; }
      return { name: entry.name, mtime };
    });
  } catch { return { names: [], omitted: 0 }; }
  entries.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  return { names: entries.slice(0, limit).map(entry => entry.name), omitted: Math.max(0, entries.length - limit) };
}

/** Keep the `SCAN_CAP` records with the newest own timestamp; the rest add to `omitted`. */
function newestRecords(records, timestamp, omitted) {
  const ranked = records.toSorted((a, b) => String(timestamp(b) || '').localeCompare(String(timestamp(a) || '')));
  return { records: ranked.slice(0, SCAN_CAP), omitted: omitted + Math.max(0, ranked.length - SCAN_CAP) };
}

const digestOf = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A history or observation record whose name is not the digest of its content was not written by Harness. */
function readDigestRecord(root, rel, name) {
  const value = readJson(root, rel);
  return value && digestOf(value) === name.slice(0, -'.json'.length) ? value : null;
}

function readJson(root, rel) {
  const text = readFileNoFollow(path.join(root, rel), { root, maxBytes: 1024 * 1024 });
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Bounded, secret-screened tail of a failing check's retained output. Any
 * private-key header withholds it. ANSI CSI sequences are stripped, so a
 * colour code cannot sit between a keyword and its value. Control characters
 * and whitespace runs are then collapsed, so padding cannot push a keyword
 * such as `client_secret=` or `Authorization: Bearer` out of the masking
 * window while its value stays in the tail. Any unbroken run of
 * `RECHECK_LONG_TOKEN` or more non-space characters is withheld whole, so the
 * tail of a secret longer than the window cannot survive without its keyword.
 * Masking then runs over a bounded window (some patterns are superlinear on
 * long output), well wider than the tail, before the last characters are kept
 * and screened once more.
 */
export function failureExcerpt(check) {
  const raw = [check?.stderr, check?.stdout, check?.message].find(value => typeof value === 'string' && value.trim());
  if (!raw) return null;
  if (/PRIVATE KEY/.test(raw)) return '[withheld: private-key]';
  // Split rather than match `\S{1024,}`: that regex rescans every run just under the threshold.
  const flat = raw.replace(ANSI_CSI, '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').map(run => (run.length >= RECHECK_LONG_TOKEN ? '[withheld: long-token]' : run)).join(' ');
  const masked = maskSecrets(flat.slice(-RECHECK_MASK_WINDOW));
  return redactSecrets(masked.slice(-RECHECK_EXCERPT_CAP));
}

/**
 * Only a named check (from checks.yaml) whose process failed is failure
 * evidence: a nonzero exit, or a timeout with retained output. Harness's
 * built-in gate rows (plan-state, phase-tasks, scope, required-reviews and the
 * rest) carry no process result: they say the work was unfinished, not that
 * something broke. A passing process whose row Harness later marked failed
 * (an artifact or domain manifest refusal) keeps exit 0 and is excluded too.
 */
const processFailed = check => (check.status === 'failed' && Number.isInteger(check.exitCode) && check.exitCode !== 0)
  || (check.status === 'timeout' && ['stdout', 'stderr'].some(key => Object.hasOwn(check, key)));

const byStrength = (a, b) => b.plan_count - a.plan_count || String(b.last_seen || '').localeCompare(String(a.last_seen || '')) || a.id.localeCompare(b.id);

function finishCluster(row) {
  const plans = [...row.plans].sort();
  return { ...row, plans: plans.slice(0, PLAN_LIST_CAP), plan_count: plans.length };
}

/**
 * A failure counts toward a cluster only when it is timestamped after the
 * latest learning-writing consolidation that consumed an episode answering the
 * cluster (`derived_from`), so answering a cluster clears it until the failure
 * recurs, the same day or later.
 */
const unresolved = (resolved, id, at) => !resolved.has(id) || (typeof at === 'string' && at > resolved.get(id));

/**
 * Failed named `ae verify` checks, grouped by check ID across plans, from the
 * digest-named evidence history Harness writes on every verification.
 */
function evidenceClusters(workspace, resolved) {
  const history = listRecordNames(workspace, '.harness/evidence/history', HASH_FILE);
  const read = history.names.map(name => ({ rel: `.harness/evidence/history/${name}`, value: readDigestRecord(workspace, `.harness/evidence/history/${name}`, name) })).filter(record => record.value);
  const { records, omitted } = newestRecords(read, record => record.value.verifiedAt, history.omitted);
  const clusters = new Map();
  for (const { rel, value } of records) {
    if (typeof value.plan !== 'string' || !value.plan || !Array.isArray(value.checks)) continue;
    const at = typeof value.verifiedAt === 'string' ? value.verifiedAt : null;
    for (const check of value.checks) {
      if (!check || typeof check.id !== 'string' || !check.id || !processFailed(check)) continue;
      const checkId = inertLine(check.id).slice(0, 200);
      const key = `check:${checkId}`;
      if (!unresolved(resolved, failureClusterId(key), at)) continue;
      const row = clusters.get(key) || { id: failureClusterId(key), source: 'evidence', check: checkId, plans: new Set(), failures: 0, first_seen: null, last_seen: null, excerpt: null, evidence: [] };
      row.plans.add(value.plan);
      row.failures += 1;
      if (at && (!row.first_seen || at < row.first_seen)) row.first_seen = at;
      if (at && (!row.last_seen || at >= row.last_seen)) { row.last_seen = at; row.excerpt = failureExcerpt(check); }
      if (!row.evidence.includes(rel)) row.evidence.push(rel);
      clusters.set(key, row);
    }
  }
  return { clusters: [...clusters.values()], omitted };
}

/**
 * Bounded, no-follow read of the run journal's newest bytes. An unsafe or
 * symlinked journal contributes nothing; an oversized one contributes its
 * tail, without the first partial line, and says so.
 */
function readJournalBounded(workspace) {
  const rel = path.join('.harness', RUNS_FILE);
  const full = assertNoSymlinkAncestors(workspace, rel);
  const tail = full ? readFileTailNoFollow(full, { root: workspace, maxBytes: JOURNAL_BYTE_CAP }) : null;
  if (!tail) return { records: [], truncated: false };
  let text = tail.buffer.toString('utf8');
  if (tail.truncated) text = text.slice(text.indexOf('\n') + 1);
  return { records: text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean), truncated: tail.truncated };
}

/**
 * Failed runs per command across plans, from the run journal's `run.result`
 * records. Context only: a journal result cannot tell a gate refusal from a
 * broken check, so these clusters never make consolidation due.
 */
function journalClusters(workspace, resolved) {
  const journal = readJournalBounded(workspace);
  let runs = [];
  try { runs = foldRuns(journal.records, { isAlive: () => false }); } catch { return { clusters: [], truncated: journal.truncated }; }
  const clusters = new Map();
  for (const run of runs) {
    if (run.status !== 'failed' || typeof run.plan !== 'string' || !run.plan || typeof run.command !== 'string' || !run.command) continue;
    const command = inertLine(run.command).slice(0, 80);
    const key = `command:${command}`;
    const at = run.finishedAt || run.startedAt || null;
    if (!unresolved(resolved, failureClusterId(key), at)) continue;
    const row = clusters.get(key) || { id: failureClusterId(key), source: 'run-journal', command, plans: new Set(), failures: 0, first_seen: null, last_seen: null };
    row.plans.add(run.plan);
    row.failures += 1;
    if (at && (!row.first_seen || at < row.first_seen)) row.first_seen = at;
    if (at && (!row.last_seen || at > row.last_seen)) row.last_seen = at;
    clusters.set(key, row);
  }
  return { clusters: [...clusters.values()], truncated: journal.truncated };
}

/** Recurring review findings grouped by perspective (the finding category) and file across plans. */
function findingClusters(workspace) {
  const { names, omitted } = listRecordNames(workspace, '.harness/reviews/observations', HASH_FILE, SCAN_CAP);
  const packetPlans = new Map(), clusters = new Map();
  for (const name of names) {
    const input = readDigestRecord(workspace, `.harness/reviews/observations/${name}`, name);
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

/**
 * Exposure entries across the newest plan records: learning ID -> last
 * exposure, total count, plans. `omitted` counts the plan records left out by
 * the preselect and the cap.
 */
function exposureIndex(workspace) {
  const listed = listRecordNames(workspace, '.harness/learning/exposures', /^plan-[a-f0-9]{64}\.json$/);
  const valid = listed.names.map(name => readJson(workspace, `.harness/learning/exposures/${name}`))
    .filter(record => record?.version === 1 && typeof record.plan === 'string' && Array.isArray(record.entries));
  const latest = record => record.entries.reduce((max, entry) => (typeof entry?.lastExposedAt === 'string' && entry.lastExposedAt > max ? entry.lastExposedAt : max), '');
  const index = new Map();
  const kept = newestRecords(valid, latest, listed.omitted);
  for (const record of kept.records) {
    for (const entry of record.entries) {
      if (typeof entry?.id !== 'string') continue;
      const row = index.get(entry.id) || { last: null, count: 0, plans: new Set() };
      if (typeof entry.lastExposedAt === 'string' && (!row.last || entry.lastExposedAt > row.last)) row.last = entry.lastExposedAt;
      row.count += Number.isInteger(entry.count) ? entry.count : 0;
      row.plans.add(record.plan);
      index.set(entry.id, row);
    }
  }
  return { index, omitted: kept.omitted };
}

/** Exposed learnings whose recorded source bindings no longer match the checkout. */
function staleExposed(workspace, learnings) {
  const { index: exposed, omitted } = exposureIndex(workspace);
  if (!exposed.size) return { rows: [], omitted };
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
  return { rows: out.sort((a, b) => String(b.last_exposed || '').localeCompare(String(a.last_exposed || '')) || a.id.localeCompare(b.id)), omitted };
}

const CODE_SPAN = /`([^`\n]{1,300})`/g;
const LEARNING_REF = /^([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9._-]*)$/;

const REF_PREFIX = /^(?:origin|upstream|refs|heads|tags|remotes)\//;

function pathLike(token) {
  return token.includes('/') && !/\s/.test(token) && !/[*?{}<>$~:|"'\\@]/.test(token)
    && !token.startsWith('/') && !token.startsWith('-') && !token.startsWith('.harness/') && !REF_PREFIX.test(token)
    && !token.split('/').includes('..') && path.posix.normalize(token).replace(/\/$/, '') === token.replace(/\/$/, '');
}

/** 'present', 'absent', or 'unknown' when the path is unsafe to inspect. */
function pathState(base, rel) {
  const full = assertNoSymlinkAncestors(base, rel.replace(/\/$/, ''));
  if (!full) return 'unknown';
  try { fs.lstatSync(full); return 'present'; } catch { return 'absent'; }
}

/** The workspace root plus each ancestor directory of the learning's anchors and source bindings. */
function referenceBases(workspace, fm) {
  const bases = new Set(['']);
  const anchors = [...(Array.isArray(fm?.anchors) ? fm.anchors : []), ...(Array.isArray(fm?.source_bindings) ? fm.source_bindings.map(b => b?.path) : [])];
  for (const anchor of anchors) {
    if (typeof anchor !== 'string' || !pathLike(anchor)) continue;
    for (let dir = path.posix.dirname(anchor); dir && dir !== '.'; dir = path.posix.dirname(dir)) bases.add(dir);
  }
  return [...bases].map(dir => (dir ? path.join(workspace, dir) : workspace));
}

/**
 * A path reference is reported missing only when some base (the root or an
 * anchor's ancestor) holds its first segment as a directory and no base holds
 * the whole path. Prose with slashes (`and/or`, `owner/repo`,
 * `application/json`), package names and Git refs never qualify.
 */
function missingPath(bases, token) {
  const first = token.split('/')[0];
  let checkable = false;
  for (const base of bases) {
    if (pathState(base, token) !== 'absent') return false;
    try { if (fs.lstatSync(path.join(base, first)).isDirectory()) checkable = true; } catch { /* absent */ }
  }
  return checkable;
}

/**
 * Inline code spans in a learning body that name another learning (`domain/slug`
 * with a known domain) or a repository path that no longer exists. Learning
 * references are checked against every golden and branch learning, active or not.
 */
function brokenReferences(workspace, learnings, allLearnings) {
  const ids = new Set(allLearnings.map(l => l.id));
  const domains = new Set(allLearnings.map(l => l.domain));
  const out = [];
  for (const learning of learnings) {
    const refs = [];
    const bases = referenceBases(workspace, learning.fm);
    for (const [, span] of String(learning.body || '').matchAll(CODE_SPAN)) {
      const token = span.trim();
      if (refs.some(ref => ref.ref === token)) continue;
      const asLearning = token.match(LEARNING_REF);
      if (asLearning && domains.has(asLearning[1]) && !/\.[a-z0-9]{1,8}$/i.test(token)) {
        if (!ids.has(token) && pathState(workspace, token) === 'absent') refs.push({ kind: 'learning', ref: token });
        continue;
      }
      if (pathLike(token) && missingPath(bases, token)) refs.push({ kind: 'path', ref: inertLine(token) });
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
export function recheckSummary({ workspace, learnings, allLearnings = learnings, reviewRequired = [], resolved = new Map() }) {
  const evidence = evidenceClusters(workspace, resolved);
  const journal = journalClusters(workspace, resolved);
  const failures = [...evidence.clusters, ...journal.clusters].filter(plansAtLeast(RECHECK_PLAN_THRESHOLD)).map(finishCluster).sort(byStrength);
  const findings = findingClusters(workspace);
  const findingRows = findings.clusters.filter(plansAtLeast(RECHECK_PLAN_THRESHOLD)).map(finishCluster).sort(byStrength);
  const { rows: stale, omitted: exposureOmitted } = staleExposed(workspace, learnings);
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
      ...(exposureOmitted ? { exposureRecords: exposureOmitted } : {}),
      ...(journal.truncated ? { journal: `only the newest ${JOURNAL_BYTE_CAP / (1024 * 1024)} MiB of the run journal was read` } : {}),
    },
    max_cluster_plans: failures.filter(row => row.source === 'evidence').reduce((n, row) => Math.max(n, row.plan_count), 0),
  };
}

/** Only with `knowledge.recheck=on`: three stale exposed learnings, or one named-check failure cluster across three plans. */
export function recheckDue(summary) {
  return summary.counts.stale_exposed >= RECHECK_DUE_STALE_EXPOSED || summary.max_cluster_plans >= RECHECK_DUE_CLUSTER_PLANS;
}
