import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseStateDiagram, checkWorkflow, run } from '../../../.cursor/skills/verify-harness/formal/delivery-evidence/scripts/check.mjs';

const model = fileURLToPath(new URL('../../../.cursor/skills/verify-harness/formal/delivery-evidence/workflow.mmd', import.meta.url));
const edges = () => parseStateDiagram(fs.readFileSync(model, 'utf8'));
const rules = result => result.violations.map(violation => violation.rule);

test('the delivery-evidence diagram satisfies every rule and its broken variants are caught', () => {
  const receipt = run(model);
  assert.equal(receipt.passed, true, JSON.stringify(receipt.result.violations));
  assert.deepEqual(receipt.negativeControls.map(control => [control.id, control.detected]), [['unguarded-compound', true], ['no-verify', true]]);
});

test('an edit before Lock or outside Deliver is a violation', () => {
  assert.ok(rules(checkWorkflow([...edges(), { from: 'Deliver', to: 'Deliver', action: 'Edit' }])).includes('intent-before-edit'));
  assert.ok(rules(checkWorkflow([...edges(), { from: 'AnswerMode', to: 'AnswerMode', action: 'Edit' }])).includes('deliver-only-edits'));
});

test('compound after an edit that follows verify is a violation', () => {
  const broken = [...edges(), { from: 'Verified', to: 'Edited', action: 'Edit' }, { from: 'Edited', to: 'Compounded', action: 'Compound' }];
  assert.ok(rules(checkWorkflow(broken)).includes('current-evidence'));
});

test('insight capture that moves state is a violation', () => {
  assert.ok(rules(checkWorkflow([...edges(), { from: 'Locked', to: 'Reviewed', action: 'CaptureInsight' }])).includes('insight-is-inert'));
});

test('a reviewed state that can no longer reach Compound is a violation', () => {
  const trapped = [...edges(), { from: 'Reviewed', to: 'Stuck', action: 'Amend' }, { from: 'Stuck', to: 'Stuck', action: 'Amend' }];
  assert.ok(rules(checkWorkflow(trapped)).includes('progress'));
});

test('the parser rejects unknown actions and unsupported syntax', () => {
  assert.throws(() => parseStateDiagram('stateDiagram-v2\n  [*] --> A\n  A --> B : Deploy\n'), /unknown action/);
  assert.throws(() => parseStateDiagram('stateDiagram-v2\n  state A { B }\n'), /unsupported model line/);
  assert.throws(() => parseStateDiagram('flowchart TD\n  A --> B\n'), /stateDiagram-v2/);
});
