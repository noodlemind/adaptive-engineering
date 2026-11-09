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
import { EXPOSURE_ENTRY_CAP, exposureRel, readExposure, recordExposure } from '../lib/learning-feedback.mjs';
import { projectStoreDir } from '../lib/project-layout.mjs';
import { writeChecks, writeVersionedPlan, initGit } from './helpers/cli-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const TRIGGER = 'exporting the example value from the module';

function feedbackFixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-feedback-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'product'), home = path.join(dir, 'home'), copilot = path.join(dir, 'copilot');
  fs.mkdirSync(ws);
  fs.mkdirSync(copilot);
  fs.writeFileSync(path.join(ws, '.gitignore'), '.harness/\n');
  fs.writeFileSync(path.join(ws, 'package.json'), '{"type":"module"}\n');
  const episode = '---\ntitle: "export example value"\nkind: fix\ndate: 2026-11-01\n---\n\nThe example module must export the value two.\n';
  fs.mkdirSync(path.join(ws, 'docs/solutions/logic'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'docs/solutions/logic/export.md'), episode);
  writeChecks(ws, { behavior: { command: [process.execPath, '-e', "import('./src/example.js').then(m => { if (m.value !== 2) process.exit(1); })"] } });
  fs.writeFileSync(path.join(ws, '.github/harness/policy.yaml'), 'version: 1\nenforcement: enforce\n');
  initGit(ws);
  approveProject({ workspace: ws, copilotHome: copilot, home });
  const ops = path.join(dir, 'ops.json');
  fs.writeFileSync(ops, JSON.stringify({ schema: 1, ops: [{ op: 'ADD', domain: 'logic', slug: 'export-example-value', trigger: TRIGGER,
    body: 'Export the example value as two from the example module.',
    episodes: [{ path: 'docs/solutions/logic/export.md', sha256: sha(episode), kind: 'fix', plan: 'docs/plans/earlier.md' }] }] }));
  const applied = applyOps({ workspace: ws, opsPath: ops, home });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.rejected));
  const env = { ...process.env, HARNESS_HOME: home, COPILOT_HOME: copilot, HARNESS_NO_EVENTS: '1', HARNESS_BIN: path.join(root, 'bin/ae.mjs') };
  delete env.HARNESS_ENFORCEMENT;
  const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'bin/ae.mjs'), ...args, '--workspace', ws, '--harness-home', home, '--copilot-home', copilot], { cwd: ws, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const plan = writeVersionedPlan(ws, { required: ['behavior'], criteria: { AC1: ['behavior'] } });
  return { ws, home, copilot, cli, plan };
}

function decide(f, value) {
  const file = path.join(f.ws, '.harness', `decision-${value.operation}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return f.cli('compound', '--plan', f.plan, '--learning-decision', file, '--json');
}

function verifiedAfterOrient(f) {
  const oriented = f.cli('orient', '--plan', f.plan, '--query', TRIGGER, '--json');
  assert.equal(oriented.status, 0, oriented.stderr || oriented.stdout);
  const out = JSON.parse(oriented.stdout);
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  const verified = f.cli('verify', '--plan', f.plan, '--base', 'HEAD', '--json');
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  return out;
}

test('orient records delivered learnings and a decision can judge only those learnings', t => {
  const f = feedbackFixture(t);
  const out = verifiedAfterOrient(f);
  assert.deepEqual(out.deliveredLearnings, ['logic/export-example-value']);
  const exposure = readExposure(f.ws, f.plan);
  assert.equal(exposure.entries.length, 1);
  assert.equal(exposure.entries[0].id, 'logic/export-example-value');
  assert.equal(exposure.entries[0].count, 1);
  assert.match(exposure.entries[0].version, /^[a-f0-9]{64}$/);

  const unknown = decide(f, { operation: 'judge-unknown', decision: 'no-learning', rationale: 'No new lesson.', recalled: [{ id: 'logic/never-shown', verdict: 'wrong' }] });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stdout + unknown.stderr, /never delivered/);

  const judged = decide(f, { operation: 'judge-known', decision: 'no-learning', rationale: 'No new lesson.', recalled: [{ id: 'logic/export-example-value', verdict: 'helped', note: 'Pointed straight at the export.' }] });
  assert.equal(judged.status, 0, judged.stderr || judged.stdout);
  const result = JSON.parse(judged.stdout);
  assert.equal(result.feedbackRecord.written, true);
  const record = JSON.parse(fs.readFileSync(result.feedbackRecord.path, 'utf8'));
  assert.equal(record.plan, f.plan);
  assert.deepEqual(record.recalled.map(({ id, verdict }) => ({ id, verdict })), [{ id: 'logic/export-example-value', verdict: 'helped' }]);
  assert.equal(record.recalled[0].version, exposure.entries[0].version);
  assert.ok(result.feedbackRecord.path.startsWith(projectStoreDir(f.ws, { home: f.home })));

  const stored = JSON.parse(fs.readFileSync(path.join(f.ws, result.learningRecord), 'utf8'));
  assert.equal(stored.decision.recalled[0].note, 'Pointed straight at the export.');
  const replay = decide(f, { operation: 'judge-known', decision: 'no-learning', rationale: 'No new lesson.', recalled: [{ id: 'logic/export-example-value', verdict: 'helped', note: 'Pointed straight at the export.' }] });
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).replayed, true);
  assert.equal(JSON.parse(replay.stdout).feedbackRecord.written, false);
});

test('a decision without feedback fields keeps the decision bytes and writes no feedback record', t => {
  const f = feedbackFixture(t);
  verifiedAfterOrient(f);
  const value = { operation: 'plain-decision', decision: 'no-learning', rationale: 'No reusable lesson.' };
  const result = decide(f, value);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const out = JSON.parse(result.stdout);
  assert.equal(out.feedbackRecord, undefined);
  const stored = JSON.parse(fs.readFileSync(path.join(f.ws, out.learningRecord), 'utf8'));
  assert.deepEqual(stored.decision, value);
  const proof = stored.proof.verificationIdentity;
  assert.equal(stored.digest, sha(JSON.stringify({ decision: value, proof })));
  assert.equal(fs.existsSync(path.join(projectStoreDir(f.ws, { home: f.home }), 'feedback')), false);
});

test('finding dispositions must name findings from this plan\'s review records', t => {
  const f = feedbackFixture(t);
  verifiedAfterOrient(f);
  const id = 'a'.repeat(64);
  fs.mkdirSync(path.join(f.ws, '.harness/reviews/records'), { recursive: true });
  fs.writeFileSync(path.join(f.ws, '.harness/reviews/records', `${'b'.repeat(64)}.json`), JSON.stringify({ version: 2, plan: f.plan, findings: [{ id, reviewers: ['correctness'], severity: 'P2' }] }));
  fs.writeFileSync(path.join(f.ws, '.harness/reviews/records', `${'c'.repeat(64)}.json`), JSON.stringify({ version: 2, plan: 'docs/plans/other.md', findings: [{ id: 'd'.repeat(64), reviewers: ['security'] }] }));
  const foreign = decide(f, { operation: 'foreign-finding', decision: 'no-learning', rationale: 'No lesson.', findings: [{ id: 'd'.repeat(64), disposition: 'fixed' }] });
  assert.notEqual(foreign.status, 0);
  const secret = decide(f, { operation: 'secret-note', decision: 'no-learning', rationale: 'No lesson.', findings: [{ id, disposition: 'dismissed', note: 'token ghp_' + 'x'.repeat(36) }] });
  assert.notEqual(secret.status, 0);
  assert.match(secret.stdout + secret.stderr, /secret/);
  const fixedId = 'e'.repeat(64);
  fs.writeFileSync(path.join(f.ws, '.harness/reviews/records', `${'f'.repeat(64)}.json`), JSON.stringify({ version: 2, plan: f.plan, findings: [{ id: fixedId, reviewers: ['tests'] }] }));
  fs.mkdirSync(path.join(f.ws, '.harness/reviews/latest'), { recursive: true });
  fs.writeFileSync(path.join(f.ws, '.harness/reviews/latest', `${sha(JSON.stringify(f.plan))}.json`), JSON.stringify({ version: 2, id: 'b'.repeat(64) }));
  const ok = decide(f, { operation: 'own-finding', decision: 'no-learning', rationale: 'No lesson.', findings: [{ id, disposition: 'fixed', note: 'Guarded the null path.' }, { id: fixedId, disposition: 'fixed' }] });
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);
  const record = JSON.parse(fs.readFileSync(JSON.parse(ok.stdout).feedbackRecord.path, 'utf8'));
  assert.deepEqual(record.findings, [
    { id, disposition: 'fixed', reviewers: ['correctness'], observed: 'still-reported', note: 'Guarded the null path.' },
    { id: fixedId, disposition: 'fixed', reviewers: ['tests'], observed: 'no-longer-reported' },
  ], 'Harness records its own observation beside each claimed disposition');
  assert.equal(record.readiness, undefined, 'no readiness decision was recorded for this plan');
  assert.ok(fs.existsSync(path.join(f.ws, exposureRel(f.plan))));
});

test('an exact replay reuses the accepted feedback after the exposure cap evicts its learning', t => {
  const f = feedbackFixture(t);
  verifiedAfterOrient(f);
  const value = { operation: 'judge-then-evict', decision: 'no-learning', rationale: 'No new lesson.', recalled: [{ id: 'logic/export-example-value', verdict: 'helped' }] };
  const first = decide(f, value);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const accepted = JSON.parse(first.stdout).feedbackRecord;
  assert.equal(accepted.written, true);
  const later = Array.from({ length: EXPOSURE_ENTRY_CAP }, (_, i) => ({ id: `logic/later-${String(i).padStart(3, '0')}` }));
  recordExposure({ recordRoot: f.ws, workspace: f.ws, home: f.home, planPath: f.plan, delivered: later, now: new Date(Date.now() + 60000) });
  assert.equal(readExposure(f.ws, f.plan).entries.some(entry => entry.id === 'logic/export-example-value'), false, 'the judged learning was evicted');
  const replay = decide(f, value);
  assert.equal(replay.status, 0, replay.stderr || replay.stdout);
  const out = JSON.parse(replay.stdout);
  assert.equal(out.replayed, true);
  assert.deepEqual(out.feedbackRecord, { path: accepted.path, written: false });
  const fresh = decide(f, { ...value, operation: 'judge-evicted-new' });
  assert.notEqual(fresh.status, 0, 'a new operation still validates against current exposure');
  assert.match(fresh.stdout + fresh.stderr, /never delivered/);
});

test('a replay after eviction reuses a legacy feedback record only when its authored verdicts match', t => {
  const f = feedbackFixture(t);
  verifiedAfterOrient(f);
  const value = { operation: 'judge-legacy', decision: 'no-learning', rationale: 'No new lesson.', recalled: [{ id: 'logic/export-example-value', verdict: 'helped', note: '' }] };
  const first = decide(f, value);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  // Rewrite the accepted record as one saved before keys carried the digest.
  const keyed = JSON.parse(first.stdout).feedbackRecord.path;
  const { digest, ...stored } = JSON.parse(fs.readFileSync(keyed, 'utf8'));
  assert.match(digest, /^[a-f0-9]{64}$/);
  const legacy = path.join(path.dirname(keyed), `${stored.operation}.json`);
  fs.rmSync(keyed);
  const later = Array.from({ length: EXPOSURE_ENTRY_CAP }, (_, i) => ({ id: `logic/later-${String(i).padStart(3, '0')}` }));
  recordExposure({ recordRoot: f.ws, workspace: f.ws, home: f.home, planPath: f.plan, delivered: later, now: new Date(Date.now() + 60000) });

  fs.writeFileSync(legacy, `${JSON.stringify(stored, null, 2)}\n`);
  const matching = decide(f, value);
  assert.equal(matching.status, 0, matching.stderr || matching.stdout);
  assert.deepEqual(JSON.parse(matching.stdout).feedbackRecord, { path: legacy, written: false }, 'an empty note matches a stored record without one');

  fs.writeFileSync(legacy, `${JSON.stringify({ ...stored, recalled: [{ ...stored.recalled[0], verdict: 'wrong' }] }, null, 2)}\n`);
  const differing = decide(f, value);
  assert.equal(differing.status, 0, differing.stderr || differing.stdout);
  const out = JSON.parse(differing.stdout).feedbackRecord;
  assert.equal(out.written, false);
  assert.equal(out.path, undefined, 'a legacy record with different verdicts is not this decision\'s record');
  assert.match(out.reason, /never delivered/);
});
