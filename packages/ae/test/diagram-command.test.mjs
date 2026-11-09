import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { diagramsResultOf, parseDiagramArguments } from '../lib/diagram-cmd.mjs';
import { diagramArtifactPaths } from '../lib/diagram.mjs';
import { prepareFlowModel, publishFlowModel } from '../lib/flow-model.mjs';
import { queryGraph } from '../lib/graph.mjs';
import { NEEDS_NO_LAZY_FETCH } from './helpers/git-features.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin/ae.mjs');
function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-diagrams-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src/input.mjs'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(workspace, 'view.mmd'), 'flowchart TD\n  A[Read source] --> B[Review change]\n');
  return workspace;
}
const render = workspace => diagramsResultOf(['render', '--file', 'view.mmd', '--sources', 'src', '--workspace', workspace, '--no-events']);
const status = (workspace, receipt) => diagramsResultOf(['status', '--receipt', receipt, '--workspace', workspace, '--no-events']);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash('sha256').update(value).digest('hex');
function git(workspace, ...args) {
  const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function flowFixture(t) {
  const workspace = fixture(t), home = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-diagram-flows-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  git(workspace, 'init', '-q', '-b', 'trunk');
  git(workspace, 'config', 'user.email', 'test@example.invalid'); git(workspace, 'config', 'user.name', 'Test');
  git(workspace, 'remote', 'add', 'origin', 'https://example.invalid/diagram-flow.git');
  const commit = () => { git(workspace, 'add', '.'); git(workspace, 'commit', '-qm', 'fixture'); const sha = git(workspace, 'rev-parse', 'HEAD'); git(workspace, 'update-ref', 'refs/remotes/origin/trunk', sha); return sha; };
  const initial = commit(); git(workspace, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  publishFlowModel({ workspace, home, input: { version: 1, preparation: prepareFlowModel({ workspace, home, watchPaths: ['src'] }), model: { version: 1, format: 'statechart', flows: [{
    id: 'checkout', title: 'Checkout', sources: ['src/input.mjs'], initial: 'idle', states: [{ id: 'idle' }, { id: 'done', kind: 'terminal' }], transitions: [{ from: 'idle', to: 'done', event: 'finish', guard: 'ready' }],
  }] } } });
  const options = ['--workspace', workspace, '--ae-home', home, '--no-events'];
  return { workspace, home, initial, commit, render: () => diagramsResultOf(['flow', '--flow', 'checkout', ...options]), status: receipt => diagramsResultOf(['status', '--receipt', receipt, ...options]) };
}

// Deliberately recompute the public checksum: receipt checksums establish byte
// identity, not authority to redirect source inspection outside the workspace.
function forgedReceipt(workspace, result, mutate) {
  const original = JSON.parse(fs.readFileSync(path.join(workspace, result.artifacts.receipt), 'utf8'));
  const { id: _previousId, artifacts: previousArtifacts, hashes, ...record } = original;
  mutate(record);
  const id = hash(JSON.stringify(stable(record))), base = `.harness/diagrams/${id}`;
  const artifacts = Object.fromEntries(Object.entries(previousArtifacts).map(([key, value]) => [key, `${base}/${path.basename(value)}`]));
  fs.mkdirSync(path.join(workspace, base), { recursive: true });
  for (const key of ['svg', 'html', 'source']) fs.copyFileSync(path.join(workspace, previousArtifacts[key]), path.join(workspace, artifacts[key]));
  fs.writeFileSync(path.join(workspace, artifacts.receipt), JSON.stringify({ ...record, id, artifacts, hashes }));
  return artifacts.receipt;
}

test('diagram flags reject undeclared, duplicate, irrelevant and unsafe inputs', () => {
  for (const argv of [[], ['render'], ['status'], ['render', '--file', '../x.mmd'], ['graph', '--root', 'src/a.mjs', '--depth', '0'], ['render', '--file', 'x.mmd', '--file', 'y.mmd'], ['status', '--receipt', 'receipt.json', '--renderer', 'd2'], ['render', '--file', 'x.mmd', '--mcp'], ['render', '--file', 'x.mmd', '--layout', 'tala'], ['render', '--file', 'x.mmd', '--sources', '.git']]) {
    assert.throws(() => parseDiagramArguments(argv), /diagrams:/);
  }
});

test('authored diagram publishes portable SVG, offline HTML and a source-bound receipt', async t => {
  const workspace = fixture(t);
  const first = await render(workspace);
  assert.equal(first.status, 'ok');
  assert.match(first.id, /^[a-f0-9]{64}$/);
  const receipt = JSON.parse(fs.readFileSync(path.join(workspace, first.artifacts.receipt), 'utf8'));
  assert.equal(receipt.schema, 'ae.diagram.v1');
  assert.equal(receipt.authority, 'descriptive-context');
  assert.equal(receipt.verification, 'not-verified');
  assert.equal(receipt.snapshot.scope, 'worktree');
  assert.equal(receipt.snapshot.files.find(f => f.path === 'src/input.mjs').sha256.length, 64);
  assert.equal(receipt.diagram.sha256, receipt.hashes.source);
  assert.equal((await status(workspace, first.artifacts.receipt)).state, 'current');
  const svg = fs.readFileSync(path.join(workspace, first.artifacts.svg), 'utf8');
  assert.match(svg, /<svg\b/);
  const html = fs.readFileSync(path.join(workspace, first.artifacts.html), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /not-verified/);
  assert.doesNotMatch(html, /<script\b|<iframe\b|<img\b/i);
  assert.equal(first.artifacts.png, undefined);
  assert.equal(receipt.hashes.png, undefined);
  assert.equal((await render(workspace)).id, first.id, 'identical source/configuration replays its immutable artifacts');
});

function pngSize(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('diagram output paths use the active platform separator, including Windows', () => {
  const artifacts = {
    svg: '.harness/diagrams/abc/diagram.svg', html: '.harness/diagrams/abc/report.html',
    png: '.harness/diagrams/abc/diagram.png', receipt: '.harness/diagrams/abc/receipt.json',
  };
  const paths = diagramArtifactPaths('C:\\work\\repo', artifacts, path.win32);
  assert.equal(paths.svg, 'C:\\work\\repo\\.harness\\diagrams\\abc\\diagram.svg');
  assert.equal(paths.html, 'C:\\work\\repo\\.harness\\diagrams\\abc\\report.html');
  assert.equal(paths.png, 'C:\\work\\repo\\.harness\\diagrams\\abc\\diagram.png');
  assert.equal(paths.receipt, 'C:\\work\\repo\\.harness\\diagrams\\abc\\receipt.json');
  assert.equal(diagramArtifactPaths('/work/repo', artifacts, path.posix).svg, '/work/repo/.harness/diagrams/abc/diagram.svg');
});

test('optional png is written beside the svg, hashed in the receipt, printed as an absolute path, and checked by status', async t => {
  const workspace = fixture(t);
  const printed = spawnSync(process.execPath, [cli, 'diagrams', 'render', '--file', 'view.mmd', '--sources', 'src', '--png', '--workspace', workspace, '--no-events'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(printed.status, 0, printed.stderr || printed.stdout);
  assert.match(printed.stdout, /Open the HTML page in a browser\. Use the PNG for Slack, Confluence, Jira, email, or slides\./);
  const jsonRun = spawnSync(process.execPath, [cli, 'diagrams', 'render', '--file', 'view.mmd', '--sources', 'src', '--png', '--scale', '2', '--workspace', workspace, '--no-events', '--json'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(jsonRun.status, 0, jsonRun.stderr || jsonRun.stdout);
  const result = JSON.parse(jsonRun.stdout);
  assert.equal(result.paths.svg, path.resolve(workspace, result.artifacts.svg));
  assert.equal(result.paths.html, path.resolve(workspace, result.artifacts.html));
  assert.equal(result.paths.png, path.resolve(workspace, result.artifacts.png));
  assert.match(printed.stdout, new RegExp(result.paths.svg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(printed.stdout, new RegExp(result.paths.png.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.artifacts.png, /^\.harness\/diagrams\/[a-f0-9]{64}\/diagram\.png$/);
  const receipt = JSON.parse(fs.readFileSync(path.join(workspace, result.artifacts.receipt), 'utf8'));
  const png = fs.readFileSync(path.join(workspace, result.artifacts.png));
  const svg = fs.readFileSync(path.join(workspace, result.artifacts.svg), 'utf8');
  const size = pngSize(png);
  assert.equal(size.width, Number(svg.match(/\bwidth="(\d+(?:\.\d+)?)"/)[1]) * 2);
  assert.equal(size.height, Number(svg.match(/\bheight="(\d+(?:\.\d+)?)"/)[1]) * 2);
  assert.equal(receipt.hashes.png, hash(png));
  assert.equal(receipt.artifacts.png, result.artifacts.png);
  assert.equal(receipt.renderer.settings.raster.scale, 2);
  assert.equal((await status(workspace, result.artifacts.receipt)).state, 'current');
  fs.writeFileSync(path.join(workspace, result.artifacts.png), Buffer.concat([png.subarray(0, 8), Buffer.from('nope')]));
  assert.equal((await status(workspace, result.artifacts.receipt)).state, 'unknown');
  const scaled = await diagramsResultOf(['render', '--file', 'view.mmd', '--sources', 'src', '--png', '--scale', '1', '--workspace', workspace, '--no-events']);
  const once = pngSize(fs.readFileSync(path.join(workspace, scaled.artifacts.png)));
  const scaledSvg = fs.readFileSync(path.join(workspace, scaled.artifacts.svg), 'utf8');
  assert.equal(once.width, Number(scaledSvg.match(/\bwidth="(\d+(?:\.\d+)?)"/)[1]));
  assert.notEqual(scaled.id, result.id);
  for (const argv of [['render', '--file', 'view.mmd', '--scale', '2'], ['render', '--file', 'view.mmd', '--png', '--scale', '5'], ['status', '--receipt', 'receipt.json', '--png']]) {
    assert.throws(() => parseDiagramArguments(argv), /diagrams:/);
  }
});

test('status detects covered edits, added files, diagram edits and corrupted output', async t => {
  const workspace = fixture(t), result = await render(workspace);
  const check = () => status(workspace, result.artifacts.receipt);
  const source = path.join(workspace, 'src/input.mjs'), before = fs.readFileSync(source);
  fs.writeFileSync(source, 'export const value = 2;\n');
  assert.equal((await check()).state, 'stale');
  fs.writeFileSync(source, before);
  fs.writeFileSync(path.join(workspace, 'src/new-writer.mjs'), 'export const writer = true;\n');
  assert.equal((await check()).state, 'stale');
  fs.unlinkSync(path.join(workspace, 'src/new-writer.mjs'));
  assert.equal((await check()).state, 'current');
  fs.appendFileSync(path.join(workspace, 'view.mmd'), 'B --> C[New step]\n');
  assert.equal((await check()).state, 'stale');
  fs.writeFileSync(path.join(workspace, result.artifacts.svg), '<svg>tampered</svg>');
  assert.equal((await check()).state, 'unknown');
});

test('source changes during rendering cannot publish a current artifact', async t => {
  const workspace = fixture(t), pending = render(workspace);
  fs.writeFileSync(path.join(workspace, 'src/input.mjs'), 'changed while rendering\n');
  await assert.rejects(pending, /changed during rendering/);
  assert.equal(fs.existsSync(path.join(workspace, '.harness/diagrams')), false);
});

test('authored diagram cannot render different bytes from its captured hash during an ABA read race', async t => {
  const workspace = fixture(t), file = path.join(workspace, 'view.mmd'), originalRead = fs.readSync;
  const first = 'flowchart TD\nA --> B\n', alternate = 'flowchart TD\nC --> D\n';
  fs.writeFileSync(file, first);
  let stage = 0;
  fs.readSync = function (fd, buffer, ...args) {
    const count = originalRead.call(this, fd, buffer, ...args), bytes = buffer.toString('utf8');
    if (stage === 0 && bytes === first) { stage = 1; fs.writeFileSync(file, alternate); }
    else if (stage === 1 && bytes === alternate) { stage = 2; fs.writeFileSync(file, first); }
    return count;
  };
  try { await assert.rejects(render(workspace), /diagram source.*changed|captured diagram/i); }
  finally { fs.readSync = originalRead; }
  assert.equal(stage, 2, 'both competing reads must run in the fixture');
  assert.equal(fs.existsSync(path.join(workspace, '.harness/diagrams')), false);
});

test('real CLI flow preserves committed scope, source bindings and currentness despite dirty worktree bytes', { skip: NEEDS_NO_LAZY_FETCH }, t => {
  const f = flowFixture(t);
  fs.writeFileSync(path.join(f.workspace, 'src/input.mjs'), 'dirty worktree bytes\n');
  const run = spawnSync(process.execPath, [cli, 'diagrams', 'flow', '--flow', 'checkout', '--workspace', f.workspace, '--ae-home', f.home, '--no-events', '--json'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout), receipt = JSON.parse(fs.readFileSync(path.join(f.workspace, result.artifacts.receipt), 'utf8'));
  assert.equal(result.freshness.state, 'current');
  assert.equal(result.freshness.scope, 'committed-default-branch');
  assert.equal(receipt.projection.generationCommit, f.initial);
  assert.equal(receipt.projection.preparation.sources[0].path, 'src/input.mjs');
  assert.equal(receipt.diagram.sha256, receipt.hashes.source);
  assert.match(fs.readFileSync(path.join(f.workspace, result.artifacts.source), 'utf8'), /status current/);
});

test('a previously stale flow remains renderable and visibly stale without changing its authored generation', { skip: NEEDS_NO_LAZY_FETCH }, async t => {
  const f = flowFixture(t);
  fs.writeFileSync(path.join(f.workspace, 'src/input.mjs'), 'export const value = 2;\n'); f.commit();
  const result = await f.render(), receipt = JSON.parse(fs.readFileSync(path.join(f.workspace, result.artifacts.receipt), 'utf8'));
  assert.equal(result.freshness.state, 'stale');
  assert.equal(receipt.projection.state, 'stale');
  assert.equal(receipt.projection.generationCommit, f.initial);
  assert.match(fs.readFileSync(path.join(f.workspace, result.artifacts.source), 'utf8'), /status stale/);
  assert.equal((await f.status(result.artifacts.receipt)).state, 'stale');
});

for (const alreadyStale of [false, true]) test(`flow source/status changes during render refuse publication (initially ${alreadyStale ? 'stale' : 'current'})`, { skip: NEEDS_NO_LAZY_FETCH }, async t => {
  const f = flowFixture(t);
  if (alreadyStale) { fs.writeFileSync(path.join(f.workspace, 'src/input.mjs'), 'export const value = 2;\n'); f.commit(); }
  const pending = f.render();
  fs.writeFileSync(path.join(f.workspace, 'src/input.mjs'), 'export const value = 3;\n'); f.commit();
  await assert.rejects(pending, /flow.*changed during rendering/i);
  assert.equal(fs.existsSync(path.join(f.workspace, '.harness/diagrams')), false);
});

test('diagram-only rendering is explicit and dry-run publishes nothing', async t => {
  const workspace = fixture(t);
  const preview = await diagramsResultOf(['render', '--file', 'view.mmd', '--dry-run', '--workspace', workspace]);
  assert.equal(preview.artifacts, null);
  assert.equal(preview.freshness.scope, 'diagram-only');
  assert.equal(fs.existsSync(path.join(workspace, '.harness/diagrams')), false);
});

test('symlinked watched paths and report destinations refuse write-through', async t => {
  if (process.platform === 'win32') return t.skip('symlink creation requires host privileges');
  const workspace = fixture(t), outside = fixture(t);
  fs.symlinkSync(path.join(outside, 'src'), path.join(workspace, 'linked'), 'dir');
  await assert.rejects(diagramsResultOf(['render', '--file', 'view.mmd', '--sources', 'linked', '--workspace', workspace]), /symlink|unsafe/);
  fs.symlinkSync(outside, path.join(workspace, '.harness'), 'dir');
  await assert.rejects(render(workspace), /unsafe|destination/);
  assert.equal(fs.existsSync(path.join(outside, 'diagrams')), false);
});

test('replaying identical artifacts still refuses an in-workspace symlinked report ancestor', async t => {
  if (process.platform === 'win32') return t.skip('symlink creation requires host privileges');
  const workspace = fixture(t), result = await render(workspace), original = path.join(workspace, path.dirname(result.artifacts.receipt)), relocated = path.join(workspace, 'relocated-report');
  fs.renameSync(original, relocated); fs.symlinkSync(relocated, original, 'dir');
  await assert.rejects(render(workspace), /unsafe|symlink|destination/);
  assert.equal((await status(workspace, result.artifacts.receipt)).state, 'unknown');
});

test('source scopes and skipped dependency directories use case-insensitive reserved names', async t => {
  const workspace = fixture(t);
  for (const reserved of ['.GIT', 'src/.HaRnEsS', 'Node_Modules']) assert.throws(() => parseDiagramArguments(['render', '--file', 'view.mmd', '--sources', reserved]), /source scopes/i);
  fs.mkdirSync(path.join(workspace, 'src/Node_Modules'));
  fs.writeFileSync(path.join(workspace, 'src/Node_Modules/ignored.mjs'), 'not product evidence\n');
  const result = await render(workspace), receipt = JSON.parse(fs.readFileSync(path.join(workspace, result.artifacts.receipt), 'utf8'));
  assert.equal(receipt.snapshot.files.some(file => file.path.includes('Node_Modules')), false);
});

test('directory inventory stops at its entry bound without allocating a complete directory listing', async t => {
  const workspace = fixture(t), source = path.join(workspace, 'src'), original = fs.readdirSync;
  for (let i = 0; i < 4100; i++) fs.writeFileSync(path.join(source, `entry-${i}.mjs`), '');
  let fullListing = false;
  fs.readdirSync = function (target, ...args) {
    if (String(target) === source) { fullListing = true; throw new Error('unbounded directory listing attempted'); }
    return original.call(this, target, ...args);
  };
  try { await assert.rejects(render(workspace), /source inventory.*bound/i); }
  finally { fs.readdirSync = original; }
  assert.equal(fullListing, false);
  assert.equal(fs.existsSync(path.join(workspace, '.harness/diagrams')), false);
});

test('a checksummed receipt cannot redirect graph freshness inspection to a sibling workspace', async t => {
  const workspace = fixture(t), sibling = fixture(t), secret = path.join(sibling, 'private.mjs');
  fs.writeFileSync(path.join(workspace, 'src/a.mjs'), "import './input.mjs';\n");
  fs.writeFileSync(secret, 'export const privateValue = 41;\n');
  for (const repo of [workspace, sibling]) { git(repo, 'init', '-q'); git(repo, 'add', '.'); }
  const result = await diagramsResultOf(['graph', '--root', 'src/a.mjs', '--workspace', workspace]);
  const outside = queryGraph({ workspace: sibling, operation: 'deps', files: ['private.mjs'], depth: 2, limit: 50 });
  const receipt = forgedReceipt(workspace, result, record => { record.snapshot.query = { operation: 'deps', files: ['private.mjs'], depth: 2, limit: 50, workspace: sibling }; record.snapshot.digest = outside.snapshot; });
  const original = fs.openSync; let outsideReads = 0;
  fs.openSync = function (target, ...args) { if (String(target) === secret) outsideReads++; return original.call(this, target, ...args); };
  let checked;
  try { checked = await status(workspace, receipt); }
  finally { fs.openSync = original; }
  assert.equal(checked.state, 'unknown');
  assert.equal(outsideReads, 0, 'untrusted receipt fields must never select source-reading authority');
});

test('forged receipt snapshots reject unexpected fields, kinds, paths and query ranges', async t => {
  const workspace = fixture(t);
  fs.writeFileSync(path.join(workspace, 'src/a.mjs'), "import './input.mjs';\n"); git(workspace, 'init', '-q'); git(workspace, 'add', '.');
  const result = await diagramsResultOf(['graph', '--root', 'src/a.mjs', '--workspace', workspace]);
  const mutations = [
    record => { record.snapshot.version = 2; },
    record => { record.snapshot.scope = 'diagram-only'; },
    record => { record.snapshot.query.home = workspace; },
    record => { record.snapshot.query.depth = 0; },
    record => { record.snapshot.query.limit = 201; },
    record => { record.snapshot.query.files = ['../outside.mjs']; },
    record => { record.snapshot.query.operation = 'path'; record.snapshot.query.files = ['src/a.mjs', 'src/input.mjs']; },
    record => { record.snapshot.kind = 'unsupported'; },
    record => { record.snapshot.digest = 'invalid'; },
  ];
  for (const mutate of mutations) assert.equal((await status(workspace, forgedReceipt(workspace, result, mutate))).state, 'unknown');
  const authored = await render(workspace);
  for (const mutate of [record => { record.snapshot.files[0].sha256 = 'f'.repeat(64); }, record => { record.snapshot.extra = 'unexpected'; }, record => { record.diagram.sha256 = 'f'.repeat(64); }]) {
    assert.equal((await status(workspace, forgedReceipt(workspace, authored, mutate))).state, 'unknown');
  }
});

test('real CLI graph uses current import facts and participates in command envelopes', t => {
  const workspace = fixture(t);
  fs.writeFileSync(path.join(workspace, 'src/a.mjs'), "import { value } from './input.mjs';\nconsole.log(value);\n");
  for (const args of [['init', '-q'], ['add', '.']]) assert.equal(spawnSync('git', args, { cwd: workspace }).status, 0);
  const run = spawnSync(process.execPath, [cli, 'diagrams', 'graph', '--root', 'src/a.mjs', '--workspace', workspace, '--no-events', '--json'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout);
  const receipt = JSON.parse(fs.readFileSync(path.join(workspace, result.artifacts.receipt), 'utf8'));
  assert.equal(receipt.kind, 'module-imports');
  assert.equal(receipt.projection.relation, 'observed-module-imports');
  assert.equal(receipt.projection.edges.length, 1);
  assert.equal(receipt.verification, 'not-verified');
  const envelope = spawnSync(process.execPath, [cli, 'diagrams', 'status', '--receipt', result.artifacts.receipt, '--workspace', workspace, '--no-events', '--output', 'json-envelope'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(envelope.status, 0, envelope.stderr || envelope.stdout);
  assert.equal(JSON.parse(envelope.stdout).command, 'diagrams');
});

test('cold graph diagrams disclose lexical provenance and status never prepares a structural index', async t => {
  const workspace = fixture(t), home = path.join(workspace, 'uncreated-ae-home');
  fs.writeFileSync(path.join(workspace, 'src/a.mjs'), "import { value } from './input.mjs';\nconsole.log(value);\n");
  git(workspace, 'init', '-q'); git(workspace, 'add', '.');
  const options = ['--workspace', workspace, '--ae-home', home, '--no-events'];
  const result = await diagramsResultOf(['graph', '--root', 'src/a.mjs', ...options]);
  const receipt = JSON.parse(fs.readFileSync(path.join(workspace, result.artifacts.receipt), 'utf8'));
  assert.equal(receipt.projection.generation, null);
  assert.equal(receipt.projection.producer.extractorTier, 'lexical');
  assert.equal(receipt.projection.freshness.state, 'current');
  assert.equal(receipt.projection.coverage.scope, 'git-tracked-source');
  assert.equal(receipt.projection.edges[0].method, 'lexical');
  assert.equal(receipt.projection.edges[0].evidence[0].path, 'src/a.mjs');
  const check = () => diagramsResultOf(['status', '--receipt', result.artifacts.receipt, ...options]);
  assert.equal((await check()).state, 'current');
  assert.equal(fs.existsSync(home), false, 'rendering and status must preserve the query-only graph contract');
  fs.writeFileSync(path.join(workspace, 'src/input.mjs'), 'export const value = 2;\n');
  assert.equal((await check()).state, 'stale');
  assert.equal(fs.existsSync(home), false, 'status must not publish an index while checking changed sources');
});
