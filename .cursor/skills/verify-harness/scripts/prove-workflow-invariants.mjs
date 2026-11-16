#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../../../../packages/ae/lib/runner.mjs';
import { GIT_ENV, parseFrontmatter } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const packageRoot = path.join(repoRoot, 'packages/ae');
const reference = 'packages/ae/corpus/skills/references/workflow-invariants.md';
const negative = process.argv.slice(2).includes('--negative-control');
const feature = negative ? 'workflow-invariants-negative' : 'workflow-invariants';
const artifactRoot = process.env.HARNESS_CHECK_ARTIFACT_DIR || process.env.HARNESS_DRIVE_EVIDENCE_ROOT || path.join(repoRoot, '.harness/evidence/workflow-invariants-manual', crypto.randomUUID());
const evidencePath = path.join(artifactRoot, feature, 'drive.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));
const controller = new AbortController();
const receipt = { schema: 1, feature, passed: false, ...(negative ? { detected: false } : {}), invariantIds: ['AE-I1', 'AE-I2', 'AE-I3'], steps: [], lifecycle: { outcome: 'failed', doctor: null, resources: [], cleaned: false } };
let stage = 'arguments';
let cancellationPoll;
const cancel = () => { receipt.lifecycle.outcome = 'cancelled'; controller.abort(); };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, cancel);
const notice = process.env.HARNESS_RUN_CANCEL_FILE;
if (notice && path.isAbsolute(notice)) {
  cancellationPoll = setInterval(() => {
    try {
      const stat = fs.lstatSync(notice);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) return;
      const value = JSON.parse(fs.readFileSync(notice, 'utf8'));
      if (value.version === 1 && value.pid === process.pid) cancel();
    } catch { /* the owned cancellation notice appears only on interruption */ }
  }, 25);
  cancellationPoll.unref();
}

async function run(label, invariant, argv, { cwd = repoRoot, env = process.env, input } = {}) {
  stage = label;
  assert.equal(controller.signal.aborted, false, 'drive cancelled');
  const result = await runProcess({ argv, cwd, env, timeoutMs: 25000, signal: controller.signal, maxBuffer: 262144,
    ...(input === undefined ? {} : { spawnFn: (command, args, options) => {
      const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input));
      return child;
    } }),
  });
  const step = { stage: label, invariant, argv, exitCode: result.exitCode, status: result.status, stdout: result.stdout.slice(0, 8192), stderr: result.stderr.slice(0, 2048) };
  receipt.steps.push(step);
  assert.notEqual(result.exitCode, null, `${label}: process did not exit normally (${result.status})`);
  assert.equal(controller.signal.aborted, false, 'drive cancelled');
  return { ...result, step };
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

async function fixture(runtimeRoot) {
  const owned = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-invariants-')));
  receipt.lifecycle.resources.push(owned);
  const ws = path.join(owned, 'product'), home = path.join(owned, 'state'), copilot = path.join(owned, 'copilot');
  const bin = path.join(runtimeRoot, 'bin/ae.mjs');
  const env = { ...process.env, ...GIT_ENV, CI: '', HARNESS_ALLOW_INPLACE: '', HOME: owned, USERPROFILE: owned, AE_HOME: home, HARNESS_HOME: home, COPILOT_HOME: copilot, AE_BIN: bin, HARNESS_BIN: bin, HARNESS_ENFORCEMENT: 'enforce' };
  write(path.join(ws, '.gitignore'), '.harness/\n');
  write(path.join(ws, 'package.json'), '{"type":"module"}\n');
  write(path.join(ws, 'src/example.js'), 'export const value = 1;\n');
  const spec = path.join(ws, 'docs/specs/value.md'), specBytes = '# Value contract\n\nThe exported value must be two.\n';
  write(spec, specBytes);
  const check = [process.execPath, '-e', "import('./src/example.js').then(m => { if (m.value !== 2) process.exit(1); })"];
  write(path.join(ws, '.github/harness/checks.yaml'), `version: 1\nchecks:\n  behavior:\n    command: ${JSON.stringify(check)}\n    proof: behavior\n`);
  write(path.join(ws, '.github/harness/policy.yaml'), 'version: 1\nenforcement: enforce\n');
  for (const args of [['init', '-q'], ['config', 'user.name', 'Invariant Fixture'], ['config', 'user.email', 'invariant@example.test'], ['add', '.'], ['commit', '-qm', 'fixture baseline']]) {
    const result = await run('fixture-git', null, ['git', ...args], { cwd: ws, env });
    assert.equal(result.exitCode, 0, result.stderr);
  }
  const cli = async (label, args, expected = 0, invariant = 'AE-I2') => {
    const result = await run(label, invariant, [process.execPath, bin, ...args, '--workspace', ws, '--ae-home', home, '--copilot-home', copilot, '--json'], { cwd: ws, env });
    assert.equal(result.exitCode, expected, result.stderr + result.stdout);
    const body = JSON.parse(result.stdout);
    result.step.observation = { ...(body.pass === undefined ? {} : { pass: body.pass }), ...(body.outcome ? { outcome: body.outcome } : {}), ...(body.checks ? { checks: body.checks.map(c => ({ id: c.id, pass: c.pass, status: c.status })) } : {}) };
    return body;
  };
  const hook = async (label, name, input, invariant = 'AE-I3') => {
    const result = await run(label, invariant, [process.execPath, path.join(runtimeRoot, 'corpus/hooks', name)], { cwd: ws, env, input: { cwd: ws, workspace: ws, session_id: 'invariant-drive', ...input } });
    assert.equal(result.exitCode, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    result.step.observation = body;
    return body;
  };
  await cli('fixture-trust', ['trust', 'approve']);
  const create = async () => {
    const decision = path.join(ws, '.harness/decisions/create.json');
    write(decision, JSON.stringify({ version: 1, format: 'short', goal: 'Honor the value contract', acceptance: ['The exported value is two.'], constraints: ['Preserve the export API.'], scope: ['src/example.js'], check: 'behavior', status: 'in-progress', intentSources: ['docs/specs/value.md'] }));
    const created = await cli('accepted-plan', ['plan-new', '--file', decision], 0, 'AE-I1');
    const fm = parseFrontmatter(fs.readFileSync(created.path, 'utf8'));
    assert.equal(fm.plan_lock, true);
    assert.equal(fm.intent_source_policy, 'content-v1');
    assert.equal(fm.intent_sources[0].sha256, hash(specBytes));
    return created.path;
  };
  return { owned, ws, home, copilot, cli, hook, create, spec, specBytes };
}

function denied(body) { return body.hookSpecificOutput?.permissionDecision === 'deny'; }
function stopped(body) { return body.hookSpecificOutput?.decision === 'block'; }
function intentCheck(body) {
  const checks = body.checks.filter(check => check.id === 'C-intent-sources');
  assert.equal(checks.length, 1);
  return checks[0];
}

async function positive() {
  const f = await fixture(packageRoot);
  const edit = { tool_name: 'replace_string_in_file', tool_input: { filePath: 'src/example.js', oldString: 'value = 1', newString: 'value = 2' } };
  assert.equal((await f.hook('read-without-plan', 'require-plan-gate.mjs', { tool_name: 'read_file', tool_input: { filePath: 'src/example.js' } })).continue, true);
  assert.equal((await f.hook('read-only-stop', 'require-verification.mjs', { hook_event_name: 'Stop' })).continue, true);
  assert.equal(denied(await f.hook('ungated-edit', 'require-plan-gate.mjs', edit)), true);
  assert.equal(fs.readFileSync(path.join(f.ws, 'src/example.js'), 'utf8'), 'export const value = 1;\n');
  const plan = await f.create();
  assert.equal((await f.cli('accepted-gate', ['gate', '--plan', plan, '--phase', 'implement'], 0, 'AE-I1')).pass, true);
  fs.writeFileSync(f.spec, '# Changed after acceptance\n');
  const drift = await f.cli('changed-intent', ['gate', '--plan', plan, '--phase', 'implement'], 1, 'AE-I1');
  assert.equal(intentCheck(drift).pass, false);
  assert.equal((await f.hook('recovery-read', 'require-plan-gate.mjs', { tool_name: 'run_in_terminal', tool_input: { command: 'ae orient --read --json' } })).continue, true);
  assert.equal(denied(await f.hook('mixed-recovery', 'require-plan-gate.mjs', { tool_name: 'run_in_terminal', tool_input: { command: 'ae orient --read --json; node src/example.js' } })), true);
  assert.equal(denied(await f.hook('failed-gate-edit', 'require-plan-gate.mjs', edit)), true);
  fs.writeFileSync(f.spec, f.specBytes);
  await f.cli('restored-intent-gate', ['gate', '--plan', plan, '--phase', 'implement'], 0, 'AE-I1');
  assert.equal((await f.hook('gated-edit', 'require-plan-gate.mjs', edit)).continue, true);
  const mutate = async value => {
    fs.writeFileSync(path.join(f.ws, 'src/example.js'), `export const value = ${value};\n`);
    await f.hook('record-product-edit', 'record-successful-edit.mjs', { ...edit, hook_event_name: 'PostToolUse', tool_response: 'File edited successfully' });
  };
  await mutate(3);
  const learning = path.join(f.ws, '.harness/decisions/learning.json');
  write(learning, JSON.stringify({ operation: 'workflow-no-learning', decision: 'no-learning', rationale: 'Disposable conformance fixture has no durable product lesson.' }));
  const compound = label => f.cli(label, ['compound', '--plan', plan, '--learning-decision', learning], 2);
  assert.equal((await compound('compound-before-proof')).pass, false);
  assert.equal(fs.existsSync(path.join(f.ws, '.harness/learning')), false);
  const broken = await f.cli('failed-behavior', ['verify', '--plan', plan, '--base', 'HEAD'], 1);
  assert.equal(broken.checks.find(check => check.id === 'behavior').status, 'failed');
  assert.equal((await compound('compound-after-failure')).pass, false);
  assert.equal(stopped(await f.hook('failed-proof-stop', 'require-verification.mjs', { hook_event_name: 'Stop' })), true);
  await mutate(2);
  const packet = await f.cli('prepare-review', ['review', 'prepare', '--plan', plan, '--base', 'HEAD']);
  const review = path.join(f.ws, '.harness/decisions/review.json');
  const flowLedger = ['positive', 'malformed-input', 'boundary', 'dependency-failure', 'concurrency', 'old-state', 'abuse', 'cross-boundary']
    .map(flow_class => ({ flow_class, entry: 'value export', input: `${flow_class} input`, path: ['src/example.js:1'], expected: 'Export the value', observed: 'Exports the value', verdict: 'gap', test: null }));
  write(review, JSON.stringify({ packet: packet.id, results: packet.required.map(reviewer => ({ reviewer, status: 'completed', findings: [], residual_risks: ['Scripted fixture exercises review collection, not reviewer quality.'], testing_gaps: [], ...(reviewer === 'spec-flow-analyzer' ? { flow_ledger: flowLedger } : {}) })) }));
  await f.cli('collect-review', ['review', 'assemble', '--plan', plan, '--packet', packet.id, '--file', review]);
  assert.equal((await f.cli('passed-proof', ['verify', '--plan', plan, '--base', 'HEAD'])).outcome, 'passed');
  await mutate(4);
  assert.equal((await compound('compound-stale-proof')).pass, false);
  assert.equal(stopped(await f.hook('stale-proof-stop', 'require-verification.mjs', { hook_event_name: 'Stop' })), true);
  await mutate(2);
  assert.equal((await f.cli('refreshed-proof', ['verify', '--plan', plan, '--base', 'HEAD'])).outcome, 'passed');
  assert.equal((await f.cli('verified-learning', ['compound', '--plan', plan, '--learning-decision', learning])).pass, true);
  assert.equal(stopped(await f.hook('incomplete-stop', 'require-verification.mjs', { hook_event_name: 'Stop' })), true);
  const complete = path.join(f.ws, '.harness/decisions/complete.json');
  write(complete, JSON.stringify({ version: 1, id: 'workflow-complete', action: 'complete', expect: fileHash(plan) }));
  await f.cli('complete-plan', ['plan-update', '--plan', plan, '--file', complete]);
  assert.equal((await f.hook('completion-stop', 'require-verification.mjs', { hook_event_name: 'Stop' })).continue, true);
}

async function negativeControl() {
  const owned = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-invariant-mutant-')));
  receipt.lifecycle.resources.push(owned);
  const copied = path.join(owned, 'package');
  fs.cpSync(packageRoot, copied, { recursive: true, filter: source => !['node_modules', 'test', 'eval'].includes(path.relative(packageRoot, source).split(path.sep)[0]) && !source.endsWith('.tgz') });
  fs.cpSync(path.join(packageRoot, 'node_modules/yaml'), path.join(copied, 'node_modules/yaml'), { recursive: true });
  const f = await fixture(copied), plan = await f.create(), acceptedPlan = fileHash(plan);
  const fresh = await f.cli('control-accepted-gate', ['gate', '--plan', plan, '--phase', 'implement'], 0, 'AE-I1');
  assert.equal(fresh.pass, true);
  assert.equal(intentCheck(fresh).pass, true);
  fs.writeFileSync(f.spec, '# Unexpected changed intent\n');
  const baseline = await f.cli('control-baseline-blocked', ['gate', '--plan', plan, '--phase', 'implement'], 1, 'AE-I1');
  assert.equal(baseline.pass, false);
  assert.equal(intentCheck(baseline).pass, false);
  assert.ok(baseline.checks.filter(c => c.id !== 'C-intent-sources').every(c => c.pass), 'unrelated gate checks must pass before mutation');
  stage = 'mutate-copied-guard';
  const guard = path.join(copied, 'lib/intent-sources.mjs'), original = fs.readFileSync(guard, 'utf8');
  const anchor = "if (stale.length) return { id: 'C-intent-sources', pass: false";
  assert.equal(original.split(anchor).length - 1, 1, 'exactly one actual stale-intent guard must be present');
  const mutated = original.replace(anchor, "if (false && stale.length) return { id: 'C-intent-sources', pass: false");
  fs.writeFileSync(guard, mutated);
  receipt.mutation = { invariant: 'AE-I1', file: guard, guard: 'C-intent-sources stale accepted-byte rejection', originalSha256: hash(original), mutatedSha256: hash(mutated) };
  const allowed = await f.cli('control-unexpected-allow', ['gate', '--plan', plan, '--phase', 'implement'], 0, 'AE-I1');
  assert.equal(allowed.pass, true, 'the real copied gate must expose the injected violation');
  assert.equal(intentCheck(allowed).pass, true);
  const acceptedHash = parseFrontmatter(fs.readFileSync(plan, 'utf8')).intent_sources[0].sha256, currentHash = fileHash(f.spec);
  assert.notEqual(acceptedHash, currentHash, 'changed intent must remain changed');
  assert.equal(fileHash(plan), acceptedPlan, 'accepted plan must remain unchanged');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.ws, '.harness/session.json'))).gateStatus, 'pass');
  receipt.control = { baselineBlocked: true, unexpectedAllow: true, acceptedHash, currentHash };
  receipt.detected = true;
}

try {
  assert.ok(process.argv.slice(2).every(arg => arg === '--negative-control'), 'only --negative-control is supported');
  const doctor = await run('doctor', null, [process.execPath, path.join(here, 'doctor.mjs')]);
  receipt.lifecycle.doctor = { exitCode: doctor.exitCode, stdout: doctor.stdout, stderr: doctor.stderr };
  assert.equal(doctor.exitCode, 0, 'readiness doctor failed');
  receipt.reference = { path: reference, sha256: fileHash(path.join(repoRoot, reference)) };
  const revision = await run('source-revision', null, ['git', 'rev-parse', 'HEAD'], { env: { ...process.env, ...GIT_ENV } });
  assert.equal(revision.exitCode, 0, revision.stderr);
  assert.match(revision.stdout.trim(), /^[a-f0-9]{40}$/);
  const sourceFiles = ['lib/intent-sources.mjs', 'lib/gate.mjs', 'lib/evidence.mjs', 'lib/compound.mjs', 'lib/completion.mjs', 'corpus/hooks/require-plan-gate.mjs', 'corpus/hooks/require-verification.mjs'];
  receipt.source = { head: revision.stdout.trim(), inputs: Object.fromEntries(sourceFiles.map(rel => [`packages/ae/${rel}`, fileHash(path.join(packageRoot, rel))])), helperSha256: fileHash(process.argv[1]) };
  receipt.checkedInvariantIds = negative ? ['AE-I1'] : receipt.invariantIds;
  if (negative) await negativeControl(); else await positive();
  receipt.passed = true;
  receipt.lifecycle.outcome = 'passed';
} catch (error) {
  receipt.error = { stage, message: error.message.slice(0, 2048) };
  process.exitCode = 1;
} finally {
  if (cancellationPoll) clearInterval(cancellationPoll);
  for (const resource of receipt.lifecycle.resources) fs.rmSync(resource, { recursive: true, force: true });
  receipt.lifecycle.cleaned = receipt.lifecycle.resources.every(resource => !fs.existsSync(resource));
  receipt.evidencePath = evidencePath;
  write(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
