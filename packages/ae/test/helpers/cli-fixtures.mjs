/**
 * Local fixtures shared by split harness CLI domain tests.
 * Extracted from harness-cli.test.mjs (Phase 2 hygiene).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runHarness, packageRoot, cliHarnessHome } from './cli.mjs';

export function writeKnowledgeSolution(copilotHome, {
  category = 'api',
  slug = 'orders-timeout',
  title = 'Orders API timeout',
  symptom = 'checkout requests hang after 30 seconds',
  module = 'orders-service',
  scope = 'global',
  tags = 'commerce, checkout',
  body = '## Problem\n\nCheckout requests hang after 30 seconds under load.',
} = {}) {
  const knowledgeRoot = path.join(copilotHome, 'knowledge');
  const solDir = path.join(knowledgeRoot, 'solutions', category);
  fs.mkdirSync(solDir, { recursive: true });
  fs.writeFileSync(
    path.join(solDir, `${slug}.md`),
    `---
title: "${title}"
category: ${category}
module: ${module}
symptom: ${symptom}
tags: ${tags}
date: 2026-05-01
---

${body}
`,
    'utf8'
  );
  fs.copyFileSync(
    path.join(packageRoot, 'corpus', 'knowledge', 'collections.yaml'),
    path.join(knowledgeRoot, 'collections.yaml')
  );
  fs.copyFileSync(
    path.join(packageRoot, 'corpus', 'knowledge', 'recall-synonyms.yaml'),
    path.join(knowledgeRoot, 'recall-synonyms.yaml')
  );
  return `${scope}-${category}-${slug}`;
}

export function runIndex(workspace, copilotHome) {
  const result = runHarness(['index', '--workspace', workspace, '--copilot-home', copilotHome]);
  assert.equal(result.status, 0, result.stderr);
}

export function writeProductSolution(workspace, {
  category = 'product',
  slug = 'local-fix',
  title = 'Local product fix',
  symptom = 'product-only symptom',
} = {}) {
  const solDir = path.join(workspace, 'docs', 'solutions', category);
  fs.mkdirSync(solDir, { recursive: true });
  fs.writeFileSync(
    path.join(solDir, `${slug}.md`),
    `---
title: "${title}"
category: ${category}
symptom: ${symptom}
date: 2026-05-10
---

## Problem

Product scoped solution.
`,
    'utf8'
  );
  return `product-${category}-${slug}`;
}

export function writeChecks(workspace, checks) {
  const configDir = path.join(workspace, '.github', 'harness');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'checks.yaml'),
    `version: 1\nchecks:\n${Object.entries(checks)
      .map(
        ([name, check]) => {
          const timeout = check.timeout_seconds === undefined ? '' : `\n    timeout_seconds: ${check.timeout_seconds}`;
          return `  ${name}:\n    command: ${JSON.stringify(check.command)}${timeout}`;
        }
      )
      .join('\n')}\n`,
    'utf8'
  );
}

export function writeNoLearningDecision(workspace) {
  const full = path.join(workspace, '.harness/fixture-no-learning.json');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify({ operation: 'fixture-no-learning', decision: 'no-learning', rationale: 'Disposable test fixture has no durable product lesson.' }));
  return full;
}

export function writeVersionedPlan(workspace, {
  name = '2026-07-13-feat-verify-plan.md',
  required = ['unit-tests'],
  criteria = { AC1: ['unit-tests'] },
  impacted = ['src/example.js'],
  extraFrontmatter = '',
  taskChecked = true,
  skillsUsed = ['engineer'],
  technicalNotes = 'No additional technical notes.',
  intent = 'Verify safely',
} = {}) {
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  if (!fs.existsSync(path.join(workspace, '.github/harness/checks.yaml')) && required.length) {
    writeChecks(workspace, Object.fromEntries(required.map(name => [name, { command: [process.execPath, '-e', 'process.exit(0)'] }])));
  }
  const rel = `docs/plans/${name}`;
  const criterionYaml = Object.entries(criteria)
    .map(([id, checks]) => `    ${id}: ${JSON.stringify(checks)}`)
    .join('\n');
  fs.writeFileSync(
    path.join(workspace, rel),
    `---
plan_schema: 1
title: "Verify example"
type: feat
status: in-progress
plan_lock: true
phase: 1
risk: green
intent: ${JSON.stringify(intent)}
expected_outputs:
  - "verified change"
success_criteria:
  - "AC1 Example works"
verification:
  required: ${JSON.stringify(required)}
  criteria:
${criterionYaml}
reviews:
  required: []
  completed: []
  critical_open: []
capability_gaps: []
skills_used: ${JSON.stringify(skillsUsed)}
${extraFrontmatter}---

# Verify example

## Overview

Verify the example.

## Intent Contract

- **Goal:** Verify safely.
- **Expected outputs:** verified change.
- **Success criteria:** AC1 passes.

## Acceptance Criteria

- [x] **AC1** Example works.

## Plan

### Phase 1 — Implement

- [${taskChecked ? 'x' : ' '}] Implement the example.

## Impacted Files

${impacted.map((file) => `- \`${file}\``).join('\n')}

## Technical Notes

${technicalNotes}

## Verification Plan

Run trusted named checks.

## Risk & Review Routing

No required specialist review.

## Review Findings

No open findings.

## Activity

- Work recorded.
`,
    'utf8'
  );
  return rel;
}

export function initGit(workspace) {
  const run = (args) =>
    spawnSync('git', args, {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  assert.equal(run(['init', '-q']).status, 0);
  assert.equal(run(['config', 'user.email', 'harness@example.test']).status, 0);
  assert.equal(run(['config', 'user.name', 'Harness Test']).status, 0);
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const value = 1;\n');
  assert.equal(run(['add', '.']).status, 0);
  assert.equal(run(['commit', '-qm', 'baseline']).status, 0);
}

export function runHook(name, workspace, toolInput = {}) {
  return spawnSync(process.execPath, [path.join(packageRoot, 'corpus', 'hooks', name)], {
    cwd: workspace,
    input: JSON.stringify({ workspace, tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: process.env.HARNESS_HOME || cliHarnessHome(), HARNESS_ENFORCEMENT: 'enforce', HARNESS_BIN: path.join(packageRoot, 'bin', 'ae.mjs') },
  });
}

export function runHookWithPolicy(name, workspace, toolInput = {}) {
  const env = { ...process.env };
  env.HARNESS_HOME ||= cliHarnessHome();
  env.HARNESS_BIN = path.join(packageRoot, 'bin/ae.mjs');
  delete env.HARNESS_ENFORCEMENT;
  return spawnSync(process.execPath, [path.join(packageRoot, 'corpus', 'hooks', name)], {
    cwd: workspace,
    input: JSON.stringify({ workspace, tool_input: toolInput }),
    encoding: 'utf8',
    env,
  });
}

export function hookResponse(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

export function assertHookBlocked(result, pattern) {
  const response = hookResponse(result);
  const hook = response.hookSpecificOutput || {};
  assert.ok(hook.permissionDecision === 'deny' || hook.decision === 'block', result.stdout);
  const reason = hook.permissionDecisionReason || hook.reason || response.reason || '';
  if (pattern) assert.match(reason, pattern);
  return response;
}

export function recordSuccessfulEdit(workspace, toolInput) {
  return hookResponse(runHook('record-successful-edit.mjs', workspace, toolInput));
}

/** Shared technical notes for primitive-path gate tests. */
export const primitiveAnalysis = `
- Primitive classification: modify the existing skill because it owns the workflow.
- Existing-capability overlap analysis: reuse the Existing /java skill and Existing /aws skill instead of duplicating them.
- Intended artifact structure: keep the procedure in SKILL.md and dense guidance in a reference.
- Trigger and negative-trigger implications: route migration delivery here; exclude one-off API questions.
- Verification expectations: run prompt, host, and built-asset contracts.
- Registry and documentation impact: update them only if a new skill is justified.
`.trim();

const FLOW_CLASSES = ['positive', 'malformed-input', 'boundary', 'dependency-failure', 'concurrency', 'old-state', 'abuse', 'cross-boundary'];
const PROSE_OR_MEDIA = /\.(?:md|markdown|mdx|txt|rst|adoc|png|jpe?g|gif|svg|webp|ico)$/i;

/**
 * Scripted spec-flow-analyzer ledger for delivery fixtures: every flow class left as a testing gap through
 * line 1 of the packet's first changed file that is not prose or media. It exercises collection, not flow-tracing quality.
 */
export function scriptedFlowLedger(packet, reviewer) {
  if (reviewer !== 'spec-flow-analyzer') return {};
  const file = (packet?.scope?.changedFiles || []).find(name => !PROSE_OR_MEDIA.test(name));
  if (!file) return {};
  return { flow_ledger: FLOW_CLASSES.map(flow_class => ({ flow_class, entry: `scripted ${file}`, input: `${flow_class} fixture input`, path: [`${file}:1`], expected: 'Scripted fixture expectation', observed: 'Not traced by the scripted fixture', verdict: 'gap', test: null })) };
}
