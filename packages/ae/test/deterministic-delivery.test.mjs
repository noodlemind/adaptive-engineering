import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { approveProject } from '../lib/trust.mjs';
import { loadPlan } from '../lib/plan-parse.mjs';
import { validatePlanSchema } from '../lib/plan-schema.mjs';
import { planDigest, readEvidence } from '../lib/evidence.mjs';
import { applyPlanUpdate } from '../lib/plan-update.mjs';
import { redactedJson } from '../lib/redact.mjs';
import { writeChecks, writeVersionedPlan, initGit, scriptedFlowLedger } from './helpers/cli-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function installPackage(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-package-proof-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const npm = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(npm, 'npm CLI must be available for clean-package proof');
  const logsDir = path.join(dir, 'npm-logs');
  fs.mkdirSync(logsDir);
  const cache = path.join(dir, 'npm-cache');
  const npmStep = (label, args, cwd) => {
    const started = Date.now();
    const result = spawnSync(process.execPath, [npm, ...args, '--cache', cache, '--no-audit', '--no-fund', '--timing', '--logs-dir', logsDir], { cwd, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const diagnostic = { kind: 'package-proof', label, platform: process.platform, node: process.version, durationMs: Date.now() - started,
      status: result.status, signal: result.signal, error: result.error ? { code: result.error.code, message: result.error.message } : null,
      npm, cache: { selected: cache, isolated: true }, logsDir,
      stdout: String(result.stdout || '').slice(0, 65536), stderr: String(result.stderr || '').slice(0, 65536),
      logs: fs.readdirSync(logsDir).filter(name => /(?:timing\.json|debug-\d+\.log)$/.test(name)).slice(-4)
        .map(name => ({ name, text: fs.readFileSync(path.join(logsDir, name), 'utf8').slice(-65536) })) };
    if (process.env.HARNESS_PROOF_LOG) fs.appendFileSync(process.env.HARNESS_PROOF_LOG, redactedJson(diagnostic) + '\n');
    assert.equal(result.status, 0, redactedJson({ ...diagnostic, logs: diagnostic.logs.map(log => ({ name: log.name, text: log.text.slice(-4096) })) }));
    return result;
  };
  const packed = process.env.AE_TEST_ARCHIVE ? null : npmStep('pack', ['pack', '--json', '--pack-destination', dir], root);
  const archive = process.env.AE_TEST_ARCHIVE ? path.resolve(process.env.AE_TEST_ARCHIVE) : path.join(dir, JSON.parse(packed.stdout)[0].filename);
  npmStep('offline-install', ['install', '--prefix', dir, '--offline', '--ignore-scripts', '--omit=optional', archive], dir);
  return path.join(dir, 'node_modules/ae-harness');
}

test('installed product proof entry rejects placeholders and proves broken/fixed stages through actual checks', t => {
  const f = deliveryFixture(t, installPackage(t));
  assert.equal(f.cli('install', '--json').status, 0);
  const script = path.join(f.copilot, 'skills/harness-doctor/scripts/product-proof.mjs');
  assert.ok(fs.existsSync(script), 'proof script must be discovered in the clean installed skill');
  const plan = JSON.parse(f.cli('plan-new', '--goal', 'Return two', '--acceptance', 'value is two', '--constraint', 'Preserve API', '--verification-check', 'behavior', '--json').stdout).path;
  assert.equal(f.cli('gate', '--plan', plan, '--json').status, 0);
  f.hook('record-successful-edit.mjs', { tool_name: 'replace_string_in_file', tool_input: { filePath: 'src/example.js' }, tool_response: 'File edited successfully' });
  const map = '.harness/product-flow.json';
  fs.writeFileSync(path.join(f.ws, map), JSON.stringify({ schema: 1, product: 'TODO', environment: 'Disposable fixture', flow: { id: 'return-two', acceptance: 'The exported value is two.', checks: ['behavior'] } }));
  const proof = (stage, cwd = f.ws, home = f.home) => f.receipt('product-proof', [stage], spawnSync(process.execPath, [script, '--workspace', f.ws, '--copilot-home', f.copilot, '--harness-home', home, '--plan', plan, '--map', map, '--stage', stage], { cwd, encoding: 'utf8', timeout: 120000, env: { ...f.env, AE_BIN: path.join(f.home, 'wrong-bin.mjs'), HARNESS_HOME: path.join(f.home, 'wrong-store') } }));
  assert.notEqual(proof('broken').status, 0, 'a placeholder map never proves a product');
  fs.writeFileSync(path.join(f.ws, map), JSON.stringify({ schema: 1, product: 'Synthetic export fixture', environment: 'Disposable fixture', flow: { id: 'return-two', acceptance: 'The exported value is two.', checks: ['behavior'] } }));
  const broken = proof('broken');
  assert.equal(broken.status, 0, broken.stderr + broken.stdout);
  assert.equal(JSON.parse(broken.stdout).verifyOutcome, 'failed');
  assert.equal(JSON.parse(broken.stdout).stopDecision, 'block');
  assert.notEqual(proof('fixed').status, 0);
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  const packet = JSON.parse(f.cli('review', 'prepare', '--plan', plan, '--base', 'HEAD', '--json').stdout), input = path.join(f.ws, '.harness/proof-review.json');
  fs.writeFileSync(input, JSON.stringify({ packet: packet.id, results: packet.required.map(reviewer => ({ ...scriptedFlowLedger(packet, reviewer), reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [] })) }));
  assert.equal(f.cli('review', 'assemble', '--plan', plan, '--packet', packet.id, '--file', input, '--json').status, 0);
  assert.equal(f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json').status, 0);
  const learning = path.join(f.ws, '.harness/proof-learning.json');
  fs.writeFileSync(learning, JSON.stringify({ operation: 'proof-no-learning', decision: 'no-learning', rationale: 'No durable lesson in this synthetic fixture.' }));
  assert.equal(f.cli('compound', '--plan', plan, '--learning-decision', learning, '--json').status, 0);
  assert.equal(f.cli('plan-update', '--plan', plan, '--status', 'done', '--json').status, 0);
  const fixed = proof('fixed');
  assert.equal(fixed.status, 0, fixed.stderr + fixed.stdout);
  const result = JSON.parse(fixed.stdout);
  assert.equal(result.verifyOutcome, 'passed');
  assert.equal(result.stopDecision, 'allow');
  assert.equal(result.work.completion.pass, true);
  assert.ok(Buffer.byteLength(fixed.stdout) <= 16384);
  assert.match(result.mapSource.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.liveHost, 'unverified');
  const relative = proof('fixed', path.dirname(f.home), path.basename(f.home));
  assert.equal(relative.status, 0, relative.stderr + relative.stdout);
  const sessionPath = path.join(f.ws, '.harness/session.json'), session = JSON.parse(fs.readFileSync(sessionPath));
  const invalidSessions = [
    { ...session, activePlan: 'docs/plans/another-plan.md', lastEditAt: null },
    { ...session, lastEditAt: null },
    { ...session, lastEditPlan: 'docs/plans/another-plan.md' },
    { ...session, lastEvidencePath: '.harness/evidence/another-proof.json', lastEditAt: null },
  ];
  const invalidResults = invalidSessions.map(invalid => {
    fs.writeFileSync(sessionPath, JSON.stringify(invalid));
    return proof('fixed').status;
  });
  fs.writeFileSync(sessionPath, JSON.stringify(session));
  assert.ok(invalidResults.every(status => status !== 0), `another plan, absent mutation, mismatched edit or proof must fail: ${invalidResults}`);
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 3;\n');
  const stale = proof('fixed');
  assert.notEqual(stale.status, 0);
  assert.equal(JSON.parse(stale.stdout).work.proof.pass, false);
  assert.equal(JSON.parse(stale.stdout).stopDecision, 'block');
});

test('installed package proves behavior, hook layout, stale replay and completion recovery outside checkout', (t) => {
  const installedRoot = installPackage(t);
  const f = deliveryFixture(t, installedRoot);
  assert.equal(f.cli('install', '--json').status, 0);
  const hooks = path.join(f.copilot, 'hooks');
  assert.ok(fs.existsSync(path.join(hooks, 'lib/proof-authority.mjs')));
  assert.equal(fs.existsSync(path.join(hooks, 'lib/evidence-binding.mjs')), false);
  const installedEnv = { ...f.env };
  delete installedEnv.HARNESS_BIN;
  const gitPath = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' });
  assert.equal(gitPath.status, 0, gitPath.stderr);
  installedEnv.PATH = path.dirname(gitPath.stdout.trim().split(/\r?\n/)[0]);
  assert.ok(spawnSync('harness', ['--version'], { env: installedEnv }).error, 'installed hook proof must not depend on harness in PATH');
  const installedHook = (name, payload = {}) => f.receipt('installed-hook', [name], spawnSync(process.execPath, [path.join(hooks, name)], { cwd: f.ws, env: installedEnv, input: JSON.stringify({ cwd: f.ws, session_id: 'delivery-proof', hook_event_name: 'Stop', ...payload }), encoding: 'utf8', timeout: 15000 }));
  const unrelated = path.join(path.dirname(f.ws), 'unrelated');
  fs.mkdirSync(unrelated);
  initGit(unrelated);
  fs.writeFileSync(path.join(path.dirname(f.ws), 'inactive.code-workspace'), JSON.stringify({ folders: [{ path: f.ws }, { path: unrelated }] }));
  const orientation = JSON.parse(f.cli('orient', '--query', 'Return two', '--file', 'src/example.js', '--json').stdout);
  assert.equal(orientation.layout.boundRoot, fs.realpathSync.native(f.ws));
  assert.deepEqual(orientation.layout.roots, [], 'an inactive workspace must not widen task scope');
  assert.equal(orientation.layout.workspaceFile, null);
  assert.equal(orientation.layout.domainSuggestion, null);
  const plan = JSON.parse(f.cli('plan-new', '--goal', 'Return two', '--acceptance', 'value is two', '--constraint', 'Preserve API', '--verification-check', 'behavior', '--json').stdout).path;
  assert.equal(f.cli('gate', '--plan', plan, '--json').status, 0);
  f.hook('record-successful-edit.mjs', { tool_name: 'replace_string_in_file', tool_input: { filePath: 'src/example.js' }, tool_response: 'File edited successfully' });
  const skillPath = path.join(f.copilot, 'skills/create-primitive/SKILL.md'), skillText = fs.readFileSync(skillPath, 'utf8');
  const decoy = path.join(f.ws, 'tmp/skills/create-primitive/SKILL.md');
  fs.mkdirSync(path.dirname(decoy), { recursive: true });
  fs.writeFileSync(decoy, skillText);
  const readSkill = filePath => installedHook('record-successful-edit.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { filePath },
    tool_result: { result_type: 'success', text_result_for_llm: skillText } });
  assert.equal(readSkill(decoy).status, 0);
  const sessionPath = path.join(f.ws, '.harness/session.json');
  assert.equal(JSON.parse(fs.readFileSync(sessionPath)).activatedSkills?.['create-primitive'], undefined, 'same-suffix decoy is not the installed skill');
  assert.equal(readSkill(skillPath).status, 0);
  const activation = JSON.parse(fs.readFileSync(sessionPath)).activatedSkills['create-primitive'];
  assert.equal(activation.complete, true, 'whole returned CLI source establishes mechanical complete-read evidence');
  assert.equal(activation.source.path, fs.realpathSync.native(skillPath));
  assert.equal(activation.source.sha256, createHash('sha256').update(skillText).digest('hex'));
  fs.rmSync(path.join(f.ws, 'tmp'), { recursive: true });
  assert.equal(JSON.parse(f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json').stdout).outcome, 'failed');
  assert.equal(JSON.parse(installedHook('require-verification.mjs').stdout).hookSpecificOutput.decision, 'block');
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  const packet = JSON.parse(f.cli('review', 'prepare', '--plan', plan, '--base', 'HEAD', '--json').stdout);
  const input = path.join(f.ws, '.harness/review-input.json');
  fs.writeFileSync(input, JSON.stringify({ packet: packet.id, results: packet.required.map(reviewer => ({ ...scriptedFlowLedger(packet, reviewer), reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [] })) }));
  assert.equal(f.cli('review', 'assemble', '--plan', plan, '--packet', packet.id, '--file', input, '--json').status, 0);
  assert.equal(f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json').status, 0);
  const learning = path.join(f.ws, '.harness/no-learning.json');
  fs.writeFileSync(learning, JSON.stringify({ operation: 'installed-proof-learning', decision: 'no-learning', rationale: 'Disposable fixture has no durable learning.' }));
  assert.equal(f.cli('compound', '--plan', plan, '--learning-decision', learning, '--json').status, 0);
  const beforeCompletion = fs.readFileSync(plan, 'utf8');
  const done = f.cli('plan-update', '--plan', plan, '--status', 'done', '--json');
  assert.equal(done.status, 0, done.stdout + done.stderr);
  fs.writeFileSync(plan, beforeCompletion);
  assert.equal(JSON.parse(installedHook('require-verification.mjs').stdout).hookSpecificOutput.decision, 'block', 'interrupted plan commit must remain pending');
  assert.equal(f.cli('plan-update', '--plan', plan, '--status', 'done', '--json').status, 0);
  assert.equal(JSON.parse(installedHook('require-verification.mjs').stdout).continue, true);
  fs.appendFileSync(path.join(f.ws, '.github/harness/policy.yaml'), '# policy changed\n');
  assert.equal(JSON.parse(installedHook('require-verification.mjs').stdout).hookSpecificOutput.decision, 'block');
});

test('completion requires a current finished learning decision and binds it into the receipt', t => {
  const f = deliveryFixture(t);
  const plan = writeVersionedPlan(f.ws, { required: ['behavior'], criteria: { AC1: ['behavior'] } });
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  assert.equal(f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json').status, 0);
  const before = fs.readFileSync(path.join(f.ws, plan), 'utf8');
  assert.notEqual(f.cli('plan-update', '--plan', plan, '--status', 'done', '--json').status, 0);
  assert.equal(fs.readFileSync(path.join(f.ws, plan), 'utf8'), before);
  const file = path.join(f.ws, '.harness/learning-input.json');
  fs.writeFileSync(file, JSON.stringify({ operation: 'finish-learning', decision: 'no-learning', rationale: 'No reusable lesson from this fixture.' }));
  const compounded = f.cli('compound', '--plan', plan, '--learning-decision', file, '--json');
  assert.equal(compounded.status, 0, compounded.stderr);
  const recordPath = path.join(f.ws, JSON.parse(compounded.stdout).learningRecord);
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  fs.writeFileSync(recordPath, JSON.stringify({ ...record, state: 'pending' }));
  assert.notEqual(f.cli('plan-update', '--plan', plan, '--status', 'done', '--json').status, 0);
  fs.writeFileSync(recordPath, JSON.stringify(record));
  assert.equal(f.cli('plan-update', '--plan', plan, '--status', 'done', '--json').status, 0);
  const completionFiles = fs.readdirSync(path.join(f.ws, '.harness/completions'));
  const completion = JSON.parse(fs.readFileSync(path.join(f.ws, '.harness/completions', completionFiles[0]), 'utf8'));
  assert.equal(completion.value.learning.operation, record.operation);
  fs.writeFileSync(recordPath, JSON.stringify({ ...record, state: 'blocked' }));
  assert.equal(JSON.parse(f.cli('status', '--validate-completion', '--plan', plan, '--json').stdout).pass, false);
});

test('oversized serialized review records reject without changing current coverage', t => {
  const f = deliveryFixture(t);
  const plan = JSON.parse(f.cli('plan-new', '--goal', 'Review bytes', '--acceptance', 'Behavior works', '--constraint', 'Keep API', '--verification-check', 'behavior', '--json').stdout).path;
  const packet = JSON.parse(f.cli('review', 'prepare', '--plan', plan, '--base', 'HEAD', '--json').stdout);
  const results = packet.required.map(reviewer => ({ ...scriptedFlowLedger(packet, reviewer), reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [] }));
  const input = path.join(f.ws, '.harness/results.json');
  fs.writeFileSync(input, JSON.stringify({ packet: packet.id, results }));
  assert.equal(f.cli('review', 'assemble', '--plan', plan, '--packet', packet.id, '--file', input, '--json').status, 0);
  const latestDir = path.join(f.ws, '.harness/reviews/latest');
  const pointer = path.join(latestDir, fs.readdirSync(latestDir)[0]);
  const before = fs.readFileSync(pointer, 'utf8');
  results[0].findings = [{ file: 'src/example.js', line: 1, severity: 'P2', confidence: 0.8, title: 'Large finding', description: 'x'.repeat(600 * 1024), suggested_fix: 'Inspect behavior.', autofix_class: 'manual', evidence: ['src/example.js:1'] }];
  fs.writeFileSync(input, JSON.stringify({ packet: packet.id, results }));
  const rejected = f.cli('review', 'assemble', '--plan', plan, '--packet', packet.id, '--file', input, '--json');
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr + rejected.stdout, /size|limit|large/);
  assert.equal(fs.readFileSync(pointer, 'utf8'), before);
});

for (const scope of ['private', 'global', 'ship-set-proposal']) test(`verified publication owns ${scope} destination and replays one logical result`, t => {
  const f = deliveryFixture(t), plan = writeVersionedPlan(f.ws, { required: ['behavior'], criteria: { AC1: ['behavior'] } });
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  assert.equal(f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json').status, 0);
  const file = path.join(f.ws, '.harness/learning-destination.json');
  const decision = { operation: `destination-${scope}`, decision: 'publish', scope, rationale: 'The boundary needs a durable evidence-backed explanation.', title: 'Accepted publication boundary', body: 'A publication operation must retain its content and evidence identity across recovery.', category: 'design', tags: ['publication'] };
  fs.writeFileSync(file, JSON.stringify(decision));
  const first = f.cli('compound', '--plan', plan, '--learning-decision', file, '--json');
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const value = JSON.parse(first.stdout);
  assert.equal(value.scope, scope);
  assert.ok(fs.existsSync(value.publishedPath));
  const bytes = fs.readFileSync(value.publishedPath, 'utf8');
  assert.match(bytes, /proof_identity: [a-f0-9]{64}/);
  assert.match(bytes, /work_contract: [a-f0-9]{64}/);
  if (scope === 'global') assert.ok(value.publishedPath.startsWith(path.join(f.copilot, 'knowledge')));
  if (scope === 'ship-set-proposal') {
    assert.ok(value.publishedPath.startsWith(path.join(f.ws, '.harness/proposals')));
    assert.equal(value.activated, false);
    assert.equal(value.indexed, null);
  }
  const receiptFile = path.join(f.ws, value.learningRecord), receipt = JSON.parse(fs.readFileSync(receiptFile));
  fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, state: 'pending' }));
  const recovered = f.cli('compound', '--plan', plan, '--learning-decision', file, '--json');
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).publishedPath, value.publishedPath);
  assert.equal(fs.readFileSync(value.publishedPath, 'utf8'), bytes);
  assert.equal(f.cli('plan-update', '--plan', plan, '--status', 'done', '--json').status, 0);
  fs.writeFileSync(file, JSON.stringify({ ...decision, body: 'Different claim.' }));
  assert.notEqual(f.cli('compound', '--plan', plan, '--learning-decision', file, '--dry-run', '--json').status, 0);
});

test('publication replay and completion detect missing accepted episode bytes', t => {
  const f = deliveryFixture(t), plan = writeVersionedPlan(f.ws, { required: ['behavior'], criteria: { AC1: ['behavior'] } });
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  assert.equal(f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json').status, 0);
  const file = path.join(f.ws, '.harness/learning-delete.json');
  fs.writeFileSync(file, JSON.stringify({ operation: 'deleted-episode', decision: 'publish', scope: 'private', rationale: 'Durable boundary.', title: 'Boundary', body: 'The published evidence must remain available.' }));
  const first = f.cli('compound', '--plan', plan, '--learning-decision', file, '--json');
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const value = JSON.parse(first.stdout);
  assert.ok(value.publishedPath);
  fs.rmSync(value.publishedPath);
  assert.notEqual(f.cli('plan-update', '--plan', plan, '--status', 'done', '--json').status, 0);
  const recovered = f.cli('compound', '--plan', plan, '--learning-decision', file, '--json');
  assert.equal(recovered.status, 0, recovered.stderr + recovered.stdout);
  assert.ok(fs.existsSync(value.publishedPath));
});

test('publication can recover after previously reported partial index recovery is reconciled', t => {
  const f = deliveryFixture(t), plan = writeVersionedPlan(f.ws, { required: ['behavior'], criteria: { AC1: ['behavior'] } });
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  assert.equal(f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json').status, 0);
  const file = path.join(f.ws, '.harness/learning-reconcile.json');
  fs.writeFileSync(file, JSON.stringify({ operation: 'reconciled-episode', decision: 'publish', scope: 'private', rationale: 'Durable boundary.', title: 'Recovery', body: 'Recovery must validate current retrieval state.' }));
  const value = JSON.parse(f.cli('compound', '--plan', plan, '--learning-decision', file, '--json').stdout);
  const receiptFile = path.join(f.ws, value.learningRecord), receipt = JSON.parse(fs.readFileSync(receiptFile));
  fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, state: 'blocked', result: { ...receipt.result, pass: false, blockedReason: 'Earlier partial rollback.', partialRecovery: { episodeRemains: true, unrestored: ['manifest.yaml'] } } }));
  assert.equal(f.cli('index', '--json').status, 0);
  const retry = f.cli('compound', '--plan', plan, '--learning-decision', file, '--json');
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal(JSON.parse(retry.stdout).publishedPath, value.publishedPath);
});

export function deliveryFixture(t, runtimeRoot = root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-delivery-'));
  const ws = path.join(dir, 'product');
  const home = path.join(dir, 'home');
  const copilot = path.join(dir, 'copilot');
  fs.mkdirSync(ws);
  fs.mkdirSync(copilot);
  fs.writeFileSync(path.join(ws, '.gitignore'), '.harness/\n');
  fs.writeFileSync(path.join(ws, 'package.json'), '{"type":"module"}\n');
  writeChecks(ws, { behavior: { command: [process.execPath, '-e', "import('./src/example.js').then(m => { if (m.value !== 2) process.exit(1); })"] } });
  fs.writeFileSync(path.join(ws, '.github/harness/policy.yaml'), 'version: 1\nenforcement: enforce\n');
  initGit(ws);
  approveProject({ workspace: ws, copilotHome: copilot, home });
  const env = { ...process.env, HARNESS_HOME: home, COPILOT_HOME: copilot, HARNESS_NO_EVENTS: '1', HARNESS_BIN: path.join(runtimeRoot, 'bin/ae.mjs') };
  delete env.HARNESS_ENFORCEMENT;
  const receipt = (kind, args, result) => {
    if (process.env.HARNESS_PROOF_LOG) fs.appendFileSync(process.env.HARNESS_PROOF_LOG, JSON.stringify({ fixture: dir, runtimeRoot, platform: process.platform, node: process.version, kind, args, status: result.status, stdout: String(result.stdout || '').slice(0, 262144), stderr: String(result.stderr || '').slice(0, 262144) }) + '\n');
    return result;
  };
  const cli = (...args) => receipt('cli', args, spawnSync(process.execPath, [path.join(runtimeRoot, 'bin/ae.mjs'), ...args, '--workspace', ws, '--harness-home', home, '--copilot-home', copilot], { cwd: ws, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 }));
  const hook = (name, input = {}) => receipt('hook', [name, input], spawnSync(process.execPath, [path.join(runtimeRoot, 'corpus/hooks', name)], { cwd: ws, env, input: JSON.stringify({ cwd: ws, workspace: ws, session_id: 'delivery-proof', ...input }), encoding: 'utf8', timeout: 30000 }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { ws, home, copilot, cli, hook, env, receipt };
}

test('short plans without proof are unlocked drafts and cannot verify', (t) => {
  const f = deliveryFixture(t);
  const created = f.cli('plan-new', '--goal', 'Return two', '--acceptance', 'value is two', '--constraint', 'Keep the exported API', '--json');
  assert.equal(created.status, 0, created.stderr);
  const plan = JSON.parse(created.stdout).path;
  assert.match(fs.readFileSync(plan, 'utf8'), /plan_lock: false/);
  const verified = f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json');
  assert.notEqual(JSON.parse(verified.stdout).outcome, 'passed');
});

test('CLI and every hook use trusted quoted YAML and refresh stale trust', (t) => {
  const f = deliveryFixture(t);
  fs.writeFileSync(path.join(f.ws, '.github/harness/policy.yaml'), 'version: 1\nenforcement: "warn"\ngate_ttl_minutes: 12\nevidence_ttl_hours: 3\n');
  approveProject({ workspace: f.ws, copilotHome: f.copilot, home: f.home });
  const resolved = f.cli('status', '--effective-policy', '--json');
  assert.equal(resolved.status, 0, resolved.stderr);
  const policy = JSON.parse(resolved.stdout).policy;
  assert.equal(policy?.enforcement, 'warn', resolved.stdout);
  assert.equal(policy.rules.critical, 'enforce');
  const warned = JSON.parse(f.hook('require-plan-gate.mjs', { tool_name: 'replace_string_in_file', tool_input: { filePath: 'src/example.js' } }).stdout);
  assert.equal(warned.continue, true, JSON.stringify(warned));
  const protectedPath = JSON.parse(f.hook('guard-critical-files.mjs', { tool_name: 'replace_string_in_file', tool_input: { filePath: '.env' } }).stdout);
  assert.equal(protectedPath.hookSpecificOutput?.permissionDecision, 'deny');
  fs.appendFileSync(path.join(f.ws, '.github/harness/policy.yaml'), '\n# changed policy\n');
  const blocked = JSON.parse(f.hook('require-plan-gate.mjs', { tool_name: 'replace_string_in_file', tool_input: { filePath: 'src/example.js' } }).stdout);
  assert.equal(blocked.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(blocked));
});

test('valid environment policy overrides all rules; unavailable refresh fails closed', (t) => {
  const f = deliveryFixture(t);
  f.env.HARNESS_ENFORCEMENT = 'warn';
  assert.equal(JSON.parse(f.cli('status', '--effective-policy', '--json').stdout).policy?.enforcement, 'warn');
  const warned = JSON.parse(f.hook('guard-critical-files.mjs', { tool_name: 'replace_string_in_file', tool_input: { filePath: '.env' } }).stdout);
  assert.equal(warned.continue, true, JSON.stringify(warned));
  fs.rmSync(path.join(f.home, 'policies'), { recursive: true, force: true });
  f.env.HARNESS_BIN = path.join(f.home, 'unavailable.mjs');
  const blocked = JSON.parse(f.hook('guard-critical-files.mjs', { tool_name: 'replace_string_in_file', tool_input: { filePath: '.env' } }).stdout);
  assert.equal(blocked.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(blocked));
});

test('nonregular pinned policy sources cannot hang the CLI authority', { skip: process.platform === 'win32' }, (t) => {
  const f = deliveryFixture(t);
  const policy = path.join(f.ws, '.github/harness/policy.yaml');
  fs.unlinkSync(policy);
  assert.equal(spawnSync('mkfifo', [policy]).status, 0);
  const resolved = spawnSync(process.execPath, [path.join(root, 'bin/ae.mjs'), 'status', '--effective-policy', '--workspace', f.ws, '--json'], { env: f.env, encoding: 'utf8', timeout: 1500 });
  assert.notEqual(resolved.status, null, 'policy discovery must reject a FIFO before opening it');
});

test('short plan runs its bound behavior check and rejects broken product', (t) => {
  const f = deliveryFixture(t);
  const created = f.cli('plan-new', '--goal', 'Return two', '--acceptance', 'value is two', '--constraint', 'Keep the exported API', '--verification-check', 'behavior', '--json');
  assert.equal(created.status, 0, created.stderr);
  const plan = JSON.parse(created.stdout).path;
  const broken = JSON.parse(f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json').stdout);
  assert.equal(broken.outcome, 'failed', JSON.stringify(broken));
  assert.equal(broken.checks.find(c => c.id === 'behavior')?.status, 'failed');
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  const packet = JSON.parse(f.cli('review', 'prepare', '--plan', plan, '--base', 'HEAD', '--json').stdout);
  const input = path.join(f.ws, '.harness/review-input.json');
  fs.writeFileSync(input, JSON.stringify({ packet: packet.id, results: packet.required.map(reviewer => ({ ...scriptedFlowLedger(packet, reviewer), reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [] })) }));
  assert.equal(f.cli('review', 'assemble', '--plan', plan, '--packet', packet.id, '--file', input, '--json').status, 0);
  const repaired = f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json');
  assert.equal(JSON.parse(repaired.stdout).outcome, 'passed', repaired.stdout + repaired.stderr);
});

test('JSON examples in full plans cannot bypass malformed frontmatter', (t) => {
  const f = deliveryFixture(t);
  const rel = writeVersionedPlan(f.ws);
  const full = path.join(f.ws, rel);
  const text = fs.readFileSync(full, 'utf8').replace('plan_schema: 1', 'plan_schema: [broken');
  fs.writeFileSync(full, `${text}\n${JSON.stringify({ goal: 'example', acceptance: ['example'], constraints: ['example'] })}\n`);
  assert.equal(validatePlanSchema(loadPlan(f.ws, rel)).pass, false);
  assert.equal(JSON.parse(f.cli('verify', '--plan', rel, '--base', 'HEAD', '--json').stdout).outcome, 'failed');
});

test('typed contract values cannot collide and cycles fail as a domain outcome', (t) => {
  const f = deliveryFixture(t);
  const rel = writeVersionedPlan(f.ws);
  const full = path.join(f.ws, rel);
  const source = fs.readFileSync(full, 'utf8');
  assert.notEqual(planDigest(source.replace('phase: 1', 'phase: 1\nunknown: 99999999999999999999')), planDigest(source.replace('phase: 1', 'phase: 1\nunknown: {integer: "99999999999999999999"}')));
  fs.writeFileSync(full, source.replace('phase: 1', 'phase: 1\nunknown: &cycle {self: *cycle}'));
  const result = f.cli('verify', '--plan', rel, '--base', 'HEAD', '--json');
  assert.equal(JSON.parse(result.stdout).outcome, 'failed', result.stdout + result.stderr);
});

test('passed labels cannot substitute for recorded named proof', (t) => {
  const f = deliveryFixture(t);
  const rel = writeVersionedPlan(f.ws, { required: ['behavior'], criteria: { AC1: ['behavior'] } });
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  assert.equal(f.cli('verify', '--plan', rel, '--base', 'HEAD', '--json').status, 0);
  const evidence = readEvidence(f.ws, rel);
  assert.equal(JSON.parse(f.cli('status', '--validate-evidence', '--plan', rel, '--json').stdout).pass, true);
  fs.writeFileSync(path.join(f.ws, evidence.evidencePath), JSON.stringify({ ...evidence, checks: [] }));
  assert.equal(JSON.parse(f.cli('status', '--validate-evidence', '--plan', rel, '--json').stdout).pass, false);
});

test('contract digest ignores only declared bookkeeping and retains unknown semantic content', (t) => {
  const f = deliveryFixture(t);
  const rel = writeVersionedPlan(f.ws);
  const text = fs.readFileSync(path.join(f.ws, rel), 'utf8');
  const updated = applyPlanUpdate(text, { status: 'review', activity: ['Review recorded'], completed: ['code-review'] });
  assert.equal(planDigest(updated), planDigest(text));
  assert.notEqual(planDigest(text.replace('Verify safely', 'Different goal')), planDigest(text));
  assert.notEqual(planDigest(text.replace('phase: 1', 'phase: 1\nunknown_semantic_rule: protect-me')), planDigest(text));
});

test('completion rejects declared review strings and critical findings without changing plan', (t) => {
  const f = deliveryFixture(t);
  const rel = writeVersionedPlan(f.ws, { required: ['behavior'], criteria: { AC1: ['behavior'] } });
  const full = path.join(f.ws, rel);
  const initial = fs.readFileSync(full, 'utf8').replace('required: []\n  completed: []\n  critical_open: []', 'required: [code-review]\n  completed: [code-review]\n  critical_open: [critical-1]');
  fs.writeFileSync(full, initial);
  const completed = f.cli('plan-update', '--plan', rel, '--status', 'done', '--json');
  assert.notEqual(completed.status, 0, completed.stdout);
  assert.equal(fs.readFileSync(full, 'utf8'), initial);
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  fs.writeFileSync(full, initial.replace('critical_open: [critical-1]', 'critical_open: []'));
  const verified = JSON.parse(f.cli('verify', '--plan', rel, '--base', 'HEAD', '--json').stdout);
  assert.notEqual(verified.outcome, 'passed', 'a declared string is not collected review evidence');
});

for (const format of ['short', 'full']) for (const learning of ['no-learning', 'publish']) {
  test(`exit sequence: ${format} plan, ${learning}, review → verify → compound → done → repeated Stop`, (t) => {
    const f = deliveryFixture(t);
    let plan;
    if (format === 'short') {
      const created = f.cli('plan-new', '--goal', 'Return two', '--acceptance', 'value is two', '--constraint', 'Keep the API', '--verification-check', 'behavior', '--json');
      assert.equal(created.status, 0, created.stderr);
      plan = JSON.parse(created.stdout).path;
    } else plan = writeVersionedPlan(f.ws, { required: ['behavior'], criteria: { AC1: ['behavior'] } });
    const full = path.resolve(f.ws, plan);
    fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace('reviews:\n  required: []', 'reviews:\n  required: [code-review]'));
    const gate = f.cli('gate', '--plan', plan, '--phase', 'implement', '--json');
    assert.equal(JSON.parse(gate.stdout).pass, true, gate.stdout + gate.stderr);
    const edit = { tool_name: 'replace_string_in_file', tool_input: { filePath: 'src/example.js' } };
    assert.equal(JSON.parse(f.hook('require-plan-gate.mjs', edit).stdout).continue, true);
    fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 3;\n');
    f.hook('record-successful-edit.mjs', { ...edit, hook_event_name: 'PostToolUse', tool_response: 'File edited successfully' });
    const broken = JSON.parse(f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json').stdout);
    assert.notEqual(broken.outcome, 'passed');
    assert.equal(broken.checks.find(c => c.id === 'behavior').status, 'failed');
    assert.equal(JSON.parse(f.hook('require-verification.mjs', { hook_event_name: 'Stop' }).stdout).hookSpecificOutput?.decision, 'block');
    fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
    f.hook('record-successful-edit.mjs', { ...edit, hook_event_name: 'PostToolUse', tool_response: 'File edited successfully' });
    const prepared = f.cli('review', 'prepare', '--plan', plan, '--base', 'HEAD', '--json');
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    const packet = JSON.parse(prepared.stdout);
    const input = path.join(f.ws, '.harness/review-input.json');
    fs.writeFileSync(input, JSON.stringify({ packet: packet.id, results: [] }));
    const missing = f.cli('review', 'assemble', '--plan', plan, '--packet', packet.id, '--file', input, '--json');
    assert.equal(JSON.parse(missing.stdout).coverage.complete, false);
    fs.writeFileSync(input, JSON.stringify({ packet: packet.id, results: packet.required.map(reviewer => ({ ...scriptedFlowLedger(packet, reviewer), reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [] })) }));
    const reviewed = f.cli('review', 'assemble', '--plan', plan, '--packet', packet.id, '--file', input, '--json');
    assert.equal(reviewed.status, 0, reviewed.stdout + reviewed.stderr);
    const verified = f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json');
    assert.equal(JSON.parse(verified.stdout).outcome, 'passed', verified.stdout + verified.stderr);
    const contract = planDigest(fs.readFileSync(full, 'utf8'));
    const decisionFile = path.join(f.ws, '.harness/learning-input.json');
    fs.writeFileSync(decisionFile, JSON.stringify({ operation: 'exit-proof', decision: learning, scope: 'private', rationale: 'Fixture explicitly chooses whether a durable lesson exists', title: 'Export value regression', body: '## Problem\nAn incorrect value escaped.\n\n## Solution\nAssert the observable exported value.', category: 'testing' }));
    const compounded = f.cli('compound', '--plan', plan, '--learning-decision', decisionFile, '--json');
    assert.equal(compounded.status, 0, compounded.stdout + compounded.stderr);
    const replayed = f.cli('compound', '--plan', plan, '--learning-decision', decisionFile, '--json');
    assert.equal(JSON.parse(replayed.stdout).replayed, true, replayed.stdout + replayed.stderr);
    const operationPath = path.join(f.ws, JSON.parse(compounded.stdout).learningRecord);
    const operation = JSON.parse(fs.readFileSync(operationPath, 'utf8'));
    fs.writeFileSync(operationPath, JSON.stringify({ ...operation, state: 'pending' }));
    const recoveredLearning = f.cli('compound', '--plan', plan, '--learning-decision', decisionFile, '--json');
    assert.equal(recoveredLearning.status, 0, recoveredLearning.stdout + recoveredLearning.stderr);
    assert.equal(JSON.parse(recoveredLearning.stdout).path, JSON.parse(compounded.stdout).path, 'interrupted bookkeeping must recover the same publication');
    assert.equal(JSON.parse(replayed.stdout).path, JSON.parse(compounded.stdout).path);
    const done = f.cli('plan-update', '--plan', plan, '--status', 'done', '--json');
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.equal(planDigest(fs.readFileSync(full, 'utf8')), contract);
    const repeated = f.cli('plan-update', '--plan', plan, '--status', 'done', '--json');
    assert.equal(JSON.parse(repeated.stdout).completion, JSON.parse(done.stdout).completion);
    for (let i = 0; i < 2; i++) {
      const stopped = f.hook('require-verification.mjs', { hook_event_name: 'Stop' });
      assert.equal(JSON.parse(stopped.stdout).continue, true, stopped.stdout + stopped.stderr);
    }
    fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 4;\n');
    const stale = f.hook('require-verification.mjs', { hook_event_name: 'Stop' });
    assert.equal(JSON.parse(stale.stdout).hookSpecificOutput?.decision, 'block', stale.stdout + stale.stderr);
  });
}

test('learning replay rejects a changed resolved home rather than republishing', t => {
  const f = deliveryFixture(t), plan = writeVersionedPlan(f.ws, { required: ['behavior'], criteria: { AC1: ['behavior'] } });
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  assert.equal(f.cli('verify', '--plan', plan, '--base', 'HEAD', '--json').status, 0);
  const file = path.join(f.ws, '.harness/destination-conflict.json');
  fs.writeFileSync(file, JSON.stringify({ operation: 'home-conflict', decision: 'publish', scope: 'global', rationale: 'Durable boundary.', title: 'Boundary', body: 'Accepted publication remains at one resolved destination.' }));
  const first = f.cli('compound', '--plan', plan, '--learning-decision', file, '--json');
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const value = JSON.parse(first.stdout), receiptPath = path.join(f.ws, value.learningRecord), before = fs.readFileSync(receiptPath);
  const secondHome = path.join(f.ws, '.harness/second-copilot');
  fs.cpSync(f.copilot, secondHome, { recursive: true });
  fs.rmSync(path.join(secondHome, 'knowledge/solutions'), { recursive: true, force: true });
  approveProject({ workspace: f.ws, copilotHome: secondHome, home: f.home });
  const result = spawnSync(process.execPath, [path.join(root, 'bin/ae.mjs'), 'compound', '--plan', plan, '--learning-decision', file, '--workspace', f.ws, '--harness-home', f.home, '--copilot-home', secondHome, '--json'], { cwd: f.ws, env: { ...f.env, COPILOT_HOME: secondHome }, encoding: 'utf8' });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout + result.stderr, /destination|conflict/);
  assert.equal(fs.existsSync(path.join(secondHome, 'knowledge/solutions')), false);
  assert.ok(fs.readFileSync(receiptPath).equals(before));
});
