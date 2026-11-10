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

/** One archived request record by exact ID, integrity-checked, or null when none is retained. */
function archivedRequest(loc, requestId) {
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
  }
  return record;
}

/** Exact lookup only; no unbounded archive-directory scan is used for authority. */
export function hydrateArchivedDecision(loc, state, requestId) {
  if (Object.hasOwn(state.requests, requestId)) return state.requests[requestId];
  const record = archivedRequest(loc, requestId);
  if (!record) return null;
  const request = record.request;
  if (record.receipt) state.receipts[requestId] = record.receipt;
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
// At most this many noted index writes are retried per compaction pass, least recently tried first.
const MAX_READINESS_RETRIES = 8;
// A reconciliation sweep lists at most this many archived request records; past it the sweep is incomplete.
const MAX_SWEEP_RECORDS = 65536;
// Each compaction pass reconciles at most this many archived request records.
const SWEEP_SLICE = 64;
const RECORD_NAME = /^[a-f0-9]{64}\.json$/;
// The untracked-plan count saturates here; it only ever reads as "up to N".
const MAX_UNTRACKED = 1 << 30;

const readinessRelative = (loc, planPath) => path.join(root(loc), 'readiness', `${readinessPlanKey(planPath)}.json`);
const readinessCitation = receipt => ({ id: receipt.id, requestId: receipt.requestId, verdict: receipt.verdict, recordedAt: receipt.recordedAt });

/**
 * The readiness citation that the retained request record `requestId` proves for `planPath`, built from
 * that record (never from the caller's copy), or null when the record is absent, is for another plan, or
 * holds another receipt. Throws when the record exists but its integrity changed.
 */
function archivedReadiness(loc, planPath, requestId, receiptId) {
  const record = archivedRequest(loc, requestId), receipt = record?.receipt;
  if (!record || record.request.planPath !== planPath || receipt?.type !== 'readiness' || receipt.id !== receiptId || !Number.isFinite(receipt.recordedAt)) return null;
  return readinessCitation(receipt);
}

/** True when an index's citation is the one its retained request record proves. */
function indexVerified(loc, index) {
  try { return archivedReadiness(loc, index.planPath, index.receipt?.requestId, index.receipt?.id)?.recordedAt === index.receipt.recordedAt; } catch { return false; }
}

/**
 * Keep the newest archived readiness receipt per plan so read-only citations survive compaction.
 * Returns 'written' after an index write, 'current' when the index already holds a newer or equal
 * receipt (nothing was written), and null when the citation lacks a plan, an id or a time. An index
 * that claims a newer receipt its request record does not prove is overwritten, so it never hides one.
 */
function retainLatestReadiness(loc, planPath, receipt) {
  if (typeof planPath !== 'string' || !ID.test(receipt?.id || '') || !Number.isFinite(receipt.recordedAt)) return null;
  const relative = readinessRelative(loc, planPath);
  let previous = null;
  try { previous = readRecord(loc, relative); } catch { previous = null; }
  if (previous?.planPath === planPath && previous.receipt?.recordedAt >= receipt.recordedAt && (previous.receipt.id === receipt.id || indexVerified(loc, previous))) return 'current';
  writeRecord(loc, relative, { schema: 1, workspace: loc.workspace, planPath, receipt: readinessCitation(receipt) });
  return 'written';
}

/**
 * True when the plan's readiness index exists, its retained request record proves the receipt it names,
 * and that proven receipt is at least as new as `entry`. The index's own time is never trusted: an index
 * with a valid self-hash can still claim a time its request record does not prove.
 */
function indexHolds(loc, entry) {
  let index = null, proven = null;
  try { index = readRecord(loc, readinessRelative(loc, entry.planPath)); } catch { return false; }
  if (index?.planPath !== entry.planPath || !object(index.receipt)) return false;
  try { proven = archivedReadiness(loc, index.planPath, index.receipt.requestId, index.receipt.id); } catch { return false; }
  return proven !== null && proven.recordedAt >= entry.recordedAt;
}

/**
 * The persisted reconciliation sweep: `after` is the last processed record name in sorted order,
 * `swept` the records processed so far, `unreadable`/`failed` this sweep's unreadable records and refused
 * index writes, `total` the record count last listed, and `last` what the previous full sweep found when
 * it could not clear the marker. A malformed sweep restarts from the beginning.
 */
const nonNegative = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
function sweepOf(pending) {
  const sweep = object(pending) && object(pending.sweep) ? pending.sweep : {};
  const last = object(sweep.last) ? { unreadable: nonNegative(sweep.last.unreadable), failed: nonNegative(sweep.last.failed), ...(sweep.last.overCap === true ? { overCap: true } : {}) } : null;
  return { ...(typeof sweep.after === 'string' && RECORD_NAME.test(sweep.after) ? { after: sweep.after } : {}),
    swept: nonNegative(sweep.swept), unreadable: nonNegative(sweep.unreadable), failed: nonNegative(sweep.failed), total: nonNegative(sweep.total), ...(last ? { last } : {}) };
}

/**
 * One bounded slice of the reconciliation sweep over `requests/*.json`: the next SWEEP_SLICE record names
 * after the cursor, in sorted order, each integrity-checked and its readiness receipt written to the plan's
 * index forward-only (an index already proving a newer or equal receipt is kept). Returns the advanced
 * sweep and whether this slice reached the end of the archive. Runs under the caller's per-pass lock.
 */
function sweepSlice(loc, sweep, faults) {
  const relative = path.join(root(loc), 'requests');
  if (!assertNoSymlinkAncestors(loc.home, relative)) return { sweep, done: false };
  const names = [];
  let overCap = false, directory = null;
  try {
    try { directory = fs.opendirSync(path.join(loc.home, relative)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (let item = directory?.readSync(); item; item = directory.readSync()) {
      if (!RECORD_NAME.test(item.name) || !item.isFile()) continue;
      if (names.length >= MAX_SWEEP_RECORDS) { overCap = true; break; }
      names.push(item.name);
    }
  } catch { return { sweep, done: false }; } finally { try { directory?.closeSync(); } catch { /* already closed */ } }
  names.sort();
  const start = sweep.after === undefined ? 0 : names.findIndex(name => name > sweep.after);
  const slice = start < 0 ? [] : names.slice(start, start + SWEEP_SLICE);
  let { unreadable, failed } = sweep;
  for (const name of slice) {
    const requestId = name.slice(0, 64);
    let record;
    try { record = archivedRequest(loc, requestId); } catch { unreadable += 1; continue; }
    const receipt = record?.receipt, planPath = record?.request?.planPath;
    if (receipt?.type !== 'readiness' || typeof planPath !== 'string' || !ID.test(receipt.id || '') || !Number.isFinite(receipt.recordedAt)) continue;
    try { retainLatestReadiness(loc, planPath, readinessCitation(receipt)); }
    catch (error) {
      failed += 1;
      faults.push({ requestId, plan: readinessPlanKey(planPath), message: `readiness index not reconciled for request ${requestId}: ${error.message}` });
    }
  }
  const done = start < 0 || start + SWEEP_SLICE >= names.length;
  const next = { ...(slice.length ? { after: slice.at(-1) } : sweep.after === undefined ? {} : { after: sweep.after }), swept: sweep.swept + slice.length, unreadable, failed, total: names.length, ...(sweep.last ? { last: sweep.last } : {}) };
  return { sweep: next, done, overCap };
}

const untrackedOf = pending => {
  if (!object(pending)) return 0;
  const count = Number.isSafeInteger(pending.untracked) && pending.untracked > 0 ? Math.min(pending.untracked, MAX_UNTRACKED) : 0;
  // A note from an earlier version said only that some plan was dropped.
  return count || (pending.capped === true ? 1 : 0);
};

/**
 * Archived readiness receipts whose index write did not succeed, one per plan (its newest), newest first:
 * facts about the archive, not warnings. A malformed entry, or one from an older shape, is ignored.
 * `untracked` counts plans dropped from tracking past the bound; it lasts until a reconciliation sweep
 * over the request archive completes cleanly.
 */
export function pendingReadiness(state) {
  const plans = object(state.readinessPending?.plans) ? state.readinessPending.plans : {};
  const entries = [];
  for (const [plan, entry] of Object.entries(plans)) {
    if (!object(entry) || typeof entry.planPath !== 'string' || readinessPlanKey(entry.planPath) !== plan || !ID.test(entry.id || '') || !ID.test(entry.requestId || '')
      || typeof entry.verdict !== 'string' || entry.verdict.length > 32 || !Number.isFinite(entry.recordedAt)) continue;
    entries.push({ plan, planPath: entry.planPath, id: entry.id, requestId: entry.requestId, verdict: entry.verdict, recordedAt: entry.recordedAt,
      ...(Number.isSafeInteger(entry.tried) && entry.tried > 0 ? { tried: entry.tried } : {}) });
  }
  entries.sort((a, b) => b.recordedAt - a.recordedAt || a.plan.localeCompare(b.plan));
  const untracked = Math.min(MAX_UNTRACKED, untrackedOf(state.readinessPending) + Math.max(0, entries.length - MAX_PENDING_READINESS));
  return { entries: entries.slice(0, MAX_PENDING_READINESS), capped: untracked > 0, untracked };
}

/**
 * Read-only readiness-index health, derived from what exists: a tracked plan is stale while its index is
 * missing or names a receipt older than the plan's newest archived one. Nothing here is stored or cleared.
 * `untracked` counts plans dropped from tracking whose index may still be stale; while it is nonzero,
 * `sweep` reports the reconciliation progress that compaction passes make toward clearing it.
 */
export function readinessIndexHealth(loc, state) {
  const { entries, capped, untracked } = pendingReadiness(state);
  const stale = entries.filter(entry => !indexHolds(loc, entry)).map(entry => entry.plan);
  if (!untracked) return { stale, capped, untracked };
  const sweep = sweepOf(state.readinessPending);
  return { stale, capped, untracked, sweep: { swept: sweep.swept, total: Math.max(sweep.total, sweep.swept), unreadable: sweep.unreadable, failed: sweep.failed, ...(sweep.last ? { last: sweep.last } : {}) } };
}

/** Read-only: a plan's newest archived readiness receipt whose index write failed, cross-checked against its retained request record. */
export function pendingArchivedReadiness(loc, state, planPath) {
  const entry = pendingReadiness(state).entries.find(item => item.planPath === planPath);
  return entry ? archivedReadiness(loc, planPath, entry.requestId, entry.id) : null;
}

/** Read-only: the newest archived readiness citation for a plan, cross-checked against its retained request record. */
export function latestArchivedReadiness(loc, planPath) {
  const index = readRecord(loc, readinessRelative(loc, planPath));
  if (!index || index.planPath !== planPath) return null;
  return archivedReadiness(loc, planPath, index.receipt?.requestId, index.receipt?.id);
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
 * newest archived receipt is noted in `state.readinessPending` so readers can cite it. A note leaves
 * once the plan's index holds a receipt at least as new, read from the index itself. Each pass retries
 * at most MAX_READINESS_RETRIES notes, least recently tried first, and a retry writes only the citation
 * its retained request record proves; a note that record does not prove is dropped. Past the tracking
 * bound the oldest notes are dropped and counted as untracked. While any plan is untracked, each pass
 * also reconciles a bounded slice of the request archive (SWEEP_SLICE records after a persisted cursor),
 * writing each readiness index forward-only; a full sweep with no unreadable record and no refused
 * write clears the count, and any other full sweep restarts. A note whose request record is absent or
 * proves something else is dropped; a note whose record cannot be read this pass is kept.
 * Returns this pass's index faults, `{ requestId, plan, message }`; callers may ignore them, because
 * status derives readiness-index health from the index and the notes, not from these faults.
 */
export function compactDecisions(loc, state) {
  const faults = [];
  // Small state with nothing hydrated retires nothing; it still retries noted index writes.
  const retireNow = Buffer.byteLength(stable(state)) > 512 * 1024 || state.archivedHydrated?.size > 0;
  if (!retireNow && state.readinessPending === undefined) return faults;
  const now = loc.now ?? Date.now(), touched = new Set();
  const noted = pendingReadiness(state), pending = new Map(noted.entries.map(entry => [entry.plan, entry]));
  let untracked = noted.untracked;
  const priorPass = state.readinessPending?.pass;
  const pass = Number.isSafeInteger(priorPass) && priorPass > 0 && priorPass < Number.MAX_SAFE_INTEGER ? priorPass + 1 : 1;
  const tried = new Set(), wrote = new Set();
  // Absent or mismatched evidence (null) is not unreadable evidence (threw): only the first drops a note.
  const prove = entry => { try { return { citation: archivedReadiness(loc, entry.planPath, entry.requestId, entry.id) }; } catch { return { threw: true }; } };
  const retain = (planPath, citation) => {
    const plan = readinessPlanKey(planPath);
    try { retainLatestReadiness(loc, planPath, citation); wrote.add(plan); return true; }
    catch (error) {
      tried.add(plan);
      faults.push({ requestId: citation.requestId, plan, message: `readiness index not retained for request ${citation.requestId}: ${error.message}` });
      const prior = pending.get(plan);
      // A prior note no retained record proves never outranks a real receipt.
      if (!prior || citation.recordedAt > prior.recordedAt || (prior.id !== citation.id && prove(prior).citation === null)) pending.set(plan, { plan, planPath, ...citation, tried: pass });
      else prior.tried = pass;
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
  // Each noted plan leaves once its index holds a receipt at least as new. Otherwise, a bounded number
  // of notes per pass retry the write from the retained request record: first plans whose index was
  // just written for an older request, then the least recently tried.
  const order = [...pending.values()].sort((a, b) => wrote.has(b.plan) - wrote.has(a.plan) || (a.tried || 0) - (b.tried || 0) || b.recordedAt - a.recordedAt || a.plan.localeCompare(b.plan));
  let retries = 0;
  for (const entry of order) {
    if (indexHolds(loc, entry)) { pending.delete(entry.plan); continue; }
    if (tried.has(entry.plan) || retries >= MAX_READINESS_RETRIES) continue;
    retries += 1;
    const { citation, threw } = prove(entry);
    if (threw) { entry.tried = pass; continue; }
    if (!citation) { pending.delete(entry.plan); continue; }
    pending.set(entry.plan, { plan: entry.plan, planPath: entry.planPath, ...citation, tried: pass });
    if (retain(entry.planPath, citation)) pending.delete(entry.plan);
  }
  // Bounded: the newest plans stay tracked; each dropped plan is counted until a reconciliation sweep
  // completes cleanly. A drop restarts the sweep, since its record may lie behind the cursor.
  const kept = [...pending.values()].sort((a, b) => b.recordedAt - a.recordedAt || a.plan.localeCompare(b.plan));
  let sweep = null;
  if (kept.length > MAX_PENDING_READINESS) untracked = Math.min(MAX_UNTRACKED, untracked + kept.length - MAX_PENDING_READINESS);
  else if (untracked) {
    const slice = sweepSlice(loc, sweepOf(state.readinessPending), faults);
    sweep = slice.sweep;
    if (slice.done && !slice.overCap && sweep.unreadable === 0 && sweep.failed === 0) { untracked = 0; sweep = null; }
    else if (slice.done) sweep = { swept: 0, unreadable: 0, failed: 0, total: sweep.total, last: { unreadable: sweep.unreadable, failed: sweep.failed, ...(slice.overCap ? { overCap: true } : {}) } };
  }
  if (!kept.length && !untracked) delete state.readinessPending;
  else state.readinessPending = { pass, ...(untracked ? { untracked } : {}), ...(untracked && sweep ? { sweep } : {}), plans: Object.fromEntries(kept.slice(0, MAX_PENDING_READINESS).map(({ plan, ...entry }) => [plan, entry])) };
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
