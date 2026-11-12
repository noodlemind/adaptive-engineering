import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { initGit } from './helpers/cli-fixtures.mjs';
import { deriveGitContext } from '../lib/git-context.mjs';
import { ensureBucket } from '../lib/knowledge/layer.mjs';
import { renderLearning } from '../lib/knowledge/apply.mjs';
import { writeStoreFile } from '../lib/knowledge/store-io.mjs';
import { collectEpisodes } from '../lib/knowledge/consolidate.mjs';
import { ensureStore, readLedger, writeRecheckConfig, writeStoreConfig } from '../lib/knowledge/store.mjs';

function fixture(t, count = 2) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-consolidation-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const home = path.join(ws, '.harness/home'), copilot = path.join(ws, '.harness/copilot');
  for (let n = 0; n < count; n++) {
    const file = path.join(ws, `docs/solutions/design/episode-${n}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\nkind: insight\ntitle: Episode ${n}\ndate: 2026-10-01\n---\n\nIndependent observation ${n}.\n`);
  }
  writeStoreConfig(ws, { mode: 'on' }, { home });
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/ae.mjs'), 'consolidate', ...args, '--workspace', ws, '--harness-home', home, '--copilot-home', copilot, '--json'], { encoding: 'utf8', env: { ...process.env, HARNESS_NO_EVENTS: '1' } });
    return { ...r, value: r.stdout.trim() ? JSON.parse(r.stdout) : null };
  };
  const candidates = () => cli('--candidates').value;
  const apply = (input, ...flags) => {
    const file = path.join(ws, 'ops.json');
    fs.writeFileSync(file, JSON.stringify(input));
    return cli('--apply', '--ops', file, ...flags);
  };
  return { ws, home, copilot, candidates, apply };
}

test('frozen packet IDs expand evidence and replay one committed consumption', t => {
  const f = fixture(t), packet = f.candidates();
  assert.match(packet.id || '', /^[a-f0-9]{64}$/);
  assert.equal(f.candidates().id, packet.id);
  const episodes = packet.clusters.flatMap(c => c.episodes);
  assert.ok(episodes.every(e => /^[a-f0-9]{64}$/.test(e.id)));
  const input = { schema: 2, packet: packet.id, operation: 'drain-one', attempt: 1, ops: [{ op: 'NOOP', reason: 'These are derivable observations.', episodes: episodes.map(e => ({ id: e.id })) }] };
  assert.equal(f.apply(input, '--dry-run').status, 0);
  const first = f.apply(input);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const { dir } = ensureStore(f.ws, { home: f.home });
  const ledger = readLedger(dir);
  assert.equal(ledger.length, episodes.length);
  const replay = f.apply(input);
  assert.equal(replay.status, 0, replay.stderr + replay.stdout);
  assert.equal(replay.value.replayed, true);
  assert.deepEqual(readLedger(dir), ledger);
  assert.equal(f.apply({ ...input, ops: [{ ...input.ops[0], reason: 'Different payload.' }] }).status, 1);
  assert.equal(f.candidates().clusters.length, 0);
});

test('changed sources and tampered frozen packets fail closed', t => {
  const f = fixture(t), packet = f.candidates(), episode = packet.clusters[0].episodes[0];
  const input = { schema: 2, packet: packet.id, operation: 'stale', attempt: 1, ops: [{ op: 'NOOP', reason: 'Derivable.', episodes: [{ id: episode.id }] }] };
  fs.appendFileSync(path.join(f.ws, episode.path), 'Changed.\n');
  const stale = f.apply(input);
  assert.equal(stale.status, 1);
  assert.equal(stale.value.retry.eligible, false);
  assert.match(stale.value.rejected[0].reason, /stale/);
  const fresh = f.candidates(), file = path.join(f.ws, fresh.packetPath);
  fs.writeFileSync(file, JSON.stringify({ ...fresh, governed: [{ id: 'design/x', action: 'retire' }] }));
  const tampered = f.apply({ ...input, packet: fresh.id, operation: 'tampered', ops: [{ ...input.ops[0], episodes: [{ id: fresh.clusters[0].episodes[0].id }] }] });
  assert.equal(tampered.status, 1);
  assert.match(tampered.value.rejected[0].reason, /packet/);
});

test('repair diagnostics persist one semantic retry and dry-run does not spend it', t => {
  const f = fixture(t), packet = f.candidates(), id = packet.clusters[0].episodes[0].id;
  const input = { schema: 2, packet: packet.id, operation: 'repair-body', attempt: 1, ops: [{ op: 'ADD', domain: 'design', slug: 'claim', trigger: 'A boundary is evaluated', body: 'x'.repeat(2000), reason: 'No existing equivalent.', episodes: [{ id }] }] };
  const dry = f.apply(input, '--dry-run');
  assert.equal(dry.status, 1);
  assert.equal(dry.value.retry.eligible, true);
  const first = f.apply(input);
  assert.equal(first.value.retry.nextAttempt, 2);
  assert.equal(f.apply(input).value.replayed, true);
  const repaired = { ...input, attempt: 2, ops: [{ ...input.ops[0], body: 'Independent validation preserves the acceptance boundary.' }] };
  const accepted = f.apply(repaired);
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
  assert.equal(f.apply({ ...repaired, attempt: 3 }).status, 1);
});

test('committed store receipt recovers an interrupted outer receipt without duplicate ledger entries', t => {
  const f = fixture(t), packet = f.candidates(), id = packet.clusters[0].episodes[0].id;
  const input = { schema: 2, packet: packet.id, operation: 'interrupted', attempt: 1, ops: [{ op: 'NOOP', reason: 'Derivable.', episodes: [{ id }] }] };
  assert.equal(f.apply(input).status, 0);
  const { dir } = ensureStore(f.ws, { home: f.home }), ledger = readLedger(dir);
  fs.rmSync(path.join(f.ws, '.harness/consolidation/operations'), { recursive: true, force: true });
  assert.equal(f.apply(input).status, 0);
  assert.deepEqual(readLedger(dir), ledger);
});

test('large debt drains frozen bounded packets without omission or repeat consumption', t => {
  const f = fixture(t, 180), seen = new Set();
  let batches = 0;
  while (true) {
    const packet = f.candidates(), episodes = packet.clusters.flatMap(c => c.episodes);
    if (!episodes.length) break;
    assert.ok(Buffer.byteLength(JSON.stringify(packet.clusters)) < 32_000);
    for (const e of episodes) { assert.equal(seen.has(e.id), false); seen.add(e.id); }
    const result = f.apply({ schema: 2, packet: packet.id, operation: `batch-${batches++}`, attempt: 1, ops: [{ op: 'NOOP', reason: 'Derivable facts.', episodes: episodes.map(e => ({ id: e.id })) }] });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  }
  assert.ok(batches > 1);
  assert.equal(seen.size, 180);
  const { dir } = ensureStore(f.ws, { home: f.home });
  assert.equal(readLedger(dir).length, 180);
});

test('repair exhaustion and semantic-cap refusal stay terminal', t => {
  const f = fixture(t), packet = f.candidates(), id = packet.clusters[0].episodes[0].id;
  const input = { schema: 2, packet: packet.id, operation: 'exhaustion', attempt: 1, ops: [{ op: 'ADD', domain: 'design', slug: 'claim', trigger: 'Boundary', body: 'x'.repeat(2000), episodes: [{ id }] }] };
  assert.equal(f.apply(input).value.retry.eligible, true);
  assert.equal(f.apply({ ...input, attempt: 2 }).value.retry.eligible, false);
  assert.equal(f.apply({ ...input, attempt: 2, ops: [{ ...input.ops[0], body: 'Repaired.' }] }).status, 1);
});

test('damaged outer operation receipts cannot claim an accepted result', t => {
  const f = fixture(t), packet = f.candidates(), id = packet.clusters[0].episodes[0].id;
  const input = { schema: 2, packet: packet.id, operation: 'damaged-receipt', attempt: 1, ops: [{ op: 'NOOP', reason: 'Derivable.', episodes: [{ id }] }] };
  assert.equal(f.apply(input).status, 0);
  const dir = path.join(f.ws, '.harness/consolidation/operations');
  const file = fs.readdirSync(dir).find(name => /^[a-f0-9]{64}\.json$/.test(name));
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, file)));
  receipt.attempts[1].result.applied = [{ op: 'ADD', id: 'invented/claim' }];
  fs.writeFileSync(path.join(dir, file), JSON.stringify(receipt));
  assert.equal(f.apply(input).status, 1);
});

test('candidate dry-run returns the same bounded packet without persisting it', t => {
  const f = fixture(t);
  const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/ae.mjs'), 'consolidate', '--candidates', '--dry-run', '--workspace', f.ws, '--harness-home', f.home, '--copilot-home', f.copilot, '--json'], { encoding: 'utf8', env: { ...process.env, HARNESS_NO_EVENTS: '1' } });
  assert.equal(r.status, 0, r.stderr);
  const packet = JSON.parse(r.stdout);
  assert.equal(fs.existsSync(path.join(f.ws, packet.packetPath)), false);
  assert.equal(f.candidates().id, packet.id);
});

test('accepted repair attempt recovers after outer history disappears', t => {
  const f = fixture(t), packet = f.candidates(), id = packet.clusters[0].episodes[0].id;
  const input = { schema: 2, packet: packet.id, operation: 'lost-repair-receipt', attempt: 1, ops: [{ op: 'ADD', domain: 'design', slug: 'claim', trigger: 'Boundary', body: 'x'.repeat(2000), episodes: [{ id }] }] };
  assert.equal(f.apply(input).value.retry.nextAttempt, 2);
  const repaired = { ...input, attempt: 2, ops: [{ ...input.ops[0], body: 'Preserve the accepted evidence boundary.' }] };
  assert.equal(f.apply(repaired).status, 0);
  const { dir } = ensureStore(f.ws, { home: f.home }), ledger = readLedger(dir);
  fs.rmSync(path.join(f.ws, '.harness/consolidation/operations'), { recursive: true, force: true });
  const recovered = f.apply(repaired);
  assert.equal(recovered.status, 0, recovered.stderr + recovered.stdout);
  assert.equal(recovered.value.replayed, true);
  assert.deepEqual(readLedger(dir), ledger);
  assert.notEqual(f.apply({ ...repaired, ops: [{ ...repaired.ops[0], body: 'A different claim.' }] }).status, 0);
});

test('a frozen branch packet cannot modify a changed golden copy of its target', t => {
  const f = fixture(t);
  initGit(f.ws);
  assert.equal(spawnSync('git', ['switch', '-c', 'feature/bound-layer'], { cwd: f.ws }).status, 0);
  const { dir } = ensureStore(f.ws, { home: f.home });
  const context = deriveGitContext({ workspace: f.ws, home: f.home });
  const branch = ensureBucket(dir, { key: context.branchKey, branch: context.branch });
  const episode = collectEpisodes({ workspace: f.ws, copilotHome: f.copilot, home: f.home })[0];
  const doc = renderLearning({ trigger: 'Boundary', body: 'Preserve existing evidence.', episodes: [{ path: episode.path, sha256: episode.sha256, kind: episode.kind }], origin: 'fixture', status: 'active', source: 'consolidation' });
  assert.ok(writeStoreFile(path.join(branch, 'learnings/design/claim.md'), doc));
  assert.ok(writeStoreFile(path.join(dir, 'learnings/design/claim.md'), doc));
  assert.equal(spawnSync('git', ['add', '.'], { cwd: dir }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=Harness fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed learning layers'], { cwd: dir }).status, 0);
  const packet = f.candidates();
  assert.equal(packet.layer, 'branch');
  assert.ok(packet.clusters.length);
  const changed = doc.replace('Preserve existing evidence.', 'The human refined the golden boundary.');
  assert.ok(writeStoreFile(path.join(dir, 'learnings/design/claim.md'), changed));
  const selected = packet.clusters.flatMap(c => c.episodes).find(e => e.path === episode.path);
  const result = f.apply({ schema: 2, packet: packet.id, operation: 'wrong-layer', attempt: 1, ops: [{ op: 'STRENGTHEN', target: 'design/claim', episodes: [{ id: selected.id }] }] }, '--layer', 'golden', '--yes');
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.value.rejected[0].reason, /destination|layer/);
  assert.match(fs.readFileSync(path.join(dir, 'learnings/design/claim.md'), 'utf8'), /human refined/);
});

test('first branch packet binds the write layer before a bucket exists', t => {
  const f = fixture(t);
  initGit(f.ws);
  assert.equal(spawnSync('git', ['switch', '-c', 'feature/first-consolidation'], { cwd: f.ws }).status, 0);
  const packet = f.candidates();
  assert.equal(packet.layer, 'branch');
  const result = f.apply({ schema: 2, packet: packet.id, operation: 'first-branch', attempt: 1, ops: [{ op: 'NOOP', reason: 'Derivable.', episodes: packet.clusters.flatMap(c => c.episodes).map(e => ({ id: e.id })) }] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.value.layer, 'branch');
});

test('a packet with a recheck section stays a schema-2 packet the apply path accepts', t => {
  const f = fixture(t);
  const plain = f.candidates();
  assert.equal(writeRecheckConfig(f.ws, { home: f.home, recheck: 'suggest' }).pass, true);
  const cli = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/ae.mjs'), 'consolidate', '--candidates', '--recheck', '--workspace', f.ws, '--harness-home', f.home, '--copilot-home', f.copilot, '--json'], { encoding: 'utf8', env: { ...process.env, HARNESS_NO_EVENTS: '1' } });
  assert.equal(cli.status, 0, cli.stderr);
  const packet = JSON.parse(cli.stdout);
  assert.equal(packet.schema, 2);
  assert.equal(packet.recheck.state, 'suggest');
  assert.notEqual(packet.id, plain.id, 'the section is part of the frozen identity');
  assert.equal(f.candidates().id, plain.id, 'without --recheck the packet is unchanged');
  const result = f.apply({ schema: 2, packet: packet.id, operation: 'recheck-noop', attempt: 1, ops: [{ op: 'NOOP', reason: 'Derivable.', episodes: packet.clusters.flatMap(c => c.episodes).map(e => ({ id: e.id })) }] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
