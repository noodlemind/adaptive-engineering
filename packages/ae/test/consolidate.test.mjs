import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureStore, appendLedger } from '../lib/knowledge/store.mjs';
import { verifiedAndPlans, consolidateCandidates, EVIDENCE_MATCH_CONTRACT } from '../lib/knowledge/consolidate.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const run = (args, env = {}) =>
  spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

function writeEpisode(ws, category, name, kind) {
  const dir = path.join(ws, 'docs', 'solutions', category);
  fs.mkdirSync(dir, { recursive: true });
  const kindLine = kind === 'insight' || kind === 'human-teaching' ? `kind: ${kind}\n` : '';
  const text = `---\ntitle: "${name} lesson"\n${kindLine}date: 2026-07-01\n---\n\n## Problem\n\n${name} details.\n`;
  fs.writeFileSync(path.join(dir, `${name}.md`), text);
  return { rel: `docs/solutions/${category}/${name}.md`, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

function writeBigEpisode(ws, category, name) {
  const dir = path.join(ws, 'docs', 'solutions', category);
  fs.mkdirSync(dir, { recursive: true });
  const filler = 'x'.repeat(300);
  const text = `---\ntitle: "${name} lesson"\ndate: 2026-07-01\n---\n\n## Problem\n\n${name} details. ${filler}\n`;
  fs.writeFileSync(path.join(dir, `${name}.md`), text);
  return { rel: `docs/solutions/${category}/${name}.md`, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

function seedWorkspace() {
  const ws = tempDir('consol-ws-');
  const episodes = [];
  for (let i = 0; i < 5; i++) episodes.push(writeEpisode(ws, 'perf', `fix-${i}`, 'fix'));
  episodes.push(writeEpisode(ws, 'debugging', 'hunch-0', 'insight'));
  return { ws, episodes };
}

test('consolidate --status reports debt against the threshold', () => {
  const { ws } = seedWorkspace();
  const home = tempDir('consol-h-');
  const harnessHome = tempDir('consol-hh-');
  const res = run(['consolidate', '--status', '--workspace', ws, '--copilot-home', home, '--json'], {
    HARNESS_HOME: harnessHome,
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.debt, 6);
  assert.equal(out.threshold, 5);
  assert.equal(out.due, true);
  assert.equal(out.unconsolidated.length, 6);
  assert.ok(out.unconsolidated.every((e) => /^[0-9a-f]{64}$/.test(e.sha256)));
});

test('ledger-consumed and quarantined episodes leave the debt', () => {
  const { ws, episodes } = seedWorkspace();
  const home = tempDir('consol2-h-');
  const harnessHome = tempDir('consol2-hh-');
  const { dir } = ensureStore(ws, { home: harnessHome });
  appendLedger(
    dir,
    episodes.slice(0, 4).map((e) => ({ path: e.rel, sha256: e.sha256, learning: 'perf/x', at: '2026-07-27' }))
  );
  appendLedger(dir, [
    { path: episodes[4].rel, sha256: episodes[4].sha256, learning: null, quarantined: true, at: '2026-07-27' },
  ]);
  const out = JSON.parse(
    run(['consolidate', '--workspace', ws, '--copilot-home', home, '--json'], { HARNESS_HOME: harnessHome }).stdout
  );
  assert.equal(out.debt, 1);
  assert.equal(out.due, false);
  assert.equal(out.quarantined.length, 1);
});

function writeHugeTitleEpisode(ws, category, name, titleLen) {
  const dir = path.join(ws, 'docs', 'solutions', category);
  fs.mkdirSync(dir, { recursive: true });
  const text = `---\ntitle: "${'T'.repeat(titleLen)}"\ndate: 2026-07-01\n---\n\n## Problem\n\n${name} details.\n`;
  fs.writeFileSync(path.join(dir, `${name}.md`), text);
}

test('consolidate --candidates caps each entry\'s rendered title so a 1MB-title episode cannot balloon the packet', () => {
  const ws = tempDir('consol-hugetitle-');
  const home = tempDir('consol-ht-h-');
  const harnessHome = tempDir('consol-ht-hh-');
  // 'a-huge' sorts first within perf → it is the always-admitted first entry.
  writeHugeTitleEpisode(ws, 'perf', 'a-huge', 1_000_000);
  for (let i = 0; i < 3; i++) writeEpisode(ws, 'perf', `p-${i}`, 'fix');

  const packet = consolidateCandidates({ workspace: ws, copilotHome: home, home: harnessHome });
  const entries = packet.clusters.flatMap((c) => c.episodes);
  assert.ok(entries.length >= 1, 'the always-admitted first entry is present');
  assert.equal(entries[0].path, 'docs/solutions/perf/a-huge.md', 'the huge-title episode is the first (always-admitted) entry');
  for (const e of entries) assert.ok(e.title.length <= 200, `each rendered title is bounded, got ${e.title.length}`);
  const totalBytes = Buffer.byteLength(JSON.stringify(packet), 'utf8');
  assert.ok(totalBytes < 100_000, `the packet stays bounded despite the 1MB title, got ${totalBytes} bytes`);
  // A small packet is under budget — truncated/remaining are correctly absent.
  assert.equal('truncated' in packet, false);
  assert.equal('remaining' in packet, false);
});

test('consolidate --candidates caps an entry\'s total rendered tags length', () => {
  const ws = tempDir('consol-tagcap-');
  const home = tempDir('consol-tc-h-');
  const harnessHome = tempDir('consol-tc-hh-');
  const dir = path.join(ws, 'docs', 'solutions', 'perf');
  fs.mkdirSync(dir, { recursive: true });
  // A pathological frontmatter `tags:` line — hundreds of tags, far past the cap.
  const tags = Array.from({ length: 500 }, (_, i) => `tag${i}`).join(', ');
  const text = `---\ntitle: "tagcap lesson"\ntags: ${tags}\ndate: 2026-07-01\n---\n\n## Problem\n\ntagcap details.\n`;
  fs.writeFileSync(path.join(dir, 'tagcap.md'), text);

  const packet = consolidateCandidates({ workspace: ws, copilotHome: home, home: harnessHome });
  const entry = packet.clusters.flatMap((c) => c.episodes)[0];
  const totalLen = entry.tags.join('').length;
  assert.ok(totalLen <= 500, `total rendered tags length bounded to <=500, got ${totalLen}`);
  assert.ok(entry.tags.length < 500, 'the tag list is truncated when it exceeds the budget');
});

test('consolidate --candidates groups two unrelated episodes in one category cluster (a hint the skill may split)', () => {
  const ws = tempDir('consol-group-');
  const home = tempDir('consol-g-h-');
  const harnessHome = tempDir('consol-g-hh-');
  writeEpisode(ws, 'perf', 'unrelated-a', 'fix');
  writeEpisode(ws, 'perf', 'unrelated-b', 'fix');

  const packet = consolidateCandidates({ workspace: ws, copilotHome: home, home: harnessHome });
  const perf = packet.clusters.find((c) => c.id === 'perf');
  assert.ok(perf, 'the perf category group is present');
  assert.equal(perf.episodes.length, 2, 'both unrelated episodes are emitted, grouped by category — the skill may split them');
});

test('consolidate --candidates emits the deterministic work packet', () => {
  const { ws } = seedWorkspace();
  const home = tempDir('consol3-h-');
  const harnessHome = tempDir('consol3-hh-');
  const res = run(['consolidate', '--candidates', '--workspace', ws, '--copilot-home', home, '--json'], {
    HARNESS_HOME: harnessHome,
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.schema, 2);
  assert.deepEqual(out.contract, { maxOps: 5, byteCap: 1200, threshold: 5, domainCap: 25, evidenceMatch: EVIDENCE_MATCH_CONTRACT });
  const allEpisodes = out.clusters.flatMap((c) => c.episodes);
  assert.equal(allEpisodes.length, 6);
  assert.ok(allEpisodes.every((e) => e.sha256 && e.path && e.title));
  const perfCluster = out.clusters.find((c) => c.id === 'perf');
  assert.equal(perfCluster.episodes.length, 5);
  assert.deepEqual(out.learnings, []);
});

test('a changed episode body re-enters the debt (hash-keyed ledger)', () => {
  const { ws, episodes } = seedWorkspace();
  const home = tempDir('consol4-h-');
  const harnessHome = tempDir('consol4-hh-');
  const { dir } = ensureStore(ws, { home: harnessHome });
  appendLedger(
    dir,
    episodes.map((e) => ({ path: e.rel, sha256: e.sha256, learning: 'perf/x', at: '2026-07-27' }))
  );
  fs.appendFileSync(path.join(ws, episodes[0].rel), '\nNew detail discovered later.\n');
  const out = JSON.parse(
    run(['consolidate', '--workspace', ws, '--copilot-home', home, '--json'], { HARNESS_HOME: harnessHome }).stdout
  );
  assert.equal(out.debt, 1);
  assert.equal(out.unconsolidated[0].path, episodes[0].rel);
});

test('a human-teaching episode appears in --candidates --json with kind: human-teaching, not flattened to fix', () => {
  const ws = tempDir('consol5-ws-');
  const home = tempDir('consol5-h-');
  const harnessHome = tempDir('consol5-hh-');
  writeEpisode(ws, 'teachings', 'hand-taught-0', 'human-teaching');
  const res = run(['consolidate', '--candidates', '--workspace', ws, '--copilot-home', home, '--json'], {
    HARNESS_HOME: harnessHome,
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  const allEpisodes = out.clusters.flatMap((c) => c.episodes);
  const teaching = allEpisodes.find((e) => e.path.endsWith('hand-taught-0.md'));
  assert.ok(teaching, 'the teaching episode is present in the candidates packet');
  assert.equal(teaching.kind, 'human-teaching');
});

test('consolidate --candidates bounds the episode packet, reports truncated/remaining, and orders deterministically across runs', () => {
  const ws = tempDir('consol6-ws-');
  const home = tempDir('consol6-h-');
  const harnessHome = tempDir('consol6-hh-');
  const N = 90;
  for (let i = 0; i < N; i++) writeBigEpisode(ws, 'perf', `big-${String(i).padStart(3, '0')}`);

  const runOnce = () =>
    JSON.parse(
      run(['consolidate', '--candidates', '--workspace', ws, '--copilot-home', home, '--json'], {
        HARNESS_HOME: harnessHome,
      }).stdout
    );

  const out1 = runOnce();
  const paths1 = out1.clusters.flatMap((c) => c.episodes).map((e) => e.path);
  assert.ok(paths1.length < N, 'the packet must not include every episode once the byte budget is exceeded');
  assert.equal(out1.truncated, true);
  assert.equal(out1.remaining, N - paths1.length);
  assert.ok(out1.remaining > 0);

  const out2 = runOnce();
  const paths2 = out2.clusters.flatMap((c) => c.episodes).map((e) => e.path);
  assert.deepEqual(paths2, paths1, 'a repeat call against unchanged debt must include the same episodes in the same order');

    assert.deepEqual(paths1, [...paths1].sort());
});

test('consolidate --candidates omits truncated/remaining entirely when the packet is under budget', () => {
  const { ws } = seedWorkspace();
  const home = tempDir('consol7-h-');
  const harnessHome = tempDir('consol7-hh-');
  const out = JSON.parse(
    run(['consolidate', '--candidates', '--workspace', ws, '--copilot-home', home, '--json'], {
      HARNESS_HOME: harnessHome,
    }).stdout
  );
  assert.equal('truncated' in out, false);
  assert.equal('remaining' in out, false);
});

test('verifiedAndPlans counts fix links only — a human-teaching link never inflates verified/plans', () => {
  const fm = {
    episodes: [
      { path: 'docs/solutions/perf/a.md', kind: 'fix', plan: 'docs/plans/p1.md' },
      { path: 'docs/solutions/perf/b.md', kind: 'fix', plan: 'docs/plans/p2.md' },
      { path: 'docs/solutions/teachings/c.md', kind: 'human-teaching', plan: null },
    ],
  };
  const { verified, plans } = verifiedAndPlans(fm);
  assert.equal(verified, 2, 'only the 2 fix-kind links count as verified');
  assert.equal(plans, 2);
});
