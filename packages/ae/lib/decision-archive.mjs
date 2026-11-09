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

/** Marks compaction warnings about a refused readiness-index write; they outlive their request until an index write succeeds. */
export const READINESS_INDEX_FAULT = 'readiness-index';
// Under a lasting index fault, at most this many plans keep their newest readiness request live.
const MAX_KEPT_READINESS = 32;

const readinessRelative = (loc, planPath) => path.join(root(loc), 'readiness', `${hash(planPath)}.json`);
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
 * `report.indexRetained` is set only after a readiness-index write succeeded in this pass; an index
 * that was already current proves nothing about the fault.
 */
export function compactDecisions(loc, state, report = {}) {
  const warnings = [];
  if (Buffer.byteLength(stable(state)) <= 512 * 1024 && !state.archivedHydrated?.size) return warnings;
  const now = loc.now ?? Date.now(), touched = new Set();
  // The newest live readiness receipt per plan; only it is kept live when its
  // index write is refused, so a lasting fault retains at most one request per
  // plan, for at most MAX_KEPT_READINESS plans. A request hydrated from the
  // archive is never a candidate: a newer receipt may already be archived.
  const newestReadiness = new Map();
  for (const [requestId, request] of Object.entries(state.requests)) {
    const receipt = state.receipts[requestId];
    if (receipt?.type !== 'readiness' || typeof request.planPath !== 'string' || !Number.isFinite(receipt.recordedAt) || state.archivedHydrated?.has(requestId)) continue;
    const current = state.receipts[newestReadiness.get(request.planPath)];
    if (!current || receipt.recordedAt > current.recordedAt) newestReadiness.set(request.planPath, requestId);
  }
  const overCap = new Set();
  const byRecency = [...newestReadiness.entries()].sort(([, a], [, b]) => state.receipts[b].recordedAt - state.receipts[a].recordedAt || a.localeCompare(b));
  for (const [planPath, requestId] of byRecency.slice(MAX_KEPT_READINESS)) { newestReadiness.delete(planPath); overCap.add(requestId); }
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
    try { if (retainLatestReadiness(loc, request, receipt) === 'written') report.indexRetained = true; } catch (error) {
      const newest = newestReadiness.get(request.planPath), keep = newest === requestId;
      // An archived request's warning rides on the plan's newest live request, or
      // stays at state level when there is none; either lasts until an index write succeeds.
      const message = keep ? `readiness index not retained; request stays live: ${error.message}`
        : newest ? `readiness index not retained for older request ${requestId}: ${error.message}`
          : overCap.has(requestId) ? `readiness index not retained; request ${requestId} archived because more than ${MAX_KEPT_READINESS} plans already keep one live: ${error.message}`
            : `readiness index not retained for archived request ${requestId}: ${error.message}`;
      warnings.push({ requestId: newest || null, fault: READINESS_INDEX_FAULT, message });
      if (keep) continue;
    }
    touched.add(request.budgetKey);
    delete state.requests[requestId]; delete state.receipts[requestId]; delete state.observations[requestId]; delete state.nativeProbes[requestId];
    for (const key of Object.keys(invocations)) delete state.invocations[key];
  }
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
