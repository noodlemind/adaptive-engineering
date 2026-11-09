import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { consolidateCandidates, consolidateStatus } from '../lib/knowledge/consolidate.mjs';
import { readFeedbackConfig, storeDir, writeFeedbackConfig, writeStoreConfig } from '../lib/knowledge/store.mjs';
import {
  EXPOSURE_ENTRY_CAP, exposureTotals, feedbackState, feedbackSummary, learningVersion, publishFeedbackRecord, readExposure, recordExposure, validateFeedbackFields,
} from '../lib/learning-feedback.mjs';
import { feedbackPruningCheck } from '../lib/doctor.mjs';
import { initGit } from './helpers/cli-fixtures.mjs';
import { loadLayeredLearnings } from '../lib/knowledge/overlay.mjs';

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const PLAN = 'docs/plans/2026-11-09-feat-feedback-plan.md';

function seeded(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-feedback-unit-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'ws'), home = path.join(dir, 'home');
  fs.mkdirSync(path.join(ws, 'docs/solutions/logic'), { recursive: true });
  const episode = '---\ntitle: "lock order"\nkind: fix\ndate: 2026-11-01\n---\n\nTake the index lock before the store lock.\n';
  fs.writeFileSync(path.join(ws, 'docs/solutions/logic/lock.md'), episode);
  initGit(ws);
  const ops = path.join(dir, 'ops.json');
  fs.writeFileSync(ops, JSON.stringify({ schema: 1, ops: [{ op: 'ADD', domain: 'logic', slug: 'lock-order', trigger: 'taking the index and store locks together',
    body: 'Take the index lock before the store lock to avoid deadlock.', episodes: [{ path: 'docs/solutions/logic/lock.md', sha256: sha(episode), kind: 'fix', plan: 'docs/plans/a.md' }] }] }));
  assert.equal(applyOps({ workspace: ws, opsPath: ops, home }).exitCode, 0);
  const learnings = loadLayeredLearnings({ workspace: ws, home }).learnings;
  assert.equal(learnings.length, 1);
  return { ws, home, learnings, id: learnings[0].id };
}

const operation = name => sha(name);

test('feedback config reads unknown or absent values as off and knowledge modes override it', t => {
  const c = seeded(t);
  assert.equal(readFeedbackConfig(c.ws, { home: c.home }), 'off');
  assert.equal(writeFeedbackConfig(c.ws, { home: c.home, feedback: 'maybe' }).pass, false);
  assert.equal(writeFeedbackConfig(c.ws, { home: c.home, feedback: 'suggest' }).pass, true);
  assert.equal(feedbackState({ workspace: c.ws, home: c.home }), 'suggest');
  for (const mode of ['freeze', 'capture-only', 'off']) {
    assert.equal(writeStoreConfig(c.ws, { home: c.home, mode }).pass, true);
    assert.equal(feedbackState({ workspace: c.ws, home: c.home }), 'off', mode);
  }
  assert.equal(readFeedbackConfig(c.ws, { home: c.home }), 'suggest', 'a mode switch keeps the feedback key');
  const config = path.join(storeDir(c.ws, { home: c.home }), 'config.json');
  fs.writeFileSync(config, JSON.stringify({ mode: 'on', feedback: 'loud' }));
  assert.equal(feedbackState({ workspace: c.ws, home: c.home }), 'off');
});

test('exposure records count deliveries, keep the newest entries under the cap and ignore unsafe IDs', t => {
  const c = seeded(t);
  recordExposure({ recordRoot: c.ws, workspace: c.ws, home: c.home, planPath: PLAN, delivered: [{ id: c.id }, { id: '../escape' }], now: new Date('2026-11-09T00:00:00Z') });
  const second = recordExposure({ recordRoot: c.ws, workspace: c.ws, home: c.home, planPath: PLAN, delivered: [{ id: c.id }], now: new Date('2026-11-09T01:00:00Z') });
  assert.deepEqual(second.entries.map(e => [e.id, e.count, e.firstExposedAt, e.lastExposedAt]), [[c.id, 2, '2026-11-09T00:00:00.000Z', '2026-11-09T01:00:00.000Z']]);
  assert.equal(second.entries[0].version, learningVersion(c.learnings[0]));
  const many = Array.from({ length: EXPOSURE_ENTRY_CAP + 6 }, (_, i) => ({ id: `logic/item-${String(i).padStart(3, '0')}` }));
  recordExposure({ recordRoot: c.ws, workspace: c.ws, home: c.home, planPath: PLAN, delivered: many, now: new Date('2026-11-09T02:00:00Z') });
  const capped = readExposure(c.ws, PLAN);
  assert.equal(capped.entries.length, EXPOSURE_ENTRY_CAP);
  assert.equal(capped.entries.some(e => e.id === c.id), false, 'the oldest entry is dropped first');
  assert.equal(readExposure(c.ws, 'docs/plans/other.md'), null);
});

test('recalled and findings validation rejects malformed, duplicate and unknown entries', t => {
  const c = seeded(t);
  recordExposure({ recordRoot: c.ws, workspace: c.ws, home: c.home, planPath: PLAN, delivered: [{ id: c.id }] });
  const check = extra => () => validateFeedbackFields({ operation: 'x', decision: 'no-learning', rationale: 'r', ...extra }, { recordRoot: c.ws, planPath: PLAN });
  assert.equal(check({})(), null);
  assert.throws(check({ recalled: [] }), /nonempty/);
  assert.throws(check({ recalled: [{ id: c.id, verdict: 'great' }] }), /verdict/);
  assert.throws(check({ recalled: [{ id: c.id, verdict: 'helped' }, { id: c.id, verdict: 'wrong' }] }), /more than once/);
  assert.throws(check({ recalled: [{ id: c.id, verdict: 'helped', extra: 1 }] }), /allow only/);
  assert.throws(check({ recalled: [{ id: c.id, verdict: 'helped', note: 'n'.repeat(281) }] }), /at most 280/);
  assert.throws(check({ findings: [{ id: 'e'.repeat(64), disposition: 'fixed' }] }), /no review record/);
  assert.throws(check({ findings: [{ id: 'e'.repeat(64), disposition: 'ignored' }] }), /disposition/);
  assert.deepEqual(check({ recalled: [{ id: c.id, verdict: 'wrong' }] })().recalled, [{ id: c.id, verdict: 'wrong', version: learningVersion(c.learnings[0]) }]);
});

test('consolidation output is byte-identical with feedback off and gains evidence under suggest and on', t => {
  const c = seeded(t);
  const version = learningVersion(c.learnings[0]);
  const baseStatus = JSON.stringify(consolidateStatus({ workspace: c.ws, home: c.home }));
  const basePacket = JSON.stringify(consolidateCandidates({ workspace: c.ws, home: c.home }));
  publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: operation('one'), planPath: PLAN, captureDate: '2026-11-09',
    feedback: { recalled: [{ id: c.id, verdict: 'wrong', version }], findings: [{ id: 'f'.repeat(64), disposition: 'fixed', reviewers: ['correctness'], observed: 'still-reported' }, { id: '1'.repeat(64), disposition: 'dismissed', reviewers: ['correctness'], observed: 'still-reported' }] } });
  publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: operation('two'), planPath: 'docs/plans/b.md', captureDate: '2026-11-09',
    feedback: { recalled: [{ id: c.id, verdict: 'helped', version }] } });

  assert.equal(JSON.stringify(consolidateStatus({ workspace: c.ws, home: c.home })), baseStatus, 'off: status unchanged');
  assert.equal(JSON.stringify(consolidateCandidates({ workspace: c.ws, home: c.home })), basePacket, 'off: packet unchanged');

  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'suggest' });
  const suggested = consolidateCandidates({ workspace: c.ws, home: c.home });
  assert.equal(suggested.feedback.state, 'suggest');
  assert.deepEqual(suggested.feedback.learnings, [{ id: c.id, helped: 1, irrelevant: 0, wrong: 1, plans: ['docs/plans/b.md', PLAN].sort() }]);
  assert.deepEqual(suggested.feedback.review_required, [c.id]);
  assert.deepEqual(suggested.feedback.reviewers, [{ reviewer: 'correctness', fixed: 1, dismissed: 1, contradicted: 1, resolutionRate: 0.5 }], 'a fixed claim the latest review still reports is counted as contradicted');
  const suggestStatus = consolidateStatus({ workspace: c.ws, home: c.home });
  assert.equal(suggestStatus.due, false, 'suggest never changes due');
  assert.deepEqual(suggestStatus.feedback.review_required, [c.id]);

  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'on' });
  const onStatus = consolidateStatus({ workspace: c.ws, home: c.home });
  assert.equal(onStatus.debt < onStatus.threshold, true);
  assert.equal(onStatus.due, true, 'on: an unresolved wrong verdict makes consolidation due below the debt threshold');
  assert.equal(learningVersion(loadLayeredLearnings({ workspace: c.ws, home: c.home }).learnings[0]), version, 'feedback never changes learning content or status');
});

test('a wrong verdict stops counting once the learning version changes', t => {
  const c = seeded(t);
  const summary = version => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-feedback-ver-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    publishFeedbackRecord({ workspace: c.ws, home: dir, operation: operation('v'), planPath: PLAN, captureDate: '2026-11-09', feedback: { recalled: [{ id: c.id, verdict: 'wrong', version }] } });
    return feedbackSummary({ workspace: c.ws, home: dir, learnings: c.learnings });
  };
  assert.deepEqual(summary(learningVersion(c.learnings[0])).review_required, [c.id]);
  assert.deepEqual(summary('0'.repeat(64)).review_required, []);
  assert.equal(summary('0'.repeat(64)).learnings[0].wrong, 1, 'the verdict stays visible as history');
});

test('feedback records are immutable per operation', t => {
  const c = seeded(t);
  const first = publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: operation('same'), planPath: PLAN, captureDate: '2026-11-09', feedback: { recalled: [{ id: c.id, verdict: 'helped' }] } });
  const second = publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: operation('same'), planPath: PLAN, captureDate: '2026-11-10', feedback: { recalled: [{ id: c.id, verdict: 'wrong' }] } });
  assert.equal(first.written, true);
  assert.equal(second.written, false);
  assert.equal(JSON.parse(fs.readFileSync(first.path, 'utf8')).recalled[0].verdict, 'helped');
});

test('feedback records cite the decision agent\'s latest readiness receipt for the plan', t => {
  const c = seeded(t);
  const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
  const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
  const workspace = fs.realpathSync.native(c.ws);
  const requests = {}, receipts = {};
  for (const [planPath, verdict, recordedAt] of [[PLAN, 'escalate', 1], [PLAN, 'ready', 2], ['docs/plans/other.md', 'ready', 3]]) {
    const packet = { schema: 1, type: 'readiness', planPath, nonce: recordedAt };
    const requestId = hash(packet);
    requests[requestId] = { ...packet, requestId, createdAt: recordedAt };
    const value = { schema: 1, requestId, type: 'readiness', verdict, authorized: verdict === 'ready', recordedAt, consumedAt: null };
    receipts[requestId] = { ...value, id: hash(value) };
  }
  fs.mkdirSync(path.join(c.home, 'decisions'), { recursive: true });
  fs.writeFileSync(path.join(c.home, 'decisions', `${hash(workspace)}.json`), JSON.stringify({ schema: 1, workspace, tasks: {}, requests, observations: {}, receipts }));
  const written = publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: operation('ready'), planPath: PLAN, captureDate: '2026-11-09', feedback: { recalled: [{ id: c.id, verdict: 'helped' }] } });
  const readiness = JSON.parse(fs.readFileSync(written.path, 'utf8')).readiness;
  assert.equal(readiness.verdict, 'ready');
  assert.equal(readiness.recordedAt, 2, 'the newest receipt for this plan, not another plan\'s');
  assert.match(readiness.id, /^[a-f0-9]{64}$/);
});

function addLearnings(t, c, slugs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-feedback-ops-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ops = slugs.map(slug => {
    const text = `---\ntitle: "${slug}"\nkind: fix\ndate: 2026-11-02\n---\n\nEvidence for ${slug}.\n`;
    fs.writeFileSync(path.join(c.ws, `docs/solutions/logic/${slug}.md`), text);
    return { op: 'ADD', domain: 'logic', slug, trigger: `working on ${slug}`, body: `Claim for ${slug}.`, episodes: [{ path: `docs/solutions/logic/${slug}.md`, sha256: sha(text), kind: 'fix', plan: `docs/plans/${slug}.md` }] };
  });
  fs.writeFileSync(path.join(dir, 'ops.json'), JSON.stringify({ schema: 1, ops }));
  assert.equal(applyOps({ workspace: c.ws, opsPath: path.join(dir, 'ops.json'), home: c.home }).exitCode, 0);
  return loadLayeredLearnings({ workspace: c.ws, home: c.home }).learnings;
}

const expose = (c, planPath, id, times) => {
  for (let i = 0; i < times; i++) recordExposure({ recordRoot: c.ws, workspace: c.ws, home: c.home, planPath, delivered: [{ id }], now: new Date(Date.UTC(2026, 10, 1, i)) });
};

test('exposure totals sum every plan record in the workspace and skip records whose plan does not match the file', t => {
  const c = seeded(t);
  expose(c, PLAN, c.id, 2);
  expose(c, 'docs/plans/other.md', c.id, 1);
  const forged = path.join(c.ws, '.harness/learning/exposures', `plan-${'0'.repeat(64)}.json`);
  fs.writeFileSync(forged, JSON.stringify({ version: 1, plan: 'docs/plans/forged.md', entries: [{ id: c.id, count: 50, lastExposedAt: '2027-01-01T00:00:00.000Z' }] }));
  assert.deepEqual(exposureTotals(c.ws).get(c.id), { exposed: 3, last_exposed: '2026-11-01T01:00:00.000Z' });
  assert.equal(exposureTotals(path.join(c.ws, 'missing')).size, 0);
});

test('doctor pruning hint: off reports nothing; 4 exposures no hint; 5 with zero helped hints; 5 with one helped does not', t => {
  const c = seeded(t);
  expose(c, PLAN, c.id, 3);
  expose(c, 'docs/plans/other.md', c.id, 2);
  assert.equal(feedbackPruningCheck({ workspace: c.ws, home: c.home }), null, 'off: no K8 check at all, so doctor output is unchanged');

  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'suggest' });
  const atFive = feedbackPruningCheck({ workspace: c.ws, home: c.home });
  assert.equal(atFive.id, 'K8');
  assert.equal(atFive.optional, true, 'advisory only');
  assert.equal(atFive.pass, false);
  assert.deepEqual(atFive.pruningCandidates, [c.id]);
  assert.match(atFive.hint, /exposed 5, helped 0/);

  const four = seeded(t);
  expose(four, PLAN, four.id, 4);
  writeFeedbackConfig(four.ws, { home: four.home, feedback: 'on' });
  const atFour = feedbackPruningCheck({ workspace: four.ws, home: four.home });
  assert.equal(atFour.pass, true);
  assert.equal(atFour.pruningCandidates, undefined);

  publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: operation('helped-once'), planPath: PLAN, captureDate: '2026-11-09', feedback: { recalled: [{ id: c.id, verdict: 'helped' }] } });
  assert.equal(feedbackPruningCheck({ workspace: c.ws, home: c.home }).pass, true, 'one helped verdict clears the hint');
  assert.equal(learningVersion(loadLayeredLearnings({ workspace: c.ws, home: c.home }).learnings[0]), learningVersion(c.learnings[0]), 'the hint never changes the learning');
});

test('packet ordering uses exposure and feedback only under on; off and suggest keep the existing order', t => {
  const c = seeded(t);
  const learnings = addLearnings(t, c, ['alpha', 'zeta']);
  const ids = learnings.map(l => l.id);
  const [alpha, zeta] = ['logic/alpha', 'logic/zeta'].map(id => learnings.find(l => l.id === id));
  assert.ok(alpha && zeta);
  const order = () => consolidateCandidates({ workspace: c.ws, home: c.home }).learnings.map(l => l.id);
  const base = order();
  assert.deepEqual([...base].sort(), [...ids].sort());

  expose(c, PLAN, zeta.id, 4);
  expose(c, PLAN, c.id, 1);
  publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: operation('stale-wrong'), planPath: PLAN, captureDate: '2026-11-09', feedback: { recalled: [{ id: alpha.id, verdict: 'wrong', version: '0'.repeat(64) }] } });
  assert.deepEqual(order(), base, 'off: order unchanged');
  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'suggest' });
  assert.deepEqual(order(), base, 'suggest: order unchanged');

  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'on' });
  assert.deepEqual(order(), [alpha.id, zeta.id, c.id], 'on: feedback-disputed first, then most exposed');

  publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: operation('current-wrong'), planPath: PLAN, captureDate: '2026-11-09', feedback: { recalled: [{ id: c.id, verdict: 'wrong', version: learningVersion(c.learnings[0]) }] } });
  assert.deepEqual(order(), [c.id, alpha.id, zeta.id], 'on: review_required stays first');
});
