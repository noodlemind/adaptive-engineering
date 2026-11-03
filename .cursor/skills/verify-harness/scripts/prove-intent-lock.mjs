#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  assertEqual,
  assertMatch,
  cleanup,
  git,
  initWorkspace,
  parseFrontmatter,
  runHarness,
  sha256,
  writeEvidence,
  writeTracked,
  YAML,
} from './lib.mjs';

const SPEC_REL = 'docs/specs/checkout.md';
const SPEC_BODY = '# Checkout retry\n\nRefunds share the payment retry budget.\n';
const SPEC_SHA = sha256(SPEC_BODY);
const created = [];

function parseJson(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} stdout was not JSON: ${result.stdout}\n${result.stderr}`);
  }
}

try {
  const ctx = initWorkspace();
  created.push(ctx.ws, ctx.home, ctx.copilotHome);
  writeTracked(ctx.ws, SPEC_REL, SPEC_BODY);

  const oriented = await runHarness(['orient', '--query', 'checkout retry'], ctx);
  assertEqual(oriented.status, 0, 'orient exit');
  const orientBody = parseJson(oriented, 'orient');
  assertEqual(orientBody.intentSources[0].path, SPEC_REL, 'orient intentSources path');
  assertEqual(orientBody.intentSources[0].kind, 'spec', 'orient intentSources kind');

  const createdPlan = await runHarness(
    [
      'plan-new',
      '--type',
      'feat',
      '--slug',
      'checkout-retry',
      '--intent',
      'Honor the checkout spec',
      '--date',
      '2026-10-05',
      '--verification-check',
      'unit-tests',
    ],
    ctx
  );
  assertEqual(createdPlan.status, 0, `plan-new exit (${createdPlan.stderr})`);
  const planPath = parseJson(createdPlan, 'plan-new').path;
  const locked = parseFrontmatter(fs.readFileSync(planPath, 'utf8'));
  assertEqual(locked.intent_sources[0].path, SPEC_REL, 'plan-new intent_sources path');
  assertEqual(locked.intent_sources[0].sha256, SPEC_SHA, 'plan-new intent_sources sha256');

  fs.writeFileSync(path.join(ctx.ws, SPEC_REL), '# Drifted after lock\n');
  const drifted = await runHarness(['gate', '--phase', 'implement', '--plan', planPath], ctx);
  assertEqual(drifted.status, 1, `gate after spec edit exit (${drifted.stderr} ${drifted.stdout})`);
  const driftCheck = parseJson(drifted, 'gate-drift').checks.find((item) => item.id === 'C-intent-sources');
  assertEqual(driftCheck.pass, false, 'C-intent-sources after spec edit');
  assertMatch(driftCheck.message || '', /changed or unreadable/, 'C-intent-sources requires an amendment');

  const relock = await runHarness(['plan-update', '--plan', planPath, '--lock'], ctx);
  assertEqual(relock.status, 2, 'relock rejects changed selected bytes');
  assertEqual(parseFrontmatter(fs.readFileSync(planPath, 'utf8')).intent_sources[0].sha256, SPEC_SHA, 'relock preserves accepted hash');
  const digest = sha256(fs.readFileSync(planPath, 'utf8'));
  const decision = path.join(ctx.ws, '.harness/decisions/accept-source.json');
  fs.mkdirSync(path.dirname(decision), { recursive: true });
  fs.writeFileSync(decision, JSON.stringify({ version: 1, id: 'accept-source-change', action: 'amend', expect: digest,
    rationale: 'The fixture owner accepts the changed spec.', authority: { scope: 'plan-intent', basis: 'Fixture acceptance' },
    intentSources: [{ path: SPEC_REL, oldHash: SPEC_SHA }] }));
  const amended = await runHarness(['plan-update', '--plan', planPath, '--file', decision], ctx);
  assertEqual(amended.status, 0, `source amendment (${amended.stderr} ${amended.stdout})`);
  const accepted = await runHarness(['gate', '--phase', 'implement', '--plan', planPath], ctx);
  assertEqual(accepted.status, 0, 'gate after accepted source amendment');
  fs.rmSync(path.join(ctx.ws, SPEC_REL));
  const unreadable = await runHarness(['gate', '--phase', 'implement', '--plan', planPath], ctx);
  assertEqual(unreadable.status, 1, 'gate rejects missing selected file');
  fs.mkdirSync(path.join(ctx.ws, SPEC_REL));
  const directory = await runHarness(['gate', '--phase', 'implement', '--plan', planPath], ctx);
  assertEqual(directory.status, 1, 'gate rejects nonregular selected file');
  fs.rmdirSync(path.join(ctx.ws, SPEC_REL));

  const stringPlanRel = 'docs/plans/2026-10-05-feat-relock-plan.md';
  const stringPlan = path.join(ctx.ws, stringPlanRel);
  fs.mkdirSync(path.dirname(stringPlan), { recursive: true });
  fs.writeFileSync(
    stringPlan,
    `---
plan_schema: 1
title: Relock
type: feat
status: in-progress
plan_lock: false
phase: 1
risk: green
intent: Honor the checkout spec
expected_outputs: ["locked"]
success_criteria: ["AC1"]
verification:
  required: ["unit-tests"]
  criteria:
    AC1: ["unit-tests"]
reviews:
  required: []
  completed: []
  critical_open: []
capability_gaps: []
skills_used: ["engineer"]
intent_sources:
  - ${SPEC_REL}
---

# Relock

## Overview

Relock hashes.

## Intent Contract

- Goal: Honor the checkout spec

## Acceptance Criteria

- [x] **AC1** Example works.

## Plan

### Phase 1

- [x] Example works.

## Impacted Files

- \`src/example.js\`

## Verification Plan

- unit-tests

## Risk & Review Routing

- Green.

## Review Findings

- None.

## Activity

- Seeded for relock.
`
  );
  fs.writeFileSync(path.join(ctx.ws, SPEC_REL), SPEC_BODY);
  const relocked = await runHarness(['plan-update', '--plan', stringPlanRel, '--lock'], ctx);
  assertEqual(relocked.status, 0, `plan-update --lock exit (${relocked.stderr})`);
  const relockFm = parseFrontmatter(fs.readFileSync(stringPlan, 'utf8'));
  assertEqual(relockFm.intent_sources[0].path, SPEC_REL, 'plan-update --lock path');
  assertEqual(relockFm.intent_sources[0].sha256, SPEC_SHA, 'plan-update --lock sha256');

  const missingPlanRel = 'docs/plans/2026-10-05-feat-missing-plan.md';
  const missingPlan = path.join(ctx.ws, missingPlanRel);
  const missingFm = parseFrontmatter(fs.readFileSync(stringPlan, 'utf8'));
  missingFm.intent_sources = [];
  const missingBody = fs.readFileSync(stringPlan, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  fs.writeFileSync(missingPlan, `---\n${YAML.stringify(missingFm, { lineWidth: 0 })}---${missingBody}`);
  const missing = await runHarness(['gate', '--phase', 'implement', '--plan', missingPlanRel], ctx);
  assertEqual(missing.status, 1, 'gate missing source exit');
  const missingCheck = parseJson(missing, 'gate-missing').checks.find((item) => item.id === 'C-intent-sources');
  assertEqual(missingCheck.pass, false, 'C-intent-sources missing source');
  assertMatch(missingCheck.message, /docs\/specs\/checkout\.md/, 'C-intent-sources names the spec');

  // These siblings form one discovery fixture; their intermediate commits are
  // not part of the intent contract. Publish the same tracked tree together.
  const siblingPaths = [];
  for (let i = 1; i <= 12; i += 1) {
    const rel = `docs/specs/n${String(i).padStart(2, '0')}.md`;
    fs.writeFileSync(path.join(ctx.ws, rel), `# n${i}\n`);
    siblingPaths.push(rel);
  }
  const winnerRel = 'docs/specs/n13.md';
  fs.writeFileSync(path.join(ctx.ws, winnerRel), '# n13\n\nrefund buyer\n');
  siblingPaths.push(winnerRel);
  git(ctx.ws, ['add', '--', ...siblingPaths]);
  git(ctx.ws, ['commit', '-qm', 'add sibling discovery fixtures']);
  const siblingPlan = await runHarness(
    [
      'plan-new',
      '--type',
      'feat',
      '--slug',
      'refund-buyer',
      '--intent',
      'refund buyer',
      '--date',
      '2026-10-05',
      '--verification-check',
      'unit-tests',
    ],
    ctx
  );
  assertEqual(siblingPlan.status, 0, `sibling plan-new exit (${siblingPlan.stderr})`);
  const siblingPlanPath = parseJson(siblingPlan, 'sibling-plan-new').path;
  const siblingLocked = parseFrontmatter(fs.readFileSync(siblingPlanPath, 'utf8'));
  assertEqual(siblingLocked.intent_sources[0].path, winnerRel, 'sibling plan records the body winner');
  fs.writeFileSync(path.join(ctx.ws, winnerRel), '# n13\n\nno query words remain\n');
  const siblingGate = await runHarness(['gate', '--phase', 'implement', '--plan', siblingPlanPath], ctx);
  assertEqual(siblingGate.status, 1, `sibling gate exit (${siblingGate.stderr} ${siblingGate.stdout})`);
  const siblingCheck = parseJson(siblingGate, 'sibling-gate').checks.find((item) => item.id === 'C-intent-sources');
  assertEqual(siblingCheck.pass, false, 'sibling selected bytes changed');
  assertMatch(siblingCheck.message || '', /changed or unreadable/, 'sibling change fails without re-ranking');
  assertEqual(String(siblingCheck.message || '').includes('docs/specs/n01.md'), false, 'sibling check does not name n01');

  const evidence = writeEvidence('intent-lock', {
    feature: 'intent-lock',
    specPath: SPEC_REL,
    specSha256: SPEC_SHA,
    steps: [
      { command: 'orient', exit: oriented.status, intentSources: orientBody.intentSources },
      {
        command: 'plan-new',
        exit: createdPlan.status,
        path: planPath,
        intent_sources: locked.intent_sources,
      },
      {
        command: 'gate --phase implement after spec rewrite',
        exit: drifted.status,
        check: driftCheck,
      },
      { command: 'accepted source amendment', exit: amended.status, gateExit: accepted.status },
      { command: 'missing selected file', exit: unreadable.status },
      { command: 'nonregular selected file', exit: directory.status },
      {
        command: 'plan-update --lock',
        exit: relocked.status,
        intent_sources: relockFm.intent_sources,
      },
      {
        command: 'gate --phase implement with empty intent_sources',
        exit: missing.status,
        check: missingCheck,
      },
      {
        command: 'gate --phase implement after sibling body edit',
        exit: siblingGate.status,
        check: siblingCheck,
        winner: siblingLocked.intent_sources[0].path,
      },
    ],
  });
  process.stdout.write(`prove-intent-lock passed\n${evidence.dest}\n${evidence.copied || ''}\n`);
} finally {
  cleanup(created);
}
