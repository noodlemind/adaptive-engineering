import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { recordHash } from '../lib/review.mjs';
import { solutionsWriteTarget } from '../lib/project-layout.mjs';
import { verifiedEpisodeRecurrence, retainVerifiedPublication } from '../lib/resource-recurrence.mjs';
import { resourceCandidates, proposeResource } from '../lib/resource-candidates.mjs';
import { adaptationContext } from '../lib/adaptive-context.mjs';
import { reviewHash } from '../lib/review-preparation.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-resource-recurrence-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'product'), home = path.join(base, 'ae'), copilotHome = path.join(base, 'config');
  fs.mkdirSync(workspace); fs.mkdirSync(copilotHome);
  const options = { workspace, home, copilotHome };
  const put = (root, rel, value) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const lesson = (task, patch = {}) => {
    const plan = `/external/plans/${task}.md`, binding = { planDigest: digest(task) }, checks = [{ id: 'behavior', status: 'passed', proof: 'behavior' }, { id: 'criteria-evidence', status: 'passed' }];
    const evidence = { version: 5, plan, binding, outcome: 'passed', checks, evidencePath: `.harness/evidence/${task}.json` };
    put(workspace, `.harness/evidence/history/${digest(JSON.stringify(evidence))}.json`, evidence);
    put(workspace, evidence.evidencePath, evidence);
    const verificationIdentity = recordHash({ version: evidence.version, plan, binding, outcome: 'passed', checks: checks.map(x => ({ id: x.id, status: x.status, proof: x.proof || null })), review: null });
    const proof = { version: 1, plan, binding, verificationIdentity, evidencePath: evidence.evidencePath, review: null };
    const target = solutionsWriteTarget(workspace, { home }), relative = `${target.dirRel}/java/${task}.md`;
    const resource = { kind: 'skill', name: 'acme-java', path: path.join(copilotHome, 'skills/acme-java/SKILL.md'), sha256: digest('source'), assurance: 'source-loaded; task outcome does not prove causal effectiveness' };
    const doc = `---\ntitle: Transaction workflow\nkind: ${patch.kind || 'fix'}\nclaim: Use bounded transaction retries\nproof_identity: ${patch.fakeProof || verificationIdentity}\nwork_contract: ${binding.planDigest}\nresource_uses: ${JSON.stringify([resource])}\n---\nPreserve ordering.\n`;
    const episodeFile = put(target.base, relative, doc);
    const decision = { operation: `lesson-${task}`, decision: 'publish', rationale: 'Useful repeated procedure.', scope: 'private' };
    const destination = { base: target.base, dirRel: target.dirRel };
    const record = { version: 1, state: 'done', operation: recordHash(decision.operation), decision, destination, proof, digest: recordHash({ decision, proof: verificationIdentity, destination }), result: { pass: true, indexed: true, publicationVersion: 1, path: relative, publishedPath: episodeFile, publishedHash: recordHash(doc) } };
    const receiptPath = put(workspace, `.harness/learning/${record.operation}.json`, record);
    return { episodeFile, receiptPath, record, resource, plan };
  };
  return { ...options, options, put, lesson };
}

test('distinct verified private task episodes surface claim and source-version recurrence', t => {
  const f = fixture(t); f.lesson('one'); f.lesson('two');
  const result = verifiedEpisodeRecurrence(f.options);
  assert.equal(result.claimRecurrence.length, 1); assert.equal(result.claimRecurrence[0].count, 2);
  assert.equal(result.resourceUseRecurrence.length, 1); assert.equal(result.resourceUseRecurrence[0].count, 2);
  assert.equal(result.resourceUseRecurrence[0].causalEffectiveness, 'unassessed');
  assert.equal(result.claimRecurrence[0].recommendation, 'reuse-or-improve');
  assert.ok(result.claimRecurrence[0].evidence.some(x => x.source === 'user' && x.base));
  const packet = resourceCandidates({ ...f.options, dryRun: true });
  assert.equal(packet.resourceUseRecurrence.length, 1);
  assert.ok(packet.candidates.some(x => x.recurrence === 'verified-private-claim'));
});

test('unbound fixes, human teachings, insights and damaged historical proof do not establish recurrence', t => {
  const f = fixture(t); f.lesson('one'); f.lesson('insight', { kind: 'insight' }); f.lesson('human', { kind: 'human-teaching' }); f.lesson('fake', { fakeProof: digest('unproven') });
  const damaged = f.lesson('damaged'); fs.appendFileSync(damaged.episodeFile, 'changed');
  const bare = solutionsWriteTarget(f.workspace, { home: f.home });
  f.put(bare.base, `${bare.dirRel}/java/unbound.md`, '---\nkind: fix\nclaim: Use bounded transaction retries\nproof_identity: fake\n---\nClaimed success.\n');
  const result = verifiedEpisodeRecurrence(f.options);
  assert.equal(result.claimRecurrence.length, 0); assert.equal(result.resourceUseRecurrence.length, 0);
  assert.ok(result.diagnostics.length);
});

test('replaying the same task is not another distinct use and changed resource versions are separate', t => {
  const f = fixture(t); const one = f.lesson('one');
  const duplicate = { ...one.record, operation: recordHash('replay'), decision: { ...one.record.decision, operation: 'replay' } };
  duplicate.digest = recordHash({ decision: duplicate.decision, proof: duplicate.proof.verificationIdentity, destination: duplicate.destination });
  f.put(f.workspace, `.harness/learning/${duplicate.operation}.json`, duplicate);
  assert.equal(verifiedEpisodeRecurrence(f.options).claimRecurrence.length, 0);
  const two = f.lesson('two');
  const updated = fs.readFileSync(two.episodeFile, 'utf8').replace(digest('source'), digest('new-source'));
  fs.writeFileSync(two.episodeFile, updated); two.record.result.publishedHash = recordHash(updated); fs.writeFileSync(two.receiptPath, JSON.stringify(two.record));
  const result = verifiedEpisodeRecurrence(f.options);
  assert.equal(result.claimRecurrence.length, 1); assert.equal(result.resourceUseRecurrence.length, 0);
});

test('scan rejects symlinked private episode roots and reports finite history coverage', t => {
  const f = fixture(t); f.lesson('one'); f.lesson('two');
  const result = verifiedEpisodeRecurrence({ ...f.options, maxRecords: 1 });
  assert.equal(result.claimRecurrence.length, 0); assert.ok(result.omitted.records > 0);
  const target = solutionsWriteTarget(f.workspace, { home: f.home });
  const elsewhere = path.join(f.home, 'elsewhere'); fs.renameSync(path.join(target.base, target.dirRel), elsewhere);
  fs.symlinkSync(elsewhere, path.join(target.base, target.dirRel), 'dir');
  const redirected = verifiedEpisodeRecurrence(f.options);
  assert.equal(redirected.claimRecurrence.length, 0); assert.ok(redirected.diagnostics.length);
});

test('a private recurrence proposal binds the selected project-store episode bytes', t => {
  const f = fixture(t); const one = f.lesson('one'); f.lesson('two');
  const packet = resourceCandidates(f.options);
  const input = { schema: 1, operation: 'bounded-retry-proposal', type: 'cli', name: 'bounded-retry', rationale: 'Two verified tasks used the same procedure.', text: 'Add a bounded operation under the existing workflow.', candidatePacket: packet.id, candidate: packet.candidates.find(row => row.recurrence === 'verified-private-claim').id };
  assert.equal(proposeResource({ ...f.options, input }).status, 'ok');
  fs.appendFileSync(one.episodeFile, 'Changed after candidate capture.');
  assert.throws(() => proposeResource({ ...f.options, input }), /evidence changed/i);
});

test('retained private proof remains usable after the original worktree runtime records disappear', t => {
  const f = fixture(t); const one = f.lesson('one'), two = f.lesson('two');
  assert.equal(retainVerifiedPublication({ ...f.options, record: one.record }).retained, true);
  assert.equal(retainVerifiedPublication({ ...f.options, record: two.record }).retained, true);
  fs.rmSync(path.join(f.workspace, '.harness'), { recursive: true });
  const found = verifiedEpisodeRecurrence(f.options);
  assert.equal(found.claimRecurrence.length, 1); assert.equal(found.resourceUseRecurrence[0].count, 2);
  assert.ok(found.resourceUseRecurrence[0].evidence.every(ref => ref.source === 'user'));
});

test('orientation reports omitted oversized recurrence evidence as partial instead of asserting no recurrence', t => {
  const f = fixture(t);
  for (const revision of ['one', 'two']) {
    const findings = Array.from({ length: 5 }, (_, index) => ({ id: `claim-${index}`, file: `src/feature-${index}.js`, title: `Recurring transaction defect ${index}: ${'detail '.repeat(2500)}` }));
    const value = { version: 2, scope: { revision }, findings, residual_risks: [] }, id = reviewHash(value);
    f.put(f.workspace, `.harness/reviews/records/${id}.json`, { ...value, id, recordedAt: '2026-11-05' });
  }
  const packet = resourceCandidates({ ...f.options, dryRun: true });
  assert.ok(packet.omitted.candidates >= 5); assert.equal(packet.candidates.length, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 65536);
  const context = adaptationContext({ ...f.options, query: 'transaction defect' });
  assert.equal(context.coverage.state, 'partial'); assert.ok(context.omitted > 0);
  assert.match(context.assessment, /evidence was omitted/i);
  assert.doesNotMatch(context.assessment, /^No relevant recurrence/);
  assert.equal(context.nextAction, 'ae resources candidates --json');
});
