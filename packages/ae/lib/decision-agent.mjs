import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertNoSymlinkAncestors, readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { harnessGlobalHome } from './paths.mjs';
import * as review from './review.mjs';
import { normalizeCapabilityTools } from './capability-catalog.mjs';
import { loadPlan } from './plan-parse.mjs';
import { planContractText } from './work-contract.mjs';
import { normalizeToolPayload, toolMutationSucceeded, harnessControlCommand, TERMINAL_TOOLS } from '../corpus/hooks/lib/tool-payload.mjs';
import { decisionInputStaging } from '../corpus/hooks/lib/decision-staging.mjs';
import { hydrateArchivedDecision, decisionTask, compactDecisions, latestArchivedReadiness, READINESS_INDEX_FAULT, archivedOverCapMessage } from './decision-archive.mjs';

const TYPES = new Set(['action', 'capability', 'readiness', 'memory']);
const VERDICTS = new Set(['allow', 'revise', 'acquire', 'ready', 'escalate', 'deny']);
const ID = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_STATE_WARNINGS = 16;
// Plans the aggregated archived-over-cap warning tracks until each one's index is written.
const MAX_ARCHIVED_PLAN_KEYS = 256;
const DEFAULT_BUDGETS = Object.freeze({ maxDecisions: 24, maxRepairs: 3, maxAcquisitions: 3, maxSeconds: 900 });
const LOCAL_INSPECTION = new Set(['read', 'Read', 'read_file', 'readFile', 'copilot_readFile', 'read_skill', 'readSkill', 'grep_search', 'file_search', 'list_dir', 'semantic_search', 'list_code_usages', 'get_errors', 'get_changed_files', 'get_search_view_results', 'test_search', 'open_file', 'codebase', 'search', 'usages', 'changes', 'problems', 'terminalLastCommand', 'get_terminal_output', 'think', 'todos']);
const NATIVE_LOCAL_INSPECTION = new Set([...LOCAL_INSPECTION, 'ReadFile', 'Glob', 'Grep', 'ListDir', 'view', 'glob', 'grep', 'rg']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => Object.assign(new Error(`Decision agent: ${message}`), { code: 'E_TARGET', exit: 1, hint: 'Inspect the decision packet and standing discovery consent; never supply an approved flag.' });
const stable = value => JSON.stringify(value, (_, v) => object(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const within = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);
const nativeToolName = value => value === 'task' || value === 'Task' ? 'Agent' : value;

function sameAlias(payload, keys) {
  const values = keys.map(key => payload[key]).filter(value => value !== undefined && value !== null);
  return values.length && values.every(value => value === values[0]) ? values[0] : null;
}

function aliasesAgree(payload) {
  for (const keys of [['session_id', 'sessionId'], ['hook_event_name', 'hookEventName']]) {
    const values = keys.map(key => payload[key]).filter(value => value !== undefined && value !== null);
    if (values.length > 1 && !values.every(value => value === values[0])) return false;
  }
  const names = ['tool_name', 'toolName'].map(key => payload[key]).filter(value => value !== undefined).map(value => nativeToolName(normalizeToolPayload({ tool_name: value }).toolName));
  if (names.some(value => value !== names[0])) return false;
  try {
    const inputs = ['tool_input', 'toolArgs', 'toolInput'].map(key => payload[key]).filter(value => value !== undefined && value !== null).map(value => typeof value === 'string' ? JSON.parse(value) : value);
    return inputs.every(value => stable(value) === stable(inputs[0]));
  } catch { return false; }
}

function decisionRole(input) {
  const roles = ['subagent_type', 'agent_type', 'agent'].map(key => input?.[key]).filter(value => typeof value === 'string' && value);
  return roles.length ? roles.every(role => role === roles[0]) ? roles[0] : null : input?.name;
}

function fields(value, permitted, label) {
  if (!object(value) || Object.keys(value).some(key => !permitted.includes(key))) throw fail(`${label} has unknown or unsupported fields`);
}

function text(value, label, limit = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000]/.test(value)) throw fail(`${label} must be bounded nonempty text`);
  return value;
}

function bounded(value, label, max = 32768) {
  const encoded = stable(value);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > max) throw fail(`${label} exceeds its bounded JSON size`);
  return JSON.parse(encoded);
}

/** Translate user-owned discovery consent; agent payloads never supply this authority. */
export function decisionPolicyFromDiscovery(snapshot) {
  const grants = snapshot?.policy?.grants;
  return { enabled: snapshot?.configured === true && grants?.decision === true, revision: snapshot?.policyRevision || snapshot?.policy?.revision || 'unconfigured',
    tools: grants?.tools || [], agents: grants?.agents || [], create: grants?.create || [], update: grants?.update || [], memory: grants?.memory === true,
    types: [...TYPES], readRoots: (snapshot?.policy?.roots || []).filter(root => root.included).map(root => root.path), budgets: grants?.budgets || {} };
}

function authority(value) {
  const policy = object(value) ? value : {};
  const budgets = { ...DEFAULT_BUDGETS, ...(object(policy.budgets) ? policy.budgets : {}) };
  for (const [key, fallback] of Object.entries(DEFAULT_BUDGETS)) {
    if (!Number.isSafeInteger(budgets[key]) || budgets[key] < 1 || budgets[key] > (key === 'maxSeconds' ? 86400 : 1000)) budgets[key] = fallback;
  }
  return { enabled: policy.enabled === true, revision: typeof policy.revision === 'string' ? policy.revision : stable(policy.revision ?? 'unconfigured'),
    tools: Array.isArray(policy.tools) ? normalizeCapabilityTools(policy.tools) : [], create: Array.isArray(policy.create) ? policy.create : [], update: Array.isArray(policy.update) ? policy.update : [],
    agents: Array.isArray(policy.agents) ? policy.agents : [], readRoots: Array.isArray(policy.readRoots) ? policy.readRoots.filter(root => typeof root === 'string' && path.isAbsolute(root)) : [], memory: policy.memory === true, types: Array.isArray(policy.types) ? policy.types : [...TYPES], budgets };
}

function locations(options) {
  const workspace = fs.realpathSync.native(path.resolve(options.workspace || process.cwd()));
  const home = path.resolve(options.home || harnessGlobalHome());
  if (within(workspace, home)) throw fail('decision state home must be outside the product workspace');
  if (!assertNoSymlinkAncestors(path.parse(home).root, path.relative(path.parse(home).root, home))) throw fail('decision state home is redirected or unsafe');
  const relative = path.join('decisions', `${hash(workspace)}.json`);
  if (!assertNoSymlinkAncestors(home, relative)) throw fail('decision store is unsafe or symlinked');
  return { home, workspace, relative, file: path.join(home, relative), now: options.now ?? Date.now() };
}

function readState(loc) {
  const stat = fs.lstatSync(loc.file, { throwIfNoEntry: false });
  if (!stat) return { schema: 1, workspace: loc.workspace, tasks: {}, requests: {}, observations: {}, receipts: {}, invocations: {}, nativeProbes: {} };
  const bytes = readFileNoFollow(loc.file, { root: loc.home, maxBytes: MAX_STATE_BYTES });
  if (bytes === null) throw fail('decision state store is unsafe or unreadable');
  let state;
  try { state = JSON.parse(bytes); } catch { throw fail('decision state store is malformed'); }
  if (!object(state) || state.schema !== 1 || state.workspace !== loc.workspace || !['tasks', 'requests', 'observations', 'receipts'].every(key => object(state[key]))) throw fail('decision state store has invalid bindings');
  if (state.invocations === undefined) state.invocations = {};
  if (!object(state.invocations)) throw fail('native invocation state is malformed');
  if (state.nativeProbes === undefined) state.nativeProbes = {};
  if (!object(state.nativeProbes)) throw fail('native probe state is malformed');
  for (const [id, request] of Object.entries(state.requests)) {
    if (!object(request) || request.requestId !== id || !ID.test(id)) throw fail('decision state request is malformed');
    const { requestId, createdAt, ...packet } = request;
    if (hash(packet) !== requestId || !Number.isFinite(createdAt)) throw fail('decision state request integrity changed');
  }
  for (const [id, receipt] of Object.entries(state.receipts)) {
    if (!object(receipt) || receipt.requestId !== id || !Object.hasOwn(state.requests, id) || !ID.test(receipt.id || '')) throw fail('decision state receipt is malformed');
    const { id: receiptId, ...value } = receipt;
    if (hash({ ...value, consumedAt: null }) !== receiptId || receipt.authorized !== ['allow', 'acquire', 'ready'].includes(receipt.verdict)) throw fail('decision state receipt integrity changed');
  }
  return state;
}

/**
 * Well-formed warnings, the newest per request, at most MAX_STATE_WARNINGS. A
 * warning about a request leaves with it, except a readiness-index fault, which
 * stays at state level (requestId null), one per plan, until that plan's index
 * write succeeds. The one aggregated warning for plans archived over the cap
 * always keeps its slot.
 */
function stateWarnings(state) {
  const byKey = new Map();
  let archived = null;
  for (const item of Array.isArray(state.warnings) ? state.warnings : []) {
    if (!object(item) || !Number.isFinite(item.at) || typeof item.message !== 'string') continue;
    const fault = item.fault === READINESS_INDEX_FAULT;
    if (fault && Array.isArray(item.plans)) {
      const plans = item.plans.filter(plan => ID.test(plan || ''));
      if (!plans.length) continue;
      const merged = [...new Set([...(archived?.plans || []), ...plans])].sort().slice(0, MAX_ARCHIVED_PLAN_KEYS);
      archived = { at: Math.max(archived?.at ?? item.at, item.at), requestId: null, fault: READINESS_INDEX_FAULT, plans: merged, message: archivedOverCapMessage(merged.length) };
      continue;
    }
    const plan = fault && ID.test(item.plan || '') ? item.plan : null;
    const live = ID.test(item.requestId || '') && Object.hasOwn(state.requests, item.requestId);
    if (!live && !(fault && (item.requestId === null || ID.test(item.requestId || '')))) continue;
    const requestId = live ? item.requestId : null, key = requestId ?? (plan ? `plan:${plan}` : 'state');
    byKey.delete(key);
    byKey.set(key, { at: item.at, requestId, ...(fault ? { fault: READINESS_INDEX_FAULT } : {}), ...(plan ? { plan } : {}), message: Array.from(item.message).slice(0, 500).join('') });
  }
  const rest = [...byKey.values()];
  return archived ? [archived, ...rest.slice(-(MAX_STATE_WARNINGS - 1))] : rest.slice(-MAX_STATE_WARNINGS);
}

/**
 * A readiness-index warning clears only when its own plan's index write
 * succeeded; the aggregated warning drops each plan as its index is written.
 * A warning stored before plan identity existed clears on any successful write.
 */
function clearIndexed(item, indexed) {
  if (!object(item) || item.fault !== READINESS_INDEX_FAULT) return [item];
  if (Array.isArray(item.plans)) {
    const plans = item.plans.filter(plan => !indexed.has(plan));
    return plans.length ? [{ ...item, plans }] : [];
  }
  if (typeof item.plan === 'string') return indexed.has(item.plan) ? [] : [item];
  return indexed.size ? [] : [item];
}

function mutate(loc, callback) {
  fs.mkdirSync(loc.home, { recursive: true });
  const directory = path.join(loc.home, 'decisions');
  if (!assertNoSymlinkAncestors(loc.home, 'decisions')) throw fail('decision store directory is unsafe or redirected');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = `${loc.file}.lock`;
  if (!assertNoSymlinkAncestors(loc.home, path.relative(loc.home, lock))) throw fail('decision lock is unsafe');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw fail('decision state is busy; retry without resetting its budget'); throw error; }
  try {
    const state = readState(loc), result = callback(state);
    // Compaction warnings stay in the state, quietly, for decision status to
    // report. An index-fault warning clears on its own plan's next successful
    // index write; this pass's own faults stay.
    const report = {};
    const fresh = compactDecisions(loc, state, report).map(item => ({ at: loc.now, requestId: item.requestId, ...(item.fault ? { fault: item.fault } : {}), ...(item.plan ? { plan: item.plan } : {}), ...(item.plans ? { plans: item.plans } : {}), message: item.message }));
    const prior = (Array.isArray(state.warnings) ? state.warnings : []).flatMap(item => clearIndexed(item, report.indexedPlans || new Set()));
    const warnings = stateWarnings({ ...state, warnings: [...prior, ...fresh] });
    if (warnings.length) state.warnings = warnings; else delete state.warnings;
    const bytes = stable(state);
    if (Buffer.byteLength(bytes) > MAX_STATE_BYTES) throw fail('active decision capacity is full; finish or allow existing task budgets to expire without resetting their evidence');
    if (!writeFileContained(loc.home, loc.relative, `${bytes}\n`, { mode: 0o600 })) throw fail('decision state publication refused');
    return result;
  } finally { fs.rmdirSync(lock); }
}

function sourcesNow(workspace, sources = []) {
  if (!Array.isArray(sources) || sources.length > 64) throw fail('source paths must be a bounded list');
  return [...new Set(sources)].sort().map(relative => {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw fail('source path escapes the accepted workspace scope');
    const full = assertNoSymlinkAncestors(workspace, relative);
    if (!full) throw fail(`source is unsafe or symlinked: ${relative}`);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!stat) return { path: relative, state: 'absent', sha256: null };
    const bytes = readFileNoFollow(full, { root: workspace, maxBytes: 1024 * 1024, encoding: null });
    if (bytes === null) throw fail(`source is unsafe, nonregular or unreadable: ${relative}`);
    return { path: relative, state: 'regular', sha256: createHash('sha256').update(bytes).digest('hex') };
  });
}

function actionValue(workspace, action) {
  fields(action, ['tool', 'input', 'cwd'], 'action');
  text(action.tool, 'action tool', 120);
  if (!object(action.input)) throw fail('action input must be an object');
  const cwd = fs.realpathSync.native(path.resolve(action.cwd || workspace));
  if (!within(workspace, cwd)) throw fail('action cwd is outside the task workspace');
  const normalizedTool = normalizeToolPayload({ workspace, tool_name: action.tool, tool_input: action.input }).toolName;
  return bounded({ tool: nativeToolName(normalizedTool), input: action.input, cwd }, 'action', 16384);
}

function actionSources(workspace, action) {
  if (!action) return [];
  const normalized = normalizeToolPayload({ workspace, tool_name: action.tool, tool_input: action.input });
  const paths = normalized.targets.map(target => path.relative(workspace, path.resolve(workspace, target)).replaceAll('\\', '/'));
  for (const argv of normalized.terminalEffects.invocations || []) {
    const executable = path.basename(argv[0] || '').toLowerCase();
    if (['npm', 'pnpm', 'yarn', 'npx'].includes(executable) && fs.existsSync(path.join(workspace, 'package.json'))) paths.push('package.json');
    if (['node', 'python', 'python3', 'bash', 'sh'].includes(executable)) {
      const script = argv[1];
      if (script && !script.startsWith('-')) paths.push(path.relative(workspace, path.resolve(action.cwd, script)).replaceAll('\\', '/'));
    }
  }
  return paths;
}

function capabilityValue(value) {
  fields(value, ['operation', 'kind', 'name', 'path', 'tools', 'agents', 'textDigest', 'expectedDigest'], 'capability');
  if (!['create', 'update'].includes(value.operation) || !['skill', 'agent', 'instruction'].includes(value.kind) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name || '')) throw fail('capability requires a canonical operation, kind and name');
  if (!/^sha256-[a-f0-9]{64}$/.test(value.textDigest || '') || value.expectedDigest !== undefined && !/^sha256-[a-f0-9]{64}$/.test(value.expectedDigest)) throw fail('capability must bind its exact textDigest and optional expectedDigest');
  if (value.path !== undefined && (typeof value.path !== 'string' || !path.isAbsolute(value.path))) throw fail('capability native path must be absolute');
  for (const key of ['tools', 'agents']) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > 64 || value[key].some(item => typeof item !== 'string' || !item || item.length > 200))) throw fail(`capability ${key} must be bounded names`);
  return { operation: value.operation, kind: value.kind, name: value.name, path: value.path === undefined ? null : path.resolve(value.path),
    tools: normalizeCapabilityTools(value.tools || []), agents: [...new Set(value.agents || [])].sort(), textDigest: value.textDigest, expectedDigest: value.expectedDigest || null };
}

function memoryValue(value) {
  fields(value, ['operation', 'kind', 'scope', 'destination', 'contentDigest', 'proofIdentity'], 'memory');
  if (value.operation !== 'publish' || !['fix', 'insight'].includes(value.kind) || !['private', 'global', 'ship-set-proposal'].includes(value.scope)) throw fail('memory requires a supported publication kind and scope');
  if (typeof value.destination !== 'string' || value.destination.length > 4096 || !path.isAbsolute(value.destination) || path.resolve(value.destination) !== value.destination || /[\u0000-\u001f\u007f]/.test(value.destination)) throw fail('memory destination must be an exact absolute file path');
  if (!/^sha256-[a-f0-9]{64}$/.test(value.contentDigest || '') || value.proofIdentity !== null && !ID.test(value.proofIdentity || '')) throw fail('memory contentDigest or proofIdentity is invalid');
  return { operation: value.operation, kind: value.kind, scope: value.scope, destination: value.destination, contentDigest: value.contentDigest, proofIdentity: value.proofIdentity };
}

function memoryTargetNow(memory) {
  const root = path.parse(memory.destination).root, relative = path.relative(root, memory.destination);
  if (!relative || !assertNoSymlinkAncestors(root, relative)) throw fail('memory destination is unsafe or redirected');
  const stat = fs.lstatSync(memory.destination, { throwIfNoEntry: false });
  if (!stat) return { state: 'absent', sha256: null };
  const bytes = readFileNoFollow(memory.destination, { root, maxBytes: 1024 * 1024, encoding: null });
  if (bytes === null || stat.nlink !== 1) throw fail('memory destination is unsafe, nonregular or unreadable');
  return { state: 'regular', sha256: createHash('sha256').update(bytes).digest('hex') };
}

function taskBudget(task, policy, now) {
  if (!task || !Number.isFinite(task.startedAt) || !object(task.counts) || ['decisions', 'repairs', 'acquisitions'].some(key => !Number.isSafeInteger(task.counts[key]) || task.counts[key] < 0)) throw fail('task state is malformed');
  if (now < task.startedAt || now - task.startedAt > policy.budgets.maxSeconds * 1000) throw fail('task time budget expired; escalate without renewing the task');
}

function acceptedPlan(options, input, workspace) {
  const plan = input.planPath ? loadPlan(workspace, input.planPath, { home: options.home }) : null;
  return plan?.plan_lock ? { path: plan.fullPath, digest: hash(planContractText(plan.text)) } : null;
}

function budgetIdentity(input, plan) {
  // taskId is a display label authored by Engineer. It cannot renew a budget.
  // Accepted plans retain one budget across sessions; otherwise the actual
  // observed native session is the boundary checked again on result ingestion.
  return hash(plan ? { plan: plan.path } : { session: input.sessionId });
}

function readinessNow(options, packet) {
  if (!packet.planPath || typeof review.reviewReadinessEvidence !== 'function') return { ready: false, binding: null, failures: ['Authoritative readiness plan/proof is unavailable'] };
  try { return bounded(review.reviewReadinessEvidence({ workspace: options.workspace, home: options.home, copilotHome: options.copilotHome, planPath: packet.planPath }), 'readiness evidence'); }
  catch (error) { return { ready: false, binding: null, failures: [`Authoritative readiness failed: ${error.message}`] }; }
}

function currentRequest(options, packet, policy) {
  try {
    if (!policy.enabled || policy.revision !== packet.policyRevision) return { current: false, reason: 'Standing authority is absent, changed or revoked' };
    if (packet.planBinding && stable(acceptedPlan(options, packet, options.workspace)) !== stable(packet.planBinding)) return { current: false, reason: 'Accepted task scope or plan contract changed after the decision request' };
    if (stable(sourcesNow(options.workspace, packet.sources.map(source => source.path))) !== stable(packet.sources)) return { current: false, reason: 'Bound source bytes changed after the decision request' };
    if (packet.type === 'memory' && stable(memoryTargetNow(packet.memory)) !== stable(packet.memoryTarget)) return { current: false, reason: 'Exact memory destination changed after the decision request' };
    if (packet.type === 'readiness' && stable(readinessNow(options, packet).binding) !== stable(packet.readiness.binding)) return { current: false, reason: 'Readiness proof, review or tour changed after the decision request' };
    return { current: true, reason: 'Exact action, source versions and standing consent are current' };
  } catch (error) { return { current: false, reason: error.message }; }
}

/** Prepare bounded context only. The host, not this CLI, executes decision-agent. */
export function prepareDecision(options) {
  const input = options.input;
  fields(input, ['schema', 'operation', 'taskId', 'sessionId', 'type', 'intent', 'action', 'sources', 'context', 'planPath', 'capability', 'memory'], 'prepare input');
  if (input.schema !== 1 || !TYPES.has(input.type)) throw fail('prepare requires schema 1 and a supported decision type');
  const taskId = text(input.taskId, 'taskId', 1024), sessionId = text(input.sessionId, 'sessionId', 200), intent = text(input.intent, 'intent', 4000);
  const loc = locations(options), policy = authority(options.policy), now = options.now ?? Date.now();
  if (!policy.enabled || !policy.types.includes(input.type)) throw fail('standing authority does not enable this decision type');
  const action = input.action === undefined ? null : actionValue(loc.workspace, input.action);
  if (input.type === 'action' && !action) throw fail('action decisions require the exact action');
  if (input.type === 'capability' && !input.capability) throw fail('capability decisions require the exact draft');
  if (input.type === 'memory' && !input.memory) throw fail('memory decisions require the exact publication');
  if (input.sources !== undefined && !Array.isArray(input.sources)) throw fail('source paths must be a bounded list');
  const planBinding = acceptedPlan(options, input, loc.workspace);
  const packet = { schema: 1, taskId, sessionId, budgetKey: budgetIdentity(input, planBinding), planBinding, type: input.type, intent, workspace: loc.workspace, policyRevision: policy.revision, sources: sourcesNow(loc.workspace, [...(input.sources || []), ...actionSources(loc.workspace, action)]),
    action, context: bounded(input.context || {}, 'decision context'), capability: input.capability ? capabilityValue(input.capability) : null,
    planPath: input.planPath === undefined ? null : text(input.planPath, 'planPath', 4096), modelExecution: 'host-native', authority: 'Recommendation within standing user consent; no new permissions granted',
    sourceCoverage: 'Explicit selected files only; external effects and undeclared script dependencies are not inferred', budgets: policy.budgets };
  if (packet.type === 'memory') {
    packet.memory = memoryValue(input.memory);
    if (typeof packet.context.memoryContent !== 'string' || `sha256-${hash(packet.context.memoryContent)}` !== packet.memory.contentDigest) throw fail('memory content must contain the exact serialized publication in context.memoryContent');
    packet.memoryTarget = memoryTargetNow(packet.memory);
  }
  if (packet.type === 'capability' && (typeof packet.context.capabilityText !== 'string' || `sha256-${hash(packet.context.capabilityText)}` !== packet.capability.textDigest)) throw fail('capability draft must contain the exact canonical text in context.capabilityText');
  if (packet.type === 'readiness') packet.readiness = readinessNow({ ...options, ...loc }, packet);
  const requestId = hash(packet);
  return mutate(loc, state => {
    const taskKey = packet.budgetKey;
    let task = decisionTask(loc, state, taskKey);
    if (!task) task = state.tasks[taskKey] = { startedAt: now, counts: { decisions: 0, repairs: 0, acquisitions: 0 } };
    taskBudget(task, policy, now);
    if (!hydrateArchivedDecision(loc, state, requestId)) {
      if (task.counts.decisions >= policy.budgets.maxDecisions) throw fail('task decision budget exhausted; escalate');
      task.counts.decisions++;
      state.requests[requestId] = { ...packet, requestId, createdAt: now };
    }
    return { schema: 1, operation: 'prepare', status: 'prepared', requestId, packet: state.requests[requestId], storePath: loc.file,
      recordCommand: [process.execPath, fileURLToPath(new URL('../bin/ae.mjs', import.meta.url)), 'resources', 'decision', '--file', '-', '--workspace', loc.workspace, '--ae-home', loc.home,
        ...(options.copilotHome ? ['--copilot-home', options.copilotHome] : []), ...(options.skillsHome ? ['--skills-home', options.skillsHome] : []), '--json'],
      next: 'Invoke the native decision-agent with this packet, then use recordCommand with the schema 1 record request on stdin. No decision API is called.' };
  });
}

function parseJudgment(value) {
  fields(value, ['schema', 'requestId', 'verdict', 'reason', 'evidence'], 'native judgment');
  if (value.schema !== 1 || !ID.test(value.requestId || '') || !VERDICTS.has(value.verdict)) throw fail('native judgment has invalid schema, request or verdict');
  text(value.reason, 'judgment reason', 4000);
  if (!Array.isArray(value.evidence) || value.evidence.length > 32 || value.evidence.some(item => typeof item !== 'string' || !item.trim() || item.length > 2000)) throw fail('native judgment evidence must be bounded strings');
  return bounded(value, 'native judgment', 32768);
}

function outputObject(value) {
  if (typeof value === 'string') {
    if (value.length > 65536) throw fail('native decision output exceeds its bound');
    return JSON.parse(value);
  }
  if (object(value)) {
    const texts = ['textResultForLlm', 'text_result_for_llm'].filter(key => typeof value[key] === 'string').map(key => value[key]);
    if (typeof value.content === 'string') texts.push(value.content);
    if (Array.isArray(value.content) && value.content.length === 1 && value.content[0]?.type === 'text') texts.push(value.content[0].text);
    if (texts.length) {
      const parsed = texts.map(outputObject);
      if (parsed.some(item => stable(item) !== stable(parsed[0]))) throw fail('native decision result aliases conflict');
      return parsed[0];
    }
  }
  if (object(value)) return value;
  throw fail('native decision output must contain one complete JSON judgment');
}

/** Post-hook adapter observation, not a cryptographically authenticated transcript. */
export function observeDecisionInvocation(options) {
  const payload = options.payload || {}, normalized = normalizeToolPayload(payload);
  if (!aliasesAgree(payload)) return { observed: false, reason: 'Native event aliases conflict' };
  const sessionId = sameAlias(payload, ['session_id', 'sessionId']);
  const event = sameAlias(payload, ['hook_event_name', 'hookEventName']);
  const subagentStop = event === 'SubagentStop' || event === 'subagentStop' || !event && typeof payload.agentName === 'string' && typeof payload.response === 'string' && payload.stopReason === 'end_turn';
  const tool = subagentStop ? 'SubagentStop' : nativeToolName(payload.ae_native_tool_name || payload.tool_name || payload.toolName);
  const namedStopRole = sameAlias(payload, ['agent_name', 'agentName']), typedStopRole = sameAlias(payload, ['agent_type', 'agentType']);
  if (subagentStop && (['agent_name', 'agentName'].some(key => payload[key] !== undefined && payload[key] !== null) && !namedStopRole
    || ['agent_type', 'agentType'].some(key => payload[key] !== undefined && payload[key] !== null) && !typedStopRole)) return { observed: false };
  const role = subagentStop ? namedStopRole || typedStopRole : decisionRole(normalized.toolInput);
  const stopReason = sameAlias(payload, ['stop_reason', 'stopReason']);
  const stopReasonInvalid = subagentStop && (stopReason !== null && stopReason !== 'end_turn' || ['stop_reason', 'stopReason'].some(key => payload[key] !== undefined && payload[key] !== null) && stopReason === null || namedStopRole && stopReason !== 'end_turn');
  let invocationId = subagentStop ? sameAlias(payload, ['agent_id', 'agentId']) : sameAlias(payload, ['tool_use_id', 'tool_call_id', 'toolCallId']);
  const results = subagentStop ? [sameAlias(payload, ['last_assistant_message', 'response'])] : [payload.tool_response, payload.tool_result, payload.toolResult].filter(value => value !== undefined);
  const isCopilotPost = results.some(result => object(result) && (result.resultType === 'success' && typeof result.textResultForLlm === 'string' || result.result_type === 'success' && typeof result.text_result_for_llm === 'string'));
  if (!invocationId && tool === 'Agent' && isCopilotPost && (Number.isFinite(payload.timestamp) || typeof payload.timestamp === 'string' && Number.isFinite(Date.parse(payload.timestamp)))) {
    // The documented Copilot command-hook schema carries no tool-call ID.
    // Identify its observed event by a digest, without inventing a host ID.
    invocationId = `copilot-post-event:${hash({ sessionId, timestamp: payload.timestamp, tool, input: normalized.toolInput, results })}`;
  }
  if (!['Agent', 'spawn_agent', 'wait_agent', 'SubagentStop'].includes(tool) || typeof sessionId !== 'string' || !sessionId || typeof invocationId !== 'string' || !invocationId || payload.truncated === true || !toolMutationSucceeded(payload)
    || normalized.terminalEffects.hasOpaque || stopReasonInvalid) return { observed: false };
  try {
    if (!results.length || results.some(result => result?.truncated === true || object(result) && ['result_type', 'resultType'].some(key => Object.hasOwn(result, key) && result[key] !== 'success'))) return { observed: false };
    const raw = outputObject(results[0]);
    if (results.some(result => stable(outputObject(result)) !== stable(raw))) return { observed: false };
    const loc = locations(options), now = options.now ?? Date.now();
    if (payload.cwd && fs.realpathSync.native(payload.cwd) !== loc.workspace) return { observed: false };
    if (tool === 'spawn_agent') {
      if (role !== 'decision-agent' || typeof normalized.toolInput.message !== 'string') return { observed: false };
      const supplied = outputObject(normalized.toolInput.message), result = raw, request = hydrateArchivedDecision(loc, readState(loc), supplied.requestId);
      if (!request || request.sessionId !== sessionId || typeof result.agent_id !== 'string' || !result.agent_id || result.agent_id.length > 200) return { observed: false };
      return mutate(loc, state => {
        hydrateArchivedDecision(loc, state, request.requestId);
        if (state.receipts[request.requestId]) return { observed: false, reason: 'Terminal decision requests cannot start another retained child invocation' };
        const key = hash(result.agent_id), prior = state.invocations[key];
        if (prior && (prior.requestId !== request.requestId || prior.sessionId !== request.sessionId)) throw fail('native child identity was already bound');
        state.invocations[key] = prior || { agentId: result.agent_id, requestId: request.requestId, sessionId: request.sessionId, invocationId, observedAt: now };
        return { observed: false, pending: true, requestId: request.requestId, agentId: result.agent_id };
      });
    }
    return mutate(loc, current => {
      let judgment, nativeInvocationId = invocationId;
      if (tool === 'wait_agent') {
        const ids = normalized.toolInput.ids, result = raw;
        if (!Array.isArray(ids) || ids.length > 64 || !object(result.status)) return { observed: false };
        const completed = ids.map(id => ({ pending: current.invocations[hash(id)], output: result.status[id]?.completed })).filter(item => item.pending?.sessionId === sessionId && item.output !== undefined);
        if (completed.length !== 1) return { observed: false };
        judgment = parseJudgment(outputObject(completed[0].output));
        if (judgment.requestId !== completed[0].pending.requestId) return { observed: false };
        nativeInvocationId = `${completed[0].pending.invocationId}/${invocationId}`;
      } else {
        if (role !== 'decision-agent') return { observed: false };
        judgment = parseJudgment(outputObject(raw));
      }
      const request = hydrateArchivedDecision(loc, current, judgment.requestId);
      if (!request || request.sessionId !== sessionId || request.workspace !== loc.workspace || now < request.createdAt) return { observed: false };
      const observation = { schema: 1, requestId: request.requestId, sessionId: request.sessionId, invocationId: nativeInvocationId, agent: 'decision-agent', tool, observedAt: now, judgment,
        provenance: 'post-hook-adapter-observation', assurance: 'Recorded native event; not an authenticated host transcript' };
      const previous = current.observations[request.requestId];
      if (Object.values(current.observations).some(item => item.invocationId === nativeInvocationId && item.requestId !== request.requestId)) throw fail('native invocation was already bound to a different request');
      if (previous && stable(previous.judgment) !== stable(judgment)) throw fail('conflicting native judgments require a new decision request');
      current.observations[request.requestId] = previous || observation;
      return { observed: true, requestId: request.requestId, invocationId: (previous || observation).invocationId };
    });
  } catch (error) { return { observed: false, reason: error.message }; }
}

function permission(packet, verdict, policy, options) {
  if (!policy.enabled) return 'Standing decision authority has been revoked';
  if (verdict === 'ready') {
    if (packet.type !== 'readiness') return 'Readiness verdict cannot authorize an action';
    const facts = readinessNow(options, packet);
    if (!facts.ready) return `Readiness remains blocked: ${(facts.failures || []).join('; ')}`;
    return null;
  }
  if (verdict === 'acquire') {
    const resource = packet.capability;
    if (packet.type !== 'capability' || !object(resource) || !['create', 'update'].includes(resource.operation) || !policy[resource.operation].includes(resource.kind)) return 'Standing authority does not cover this capability acquisition';
    if (resource.tools !== undefined && (!Array.isArray(resource.tools) || normalizeCapabilityTools(resource.tools).some(tool => !policy.tools.includes(tool)))) return 'Requested specialist tools exceed standing authority';
    if (resource.agents.some(agent => !policy.agents.includes(agent))) return 'Requested specialist delegation exceeds standing authority';
    return null;
  }
  if (verdict === 'allow') {
    if (packet.type === 'readiness') return 'Readiness requires a ready verdict and authoritative proof';
    if (packet.type === 'action' && !normalizeCapabilityTools([packet.action.tool]).every(tool => policy.tools.includes(tool))) return 'The action tool exceeds standing authority';
    if (packet.type === 'memory' && (!policy.memory || packet.memory?.scope !== 'private')) return 'Automatic memory publication is outside standing private memory authority';
    return null;
  }
  return null;
}

export function recordDecision(options) {
  fields(options.input, ['schema', 'operation', 'requestId'], 'record input');
  if (options.input.schema !== 1 || !ID.test(options.input.requestId || '')) throw fail('record requires schema 1 and requestId');
  const loc = locations(options), policy = authority(options.policy), now = options.now ?? Date.now();
  return mutate(loc, state => {
    const request = hydrateArchivedDecision(loc, state, options.input.requestId);
    if (!request) throw fail('unknown decision request');
    const task = decisionTask(loc, state, request.budgetKey);
    taskBudget(task, policy, now);
    const current = currentRequest({ ...options, ...loc }, request, policy);
    if (!current.current) throw fail(current.reason);
    if (state.receipts[request.requestId]) return state.receipts[request.requestId];
    const observation = state.observations[request.requestId];
    if (!observation) throw fail('no observed native decision-agent invocation exists for this request');
    let { verdict, reason } = observation.judgment;
    const refusal = permission(request, verdict, policy, { ...options, ...loc });
    if (refusal) { verdict = 'escalate'; reason = refusal; }
    const counter = verdict === 'revise' ? 'repairs' : verdict === 'acquire' ? 'acquisitions' : null;
    if (counter) {
      const limit = counter === 'repairs' ? policy.budgets.maxRepairs : policy.budgets.maxAcquisitions;
      if (task.counts[counter] >= limit) { verdict = 'escalate'; reason = `Task ${counter} budget exhausted; human decision or narrower work is required`; }
      else task.counts[counter]++;
    }
    const value = { schema: 1, requestId: request.requestId, taskId: request.taskId, sessionId: request.sessionId, type: request.type, verdict, reason,
      authorized: ['allow', 'acquire', 'ready'].includes(verdict), policyRevision: policy.revision, observedInvocation: observation.invocationId,
      observationAssurance: observation.assurance, evidence: observation.judgment.evidence, recordedAt: now, consumedAt: null };
    const receipt = { ...value, id: hash(value) };
    state.receipts[request.requestId] = receipt;
    return receipt;
  });
}

export function decisionStatus(options) {
  const loc = locations(options), state = readState(loc), policy = authority(options.policy);
  const request = options.requestId ? hydrateArchivedDecision(loc, state, options.requestId) : Object.values(state.requests).filter(item => item.taskId === options.taskId).sort((a, b) => b.createdAt - a.createdAt)[0];
  const taskId = options.taskId || request?.taskId, task = request ? decisionTask(loc, state, request.budgetKey) : null;
  const live = stateWarnings(state), warnings = live.length ? { warnings: live } : {};
  if (!task) return { schema: 1, status: 'missing', counts: { decisions: 0, repairs: 0, acquisitions: 0 }, current: false, ...warnings };
  let result = request ? currentRequest({ ...options, ...loc }, request, policy) : { current: policy.enabled, reason: 'Task status; inspect an exact request for freshness' };
  try { taskBudget(task, policy, options.now ?? Date.now()); } catch (error) { result = { current: false, reason: error.message }; }
  return { schema: 1, status: result.current ? 'current' : 'stale', taskId, counts: task.counts, budgets: policy.budgets, ...result, receipt: request ? state.receipts[request.requestId] || null : null, ...warnings };
}

export function inspectDecisionAction(options) {
  const loc = locations(options), policy = authority(options.policy), action = actionValue(loc.workspace, options.action), now = options.now ?? Date.now();
  const inspect = state => {
    for (const request of Object.values(state.requests)) {
      if (request.type !== 'action' || request.sessionId !== options.sessionId || stable(request.action) !== stable(action)) continue;
      const receipt = state.receipts[request.requestId];
      if (!receipt?.authorized || receipt.verdict !== 'allow' || receipt.consumedAt !== null) continue;
      const current = currentRequest({ ...options, ...loc }, request, policy);
      if (!current.current || permission(request, 'allow', policy, options)) continue;
      try { taskBudget(decisionTask(loc, state, request.budgetKey), policy, now); } catch { continue; }
      if (options.consume) {
        receipt.consumedAt = now;
        if (options.probeResource) {
          const resource = nativeResourceBinding(options.probeResource);
          state.nativeProbes[request.requestId] = { schema: 1, requestId: request.requestId, receiptId: receipt.id, sessionId: request.sessionId,
            role: resource.id, policyRevision: policy.revision, consumedAt: now, action: request.action, resource };
        }
      }
      return { authorized: true, requestId: request.requestId, receiptId: receipt.id, consumed: Boolean(options.consume), assurance: receipt.observationAssurance };
    }
    return { authorized: false, reason: 'No current unconsumed native decision receipt matches this exact action and session' };
  };
  return options.consume ? mutate(loc, inspect) : inspect(readState(loc));
}

function nativeResourceBinding(resource) {
  if (!object(resource) || typeof resource.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(resource.id) || typeof resource.path !== 'string' || !path.isAbsolute(resource.path)
    || !/^sha256-[a-f0-9]{64}$/.test(resource.digest || '') || resource.sourceDigest !== undefined && resource.sourceDigest !== null && !/^sha256-[a-f0-9]{64}$/.test(resource.sourceDigest)) throw fail('native probe resource binding is invalid');
  return { id: resource.id, path: path.resolve(resource.path), digest: resource.digest, sourceDigest: resource.sourceDigest || null };
}

/** Internal hook verifier: only an exact consumed pending-role action creates a probe. */
export function inspectNativeProbe(options) {
  const loc = locations(options), policy = authority(options.policy), state = readState(loc), resource = nativeResourceBinding(options.resource), now = options.now ?? Date.now();
  if (options.requestId) hydrateArchivedDecision(loc, state, options.requestId);
  const candidates = [];
  for (const probe of Object.values(state.nativeProbes)) {
    if (options.requestId && probe.requestId !== options.requestId) continue;
    if (probe.sessionId !== options.sessionId || probe.role !== options.role || probe.policyRevision !== policy.revision || stable(probe.resource) !== stable(resource)) continue;
    const request = state.requests[probe.requestId], receipt = state.receipts[probe.requestId];
    if (!request || !receipt?.authorized || receipt.verdict !== 'allow' || receipt.id !== probe.receiptId || receipt.consumedAt !== probe.consumedAt || !Number.isFinite(probe.consumedAt)
      || stable(request.action) !== stable(probe.action) || !currentRequest({ ...options, ...loc }, request, policy).current || permission(request, 'allow', policy, options)) continue;
    if (options.action && stable(actionValue(loc.workspace, options.action)) !== stable(probe.action)) continue;
    try { taskBudget(decisionTask(loc, state, request.budgetKey), policy, now); } catch { continue; }
    candidates.push(probe);
  }
  return candidates.length === 1 ? { authorized: true, ...candidates[0] } : { authorized: false, reason: 'No unique current consumed action receipt binds this pending native role, source and session' };
}

export function inspectCapabilityDecision(options) {
  const loc = locations(options), policy = authority(options.policy), capability = capabilityValue(options.capability), now = options.now ?? Date.now();
  const inspect = state => {
    for (const request of Object.values(state.requests)) {
      if (request.type !== 'capability' || request.sessionId !== options.sessionId || stable(request.capability) !== stable(capability)) continue;
      const receipt = state.receipts[request.requestId];
      if (!receipt?.authorized || receipt.verdict !== 'acquire' || receipt.consumedAt !== null || !currentRequest({ ...options, ...loc }, request, policy).current || permission(request, 'acquire', policy, options)) continue;
      try { taskBudget(decisionTask(loc, state, request.budgetKey), policy, now); } catch { continue; }
      if (options.consume) receipt.consumedAt = now;
      return { authorized: true, requestId: request.requestId, receiptId: receipt.id, consumed: Boolean(options.consume), assurance: receipt.observationAssurance };
    }
    return { authorized: false, reason: 'No current unconsumed native acquisition decision matches the exact resource identity, bytes, tools and session' };
  };
  return options.consume ? mutate(loc, inspect) : inspect(readState(loc));
}

/** Only the memory publisher consumes this receipt after deriving final bytes and destination. */
export function inspectMemoryDecision(options) {
  const loc = locations(options), policy = authority(options.policy), memory = memoryValue(options.memory), now = options.now ?? Date.now();
  const inspect = state => {
    for (const request of Object.values(state.requests)) {
      if (request.type !== 'memory' || request.sessionId !== options.sessionId || stable(request.memory) !== stable(memory)) continue;
      const receipt = state.receipts[request.requestId];
      if (!receipt?.authorized || receipt.verdict !== 'allow' || receipt.consumedAt !== null || !currentRequest({ ...options, ...loc }, request, policy).current || permission(request, 'allow', policy, options)) continue;
      try { taskBudget(decisionTask(loc, state, request.budgetKey), policy, now); } catch { continue; }
      if (options.consume) receipt.consumedAt = now;
      return { authorized: true, requestId: request.requestId, receiptId: receipt.id, consumed: Boolean(options.consume), assurance: receipt.observationAssurance };
    }
    return { authorized: false, reason: 'No current unconsumed native memory decision matches the exact bytes, destination, proof and session' };
  };
  return options.consume ? mutate(loc, inspect) : inspect(readState(loc));
}

export function decisionResultOf(options) {
  if (!object(options.input)) throw fail('decision input must be an object');
  if (options.input.operation === 'prepare') return prepareDecision(options);
  if (options.input.operation === 'record') return recordDecision(options);
  if (options.input.operation === 'status') {
    fields(options.input, ['schema', 'operation', 'taskId', 'requestId'], 'status input');
    if (options.input.schema !== 1) throw fail('status requires schema 1');
    return decisionStatus({ ...options, taskId: options.input.taskId, requestId: options.input.requestId });
  }
  throw fail('unsupported decision operation; use prepare, record or status');
}

/** Optional pre-tool layer. It supplements rather than replaces existing plan/host controls. */
export function guardDecisionTool(options) {
  const policy = authority(options.policy);
  if (!policy.enabled) return { continue: true };
  try {
    const payload = options.payload || {}, normalized = normalizeToolPayload(payload);
    if (!aliasesAgree(payload)) throw fail('Native tool event aliases conflict');
    const receiptPermission = receipt => ({ continue: true, decisionReceipt: receipt.receiptId,
      ...(normalized.toolInput.requestSandboxBypass === true || normalized.toolInput.dangerouslyDisableSandbox === true || normalized.toolInput.sandbox_permissions === 'require_escalated'
        ? {} : { permissionDecision: 'allow', permissionDecisionReason: `Current exact native decision receipt ${receipt.receiptId} covers this action within standing user authority` }) });
    const nativeTool = nativeToolName(payload.ae_native_tool_name || payload.tool_name || payload.toolName);
    if (decisionInputStaging(payload, normalized)) return { continue: true, mediation: 'bounded-decision-input-staging' };
    if (['Agent', 'Task', 'spawn_agent'].includes(nativeTool)) {
      if (normalized.terminalEffects.hasOpaque) throw fail('Native delegation aliases conflict');
      const role = decisionRole(normalized.toolInput);
      const resource = typeof options.resolveAgent === 'function' && typeof role === 'string' ? options.resolveAgent(role) : null;
      if (role === 'decision-agent') return resource?.id === role && resource.included && resource.current && resource.invocable && resource.tools.every(tool => ['read', 'search'].includes(tool)) && resource.agents.length === 0
        ? { continue: true, mediation: 'bounded-native-decision-role' }
        : { permissionDecision: 'deny', permissionDecisionReason: 'The included decision-agent definition is absent, stale, or exceeds bounded read-only judgment authority', continue: false };
      if (resource?.id === role && resource.included && resource.current && resource.invocable && resource.tools.every(tool => policy.tools.includes(tool)) && resource.agents.every(agent => policy.agents.includes(agent))) return { continue: true, mediation: 'included-native-specialist', nativeQualification: resource.nativeQualification || 'unverified' };
      if (resource?.id === role && resource.included && resource.current && resource.activation === 'pending-reload' && resource.tools.every(tool => policy.tools.includes(tool)) && resource.agents.every(agent => policy.agents.includes(agent))) {
        const action = { tool: nativeTool, input: normalized.toolInput, cwd: normalized.workspace };
        const probe = inspectDecisionAction({ ...options, workspace: normalized.workspace, sessionId: normalized.sessionId, action, consume: true, probeResource: resource });
        if (probe.authorized) return { ...receiptPermission(probe), mediation: 'receipt-bound-pending-native-probe', nativeQualification: 'unverified' };
      }
      return { permissionDecision: 'deny', permissionDecisionReason: 'Native specialist is not an included current resource within standing tool authority; refresh or acquire that capability before delegation', continue: false };
    }
    if (['wait_agent', 'close_agent'].includes(nativeTool)) return { continue: true, mediation: 'native-result-or-cancellation-control' };
    // Native read/dispatch controls remain available so the judge can inspect a
    // request and Engineer can obtain a verdict without recursive authorization.
    if (NATIVE_LOCAL_INSPECTION.has(nativeTool) && LOCAL_INSPECTION.has(normalized.toolName) && !normalized.mutation && !normalized.terminalEffects.hasOpaque && !TERMINAL_TOOLS.has(normalized.toolName)) {
      const readRoots = [normalized.workspace, ...policy.readRoots];
      if (normalized.targets.every(target => readRoots.some(root => {
        const absolute = path.resolve(normalized.workspace, target), relative = path.relative(path.resolve(root), absolute);
        return within(path.resolve(root), absolute) && Boolean(assertNoSymlinkAncestors(root, relative));
      }))) return { continue: true };
    }
    if (normalized.command && !normalized.terminalEffects.ambiguous) {
      const invocations = normalized.terminalEffects.invocations;
      const control = invocations.length === 1 ? harnessControlCommand(invocations[0], normalized.workspace) : null;
      // Exact bounded writers perform the final content-bound acquisition check
      // after reading stdin, where the pre-tool hook cannot inspect those bytes.
      const isResourceCreate = control === 'resources' && invocations[0]?.[2] === 'resources' && invocations[0]?.[3] === 'create';
      if (control && isResourceCreate) return { continue: true, mediation: 'bounded-writer-acquisition-receipt' };
      if (control) return { continue: true };
    }
    const action = { tool: nativeTool, input: normalized.toolInput, cwd: normalized.workspace };
    const checked = inspectDecisionAction({ ...options, workspace: normalized.workspace, sessionId: normalized.sessionId, action, consume: true });
    if (checked.authorized) return receiptPermission(checked);
    return { permissionDecision: 'deny', permissionDecisionReason: `${checked.reason}. Prepare an action packet using the host setup's absolute installed Node/package argv for resources decision --file, invoke native decision-agent, and record its observed verdict before retrying.`, continue: false };
  } catch (error) { return { permissionDecision: 'deny', permissionDecisionReason: error.message, continue: false }; }
}

/** Read-only: the newest recorded readiness receipt for a plan, for feedback records to cite. Never authority. */
export function latestReadinessReceipt(options) {
  let state, loc;
  try { loc = locations(options); state = readState(loc); } catch { return null; }
  let latest = null;
  for (const receipt of Object.values(state.receipts)) {
    if (receipt?.type !== 'readiness' || !ID.test(receipt.id || '')) continue;
    if (state.requests[receipt.requestId]?.planPath !== options.planPath) continue;
    if (!latest || receipt.recordedAt > latest.recordedAt) latest = receipt;
  }
  // Compaction moves terminal receipts out of live state; its retained index still names the newest one.
  try {
    const archived = latestArchivedReadiness(loc, options.planPath);
    if (archived && (!latest || archived.recordedAt > latest.recordedAt)) latest = archived;
  } catch { /* retained evidence unreadable: cite live state only */ }
  return latest ?{ id: latest.id, requestId: latest.requestId, verdict: latest.verdict, recordedAt: latest.recordedAt } : null;
}
