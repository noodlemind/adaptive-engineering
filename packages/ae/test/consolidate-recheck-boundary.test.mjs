import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { initGit } from './helpers/cli-fixtures.mjs';
import { consolidateCandidates, consolidateStatus } from '../lib/knowledge/consolidate.mjs';
import { prepareConsolidationPacket, applyConsolidationProposal } from '../lib/knowledge/packet-ops.mjs';
import { runInsightCompound } from '../lib/compound.mjs';
import { ensureStore, readLedger, readRecheckConfig, repoId, serializeLearning, writeRecheckConfig, writeStoreConfig } from '../lib/knowledge/store.mjs';
import { loadLayeredLearnings } from '../lib/knowledge/overlay.mjs';
import { solutionsScanRoots } from '../lib/project-layout.mjs';
import { purgeEpisode } from '../lib/knowledge/admin.mjs';
import { failureClusterId } from '../lib/learning-recheck.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/ae.mjs');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const PLANS = ['docs/plans/2026-11-01-a-plan.md', 'docs/plans/2026-11-02-b-plan.md'];

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-recheck-boundary-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, 'ws'), home = path.join(root, 'home'), copilotHome = path.join(root, 'copilot');
  fs.mkdirSync(ws, { recursive: true });
  initGit(ws);
  const put = (rel, value) => {
    const target = path.join(ws, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
    return rel;
  };
  const { dir } = ensureStore(ws, { home });
  assert.equal(writeStoreConfig(ws, { home, mode: 'on' }).pass, true);
  const evidence = PLANS.map((plan, n) => {
    const record = { plan, outcome: 'failed', verifiedAt: `2026-11-0${n + 1}T00:00:00.000Z`, checks: [{ id: 'unit', status: 'failed', exitCode: 1, stderr: `retry count wrong in ${plan}` }] };
    return put(`.harness/evidence/history/${sha(JSON.stringify(record))}.json`, record);
  });
  const cli = (args, env = {}) => spawnSync(process.execPath, [bin, ...args, '--workspace', ws, '--copilot-home', copilotHome, '--json'], { encoding: 'utf8', env: { ...process.env, HARNESS_HOME: home, HARNESS_NO_EVENTS: '1', ...env } });
  return { root, ws, home, copilotHome, dir, put, evidence, cli };
}

function snapshot(dir) {
  const out = {};
  const walk = rel => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else out[child] = sha(fs.readFileSync(path.join(dir, child)));
    }
  };
  walk('');
  return out;
}

test('re-check reads only Harness-owned records, never host transcripts', t => {
  const f = fixture(t);
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  const userHome = path.join(f.root, 'user');
  const transcripts = [
    path.join(userHome, '.claude/projects/ws/session.jsonl'),
    path.join(userHome, '.codex/sessions/2026/11/09/rollout.jsonl'),
    path.join(f.ws, '.claude/transcripts/session.jsonl'),
  ];
  for (const file of transcripts) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ type: 'tool_result', content: 'unit failed: retry count wrong' })}\n`);
  }
  const touched = [];
  const names = ['openSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'opendirSync'];
  const originals = Object.fromEntries(names.map(name => [name, fs[name]]));
  const priorHome = process.env.HOME;
  process.env.HOME = userHome;
  for (const name of names) fs[name] = function (target, ...rest) { if (typeof target === 'string') touched.push(path.resolve(target)); return originals[name].call(this, target, ...rest); };
  let packet, status;
  try {
    packet = consolidateCandidates({ workspace: f.ws, home: f.home, recheck: true });
    status = consolidateStatus({ workspace: f.ws, home: f.home });
  } finally {
    Object.assign(fs, originals);
    process.env.HOME = priorHome;
  }
  assert.equal(packet.recheck.failure_clusters.length, 1, 'the recheck pass ran');
  assert.equal(status.recheck.state, 'suggest');
  assert.ok(touched.some(file => file.includes(`${path.sep}.harness${path.sep}evidence${path.sep}`)), 'evidence records are read');
  const leaked = touched.filter(file => file.startsWith(userHome) || file.includes(`${path.sep}.claude${path.sep}`) || file.includes(`${path.sep}.codex${path.sep}`) || /transcript/i.test(file));
  assert.deepEqual(leaked, []);
});

test('no knowledge-store write happens outside --apply', t => {
  const f = fixture(t);
  const offHint = f.cli(['consolidate', '--candidates', '--recheck', '--dry-run']);
  assert.match(offHint.stderr, /--recheck added nothing/, 'a hint names the off key');
  const set = f.cli(['knowledge', 'recheck', 'on']);
  assert.equal(set.status, 0, set.stderr + set.stdout);
  assert.deepEqual(JSON.parse(set.stdout), { pass: true, recheck: 'on' });
  assert.equal(readRecheckConfig(f.ws, { home: f.home }), 'on');
  const bad = f.cli(['knowledge', 'recheck', 'loud']);
  assert.equal(bad.status, 2, 'unknown values are refused');
  const before = snapshot(f.dir);
  for (const args of [['consolidate', '--candidates', '--recheck'], ['consolidate', '--candidates', '--recheck', '--dry-run'], ['consolidate', '--status'], ['consolidate']]) {
    const result = f.cli(args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  }
  assert.match(f.cli(['consolidate', '--status', '--recheck']).stderr, /applies only with --candidates/);
  const packet = JSON.parse(f.cli(['consolidate', '--candidates', '--recheck']).stdout);
  assert.equal(packet.schema, 2, 'the frozen packet keeps schema 2');
  assert.equal(packet.recheck.state, 'on');
  assert.deepEqual(packet.recheck.failure_clusters.map(c => c.id), [failureClusterId('check:unit')]);
  assert.deepEqual(snapshot(f.dir), before, 'the store, its config and its Git history are unchanged');
});

test('a derived_from insight is traceable from the applied learning back to the cluster evidence', t => {
  const f = fixture(t);
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  const before = prepareConsolidationPacket({ workspace: f.ws, copilotHome: f.copilotHome, home: f.home, recheck: true, dryRun: true });
  const [cluster] = before.recheck.failure_clusters;
  assert.equal(cluster.plan_count, 2);

  const insight = runInsightCompound({ workspace: f.ws, copilotHome: f.copilotHome, home: f.home, log: () => {},
    flags: { title: 'Retry count drifts between plans', body: 'The unit check fails on retry count in two plans; the retry constant is read before config loads.', category: 'debugging', derivedFrom: `failure-cluster:${cluster.id}` } });
  assert.equal(insight.pass, true, insight.blockedReason);

  // The packet with --recheck stays a valid schema-2 packet: the apply path ignores the extra section.
  const packet = prepareConsolidationPacket({ workspace: f.ws, copilotHome: f.copilotHome, home: f.home, recheck: true });
  assert.ok(packet.recheck);
  const episode = packet.clusters.flatMap(c => c.episodes).find(e => e.path === insight.path);
  assert.ok(episode, 'the insight is an ordinary packet episode');
  const opsPath = path.join(f.root, 'ops.json');
  fs.writeFileSync(opsPath, JSON.stringify({ schema: 2, packet: packet.id, operation: 'from-cluster', attempt: 1, ops: [{ op: 'ADD', domain: 'testing', slug: 'retry-constant-load-order',
    trigger: 'reading the retry constant during startup', body: 'Load config before reading the retry constant; the unit check failed on this in two plans.', episodes: [{ id: episode.id }] }] }));
  const applied = applyConsolidationProposal({ workspace: f.ws, copilotHome: f.copilotHome, home: f.home, opsPath });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));

  const learning = loadLayeredLearnings({ workspace: f.ws, home: f.home }).learnings.find(l => l.id === 'testing/retry-constant-load-order');
  const [cited] = learning.fm.episodes;
  const file = solutionsScanRoots(f.ws, { home: f.home }).map(root => path.join(root.base, cited.path)).find(candidate => fs.existsSync(candidate));
  assert.ok(file, 'the cited episode resolves');
  const derived = fs.readFileSync(file, 'utf8').match(/^derived_from: (failure-cluster:[a-f0-9]{16})$/m)?.[1];
  assert.equal(derived, `failure-cluster:${cluster.id}`);
  const traced = before.recheck.failure_clusters.find(c => `failure-cluster:${c.id}` === derived);
  assert.deepEqual(traced.evidence.toSorted(), f.evidence.toSorted(), 'the cited cluster names the evidence records it was built from');
  for (const rel of traced.evidence) assert.equal(JSON.parse(fs.readFileSync(path.join(f.ws, rel), 'utf8')).checks[0].id, 'unit');

  // Consuming the citing episode answers the cluster: it clears until the failure recurs.
  const cleared = consolidateCandidates({ workspace: f.ws, home: f.home, recheck: true }).recheck.failure_clusters;
  assert.equal(cleared.some(c => c.id === cluster.id), false, 'an answered cluster no longer appears');
  const recurred = PLANS.map((plan, n) => {
    const record = { plan, outcome: 'failed', verifiedAt: new Date(Date.now() + 60_000 + n).toISOString(), checks: [{ id: 'unit', status: 'failed', exitCode: 1, stderr: 'retry count wrong again' }] };
    return f.put(`.harness/evidence/history/${sha(JSON.stringify(record))}.json`, record);
  });
  const reopened = consolidateCandidates({ workspace: f.ws, home: f.home, recheck: true }).recheck.failure_clusters.find(c => c.id === cluster.id);
  assert.ok(reopened, 'failures after the consolidation reopen the cluster');
  assert.deepEqual(reopened.evidence.toSorted(), recurred.toSorted(), 'only failures after the answer count');
});

/** Capture an insight answering the fixture's cluster and consume it with one op. */
function answerCluster(f, op, operation) {
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  const [cluster] = consolidateCandidates({ workspace: f.ws, home: f.home, recheck: true }).recheck.failure_clusters;
  const insight = runInsightCompound({ workspace: f.ws, copilotHome: f.copilotHome, home: f.home, log: () => {},
    flags: { title: `Retry count answer ${operation}`, body: 'The retry constant is read before config loads.', category: 'debugging', derivedFrom: `failure-cluster:${cluster.id}` } });
  assert.equal(insight.pass, true, insight.blockedReason);
  const packet = prepareConsolidationPacket({ workspace: f.ws, copilotHome: f.copilotHome, home: f.home });
  const episode = packet.clusters.flatMap(c => c.episodes).find(e => e.path === insight.path);
  const opsPath = path.join(f.root, `${operation}.json`);
  fs.writeFileSync(opsPath, JSON.stringify({ schema: 2, packet: packet.id, operation, attempt: 1, ops: [{ ...op, episodes: [{ id: episode.id }] }] }));
  const applied = applyConsolidationProposal({ workspace: f.ws, copilotHome: f.copilotHome, home: f.home, opsPath });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  const file = solutionsScanRoots(f.ws, { home: f.home }).map(root => path.join(root.base, insight.path)).find(candidate => fs.existsSync(candidate));
  return { cluster, file, rel: insight.path };
}

const ADD = { op: 'ADD', domain: 'testing', slug: 'retry-constant-load-order', trigger: 'reading the retry constant during startup', body: 'Load config before reading the retry constant.' };
const clusterIds = f => consolidateCandidates({ workspace: f.ws, home: f.home, recheck: true }).recheck.failure_clusters.map(c => c.id);
const failAgain = (f, at) => PLANS.map(plan => {
  const record = { plan, outcome: 'failed', verifiedAt: at, checks: [{ id: 'unit', status: 'failed', exitCode: 1, stderr: 'again' }] };
  return f.put(`.harness/evidence/history/${sha(JSON.stringify(record))}.json`, record);
});

test('a NOOP consumption does not answer a cluster', t => {
  const f = fixture(t);
  const { cluster } = answerCluster(f, { op: 'NOOP', reason: 'Nothing durable to learn.' }, 'noop-answer');
  assert.ok(clusterIds(f).includes(cluster.id), 'only a learning-writing op answers a cluster');
});

test('an answer is durable: it survives the episode file being deleted and a same-day recurrence still reopens it', t => {
  const f = fixture(t);
  const { cluster, file } = answerCluster(f, ADD, 'durable-answer');
  assert.equal(clusterIds(f).includes(cluster.id), false);
  fs.rmSync(file);
  assert.equal(clusterIds(f).includes(cluster.id), false, 'the answer lives in the ledger, not the episode file');
  failAgain(f, new Date(Date.now() + 60_000).toISOString());
  assert.ok(clusterIds(f).includes(cluster.id), 'a recurrence later the same day reopens the cluster');
});

test('an answer recorded in a branch bucket is visible from other branches', t => {
  const f = fixture(t);
  assert.equal(spawnSync('git', ['switch', '-q', '-c', 'feature/answer'], { cwd: f.ws }).status, 0);
  const { cluster } = answerCluster(f, ADD, 'branch-answer');
  assert.equal(spawnSync('git', ['switch', '-q', '-c', 'feature/other'], { cwd: f.ws }).status, 0);
  assert.equal(clusterIds(f).includes(cluster.id), false);
});

test('ae knowledge purge of the answering episode removes its ledger entry and reopens the cluster', t => {
  const f = fixture(t);
  const { cluster, rel } = answerCluster(f, ADD, 'purged-answer');
  assert.equal(clusterIds(f).includes(cluster.id), false);
  const purged = purgeEpisode({ workspace: f.ws, target: rel, copilotHome: f.copilotHome, home: f.home });
  assert.equal(purged.pass, true, purged.blockedReason);
  assert.ok(purged.removed.ledger >= 1, 'the consumption entry carrying the answer is removed');
  assert.ok(clusterIds(f).includes(cluster.id), 'with its ledger entry gone the cluster is open again');
});

/** An active learning, in the layer the packet writes to, that STRENGTHEN, SUPERSEDE and MERGE ops can target. */
function seedLearning(f, slug) {
  const { layerDir } = prepareConsolidationPacket({ workspace: f.ws, copilotHome: f.copilotHome, home: f.home }).binding;
  const file = path.join(layerDir, 'learnings', 'testing', `${slug}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeLearning({
    trigger: `working on ${slug}`, status: 'active', source: 'auto',
    episodes: [{ path: `docs/solutions/${slug}.md`, sha256: 'a'.repeat(64), kind: 'fix', plan: PLANS[0] }],
    anchors: [], origin: repoId(f.ws),
  }, `Existing advice for ${slug}.`));
  return `testing/${slug}`;
}

for (const [name, op] of [
  ['STRENGTHEN', f => ({ op: 'STRENGTHEN', target: seedLearning(f, 'retry-existing') })],
  ['SUPERSEDE', f => ({ op: 'SUPERSEDE', target: seedLearning(f, 'retry-old'), domain: 'testing', slug: 'retry-new', trigger: 'reading the retry constant during startup', body: 'Load config before reading the retry constant.' })],
  ['MERGE', f => ({ op: 'MERGE', targets: [seedLearning(f, 'retry-a'), seedLearning(f, 'retry-b')], domain: 'testing', slug: 'retry-merged', trigger: 'reading the retry constant in either startup path', body: 'Load config before reading the retry constant in both startup paths.' })],
]) {
  test(`a ${name} consumption answers a cluster`, t => {
    const f = fixture(t);
    const { cluster } = answerCluster(f, op(f), `${name.toLowerCase()}-answer`);
    assert.equal(clusterIds(f).includes(cluster.id), false, `${name} writes a learning, so it answers the cluster`);
  });
}

test('derived_from answers a cluster only on an insight episode: the same line on a fix answers nothing', t => {
  const f = fixture(t);
  writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' });
  const [cluster] = consolidateCandidates({ workspace: f.ws, home: f.home, recheck: true }).recheck.failure_clusters;
  const insight = runInsightCompound({ workspace: f.ws, copilotHome: f.copilotHome, home: f.home, log: () => {},
    flags: { title: 'Retry count answer as a fix', body: 'The retry constant is read before config loads.', category: 'debugging', derivedFrom: `failure-cluster:${cluster.id}` } });
  assert.equal(insight.pass, true, insight.blockedReason);
  const file = solutionsScanRoots(f.ws, { home: f.home }).map(root => path.join(root.base, insight.path)).find(candidate => fs.existsSync(candidate));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^kind: insight$/m);
  // A hand-edited episode keeps the derived_from line but is a fix, which Harness never writes with the field.
  fs.writeFileSync(file, text.replace(/^kind: insight$/m, 'kind: fix'));
  const packet = prepareConsolidationPacket({ workspace: f.ws, copilotHome: f.copilotHome, home: f.home });
  const episode = packet.clusters.flatMap(c => c.episodes).find(e => e.path === insight.path);
  assert.equal(episode?.kind, 'fix');
  const opsPath = path.join(f.root, 'fix-answer.json');
  fs.writeFileSync(opsPath, JSON.stringify({ schema: 2, packet: packet.id, operation: 'fix-answer', attempt: 1, ops: [{ ...ADD, episodes: [{ id: episode.id }] }] }));
  const applied = applyConsolidationProposal({ workspace: f.ws, copilotHome: f.copilotHome, home: f.home, opsPath });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  const entry = readLedger(packet.binding.layerDir).find(row => row.path === insight.path && row.learning);
  assert.ok(entry, 'the fix episode was consumed');
  assert.equal('answers' in entry, false, 'a fix episode records no answer');
  assert.ok(clusterIds(f).includes(cluster.id), 'the cluster stays open');
});
