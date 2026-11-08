import fs from 'node:fs';
import path from 'node:path';
import { safeResolveUnderRoot } from '../path-safe.mjs';

/** Directories never worth offering. Listing them buries the repository's own
 * files under machinery nobody types a path into by hand. */
const SKIP = new Set(['.git', 'node_modules', '.harness', 'dist', 'build', '.next', '.venv', '__pycache__', '.worktrees', '.claude']);

/** How many rows the chooser can show. More than this and the list has stopped
 * being a completion. */
export const MAX_RESULTS = 8;
/** Directories descended when the prefix names no directory of its own. Bounds
 * the cost of `@` on a large repository, which is otherwise a full walk on a
 * keystroke. */
const MAX_SCAN = 4000;

function listDir(root, relDir) {
  let full;
  try {
    full = relDir ? safeResolveUnderRoot(root, relDir) : root;
  } catch {
    return [];
  }
  try {
    return fs.readdirSync(full, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function completePath(prefix, { workspace = process.cwd(), limit = MAX_RESULTS } = {}) {
  const raw = String(prefix ?? '');
    if (raw.startsWith('/') || raw.startsWith('\\') || raw.split(/[\\/]/).includes('..')) return [];

  const endsWithSep = /[\\/]$/.test(raw);
  const normalized = raw.replace(/\\/g, '/');
  const dir = endsWithSep ? normalized.replace(/\/$/, '') : path.posix.dirname(normalized);
  const base = endsWithSep ? '' : path.posix.basename(normalized);
  const relDir = dir === '.' || dir === '' ? '' : dir;

  const entries = listDir(workspace, relDir);
  const wanted = base.toLowerCase();
  const scored = [];
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    if (!base && entry.name.startsWith('.')) continue; // hidden files only when asked for by name
    const name = entry.name;
    const lower = name.toLowerCase();
    let score;
    if (!wanted) score = 0;
    else if (lower === wanted) score = 4;
    else if (lower.startsWith(wanted)) score = 3;
    else if (lower.includes(wanted)) score = 2;
    else continue;
    const isDir = entry.isDirectory();
    const rel = relDir ? `${relDir}/${name}` : name;
    scored.push({ path: isDir ? `${rel}/` : rel, name, kind: isDir ? 'dir' : 'file', score });
  }

    if (!scored.length && base && !relDir) {
    for (const hit of walk(workspace, wanted, limit)) scored.push(hit);
  }

  scored.sort((a, b) => (
    b.score - a.score
    || a.path.split('/').length - b.path.split('/').length
    || (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1)
    || a.path.localeCompare(b.path)
  ));
  return scored.slice(0, limit);
}

/** A bounded breadth-first walk. Breadth-first because the file someone means
 * is far more often near the root than deep in a tree. */
function* walk(root, wanted, limit) {
  const queue = [''];
  let seen = 0;
  let found = 0;
  while (queue.length && seen < MAX_SCAN && found < limit) {
    const rel = queue.shift();
    for (const entry of listDir(root, rel)) {
      if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
      seen += 1;
      if (seen > MAX_SCAN) return;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { queue.push(child); continue; }
      if (entry.name.toLowerCase().includes(wanted)) {
        found += 1;
        yield { path: child, name: entry.name, kind: 'file', score: 1 };
        if (found >= limit) return;
      }
    }
  }
}
