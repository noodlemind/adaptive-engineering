import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { configureDiscovery, discoveryPolicy } from '../lib/capability-catalog.mjs';
import { decisionPolicyFromDiscovery } from '../lib/decision-agent.mjs';
import { observeNativeSpecialist } from '../lib/native-specialist-observation.mjs';
import { writeSession } from '../lib/session.mjs';
import { prepareReview, assembleReview, authorReviewTour, validateReview, reviewReadinessEvidence } from '../lib/review.mjs';
import { preparationIsCurrent } from '../lib/review-preparation.mjs';
import { initGit, writeVersionedPlan } from './helpers/cli-fixtures.mjs';
import { loadPlan } from '../lib/plan-parse.mjs';

const FLOW_CLASSES = ['positive', 'malformed-input', 'boundary', 'dependency-failure', 'concurrency', 'old-state', 'abuse', 'cross-boundary'];
const ledger = () => FLOW_CLASSES.map(flow_class => ({ flow_class, entry: 'value export', input: `${flow_class} input`, path: ['src/example.js:1'], expected: 'Export the value', observed: 'Exports the value', verdict: 'gap', test: null }));

function fixture(t, { provider = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-portable-review-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'product'), home = path.join(base, 'home'), copilotHome = path.join(base, 'copilot');
  fs.mkdirSync(workspace); fs.mkdirSync(path.join(copilotHome, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.gitignore'), '.harness/\n');
  const planPath = writeVersionedPlan(workspace);
  fs.writeFileSync(path.join(workspace, planPath), fs.readFileSync(path.join(workspace, planPath), 'utf8').replace('required: []', 'required: [code-review]'));
  initGit(workspace); fs.writeFileSync(path.join(workspace, 'src/example.js'), 'export const value = 2;\n');
  const providerPath = path.join(copilotHome, 'agents/acme-reviewer.agent.md');
  if (provider) fs.writeFileSync(providerPath, '---\nname: acme-reviewer\ndescription: Independent simplicity reviewer\ntools: [read]\nagents: []\ncapabilities: [code-simplicity-reviewer, compounding-typescript-reviewer, spec-flow-analyzer]\n---\nReview simplicity in separate context.\n');
  const options = { workspace, home, copilotHome };
  configureDiscovery({ ...options, input: { schema: 1, roots: [{ path: copilotHome, kind: 'config', included: true }], ongoing: true, autoUpdate: true, autoIncludeNew: true, grants: { tools: ['read'], agents: [], create: ['agent'] } } });
  const plan = loadPlan(workspace, planPath, { home });
  return { ...options, options, plan, planPath, providerPath };
}

async function observeReviewFixture(f, packet, results) {
  const sessionId = 'observed-review-session';
  writeSession(f.workspace, { sessionId, activePlan: f.plan.path });
  const observed = await observeNativeSpecialist({ ...f.options, configured: true,
    policy: decisionPolicyFromDiscovery(discoveryPolicy(f.options)), payload: {
      cwd: f.workspace, session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: `review-${packet.id}`,
      tool_input: { subagent_type: 'acme-reviewer', prompt: `Review packet ${packet.id}` },
      tool_response: { content: JSON.stringify({ schema: 1, packet: packet.id, results }) }, success: true,
    } });
  assert.equal(observed.reviewObserved, true, observed.reason);
}

test('consented review binds perspective to observed external provider output and intrinsic findings schema', async t => {
  const f = fixture(t);
  const packet = prepareReview({ ...f.options, plan: f.plan, base: 'HEAD' });
  assert.equal(packet.adaptive.tourRequired, true);
  assert.deepEqual(packet.preparation.providers.map(p => [p.perspective, p.name]), [['code-simplicity-reviewer', 'acme-reviewer'], ['compounding-typescript-reviewer', 'acme-reviewer'], ['spec-flow-analyzer', 'acme-reviewer']]);
  const binding = packet.preparation.sources.find(s => s.origin === 'installed');
  assert.equal(binding.path, f.providerPath); assert.match(binding.sha256, /^[a-f0-9]{64}$/);
  assert.equal(packet.preparation.findingsSchema, 'review-findings-v1');
  assert.equal(packet.preparation.sources.some(s => s.origin === 'corpus' && s.path.includes('agents/')), false);
  const results = packet.required.map(reviewer => ({ reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [], provenance: { kind: 'host-invocation', agent: 'acme-reviewer', via: 'engineer' }, ...(reviewer === 'spec-flow-analyzer' ? { flow_ledger: ledger() } : {}) }));
  const authored = assembleReview({ ...f.options, plan: f.plan, packetId: packet.id, input: { packet: packet.id, results } });
  assert.equal(authored.coverage.complete, false, 'Authored host-invocation provenance cannot establish independent coverage');
  await observeReviewFixture(f, packet, results);
  const record = assembleReview({ ...f.options, plan: f.plan, packetId: packet.id, input: { packet: packet.id, results } });
  assert.equal(record.coverage.complete, true);
  const readiness = reviewReadinessEvidence({ ...f.options, planPath: f.planPath });
  assert.equal(readiness.ready, false);
  assert.ok(readiness.failures.some(message => /tour/i.test(message)));
  assert.ok(readiness.failures.some(message => /verify|verification/i.test(message)));
});

test('missing reviewer never drops required coverage and yields a create-primitive prerequisite', t => {
  const f = fixture(t, { provider: false });
  const packet = prepareReview({ ...f.options, plan: f.plan, base: 'HEAD' });
  assert.ok(packet.required.includes('code-simplicity-reviewer'));
  assert.equal(packet.preparation.acquisitionPrerequisites[0].perspective, 'code-simplicity-reviewer');
  assert.equal(packet.preparation.acquisitionPrerequisites[0].workflow, 'create-primitive');
  const record = assembleReview({ ...f.options, plan: f.plan, packetId: packet.id, input: { packet: packet.id, results: [] } });
  assert.equal(record.coverage.complete, false);
});

test('provider byte changes and revoked catalog consent invalidate prepared reviews', t => {
  const f = fixture(t);
  const packet = prepareReview({ ...f.options, plan: f.plan, base: 'HEAD' });
  fs.appendFileSync(f.providerPath, '\nAdditional reviewer criteria.\n');
  assert.equal(preparationIsCurrent(f.workspace, packet.preparation, { ...f.options, plan: f.plan }), false);
  assert.throws(() => assembleReview({ ...f.options, plan: f.plan, packetId: packet.id, input: { packet: packet.id, results: [] } }), /stale/);
  const updated = prepareReview({ ...f.options, plan: f.plan, base: 'HEAD' });
  const current = discoveryPolicy(f.options);
  configureDiscovery({ ...f.options, input: { ...current.policy, expectedRevision: current.policyRevision, exclusions: [f.providerPath] } });
  assert.equal(preparationIsCurrent(f.workspace, updated.preparation, { ...f.options, plan: f.plan }), false);
  const revoked = prepareReview({ ...f.options, plan: f.plan, base: 'HEAD' });
  assert.equal(revoked.preparation.providers.length, 0);
  assert.equal(revoked.preparation.acquisitionPrerequisites.length, revoked.required.length);
});

test('adaptive review becomes current only after a tour and remains separate from verification', async t => {
  const f = fixture(t);
  const packet = prepareReview({ ...f.options, plan: f.plan, base: 'HEAD' });
  const results = packet.required.map(reviewer => ({ reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [], provenance: { kind: 'host-invocation', agent: 'acme-reviewer', via: 'engineer' }, ...(reviewer === 'spec-flow-analyzer' ? { flow_ledger: ledger() } : {}) }));
  await observeReviewFixture(f, packet, results);
  assembleReview({ ...f.options, plan: f.plan, packetId: packet.id, input: { packet: packet.id, results } });
  assert.equal(validateReview({ ...f.options, plan: f.plan }).pass, false);
  const code = { path: 'src/example.js', line: 1, symbol: 'value' }, planSource = { path: f.planPath, line: 2, symbol: 'plan_schema' };
  await authorReviewTour({ ...f.options, plan: f.plan, packetId: packet.id, input: {
    schema: 1, packet: packet.id, purpose: 'Change the exported value.', before: 'The value was one.', after: 'The value is two.',
    context: { summary: 'The accepted plan governs this source change.', components: [{ id: 'source', label: 'Value export', role: 'changed', source: code }, { id: 'plan', label: 'Accepted plan', role: 'context', source: planSource }], edges: [{ from: 'plan', to: 'source', claim: 'Scopes the value change', kind: 'inferred', evidence: [planSource] }] },
    readingOrder: [{ step: 'Inspect the exported value.', component: 'source', code: [code], tests: [] }],
    verification: [{ claim: 'Named behavioral verification remains a separate prerequisite.', refs: [code] }], risks: [], questions: [],
  } });
  assert.equal(validateReview({ ...f.options, plan: f.plan }).pass, true);
  const readiness = reviewReadinessEvidence({ ...f.options, planPath: f.planPath });
  assert.equal(readiness.ready, false);
  assert.ok(readiness.binding.tour?.id);
  assert.ok(readiness.failures.every(message => !/tour/i.test(message)));
  fs.writeFileSync(path.join(f.workspace, 'src/example.js'), 'export const value = 3;\n');
  assert.equal(validateReview({ ...f.options, plan: f.plan }).pass, false);
  assert.equal(reviewReadinessEvidence({ ...f.options, planPath: f.planPath }).ready, false);
});
