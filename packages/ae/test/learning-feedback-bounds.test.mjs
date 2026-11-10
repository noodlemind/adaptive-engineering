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
import { compactDecisions, hydrateArchivedDecision, latestArchivedReadiness } from '../lib/decision-archive.mjs';
import { decisionStatus, prepareDecision } from '../lib/decision-agent.mjs';
import { runOrient } from '../lib/orient.mjs';
import { branchKeyFor } from '../lib/git-context.mjs';
import {
  acceptedFeedbackRecord, feedbackSummary, learningVersion, planReviewFindings, publishFeedbackRecord, readExposure, readFeedbackRecords, recordExposure, validateFeedbackFields,
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

test('a refused readiness index write keeps the newer receipt live so an older one is never cited as latest', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const r1 = d.readiness('ready-ish', 1), r2 = d.readiness('blocked', 2);
  const first = d.state([r1]);
  assert.deepEqual(compactDecisions({ home: c.home, workspace: d.workspace, now: 10 }, first), []);
  // Redirect the index directory; the retained R1 index stays behind the redirect.
  fs.renameSync(path.join(d.archive, 'readiness'), path.join(c.dir, 'elsewhere'));
  fs.symlinkSync(path.join(c.dir, 'elsewhere'), path.join(d.archive, 'readiness'), 'dir');
  const second = d.state([r2]);
  const warnings = compactDecisions({ home: c.home, workspace: d.workspace, now: 10 }, second);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /readiness index not retained/);
  assert.ok(second.requests[r2.requestId] && second.receipts[r2.requestId], 'the request whose index write failed stays live for a retry');
  assert.equal(fs.readdirSync(path.join(c.dir, 'elsewhere')).length, 1, 'nothing new was written through the redirect');
  fs.mkdirSync(path.dirname(d.stateFile), { recursive: true });
  fs.writeFileSync(d.stateFile, JSON.stringify(second));
  const cited = JSON.parse(fs.readFileSync(publishFeedbackRecord({ workspace: c.ws, home: c.home, operation: sha('cite'), planPath: PLAN, captureDate: '2026-11-09', feedback: { recalled: [{ id: c.id, verdict: 'helped' }] } }).path, 'utf8')).readiness;
  assert.equal(cited.verdict, 'blocked');
  assert.equal(cited.recordedAt, 2);
});

test('compaction warnings are kept quietly in decision state and reported by decision status', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  fs.mkdirSync(d.archive, { recursive: true });
  fs.mkdirSync(path.join(c.dir, 'elsewhere'));
  fs.symlinkSync(path.join(c.dir, 'elsewhere'), path.join(d.archive, 'readiness'), 'dir');
  fs.mkdirSync(path.dirname(d.stateFile), { recursive: true });
  fs.writeFileSync(d.stateFile, JSON.stringify(d.state([d.readiness('escalate', 1)])));
  fs.writeFileSync(path.join(c.ws, 'test.mjs'), 'console.log("test");\n');
  const policy = { enabled: true, revision: 'consent-1', tools: ['execute'], budgets: { maxDecisions: 1, maxRepairs: 1, maxAcquisitions: 1, maxSeconds: 60 } };
  const action = { tool: 'Bash', input: { command: 'node test.mjs' }, cwd: d.workspace };
  const input = { schema: 1, taskId: 'task-0', sessionId: 'session-0', type: 'action', intent: 'Run the selected behavior check.', action, sources: ['test.mjs'] };
  const prepared = prepareDecision({ workspace: c.ws, home: c.home, policy, input, now: 1000 });
  const stored = JSON.parse(fs.readFileSync(d.stateFile, 'utf8'));
  assert.equal(stored.warnings.length, 1);
  assert.match(stored.warnings[0].message, /readiness index not retained/);
  const status = decisionStatus({ workspace: c.ws, home: c.home, policy, requestId: prepared.requestId, now: 1001 });
  assert.deepEqual(status.warnings, stored.warnings);
  // Once the fault clears, the next compaction retains the index, retires the request and drops its warning.
  fs.unlinkSync(path.join(d.archive, 'readiness'));
  prepareDecision({ workspace: c.ws, home: c.home, policy, input: { ...input, taskId: 'task-1', sessionId: 'session-1' }, now: 1002 });
  const cleared = JSON.parse(fs.readFileSync(d.stateFile, 'utf8'));
  assert.equal(cleared.warnings, undefined, 'a fixed fault is no longer reported');
  assert.equal(decisionStatus({ workspace: c.ws, home: c.home, policy, requestId: prepared.requestId, now: 1003 }).warnings, undefined);
});

test('a lasting readiness index failure keeps only the newest readiness request per plan live, and a cleared fault retries', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  fs.mkdirSync(d.archive, { recursive: true });
  fs.mkdirSync(path.join(c.dir, 'elsewhere'));
  fs.symlinkSync(path.join(c.dir, 'elsewhere'), path.join(d.archive, 'readiness'), 'dir');
  const items = [d.readiness('escalate', 1), d.readiness('escalate', 2), d.readiness('escalate', 3)];
  const state = d.state(items);
  const loc = { home: c.home, workspace: d.workspace, now: 10 };
  for (let pass = 0; pass < 3; pass++) {
    const warnings = compactDecisions(loc, state);
    assert.deepEqual(Object.keys(state.requests), [items[2].requestId], `pass ${pass}: only the newest readiness request stays live`);
    assert.ok(warnings.some(item => item.requestId === items[2].requestId && /stays live/.test(item.message)));
  }
  assert.equal(fs.readdirSync(path.join(c.dir, 'elsewhere')).length, 0);
  fs.unlinkSync(path.join(d.archive, 'readiness'));
  assert.deepEqual(compactDecisions(loc, state), [], 'the retry succeeds once the fault clears');
  assert.deepEqual(Object.keys(state.requests), []);
  assert.equal(latestArchivedReadiness(loc, PLAN).recordedAt, 3);
});

test('decision status reports only well-formed warnings about live requests, one per request, at most 16', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
  const hash = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
  const requests = {};
  for (let i = 0; i < 20; i++) {
    const packet = { schema: 1, type: 'readiness', planPath: PLAN, nonce: i };
    requests[hash(packet)] = { ...packet, requestId: hash(packet), createdAt: i };
  }
  const ids = Object.keys(requests);
  const warnings = [
    ...ids.map((requestId, i) => ({ at: i, requestId, message: `old ${i}` })),
    { at: 98, requestId: ids[18], message: `${'a'.repeat(499)}\u{1F600}tail` },
    { at: 99, requestId: ids[19], message: 'newest for 19' },
    { at: 'soon', requestId: ids[0], message: 'bad time' },
    { at: 1, requestId: ids[0], message: 7 },
    { at: 1, requestId: 'f'.repeat(64), message: 'retired request' },
    'loose text',
  ];
  fs.mkdirSync(path.dirname(d.stateFile), { recursive: true });
  fs.writeFileSync(d.stateFile, JSON.stringify({ schema: 1, workspace: d.workspace, tasks: {}, requests, observations: {}, receipts: {}, invocations: {}, nativeProbes: {}, warnings }));
  const status = decisionStatus({ workspace: c.ws, home: c.home, policy: { enabled: true, revision: 'r', tools: [], budgets: {} }, requestId: ids[0], now: 100 });
  assert.equal(status.warnings.length, 16);
  assert.ok(status.warnings.every(item => typeof item.at === 'number' && typeof item.message === 'string' && Object.hasOwn(requests, item.requestId)));
  assert.equal(new Set(status.warnings.map(item => item.requestId)).size, 16, 'one warning per request');
  assert.equal(status.warnings.at(-1).message, 'newest for 19');
  assert.equal(status.warnings.at(-2).message, `${'a'.repeat(499)}\u{1F600}`, 'truncation keeps a surrogate pair whole');
});

test('under an index fault a hydrated request is never kept live, and an older request\'s warning rides on the newest live one', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const loc = { home: c.home, workspace: d.workspace, now: 10 };
  const r1 = d.readiness('escalate', 1), r2 = d.readiness('blocked', 2);
  const archived = d.state([r1, r2]);
  assert.deepEqual(compactDecisions(loc, archived), []);
  assert.equal(latestArchivedReadiness(loc, PLAN).recordedAt, 2);
  fs.renameSync(path.join(d.archive, 'readiness'), path.join(c.dir, 'elsewhere'));
  fs.symlinkSync(path.join(c.dir, 'elsewhere'), path.join(d.archive, 'readiness'), 'dir');

  // R1 comes back from the archive (re-prepare or inspect); it must not be kept live as "newest".
  const hydrated = d.state([]);
  assert.equal(hydrateArchivedDecision(loc, hydrated, r1.requestId).requestId, r1.requestId);
  compactDecisions(loc, hydrated);
  assert.deepEqual(Object.keys(hydrated.requests), [], 'the hydrated request is retired again');

  // An older terminal request archived under the fault reports through the plan's newest live request.
  const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
  const hash = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
  const r3 = d.readiness('escalate', 3);
  const packet = { schema: 1, type: 'readiness', planPath: PLAN, nonce: 4 };
  const value = { schema: 1, requestId: hash(packet), type: 'readiness', verdict: 'ready', authorized: true, recordedAt: 4, consumedAt: null };
  const r4 = { requestId: hash(packet), request: { ...packet, requestId: hash(packet), createdAt: 4 }, receipt: { ...value, id: hash(value) } };
  const undated = d.readiness('escalate', 5);
  undated.receipt.recordedAt = null;
  const live = d.state([r3, r4, undated]);
  const warnings = compactDecisions(loc, live);
  assert.deepEqual(Object.keys(live.requests), [r4.requestId], 'the older and undated terminal requests compact; the open newest stays');
  assert.ok(warnings.length >= 1 && warnings.every(item => item.requestId === r4.requestId), 'warnings name the live newest request');
  assert.ok(warnings.some(item => item.message.includes(`older request ${r3.requestId}`)));
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

test('follow-up G: under a lasting index fault at most 32 plans keep a readiness request live; the rest archive with a warning', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  redirectIndex(c, d);
  const items = Array.from({ length: 34 }, (_, i) => readinessFor(d, `docs/plans/p${String(i).padStart(2, '0')}.md`, 'escalate', i + 1, 20 * 1024));
  const state = d.state(items);
  const warnings = compactDecisions({ home: c.home, workspace: d.workspace, now: 10 }, state);
  assert.deepEqual(Object.keys(state.requests).sort(), items.slice(2).map(item => item.requestId).sort(), 'the 32 newest plans keep their request live');
  const archived = warnings.filter(item => item.requestId === null);
  assert.equal(archived.length, 1, 'one aggregated warning for the plans archived over the cap');
  assert.equal(archived[0].fault, 'readiness-index');
  assert.match(archived[0].message, /2 plan\(s\) archived .* more than 32 plans/);
  assert.deepEqual(archived[0].plans, ['docs/plans/p00.md', 'docs/plans/p01.md'].map(sha).sort());
});

test('follow-up H: a hydrated request whose index write fails leaves a state-level warning that decision status reports', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const run = decisionRun(c, d);
  const loc = { home: c.home, workspace: d.workspace, now: 10 };
  const r1 = d.readiness('escalate', 1);
  assert.deepEqual(compactDecisions(loc, d.state([r1])), []);
  fs.renameSync(path.join(d.archive, 'readiness'), path.join(c.dir, 'elsewhere'));
  fs.symlinkSync(path.join(c.dir, 'elsewhere'), path.join(d.archive, 'readiness'), 'dir');
  fs.unlinkSync(path.join(c.dir, 'elsewhere', fs.readdirSync(path.join(c.dir, 'elsewhere'))[0]));
  const hydrated = d.state([]);
  hydrateArchivedDecision(loc, hydrated, r1.requestId);
  const warnings = compactDecisions(loc, hydrated);
  assert.deepEqual(Object.keys(hydrated.requests), []);
  assert.equal(warnings.length, 1, 'the warning is kept though no live request remains for the plan');
  assert.deepEqual([warnings[0].requestId, warnings[0].fault], [null, 'readiness-index']);
  assert.match(warnings[0].message, new RegExp(`archived request ${r1.requestId}`));
  // Persisted as a state-level warning, reported by decision status.
  run.seed([]);
  const prepared = run.prepare(1000);
  fs.writeFileSync(d.stateFile, JSON.stringify({ ...run.stored(), warnings: [{ at: 5, ...warnings[0] }] }));
  assert.deepEqual(run.status(prepared.requestId, 1001).warnings, [{ at: 5, requestId: null, fault: 'readiness-index', plan: sha(PLAN), message: warnings[0].message }]);
});

test('follow-up I: index-fault warnings clear on the next successful index write and survive their owner compacting in the same pass', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const run = decisionRun(c, d);
  // Part 1: an older request's warning rides on the newest open request; another plan's index write does not
  // clear it, only its own plan's index write does.
  redirectIndex(c, d);
  const older = d.readiness('escalate', 1), open = readinessFor(d, PLAN, 'ready', 2, 600 * 1024), other = readinessFor(d, 'docs/plans/b.md', 'escalate', 3);
  run.seed([older, open, other]);
  run.prepare(1000);
  const faulted = run.stored();
  assert.ok(faulted.warnings.some(item => item.requestId === open.requestId && item.fault === 'readiness-index'), 'the older request warns through the open newest one');
  assert.ok(faulted.requests[other.requestId], 'the other plan keeps its request live for a retry');
  fs.unlinkSync(path.join(d.archive, 'readiness'));
  run.prepare(1002);
  const cleared = run.stored();
  assert.ok(cleared.requests[open.requestId], 'the open request is still live');
  assert.equal(cleared.requests[other.requestId], undefined, 'the other plan indexed and compacted');
  assert.deepEqual(cleared.warnings.map(item => [item.requestId, item.plan]), [[open.requestId, sha(PLAN)]], 'another plan\'s index write leaves this plan\'s warning');
  cleared.receipts[open.requestId].consumedAt = 1003;
  fs.writeFileSync(d.stateFile, JSON.stringify(cleared));
  run.prepare(1004);
  assert.equal(run.stored().requests[open.requestId], undefined, 'the consumed open request compacted and wrote its plan\'s index');
  assert.equal(run.stored().warnings, undefined, 'its own plan\'s index write clears the warning');

  // Part 2: the owner compacts in the same pass after a transient fault; the warning stays at state level.
  const c2 = seeded(t);
  const d2 = decisionHarness(c2);
  const run2 = decisionRun(c2, d2);
  const r1 = d2.readiness('escalate', 1), r2 = d2.readiness('blocked', 2);
  run2.seed([r1, r2]);
  const { mkdirSync } = fs;
  let refused = 0;
  fs.mkdirSync = (dir, ...rest) => { if (!refused && String(dir).endsWith(`${path.sep}readiness`)) { refused += 1; throw new Error('transient index fault'); } return mkdirSync(dir, ...rest); };
  let prepared;
  try { prepared = run2.prepare(1000); } finally { fs.mkdirSync = mkdirSync; }
  assert.equal(refused, 1);
  const kept = run2.stored();
  assert.equal(kept.requests[r2.requestId], undefined, 'the owner compacted once its own index write succeeded');
  assert.deepEqual(kept.warnings.map(item => [item.requestId, item.fault]), [[null, 'readiness-index']]);
  assert.match(kept.warnings[0].message, /transient index fault/);
  assert.equal(run2.status(prepared.requestId, 1001).warnings.length, 1);
  // A later successful index write clears it.
  const r3 = d2.readiness('escalate', 3);
  fs.writeFileSync(d2.stateFile, JSON.stringify({ ...run2.stored(), requests: { ...run2.stored().requests, [r3.requestId]: r3.request }, receipts: { ...run2.stored().receipts, [r3.requestId]: r3.receipt } }));
  run2.prepare(1002);
  assert.equal(run2.stored().warnings, undefined);
});

// Fourth review pass regressions (PR #123).

test('fourth pass 2: an index that is already current sets no indexedPlans, so fault warnings stay while writes still fail', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const loc = { home: c.home, workspace: d.workspace, now: 10 };
  const a = d.readiness('escalate', 1);
  const first = {};
  assert.deepEqual(compactDecisions(loc, d.state([a]), first), []);
  assert.deepEqual([...first.indexedPlans], [sha(PLAN)], 'precondition: indexing A was a real write');
  const { openSync } = fs;
  let attempts = 0;
  fs.openSync = (file, flags, ...rest) => {
    if (flags === 'wx' && String(file).includes(`${path.sep}readiness${path.sep}`)) { attempts += 1; throw new Error('index writes still fail'); }
    return openSync(file, flags, ...rest);
  };
  try {
    const hydrated = d.state([]);
    hydrateArchivedDecision(loc, hydrated, a.requestId);
    const report = {};
    assert.deepEqual(compactDecisions(loc, hydrated, report), []);
    assert.deepEqual(Object.keys(hydrated.requests), [], 'the hydrated request is retired again');
    assert.equal(attempts, 0, 'the index already held A, so nothing was written');
    assert.equal(report.indexedPlans, undefined, 'a current index is not a successful write');
    // A newer receipt does try to write, and the failure is reported, not counted as retained.
    const b = d.readiness('blocked', 2);
    const next = {};
    const warnings = compactDecisions(loc, d.state([b]), next);
    assert.equal(attempts > 0, true);
    assert.equal(next.indexedPlans, undefined);
    assert.ok(warnings.some(item => item.fault === 'readiness-index'));
  } finally { fs.openSync = openSync; }
});

// Fifth review pass regressions (PR #123).

/** Fail index writes only for the plan whose index file is named by `key`. */
function refuseIndexFor(key, fn) {
  const { openSync } = fs;
  let refused = 0;
  fs.openSync = (file, flags, ...rest) => {
    if (String(file).includes(`${path.sep}readiness${path.sep}`) && path.basename(String(file)).includes(key)) { refused += 1; throw new Error('index write refused for one plan'); }
    return openSync(file, flags, ...rest);
  };
  try { return fn(); } finally { fs.openSync = openSync; assert.ok(refused > 0, 'the patched index write was attempted'); }
}

test('fifth pass 1: the 32-plan cap counts only failed index writes, so one transient failure keeps that plan\'s newest request live', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const loc = { home: c.home, workspace: d.workspace, now: 10 };
  const a1 = readinessFor(d, PLAN, 'escalate', 1, 600 * 1024);
  assert.deepEqual(compactDecisions(loc, d.state([a1])), []);
  assert.equal(latestArchivedReadiness(loc, PLAN).recordedAt, 1);
  // A's newer v2 is the oldest receipt in the pass, alongside 32 other plans that index fine.
  const a2 = readinessFor(d, PLAN, 'blocked', 2, 600 * 1024);
  const others = Array.from({ length: 32 }, (_, i) => readinessFor(d, `docs/plans/o${String(i).padStart(2, '0')}.md`, 'escalate', i + 3, 20 * 1024));
  const state = d.state([a2, ...others]);
  const report = {};
  const warnings = refuseIndexFor(sha(PLAN), () => compactDecisions(loc, state, report));
  assert.deepEqual(Object.keys(state.requests), [a2.requestId], 'A\'s newest request stays live for a retry; the indexed plans compact');
  assert.deepEqual(warnings.map(item => [item.requestId, item.plan, item.fault]), [[a2.requestId, sha(PLAN), 'readiness-index']]);
  assert.equal(report.indexedPlans.size, 32);
  assert.equal(report.indexedPlans.has(sha(PLAN)), false, 'A\'s own write did not succeed');
  // The retry writes A's index and v2 is cited from then on.
  assert.deepEqual(compactDecisions(loc, state), []);
  assert.equal(latestArchivedReadiness(loc, PLAN).recordedAt, 2);
});

test('fifth pass 1: another plan\'s successful index write does not clear a plan\'s readiness-index warning', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const run = decisionRun(c, d);
  const a = readinessFor(d, PLAN, 'blocked', 1, 600 * 1024), b = readinessFor(d, 'docs/plans/b.md', 'escalate', 2);
  run.seed([a, b]);
  const prepared = refuseIndexFor(sha(PLAN), () => run.prepare(1000));
  const stored = run.stored();
  assert.ok(stored.requests[a.requestId] && !stored.requests[b.requestId], 'B indexed and compacted; A stays live');
  assert.deepEqual(stored.warnings.map(item => [item.requestId, item.plan]), [[a.requestId, sha(PLAN)]], 'B\'s write in the same pass does not clear A\'s warning');
  // A later pass where only another plan indexes leaves A's warning; A's own write clears it.
  const c2 = readinessFor(d, 'docs/plans/c.md', 'escalate', 3);
  fs.writeFileSync(d.stateFile, JSON.stringify({ ...stored, requests: { ...stored.requests, [c2.requestId]: c2.request }, receipts: { ...stored.receipts, [c2.requestId]: c2.receipt } }));
  refuseIndexFor(sha(PLAN), () => run.prepare(1002));
  assert.deepEqual(run.stored().warnings.map(item => item.plan), [sha(PLAN)]);
  assert.equal(run.status(prepared.requestId, 1003).warnings[0].plan, sha(PLAN));
  run.prepare(1004);
  assert.equal(run.stored().warnings, undefined);
  assert.equal(latestArchivedReadiness({ home: c.home, workspace: d.workspace }, PLAN).recordedAt, 1);
});

test('fifth pass 2: the archived-over-cap warning reaches stored state and decision status, and clears per plan', t => {
  const c = seeded(t);
  const d = decisionHarness(c);
  const run = decisionRun(c, d);
  redirectIndex(c, d);
  const plans = Array.from({ length: 35 }, (_, i) => `docs/plans/q${String(i).padStart(2, '0')}.md`);
  run.seed(plans.map((planPath, i) => readinessFor(d, planPath, 'escalate', i + 1, 20 * 1024)));
  const prepared = run.prepare(1000);
  const stored = run.stored();
  assert.equal(Object.keys(stored.requests).length, 33, '32 readiness requests plus the new action request stay live');
  assert.equal(stored.warnings.length, 16);
  const aggregate = stored.warnings.filter(item => Array.isArray(item.plans));
  assert.equal(aggregate.length, 1, 'the aggregated warning survives the 16-warning bound');
  assert.deepEqual([aggregate[0].requestId, aggregate[0].fault], [null, 'readiness-index']);
  assert.deepEqual(aggregate[0].plans, plans.slice(0, 3).map(sha).sort());
  assert.match(aggregate[0].message, /3 plan\(s\) archived/);
  const status = run.status(prepared.requestId, 1001);
  assert.deepEqual(status.warnings.filter(item => Array.isArray(item.plans)), aggregate);
  assert.equal(status.warnings.length, 16);
  // The fault clears; the kept-live plans index, and an archived plan drops out of the aggregate only once its own index is written.
  fs.unlinkSync(path.join(d.archive, 'readiness'));
  const q00 = readinessFor(d, plans[0], 'escalate', 100);
  const current = run.stored();
  fs.writeFileSync(d.stateFile, JSON.stringify({ ...current, requests: { ...current.requests, [q00.requestId]: q00.request }, receipts: { ...current.receipts, [q00.requestId]: q00.receipt } }));
  run.prepare(1002);
  const after = run.stored().warnings;
  assert.deepEqual(after.map(item => item.plans), [plans.slice(1, 3).map(sha).sort()], 'only the aggregate remains, without the indexed plan');
  assert.match(after[0].message, /2 plan\(s\) archived/);
});
