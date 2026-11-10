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
import { normalizeEvidenceLine, evidenceLineError, evidenceFingerprint, matchEvidence, evidencePrefixError, evidenceBytesError, compoundJournalArgv, readEvidenceFingerprint, EVIDENCE_LINE_CAP } from '../lib/knowledge/evidence-fingerprint.mjs';
import { writeChecks, writeVersionedPlan, initGit } from './helpers/cli-fixtures.mjs';
import { beforeDeliveryTool, runDeliveryCommand } from '../lib/agent-delivery.mjs';

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

test('normalisation strips a BOM and escapes, trims both ends, applies NFC, and caps the normalised line', () => {
  assert.equal(normalizeEvidenceLine('\ufeff  FAIL retry \t '), 'FAIL retry');
  assert.equal(normalizeEvidenceLine('Cafe\u0301 failed'), 'Caf\u00e9 failed', 'NFC composes combining marks');
  assert.equal(evidenceFingerprint('Cafe\u0301 failed').sha256, sha('Caf\u00e9 failed'));
  assert.deepEqual(matchEvidence('\ufeffCafe\u0301 failed  \n', sha('Caf\u00e9 failed')), { matched: true, line: 1 }, 'match normalises identically');
  assert.deepEqual(matchEvidence(`   ${QUOTE}`, QUOTE_SHA), { matched: true, line: 1 }, 'leading blanks are trimmed at match too');
  // An unterminated OSC loses only its ESC; it does not swallow the line.
  assert.equal(normalizeEvidenceLine(`\x1b]0;title ${QUOTE}`), `]0;title ${QUOTE}`);
  assert.equal(normalizeEvidenceLine('\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\ ok'), 'link ok', 'a terminated OSC is removed whole');
  assert.match(evidenceLineError(`\u009d0;title ${QUOTE}`), /no other control characters/, 'an unterminated C1 OSC is a control character');
  // The 600-byte cap applies to the normalised line; raw input may carry colour codes up to 4 KB.
  const coloured = `\x1b[31m${'x'.repeat(EVIDENCE_LINE_CAP)}\x1b[0m`;
  assert.equal(evidenceLineError(coloured), null);
  assert.equal(evidenceFingerprint(coloured).bytes, EVIDENCE_LINE_CAP);
  assert.match(evidenceLineError(`${'x'.repeat(EVIDENCE_LINE_CAP)}y`), /at most 600 bytes/);
  assert.match(evidenceLineError(`${'\x1b[0m'.repeat(1100)}x`), /input must be at most 4096 bytes/, 'raw input over 4 KB is refused');
});

test('the compound journal argv replaces every evidence value, accepted or refused, in both forms', () => {
  assert.deepEqual(compoundJournalArgv(['--insight', '--title', 't', '--evidence-quote', `--- ${MARKER}`, '--json']), ['--insight', '--title', 't', '--evidence-quote', '<evidence>', '--json']);
  assert.deepEqual(compoundJournalArgv([`--evidence-quote=${MARKER}\nsecond`, '--evidence-quote', '-', '--evidence-quote']), ['--evidence-quote=<evidence>', '--evidence-quote', '-', '--evidence-quote']);
  // An unquoted line splits into positionals, and `--` carries literal text: both are only counted.
  assert.deepEqual(compoundJournalArgv(['--insight', '--evidence-quote', 'not', 'ok', MARKER, '--', `${MARKER} line`]), ['--insight', '--evidence-quote', '<positionals:3>']);
  assert.deepEqual(compoundJournalArgv(['--learning-decision', '-', MARKER]), ['--learning-decision', '<positionals:1>']);
  // Beside stray arguments, flag-shaped fragments of the line keep only their names.
  assert.deepEqual(compoundJournalArgv(['--insight', '--evidence-quote', '-', 'SECRETM:', '--claim', 'SECRETNVALUE', 'was', '--tags=SECRETO,x']), ['--insight', '--evidence-quote', '--claim', '--tags', '<positionals:2>']);
  assert.deepEqual(compoundJournalArgv(['--learning-decision=-', '--title', 'SECRETT', '--', 'x']), ['--learning-decision', '--title', '<positionals:1>']);
  assert.deepEqual(compoundJournalArgv(['--insight', '--title', 'kept', '--claim', 'kept too']), ['--insight', '--title', 'kept', '--claim', 'kept too'], 'without stray arguments values are kept');
});

test('a line that looks like a credential is refused by pattern name only, never echoed', () => {
  const token = `ghp_${'A1b2C3d4'.repeat(5)}`;
  for (const line of [`FAIL auth ${token}`, `\x1b[31mFAIL\x1b[0m Authorization: Bearer ${'k'.repeat(24)}`]) {
    const error = evidenceLineError(line);
    assert.match(error, /looks like it holds a credential/);
    assert.ok(!error.includes(token) && !error.includes('kkkk'), error);
  }
  assert.equal(evidenceLineError(QUOTE), null);
});

test('matching skips lines outside the length window, so many short lines stay fast', () => {
  const lines = Array.from({ length: 400000 }, (_, i) => i.toString(36));
  const output = `${lines.join('\n')}\n${QUOTE}\n`;
  const started = Date.now();
  assert.deepEqual(matchEvidence(output, QUOTE_SHA, { bytes: Buffer.byteLength(QUOTE) }), { matched: true, line: lines.length + 1 });
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.deepEqual(matchEvidence(`ab\n${'ab\n'.repeat(1000)}${QUOTE}`, QUOTE_SHA), { matched: true, line: 1002 }, 'repeated lines are hashed once and still counted');
  assert.deepEqual(matchEvidence(`${'y'.repeat(700)}\n`, sha('y'.repeat(700))), { matched: false, line: null }, 'a line over the cap never matches');
});

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
  assert.equal(evidencePrefixError(QUOTE_SHA.toUpperCase()), null, 'upper-case hex is accepted');
  assert.deepEqual(matchEvidence(output, QUOTE_SHA.slice(0, 12).toUpperCase()), { matched: true, line: 2 });
  for (const bad of ['', 'abc', QUOTE_SHA.slice(0, 11), `${QUOTE_SHA}0`, 'zzzzzzzzzzzz']) assert.ok(evidencePrefixError(bad), bad);
  assert.equal(evidenceBytesError('57'), null);
  for (const bad of ['0', '601', '-1', '1.5', 'x', '']) assert.ok(evidenceBytesError(bad), bad);
  assert.deepEqual(readEvidenceFingerprint({ evidence_sha256: QUOTE_SHA, evidence_bytes: '57' }), { sha256: QUOTE_SHA, bytes: 57 });
  assert.equal(readEvidenceFingerprint({ evidence_sha256: 'abc', evidence_bytes: '5' }), null);
  assert.equal(readEvidenceFingerprint({ evidence_sha256: QUOTE_SHA, evidence_bytes: '601' }), null);
  assert.equal(readEvidenceFingerprint({ evidence_quote: QUOTE }), null, 'an evidence_quote key is never read');
});

function verifiedFixture(t, { events = false } = {}) {
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
  if (events) delete env.HARNESS_NO_EVENTS;
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
  const flagged = f.cli(['compound', '--plan', f.plan, '--learning-decision', '-', '--evidence-quote', '-', '--json'], JSON.stringify(publish('quote-flag')));
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
  const sized = ae(['--match-evidence', prefix.toUpperCase(), '--evidence-bytes', String(Buffer.byteLength(QUOTE)), '--check-output', 'out.txt']);
  assert.equal(sized.status, 0, sized.stdout + sized.stderr);
  assert.equal(ae(['--match-evidence', prefix, '--evidence-bytes', '7', '--check-output', 'out.txt']).status, 1, 'a different stored length does not match');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'empty.txt'), '');
  fs.writeFileSync(path.join(dir, 'blank.txt'), '\n \n');
  for (const args of [['--match-evidence', 'abc', '--check-output', 'out.txt'], ['--match-evidence', prefix], ['--match-evidence', prefix, '--check-output', 'out.txt', '--insight'],
    ['--match-evidence', prefix, '--check-output', 'missing.txt'], ['--match-evidence', prefix, '--check-output', 'sub'], ['--match-evidence', prefix, '--check-output', 'out.txt', '--title', 't'],
    ['--match-evidence', prefix, '--check-output', 'out.txt', '--category=logic'], ['--match-evidence', prefix, '--check-output', 'out.txt', '--evidence-bytes', '0'], ['--check-output', 'out.txt'],
    // Stray arguments, and empty output (nothing re-run), are usage errors, never a mismatch.
    ['--match-evidence', prefix, '--check-output', 'out.txt', 'stray'], ['--match-evidence', prefix, '--check-output', 'out.txt', '--', 'x'], ['--match-evidence', prefix, '--check-output', '-'],
    ['--match-evidence', prefix, '--check-output', 'empty.txt'], ['--match-evidence', prefix, '--check-output', 'blank.txt']]) {
    const usage = ae(args);
    assert.equal(usage.status, 2, `${args.join(' ')}: ${usage.stdout}${usage.stderr}`);
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['blank.txt', 'empty.txt', 'out.txt', 'sub'], 'a match writes nothing');
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

test('with events and the run journal on, no capture path leaves the evidence line in any file', t => {
  const f = verifiedFixture(t, { events: true });
  const insight = (args, input) => f.cli(['compound', '--insight', '--title', `insight ${args.length}`, '--body', 'retries matter', ...args, '--json'], input);
  const accepted = [
    insight(['--evidence-quote', '-'], `${QUOTE} piped\n`),
    insight(['--evidence-quote=-'], `--- a/${MARKER}.mjs\t2026-11-01\n`),
    decide(f, publish('quote-events', { evidence_quote: QUOTE })),
  ];
  for (const [i, run] of accepted.entries()) assert.equal(run.status, 0, `${i}: ${run.stdout}${run.stderr}`);
  const refused = [
    // The line in argv, in any form, is refused and never journaled.
    insight(['--evidence-quote', QUOTE]),
    insight([`--evidence-quote=${QUOTE} equals`]),
    insight(['--evidence-quote', `--- a/${MARKER}.mjs`]),
    insight(['--evidence-quote', 'not', 'ok', MARKER]),
    insight(['--evidence-quote', '-', '--', `${MARKER} after the boundary`], 'FAIL retry\n'),
    insight(['--evidence-quote', '-', 'not', 'ok', MARKER], 'FAIL retry\n'),
    insight([`--evidence-quote=${MARKER} one\nline two`]),
    insight(['--evidence-quote', `${MARKER}${'x'.repeat(700)}`]),
    insight(['--evidence-quote', `${MARKER} bell \x07`]),
    insight(['--evidence-quote', '-'], `${MARKER} one\ntwo\n`),
    decide(f, publish('quote-events-bad', { evidence_quote: `${MARKER}\nsecond` })),
    f.cli(['compound', '--plan', f.plan, '--learning-decision', '-', '--json'], `{"operation":"bad-json","evidence_quote":"${MARKER}" oops}`),
  ];
  for (const [i, run] of refused.entries()) {
    assert.notEqual(run.status, 0, `${i}: ${run.stdout}`);
    assert.ok(!(run.stdout + run.stderr).includes(MARKER), `refusal ${i} echoes the line: ${run.stdout}${run.stderr}`);
  }
  assert.match(refused.at(-1).stdout + refused.at(-1).stderr, /Learning decision is not valid JSON/);
  const journals = walk(f.dir).filter(file => file.endsWith('.jsonl'));
  assert.ok(journals.some(file => path.basename(file) === 'runs.jsonl'), `the run journal is on: ${journals.join(', ')}`);
  assert.ok(journals.some(file => fs.readFileSync(file, 'utf8').includes('<evidence>')), 'the journal records the placeholder');
  assert.ok(journals.some(file => fs.readFileSync(file, 'utf8').includes('command.start')), 'events are on');
  assert.deepEqual(filesHolding(f.dir, MARKER), [], 'no file anywhere, journal and events included, holds the line');
});

test('stray fragments of an unquoted line, flag-shaped or not, never reach the run journal, events or output', t => {
  const f = verifiedFixture(t, { events: true });
  const runs = [
    // Refused in dispatch before the journal opens.
    f.cli(['compound', '--insight', '--title', 't', '--evidence-quote', '-', 'SECRETM:', '--claim', 'SECRETNVALUE', 'was', '--tags=SECRETO,x'], 'FAIL retry\n'),
    f.cli(['compound', '--plan', f.plan, '--learning-decision', '-', 'SECRETQ', '--title', 'SECRETR'], '{}'),
    // An unknown flag beside a stdin-only flag is reported without its name.
    f.cli(['compound', '--insight', '--title', 't', '--evidence-quote', '-', '--SECRETP'], 'FAIL retry\n'),
    f.cli(['compound', '--plan', f.plan, '--learning-decision=-', 'stray', '--SECRETS=x'], '{}'),
  ];
  for (const [i, run] of runs.entries()) {
    assert.equal(run.status, 2, `${i}: ${run.stdout}${run.stderr}`);
    assert.ok(!(run.stdout + run.stderr).includes('SECRET'), `run ${i} echoes a fragment: ${run.stdout}${run.stderr}`);
  }
  assert.match(runs[0].stdout + runs[0].stderr, /no positional arguments/);
  assert.match(runs[2].stdout + runs[2].stderr, /unknown flag/);
  assert.deepEqual(filesHolding(f.dir, 'SECRET'), [], 'no fragment reaches runs.jsonl, events or any other file');
  const unknown = f.cli(['compound', '--insight', '--SECRETU']);
  assert.match(unknown.stdout + unknown.stderr, /unknown flag: --SECRETU/, 'without a stdin-only flag the name is still shown');
  // A file-based decision with no stray argument, and every other command, still name the flag.
  const typo = f.cli(['compound', '--plan', f.plan, '--learning-decision', 'decision.json', '--plna']);
  assert.match(typo.stdout + typo.stderr, /unknown flag: --plna/);
  for (const args of [['domain', 'status', '--learning-decision', '-', '--bogusflag'], ['status', '--bogusflag'], ['agent', 'task', '--evidence-quote', '-', '--bogusflag']]) {
    const run = f.cli(args);
    assert.match(run.stdout + run.stderr, /(?:unknown flag:|unsupported option) --(?:bogusflag|evidence-quote)/, `${args.join(' ')}: ${run.stdout}${run.stderr}`);
  }
});

test('--learning-decision=- takes the stdin path with all its checks', t => {
  const f = verifiedFixture(t);
  const piped = f.cli(['compound', '--plan', f.plan, '--learning-decision=-', '--json'], JSON.stringify(publish('quote-equals', { evidence_quote: QUOTE })));
  assert.equal(piped.status, 0, piped.stdout + piped.stderr);
  assert.deepEqual(JSON.parse(piped.stdout).evidence, { sha256_prefix: QUOTE_SHA.slice(0, 12), bytes: Buffer.byteLength(QUOTE) });
  const stray = f.cli(['compound', '--plan', f.plan, '--learning-decision=-', MARKER], '{}');
  assert.equal(stray.status, 2);
  assert.ok(!(stray.stdout + stray.stderr).includes(MARKER));
  const file = path.join(f.ws, 'decision.json');
  fs.writeFileSync(file, JSON.stringify(publish('quote-equals-file', { evidence_quote: QUOTE })));
  const fromFile = f.cli(['compound', '--plan', f.plan, `--learning-decision=${file}`, '--json']);
  fs.rmSync(file);
  assert.equal(fromFile.status, 2, fromFile.stdout + fromFile.stderr);
  assert.match(fromFile.stdout + fromFile.stderr, /accepted only from stdin/);
  assert.deepEqual(filesHolding(f.dir, MARKER), []);
});

test('a script piping into --evidence-quote - under ae bash or ae exec is journaled and audited only as length and digest', t => {
  const f = verifiedFixture(t, { events: true });
  fs.mkdirSync(path.join(f.copilot, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(f.copilot, 'harness', 'config.yaml'), 'version: 1\nexec.bash_enabled: true\n');
  const inner = (title) => `printf '%s\\n' '${QUOTE}' | '${process.execPath}' '${path.join(root, 'bin/ae.mjs')}' compound --insight --title '${title}' --body 'retries matter' --evidence-quote - --workspace '${f.ws}' --harness-home '${f.home}' --copilot-home '${f.copilot}' --json`;
  const ae = (...args) => spawnSync(process.execPath, [path.join(root, 'bin/ae.mjs'), ...args], { cwd: f.ws, env: { ...process.env, HARNESS_HOME: f.home, COPILOT_HOME: f.copilot, HARNESS_ENFORCEMENT: '' }, encoding: 'utf8', timeout: 30000 });
  const homes = ['--workspace', f.ws, '--harness-home', f.home, '--copilot-home', f.copilot];
  const bash = ae('bash', ...homes, '--', inner('via bash'));
  assert.equal(bash.status, 0, bash.stdout + bash.stderr);
  const exec = ae('exec', ...homes, '--', '/bin/sh', '-c', inner('via exec'));
  assert.equal(exec.status, 0, exec.stdout + exec.stderr);
  const runs = walk(f.dir).filter(file => path.basename(file) === 'runs.jsonl').map(file => fs.readFileSync(file, 'utf8')).join('');
  assert.match(runs, /<script:\d+b:[0-9a-f]{12}>/, 'the script is journaled as length and digest');
  assert.ok(walk(f.dir).some(file => file.endsWith('.jsonl') && fs.readFileSync(file, 'utf8').includes('"exec"')), 'the exec audit is on');
  assert.deepEqual(filesHolding(f.dir, MARKER), [], 'no journal, audit or episode holds the line');
});

test('a terminal on stdin is refused for --evidence-quote -, --learning-decision - and --check-output -, with a hint that never names the line', async t => {
  const tty = (await import('node:tty')).default;
  const { runCompound, runEvidenceMatch } = await import('../lib/compound.mjs');
  const original = tty.isatty;
  tty.isatty = fd => (fd === 0 ? true : original(fd));
  t.after(() => { tty.isatty = original; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-tty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const refused = error => {
    assert.equal(error.code, 'E_USAGE');
    assert.match(error.message, /stdin is a terminal/);
    assert.match(error.hint, /in the host shell, pipe/);
    assert.doesNotMatch(error.hint, /printf/, 'the hint never names the line in a command');
    return true;
  };
  await assert.rejects(runCompound({ workspace: dir, copilotHome: dir, flags: { workspace: dir, insight: true, title: 't', evidenceQuote: '-', evidenceQuoteCount: 1 } }), error => refused(error) && /sed -n/.test(error.hint));
  await assert.rejects(runCompound({ workspace: dir, copilotHome: dir, flags: { workspace: dir, learningDecision: '-' } }), error => refused(error) && /<<'EOF'/.test(error.hint));
  assert.throws(() => runEvidenceMatch({ workspace: dir, flags: { matchEvidence: QUOTE_SHA.slice(0, 12), checkOutput: '-' } }), refused);
});

test('under ae agent, a real child receives the piped decision through dispatchToolCall and stores only the fingerprint', async t => {
  const { dispatchToolCall, DELIVER_PROFILE } = await import('../lib/agent-loop.mjs');
  const f = verifiedFixture(t);
  const outcome = await dispatchToolCall({ id: 'call', name: 'harness', input: { argv: ['compound', '--plan', f.plan], decision: publish('quote-agent-loop', { evidence_quote: QUOTE }) } },
    { workspace: f.ws, copilotHome: f.copilot, harnessHome: f.home, profile: DELIVER_PROFILE, remainingSeconds: 60 });
  assert.equal(outcome.dispatched, true, outcome.reason);
  assert.equal(outcome.result.status, 'ok', JSON.stringify(outcome.result));
  // The tool result shows a bounded excerpt, so the stored episode is checked on disk.
  assert.match(JSON.stringify(outcome.result.output), /\\"pass\\":true/);
  const episodes = filesHolding(f.dir, `evidence_sha256: ${QUOTE_SHA}`);
  assert.equal(episodes.length, 1, 'the child received the decision on stdin and stored its fingerprint');
  assert.ok(fs.readFileSync(episodes[0], 'utf8').includes(`evidence_bytes: ${Buffer.byteLength(QUOTE)}`));
  assert.ok(!JSON.stringify(outcome).includes(MARKER), 'the tool result never carries the line');
  assert.deepEqual(filesHolding(f.dir, MARKER), [], 'nothing is staged on disk');
});

test('normalisation and matching stay linear on long runs of C1 OSC bytes, and very long output lines are skipped', () => {
  const started = process.hrtime.bigint();
  assert.equal(normalizeEvidenceLine('\u009d'.repeat(1 << 20)).length, 1 << 20);
  assert.deepEqual(matchEvidence(`${'\u009d'.repeat(1 << 20)}\n${QUOTE}\n`, QUOTE_SHA), { matched: true, line: 2 });
  assert.deepEqual(matchEvidence(`${'x'.repeat(70 * 1024)} ${QUOTE}`, QUOTE_SHA), { matched: false, line: null }, 'a line over 64 KB is skipped unread');
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 2000, 'a 1 MiB line of U+009D is handled quickly');
  assert.match(evidenceLineError('x'.repeat(5000)), /input must be at most 4096 bytes/, 'the raw cap has its own message');
});

test('a decision carrying evidence_quote is refused from a file, and the dry run then publish flow works over stdin', t => {
  const f = verifiedFixture(t);
  const file = path.join(f.ws, '.harness', 'decision.json');
  fs.writeFileSync(file, JSON.stringify(publish('quote-file', { evidence_quote: QUOTE })));
  const fromFile = f.cli(['compound', '--plan', f.plan, '--learning-decision', file, '--json']);
  assert.equal(fromFile.status, 2, fromFile.stdout + fromFile.stderr);
  assert.match(fromFile.stdout + fromFile.stderr, /evidence_quote is accepted only from stdin/);
  assert.ok(!(fromFile.stdout + fromFile.stderr).includes(MARKER));
  fs.rmSync(file);
  const plainFile = path.join(f.ws, '.harness', 'plain.json');
  fs.writeFileSync(plainFile, JSON.stringify(publish('plain-file')));
  assert.equal(f.cli(['compound', '--plan', f.plan, '--learning-decision', plainFile, '--json']).status, 0, 'a decision without evidence still works from a file');
  const value = publish('quote-dry-run', { evidence_quote: QUOTE });
  const dry = f.cli(['compound', '--plan', f.plan, '--learning-decision', '-', '--dry-run', '--json'], JSON.stringify(value));
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.equal(JSON.parse(dry.stdout).dryRun, true);
  const real = decide(f, value);
  assert.equal(real.status, 0, real.stdout + real.stderr);
  assert.deepEqual(JSON.parse(real.stdout).evidence, { sha256_prefix: QUOTE_SHA.slice(0, 12), bytes: Buffer.byteLength(QUOTE) });
  assert.deepEqual(filesHolding(f.dir, MARKER), []);
});

test('a capture over stdin and a later match agree across BOM, NFD, OSC and CRLF, and a mismatch is not recorded as a failed run', t => {
  const f = verifiedFixture(t, { events: true });
  const line = `Café ${MARKER} failed: expected 2`;
  const captured = f.cli(['compound', '--insight', '--title', 'round trip', '--body', 'retries matter', '--evidence-quote', '-', '--json'],
    `﻿\x1b]0;title\x07Café ${MARKER} failed: expected 2  \r\n`);
  assert.equal(captured.status, 0, captured.stdout + captured.stderr);
  const { sha256_prefix: prefix, bytes } = JSON.parse(captured.stdout).evidence;
  assert.equal(prefix, sha(line).slice(0, 12));
  fs.writeFileSync(path.join(f.ws, 'out.txt'), `TAP version 13\r\n\x1b[31m${line}\x1b[0m\r\n`);
  const match = f.cli(['compound', '--match-evidence', prefix, '--evidence-bytes', String(bytes), '--check-output', 'out.txt', '--json']);
  assert.equal(match.status, 0, match.stdout + match.stderr);
  assert.equal(JSON.parse(match.stdout).line, 2);
  const miss = f.cli(['compound', '--match-evidence', prefix, '--check-output', '-', '--json'], 'other output\n');
  assert.equal(miss.status, 1, miss.stdout + miss.stderr);
  const runs = fs.readFileSync(path.join(f.ws, '.harness/runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const last = runs.filter(r => r.command === 'compound').at(-1);
  assert.equal(runs.filter(r => r.run === last.run).at(-1).status, 'succeeded', 'a mismatch is an answer, not a failed run');
  const events = walk(f.dir).filter(file => path.basename(file) === 'events.jsonl').flatMap(file => fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)));
  const result = events.filter(e => e.type === 'command.result' && e.run === last.run).at(-1);
  assert.ok(result, 'events are on');
  assert.equal(result.status, 'ok');
  const alone = f.cli(['compound', '--evidence-bytes', '5', '--json']);
  assert.equal(alone.status, 2, '--evidence-bytes without --match-evidence is a usage error');
  assert.match(alone.stdout + alone.stderr, /used only with --match-evidence/);
  const lane = f.cli(['compound', '--insight', '--title', 'lane', '--body', 'retries matter', '--evidence-quote', `--output=${MARKER}`, '--json']);
  assert.equal(lane.status, 2, `a literal value that looks like --output is not an output lane: ${lane.stdout}${lane.stderr}`);
  assert.match(lane.stdout + lane.stderr, /takes only -/);
  assert.ok(!(lane.stdout + lane.stderr).includes(MARKER));
  const badLane = f.cli(['compound', '--learning-decision', '-', '--output', `${MARKER}`, '--json']);
  assert.equal(badLane.status, 2);
  assert.match(badLane.stderr, /not a known lane/);
  assert.deepEqual(filesHolding(f.dir, MARKER).filter(file => !file.endsWith('out.txt')), [], 'nothing but the test-written output holds the line');
});

test('under ae agent delivery, --check-output is confined to the workspace', () => {
  const workspace = process.cwd();
  const call = value => beforeDeliveryTool({ name: 'harness', input: { argv: ['compound', '--match-evidence', QUOTE_SHA.slice(0, 12), ...value, '--json'] } }, { workspace });
  assert.equal(call(['--check-output', 'out.txt']).pass, true);
  assert.equal(call(['--check-output', '..out.txt']).pass, true, 'a name starting with .. inside the workspace is kept');
  assert.equal(call(['--check-output', 'sub/..x/out.txt']).pass, true);
  // A delivered command's stdin carries only an inline decision, so - would read nothing.
  for (const value of [['--check-output', '-'], ['--check-output=-'], ['--check-output', '/etc/passwd'], ['--check-output=../outside.txt'], ['--check-output', '..'], ['--check-output', '.']]) assert.equal(call(value).pass, false, value.join(' '));
});

test('only stdin carries an evidence decision: spoofed, relative and symlinked staged paths are refused, and delivery pipes it', async t => {
  const f = verifiedFixture(t);
  const value = publish('quote-spoof', { evidence_quote: QUOTE });
  const spoofDir = path.join(os.tmpdir(), `harness-agent-decision-${process.pid}`);
  fs.mkdirSync(spoofDir, { recursive: true });
  t.after(() => fs.rmSync(spoofDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(spoofDir, 'decision.json'), JSON.stringify(value));
  const linked = path.join(f.ws, '.harness', 'harness-agent-decision-link');
  fs.symlinkSync(spoofDir, linked);
  fs.mkdirSync(path.join(f.ws, '.harness', 'harness-agent-decision-rel'), { recursive: true });
  fs.writeFileSync(path.join(f.ws, '.harness', 'harness-agent-decision-rel', 'decision.json'), JSON.stringify(value));
  for (const file of [path.join(spoofDir, 'decision.json'), path.join(linked, 'decision.json'), '.harness/harness-agent-decision-rel/decision.json']) {
    const run = f.cli(['compound', '--plan', f.plan, '--learning-decision', file, '--json']);
    assert.equal(run.status, 2, `${file}: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout + run.stderr, /accepted only from stdin/);
  }
  fs.rmSync(path.join(f.ws, '.harness', 'harness-agent-decision-rel'), { recursive: true });
  fs.rmSync(linked);
  fs.rmSync(spoofDir, { recursive: true, force: true });
  // Delivery hands the decision to the child's stdin; nothing is staged on disk.
  let piped;
  await runDeliveryCommand({ argv: ['compound', '--plan', f.plan, '--json'], decision: value }, async (argv, options = {}) => {
    assert.equal(argv[argv.indexOf('--learning-decision') + 1], '-');
    piped = f.cli(argv, options.input);
    return { status: 'ok' };
  });
  assert.equal(piped.status, 0, piped.stdout + piped.stderr);
  assert.deepEqual(JSON.parse(piped.stdout).evidence, { sha256_prefix: QUOTE_SHA.slice(0, 12), bytes: Buffer.byteLength(QUOTE) });
  assert.deepEqual(filesHolding(f.dir, MARKER), []);
});

test('the exec runner feeds an input string to the child stdin', async t => {
  const { execResultOf } = await import('../lib/exec-cmd.mjs');
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-exec-input-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await execResultOf(['--workspace', dir, '--harness-home', dir, '--copilot-home', dir, '--', process.execPath, '-e', "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log('got:'+s.length))"], {}, { input: 'x'.repeat(10) });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.ok(JSON.stringify(result.output).includes('got:10'), JSON.stringify(result.output));
});

test('a relative --check-output cannot follow a symlinked directory out of the workspace', t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-match-link-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'ws'), outside = path.join(dir, 'outside');
  fs.mkdirSync(ws); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'out.txt'), `${QUOTE}\n`);
  fs.writeFileSync(path.join(ws, 'out.txt'), `${QUOTE}\n`);
  fs.symlinkSync(outside, path.join(ws, 'linked'));
  const ae = (...args) => spawnSync(process.execPath, [path.join(root, 'bin/ae.mjs'), 'compound', '--match-evidence', QUOTE_SHA.slice(0, 12), ...args, '--workspace', ws, '--harness-home', dir, '--copilot-home', dir, '--json'],
    { cwd: ws, env: { ...process.env, HARNESS_NO_EVENTS: '1' }, encoding: 'utf8', timeout: 30000 });
  assert.equal(ae('--check-output', 'out.txt').status, 0);
  const escaped = ae('--check-output', 'linked/out.txt');
  assert.equal(escaped.status, 2, escaped.stdout + escaped.stderr);
  assert.match(escaped.stdout + escaped.stderr, /--check-output is missing, not a regular file/);
});
