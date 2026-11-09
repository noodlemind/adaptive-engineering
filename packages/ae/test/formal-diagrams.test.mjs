import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { projectFormalEvidence } from '../lib/diagrams/formal.mjs';
import { createRedactor } from '../lib/redact.mjs';
import { diagramsResultOf, parseDiagramArguments } from '../lib/diagram-cmd.mjs';
import { runFormalVerification } from '../corpus/skills/create-primitive/assets/formal-verification/check.mjs';
import { TEST_GIT_ENV } from './helpers/store.mjs';
import { NEEDS_NO_LAZY_FETCH } from './helpers/git-features.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const frame = (code, level, body = '') => `@!@!@STARTMSG ${code}:${level} @!@!@\n${body}\n@!@!@ENDMSG ${code} @!@!@\n`;
const state = (number, action, vars) => frame(2217, 4, `${number}: <${action}>\n${vars}\n`);
const safety = frame(2110, 1, 'Invariant NoDuplicate is violated.') + frame(2121, 1, 'The behavior up to this point is:')
  + state(1, 'Initial predicate', 'phase = "ready"') + state(2, 'Publish line 1', 'phase = "duplicated"') + frame(2186, 0, 'Finished');

function receipt(stdout = safety, overrides = {}) {
  return {
    schema: 1, feature: 'formal-verification', passed: true, status: 'passed', semanticCompleteness: 'unverified',
    source: { commit: 'a'.repeat(40), sourceKind: 'working-tree-bytes', files: [], digest: hash('[]') }, verificationBindings: [],
    models: [{ module: 'Unsafe.tla', expected: 'safety-violation', property: 'NoDuplicate', pass: true,
      execution: { status: 12, signal: null, error: null, stdout, stderr: '' }, ...overrides }],
  };
}

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-formal-diagram-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src/service.mjs'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(workspace, 'Unsafe.tla'), '---- MODULE Unsafe ----\n====\n');
  const evidence = receipt();
  evidence.source.files = [{ path: 'src/service.mjs', sha256: hash(fs.readFileSync(path.join(workspace, 'src/service.mjs'))) }];
  evidence.verificationBindings = [{ path: 'Unsafe.tla', sha256: hash(fs.readFileSync(path.join(workspace, 'Unsafe.tla'))) }, { path: '<copied-runner>', sha256: 'b'.repeat(64) }];
  fs.writeFileSync(path.join(workspace, 'formal-verification.json'), JSON.stringify(evidence));
  const render = (extra = []) => diagramsResultOf(['formal', '--file', 'formal-verification.json', '--model', 'Unsafe.tla', '--workspace', workspace, ...extra]);
  const status = result => diagramsResultOf(['status', '--receipt', result.artifacts.receipt, '--workspace', workspace]);
  return { workspace, evidence, render, status };
}

test('formal diagram flags explicitly select an offline recorded model', () => {
  const parsed = parseDiagramArguments(['formal', '--file', 'formal-verification.json', '--model', 'Unsafe.tla', '--png']);
  assert.equal(parsed.verb, 'formal'); assert.equal(parsed.model, 'Unsafe.tla'); assert.equal(parsed.png, true);
  for (const argv of [
    ['formal', '--file', 'formal-verification.json'], ['formal', '--file', 'model.tla', '--model', 'Unsafe.tla'],
    ['formal', '--file', 'receipt.json', '--model', '../Unsafe.tla'], ['render', '--file', 'view.mmd', '--model', 'Unsafe.tla'],
    ['formal', '--file', 'receipt.json', '--model', 'Unsafe.tla', '--view', 'execute.mjs'],
  ]) assert.throws(() => parseDiagramArguments(argv), /diagrams:/);
});

test('recorded safety counterexample preserves each transition and labels negative controls honestly', () => {
  const result = projectFormalEvidence(receipt(), 'Unsafe.tla');
  assert.equal(result.kind, 'formal-trace');
  assert.equal(result.metadata.role, 'expected-negative-control');
  assert.equal(result.metadata.property, 'NoDuplicate');
  assert.equal(result.metadata.trace.states, 2);
  assert.equal(result.metadata.trace.steps, 1);
  assert.match(result.source, /Publish/);
  assert.match(result.source, /Recorded counterexample/);
  assert.match(result.source, /not fresh verification/);
  assert.doesNotMatch(result.source, /classDef|click|^---/m);
});

test('Lauren Tan pstack saved TLC corpus retains its actual one-step CounterJump counterexample', () => {
  const stdout = fs.readFileSync(new URL('./fixtures/formal-diagrams/pstack-counterjump.txt', import.meta.url), 'utf8');
  const evidence = receipt(stdout, { property: 'NotThree' });
  const result = projectFormalEvidence(evidence, 'Unsafe.tla');
  assert.equal(result.metadata.property, 'NotThree'); assert.equal(result.metadata.trace.steps, 1);
  assert.match(result.source, /Jump/);
  assert.match(result.metadata.nodes[0].label, /jumps=0 x=0/);
  assert.match(result.metadata.nodes[1].label, /jumps=1 x=3/);
  assert.equal(result.metadata.attribution.author, 'Lauren Tan');
  assert.deepEqual(projectFormalEvidence(receipt(stdout.replaceAll('\n', '\r\n'), { property: 'NotThree' }), 'Unsafe.tla').metadata.trace, result.metadata.trace);
});

test('temporal counterexamples retain back edges and stuttering instead of inventing a terminal state', () => {
  const loop = frame(2116, 1, 'Temporal properties were violated.') + frame(2121, 1)
    + state(1, 'Initial predicate', 'x = 0') + state(2, 'Retry line 2', 'x = 1')
    + frame(2122, 4, '1: Back to state: <Again line 3>') + frame(2186, 0);
  const result = projectFormalEvidence(receipt(loop, { expected: 'liveness-violation', property: 'EventuallyDone', execution: { status: 13, signal: null, error: null, stdout: loop, stderr: '' } }), 'Unsafe.tla');
  assert.equal(result.metadata.trace.loop, 0); assert.equal(result.metadata.trace.states, 2);
  assert.match(result.source, /s1 --> s0/);
  const stutter = frame(2116, 1, 'Temporal properties were violated.') + state(1, 'Initial predicate', 'x = 0') + frame(2218, 4, '2: Stuttering') + frame(2186, 0);
  const stopped = projectFormalEvidence(receipt(stutter, { expected: 'liveness-violation', property: 'EventuallyDone', execution: { status: 13, signal: null, error: null, stdout: stutter, stderr: '' } }), 'Unsafe.tla');
  assert.equal(stopped.metadata.trace.stutters, true); assert.match(stopped.source, /s0 --> s0/);
  const windowsLoop = loop.replaceAll('\n', '\r\n');
  assert.deepEqual(projectFormalEvidence(receipt(windowsLoop, { expected: 'liveness-violation', property: 'EventuallyDone', execution: { status: 13, signal: null, error: null, stdout: windowsLoop, stderr: '' } }), 'Unsafe.tla').metadata.trace, result.metadata.trace);
  const finite = loop.replace(frame(2122, 4, '1: Back to state: <Again line 3>'), '');
  assert.throws(() => projectFormalEvidence(receipt(finite, { expected: 'liveness-violation', property: 'EventuallyDone', execution: { status: 13, signal: null, error: null, stdout: finite, stderr: '' } }), 'Unsafe.tla'), /loop|stutter/);
});

test('missing, malformed, truncated, oversized, and non-counterexample evidence never invents a chart', () => {
  const positive = frame(2193, 0, 'No error has been found.') + frame(2186, 0);
  for (const input of [positive, safety.replace('@!@!@ENDMSG 2186 @!@!@', ''), safety.replace('phase = "duplicated"', '«redacted:error»'), 'x'.repeat(600_000)]) {
    assert.throws(() => projectFormalEvidence(receipt(input), 'Unsafe.tla'), /formal trace:/);
  }
  assert.throws(() => projectFormalEvidence(receipt(), 'Missing.tla'), /formal trace:/);
  assert.throws(() => projectFormalEvidence(receipt(safety, { execution: { status: 12, signal: 'SIGTERM', error: null, stdout: safety } }), 'Unsafe.tla'), /formal trace:/);
  assert.throws(() => projectFormalEvidence(receipt(), 'Unsafe.tla', { maxNodes: 1 }), /formal trace:/);
  assert.throws(() => projectFormalEvidence(receipt(safety.replace('2: <Publish', '9: <Publish')), 'Unsafe.tla'), /out of order/);
  const extra = safety.replace(frame(2186, 0, 'Finished'), frame(2218, 4, '3: Stuttering') + state(3, 'Hidden line 3', 'phase = "hidden"') + frame(2186, 0));
  assert.throws(() => projectFormalEvidence(receipt(extra), 'Unsafe.tla'), /sequence/);
  const nestedError = safety.replace(frame(2121, 1, 'The behavior up to this point is:'), frame(2121, 1, frame(3002, 1, 'Parse failed.')));
  assert.throws(() => projectFormalEvidence(receipt(nestedError), 'Unsafe.tla'), /checker error/);
});

test('large TLA integers retain exact text while duplicate or disappearing variables refuse a trace', () => {
  for (const value of ['9007199254740993', '9007199254740991..9007199254740993']) {
    const result = projectFormalEvidence(receipt(safety.replace('phase = "ready"', `phase = ${value}`)), 'Unsafe.tla');
    assert.equal(result.metadata.nodes[0].label, value);
  }
  for (const stdout of [
    safety.replace('phase = "ready"', '/\\ phase = "ready"\n/\\ phase = "overwritten"'),
    safety.replace('phase = "ready"', '/\\ phase = "ready"\n/\\ hidden = TRUE'),
    safety.replace('phase = "ready"', '/\\ phase = "ready"\n\n/\\ hidden = TRUE'),
  ]) assert.throws(() => projectFormalEvidence(receipt(stdout), 'Unsafe.tla'), /formal trace:/);
});

test('reported pass fields cannot hide an unexpected failure or a mismatched negative property', () => {
  const mismatch = projectFormalEvidence(receipt(safety, { property: 'DifferentProperty' }), 'Unsafe.tla');
  assert.equal(mismatch.metadata.role, 'negative-control-mismatch'); assert.equal(mismatch.metadata.property, 'NoDuplicate');
  const product = projectFormalEvidence(receipt(safety, { expected: 'pass', property: null }), 'Unsafe.tla');
  assert.equal(product.metadata.role, 'unexpected-model-violation');
  assert.equal(product.metadata.freshVerification, false);
  assert.throws(() => projectFormalEvidence(receipt(safety, { property: null }), 'Unsafe.tla'), /intended property/);
});

test('trace labels are redacted before static diagram source or metadata is persisted', () => {
  const secret = 'ghp_' + 'A'.repeat(32);
  const stdout = safety.replace('"duplicated"', JSON.stringify(secret));
  const result = projectFormalEvidence(receipt(stdout), 'Unsafe.tla', { redactor: createRedactor({ env: {} }) });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.match(result.source, /redacted/);
});

test('offline formal command publishes through the existing renderer and source/model changes become stale', async t => {
  const f = fixture(t), result = await f.render(['--png', '--scale', '1']);
  assert.equal(result.verification, 'not-verified'); assert.equal(result.kind, 'formal-trace');
  assert.equal(result.freshness.state, 'current'); assert.equal(result.freshness.scope, 'recorded-formal-evidence');
  assert.equal((await f.status(result)).state, 'current');
  const record = JSON.parse(fs.readFileSync(path.join(f.workspace, result.artifacts.receipt), 'utf8'));
  assert.equal(record.authority, 'descriptive-context'); assert.equal(record.projection.role, 'expected-negative-control');
  assert.equal(record.projection.recordedRunnerSha256, 'b'.repeat(64));
  assert.equal(record.snapshot.bindings.some(binding => binding.path === '<copied-runner>'), false);
  const html = fs.readFileSync(path.join(f.workspace, result.artifacts.html), 'utf8');
  assert.match(html, /formal-trace diagram/); assert.match(html, /not-verified/); assert.match(html, /expected-negative-control/);
  assert.equal(fs.readFileSync(path.join(f.workspace, result.artifacts.png)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  fs.writeFileSync(path.join(f.workspace, 'Unsafe.tla'), 'changed model\n');
  assert.equal((await f.status(result)).state, 'stale');
  const old = await f.render(); assert.equal(old.freshness.state, 'stale');
  fs.writeFileSync(path.join(f.workspace, 'src/service.mjs'), 'changed implementation\n');
  assert.equal((await f.status(result)).state, 'stale');
});

test('missing covered source stays visibly unknown while the retained counterexample remains inspectable', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.workspace, 'Unsafe.tla'));
  const result = await f.render();
  assert.equal(result.freshness.state, 'unknown'); assert.equal((await f.status(result)).state, 'unknown');
  assert.equal(result.verification, 'not-verified');
});

test('actual CLI renders a retained receipt without Java or mise and prints its saved evidence identity', t => {
  const f = fixture(t);
  const cli = fileURLToPath(new URL('../bin/ae.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'diagrams', 'formal', '--file', 'formal-verification.json', '--model', 'Unsafe.tla', '--workspace', f.workspace, '--json', '--no-events'], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, AE_TLC_JAR: '/unavailable/do-not-read.jar', AE_TLC_JAVA: '/unavailable/do-not-execute-java' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.kind, 'formal-trace'); assert.equal(output.verification, 'not-verified');
  assert.match(fs.readFileSync(path.join(f.workspace, output.artifacts.html), 'utf8'), /expected-negative-control/);
});

test('actual producer receipt fields and copied-runner identity remain compatible with offline saved-witness replay', { skip: NEEDS_NO_LAZY_FETCH }, async t => {
  const f = fixture(t);
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']]) {
    const git = spawnSync('git', args, { cwd: f.workspace, encoding: 'utf8', env: { ...process.env, ...TEST_GIT_ENV } });
    assert.equal(git.status, 0, git.stderr);
  }
  const pilot = new URL('./fixtures/formal-verification/', import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', pilot), 'utf8'));
  for (const name of new Set(manifest.models.flatMap(model => [model.module, model.config]))) fs.copyFileSync(fileURLToPath(new URL(name, pilot)), path.join(f.workspace, name));
  fs.writeFileSync(path.join(f.workspace, 'intent.md'), 'Publish once.\n');
  fs.writeFileSync(path.join(f.workspace, 'proof.mjs'), 'throw new Error("must not execute during diagram replay");\n');
  manifest.intentSources = ['intent.md'];
  manifest.coverage = { sources: [], watchRoots: ['src'], extensions: ['.mjs'], lastSync: null };
  manifest.conformance.command = ['node', 'proof.mjs']; manifest.conformance.negativeControl = ['node', 'proof.mjs', '--negative-control'];
  fs.writeFileSync(path.join(f.workspace, 'manifest.json'), JSON.stringify(manifest));
  const produced = await runFormalVerification({ workspace: f.workspace, manifestPath: 'manifest.json', maintain: true, rationale: 'Test producer envelope only; no external checker is configured.', env: { ...process.env, ...TEST_GIT_ENV, AE_TLC_JAR: '', HARNESS_CHECK_ARTIFACT_DIR: path.join(f.workspace, 'retained') } });
  assert.equal(produced.status, 'blocked'); assert.equal(produced.passed, false);
  assert(produced.verificationBindings.some(binding => binding.path === '<copied-runner>'));
  // Import an upstream saved witness solely to exercise the real envelope. The
  // producer stays blocked; this fixture does not claim a fresh model check.
  const stdout = fs.readFileSync(new URL('./fixtures/formal-diagrams/pstack-counterjump.txt', import.meta.url), 'utf8');
  produced.models = receipt(stdout, { module: 'UnsafeDeliveryEvidence.tla', property: 'NotThree' }).models;
  fs.writeFileSync(path.join(f.workspace, 'retained/formal-verification.json'), JSON.stringify(produced));
  const replay = await diagramsResultOf(['formal', '--file', 'retained/formal-verification.json', '--model', 'UnsafeDeliveryEvidence.tla', '--workspace', f.workspace]);
  const saved = JSON.parse(fs.readFileSync(path.join(f.workspace, replay.artifacts.receipt), 'utf8'));
  assert.equal(saved.projection.recordedReceiptStatus, 'blocked'); assert.equal(saved.projection.freshVerification, false);
  assert.match(saved.projection.recordedRunnerSha256, /^[a-f0-9]{64}$/);
  assert.equal(replay.freshness.state, 'current');
  const html = fs.readFileSync(path.join(f.workspace, replay.artifacts.html), 'utf8');
  assert.match(html, /blocked/); assert.match(html, /not-verified/);
});

test('native evidence compiler has a pure import closure and retains upstream fixture notices', () => {
  const root = fileURLToPath(new URL('../lib/diagrams/', import.meta.url));
  const visited = new Set();
  const inspect = file => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\b(?:process|require|globalThis|global|Deno|Bun|Buffer|fetch|setTimeout|setInterval|eval|Function)\b|\bimport\s*\(/);
    for (const [, dependency] of source.matchAll(/\b(?:import|export)\s+[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g)) {
      assert.match(dependency, /^\.\/formal-[a-z]+\.mjs$/);
      inspect(path.resolve(path.dirname(file), dependency));
    }
  };
  inspect(path.join(root, 'formal-protocol.mjs')); inspect(path.join(root, 'formal-graph.mjs'));
  assert.equal(visited.size, 2);
  assert.equal(fs.existsSync(path.join(root, 'vendor/pstack')), false, 'AE owns the implementation rather than shipping an upstream subsystem');
  assert.match(fs.readFileSync(new URL('./fixtures/formal-diagrams/LICENSE.pstack', import.meta.url), 'utf8'), /Copyright \(c\) 2026 Lauren Tan/);
});

test('formal receipt input and binding paths cannot escape the workspace or follow symlinks', async t => {
  const f = fixture(t);
  f.evidence.source.files[0].path = '../secret';
  fs.writeFileSync(path.join(f.workspace, 'formal-verification.json'), JSON.stringify(f.evidence));
  await assert.rejects(f.render(), /formal|unsafe|contained/);
  if (process.platform === 'win32') return;
  fs.writeFileSync(path.join(f.workspace, 'outside.json'), JSON.stringify(receipt()));
  fs.symlinkSync(path.join(f.workspace, 'outside.json'), path.join(f.workspace, 'linked.json'));
  await assert.rejects(diagramsResultOf(['formal', '--file', 'linked.json', '--model', 'Unsafe.tla', '--workspace', f.workspace]), /unsafe|unreadable/);
});
