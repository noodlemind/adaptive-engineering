import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { contextAgentArgs, prepareCase, resolveStudyOutput, runChecks, runStudy, summarizeStudy } from '../eval/context/study.mjs';
import { agentResultOf } from '../lib/agent-cmd.mjs';
import { buildTaskHandoff, validateContextSnapshot } from '../lib/task-handoff.mjs';
import { readSession, writeSession } from '../lib/session.mjs';
import { readOrientSlice } from '../lib/orient-read.mjs';
import { buildChildEnv } from '../lib/exec-policy.mjs';
import { projectStoreDir } from '../lib/project-layout.mjs';

const simple = {
  id: 'example', split: 'development', family: 'known-file',
  prompt: 'Return 2 from value.', files: { 'src/value.mjs': 'export const value = 1;\n' },
  editable: ['src/value.mjs'], seeds: ['src/value.mjs'], requiredEvidence: ['src/value.mjs'],
  checks: [{ module: 'src/value.mjs', export: 'value', expected: 2 }],
};

const publicTask = {
  ...simple,
  files: { 'src/value.mjs': 'export const value = 1;\nexport const version = 1;\n' },
  publicChecks: simple.checks,
  checks: [...simple.checks, { module: 'src/value.mjs', export: 'version', expected: 1 }],
};

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-study-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('fixture subprocesses resolve the candidate CLI and keep private homes after environment filtering', async t => {
  const root = directory(t), stale = path.join(root, 'stale-bin');
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, 'ae'), "#!/usr/bin/env node\nprocess.stdout.write('stale-runtime\\n');\n", { mode: 0o755 });
  fs.writeFileSync(path.join(stale, 'ae.cmd'), '@echo stale-runtime\r\n');
  const previous = process.env.PATH;
  process.env.PATH = `${stale}${path.delimiter}${previous || ''}`;
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
  const fixture = await prepareCase({ task: publicTask, root, id: 'pinned-runtime' });
  const env = buildChildEnv({ parentEnv: fixture.env || process.env }).env;
  assert.equal(env.COPILOT_HOME, undefined);
  const run = args => process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'ae', ...args], { cwd: fixture.workspace, env, encoding: 'utf8', timeout: 15000 })
    : spawnSync('ae', args, { cwd: fixture.workspace, env, encoding: 'utf8', timeout: 15000 });
  const version = run(['--version']);
  assert.ifError(version.error);
  assert.equal(version.status, 0, version.stderr);
  const expected = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
  assert.match(version.stdout, new RegExp(expected.replaceAll('.', '\\.')));
  const orient = run(['orient', '--read', '--json']);
  assert.ifError(orient.error);
  assert.equal(orient.status, 0, orient.stderr);
  const orientation = JSON.parse(orient.stdout);
  assert.equal(Object.keys(orientation).length, 20);
  assert.equal(orientation.workflow.mutationAuthority, 'none');
  assert.equal(orientation.checkReadiness.status, 'missing');
  assert.equal(orientation.checkReadiness.sourceMode, 'local');
  assert.ok(orientation.checkReadiness.source.startsWith(fixture.harnessHome + path.sep), 'check readiness must retain the fixture-private state home');
  assert.equal(fs.existsSync(path.join(fixture.workspace, '.harness/events.jsonl')), false);
  assert.equal(fs.existsSync(path.join(fixture.workspace, '.harness/runs.jsonl')), false);
  const configured = run(['config', 'set', 'agent.enabled', 'true', '--scope', 'user', '--json']);
  assert.ifError(configured.error);
  assert.equal(configured.status, 0, configured.stderr);
  assert.equal(fs.existsSync(path.join(fixture.copilotHome, 'harness/config.yaml')), true);
  const indexed = run(['index', '--structural', '--json']);
  assert.ifError(indexed.error);
  assert.equal(indexed.status, 0, indexed.stderr);
  assert.equal(fs.existsSync(path.join(fixture.harnessHome, 'index')), true);
});

function repairProvider(content, original = simple.files['src/value.mjs']) {
  let used = false;
  return () => ({
    provider: 'scripted', model: 'scripted-test', alive: true, logs: [], close() {},
    async complete() {
      if (used) return { text: 'finished', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      used = true;
      const call = { id: 'repair', name: 'edit', input: { path: 'src/value.mjs', old: original, new: content } };
      return { text: '', toolCalls: [call], blocks: [{ type: 'tool_use', ...call }], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  });
}

test('a complete repair finishes the autonomous verifier and passes independent acceptance', async t => {
  let runtime;
  const result = await runStudy({ root: directory(t), cases: [publicTask], repeats: 1, policies: ['legacy'], model: 'scripted-test', host: 'scripted-test',
    execute: async fixture => runtime = await agentResultOf(contextAgentArgs({ ...fixture, provider: 'github-copilot' }), {}, { startProviderFn: repairProvider('export const value = 2;\nexport const version = 1;\n', publicTask.files['src/value.mjs']) }),
  });
  assert.equal(result.attempts[0].stopReason, 'verifier-pass', JSON.stringify(runtime?.verifier));
  assert.equal(result.attempts[0].pass, true, JSON.stringify({ checks: result.attempts[0].checks, scope: result.attempts[0].scope, error: result.attempts[0].error }));
});

test('a public verifier pass cannot override private preservation checks', async t => {
  const result = await runStudy({ root: directory(t), cases: [publicTask], repeats: 1, policies: ['legacy'], model: 'scripted-test', host: 'scripted-test',
    execute: fixture => agentResultOf(contextAgentArgs({ ...fixture, provider: 'github-copilot' }), {}, { startProviderFn: repairProvider('export const value = 2;\nexport const version = 0;\n', publicTask.files['src/value.mjs']) }),
  });
  assert.equal(result.attempts[0].stopReason, 'verifier-pass');
  assert.equal(result.attempts[0].checks.pass, false);
  assert.equal(result.attempts[0].scope.pass, true);
  assert.equal(result.attempts[0].pass, false);
});

test('public verifier tampering and unregistered undo files remain outside scope', async t => {
  for (const tamper of ['public-checks', 'fake-undo', 'fake-events']) {
    const result = await runStudy({ root: directory(t), cases: [publicTask], repeats: 1, policies: ['legacy'], host: 'scripted-test', execute: async ({ workspace }) => {
      fs.writeFileSync(path.join(workspace, 'src/value.mjs'), 'export const value = 2;\nexport const version = 1;\n');
      if (tamper === 'public-checks') {
        const file = path.join(workspace, '.harness/context-public-checks.json');
        fs.chmodSync(file, 0o600);
        fs.writeFileSync(file, '{"checks":[]}');
      } else if (tamper === 'fake-undo') {
        fs.mkdirSync(path.join(workspace, '.harness/undo'), { recursive: true });
        fs.writeFileSync(path.join(workspace, '.harness/undo/abc123-1234abcd.bak'), 'hidden implementation');
      } else fs.writeFileSync(path.join(workspace, '.harness/events.jsonl'), '{"unregistered":true}\n');
      return { status: 'ok', turns: [] };
    } });
    const attempt = result.attempts[0];
    assert.equal(attempt.checks.pass, true);
    assert.equal(attempt.pass, false);
    const unexpected = { 'public-checks': '.harness/context-public-checks.json', 'fake-undo': '.harness/undo/abc123-1234abcd.bak', 'fake-events': '.harness/events.jsonl' };
    assert.ok(attempt.scope.unexpected.includes(unexpected[tamper]));
  }
});

test('reset preparation preserves the accepted contract and requires fresh source evidence', async t => {
  const task = JSON.parse(fs.readFileSync(new URL('../eval/context/cases.json', import.meta.url))).cases.find(task => task.id === 'reset-pricing');
  const fixture = await prepareCase({ task, root: directory(t), id: 'reset' });
  const before = readSession(fixture.workspace);
  const handoff = buildTaskHandoff({ workspace: fixture.workspace, task: task.prompt, home: fixture.harnessHome });
  assert.equal(handoff.contract?.intent, 'Add a fixed fee of 2 after tax.');
  assert.deepEqual(handoff.contract.constraints, ['Preserve the current TAX_RATE export.', 'Preserve the synchronous total(amount) interface.']);
  assert.equal(handoff.plan.locked, true);
  assert.equal(handoff.requiresRead, true);
  assert.equal(handoff.evidence.find(row => row.location === 'src/price.mjs')?.state, 'changed');
  assert.equal(validateContextSnapshot({ workspace: fixture.workspace, snapshot: before.contextSnapshot, targets: ['src/price.mjs'], home: fixture.harnessHome }).pass, false);
  const current = readOrientSlice({ workspace: fixture.workspace, copilotHome: fixture.copilotHome, flags: { home: fixture.harnessHome, contextVersion: 2 }, query: 'Resume accepted pricing', files: task.seeds });
  assert.notEqual(current.evidence[0].sha256, before.contextSnapshot.evidence[0].sha256);
  assert.equal(validateContextSnapshot({ workspace: fixture.workspace, snapshot: readSession(fixture.workspace).contextSnapshot, targets: ['src/price.mjs'], home: fixture.harnessHome }).pass, true);
});

test('managed plan context and handoff retain the selected external home and refuse another home', async t => {
  const task = JSON.parse(fs.readFileSync(new URL('../eval/context/cases.json', import.meta.url))).cases.find(task => task.id === 'reset-pricing');
  const fixture = await prepareCase({ task, root: directory(t), id: 'selected-home' });
  const session = readSession(fixture.workspace), previous = path.join(fixture.workspace, session.activePlan);
  const plan = path.join(projectStoreDir(fixture.workspace, { home: fixture.harnessHome }), 'plans', path.basename(previous));
  fs.mkdirSync(path.dirname(plan), { recursive: true });
  fs.renameSync(previous, plan);
  writeSession(fixture.workspace, { ...session, activePlan: plan });
  const record = readOrientSlice({ workspace: fixture.workspace, copilotHome: fixture.copilotHome,
    flags: { home: fixture.harnessHome, contextVersion: 2, plan }, query: task.resume.intent, files: task.seeds });
  assert.equal(record.coverage.sourceState, 'validated', record.coverage.validationReason);
  const snapshot = readSession(fixture.workspace).contextSnapshot;
  assert.equal(validateContextSnapshot({ workspace: fixture.workspace, snapshot, targets: task.seeds, home: fixture.harnessHome }).pass, true);
  const wrongHome = path.join(fixture.trial, 'unselected-home');
  fs.mkdirSync(wrongHome);
  assert.equal(validateContextSnapshot({ workspace: fixture.workspace, snapshot, targets: task.seeds, home: wrongHome }).pass, false);
  assert.equal(buildTaskHandoff({ workspace: fixture.workspace, home: fixture.harnessHome, task: task.prompt }).contract.intent, task.resume.intent);
  const wrongHandoff = buildTaskHandoff({ workspace: fixture.workspace, home: wrongHome, task: task.prompt });
  assert.equal(wrongHandoff.plan, null);
  assert.equal(wrongHandoff.requiresRead, true);
});

test('reset contract edits remain scope violations after a correct repair', async t => {
  const task = JSON.parse(fs.readFileSync(new URL('../eval/context/cases.json', import.meta.url))).cases.find(task => task.id === 'reset-pricing');
  let plan;
  const result = await runStudy({ root: directory(t), cases: [task], repeats: 1, policies: ['legacy'], host: 'scripted-test', execute: async fixture => {
    fs.writeFileSync(path.join(fixture.workspace, 'src/price.mjs'), 'export const TAX_RATE = 0.2;\nexport function total(amount) { return amount * (1 + TAX_RATE) + 2; }\n');
    plan = readSession(fixture.workspace).activePlan;
    fs.appendFileSync(path.join(fixture.workspace, plan), '\nChanged accepted constraints.\n');
    return { status: 'ok', turns: [] };
  } });
  assert.equal(result.attempts[0].checks.pass, true);
  assert.equal(result.attempts[0].pass, false);
  assert.ok(result.attempts[0].scope.unexpected.includes(plan));
});

test('reset acceptance rejects replacing the synchronous interface with a promise', async t => {
  const task = JSON.parse(fs.readFileSync(new URL('../eval/context/cases.json', import.meta.url))).cases.find(task => task.id === 'reset-pricing');
  const fixture = await prepareCase({ task, root: directory(t), id: 'async-reset' });
  fs.writeFileSync(path.join(fixture.workspace, 'src/price.mjs'), 'export const TAX_RATE = 0.2;\nexport async function total(amount) { return amount * (1 + TAX_RATE) + 2; }\n');
  assert.equal((await runChecks(fixture)).pass, false);
});

test('reset input rejects oversized contracts before creating a fixture', async t => {
  const root = directory(t);
  await assert.rejects(prepareCase({ root, id: 'oversized', task: { ...simple, resume: { intent: 'x'.repeat(1001), constraints: [] } } }), /resume/);
  assert.equal(fs.existsSync(path.join(root, 'oversized')), false);
});

test('study output cannot enter the checkout through a linked parent', (t) => {
  const root = directory(t), checkout = path.join(root, 'repo');
  fs.mkdirSync(checkout);
  const linked = path.join(root, 'linked');
  fs.symlinkSync(checkout, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolveStudyOutput({ checkout, output: path.join(linked, 'receipts') }), /outside/);
  assert.equal(resolveStudyOutput({ checkout, output: path.join(root, 'receipts') }), path.join(fs.realpathSync(root), 'receipts'));
});

test('the study CLI rejects a linked output before publishing receipts', (t) => {
  const root = directory(t), checkout = path.join(root, 'clone');
  const packageRoot = path.join(checkout, 'packages/ae');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.cpSync(path.resolve(import.meta.dirname, '../lib'), path.join(packageRoot, 'lib'), { recursive: true });
  fs.cpSync(path.resolve(import.meta.dirname, '../corpus'), path.join(packageRoot, 'corpus'), { recursive: true });
  fs.cpSync(path.resolve(import.meta.dirname, '../config'), path.join(packageRoot, 'config'), { recursive: true });
  fs.copyFileSync(path.resolve(import.meta.dirname, '../package.json'), path.join(packageRoot, 'package.json'));
  fs.cpSync(path.resolve(import.meta.dirname, '../eval/context'), path.join(packageRoot, 'eval/context'), { recursive: true });
  fs.symlinkSync(path.resolve(import.meta.dirname, '../node_modules'), path.join(packageRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = path.join(root, 'linked');
  fs.symlinkSync(checkout, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const result = spawnSync(process.execPath, [path.join(packageRoot, 'eval/context/run.mjs'), '--out', path.join(linked, 'receipts')], { encoding: 'utf8', timeout: 15000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--out must be a new directory outside/);
  assert.equal(fs.existsSync(path.join(checkout, 'receipts')), false);
});

test('independent checks reject baseline and accept repair outside the editable workspace', async (t) => {
  const root = directory(t);
  const fixture = await prepareCase({ task: simple, root, id: 'trial' });
  assert.equal((await runChecks(fixture)).pass, false);
  fs.writeFileSync(path.join(fixture.workspace, 'src/value.mjs'), 'export const value = 2;\n');
  assert.equal((await runChecks(fixture)).pass, true);
  assert.equal(path.relative(fixture.workspace, fixture.checkFile).startsWith('..'), true);
  fs.chmodSync(fixture.checkFile, 0o600);
  fs.writeFileSync(fixture.checkFile, JSON.stringify({ ...simple, checks: [] }));
  assert.equal((await runChecks(fixture)).integrity, false);
});

test('acceptance timeout remains a failure when source exits zero on termination', async t => {
  const fixture = await prepareCase({ root: directory(t), id: 'timeout-zero', task: {
    ...simple,
    files: { 'src/value.mjs': "process.on('SIGTERM', () => process.exit(0));\nsetInterval(() => {}, 100);\nexport async function value() { return await new Promise(() => {}); }\n" },
    checks: [{ module: 'src/value.mjs', export: 'value', args: [], expected: 2 }],
  } });
  const result = await runChecks(fixture);
  // Checked code runs in a probe child under the checker's own budget: the hang becomes a failed verdict before the
  // outer timeout, and its SIGTERM handler cannot turn the checker's exit into zero.
  assert.equal(result.error, null);
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(result.verdicts, [false]);
  assert.equal(result.pass, false);
});

test('source cannot pass acceptance by exiting before the assertions run', async t => {
  const fixture = await prepareCase({ root: directory(t), id: 'premature-exit', task: {
    ...simple, files: { 'src/value.mjs': 'process.exit(0);\nexport const value = 0;\n' },
  } });
  const result = await runChecks(fixture);
  // The early exit stops only the probe child; the checker reports the missing results and never prints its completion line.
  assert.equal(result.completed, false);
  assert.equal(result.error, null);
  assert.equal(result.pass, false);
});

test('all frozen cases have failing acceptance baselines in every policy arm', async (t) => {
  const cases = JSON.parse(fs.readFileSync(new URL('../eval/context/cases.json', import.meta.url))).cases;
  const result = await runStudy({ root: directory(t), cases, repeats: 1, dryRun: true });
  assert.deepEqual(result.attempts.map(row => [row.case, row.policy]).sort(), cases.flatMap(task => ['legacy', 'selective', 'subsystem'].map(policy => [task.id, policy])).sort());
  assert.ok(result.attempts.every(row => row.baseline.pass === false && row.baseline.integrity));
  assert.ok(result.attempts.every(row => row.publicBaseline?.pass === false && row.publicBaseline.error === null));
  assert.equal(result.summary.comparison, 'inconclusive');
});

test('known repairs pass public verification and private acceptance for each frozen case', async t => {
  const cases = JSON.parse(fs.readFileSync(new URL('../eval/context/cases.json', import.meta.url))).cases;
  const repairs = {
    greeting: { 'src/greet.mjs': "export function greet(name) { return 'hello ' + name; }\n" },
    double: { 'src/math.mjs': 'export const version = 1;\nexport function double(n) { return n * 2; }\n' },
    rename: { 'src/a.mjs': 'export function newName() { return 42; }\n', 'src/b.mjs': "import { newName } from './a.mjs';\nexport function useIt() { return newName(); }\n" },
    configuration: { 'config.mjs': 'export const LIMIT = 25;\n' },
    units: { 'src/units.mjs': "export function parseUnits(value) { if (String(value).trim() === '' || Number(value) < 0) throw new Error('invalid'); return Number(value); }\n" },
    'dirty-import': { 'src/new.mjs': 'export function convert(n) { return n * 3; }\n' },
    'unknown-formatter': { 'src/format.mjs': "export function format(name) { return 'hello ' + name; }\n" },
    'new-fee': { 'src/fee.mjs': 'export function fee(n) { return Math.max(1, n * 0.02); }\n' },
    'dynamic-consumer': { 'src/service.mjs': 'export function currentValue() { return 7; }\n', 'client/adapter.mjs': "const route = '../src/' + 'service.mjs';\nexport async function publicValue() { const m = await import(route); return m.currentValue(); }\n" },
    'versioned-contract': { 'src/money.mjs': 'export function roundMoney(n) { return Math.sign(n) * Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100; }\n' },
    'regional-rate': { 'src/eu/rate.mjs': 'export const rate = 0.22;\n' },
    'falsey-values': { 'src/cache.mjs': 'export function readOrNull(record, key) { return record[key] ?? null; }\n' },
    'public-validation': { 'src/ids.mjs': "export function normalize(id) { const value = String(id).trim(); if (!value) throw new Error('invalid'); return value; }\n", 'src/api.mjs': "import { normalize } from './ids.mjs';\nexport function resolve(raw) { try { return { status: 200, key: normalize(raw) }; } catch { return { status: 400 }; } }\n" },
    'reset-pricing': { 'src/price.mjs': 'export const TAX_RATE = 0.2;\nexport function total(amount) { return amount * (1 + TAX_RATE) + 2; }\n' },
  };
  const result = await runStudy({ root: directory(t), cases, repeats: 1, policies: ['legacy'], host: 'scripted-test', execute: async fixture => {
    assert.ok(repairs[fixture.task.id], fixture.task.id);
    for (const [file, content] of Object.entries(repairs[fixture.task.id])) fs.writeFileSync(path.join(fixture.workspace, file), content);
    const verified = spawnSync(process.execPath, ['.harness/context-verify.mjs'], { cwd: fixture.workspace, encoding: 'utf8', timeout: 15000 });
    assert.ifError(verified.error);
    assert.equal(verified.status, 0, `${fixture.task.id}: ${verified.stderr}`);
    return { status: 'ok', turns: [] };
  } });
  assert.deepEqual(result.attempts.map(row => [row.case, row.pass]), cases.map(task => [task.id, true]));
});

test('study counts failures and scope violations across fresh arm workspaces', async (t) => {
  const root = directory(t);
  const workspaces = new Set();
  const result = await runStudy({ root, cases: [simple], repeats: 2, policies: ['legacy', 'selective'],
    model: 'scripted-test', host: 'scripted-test', execute: async ({ workspace, policy }) => {
      assert.equal(workspaces.has(workspace), false);
      workspaces.add(workspace);
      fs.writeFileSync(path.join(workspace, 'src/value.mjs'), 'export const value = 2;\n');
      if (policy === 'selective') {
        fs.writeFileSync(path.join(workspace, 'extra.txt'), 'out of scope');
        fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
        fs.writeFileSync(path.join(workspace, '.harness/hidden.mjs'), 'export const value = 2;');
      }
      return { status: 'ok', stopReason: 'end-turn', contextAccounting: [], turns: [] };
    },
  });
  assert.equal(result.attempts.length, 4);
  assert.equal(result.summary.arms.legacy.passed, 2);
  assert.equal(result.summary.arms.selective.passed, 0);
  assert.equal(result.attempts.filter(row => !row.scope.pass).length, 2);
  assert.ok(result.attempts.filter(row => row.policy === 'selective').every(row => row.scope.unexpected.includes('.harness/hidden.mjs')));
  assert.equal(result.summary.comparison, 'inconclusive');
  assert.equal(result.summary.arms.legacy.inputTokens, null);
  assert.equal(result.summary.arms.legacy.cost, null);
  assert.ok(result.provenance.corpusHash);
  assert.ok(result.provenance.checkerHash);
  assert.ok(result.provenance.protocolHash);
});

test('dry run and unavailable model remain inconclusive and never count as accepted tasks', async (t) => {
  const dry = await runStudy({ root: directory(t), cases: [simple], policies: ['legacy'], repeats: 1, dryRun: true });
  assert.equal(dry.attempts[0].kind, 'dry-run');
  assert.equal(dry.summary.arms.legacy.passed, 0);
  assert.equal(dry.summary.comparison, 'inconclusive');
  const unavailable = await runStudy({ root: directory(t), cases: [simple], policies: ['legacy'], repeats: 1,
    model: 'unavailable-test', execute: async () => { throw new Error('no model'); },
  });
  assert.equal(unavailable.attempts[0].kind, 'runtime-error');
  assert.equal(unavailable.summary.arms.legacy.attempts, 1);
  assert.equal(unavailable.summary.arms.legacy.failed, 1);
});

test('usage aggregates all attempts while incomplete coverage and evidence stay explicit', () => {
  const usage = value => ({ boundary: 'headless-request', modelUsage: value });
  const result = summarizeStudy([
    { policy: 'legacy', kind: 'live', pass: false, split: 'held-out', evidenceBeforeEdit: null, accounting: [usage({ measurement: 'observed', inputTokens: 20, outputTokens: 5, cachedInputTokens: 2 })] },
    { policy: 'legacy', kind: 'runtime-error', pass: false, split: 'held-out', evidenceBeforeEdit: null, accounting: [usage({ measurement: 'unavailable', inputTokens: null, outputTokens: null })] },
  ], { repeats: 2, policies: ['legacy'], host: 'test', model: 'test' });
  assert.equal(result.arms.legacy.knownInputTokens, 20);
  assert.equal(result.arms.legacy.inputTokens, null);
  assert.equal(result.arms.legacy.usageCoverage, 'partial');
  assert.equal(result.arms.legacy.failed, 2);
  assert.equal(result.arms.legacy.evidenceCoverage, 'unavailable');
});

test('development improvements cannot conceal a held-out quality regression', () => {
  const attempts = [];
  for (const policy of ['legacy', 'selective', 'subsystem']) {
    for (let i = 0; i < 40; i++) attempts.push({ policy, kind: 'live', actualModel: 'exact', split: i < 30 ? 'held-out' : 'development',
      pass: policy === 'selective' ? i >= 3 : i >= 2 && i !== 30 && i !== 31,
      accounting: [{ boundary: 'headless-request', modelUsage: { measurement: 'observed', inputTokens: policy === 'selective' ? 50 : 100, outputTokens: 10 } }],
    });
  }
  const result = summarizeStudy(attempts, { policies: ['legacy', 'selective', 'subsystem'], model: 'exact' });
  assert.ok(result.arms.selective.failed < result.arms.legacy.failed);
  assert.ok(result.arms.selective.heldOutFailed > result.arms.legacy.heldOutFailed);
  assert.equal(result.comparison, 'no-candidate');
});

test('the live CLI requires explicit permission for native Auto diagnostics', t => {
  const root = directory(t);
  const bin = path.resolve(import.meta.dirname, '../eval/context/run.mjs');
  const cases = [
    { args: ['--provider', 'github-copilot', '--model', 'auto'], message: /explicit.*--allow-auto/ },
    { args: ['--provider', 'openai', '--model', 'auto', '--allow-auto'], message: /GitHub Copilot/ },
    { args: ['--provider', 'github-copilot', '--model', 'auto', '--allow-auto', '--split', 'invalid'], message: /split must/ },
  ];
  for (const [index, sample] of cases.entries()) {
    const out = path.join(root, String(index));
    const result = spawnSync(process.execPath, [bin, '--out', out, '--live', ...sample.args], { encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, sample.message);
    assert.equal(fs.existsSync(out), false);
  }
});

test('an Auto alias stays observed without claiming a resolved model identity', async t => {
  const result = await runStudy({ root: directory(t), cases: [simple], repeats: 1, policies: ['legacy'], model: 'auto', host: 'scripted-test',
    execute: async fixture => {
      fs.writeFileSync(path.join(fixture.workspace, 'src/value.mjs'), 'export const value = 2;\n');
      return { status: 'ok', contextAccounting: [{ boundary: 'headless-request', model: 'auto' }] };
    },
  });
  assert.equal(result.provenance.modelSelection, 'automatic');
  assert.deepEqual(result.attempts[0].observedModels, ['auto']);
  assert.equal(result.attempts[0].actualModel, null);
  assert.equal(result.summary.comparison, 'inconclusive');
});

test('automatic routing cannot qualify promotion even with complete qualifying usage', () => {
  const attempts = ['legacy', 'selective', 'subsystem'].flatMap(policy => Array.from({ length: 30 }, () => ({
    policy, kind: 'live', pass: true, split: 'held-out', actualModel: 'auto',
    accounting: [{ boundary: 'headless-request', modelUsage: { measurement: 'observed', inputTokens: policy === 'legacy' ? 100 : 50, outputTokens: 10 } }],
  })));
  const result = summarizeStudy(attempts, { policies: ['legacy', 'selective', 'subsystem'], model: 'auto', modelSelection: 'automatic' });
  assert.equal(result.comparison, 'inconclusive');
  assert.deepEqual(result.candidates, []);
});
