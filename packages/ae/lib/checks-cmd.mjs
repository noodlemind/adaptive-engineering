import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { positionalsOf } from './positionals.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { inertLine } from './knowledge/store.mjs';
import { CHECKS_REL, loadNamedChecks, validateCommand, runNamedCheck, CHECK_TIMEOUT_DEFAULT_SECONDS } from './checks.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { projectAuthorityFile } from './project-authority.mjs';
import { trustStatus, formatTrustRecovery } from './trust.mjs';
import { configureCheckConfiguration, inspectCheckConfiguration } from './check-configuration.mjs';
import { readBoundedInput, readFileNoFollow } from './fs-safe.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export const CHECKS_VERBS = Object.freeze(['list', 'show', 'run', 'configure']);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

function notFoundError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_NOT_FOUND', exit: EXIT.notFound, hint });
}

function readChecks(workspace, options) {
  const { checks, error } = loadNamedChecks(workspace, options);
  if (error) {
        throw notFoundError(error, 'define version: 1 checks in the selected project authority shown by ae init-repo');
  }
  return checks;
}

function describeCheck(name, config) {
  const invalid = validateCommand(name, config);
  return {
    name,
        command: Array.isArray(config?.command) ? [...config.command] : null,
    timeoutSeconds: config?.timeout_seconds ?? CHECK_TIMEOUT_DEFAULT_SECONDS,
    valid: invalid === null,
    invalidReason: invalid,
  };
}

function context(argv) {
  const flags = parseFlags(argv);
    const positionals = positionalsOf(argv, { limit: 2 });
  return {
    flags,
    verb: positionals[0] ?? null,
    name: positionals[1] ?? null,
    workspace: path.resolve(flags.workspace),
    copilotHome: resolveCopilotHome(flags.copilotHome),
  };
}

export async function checksResultOf(argv, ctx = {}) {
  const { verb, name, workspace, copilotHome, flags } = context(argv);
  if (!verb) throw usageError('checks requires a verb', `ae checks <${CHECKS_VERBS.join('|')}>`);
  if (!CHECKS_VERBS.includes(verb)) {
    throw usageError(`unknown checks verb: ${verb}`, `one of ${CHECKS_VERBS.join(', ')}`);
  }
  if (verb === 'configure') {
    if (name || flags.files?.length !== 1) throw usageError('checks configure requires exactly one --file decision and no check-name argument', 'ae checks configure --file - --json');
    const selected = flags.files[0], full = path.resolve(workspace, selected);
    const text = selected === '-' ? readBoundedInput(0, { maxBytes: 1024 * 1024 })
      : readFileNoFollow(full, { root: path.dirname(full), maxBytes: 1024 * 1024 });
    if (text === null) throw usageError('Check configuration decision is missing, redirected, unreadable or exceeds 1 MiB', 'ae checks configure --file - --json');
    let input;
    try { input = JSON.parse(text); } catch { throw usageError('Check configuration decision must be JSON', 'ae checks configure --file - --json'); }
    return configureCheckConfiguration({ workspace, home: flags.harnessHome, copilotHome, input, dryRun: flags.dryRun });
  }
  if (flags.files?.length) throw usageError('--file is only supported for checks configure', 'ae checks configure --file - --json');
  if (verb === 'run' && !name) throw usageError('checks run requires a check name', 'ae checks run <name>');
  const trust = verb === 'run' ? trustStatus({ workspace, copilotHome, home: flags.harnessHome }) : null;
  if (trust && !trust.trusted) {
    throw Object.assign(new Error(`refusing to run ${JSON.stringify(name)}: this project is not trusted`), {
      code: 'E_DENIED',
      exit: EXIT.needsApproval,
      hint: formatTrustRecovery(trust.recovery),
      trust,
    });
  }
  const listed = verb === 'list' ? inspectCheckConfiguration({ workspace, home: flags.harnessHome }) : null;
  const checks = listed ? listed.checks : readChecks(workspace, { home: flags.harnessHome });
  const source = projectAuthorityFile(workspace, 'checks.yaml', { home: flags.harnessHome });
  const configPath = source.mode === 'shared' ? CHECKS_REL : source.path;
  const names = Object.keys(checks).sort();

  if (verb === 'list') {
    return {
      schema: 1,
      verb,
      config: configPath,
      sourceMode: listed.sourceMode,
      sourceDigest: listed.sourceDigest,
      missing: listed.missing,
      checks: names.map((n) => describeCheck(n, checks[n])),
    };
  }

  if (!name) throw usageError(`checks ${verb} requires a check name`, `ae checks ${verb} <name>`);
  if (!(name in checks)) {
    throw notFoundError(`no check named ${JSON.stringify(name)} in ${configPath}`, names.length ? `defined here: ${names.join(', ')}` : 'no checks are defined');
  }

  if (verb === 'show') {
    return { schema: 1, verb, config: configPath, check: describeCheck(name, checks[name]) };
  }

    const outcome = await runNamedCheck(workspace, name, checks[name], { signal: ctx.signal, copilotHome, home: flags.harnessHome, events: ctx.events });
    return { schema: 1, verb, config: configPath, status: statusForOutcome(outcome), check: describeCheck(name, checks[name]), outcome };
}

/** The unified status vocabulary for a check's legacy outcome status. */
function statusForOutcome(outcome) {
  if (outcome?.status === 'passed') return 'ok';
  if (outcome?.status === 'timeout') return 'timed-out';
  return 'failed';
}

export function checksExitFor(result) {
  if (result?.verb !== 'run') return EXIT.ok;
  if (result.outcome?.status === 'passed') return EXIT.ok;
  if (result.outcome?.status === 'timeout') return EXIT.timedOut;
  return 1;
}

const OUTCOME_STATE = { passed: 'ok', failed: 'error', timeout: 'error', unavailable: 'warn' };

export async function cmdChecks(argv, ctx = {}) {
  const { flags } = context(argv);
  const result = await checksResultOf(argv, ctx);

  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
  } else if (result.verb === 'configure') {
    console.log(ui.line({ state: 'ok', key: 'checks', value: result.dryRun ? 'configuration preview' : result.changed ? 'configuration prepared' : 'unchanged', note: result.config }));
    for (const change of result.changes) console.log(ui.line({ key: change.name, value: change.current.command.join(' ') }));
    for (const action of result.nextActions) console.log(ui.paint('muted', `  ${action}`));
  } else if (result.verb === 'list') {
    const keyWidth = keyWidthFor(['checks', ...result.checks.map((c) => c.name)]);
    console.log(ui.line({ key: 'checks', value: `${result.checks.length} defined`, note: result.config, keyWidth }));
    for (const c of result.checks) {
      console.log(ui.line({
        state: c.valid ? 'ok' : 'error',
        key: c.name,
        value: c.command ? c.command.join(' ') : '(no command)',
        note: c.valid ? `${c.timeoutSeconds}s` : c.invalidReason,
        keyWidth,
      }));
    }
  } else {
    const c = result.check;
    const keyWidth = keyWidthFor(['command', 'timeout', 'outcome', 'stdout']);
    console.log(ui.line({ state: c.valid ? 'ok' : 'error', key: 'check', value: c.name, note: c.valid ? undefined : c.invalidReason, keyWidth }));
    console.log(ui.line({ key: 'command', value: (c.command || []).join(' '), keyWidth }));
    console.log(ui.line({ key: 'timeout', value: `${c.timeoutSeconds}s`, keyWidth }));
    if (result.outcome) {
      console.log(ui.line({
        state: OUTCOME_STATE[result.outcome.status] || 'warn',
        key: 'outcome',
        value: result.outcome.status,
        note: result.outcome.message,
        keyWidth,
      }));
            for (const stream of ['stdout', 'stderr']) {
        const text = result.outcome[stream];
        if (text) console.log(`${stream}:\n${String(text).split('\n').map(inertLine).join('\n')}`);
      }
    }
  }

    return checksExitFor(result);
}
