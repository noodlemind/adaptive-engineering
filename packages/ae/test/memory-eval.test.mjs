import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import {
  CATALOG, PROTOCOL, PUBLIC_CHECK, SNAPSHOT_LIMIT_EXCEEDED, SUPPLIED_FILES, armById, authorizeFixtureChecks, armStatistics, baselineChain, clearExternalPlans, collectCarryForward, compareArms, captureMemory, episodeHashes, runAgentProcess, fisherOneSided, resolveStudyOutput, runStudy, runnableArms, scorePromotion, seriesOrigin, sweepStaleStudies, validateProtocol, writeMemory,
} from '../eval/memory/study.mjs';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { runInsightCompound } from '../lib/compound.mjs';
import { runOrient } from '../lib/orient.mjs';
import { storeDir, writeStoreConfig } from '../lib/knowledge/store.mjs';
import { loadNamedChecks, runNamedCheck } from '../lib/checks.mjs';
import { trustStatus } from '../lib/trust.mjs';

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
        const taskRoot = path.dirname(fixture.trial);
        const runDir = path.dirname(taskRoot);
        observations[`${fixture.arm.id}:${fixture.index}`] = {
          home: fs.readdirSync(fixture.env.HOME), homePath: fixture.env.HOME, tmp: fixture.env.TMPDIR, trial: fixture.trial,
          taskRoot: fs.readdirSync(taskRoot).sort(), taskRootPath: taskRoot, runDirPath: runDir, studyParent: path.dirname(runDir),
          // The run root and study parent are unlisted while the study runs; root and Windows ignore that mode.
          runDir: (() => { try { return fs.readdirSync(runDir); } catch (error) { return error.code; } })(),
          runDirMode: fs.statSync(runDir).mode & 0o7777, parentMode: fs.statSync(path.dirname(runDir)).mode & 0o7777,
          parentListing: (() => { try { return fs.readdirSync(path.dirname(runDir)).length; } catch (error) { return error.code; } })(),
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
/** Directory modes bind this process: not root, not Windows. */
const unlistedModesApply = process.platform !== 'win32' && process.getuid?.() !== 0;
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
    assert.deepEqual(seen.taskRoot, ['copilot', 'state', `t${index + 1}`], `${key} sees only its own task`);
    if (unlistedModesApply) {
      assert.equal(seen.runDir, 'EACCES', `${key} cannot list its run root`);
      assert.equal(seen.parentListing, 'EACCES', `${key} cannot list the study parent`);
    } else assert.deepEqual(seen.runDir, [path.basename(seen.taskRootPath)], `${key} earlier task roots are gone`);
    if (process.platform !== 'win32') {
      assert.equal(seen.runDirMode, 0o300, `${key} run root is owner write and search only`);
      assert.equal(seen.parentMode, 0o300, `${key} study parent is owner write and search only`);
    }
    assert.match(path.basename(seen.taskRootPath), /^task-[A-Za-z0-9]{6}$/, `${key} task root has an unpredictable name`);
    assert.ok(seen.homePath.startsWith(seen.trial + path.sep), `${key} HOME belongs to this task only`);
    assert.ok(seen.tmp.startsWith(seen.trial + path.sep), `${key} TMPDIR belongs to this task only`);
    assert.deepEqual(fs.existsSync(seen.studyParent) ? fs.readdirSync(seen.studyParent) : [], [], `${key} study parent is removed`);
    assert.ok(seen.outsideOut, `${key} workspace is outside the output root`);
    // Private checks stay in the runner's memory: no check file exists anywhere while an agent runs.
    assert.equal(seen.checkFile, null, `${key} has no private check file`);
    assert.equal(seen.hasCheckText, true);
    assert.deepEqual(seen.outFiles, ['provenance.json'], `${key} output root holds no private checks or attempt records during the run`);
    assert.equal(fs.existsSync(seen.taskRootPath), false, `${key} task root is removed after the task`);
    assert.equal(fs.existsSync(seen.runDirPath), false, `${key} run root is removed after the run`);
  }
  const seen = Object.values(observations);
  assert.equal(new Set(seen.map(row => row.runDirPath)).size, ARMS.length, 'each run gets its own temporary root');
  assert.equal(new Set(seen.map(row => row.taskRootPath)).size, seen.length, 'each task gets its own root');
  assert.ok(result.attempts.every(row => !JSON.stringify(row).includes('trap-checks.json')));
  assert.equal(fs.existsSync(path.join(root, 'private')), false);
});

test('every task gets fresh homes; the series store identity and recall memory carry across tasks', async () => {
  const { result, calls, inspected } = await main();
  for (const arm of ARMS) {
    const armCalls = calls.filter(call => call.arm === arm);
    assert.equal(armCalls.length, 4);
    assert.equal(new Set(rowsFor(result, arm).map(row => row.storeId)).size, 1, `${arm} resolves one store id across its tasks`);
  }
  assert.equal(new Set(calls.map(call => call.harnessHome)).size, calls.length, 'every task has its own harness home');
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
  assert.ok(third('recall').carriedForward.includes(note), 'recall carried the episode forward');
  for (const arm of ARMS) assert.deepEqual(rowsFor(result, arm)[0].carryForwardDropped, { oversized: 0, overFileLimit: 0 }, `${arm} task 1 dropped no notes`);
  assert.ok(inspected[third('recall').id].tracked.includes(note), 'carried episodes are committed in the next checkout');
  // capture-only writes memory but never reads it back, so its notes stay behind like stateless ones.
  for (const arm of ['stateless', 'capture-only']) {
    assert.deepEqual(third(arm).carriedForward, [], `${arm} inherits no notes`);
    assert.deepEqual(inspected[third(arm).id].tracked, []);
  }
});

test('external plans an earlier task left never reach the next task, whose homes are fresh', async () => {
  const { result, observations } = await main();
  for (const arm of ARMS) {
    assert.equal(rowsFor(result, arm)[1].externalPlansCleared, 0, `${arm} task 2 had no plan to clear`);
    assert.deepEqual(rowsFor(result, arm)[1].externalPlansRefused, []);
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

test('carry-forward and episode counts never follow a symlinked docs/solutions, docs or nested folder', t => {
  const root = directory(t);
  const link = process.platform === 'win32' ? 'junction' : 'dir';
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(outside, 'solutions'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'id_rsa'), 'secret\n');
  fs.writeFileSync(path.join(outside, 'leak.md'), 'outside note\n');
  fs.writeFileSync(path.join(outside, 'solutions', 'leak.md'), 'outside note\n');
  const fresh = name => { const dir = path.join(root, name); fs.mkdirSync(dir); return dir; };
  const project = name => { const dir = fresh(name); fs.mkdirSync(path.join(dir, 'docs', 'solutions'), { recursive: true }); return dir; };

  // docs/solutions itself is a link.
  const linkedLeaf = fresh('leaf');
  fs.mkdirSync(path.join(linkedLeaf, 'docs'));
  fs.symlinkSync(outside, path.join(linkedLeaf, 'docs', 'solutions'), link);
  assert.deepEqual(collectCarryForward(linkedLeaf), {});
  assert.deepEqual(episodeHashes(linkedLeaf, project('leaf-project')), {});

  // A parent (docs) is a link; the project store's docs is linked the same way.
  const linkedParent = fresh('parent');
  fs.symlinkSync(outside, path.join(linkedParent, 'docs'), link);
  const linkedProject = fresh('parent-project');
  fs.symlinkSync(outside, path.join(linkedProject, 'docs'), link);
  assert.deepEqual(collectCarryForward(linkedParent), {});
  assert.deepEqual(episodeHashes(linkedParent, linkedProject), {});

  // Real folders count; a linked folder or file inside them is skipped, as a checkout would commit the link, not its target.
  const real = fresh('real');
  fs.mkdirSync(path.join(real, 'docs', 'solutions', 'eval'), { recursive: true });
  fs.writeFileSync(path.join(real, 'docs', 'solutions', 'eval', 'note.md'), 'inside note\n');
  fs.symlinkSync(outside, path.join(real, 'docs', 'solutions', 'nested'), link);
  try { fs.symlinkSync(path.join(outside, 'id_rsa'), path.join(real, 'docs', 'solutions', 'key.md')); } catch { /* file links may need privileges on Windows */ }
  assert.deepEqual(Object.keys(collectCarryForward(real)), ['docs/solutions/eval/note.md']);
  assert.deepEqual(Object.keys(episodeHashes(real, project('real-project'))), ['workspace:eval/note.md']);
});

test('the memory study runs both checkers under its own protocol checkerTimeoutMs and records that value', async t => {
  const { result } = await dry();
  assert.equal(result.provenance.checkerTimeoutMs, PROTOCOL.checkerTimeoutMs);
  // A 1 ms checker timeout from the memory protocol (the context protocol's is 15 s) times out the baseline checks. A timed-out
  // baseline says nothing about the fixture, so even on task 1 it makes that attempt invalid instead of aborting the study.
  const protocol = { ...PROTOCOL, checkerTimeoutMs: 1 };
  const root = path.join(directory(t), 'out');
  let calls = 0;
  const timed = await runStudy({ root, catalog: { ...CATALOG, series: [orders] }, protocol, arms: ['stateless'], repeats: 1, model: 'scripted-test', host: 'scripted-test', studyBase: directory(t), execute: () => { calls += 1; return usage; } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'provenance.json'), 'utf8')).checkerTimeoutMs, 1);
  assert.equal(calls, 0, 'no agent runs on a task whose baseline timed out');
  const [first] = rowsFor(timed, 'stateless');
  assert.equal(first.kind, 'setup-error');
  assert.equal(first.valid, false);
  assert.deepEqual(first.invalidReasons, ['baseline-timeout']);
  assert.match(first.error, /baseline checker timed out/);
  assert.equal(timed.summary.eligibility.reason, 'not-a-complete-live-batch');
  // A task 1 baseline that runs and passes is a real fixture error and still stops the study.
  const broken = structuredClone(orders);
  broken.tasks[0].files = { ...broken.tasks[0].files, ...broken.tasks[0].reference };
  await assert.rejects(runStudy({ root: path.join(directory(t), 'out'), catalog: { ...CATALOG, series: [broken] }, arms: ['stateless'], repeats: 1, dryRun: true, studyBase: directory(t) }), /invalid broken baseline/);
  assert.throws(() => validateProtocol({ ...PROTOCOL, checkerTimeoutMs: 0 }), /checkerTimeoutMs/);
});

test('a study whose parent cannot be opened leaves no output directory behind, so a retry can use the same root', async t => {
  const root = path.join(directory(t), 'out');
  await assert.rejects(runStudy({ root, catalog: { ...CATALOG, series: [orders] }, arms: ['stateless'], repeats: 1, dryRun: true, studyBase: path.join(directory(t), 'missing') }));
  assert.equal(fs.existsSync(root), false);
});

test('one runtime error makes a live batch ineligible, and the summary names that attempt', async t => {
  let failed = null;
  const result = await runStudy({ root: path.join(directory(t), 'out'), catalog: { ...CATALOG, series: [orders] }, arms: ['stateless'], repeats: 1, model: 'live-test', host: 'cli:test', studyBase: directory(t),
    execute: async fixture => {
      if (fixture.index === 2) { failed = fixture; throw new Error('agent process failed: ETIMEDOUT'); }
      write(fixture.workspace, fixture.task.reference);
      return { ...usage, model: 'live-test', contextAccounting: [{ ...usage.contextAccounting[0], model: 'live-test' }] };
    } });
  assert.ok(failed);
  const rows = rowsFor(result, 'stateless');
  assert.deepEqual(rows.map(row => row.kind), ['live', 'live', 'runtime-error', 'live']);
  assert.deepEqual(result.summary.eligibility, { eligible: false, reason: 'not-a-complete-live-batch', attempts: 1, attemptIds: [rows[2].id], kinds: { 'runtime-error': 1 } });
  assert.equal(result.summary.promotion.comparison, 'inconclusive');
});

test('an agent-made store config change is reported and never reaches the next task, which rebuilds the config from the arm', async t => {
  const seen = {};
  const readConfig = ({ workspace, harnessHome }) => JSON.parse(fs.readFileSync(path.join(storeDir(workspace, { home: harnessHome }), 'config.json'), 'utf8'));
  const hooks = {
    // The agent sets a commit mode and an extra key while leaving the mode and feedback state as the arm set them.
    'recall:0': fixture => {
      seen.first = readConfig(fixture);
      const file = path.join(storeDir(fixture.workspace, { home: fixture.harnessHome }), 'config.json');
      fs.writeFileSync(file, JSON.stringify({ ...seen.first, commit: 'repo', agentKey: 'leaked' }) + '\n');
    },
    'recall:1': fixture => { seen.second = readConfig(fixture); },
  };
  const result = await runStudy({ root: path.join(directory(t), 'out'), catalog: { ...CATALOG, series: [orders] }, arms: ['recall'], repeats: 1, model: 'scripted-test', host: 'scripted-test', studyBase: directory(t), execute: scriptedExecutor([], hooks) });
  const [first, second] = rowsFor(result, 'recall');
  assert.equal(first.configChangedByAgent, true, 'a change to any config key is reported');
  assert.equal(first.knowledgeModeAfter, 'on');
  assert.equal(second.configChangedByAgent, false);
  assert.deepEqual(second.invalidReasons, []);
  assert.deepEqual(seen.second, seen.first, 'task 2 starts from the same config task 1 started from');
  assert.equal(seen.second.agentKey, undefined);
  assert.notEqual(seen.second.commit, 'repo');
});

test('a detached daemon the last task started does not outlive the study', { skip: process.platform !== 'linux' && '/proc' }, async t => {
  let daemon = null;
  t.after(() => { try { if (daemon) process.kill(daemon, 'SIGKILL'); } catch { /* gone */ } });
  const last = orders.tasks.length - 1;
  const hooks = {
    [`stateless:${last}`]: ({ workspace }) => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: workspace, detached: true, stdio: 'ignore' });
      child.unref();
      daemon = child.pid;
    },
  };
  const result = await runStudy({ root: path.join(directory(t), 'out'), catalog: { ...CATALOG, series: [orders] }, arms: ['stateless'], repeats: 1, model: 'scripted-test', host: 'scripted-test', studyBase: directory(t), execute: scriptedExecutor([], hooks) });
  assert.ok(result.summary);
  assert.ok(daemon);
  assert.equal(await waitDead(daemon), true, 'the daemon from the final task was killed when the study ended');
});

test('controls: operator-granted checks, public examples in scoring, a protected verifier and fixed memory for capture-only and frozen-seed', async t => {
  const executor = scriptedExecutor([]);
  const seen = {};
  const external = ({ copilotHome, harnessHome, workspace }) => {
    const project = path.join(harnessHome, 'projects', path.basename(storeDir(workspace, { home: harnessHome })));
    return { episode: path.join(project, 'docs', 'solutions', 'eval', 'captured.md'), manifest: path.join(copilotHome, 'knowledge', 'captured.md'), index: path.join(harnessHome, 'index', 'captured.json'),
      feedback: path.join(project, 'feedback', `${'a'.repeat(64)}.json`) };
  };
  const result = await runStudy({ root: path.join(directory(t), 'out'), catalog: { ...CATALOG, series: [ordering] }, arms: ['capture-only', 'recall+feedback', 'frozen-seed'], repeats: 1,
    model: 'scripted-test', host: 'scripted-test', studyBase: directory(t),
    execute: async fixture => {
      const { arm, index, workspace, copilotHome, harnessHome, task } = fixture;
      const key = `${arm.id}:${index}`;
      // Finding 1: the runner, as operator, registers the public verifier and grants trust; it is idempotent across the series.
      const granted = authorizeFixtureChecks(fixture);
      const named = loadNamedChecks(workspace, { home: harnessHome });
      const files = external(fixture);
      seen[key] = { granted: granted.trust.trusted, trusted: trustStatus({ workspace, copilotHome, home: harnessHome }).trusted, command: named.checks?.[PUBLIC_CHECK]?.command,
        captured: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, fs.existsSync(file)])) };
      if (index === 2) {
        // Finding 2: a constant answer passes the edge-case private check but fails the public example.
        write(workspace, { 'src/tags.mjs': 'export function uniqueTags() { return []; }\n' });
      } else await executor(fixture);
      if (index === 0) for (const file of Object.values(files)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'captured in task 1\n'); }
      if (index === 1) seen[key].publicCheck = (await runNamedCheck(workspace, PUBLIC_CHECK, named.checks[PUBLIC_CHECK], { copilotHome, home: harnessHome })).status;
      // Finding 3: a no-op verifier is a scope violation; other Harness state is not.
      if (index === 3 && arm.id === 'capture-only') { fs.chmodSync(path.join(workspace, SUPPLIED_FILES[0]), 0o644); fs.writeFileSync(path.join(workspace, SUPPLIED_FILES[0]), 'process.exit(0);\n'); }
      if (index === 3 && arm.id === 'recall+feedback') fs.writeFileSync(path.join(workspace, '.harness', 'scratch.json'), '{}\n');
      return usage;
    } });
  for (const arm of ['capture-only', 'recall+feedback', 'frozen-seed']) {
    for (let index = 0; index < 4; index++) {
      const row = seen[`${arm}:${index}`];
      assert.equal(row.granted && row.trusted, true, `${arm} task ${index + 1} is trusted by the operator`);
      assert.deepEqual(row.command, [process.execPath, '.harness/context-verify.mjs']);
    }
    assert.equal(seen[`${arm}:1`].publicCheck, 'passed', `${arm} named public check passes on a solved task`);
    const recurrence = rowsFor(result, arm)[2];
    assert.equal(recurrence.otherChecks.pass, false, `${arm} constant answer fails the public example`);
    assert.equal(recurrence.trapRecurred, null, `${arm} constant answer is not a recurrence`);
    assert.equal(recurrence.recurrenceUnscored, 'rest-of-task-unsolved');
  }
  // Finding 4: the episode store, recall manifest, index and feedback records captured in task 1 are gone for capture-only
  // and frozen-seed, and kept for recall+feedback, which reads its feedback records back.
  for (const index of [1, 2, 3]) {
    assert.deepEqual(seen[`recall+feedback:${index}`].captured, { episode: true, manifest: true, index: true, feedback: true });
    for (const arm of ['capture-only', 'frozen-seed']) assert.deepEqual(seen[`${arm}:${index}`].captured, { episode: false, manifest: false, index: false, feedback: false }, `${arm} task ${index + 1}`);
  }
  for (const row of result.attempts) assert.deepEqual(row.carriedMemoryRefused, []);
  assert.ok(rowsFor(result, 'frozen-seed')[2].learningsInjected.includes(seedId(ordering)), 'frozen-seed keeps its seed');
  const tampered = rowsFor(result, 'capture-only')[3];
  assert.deepEqual(tampered.scope.unexpected, [SUPPLIED_FILES[0]]);
  assert.equal(tampered.pass, false);
  const scratch = rowsFor(result, 'recall+feedback')[3];
  assert.deepEqual(scratch.scope.unexpected, []);
  assert.equal(scratch.checks.pass, true);
});

test('carried memory is copied into fresh homes as regular files and directories, and nothing else', t => {
  const root = directory(t);
  const make = name => {
    const homes = { copilotHome: path.join(root, name, 'copilot'), harnessHome: path.join(root, name, 'state') };
    homes.projectDir = path.join(homes.harnessHome, 'projects', 'repo-id');
    fs.mkdirSync(homes.copilotHome, { recursive: true });
    fs.mkdirSync(homes.harnessHome, { recursive: true });
    return homes;
  };
  const from = make('from');
  fs.mkdirSync(path.join(from.projectDir, 'docs', 'solutions', 'eval'), { recursive: true });
  fs.writeFileSync(path.join(from.projectDir, 'docs', 'solutions', 'eval', 'note.md'), 'note\n');
  fs.mkdirSync(path.join(from.harnessHome, 'knowledge', 'repo-id', 'learnings'), { recursive: true });
  fs.mkdirSync(path.join(from.harnessHome, 'knowledge', 'repo-id', 'empty'));
  fs.writeFileSync(path.join(from.harnessHome, 'knowledge', 'repo-id', 'config.json'), '{"mode":"on"}\n');
  fs.mkdirSync(path.join(from.copilotHome, 'knowledge'));
  fs.writeFileSync(path.join(from.copilotHome, 'knowledge', 'manifest.md'), 'manifest\n');
  // Not carried: storage aliases, plans and other project state.
  fs.mkdirSync(path.join(from.harnessHome, 'storage-aliases'));
  fs.writeFileSync(path.join(from.harnessHome, 'storage-aliases', 'repo-id.json'), 'garbage');
  fs.mkdirSync(path.join(from.projectDir, 'plans'));
  fs.writeFileSync(path.join(from.projectDir, 'plans', 'old.md'), 'plan\n');
  fs.writeFileSync(path.join(from.projectDir, 'agent-context.md'), 'context\n');
  const captured = captureMemory(from);
  assert.deepEqual(captured.refused, []);
  // The copy lives in memory: a later change to the source does not reach it.
  fs.writeFileSync(path.join(from.projectDir, 'docs', 'solutions', 'eval', 'note.md'), 'changed\n');
  const to = make('to');
  writeMemory(to, captured);
  assert.equal(fs.readFileSync(path.join(to.projectDir, 'docs', 'solutions', 'eval', 'note.md'), 'utf8'), 'note\n');
  assert.equal(fs.readFileSync(path.join(to.copilotHome, 'knowledge', 'manifest.md'), 'utf8'), 'manifest\n');
  assert.equal(fs.existsSync(path.join(to.harnessHome, 'knowledge', 'repo-id', 'config.json')), false, 'a store config is never carried; the next task rebuilds it');
  assert.ok(fs.statSync(path.join(to.harnessHome, 'knowledge', 'repo-id', 'learnings')).isDirectory());
  assert.ok(fs.statSync(path.join(to.harnessHome, 'knowledge', 'repo-id', 'empty')).isDirectory(), 'empty directories are kept');
  assert.equal(fs.existsSync(path.join(to.harnessHome, 'index')), false, 'an absent target stays absent');
  assert.equal(fs.existsSync(path.join(to.harnessHome, 'storage-aliases')), false);
  assert.deepEqual(fs.readdirSync(to.projectDir), ['docs']);
});

test('feedback records are carried only for arms that read captured memory, and lock state is never carried', t => {
  const root = directory(t);
  const make = (name, feedback) => {
    const homes = { copilotHome: path.join(root, name, 'copilot'), harnessHome: path.join(root, name, 'state'), feedback };
    homes.projectDir = path.join(homes.harnessHome, 'projects', 'repo-id');
    fs.mkdirSync(homes.copilotHome, { recursive: true });
    fs.mkdirSync(homes.harnessHome, { recursive: true });
    return homes;
  };
  const record = `${'b'.repeat(64)}.json`;
  const from = make('from', true);
  fs.mkdirSync(path.join(from.projectDir, 'feedback'), { recursive: true });
  fs.writeFileSync(path.join(from.projectDir, 'feedback', record), '{"version":1}\n');
  // Lock state an interrupted writer left an hour ago: copied with a fresh mtime it would look live and wedge the store.
  const store = path.join(from.harnessHome, 'knowledge', 'repo-id');
  const hourAgo = new Date(Date.now() - 3600_000);
  fs.mkdirSync(path.join(store, '.lock'), { recursive: true });
  fs.writeFileSync(path.join(store, '.lock', 'owner.json'), '{"pid":1}\n');
  fs.mkdirSync(path.join(store, '.lock.stale-0123456789abcdef'));
  fs.mkdirSync(path.join(store, '.git'));
  fs.writeFileSync(path.join(store, '.git', 'index.lock'), '');
  fs.writeFileSync(path.join(store, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(store, 'config.json'), '{"mode":"on"}\n');
  for (const file of [path.join(store, '.lock', 'owner.json'), path.join(store, '.lock'), path.join(store, '.git', 'index.lock')]) fs.utimesSync(file, hourAgo, hourAgo);
  const carried = make('carried', true);
  writeMemory(carried, captureMemory(from));
  assert.equal(fs.readFileSync(path.join(carried.projectDir, 'feedback', record), 'utf8'), '{"version":1}\n');
  const carriedStore = path.join(carried.harnessHome, 'knowledge', 'repo-id');
  assert.deepEqual(fs.readdirSync(carriedStore).sort(), ['.git'], 'no .lock, stale tombstone or store config is carried');
  assert.deepEqual(fs.readdirSync(path.join(carriedStore, '.git')), ['HEAD'], 'no .git lock is carried');
  // A fixed arm captures without feedback records.
  const fixedSource = { ...from, feedback: false };
  const fixed = make('fixed', false);
  writeMemory(fixed, captureMemory(fixedSource));
  assert.equal(fs.existsSync(path.join(fixed.projectDir, 'feedback')), false);
});

test('capturing memory refuses symlinks, special files and oversized stores', t => {
  const root = directory(t);
  const link = process.platform === 'win32' ? 'junction' : 'dir';
  const make = name => {
    const homes = { copilotHome: path.join(root, name, 'copilot'), harnessHome: path.join(root, name, 'state') };
    homes.projectDir = path.join(homes.harnessHome, 'projects', 'repo-id');
    fs.mkdirSync(path.join(homes.projectDir, 'docs', 'solutions'), { recursive: true });
    fs.mkdirSync(homes.copilotHome, { recursive: true });
    fs.writeFileSync(path.join(homes.projectDir, 'docs', 'solutions', 'seed.md'), 'seed\n');
    return homes;
  };
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'outside\n');
  const key = 'projects/repo-id/docs/solutions';
  // A symlinked component on the way to a target.
  const parent = make('parent');
  fs.rmSync(path.join(parent.projectDir, 'docs'), { recursive: true });
  fs.symlinkSync(outside, path.join(parent.projectDir, 'docs'), link);
  let captured = captureMemory(parent);
  assert.equal(captured.refused.length, 1);
  assert.match(captured.refused[0], new RegExp(`^${key}: projects/repo-id/docs is not a real directory`));
  assert.equal(captured.targets.some(row => row.rel.split(path.sep).join('/') === key), false, 'a refused target is left out');
  // A symlinked directory inside a target.
  const nested = make('nested');
  fs.symlinkSync(outside, path.join(nested.projectDir, 'docs', 'solutions', 'linked'), link);
  captured = captureMemory(nested);
  assert.deepEqual(captured.refused, [`${key}: linked is a symlink or special file`]);
  // A symlinked home.
  const home = make('home');
  fs.renameSync(home.copilotHome, `${home.copilotHome}-moved`);
  fs.symlinkSync(outside, home.copilotHome, link);
  assert.deepEqual(captureMemory(home).refused, ['knowledge: home is not a real directory']);
  if (process.platform !== 'win32') {
    const special = make('special');
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(special.projectDir, 'docs', 'solutions', 'key.md'));
    assert.deepEqual(captureMemory(special).refused, [`${key}: key.md is a symlink or special file`]);
    const fifo = make('fifo');
    assert.equal(spawnSync('mkfifo', [path.join(fifo.projectDir, 'docs', 'solutions', 'pipe.md')]).status, 0);
    assert.deepEqual(captureMemory(fifo).refused, [`${key}: pipe.md is a symlink or special file`]);
  }
  // More files than the limit.
  const large = make('large');
  for (let i = 0; i < 2001; i++) fs.writeFileSync(path.join(large.projectDir, 'docs', 'solutions', `n${i}.md`), '');
  assert.deepEqual(captureMemory(large).refused, [`${key}: more files than the memory limit`]);
});

test('a learning an agent writes mid-task in frozen-seed is not carried into later tasks; the seed stays', async t => {
  const calls = [];
  const written = {};
  const executor = scriptedExecutor(calls, {
    'frozen-seed:0': ({ workspace, harnessHome, series }) => {
      // The agent turns knowledge on, records a learning and freezes again, as `ae knowledge on/freeze` would.
      assert.equal(writeStoreConfig(workspace, { home: harnessHome, mode: 'on' }).pass, true);
      const rel = `docs/solutions/eval/${series.trap.id}.md`;
      const text = fs.readFileSync(path.join(workspace, rel), 'utf8');
      applyOps({ workspace, home: harnessHome, operations: { schema: 1, ops: [{ op: 'ADD', domain: 'javascript', slug: 'eval-scripted-trap', trigger: series.seed.op.trigger, body: series.seed.op.body,
        episodes: [{ path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex'), kind: 'fix', plan: null }] }] } });
      assert.equal(writeStoreConfig(workspace, { home: harnessHome, mode: 'freeze' }).pass, true);
      written.task1 = storedLearnings(storeDir(workspace, { home: harnessHome }));
    },
  });
  const result = await runStudy({ root: path.join(directory(t), 'out'), catalog: { ...CATALOG, series: [ordering] }, arms: ['frozen-seed'], repeats: 1,
    model: 'scripted-test', host: 'scripted-test', studyBase: directory(t),
    execute: async fixture => {
      if (fixture.index > 0) written[`task${fixture.index + 1}`] = storedLearnings(storeDir(fixture.workspace, { home: fixture.harnessHome }));
      return executor(fixture);
    } });
  assert.ok(written.task1.includes('eval-scripted-trap'), 'the mid-task learning was written');
  for (const index of [1, 2, 3]) {
    assert.ok(!written[`task${index + 1}`].includes('eval-scripted-trap'), `task ${index + 1} store has no mid-task learning`);
    assert.ok(written[`task${index + 1}`].includes(ordering.seed.op.slug), `task ${index + 1} store keeps the seed`);
    assert.ok(!calls[index].injected.includes(LEARNING_ID), `task ${index + 1} is not injected the mid-task learning`);
  }
  const rows = rowsFor(result, 'frozen-seed');
  assert.ok(rows[2].learningsInjected.includes(seedId(ordering)));
  for (const row of rows) { assert.deepEqual(row.carriedMemoryRefused, []); assert.equal(row.knowledgeMode, 'freeze'); }
});

test('the agent runs in its own process group and nothing it leaves running outlives the task', { skip: process.platform === 'win32' }, async t => {
  const root = directory(t);
  const marker = path.join(root, 'grandchild.pid');
  const script = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(c.pid)); c.unref(); process.stdout.write('{"ok":true}');`;
  const result = await runAgentProcess(process.execPath, ['-e', script], { cwd: root, env: process.env, timeoutMs: 10_000 });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true });
  const pid = Number(fs.readFileSync(marker, 'utf8'));
  // A killed process that no init reaps stays a zombie; on Linux its /proc state says so.
  const running = () => {
    try { process.kill(pid, 0); } catch { return false; }
    try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '')[0] !== 'Z'; } catch { return true; }
  };
  let alive = true;
  for (let i = 0; i < 50 && (alive = running()); i++) await new Promise(done => setTimeout(done, 20));
  assert.equal(alive, false, 'the grandchild was killed with the group');
  const slow = await runAgentProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: root, env: process.env, timeoutMs: 200 });
  assert.equal(slow.error?.code, 'ETIMEDOUT');
});

/** Whether `pid` is running; a killed process that no init reaps stays a zombie, which counts as dead. */
async function waitDead(pid, tries = 100) {
  const running = () => {
    try { process.kill(pid, 0); } catch { return false; }
    try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '')[0] !== 'Z'; } catch { return true; }
  };
  let alive = true;
  for (let i = 0; i < tries && (alive = running()); i++) await new Promise(done => setTimeout(done, 20));
  return !alive;
}

test('a grandchild in its own session that holds the output pipes cannot delay the agent result', { skip: process.platform === 'win32' }, async t => {
  const root = directory(t);
  const pids = [];
  t.after(() => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
  const script = (marker, tail) => `const { spawn } = require('node:child_process'); const c = spawn('sleep', ['6'], { detached: true, stdio: 'inherit' }); require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(c.pid)); c.unref(); ${tail}`;
  // The agent hangs: the timeout kills its group, and the detached sleep still holding stdout cannot hold the result.
  const hangMarker = path.join(root, 'hang.pid');
  let started = Date.now();
  const hung = await runAgentProcess(process.execPath, ['-e', script(hangMarker, 'setInterval(() => {}, 1000);')], { cwd: root, env: process.env, timeoutMs: 1000, closeGraceMs: 300 });
  pids.push(Number(fs.readFileSync(hangMarker, 'utf8')));
  assert.equal(hung.error?.code, 'ETIMEDOUT');
  assert.ok(Date.now() - started < 3000, `resolved after ${Date.now() - started} ms`);
  // The agent exits 0 at once while the detached sleep holds the pipe: the result arrives promptly, with its output.
  const exitMarker = path.join(root, 'exit.pid');
  started = Date.now();
  const done = await runAgentProcess(process.execPath, ['-e', script(exitMarker, `process.stdout.write('{"ok":true}');`)], { cwd: root, env: process.env, timeoutMs: 20_000, closeGraceMs: 300 });
  pids.push(Number(fs.readFileSync(exitMarker, 'utf8')));
  assert.equal(done.status, 0);
  assert.equal(done.error, null);
  assert.deepEqual(JSON.parse(done.stdout), { ok: true });
  assert.ok(Date.now() - started < 3000, `resolved after ${Date.now() - started} ms`);
});

test('agent output limits count bytes, not characters, and cut the output at the limit', { skip: process.platform === 'win32' }, async t => {
  const root = directory(t);
  // 600 three-byte characters are 1800 bytes: over a 1000-byte limit, though only 600 characters long.
  const result = await runAgentProcess(process.execPath, ['-e', `process.stdout.write('\\u20ac'.repeat(600)); setInterval(() => {}, 1000);`], { cwd: root, env: process.env, timeoutMs: 10_000, maxBuffer: 1000 });
  assert.equal(result.error?.code, 'ENOBUFS');
  assert.equal(result.status, null, 'an errored run reports no exit status');
  // 333 whole characters fit in 1000 bytes; the last byte is a cut character.
  assert.ok(result.stdout.startsWith('\u20ac'.repeat(333)));
  assert.ok(result.stdout.length <= 334, `kept ${result.stdout.length} characters`);
  const slow = await runAgentProcess(process.execPath, ['-e', 'process.exitCode = 3; setInterval(() => {}, 1000)'], { cwd: root, env: process.env, timeoutMs: 200 });
  assert.equal(slow.error?.code, 'ETIMEDOUT');
  assert.equal(slow.status, null);
});

test('SIGTERM to the runner kills the detached agent process group', { skip: process.platform === 'win32' && 'POSIX signals' }, async t => {
  const root = directory(t);
  const marker = path.join(root, 'agent.pid');
  const script = path.join(root, 'runner.mjs');
  const study = pathToFileURL(path.join(packageRoot, 'eval/memory/study.mjs')).href;
  const agent = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
  fs.writeFileSync(script, `import { CATALOG, runAgentProcess, runStudy } from ${JSON.stringify(study)};
await runStudy({ root: ${JSON.stringify(path.join(root, 'out'))}, catalog: { ...CATALOG, series: [CATALOG.series[0]] }, arms: ['stateless'], repeats: 1, host: 'scripted-test', studyBase: ${JSON.stringify(root)},
  execute: async fixture => { if (fixture.index === 0) return { status: 'ok' }; process.stdout.write('READY\\n'); await runAgentProcess(process.execPath, ['-e', ${JSON.stringify(agent)}], { cwd: fixture.workspace, env: process.env, timeoutMs: 60_000 }); } });
`);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('READY')) resolve(); });
    child.on('exit', code => reject(new Error(`exited early: ${code}`)));
  });
  for (let i = 0; i < 250 && !fs.existsSync(marker); i++) await new Promise(done => setTimeout(done, 20));
  const pid = Number(fs.readFileSync(marker, 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  child.kill('SIGTERM');
  assert.equal(await exited, 143);
  assert.equal(await waitDead(pid), true, 'the agent was killed with the runner');
});

test('a stateless agent that turns knowledge on, compounds an insight and turns it off leaves nothing later tasks recall', async t => {
  const insight = 'Stateless leak probe: zebra quartz lantern ordering';
  const recalled = {};
  const recallFor = ({ workspace, copilotHome, harnessHome }) => runOrient({ workspace, copilotHome, flags: { home: harnessHome, harnessHome, dryRun: true }, query: insight, files: [] }).recall;
  const executor = scriptedExecutor([], {
    'stateless:0': fixture => {
      const { workspace, copilotHome, harnessHome } = fixture;
      assert.equal(writeStoreConfig(workspace, { home: harnessHome, mode: 'on' }).pass, true);
      const captured = runInsightCompound({ workspace, copilotHome, home: harnessHome, flags: { title: insight, body: `${insight}. Sort before you deduplicate.` } });
      assert.equal(captured.pass, true, captured.blockedReason);
      assert.equal(writeStoreConfig(workspace, { home: harnessHome, mode: 'off' }).pass, true);
      recalled[0] = recallFor(fixture);
    },
  });
  const result = await runStudy({ root: path.join(directory(t), 'out'), catalog: { ...CATALOG, series: [ordering] }, arms: ['stateless'], repeats: 1,
    model: 'scripted-test', host: 'scripted-test', studyBase: directory(t),
    execute: async fixture => {
      if (fixture.index > 0) recalled[fixture.index] = recallFor(fixture);
      return executor(fixture);
    } });
  assert.ok(recalled[0].length > 0, 'the insight is recallable in the task that wrote it');
  for (const index of [1, 2, 3]) assert.deepEqual(recalled[index], [], `task ${index + 1} recalls nothing`);
  for (const row of rowsFor(result, 'stateless')) { assert.equal(row.valid, true); assert.deepEqual(row.carriedMemoryRefused, []); }
});

test('an agent that swaps the store directory for a symlink invalidates later attempts without aborting the study', async t => {
  const outside = directory(t);
  const swap = ({ workspace, harnessHome, arm }) => {
    const dir = storeDir(workspace, { home: harnessHome });
    const moved = path.join(outside, arm.id);
    fs.cpSync(dir, moved, { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.symlinkSync(moved, dir, process.platform === 'win32' ? 'junction' : 'dir');
  };
  const executor = scriptedExecutor([], { 'recall:0': swap, 'stateless:0': swap });
  const result = await runStudy({ root: path.join(directory(t), 'out'), catalog: { ...CATALOG, series: [ordering] }, arms: ['recall', 'stateless'], repeats: 1,
    model: 'scripted-test', host: 'scripted-test', studyBase: directory(t), execute: executor });
  assert.ok(result.summary, 'the study completes with a summary');
  const recall = rowsFor(result, 'recall');
  assert.equal(recall.length, 4);
  // The recall arm reads what task 1 captured: the symlinked store is refused, so the memory chain is broken for the rest
  // of the run and no agent runs on it. The link itself is never followed into the fresh homes.
  for (const row of recall.slice(1)) {
    assert.equal(row.valid, false);
    assert.ok(row.invalidReasons.includes('carried-memory-refused'), row.invalidReasons.join(','));
    assert.equal(row.kind, 'setup-error');
    assert.match(row.carriedMemoryRefused[0], /^knowledge: .* is a symlink or special file$/);
    assert.equal(row.status, null);
  }
  // The stateless arm copies task 1's memory as configured before its agent ran, so later tasks stay valid.
  const stateless = rowsFor(result, 'stateless');
  assert.equal(stateless.length, 4);
  for (const row of stateless.slice(1)) { assert.equal(row.valid, true, row.invalidReasons.join(',')); assert.deepEqual(row.setupErrors, []); }
});

test('episode hashes count .md, .MD and .markdown notes', t => {
  const root = directory(t);
  const workspace = path.join(root, 'workspace'), projectDir = path.join(root, 'project');
  fs.mkdirSync(path.join(workspace, PROTOCOL.carryForward), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'docs', 'solutions'), { recursive: true });
  for (const name of ['a.md', 'b.MD', 'c.markdown', 'd.Markdown', 'e.txt']) fs.writeFileSync(path.join(workspace, PROTOCOL.carryForward, name), name);
  assert.deepEqual(Object.keys(episodeHashes(workspace, projectDir)).sort(), ['workspace:a.md', 'workspace:b.MD', 'workspace:c.markdown', 'workspace:d.Markdown']);
});

test('stale study parents from dead runners are swept; live, foreign and unremovable ones are kept', t => {
  const base = directory(t);
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  const stale = fs.mkdtempSync(path.join(base, `aem-study-${dead}-`));
  const live = fs.mkdtempSync(path.join(base, `aem-study-${process.pid}-`));
  const unnamed = fs.mkdtempSync(path.join(base, 'aem-study-'));
  const legacy = fs.mkdtempSync(path.join(base, 'aem-study-'));
  fs.writeFileSync(path.join(legacy, 'owner.pid'), String(dead));
  const emptyOwner = fs.mkdtempSync(path.join(base, 'aem-study-'));
  fs.writeFileSync(path.join(emptyOwner, 'owner.pid'), '');
  const zeroOwner = fs.mkdtempSync(path.join(base, 'aem-study-'));
  fs.writeFileSync(path.join(zeroOwner, 'owner.pid'), '0\n');
  fs.writeFileSync(path.join(stale, 'leftover'), 'x');
  const swept = sweepStaleStudies(base);
  assert.deepEqual(swept.sort(), [stale, legacy].sort(), 'an earlier-format parent is swept when its owner.pid is dead');
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(live), true);
  assert.equal(fs.existsSync(unnamed), true, 'a folder without an owner PID in its name is never swept');
  assert.equal(fs.existsSync(emptyOwner), true, 'an empty owner.pid is malformed, not a dead owner');
  assert.equal(fs.existsSync(zeroOwner), true, 'PID 0 is not a valid owner');
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

for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129], ['SIGQUIT', 131]]) test(`${signal} during a run removes the agent-facing temporary root`, { skip: process.platform === 'win32' && 'POSIX signals' }, async t => {
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
  const parent = path.dirname(path.dirname(path.dirname(trial)));
  assert.ok(fs.existsSync(parent));
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.kill(signal);
  assert.equal((await exited).code, code);
  assert.equal(fs.existsSync(parent), false, 'the study parent and its run root are gone');
  // The finished first attempt survives the signal, marked partial.
  const results = JSON.parse(fs.readFileSync(path.join(root, 'out', 'results.json'), 'utf8'));
  assert.equal(results.partial, true);
  assert.deepEqual(results.attempts.map(row => row.taskIndex), [1]);
  assert.ok(fs.existsSync(path.join(root, 'out', 'attempts', results.attempts[0].run)));
});

test('a study parent removal failure on a signal is recorded in the partial results', { skip: process.platform === 'win32' && 'POSIX signals' }, async t => {
  const root = directory(t);
  const base = path.join(root, 'base');
  fs.mkdirSync(base);
  const script = path.join(root, 'hang.mjs');
  const study = pathToFileURL(path.join(packageRoot, 'eval/memory/study.mjs')).href;
  // The study parent cannot be removed (EBUSY on Windows, for example); the signal-time partial write must say so.
  fs.writeFileSync(script, `import fs from 'node:fs';
import path from 'node:path';
import { CATALOG, runStudy } from ${JSON.stringify(study)};
const realRm = fs.rmSync;
fs.rmSync = function (target, ...rest) {
  if (path.basename(String(target)).startsWith('aem-study-')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  return realRm.call(this, target, ...rest);
};
await runStudy({ root: ${JSON.stringify(path.join(root, 'out'))}, catalog: { ...CATALOG, series: [CATALOG.series[0]] }, arms: ['stateless'], repeats: 1, host: 'scripted-test', studyBase: ${JSON.stringify(base)},
  execute: async fixture => { if (fixture.index === 0) return { status: 'ok' }; setInterval(() => {}, 1000); process.stdout.write('READY\\n'); await new Promise(() => {}); } });
`);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('READY\n')) resolve(); });
    child.on('exit', code => reject(new Error(`exited early: ${code}`)));
  });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  assert.equal((await exited).code, 143);
  const results = JSON.parse(fs.readFileSync(path.join(root, 'out', 'results.json'), 'utf8'));
  assert.equal(results.partial, true);
  assert.deepEqual(results.cleanupErrors.map(row => [path.basename(row.path).slice(0, 10), row.code]), [['aem-study-', 'EBUSY']]);
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

test('an origin rewrite the runner cannot undo invalidates its attempt, and a planted plans link does not reach the next task', async t => {
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
    // A planted symlink for the project's plans folder stays in the abandoned home; the next task's home is fresh.
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
  assert.equal(fourth.valid, true, fourth.invalidReasons.join(','));
  assert.deepEqual(fourth.externalPlansRefused, []);
  assert.equal(fs.readFileSync(path.join(victim, 'keep.md'), 'utf8'), 'outside\n', 'removing the old root never follows the link');
});

test('a workspace the agent filled past the snapshot limit fails scope but stays valid and scored; node_modules is one changed entry', async t => {
  const fill = (workspace, dir) => {
    fs.mkdirSync(path.join(workspace, dir), { recursive: true });
    for (let i = 0; i < 1005; i++) fs.writeFileSync(path.join(workspace, dir, `f${i}.js`), '');
  };
  const hooks = {
    // As after `npm install`: the tree is excluded from the snapshot and reported as one unexpected change.
    'stateless:1': ({ workspace }) => fill(workspace, 'node_modules/pkg'),
    // Anywhere else, the snapshot limit is a scope failure: the recurrence attempt stays valid and its trap is still scored.
    'stateless:2': ({ workspace }) => fill(workspace, 'vendor'),
  };
  const result = await runStudy({ root: path.join(directory(t), 'out'), catalog: { ...CATALOG, series: [orders] }, arms: ['stateless'], repeats: 1, model: 'scripted-test', host: 'scripted-test', studyBase: directory(t), execute: scriptedExecutor([], hooks) });
  assert.ok(result.summary, 'the study completes with a summary');
  const [, second, third, fourth] = rowsFor(result, 'stateless');
  assert.equal(second.valid, true, second.invalidReasons.join(','));
  assert.deepEqual(second.scope.unexpected, ['node_modules/']);
  assert.equal(second.pass, false);
  assert.equal(third.trapRole, 'recurrence');
  assert.equal(third.valid, true, third.invalidReasons.join(','));
  assert.deepEqual(third.measurementErrors, []);
  assert.equal(third.scope.pass, false);
  assert.deepEqual(third.scope.unexpected, [SNAPSHOT_LIMIT_EXCEEDED]);
  assert.equal(third.trapRecurred, true, 'the recurrence is still scored');
  assert.equal(third.pass, false);
  assert.equal(fourth.valid, true);
  assert.equal(result.summary.arms.stateless.recurrenceAttempts, 1);
});

test('removal failures and a read-only workspace directory are recorded on the run and never abort the study', async t => {
  const realRm = fs.rmSync;
  // Root ignores directory modes, so a stub stands in for an unremovable run root (EBUSY on Windows, for example).
  t.mock.method(fs, 'rmSync', function (target, ...rest) {
    if (/^run-/.test(path.basename(String(target)))) throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${target}'`), { code: 'EBUSY' });
    return realRm.call(this, target, ...rest);
  });
  const hooks = { 'stateless:0': ({ workspace }) => fs.chmodSync(path.join(workspace, 'src'), 0o555) };
  let result;
  try {
    result = await runStudy({ root: path.join(directory(t), 'out'), catalog: { ...CATALOG, series: [orders] }, arms: ['stateless'], repeats: 1, model: 'scripted-test', host: 'scripted-test', studyBase: directory(t), execute: scriptedExecutor([], hooks) });
  } finally { t.mock.restoreAll(); }
  assert.ok(result.summary, 'the study completes with a summary');
  assert.equal(result.attempts.length, 4);
  for (const row of result.attempts) assert.equal(row.valid, true, row.invalidReasons.join(','));
  const [run] = result.runs;
  assert.deepEqual(run.cleanupErrors.map(row => [path.basename(row.path).slice(0, 4), row.code]), [['run-', 'EBUSY']], 'only the stubbed run root failed; the read-only task root was removed');
  assert.deepEqual(result.cleanupErrors, [], 'the study parent removal took the run root with it');
});

test('a daemon an earlier task left is killed before the next task, and a passing later baseline is an invalid attempt', async t => {
  // Task 2's checkout already holds its reference solution, as a daemon tampering with it would leave it.
  const tampered = structuredClone(orders);
  tampered.tasks[1].files = { ...tampered.tasks[1].files, ...tampered.tasks[1].reference };
  let daemon = null;
  t.after(() => { try { if (daemon) process.kill(daemon, 'SIGKILL'); } catch { /* gone */ } });
  const hooks = {
    'stateless:0': ({ workspace }) => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: workspace, detached: true, stdio: 'ignore' });
      child.unref();
      daemon = child.pid;
    },
  };
  const result = await runStudy({ root: path.join(directory(t), 'out'), catalog: { ...CATALOG, series: [tampered] }, arms: ['stateless'], repeats: 1, model: 'scripted-test', host: 'scripted-test', studyBase: directory(t), execute: scriptedExecutor([], hooks) });
  assert.ok(result.summary, 'the study completes with a summary');
  const [first, second, third, fourth] = rowsFor(result, 'stateless');
  assert.equal(first.valid, true);
  assert.equal(second.valid, false);
  assert.deepEqual(second.invalidReasons, ['invalid-baseline']);
  assert.equal(second.kind, 'setup-error');
  assert.equal(second.status, null, 'no agent runs on a task whose baseline already passes');
  assert.equal(third.valid, true, third.invalidReasons.join(','));
  assert.equal(fourth.valid, true, fourth.invalidReasons.join(','));
  if (process.platform === 'linux') {
    assert.equal(second.stragglersKilled, 1, 'the daemon working in task 1\'s root was killed before task 2');
    assert.equal(await waitDead(daemon), true);
    assert.equal(third.stragglersKilled, 0);
  }
});

test('a malformed storage alias an agent plants stays in its own task; later tasks resolve the series identity', async t => {
  const hooks = {
    'recall:0': ({ workspace, harnessHome }) => {
      const id = storeDir(workspace, { home: harnessHome }).split(path.sep).at(-1);
      fs.mkdirSync(path.join(harnessHome, 'storage-aliases'), { recursive: true });
      fs.writeFileSync(path.join(harnessHome, 'storage-aliases', `${id}.json`), 'not json');
    },
  };
  const result = await runStudy({ root: path.join(directory(t), 'out'), catalog: { ...CATALOG, series: [ordering] }, arms: ['recall'], repeats: 1, model: 'scripted-test', host: 'scripted-test', studyBase: directory(t), execute: scriptedExecutor([], hooks) });
  assert.ok(result.summary, 'the study completes with a summary');
  const rows = rowsFor(result, 'recall');
  assert.equal(rows.length, 4);
  for (const row of rows.slice(1)) {
    assert.equal(row.valid, true, row.invalidReasons.join(','));
    assert.deepEqual(row.setupErrors, []);
    assert.equal(row.repoId, rows[0].repoId);
  }
  assert.ok(rows[2].learningsInjected.includes(LEARNING_ID), 'the task 1 learning still reaches the recurrence task');
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
