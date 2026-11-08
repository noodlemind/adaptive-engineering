import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { inspectHostIntent, observeHostIntent, publishObservedIntent, validateObservedIntent } from '../lib/host-intent.mjs';
import { nativeHookConfig } from '../lib/hosts/native-hook.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const revision = value => value.repeat(64);

function fixture(t) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-host-intent-')));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return { workspace, sessionId: 'host-session-1', planPath: 'docs/plans/2026-11-04-fix-example-plan.md' };
}

function decision(id, disposition = 'unchanged', action = 'progress') {
  return { version: 1, id: 'operation-1', action, observedIntent: { id, disposition, rationale: 'The accepted scope still covers this request.' } };
}

test('only a host observation creates pending intent and prompt bytes are not persisted', t => {
  const options = fixture(t);
  assert.equal(inspectHostIntent(options).source, 'unobserved');
  const observed = observeHostIntent({ ...options, prompt: 'Do not persist this private prompt.', eventId: 'prompt-1', host: 'claude-code' });
  assert.equal(inspectHostIntent(options).state, 'pending');
  assert.equal(observed.id, observeHostIntent({ ...options, prompt: 'Do not persist this private prompt.', eventId: 'prompt-1', host: 'claude-code' }).id);
  assert.throws(() => observeHostIntent({ ...options, prompt: 'different prompt', eventId: 'prompt-1', host: 'claude-code' }), /different prompt/);
  const files = fs.readdirSync(path.join(options.workspace, '.harness', 'intent-observations'), { recursive: true });
  for (const file of files) {
    const full = path.join(options.workspace, '.harness', 'intent-observations', file);
    if (fs.statSync(full).isFile()) assert.doesNotMatch(fs.readFileSync(full, 'utf8'), /Do not persist this private prompt/);
  }
});

test('successful revision-bound decisions reconcile a turn and progress carries acceptance forward', t => {
  const options = fixture(t);
  const observed = observeHostIntent({ ...options, prompt: 'Continue the current task.', eventId: 'prompt-1', host: 'copilot' });
  const input = decision(observed.id);
  const captured = validateObservedIntent({ ...options, input });
  assert.equal(inspectHostIntent({ ...options, revision: revision('a') }).state, 'pending');
  publishObservedIntent({ ...options, captured, input, beforeRevision: revision('a'), afterRevision: revision('b'), operationId: input.id });
  assert.equal(inspectHostIntent({ ...options, revision: revision('a') }).state, 'pending');
  assert.equal(inspectHostIntent({ ...options, revision: revision('b') }).state, 'accepted');
  publishObservedIntent({ ...options, input: { action: 'progress' }, beforeRevision: revision('b'), afterRevision: revision('c'), operationId: 'operation-2' });
  assert.equal(inspectHostIntent({ ...options, revision: revision('c') }).state, 'accepted');
  assert.equal(inspectHostIntent({ ...options, planPath: 'docs/plans/other.md', revision: revision('c') }).state, 'pending');
});

test('a new turn, another session and stale replay never inherit acceptance', t => {
  const options = fixture(t);
  const first = observeHostIntent({ ...options, prompt: 'First request', eventId: 'prompt-1', host: 'copilot' });
  const input = decision(first.id);
  const captured = validateObservedIntent({ ...options, input });
  const second = observeHostIntent({ ...options, prompt: 'Add new scope', eventId: 'prompt-2', host: 'copilot' });
  assert.notEqual(first.id, second.id);
  observeHostIntent({ ...options, prompt: 'First request', eventId: 'prompt-1', host: 'copilot' });
  assert.equal(inspectHostIntent(options).id, second.id);
  assert.throws(() => validateObservedIntent({ ...options, input }), /stale/);
  assert.equal(publishObservedIntent({ ...options, captured, input, beforeRevision: revision('a'), afterRevision: revision('b'), operationId: input.id }), false);
  assert.equal(inspectHostIntent({ ...options, revision: revision('b') }).state, 'pending');
  assert.equal(inspectHostIntent({ ...options, sessionId: 'other-session' }).source, 'unobserved');
  assert.throws(() => validateObservedIntent({ ...options, sessionId: 'other-session', input: decision(second.id) }), /observed/);
});

test('identical prompts without host event ids remain distinct observations', t => {
  const options = fixture(t);
  const first = observeHostIntent({ ...options, prompt: 'Continue', host: 'claude-code' });
  const second = observeHostIntent({ ...options, prompt: 'Continue', host: 'claude-code' });
  assert.notEqual(first.id, second.id);
  assert.equal(inspectHostIntent(options).id, second.id);
});

test('amendment disposition cannot acknowledge a progress or completion operation', t => {
  const options = fixture(t);
  const observed = observeHostIntent({ ...options, prompt: 'Change the goal', eventId: 'prompt-1', host: 'claude-code' });
  assert.throws(() => validateObservedIntent({ ...options, input: decision(observed.id, 'amend') }), /amend/);
  assert.throws(() => validateObservedIntent({ ...options, input: decision(observed.id, 'unchanged', 'complete') }), /complete/);
  assert.throws(() => validateObservedIntent({ ...options, input: decision(observed.id, 'amend', 'amend') }), /changes/);
  assert.equal(validateObservedIntent({ ...options, input: { action: 'progress' } }), null);
  assert.equal(inspectHostIntent(options).state, 'pending');
});

test('failed new observation blocks old acceptance until a valid new event arrives', t => {
  const options = fixture(t);
  const observed = observeHostIntent({ ...options, prompt: 'Original request', eventId: 'prompt-1', host: 'copilot' });
  const input = decision(observed.id);
  const captured = validateObservedIntent({ ...options, input });
  publishObservedIntent({ ...options, captured, input, beforeRevision: revision('a'), afterRevision: revision('b'), operationId: input.id });
  assert.equal(inspectHostIntent({ ...options, revision: revision('b') }).state, 'accepted');
  assert.throws(() => observeHostIntent({ ...options, prompt: {}, eventId: 'prompt-2', host: 'copilot' }), /invalid/);
  assert.equal(inspectHostIntent({ ...options, revision: revision('b') }).state, 'pending');
  assert.throws(() => validateObservedIntent({ ...options, input }), /incomplete/);
  assert.equal(publishObservedIntent({ ...options, captured, input, beforeRevision: revision('a'), afterRevision: revision('b'), operationId: input.id }), false);
  observeHostIntent({ ...options, prompt: 'Original request', eventId: 'prompt-1', host: 'copilot' });
  assert.equal(inspectHostIntent({ ...options, revision: revision('b') }).state, 'pending');
  const next = observeHostIntent({ ...options, prompt: 'Valid new request', eventId: 'prompt-2', host: 'copilot' });
  assert.equal(inspectHostIntent(options).id, next.id);
});

test('host timestamps preserve newer intent when an older first-time event arrives late', t => {
  const options = fixture(t);
  const newer = observeHostIntent({ ...options, prompt: 'New request', eventId: 20, eventTimestamp: 20, host: 'copilot' });
  observeHostIntent({ ...options, prompt: 'Old request', eventId: 10, eventTimestamp: 10, host: 'copilot' });
  assert.equal(inspectHostIntent(options).id, newer.id);
  assert.equal(inspectHostIntent(options).error, undefined);
  assert.throws(() => observeHostIntent({ ...options, prompt: 'Invalid identity', eventId: {}, host: 'copilot' }), /identity/);
  assert.equal(inspectHostIntent(options).error, 'observation-failed');
});

for (const stage of ['current pointer', 'active session', 'error cleanup']) {
  test(`retrying the same host event finishes interrupted ${stage} publication`, t => {
    const options = fixture(t);
    observeHostIntent({ ...options, prompt: 'Original request', eventId: 'prompt-1', host: 'copilot' });
    const next = { ...options, prompt: 'Additional request', eventId: 'prompt-2', host: 'copilot' };
    const method = stage === 'error cleanup' ? 'unlinkSync' : 'renameSync';
    const original = fs[method];
    let injected = false;
    const mock = t.mock.method(fs, method, function (...args) {
      const target = String(args[method === 'renameSync' ? 1 : 0]);
      const selected = stage === 'current pointer' ? target.includes(`${path.sep}sessions${path.sep}`)
        : stage === 'active session' ? target.endsWith(`${path.sep}active-session.json`)
          : target.includes(`${path.sep}errors${path.sep}`) && target.endsWith('.json');
      if (!injected && selected) {
        injected = true;
        throw Object.assign(new Error('injected publication failure'), { code: 'EIO' });
      }
      return original.apply(this, args);
    });
    try { assert.throws(() => observeHostIntent(next), /publication|injected/); }
    finally { mock.mock.restore(); }
    assert.equal(injected, true);
    assert.equal(inspectHostIntent(options).error, 'observation-failed');
    const recovered = observeHostIntent(next);
    assert.equal(inspectHostIntent(options).id, recovered.id);
    assert.equal(inspectHostIntent(options).error, undefined);
    assert.equal(inspectHostIntent(options).state, 'pending');
  });
}

test('old event replay cannot clear a newer interrupted observation or regress its recovery', t => {
  const options = fixture(t);
  const first = { ...options, prompt: 'Original request', eventId: 'prompt-1', host: 'copilot' };
  observeHostIntent(first);
  const next = { ...options, prompt: 'Additional request', eventId: 'prompt-2', host: 'copilot' };
  const rename = fs.renameSync;
  let injected = false;
  const mock = t.mock.method(fs, 'renameSync', function (...args) {
    if (!injected && String(args[1]).includes(`${path.sep}sessions${path.sep}`)) {
      injected = true;
      throw Object.assign(new Error('injected publication failure'), { code: 'EIO' });
    }
    return rename.apply(this, args);
  });
  try { assert.throws(() => observeHostIntent(next), /publication/); }
  finally { mock.mock.restore(); }
  observeHostIntent(first);
  assert.equal(inspectHostIntent(options).error, 'observation-failed');
  const recovered = observeHostIntent(next);
  assert.equal(inspectHostIntent(options).id, recovered.id);
  const latest = observeHostIntent({ ...options, prompt: 'Latest request', eventId: 'prompt-3', host: 'copilot' });
  observeHostIntent(next);
  assert.equal(inspectHostIntent(options).id, latest.id);
  assert.equal(inspectHostIntent(options).error, undefined);
});

test('corrupt acceptance receipts never authorize a mutation', t => {
  const options = fixture(t);
  const observed = observeHostIntent({ ...options, prompt: 'Original request', eventId: 'prompt-1', host: 'copilot' });
  const input = decision(observed.id);
  const captured = validateObservedIntent({ ...options, input });
  publishObservedIntent({ ...options, captured, input, beforeRevision: revision('a'), afterRevision: revision('b'), operationId: input.id });
  const directory = path.join(options.workspace, '.harness', 'intent-observations', 'accepted', observed.id);
  const full = path.join(directory, fs.readdirSync(directory)[0]);
  const record = JSON.parse(fs.readFileSync(full, 'utf8'));
  delete record.disposition;
  fs.writeFileSync(full, JSON.stringify(record));
  assert.throws(() => inspectHostIntent({ ...options, revision: revision('b') }), /acceptance/);
});

for (const record of ['sessions', 'errors']) {
  test(`nonobject ${record} records cannot disappear as absent observation state`, t => {
    const options = fixture(t);
    const observed = observeHostIntent({ ...options, prompt: 'Original request', eventId: 'prompt-1', host: 'copilot' });
    const input = decision(observed.id);
    const captured = validateObservedIntent({ ...options, input });
    publishObservedIntent({ ...options, captured, input, beforeRevision: revision('a'), afterRevision: revision('b'), operationId: input.id });
    const full = path.join(options.workspace, '.harness', 'intent-observations', record, `${observed.sessionHash}.json`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const original = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    for (const content of ['null', 'false', '[]', '42', '"value"']) {
      fs.writeFileSync(full, content);
      assert.throws(() => inspectHostIntent({ ...options, revision: revision('b') }), /invalid observation record/, content);
      if (original === null) fs.unlinkSync(full);
      else fs.writeFileSync(full, original);
    }
  });
}

test('observation and acceptance refuse symlinked state and corrupted records', t => {
  const options = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-host-intent-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(options.workspace, '.harness'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => observeHostIntent({ ...options, prompt: 'request', host: 'copilot' }), /unsafe/);
  assert.equal(fs.readdirSync(outside).length, 0);
  fs.unlinkSync(path.join(options.workspace, '.harness'));
  const observed = observeHostIntent({ ...options, prompt: 'request', host: 'copilot' });
  const observationFile = path.join(options.workspace, '.harness', 'intent-observations', 'sessions', `${observed.sessionHash}.json`);
  fs.writeFileSync(observationFile, '{}');
  assert.throws(() => inspectHostIntent(options), /invalid/);
});

test('Copilot-compatible prompt hook records intent without relying on hook output', t => {
  const options = fixture(t);
  const run = spawnSync(process.execPath, [path.join(root, 'corpus/hooks/observe-user-intent.mjs')], {
    cwd: options.workspace, input: JSON.stringify({ cwd: options.workspace, sessionId: options.sessionId, timestamp: 1234, prompt: 'Add a second acceptance criterion.' }),
    env: { ...process.env, AE_BIN: path.join(root, 'bin/ae.mjs') }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(inspectHostIntent(options).state, 'pending');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'corpus/hooks/hooks.json'), 'utf8'));
  assert.ok(config.hooks.UserPromptSubmit);
});

test('Claude native configuration registers prompt ingress without claiming other hosts', t => {
  const { workspace } = fixture(t);
  const options = { configHome: workspace, skillsHome: workspace, home: workspace, packageRoot: root };
  assert.ok(nativeHookConfig({ ...options, host: 'claude-code' }).value.hooks.UserPromptSubmit);
  assert.equal(nativeHookConfig({ ...options, host: 'codex' }).value.hooks.UserPromptSubmit, undefined);
  assert.equal(nativeHookConfig({ ...options, host: 'cursor' }).value.hooks.beforeSubmitPrompt, undefined);
});
