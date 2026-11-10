import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { consolidateCandidates, consolidateStatus } from '../lib/knowledge/consolidate.mjs';
import { appendLedger, ensureStore, readRecheckConfig, repoId, serializeLearning, storeDir, writeFeedbackConfig, writeRecheckConfig, writeStoreConfig } from '../lib/knowledge/store.mjs';
import { learningVersion, publishFeedbackRecord, recordExposure } from '../lib/learning-feedback.mjs';
import { loadLayeredLearnings } from '../lib/knowledge/overlay.mjs';
import { FAILURE_CLUSTER_REF, FINDING_CLUSTER_REF, failureClusterId, failureMetadata, recheckState, RECHECK_DIR_ENTRY_CAP, RECHECK_SECTION_CAP, RECHECK_STATUS_PRESELECT } from '../lib/learning-recheck.mjs';
import { parseFlags } from '../lib/flags.mjs';
import { spawnSync } from 'node:child_process';
import { initGit } from './helpers/cli-fixtures.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { runNamedCheck } from '../lib/checks.mjs';
import { deriveGitContext } from '../lib/git-context.mjs';
import { ensureBucket } from '../lib/knowledge/layer.mjs';
import { runInsightCompound } from '../lib/compound.mjs';
import { externalPlansDir, normalizePlanRel } from '../lib/project-layout.mjs';
// The CLI loads the command registry before any command runs; journal commands are shown only when it names them.
import '../lib/registry.mjs';

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const PLAN_A = 'docs/plans/2026-11-01-a-plan.md', PLAN_B = 'docs/plans/2026-11-02-b-plan.md', PLAN_C = 'docs/plans/2026-11-03-c-plan.md';
const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const DECLARED_CHECKS = ['unit', 'lint', 'types', 'slow', 'solo', 'early', 'late', 'near', 'wide', 'leaky', 'pkg/unit:fast-1.2_x', 'constructor', 'toString', 'hasOwnProperty'];
const DIGEST_CHECK = /^\[check:[a-f0-9]{12}\]$/, DIGEST_REVIEWER = /^\[reviewer:[a-f0-9]{12}\]$/, DIGEST_PATH = /^\[unnamed:[a-f0-9]{12}\]$/;

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
  // Check names are shown only when the checks configuration declares them, and plans only when the file exists.
  put('.github/harness/checks.yaml', `version: 1\nchecks:\n${DECLARED_CHECKS.map(id => `  ${JSON.stringify(id)}:\n    argv: [node, --version]\n`).join('')}`);
  for (const plan of [PLAN_A, PLAN_B, PLAN_C]) put(plan, `# ${plan}\n`);
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
  f.observation(PLAN_A, 'architecture-strategist', [finding('Retry count is off by one')]);
  f.observation(PLAN_B, 'architecture-strategist', [finding(`Retry count leaks ${GITHUB_TOKEN}`)]);
  f.observation(PLAN_A, 'security-sentinel', [{ ...finding('Single-plan finding'), file: 'src/other.mjs' }]);
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
  assert.equal('excerpt' in unit, false, 'no failing output is shown');
  assert.deepEqual(unit.failure_records.map(r => r.stderr_lines), [1, 1]);
  assert.equal(unit.failure_records[0].at, unit.last_seen, 'newest record first');
  assert.notEqual(unit.failure_records[0].output_sha256, unit.failure_records[1].output_sha256, 'different output, different hash');
  assert.deepEqual(unit.failure_records[0], { check: 'unit', status: 'failed', exit_code: 1, signal: null, at: unit.last_seen, stdout_lines: 0, stderr_lines: 1, output_sha256: unit.failure_records[0].output_sha256 });
  assert.match(unit.failure_records[0].output_sha256, /^[a-f0-9]{12}$/);
  assert.match(unit.hint, /ae checks run unit/);
  assert.equal(unit.evidence_count, 2, 'the cluster counts its evidence records');
  assert.equal('evidence' in unit, false, 'evidence record paths (which hold retained output) are not listed');
  assert.equal(JSON.stringify(recheck).includes(ids.evidenceA), false);
  const verify = recheck.failure_clusters.find(c => c.command === 'verify');
  assert.equal(verify.source, 'run-journal');
  assert.deepEqual(verify.plans, [PLAN_A, PLAN_B]);
  assert.equal(verify.first_seen, '2026-11-01T00:01:00.000Z');
  assert.equal(verify.last_seen, '2026-11-02T00:01:00.000Z');
  assert.equal(recheck.failure_clusters.some(c => c.check === 'types' || c.command === 'gate' || c.check === 'lint'), false, 'one-plan failures and passed checks are not clusters');

  assert.equal(recheck.finding_clusters.length, 1);
  const [cluster] = recheck.finding_clusters;
  assert.equal(cluster.category, 'architecture-strategist');
  assert.equal(cluster.file, 'src/worker.mjs');
  assert.deepEqual(cluster.plans, [PLAN_A, PLAN_B]);
  assert.equal(cluster.findings, 2);
  assert.equal(JSON.stringify(recheck).includes(GITHUB_TOKEN), false, 'finding titles are never shown');
  assert.equal(JSON.stringify(recheck).includes('Retry count'), false, 'not even a clean title is shown');
  assert.deepEqual(cluster.samples.map(sample => sample.title_sha256).toSorted(), [sha('Retry count is off by one'), sha(`Retry count leaks ${GITHUB_TOKEN}`)].map(hash => hash.slice(0, 12)).toSorted());
  assert.ok(cluster.samples.every(sample => sample.severity === 'P2' && sample.line === 1));

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
  // The packet path preselects 1,024 names by mtime; with every mtime reset, all 603 are read and ranked by verifiedAt.
  const { recheck } = f.packet({ recheck: true });
  assert.equal(recheck.counts.failure_clusters, 1, 'the newest records by verifiedAt are read');
  assert.equal(recheck.failure_clusters[0].plan_count, 3);
  // Due reads only the status window (the newest 128 names by mtime), so the packet and status agree on it.
  const status = f.status();
  assert.equal(recheck.max_cluster_plans >= 3, status.due, 'the packet and status agree about due');
  assert.equal(recheck.due_clusters.length > 0, status.due);
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

test('R5: --derived-from without a value parses as empty and is refused, not dropped', t => {
  const flags = parseFlags(['--insight', '--title', 't', '--body', 'b', '--derived-from']);
  assert.equal(flags.derivedFrom, '');
  const f = fixture(t);
  const refused = runInsightCompound({ workspace: f.ws, copilotHome: path.join(f.root, 'copilot'), home: f.home, log: () => {}, flags });
  assert.equal(refused.pass, false);
  assert.equal(refused.exitCode, 2);
  assert.match(refused.blockedReason, /failure-cluster:<id>/);
  assert.equal(refused.path, null, 'nothing is written');
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
  assert.equal(f.packet({ recheck: true }).recheck.counts.failure_clusters, 1, 'the packet lists the journal cluster');
  const status = f.status();
  assert.equal(status.recheck.counts.failure_clusters, 0, 'status counts only named-check evidence clusters, which decide due');
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
  // Status computes only what due reads; those counts match the packet's.
  const { stale_exposed, review_required, failure_clusters } = packet.recheck.counts;
  assert.deepEqual(f.status().recheck.counts, { stale_exposed, review_required, failure_clusters });
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
  assert.equal(JSON.stringify(cluster).includes('retry count wrong'), false, 'output is never shown');
  assert.deepEqual(cluster.failure_records.map(r => [r.exit_code, r.stderr_lines, r.stdout_lines]), [[3, 1, 0], [3, 1, 0]]);
  assert.equal(cluster.failure_records[0].output_sha256, cluster.failure_records[1].output_sha256, 'identical output, identical hash');
});

test('F6: callers that skip re-check pay nothing for it and keep the rest of the status', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'on' });
  for (const plan of [PLAN_A, PLAN_B, PLAN_C]) f.evidence(plan, [{ id: 'unit', status: 'failed', stderr: 'boom' }]);
  const full = consolidateStatus({ workspace: f.ws, home: f.home });
  assert.equal(full.due, true);
  assert.equal(full.recheck.counts.failure_clusters, 1);
  const light = consolidateStatus({ workspace: f.ws, home: f.home, withRecheck: false });
  assert.deepEqual(light.recheck, { state: 'on' });
  assert.equal(light.due, false, 'without the scan, re-check adds nothing to due');
  assert.deepEqual({ ...light, recheck: undefined, due: undefined, nextTools: undefined }, { ...full, recheck: undefined, due: undefined, nextTools: undefined });
});

// Recheck shows structured metadata only: no raw check output and no finding title text.

const RAW_SECRETS = {
  csi: '\x1b[Password: hunter2',
  curl: 'curl -u admin:hunter2pass https://example.test/api',
  cookie: 'Cookie: sid=31d4d96e407aad42; theme=dark',
  github: `token ${GITHUB_TOKEN}`,
  pem: `-----BEGIN RSA PRIVATE KEY-----\n${'MIIEowIBAAKCAQEA'.repeat(4)}\n-----END RSA PRIVATE KEY-----`,
};
const assertNoRaw = (json, label) => {
  for (const needle of ['hunter2', GITHUB_TOKEN, GITHUB_TOKEN.slice(4, 16), 'sid=', 'Password', 'Cookie', 'PRIVATE KEY', 'MIIEowIBAAKCAQEA', 'admin:']) {
    assert.equal(json.includes(needle), false, `${label}: ${needle} must not appear`);
  }
};

test('failing check output never appears in the packet or status: only metadata', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'on' });
  const stdout = Object.values(RAW_SECRETS).join('\n');
  const stderr = `${RAW_SECRETS.csi}\n${RAW_SECRETS.curl}\r\n${RAW_SECRETS.cookie}\n`;
  for (const plan of [PLAN_A, PLAN_B, PLAN_C]) f.evidence(plan, [{ id: 'leaky', status: 'failed', stdout, stderr, message: RAW_SECRETS.cookie }]);
  f.evidence(PLAN_A, [{ id: 'slow', status: 'timeout', stdout: RAW_SECRETS.github, message: 'Timed out after 60s' }]);
  f.evidence(PLAN_B, [{ id: 'slow', status: 'timeout', stderr: RAW_SECRETS.curl }]);
  const packet = f.packet({ recheck: true }), status = f.status();
  assertNoRaw(JSON.stringify(packet), 'packet');
  assertNoRaw(JSON.stringify(status), 'status');
  assert.equal(status.due, true);
  const leaky = packet.recheck.failure_clusters.find(c => c.check === 'leaky');
  assert.equal(leaky.failure_records.length, 3);
  for (const record of leaky.failure_records) {
    assert.deepEqual(Object.keys(record), ['check', 'status', 'exit_code', 'signal', 'at', 'stdout_lines', 'stderr_lines', 'output_sha256']);
    assert.equal(record.stdout_lines, stdout.split('\n').length);
    assert.equal(record.stderr_lines, 3, 'a trailing newline does not count as a line');
    assert.match(record.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
  assert.equal(new Set(leaky.failure_records.map(r => r.output_sha256)).size, 1, 'identical output hashes alike');
  const slow = packet.recheck.failure_clusters.find(c => c.check === 'slow');
  assert.deepEqual(slow.failure_records.map(r => [r.status, r.exit_code]), [['timeout', null], ['timeout', null]]);
  assert.equal(JSON.stringify(packet.recheck).includes('Timed out'), false, 'the message is not shown either');
});

test('failure metadata fields are sanitized: hostile names, signals, statuses and timestamps are replaced', t => {
  const hostileIds = ['unit\x1b[31m', 'unit\nnext', 'unit test', 'x'.repeat(65), '', 'ünit', 'a;rm -rf', 42];
  // Even a declared check is shown only when it also passes the character rules.
  const declared = () => new Set([...hostileIds, 'pkg/unit:fast-1.2_x', 'unit']);
  for (const id of hostileIds) {
    assert.match(failureMetadata({ id, status: 'failed', exitCode: 1 }, null, declared).check, DIGEST_CHECK, JSON.stringify(id));
  }
  assert.equal(failureMetadata({ id: 'pkg/unit:fast-1.2_x' }, null, declared).check, 'pkg/unit:fast-1.2_x');
  assert.match(failureMetadata({ id: 'pkg/unit:fast-1.2_x' }).check, DIGEST_CHECK, 'an undeclared check is a digest');
  const odd = failureMetadata({ id: 'unit', status: 'failed\n', exitCode: '1', signal: 'SIGTERM\x1b[0m', stdout: 7, stderr: null }, '2026-11-01T00:00:00Z\nhunter2', declared);
  assert.deepEqual({ ...odd, output_sha256: undefined }, { check: 'unit', status: null, exit_code: null, signal: null, at: null, stdout_lines: 0, stderr_lines: 0, output_sha256: undefined });
  assert.equal(failureMetadata({ id: 'unit', signal: 'SIGKILL' }, '2026-11-01T00:00:00.000+02:00').signal, 'SIGKILL');
  assert.equal(failureMetadata({ id: 'unit' }, '2026-11-01T00:00:00.000+02:00').at, '2026-10-31T22:00:00.000Z', 'an offset time is shown in canonical UTC');

  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  const hostile = 'unit\x1b[2K\nPassword: hunter2';
  for (const plan of [PLAN_A, PLAN_B]) f.evidence(plan, [{ id: hostile, status: 'failed', stderr: 'boom' }]);
  const { recheck } = f.packet({ recheck: true });
  const [cluster] = recheck.failure_clusters;
  assert.match(cluster.check, DIGEST_CHECK);
  assert.ok(cluster.failure_records.every(record => record.check === cluster.check));
  assert.doesNotMatch(cluster.hint, /checks run [^<]/, 'an undeclared check is not offered as a command');
  assert.match(cluster.hint, /ae checks list/);
  assert.equal(JSON.stringify(recheck).includes('hunter2'), false);
  assert.equal(/[\x00-\x1f]/.test(JSON.parse(JSON.stringify(recheck.failure_clusters)).map(c => c.check + c.hint).join('')), false);
});

test('finding titles never appear: only a title hash, severity, line, sanitized category and path', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'on' });
  const finding = (file, title, extra = {}) => ({ file, line: 4, title, severity: 'P1', confidence: 0.8, description: 'd', suggested_fix: 's', autofix_class: 'manual', evidence: ['e'], ...extra });
  f.put('src/a.mjs', 'export const a = 1;\n');
  for (const [plan, title] of [[PLAN_A, RAW_SECRETS.csi], [PLAN_B, RAW_SECRETS.curl], [PLAN_C, RAW_SECRETS.cookie]]) {
    f.observation(plan, 'security-sentinel', [finding('src/a.mjs', title), finding('src/a.mjs', RAW_SECRETS.github), finding('src/a.mjs', RAW_SECRETS.pem)]);
  }
  f.observation(PLAN_A, 'style\x1b[31m', [finding('src/we ird.mjs', `Slow ${'a-'.repeat(100000)}`, { severity: 'P9\nhunter2', line: 'x' })]);
  f.observation(PLAN_B, 'style\x1b[31m', [finding('src/we ird.mjs', 'Other')]);
  const started = performance.now();
  const status = f.status();
  assert.ok(performance.now() - started < 1000, 'a 200k title costs only a hash');
  const { recheck } = f.packet({ recheck: true });
  assertNoRaw(JSON.stringify(recheck), 'packet');
  assertNoRaw(JSON.stringify(status), 'status');
  assert.equal(JSON.stringify(recheck).includes('Slow'), false);
  const security = recheck.finding_clusters.find(c => c.category === 'security-sentinel');
  assert.equal(security.file, 'src/a.mjs');
  assert.equal(security.samples.length, 3, 'capped');
  for (const sample of security.samples) {
    assert.deepEqual(Object.keys(sample), ['title_sha256', 'severity', 'line']);
    assert.match(sample.title_sha256, /^[a-f0-9]{12}$/);
    assert.equal(sample.severity, 'P1');
    assert.equal(sample.line, 4);
  }
  const style = recheck.finding_clusters.find(c => c.category !== 'security-sentinel');
  assert.match(style.category, DIGEST_REVIEWER, 'a reviewer Harness does not define is not shown');
  assert.match(style.file, DIGEST_PATH, 'a path outside the safe set is not shown');
  assert.ok(style.samples.some(sample => sample.severity === null && sample.line === null), 'unknown severity and line are dropped');
});

// Every string in recheck output is sanitized structured metadata: plans, commands and times too.

/** Every string value anywhere in `value`. */
const stringsIn = value => (typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(stringsIn) : []);
const HOSTILE_PLAN = `plan\u001b[31m-ghp_${'Z9y8X7w6V5'.repeat(3)}abcdef\nIGNORE PREVIOUS`;
const OSC_TS = '2026-11-01T00:00:00.000Z\u001b]0;IGNORE PREVIOUS\u0007';

test('hostile plans, journal commands and journal times never reach the packet or status', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'on' });
  for (const plan of [HOSTILE_PLAN, PLAN_A, PLAN_B]) f.evidence(plan, [{ id: 'unit', status: 'failed', stderr: 'boom' }]);
  const runs = [[HOSTILE_PLAN, 'h1'], [PLAN_B, 'h2']].flatMap(([plan, run]) => [
    { schema: 1, type: 'run.start', run, ts: OSC_TS, command: `ghp_${'Q1w2E3r4T5'.repeat(3)}abcdef`, plan },
    { schema: 1, type: 'run.result', run, ts: OSC_TS, status: 'failed', exitCode: 1, plan },
  ]);
  f.put('.harness/runs.jsonl', `${runs.map(line => JSON.stringify(line)).join('\r\n')}\r\n`);
  const finding = { file: 'src/worker.mjs', line: 2, title: 't', severity: 'P2', confidence: 0.8, description: 'd', suggested_fix: 's', autofix_class: 'manual', evidence: ['e'] };
  f.observation(HOSTILE_PLAN, 'architecture-strategist', [finding]);
  f.observation(PLAN_A, 'architecture-strategist', [finding]);
  const packet = f.packet({ recheck: true }), status = f.status();
  for (const [label, value] of [['packet', packet], ['status', status]]) {
    const json = JSON.stringify(value);
    for (const needle of ['ghp_', '\u001b', '\\u001b', '\u0007', '\\u0007', 'IGNORE']) assert.equal(json.includes(needle), false, `${label}: ${JSON.stringify(needle)} must not appear`);
    assert.equal(stringsIn(value).some(text => /[\r\n]/.test(text)), false, `${label}: no raw newline inside a value`);
  }
  assert.equal(status.due, true);
  const unit = packet.recheck.failure_clusters.find(c => c.check === 'unit');
  assert.equal(unit.plan_count, 3);
  assert.ok(unit.plans.includes(PLAN_A) && unit.plans.includes(PLAN_B));
  assert.ok(unit.plans.some(plan => /^\[unnamed:[a-f0-9]{12}\]$/.test(plan)), 'an unsafe plan is shown as a digest');
  const journal = packet.recheck.failure_clusters.find(c => c.source === 'run-journal');
  assert.match(journal.command, /^\[command:[a-f0-9]{12}\]$/);
  assert.deepEqual([journal.first_seen, journal.last_seen, journal.plan_count], [null, null, 2]);
  const [findings] = packet.recheck.finding_clusters;
  assert.equal(findings.plan_count, 2);
});

test('a journal command is shown only when the ae command registry defines it, otherwise as a digest', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  // Lowercase and short enough to pass the character rules: the shape alone vouched for these before.
  const planted = ['xoxb-1234567890-abcdefghij', 'hunter2correcthorse'];
  const lines = [];
  for (const [n, command] of [...planted, 'verify'].entries()) {
    for (const plan of [PLAN_A, PLAN_B]) {
      const run = `c${n}${plan === PLAN_A ? 'a' : 'b'}`;
      lines.push({ schema: 1, type: 'run.start', run, ts: '2026-11-01T00:00:00.000Z', command, plan });
      lines.push({ schema: 1, type: 'run.result', run, ts: '2026-11-01T00:01:00.000Z', status: 'failed', exitCode: 1, plan });
    }
  }
  f.journal(lines);
  const { recheck } = f.packet({ recheck: true });
  const json = JSON.stringify(recheck);
  for (const value of planted) assert.equal(json.includes(value), false, `${value} must not appear`);
  const journal = recheck.failure_clusters.filter(c => c.source === 'run-journal');
  assert.equal(journal.length, 3);
  const shown = journal.map(c => c.command);
  assert.ok(shown.includes('verify'), 'a registered command is shown by name');
  const digests = shown.filter(command => command !== 'verify');
  assert.equal(digests.length, 2);
  for (const command of digests) assert.match(command, /^\[command:[a-f0-9]{12}\]$/);
  assert.notEqual(digests[0], digests[1], 'distinct commands stay distinct');
  // The cluster ID still follows the recorded command, so an answer to it keeps matching.
  assert.ok(journal.some(c => c.id === failureClusterId('command:xoxb-1234567890-abcdefghij')));

  // The same through the CLI, which loads the registry itself.
  const cli = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'bin', 'ae.mjs'), 'consolidate', '--candidates', '--recheck', '--json', '--workspace', f.ws, '--no-events'], { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: f.home, AE_HOME: f.home, NO_COLOR: '1' } });
  for (const value of planted) assert.equal(cli.stdout.includes(value), false, `CLI: ${value} must not appear`);
  assert.match(cli.stdout, /"command": ?"verify"/);
});

test('a cluster counts its evidence records without listing their paths, and lists five failure records newest first', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  const rels = [];
  for (let i = 0; i < 12; i++) rels.push(f.evidence(i % 2 ? PLAN_B : PLAN_A, [{ id: 'unit', status: 'failed', stderr: `run ${i}` }], `2026-11-01T00:00:${String(i).padStart(2, '0')}.000Z`));
  const [cluster] = f.packet({ recheck: true }).recheck.failure_clusters;
  assert.equal('evidence' in cluster, false, 'evidence records hold retained output, so their paths are not listed');
  assert.equal(rels.some(rel => JSON.stringify(cluster).includes(path.basename(rel, '.json'))), false);
  assert.equal(cluster.evidence_count, 12);
  assert.deepEqual(cluster.omitted, { failure_records: 7 });
  assert.deepEqual(cluster.failure_records.map(r => r.at), [11, 10, 9, 8, 7].map(i => `2026-11-01T00:00:${String(i).padStart(2, '0')}.000Z`));
});

test('names and paths must start with a letter or digit; flag-like names get the generic hint; built-in property names stay data', t => {
  const ids = ['--trust-all', '-x', '..', '.hidden', '.', ':x', '/etc', '__proto__', `ghp_${'A1b2C3d4E5'.repeat(4)}`];
  for (const id of ids) {
    assert.match(failureMetadata({ id, status: 'failed', exitCode: 1 }, null, () => new Set(ids)).check, DIGEST_CHECK, JSON.stringify(id));
  }
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  for (const id of ['--trust-all', 'constructor', 'toString', 'hasOwnProperty']) for (const plan of [PLAN_A, PLAN_B]) f.evidence(plan, [{ id, status: 'failed', stderr: 'boom' }]);
  f.evidence('-rf/plan.md', [{ id: 'constructor', status: 'failed', stderr: 'boom' }]);
  const finding = { file: '.hidden/a.mjs', line: 1, title: 't', severity: 'P3', confidence: 0.8, description: 'd', suggested_fix: 's', autofix_class: 'manual', evidence: ['e'] };
  for (const plan of [PLAN_A, PLAN_B]) f.observation(plan, '-security', [finding]);
  const { recheck } = f.packet({ recheck: true });
  const flag = recheck.failure_clusters.find(c => c.id === failureClusterId('check:--trust-all'));
  assert.match(flag.check, DIGEST_CHECK);
  assert.match(flag.hint, /ae checks list/);
  assert.doesNotMatch(flag.hint, /trust-all|checks run [^<]/);
  for (const name of ['constructor', 'toString', 'hasOwnProperty']) assert.equal(recheck.failure_clusters.find(c => c.check === name)?.id, failureClusterId(`check:${name}`), name);
  const ctor = recheck.failure_clusters.find(c => c.check === 'constructor');
  assert.equal(ctor.plan_count, 3);
  assert.ok(ctor.plans.some(plan => /^\[unnamed:[a-f0-9]{12}\]$/.test(plan)), 'a flag-like plan is not shown');
  assert.match(recheck.finding_clusters[0].category, DIGEST_REVIEWER);
  assert.match(recheck.finding_clusters[0].file, DIGEST_PATH);
});

test('timestamps compare as times: offsets, future times and answers recorded with offsets', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  f.evidence(PLAN_A, [{ id: 'unit', status: 'failed', stderr: 'a' }], '2026-11-02T01:00:00+05:00');
  f.evidence(PLAN_B, [{ id: 'unit', status: 'failed', stderr: 'b' }], '2026-11-01T21:00:00.000Z');
  f.evidence(PLAN_C, [{ id: 'unit', status: 'failed', stderr: 'c' }], '2099-01-01T00:00:00.000Z');
  // `late` is answered at 20:00Z (written with an offset) and 21:00Z, then fails at 21:30Z: it is open.
  // `early` is answered at 22:00Z and fails at 21:00Z (written with an offset): it stays answered.
  for (const [plan, minute] of [[PLAN_A, 30], [PLAN_B, 40]]) f.evidence(plan, [{ id: 'late', status: 'failed', stderr: 'x' }], `2026-11-01T21:${minute}:00.000Z`);
  for (const plan of [PLAN_A, PLAN_B]) f.evidence(plan, [{ id: 'early', status: 'failed', stderr: 'y' }], '2026-11-02T02:00:00+05:00');
  const answer = (check, answeredAt, n) => ({ path: `docs/solutions/answer-${check}-${n}.md`, sha256: String(n).repeat(64), learning: 'runtime/baseline', at: answeredAt, answers: failureClusterId(`check:${check}`), answeredAt });
  appendLedger(f.dir, [answer('late', '2026-11-02T01:00:00.000+05:00', 1), answer('late', '2026-11-01T21:00:00.000Z', 2), answer('early', '2026-11-01T22:00:00.000Z', 3), answer('early', 'not a time', 4)]);
  const { recheck } = f.packet({ recheck: true });
  const unit = recheck.failure_clusters.find(c => c.check === 'unit');
  assert.equal(unit.first_seen, '2026-11-01T20:00:00.000Z', 'shown in canonical UTC');
  assert.equal(unit.last_seen, '2026-11-01T21:00:00.000Z', 'a future time is dropped, and 21:00Z is later than 01:00+05:00');
  assert.deepEqual(unit.failure_records.map(r => r.at), ['2026-11-01T21:00:00.000Z', '2026-11-01T20:00:00.000Z', null]);
  assert.ok(recheck.failure_clusters.some(c => c.check === 'late'), 'a failure after the latest answer reopens the cluster');
  assert.equal(recheck.failure_clusters.some(c => c.check === 'early'), false, 'a failure before the latest answer stays answered');
});

test('a timeout counts as a process failure even without retained output', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'on' });
  for (const plan of [PLAN_A, PLAN_B, PLAN_C]) f.evidence(plan, [{ id: 'slow', status: 'timeout', message: 'Timed out after 60s' }, { id: 'killed', status: 'unavailable', signal: 'SIGKILL', message: 'Terminated by signal SIGKILL' }]);
  const status = f.status();
  assert.equal(status.recheck.counts.failure_clusters, 1, 'a signal-killed check is unavailable and never clusters');
  assert.equal(status.due, true);
});

test('a reference is never checked through a symlinked intermediate directory', t => {
  const f = fixture(t);
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(path.join(outside, 'pkg/lib/test'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'pkg/lib/thing.mjs'), 'x');
  fs.mkdirSync(path.join(f.ws, 'a'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'pkg'), path.join(f.ws, 'a/pkg'));
  f.learn('runtime', 'linked', { anchors: ['a/pkg/lib/thing.mjs'] }, 'Cover it in `test/gone.test.mjs`.');
  f.put('b/pkg/lib/test/kept.mjs', 'x');
  const real = f.learn('runtime', 'real', { anchors: ['b/pkg/lib/thing.mjs'] }, 'Cover it in `test/gone.test.mjs`.');
  assert.deepEqual(f.packet({ recheck: true }).recheck.broken_references, [{ id: real, references: [{ kind: 'path', ref: 'test/gone.test.mjs' }] }]);
});

test('a record directory is read only up to its entry cap, and the omission is reported', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  const dir = path.join(f.ws, '.harness/reviews/observations');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i <= RECHECK_DIR_ENTRY_CAP; i++) fs.writeFileSync(path.join(dir, `junk-${i}`), '');
  assert.match(f.packet({ recheck: true }).recheck.omitted.directories, new RegExp(`first ${RECHECK_DIR_ENTRY_CAP} entries`));
  fs.rmSync(path.join(dir, 'junk-0'));
  assert.equal('directories' in f.packet({ recheck: true }).recheck.omitted, false, 'at the cap, nothing is left unread');
});

test('status opens only the newest 128 evidence records by mtime; the packet still finds an older failure', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'on' });
  const old = new Date('2026-01-01T00:00:00Z'), recent = new Date('2026-06-01T00:00:00Z');
  // Three failures across three plans (enough for due), all with an mtime older than every filler.
  const failing = [PLAN_A, PLAN_B, PLAN_C].map((plan, n) => f.evidence(plan, [{ id: 'unit', status: 'failed', stderr: 'boom' }], `2026-11-0${n + 1}T00:00:00.000Z`));
  for (const rel of failing) fs.utimesSync(path.join(f.ws, rel), old, old);
  for (let i = 0; i < RECHECK_STATUS_PRESELECT + 2; i++) {
    const rel = f.evidence(`docs/plans/filler-${i}.md`, [{ id: 'lint', status: 'passed' }], `2026-10-01T00:00:00.${String(i).padStart(3, '0')}Z`);
    fs.utimesSync(path.join(f.ws, rel), recent, recent);
  }
  const opens = t.mock.method(fs, 'openSync');
  const status = f.status();
  const historyOpens = opens.mock.calls.filter(call => String(call.arguments[0]).replace(/\\/g, '/').includes('.harness/evidence/history/')).length;
  opens.mock.restore();
  assert.equal(status.recheck.counts.failure_clusters, 0, 'the old-mtime failures are outside the newest 128 and are not counted');
  assert.equal(status.due, false);
  assert.ok(historyOpens > 0 && historyOpens <= RECHECK_STATUS_PRESELECT, `status opened ${historyOpens} evidence records`);
  const packet = f.packet({ recheck: true });
  const { recheck } = packet;
  assert.equal(recheck.counts.failure_clusters, 1, '--candidates --recheck reads past the status preselect');
  assert.equal(recheck.failure_clusters[0].plan_count, 3);
  // Only the status window decides due, so the packet agrees with status about it.
  assert.equal(recheck.max_cluster_plans, 0, 'a cluster outside the status window does not count toward due');
  assert.deepEqual(recheck.due_clusters, []);
  assert.equal(consolidateStatus({ workspace: f.ws, home: f.home }).due, false);

  // Once the failures are inside the window, status and the packet both call it due and name the same cluster.
  const now = new Date('2026-12-01T00:00:00Z');
  for (const rel of failing) fs.utimesSync(path.join(f.ws, rel), now, now);
  assert.equal(f.status().due, true);
  const after = f.packet({ recheck: true }).recheck;
  assert.equal(after.max_cluster_plans, 3);
  assert.deepEqual(after.due_clusters, [failureClusterId('check:unit')]);
});

test('a plan in the external plan store is shown by its file name, which --plan resolves back to it', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'on' });
  const store = externalPlansDir(f.ws, { home: f.home });
  const names = ['2026-11-01-feat-a-plan.md', '2026-11-02-feat-b-plan.hplan', '2026-11-03-feat-c-plan.md'];
  const recorded = names.map(name => path.join(store, name));
  for (const full of recorded) { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, '---\nstatus: planned\n---\n'); }
  for (const plan of recorded) f.evidence(plan, [{ id: 'unit', status: 'failed', stderr: 'boom' }]);
  // A plan outside the store, recorded with an absolute path, is still only a digest.
  const stray = path.join(f.root, 'elsewhere', 'plans', '2026-11-04-feat-d-plan.md');
  f.evidence(stray, [{ id: 'unit', status: 'failed', stderr: 'boom' }]);
  const { recheck } = f.packet({ recheck: true });
  const [unit] = recheck.failure_clusters;
  assert.deepEqual(unit.plans.filter(plan => !plan.startsWith('[unnamed:')), names.toSorted());
  assert.equal(unit.plans.filter(plan => plan.startsWith('[unnamed:')).length, 1);
  assert.equal(unit.plan_count, 4);
  const shown = JSON.stringify(recheck);
  for (const secret of [f.home, f.root, os.homedir()]) assert.equal(shown.includes(secret), false, 'no home directory or store path is shown');
  for (const [i, name] of names.entries()) assert.equal(normalizePlanRel(f.ws, name, { home: f.home }), recorded[i], `--plan ${name} resolves to the recorded plan`);
  assert.equal(f.status().due, true, 'three external-store plans still make the cluster due');
});

test('plans are counted after mapping to what is shown, so plan_count matches the list', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  const store = externalPlansDir(f.ws, { home: f.home });
  const name = '2026-11-01-feat-a-plan.md';
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, name), '# a\n');
  const run = (id, plan, day) => [
    { schema: 1, type: 'run.start', run: id, ts: `2026-11-0${day}T00:00:00.000Z`, command: 'verify', plan },
    { schema: 1, type: 'run.result', run: id, ts: `2026-11-0${day}T00:01:00.000Z`, status: 'failed', exitCode: 1, plan },
  ];
  // The same plan typed as a name and as its absolute store path is one plan, so there is no cluster.
  f.journal([...run('r1', name, 1), ...run('r2', path.join(store, name), 2)]);
  assert.deepEqual(f.packet({ recheck: true }).recheck.failure_clusters, []);
  f.journal([...run('r1', name, 1), ...run('r2', path.join(store, name), 2), ...run('r3', PLAN_B, 3)]);
  const [verify] = f.packet({ recheck: true }).recheck.failure_clusters;
  assert.deepEqual(verify.plans, [name, PLAN_B].toSorted());
  assert.equal(verify.plan_count, verify.plans.length);
});

test('names and paths the shared redactor would mask are not shown, even when the secret scan misses them', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  const openai = `sk-proj-${'A1b2C3d4E5f6'.repeat(3)}`;
  const kv = 'password:SuperSecret123';
  for (const plan of [PLAN_A, PLAN_B]) f.evidence(plan, [{ id: openai, status: 'failed', stderr: 'a' }, { id: kv, status: 'failed', stderr: 'b' }]);
  const finding = file => ({ file, line: 1, title: 't', severity: 'P2', confidence: 0.8, description: 'd', suggested_fix: 's', autofix_class: 'manual', evidence: ['e'] });
  for (const plan of [PLAN_A, PLAN_B]) {
    f.observation(plan, openai, [finding('src/a.mjs')]);
    f.observation(plan, kv, [finding('src/b.mjs')]);
    f.observation(plan, 'architecture-strategist', [finding(`src/${openai}.mjs`)]);
  }
  const { recheck } = f.packet({ recheck: true });
  assert.equal(recheck.failure_clusters.length, 2);
  assert.ok(recheck.failure_clusters.every(c => DIGEST_CHECK.test(c.check) && c.failure_records.every(r => r.check === c.check)));
  assert.deepEqual(recheck.finding_clusters.map(c => DIGEST_REVIEWER.test(c.category) ? 'digest' : c.category).toSorted(), ['architecture-strategist', 'digest', 'digest']);
  assert.match(recheck.finding_clusters.find(c => c.category === 'architecture-strategist').file, DIGEST_PATH);
  const shown = JSON.stringify(recheck);
  assert.equal(shown.includes(openai) || shown.includes('SuperSecret123'), false);
});

test('finding clusters have their own ID shape that no failure-cluster reference accepts', t => {
  const f = fixture(t);
  seedSignals(f);
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  const { recheck } = f.packet({ recheck: true });
  const [finding] = recheck.finding_clusters;
  assert.match(finding.id, FINDING_CLUSTER_REF);
  const digest = finding.id.slice('finding-cluster:'.length);
  for (const ref of [finding.id, `failure-cluster:${digest}`]) assert.equal(FAILURE_CLUSTER_REF.test(ref), false, ref);
  assert.ok(recheck.failure_clusters.every(c => /^[a-f0-9]{16}$/.test(c.id) && FAILURE_CLUSTER_REF.test(`failure-cluster:${c.id}`)));
  const refused = runInsightCompound({ workspace: f.ws, copilotHome: path.join(f.root, 'copilot'), home: f.home, log: () => {}, flags: { title: 'From a finding', body: 'b', derivedFrom: finding.id } });
  assert.equal(refused.pass, false);
  assert.equal(refused.exitCode, 2);
  assert.match(refused.blockedReason, /finding clusters are informational/);
});

test('an answer timestamped more than five minutes ahead answers nothing', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  for (const plan of [PLAN_A, PLAN_B]) f.evidence(plan, [{ id: 'unit', status: 'failed', stderr: 'x' }], '2026-11-01T00:00:00.000Z');
  for (const plan of [PLAN_A, PLAN_B]) f.evidence(plan, [{ id: 'near', status: 'failed', stderr: 'x' }], '2026-11-01T00:00:00.000Z');
  const answer = (check, answeredAt, n) => ({ path: `docs/solutions/answer-${n}.md`, sha256: String(n).repeat(64), learning: 'runtime/baseline', at: '2026-11-01', answers: failureClusterId(`check:${check}`), answeredAt });
  appendLedger(f.dir, [answer('unit', '2099-01-01T00:00:00.000Z', 1), answer('near', new Date(Date.now() + 60_000).toISOString(), 2)]);
  const { recheck } = f.packet({ recheck: true });
  assert.ok(recheck.failure_clusters.some(c => c.check === 'unit'), 'a far-future answer does not hide the cluster');
  assert.equal(recheck.failure_clusters.some(c => c.check === 'near'), false, 'an answer within the skew limit still counts');
});

test('impossible dates are dropped, and only positive exposure counts are summed', t => {
  for (const at of ['2026-02-30T00:00:00.000Z', '2026-04-31T12:00:00+05:00', '2026-01-01T24:00:00Z', '2025-02-29T00:00:00Z']) {
    assert.equal(failureMetadata({ id: 'unit' }, at).at, null, at);
  }
  assert.equal(failureMetadata({ id: 'unit' }, '2024-02-29T23:59:59.999-01:00').at, '2024-03-01T00:59:59.999Z', 'a real leap day with an offset is kept');

  const f = fixture(t);
  const stale = f.bound('runtime', 'retry-worker', 'src/worker.mjs');
  f.put('src/worker.mjs', 'export const retry_worker = 2;\n');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  const counts = [3, -100, 0, 2.5, 2];
  for (const [i, count] of counts.entries()) {
    const plan = `docs/plans/x${i}.md`;
    f.put(`.harness/learning/exposures/plan-${sha(plan)}.json`, { version: 1, plan, entries: [{ id: stale, count, lastExposedAt: '2026-11-01T00:00:00.000Z' }] });
  }
  const [row] = f.packet({ recheck: true }).recheck.stale_exposed;
  assert.equal(row.exposures, 5);
  assert.equal(row.plan_count, counts.length);
});

// Identity fields are shown only when an allowlist outside the record vouches for them.

/** Values that fit every character set and match no secret pattern: only an allowlist can keep them out. */
const LOOKS_SAFE = [`sk_live_${'4eC39HqLyjWDarjtT1zdp7dc'}`, `hf_${'aBcDeFgHiJkLmNoPqRsTuVwXyZ01234'}`, '3f786850e387550fdab836ed7e6dc881de23001b', 'admin:hunter2pass'];

test('names, perspectives, files and plans no allowlist vouches for are digests, however safe they look', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  const finding = file => ({ file, line: 1, title: 't', severity: 'P2', confidence: 0.8, description: 'd', suggested_fix: 's', autofix_class: 'manual', evidence: ['e'] });
  const outside = path.join(f.root, 'outside.md');
  fs.writeFileSync(outside, '# outside\n');
  fs.symlinkSync(outside, path.join(f.ws, 'docs/plans/linked-plan.md'));
  const journal = [];
  for (const [n, value] of LOOKS_SAFE.entries()) {
    // As a check name (two plans), as plans (evidence and journal), as a reviewer and as a finding file.
    for (const plan of [PLAN_A, PLAN_B]) f.evidence(plan, [{ id: value, status: 'failed', stderr: 'boom' }]);
    for (const plan of [value, `docs/plans/${value}.md`]) f.evidence(plan, [{ id: 'unit', status: 'failed', stderr: 'boom' }]);
    for (const [i, plan] of [value, `docs/plans/${value}.md`].entries()) {
      journal.push({ schema: 1, type: 'run.start', run: `s${n}${i}`, ts: '2026-11-01T00:00:00.000Z', command: 'verify', plan },
        { schema: 1, type: 'run.result', run: `s${n}${i}`, ts: '2026-11-01T00:01:00.000Z', status: 'failed', exitCode: 1, plan });
    }
    for (const plan of [PLAN_A, PLAN_B]) {
      f.observation(plan, value, [finding('src/worker.mjs')]);
      f.observation(plan, 'architecture-strategist', [finding(`src/${value}.mjs`)]);
    }
  }
  f.put('src/worker.mjs', 'export const worker = 1;\n');
  f.evidence('docs/plans/linked-plan.md', [{ id: 'unit', status: 'failed', stderr: 'boom' }]);
  f.evidence(PLAN_A, [{ id: 'unit', status: 'failed', stderr: 'boom' }]);
  f.journal(journal);
  const { recheck } = f.packet({ recheck: true });
  const shown = JSON.stringify(recheck);
  for (const value of LOOKS_SAFE) assert.equal(shown.includes(value), false, `${value} must not appear`);
  for (const part of ['4eC39HqLyjWDarjtT1zdp7dc', 'hunter2pass', '3f786850e387550f']) assert.equal(shown.includes(part), false, part);

  for (const value of LOOKS_SAFE) {
    const cluster = recheck.failure_clusters.find(c => c.id === failureClusterId(`check:${value}`));
    assert.ok(cluster, value);
    assert.match(cluster.check, DIGEST_CHECK);
    assert.ok(cluster.failure_records.every(r => r.check === cluster.check));
    assert.match(cluster.hint, /ae checks list/);
    assert.doesNotMatch(cluster.hint, /checks run [^<]/, 'the hint names only a declared check');
  }
  const unit = recheck.failure_clusters.find(c => c.check === 'unit');
  assert.match(unit.hint, /ae checks run unit/, 'a declared check is named');
  assert.equal(unit.plan_count, LOOKS_SAFE.length * 2 + 2);
  assert.ok(unit.plans.includes(PLAN_A), 'an existing plan is shown');
  assert.ok(unit.plans.filter(plan => plan !== PLAN_A).every(plan => DIGEST_PATH.test(plan)), 'missing and symlinked plans are digests');
  const verify = recheck.failure_clusters.find(c => c.command === 'verify');
  // `--plan <name>` and `--plan docs/plans/<name>.md` (missing) resolve to the same plan-store file, as loadPlan resolves them.
  assert.equal(verify.plan_count, LOOKS_SAFE.length);
  assert.ok(verify.plans.every(plan => DIGEST_PATH.test(plan)));

  const byPerspective = recheck.finding_clusters.filter(c => c.file === 'src/worker.mjs');
  assert.equal(byPerspective.length, LOOKS_SAFE.length, 'an existing file is shown');
  assert.ok(byPerspective.every(c => DIGEST_REVIEWER.test(c.category)));
  const byFile = recheck.finding_clusters.filter(c => c.category === 'architecture-strategist');
  assert.equal(byFile.length, LOOKS_SAFE.length);
  assert.ok(byFile.every(c => DIGEST_PATH.test(c.file)), 'a file that does not exist in the checkout is a digest');
});

test('status computes only what due reads: no run journal, review observations, checks configuration or reference scan', t => {
  const f = fixture(t);
  seedSignals(f);
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'on' });
  const touched = [];
  const spied = ['openSync', 'opendirSync', 'lstatSync'].map(name => {
    const original = fs[name];
    fs[name] = function spy(target, ...rest) { touched.push(String(target)); return original.call(this, target, ...rest); };
    return [name, original];
  });
  let status;
  try {
    status = f.status();
    const statusTouched = touched.splice(0);
    for (const needle of ['runs.jsonl', path.join('reviews', 'observations'), 'checks.yaml', path.join('src', 'removed')]) {
      assert.equal(statusTouched.some(p => p.includes(needle)), false, `status must not open ${needle}`);
    }
    f.packet({ recheck: true });
    for (const needle of ['runs.jsonl', path.join('reviews', 'observations'), 'checks.yaml', path.join('src', 'removed')]) {
      assert.equal(touched.some(p => p.includes(needle)), true, `the packet opens ${needle} (the spy sees it)`);
    }
  } finally {
    for (const [name, original] of spied) fs[name] = original;
  }
  assert.deepEqual(status.recheck, { state: 'on', counts: { stale_exposed: 1, review_required: 1, failure_clusters: 1 } });
});

test('journal plans are resolved as loadPlan resolves them before they are counted', t => {
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  const run = (id, plan) => [
    { schema: 1, type: 'run.start', run: id, ts: '2026-11-01T00:00:00.000Z', command: 'verify', plan },
    { schema: 1, type: 'run.result', run: id, ts: '2026-11-01T00:01:00.000Z', status: 'failed', exitCode: 1, plan },
  ];
  const spellings = [`./${PLAN_A}`, PLAN_A, path.join(f.ws, PLAN_A)];
  f.journal(spellings.flatMap((plan, i) => run(`p${i}`, plan)));
  assert.deepEqual(f.packet({ recheck: true }).recheck.failure_clusters, [], 'three spellings of one plan are one plan');
  f.journal([...spellings, PLAN_B].flatMap((plan, i) => run(`p${i}`, plan)));
  const [verify] = f.packet({ recheck: true }).recheck.failure_clusters;
  assert.deepEqual([verify.plans, verify.plan_count, verify.failures], [[PLAN_A, PLAN_B], 2, 4]);
});

test('out-of-range exit codes and finding lines are dropped', t => {
  for (const [code, shown] of [[1, 1], [-1, -1], [255, 255], [-255, -255], [256, null], [-256, null], [70000, null], [Number.MAX_SAFE_INTEGER, null]]) {
    assert.equal(failureMetadata({ id: 'unit', status: 'failed', exitCode: code }).exit_code, shown, String(code));
  }
  const f = fixture(t);
  f.learn('runtime', 'baseline');
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  f.put('src/a.mjs', 'export const a = 1;\n');
  const finding = line => ({ file: 'src/a.mjs', line, title: `line ${line}`, severity: 'P2', confidence: 0.8, description: 'd', suggested_fix: 's', autofix_class: 'manual', evidence: ['e'] });
  f.observation(PLAN_A, 'architecture-strategist', [finding(10_000_000)]);
  f.observation(PLAN_B, 'architecture-strategist', [finding(10_000_001)]);
  f.observation(PLAN_C, 'architecture-strategist', [finding(1e15)]);
  const [cluster] = f.packet({ recheck: true }).recheck.finding_clusters;
  assert.deepEqual(cluster.samples.map(s => s.line).toSorted(), [10_000_000, null, null]);
});

test('the consolidate skill and docs send agents to re-run a check, never to evidence records or run output', () => {
  const repo = path.resolve(import.meta.dirname, '../../..');
  for (const rel of ['packages/ae/corpus/skills/consolidate/SKILL.md', 'packages/ae/corpus/skills/references/learning-operations.md', 'docs/adaptive-engineering.md']) {
    const text = fs.readFileSync(path.join(repo, rel), 'utf8');
    assert.doesNotMatch(text, /ae run list --plan/, `${rel}: no run-list lookup for a cluster`);
    assert.doesNotMatch(text, /read (?:its|the) evidence records/i, `${rel}: no reading of evidence records`);
    assert.doesNotMatch(text, /high-entropy string[^.]*is shown/, `${rel}: no character-set rule decides what is shown`);
  }
  assert.match(fs.readFileSync(path.join(repo, 'packages/ae/corpus/skills/consolidate/SKILL.md'), 'utf8'), /re-run the check/);
});
