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
import { failureClusterId, failureExcerpt, recheckState, RECHECK_EXCERPT_CAP, RECHECK_SECTION_CAP } from '../lib/learning-recheck.mjs';
import { parseFlags } from '../lib/flags.mjs';
import { spawnSync } from 'node:child_process';
import { initGit } from './helpers/cli-fixtures.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { runNamedCheck } from '../lib/checks.mjs';
import { deriveGitContext } from '../lib/git-context.mjs';
import { ensureBucket } from '../lib/knowledge/layer.mjs';

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
    // A named check that ran and failed exits nonzero; rows without process output model Harness's gate rows.
    const named = check => check.status === 'failed' && (check.stdout !== undefined || check.stderr !== undefined) && check.exitCode === undefined ? { ...check, exitCode: 1 } : check;
    const record = { plan, outcome: 'failed', verifiedAt, checks: checks.map(named) };
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
  assert.deepEqual(status.recheck, { state: 'suggest' }, 'suggest status names the state without paying for the scan');
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
    f.evidence(PLAN_B, [{ id, status: 'timeout', message: 'Timed out after 60s', stdout: '' }]);
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
  assert.match(recheck.failure_clusters.find(c => c.check === 'leaky').excerpt, /\[redacted: (github-token|bearer-token)\]/, 'secrets are masked in place');
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
  g.evidence(PLAN_A, [{ id: 'unit', status: 'failed', exitCode: 1 }]);
  g.evidence(PLAN_B, [{ id: 'unit', status: 'failed', exitCode: 1 }]);
  assert.equal(g.status().due, false, 'a two-plan cluster is evidence, not debt');
  g.evidence(PLAN_C, [{ id: 'unit', status: 'failed', exitCode: 1 }]);
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

// Independent review regressions (R1-R7 from the PR #126 review).

test('R1: built-in gate rows are not failure evidence, so they never make consolidation due', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'on' });
  for (const plan of [PLAN_A, PLAN_B, PLAN_C]) f.evidence(plan, [{ id: 'phase-tasks', status: 'failed', message: '2 current phase tasks remain open' }, { id: 'required-reviews', status: 'failed', message: 'missing' }]);
  const status = f.status();
  assert.equal(status.due, false);
  assert.equal(status.recheck.counts.failure_clusters, 0);
});

test('R2: a long evidence history keeps its newest records by their own timestamp, even after a restore resets mtimes', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'on' });
  const rels = [];
  for (let i = 0; i < 600; i++) rels.push(f.evidence(`docs/plans/p${i}.md`, [{ id: 'lint', status: 'passed' }], `2026-10-01T00:00:00.${String(i).padStart(3, '0')}Z`));
  for (const [n, plan] of [PLAN_A, PLAN_B, PLAN_C].entries()) rels.push(f.evidence(plan, [{ id: 'unit', status: 'failed', stderr: 'boom' }], `2026-11-0${n + 1}T00:00:00.000Z`));
  const restored = new Date('2026-01-01T00:00:00Z');
  for (const rel of rels) fs.utimesSync(path.join(f.ws, rel), restored, restored);
  const status = f.status();
  assert.equal(status.recheck.counts.failure_clusters, 1, 'the newest records by verifiedAt are read');
  assert.equal(status.due, true);
});

test('hand-written history records whose name is not their digest cannot force due', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'on' });
  for (const [n, plan] of [PLAN_A, PLAN_B, PLAN_C].entries()) f.put(`.harness/evidence/history/${String(n).repeat(64)}.json`, { plan, verifiedAt: `2026-11-0${n + 1}T00:00:00.000Z`, checks: [{ id: 'unit', status: 'failed', exitCode: 1, stderr: 'forged' }] });
  for (const plan of [PLAN_A, PLAN_B, PLAN_C]) f.put(`.harness/evidence/${path.basename(plan, '.md')}.json`, { plan, verifiedAt: '2026-11-05T00:00:00.000Z', checks: [{ id: 'unit', status: 'failed', exitCode: 1, stderr: 'latest only' }] });
  const status = f.status();
  assert.equal(status.recheck.counts.failure_clusters, 0);
  assert.equal(status.due, false);
});

test('a passing process Harness later marked failed is not failure evidence', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'on' });
  for (const plan of [PLAN_A, PLAN_B, PLAN_C]) f.evidence(plan, [{ id: 'domain-joint:repo:unit', status: 'failed', exitCode: 0, stdout: 'ok', message: 'The integrated check changed or removed the controller revision manifest' }]);
  assert.equal(f.status().recheck.counts.failure_clusters, 0);
});

test('R3: prose, refs and package names are not broken paths; anchors resolve package-relative paths', t => {
  const f = fixture(t);
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  f.put('packages/ae/test/foo.test.mjs', 'x');
  f.learn('runtime', 'prose', {}, 'Rebase on `origin/main`, import `@anthropic-ai/sdk`, send `application/json`, use `and/or`, see `noodlemind/adaptive-engineering`, run in `packages/ae` with `test/foo.test.mjs`.');
  assert.deepEqual(f.packet({ recheck: true }).recheck.broken_references, []);
  const anchored = f.put('packages/ae/lib/thing.mjs', 'export const thing = 1;\n');
  const id = f.learn('runtime', 'anchored', { anchors: [anchored.path] }, 'Cover it in `test/foo.test.mjs`, not `test/gone.test.mjs`.');
  assert.deepEqual(f.packet({ recheck: true }).recheck.broken_references, [{ id, references: [{ kind: 'path', ref: 'test/gone.test.mjs' }] }]);
});

test('R4: excerpts are masked over the whole output before the tail is taken', () => {
  const password = 'S3cr3tPassw0rdValue';
  const cut = failureExcerpt({ stderr: `${'x'.repeat(1000)} connecting postgres://admin:${password}@db.internal:5432/app ${'y'.repeat(355)}` });
  assert.equal(cut.includes(password.slice(-6)), false, 'no fragment survives the cut');
  assert.ok(cut.length <= RECHECK_EXCERPT_CAP);
  const whole = failureExcerpt({ stderr: `failed: postgres://admin:${password}@db.internal:5432/app` });
  assert.match(whole, /^failed: \[redacted: connection-string\]/, 'the surrounding text is kept');
  assert.equal(whole.includes(password), false);
  const key = `-----BEGIN RSA PRIVATE KEY-----\n${'MIIEowIBAAKCAQEA'.repeat(60)}\n-----END RSA PRIVATE KEY-----`;
  assert.equal(failureExcerpt({ stderr: key }), '[withheld: private-key]');
});

test('R5: --derived-from without a value parses as empty and is refused, not dropped', () => {
  assert.equal(parseFlags(['--insight', '--title', 't', '--derived-from']).derivedFrom, '');
});

test('R6: a symlinked run journal is not followed', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  const outside = path.join(f.root, 'outside.jsonl');
  const lines = [];
  for (const [i, plan] of [PLAN_A, PLAN_B].entries()) {
    lines.push({ type: 'run.start', run: `x${i}`, command: 'OUTSIDE-FILE-CONTENT', plan, ts: '2026-11-01T00:00:00Z' });
    lines.push({ type: 'run.result', run: `x${i}`, status: 'failed', ts: '2026-11-01T00:00:01Z' });
  }
  fs.writeFileSync(outside, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  fs.mkdirSync(path.join(f.ws, '.harness'), { recursive: true });
  fs.symlinkSync(outside, path.join(f.ws, '.harness/runs.jsonl'));
  assert.deepEqual(f.packet({ recheck: true }).recheck.failure_clusters, []);
});

test('R7: clusters rank by full plan count, so the widest is never the one omitted', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  for (let p = 0; p < 30; p++) f.evidence(`docs/plans/wide-${p}.md`, [{ id: 'wide', status: 'failed', stderr: 'wide' }], `2026-01-01T00:00:${String(p).padStart(2, '0')}.000Z`);
  for (let c = 0; c < 10; c++) for (let p = 0; p < 5; p++) f.evidence(`docs/plans/n${c}-${p}.md`, [{ id: `narrow-${c}`, status: 'failed', stderr: 'n' }], `2026-11-01T00:00:${String(c * 5 + p).padStart(2, '0')}.000Z`);
  const { recheck } = f.packet({ recheck: true });
  assert.deepEqual([recheck.failure_clusters[0].check, recheck.failure_clusters[0].plan_count], ['wide', 30]);
  assert.equal(recheck.failure_clusters[0].plans.length, 5, 'the listed plans stay bounded');
  assert.equal(recheck.omitted.failure_clusters, 1);
  assert.equal(recheck.max_cluster_plans, 30);
});

test('run-journal clusters are context only and never make consolidation due', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'on' });
  f.journal([PLAN_A, PLAN_B, PLAN_C].flatMap((plan, i) => [
    { schema: 1, type: 'run.start', run: `j${i}`, ts: `2026-11-0${i + 1}T00:00:00.000Z`, command: 'verify', plan },
    { schema: 1, type: 'run.result', run: `j${i}`, ts: `2026-11-0${i + 1}T00:01:00.000Z`, status: 'failed', exitCode: 1, plan },
  ]));
  const status = f.status();
  assert.equal(status.recheck.counts.failure_clusters, 1);
  assert.equal(status.due, false);
});

test('status and packet see the same golden plus branch learnings', t => {
  const f = fixture(t);
  initGit(f.ws);
  assert.equal(spawnSync('git', ['switch', '-c', 'feature/recheck-layers'], { cwd: f.ws }).status, 0);
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'on' });
  f.learn('runtime', 'golden-claim');
  const context = deriveGitContext({ workspace: f.ws, home: f.home });
  const bucket = ensureBucket(f.dir, { key: context.branchKey, branch: context.branch });
  const file = path.join(bucket, 'learnings/runtime/branch-claim.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeLearning({ trigger: 'branch work', status: 'active', source: 'auto', episodes: [{ path: 'docs/solutions/fix.md', sha256: 'a'.repeat(64), kind: 'fix', plan: PLAN_A }], anchors: [], origin: repoId(f.ws) },
    'Builds on `runtime/golden-claim`; see `runtime/missing-claim`.'));
  const packet = consolidateCandidates({ workspace: f.ws, home: f.home, recheck: true, writeLayer: true });
  assert.deepEqual(packet.recheck.broken_references, [{ id: 'runtime/branch-claim', references: [{ kind: 'learning', ref: 'runtime/missing-claim' }] }], 'a branch learning citing a golden learning is not broken');
  assert.deepEqual(f.status().recheck.counts, packet.recheck.counts);
});

// Second review pass.

test('a subordinate branch twin is not listed twice, and a retired branch learning is a valid reference target', t => {
  const f = fixture(t);
  initGit(f.ws);
  assert.equal(spawnSync('git', ['switch', '-c', 'feature/recheck-twins'], { cwd: f.ws }).status, 0);
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  const body = 'See `runtime/missing-claim` and `runtime/retired-branch`.';
  f.learn('runtime', 'protected', { source: 'human' }, body);
  const context = deriveGitContext({ workspace: f.ws, home: f.home });
  const bucket = ensureBucket(f.dir, { key: context.branchKey, branch: context.branch });
  const write = (slug, fm, text) => {
    const file = path.join(bucket, `learnings/runtime/${slug}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeLearning({ trigger: slug, status: 'active', source: 'auto', episodes: [{ path: 'docs/solutions/fix.md', sha256: 'a'.repeat(64), kind: 'fix', plan: PLAN_A }], anchors: [], origin: repoId(f.ws), ...fm }, text));
  };
  write('protected', {}, body);
  write('retired-branch', { status: 'retired' }, 'Old claim.');
  const { recheck } = consolidateCandidates({ workspace: f.ws, home: f.home, recheck: true, writeLayer: true });
  assert.deepEqual(recheck.broken_references, [{ id: 'runtime/protected', references: [{ kind: 'learning', ref: 'runtime/missing-claim' }] }]);
});

test('an oversized run journal contributes its newest records and says it was truncated', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  const filler = `${JSON.stringify({ schema: 1, type: 'journal.pruned', ts: '2026-01-01T00:00:00.000Z', removed: 0, reason: 'x'.repeat(200) })}\n`;
  const tail = [PLAN_A, PLAN_B].flatMap((plan, i) => [
    { schema: 1, type: 'run.start', run: `t${i}`, ts: '2026-11-01T00:00:00.000Z', command: 'verify', plan },
    { schema: 1, type: 'run.result', run: `t${i}`, ts: '2026-11-01T00:01:00.000Z', status: 'failed', exitCode: 1, plan },
  ]).map(line => JSON.stringify(line)).join('\n');
  fs.mkdirSync(path.join(f.ws, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(f.ws, '.harness/runs.jsonl'), `${filler.repeat(Math.ceil((9 * 1024 * 1024) / filler.length))}${tail}\n`);
  const { recheck } = f.packet({ recheck: true });
  assert.deepEqual(recheck.failure_clusters.map(c => c.command), ['verify']);
  assert.match(recheck.omitted.journal, /newest 8 MiB/);
});

test('excerpt masking stays fast on very long output', () => {
  // `a-a-a-...api` backtracks superlinearly in the generic-api-key pattern; 8k chars already take tens of milliseconds unbounded.
  // Spaces split it into 1,000-char runs so the long-token rule does not withhold it before masking.
  const long = `${`${'a-'.repeat(500)} `.repeat(1000)}api`;
  const started = performance.now();
  const excerpt = failureExcerpt({ stderr: long });
  assert.ok(performance.now() - started < 1000, 'masking is bounded');
  assert.ok(excerpt.length <= RECHECK_EXCERPT_CAP);
});

test('whitespace padding cannot push a secret keyword out of the masking window while its value stays in the tail', () => {
  const secret = 'Zq8xY7wV6uT5sR4qP3oN2m';
  const token = 'eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop';
  for (const pad of [' ', '\n', '\t \r\n']) {
    const clientSecret = failureExcerpt({ stderr: `client_secret=${pad.repeat(5000)}${secret} done` });
    assert.equal(clientSecret.includes(secret), false, `client_secret value leaked with ${JSON.stringify(pad)} padding`);
    assert.match(clientSecret, /\[redacted: [a-z-]+\] done$/);
    const bearer = failureExcerpt({ stderr: `Authorization: Bearer${pad.repeat(5000)}${token} done` });
    assert.equal(bearer.includes(token), false, `bearer token leaked with ${JSON.stringify(pad)} padding`);
    assert.match(bearer, /\[redacted: [a-z-]+\] done$/);
  }
});

test('the history preselect reads the newest 1,024 names by mtime and counts the rest as omitted', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'on' });
  const old = new Date('2026-01-01T00:00:00Z'), recent = new Date('2026-06-01T00:00:00Z');
  const failing = [PLAN_A, PLAN_B, PLAN_C].map((plan, n) => f.evidence(plan, [{ id: 'unit', status: 'failed', stderr: 'boom' }], `2026-11-0${n + 1}T00:00:00.000Z`));
  const fillers = [];
  for (let i = 0; i < 1100; i++) fillers.push(f.evidence(`docs/plans/p${i}.md`, [{ id: 'lint', status: 'passed' }], `2026-10-01T00:00:${String(Math.floor(i / 1000)).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')}Z`));
  const total = failing.length + fillers.length;
  const stamp = (rels, at) => { for (const rel of rels) fs.utimesSync(path.join(f.ws, rel), at, at); };

  stamp(fillers, old);
  stamp(failing, recent);
  let status = f.status();
  assert.equal(status.recheck.counts.failure_clusters, 1, 'recently written failures are preselected and ranked first');
  assert.equal(status.due, true);
  assert.equal(f.packet({ recheck: true }).recheck.omitted.scannedRecords, total - 512, 'names past the preselect and records past the cap are both counted');

  stamp(fillers, recent);
  stamp(failing, old);
  status = f.status();
  assert.equal(status.recheck.counts.failure_clusters, 0, 'names outside the newest 1,024 by mtime are never opened');
  assert.equal(f.packet({ recheck: true }).recheck.omitted.scannedRecords, total - 512);
});

test('exposure records past the cap are reported as omitted', t => {
  const f = fixture(t);
  const id = f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  for (let i = 0; i < 515; i++) {
    const plan = `docs/plans/e${i}.md`;
    f.put(`.harness/learning/exposures/plan-${sha(plan)}.json`, { version: 1, plan, entries: [{ id, count: 1, lastExposedAt: `2026-10-01T00:00:00.${String(i).padStart(3, '0')}Z` }] });
  }
  assert.equal(f.packet({ recheck: true }).recheck.omitted.exposureRecords, 3);
  const g = fixture(t);
  g.learn('runtime', 'baseline');
  writeRecheckConfig(g.ws, { home: g.home, recheck: 'suggest' });
  assert.equal('exposureRecords' in g.packet({ recheck: true }).recheck.omitted, false, 'nothing omitted, no key');
});

test('evidence written by a real named check and writeEvidence clusters across plans', async t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  for (const plan of [PLAN_A, PLAN_B]) {
    const check = await runNamedCheck(f.ws, 'unit', { command: [process.execPath, '-e', 'console.error("retry count wrong"); process.exit(3)'] }, { home: f.home });
    assert.equal(check.status, 'failed', JSON.stringify(check));
    assert.equal(check.exitCode, 3);
    assert.ok(writeEvidence(f.ws, { plan, outcome: 'failed', checks: [check] }));
  }
  const [cluster, ...rest] = f.packet({ recheck: true }).recheck.failure_clusters;
  assert.deepEqual(rest, []);
  assert.equal(cluster.id, failureClusterId('check:unit'));
  assert.equal(cluster.plan_count, 2);
  assert.match(cluster.excerpt, /retry count wrong/);
});

test('ANSI colour codes between a keyword and its value do not defeat masking', () => {
  const key = 'Zq8xY7wV6uT5sR4qP3oN2m';
  const token = 'eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop';
  const apiKey = failureExcerpt({ stderr: `failed: api_key=\x1b[1m${key}\x1b[0m done` });
  assert.equal(apiKey.includes(key), false, apiKey);
  const bearer = failureExcerpt({ stderr: `failed: Bearer \x1b[33m${token}\x1b[0m done` });
  assert.equal(bearer.includes(token), false, bearer);
  assert.equal(/\x1b/.test(apiKey + bearer), false, 'no escape bytes reach the excerpt');
});

test('a secret longer than the masking window is withheld whole, not leaked by its tail', () => {
  const clientSecret = failureExcerpt({ stderr: `client_secret=${'Zx9'.repeat(1100)} done` });
  assert.equal(clientSecret.includes('Zx9Zx9'), false, clientSecret);
  assert.match(clientSecret, /\[withheld: long-token\] done$/);
  const bearer = failureExcerpt({ stderr: `Authorization: Bearer ${'q'.repeat(3300)} done` });
  assert.equal(bearer.includes('qqqq'), false, bearer);
  assert.match(bearer, /\[withheld: long-token\] done$/);
  assert.equal(failureExcerpt({ stderr: `short ${'w'.repeat(1023)} ok` }).includes('w'.repeat(300)), true, 'runs under the threshold are kept');
});

test('masking catches a connection string whose user part looks like another secret', () => {
  const password = 'S3cr3tPassw0rdValue';
  const excerpt = failureExcerpt({ stderr: `failed: postgres://AKIAABCDEFGHIJKLMNOP:${password}@db.internal/app` });
  assert.equal(excerpt.includes(password), false, excerpt);
});

test('every ANSI escape form and zero-width character between a keyword and its value is stripped before masking', () => {
  const key = 'Zq8xY7wV6uT5sR4qP3oN2m';
  const token = 'eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop';
  const forms = {
    'colon-separated SGR': '\x1b[38:5:196m',
    'private-parameter CSI': '\x1b[>4;2m',
    'tput sgr0 reset': '\x1b(B\x1b[m',
    '8-bit CSI': '\x9b1m',
    'OSC 8 hyperlink': '\x1b]8;;https://example.test/x\x07',
    'OSC terminated by ST': '\x1b]0;title\x1b\\',
    'zero-width space': '\u200b',
    'zero-width joiner': '\u200d',
    'word joiner': '\u2060',
    'byte-order mark': '\ufeff',
  };
  for (const [name, seq] of Object.entries(forms)) {
    const apiKey = failureExcerpt({ stderr: `failed: api_key=${seq}${key} done` });
    assert.equal(apiKey.includes(key), false, `${name}: ${JSON.stringify(apiKey)}`);
    const bearer = failureExcerpt({ stderr: `failed: Bearer ${seq}${token} done` });
    assert.equal(bearer.includes(token), false, `${name}: ${JSON.stringify(bearer)}`);
    assert.equal(/[\x1b\x9b\x9d\x07]/.test(apiKey + bearer), false, `${name}: no escape bytes reach the excerpt`);
  }
});

test('escape stripping stays fast on 1 MiB of unterminated escape introducers', () => {
  for (const long of ['\x1b['.repeat(512 * 1024), '\x1b]'.repeat(512 * 1024), `\x1b[${'1;'.repeat(512 * 1024)}`, `\x1b]${'x'.repeat(1024 * 1024)}`]) {
    const started = performance.now();
    const excerpt = failureExcerpt({ stderr: `${long} tail` });
    assert.ok(performance.now() - started < 1000, 'stripping is bounded');
    assert.ok(excerpt === null || excerpt.length <= RECHECK_EXCERPT_CAP);
  }
});

test('C1: an escape or invisible character inside a private-key header still withholds the key body', () => {
  const body = 'MIIEowIBAAKCAQEAsecretkeybody';
  for (const header of [
    '-----BEGIN PRIVATE \x1b[31mKEY-----',
    '-----BEGIN RSA PRIVATE\x1b[0m KEY-----',
    '-----BEGIN PRIVATE​KEY-----',
    '-----BEGIN PRIVATE ­KEY-----',
    '-----BEGIN PRIVATE\x1bKEY-----',
    '-----BEGIN ＰＲＩＶＡＴＥ ＫＥＹ-----',
  ]) {
    // No END line: the header alone must withhold the body.
    assert.equal(failureExcerpt({ stderr: `${header}\n${body}` }), '[withheld: private-key]', JSON.stringify(header));
  }
});

test('C2: a credential whose prefix matches another pattern is masked whole in the excerpt', () => {
  const rest = '-SensitiveRemainingCredentialValue';
  for (const stderr of [`failed: client_secret=AKIAABCDEFGHIJKLMNOP${rest} done`, `failed: Authorization: Bearer AKIAABCDEFGHIJKLMNOP${rest} done`]) {
    const excerpt = failureExcerpt({ stderr });
    assert.equal(excerpt.includes('Sensitive'), false, excerpt);
    assert.match(excerpt, /^failed: .*\[redacted: [a-z-]+\] done$/);
  }
});

test('R1: masking shrinkage cannot pull a value whose keyword was cut off the window into the tail', () => {
  const jwt = `eyJ${'a'.repeat(250)}.${'b'.repeat(250)}.${'c'.repeat(270)}`;
  const secret = 'SuperSecretValue1234567890abcdef';
  const excerpt = failureExcerpt({ stderr: `${'x '.repeat(3000)}Authorization: Bearer ${secret} ${'y'.repeat(57)}${` ${jwt}`.repeat(4)}` });
  assert.equal(excerpt.includes(secret.slice(0, 12)), false, excerpt);
  assert.equal(excerpt.includes('earer'), false, excerpt);
  assert.ok(excerpt.length <= RECHECK_EXCERPT_CAP);
  // Slide the cut across the keyword context and the value: no offset leaks any part of the value.
  for (let shift = 0; shift < 80; shift += 1) {
    for (const lead of [`Authorization: Bearer ${secret}`, `Authorization: Basic ${secret}`, `client_secret = "${secret}`, `Authorization" : "Basic ${secret}`]) {
      const out = failureExcerpt({ stderr: `${'x '.repeat(3000)}${'z'.repeat(shift)} ${lead} ${'y'.repeat(57)}${` ${jwt}`.repeat(4)}` });
      assert.equal(out?.includes('SuperSecret') || out?.includes('7890abcdef'), false, `shift ${shift}: ${out}`);
    }
  }
  // An uncut window keeps its head.
  assert.equal(failureExcerpt({ stderr: `head Bearer ${secret} ${jwt}` }), 'head [redacted: bearer-token] [redacted: jwt]');
});

test('R3: invisible characters and fullwidth forms inside a keyword do not split it from its value', () => {
  const key = 'Zq8xY7wV6uT5sR4qP3oN2m';
  const token = 'eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop';
  const invisibles = { 'zero-width space': '​', 'soft hyphen': '­', 'LRE': '‪', 'RLO': '‮', 'LRI': '⁦', 'PDI': '⁩', 'variation selector': '️', 'Hangul filler': 'ㅤ' };
  for (const [name, ch] of Object.entries(invisibles)) {
    for (const stderr of [`failed: api${ch}_key=${key} done`, `failed: client${ch}_secret${ch}=${ch}${key} done`, `failed: Bea${ch}rer ${token} done`, `failed: x${ch}Bearer ${token} done`]) {
      const excerpt = failureExcerpt({ stderr });
      assert.equal(excerpt.includes(key) || excerpt.includes(token), false, `${name}: ${JSON.stringify(excerpt)}`);
      assert.equal(excerpt.includes(ch), false, `${name}: removed from the excerpt`);
    }
  }
  const fullwidth = failureExcerpt({ stderr: `failed: api_key＝${key} done` });
  assert.equal(fullwidth, 'failed: [redacted: generic-api-key] done');
  assert.equal(failureExcerpt({ stderr: 'tab\tand\nnew\r\nline kept apart' }), 'tab and new line kept apart', 'real whitespace still separates words');
});

test('R2: a very long finding title is capped before it is screened, and a secret cut by the cap stays hidden', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'on' });
  const finding = title => ({ file: 'src/slow.mjs', line: 1, title, severity: 'P2', confidence: 0.8, description: 'd', suggested_fix: 's', autofix_class: 'manual', evidence: ['e'] });
  f.observation(PLAN_A, 'correctness', [finding(`Slow title ${'a-'.repeat(100000)}`)]);
  f.observation(PLAN_B, 'correctness', [finding(`Cut secret ghp_${'A1b2C3d4E5'.repeat(60)}`)]);
  const started = performance.now();
  f.status();
  assert.ok(performance.now() - started < 1000, 'a 200k title is screened in bounded time');
  const [cluster] = f.packet({ recheck: true }).recheck.finding_clusters;
  assert.equal(cluster.file, 'src/slow.mjs');
  assert.ok(cluster.titles.every(title => title.length <= 120));
  assert.ok(cluster.titles.some(title => title.startsWith('Slow title a-a-')));
  assert.equal(JSON.stringify(cluster).includes('A1b2C3d4E5'), false, 'the secret the cap cuts is still redacted');
  assert.ok(cluster.titles.includes('[redacted: github-token]'));
});
