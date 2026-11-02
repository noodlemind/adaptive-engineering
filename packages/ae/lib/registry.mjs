import path from 'node:path';
import { EXIT } from './style.mjs';
import { normalizeChoices } from './value-sources.mjs';
import {
  cmdOrient,
  computeOrientResult,
  cmdLearnings,
  cmdStatus,
  computeStatusResult,
  statusDomainResult,
  cmdInstallOrUpgrade,
  cmdDoctor,
  cmdInitRepo,
  cmdMigrate,
  cmdIndex,
  cmdGate,
  cmdVerify,
  cmdValidatePlan,
  cmdCompound,
  cmdRecall,
  cmdGet,
  cmdEvents,
  cmdReport,
  cmdKnowledge,
  cmdConsolidate,
  cmdRemember,
  cmdCorrect,
  cmdLearning,
  cmdEvalKnowledge,
  cmdUninstall,
  cmdResolve,
} from './commands.mjs';
import { cmdPlanNew } from './plan-new.mjs';
import { cmdPlanUpdate } from './plan-update.mjs';
import { cmdWorktree } from './worktree-cmd.mjs';
import { cmdPrepare } from './prepare.mjs';
import { cmdRoute } from './route.mjs';
import { cmdLookup, lookupResultOf } from './retrieval/lookup-cmd.mjs';
import { recallResultOf, getResultOf } from './retrieval/compat-results.mjs';
import { cmdChecks, checksResultOf, checksExitFor, CHECKS_VERBS } from './checks-cmd.mjs';
import { cmdConfig, configResultOf, configExitFor, CONFIG_VERBS } from './config-cmd.mjs';
import { cmdTrust, trustResultOf, TRUST_VERBS } from './trust-cmd.mjs';
import { cmdRun, runResultOf, runExitFor, runRequireArgs, RUN_VERBS } from './run-cmd.mjs';
import { cmdResources, resourcesResultOf, resourcesExitFor, RESOURCES_VERBS } from './resources-cmd.mjs';
import { cmdReview, reviewResultOf, REVIEW_VERBS } from './review.mjs';
import { CONFIG_KEYS, SCOPES } from './config.mjs';
import { RUN_STATUSES } from './run-journal.mjs';
import { cmdExec, execResultOf, cmdBash, bashResultOf, exitFor as execExitFor } from './exec-cmd.mjs';
import {
  cmdEdit, editResultOf, cmdWrite, writeResultOf, cmdUndo, undoResultOf,
  exitFor as editExitFor, literalFlag,
} from './edit-cmd.mjs';
import { cmdTodo, todoResultOf, todoExitFor, TODO_VERBS } from './todo-cmd.mjs';
import { cmdApply, applyResultOf, applyExitFor } from './apply-cmd.mjs';
import { cmdAgent, agentResultOf, agentExitFor, agentJournalArgv, taskFromArgv } from './agent-cmd.mjs';
import { DEFAULT_MAX_SECONDS, DEFAULT_MAX_TURNS, DEFAULT_PERSONA, DEFAULT_PROFILE_ID } from './agent-loop.mjs';
import { DEFAULT_PROVIDER, PROVIDERS } from './provider.mjs';
import { GET_DEFAULT_LINES, GET_DEFAULT_MAX_BYTES } from './get-cmd.mjs';
import {
  cmdSearch,
  searchResultOf,
  cmdTree,
  treeResultOf,
  SEARCH_MATCH_MODES,
  SEARCH_SOURCE_NAMES,
  TREE_SUBJECT_NAMES,
} from './retrieval/search-cmd.mjs';
import { LOOKUP_KINDS, LOOKUP_KIND_SUMMARIES } from './retrieval/lookup.mjs';
import { parseFlags, hasFlag } from './flags.mjs';
import { parseQueryFromArgv } from './argv.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { createEnvelope, createErrorEnvelope, STATUS } from './envelope.mjs';
import { renderAgentLane, recordAgentLaneBytes } from './agent-lane.mjs';
import { EVENT_TYPE, summarizeArgFlags } from './event-registry.mjs';
import { createRedactor, redactedJson } from './redact.mjs';
import { cmdModel, modelResultOf, MODEL_VERBS } from './model-cmd.mjs';
import { cmdInspect, inspectResultOf, inspectExitFor, INSPECT_VERBS } from './inspect-cmd.mjs';
import { cmdDomain, domainResultOf, parseDomainArguments, DOMAIN_VERBS } from './domain-cmd.mjs';
import { cmdExperiment, experimentResultOf, parseExperimentArguments, EXPERIMENT_VERBS } from './experiment-cmd.mjs';
import { cmdInventory, inventoryResultOf, INVENTORY_VERBS } from './inventory-cmd.mjs';
import { cmdPerformance, performanceResultOf, PERFORMANCE_VERBS } from './performance-cmd.mjs';
import { cmdGraph, graphResultOf, parseGraphArguments, GRAPH_OPERATIONS } from './graph-cmd.mjs';
import { prepareGraph } from './graph.mjs';
import { cmdFlows, flowsResultOf, FLOW_VERBS } from './flow-model-cmd.mjs';
import { cmdDiagrams, diagramsResultOf, DIAGRAM_VERBS } from './diagram-cmd.mjs';
import { cmdHost, hostResultOf, HOST_VERBS } from './hosts/command.mjs';
import { cmdMcp } from './hosts/mcp-server.mjs';

const REGISTRY = new Map();

export const GLOBAL_FLAGS = [
  { name: '--json', type: 'boolean', description: 'JSON output for machine readers', required: false, default: false, tui: 'cli-only' },
  { name: '--dry-run', type: 'boolean', description: 'print actions without writing', required: false, default: false, tui: 'cli-only' },
  {
    name: '--verbose',
    aliases: ['-v'],
    type: 'boolean',
    description: 'full detail: per-file logging, all checks, unclamped hints',
    required: false,
    default: false,
    tui: 'cli-only',
  },
  {
    name: '--no-color',
    type: 'boolean',
    description: 'plain ascii output (also honors NO_COLOR; auto when piped)',
    required: false,
    default: false,
    tui: 'cli-only',
  },
  { name: '--workspace', type: 'string', valueName: 'path', description: 'repo root (default: cwd)', required: false, default: null, tui: 'cli-only' },
  { name: '--copilot-home', type: 'string', valueName: 'path', description: 'override ~/.copilot', required: false, default: null, tui: 'cli-only' },
  { name: '--skills-home', type: 'string', valueName: 'path', description: 'select native skills separately from host configuration', required: false, default: null, tui: 'cli-only' },
  { name: '--ae-home', type: 'string', valueName: 'path', description: 'select the AE state directory for this command', required: false, default: null, tui: 'cli-only' },
  { name: '--harness-home', type: 'string', valueName: 'path', description: 'legacy alias for --ae-home', required: false, default: null, tui: 'cli-only' },
  {
    name: '--no-events',
    type: 'boolean',
    description: 'do not write any local record: .harness/events.jsonl or runs.jsonl',
    required: false,
    default: false,
    tui: 'cli-only',
  },
];

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', hint, exit: EXIT.usage });
}

export const SURFACES = ['cli', 'tui', 'agent'];

export const TUI_DISPOSITIONS = ['verb', 'prompt', 'cli-only'];

export const SIDE_EFFECTS = ['read', 'mutate', 'execute'];

/** Guard the one direction an override must never go. `where` names the
 * override so the error points at the declaration to fix. */
function assertNotAboveEntry(entry, where, value) {
  if (SIDE_EFFECTS.indexOf(value) <= SIDE_EFFECTS.indexOf(entry.sideEffect)) return;
  throw new Error(
    `registerCommand: "${entry.name}" ${where} declares sideEffect "${value}" above the command's own "${entry.sideEffect}" — entry.sideEffect is the maximum across every form`
  );
}

function assertValidVerbs(entry, args) {
  if (entry.verbs === undefined) return;
  if (!Array.isArray(entry.verbs)) {
    throw new Error(`registerCommand: "${entry.name}" verbs must be an array`);
  }
  const positionalNames = new Set(args.positionals.map((p) => p.name));
  const verbSlot = args.positionals[0]?.name;
  const seen = new Set();
  for (const v of entry.verbs) {
    if (!v || typeof v !== 'object' || typeof v.verb !== 'string' || !v.verb) {
      throw new Error(`registerCommand: "${entry.name}" has a verb without a verb name`);
    }
    if (typeof v.summary !== 'string' || !v.summary) {
      throw new Error(`registerCommand: "${entry.name}" verb "${v.verb}" needs a summary`);
    }
    if (seen.has(v.verb)) {
      throw new Error(`registerCommand: "${entry.name}" declares verb "${v.verb}" twice`);
    }
    seen.add(v.verb);
    if (v.sideEffect !== undefined && !SIDE_EFFECTS.includes(v.sideEffect)) {
      throw new Error(`registerCommand: "${entry.name}" verb "${v.verb}" has an invalid sideEffect "${v.sideEffect}"`);
    }
    if (v.sideEffect !== undefined) assertNotAboveEntry(entry, `verb "${v.verb}"`, v.sideEffect);
        for (const name of v.positionals || []) {
      if (!positionalNames.has(name)) {
        throw new Error(`registerCommand: "${entry.name}" verb "${v.verb}" consumes positional "${name}", which it does not declare`);
      }
      if (name === verbSlot) {
        throw new Error(`registerCommand: "${entry.name}" verb "${v.verb}" consumes positional "${name}", which is the verb's own slot`);
      }
    }
  }
}

function assertValidFlagMetadata(entry, args) {
  const declared = new Set();
  for (const def of args.flags) {
    declared.add(def.name);
    for (const alias of def.aliases || []) declared.add(alias);
  }
  const verbNames = new Set((entry.verbs || []).map((v) => v.verb));
  for (const def of args.flags) {
    if (def.tui !== undefined && !TUI_DISPOSITIONS.includes(def.tui)) {
      throw new Error(`registerCommand: "${entry.name}" flag ${def.name} has an invalid tui disposition "${def.tui}" (must be ${TUI_DISPOSITIONS.join(' | ')})`);
    }
    if (def.sideEffect !== undefined && !SIDE_EFFECTS.includes(def.sideEffect)) {
      throw new Error(`registerCommand: "${entry.name}" flag ${def.name} has an invalid sideEffect "${def.sideEffect}"`);
    }
    if (def.sideEffect !== undefined) assertNotAboveEntry(entry, `flag ${def.name}`, def.sideEffect);
        for (const req of def.requires || []) {
      if (!declared.has(req)) {
        throw new Error(`registerCommand: "${entry.name}" flag ${def.name} requires ${req}, which it does not declare`);
      }
    }
    for (const verb of def.verbs || []) {
      if (!verbNames.has(verb)) {
        throw new Error(`registerCommand: "${entry.name}" flag ${def.name} is scoped to verb "${verb}", which it does not declare`);
      }
    }
  }
}

function assertValidEntry(entry, args) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('registerCommand: entry must be an object');
  }
  if (!entry.name || typeof entry.name !== 'string') {
    throw new Error('registerCommand: entry.name (string) is required');
  }
  if (typeof entry.handler !== 'function') {
    throw new Error(`registerCommand: "${entry.name}" needs a handler(argv, ctx) function`);
  }
  if (!SIDE_EFFECTS.includes(entry.sideEffect)) {
    throw new Error(`registerCommand: "${entry.name}" has an invalid sideEffect "${entry.sideEffect}" (must be ${SIDE_EFFECTS.join(' | ')})`);
  }
    if (entry.bareSideEffect !== undefined && !SIDE_EFFECTS.includes(entry.bareSideEffect)) {
    throw new Error(`registerCommand: "${entry.name}" has an invalid bareSideEffect "${entry.bareSideEffect}"`);
  }
  if (entry.bareSideEffect !== undefined) assertNotAboveEntry(entry, 'bareSideEffect', entry.bareSideEffect);
  if (entry.surfaces !== undefined) {
    if (!Array.isArray(entry.surfaces) || entry.surfaces.length === 0) {
      throw new Error(`registerCommand: "${entry.name}" surfaces must be a non-empty array`);
    }
    for (const s of entry.surfaces) {
      if (!SURFACES.includes(s)) {
        throw new Error(`registerCommand: "${entry.name}" has an invalid surface "${s}" (must be ${SURFACES.join(' | ')})`);
      }
    }
  }
  assertValidVerbs(entry, args);
  assertValidFlagMetadata(entry, args);
  assertValidChoices(entry, args);
}

function assertValidChoices(entry, args) {
  for (const def of [...args.flags, ...args.positionals]) {
    normalizeChoices(def.choices, { where: `registerCommand: "${entry.name}" ${def.name}` });
  }
}

/** Register one command entry. Entries are data — see the module doc for the shape. */
export function registerCommand(entry) {
  const args = { flags: [], positionals: [], ...entry.args };
  assertValidEntry(entry, args);
  REGISTRY.set(entry.name, {
    group: 'general',
    capabilities: [],
    outputModes: ['ledger', 'json'],
    surfaces: SURFACES,
    userInvocable: true,
    verbs: [],
    ...entry,
    args,
  });
  return entry.name;
}

export function hasCommand(name) {
  return REGISTRY.has(name);
}

export function getCommand(name) {
  return REGISTRY.get(name) || null;
}

export function listCommands() {
  return [...REGISTRY.keys()];
}

function flagIndex(entry) {
  const index = new Map();
  for (const def of [...GLOBAL_FLAGS, ...entry.args.flags]) {
    index.set(def.name, def);
    for (const alias of def.aliases || []) index.set(alias, def);
  }
  return index;
}

/** `--help` and `-h` before `--` ask for command help. A value consumed by a flag does not. */
export function commandHelpRequested(argv, entry = null) {
  const end = argv.indexOf('--');
  const scan = end === -1 ? argv : argv.slice(0, end);
  const known = entry ? flagIndex(entry) : null;
  for (let i = 0; i < scan.length; i++) {
    const token = scan[i];
    if (token === '--help' || token === '-h') return true;
    if (!known || token === '-' || !token.startsWith('-')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) continue;
    const def = known.get(token);
    if (!def || def.type === 'boolean') continue;
    const next = scan[i + 1];
    if (next !== undefined && (def.valueIsLiteral === true || !next.startsWith('--'))) i++;
  }
  return false;
}

export function validateArgs(entry, argv) {
  const known = flagIndex(entry);
    const present = new Set();
  let selectedVerb = null;
  let sawBareToken = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') break;
    const isFlagShaped = token.startsWith('-') && token !== '-';
    if (!isFlagShaped) {
      if (!sawBareToken) {
        sawBareToken = true;
        if ((entry.verbs || []).some((v) => v.verb === token)) selectedVerb = token;
      }
      continue;
    }
    const eq = token.indexOf('=');
    const flagName = eq === -1 ? token : token.slice(0, eq);
    const def = known.get(flagName);
    if (!def) {
      throw usageError(`unknown flag: ${flagName}`, `ae help ${entry.name}`);
    }
        if (def.type !== 'boolean' || eq === -1) present.add(def.name);
    if (def.type !== 'boolean' && eq === -1) {
      const next = argv[i + 1];
            const nextIsValue = next !== undefined && (def.valueIsLiteral === true || !next.startsWith('--'));
      if (nextIsValue) i++;
    }
  }

    for (const def of entry.args.flags) {
    if (!present.has(def.name)) continue;
    for (const req of def.requires || []) {
      if (!present.has(req)) {
        throw usageError(
          `${def.name} requires ${req}`,
          `ae help ${entry.name}`,
        );
      }
    }
    if (def.verbs && def.verbs.length && selectedVerb && !def.verbs.includes(selectedVerb)) {
      throw usageError(
        `${def.name} does not apply to "${entry.name} ${selectedVerb}"`,
        `ae help ${entry.name}`,
      );
    }
  }
}

export async function dispatch(argv, ctx = {}) {
    const outer = ctx.reportStatus;
  ctx.reportStatus = (status) => {
    ctx.__reportedStatus = status;
    outer?.(status);
  };
  const [name, ...rest] = argv;
  const entry = REGISTRY.get(name);
  if (!entry) {
    throw usageError(`unknown command: ${name}`, 'ae help');
  }
  if (commandHelpRequested(rest, entry)) return EXIT.ok;
  validateArgs(entry, rest);
  const lane = ctx.output;
  assertLaneSupported(entry, lane);
    if (typeof entry.requireArgs === 'function') {
    const message = entry.requireArgs(rest, parseFlags(rest));
    if (message) throw usageError(message);
  }
    ctx.onRunStart?.();
    const instrumented = typeof entry.instrument === 'function' ? entry.instrument(rest) : entry.instrument !== false;
  const events = instrumented && ctx.events && typeof ctx.events.withCommand === 'function' ? ctx.events.withCommand(entry.name) : null;
    if (lane === 'json' || lane === 'agent') {
    return dispatchLane(entry, rest, ctx, lane, events);
  }
  return runHandler(entry, rest, ctx, events);
}

const LANE_DISPLAY_NAMES = { json: 'json-envelope', agent: 'agent', jsonl: 'jsonl' };

function laneBearingCommands() {
  const dispatchLaneCommands = [];
  const jsonlCommands = [];
  for (const candidate of REGISTRY.values()) {
    if (candidate.resultOf) dispatchLaneCommands.push(candidate.name);
    if (candidate.supportsJsonl) jsonlCommands.push(candidate.name);
  }
  const parts = [];
  if (dispatchLaneCommands.length) parts.push(`${dispatchLaneCommands.join(', ')} (--output json-envelope|agent)`);
  if (jsonlCommands.length) parts.push(`${jsonlCommands.join(', ')} (--output jsonl)`);
  return parts.join('; ') || 'none registered';
}

function assertLaneSupported(entry, lane) {
  if (!lane || lane === 'ledger') return;
  let supported = false;
  if (lane === 'json' || lane === 'agent') supported = Boolean(entry.resultOf);
  else if (lane === 'jsonl') supported = entry.supportsJsonl === true;
  if (supported) return;
  throw usageError(
    `command ${entry.name} does not support --output ${LANE_DISPLAY_NAMES[lane] || lane}; lane-bearing commands: ${laneBearingCommands()}`,
    'ae help'
  );
}

function statusForExit(exit) {
  if (exit === EXIT.ok) return STATUS.OK;
  if (exit === EXIT.cancelled) return STATUS.CANCELLED;
  if (exit === EXIT.timedOut) return STATUS.TIMED_OUT;
  return STATUS.FAILED;
}

function legacyResultForStatus(status) {
  if (status === STATUS.OK) return 'pass';
  if (status === STATUS.FAILED) return 'fail';
  return 'warn';
}

function commandResultPayload(status, durationMs, exitCode) {
  return { status, result: legacyResultForStatus(status), durationMs, exitCode };
}

const PENDING_RESULT = 'pending';

async function runHandler(entry, rest, ctx, events) {
  const startedAt = Date.now();
  events?.emit(EVENT_TYPE.COMMAND_START, { flags: summarizeArgFlags(rest, flagIndex(entry)), result: PENDING_RESULT });
  try {
    const exit = await entry.handler(rest, ctx);
        const status = ctx.__reportedStatus ?? statusForExit(exit);
    events?.emit(EVENT_TYPE.COMMAND_RESULT, commandResultPayload(status, Date.now() - startedAt, exit));
    return exit;
  } catch (err) {
    const exit = Number.isInteger(err.exit) ? err.exit : 1;
    events?.emit(EVENT_TYPE.COMMAND_RESULT, commandResultPayload(statusForExit(exit), Date.now() - startedAt, exit));
    throw err;
  }
}

async function dispatchLane(entry, rest, ctx, lane, events) {
  const schema = 1;
  const startedAt = Date.now();
    const redactor = ctx.redactor || createRedactor();
  events?.emit(EVENT_TYPE.COMMAND_START, { flags: summarizeArgFlags(rest, flagIndex(entry)), result: PENDING_RESULT });
  try {
    const result = await entry.resultOf(rest, ctx);
    const envelope = createEnvelope({ command: entry.name, schema, status: STATUS.OK, ...result });
    if (lane === 'agent') {
      const rendered = renderAgentLane(envelope, {
        budgetBytes: entry.agentBudgetBytes,
        redactor,
        inert: ctx.inert,
      });
            process.stdout.write(rendered.text);
      if (events) recordAgentLaneBytes({ writeEvent: (record) => events.emit(record.type, { ...record, result: PENDING_RESULT }) }, entry.name, rendered.bytes);
    } else {
            console.log(redactedJson(envelope, { redactor }));
    }
        const status = envelope.status || STATUS.OK;
        ctx.reportStatus?.(status);
        const exit = typeof entry.exitOf === 'function'
      ? entry.exitOf(result)
      : (status === STATUS.OK ? EXIT.ok : 1);
    events?.emit(EVENT_TYPE.COMMAND_RESULT, commandResultPayload(status, Date.now() - startedAt, exit));
    return exit;
  } catch (err) {
    const exit = Number.isInteger(err.exit) ? err.exit : 1;
    const status = err.code === 'E_CANCELLED' ? STATUS.CANCELLED : err.code === 'E_TIMEOUT' ? STATUS.TIMED_OUT : STATUS.FAILED;
    const errorEnvelope = createErrorEnvelope({
      command: entry.name,
      schema,
      status,
      code: err.code || 'E_UNEXPECTED',
      message: err.message,
      fix: err.hint,
      exit,
    });
    if (lane === 'agent') {
      const rendered = renderAgentLane(errorEnvelope, {
        budgetBytes: entry.agentBudgetBytes,
        redactor,
        inert: ctx.inert,
      });
            process.stdout.write(rendered.text);
      if (events) recordAgentLaneBytes({ writeEvent: (record) => events.emit(record.type, { ...record, result: PENDING_RESULT }) }, entry.name, rendered.bytes);
    } else {
            console.error(redactedJson(errorEnvelope, { redactor }));
    }
    events?.emit(EVENT_TYPE.COMMAND_RESULT, commandResultPayload(status, Date.now() - startedAt, exit));
    return exit;
  }
}

async function orientResultOf(argv) {
  const { result } = await computeOrientResult(argv);
  return result;
}

async function learningsResultOf(argv) {
  const flags = parseFlags(argv);
  const { resolveLearningsView } = await import('./knowledge/listing.mjs');
  const view = resolveLearningsView({
    argv,
    flags,
    workspace: path.resolve(flags.workspace),
    copilotHome: resolveCopilotHome(flags.copilotHome),
    home: flags.harnessHome || flags.home,
    hasFlag,
  });

  if (view.outcome === 'usage') throw usageError(view.message, 'ae learnings --why <id>');
  if (view.outcome === 'not-found') {
    throw Object.assign(new Error(`no learning ${view.id}`), { code: 'E_TARGET', exit: 1 });
  }
  return view.result;
}

async function statusResultOf(argv) {
  const { flags, copilotHome, lock, version } = computeStatusResult(argv);
  return statusDomainResult(flags, copilotHome) || { packageVersion: version, copilotHome, lock };
}

function recallRequireArgs(rest, flags) {
  const query = parseQueryFromArgv(rest, flags);
  if (!query) return 'recall requires a query string, e.g. ae recall "orders timeout"';
}

function agentRequireArgs(rest) {
  if (!taskFromArgv(rest)) return 'agent needs a task, e.g. ae agent "make the failing test pass"';
}

function getRequireArgs(rest, flags) {
  if (!flags.docid && !flags.path && !flags.reference) {
    return 'get requires --docid <id>, --path <relative-path>, or --reference <installed-corpus-path>';
  }
}

function editRequireArgs(rest) {
  if (!literalFlag(rest, '--path')) return 'edit requires --path <relative-path>';
  if (!literalFlag(rest, '--old')) return 'edit requires --old <text>';
  if (literalFlag(rest, '--new') === null) return 'edit requires --new <text>';
}

function writeRequireArgs(rest) {
  if (!literalFlag(rest, '--path')) return 'write requires --path <relative-path>';
  if (literalFlag(rest, '--content') === null) return 'write requires --content <text>';
}

const PLAN_NEW_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function planNewFlagValue(rest, name) {
  let value;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--') break;
    if (rest[i] === name) value = rest[++i];
  }
  return value;
}

function planNewFlagValues(rest, name) {
  const values = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--') break;
    if (rest[i] === name) values.push(rest[++i]);
  }
  return values;
}

function worktreeRequireArgs(rest) {
  const slug = planNewFlagValue(rest, '--slug');
  if (!slug || !PLAN_NEW_SLUG_RE.test(slug)) {
    return 'worktree: --slug is required and must be lowercase-hyphen (a-z0-9-)';
  }
}

function planNewRequireArgs(rest) {
  if (planNewFlagValue(rest, '--file')) return undefined;
  if (planNewFlagValue(rest, '--from')) return undefined;
  const goalValues = planNewFlagValues(rest, '--goal');
  if (goalValues.length) {
    const goal = goalValues.at(-1);
    const acceptance = planNewFlagValues(rest, '--acceptance').filter((value) => typeof value === 'string' && value.trim());
    const constraints = planNewFlagValues(rest, '--constraint').filter((value) => typeof value === 'string' && value.trim());
    if (!goal || !String(goal).trim() || acceptance.length === 0 || constraints.length === 0) {
      return 'plan-new: --goal requires at least one --acceptance and one --constraint';
    }
    return undefined;
  }
  const slug = planNewFlagValue(rest, '--slug');
  if (!slug || !PLAN_NEW_SLUG_RE.test(slug)) {
    return 'plan-new: --slug is required and must be lowercase-hyphen (a-z0-9-)';
  }
  const intent = planNewFlagValue(rest, '--intent');
  if (!intent || !intent.trim()) {
    return 'plan-new: --intent is required';
  }
}

function flagLabel(def) {
  const names = [def.name, ...(def.aliases || [])];
  return def.type === 'boolean' ? names.join(', ') : `${names.join(', ')} <${def.valueName || 'value'}>`;
}

function buildUsage(entry) {
  const parts = [];
  for (const p of entry.args.positionals) {
    parts.push(p.required ? `<${p.name}>` : `[${p.name}]`);
  }
  for (const f of entry.args.flags) {
    const label = f.type === 'boolean' ? f.name : `${f.name} <${f.valueName || 'value'}>`;
    parts.push(f.required ? label : `[${label}]`);
  }
  return parts.join(' ');
}

export function describeCommand(name) {
  const entry = REGISTRY.get(name);
  if (!entry) return null;
  return {
    name: entry.name,
    summary: entry.summary,
    group: entry.group,
    sideEffect: entry.sideEffect,
    capabilities: entry.capabilities,
    outputModes: entry.outputModes,
    usage: entry.usage ?? buildUsage(entry),
    options: [
      ...entry.args.flags.map((f) => [flagLabel(f), f.description || '']),
      ...(entry.extraOptions || []),
      ...GLOBAL_FLAGS.map((f) => [flagLabel(f), f.description || '']),
    ],
  };
}

/** `describeCommand` for every registered command, in registration order. */
export function describeAll() {
  return listCommands().map(describeCommand);
}

registerCommand({
  name: 'orient',
  summary: 'context pack for a task',
  group: 'engineer loop',
  sideEffect: 'read',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  args: {
    positionals: [
      {
        name: 'query',
        description: 'free-text query words (joined; same as --query)',
        required: false,
        default: '',
        variadic: true,
      },
    ],
    flags: [
      { name: '--intent-page', type: 'number', valueName: 'n', description: 'read a bounded page of ranked intent candidates', required: false, default: null },
      { name: '--intent-page-size', type: 'number', valueName: 'n', description: 'intent paths per page, 1 to 32', required: false, default: 8 },
      { name: '--plan', type: 'string', valueName: 'path', description: 'orient the selected plan instead of ranking active plans', required: false, default: null },
      { name: '--query', type: 'string', valueName: 'text', description: 'agent/internal task summary', required: false, default: null, tui: 'prompt' },
      { name: '--limit', type: 'number', valueName: 'n', description: 'recall result count (default 3)', required: false, default: 3, tui: 'prompt' },
      {
        name: '--collection',
        aliases: ['-c'],
        type: 'string',
        valueName: 'name',
        description: 'filter by knowledge/collections.yaml',
        required: false,
        default: null,
        tui: 'prompt',
      },
      { name: '--min-score', type: 'number', valueName: 'n', description: 'minimum score (default 0.15)', required: false, default: 0.15, tui: 'prompt' },
            { name: '--explain', type: 'boolean', description: 'decompose learning ranking (deterministic)', required: false, default: false, tui: 'verb' },
      { name: '--file', type: 'string', valueName: 'path', description: 'one file to place in the change neighborhood (repeatable)', required: false, default: null, tui: 'prompt' },
      { name: '--read', type: 'boolean', description: 'print the bounded session slice and write no context pack', required: false, default: false, tui: 'cli-only' },
      { name: '--context-version', type: 'number', valueName: '1|2', description: 'select legacy facts or source-bound context evidence', required: false, default: 1, tui: 'cli-only' },
      { name: '--question-kind', type: 'string', valueName: 'kind', description: 'explicit lookup, dependency-path, change-impact or prior-lesson packet; requires --read --context-version 2', required: false, default: null, tui: 'cli-only' },
    ],
  },
  handler: cmdOrient,
  resultOf: orientResultOf,
});

registerCommand({
  name: 'learnings',
  summary: 'paged listing of learnings with provenance and failure annotations',
  group: 'knowledge',
  sideEffect: 'read',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  args: {
    positionals: [{ name: 'domain', description: 'filter by learning domain directory', required: false, default: null }],
    flags: [
      {
        name: '--why',
        type: 'string',
        valueName: 'id',
        description: 'full provenance chain for one learning',
        required: false,
        default: null,
                tui: 'verb',
      },
    ],
  },
  handler: cmdLearnings,
  resultOf: learningsResultOf,
});

registerCommand({
  name: 'status',
  summary: 'installed version, home, tracked files',
  group: 'setup',
  sideEffect: 'read',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  args: { positionals: [], flags: [
    { name: '--effective-policy', type: 'boolean', description: 'Resolve and publish the environment-scoped policy snapshot for installed hooks' },
    { name: '--contract-digest', type: 'boolean', description: 'Compute the current canonical work contract digest' },
    { name: '--validate-evidence', type: 'boolean', description: 'Validate current proof without rerunning checks' },
    { name: '--validate-completion', type: 'boolean', description: 'Validate the current bound completion record' },
    { name: '--plan', type: 'string', valueName: 'path', description: 'Plan to inspect' },
  ] },
  handler: cmdStatus,
  resultOf: statusResultOf,
});

registerCommand({
  name: 'review', summary: 'Capture review obligations and collect bound specialist results', group: 'engineer loop', sideEffect: 'mutate', capabilities: [], outputModes: ['ledger', 'json'],
  verbs: REVIEW_VERBS.map(verb => ({ verb, summary: verb === 'prepare' ? 'Capture current review scope' : 'Validate and record collected results' })),
  usage: '<prepare|assemble> [--plan <plan>] [--packet <id> --file <path>]',
  args: { positionals: [{ name: 'verb', required: true, description: REVIEW_VERBS.join('|') }], flags: [
    { name: '--plan', type: 'string', valueName: 'plan', description: 'Plan whose work is reviewed (omit for standalone)' },
    { name: '--domain', type: 'string', valueName: 'code|document', description: 'Review criteria set (default: code)' },
    { name: '--reviewer', type: 'string', valueName: 'id', description: 'Additional specialist (repeatable)' },
    { name: '--max-bytes', type: 'string', valueName: 'bytes', description: 'Per-section packet byte budget, 1024 to 131072 (default: 16384)' },
    { name: '--base', type: 'string', valueName: 'ref', description: 'Captured comparison revision' },
    { name: '--packet', type: 'string', valueName: 'id', description: 'Prepared packet identity' },
    { name: '--file', type: 'string', valueName: 'path', description: 'Prepare: selected source (repeatable). Assemble: JSON results (default: stdin)' },
  ] }, handler: cmdReview, resultOf: reviewResultOf, exitOf: result => result.status === 'blocked' ? 1 : 0,
});

registerCommand({
  name: 'inspect',
  summary: 'effective config, permissions, and workspace provenance',
  group: 'engineer loop',
  sideEffect: 'read',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: `<${INSPECT_VERBS.join('|')}> [key]`,
  verbs: INSPECT_VERBS.map((verb) => ({
    verb,
    summary: verb === 'config'
      ? 'effective config values with source and scope'
      : verb === 'permissions'
        ? 'trust, agent, bash, and network posture'
        : verb === 'workspace'
          ? 'workspace and copilot-home paths'
          : 'tool-class gates (bash, agent)',
    positionals: verb === 'config' ? ['key'] : [],
  })),
  args: {
    positionals: [
      { name: 'verb', description: INSPECT_VERBS.join('|'), required: false, default: 'config' },
      { name: 'key', description: 'optional config key for inspect config', required: false, default: null, choices: 'config-key' },
    ],
    flags: [],
  },
  handler: cmdInspect,
  resultOf: inspectResultOf,
  exitOf: inspectExitFor,
});

// --- setup ------------------------------------------------------------

const INSTALL_FLAGS = [
  { name: '--target', type: 'string', valueName: 't,..', description: 'installed: vscode, cli, intellij. cursor, codex, and grok are recognized but not installed', required: false, default: null, tui: 'cli-only' },
  { name: '--autonomy', type: 'string', valueName: 'mode', description: 'full | balanced | strict', required: false, default: null, tui: 'cli-only' },
  { name: '--configure-vscode', type: 'boolean', description: 'merge VS Code chat.* discovery settings', required: false, default: false, tui: 'cli-only' },
  { name: '--configure-path', type: 'boolean', description: 'append ~/.copilot/bin to shell PATH (~/.zshrc, ~/.bashrc)', required: false, default: false, tui: 'cli-only' },
  { name: '--force-profile', type: 'boolean', description: 'overwrite knowledge/profile.md', required: false, default: false, tui: 'cli-only' },
  { name: '--force-knowledge-reset', type: 'boolean', description: 'overwrite knowledge/solutions (danger)', required: false, default: false, tui: 'cli-only' },
    { name: '--preserve-knowledge', type: 'boolean', description: 'keep existing knowledge/solutions (default)', required: false, default: true, tui: 'cli-only' },
];

registerCommand({
  name: 'host', summary: 'select, configure, inspect or remove an AE host integration', group: 'setup', sideEffect: 'mutate',
  usage: '<list|setup|status|remove|export> [--host <id>] [--config-home <path>] [--skills-home <path>] [--output-directory <path>]',
  instrument: false, workspaceJournal: false, surfaces: ['cli'],
  verbs: HOST_VERBS.map(verb => ({ verb, summary: `${verb} host integration`, ...(['list', 'status'].includes(verb) ? { sideEffect: 'read' } : {}) })),
  args: { positionals: [{ name: 'verb', required: false, description: HOST_VERBS.join('|'), default: 'list' }], flags: [
    { name: '--host', type: 'string', valueName: 'id', description: 'claude-code, codex, cursor, terminal or copilot-vscode/cli/intellij' },
    { name: '--config-home', aliases: ['--host-home'], type: 'string', valueName: 'path', description: 'selected host configuration directory' },
    { name: '--skills-home', type: 'string', valueName: 'path', description: 'native skill directory (Codex defaults to ~/.agents/skills)' },
    { name: '--output-directory', type: 'string', valueName: 'path', description: 'new directory for portable Agent Plugins export', verbs: ['export'] },
  ] }, handler: cmdHost, resultOf: hostResultOf, exitOf: result => result.exitCode,
});

registerCommand({
  name: 'mcp', summary: 'serve bounded AE tools over local MCP stdio', group: 'setup', sideEffect: 'execute',
  usage: '<serve> [--skills-home <path>]',
  instrument: false, workspaceJournal: false, surfaces: ['cli'], outputModes: ['ledger'],
  verbs: [{ verb: 'serve', summary: 'start a workspace-bound MCP stdio server' }],
  args: { positionals: [{ name: 'verb', required: true, description: 'serve' }], flags: [
    { name: '--skills-home', type: 'string', valueName: 'path', description: 'selected native skill directory' },
  ] }, handler: cmdMcp,
});

registerCommand({
  name: 'install',
  summary: 'hydrate skills, agents, and team knowledge globally',
  group: 'setup',
  sideEffect: 'mutate',
    surfaces: ['cli'],
  args: { positionals: [], flags: INSTALL_FLAGS },
  handler: (argv) => cmdInstallOrUpgrade('install', argv),
});

registerCommand({
  name: 'upgrade',
  summary: 're-hydrate and purge retired primitives',
  group: 'setup',
  sideEffect: 'mutate',
    surfaces: ['cli'],
  args: { positionals: [], flags: INSTALL_FLAGS },
  handler: (argv) => cmdInstallOrUpgrade('upgrade', argv),
});

registerCommand({
  name: 'doctor',
  summary: 'health checks for install, hooks, and knowledge',
  group: 'setup',
  sideEffect: 'read',
  args: {
    positionals: [],
    flags: [
      { name: '--target', type: 'string', valueName: 'vscode|cli|intellij', description: 'select one installed host and its capability checks', required: false, default: null, tui: 'cli-only' },
      { name: '--host', type: 'string', valueName: 'name', description: 'run host-specific checks (vscode executes installed-hook probes)', required: false, default: null, tui: 'prompt' },
      { name: '--adapter', type: 'string', valueName: 'name', description: 'check one installed host adapter file', required: false, default: null, tui: 'cli-only' },
    ],
  },
  handler: cmdDoctor,
});

registerCommand({
  name: 'uninstall',
  summary: 'remove hydrated files tracked by the lock',
  group: 'setup',
  sideEffect: 'mutate',
    surfaces: ['cli'],
  args: { positionals: [], flags: [] },
  handler: cmdUninstall,
});

// --- workspace ----------------------------------------------------------

registerCommand({
  name: 'init-repo',
  summary: 'initialize private project setup, or explicitly share repository configuration',
  group: 'workspace',
  sideEffect: 'mutate',
    surfaces: ['cli', 'tui'],
  args: { positionals: [], flags: [
    { name: '--shared', type: 'boolean', description: 'create reviewable .github/harness project configuration instead of private configuration' },
  ] },
  handler: cmdInitRepo,
});

registerCommand({
  name: 'prepare',
  summary: 'write starter spec and ADR files when a brownfield repo has none',
  group: 'workspace',
  sideEffect: 'mutate',
  surfaces: ['cli', 'tui'],
  args: { positionals: [], flags: [] },
  handler: cmdPrepare,
});

registerCommand({
  name: 'migrate',
  summary: 'migrate a saved state home, or move gitignored product plans and solutions',
  group: 'workspace',
  sideEffect: 'mutate',
  surfaces: ['cli', 'tui'],
  args: { positionals: [], flags: [
    { name: '--from-home', type: 'string', valueName: 'path', description: 'copy the complete old home into explicit --ae-home; original stays as backup', tui: 'cli-only' },
  ] },
  handler: cmdMigrate,
});

registerCommand({
  name: 'graph',
  summary: 'bounded cited dependencies, explanations and impact from current facts or an immutable generation',
  group: 'workspace',
  sideEffect: 'read',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  surfaces: ['cli', 'tui', 'agent'],
  usage: '<deps|dependents|impact> <file> [--depth <n>] [--limit <n>] [--generation <id>] | <path|explain> <file> <target>',
  verbs: GRAPH_OPERATIONS.map(verb => ({ verb, summary: ['path', 'explain'].includes(verb) ? 'read a bounded directed relationship with evidence' : `read file ${verb}`, sideEffect: 'read', positionals: ['path', 'explain'].includes(verb) ? ['file', 'target'] : ['file'] })),
  args: {
    positionals: [
      { name: 'operation', description: GRAPH_OPERATIONS.join('|'), required: true },
      { name: 'file', description: 'repository file path', required: true },
      { name: 'target', description: 'target path for the path operation', required: false },
    ],
    flags: [
      { name: '--depth', type: 'number', valueName: 'n', description: 'traversal depth, 1 to 32; default 1, or 8 for path', required: false, default: null, tui: 'prompt' },
      { name: '--limit', type: 'number', valueName: 'n', description: 'maximum returned edges and unresolved imports, 1 to 200', required: false, default: 50, tui: 'prompt' },
      { name: '--generation', type: 'string', valueName: 'id', description: 'read a retained immutable historical generation without claiming live freshness', required: false, default: null, tui: 'prompt' },
    ],
  },
  handler: cmdGraph,
  resultOf: async argv => graphResultOf(argv, await prepareGraph(parseGraphArguments(argv))),
});

registerCommand({
  name: 'index',
  summary: 'rebuild knowledge and code indexes · --status to look · --structural for code only',
  group: 'workspace',
  sideEffect: 'mutate',
    usage: '[--status] [--structural [--since <ref>]]',
  args: {
    positionals: [],
    flags: [
            {
        name: '--status',
        type: 'boolean',
        description:
          'read-only: knowledge BM25 freshness and code-symbol index status (never rebuilds)',
        required: false,
        default: false,
        tui: 'verb',
        sideEffect: 'read',
      },
            {
        name: '--structural',
        type: 'boolean',
        description:
          'build the persistent structural code index with bundled AST assets; unsupported inputs retain a labeled lexical tier',
        required: false,
        default: false,
        tui: 'verb',
      },
      {
        name: '--since',
        type: 'string',
        valueName: 'ref',
        description:
          'requires --structural: re-parse only files changed since <ref> (validated via git rev-parse; leading "-" rejected). Narrows ONLY when <ref> is the sha the prior index was built at — any other ref is reported and ignored for a full pass',
        required: false,
        default: null,
        tui: 'prompt',
                requires: ['--structural'],
      },
    ],
  },
  handler: cmdIndex,
});

registerCommand({
  name: 'route',
  summary: 'show a plan routing snapshot without writing',
  group: 'engineer loop',
  sideEffect: 'read',
  surfaces: ['cli'],
  args: {
    positionals: [],
    flags: [
      { name: '--plan', type: 'string', valueName: 'path', description: 'plan file', required: true, default: null, tui: 'cli-only' },
    ],
  },
  handler: cmdRoute,
});

registerCommand({
  name: 'plan-new',
  summary: 'scaffold a gate-ready plan',
  group: 'workspace',
  sideEffect: 'mutate',
    args: {
    positionals: [],
    flags: [
      { name: '--file', type: 'string', valueName: 'decision.json', description: 'Version 1 full or short creation decision, or - to read that JSON from stdin; owns dates, IDs, headings and bindings' },
      { name: '--type', type: 'string', valueName: 't', description: 'feat|fix|docs|refactor|chore', required: true, default: null, tui: 'prompt' },
      { name: '--slug', type: 'string', valueName: 's', description: 'lowercase-hyphen slug', required: true, default: null, tui: 'prompt' },
      { name: '--intent', type: 'string', valueName: 'text', description: 'one-line intent', required: true, default: null, tui: 'prompt' },
      { name: '--goal', type: 'string', valueName: 'text', description: 'short plan goal; requires --acceptance and --constraint', required: false, default: null, tui: 'cli-only' },
      { name: '--acceptance', type: 'string', valueName: 'text', description: 'short plan acceptance criterion (repeatable)', required: false, default: null, tui: 'cli-only' },
      { name: '--constraint', type: 'string', valueName: 'text', description: 'short plan constraint (repeatable)', required: false, default: null, tui: 'cli-only' },
      { name: '--verification-check', type: 'string', valueName: 'name', description: 'configured named check (required when several are configured)', required: false, default: null, tui: 'prompt' },
      { name: '--impacted', type: 'string', valueName: 'a,b', description: 'comma-separated Impacted Files', required: false, default: null, tui: 'prompt' },
      { name: '--criteria', type: 'string', valueName: 'text', description: 'an acceptance criterion (repeatable)', required: false, default: null, tui: 'prompt' },
      { name: '--gap', type: 'string', valueName: 'id:path', description: 'capability gap → blocked-capability + governed primitive plan', required: false, default: null, tui: 'prompt' },
            { name: '--stdout', type: 'boolean', description: 'print the plan instead of writing it', required: false, default: false, tui: 'cli-only' },
            { name: '--title', type: 'string', valueName: 'text', description: 'plan heading override (default: derived from slug)', required: false, default: null, tui: 'prompt' },
      { name: '--date', type: 'string', valueName: 'yyyy-mm-dd', description: 'override the plan filename date (default: today)', required: false, default: null, tui: 'prompt' },
            { name: '--risk', type: 'string', valueName: 'green|amber|red', description: 'risk rating (default green)', required: false, default: null, tui: 'prompt' },
            { name: '--status', type: 'string', valueName: 'name', description: 'open|planned|in-progress|review|done|blocked-capability|needs-info (default in-progress, or blocked-capability with --gap)', required: false, default: null, tui: 'cli-only' },
      { name: '--from', type: 'string', valueName: 'path', description: 'relock an unlocked plan in place', required: false, default: null, tui: 'cli-only' },
      { name: '--classification', type: 'string', valueName: 'path', description: 'host classification JSON to validate', required: false, default: null, tui: 'cli-only' },
      { name: '--intent-source', type: 'string', valueName: 'path', description: 'in-repo spec, ADR, or intent path (repeatable)', required: false, default: null, tui: 'prompt', valueIsLiteral: true },
    ],
  },
  handler: cmdPlanNew,
  requireArgs: planNewRequireArgs,
});

registerCommand({
  name: 'plan-update',
  summary: 'update a plan file in the external plan store',
  group: 'workspace',
  sideEffect: 'mutate',
  args: {
    positionals: [],
    flags: [
      { name: '--plan', type: 'string', valueName: 'path', description: 'plan file under the external store or a legacy plan directory', required: true, default: null, tui: 'prompt', choices: 'plan', valueIsLiteral: true },
      { name: '--file', type: 'string', valueName: 'decision.json', description: 'Versioned start, amend, progress, finding, gap or complete decision with expected revision and replay ID, or - to read that JSON from stdin' },
      { name: '--status', type: 'string', valueName: 'name', description: 'open|planned|in-progress|review|done|blocked-capability|needs-info', required: false, default: null, tui: 'prompt' },
      { name: '--activity', type: 'string', valueName: 'line', description: 'append one activity line (repeatable)', required: false, default: null, tui: 'prompt', valueIsLiteral: true },
      { name: '--review-completed', type: 'string', valueName: 'id', description: 'add a reviews.completed id (repeatable)', required: false, default: null, tui: 'prompt' },
      { name: '--critical-open', type: 'string', valueName: 'id', description: 'replace reviews.critical_open (repeatable)', required: false, default: null, tui: 'prompt', valueIsLiteral: true },
      { name: '--clear-critical', type: 'boolean', description: 'set reviews.critical_open to []', required: false, default: false, tui: 'cli-only' },
      { name: '--lock', type: 'boolean', description: 'set plan_lock true and stamp intent_sources sha256; never clears it', required: false, default: false, tui: 'cli-only' },
      { name: '--intent', type: 'string', valueName: 'text', description: 'replace the intent line', required: false, default: null, tui: 'prompt', valueIsLiteral: true },
      { name: '--intent-source', type: 'string', valueName: 'path', description: 'append one intent_sources path (repeatable)', required: false, default: null, tui: 'prompt', valueIsLiteral: true },
      { name: '--expected-output', type: 'string', valueName: 'text', description: 'append one expected output (repeatable)', required: false, default: null, tui: 'prompt', valueIsLiteral: true },
      { name: '--success-criterion', type: 'string', valueName: 'text', description: 'append one success criterion (repeatable)', required: false, default: null, tui: 'prompt', valueIsLiteral: true },
      { name: '--verification-check', type: 'string', valueName: 'id', description: 'append one verification.required check (repeatable)', required: false, default: null, tui: 'prompt' },
      { name: '--gap-fulfillment', type: 'string', valueName: 'id:done|bridge|waived', description: 'set fulfillment on an existing capability gap (repeatable)', required: false, default: null, tui: 'prompt' },
      { name: '--old', type: 'string', valueName: 'text', description: 'unique plan-body text to replace', required: false, default: null, tui: 'prompt', valueIsLiteral: true, requires: ['--new'] },
      { name: '--new', type: 'string', valueName: 'text', description: 'replacement for --old; body only', required: false, default: null, tui: 'prompt', valueIsLiteral: true, requires: ['--old'] },
    ],
  },
  handler: cmdPlanUpdate,
});

registerCommand({
  name: 'worktree',
  summary: 'create a linked git worktree for issue work',
  group: 'workspace',
  sideEffect: 'mutate',
  args: {
    positionals: [],
    flags: [
      { name: '--slug', type: 'string', valueName: 's', description: 'lowercase-hyphen slug; branch is harness/<slug>', required: true, default: null, tui: 'prompt' },
      { name: '--from', type: 'string', valueName: 'ref', description: 'start point (default: origin default branch, else HEAD)', required: false, default: null, tui: 'prompt' },
    ],
  },
  handler: cmdWorktree,
  requireArgs: worktreeRequireArgs,
});

// --- engineer loop --------------------------------------------------------

registerCommand({
  name: 'gate',
  summary: 'edit preconditions before editFiles',
  group: 'engineer loop',
  sideEffect: 'mutate',
  args: {
    positionals: [{ name: 'query', description: 'free-text query words (plan-ranking only)', required: false, default: '', variadic: true }],
    flags: [
      { name: '--phase', type: 'string', valueName: 'name', description: 'implement | verify', required: false, default: 'implement', tui: 'prompt' },
      { name: '--plan', type: 'string', valueName: 'path', description: 'explicit plan file', required: false, default: null, tui: 'prompt', choices: 'plan' },
            { name: '--strict-intent', type: 'boolean', description: 'fail locked plans missing intent fields', required: false, default: false, tui: 'cli-only' },
      { name: '--allow-inplace', type: 'boolean', description: 'allow implement on the current branch instead of a linked worktree', required: false, default: false, tui: 'cli-only' },
      { name: '--enforcement', type: 'string', valueName: 'mode', description: 'observe | warn | enforce (default enforce)', required: false, default: null, tui: 'prompt', choices: ['observe', 'warn', 'enforce'] },
    ],
  },
  handler: cmdGate,
});

registerCommand({
  name: 'verify',
  summary: 'run trusted named checks and capture evidence',
  group: 'engineer loop',
  sideEffect: 'execute',
    supportsJsonl: true,
  args: {
    positionals: [],
    flags: [
      { name: '--plan', type: 'string', valueName: 'path', description: 'plan file whose named checks run', required: false, default: null, tui: 'prompt', choices: 'plan' },
      { name: '--base', type: 'string', valueName: 'git-ref', description: 'compare changed files to this git ref', required: false, default: null, tui: 'prompt' },
      { name: '--enforcement', type: 'string', valueName: 'mode', description: 'observe | warn | enforce (default enforce)', required: false, default: null, tui: 'prompt', choices: ['observe', 'warn', 'enforce'] },
            { name: '--learnings', type: 'string', valueName: 'a,b', description: 'learning ids cited by this verified change', required: false, default: null, tui: 'prompt' },
    ],
  },
  handler: cmdVerify,
});

registerCommand({
  name: 'validate-plan',
  summary: 'plan readiness checks',
  group: 'engineer loop',
  sideEffect: 'read',
  args: {
    positionals: [],
    flags: [
      { name: '--plan', type: 'string', valueName: 'path', description: 'explicit plan file', required: false, default: null, tui: 'prompt', choices: 'plan' },
      { name: '--enforcement', type: 'string', valueName: 'mode', description: 'observe | warn | enforce (default enforce)', required: false, default: null, tui: 'prompt', choices: ['observe', 'warn', 'enforce'] },
            { name: '--strict-intent', type: 'boolean', description: 'fail locked plans missing intent fields', required: false, default: false, tui: 'cli-only' },
    ],
  },
  handler: cmdValidatePlan,
});

registerCommand({
  name: 'compound',
  summary: 'record learning from passed evidence · --insight captures without evidence',
  group: 'engineer loop',
  sideEffect: 'mutate',
  args: {
    positionals: [],
    flags: [
      { name: '--learning-decision', type: 'string', valueName: 'path', description: 'Structured verified learning decision JSON file, or - for stdin' },
      { name: '--plan', type: 'string', valueName: 'path', description: 'explicit plan file', required: false, default: null, tui: 'prompt', choices: 'plan' },
            { name: '--insight', type: 'boolean', description: 'evidence-free investigation capture (kind: insight, secret-scanned)', required: false, default: false, tui: 'verb' },
            { name: '--title', type: 'string', valueName: 't', description: 'insight title (required with --insight)', required: false, default: null, tui: 'prompt' },
      { name: '--body', type: 'string', valueName: 'text', description: 'insight body text', required: false, default: null, tui: 'prompt' },
      { name: '--body-file', type: 'string', valueName: 'path', description: 'read insight body from a file', required: false, default: null, tui: 'prompt', choices: 'path' },
      { name: '--category', type: 'string', valueName: 'c', description: 'docs/solutions/<category>/ (default insights)', required: false, default: null, tui: 'prompt' },
      { name: '--tags', type: 'string', valueName: 'a,b', description: 'comma-separated tags', required: false, default: null, tui: 'prompt' },
      { name: '--trigger', type: 'string', valueName: 't', description: 'applicability condition frontmatter', required: false, default: null, tui: 'prompt' },
      { name: '--claim', type: 'string', valueName: 't', description: 'one-line claim frontmatter', required: false, default: null, tui: 'prompt' },
            { name: '--enforcement', type: 'string', valueName: 'mode', description: 'observe | warn | enforce (default enforce)', required: false, default: null, tui: 'prompt', choices: ['observe', 'warn', 'enforce'] },
    ],
  },
  handler: cmdCompound,
});

registerCommand({
  name: 'recall',
  summary: 'search team knowledge',
  group: 'engineer loop',
  sideEffect: 'read',
  args: {
        positionals: [{ name: 'query', description: 'free-text search terms (joined)', required: true, default: '', variadic: true }],
    flags: [
      { name: '--limit', type: 'number', valueName: 'n', description: 'result count (default 3)', required: false, default: 3, tui: 'prompt' },
      { name: '--collection', aliases: ['-c'], type: 'string', valueName: 'name', description: 'filter by knowledge/collections.yaml', required: false, default: null, tui: 'prompt' },
      { name: '--min-score', type: 'number', valueName: 'n', description: 'minimum score (default 0.15)', required: false, default: 0.15, tui: 'prompt' },
            { name: '--include-plans', type: 'boolean', description: 'include matching plans', required: false, default: false, tui: 'cli-only' },
    ],
  },
  handler: cmdRecall,
  resultOf: recallResultOf,
  requireArgs: recallRequireArgs,
});

registerCommand({
  name: 'get',
  summary: 'bounded doc excerpt',
  group: 'engineer loop',
  sideEffect: 'read',
  args: {
    positionals: [],
    flags: [
            { name: '--docid', type: 'string', valueName: 'id', description: 'manifest doc id', required: false, default: null, tui: 'prompt' },
      { name: '--reference', type: 'string', valueName: 'id', description: 'installed corpus file, for example skills/code-review/references/findings-schema.md. Prints that file. Does not search the workspace.', required: false, default: null, tui: 'cli-only' },
      { name: '--path', type: 'string', valueName: 'rel', description: 'relative file path', required: false, default: null, tui: 'prompt', choices: 'path' },
      { name: '--lines', type: 'number', valueName: 'n', description: `max lines (default ${GET_DEFAULT_LINES})`, required: false, default: GET_DEFAULT_LINES, tui: 'prompt' },
      { name: '--offset', type: 'number', valueName: 'n', description: 'first line of the window, 1-indexed (default 1)', required: false, default: 1, tui: 'prompt' },
      { name: '--max-bytes', type: 'number', valueName: 'n', description: `max excerpt bytes (default ${GET_DEFAULT_MAX_BYTES})`, required: false, default: GET_DEFAULT_MAX_BYTES, tui: 'prompt' },
      { name: '--context-version', type: 'number', valueName: '1|2', description: 'add source-bound ranges and surrounding context with version 2', required: false, default: 1, tui: 'cli-only' },
    ],
  },
  handler: cmdGet,
  resultOf: getResultOf,
  requireArgs: getRequireArgs,
});

registerCommand({
  name: 'edit',
  summary: 'replace one exact, unique piece of text in a file',
  group: 'engineer loop',
  sideEffect: 'mutate',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  args: {
    positionals: [],
    flags: [
      { name: '--path', type: 'string', valueName: 'rel', description: 'the file to change, relative to the workspace', required: true, default: null, tui: 'prompt', choices: 'path', valueIsLiteral: true },
            { name: '--old', type: 'string', valueName: 'text', description: 'the exact text to replace; it must appear exactly once', required: true, default: null, tui: 'prompt', valueIsLiteral: true },
      { name: '--new', type: 'string', valueName: 'text', description: 'what to put in its place', required: true, default: null, tui: 'prompt', valueIsLiteral: true },
    ],
  },
  handler: cmdEdit,
  resultOf: editResultOf,
  requireArgs: editRequireArgs,
  exitOf: editExitFor,
});

registerCommand({
  name: 'write',
  summary: 'create a file, or replace one whose current content you can prove',
  group: 'engineer loop',
  sideEffect: 'mutate',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  args: {
    positionals: [],
    flags: [
      { name: '--path', type: 'string', valueName: 'rel', description: 'the file to write, relative to the workspace', required: true, default: null, tui: 'prompt', choices: 'path', valueIsLiteral: true },
      { name: '--content', type: 'string', valueName: 'text', description: 'the complete new contents of the file', required: true, default: null, tui: 'prompt', valueIsLiteral: true },
            { name: '--expect', type: 'string', valueName: 'sha256', description: 'the digest of the content being replaced — required to overwrite an existing file', required: false, default: null, tui: 'prompt' },
            { name: '--allow-shrink', type: 'boolean', description: 'confirm replacing an existing file with much smaller content is intended', required: false, default: false, tui: 'cli-only' },
    ],
  },
  handler: cmdWrite,
  resultOf: writeResultOf,
  requireArgs: writeRequireArgs,
  exitOf: editExitFor,
});

registerCommand({
  name: 'undo',
  summary: 'put back the most recent edit/write, or list outstanding undos',
  group: 'engineer loop',
  sideEffect: 'mutate',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  surfaces: ['cli', 'tui'],
  usage: '[list]',
  verbs: [
    { verb: 'list', summary: 'show outstanding undos without reverting', sideEffect: 'read' },
  ],
  args: {
    positionals: [],
    flags: [],
  },
  handler: cmdUndo,
  resultOf: undoResultOf,
  exitOf: editExitFor,
});

registerCommand({
  name: 'todo',
  bareSideEffect: 'read',
  summary: 'durable workspace or accepted plan worklist',
  group: 'engineer loop',
  sideEffect: 'mutate',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  surfaces: ['cli', 'tui', 'agent'],
  usage: '<list|sync|add|complete|clear> [--plan <path>] [--text <item>] [--id <id>]',
  verbs: [
    { verb: 'list', summary: 'show open and completed items', sideEffect: 'read' },
    { verb: 'sync', summary: 'reconcile an accepted plan playbook into its durable worklist' },
    { verb: 'add', summary: 'append a work item' },
    { verb: 'complete', summary: 'mark an item done' },
    { verb: 'clear', summary: 'remove all items' },
  ],
  args: {
    positionals: [
      { name: 'verb', description: TODO_VERBS.join('|'), required: false, default: 'list' },
    ],
    flags: [
      { name: '--plan', type: 'string', valueName: 'path', description: 'accepted plan identity for scoped list, sync or complete', required: false, default: null, verbs: ['list', 'sync', 'complete'] },
      // Mutate flags are only offered on mutating verb rows (not on list / bare read paths).
      { name: '--text', type: 'string', valueName: 'item', description: 'work item text for add', required: false, default: null, tui: 'prompt', valueIsLiteral: true, verbs: ['add'] },
      { name: '--id', type: 'string', valueName: 'id', description: 'item id for complete', required: false, default: null, tui: 'prompt', verbs: ['complete'] },
    ],
  },
  handler: cmdTodo,
  resultOf: todoResultOf,
  exitOf: todoExitFor,
});

registerCommand({
  name: 'domain',
  summary: 'observe domains and coordinate accepted work through the existing lifecycle',
  group: 'engineer loop',
  sideEffect: 'execute',
  instrument: argv => parseDomainArguments(argv).verb !== 'show',
  workspaceJournal: false,
  capabilities: [],
  outputModes: ['ledger', 'json'],
  surfaces: ['cli', 'tui', 'agent'],
  usage: '<show|status|get|plan-new|plan-update|gate|review|verify|compound> --name <name> [--plan <path>]',
  verbs: [
    { verb: 'show', summary: 'observe existing membership without creating execution authority', sideEffect: 'read' },
    { verb: 'status', summary: 'read current child and joint proof status', sideEffect: 'read' },
    { verb: 'get', summary: 'read a bounded parent plan through its explicit domain context', sideEffect: 'read' },
    { verb: 'plan-new', summary: 'accept one parent and reserved per-repository plans', sideEffect: 'mutate' },
    { verb: 'plan-update', summary: 'apply a revision-bound authored parent decision', sideEffect: 'mutate' },
    { verb: 'gate', summary: 'publish coordination-only gate authority', sideEffect: 'mutate' },
    { verb: 'review', summary: 'prepare or assemble existing bound review records', sideEffect: 'mutate' },
    { verb: 'verify', summary: 'verify current children and the actual revision-set contract', sideEffect: 'execute' },
    { verb: 'compound', summary: 'record the parent learning decision through passed evidence', sideEffect: 'mutate' },
  ],
  args: {
    positionals: [{ name: 'verb', description: DOMAIN_VERBS.join('|'), required: true }, { name: 'review-verb', description: 'prepare|assemble for review', required: false }],
    flags: [
      { name: '--name', type: 'string', valueName: 'name', description: 'existing local domain name', required: true, tui: 'prompt' },
      { name: '--plan', type: 'string', valueName: 'path', description: 'parent plan in the selected domain store', tui: 'prompt' },
      { name: '--file', type: 'string', valueName: 'path', description: 'authored JSON decision, review input or selected review source', repeatable: true, tui: 'prompt' },
      { name: '--base', type: 'string', valueName: 'ref', description: 'captured comparison revision', tui: 'prompt' },
      { name: '--phase', type: 'string', valueName: 'name', description: 'implement|verify coordination gate', tui: 'prompt' },
      { name: '--enforcement', type: 'string', valueName: 'mode', description: 'observe|warn|enforce', tui: 'prompt' },
      { name: '--domain', type: 'string', valueName: 'kind', description: 'code|document review criteria', tui: 'prompt' },
      { name: '--reviewer', type: 'string', valueName: 'id', description: 'additional review perspective', repeatable: true, tui: 'prompt' },
      { name: '--max-bytes', type: 'string', valueName: 'bytes', description: 'bounded review excerpt budget', tui: 'prompt' },
      { name: '--offset', type: 'string', valueName: 'line', description: 'first parent-plan line to read', tui: 'prompt' },
      { name: '--lines', type: 'string', valueName: 'count', description: 'bounded parent-plan line count', tui: 'prompt' },
      { name: '--packet', type: 'string', valueName: 'id', description: 'prepared review packet identity', tui: 'prompt' },
      { name: '--learning-decision', type: 'string', valueName: 'path', description: 'verified learning or no-learning JSON decision', tui: 'prompt' },
      { name: '--validate-completion', type: 'boolean', description: 'validate the current bound parent completion receipt', appliesToVerbs: ['status'], tui: 'cli-only' },
    ],
  },
  handler: cmdDomain,
  resultOf: domainResultOf,
  exitOf: result => result.exitCode,
});

registerCommand({
  name: 'experiment',
  summary: 'reserve, measure and retain a bounded accepted numerical experiment',
  group: 'engineer loop',
  sideEffect: 'execute',
  instrument: argv => parseExperimentArguments(argv).verb !== 'status',
  workspaceJournal: false,
  capabilities: [],
  outputModes: ['json'],
  surfaces: ['cli', 'tui', 'agent'],
  usage: '<begin|evaluate|resolve|status> [--plan <path>]',
  verbs: [
    { verb: 'begin', summary: 'reserve a charged baseline, candidate or repair pair', sideEffect: 'mutate' },
    { verb: 'evaluate', summary: 'execute one reserved pair once through trusted isolated checks', sideEffect: 'execute' },
    { verb: 'resolve', summary: 'keep, discard or cancel the observed candidate', sideEffect: 'mutate' },
    { verb: 'status', summary: 'read setup or current durable experiment state', sideEffect: 'read' },
  ],
  args: {
    positionals: [{ name: 'verb', description: EXPERIMENT_VERBS.join('|'), required: true }],
    flags: [
      { name: '--plan', type: 'string', valueName: 'path', description: 'accepted full experiment plan', tui: 'prompt' },
      { name: '--file', type: 'string', valueName: 'path', description: 'revision-bound authored reservation or resolution', tui: 'prompt' },
      { name: '--attempt', type: 'string', valueName: 'uuid', description: 'durably reserved invocation identity', tui: 'prompt' },
    ],
  },
  handler: cmdExperiment,
  resultOf: experimentResultOf,
  exitOf: result => result.exitCode,
});

registerCommand({
  name: 'diagrams',
  summary: 'render source-bound diagrams using bundled offline engines',
  group: 'engineer loop',
  sideEffect: 'mutate',
  instrument: false,
  workspaceJournal: false,
  capabilities: [],
  outputModes: ['ledger', 'json'],
  surfaces: ['cli', 'tui', 'agent'],
  usage: '<render|graph|flow|formal|status> [--file <path>] [--model <module>] [--sources <paths>] [--renderer <pele|d2>] [--layout <tala|elk|dagre>] [--png] [--scale <1-4>] [--root <path>] [--operation <deps|dependents>] [--flow <id>] [--receipt <path>] [--depth <n>] [--limit <n>] [--max-nodes <n>] [--timeout <ms>] [--dry-run]',
  verbs: [
    { verb: 'render', summary: 'render an authored Mermaid or D2 source with explicit evidence' },
    { verb: 'graph', summary: 'render a bounded current-worktree module-import view' },
    { verb: 'flow', summary: 'render a saved committed-default-branch statechart' },
    { verb: 'formal', summary: 'draw retained formal counterexamples or positive explored state graphs without running a checker' },
    { verb: 'status', summary: 'inspect source freshness and retained artifact integrity', sideEffect: 'read' },
  ],
  args: {
    positionals: [{ name: 'verb', description: DIAGRAM_VERBS.join('|'), required: true }],
    flags: [
      { name: '--file', type: 'string', valueName: 'path', description: 'workspace-relative diagram source or recorded formal-verification.json', tui: 'prompt', verbs: ['render', 'formal'] },
      { name: '--model', type: 'string', valueName: 'module', description: 'exact .tla module in the recorded receipt; retained evidence only, no checker execution', tui: 'prompt', verbs: ['formal'] },
      { name: '--sources', type: 'string', valueName: 'paths', description: 'comma-separated source files or watched directories', tui: 'prompt', verbs: ['render'] },
      { name: '--renderer', type: 'string', valueName: 'pele|d2', description: 'bundled backend matching the source syntax', tui: 'prompt', verbs: ['render'] },
      { name: '--layout', type: 'string', valueName: 'tala|elk|dagre', description: 'D2 layout; default tala', tui: 'prompt', verbs: ['render'] },
      { name: '--root', type: 'string', valueName: 'path', description: 'tracked source file for the import view', tui: 'prompt', verbs: ['graph'] },
      { name: '--operation', type: 'string', valueName: 'deps|dependents', description: 'import neighbors; default deps', tui: 'prompt', verbs: ['graph'] },
      { name: '--flow', type: 'string', valueName: 'id', description: 'existing saved application flow ID', tui: 'prompt', verbs: ['flow'] },
      { name: '--receipt', type: 'string', valueName: 'path', description: 'returned receipt path for freshness inspection', tui: 'prompt', verbs: ['status'] },
      { name: '--depth', type: 'number', valueName: 'n', description: 'graph depth 1 to 32; default 2', tui: 'prompt', verbs: ['graph'] },
      { name: '--limit', type: 'number', valueName: 'n', description: 'graph/flow edge limit 1 to 200; default 50', tui: 'prompt', verbs: ['graph', 'flow'] },
      { name: '--max-nodes', type: 'number', valueName: 'n', description: 'view nodes 1 to 200; default 50', tui: 'prompt', verbs: ['graph', 'flow', 'formal'] },
      { name: '--timeout', type: 'number', valueName: 'ms', description: 'worker deadline 1 to 30000 ms; default 10000', tui: 'prompt', verbs: ['render', 'graph', 'flow', 'formal'] },
      { name: '--png', type: 'boolean', description: 'also write diagram.png beside the SVG', tui: 'cli-only', verbs: ['render', 'graph', 'flow', 'formal'] },
      { name: '--scale', type: 'number', valueName: '1-4', description: 'PNG pixel scale; default 2; requires --png', tui: 'prompt', verbs: ['render', 'graph', 'flow', 'formal'] },
    ],
  },
  handler: cmdDiagrams,
  resultOf: diagramsResultOf,
  exitOf: result => result.exitCode,
});

registerCommand({
  name: 'flows',
  summary: 'prepare, publish and inspect shared descriptive application flow models',
  group: 'engineer loop',
  sideEffect: 'mutate',
  instrument: false,
  workspaceJournal: false,
  capabilities: [],
  outputModes: ['ledger', 'json'],
  surfaces: ['cli', 'tui', 'agent'],
  usage: '<prepare|publish|status|show> [--file <path>] [--dry-run]',
  verbs: [
    { verb: 'prepare', summary: 'capture committed default-branch source bindings', sideEffect: 'read' },
    { verb: 'publish', summary: 'publish an immutable authored statechart generation' },
    { verb: 'status', summary: 'inspect observed default-branch applicability', sideEffect: 'read' },
    { verb: 'show', summary: 'read the validated current generation', sideEffect: 'read' },
  ],
  args: {
    positionals: [{ name: 'verb', description: FLOW_VERBS.join('|'), required: true }],
    flags: [{ name: '--file', type: 'string', valueName: 'path', description: 'workspace-relative preparation scope or authored publication JSON', tui: 'prompt' }],
  },
  handler: cmdFlows,
  resultOf: flowsResultOf,
  exitOf: result => result.exitCode,
});

registerCommand({
  name: 'performance',
  summary: 'analyze journey goals, architecture flows and source dependencies',
  group: 'engineer loop',
  sideEffect: 'mutate',
  instrument: false,
  workspaceJournal: false,
  capabilities: [],
  outputModes: ['ledger', 'json'],
  surfaces: ['cli', 'tui', 'agent'],
  usage: 'analyze [--file <path>] [--domain <name>] [--dry-run]',
  verbs: [{ verb: 'analyze', summary: 'publish linked performance views from bounded current evidence' }],
  args: {
    positionals: [{ name: 'verb', description: PERFORMANCE_VERBS.join('|'), required: true }],
    flags: [
      { name: '--file', type: 'string', valueName: 'path', description: 'workspace-relative profile (default .github/harness/performance.json)', tui: 'prompt' },
      { name: '--domain', type: 'string', valueName: 'name', description: 'existing version-2 domain membership', tui: 'prompt' },
    ],
  },
  handler: cmdPerformance,
  resultOf: performanceResultOf,
  exitOf: result => result.exitCode,
});

registerCommand({
  name: 'inventory',
  summary: 'read or refresh an optional sourced local IDE snapshot',
  group: 'engineer loop',
  sideEffect: 'mutate',
  instrument: false,
  workspaceJournal: false,
  capabilities: [],
  outputModes: ['ledger', 'json'],
  surfaces: ['cli', 'tui', 'agent'],
  usage: '<show|refresh> [--editor <family>] [--profile <id>] [--installation <path>] [--launcher <path>] [--user-data <path>] [--config-root <path>] [--plugins-root <path>]',
  verbs: [
    { verb: 'show', summary: 'read the dated cache without collecting or creating files', sideEffect: 'read' },
    { verb: 'refresh', summary: 'collect one IDE family and merge its cache in the selected home' },
  ],
  args: {
    positionals: [{ name: 'verb', description: INVENTORY_VERBS.join('|'), required: true }],
    flags: [
      { name: '--editor', type: 'string', valueName: 'family', description: 'vscode, cursor or jetbrains', tui: 'prompt', appliesToVerbs: ['refresh'] },
      { name: '--profile', type: 'string', valueName: 'id', description: 'existing profile directory ID', tui: 'prompt', appliesToVerbs: ['refresh'] },
      ...['installation', 'launcher', 'user-data', 'config-root', 'plugins-root'].map(name => ({ name: `--${name}`, type: 'string', valueName: 'path', description: `read-only ${name} metadata location`, tui: 'prompt', appliesToVerbs: ['refresh'] })),
    ],
  },
  handler: cmdInventory,
  resultOf: inventoryResultOf,
  exitOf: result => result.exitCode,
});

registerCommand({
  name: 'apply',
  summary: 'all-or-nothing multi-file CAS apply on the single write path',
  group: 'engineer loop',
  sideEffect: 'mutate',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  surfaces: ['cli', 'tui', 'agent'],
  usage: '[--spec <file>] [--changes <json>]',
  args: {
    positionals: [],
    flags: [
      { name: '--spec', type: 'string', valueName: 'file', description: 'workspace-relative JSON file: array of changes', required: false, default: null, tui: 'prompt' },
      { name: '--changes', type: 'string', valueName: 'json', description: 'inline JSON array of {path,old,new} or {path,content,expect?}', required: false, default: null, tui: 'prompt', valueIsLiteral: true },
    ],
  },
  handler: cmdApply,
  resultOf: applyResultOf,
  exitOf: applyExitFor,
});

registerCommand({
  name: 'exec',
  summary: 'run an argv directly — never through a shell — with a confined cwd and an allowlisted environment',
  group: 'engineer loop',
  sideEffect: 'execute',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '[--cwd <dir>] [--timeout <s>] [--allow-env <NAME>] -- <program> [args...]',
  args: {
    positionals: [],
    flags: [
      { name: '--cwd', type: 'string', valueName: 'dir', description: 'working directory, confined to the workspace', required: false, default: null, tui: 'prompt' },
      { name: '--timeout', type: 'number', valueName: 's', description: 'seconds before the process tree is terminated (default 600, max 3600)', required: false, default: 600, tui: 'prompt' },
      { name: '--allow-env', type: 'string', valueName: 'NAME', description: 'pass one parent environment variable through (repeatable); the default is deny-all', required: false, default: null, tui: 'prompt' },
    ],
  },
  handler: cmdExec,
  resultOf: execResultOf,
    exitOf: execExitFor,
});

registerCommand({
  name: 'bash',
    summary: 'run a script through a shell — separately gated from exec, which never uses one',
  group: 'engineer loop',
  sideEffect: 'execute',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '[--cwd <dir>] [--timeout <s>] [--allow-env <NAME>] -- "<script>"',
  args: {
    positionals: [],
    flags: [
      { name: '--cwd', type: 'string', valueName: 'dir', description: 'working directory, confined to the workspace', required: false, default: null, tui: 'prompt' },
      { name: '--timeout', type: 'number', valueName: 's', description: 'seconds before the process tree is terminated (default 600, max 3600)', required: false, default: 600, tui: 'prompt' },
      { name: '--allow-env', type: 'string', valueName: 'NAME', description: 'pass one parent environment variable through (repeatable); the default is deny-all', required: false, default: null, tui: 'prompt' },
    ],
  },
  handler: cmdBash,
  resultOf: bashResultOf,
  exitOf: execExitFor,
});

registerCommand({
  name: 'tui',
    surfaces: ['cli', 'agent'],
  summary: 'open the session ledger — a scrolling transcript that dispatches through this same registry',
  group: 'engineer loop',
    sideEffect: 'execute',
  capabilities: [],
  outputModes: ['ledger'],
  usage: '',
  args: { positionals: [], flags: [] },
    handler: async (argv, ctx) => (await import('./tui-cmd.mjs')).cmdTui(argv, ctx),
  });

registerCommand({
  name: 'resources',
  summary: 'validate, scaffold, propose, and manage skills, agents, instructions and bundles',
  group: 'setup',
    sideEffect: 'mutate',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '<list|show|register|unregister|discard|create|validate|scaffold|candidates|propose|bundles|add|update|remove> [path] [name]',
  verbs: [
    { verb: 'validate', summary: 'check metadata, references, registry and delegation declarations', sideEffect: 'read' },
    { verb: 'scaffold', summary: 'emit a dormant template requiring authored judgment', sideEffect: 'read', positionals: ['path', 'name'] },
    { verb: 'candidates', summary: 'freeze recurring claim evidence; counters never activate a primitive' },
    { verb: 'propose', summary: 'package a dormant authored intervention with frozen evidence' },
    { verb: 'list', summary: 'skills and agents added by hand, with whether each is registered and valid', sideEffect: 'read' },
    { verb: 'show', summary: 'one added primitive: its kind, name, digest, and why it is in that state', sideEffect: 'read', positionals: ['path'] },
    { verb: 'register', summary: 'validate an added primitive and record that this machine recognizes it', positionals: ['path'] },
    { verb: 'unregister', summary: 'withdraw recognition without deleting the file', positionals: ['path'] },
    { verb: 'discard', summary: 'delete a locally-added invalid, stray, or unused skill, agent, or extra file', positionals: ['path'] },
    { verb: 'create', summary: 'write a personal skill, agent, or instruction from stdin under the Copilot home', positionals: ['path', 'name'] },
    { verb: 'bundles', summary: 'installed bundles, their state, and what each has placed', sideEffect: 'read' },
    { verb: 'add', summary: 'install a bundle directory and place its contributions', positionals: ['bundle'] },
    { verb: 'update', summary: 'replace an installed bundle and re-place its contributions', positionals: ['bundle'] },
    { verb: 'remove', summary: 'uninstall a bundle and withdraw everything it placed', positionals: ['bundle'] },
  ],
  args: {
    positionals: [
      { name: 'verb', description: RESOURCES_VERBS.join('|'), required: false, default: 'list' },
      { name: 'path', description: 'the primitive path, name, or filename', required: false, default: null, choices: 'primitive' },
      { name: 'bundle', description: 'bundle directory or installed bundle name', required: false, default: null },
      { name: 'name', description: 'primitive name for resources create', required: false, default: null },
    ],
    flags: [
      { name: '--file', type: 'string', valueName: 'path', description: 'Versioned creation or dormant proposal JSON input', required: false, default: null, tui: 'cli-only' },
      { name: '--path', type: 'string', valueName: 'directory', description: 'Root to inspect with validate', required: false, default: null, tui: 'cli-only' },
      { name: '--corpus', type: 'boolean', description: 'Validate shipped corpus and capability registry', required: false, default: false, tui: 'cli-only' },
      { name: '--yes', type: 'boolean', description: 'Caller confirmation of human-authorized tool or delegation expansion', required: false, default: false, tui: 'cli-only' },
    ],
  },
  bareSideEffect: 'read',
  handler: cmdResources,
  resultOf: resourcesResultOf,
  exitOf: resourcesExitFor,
});

registerCommand({
  name: 'agent',
  summary: 'run a task headlessly — orient, ask a model what to do, do it under controls, journal every turn',
  group: 'engineer loop',
    sideEffect: 'execute',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '<task...> [--profile <name>] [--verify-cmd <argv>] [--agent <persona>] [--provider <id>] [--model <id>] [--max-turns <n>] [--max-seconds <s>] [--tool-timeout <s>] [--dry-run]',
  args: {
        positionals: [{ name: 'task...', description: 'what to do, in words', required: true, default: null }],
    flags: [
      { name: '--profile', type: 'string', valueName: 'name', description: `deliver | autonomous | bench | benchmark (default ${DEFAULT_PROFILE_ID})`, required: false, default: DEFAULT_PROFILE_ID, tui: 'prompt' },
      { name: '--verify-cmd', type: 'string', valueName: 'argv', description: 'task verifier argv for autonomous success (e.g. "node ./verify.mjs"); green is terminal success', required: false, default: null, tui: 'prompt', valueIsLiteral: true },
      { name: '--retention-policy', type: 'string', valueName: 'legacy|structured', description: 'opt into task handoff and source references during compaction', required: false, default: 'legacy', tui: 'cli-only' },
      { name: '--context-policy', type: 'string', valueName: 'legacy|selective|subsystem', description: 'opt into current source evidence for each model request', required: false, default: 'legacy', tui: 'cli-only' },
      { name: '--file', type: 'string', valueName: 'path', description: 'task file seed for context selection; repeat for more files', required: false, default: null, tui: 'cli-only' },
      { name: '--agent', type: 'string', valueName: 'persona', description: `which hydrated persona to run as (default ${DEFAULT_PERSONA})`, required: false, default: DEFAULT_PERSONA, tui: 'prompt' },
      { name: '--provider', type: 'string', valueName: 'id', description: `which provider answers the model call: ${Object.keys(PROVIDERS).join('|')} (default ${DEFAULT_PROVIDER})`, required: false, default: DEFAULT_PROVIDER, tui: 'prompt' },
      { name: '--model', type: 'string', valueName: 'id', description: "the model to call; the provider's default when omitted", required: false, default: null, tui: 'prompt' },
      { name: '--max-turns', type: 'number', valueName: 'n', description: `stop after this many turns (default ${DEFAULT_MAX_TURNS})`, required: false, default: DEFAULT_MAX_TURNS, tui: 'prompt' },
      { name: '--max-seconds', type: 'number', valueName: 's', description: `stop after this much wall clock (default ${DEFAULT_MAX_SECONDS})`, required: false, default: DEFAULT_MAX_SECONDS, tui: 'prompt' },
      { name: '--tool-timeout', type: 'number', valueName: 's', description: "ceiling on one tool's runtime in seconds; the model may ask for less, never more", required: false, default: null, tui: 'prompt' },
    ],
  },
    requireArgs: agentRequireArgs,
  handler: cmdAgent,
  resultOf: agentResultOf,
    journalArgv: agentJournalArgv,
    exitOf: agentExitFor,
});

registerCommand({
  name: 'run',
  summary: 'list, inspect, or judge the resumability of past harness runs',
  group: 'engineer loop',
    sideEffect: 'read',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '<list|show|tree|resume> [run-id] [--status <status>] [--command <name>] [--host <host>] [--plan <path>] [--since <date>] [--until <date>] [--limit <n>]',
  verbs: [
    { verb: 'list', summary: 'past runs, newest first, with the documented filters' },
    { verb: 'show', summary: 'one run and every event it recorded', positionals: ['run-id'] },
    { verb: 'tree', summary: 'one run and the work it caused', positionals: ['run-id'] },
    { verb: 'resume', summary: 'whether this run can safely be resumed, and from where', positionals: ['run-id'] },
  ],
  args: {
    positionals: [
      { name: 'verb', description: RUN_VERBS.join('|'), required: false, default: 'list' },
      { name: 'run-id', description: 'a run id or an unambiguous prefix', required: false, default: null, choices: 'run' },
    ],
    flags: [
      { name: '--status', type: 'string', valueName: 'status', description: `list: ${RUN_STATUSES.join('|')}`, required: false, default: null, tui: 'prompt', verbs: ['list'] },
      { name: '--command', type: 'string', valueName: 'name', description: 'list: only runs of this command', required: false, default: null, tui: 'prompt', verbs: ['list'] },
      { name: '--host', type: 'string', valueName: 'host', description: 'list: only runs from this host', required: false, default: null, tui: 'prompt', verbs: ['list'] },
      { name: '--plan', type: 'string', valueName: 'path', description: 'list: only runs against this plan', required: false, default: null, tui: 'prompt', verbs: ['list'], choices: 'plan' },
      { name: '--since', type: 'string', valueName: 'date', description: 'list: runs at or after this date', required: false, default: null, tui: 'prompt', verbs: ['list'] },
      { name: '--until', type: 'string', valueName: 'date', description: 'list: runs at or before this date', required: false, default: null, tui: 'prompt', verbs: ['list'] },
      { name: '--limit', type: 'number', valueName: 'n', description: 'list: how many runs to show (default 20)', required: false, default: 20, tui: 'prompt', verbs: ['list'] },
    ],
  },
  // A bare `ae run` lists, which reads.
  bareSideEffect: 'read',
  handler: cmdRun,
  resultOf: runResultOf,
  exitOf: runExitFor,
    requireArgs: runRequireArgs,
});

registerCommand({
  name: 'model',
  summary: 'choose the provider and model that answer',
  group: 'engineer loop',
    tuiPicker: 'model',
  // `set`/`clear` write config; a bare `model` reads, which is the common call.
  sideEffect: 'mutate',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '[show|set|clear|refresh] [provider] [model] [--scope <scope>]',
  verbs: [
    { verb: 'show', summary: 'the active provider and model, and every provider you can reach', sideEffect: 'read' },
    { verb: 'set', summary: 'make a provider (and optionally a model) the default', positionals: ['provider', 'model'] },
    { verb: 'clear', summary: 'forget the choice and fall back to the built-in default' },
        { verb: 'refresh', summary: 'ask a provider which models it actually serves, and remember the answer', positionals: ['provider'] },
  ],
  args: {
    positionals: [
      { name: 'verb', description: MODEL_VERBS.join('|'), required: false, default: 'show', choices: MODEL_VERBS },
            { name: 'provider', description: 'the provider id, for set', required: false, default: null, choices: 'provider' },
      { name: 'model', description: 'the model id, for set; omit for the provider default', required: false, default: null, choices: 'model' },
    ],
    flags: [
      { name: '--scope', type: 'string', valueName: 'scope', description: `which file remembers the choice, ${SCOPES.join(' or ')}`, required: false, default: null, tui: 'prompt', verbs: ['set', 'clear'], choices: 'scope' },
    ],
  },
  // A bare `ae model` is the picker view, and reading is what it does.
  bareSideEffect: 'read',
  handler: cmdModel,
  resultOf: modelResultOf,
});

registerCommand({
  name: 'trust',
  summary: 'show, grant, or withdraw this project\u2019s permission to change harness behavior',
  group: 'engineer loop',
  // `approve`/`revoke` write the user-scope trust store; `status` reads.
  sideEffect: 'mutate',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '<status|approve|revoke>',
  verbs: [
    { verb: 'status', summary: 'whether this project is trusted, why, and which files an approval pins', sideEffect: 'read' },
    { verb: 'approve', summary: 'grant this project permission and pin its policy files by content' },
    { verb: 'revoke', summary: 'withdraw permission; project config and policy stop taking effect' },
  ],
  args: {
    positionals: [
      { name: 'verb', description: TRUST_VERBS.join('|'), required: false, default: 'status' },
    ],
    flags: [],
  },
    bareSideEffect: 'read',
  handler: cmdTrust,
  resultOf: trustResultOf,
});

registerCommand({
  name: 'config',
  summary: 'show, read, or change harness configuration across the user and project scopes',
  group: 'engineer loop',
  // Ledger: one Settings modal (keys + values), not config set/get/show rows.
  tuiPicker: 'config',
  sideEffect: 'mutate',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '<show|get|set|validate> [key] [value] [--scope <scope>]',
  verbs: [
    { verb: 'show', summary: 'every key, its effective value, and which scope supplied it', sideEffect: 'read' },
    { verb: 'get', summary: 'one key: its effective value and provenance', sideEffect: 'read', positionals: ['key'] },
    { verb: 'set', summary: 'write one key into the user or project scope, atomically', positionals: ['key', 'value'] },
    { verb: 'validate', summary: 'parse both scopes and report every schema violation', sideEffect: 'read' },
  ],
  args: {
    positionals: [
      { name: 'verb', description: CONFIG_VERBS.join('|'), required: true, default: null, choices: CONFIG_VERBS },
            { name: 'key', description: CONFIG_KEYS.join('|'), required: false, default: null, choices: 'config-key' },
      { name: 'value', description: 'the new value, for set', required: false, default: null, choices: 'config-value' },
    ],
    flags: [
            { name: '--scope', type: 'string', valueName: 'scope', description: `set: which file to write, ${SCOPES.join(' or ')}`, required: true, default: null, tui: 'prompt', verbs: ['set'], choices: 'scope' },
    ],
  },
  handler: cmdConfig,
  resultOf: configResultOf,
    exitOf: configExitFor,
});

registerCommand({
  name: 'checks',
  summary: 'list, inspect, or run one named check from the trusted check config',
  group: 'engineer loop',
    sideEffect: 'execute',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '<list|show|run> [name]',
  verbs: [
    { verb: 'list', summary: 'every check the workspace declares, with its argv and timeout', sideEffect: 'read' },
    { verb: 'show', summary: 'one check: the exact argv it will execute, and whether it validates', sideEffect: 'read', positionals: ['name'] },
    { verb: 'run', summary: 'execute one check on its own and exit non-zero if it does not pass', positionals: ['name'] },
  ],
  args: {
    positionals: [
      { name: 'verb', description: CHECKS_VERBS.join('|'), required: true, default: null },
      { name: 'name', description: 'the check name, for show and run', required: false, default: null },
    ],
    flags: [],
  },
  handler: cmdChecks,
  resultOf: checksResultOf,
    exitOf: checksExitFor,
});

registerCommand({
  name: 'search',
  summary: 'ranked, literal, regex, path, or symbol search across code, knowledge, learnings and plans',
  group: 'engineer loop',
  sideEffect: 'read',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '<query> [--match <mode>] [--source <a,b>] [--explain] [--cursor <c>]',
  args: {
    positionals: [
      { name: 'query', description: 'free-text query words (joined)', required: true, default: '', variadic: true },
    ],
    flags: [
            { name: '--match', type: 'string', valueName: 'mode', description: `match mode: ${SEARCH_MATCH_MODES.join('|')} (default ranked)`, required: false, default: 'ranked', tui: 'prompt' },
      { name: '--source', type: 'string', valueName: 'a,b', description: `restrict to sources: ${SEARCH_SOURCE_NAMES.join(',')}`, required: false, default: null, tui: 'prompt' },
      { name: '--explain', type: 'boolean', description: 'include the retrieval reason per result', required: false, default: false, tui: 'prompt' },
      { name: '--cursor', type: 'string', valueName: 'c', description: 'resume from a previous page', required: false, default: null, tui: 'cli-only' },
      { name: '--context-version', type: 'number', valueName: '1|2', description: 'bind cursors to query and source state; return expandable evidence', required: false, default: 1, tui: 'cli-only' },
      { name: '--limit', type: 'number', valueName: 'n', description: 'results per page (default 20)', required: false, default: 20, tui: 'prompt' },
      { name: '--collection', aliases: ['-c'], type: 'string', valueName: 'name', description: 'filter by knowledge/collections.yaml', required: false, default: null, tui: 'prompt' },
    ],
  },
  handler: cmdSearch,
  resultOf: searchResultOf,
});

registerCommand({
  name: 'tree',
  summary: 'structural navigation of the workspace or the knowledge corpus',
  group: 'engineer loop',
  sideEffect: 'read',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '<workspace|knowledge> [target] [--depth <n>]',
    verbs: TREE_SUBJECT_NAMES.map((subject) => ({
    verb: subject,
    summary: subject === 'workspace'
      ? 'tracked files as a directory tree'
      : 'the knowledge corpus grouped by scope, category, and learning domain',
    positionals: [],
  })),
  args: {
    positionals: [
      { name: 'subject', description: TREE_SUBJECT_NAMES.join('|'), required: true, default: null },
      { name: 'target', description: 'subtree path, or a collection name for knowledge', required: false, default: null },
    ],
    flags: [
      { name: '--depth', type: 'number', valueName: 'n', description: 'tree depth (default 3, max 10)', required: false, default: 3, tui: 'prompt' },
      { name: '--files', type: 'boolean', description: 'flat git ls-files list for the workspace, including untracked files git does not ignore', required: false, default: false, tui: 'cli-only' },
    ],
  },
  handler: cmdTree,
  resultOf: treeResultOf,
});

registerCommand({
  name: 'lookup',
  summary: 'exact entity retrieval by kind and identifier',
  group: 'engineer loop',
    sideEffect: 'read',
  capabilities: [],
  outputModes: ['ledger', 'json'],
    verbs: LOOKUP_KINDS.map((kind) => ({
    verb: kind,
    summary: LOOKUP_KIND_SUMMARIES[kind],
    positionals: ['identifier'],
  })),
  args: {
    positionals: [
      {
        name: 'kind',
        description: LOOKUP_KINDS.join('|'),
        required: true,
        default: null,
      },
      {
        name: 'identifier',
        description: 'entity id — a path, docid, symbol name, <domain>/<slug>, or path@sha256',
        required: true,
        default: null,
      },
    ],
    flags: [],
  },
  handler: cmdLookup,
    resultOf: lookupResultOf,
    usage: `<${LOOKUP_KINDS.join('|')}> <identifier>`,
});

registerCommand({
  name: 'events',
  summary: 'session telemetry',
  group: 'engineer loop',
  sideEffect: 'read',
    instrument: false,
  args: {
    positionals: [],
    flags: [
      { name: '--session', type: 'string', valueName: 'id', description: 'filter by host session ID', required: false, default: null, tui: 'prompt' },
            { name: '--summary', type: 'boolean', description: 'aggregate summary only', required: false, default: false, tui: 'verb' },
      { name: '--failures', type: 'boolean', description: 'failed or blocked events only', required: false, default: false, tui: 'verb' },
      { name: '--limit', type: 'number', valueName: 'n', description: 'event count (default 20)', required: false, default: 20, tui: 'prompt' },
    ],
  },
  handler: cmdEvents,
});

registerCommand({
  name: 'report',
  summary: 'token-efficiency or Adaptive Engineering growth report from events',
  group: 'engineer loop',
  sideEffect: 'mutate',
  bareSideEffect: 'read',
  usage: '[--facts] [--growth] [--sync] [--global] [--check] [--json]',
  instrument: false,
  args: {
    positionals: [],
    flags: [
      { name: '--facts', type: 'boolean', description: 'source-bound product facts, declared graphs and completion records', tui: 'verb', sideEffect: 'read' },
      { name: '--max-bytes', type: 'number', valueName: 'n', description: 'factual report byte budget 2048–65536', tui: 'cli-only' },
      { name: '--growth', type: 'boolean', description: 'session-end Adaptive Engineering growth report (learnings, compound, promote)', required: false, default: false, tui: 'verb', sideEffect: 'read' },
      { name: '--plan', type: 'string', valueName: 'path', description: 'optional plan path for growth report context', required: false, default: null, tui: 'prompt', choices: 'plan', sideEffect: 'read' },
      { name: '--sync', type: 'boolean', description: 'merge workspace events into the global store first', required: false, default: false, tui: 'verb' },
      { name: '--global', type: 'boolean', description: 'report across all synced workspaces', required: false, default: false, tui: 'verb', sideEffect: 'read' },
      { name: '--check', type: 'boolean', description: 'exit non-zero on a budget breach (CI)', required: false, default: false, tui: 'cli-only' },
      { name: '--host', type: 'string', valueName: 'name', description: 'host usage log to overlay (default: auto-detect)', required: false, default: null, tui: 'prompt', sideEffect: 'read' },
    ],
  },
  handler: cmdReport,
});

// --- knowledge ------------------------------------------------------------

registerCommand({
  name: 'knowledge',
  summary: 'knowledge layer mode switch and purge (human deletion always wins)',
  group: 'knowledge',
  sideEffect: 'mutate',
    usage: '<on|suggest|off|freeze|capture-only> | --status | purge <file|--all> | commit <none|repo> | migrate-store',
    extraOptions: [
    ['status', 'layer-aware report: golden domain counts, branch buckets, recall-index drift (read-only)'],
    ['promote [--branch <key>] [--ids a,b] [--all]', 'emit a reviewable branch→golden promotion op-set (.harness/promote-ops.json)'],
    ['prune [--branch <key>] [--merged] [--stale <days>]', 'delete branch buckets (human authority, never mode-gated)'],
    ['purge <file>', 'cascade-delete an episode and dependent learnings'],
    ['purge --all', 'reset the learnings store (episodes remain, become debt)'],
    ['commit <none|repo>', 'repo mirrors ACTIVE learnings into docs/knowledge/learnings (opt-in, never git-commits the product repo); none is the default'],
    ['migrate-store [--from-id <id>]', 'copy missing files from other ids of this checkout into the stable id and keep every source; --from-id preserves old knowledge and plans in place'],
  ],
    verbs: [
    { verb: 'on', summary: 'default mode: orient injects, and every writer (remember, compound --insight, consolidate --apply) is open' },
    { verb: 'suggest', summary: 'approve-before-write: consolidate --apply stops until a human re-runs it with --yes' },
    { verb: 'off', summary: 'kill switch: no injection and no writers at all' },
    { verb: 'freeze', summary: 'read-only layer: orient still injects, but remember and consolidate --apply stop writing' },
    { verb: 'capture-only', summary: 'stop injecting into orient while compound --insight keeps capturing' },
        {
      verb: 'status',
      summary: 'layer-aware report: golden domain counts, branch buckets, recall-index drift (read-only)',
      sideEffect: 'read',
    },
    { verb: 'promote', summary: 'emit a reviewable branch→golden promotion op-set (.harness/promote-ops.json)' },
    { verb: 'prune', summary: 'delete branch buckets (human authority, never mode-gated)' },
        { verb: 'purge', summary: 'cascade-delete an episode and dependent learnings', positionals: ['target'] },
    {
      verb: 'commit',
      summary:
        'repo mirrors ACTIVE learnings into docs/knowledge/learnings (opt-in, never git-commits the product repo); none is the default',
      positionals: ['target'],
    },
    {
      verb: 'migrate-store',
      summary:
        'copy missing learnings into the current store and keep every source; --from-id preserves old knowledge and plans in place',
    },
  ],
  args: {
    positionals: [
      {
        name: 'subcommand',
        description: 'on|suggest|off|freeze|capture-only|status|promote|prune|purge|commit|migrate-store',
        required: false,
        default: null,
      },
      { name: 'target', description: 'purge target, or the commit mode (none|repo)', required: false, default: null },
    ],
    flags: [
      { name: '--from-id', type: 'string', valueName: 'id', description: 'adopt an existing local or canonical remote storage ID without moving records; refuses conflicts', required: false, default: null, tui: 'prompt', verbs: ['migrate-store'] },
            { name: '--status', type: 'boolean', description: 'show the active mode (default)', required: false, default: false, tui: 'cli-only' },
            {
        name: '--all',
        type: 'boolean',
        description: 'purge --all resets the whole learnings store; promote --all takes every promotable id in the bucket',
        required: false,
        default: false,
        tui: 'cli-only',
        verbs: ['promote', 'purge'],
      },
            { name: '--branch', type: 'string', valueName: 'key', description: 'promote/prune: the branch bucket key to act on', required: false, default: null, tui: 'prompt', verbs: ['promote', 'prune'] },
      { name: '--ids', type: 'string', valueName: 'a,b', description: 'promote: comma-separated learning ids to include in the op-set', required: false, default: null, tui: 'prompt', verbs: ['promote'] },
            { name: '--merged', type: 'boolean', description: 'prune: every bucket whose branch is already merged into the default branch', required: false, default: false, tui: 'verb', verbs: ['prune'] },
      { name: '--stale', type: 'string', valueName: 'days', description: 'prune: every bucket older than <days> (integer >= 1)', required: false, default: null, tui: 'prompt', verbs: ['prune'] },
            { name: '--yes', type: 'boolean', description: 'prune: confirm deleting a bucket that still holds ACTIVE, unpromoted learnings', required: false, default: false, tui: 'cli-only', verbs: ['prune'] },
    ],
  },
  handler: cmdKnowledge,
});

registerCommand({
  name: 'consolidate',
  summary: 'episode→learning debt, work packet, and validated apply',
  group: 'knowledge',
  sideEffect: 'mutate',
    bareSideEffect: 'read',
  usage: '[--status | --candidates | --apply --ops <path> | --rebuild --yes]',
  args: {
    positionals: [],
    flags: [
            { name: '--status', type: 'boolean', description: 'debt vs threshold, quarantine, promotion candidates (default)', required: false, default: false, tui: 'cli-only' },
            { name: '--candidates', type: 'boolean', description: 'persist a frozen work packet; --dry-run previews without publication', required: false, default: false, tui: 'verb', sideEffect: 'mutate' },
      {
        name: '--apply',
        type: 'boolean',
        description: 'validate and apply an ops JSON (sole writer); suggest mode requires --yes',
        required: false,
        default: false,
        tui: 'verb',
                requires: ['--ops'],
      },
            { name: '--ops', type: 'string', valueName: 'path', description: 'Frozen packet proposal JSON path; legacy schema-1 ops remain supported', required: false, default: null, tui: 'prompt', sideEffect: 'read', choices: 'path' },
            { name: '--rebuild', type: 'boolean', description: 'T2 reset for model-upgrade regeneration (git history retains learnings)', required: false, default: false, tui: 'verb' },
      { name: '--yes', type: 'boolean', description: 'confirm --apply (suggest mode) or --rebuild', required: false, default: false, tui: 'cli-only' },
            { name: '--layer', type: 'string', valueName: 'golden|branch', description: 'explicit layer override for --apply (writes otherwise route by write-time git context)', required: false, default: null, tui: 'prompt', sideEffect: 'read' },
    ],
  },
  handler: cmdConsolidate,
});

registerCommand({
  name: 'remember',
  summary: 'teach the harness a durable claim (human-teaching episode + learning)',
  group: 'knowledge',
  sideEffect: 'mutate',
  args: {
    positionals: [{ name: 'claim', description: 'the durable claim text', required: true, default: null }],
    flags: [
      { name: '--trigger', type: 'string', valueName: 't', description: 'applicability condition (required)', required: true, default: null, tui: 'prompt' },
      { name: '--domain', type: 'string', valueName: 'd', description: 'learning domain directory (default general)', required: false, default: null, tui: 'prompt' },
            { name: '--category', type: 'string', valueName: 'c', description: 'docs/solutions/<category>/ (default teachings)', required: false, default: null, tui: 'prompt' },
      { name: '--tags', type: 'string', valueName: 'a,b', description: 'comma-separated tags', required: false, default: null, tui: 'prompt' },
    ],
  },
  handler: cmdRemember,
});

registerCommand({
  name: 'correct',
  summary: 'record who authorized a claim, why, where it applies, and where it does not',
  group: 'knowledge',
  sideEffect: 'mutate',
  surfaces: ['cli'],
  args: {
    positionals: [{ name: 'claim', description: 'the accepted claim', required: true, default: null }],
    flags: [
      { name: '--trigger', type: 'string', valueName: 'when', description: 'when the claim applies', required: true, default: null, tui: 'cli-only' },
      { name: '--why', type: 'string', valueName: 'why', description: 'why this claim was accepted', required: true, default: null, tui: 'cli-only' },
      { name: '--applies', type: 'string', valueName: 'where', description: 'where the claim applies', required: true, default: null, tui: 'cli-only' },
      { name: '--does-not-apply', type: 'string', valueName: 'where-not', description: 'where the claim does not apply', required: true, default: null, tui: 'cli-only' },
      { name: '--shows', type: 'string', valueName: 'phrase', description: 'symbol or phrase the refused diff contains. Required when --authority is correction', required: false, default: null, tui: 'cli-only' },
      { name: '--authority', type: 'string', valueName: 'authority', description: 'instruction, correction, or inference', required: true, default: null, tui: 'cli-only', choices: ['instruction', 'correction', 'inference'] },
      { name: '--domain', type: 'string', valueName: 'd', description: 'learning domain directory (default general)', required: false, default: null, tui: 'cli-only' },
    ],
  },
  handler: cmdCorrect,
});

registerCommand({
  name: 'learning',
  summary: 'human authority over one learning: retire, dispute, confirm, or promote',
  group: 'knowledge',
  sideEffect: 'mutate',
  usage: '<retire|dispute|confirm|promote> <id> [--reason "<r>"] [--to <path>]',
    verbs: [
    { verb: 'retire', summary: 'retire the learning from ranking (requires --reason)', positionals: ['id'] },
    { verb: 'dispute', summary: 'mark the learning contested pending review (requires --reason)', positionals: ['id'] },
    { verb: 'confirm', summary: 'reaffirm the learning as active and stamp last_confirmed', positionals: ['id'] },
    { verb: 'promote', summary: 'record that behavior now lives in a primitive (requires --to); terminal for the other three', positionals: ['id'] },
  ],
  args: {
    positionals: [
      { name: 'action', description: 'retire|dispute|confirm|promote', required: true, default: null },
      { name: 'id', description: 'the learning id', required: true, default: null },
    ],
    flags: [
            { name: '--reason', type: 'string', valueName: 'r', description: 'required for retire/dispute; recorded in the store commit', required: false, default: null, tui: 'prompt' },
            { name: '--to', type: 'string', valueName: 'path', description: 'primitive path recorded on promote (behavior supersedes knowledge)', required: false, default: null, tui: 'prompt', verbs: ['promote'], choices: 'path' },
    ],
  },
  handler: cmdLearning,
});

registerCommand({
  name: 'eval-knowledge',
  summary: 'deterministic retrieval eval — hit/false-surface/token cost per arm (proxy, not net-benefit)',
  group: 'knowledge',
  sideEffect: 'read',
  args: { positionals: [], flags: [] },
  handler: cmdEvalKnowledge,
});

// --- utility ----------------------------------------------------------

registerCommand({
  name: 'resolve',
  summary: 'print the resolved harness CLI path for agents',
  group: 'utility',
  sideEffect: 'read',
    surfaces: ['cli'],
  userInvocable: false,
  args: { positionals: [], flags: [] },
  handler: cmdResolve,
});
