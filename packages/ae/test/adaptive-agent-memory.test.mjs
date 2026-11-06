import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { configureDiscovery, discoveryPolicy } from '../lib/capability-catalog.mjs';
import { decisionPolicyFromDiscovery } from '../lib/decision-agent.mjs';
import { observeNativeSpecialist } from '../lib/native-specialist-observation.mjs';
import { loadedResourceUses } from '../lib/adaptive-context.mjs';
import { writeSession } from '../lib/session.mjs';
import { prepareReview, assembleReview, recordHash, publishReviewRecord } from '../lib/review.mjs';
import { reviewHash } from '../lib/review-preparation.mjs';
import { initGit, writeVersionedPlan } from './helpers/cli-fixtures.mjs';
import { loadPlan } from '../lib/plan-parse.mjs';
import { solutionsWriteTarget } from '../lib/project-layout.mjs';
import { verifiedEpisodeRecurrence } from '../lib/resource-recurrence.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-agent-memory-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { workspace: path.join(root, 'product'), home: path.join(root, 'ae'), copilotHome: path.join(root, 'copilot') };
  fs.mkdirSync(options.workspace); fs.mkdirSync(path.join(options.copilotHome, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(options.workspace, '.gitignore'), '.harness/\n');
  const planPath = writeVersionedPlan(options.workspace);
  fs.writeFileSync(path.join(options.workspace, planPath), fs.readFileSync(path.join(options.workspace, planPath), 'utf8').replace('required: []', 'required: [code-review]'));
  initGit(options.workspace);
  fs.writeFileSync(path.join(options.workspace, 'src/example.js'), 'export const value = 2;\n');
  const providerPath = path.join(options.copilotHome, 'agents/acme-reviewer.agent.md');
  fs.writeFileSync(providerPath, '---\nname: acme-reviewer\ndescription: Independent simplicity review\ntools: [read]\nagents: []\ncapabilities: [code-simplicity-reviewer]\n---\nReview the selected scope.\n');
  configureDiscovery({ ...options, input: { schema: 1, roots: [{ path: options.copilotHome, kind: 'config', included: true }], ongoing: false, grants: { tools: ['read'] } } });
  const plan = loadPlan(options.workspace, planPath, { home: options.home });
  return { ...options, options, plan, planPath, providerPath };
}
async function review(f, { observe = true, plan = f.plan, sessionId = 'actual-review-session' } = {}) {
  writeSession(f.workspace, { sessionId, activePlan: plan.path });
  const packet = prepareReview({ ...f.options, plan, base: 'HEAD' });
  const results = packet.required.map(reviewer => ({ reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [], provenance: { kind: 'host-invocation', agent: 'acme-reviewer', via: 'engineer' } }));
  if (observe) {
    // Native hook adapter fixture, not a claim of an authenticated host run.
    const observed = await observeNativeSpecialist({ ...f.options, configured: true, policy: decisionPolicyFromDiscovery(discoveryPolicy(f.options)), payload: {
      cwd: f.workspace, session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: `native-review-${packet.id}`,
      tool_input: { subagent_type: 'acme-reviewer', prompt: `Review packet ${packet.id}` }, tool_response: { content: JSON.stringify({ schema: 1, packet: packet.id, results }) }, success: true,
    } });
    assert.equal(observed.reviewObserved, true, observed.reason);
  }
  const record = assembleReview({ ...f.options, plan, packetId: packet.id, input: { packet: packet.id, results } });
  return { packet, record, results };
}
function seedVerifiedLesson(f, name, plan, use) {
  const put = (base, rel, value) => { const file = path.join(base, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const checks = [{ id: 'behavior', status: 'passed', proof: 'behavior' }, { id: 'criteria-evidence', status: 'passed' }];
  const evidence = { version: 5, plan: plan.path, binding: { planDigest: sha(name) }, outcome: 'passed', checks, evidencePath: `.harness/evidence/${name}.json` };
  put(f.workspace, `.harness/evidence/history/${sha(JSON.stringify(evidence))}.json`, evidence);
  const proofIdentity = recordHash({ version: evidence.version, plan: evidence.plan, binding: evidence.binding, outcome: 'passed', checks: checks.map(row => ({ id: row.id, status: row.status, proof: row.proof || null })), review: null });
  const proof = { version: 1, plan: plan.path, binding: evidence.binding, verificationIdentity: proofIdentity, evidencePath: evidence.evidencePath, review: null };
  const target = solutionsWriteTarget(f.workspace, { home: f.home }), relative = `${target.dirRel}/review/${name}.md`;
  const doc = `---\nkind: fix\nproof_identity: ${proofIdentity}\nwork_contract: ${evidence.binding.planDigest}\nresource_uses: ${JSON.stringify([use])}\n---\nReviewer consultation informed the task.\n`;
  const publishedPath = put(target.base, relative, doc), decision = { operation: `lesson-${name}`, decision: 'publish', rationale: 'Keep the verified task procedure.', scope: 'private' };
  const destination = { base: target.base, dirRel: target.dirRel }, operation = recordHash(decision.operation);
  put(f.workspace, `.harness/learning/${operation}.json`, { version: 1, operation, digest: recordHash({ decision, proof: proofIdentity, destination }), decision, destination, proof, state: 'done', result: { pass: true, indexed: true, publicationVersion: 1, path: relative, publishedPath, publishedHash: recordHash(doc) } });
}

test('only actual source-bound native review output creates current-session agent attribution', async t => {
  const f = fixture(t);
  await review(f, { observe: false });
  assert.deepEqual(loadedResourceUses(f.options), []);
  await review(f);
  const uses = loadedResourceUses(f.options);
  assert.equal(uses.length, 1);
  assert.equal(uses[0].kind, 'agent'); assert.equal(uses[0].name, 'acme-reviewer');
  assert.equal(uses[0].path, f.providerPath); assert.equal(uses[0].sha256, sha(fs.readFileSync(f.providerPath)));
  assert.match(uses[0].reviewUse.observationId, /^[a-f0-9]{64}$/);
  assert.equal(uses[0].reviewUse.plan, f.plan.path);
  assert.equal(uses[0].loadedSourceHash, 'unverified');
  assert.match(uses[0].assurance, /does not prove causal effectiveness/);
  assert.deepEqual(loadedResourceUses({ ...f.options, plan: 'docs/plans/a-different-task.md' }), []);
  writeSession(f.workspace, { sessionId: 'another-session', activePlan: f.plan.path });
  assert.deepEqual(loadedResourceUses(f.options), []);
});

test('stale native sources and revoked discovery consent remove agent attribution', async t => {
  const f = fixture(t); await review(f);
  const original = fs.readFileSync(f.providerPath); fs.appendFileSync(f.providerPath, 'Changed source definition.\n');
  assert.deepEqual(loadedResourceUses(f.options), []);
  fs.writeFileSync(f.providerPath, original);
  assert.equal(loadedResourceUses(f.options).length, 1);
  const consent = discoveryPolicy(f.options);
  configureDiscovery({ ...f.options, input: { ...consent.policy, expectedRevision: consent.policyRevision, exclusions: ['acme-reviewer'] } });
  assert.deepEqual(loadedResourceUses(f.options), []);
});

test('a hash-valid authored review record cannot substitute different native findings', async t => {
  const f = fixture(t), { record } = await review(f);
  const { id, recordedAt, ...value } = record;
  delete value.observationPath;
  value.results[0].raw.testing_gaps = ['Authored replacement after the native result.'];
  const forgedId = reviewHash(value);
  publishReviewRecord(f.workspace, `.harness/reviews/records/${forgedId}.json`, { ...value, id: forgedId, recordedAt });
  publishReviewRecord(f.workspace, `.harness/reviews/latest/${recordHash(f.plan.path)}.json`, { version: 2, id: forgedId });
  assert.deepEqual(loadedResourceUses(f.options), []);
});

test('verified recurrence admits only archive-bound agent consultations for their actual distinct plans', async t => {
  const f = fixture(t); await review(f);
  const use = loadedResourceUses(f.options)[0];
  assert.ok(use?.reviewUse);
  seedVerifiedLesson(f, 'first', f.plan, use);
  const secondPath = writeVersionedPlan(f.workspace, { name: 'second-task.md' });
  fs.writeFileSync(path.join(f.workspace, secondPath), fs.readFileSync(path.join(f.workspace, secondPath), 'utf8').replace('required: []', 'required: [code-review]'));
  const secondPlan = loadPlan(f.workspace, secondPath, { home: f.home });
  seedVerifiedLesson(f, 'forged-copy', secondPlan, { ...use, reviewUse: { ...use.reviewUse, plan: secondPlan.path } });
  assert.equal(verifiedEpisodeRecurrence(f.options).resourceUseRecurrence.length, 0);
  await review(f, { plan: secondPlan, sessionId: 'second-real-session' });
  const secondUse = loadedResourceUses(f.options)[0];
  seedVerifiedLesson(f, 'second', secondPlan, secondUse);
  const recurrence = verifiedEpisodeRecurrence(f.options).resourceUseRecurrence;
  assert.equal(recurrence.length, 1); assert.equal(recurrence[0].count, 2);
  assert.equal(recurrence[0].detail.resource.kind, 'agent');
  assert.equal(recurrence[0].causalEffectiveness, 'unassessed');
});
