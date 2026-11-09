import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStateDiagram, validateRules, checkModel, markedChart, run } from '../corpus/skills/create-primitive/assets/state-model/check.mjs';
import { renderDiagram } from '../lib/diagrams/render.mjs';

const script = fileURLToPath(new URL('../corpus/skills/create-primitive/assets/state-model/check.mjs', import.meta.url));

const MODEL = `stateDiagram-v2
  %% A refund workflow
  state "Refund requested" as Requested
  state "Approved by a person" as Approved
  state "Money sent back" as Paid
  [*] --> Requested
  Requested --> Approved : Approve
  Requested --> Requested : Note
  Approved --> Paid : Pay
  Paid --> [*]
`;
const RULES = {
  schema: 1,
  actions: ['Approve', 'Pay', 'Note'],
  required: ['Approve', 'Pay'],
  rules: [
    { id: 'approval-first', kind: 'requires', action: 'Pay', requires: 'Approve', says: 'Money is sent back only after a person approves.' },
    { id: 'notes-are-inert', kind: 'inert', action: 'Note', says: 'Adding a note never changes the refund.' },
    { id: 'can-pay', kind: 'reachable', action: 'Pay', after: 'Approve', says: 'After approval, paying stays possible.' },
  ],
  negativeControls: [{ id: 'skip-approval', expect: 'approval-first', addEdges: [{ from: 'Requested', to: 'Paid', action: 'Pay' }] }],
};
const clone = value => JSON.parse(JSON.stringify(value));
const parsed = (text = MODEL) => parseStateDiagram(text);

function workspace(model = MODEL, rules = RULES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-state-model-'));
  fs.writeFileSync(path.join(dir, 'model.mmd'), model);
  fs.writeFileSync(path.join(dir, 'rules.json'), typeof rules === 'string' ? rules : JSON.stringify(rules));
  return dir;
}

test('the parser keeps plain-word labels and refuses unsupported syntax', () => {
  const { edges, labels } = parsed();
  assert.equal(labels.Approved, 'Approved by a person');
  assert.deepEqual(edges[1], { from: 'Requested', to: 'Approved', action: 'Approve' });
  assert.throws(() => parseStateDiagram('flowchart TD\n  A --> B\n'), /stateDiagram-v2/);
  assert.throws(() => parseStateDiagram('stateDiagram-v2\n  [*] --> A\n  state A { B }\n'), /unsupported model line/);
  assert.throws(() => parseStateDiagram('stateDiagram-v2\n  A --> B\n'), /start edge/);
});

test('rules are validated as data and need a negative control', () => {
  assert.doesNotThrow(() => validateRules(clone(RULES)));
  const without = clone(RULES); without.negativeControls = [];
  assert.throws(() => validateRules(without), /negative control/);
  const unknown = clone(RULES); unknown.rules[0].requires = 'Deploy';
  assert.throws(() => validateRules(unknown), /unknown action Deploy/);
  const kind = clone(RULES); kind.rules[0].kind = 'eventually';
  assert.throws(() => validateRules(kind), /unsupported kind/);
  const silent = clone(RULES); delete silent.rules[1].says;
  assert.throws(() => validateRules(silent), /says/);
});

test('a correct model passes, and a finished state is not a dead end', () => {
  const { edges, labels } = parsed();
  const result = checkModel(edges, RULES, labels);
  assert.equal(result.passed, true, JSON.stringify(result.violations));
  assert.equal(result.states, 3);
});

test('a broken requires rule is reported with its shortest path in plain words', () => {
  const { edges, labels } = parsed();
  const longWay = [...edges, { from: 'Requested', to: 'Held', action: 'Note' }, { from: 'Held', to: 'Paid', action: 'Pay' }, { from: 'Requested', to: 'Paid', action: 'Pay' }];
  const result = checkModel(longWay, RULES, labels);
  const broken = result.violations.filter(v => v.rule === 'approval-first');
  const shortest = broken.find(v => v.edge === 'Requested --> Paid : Pay');
  assert.deepEqual(shortest.words, ['1. start -> Refund requested', '2. Refund requested -> Money sent back (Pay)']);
  assert.ok(broken.some(v => v.path.length === 3), 'the longer route is reported separately with its own path');
});

test('resetBy makes an earlier guard stale', () => {
  const spec = clone(RULES); spec.actions.push('Edit');
  spec.rules[0].resetBy = ['Edit'];
  const { edges, labels } = parsed();
  const result = checkModel([...edges, { from: 'Approved', to: 'Approved', action: 'Edit' }], spec, labels);
  assert.ok(result.violations.some(v => v.rule === 'approval-first' && v.words.at(-2) === '3. Approved by a person -> Approved by a person (Edit)'));
});

test('inert and reachable rules catch state changes and stuck states', () => {
  const { edges, labels } = parsed();
  assert.ok(checkModel([...edges, { from: 'Requested', to: 'Approved', action: 'Note' }], RULES, labels).violations.some(v => v.rule === 'notes-are-inert'));
  const stuck = checkModel([...edges, { from: 'Approved', to: 'Frozen', action: 'Note' }], RULES, labels).violations.find(v => v.rule === 'can-pay');
  assert.equal(stuck.state, 'Frozen');
  assert.match(stuck.detail, /dead end/);
  assert.deepEqual(stuck.words, ['1. start -> Refund requested', '2. Refund requested -> Approved by a person (Approve)', '3. Approved by a person -> Frozen (Note)']);
});

test('well-formed checks flag unknown and missing actions', () => {
  const { edges } = parsed();
  const rules = checkModel([...edges.filter(e => e.action !== 'Approve'), { from: 'Paid', to: 'Paid', action: 'Refund' }], RULES).violations.map(v => v.detail);
  assert.ok(rules.includes('missing Approve transition'));
  assert.ok(rules.includes('unknown action Refund'));
});

test('the marked chart numbers the bug path, marks the breaking state and renders with pele', async () => {
  const { edges, labels } = parsed();
  const broken = [...edges, { from: 'Requested', to: 'Paid', action: 'Pay' }];
  const result = checkModel(broken, RULES, labels);
  const chart = markedChart(broken, labels, result.violations);
  assert.match(chart, /state "Money sent back - BREAKS approval-first" as Paid/);
  assert.ok(chart.includes("Requested --> Paid : Pay #40;approval-first step 2, breaks#41;"), chart);
  assert.doesNotMatch(chart, /classDef|style /);
  const rendered = await renderDiagram({ source: chart, engine: 'pele' });
  assert.match(rendered.svg, /<svg/);
  assert.match(rendered.svg, /BREAKS approval-first/);
});

test('run checks the negative controls and fails when one is missed', () => {
  const dir = workspace();
  const ok = run({ modelPath: path.join(dir, 'model.mmd'), rulesPath: path.join(dir, 'rules.json') });
  assert.equal(ok.receipt.passed, true);
  assert.deepEqual(ok.receipt.negativeControls.map(c => [c.id, c.detected]), [['skip-approval', true]]);
  assert.match(ok.receipt.modelSha256, /^[0-9a-f]{64}$/);
  assert.match(ok.report, /approval-first\*\*: Money is sent back only after a person approves\. Holds\./);

  const blind = clone(RULES); blind.negativeControls = [{ id: 'harmless', expect: 'approval-first', addEdges: [{ from: 'Paid', to: 'Paid', action: 'Note' }] }];
  const dir2 = workspace(MODEL, blind);
  const missed = run({ modelPath: path.join(dir2, 'model.mmd'), rulesPath: path.join(dir2, 'rules.json') });
  assert.equal(missed.receipt.result.passed, true);
  assert.equal(missed.receipt.passed, false);
  assert.match(missed.report, /harmless: MISSED/);
});

test('the CLI writes its artifacts and exits 0, 1 or 2', () => {
  const good = workspace();
  const out = path.join(good, 'out');
  const pass = spawnSync(process.execPath, [script, '--model', path.join(good, 'model.mmd'), '--rules', path.join(good, 'rules.json'), '--out', out], { encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(), ['chart.mmd', 'report.md', 'state-model.json']);

  const bad = workspace(`${MODEL}  Requested --> Paid : Pay\n`);
  const env = { ...process.env, HARNESS_CHECK_ARTIFACT_DIR: path.join(bad, 'artifacts') };
  const fail = spawnSync(process.execPath, [script, '--model', path.join(bad, 'model.mmd'), '--rules', path.join(bad, 'rules.json')], { encoding: 'utf8', env });
  assert.equal(fail.status, 1);
  assert.match(fs.readFileSync(path.join(bad, 'artifacts', 'report.md'), 'utf8'), /2\. Refund requested -> Money sent back \(Pay\)/);

  const invalid = workspace(MODEL, '{"schema":2}');
  const refused = spawnSync(process.execPath, [script, '--model', path.join(invalid, 'model.mmd'), '--rules', path.join(invalid, 'rules.json')], { encoding: 'utf8' });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /schema 1/);
  for (const dir of [good, bad, invalid]) fs.rmSync(dir, { recursive: true, force: true });
});

test('malformed ids, expectations and added edges are refused rather than counted as caught', () => {
  const noId = clone(RULES); delete noId.rules[1].id;
  assert.throws(() => validateRules(noId), /unique id/);
  const noExpect = clone(RULES); delete noExpect.negativeControls[0].expect;
  assert.throws(() => validateRules(noExpect), /expected rule id/);
  const notList = clone(RULES); notList.negativeControls[0] = { id: 'n', expect: 'approval-first', removeAction: 'Approve', addEdges: { from: 'Paid' } };
  assert.throws(() => validateRules(notList), /addEdges must be a list/);
  const noTo = clone(RULES); noTo.negativeControls[0].addEdges = [{ from: 'Approved', action: 'Note' }];
  assert.throws(() => validateRules(noTo), /valid from and to/);
  const badAction = clone(RULES); badAction.negativeControls[0].addEdges = [{ from: 'Approved', to: 'Paid', action: 'Refund' }];
  assert.throws(() => validateRules(badAction), /unknown action Refund/);
});

test('a finished run does not restart, so ending is not a route to the action', () => {
  const { edges, labels } = parsed();
  const result = checkModel([...edges, { from: 'Approved', to: 'Parked', action: 'Note' }, { from: 'Parked', to: 'Hold', action: 'Note' }, { from: 'Hold', to: 'Parked', action: 'Note' }, { from: 'Parked', to: '[*]', action: null }], RULES, labels);
  const stuck = result.violations.find(v => v.rule === 'can-pay');
  assert.equal(stuck?.state, 'Parked');
  assert.match(stuck.detail, /cannot reach Pay/);
});

test('every witness starts at the start, includes the trigger, and is the shortest one', () => {
  const { edges, labels } = parsed();
  const inert = checkModel([...edges, { from: 'Approved', to: 'Paid', action: 'Note' }], RULES, labels).violations.find(v => v.rule === 'notes-are-inert');
  assert.deepEqual(inert.words, ['1. start -> Refund requested', '2. Refund requested -> Approved by a person (Approve)', '3. Approved by a person -> Money sent back (Note)']);

  const frozen = checkModel([...edges, { from: 'Requested', to: 'Frozen', action: 'Note' }, { from: 'Approved', to: 'Frozen', action: 'Note' }], RULES, labels).violations.find(v => v.rule === 'can-pay');
  assert.ok(frozen.path.some(edge => edge.action === 'Approve'), JSON.stringify(frozen.words));

  const spec = clone(RULES); spec.actions.push('Edit'); spec.rules[0].resetBy = ['Edit'];
  const looped = checkModel([...edges, { from: 'Approved', to: 'Approved', action: 'Edit' }, { from: 'Requested', to: 'Paid', action: 'Pay' }], spec, labels);
  const direct = looped.violations.filter(v => v.rule === 'approval-first' && v.edge === 'Requested --> Paid : Pay');
  assert.equal(direct.length, 1);
  assert.equal(direct[0].path.length, 2);

  const missing = checkModel(edges.filter(edge => !['Approve', 'Pay'].includes(edge.action)), RULES).violations.filter(v => v.rule === 'well-formed').map(v => v.detail);
  assert.deepEqual(missing.sort(), ['missing Approve transition', 'missing Pay transition']);
});

test('an edge on two bug paths keeps each rule and its own step number', () => {
  const spec = clone(RULES);
  spec.actions.push('Open');
  spec.rules.push({ id: 'opened-first', kind: 'requires', action: 'Pay', requires: 'Open', says: 'Money is sent back only on an opened case.' });
  const { edges, labels } = parsed();
  const broken = [...edges, { from: 'Requested', to: 'Paid', action: 'Pay' }];
  const chart = markedChart(broken, labels, checkModel(broken, spec, labels).violations);
  assert.ok(chart.includes('Requested --> Paid : Pay #40;approval-first step 2, breaks; opened-first step 2, breaks#41;'), chart);
  assert.match(chart, /BREAKS approval-first, opened-first/);
});

test('a manual run with no output directory still writes its artifacts and says where', () => {
  const dir = workspace();
  const env = { ...process.env }; delete env.HARNESS_CHECK_ARTIFACT_DIR;
  const result = spawnSync(process.execPath, [script, '--model', path.join(dir, 'model.mmd'), '--rules', path.join(dir, 'rules.json')], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  const out = /artifacts: (.+)/.exec(result.stderr)?.[1];
  assert.ok(out && fs.existsSync(path.join(out, 'chart.mmd')) && fs.existsSync(path.join(out, 'report.md')));
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a legal end with an inert self-loop is still a legal end', () => {
  const { edges, labels } = parsed();
  const result = checkModel([...edges, { from: 'Paid', to: 'Paid', action: 'Note' }], RULES, labels);
  assert.equal(result.passed, true, JSON.stringify(result.violations));
});

test('state names that match Object members are not mistaken for labels', () => {
  const { labels } = parseStateDiagram('stateDiagram-v2\n  [*] --> constructor\n  constructor --> toString : Approve\n');
  assert.equal(Object.keys(labels).length, 0);
  const chart = markedChart([{ from: '[*]', to: 'constructor', action: null }], labels, []);
  assert.doesNotMatch(chart, /function/);
});

test('a failure on an unreachable edge still marks the chart', () => {
  const { edges, labels } = parsed();
  const broken = [...edges, { from: 'Orphan', to: 'Other', action: 'Note' }];
  const chart = markedChart(broken, labels, checkModel(broken, RULES, labels).violations);
  assert.ok(chart.includes('Orphan --> Other : Note #40;notes-are-inert, breaks#41;'), chart);
});

test('a negative control must change the model; a dead-end control may add a new state', () => {
  const runWith = rules => { const dir = workspace(MODEL, rules); try { return run({ modelPath: path.join(dir, 'model.mmd'), rulesPath: path.join(dir, 'rules.json') }); } finally { fs.rmSync(dir, { recursive: true, force: true }); } };
  const renamed = clone(RULES); renamed.negativeControls[0].addEdges = [{ from: 'Renamed', to: 'Paid', action: 'Pay' }];
  assert.throws(() => runWith(renamed), /from Renamed, which is not in the model/);
  const typo = clone(RULES); typo.negativeControls = [{ id: 'no-note', expect: 'notes-are-inert', removeAction: 'Note' }]; typo.actions.push('Refund'); typo.negativeControls[0].removeAction = 'Refund';
  assert.throws(() => runWith(typo), /removes Refund, which no model edge uses/);
  const deadEnd = clone(RULES); deadEnd.negativeControls = [{ id: 'stuck', expect: 'can-pay', addEdges: [{ from: 'Approved', to: 'Abandoned', action: 'Note' }] }];
  const result = runWith(deadEnd);
  assert.deepEqual(result.receipt.negativeControls.map(c => [c.id, c.detected]), [['stuck', true]]);
});

test('only an inert self-loop keeps a legal end; any other self-loop is lost progress', () => {
  const { edges, labels } = parsed();
  const spec = clone(RULES); spec.actions.push('Edit');
  const result = checkModel([...edges, { from: 'Approved', to: 'Parked', action: 'Note' }, { from: 'Parked', to: 'Parked', action: 'Edit' }, { from: 'Parked', to: '[*]', action: null }], spec, labels);
  assert.ok(result.violations.some(v => v.rule === 'can-pay' && v.state === 'Parked'));
});
