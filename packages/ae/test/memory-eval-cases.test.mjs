import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { checkCases } from '../eval/context/check.mjs';
import { CATALOG, memoryPrompt, seedStore, seriesOrigin, seriesState, validateCatalog } from '../eval/memory/study.mjs';
import { rankLearnings } from '../lib/knowledge/retrieve.mjs';
import { writeStoreConfig } from '../lib/knowledge/store.mjs';

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-cases-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

let counter = 0;
function materialize(root, files) {
  const workspace = path.join(root, `w${++counter}`);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
    fs.writeFileSync(path.join(workspace, file), content);
  }
  return workspace;
}

async function passes(workspace, checks) {
  try { await checkCases(workspace, checks); return true; } catch { return false; }
}

test('the catalog validates: 4 to 6 ordered tasks per series, a planted trap and a later recurrence', () => {
  validateCatalog(CATALOG);
  const splits = CATALOG.series.map(series => series.split);
  assert.ok(splits.filter(split => split === 'development').length >= 2);
  assert.ok(splits.filter(split => split === 'held-out').length >= 2);
  for (const series of CATALOG.series) {
    assert.equal(series.tasks[0].trap, 'first');
    assert.ok(series.tasks.slice(1).some(task => task.trap === 'recurrence'));
    assert.match(seriesOrigin(series.id), /^https:\/\/eval\.invalid\/ae-memory\/[a-z0-9-]+\.git$/);
  }
});

test('no held-out series shares a trap with a development series', () => {
  const traps = split => new Set(CATALOG.series.filter(series => series.split === split).map(series => series.trap.id));
  const development = traps('development');
  for (const trap of traps('held-out')) assert.equal(development.has(trap), false, `${trap} is shared`);
  const leaked = { ...CATALOG, series: CATALOG.series.map(series => series.split === 'held-out' ? { ...series, trap: { ...series.trap, id: CATALOG.series[0].trap.id } } : series) };
  assert.throws(() => validateCatalog(leaked), /share traps/);
});

test('every task has a failing baseline, the obvious fix falls into the trap, and a reference fix passes', async t => {
  const root = directory(t);
  for (const series of CATALOG.series) {
    for (const [index, task] of series.tasks.entries()) {
      const label = `${series.id}/${task.id}`;
      const state = seriesState(series, index);
      const baseline = materialize(root, state);
      assert.equal(await passes(baseline, task.checks), false, `${label} private baseline fails`);
      assert.equal(await passes(baseline, task.publicChecks), false, `${label} public baseline fails`);
      const reference = materialize(root, { ...state, ...task.reference });
      assert.equal(await passes(reference, task.checks), true, `${label} reference passes private checks`);
      assert.equal(await passes(reference, task.publicChecks), true, `${label} reference passes public checks`);
      if (!task.trap) continue;
      const trapChecks = task.checks.filter(check => check.trap);
      assert.equal(await passes(baseline, trapChecks), false, `${label} trap check fails at baseline`);
      assert.ok(task.naive, `${label} declares the obvious implementation`);
      const naive = materialize(root, { ...state, ...task.naive });
      assert.equal(await passes(naive, task.publicChecks), true, `${label} the public verifier cannot see the trap`);
      assert.equal(await passes(naive, trapChecks), false, `${label} the obvious implementation is trapped`);
      assert.equal(await passes(naive, task.checks.filter(check => !check.trap)), true, `${label} only the trap check separates naive from reference`);
    }
  }
});

test('each series seed is retrievable for its recurrence task, so the trap is reachable through memory', async t => {
  const root = directory(t);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Memory Eval', GIT_AUTHOR_EMAIL: 'memory@example.test', GIT_COMMITTER_NAME: 'Memory Eval', GIT_COMMITTER_EMAIL: 'memory@example.test' };
  for (const series of CATALOG.series) {
    const home = path.join(root, `${series.id}-home`);
    fs.mkdirSync(home);
    const workspace = materialize(root, { ...seriesState(series, 0), [series.seed.episode.path]: series.seed.episode.content });
    for (const args of [['init', '-q'], ['add', '.'], ['commit', '-qm', 'seed'], ['remote', 'add', 'origin', seriesOrigin(series.id)]]) execFileSync('git', args, { cwd: workspace, env, stdio: 'pipe' });
    const id = seedStore({ workspace, home, series });
    assert.equal(writeStoreConfig(workspace, { home, mode: 'freeze' }).pass, true);
    const recurrence = series.tasks.find(task => task.trap === 'recurrence');
    const ranked = rankLearnings({ workspace, home, query: memoryPrompt(recurrence), signals: recurrence.seeds });
    assert.ok(ranked.some(row => row.id === id), `${series.id} seed ranks for ${recurrence.id}`);
  }
});
