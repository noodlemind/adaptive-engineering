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
// A record that exists but can never prove anything as it stands (not a regular file, oversized, empty,
// truncated, malformed, a broken hash or binding), as opposed to one whose read failed (EMFILE, EIO).
const invalidRecord = message => Object.assign(fail(message), { invalid: true });

// A record that exists but cannot be used now and must be kept: its read failed (EMFILE, EIO, EACCES) or a
// newer version wrote it. `reason` names it for the archive-fault marker status reports.
const keptRecord = (message, reason) => Object.assign(fail(message), { reason });
// ENOTDIR: a regular file (or another non-directory) stands where a directory on the record's path belongs.
const inspectReason = error => error?.code === 'ENOTDIR' ? 'not-directory' : 'unreadable-now';

function readRecord(loc, relative) {
  const file = path.join(loc.home, relative);
  let stat;
  try { stat = fs.lstatSync(file, { throwIfNoEntry: false }); }
  catch (error) { throw keptRecord(`retained record cannot be inspected now: ${error.message}`, inspectReason(error)); }
  if (!stat) return null;
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw invalidRecord('retained record is not a regular file or is oversized');
  const bytes = readFileNoFollow(file, { root: loc.home, maxBytes: 2 * 1024 * 1024 });
  if (bytes === null) throw keptRecord('retained record is unreadable, oversized or redirected', 'unreadable-now');
  let record;
  try { record = JSON.parse(bytes); } catch { throw invalidRecord('retained record is malformed or unsafe'); }
  // A parsed record whose schema is not 1 was written by another (newer) version: it is kept, never judged
  // by this version's integrity rules and never replaced.
  if (object(record) && Object.hasOwn(record, 'schema') && record.schema !== 1) throw keptRecord(`retained record has schema ${JSON.stringify(record.schema).slice(0, 32)}, which this version does not know, so it is kept`, 'unknown-schema');
  const { id, ...value } = record || {};
  if (!object(record) || !ID.test(id || '') || hash(value) !== id || value.schema !== 1 || value.workspace !== loc.workspace) throw invalidRecord('retained record integrity or workspace binding changed');
  return value;
}

// A record that cannot be archived or written this pass: the caller keeps its live copy and retries it on a
// later pass. `reason` is one of ARCHIVE_REASONS and selects the remedy status gives.
const deferred = (message, reason, extra = {}) => Object.assign(fail(message), { deferred: true, reason }, extra);

// Consumption time is outside a receipt's id hash, so a pass whose state was never published can be retried
// and consume the same receipt again later. A retained record that already proves consumption stands.
const withoutConsumption = record => ({ ...record, receipt: object(record.receipt) ? { ...record.receipt, consumedAt: null } : record.receipt,
  nativeProbe: object(record.nativeProbe) ? { ...record.nativeProbe, consumedAt: null } : record.nativeProbe });
const consumedOnly = (previous, value) => object(previous.receipt) && Number.isFinite(previous.receipt.consumedAt) && object(value.receipt)
  && stable(withoutConsumption(previous)) === stable(withoutConsumption(value));

/**
 * Publish one retained record. Returns 'written', 'kept' when the immutable record is already retained, or
 * 'replaced' when the immutable record's name held a regular file whose content proved nothing (empty or
 * truncated after a crash, malformed, a broken hash or binding): the verified record replaces it. A
 * retained record is authoritative: one that differs from the value only in when it was consumed, and
 * already proves consumption, is 'kept' too. Anything that keeps the record from being written this pass
 * throws with `deferred` and a `reason`, and the caller keeps the live copy and retries it: a read that
 * fails now ('unreadable-now'), a newer-schema record ('unknown-schema'), a non-regular entry at its name,
 * which is never replaced ('not-regular'), a valid retained record that disagrees with the value, which is
 * never overwritten ('conflict'), a symlinked ancestor ('redirected') or a refused write, including a
 * directory that cannot be created ('refused-write').
 */
function writeRecord(loc, relative, value, immutable = false, durable = false) {
  // The directories first, then the leaf: a symlink at the record's own name is a non-regular entry to
  // remove, not a redirected directory.
  if (!assertNoSymlinkAncestors(loc.home, path.dirname(relative))) throw deferred('retained record path is redirected', 'redirected');
  let leaf;
  try { leaf = fs.lstatSync(path.join(loc.home, relative), { throwIfNoEntry: false }); }
  catch (error) { throw deferred(`retained record cannot be inspected now: ${error.message}`, inspectReason(error)); }
  if (leaf && !leaf.isFile()) throw deferred('retained record name holds a symlink or another non-regular entry, which is never replaced', 'not-regular', { notRegular: true });
  if (!assertNoSymlinkAncestors(loc.home, relative)) throw deferred('retained record path is redirected', 'redirected');
  const bytes = `${stable({ ...value, id: hash(value) })}\n`;
  if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw deferred('one retained record exceeds its bound', 'refused-write');
  let replace = false;
  if (immutable) {
    let previous;
    try { previous = readRecord(loc, relative); }
    catch (error) {
      if (!error.invalid) throw deferred(`retained request record cannot be used now, so its request stays live: ${error.message}`, error.reason || 'unreadable-now');
      let stat;
      try { stat = fs.lstatSync(path.join(loc.home, relative)); }
      catch (statError) { throw deferred(`retained request record cannot be inspected now, so its request stays live: ${statError.message}`, inspectReason(statError)); }
      if (!stat.isFile()) throw deferred('retained request record name holds a symlink or another non-regular entry, which is never replaced', 'not-regular', { notRegular: true });
      replace = true;
    }
    if (previous) {
      if (stable(previous) === stable(value) || consumedOnly(previous, value)) return 'kept';
      throw deferred('a valid retained request record disagrees with the live copy, and retained evidence is never overwritten', 'conflict');
    }
  } else {
    let stat;
    try { stat = fs.lstatSync(path.join(loc.home, relative), { throwIfNoEntry: false }); }
    catch (error) { throw deferred(`retained record cannot be inspected now: ${error.message}`, inspectReason(error)); }
    if (stat && !stat.isFile()) throw deferred('retained record name holds a symlink or another non-regular entry, which is never replaced', 'not-regular', { notRegular: true });
  }
  // Immutable request evidence is flushed before it is linked (or renamed over invalid content) where the
  // filesystem allows: a durable readiness index may name it. A failed flush never refuses it, and a
  // reader already treats invalid content as such. A directory that cannot be created (EACCES, EROFS,
  // EDQUOT) refuses the write like any other refusal.
  let written;
  try { written = writeFileContained(loc.home, relative, bytes, { exclusive: immutable && !replace, mode: 0o600, durable: immutable ? 'best-effort' : durable }); }
  catch (error) { throw deferred(`retained record publication refused: ${error.message}`, 'refused-write'); }
  if (!written) throw deferred('retained record publication refused', 'refused-write');
  return replace ? 'replaced' : 'written';
}

/** One archived request record by exact ID, integrity-checked, or null when none is retained. */
function archivedRequest(loc, requestId) {
  if (!ID.test(requestId || '')) return null;
  const record = readRecord(loc, path.join(root(loc), 'requests', `${requestId}.json`));
  if (!record) return null;
  const request = record.request;
  if (!object(request) || record.requestId !== requestId || request.requestId !== requestId) throw invalidRecord('request archive binding is invalid');
  const { requestId: ignored, createdAt, ...packet } = request;
  if (hash(packet) !== requestId || !Number.isFinite(createdAt)) throw invalidRecord('request archive integrity changed');
  if (record.receipt) {
    const { id, ...receipt } = record.receipt;
    if (receipt.requestId !== requestId || hash({ ...receipt, consumedAt: null }) !== id) throw invalidRecord('receipt archive integrity changed');
  }
  return record;
}

/**
 * Exact lookup only; no unbounded archive-directory scan is used for authority. A request hydrated from the
 * archive is read-only evidence: the next compaction drops it from live state without re-publishing it.
 * A lookup that fails throws; an error with a `reason` names a cause from ARCHIVE_REASONS.
 */
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
// Only a well-formed plan path is keyed: hashing encodes a lone surrogate as U+FFFD, so two different
// paths would share one index file and rebuild it from each other on every sweep.
const keyablePlan = planPath => typeof planPath === 'string' && planPath.isWellFormed();
// At most this many plans are tracked as possibly holding a stale readiness index.
const MAX_PENDING_READINESS = 256;
// At most this many noted index writes are retried per compaction pass, least recently tried first.
const MAX_READINESS_RETRIES = 8;
// A reconciliation sweep lists at most this many archived request records; past it the sweep is incomplete.
export const MAX_SWEEP_RECORDS = 65536;
// Each compaction pass reconciles at most this many archived request records.
const SWEEP_SLICE = 64;
const RECORD_NAME = /^[a-f0-9]{64}\.json$/;
// The untracked-plan count saturates here; it only ever reads as "up to N".
const MAX_UNTRACKED = 1 << 30;
// A sweep names at most this many offending archive files so status can say which file to act on, each
// as `{ file, reason }`: `file` is an archive-relative hex name only, and `reason` selects the remedy:
// 'unreadable-record' (a request record that cannot be read or proves nothing: restore it or move it out),
// 'not-regular' (an index file that is a symlink or not a regular file: remove it) and 'refused-write'
// (an index file that could not be read or written: fix its permissions or directory, or remove it).
// `offendersTruncated` says whether more offenders were found than are named.
const MAX_OFFENDERS = 8;
const OFFENDER = /^(requests|readiness)\/[a-f0-9]{64}\.json$/;
const REASONS = new Set(['unreadable-record', 'not-regular', 'refused-write', 'unknown-schema']);
// The requests directory itself, when a sweep cannot list it (a regular file, a symlink, unreadable).
const LISTING = { file: 'requests', reason: 'not-directory' };
// A bare name from an earlier version: a request record was unreadable; an index write was refused.
const offenderOf = item => object(item) && item.file === LISTING.file && item.reason === LISTING.reason ? { ...LISTING } : typeof item === 'string' ? (OFFENDER.test(item) ? { file: item, reason: item.startsWith('requests/') ? 'unreadable-record' : 'refused-write' } : null)
  : object(item) && typeof item.file === 'string' && OFFENDER.test(item.file) && REASONS.has(item.reason) && (item.reason === 'unreadable-record') === item.file.startsWith('requests/') ? { file: item.file, reason: item.reason } : null;
const offendersOf = value => {
  const list = [];
  for (const item of Array.isArray(value) ? value : []) {
    const offender = offenderOf(item);
    if (offender && list.length < MAX_OFFENDERS && !list.some(seen => seen.file === offender.file)) list.push(offender);
  }
  return list;
};
// A full list says whether more were found (`false` explicitly), so a full list from an earlier version,
// which never said, reads as truncated: it was cut at the cap.
const withOffenders = (list, truncated = false) => ({ ...(list.length ? { offenders: list } : {}),
  ...(list.length && truncated === true ? { offendersTruncated: true } : list.length >= MAX_OFFENDERS ? { offendersTruncated: false } : {}) });
const truncatedOf = (list, flag) => flag === true || (flag === undefined && list.length >= MAX_OFFENDERS);

const readinessRelative = (loc, planPath) => path.join(root(loc), 'readiness', `${readinessPlanKey(planPath)}.json`);

/**
 * The plan's readiness index, or null when it is absent or when its file was read but holds no valid
 * index (empty after a crash, truncated, malformed, oversized, a wrong self-hash or workspace): the index
 * is derived from the request archive, so invalid content is rebuilt, never kept. `invalid` reports
 * which. Throws, so the caller keeps the file and retries later, when the file cannot be read (EMFILE,
 * EIO, EACCES, a redirected ancestor) and when its leaf is a symlink or another non-regular entry, which
 * is never followed or replaced: the message names the file and the manual remedy.
 */
function readReadinessIndex(loc, relative, invalid = { value: false }) {
  const file = path.join(loc.home, relative), stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw Object.assign(fail(`the readiness index ${file} is a symlink or not a regular file, so it is never followed or replaced; remove it and the next decision prepare or record rebuilds it`), { notRegular: true });
  if (stat.size > 2 * 1024 * 1024) { invalid.value = true; return null; }
  const bytes = readFileNoFollow(file, { root: loc.home, maxBytes: 2 * 1024 * 1024 });
  if (bytes === null) throw fail('retained record is unreadable, oversized or redirected');
  let record;
  try { record = JSON.parse(bytes); } catch { invalid.value = true; return null; }
  // An index a newer version wrote is kept, never rebuilt over: readers fall back to live and noted receipts.
  if (object(record) && Object.hasOwn(record, 'schema') && record.schema !== 1) throw Object.assign(fail(`the readiness index ${file} has schema ${JSON.stringify(record.schema).slice(0, 32)}, which this version does not know (a newer version wrote it), so it is kept and not used`), { unknownSchema: true });
  const { id, ...value } = object(record) ? record : {};
  if (!object(record) || !ID.test(id || '') || hash(value) !== id || value.schema !== 1 || value.workspace !== loc.workspace) { invalid.value = true; return null; }
  return value;
}
/** The readiness index file name a status warning shows, relative to the archive: a hex plan key only. */
const readinessName = planPath => `readiness/${readinessPlanKey(planPath)}.json`;
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

/**
 * Keep the newest archived readiness receipt per plan so read-only citations survive compaction.
 * Returns 'written' after an index write, 'rebuilt' after it replaced an index file whose content was
 * invalid (nothing there was proven, so the caller's integrity-checked receipt wins and a sweep must
 * reconcile it against the plan's other records), 'current' when the index already holds a newer or equal
 * receipt (nothing was written), and null when the citation lacks a plan, an id or a time. The index's
 * receipt is judged by what its retained request record proves, never by the index's own time: it is
 * overwritten only when that record proves nothing (absent, another plan or another receipt) or proves an
 * older time. A record that reads but holds no valid record (empty after a crash, truncated, malformed, a
 * broken hash, not a regular file) proves nothing either: the index is rebuilt from the caller's receipt
 * ('rebuilt'), so a sweep reconciles the plan and names that record. When the index itself or that record
 * cannot be read (EMFILE, EIO), this throws and writes nothing, so a transient read failure never
 * downgrades the index; the caller notes the citation (or counts the failure) and a later pass retries.
 * A thrown error carries `offender`, the file a sweep names and why. A missing index file reads as "no
 * index"; one read but invalid is rebuilt.
 */
function retainLatestReadiness(loc, planPath, receipt) {
  if (!keyablePlan(planPath) || !ID.test(receipt?.id || '') || !Number.isFinite(receipt.recordedAt)) return null;
  const relative = readinessRelative(loc, planPath);
  const refused = (error, offender) => Object.assign(error, { offender });
  // Null when no file or invalid content; EMFILE, EIO, a redirected ancestor or a non-regular leaf throw.
  let previous;
  const invalid = { value: false };
  try { previous = readReadinessIndex(loc, relative, invalid); }
  catch (error) { throw refused(fail(`the readiness index cannot be read, so it is kept: ${error.message}`), { file: readinessName(planPath), reason: error.notRegular ? 'not-regular' : error.unknownSchema ? 'unknown-schema' : 'refused-write' }); }
  const write = citation => {
    try { writeRecord(loc, relative, { schema: 1, workspace: loc.workspace, planPath, receipt: readinessCitation(citation) }, false, true); }
    catch (error) { throw refused(error, { file: readinessName(planPath), reason: 'refused-write' }); }
    return 'written';
  };
  // A readable index of another shape proves nothing either.
  if (invalid.value || (previous && (previous.planPath !== planPath || !object(previous.receipt)))) { write(receipt); return 'rebuilt'; }
  if (!previous) return write(receipt);
  // The same receipt: the caller's copy is integrity-checked (its id hashes its time), the index's is not.
  if (previous.receipt.id === receipt.id) return previous.receipt.recordedAt === receipt.recordedAt && previous.receipt.requestId === receipt.requestId ? 'current' : write(receipt);
  let proven;
  try { proven = archivedReadiness(loc, planPath, previous.receipt.requestId, previous.receipt.id); }
  catch (error) {
    // It names a valid ID here: archivedRequest reads nothing for any other.
    if (error.invalid) { write(receipt); return 'rebuilt'; }
    throw refused(fail(`the indexed receipt's request record cannot be read, so the index is kept: ${error.message}`), { file: `requests/${previous.receipt.requestId}.json`, reason: 'unreadable-record' });
  }
  if (proven === null || proven.recordedAt < receipt.recordedAt) return write(receipt);
  // The index names a newer or equal proven receipt; correct a forged time on it to the proven one.
  return stable(proven) === stable(readinessCitation(previous.receipt)) ? 'current' : write(proven);
}

/**
 * True when the plan's readiness index exists, its retained request record proves the receipt it names,
 * and that proven receipt is at least as new as `entry`. The index's own time is never trusted: an index
 * with a valid self-hash can still claim a time its request record does not prove.
 */
function indexHolds(loc, entry) {
  if (!Number.isFinite(entry.recordedAt)) return false;
  let index = null, proven = null;
  try { index = readReadinessIndex(loc, readinessRelative(loc, entry.planPath)); } catch { return false; }
  if (index?.planPath !== entry.planPath || !object(index.receipt)) return false;
  try { proven = archivedReadiness(loc, index.planPath, index.receipt.requestId, index.receipt.id); } catch { return false; }
  return proven !== null && proven.recordedAt >= entry.recordedAt;
}

/**
 * The persisted reconciliation sweep: `after` is the last processed record name in sorted order,
 * `swept` the records processed so far, `unreadable`/`failed` this sweep's unreadable records and refused
 * index writes, `offenders` up to MAX_OFFENDERS of their archive-relative file names, `total` the record
 * count last listed, and `last` what the previous full sweep found (with its offenders) when it could not
 * clear the marker. A malformed sweep restarts from the beginning.
 */
const offendersIn = value => { const list = offendersOf(value.offenders); return withOffenders(list, truncatedOf(list, value.offendersTruncated)); };
const nonNegative = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
function sweepOf(pending) {
  const sweep = object(pending) && object(pending.sweep) ? pending.sweep : {};
  const last = object(sweep.last) ? { unreadable: nonNegative(sweep.last.unreadable), failed: nonNegative(sweep.last.failed), ...(sweep.last.overCap === true ? { overCap: true } : {}), ...offendersIn(sweep.last) } : null;
  return { ...(typeof sweep.after === 'string' && RECORD_NAME.test(sweep.after) ? { after: sweep.after } : {}),
    swept: nonNegative(sweep.swept), unreadable: nonNegative(sweep.unreadable), failed: nonNegative(sweep.failed), ...offendersIn(sweep), total: nonNegative(sweep.total), ...(last ? { last } : {}),
    ...(Number.isFinite(sweep.lastSweepAt) ? { lastSweepAt: sweep.lastSweepAt } : {}) };
}
/** The sweep restarted from the beginning, keeping what the previous full sweep found and when a slice last ran. */
const restartedSweep = sweep => ({ swept: 0, unreadable: 0, failed: 0, total: sweep.total, ...(sweep.last ? { last: sweep.last } : {}), ...(sweep.lastSweepAt !== undefined ? { lastSweepAt: sweep.lastSweepAt } : {}) });

/** The minimum time between reconciliation sweep slices that decision prepare and record run. */
export const READINESS_SWEEP_INTERVAL_MS = 30 * 1000;

/**
 * One bounded slice of the reconciliation sweep over `requests/*.json`: the next SWEEP_SLICE record names
 * after the cursor, in sorted order, each integrity-checked and its readiness receipt written to the plan's
 * index forward-only (an index already proving a newer or equal receipt is kept), adding each plan whose
 * index it wrote to `wrote`. Returns the advanced sweep and whether this slice reached the end of the
 * archive. A record name of a live request (in `live`) that cannot be used is skipped. Runs under the
 * caller's per-pass lock.
 */
function sweepSlice(loc, sweep, faults, wrote = new Set(), rebuilt = new Set(), live = new Set()) {
  const relative = path.join(root(loc), 'requests');
  // A requests path that cannot be listed stops the sweep; it is named so status can say what to fix.
  const unlisted = () => ({ sweep: { ...restartedSweep(sweep), last: { unreadable: 0, failed: 0, ...withOffenders([{ ...LISTING }]) } }, done: false });
  if (!assertNoSymlinkAncestors(loc.home, relative)) return unlisted();
  const names = [];
  let overCap = false, directory = null;
  try {
    try { directory = fs.opendirSync(path.join(loc.home, relative)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (let item = directory?.readSync(); item; item = directory.readSync()) {
      // A record name that is not a regular file (a symlink, a directory) is listed too: reading it fails,
      // so it counts as unreadable and the sweep can never finish clean past it.
      if (!RECORD_NAME.test(item.name)) continue;
      if (names.length >= MAX_SWEEP_RECORDS) { overCap = true; break; }
      names.push(item.name);
    }
  } catch (error) { faults.push({ requestId: null, plan: null, message: `the request archive cannot be listed: ${error.message}` }); return unlisted(); } finally { try { directory?.closeSync(); } catch { /* already closed */ } }
  names.sort();
  let start = sweep.after === undefined ? 0 : names.findIndex(name => name > sweep.after);
  // A cursor past every record (records removed, or a hostile state) proves nothing was covered: restart,
  // so the marker clears only after a pass over every record from the beginning.
  if (start < 0) { sweep = restartedSweep(sweep); start = 0; }
  const slice = names.slice(start, start + SWEEP_SLICE);
  let { unreadable, failed } = sweep;
  const offenders = offendersOf(sweep.offenders);
  let truncated = sweep.offendersTruncated === true;
  const offend = offender => {
    if (offenders.some(seen => seen.file === offender.file)) return;
    if (offenders.length < MAX_OFFENDERS) offenders.push(offender); else truncated = true;
  };
  for (const name of slice) {
    const requestId = name.slice(0, 64);
    let record;
    // A live request's record name that cannot be used is the archive-fault marker's to report: the request
    // has not archived, and its readiness index is written when it does.
    try { record = archivedRequest(loc, requestId); } catch { if (live.has(requestId)) continue; unreadable += 1; offend({ file: `requests/${name}`, reason: 'unreadable-record' }); continue; }
    const receipt = record?.receipt, planPath = record?.request?.planPath;
    if (receipt?.type !== 'readiness' || !keyablePlan(planPath) || !ID.test(receipt.id || '') || !Number.isFinite(receipt.recordedAt)) continue;
    try {
      const result = retainLatestReadiness(loc, planPath, readinessCitation(receipt));
      if (result === 'written' || result === 'rebuilt') wrote.add(readinessPlanKey(planPath));
      if (result === 'rebuilt') rebuilt.add(readinessPlanKey(planPath));
    } catch (error) {
      failed += 1;
      offend(offenderOf(error.offender) || { file: readinessName(planPath), reason: 'refused-write' });
      faults.push({ requestId, plan: readinessPlanKey(planPath), message: `readiness index not reconciled for request ${requestId}: ${error.message}` });
    }
  }
  const done = start + SWEEP_SLICE >= names.length;
  const next = { ...(slice.length ? { after: slice.at(-1) } : sweep.after === undefined ? {} : { after: sweep.after }), swept: sweep.swept + slice.length, unreadable, failed, ...withOffenders(offenders, truncated), total: names.length,
    ...(sweep.last ? { last: sweep.last } : {}), ...(sweep.lastSweepAt !== undefined ? { lastSweepAt: sweep.lastSweepAt } : {}) };
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
    if (!object(entry) || !keyablePlan(entry.planPath) || readinessPlanKey(entry.planPath) !== plan || !ID.test(entry.id || '') || !ID.test(entry.requestId || '')
      || typeof entry.verdict !== 'string' || entry.verdict.length > 32 || !Number.isFinite(entry.recordedAt)) continue;
    entries.push({ plan, planPath: entry.planPath, id: entry.id, requestId: entry.requestId, verdict: entry.verdict, recordedAt: entry.recordedAt,
      ...(Number.isSafeInteger(entry.tried) && entry.tried > 0 ? { tried: entry.tried } : {}) });
  }
  entries.sort((a, b) => b.recordedAt - a.recordedAt || a.plan.localeCompare(b.plan));
  const overflow = Math.max(0, entries.length - MAX_PENDING_READINESS);
  const untracked = Math.min(MAX_UNTRACKED, untrackedOf(state.readinessPending) + overflow);
  return { entries: entries.slice(0, MAX_PENDING_READINESS), capped: untracked > 0, untracked, overflow: overflow > 0 };
}

/**
 * Read-only readiness-index health, derived from what exists: a tracked plan is stale while its index is
 * missing or names a receipt older than the plan's newest archived one. Nothing here is stored or cleared.
 * `untracked` counts plans dropped from tracking whose index may still be stale; while it is nonzero,
 * `sweep` reports the reconciliation progress that compaction passes make toward clearing it.
 */
export function readinessIndexHealth(loc, state) {
  const { entries, capped, untracked, overflow } = pendingReadiness(state);
  const staleEntries = entries.filter(entry => !indexHolds(loc, entry)), stale = staleEntries.map(entry => entry.plan);
  // A stale plan whose index leaf is a symlink or another non-regular entry stays stale until someone
  // removes that entry, since it is never followed or replaced; name it (lstat only, never followed).
  const blocked = [];
  for (const entry of staleEntries) {
    if (blocked.length >= MAX_OFFENDERS) break;
    try { const stat = fs.lstatSync(path.join(loc.home, readinessRelative(loc, entry.planPath)), { throwIfNoEntry: false }); if (stat && !stat.isFile()) blocked.push(readinessName(entry.planPath)); }
    catch { /* unreadable now: reported as stale */ }
  }
  const archive = path.join(loc.home, root(loc));
  const base = { stale, capped, untracked, archive, ...(blocked.length ? { blocked } : {}) };
  if (!untracked) return base;
  // Plans dropped from an over-bound stored state may lie behind the cursor, so the sweep restarts.
  const sweep = overflow ? restartedSweep(sweepOf(state.readinessPending)) : sweepOf(state.readinessPending);
  // A forged progress count never reads as more records than were listed.
  return { ...base, sweep: { swept: Math.min(sweep.swept, sweep.total), total: sweep.total, unreadable: sweep.unreadable, failed: sweep.failed, ...withOffenders(sweep.offenders || [], sweep.offendersTruncated), ...(sweep.last ? { last: sweep.last } : {}) } };
}

/** Read-only: a plan's newest archived readiness receipt whose index write failed, cross-checked against its retained request record. */
export function pendingArchivedReadiness(loc, state, planPath) {
  const entry = pendingReadiness(state).entries.find(item => item.planPath === planPath);
  return entry ? archivedReadiness(loc, planPath, entry.requestId, entry.id) : null;
}

/** Read-only: the newest archived readiness citation for a plan, cross-checked against its retained request record. */
export function latestArchivedReadiness(loc, planPath) {
  if (!keyablePlan(planPath)) return null;
  const index = readReadinessIndex(loc, readinessRelative(loc, planPath));
  if (!index || index.planPath !== planPath) return null;
  return archivedReadiness(loc, planPath, index.receipt?.requestId, index.receipt?.id);
}

function validTask(value) {
  return object(value) && Number.isFinite(value.startedAt) && object(value.counts) && ['decisions', 'repairs', 'acquisitions'].every(key => Number.isSafeInteger(value.counts[key]) && value.counts[key] >= 0);
}

/**
 * Counters retain the earliest start and greatest observed use across crash recovery. A retained task
 * record that reads but proves nothing (empty or partial after a crash, malformed, a broken hash or
 * binding) yields to the live copy, and the next retirement replaces it; with no live copy it throws
 * ('invalid-task'), since the budget cannot be verified. One that cannot be used now (a failed read, a
 * newer schema, a non-regular entry at its name) throws with a `reason`, so the caller keeps the live task.
 * Every thrown error carries `file`, the archive-relative record name.
 */
export function decisionTask(loc, state, key) {
  if (!ID.test(key || '')) return null;
  try { return taskRecord(loc, state, key); }
  catch (error) { if (error.reason) error.file = `tasks/${key}.json`; throw error; }
}
function taskRecord(loc, state, key) {
  const relative = path.join(root(loc), 'tasks', `${key}.json`);
  let retained;
  try { retained = readRecord(loc, relative); }
  catch (error) {
    if (!error.invalid) throw Object.assign(fail(`retained task budget cannot be used now: ${error.message}`), { reason: error.reason || 'unreadable-now' });
    let stat;
    try { stat = fs.lstatSync(path.join(loc.home, relative)); }
    catch (statError) { throw Object.assign(fail(`retained task budget cannot be inspected now: ${statError.message}`), { reason: inspectReason(statError) }); }
    if (!stat.isFile()) throw Object.assign(fail('retained task budget name holds a symlink or another non-regular entry, which is never replaced'), { reason: 'not-regular' });
    retained = undefined;
  }
  if (retained && (retained.budgetKey !== key || !validTask(retained.task))) retained = undefined;
  // Fail closed: a record that proves nothing can stand in for nothing, so without a live copy the budget
  // cannot be verified, and deleting the record (which resets the budget) is the user's choice.
  if (retained === undefined && !state.tasks[key]) throw Object.assign(fail('retained task budget proves nothing (empty, partial or malformed) and no live copy exists'), { reason: 'invalid-task' });
  const current = state.tasks[key];
  if (current && !validTask(current)) throw fail('live task budget is malformed');
  if (!current && !retained) return null;
  const task = current && retained ? { startedAt: Math.min(current.startedAt, retained.task.startedAt), counts: Object.fromEntries(['decisions', 'repairs', 'acquisitions'].map(name => [name, Math.max(current.counts[name], retained.task.counts[name])])) } : current || retained.task;
  state.tasks[key] = task;
  return task;
}

// The archive-fault marker: records the last retiring pass could not archive, which stay live in the decision
// state. `count` counts them; `files` names up to MAX_OFFENDERS by archive-relative hex name with the reason
// that selects the remedy, and `at` when the pass ran. Recomputed by every retiring pass; while it is set, a
// pass that retries (not a guarded tool call) retires at most once per `options.archiveRetryInterval`, so a
// fixed record archives on the next such pass and the marker clears.
const ARCHIVE_FAULT = /^(requests|tasks)\/[a-f0-9]{64}\.json$/;
export const ARCHIVE_REASONS = Object.freeze(['not-regular', 'not-directory', 'unreadable-now', 'unknown-schema', 'invalid-task', 'conflict', 'redirected', 'refused-write']);
/** The sanitized archive-fault marker, with the archive path its file names are relative to. */
export function archiveFaults(loc, state) {
  const value = object(state.archiveFaults) ? state.archiveFaults : {}, files = [];
  for (const item of Array.isArray(value.files) ? value.files : []) {
    if (files.length >= MAX_OFFENDERS) break;
    if (object(item) && typeof item.file === 'string' && ARCHIVE_FAULT.test(item.file) && ARCHIVE_REASONS.includes(item.reason) && !files.some(seen => seen.file === item.file)) files.push({ file: item.file, reason: item.reason });
  }
  const count = Math.min(MAX_UNTRACKED, Math.max(nonNegative(value.count), files.length));
  return { count, files, truncated: count > files.length, archive: path.join(loc.home, root(loc)), ...(count && Number.isFinite(value.at) ? { at: value.at } : {}) };
}
/**
 * Retire terminal/expired context while retaining immutable evidence and durable budgets.
 * A refused readiness-index write never blocks compaction: the request still archives, and the plan's
 * newest archived receipt is noted in `state.readinessPending` so readers can cite it. A note leaves
 * once the plan's index holds a receipt at least as new, read from the index itself. Each pass retries
 * at most MAX_READINESS_RETRIES notes, least recently tried first, and a retry writes only the citation
 * its retained request record proves; a note that record does not prove is dropped. Past the tracking
 * bound the oldest notes are dropped and counted as untracked. While any plan is untracked, a pass may
 * also reconcile a bounded slice of the request archive (SWEEP_SLICE records after a persisted cursor),
 * writing each readiness index forward-only; a full sweep with no unreadable record and no refused
 * write clears the count, and any other full sweep restarts. A slice runs only when `options.sweep` is
 * not false and at least `options.sweepInterval` ms (default 0) have passed since the last slice, whose
 * time is kept in the sweep state; the pre-tool consume path passes `sweep: false`, so it never lists the
 * archive. A note whose request record is absent or proves something else is dropped; a note whose record
 * cannot be read this pass is kept. Only the notes retried this pass, and those of plans written this
 * pass, read the index, so one pass reads at most MAX_READINESS_RETRIES indexes beyond its own writes.
 * `options.retries: false` (the pre-tool consume path) retries no note and leaves the pass counter as it is,
 * so a guarded tool call does no readiness bookkeeping beyond the receipts it archives itself.
 * A request hydrated from the archive is read-only evidence: every pass drops it from live state without
 * re-publishing it, and writes its plan's index forward-only from the retained record's receipt, never the
 * live copy. That receipt is never noted (a newer one may already be archived); when its index write fails, the plan is counted as untracked and the sweep restarts, so status reports it and a
 * full sweep reconciles it. An index file read but invalid (empty, truncated, malformed) is rebuilt from
 * the receipt at hand, and its plan is likewise counted as untracked until a restarted sweep reconciles
 * it against every record. A request record that reads but proves nothing (empty, truncated, a broken
 * hash) is never waited on: an index naming it is rebuilt from the receipt at hand, a note citing it is
 * dropped, and either way the plan is counted as untracked, so a restarted sweep reconciles it and names
 * that record. A read that fails (EMFILE, EIO) is retried instead. A sweep keeps up to MAX_OFFENDERS
 * archive-relative names of the files it could not use, each with its reason, so status can name them
 * and give the matching remedy. A plan path that is not well-formed Unicode is never indexed or noted.
 * Archiving never throws out of the pass: a failed flush publishes a request record unflushed; a record
 * name holding content that proves nothing (left by a crash after link, before the state was published) is
 * replaced with the verified record, and its plan is counted as untracked so a restarted sweep reconciles
 * it; a retained record that already proves consumption stands over a live copy consumed again later; and
 * a request or task record that cannot be archived this pass (see writeRecord and decisionTask) keeps its
 * live copy, is counted and named in `state.archiveFaults` with its reason, and is retried by later passes
 * (see the marker) until it archives. A sweep skips a live request's record name, which that marker
 * reports instead.
 * Returns this pass's faults, `{ requestId, plan, message }` (`requestId` and `plan` null for a task,
 * `plan` null for a request without a readiness receipt); callers may ignore them, because status derives
 * readiness-index health from the index, the notes and the sweep, and archive health from the marker.
 */
export function compactDecisions(loc, state, options = {}) {
  const faults = [];
  // Requests hydrated from the archive are read-only evidence the archive already holds: they leave live
  // state here, are never re-published from their live copy (which a caller may have changed), and their
  // plan's index is written forward-only from the retained record's own receipt below.
  delete state.hydratedLive;
  const hydrated = [...(state.archivedHydrated || [])].filter(id => Object.hasOwn(state.requests, id));
  for (const id of hydrated) {
    delete state.requests[id]; delete state.receipts[id]; delete state.observations[id]; delete state.nativeProbes[id];
    for (const [key, value] of Object.entries(state.invocations)) if (value?.requestId === id) delete state.invocations[key];
  }
  state.archivedHydrated?.clear();
  // Small state with no deferred record retires nothing; it still retries noted index writes.
  // Deferred records are retried by a decision prepare or record pass (never a guarded tool call), at most
  // once per `options.archiveRetryInterval` ms (default 0); a large state retires on every pass anyway.
  const held = archiveFaults(loc, state), now0 = loc.now ?? Date.now();
  const retryInterval = Number.isFinite(options.archiveRetryInterval) && options.archiveRetryInterval > 0 ? options.archiveRetryInterval : 0;
  const retryHeld = held.count > 0 && options.retries !== false && (held.at === undefined || now0 < held.at || now0 - held.at >= retryInterval);
  const retireNow = Buffer.byteLength(stable(state)) > 512 * 1024 || retryHeld;
  // The consume path (retries off) with nothing to retire leaves readiness bookkeeping untouched.
  if (!retireNow && !hydrated.length && (state.readinessPending === undefined || options.retries === false)) return faults;
  const now = loc.now ?? Date.now(), touched = new Set();
  const noted = pendingReadiness(state), pending = new Map(noted.entries.map(entry => [entry.plan, entry]));
  let untracked = noted.untracked;
  const priorPass = state.readinessPending?.pass;
  const validPass = Number.isSafeInteger(priorPass) && priorPass > 0 && priorPass < Number.MAX_SAFE_INTEGER;
  const retrying = options.retries !== false;
  const pass = validPass ? priorPass + (retrying ? 1 : 0) : 1;
  // A note never claims to have been tried after this pass, so a hostile time cannot starve its retry.
  for (const entry of pending.values()) if (entry.tried > pass) entry.tried = pass;
  const tried = new Set(), wrote = new Set(), untrackedNow = new Set(), rebuilt = new Set();
  const deferredFiles = [];
  let deferredCount = 0;
  const defer = (file, reason) => {
    deferredCount += 1;
    if (deferredFiles.length < MAX_OFFENDERS && !deferredFiles.some(seen => seen.file === file)) deferredFiles.push({ file, reason: ARCHIVE_REASONS.includes(reason) ? reason : 'refused-write' });
  };
  // A retained task budget that cannot be used now leaves only the live copy to judge expiry by.
  const taskOf = key => {
    try { return decisionTask(loc, state, key); }
    catch { return validTask(state.tasks[key]) ? state.tasks[key] : null; }
  };
  // A pass that leaves a plan untracked whose record may lie behind the sweep cursor restarts the sweep.
  let restart = false;
  // Absent or mismatched evidence (null) is not unreadable evidence (threw): only the first drops a note.
  // A record that reads but proves nothing (invalid) is null evidence too, and its plan is counted as
  // untracked so a restarted sweep reconciles it and names that record.
  const untrack = plan => { if (!untrackedNow.has(plan)) { untrackedNow.add(plan); untracked = Math.min(MAX_UNTRACKED, untracked + 1); } restart = true; };
  const prove = entry => {
    try { return { citation: archivedReadiness(loc, entry.planPath, entry.requestId, entry.id) }; }
    catch (error) { if (!error.invalid) return { threw: true }; untrack(entry.plan); return { citation: null }; }
  };
  const retain = (planPath, citation) => {
    const plan = readinessPlanKey(planPath);
    try { if (retainLatestReadiness(loc, planPath, citation) === 'rebuilt') rebuilt.add(plan); wrote.add(plan); return true; }
    catch (error) {
      tried.add(plan);
      faults.push({ requestId: citation.requestId, plan, message: `readiness index not retained for request ${citation.requestId}: ${error.message}` });
      const prior = pending.get(plan);
      // The prior note's time is judged by what its retained record proves, never by the note's own time:
      // a note no record proves never outranks a real receipt, and a forged time never hides a newer one.
      // Only a record that cannot be read this pass falls back to the note's time, so the note is kept.
      const proof = prior && prior.id !== citation.id ? prove(prior) : null;
      const priorAt = proof?.citation ? proof.citation.recordedAt : prior?.recordedAt;
      if (!prior || prior.id === citation.id || (proof && !proof.threw && proof.citation === null) || citation.recordedAt > priorAt) pending.set(plan, { plan, planPath, ...citation, tried: pass });
      else prior.tried = pass;
      return false;
    }
  };
  for (const requestId of hydrated) {
    // The retained record, read again: what the archive proves, never the live copy.
    let record;
    try { record = archivedRequest(loc, requestId); } catch { continue; }
    const receipt = record?.receipt, planPath = record?.request?.planPath;
    if (receipt?.type !== 'readiness' || !keyablePlan(planPath)) continue;
    const plan = readinessPlanKey(planPath);
    try { if (retainLatestReadiness(loc, planPath, readinessCitation(receipt)) === 'rebuilt') rebuilt.add(plan); }
    catch (error) {
      faults.push({ requestId, plan, message: `readiness index not retained for re-archived request ${requestId}: ${error.message}` });
      // Its record may lie behind the sweep cursor, so a sweep already past it must not clear the count.
      untrack(plan);
    }
  }
  for (const [requestId, request] of retireNow ? Object.entries(state.requests) : []) {
    const task = taskOf(request.budgetKey), receipt = state.receipts[requestId];
    const seconds = request.budgets?.maxSeconds;
    const expired = task && Number.isSafeInteger(seconds) && now >= task.startedAt && now - task.startedAt > seconds * 1000;
    const terminal = receipt && (!receipt.authorized || receipt.consumedAt !== null);
    // A first-invocation probe must remain discoverable by role/session until
    // its original task budget expires; retained exact-ID lookup remains possible.
    if (!expired && (!terminal || state.nativeProbes[requestId])) continue;
    const invocations = Object.fromEntries(Object.entries(state.invocations).filter(([, value]) => value.requestId === requestId));
    const record = { schema: 1, workspace: loc.workspace, requestId, request, receipt: receipt || null, observation: state.observations[requestId] || null, nativeProbe: state.nativeProbes[requestId] || null, invocations };
    const readinessPlan = receipt?.type === 'readiness' && keyablePlan(request.planPath) ? readinessPlanKey(request.planPath) : null;
    let archived;
    try { archived = writeRecord(loc, path.join(root(loc), 'requests', `${requestId}.json`), record, true); }
    catch (error) {
      // The request stays live, is named in the archive-fault marker, and is retried on later passes.
      faults.push({ requestId, plan: readinessPlan, message: `request ${requestId} not archived this pass, kept live: ${error.message}` });
      defer(`requests/${requestId}.json`, error.reason);
      continue;
    }
    if (archived === 'replaced') {
      // The name held content that proved nothing (a crash after link, before the state was published).
      // An index may have been rebuilt from an older receipt meanwhile, so the plan is reconciled again.
      faults.push({ requestId, plan: readinessPlan, message: `request record ${requestId} held content that proved nothing and was replaced with the verified record` });
      if (readinessPlan) untrack(readinessPlan);
    }
    if (receipt?.type === 'readiness' && keyablePlan(request.planPath) && ID.test(receipt.id || '') && Number.isFinite(receipt.recordedAt)) {
      retain(request.planPath, readinessCitation(receipt));
    }
    touched.add(request.budgetKey);
    delete state.requests[requestId]; delete state.receipts[requestId]; delete state.observations[requestId]; delete state.nativeProbes[requestId];
    for (const key of Object.keys(invocations)) delete state.invocations[key];
  }
  // Each noted plan leaves once its index holds a receipt at least as new. Plans whose index was just
  // written are checked first; then a bounded number of notes per pass, least recently tried first, are
  // verified against their retained request record and, unless the index holds that proven receipt,
  // retried from it. No other note reads the index this pass; status checks every note.
  const order = [...pending.values()].sort((a, b) => wrote.has(b.plan) - wrote.has(a.plan) || (a.tried || 0) - (b.tried || 0) || b.recordedAt - a.recordedAt || a.plan.localeCompare(b.plan));
  let retries = 0;
  for (const entry of order) {
    if (wrote.has(entry.plan) && indexHolds(loc, entry)) { pending.delete(entry.plan); continue; }
    if (tried.has(entry.plan) || retries >= (retrying ? MAX_READINESS_RETRIES : 0)) continue;
    retries += 1;
    const { citation, threw } = prove(entry);
    if (threw) { entry.tried = pass; continue; }
    if (!citation) { pending.delete(entry.plan); continue; }
    // The proven time, not the note's own, decides whether the index holds it.
    if (indexHolds(loc, { planPath: entry.planPath, recordedAt: citation.recordedAt })) { pending.delete(entry.plan); continue; }
    pending.set(entry.plan, { plan: entry.plan, planPath: entry.planPath, ...citation, tried: pass });
    if (retain(entry.planPath, citation)) pending.delete(entry.plan);
  }
  // An index rebuilt from invalid content proved nothing about the plan's other receipts: the plan is
  // counted as untracked until a full sweep, restarted since those records may lie behind the cursor,
  // reconciles it against every record.
  for (const plan of rebuilt) untrack(plan);
  // Bounded: the newest plans stay tracked; each dropped plan is counted until a reconciliation sweep
  // completes cleanly. A drop restarts the sweep, since its record may lie behind the cursor.
  let kept = [...pending.values()].sort((a, b) => b.recordedAt - a.recordedAt || a.plan.localeCompare(b.plan));
  let sweep = null;
  if (kept.length > MAX_PENDING_READINESS) untracked = Math.min(MAX_UNTRACKED, untracked + kept.length - MAX_PENDING_READINESS);
  else if (untracked) {
    // Plans dropped from an over-bound stored state may lie behind the cursor, so the sweep restarts.
    const prior = noted.overflow || restart ? restartedSweep(sweepOf(state.readinessPending)) : sweepOf(state.readinessPending);
    const interval = Number.isFinite(options.sweepInterval) && options.sweepInterval > 0 ? options.sweepInterval : 0;
    const due = options.sweep !== false && (prior.lastSweepAt === undefined || now < prior.lastSweepAt || now - prior.lastSweepAt >= interval);
    sweep = prior;
    if (due) {
      const sweptPlans = new Set(), sweptRebuilt = new Set();
      const slice = sweepSlice(loc, { ...prior, lastSweepAt: now }, faults, sweptPlans, sweptRebuilt, new Set(Object.keys(state.requests)));
      // A note whose plan index the sweep just wrote leaves once that index holds it.
      kept = kept.filter(entry => !(sweptPlans.has(entry.plan) && indexHolds(loc, entry)));
      sweep = slice.sweep;
      const clean = !slice.overCap && sweep.unreadable === 0 && sweep.failed === 0;
      // An index rebuilt from invalid content mid-sweep may hold an older receipt than one behind the cursor.
      if (slice.done && clean && !sweptRebuilt.size) { untracked = 0; sweep = null; }
      else if (slice.done && clean) sweep = restartedSweep(sweep);
      else if (slice.done) sweep = { ...restartedSweep(sweep), last: { unreadable: sweep.unreadable, failed: sweep.failed, ...(slice.overCap ? { overCap: true } : {}), ...withOffenders(offendersOf(sweep.offenders), sweep.offendersTruncated) } };
    }
  }
  if (!kept.length && !untracked) delete state.readinessPending;
  else state.readinessPending = { pass, ...(untracked ? { untracked } : {}), ...(untracked && sweep ? { sweep } : {}), plans: Object.fromEntries(kept.slice(0, MAX_PENDING_READINESS).map(({ plan, ...entry }) => [plan, entry])) };
  if (!retireNow) return faults;
  const liveTasks = new Set(Object.values(state.requests).map(request => request.budgetKey));
  for (const key of new Set([...touched, ...Object.keys(state.tasks)])) {
    if (liveTasks.has(key)) continue;
    let task;
    try { task = decisionTask(loc, state, key); }
    catch (error) {
      // A malformed live task (no reason) is left as it is. A retained record that cannot be used is reported
      // only while a live task is kept because of it; with no live task, prepare, record and status report it.
      if (error.reason && Object.hasOwn(state.tasks, key)) { defer(`tasks/${key}.json`, error.reason); faults.push({ requestId: null, plan: null, message: `task budget ${key} not retired this pass, kept live: ${error.message}` }); }
      continue;
    }
    if (!task) continue;
    try { writeRecord(loc, path.join(root(loc), 'tasks', `${key}.json`), { schema: 1, workspace: loc.workspace, budgetKey: key, task }, false, 'best-effort'); }
    catch (error) {
      defer(`tasks/${key}.json`, error.reason);
      faults.push({ requestId: null, plan: null, message: `task budget ${key} not retired this pass, kept live: ${error.message}` });
      continue;
    }
    delete state.tasks[key];
  }
  if (deferredCount) state.archiveFaults = { count: Math.min(MAX_UNTRACKED, deferredCount), files: deferredFiles, at: now };
  else delete state.archiveFaults;
  return faults;
}
