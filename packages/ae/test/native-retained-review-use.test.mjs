import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { observeNativeSpecialist, verifyRetainedReviewUse } from '../lib/native-specialist-observation.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, includePlan = true) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-retained-review-use-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'state'), resourcePath = path.join(root, 'config/agents/enterprise-reviewer.md');
  fs.mkdirSync(workspace); fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  const source = 'Review the selected enterprise behavior.\n';
  fs.writeFileSync(resourcePath, source);
  const resource = { id: 'enterprise-reviewer', path: resourcePath, digest: `sha256-${hash(source)}`, included: true, current: true, invocable: true, tools: ['read'], agents: [] };
  const packetId = 'a'.repeat(64), sessionId = 'actual-native-session', plan = 'docs/plans/accepted.md', policyRevision = 'consent-at-review';
  const binding = { workspace, packet: packetId, policyRevision, scope: { source: 'reviewed-version' }, ...(includePlan ? { plan } : {}) };
  const provider = { name: resource.id, path: resource.path, digest: resource.digest, perspective: 'security-sentinel' };
  const output = { schema: 1, packet: packetId, results: [{ reviewer: 'security-sentinel', status: 'completed', findings: [], residual_risks: [], testing_gaps: [] }] };
  const observed = await observeNativeSpecialist({ workspace, home, configured: true, policy: { enabled: false, revision: policyRevision }, resolveAgent: () => resource, packetBinding: () => ({ current: true, binding, providers: [provider] }),
    payload: { cwd: workspace, session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'actual-native-consultation', tool_input: { subagent_type: resource.id, prompt: 'Review the accepted task.' }, tool_response: output, success: true } });
  assert.equal(observed.reviewObserved, true, observed.reason);
  const query = { workspace, home, observationId: observed.reviewObservationId, packetId, sessionId, name: resource.id, path: resource.path, sha256: hash(source), plan, policyRevision };
  return { root, workspace, home, resourcePath, query };
}

test('historical review use retains exact native consultation after source changes and disposable worktree deletion', async t => {
  const f = await fixture(t);
  assert.equal(verifyRetainedReviewUse(f.query).valid, true);
  fs.writeFileSync(f.resourcePath, 'A different current reviewer version.\n');
  fs.rmSync(f.workspace, { recursive: true });
  const retained = verifyRetainedReviewUse(f.query);
  assert.equal(retained.valid, true, retained.reason);
  assert.equal(retained.observationId, f.query.observationId);
  assert.equal(retained.loadedSourceHash, 'unverified');
  assert.match(retained.assurance, /adapter|authenticated/i);
});

test('retained consultation cannot move across packet, session, resource, policy, plan or workspace identities', async t => {
  const f = await fixture(t);
  for (const patch of [{ observationId: 'f'.repeat(64) }, { packetId: 'b'.repeat(64) }, { sessionId: 'authored-session' }, { name: 'another-reviewer' }, { path: path.join(f.root, 'other.md') }, { sha256: 'c'.repeat(64) }, { plan: 'docs/plans/other.md' }, { policyRevision: 'different-consent' }, { workspace: path.join(f.root, 'different-worktree') }]) {
    assert.equal(verifyRetainedReviewUse({ ...f.query, ...patch }).valid, false, JSON.stringify(patch));
  }
});

test('legacy review observations without authoritative task plan binding cannot support historical attribution', async t => {
  const f = await fixture(t, false);
  assert.equal(verifyRetainedReviewUse(f.query).valid, false);
});

test('historical consultation refuses tampered immutable evidence and unsafe recorded workspace identities', async t => {
  const f = await fixture(t);
  const archive = path.join(f.home, 'native-specialist-observations/archive', hash(f.workspace), 'review', `${f.query.observationId}.json`);
  const record = JSON.parse(fs.readFileSync(archive, 'utf8'));
  record.packetBinding.plan = 'docs/plans/forged.md';
  fs.writeFileSync(archive, JSON.stringify(record));
  assert.equal(verifyRetainedReviewUse({ ...f.query, plan: record.packetBinding.plan }).valid, false);
  for (const workspace of ['relative/worktree', path.join(f.root, 'parent') + '/../product', '/']) assert.equal(verifyRetainedReviewUse({ ...f.query, workspace }).valid, false);
});
