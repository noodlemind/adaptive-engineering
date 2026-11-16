import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { matchFindings, scoreArm, validateCases } from '../eval/review/score.mjs';
import { planTrials } from '../eval/review/run.mjs';
import { FLOW_CLASSES } from '../lib/review-synthesis.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../eval/review');
const cases = JSON.parse(fs.readFileSync(path.join(dir, 'cases.json'), 'utf8'));
const protocol = JSON.parse(fs.readFileSync(path.join(dir, 'protocol.json'), 'utf8'));

test('the frozen review-recall cases are well formed and tag defects with flow classes', () => {
  assert.deepEqual(validateCases(cases), []);
  for (const item of cases.cases) for (const defect of item.defects) assert.ok(FLOW_CLASSES.includes(defect.flow_class), `${item.id} ${defect.flow_class}`);
  // The flow-tracing probes were learned from these pull requests, so none of them can be held out.
  assert.equal(cases.cases.some(c => c.split === 'held-out'), false);
  assert.match(protocol.heldOut, /pending/);
  assert.equal(planTrials({ cases, protocol }).length, protocol.arms.length * cases.cases.length * protocol.repeats);
  assert.match(protocol.status, /no arm has been run/);
  assert.ok(validateCases({ schema: 'review-recall-cases-v1', cases: [{ id: 'x', split: 'dev', base: 'abc', head: 'abc', defects: [{ file: '../x', line: 0 }] }] }).length >= 4);
});

test('scoring matches by file and line window one to one and counts clean-control noise', () => {
  const defects = [{ file: 'a.mjs', line: 10, flow_class: 'abuse' }, { file: 'a.mjs', line: 14, flow_class: 'boundary' }, { file: 'b.mjs', line: 5, flow_class: 'abuse' }];
  const findings = [{ file: './a.mjs', line: 12 }, { file: 'a.mjs', line: 30 }, { file: 'c.mjs', line: 5 }];
  const m = matchFindings(defects, findings, { lineWindow: 8 });
  assert.equal(m.matched.length, 1, 'one finding never covers two defects');
  assert.equal(m.missed.length, 2);
  assert.equal(m.unmatched.length, 2);
  const testCases = [{ id: 'd', defects }, { id: 'clean', defects: [] }];
  const records = { d: { findings: findings.map((f, i) => i === 1 ? { ...f, verification: { state: 'refuted' } } : f) }, clean: { findings: [{ file: 'z.mjs', line: 1, verification: { state: 'confirmed' } }] } };
  const score = scoreArm({ cases: testCases, records, protocol });
  assert.equal(score.recall, 0.333);
  assert.equal(score.perClassRecall.abuse.expected, 2);
  assert.equal(score.cleanFindings, 1);
  assert.equal(score.precisionProxy, 0.333);
  assert.equal(score.verifiedRefutedShare, 0.5);
  const none = scoreArm({ cases: testCases, records: {}, protocol });
  assert.equal(none.recall, 0);
  assert.equal(none.cases[0].reviewed, false);
});

test('corpus text never quotes a held-out defect', () => {
  const corpus = path.join(dir, '../../corpus');
  const texts = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.md')) texts.push(fs.readFileSync(p, 'utf8')); } };
  walk(corpus);
  const all = texts.join('\n');
  for (const item of cases.cases.filter(c => c.split === 'held-out')) {
    for (const defect of item.defects) {
      assert.equal(all.includes(`${path.posix.basename(defect.file)}:${defect.line}`), false, `${item.id} ${defect.file}:${defect.line}`);
      assert.equal(all.includes(defect.summary), false, `${item.id} summary`);
    }
  }
  // The worked example in flow tracing is synthetic and cites no file from any case.
  const example = fs.readFileSync(path.join(corpus, 'skills/code-review/references/flow-tracing.md'), 'utf8').match(/```json([\s\S]*?)```/)[1];
  for (const item of cases.cases) for (const defect of item.defects) assert.equal(example.includes(defect.file), false, defect.file);
});
