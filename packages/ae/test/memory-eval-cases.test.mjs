import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { checkCases, checkCasesIsolated } from '../eval/context/check.mjs';
import { CATALOG, memoryPrompt, seriesOrigin, seriesState, validateCatalog } from '../eval/memory/study.mjs';
import { applyOps } from '../lib/knowledge/apply.mjs';
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
      const otherChecks = task.checks.filter(check => !check.trap);
      assert.equal(await passes(baseline, trapChecks), false, `${label} trap check fails at baseline`);
      assert.ok(task.naive, `${label} declares the obvious implementation`);
      assert.ok(task.idioms?.length, `${label} declares alternative idioms that must also be trapped`);
      for (const [n, variant] of [task.naive, ...task.idioms].entries()) {
        const name = n === 0 ? 'naive' : `idiom ${n}`;
        const trapped = materialize(root, { ...state, ...variant });
        assert.equal(await passes(trapped, task.publicChecks), true, `${label} ${name}: the public verifier cannot see the trap`);
        assert.equal(await passes(trapped, otherChecks), true, `${label} ${name}: only the trap check separates it from the reference`);
        assert.equal(await passes(trapped, trapChecks), false, `${label} ${name} is trapped`);
      }
    }
  }
});

test('each checkout merges earlier non-trap tasks and keeps earlier trap tasks as stubs', () => {
  for (const series of CATALOG.series) {
    const state = seriesState(series, 2);
    for (const earlier of series.tasks.slice(0, 2)) {
      const expected = earlier.trap ? earlier.files : earlier.reference;
      for (const [file, content] of Object.entries(expected)) assert.equal(state[file], content, `${series.id}: ${file}`);
    }
    for (const [file, content] of Object.entries(series.tasks[2].files)) assert.equal(state[file], content);
  }
});

test('each seed is the top learning for its own recurrence task when all seeds share one store', async t => {
  const root = directory(t);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Memory Eval', GIT_AUTHOR_EMAIL: 'memory@example.test', GIT_COMMITTER_NAME: 'Memory Eval', GIT_COMMITTER_EMAIL: 'memory@example.test' };
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const episodes = Object.fromEntries(CATALOG.series.map(series => [series.seed.episode.path, series.seed.episode.content]));
  const workspace = materialize(root, { 'README.md': '# shared\n', ...episodes });
  for (const args of [['init', '-q'], ['add', '.'], ['commit', '-qm', 'seeds'], ['remote', 'add', 'origin', seriesOrigin('all-seeds')]]) execFileSync('git', args, { cwd: workspace, env, stdio: 'pipe' });
  assert.equal(writeStoreConfig(workspace, { home, mode: 'on' }).pass, true);
  const ops = CATALOG.series.map(series => ({ op: 'ADD', ...series.seed.op,
    episodes: [{ path: series.seed.episode.path, sha256: crypto.createHash('sha256').update(series.seed.episode.content).digest('hex'), kind: 'fix', plan: null }] }));
  assert.equal(applyOps({ workspace, home, operations: { schema: 1, ops } }).applied.length, CATALOG.series.length);
  for (const series of CATALOG.series) {
    const recurrence = series.tasks.find(task => task.trap === 'recurrence');
    const ranked = rankLearnings({ workspace, home, query: memoryPrompt(recurrence), signals: recurrence.seeds, limit: CATALOG.series.length });
    assert.equal(ranked[0]?.id, `${series.seed.op.domain}/${series.seed.op.slug}`, `${series.id}: its own seed outranks the other series' seeds`);
    if (ranked[1]) assert.ok(ranked[0].score > ranked[1].score, `${series.id}: the lead is not a tie`);
  }
});

function runChecker(t, source, checks, header = '') {
  const root = directory(t);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src/value.mjs'), source);
  const challenge = crypto.randomBytes(16).toString('hex');
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, '../eval/context/check.mjs'), workspace], { input: `${challenge}${header}\n${JSON.stringify({ checks })}`, encoding: 'utf8', timeout: 40000 });
  const verdicts = checks.map((_, index) => result.stdout.includes(`harness-context-check-v1:${challenge}:${index}:pass`) ? true : result.stdout.includes(`harness-context-check-v1:${challenge}:${index}:fail`) ? false : null);
  return { ...result, verdicts, completed: result.stdout.includes(`harness-context-checked-v1:${challenge}:${checks.length}`) };
}

test('the private checker passes honest code and fails wrong values', t => {
  const checks = [{ module: 'src/value.mjs', export: 'value', expected: 2 }, { module: 'src/value.mjs', export: 'fail', args: [], throws: 'boom' }, { module: 'src/value.mjs', export: 'gone', absent: true }];
  const honest = runChecker(t, "export const value = 2;\nexport function fail() { throw new Error('a boom here'); }\n", checks);
  assert.equal(honest.status, 0, honest.stderr);
  assert.equal(honest.completed, true);
  const wrong = runChecker(t, "export const value = 3;\nexport function fail() { throw new Error('a boom here'); }\n", checks);
  assert.notEqual(wrong.status, 0);
  assert.equal(wrong.completed, false);
});

test('checked code cannot read expectations from any command line or forge a throws check', t => {
  const checks = [{ module: 'src/value.mjs', export: 'value', args: [], expected: { secret: 41 } }, { module: 'src/value.mjs', export: 'fail', args: [], throws: 'specific message' }];
  const source = `import fs from 'node:fs';
String.prototype.includes = () => true;
function find() {
  const lines = [process.argv, ...[process.ppid].map(pid => { try { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\\0'); } catch { return []; } })].flat();
  for (const item of lines) { try { const parsed = JSON.parse(fs.readFileSync(item, 'utf8')); if (parsed.checks) return parsed.checks[0].expected; } catch {} }
  return null;
}
export function value() { return find(); }
export function fail() { throw new Error('other'); }
`;
  const result = runChecker(t, source, checks);
  assert.notEqual(result.status, 0);
  assert.equal(result.completed, false);
});

test('checked code cannot forge the probe report by wrapping output functions', t => {
  const checks = [
    { module: 'src/value.mjs', export: 'gone', absent: true },
    { module: 'src/value.mjs', export: 'load', args: [], synchronous: true, expected: 1 },
    { module: 'src/value.mjs', export: 'fail', args: [], throws: 'boom' },
    { module: 'src/value.mjs', export: 'point', args: [], expected: { x: 1 } },
    { module: 'src/missing.mjs', export: 'any', args: [], throws: 'Cannot find' },
  ];
  // Every report path the old probe used is wrapped to flip the flags the parent judges on, and an Object.prototype.toJSON
  // rewrites any ordinary result object before it is encoded.
  const source = `import fs from 'node:fs';
const flip = text => typeof text === 'string' ? text.replace('"present":true', '"present":false').replace('"thenable":true', '"thenable":false').replace('"kind":"import-failed"', '"kind":"threw"') : text;
const stringify = JSON.stringify; JSON.stringify = (...args) => flip(stringify(...args));
const from = Buffer.from; Buffer.from = (value, ...rest) => from(flip(value), ...rest);
const writeSync = fs.writeSync; fs.writeSync = (fd, data, ...rest) => writeSync(fd, flip(String(data)), ...rest);
const write = process.stdout.write.bind(process.stdout); process.stdout.write = (data, ...rest) => write(flip(String(data)), ...rest);
Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value() {
  const copy = { ...this };
  if ('present' in copy) copy.present = false;
  if ('thenable' in copy) copy.thenable = false;
  if ('plain' in copy) copy.plain = true;
  if (copy.kind === 'import-failed') { copy.kind = 'threw'; copy.error = 'Cannot find'; }
  return copy;
} });
class Point { constructor() { this.x = 1; } }
export const point = () => new Point();
export const gone = 1;
export async function load() { return 1; }
export function fail() { throw new Error('boom'); }
`;
  const result = runChecker(t, source, checks);
  assert.deepEqual(result.verdicts, [false, false, true, false, false]);
  assert.equal(result.completed, false);
});

test('a check that exits or hangs fails alone; the checks after it still get verdicts', t => {
  const checks = [
    { module: 'src/value.mjs', export: 'one', args: [], expected: 1 },
    { module: 'src/value.mjs', export: 'quit', args: [], expected: 2 },
    { module: 'src/value.mjs', export: 'three', args: [], expected: 3 },
    { module: 'src/value.mjs', export: 'hang', args: [], expected: 4 },
    { module: 'src/value.mjs', export: 'five', args: [], expected: 5 },
  ];
  const source = `export const one = () => 1;
export const quit = () => process.exit(0);
export const three = () => 3;
export const hang = () => new Promise(() => { setInterval(() => {}, 1000); });
export const five = () => 5;
`;
  const started = Date.now();
  const result = runChecker(t, source, checks, ' 25000 2000');
  assert.deepEqual(result.verdicts, [true, false, true, false, true]);
  assert.equal(result.completed, false);
  assert.ok(Date.now() - started < 20000, 'the idle limit, not the whole budget, ends a hung check');
  // A budget that runs out fails the checks it never reached instead of leaving them unreported. No check has to pass
  // inside this short budget, so a loaded machine cannot turn it into a false failure.
  const short = runChecker(t, source, checks.slice(3), ' 3000 5000');
  assert.deepEqual(short.verdicts, [false, false]);
});

test('the private judge is as strict as checkCases about prototypes and about throws', async t => {
  const root = directory(t);
  const workspace = materialize(root, { 'src/value.mjs': `class Point { constructor() { this.x = 1; } }
export const point = () => new Point();
export const plain = () => ({ x: 1, list: [1, 2] });
export const bare = () => Object.assign(Object.create(null), { x: 1 });
export const tagged = () => ({ x: 1, [Symbol('tag')]: 2 });
export const wrongInput = () => 'not thrown: boom';
` });
  const checks = [
    { module: 'src/value.mjs', export: 'point', args: [], expected: { x: 1 } },
    { module: 'src/value.mjs', export: 'plain', args: [], expected: { x: 1, list: [1, 2] } },
    { module: 'src/value.mjs', export: 'bare', args: [], expected: { x: 1 } },
    { module: 'src/value.mjs', export: 'tagged', args: [], expected: { x: 1 } },
    { module: 'src/missing.mjs', export: 'any', args: [], throws: 'Cannot find' },
  ];
  const { verdicts } = await checkCasesIsolated(workspace, checks);
  assert.deepEqual(verdicts, [false, true, false, false, false], 'an import failure never satisfies a throws check');
  for (const [index, check] of checks.slice(0, 4).entries()) assert.equal(await passes(workspace, [check]), verdicts[index], `checkCases agrees on ${check.export}`);
});

test('the isolated checker agrees with checkCases on every reference and trap variant of one series per split', async t => {
  const root = directory(t);
  for (const series of [CATALOG.series.find(item => item.split === 'development'), CATALOG.series.find(item => item.split === 'held-out')]) {
    const task = series.tasks[0];
    const state = seriesState(series, 0);
    const reference = await checkCasesIsolated(materialize(root, { ...state, ...task.reference }), task.checks);
    assert.ok(reference.verdicts.every(Boolean), `${series.id} reference passes in isolation: ${reference.messages.filter(Boolean).join('; ')}`);
    const naive = await checkCasesIsolated(materialize(root, { ...state, ...task.naive }), task.checks);
    assert.deepEqual(naive.verdicts, task.checks.map(check => !check.trap), `${series.id} naive fails exactly the trap checks`);
    const baseline = await checkCasesIsolated(materialize(root, state), task.checks);
    assert.equal(baseline.verdicts.every(Boolean), false);
  }
});

test('the catalog rejects public checks the public verifier cannot express safely', () => {
  for (const extra of [{ throws: 'x' }, { absent: true }, { synchronous: true }]) {
    const series = CATALOG.series[0];
    const tasks = series.tasks.map((task, index) => index === 0 ? { ...task, publicChecks: [{ ...task.publicChecks[0], ...extra }] } : task);
    assert.throws(() => validateCatalog({ ...CATALOG, series: [{ ...series, tasks }, ...CATALOG.series.slice(1)] }), /plain value checks/);
  }
});

test('a checked module cannot disable the private checker by replacing assert methods', t => {
  const root = directory(t);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src/value.mjs'), "import assert from 'node:assert/strict';\nassert.deepEqual = () => {};\nassert.equal = () => {};\nassert.rejects = async () => {};\nexport const value = 1;\n");
  const challenge = crypto.randomBytes(16).toString('hex');
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, '../eval/context/check.mjs'), workspace], { input: `${challenge}\n${JSON.stringify({ checks: [{ module: 'src/value.mjs', export: 'value', expected: 2 }] })}`, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, new RegExp(`harness-context-checked-v1:${challenge}`));
  assert.match(result.stdout, new RegExp(`harness-context-check-v1:${challenge}:0:fail`));
});
