import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import YAML from 'yaml';
import { readDomain } from '../lib/domain-contract.mjs';
import { gitExecutable } from '../corpus/hooks/lib/git-executable.mjs';
import { snapshotDomain } from '../lib/domain-bindings.mjs';
import { approveProject, isProjectTrusted, trustStatus } from '../lib/trust.mjs';
import { resolveDomainContext, authorizeDomainPlan } from '../lib/domain-context.mjs';
import { planFromText, loadPlan } from '../lib/plan-parse.mjs';
import { createDomainPlans } from '../lib/domain-plans.mjs';
import { updatePlanDecision } from '../lib/plan-update.mjs';
import { planRevision } from '../lib/plan-decisions.mjs';
import { createEvidenceBinding, planDigest, proofPolicyDigest, readEvidence, validateEvidence } from '../lib/evidence.mjs';
import { prepareReview, assembleReview, recordHash } from '../lib/review.mjs';
import { runVerify } from '../lib/verify.mjs';
import { runCompound } from '../lib/compound.mjs';
import { validateCompletion } from '../lib/completion.mjs';
import { domainExecutionBinding, domainPrerequisites, runDomainJointChecks, domainStatus, snapshotDomainCoordinator, domainCoordinatorCheck } from '../lib/domain-delivery.mjs';
import { scriptedFlowLedger } from './helpers/cli-fixtures.mjs';
import { withGitObservationCache } from '../lib/git-observation-cache.mjs';

function git(root, args) {
  const result = spawnSync(gitExecutable(), args, { cwd: root, encoding: 'utf8', timeout: 4000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'domain-delivery-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const copilotHome = path.join(dir, 'copilot');
  const repositories = Object.fromEntries(['producer', 'consumer', 'coordinator'].map(id => {
    const root = path.join(dir, id);
    fs.mkdirSync(root);
    git(root, ['init', '-b', 'feature/catalog']);
    git(root, ['config', 'user.name', 'Domain Delivery']);
    git(root, ['config', 'user.email', 'domain@example.invalid']);
    git(root, ['remote', 'add', 'origin', `https://example.invalid/team/${id}.git`]);
    fs.writeFileSync(path.join(root, 'schema.json'), JSON.stringify({ version: id === 'producer' ? 2 : 1 }));
    fs.mkdirSync(path.join(root, '.github/harness'), { recursive: true });
    const joint = `const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.env.HARNESS_DOMAIN_REVISION_MANIFEST,'utf8')); const roots=Object.fromEntries(m.repos.map(r=>[r.id,r.root])); const v=id=>JSON.parse(fs.readFileSync(roots[id]+'/schema.json','utf8')).version; process.exit(v('producer')===v('consumer')?0:1);`;
    const local = `const s=JSON.parse(require('fs').readFileSync('schema.json','utf8')); if(Object.keys(s).join(',')!=='version'||!Number.isSafeInteger(s.version)||s.version<1)process.exit(1);`;
    fs.writeFileSync(path.join(root, '.github/harness/checks.yaml'), YAML.stringify({ version: 1, checks: { local: { command: [process.execPath, '-e', local] }, compatibility: { command: [process.execPath, '-e', joint] } } }));
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'Initial participating product']);
    approveProject({ workspace: root, home, copilotHome });
    return [id, root];
  }));
  const coordinator = repositories.coordinator;
  const roots = Object.fromEntries(['producer', 'consumer'].map(id => [id, repositories[id]]));
  const config = { domain_version: 2, name: 'catalog', repos: Object.keys(roots).map(id => ({ id, origin: `https://example.invalid/team/${id}.git` })), sources: [], bindings: { repos: roots, sources: {} }, shared_specs: [], shared_conventions: [] };
  fs.mkdirSync(path.join(home, 'domains'), { recursive: true });
  fs.writeFileSync(path.join(home, 'domains/catalog.yaml'), YAML.stringify(config));
  const binding = snapshotDomain(readDomain('catalog', { home }));
  const recordRoot = path.join(home, 'domains/catalog');
  fs.mkdirSync(recordRoot);
  const fullPath = path.join(recordRoot, 'plans/2026-10-12-feat-catalog-plan.hplan');
  const fm = { plan_schema: 3, plan_id: '7ea1bcb9-6fdf-4e4e-8484-0b048648a975', domain_binding: binding, domain_parent: { version: 1, name: 'catalog', coordinator: snapshotDomainCoordinator(coordinator), repos: Object.entries(roots).map(([id, root]) => ({ id, initial_head: git(root, ['rev-parse', 'HEAD']), touched_scope: [], depends_on: id === 'consumer' ? ['producer'] : [], child_plan_id: null, child_plan_path: null })), joint_checks: [{ repo: 'consumer', check: 'compatibility' }], release_order: ['producer', 'consumer'], rollback: 'The producer owner restores the prior schema before consumer rollback.' } };
  const plan = authorizeDomainPlan(resolveDomainContext({ workspace: coordinator, home, name: 'catalog' }), planFromText(`---\n${YAML.stringify(fm)}---\n\n# Catalog\n`, { path: fullPath, fullPath }));
  return { dir, home, copilotHome, roots, coordinator, plan, recordRoot, options: { workspace: coordinator, plan, copilotHome, home, recordRoot } };
}

test('participating content keeps literal mode-bound evidence and selected-home trust without discarded per-repo HEAD probes', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.roots.producer, 'schema.json'), '{"version":5}');
  const previous = createEvidenceBinding({ workspace: f.roots.producer, plan: { path: '', text: '', fm: {}, phase: 0 }, base: f.plan.fm.domain_parent.repos[0].initial_head, changedFiles: ['schema.json'], copilotHome: f.copilotHome });
  assert.equal(previous.workspaceDigest, 'ea203c82ae2e8707728efbe2a968c1c501ff984104776e5adcdc343189cabff8');
  assert.equal(trustStatus({ workspace: f.roots.producer, copilotHome: f.copilotHome }).state, 'untrusted');
  assert.equal(trustStatus({ workspace: f.roots.producer, copilotHome: f.copilotHome, home: f.home }).state, 'trusted');
  const spawn = childProcess.spawnSync;
  const executable = gitExecutable();
  const redundant = [];
  t.mock.method(childProcess, 'spawnSync', function(command, args, options) {
    if (command === executable && args.length === 4 && args[0] === '-C' && args[2] === 'rev-parse' && args[3] === 'HEAD' && Object.values(f.roots).includes(args[1])) redundant.push(args[1]);
    return spawn.apply(this, arguments);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const binding = domainExecutionBinding(f.options);
  const producer = binding.repos.find(repo => repo.id === 'producer');
  assert.equal(JSON.stringify({ changedFiles: producer.changedFiles, workspaceDigest: producer.workspaceDigest }), JSON.stringify({ changedFiles: previous.changedFiles, workspaceDigest: previous.workspaceDigest }));
  assert.equal(producer.policyDigest, proofPolicyDigest(f.roots.producer, f.copilotHome, f.home));
  assert.equal(producer.trust, 'trusted');
  assert.deepEqual(redundant, [], 'Member HEAD is already part of the live repository identity observation');
});

test('one completion reuses the git observation of each checkout', t => {
  const f = fixture(t);
  const spawn = childProcess.spawnSync;
  const executable = gitExecutable();
  let gitCalls = 0;
  t.mock.method(childProcess, 'spawnSync', function (command, args, options) {
    if (command === executable) gitCalls += 1;
    return spawn.apply(this, arguments);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const measure = (run) => { gitCalls = 0; run(); return gitCalls; };
  const single = measure(() => domainExecutionBinding(f.options));
  const repeated = measure(() => { domainExecutionBinding(f.options); domainExecutionBinding(f.options); });
  assert.ok(repeated > single, 'a second binding re-reads git when no completion cache is active');
  const cached = measure(() => withGitObservationCache(() => { domainExecutionBinding(f.options); domainExecutionBinding(f.options); }));
  assert.ok(cached <= single, `cached bindings issued ${cached} git calls and one binding issued ${single}`);
  const validated = measure(() => validateCompletion({ workspace: f.coordinator, plan: f.plan, copilotHome: f.copilotHome }));
  assert.ok(validated <= single + 8, `validateCompletion issued ${validated} git calls and one binding issued ${single}`);
  fs.writeFileSync(path.join(f.roots.producer, 'schema.json'), '{"version":9}\n');
  const changed = domainExecutionBinding(f.options);
  assert.deepEqual(changed.repos.find(repo => repo.id === 'producer').changedFiles, ['schema.json']);
});

test('removing discarded content authority preserves refusal of an invalid selected-home trusted policy', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.roots.producer, '.github/harness/policy.yaml'), 'version: 2\nenforcement: unsupported\n');
  approveProject({ workspace: f.roots.producer, home: f.home, copilotHome: f.copilotHome });
  assert.equal(trustStatus({ workspace: f.roots.producer, home: f.home, copilotHome: f.copilotHome }).state, 'trusted');
  const binding = domainExecutionBinding(f.options);
  const producer = binding.repos.find(repo => repo.id === 'producer');
  assert.equal(producer.unavailable, true);
  assert.equal(producer.completion.pass, false);
  assert.match(producer.completion.message, /Invalid enforcement mode/);
});

test('joint proof executes against participating revision manifest and catches a producer consumer mismatch despite passing local checks', async t => {
  const f = fixture(t);
  assert.equal(domainPrerequisites(f.options).pass, true);
  const before = domainExecutionBinding(f.options);
  assert.equal(before.repos.length, 2);
  assert.equal(before.repos.find(repo => repo.id === 'consumer').child, null);
  const first = await runDomainJointChecks(f.options);
  assert.equal(first.pass, false);
  assert.equal(first.checks.find(check => check.id === 'domain-joint:consumer:compatibility').status, 'failed');
  assert.equal(domainStatus(f.options).joint[0].status, 'failed');
  fs.writeFileSync(path.join(f.roots.consumer, 'schema.json'), JSON.stringify({ version: 2 }));
  git(f.roots.consumer, ['add', 'schema.json']);
  git(f.roots.consumer, ['commit', '-m', 'Accept compatible dependency revision']);
  f.plan.fm.domain_parent.repos.find(repo => repo.id === 'consumer').initial_head = git(f.roots.consumer, ['rev-parse', 'HEAD']);
  const repaired = await runDomainJointChecks(f.options);
  assert.equal(repaired.pass, true);
  assert.equal(domainStatus(f.options).joint[0].status, 'passed');
  const retained = await runDomainJointChecks(f.options);
  assert.equal(retained.pass, true);
  assert.equal(retained.checks.find(check => check.id === 'domain-joint:consumer:compatibility').reused, true);
  const receiptPath = path.join(f.recordRoot, '.harness/domain/joint', f.plan.fm.plan_id, `${recordHash({ repo: 'consumer', check: 'compatibility' })}.json`);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  receipt.recordedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.equal(domainStatus(f.options).joint[0].status, 'stale');
  const refreshed = await runDomainJointChecks(f.options);
  assert.equal(refreshed.pass, true);
  assert.equal(refreshed.checks.find(check => check.id === 'domain-joint:consumer:compatibility').reused, undefined);
  assert.notEqual(domainExecutionBinding(f.options).digest, before.digest);
  git(f.roots.producer, ['commit', '--allow-empty', '-m', 'A sibling head moved']);
  assert.equal(domainStatus(f.options).joint[0].status, 'stale');
});

test('joint proof refuses untrusted checks and a missing participant rather than skipping them', async t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.roots.consumer, '.github/harness/checks.yaml'), '\n# policy changed\n');
  git(f.roots.consumer, ['add', '.github/harness/checks.yaml']);
  git(f.roots.consumer, ['commit', '-m', 'Alter the joint check policy']);
  f.plan.fm.domain_parent.repos.find(repo => repo.id === 'consumer').initial_head = git(f.roots.consumer, ['rev-parse', 'HEAD']);
  const stale = await runDomainJointChecks(f.options);
  assert.equal(stale.pass, false);
  assert.match(stale.checks.map(check => check.message).join(' '), /trust|policy/i);
  fs.renameSync(f.roots.consumer, `${f.roots.consumer}-missing`);
  const missing = domainPrerequisites(f.options);
  assert.equal(missing.pass, false);
  assert.match(missing.message, /root|identity|unavailable/i);
});

test('parent verification requires a real current child completion and rejects an omitted touched child', t => {
  const f = fixture(t);
  f.plan.fm.domain_parent.repos[0].touched_scope = ['schema.json'];
  assert.equal(domainPrerequisites(f.options).pass, false);
  f.plan.fm.domain_parent.repos[0].child_plan_id = 'd8f1073e-3a0c-4e6e-95a8-b3b7f314c31d';
  f.plan.fm.domain_parent.repos[0].child_plan_path = '2026-10-12-feat-producer-plan.hplan';
  const checked = domainPrerequisites(f.options);
  assert.equal(checked.pass, false);
  assert.match(checked.message, /child|completion|missing/i);
});

test('joint proof invalidates a successful command if participating bytes change during the command', async t => {
  const f = fixture(t);
  const checks = YAML.parse(fs.readFileSync(path.join(f.roots.consumer, '.github/harness/checks.yaml'), 'utf8'));
  checks.checks.compatibility.command = [process.execPath, '-e', `require('fs').writeFileSync('../producer/schema.json','{"version":3}');`];
  fs.writeFileSync(path.join(f.roots.consumer, '.github/harness/checks.yaml'), YAML.stringify(checks));
  git(f.roots.consumer, ['add', '.github/harness/checks.yaml']);
  git(f.roots.consumer, ['commit', '-m', 'Use a deliberately mutating integrated check']);
  f.plan.fm.domain_parent.repos.find(repo => repo.id === 'consumer').initial_head = git(f.roots.consumer, ['rev-parse', 'HEAD']);
  approveProject({ workspace: f.roots.consumer, home: f.home, copilotHome: f.copilotHome });
  const result = await runDomainJointChecks(f.options);
  assert.equal(result.pass, false);
  assert.equal(result.checks.find(check => check.id === 'domain-revision-stability').status, 'failed');
  assert.equal(domainStatus(f.options).joint[0].status, 'stale');
});

test('a check cannot replace the controller manifest and retain passing joint proof', async t => {
  const f = fixture(t);
  const checkPath = path.join(f.roots.consumer, '.github/harness/checks.yaml');
  const checks = YAML.parse(fs.readFileSync(checkPath, 'utf8'));
  checks.checks.compatibility.command = [process.execPath, '-e', `require('fs').writeFileSync(process.env.HARNESS_DOMAIN_REVISION_MANIFEST,'{}');`];
  fs.writeFileSync(checkPath, YAML.stringify(checks));
  git(f.roots.consumer, ['add', '.github/harness/checks.yaml']);
  git(f.roots.consumer, ['commit', '-m', 'Use a deliberately forged manifest']);
  f.plan.fm.domain_parent.repos.find(repo => repo.id === 'consumer').initial_head = git(f.roots.consumer, ['rev-parse', 'HEAD']);
  approveProject({ workspace: f.roots.consumer, home: f.home, copilotHome: f.copilotHome });
  const result = await runDomainJointChecks(f.options);
  assert.equal(result.pass, false);
  assert.equal(result.checks.find(check => check.id === 'domain-revision-stability').status, 'failed');
});

test('retained joint JSON artifacts remain owned by their physical check and tampering invalidates the receipt', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.roots.consumer, 'schema.json'), JSON.stringify({ version: 2 }));
  const checkPath = path.join(f.roots.consumer, '.github/harness/checks.yaml');
  const checks = YAML.parse(fs.readFileSync(checkPath, 'utf8'));
  checks.checks.compatibility.artifacts = ['compatibility.json'];
  checks.checks.compatibility.command[2] = checks.checks.compatibility.command[2].replace('process.exit(', `require('fs').writeFileSync(process.env.HARNESS_CHECK_ARTIFACT_DIR+'/compatibility.json',JSON.stringify({version:1,compatible:v('producer')===v('consumer')})); process.exit(`);
  git(f.roots.consumer, ['add', 'schema.json']);
  fs.writeFileSync(checkPath, YAML.stringify(checks));
  git(f.roots.consumer, ['add', '.github/harness/checks.yaml']);
  git(f.roots.consumer, ['commit', '-m', 'Accept a check with an owned JSON receipt']);
  f.plan.fm.domain_parent.repos.find(repo => repo.id === 'consumer').initial_head = git(f.roots.consumer, ['rev-parse', 'HEAD']);
  approveProject({ workspace: f.roots.consumer, home: f.home, copilotHome: f.copilotHome });
  const result = await runDomainJointChecks(f.options);
  assert.equal(result.pass, true, JSON.stringify(result));
  assert.equal(domainStatus(f.options).pass, true);
  const joint = result.checks.find(check => check.id === 'domain-joint:consumer:compatibility');
  fs.writeFileSync(path.join(f.recordRoot, joint.artifacts[0].path), '{"compatible":false}\n');
  assert.equal(domainStatus(f.options).joint[0].status, 'stale');
});

test('another coordinator or a moved accepted coordinator head cannot execute or resume the parent', t => {
  const f = fixture(t);
  assert.equal(domainCoordinatorCheck({ workspace: f.coordinator, plan: f.plan }).pass, true);
  assert.equal(domainCoordinatorCheck({ workspace: f.roots.producer, plan: f.plan }).pass, false);
  git(f.coordinator, ['commit', '--allow-empty', '-m', 'Coordinator revision moved']);
  assert.equal(domainCoordinatorCheck({ workspace: f.coordinator, plan: f.plan }).pass, false);
  assert.equal(domainPrerequisites(f.options).pass, false);
});

async function completeChild(f, child, iteration) {
  const options = { workspace: child.workspace, home: f.home, planPath: child.path, copilotHome: f.copilotHome };
  const read = () => loadPlan(child.workspace, child.path, { home: f.home });
  const decide = (action, fields = {}) => updatePlanDecision({ ...options, input: { version: 1, id: `${child.repo}-${action}-${iteration}`, action, expect: planRevision(read().text), ...fields } });
  if (read().status === 'open') {
    const start = decide('start');
    assert.equal(start.status, 'ok', JSON.stringify(start));
    const progress = decide('progress', { progress: { tasks: ['P1T1'], criteria: ['AC1'] } });
    assert.equal(progress.status, 'ok', JSON.stringify(progress));
  }
  const plan = read();
  const packet = prepareReview({ workspace: child.workspace, plan, base: 'HEAD', copilotHome: f.copilotHome, maxBytes: 131072 });
  const review = assembleReview({ workspace: child.workspace, plan, packetId: packet.id, copilotHome: f.copilotHome, input: { packet: packet.id, results: packet.required.map(reviewer => ({ ...scriptedFlowLedger(packet, reviewer), reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [], provenance: { kind: 'same-context', method: 'Fixture review of this deterministic acceptance workspace' } })) } });
  assert.equal(review.coverage.complete, true, JSON.stringify(review));
  const verification = await runVerify({ workspace: child.workspace, flags: { plan: child.path, base: 'HEAD', harnessHome: f.home, copilotHome: f.copilotHome } });
  assert.equal(verification.outcome, 'passed', JSON.stringify(verification.checks));
  const learningPath = path.join(f.dir, `${child.repo}-${iteration}-learning.json`);
  fs.writeFileSync(learningPath, JSON.stringify({ operation: `${child.repo}-${iteration}-no-learning`, decision: 'no-learning', rationale: 'This deterministic fixture exercises lifecycle binding and supplies no reusable product learning.' }));
  const learning = await runCompound({ workspace: child.workspace, copilotHome: f.copilotHome, flags: { plan: child.path, harnessHome: f.home, learningDecision: learningPath } });
  assert.equal(learning.pass, true, JSON.stringify(learning));
  const completed = decide('complete');
  assert.equal(completed.status, 'ok', JSON.stringify(completed));
  const current = validateCompletion({ workspace: child.workspace, plan: read(), copilotHome: f.copilotHome });
  assert.equal(current.pass, true, JSON.stringify(current));
  return current.record;
}

test('completed per-repo proof remains separate from joint compatibility, repair preserves the current producer completion', async t => {
  const f = fixture(t);
  const decision = { version: 1, id: 'accepted-catalog', format: 'full', slug: 'accepted-catalog', goal: 'Deliver compatible producer and consumer schema.', outputs: ['producer/schema.json', 'consumer/schema.json'], check: 'local', acceptance: ['The participating revision set is compatible.'], repos: ['producer', 'consumer'].map(id => ({ id, scope: ['schema.json'], depends_on: id === 'consumer' ? ['producer'] : [], plan: { version: 1, format: 'full', slug: `${id}-catalog`, goal: `Deliver the ${id} schema.`, outputs: ['schema.json'], check: 'local', acceptance: ['The local schema check passes.'] } })), joint_checks: [{ repo: 'consumer', check: 'compatibility' }], release_order: ['producer', 'consumer'], rollback: 'Producer owner coordinates restoring the prior compatible pair.' };
  const context = resolveDomainContext({ workspace: f.coordinator, home: f.home, name: 'catalog' });
  const created = createDomainPlans({ workspace: f.coordinator, home: f.home, name: 'catalog', copilotHome: f.copilotHome, decision });
  const parent = loadPlan(f.coordinator, created.parent.path, { home: f.home, domainContext: context });
  const options = { ...f.options, plan: parent };
  const readParent = () => loadPlan(f.coordinator, created.parent.path, { home: f.home, domainContext: context });
  const decideParent = (action, fields = {}) => updatePlanDecision({ workspace: f.coordinator, home: f.home, domainContext: context, planPath: created.parent.path, copilotHome: f.copilotHome, input: { version: 1, id: `parent-${action}`, action, expect: planRevision(readParent().text), ...fields } });
  const start = decideParent('start');
  assert.equal(start.status, 'ok', JSON.stringify(start));
  assert.equal(planDigest(readParent().text), planDigest(parent.text), 'Starting the locked parent preserves its accepted contract');
  assert.equal(domainPrerequisites(options).pass, false);
  const producer = created.children.find(child => child.repo === 'producer');
  const consumer = created.children.find(child => child.repo === 'consumer');
  const producerCompletion = await completeChild(f, producer, 1);
  await completeChild(f, consumer, 1);
  assert.equal(decideParent('progress', { progress: { tasks: ['P1T1'], criteria: ['AC1'] } }).status, 'ok');
  assert.equal(planDigest(readParent().text), planDigest(parent.text), 'Accepted progress preserves the parent contract linked by both children');
  const childrenReady = domainPrerequisites(options);
  assert.equal(childrenReady.pass, true, childrenReady.message);
  const mismatchParent = readParent();
  const mismatchPacket = prepareReview({ workspace: f.coordinator, plan: mismatchParent, base: 'HEAD', copilotHome: f.copilotHome, maxBytes: 131072 });
  assembleReview({ workspace: f.coordinator, plan: mismatchParent, packetId: mismatchPacket.id, copilotHome: f.copilotHome, input: { packet: mismatchPacket.id, results: mismatchPacket.required.map(reviewer => ({ ...scriptedFlowLedger(mismatchPacket, reviewer), reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [], provenance: { kind: 'same-context', method: 'Fixture review of the exact compatibility obligations' } })) } });
  const failedParent = await runVerify({ workspace: f.coordinator, flags: { plan: mismatchParent.path, base: 'HEAD', harnessHome: f.home, copilotHome: f.copilotHome }, domainContext: context });
  assert.equal(failedParent.outcome, 'failed');
  assert.equal(failedParent.checks.find(check => check.id === 'domain-joint:consumer:compatibility').status, 'failed');
  assert.equal(decideParent('complete').status, 'blocked');
  fs.writeFileSync(path.join(consumer.workspace, 'schema.json'), JSON.stringify({ version: 2 }));
  assert.equal(domainPrerequisites(options).pass, false);
  await completeChild(f, consumer, 2);
  const currentParent = readParent();
  const packet = prepareReview({ workspace: f.coordinator, plan: currentParent, base: 'HEAD', copilotHome: f.copilotHome, maxBytes: 131072 });
  assembleReview({ workspace: f.coordinator, plan: currentParent, packetId: packet.id, copilotHome: f.copilotHome, input: { packet: packet.id, results: packet.required.map(reviewer => ({ ...scriptedFlowLedger(packet, reviewer), reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [], provenance: { kind: 'same-context', method: 'Fixture review of the exact bound producer and consumer proof' } })) } });
  const verification = await runVerify({ workspace: f.coordinator, flags: { plan: currentParent.path, base: 'HEAD', harnessHome: f.home, copilotHome: f.copilotHome }, domainContext: context });
  assert.equal(verification.outcome, 'passed', JSON.stringify(verification.checks));
  assert.equal(verification.checks.find(check => check.id === 'domain-joint:consumer:compatibility').status, 'passed');
  assert.equal(verification.binding.domainExecution.repos.find(repo => repo.id === 'producer').child.completionId, producerCompletion);
  const evidence = readEvidence(f.recordRoot, currentParent.path);
  const evidencePath = path.join(f.recordRoot, evidence.evidencePath);
  const evidenceText = fs.readFileSync(evidencePath, 'utf8');
  const stripped = { ...evidence, checks: evidence.checks.filter(check => !check.id.startsWith('domain-')) };
  fs.writeFileSync(evidencePath, JSON.stringify(stripped));
  const unbound = validateEvidence({ workspace: f.coordinator, plan: currentParent, evidence: stripped, copilotHome: f.copilotHome });
  assert.equal(unbound.pass, false);
  assert.match(unbound.message, /joint|integrated|domain/i);
  fs.writeFileSync(evidencePath, evidenceText);
  const jointPath = path.join(f.recordRoot, '.harness/domain/joint', currentParent.fm.plan_id, `${recordHash({ repo: 'consumer', check: 'compatibility' })}.json`);
  const jointText = fs.readFileSync(jointPath, 'utf8');
  fs.unlinkSync(jointPath);
  assert.equal(validateEvidence({ workspace: f.coordinator, plan: currentParent, evidence, copilotHome: f.copilotHome }).pass, false);
  fs.writeFileSync(jointPath, jointText);
  const learningPath = path.join(f.dir, 'parent-learning.json');
  fs.writeFileSync(learningPath, JSON.stringify({ operation: 'parent-no-learning', decision: 'no-learning', rationale: 'This deterministic fixture verifies cross-repository lifecycle behavior.' }));
  const learning = await runCompound({ workspace: f.coordinator, copilotHome: f.copilotHome, flags: { plan: currentParent.path, harnessHome: f.home, learningDecision: learningPath }, domainContext: context });
  assert.equal(learning.pass, true, JSON.stringify(learning));
  const completed = decideParent('complete');
  assert.equal(completed.status, 'ok', JSON.stringify(completed));
  const parentCompletion = validateCompletion({ workspace: f.coordinator, plan: readParent(), copilotHome: f.copilotHome });
  assert.equal(parentCompletion.pass, true, JSON.stringify(parentCompletion));
  assert.equal(git(f.coordinator, ['status', '--porcelain']), '');
  assert.equal(fs.existsSync(path.join(f.coordinator, '.harness')), false);
  const replay = createDomainPlans({ workspace: f.coordinator, home: f.home, name: 'catalog', copilotHome: f.copilotHome, decision });
  assert.equal(replay.children.find(child => child.repo === 'producer').plan_id, producer.plan_id);
  assert.equal(validateCompletion({ workspace: producer.workspace, plan: loadPlan(producer.workspace, producer.path, { home: f.home }), copilotHome: f.copilotHome }).record, producerCompletion);
  fs.writeFileSync(learningPath, JSON.stringify({ operation: 'parent-publish', decision: 'publish', scope: 'private', title: 'Integrated schemas require a participating revision set', body: 'Both local schema validators accepted structurally valid versions, while the integrated check rejected different versions. Bind the participating revisions and validate their compatibility before completing the parent.', category: 'domain', tags: ['domain', 'compatibility'], rationale: 'The fixture produced a verified compatibility failure and repair.' }));
  const published = await runCompound({ workspace: f.coordinator, copilotHome: f.copilotHome, flags: { plan: currentParent.path, harnessHome: f.home, learningDecision: learningPath }, domainContext: context });
  assert.equal(published.pass, true, JSON.stringify(published));
  assert.equal(published.indexed.entries, 1);
  assert.equal(published.indexed.indexEntries, 1);
  assert.equal(published.indexed.indexDir, path.join(f.recordRoot, '.harness/knowledge-index'));
  const publishedRelative = path.relative(path.join(f.recordRoot, 'docs/solutions'), published.publishedPath);
  assert.ok(publishedRelative && !publishedRelative.startsWith('..') && !path.isAbsolute(publishedRelative), published.publishedPath);
  assert.equal(fs.existsSync(published.publishedPath), true);
  assert.equal(fs.existsSync(path.join(f.coordinator, 'docs/solutions')), false);
  assert.equal(fs.existsSync(path.join(f.copilotHome, 'knowledge')), false);
  assert.equal(decideParent('complete', { id: 'parent-complete-publish' }).status, 'ok');
  assert.equal(validateCompletion({ workspace: f.coordinator, plan: readParent(), copilotHome: f.copilotHome }).pass, true);
});

test('creation uses the existing issue worktree policy without rewriting machine bindings or granting child trust', t => {
  const ambient = Object.fromEntries(['CI', 'HARNESS_ALLOW_INPLACE'].map(name => [name, process.env[name]]));
  for (const name of Object.keys(ambient)) delete process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(ambient)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const f = fixture(t);
  git(f.roots.producer, ['branch', '-m', 'main']);
  git(f.roots.producer, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(f.roots.producer, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  const initial = fs.readFileSync(path.join(f.roots.producer, 'schema.json'), 'utf8');
  const decision = { version: 1, id: 'isolated-catalog', slug: 'isolated-catalog', goal: 'Deliver isolated producer work.', check: 'local', acceptance: ['The pair remains compatible.'], repos: [{ id: 'producer', scope: ['schema.json'], depends_on: [], plan: { goal: 'Deliver producer schema.', slug: 'producer-isolated', check: 'local', acceptance: ['Producer proof passes.'] } }, { id: 'consumer', scope: [], depends_on: ['producer'] }], joint_checks: [{ repo: 'consumer', check: 'compatibility' }], release_order: ['producer', 'consumer'], rollback: 'Producer owner restores the previous schema.' };
  const options = { workspace: f.roots.producer, home: f.home, name: 'catalog', copilotHome: f.copilotHome, decision };
  const preview = createDomainPlans({ ...options, dryRun: true });
  assert.equal(fs.existsSync(preview.children[0].workspace), false);
  const result = createDomainPlans(options);
  const child = result.children[0];
  assert.notEqual(child.workspace, f.roots.producer);
  assert.equal(git(f.roots.producer, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.equal(fs.readFileSync(path.join(f.roots.producer, 'schema.json'), 'utf8'), initial);
  assert.equal(readDomain('catalog', { home: f.home }).config.bindings.repos.producer, f.roots.producer);
  const plan = loadPlan(child.workspace, child.path, { home: f.home });
  assert.equal(plan.fm.domain_binding.bindings.repos.find(repo => repo.id === 'producer').root, child.workspace);
  assert.equal(isProjectTrusted({ workspace: child.workspace, home: f.home, copilotHome: f.copilotHome }), false);
  assert.equal(domainPrerequisites({ workspace: f.roots.producer, home: f.home, plan: loadPlan(f.roots.producer, result.parent.path, { home: f.home, domainContext: resolveDomainContext({ workspace: f.roots.producer, home: f.home, name: 'catalog' }) }), copilotHome: f.copilotHome }).pass, false);
});

test('creation replay retains a child that accepted its ordinary start and lock transition', t => {
  const f = fixture(t);
  const decision = { version: 1, id: 'started-catalog', slug: 'started-catalog', goal: 'Deliver producer schema.', outputs: ['producer/schema.json'], check: 'local', acceptance: ['The pair remains compatible.'], repos: [{ id: 'producer', scope: ['schema.json'], depends_on: [], plan: { goal: 'Deliver producer schema.', outputs: ['schema.json'], slug: 'producer-started', check: 'local', acceptance: ['Producer proof passes.'] } }, { id: 'consumer', scope: [], depends_on: ['producer'] }], joint_checks: [{ repo: 'consumer', check: 'compatibility' }], release_order: ['producer', 'consumer'], rollback: 'Producer owner restores the previous schema.' };
  const options = { workspace: f.coordinator, home: f.home, name: 'catalog', copilotHome: f.copilotHome, decision };
  const first = createDomainPlans(options);
  const child = first.children[0];
  const original = loadPlan(child.workspace, child.path, { home: f.home });
  const start = updatePlanDecision({ workspace: child.workspace, home: f.home, planPath: child.path, copilotHome: f.copilotHome, input: { version: 1, id: 'accepted-child-start', action: 'start', expect: planRevision(original.text) } });
  assert.equal(start.status, 'ok', JSON.stringify(start));
  const replay = createDomainPlans(options);
  assert.equal(replay.children[0].plan_id, child.plan_id);
  assert.equal(loadPlan(child.workspace, child.path, { home: f.home }).status, 'in-progress');
  const journalPath = path.join(f.recordRoot, '.harness/domain/operations', `create-${recordHash(decision.id)}.json`);
  const journal = fs.readFileSync(journalPath, 'utf8');
  const journalStat = fs.statSync(journalPath, { bigint: true });
  assert.throws(() => createDomainPlans({ ...options, workspace: f.roots.consumer }), /coordinator/i);
  assert.equal(fs.readFileSync(journalPath, 'utf8'), journal);
  assert.equal(fs.statSync(journalPath, { bigint: true }).mtimeNs, journalStat.mtimeNs);
});
