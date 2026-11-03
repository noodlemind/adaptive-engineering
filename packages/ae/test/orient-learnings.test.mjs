import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { ensureStore } from '../lib/knowledge/store.mjs';
import { writeChecks } from './helpers/cli-fixtures.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function writeRealEpisode(ws, rel, body) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(body).digest('hex') };
}

function seededContext() {
  const ws = tempDir('ol-ws-');
  const home = tempDir('ol-home-');
  const harnessHome = tempDir('ol-hh-');
  const opsPath = path.join(ws, 'ops.json');
  fs.writeFileSync(
    opsPath,
    JSON.stringify({
      schema: 1,
      ops: [
        {
          op: 'ADD',
          domain: 'sql',
          slug: 'not-null-large-tables',
          trigger: 'adding NOT NULL columns to large hot tables',
          body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
          episodes: [{
            ...writeRealEpisode(ws, 'docs/solutions/perf/x.md', 'Two-step default+backfill episode for large hot tables.\n'),
            kind: 'fix', plan: 'docs/plans/p1.md',
          }],
        },
        {
          op: 'ADD',
          domain: 'api',
          slug: 'retry-jitter',
          trigger: 'retrying rate limited requests',
          body: 'Retry storms amplify rate limiting when jitter is missing from backoff.',
          episodes: [{
            ...writeRealEpisode(
              ws,
              'docs/solutions/debugging/h.md',
              '---\ntitle: "retry jitter insight"\nkind: insight\ndate: 2026-07-01\n---\n\nRetry storms amplify rate limiting when jitter is missing from backoff.\n'
            ),
            kind: 'insight', plan: '',
          }],
        },
      ],
    })
  );
  const res = applyOps({ workspace: ws, opsPath, home: harnessHome });
  assert.equal(res.exitCode, 0, JSON.stringify(res.rejected));
  return { ws, home, harnessHome };
}

function orient({ ws, home, harnessHome }, query) {
  return spawnSync(
    process.execPath,
    [binPath, 'orient', '--query', query, '--workspace', ws, '--copilot-home', home, '--json'],
    { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: harnessHome } }
  );
}

test('orient surfaces matching learnings with attribution and advisory fencing', () => {
  const c = seededContext();
  const res = orient(c, 'adding NOT NULL columns to large tables');
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.ok(Array.isArray(out.learnings), 'orient JSON gains learnings');
  assert.equal(out.learnings[0].id, 'sql/not-null-large-tables');

  const pack = fs.readFileSync(path.join(c.ws, '.harness', 'context-pack.md'), 'utf8');
  assert.match(pack, /## Learnings \(memory\)/);
  assert.match(pack, /Retrieved learnings: sql\/not-null-large-tables/);
  assert.match(pack, /two-step default\+backfill/);
});

test('insight-only learnings render the advisory fence; retired ones never appear', () => {
  const c = seededContext();
  const res = orient(c, 'retrying rate limited requests jitter');
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const pack = fs.readFileSync(path.join(c.ws, '.harness', 'context-pack.md'), 'utf8');
  assert.match(pack, /\[unverified memory — advisory\]/);

  // Retire the sql learning by hand; it must vanish from the next orient.
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const f = path.join(dir, 'learnings', 'sql', 'not-null-large-tables.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('status: provisional', 'status: retired'));
  const res2 = orient(c, 'adding NOT NULL columns to large tables');
  const out2 = JSON.parse(res2.stdout);
  assert.ok(!out2.learnings.some((l) => l.id === 'sql/not-null-large-tables'));
});

test('orient records only the learning ids that SURVIVED into the 2KB pack, never every ranked id', () => {
  const ws = tempDir('ol-trunc-ws-');
  const home = tempDir('ol-trunc-home-');
  const harnessHome = tempDir('ol-trunc-hh-');

    const ops = { schema: 1, ops: [] };
  for (let i = 0; i < 3; i++) {
    const rel = `docs/solutions/perf/big-${i}.md`;
    const body = `Body ${i}.\n`;
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), body, 'utf8');
    ops.ops.push({
      op: 'ADD',
      domain: 'auth',
      slug: `big-${i}`,
      trigger: `auth token refresh session cookie rotation ${i} ${'x'.repeat(780)}`,
      body: `Retry ${i} behind a per-session lock.`,
      episodes: [{ path: rel, sha256: crypto.createHash('sha256').update(body).digest('hex'), kind: 'fix', plan: 'docs/plans/p1.md' }],
    });
  }
  const opsPath = path.join(ws, 'ops.json');
  fs.writeFileSync(opsPath, JSON.stringify(ops));
  assert.equal(applyOps({ workspace: ws, opsPath, home: harnessHome }).exitCode, 0);

  // Keep this fixture ready for behavioral verification so the 2KB pressure
  // exercises partial memory packing rather than missing-check setup guidance.
  fs.writeFileSync(path.join(ws, 'assert-episode.mjs'), "import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nassert.equal(fs.readFileSync('docs/solutions/perf/big-0.md', 'utf8'), 'Body 0.\\n');\n");
  writeChecks(ws, { 'episode-behavior': { command: [process.execPath, 'assert-episode.mjs'] } });

  const res = orient({ ws, home, harnessHome }, 'auth token refresh session cookie rotation');
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const output = JSON.parse(res.stdout);
  assert.equal(output.checkReadiness.status, 'ready');
  const ranked = output.learnings.map((l) => l.id);
  assert.equal(ranked.length, 3, 'all three learnings rank');

  const pack = fs.readFileSync(path.join(ws, '.harness', 'context-pack.md'), 'utf8');
  assert.match(pack, /truncated to 2KB budget/, 'the pack must actually truncate for this test to be meaningful');

  const events = fs
    .readFileSync(path.join(ws, '.harness', 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const orientEvent = [...events].reverse().find((e) => e.type === 'orient');
  assert.ok(orientEvent, 'an orient event was recorded');
  const recorded = orientEvent.learnings;
  assert.ok(recorded.length >= 1 && recorded.length < ranked.length, `event lists a truncated subset (got ${recorded.length} of ${ranked.length})`);
  for (const id of recorded) {
    assert.ok(pack.includes(`- [${id}]`), `every recorded id (${id}) has a surviving bullet in the pack`);
  }
});

test('orient without any knowledge store still works and reports no learnings', () => {
  const ws = tempDir('ol-empty-');
  const res = spawnSync(
    process.execPath,
    [binPath, 'orient', '--query', 'anything at all', '--workspace', ws, '--copilot-home', tempDir('ol-eh-'), '--json'],
    { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: tempDir('ol-ehh-') } }
  );
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.learnings, []);
  const pack = fs.readFileSync(path.join(ws, '.harness', 'context-pack.md'), 'utf8');
  assert.doesNotMatch(pack, /## Learnings/);
});
