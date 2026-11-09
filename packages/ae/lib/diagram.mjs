import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { repoId } from './knowledge/store.mjs';
import { assertNoSymlinkAncestors, readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { queryGraph } from './graph.mjs';
import { showFlowModel } from './flow-model.mjs';
import { projectGraph, projectFlow } from './diagrams/projections.mjs';
import { renderDiagram } from './diagrams/render.mjs';

const MAX_FILE = 1024 * 1024, MAX_TOTAL = 16 * 1024 * 1024, MAX_ARTIFACT = 8 * 1024 * 1024;
const RESERVED = new Set(['.git', '.harness', 'node_modules']);
const reserved = value => RESERVED.has(value.toLowerCase());
const HASH = /^[a-f0-9]{64}$/;
const fail = message => Object.assign(new Error(`diagrams: ${message}`), { code: 'E_DIAGRAM', exit: 2, hint: 'ae help diagrams' });
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const serialize = value => JSON.stringify(stable(value));
const digest = value => sha(serialize(value));
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function diagramPath(value, { scope = false } = {}) {
  if (scope && value === '.') return value;
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\x00-\x1f\x7f\\:]/.test(value)
    || path.isAbsolute(value) || path.win32.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw fail('paths must be contained, regular workspace-relative paths');
  if (scope && value.split('/').some(reserved)) throw fail('source scopes cannot contain .git, .harness or node_modules');
  return value;
}

function read(workspace, rel, maxBytes = MAX_FILE, binary = false) {
  const full = assertNoSymlinkAncestors(workspace, rel);
  const content = full && readFileNoFollow(full, { root: workspace, maxBytes, encoding: binary ? null : 'utf8' });
  if (content === null || content === false) throw fail(`unsafe, unreadable or oversized file: ${rel}`);
  return content;
}

function fields(value, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key))) throw fail(`invalid ${label}`);
}

// A checksum is public identity, not authority. Validate receipt data before it
// can select a query or a filesystem observation, even if its checksum matches.
function validateSnapshot(snapshot) {
  const extra = { files: ['watchPaths', 'diagramFile', 'files'], graph: ['query'], flow: ['flow', 'modelDigest', 'preparationDigest'] }[snapshot?.kind];
  if (!extra) throw fail('invalid source snapshot kind');
  fields(snapshot, ['version', 'kind', 'project', 'scope', 'digest', ...extra], 'source snapshot fields');
  if (snapshot.version !== 1 || !HASH.test(snapshot.digest) || typeof snapshot.project !== 'string'
    || !snapshot.project || snapshot.project.length > 4096 || /[\x00-\x1f\x7f]/.test(snapshot.project)) throw fail('invalid source snapshot identity');
  if (snapshot.kind === 'files') {
    if (!Array.isArray(snapshot.watchPaths) || snapshot.watchPaths.length > 64 || new Set(snapshot.watchPaths).size !== snapshot.watchPaths.length
      || snapshot.scope !== (snapshot.watchPaths.length ? 'worktree' : 'diagram-only')
      || !Array.isArray(snapshot.files) || !snapshot.files.length || snapshot.files.length > 2048) throw fail('invalid file source snapshot');
    snapshot.watchPaths.forEach(watch => diagramPath(watch, { scope: true }));
    diagramPath(snapshot.diagramFile);
    const paths = new Set();
    for (const file of snapshot.files) {
      fields(file, ['path', 'sha256', 'mode'], 'file source binding'); diagramPath(file.path);
      if (paths.has(file.path) || !HASH.test(file.sha256) || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777
        || file.path !== snapshot.diagramFile && !snapshot.watchPaths.some(watch => watch === '.' || file.path === watch || file.path.startsWith(`${watch}/`))) throw fail('invalid file source binding');
      paths.add(file.path);
    }
    const { digest: expected, ...body } = snapshot;
    if (!paths.has(snapshot.diagramFile) || digest(body) !== expected) throw fail('changed file source snapshot digest');
  } else if (snapshot.kind === 'graph') {
    fields(snapshot.query, ['operation', 'files', 'depth', 'limit'], 'graph snapshot query');
    const query = snapshot.query;
    if (snapshot.scope !== 'worktree' || !['deps', 'dependents'].includes(query.operation) || !Array.isArray(query.files) || query.files.length !== 1
      || !Number.isInteger(query.depth) || query.depth < 1 || query.depth > 32
      || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200) throw fail('invalid graph snapshot query');
    diagramPath(query.files[0]);
  } else if (snapshot.scope !== 'committed-default-branch' || typeof snapshot.flow !== 'string'
    || snapshot.flow.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(snapshot.flow)
    || !HASH.test(snapshot.modelDigest) || !HASH.test(snapshot.preparationDigest)) throw fail('invalid flow source snapshot');
}

// Watch explicit directories as well as current files: a newly added writer
// changes the inventory even before it has been added to Git's index.
function capture(workspace, watchPaths, diagramFile) {
  if (!Array.isArray(watchPaths) || watchPaths.length > 64) throw fail('select at most 64 source paths');
  const watches = [...new Set(watchPaths.map(p => diagramPath(p, { scope: true })))].sort();
  const files = new Map();
  let total = 0, visited = 0, enumerated = 0;
  const visit = (rel, depth = 0) => {
    if (++visited > 4096 || depth > 32) throw fail('source inventory exceeds its bound; narrow --sources');
    if (rel !== '.') diagramPath(rel);
    const full = assertNoSymlinkAncestors(workspace, rel);
    if (!full) throw fail(`unsafe or symlinked source path: ${rel}`);
    let stat;
    try { stat = fs.lstatSync(full); } catch { throw fail(`missing source path: ${rel}`); }
    if (stat.isSymbolicLink()) throw fail(`symlinked source path: ${rel}`);
    if (stat.isDirectory()) {
      const names = [], directory = fs.opendirSync(full, { bufferSize: 32 });
      try {
        let entry;
        while ((entry = directory.readSync())) {
          if (++enumerated > 4096) throw fail('source inventory exceeds its bound; narrow --sources');
          if (!reserved(entry.name)) names.push(entry.name);
        }
      } finally { directory.closeSync(); }
      for (const name of names.sort()) {
        visit(rel === '.' ? name : `${rel}/${name}`, depth + 1);
      }
    } else if (stat.isFile()) {
      if (files.has(rel)) return;
      const content = read(workspace, rel, MAX_FILE, true);
      total += content.length;
      if (files.size >= 2048 || total > MAX_TOTAL) throw fail('source bytes exceed their bound; narrow --sources');
      files.set(rel, { path: rel, sha256: sha(content), mode: stat.mode & 0o777 });
    } else throw fail(`source is not a regular file or directory: ${rel}`);
  };
  for (const rel of watches) visit(rel);
  visit(diagramFile);
  const snapshot = { version: 1, kind: 'files', project: repoId(workspace), scope: watches.length ? 'worktree' : 'diagram-only', watchPaths: watches, diagramFile, files: [...files.values()].sort((a, b) => a.path < b.path ? -1 : 1) };
  return { ...snapshot, digest: digest(snapshot) };
}

function selectView({ workspace, home, verb, file, sources = [], root, operation = 'deps', depth = 2, limit = 50, flow, maxNodes = 50 }) {
  if (verb === 'render') {
    const snapshot = capture(workspace, sources, file);
    const source = read(workspace, file, 50000), captured = snapshot.files.find(f => f.path === file)?.sha256;
    if (sha(source) !== captured) throw fail('diagram source changed after its captured diagram binding');
    return { source, kind: 'authored', format: file.endsWith('.d2') ? 'd2' : 'mermaid', diagram: { file, sha256: captured }, snapshot, projection: null };
  }
  if (verb === 'graph') {
    const query = { operation, files: [root], depth, limit };
    const graph = queryGraph({ workspace, home, ...query });
    if (graph.outcome === 'unknown' || graph.outcome === 'missing') throw fail(`module graph is ${graph.outcome}; inspect ae graph coverage before rendering`);
    const view = projectGraph(graph, { maxNodes, maxEdges: limit });
    return { ...view, diagram: { sha256: sha(view.source) }, projection: view.metadata,
      snapshot: { version: 1, kind: 'graph', project: repoId(workspace), scope: 'worktree', query, digest: graph.snapshot } };
  }
  const model = showFlowModel({ workspace, home });
  const view = projectFlow(model, flow, { maxNodes, maxEdges: limit });
  return { ...view, diagram: { sha256: sha(view.source) }, projection: view.metadata, flowObservationDigest: digest(model),
    snapshot: { version: 1, kind: 'flow', project: repoId(workspace), scope: 'committed-default-branch', flow, modelDigest: digest(model.model), preparationDigest: digest(model.preparation), digest: digest({ model: model.model, preparation: model.preparation }) } };
}

function flowFreshness(model, snapshot) {
  if (!model.model || !['current', 'stale'].includes(model.state)) return { state: 'unknown', reason: model.reason || 'saved flow unavailable' };
  if (model.state === 'stale' || digest(model.model) !== snapshot.modelDigest || digest(model.preparation) !== snapshot.preparationDigest) return { state: 'stale', reason: 'saved flow or committed default-branch sources changed' };
  return { state: 'current' };
}

function currentness({ workspace, home }, snapshot) {
  try {
    validateSnapshot(snapshot);
    if (repoId(workspace) !== snapshot.project) return { state: 'unknown', reason: 'different project identity' };
    if (snapshot.kind === 'files') {
      const current = capture(workspace, snapshot.watchPaths, snapshot.diagramFile);
      return current.digest === snapshot.digest ? { state: 'current' } : { state: 'stale', reason: 'covered source bytes, modes or inventory changed' };
    }
    if (snapshot.kind === 'graph') {
      const { operation, files, depth, limit } = snapshot.query;
      const graph = queryGraph({ operation, files, depth, limit, workspace, home });
      if (graph.outcome === 'unknown') return { state: 'unknown', reason: 'current graph source evidence unavailable' };
      return graph.snapshot === snapshot.digest ? { state: 'current' } : { state: 'stale', reason: 'tracked graph sources or resolver inputs changed' };
    }
    if (snapshot.kind === 'flow') return flowFreshness(showFlowModel({ workspace, home }), snapshot);
  } catch (error) { return { state: 'unknown', reason: String(error.message).slice(0, 500) }; }
  return { state: 'unknown', reason: 'unsupported source snapshot' };
}

function htmlReport({ id, record, svg, source }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:"><title>AE diagram ${id.slice(0, 12)}</title><style>body{margin:0;background:#fafbf8;color:#183237;font:16px/1.6 system-ui,sans-serif}main{max-width:1200px;margin:auto;padding:32px}h1{font-size:30px;line-height:1.2}.meta{color:#52666b}figure{background:white;padding:24px;border:1px solid #dce4de;overflow:auto;margin:24px 0}figure svg{display:block;max-width:100%;height:auto;margin:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;background:#edf2ed;padding:20px}summary{cursor:pointer;font-weight:600}code{overflow-wrap:anywhere}</style></head><body><main><h1>${escape(record.kind)} diagram</h1><p class="meta">${escape(record.snapshot.scope)} · ${escape(record.renderer.engine)} ${escape(record.renderer.version)} · ${escape(record.renderer.layout || 'native')} · snapshot ${id.slice(0, 12)}</p><p><strong>Descriptive context.</strong> Verification: <code>not-verified</code>. A successful render does not establish architecture accuracy, runtime behavior or complete coverage.</p><figure>${svg}</figure><details><summary>Sources, coverage and rendering receipt</summary><pre>${escape(JSON.stringify(record, null, 2))}</pre></details><details><summary>Diagram source</summary><pre>${escape(source)}</pre></details><p>This is a saved snapshot. Run <code>ae diagrams status --receipt .harness/diagrams/${id}/receipt.json --json</code> to check current source and artifact bytes.</p></main></body></html>\n`;
}

function sameBytes(existing, content) {
  if (existing === content) return true;
  if (existing == null || content == null) return false;
  const left = Buffer.isBuffer(existing) ? existing : Buffer.from(existing);
  const right = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return left.equals(right);
}

function publish(workspace, rel, content) {
  const full = assertNoSymlinkAncestors(workspace, rel);
  if (!full) throw fail('report destination is unsafe or symlinked');
  const binary = Buffer.isBuffer(content);
  const existing = readFileNoFollow(full, { root: workspace, maxBytes: MAX_ARTIFACT, encoding: binary ? null : 'utf8' });
  if (sameBytes(existing, content)) return;
  if (existing !== null || !writeFileContained(workspace, rel, content, { exclusive: true })) throw fail('report destination is unsafe or contains conflicting bytes');
  const verified = readFileNoFollow(path.join(workspace, rel), { root: workspace, maxBytes: MAX_ARTIFACT, encoding: binary ? null : 'utf8' });
  if (!sameBytes(verified, content)) throw fail('report publication could not be verified');
}

export function diagramArtifactPaths(workspace, artifacts, pathImpl = path) {
  const paths = {};
  if (!artifacts) return paths;
  for (const key of ['svg', 'html', 'png', 'receipt']) {
    if (typeof artifacts[key] === 'string') paths[key] = pathImpl.resolve(workspace, artifacts[key]);
  }
  return paths;
}

export async function renderDiagramView(options) {
  const { workspace, home, renderer, layout, timeoutMs, dryRun = false, png = false, scale = 2 } = options;
  const view = selectView(options);
  const engine = renderer || (view.format === 'd2' ? 'd2' : 'pele');
  if (view.format === 'd2' && engine !== 'd2' || view.format === 'mermaid' && engine !== 'pele') throw fail('diagram syntax must match renderer; Mermaid uses pele and D2 uses d2');
  const rendered = await renderDiagram({ source: view.source, engine, layout, timeoutMs, pngScale: png ? scale : undefined });
  let now;
  if (view.snapshot.kind === 'flow') {
    const after = showFlowModel({ workspace, home });
    if (digest(after) !== view.flowObservationDigest) throw fail('flow source or status changed during rendering; inspect the current flow and retry');
    now = flowFreshness(after, view.snapshot);
  } else now = currentness({ workspace, home }, view.snapshot);
  if (view.snapshot.kind !== 'flow' && now.state !== 'current') throw fail(`sources changed during rendering: ${now.reason || now.state}`);
  if (view.snapshot.kind === 'flow' && now.state === 'unknown') throw fail(`flow sources unavailable after rendering: ${now.reason}`);
  const record = { schema: 'ae.diagram.v1', kind: view.kind, authority: 'descriptive-context', verification: 'not-verified', diagram: { ...view.diagram, format: view.format }, snapshot: view.snapshot,
    renderer: { engine: rendered.engine, version: rendered.version, layout: rendered.layout || null, settings: rendered.settings }, projection: view.projection };
  const id = digest(record), base = `.harness/diagrams/${id}`;
  const artifacts = { svg: `${base}/diagram.svg`, html: `${base}/report.html`, source: `${base}/diagram.${view.format === 'd2' ? 'd2' : 'mmd'}`, receipt: `${base}/receipt.json` };
  const contents = { svg: rendered.svg, html: htmlReport({ id, record, svg: rendered.svg, source: view.source }), source: view.source };
  if (rendered.png) {
    artifacts.png = `${base}/diagram.png`;
    contents.png = rendered.png;
  }
  const hashes = Object.fromEntries(Object.entries(contents).map(([key, content]) => [key, sha(content)]));
  const receipt = { ...record, id, artifacts, hashes };
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  if ([...Object.values(contents), json].some(content => Buffer.byteLength(content) > MAX_ARTIFACT)) throw fail('generated artifact exceeds 8 MiB; select a smaller view or a lower --scale');
  if (!dryRun) {
    // The receipt is the completion marker. Interrupted publication can replay
    // identical bytes; conflicting/user-edited content is never overwritten.
    for (const [key, content] of Object.entries(contents)) publish(workspace, artifacts[key], content);
    publish(workspace, artifacts.receipt, json);
  }
  const published = dryRun ? null : artifacts;
  return { mode: 'diagrams', verb: options.verb, status: 'ok', exitCode: 0, id, kind: view.kind, renderer: record.renderer, freshness: { ...now, scope: view.snapshot.scope }, artifacts: published, paths: published ? diagramArtifactPaths(workspace, published) : null, dryRun, verification: 'not-verified' };
}

export function diagramStatus({ workspace, home, receiptPath }) {
  const unknown = reason => ({ mode: 'diagrams', verb: 'status', status: 'ok', exitCode: 0, state: 'unknown', reason, verification: 'not-verified' });
  try {
    const receipt = JSON.parse(read(workspace, receiptPath, MAX_ARTIFACT));
    const { id, artifacts, hashes, ...record } = receipt;
    const base = `.harness/diagrams/${id}`;
    const hashNames = hashes && typeof hashes === 'object' ? Object.keys(hashes).sort() : [];
    const png = hashNames.includes('png');
    const expectedNames = png ? ['html', 'png', 'source', 'svg'] : ['html', 'source', 'svg'];
    const expected = { svg: `${base}/diagram.svg`, html: `${base}/report.html`, source: `${base}/diagram.${record.diagram?.format === 'd2' ? 'd2' : 'mmd'}`, ...(png ? { png: `${base}/diagram.png` } : {}), receipt: `${base}/receipt.json` };
    if (!HASH.test(id) || record.schema !== 'ae.diagram.v1' || record.authority !== 'descriptive-context' || record.verification !== 'not-verified'
      || digest(record) !== id || receiptPath !== expected.receipt || serialize(artifacts) !== serialize(expected)
      || hashNames.join(',') !== expectedNames.join(',')
      || !['d2', 'mermaid'].includes(record.diagram?.format) || record.diagram.sha256 !== hashes.source) return unknown('invalid or changed render receipt');
    validateSnapshot(record.snapshot);
    for (const key of expectedNames) if (!HASH.test(hashes[key]) || sha(read(workspace, expected[key], MAX_ARTIFACT, true)) !== hashes[key]) return unknown('rendered artifact bytes changed or are unavailable');
    return { mode: 'diagrams', verb: 'status', status: 'ok', exitCode: 0, id, ...currentness({ workspace, home }, record.snapshot), scope: record.snapshot.scope, artifacts, paths: diagramArtifactPaths(workspace, artifacts), verification: 'not-verified' };
  } catch (error) { return unknown(String(error.message).slice(0, 500)); }
}
