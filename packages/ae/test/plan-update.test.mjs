import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import YAML from 'yaml';
import { applyPlanUpdate, planUpdateLockDir } from '../lib/plan-update.mjs';
import { tempDir } from './helpers/temp.mjs';

const binPath = path.resolve(import.meta.dirname, '..', 'bin', 'ae.mjs');
const roots = [];
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const aeHome = ws => path.join(path.dirname(ws), 'harness-home');
const copilotHome = ws => path.join(path.dirname(ws), '.copilot-home');
const runtimeEnv = ws => ({ ...process.env, COPILOT_HOME: copilotHome(ws), AE_HOME: aeHome(ws), HARNESS_HOME: aeHome(ws) });

function workspace() {
  const root = tempDir('harness-plan-update-');
  roots.push(root);
  const ws = path.join(root, 'product');
  fs.mkdirSync(path.join(ws, 'docs', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'policy.yaml'), 'version: 1\nenforcement: enforce\ngate_ttl_minutes: 30\nevidence_ttl_hours: 24\n');
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'checks.yaml'), 'version: 1\nchecks:\n  unit-tests:\n    command: [npm, test]\n');
  const git = (args) => spawnSync('git', args, {
    cwd: ws,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  git(['init', '-q']);
  git(['config', 'user.email', 'e@x.test']);
  git(['config', 'user.name', 'T']);
  return ws;
}

function harness(ws, args) {
  const home = copilotHome(ws);
  fs.mkdirSync(home, { recursive: true });
  const result = spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home], {
    cwd: ws,
    encoding: 'utf8',
    env: runtimeEnv(ws),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function frontmatter(text) {
  return YAML.parse(text.match(/^---\n([\s\S]*?)\n---/)[1]);
}

function newPlan(ws, type = 'feat') {
  const created = harness(ws, [
    'plan-new', '--type', type, '--slug', `${type}-shape`, '--intent', 'Do the work',
    '--date', '2026-07-21', '--json',
  ]);
  assert.equal(created.status, 0, created.stderr);
  return JSON.parse(created.stdout).path;
}

test('plan-update refuses a path outside the plan store and does not write it', () => {
  const ws = workspace();
  const outside = path.join(aeHome(ws), 'trust.yaml');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, 'trust: no\n');
  const refused = harness(ws, ['plan-update', '--plan', outside, '--status', 'done', '--json']);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /outside the plan store/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'trust: no\n');

  const missing = path.join(os.tmpdir(), `not-a-plan-${process.pid}.md`);
  const absent = harness(ws, ['plan-update', '--plan', missing, '--status', 'done']);
  assert.equal(absent.status, 2, absent.stderr);
  assert.equal(fs.existsSync(missing), false);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('CLI: plan-update refuses repeated file inputs before reading a decision or changing the plan', () => {
  const ws = workspace();
  const plan = newPlan(ws);
  const original = fs.readFileSync(plan, 'utf8');
  for (const args of [
    ['--file', 'missing.json', '--file', 'other.json'],
    ['--file=missing.json', '--file=other.json'],
    ['--file', 'missing.json', '--file=missing.json'],
    ['--file', '-', '--file', 'missing.json'],
  ]) {
    const result = harness(ws, ['plan-update', '--plan', plan, ...args, '--json']);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, 'E_USAGE');
    assert.match(result.stderr, /one JSON document/);
    assert.equal(fs.readFileSync(plan, 'utf8'), original);
  }
});

test('CLI: plan-update preserves an equals file path with spaces and equals characters', () => {
  const ws = workspace();
  const created = harness(ws, ['plan-new', '--type', 'fix', '--slug', 'equals-update', '--intent', 'Keep the authored decision', '--json']);
  assert.equal(created.status, 0, created.stderr);
  const plan = JSON.parse(created.stdout);
  const file = 'update decision=ready.json';
  fs.writeFileSync(path.join(ws, file), JSON.stringify({ version: 1, id: 'equals-update', action: 'finding', expect: plan.revision, finding: { id: 'exact-input', text: 'The authored input path is preserved.' } }));
  const result = harness(ws, ['plan-update', '--plan', plan.path, `--file=${file}`, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(plan.path, 'utf8'), /exact-input: The authored input path is preserved/);
});

test('CLI: plan-update rejects post-boundary operands without applying them as flags', () => {
  const ws = workspace();
  const plan = newPlan(ws);
  const original = fs.readFileSync(plan, 'utf8');
  const result = harness(ws, ['plan-update', '--plan', plan, '--status', 'review', '--', '--file=missing.json']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /unexpected argument --file=missing.json/);
  assert.equal(fs.readFileSync(plan, 'utf8'), original);
});

test('plan-update refuses a symlink inside the plan store', () => {
  const ws = workspace();
  const plan = newPlan(ws);
  const outside = path.join(ws, 'outside.md');
  fs.writeFileSync(outside, 'leave me\n');
  const link = path.join(path.dirname(plan), 'linked-plan.md');
  fs.symlinkSync(outside, link);
  const refused = harness(ws, ['plan-update', '--plan', link, '--status', 'done']);
  assert.equal(refused.status, 2, refused.stderr);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'leave me\n');
  fs.rmSync(ws, { recursive: true, force: true });
});

test('plan-update edits an external plan body and review fields without the editor', () => {
  const ws = workspace();
  const plan = newPlan(ws);
  const updated = harness(ws, [
    'plan-update', '--plan', plan, '--status', 'review',
    '--activity', '2026-07-21 — code-review recorded',
    '--review-completed', 'code-review',
    '--critical-open', 'finding-1',
    '--old', 'TODO: add the files this plan will change',
    '--new', 'src/App.java',
    '--json',
  ]);
  assert.equal(updated.status, 0, updated.stderr);
  const body = fs.readFileSync(plan, 'utf8');
  const fm = frontmatter(body);
  assert.equal(fm.status, 'review');
  assert.deepEqual(fm.reviews.required, ['code-review']);
  assert.deepEqual(fm.reviews.completed, ['code-review']);
  assert.deepEqual(fm.reviews.critical_open, ['finding-1']);
  assert.match(body, /src\/App\.java/);
  assert.match(body, /2026-07-21 — code-review recorded/);
  assert.doesNotMatch(body, /TODO: add the files this plan will change/);

  const again = harness(ws, ['plan-update', '--plan', plan, '--review-completed', 'code-review', '--json']);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(frontmatter(fs.readFileSync(plan, 'utf8')).reviews.completed, ['code-review']);

  const cleared = harness(ws, ['plan-update', '--plan', plan, '--clear-critical', '--json']);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.deepEqual(frontmatter(fs.readFileSync(plan, 'utf8')).reviews.critical_open, []);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('plan-update can edit a legacy in-repo plan and refuses a repeated body match', () => {
  const ws = workspace();
  const legacy = path.join(ws, 'docs', 'plans', '2026-07-21-fix-legacy-plan.md');
  fs.writeFileSync(legacy, `---
plan_schema: 1
title: Legacy
status: planned
reviews:
  required: [code-review]
  completed: []
  critical_open: []
---

## Overview

alpha alpha

## Activity

- captured
`);
  const once = harness(ws, ['plan-update', '--plan', legacy, '--status', 'in-progress', '--json']);
  assert.equal(once.status, 0, once.stderr);
  assert.equal(frontmatter(fs.readFileSync(legacy, 'utf8')).status, 'in-progress');

  const before = fs.readFileSync(legacy, 'utf8');
  const twice = harness(ws, ['plan-update', '--plan', legacy, '--old', 'alpha', '--new', 'beta']);
  assert.equal(twice.status, 2, twice.stderr);
  assert.match(twice.stderr, /matched 2 times/);
  assert.equal(fs.readFileSync(legacy, 'utf8'), before);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('body replace cannot rewrite frontmatter, and dry-run writes nothing', () => {
  const text = `---
status: planned
intent: keep-intent
reviews:
  required: [code-review]
  completed: []
  critical_open: []
---

## Overview

keep-intent is the goal
`;
  assert.throws(() => applyPlanUpdate(text, { old: 'status: planned', next: 'status: done' }), /matched 0 times/);
  const changed = applyPlanUpdate(text, { old: 'keep-intent is the goal', next: 'the goal changed', status: 'review' });
  const fm = frontmatter(changed);
  assert.equal(fm.intent, 'keep-intent');
  assert.equal(fm.status, 'review');
  assert.match(changed, /the goal changed/);
  assert.doesNotMatch(changed.split('---').slice(2).join('---'), /status: review/);

  const ws = workspace();
  const plan = newPlan(ws);
  const before = fs.readFileSync(plan, 'utf8');
  const dry = harness(ws, ['plan-update', '--plan', plan, '--status', 'review', '--dry-run', '--json']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).dryRun, true);
  assert.equal(JSON.parse(dry.stdout).status, 'review');
  assert.equal(fs.readFileSync(plan, 'utf8'), before);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('an explicit path does not update a same-named plan', () => {
  const ws = workspace();
  const plan = newPlan(ws);
  const before = fs.readFileSync(plan, 'utf8');
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-other-plan-'));
  const decoy = path.join(other, path.basename(plan));
  fs.writeFileSync(decoy, 'other plan\n');
  const refused = harness(ws, ['plan-update', '--plan', decoy, '--status', 'done']);
  assert.notEqual(refused.status, 0, refused.stderr);
  assert.match(refused.stderr, /outside the plan store/);
  assert.equal(fs.readFileSync(plan, 'utf8'), before);
  assert.equal(fs.readFileSync(decoy, 'utf8'), 'other plan\n');
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
});

test('a symlink to a plan inside the store is refused', () => {
  const ws = workspace();
  const plan = newPlan(ws);
  const before = fs.readFileSync(plan, 'utf8');
  const link = path.join(path.dirname(plan), 'alias-plan.md');
  fs.symlinkSync(plan, link);
  const refused = harness(ws, ['plan-update', '--plan', link, '--status', 'done']);
  assert.equal(refused.status, 2, refused.stderr);
  assert.equal(fs.readFileSync(plan, 'utf8'), before);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('plan-update can lock a plan and record goal, checks, and gap fulfillment', () => {
  const ws = workspace();
  const plan = newPlan(ws);
  const seeded = fs.readFileSync(plan, 'utf8')
    .replace('plan_lock: true', 'plan_lock: false')
    .replace('capability_gaps: []', 'capability_gaps:\n  - {id: payment-audit, class: hard, fulfillment: proposed}');
  fs.writeFileSync(plan, seeded);
  if (process.platform !== 'win32') fs.chmodSync(plan, 0o600);
  const updated = harness(ws, [
    'plan-update', '--plan', plan, '--lock', '--intent', 'Ship the audit',
    '--expected-output', 'audit report', '--success-criterion', 'report exists',
    '--verification-check', 'unit-tests', '--gap-fulfillment', 'payment-audit:done', '--json',
  ]);
  assert.equal(updated.status, 0, updated.stderr);
  const fm = frontmatter(fs.readFileSync(plan, 'utf8'));
  assert.equal(fm.plan_lock, true);
  assert.equal(fm.intent, 'Ship the audit');
  assert.ok(fm.expected_outputs.includes('audit report'));
  assert.ok(fm.success_criteria.includes('report exists'));
  assert.ok(fm.verification.required.includes('unit-tests'));
  assert.deepEqual(fm.reviews.required, ['code-review']);
  assert.equal(fm.capability_gaps[0].fulfillment, 'done');
  assert.equal(fm.capability_gaps[0].class, 'hard');
  if (process.platform !== 'win32') assert.equal(fs.statSync(plan).mode & 0o777, 0o600);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('overlapping plan updates keep both changes', async () => {
  const ws = workspace();
  const plan = newPlan(ws);
  const home = copilotHome(ws);
  fs.mkdirSync(home, { recursive: true });
  const lock = planUpdateLockDir(plan);
  fs.mkdirSync(lock);
  const child = spawn(process.execPath, [
    binPath, 'plan-update', '--plan', plan, '--activity', 'from-child',
    '--workspace', ws, '--copilot-home', home,
  ], {
    cwd: ws,
    env: runtimeEnv(ws),
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(child.exitCode, null);
  assert.doesNotMatch(fs.readFileSync(plan, 'utf8'), /from-child/);
  const held = fs.readFileSync(plan, 'utf8');
  fs.writeFileSync(plan, held.includes('## Activity')
    ? held.replace('## Activity', '## Activity\n\n- from-parent')
    : `${held}\n## Activity\n\n- from-parent\n`);
  fs.rmdirSync(lock);
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  const after = fs.readFileSync(plan, 'utf8');
  assert.match(after, /from-parent/);
  assert.match(after, /from-child/);
  assert.equal(fs.existsSync(lock), false);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('ae edit still refuses an external plan path', () => {
  const ws = workspace();
  const plan = newPlan(ws);
  const before = fs.readFileSync(plan, 'utf8');
  const edit = harness(ws, ['edit', '--path', plan, '--old', 'None.', '--new', 'Changed.']);
  assert.notEqual(edit.status, 0, `${edit.stdout}${edit.stderr}`);
  assert.match(`${edit.stdout}${edit.stderr}`, /refusing to edit outside the workspace/);
  assert.equal(fs.readFileSync(plan, 'utf8'), before);
  fs.rmSync(ws, { recursive: true, force: true });
});
