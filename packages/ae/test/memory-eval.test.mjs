import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import {
  CATALOG, PROTOCOL, armById, baselineChain, compareArms, resolveStudyOutput, runStudy, runnableArms, scorePromotion, seriesOrigin, validateProtocol,
} from '../eval/memory/study.mjs';
import { applyOps } from '../lib/knowledge/apply.mjs';

const packageRoot = path.resolve(import.meta.dirname, '..');
const LEARNING_ID = 'javascript/eval-scripted-trap';
const [ordering, orders] = CATALOG.series;

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

/**
 * Scripted agent: task 1 falls into the trap and records an episode plus a learning (refused unless knowledge mode is on);
 * a recurrence task avoids the trap only when a learning was injected; other tasks are solved.
 */
function scriptedExecutor(calls) {
  return async ({ workspace, harnessHome, task, series, injection, arm }) => {
    calls.push({ series: series.id, arm: arm.id, task: task.id, harnessHome, injected: injection.learnings });
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
      write(workspace, injection.learnings.length ? task.reference : task.naive);
    } else {
      write(workspace, task.reference);
    }
    return { status: 'ok', provider: 'scripted', model: 'scripted-test', turnCount: 2,
      contextAccounting: [{ boundary: 'headless-request', model: 'scripted-test', modelUsage: { measurement: 'observed', inputTokens: 100, outputTokens: 10 } }] };
  };
}

const ARMS = ['stateless', 'capture-only', 'recall'];
const RUNNABLE = ['stateless', 'capture-only', 'recall', 'recall+feedback', 'frozen-seed'];
let mainRun = null;
function main(t) {
  mainRun ||= (async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-study-main-'));
    const calls = [];
    const result = await runStudy({ root, catalog: { ...CATALOG, series: [ordering] }, arms: ARMS, repeats: 1, model: 'scripted-test', host: 'scripted-test', execute: scriptedExecutor(calls) });
    return { root, calls, result };
  })();
  return mainRun;
}
after(async () => { if (mainRun) fs.rmSync((await mainRun).root, { recursive: true, force: true }); });
const rowsFor = (result, arm) => result.attempts.filter(row => row.arm === arm).sort((a, b) => a.taskIndex - b.taskIndex);

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
      originFor: (series, index) => index === 2 ? 'https://eval.invalid/ae-memory/elsewhere.git' : seriesOrigin(series.id),
      execute: async fixture => {
        const outcome = await executor(fixture);
        if (fixture.index === 1) fs.writeFileSync(path.join(fixture.workspace, 'docs/solutions/eval/second.md'), 'A second episode.\n');
        if (fixture.index === 3) spawnSync('git', ['remote', 'set-url', 'origin', 'https://eval.invalid/other.git'], { cwd: fixture.workspace });
        return outcome;
      } });
    return { root, result };
  })();
  return driftRun;
}
after(async () => {
  for (const run of [dryRunResult, driftRun]) if (run) fs.rmSync((await run).root, { recursive: true, force: true });
});

test('arms set their knowledge mode and feedback state in their own home', async t => {
  const { result } = await main(t);
  const { result: dryResult } = await dry();
  const expected = { stateless: ['off', 'off', result], 'capture-only': ['capture-only', 'off', result], recall: ['on', 'off', result], 'recall+feedback': ['on', 'on', dryResult], 'frozen-seed': ['freeze', 'off', dryResult] };
  for (const [arm, [mode, feedback, source]] of Object.entries(expected)) {
    const rows = rowsFor(source, arm);
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.knowledgeMode, mode, `${arm} mode`);
      assert.equal(row.knowledgeModeAfter, mode);
      assert.equal(row.feedback, feedback, `${arm} feedback`);
      assert.equal(row.valid, true);
    }
  }
  assert.equal(rowsFor(dryResult, 'frozen-seed')[0].seeded, `${orders.seed.op.domain}/${orders.seed.op.slug}`);
  assert.ok(rowsFor(result, 'recall').every(row => row.kind === 'scripted'));
});

test('the harness home persists across a series and is isolated between arms and repeats', async t => {
  const { result, calls } = await main(t);
  const homes = new Set();
  for (const arm of ARMS) {
    const armCalls = calls.filter(call => call.arm === arm);
    assert.equal(armCalls.length, 4);
    assert.equal(new Set(armCalls.map(call => call.harnessHome)).size, 1, `${arm} keeps one home across its tasks`);
    homes.add(armCalls[0].harnessHome);
    assert.equal(new Set(rowsFor(result, arm).map(row => row.storeDir)).size, 1);
  }
  assert.equal(homes.size, ARMS.length, 'every arm has its own home');
  assert.ok(storedLearnings(rowsFor(result, 'recall')[0].storeDir).includes('eval-scripted-trap'), 'recall store kept the task 1 learning');
  for (const arm of ['stateless', 'capture-only']) assert.deepEqual(storedLearnings(rowsFor(result, arm)[0].storeDir), [], `${arm} store refused the write`);
  const { result: repeated } = await drift();
  const repeatHomes = repeated.runs.map(run => run.harnessHome);
  assert.equal(new Set(repeatHomes).size, 2, 'repeats get separate homes');
  const validIds = new Set(repeated.attempts.filter(row => row.valid).map(row => row.repoId));
  assert.deepEqual([...validIds], [result.attempts[0].repoId], 'repeats and arms share one series identity');
});

test('every task in a series resolves the same repoId and store; different series resolve different ones', async t => {
  const { result } = await main(t);
  const ids = new Set(result.attempts.map(row => row.repoId));
  assert.equal(ids.size, 1);
  assert.match([...ids][0], /^eval\.invalid-ae-memory-catalog-ordering-/);
  for (const row of result.attempts) {
    assert.equal(row.origin.expected, seriesOrigin(ordering.id));
    assert.equal(row.origin.unchanged, true);
    assert.ok(row.storeDir.startsWith(path.join(result.runs.find(run => run.id === row.run).harnessHome, 'knowledge') + path.sep));
  }
  const { result: other } = await dry();
  const otherIds = new Set(other.attempts.map(row => row.repoId));
  assert.equal(otherIds.size, 1);
  assert.notEqual([...otherIds][0], [...ids][0]);
  assert.match([...otherIds][0], /^eval\.invalid-ae-memory-orders-csv-/);
});

test('a learning added in task 1 is injected in task 3 under recall and absent under stateless and capture-only', async t => {
  const { result } = await main(t);
  const third = arm => rowsFor(result, arm)[2];
  assert.equal(third('recall').trapRole, 'recurrence');
  assert.ok(third('recall').learningsInjected.includes(LEARNING_ID));
  assert.ok(third('recall').learningsBytes > 0);
  for (const arm of ['stateless', 'capture-only']) {
    assert.deepEqual(third(arm).learningsInjected, [], `${arm} injects nothing`);
    assert.equal(third(arm).learningsBytes, 0);
  }
  assert.deepEqual(rowsFor(result, 'recall')[0].learningsInjected, [], 'nothing to inject before task 1');
  for (const arm of ARMS) {
    const rows = rowsFor(result, arm);
    assert.equal(rows[0].episodesWritten, 1, `${arm} task 1 wrote one episode`);
    assert.deepEqual(rows[0].carriedForward, []);
    assert.ok(rows[2].carriedForward.includes(`docs/solutions/eval/${ordering.trap.id}.md`), `${arm} carried the episode forward`);
    const workspace = path.join(path.dirname(result.runs.find(run => run.id === rows[2].run).harnessHome), 'tasks', `3-${ordering.tasks[2].id}`, 'workspace');
    const tracked = spawnSync('git', ['ls-files', `docs/solutions/eval/${ordering.trap.id}.md`], { cwd: workspace, encoding: 'utf8' });
    assert.match(tracked.stdout, /docs\/solutions\/eval\//, 'carried episodes are committed in the next checkout');
  }
});

test('trap recurrence, pass, turns and usage are scored per attempt and arm', async t => {
  const { result, root } = await main(t);
  for (const arm of ARMS) {
    const [first, , recurrence, last] = rowsFor(result, arm);
    assert.equal(first.trapFirstFailed, true);
    assert.equal(first.pass, false);
    assert.equal(last.pass, true);
    assert.equal(last.trapRecurred, null);
    assert.equal(recurrence.turns, 2);
    assert.equal(recurrence.inputTokens, 100);
    assert.equal(recurrence.usageCoverage, 'complete');
    assert.equal(typeof recurrence.repeatMistake?.flagged, 'boolean');
    assert.equal(recurrence.trapRecurred, arm !== 'recall', `${arm} recurrence`);
    assert.equal(recurrence.pass, arm === 'recall');
  }
  const { arms } = result.summary;
  assert.equal(arms.stateless.recurrenceRate, 1);
  assert.equal(arms['capture-only'].recurrenceRate, 1);
  assert.equal(arms.recall.recurrenceRate, 0);
  assert.equal(arms.recall.passRate, 0.75);
  assert.equal(arms.stateless.passRate, 0.5);
  assert.equal(arms.recall.episodesPerSeries, 1);
  assert.equal(arms.recall.inputTokens, 400);
  assert.equal(result.summary.promotion.comparison, 'inconclusive', 'scripted runs never qualify');
  assert.ok(fs.existsSync(path.join(root, 'results.json')));
  assert.ok(fs.existsSync(path.join(root, 'provenance.json')));
});

test('an attempt whose repoId drifts is invalid, not failed; a changed origin fails the private check', async () => {
  const { result } = await drift();
  for (const repeat of [1, 2]) {
    const rows = rowsFor(result, 'recall').filter(row => row.repeat === repeat);
    assert.equal(rows[2].valid, false);
    assert.ok(rows[2].invalidReasons.includes('repo-identity-drift'));
    assert.equal(rows[2].pass, false);
    assert.equal(rows[2].trapRecurred, null, 'an invalid attempt is not scored as a recurrence');
    assert.deepEqual(rows[2].learningsInjected, [], 'the drifted identity saw a different store');
    assert.equal(rows[1].episodesWritten, 1);
    assert.equal(rows[1].pass, true, 'a new episode is an expected write, not a scope violation');
    assert.equal(rows[3].valid, true);
    assert.equal(rows[3].checks.pass, true);
    assert.equal(rows[3].origin.unchanged, false);
    assert.equal(rows[3].pass, false);
  }
  const stats = result.summary.arms.recall;
  assert.equal(stats.invalidAttempts, 2);
  assert.equal(stats.measuredAttempts, 6);
  assert.equal(stats.recurrenceAttempts, 0);
});

test('promotion: the 50/10/30 example is rejected against its recall baseline', () => {
  const arm = recurrenceRate => ({ heldOutAttempts: 40, passRate: 0.8, recurrenceRate, episodesPerSeries: 2, usageCoverage: 'complete' });
  const stats = { stateless: arm(0.5), recall: arm(0.1), 'recall+feedback': arm(0.3) };
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

test('promotion: thresholds, baseline failure and batch eligibility', () => {
  const arm = (recurrenceRate, over = {}) => ({ heldOutAttempts: 40, passRate: 0.8, recurrenceRate, episodesPerSeries: 2, usageCoverage: 'complete', ...over });
  assert.equal(compareArms(arm(0.35), arm(0.5)).pass, true, '30% exactly passes');
  assert.ok(compareArms(arm(0.36), arm(0.5)).reasons.includes('recurrence-reduction-below-threshold'));
  assert.equal(compareArms(arm(0.1, { passRate: 0.78 }), arm(0.5)).pass, true, '-2pp is within the margin');
  assert.ok(compareArms(arm(0.1, { passRate: 0.77 }), arm(0.5)).reasons.includes('pass-rate-regressed'));
  assert.ok(compareArms(arm(0.1, { heldOutAttempts: 29 }), arm(0.5)).reasons.includes('insufficient-held-out-attempts'));
  assert.ok(compareArms(arm(0.1, { usageCoverage: 'partial' }), arm(0.5)).reasons.includes('incomplete-observed-usage'));
  assert.ok(compareArms(arm(0.5, { episodesPerSeries: 3 }), arm(0.5)).reasons.includes('episodes-rose-without-recurrence-falling'));
  assert.ok(compareArms(arm(0, { episodesPerSeries: 3 }), arm(0.5)).pass, 'episodes may rise when recurrence falls');
  assert.ok(compareArms(arm(0), arm(0)).reasons.includes('reference-has-no-recurrence'));
  const failedBaseline = scorePromotion({ stateless: arm(0.5), recall: arm(0.45), 'recall+feedback': arm(0.1) });
  assert.equal(failedBaseline.decisions.recall.promotable, false);
  assert.equal(failedBaseline.decisions['recall+feedback'].against.recall.pass, true);
  assert.equal(failedBaseline.decisions['recall+feedback'].against.stateless.pass, true);
  assert.equal(failedBaseline.decisions['recall+feedback'].promotable, false);
  assert.ok(failedBaseline.decisions['recall+feedback'].reasons.includes('baseline-recall-not-promotable'));
  const missing = scorePromotion({ stateless: arm(0.5), 'recall+feedback': arm(0.1) });
  assert.ok(missing.decisions['recall+feedback'].reasons.includes('baseline-recall-not-in-batch'));
  const auto = scorePromotion({ stateless: arm(0.5), recall: arm(0.1) }, { eligible: false, ineligibleReason: 'automatic-model-selection' });
  assert.equal(auto.comparison, 'inconclusive');
  assert.deepEqual(auto.promotable, []);
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
  assert.ok(rowsFor(result, 'frozen-seed')[2].learningsInjected.includes(`${orders.seed.op.domain}/${orders.seed.op.slug}`));
  assert.deepEqual(rowsFor(result, 'recall+feedback')[2].learningsInjected, []);
  assert.equal(result.summary.arms['frozen-seed'].measuredAttempts, 0);
  assert.equal(result.summary.promotion.comparison, 'inconclusive');
  assert.equal(result.provenance.origin, PROTOCOL.origin);
});
