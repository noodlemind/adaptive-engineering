import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  ensureStore,
  listLearnings,
  readLedger,
  readGovernance,
  appendGovernance,
  commitStore,
} from '../lib/knowledge/store.mjs';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { buildPromotionOps, PROMOTE_OPS_REL, promotionDigest } from '../lib/knowledge/promote.mjs';
import { pruneBuckets } from '../lib/knowledge/prune.mjs';
import { rebuildStore } from '../lib/knowledge/admin.mjs';
import { bucketDirFor, listBuckets, loadLayeredLearnings } from '../lib/knowledge/overlay.mjs';
import { branchKeyFor } from '../lib/git-context.mjs';
import { retrievalExclusion } from '../lib/knowledge/retrieve.mjs';
import { writeRecheckConfig, writeStoreConfig } from '../lib/knowledge/store.mjs';
import { consolidateCandidates } from '../lib/knowledge/consolidate.mjs';
import { failureClusterId } from '../lib/learning-recheck.mjs';

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

/** Cloned workspace with origin/HEAD → main, on a feature branch. */
function featureWorkspace(branch = 'feature/promo') {
  const origin = tempDir('promo-origin-');
  git(origin, ['init', '-q', '-b', 'main']);
  git(origin, ['config', 'user.email', 't@example.test']);
  git(origin, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(origin, 'seed.txt'), 'seed\n');
  git(origin, ['add', '.']);
  git(origin, ['commit', '-qm', 'seed']);
  const ws = tempDir('promo-ws-');
  git(ws, ['clone', '-q', origin, '.']);
  git(ws, ['config', 'user.email', 't@example.test']);
  git(ws, ['config', 'user.name', 'T']);
  git(ws, ['checkout', '-qb', branch]);
  return ws;
}

function writeEpisode(ws, rel) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = `fix evidence for ${rel}.\n`;
  fs.writeFileSync(full, text, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex'), kind: 'fix', plan: 'docs/plans/p1.md' };
}

function writeOps(ws, ops) {
  const p = path.join(ws, `ops-${crypto.randomUUID()}.json`);
  fs.writeFileSync(p, JSON.stringify({ schema: 1, ops }));
  return p;
}

function addOp(ws, slug, over = {}) {
  return {
    op: 'ADD',
    domain: 'sql',
    slug,
    trigger: `trigger for ${slug}`,
    body: `Claim body for ${slug}.`,
    episodes: over.episodes || [writeEpisode(ws, `docs/solutions/perf/${slug}.md`)],
    ...over,
  };
}

/** Seed a bucket learning via the real routed write path. */
function seedBucketLearning(ws, home, slug, over = {}) {
  const applied = applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws, slug, over)]), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  assert.equal(applied.layer, 'branch');
  return applied;
}

test('promote emits a reviewable, digest-bound op-set and apply lands it golden with tombstones and absorb-branch audit', () => {
  const ws = featureWorkspace('feature/promo');
  const home = tempDir('promo-home-');
  seedBucketLearning(ws, home, 'claim-a');
  const { dir } = ensureStore(ws, { home });
  const key = branchKeyFor('feature/promo');

  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, true, emitted.blockedReason);
  assert.equal(emitted.ops, 1);
  assert.equal(emitted.remaining, 0);
  assert.equal(emitted.bucketKey, key);
  const opset = JSON.parse(fs.readFileSync(path.join(ws, PROMOTE_OPS_REL), 'utf8'));
  assert.equal(opset.promotion.branchKey, key);
  assert.match(opset.promotion.digest, /^[0-9a-f]{64}$/);
  assert.equal(opset.ops[0].op, 'ADD');
  assert.equal(opset.ops[0].source.id, 'sql/claim-a');

    const applied = applyOps({ workspace: ws, opsPath: path.join(ws, PROMOTE_OPS_REL), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
    assert.equal(applied.layer, 'golden');
  assert.equal(applied.bucketKey, null);

  // Golden now carries the claim.
  const golden = listLearnings(dir).find((l) => l.id === 'sql/claim-a');
  assert.ok(golden, 'promoted claim lives golden');
  assert.equal(golden.fm.branch, 'feature/promo', 'branch provenance carried forward');
  // Golden ledger consumed the episodes.
  assert.ok(readLedger(dir).some((e) => e.learning === 'sql/claim-a'));

  // Source tombstoned + excluded from retrieval; bucket prunable.
  const bucketDir = bucketDirFor(dir, key);
  const source = listLearnings(bucketDir).find((l) => l.id === 'sql/claim-a');
  assert.equal(source.fm.promoted_to_golden, 'sql/claim-a');
  assert.equal(retrievalExclusion(source), 'promoted-to-golden');

  // absorb-branch recorded for AUDIT — never a standing decision.
  const govLines = fs
    .readFileSync(path.join(dir, 'governance.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.ok(govLines.some((e) => e.id === 'sql/claim-a' && e.action === 'absorb-branch'));
  assert.equal(readGovernance(dir).has('sql/claim-a'), false, 'absorb-branch never becomes a standing decision');

  // The overlay no longer shadows golden with the tombstoned bucket entry.
  const overlay = loadLayeredLearnings({ workspace: ws, home });
  const surfaced = overlay.learnings.filter((l) => l.id === 'sql/claim-a');
  assert.equal(surfaced.length, 1);
  assert.equal(surfaced[0].layer, undefined, 'golden claim surfaces, tombstoned bucket copy does not');
});

test('REPLAY RULE regression: retire → absorb-branch → rebuild --yes still lands retired', () => {
  const ws = featureWorkspace('feature/replay');
  const home = tempDir('promo-home2-');
  git(ws, ['checkout', '-q', 'main']);
  const ep = writeEpisode(ws, 'docs/solutions/perf/replayed.md');
  const applied = applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws, 'replayed', { episodes: [ep] })]), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  assert.equal(applied.layer, 'golden');
  const { dir } = ensureStore(ws, { home });

  // 1) A human retires the id — the standing decision.
  appendGovernance(dir, { id: 'sql/replayed', action: 'retire', reason: 'human veto', to: null, at: new Date().toISOString() });
  // 2) A LATER absorb-branch audit entry lands for the same id.
  appendGovernance(dir, { id: 'sql/replayed', action: 'absorb-branch', reason: 'promoted from feature-x-00000000', to: null, at: new Date().toISOString() });
  assert.equal(readGovernance(dir).get('sql/replayed').action, 'retire', 'replay skips absorb-branch — retire stands');

  // 3) Rebuild wipes the corpus; the ledger survives.
  const rebuilt = rebuildStore({ workspace: ws, home, yes: true, copilotHome: tempDir('promo-ch-') });
  assert.equal(rebuilt.pass, true, rebuilt.blockedReason);

    const again = applyOps({ workspace: ws, opsPath: writeOps(ws, [addOp(ws, 'replayed', { episodes: [ep] })]), home });
  assert.equal(again.exitCode, 0, JSON.stringify(again.rejected));
  assert.deepEqual(again.governed, [{ id: 'sql/replayed', action: 'retire' }]);
  const learning = listLearnings(dir).find((l) => l.id === 'sql/replayed');
  assert.equal(learning.fm.status, 'retired', 'the standing retire survived the absorb-branch audit entry and the rebuild');
});

test('promotion of a shadowing claim maps to SUPERSEDE; a protected golden target rejects and disputes without strikes', () => {
  const ws = featureWorkspace('feature/shadowed');
  const home = tempDir('promo-home3-');
  const { dir } = ensureStore(ws, { home });
  // Protected golden twin: source human.
  fs.mkdirSync(path.join(dir, 'learnings', 'sql'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'learnings', 'sql', 'guarded.md'),
    `---\nschema: 1\ntrigger: "guarded trigger"\nstatus: active\nsource: human\nepisodes:\nanchors: []\nsuperseded_by: null\nlast_confirmed: null\norigin: t\n---\n\nProtected golden claim.\n`
  );
  seedBucketLearning(ws, home, 'guarded', { trigger: 'guarded trigger v2', body: 'Branch challenger claim.' });

  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, true, emitted.blockedReason);
  const opset = JSON.parse(fs.readFileSync(path.join(ws, PROMOTE_OPS_REL), 'utf8'));
  assert.equal(opset.ops[0].op, 'SUPERSEDE', 'shadow-of-golden maps to SUPERSEDE');
  assert.equal(opset.ops[0].target, 'sql/guarded');

  const applied = applyOps({ workspace: ws, opsPath: path.join(ws, PROMOTE_OPS_REL), home });
  assert.equal(applied.exitCode, 0, 'dispute path exits 0 with E_DISPUTED rejection recorded');
  assert.equal(applied.rejected[0]?.code, 'E_DISPUTED');
  const golden = listLearnings(dir).find((l) => l.id === 'sql/guarded');
  assert.equal(golden.fm.status, 'disputed', 'protected target marked disputed for human review');
  assert.match(golden.body, /Protected golden claim/, 'protected claim body never overwritten');
  // Promotion rejections never strike: no failure entries anywhere.
  assert.equal(readLedger(dir).filter((e) => e.failure).length, 0);
  assert.equal(readLedger(bucketDirFor(dir, branchKeyFor('feature/shadowed'))).filter((e) => e.failure).length, 0);
});

test('episodes-only overlap maps to STRENGTHEN; identical claims are skipped', () => {
  const ws = featureWorkspace('feature/overlap');
  const home = tempDir('promo-home4-');
  const { dir } = ensureStore(ws, { home });
  const goldenEp = writeEpisode(ws, 'docs/solutions/perf/golden-ev.md');
  // Unprotected golden twin with identical trigger+body.
  fs.mkdirSync(path.join(dir, 'learnings', 'sql'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'learnings', 'sql', 'same-claim.md'),
    `---\nschema: 1\ntrigger: "same trigger"\nstatus: active\nsource: auto\nepisodes:\n  - path: ${goldenEp.path}\n    sha256: "${goldenEp.sha256}"\n    kind: fix\n    plan: docs/plans/p1.md\nanchors: []\nsuperseded_by: null\nlast_confirmed: null\norigin: t\n---\n\nShared claim body.\n`
  );
    commitStore(dir, 'seed: pre-existing golden twin');
  const branchEp = writeEpisode(ws, 'docs/solutions/perf/branch-ev.md');
  seedBucketLearning(ws, home, 'same-claim', { trigger: 'same trigger', body: 'Shared claim body.', episodes: [branchEp] });

  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, true, emitted.blockedReason);
  const opset = JSON.parse(fs.readFileSync(path.join(ws, PROMOTE_OPS_REL), 'utf8'));
  assert.equal(opset.ops[0].op, 'STRENGTHEN', 'episodes-only overlap maps to STRENGTHEN');
  assert.deepEqual(opset.ops[0].episodes.map((e) => e.path), [branchEp.path]);

  const applied = applyOps({ workspace: ws, opsPath: path.join(ws, PROMOTE_OPS_REL), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  const golden = listLearnings(dir).find((l) => l.id === 'sql/same-claim');
  assert.equal(golden.fm.episodes.length, 2, 'golden gained the branch evidence');

  // A second promote now finds only a tombstoned source — nothing promotable.
  const again = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(again.pass, false);
  assert.match(again.blockedReason, /nothing promotable/);
});

test('--all chunks under MAX_OPS_PER_RUN with deterministic ordering and remaining count', () => {
  const ws = featureWorkspace('feature/chunky');
  const home = tempDir('promo-home5-');
  for (let i = 0; i < 7; i++) seedBucketLearning(ws, home, `chunk-${String(i).padStart(2, '0')}`);

  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, true, emitted.blockedReason);
  assert.equal(emitted.ops, 5, 'chunked at MAX_OPS_PER_RUN');
  assert.equal(emitted.remaining, 2);
  const opset = JSON.parse(fs.readFileSync(path.join(ws, PROMOTE_OPS_REL), 'utf8'));
  assert.deepEqual(
    opset.ops.map((o) => o.source.id),
    ['sql/chunk-00', 'sql/chunk-01', 'sql/chunk-02', 'sql/chunk-03', 'sql/chunk-04'],
    'deterministic id ordering is the cursor'
  );

  const applied = applyOps({ workspace: ws, opsPath: path.join(ws, PROMOTE_OPS_REL), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));

  // Next emission drains the remainder — the tombstoned five drop out.
  const next = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(next.pass, true, next.blockedReason);
  assert.equal(next.ops, 2);
  assert.equal(next.remaining, 0);
  const nextSet = JSON.parse(fs.readFileSync(path.join(ws, PROMOTE_OPS_REL), 'utf8'));
  assert.deepEqual(nextSet.ops.map((o) => o.source.id), ['sql/chunk-05', 'sql/chunk-06']);
});

test('a tampered promote-ops file is rejected by the digest binding — and a re-digested tamper still cannot author the promoted claim (no strikes)', () => {
  const ws = featureWorkspace('feature/tamper');
  const home = tempDir('promo-home6-');
  seedBucketLearning(ws, home, 'tampered');
  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, true, emitted.blockedReason);
  const opsFull = path.join(ws, PROMOTE_OPS_REL);
  const pristine = fs.readFileSync(opsFull, 'utf8');
  const { dir } = ensureStore(ws, { home });

  // 1. Stale digest: content edited after emission.
  const stale = JSON.parse(pristine);
  stale.ops[0].body = 'Tampered body.';
  fs.writeFileSync(opsFull, JSON.stringify(stale));
  const staleRes = applyOps({ workspace: ws, opsPath: opsFull, home });
  assert.equal(staleRes.exitCode, 1);
  assert.match(staleRes.rejected[0].reason, /digest mismatch/);

    const redigested = JSON.parse(pristine);
  redigested.ops[0].trigger = 'attacker-authored trigger';
  redigested.ops[0].body = 'Attacker-authored golden claim body.';
  redigested.promotion.digest = promotionDigest(redigested.ops);
  fs.writeFileSync(opsFull, JSON.stringify(redigested));
  const contentRes = applyOps({ workspace: ws, opsPath: opsFull, home });
  assert.equal(contentRes.exitCode, 0, JSON.stringify(contentRes.rejected));

  const golden = listLearnings(dir).find((l) => l.id === 'sql/tampered');
  assert.ok(golden, 'the source claim still promotes');
  assert.equal(golden.fm.trigger, 'trigger for tampered', 'the promoted trigger is the source learning’s');
  assert.match(golden.body, /Claim body for tampered\./);
  assert.ok(!/Attacker-authored/.test(`${golden.fm.trigger}\n${golden.body}`), 'the op never authors the promoted claim');

  assert.equal(readLedger(dir).filter((e) => e.failure).length, 0, 'promotion rejections never strike');
});

test('a re-digested promotion op cannot rename its destination, and a refused run never tombstones its source', () => {
  const ws = featureWorkspace('feature/bind');
  const home = tempDir('promo-home11-');
  seedBucketLearning(ws, home, 'bound-claim');
  const { dir } = ensureStore(ws, { home });
  const key = branchKeyFor('feature/bind');
  const opsFull = path.join(ws, PROMOTE_OPS_REL);

  assert.equal(buildPromotionOps({ workspace: ws, home, all: true }).pass, true);
  const renamed = JSON.parse(fs.readFileSync(opsFull, 'utf8'));
  assert.equal(renamed.ops[0].source.id, 'sql/bound-claim');
  renamed.ops[0].slug = 'attacker-claim';
  renamed.ops[0].trigger = 'attacker-authored trigger';
  renamed.ops[0].body = 'An arbitrary claim wearing another claim’s verified identity.';
  renamed.promotion.digest = promotionDigest(renamed.ops);
  fs.writeFileSync(opsFull, JSON.stringify(renamed));

  const res = applyOps({ workspace: ws, opsPath: opsFull, home });
  assert.equal(res.exitCode, 1, JSON.stringify(res));
  assert.equal(res.rejected[0].code, 'E_SCHEMA');
  assert.match(res.rejected[0].reason, /promotion destination .* does not match source/);
  assert.deepEqual(listLearnings(dir).map((l) => l.id), [], 'nothing reached golden');

    const source = listLearnings(bucketDirFor(dir, key)).find((l) => l.id === 'sql/bound-claim');
  assert.equal(source.fm.promoted_to_golden, undefined, 'a refused promotion never tombstones its source');

  const clean = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(clean.pass, true, clean.blockedReason);
  assert.equal(applyOps({ workspace: ws, opsPath: opsFull, home }).exitCode, 0);
  const tombstoned = listLearnings(bucketDirFor(dir, key)).find((l) => l.id === 'sql/bound-claim');
  assert.equal(tombstoned.fm.promoted_to_golden, 'sql/bound-claim', 'the promoted source is tombstoned by id');
  assert.equal(buildPromotionOps({ workspace: ws, home, all: true }).pass, false, 'and is no longer re-offered');
});

test('a re-digested promotion STRENGTHEN cannot graft its source evidence onto an unrelated golden claim', () => {
  const ws = featureWorkspace('feature/graft');
  const home = tempDir('promo-home12-');
  const opsFull = path.join(ws, PROMOTE_OPS_REL);

  // A legitimately promoted golden claim — the graft victim.
  seedBucketLearning(ws, home, 'victim');
  assert.equal(buildPromotionOps({ workspace: ws, home, all: true }).pass, true);
  assert.equal(applyOps({ workspace: ws, opsPath: opsFull, home }).exitCode, 0);
  const { dir } = ensureStore(ws, { home });
  const victimBefore = listLearnings(dir).find((l) => l.id === 'sql/victim');
  assert.equal(victimBefore.fm.episodes.length, 1);

    seedBucketLearning(ws, home, 'evidence-source');
  assert.equal(buildPromotionOps({ workspace: ws, home, all: true }).pass, true);
  const grafted = JSON.parse(fs.readFileSync(opsFull, 'utf8'));
  const donor = grafted.ops.find((o) => o.source.id === 'sql/evidence-source');
  grafted.ops = [{ op: 'STRENGTHEN', target: 'sql/victim', episodes: donor.episodes, source: donor.source }];
  grafted.promotion.digest = promotionDigest(grafted.ops);
  fs.writeFileSync(opsFull, JSON.stringify(grafted));

  const res = applyOps({ workspace: ws, opsPath: opsFull, home });
  assert.equal(res.exitCode, 1, JSON.stringify(res));
  assert.equal(res.rejected[0].code, 'E_SCHEMA');
  assert.match(res.rejected[0].reason, /promotion destination sql\/victim does not match source sql\/evidence-source/);

  const victimAfter = listLearnings(dir).find((l) => l.id === 'sql/victim');
  assert.equal(victimAfter.fm.episodes.length, 1, 'the unrelated golden claim gained no borrowed evidence');
});

test('a re-digested promotion op cannot tombstone unrelated golden claims through target/targets, and MERGE is not a promotion op', () => {
  const ws = featureWorkspace('feature/bound-targets');
  const home = tempDir('promo-home13-');
  const { dir } = ensureStore(ws, { home });

    fs.mkdirSync(path.join(dir, 'learnings', 'sql'), { recursive: true });
  for (const slug of ['treasure-a', 'treasure-b']) {
    fs.writeFileSync(
      path.join(dir, 'learnings', 'sql', `${slug}.md`),
      `---\nschema: 1\ntrigger: "${slug} trigger"\nstatus: active\nsource: auto\nepisodes:\nanchors: []\nsuperseded_by: null\nlast_confirmed: null\norigin: t\n---\n\nGolden claim ${slug}.\n`
    );
  }
  commitStore(dir, 'seed: unrelated golden claims');

  seedBucketLearning(ws, home, 'authentic');
  const opsFull = path.join(ws, PROMOTE_OPS_REL);
  assert.equal(buildPromotionOps({ workspace: ws, home, all: true }).pass, true);
  const pristine = fs.readFileSync(opsFull, 'utf8');
  const emitted = JSON.parse(pristine).ops[0];
  assert.equal(emitted.op, 'ADD');
  assert.equal(emitted.source.id, 'sql/authentic');

  const untouched = () => {
    for (const slug of ['treasure-a', 'treasure-b']) {
      const claim = listLearnings(dir).find((l) => l.id === `sql/${slug}`);
      assert.equal(claim.fm.status, 'active', `sql/${slug} stays active`);
      assert.equal(claim.fm.superseded_by, null, `sql/${slug} is never tombstoned`);
    }
    assert.equal(listLearnings(dir).some((l) => l.id === 'sql/authentic'), false, 'nothing reached golden');
    const source = listLearnings(bucketDirFor(dir, branchKeyFor('feature/bound-targets'))).find((l) => l.id === 'sql/authentic');
    assert.equal(source.fm.promoted_to_golden, undefined, 'a refused promotion never tombstones its source');
    assert.equal(readLedger(dir).filter((e) => e.failure).length, 0, 'promotion rejections never strike');
  };

    const forgedSupersede = JSON.parse(pristine);
  forgedSupersede.ops = [{ ...emitted, op: 'SUPERSEDE', target: 'sql/treasure-a' }];
  forgedSupersede.promotion.digest = promotionDigest(forgedSupersede.ops);
  fs.writeFileSync(opsFull, JSON.stringify(forgedSupersede));
  const supersede = applyOps({ workspace: ws, opsPath: opsFull, home });
  assert.equal(supersede.exitCode, 1, JSON.stringify(supersede));
  assert.equal(supersede.rejected[0].code, 'E_SCHEMA');
  assert.match(supersede.rejected[0].reason, /sql\/treasure-a/);
  untouched();

    const forgedMerge = JSON.parse(pristine);
  forgedMerge.ops = [{ ...emitted, op: 'MERGE', targets: ['sql/treasure-a', 'sql/treasure-b'] }];
  forgedMerge.promotion.digest = promotionDigest(forgedMerge.ops);
  fs.writeFileSync(opsFull, JSON.stringify(forgedMerge));
  const merge = applyOps({ workspace: ws, opsPath: opsFull, home });
  assert.equal(merge.exitCode, 1, JSON.stringify(merge));
  assert.equal(merge.rejected[0].code, 'E_SCHEMA');
  assert.match(merge.rejected[0].reason, /never MERGE/);
  untouched();

    fs.writeFileSync(opsFull, pristine);
  assert.equal(applyOps({ workspace: ws, opsPath: opsFull, home }).exitCode, 0);
  assert.ok(listLearnings(dir).some((l) => l.id === 'sql/authentic'));
});

test('governed and detached sources are refused at emit time', () => {
  const ws = featureWorkspace('feature/governed-promo');
  const home = tempDir('promo-home7-');
  seedBucketLearning(ws, home, 'vetoed');
  const { dir } = ensureStore(ws, { home });
  appendGovernance(dir, { id: 'sql/vetoed', action: 'retire', reason: 'human veto', to: null, at: new Date().toISOString() });

  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, false, 'only governed sources → nothing promotable');
  assert.ok(emitted.skipped.some((s) => s.id === 'sql/vetoed' && /standing governance/.test(s.reason)));

  const detached = buildPromotionOps({ workspace: ws, home, branchKey: 'detached-abcdefabcdef', all: true });
  assert.equal(detached.pass, false);
  assert.match(detached.blockedReason, /never promotable/);
});

test('path-shaped --branch keys are refused before any path construction', () => {
  const ws = featureWorkspace('feature/keyshape');
  const home = tempDir('promo-home9-');
  seedBucketLearning(ws, home, 'safe-claim');

  for (const key of ['../evil', 'a/b', 'a\\b', '.', path.resolve(os.tmpdir(), 'abs')]) {
    const emitted = buildPromotionOps({ workspace: ws, home, branchKey: key, all: true });
    assert.equal(emitted.pass, false, `key ${JSON.stringify(key)} must be refused`);
    assert.match(emitted.blockedReason, /invalid branch key/, `key ${JSON.stringify(key)}: ${emitted.blockedReason}`);
  }
});

test('a bucket whose recorded base is provably not an ancestor of HEAD never promotes (force-push name reuse)', () => {
  const ws = featureWorkspace('feature/reused');
  const home = tempDir('promo-home10-');
  seedBucketLearning(ws, home, 'stale-claim');
  const { dir } = ensureStore(ws, { home });
  const key = branchKeyFor('feature/reused');

    const metaPath = path.join(bucketDirFor(dir, key), 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  fs.writeFileSync(metaPath, JSON.stringify({ ...meta, baseSha: 'f'.repeat(40) }) + '\n');

  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, false, 'non-ancestor bucket must not promote');
  assert.match(emitted.blockedReason, /unrelated history/);
  assert.match(emitted.blockedReason, /prune/);
});

test('prune resolves bucket discovery and selection INSIDE the store transaction (TOCTOU guard)', () => {
    const src = fs.readFileSync(new URL('../lib/knowledge/prune.mjs', import.meta.url), 'utf8');
  const txAt = src.indexOf('withStoreTransaction(');
  assert.ok(txAt !== -1, 'prune uses withStoreTransaction');
  const callSites = [...src.matchAll(/listBuckets\(/g)].map((m) => m.index);
  assert.ok(callSites.length >= 1, 'prune discovers buckets via listBuckets');
  for (const at of callSites) {
    assert.ok(at > txAt, 'bucket discovery must happen under the store lock, never before it');
  }
});

test('prune containment-verifies EVERY selected bucket before the first delete (all-or-nothing)', () => {
    const src = fs.readFileSync(new URL('../lib/knowledge/prune.mjs', import.meta.url), 'utf8');
  const firstDeleteAt = src.indexOf('fs.rmSync(');
  assert.ok(firstDeleteAt !== -1, 'prune deletes bucket directories with rmSync');
  for (const m of [...src.matchAll(/assertRealpathContained\(/g)]) {
    assert.ok(m.index < firstDeleteAt, 'every containment check runs before anything is deleted');
  }
    const deleteLoop = src.slice(src.lastIndexOf('for (', firstDeleteAt), firstDeleteAt);
  assert.doesNotMatch(deleteLoop, /assertRealpathContained/, 'no containment check inside the delete loop');
  assert.doesNotMatch(deleteLoop, /selected\.values\(\)/, 'the delete loop never iterates the unvalidated selection');
});

test('pruneBuckets refuses a non-integer staleDays at its own boundary', () => {
  const ws = featureWorkspace('feature/staleness');
  const home = tempDir('promo-home11-');
  seedBucketLearning(ws, home, 'boundary-claim');

  for (const staleDays of [2.5, 0, -1, NaN]) {
    const result = pruneBuckets({ workspace: ws, home, staleDays });
    assert.equal(result.pass, false, `staleDays ${staleDays} must be refused`);
    assert.match(result.blockedReason, /positive whole number/, `staleDays ${staleDays}: ${result.blockedReason}`);
  }
});

test('prune removes buckets by key, by merged/tombstoned state, and by staleness in one store commit', () => {
  const ws = featureWorkspace('feature/prunable');
  const home = tempDir('promo-home8-');
  seedBucketLearning(ws, home, 'landed');
  const { dir } = ensureStore(ws, { home });
  const key = branchKeyFor('feature/prunable');

  // Promote everything → the bucket becomes fully tombstoned (prunable).
  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, true, emitted.blockedReason);
  assert.equal(applyOps({ workspace: ws, opsPath: path.join(ws, PROMOTE_OPS_REL), home }).exitCode, 0);

  // --merged sweeps the fully-tombstoned bucket.
  const merged = pruneBuckets({ workspace: ws, home, merged: true });
  assert.equal(merged.pass, true, merged.blockedReason);
  assert.deepEqual(merged.removed, [key]);
  assert.deepEqual(listBuckets(dir), []);
  const gitLog = spawnSync('git', ['log', '--oneline', '-1'], { cwd: dir, encoding: 'utf8' }).stdout;
  assert.match(gitLog, /knowledge: prune/);

  // --branch removes an explicit bucket; --stale sweeps by age.
  const bucketDir = bucketDirFor(dir, 'old-branch-11111111');
  fs.mkdirSync(path.join(bucketDir, 'learnings'), { recursive: true });
  fs.writeFileSync(
    path.join(bucketDir, 'meta.json'),
    JSON.stringify({ branch: 'old-branch', branchKey: 'old-branch-11111111', createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString() }) + '\n'
  );
  const stale = pruneBuckets({ workspace: ws, home, staleDays: 30 });
  assert.equal(stale.pass, true, stale.blockedReason);
  assert.deepEqual(stale.removed, ['old-branch-11111111']);

  // Selector required; unknown key refused.
  assert.match(pruneBuckets({ workspace: ws, home }).blockedReason, /needs --branch/);
  assert.match(pruneBuckets({ workspace: ws, home, branchKey: 'nope-00000000' }).blockedReason, /nothing to prune|no bucket/);
});

test('promotion carries a branch answer with its original time, so a cluster that reopened after it stays open', () => {
  const ws = featureWorkspace('feature/answer');
  const home = tempDir('promo-home-');
  assert.equal(writeStoreConfig(ws, { home, mode: 'on' }).pass, true);
  assert.equal(writeRecheckConfig(ws, { home, recheck: 'suggest' }).pass, true);
  const clusterId = failureClusterId('check:unit');
  const rel = 'docs/solutions/insights/unit-answer.md';
  const text = `---\nkind: insight\ntitle: Unit check answer\nderived_from: failure-cluster:${clusterId}\n---\nThe retry constant is read before config loads.\n`;
  fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), text);
  const episode = { path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex'), kind: 'insight', plan: 'docs/plans/p1.md' };
  seedBucketLearning(ws, home, 'unit-answer', { episodes: [episode] });
  const { dir } = ensureStore(ws, { home });
  const branchAnswer = readLedger(bucketDirFor(dir, branchKeyFor('feature/answer'))).find((e) => e.answers === clusterId);
  assert.ok(branchAnswer, 'the branch apply answered the cluster');
  const open = () => consolidateCandidates({ workspace: ws, home, recheck: true }).recheck.failure_clusters.some((c) => c.id === clusterId);

  // The failure recurs after the branch answer: the cluster reopens.
  const busyUntil = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } };
  busyUntil(5);
  for (const plan of ['docs/plans/a.md', 'docs/plans/b.md']) {
    const record = { plan, outcome: 'failed', verifiedAt: new Date().toISOString(), checks: [{ id: 'unit', status: 'failed', exitCode: 1, stderr: 'again' }] };
    const file = path.join(ws, '.harness/evidence/history', `${crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex')}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record));
  }
  assert.equal(open(), true, 'failures after the branch answer reopen the cluster');
  busyUntil(5);

  const emitted = buildPromotionOps({ workspace: ws, home, all: true });
  assert.equal(emitted.pass, true, emitted.blockedReason);
  const applied = applyOps({ workspace: ws, opsPath: path.join(ws, PROMOTE_OPS_REL), home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  const goldenAnswer = readLedger(dir).find((e) => e.learning === 'sql/unit-answer' && e.path === rel);
  assert.ok(goldenAnswer, 'the golden ledger consumed the episode');
  assert.deepEqual([goldenAnswer.answers, goldenAnswer.answeredAt], [clusterId, branchAnswer.answeredAt], 'the original answer and its time are carried over');
  assert.equal(open(), true, 'promotion does not re-clear a cluster that reopened after the original answer');
});
