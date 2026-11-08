import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { positionalsOf } from './positionals.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import fs from 'node:fs';
import { eventPath } from './events.mjs';
import { RUN_STATUSES, readRuns, readJournal, foldRuns } from './run-journal.mjs';
import { inertLine } from './knowledge/store.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export const RUN_VERBS = Object.freeze(['list', 'show', 'tree', 'resume']);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

function notFoundError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_NOT_FOUND', exit: EXIT.notFound, hint });
}

/** Command-specific value flags, read straight from argv for the same reason
 * `--match` and `--scope` are: parseFlags is shared by every command. */
function readValueFlag(argv, name) {
  const boundary = argv.indexOf('--');
  const scan = boundary === -1 ? argv : argv.slice(0, boundary);
  const eq = scan.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1) || null;
  const i = scan.indexOf(name);
  if (i === -1) return null;
  const next = scan[i + 1];
  return next === undefined || next.startsWith('--') ? null : next;
}

/** Flags on this entry that take a value. A BOOLEAN flag before the verb —
 * `ae run --json show <id>` — must not swallow the next token, which is
 * what a blanket "skip the following word" rule did (P2-12). */
function context(argv) {
  const flags = parseFlags(argv);
  const positionals = positionalsOf(argv, { limit: 2 });
  return {
    flags,
    verb: positionals[0] ?? 'list',
    id: positionals[1] ?? null,
    workspace: path.resolve(flags.workspace),
    filters: {
      status: readValueFlag(argv, '--status'),
      command: readValueFlag(argv, '--command'),
      host: readValueFlag(argv, '--host'),
      plan: readValueFlag(argv, '--plan'),
      since: readValueFlag(argv, '--since'),
      until: readValueFlag(argv, '--until'),
    },
  };
}

export function resolveRunId(runs, id) {
  if (!id) throw usageError('run requires a run id', 'ae run show <run-id> — see `ae run list`');
  const exact = runs.find((r) => r.run === id);
  if (exact) return exact;
  const matches = runs.filter((r) => r.run.startsWith(id));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw usageError(
      `run id ${JSON.stringify(id)} is ambiguous (${matches.length} runs match)`,
      `matching: ${matches.slice(0, 5).map((r) => r.run).join(', ')}${matches.length > 5 ? ' …' : ''}`,
    );
  }
  throw notFoundError(`no run matching ${JSON.stringify(id)}`, 'ae run list');
}

/** The events belonging to one run. The run id is on every event the invocation
 * produced, so this is a filter rather than a reconstruction. */
function eventsForRun(workspace, runId) {
    const file = eventPath(workspace);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((e) => e && e.run === runId);
}

const STATUS_STATE = {
  succeeded: 'ok',
  running: 'warn',
  failed: 'error',
  inconclusive: 'warn',
  blocked: 'warn',
  cancelled: 'warn',
  'timed-out': 'error',
};

export function resumePlanFor(run, { sideEffect = 'execute' } = {}) {
  if (!run) return { resumable: false, reason: 'no such run' };
  if (run.status === 'running') {
    return {
      resumable: false,
      boundary: null,
      reason: run.live
        ? 'this run is still going — its process is alive'
        : 'this run never recorded an outcome, so where it stopped is unknown',
      guidance: run.live
        ? 'wait for it to finish, or interrupt it and inspect the workspace'
        : 'inspect the workspace, then re-run the command yourself if its effects are safe to repeat',
    };
  }
  if (sideEffect !== 'read') {
    return {
      resumable: false,
      boundary: null,
      reason: `${run.command} is ${sideEffect === 'execute' ? 'an' : 'a'} ${sideEffect}-class command, so re-running it is not a safe boundary`,
      guidance: `re-run it deliberately if that is what you want: ae ${run.command} ${(run.argv || []).join(' ')}`.trim(),
    };
  }
  return {
    resumable: true,
    boundary: 'command-start',
    reason: `${run.command} only reads, so running it again cannot change anything`,
    argv: [run.command, ...(run.argv || [])],
  };
}

export function runRequireArgs(rest) {
    const positionals = positionalsOf(rest);
  const verb = positionals[0] ?? 'list';
  if (!RUN_VERBS.includes(verb)) return `unknown run verb: ${verb}`;
  if (['show', 'tree', 'resume'].includes(verb)) {
    if (positionals.length < 2) return `run ${verb} requires a run id`;
  }
    return undefined;
}

export async function runResultOf(argv, ctx = {}) {
  const { verb, id, workspace, filters } = context(argv);
  if (!RUN_VERBS.includes(verb)) {
    throw usageError(`unknown run verb: ${verb}`, `one of ${RUN_VERBS.join(', ')}`);
  }
  if (filters.status && !RUN_STATUSES.includes(filters.status)) {
    throw usageError(`unknown run status: ${filters.status}`, `one of ${RUN_STATUSES.join(', ')}`);
  }
    for (const [name, value] of [['--since', filters.since], ['--until', filters.until]]) {
    if (!value) continue;
    const at = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
    if (!Number.isFinite(at)) throw usageError(`${name} is not a date: ${JSON.stringify(value)}`);
  }

  const all = readRuns(workspace, verb === 'list' ? filters : {});

  if (verb === 'list') {
    const rawLimit = readValueFlag(argv, '--limit');
    const parsedLimit = rawLimit === null ? NaN : Number(rawLimit);
    if (rawLimit !== null && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      throw usageError(`--limit must be a positive integer (got ${JSON.stringify(rawLimit)})`);
    }
    const limit = Number.isInteger(parsedLimit) ? parsedLimit : 20;
    return {
      schema: 1,
      verb,
      total: all.length,
      filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
      runs: all.slice(0, Math.max(1, limit)),
    };
  }

  const run = resolveRunId(all, id);

  if (verb === 'show') {
    return { schema: 1, verb, run, events: eventsForRun(workspace, run.run) };
  }

  if (verb === 'tree') {
    const events = eventsForRun(workspace, run.run);
    return {
      schema: 1,
      verb,
      run,
            lifecycle: events.filter((e) => e.type === 'command.start' || e.type === 'command.result'),
      caused: events.filter((e) => e.type !== 'command.start' && e.type !== 'command.result'),
    };
  }

    const { getCommand: lookup } = await import('./registry.mjs');
  const entry = run.command ? lookup(run.command) : null;
    const invokedVerb = positionalsOf(run.argv || [])[0];
  const verbEntry = entry?.verbs?.find((v) => v.verb === invokedVerb);
  const sideEffect = verbEntry?.sideEffect
    ?? (invokedVerb ? entry?.sideEffect : entry?.bareSideEffect ?? entry?.sideEffect)
    ?? 'execute';
  const plan = resumePlanFor(run, { sideEffect });
  return { schema: 1, verb, run, status: plan.resumable ? 'ok' : 'blocked', resume: plan };
}

function renderList(result) {
  const keyWidth = keyWidthFor(['runs', ...result.runs.map((r) => r.run)]);
  const filters = Object.entries(result.filters).map(([k, v]) => `${k}=${v}`).join(' · ');
  console.log(ui.line({ key: 'runs', value: `${result.runs.length} of ${result.total}`, note: filters || undefined, keyWidth }));
  for (const r of result.runs) {
    console.log(ui.line({
      state: STATUS_STATE[r.status] || 'warn',
      key: r.run,
      value: inertLine(`${r.command || '(unknown)'} · ${r.status}`),
            note: inertLine([r.startedAt, r.status === 'running' && !r.live ? 'no outcome recorded' : null, r.plan].filter(Boolean).join(' · ')),
      keyWidth,
    }));
  }
  if (!result.runs.length) console.log(ui.paint('muted', '  no runs recorded yet'));
}

function renderRunHeader(run) {
  const keyWidth = keyWidthFor(['run', 'command', 'started', 'status']);
  console.log(ui.line({ state: STATUS_STATE[run.status] || 'warn', key: 'run', value: run.run, note: run.status, keyWidth }));
    console.log(ui.line({ key: 'command', value: inertLine([run.command, ...(run.argv || [])].filter(Boolean).join(' ')), keyWidth }));
  console.log(ui.line({ key: 'started', value: run.startedAt || '(unknown)', note: run.finishedAt ? `finished ${run.finishedAt}` : undefined, keyWidth }));
  if (run.status === 'running') {
    console.log(ui.line({ state: run.live ? 'warn' : 'error', key: 'process', value: run.live ? `alive (pid ${run.pid})` : `gone (pid ${run.pid}) — no outcome was recorded`, keyWidth }));
  }
  return keyWidth;
}

export async function cmdRun(argv, ctx = {}) {
  const { flags } = context(argv);
  const result = await runResultOf(argv, ctx);

  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
  } else if (result.verb === 'list') {
    renderList(result);
  } else if (result.verb === 'show') {
    const keyWidth = renderRunHeader(result.run);
    console.log(ui.line({ key: 'events', value: `${result.events.length}`, keyWidth }));
    for (const e of result.events) {
      console.log(ui.paint('muted', inertLine(`  ${e.ts}  ${e.type}${e.status ? ` · ${e.status}` : ''}`)));
    }
  } else if (result.verb === 'tree') {
    renderRunHeader(result.run);
    console.log(ui.paint('muted', `  caused ${result.caused.length} recorded action(s)`));
    for (const e of result.caused) {
      const what = e.exec ? [e.exec.check, ...(e.exec.argv || [])].filter(Boolean).join(' ') : e.type;
      console.log(ui.paint('muted', inertLine(`  └─ ${e.type}  ${what}${e.status ? ` · ${e.status}` : ''}`)));
    }
  } else {
    const keyWidth = renderRunHeader(result.run);
    console.log(ui.line({
      state: result.resume.resumable ? 'ok' : 'warn',
      key: 'resume',
      value: result.resume.resumable ? `safe from ${result.resume.boundary}` : 'refused',
            note: inertLine(String(result.resume.reason ?? '')),
      keyWidth,
    }));
    if (result.resume.guidance) console.log(ui.paint('muted', `  ${inertLine(String(result.resume.guidance))}`));
    if (result.resume.resumable) console.log(ui.paint('muted', `  ae ${inertLine(result.resume.argv.join(' '))}`));
  }

    if (result.verb === 'resume' && !result.resume.resumable) return EXIT.needsApproval;
  return EXIT.ok;
}

export function runExitFor(result) {
  if (result?.verb === 'resume' && !result.resume?.resumable) return EXIT.needsApproval;
  return EXIT.ok;
}

export { readJournal, foldRuns };
