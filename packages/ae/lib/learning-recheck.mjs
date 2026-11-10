import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readFileNoFollow, readFileTailNoFollow, assertNoSymlinkAncestors } from './fs-safe.mjs';
import { foldRuns, RUNS_FILE } from './run-journal.mjs';
import { readRecheckConfig, readStoreConfig, repoId, inertLine } from './knowledge/store.mjs';
import { learningApplicability, APPLICABILITY_VERSION } from './knowledge/applicability.mjs';
import { scanSecrets } from './secret-scan.mjs';

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
/** `derived_from` reference to a failure cluster. The ID is a stable digest of the cluster key. */
export const FAILURE_CLUSTER_REF = /^failure-cluster:[a-f0-9]{16}$/;
const SCAN_CAP = 512;
/** Evidence-history preselect for status and orient, which need only counts and `due`; packets read twice `SCAN_CAP`. */
export const RECHECK_STATUS_PRESELECT = 128;
/** At most this many directory entries are read from one record directory; the rest are reported, not opened. */
export const RECHECK_DIR_ENTRY_CAP = 4096;
const PLAN_LIST_CAP = 5;
const REF_LIST_CAP = 8;
// Structured metadata only: no raw check output, finding title, command line or plan text is ever shown.
// Names and paths are shown only when they fit a narrow character set, start with a letter or digit (so
// nothing reads as a flag or a dot path) and match no secret pattern; anything else is replaced, never
// escaped or trimmed. A shown name is display text only and is never used as a plain-object key.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const SAFE_COMMAND = /^[a-z][a-z0-9-]{0,31}$/;
const SAFE_LEARNING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const UNNAMED = '[unnamed]';
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const SIGNALS = new Set(['SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM', 'SIGTRAP', 'SIGXCPU', 'SIGXFSZ']);
const FAILURE_STATUSES = new Set(['failed', 'timeout']);
const SEVERITIES = new Set(['P1', 'P2', 'P3']);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FINDING_SAMPLE_CAP = 3;
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
 * reset mtime. Record names are digests, not times, so the directory is read
 * in readdir order and only its first `RECHECK_DIR_ENTRY_CAP` entries are
 * considered; `truncated` says more entries were left unread.
 */
function listRecordNames(root, rel, pattern, limit = SCAN_CAP * 2) {
  const dir = assertNoSymlinkAncestors(root, rel);
  if (!dir) return { names: [], omitted: 0, truncated: false };
  const entries = [];
  let truncated = false;
  let handle = null;
  try {
    handle = fs.opendirSync(dir);
    for (let seen = 0; ; seen++) {
      const entry = handle.readSync();
      if (!entry) break;
      if (seen >= RECHECK_DIR_ENTRY_CAP) { truncated = true; break; }
      if (!entry.isFile() || !pattern.test(entry.name)) continue;
      let mtime = 0;
      try { mtime = fs.lstatSync(path.join(dir, entry.name)).mtimeMs; } catch { mtime = 0; }
      entries.push({ name: entry.name, mtime });
    }
  } catch { return { names: [], omitted: 0, truncated: false }; } finally { try { handle?.closeSync(); } catch { /* already closed */ } }
  entries.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return { names: entries.slice(0, limit).map(entry => entry.name), omitted: Math.max(0, entries.length - limit), truncated };
}

/** Descending numeric order; a missing time sorts last. */
const newestFirst = (a, b) => (b > a ? 1 : b < a ? -1 : 0);

/** Keep the `SCAN_CAP` records with the newest own timestamp; the rest add to `omitted`. */
function newestRecords(records, timestamp, omitted) {
  const ranked = records.map(record => ({ record, ms: timeMs(timestamp(record)) })).sort((a, b) => newestFirst(a.ms, b.ms)).map(row => row.record);
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

const noSecret = value => scanSecrets(value).length === 0;

/** A check, reviewer or rule name as shown: unchanged when it fits `SAFE_NAME`, otherwise `[unnamed]`. */
const safeName = value => (typeof value === 'string' && SAFE_NAME.test(value) && noSecret(value) ? value : UNNAMED);

/** A relative path as shown: unchanged when it fits `SAFE_PATH` and has no `..` segment, otherwise null (shown as `[unnamed]`). */
const safePath = value => (typeof value === 'string' && SAFE_PATH.test(value) && !value.split('/').includes('..') && noSecret(value) ? value : null);

/** A plan or reference path as shown: the safe path, else a 12-hex digest so distinct values stay distinct, else `[unnamed]`. */
const displayPath = value => safePath(value) ?? (typeof value === 'string' && value ? `[unnamed:${shortHash(value)}]` : UNNAMED);

/** A run-journal command as shown: only a lowercase `ae` subcommand-shaped word, otherwise `[unnamed]`. */
const safeCommand = value => (typeof value === 'string' && SAFE_COMMAND.test(value) ? value : UNNAMED);

/** A learning ID as shown: `domain/slug` in the safe set, otherwise a digest. */
const safeLearningId = value => (typeof value === 'string' && SAFE_LEARNING_ID.test(value) && noSecret(value) ? value : `[unnamed:${shortHash(String(value))}]`);

/**
 * A timestamp as shown and compared: an ISO 8601 time that parses, no more
 * than five minutes in the future, rewritten to canonical UTC
 * (`YYYY-MM-DDTHH:MM:SS.sssZ`) so string order is time order. Anything else is null.
 */
const safeTime = value => {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms > Date.now() + FUTURE_SKEW_MS) return null;
  const iso = new Date(ms).toISOString();
  return CANONICAL_TIME.test(iso) ? iso : null;
};
/** Milliseconds for a timestamp that `safeTime` accepts, otherwise -Infinity (sorts last, never newer). */
const timeMs = value => { const at = safeTime(value); return at ? Date.parse(at) : Number.NEGATIVE_INFINITY; };
const lineCount = value => (typeof value === 'string' && value ? value.split(/\r\n|\n|\r/).length - (/(?:\r\n|\n|\r)$/.test(value) ? 1 : 0) : 0);
const shortHash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);

/**
 * Structured metadata for one failing check in an evidence record. No raw
 * output is ever shown: retained output can hold credentials in shapes no
 * screen recognizes. The agent gets the sanitized check name, the status, the
 * exit code and signal, the record's timestamp, line counts per stream and a
 * 12-hex sha256 prefix of the combined output, so two failures with identical
 * output can be told apart from two with different output. To read the output
 * the agent re-runs the check.
 */
export function failureMetadata(check, at = null) {
  const stdout = typeof check?.stdout === 'string' ? check.stdout : '';
  const stderr = typeof check?.stderr === 'string' ? check.stderr : '';
  return {
    check: safeName(check?.id),
    status: FAILURE_STATUSES.has(check?.status) ? check.status : null,
    exit_code: Number.isInteger(check?.exitCode) ? check.exitCode : null,
    signal: SIGNALS.has(check?.signal) ? check.signal : null,
    at: safeTime(at),
    stdout_lines: lineCount(stdout),
    stderr_lines: lineCount(stderr),
    output_sha256: shortHash(JSON.stringify([stdout, stderr])),
  };
}

/** How to see a failing check's output, naming the check only when its sanitized name survived. */
const rerunHint = name => (name === UNNAMED
  ? 'Output is not shown. Re-run `ae verify --plan <plan>` for a listed plan to see it.'
  : `Output is not shown. Run \`ae checks run ${name}\` to see it.`);

/**
 * A finding as shown: never its free-text title (observations are stored
 * unredacted), only structured fields: a 12-hex sha256 prefix of the title,
 * the severity when it is on the allowlist, and the line when it is an integer.
 */
function findingMetadata(finding) {
  return {
    title_sha256: typeof finding.title === 'string' && finding.title.trim() ? shortHash(finding.title.trim()) : null,
    severity: SEVERITIES.has(finding.severity) ? finding.severity : null,
    line: Number.isInteger(finding.line) && finding.line > 0 ? finding.line : null,
  };
}

/**
 * Only a named check (from checks.yaml) whose process failed is failure
 * evidence: a nonzero exit, or a timeout (whether or not output was
 * retained). Harness's built-in gate rows (plan-state, phase-tasks, scope,
 * required-reviews and the rest) carry no process result: they say the work
 * was unfinished, not that something broke. A passing process whose row
 * Harness later marked failed (an artifact or domain manifest refusal) keeps
 * exit 0 and is excluded too. A check killed by a signal, or that could not be
 * spawned, is recorded `unavailable` and never clusters.
 */
const processFailed = check => (check.status === 'failed' && Number.isInteger(check.exitCode) && check.exitCode !== 0)
  || check.status === 'timeout';

const byStrength = (a, b) => b.plan_count - a.plan_count || newestFirst(timeMs(a.last_seen), timeMs(b.last_seen)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Plans are counted by their raw value but shown only through `displayPath`. */
function finishCluster(row) {
  const plans = [...new Set([...row.plans].map(displayPath))].sort();
  return { ...row, plans: plans.slice(0, PLAN_LIST_CAP), plan_count: row.plans.size };
}

/**
 * A failure counts toward a cluster only when it is timestamped after the
 * latest learning-writing consolidation that consumed an episode answering the
 * cluster (`derived_from`), so answering a cluster clears it until the failure
 * recurs, the same day or later.
 */
const unresolved = (resolved, id, at) => !resolved.has(id) || timeMs(at) > Date.parse(resolved.get(id));

/**
 * Failed named `ae verify` checks, grouped by check ID across plans, from the
 * digest-named evidence history Harness writes on every verification.
 */
function evidenceClusters(workspace, resolved, preselect = SCAN_CAP * 2) {
  const history = listRecordNames(workspace, '.harness/evidence/history', HASH_FILE, preselect);
  const read = history.names.map(name => ({ rel: `.harness/evidence/history/${name}`, value: readDigestRecord(workspace, `.harness/evidence/history/${name}`, name) })).filter(record => record.value);
  const { records, omitted } = newestRecords(read, record => record.value.verifiedAt, history.omitted);
  const clusters = new Map();
  for (const { rel, value } of records) {
    if (typeof value.plan !== 'string' || !value.plan || !Array.isArray(value.checks)) continue;
    const at = safeTime(value.verifiedAt);
    for (const check of value.checks) {
      if (!check || typeof check.id !== 'string' || !check.id || !processFailed(check)) continue;
      const checkId = inertLine(check.id).slice(0, 200);
      const key = `check:${checkId}`;
      if (!unresolved(resolved, failureClusterId(key), at)) continue;
      const name = safeName(check.id);
      const row = clusters.get(key) || { id: failureClusterId(key), source: 'evidence', check: name, plans: new Set(), failures: 0, first_seen: null, last_seen: null, failure_records: [], hint: rerunHint(name), evidence: new Map() };
      row.plans.add(value.plan);
      row.failures += 1;
      if (at && (!row.first_seen || timeMs(at) < timeMs(row.first_seen))) row.first_seen = at;
      if (at && (!row.last_seen || timeMs(at) >= timeMs(row.last_seen))) row.last_seen = at;
      row.failure_records.push(failureMetadata(check, at));
      if (!row.evidence.has(rel)) row.evidence.set(rel, timeMs(at));
      clusters.set(key, row);
    }
  }
  // Newest failing records and evidence records first, each capped with an omission count: metadata only, never output.
  const rows = [...clusters.values()].map(row => {
    const records = row.failure_records.toSorted((a, b) => newestFirst(timeMs(a.at), timeMs(b.at)));
    const evidence = [...row.evidence].sort((a, b) => newestFirst(a[1], b[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([rel]) => rel);
    return {
      ...row,
      failure_records: records.slice(0, PLAN_LIST_CAP),
      evidence: evidence.slice(0, REF_LIST_CAP),
      evidence_count: evidence.length,
      omitted: { failure_records: Math.max(0, records.length - PLAN_LIST_CAP), evidence: Math.max(0, evidence.length - REF_LIST_CAP) },
    };
  });
  return { clusters: rows, omitted, truncated: history.truncated };
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
    // The key (and so the cluster ID) keeps the recorded command; only the allowlisted word is shown.
    const key = `command:${inertLine(run.command).slice(0, 80)}`;
    const at = safeTime(run.finishedAt) || safeTime(run.startedAt) || null;
    if (!unresolved(resolved, failureClusterId(key), at)) continue;
    const row = clusters.get(key) || { id: failureClusterId(key), source: 'run-journal', command: safeCommand(run.command), plans: new Set(), failures: 0, first_seen: null, last_seen: null };
    row.plans.add(run.plan);
    row.failures += 1;
    if (at && (!row.first_seen || timeMs(at) < timeMs(row.first_seen))) row.first_seen = at;
    if (at && (!row.last_seen || timeMs(at) > timeMs(row.last_seen))) row.last_seen = at;
    clusters.set(key, row);
  }
  return { clusters: [...clusters.values()], truncated: journal.truncated };
}

/** Recurring review findings grouped by perspective (the finding category) and file across plans. */
function findingClusters(workspace) {
  const { names, omitted, truncated } = listRecordNames(workspace, '.harness/reviews/observations', HASH_FILE, SCAN_CAP);
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
        const key = `${inertLine(result.reviewer).slice(0, 80)}\0${file}`;
        const row = clusters.get(key) || { id: findingClusterId(key), category: safeName(result.reviewer), file: safePath(file) ?? UNNAMED, plans: new Set(), findings: 0, samples: [] };
        row.plans.add(plan);
        row.findings += 1;
        const sample = findingMetadata(finding);
        if (row.samples.length < FINDING_SAMPLE_CAP && !row.samples.some(seen => JSON.stringify(seen) === JSON.stringify(sample))) row.samples.push(sample);
        clusters.set(key, row);
      }
    }
  }
  return { clusters: [...clusters.values()], omitted, truncated };
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
  const latest = record => record.entries.reduce((max, entry) => (timeMs(entry?.lastExposedAt) > timeMs(max) ? safeTime(entry.lastExposedAt) : max), null);
  const index = new Map();
  const kept = newestRecords(valid, latest, listed.omitted);
  for (const record of kept.records) {
    for (const entry of record.entries) {
      if (typeof entry?.id !== 'string') continue;
      const row = index.get(entry.id) || { last: null, count: 0, plans: new Set() };
      const at = safeTime(entry.lastExposedAt);
      if (at && (!row.last || timeMs(at) > timeMs(row.last))) row.last = at;
      row.count += Number.isInteger(entry.count) ? entry.count : 0;
      row.plans.add(record.plan);
      index.set(entry.id, row);
    }
  }
  return { index, omitted: kept.omitted, truncated: listed.truncated };
}

/** Exposed learnings whose recorded source bindings no longer match the checkout. */
function staleExposed(workspace, learnings) {
  const { index: exposed, omitted, truncated } = exposureIndex(workspace);
  if (!exposed.size) return { rows: [], omitted, truncated };
  const repository = learnings.some(l => String(l.fm.applicability_version) === String(APPLICABILITY_VERSION)) ? repoId(workspace) : null;
  const cache = new Map(), out = [];
  for (const learning of learnings) {
    const exposure = exposed.get(learning.id);
    if (!exposure) continue;
    const applicability = learningApplicability({ workspace, fm: learning.fm, repository, cache });
    if (applicability.state !== 'needs-review') continue;
    out.push({
      id: safeLearningId(learning.id),
      changed_paths: applicability.bindings.filter(b => ['changed', 'missing', 'excluded'].includes(b.state)).map(b => ({ path: displayPath(b.path), state: b.state })).slice(0, REF_LIST_CAP),
      last_exposed: exposure.last,
      exposures: exposure.count,
      plan_count: exposure.plans.size,
    });
  }
  return { rows: out.sort((a, b) => newestFirst(timeMs(a.last_exposed), timeMs(b.last_exposed)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), omitted, truncated };
}

const CODE_SPAN = /`([^`\n]{1,300})`/g;
const LEARNING_REF = /^([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9._-]*)$/;

const REF_PREFIX = /^(?:origin|upstream|refs|heads|tags|remotes)\//;

function pathLike(token) {
  return token.includes('/') && !/\s/.test(token) && !/[*?{}<>$~:|"'\\@]/.test(token)
    && !token.startsWith('/') && !token.startsWith('-') && !token.startsWith('.harness/') && !REF_PREFIX.test(token)
    && !token.split('/').includes('..') && path.posix.normalize(token).replace(/\/$/, '') === token.replace(/\/$/, '');
}

/**
 * 'present', 'absent', or 'unknown' when the path is unsafe to inspect. The
 * whole path is checked from the workspace root, so no symlinked intermediate
 * directory (including one inside an anchor's base) is followed.
 */
function pathState(workspace, rel) {
  const full = assertNoSymlinkAncestors(workspace, rel.replace(/\/$/, ''));
  if (!full) return 'unknown';
  try { fs.lstatSync(full); return 'present'; } catch { return 'absent'; }
}

/** The workspace root ('') plus each ancestor directory of the learning's anchors and source bindings, relative to the workspace. */
function referenceBases(fm) {
  const bases = new Set(['']);
  const anchors = [...(Array.isArray(fm?.anchors) ? fm.anchors : []), ...(Array.isArray(fm?.source_bindings) ? fm.source_bindings.map(b => b?.path) : [])];
  for (const anchor of anchors) {
    if (typeof anchor !== 'string' || !pathLike(anchor)) continue;
    for (let dir = path.posix.dirname(anchor); dir && dir !== '.'; dir = path.posix.dirname(dir)) bases.add(dir);
  }
  return [...bases];
}

/**
 * A path reference is reported missing only when some base (the root or an
 * anchor's ancestor) holds its first segment as a directory and no base holds
 * the whole path. Prose with slashes (`and/or`, `owner/repo`,
 * `application/json`), package names and Git refs never qualify.
 */
function missingPath(workspace, bases, token) {
  const first = token.split('/')[0];
  let checkable = false;
  for (const base of bases) {
    if (pathState(workspace, base ? path.posix.join(base, token) : token) !== 'absent') return false;
    const firstFull = assertNoSymlinkAncestors(workspace, base ? path.posix.join(base, first) : first);
    try { if (firstFull && fs.lstatSync(firstFull).isDirectory()) checkable = true; } catch { /* absent */ }
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
    const refs = [], seen = new Set();
    const bases = referenceBases(learning.fm);
    for (const [, span] of String(learning.body || '').matchAll(CODE_SPAN)) {
      const token = span.trim();
      if (seen.has(token)) continue;
      seen.add(token);
      const asLearning = token.match(LEARNING_REF);
      if (asLearning && domains.has(asLearning[1]) && !/\.[a-z0-9]{1,8}$/i.test(token)) {
        if (!ids.has(token) && pathState(workspace, token) === 'absent') refs.push({ kind: 'learning', ref: safeLearningId(token) });
        continue;
      }
      if (pathLike(token) && missingPath(workspace, bases, token)) refs.push({ kind: 'path', ref: displayPath(token) });
    }
    if (refs.length) out.push({ id: safeLearningId(learning.id), references: refs.slice(0, REF_LIST_CAP) });
  }
  return out;
}

const plansAtLeast = n => row => row.plans.size >= n;

/**
 * The `recheck` packet section. `reviewRequired` is the Phase 1 feedback list
 * of learnings judged `wrong` in their current version, shared with the
 * feedback section. Each list is capped with an omission count. `preselect`
 * bounds how many evidence-history names (newest by mtime) are opened:
 * status and orient pass `RECHECK_STATUS_PRESELECT`.
 */
export function recheckSummary({ workspace, learnings, allLearnings = learnings, reviewRequired: reviewIds = [], resolved = new Map(), preselect = SCAN_CAP * 2 }) {
  const reviewRequired = reviewIds.map(safeLearningId);
  const evidence = evidenceClusters(workspace, resolved, preselect);
  const journal = journalClusters(workspace, resolved);
  const failures = [...evidence.clusters, ...journal.clusters].filter(plansAtLeast(RECHECK_PLAN_THRESHOLD)).map(finishCluster).sort(byStrength);
  const findings = findingClusters(workspace);
  const findingRows = findings.clusters.filter(plansAtLeast(RECHECK_PLAN_THRESHOLD)).map(finishCluster).sort(byStrength);
  const { rows: stale, omitted: exposureOmitted, truncated: exposureTruncated } = staleExposed(workspace, learnings);
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
      ...(evidence.truncated || findings.truncated || exposureTruncated ? { directories: `only the first ${RECHECK_DIR_ENTRY_CAP} entries of each record directory were read` } : {}),
    },
    max_cluster_plans: failures.filter(row => row.source === 'evidence').reduce((n, row) => Math.max(n, row.plan_count), 0),
  };
}

/** Only with `knowledge.recheck=on`: three stale exposed learnings, or one named-check failure cluster across three plans. */
export function recheckDue(summary) {
  return summary.counts.stale_exposed >= RECHECK_DUE_STALE_EXPOSED || summary.max_cluster_plans >= RECHECK_DUE_CLUSTER_PLANS;
}
