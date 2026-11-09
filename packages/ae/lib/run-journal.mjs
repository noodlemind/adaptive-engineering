import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureHarnessDir } from './session.mjs';
import { assertNoSymlinkAncestors } from './fs-safe.mjs';
import { createRedactor } from './redact.mjs';
import { appendGuarded, pruneJournalFile } from './retention.mjs';
import { retentionDaysFor } from './retention-config.mjs';
import { EXIT } from './style.mjs';

export const RUNS_FILE = 'runs.jsonl';
export const RUN_SCHEMA = 1;

/** The terminal statuses a run may end in, plus the one non-terminal state.
 * Pinned by test/run-journal.test.mjs. */
export const RUN_STATUSES = Object.freeze([
  'running',
  'succeeded',
  'failed',
  'inconclusive',
  'blocked',
  'cancelled',
  'timed-out',
]);

export const TERMINAL_RUN_STATUSES = Object.freeze(RUN_STATUSES.filter((s) => s !== 'running'));

export function runStatusFromReported(status) {
  if (status === 'ok') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'timed-out') return 'timed-out';
  return null;
}

export function runStatusForExit(code, { cancelled = false, timedOut = false } = {}) {
  if (cancelled) return 'cancelled';
  if (timedOut) return 'timed-out';
  if (code === EXIT.ok) return 'succeeded';
  if (code === EXIT.cancelled) return 'cancelled';
  if (code === EXIT.timedOut) return 'timed-out';
  if (code === EXIT.needsApproval) return 'blocked';
  if (code === EXIT.usage) return 'inconclusive';
  return 'failed';
}

export function runsPath(workspace) {
  return path.join(workspace, '.harness', RUNS_FILE);
}

export function newRunId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

function append(workspace, record, flags = {}) {
  if (ensureHarnessDir(workspace, false) === null) return null;
    if (!assertNoSymlinkAncestors(path.resolve(workspace), path.join('.harness', RUNS_FILE))) {
    return null;
  }
    const safe = createRedactor().redactValue(record);
  const file = runsPath(workspace);
  ensureNewlineTerminated(file);
  appendGuarded(file, `${JSON.stringify(safe)}\n`);
    pruneJournalFile(file, {
    retentionDays: retentionDaysFor(workspace, flags),
    markerFor: ({ removed, cutoff }) => ({
      schema: RUN_SCHEMA,
      type: 'journal.pruned',
      ts: new Date().toISOString(),
      removed,
      reason: `older than ${cutoff}`,
    }),
  });
  return safe;
}

export function startRun(workspace, { run, command, argv = [], plan = null, host = null, actor = null, pid = process.pid, harnessVersion = null, ts = new Date().toISOString(), flags = {} }) {
  return append(workspace, {
    schema: RUN_SCHEMA,
    type: 'run.start',
    run,
    ts,
    command,
    argv,
    plan,
    host,
    actor,
    execution: { pid, harnessVersion },
  }, flags);
}

export function finishRun(workspace, { run, status, exitCode = null, durationMs = null, plan = null, ts = new Date().toISOString(), flags = {} }) {
  if (!TERMINAL_RUN_STATUSES.includes(status)) {
    throw new TypeError(`finishRun: status must be one of ${TERMINAL_RUN_STATUSES.join(', ')} (got ${JSON.stringify(status)})`);
  }
  return append(workspace, {
    schema: RUN_SCHEMA,
    type: 'run.result',
    run,
    ts,
    status,
    exitCode,
    durationMs,
    ...(plan ? { plan } : {}),
  }, flags);
}

function ensureNewlineTerminated(file) {
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return;
    const fd = fs.openSync(file, 'r');
    const tail = Buffer.alloc(1);
    fs.readSync(fd, tail, 0, 1, size - 1);
    fs.closeSync(fd);
    if (tail.toString() !== '\n') fs.appendFileSync(file, '\n', 'utf8');
  } catch {
    /* nothing to terminate */
  }
}

/** Note that entries were removed, and why. See the module doc on pruning. */
export function recordPrune(workspace, { removed, reason, ts = new Date().toISOString() }) {
  return append(workspace, { schema: RUN_SCHEMA, type: 'journal.pruned', ts, removed, reason });
}

/** Every raw journal record, in write order. A malformed line is skipped rather
 * than fatal — a torn final write from a crash must not make the whole history
 * unreadable, which is the failure the journal exists to survive. */
export function readJournal(workspace) {
  const file = runsPath(workspace);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Is the process that opened this run still alive? Signal 0 tests existence
 * without delivering anything. EPERM means it exists and is not ours, which is
 * still alive for this purpose. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function foldRuns(records, { isAlive = pidAlive } = {}) {
  const runs = new Map();
  for (const record of records) {
    if (!record?.run) continue;
    if (record.type === 'run.start') {
      const existing = runs.get(record.run);
      if (existing?.startedAt) continue;
      runs.set(record.run, {
        run: record.run,
        command: record.command,
        argv: record.argv || [],
        plan: record.plan ?? null,
        host: record.host ?? null,
        actor: record.actor ?? null,
        pid: record.execution?.pid ?? null,
        harnessVersion: record.execution?.harnessVersion ?? null,
        startedAt: record.ts,
        status: existing?.status ?? 'running',
        exitCode: existing?.exitCode ?? null,
        durationMs: existing?.durationMs ?? null,
        finishedAt: existing?.finishedAt ?? null,
        terminal: existing?.terminal ?? false,
      });
    } else if (record.type === 'run.result') {
      const existing = runs.get(record.run) || { run: record.run, command: null, argv: [], plan: null, host: null, actor: null, pid: null, startedAt: null };
      if (existing.terminal) continue;
      runs.set(record.run, {
        ...existing,
        status: record.status,
        exitCode: record.exitCode ?? null,
        durationMs: record.durationMs ?? null,
        finishedAt: record.ts ?? null,
        terminal: true,
        plan: record.plan ?? existing.plan ?? null,
      });
    }
  }
  return [...runs.values()].map((r) => {
    const known = RUN_STATUSES.includes(r.status);
    return {
      ...r,
      status: known ? r.status : 'running',
      ...(known ? {} : { corrupt: `unrecognized status ${JSON.stringify(r.status)}` }),
      live: (known ? r.status : 'running') === 'running' ? isAlive(r.pid) : false,
    };
  });
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function queryRuns(runs, { status = null, command = null, host = null, plan = null, since = null, until = null } = {}) {
  const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
    const bound = (value, endOfDay) => {
    if (!value) return null;
    const text = DATE_ONLY.test(value)
      ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
      : value;
    const at = Date.parse(text);
    if (!Number.isFinite(at)) {
      throw Object.assign(new Error(`not a date: ${JSON.stringify(value)}`), { code: 'E_USAGE', exit: 2 });
    }
    return at;
  };
  const from = bound(since, false);
  const to = bound(until, true);

  return runs.filter((run) => {
    if (status && lower(run.status) !== lower(status)) return false;
    if (command && lower(run.command) !== lower(command)) return false;
    if (host && lower(run.host) !== lower(host)) return false;
    if (plan && run.plan !== plan) return false;
    const at = Date.parse(run.startedAt || run.finishedAt || '');
    if (from !== null && (!Number.isFinite(at) || at < from)) return false;
    if (to !== null && (!Number.isFinite(at) || at > to)) return false;
    return true;
  });
}

export function sortRuns(runs) {
  const at = (r) => {
    const parsed = Date.parse(r.startedAt || r.finishedAt || '');
    return Number.isFinite(parsed) ? parsed : -Infinity;
  };
  return [...runs].sort((a, b) => at(b) - at(a) || (a.run < b.run ? -1 : a.run > b.run ? 1 : 0));
}

export function readRuns(workspace, filters = {}, options = {}) {
  return sortRuns(queryRuns(foldRuns(readJournal(workspace), options), filters));
}
