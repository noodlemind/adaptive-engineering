import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertNoSymlinkAncestors, readFileNoFollow, writeFileContained } from './fs-safe.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = value => JSON.stringify(value, (_, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const ID = /^[a-f0-9]{64}$/;
const fail = message => Object.assign(new Error(`Decision archive: ${message}`), { code: 'E_TARGET', exit: 1 });
const root = loc => path.join('decision-archives', hash(loc.workspace));

function readRecord(loc, relative) {
  const file = path.join(loc.home, relative), stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  const bytes = readFileNoFollow(file, { root: loc.home, maxBytes: 2 * 1024 * 1024 });
  let record;
  try { record = JSON.parse(bytes); } catch { throw fail('retained record is malformed or unsafe'); }
  const { id, ...value } = record || {};
  if (!object(record) || !ID.test(id || '') || hash(value) !== id || value.schema !== 1 || value.workspace !== loc.workspace) throw fail('retained record integrity or workspace binding changed');
  return value;
}

function writeRecord(loc, relative, value, immutable = false) {
  if (!assertNoSymlinkAncestors(loc.home, relative)) throw fail('retained record path is redirected');
  const bytes = `${stable({ ...value, id: hash(value) })}\n`;
  if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw fail('one retained record exceeds its bound');
  if (immutable) {
    const previous = readRecord(loc, relative);
    if (previous) {
      if (stable(previous) !== stable(value)) throw fail('immutable request evidence conflicts with its retained identity');
      return;
    }
  }
  if (!writeFileContained(loc.home, relative, bytes, { exclusive: immutable, mode: 0o600 })) throw fail('retained record publication refused');
}

/** Exact lookup only; no unbounded archive-directory scan is used for authority. */
export function hydrateArchivedDecision(loc, state, requestId) {
  if (Object.hasOwn(state.requests, requestId)) return state.requests[requestId];
  if (!ID.test(requestId || '')) return null;
  const record = readRecord(loc, path.join(root(loc), 'requests', `${requestId}.json`));
  if (!record) return null;
  const request = record.request;
  if (!object(request) || record.requestId !== requestId || request.requestId !== requestId) throw fail('request archive binding is invalid');
  const { requestId: ignored, createdAt, ...packet } = request;
  if (hash(packet) !== requestId || !Number.isFinite(createdAt)) throw fail('request archive integrity changed');
  if (record.receipt) {
    const { id, ...receipt } = record.receipt;
    if (receipt.requestId !== requestId || hash({ ...receipt, consumedAt: null }) !== id) throw fail('receipt archive integrity changed');
    state.receipts[requestId] = record.receipt;
  }
  state.requests[requestId] = request;
  if (!state.archivedHydrated) Object.defineProperty(state, 'archivedHydrated', { value: new Set(), enumerable: false });
  state.archivedHydrated.add(requestId);
  if (record.observation) state.observations[requestId] = record.observation;
  if (record.nativeProbe) state.nativeProbes[requestId] = record.nativeProbe;
  Object.assign(state.invocations, record.invocations || {});
  return request;
}

/** Marks compaction warnings about a refused readiness-index write; they outlive their request until that plan's index write succeeds. */
export const READINESS_INDEX_FAULT = 'readiness-index';
// Under a lasting index fault, at most this many plans keep their newest readiness request live.
const MAX_KEPT_READINESS = 32;
/** The plan identity carried by readiness-index warnings: the hash that also names the plan's index record. */
export const readinessPlanKey = planPath => hash(planPath);
/** The one aggregated warning for plans archived over the cap; those plans may cite a stale index. */
/** Starts the warning for a plan's newest readiness request kept live after its index write was refused. */
export const STAYS_LIVE_PREFIX = 'readiness index not retained; request stays live: ';
export const archivedOverCapMessage = count => `readiness index not retained; ${count} plan(s) archived their newest readiness request because more than ${MAX_KEPT_READINESS} plans already keep one live; their cited readiness may be stale until their index is written`;

const readinessRelative = (loc, planPath) => path.join(root(loc), 'readiness', `${readinessPlanKey(planPath)}.json`);
const readinessCitation = receipt => ({ id: receipt.id, requestId: receipt.requestId, verdict: receipt.verdict, recordedAt: receipt.recordedAt });

/**
 * Keep the newest archived readiness receipt per plan so read-only citations survive compaction.
 * Returns 'written' after an index write, 'current' when the index already holds a newer or equal
 * receipt (nothing was written), and null when the receipt is not a readiness receipt.
 */
function retainLatestReadiness(loc, request, receipt) {
  if (receipt?.type !== 'readiness' || typeof request.planPath !== 'string' || !ID.test(receipt.id || '') || !Number.isFinite(receipt.recordedAt)) return null;
  const relative = readinessRelative(loc, request.planPath);
  let previous = null;
  try { previous = readRecord(loc, relative); } catch { previous = null; }
  if (previous?.planPath === request.planPath && previous.receipt?.recordedAt >= receipt.recordedAt) return 'current';
  writeRecord(loc, relative, { schema: 1, workspace: loc.workspace, planPath: request.planPath, receipt: readinessCitation(receipt) });
  return 'written';
}

/** Read-only: the newest archived readiness citation for a plan, cross-checked against its retained request record. */
export function latestArchivedReadiness(loc, planPath) {
  const index = readRecord(loc, readinessRelative(loc, planPath));
  if (!index || index.planPath !== planPath || !ID.test(index.receipt?.requestId || '')) return null;
  const retained = readRecord(loc, path.join(root(loc), 'requests', `${index.receipt.requestId}.json`));
  if (!retained || retained.request?.planPath !== planPath || retained.receipt?.id !== index.receipt.id) return null;
  return readinessCitation(retained.receipt);
}

function validTask(value) {
  return object(value) && Number.isFinite(value.startedAt) && object(value.counts) && ['decisions', 'repairs', 'acquisitions'].every(key => Number.isSafeInteger(value.counts[key]) && value.counts[key] >= 0);
}

/** Counters retain the earliest start and greatest observed use across crash recovery. */
export function decisionTask(loc, state, key) {
  if (!ID.test(key || '')) return null;
  const retained = readRecord(loc, path.join(root(loc), 'tasks', `${key}.json`));
  if (retained && (retained.budgetKey !== key || !validTask(retained.task))) throw fail('retained task budget binding is invalid');
  const current = state.tasks[key];
  if (current && !validTask(current)) throw fail('live task budget is malformed');
  if (!current && !retained) return null;
  const task = current && retained ? { startedAt: Math.min(current.startedAt, retained.task.startedAt), counts: Object.fromEntries(['decisions', 'repairs', 'acquisitions'].map(name => [name, Math.max(current.counts[name], retained.task.counts[name])])) } : current || retained.task;
  state.tasks[key] = task;
  return task;
}

/**
 * Retire terminal/expired context while retaining immutable evidence and durable budgets. Returns best-effort warnings.
 * Readiness-index warnings carry `plan` (readinessPlanKey); plans archived over the cap are reported by one
 * aggregated warning carrying `plans`, oldest archived first. `report.indexedPlans` holds the plan keys whose
 * readiness index is healthy after this pass: the write succeeded, or the index already held the plan's newest
 * live receipt. An index current for an older or hydrated request proves nothing about a newer receipt.
 */
export function compactDecisions(loc, state, report = {}) {
  const warnings = [];
  if (Buffer.byteLength(stable(state)) <= 512 * 1024 && !state.archivedHydrated?.size) return warnings;
  const now = loc.now ?? Date.now(), touched = new Set(), indexed = new Set();
  // The newest live readiness receipt per plan; only it may stay live when its
  // index write is refused, so a lasting fault retains at most one request per
  // plan. A request hydrated from the archive is never a candidate: a newer
  // receipt may already be archived.
  const newestReadiness = new Map();
  for (const [requestId, request] of Object.entries(state.requests)) {
    const receipt = state.receipts[requestId];
    if (receipt?.type !== 'readiness' || typeof request.planPath !== 'string' || !Number.isFinite(receipt.recordedAt) || state.archivedHydrated?.has(requestId)) continue;
    const current = state.receipts[newestReadiness.get(request.planPath)];
    if (!current || receipt.recordedAt > current.recordedAt) newestReadiness.set(request.planPath, requestId);
  }
  const retire = (requestId, request, invocations) => {
    touched.add(request.budgetKey);
    delete state.requests[requestId]; delete state.receipts[requestId]; delete state.observations[requestId]; delete state.nativeProbes[requestId];
    for (const key of Object.keys(invocations)) delete state.invocations[key];
  };
  // Newest requests whose own index write failed. The cap applies to these
  // alone, once every write in the pass has been tried.
  const refused = [];
  for (const [requestId, request] of Object.entries(state.requests)) {
    const task = decisionTask(loc, state, request.budgetKey), receipt = state.receipts[requestId];
    const seconds = request.budgets?.maxSeconds;
    const expired = task && Number.isSafeInteger(seconds) && now >= task.startedAt && now - task.startedAt > seconds * 1000;
    const terminal = receipt && (!receipt.authorized || receipt.consumedAt !== null);
    // A first-invocation probe must remain discoverable by role/session until
    // its original task budget expires; retained exact-ID lookup remains possible.
    if (!expired && (!terminal || state.nativeProbes[requestId])) continue;
    const invocations = Object.fromEntries(Object.entries(state.invocations).filter(([, value]) => value.requestId === requestId));
    const record = { schema: 1, workspace: loc.workspace, requestId, request, receipt: receipt || null, observation: state.observations[requestId] || null, nativeProbe: state.nativeProbes[requestId] || null, invocations };
    writeRecord(loc, path.join(root(loc), 'requests', `${requestId}.json`), record, true);
    // A refused readiness-index write must not block compaction, and must not
    // leave the index naming an older receipt as latest: the plan's newest
    // readiness request stays live for a retry; older ones compact normally,
    // so live state stays bounded at one request per plan.
    try {
      const retained = retainLatestReadiness(loc, request, receipt);
      if (retained === 'written' || (retained === 'current' && newestReadiness.get(request.planPath) === requestId)) indexed.add(readinessPlanKey(request.planPath));
    } catch (error) {
      const newest = newestReadiness.get(request.planPath), plan = readinessPlanKey(request.planPath);
      if (newest === requestId) { refused.push({ requestId, request, invocations, plan, error }); continue; }
      // An archived request's warning rides on the plan's newest live request, or
      // stays at state level when there is none; either lasts until that plan's index write succeeds.
      const message = newest ? `readiness index not retained for older request ${requestId}: ${error.message}`
        : `readiness index not retained for archived request ${requestId}: ${error.message}`;
      warnings.push({ requestId: newest || null, plan, fault: READINESS_INDEX_FAULT, message });
    }
    retire(requestId, request, invocations);
  }
  refused.sort((a, b) => state.receipts[b.requestId].recordedAt - state.receipts[a.requestId].recordedAt || a.requestId.localeCompare(b.requestId));
  for (const { requestId, plan, error } of refused.slice(0, MAX_KEPT_READINESS)) {
    warnings.push({ requestId, plan, fault: READINESS_INDEX_FAULT, message: `${STAYS_LIVE_PREFIX}${error.message}` });
  }
  const overCap = refused.slice(MAX_KEPT_READINESS);
  if (overCap.length) {
    const archived = new Set(overCap.map(item => item.requestId));
    // An older request's warning that rode on an over-cap request moves to state level with its plan.
    for (const item of warnings) if (archived.has(item.requestId)) item.requestId = null;
    for (const { requestId, request, invocations } of overCap) retire(requestId, request, invocations);
    // Oldest receipt first, so a bounded list keeps the newest plans.
    const plans = [...new Set(overCap.map(item => item.plan).reverse())];
    warnings.push({ requestId: null, plans, fault: READINESS_INDEX_FAULT, message: archivedOverCapMessage(plans.length) });
  }
  if (indexed.size) report.indexedPlans = indexed;
  const liveTasks = new Set(Object.values(state.requests).map(request => request.budgetKey));
  for (const key of new Set([...touched, ...Object.keys(state.tasks)])) {
    if (liveTasks.has(key)) continue;
    const task = decisionTask(loc, state, key);
    if (!task) continue;
    writeRecord(loc, path.join(root(loc), 'tasks', `${key}.json`), { schema: 1, workspace: loc.workspace, budgetKey: key, task });
    delete state.tasks[key];
  }
  return warnings;
}
