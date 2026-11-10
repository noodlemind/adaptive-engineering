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
import { storeDir } from '../lib/knowledge/store.mjs';
import { LEARNING_BYTE_CAP } from '../lib/knowledge/consolidate.mjs';
import { readEvidenceQuote } from '../lib/knowledge/evidence-quote.mjs';
import { writeChecks, writeVersionedPlan, initGit } from './helpers/cli-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const QUOTE = 'not ok 1 - example exports two # expected: 2, actual: 1';

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
  const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'bin/ae.mjs'), ...args, '--workspace', ws, '--harness-home', home, '--copilot-home', copilot], { cwd: ws, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const plan = writeVersionedPlan(ws, { required: ['behavior'], criteria: { AC1: ['behavior'] } });
  fs.writeFileSync(path.join(ws, 'src/example.js'), 'export const value = 2;\n');
  const verified = cli('verify', '--plan', plan, '--base', 'HEAD', '--json');
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  return { ws, home, copilot, cli, plan };
}

function decide(f, value) {
  const file = path.join(f.ws, '.harness', `decision-${value.operation}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return f.cli('compound', '--plan', f.plan, '--learning-decision', file, '--json');
}

const publish = (operation, extra = {}) => ({ operation, decision: 'publish', rationale: 'The export regression is reusable.', title: 'example export value', body: 'The example module must export the value two.', category: 'logic', ...extra });

test('a publish decision stores a verbatim evidence quote in the episode and refuses oversize, multi-line, secret or no-learning quotes', t => {
  const f = verifiedFixture(t);
  const oversize = decide(f, publish('quote-oversize', { evidence_quote: 'x'.repeat(601) }));
  assert.notEqual(oversize.status, 0);
  assert.match(oversize.stdout + oversize.stderr, /at most 600 bytes/);
  const secret = decide(f, publish('quote-secret', { evidence_quote: 'token ghp_' + 'x'.repeat(36) }));
  assert.notEqual(secret.status, 0);
  assert.match(secret.stdout + secret.stderr, /secret/);
  const multiLine = decide(f, publish('quote-multi-line', { evidence_quote: 'not ok 1 - example exports two\n  expected: 2\n  actual: 1' }));
  assert.notEqual(multiLine.status, 0);
  assert.match(multiLine.stdout + multiLine.stderr, /must be a single line; pick the single most specific failing line/);
  const noLearning = decide(f, { operation: 'quote-no-learning', decision: 'no-learning', rationale: 'Nothing new.', evidence_quote: QUOTE });
  assert.notEqual(noLearning.status, 0);
  assert.match(noLearning.stdout + noLearning.stderr, /only to a publish decision/);
  assert.equal(fs.existsSync(path.join(f.ws, '.harness/learning')) && fs.readdirSync(path.join(f.ws, '.harness/learning')).some(name => name !== '.ready.json'), false, 'refused decisions leave no learning record');

  const decisionFile = path.join(f.ws, '.harness', 'decision-quote-flag.json');
  fs.writeFileSync(decisionFile, JSON.stringify(publish('quote-flag')));
  const flagged = f.cli('compound', '--plan', f.plan, '--learning-decision', decisionFile, '--evidence-quote', QUOTE, '--json');
  assert.equal(flagged.status, 2, 'the CLI flag is a usage error rather than silently ignored');
  assert.match(flagged.stdout + flagged.stderr, /accepted only with --insight/);

  const accepted = decide(f, publish('quote-accepted', { evidence_quote: QUOTE }));
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  const out = JSON.parse(accepted.stdout);
  const episode = fs.readFileSync(out.publishedPath, 'utf8');
  assert.equal(readEvidenceQuote(episode), QUOTE);
  assert.ok(episode.endsWith('---\n\nThe example module must export the value two.\n'), 'the episode body carries no quote');
});

test('a publish decision without evidence_quote keeps its stored bytes, digest and episode shape', t => {
  const f = verifiedFixture(t);
  const value = publish('plain-publish');
  const result = decide(f, value);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const out = JSON.parse(result.stdout);
  const stored = JSON.parse(fs.readFileSync(path.join(f.ws, out.learningRecord), 'utf8'));
  assert.deepEqual(stored.decision, value, 'no evidence_quote key is added to the stored decision');
  assert.equal(stored.digest, sha(JSON.stringify({ decision: value, proof: stored.proof.verificationIdentity, destination: stored.destination })));
  const episode = fs.readFileSync(out.publishedPath, 'utf8');
  assert.equal(episode.includes('evidence_quote'), false);
  assert.equal(readEvidenceQuote(episode), null);
});

test('an evidence quote never reaches the learning, so the claim byte cap measures the same bytes with or without it', t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-quote-cap-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plain = '---\ntitle: "export example value"\nkind: fix\ndate: 2026-11-01\n---\n\nThe example module must export the value two.\n';
  const quoted = plain.replace('date: 2026-11-01\n', `date: 2026-11-01\nevidence_quote: ${JSON.stringify('y'.repeat(600))}\n`);
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
  assert.equal(Buffer.byteLength(quotedAtCap.learning), LEARNING_BYTE_CAP, 'a learning citing a quoted episode sits exactly at the cap');
  assert.equal(quotedAtCap.learning.includes('evidence_quote'), false, 'the learning carries no quote');
  const over = add('quoted.md', quoted, `${atCap}b`);
  assert.equal(over.result.rejected[0]?.code, 'E_BYTE_CAP', 'one byte over the claim cap is still refused');
});

