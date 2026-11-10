import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { storeDir } from '../lib/knowledge/store.mjs';
import { publishFeedbackRecord, recordExposure } from '../lib/learning-feedback.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ctx = () => ({ ws: tempDir('ll-ws-'), home: tempDir('ll-home-'), harnessHome: tempDir('ll-hh-') });

function run({ ws, home, harnessHome }, args, { json = true } = {}) {
  return spawnSync(
    process.execPath,
    [binPath, ...args, '--workspace', ws, '--copilot-home', home, ...(json ? ['--json'] : [])],
    { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: harnessHome } }
  );
}

function writeOps(dir, ops) {
  const p = path.join(dir, 'ops.json');
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

function quarantineEpisode(c) {
  const dir = path.join(c.ws, 'docs', 'solutions', 'perf');
  fs.mkdirSync(dir, { recursive: true });
  const text = '---\ntitle: "big claim lesson"\ndate: 2026-07-01\n---\n\n## Problem\n\nbig claim details.\n';
  fs.writeFileSync(path.join(dir, 'big-claim.md'), text);
  const ep = { path: 'docs/solutions/perf/big-claim.md', sha256: crypto.createHash('sha256').update(text).digest('hex') };
  const op = {
    op: 'ADD',
    domain: 'sql',
    slug: 'big-claim',
    trigger: 'a quarantine trigger',
    body: 'x'.repeat(1300),
    episodes: [{ path: ep.path, sha256: ep.sha256, kind: 'fix', plan: 'docs/plans/p1.md' }],
  };
  const opsPath = writeOps(c.ws, [op]);
  for (let i = 0; i < 3; i++) {
    const res = run(c, ['consolidate', '--apply', '--ops', opsPath]);
    assert.equal(res.status, 1, res.stderr || res.stdout);
  }
  return ep;
}

function writeFixEpisode(ws, rel) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = `episode body for ${rel}.\n`;
  fs.writeFileSync(full, text, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

function buildAddPromotable(ws) {
  return {
    op: 'ADD',
    domain: 'sql',
    slug: 'not-null-large-tables',
    trigger: 'adding NOT NULL columns to large/hot tables',
    body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
    episodes: [
      { ...writeFixEpisode(ws, 'docs/solutions/perf/x.md'), kind: 'fix', plan: 'docs/plans/p1.md' },
      { ...writeFixEpisode(ws, 'docs/solutions/perf/y.md'), kind: 'fix', plan: 'docs/plans/p2.md' },
      { ...writeFixEpisode(ws, 'docs/solutions/perf/z.md'), kind: 'fix', plan: 'docs/plans/p2.md' },
    ],
  };
}

function seed(c) {
  // Auto learning via a Task-1-style consolidate --apply ops file — promotion-eligible.
  const opsPath = writeOps(c.ws, [buildAddPromotable(c.ws)]);
  const applyRes = run(c, ['consolidate', '--apply', '--ops', opsPath]);
  assert.equal(applyRes.status, 0, applyRes.stderr || applyRes.stdout);
  const autoId = JSON.parse(applyRes.stdout).applied[0].id;

  // Human learning via Task-1 `remember`.
  const rememberRes = run(c, [
    'remember',
    'Use two-step default+backfill for NOT NULL adds; direct ALTER takes an exclusive lock.',
    '--trigger', 'adding NOT NULL columns to hot tables',
    '--domain', 'sql',
  ]);
  assert.equal(rememberRes.status, 0, rememberRes.stderr || rememberRes.stdout);
  const humanId = JSON.parse(rememberRes.stdout).learningId;

  // A fake verify-fail event naming the human learning — the evidence-contradicts annotation.
  const harnessDir = path.join(c.ws, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.appendFileSync(
    path.join(harnessDir, 'events.jsonl'),
    `${JSON.stringify({ version: 2, type: 'verify', result: 'fail', learnings: [humanId] })}\n`
  );

  return { autoId, humanId };
}

function seedLegacyAndSupersede(c) {
  const legacyOp = {
    op: 'ADD',
    domain: 'sql',
    slug: 'legacy-claim',
    trigger: 'a legacy trigger',
    body: 'The original claim body.',
    episodes: [{ ...writeFixEpisode(c.ws, 'docs/solutions/perf/legacy.md'), kind: 'fix', plan: 'docs/plans/p10.md' }],
  };
  const legacyRes = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [legacyOp])]);
  assert.equal(legacyRes.status, 0, legacyRes.stderr || legacyRes.stdout);
  const oldId = JSON.parse(legacyRes.stdout).applied[0].id;

  const supersedeOp = {
    op: 'SUPERSEDE',
    target: oldId,
    domain: 'sql',
    slug: 'legacy-claim-v2',
    trigger: 'a legacy trigger, v2',
    body: 'The replacement claim body.',
    episodes: [{ ...writeFixEpisode(c.ws, 'docs/solutions/perf/legacy-v2.md'), kind: 'fix', plan: 'docs/plans/p11.md' }],
  };
  const supersedeRes = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [supersedeOp])]);
  assert.equal(supersedeRes.status, 0, supersedeRes.stderr || supersedeRes.stdout);
  const newId = JSON.parse(supersedeRes.stdout).applied[0].id;

  return { oldId, newId };
}

test('learnings --json lists both learnings with verified/plans/promotionEligible/failures', () => {
  const c = ctx();
  const { autoId, humanId } = seed(c);

  const res = run(c, ['learnings']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.learnings.length, 2);

  const auto = out.learnings.find((l) => l.id === autoId);
  assert.ok(auto, 'auto learning present');
  assert.equal(auto.verified, 3);
  assert.equal(auto.plans, 2);
  assert.equal(auto.promotionEligible, true);
  assert.equal(auto.failures, 0);

  const human = out.learnings.find((l) => l.id === humanId);
  assert.ok(human, 'human learning present');
  assert.equal(human.source, 'human');
  assert.equal(human.failures, 1);
  assert.equal(human.promotionEligible, false);
});

test('learnings <domain> --json filters to that domain', () => {
  const c = ctx();
  seed(c);

  // Add an unrelated learning in another domain so the filter has something to exclude.
  const opsPath = writeOps(c.ws, [
    {
      op: 'ADD',
      domain: 'python',
      slug: 'async-context-managers',
      trigger: 'using async context managers',
      body: 'Prefer async with over manual __aenter__/__aexit__ calls.',
      episodes: [{ ...writeFixEpisode(c.ws, 'docs/solutions/py/a.md'), kind: 'fix', plan: 'docs/plans/p3.md' }],
    },
  ]);
  const applyRes = run(c, ['consolidate', '--apply', '--ops', opsPath]);
  assert.equal(applyRes.status, 0, applyRes.stderr || applyRes.stdout);

  const res = run(c, ['learnings', 'sql']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.learnings.length, 2);
  assert.ok(out.learnings.every((l) => l.id.startsWith('sql/')));
});

test('learnings --json carries quarantined episodes as { path, sha256 }', () => {
  const c = ctx();
  seed(c);
  const ep = quarantineEpisode(c);

  const res = run(c, ['learnings']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.quarantined, [{ path: ep.path, sha256: ep.sha256 }]);
});

test('plain learnings output renders a muted quarantine line when episodes are quarantined', () => {
  const c = ctx();
  seed(c);
  quarantineEpisode(c);

  const res = run(c, ['learnings'], { json: false });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(
    res.stdout,
    /1 quarantined episode\(s\) — inspect with ae consolidate --status, clear with knowledge purge <path>/
  );
});

test('learnings with no quarantined episodes: empty array in JSON, no quarantine line in plain output', () => {
  const c = ctx();
  seed(c);

  const out = JSON.parse(run(c, ['learnings']).stdout);
  assert.deepEqual(out.quarantined, []);

  const plain = run(c, ['learnings'], { json: false });
  assert.equal(plain.status, 0, plain.stderr || plain.stdout);
  assert.doesNotMatch(plain.stdout, /quarantined episode/);
});

test('plain learnings output is fenced and annotates contradicted evidence', () => {
  const c = ctx();
  seed(c);

  const res = run(c, ['learnings'], { json: false });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /untrusted memory/);
  assert.match(res.stdout, /evidence contradicts \(1 failures\)/);
});

test('learnings --why <id> --json returns the provenance chain', () => {
  const c = ctx();
  const { humanId } = seed(c);

  const res = run(c, ['learnings', '--why', humanId]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.id, humanId);
  assert.equal(out.episodes[0].kind, 'human-teaching');
  assert.equal(out.failures, 1);
});

test('learnings --why missing/id exits 1', () => {
  const c = ctx();
  seed(c);

  const res = run(c, ['learnings', '--why', 'missing/id']);
  assert.equal(res.status, 1, res.stdout);
});

test('plain --why output includes failures and promotionEligible annotations like the listing view', () => {
  const c = ctx();
  const { autoId, humanId } = seed(c);

  const autoRes = run(c, ['learnings', '--why', autoId], { json: false });
  assert.equal(autoRes.status, 0, autoRes.stderr || autoRes.stdout);
  assert.match(autoRes.stdout, /promotable → \/create-primitive/);

  const humanRes = run(c, ['learnings', '--why', humanId], { json: false });
  assert.equal(humanRes.status, 0, humanRes.stderr || humanRes.stdout);
  assert.match(humanRes.stdout, /evidence contradicts \(1 failures\)/);
});

test('learnings --why on a superseded learning synthesizes status: superseded, matching the listing view', () => {
  const c = ctx();
  const { oldId, newId } = seedLegacyAndSupersede(c);

  const res = run(c, ['learnings', '--why', oldId]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'superseded');
  assert.equal(out.supersededBy, newId);
});

test('learnings --why exposes lastConfirmed, supersededBy, mergedFrom, and claimLine', () => {
  const c = ctx();
  const { oldId, newId } = seedLegacyAndSupersede(c);

    const extraOp = {
    op: 'ADD',
    domain: 'sql',
    slug: 'legacy-claim-alt',
    trigger: 'an alternate legacy trigger',
    body: 'The alternate claim body.',
    episodes: [{ ...writeFixEpisode(c.ws, 'docs/solutions/perf/legacy-alt.md'), kind: 'fix', plan: 'docs/plans/p11b.md' }],
  };
  const extraRes = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [extraOp])]);
  assert.equal(extraRes.status, 0, extraRes.stderr || extraRes.stdout);
  const altId = JSON.parse(extraRes.stdout).applied[0].id;

  const mergedOp = {
    op: 'MERGE',
    targets: [newId, altId],
    domain: 'sql',
    slug: 'merged-claim',
    trigger: 'a merged trigger',
    body: 'The merged claim body.',
    episodes: [{ ...writeFixEpisode(c.ws, 'docs/solutions/perf/merged.md'), kind: 'fix', plan: 'docs/plans/p12.md' }],
  };
  const mergedRes = run(c, ['consolidate', '--apply', '--ops', writeOps(c.ws, [mergedOp])]);
  assert.equal(mergedRes.status, 0, mergedRes.stderr || mergedRes.stdout);
  const mergedId = JSON.parse(mergedRes.stdout).applied[0].id;

  const confirmRes = run(c, ['learning', 'confirm', mergedId]);
  assert.equal(confirmRes.status, 0, confirmRes.stderr || confirmRes.stdout);
  const today = new Date().toISOString().slice(0, 10);

  const whyOld = JSON.parse(run(c, ['learnings', '--why', oldId]).stdout);
  assert.equal(whyOld.supersededBy, newId);
  assert.equal(whyOld.claimLine, 'The original claim body.');

  const whyMerged = JSON.parse(run(c, ['learnings', '--why', mergedId]).stdout);
  assert.equal(whyMerged.lastConfirmed, today);
  assert.deepEqual(whyMerged.mergedFrom, [newId, altId]);
  assert.equal(whyMerged.claimLine, 'The merged claim body.');
});

test('trailing bare --why (last arg, no value) exits usage instead of silently falling through to the full listing', () => {
  const c = ctx();
  seed(c);

  const res = spawnSync(
    process.execPath,
    [binPath, 'learnings', '--workspace', c.ws, '--copilot-home', c.home, '--json', '--why'],
    { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: c.harnessHome } }
  );
  assert.equal(res.status, 2, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.match(out.blockedReason || '', /usage/i);
});

test('--why immediately followed by another flag treats the flag as a missing value, not as an id', () => {
  const c = ctx();
  seed(c);

    const res = spawnSync(
    process.execPath,
    [binPath, 'learnings', '--why', '--json', '--workspace', c.ws, '--copilot-home', c.home],
    { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: c.harnessHome } }
  );
  assert.equal(res.status, 2, res.stderr || res.stdout);
    const out = JSON.parse(res.stdout);
  assert.match(out.blockedReason || '', /usage/i);
});

test('learnings on a storeless workspace exits 0 with an empty listing and never materializes the store', () => {
  const c = ctx();
  const dir = storeDir(c.ws, { home: c.harnessHome });
  assert.equal(fs.existsSync(dir), false, 'precondition: no store yet');

  const res = run(c, ['learnings']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out, { learnings: [], counts: { active: 0, total: 0 }, quarantined: [] });

  assert.equal(fs.existsSync(dir), false, 'ae learnings must not materialize a knowledge store');
});

test('learnings --why on a storeless workspace exits 1 and never materializes the store', () => {
  const c = ctx();
  const dir = storeDir(c.ws, { home: c.harnessHome });
  assert.equal(fs.existsSync(dir), false, 'precondition: no store yet');

  const res = run(c, ['learnings', '--why', 'sql/missing']);
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout + res.stderr, /E_TARGET/);

  assert.equal(fs.existsSync(dir), false, 'ae learnings --why must not materialize a knowledge store');
});

test('failure count survives more than 20 unrelated events written after the verify-fail', () => {
  const c = ctx();
  const { humanId } = seed(c);

    const eventsPath = path.join(c.ws, '.harness', 'events.jsonl');
  const filler = Array.from({ length: 25 }, () => JSON.stringify({ version: 2, type: 'orient', result: 'pass' }));
  fs.appendFileSync(eventsPath, `${filler.join('\n')}\n`);

  const res = run(c, ['learnings']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  const human = out.learnings.find((l) => l.id === humanId);
  assert.equal(human.failures, 1, 'verify-fail event must still be counted past a 20-event window of unrelated events');
});

test('learnings listing is byte-identical under feedback off and shows exposed/helped/wrong/last_exposed under suggest and on', () => {
  const c = ctx();
  const { autoId, humanId } = seed(c);
  const outputs = () => [run(c, ['learnings']).stdout, run(c, ['learnings'], { json: false }).stdout];
  const before = outputs();

  for (let i = 0; i < 2; i++) {
    recordExposure({ recordRoot: c.ws, workspace: c.ws, home: c.harnessHome, planPath: 'docs/plans/p1.md', delivered: [{ id: autoId }], now: new Date(`2026-11-0${i + 1}T00:00:00Z`) });
  }
  publishFeedbackRecord({ workspace: c.ws, home: c.harnessHome, operation: 'c'.repeat(64), planPath: 'docs/plans/p1.md', captureDate: '2026-11-02', feedback: { recalled: [{ id: autoId, verdict: 'wrong' }] } });
  assert.deepEqual(outputs(), before, 'off: listing output is byte-identical with records present');

  for (const state of ['suggest', 'on']) {
    assert.equal(run(c, ['knowledge', 'feedback', state]).status, 0);
    const out = JSON.parse(run(c, ['learnings']).stdout);
    assert.equal(out.feedback, state);
    const auto = out.learnings.find((l) => l.id === autoId);
    const human = out.learnings.find((l) => l.id === humanId);
    assert.deepEqual([auto.exposed, auto.helped, auto.wrong, auto.last_exposed], [2, 0, 1, '2026-11-02T00:00:00.000Z']);
    assert.deepEqual([human.exposed, human.helped, human.wrong, human.last_exposed], [0, 0, 0, null]);
    const plain = run(c, ['learnings'], { json: false }).stdout;
    assert.match(plain, /exposed 2 · helped 0 · wrong 1 · last_exposed 2026-11-02/);
    assert.match(plain, /exposed 0 · helped 0 · wrong 0 · last_exposed never/);
  }
});
