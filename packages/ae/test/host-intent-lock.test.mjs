import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { tempDir } from './helpers/temp.mjs';
import { inspectHostIntent, observeHostIntent, publishObservedIntent, validateObservedIntent } from '../lib/host-intent.mjs';

function fixture(t) {
  const workspace = tempDir('host-intent-lock-');
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const options = { workspace, sessionId: 'observer-session', planPath: 'docs/plans/example.md', host: 'copilot' };
  const first = observeHostIntent({ ...options, prompt: 'Original request', eventId: 'original' });
  const input = { action: 'progress', observedIntent: { id: first.id, disposition: 'unchanged', rationale: 'Current scope covers this request.' } };
  const captured = validateObservedIntent({ ...options, input });
  publishObservedIntent({ ...options, captured, input, beforeRevision: 'a'.repeat(64), afterRevision: 'b'.repeat(64), operationId: 'accept-original' });
  const lock = path.join(workspace, '.harness', 'intent-observations', 'locks', first.sessionHash);
  return { ...options, lock };
}

function age(lock) {
  const expired = new Date(Date.now() - 31_000);
  fs.utimesSync(lock, expired, expired);
}

function stamp(lock, pid) {
  const owner = `owner-v1-${pid}-${randomUUID()}`;
  fs.mkdirSync(path.join(lock, owner), { recursive: true });
  age(lock);
  return owner;
}

test('a later valid host prompt recovers a terminated stamped observer', t => {
  const options = fixture(t);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
fs.mkdirSync(${JSON.stringify(options.lock)} + '/owner-v1-' + process.pid + '-' + randomUUID(), { recursive: true });
process.exit(71);
`], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 71);
  age(options.lock);
  assert.equal(inspectHostIntent({ ...options, revision: 'b'.repeat(64) }).state, 'pending');
  const next = observeHostIntent({ ...options, prompt: 'New request after interruption', eventId: 'recovered' });
  const state = inspectHostIntent({ ...options, revision: 'b'.repeat(64) });
  assert.equal(state.id, next.id);
  assert.equal(state.state, 'pending');
  assert.equal(state.error, undefined);
  assert.equal(fs.existsSync(options.lock), false);
  assert.equal(fs.existsSync(`${options.lock}.recovery`), false);
});

test('a live observer keeps its lock and cannot expose old acceptance', t => {
  const options = fixture(t);
  const owner = stamp(options.lock, process.pid);
  assert.throws(() => observeHostIntent({ ...options, prompt: 'Concurrent request', eventId: 'concurrent' }), /locked|busy/);
  assert.deepEqual(fs.readdirSync(options.lock), [owner]);
  assert.equal(inspectHostIntent({ ...options, revision: 'b'.repeat(64) }).state, 'pending');
});

test('unavailable observer liveness never authorizes stale lock removal', t => {
  const options = fixture(t);
  const owner = stamp(options.lock, process.pid);
  const kill = process.kill;
  process.kill = () => { throw Object.assign(new Error('Cannot inspect owner'), { code: 'EPERM' }); };
  try {
    assert.throws(() => observeHostIntent({ ...options, prompt: 'Another request', eventId: 'blocked' }), /liveness.*unavailable|owner.*unavailable/);
  } finally { process.kill = kill; }
  assert.deepEqual(fs.readdirSync(options.lock), [owner]);
  assert.equal(inspectHostIntent({ ...options, revision: 'b'.repeat(64) }).state, 'pending');
});

test('an in-progress lock recovery cannot expose prior accepted intent', t => {
  const options = fixture(t);
  fs.mkdirSync(`${options.lock}.recovery`);
  const state = inspectHostIntent({ ...options, revision: 'b'.repeat(64) });
  assert.equal(state.state, 'pending');
  assert.equal(state.error, 'observation-in-progress');
});
