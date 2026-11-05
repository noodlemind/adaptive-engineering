import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertNoSymlinkAncestors, readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { readSessionState } from '../corpus/hooks/lib/session-state.mjs';
import { acquireFileLock, releaseFileLock } from './file-lock.mjs';

const ROOT = '.harness/intent-observations';
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{32}\.[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw Object.assign(new Error(`host intent: ${message}`), { code: 'E_OBSERVED_INTENT', exit: 2 }); };
const line = value => typeof value === 'string' && value.trim() && value.length <= 1000 && !/[\u0000-\u001f\u007f]/.test(value);

function canonicalPlan(root, planPath) {
  const full = path.resolve(root, planPath);
  try { return fs.realpathSync.native(full); } catch { return full; }
}

function identity(workspace, sessionId) {
  const root = fs.realpathSync.native(path.resolve(workspace));
  const selected = sessionId ?? readSessionState(root)?.sessionId;
  if (selected === undefined || selected === null || selected === '') {
    const active = read(root, `${ROOT}/active-session.json`);
    if (active && (active.version !== 1 || !HASH.test(active.sessionHash || '') || Object.keys(active).some(key => !['version', 'sessionHash'].includes(key)))) fail('invalid active session binding');
    return { root, sessionHash: active?.sessionHash || null };
  }
  if (!line(selected)) fail('invalid host session identity');
  return { root, sessionHash: hash(selected), sessionId: selected };
}

function read(root, relative) {
  const full = assertNoSymlinkAncestors(root, relative);
  if (!full) fail('unsafe observation path');
  const stat = fs.lstatSync(full, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink !== 1) fail('unsafe observation file');
  const bytes = readFileNoFollow(full, { root, maxBytes: 8192 });
  if (bytes === null) fail('unreadable observation file');
  try {
    const value = JSON.parse(bytes);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid observation record');
    return value;
  } catch { fail('invalid observation record'); }
}

function write(root, relative, value, { exclusive = false } = {}) {
  if (!writeFileContained(root, relative, JSON.stringify(value) + '\n', { exclusive, mode: 0o600 })) fail('unsafe observation publication');
}

function current(root, sessionHash) {
  if (!sessionHash) return null;
  const value = read(root, `${ROOT}/sessions/${sessionHash}.json`);
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['version', 'source', 'sessionHash', 'id', 'digest', 'host', 'observedAt', 'timestamp'].includes(key))
    || value.version !== 1 || value.source !== 'host-event' || value.sessionHash !== sessionHash || !ID.test(value.id || '')
    || !value.id.startsWith(sessionHash.slice(0, 32) + '.') || !HASH.test(value.digest || '') || !['claude-code', 'copilot'].includes(value.host)
    || !line(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt)) || value.timestamp !== undefined && (!Number.isSafeInteger(value.timestamp) || value.timestamp < 0)) fail('invalid observation record');
  const event = read(root, `${ROOT}/events/${value.id}.json`);
  if (JSON.stringify(value) !== JSON.stringify(event)) fail('invalid observation event binding');
  return value;
}

function receipt(root, observation, planPath, revision) {
  if (!planPath || !HASH.test(revision || '')) return null;
  const plan = canonicalPlan(root, planPath);
  const relative = `${ROOT}/accepted/${observation.id}/${hash(plan)}-${revision}.json`;
  const value = read(root, relative);
  if (value && (Object.keys(value).some(key => !['version', 'id', 'plan', 'revision', 'sessionHash', 'disposition', 'operationId'].includes(key))
    || value.version !== 1 || value.id !== observation.id || value.plan !== plan || value.revision !== revision || value.sessionHash !== observation.sessionHash
    || !['amend', 'unchanged'].includes(value.disposition) || !line(value.operationId))) fail('invalid acceptance record');
  return value;
}

function observationError(root, sessionHash) {
  const error = read(root, `${ROOT}/errors/${sessionHash}.json`);
  if (error && (typeof error !== 'object' || Array.isArray(error) || Object.keys(error).some(key => !['version', 'sessionHash', 'reason', 'id'].includes(key))
    || error.version !== 1 || error.sessionHash !== sessionHash || !['observation-in-progress', 'observation-failed'].includes(error.reason)
    || error.id !== undefined && (!ID.test(error.id) || !error.id.startsWith(sessionHash.slice(0, 32) + '.')))) fail('invalid observation error barrier');
  return error;
}

function barrier(root, sessionHash) {
  if (!sessionHash) return null;
  for (const relative of [`${ROOT}/locks/${sessionHash}`, `${ROOT}/locks/${sessionHash}.recovery`]) {
    const lock = assertNoSymlinkAncestors(root, relative);
    if (!lock) fail('unsafe observation lock');
    if (fs.lstatSync(lock, { throwIfNoEntry: false })) return 'observation-in-progress';
  }
  return observationError(root, sessionHash)?.reason || null;
}

function withObservationLock(root, sessionHash, work) {
  const relative = `${ROOT}/locks/${sessionHash}`;
  const full = assertNoSymlinkAncestors(root, relative);
  if (!full) fail('unsafe observation lock');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const lock = acquireFileLock(full);
  const transaction = { phase: 'validating' };
  let retained = false;
  try { return work(transaction); }
  catch (error) {
    try {
      if (transaction.phase !== 'historical') write(root, `${ROOT}/errors/${sessionHash}.json`, {
        version: 1, sessionHash, reason: 'observation-failed', ...(transaction.id ? { id: transaction.id } : {}),
      });
    }
    catch { retained = true; }
    throw error;
  } finally {
    if (!retained) releaseFileLock(lock);
  }
}

export function observeHostIntent({ workspace, sessionId, prompt, eventId, eventTimestamp, host }) {
  const { root, sessionHash } = identity(workspace, sessionId);
  if (!sessionHash || !['claude-code', 'copilot'].includes(host)) fail('host event requires a supported host and session');
  return withObservationLock(root, sessionHash, transaction => {
    if (typeof prompt !== 'string' || Buffer.byteLength(prompt) > 1024 * 1024) fail('host prompt is invalid or oversized');
    if (eventId !== undefined && !(typeof eventId === 'string' && line(eventId) || Number.isSafeInteger(eventId) && eventId >= 0)) fail('invalid host event identity');
    if (eventTimestamp !== undefined && (!Number.isSafeInteger(eventTimestamp) || eventTimestamp < 0)) fail('invalid host event timestamp');
    const digest = hash(prompt);
    const id = `${sessionHash.slice(0, 32)}.${hash(JSON.stringify([host, String(eventId ?? randomUUID())]))}`;
    const eventPath = `${ROOT}/events/${id}.json`;
    const previous = read(root, eventPath);
    const previousError = observationError(root, sessionHash);
    if (previous) {
      if (previous.id !== id || previous.digest !== digest || previous.sessionHash !== sessionHash || previous.host !== host) fail('host event identity was reused for a different prompt');
      if (previousError?.id !== id) return previous;
    }
    const observation = previous || { version: 1, source: 'host-event', id, sessionHash, digest, host, observedAt: new Date().toISOString(), ...(eventTimestamp === undefined ? {} : { timestamp: eventTimestamp }) };
    const prior = current(root, sessionHash);
    if (prior?.timestamp !== undefined && observation.timestamp !== undefined && observation.timestamp < prior.timestamp) {
      transaction.phase = 'historical';
      if (!previous) write(root, eventPath, observation, { exclusive: true });
      return observation;
    }
    transaction.phase = 'publishing';
    transaction.id = id;
    write(root, `${ROOT}/errors/${sessionHash}.json`, { version: 1, sessionHash, reason: 'observation-in-progress', id });
    if (!previous) write(root, eventPath, observation, { exclusive: true });
    write(root, `${ROOT}/sessions/${sessionHash}.json`, observation);
    write(root, `${ROOT}/active-session.json`, { version: 1, sessionHash });
    const errorPath = assertNoSymlinkAncestors(root, `${ROOT}/errors/${sessionHash}.json`);
    if (!errorPath) fail('unsafe observation error barrier');
    fs.unlinkSync(errorPath);
    return observation;
  });
}

export function inspectHostIntent({ workspace, sessionId, planPath, revision } = {}) {
  const { root, sessionHash } = identity(workspace, sessionId);
  const blocked = barrier(root, sessionHash);
  if (blocked) return { source: 'host-event', state: 'pending', error: blocked };
  const observation = current(root, sessionHash);
  if (!observation) return { source: 'unobserved', state: 'unavailable' };
  const accepted = receipt(root, observation, planPath, revision);
  const latest = current(root, sessionHash);
  const interrupted = barrier(root, sessionHash);
  if (interrupted) return { source: 'host-event', state: 'pending', error: interrupted };
  const state = accepted && latest.id === observation.id ? 'accepted' : 'pending';
  return { source: 'host-event', state, id: latest.id, digest: latest.digest, host: latest.host,
    ...(state === 'accepted' ? { plan: accepted.plan, revision: accepted.revision, disposition: accepted.disposition } : {}) };
}

export function validateObservedIntent({ workspace, sessionId, input } = {}) {
  const value = input?.observedIntent;
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['id', 'disposition', 'rationale'].includes(key))
    || !ID.test(value.id || '') || !['amend', 'unchanged'].includes(value.disposition) || !line(value.rationale)) fail('invalid observedIntent decision');
  if (input.action === 'complete') fail('complete cannot reconcile new host intent');
  if (value.disposition === 'amend' && input.action !== 'amend') fail('amend disposition requires an amendment');
  if (value.disposition === 'amend' && !Object.keys(input.changes || {}).length && !input.intentSources?.length && !input.intentSelection && !input.migrateIntent) fail('amend disposition requires authored amendment changes');
  const { root, sessionHash } = identity(workspace, sessionId);
  if (barrier(root, sessionHash)) fail('host observation is incomplete; retry with a valid host event');
  const observation = current(root, sessionHash);
  if (!observation) fail('no host intent was observed for this session');
  if (observation.id !== value.id) fail('stale host intent; inspect the current observation');
  return observation;
}

export function publishObservedIntent({ workspace, sessionId, captured, input, planPath, beforeRevision, afterRevision, operationId } = {}) {
  const { root, sessionHash } = identity(workspace, sessionId);
  if (barrier(root, sessionHash)) return false;
  const observation = current(root, sessionHash);
  if (!observation) return false;
  if (!HASH.test(afterRevision || '') || !line(planPath) || !line(operationId)) fail('invalid acceptance binding');
  let disposition;
  if (input?.observedIntent !== undefined) {
    if (!captured || observation.id !== captured.id || input.observedIntent.id !== observation.id) return false;
    validateObservedIntent({ workspace: root, sessionId, input });
    disposition = input.observedIntent.disposition;
  } else {
    const accepted = receipt(root, observation, planPath, beforeRevision);
    if (!accepted) return false;
    disposition = accepted.disposition;
  }
  const plan = canonicalPlan(root, planPath);
  const relative = `${ROOT}/accepted/${observation.id}/${hash(plan)}-${afterRevision}.json`;
  const value = { version: 1, id: observation.id, sessionHash, plan, revision: afterRevision, disposition, operationId };
  const existing = receipt(root, observation, planPath, afterRevision);
  if (existing) {
    if (existing.id !== observation.id || existing.plan !== plan || existing.revision !== afterRevision || existing.sessionHash !== sessionHash) fail('conflicting acceptance binding');
  } else write(root, relative, value, { exclusive: true });
  return current(root, sessionHash)?.id === observation.id;
}
