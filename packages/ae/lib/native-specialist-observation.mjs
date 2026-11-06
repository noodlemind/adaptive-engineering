import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertNoSymlinkAncestors, readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import * as decisions from './decision-agent.mjs';
import * as review from './review.mjs';
import * as catalog from './capability-catalog.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { normalizeToolPayload, toolMutationSucceeded } from '../corpus/hooks/lib/tool-payload.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = value => JSON.stringify(value, (_, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const fail = message => Object.assign(new Error(`Native specialist observation: ${message}`), { code: 'E_TARGET', exit: 1 });
const nativeName = name => ['Agent', 'Task', 'task'].includes(name) ? 'Agent' : name;
const within = (root, full) => full === root || full.startsWith(root + path.sep);
const alias = (value, names) => {
  const values = names.map(name => value[name]).filter(item => item !== undefined && item !== null);
  if (!values.length) return null;
  if (values.some(item => stable(item) !== stable(values[0]))) throw fail('native event aliases conflict');
  return values[0];
};
const roleOf = input => alias(input || {}, ['subagent_type', 'agent_type', 'agent']) || input?.name;

function resourceBinding(resource) {
  const value = { id: resource?.id || resource?.name, path: resource?.path, digest: resource?.digest, sourceDigest: resource?.sourceDigest || null };
  if (typeof value.id !== 'string' || typeof value.path !== 'string' || !path.isAbsolute(value.path) || !/^sha256-[a-f0-9]{64}$/.test(value.digest || '') || value.sourceDigest !== null && !/^sha256-[a-f0-9]{64}$/.test(value.sourceDigest)) throw fail('current resource binding is incomplete');
  return value;
}

function locations(options) {
  const workspace = fs.realpathSync.native(path.resolve(options.workspace));
  return locationsForWorkspace(options, workspace);
}

function locationsForWorkspace(options, workspace) {
  const selectedHome = options.home || harnessGlobalHome();
  if (typeof selectedHome !== 'string' || !path.isAbsolute(selectedHome)) throw fail('external state home is required');
  const home = path.resolve(selectedHome), relative = `native-specialist-observations/${hash(workspace)}.json`;
  if (within(workspace, home) || !assertNoSymlinkAncestors(path.parse(home).root, path.relative(path.parse(home).root, home)) || !assertNoSymlinkAncestors(home, relative)) throw fail('observation state path is unsafe');
  return { workspace, home, relative, file: path.join(home, relative), archive: `native-specialist-observations/archive/${hash(workspace)}` };
}

function historicalLocations(options) {
  const workspace = options.workspace;
  if (typeof workspace !== 'string' || workspace.length > 4096 || !path.isAbsolute(workspace) || path.resolve(workspace) !== workspace || workspace === path.parse(workspace).root || /[\u0000-\u001f\u007f]/.test(workspace)) throw fail('recorded workspace must be an exact canonical absolute identity');
  // A retired worktree may no longer exist. Read only the archive keyed by its
  // originally canonical identity; never resolve or read the old product path.
  return locationsForWorkspace(options, workspace);
}

function archiveRelative(loc, kind, id) {
  if (!['activation', 'review', 'review-index', 'pending', 'pending-completion'].includes(kind) || !/^[a-f0-9]{64}$/.test(id || '')) throw fail('archive identity is invalid');
  return `${loc.archive}/${kind}/${id}.json`;
}

function readArchive(loc, kind, id) {
  const relative = archiveRelative(loc, kind, id), full = path.join(loc.home, relative);
  if (!assertNoSymlinkAncestors(loc.home, relative)) throw fail('observation archive is unsafe');
  const text = readFileNoFollow(full, { root: loc.home, maxBytes: 2 * 1024 * 1024 });
  if (text === null) {
    if (fs.lstatSync(full, { throwIfNoEntry: false })) throw fail('observation archive is unreadable');
    return null;
  }
  let entry;
  try { entry = JSON.parse(text); } catch { throw fail('observation archive is malformed'); }
  const { id: entryId, ...record } = entry || {};
  const keyed = kind === 'review-index' ? entry?.key === id && /^[a-f0-9]{64}$/.test(entry.observationId || '')
    : kind === 'pending' ? entry?.childKey === id && typeof entry.childId === 'string' && hash(entry.childId) === id
      : kind === 'pending-completion' ? entry?.childKey === id && /^[a-f0-9]{64}$/.test(entry.pendingId || '') : entryId === id;
  if (entry?.schema !== 1 || entry.workspace !== loc.workspace || hash(record) !== entryId || !keyed) throw fail('observation archive integrity changed');
  return entry;
}

function publishArchive(loc, kind, id, entry) {
  const prior = readArchive(loc, kind, id);
  if (prior) {
    if (stable(prior) !== stable(entry)) throw fail('immutable observation archive identity conflicts');
    return prior;
  }
  fs.mkdirSync(loc.home, { recursive: true });
  const relative = archiveRelative(loc, kind, id), text = `${stable(entry)}\n`;
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw fail('one observation exceeds its archive bound');
  if (!writeFileContained(loc.home, relative, text, { exclusive: true, mode: 0o600 })) {
    const raced = readArchive(loc, kind, id);
    if (!raced || stable(raced) !== stable(entry)) throw fail('immutable observation archive publication refused');
    return raced;
  }
  return entry;
}

const reviewIndexKey = (entry, result) => hash({ packetId: entry.packetId, sessionId: entry.sessionId, policyRevision: entry.policyRevision, resource: entry.resource, packetBinding: entry.packetBinding, result: semanticResult(result) });
function archiveReview(loc, entry) {
  publishArchive(loc, 'review', entry.id, entry);
  for (const row of reviewOutput(stable(entry.output))?.rows || []) {
    const key = reviewIndexKey(entry, row);
    if (readArchive(loc, 'review-index', key)) continue;
    const record = { schema: 1, workspace: loc.workspace, key, observationId: entry.id };
    const index = { ...record, id: hash(record) };
    try { publishArchive(loc, 'review-index', key, index); }
    catch (error) { if (!readArchive(loc, 'review-index', key)) throw error; }
  }
}

function archiveLegacy(loc, state) {
  for (const entry of Object.values(state.observations)) publishArchive(loc, 'activation', entry.id, entry);
  for (const entry of Object.values(state.reviews)) archiveReview(loc, entry);
  for (const pending of Object.values(state.pending)) archivePending(loc, pending);
  state.observations = {}; state.reviews = {}; state.pending = {};
}

function archivePending(loc, pending) {
  if (typeof pending?.childId !== 'string' || !pending.childId || pending.childId.length > 200) throw fail('pending child identity is malformed');
  const { id: priorId, ...value } = pending;
  const record = { ...value, schema: 1, workspace: loc.workspace, childKey: hash(pending.childId) };
  const entry = { ...record, id: hash(record) };
  return publishArchive(loc, 'pending', entry.childKey, entry);
}

function readPending(loc, childId, legacy) {
  if (typeof childId !== 'string' || !childId || childId.length > 200) throw fail('actual child identity is malformed');
  const key = hash(childId);
  if (readArchive(loc, 'pending-completion', key)) return null;
  const entry = readArchive(loc, 'pending', key) || legacy?.pending[key];
  if (entry && entry.childId !== childId) throw fail('native child correlation changed');
  return entry || null;
}

function readState(loc) {
  if (!fs.lstatSync(loc.file, { throwIfNoEntry: false })) return { schema: 1, workspace: loc.workspace, pending: {}, observations: {}, reviews: {} };
  const text = readFileNoFollow(loc.file, { root: loc.home, maxBytes: 2 * 1024 * 1024 });
  let value;
  try { value = JSON.parse(text); } catch { throw fail('observation state is malformed'); }
  if (!object(value) || value.schema !== 1 || value.workspace !== loc.workspace || !object(value.pending) || !object(value.observations)) throw fail('observation state has invalid bindings');
  value.reviews ||= {};
  if (!object(value.reviews)) throw fail('review observation state is malformed');
  for (const [id, entry] of Object.entries({ ...value.observations, ...value.reviews })) {
    const { id: entryId, ...record } = entry || {};
    if (entryId !== id || !/^[a-f0-9]{64}$/.test(id) || hash(record) !== id) throw fail('observation integrity changed');
  }
  return value;
}

function mutate(loc, callback) {
  fs.mkdirSync(loc.home, { recursive: true });
  if (!assertNoSymlinkAncestors(loc.home, 'native-specialist-observations')) throw fail('observation directory is unsafe');
  fs.mkdirSync(path.dirname(loc.file), { recursive: true, mode: 0o700 });
  const lock = `${loc.file}.lock`;
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { throw fail('observation state is busy; retry without replacing evidence'); }
  try {
    const state = readState(loc);
    archiveLegacy(loc, state);
    const result = callback(state), text = stable(state);
    if (Buffer.byteLength(text) > 2 * 1024 * 1024 || !writeFileContained(loc.home, loc.relative, `${text}\n`, { mode: 0o600 })) throw fail('observation publication refused');
    return result;
  } finally { fs.rmdirSync(lock); }
}

function output(value) {
  if (typeof value === 'string') {
    if (!value.trim() || Buffer.byteLength(value) > 1024 * 1024) throw fail('native response is empty or exceeds its bound');
    return value;
  }
  if (!object(value) || value.truncated === true || value.is_error === true || value.error || value.success === false || value.failed === true) throw fail('native response failed or is incomplete');
  for (const key of ['result_type', 'resultType']) if (Object.hasOwn(value, key) && value[key] !== 'success') throw fail('native result did not succeed');
  const texts = ['textResultForLlm', 'text_result_for_llm'].filter(key => typeof value[key] === 'string').map(key => value[key]);
  if (typeof value.content === 'string') texts.push(value.content);
  if (Array.isArray(value.content)) {
    if (value.content.some(item => item?.type !== 'text' || typeof item.text !== 'string')) throw fail('native response has unsupported content');
    texts.push(value.content.map(item => item.text).join('\n'));
  }
  if (texts.length) {
    if (texts.some(text => text !== texts[0])) throw fail('native result aliases conflict');
    return output(texts[0]);
  }
  return stable(value);
}

function parsedOutput(value) {
  if (object(value) && !value.content && !value.textResultForLlm && !value.text_result_for_llm) return value;
  try { return JSON.parse(output(value)); } catch { throw fail('native child-control result is not complete JSON'); }
}

function nativeEvent(options) {
  const payload = options.payload || {}, normalized = normalizeToolPayload(payload);
  const sessionId = alias(payload, ['session_id', 'sessionId']), eventName = alias(payload, ['hook_event_name', 'hookEventName']);
  const stop = ['SubagentStop', 'subagentStop'].includes(eventName) || !eventName && typeof payload.agentName === 'string' && typeof payload.response === 'string' && payload.stopReason === 'end_turn';
  const names = ['tool_name', 'toolName'].map(key => payload[key]).filter(value => value !== undefined).map(nativeName);
  if (names.some(name => name !== names[0]) || normalized.terminalEffects.hasOpaque || !toolMutationSucceeded(payload) || payload.truncated === true) throw fail('native event failed, conflicted or was truncated');
  if (typeof sessionId !== 'string' || !sessionId || payload.cwd && fs.realpathSync.native(payload.cwd) !== options.workspace) throw fail('native session/workspace differs');
  const tool = stop ? 'SubagentStop' : nativeName(payload.ae_native_tool_name || payload.tool_name || payload.toolName);
  if (!['Agent', 'SubagentStop', 'spawn_agent', 'wait_agent'].includes(tool)) throw fail('event is not a native specialist invocation');
  const results = stop ? [alias(payload, ['last_assistant_message', 'response'])] : [payload.tool_response, payload.tool_result, payload.toolResult].filter(value => value !== undefined);
  if (!results.length) throw fail('native result is missing');
  const texts = results.map(output);
  if (texts.some(text => text !== texts[0])) throw fail('native response aliases conflict');
  const namedRole = stop ? alias(payload, ['agent_name', 'agentName']) : null;
  const typedRole = stop ? alias(payload, ['agent_type', 'agentType']) : null;
  const role = stop ? namedRole || typedRole : roleOf(normalized.toolInput);
  let toolUseId = stop ? alias(payload, ['agent_id', 'agentId']) : alias(payload, ['tool_use_id', 'tool_call_id', 'toolCallId']);
  const timestampValid = Number.isFinite(payload.timestamp) || typeof payload.timestamp === 'string' && Number.isFinite(Date.parse(payload.timestamp));
  const documentedPost = results.some(result => object(result) && (result.resultType === 'success' && typeof result.textResultForLlm === 'string' || result.result_type === 'success' && typeof result.text_result_for_llm === 'string'));
  if (!toolUseId && tool === 'Agent' && timestampValid && documentedPost) toolUseId = `copilot-post-event:${hash({ sessionId, timestamp: payload.timestamp, tool, input: normalized.toolInput, output: texts[0] })}`;
  if (typeof toolUseId !== 'string' || !toolUseId || toolUseId.length > 500 || !stop && !documentedPost && eventName !== 'PostToolUse' && eventName !== 'postToolUse' && payload.success !== true) throw fail('successful native event identity is missing');
  const stopReason = stop ? alias(payload, ['stop_reason', 'stopReason']) : null;
  if (stop && (stopReason !== null && stopReason !== 'end_turn' || namedRole && stopReason !== 'end_turn')) throw fail('subagent did not complete normally');
  return { tool, role, sessionId, toolUseId, input: normalized.toolInput, action: stop || tool === 'wait_agent' ? null : { tool, input: normalized.toolInput, cwd: options.workspace }, result: results[0], responseText: texts[0], outputDigest: hash(texts[0]), eventDigest: hash(payload), correlation: stop ? 'single-current-role-and-session-probe; host provides no shared task-call ID' : 'exact-native-action-and-session' };
}

const currentResource = (options, id) => typeof options.resolveAgent === 'function' ? options.resolveAgent(id) : catalog.resolveCapability({ ...options, kind: 'agent', id });
const packetBinding = (options, packetId) => typeof options.packetBinding === 'function' ? options.packetBinding(packetId) : typeof review.nativeReviewPacketBinding === 'function' ? review.nativeReviewPacketBinding({ ...options, packetId }) : { current: false, reason: 'Native review packet verifier is unavailable' };
function semanticResult(result) {
  const { schema, packet, provenance, ...value } = result;
  return { ...value, ...(Array.isArray(value.findings) ? { findings: value.findings.toSorted((a, b) => stable(a).localeCompare(stable(b))) } : {}) };
}
function reviewOutput(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!object(value) || value.schema !== undefined && value.schema !== 1 || !/^[a-f0-9]{64}$/.test(value.packet || '')) return null;
  const rows = Array.isArray(value.results) ? value.results : typeof value.reviewer === 'string' ? [value] : [];
  return rows.length && rows.length <= 64 && rows.every(row => object(row) && typeof row.reviewer === 'string') ? { value, rows, packetId: value.packet } : null;
}
function providerMatches(provider, resource) {
  return (provider?.name || provider?.id) === resource.id && provider.path === resource.path && provider.digest === resource.digest
    && (provider.sourceDigest === undefined || (provider.sourceDigest || null) === (resource.sourceDigest || null));
}
function retainReview(options, loc, event, resource, now) {
  const parsed = reviewOutput(event.responseText);
  if (!parsed) return null;
  const packet = packetBinding(options, parsed.packetId);
  if (!packet?.current || !object(packet.binding) || !Array.isArray(packet.providers)) throw fail(packet?.reason || 'Review packet binding is unavailable');
  if (!parsed.rows.every(row => packet.providers.some(provider => provider.perspective === row.reviewer && providerMatches(provider, resource)))) throw fail('Observed native role does not provide the returned packet perspective');
  const record = { schema: 1, workspace: loc.workspace, role: resource.id, sessionId: event.sessionId, resource: resourceBinding(resource), policyRevision: options.policy.revision, packetId: parsed.packetId, packetBinding: packet.binding,
    output: parsed.value, toolUseId: event.toolUseId, eventTool: event.tool, eventDigest: event.eventDigest, observedAt: now, assurance: 'Recorded native hook adapter event; not an authenticated host transcript', loadedSourceHash: 'unverified' };
  const entry = { ...record, id: hash(record) };
  archiveReview(loc, entry);
  return entry;
}

/** Match review authorship to retained full native output, never to authored provenance. */
export function validateReviewObservation(options) {
  try {
    const loc = locations(options), sessionId = options.sessionId;
    if (typeof sessionId !== 'string' || !sessionId || !object(options.result) || !/^[a-f0-9]{64}$/.test(options.packetId || '')) throw fail('Actual review session, packet and result are required');
    const snapshot = options.policy ? null : catalog.discoveryPolicy(options);
    const policyRevision = options.policy?.revision || snapshot?.policyRevision;
    if (!policyRevision || snapshot && !snapshot.configured) throw fail('Current review discovery consent is unavailable');
    const name = options.provider?.name || options.provider?.id, resource = currentResource(options, name);
    if (!resource?.included || !resource.current || !resource.invocable || !providerMatches(options.provider, resource)) throw fail('Observed review provider is no longer current or eligible');
    const packet = packetBinding(options, options.packetId);
    if (!packet?.current || !Array.isArray(packet.providers) || !packet.providers.some(provider => provider.perspective === options.result.reviewer && providerMatches(provider, resource))) throw fail(packet?.reason || 'Current packet does not select this provider');
    const semantic = stable(semanticResult(options.result)), key = reviewIndexKey({ packetId: options.packetId, sessionId, policyRevision, resource: resourceBinding(resource), packetBinding: packet.binding }, options.result);
    const index = readArchive(loc, 'review-index', key);
    const indexed = index ? readArchive(loc, 'review', index.observationId) : null;
    if (index && !indexed) throw fail('indexed native review observation is missing');
    const entry = (indexed ? [indexed] : Object.values(readState(loc).reviews)).find(value => value.packetId === options.packetId && value.sessionId === sessionId && value.policyRevision === policyRevision
      && stable(value.resource) === stable(resourceBinding(resource)) && stable(value.packetBinding) === stable(packet.binding)
      && (reviewOutput(stable(value.output))?.rows || []).some(row => stable(semanticResult(row)) === semantic));
    if (!entry) throw fail('No retained complete native review output matches the exact packet, provider, source, session and result');
    return { valid: true, pass: true, independence: 'separate-reviewer', observationId: entry.id, sessionId: entry.sessionId, toolUseId: entry.toolUseId, agent: entry.role, packet: entry.packetId, assurance: entry.assurance, loadedSourceHash: entry.loadedSourceHash };
  } catch (error) { return { valid: false, pass: false, independence: 'unverified', reason: error.message }; }
}

/** Historical consultation is evidence of use, distinct from current eligibility or usefulness. */
export function verifyRetainedReviewUse(options) {
  try {
    const loc = historicalLocations(options);
    if (!/^[a-f0-9]{64}$/.test(options.observationId || '') || !/^[a-f0-9]{64}$/.test(options.packetId || '') || !/^[a-f0-9]{64}$/.test(options.sha256 || '')) throw fail('historical review identities are invalid');
    for (const key of ['sessionId', 'name', 'plan']) if (typeof options[key] !== 'string' || !options[key] || options[key].length > 4096 || /[\u0000-\u001f\u007f]/.test(options[key])) throw fail('historical session, role and plan are required');
    if (typeof options.path !== 'string' || !path.isAbsolute(options.path) || path.resolve(options.path) !== options.path) throw fail('historical resource path must be exact and absolute');
    const entry = readArchive(loc, 'review', options.observationId);
    if (!entry || entry.workspace !== loc.workspace || entry.sessionId !== options.sessionId || entry.packetId !== options.packetId
      || entry.role !== options.name || entry.resource?.id !== options.name || entry.resource.path !== options.path || entry.resource.digest !== `sha256-${options.sha256}`) throw fail('historical native consultation identity does not match the retained event');
    const binding = entry.packetBinding;
    if (!object(binding) || binding.workspace !== loc.workspace || binding.packet !== options.packetId || typeof binding.plan !== 'string' || !binding.plan || binding.plan !== options.plan || binding.policyRevision !== entry.policyRevision
      || options.policyRevision !== undefined && options.policyRevision !== entry.policyRevision) throw fail('retained review lacks the exact authoritative task plan, packet or consent binding');
    const parsed = reviewOutput(stable(entry.output));
    if (!parsed || parsed.packetId !== options.packetId || typeof entry.toolUseId !== 'string' || !entry.toolUseId || !['Agent', 'SubagentStop', 'wait_agent'].includes(entry.eventTool)) throw fail('retained native review output or invocation evidence is incomplete');
    return { valid: true, pass: true, observationId: entry.id, workspace: entry.workspace, packetId: entry.packetId, sessionId: entry.sessionId, plan: binding.plan,
      name: entry.role, path: entry.resource.path, sha256: options.sha256, policyRevision: entry.policyRevision, ...(entry.resource.sourceDigest ? { sourceDigest: entry.resource.sourceDigest } : {}),
      assurance: 'Retained native hook adapter consultation; not an authenticated host transcript or proof of causal effectiveness', loadedSourceHash: 'unverified' };
  } catch (error) { return { valid: false, pass: false, reason: error.message, loadedSourceHash: 'unverified' }; }
}

function inspectProbe(options, query) {
  const inspect = options.inspectProbe || decisions.inspectNativeProbe;
  if (typeof inspect !== 'function') throw fail('approved native probe inspector is unavailable');
  const probe = inspect({ ...options, ...query });
  if (!probe?.authorized || !Number.isFinite(probe.consumedAt) || !/^[a-f0-9]{64}$/.test(probe.requestId || '') || !/^[a-f0-9]{64}$/.test(probe.receiptId || '') || probe.sessionId !== query.sessionId || probe.role !== query.role || probe.policyRevision !== options.policy?.revision || stable(probe.resource) !== stable(resourceBinding(query.resource))) throw fail('no current source-bound consumed native probe matches this event');
  return probe;
}

/** Verify retained adapter evidence again; no client-supplied approved flag is accepted. */
export function verifyNativeInvocationObservation(options) {
  const loc = locations(options), entry = readArchive(loc, 'activation', options.observationId) || readState(loc).observations[options.observationId];
  if (!entry || stable(entry.resource) !== stable(resourceBinding(options.resource))) throw fail('current resource differs from the retained observation');
  const current = currentResource(options, entry.role);
  if (!current?.included || !current.current || stable(resourceBinding(current)) !== stable(entry.resource)) throw fail('observed resource is no longer current or included');
  const probe = inspectProbe({ ...options, ...loc }, { requestId: entry.requestId, sessionId: entry.sessionId, role: entry.role, action: entry.action, resource: options.resource });
  if (probe.requestId !== entry.requestId || probe.receiptId !== entry.receiptId || probe.consumedAt > entry.observedAt) throw fail('observed event no longer matches its approved probe');
  return entry;
}

/** Native hook ingestion only. Events are adapter evidence, not authenticated transcripts. */
export async function observeNativeSpecialist(options) {
  try {
    if (!options.policy?.enabled && !options.configured) return { observed: false };
    const loc = locations(options), event = nativeEvent({ ...options, ...loc }), now = options.now ?? Date.now();
    if (event.role === 'decision-agent') return { observed: false };
    let resource, probe, child;
    if (event.tool === 'wait_agent') {
      const result = parsedOutput(event.result), ids = event.input.ids;
      if (!Array.isArray(ids) || ids.length > 64 || !object(result.status)) throw fail('completed child status is missing');
      const state = readState(loc), completed = ids.map(id => ({ pending: readPending(loc, id, state), status: result.status[id] })).filter(item => item.pending?.sessionId === event.sessionId && typeof item.status?.completed === 'string' && item.status.completed.trim());
      if (completed.length !== 1) throw fail('native wait does not identify one approved completed child');
      child = completed[0].pending;
      resource = currentResource(options, child.role);
      if (!resource?.included || !resource.current || stable(resourceBinding(resource)) !== stable(child.resource)) throw fail('native child source changed');
      if (child.requestId) {
        probe = inspectProbe({ ...options, ...loc }, { sessionId: event.sessionId, role: child.role, action: child.action, resource });
        if (probe.requestId !== child.requestId || stable(probe.resource) !== stable(child.resource)) throw fail('native child approved probe changed');
      } else if (!resource.invocable) throw fail('native review child is no longer independently invocable');
      event.role = child.role; event.action = child.action; event.toolUseId = `${child.toolUseId}/${event.toolUseId}`; event.responseText = completed[0].status.completed; event.correlation = 'source-bound-native-spawn-and-completed-wait';
    } else {
      if (typeof event.role !== 'string') throw fail('native specialist role is missing');
      resource = currentResource(options, event.role);
      if (!resource?.included || !resource.current || resource.id !== event.role) throw fail('native resource is not currently included');
      try { probe = inspectProbe({ ...options, ...loc }, { sessionId: event.sessionId, role: event.role, ...(event.action ? { action: event.action } : {}), resource }); }
      catch (error) { if (!resource.invocable) throw error; }
      if (event.tool === 'spawn_agent') {
        const result = parsedOutput(event.result);
        if (typeof result.agent_id !== 'string' || !result.agent_id || result.agent_id.length > 200) throw fail('actual spawned child ID is missing');
        return mutate(loc, state => {
          const key = hash(result.agent_id), prior = readPending(loc, result.agent_id, state);
          if (readArchive(loc, 'pending-completion', key)) throw fail('completed native child identity cannot be reused');
          const pending = { sessionId: event.sessionId, role: event.role, action: probe?.action || event.action, requestId: probe?.requestId || null, receiptId: probe?.receiptId || null, resource: resourceBinding(resource), toolUseId: event.toolUseId, childId: result.agent_id, observedAt: now };
          const record = { ...pending, schema: 1, workspace: loc.workspace, childKey: key }, entry = { ...record, id: hash(record) };
          if (prior && stable(prior) !== stable(entry)) throw fail('native child was already bound to another probe');
          archivePending(loc, entry);
          return { observed: false, pending: true, requestId: probe?.requestId || null, agentId: result.agent_id };
        });
      }
      event.action = probe?.action || event.action;
    }
    if (!resource?.included || !resource.current || probe && now < probe.consumedAt) throw fail('current resource or observation time is invalid');
    const nativeReview = retainReview(options, loc, event, resource, now);
    const finishChild = () => {
      if (!child) return;
      const pending = archivePending(loc, child), record = { schema: 1, workspace: loc.workspace, childKey: hash(child.childId), pendingId: pending.id, completedAt: now };
      publishArchive(loc, 'pending-completion', record.childKey, { ...record, id: hash(record) });
      mutate(loc, state => { delete state.pending[hash(child.childId)]; });
    };
    if (!probe) {
      finishChild();
      return { observed: Boolean(nativeReview), reviewObserved: Boolean(nativeReview), ...(nativeReview ? { reviewObservationId: nativeReview.id } : { reason: 'No complete source-bound review result was returned' }) };
    }
    const record = { schema: 1, workspace: loc.workspace, role: event.role, sessionId: event.sessionId, requestId: probe.requestId, receiptId: probe.receiptId, policyRevision: probe.policyRevision, resource: resourceBinding(resource), action: probe.action, toolUseId: event.toolUseId, eventTool: event.tool, eventDigest: event.eventDigest, outputDigest: event.outputDigest, observedAt: now, correlation: event.correlation, assurance: 'Recorded native hook adapter event; not an authenticated host transcript', nativeQualification: 'observed-invocation', loadedSourceHash: 'unverified' };
    const observation = { ...record, id: hash(record) };
    publishArchive(loc, 'activation', observation.id, observation);
    let activate = options.activate;
    if (!activate) activate = (await import('./hosts/personal-resource.mjs')).activatePersonalResource;
    if (typeof activate !== 'function') return { observed: true, activated: false, observationId: observation.id, reason: 'Native availability persistence is unavailable' };
    const result = await activate({ home: loc.home, configHome: options.copilotHome, skillsHome: options.skillsHome, host: resource.host, name: resource.id, expectedDigest: resource.digest, ...(resource.sourceDigest ? { expectedSourceDigest: resource.sourceDigest } : {}), expectedPolicyRevision: probe.policyRevision, observation, validateObservation: current => verifyNativeInvocationObservation({ ...options, ...loc, observationId: observation.id, resource: current }) });
    finishChild();
    return { observed: true, activated: result?.activated === true || result?.activation?.state === 'available', observationId: observation.id, activation: result?.activation, ...(nativeReview ? { reviewObserved: true, reviewObservationId: nativeReview.id } : {}) };
  } catch (error) { return { observed: false, reason: error.message }; }
}
