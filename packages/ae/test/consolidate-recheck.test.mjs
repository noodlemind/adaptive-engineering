import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { consolidateCandidates, consolidateStatus } from '../lib/knowledge/consolidate.mjs';
import { ensureStore, readRecheckConfig, repoId, serializeLearning, storeDir, writeFeedbackConfig, writeRecheckConfig, writeStoreConfig } from '../lib/knowledge/store.mjs';
import { learningVersion, publishFeedbackRecord, recordExposure } from '../lib/learning-feedback.mjs';
import { loadLayeredLearnings } from '../lib/knowledge/overlay.mjs';
import { failureClusterId, recheckState, RECHECK_EXCERPT_CAP, RECHECK_SECTION_CAP } from '../lib/knowledge/recheck.mjs';

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const PLAN_A = 'docs/plans/2026-11-01-a-plan.md', PLAN_B = 'docs/plans/2026-11-02-b-plan.md', PLAN_C = 'docs/plans/2026-11-03-c-plan.md';
const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-recheck-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, 'ws'), home = path.join(root, 'home');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  const put = (rel, text) => {
    const target = path.join(ws, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`);
    return { path: rel, sha256: sha(typeof text === 'string' ? text : '') };
  };
  const { dir } = ensureStore(ws, { home });
  assert.equal(writeStoreConfig(ws, { home, mode: 'on' }).pass, true);
  const learn = (domain, slug, fm = {}, body = 'Retry the delivery once before failing.') => {
    const file = path.join(dir, 'learnings', domain, `${slug}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeLearning({
      trigger: `working on ${slug}`, status: 'active', source: 'auto',
      episodes: [{ path: 'docs/solutions/fix.md', sha256: 'a'.repeat(64), kind: 'fix', plan: PLAN_A }],
      anchors: [], origin: repoId(ws), ...fm,
    }, body));
    return `${domain}/${slug}`;
  };
  const bound = (domain, slug, rel) => {
    const binding = put(rel, `export const ${slug.replace(/-/g, '_')} = 1;\n`);
    return learn(domain, slug, { anchors: [binding.path], applicability_version: 1, source_bindings: [binding] });
  };
  let evidenceSeq = 0;
  const evidence = (plan, checks, verifiedAt = `2026-11-0${(evidenceSeq % 9) + 1}T00:00:${String(evidenceSeq).padStart(2, '0')}.000Z`) => {
    evidenceSeq += 1;
    const record = { plan, outcome: 'failed', verifiedAt, checks };
    const rel = `.harness/evidence/history/${sha(JSON.stringify(record))}.json`;
    put(rel, record);
    return rel;
  };
  const journal = lines => put('.harness/runs.jsonl', `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  const observation = (plan, reviewer, findings) => {
    const packet = sha(`packet:${plan}:${reviewer}:${findings.length}`);
    put(`.harness/reviews/packets/${packet}.json`, { version: 2, plan });
    const input = { packet, results: [{ reviewer, status: 'completed', findings }] };
    put(`.harness/reviews/observations/${sha(JSON.stringify(input))}.json`, input);
  };
  const packet = (extra = {}) => consolidateCandidates({ workspace: ws, home, ...extra });
  const status = () => consolidateStatus({ workspace: ws, home });
  return { root, ws, home, dir, put, learn, bound, evidence, journal, observation, packet, status };
}

/** One instance of every re-check signal, with each recurring signal spanning exactly two plans. */
function seedSignals(f) {
  const stale = f.bound('runtime', 'retry-worker', 'src/worker.mjs');
  f.put('src/worker.mjs', 'export const retry_worker = 2;\n');
  recordExposure({ recordRoot: f.ws, workspace: f.ws, home: f.home, planPath: PLAN_A, delivered: [{ id: stale }], now: new Date('2026-11-05T00:00:00Z') });
  const wrong = f.learn('runtime', 'old-advice');
  recordExposure({ recordRoot: f.ws, workspace: f.ws, home: f.home, planPath: PLAN_B, delivered: [{ id: wrong }] });
  const version = learningVersion(loadLayeredLearnings({ workspace: f.ws, home: f.home }).learnings.find(l => l.id === wrong));
  publishFeedbackRecord({ workspace: f.ws, home: f.home, operation: sha('wrong'), planPath: PLAN_B, captureDate: '2026-11-06', feedback: { recalled: [{ id: wrong, verdict: 'wrong', version }] } });
  const broken = f.learn('runtime', 'cites-gone', {}, 'Follow `runtime/never-existed` and edit `src/removed/thing.mjs`; `runtime/old-advice` and `src/worker.mjs` still exist.');
  const evidenceA = f.evidence(PLAN_A, [{ id: 'unit', status: 'failed', stderr: 'AssertionError: expected 2 to equal 3' }, { id: 'lint', status: 'passed' }]);
  const evidenceB = f.evidence(PLAN_B, [{ id: 'unit', status: 'failed', stderr: 'AssertionError: expected 2 to equal 3 again' }]);
  f.evidence(PLAN_A, [{ id: 'types', status: 'failed', stderr: 'only one plan' }]);
  f.evidence(PLAN_A, [{ id: 'types', status: 'failed', stderr: 'still only one plan' }]);
  f.journal([
    { schema: 1, type: 'run.start', run: 'r1', ts: '2026-11-01T00:00:00.000Z', command: 'verify', plan: PLAN_A },
    { schema: 1, type: 'run.result', run: 'r1', ts: '2026-11-01T00:01:00.000Z', status: 'failed', exitCode: 1, plan: PLAN_A },
    { schema: 1, type: 'run.start', run: 'r2', ts: '2026-11-02T00:00:00.000Z', command: 'verify', plan: PLAN_B },
    { schema: 1, type: 'run.result', run: 'r2', ts: '2026-11-02T00:01:00.000Z', status: 'failed', exitCode: 1, plan: PLAN_B },
    { schema: 1, type: 'run.start', run: 'r3', ts: '2026-11-02T00:00:00.000Z', command: 'gate', plan: PLAN_B },
    { schema: 1, type: 'run.result', run: 'r3', ts: '2026-11-02T00:01:00.000Z', status: 'failed', exitCode: 1, plan: PLAN_B },
  ]);
  const finding = title => ({ file: 'src/worker.mjs', line: 1, title, severity: 'P2', confidence: 0.8, description: 'd', suggested_fix: 's', autofix_class: 'manual', evidence: ['e'] });
  f.observation(PLAN_A, 'correctness', [finding('Retry count is off by one')]);
  f.observation(PLAN_B, 'correctness', [finding(`Retry count leaks ${GITHUB_TOKEN}`)]);
  f.observation(PLAN_A, 'security', [{ ...finding('Single-plan finding'), file: 'src/other.mjs' }]);
  return { stale, wrong, broken, evidenceA, evidenceB };
}

test('with the key off, packet and status bytes are identical whatever re-check records exist', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  const basePacket = JSON.stringify(f.packet()), baseStatus = JSON.stringify(f.status());
  f.evidence(PLAN_A, [{ id: 'unit', status: 'failed', stderr: 'x' }]);
  f.evidence(PLAN_B, [{ id: 'unit', status: 'failed', stderr: 'y' }]);
  f.evidence(PLAN_C, [{ id: 'unit', status: 'failed', stderr: 'z' }]);
  assert.equal(JSON.stringify(f.packet()), basePacket, 'off: records alone change nothing');
  assert.equal(JSON.stringify(f.packet({ recheck: true })), basePacket, 'off: --recheck adds nothing');
  assert.equal(JSON.stringify(f.status()), baseStatus, 'off: status and due unchanged');
  assert.equal(readRecheckConfig(f.ws, { home: f.home }), 'off', 'default is off');

  const g = fixture(t);
  seedSignals(g);
  const seeded = JSON.stringify(g.packet());
  assert.equal(JSON.stringify(g.packet({ recheck: true })), seeded, 'off: every signal present, still no section');
  assert.equal('recheck' in JSON.parse(seeded), false);
  assert.equal('recheck' in g.status(), false);
});

test('suggest: --recheck adds every signal from Harness-owned records and leaves due unchanged', t => {
  const f = fixture(t);
  const ids = seedSignals(f);
  assert.equal(writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' }).pass, true);
  assert.equal('recheck' in f.packet(), false, 'the section needs --recheck');
  const { recheck } = f.packet({ recheck: true });
  assert.equal(recheck.state, 'suggest');

  assert.deepEqual(recheck.stale_exposed, [{ id: ids.stale, changed_paths: [{ path: 'src/worker.mjs', state: 'changed' }], last_exposed: '2026-11-05T00:00:00.000Z', exposures: 1, plan_count: 1 }]);
  assert.deepEqual(recheck.review_required, [ids.wrong], 'review_required is shared with feedback even while feedback is off');

  const unit = recheck.failure_clusters.find(c => c.check === 'unit');
  assert.equal(unit.id, failureClusterId('check:unit'));
  assert.equal(unit.source, 'evidence');
  assert.deepEqual(unit.plans, [PLAN_A, PLAN_B]);
  assert.equal(unit.plan_count, 2);
  assert.equal(unit.failures, 2);
  assert.ok(unit.first_seen < unit.last_seen);
  assert.equal(unit.excerpt, 'AssertionError: expected 2 to equal 3 again', 'the latest failing output is the excerpt');
  assert.deepEqual(unit.evidence.toSorted(), [ids.evidenceA, ids.evidenceB].toSorted());
  const verify = recheck.failure_clusters.find(c => c.command === 'verify');
  assert.equal(verify.source, 'run-journal');
  assert.deepEqual(verify.plans, [PLAN_A, PLAN_B]);
  assert.equal(verify.first_seen, '2026-11-01T00:01:00.000Z');
  assert.equal(verify.last_seen, '2026-11-02T00:01:00.000Z');
  assert.equal(recheck.failure_clusters.some(c => c.check === 'types' || c.command === 'gate' || c.check === 'lint'), false, 'one-plan failures and passed checks are not clusters');

  assert.equal(recheck.finding_clusters.length, 1);
  const [cluster] = recheck.finding_clusters;
  assert.equal(cluster.category, 'correctness');
  assert.equal(cluster.file, 'src/worker.mjs');
  assert.deepEqual(cluster.plans, [PLAN_A, PLAN_B]);
  assert.equal(cluster.findings, 2);
  assert.equal(JSON.stringify(recheck).includes(GITHUB_TOKEN), false, 'finding titles are secret-screened');

  assert.deepEqual(recheck.broken_references, [{ id: ids.broken, references: [{ kind: 'learning', ref: 'runtime/never-existed' }, { kind: 'path', ref: 'src/removed/thing.mjs' }] }]);
  assert.deepEqual(recheck.counts, { stale_exposed: 1, review_required: 1, failure_clusters: 2, finding_clusters: 1, broken_references: 1 });
  assert.equal(recheck.omitted.failure_clusters, 0);

  const status = f.status();
  assert.equal(status.due, false, 'suggest never changes due');
  assert.deepEqual(status.recheck, { state: 'suggest', counts: recheck.counts });
});

test('failure clusters need two distinct plans, are capped per packet and report omissions', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  f.evidence(PLAN_A, [{ id: 'solo', status: 'failed', stderr: 'first' }]);
  f.evidence(PLAN_A, [{ id: 'solo', status: 'failed', stderr: 'second' }]);
  assert.deepEqual(f.packet({ recheck: true }).recheck.failure_clusters, [], 'repeat failures in one plan are not a cluster');
  const total = RECHECK_SECTION_CAP + 3;
  for (let n = 0; n < total; n++) {
    const id = `check-${String(n).padStart(2, '0')}`;
    f.evidence(PLAN_A, [{ id, status: 'failed', stderr: 'a' }]);
    f.evidence(PLAN_B, [{ id, status: 'timeout', message: 'Timed out after 60s' }]);
  }
  const { recheck } = f.packet({ recheck: true });
  assert.equal(recheck.failure_clusters.length, RECHECK_SECTION_CAP);
  assert.equal(recheck.counts.failure_clusters, total);
  assert.equal(recheck.omitted.failure_clusters, 3);
  assert.equal(recheck.contract.planThreshold, 2);
});

test('failing-output excerpts are bounded and secret-scanned', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  f.evidence(PLAN_A, [{ id: 'leaky', status: 'failed', stderr: `token=${GITHUB_TOKEN}` }, { id: 'noisy', status: 'failed', stdout: 'x'.repeat(5000) }]);
  f.evidence(PLAN_B, [{ id: 'leaky', status: 'failed', stderr: `Authorization: Bearer ${'z'.repeat(30)}\nline two ${GITHUB_TOKEN}` }, { id: 'noisy', status: 'failed', stdout: `${'y'.repeat(5000)}\u0000tail` }]);
  const { recheck } = f.packet({ recheck: true });
  const text = JSON.stringify(recheck);
  assert.equal(text.includes(GITHUB_TOKEN), false);
  assert.equal(text.includes('z'.repeat(30)), false);
  assert.match(recheck.failure_clusters.find(c => c.check === 'leaky').excerpt, /^\[redacted: /);
  const noisy = recheck.failure_clusters.find(c => c.check === 'noisy').excerpt;
  assert.ok(noisy.length <= RECHECK_EXCERPT_CAP);
  assert.match(noisy, /tail$/, 'the tail of the output is kept');
  assert.equal(/[\x00-\x1f]/.test(noisy), false, 'control characters are inert');
});

test('on: three stale exposed learnings or a failure cluster across three plans makes consolidation due', t => {
  const f = fixture(t);
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'on' });
  assert.equal(f.status().due, false);
  const stale = ['one', 'two', 'three'].map(name => f.bound('runtime', `stale-${name}`, `src/${name}.mjs`));
  for (const name of ['one', 'two', 'three']) f.put(`src/${name}.mjs`, 'changed\n');
  recordExposure({ recordRoot: f.ws, workspace: f.ws, home: f.home, planPath: PLAN_A, delivered: stale.slice(0, 2).map(id => ({ id })) });
  assert.equal(f.status().due, false, 'two stale exposed learnings are below the rule');
  recordExposure({ recordRoot: f.ws, workspace: f.ws, home: f.home, planPath: PLAN_B, delivered: [{ id: stale[2] }] });
  const due = f.status();
  assert.equal(due.debt < due.threshold, true);
  assert.equal(due.due, true);
  assert.deepEqual(due.nextTools, ['ae consolidate --candidates --recheck']);
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  assert.equal(f.status().due, false, 'the same evidence under suggest is not due');

  const g = fixture(t);
  g.learn('runtime', 'baseline');
  writeRecheckConfig(g.ws, { home: g.home, recheck: 'on' });
  g.evidence(PLAN_A, [{ id: 'unit', status: 'failed' }]);
  g.evidence(PLAN_B, [{ id: 'unit', status: 'failed' }]);
  assert.equal(g.status().due, false, 'a two-plan cluster is evidence, not debt');
  g.evidence(PLAN_C, [{ id: 'unit', status: 'failed' }]);
  assert.equal(g.status().due, true);
});

test('recheck config ladder: unknown values are refused and read as off, knowledge modes override, and the field is recheck', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  assert.equal(writeRecheckConfig(f.ws, { home: f.home, recheck: 'loud' }).pass, false);
  assert.equal(writeRecheckConfig(f.ws, { home: f.home, recheck: 'loud' }).code, 'E_USAGE');
  assert.equal(writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' }).pass, true);
  assert.equal(writeFeedbackConfig(f.ws, { home: f.home, feedback: 'on' }).pass, true);
  const config = path.join(storeDir(f.ws, { home: f.home }), 'config.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')), { mode: 'on', commit: 'none', recheck: 'suggest', feedback: 'on' }, 'each ladder keeps its own field');
  assert.equal(recheckState({ workspace: f.ws, home: f.home }), 'suggest');
  for (const mode of ['freeze', 'capture-only', 'off']) {
    assert.equal(writeStoreConfig(f.ws, { home: f.home, mode }).pass, true);
    assert.equal(recheckState({ workspace: f.ws, home: f.home }), 'off', mode);
    assert.equal('recheck' in f.packet({ recheck: true }), false, `${mode} reads recheck as off`);
  }
  assert.equal(readRecheckConfig(f.ws, { home: f.home }), 'suggest', 'a mode switch keeps the recheck key');
  fs.writeFileSync(config, JSON.stringify({ mode: 'on', recheck: 'maybe' }));
  assert.equal(recheckState({ workspace: f.ws, home: f.home }), 'off');
});
