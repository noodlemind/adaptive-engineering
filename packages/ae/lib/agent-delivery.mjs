import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readSession } from './session.mjs';
import { planFromText, loadPlan } from './plan-parse.mjs';
import { parseFlags } from './flags.mjs';
import { resolveDomainContext } from './domain-context.mjs';
import { resolvePlanUpdateFile } from './plan-update.mjs';
import { readFileNoFollow } from './fs-safe.mjs';
import { readEvidence } from './evidence.mjs';
import { READ_SOURCE } from './get-cmd.mjs';
import { harnessControlCommand, normalizeToolPayload, unwrapShellSegments } from '../corpus/hooks/lib/tool-payload.mjs';
import { validateContextSnapshot } from './task-handoff.mjs';

export const DELIVERY_BIN = fileURLToPath(new URL('../bin/ae.mjs', import.meta.url));
const HOOK_ROOT = fileURLToPath(new URL('../corpus/hooks/', import.meta.url));
const COMMANDS = new Set(['orient', 'recall', 'plan-new', 'plan-update', 'gate', 'review', 'verify', 'compound', 'report', 'status', 'trust', 'prepare', 'index', 'graph']);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function inlineDecisionFlag(input) {
  if (input.decision === undefined) return null;
  const offset = ['domain', 'experiment'].includes(input.argv[0]) ? 1 : 0;
  const operation = input.argv[offset];
  const flag = operation === 'compound' ? '--learning-decision' : '--file';
  const checkConfiguration = operation === 'checks' && input.argv[1] === 'configure';
  if ((!checkConfiguration && !(input.argv[0] === 'experiment' ? ['begin', 'resolve'] : ['plan-new', 'plan-update', 'compound', 'review']).includes(operation))
    || operation === 'review' && input.argv[offset + 1] !== 'assemble'
    || input.argv.some(arg => arg === flag || arg.startsWith(`${flag}=`))) {
    throw new Error('decision requires plan-new, plan-update, review assemble, compound, checks configure, experiment begin or experiment resolve without an existing input file');
  }
  return flag;
}

function checkRecoveryInput(input) {
  const [command, verb, ...args] = input.argv;
  if (command !== 'checks' || !['list', 'show', 'configure'].includes(verb)) return false;
  if (verb === 'configure' && input.decision === undefined) return false;
  const flags = new Set(['--json', '--no-events', '--verbose', '-v', ...(verb === 'configure' ? ['--dry-run'] : [])]);
  const seen = new Set();
  let name = null;
  for (const arg of args) {
    if (flags.has(arg)) {
      if (seen.has(arg)) return false;
      seen.add(arg);
    } else if (verb === 'show' && name === null && /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i.test(arg) && arg.length <= 80) name = arg;
    else return false;
  }
  return verb !== 'show' || name !== null;
}

function toolPayload(call, workspace, sessionId) {
  const input = call.input || {};
  const context = { workspace, session_id: sessionId || null };
  if (call.name === 'apply') return { ...context, tool_name: 'MultiEdit', tool_input: { edits: input.changes } };
  if (call.name === 'exec' || call.name === 'bash') {
    const command = call.name === 'exec' ? (input.argv || []).map(quote).join(' ') : input.script;
    return { ...context, tool_name: 'Bash', tool_input: { command } };
  }
  return { ...context, tool_name: call.name === 'write' ? 'Write' : call.name, tool_input: input };
}

function trustMutation(command) {
  return unwrapShellSegments(command || '').some(tokens => {
    const index = tokens.findIndex(token => /^(?:(?:ae|harness)(?:\.mjs|\.cmd|\.exe)?)$/i.test(path.basename(token)));
    return index >= 0 && tokens[index + 1] === 'trust' && tokens[index + 2] !== 'status' && tokens.length > index + 2;
  });
}

function hook(name, payload, { workspace, copilotHome, harnessHome, remainingSeconds } = {}) {
  const result = spawnSync(process.execPath, [path.join(HOOK_ROOT, name)], {
    cwd: workspace, input: JSON.stringify(payload), encoding: 'utf8', maxBuffer: 128 * 1024,
    timeout: Math.max(1, Math.min(10_000, (remainingSeconds ?? 10) * 1000)),
    env: { ...process.env, AE_BIN: DELIVERY_BIN, HARNESS_BIN: DELIVERY_BIN, ...(copilotHome ? { COPILOT_HOME: copilotHome } : {}), ...(harnessHome ? { AE_HOME: harnessHome, HARNESS_HOME: harnessHome } : {}) },
  });
  if (result.error || result.status !== 0) return { pass: false, reason: `Delivery hook ${name} unavailable: ${result.error?.message || result.stderr}` };
  try {
    const value = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    if (value.permissionDecision === 'deny') return { pass: false, reason: value.permissionDecisionReason };
    return value.continue === true ? { pass: true } : { pass: false, reason: `Delivery hook ${name} returned no valid decision` };
  } catch {
    return { pass: false, reason: `Delivery hook ${name} returned no valid decision` };
  }
}

// `ae compound --match-evidence` reads --check-output; under delivery that
// read is confined to the run workspace: an absolute path, or one that
// resolves outside it, is refused. `-` is refused too: a delivered command's
// stdin carries nothing but an inline decision, so it would read nothing.
function checkOutputOutsideWorkspace(argv, workspace) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    const value = arg === '--check-output' ? argv[i + 1] : arg.startsWith('--check-output=') ? arg.slice('--check-output='.length) : null;
    if (value === null || value === undefined) continue;
    if (value === '-' || path.isAbsolute(value)) return true;
    const relative = path.relative(path.resolve(workspace), path.resolve(workspace, value));
    // A segment check, so a name such as `..foo` inside the workspace is kept.
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return true;
  }
  return false;
}

export function beforeDeliveryTool(call, options) {
  if (call.name === 'exec' && (!Array.isArray(call.input?.argv) || !call.input.argv.length || !call.input.argv.every(arg => typeof arg === 'string'))) return { pass: false, reason: 'exec requires a non-empty argv array of strings' };
  if (call.name === 'todo') return { pass: true };
  if (call.name === 'harness') {
    const argv = call.input?.argv;
    if (!Array.isArray(argv) || !argv.length || !argv.every(arg => typeof arg === 'string')) return { pass: false, reason: 'ae requires argv for a supported lifecycle command or exact diagnostic/worklist control' };
    let decisionFlag;
    try { decisionFlag = inlineDecisionFlag(call.input); }
    catch (error) { return { pass: false, reason: error.message }; }
    const effectiveArgv = decisionFlag ? [...argv, decisionFlag, decisionFlag === '--learning-decision' ? '-' : path.join(os.tmpdir(), 'harness-agent-decision-placeholder', 'decision.json')] : argv;
    if (!(COMMANDS.has(argv[0]) || checkRecoveryInput(call.input) || ['todo', 'inventory', 'domain', 'experiment', 'diagrams'].includes(argv[0]) && harnessControlCommand(['harness', ...effectiveArgv], options.workspace) === argv[0])) return { pass: false, reason: 'ae requires argv for a supported lifecycle command or exact diagnostic/worklist control' };
    if (argv[0] === 'trust' && argv[1] && argv[1] !== 'status') return { pass: false, reason: 'Trust approval or revocation requires a person; the agent may read trust status only.' };
    if (argv.some(arg => /^--(?:workspace|copilot-home|ae-home|harness-home|home)(?:=|$)/.test(arg))) return { pass: false, reason: 'Lifecycle commands are bound to this run workspace and homes.' };
    if (argv[0] === 'compound' && checkOutputOutsideWorkspace(argv, options.workspace)) return { pass: false, reason: '--check-output must be a relative path inside the run workspace; save the re-run check output to a file there first.' };
    return { pass: true };
  }
  const payload = toolPayload(call, options.workspace, options.sessionId);
  if (trustMutation(payload.tool_input.command)) return { pass: false, reason: 'Trust approval or revocation requires a person; the agent may read trust status only.' };
  for (const name of ['block-destructive-commands.mjs', 'guard-critical-files.mjs', 'require-plan-gate.mjs']) {
    const checked = hook(name, payload, options);
    if (!checked.pass) return checked;
  }
  const normalized = normalizeToolPayload(payload);
  const productMutation = normalized.mutation && normalized.targets.some(target => {
    const relative = path.relative(options.workspace, path.resolve(options.workspace, target)).replaceAll('\\', '/');
    return !relative.startsWith('.harness/') && !relative.startsWith('docs/plans/');
  });
  if (productMutation) {
    const session = readSession(options.workspace);
    if (!session?.lastOrientReadAt || !session.files?.length) return { pass: false, reason: 'missing-orient-read: call ae orient --read --query <task> --file <each touched file> before product edits.' };
    const current = validateContextSnapshot({ workspace: options.workspace, snapshot: session.contextSnapshot, targets: normalized.targets, home: options.harnessHome });
    if (!current.pass) return current;
  }
  return { pass: true };
}

export function afterDeliveryTool(call, result, options) {
  if (call.name === 'harness') {
    if (options.deliveryState && result.status === 'ok' && result.exitCode === 0) {
      const argv = call.input?.argv || [];
      if (argv[0] === 'domain') {
        const flags = parseFlags(argv);
        if (flags.plan) {
          try {
            const index = argv.findIndex(arg => arg === '--name' || arg.startsWith('--name='));
            const name = argv[index]?.includes('=') ? argv[index].slice(7) : argv[index + 1];
            const context = resolveDomainContext({ workspace: options.workspace, home: options.harnessHome || undefined, name });
            const plan = loadPlan(options.workspace, flags.plan, { domainContext: context });
            if (!plan) return { pass: false, reason: 'The selected domain parent is missing or unsafe.' };
            options.deliveryState.domainPlan = { name, path: plan.path };
          } catch (error) { return { pass: false, reason: error.message }; }
        }
      } else if (['plan-new', 'plan-update', 'gate', 'review', 'verify', 'compound'].includes(argv[0]) || argv[0] === 'experiment' && parseFlags(argv).plan) options.deliveryState.domainPlan = null;
    }
    return { pass: true };
  }
  if (call.name === 'todo') return { pass: true };
  return hook('record-successful-edit.mjs', {
    ...toolPayload(call, options.workspace, options.sessionId),
    ...(call.name === 'read' && result[READ_SOURCE] ? { tool_input: { ...call.input, path: result[READ_SOURCE] } } : {}),
    success: result.status === 'ok' && result.exitCode === 0,
    ...(call.name === 'read' ? { tool_response: { truncated: result.truncated, sha256: result.sha256 } } : {}),
  }, options);
}

/**
 * Stage authored decisions outside product scope; only Harness serializes
 * them. A learning decision goes to the child's stdin as
 * `--learning-decision -`, so no decision file (and no evidence line) is ever
 * written; other inline decisions are staged in an owned temporary file.
 */
export async function runDeliveryCommand(input, run) {
  let directory;
  try {
    const argv = [...input.argv];
    const flag = inlineDecisionFlag(input);
    if (['inventory', 'domain', 'experiment', 'diagrams'].includes(argv[0]) && !argv.includes('--verbose') && !argv.includes('-v')) argv.push('--verbose');
    if (flag === '--learning-decision') {
      argv.push(flag, '-');
      return await run(argv, { input: JSON.stringify(input.decision) });
    }
    if (flag) {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agent-decision-'));
      const file = path.join(directory, 'decision.json');
      fs.writeFileSync(file, JSON.stringify(input.decision), { mode: 0o600 });
      argv.push(flag, file);
    }
    return await run(argv);
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function deliveryCompletion({ workspace, copilotHome, harnessHome, remainingSeconds, domainPlan = null }) {
  try {
    if (domainPlan) {
      const result = spawnSync(process.execPath, [DELIVERY_BIN, 'domain', 'status', '--validate-completion', '--name', domainPlan.name, '--plan', domainPlan.path, '--workspace', workspace,
        ...(copilotHome ? ['--copilot-home', copilotHome] : []), ...(harnessHome ? ['--harness-home', harnessHome] : []), '--json', '--no-events'], { cwd: workspace, encoding: 'utf8', maxBuffer: 256 * 1024, timeout: Math.max(1, Math.min(10_000, (remainingSeconds ?? 10) * 1000)) });
      if (result.error) return { pass: false, message: `Domain completion authority unavailable: ${result.error.message}` };
      if (result.status !== 0) return { pass: false, message: 'Domain completion authority failed; read domain status --validate-completion and repair the reported error.' };
      const value = JSON.parse(result.stdout);
      return value && typeof value.pass === 'boolean' ? value : { pass: false, message: 'Domain completion authority returned no valid decision.' };
    }
    const session = readSession(workspace);
    if (!session?.activePlan) return { pass: false, message: 'Deliver has no current plan. Read ensure-plan and create/start a proportional plan.' };
    const result = spawnSync(process.execPath, [DELIVERY_BIN, 'status', '--validate-completion', '--plan', session.activePlan, '--workspace', workspace,
      ...(copilotHome ? ['--copilot-home', copilotHome] : []), ...(harnessHome ? ['--harness-home', harnessHome] : []), '--json', '--no-events'], {
      cwd: workspace, encoding: 'utf8', maxBuffer: 256 * 1024, timeout: Math.max(1, Math.min(10_000, (remainingSeconds ?? 10) * 1000)),
    });
    if (result.error) return { pass: false, message: `Completion authority unavailable: ${result.error.message}` };
    if (result.status !== 0) return { pass: false, message: 'Completion authority failed; read status --validate-completion and repair the reported error.' };
    const value = JSON.parse(result.stdout);
    if (value?.pass) {
      const full = resolvePlanUpdateFile(workspace, session.activePlan, { home: harnessHome });
      const source = readFileNoFollow(full, { root: path.dirname(full), maxBytes: 1024 * 1024 });
      if (source === null) return { pass: false, message: 'Completion plan is missing, unsafe or unreadable.' };
      const plan = planFromText(source, { path: session.activePlan, fullPath: full });
      const evidence = readEvidence(workspace, session.activePlan);
      if (evidence?.binding?.changedFiles?.length && !plan?.fm.reviews?.required?.includes('code-review')) return { pass: false, message: 'Changed Deliver work requires code-review. Amend the plan review obligations, collect the bound review, then verify and complete again.' };
    }
    return value && typeof value.pass === 'boolean' ? value : { pass: false, message: 'Completion authority returned no valid decision.' };
  } catch (error) {
    return { pass: false, message: `Completion authority unavailable: ${error.message}` };
  }
}
