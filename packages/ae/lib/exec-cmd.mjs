import fs from 'node:fs';
import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson, createRedactor } from './redact.mjs';
import { inertLine } from './knowledge/store.mjs';
import { runProcess } from './runner.mjs';
import { createCheckOutputStreamer } from './verify.mjs';
import { buildChildEnv, resolveExecCwd, resolveShell, resolveTimeoutSeconds } from './exec-policy.mjs';
import { resolveConfig } from './config.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { isProjectTrusted } from './trust.mjs';
import { resolveControls } from './controls.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

const realpath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

export function splitAtBoundary(argv) {
  const i = argv.indexOf('--');
  if (i === -1) return { harnessArgs: argv, childArgs: null };
  return { harnessArgs: argv.slice(0, i), childArgs: argv.slice(i + 1) };
}

function repeatedFlag(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
    else if (a === name && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out.push(argv[i += 1]);
  }
  return out.flatMap((v) => v.split(',').map((s) => s.trim()).filter(Boolean));
}

function singleFlag(argv, name) {
  const occurrences = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (a === name) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw usageError(`${name} requires a value`, `e.g. ${name} <value>`);
      }
      occurrences.push(next);
      i += 1;
    } else if (a.startsWith(`${name}=`)) {
      const value = a.slice(name.length + 1);
      if (value === '') throw usageError(`${name} requires a value`, `e.g. ${name}=<value>`);
      occurrences.push(value);
    }
  }
  if (occurrences.length === 0) return null;
  if (occurrences.length > 1) {
    throw usageError(
      `${name} was given more than once`,
      `values seen: ${occurrences.map((v) => JSON.stringify(v)).join(', ')} — pass it once so there is no question which applies`,
    );
  }
  return occurrences[0];
}

function plan(argv, { shell }) {
  const { harnessArgs, childArgs } = splitAtBoundary(argv);
  const flags = parseFlags(harnessArgs);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const config = resolveConfig({
    copilotHome,
    workspace,
    projectTrusted: isProjectTrusted({ workspace, copilotHome }),
  });

    if (config.errors.length) {
    throw Object.assign(new Error('refusing to execute: the harness configuration has errors'), {
      code: 'E_DENIED',
      exit: EXIT.needsApproval,
      hint: `run \`ae config validate\` — first error: ${config.errors[0]}`,
    });
  }

    if (shell && config.values['exec.bash_enabled'] !== true) {
    throw Object.assign(new Error('bash is disabled by configuration'), {
      code: 'E_DENIED',
      exit: EXIT.needsApproval,
      hint: `set exec.bash_enabled true (currently from ${config.provenance['exec.bash_enabled'].source}), or use \`ae exec\`, which never invokes a shell`,
    });
  }

  if (childArgs === null || childArgs.length === 0) {
    throw usageError(
      shell ? 'bash needs a script to run' : 'exec needs a program to run',
      shell
        ? 'in the ledger: type ! then a command  ·  or: bash -- "ls -la"'
        : 'exec -- <program> [args...]',
    );
  }
    if (shell && childArgs.length !== 1) {
    throw usageError(
      `bash takes exactly one script argument (got ${childArgs.length})`,
      'quote the whole script: ae bash -- "cmd one; cmd two"',
    );
  }

    const rawTimeout = singleFlag(harnessArgs, '--timeout');
  const timeoutSeconds = rawTimeout === null || rawTimeout === ''
    ? config.values['exec.timeout_seconds']
    : resolveTimeoutSeconds(rawTimeout);
  const cwd = resolveExecCwd({ workspace, cwd: singleFlag(harnessArgs, '--cwd'), realpath });
  const envReport = buildChildEnv({
    allow: [...config.values['exec.allow_env'], ...repeatedFlag(harnessArgs, '--allow-env')],
  });

    const resolvedShell = shell ? resolveShell() : null;
  const target = shell ? [...resolvedShell.argv, childArgs[0]] : childArgs;

    const { controls, networkWrapper, degraded } = resolveControls({ networkPolicy: config.values['exec.network'] });
  const argvToRun = [...networkWrapper, ...target];

  return { flags, workspace, cwd, timeoutSeconds, envReport, argvToRun, childArgs, shell, controls, degraded, shellPath: resolvedShell?.shell ?? null };
}

function emitAudit(ctx, mode, p, result) {
  const events = ctx?.events;
  const sink = typeof events?.withCommand === 'function' ? events.withCommand(mode) : events;
  sink?.emit?.(mode, {
    result: result.status === 'ok' ? 'pass' : 'fail',
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    // The invocation descriptor: what ran, where, and under what policy.
    exec: {
      shell: p.shell,
            shellPath: p.shellPath,
      argv: p.childArgs,
      cwd: p.cwd,
      timeoutSeconds: p.timeoutSeconds,
      env: { allowed: p.envReport.allowed, droppedCount: p.envReport.dropped.length, refused: p.envReport.refused },
      signal: result.signal,
      truncated: result.truncated,
            controls: p.controls,
      degraded: p.degraded.map((c) => ({ id: c.id, declared: c.declared, realized: c.realized, reason: c.reason })),
    },
  });
}

async function execute(argv, ctx, { shell, input = null }) {
  const p = plan(argv, { shell });

    if (p.flags.dryRun) {
    return {
      schema: 1,
      mode: p.shell ? 'bash' : 'exec',
      dryRun: true,
      argv: p.childArgs,
      cwd: p.cwd,
      timeoutSeconds: p.timeoutSeconds,
      status: 'ok',
      exitCode: null,
      signal: null,
      durationMs: 0,
      truncated: false,
      env: { allowed: p.envReport.allowed, droppedCount: p.envReport.dropped.length, refused: p.envReport.refused },
      controls: p.controls,
      output: [],
    };
  }
  const { redactText } = createRedactor();
  const rows = [];

    const streamer = createCheckOutputStreamer({
    check: p.shell ? 'bash' : 'exec',
    onEvent: (_event, fields) => rows.push(fields),
    redactText,
  });

  const execution = await runProcess({
    argv: p.argvToRun,
    cwd: p.cwd,
    env: p.envReport.env,
    timeoutMs: p.timeoutSeconds * 1000,
    signal: ctx?.signal,
    onStdout: (chunk) => streamer.onStdout(chunk),
    onStderr: (chunk) => streamer.onStderr(chunk),
    input,
  });
  streamer.flush();

  const result = {
    schema: 1,
    mode: p.shell ? 'bash' : 'exec',
        argv: p.childArgs,
    cwd: p.cwd,
    timeoutSeconds: p.timeoutSeconds,
    status: execution.status,
    exitCode: execution.exitCode,
    signal: execution.signalName,
    durationMs: execution.durationMs,
    truncated: execution.truncated,
        env: { allowed: p.envReport.allowed, droppedCount: p.envReport.dropped.length, refused: p.envReport.refused },
    controls: p.controls,
    output: rows,
  };

  emitAudit(ctx, result.mode, p, result);
  return result;
}

const STATUS_EXIT = { ok: EXIT.ok, cancelled: EXIT.cancelled, 'timed-out': EXIT.timedOut };

function render(result, flags) {
  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
    return;
  }
  const keyWidth = keyWidthFor(['command', 'cwd', 'env', 'status']);
  const state = result.status === 'ok' ? 'ok' : result.status === 'failed' ? 'error' : 'warn';
  console.log(ui.line({ state, key: result.mode, value: result.argv.join(' '), keyWidth }));
  console.log(ui.line({ key: 'cwd', value: result.cwd, keyWidth }));
  console.log(ui.line({
    key: 'env',
    value: `${result.env.allowed.length} allowed`,
    note: `${result.env.droppedCount} dropped${result.env.refused.length ? ` · ${result.env.refused.length} refused` : ''}`,
    keyWidth,
  }));
    for (const control of result.controls || []) {
    if (control.declared === control.realized) continue;
    console.log(ui.line({
      state: 'warn',
      key: 'control',
      value: `${control.id}: ${control.realized}, not ${control.declared}`,
      note: control.reason,
      keyWidth,
    }));
  }
  for (const row of result.output) {
    if (row.line) console.log(inertLine(row.line));
    else if (row.truncated) console.log(ui.paint('muted', '  …output truncated'));
  }
  console.log(ui.line({
    state,
    key: 'status',
    value: result.status,
    note: result.exitCode === null ? undefined : `exit ${result.exitCode} · ${result.durationMs}ms`,
    keyWidth,
  }));
}

export function exitFor(result) {
  if (result.status in STATUS_EXIT) return STATUS_EXIT[result.status];
    return result.exitCode === null || result.exitCode === 0 ? 1 : result.exitCode;
}

/** `input`, when given, is written to the child's stdin (an inline decision for `--learning-decision -`). */
export async function execResultOf(argv, ctx = {}, { input = null } = {}) {
  return execute(argv, ctx, { shell: false, input });
}

export async function cmdExec(argv, ctx = {}) {
  const result = await execute(argv, ctx, { shell: false });
  render(result, parseFlags(splitAtBoundary(argv).harnessArgs));
    ctx.reportStatus?.(result.status === 'ok' ? 'ok' : result.status);
  return exitFor(result);
}

export async function bashResultOf(argv, ctx = {}) {
  return execute(argv, ctx, { shell: true });
}

export async function cmdBash(argv, ctx = {}) {
  const result = await execute(argv, ctx, { shell: true });
  render(result, parseFlags(splitAtBoundary(argv).harnessArgs));
  ctx.reportStatus?.(result.status === 'ok' ? 'ok' : result.status);
  return exitFor(result);
}
