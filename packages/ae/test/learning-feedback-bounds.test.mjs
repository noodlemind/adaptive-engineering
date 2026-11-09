import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { consolidateCandidates, consolidateStatus } from '../lib/knowledge/consolidate.mjs';
import { ensureStore, writeFeedbackConfig } from '../lib/knowledge/store.mjs';
import { loadLayeredLearnings } from '../lib/knowledge/overlay.mjs';
import { compactDecisions } from '../lib/decision-archive.mjs';
import { branchKeyFor } from '../lib/git-context.mjs';
import {
  feedbackSummary, learningVersion, planReviewFindings, publishFeedbackRecord, readExposure, readFeedbackRecords, recordExposure,
} from '../lib/learning-feedback.mjs';
import { initGit } from './helpers/cli-fixtures.mjs';

// Regression tests for the review findings on the phase 1a recall feedback loop.

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const PLAN = 'docs/plans/2026-11-09-feat-feedback-plan.md';

function seeded(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-feedback-bounds-')));
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
  return { dir, ws, home, learnings, id: learnings[0].id, version: learningVersion(learnings[0]) };
}

test('consolidate --status under suggest carries the verdict counts and reviewer rates', t => {
  const c = seeded(t);
  publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: sha('one'), planPath: PLAN, captureDate: '2026-11-09',
    feedback: { recalled: [{ id: c.id, verdict: 'helped', version: c.version }], findings: [{ id: 'f'.repeat(64), disposition: 'fixed', reviewers: ['correctness'], observed: 'no-longer-reported' }] } });
  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'suggest' });
  const packet = consolidateCandidates({ workspace: c.ws, home: c.home });
  const status = consolidateStatus({ workspace: c.ws, home: c.home });
  assert.deepEqual(status.feedback.learnings, packet.feedback.learnings);
  assert.deepEqual(status.feedback.reviewers, [{ reviewer: 'correctness', fixed: 1, dismissed: 0, contradicted: 0, resolutionRate: 1 }]);
});

test('feedback records namespace by plan and accepted digest so same-named operations from two worktrees both count', t => {
  const c = seeded(t);
  const publish = (digest, verdict) => publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: sha('shared'), digest, planPath: PLAN, captureDate: '2026-11-09', feedback: { recalled: [{ id: c.id, verdict, version: c.version }] } });
  const first = publish('a'.repeat(64), 'helped');
  const second = publish('b'.repeat(64), 'wrong');
  assert.equal(first.written, true);
  assert.equal(second.written, true, 'a different accepted decision under the same operation name is not dropped');
  assert.notEqual(first.path, second.path);
  assert.equal(readFeedbackRecords({ workspace: c.ws, home: c.home }).records.length, 2);
  assert.equal(publish('a'.repeat(64), 'wrong').written, false, 'the same accepted decision stays immutable');
});

test('review_required and due use the full feedback history, not a hash-ordered prefix', t => {
  const c = seeded(t);
  for (let i = 0; i < 520; i++) {
    publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: `0${sha(`filler-${i}`).slice(1)}`, planPath: PLAN, captureDate: '2026-11-09', feedback: { recalled: [{ id: c.id, verdict: 'helped', version: c.version }] } });
  }
  publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: 'f'.repeat(64), planPath: PLAN, captureDate: '2026-11-09', feedback: { recalled: [{ id: c.id, verdict: 'wrong', version: c.version }] } });
  const summary = feedbackSummary({ workspace: c.ws, home: c.home, learnings: c.learnings });
  assert.deepEqual(summary.review_required, [c.id]);
  assert.equal(summary.records, 521);
  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'on' });
  assert.equal(consolidateStatus({ workspace: c.ws, home: c.home }).due, true);
});

test('finding lookup filters review records by plan before any bound', t => {
  const c = seeded(t);
  const dir = path.join(c.ws, '.harness/reviews/records');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(dir, `0${sha(`other-${i}`).slice(1)}.json`), JSON.stringify({ version: 2, plan: 'docs/plans/other.md', findings: [] }));
  const finding = 'e'.repeat(64);
  fs.writeFileSync(path.join(dir, `${'f'.repeat(64)}.json`), JSON.stringify({ version: 2, plan: PLAN, findings: [{ id: finding, reviewers: ['correctness'] }] }));
  assert.deepEqual(planReviewFindings(c.ws, PLAN).get(finding), ['correctness']);
});

test('exposure carries the delivered layer\'s version when a protected golden and its branch twin share an ID', t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-feedback-layer-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'ws'), home = path.join(dir, 'home');
  fs.mkdirSync(ws);
  initGit(ws);
  const branch = spawnSync('git', ['-C', ws, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const { dir: store } = ensureStore(ws, { home });
  const learning = (root, body, fixes) => {
    fs.mkdirSync(path.join(root, 'learnings/sql'), { recursive: true });
    const episodes = Array.from({ length: fixes }, (_, i) => [`  - path: docs/solutions/sql/e${i}.md`, `    sha256: "${'a'.repeat(64)}"`, '    kind: fix', `    plan: docs/plans/p${i}.md`]).flat();
    fs.writeFileSync(path.join(root, 'learnings/sql/vital.md'), ['---', 'schema: 1', 'trigger: "vital trigger"', 'status: active', 'source: auto',
      fixes ? 'episodes:' : 'episodes: []', ...episodes, 'anchors: []', 'superseded_by: null', 'last_confirmed: null', 'origin: test', '---', '', body, ''].join('\n'));
  };
  learning(store, 'Golden protected version.', 3);
  const bucket = path.join(store, 'branches', branchKeyFor(branch));
  fs.mkdirSync(bucket, { recursive: true });
  fs.writeFileSync(path.join(bucket, 'meta.json'), `${JSON.stringify({ branchKey: branchKeyFor(branch), branch, promotable: true })}\n`);
  learning(bucket, 'Branch challenger version.', 0);
  const layered = loadLayeredLearnings({ workspace: ws, home }).learnings;
  const golden = layered.find(l => !l.layer), sub = layered.find(l => l.subordinate);
  assert.ok(golden && sub, 'fixture yields a protected golden and a subordinate branch twin');
  assert.notEqual(learningVersion(golden), learningVersion(sub));

  const goldenOnly = recordExposure({ recordRoot: ws, workspace: ws, home, planPath: PLAN, delivered: [{ id: 'sql/vital' }] });
  assert.equal(goldenOnly.entries[0].layer, 'golden');
  assert.equal(goldenOnly.entries[0].version, learningVersion(golden), 'only the golden was delivered, so its version is recorded');
  const branchOnly = recordExposure({ recordRoot: ws, workspace: ws, home, planPath: 'docs/plans/branch.md', delivered: [{ id: 'sql/vital', layer: 'branch', subordinate: true }] });
  assert.equal(branchOnly.entries[0].version, learningVersion(sub));
  const both = recordExposure({ recordRoot: ws, workspace: ws, home, planPath: 'docs/plans/both.md', delivered: [{ id: 'sql/vital' }, { id: 'sql/vital', layer: 'branch', subordinate: true }] });
  assert.equal(both.entries[0].version, learningVersion(golden), 'when both are delivered the authoritative golden version is recorded');
  assert.equal(both.entries[0].count, 1);
});

test('concurrent orientations for one plan do not lose exposure updates', async t => {
  const c = seeded(t);
  const module = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/learning-feedback.mjs');
  const script = `const { recordExposure } = await import(${JSON.stringify(module)});
const [ws, home, plan, prefix] = process.argv.slice(1);
for (let i = 0; i < 25; i++) recordExposure({ recordRoot: ws, workspace: ws, home, planPath: plan, delivered: [{ id: prefix + '/item-' + String(i).padStart(2, '0') }] });`;
  const run = prefix => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, c.ws, c.home, PLAN, prefix], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(err)));
  });
  await Promise.all([run('alpha'), run('beta')]);
  assert.equal(readExposure(c.ws, PLAN).entries.length, 50, 'every delivered ID from both writers is retained');
});

test('readiness receipts archived by decision compaction stay citable', t => {
  const c = seeded(t);
  const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
  const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
  const workspace = fs.realpathSync.native(c.ws);
  const requests = {}, receipts = {};
  for (const [verdict, recordedAt] of [['escalate', 1], ['blocked', 2]]) {
    const packet = { schema: 1, type: 'readiness', planPath: PLAN, nonce: recordedAt, padding: 'x'.repeat(300 * 1024) };
    const requestId = hash(packet);
    requests[requestId] = { ...packet, requestId, createdAt: recordedAt };
    const value = { schema: 1, requestId, type: 'readiness', verdict, authorized: false, recordedAt, consumedAt: null };
    receipts[requestId] = { ...value, id: hash(value) };
  }
  const state = { schema: 1, workspace, tasks: {}, requests, observations: {}, receipts, invocations: {}, nativeProbes: {} };
  compactDecisions({ home: c.home, workspace, now: 10 }, state);
  assert.equal(Object.keys(state.receipts).length, 0, 'terminal readiness receipts left live state');
  fs.mkdirSync(path.join(c.home, 'decisions'), { recursive: true });
  fs.writeFileSync(path.join(c.home, 'decisions', `${hash(workspace)}.json`), JSON.stringify(state));
  const written = publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: sha('archived'), planPath: PLAN, captureDate: '2026-11-09', feedback: { recalled: [{ id: c.id, verdict: 'helped' }] } });
  const readiness = JSON.parse(fs.readFileSync(written.path, 'utf8')).readiness;
  assert.equal(readiness?.verdict, 'blocked');
  assert.equal(readiness.recordedAt, 2);
});
