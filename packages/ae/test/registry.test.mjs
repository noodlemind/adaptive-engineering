import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EXIT } from '../lib/style.mjs';
import { approveProject } from '../lib/trust.mjs';
import {
  dispatch,
  registerCommand,
  hasCommand,
  getCommand,
  listCommands,
  describeCommand,
  describeAll,
  validateArgs,
} from '../lib/registry.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');
const PILOTS = ['orient', 'learnings', 'status'];

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runHarness(args) {
  const full = [...args];
  const workspace = valueOf(full, '--workspace');
  let copilotHome = valueOf(full, '--copilot-home');
  if (!copilotHome && workspace) {
    copilotHome = tempDir('registry-home-');
    full.push('--copilot-home', copilotHome);
  }
  if (workspace && copilotHome) {
    try {
      approveProject({ workspace, copilotHome });
    } catch { /* a fixture with no writable home does not need trust */ }
  }
  return spawnSync(process.execPath, [binPath, ...full], { cwd: packageRoot, encoding: 'utf8' });
}

function valueOf(argv, name) {
  const eq = argv.find((a) => typeof a === 'string' && a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? null;
}

// --- registration -----------------------------------------------------

test('the three P1.1 pilots are registered', () => {
  for (const name of PILOTS) {
    assert.equal(hasCommand(name), true, `${name} should be registered`);
    assert.ok(getCommand(name), `${name} entry should be retrievable`);
  }
    for (const name of PILOTS) assert.ok(listCommands().includes(name));
});

test('every migrated command is registered; help stays a dedicated non-command branch', () => {
  for (const name of [
    'doctor', 'install', 'upgrade', 'uninstall', 'init-repo', 'index', 'plan-new',
    'events', 'consolidate', 'gate', 'verify', 'recall', 'get', 'validate-plan',
    'compound', 'report', 'knowledge', 'remember', 'learning', 'eval-knowledge', 'resolve',
  ]) {
    assert.equal(hasCommand(name), true, `${name} should be registered (P1.6 migration)`);
    assert.ok(getCommand(name), `${name} entry should be retrievable`);
    assert.ok(describeCommand(name), `${name} should have help data`);
  }
  assert.equal(hasCommand('help'), false, 'help is not a registered command');
  assert.equal(getCommand('help'), null);
  assert.equal(describeCommand('help'), null);
});

// --- side-effect metadata -----------------------------------------------

test('every pilot entry declares read-only side-effect metadata', () => {
  for (const name of PILOTS) {
    const entry = getCommand(name);
    assert.equal(entry.sideEffect, 'read', `${name} is a read path — recall/get/status convention`);
    assert.ok(Array.isArray(entry.capabilities));
    assert.deepEqual(entry.outputModes, ['ledger', 'json']);
    assert.equal(typeof entry.handler, 'function');
  }
});

test('P1.6 migrated commands carry the correct sideEffect classification', () => {
  const expected = {
    // read
    doctor: 'read',
    'validate-plan': 'read',
    recall: 'read',
    get: 'read',
    events: 'read',
    'eval-knowledge': 'read',
    resolve: 'read',
        install: 'mutate',
    upgrade: 'mutate',
    uninstall: 'mutate',
    'init-repo': 'mutate',
    index: 'mutate',
    'plan-new': 'mutate',
    gate: 'mutate',
    compound: 'mutate',
    report: 'mutate',
    knowledge: 'mutate',
    consolidate: 'mutate',
    remember: 'mutate',
    learning: 'mutate',
    // execute — spawns arbitrary trusted commands via lib/runner.mjs
    verify: 'execute',
  };
  for (const [name, sideEffect] of Object.entries(expected)) {
    const entry = getCommand(name);
    assert.ok(entry, `${name} must be registered`);
    assert.equal(entry.sideEffect, sideEffect, `${name} sideEffect classification`);
    assert.equal(['read', 'mutate', 'execute'].includes(entry.sideEffect), true);
  }
});

test('dispatch: a mutate-class command (gate) actually mutates session state through the real handler', async () => {
  const workspace = tempDir('registry-mutate-gate-');
  fs.mkdirSync(path.join(workspace, 'docs', 'plans'), { recursive: true });
  const sessionPath = path.join(workspace, '.harness', 'session.json');
  assert.equal(fs.existsSync(sessionPath), false, 'precondition: no session yet');

  const code = await dispatch(['gate', '--workspace', workspace, '--json'], {});
    assert.ok(Number.isInteger(code));
  assert.equal(fs.existsSync(sessionPath), true, 'gate must have written .harness/session.json');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.match(session.lastGateAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(getCommand('gate').sideEffect, 'mutate');
});

test('dispatch: an execute-class command (verify) is registered as execute and actually spawns a trusted check via the real handler', async () => {
  assert.equal(getCommand('verify').sideEffect, 'execute');

  const workspace = tempDir('registry-execute-verify-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const rel = 'docs/plans/2026-07-29-feat-registry-verify-plan.md';
  fs.writeFileSync(
    path.join(workspace, rel),
    `---
plan_schema: 1
title: "Registry verify example"
type: feat
status: in-progress
plan_lock: true
phase: 1
risk: green
intent: "registry-level execute dispatch"
expected_outputs: ["verified change"]
success_criteria: ["AC1 Example works"]
verification:
  required: [unit-tests]
  criteria:
    AC1: [unit-tests]
reviews: {required: [], completed: [], critical_open: []}
capability_gaps: []
skills_used: ["engineer"]
---

# Registry verify example

## Overview

Registry-level execute dispatch.

## Intent Contract

- **Goal:** Prove verify executes a trusted check via dispatch().
- **Expected outputs:** verified change.
- **Success criteria:** AC1 passes.

## Acceptance Criteria

- [x] **AC1** Example works.

## Plan

### Phase 1 — Implement

- [x] Implement the example.

## Impacted Files

- \`src/example.js\`

## Technical Notes

None.

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
  const configDir = path.join(workspace, '.github', 'harness');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'checks.yaml'),
    `version: 1\nchecks:\n  unit-tests:\n    command: ${JSON.stringify([process.execPath, '-e', 'process.exit(0)'])}\n`
  );
  const git = (args) =>
    spawnSync('git', args, { cwd: workspace, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  assert.equal(git(['init', '-q']).status, 0);
  git(['config', 'user.email', 'harness@example.test']);
  git(['config', 'user.name', 'Harness Test']);
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const value = 1;\n');
  git(['add', '.']);
  assert.equal(git(['commit', '-qm', 'baseline']).status, 0);

    const copilotHome = tempDir('registry-execute-home-');
  approveProject({ workspace, copilotHome });

  const code = await dispatch(['verify', '--plan', rel, '--base', 'HEAD', '--workspace', workspace, '--copilot-home', copilotHome, '--json'], {});
  assert.equal(code, 0, 'the trusted check actually ran (exit 0) through the real handler, not a stub');
  assert.ok(fs.existsSync(path.join(workspace, '.harness', 'evidence')), 'verify wrote evidence — the real cmdVerify ran, not a mock');
});

// --- help data generation -------------------------------------------------

test('describeCommand produces help data shaped for the existing renderer', () => {
  const orient = describeCommand('orient');
  assert.equal(orient.name, 'orient');
  assert.match(orient.summary, /context pack/);
  assert.equal(orient.group, 'engineer loop');
  assert.equal(orient.sideEffect, 'read');
  assert.ok(Array.isArray(orient.options));
  assert.ok(orient.options.some(([label]) => label.includes('--query')));
  assert.ok(orient.options.some(([label]) => label.includes('--collection') && label.includes('-c')));
  assert.match(orient.usage, /\[query\]/);

  const learnings = describeCommand('learnings');
  assert.ok(learnings.options.some(([label, desc]) => label.includes('--why') && /provenance/.test(desc)));
  assert.match(learnings.usage, /\[domain\]/);

  const status = describeCommand('status');
  assert.ok(status.options.some(([name]) => name === '--effective-policy'));
});

test('describeAll lists every registered command, pilots included', () => {
  const all = describeAll();
  const names = all.map((d) => d.name);
  for (const name of PILOTS) assert.ok(names.includes(name));
  // P1.6: no longer "exactly the pilots" — every migrated command is here too.
  assert.ok(names.length > PILOTS.length, 'describeAll must include the P1.6-migrated commands, not just the pilots');
  for (const d of all) {
    assert.equal(typeof d.summary, 'string');
    assert.ok(d.summary.length > 0);
  }
});

// --- strict arg validation -------------------------------------------------

test('validateArgs accepts every documented flag for each pilot, including global flags', () => {
  assert.doesNotThrow(() =>
    validateArgs(getCommand('orient'), ['--query', 'text', '--limit', '3', '-c', 'sql', '--min-score', '0.2', '--explain'])
  );
  assert.doesNotThrow(() => validateArgs(getCommand('orient'), ['--workspace', '/tmp/x', '--json', '--no-events']));
  assert.doesNotThrow(() => validateArgs(getCommand('learnings'), ['sql', '--why', 'sql/some-id']));
  assert.doesNotThrow(() => validateArgs(getCommand('status'), ['--copilot-home', '/tmp/y', '--verbose', '-v']));
});

test('validateArgs rejects an unknown flag with a structured E_USAGE error naming the flag', () => {
  assert.throws(
    () => validateArgs(getCommand('orient'), ['--not-a-real-flag']),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.equal(err.exit, EXIT.usage);
      assert.equal(err.exit, 2);
      assert.match(err.message, /--not-a-real-flag/);
      return true;
    }
  );
  assert.throws(
    () => validateArgs(getCommand('status'), ['--host', 'vscode']),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.match(err.message, /--host/);
      return true;
    }
  );
});

test('CLI: --files mistakes explain each command\'s canonical input form', () => {
  for (const [args, hint] of [
    [['orient', '--files', 'one.md'], 'Repeat --file <path> for each source. See ae help orient.'],
    [['agent', 'Inspect inputs', '--files', 'one.md'], 'Repeat --file <path> for each source. See ae help agent.'],
    [['review', 'prepare', '--files', 'one.md', 'two.md'], 'For review prepare, repeat --file <path> for each source. Review assemble accepts exactly one JSON document via --file <path>. See ae help review.'],
    [['domain', 'review', 'prepare', '--files', 'one.md'], 'For domain review prepare, repeat --file <path> for each source. Domain decisions and review assemble accept exactly one JSON document via --file <path>. See ae help domain.'],
    [['plan-new', '--files=one.json'], 'Use --file <path> with one input document. See ae help plan-new.'],
    [['plan-update', '--files', 'one.json'], 'Use --file <path> with one input document. See ae help plan-update.'],
  ]) {
    const result = runHarness([...args, '--json']);
    assert.equal(result.status, 2, result.stderr);
    const error = JSON.parse(result.stderr).error;
    assert.equal(error.code, 'E_USAGE');
    assert.match(error.message, /unknown flag: --files|domain: unsupported option --files/);
    assert.equal(error.hint, hint);
  }
  assert.doesNotThrow(() => validateArgs(getCommand('tree'), ['--files']));
  assert.doesNotThrow(() => validateArgs(getCommand('agent'), ['Inspect', '--', '--files', 'one.json']));
});

test('CLI: tree keeps its boolean --files option', t => {
  const workspace = tempDir('registry-tree-files-');
  const copilotHome = tempDir('registry-tree-home-');
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(copilotHome, { recursive: true, force: true }); });
  const git = spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  fs.writeFileSync(path.join(workspace, 'source one=two.md'), '# Source\n');
  const result = runHarness(['tree', 'workspace', '--files', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).files, ['source one=two.md']);
});

test('validateArgs treats a flag-shaped next token as a missing value, not a swallowed one', () => {
    assert.throws(
    () => validateArgs(getCommand('learnings'), ['--why', '--bogus']),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.match(err.message, /--bogus/);
      return true;
    }
  );
    assert.doesNotThrow(() => validateArgs(getCommand('learnings'), ['--why']));
});

test('validateArgs consumes a negative-number value for a numeric flag, not as a flag boundary', () => {
  assert.doesNotThrow(() => validateArgs(getCommand('orient'), ['--min-score', '-0.5', '--json']));
  assert.doesNotThrow(() => validateArgs(getCommand('orient'), ['--limit', '-3']));
});

test('validateArgs consumes a single-dash-prefixed string value, not as a flag boundary', () => {
  assert.doesNotThrow(() => validateArgs(getCommand('orient'), ['--query', '-explain-mode', '--json']));
  assert.doesNotThrow(() => validateArgs(getCommand('learnings'), ['--why', '-weird-id', '--json']));
});

// --- dispatch: resolves pilots, rejects unknown commands/flags ------------

test('dispatch resolves a registered pilot and runs its existing handler', async () => {
  const workspace = tempDir('registry-ws-');
  const copilotHome = tempDir('registry-home-');
  const code = await dispatch(['status', '--workspace', workspace, '--copilot-home', copilotHome, '--json'], {});
  assert.equal(code, 0);
});

test('dispatch rejects an unregistered command with a structured E_USAGE error', async () => {
  await assert.rejects(
    () => dispatch(['definitely-not-a-command'], {}),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.equal(err.exit, EXIT.usage);
      assert.match(err.message, /definitely-not-a-command/);
      return true;
    }
  );
});

test('dispatch rejects an unknown flag before the handler runs (no side effect)', async () => {
  const workspace = tempDir('registry-noop-');
  const copilotHome = tempDir('registry-noop-home-');
  await assert.rejects(
    () => dispatch(['orient', '--workspace', workspace, '--copilot-home', copilotHome, '--totally-bogus'], {}),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.equal(err.exit, 2);
      assert.match(err.message, /--totally-bogus/);
      return true;
    }
  );
  assert.equal(fs.existsSync(path.join(workspace, '.harness')), false, 'orient must not have run');
});

// --- end-to-end CLI wiring --------------------------------------------------

test('CLI: registry-dispatched orient produces the same JSON envelope shape as before', () => {
  const workspace = tempDir('registry-e2e-ws-');
  const copilotHome = tempDir('registry-e2e-home-');
  const result = runHarness(['orient', '--query', 'orders timeout', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok('contextPack' in body);
  assert.ok('recall' in body);
  assert.ok('plans' in body);
  assert.ok('gateStatus' in body);
});

test('CLI: registry-dispatched learnings rejects an unknown flag with exit 2 and a structured JSON error', () => {
  const workspace = tempDir('registry-e2e-ws2-');
  const copilotHome = tempDir('registry-e2e-home2-');
  const result = runHarness(['learnings', '--workspace', workspace, '--copilot-home', copilotHome, '--json', '--not-a-flag']);

  assert.equal(result.status, EXIT.usage);
  assert.equal(result.status, 2);
  const body = JSON.parse(result.stderr);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_USAGE');
  assert.match(body.error.message, /--not-a-flag/);
  assert.equal(body.error.exit, 2);
});

test('CLI: registry-dispatched status still renders the human ledger line unchanged', () => {
  const copilotHome = tempDir('registry-e2e-home3-');
  const workspace = tempDir('registry-e2e-ws3-');
  const result = runHarness(['status', '--copilot-home', copilotHome, '--workspace', workspace, '--no-events']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /harness\s+\d+\.\d+\.\d+/);
  assert.match(result.stdout, /home\s+/);
});

test('CLI: a non-pilot registered command (events) dispatches through the registry end to end', () => {
  const workspace = tempDir('registry-fallthrough-ws-');
  const result = runHarness(['events', '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok('count' in body);
});

test('CLI: a genuinely unknown top-level command produces a structured E_USAGE error', () => {
  const result = runHarness(['this-command-does-not-exist']);

  assert.equal(result.status, EXIT.usage);
  assert.match(result.stderr, /unknown command: this-command-does-not-exist/);
});

test('CLI repro 1: a negative-number --min-score value reaches parseMinScore unchanged (E_USAGE, exit 2)', () => {
  const workspace = tempDir('registry-repro1-ws-');
  const copilotHome = tempDir('registry-repro1-home-');
  const result = runHarness(['orient', '--min-score', '-0.5', '--json', '--workspace', workspace, '--copilot-home', copilotHome]);

  assert.equal(result.status, 2, result.stderr);
  const body = JSON.parse(result.stderr);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_USAGE');
  assert.match(body.error.message, /invalid --min-score: "-0\.5" — must be a number between 0 and 1/);
  assert.equal(body.error.exit, 2);
});

test('CLI repro 2: a dash-prefixed --query value is consumed as free text, not rejected (exit 0)', () => {
  const workspace = tempDir('registry-repro2-ws-');
  const copilotHome = tempDir('registry-repro2-home-');
  const result = runHarness(['orient', '--query', '-explain-mode', '--json', '--workspace', workspace, '--copilot-home', copilotHome]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.gateStatus, 'blocked');
  assert.ok('contextPack' in body);
});

test('CLI repro 3: a dash-prefixed --why id is consumed as the lookup id, not rejected (E_TARGET, exit 1)', () => {
  const workspace = tempDir('registry-repro3-ws-');
  const copilotHome = tempDir('registry-repro3-home-');
  const result = runHarness(['learnings', '--why', '-weird-id', '--json', '--workspace', workspace, '--copilot-home', copilotHome]);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, false);
  assert.equal(body.id, '-weird-id');
  assert.equal(body.blockedReason, 'E_TARGET: no learning -weird-id');
});

test('CLI: recall without a query is E_USAGE/exit 2 with the original message (was E_UNEXPECTED/exit 1)', () => {
  const workspace = tempDir('registry-recall-usage-ws-');
  const copilotHome = tempDir('registry-recall-usage-home-');
  const result = runHarness(['recall', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);

  assert.equal(result.status, EXIT.usage);
  assert.equal(result.status, 2);
  const body = JSON.parse(result.stderr);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_USAGE');
  assert.equal(body.error.message, 'recall requires a query string, e.g. ae recall "orders timeout"');
  assert.equal(body.error.exit, 2);
});

test('CLI: get without --docid or --path is E_USAGE/exit 2 with the original message (was E_UNEXPECTED/exit 1)', () => {
  const workspace = tempDir('registry-get-usage-ws-');
  const copilotHome = tempDir('registry-get-usage-home-');
  const result = runHarness(['get', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);

  assert.equal(result.status, EXIT.usage);
  assert.equal(result.status, 2);
  const body = JSON.parse(result.stderr);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_USAGE');
  assert.equal(body.error.message, 'get requires --docid <id>, --path <relative-path>, or --reference <installed-corpus-path>');
  assert.equal(body.error.exit, 2);
});

test('CLI: plan-new without --slug is E_USAGE/exit 2 with the original message (was E_UNEXPECTED/exit 1)', () => {
  const workspace = tempDir('registry-plannew-slug-usage-ws-');
  const result = runHarness(['plan-new', '--type', 'feat', '--intent', 'do the thing', '--workspace', workspace, '--dry-run', '--json']);

  assert.equal(result.status, EXIT.usage);
  assert.equal(result.status, 2);
  const body = JSON.parse(result.stderr);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_USAGE');
  assert.equal(body.error.message, 'plan-new: --slug is required and must be lowercase-hyphen (a-z0-9-)');
  assert.equal(body.error.exit, 2);
});

test('CLI: plan-new without --intent is E_USAGE/exit 2 with the original message (was E_UNEXPECTED/exit 1)', () => {
  const workspace = tempDir('registry-plannew-intent-usage-ws-');
  const result = runHarness(['plan-new', '--type', 'feat', '--slug', 'my-fine-slug', '--workspace', workspace, '--dry-run', '--json']);

  assert.equal(result.status, EXIT.usage);
  assert.equal(result.status, 2);
  const body = JSON.parse(result.stderr);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_USAGE');
  assert.equal(body.error.message, 'plan-new: --intent is required');
  assert.equal(body.error.exit, 2);
});

test('CLI: plan-new with a malformed --slug is E_USAGE/exit 2 with the original message', () => {
  const workspace = tempDir('registry-plannew-badslug-usage-ws-');
  const result = runHarness([
    'plan-new', '--type', 'feat', '--slug', 'Not A Slug!', '--intent', 'do the thing',
    '--workspace', workspace, '--dry-run', '--json',
  ]);

  assert.equal(result.status, EXIT.usage);
  const body = JSON.parse(result.stderr);
  assert.equal(body.error.code, 'E_USAGE');
  assert.equal(body.error.message, 'plan-new: --slug is required and must be lowercase-hyphen (a-z0-9-)');
});

// --- requireArgs: a correctly-invoked call is unaffected -------------------

test('CLI: a correctly-invoked recall/get/plan-new is unaffected by requireArgs', () => {
  const workspace = tempDir('registry-requireargs-ok-ws-');
  const copilotHome = tempDir('registry-requireargs-ok-home-');

  const recall = runHarness(['recall', 'orders timeout', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);
  assert.equal(recall.status, 0, recall.stderr);
  assert.deepEqual(JSON.parse(recall.stdout), { query: 'orders timeout', recall: [], plans: [] });

  const docPath = path.join(workspace, 'notes.md');
  fs.writeFileSync(docPath, '# notes\n\nhello\n');
  const get = runHarness(['get', '--path', 'notes.md', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);
  assert.equal(get.status, 0, get.stderr);
  const getBody = JSON.parse(get.stdout);
  assert.equal(getBody.path, 'notes.md');
  assert.match(getBody.excerpt, /hello/);

  const planWorkspace = tempDir('registry-requireargs-ok-plan-ws-');
  fs.mkdirSync(path.join(planWorkspace, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(
    path.join(planWorkspace, '.github', 'harness', 'checks.yaml'),
    'version: 1\nchecks:\n  unit-tests:\n    command: [npm, test]\n'
  );
  const planNew = runHarness([
    'plan-new', '--type', 'feat', '--slug', 'my-fine-slug', '--intent', 'do the thing',
    '--workspace', planWorkspace, '--dry-run', '--json',
  ]);
  assert.equal(planNew.status, 0, planNew.stderr);
  assert.equal(JSON.parse(planNew.stdout).created, false);
});

test('a lane-bearing result reporting a non-ok status exits non-zero without needing exitOf', async () => {
  const name = `probe-lane-parity-${process.pid}`;
  registerCommand({
    name,
    summary: 'fixture: reports failure as data rather than by throwing',
    group: 'engineer loop',
    sideEffect: 'read',
    capabilities: [],
    outputModes: ['ledger', 'json'],
    args: { positionals: [], flags: [] },
    handler: async () => 1,
    // Deliberately NO exitOf — that is the property under test.
    resultOf: async () => ({ schema: 1, status: 'failed', detail: 'the thing did not work' }),
  });

  const failed = await dispatch([name], { output: 'json' });
  assert.equal(failed, 1, 'a non-ok status must reach the exit code even with no exitOf declared');

  const okName = `${name}-ok`;
  registerCommand({
    name: okName,
    summary: 'fixture: succeeds',
    group: 'engineer loop',
    sideEffect: 'read',
    capabilities: [],
    outputModes: ['ledger', 'json'],
    args: { positionals: [], flags: [] },
    handler: async () => 0,
    resultOf: async () => ({ schema: 1, detail: 'fine' }),
  });
  assert.equal(await dispatch([okName], { output: 'json' }), EXIT.ok,
    'and a result with no status still succeeds, so nothing regressed for the read commands');
});

test('exitOf overrides the derived default when a command needs a specific code', async () => {
  const name = `probe-exit-override-${process.pid}`;
  registerCommand({
    name,
    summary: 'fixture: needs its own code',
    group: 'engineer loop',
    sideEffect: 'read',
    capabilities: [],
    outputModes: ['ledger', 'json'],
    args: { positionals: [], flags: [] },
    handler: async () => 7,
    resultOf: async () => ({ schema: 1, status: 'failed', exitCode: 7 }),
    exitOf: (result) => result.exitCode,
  });
  assert.equal(await dispatch([name], { output: 'json' }), 7);
});
