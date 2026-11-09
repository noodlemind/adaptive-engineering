#!/usr/bin/env node
// Checks every path through a Mermaid state diagram against declared rules, then confirms
// that each declared broken variant is caught. Needs only Node; installs and downloads nothing.
//
//   node check.mjs --model <model.mmd> --rules <rules.json> [--out <dir>]
//
// Writes state-model.json, report.md and chart.mmd to --out, else to HARNESS_CHECK_ARTIFACT_DIR,
// and prints the receipt. Exits 1 when a rule breaks or a broken variant is missed, 2 on bad input.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const START = '[*]';
const ID = /^[A-Za-z][A-Za-z0-9_]*$/;
const KINDS = new Set(['requires', 'inert', 'reachable']);
const MAX_PRODUCT_STATES = 100000;

const fail = message => Object.assign(new Error(message), { code: 'E_STATE_MODEL' });
const sha256 = text => createHash('sha256').update(text).digest('hex');
const edgeText = edge => `${edge.from} --> ${edge.to}${edge.action ? ` : ${edge.action}` : ''}`;

/**
 * Parse the supported stateDiagram subset: `A --> B` with an optional `: Action` label,
 * `state "Label" as A` for a reader-facing name, `[*]` for start and end, and `%%` comments.
 * A state whose only exits go to `[*]` is a correct end, not a dead end.
 */
export function parseStateDiagram(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('%%'));
  if (lines[0] !== 'stateDiagram-v2' && lines[0] !== 'stateDiagram') throw fail('model must start with stateDiagram-v2');
  const edges = [], labels = {};
  for (const line of lines.slice(1)) {
    const named = /^state\s+"([^"\n]{1,120})"\s+as\s+([A-Za-z][A-Za-z0-9_]*)$/.exec(line);
    if (named) { labels[named[2]] = named[1]; continue; }
    const match = /^(\[\*\]|[A-Za-z][A-Za-z0-9_]*)\s*-->\s*(\[\*\]|[A-Za-z][A-Za-z0-9_]*)(?:\s*:\s*([A-Za-z][A-Za-z0-9_]*))?$/.exec(line);
    if (!match) throw fail(`unsupported model line: ${line}`);
    const [, from, to, action = null] = match;
    edges.push({ from, to, action });
  }
  if (!edges.some(edge => edge.from === START)) throw fail('model needs at least one [*] --> State start edge');
  return { edges, labels };
}

function ids(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !ID.test(item))) throw fail(`${label} must be a list of action names`);
  return value;
}

/** Validate a rules file. Rules are data: there is no executable rule code. */
export function validateRules(spec) {
  if (!spec || typeof spec !== 'object' || spec.schema !== 1) throw fail('rules file needs schema 1');
  const actions = new Set(ids(spec.actions, 'actions'));
  const known = (name, label) => { if (!actions.has(name)) throw fail(`${label} names unknown action ${name}`); return name; };
  for (const name of ids(spec.required || [], 'required')) known(name, 'required');
  if (!Array.isArray(spec.rules) || !spec.rules.length) throw fail('rules file needs at least one rule');
  const seen = new Set();
  for (const rule of spec.rules) {
    if (!rule || !ID.test(String(rule.id).replaceAll('-', '_')) || seen.has(rule.id)) throw fail('each rule needs a unique id');
    seen.add(rule.id);
    if (!KINDS.has(rule.kind)) throw fail(`rule ${rule.id} has unsupported kind ${rule.kind}`);
    if (typeof rule.says !== 'string' || !rule.says.trim()) throw fail(`rule ${rule.id} needs a plain-language "says" sentence`);
    known(rule.action, `rule ${rule.id}`);
    if (rule.kind === 'requires') { known(rule.requires, `rule ${rule.id}`); for (const name of ids(rule.resetBy || [], `rule ${rule.id} resetBy`)) known(name, `rule ${rule.id}`); }
    if (rule.kind === 'reachable') known(rule.after, `rule ${rule.id}`);
  }
  if (!Array.isArray(spec.negativeControls) || !spec.negativeControls.length) throw fail('rules file needs at least one negative control; a check never seen failing proves nothing');
  for (const control of spec.negativeControls) {
    if (!control || typeof control.id !== 'string' || !seen.has(control.expect)) throw fail('each negative control needs an id and an expected rule id');
    if (!control.removeAction && !Array.isArray(control.addEdges)) throw fail(`negative control ${control.id} must remove an action or add edges`);
    if (control.removeAction) known(control.removeAction, `negative control ${control.id}`);
  }
  return spec;
}

function pathTo(node, parents) {
  const steps = [];
  for (let key = node.key; parents.get(key);) { const { prev, edge } = parents.get(key); steps.unshift(edge); key = prev; }
  return steps;
}

/** Explore every path and report each broken rule with its shortest path from the start. */
export function checkModel(edges, spec, labels = {}) {
  const actions = new Set(spec.actions);
  const violations = [];
  for (const edge of edges) if (edge.action && !actions.has(edge.action)) violations.push({ rule: 'well-formed', edge: edgeText(edge), detail: `unknown action ${edge.action}`, path: [] });
  for (const name of spec.required || []) if (!edges.some(edge => edge.action === name)) violations.push({ rule: 'well-formed', edge: null, detail: `missing ${name} transition`, path: [] });

  const requires = spec.rules.filter(rule => rule.kind === 'requires');
  for (const rule of spec.rules.filter(rule => rule.kind === 'inert')) {
    for (const edge of edges) if (edge.action === rule.action && edge.from !== edge.to) violations.push({ rule: rule.id, edge: edgeText(edge), detail: `${rule.action} moves to another state`, path: [edge] });
  }
  const outgoing = state => edges.filter(edge => edge.from === state);
  const keyOf = (state, flags) => `${state}|${flags.map(Number).join('')}`;
  const startNode = { state: START, flags: requires.map(() => false) };
  startNode.key = keyOf(START, startNode.flags);
  const nodes = new Map([[startNode.key, startNode]]), parents = new Map(), queue = [startNode];
  const firstReach = new Map([[START, startNode]]);
  while (queue.length) {
    const node = queue.shift();
    for (const edge of outgoing(node.state)) {
      requires.forEach((rule, index) => {
        if (edge.action === rule.action && !node.flags[index]) violations.push({ rule: rule.id, edge: edgeText(edge), detail: `${rule.action} is reachable without ${rule.requires}${rule.resetBy?.length ? ` since the last ${rule.resetBy.join(' or ')}` : ''}`, path: [...pathTo(node, parents), edge] });
      });
      if (edge.to === START) continue;
      const flags = requires.map((rule, index) => edge.action === rule.requires ? true : (rule.resetBy || []).includes(edge.action) ? false : node.flags[index]);
      const next = { state: edge.to, flags, key: keyOf(edge.to, flags) };
      if (nodes.has(next.key)) continue;
      if (nodes.size >= MAX_PRODUCT_STATES) throw fail(`model exceeds ${MAX_PRODUCT_STATES} explored states; make it smaller`);
      nodes.set(next.key, next); parents.set(next.key, { prev: node.key, edge }); queue.push(next);
      if (!firstReach.has(edge.to)) firstReach.set(edge.to, next);
    }
  }
  const reachable = new Set([...firstReach.keys()].filter(state => state !== START));
  for (const rule of spec.rules.filter(rule => rule.kind === 'reachable')) {
    const canReach = new Set();
    for (let changed = true; changed;) {
      changed = false;
      for (const edge of edges) if (!canReach.has(edge.from) && (edge.action === rule.action || canReach.has(edge.to))) { canReach.add(edge.from); changed = true; }
    }
    const after = new Set(edges.filter(edge => edge.action === rule.after && (edge.from === START || reachable.has(edge.from)) && edge.to !== START).map(edge => edge.to));
    for (const pending = [...after]; pending.length;) for (const edge of outgoing(pending.shift())) if (edge.to !== START && !after.has(edge.to)) { after.add(edge.to); pending.push(edge.to); }
    for (const state of after) {
      const exits = outgoing(state);
      if (canReach.has(state) || (exits.length && exits.every(edge => edge.to === START))) continue;
      const stuck = firstReach.get(state);
      violations.push({ rule: rule.id, edge: null, detail: exits.length ? `${state} cannot reach ${rule.action}` : `${state} is a dead end`, state, path: stuck ? pathTo(stuck, parents) : [] });
    }
  }
  const unique = [...new Map(violations.map(v => [`${v.rule}|${v.edge}|${v.state || ''}`, v])).values()];
  return { passed: unique.length === 0, states: reachable.size, explored: nodes.size, violations: unique.map(v => ({ ...v, words: words(v, labels) })) };
}

const nameOf = (state, labels) => state === START ? 'start' : labels[state] || state;

/** Tell a bug path as numbered steps in the reader's words. */
function words(violation, labels) {
  return violation.path.map((edge, index) => `${index + 1}. ${nameOf(edge.from, labels)} -> ${nameOf(edge.to, labels)}${edge.action ? ` (${edge.action})` : ''}`);
}

function applyControl(edges, control) {
  const kept = control.removeAction ? edges.filter(edge => edge.action !== control.removeAction) : edges;
  return [...kept, ...(control.addEdges || []).map(edge => ({ from: edge.from, to: edge.to, action: edge.action || null }))];
}

/** A copy of the model whose labels mark where each rule breaks and number the bug path. */
export function markedChart(edges, labels, violations) {
  const encode = value => [...String(value)].map(ch => /^[A-Za-z0-9 _.,-]$/.test(ch) ? ch : `#${ch.codePointAt(0)};`).join('');
  const breaks = new Map(), stepOf = new Map();
  for (const violation of violations) {
    const last = violation.path.at(-1);
    const state = violation.state || (last && (last.to !== START ? last.to : last.from));
    if (state && state !== START) breaks.set(state, [...(breaks.get(state) || []), violation.rule]);
    violation.path.forEach((edge, index) => { const key = edgeText(edge); if (!stepOf.has(key)) stepOf.set(key, `step ${index + 1}${index === violation.path.length - 1 && violation.edge ? `, breaks ${violation.rule}` : ''}`); });
  }
  const states = [...new Set(edges.flatMap(edge => [edge.from, edge.to]).filter(state => state !== START))];
  const lines = ['stateDiagram-v2'];
  for (const state of states) {
    const rules = breaks.get(state);
    const label = `${nameOf(state, labels)}${rules ? ` - BREAKS ${[...new Set(rules)].join(', ')}` : ''}`;
    if (labels[state] || rules) lines.push(`  state "${encode(label)}" as ${state}`);
  }
  for (const edge of edges) {
    const step = stepOf.get(edgeText(edge));
    const text = [edge.action, step && `(${step})`].filter(Boolean).join(' ');
    lines.push(`  ${edge.from} --> ${edge.to}${text ? ` : ${encode(text)}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

function report(receipt, spec) {
  const out = [`# State model check: ${receipt.passed ? 'passed' : 'failed'}`, '', `Model \`${receipt.model}\`, ${receipt.result.states} states, ${receipt.result.explored} explored.`, '', '## Rules', ''];
  for (const rule of spec.rules) {
    const broken = receipt.result.violations.filter(v => v.rule === rule.id);
    out.push(`- **${rule.id}**: ${rule.says} ${broken.length ? `Breaks (${broken.length}).` : 'Holds.'}`);
    for (const violation of broken) out.push(`  - ${violation.detail}. Shortest path:`, ...violation.words.map(step => `    ${step}`));
  }
  for (const violation of receipt.result.violations.filter(v => v.rule === 'well-formed')) out.push(`- **well-formed**: ${violation.detail}`);
  out.push('', '## Broken variants', '', ...receipt.negativeControls.map(c => `- ${c.id}: ${c.detected ? 'caught' : 'MISSED'} (expects ${c.expect})`));
  out.push('', '## Limits', '', receipt.limits, '');
  return out.join('\n');
}

/** Check a model file against a rules file and return the receipt and its artifacts. */
export function run({ modelPath, rulesPath }) {
  const modelText = fs.readFileSync(modelPath, 'utf8'), rulesText = fs.readFileSync(rulesPath, 'utf8');
  const spec = validateRules(JSON.parse(rulesText));
  const { edges, labels } = parseStateDiagram(modelText);
  const result = checkModel(edges, spec, labels);
  const negativeControls = spec.negativeControls.map(control => {
    const variant = checkModel(applyControl(edges, control), spec, labels);
    return { id: control.id, expect: control.expect, detected: variant.violations.some(v => v.rule === control.expect), violations: [...new Set(variant.violations.map(v => v.rule))] };
  });
  const receipt = { schema: 1, check: 'state-model', model: path.basename(modelPath), modelSha256: sha256(modelText), rulesSha256: sha256(rulesText),
    passed: result.passed && negativeControls.every(control => control.detected), rules: Object.fromEntries(spec.rules.map(rule => [rule.id, rule.says])), result, negativeControls,
    limits: spec.limits || 'The diagram describes intended behavior. It has no counters or data, and it does not prove that the code follows it; pair it with a check that drives the real code.' };
  return { receipt, chart: markedChart(edges, labels, result.violations), report: report(receipt, spec) };
}

export function writeArtifacts(dir, { receipt, chart, report: text }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state-model.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'chart.mmd'), chart);
  fs.writeFileSync(path.join(dir, 'report.md'), text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { model: { type: 'string' }, rules: { type: 'string' }, out: { type: 'string' } } });
    if (!values.model || !values.rules) throw fail('usage: check.mjs --model <model.mmd> --rules <rules.json> [--out <dir>]');
    const result = run({ modelPath: values.model, rulesPath: values.rules });
    const dir = values.out || process.env.HARNESS_CHECK_ARTIFACT_DIR;
    if (dir) writeArtifacts(dir, result);
    process.stdout.write(`${JSON.stringify(result.receipt, null, 2)}\n`);
    if (!result.receipt.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
