import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { runInsightCompound } from '../lib/compound.mjs';
import { runRemember } from '../lib/knowledge/remember.mjs';
import { solutionsWriteTarget } from '../lib/project-layout.mjs';
import { trackWorkspaceSolutions } from './helpers/workspace.mjs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { packageRoot } from './helpers/cli.mjs';

// Every fixture directory is removed when the file's tests finish.
const madeDirs = [];
after(() => { for (const dir of madeDirs) fs.rmSync(dir, { recursive: true, force: true }); });
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
}

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

// Evidence fingerprint (memory plan phase 5a) ------------------------------
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
// The stored fingerprint fields of an episode, or null.
function storedEvidence(text) {
  const hash = text.match(/^evidence_sha256: ([0-9a-f]{64})$/m);
  const bytes = text.match(/^evidence_bytes: (\d+)$/m);
  return hash && bytes ? { sha256: hash[1], bytes: Number(bytes[1]) } : null;
}

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

test('an insight stores only the sha256 and byte length of its evidence line, never the text', () => {
  const quote = 'AssertionError [ERR_ASSERTION]: QX7MARKER 1 !== 2 at "retry.test.mjs":14:10\ttab';
  const { result, text } = captureInsight({ evidenceQuote: `\x1b[31m${quote}\x1b[0m  ` });
  assert.equal(result.pass, true, JSON.stringify(result));
  assert.deepEqual(storedEvidence(text), { sha256: sha(quote), bytes: Buffer.byteLength(quote) }, 'colour codes and trailing blanks are removed before hashing');
  assert.deepEqual(result.evidence, { sha256_prefix: sha(quote).slice(0, 12), bytes: Buffer.byteLength(quote) });
  assert.ok(!text.includes('QX7MARKER') && !text.includes('evidence_quote'), text);
  assert.ok(!JSON.stringify(result).includes('QX7MARKER'), 'the result never shows the line');
  assert.ok(text.endsWith('---\n\nthe retry loop masks the timeout\n'), 'the body is unchanged');
});

test('an oversize, multi-line or control-holding insight evidence line is refused and nothing is written', () => {
  assert.equal(captureInsight({ evidenceQuote: 'x'.repeat(600) }).result.pass, true, 'exactly 600 bytes is accepted');
  for (const [quote, message] of [
    ['é'.repeat(301), /at most 600 bytes/],
    ['expected 1\nreceived QX7MARKER', /must be a single line/],
    ['line one\r\nline QX7MARKER', /must be a single line/],
    ['FAIL retry QX7MARKER', /must be a single line/],
    ['FAIL \x00 QX7MARKER', /no other control characters/],
  ]) {
    const refused = captureInsight({ evidenceQuote: quote });
    assert.equal(refused.result.pass, false, JSON.stringify(quote));
    assert.equal(refused.result.exitCode, 2);
    assert.match(refused.result.blockedReason, message);
    assert.ok(!refused.result.blockedReason.includes('QX7MARKER'), 'the refusal does not echo the line');
    assert.deepEqual(refused.written, []);
  }
  // The body and other fields are still secret-scanned as before.
  const bodySecret = captureInsight({ evidenceQuote: 'FAIL retry', body: `see ghp_${'x'.repeat(36)}` });
  assert.equal(bodySecret.result.pass, false);
  assert.match(bodySecret.result.blockedReason, /github-token|secret/);
});

const aeCli = (ws, home, copilotHome) => (args, input) => spawnSync(process.execPath, [path.join(packageRoot, 'bin/ae.mjs'), 'compound', '--workspace', ws, '--harness-home', home, '--copilot-home', copilotHome, '--json', ...args],
  { cwd: ws, input, env: { ...process.env, HARNESS_HOME: home, COPILOT_HOME: copilotHome, HARNESS_NO_EVENTS: '1' }, encoding: 'utf8', timeout: 30000 });

test('ae compound --insight --evidence-quote - fingerprints a dash-led line read from stdin', () => {
  const ws = tempDir('quote-cli-ws-');
  const home = tempDir('quote-cli-hh-');
  const copilotHome = tempDir('quote-cli-ch-');
  const quote = '--- a/src/retry.mjs\t2026-11-01 12:00:00';
  for (const flag of [['--evidence-quote', '-'], ['--evidence-quote=-']]) {
    const run = aeCli(ws, home, copilotHome)(['--insight', '--title', `diff quote ${flag.length}`, '--body', 'retries matter', ...flag], `${quote}\n`);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const text = fs.readFileSync(path.join(solutionsWriteTarget(ws, { home }).base, JSON.parse(run.stdout).path), 'utf8');
    assert.deepEqual(storedEvidence(text), { sha256: sha(quote), bytes: Buffer.byteLength(quote) });
  }
});

test('--evidence-quote takes only -, once, with --insight, and never echoes a refused value', () => {
  const ws = tempDir('quote-flag-ws-');
  const home = tempDir('quote-flag-hh-');
  const copilotHome = tempDir('quote-flag-ch-');
  const ae = aeCli(ws, home, copilotHome);
  const refused = [
    [['--insight', '--title', 't', '--body', 'b', '--evidence-quote', 'QX7MARKER boom'], /takes only - and reads the line from stdin/],
    [['--insight', '--title', 't', '--body', 'b', '--evidence-quote=QX7MARKER boom'], /takes only -/],
    [['--insight', '--title', 't', '--body', 'b', '--evidence-quote', '--json'], /takes only -/],
    [['--insight', '--title', 't', '--body', 'b', '--evidence-quote'], /takes only -/],
    [['--insight', '--title', 't', '--body', 'b', '--evidence-quote', '-', '--evidence-quote', '-'], /may be given only once/],
    [['--evidence-quote', '-'], /accepted only with --insight/],
    [['--insight', '--learning-decision', '-', '--evidence-quote', '-'], /cannot be combined with --learning-decision/],
    [['--learning-decision', '-', '--evidence-quote', '-'], /cannot be combined with --learning-decision/],
    // An unquoted line splits into positionals; `--` carries literal text.
    [['--insight', '--title', 't', '--body', 'b', '--evidence-quote', '-', 'not', 'ok', 'QX7MARKER'], /no positional arguments/],
    [['--insight', '--title', 't', '--body', 'b', '--evidence-quote', '-', '--', 'QX7MARKER line'], /no arguments after --/],
    [['--learning-decision', '-', 'QX7MARKER'], /no positional arguments/],
  ];
  for (const [args, message] of refused) {
    const run = ae(args, 'FAIL retry\n');
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout + run.stderr, message, args.join(' '));
    assert.ok(!(run.stdout + run.stderr).includes('QX7MARKER'), `the value is not echoed: ${args.join(' ')}`);
  }
  assert.equal(fs.existsSync(path.join(solutionsWriteTarget(ws, { home }).base, 'docs/solutions/insights')), false, 'nothing is captured');
});

test('an insight without an evidence line keeps the exact pre-evidence episode bytes', () => {
  const { result, text } = captureInsight();
  assert.equal(result.pass, true, JSON.stringify(result));
  assert.equal(text, '---\ntitle: "quoted insight"\nkind: insight\ndate: 2026-11-09\n---\n\nthe retry loop masks the timeout\n');
  assert.equal(result.evidence, undefined);
  assert.equal(captureInsight({ evidenceQuote: null }).text, text, 'a null flag is the same as an absent one');
});
