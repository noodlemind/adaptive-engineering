import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runInsightCompound } from '../lib/compound.mjs';
import { runRemember } from '../lib/knowledge/remember.mjs';
import { solutionsWriteTarget } from '../lib/project-layout.mjs';
import { trackWorkspaceSolutions } from './helpers/workspace.mjs';
import { EVIDENCE_QUOTE_CAP, readEvidenceQuote } from '../lib/knowledge/evidence-quote.mjs';

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
  const ansi = captureInsight({ evidenceQuote: '\x1b[31mFAIL\x1b[0m retry.test.mjs' });
  assert.equal(ansi.result.pass, false);
  assert.match(ansi.result.blockedReason, /control characters/);
  assert.deepEqual(ansi.written, []);
});

test('an insight without an evidence quote keeps the exact pre-quote episode bytes', () => {
  const { result, text } = captureInsight();
  assert.equal(result.pass, true, JSON.stringify(result));
  assert.equal(text, '---\ntitle: "quoted insight"\nkind: insight\ndate: 2026-11-09\n---\n\nthe retry loop masks the timeout\n');
  assert.equal(captureInsight({ evidenceQuote: null }).text, text, 'a null flag is the same as an absent one');
});
