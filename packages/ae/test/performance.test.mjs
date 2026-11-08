import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import YAML from 'yaml';
import { analyzePerformance, performanceContext, performanceContextIsCurrent, DEFAULT_PERFORMANCE_PROFILE } from '../lib/performance.mjs';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const hash = value => createHash('sha256').update(value).digest('hex');

function git(root, ...args) {
  // Allow process startup variance in parallel Windows CI fixture setup.
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, JSON.stringify({ command: ['git', ...args], cwd: root,
    error: result.error ? { code: result.error.code, message: result.error.message } : null,
    signal: result.signal, stdout: result.stdout?.slice(-4096), stderr: result.stderr?.slice(-4096) }));
  return result.stdout.trim();
}

function repository(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Performance Test');
  git(root, 'config', 'user.email', 'performance@example.invalid');
  fs.writeFileSync(path.join(root, 'initial.txt'), 'Initial repository\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Initial repository');
  return root;
}

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'performance-core-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = repository(path.join(dir, 'product'));
  const home = path.join(dir, 'home');
  const write = (relative, content, root = workspace) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content));
    return full;
  };
  write('src/start.mjs', "import { finish } from './finish.mjs';\nexport function start() { return finish(); }\n");
  write('src/finish.mjs', 'export function finish() { return true; }\n');
  write('package.json', { dependencies: { slow: '1.0.0' } });
  write('design.md', 'Complete when the response is accepted.\n');
  const profile = {
    version: 1,
    sources: [
      { id: 'start-source', repo: 'self', path: 'src/start.mjs', kind: 'code' },
      { id: 'finish-source', repo: 'self', path: 'src/finish.mjs', kind: 'code' },
      { id: 'package-source', repo: 'self', path: 'package.json', kind: 'manifest' },
      { id: 'design-source', repo: 'self', path: 'design.md', kind: 'design' },
      { id: 'measurement', repo: 'self', path: 'measurements.json', kind: 'evidence' },
    ],
    nodes: [
      { id: 'start', label: 'Start request', kind: 'operation', sources: ['start-source', 'package-source'] },
      { id: 'finish', label: 'Accept response', kind: 'service', sources: ['finish-source'] },
    ],
    edges: [{ id: 'response', from: 'start', to: 'finish', mode: 'sync', sources: ['design-source'] }],
    journeys: [{ id: 'request', title: 'Accept a request', entry: 'start', completion: 'finish', nodes: ['start', 'finish'], environment: 'test', workload: 'one request', maxAgeSeconds: 3600,
      goals: [{ metric: 'latency', statistic: 'p95', unit: 'ms', basis: 'accepted response', target: 100 }],
      constraints: [{ id: 'completion', text: 'Return only after acceptance.', sources: ['design-source'] }],
    }],
    rules: [],
    observations: ['measurement'],
  };
  const save = () => write(DEFAULT_PERFORMANCE_PROFILE, profile);
  const observation = (overrides = {}) => ({
    version: 1, provenance: { kind: 'synthetic', description: 'Synthetic fixture measurement' },
    capturedAt: '2026-10-15T11:55:00.000Z', environment: 'test', workload: 'one request',
    sourceHashes: Object.fromEntries(profile.sources.filter(s => s.kind !== 'evidence').map(s => [s.id, hash(fs.readFileSync(path.join(s.repo === 'self' ? workspace : path.join(dir, s.repo), s.path)))])),
    metrics: [{ journey: 'request', metric: 'latency', statistic: 'p95', unit: 'ms', basis: 'accepted response', value: 80, samples: 40 }],
    ...overrides,
  });
  const measure = (value = observation()) => write('measurements.json', value);
  const analyze = () => analyzePerformance({ workspace, home, now: NOW });
  measure();
  save();
  return { dir, workspace, home, profile, write, save, observation, measure, analyze };
}

const goal = (report, metric = 'latency') => report.journeys[0].goals.find(g => g.metric === metric);

test('reports bind live selected bytes and distinguish all four goals without scanning a cached graph', t => {
  const f = fixture(t);
  f.write('.harness/repo-map/index.json', '{"invented":"cached-symbol"}');
  const report = f.analyze();
  assert.match(report.id, /^[a-f0-9]{64}$/);
  assert.equal(report.profile.sha256, hash(fs.readFileSync(path.join(f.workspace, DEFAULT_PERFORMANCE_PROFILE))));
  assert.equal(report.inputs.sources.find(s => s.id === 'start-source').sha256, hash(fs.readFileSync(path.join(f.workspace, 'src/start.mjs'))));
  assert.deepEqual(report.journeys[0].goals.map(g => [g.metric, g.status]), [['latency', 'met'], ['reliability', 'unknown'], ['throughput', 'unknown'], ['cost', 'unknown']]);
  assert.ok(report.implementation.nodes.find(n => n.id === 'start-source').symbols.includes('start'));
  assert.ok(report.implementation.edges.some(e => e.from === 'start-source' && e.to === 'finish-source' && e.fidelity === 'lexical' && e.provenance === 'extracted'));
  assert.equal(JSON.stringify(report).includes('cached-symbol'), false);
  assert.equal(JSON.stringify(report).includes('return finish()'), false, 'source bodies must not be returned');
  assert.match(report.limitations.join(' '), /lexical|heuristic/i);
  assert.equal(f.analyze().id, report.id);
  assert.equal(analyzePerformance({ workspace: f.workspace, home: f.home, now: NOW + 1000 }).id, report.id, 'elapsed seconds do not change an otherwise current report');
  assert.equal(fs.existsSync(path.join(f.workspace, '.harness/performance')), false);
});

test('declared structural checks use only the journey graph and exact manifest dependencies', t => {
  const f = fixture(t);
  f.profile.edges = [];
  f.profile.rules = [
    { id: 'finish-required', kind: 'requires-path', journey: 'request', from: 'start', to: 'finish', rationale: 'Completion needs a declared route.' },
    { id: 'package-forbidden', kind: 'forbidden-package', journey: 'request', source: 'package-source', package: 'slow', rationale: 'Avoid the selected package.' },
  ];
  f.save();
  const report = f.analyze();
  assert.equal(report.diagnostics.filter(d => d.kind === 'structural-violation').length, 2);
  assert.ok(report.diagnostics.some(d => d.view === 'architecture' && d.provenance === 'declared'));
  assert.ok(report.diagnostics.some(d => d.view === 'implementation' && d.provenance === 'extracted'));
  f.write('package.json', '{"scripts":{"slow":"echo slow"},"dependencies":{"slow-helper":"1"}}');
  assert.equal(f.analyze().diagnostics.filter(d => d.view === 'implementation' && d.kind === 'structural-violation').length, 0);
  f.write('package.json', '{malformed');
  assert.ok(f.analyze().diagnostics.some(d => d.view === 'implementation' && d.kind === 'unknown'));
});

test('bounded lexical lists retain their truncation flags and disclose incomplete extraction', t => {
  const f = fixture(t);
  const imports = Array.from({ length: 257 }, (_, i) => `import { imported${i} } from './dependency-${i}.mjs';`);
  const symbols = Array.from({ length: 513 }, (_, i) => `export function symbol${i}() {}`);
  f.write('src/start.mjs', [...imports, ...symbols].join('\n'));
  const report = f.analyze();
  const source = report.implementation.nodes.find(node => node.id === 'start-source');
  assert.equal(source.imports.length, 256);
  assert.equal(source.symbols.length, 512);
  assert.deepEqual(source.limitsReached, { symbols: true, imports: true, importOccurrences: true, refs: true });
  assert.ok(report.unknowns.some(message => message.includes('start-source') && /truncat/i.test(message) && message.includes('importOccurrences')));
});

test('bounded repeated import sites disclose omitted evidence even when the module list fits', t => {
  const f = fixture(t);
  f.write('src/start.mjs', Array.from({ length: 257 }, () => "import './finish.mjs';").join('\n'));
  const report = f.analyze();
  const source = report.implementation.nodes.find(node => node.id === 'start-source');
  assert.deepEqual(source.imports, ['./finish.mjs']);
  assert.deepEqual(source.limitsReached, { symbols: false, imports: false, importOccurrences: true, refs: false });
  assert.ok(report.unknowns.some(message => message.includes('start-source') && /truncated for importOccurrences/.test(message)));
});

test('a forbidden direct edge does not become a forbidden transitive path', t => {
  const f = fixture(t);
  f.profile.nodes.push({ id: 'middle', label: 'Middle', kind: 'queue', sources: [] });
  f.profile.journeys[0].nodes.push('middle');
  f.profile.edges = [
    { id: 'first', from: 'start', to: 'middle', mode: 'async', sources: [] },
    { id: 'second', from: 'middle', to: 'finish', mode: 'async', sources: [] },
  ];
  f.profile.rules = [{ id: 'direct-only', kind: 'forbids-edge', journey: 'request', from: 'start', to: 'finish', rationale: 'No direct call.' }];
  f.save();
  assert.equal(f.analyze().diagnostics.some(d => d.kind === 'structural-violation'), false);
  f.profile.edges.push({ id: 'direct', from: 'start', to: 'finish', mode: 'sync', sources: [] }); f.save();
  assert.equal(f.analyze().diagnostics.some(d => d.kind === 'structural-violation'), true);
});

test('goal comparisons require exact context and one journey metric and never aggregate percentiles', t => {
  const f = fixture(t);
  for (const mutation of [
    o => { o.environment = 'production'; },
    o => { o.workload = 'many requests'; },
    o => { o.metrics[0].statistic = 'p50'; },
    o => { o.metrics[0].unit = 's'; },
    o => { o.metrics[0].basis = 'request sent'; },
    o => { o.metrics[0].node = 'start'; },
    o => { o.metrics.push({ ...o.metrics[0] }); },
  ]) {
    const observation = f.observation(); mutation(observation); f.measure(observation);
    assert.equal(goal(f.analyze()).status, 'unknown');
  }
  const observed = f.observation(); observed.metrics.push({ ...observed.metrics[0], node: 'start', value: 400 }); f.measure(observed);
  assert.equal(goal(f.analyze()).status, 'met', 'a node measurement is retained but does not enter the journey comparison');
  assert.equal(f.analyze().observations[0].metrics.length, 2);
});

test('old or mismatched evidence is stale; missing hashes, future captures and unreadable sources are unknown', t => {
  const f = fixture(t);
  const old = f.observation({ capturedAt: '2026-10-14T11:55:00.000Z' }); f.measure(old);
  assert.equal(goal(f.analyze()).status, 'stale');
  f.measure(f.observation({ capturedAt: '2026-10-15T12:01:00.000Z' }));
  assert.equal(goal(f.analyze()).status, 'unknown');
  const missing = f.observation(); delete missing.sourceHashes['design-source']; f.measure(missing);
  assert.equal(goal(f.analyze()).status, 'unknown');
  f.measure(); f.write('src/finish.mjs', 'export function finish() { return false; }\n');
  assert.equal(goal(f.analyze()).status, 'stale');
  fs.unlinkSync(path.join(f.workspace, 'src/finish.mjs'));
  const report = f.analyze();
  assert.equal(goal(report).status, 'unknown');
  assert.equal(report.coverage.unavailable, 1);
  assert.equal(report.inputs.sources.find(s => s.id === 'finish-source').state, 'unavailable');
});

test('goals compare each declared metric in its direction and report only measured symptoms', t => {
  const f = fixture(t);
  f.profile.journeys[0].goals.push(
    { metric: 'reliability', statistic: 'ratio', unit: 'ratio', basis: 'accepted / attempted', target: 0.99 },
    { metric: 'throughput', statistic: 'rate', unit: 'requests/s', basis: 'accepted requests', target: 20 },
    { metric: 'cost', statistic: 'mean', unit: 'USD/journey', basis: 'per accepted journey', target: 0.02 },
  );
  f.save();
  const observation = f.observation();
  observation.metrics = f.profile.journeys[0].goals.map(g => ({ ...g, value: ({ latency: 110, reliability: 0.98, throughput: 21, cost: 0.01 })[g.metric], samples: 40 }));
  for (const metric of observation.metrics) { delete metric.target; metric.journey = 'request'; }
  f.measure(observation);
  const report = f.analyze();
  assert.deepEqual(report.journeys[0].goals.map(g => g.status), ['missed', 'missed', 'met', 'met']);
  const symptoms = report.diagnostics.filter(d => d.kind === 'measured-symptom');
  assert.equal(symptoms.length, 2);
  assert.ok(symptoms.every(d => d.provenance === 'observed' && d.nodes.length === 0));
  assert.match(report.limitations.join(' '), /causal|causation/i);
});

test('strict profiles reject unknown keys, duplicate JSON keys, bad references and invalid metric contracts', t => {
  const f = fixture(t), original = structuredClone(f.profile);
  const invalid = [
    p => { p.extra = true; },
    p => { p.rules = null; },
    p => { p.observations = null; },
    p => { p.sources[0].path = '../outside'; },
    p => { p.sources[0].path = 'src/*.mjs'; },
    p => { p.sources[0].repo = 'foreign'; },
    p => { p.nodes[0].sources.push('missing'); },
    p => { p.edges[0].to = 'missing'; },
    p => { p.journeys[0].nodes = ['start']; },
    p => { p.journeys[0].goals[0].statistic = 'sum'; },
    p => { p.journeys[0].goals.push({ ...p.journeys[0].goals[0] }); },
    p => { p.journeys[0].goals[0] = { metric: 'reliability', statistic: 'ratio', unit: 'ratio', basis: 'success', target: 2 }; },
    p => { p.journeys[0].goals[0] = { metric: 'cost', statistic: 'mean', unit: 'ZZZ/journey', basis: 'per accepted journey', target: 1 }; },
    p => { p.rules.push({ id: 'forbidden', kind: 'forbidden-package', journey: 'request', source: 'start-source', package: 'slow', rationale: 'No.' }); },
    p => { p.observations = ['start-source']; },
  ];
  for (const mutation of invalid) {
    const changed = structuredClone(original); mutation(changed); f.write(DEFAULT_PERFORMANCE_PROFILE, changed);
    assert.throws(f.analyze, error => error.code === 'E_USAGE' && error.exit === 2);
  }
  f.write(DEFAULT_PERFORMANCE_PROFILE, '{"version":1,"version":1}');
  assert.throws(f.analyze, /duplicate|JSON/i);
  f.write(DEFAULT_PERFORMANCE_PROFILE, 'version: 1');
  assert.throws(f.analyze, /JSON/i);
});

test('strict observation exports reject forged membership, unknown fields and invalid samples', t => {
  const f = fixture(t);
  for (const mutation of [
    o => { o.sourceHashes.measurement = 'a'.repeat(64); },
    o => { o.sourceHashes.foreign = 'a'.repeat(64); },
    o => { o.metrics[0].samples = 0; },
    o => { o.metrics[0].samples = 1.5; },
    o => { o.metrics[0].journey = 'missing'; },
    o => { o.metrics[0].node = 'missing'; },
    o => { o.metrics[0].value = -1; },
    o => { o.capturedAt = 'yesterday'; },
    o => { o.authority = 'passed'; },
    o => { o.deployments = [{ node: 'start', repo: 'unselected', commit: 'a'.repeat(40) }]; },
  ]) {
    const observation = f.observation(); mutation(observation); f.measure(observation);
    assert.throws(f.analyze, error => error.code === 'E_USAGE' && error.exit === 2);
  }
  f.measure('{"version":1,"version":1}');
  assert.throws(f.analyze, /duplicate|JSON/i);
});

test('source and profile containment rejects symlinks and never reads unselected imports', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const outside = f.write('outside.mjs', 'export const unselectedSecretName = true;\n', f.dir);
  f.write('src/start.mjs', "import value from '../../outside.mjs';\nexport const start = value;\n");
  let report = f.analyze();
  assert.equal(JSON.stringify(report).includes('unselectedSecretName'), false);
  fs.unlinkSync(path.join(f.workspace, 'src/finish.mjs'));
  fs.symlinkSync(outside, path.join(f.workspace, 'src/finish.mjs'));
  report = f.analyze();
  assert.equal(report.inputs.sources.find(s => s.id === 'finish-source').state, 'unavailable');
  const profileFile = path.join(f.workspace, DEFAULT_PERFORMANCE_PROFILE);
  fs.renameSync(profileFile, path.join(f.dir, 'outside-profile.json'));
  fs.symlinkSync(path.join(f.dir, 'outside-profile.json'), profileFile);
  assert.throws(f.analyze, error => error.code === 'E_USAGE');
});

test('displayed fields are secret-screened while original byte hashes remain exact', t => {
  const f = fixture(t), token = `ghp_${'A'.repeat(36)}`;
  f.profile.nodes[0].label = token;
  f.profile.journeys[0].constraints[0].text = `Do not disclose ${token}`;
  f.save();
  const report = f.analyze();
  assert.equal(JSON.stringify(report).includes(token), false);
  assert.match(report.architecture.nodes[0].label, /redacted/);
  assert.equal(report.profile.sha256, hash(fs.readFileSync(path.join(f.workspace, DEFAULT_PERFORMANCE_PROFILE))));
});

test('scanner-recognized credentials cannot become identity keys in observation maps', t => {
  const f = fixture(t), token = `xoxb-${'a'.repeat(24)}`;
  f.profile.sources[0].id = token;
  f.profile.nodes[0].sources[0] = token;
  f.save(); f.measure();
  assert.throws(f.analyze, error => error.code === 'E_USAGE' && !error.message.includes(token));
});

test('domain snapshot fields screen secret-shaped identities while preserving every member', t => {
  const f = fixture(t), first = `xoxb-${'a'.repeat(24)}`, second = `xoxb-${'b'.repeat(24)}`;
  const one = repository(path.join(f.dir, 'one')), two = repository(path.join(f.dir, 'two'));
  const config = { domain_version: 2, name: 'screened', repos: [{ id: 'product', local_identity: { id: 'product-repo', approved: true } }, { id: first, local_identity: { id: 'one-repo', approved: true } }, { id: second, local_identity: { id: 'two-repo', approved: true } }], sources: [], bindings: { repos: { product: f.workspace, [first]: one, [second]: two }, sources: {} }, shared_specs: [], shared_conventions: [] };
  f.write('domains/screened.yaml', YAML.stringify(config), f.home);
  for (const source of f.profile.sources) source.repo = 'product';
  f.profile.domain = 'screened'; f.save(); f.measure();
  const report = f.analyze(), text = JSON.stringify(report);
  assert.equal(text.includes(first), false);
  assert.equal(text.includes(second), false);
  assert.equal(Object.keys(report.inputs.domain.logical.repos).length, 3);
  assert.equal(Object.keys(report.inputs.domain.bindings.repos).length, 3);
  assert.equal(report.inputs.domain.config.sha256, hash(fs.readFileSync(path.join(f.home, 'domains/screened.yaml'))));
});

test('available context matches selected files, omits unrelated constraints, and binds dirty foreign bytes', t => {
  const f = fixture(t), foreign = repository(path.join(f.dir, 'foreign'));
  f.write('worker.mjs', 'export const worker = true;\n', foreign);
  const config = { domain_version: 2, name: 'sample', repos: [{ id: 'foreign', local_identity: { id: 'foreign-repo', approved: true } }, { id: 'product', local_identity: { id: 'product-repo', approved: true } }], sources: [], bindings: { repos: { foreign, product: f.workspace }, sources: {} }, shared_specs: [], shared_conventions: [] };
  f.write('domains/sample.yaml', YAML.stringify(config), f.home);
  f.profile.domain = 'sample';
  for (const source of f.profile.sources) source.repo = 'product';
  f.profile.sources.push({ id: 'foreign-code', repo: 'foreign', path: 'worker.mjs', kind: 'code' });
  f.profile.nodes[1].sources.push('foreign-code'); f.save(); f.measure();
  const context = performanceContext({ workspace: f.workspace, home: f.home, files: ['src/start.mjs'] });
  assert.equal(context.state, 'available');
  assert.equal(context.journeys[0].id, 'request');
  assert.equal(performanceContextIsCurrent({ workspace: f.workspace, home: f.home, context }), true);
  const domainPath = path.join(f.home, 'domains/sample.yaml');
  const domainBytes = fs.readFileSync(domainPath);
  fs.appendFileSync(domainPath, '\n');
  assert.equal(performanceContextIsCurrent({ workspace: f.workspace, home: f.home, context }), false, 'domain config exact bytes bind context even when YAML meaning is unchanged');
  fs.writeFileSync(domainPath, domainBytes);
  assert.equal(performanceContextIsCurrent({ workspace: f.workspace, home: f.home, context }), true);
  const discovery = performanceContext({ workspace: f.workspace, home: f.home });
  assert.equal(JSON.stringify(discovery).includes('Return only after acceptance.'), false);
  const noMatch = performanceContext({ workspace: f.workspace, home: f.home, files: ['initial.txt'] });
  assert.deepEqual(noMatch.journeys, []);
  const foreignContext = performanceContext({ workspace: f.workspace, home: f.home, files: [path.join(foreign, 'worker.mjs')] });
  assert.equal(foreignContext.journeys[0].id, 'request');
  const oldHead = git(foreign, 'rev-parse', 'HEAD');
  f.write('worker.mjs', 'export const worker = false;\n', foreign);
  assert.equal(git(foreign, 'rev-parse', 'HEAD'), oldHead);
  assert.equal(performanceContextIsCurrent({ workspace: f.workspace, home: f.home, context }), false);
});

test('domain sources require explicit version 2 membership including the coordinating repository', t => {
  const f = fixture(t), foreign = repository(path.join(f.dir, 'foreign'));
  const config = { domain_version: 2, name: 'sample', repos: [{ id: 'foreign', local_identity: { id: 'foreign-repo', approved: true } }], sources: [], bindings: { repos: { foreign }, sources: {} }, shared_specs: [], shared_conventions: [] };
  f.write('domains/sample.yaml', YAML.stringify(config), f.home);
  f.profile.domain = 'sample'; f.save();
  assert.throws(f.analyze, error => error.code === 'E_USAGE' && /domain|member|repositor/.test(error.message));
});

test('directory scopes retrieve only the selected sources and applicable journey constraints', t => {
  const f = fixture(t);
  for (const file of ['src/', 'src', path.join(f.workspace, 'src')]) {
    const context = performanceContext({ workspace: f.workspace, home: f.home, files: [file] });
    assert.equal(context.journeys[0]?.id, 'request');
    assert.deepEqual(context.journeys[0].sourceIds, ['start-source', 'finish-source']);
    assert.deepEqual(context.journeys[0].paths, [{ repo: 'self', path: 'src/start.mjs' }, { repo: 'self', path: 'src/finish.mjs' }]);
  }
});

test('physical path aliases select the same file and directory journey context', t => {
  const f = fixture(t);
  const alias = path.join(f.dir, 'product-alias');
  fs.symlinkSync(f.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const file of [path.join(alias, 'src/start.mjs'), path.join(alias, 'src')]) {
    const context = performanceContext({ workspace: f.workspace, home: f.home, files: [file] });
    assert.deepEqual(context.journeys.map(journey => journey.id), ['request']);
    assert.ok(context.journeys[0].sourceIds.includes('start-source'));
  }
});

test('observation-only edits retrieve guidance for exactly the measured journeys', t => {
  const f = fixture(t);
  f.profile.journeys.push({ ...f.profile.journeys[0], id: 'unmeasured', title: 'An unmeasured journey' });
  f.save();
  const context = performanceContext({ workspace: f.workspace, home: f.home, files: ['measurements.json'] });
  assert.deepEqual(context.journeys.map(journey => journey.id), ['request']);
  assert.deepEqual(context.journeys[0].sourceIds, ['measurement']);
  assert.deepEqual(context.journeys[0].paths, [{ repo: 'self', path: 'measurements.json' }]);
  assert.equal(context.journeys[0].constraints[0].text, 'Return only after acceptance.');
});

test('context reports malformed profiles and currentness notices evidence/profile deletion and domain edits', t => {
  const f = fixture(t);
  const context = performanceContext({ workspace: f.workspace, home: f.home, files: ['src/start.mjs'] });
  fs.unlinkSync(path.join(f.workspace, 'measurements.json'));
  assert.equal(performanceContextIsCurrent({ workspace: f.workspace, home: f.home, context }), false);
  f.write(DEFAULT_PERFORMANCE_PROFILE, '{bad JSON');
  const invalid = performanceContext({ workspace: f.workspace, home: f.home });
  assert.equal(invalid.state, 'invalid');
  assert.match(invalid.profile.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(invalid.error) <= 512);
  assert.equal(performanceContextIsCurrent({ workspace: f.workspace, home: f.home, context: invalid }), true);
  fs.unlinkSync(path.join(f.workspace, DEFAULT_PERFORMANCE_PROFILE));
  assert.equal(performanceContextIsCurrent({ workspace: f.workspace, home: f.home, context }), false);
  assert.equal(performanceContext({ workspace: f.workspace, home: f.home }), null);
});

test('bounded context retains full binding and never exceeds the requested UTF-8 byte budget', t => {
  const f = fixture(t);
  const context = performanceContext({ workspace: f.workspace, home: f.home, files: ['src/start.mjs'], maxBytes: 700 });
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 700);
  assert.match(context.reportId, /^[a-f0-9]{64}$/);
  assert.equal(context.binding.reportId, context.reportId);
  assert.ok(context.omitted.journeys > 0);
  assert.equal(performanceContextIsCurrent({ workspace: f.workspace, home: f.home, context }), true);
  f.write('src/start.mjs', 'export const changed = true;\n');
  assert.equal(performanceContextIsCurrent({ workspace: f.workspace, home: f.home, context }), false);
});

test('large normal review scopes keep a compact complete report binding within the default budget', t => {
  const f = fixture(t);
  const files = ['src/start.mjs', ...Array.from({ length: 512 }, (_, index) => `packages/ordinary-module-${index}/src/${'a'.repeat(42)}.mjs`)];
  const context = performanceContext({ workspace: f.workspace, home: f.home, files });
  assert.equal(context.state, 'available');
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 4096);
  assert.match(context.binding.filesHash, /^[a-f0-9]{64}$/);
  assert.equal(context.binding.reportId, context.reportId);
  assert.equal(performanceContextIsCurrent({ workspace: f.workspace, home: f.home, context }), true);
  f.write('src/finish.mjs', 'export const changed = true;\n');
  assert.equal(performanceContextIsCurrent({ workspace: f.workspace, home: f.home, context }), false);
});

test('deployment commit mismatch cannot compare a current-byte measurement against another HEAD', t => {
  const f = fixture(t);
  f.measure(f.observation({ deployments: [{ node: 'start', repo: 'self', commit: 'a'.repeat(40) }] }));
  assert.equal(goal(f.analyze()).status, 'stale');
  f.measure(f.observation({ deployments: [{ node: 'start', repo: 'self', commit: git(f.workspace, 'rev-parse', 'HEAD') }] }));
  assert.equal(goal(f.analyze()).status, 'met');
  assert.ok(f.analyze().unknowns.some(u => /artifact|build|identity/i.test(u)));
});

test('an absent conventional profile returns null before Git, root validation or source reads', { skip: process.platform === 'win32' }, t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'performance-absent-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, 'real'), alias = path.join(dir, 'alias');
  fs.mkdirSync(real); fs.symlinkSync(real, alias, 'dir');
  let gitCalls = 0, reads = 0;
  t.mock.method(childProcess, 'spawnSync', () => { gitCalls++; throw new Error('Unexpected Git work'); });
  t.mock.method(fs, 'readFileSync', () => { reads++; throw new Error('Unexpected source read'); });
  syncBuiltinESMExports();
  try {
    assert.equal(performanceContext({ workspace: alias }), null);
    assert.equal(performanceContext({ workspace: path.join(alias, 'missing') }), null);
    assert.equal(gitCalls, 0);
    assert.equal(reads, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  fs.mkdirSync(path.join(real, '.github/harness'), { recursive: true });
  fs.writeFileSync(path.join(real, DEFAULT_PERFORMANCE_PROFILE), '{}');
  const context = performanceContext({ workspace: alias });
  assert.equal(context.state, 'invalid');
  assert.match(context.error, /unsafe|symlink/);
});

test('selected input changes during analysis reject the mixed snapshot', t => {
  const f = fixture(t);
  const originalRead = fs.readSync;
  let changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const count = originalRead(...args);
    if (!changed && Buffer.isBuffer(args[1]) && args[1].toString('utf8').includes('export function finish()')) {
      changed = true;
      f.write('src/finish.mjs', 'export function finish() { return false; }\n');
    }
    return count;
  });
  assert.throws(f.analyze, error => error.code === 'E_USAGE' && /changed during analysis/.test(error.message));
  assert.equal(changed, true);
});

test('oversized sources are unavailable and the aggregate source budget rejects excess selected bytes', t => {
  const f = fixture(t);
  f.write('src/finish.mjs', 'x'.repeat(200 * 1024 + 1));
  assert.equal(f.analyze().inputs.sources.find(source => source.id === 'finish-source').state, 'unavailable');
  f.profile.sources = [];
  f.profile.nodes = [];
  f.profile.edges = [];
  f.profile.journeys = [];
  f.profile.observations = [];
  const content = 'x'.repeat(200 * 1024);
  for (let index = 0; index < 42; index++) {
    f.write(`selected-${index}.txt`, content);
    f.profile.sources.push({ id: `source-${index}`, repo: 'self', path: `selected-${index}.txt`, kind: 'design' });
  }
  f.save();
  assert.throws(f.analyze, error => error.code === 'E_USAGE' && /8 MiB/.test(error.message));
});

test('ignored Harness output does not alter a context binding but a selected HEAD does', t => {
  const f = fixture(t);
  f.write('.gitignore', '.harness/\n');
  const context = performanceContext({ workspace: f.workspace, home: f.home, files: ['src/start.mjs'] });
  f.write('.harness/context.json', '{"orient":"new output"}');
  assert.equal(performanceContextIsCurrent({ workspace: f.workspace, home: f.home, context }), true);
  git(f.workspace, 'add', 'initial.txt');
  git(f.workspace, 'commit', '--allow-empty', '-m', 'New selected revision');
  assert.equal(performanceContextIsCurrent({ workspace: f.workspace, home: f.home, context }), false);
});

test('requires-path cannot route through nodes outside its selected journey', t => {
  const f = fixture(t);
  f.profile.nodes.push({ id: 'outside', label: 'Unselected operation', kind: 'operation', sources: [] });
  f.profile.edges = [{ id: 'leave', from: 'start', to: 'outside', mode: 'sync', sources: [] }, { id: 'reenter', from: 'outside', to: 'finish', mode: 'sync', sources: [] }];
  f.profile.rules = [{ id: 'selected-path', kind: 'requires-path', journey: 'request', from: 'start', to: 'finish', rationale: 'Selected journey needs its own route.' }];
  f.save();
  assert.ok(f.analyze().diagnostics.some(diagnostic => diagnostic.kind === 'structural-violation' && diagnostic.id.includes('selected-path')));
});
