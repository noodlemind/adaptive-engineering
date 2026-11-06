import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createReviewTour, validateReviewTour } from '../lib/review-tour.mjs';
import { reviewHash } from '../lib/review-preparation.mjs';
import { synthesizeReview } from '../lib/review-synthesis.mjs';

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-review-tour-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const files = { 'src.js': 'export function run() { return save(); }\n', 'store.js': 'export function save() { return 1; }\n', 'test.js': 'assert.equal(run(), 1);\n' };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(workspace, name), text);
  const ref = file => ({ origin: 'product', path: file, state: 'regular', sha256: createHash('sha256').update(files[file]).digest('hex') });
  const contract = { version: 2, plan: null, kind: 'code', adaptive: { schema: 1, independentReview: true, tourRequired: true }, scope: { head: 'head-a', changedFiles: ['src.js', 'test.js'] }, preparation: { kind: 'document', sources: [], checks: [], refs: ['src.js', 'test.js'].map(ref) }, required: ['code-simplicity-reviewer'] };
  const packet = { ...contract, id: reviewHash(contract), createdAt: new Date().toISOString() };
  const source = (file, symbol) => ({ path: file, line: 1, symbol });
  const input = {
    schema: 1, packet: packet.id, purpose: 'Persist the result', before: 'The result was discarded.', after: 'The result is saved and returned.',
    context: { summary: 'The request delegates storage to the existing store.', components: [
      { id: 'request', label: 'Request', role: 'changed', source: source('src.js', 'run') },
      { id: 'store', label: 'Store', role: 'context', source: source('store.js', 'save') },
      { id: 'test', label: 'Behavior test', role: 'changed', source: source('test.js', 'assert.equal') },
    ], edges: [
      { from: 'request', to: 'store', claim: 'Saves result', kind: 'observed', evidence: [source('src.js', 'save')] },
      { from: 'test', to: 'request', claim: 'Checks returned result', kind: 'observed', evidence: [source('test.js', 'run')] },
    ] },
    readingOrder: [{ step: 'Follow the request into storage, then read the behavioral assertion.', component: 'request', code: [source('src.js', 'run')], tests: [source('test.js', 'assert.equal')] }],
    verification: [{ claim: 'The behavior test checks the returned value; execution is recorded separately.', refs: [source('test.js', 'assert.equal')] }],
    risks: ['Store availability still requires operational testing.'], questions: ['Is the storage failure behavior acceptable?'],
  };
  const args = { workspace, packet, currentScope: packet.scope };
  return { workspace, packet, input, args };
}

test('adaptive review rejects same-context coverage and binds actual external provider identity', () => {
  const result = { reviewer: 'code-simplicity-reviewer', status: 'completed', findings: [], residual_risks: [], testing_gaps: [], provenance: { kind: 'same-context', agent: 'engineer' } };
  const options = { requireIndependent: true, providers: [{ perspective: result.reviewer, name: 'enterprise-reviewer' }] };
  const rejected = synthesizeReview('.', [result.reviewer], { results: [result] }, [], [], false, options);
  assert.equal(rejected.coverage.complete, false);
  assert.deepEqual(rejected.coverage.missing, [result.reviewer]);
  const authored = { ...result, provenance: { kind: 'host-invocation', agent: 'enterprise-reviewer', via: 'engineer' } };
  assert.equal(synthesizeReview('.', [result.reviewer], { results: [authored] }, [], [], false, options).coverage.complete, false);
  const accepted = synthesizeReview('.', [result.reviewer], { results: [authored] }, [], [], false, { ...options,
    observationFor: (_, provider) => ({ valid: provider.name === 'enterprise-reviewer', sessionId: 'native-session', observationId: 'observed-fixture', assurance: 'Unit fixture for the server-side observer callback' }) });
  assert.equal(accepted.coverage.complete, true);
  const wrong = synthesizeReview('.', [result.reviewer], { results: [authored] }, [], [], false, { ...options, observationFor: () => ({ valid: false, reason: 'Actual native provider did not match' }) });
  assert.equal(wrong.coverage.complete, false);
});

test('tour renders exact linked reading order and source-bound context', async t => {
  const { workspace, input, args } = fixture(t);
  const tour = await createReviewTour({ ...args, input });
  const markdown = fs.readFileSync(path.join(workspace, tour.markdownPath), 'utf8');
  assert.match(markdown, /```mermaid/);
  assert.match(markdown, /src\.js#L1/);
  assert.match(markdown, /Descriptive/);
  assert.match(fs.readFileSync(path.join(workspace, tour.svgPath), 'utf8'), /<svg/);
  assert.equal(validateReviewTour(args).pass, true);
});

test('tour rejects missing behavioral fields, absent symbols, unmapped edges and omitted changed files', async t => {
  const { input, args } = fixture(t);
  for (const mutate of [value => { value.after = ''; }, value => { value.readingOrder[0].code[0].symbol = 'missingSymbol'; }, value => { value.context.edges[0].to = 'absent'; }, value => { value.readingOrder[0].tests = []; }]) {
    const invalid = structuredClone(input); mutate(invalid);
    await assert.rejects(createReviewTour({ ...args, input: invalid }), /tour:/);
  }
});

test('tour cannot establish readiness after head, context source, packet or artifact changes', async t => {
  const { workspace, packet, input, args } = fixture(t);
  const tour = await createReviewTour({ ...args, input });
  assert.equal(validateReviewTour({ ...args, currentScope: { ...packet.scope, head: 'head-b' } }).pass, false);
  assert.equal(validateReviewTour({ ...args, packet: { ...packet, required: [] } }).pass, false);
  fs.appendFileSync(path.join(workspace, 'store.js'), '// context changed\n');
  assert.equal(validateReviewTour(args).pass, false);
  fs.writeFileSync(path.join(workspace, 'store.js'), 'export function save() { return 1; }\n');
  fs.appendFileSync(path.join(workspace, tour.markdownPath), '\nAltered tour\n');
  assert.equal(validateReviewTour(args).pass, false);
});

test('tours in an external record store link back to actual product sources', async t => {
  const { workspace, input, args } = fixture(t);
  const recordRoot = path.join(workspace, 'external-records');
  fs.mkdirSync(recordRoot);
  const tour = await createReviewTour({ ...args, recordRoot, input });
  const expected = path.relative(path.dirname(path.join(recordRoot, tour.markdownPath)), path.join(workspace, 'src.js')).replace(/\\/g, '/');
  assert.ok(fs.readFileSync(path.join(recordRoot, tour.markdownPath), 'utf8').includes(`](${expected}#L1)`));
  assert.equal(validateReviewTour({ ...args, recordRoot }).pass, true);
});
