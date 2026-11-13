import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { externalPlansDir } from '../corpus/hooks/lib/external-plans.mjs';
import { approveProject } from '../lib/trust.mjs';
import { writeChecks, scriptedFlowLedger } from './helpers/cli-fixtures.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '../..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');
const gateHook = path.join(repoRoot, 'packages', 'ae', 'corpus', 'hooks', 'require-plan-gate.mjs');
const GOAL = 'Ship the edit';
const ACCEPTANCE = 'The edit is allowed';
const CONSTRAINT = 'Do not invent plan text';
const RECORD = { goal: GOAL, acceptance: [ACCEPTANCE], constraints: [CONSTRAINT] };

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function coldRepo() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-short-plan-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-short-plan-home-'));
  fs.writeFileSync(path.join(ws, 'README.md'), 'cold\n');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src', 'app.js'), 'export const n = 1;\n');
  writeChecks(ws, { behavior: { command: [process.execPath, '-e', "import('./src/app.js').then(m => { if (m.n !== 2) process.exit(1); })"] } });
  git(ws, ['init', '-q']);
  git(ws, ['config', 'user.email', 'e@x.test']);
  git(ws, ['config', 'user.name', 'T']);
  git(ws, ['add', 'README.md', 'src/app.js']);
  const committed = git(ws, ['commit', '-qm', 'init']);
  assert.equal(committed.status, 0, committed.stderr || committed.stdout);
  approveProject({ workspace: ws, copilotHome: home, home });
  return { ws, home };
}

function removeRepo(c, previousHome) {
  if (previousHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = previousHome;
  fs.rmSync(c.ws, { recursive: true, force: true });
  fs.rmSync(c.home, { recursive: true, force: true });
}

function useHome(c) {
  const previous = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = c.home;
  return previous;
}

function harness(c, args) {
  if (args[0] === 'plan-new' && args.includes('--goal') && !args.includes('--verification-check')) args = [...args, '--verification-check', 'behavior'];
  return spawnSync(process.execPath, [binPath, ...args, '--workspace', c.ws, '--harness-home', c.home], {
    cwd: c.ws,
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: c.home, HARNESS_NO_EVENTS: '1' },
  });
}

function planFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
}

function recordFrom(text) {
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith('{'));
  assert.ok(line, text);
  return JSON.parse(line);
}

function editHook(c, file) {
  return spawnSync(process.execPath, [gateHook], {
    cwd: c.ws,
    input: JSON.stringify({
      cwd: c.ws,
      session_id: 'vscode-session',
      hook_event_name: 'PreToolUse',
      tool_name: 'replace_string_in_file',
      tool_input: { filePath: file },
    }),
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: c.home, HARNESS_ENFORCEMENT: 'enforce' },
  });
}

test('plan-new stores the short record outside the repo and the edit hook allows it', () => {
  const c = coldRepo();
  const previousHome = useHome(c);
  try {
    const created = harness(c, [
      'plan-new',
      '--goal', GOAL,
      '--acceptance', ACCEPTANCE,
      '--constraint', CONSTRAINT,
      '--json',
    ]);
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const written = JSON.parse(created.stdout);
    const external = externalPlansDir(c.ws);
    assert.equal(path.dirname(written.path), external);
    assert.equal(fs.existsSync(path.join(c.ws, 'docs', 'plans')), false);
    assert.deepEqual(planFiles(external), [path.basename(written.path)]);
    const before = fs.readFileSync(written.path, 'utf8');
    assert.deepEqual(recordFrom(before), RECORD);
    assert.equal(before.includes('## Overview'), false);
    assert.equal(before.includes('## Acceptance Criteria'), false);
    assert.equal(before.includes('## Activity'), false);
    assert.equal(before.includes('## Intent Contract'), false);
    assert.equal(before.includes('## Impacted Files'), false);
    assert.match(before, /^status: in-progress$/m);
    assert.match(before, /^plan_lock: true$/m);

    const gate = harness(c, ['gate', '--phase', 'implement', '--plan', written.path, '--json']);
    assert.equal(gate.status, 0, gate.stderr || gate.stdout);
    assert.equal(JSON.parse(gate.stdout).pass, true);

    const allowed = editHook(c, 'src/app.js');
    assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
    assert.equal(JSON.parse(allowed.stdout).continue, true);
    assert.equal(fs.readFileSync(written.path, 'utf8'), before);
  } finally {
    removeRepo(c, previousHome);
  }
});

test('an empty plan file fails the gate and the edit hook denies it without inventing text', () => {
  const c = coldRepo();
  const previousHome = useHome(c);
  try {
    const external = externalPlansDir(c.ws);
    fs.mkdirSync(external, { recursive: true });
    const empty = path.join(external, '2026-10-02-feat-empty-plan.md');
    fs.writeFileSync(empty, '');
    const gate = harness(c, ['gate', '--phase', 'implement', '--plan', empty, '--json']);
    assert.notEqual(gate.status, 0, gate.stdout);
    assert.equal(JSON.parse(gate.stdout).pass, false);
    const denied = editHook(c, 'src/app.js');
    assert.equal(denied.status, 0, denied.stderr || denied.stdout);
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(fs.readFileSync(empty, 'utf8'), '');
  } finally {
    removeRepo(c, previousHome);
  }
});

function markdownFiles(dir, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) markdownFiles(full, found);
    else if (name.endsWith('.md')) found.push(full);
  }
  return found;
}

test('plan-new rejects a date that is not YYYY-MM-DD and writes no plan file', () => {
  const c = coldRepo();
  const previousHome = useHome(c);
  try {
    const escaped = harness(c, [
      'plan-new',
      '--goal', GOAL,
      '--acceptance', ACCEPTANCE,
      '--constraint', CONSTRAINT,
      '--date', '../not-a-date',
      '--json',
    ]);
    assert.notEqual(escaped.status, 0, escaped.stdout);
    assert.match(escaped.stderr, /date must be YYYY-MM-DD/);
    assert.deepEqual(planFiles(externalPlansDir(c.ws)), []);
    assert.deepEqual(markdownFiles(c.home), []);
  } finally {
    removeRepo(c, previousHome);
  }
});

test('a short record that lists impacted files still denies an edit outside that list', () => {
  const c = coldRepo();
  const previousHome = useHome(c);
  try {
    const created = harness(c, [
      'plan-new',
      '--goal', GOAL,
      '--acceptance', ACCEPTANCE,
      '--constraint', CONSTRAINT,
      '--json',
    ]);
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const written = JSON.parse(created.stdout);
    fs.appendFileSync(written.path, '\n## Impacted Files\n\n- `README.md`\n');
    const gate = harness(c, ['gate', '--phase', 'implement', '--plan', written.path, '--json']);
    assert.equal(gate.status, 0, gate.stderr || gate.stdout);
    assert.equal(JSON.parse(gate.stdout).pass, true);

    const denied = editHook(c, 'src/app.js');
    assert.equal(denied.status, 0, denied.stderr || denied.stdout);
    const denial = JSON.parse(denied.stdout);
    assert.equal(denial.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(denial.hookSpecificOutput.permissionDecisionReason, /Impacted Files/);

    const allowed = editHook(c, 'README.md');
    assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
    assert.equal(JSON.parse(allowed.stdout).continue, true);
  } finally {
    removeRepo(c, previousHome);
  }
});

test('plan-new keeps a long goal when the cut lands on a hyphen', () => {
  const c = coldRepo();
  const previousHome = useHome(c);
  try {
    const goal = `${'a'.repeat(47)}-extra words`;
    const created = harness(c, [
      'plan-new',
      '--goal', goal,
      '--acceptance', ACCEPTANCE,
      '--constraint', CONSTRAINT,
      '--date', '2026-10-02',
      '--json',
    ]);
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const written = JSON.parse(created.stdout);
    assert.equal(path.basename(written.path), `2026-10-02-feat-${'a'.repeat(47)}-plan.md`);
    assert.equal(recordFrom(fs.readFileSync(written.path, 'utf8')).goal, goal);
  } finally {
    removeRepo(c, previousHome);
  }
});

test('plan-new --from rejects --goal and leaves the plan file', () => {
  const c = coldRepo();
  const previousHome = useHome(c);
  try {
    const created = harness(c, [
      'plan-new',
      '--goal', GOAL,
      '--acceptance', ACCEPTANCE,
      '--constraint', CONSTRAINT,
      '--json',
    ]);
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const written = JSON.parse(created.stdout);
    const before = fs.readFileSync(written.path, 'utf8');
    const mixed = harness(c, [
      'plan-new',
      '--from', written.path,
      '--goal', 'Other goal',
      '--acceptance', ACCEPTANCE,
      '--constraint', CONSTRAINT,
      '--json',
    ]);
    assert.notEqual(mixed.status, 0, mixed.stdout);
    assert.match(mixed.stderr, /--from cannot be combined with new-plan flags/);
    assert.equal(fs.readFileSync(written.path, 'utf8'), before);
  } finally {
    removeRepo(c, previousHome);
  }
});

test('plan-new --goal rejects --type and --risk and writes no plan file', () => {
  const c = coldRepo();
  const previousHome = useHome(c);
  try {
    const typed = harness(c, [
      'plan-new',
      '--goal', GOAL,
      '--acceptance', ACCEPTANCE,
      '--constraint', CONSTRAINT,
      '--type', 'fix',
      '--json',
    ]);
    assert.notEqual(typed.status, 0, typed.stdout);
    assert.match(typed.stderr, /--goal does not take --type, --risk/);
    const risked = harness(c, [
      'plan-new',
      '--goal', GOAL,
      '--acceptance', ACCEPTANCE,
      '--constraint', CONSTRAINT,
      '--risk', 'red',
      '--json',
    ]);
    assert.notEqual(risked.status, 0, risked.stdout);
    assert.match(risked.stderr, /--goal does not take --type, --risk/);
    assert.deepEqual(markdownFiles(c.home), []);
  } finally {
    removeRepo(c, previousHome);
  }
});

test('a short plan passes verify after a green file change', () => {
  const c = coldRepo();
  const previousHome = useHome(c);
  try {
    const created = harness(c, [
      'plan-new',
      '--goal', GOAL,
      '--acceptance', ACCEPTANCE,
      '--constraint', CONSTRAINT,
      '--json',
    ]);
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const plan = JSON.parse(created.stdout).path;
    fs.writeFileSync(path.join(c.ws, 'src', 'app.js'), 'export const n = 2;\n');
    const packet = JSON.parse(harness(c, ['review', 'prepare', '--plan', plan, '--base', 'HEAD', '--json']).stdout);
    const input = path.join(c.ws, '.harness/review-input.json');
    fs.writeFileSync(input, JSON.stringify({ packet: packet.id, results: packet.required.map(reviewer => ({ ...scriptedFlowLedger(packet, reviewer), reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [] })) }));
    const reviewed = harness(c, ['review', 'assemble', '--plan', plan, '--packet', packet.id, '--file', input, '--json']);
    assert.equal(reviewed.status, 0, reviewed.stdout + reviewed.stderr);
    const verified = harness(c, ['verify', '--plan', plan, '--base', 'HEAD', '--json']);
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);
    assert.equal(JSON.parse(verified.stdout).outcome, 'passed');
  } finally {
    removeRepo(c, previousHome);
  }
});

test('a short plan that lists impacted files still fails verify outside that list', () => {
  const c = coldRepo();
  const previousHome = useHome(c);
  try {
    const created = harness(c, [
      'plan-new',
      '--goal', GOAL,
      '--acceptance', ACCEPTANCE,
      '--constraint', CONSTRAINT,
      '--json',
    ]);
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const plan = JSON.parse(created.stdout).path;
    fs.appendFileSync(plan, '\n## Impacted Files\n\n- `README.md`\n');
    fs.writeFileSync(path.join(c.ws, 'src', 'app.js'), 'export const n = 2;\n');
    const verified = harness(c, ['verify', '--plan', plan, '--base', 'HEAD', '--json']);
    const body = JSON.parse(verified.stdout);
    assert.notEqual(body.outcome, 'passed');
    assert.equal(body.checks.find((check) => check.id === 'scope')?.status, 'failed');
  } finally {
    removeRepo(c, previousHome);
  }
});

test('plan-new --goal without acceptance or constraint writes no file', () => {
  const c = coldRepo();
  const previousHome = useHome(c);
  try {
    const missingAcceptance = harness(c, ['plan-new', '--goal', GOAL, '--constraint', CONSTRAINT, '--json']);
    assert.notEqual(missingAcceptance.status, 0);
    const missingConstraint = harness(c, ['plan-new', '--goal', GOAL, '--acceptance', ACCEPTANCE, '--json']);
    assert.notEqual(missingConstraint.status, 0);
    assert.deepEqual(planFiles(externalPlansDir(c.ws)), []);
    assert.equal(fs.existsSync(path.join(c.ws, 'docs', 'plans')), false);
  } finally {
    removeRepo(c, previousHome);
  }
});
