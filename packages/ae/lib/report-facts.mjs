import { spawnGitSync } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { readFileNoFollow, assertNoSymlinkAncestors } from './fs-safe.mjs';
import { listPlanRels, normalizePlanRel, planFromText } from './plan-parse.mjs';
import { loadNamedChecks, validateCommand, CHECKS_REL } from './checks.mjs';
import { indexStatus } from './index-status.mjs';
import { validateReview, readReviewRecord, recordHash } from './review.mjs';
import { readEvidence, validateEvidence } from './evidence.mjs';
import { validateCompletion } from './completion.mjs';
import { loadPolicy } from './policy.mjs';
import { runGate } from './gate.mjs';
import { resolveObligation } from './intent-sources.mjs';
import { inertLine } from './knowledge/store.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const brief = text => inertLine(String(text || '')).slice(0, 240);
function source(root, rel) {
  const text = readFileNoFollow(path.isAbsolute(rel) ? rel : path.join(root, rel), { root, maxBytes: 1024 * 1024 });
  return text === null ? null : { text, ref: { path: rel, sha256: hash(text) } };
}
function snapshotPlan(workspace, rel) {
  const normalized = normalizePlanRel(workspace, rel);
  if (!normalized) return null;
  const root = path.isAbsolute(normalized) ? path.dirname(normalized) : workspace;
  const s = source(root, normalized);
  return s ? { plan: planFromText(s.text, { path: normalized, fullPath: path.resolve(workspace, normalized) }), source: s.ref } : null;
}

export function planStateFacts(workspace) {
  const counts = Object.create(null), rows = [], diagnostics = [];
  for (const rel of listPlanRels(workspace)) {
    const snapshot = snapshotPlan(workspace, rel);
    if (!snapshot || snapshot.plan.fm.__parseError) { diagnostics.push({ path: rel, reason: 'plan unavailable or malformed' }); continue; }
    const p = snapshot.plan, status = typeof p.status === 'string' ? p.status : 'unknown';
    counts[status] = (counts[status] || 0) + 1;
    rows.push({ path: p.path, status, locked: p.plan_lock, schema: p.fm.plan_schema || p.fm.format || 'legacy', source: snapshot.source });
  }
  return { total: rows.length, counts, rows, diagnostics };
}

function invocationIdentityOf(record) {
  const results = Array.isArray(record?.results) ? record.results : [];
  if (results.length && results.every(result => result.provenance?.independence === 'separate-reviewer')) return 'separate-reviewer';
  if (results.some(result => result.provenance?.independence === 'rejected')) return 'rejected';
  return 'unverified';
}

export function reviewCoverageFacts({ workspace, plan, copilotHome }) {
  if (!plan) return { pass: false, state: 'no-plan', requiredCount: 0, missingCount: 0, record: null };
  const required = plan.fm.reviews?.required || [];
  try {
    const result = validateReview({ workspace, plan, copilotHome });
    return { pass: result.pass, state: result.pass ? 'current' : 'incomplete-or-stale', requiredCount: required.length, missingCount: result.missing?.length || 0, record: result.record?.id || null, message: brief(result.message), invocationIdentity: invocationIdentityOf(result.record) };
  } catch (error) { return { pass: false, state: 'unavailable', requiredCount: required.length, missingCount: required.length, record: null, message: brief(error.message) }; }
}

function workFacts({ workspace, copilotHome, planPath }) {
  if (!planPath) return { state: 'not-selected', plan: null, gate: null, intent: null, review: null, proof: null, completion: null };
  const snapshot = snapshotPlan(workspace, planPath);
  if (!snapshot) return { state: 'unavailable', plan: { path: planPath }, gate: null, intent: null, review: null, proof: null, completion: null };
  const { plan } = snapshot, options = { workspace, plan, copilotHome };
  const safe = fn => { try { return fn(); } catch (error) { return { pass: false, message: brief(error.message) }; } };
  const policy = loadPolicy(workspace, null, { copilotHome }), evidence = readEvidence(workspace, plan.path);
  const proof = safe(() => validateEvidence({ ...options, evidence, maxAgeHours: policy.evidenceTtlHours }));
  const gate = safe(() => runGate({ workspace, flags: { plan: plan.path, copilotHome, dryRun: true }, planOverride: plan }));
  const intent = resolveObligation(workspace, plan, '');
  const completion = safe(() => validateCompletion(options));
  const completionPath = `.harness/completions/${recordHash(plan.path)}.json`;
  return { state: 'observed', plan: { ...snapshot.source, status: plan.status, intentPolicy: plan.fm.intent_source_policy || 'legacy-paths-only' }, gate: { pass: Boolean(gate.pass), reason: brief(gate.blockedReason || gate.message) }, intent: { count: intent.paths.length, selection: intent.reason, source: snapshot.source }, review: reviewCoverageFacts(options), proof: { pass: Boolean(proof.pass), observedOutcome: evidence?.outcome || null, message: brief(proof.message), source: evidence?.evidencePath ? source(workspace, evidence.evidencePath)?.ref || null : null }, completion: { pass: Boolean(completion.pass), message: brief(completion.message), source: source(workspace, completionPath)?.ref || null } };
}

function declaredGraph(root, directories) {
  const nodes = [], edges = [], diagnostics = [];
  for (const dir of directories) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, dir)).filter(n => n.endsWith('.agent.md')).sort(); } catch { continue; }
    for (const name of names) {
      const rel = `${dir}/${name}`, s = source(root, rel);
      if (!s) { diagnostics.push({ path: rel, reason: 'agent source unavailable or unsafe' }); continue; }
      let fm;
      try { fm = YAML.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(s.text)?.[1] || '', { maxAliasCount: 50 }); } catch { fm = null; }
      if (!fm || typeof fm !== 'object') { diagnostics.push({ path: rel, reason: 'agent frontmatter unavailable' }); continue; }
      const id = `n${hash(rel).slice(0, 16)}`, canonical = name.replace(/\.agent\.md$/, '');
      nodes.push({ id, name: canonical, source: s.ref });
      if (fm.agents !== undefined && (!Array.isArray(fm.agents) || fm.agents.some(v => typeof v !== 'string'))) diagnostics.push({ path: rel, reason: 'unsupported delegation declaration' });
      for (const target of Array.isArray(fm.agents) ? fm.agents.filter(v => typeof v === 'string') : []) edges.push({ from: id, target, kind: 'delegation', source: s.ref });
      for (const handoff of Array.isArray(fm.handoffs) ? fm.handoffs : []) if (typeof handoff?.agent === 'string') edges.push({ from: id, target: handoff.agent, kind: 'handoff', source: s.ref });
    }
  }
  for (const edge of edges) {
    const found = nodes.filter(n => n.name === edge.target);
    edge.resolution = found.length === 1 ? 'declared' : found.length ? 'ambiguous' : 'missing';
    edge.to = found.length === 1 ? found[0].id : null;
  }
  const label = name => inertLine(name).replace(/["<>]/g, '').replace(/[\[\]{};`]/g, '').slice(0, 100);
  const mermaid = ['graph TD', ...nodes.map(n => `  ${n.id}["${label(n.name)}"]`), ...edges.filter(e => e.to).map(e => `  ${e.from} -->|${e.kind}| ${e.to}`)].join('\n');
  return { root, assurance: 'declared-only; inferred architecture requires agent analysis', counts: { nodes: nodes.length, edges: edges.length }, nodes, edges, diagnostics, mermaid };
}

export function buildFactualReport({ workspace, copilotHome, planPath = null, maxBytes = 16384 }) {
  if (!Number.isInteger(maxBytes) || maxBytes < 2048 || maxBytes > 65536) throw Object.assign(new Error('Factual report --max-bytes must be 2048–65536'), { exit: 2, code: 'E_USAGE' });
  const diagnostics = [], versions = [], extensions = Object.create(null), directories = Object.create(null);
  const listed = spawnGitSync(['ls-files', '-c', '-o', '--exclude-standard', '-z'], { cwd: workspace, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  const paths = listed.status === 0 ? [...new Set(listed.stdout.split('\0').filter(Boolean))].sort() : null;
  const regular = [];
  for (const rel of paths || []) {
    const full = assertNoSymlinkAncestors(workspace, rel);
    try { if (!full || !fs.lstatSync(full).isFile()) { diagnostics.push({ path: rel, reason: 'nonregular or unsafe file excluded' }); continue; } } catch { diagnostics.push({ path: rel, reason: 'listed file disappeared' }); continue; }
    regular.push(rel);
    const ext = path.extname(rel) || '(none)', dir = rel.includes('/') ? rel.split('/')[0] : '(root)';
    extensions[ext] = (extensions[ext] || 0) + 1; directories[dir] = (directories[dir] || 0) + 1;
    if (/\/(?:node_modules|vendor)\//.test(`/${rel}`)) continue;
    if (!/(?:^|\/)(?:package\.json|package-lock\.json|pom\.xml|pyproject\.toml|go\.mod|build\.gradle(?:\.kts)?|pnpm-lock\.yaml|yarn\.lock)$/.test(rel)) continue;
    const s = source(workspace, rel);
    if (!s) { diagnostics.push({ path: rel, reason: 'manifest unavailable or exceeds 1 MiB' }); continue; }
    if (!rel.endsWith('.json')) { diagnostics.push({ path: rel, reason: 'unsupported version parser; retrieve source for interpretation' }); continue; }
    try {
      const data = JSON.parse(s.text);
      if (path.basename(rel) === 'package.json') {
        if (typeof data.version === 'string') versions.push({ name: data.name || rel, version: data.version, assurance: 'declared-manifest', source: s.ref });
        for (const [name, version] of Object.entries({ ...data.dependencies, ...data.devDependencies })) if (typeof version === 'string') versions.push({ name, version, assurance: 'declared-range', source: s.ref });
      } else if ([2, 3].includes(data.lockfileVersion) && data.packages) {
        for (const [name, config] of Object.entries(data.packages)) if (name && typeof config.version === 'string') versions.push({ name: name.split('node_modules/').at(-1), version: config.version, assurance: 'resolved-lock', source: s.ref });
      } else diagnostics.push({ path: rel, reason: 'unsupported lockfile version' });
    } catch { diagnostics.push({ path: rel, reason: 'malformed JSON manifest' }); }
  }
  const plans = planStateFacts(workspace), named = loadNamedChecks(workspace);
  const checkPath = named.sourceMode === 'local' ? named.source : CHECKS_REL;
  const checkSource = named.sourceRoot && named.source ? source(named.sourceRoot, named.source)?.ref || null : null;
  if (checkSource && named.sourceMode === 'shared') checkSource.path = CHECKS_REL;
  const checks = Object.entries(named.checks || {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, config]) => ({ name, proof: config?.proof || 'behavior', validation: validateCommand(name, config), source: checkSource }));
  if (named.error) diagnostics.push({ path: checkPath, reason: named.error });
  const index = indexStatus({ workspace, copilotHome });
  const plane = value => ({ state: !value?.indexed ? 'missing' : value.unreadable?.length ? 'unreadable' : value.stale ? 'stale' : 'current', indexedHead: value?.indexedHead || null, currentHead: value?.currentHead || null });
  const completions = [];
  for (const row of plans.rows.filter(p => p.status === 'done')) {
    const rel = `.harness/completions/${recordHash(row.path)}.json`, record = readReviewRecord(workspace, rel), p = snapshotPlan(workspace, row.path);
    let current;
    try { current = p ? validateCompletion({ workspace, plan: p.plan, copilotHome }).pass : false; } catch { current = false; }
    completions.push({ plan: row.path, current, id: record?.id || null, completedAt: record?.completedAt || null, source: source(workspace, rel)?.ref || null, verification: record?.value?.verificationIdentity || null, review: record?.value?.review || null, learning: record?.value?.learning || null });
  }
  const result = { schema: 1, status: 'ok', files: { state: paths ? 'observed' : 'unavailable', total: paths ? regular.length : null, inventoryDigest: paths ? hash(JSON.stringify(regular)) : null, extensions, directories }, versions, plans: { ...plans, diagnostics: undefined }, checks, productGraph: declaredGraph(workspace, ['.github/agents', '.copilot/agents']), harnessGraph: declaredGraph(copilotHome, ['agents']), index: { knowledge: plane(index.knowledge), structural: plane(index.structural) }, work: workFacts({ workspace, copilotHome, planPath }), completions, diagnostics: [...diagnostics, ...plans.diagnostics], omitted: {}, retrieval: 'Use lookup/get on source paths; report --facts --max-bytes 65536 for more rows. Graph roots separate product and installed capabilities.' };
  const collections = [['versions', result, 'versions'], ['plans', result.plans, 'rows'], ['checks', result, 'checks'], ['productNodes', result.productGraph, 'nodes'], ['productEdges', result.productGraph, 'edges'], ['harnessNodes', result.harnessGraph, 'nodes'], ['harnessEdges', result.harnessGraph, 'edges'], ['completions', result, 'completions'], ['diagnostics', result, 'diagnostics'], ['productDiagnostics', result.productGraph, 'diagnostics'], ['harnessDiagnostics', result.harnessGraph, 'diagnostics'], ['extensions', result.files, 'extensions'], ['directories', result.files, 'directories'], ['planStatuses', result.plans, 'counts']];
  const entries = collections.map(([key, obj, field]) => ({ key, obj, field, rows: Array.isArray(obj[field]) ? obj[field] : Object.keys(obj[field]) }));
  for (const entry of entries) entry.originalSize = entry.rows.length;
  result.productGraph.mermaid = result.productGraph.nodes.length <= 100 ? result.productGraph.mermaid : null;
  result.harnessGraph.mermaid = result.harnessGraph.nodes.length <= 100 ? result.harnessGraph.mermaid : null;
  const bytes = () => Buffer.byteLength(JSON.stringify(result)) + 1;
  if (bytes() > maxBytes) { result.productGraph.mermaid = null; result.harnessGraph.mermaid = null; }
  while (bytes() > maxBytes && entries.some(entry => entry.rows.length)) {
    for (const entry of entries) {
      const retained = Math.floor(entry.rows.length / 2);
      if (!Array.isArray(entry.obj[entry.field])) for (const key of entry.rows.slice(retained)) delete entry.obj[entry.field][key];
      entry.rows.length = retained;
      if (entry.originalSize > retained) result.omitted[entry.key] = entry.originalSize - retained;
    }
  }
  if (bytes() > maxBytes) throw Object.assign(new Error('Mandatory facts exceed the requested byte budget; increase --max-bytes'), { code: 'E_USAGE', exit: 2 });
  return result;
}
