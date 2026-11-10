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

/** The plan identity the readiness-index warning reports: the hash that also names the plan's index record. */
export const readinessPlanKey = planPath => hash(planPath);
// At most this many plans are tracked as possibly holding a stale readiness index.
const MAX_PENDING_READINESS = 256;

const readinessRelative = (loc, planPath) => path.join(root(loc), 'readiness', `${readinessPlanKey(planPath)}.json`);
const readinessCitation = receipt => ({ id: receipt.id, requestId: receipt.requestId, verdict: receipt.verdict, recordedAt: receipt.recordedAt });

/**
 * Keep the newest archived readiness receipt per plan so read-only citations survive compaction.
 * Returns 'written' after an index write, 'current' when the index already holds a newer or equal
 * receipt (nothing was written), and null when the citation lacks a plan, an id or a time.
 */
function retainLatestReadiness(loc, planPath, receipt) {
  if (typeof planPath !== 'string' || !ID.test(receipt?.id || '') || !Number.isFinite(receipt.recordedAt)) return null;
  const relative = readinessRelative(loc, planPath);
  let previous = null;
  try { previous = readRecord(loc, relative); } catch { previous = null; }
  if (previous?.planPath === planPath && previous.receipt?.recordedAt >= receipt.recordedAt) return 'current';
  writeRecord(loc, relative, { schema: 1, workspace: loc.workspace, planPath, receipt: readinessCitation(receipt) });
  return 'written';
}

/** True when the plan's readiness index exists and names a receipt at least as new as `entry`. */
function indexHolds(loc, entry) {
  let index = null;
  try { index = readRecord(loc, readinessRelative(loc, entry.planPath)); } catch { return false; }
  return index?.planPath === entry.planPath && Number.isFinite(index.receipt?.recordedAt) && index.receipt.recordedAt >= entry.recordedAt;
}

/**
 * Archived readiness receipts whose index write did not succeed, one per plan (its newest), newest first:
 * facts about the archive, not warnings. A malformed entry, or one from an older shape, is ignored.
 */
export function pendingReadiness(state) {
  const plans = object(state.readinessPending?.plans) ? state.readinessPending.plans : {};
  const entries = [];
  for (const [plan, entry] of Object.entries(plans)) {
    if (!object(entry) || typeof entry.planPath !== 'string' || readinessPlanKey(entry.planPath) !== plan || !ID.test(entry.id || '') || !ID.test(entry.requestId || '')
      || typeof entry.verdict !== 'string' || entry.verdict.length > 32 || !Number.isFinite(entry.recordedAt)) continue;
    entries.push({ plan, planPath: entry.planPath, id: entry.id, requestId: entry.requestId, verdict: entry.verdict, recordedAt: entry.recordedAt });
  }
  entries.sort((a, b) => b.recordedAt - a.recordedAt || a.plan.localeCompare(b.plan));
  return { entries: entries.slice(0, MAX_PENDING_READINESS), capped: state.readinessPending?.capped === true || entries.length > MAX_PENDING_READINESS };
}

/**
 * Read-only readiness-index health, derived from what exists: a tracked plan is stale while its index is
 * missing or names a receipt older than the plan's newest archived one. Nothing here is stored or cleared.
 * `capped` means more plans were stale than are tracked, so the count is a lower bound.
 */
export function readinessIndexHealth(loc, state) {
  const { entries, capped } = pendingReadiness(state);
  return { stale: entries.filter(entry => !indexHolds(loc, entry)).map(entry => entry.plan), capped };
}

/** Read-only: a plan's newest archived readiness receipt whose index write failed, cross-checked against its retained request record. */
export function pendingArchivedReadiness(loc, state, planPath) {
  const entry = pendingReadiness(state).entries.find(item => item.planPath === planPath);
  if (!entry) return null;
  const retained = readRecord(loc, path.join(root(loc), 'requests', `${entry.requestId}.json`));
  if (!retained || retained.request?.planPath !== planPath || retained.receipt?.id !== entry.id) return null;
  return readinessCitation(retained.receipt);
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
 * Retire terminal/expired context while retaining immutable evidence and durable budgets.
 * A refused readiness-index write never blocks compaction: the request still archives, and the plan's
 * newest archived receipt is noted in `state.readinessPending` so readers can cite it and the write is
 * retried on later passes. A note leaves once the plan's index holds a receipt at least as new, which is
 * read from the index itself, never inferred from some other write. Returns this pass's index faults,
 * `{ requestId, plan, message }`, for the caller to report; they are not stored.
 */
export function compactDecisions(loc, state) {
  const faults = [];
  // Small state with nothing hydrated retires nothing; it still retries noted index writes.
  const retireNow = Buffer.byteLength(stable(state)) > 512 * 1024 || state.archivedHydrated?.size > 0;
  if (!retireNow && state.readinessPending === undefined) return faults;
  const now = loc.now ?? Date.now(), touched = new Set();
  const noted = pendingReadiness(state), pending = new Map(noted.entries.map(entry => [entry.plan, entry]));
  let capped = noted.capped;
  const tried = new Set();
  const retain = (planPath, citation) => {
    const plan = readinessPlanKey(planPath);
    try { retainLatestReadiness(loc, planPath, citation); return true; }
    catch (error) {
      tried.add(plan);
      faults.push({ requestId: citation.requestId, plan, message: `readiness index not retained for request ${citation.requestId}: ${error.message}` });
      const prior = pending.get(plan);
      if (!prior || citation.recordedAt > prior.recordedAt) pending.set(plan, { plan, planPath, ...citation });
      return false;
    }
  };
  for (const [requestId, request] of retireNow ? Object.entries(state.requests) : []) {
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
    // A request hydrated from the archive was archived before; a newer receipt may already be,
    // so it never becomes the plan's pending newest.
    if (receipt?.type === 'readiness' && typeof request.planPath === 'string' && ID.test(receipt.id || '') && Number.isFinite(receipt.recordedAt) && !state.archivedHydrated?.has(requestId)) {
      retain(request.planPath, readinessCitation(receipt));
    } else if (receipt?.type === 'readiness' && typeof request.planPath === 'string') {
      try { retainLatestReadiness(loc, request.planPath, readinessCitation(receipt)); } catch { /* the original pass noted it */ }
    }
    touched.add(request.budgetKey);
    delete state.requests[requestId]; delete state.receipts[requestId]; delete state.observations[requestId]; delete state.nativeProbes[requestId];
    for (const key of Object.keys(invocations)) delete state.invocations[key];
  }
  // Each noted plan leaves once its index holds a receipt at least as new; otherwise retry the write
  // once per pass. The archived request record already exists, so readers can cite it meanwhile.
  for (const [plan, entry] of pending) {
    if (indexHolds(loc, entry) || (!tried.has(plan) && retain(entry.planPath, { id: entry.id, requestId: entry.requestId, verdict: entry.verdict, recordedAt: entry.recordedAt }))) pending.delete(plan);
  }
  // Bounded: the newest plans stay tracked; once one is dropped, the stale count is a lower bound until none remain.
  const kept = [...pending.values()].sort((a, b) => b.recordedAt - a.recordedAt || a.plan.localeCompare(b.plan));
  if (kept.length > MAX_PENDING_READINESS) capped = true;
  if (!kept.length) delete state.readinessPending;
  else state.readinessPending = { ...(capped ? { capped: true } : {}), plans: Object.fromEntries(kept.slice(0, MAX_PENDING_READINESS).map(({ plan, ...entry }) => [plan, entry])) };
  if (!retireNow) return faults;
  const liveTasks = new Set(Object.values(state.requests).map(request => request.budgetKey));
  for (const key of new Set([...touched, ...Object.keys(state.tasks)])) {
    if (liveTasks.has(key)) continue;
    const task = decisionTask(loc, state, key);
    if (!task) continue;
    writeRecord(loc, path.join(root(loc), 'tasks', `${key}.json`), { schema: 1, workspace: loc.workspace, budgetKey: key, task });
    delete state.tasks[key];
  }
  return faults;
}
