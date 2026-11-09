#!/usr/bin/env node
// Checks every path through the delivery-evidence Mermaid state diagram
// against AE's delivery rules, then confirms two broken variants are caught.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ACTIONS = new Set(['EnterDeliver', 'Lock', 'Edit', 'Amend', 'Review', 'Verify', 'Compound', 'CaptureInsight']);
const REQUIRED = ['EnterDeliver', 'Lock', 'Edit', 'Review', 'Verify', 'Compound'];
const START = '[*]';

export const RULES = {
  'intent-before-edit': 'Every Edit follows a Lock (accepted intent).',
  'deliver-only-edits': 'Every Edit follows EnterDeliver; Answer, Investigate and Review never edit.',
  'current-evidence': 'Compound follows a Verify with no Edit or Amend since.',
  'insight-is-inert': 'CaptureInsight never changes the delivery state.',
  'progress': 'After a Review, Compound stays reachable.',
};

/** Parse the stateDiagram subset used by workflow.mmd: `A --> B` with an optional `: Action` label. */
export function parseStateDiagram(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('%%'));
  if (lines[0] !== 'stateDiagram-v2' && lines[0] !== 'stateDiagram') throw new Error('model must start with stateDiagram-v2');
  const edges = [];
  for (const line of lines.slice(1)) {
    const match = /^(\[\*\]|[A-Za-z][A-Za-z0-9]*)\s*-->\s*(\[\*\]|[A-Za-z][A-Za-z0-9]*)(?:\s*:\s*([A-Za-z]+))?$/.exec(line);
    if (!match) throw new Error(`unsupported model line: ${line}`);
    const [, from, to, action = null] = match;
    if (action && !ACTIONS.has(action)) throw new Error(`unknown action: ${action}`);
    edges.push({ from, to, action });
  }
  return edges;
}

/** Explore (state, Lock seen, EnterDeliver seen, proof current) and report rule violations. */
export function checkWorkflow(edges) {
  const violations = [];
  const report = (rule, edge, detail) => violations.push({ rule, edge: `${edge.from} --> ${edge.to}${edge.action ? ` : ${edge.action}` : ''}`, detail });
  for (const action of REQUIRED) if (!edges.some(edge => edge.action === action)) violations.push({ rule: 'well-formed', edge: null, detail: `missing ${action} transition` });
  for (const edge of edges) if (edge.action === 'CaptureInsight' && edge.from !== edge.to) report('insight-is-inert', edge, 'CaptureInsight moves to another state');

  const outgoing = state => edges.filter(edge => edge.from === state);
  const key = node => `${node.state}|${+node.locked}|${+node.deliver}|${+node.current}`;
  const step = (node, edge) => ({
    state: edge.to,
    locked: node.locked || edge.action === 'Lock',
    deliver: node.deliver || edge.action === 'EnterDeliver',
    current: edge.action === 'Verify' ? true : ['Edit', 'Amend'].includes(edge.action) ? false : node.current,
  });
  const seen = new Map();
  const queue = [{ state: START, locked: false, deliver: false, current: false }];
  seen.set(key(queue[0]), queue[0]);
  while (queue.length) {
    const node = queue.shift();
    for (const edge of outgoing(node.state)) {
      if (edge.action === 'Edit' && !node.locked) report('intent-before-edit', edge, 'reachable before Lock');
      if (edge.action === 'Edit' && !node.deliver) report('deliver-only-edits', edge, 'reachable outside Deliver');
      if (edge.action === 'Compound' && !node.current) report('current-evidence', edge, 'reachable without current Verify');
      const next = step(node, edge);
      if (next.state !== START && !seen.has(key(next))) { seen.set(key(next), next); queue.push(next); }
    }
  }

  const reachable = new Set([...seen.values()].map(node => node.state));
  const canCompound = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of edges) {
      if (canCompound.has(edge.from)) continue;
      if (edge.action === 'Compound' || canCompound.has(edge.to)) { canCompound.add(edge.from); changed = true; }
    }
  }
  const afterReview = new Set(edges.filter(edge => edge.action === 'Review' && reachable.has(edge.from)).map(edge => edge.to));
  for (const queue2 = [...afterReview]; queue2.length;) {
    const state = queue2.shift();
    for (const edge of outgoing(state)) if (edge.to !== START && !afterReview.has(edge.to)) { afterReview.add(edge.to); queue2.push(edge.to); }
  }
  for (const state of afterReview) if (state !== START && outgoing(state).some(edge => edge.to !== START) && !canCompound.has(state)) violations.push({ rule: 'progress', edge: null, detail: `${state} cannot reach Compound` });
  for (const state of afterReview) if (!outgoing(state).length) violations.push({ rule: 'progress', edge: null, detail: `${state} is a dead end` });

  const unique = [...new Map(violations.map(v => [JSON.stringify(v), v])).values()];
  return { passed: unique.length === 0, states: reachable.size - 1, explored: seen.size, violations: unique };
}

/** Broken variants the checker must reject: an unguarded Compound, and no Verify. */
export function negativeControls(edges) {
  const reviewed = [...new Set(edges.filter(edge => edge.action === 'Review').map(edge => edge.to))];
  const compoundTarget = edges.find(edge => edge.action === 'Compound')?.to;
  return [
    { id: 'unguarded-compound', expect: 'current-evidence', edges: [...edges, ...reviewed.map(from => ({ from, to: compoundTarget, action: 'Compound' }))] },
    { id: 'no-verify', expect: 'progress', edges: edges.filter(edge => edge.action !== 'Verify') },
  ];
}

export function run(modelPath) {
  const edges = parseStateDiagram(fs.readFileSync(modelPath, 'utf8'));
  const model = checkWorkflow(edges);
  const controls = negativeControls(edges).map(control => {
    const result = checkWorkflow(control.edges);
    return { id: control.id, expect: control.expect, detected: result.violations.some(v => v.rule === control.expect), violations: result.violations.map(v => v.rule) };
  });
  const passed = model.passed && controls.every(control => control.detected);
  return { schema: 1, check: 'delivery-evidence-model', model: path.basename(modelPath), rules: RULES, passed, result: model, negativeControls: controls,
    limits: 'The diagram has no counters or data, so bounds such as edit counts are covered by the workflow-invariant behavior checks, not here.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const receipt = run(path.join(here, '..', 'workflow.mmd'));
  const dir = process.env.HARNESS_CHECK_ARTIFACT_DIR;
  if (dir) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'delivery-evidence-model.json'), `${JSON.stringify(receipt, null, 2)}\n`); }
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (!receipt.passed) process.exitCode = 1;
}
