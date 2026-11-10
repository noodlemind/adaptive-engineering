import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureStore, storeDir } from '../lib/knowledge/store.mjs';
import { knowledgeStatus } from '../lib/knowledge/status.mjs';
import { branchKeyFor } from '../lib/git-context.mjs';
import { publishFeedbackRecord, recordExposure } from '../lib/learning-feedback.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function gitWorkspace(branch = 'feature/status') {
  const ws = tempDir('kstatus-ws-');
  git(ws, ['init', '-q', '-b', branch]);
  git(ws, ['config', 'user.email', 'test@example.test']);
  git(ws, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(ws, 'seed.txt'), 'seed\n');
  git(ws, ['add', '.']);
  git(ws, ['commit', '-qm', 'seed']);
  return ws;
}

function head(ws) {
  return git(ws, ['rev-parse', 'HEAD']).stdout.trim();
}

function writeLearning(root, id, { status = 'active', tombstone = null } = {}) {
  const [domain, slug] = id.split('/');
  const dir = path.join(root, 'learnings', domain);
  fs.mkdirSync(dir, { recursive: true });
  const extra = tombstone ? `promoted_to_golden: ${tombstone}\n` : '';
  fs.writeFileSync(
    path.join(dir, `${slug}.md`),
    `---\nschema: 1\ntrigger: "t ${slug}"\nstatus: ${status}\nsource: auto\nepisodes:\nanchors: []\nsuperseded_by: null\nlast_confirmed: null\n${extra}origin: test\n---\n\nBody.\n`,
    'utf8'
  );
}

function writeBucket(dir, key, meta = {}) {
  const bucketDir = path.join(dir, 'branches', key);
  fs.mkdirSync(path.join(bucketDir, 'learnings'), { recursive: true });
  fs.writeFileSync(path.join(bucketDir, 'meta.json'), JSON.stringify(meta) + '\n');
  return bucketDir;
}

function runHarness(args, env = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('knowledge status reports golden per-domain counts and bucket rows', () => {
  const ws = gitWorkspace('feature/status');
  const home = tempDir('kstatus-home-');
  const { dir } = ensureStore(ws, { home });
  writeLearning(dir, 'sql/one');
  writeLearning(dir, 'sql/two', { status: 'retired' });
  writeLearning(dir, 'aws/three');

  const key = branchKeyFor('feature/status');
  const createdAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const bucketDir = writeBucket(dir, key, { branch: 'feature/status', branchKey: key, baseSha: head(ws), createdAt, promotable: true });
  writeLearning(bucketDir, 'sql/branch-claim');
  const detachedDir = writeBucket(dir, 'detached-abcdefabcdef', { branch: null, branchKey: 'detached-abcdefabcdef' });
  writeLearning(detachedDir, 'sql/experiment', { tombstone: 'sql/one' });

  const report = knowledgeStatus({ workspace: ws, home });
  assert.equal(report.storeExists, true);
  assert.deepEqual(report.golden.domains, [
    { domain: 'aws', active: 1, total: 1 },
    { domain: 'sql', active: 1, total: 2 },
  ]);
  assert.equal(report.golden.active, 2);
  assert.equal(report.golden.total, 3);
  assert.equal(report.context.branch, 'feature/status');
  assert.equal(report.context.branchKey, key);

  const buckets = Object.fromEntries(report.buckets.map((b) => [b.key, b]));
  const current = buckets[key];
  assert.equal(current.branch, 'feature/status');
  assert.equal(current.promotable, true);
  assert.equal(current.active, 1);
  assert.equal(current.ageDays, 3);
  assert.equal(current.baseSha, head(ws));
  assert.equal(current.ancestryOk, true);
  assert.equal(current.prunable, false);

  const detached = buckets['detached-abcdefabcdef'];
  assert.equal(detached.promotable, false, 'detached-* is derived never-promotable from the key shape');
  assert.equal(detached.promoted, 1);
  assert.equal(detached.active, 0);
  assert.equal(detached.prunable, true, 'a fully tombstoned bucket is prunable');
  assert.equal(detached.ancestryOk, null, 'no recorded base — unverifiable, not excluded');
});

test('a bucket with a non-ancestor base is flagged ancestryOk: false', () => {
  const ws = gitWorkspace('feature/reuse');
  const home = tempDir('kstatus-home2-');
  const { dir } = ensureStore(ws, { home });
  writeBucket(dir, branchKeyFor('feature/reuse'), { branch: 'feature/reuse', baseSha: 'e'.repeat(40) });
  const report = knowledgeStatus({ workspace: ws, home });
  assert.equal(report.buckets[0].ancestryOk, false);
});

test('a malformed bucket baseSha is dropped rather than rendered verbatim', () => {
  const ws = gitWorkspace('feature/basesha');
  const home = tempDir('kstatus-home4-');
  const { dir } = ensureStore(ws, { home });
  writeBucket(dir, 'hostile-11111111', {
    branch: 'hostile',
    baseSha: 'AKIAIOSFODNN7EXAMPLE\nnot a sha at all',
  });
  const report = knowledgeStatus({ workspace: ws, home });
  assert.equal(report.buckets[0].baseSha, null, 'a value the ancestry gate would refuse is never reported');
  assert.equal(report.buckets[0].ancestryOk, null, 'and it stays unverifiable, not "proven not an ancestor"');

  writeBucket(dir, 'ok-22222222', { branch: 'ok', baseSha: 'a'.repeat(40) });
  const again = knowledgeStatus({ workspace: ws, home });
  assert.equal(again.buckets.find((b) => b.key === 'ok-22222222').baseSha, 'a'.repeat(40), 'a well-formed sha still reports');
});

test('knowledge status is read-only and never materializes a store', () => {
  const ws = gitWorkspace('feature/empty');
  const home = tempDir('kstatus-home3-');
  const report = knowledgeStatus({ workspace: ws, home });
  assert.equal(report.storeExists, false);
  assert.deepEqual(report.golden, { active: 0, total: 0, domains: [] });
  assert.deepEqual(report.buckets, []);
  assert.equal(fs.existsSync(storeDir(ws, { home })), false, 'status must not create the store');
});

test('CLI: ae knowledge status --json emits the report and a knowledge event', () => {
  const ws = gitWorkspace('feature/cli-status');
  const harnessHome = tempDir('kstatus-hh-');
  const copilotHome = tempDir('kstatus-ch-');
  const { dir } = ensureStore(ws, { home: harnessHome });
  writeLearning(dir, 'sql/cli-claim');

  const res = runHarness(['knowledge', 'status', '--workspace', ws, '--copilot-home', copilotHome, '--json'], {
    HARNESS_HOME: harnessHome,
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const body = JSON.parse(res.stdout);
  assert.equal(body.pass, true);
  assert.equal(body.golden.active, 1);
  assert.equal(body.mode, 'on');
  assert.ok(body.drift, 'drift line present');

  const events = fs
    .readFileSync(path.join(ws, '.harness', 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.type === 'knowledge' && e.decision === 'status'), 'knowledge event emitted');

  // Styled (non-JSON) rendering also exits 0 and shows the ledger rows.
  const human = runHarness(['knowledge', 'status', '--workspace', ws, '--copilot-home', copilotHome], {
    HARNESS_HOME: harnessHome,
  });
  assert.equal(human.status, 0, human.stderr || human.stdout);
  assert.match(human.stdout, /golden/);
  assert.match(human.stdout, /sql/);
});

test('CLI: --branch and --ids refuse a missing or flag-shaped value instead of swallowing the next flag', () => {
  const ws = gitWorkspace('feature/flagguard');
  const harnessHome = tempDir('kstatus-hh2-');
  for (const args of [
    ['knowledge', 'prune', '--branch', '--merged'],
    ['knowledge', 'prune', '--branch='],
    ['knowledge', 'promote', '--ids', '--all'],
    ['knowledge', 'promote', '--ids='],
  ]) {
    const res = runHarness([...args, '--workspace', ws], { HARNESS_HOME: harnessHome });
    assert.notEqual(res.status, 0, `${args.join(' ')} must be refused`);
    assert.match(res.stderr, /invalid --(branch|ids)/, `${args.join(' ')}: ${res.stderr}`);
  }
});

test('CLI: knowledge status and --status are byte-identical under feedback off and show feedback columns under suggest and on', () => {
  const ws = gitWorkspace('feature/feedback-columns');
  const harnessHome = tempDir('kstatus-fb-hh-');
  const copilotHome = tempDir('kstatus-fb-ch-');
  const { dir } = ensureStore(ws, { home: harnessHome });
  writeLearning(dir, 'sql/seen');
  writeLearning(dir, 'sql/unseen');
  const env = { HARNESS_HOME: harnessHome };
  const outputs = () => ['status', '--status'].flatMap((sub) => [
    runHarness(['knowledge', sub, '--workspace', ws, '--copilot-home', copilotHome, '--json'], env).stdout,
    runHarness(['knowledge', sub, '--workspace', ws, '--copilot-home', copilotHome], env).stdout,
  ]);
  const before = outputs();

  for (const plan of ['docs/plans/a.md', 'docs/plans/b.md']) {
    recordExposure({ recordRoot: ws, workspace: ws, home: harnessHome, planPath: plan, delivered: [{ id: 'sql/seen' }], now: new Date(plan.endsWith('a.md') ? '2026-11-01T00:00:00Z' : '2026-11-05T00:00:00Z') });
  }
  recordExposure({ recordRoot: ws, workspace: ws, home: harnessHome, planPath: 'docs/plans/a.md', delivered: [{ id: 'sql/seen' }], now: new Date('2026-11-03T00:00:00Z') });
  publishFeedbackRecord({ workspace: ws, home: harnessHome, operation: 'a'.repeat(64), planPath: 'docs/plans/a.md', captureDate: '2026-11-03', feedback: { recalled: [{ id: 'sql/seen', verdict: 'helped' }] } });
  publishFeedbackRecord({ workspace: ws, home: harnessHome, operation: 'b'.repeat(64), planPath: 'docs/plans/b.md', captureDate: '2026-11-05', feedback: { recalled: [{ id: 'sql/seen', verdict: 'wrong' }] } });

  assert.deepEqual(outputs(), before, 'off: knowledge status and --status are byte-identical with records present');

  for (const state of ['suggest', 'on']) {
    assert.equal(runHarness(['knowledge', 'feedback', state, '--workspace', ws, '--json'], env).status, 0);
    const expected = { state, learnings: [{ id: 'sql/seen', exposed: 3, helped: 1, wrong: 1, last_exposed: '2026-11-05T00:00:00.000Z' }] };
    const report = JSON.parse(runHarness(['knowledge', 'status', '--workspace', ws, '--copilot-home', copilotHome, '--json'], env).stdout);
    assert.deepEqual(report.feedback, expected, `${state}: exposure summed across this workspace's plans, verdicts from the project store`);
    const bare = JSON.parse(runHarness(['knowledge', '--status', '--workspace', ws, '--copilot-home', copilotHome, '--json'], env).stdout);
    assert.deepEqual(bare.feedback, expected);
    for (const sub of ['status', '--status']) {
      const plain = runHarness(['knowledge', sub, '--workspace', ws, '--copilot-home', copilotHome], env).stdout;
      assert.match(plain, new RegExp(`feedback\\s+${state}`));
      assert.match(plain, /sql\/seen · exposed 3 · helped 1 · wrong 1 · last_exposed 2026-11-05/);
    }
  }
});
