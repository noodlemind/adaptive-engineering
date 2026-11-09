import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TEST_GIT_ENV } from './helpers/store.mjs';
import { collectCoverage, classifyTlc, validateConfiguration, runFormalVerification, tlcModelArguments, publishModelGraph } from '../corpus/skills/create-primitive/assets/formal-verification/check.mjs';

const msg = (id, severity = 0, body = '') => `@!@!@STARTMSG ${id}:${severity} @!@!@\n${body}\n@!@!@ENDMSG ${id} @!@!@\n`;
const success = msg(2193) + msg(2199, 0, '12 states generated, 8 distinct states found, 0 states left on queue.') + msg(2186);
const result = (status, stdout) => ({ status, stdout, stderr: '', signal: null });

function graphFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-formal-graph-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sandbox = path.join(root, 'run'), artifactDir = path.join(root, 'evidence');
  fs.mkdirSync(sandbox); fs.mkdirSync(artifactDir);
  const model = { module: 'Positive.tla', config: 'Positive.cfg', expect: 'pass' };
  const file = 'Positive.graph.dot', dot = 'strict digraph DiskGraph {\n-9007199254740993 [label="x = 9007199254740993",style = filled]\n}\n';
  fs.writeFileSync(path.join(sandbox, file), dot);
  return { root, sandbox, artifactDir, model, file, dot };
}

test('graph capture adds a dump to the same fixed TLC invocation only when requested', () => {
  const model = { module: 'Positive.tla', config: 'Positive.cfg' }, sandbox = path.resolve('owned-run');
  const original = tlcModelArguments('/configured/tla2tools.jar', model, sandbox);
  const captured = tlcModelArguments('/configured/tla2tools.jar', model, sandbox, true);
  assert.equal(original.at(-1), model.module);
  assert.equal(original.includes('-dump'), false);
  assert.deepEqual(captured, [...original.slice(0, -1), '-dump', 'dot,actionlabels', path.join(sandbox, 'Positive.graph'), model.module]);
  assert.deepEqual(captured.slice(0, original.length - 1), original.slice(0, -1), 'same configured model, seed, worker count and metadir');
});

test('captured graph publication retains exact bytes and binds same-run completion', t => {
  const f = graphFixture(t);
  const graph = publishModelGraph({ ...f, execution: result(0, success) });
  assert.deepEqual(graph, { format: 'tlc-dot', file: f.file, sha256: crypto.createHash('sha256').update(f.dot).digest('hex'), exploration: 'complete' });
  assert.equal(fs.readFileSync(path.join(f.artifactDir, f.file), 'utf8'), f.dot);
  assert.throws(() => publishModelGraph({ ...f, execution: result(0, success) }), /exist|occupied/i);
  assert.equal(fs.readFileSync(path.join(f.artifactDir, f.file), 'utf8'), f.dot, 'an existing artifact cannot be overwritten');
});

test('negative-control graphs remain partial and incomplete execution cannot export one', t => {
  const f = graphFixture(t);
  const execution = result(12, msg(2110, 1, 'Invariant NoDuplicate is violated.') + msg(2121, 1) + msg(2217, 4, 'State 1') + msg(2186));
  const model = { ...f.model, expect: 'safety-violation', property: 'NoDuplicate' };
  const graph = publishModelGraph({ ...f, model, execution });
  assert.equal(graph.exploration, 'partial');
  for (const incomplete of [result(0, msg(2186)), { ...result(0, success), signal: 'SIGTERM' }, { ...result(0, success), error: { code: 'ETIMEDOUT' } }]) {
    assert.throws(() => publishModelGraph({ ...f, execution: incomplete }), /completed|expected|capture/i);
  }
});

test('requested graph capture refuses missing, nonregular, empty and oversized dumps', t => {
  const f = graphFixture(t), full = path.join(f.sandbox, f.file);
  const capture = () => publishModelGraph({ ...f, execution: result(0, success) });
  fs.rmSync(full);
  assert.throws(capture, /missing|ENOENT|capture/i);
  fs.mkdirSync(full);
  assert.throws(capture, /regular/i);
  fs.rmdirSync(full);
  for (const bytes of ['', Buffer.from([0]), Buffer.from([0xff])]) {
    fs.writeFileSync(full, bytes);
    assert.throws(capture, /empty|text/i);
  }
  fs.writeFileSync(full, Buffer.alloc(1024 * 1024 + 1, 120));
  assert.throws(capture, /bounded|limit|oversized/i);
  assert.deepEqual(fs.readdirSync(f.artifactDir), []);
});

test('graph capture rejects symlink input and artifact ancestors without outside writes', { skip: process.platform === 'win32' }, t => {
  const f = graphFixture(t), outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, f.file), f.dot);
  fs.rmSync(path.join(f.sandbox, f.file));
  fs.symlinkSync(path.join(outside, f.file), path.join(f.sandbox, f.file));
  assert.throws(() => publishModelGraph({ ...f, execution: result(0, success) }), /symbolic|symlink/i);
  fs.rmSync(path.join(f.sandbox, f.file));
  fs.writeFileSync(path.join(f.sandbox, f.file), f.dot);
  const link = path.join(f.root, 'artifact-link'); fs.symlinkSync(outside, link, 'dir');
  assert.throws(() => publishModelGraph({ ...f, artifactDir: link, execution: result(0, success) }), /symbolic|symlink/i);
  assert.deepEqual(fs.readdirSync(outside), [f.file]);
  assert.equal(fs.readFileSync(path.join(outside, f.file), 'utf8'), f.dot);
});

test('the actual capture flag retains deliberate tool prerequisites instead of installing tools', t => {
  const f = manifestFixture(t);
  const runner = fileURLToPath(new URL('../corpus/skills/create-primitive/assets/formal-verification/check.mjs', import.meta.url));
  const invocation = spawnSync(process.execPath, [runner, '--workspace', f.root, '--manifest', f.filename, '--maintain', '--rationale', 'Reviewed fixture.', '--capture-graph'], { encoding: 'utf8', env: { ...process.env, AE_TLC_JAR: '', HARNESS_CHECK_ARTIFACT_DIR: path.join(f.root, 'capture-evidence') } });
  assert.equal(invocation.status, 1);
  const receipt = JSON.parse(invocation.stdout);
  assert.equal(receipt.status, 'blocked');
  assert.match(receipt.reason, /AE_TLC_JAR/);
  assert.equal(receipt.passed, false);
  assert.equal(fs.existsSync(path.join(f.root, 'capture-evidence', 'Positive.graph.dot')), false);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-formal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/service.mjs'), 'export const value = 1;\n');
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...TEST_GIT_ENV } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'baseline');
  return { root, git, coverage: { sources: [], watchRoots: ['src'], extensions: ['.mjs'] } };
}

function manifestFixture(t) {
  const f = fixture(t);
  const pilot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/formal-verification');
  const manifest = JSON.parse(fs.readFileSync(path.join(pilot, 'manifest.json'), 'utf8'));
  for (const name of new Set(manifest.models.flatMap(model => [model.module, model.config]))) fs.copyFileSync(path.join(pilot, name), path.join(f.root, name));
  fs.writeFileSync(path.join(f.root, 'intent.md'), 'The exported fixture value is one.\n');
  fs.writeFileSync(path.join(f.root, 'proof.mjs'), `import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pathToFileURL } from 'node:url'; import { spawnSync } from 'node:child_process';
const source = path.join(process.cwd(), 'src/service.mjs');
const { value } = await import(pathToFileURL(source)); assert.equal(value, 1);
const negative = process.argv.includes('--negative-control');
const steps = [{ stage: 'observe-exported-value', value, exitCode: 0 }];
if (negative) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-formal-mutation-'));
  try {
    const original = fs.readFileSync(source, 'utf8');
    const broken = original.replace('= 1', '= 2'); assert.notEqual(broken, original);
    const file = path.join(root, 'broken.mjs'); fs.writeFileSync(file, broken);
    const execution = spawnSync(process.execPath, ['--input-type=module', '-e', 'import assert from "node:assert/strict"; const {value}=await import(' + JSON.stringify(pathToFileURL(file).href) + '); assert.equal(value,1);'], { encoding: 'utf8' });
    assert.equal(execution.status, 1); assert.match(execution.stderr, /ERR_ASSERTION/);
    steps.push({ stage: 'observe-mutated-implementation-failure', exitCode: execution.status });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const ids = process.argv.includes('--string-ids') ? 'PREFIX-T1-SUFFIX' : ['T1'];
console.log(JSON.stringify({ schema: 1, feature: negative ? 'fixture-negative' : 'fixture-positive', passed: true, invariantIds: ids, checkedInvariantIds: ids, detected: negative, steps }));
`);
  manifest.intentSources = ['intent.md'];
  manifest.coverage = { ...f.coverage, lastSync: null };
  manifest.conformance = { command: ['node', 'proof.mjs'], negativeControl: ['node', 'proof.mjs', '--negative-control'], positiveFeature: 'fixture-positive', negativeFeature: 'fixture-negative', invariantIds: ['T1'], negativeInvariantIds: ['T1'] };
  const filename = path.join(f.root, 'manifest.json');
  const save = () => fs.writeFileSync(filename, JSON.stringify(manifest, null, 2) + '\n');
  save();
  return { ...f, manifest, filename, save };
}

test('coverage binds actual tracked source bytes', t => {
  const f = fixture(t), captured = collectCoverage(f.root, f.coverage);
  assert.deepEqual(captured.files.map(file => file.path), ['src/service.mjs']);
  assert.match(captured.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(captured.commit, f.git('rev-parse', 'HEAD'));
  assert.equal(captured.dirty, false);
  assert.equal(captured.sourceKind, 'working-tree-bytes');
});

test('coverage metadata does not invoke a configured Git filesystem monitor', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), monitor = path.join(f.root, 'monitor.sh'), called = `${monitor}.called`;
  fs.writeFileSync(monitor, '#!/bin/sh\n: > "$0.called"\nprintf "token\\0"\n', { mode: 0o700 });
  f.git('config', 'core.fsmonitor', monitor);
  f.git('status', '--porcelain');
  assert.equal(fs.existsSync(called), true, 'the configured monitor is executable for ordinary Git status');
  fs.rmSync(called);
  collectCoverage(f.root, f.coverage);
  assert.equal(fs.existsSync(called), false);
});

test('coverage metadata does not execute a configured clean filter', t => {
  const f = fixture(t), marker = path.join(f.root, 'filter.marker'), filter = path.join(f.root, 'filter.cjs');
  fs.writeFileSync(filter, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'called'); process.stdout.write(fs.readFileSync(0));\n`);
  fs.writeFileSync(path.join(f.root, '.gitattributes'), 'src/service.mjs filter=FormalFixture\n');
  f.git('add', '.'); f.git('commit', '-qm', 'filter fixture');
  const shellQuote = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
  f.git('config', 'filter.FormalFixture.clean', `${shellQuote(process.execPath)} ${shellQuote(filter)}`);
  fs.writeFileSync(path.join(f.root, 'src/service.mjs'), 'export const value = 2;\n');
  f.git('-c', 'core.fsmonitor=false', 'status', '--porcelain');
  assert.equal(fs.existsSync(marker), true, 'ordinary status must execute the configured filter');
  fs.rmSync(marker);
  const captured = collectCoverage(f.root, f.coverage);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(captured.files[0].sha256, crypto.createHash('sha256').update('export const value = 2;\n').digest('hex'));
});

test('coverage metadata does not execute an unwatched submodule clean filter', t => {
  const f = fixture(t), child = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-formal-submodule-'));
  t.after(() => fs.rmSync(child, { recursive: true, force: true }));
  const gitAt = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...TEST_GIT_ENV } });
    assert.equal(result.status, 0, result.stderr);
  };
  gitAt(child, 'init', '-q');
  fs.writeFileSync(path.join(child, '.gitattributes'), 'inner.txt filter=FormalInner\n');
  fs.writeFileSync(path.join(child, 'inner.txt'), 'before\n');
  gitAt(child, 'add', '.'); gitAt(child, 'commit', '-qm', 'inner baseline');
  f.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', child, 'deps/sub');
  f.git('commit', '-qm', 'submodule fixture');
  const submodule = path.join(f.root, 'deps/sub'), marker = path.join(child, 'filter.marker'), filter = path.join(child, 'filter.cjs');
  fs.writeFileSync(filter, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'called'); process.stdout.write(fs.readFileSync(0));\n`);
  const shellQuote = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
  gitAt(submodule, 'config', 'filter.FormalInner.clean', `${shellQuote(process.execPath)} ${shellQuote(filter)}`);
  fs.writeFileSync(path.join(submodule, 'inner.txt'), 'after!\n');
  f.git('-c', 'core.fsmonitor=false', 'status', '--porcelain');
  assert.equal(fs.existsSync(marker), true, 'ordinary outer status must execute the inner filter');
  fs.rmSync(marker);
  const captured = collectCoverage(f.root, f.coverage);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(captured.files.map(file => file.path), ['src/service.mjs']);
});

test('coverage includes an untracked writer under a watched root', t => {
  const f = fixture(t), before = collectCoverage(f.root, f.coverage);
  fs.writeFileSync(path.join(f.root, 'src/new-writer.mjs'), 'export const writer = true;\n');
  const after = collectCoverage(f.root, f.coverage);
  assert.notEqual(after.digest, before.digest);
  assert.ok(after.files.some(file => file.path === 'src/new-writer.mjs'));
  assert.equal(after.dirty, true);
});

test('coverage detects changed bytes without requiring a commit', t => {
  const f = fixture(t), before = collectCoverage(f.root, f.coverage);
  fs.writeFileSync(path.join(f.root, 'src/service.mjs'), 'export const value = 2;\n');
  assert.notEqual(collectCoverage(f.root, f.coverage).digest, before.digest);
});

test('unrelated files do not alter declared coverage', t => {
  const f = fixture(t), before = collectCoverage(f.root, f.coverage);
  fs.writeFileSync(path.join(f.root, 'unrelated.md'), 'Unrelated notes.\n');
  assert.equal(collectCoverage(f.root, f.coverage).digest, before.digest);
});

test('completed TLC model checking is distinguished from a bare zero exit', () => {
  assert.equal(classifyTlc(result(0, success), 'pass').pass, true);
});

test('the safety negative control requires its actual violation and trace', () => {
  const out = msg(2110, 1, 'Invariant CurrentEvidence is violated.') + msg(2121, 1) + msg(2217, 4, 'State 1') + msg(2186);
  assert.equal(classifyTlc(result(12, out), 'safety-violation', 'CurrentEvidence').pass, true);
});

test('an accidental TypeOK failure is not the intended safety negative control', () => {
  const out = msg(2110, 1, 'Invariant TypeOK is violated.') + msg(2121, 1) + msg(2217, 4, 'State 1') + msg(2186);
  assert.equal(classifyTlc(result(12, out), 'safety-violation', 'CurrentEvidence').pass, false);
});

test('the liveness negative control requires its actual violation and trace', () => {
  const out = msg(2116, 1, 'Temporal properties were violated.') + msg(2264, 1) + msg(2217, 4, 'State 1') + msg(2218, 4, 'Stuttering') + msg(2186);
  assert.equal(classifyTlc(result(13, out), 'liveness-violation').pass, true);
});

test('a successful model run retains explicit finite exploration statistics', () => {
  const check = classifyTlc(result(0, success), 'pass');
  assert.deepEqual(check.states, { generated: 12, distinct: 8, remaining: 0 });
});

test('coverage rejects escaping watched roots', t => {
  const f = fixture(t);
  assert.throws(() => collectCoverage(f.root, { ...f.coverage, watchRoots: ['../'] }), /contain|relative|unsafe|escape/i);
});

test('coverage rejects symlinked source instead of hashing another tree', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root, 'unrelated.mjs'), path.join(f.root, 'src/link.mjs'));
  assert.throws(() => collectCoverage(f.root, f.coverage), /symbolic|symlink|regular/i);
});

test('zero exit with incomplete output cannot claim formal success', () => {
  assert.equal(classifyTlc(result(0, msg(2186)), 'pass').pass, false);
});

test('a success marker cannot hide a TLC error', () => {
  assert.equal(classifyTlc(result(0, msg(2110, 1, 'Violation') + success), 'pass').pass, false);
});

test('a setup error cannot count as a detected negative control', () => {
  assert.equal(classifyTlc(result(150, msg(3002, 1, 'Parse failed') + msg(2186)), 'safety-violation').pass, false);
});

test('simulation output cannot substitute for completed model checking', () => {
  assert.equal(classifyTlc(result(0, msg(2193) + msg(2210) + msg(2186)), 'pass').pass, false);
});

test('tool errors and cancellation cannot supply formal evidence', () => {
  assert.equal(classifyTlc({ ...result(0, success), error: { code: 'ETIMEDOUT' } }, 'pass').pass, false);
  assert.equal(classifyTlc({ ...result(0, success), signal: 'SIGTERM' }, 'pass').pass, false);
});

test('missing prerequisites block without writing synchronization metadata', async t => {
  const f = manifestFixture(t), source = fs.readFileSync(f.filename, 'utf8');
  const check = await runFormalVerification({ workspace: f.root, manifestPath: f.filename, maintain: true, rationale: 'Reviewed fixture coverage.', env: { ...process.env, AE_TLC_JAR: '' } });
  assert.equal(check.passed, false);
  assert.equal(check.status, 'blocked');
  assert.match(check.reason, /AE_TLC_JAR/);
  assert.equal(fs.readFileSync(f.filename, 'utf8'), source);
});

test('unsupported Git gives an actionable prerequisite without retrying or advancing synchronization', { skip: process.platform === 'win32' }, async t => {
  const f = manifestFixture(t), before = fs.readFileSync(f.filename, 'utf8');
  const bin = path.join(f.root, 'git-bin'), calls = path.join(f.root, 'git-calls');
  fs.mkdirSync(bin);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(calls)}\nprintf '%s\\n' 'unknown option: --no-lazy-fetch' >&2\nexit 129\n`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  let check;
  try {
    process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
    check = await runFormalVerification({ workspace: f.root, manifestPath: f.filename, maintain: true, rationale: 'Reviewed fixture coverage.' });
  } finally { process.env.PATH = previousPath; }
  assert.equal(check.passed, false);
  assert.equal(check.status, 'blocked');
  assert.match(check.reason, /Upgrade Git.*--no-lazy-fetch/);
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1, 'unsupported Git must not be retried without its guard');
  assert.equal(fs.readFileSync(f.filename, 'utf8'), before);
});

test('an occupied receipt blocks before synchronization can advance', async t => {
  const f = manifestFixture(t), before = fs.readFileSync(f.filename, 'utf8');
  const artifacts = path.join(f.root, 'artifacts'); fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, 'formal-verification.json'), '{"existing":true}\n');
  const check = await runFormalVerification({ workspace: f.root, manifestPath: f.filename, maintain: true, rationale: 'Reviewed fixture coverage.', env: { ...process.env, HARNESS_CHECK_ARTIFACT_DIR: artifacts } });
  assert.equal(check.passed, false);
  assert.equal(check.status, 'blocked');
  assert.equal(fs.readFileSync(f.filename, 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(artifacts, 'formal-verification.json'), 'utf8'), '{"existing":true}\n');
});

for (const suffix of ['', '/new/subdirectory']) {
  test(`a rejected symlink artifact root cannot create directories or publish evidence${suffix}`, { skip: process.platform === 'win32' }, async t => {
    const f = fixture(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-formal-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const link = path.join(f.root, 'artifact-link');
    fs.symlinkSync(outside, link, 'dir');
    const check = await runFormalVerification({ workspace: f.root, manifestPath: 'missing.json', env: { ...process.env, HARNESS_CHECK_ARTIFACT_DIR: `${link}${suffix}` } });
    assert.equal(check.passed, false);
    assert.equal(check.status, 'blocked');
    assert.match(check.reason, /symbolic|symlink/);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.ok(fs.existsSync(check.evidencePath), 'a fresh private fallback retains the blocked receipt');
    assert.equal(fs.realpathSync(path.dirname(check.evidencePath)), path.dirname(check.evidencePath));
    assert.notEqual(path.dirname(check.evidencePath), outside);
  });
}

test('another maintenance lock is never deleted by a rejected invocation', async t => {
  const f = manifestFixture(t), lock = path.join(fs.realpathSync(os.tmpdir()), `ae-formal-maintain-${crypto.createHash('sha256').update(f.filename).digest('hex')}.lock`);
  fs.writeFileSync(lock, 'other operation', { flag: 'wx' });
  t.after(() => fs.rmSync(lock, { force: true }));
  const check = await runFormalVerification({ workspace: f.root, manifestPath: f.filename, maintain: true, rationale: 'Reviewed fixture coverage.' });
  assert.equal(check.passed, false);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'other operation');
});

for (const directive of ['  CONSTRAINT Restrict', '\tSYMMETRY Perms', '  CHECK_DEADLOCK FALSE', 'ACTION_CONSTRAINTS Restrict', 'VIEW SmallView', 'CONSTANTS Bounds = 0']) {
  test(`configuration cannot conceal a reduction or extra directive: ${directive.trim()}`, () => {
    assert.throws(() => validateConfiguration(`SPECIFICATION Spec\nINVARIANTS Safety\nPROPERTY Progress\n${directive}\n`), /configuration|unsupported/i);
  });
}

test('the actual pinned TLC and implementation controls maintain fresh evidence and reject policy swaps', async t => {
  if (!process.env.AE_TLC_JAR) return t.skip('Explicit external TLC prerequisite absent; no formal result is claimed by this test.');
  const f = manifestFixture(t);
  const options = { workspace: f.root, manifestPath: f.filename, maintain: true, captureGraph: true, rationale: 'Reviewed the finite fixture model and exported-value implementation correspondence.' };
  const first = await runFormalVerification(options);
  assert.equal(first.passed, true, first.reason);
  assert.equal(first.sync.maintained, true);
  assert.equal(first.models[0].states.remaining, 0);
  for (const model of first.models) {
    assert.equal(model.graph.exploration, model.expected === 'pass' ? 'complete' : 'partial');
    const bytes = fs.readFileSync(path.join(path.dirname(first.evidencePath), model.graph.file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), model.graph.sha256);
    assert.match(bytes.toString('utf8'), /strict digraph DiskGraph/);
  }
  assert.equal(first.conformance[1].observed.detected, true);
  const confirmed = JSON.parse(fs.readFileSync(f.filename, 'utf8'));
  assert.equal(confirmed.coverage.lastSync.sourceKind, 'working-tree-bytes');

  for (const [field, kind] of [['command', 'positive'], ['negativeControl', 'negative']]) {
    const malformed = structuredClone(confirmed);
    malformed.conformance[field].push('--string-ids');
    fs.writeFileSync(f.filename, JSON.stringify(malformed));
    const malformedBytes = fs.readFileSync(f.filename, 'utf8');
    const rejected = await runFormalVerification(options);
    assert.equal(rejected.passed, false, `${kind} string IDs must not satisfy exact invariant membership`);
    assert.match(rejected.reason, new RegExp(`${kind} control`));
    assert.equal(fs.readFileSync(f.filename, 'utf8'), malformedBytes);
  }

  confirmed.conformance.command.push('--negative-control');
  fs.writeFileSync(f.filename, JSON.stringify(confirmed));
  const swappedBytes = fs.readFileSync(f.filename, 'utf8');
  const stale = await runFormalVerification({ workspace: f.root, manifestPath: f.filename });
  assert.equal(stale.passed, false);
  assert.match(stale.reason, /changed|drift/);
  const swapped = await runFormalVerification(options);
  assert.equal(swapped.passed, false);
  assert.match(swapped.reason, /positive control/);
  assert.equal(fs.readFileSync(f.filename, 'utf8'), swappedBytes);

  confirmed.conformance.command.pop();
  fs.writeFileSync(f.filename, JSON.stringify(confirmed));
  fs.writeFileSync(path.join(f.root, 'src/new-writer.mjs'), 'export const writer = true;\n');
  const newWriter = await runFormalVerification({ workspace: f.root, manifestPath: f.filename });
  assert.equal(newWriter.passed, false);
  assert.match(newWriter.reason, /changed|drift/);
});
