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
  EXPOSURE_ENTRY_CAP, exposureRel, exposureTotals, feedbackState, feedbackSummary, learningVersion, publishFeedbackRecord, readExposure, recordExposure, validateFeedbackFields,
} from '../lib/learning-feedback.mjs';
import { feedbackPruningCheck } from '../lib/doctor.mjs';
import { publishReviewRecord, recordHash } from '../lib/review.mjs';
import { projectStoreDir } from '../lib/project-layout.mjs';
import { ensureStore } from '../lib/knowledge/store.mjs';
import { knowledgeFeedbackStatus } from '../lib/knowledge/status.mjs';
import { branchKeyFor } from '../lib/git-context.mjs';
import { spawnSync } from 'node:child_process';
import { initGit } from './helpers/cli-fixtures.mjs';
import { loadLayeredLearnings } from '../lib/knowledge/overlay.mjs';
import { learningRendered } from '../lib/context-pack.mjs';

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
  const suggestStatus = consolidateStatus({ workspace: c.ws, home: c.home, withFeedback: true });
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

// Deliver the learning object the way orient does, so the exposure carries its layer.
const expose = (c, planPath, id, times) => {
  const learning = loadLayeredLearnings({ workspace: c.ws, home: c.home }).learnings.find(l => l.id === id && !l.subordinate) || { id };
  for (let i = 0; i < times; i++) recordExposure({ recordRoot: c.ws, workspace: c.ws, home: c.home, planPath, delivered: [learning], now: new Date(Date.UTC(2026, 10, 1, i)) });
};

test('exposure totals sum every plan record in the workspace and skip records whose plan does not match the file', t => {
  const c = seeded(t);
  expose(c, PLAN, c.id, 2);
  expose(c, 'docs/plans/other.md', c.id, 1);
  const forged = path.join(c.ws, '.harness/learning/exposures', `plan-${'0'.repeat(64)}.json`);
  fs.writeFileSync(forged, JSON.stringify({ version: 1, plan: 'docs/plans/forged.md', entries: [{ id: c.id, count: 50, lastExposedAt: '2027-01-01T00:00:00.000Z' }] }));
  const layer = c.learnings[0].layer === 'branch' ? 'branch' : 'golden';
  assert.deepEqual(exposureTotals(c.ws).get(c.id), { exposed: 3, last_exposed: '2026-11-01T01:00:00.000Z', layers: { [layer]: { exposed: 3, last_exposed: '2026-11-01T01:00:00.000Z' } } });
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

// Independent review regressions (PR #123).

test('review 1: verdicts beyond the 512-record display scan still count, so K8 never hints on a learning that helped', t => {
  const c = seeded(t);
  expose(c, PLAN, c.id, 5);
  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'suggest' });
  publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: 'f'.repeat(64), planPath: PLAN, captureDate: '2026-11-09', feedback: { recalled: [{ id: c.id, verdict: 'helped' }] } });
  const base = projectStoreDir(c.ws, { home: c.home });
  for (let i = 0; i < 512; i++) {
    const op = '0' + sha(`op-${i}`).slice(1);
    fs.writeFileSync(path.join(base, 'feedback', `${op}.json`), JSON.stringify({ version: 1, operation: op, plan: `docs/plans/o${i}.md`, recalled: [{ id: 'logic/other', verdict: 'irrelevant' }] }));
  }
  const k8 = feedbackPruningCheck({ workspace: c.ws, home: c.home });
  assert.equal(k8.pass, true, 'the helped verdict sorted past the scan cap still clears the hint');
  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'on' });
  publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: 'e'.repeat(64), planPath: PLAN, captureDate: '2026-11-09', feedback: { recalled: [{ id: c.id, verdict: 'wrong', version: '0'.repeat(64) }] } });
  assert.equal(knowledgeFeedbackStatus({ workspace: c.ws, home: c.home }).learnings[0].wrong, 1, 'a wrong verdict past the cap still reaches status and ordering');
});

test('review 2: every exposure record is read, so no plan vanishes past 512 records', t => {
  const c = seeded(t);
  let target = null;
  for (let i = 0; !target; i++) { const p = `docs/plans/t${i}.md`; if (recordHash(p).startsWith('ff')) target = p; }
  expose(c, target, c.id, 6);
  let n = 0;
  for (let i = 0; n < 512; i++) {
    const p = `docs/plans/x${i}.md`;
    if (recordHash(p) >= recordHash(target)) continue;
    publishReviewRecord(c.ws, `.harness/learning/exposures/plan-${recordHash(p)}.json`, { version: 1, plan: p, entries: [{ id: 'logic/other', count: 1, lastExposedAt: '2026-11-01T00:00:00.000Z' }] });
    n++;
  }
  assert.equal(exposureTotals(c.ws).get(c.id).exposed, 6);
});

test('review 3: a protected golden learning and its branch twin give one status row and one K8 candidate, and exposure stays in its layer', t => {
  const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-twin-ws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-twin-home-'));
  t.after(() => { fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
  git(ws, ['init', '-q', '-b', 'feature/x']); git(ws, ['config', 'user.email', 'a@b.c']); git(ws, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(ws, 'seed.txt'), 's\n'); git(ws, ['add', '.']); git(ws, ['commit', '-qm', 's']);
  const head = git(ws, ['rev-parse', 'HEAD']).stdout.trim();
  const { dir } = ensureStore(ws, { home });
  const write = (root, source) => {
    fs.mkdirSync(path.join(root, 'learnings', 'sql'), { recursive: true });
    fs.writeFileSync(path.join(root, 'learnings', 'sql', 'dup.md'), `---\nschema: 1\ntrigger: "t dup"\nstatus: active\nsource: ${source}\nepisodes:\nanchors: []\nsuperseded_by: null\nlast_confirmed: null\norigin: test\n---\n\nBody ${source}.\n`);
  };
  write(dir, 'human');
  const key = branchKeyFor('feature/x');
  const bucket = path.join(dir, 'branches', key);
  fs.mkdirSync(path.join(bucket, 'learnings'), { recursive: true });
  fs.writeFileSync(path.join(bucket, 'meta.json'), JSON.stringify({ branch: 'feature/x', branchKey: key, baseSha: head, createdAt: new Date().toISOString(), promotable: true }));
  write(bucket, 'auto');
  const layered = loadLayeredLearnings({ workspace: ws, home }).learnings;
  assert.deepEqual(layered.map(l => Boolean(l.subordinate)), [false, true], 'precondition: golden plus subordinate twin');
  // Orient passes both twins; one pack delivers the ID once, credited to the golden layer.
  for (let i = 0; i < 5; i++) recordExposure({ recordRoot: ws, workspace: ws, home, planPath: 'docs/plans/p.md', delivered: layered });
  assert.deepEqual(exposureTotals(ws).get('sql/dup').layers, { golden: { exposed: 5, last_exposed: exposureTotals(ws).get('sql/dup').last_exposed } });
  writeFeedbackConfig(ws, { home, feedback: 'suggest' });
  const status = knowledgeFeedbackStatus({ workspace: ws, home });
  assert.deepEqual(status.learnings.map(r => [r.id, r.exposed]), [['sql/dup', 5]]);
  assert.deepEqual(feedbackPruningCheck({ workspace: ws, home }).pruningCandidates, ['sql/dup']);
  // Branch-layer exposure is not credited to the golden learning.
  publishReviewRecord(ws, `.harness/learning/exposures/plan-${recordHash('docs/plans/q.md')}.json`, { version: 1, plan: 'docs/plans/q.md', entries: [{ id: 'sql/dup', layer: 'branch', count: 9, lastExposedAt: '2026-11-01T00:00:00.000Z' }] });
  assert.equal(knowledgeFeedbackStatus({ workspace: ws, home }).learnings[0].exposed, 5);
});

// Second review pass regressions (PR #123).

function twins(t) {
  const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-twin2-ws-')));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-twin2-home-'));
  t.after(() => { fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
  git(ws, ['init', '-q', '-b', 'feature/x']); git(ws, ['config', 'user.email', 'a@b.c']); git(ws, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(ws, 'seed.txt'), 's\n'); git(ws, ['add', '.']); git(ws, ['commit', '-qm', 's']);
  const head = git(ws, ['rev-parse', 'HEAD']).stdout.trim();
  const { dir } = ensureStore(ws, { home });
  const write = (root, source) => {
    fs.mkdirSync(path.join(root, 'learnings', 'sql'), { recursive: true });
    fs.writeFileSync(path.join(root, 'learnings', 'sql', 'dup.md'), `---\nschema: 1\ntrigger: "t dup"\nstatus: active\nsource: ${source}\nepisodes:\nanchors: []\nsuperseded_by: null\nlast_confirmed: null\norigin: test\n---\n\nBody ${source}.\n`);
  };
  write(dir, 'human');
  const key = branchKeyFor('feature/x');
  const bucket = path.join(dir, 'branches', key);
  fs.mkdirSync(path.join(bucket, 'learnings'), { recursive: true });
  fs.writeFileSync(path.join(bucket, 'meta.json'), JSON.stringify({ branch: 'feature/x', branchKey: key, baseSha: head, createdAt: new Date().toISOString(), promotable: true }));
  write(bucket, 'auto');
  const [golden, twin] = loadLayeredLearnings({ workspace: ws, home }).learnings;
  assert.equal(Boolean(twin?.subordinate), true, 'precondition: golden plus subordinate twin');
  return { ws, home, golden, twin };
}

test('second pass 1: exposure is kept per layer, so a twin-only delivery does not move the golden count', t => {
  const c = twins(t);
  for (let i = 0; i < 5; i++) recordExposure({ recordRoot: c.ws, workspace: c.ws, home: c.home, planPath: PLAN, delivered: [c.golden, c.twin] });
  recordExposure({ recordRoot: c.ws, workspace: c.ws, home: c.home, planPath: PLAN, delivered: [c.twin] });
  const layers = exposureTotals(c.ws).get('sql/dup').layers;
  assert.deepEqual([layers.golden.exposed, layers.branch.exposed], [5, 1]);
  assert.deepEqual(readExposure(c.ws, PLAN).entries.map(e => [e.id, e.layer, e.count]), [['sql/dup', 'branch', 1], ['sql/dup', 'golden', 5]]);
  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'suggest' });
  assert.deepEqual(knowledgeFeedbackStatus({ workspace: c.ws, home: c.home }).learnings.map(r => [r.id, r.exposed]), [['sql/dup', 5]]);
  assert.deepEqual(feedbackPruningCheck({ workspace: c.ws, home: c.home }).pruningCandidates, ['sql/dup']);
  // An older entry without per-layer keying still reads as its single layer.
  publishReviewRecord(c.ws, `.harness/learning/exposures/plan-${recordHash('docs/plans/old.md')}.json`, { version: 1, plan: 'docs/plans/old.md', entries: [{ id: 'sql/dup', count: 2, lastExposedAt: '2026-11-01T00:00:00.000Z' }] });
  assert.equal(exposureTotals(c.ws).get('sql/dup').layers.golden.exposed, 7);
});

test('second pass 2: the golden entry carries the golden version, so a wrong verdict on it reaches review_required', t => {
  const c = twins(t);
  recordExposure({ recordRoot: c.ws, workspace: c.ws, home: c.home, planPath: PLAN, delivered: [c.golden, c.twin] });
  const entry = readExposure(c.ws, PLAN).entries.find(e => e.layer === 'golden');
  assert.equal(entry.version, learningVersion(c.golden));
  assert.notEqual(entry.version, learningVersion(c.twin));
  const fields = validateFeedbackFields({ operation: 'x', decision: 'no-learning', rationale: 'r', recalled: [{ id: 'sql/dup', verdict: 'wrong' }] }, { recordRoot: c.ws, planPath: PLAN });
  publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: operation('golden-wrong'), planPath: PLAN, captureDate: '2026-11-09', feedback: fields });
  assert.deepEqual(feedbackSummary({ workspace: c.ws, home: c.home, learnings: [c.golden] }).review_required, ['sql/dup']);
});

test('second pass 3: review_required reads the full feedback history, not the first 512 records', t => {
  const c = seeded(t);
  const base = projectStoreDir(c.ws, { home: c.home });
  publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: 'f'.repeat(64), planPath: PLAN, captureDate: '2026-11-09', feedback: { recalled: [{ id: c.id, verdict: 'wrong', version: learningVersion(c.learnings[0]) }] } });
  for (let i = 0; i < 512; i++) {
    const op = '0' + sha(`op-${i}`).slice(1);
    fs.writeFileSync(path.join(base, 'feedback', `${op}.json`), JSON.stringify({ version: 1, operation: op, plan: `docs/plans/o${i}.md`, recalled: [{ id: 'logic/other', verdict: 'irrelevant' }] }));
  }
  assert.deepEqual(feedbackSummary({ workspace: c.ws, home: c.home, learnings: c.learnings }).review_required, [c.id]);
  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'on' });
  assert.equal(consolidateStatus({ workspace: c.ws, home: c.home }).due, true);
});

test('second pass 4: an exposure file above the 32 KiB record cap is skipped', t => {
  const c = seeded(t);
  const plan = 'docs/plans/big.md';
  const filler = Array.from({ length: 400 }, (_, i) => ({ id: `logic/filler-${String(i).padStart(4, '0')}-${'x'.repeat(40)}`, count: 1, lastExposedAt: '2026-11-01T00:00:00.000Z' }));
  publishReviewRecord(c.ws, `.harness/learning/exposures/plan-${recordHash(plan)}.json`, { version: 1, plan, entries: [{ id: c.id, count: 9, lastExposedAt: '2026-11-01T00:00:00.000Z' }, ...filler] });
  assert.ok(fs.statSync(path.join(c.ws, `.harness/learning/exposures/plan-${recordHash(plan)}.json`)).size > 32 * 1024);
  assert.equal(exposureTotals(c.ws).get(c.id), undefined);
});

test('second pass 6: delivery detection matches the layer mark, so a twin-only line does not credit the golden', () => {
  const golden = { id: 'sql/dup' };
  const twin = { id: 'sql/dup', layer: 'branch', subordinate: true };
  const twinOnly = '## Learnings (memory)\n- [sql/dup] [branch-local, subordinate] t → c\n';
  assert.equal(learningRendered(twinOnly, golden), false);
  assert.equal(learningRendered(twinOnly, twin), true);
  const goldenOnly = '## Learnings (memory)\n- [sql/dup] [applicability: current; source bindings only] t → c\n';
  assert.equal(learningRendered(goldenOnly, golden), true);
  assert.equal(learningRendered(goldenOnly, twin), false);
});

// Third review pass regressions (PR #123).

test('third pass A: a retired protected golden does not hide its active branch twin from status or K8', t => {
  const c = twins(t);
  const goldenFile = path.join(storeDir(c.ws, { home: c.home }), 'learnings', 'sql', 'dup.md');
  fs.writeFileSync(goldenFile, fs.readFileSync(goldenFile, 'utf8').replace('status: active', 'status: retired'));
  const layered = loadLayeredLearnings({ workspace: c.ws, home: c.home }).learnings;
  assert.deepEqual(layered.map(l => [l.fm.status, Boolean(l.subordinate)]), [['retired', false], ['active', true]], 'precondition: retired golden plus active subordinate twin');
  const twin = layered[1];
  for (let i = 0; i < 5; i++) recordExposure({ recordRoot: c.ws, workspace: c.ws, home: c.home, planPath: PLAN, delivered: [twin] });
  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'suggest' });
  assert.deepEqual(knowledgeFeedbackStatus({ workspace: c.ws, home: c.home }).learnings.map(r => [r.id, r.exposed]), [['sql/dup', 5]], 'the active twin keeps its status row');
  assert.deepEqual(feedbackPruningCheck({ workspace: c.ws, home: c.home }).pruningCandidates, ['sql/dup'], 'and its K8 candidacy');
});

test('fifth pass K8: branch-layer candidates get branch guidance, never the golden-only --why and retire commands', t => {
  // A branch learning that shadows an unprotected golden with the same ID.
  const c = twins(t);
  const dir = storeDir(c.ws, { home: c.home });
  const goldenFile = path.join(dir, 'learnings', 'sql', 'dup.md');
  fs.writeFileSync(goldenFile, fs.readFileSync(goldenFile, 'utf8').replace('source: human', 'source: auto'));
  // And a learning that exists only on the branch.
  const bucket = path.join(dir, 'branches', branchKeyFor('feature/x'));
  const branchOnly = path.join(bucket, 'learnings', 'sql', 'only.md');
  fs.writeFileSync(branchOnly, fs.readFileSync(path.join(bucket, 'learnings', 'sql', 'dup.md'), 'utf8').replace('t dup', 't only'));
  const layered = loadLayeredLearnings({ workspace: c.ws, home: c.home }).learnings;
  assert.deepEqual(layered.map(l => [l.id, l.layer, Boolean(l.subordinate)]), [['sql/dup', 'branch', false], ['sql/only', 'branch', false]], 'precondition: a shadowing branch learning and a branch-only one');
  for (let i = 0; i < 5; i++) recordExposure({ recordRoot: c.ws, workspace: c.ws, home: c.home, planPath: PLAN, delivered: layered });
  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'suggest' });
  const k8 = feedbackPruningCheck({ workspace: c.ws, home: c.home });
  assert.equal(k8.pass, false);
  assert.deepEqual(k8.pruningCandidates, ['sql/dup', 'sql/only']);
  assert.deepEqual(k8.branchPruningCandidates, ['sql/dup', 'sql/only']);
  assert.doesNotMatch(k8.hint, /review with ae learnings --why <id>|retire only through ae learning retire/, 'no golden-only command is recommended for a branch candidate');
  assert.match(k8.hint, /^branch-layer pruning hint, advisory only: /);
  const rel = file => path.relative(dir, file).split(path.sep).join('/');
  assert.ok(k8.hint.includes(`sql/dup (exposed 5, helped 0) at ${rel(path.join(bucket, 'learnings', 'sql', 'dup.md'))}`), 'the shadowing candidate points at its branch file, not the golden');
  assert.ok(k8.hint.includes(`sql/only (exposed 5, helped 0) at ${rel(branchOnly)}`));
  assert.match(k8.hint, /act only on golden learnings/);
  // A golden candidate alongside keeps the golden guidance, for it alone.
  fs.mkdirSync(path.join(dir, 'learnings', 'logic'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'learnings', 'logic', 'gold.md'), fs.readFileSync(goldenFile, 'utf8').replace('t dup', 't gold'));
  const gold = loadLayeredLearnings({ workspace: c.ws, home: c.home }).learnings.find(l => l.id === 'logic/gold');
  assert.equal(gold.layer === 'branch', false);
  for (let i = 0; i < 6; i++) recordExposure({ recordRoot: c.ws, workspace: c.ws, home: c.home, planPath: PLAN, delivered: [gold] });
  const mixed = feedbackPruningCheck({ workspace: c.ws, home: c.home });
  assert.deepEqual(mixed.branchPruningCandidates, ['sql/dup', 'sql/only']);
  const [goldenHint, branchHint] = mixed.hint.split('; branch-layer ');
  assert.equal(goldenHint, 'pruning hint, advisory only: logic/gold (exposed 6, helped 0) — review with ae learnings --why <id>; retire only through ae learning retire');
  assert.doesNotMatch(branchHint, /logic\/gold/);
});

test('third pass D: a twin line truncated after the layer mark opens does not credit the golden', () => {
  const golden = { id: 'sql/dup' };
  const pack = line => `# Harness Context Pack\n\n## Learnings (memory)\n${line}`;
  assert.equal(learningRendered(pack('- [sql/dup] [b'), golden), false);
  assert.equal(learningRendered(pack('- [sql/dup] [branch-local, sub'), golden), false);
  assert.equal(learningRendered(pack('- [sql/dup] [unverified memory — advisory] t → c\n'), golden), true, 'a golden fence is not a twin mark');
});

test('fourth pass 1: a golden trigger starting with [b is credited; a twin line cut to "- [id] " or "- [id] [" is not', () => {
  const golden = { id: 'sql/dup' };
  const pack = line => `# Harness Context Pack\n\n## Learnings (memory)\n${line}`;
  assert.equal(learningRendered(pack('- [sql/dup] [bugfix] retry the lock → take it in order\n'), golden), true, 'a [bugfix] trigger is the golden line');
  for (const cut of ['- [sql/dup] ', '- [sql/dup] [']) {
    assert.equal(learningRendered(pack(cut), golden), false, `${JSON.stringify(cut)} at end of text`);
    assert.equal(learningRendered(pack(`${cut}\n\n…(truncated to 2KB budget)\n`), golden), false, `${JSON.stringify(cut)} at end of line`);
  }
  assert.equal(learningRendered(pack('- [sql/dup] [branch-local, subordinate] t → c\n'), golden), false);
});

test('fourth pass 3: delivery is matched at line starts inside the learnings section only', () => {
  const golden = { id: 'sql/dup' };
  assert.equal(learningRendered('## Intent\n- [sql/dup] t → c\n', golden), false, 'outside the learnings section');
  assert.equal(learningRendered('## Learnings (memory)\nRetrieved learnings: x - [sql/dup] t\n', golden), false, 'not at a line start');
  assert.equal(learningRendered('## Learnings (memory)\n- [other] t\n## Next tools\n- [sql/dup] t\n', golden), false, 'after the section ends');
  assert.equal(learningRendered('## Learnings (memory)\n- [other] t\n- [sql/dup] t → c\n## Next tools\n', golden), true);
});

test('fourth pass 4: malformed prior exposure entries are dropped on the next merge', t => {
  const c = seeded(t);
  publishReviewRecord(c.ws, exposureRel(PLAN), { version: 1, plan: PLAN, entries: [
    { id: 'logic/bad-count', count: '9', lastExposedAt: '2026-11-01T00:00:00.000Z' },
    { id: 'logic/bad-time', count: 2, lastExposedAt: 7 },
    { id: 7, count: 1, lastExposedAt: '2026-11-01T00:00:00.000Z' },
    { id: 'logic/good', count: 2, lastExposedAt: '2026-11-01T00:00:00.000Z' },
  ] });
  recordExposure({ recordRoot: c.ws, workspace: c.ws, home: c.home, planPath: PLAN, delivered: [c.learnings[0]], now: new Date(Date.UTC(2026, 10, 2)) });
  assert.deepEqual(readExposure(c.ws, PLAN).entries.map(e => [e.id, e.count]).sort(), [[c.id, 1], ['logic/good', 2]].sort());
});

test('fifth pass 3: hand-edited exposure counts saturate at a safe integer and only strict ISO times order last_exposed', t => {
  const c = seeded(t);
  const write = (plan, entries) => publishReviewRecord(c.ws, exposureRel(plan), { version: 1, plan, entries });
  write('docs/plans/a.md', [{ id: c.id, count: 1e308, lastExposedAt: '2026-11-01T00:00:00.000Z' }, { id: 'logic/safe', count: Number.MAX_SAFE_INTEGER, lastExposedAt: '2026-11-01T00:00:00.000Z' }]);
  write('docs/plans/b.md', [{ id: c.id, count: 1e308, lastExposedAt: 'zzzz' }, { id: 'logic/safe', count: Number.MAX_SAFE_INTEGER, lastExposedAt: '2026-11-03T00:00:00.000Z' }]);
  write('docs/plans/c.md', [{ id: c.id, count: 2, lastExposedAt: '2026-11-02T00:00:00.000Z' }, { id: 'logic/safe', count: 3, lastExposedAt: '2026-11-02T00:00:00Z' }]);
  const totals = exposureTotals(c.ws);
  assert.equal(totals.get(c.id).exposed, 2, 'counts beyond the safe integer range are not accepted');
  assert.equal(totals.get(c.id).last_exposed, '2026-11-02T00:00:00.000Z', 'a non-ISO time never beats a real one');
  const safe = totals.get('logic/safe');
  assert.equal(safe.exposed, Number.MAX_SAFE_INTEGER, 'the sum saturates instead of overflowing');
  assert.equal(safe.layers.golden.exposed, Number.MAX_SAFE_INTEGER);
  assert.equal(safe.last_exposed, '2026-11-03T00:00:00.000Z');
  assert.ok(Number.isFinite(JSON.parse(JSON.stringify({ exposed: safe.exposed })).exposed));
  // A merge drops an out-of-range prior count and saturates a maximal one.
  write(PLAN, [{ id: 'logic/huge', count: 1e308, lastExposedAt: '2026-11-01T00:00:00.000Z' }, { id: c.id, count: Number.MAX_SAFE_INTEGER, lastExposedAt: '2026-11-01T00:00:00.000Z' }]);
  recordExposure({ recordRoot: c.ws, workspace: c.ws, home: c.home, planPath: PLAN, delivered: [c.learnings[0]], now: new Date(Date.UTC(2026, 10, 2)) });
  const merged = readExposure(c.ws, PLAN).entries;
  assert.equal(merged.some(e => e.id === 'logic/huge'), false);
  assert.ok(merged.filter(e => e.id === c.id).every(e => e.count <= Number.MAX_SAFE_INTEGER));
});

test('third pass E: an exposure record of 32 KiB plus its trailing newline is still read', t => {
  const c = seeded(t);
  const plan = 'docs/plans/edge.md';
  const rel = `.harness/learning/exposures/plan-${recordHash(plan)}.json`;
  const entries = [{ id: c.id, count: 3, lastExposedAt: '2026-11-01T00:00:00.000Z' }];
  const text = () => `${JSON.stringify({ version: 1, plan, entries }, null, 2)}\n`;
  for (let i = 0; Buffer.byteLength(text()) < 32 * 1024 + 1 - 400; i++) entries.push({ id: `logic/f-${String(i).padStart(4, '0')}`, count: 1, lastExposedAt: '2026-11-01T00:00:00.000Z' });
  const last = entries.at(-1);
  while (Buffer.byteLength(text()) < 32 * 1024 + 1) last.id += 'x';
  assert.equal(Buffer.byteLength(text()), 32 * 1024 + 1, 'precondition: a file one byte over the cap, as earlier writers produced');
  fs.mkdirSync(path.dirname(path.join(c.ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(c.ws, rel), text());
  assert.equal(exposureTotals(c.ws).get(c.id).exposed, 3);
});

test('third pass F: the K8 candidate list is capped at 20 with a count of the rest', t => {
  const c = seeded(t);
  for (let i = 0; i < 24; i++) {
    fs.writeFileSync(path.join(path.dirname(c.learnings[0].file), `cap-${String(i).padStart(2, '0')}.md`),
      `---\nschema: 1\ntrigger: "t cap ${i}"\nstatus: active\nsource: auto\nepisodes:\nanchors: []\nsuperseded_by: null\nlast_confirmed: null\norigin: test\n---\n\nBody ${i}.\n`);
  }
  const learnings = loadLayeredLearnings({ workspace: c.ws, home: c.home }).learnings;
  assert.equal(learnings.length, 25);
  publishReviewRecord(c.ws, exposureRel(PLAN), { version: 1, plan: PLAN, entries: learnings.map(l => ({ id: l.id, layer: l.layer === 'branch' ? 'branch' : 'golden', count: 5, lastExposedAt: '2026-11-01T00:00:00.000Z' })) });
  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'suggest' });
  const k8 = feedbackPruningCheck({ workspace: c.ws, home: c.home });
  assert.equal(k8.pruningCandidates.length, 20);
  assert.equal(k8.omittedPruningCandidates, 5);
  assert.match(k8.hint, /and 20 more/);
});

test('third pass J: an existing feedback record over the read limit reports written:false instead of throwing', t => {
  const c = seeded(t);
  const op = operation('oversized');
  const file = path.join(projectStoreDir(c.ws, { home: c.home }), 'feedback', `${op}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, operation: op, plan: PLAN, note: 'x'.repeat(300 * 1024) }));
  const result = publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: op, planPath: PLAN, captureDate: '2026-11-09', feedback: { recalled: [{ id: c.id, verdict: 'helped' }] } });
  assert.deepEqual(result, { path: file, written: false });
  assert.ok(fs.statSync(file).size > 256 * 1024, 'the hand-made file is left as it is');
});
