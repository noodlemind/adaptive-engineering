import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { approveProject } from '../lib/trust.mjs';
import { applyOps } from '../lib/knowledge/apply.mjs';
import { storeDir, ensureStore } from '../lib/knowledge/store.mjs';
import { LEARNING_BYTE_CAP, consolidateCandidates } from '../lib/knowledge/consolidate.mjs';
import { normalizeEvidenceLine, evidenceLineError, evidenceFingerprint, matchEvidence, evidencePrefixError, readEvidenceFingerprint, EVIDENCE_LINE_CAP } from '../lib/knowledge/evidence-fingerprint.mjs';
import { writeChecks, writeVersionedPlan, initGit } from './helpers/cli-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
// A distinctive marker, so any copy of the line anywhere on disk or in output is found.
const MARKER = 'QX7MARKER';
const QUOTE = `not ok 1 - example exports two # ${MARKER} expected: 2, actual: 1`;
const QUOTE_SHA = sha(QUOTE);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) return [];
    return e.isDirectory() ? walk(full) : [full];
  });
}
const filesHolding = (dir, needle) => walk(dir).filter(file => fs.readFileSync(file).includes(needle));

test('the evidence line is checked, normalised and fingerprinted the same way at capture and verification', () => {
  assert.equal(normalizeEvidenceLine('\x1b[31mFAIL\x1b[0m retry  \r'), 'FAIL retry');
  assert.equal(normalizeEvidenceLine('\x1b]8;;http://x\x07link\x1b]8;;\x07 ok\t'), 'link ok');
  assert.equal(evidenceLineError(QUOTE), null);
  assert.equal(evidenceLineError('FAIL\ttest/retry.test.mjs\t(12 ms)'), null, 'tabs are allowed');
  assert.equal(evidenceLineError('\x1b[31mFAIL\x1b[0m retry'), null, 'colour codes are removed, not refused');
  assert.equal(evidenceLineError('x'.repeat(EVIDENCE_LINE_CAP)), null, 'exactly the cap is accepted');
  for (const value of ['a\nb', 'a\r\nb', 'a\rb', 'a\u0085b', 'a\u2028b', 'a\u2029b']) assert.match(evidenceLineError(value), /single line/, JSON.stringify(value));
  assert.match(evidenceLineError('é'.repeat(301)), /at most 600 bytes/);
  for (const value of ['ok \x00 nul', 'ok \x07 bell', 'ok \x7f del', 'ok \u0090 c1']) assert.match(evidenceLineError(value), /no other control characters/, JSON.stringify(value));
  for (const value of ['', '   ', '\x1b[0m', null, 3]) assert.match(evidenceLineError(value), /nonempty/, JSON.stringify(value));
  assert.ok(!evidenceLineError('a\nghp_secret').includes('ghp_'), 'a refusal never echoes the line');

  const fp = evidenceFingerprint(`\x1b[1m${QUOTE}\x1b[0m   `);
  assert.deepEqual(fp, { sha256: QUOTE_SHA, bytes: Buffer.byteLength(QUOTE) });
  const output = ['TAP version 13', `\x1b[31m${QUOTE}\x1b[39m`, '# fail 1'].join('\r\n');
  assert.deepEqual(matchEvidence(output, QUOTE_SHA.slice(0, 12)), { matched: true, line: 2 }, 'ANSI and CRLF variants match');
  assert.deepEqual(matchEvidence(`progress 10%\rprogress 90%\r${QUOTE}\n`, QUOTE_SHA), { matched: true, line: 3 }, 'carriage-return progress output is split into lines');
  assert.deepEqual(matchEvidence(output, QUOTE_SHA.slice(0, 12), { bytes: fp.bytes }), { matched: true, line: 2 });
  assert.deepEqual(matchEvidence(output, QUOTE_SHA.slice(0, 12), { bytes: fp.bytes + 1 }), { matched: false, line: null });
  assert.deepEqual(matchEvidence(output.replace('actual: 1', 'actual: 3'), QUOTE_SHA.slice(0, 12)), { matched: false, line: null }, 'a changed line does not match');
  assert.equal(evidencePrefixError(QUOTE_SHA.slice(0, 12)), null);
  assert.equal(evidencePrefixError(QUOTE_SHA), null);
  for (const bad of ['', 'abc', QUOTE_SHA.slice(0, 11), QUOTE_SHA.toUpperCase(), `${QUOTE_SHA}0`, 'zzzzzzzzzzzz']) assert.ok(evidencePrefixError(bad), bad);
  assert.deepEqual(readEvidenceFingerprint({ evidence_sha256: QUOTE_SHA, evidence_bytes: '57' }), { sha256: QUOTE_SHA, bytes: 57 });
  assert.equal(readEvidenceFingerprint({ evidence_sha256: 'abc', evidence_bytes: '5' }), null);
  assert.equal(readEvidenceFingerprint({ evidence_sha256: QUOTE_SHA, evidence_bytes: '601' }), null);
  assert.equal(readEvidenceFingerprint({ evidence_quote: QUOTE }), null, 'an evidence_quote key is never read');
});

function verifiedFixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-quote-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'product'), home = path.join(dir, 'home'), copilot = path.join(dir, 'copilot');
  fs.mkdirSync(ws);
  fs.mkdirSync(copilot);
  fs.writeFileSync(path.join(ws, '.gitignore'), '.harness/\n');
  fs.writeFileSync(path.join(ws, 'package.json'), '{"type":"module"}\n');
  writeChecks(ws, { behavior: { command: [process.execPath, '-e', "import('./src/example.js').then(m => { if (m.value !== 2) process.exit(1); })"] } });
  fs.writeFileSync(path.join(ws, '.github/harness/policy.yaml'), 'version: 1\nenforcement: enforce\n');
  initGit(ws);
  approveProject({ workspace: ws, copilotHome: copilot, home });
  const env = { ...process.env, HARNESS_HOME: home, COPILOT_HOME: copilot, HARNESS_NO_EVENTS: '1', HARNESS_BIN: path.join(root, 'bin/ae.mjs') };
  delete env.HARNESS_ENFORCEMENT;
  const cli = (args, input) => spawnSync(process.execPath, [path.join(root, 'bin/ae.mjs'), ...args, '--workspace', ws, '--harness-home', home, '--copilot-home', copilot], { cwd: ws, env, input, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const plan = writeVersionedPlan(ws, { required: ['behavior'], criteria: { AC1: ['behavior'] } });
  fs.writeFileSync(path.join(ws, 'src/example.js'), 'export const value = 2;\n');
  const verified = cli(['verify', '--plan', plan, '--base', 'HEAD', '--json']);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  return { dir, ws, home, copilot, cli, plan };
}

// The decision goes in on stdin, so the test itself leaves no copy of the line on disk.
const decide = (f, value) => f.cli(['compound', '--plan', f.plan, '--learning-decision', '-', '--json'], JSON.stringify(value));

const publish = (operation, extra = {}) => ({ operation, decision: 'publish', rationale: 'The export regression is reusable.', title: 'example export value', body: 'The example module must export the value two.', category: 'logic', ...extra });

test('a publish decision stores only the evidence fingerprint, and no copy of the line reaches disk or any output', t => {
  const f = verifiedFixture(t);
  const accepted = decide(f, publish('quote-accepted', { evidence_quote: `\x1b[31m${QUOTE}\x1b[0m` }));
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  const out = JSON.parse(accepted.stdout);
  assert.deepEqual(out.evidence, { sha256_prefix: QUOTE_SHA.slice(0, 12), bytes: Buffer.byteLength(QUOTE) });
  const episode = fs.readFileSync(out.publishedPath, 'utf8');
  assert.ok(episode.includes(`\nevidence_sha256: ${QUOTE_SHA}\nevidence_bytes: ${Buffer.byteLength(QUOTE)}\n`), episode);
  assert.ok(!episode.includes('evidence_quote'), 'no evidence_quote key is written');
  assert.ok(episode.endsWith('---\n\nThe example module must export the value two.\n'), 'the body is unchanged');
  const record = JSON.parse(fs.readFileSync(path.join(f.ws, out.learningRecord), 'utf8'));
  assert.equal(record.decision.evidence_quote, undefined, 'the stored decision holds the fingerprint, not the line');
  assert.equal(record.decision.evidence_sha256, QUOTE_SHA);

  const replay = decide(f, publish('quote-accepted', { evidence_quote: QUOTE }));
  assert.equal(replay.status, 0, replay.stderr || replay.stdout);
  assert.equal(JSON.parse(replay.stdout).replayed, true, 'the same line, with or without colour codes, is the same operation');

  const surfaces = [accepted.stdout, accepted.stderr, replay.stdout];
  surfaces.push(f.cli(['index', '--json']).stdout);
  const candidates = f.cli(['consolidate', '--candidates', '--json']);
  surfaces.push(candidates.stdout, candidates.stderr);
  surfaces.push(f.cli(['recall', 'example export value', '--json']).stdout);
  surfaces.push(f.cli(['search', 'example export value', '--json']).stdout);
  const oriented = f.cli(['orient', '--plan', f.plan, '--query', 'example export value', '--json']);
  surfaces.push(oriented.stdout);
  for (const [i, text] of surfaces.entries()) assert.ok(!String(text).includes(MARKER), `surface ${i} shows the line`);
  const packet = JSON.parse(candidates.stdout);
  const entry = (packet.clusters || []).flatMap(c => c.episodes).find(e => e.title === 'example export value');
  assert.ok(entry, candidates.stdout.slice(0, 2000));
  assert.deepEqual(entry.evidence, { sha256_prefix: QUOTE_SHA.slice(0, 12), bytes: Buffer.byteLength(QUOTE) });
  assert.match(packet.contract.evidenceMatch, /--match-evidence/);
  assert.deepEqual(filesHolding(f.dir, MARKER), [], 'no file anywhere holds the line');
});

test('a publish decision refuses an oversize, multi-line, control-holding or no-learning evidence line', t => {
  const f = verifiedFixture(t);
  const refused = [
    [publish('quote-oversize', { evidence_quote: 'x'.repeat(601) }), /at most 600 bytes/],
    [publish('quote-multi-line', { evidence_quote: `${MARKER} expected: 2\n  actual: 1` }), /must be a single line/],
    [publish('quote-control', { evidence_quote: `${MARKER} bell \x07` }), /no other control characters/],
    [{ operation: 'quote-no-learning', decision: 'no-learning', rationale: 'Nothing new.', evidence_quote: QUOTE }, /only to a publish decision/],
    [publish('quote-direct', { evidence_sha256: QUOTE_SHA }), /Learning decision requires/],
  ];
  for (const [value, message] of refused) {
    const result = decide(f, value);
    assert.notEqual(result.status, 0, value.operation);
    assert.match(result.stdout + result.stderr, message);
    assert.ok(!(result.stdout + result.stderr).includes(MARKER), 'a refusal never echoes the line');
  }
  assert.equal(fs.existsSync(path.join(f.ws, '.harness/learning')) && fs.readdirSync(path.join(f.ws, '.harness/learning')).some(name => name !== '.ready.json'), false, 'refused decisions leave no learning record');
  const flagged = f.cli(['compound', '--plan', f.plan, '--learning-decision', '-', '--evidence-quote', QUOTE, '--json'], JSON.stringify(publish('quote-flag')));
  assert.equal(flagged.status, 2, 'the CLI flag beside a decision is a usage error');
  assert.match(flagged.stdout + flagged.stderr, /--evidence-quote cannot be combined with --learning-decision/);
  assert.deepEqual(filesHolding(f.dir, MARKER), []);
});

test('a publish decision without evidence_quote keeps its stored bytes, digest and episode shape', t => {
  const f = verifiedFixture(t);
  const value = publish('plain-publish');
  const result = decide(f, value);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const out = JSON.parse(result.stdout);
  assert.equal(out.evidence, undefined);
  const stored = JSON.parse(fs.readFileSync(path.join(f.ws, out.learningRecord), 'utf8'));
  assert.deepEqual(stored.decision, value, 'no evidence key is added to the stored decision');
  assert.equal(stored.digest, sha(JSON.stringify({ decision: value, proof: stored.proof.verificationIdentity, destination: stored.destination })));
  const episode = fs.readFileSync(out.publishedPath, 'utf8');
  assert.equal(/evidence_/.test(episode), false);
});

test('ae compound --match-evidence matches re-run check output by fingerprint and reports a mismatch', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-match-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ae = (args, input) => spawnSync(process.execPath, [path.join(root, 'bin/ae.mjs'), 'compound', ...args, '--workspace', dir, '--harness-home', dir, '--copilot-home', dir, '--json'],
    { cwd: dir, input, env: { ...process.env, HARNESS_NO_EVENTS: '1' }, encoding: 'utf8', timeout: 30000 });
  fs.writeFileSync(path.join(dir, 'out.txt'), `TAP version 13\r\n\x1b[31m${QUOTE}\x1b[0m\r\n# fail 1\r\n`);
  const prefix = QUOTE_SHA.slice(0, 12);
  const matched = ae(['--match-evidence', prefix, '--check-output', 'out.txt']);
  assert.equal(matched.status, 0, matched.stdout + matched.stderr);
  const result = JSON.parse(matched.stdout);
  assert.equal(result.matched, true);
  assert.equal(result.line, 2);
  assert.ok(!matched.stdout.includes(MARKER), 'the output is never echoed');
  const piped = ae(['--match-evidence', QUOTE_SHA, '--check-output', '-'], `${QUOTE}\n`);
  assert.equal(piped.status, 0, piped.stdout + piped.stderr);
  const missed = ae(['--match-evidence', prefix, '--check-output', '-'], 'not ok 1 - example exports two # expected: 2, actual: 3\n');
  assert.equal(missed.status, 1, missed.stdout + missed.stderr);
  assert.equal(JSON.parse(missed.stdout).matched, false);
  assert.match(JSON.parse(missed.stdout).blockedReason, /No line of the check output matches/);
  for (const args of [['--match-evidence', 'abc', '--check-output', 'out.txt'], ['--match-evidence', prefix], ['--match-evidence', prefix, '--check-output', 'out.txt', '--insight']]) {
    const usage = ae(args);
    assert.equal(usage.status, 2, `${args.join(' ')}: ${usage.stdout}${usage.stderr}`);
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['out.txt'], 'a match writes nothing');
});

test('a hand-written evidence_quote key in an episode is never read or shown', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-ws-'));
  const copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-ch-'));
  const harnessHome = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-hh-'));
  try {
    const dir = path.join(copilotHome, 'knowledge', 'solutions', 'perf');
    fs.mkdirSync(dir, { recursive: true });
    const episode = (title, extra) => `---\ntitle: "${title}"\nkind: insight\ndate: 2026-11-01\n${extra}---\n\n## Problem\n\nOrders timeout under retry load.\n`;
    fs.writeFileSync(path.join(dir, 'legacy.md'), episode('orders timeout legacy', `evidence_quote: ${JSON.stringify(QUOTE)}\n`));
    fs.writeFileSync(path.join(dir, 'fingerprint.md'), episode('orders timeout fingerprint', `evidence_sha256: ${QUOTE_SHA}\nevidence_bytes: ${Buffer.byteLength(QUOTE)}\n`));
    ensureStore(workspace, { home: harnessHome });
    const packet = consolidateCandidates({ workspace, copilotHome, home: harnessHome });
    const entries = packet.clusters.flatMap(c => c.episodes);
    const legacy = entries.find(e => e.title === 'orders timeout legacy');
    assert.ok(legacy, JSON.stringify(entries));
    assert.equal(legacy.evidence, undefined);
    assert.equal(legacy.evidence_quote, undefined);
    assert.deepEqual(entries.find(e => e.title === 'orders timeout fingerprint').evidence, { sha256_prefix: QUOTE_SHA.slice(0, 12), bytes: Buffer.byteLength(QUOTE) });
    assert.ok(!JSON.stringify(packet).includes(MARKER), 'the packet never shows a hand-written quote');
  } finally {
    for (const d of [workspace, copilotHome, harnessHome]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('an evidence fingerprint never reaches the learning, so the claim byte cap measures the same bytes with or without it', t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-quote-cap-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plain = '---\ntitle: "export example value"\nkind: fix\ndate: 2026-11-01\n---\n\nThe example module must export the value two.\n';
  const quoted = plain.replace('date: 2026-11-01\n', `date: 2026-11-01\nevidence_sha256: ${QUOTE_SHA}\nevidence_bytes: 600\n`);
  let n = 0;
  // Equal-length episode names, so only the episode content differs.
  const add = (name, text, body) => {
    const ws = path.join(dir, `ws${++n}`), home = path.join(dir, `home${n}`);
    fs.mkdirSync(path.join(ws, 'docs/solutions/logic'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'docs/solutions/logic', name), text);
    const ops = path.join(dir, `ops${n}.json`);
    fs.writeFileSync(ops, JSON.stringify({ schema: 1, ops: [{ op: 'ADD', domain: 'logic', slug: 'export-example', trigger: 'exporting the example value', body,
      episodes: [{ path: `docs/solutions/logic/${name}`, sha256: sha(text), kind: 'fix', plan: 'docs/plans/earlier.md' }] }] }));
    const result = applyOps({ workspace: ws, opsPath: ops, home });
    const file = path.join(storeDir(ws, { home }), 'learnings/logic/export-example.md');
    return { result, learning: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null };
  };
  const probe = add('plain1.md', plain, 'b');
  assert.equal(probe.result.exitCode, 0, JSON.stringify(probe.result.rejected));
  const overhead = Buffer.byteLength(probe.learning) - 1;
  const atCap = 'b'.repeat(LEARNING_BYTE_CAP - overhead);
  const quotedAtCap = add('quoted.md', quoted, atCap);
  assert.equal(quotedAtCap.result.exitCode, 0, JSON.stringify(quotedAtCap.result.rejected));
  assert.equal(Buffer.byteLength(quotedAtCap.learning), LEARNING_BYTE_CAP, 'a learning citing a fingerprinted episode sits exactly at the cap');
  assert.equal(/evidence_/.test(quotedAtCap.learning), false, 'the learning carries no evidence field');
  const over = add('quoted.md', quoted, `${atCap}b`);
  assert.equal(over.result.rejected[0]?.code, 'E_BYTE_CAP', 'one byte over the claim cap is still refused');
});
