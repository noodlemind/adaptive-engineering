import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { writeRecheckConfig } from '../lib/knowledge/store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const TRIGGER = 'adding NOT NULL columns to hot tables';

const ctx = () => ({ ws: tempDir('odd-ws-'), home: tempDir('odd-home-'), harnessHome: tempDir('odd-hh-') });

function run({ ws, home, harnessHome }, args) {
  return spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: harnessHome },
  });
}

function writeEpisode(ws, category, name) {
  const dir = path.join(ws, 'docs', 'solutions', category);
  fs.mkdirSync(dir, { recursive: true });
  const text = `---\ntitle: "${name} lesson"\ndate: 2026-07-01\n---\n\n## Problem\n\n${name} details.\n`;
  fs.writeFileSync(path.join(dir, `${name}.md`), text);
}

/** Seeds a knowledge store (via applyOps) with one learning matching TRIGGER,
 * then adds `count` real, never-consolidated fix episodes so debt accrues. */
function seedStoreWithDebt(c, { count = 5 } = {}) {
  const seedRel = 'docs/solutions/perf/seed.md';
  const seedFull = path.join(c.ws, seedRel);
  fs.mkdirSync(path.dirname(seedFull), { recursive: true });
  const seedText = `---\ntitle: "seed lesson"\ndate: 2026-07-01\n---\n\n## Problem\n\nseed details.\n`;
  fs.writeFileSync(seedFull, seedText);
  const seedSha256 = crypto.createHash('sha256').update(seedText).digest('hex');

  const op = {
    op: 'ADD',
    domain: 'sql',
    slug: 'not-null-hot-tables',
    trigger: TRIGGER,
    body: 'Use two-step default+backfill; a direct ALTER takes an exclusive lock.',
    episodes: [{ path: seedRel, sha256: seedSha256, kind: 'fix', plan: 'docs/plans/p1.md' }],
  };
  const opsPath = path.join(c.ws, 'ops.json');
  fs.writeFileSync(opsPath, JSON.stringify({ schema: 1, ops: [op] }));
  const res = applyOps({ workspace: c.ws, opsPath, home: c.harnessHome });
  assert.equal(res.exitCode, 0, JSON.stringify(res.rejected));
  for (let i = 0; i < count; i++) writeEpisode(c.ws, 'perf', `debt-${i}`);
}

function writeActivePlan(ws) {
  const plansDir = path.join(ws, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const planPath = path.join(plansDir, '2026-05-22-fix-example-plan.md');
  fs.writeFileSync(
    planPath,
    `---
title: "Fix example"
status: in-progress
plan_lock: true
phase: 1
---

# Fix example

## Overview

Do the work.

## Intent Contract

- **Goal:** Fix example
- **Expected outputs:** code change
- **Success criteria:** tests pass

## Acceptance Criteria

- [ ] Example is fixed.

## Verification Plan

Run the relevant test command.

## Impacted Files

- src/example.ts

## Activity

- Plan created.
`,
    'utf8'
  );
  return planPath;
}

function lastEvent(ws) {
  const p = path.join(ws, '.harness', 'events.jsonl');
  const lines = fs
    .readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return [...lines].reverse().find((event) => event.type === 'orient');
}

test('due debt with no active plan: hint pushed, knowledgeDebt reported, surfaced learnings recorded on the event', () => {
  const c = ctx();
  seedStoreWithDebt(c);

  const res = run(c, ['orient', '--query', TRIGGER]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);

  assert.deepEqual(out.knowledgeDebt, { debt: 5, threshold: 5, due: true });
  assert.ok(
    out.nextTools.includes('ae consolidate --candidates  # knowledge debt 5/5'),
    JSON.stringify(out.nextTools)
  );
  assert.equal(out.learnings.length, 1);
  const learningId = out.learnings[0].id;

  const event = lastEvent(c.ws);
  assert.equal(event.type, 'orient');
  assert.deepEqual(event.learnings, [learningId]);
});

test('active plan debounces the hint but knowledgeDebt still reports', () => {
  const c = ctx();
  seedStoreWithDebt(c);
  writeActivePlan(c.ws);

  const res = run(c, ['orient', '--query', TRIGGER]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);

  assert.deepEqual(out.knowledgeDebt, { debt: 5, threshold: 5, due: true });
  assert.ok(
    !out.nextTools.some((t) => t.includes('consolidate --candidates')),
    JSON.stringify(out.nextTools)
  );
});

test('knowledge off: knowledgeDebt is null and no hint', () => {
  const c = ctx();
  seedStoreWithDebt(c);
  assert.equal(run(c, ['knowledge', 'off']).status, 0);

  const res = run(c, ['orient', '--query', TRIGGER]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);

  assert.equal(out.knowledgeDebt, null);
  assert.ok(
    !out.nextTools.some((t) => t.includes('consolidate --candidates')),
    JSON.stringify(out.nextTools)
  );
});

test('knowledge freeze: injection stays on but knowledgeDebt is null (debt gate requires mode "on"|"suggest")', () => {
  const c = ctx();
  seedStoreWithDebt(c);
  assert.equal(run(c, ['knowledge', 'freeze']).status, 0);

  const res = run(c, ['orient', '--query', TRIGGER]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);

  assert.equal(out.learnings.length, 1, 'freeze keeps learnings injection on');
  assert.equal(out.knowledgeDebt, null, 'freeze is not mode "on"/"suggest" so debt is not reported');
  assert.ok(
    !out.nextTools.some((t) => t.includes('consolidate --candidates')),
    JSON.stringify(out.nextTools)
  );
});

test('knowledge capture-only: no injection and knowledgeDebt is null', () => {
  const c = ctx();
  seedStoreWithDebt(c);
  assert.equal(run(c, ['knowledge', 'capture-only']).status, 0);

  const res = run(c, ['orient', '--query', TRIGGER]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);

  assert.equal(out.learnings.length, 0, 'capture-only suppresses injection');
  assert.equal(out.knowledgeDebt, null, 'capture-only is not mode "on" so debt is not reported');
  assert.ok(
    !out.nextTools.some((t) => t.includes('consolidate --candidates')),
    JSON.stringify(out.nextTools)
  );
});

test('orient on a workspace with no knowledge store yet stays store-read-only', () => {
  const c = ctx();
  const res = run(c, ['orient', '--query', 'anything at all']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);

  assert.equal(out.knowledgeDebt, null);
  const storeRoot = path.join(c.harnessHome, 'knowledge');
  assert.equal(fs.existsSync(storeRoot), false, 'orient must not materialize a knowledge store');
});

test('below-threshold debt: knowledgeDebt reports due false and no hint', () => {
  const c = ctx();
  seedStoreWithDebt(c, { count: 2 });

  const res = run(c, ['orient', '--query', TRIGGER]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);

  assert.deepEqual(out.knowledgeDebt, { debt: 2, threshold: 5, due: false });
  assert.ok(
    !out.nextTools.some((t) => t.includes('consolidate --candidates')),
    JSON.stringify(out.nextTools)
  );
});

test('when re-check makes consolidation due, the orient hint asks for the recheck packet', () => {
  const c = ctx();
  seedStoreWithDebt(c, { count: 0 });
  assert.equal(writeRecheckConfig(c.ws, { home: c.harnessHome, recheck: 'on' }).pass, true);
  for (const [n, plan] of ['docs/plans/a.md', 'docs/plans/b.md', 'docs/plans/c.md'].entries()) {
    const record = { plan, outcome: 'failed', verifiedAt: `2026-11-0${n + 1}T00:00:00.000Z`, checks: [{ id: 'unit', status: 'failed', exitCode: 1, stderr: 'boom' }] };
    const file = path.join(c.ws, '.harness/evidence/history', `${crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex')}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record));
  }
  const res = run(c, ['orient', '--query', TRIGGER]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.ok(out.nextTools.includes('ae consolidate --candidates --recheck  # knowledge debt 0/5'), JSON.stringify(out.nextTools));
});
