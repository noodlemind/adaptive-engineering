import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { runCompound, runInsightCompound } from '../lib/compound.mjs';
import { configureDiscovery, discoveryPolicy } from '../lib/capability-catalog.mjs';
import { decisionPolicyFromDiscovery, prepareDecision, observeDecisionInvocation, recordDecision } from '../lib/decision-agent.mjs';
import { writeSession } from '../lib/session.mjs';

function fixture(t, grants = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-memory-publication-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { workspace: path.join(root, 'product'), home: path.join(root, 'ae'), copilotHome: path.join(root, 'copilot') };
  fs.mkdirSync(options.workspace); fs.mkdirSync(options.copilotHome);
  configureDiscovery({ ...options, input: { schema: 1, roots: [{ path: options.copilotHome, kind: 'config', included: true }], ongoing: false,
    grants: { memory: true, decision: true, tools: ['read', 'search'], ...grants } } });
  writeSession(options.workspace, { sessionId: 'native-memory-session' });
  const flags = { title: 'Retry policy follows the transaction owner', body: 'Keep retry ownership with the transaction boundary.', captureDate: '2026-11-06' };
  return { ...options, flags };
}

function approve(f, memory, memoryContent) {
  const policy = decisionPolicyFromDiscovery(discoveryPolicy(f));
  const prepared = prepareDecision({ ...f, policy, input: { schema: 1, taskId: 'memory-task', sessionId: 'native-memory-session', type: 'memory', intent: 'Publish this private task learning.', memory, context: { memoryContent }, sources: [] } });
  const verdict = { schema: 1, requestId: prepared.requestId, verdict: 'allow', reason: 'The exact private learning is useful and within standing memory authority.', evidence: ['Exact publication bytes and destination were inspected.'] };
  // Synthetic unit hook observation exercises the native-observation boundary;
  // this test is not a claim that a real host model was invoked.
  const observation = observeDecisionInvocation({ ...f, policy, payload: { cwd: f.workspace, session_id: 'native-memory-session', tool_name: 'Agent', tool_use_id: prepared.requestId,
    tool_input: { subagent_type: 'decision-agent' }, tool_response: { content: [{ type: 'text', text: JSON.stringify(verdict) }] }, success: true } });
  assert.equal(observation.observed, true);
  assert.equal(recordDecision({ ...f, policy, input: { schema: 1, requestId: prepared.requestId } }).authorized, true);
}

test('configured inferred publication requires an exact observed native memory verdict', t => {
  const f = fixture(t);
  const blocked = runInsightCompound(f);
  assert.equal(blocked.pass, false);
  assert.match(blocked.blockedReason, /memory.*decision|decision.*memory/i);
  assert.equal(blocked.memoryDecision.operation, 'publish');
  assert.equal(blocked.memoryDecision.scope, 'private');
  assert.equal(fs.existsSync(blocked.memoryDecision.destination), false);
  approve(f, blocked.memoryDecision, blocked.memoryContent);
  const published = runInsightCompound(f);
  assert.equal(published.pass, true);
  assert.equal(published.publishedPath, blocked.memoryDecision.destination);
  assert.equal(`sha256-${createHash('sha256').update(fs.readFileSync(published.publishedPath)).digest('hex')}`, blocked.memoryDecision.contentDigest);
  assert.ok(published.memoryDecisionReceipt);
  assert.equal(runInsightCompound(f).pass, false, 'one receipt cannot authorize a second episode');
});

test('dry-run exposes exact bytes/destination without consuming memory authority', t => {
  const f = fixture(t);
  const preview = runInsightCompound({ ...f, flags: { ...f.flags, dryRun: true } });
  assert.equal(preview.pass, true);
  assert.equal(preview.memoryDecision.destination, preview.publishedPath);
  assert.match(preview.memoryDecision.contentDigest, /^sha256-[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(preview.publishedPath), false);
  approve(f, preview.memoryDecision, preview.memoryContent);
  assert.equal(runInsightCompound({ ...f, flags: { ...f.flags, dryRun: true } }).pass, true);
  assert.equal(runInsightCompound(f).pass, true);
});

test('memory consent, destination scope and current content constrain publication independently', t => {
  const denied = fixture(t, { memory: false });
  assert.equal(runInsightCompound(denied).pass, false);
  assert.match(runInsightCompound(denied).blockedReason, /standing.*memory|memory.*standing/i);
  const f = fixture(t);
  const preview = runInsightCompound({ ...f, flags: { ...f.flags, dryRun: true } });
  approve(f, preview.memoryDecision, preview.memoryContent);
  assert.equal(runInsightCompound({ ...f, flags: { ...f.flags, body: 'Different inferred guidance.' } }).pass, false);
  assert.equal(runInsightCompound({ ...f, flags: { ...f.flags, publicationScope: 'global' } }).pass, false);
  assert.equal(runInsightCompound({ ...f, flags: { ...f.flags, publicationScope: 'ship-set-proposal' } }).pass, false);
  assert.equal(runInsightCompound(f).pass, true, 'failed mismatches must not consume the exact private receipt');
});

test('revocation invalidates a previously allowed memory receipt while explicit user teaching stays available', t => {
  const f = fixture(t);
  const preview = runInsightCompound({ ...f, flags: { ...f.flags, dryRun: true } });
  approve(f, preview.memoryDecision, preview.memoryContent);
  const state = discoveryPolicy(f);
  configureDiscovery({ ...f, input: { ...state.policy, expectedRevision: state.policyRevision, grants: { ...state.policy.grants, memory: false } } });
  assert.equal(runInsightCompound(f).pass, false);
  assert.equal(fs.existsSync(preview.publishedPath), false);
  const explicit = runInsightCompound({ ...f, kind: 'human-teaching' });
  assert.equal(explicit.pass, true);
});

test('a collision after judgment cannot reuse its consumed verdict for a different file', t => {
  const f = fixture(t);
  const preview = runInsightCompound({ ...f, flags: { ...f.flags, dryRun: true } });
  approve(f, preview.memoryDecision, preview.memoryContent);
  const original = fs.linkSync;
  let raced = false;
  fs.linkSync = (source, destination) => {
    if (destination === preview.publishedPath) {
      raced = true;
      fs.writeFileSync(destination, 'A concurrent independent episode.\n', { flag: 'wx' });
    }
    return original(source, destination);
  };
  let result;
  try { result = runInsightCompound(f); } finally { fs.linkSync = original; }
  assert.equal(raced, true);
  assert.equal(result.pass, false);
  assert.match(result.blockedReason, /exclusive destination/i);
  assert.equal(fs.readFileSync(preview.publishedPath, 'utf8'), 'A concurrent independent episode.\n');
  const retry = runInsightCompound(f);
  assert.equal(retry.pass, false);
  assert.notEqual(retry.memoryDecision.destination, preview.publishedPath);
  assert.equal(fs.existsSync(retry.memoryDecision.destination), false);
  approve(f, retry.memoryDecision, retry.memoryContent);
  assert.equal(runInsightCompound(f).pass, true);
});

test('an identical operation replay preserves one episode without spending a second memory verdict', t => {
  const f = fixture(t);
  f.flags.operationSuffix = 'accepted-memory-operation';
  const preview = runInsightCompound({ ...f, flags: { ...f.flags, dryRun: true } });
  approve(f, preview.memoryDecision, preview.memoryContent);
  const first = runInsightCompound(f), replay = runInsightCompound(f);
  assert.equal(first.pass, true);
  assert.equal(replay.pass, true);
  assert.equal(first.publishedPath, replay.publishedPath);
  assert.equal(fs.readdirSync(path.dirname(first.publishedPath)).filter(name => name.endsWith('.md')).length, 1);
});

test('the compound command uses the explicitly selected AE home for insight consent', async t => {
  const f = fixture(t, { memory: false });
  const result = await runCompound({ workspace: f.workspace, copilotHome: f.copilotHome, flags: { ...f.flags, insight: true, harnessHome: f.home } });
  assert.equal(result.pass, false);
  assert.match(result.blockedReason, /standing memory authority/i);
});
