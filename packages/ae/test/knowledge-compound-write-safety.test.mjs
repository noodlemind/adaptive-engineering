import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runInsightCompound } from '../lib/compound.mjs';
import { runRemember } from '../lib/knowledge/remember.mjs';
import { solutionsWriteTarget } from '../lib/project-layout.mjs';
import { trackWorkspaceSolutions } from './helpers/workspace.mjs';
import { EVIDENCE_QUOTE_CAP, evidenceQuoteError, readEvidenceQuote } from '../lib/knowledge/evidence-quote.mjs';
import { spawnSync } from 'node:child_process';
import { packageRoot } from './helpers/cli.mjs';

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('runInsightCompound does not write through a leftover symlinked docs/solutions directory', () => {
  const ws = tempDir('probeC-ws-');
  const copilotHome = tempDir('probeC-ch-');
  const home = tempDir('probeC-hh-');
  const outside = tempDir('probeC-outside-');

  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));

  const result = runInsightCompound({
    workspace: ws,
    copilotHome,
    home,
    flags: { title: 'probe insight', body: 'PROBE_C_WRITE_CONTENT should never land outside the workspace', category: 'insights' },
    log: () => {},
    kind: 'insight',
  });

  assert.equal(result.pass, true, JSON.stringify(result));
  const target = solutionsWriteTarget(ws, { home });
  assert.equal(target.kind, 'user');
  assert.ok(fs.existsSync(path.join(target.base, result.path)));
  assert.ok(!fs.existsSync(path.join(outside, 'insights')), 'nothing was written through the leftover symlink');
  assert.ok(fs.lstatSync(path.join(ws, 'docs', 'solutions')).isSymbolicLink(), 'the symlink itself is untouched');
});

test('runInsightCompound still writes normally when docs/solutions is a plain directory (no false-positive refusal)', () => {
  const ws = tempDir('probeC-ok-ws-');
  const copilotHome = tempDir('probeC-ok-ch-');
  const home = tempDir('probeC-ok-hh-');
  fs.mkdirSync(path.join(ws, 'docs', 'solutions'), { recursive: true });

  const result = runInsightCompound({
    workspace: ws,
    copilotHome,
    home,
    flags: { title: 'a normal insight', body: 'a normal insight body', category: 'insights' },
    log: () => {},
    kind: 'insight',
  });

  assert.equal(result.pass, true, JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.ok(result.path.startsWith('docs/solutions/insights/'));
  const target = solutionsWriteTarget(ws, { home });
  assert.equal(target.kind, 'user', 'an untracked leftover dir must not capture new episodes');
  assert.ok(fs.existsSync(path.join(target.base, result.path)), 'the episode file was actually written');
  assert.equal(fs.existsSync(path.join(ws, result.path)), false);
});

test('ae remember does not write its episode through a leftover symlinked docs/solutions directory', () => {
  const ws = tempDir('probeC-remember-ws-');
  const copilotHome = tempDir('probeC-remember-ch-');
  const harnessHome = tempDir('probeC-remember-hh-');
  const outside = tempDir('probeC-remember-outside-');

  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));

  const result = runRemember({
    workspace: ws,
    copilotHome,
    home: harnessHome,
    flags: { trigger: 'a probe trigger for the leftover symlink remember case' },
    argv: ['a probe claim that must never land outside the workspace'],
    log: () => {},
  });

  assert.equal(result.pass, true, JSON.stringify(result));
  const target = solutionsWriteTarget(ws, { home: harnessHome });
  assert.equal(target.kind, 'user');
  assert.ok(fs.existsSync(path.join(target.base, result.episodePath)));
  assert.ok(fs.readdirSync(outside).length === 0, 'nothing was written through the leftover symlink');
});

test('runInsightCompound refuses when git-tracked docs/solutions is a symlink', () => {
  const ws = tempDir('probeC-ts-ws-');
  const copilotHome = tempDir('probeC-ts-ch-');
  const home = tempDir('probeC-ts-hh-');
  const outside = tempDir('probeC-ts-out-');
  trackWorkspaceSolutions(ws);
  fs.rmSync(path.join(ws, 'docs', 'solutions'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));

  const result = runInsightCompound({
    workspace: ws,
    copilotHome,
    home,
    flags: { title: 'tracked symlink', body: 'must not land outside via a tracked symlink' },
    log: () => {},
    kind: 'insight',
  });

  assert.equal(result.pass, true, JSON.stringify(result));
  const target = solutionsWriteTarget(ws, { home });
  assert.equal(target.kind, 'user');
  assert.ok(fs.existsSync(path.join(target.base, result.episodePath || result.path)));
  assert.ok(!fs.existsSync(path.join(outside, 'insights')), 'a tracked symlink is not the write target');
});

// Quoted evidence (memory plan phase 5a) -----------------------------------
// Line and paragraph separators and the bidirectional marks (LRM, RLM, ALM).
// Also the zero-width and invisible format characters, BOM and tag characters.
// And the other default-ignorable code points: the combining grapheme joiner,
// the variation selectors, the Hangul fillers, U+17B4 and the musical format
// characters.
const INVISIBLE = [0x2028, 0x2029, 0x200e, 0x200f, 0x061c, 0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff, 0xe0000, 0xe0041, 0xe007f, 0x00ad, 0x180e, 0x206a, 0x206f, 0xfff9, 0xfffb, 0x034f, 0xfe00, 0xfe0f, 0x115f, 0x1160, 0x3164, 0xffa0, 0x17b4, 0x1d173, 0x1d17a];
function captureInsight(extraFlags = {}) {
  const ws = tempDir('quote-ws-');
  const copilotHome = tempDir('quote-ch-');
  const home = tempDir('quote-hh-');
  const result = runInsightCompound({
    workspace: ws,
    copilotHome,
    home,
    flags: { title: 'quoted insight', body: 'the retry loop masks the timeout', category: 'insights', captureDate: '2026-11-09', ...extraFlags },
    log: () => {},
    kind: 'insight',
  });
  const target = solutionsWriteTarget(ws, { home });
  const text = result.path ? fs.readFileSync(path.join(target.base, result.path), 'utf8') : null;
  const dir = path.join(target.base, 'docs/solutions/insights');
  const written = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  return { result, text, written };
}

test('an insight keeps a verbatim evidence quote as one escaped frontmatter line that reads back exactly', () => {
  const quote = 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n1 !== 2\n\n    at "retry.test.mjs":14:10\ttab';
  const { result, text } = captureInsight({ evidenceQuote: quote });
  assert.equal(result.pass, true, JSON.stringify(result));
  const line = text.split('\n').find(l => l.startsWith('evidence_quote: '));
  assert.ok(line, 'the quote is stored in frontmatter');
  assert.equal(readEvidenceQuote(text), quote, 'the stored quote decodes to the exact input bytes');
  assert.ok(text.endsWith('---\n\nthe retry loop masks the timeout\n'), 'the body is unchanged by the quote');
});

test('an insight evidence quote over 600 bytes is refused and nothing is written', () => {
  const { result, written } = captureInsight({ evidenceQuote: 'é'.repeat(301) });
  assert.equal(result.pass, false);
  assert.equal(result.exitCode, 2);
  assert.match(result.blockedReason, /at most 600 bytes/);
  assert.deepEqual(written, []);
  assert.equal(captureInsight({ evidenceQuote: 'x'.repeat(EVIDENCE_QUOTE_CAP) }).result.pass, true, 'exactly 600 bytes is accepted');
});

test('an insight evidence quote with a secret or terminal control codes is refused and nothing is written', () => {
  const secret = captureInsight({ evidenceQuote: 'auth failed for token ghp_' + 'x'.repeat(36) });
  assert.equal(secret.result.pass, false);
  assert.match(secret.result.blockedReason, /secret/);
  assert.ok(!secret.result.blockedReason.includes('ghp_'), 'the refusal does not echo the secret');
  assert.deepEqual(secret.written, []);
  for (const quote of ['\x1b[31mFAIL\x1b[0m retry.test.mjs', '\u009b31mFAIL\u009b0m retry.test.mjs', 'ok \u202eevil', 'ok \u2066isolate\u2069', ...INVISIBLE.map(point => `ok ${String.fromCodePoint(point)} x`)]) {
    const refused = captureInsight({ evidenceQuote: quote });
    assert.equal(refused.result.pass, false, JSON.stringify(quote));
    assert.match(refused.result.blockedReason, /control, bidirectional formatting, line separator, zero-width or tag/);
    assert.deepEqual(refused.written, []);
  }
  assert.equal(captureInsight({ evidenceQuote: 'line one\r\nline two' }).result.pass, true, 'CRLF output is accepted, as documented');
});

test('an insight evidence quote with a secret split across lines is refused', () => {
  const split = captureInsight({ evidenceQuote: `request failed\nAuthorization: Bearer\n${'abcdefghijklmnopqrstuvwxyz012345'}` });
  assert.equal(split.result.pass, false);
  assert.match(split.result.blockedReason, /secret/);
  assert.deepEqual(split.written, []);
  // A credential wrapped mid-token reassembles only with the break removed.
  for (const quote of ['postgres://reader:pw\r\n@db.invalid', `ghp_${'A'.repeat(18)}\n${'A'.repeat(18)}`, `ghp_${'A'.repeat(18)}  \r\n  ${'A'.repeat(18)} rejected`]) {
    const wrapped = captureInsight({ evidenceQuote: quote });
    assert.equal(wrapped.result.pass, false, JSON.stringify(quote));
    assert.match(wrapped.result.blockedReason, /secret split across lines/);
    assert.ok(!wrapped.result.blockedReason.includes('pw') && !wrapped.result.blockedReason.includes('ghp_'), 'the refusal does not echo the secret');
    assert.deepEqual(wrapped.written, []);
  }
  assert.equal(captureInsight({ evidenceQuote: 'expected 1\nreceived 2' }).result.pass, true, 'ordinary multi-line output still passes');
});

test('an insight evidence quote with a bare colour-code remnant against a secret is refused', () => {
  const remnant = captureInsight({ evidenceQuote: `error: [33mghp_${'A'.repeat(36)}[0m rejected` });
  assert.equal(remnant.result.pass, false);
  assert.match(remnant.result.blockedReason, /secret \(github-token\)/);
  assert.deepEqual(remnant.written, []);
});

test('an evidence quote that puts a URL and an @ on adjacent lines is refused, since a dotted user name reads the same', () => {
  for (const quote of ['Server listening on http://localhost:3000\nadmin@example.com logged in', 'GET https://registry.npmjs.org:443\n@types/node 404 Not Found', 'postgres://reader:hunter2pass\n@db.example', 'postgres://svc.user:2024\nWinterPass@prod.example.com']) {
    const wrapped = captureInsight({ evidenceQuote: quote });
    assert.equal(wrapped.result.pass, false, JSON.stringify(quote));
    assert.match(wrapped.result.blockedReason, /secret split across lines \(connection-string\)/);
    assert.ok(!wrapped.result.blockedReason.includes('WinterPass'), 'the refusal does not echo the secret');
    assert.deepEqual(wrapped.written, []);
  }
});

test('an insight evidence quote whose wrapped token follows another line is refused', () => {
  const wrapped = captureInsight({ evidenceQuote: `Authentication failed\nghp_${'A'.repeat(18)}\n${'B'.repeat(18)}` });
  assert.equal(wrapped.result.pass, false);
  assert.match(wrapped.result.blockedReason, /secret split across lines \(split-token\)/);
  assert.ok(!wrapped.result.blockedReason.includes('ghp_'), 'the refusal does not echo the secret');
  assert.deepEqual(wrapped.written, []);
});

test('ae compound --insight captures an accepted multi-line quote that the escaped line alone would look like a secret in', () => {
  const ws = tempDir('quote-ml-ws-');
  const home = tempDir('quote-ml-hh-');
  const copilotHome = tempDir('quote-ml-ch-');
  // Screened line by line and in the compact form, this holds no secret. Escaped
  // as JSON on one line, the break and tabs become `\n` and `\t`, which glue
  // the URL to the address into a false connection-string match.
  const quote = 'GET http://localhost:3000\nstatus\t401\tuser\tadmin@example.com';
  assert.equal(evidenceQuoteError(quote), null);
  const run = spawnSync(process.execPath, [path.join(packageRoot, 'bin/ae.mjs'), 'compound', '--insight', '--title', 'multi-line quote', '--body', 'the login retry masks a 401', '--evidence-quote', quote, '--workspace', ws, '--harness-home', home, '--copilot-home', copilotHome, '--json'],
    { cwd: ws, env: { ...process.env, HARNESS_HOME: home, COPILOT_HOME: copilotHome, HARNESS_NO_EVENTS: '1' }, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const out = JSON.parse(run.stdout);
  const text = fs.readFileSync(path.join(solutionsWriteTarget(ws, { home }).base, out.path), 'utf8');
  assert.equal(readEvidenceQuote(text), quote);
  // Every other field and the body are still scanned.
  const bodySecret = captureInsight({ evidenceQuote: quote, body: `see ghp_${'x'.repeat(36)}` });
  assert.equal(bodySecret.result.pass, false);
  assert.match(bodySecret.result.blockedReason, /github-token|secret/);
  assert.deepEqual(bodySecret.written, []);
});

test('an insight evidence quote with a bare colour-code remnant inside a token is refused', () => {
  const remnant = captureInsight({ evidenceQuote: `token ghp_${'A'.repeat(18)}[1m${'B'.repeat(18)}[0m` });
  assert.equal(remnant.result.pass, false);
  assert.match(remnant.result.blockedReason, /secret \(github-token\)/);
  assert.deepEqual(remnant.written, []);
});

test('ae compound --insight takes an --evidence-quote that starts with a diff header', () => {
  const ws = tempDir('quote-cli-ws-');
  const home = tempDir('quote-cli-hh-');
  const copilotHome = tempDir('quote-cli-ch-');
  const quote = '--- a/src/retry.mjs\n+++ b/src/retry.mjs\n@@ -1 +1 @@\n-retries = 0\n+retries = 3';
  const run = spawnSync(process.execPath, [path.join(packageRoot, 'bin/ae.mjs'), 'compound', '--insight', '--title', 'diff quote', '--body', 'retries matter', '--evidence-quote', quote, '--workspace', ws, '--harness-home', home, '--copilot-home', copilotHome, '--json'],
    { cwd: ws, env: { ...process.env, HARNESS_HOME: home, COPILOT_HOME: copilotHome, HARNESS_NO_EVENTS: '1' }, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const out = JSON.parse(run.stdout);
  const text = fs.readFileSync(path.join(solutionsWriteTarget(ws, { home }).base, out.path), 'utf8');
  assert.equal(readEvidenceQuote(text), quote);
});

test('ae compound refuses --evidence-quote without --insight or without a value', () => {
  const ws = tempDir('quote-flag-ws-');
  const home = tempDir('quote-flag-hh-');
  const copilotHome = tempDir('quote-flag-ch-');
  const ae = (...args) => spawnSync(process.execPath, [path.join(packageRoot, 'bin/ae.mjs'), 'compound', '--workspace', ws, '--harness-home', home, '--copilot-home', copilotHome, '--json', ...args],
    { cwd: ws, env: { ...process.env, HARNESS_HOME: home, COPILOT_HOME: copilotHome, HARNESS_NO_EVENTS: '1' }, encoding: 'utf8', timeout: 30000 });
  const noInsight = ae('--evidence-quote', 'Error: boom');
  assert.equal(noInsight.status, 2, 'a usage error');
  assert.match(noInsight.stdout + noInsight.stderr, /--evidence-quote is accepted only with --insight/);
  const swallowed = spawnSync(process.execPath, [path.join(packageRoot, 'bin/ae.mjs'), 'compound', '--insight', '--title', 'swallowed', '--body', 'body', '--evidence-quote', '--json', '--workspace', ws, '--harness-home', home, '--copilot-home', copilotHome],
    { cwd: ws, env: { ...process.env, HARNESS_HOME: home, COPILOT_HOME: copilotHome, HARNESS_NO_EVENTS: '1' }, encoding: 'utf8', timeout: 30000 });
  assert.equal(swallowed.status, 2, swallowed.stdout + swallowed.stderr);
  assert.match(swallowed.stdout + swallowed.stderr, /E_USAGE/);
  assert.match(swallowed.stdout + swallowed.stderr, /--evidence-quote needs a value but got the flag --json/);
  const noValue = ae('--insight', '--title', 'empty quote', '--body', 'body', '--evidence-quote');
  assert.equal(noValue.status, 2, 'a missing trailing value is a usage error');
  assert.match(noValue.stdout + noValue.stderr, /E_USAGE/);
  assert.match(noValue.stdout + noValue.stderr, /--evidence-quote needs a value/);
  const target = solutionsWriteTarget(ws, { home });
  assert.equal(fs.existsSync(path.join(target.base, 'docs/solutions/insights')), false, 'nothing is captured');
  const equalsForm = ae('--insight', '--title', 'flag-like quote', '--body', 'body', '--evidence-quote=--dry-run');
  assert.equal(equalsForm.status, 0, equalsForm.stdout + equalsForm.stderr);
  const captured = JSON.parse(equalsForm.stdout);
  assert.equal(readEvidenceQuote(fs.readFileSync(path.join(target.base, captured.path), 'utf8')), '--dry-run', 'the = form keeps a flag-like value as the quote');
  // The space form also catches a swallowed flag of this command: its own or a
  // global flag, alone or with =value, an alias, or -h/--help.
  for (const value of ['--category=logic', '--tags', '--workspace=/x', '-v', '-h', '--help']) {
    const swallowedValue = ae('--insight', '--title', `swallowed ${value}`, '--body', 'body', '--evidence-quote', value);
    assert.equal(swallowedValue.status, 2, swallowedValue.stdout + swallowedValue.stderr);
    assert.match(swallowedValue.stdout + swallowedValue.stderr, new RegExp(`needs a value but got the flag ${value}`));
  }
  // Diff lines, and dash-led text that is not a flag of this command, are
  // still quotes in the space form.
  for (const value of ['--- a/src/retry.mjs', '-  removed line', '--max-old-space-size=4096', '-x', '--foo=bar', '--insightful']) {
    const diff = ae('--insight', '--title', `diff ${value.length}`, '--body', 'body', '--evidence-quote', value);
    assert.equal(diff.status, 0, diff.stdout + diff.stderr);
    assert.equal(readEvidenceQuote(fs.readFileSync(path.join(target.base, JSON.parse(diff.stdout).path), 'utf8')), value);
  }
});

test('an insight without an evidence quote keeps the exact pre-quote episode bytes', () => {
  const { result, text } = captureInsight();
  assert.equal(result.pass, true, JSON.stringify(result));
  assert.equal(text, '---\ntitle: "quoted insight"\nkind: insight\ndate: 2026-11-09\n---\n\nthe retry loop masks the timeout\n');
  assert.equal(captureInsight({ evidenceQuote: null }).text, text, 'a null flag is the same as an absent one');
});
