import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ensureHarnessDir, readSession } from './session.mjs';
import { summarizeUsage } from './token-meter.mjs';
import { createRedactor } from './redact.mjs';
import { currentRunContext } from './run-context.mjs';
import { appendGuarded, pruneJournalFile } from './retention.mjs';
import { retentionDaysFor } from './retention-config.mjs';

export const EVENTS_FILE = 'events.jsonl';
export const EVENTS_DEFAULT_LIMIT = 20;
export const EVENTS_MAX_LIMIT = 200;
/** Terminal statuses an operator asking for failures means to see. `ok` is
 * excluded; everything else that ended badly is included. */
export const FAILURE_STATUSES = new Set(['failed', 'cancelled', 'timed-out']);

export const EVENT_TYPES = new Set([
  'session_start',
  'orient',
  'gate',
  'pre_tool',
  'post_tool',
  'skill_activation',
  'verify',
  'compound',
  'consolidate',
  'remember',
  'learning',
  'knowledge',
  'session_end',
    'init_repo',
  'migrate_layout',
  'recall',
  'validate_plan',
  'index',
    'command.start',
  'command.result',
  'agent_lane',
    'exec',
  'bash',
    'edit',
  'write',
  'undo',
    'trust',
    'agent.turn',
  'context.accounting',
    'journal.pruned',
]);

function shouldSkipEvents(flags = {}) {
  return flags.dryRun || flags.noEvents || process.env.HARNESS_NO_EVENTS === '1';
}

function eventId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function eventResult({ result, exitCode, checks }) {
  if (result) return result;
  if (exitCode === 1) return 'fail';
  if (exitCode === 2) return 'warn';
  if ((checks || []).some((check) => check.severity === 'warn')) return 'warn';
  return 'pass';
}

function safeChecks(checks) {
  return (checks || []).map((check) => ({
    id: check.id,
    pass: Boolean(check.pass),
    severity: check.severity || (check.pass ? 'ok' : 'fail'),
        ...(check.status ? { status: check.status } : {}),
  }));
}

export function eventPath(workspace) {
  return path.join(workspace, '.harness', EVENTS_FILE);
}

export function writeEvent(workspace, flags, payload) {
  if (shouldSkipEvents(flags)) return null;
  if (!EVENT_TYPES.has(payload.type)) return null;
    if (ensureHarnessDir(workspace, false) === null) return null;

  const checks = safeChecks(payload.checks);
  const session = readSession(workspace);
    const ambient = currentRunContext();
  const event = {
    version: 2,
    id: eventId(),
    ts: new Date().toISOString(),
    type: payload.type,
    command: payload.command || payload.type,
    plan: payload.plan || null,
    phase: payload.phase || null,
    result: eventResult({ result: payload.result, exitCode: payload.exitCode, checks }),
    checks,
    session: payload.session || session?.sessionId || null,
    host: payload.host || flags.host || process.env.HARNESS_HOST || 'harness-cli',
    agent: payload.agent || process.env.HARNESS_AGENT || null,
    ...(payload.run ?? ambient.run ? { run: payload.run ?? ambient.run } : {}),
    ...(payload.actor ?? ambient.actor ? { actor: payload.actor ?? ambient.actor } : {}),
  };
  if (payload.blockedReason) event.blockedReason = payload.blockedReason;
  if (payload.usage) event.usage = payload.usage;
  for (const field of [
    'exitCode',
    'tool',
    'mutation',
    'targets',
    'targetResolved',
    'gate',
    'decision',
    'durationMs',
    'success',
    'learnings',
    'learningsBytes',
        'learningLayers',
        'actor',
        'run',
    'execution',
    'flags',
    'status',
    'bytes',
        'exec',
        'file',
    'removed',
    'reason',
    'repeatEvidence',
    'contextAccounting',
    // The trust-change descriptor: which project, and which way it moved.
    'trust',
  ]) {
    if (payload[field] !== undefined) event[field] = payload[field];
  }

    const safeEvent = createRedactor().redactValue(event);
  const file = eventPath(workspace);
  appendGuarded(file, JSON.stringify(safeEvent) + '\n');
    pruneJournalFile(file, {
    retentionDays: retentionDaysFor(workspace, flags),
    markerFor: ({ removed, cutoff }) => ({
      version: 2,
      id: eventId(),
      ts: new Date().toISOString(),
      type: 'journal.pruned',
      command: 'journal.pruned',
      result: 'pass',
      checks: [],
            ...(ambient.run ? { run: ambient.run } : {}),
      ...(ambient.actor ? { actor: ambient.actor } : {}),
      removed,
      reason: `older than ${cutoff}`,
    }),
  });
  return safeEvent;
}

export function readEvents(workspace, options = 20) {
  const config = typeof options === 'number' ? { limit: options } : options || {};
  const file = eventPath(workspace);
  if (!fs.existsSync(file)) return [];
  const events = fs
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
  const filtered = events.filter((event) => {
    if (config.session && event.session !== config.session) return false;
    if (config.failures
      && event.result !== 'fail'
      && event.decision !== 'block'
      && !event.blockedReason
      && !FAILURE_STATUSES.has(event.status)) return false;
    return true;
  });
    const requested = Number.isFinite(config.limit) && config.limit > 0 ? config.limit : EVENTS_DEFAULT_LIMIT;
  const cap = Math.min(requested, EVENTS_MAX_LIMIT);
  const result = filtered.slice(-cap);
  result.totalMatched = filtered.length;
  return result;
}

export function summarizeEvents(events) {
  const summary = {
    total: events.length,
    pass: 0,
    warn: 0,
    fail: 0,
    lastActivePlan: null,
    latestBlockedReason: null,
    usage: summarizeUsage(events),
  };
  for (const event of events) {
    if (event.result === 'pass') summary.pass++;
    else if (event.result === 'warn') summary.warn++;
    else if (event.result === 'fail') summary.fail++;
    if (event.plan) summary.lastActivePlan = event.plan;
    if (event.blockedReason) summary.latestBlockedReason = event.blockedReason;
  }
  return summary;
}
