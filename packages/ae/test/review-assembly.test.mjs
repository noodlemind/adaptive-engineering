import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';
import { getCorpusRoot } from '../lib/assets.mjs';
import { loadPlan } from '../lib/plan-parse.mjs';
import { reviewCoverageFacts } from '../lib/report-facts.mjs';
import { syncAssetsToTarget } from '../lib/sync.mjs';
import { mergeVSCodeSettings } from '../lib/vscode-settings.mjs';
import { initGit, writeVersionedPlan } from './helpers/cli-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = ['architecture-strategist', 'security-sentinel', 'performance-oracle', 'code-simplicity-reviewer', 'pattern-recognition-specialist'];
function fixture(t, { changed = true, copyPackage = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const packageRoot = copyPackage ? path.join(dir, 'cli') : root;
  if (copyPackage) {
    fs.mkdirSync(packageRoot);
    for (const entry of ['bin', 'lib', 'corpus', 'config', 'node_modules', 'package.json']) {
      fs.cpSync(path.join(root, entry), path.join(packageRoot, entry), { recursive: true });
    }
  }
  const ws = path.join(dir, 'product');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, '.gitignore'), '.harness/\n');
  const plan = writeVersionedPlan(ws);
  fs.writeFileSync(path.join(ws, plan), fs.readFileSync(path.join(ws, plan), 'utf8').replace('required: []', 'required: [code-review]'));
  initGit(ws);
  if (changed) fs.writeFileSync(path.join(ws, 'src/example.js'), Array.from({ length: 12 }, (_, i) => `export const value${i} = ${i};`).join('\n') + '\n');
  const cliEnv = { ...process.env, HARNESS_NO_EVENTS: '1' };
  const cli = (...args) => spawnSync(process.execPath, [path.join(packageRoot, 'bin/ae.mjs'), 'review', ...args, '--workspace', ws, '--copilot-home', path.join(dir, 'copilot'), '--harness-home', path.join(dir, 'home'), '--json'], { cwd: ws, env: cliEnv, encoding: 'utf8', timeout: 15000 });
  const prepare = (...args) => { const r = cli('prepare', '--plan', plan, '--base', 'HEAD', ...args); assert.equal(r.status, 0, r.stderr + r.stdout); return JSON.parse(r.stdout); };
  const assemble = (packet, results, extra = {}) => {
    const file = path.join(ws, '.harness/results.json');
    fs.writeFileSync(file, JSON.stringify({ packet: packet.id, results, ...extra }));
    const r = cli('assemble', '--plan', plan, '--packet', packet.id, '--file', file);
    return { ...r, value: r.stdout.trim() ? JSON.parse(r.stdout) : null };
  };
  return { dir, ws, plan, packageRoot, cliEnv, cli, prepare, assemble };
}
const FLOW_CLASSES = ['positive', 'malformed-input', 'boundary', 'dependency-failure', 'concurrency', 'old-state', 'abuse', 'cross-boundary'];
// A minimal valid ledger: every class traced as a gap through the changed file.
const ledger = () => FLOW_CLASSES.map(flow_class => ({ flow_class, entry: 'value export', input: `${flow_class} input`, path: ['src/example.js:1'], expected: 'Export the value', observed: 'Exports the value', verdict: 'gap', test: null }));
const clean = reviewer => ({ reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [], ...(reviewer === 'spec-flow-analyzer' ? { flow_ledger: ledger() } : {}) });
const finding = (fields = {}) => ({ file: './src/example.js', line: 3, title: 'Missing guard', description: 'The input is unchecked.', suggested_fix: 'Validate the input.', severity: 'P2', confidence: 0.7, autofix_class: 'manual', evidence: ['src/example.js:3'], ...fields });
function prepareDocument(f, ...files) {
  const result = f.cli('prepare', '--domain', 'document', '--base', 'HEAD', ...files.flatMap(file => ['--file', file]));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}
function assembleDocument(f, packet, results = packet.required.map(clean)) {
  const file = path.join(f.ws, '.harness/document-results.json');
  fs.writeFileSync(file, JSON.stringify({ packet: packet.id, results }));
  const result = f.cli('assemble', '--packet', packet.id, '--file', file);
  return { ...result, value: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}
function forbidReads(f, forbidden) {
  const probe = path.join(f.dir, 'read-probe.mjs');
  const log = path.join(f.dir, 'unselected-reads.log');
  fs.writeFileSync(probe, `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const forbidden = ${JSON.stringify(forbidden)};
const log = ${JSON.stringify(log)};
for (const operation of ['openSync', 'readFileSync', 'readdirSync']) {
  const original = fs[operation];
  fs[operation] = function (file, ...args) {
    const full = file instanceof URL ? fileURLToPath(file) : typeof file === 'string' || Buffer.isBuffer(file) ? path.resolve(String(file)) : null;
    if (full && (full === forbidden || full.startsWith(forbidden + path.sep))) {
      fs.appendFileSync(log, operation + ' ' + full + '\\n');
      throw new Error('Attempted to read an unselected review source');
    }
    return original.call(this, file, ...args);
  };
}
`);
  f.cliEnv.NODE_OPTIONS = [f.cliEnv.NODE_OPTIONS, `--import=${pathToFileURL(probe).href}`].filter(Boolean).join(' ');
  return () => assert.equal(fs.existsSync(log), false, fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : undefined);
}

test('CLI: review assemble refuses repeated JSON files before reading a file or plan', t => {
  const f = fixture(t);
  const noReads = forbidReads(f, path.join(f.ws, 'inputs'));
  for (const args of [
    ['--file', 'inputs/one.json', '--file', 'inputs/two.json'],
    ['--file=inputs/one.json', '--file=inputs/two.json'],
    ['--file', 'inputs/one.json', '--file=inputs/one.json'],
    ['--file', '-', '--file', 'inputs/one.json'],
  ]) {
    const result = f.cli('assemble', '--plan', 'missing-plan.md', ...args);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, 'E_USAGE');
    assert.match(result.stderr, /one JSON document/);
  }
  noReads();
});

test('CLI: review reads the verb from positional arguments rather than file names', t => {
  const f = fixture(t);
  for (const fileArgs of [['--file', 'prepare'], ['--file=prepare']]) {
    const result = f.cli(...fileArgs, 'assemble', '--dry-run');
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Review input is absent/);
    assert.equal(result.stdout, '');
  }
});

test('CLI: review prepare keeps repeated sources with spaces, equals characters and verb names', t => {
  const f = fixture(t);
  const selected = ['assemble', 'guide one=two.md'];
  for (const file of selected) fs.writeFileSync(path.join(f.ws, file), `# ${file}\n\nReview this source.\n`);
  const result = f.cli('--file', selected[0], 'prepare', '--domain', 'document', '--base', 'HEAD', `--file=${selected[1]}`);
  assert.equal(result.status, 0, result.stderr);
  const packet = JSON.parse(result.stdout);
  assert.deepEqual(packet.scope.files.map(ref => ref.path), selected);
  assert.deepEqual(packet.preparation.files.map(ref => ref.path), selected);
});

test('CLI: review rejects extra and post-boundary file operands', t => {
  const f = fixture(t);
  for (const args of [
    ['assemble', '--file', 'missing.json', 'extra.json'],
    ['assemble', '--', '--file=missing.json'],
    ['--', 'prepare'],
  ]) {
    const result = f.cli(...args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /unexpected argument|requires prepare.*assemble/);
  }
});
test('prepare owns mandatory coverage and brace/comma/glob discovery', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.ws, '.github/checks'), { recursive: true });
  fs.writeFileSync(path.join(f.ws, '.github/checks/api.md'), '---\nname: api-contract\nglobs: "{src,lib}/**/*.js,api/**"\nseverity-default: P2\n---\nRead public contracts.\n');
  fs.writeFileSync(path.join(f.ws, '.github/checks/sql.md'), '---\nname: sql-contract\nglobs: "**/*.sql"\n---\nRead SQL.\n');
  const packet = f.prepare();
  assert.equal(packet.version, 2);
  assert.ok(packet.required.includes('code-simplicity-reviewer'));
  for (const name of baseline.filter(id => id !== 'code-simplicity-reviewer')) assert.equal(packet.required.includes(name), false, name);
  assert.ok(packet.required.includes('api-contract'));
  assert.ok(!packet.required.includes('sql-contract'));
  assert.equal(packet.preparation.checks.find(c => c.name === 'api-contract').matched, true);
  assert.equal(packet.preparation.coverage.totalFiles, packet.scope.changedFiles.length);
  assert.equal(f.prepare().id, packet.id);
});

test('the review budget grows for a large diff, a real boundary, and one language', t => {
  const large = fixture(t);
  for (let i = 0; i < 8; i += 1) fs.writeFileSync(path.join(large.ws, `src/extra-${i}.js`), `export const extra${i} = ${i};\n`);
  const largePacket = large.prepare();
  for (const name of ['spec-flow-analyzer', 'security-sentinel', 'architecture-strategist']) assert.ok(largePacket.required.includes(name), name);
  // A large diff spends the cap on correctness, security and architecture; simplicity yields.
  assert.equal(largePacket.required.includes('code-simplicity-reviewer'), false);
  assert.equal(largePacket.required.includes('performance-oracle'), false);
  const boundary = fixture(t);
  fs.mkdirSync(path.join(boundary.ws, 'src/auth'), { recursive: true });
  fs.writeFileSync(path.join(boundary.ws, 'src/auth/session.js'), 'export const session = true;\n');
  const boundaryPacket = boundary.prepare();
  assert.ok(boundaryPacket.required.includes('security-sentinel'));
  assert.equal(boundaryPacket.required.includes('architecture-strategist'), false);
  const java = fixture(t, { changed: false });
  fs.writeFileSync(path.join(java.ws, 'src/Order.java'), 'public record Order() {}\n');
  const javaPacket = java.prepare();
  assert.ok(javaPacket.required.includes('java-reviewer'));
  assert.ok(javaPacket.required.includes('spec-flow-analyzer'));
  assert.ok(javaPacket.required.length <= 3);
  assert.equal(javaPacket.required.includes('python-reviewer'), false);
  assert.ok(javaPacket.required.filter(id => id.endsWith('reviewer') || id.endsWith('strategist') || id.endsWith('sentinel')).length <= 3);
});

test('a checks README without frontmatter is documentation; malformed declared checks still block', t => {
  const f = fixture(t);
  const directory = path.join(f.ws, '.github/checks');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'README.md'), '# Review checks\n\nHow to author product checks.\n');
  const packet = f.prepare();
  assert.deepEqual(packet.preparation.failures, []);
  assert.equal(f.assemble(packet, packet.required.map(clean)).status, 0);
  fs.writeFileSync(path.join(directory, 'README.md'), '---\nname: invalid name\n---\nDeclared check.\n');
  const malformed = f.prepare();
  assert.ok(malformed.preparation.failures.some(message => /valid name/.test(message)));
  assert.equal(f.assemble(malformed, malformed.required.map(clean)).status, 1);
});

test('assembly is invariant to result order, gates before boosting and only merges exact identities', t => {
  const f = fixture(t), packet = f.prepare('--reviewer', 'security-sentinel');
  const results = packet.required.map(clean);
  results[0].findings = [finding(), finding({ line: 5 }), finding({ title: 'Weak', confidence: 0.55 }), finding({ title: 'Critical uncertainty', severity: 'P1', confidence: 0.5 })];
  results[1].findings = [finding({ file: 'src\\example.js', confidence: 0.8, evidence: ['Second observation'] }), finding({ title: 'Weak', confidence: 0.55 })];
  const first = f.assemble(packet, results);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const shuffled = f.assemble(packet, results.toReversed().map(r => ({ ...r, findings: r.findings.toReversed() })));
  assert.equal(shuffled.status, 0, shuffled.stderr + shuffled.stdout);
  assert.equal(first.value.id, shuffled.value.id);
  assert.equal(first.value.report, shuffled.value.report);
  assert.equal(first.value.findings.length, 3);
  assert.equal(first.value.suppressed.length, 2);
  const merged = first.value.findings.find(f => f.title === 'Missing guard' && f.line === 3);
  assert.equal(merged.confidence, 0.9);
  assert.deepEqual(merged.originalConfidences, [0.7, 0.8]);
  assert.equal(merged.provenance.kind, 'unknown');
  assert.equal(first.value.overlaps.length, 1);
  assert.equal(first.value.coverage.complete, true);
  assert.equal(first.value.counts.P1, 1);
});

test('missing, timed-out and malformed results remain failed coverage with retrievable raw evidence', t => {
  const f = fixture(t), packet = f.prepare('--reviewer', 'security-sentinel', '--reviewer', 'architecture-strategist');
  const results = packet.required.map(clean);
  results[0].status = 'timed-out';
  results[1].findings = [finding({ line: 1000 })];
  results.pop();
  const assembled = f.assemble(packet, results);
  assert.equal(assembled.status, 1);
  assert.equal(assembled.value.coverage.complete, false);
  assert.ok(assembled.value.failures.some(f => f.errors.some(e => /outside the file/.test(e))));
  assert.ok(assembled.value.report.includes('Incomplete'));
  const raw = JSON.parse(fs.readFileSync(path.join(f.ws, assembled.value.recordPath), 'utf8'));
  assert.equal(raw.results.find(r => r.raw.status === 'timed-out').raw.status, 'timed-out');
});

test('check definition drift invalidates captured review obligations', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.ws, '.github/checks'), { recursive: true });
  const file = path.join(f.ws, '.github/checks/all.md');
  fs.writeFileSync(file, '---\nname: product-review\n---\nReview inputs.\n');
  const packet = f.prepare();
  fs.appendFileSync(file, 'Review new behavior.\n');
  const output = f.assemble(packet, packet.required.map(clean));
  assert.notEqual(output.status, 0);
  assert.match(output.stderr + output.stdout, /stale|changed/);
});

test('standalone document review uses the same collection and factual report contracts', t => {
  const f = fixture(t);
  const prepared = f.cli('prepare', '--domain', 'document', '--file', f.plan, '--base', 'HEAD');
  assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
  const packet = JSON.parse(prepared.stdout);
  assert.deepEqual(packet.required, ['coherence', 'design', 'feasibility', 'scope']);
  const file = path.join(f.ws, '.harness/document-results.json');
  fs.writeFileSync(file, JSON.stringify({ packet: packet.id, results: packet.required.map(clean) }));
  const result = f.cli('assemble', '--packet', packet.id, '--file', file);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).coverage.complete, true);
});

for (const workspaceCase of ['clean checkout', 'plain untracked directory', 'nested Git checkout']) {
  test(`explicit standalone document review prepares and assembles with a ${workspaceCase}`, t => {
    const f = fixture(t, { changed: false });
    let assertNoReads = () => {};
    if (workspaceCase !== 'clean checkout') {
      const unrelated = path.join(f.ws, 'unrelated');
      fs.mkdirSync(unrelated);
      if (workspaceCase === 'nested Git checkout') initGit(unrelated);
      fs.writeFileSync(path.join(unrelated, 'private.md'), '# Unselected private draft\n');
      if (workspaceCase === 'nested Git checkout') assertNoReads = forbidReads(f, unrelated);
    }
    const packet = prepareDocument(f, f.plan);
    const result = assembleDocument(f, packet);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(result.value.coverage.complete, true);
    assert.equal(result.value.plan, null);
    assert.deepEqual(result.value.required, ['coherence', 'design', 'feasibility', 'scope']);
    assertNoReads();
  });
}

test('explicit standalone document scope binds only the selected source bytes', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.ws, 'selected.md'), '# Selected companion\n\nReview this too.\n');
  fs.writeFileSync(path.join(f.ws, 'unselected.md'), '# Private unrelated draft\n');
  const selected = [f.plan, 'selected.md'].sort();
  const packet = prepareDocument(f, ...selected);
  assert.deepEqual(packet.scope.files?.map(ref => ref.path), selected);
  assert.deepEqual(packet.preparation.refs.map(ref => ref.path), selected);
  assert.deepEqual(packet.preparation.files.map(ref => ref.path), selected);
  assert.equal(packet.preparation.coverage.totalFiles, selected.length);
  for (const ref of packet.preparation.refs) {
    assert.equal(ref.state, 'regular');
    assert.equal(ref.sha256, createHash('sha256').update(fs.readFileSync(path.join(f.ws, ref.path))).digest('hex'));
  }
  assert.deepEqual(packet.scope.files, packet.preparation.refs);
  assert.ok(!JSON.stringify(packet).includes('unselected.md'));
  assert.ok(!packet.preparation.diff?.includes('src/example.js'));
  assert.equal(assembleDocument(f, packet).status, 0);
});

test('unrelated changes after standalone document preparation do not stale the selected review', t => {
  const f = fixture(t, { changed: false });
  const packet = prepareDocument(f, f.plan);
  fs.appendFileSync(path.join(f.ws, 'src/example.js'), 'export const unrelated = true;\n');
  fs.writeFileSync(path.join(f.ws, 'unrelated.md'), '# Unrelated new document\n');
  const nested = path.join(f.ws, 'unrelated-checkout');
  fs.mkdirSync(nested);
  initGit(nested);
  const result = assembleDocument(f, packet);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.value.coverage.complete, true);
  assert.deepEqual(result.value.scope, packet.scope);
});

test('selected document changes still stale standalone review assembly', t => {
  const f = fixture(t, { changed: false });
  const packet = prepareDocument(f, f.plan);
  fs.appendFileSync(path.join(f.ws, f.plan), '\nSelected content changed.\n');
  const result = assembleDocument(f, packet);
  assert.equal(result.status, 2);
  assert.match(result.stderr + result.stdout, /stale|changed/i);
});

for (const sourceCase of ['missing', 'directory', 'symlink', 'outside workspace']) {
  test(`explicit standalone document preparation rejects a selected ${sourceCase} source`, t => {
    const f = fixture(t, { changed: false });
    let selected = 'selected.md';
    if (sourceCase === 'directory') fs.mkdirSync(path.join(f.ws, selected));
    if (sourceCase === 'symlink') {
      try { fs.symlinkSync(path.join(f.ws, f.plan), path.join(f.ws, selected)); }
      catch (error) { if (error.code === 'EPERM') return t.skip('Symlink creation requires OS permission'); throw error; }
    }
    if (sourceCase === 'outside workspace') {
      selected = path.join(f.dir, 'outside.md');
      fs.writeFileSync(selected, '# Outside the project\n');
    }
    const result = f.cli('prepare', '--domain', 'document', '--file', selected, '--base', 'HEAD');
    assert.notEqual(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stderr + result.stdout, /missing|unreadable|unsafe|regular|inside the workspace|current project/i);
  });
}

test('selected document preparation rejects a symlink ancestor before reading source content', t => {
  const f = fixture(t, { changed: false });
  fs.mkdirSync(path.join(f.ws, 'real'));
  fs.writeFileSync(path.join(f.ws, 'real/doc.md'), '# Selected document\n');
  const alias = path.join(f.ws, 'alias');
  try { fs.symlinkSync('real', alias, 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Symlink creation requires OS permission'); throw error; }
  const assertNoReads = forbidReads(f, alias);
  const result = f.cli('prepare', '--domain', 'document', '--file', 'alias/doc.md', '--base', 'HEAD');
  assertNoReads();
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr + result.stdout, /symlink|unsafe|regular|unreadable/i);
});

test('selected document assembly rejects a replaced symlink ancestor before reading source content', t => {
  const f = fixture(t, { changed: false });
  const selected = path.join(f.ws, 'selected');
  fs.mkdirSync(selected);
  fs.writeFileSync(path.join(selected, 'doc.md'), '# Selected document\n');
  const packet = prepareDocument(f, 'selected/doc.md');
  fs.renameSync(selected, path.join(f.ws, 'real'));
  try { fs.symlinkSync('real', selected, 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Symlink creation requires OS permission'); throw error; }
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(selected, 'doc.md'))).digest('hex'), packet.scope.files[0].sha256);
  const assertNoReads = forbidReads(f, selected);
  const result = assembleDocument(f, packet);
  assertNoReads();
  assert.equal(result.status, 2, result.stderr + result.stdout);
  assert.match(result.stderr + result.stdout, /stale|changed/i);
});

test('explicit standalone document preparation rejects a selected unreadable source', t => {
  const f = fixture(t, { changed: false });
  const selected = path.join(f.ws, 'unreadable.md');
  fs.writeFileSync(selected, '# Unreadable document\n');
  fs.chmodSync(selected, 0);
  t.after(() => { if (fs.existsSync(selected)) fs.chmodSync(selected, 0o600); });
  try {
    fs.readFileSync(selected);
    return t.skip('The current user can still read permission-denied files');
  } catch (error) { assert.ok(['EACCES', 'EPERM'].includes(error.code), error.message); }
  const result = f.cli('prepare', '--domain', 'document', '--file', 'unreadable.md', '--base', 'HEAD');
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr + result.stdout, /unreadable|unsafe|regular|permission|denied/i);
});

test('document review definition drift still stales a standalone packet', t => {
  const f = fixture(t, { changed: false, copyPackage: true });
  const packet = prepareDocument(f, f.plan);
  fs.appendFileSync(path.join(f.packageRoot, 'corpus/skills/document-review/references/review-criteria.md'), '\nNew review obligation.\n');
  const result = assembleDocument(f, packet);
  assert.equal(result.status, 2);
  assert.match(result.stderr + result.stdout, /stale|changed/i);
});

test('governing policy drift still stales a standalone document packet', t => {
  const f = fixture(t, { changed: false });
  const packet = prepareDocument(f, f.plan);
  fs.writeFileSync(path.join(f.ws, '.github/harness/policy.yaml'), 'enforcement: enforce\n');
  const result = assembleDocument(f, packet);
  assert.equal(result.status, 2);
  assert.match(result.stderr + result.stdout, /stale|changed/i);
});

test('standalone document findings cannot report an unselected readable document', t => {
  const f = fixture(t, { changed: false });
  fs.writeFileSync(path.join(f.ws, 'unselected.md'), '# Unselected document\n\nPrivate draft content.\n');
  const packet = prepareDocument(f, f.plan);
  const assertNoReads = forbidReads(f, path.join(f.ws, 'unselected.md'));
  const results = packet.required.map(clean);
  results[0].findings = [finding({ file: 'unselected.md', line: 1, title: 'Unselected finding', evidence: ['unselected.md:1'] })];
  const result = assembleDocument(f, packet, results);
  assertNoReads();
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.equal(result.value.coverage.complete, false);
  assert.deepEqual(result.value.findings, []);
  assert.match(result.value.failures.flatMap(failure => failure.errors).join('\n'), /selected|scope/i);
  assert.ok(!result.value.report.includes('Unselected finding'));
});

test('ambiguous overlaps change only through explicit, recorded adjudication', t => {
  const f = fixture(t), packet = f.prepare(), results = packet.required.map(clean);
  results[0].findings = [finding(), finding({ line: 5 })];
  const original = f.assemble(packet, results).value;
  const members = original.overlaps[0].members;
  const retained = f.assemble(packet, results, { adjudications: [{ action: 'retain', members, rationale: 'These are distinct guard boundaries.' }] }).value;
  assert.equal(retained.findings.length, 2);
  const merged = f.assemble(packet, results, { adjudications: [{ action: 'merge', members, rationale: 'Both report one unchecked input.' }] }).value;
  assert.equal(merged.findings.length, 1);
  assert.equal(merged.adjudications[0].rationale, 'Both report one unchecked input.');
  assert.equal(f.assemble(packet, results, { adjudications: [{ action: 'merge', members: [...members, 'missing'], rationale: 'Invalid input' }] }).status, 1);
});

test('dry runs leave stored review coverage untouched', t => {
  const f = fixture(t);
  const output = f.cli('prepare', '--plan', f.plan, '--base', 'HEAD', '--dry-run');
  assert.equal(output.status, 0, output.stderr);
  const proposed = JSON.parse(output.stdout);
  assert.equal(proposed.persisted, false);
  assert.equal(fs.existsSync(path.join(f.ws, proposed.packetPath)), false);
  const packet = f.prepare(), file = path.join(f.ws, '.harness/dry-results.json');
  fs.writeFileSync(file, JSON.stringify({ packet: packet.id, results: packet.required.map(clean) }));
  const assembled = f.cli('assemble', '--plan', f.plan, '--packet', packet.id, '--file', file, '--dry-run');
  assert.equal(assembled.status, 0, assembled.stderr);
  assert.equal(JSON.parse(assembled.stdout).persisted, false);
  assert.equal(fs.existsSync(path.join(f.ws, '.harness/reviews/latest')), false);
});

test('packet excerpts and report rows are bounded with full evidence references', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const longValue = 1;\n'.repeat(300));
  const packet = f.prepare('--max-bytes', '1024');
  assert.ok(packet.preparation.coverage.excerptBytes <= 1024);
  assert.ok(packet.preparation.files.some(file => file.truncated));
  const results = packet.required.map(clean);
  results[0].findings = Array.from({ length: 150 }, (_, i) => finding({ line: i + 1, title: `Guard ${i} ${'x'.repeat(100)}` }));
  const record = f.assemble(packet, results).value;
  assert.ok(Buffer.byteLength(record.report) <= 16384);
  assert.ok(record.reportOmittedRows > 0);
  const full = JSON.parse(fs.readFileSync(path.join(f.ws, record.recordPath), 'utf8'));
  assert.equal(full.findings.length, 150);
});

test('a product check cannot replace a mandatory perspective by reusing its name', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.ws, '.github/checks'), { recursive: true });
  fs.writeFileSync(path.join(f.ws, '.github/checks/shadow.md'), '---\nname: security-sentinel\n---\nCheck one token.\n');
  const packet = f.prepare();
  const output = f.assemble(packet, packet.required.map(clean));
  assert.equal(output.status, 1);
  assert.ok(output.value.failures.some(f => f.errors.some(e => /collid/i.test(e))));
});

test('a newly applicable check makes the frozen packet stale', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.ws, '.gitignore'), '.github/checks/\n');
  const packet = f.prepare();
  fs.mkdirSync(path.join(f.ws, '.github/checks'), { recursive: true });
  fs.writeFileSync(path.join(f.ws, '.github/checks/new.md'), '---\nname: new-coverage\n---\nReview the new obligation.\n');
  const result = f.assemble(packet, packet.required.map(clean));
  assert.equal(result.status, 2);
  assert.match(result.stderr + result.stdout, /stale|changed/);
});

test('document review cannot fulfill a plan requiring code review', t => {
  const f = fixture(t);
  const output = f.cli('prepare', '--plan', f.plan, '--domain', 'document', '--base', 'HEAD');
  assert.equal(output.status, 2);
  assert.match(output.stderr + output.stdout, /code.review|document/i);
});

test('selecting packet excerpts cannot omit checks for the delivery scope', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.ws, '.github/checks'), { recursive: true });
  fs.writeFileSync(path.join(f.ws, '.github/checks/sql.md'), '---\nname: sql-contract\nglobs: "**/*.sql"\n---\nReview SQL.\n');
  fs.writeFileSync(path.join(f.ws, 'migration.sql'), 'DELETE FROM accounts;\n');
  const packet = f.prepare('--file', 'src/example.js');
  assert.ok(packet.required.includes('sql-contract'));
  assert.ok(packet.preparation.refs.some(ref => ref.path === 'migration.sql'));
  const assembled = f.assemble(packet, packet.required.filter(id => id !== 'sql-contract').map(clean));
  assert.equal(assembled.status, 1);
  assert.deepEqual(assembled.value.coverage.missing, ['sql-contract']);
});

test('ignored documents above the excerpt read limit still bind their actual bytes', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.ws, '.gitignore'), 'large.md\n');
  fs.writeFileSync(path.join(f.ws, 'large.md'), 'a'.repeat(1024 * 1024 + 1));
  const output = f.cli('prepare', '--domain', 'document', '--file', 'large.md', '--base', 'HEAD');
  assert.equal(output.status, 0, output.stderr + output.stdout);
  const packet = JSON.parse(output.stdout);
  fs.writeFileSync(path.join(f.ws, 'large.md'), 'b'.repeat(1024 * 1024 + 1));
  const input = path.join(f.ws, '.harness/large-results.json');
  fs.writeFileSync(input, JSON.stringify({ packet: packet.id, results: packet.required.map(clean) }));
  const assembled = f.cli('assemble', '--packet', packet.id, '--file', input);
  assert.equal(assembled.status, 2);
  assert.match(assembled.stderr + assembled.stdout, /stale|changed/);
});

test('different claims at the same location remain distinct pending judgment', t => {
  const f = fixture(t), packet = f.prepare('--reviewer', 'security-sentinel'), results = packet.required.map(clean);
  results[0].findings = [finding()];
  results[1].findings = [finding({ description: 'The caller can bypass account authorization.', suggested_fix: 'Check account ownership.' })];
  const record = f.assemble(packet, results).value;
  assert.equal(record.findings.length, 2);
  assert.deepEqual(record.findings.map(f => f.description).sort(), ['The caller can bypass account authorization.', 'The input is unchecked.']);
  assert.equal(record.overlaps.length, 1);
});

test('compatible overlapping retain decisions work in either order', t => {
  const f = fixture(t), packet = f.prepare(), results = packet.required.map(clean);
  results[0].findings = [finding({ line: 1 }), finding({ line: 3 }), finding({ line: 5 })];
  const original = f.assemble(packet, results).value;
  const adjudications = original.overlaps.map(candidate => ({ action: 'retain', members: candidate.members, rationale: 'Each is a separate input boundary.' }));
  const a = f.assemble(packet, results, { adjudications });
  const b = f.assemble(packet, results, { adjudications: adjudications.toReversed() });
  assert.equal(a.status, 0, a.stderr + a.stdout);
  assert.equal(b.status, 0, b.stderr + b.stdout);
  assert.equal(a.value.id, b.value.id);
  assert.equal(a.value.findings.length, 3);
  assert.equal(a.value.overlaps.length, 0);
});

test('actionable overlaps refer to surviving findings after a merge', t => {
  const f = fixture(t), packet = f.prepare(), results = packet.required.map(clean);
  results[0].findings = [finding(), finding({ line: 5 })];
  const original = f.assemble(packet, results).value;
  const merged = f.assemble(packet, results, { adjudications: [{ action: 'merge', members: original.overlaps[0].members, rationale: 'Both describe one guard.' }] }).value;
  const ids = new Set(merged.findings.map(f => f.id));
  assert.ok(merged.overlaps.every(candidate => candidate.members.every(id => ids.has(id))));
  assert.equal(merged.overlaps.length, 0);
});

test('a surviving overlap accepts a follow-up judgment referencing a prior merge', t => {
  const f = fixture(t), packet = f.prepare(), results = packet.required.map(clean);
  results[0].findings = [finding({ line: 1 }), finding({ line: 3 }), finding({ line: 5 })];
  const original = f.assemble(packet, results).value;
  const first = { action: 'merge', members: original.overlaps[0].members, rationale: 'One guard is reported twice.' };
  const merged = f.assemble(packet, results, { adjudications: [first] }).value;
  assert.equal(merged.findings.length, 2);
  assert.equal(merged.overlaps.length, 1);
  const second = { action: 'retain', members: merged.overlaps[0].members, rationale: 'The remaining guard is independent.' };
  const a = f.assemble(packet, results, { adjudications: [first, second] });
  const b = f.assemble(packet, results, { adjudications: [second, first] });
  assert.equal(a.status, 0, a.stderr + a.stdout);
  assert.equal(a.value.id, b.value.id);
  assert.equal(a.value.findings.length, 2);
  assert.equal(a.value.overlaps.length, 0);
});

const REVIEW_SPECIALISTS = ['code-simplicity-reviewer', 'pattern-recognition-specialist', 'compounding-typescript-reviewer', 'data-integrity-guardian', 'spec-flow-analyzer'];

function frontmatter(text) {
  return YAML.parse(text.match(/^---\n([\s\S]*?)\n---/)[1]);
}

test('installed host profiles let the engineer invoke the review specialists', () => {
  const corpus = getCorpusRoot();
  const engineer = frontmatter(fs.readFileSync(path.join(corpus, 'agents/engineer.agent.md'), 'utf8'));
  const coordinator = frontmatter(fs.readFileSync(path.join(corpus, 'agents/code-review-coordinator.agent.md'), 'utf8'));
  const registry = YAML.parse(fs.readFileSync(path.join(corpus, 'knowledge/capability-registry.yaml'), 'utf8'));
  assert.ok(engineer.tools.includes('agent'));
  assert.ok(coordinator.tools.includes('agent'));
  for (const id of REVIEW_SPECIALISTS) {
    assert.ok(engineer.agents.includes(id), `engineer cannot invoke ${id}`);
    assert.ok(coordinator.agents.includes(id), `coordinator cannot invoke ${id}`);
  }
  assert.deepEqual([...engineer.agents].sort(), [...registry.engineer_allowlist].sort());
  assert.equal(mergeVSCodeSettings({})['chat.subagents.allowInvocationsFromSubagents'], true);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-hosts-'));
  try {
    for (const host of ['vscode', 'cli', 'intellij']) {
      const home = path.join(rootDir, host);
      fs.mkdirSync(home);
      syncAssetsToTarget(corpus, home, { dryRun: false, verbose: false }, () => {});
      const installed = frontmatter(fs.readFileSync(path.join(home, 'agents/engineer.agent.md'), 'utf8'));
      for (const id of REVIEW_SPECIALISTS) assert.ok(installed.agents.includes(id), `${host} engineer cannot invoke ${id}`);
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

function separate(reviewer, via) {
  return { ...clean(reviewer), provenance: { kind: 'host-invocation', agent: reviewer, via } };
}

function coverageIdentity(f) {
  const plan = loadPlan(f.ws, f.plan);
  return reviewCoverageFacts({ workspace: f.ws, plan, copilotHome: path.join(f.dir, 'copilot') });
}

test('a direct specialist invocation counts as a separate review', t => {
  const f = fixture(t);
  const packet = f.prepare();
  const assembled = f.assemble(packet, packet.required.map(reviewer => separate(reviewer, 'engineer')));
  assert.equal(assembled.status, 0, assembled.stderr + assembled.stdout);
  assert.equal(assembled.value.coverage.complete, true);
  assert.ok(assembled.value.results.every(result => result.provenance.independence === 'separate-reviewer' && result.provenance.via === 'engineer' && result.provenance.agent === result.reviewer));
  const facts = coverageIdentity(f);
  assert.equal(facts.pass, true, facts.message);
  assert.equal(facts.invocationIdentity, 'separate-reviewer');
});

test('a coordinator specialist invocation counts as a separate review', t => {
  const f = fixture(t);
  const packet = f.prepare();
  const assembled = f.assemble(packet, packet.required.map(reviewer => separate(reviewer, 'code-review-coordinator')));
  assert.equal(assembled.status, 0, assembled.stderr + assembled.stdout);
  assert.equal(assembled.value.coverage.complete, true);
  assert.ok(assembled.value.results.every(result => result.provenance.independence === 'separate-reviewer' && result.provenance.via === 'code-review-coordinator' && result.provenance.agent === result.reviewer));
  assert.match(assembled.value.report, /Recorded invocations name a separate reviewer/);
  const facts = coverageIdentity(f);
  assert.equal(facts.pass, true, facts.message);
  assert.equal(facts.invocationIdentity, 'separate-reviewer');
});

test('the coordinator output example records the required invocation provenance', t => {
  const f = fixture(t), packet = f.prepare();
  const instructions = fs.readFileSync(path.join(root, 'corpus/agents/code-review-coordinator.agent.md'), 'utf8');
  const example = instructions.match(/Return `([^`]+)`\./)?.[1];
  assert.ok(example);
  const results = packet.required.map(reviewer => JSON.parse(example.replaceAll('<supplied id>', packet.id).replaceAll('<required id>', reviewer)).results[0])
    .map(result => result.reviewer === 'spec-flow-analyzer' ? { ...result, flow_ledger: ledger() } : result);
  assert.match(instructions, /flow_ledger/);
  const assembled = f.assemble(packet, results);
  assert.equal(assembled.status, 0, assembled.stderr + assembled.stdout);
  const facts = coverageIdentity(f);
  assert.equal(facts.pass, true, facts.message);
  assert.equal(facts.invocationIdentity, 'separate-reviewer');
});

test('an engineer self-review is not an independent review', t => {
  const f = fixture(t);
  const packet = f.prepare('--reviewer', 'security-sentinel', '--reviewer', 'architecture-strategist');
  const results = packet.required.map(clean);
  results[0].provenance = { kind: 'same-context', agent: 'engineer' };
  results[1].provenance = { kind: 'host-invocation', agent: 'engineer', via: 'engineer' };
  const assembled = f.assemble(packet, results);
  assert.equal(assembled.status, 0, assembled.stderr + assembled.stdout);
  assert.equal(assembled.value.coverage.complete, true);
  const recorded = new Map(assembled.value.results.map(result => [result.reviewer, result.provenance]));
  assert.equal(recorded.get(results[0].reviewer).independence, 'rejected');
  assert.equal(recorded.get(results[1].reviewer).independence, 'rejected');
  assert.equal(recorded.get(results[2].reviewer).independence, 'unverified');
  assert.match(assembled.value.report, /self-review is not an independent review/);
  const facts = coverageIdentity(f);
  assert.equal(facts.pass, true, facts.message);
  assert.equal(facts.invocationIdentity, 'rejected');
});

test('contradictory adjudications block coverage without silently deleting findings', t => {
  const f = fixture(t), packet = f.prepare(), results = packet.required.map(clean);
  results[0].findings = [finding(), finding({ line: 5 })];
  const members = f.assemble(packet, results).value.overlaps[0].members;
  const adjudications = ['merge', 'retain'].map(action => ({ action, members, rationale: 'Conflicting judgments.' }));
  const a = f.assemble(packet, results, { adjudications });
  const b = f.assemble(packet, results, { adjudications: adjudications.toReversed() });
  assert.equal(a.status, 1);
  assert.equal(a.value.id, b.value.id);
  assert.equal(a.value.findings.length, 2);
  assert.ok(a.value.failures.some(f => f.errors.includes('Conflicting merge and retain adjudications')));
});

test('the code packet binds reverse dependents, and a changed dependent makes the packet stale', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.ws, 'src/dep.js'), "import { value0 } from './example.js';\nexport const dep = value0;\n");
  spawnSync('git', ['add', 'src/dep.js'], { cwd: f.ws });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'dep', '--', 'src/dep.js'], { cwd: f.ws });
  const packet = f.prepare();
  const impact = packet.preparation.impact;
  assert.equal(impact.schema, 'review-impact-v1');
  const seed = impact.seeds.find(s => s.file === 'src/example.js');
  assert.ok(seed, JSON.stringify(impact));
  assert.deepEqual(seed.dependents.map(d => d.file), ['src/dep.js']);
  assert.equal(f.assemble(packet, packet.required.map(clean)).status, 0);
  fs.appendFileSync(path.join(f.ws, 'src/dep.js'), 'export const later = 1;\n');
  const stale = f.assemble(packet, packet.required.map(clean));
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr + stale.stdout, /stale|changed/);
});

test('a diff with no source file needs no flow ledger, but a supplied ledger is still checked', t => {
  const f = fixture(t, { changed: false });
  fs.appendFileSync(path.join(f.ws, f.plan), '\nA clarifying note.\n');
  const packet = f.prepare();
  assert.ok(packet.required.includes('spec-flow-analyzer'));
  assert.ok(packet.scope.changedFiles.every(file => file.endsWith('.md')), JSON.stringify(packet.scope.changedFiles));
  const bare = packet.required.map(reviewer => ({ reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [] }));
  const accepted = f.assemble(packet, bare);
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
  const malformed = bare.map(r => r.reviewer === 'spec-flow-analyzer' ? { ...r, flow_ledger: [] } : r);
  assert.equal(f.assemble(packet, malformed).status, 1);
});

test('assembly loads recorded finding verifications through the CLI and refuses one without a receipt', t => {
  const f = fixture(t), packet = f.prepare();
  const results = packet.required.map(clean);
  results[0].findings = [finding()];
  const first = f.assemble(packet, results).value;
  const id = first.findings[0].id;
  const output = f.assemble(packet, results, { verifications: [{ finding: id, request: '1'.repeat(64) }] });
  assert.equal(output.status, 1);
  assert.ok(output.value.failures.some(entry => entry.errors.some(e => /no recorded decision-agent receipt/.test(e))), output.stdout);
});
