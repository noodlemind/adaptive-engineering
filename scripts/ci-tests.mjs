import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reporter = new URL('./ci-test-reporter.mjs', import.meta.url).href;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = values => [...values].sort();
export const GIT_REGRESSION_FILES = Object.freeze([
  'domain-contract.test.mjs', 'domain-context.test.mjs', 'domain-delivery.test.mjs',
  'storage-aliases.test.mjs', 'workspace-layout.test.mjs', 'migrate-layout.test.mjs',
  'package-standalone.test.mjs', 'unchanged-retry.test.mjs', 'domain-commands.test.mjs',
]);

// The pull-request tier: every file whose recorded Windows duration is at most
// this long, plus every file with no recorded duration yet (new tests always
// run). It covers about two thirds of the files in a few Linux minutes. The
// complete suite runs locally before a PR (scripts/full-suite.mjs) and in CI
// only on manual dispatch.
export const FAST_FILE_LIMIT_MS = 30_000;

export function readCosts(repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, '.github/ci/windows-test-costs.json'), 'utf8')).files;
}

export function readTestFiles(repoRoot) {
  const directory = path.join(repoRoot, 'packages/ae/test');
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.test.mjs')).sort();
  if (!files.length || files.some(name => !fs.lstatSync(path.join(directory, name)).isFile())) throw new Error('Test inventory is empty or contains a non-regular file');
  return files;
}

export function readSuiteFiles(repoRoot, suite = 'source') {
  const all = readTestFiles(repoRoot);
  if (suite === 'source') return all;
  if (suite === 'fast') {
    const costs = readCosts(repoRoot);
    return all.filter(file => !Object.hasOwn(costs, file) || costs[file] <= FAST_FILE_LIMIT_MS);
  }
  if (suite !== 'git') throw new Error('Unknown test suite');
  if (GIT_REGRESSION_FILES.some(file => !all.includes(file))) throw new Error('Git regression inventory is missing a required file');
  return sorted(GIT_REGRESSION_FILES);
}

export function partitionTests(files, costs, count) {
  if (!Number.isInteger(count) || count < 1 || count > 16 || count > files.length) throw new Error('Invalid shard count');
  if (new Set(files).size !== files.length) throw new Error('Duplicate test file');
  if (!costs || typeof costs !== 'object' || Array.isArray(costs) || Object.values(costs).some(cost => !Number.isFinite(cost) || cost < 0)) throw new Error('Invalid test cost');
  const observed = Object.values(costs).filter(cost => cost > 0).sort((a, b) => a - b);
  const fallback = observed[Math.floor(observed.length / 2)] || 1000;
  const weight = file => Math.max(1, Object.hasOwn(costs, file) ? costs[file] : fallback);
  const bins = Array.from({ length: count }, () => ({ files: [], estimatedMs: 0 }));
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const target = bins.reduce((best, bin) => bin.estimatedMs < best.estimatedMs ? bin : best);
    target.files.push(file);
    target.estimatedMs += weight(file);
  }
  return bins;
}

export function verifyShardManifests(manifests, { files, sourceSha, shards, suite, platform, nodeMajor }) {
  if (manifests.length !== shards || new Set(manifests.map(item => item.shard)).size !== shards) throw new Error('Missing or duplicate shard');
  const inventory = sorted(files), executed = [];
  for (const item of manifests) {
    if (item.version !== 1 || item.shards !== shards || !Number.isInteger(item.shard) || item.shard < 1 || item.shard > shards) throw new Error('Invalid shard manifest');
    if (item.sourceSha !== sourceSha) throw new Error('Shard source revision differs');
    if (suite !== undefined && item.suite !== suite) throw new Error('Shard test suite differs');
    if (platform !== undefined && item.platform !== platform) throw new Error('Shard platform differs');
    if (nodeMajor !== undefined && item.nodeMajor !== nodeMajor) throw new Error('Shard runtime differs');
    if (item.exitCode !== 0 || !Array.isArray(item.results) || item.results.some(result => result.passed !== true)) throw new Error('Shard did not pass');
    if (!same(item.allFiles, inventory) || !Array.isArray(item.files) || !item.files.length) throw new Error('Shard inventory differs');
    if (!same(sorted(item.results.map(result => result.file)), sorted(item.files))) throw new Error('Shard execution inventory is incomplete');
    executed.push(...item.files);
  }
  if (new Set(executed).size !== executed.length || !same(sorted(executed), inventory)) throw new Error('Aggregate inventory contains duplicate or missing files');
  return { files: files.length, shards };
}

export async function runShard({ repoRoot = repositoryRoot, shard, shards, costs, suite = 'source', env = process.env, concurrency = 2 }) {
  const allFiles = readSuiteFiles(repoRoot, suite);
  const selectedCosts = costs ?? readCosts(repoRoot);
  const groups = partitionTests(allFiles, selectedCosts, shards);
  if (!Number.isInteger(shard) || shard < 1 || shard > shards) throw new Error('Invalid shard index');
  const files = groups[shard - 1].files;
  const directory = path.join(repoRoot, 'ci-test-results');
  fs.mkdirSync(directory, { recursive: true });
  const timingFile = path.join(directory, 'timings.jsonl');
  const argv = ['--import', './test/helpers/isolate-runtime-env.mjs', '--test', `--test-concurrency=${concurrency}`,
    '--test-reporter=tap', `--test-reporter=${reporter}`, '--test-reporter-destination=stdout', `--test-reporter-destination=${timingFile}`,
    ...files.map(file => `./test/${file}`)];
  console.log(`CI ${suite} test shard ${shard}/${shards}: ${files.length}/${allFiles.length} files, estimated ${Math.round(groups[shard - 1].estimatedMs / 1000)} aggregate test-seconds`);
  const started = Date.now();
  const child = spawn(process.execPath, argv, { cwd: path.join(repoRoot, 'packages/ae'), env, stdio: 'inherit' });
  const outcome = await new Promise(resolve => {
    child.once('error', error => resolve({ code: 1, error: error.message }));
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
  const records = fs.existsSync(timingFile) ? fs.readFileSync(timingFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const results = records.filter(record => record.kind === 'file');
  const summary = records.findLast(record => record.kind === 'summary');
  let exitCode = outcome.code;
  if (exitCode === 0 && (summary?.success !== true || !same(sorted(results.map(result => result.file)), sorted(files)) || results.some(result => !result.passed))) exitCode = 1;
  const manifest = { version: 1, sourceSha: env.GITHUB_SHA || null, suite, platform: process.platform, nodeMajor: Number(process.versions.node.split('.')[0]), shard, shards, allFiles, files, results, counts: summary?.counts ?? null, durationMs: Date.now() - started, exitCode, ...(outcome.error ? { error: outcome.error } : {}) };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export function readManifests(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
    const file = path.join(directory, entry.name, 'ci-test-results/manifest.json');
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('Shard manifest is oversized');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { shard: { type: 'string' }, shards: { type: 'string', default: '4' }, suite: { type: 'string', default: 'source' }, platform: { type: 'string' }, 'node-major': { type: 'string' }, 'verify-manifests': { type: 'string' } } });
    const count = Number(values.shards);
    if (values['verify-manifests']) {
      if (values.shard) throw new Error('Cannot execute and verify shards together');
      const result = verifyShardManifests(readManifests(values['verify-manifests']), { files: readSuiteFiles(repositoryRoot, values.suite), sourceSha: process.env.GITHUB_SHA || null, shards: count, suite: values.suite, platform: values.platform, nodeMajor: values['node-major'] === undefined ? undefined : Number(values['node-major']) });
      console.log(`Verified ${result.files} test files exactly once across ${result.shards} passing shards`);
    } else {
      const result = await runShard({ shard: Number(values.shard), shards: count, suite: values.suite });
      process.exitCode = result.exitCode;
    }
  } catch (error) {
    console.error(`CI test runner: ${error.message}`);
    process.exitCode = 1;
  }
}
