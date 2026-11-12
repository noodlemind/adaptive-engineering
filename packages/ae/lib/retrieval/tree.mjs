import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from '../style.mjs';
import { redactSecrets } from '../secret-scan.mjs';
import { safeResolveUnderRoot } from '../path-safe.mjs';
import { listRepoFiles, trackedSourceFiles } from '../repo-map/scan.mjs';
import { loadManifest } from '../recall-rank.mjs';
import { loadCollections, entryMatchesCollection } from '../recall-config.mjs';
import { storeDir, listLearnings } from '../knowledge/store.mjs';
import { consolidateStatus } from '../knowledge/consolidate.mjs';

export const TREE_SCHEMA = 1;

/** The subjects this phase implements, in the order the architecture doc lists them. */
export const TREE_SUBJECTS = Object.freeze(['workspace', 'knowledge']);

export const PENDING_SUBJECTS = Object.freeze({
  run: 'Phase 4a (durable runs)',
  resources: 'Phase 5 (resources and plugins)',
});

export const DEFAULT_DEPTH = 3;

export const MAX_DEPTH = 10;

export const MAX_NODES = 2000;

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

function notFoundError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_NOT_FOUND', exit: EXIT.notFound, hint });
}

function resolveDepth(depth) {
  if (depth === undefined || depth === null || depth === '') return DEFAULT_DEPTH;
  const n = Number(depth);
    if (!Number.isInteger(n) || n < 1) {
    throw usageError(`--depth must be a whole number of levels, got ${JSON.stringify(depth)}`, `1..${MAX_DEPTH}`);
  }
  if (n > MAX_DEPTH) {
    throw usageError(`--depth ${n} exceeds the maximum of ${MAX_DEPTH}`, `use --depth ${MAX_DEPTH} or less`);
  }
  return n;
}

function normalizeRelative(raw) {
  const posixish = String(raw).replace(/\\/g, '/');
  if (posixish.startsWith('/') || /^[A-Za-z]:/.test(posixish)) return null;
  const norm = path.posix.normalize(posixish).replace(/\/+$/, '');
  if (norm === '.' || norm === '') return '';
  if (norm === '..' || norm.startsWith('../')) return null;
  return norm;
}

function makeNode({ name, type, kind = null, title = null, location = null, status = null, counts = null }) {
    const node = { name, type };
  if (kind) node.kind = kind;
  if (title) node.title = title;
  if (location) node.location = location;
  if (status) node.status = status;
  node.children = [];
  node.counts = counts || { files: 0, dirs: 0 };
  return node;
}

function compareNodes(a, b) {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function sortTree(node) {
  node.children.sort(compareNodes);
  for (const child of node.children) sortTree(child);
  return node;
}

function subtreeSize(node) {
  let n = 1;
  for (const child of node.children) n += subtreeSize(child);
  return n;
}

/** Pre-order budgeted clone: keep the first `remaining` nodes, drop the rest. */
function applyNodeCap(node, state) {
  if (state.remaining <= 0) {
    state.dropped += subtreeSize(node);
    return null;
  }
  state.remaining -= 1;
  const out = { ...node, children: [] };
  for (const child of node.children) {
    const kept = applyNodeCap(child, state);
    if (kept) out.children.push(kept);
  }
  return out;
}

function buildTree({ rootName, rows, depth, maxNodes }) {
    const byKey = new Map();
  for (const row of rows) {
    const key = row.parts.map((p) => p.name).join('/');
    if (!byKey.has(key)) byKey.set(key, row);
  }
  const unique = [...byKey.keys()].sort().map((k) => byKey.get(k));

  const counts = new Map();
  const bump = (key) => {
    let c = counts.get(key);
    if (!c) {
      c = { files: 0, dirs: 0 };
      counts.set(key, c);
    }
    return c;
  };
  const dirPrefixes = new Set();

  for (const row of unique) {
    let prefix = '';
    bump(prefix).files += 1;
    for (const part of row.parts.slice(0, -1)) {
      prefix = prefix ? `${prefix}/${part.name}` : part.name;
      bump(prefix).files += 1;
      dirPrefixes.add(prefix);
    }
  }
  for (const dir of dirPrefixes) {
    let prefix = '';
    bump(prefix).dirs += 1;
    for (const seg of dir.split('/').slice(0, -1)) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      bump(prefix).dirs += 1;
    }
  }

  const rootCounts = counts.get('') || { files: 0, dirs: 0 };
  const root = makeNode({ name: rootName, type: 'dir', counts: rootCounts });
  const index = new Map([['', root]]);

  for (const row of unique) {
    const dirs = row.parts.slice(0, -1);
    let prefix = '';
    let parent = root;
    let level = 0;
    for (const part of dirs) {
      level += 1;
      if (level > depth) break;
      prefix = prefix ? `${prefix}/${part.name}` : part.name;
      let node = index.get(prefix);
      if (!node) {
        node = makeNode({ ...part, type: 'dir', counts: counts.get(prefix) });
        index.set(prefix, node);
        parent.children.push(node);
      }
      parent = node;
    }
    if (dirs.length + 1 <= depth) {
      parent.children.push(makeNode({ ...row.parts[row.parts.length - 1], type: 'file' }));
    }
  }

  sortTree(root);
  const total = subtreeSize(root);
    const cap = Math.max(1, Math.min(Number(maxNodes) || MAX_NODES, MAX_NODES));
  const state = { remaining: cap, dropped: 0 };
  const capped = applyNodeCap(root, state);

  return {
    root: capped,
    files: rootCounts.files,
    dirs: rootCounts.dirs,
    nodes: total - state.dropped,
    nodesDropped: state.dropped,
  };
}

function workspaceTree({ workspace, target, depth, maxNodes }) {
  const root = path.resolve(workspace);
  const { files, total } = trackedSourceFiles(root);

  let scope = '';
  if (target) {
    const rel = normalizeRelative(target);
    if (rel === null || (rel !== '' && !safeResolveUnderRoot(root, rel))) {
      throw usageError(`path escapes the workspace: ${target}`, 'tree workspace <workspace-relative-path>');
    }
    scope = rel;
  }

    const scopedFile = scope && files.includes(scope);
  const prefix = scope ? `${scope}/` : '';
  const rels = scopedFile
    ? [path.posix.basename(scope)]
    : files.filter((f) => !scope || f.startsWith(prefix)).map((f) => (scope ? f.slice(prefix.length) : f));

  const rootName = scopedFile ? path.posix.dirname(scope) : scope || '.';
  const built = buildTree({
    rootName,
    rows: rels.map((rel) => ({ parts: rel.split('/').map((name) => ({ name })) })),
    depth,
    maxNodes,
  });

    const filesUnscanned = Math.max(0, total - files.length);
  return {
    schema: TREE_SCHEMA,
    subject: 'workspace',
    target: scope || null,
    depth,
    root: built.root,
    totals: { files: built.files, dirs: built.dirs, nodes: built.nodes, tracked: total },
    truncated: built.nodesDropped > 0 || filesUnscanned > 0,
    limits: { depth, maxNodes: MAX_NODES, nodesDropped: built.nodesDropped, filesUnscanned },
        emptyReason: built.files > 0 || built.dirs > 0
      ? null
      : total > 0
        ? scope
          ? `no source files under ${scope} — this tree covers tracked source files, and other file types are not enumerated`
          : 'no source files are tracked in this workspace'
        : 'no tracked files — run this inside a git repository with committed files',
  };
}

/** Manifest free text can carry a pasted credential; a null stays null. */
function clean(value) {
  if (value === undefined || value === null || value === '') return null;
  return redactSecrets(String(value));
}

function knowledgeTree({ workspace, copilotHome, home, target, depth, maxNodes }) {
  const collections = loadCollections(copilotHome, workspace) || {};
  const names = Object.keys(collections).sort();
  if (target && !collections[target]) {
    throw notFoundError(
      `unknown knowledge collection: ${target}`,
      names.length
        ? `collections defined here: ${names.join(', ')}`
        : 'no collections are defined — add a collections.yaml under the knowledge root',
    );
  }

  const manifest = loadManifest(copilotHome, workspace, { home });
  if (manifest.error) throw new Error(manifest.error);
  const rows = [];
  for (const entry of manifest.entries || []) {
    if (!entry || typeof entry !== 'object') continue;
    if (!entryMatchesCollection(entry, target || null, collections)) continue;
    const id = clean(entry.docid || entry.id || entry.path);
    if (!id) continue;
    rows.push({
      parts: [
        { name: String(entry.scope || 'unscoped'), kind: 'scope' },
        { name: clean(entry.category) || 'uncategorized', kind: 'category' },
        { name: id, kind: 'document', title: clean(entry.title), location: clean(entry.path) },
      ],
    });
  }

  const dir = storeDir(workspace, { home });
    const hasStore = fs.existsSync(dir);
    if (hasStore && !target) {
    for (const learning of listLearnings(dir)) {
      rows.push({
        parts: [
          { name: 'learnings', kind: 'learnings' },
          { name: clean(learning.domain) || 'uncategorized', kind: 'domain' },
          {
            name: clean(learning.slug || learning.id) || 'unnamed',
            kind: 'learning',
            title: clean(learning.fm?.trigger),
            location: null,
                        status: clean(learning.fm?.status) || 'active',
          },
        ],
      });
    }
  }

    if (hasStore && !target) {
    try {
      for (const episode of consolidateStatus({ workspace, copilotHome, withRecheck: false }).quarantined || []) {
        const id = clean(episode.path);
        if (!id) continue;
        rows.push({
          parts: [
            { name: 'quarantined', kind: 'quarantined' },
            {
              name: id,
              kind: 'episode',
              title: clean(episode.failure) || 'quarantined after repeated consolidation failures',
              location: id,
              status: 'quarantined',
            },
          ],
        });
      }
    } catch {
      // Advisory only — the rest of the corpus still renders.
    }
  }

  const built = buildTree({ rootName: 'knowledge', rows, depth, maxNodes });
  return {
    schema: TREE_SCHEMA,
    subject: 'knowledge',
    target: target || null,
    depth,
    root: built.root,
    totals: { files: built.files, dirs: built.dirs, nodes: built.nodes },
    truncated: built.nodesDropped > 0,
    limits: { depth, maxNodes: MAX_NODES, nodesDropped: built.nodesDropped, filesUnscanned: 0 },
    collections: names,
    manifest: manifest.path ? { path: manifest.path, updated: manifest.updated ?? null, error: manifest.error ?? null } : null,
    learningsStore: hasStore,
  };
}

export function runTree({ subject, target = null, depth, workspace, copilotHome, home, maxNodes, files = false } = {}) {
  // Default subject for bare `tree` — the workspace map is the common case.
  let resolvedSubject = subject || 'workspace';
  let resolvedTarget = target;
  // Non-subject first tokens: path under workspace if it looks like a path,
  // otherwise a clear usage error (not a cryptic subject list alone).
  if (resolvedSubject && !TREE_SUBJECTS.includes(resolvedSubject)) {
    if (PENDING_SUBJECTS[resolvedSubject]) {
      const pending = PENDING_SUBJECTS[resolvedSubject];
      throw usageError(
        `tree subject "${resolvedSubject}" is not available yet`,
        `${pending} · today: tree workspace | tree knowledge`,
      );
    }
    const looksLikePath = /[./]/.test(resolvedSubject)
      || (workspace && fs.existsSync(path.join(workspace, resolvedSubject)));
    if (looksLikePath) {
      resolvedTarget = resolvedTarget || resolvedSubject;
      resolvedSubject = 'workspace';
    } else {
      throw usageError(
        `unknown tree subject: ${resolvedSubject}`,
        `use workspace or knowledge · for a folder try: tree workspace ${resolvedSubject}`,
      );
    }
  }
  subject = resolvedSubject;
  target = resolvedTarget;
  if (files && subject !== 'workspace') {
    throw usageError('tree --files lists the workspace checkout', 'ae tree workspace --files --json');
  }
  if (files) {
    const scope = target ? normalizeRelative(target) : '';
    // Scope git before the 4,000 path cap. Filtering afterward hides a late folder.
    const listed = listRepoFiles(workspace, scope ? { prefix: scope } : {});
    const filtered = scope ? listed.files.filter((rel) => rel === scope || rel.startsWith(`${scope}/`)) : listed.files;
    return {
      schema: TREE_SCHEMA,
      subject: 'workspace',
      target: scope || null,
      files: filtered,
      total: listed.total,
      truncated: listed.truncated,
      unavailable: listed.unavailable,
      fallback: listed.unavailable ? listed.fallback : 'git ls-files --cached --others --exclude-standard',
      emptyReason: listed.unavailable ? (listed.fallback || 'git ls-files failed; use the host search/codebase tool') : filtered.length ? null : 'no tracked or untracked files',
    };
  }
  const levels = resolveDepth(depth);
  if (subject === 'workspace') return workspaceTree({ workspace, target, depth: levels, maxNodes });
  return knowledgeTree({ workspace, copilotHome, home, target, depth: levels, maxNodes });
}
