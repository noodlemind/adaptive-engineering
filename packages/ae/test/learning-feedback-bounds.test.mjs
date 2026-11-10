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
import { compactDecisions, hydrateArchivedDecision, latestArchivedReadiness, readinessIndexHealth } from '../lib/decision-archive.mjs';
import { decisionStatus, latestReadinessReceipt, prepareDecision } from '../lib/decision-agent.mjs';
import { runOrient } from '../lib/orient.mjs';
import { branchKeyFor } from '../lib/git-context.mjs';
import {
  acceptedFeedbackRecord, exposureRel, feedbackSummary, learningVersion, planReviewFindings, publishFeedbackRecord, readExposure, readFeedbackRecords, recordExposure, validateFeedbackFields,
} from '../lib/learning-feedback.mjs';
import { projectStoreDir } from '../lib/project-layout.mjs';
import { recordHash } from '../lib/review.mjs';
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
  const status = consolidateStatus({ workspace: c.ws, home: c.home, withFeedback: true });
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

/** Run fn while counting readdir calls on the project feedback directory and bytes read from disk. */
function observed(c, fn) {
  const feedbackDir = path.join(projectStoreDir(c.ws, { home: c.home }), 'feedback');
  const { readdirSync, readSync } = fs;
  let scans = 0, bytes = 0;
  fs.readdirSync = (dir, ...rest) => { if (path.resolve(String(dir)) === feedbackDir) scans += 1; return readdirSync(dir, ...rest); };
  fs.readSync = (...args) => { const n = readSync(...args); bytes += n; return n; };
  try { return { value: fn(), scans: () => scans, bytes: () => bytes }; } finally { fs.readdirSync = readdirSync; fs.readSync = readSync; }
}

test('a record accepted before digest keys stays the accepted record and is counted once', t => {
  const c = seeded(t);
  const operation = sha('legacy-op'), digest = 'c'.repeat(64);
  const feedback = { recalled: [{ id: c.id, verdict: 'helped', version: c.version }] };
  const legacy = publishFeedbackRecord({ workspace: c.ws, home: c.home, operation, planPath: PLAN, captureDate: '2026-11-08', feedback });
  assert.equal(path.basename(legacy.path), `${operation}.json`);
  const replay = publishFeedbackRecord({ workspace: c.ws, home: c.home, operation, digest, planPath: PLAN, captureDate: '2026-11-09', feedback });
  assert.deepEqual(replay, { path: legacy.path, written: false }, 'the replay reuses the legacy record');
  assert.equal(acceptedFeedbackRecord({ workspace: c.ws, home: c.home, operation, digest, planPath: PLAN, feedback: { recalled: [{ id: c.id, verdict: 'helped' }] } }), legacy.path);
  // A keyed duplicate of the same decision, written before this fix, is not counted twice.
  const keyed = path.join(path.dirname(legacy.path), `${recordHash({ operation, plan: PLAN, digest })}.json`);
  fs.writeFileSync(keyed, `${JSON.stringify({ version: 1, operation, digest, plan: PLAN, captureDate: '2026-11-09', ...feedback }, null, 2)}\n`);
  assert.equal(readFeedbackRecords({ workspace: c.ws, home: c.home }).records.length, 1);
  assert.equal(feedbackSummary({ workspace: c.ws, home: c.home, learnings: c.learnings }).learnings[0].helped, 1);
  const otherPlan = publishFeedbackRecord({ workspace: c.ws, home: c.home, operation, digest, planPath: 'docs/plans/other.md', captureDate: '2026-11-09', feedback });
  assert.equal(otherPlan.written, true, 'a legacy record of another plan is not this decision');
  // A different decision under the same operation and plan is its own record and counts.
  const different = { recalled: [{ id: c.id, verdict: 'wrong', version: c.version }] };
  assert.equal(acceptedFeedbackRecord({ workspace: c.ws, home: c.home, operation, digest: 'd'.repeat(64), planPath: PLAN, feedback: { recalled: [{ id: c.id, verdict: 'wrong' }] } }), null);
  const second = publishFeedbackRecord({ workspace: c.ws, home: c.home, operation, digest: 'd'.repeat(64), planPath: PLAN, captureDate: '2026-11-10', feedback: different });
  assert.equal(second.written, true);
  const summary = feedbackSummary({ workspace: c.ws, home: c.home, learnings: c.learnings });
  assert.deepEqual([summary.learnings[0].helped, summary.learnings[0].wrong], [2, 1], 'legacy, other-plan and different-decision records each count once');
});

test('escaped notes that would exceed the feedback record limit are refused before acceptance', t => {
  const c = seeded(t);
  const ids = Array.from({ length: 64 }, (_, i) => `logic/item-${String(i).padStart(2, '0')}`);
  recordExposure({ recordRoot: c.ws, workspace: c.ws, home: c.home, planPath: PLAN, delivered: ids.map(id => ({ id })) });
  const findings = Array.from({ length: 128 }, (_, i) => ({ id: sha(`finding-${i}`), reviewers: ['correctness'] }));
  fs.mkdirSync(path.join(c.ws, '.harness/reviews/records'), { recursive: true });
  fs.writeFileSync(path.join(c.ws, '.harness/reviews/records', `${'a'.repeat(64)}.json`), JSON.stringify({ version: 2, plan: PLAN, findings }));
  const note = '\u0001'.repeat(280);
  const decision = { operation: 'x', decision: 'no-learning', rationale: 'r', recalled: ids.map(id => ({ id, verdict: 'helped', note })), findings: findings.map(({ id }) => ({ id, disposition: 'fixed', note })) };
  assert.throws(() => validateFeedbackFields(decision, { recordRoot: c.ws, planPath: PLAN }), /feedback record limit/);
  const plain = { ...decision, recalled: decision.recalled.map(entry => ({ ...entry, note: 'n'.repeat(280) })), findings: decision.findings.map(entry => ({ ...entry, note: 'n'.repeat(280) })) };
  assert.ok(validateFeedbackFields(plain, { recordRoot: c.ws, planPath: PLAN }).findings.length === 128, 'a full record with plain notes still fits');
});

test('feedback history is never scanned while feedback is off, once per status or packet otherwise, and oversized records are refused', t => {
  const c = seeded(t);
  publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: sha('one'), planPath: PLAN, captureDate: '2026-11-09', feedback: { recalled: [{ id: c.id, verdict: 'wrong', version: c.version }] } });
  const off = observed(c, () => { consolidateStatus({ workspace: c.ws, home: c.home }); consolidateCandidates({ workspace: c.ws, home: c.home }); });
  assert.equal(off.scans(), 0, 'off reads no feedback records');
  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'suggest' });
  const plain = observed(c, () => consolidateStatus({ workspace: c.ws, home: c.home }));
  assert.equal(plain.scans(), 0, 'suggest: a status caller that does not show feedback skips the scan');
  assert.equal(plain.value.feedback, undefined);
  assert.equal(observed(c, () => consolidateStatus({ workspace: c.ws, home: c.home, withFeedback: true })).scans(), 1);
  const packet = observed(c, () => consolidateCandidates({ workspace: c.ws, home: c.home }));
  assert.equal(packet.scans(), 1, 'the packet reuses the status feedback view');
  assert.deepEqual(packet.value.feedback.review_required, [c.id]);
  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'on' });
  const on = observed(c, () => consolidateStatus({ workspace: c.ws, home: c.home }));
  assert.equal(on.scans(), 1, 'on: due depends on the history');
  assert.equal(on.value.due, true);
  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'suggest' });
  const big = path.join(projectStoreDir(c.ws, { home: c.home }), 'feedback', `${'e'.repeat(64)}.json`);
  fs.writeFileSync(big, JSON.stringify({ version: 1, operation: 'e'.repeat(64), plan: PLAN, recalled: [{ id: c.id, verdict: 'helped', version: c.version, note: 'x'.repeat(300 * 1024) }] }));
  assert.equal(readFeedbackRecords({ workspace: c.ws, home: c.home }).records.length, 1, 'a record above the per-file cap is refused');
});

test('finding lookup reads only the header of another plan\'s review record', t => {
  const c = seeded(t);
  const dir = path.join(c.ws, '.harness/reviews/records');
  fs.mkdirSync(dir, { recursive: true });
  const bulky = { version: 2, plan: 'docs/plans/other.md', findings: Array.from({ length: 400 }, (_, i) => ({ id: sha(`f-${i}`), reviewers: ['correctness'], summary: 'y'.repeat(200) })) };
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(dir, `0${sha(`bulky-${i}`).slice(1)}.json`), `${JSON.stringify(bulky, null, 2)}\n`);
  const finding = 'e'.repeat(64);
  fs.writeFileSync(path.join(dir, `${'f'.repeat(64)}.json`), `${JSON.stringify({ version: 2, plan: PLAN, findings: [{ id: finding, reviewers: ['tests'] }] }, null, 2)}\n`);
  const run = observed(c, () => planReviewFindings(c.ws, PLAN));
  assert.deepEqual(run.value.get(finding), ['tests']);
  assert.ok(run.bytes() < 20 * 8192 + 4096, `read ${run.bytes()} bytes; other plans' records are skipped from their header`);
});

function decisionHarness(c) {
  const workspace = fs.realpathSync.native(c.ws);
  const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
  const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
  const readiness = (verdict, recordedAt) => {
    const packet = { schema: 1, type: 'readiness', planPath: PLAN, nonce: recordedAt, padding: 'x'.repeat(600 * 1024) };
    const requestId = hash(packet);
    const value = { schema: 1, requestId, type: 'readiness', verdict, authorized: false, recordedAt, consumedAt: null };
    return { requestId, request: { ...packet, requestId, createdAt: recordedAt }, receipt: { ...value, id: hash(value) } };
  };
  const state = items => ({ schema: 1, workspace, tasks: {}, requests: Object.fromEntries(items.map(item => [item.requestId, item.request])), observations: {}, receipts: Object.fromEntries(items.map(item => [item.requestId, item.receipt])), invocations: {}, nativeProbes: {} });
  const archive = path.join(c.home, 'decision-archives', hash(workspace));
  const stateFile = path.join(c.home, 'decisions', `${hash(workspace)}.json`);
  return { workspace, readiness, state, archive, stateFile };
}

test('a refused readiness index write never lets an older receipt be cited as latest', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const r1 = d.readiness('ready-ish', 1), r2 = d.readiness('blocked', 2);
  const first = d.state([r1]);
  assert.deepEqual(compactDecisions({ home: c.home, workspace: d.workspace, now: 10 }, first), []);
  // Redirect the index directory; the retained R1 index stays behind the redirect.
  fs.renameSync(path.join(d.archive, 'readiness'), path.join(c.dir, 'elsewhere'));
  fs.symlinkSync(path.join(c.dir, 'elsewhere'), path.join(d.archive, 'readiness'), 'dir');
  const second = d.state([r2]);
  const faults = compactDecisions({ home: c.home, workspace: d.workspace, now: 10 }, second);
  assert.equal(faults.length, 1);
  assert.match(faults[0].message, /readiness index not retained/);
  assert.equal(second.requests[r2.requestId], undefined, 'the request archives; compaction is never blocked');
  assert.deepEqual(Object.keys(second.readinessPending.plans), [sha(PLAN)], 'the plan\'s newest archived receipt is noted');
  assert.equal(fs.readdirSync(path.join(c.dir, 'elsewhere')).length, 1, 'nothing new was written through the redirect');
  fs.mkdirSync(path.dirname(d.stateFile), { recursive: true });
  fs.writeFileSync(d.stateFile, JSON.stringify(second));
  const cited = JSON.parse(fs.readFileSync(publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: sha('cite'), planPath: PLAN, captureDate: '2026-11-09', feedback: { recalled: [{ id: c.id, verdict: 'helped' }] } }).path, 'utf8')).readiness;
  assert.equal(cited.verdict, 'blocked');
  assert.equal(cited.recordedAt, 2);
});

test('decision status derives the readiness-index warning from the index; nothing about it is stored', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const run = decisionRun(c, d);
  redirectIndex(c, d);
  run.seed([d.readiness('escalate', 1)]);
  const prepared = run.prepare(1000);
  const stored = run.stored();
  assert.equal(stored.warnings, undefined, 'no warning is persisted');
  const [warning, ...rest] = run.status(prepared.requestId, 1001).warnings;
  assert.deepEqual(rest, []);
  assert.deepEqual({ ...warning, message: undefined }, { fault: 'readiness-index', planCount: 1, plans: [sha(PLAN).slice(0, 12)], omittedPlans: 0, message: undefined });
  assert.match(warning.message, /stale for 1 plan/);
  // The fault clears: the next pass retries the write from the noted receipt, and status derives a healthy index.
  fs.unlinkSync(path.join(d.archive, 'readiness'));
  run.prepare(1002);
  assert.equal(run.stored().readinessPending, undefined);
  assert.equal(run.status(prepared.requestId, 1003).warnings, undefined);
  assert.equal(latestArchivedReadiness({ home: c.home, workspace: d.workspace }, PLAN).recordedAt, 1);
});

test('a lasting readiness index failure notes only the plan\'s newest receipt, and a cleared fault retries', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  redirectIndex(c, d);
  const items = [d.readiness('escalate', 1), d.readiness('escalate', 2), d.readiness('escalate', 3)];
  const state = d.state(items);
  const loc = { home: c.home, workspace: d.workspace, now: 10 };
  for (let pass = 0; pass < 3; pass++) {
    const faults = compactDecisions(loc, state);
    assert.deepEqual(Object.keys(state.requests), [], `pass ${pass}: every terminal request archives`);
    assert.deepEqual(Object.values(state.readinessPending.plans).map(entry => entry.requestId), [items[2].requestId], `pass ${pass}: the newest receipt is noted`);
    assert.ok(faults.length >= 1);
  }
  assert.equal(fs.readdirSync(path.join(c.dir, 'elsewhere')).length, 0);
  fs.unlinkSync(path.join(d.archive, 'readiness'));
  assert.deepEqual(compactDecisions(loc, state), [], 'the retry succeeds once the fault clears');
  assert.equal(state.readinessPending, undefined);
  assert.equal(latestArchivedReadiness(loc, PLAN).recordedAt, 3);
});

test('warnings persisted by earlier versions are ignored on read and dropped on the next write', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const run = decisionRun(c, d);
  run.seed([]);
  const prepared = run.prepare(1000);
  fs.writeFileSync(d.stateFile, JSON.stringify({ ...run.stored(), warnings: [
    { at: 1, requestId: prepared.requestId, message: 'about a live request' },
    { at: 5, requestId: 'a'.repeat(64), fault: 'readiness-index', plan: sha(PLAN), message: 'readiness index not retained; request stays live: disk full' },
    { at: 6, requestId: null, fault: 'readiness-index', plans: [sha('docs/plans/b.md')], count: 300, message: 'x' },
    'loose text',
  ], readinessPending: { plans: { [sha('x')]: { planPath: 'not x', id: 'f'.repeat(64), requestId: 'f'.repeat(64), verdict: 'ready', recordedAt: 1 } } } }));
  assert.equal(run.status(prepared.requestId, 1001).warnings, undefined, 'old shapes and a mismatched note are ignored');
  run.prepare(1002);
  const stored = run.stored();
  assert.equal(stored.warnings, undefined);
  assert.equal(stored.readinessPending, undefined, 'a malformed note is dropped on write');
});

test('under an index fault a hydrated request is never noted as newest, and an older request\'s note yields to a newer index', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const loc = { home: c.home, workspace: d.workspace, now: 10 };
  const r1 = d.readiness('escalate', 1), r2 = d.readiness('blocked', 2);
  assert.deepEqual(compactDecisions(loc, d.state([r1, r2])), []);
  assert.equal(latestArchivedReadiness(loc, PLAN).recordedAt, 2);
  fs.renameSync(path.join(d.archive, 'readiness'), path.join(c.dir, 'elsewhere'));
  fs.symlinkSync(path.join(c.dir, 'elsewhere'), path.join(d.archive, 'readiness'), 'dir');
  // R1 comes back from the archive (re-prepare or inspect); it must not be noted as the plan's newest.
  const hydrated = d.state([]);
  assert.equal(hydrateArchivedDecision(loc, hydrated, r1.requestId).requestId, r1.requestId);
  compactDecisions(loc, hydrated);
  assert.deepEqual(Object.keys(hydrated.requests), [], 'the hydrated request is retired again');
  assert.equal(hydrated.readinessPending, undefined, 'R2 behind the index stays the newest');

  // An older terminal request archived under the fault is noted; the open newest stays live.
  const r3 = d.readiness('escalate', 3), r4 = readinessFor(d, PLAN, 'ready', 4, 600 * 1024);
  const undated = d.readiness('escalate', 5);
  undated.receipt.recordedAt = null;
  const live = d.state([r3, r4, undated]);
  compactDecisions(loc, live);
  assert.deepEqual(Object.keys(live.requests), [r4.requestId], 'the older and undated terminal requests compact; the open newest stays');
  assert.deepEqual(Object.values(live.readinessPending.plans).map(entry => entry.requestId), [r3.requestId]);
  // R4 is consumed once the fault clears: its index write covers R3, and the note leaves.
  fs.unlinkSync(path.join(d.archive, 'readiness'));
  live.receipts[r4.requestId].consumedAt = 11;
  assert.deepEqual(compactDecisions(loc, live), []);
  assert.equal(live.readinessPending, undefined);
  assert.equal(latestArchivedReadiness(loc, PLAN).recordedAt, 4);
});
// Third review pass and #122 follow-ups (PR #123).

test('third pass B: under on the packet reads the feedback history once, and orient under suggest never reads it', t => {
  const c = seeded(t);
  publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: sha('one'), planPath: PLAN, captureDate: '2026-11-09', feedback: { recalled: [{ id: c.id, verdict: 'wrong', version: c.version }] } });
  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'on' });
  const packet = observed(c, () => consolidateCandidates({ workspace: c.ws, home: c.home }));
  assert.equal(packet.scans(), 1, 'on: status and ordering share one history read');
  assert.deepEqual(packet.value.feedback.review_required, [c.id]);
  assert.deepEqual(packet.value.learnings.map(l => l.id), [c.id]);
  writeFeedbackConfig(c.ws, { home: c.home, feedback: 'suggest' });
  const saved = { AE_HOME: process.env.AE_HOME, HARNESS_HOME: process.env.HARNESS_HOME };
  process.env.AE_HOME = c.home; process.env.HARNESS_HOME = c.home;
  const copilot = path.join(c.dir, 'copilot');
  fs.mkdirSync(copilot, { recursive: true });
  try {
    const oriented = observed(c, () => runOrient({ workspace: c.ws, copilotHome: copilot, flags: { workspace: c.ws, harnessHome: c.home }, query: 'index and store locks' }));
    assert.equal(oriented.value.knowledgeDebt?.due ?? false, false);
    assert.equal(oriented.scans(), 0, 'suggest: orient never scans feedback records');
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

function readinessFor(d, planPath, verdict, recordedAt, padding = 0) {
  const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
  const hash = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
  const packet = { schema: 1, type: 'readiness', planPath, nonce: recordedAt, padding: 'x'.repeat(padding) };
  const requestId = hash(packet);
  const value = { schema: 1, requestId, type: 'readiness', verdict, authorized: verdict === 'ready', recordedAt, consumedAt: null };
  return { requestId, request: { ...packet, requestId, createdAt: recordedAt }, receipt: { ...value, id: hash(value) } };
}

function decisionRun(c, d) {
  fs.writeFileSync(path.join(c.ws, 'test.mjs'), 'console.log("test");\n');
  const policy = { enabled: true, revision: 'consent-1', tools: ['execute'], budgets: { maxDecisions: 1, maxRepairs: 1, maxAcquisitions: 1, maxSeconds: 60 } };
  const action = { tool: 'Bash', input: { command: 'node test.mjs' }, cwd: d.workspace };
  let n = 0;
  const prepare = now => prepareDecision({ workspace: c.ws, home: c.home, policy, now, input: { schema: 1, taskId: `task-${n}`, sessionId: `session-${n++}`, type: 'action', intent: 'Run the selected behavior check.', action, sources: ['test.mjs'] } });
  const stored = () => JSON.parse(fs.readFileSync(d.stateFile, 'utf8'));
  const seed = items => { fs.mkdirSync(path.dirname(d.stateFile), { recursive: true }); fs.writeFileSync(d.stateFile, JSON.stringify(d.state(items))); };
  const status = (requestId, now) => decisionStatus({ workspace: c.ws, home: c.home, policy, requestId, now });
  return { prepare, stored, seed, status };
}

const redirectIndex = (c, d) => {
  fs.mkdirSync(d.archive, { recursive: true });
  fs.mkdirSync(path.join(c.dir, 'elsewhere'), { recursive: true });
  fs.symlinkSync(path.join(c.dir, 'elsewhere'), path.join(d.archive, 'readiness'), 'dir');
};

/** Fail index writes for the plan whose index file is named by `key`, letting the first `allow` through. */
function refuseIndexFor(key, fn, allow = 0) {
  const { openSync } = fs;
  let seen = 0, refused = 0;
  fs.openSync = (file, flags, ...rest) => {
    if (String(file).includes(`${path.sep}readiness${path.sep}`) && path.basename(String(file)).includes(key) && seen++ >= allow) { refused += 1; throw new Error('index write refused for one plan'); }
    return openSync(file, flags, ...rest);
  };
  try { return fn(); } finally { fs.openSync = openSync; assert.ok(refused > 0, 'the patched index write was attempted'); }
}

const staleWarning = (run, requestId, now) => (run.status(requestId, now).warnings || []).find(item => item.fault === 'readiness-index');

// Seventh review pass (PR #123): readiness-index health is derived from the index, never persisted and cleared.

test('F1: an older request\'s index write never hides a newer archived receipt', t => {
  for (const variant of ['retry heals', 'retry still refused']) {
    const c = seeded(t);
    const d = decisionHarness(c);
    const run = decisionRun(c, d);
    redirectIndex(c, d);
    const a = readinessFor(d, PLAN, 'ready', 1, 600 * 1024), b = readinessFor(d, PLAN, 'escalate', 2);
    const others = Array.from({ length: 33 }, (_, i) => readinessFor(d, `docs/plans/o${String(i).padStart(2, '0')}.md`, 'escalate', i + 3));
    run.seed([a, b, ...others]);
    const prepared = run.prepare(1000);
    const faulted = run.stored();
    assert.ok(faulted.requests[a.requestId] && !faulted.requests[b.requestId], `${variant}: A stays open; B archives`);
    assert.equal(faulted.readinessPending.plans[sha(PLAN)].requestId, b.requestId);
    assert.equal(staleWarning(run, prepared.requestId, 1001).planCount, 34, 'P and the 33 other plans are all stale');
    fs.unlinkSync(path.join(d.archive, 'readiness'));
    faulted.receipts[a.requestId].consumedAt = 1001;
    fs.writeFileSync(d.stateFile, JSON.stringify(faulted));
    const loc = { home: c.home, workspace: d.workspace };
    if (variant === 'retry heals') {
      run.prepare(1002);
      assert.equal(latestArchivedReadiness(loc, PLAN).recordedAt, 2, 'B is retried after A\'s write, so the index names B');
      assert.equal(staleWarning(run, prepared.requestId, 1003), undefined);
    } else {
      // A's own index write succeeds; B's retry is still refused.
      refuseIndexFor(sha(PLAN), () => run.prepare(1002), 1);
      assert.equal(latestArchivedReadiness(loc, PLAN).recordedAt, 1, 'precondition: the index names the older A');
      const warning = staleWarning(run, prepared.requestId, 1003);
      assert.equal(warning.planCount, 1, 'only P is still stale');
      assert.deepEqual(warning.plans, [sha(PLAN).slice(0, 12)]);
      assert.deepEqual(latestReadinessReceipt({ workspace: c.ws, home: c.home, planPath: PLAN }), { id: b.receipt.id, requestId: b.requestId, verdict: 'escalate', recordedAt: 2 }, 'B, not the indexed A, is cited');
    }
  }
});

test('F2: every refused plan is represented, beyond any per-warning bound', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const run = decisionRun(c, d);
  redirectIndex(c, d);
  const plans = Array.from({ length: 32 }, (_, i) => `docs/plans/q${String(i).padStart(2, '0')}.md`);
  run.seed(plans.map((planPath, i) => readinessFor(d, planPath, 'escalate', i + 1, i === 0 ? 600 * 1024 : 0)));
  const prepared = run.prepare(1000);
  const stored = run.stored();
  assert.equal(Object.keys(stored.requests).length, 1, 'only the new action request stays live');
  assert.equal(Object.keys(stored.readinessPending.plans).length, 32);
  const status = run.status(prepared.requestId, 1001);
  assert.equal(status.warnings.length, 1, 'one aggregated warning');
  const [warning] = status.warnings;
  assert.deepEqual([warning.planCount, warning.omittedPlans, warning.atLeast], [32, 24, undefined]);
  assert.deepEqual(warning.plans, plans.slice(-8).reverse().map(plan => sha(plan).slice(0, 12)), 'at most 8 short hashes, newest first');
  assert.ok(JSON.stringify(warning).length < 1024, 'status stays small');
});

test('F3: past 256 stale plans the count is a stated lower bound, and stays exact below it', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const run = decisionRun(c, d);
  redirectIndex(c, d);
  const plans = Array.from({ length: 300 }, (_, i) => `docs/plans/r${String(i).padStart(3, '0')}.md`);
  run.seed(plans.map((planPath, i) => readinessFor(d, planPath, 'escalate', i + 1, i === 0 ? 600 * 1024 : 0)));
  const prepared = run.prepare(1000);
  const stored = run.stored();
  assert.equal(Object.keys(stored.readinessPending.plans).length, 256, 'tracking is bounded');
  assert.equal(stored.readinessPending.plans[sha(plans[0])], undefined, 'the oldest plans are dropped first');
  assert.ok(stored.readinessPending.plans[sha(plans[299])]);
  const warning = staleWarning(run, prepared.requestId, 1001);
  assert.deepEqual([warning.planCount, warning.atLeast, warning.omittedPlans], [256, true, 248]);
  assert.match(warning.message, /at least 256 plan/);
  // Another pass under the same fault neither drifts nor grows.
  run.prepare(1002);
  assert.equal(staleWarning(run, prepared.requestId, 1003).planCount, 256);
  // The fault clears except for one plan: the count is exact for what is tracked, still a lower bound.
  fs.unlinkSync(path.join(d.archive, 'readiness'));
  refuseIndexFor(sha(plans[299]), () => run.prepare(1004));
  const left = staleWarning(run, prepared.requestId, 1005);
  assert.deepEqual([left.planCount, left.atLeast, left.plans], [1, true, [sha(plans[299]).slice(0, 12)]]);
  run.prepare(1006);
  assert.equal(staleWarning(run, prepared.requestId, 1007), undefined);
  assert.equal(run.stored().readinessPending, undefined);
});

test('a transient fault on an older receipt is covered once the newer receipt indexes in the same pass', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const run = decisionRun(c, d);
  const r1 = d.readiness('escalate', 1), r2 = d.readiness('blocked', 2);
  run.seed([r1, r2]);
  const { mkdirSync } = fs;
  let refused = 0;
  fs.mkdirSync = (dir, ...rest) => { if (!refused && String(dir).endsWith(`${path.sep}readiness`)) { refused += 1; throw new Error('transient index fault'); } return mkdirSync(dir, ...rest); };
  let prepared;
  try { prepared = run.prepare(1000); } finally { fs.mkdirSync = mkdirSync; }
  assert.equal(refused, 1);
  assert.equal(run.stored().readinessPending, undefined, 'R2\'s index covers R1');
  assert.equal(run.status(prepared.requestId, 1001).warnings, undefined);
  assert.equal(latestArchivedReadiness({ home: c.home, workspace: d.workspace }, PLAN).recordedAt, 2);
});

test('an index that is already current writes nothing and notes nothing; a newer refused receipt is noted', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const loc = { home: c.home, workspace: d.workspace, now: 10 };
  const a = d.readiness('escalate', 1);
  assert.deepEqual(compactDecisions(loc, d.state([a])), []);
  const { openSync } = fs;
  let attempts = 0;
  fs.openSync = (file, flags, ...rest) => {
    if (flags === 'wx' && String(file).includes(`${path.sep}readiness${path.sep}`)) { attempts += 1; throw new Error('index writes still fail'); }
    return openSync(file, flags, ...rest);
  };
  try {
    const hydrated = d.state([]);
    hydrateArchivedDecision(loc, hydrated, a.requestId);
    assert.deepEqual(compactDecisions(loc, hydrated), []);
    assert.deepEqual(Object.keys(hydrated.requests), [], 'the hydrated request is retired again');
    assert.equal(attempts, 0, 'the index already held A, so nothing was written');
    assert.equal(hydrated.readinessPending, undefined);
    const b = d.readiness('blocked', 2), next = d.state([b]);
    const faults = compactDecisions(loc, next);
    assert.ok(attempts > 0);
    assert.deepEqual(faults.map(item => item.plan), [sha(PLAN)]);
    assert.equal(next.readinessPending.plans[sha(PLAN)].recordedAt, 2);
  } finally { fs.openSync = openSync; }
});

test('another plan\'s successful index write never makes a refused plan look healthy', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const run = decisionRun(c, d);
  const a = readinessFor(d, PLAN, 'blocked', 1, 600 * 1024), b = readinessFor(d, 'docs/plans/b.md', 'escalate', 2);
  run.seed([a, b]);
  const prepared = refuseIndexFor(sha(PLAN), () => run.prepare(1000));
  assert.deepEqual(staleWarning(run, prepared.requestId, 1001).plans, [sha(PLAN).slice(0, 12)], 'B indexed; A did not');
  const c2 = readinessFor(d, 'docs/plans/c.md', 'escalate', 3, 600 * 1024), stored = run.stored();
  fs.writeFileSync(d.stateFile, JSON.stringify({ ...stored, requests: { ...stored.requests, [c2.requestId]: c2.request }, receipts: { ...stored.receipts, [c2.requestId]: c2.receipt } }));
  refuseIndexFor(sha(PLAN), () => run.prepare(1002));
  assert.equal(staleWarning(run, prepared.requestId, 1003).planCount, 1);
  run.prepare(1004);
  assert.equal(run.status(prepared.requestId, 1005).warnings, undefined);
  assert.equal(latestArchivedReadiness({ home: c.home, workspace: d.workspace }, PLAN).recordedAt, 1);
});

test('an index current for an older request still derives the plan\'s newest receipt as stale', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const loc = { home: c.home, workspace: d.workspace, now: 10 };
  assert.deepEqual(compactDecisions(loc, d.state([readinessFor(d, PLAN, 'escalate', 2, 600 * 1024)])), []);
  const older = readinessFor(d, PLAN, 'escalate', 1, 600 * 1024), newest = readinessFor(d, PLAN, 'blocked', 3);
  const state = d.state([older, newest]);
  const { openSync } = fs;
  let refused = 0;
  fs.openSync = (file, flags, ...rest) => {
    if (flags === 'wx' && String(file).includes(`${path.sep}readiness${path.sep}`)) { refused += 1; throw new Error('index writes fail'); }
    return openSync(file, flags, ...rest);
  };
  let faults;
  try { faults = compactDecisions(loc, state); } finally { fs.openSync = openSync; }
  assert.equal(refused, 1, 'only the newest request tried to write, once per pass');
  assert.deepEqual(Object.keys(state.requests), []);
  assert.deepEqual(faults.map(item => [item.requestId, item.plan]), [[newest.requestId, sha(PLAN)]]);
  assert.deepEqual(readinessIndexHealth(loc, state), { stale: [sha(PLAN)], capped: false });
});

const writeExposure = (c, entries) => {
  const file = path.join(c.ws, exposureRel(PLAN));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, plan: PLAN, entries }, null, 2)}\n`);
};

test('F4: hostile exposure entries (control-character IDs, future times) never block a real delivery', t => {
  const c = seeded(t);
  writeExposure(c, Array.from({ length: 64 }, (_, i) => ({ id: `evil/\u001b[31m${i}\r\n`, layer: 'golden', firstExposedAt: '2030-01-01T00:00:00.000Z', lastExposedAt: '2030-01-01T00:00:00.000Z', count: 1 })));
  const record = recordExposure({ recordRoot: c.ws, workspace: c.ws, home: c.home, planPath: PLAN, delivered: [{ id: 'real/learning' }] });
  assert.deepEqual(record.entries.map(entry => entry.id), ['real/learning'], 'the real learning is recorded and the hostile entries dropped');
  // Well-formed IDs with a future time, or a count below one, are dropped too; one within the skew is kept.
  const soon = new Date(Date.now() + 60 * 1000).toISOString(), late = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  writeExposure(c, [
    { id: 'future/one', layer: 'golden', firstExposedAt: late, lastExposedAt: late, count: 3 },
    { id: 'zero/one', layer: 'golden', firstExposedAt: soon, lastExposedAt: soon, count: 0 },
    { id: 'skew/one', layer: 'golden', firstExposedAt: soon, lastExposedAt: soon, count: 2 },
  ]);
  const next = recordExposure({ recordRoot: c.ws, workspace: c.ws, home: c.home, planPath: PLAN, delivered: [{ id: 'real/learning' }] });
  assert.deepEqual(next.entries.map(entry => [entry.id, entry.count]), [['real/learning', 1], ['skew/one', 2]]);
});

test('F5: the delivered gate accepts only well-formed exposure entries, with a hex version', t => {
  const c = seeded(t);
  const check = id => () => validateFeedbackFields({ operation: 'x', decision: 'no-learning', rationale: 'r', recalled: [{ id, verdict: 'helped' }] }, { recordRoot: c.ws, planPath: PLAN });
  const now = new Date().toISOString(), late = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  writeExposure(c, [
    { id: 'ghost/one', lastExposedAt: 'never', count: -5, version: 'v'.repeat(2000) },
    { id: 'ghost/two', lastExposedAt: now, count: 1, version: 'v'.repeat(2000) },
    { id: 'ghost/three', lastExposedAt: late, count: 1 },
    { id: 'ghost/four', lastExposedAt: now, count: 0 },
    { id: 'ok/one', lastExposedAt: now, count: 1, version: 'a'.repeat(64) },
  ]);
  for (const id of ['ghost/one', 'ghost/two', 'ghost/three', 'ghost/four']) assert.throws(check(id), /never delivered/, id);
  assert.deepEqual(check('ok/one')().recalled, [{ id: 'ok/one', verdict: 'helped', version: 'a'.repeat(64) }]);
});
