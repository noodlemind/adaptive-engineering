import { spawnGitSync } from '../../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { harnessGlobalHome } from '../paths.mjs';
import { repoId } from '../knowledge/store.mjs';
import { currentSnapshotDir, readSnapshot } from './snapshot.mjs';
import { structuralCurrentness } from '../repo-map/working-sources.mjs';

export const STRUCTURAL_SHAPE_VERSION = 2;

const worktreeIds = new Map();

export function worktreeId(workspace) {
  const key = path.resolve(workspace);
  const cached = worktreeIds.get(key);
  if (cached) return cached;
  let root = key;
  const top = spawnGitSync(['-C', key, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 10_000 });
  if (top.status === 0 && top.stdout.trim()) root = top.stdout.trim();
  try {
    root = fs.realpathSync(root);
  } catch {
    // keep the resolved path
  }
  const id = `wt-${crypto.createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
  worktreeIds.set(key, id);
  return id;
}

const EMPTY_FILES = Object.freeze({ version: STRUCTURAL_SHAPE_VERSION, files: {} });
const EMPTY_SYMBOLS = Object.freeze({ version: STRUCTURAL_SHAPE_VERSION, symbols: [] });
const EMPTY_GRAPH = Object.freeze({ version: STRUCTURAL_SHAPE_VERSION, calls: [], modules: [], unresolved: [] });

/** `<home>/index/<repo-id>/<worktree-id>/structural` for this workspace. */
export function structuralCacheDir(workspace, { home } = {}) {
  return path.join(home || harnessGlobalHome(), 'index', repoId(workspace), worktreeId(workspace), 'structural');
}

export function structuralDir(workspace, options = {}) {
  return currentSnapshotDir(structuralCacheDir(workspace, options));
}

export function readStructuralIndex(workspace, options = {}) {
  const root = structuralCacheDir(workspace, options);
  const absent = reason => ({ present: false, reason, dir: root, files: {}, symbols: [], graph: EMPTY_GRAPH, meta: null });
  if (!fs.existsSync(root)) return absent('structural index not found');
  const snapshot = readSnapshot(root);
  if (!snapshot) return absent('structural index has no meta.json');
  if (snapshot.meta && (typeof snapshot.meta.sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(snapshot.meta.sha))) return absent('meta.json has no valid baseline sha');
  const version = snapshot.meta?.version;
  if (version !== undefined && !(Number.isFinite(version) && version <= STRUCTURAL_SHAPE_VERSION)) return absent(`unsupported structural index version ${JSON.stringify(version)} (this harness reads ${STRUCTURAL_SHAPE_VERSION})`);
  if (snapshot.unreadable.length) return absent(`unreadable structural index (${snapshot.unreadable.join('; ')})`);
  if (options.requireCurrent) {
    const freshness = structuralCurrentness(workspace, snapshot.meta);
    if (!freshness.current) return absent(`stale structural index: ${freshness.reason}`);
  }
  return { ...snapshot, present: true, reason: null, files: normalizeFiles(snapshot.files), symbols: normalizeSymbols(snapshot.symbols), graph: normalizeGraph(snapshot.graph) };
}

function normalizeFiles(parsed) {
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY_FILES.files };
  // Wrapper form: { version, files: {...} }. Builder form: the map itself.
  if (parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)) return parsed.files;
  if ('version' in parsed && !('files' in parsed)) return { ...EMPTY_FILES.files };
  return parsed;
}

function normalizeSymbols(parsed) {
  if (!parsed || typeof parsed !== 'object') return [...EMPTY_SYMBOLS.symbols];
  // Wrapper form: { version, symbols: [rows] } already row-shaped.
  if (Array.isArray(parsed.symbols)) return parsed.symbols;
    const rows = [];
  for (const [name, entry] of Object.entries(parsed)) {
    if (name === 'version' || !entry || typeof entry !== 'object') continue;
    const refs = Array.isArray(entry.refs) ? entry.refs : [];
    for (const def of Array.isArray(entry.defs) ? entry.defs : []) {
      if (!def || typeof def.file !== 'string') continue;
      rows.push({
        name,
        file: def.file,
        kind: def.kind || 'symbol',
        exported: def.exported === true,
        def: { line: Number.isFinite(def.line) ? def.line : 0 },
        refs,
      });
    }
  }
  return rows;
}

function normalizeGraph(parsed) {
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY_GRAPH };
  const calls = [];
  for (const edge of Array.isArray(parsed.calls) ? parsed.calls : []) {
    if (!edge || typeof edge.from !== 'string') continue;
    if (typeof edge.symbol === 'string' && Array.isArray(edge.to)) {
      // Builder form: caller file + callee symbol + defining files.
      for (const target of edge.to) {
        const candidates = Array.isArray(edge.candidates) ? edge.candidates.filter(candidate => candidate?.file === target) : [];
        const name = candidates.length && typeof candidates[0].name === 'string' ? candidates[0].name : edge.symbol;
        if (typeof target === 'string') calls.push({
          from: `${edge.from}#${edge.symbol}`, to: `${target}#${name}`,
          relation: edge.relation || 'call-candidate', method: edge.method || 'unknown',
          resolutionStatus: edge.resolutionStatus || (edge.to.length > 1 ? 'ambiguous' : 'candidate'),
          authority: 'descriptive-context',
          ...(['call-site', 'imported-name-reference'].includes(edge.observation) ? { observation: edge.observation } : {}),
          ...(edge.id ? { id: edge.id } : {}), ...(edge.reason ? { reason: edge.reason } : {}),
          ...(Array.isArray(edge.evidence) ? { evidence: edge.evidence } : {}),
          ...(candidates.length ? { candidates } : {}),
        });
      }
    } else if (typeof edge.to === 'string') {
      calls.push({ ...edge, from: edge.from, to: edge.to, relation: edge.relation || 'call-candidate', resolutionStatus: edge.resolutionStatus || 'candidate', authority: 'descriptive-context' });
    }
  }
  const unresolved = [];
  for (const entry of Array.isArray(parsed.unresolved) ? parsed.unresolved : []) {
    if (entry && typeof entry.from === 'string' && typeof entry.to === 'string') unresolved.push(entry);
  }
  for (const entry of Array.isArray(parsed.unresolvedCalls) ? parsed.unresolvedCalls : []) {
    if (entry && typeof entry.from === 'string' && typeof entry.symbol === 'string') {
      unresolved.push({ from: `${entry.from}#${entry.symbol}`, to: entry.symbol });
    }
  }
  for (const entry of Array.isArray(parsed.unresolvedImports) ? parsed.unresolvedImports : []) {
    if (entry && typeof entry.from === 'string' && typeof entry.import === 'string') {
      unresolved.push({ from: entry.from, to: entry.import });
    }
  }
  return {
    calls,
    modules: Array.isArray(parsed.modules) ? parsed.modules : [],
    unresolved,
  };
}
