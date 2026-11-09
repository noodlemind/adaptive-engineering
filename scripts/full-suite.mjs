#!/usr/bin/env node
// Runs the complete source suite on this machine and writes a receipt that a
// pull request can quote. Pull-request CI runs only the fast tier; this is
// where every test file runs before a PR is opened or updated.
//
//   node scripts/full-suite.mjs            run everything, write the receipt
//   node scripts/full-suite.mjs --check    exit 0 only if a passing receipt
//                                          matches HEAD on a clean tree (used
//                                          by the opt-in .githooks/pre-push)
//   --concurrency N                        test files run in parallel
//                                          (default: half the CPUs, at least 2)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runShard } from './ci-tests.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const receiptPath = path.join(root, 'ci-test-results', 'full-suite-receipt.json');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const workingTree = () => ({ head: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--untracked-files=no') !== '' });

export function receiptLine(receipt) {
  const verdict = receipt.passed ? 'PASS' : 'FAIL';
  const minutes = Math.max(1, Math.round(receipt.durationMs / 60000));
  const tree = receipt.dirty ? ' (uncommitted changes)' : '';
  return `Full suite: ${verdict} · ${receipt.tests ?? '?'} tests in ${receipt.files} files · ${receipt.platform} Node ${receipt.node} · ${receipt.head.slice(0, 12)}${tree} · ${minutes} min`;
}

export function checkReceipt(receipt, current) {
  if (!receipt) return 'no full-suite receipt yet';
  if (receipt.head !== current.head) return `the receipt is for ${receipt.head.slice(0, 12)}, HEAD is ${current.head.slice(0, 12)}`;
  if (receipt.dirty) return 'the receipt was recorded with uncommitted changes';
  if (current.dirty) return 'the working tree has uncommitted changes';
  if (!receipt.passed) return 'the last full-suite run at HEAD failed';
  return null;
}

async function main() {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, concurrency: { type: 'string' } } });
  if (values.check) {
    const receipt = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : null;
    const problem = checkReceipt(receipt, workingTree());
    if (problem) {
      console.error(`Full suite not proven for this push: ${problem}.`);
      console.error('Run `node scripts/full-suite.mjs`, or push with --no-verify to skip this check.');
      return 1;
    }
    console.log(receiptLine(receipt));
    return 0;
  }
  const concurrency = values.concurrency ? Number(values.concurrency) : Math.max(2, Math.floor(os.availableParallelism() / 2));
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer');
  const before = workingTree();
  const env = { ...process.env, GITHUB_SHA: before.head };
  delete env.NODE_TEST_CONTEXT;
  const manifest = await runShard({ repoRoot: root, shard: 1, shards: 1, suite: 'source', concurrency, env });
  const after = workingTree();
  const receipt = {
    version: 1,
    head: before.head,
    // A commit or edit during the run means the result proves neither revision.
    dirty: before.dirty || after.dirty || after.head !== before.head,
    passed: manifest.exitCode === 0,
    files: manifest.files.length,
    tests: manifest.counts?.tests ?? null,
    failed: manifest.counts?.fail ?? null,
    skipped: manifest.counts?.skipped ?? null,
    platform: process.platform,
    node: process.versions.node,
    concurrency,
    durationMs: manifest.durationMs,
    finishedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  console.log(`\n${receiptLine(receipt)}`);
  if (receipt.dirty) console.log('Commit your changes and run again to get a receipt a PR can use.');
  else if (receipt.passed) console.log('Paste the line above into the PR description.');
  return receipt.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(`full suite: ${error.message}`);
    process.exitCode = 1;
  });
}
