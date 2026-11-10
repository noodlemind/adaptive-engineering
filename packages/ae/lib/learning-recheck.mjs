import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readFileNoFollow, readFileTailNoFollow, assertNoSymlinkAncestors } from './fs-safe.mjs';
import { foldRuns, RUNS_FILE } from './run-journal.mjs';
import { readRecheckConfig, readStoreConfig, repoId, inertLine } from './knowledge/store.mjs';
import { learningApplicability, APPLICABILITY_VERSION } from './knowledge/applicability.mjs';
import { scanSecrets } from './secret-scan.mjs';
import { createRedactor } from './redact.mjs';
import { externalPlansDir, normalizePlanRel } from './project-layout.mjs';
import { loadNamedChecks } from './checks.mjs';
import { CODE_REVIEWERS, DOCUMENT_REVIEWERS, LANGUAGE_REVIEWER_IDS } from './review-preparation.mjs';
import { hasCommand } from './command-names.mjs';

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
/**
 * A finding cluster's ID as listed: its own prefix and a 20-hex digest, so neither the listed ID nor its
 * digest with a `failure-cluster:` prefix fits `FAILURE_CLUSTER_REF`. Finding clusters are informational:
 * no `derived_from` answers one.
 */
export const FINDING_CLUSTER_REF = /^finding-cluster:[a-f0-9]{20}$/;
const SCAN_CAP = 512;
/** Evidence-history preselect for status and orient, which need only counts and `due`; packets read twice `SCAN_CAP`. */
export const RECHECK_STATUS_PRESELECT = 128;
/**
 * At most this many directory entries are read from one record directory; the rest are reported in
 * `omitted.directories`, not opened. Past the cap the scan is a sample in readdir order, not the newest
 * records; history is not pruned here.
 */
export const RECHECK_DIR_ENTRY_CAP = 4096;
const PLAN_LIST_CAP = 5;
const REF_LIST_CAP = 8;
// Structured metadata only: no raw check output, finding title, command line or plan text is ever shown.
// Identity fields read from records (check names, run-journal commands, review perspectives, finding files,
// plans) are shown only when an allowlist outside the record vouches for them: a check the workspace's checks
// configuration declares, a command the `ae` command registry defines (the same check the CLI makes before it
// journals a run), a review perspective Harness defines, or a file that exists in the checkout or the plan store.
// Anything else is shown as a short digest, never escaped or trimmed: what a value looks like never decides
// whether it is shown. The character sets and secret screens below are an extra layer, not the gate. A shown
// name is display text only and is never used as a plain-object key.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const SAFE_COMMAND = /^[a-z][a-z0-9-]{0,31}$/;
const SAFE_LEARNING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Exit codes outside this range are not process exit statuses (POSIX 0-255, negative on some runtimes) and are dropped. */
const EXIT_CODE_MIN = -255, EXIT_CODE_MAX = 255;
const FINDING_LINE_MAX = 10_000_000;
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
const findingClusterId = key => `finding-cluster:${crypto.createHash('sha256').update(`finding-cluster\0${key}`).digest('hex').slice(0, 20)}`;

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

// The safe-set pattern (at most about 200 characters) is checked before this, so both scans stay cheap.
const REDACTOR = createRedactor({ env: {} });
/** No secret pattern from either scanner: `scanSecrets` finds nothing and the shared redactor leaves the value unchanged. */
const noSecret = value => scanSecrets(value).length === 0 && REDACTOR.redactText(value) === value;

/** A relative path that passes the character rules: fits `SAFE_PATH`, has no `..` segment and no secret pattern; otherwise null. */
const safePath = value => (typeof value === 'string' && SAFE_PATH.test(value) && !value.split('/').includes('..') && noSecret(value) ? value : null);

/** A digest stand-in for a value that no allowlist vouches for, so distinct values stay distinct. */
const digestName = (kind, value) => `[${kind}:${shortHash(String(value))}]`;

/** A regular file at `rel` under `root`, reached without following a symlink at any step. */
function existingFile(root, rel) {
  const full = assertNoSymlinkAncestors(root, rel);
  if (!full) return false;
  try { return fs.lstatSync(full).isFile(); } catch { return false; }
}

/** A path in the checkout as shown: unchanged only when it passes the character rules and names an existing regular file in the checkout. */
const checkoutFile = (workspace, value) => {
  const rel = safePath(value);
  return rel && existingFile(workspace, rel) ? rel : null;
};

/** Every review perspective Harness itself defines: code, language and document reviewers. */
const KNOWN_PERSPECTIVES = new Set([...CODE_REVIEWERS, ...LANGUAGE_REVIEWER_IDS, ...DOCUMENT_REVIEWERS]);

/** A finding category (the reviewer perspective) as shown: only a perspective Harness defines, otherwise a digest. */
const perspectiveName = value => (typeof value === 'string' && KNOWN_PERSPECTIVES.has(value) ? value : digestName('reviewer', value));

/**
 * Check IDs the workspace's checks configuration declares, read once per summary and only when a name is
 * shown. An unreadable or invalid configuration vouches for nothing.
 */
function declaredChecks(workspace, home) {
  let ids = null;
  return () => {
    if (ids) return ids;
    ids = new Set();
    try {
      const { checks } = loadNamedChecks(workspace, { home });
      if (checks && typeof checks === 'object') for (const id of Object.keys(checks)) ids.add(id);
    } catch { /* vouches for nothing */ }
    return ids;
  };
}

/** A check name as shown: only a check the configuration declares (and that passes the character rules), otherwise a digest. */
const checkName = (value, declared) => (typeof value === 'string' && declared().has(value) && SAFE_NAME.test(value) && noSecret(value) ? value : digestName('check', value));

/**
 * A path from a learning in the store (a source binding or a body reference) as shown: the safe path, else a
 * 12-hex digest, else `[unnamed]`. Learning text is already shown to agents by recall, and a broken
 * reference names a path that by definition no longer exists, so these are not held to the existence rule
 * that record-derived plans and files are.
 */
const displayPath = value => safePath(value) ?? (typeof value === 'string' && value ? `[unnamed:${shortHash(value)}]` : UNNAMED);

/**
 * A run-journal command as shown: only a command the `ae` registry defines (and that passes the character
 * rules), otherwise a digest. The journal is in the checkout and can be written by anyone, so the word's
 * shape alone vouches for nothing.
 */
const safeCommand = value => (typeof value === 'string' && SAFE_COMMAND.test(value) && hasCommand(value) && noSecret(value) ? value : digestName('command', value));

/** A learning ID as shown: `domain/slug` in the safe set, otherwise a digest. */
const safeLearningId = value => (typeof value === 'string' && SAFE_LEARNING_ID.test(value) && noSecret(value) ? value : `[unnamed:${shortHash(String(value))}]`);

/**
 * A timestamp as shown and compared: an ISO 8601 time that parses, no more
 * than five minutes in the future, rewritten to canonical UTC
 * (`YYYY-MM-DDTHH:MM:SS.sssZ`) so string order is time order. Anything else is null.
 */
const safeTime = value => {
  if (typeof value !== 'string' || !ISO_TIME.test(value) || !realDate(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms > Date.now() + FUTURE_SKEW_MS) return null;
  const iso = new Date(ms).toISOString();
  return CANONICAL_TIME.test(iso) ? iso : null;
};
/**
 * The written date and time components name a real instant: `Date.parse` rolls `2026-02-30` over to
 * March 2 and accepts hour 24, so the components are rebuilt in UTC and must read back unchanged.
 */
function realDate(value) {
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const back = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day
    && back.getUTCHours() === hour && back.getUTCMinutes() === minute && back.getUTCSeconds() === second;
}
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
export function failureMetadata(check, at = null, declared = () => new Set()) {
  const stdout = typeof check?.stdout === 'string' ? check.stdout : '';
  const stderr = typeof check?.stderr === 'string' ? check.stderr : '';
  return {
    check: checkName(check?.id, declared),
    status: FAILURE_STATUSES.has(check?.status) ? check.status : null,
    exit_code: Number.isInteger(check?.exitCode) && check.exitCode >= EXIT_CODE_MIN && check.exitCode <= EXIT_CODE_MAX ? check.exitCode : null,
    signal: SIGNALS.has(check?.signal) ? check.signal : null,
    at: safeTime(at),
    stdout_lines: lineCount(stdout),
    stderr_lines: lineCount(stderr),
    output_sha256: shortHash(JSON.stringify([stdout, stderr])),
  };
}

/** How to see a failing check's output, naming the check only when the checks configuration declares it. */
const rerunHint = (id, declared) => {
  const name = checkName(id, declared);
  return name.startsWith('[')
    ? 'Output is not shown, and this check is not one the workspace\'s checks configuration declares. Run the workspace\'s checks (`ae checks list`, then `ae checks run <name>`) to see current output.'
    : `Output is not shown. Run \`ae checks run ${name}\` to see it.`;
};

/**
 * A finding as shown: never its free-text title (observations are stored
 * unredacted), only structured fields: a 12-hex sha256 prefix of the title,
 * the severity when it is on the allowlist, and the line when it is an integer.
 */
function findingMetadata(finding) {
  return {
    title_sha256: typeof finding.title === 'string' && finding.title.trim() ? shortHash(finding.title.trim()) : null,
    severity: SEVERITIES.has(finding.severity) ? finding.severity : null,
    line: Number.isInteger(finding.line) && finding.line >= 1 && finding.line <= FINDING_LINE_MAX ? finding.line : null,
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

/**
 * A plan as shown: only a plan file that exists. A plan in the checkout is shown by its relative path
 * when that path passes the character rules and names a regular file reached without following a
 * symlink. A plan in the project's external plan store (managed plans and domain child plans) is
 * recorded as an absolute path under the Harness home; it is shown by its file name when that file
 * exists in the store, so the home directory never appears. Anything else is shown only as a digest.
 */
function planReference(value, ctx) {
  if (typeof value !== 'string' || !value) return UNNAMED;
  const digest = `[unnamed:${shortHash(value)}]`;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    const base = path.basename(value), dir = path.dirname(path.resolve(value));
    return /\.(?:md|hplan)$/.test(base) && ctx.planDirs.has(dir) && safePath(base) && existingFile(dir, base) ? base : digest;
  }
  return checkoutFile(ctx.workspace, value) ?? digest;
}

/** The external plan store, as written and canonical, so a recorded plan path matches either form. */
function externalPlanDirs(workspace, home) {
  const dirs = new Set();
  try {
    const dir = path.resolve(externalPlansDir(workspace, { home }));
    dirs.add(dir);
    try { dirs.add(fs.realpathSync.native(dir)); } catch { /* not created yet */ }
  } catch { /* no store */ }
  return dirs;
}

/**
 * A run-journal `--plan` value as `loadPlan` would resolve it, so `./docs/plans/a.md`, `docs/plans/a.md`
 * and the absolute path name one plan. A value that does not resolve is kept as written (shown as a digest).
 */
function journalPlan(value, ctx) {
  if (ctx.journalPlans.has(value)) return ctx.journalPlans.get(value);
  let plan = value;
  try { plan = normalizePlanRel(ctx.workspace, value, { home: ctx.home }) || value; } catch { plan = value; }
  ctx.journalPlans.set(value, plan);
  return plan;
}

/**
 * Plans are counted after they are mapped to what is shown, so `plan_count` matches the distinct plans listed.
 * Named plans are listed before digests, so digests never crowd a named plan out of the capped list.
 */
function shownPlans(row, ctx) {
  const digestLast = plan => (plan.startsWith('[') ? `1${plan}` : `0${plan}`);
  const plans = [...new Set([...row.plans].map(plan => planReference(plan, ctx)))].sort((a, b) => (digestLast(a) < digestLast(b) ? -1 : digestLast(a) > digestLast(b) ? 1 : 0));
  return { plans: plans.slice(0, PLAN_LIST_CAP), plan_count: plans.length };
}

/**
 * A failure counts toward a cluster only when it is timestamped after the
 * latest learning-writing consolidation that consumed an episode answering the
 * cluster (`derived_from`), so answering a cluster clears it until the failure
 * recurs, the same day or later.
 */
const unresolved = (resolved, id, at) => !resolved.has(id) || timeMs(at) > Date.parse(resolved.get(id));

/** First and last seen; a time equal to the current bound keeps it, so both sources compare the same way. */
function widen(row, at) {
  if (!at) return;
  if (!row.first_seen || timeMs(at) < timeMs(row.first_seen)) row.first_seen = at;
  if (!row.last_seen || timeMs(at) > timeMs(row.last_seen)) row.last_seen = at;
}

/**
 * Failed named `ae verify` checks, grouped by check ID across plans, from the
 * digest-named evidence history Harness writes on every verification. The
 * rows hold the recorded values; `evidenceRows` maps them to what is shown.
 */
function evidenceClusters(workspace, resolved, preselect = SCAN_CAP * 2) {
  const history = listRecordNames(workspace, '.harness/evidence/history', HASH_FILE, preselect);
  const read = history.names.map(name => readDigestRecord(workspace, `.harness/evidence/history/${name}`, name)).filter(Boolean);
  const { records, omitted } = newestRecords(read, record => record.verifiedAt, history.omitted);
  const clusters = new Map();
  for (const value of records) {
    if (typeof value.plan !== 'string' || !value.plan || !Array.isArray(value.checks)) continue;
    const at = safeTime(value.verifiedAt);
    for (const check of value.checks) {
      if (!check || typeof check.id !== 'string' || !check.id || !processFailed(check)) continue;
      const checkId = inertLine(check.id).slice(0, 200);
      const key = `check:${checkId}`;
      if (!unresolved(resolved, failureClusterId(key), at)) continue;
      const row = clusters.get(key) || { id: failureClusterId(key), checkId: check.id, plans: new Set(), failures: 0, first_seen: null, last_seen: null, records: [], evidence: new Set() };
      row.plans.add(value.plan);
      row.failures += 1;
      widen(row, at);
      row.records.push({ check, at });
      row.evidence.add(value);
      clusters.set(key, row);
    }
  }
  return { clusters: [...clusters.values()], omitted, truncated: history.truncated };
}

/**
 * Evidence clusters as shown. Newest failing records first, capped with an omission count: metadata only,
 * never output, and no evidence record paths (they hold retained output): `evidence_count` says how many
 * evidence records the cluster was built from.
 */
function evidenceRows(rows, ctx) {
  return rows.map(row => {
    const records = row.records.map(({ check, at }) => failureMetadata(check, at, ctx.declared)).sort((a, b) => newestFirst(timeMs(a.at), timeMs(b.at)));
    return {
      id: row.id, source: 'evidence', check: checkName(row.checkId, ctx.declared), ...shownPlans(row, ctx), failures: row.failures,
      first_seen: row.first_seen, last_seen: row.last_seen, failure_records: records.slice(0, PLAN_LIST_CAP), hint: rerunHint(row.checkId, ctx.declared),
      evidence_count: row.evidence.size,
      omitted: { failure_records: Math.max(0, records.length - PLAN_LIST_CAP) },
    };
  });
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
 * broken check, so these clusters never make consolidation due. Plans are
 * normalized as `loadPlan` resolves them before they are counted.
 */
function journalClusters(workspace, resolved, ctx) {
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
    row.plans.add(journalPlan(run.plan, ctx));
    row.failures += 1;
    widen(row, at);
    clusters.set(key, row);
  }
  return { clusters: [...clusters.values()].map(row => ({ ...row, ...shownPlans(row, ctx) })), truncated: journal.truncated };
}

/** Recurring review findings grouped by perspective (the finding category) and file across plans. */
function findingClusters(workspace, ctx) {
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
        const row = clusters.get(key) || { id: findingClusterId(key), category: perspectiveName(result.reviewer), file: checkoutFile(workspace, file) ?? `[unnamed:${shortHash(file)}]`, plans: new Set(), findings: 0, samples: [] };
        row.plans.add(plan);
        row.findings += 1;
        const sample = findingMetadata(finding);
        if (row.samples.length < FINDING_SAMPLE_CAP && !row.samples.some(seen => JSON.stringify(seen) === JSON.stringify(sample))) row.samples.push(sample);
        clusters.set(key, row);
      }
    }
  }
  return { clusters: [...clusters.values()].map(row => ({ ...row, ...shownPlans(row, ctx) })), omitted, truncated };
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
      row.count += Number.isInteger(entry.count) && entry.count >= 1 ? entry.count : 0;
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

const plansAtLeast = n => row => row.plan_count >= n;

/**
 * The `recheck` packet section. `reviewRequired` is the Phase 1 feedback list
 * of learnings judged `wrong` in their current version, shared with the
 * feedback section. Each list is capped with an omission count. `preselect`
 * bounds how many evidence-history names (newest by mtime) are opened:
 * status and orient pass `RECHECK_STATUS_PRESELECT`.
 *
 * `scope: 'due'` (status and orient) computes only what `recheckDue` reads:
 * stale exposed learnings and named-check evidence clusters. The run journal,
 * review observations, learning bodies and the checks configuration are not
 * opened, and `counts` holds only `stale_exposed`, `review_required` and
 * `failure_clusters` (named-check evidence clusters only).
 */
export function recheckSummary({ workspace, home, learnings, allLearnings = learnings, reviewRequired: reviewIds = [], resolved = new Map(), preselect = SCAN_CAP * 2, scope = 'full' }) {
  const reviewRequired = reviewIds.map(safeLearningId);
  const ctx = { workspace, home, planDirs: externalPlanDirs(workspace, home), declared: declaredChecks(workspace, home), journalPlans: new Map() };
  const evidence = evidenceClusters(workspace, resolved, preselect);
  const { rows: stale, omitted: exposureOmitted, truncated: exposureTruncated } = staleExposed(workspace, learnings);
  const evidenceCounted = evidence.clusters.map(row => ({ ...shownPlans(row, ctx) })).filter(plansAtLeast(RECHECK_PLAN_THRESHOLD));
  const max_cluster_plans = evidenceCounted.reduce((n, row) => Math.max(n, row.plan_count), 0);
  if (scope === 'due') {
    return {
      scope: 'due',
      counts: { stale_exposed: stale.length, review_required: reviewRequired.length, failure_clusters: evidenceCounted.length },
      max_cluster_plans,
    };
  }
  const journal = journalClusters(workspace, resolved, ctx);
  const failures = [...evidenceRows(evidence.clusters, ctx), ...journal.clusters].filter(plansAtLeast(RECHECK_PLAN_THRESHOLD)).sort(byStrength);
  const findings = findingClusters(workspace, ctx);
  const findingRows = findings.clusters.filter(plansAtLeast(RECHECK_PLAN_THRESHOLD)).sort(byStrength);
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
    max_cluster_plans,
  };
}

/** Only with `knowledge.recheck=on`: three stale exposed learnings, or one named-check failure cluster across three plans. */
export function recheckDue(summary) {
  return summary.counts.stale_exposed >= RECHECK_DUE_STALE_EXPOSED || summary.max_cluster_plans >= RECHECK_DUE_CLUSTER_PLANS;
}
