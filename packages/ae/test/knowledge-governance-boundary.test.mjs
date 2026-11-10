/**
 * Knowledge branch/overlay boundaries, promote, prune, and absorb guards.
 * Folded from knowledge-boundary-hardening.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureStore, listLearnings, readLedger, readGovernance, appendGovernance } from '../lib/knowledge/store.mjs';
import { applyOps, rebuildIndex } from '../lib/knowledge/apply.mjs';
import { absorbHandEdits, rebuildStore } from '../lib/knowledge/admin.mjs';
import { buildPromotionOps, PROMOTE_OPS_REL, promotionDigest } from '../lib/knowledge/promote.mjs';
import { pruneBuckets } from '../lib/knowledge/prune.mjs';
import { knowledgeStatus } from '../lib/knowledge/status.mjs';
import { consolidateStatus, consolidateCandidates, verifiedAndPlans, isActiveFm } from '../lib/knowledge/consolidate.mjs';
import { writeFeedbackConfig } from '../lib/knowledge/store.mjs';
import { listingView } from '../lib/knowledge/listing.mjs';
import { learningVersion, publishFeedbackRecord, recordExposure } from '../lib/learning-feedback.mjs';
import { feedbackPruningCheck } from '../lib/doctor.mjs';
import { bucketDirFor, readBucketMeta, isSafeBucketKey } from '../lib/knowledge/overlay.mjs';
import { retrievalExclusion } from '../lib/knowledge/retrieve.mjs';
import { branchKeyFor } from '../lib/git-context.mjs';
import { runOrient } from '../lib/orient.mjs';

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

/** Cloned workspace with origin/HEAD → main, checked out on `branch`. */
function featureWorkspace(branch = 'feature/hardening') {
  const origin = tempDir('bh-origin-');
  git(origin, ['init', '-q', '-b', 'main']);
  git(origin, ['config', 'user.email', 't@example.test']);
  git(origin, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(origin, 'seed.txt'), 'seed\n');
  git(origin, ['add', '.']);
  git(origin, ['commit', '-qm', 'seed']);
  const ws = tempDir('bh-ws-');
  git(ws, ['clone', '-q', origin, '.']);
  git(ws, ['config', 'user.email', 't@example.test']);
  git(ws, ['config', 'user.name', 'T']);
  if (branch) {
        const co = git(ws, ['checkout', '-qb', branch]);
    assert.equal(co.status, 0, `checkout -b ${branch.slice(0, 40)}… failed: ${co.stderr}`);
  }
  return ws;
}

/** A plain fix-kind episode (no frontmatter kind — a legitimate fix). */
function writeFixEpisode(ws, rel, branch = null) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = branch ? `---\ndate: 2026-08-01\nbranch: ${branch}\n---\n\nfix evidence for ${rel}.\n` : `fix evidence for ${rel}.\n`;
  fs.writeFileSync(full, text, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex'), kind: 'fix', plan: 'docs/plans/p1.md' };
}

/** An insight-kind episode — its OWN frontmatter says `kind: insight`. */
function writeInsightEpisode(ws, rel) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = `---\ntitle: "${rel}"\nkind: insight\ndate: 2026-08-01\n---\n\ninsight body for ${rel}.\n`;
  fs.writeFileSync(full, text, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex'), kind: 'insight', plan: null };
}

function writeOps(ws, ops, envelope = null) {
  const p = path.join(ws, `ops-${crypto.randomUUID()}.json`);
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ...(envelope ? { promotion: envelope } : {}), ops }));
  return p;
}

function addOp(ws, slug, over = {}) {
  return {
    op: 'ADD',
    domain: 'sql',
    slug,
    trigger: `trigger for ${slug}`,
    body: `Claim body for ${slug}.`,
    episodes: over.episodes || [writeFixEpisode(ws, `docs/solutions/perf/${slug}.md`)],
    ...over,
  };
}

function seedBucketLearning(ws, home, slug, over = {}) {
  const applied = applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws, slug, over)]), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  assert.equal(applied.layer, 'branch');
  return applied;
}

/** Hand-author a promotion op-set (digest computed exactly as apply.mjs does)
 * and run it through the REAL `ae consolidate --apply` CLI — the lane an
 * emitter-only gate never sees. */
function handAuthoredPromotion(ws, home, branchKey, ops) {
  const opsFull = path.join(ws, `hand-promote-${crypto.randomUUID()}.json`);
  fs.writeFileSync(
    opsFull,
    JSON.stringify({ schema: 1, promotion: { branchKey, meta: null, digest: promotionDigest(ops) }, ops }, null, 2)
  );
  return opsFull;
}

function cli(ws, home, args) {
  return spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: home },
  });
}

function sourceStamp(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('A: a promotion op cannot re-label recorded evidence — kind/plan are copied from the source learning, never the ops file', () => {
  const ws = featureWorkspace('feature/launder');
  const home = tempDir('bh-home-a-');
  const ep = writeInsightEpisode(ws, 'docs/solutions/perf/observation.md');
  seedBucketLearning(ws, home, 'laundered', {
    trigger: 'observing a slow plan',
    body: 'Sequential scans on a big table are often a missing index.',
    episodes: [ep],
  });
  const { dir } = ensureStore(ws, { home });
  const key = branchKeyFor('feature/launder');
  const source = listLearnings(bucketDirFor(dir, key)).find((l) => l.id === 'sql/laundered');
  assert.equal(source.fm.episodes[0].kind, 'insight', 'precondition: the branch claim records insight-only evidence');

  // The attack: the same recorded episode, re-asserted as a verified fix on a plan.
  const ops = [
    {
      op: 'ADD',
      domain: 'sql',
      slug: 'laundered',
      trigger: 'observing a slow plan',
      body: 'Sequential scans on a big table are often a missing index.',
      episodes: [{ path: ep.path, sha256: ep.sha256, kind: 'fix', plan: 'docs/plans/fabricated.md' }],
      source: { id: 'sql/laundered', sha256: sourceStamp(source.file) },
    },
  ];
  const applied = applyOps({ workspace: ws, opsPath: handAuthoredPromotion(ws, home, key, ops), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));

  const golden = listLearnings(dir).find((l) => l.id === 'sql/laundered');
  assert.equal(golden.fm.episodes.length, 1);
  assert.equal(golden.fm.episodes[0].kind, 'insight', 'the promoted claim records the SOURCE kind, not the asserted one');
  assert.equal(golden.fm.episodes[0].plan, '', 'the promoted claim records the SOURCE plan, not the asserted one');
  const { verified, plans } = verifiedAndPlans(golden.fm);
  assert.equal(verified, 0, 'an insight-only claim never counts as a verified fix after promotion');
  assert.equal(plans, 0);
});

test('A: an op listing the same episode more than once is refused — one link per episode', () => {
  const ws = featureWorkspace('feature/dupes');
  const home = tempDir('bh-home-a2-');
  const ep = writeFixEpisode(ws, 'docs/solutions/perf/dupe.md');
  const applied = applyOps({
    workspace: ws,
    opsPath: writeOps(ws, [addOp(ws, 'dupes', { episodes: [ep, { ...ep, plan: 'docs/plans/p2.md' }, { ...ep, plan: 'docs/plans/p3.md' }] })]),
    home,
  });
  assert.equal(applied.exitCode, 1);
  assert.equal(applied.rejected[0].code, 'E_SCHEMA');
  assert.match(applied.rejected[0].reason, /listed more than once/);
});

test('A: a promotion op cannot inflate evidence by repeating one recorded episode across fabricated plans', () => {
  const ws = featureWorkspace('feature/inflate');
  const home = tempDir('bh-home-a3-');
  const ep = writeFixEpisode(ws, 'docs/solutions/perf/single.md');
  seedBucketLearning(ws, home, 'inflated', { episodes: [ep] });
  const { dir } = ensureStore(ws, { home });
  const key = branchKeyFor('feature/inflate');
  const source = listLearnings(bucketDirFor(dir, key)).find((l) => l.id === 'sql/inflated');

  const ops = [
    {
      op: 'ADD',
      domain: 'sql',
      slug: 'inflated',
      trigger: 'trigger for inflated',
      body: 'Claim body for inflated.',
      episodes: [
        { path: ep.path, sha256: ep.sha256, kind: 'fix', plan: 'docs/plans/p1.md' },
        { path: ep.path, sha256: ep.sha256, kind: 'fix', plan: 'docs/plans/p2.md' },
        { path: ep.path, sha256: ep.sha256, kind: 'fix', plan: 'docs/plans/p3.md' },
      ],
      source: { id: 'sql/inflated', sha256: sourceStamp(source.file) },
    },
  ];
  const applied = applyOps({ workspace: ws, opsPath: handAuthoredPromotion(ws, home, key, ops), home });
  assert.equal(applied.exitCode, 1, 'a duplicated-evidence promotion never lands');
  assert.match(applied.rejected[0].reason, /listed more than once/);
  assert.equal(listLearnings(dir).length, 0, 'golden untouched');
});

test('B: a hand-authored promotion envelope is refused for path-shaped, detached, non-ancestor, and non-active sources — through consolidate --apply', () => {
  const ws = featureWorkspace('feature/gates');
  const home = tempDir('bh-home-b-');
  const ep = writeFixEpisode(ws, 'docs/solutions/perf/gated.md');
  seedBucketLearning(ws, home, 'gated', { episodes: [ep] });
  const { dir } = ensureStore(ws, { home });
  const key = branchKeyFor('feature/gates');
  const bucketDir = bucketDirFor(dir, key);
  const source = listLearnings(bucketDir).find((l) => l.id === 'sql/gated');
  const baseOps = () => [
    {
      op: 'ADD',
      domain: 'sql',
      slug: 'gated',
      trigger: 'trigger for gated',
      body: 'Claim body for gated.',
      episodes: [{ path: ep.path, sha256: ep.sha256, kind: 'fix', plan: 'docs/plans/p1.md' }],
      source: { id: 'sql/gated', sha256: sourceStamp(source.file) },
    },
  ];

  // (1) key shapes — every one the emitter refuses, refused by the writer too.
  for (const badKey of ['../evil', 'a/b', 'a\\b', '.', '..', 'C:', 'foo:bar', path.resolve(os.tmpdir(), 'abs')]) {
    assert.equal(isSafeBucketKey(badKey), false, `isSafeBucketKey must reject ${JSON.stringify(badKey)}`);
    const res = cli(ws, home, ['consolidate', '--apply', '--ops', handAuthoredPromotion(ws, home, badKey, baseOps())]);
    assert.equal(res.status, 1, `${badKey}: ${res.stdout}${res.stderr}`);
    assert.match(JSON.parse(res.stdout).rejected[0].reason, /plain branchKey/, `key ${badKey}`);
  }

  // (2) detached bucket — never promotable, derived from the key shape.
  const detachedRes = cli(ws, home, [
    'consolidate',
    '--apply',
    '--ops',
    handAuthoredPromotion(ws, home, 'detached-abcdefabcdef', baseOps()),
  ]);
  assert.equal(detachedRes.status, 1, detachedRes.stdout + detachedRes.stderr);
  assert.match(JSON.parse(detachedRes.stdout).rejected[0].reason, /never promotable/);

    const supersededFile = source.file;
  fs.writeFileSync(supersededFile, fs.readFileSync(supersededFile, 'utf8').replace('superseded_by: null', 'superseded_by: sql/newer'), 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'hand edit']);
  const supersededOps = [{ ...baseOps()[0], source: { id: 'sql/gated', sha256: sourceStamp(supersededFile) } }];
  const supersededRes = cli(ws, home, ['consolidate', '--apply', '--ops', handAuthoredPromotion(ws, home, key, supersededOps)]);
  assert.equal(supersededRes.status, 1, supersededRes.stdout + supersededRes.stderr);
  assert.match(JSON.parse(supersededRes.stdout).rejected[0].reason, /not an active, unpromoted bucket learning/);
  assert.equal(listLearnings(dir).length, 0, 'nothing was laundered into golden');

    const noopRes = cli(ws, home, [
    'consolidate',
    '--apply',
    '--ops',
    handAuthoredPromotion(ws, home, key, [{ op: 'NOOP', reason: 'clearing debt', episodes: [{ path: ep.path, sha256: ep.sha256 }] }]),
  ]);
  assert.equal(noopRes.status, 1, noopRes.stdout + noopRes.stderr);
  assert.match(JSON.parse(noopRes.stdout).rejected[0].reason, /never NOOP/);

    fs.writeFileSync(supersededFile, fs.readFileSync(supersededFile, 'utf8').replace('superseded_by: sql/newer', 'superseded_by: null'), 'utf8');
  const metaPath = path.join(bucketDir, 'meta.json');
  fs.writeFileSync(metaPath, JSON.stringify({ ...readBucketMeta(bucketDir), baseSha: 'f'.repeat(40) }) + '\n');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'reuse']);
  const reuseOps = [{ ...baseOps()[0], source: { id: 'sql/gated', sha256: sourceStamp(supersededFile) } }];
  const reuseRes = cli(ws, home, ['consolidate', '--apply', '--ops', handAuthoredPromotion(ws, home, key, reuseOps)]);
  assert.equal(reuseRes.status, 1, reuseRes.stdout + reuseRes.stderr);
  assert.match(JSON.parse(reuseRes.stdout).rejected[0].reason, /unrelated history/);
  assert.equal(listLearnings(dir).length, 0, 'golden still untouched');
});

test('C: a promoted bucket entry stays tombstoned — the bucket INDEX drops it, a STRENGTHEN cannot resurrect it, and prune --merged still sees it', () => {
  const ws = featureWorkspace('feature/tombstone');
  const home = tempDir('bh-home-c-');
  const first = writeFixEpisode(ws, 'docs/solutions/perf/tomb-a.md');
  seedBucketLearning(ws, home, 'tombstoned', { episodes: [first] });
  const { dir } = ensureStore(ws, { home });
  const key = branchKeyFor('feature/tombstone');
  const bucketDir = bucketDirFor(dir, key);

  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, true, emitted.blockedReason);
  assert.equal(applyOps({ workspace: ws, opsPath: path.join(ws, PROMOTE_OPS_REL), home }).exitCode, 0);

  const tombstone = listLearnings(bucketDir).find((l) => l.id === 'sql/tombstoned');
  assert.equal(tombstone.fm.promoted_to_golden, 'sql/tombstoned');
  assert.equal(isActiveFm(tombstone.fm), false, 'a branch→golden tombstone is not an active learning');
  assert.ok(
    !fs.readFileSync(path.join(bucketDir, 'INDEX.md'), 'utf8').includes('sql/tombstoned'),
    'the bucket INDEX must agree with retrievalExclusion and drop the tombstone'
  );

    const more = writeFixEpisode(ws, 'docs/solutions/perf/tomb-b.md');
  const strengthen = applyOps({
    workspace: ws,
    opsPath: writeOps(ws, [{ op: 'STRENGTHEN', target: 'sql/tombstoned', episodes: [more] }]),
    home,
  });
  assert.equal(strengthen.exitCode, 1, JSON.stringify(strengthen));
  assert.equal(strengthen.rejected[0].code, 'E_TARGET');

  const after = listLearnings(bucketDir).find((l) => l.id === 'sql/tombstoned');
  assert.equal(after.fm.promoted_to_golden, 'sql/tombstoned', 'the tombstone survives');
  assert.equal(retrievalExclusion(after), 'promoted-to-golden', 'the claim stays excluded from retrieval');
  assert.equal(buildPromotionOps({ workspace: ws, home, all: true }).pass, false, 'never re-offered for promotion');

  const pruned = pruneBuckets({ workspace: ws, home, merged: true });
  assert.equal(pruned.pass, true, pruned.blockedReason);
  assert.deepEqual(pruned.removed, [key], 'prune --merged still recognizes the fully-promoted bucket');
});

test('D: hand-deleting a BRANCH copy never retires the golden claim of the same id (a golden-only delete still does)', () => {
  const ws = featureWorkspace(null); // start on main
  const home = tempDir('bh-home-d-');
  const goldenEp = writeFixEpisode(ws, 'docs/solutions/perf/golden-x.md', 'main');
  const goldenApply = applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws, 'shared-x', { episodes: [goldenEp] })]), home });
  assert.equal(goldenApply.exitCode, 0, JSON.stringify(goldenApply.rejected));
  assert.equal(goldenApply.layer, 'golden');

  git(ws, ['checkout', '-qb', 'feature/throwaway']);
  const branchEp = writeFixEpisode(ws, 'docs/solutions/perf/branch-x.md');
  seedBucketLearning(ws, home, 'shared-x', { episodes: [branchEp], body: 'A throwaway branch version of the claim.' });

  const { dir } = ensureStore(ws, { home });
  const key = branchKeyFor('feature/throwaway');
  const bucketCopy = listLearnings(bucketDirFor(dir, key)).find((l) => l.id === 'sql/shared-x');
  assert.ok(bucketCopy, 'precondition: both layers hold sql/shared-x');

  // The human deletes ONLY the throwaway branch copy.
  fs.rmSync(bucketCopy.file, { force: true });
  const absorbed = absorbHandEdits({ workspace: ws, home });
  assert.deepEqual(absorbed.deleted, ['sql/shared-x']);

  assert.equal(readGovernance(dir).has('sql/shared-x'), false, 'a bucket-scoped delete writes no store-wide governance decision');
  const goldenStill = listLearnings(dir).find((l) => l.id === 'sql/shared-x');
  assert.ok(goldenStill, 'the golden claim survives');
  assert.equal(isActiveFm(goldenStill.fm), true, 'and stays active');

    git(ws, ['checkout', '-q', 'main']);
  const rebuilt = rebuildStore({ workspace: ws, home, yes: true, copilotHome: tempDir('bh-ch-d-') });
  assert.equal(rebuilt.pass, true, rebuilt.blockedReason);
  assert.equal(readGovernance(dir).has('sql/shared-x'), false, 'a rebuild cannot resurrect a retire that was never recorded');

  // Control: deleting the LAST copy of an id is still a retirement.
  git(ws, ['checkout', '-q', 'feature/throwaway']);
  assert.equal(applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws, 'shared-x', { episodes: [branchEp] })]), home }).exitCode, 0);
  const soleCopy = listLearnings(bucketDirFor(dir, key)).find((l) => l.id === 'sql/shared-x');
  fs.rmSync(soleCopy.file, { force: true });
  const absorbedSole = absorbHandEdits({ workspace: ws, home });
  assert.deepEqual(absorbedSole.deleted, ['sql/shared-x']);
  assert.equal(readGovernance(dir).get('sql/shared-x')?.action, 'retire', 'no layer holds it any more — a real retirement');
});

test('hand-deleting a PROMOTED golden claim still records a retire — an inactive bucket tombstone never suppresses governance', () => {
  const ws = featureWorkspace('feature/promo-delete');
  const home = tempDir('bh-home-e-');
  const ep = writeFixEpisode(ws, 'docs/solutions/perf/promo-delete.md');
  seedBucketLearning(ws, home, 'promoted-then-deleted', { episodes: [ep] });
  const { dir } = ensureStore(ws, { home });
  const key = branchKeyFor('feature/promo-delete');

  assert.equal(buildPromotionOps({ workspace: ws, home, all: true }).pass, true);
  assert.equal(applyOps({ workspace: ws, opsPath: path.join(ws, PROMOTE_OPS_REL), home }).exitCode, 0);

  const tombstone = listLearnings(bucketDirFor(dir, key)).find((l) => l.id === 'sql/promoted-then-deleted');
  assert.equal(tombstone.fm.promoted_to_golden, 'sql/promoted-then-deleted');
  assert.equal(isActiveFm(tombstone.fm), false, 'precondition: the only remaining twin is an INACTIVE tombstone');

  // The human deletes the promoted golden claim.
  const golden = listLearnings(dir).find((l) => l.id === 'sql/promoted-then-deleted');
  fs.rmSync(golden.file, { force: true });
  const absorbed = absorbHandEdits({ workspace: ws, home });
  assert.deepEqual(absorbed.deleted, ['sql/promoted-then-deleted']);
  assert.equal(
    readGovernance(dir).get('sql/promoted-then-deleted')?.action,
    'retire',
    'no ACTIVE layer holds the id any more — the deletion is a real retirement'
  );

  // ...and the retire survives the wipe: a rebuild must not resurrect it.
  const rebuilt = rebuildStore({ workspace: ws, home, yes: true, copilotHome: tempDir('bh-ch-e-') });
  assert.equal(rebuilt.pass, true, rebuilt.blockedReason);
  const resurrected = [
    ...listLearnings(dir),
    ...listLearnings(bucketDirFor(dir, key)),
  ].filter((l) => l.id === 'sql/promoted-then-deleted' && isActiveFm(l.fm));
  assert.deepEqual(resurrected, [], 'a rebuild cannot bring back a claim the human deleted');
});

test('F: --layer golden needs the human-authority signal; --layer branch is refused instead of silently ignored', () => {
  const ws = featureWorkspace('feature/selfgrant');
  const home = tempDir('bh-home-f-');
  const ep = writeFixEpisode(ws, 'docs/solutions/perf/selfgrant.md');
  const opsPath = writeOps(ws, [addOp(ws, 'selfgrant', { episodes: [ep] })]);
  const { dir } = ensureStore(ws, { home });

  const ungated = applyOps({ workspace: ws, opsPath, home, layer: 'golden' });
  assert.equal(ungated.exitCode, 2, JSON.stringify(ungated));
  assert.equal(ungated.rejected[0].code, 'E_LAYER');
  assert.equal(listLearnings(dir).length, 0, 'nothing reached golden');

  const branchOverride = applyOps({ workspace: ws, opsPath, home, layer: 'branch' });
  assert.equal(branchOverride.exitCode, 2, JSON.stringify(branchOverride));
  assert.equal(branchOverride.rejected[0].code, 'E_LAYER');

  const approved = applyOps({ workspace: ws, opsPath, home, layer: 'golden', approve: true });
  assert.equal(approved.exitCode, 0, JSON.stringify(approved.rejected));
  assert.equal(approved.layer, 'golden', 'an explicitly approved override still works');
});

test('H: three strikes cannot be reset by switching branches — the quarantine marker is store-global and every lane reports it', () => {
  const ws = featureWorkspace('feature/strike-a');
  const home = tempDir('bh-home-h-');
  const copilotHome = tempDir('bh-ch-h-');
  const ep = writeFixEpisode(ws, 'docs/solutions/perf/striker.md');
  const opsPath = writeOps(ws, [addOp(ws, 'striker', { episodes: [ep], body: 'x'.repeat(1300) })]);
  const { dir } = ensureStore(ws, { home });

  for (let i = 0; i < 2; i++) {
    const res = applyOps({ workspace: ws, opsPath, home });
    assert.equal(res.exitCode, 1);
    assert.equal(res.rejected[0].code, 'E_BYTE_CAP');
  }
  assert.equal(readLedger(dir).filter((e) => e.failure).length, 2, 'strikes accumulate in the store-global ledger');

  // The escape: a different branch used to start the count over at zero.
  git(ws, ['checkout', '-qb', 'feature/strike-b']);
  const third = applyOps({ workspace: ws, opsPath, home });
  assert.equal(third.exitCode, 1);
  const ledger = readLedger(dir);
  assert.equal(ledger.filter((e) => e.failure).length, 3, 'the third strike lands on the same running count');
  assert.equal(ledger.filter((e) => e.quarantined).length, 1, 'and quarantines on exactly the third');

  // Every lane reports it — including a THIRD branch that never saw a strike.
  git(ws, ['checkout', '-qb', 'feature/strike-c']);
  const status = consolidateStatus({ workspace: ws, copilotHome, home });
  assert.equal(status.quarantined.length, 1, 'consolidate --status reports the quarantine from any branch');
  assert.ok(!status.unconsolidated.some((u) => u.path === ep.path), 'a quarantined episode stops counting as debt in every lane');
});

test('I: prune refuses to delete a bucket holding active, unpromoted learnings without --yes, and previews what is at stake', () => {
  const ws = featureWorkspace('feature/liveprune');
  const home = tempDir('bh-home-i-');
  seedBucketLearning(ws, home, 'still-live');
  const { dir } = ensureStore(ws, { home });
  const key = branchKeyFor('feature/liveprune');

  // `knowledge status` says this bucket is NOT prunable...
  const status = knowledgeStatus({ workspace: ws, home });
  const row = status.buckets.find((b) => b.key === key);
  assert.equal(row.active, 1);
  assert.equal(row.prunable, false);

  // ...so a stale/branch selector must not silently delete it.
  fs.writeFileSync(
    path.join(bucketDirFor(dir, key), 'meta.json'),
    JSON.stringify({ ...readBucketMeta(bucketDirFor(dir, key)), createdAt: new Date(Date.now() - 90 * 86_400_000).toISOString() }) + '\n'
  );
  const refused = pruneBuckets({ workspace: ws, home, staleDays: 30 });
  assert.equal(refused.pass, false, 'a stale selector must not destroy live work unattended');
  assert.equal(refused.exitCode, 2);
  assert.match(refused.blockedReason, /--yes/);
  assert.deepEqual(
    refused.preview.map((p) => ({ key: p.key, active: p.active, promoted: p.promoted, total: p.total })),
    [{ key, active: 1, promoted: 0, total: 1 }],
    'the refusal names exactly what would be lost'
  );
  assert.ok(fs.existsSync(bucketDirFor(dir, key)), 'the bucket is still there');

  const confirmed = pruneBuckets({ workspace: ws, home, staleDays: 30, yes: true });
  assert.equal(confirmed.pass, true, confirmed.blockedReason);
  assert.deepEqual(confirmed.removed, [key]);
  assert.equal(confirmed.preview.length, 1, 'a confirmed prune still reports the preview');
  assert.ok(!fs.existsSync(bucketDirFor(dir, key)));
});

test('I: a bucket status calls prunable (nothing active) still prunes unattended', () => {
  const ws = featureWorkspace('feature/emptyprune');
  const home = tempDir('bh-home-i2-');
  seedBucketLearning(ws, home, 'landed');
  const key = branchKeyFor('feature/emptyprune');
  assert.equal(buildPromotionOps({ workspace: ws, home, all: true }).pass, true);
  assert.equal(applyOps({ workspace: ws, opsPath: path.join(ws, PROMOTE_OPS_REL), home }).exitCode, 0);

  const status = knowledgeStatus({ workspace: ws, home });
  assert.equal(status.buckets.find((b) => b.key === key).prunable, true);
  const pruned = pruneBuckets({ workspace: ws, home, branchKey: key });
  assert.equal(pruned.pass, true, pruned.blockedReason);
  assert.deepEqual(pruned.removed, [key]);
});

test('J: the promote op-set refuses to write through a symlinked .harness directory', () => {
  const ws = featureWorkspace('feature/opswrite');
  const home = tempDir('bh-home-j-');
  seedBucketLearning(ws, home, 'contained');

  const outside = tempDir('bh-outside-');
  fs.rmSync(path.join(ws, '.harness'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(ws, '.harness'), 'dir');

  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, false, 'a symlinked .harness must refuse the write, not follow it');
  assert.match(emitted.blockedReason, /symlink/i);
  assert.ok(!fs.existsSync(path.join(outside, 'promote-ops.json')), 'nothing landed outside the workspace');
});

test('K: every destructive knowledge path routes through an fs-safe realpath guard', () => {
  const guarded = [
    ['lib/knowledge/prune.mjs', /assertRealpathContained\(txDir, path\.join\('branches'/],
    ['lib/knowledge/layer.mjs', /assertRealpathContained\(dir, path\.join\('branches'/],
        ['lib/knowledge/store-io.mjs', /assertRealpathContained\(p\.storeRoot, p\.rel\)/],
    ['lib/knowledge/apply.mjs', /writeLearningFile\(src\.file, serializeLearning\(/],
  ];
  for (const [rel, pattern] of guarded) {
    const src = fs.readFileSync(path.join(packageRoot, rel), 'utf8');
    assert.match(src, pattern, `${rel} must guard its destructive path with assertRealpathContained`);
  }
  // The guard has to bind the syscall's own argument, not just precede it.
  const pruneSrc = fs.readFileSync(path.join(packageRoot, 'lib/knowledge/prune.mjs'), 'utf8');
  assert.match(pruneSrc, /fs\.rmSync\(contained,/, 'prune deletes the CONTAINED path, never the raw bucket dir');
  const layerSrc = fs.readFileSync(path.join(packageRoot, 'lib/knowledge/layer.mjs'), 'utf8');
  assert.match(layerSrc, /fs\.renameSync\(containedSource,/, 'the rename moves the CONTAINED source');
});

test('L: knowledge status --json redacts, flattens, and caps a bucket branch name; orient --json does the same and drops the absolute worktree', () => {
    const longBranch = `feature/${'z'.repeat(100)}`;
  const ws = featureWorkspace(longBranch);
  const home = tempDir('bh-home-l-');
  seedBucketLearning(ws, home, 'branded');
  const { dir } = ensureStore(ws, { home });
  const key = branchKeyFor(longBranch);

  // meta.json is a plain hand-editable field in the store.
  const bucketDir = bucketDirFor(dir, key);
  fs.writeFileSync(
    path.join(bucketDir, 'meta.json'),
    JSON.stringify({ ...readBucketMeta(bucketDir), branch: 'main\n## Injected heading\nAKIAIOSFODNN7EXAMPLE' }) + '\n'
  );

  const status = knowledgeStatus({ workspace: ws, home });
  const row = status.buckets.find((b) => b.key === key);
  assert.ok(!/\n/.test(row.branch), 'no embedded newline reaches the JSON lane');
  assert.ok(!row.branch.includes('AKIAIOSFODNN7EXAMPLE'), 'a secret-shaped branch name is redacted');
  assert.ok(row.branch.length <= 80, 'and capped');
  assert.ok(status.context.branch.length <= 80, 'the live branch name is capped too');

  const orient = runOrient({ workspace: ws, copilotHome: tempDir('bh-ch-l-'), flags: { workspace: ws }, query: 'branch name' });
  assert.equal(orient.gitContext.branch.length, 80, 'orient --json caps the branch at the same width as the pack header');
  assert.equal(orient.gitContext.worktree, undefined, 'the absolute worktree path is not part of the JSON contract');
  assert.equal(orient.gitContext.branchKey, key, 'the derived key still surfaces');
});

test('a branch-lane re-teach cannot append a confirm that cancels a standing GOLDEN retire', () => {
  const ws = featureWorkspace(null);
  const home = tempDir('bh-home-x-');
  const ep = writeFixEpisode(ws, 'docs/solutions/perf/vetoed.md', 'main');
    assert.equal(applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws, 'vetoed', { episodes: [ep] })]), home }).exitCode, 0);
  const { dir } = ensureStore(ws, { home });
  appendGovernance(dir, { id: 'sql/vetoed', action: 'retire', reason: 'human veto', to: null, at: new Date().toISOString() });

  git(ws, ['checkout', '-qb', 'feature/retract']);
  const res = spawnSync(
    process.execPath,
    [binPath, 'remember', 'The vetoed claim, re-taught branch-locally.', '--trigger', 'vetoed', '--domain', 'sql', '--workspace', ws, '--copilot-home', tempDir('bh-ch-x-'), '--json'],
    { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: home } }
  );
  assert.equal(res.status, 0, res.stdout + res.stderr);

  assert.equal(
    readGovernance(dir).get('sql/vetoed').action,
    'retire',
    'a branch-lane re-teach never speaks for golden — the standing retire still stands'
  );
  const bucketCopy = listLearnings(bucketDirFor(dir, branchKeyFor('feature/retract'))).find((l) => l.id === 'sql/vetoed');
  assert.equal(bucketCopy.fm.status, 'retired', 'the standing decision is reapplied to the layer that was written');
});

test('rebuildIndex excludes branch→golden tombstones so INDEX.md agrees with retrievalExclusion', () => {
    const dir = path.join(tempDir('bh-index-'), 'knowledge', 'repo-id');
  fs.mkdirSync(path.join(dir, 'learnings', 'sql'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'learnings', 'sql', 'gone.md'),
    '---\nschema: 1\ntrigger: "tombstoned trigger"\nstatus: active\nsource: auto\nepisodes:\nanchors: []\nsuperseded_by: null\nlast_confirmed: null\npromoted_to_golden: sql/gone\norigin: t\n---\n\nAbsorbed into golden.\n'
  );
  rebuildIndex(dir);
  assert.ok(!fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8').includes('sql/gone'));
});

test('no recall feedback path reaches the promote, retire, dispute or learning-content writers', () => {
  // Static: the feedback module and its readers never import or call a writer.
  // This is a regex check on source text, not a call-graph reachability proof;
  // the behavioral half below covers what actually runs.
  const writers = /\b(setLearningStatus|appendGovernance|buildPromotionOps|applyOps|writeLearningFile|withStoreTransaction|appendLedger|writeStoreFile)\b|knowledge\/(lifecycle|promote|apply)\.mjs/;
  const feedbackSrc = fs.readFileSync(path.join(packageRoot, 'lib/learning-feedback.mjs'), 'utf8');
  assert.doesNotMatch(feedbackSrc, writers, 'lib/learning-feedback.mjs must stay a reader of learning state');
  const doctorSrc = fs.readFileSync(path.join(packageRoot, 'lib/doctor.mjs'), 'utf8');
  const pruning = doctorSrc.slice(doctorSrc.indexOf('export function feedbackPruningCheck'), doctorSrc.indexOf('export function structuralChecks'));
  assert.ok(pruning.length > 0);
  assert.doesNotMatch(pruning, writers, 'the doctor pruning hint is advisory and never retires');

  // Behavioral: under feedback=on with a current wrong verdict and heavy exposure, every reader leaves learnings and governance untouched.
  const ws = featureWorkspace(null);
  const home = tempDir('bh-fb-home-');
  const ep = writeFixEpisode(ws, 'docs/solutions/logic/fb.md');
  assert.equal(applyOps({ workspace: ws, home, opsPath: writeOps(ws, [{ op: 'ADD', domain: 'logic', slug: 'fb-claim', trigger: 'feedback boundary', body: 'A claim judged wrong.', episodes: [ep] }]) }).exitCode, 0);
  const { dir } = ensureStore(ws, { home });
  const [learning] = listLearnings(dir);
  for (let i = 0; i < 6; i++) recordExposure({ recordRoot: ws, workspace: ws, home, planPath: 'docs/plans/p1.md', delivered: [{ id: learning.id }] });
  publishFeedbackRecord({ workspace: ws, home, operation: 'd'.repeat(64), planPath: 'docs/plans/p1.md', captureDate: '2026-11-09', feedback: { recalled: [{ id: learning.id, verdict: 'wrong', version: learningVersion(learning) }] } });
  assert.equal(writeFeedbackConfig(ws, { home, feedback: 'on' }).pass, true);
  const snapshot = () => JSON.stringify({ learnings: listLearnings(dir).map((l) => [l.id, l.fm, l.body]), governance: [...readGovernance(dir).entries()] });
  const before = snapshot();
  assert.deepEqual(consolidateCandidates({ workspace: ws, home }).feedback.review_required, [learning.id]);
  assert.equal(consolidateStatus({ workspace: ws, home }).due, true);
  assert.equal(knowledgeStatus({ workspace: ws, home }).feedback.learnings[0].exposed, 6);
  assert.equal(listingView({ workspace: ws, home }).learnings[0].wrong, 1);
  assert.equal(feedbackPruningCheck({ workspace: ws, home }).pass, false);
  assert.equal(snapshot(), before, 'feedback never changes learning status, content or governance');
});
