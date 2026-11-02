import { spawnGitSync } from '../../corpus/hooks/lib/git-executable.mjs';
import path from 'node:path';
import { tokenize } from '../tokenize.mjs';
import { estimateTokens } from '../token-meter.mjs';
import { extract as lexicalExtract, SOURCE_EXTENSIONS } from './lexical-extractor.mjs';
import { writeFileContained } from '../fs-safe.mjs';
import { codebaseMapWriteRel } from '../project-layout.mjs';
import { trackedSourceFiles, readSourceFile, inspectSourceFile, MAX_FILES_SCANNED } from './scan.mjs';
import { readStructuralIndex } from './structural-index.mjs';
import { importEdges } from './imports.mjs';
import { readFileFacts, FILE_FACTS_VERSION } from './facts.mjs';
import { captureWorkingSources } from './working-sources.mjs';

const DEFAULT_MAX_TOKENS = 1000;

function compareRel(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function requestRel(workspace, raw) {
  let text = String(raw ?? '').trim().replace(/\\/g, '/');
  if (path.isAbsolute(text)) {
    const relative = path.relative(path.resolve(workspace), path.resolve(text));
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      text = relative.split(path.sep).join('/');
    }
  }
  if (text.startsWith('./')) text = text.slice(2);
  return text;
}

function currentStructuralFiles(workspace, home) {
  try {
    const head = spawnGitSync(['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 15_000 });
    if (head.status !== 0) return null;
    const index = readStructuralIndex(workspace, { home, expectedSha: head.stdout.trim() });
    const source = captureWorkingSources(workspace);
    if (!source.valid || index?.meta?.sourceState?.version !== source.state.version || index.meta.sourceState.configDigest !== source.state.configDigest || index.meta.sourceState.extractorRevision !== source.state.extractorRevision) return null;
    return index && !index.unreadable.length && index.meta.fileFactsVersion === FILE_FACTS_VERSION ? index.files : null;
  } catch {
    return null;
  }
}

function fileFacts(workspace, rels, { extract = lexicalExtract, preferStructural = true, home } = {}) {
  const structural = preferStructural ? currentStructuralFiles(workspace, home) : null;
  const { facts } = readFileFacts(workspace, rels, { extract, cachedFiles: structural });
  return { facts, structural: Boolean(structural) };
}


function listTracked(workspace) {
  const res = spawnGitSync(['-C', workspace, 'ls-files', '-z'], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) return [];
  return res.stdout.split('\0').filter(Boolean);
}

function trackedSourceForNeighborhood(sourceFiles, maxFiles, required) {
  const limit = Number.isFinite(maxFiles) && maxFiles >= 0 ? maxFiles : MAX_FILES_SCANNED;
  const chosen = sourceFiles.slice(0, limit);
  const seen = new Set(chosen);
  const tracked = new Set(sourceFiles);
  for (const rel of required) {
    if (!rel || seen.has(rel) || !tracked.has(rel)) continue;
    chosen.push(rel);
    seen.add(rel);
  }
  return chosen;
}

export function buildRepoMap({ workspace, query = '', maxTokens = DEFAULT_MAX_TOKENS, extract = lexicalExtract, title = 'Repo Map', preferStructural = true, home } = {}) {
  const { files, total } = trackedSourceFiles(workspace);
  if (!files.length) return { files: [], body: '', tokens: 0, empty: true };

  const { facts: info, structural } = fileFacts(workspace, files, { extract, preferStructural, home });
  const tiers = { treesitter: 0, lexical: 0, error: 0, unreadable: 0 };
  for (const fact of info.values()) {
    tiers[fact.errors ? 'error' : fact.tier] += 1;
  }
  const { incoming } = importEdges(info, new Set(files));
  for (const fact of info.values()) {
    fact.importedBy = incoming.get(fact.rel)?.length || 0;
  }

  const queryTokens = new Set(tokenize(query));
  const scored = [...info.values()].map((f) => {
    let queryScore = 0;
    if (queryTokens.size) {
      const hay = new Set(tokenize(`${f.rel} ${f.symbols.join(' ')}`));
      for (const t of queryTokens) if (hay.has(t)) queryScore += 1;
    }
    const degreeScore = f.importedBy * 2 + Math.min(f.symbols.length, 12);
    return { ...f, score: queryScore * 5 + degreeScore };
  });
  // Locale-independent tie-break: the committed map must be byte-identical
  // across hosts for the same tree.
  scored.sort((a, b) => b.score - a.score || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const mapTier = [...info.values()].some(fact => fact.tier === 'treesitter') ? 'structural' : 'lexical';
  const summary = `> Deterministic ${mapTier} map of ${total} tracked source files${total > files.length ? ` (top ${files.length} scanned)` : ''}.`;
  const provenance = preferStructural ? ` tree-sitter ${tiers.treesitter}, lexical ${tiers.lexical}, parse errors ${tiers.error}${tiers.unreadable ? `, unreadable ${tiers.unreadable}` : ''}.` : '';
  const lines = [
    `# ${title}`,
    '',
    `${summary}${provenance}${query ? ` Ranked for: "${query}".` : ''}`,
    '',
  ];
  if (estimateTokens(lines.join('\n')) > maxTokens) lines[2] = `${summary}${provenance}`;
  if (estimateTokens(lines.join('\n')) > maxTokens) {
    return { files: [], body: '', tokens: 0, empty: true, totalFiles: total, structural };
  }
  const selected = [];
  for (const f of scored) {
    const symbolList = f.symbols.slice(0, 6).join(', ');
    const entry = `- \`${f.rel}\`${f.importedBy ? ` (imported by ${f.importedBy})` : ''}${symbolList ? ` — ${symbolList}` : ''}`;
    if (estimateTokens([...lines, entry].join('\n')) > maxTokens) break;
    lines.push(entry);
    selected.push(f.rel);
  }

  const body = lines.join('\n');
  return { files: selected, body, tokens: estimateTokens(body), empty: false, totalFiles: total, structural: Boolean(structural) };
}

export function buildNeighborhood({ workspace, files = [], maxFiles = MAX_FILES_SCANNED, home, includeEvidence = false } = {}) {
  const requested = Array.isArray(files) ? files : [files];
  const normalized = requested.map((raw) => ({ raw, rel: requestRel(workspace, raw) }));
  const trackedAll = listTracked(workspace);
  const trackedAllSet = new Set(trackedAll);
  const sourceFiles = trackedAll.filter((rel) => SOURCE_EXTENSIONS.has(path.extname(rel).toLowerCase()));
  const tracked = trackedSourceForNeighborhood(
    sourceFiles,
    maxFiles,
    normalized.map((item) => item.rel),
  );
  const trackedSet = new Set(tracked);
  const inputs = [];
  const missing = [];
  const seenMissing = new Set();
  const seeds = [];
  const plain = [];
  const requestedRels = [];
  const seen = new Set();
  for (const { raw, rel } of normalized) {
    const input = inspectSourceFile(workspace, rel);
    let state = input.state;
    if (['readable', 'oversized'].includes(state) && !trackedAllSet.has(rel)) {
      const ignored = spawnGitSync(['-C', workspace, 'check-ignore', '-q', '--', rel], { timeout: 15_000 });
      state = ignored.status === 1 ? 'new' : 'excluded';
    }
    inputs.push({ rel, state, ...(input.hash ? { hash: input.hash } : {}) });
    if (!['readable', 'new'].includes(state) && !trackedAllSet.has(rel)) {
      if (state === 'missing' && !seenMissing.has(rel)) { seenMissing.add(rel); missing.push(rel); }
      continue;
    }
    if (state === 'new') {
      if (SOURCE_EXTENSIONS.has(path.extname(rel).toLowerCase())) { tracked.push(rel); trackedSet.add(rel); }
      else trackedAllSet.add(rel);
    }
    if (rel && trackedSet.has(rel)) {
      if (!seen.has(rel)) {
        seen.add(rel);
        seeds.push(rel);
        requestedRels.push(rel);
      }
      continue;
    }
    if (rel && trackedAllSet.has(rel)) {
      if (!seen.has(rel)) {
        seen.add(rel);
        plain.push(rel);
        requestedRels.push(rel);
      }
      continue;
    }
    const label = rel || String(raw ?? '');
    if (!seenMissing.has(label)) {
      seenMissing.add(label);
      missing.push(label);
    }
  }
  const hop = new Set(seeds);
  let incoming = new Map();
  const facts = seeds.length ? fileFacts(workspace, tracked, { home }).facts : new Map();
  if (seeds.length) {
    const edges = importEdges(facts, trackedSet);
    incoming = edges.incoming;
    for (const rel of seeds) {
      for (const target of edges.outgoing.get(rel) || []) hop.add(target);
      for (const source of incoming.get(rel) || []) hop.add(source);
    }
  }
  const filesOut = [...hop].sort(compareRel).map((rel) => ({
    rel,
    symbols: facts.get(rel).symbols,
    imports: facts.get(rel).imports,
    importedBy: [...(incoming.get(rel) || [])].sort(compareRel),
    ...(includeEvidence ? { sha256: facts.get(rel).hash } : {}),
  }));
  for (const rel of plain) {
    filesOut.push({ rel, symbols: [], imports: [], importedBy: [] });
  }
  filesOut.sort((a, b) => compareRel(a.rel, b.rel));
  return { files: filesOut, missing, requested: requestedRels, inputs };
}

/**
 * Write the query-less codebase map. Committed docs/codebase-map.md is kept
 * when that file or docs/plans already exists; otherwise the map lives under
 * gitignored .harness/codebase-map.md.
 */
export function writeCodebaseMap({ workspace, dryRun = false, maxTokens = 2500, local = false }) {
  // The map stays lexical-only (preferStructural: false): it must
  // be byte-identical across hosts for the same tree, and whether a given
  // host has built a structural index is host-local state that must never
  // leak into a committed artifact.
  const map = buildRepoMap({ workspace, query: '', maxTokens, title: 'Codebase Map', preferStructural: false });
  if (map.empty) return null;
  const rel = local ? '.harness/codebase-map.md' : codebaseMapWriteRel(workspace);
  if (!dryRun) {
    // Refuse to write through a symlinked `docs/` (or a pre-planted symlink
    // at the target itself) — a naive mkdir+write would otherwise follow
    // either straight out of the workspace. writeFileContained also writes
    // atomically (tmp + rename), so a concurrent reader never observes a
    // partial map.
    const full = writeFileContained(workspace, rel, map.body + '\n');
    if (!full) return null;
  }
  return { path: rel.split(path.sep).join('/'), tokens: map.tokens, files: map.files.length };
}
