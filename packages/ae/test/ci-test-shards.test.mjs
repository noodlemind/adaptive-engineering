import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { GIT_REGRESSION_FILES, partitionTests, readManifests, readSuiteFiles, readTestFiles, runShard, verifyShardManifests } from '../../../scripts/ci-tests.mjs';
import timingReporter from '../../../scripts/ci-test-reporter.mjs';

test('the reporter retains Node20 terminal counters without accepting partial or nested summaries', async () => {
  const diagnostic = (message, extra = {}) => ({ type: 'test:diagnostic', data: { nesting: 0, message, ...extra } });
  const counters = ['tests 3', 'suites 0', 'pass 3', 'fail 0', 'cancelled 0', 'skipped 0', 'todo 0', 'duration_ms 123.45'].map(message => diagnostic(message));
  const collect = async values => {
    const result = [];
    for await (const line of timingReporter((async function* () { yield* values; })())) result.push(JSON.parse(line));
    return result;
  };
  const [summary] = await collect(counters);
  assert.equal(summary.success, true);
  assert.equal(summary.counts.tests, 3);
  assert.equal(summary.durationMs, 123.45);
  assert.deepEqual(await collect(counters.slice(0, -1)), []);
  assert.deepEqual(await collect(counters.map(event => ({ ...event, data: { ...event.data, file: '/test/child.mjs' } }))), []);
  assert.equal((await collect(counters.map(event => event.data.message === 'fail 0' ? diagnostic('fail 1') : event)))[0].success, false);
  const native = { type: 'test:summary', data: { counts: { tests: 4 }, duration_ms: 456, success: false } };
  assert.deepEqual(await collect([...counters, native]), [{ kind: 'summary', counts: { tests: 4 }, durationMs: 456, success: false }]);
});

test('weighted shards are deterministic, disjoint, complete and include unmeasured files', () => {
  const files = ['a.test.mjs', 'b.test.mjs', 'c.test.mjs', 'd.test.mjs', 'new.test.mjs'];
  const costs = { 'a.test.mjs': 90, 'b.test.mjs': 60, 'c.test.mjs': 40, 'd.test.mjs': 20 };
  const shards = partitionTests(files, costs, 2);
  assert.deepEqual(shards, partitionTests([...files].reverse(), costs, 2));
  assert.deepEqual(shards.flatMap(shard => shard.files).sort(), [...files].sort());
  assert.equal(new Set(shards.flatMap(shard => shard.files)).size, files.length);
  assert.ok(shards.every(shard => shard.files.length));
  assert.ok(Math.max(...shards.map(shard => shard.estimatedMs)) - Math.min(...shards.map(shard => shard.estimatedMs)) <= 90);
  assert.throws(() => partitionTests([...files, files[0]], costs, 2), /duplicate/i);
  assert.throws(() => partitionTests(files, { 'a.test.mjs': -1 }, 2), /cost/i);
  assert.throws(() => partitionTests(files, costs, 6), /shard/i);
});

test('the discovered source inventory is assigned exactly once across Linux and Windows shards', () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const files = readTestFiles(root);
  const costs = JSON.parse(fs.readFileSync(path.join(root, '.github/ci/windows-test-costs.json'), 'utf8')).files;
  for (const count of [4, 12]) {
    const shards = partitionTests(files, costs, count);
    assert.deepEqual(shards.flatMap(shard => shard.files).sort(), files);
  }
  assert.ok(files.includes('ci-test-shards.test.mjs'));
  assert.ok(files.includes('deterministic-delivery.test.mjs'));
});

function fixture(t, failing = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-ci-shards-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'packages/ae/test');
  fs.mkdirSync(path.join(directory, 'helpers'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'helpers/isolate-runtime-env.mjs'), '');
  fs.writeFileSync(path.join(directory, 'a.test.mjs'), "import {test} from 'node:test'; test('first', () => {});\n");
  fs.writeFileSync(path.join(directory, 'b.test.mjs'), `import {test} from 'node:test'; test('second', () => { ${failing ? "throw new Error('expected fixture failure');" : ''} });\n`);
  const env = { ...process.env, GITHUB_SHA: 'fixture-source' };
  delete env.NODE_TEST_CONTEXT;
  return { root, env };
}

test('real Node execution retains file timings and a complete same-source manifest', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'packages/ae/test/b.test.mjs'), "import {test} from 'node:test'; test('parent', async t => { await t.test('nested child', () => {}); });\n");
  const manifest = await runShard({ repoRoot: f.root, shard: 1, shards: 1, costs: {}, env: f.env });
  assert.equal(manifest.exitCode, 0);
  assert.deepEqual(manifest.files, ['a.test.mjs', 'b.test.mjs']);
  assert.deepEqual(manifest.results.map(result => result.file).sort(), manifest.files);
  assert.ok(manifest.results.every(result => result.passed && Number.isFinite(result.durationMs)));
  assert.equal(manifest.counts.tests, 3);
  assert.equal(manifest.suite, 'source');
  assert.equal(manifest.platform, process.platform);
  assert.equal(manifest.nodeMajor, Number(process.versions.node.split('.')[0]));
  assert.deepEqual(verifyShardManifests([manifest], { files: manifest.files, sourceSha: 'fixture-source', shards: 1 }), { files: 2, shards: 1 });
});

test('the Git regression suite runs its exact inventory once and binds platform and runtime', async t => {
  const f = fixture(t);
  assert.throws(() => readSuiteFiles(f.root, 'git'), /inventory|missing/i);
  for (const file of GIT_REGRESSION_FILES) fs.writeFileSync(path.join(f.root, 'packages/ae/test', file), "import {test} from 'node:test'; test('git regression fixture', () => {});\n");
  assert.deepEqual(readSuiteFiles(f.root, 'git'), [...GIT_REGRESSION_FILES].sort());
  assert.equal(readSuiteFiles(f.root, 'source').length, GIT_REGRESSION_FILES.length + 2);
  assert.throws(() => readSuiteFiles(f.root, 'unknown'), /suite/i);
  const manifests = [];
  for (const shard of [1, 2, 3]) manifests.push(await runShard({ repoRoot: f.root, suite: 'git', shard, shards: 3, costs: {}, env: f.env }));
  const expected = { files: readSuiteFiles(f.root, 'git'), sourceSha: 'fixture-source', shards: 3, suite: 'git', platform: process.platform, nodeMajor: Number(process.versions.node.split('.')[0]) };
  assert.deepEqual(verifyShardManifests(manifests, expected), { files: GIT_REGRESSION_FILES.length, shards: 3 });
  for (const patch of [{ suite: 'source' }, { platform: 'another-platform' }, { nodeMajor: 1 }]) {
    assert.throws(() => verifyShardManifests([{ ...manifests[0], ...patch }, ...manifests.slice(1)], expected), /suite|platform|runtime/i);
  }
  assert.throws(() => verifyShardManifests(manifests.slice(1), expected), /shard/i);
});

test('a failing real test preserves its nonzero exit and cannot satisfy the aggregate gate', async t => {
  const f = fixture(t, true);
  const manifest = await runShard({ repoRoot: f.root, shard: 1, shards: 1, costs: {}, env: f.env });
  assert.notEqual(manifest.exitCode, 0);
  assert.ok(manifest.results.some(result => !result.passed));
  assert.throws(() => verifyShardManifests([manifest], { files: manifest.files, sourceSha: 'fixture-source', shards: 1 }), /failed|pass/i);
});

test('downloaded artifact layout proves two real shards and refuses a missing manifest', async t => {
  const f = fixture(t);
  const artifacts = path.join(f.root, 'windows-shards');
  for (const shard of [1, 2]) {
    const manifest = await runShard({ repoRoot: f.root, shard, shards: 2, costs: {}, env: f.env });
    const directory = path.join(artifacts, `windows-tests-${shard}`, 'ci-test-results');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  }
  const expected = { files: readTestFiles(f.root), sourceSha: 'fixture-source', shards: 2 };
  assert.deepEqual(verifyShardManifests(readManifests(artifacts), expected), { files: 2, shards: 2 });
  fs.rmSync(path.join(artifacts, 'windows-tests-2/ci-test-results/manifest.json'));
  assert.throws(() => readManifests(artifacts));
});

test('inventory proof rejects missing shards, duplicate files, stale revisions and missing executions', () => {
  const files = ['a.test.mjs', 'b.test.mjs'];
  const one = (shard, file) => ({ version: 1, shard, shards: 2, sourceSha: 'current', allFiles: files, files: [file], exitCode: 0, results: [{ file, passed: true, durationMs: 1 }] });
  const manifests = [one(1, files[0]), one(2, files[1])];
  const expected = { files, sourceSha: 'current', shards: 2 };
  assert.deepEqual(verifyShardManifests(manifests, expected), { files: 2, shards: 2 });
  assert.throws(() => verifyShardManifests(manifests.slice(1), expected), /shard/i);
  assert.throws(() => verifyShardManifests([manifests[0], one(2, files[0])], expected), /inventory|duplicate/i);
  assert.throws(() => verifyShardManifests([{ ...manifests[0], sourceSha: 'old' }, manifests[1]], expected), /source|revision/i);
  assert.throws(() => verifyShardManifests([{ ...manifests[0], results: [] }, manifests[1]], expected), /execution|inventory/i);
});

test('the fast pull-request tier keeps quick and unmeasured files and leaves slow ones to the full suite', async () => {
  const { FAST_FILE_LIMIT_MS, readCosts } = await import('../../../scripts/ci-tests.mjs');
  const root = path.resolve(import.meta.dirname, '../../..');
  const all = readSuiteFiles(root, 'source');
  const fast = readSuiteFiles(root, 'fast');
  const costs = readCosts(root);
  assert.ok(fast.length > all.length / 2, 'the fast tier must still cover most files');
  assert.ok(fast.length < all.length);
  for (const file of all) {
    const quick = !Object.hasOwn(costs, file) || costs[file] <= FAST_FILE_LIMIT_MS;
    assert.equal(fast.includes(file), quick, file);
  }
  assert.ok(fast.includes('ci-test-shards.test.mjs'));
});

test('the local full-suite receipt is valid only for a passing run at a clean HEAD', async () => {
  const { checkReceipt, receiptLine } = await import('../../../scripts/full-suite.mjs');
  const head = 'abcdef0123456789abcdef0123456789abcdef01';
  const receipt = { head, dirty: false, passed: true, files: 2, tests: 10, platform: 'win32', node: '22.11.0', durationMs: 180000 };
  assert.equal(checkReceipt(receipt, { head, dirty: false }), null);
  assert.match(receiptLine(receipt), /^Full suite: PASS · 10 tests in 2 files · win32 Node 22\.11\.0 · abcdef012345 · 3 min$/);
  assert.match(checkReceipt(null, { head, dirty: false }), /no full-suite receipt/);
  assert.match(checkReceipt({ ...receipt, head: '1'.repeat(40) }, { head, dirty: false }), /receipt is for/);
  assert.match(checkReceipt({ ...receipt, dirty: true }, { head, dirty: false }), /uncommitted/);
  assert.match(checkReceipt(receipt, { head, dirty: true }), /uncommitted/);
  assert.match(checkReceipt({ ...receipt, passed: false }, { head, dirty: false }), /failed/);
  assert.match(receiptLine({ ...receipt, passed: false, dirty: true }), /^Full suite: FAIL .*\(uncommitted changes\)/);
});
