import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import {
  CATALOG, PROTOCOL, armById, armStatistics, baselineChain, clearExternalPlans, compareArms, fisherOneSided, resolveStudyOutput, runStudy, runnableArms, scorePromotion, seriesOrigin, sweepStaleStudies, validateProtocol,
} from '../eval/memory/study.mjs';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { storeDir, writeStoreConfig } from '../lib/knowledge/store.mjs';

const packageRoot = path.resolve(import.meta.dirname, '..');
const LEARNING_ID = 'javascript/eval-scripted-trap';
const [ordering, orders] = CATALOG.series;
const seedId = series => `${series.seed.op.domain}/${series.seed.op.slug}`;

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-study-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Learning files in a store, in any layer (main or branch bucket). */
function storedLearnings(dir) {
  const found = [];
  const walk = current => {
    for (const entry of fs.existsSync(current) ? fs.readdirSync(current, { withFileTypes: true }) : []) {
      if (entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md') && full.split(path.sep).includes('learnings')) found.push(entry.name.replace(/\.md$/, ''));
    }
  };
  walk(dir);
  return found;
}

function write(workspace, files) {
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(workspace, file), content);
}

const usage = { status: 'ok', provider: 'scripted', model: 'scripted-test', turnCount: 2,
  contextAccounting: [{ boundary: 'headless-request', model: 'scripted-test', modelUsage: { measurement: 'observed', inputTokens: 100, outputTokens: 10 } }] };

/**
 * Scripted agent: task 1 falls into the trap and records an episode plus a learning (refused unless knowledge mode is on);
 * a recurrence task avoids the trap only when this series's own learning or seed was injected; other tasks are solved.
 */
function scriptedExecutor(calls, hooks = {}) {
  return async fixture => {
    const { workspace, harnessHome, task, series, injection, arm, index } = fixture;
    calls.push({ series: series.id, arm: arm.id, task: task.id, index, harnessHome, injected: injection.learnings, fixture });
    if (task.trap === 'first') {
      write(workspace, task.naive);
      const rel = `docs/solutions/eval/${series.trap.id}.md`;
      const text = `---\ntitle: "${series.trap.id}"\nkind: fix\ndate: 2026-11-01\n---\n\n${series.trap.description}\n`;
      fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
      fs.writeFileSync(path.join(workspace, rel), text);
      const ops = { schema: 1, ops: [{ op: 'ADD', domain: 'javascript', slug: 'eval-scripted-trap', trigger: series.seed.op.trigger, body: series.seed.op.body,
        episodes: [{ path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex'), kind: 'fix', plan: null }] }] };
      applyOps({ workspace, home: harnessHome, operations: ops });
    } else if (task.trap === 'recurrence') {
      const recalled = injection.learnings.some(id => id === LEARNING_ID || id === seedId(series));
      write(workspace, recalled ? task.reference : task.naive);
    } else {
      write(workspace, task.reference);
    }
    await hooks[`${arm.id}:${index}`]?.(fixture);
    return usage;
  };
}

const ARMS = ['stateless', 'capture-only', 'recall'];
const RUNNABLE = ['stateless', 'capture-only', 'recall', 'recall+feedback', 'frozen-seed'];
const planFile = ({ harnessHome }, storeDir) => path.join(harnessHome, 'projects', path.basename(storeDir), 'plans', 'scripted-plan.md');

let mainRun = null;
function main() {
  mainRun ||= (async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-study-main-'));
    const calls = [];
    const inspected = {};
    const observations = {};
    const hooks = {
      // AE suggests `ae knowledge on`; a stateless agent that follows it fails that attempt instead of invalidating the run.
      'stateless:1': ({ workspace, harnessHome }) => { writeStoreConfig(workspace, { home: harnessHome, mode: 'on' }); },
      // An agent-changed origin is read back through the series identity, so capture-only records a failure, not drift.
      // A url rewrite changes the effective origin, which repository identity reads, without touching remote.origin.url.
      'capture-only:3': ({ workspace }) => { spawnSync('git', ['config', '--local', 'url.https://eval.invalid/other/.insteadOf', 'https://eval.invalid/ae-memory/'], { cwd: workspace }); },
    };
    const executor = scriptedExecutor(calls, hooks);
    const result = await runStudy({ root, catalog: { ...CATALOG, series: [ordering] }, arms: ARMS, repeats: 1, model: 'scripted-test', host: 'scripted-test',
      execute: async fixture => {
        const runRoot = path.dirname(fixture.trial);
        observations[`${fixture.arm.id}:${fixture.index}`] = {
          home: fs.readdirSync(fixture.env.HOME), homePath: fixture.env.HOME, tmp: fixture.env.TMPDIR, trial: fixture.trial,
          runRoot: fs.readdirSync(runRoot).sort(), runRootPath: runRoot, studyParent: path.dirname(runRoot),
          checkFile: fixture.checkFile ?? null, hasCheckText: typeof fixture.checkText === 'string', outFiles: fs.readdirSync(root).sort(), outsideOut: path.relative(root, fixture.workspace).startsWith('..'),
          planPresent: fs.existsSync(path.join(fixture.harnessHome, 'projects')) && fs.readdirSync(path.join(fixture.harnessHome, 'projects')).some(id => fs.existsSync(path.join(fixture.harnessHome, 'projects', id, 'plans', 'scripted-plan.md'))),
        };
        return executor(fixture);
      },
      inspect: (fixture, attempt) => {
        if (attempt.taskIndex === 1) {
          const file = planFile(fixture, attempt.storeDir);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, '# plan from task 1\n');
        }
        inspected[attempt.id] = {
          tracked: spawnSync('git', ['ls-files', 'docs/solutions'], { cwd: fixture.workspace, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean),
          learnings: storedLearnings(attempt.storeDir),
        };
      } });
    return { root, calls, result, inspected, observations };
  })();
  return mainRun;
}

let dryRunResult = null;
function dry() {
  dryRunResult ||= (async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-study-dry-'));
    let calls = 0;
    const result = await runStudy({ root, catalog: { ...CATALOG, series: [orders] }, arms: ['recall+feedback', 'frozen-seed'], repeats: 1, dryRun: true, execute: () => { calls += 1; throw new Error('provider called'); } });
    return { root, result, calls: () => calls };
  })();
  return dryRunResult;
}

let driftRun = null;
function drift() {
  driftRun ||= (async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-study-drift-'));
    const executor = scriptedExecutor([]);
    const result = await runStudy({ root, catalog: { ...CATALOG, series: [ordering] }, arms: ['recall'], repeats: 2, model: 'scripted-test', host: 'scripted-test',
      originFor: (series, index) => index === 1 ? 'https://eval.invalid/ae-memory/elsewhere.git' : seriesOrigin(series.id),
      execute: async fixture => {
        // Repeat 1 leaves the recurrence task unsolved, so its trap check says nothing about recurrence.
        if (fixture.repeat === 1 && fixture.index === 2) return usage;
        const outcome = await executor(fixture);
        if (fixture.index === 3) fs.writeFileSync(path.join(fixture.workspace, 'docs/solutions/eval/second.md'), 'A second episode.\n');
        return outcome;
      } });
    return { root, result };
  })();
  return driftRun;
}

after(async () => {
  for (const run of [mainRun, dryRunResult, driftRun]) if (run) fs.rmSync((await run).root, { recursive: true, force: true });
});
const rowsFor = (result, arm) => result.attempts.filter(row => row.arm === arm).sort((a, b) => a.repeat - b.repeat || a.taskIndex - b.taskIndex);

test('protocol: every arm declares an acyclic baseline that reaches stateless in at most two steps', () => {
  validateProtocol(PROTOCOL);
  for (const arm of PROTOCOL.arms) {
    assert.ok(Object.hasOwn(arm, 'baseline'), `${arm.id} declares baseline`);
    const chain = baselineChain(PROTOCOL, arm.id);
    assert.equal(chain.at(-1), 'stateless');
    assert.ok(chain.length - 1 <= 2, `${arm.id} resolves within two steps`);
  }
  const expected = { stateless: null, 'capture-only': 'stateless', recall: 'stateless', 'frozen-seed': 'stateless', 'recall+feedback': 'recall', 'recall+recheck': 'recall' };
  for (const [id, baseline] of Object.entries(expected)) assert.equal(armById(PROTOCOL, id).baseline, baseline);
  const withArms = arms => ({ ...PROTOCOL, arms });
  const base = PROTOCOL.arms.filter(arm => arm.id === 'stateless' || arm.id === 'recall');
  assert.throws(() => validateProtocol(withArms([...base, { id: 'a', mode: 'on', baseline: 'b' }, { id: 'b', mode: 'on', baseline: 'a' }])), /cycle/);
  assert.throws(() => validateProtocol(withArms([...base, { id: 'a', mode: 'on', baseline: 'recall' }, { id: 'b', mode: 'on', baseline: 'a' }])), /more than 2 steps/);
  assert.throws(() => validateProtocol(withArms([...base, { id: 'a', mode: 'on' }])), /declare a baseline/);
  assert.throws(() => validateProtocol(withArms([...base, { id: 'a', mode: 'on', baseline: 'missing' }])), /unknown arm/);
});

test('protocol: the arms map onto knowledge modes and phase 2 re-check is declared but not runnable', async t => {
  const modes = Object.fromEntries(PROTOCOL.arms.map(arm => [arm.id, arm.mode]));
  assert.deepEqual(modes, { stateless: 'off', 'capture-only': 'capture-only', recall: 'on', 'recall+feedback': 'on', 'recall+recheck': 'on', 'frozen-seed': 'freeze' });
  assert.equal(armById(PROTOCOL, 'recall+feedback').feedback, 'on');
  assert.equal(armById(PROTOCOL, 'frozen-seed').seed, true);
  assert.deepEqual(runnableArms(PROTOCOL), RUNNABLE);
  await assert.rejects(runStudy({ root: directory(t), arms: ['recall+recheck'], repeats: 1, dryRun: true }), /not runnable yet/);
});

test('arms set their knowledge mode and feedback state before every task, in their own home', async () => {
  const { result } = await main();
  const { result: dryResult } = await dry();
  const expected = { stateless: ['off', 'off', result], 'capture-only': ['capture-only', 'off', result], recall: ['on', 'off', result], 'recall+feedback': ['on', 'on', dryResult], 'frozen-seed': ['freeze', 'off', dryResult] };
  for (const [arm, [mode, feedback, source]] of Object.entries(expected)) {
    const rows = rowsFor(source, arm);
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.knowledgeMode, mode, `${arm} mode`);
      assert.equal(row.feedback, feedback, `${arm} feedback`);
      assert.equal(row.valid, true);
    }
  }
  assert.equal(rowsFor(dryResult, 'frozen-seed')[0].seeded, seedId(orders));
  assert.ok(rowsFor(result, 'recall').every(row => row.kind === 'scripted'));
});

test('an agent-made knowledge mode change fails that attempt and is reset before the next task', async () => {
  const { result } = await main();
  const [, second, third] = rowsFor(result, 'stateless');
  assert.equal(second.valid, true);
  assert.equal(second.checks.pass, true);
  assert.equal(second.knowledgeModeAfter, 'on');
  assert.equal(second.configChangedByAgent, true);
  assert.equal(second.pass, false);
  assert.equal(third.valid, true, 'later tasks are not dropped');
  assert.equal(third.knowledgeMode, 'off');
  assert.equal(third.trapRecurred, true, 'stateless still counts its recurrence');
  assert.equal(result.summary.arms.stateless.configChangedByAgent, 1);
});

test('agents cannot reach private checks, sibling runs or earlier tasks', async () => {
  const { observations, root, result } = await main();
  for (const [key, seen] of Object.entries(observations)) {
    assert.deepEqual(seen.home, [], `${key} HOME is empty`);
    const index = Number(key.split(':')[1]);
    assert.deepEqual(seen.runRoot, ['copilot', 'state', `t${index + 1}`], `${key} sees only its own task`);
    assert.ok(seen.homePath.startsWith(seen.trial + path.sep), `${key} HOME belongs to this task only`);
    assert.ok(seen.tmp.startsWith(seen.trial + path.sep), `${key} TMPDIR belongs to this task only`);
    assert.deepEqual(fs.existsSync(seen.studyParent) ? fs.readdirSync(seen.studyParent) : [], [], `${key} study parent is removed`);
    assert.ok(seen.outsideOut, `${key} workspace is outside the output root`);
    // Private checks stay in the runner's memory: no check file exists anywhere while an agent runs.
    assert.equal(seen.checkFile, null, `${key} has no private check file`);
    assert.equal(seen.hasCheckText, true);
    assert.deepEqual(seen.outFiles, ['provenance.json'], `${key} output root holds no private checks or attempt records during the run`);
    assert.equal(fs.existsSync(seen.runRootPath), false, `${key} run root is removed after the run`);
  }
  const runRoots = new Set(Object.entries(observations).map(([key, seen]) => `${key.split(':')[0]}=${seen.runRootPath}`));
  assert.equal(new Set([...runRoots].map(entry => entry.split('=')[1])).size, ARMS.length, 'each run gets its own temporary root');
  assert.ok(result.attempts.every(row => !JSON.stringify(row).includes('trap-checks.json')));
  assert.equal(fs.existsSync(path.join(root, 'private')), false);
});

test('the harness home persists across a series and is isolated between arms and repeats', async () => {
  const { result, calls, inspected } = await main();
  const homes = new Set();
  for (const arm of ARMS) {
    const armCalls = calls.filter(call => call.arm === arm);
    assert.equal(armCalls.length, 4);
    assert.equal(new Set(armCalls.map(call => call.harnessHome)).size, 1, `${arm} keeps one home across its tasks`);
    homes.add(armCalls[0].harnessHome);
    assert.equal(new Set(rowsFor(result, arm).map(row => row.storeDir)).size, 1);
  }
  assert.equal(homes.size, ARMS.length, 'every arm has its own home');
  assert.ok(inspected[rowsFor(result, 'recall')[3].id].learnings.includes('eval-scripted-trap'), 'recall store kept the task 1 learning');
  for (const arm of ['stateless', 'capture-only']) assert.deepEqual(inspected[rowsFor(result, arm)[3].id].learnings, [], `${arm} store refused the write`);
  const { result: repeated } = await drift();
  assert.equal(new Set(repeated.runs.map(run => run.id)).size, 2);
  const validIds = new Set(repeated.attempts.filter(row => row.valid).map(row => row.repoId));
  assert.deepEqual([...validIds], [result.attempts[0].repoId], 'repeats and arms share one series identity');
  assert.ok(rowsFor(repeated, 'recall').filter(row => row.repeat === 2)[2].learningsInjected.includes(LEARNING_ID), 'repeat 2 has its own store with its own learning');
});

test('every task in a series resolves the same repoId and store; different series resolve different ones', async () => {
  const { result } = await main();
  const ids = new Set(result.attempts.map(row => row.repoId));
  assert.equal(ids.size, 1);
  assert.match([...ids][0], /^eval\.invalid-ae-memory-catalog-ordering-/);
  for (const row of result.attempts) assert.equal(row.origin.expected, seriesOrigin(ordering.id));
  const { result: other } = await dry();
  const otherIds = new Set(other.attempts.map(row => row.repoId));
  assert.equal(otherIds.size, 1);
  assert.notEqual([...otherIds][0], [...ids][0]);
  assert.match([...otherIds][0], /^eval\.invalid-ae-memory-orders-csv-/);
});

test('a changed origin fails the private check and the after-state is read through the series identity', async () => {
  const { result } = await main();
  const last = rowsFor(result, 'capture-only')[3];
  assert.equal(last.checks.pass, true);
  assert.equal(last.origin.unchanged, false);
  assert.equal(last.origin.after.configured, seriesOrigin(ordering.id), 'remote.origin.url was untouched');
  assert.match(last.origin.after.effective, /eval\.invalid\/other\//, 'the url rewrite changed the effective origin');
  assert.equal(last.valid, true, 'not invalid: the series store still says capture-only');
  assert.equal(last.knowledgeModeAfter, 'capture-only');
  assert.equal(last.pass, false);
});

test('a learning added in task 1 is injected in task 3 under recall and absent under stateless and capture-only', async () => {
  const { result, inspected } = await main();
  const third = arm => rowsFor(result, arm)[2];
  assert.equal(third('recall').trapRole, 'recurrence');
  assert.ok(third('recall').learningsInjected.includes(LEARNING_ID));
  assert.ok(third('recall').learningsBytes > 0);
  for (const arm of ['stateless', 'capture-only']) {
    assert.deepEqual(third(arm).learningsInjected, [], `${arm} injects nothing`);
    assert.equal(third(arm).learningsBytes, 0);
  }
  assert.deepEqual(rowsFor(result, 'recall')[0].learningsInjected, [], 'nothing to inject before task 1');
  const note = `docs/solutions/eval/${ordering.trap.id}.md`;
  for (const arm of ARMS) assert.equal(rowsFor(result, arm)[0].episodesWritten, 1, `${arm} task 1 wrote one episode`);
  for (const arm of ['capture-only', 'recall']) {
    assert.ok(third(arm).carriedForward.includes(note), `${arm} carried the episode forward`);
    assert.ok(inspected[third(arm).id].tracked.includes(note), 'carried episodes are committed in the next checkout');
  }
  assert.deepEqual(third('stateless').carriedForward, [], 'stateless inherits no notes');
  assert.deepEqual(inspected[third('stateless').id].tracked, []);
});

test('external plans in the shared home are cleared before every task', async () => {
  const { result, observations } = await main();
  for (const arm of ARMS) {
    assert.equal(rowsFor(result, arm)[1].externalPlansCleared, 1, `${arm} cleared the plan task 1 left`);
    assert.equal(observations[`${arm}:1`].planPresent, false);
  }
});

test('trap recurrence, pass, turns and usage are scored per attempt and arm', async () => {
  const { result, root } = await main();
  for (const arm of ARMS) {
    const [first, , recurrence] = rowsFor(result, arm);
    assert.equal(first.trapFirstFailed, true);
    assert.equal(first.pass, false);
    assert.equal(recurrence.turns, 2);
    assert.equal(recurrence.inputTokens, 100);
    assert.equal(recurrence.usageCoverage, 'complete');
    assert.equal(typeof recurrence.repeatMistake?.flagged, 'boolean');
    assert.equal(recurrence.trapRecurred, arm !== 'recall', `${arm} recurrence`);
    assert.equal(recurrence.pass, arm === 'recall');
  }
  assert.equal(rowsFor(result, 'recall')[3].pass, true);
  assert.equal(rowsFor(result, 'recall')[3].trapRecurred, null);
  const { arms } = result.summary;
  assert.equal(arms.stateless.recurrenceRate, 1);
  assert.equal(arms['capture-only'].recurrenceRate, 1);
  assert.equal(arms.recall.recurrenceRate, 0);
  assert.equal(arms.recall.passRate, 0.75);
  assert.equal(arms.stateless.passRate, 0.25);
  assert.equal(arms['capture-only'].passRate, 0.25);
  assert.equal(arms.recall.episodesPerSeries, 1);
  assert.equal(arms.recall.inputTokens, 400);
  assert.equal(result.summary.promotion.comparison, 'inconclusive', 'scripted runs never qualify');
  assert.ok(fs.existsSync(path.join(root, 'results.json')));
  assert.ok(fs.existsSync(path.join(root, 'provenance.json')));
});

test('identity drift makes an attempt invalid, an unsolved recurrence is unscored, and the batch is inconclusive', async () => {
  const { result } = await drift();
  const [one, two] = [1, 2].map(repeat => rowsFor(result, 'recall').filter(row => row.repeat === repeat));
  for (const rows of [one, two]) {
    assert.equal(rows[1].valid, false);
    assert.ok(rows[1].invalidReasons.includes('repo-identity-drift'));
    assert.equal(rows[1].pass, false);
    assert.equal(rows[3].valid, true);
    assert.equal(rows[3].episodesWritten, 1);
    assert.equal(rows[3].pass, true, 'a new episode is an expected write, not a scope violation');
  }
  assert.equal(one[2].valid, true);
  assert.equal(one[2].trapChecks.pass, false);
  assert.equal(one[2].trapRecurred, null, 'an unsolved task is not a recurrence');
  assert.equal(one[2].recurrenceUnscored, 'rest-of-task-unsolved');
  assert.equal(two[2].trapRecurred, false);
  const stats = result.summary.arms.recall;
  assert.equal(stats.invalidAttempts, 2);
  assert.equal(stats.measuredAttempts, 6);
  assert.equal(stats.recurrenceAttempts, 1);
  assert.equal(stats.recurrenceUnscored, 1);
  assert.equal(stats.episodesPerSeries, null, 'runs with invalid attempts do not count toward episodes per series');
});

test('summaries mark a batch with invalid attempts inconclusive', async () => {
  const { summarizeStudy } = await import('../eval/memory/study.mjs');
  const row = { arm: 'recall', split: 'held-out', kind: 'live', valid: false, actualModel: 'm', learningsInjected: [] };
  const summary = summarizeStudy({ attempts: [row], runs: [], provenance: { arms: ['stateless', 'recall'], model: 'm', modelSelection: 'fixed', batch: 'b' } });
  assert.equal(summary.promotion.comparison, 'inconclusive');
  assert.ok(summary.promotion.decisions.recall.reasons.includes('ineligible:invalid-attempts-in-batch'));
});

const stat = (recurrenceRate, over = {}) => ({
  batch: 'b', heldOutAttempts: 1000, passRate: 0.8, recurrenceAttempts: 1000, recurred: Math.round(recurrenceRate * 1000), recurrenceRate,
  episodesPerSeries: 2, usageCoverage: 'complete', ...over,
});

test('promotion: the 50/10/30 example is rejected against its recall baseline', () => {
  const stats = { stateless: stat(0.5), recall: stat(0.1), 'recall+feedback': stat(0.3) };
  const result = scorePromotion(stats);
  assert.equal(result.decisions.recall.promotable, true);
  const feedback = result.decisions['recall+feedback'];
  assert.equal(feedback.promotable, false);
  assert.equal(feedback.against.stateless.pass, true, 'it is 40% better than stateless');
  assert.ok(Math.abs(feedback.against.stateless.relativeRecurrenceReduction - 0.4) < 1e-9);
  assert.equal(feedback.against.recall.pass, false);
  assert.ok(Math.abs(feedback.against.recall.relativeRecurrenceReduction + 2) < 1e-9, 'it is 200% worse than recall');
  assert.ok(feedback.reasons.includes('vs-recall:recurrence-reduction-below-threshold'));
  assert.deepEqual(result.promotable, ['recall']);
});

test('promotion: thresholds, observations, significance, batch and baseline failure', () => {
  assert.equal(compareArms(stat(0.35), stat(0.5)).pass, true, '30% exactly passes');
  assert.ok(compareArms(stat(0.36), stat(0.5)).reasons.includes('recurrence-reduction-below-threshold'));
  assert.equal(compareArms(stat(0.1, { passRate: 0.78 }), stat(0.5)).pass, true, '-2pp is within the margin');
  assert.ok(compareArms(stat(0.1, { passRate: 0.77 }), stat(0.5)).reasons.includes('pass-rate-regressed'));
  assert.ok(compareArms(stat(0.1, { heldOutAttempts: 29 }), stat(0.5)).reasons.includes('insufficient-held-out-attempts'));
  assert.ok(compareArms(stat(0.1, { usageCoverage: 'partial' }), stat(0.5)).reasons.includes('incomplete-observed-usage'));
  assert.ok(compareArms(stat(0.5, { episodesPerSeries: 3 }), stat(0.5)).reasons.includes('episodes-rose-without-recurrence-falling'));
  assert.ok(compareArms(stat(0, { episodesPerSeries: 3 }), stat(0.5)).pass, 'episodes may rise when recurrence falls');
  assert.ok(compareArms(stat(0), stat(0)).reasons.includes('reference-has-no-recurrence'));
  assert.ok(compareArms(stat(0.1, { batch: 'other' }), stat(0.5)).reasons.includes('reference-not-in-same-batch'));
  // 2/8 against 3/8 is a 33% relative drop on 8 observations: neither enough observations nor significant.
  const small = compareArms(stat(0.25, { recurrenceAttempts: 8, recurred: 2 }), stat(0.375, { recurrenceAttempts: 8, recurred: 3 }));
  assert.ok(small.reasons.includes('insufficient-recurrence-observations'));
  assert.ok(small.reasons.includes('recurrence-reduction-not-significant'));
  const unclear = compareArms(stat(0.3, { recurrenceAttempts: 30, recurred: 9 }), stat(0.5, { recurrenceAttempts: 30, recurred: 15 }));
  assert.deepEqual(unclear.reasons, ['recurrence-reduction-not-significant']);
  assert.ok(fisherOneSided({ candidateRecurred: 0, candidateObservations: 30, referenceRecurred: 15, referenceObservations: 30 }) < 0.001);
  assert.ok(Math.abs(fisherOneSided({ candidateRecurred: 5, candidateObservations: 10, referenceRecurred: 5, referenceObservations: 10 }) - 0.6719) < 1e-3);
  const failedBaseline = scorePromotion({ stateless: stat(0.5), recall: stat(0.45), 'recall+feedback': stat(0.1) });
  assert.equal(failedBaseline.decisions.recall.promotable, false);
  assert.equal(failedBaseline.decisions['recall+feedback'].against.recall.pass, true);
  assert.equal(failedBaseline.decisions['recall+feedback'].against.stateless.pass, true);
  assert.equal(failedBaseline.decisions['recall+feedback'].promotable, false);
  assert.ok(failedBaseline.decisions['recall+feedback'].reasons.includes('baseline-recall-not-promotable'));
  const missing = scorePromotion({ stateless: stat(0.5), 'recall+feedback': stat(0.1) });
  assert.ok(missing.decisions['recall+feedback'].reasons.includes('baseline-recall-not-in-batch'));
  const auto = scorePromotion({ stateless: stat(0.5), recall: stat(0.1) }, { eligible: false, ineligibleReason: 'automatic-model-selection' });
  assert.equal(auto.comparison, 'inconclusive');
  assert.deepEqual(auto.promotable, []);
});

test('external plan clearing refuses a planted symlink and never deletes outside the harness home', t => {
  const root = directory(t);
  const home = path.join(root, 'home');
  const victim = path.join(root, 'victim');
  fs.mkdirSync(path.join(victim, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(victim, 'plans', 'keep.md'), 'outside\n');
  fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
  fs.symlinkSync(victim, path.join(home, 'projects', 'repo-id'), process.platform === 'win32' ? 'junction' : 'dir');
  const refused = clearExternalPlans(home, path.join(home, 'projects', 'repo-id'));
  assert.deepEqual(refused.refused.sort(), [path.join('docs', 'plans'), 'plans'].sort());
  assert.equal(fs.readFileSync(path.join(victim, 'plans', 'keep.md'), 'utf8'), 'outside\n');
  fs.rmSync(path.join(home, 'projects', 'repo-id'));
  fs.mkdirSync(path.join(home, 'projects', 'repo-id', 'plans'), { recursive: true });
  fs.symlinkSync(path.join(victim, 'plans'), path.join(home, 'projects', 'repo-id', 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(home, 'projects', 'repo-id', 'plans', 'old.md'), 'plan\n');
  const mixed = clearExternalPlans(home, path.join(home, 'projects', 'repo-id'));
  assert.equal(mixed.cleared, 1);
  assert.deepEqual(mixed.refused, [path.join('docs', 'plans')]);
  assert.equal(fs.existsSync(path.join(home, 'projects', 'repo-id', 'plans')), false);
  assert.ok(fs.existsSync(path.join(victim, 'plans', 'keep.md')));
});

test('stale study parents from dead runners are swept; live, foreign and unremovable ones are kept', t => {
  const base = directory(t);
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  const stale = fs.mkdtempSync(path.join(base, `aem-study-${dead}-`));
  const live = fs.mkdtempSync(path.join(base, `aem-study-${process.pid}-`));
  const unnamed = fs.mkdtempSync(path.join(base, 'aem-study-'));
  const legacy = fs.mkdtempSync(path.join(base, 'aem-study-'));
  fs.writeFileSync(path.join(legacy, 'owner.pid'), String(dead));
  fs.writeFileSync(path.join(stale, 'leftover'), 'x');
  const swept = sweepStaleStudies(base);
  assert.deepEqual(swept.sort(), [stale, legacy].sort(), 'an earlier-format parent is swept when its owner.pid is dead');
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(live), true);
  assert.equal(fs.existsSync(unnamed), true, 'a folder without an owner PID in its name is never swept');
  // A stale parent this user cannot remove is skipped instead of aborting the sweep. Root ignores directory permissions,
  // so there the sub-check is skipped. Permissions are restored before the test ends, ahead of the directory cleanup hook.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = fs.mkdtempSync(path.join(base, `aem-study-${dead}-`));
    const inner = path.join(locked, 'inner');
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(inner, 'file'), 'x');
    fs.chmodSync(inner, 0o500);
    try {
      let swept2;
      assert.doesNotThrow(() => { swept2 = sweepStaleStudies(base); });
      assert.equal(swept2.includes(locked), false, 'an unremovable parent is not reported as swept');
      assert.equal(fs.existsSync(path.join(inner, 'file')), true);
    } finally {
      fs.chmodSync(inner, 0o755);
      fs.chmodSync(locked, 0o755);
    }
  }
});

test('a crash mid-study saves finished attempt records and a partial results file', async t => {
  const root = path.join(directory(t), 'out');
  await assert.rejects(runStudy({ root, catalog: { ...CATALOG, series: [orders] }, arms: ['stateless'], repeats: 1, dryRun: true, studyBase: directory(t),
    inspect: (fixture, attempt) => { if (attempt.taskIndex === 2) throw new Error('runner crashed'); } }), /runner crashed/);
  const results = JSON.parse(fs.readFileSync(path.join(root, 'results.json'), 'utf8'));
  assert.equal(results.partial, true);
  assert.equal(results.summary, null);
  assert.equal(results.attempts.length, 2);
  assert.equal(fs.readdirSync(path.join(root, 'attempts', results.attempts[0].run)).length, 2);
});

test('SIGTERM during a run removes the agent-facing temporary root', { skip: process.platform === 'win32' && 'POSIX signals' }, async t => {
  const root = directory(t);
  const script = path.join(root, 'hang.mjs');
  const study = pathToFileURL(path.join(packageRoot, 'eval/memory/study.mjs')).href;
  fs.writeFileSync(script, `import { CATALOG, runStudy } from ${JSON.stringify(study)};
await runStudy({ root: ${JSON.stringify(path.join(root, 'out'))}, catalog: { ...CATALOG, series: [CATALOG.series[0]] }, arms: ['stateless'], repeats: 1, host: 'scripted-test',
  execute: async fixture => { if (fixture.index === 0) return { status: 'ok' }; setInterval(() => {}, 1000); process.stdout.write('READY ' + fixture.trial + '\\n'); await new Promise(() => {}); } });
`);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const trial = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/READY (.+)\n/); if (match) resolve(match[1]); });
    child.on('exit', code => reject(new Error(`exited early: ${code}`)));
  });
  const parent = path.dirname(path.dirname(trial));
  assert.ok(fs.existsSync(parent));
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  const { code } = await exited;
  assert.equal(code, 143);
  assert.equal(fs.existsSync(parent), false, 'the study parent and its run root are gone');
  // The finished first attempt survives the signal, marked partial.
  const results = JSON.parse(fs.readFileSync(path.join(root, 'out', 'results.json'), 'utf8'));
  assert.equal(results.partial, true);
  assert.deepEqual(results.attempts.map(row => row.taskIndex), [1]);
  assert.ok(fs.existsSync(path.join(root, 'out', 'attempts', results.attempts[0].run)));
});

test('same-batch enforcement compares the batch stamped on scored rows', () => {
  const row = (batch, over = {}) => ({ arm: 'recall', split: 'held-out', kind: 'live', valid: true, pass: true, batch, learningsInjected: [], trapRole: null, trapRecurred: null, usageCoverage: 'complete', inputTokens: 1, outputTokens: 1, ...over });
  assert.equal(armStatistics({ attempts: [row('a'), row('a')], runs: [], arm: 'recall', split: 'held-out' }).batch, 'a');
  assert.equal(armStatistics({ attempts: [row('a'), row('b')], runs: [], arm: 'recall', split: 'held-out' }).batch, null);
  assert.equal(armStatistics({ attempts: [row(undefined)], runs: [], arm: 'recall', split: 'held-out' }).batch, null);
  assert.ok(compareArms(stat(0.1, { batch: null }), stat(0.5, { batch: null })).reasons.includes('reference-not-in-same-batch'));
});

test('compareArms reports unscored rates and rejects arms whose unscored rates differ widely', () => {
  const close = compareArms(stat(0.1, { unscoredRate: 0.1 }), stat(0.5, { unscoredRate: 0.15 }));
  assert.equal(close.pass, true);
  assert.ok(Math.abs(close.unscoredRateDifference + 0.05) < 1e-9);
  assert.equal(close.candidateUnscoredRate, 0.1);
  const wide = compareArms(stat(0.1, { unscoredRate: 0.4 }), stat(0.5, { unscoredRate: 0.1 }));
  assert.ok(wide.reasons.includes('unscored-rates-differ'));
});

test('an origin rewrite the runner cannot undo and a refused plan clear each invalidate their attempt', async t => {
  const victim = path.join(directory(t), 'victim');
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, 'keep.md'), 'outside\n');
  const calls = [];
  const hooks = {
    // An included config file is outside `git config --local`, so the runner cannot remove this rewrite.
    'stateless:1': ({ workspace }) => {
      fs.writeFileSync(path.join(workspace, '.git', 'rewrite.cfg'), '[url "https://eval.invalid/other/"]\n\tinsteadOf = https://eval.invalid/ae-memory/\n');
      spawnSync('git', ['config', '--local', 'include.path', 'rewrite.cfg'], { cwd: workspace });
    },
    // A planted symlink for the project's plans folder makes the next task's plan clear refuse.
    'stateless:2': ({ workspace, harnessHome }) => {
      const project = path.join(harnessHome, 'projects', path.basename(storeDir(workspace, { home: harnessHome })));
      fs.mkdirSync(project, { recursive: true });
      fs.rmSync(path.join(project, 'plans'), { recursive: true, force: true });
      fs.symlinkSync(victim, path.join(project, 'plans'), process.platform === 'win32' ? 'junction' : 'dir');
    },
  };
  const result = await runStudy({ root: path.join(directory(t), 'out'), catalog: { ...CATALOG, series: [orders] }, arms: ['stateless'], repeats: 1, model: 'scripted-test', host: 'scripted-test', studyBase: directory(t), execute: scriptedExecutor(calls, hooks) });
  const [first, second, third, fourth] = result.attempts;
  assert.equal(first.valid, true);
  assert.equal(second.valid, false);
  assert.deepEqual(second.invalidReasons, ['origin-restore-failed']);
  assert.equal(third.valid, true, 'each task gets a fresh checkout, so the rewrite does not carry over');
  assert.equal(fourth.valid, false);
  assert.ok(fourth.invalidReasons.includes('external-plans-not-cleared'));
  assert.equal(fs.readFileSync(path.join(victim, 'keep.md'), 'utf8'), 'outside\n');
});

test('output directory must be new and outside the checkout', t => {
  const checkout = path.resolve(packageRoot, '../..');
  assert.throws(() => resolveStudyOutput({ checkout, output: path.join(packageRoot, 'memory-results') }), /outside the checkout/);
  const outside = directory(t);
  assert.throws(() => resolveStudyOutput({ checkout, output: outside }), /new directory/);
  assert.equal(resolveStudyOutput({ checkout, output: path.join(outside, 'fresh') }), path.join(fs.realpathSync(outside), 'fresh'));
  const cli = spawnSync(process.execPath, [path.join(packageRoot, 'eval/memory/run.mjs'), '--out', path.join(packageRoot, 'memory-results')], { encoding: 'utf8' });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /outside the checkout/);
  assert.equal(fs.existsSync(path.join(packageRoot, 'memory-results')), false);
});

test('dry run makes no provider calls and still reports planned injection and fixture validation', async () => {
  const { result, calls } = await dry();
  assert.equal(calls(), 0);
  assert.ok(result.attempts.every(row => row.kind === 'dry-run' && row.pass === false && row.trapRecurred === null && row.repeatMistake === null && row.checks === null));
  assert.ok(result.attempts.every(row => row.baseline.pass === false && row.publicBaseline.pass === false));
  assert.ok(rowsFor(result, 'frozen-seed')[2].learningsInjected.includes(seedId(orders)));
  assert.deepEqual(rowsFor(result, 'recall+feedback')[2].learningsInjected, []);
  assert.equal(result.summary.arms['frozen-seed'].measuredAttempts, 0);
  assert.equal(result.summary.promotion.comparison, 'inconclusive');
  assert.equal(result.provenance.origin, PROTOCOL.origin);
});
