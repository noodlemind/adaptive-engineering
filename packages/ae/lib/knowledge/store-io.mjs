import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MAX_BYTES,
  readFileNoFollow,
  writeFileContained,
  appendFileContained,
  assertNoSymlinkAncestors,
  assertRealpathContained,
} from '../fs-safe.mjs';

/** Quarantine bucket for planted symlinks. Gitignored by the store `.gitignore`
 * (S2), so a quarantined link is never staged into store history nor swept by
 * `git clean -fd`. */
export const QUARANTINE_DIR = '.quarantine';

const STORE_ROOT_FILES = new Set([
  'INDEX.md',
  'consolidated.jsonl',
  'governance.jsonl',
  'config.json',
  'store.json',
  'stale.json',
  '.gitignore',
]);
const BUCKET_FILES = new Set(['INDEX.md', 'consolidated.jsonl', 'meta.json']);

const NESTED_STORE_FILES = new Set(['.git/harness-txn.json', '.lock/owner.json']);

const STORE_PARENT_DIR = 'knowledge';

function isPlausibleStoreRoot(storeRoot) {
  return path.basename(path.dirname(storeRoot)) === STORE_PARENT_DIR;
}

function parts(rootParts, full, kind, bucket) {
  const storeRoot = rootParts.join(path.sep) || path.sep;
  if (!isPlausibleStoreRoot(storeRoot)) return null;
  const rel = path.relative(storeRoot, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return { storeRoot, rel, full, kind, bucket };
}

export function storePathParts(file) {
  if (typeof file !== 'string' || !file) return null;
  const full = path.resolve(file);
  const seg = full.split(path.sep);
  const n = seg.length;
  const at = (i) => (i >= 0 && i < n ? seg[i] : undefined);

  // <layerRoot>/learnings/<domain>/<slug>.md — exactly one domain level.
  if (n >= 4 && at(n - 3) === 'learnings' && at(n - 2) && String(at(n - 1)).endsWith('.md')) {
    const layerParts = seg.slice(0, n - 3);
    const isBucket = layerParts.length >= 2 && layerParts[layerParts.length - 2] === 'branches';
    const rootParts = isBucket ? layerParts.slice(0, layerParts.length - 2) : layerParts;
    return parts(rootParts, full, 'learning', isBucket);
  }
  // <storeRoot>/.git/harness-txn.json, <storeRoot>/.lock/owner.json
  if (n >= 3 && NESTED_STORE_FILES.has(`${at(n - 2)}/${at(n - 1)}`)) {
    return parts(seg.slice(0, n - 2), full, 'nested', false);
  }
    if (n >= 4 && at(n - 3) === 'branches' && at(n - 2) && BUCKET_FILES.has(at(n - 1))) {
    return parts(seg.slice(0, n - 3), full, 'bucket-meta', true);
  }
  // <storeRoot>/<store metadata>
  if (n >= 3 && at(n - 2) === 'operations' && /^[a-f0-9]{64}\.json$/.test(at(n - 1))) {
    return parts(seg.slice(0, n - 2), full, 'operation', false);
  }
  if (n >= 2 && STORE_ROOT_FILES.has(at(n - 1))) {
    return parts(seg.slice(0, n - 1), full, 'store-meta', false);
  }
  return null;
}

/** The learning-only view of the same derivation: used by the learning-specific
 * wrappers below so a caller reaching for `writeLearningFile` can never be
 * handed a metadata path (and vice versa). */
export function learningPathParts(file) {
  const p = storePathParts(file);
  return p && p.kind === 'learning' ? p : null;
}

export function storeFileState(file) {
  const p = storePathParts(file);
  if (!p) return 'blocked';
  if (!assertNoSymlinkAncestors(p.storeRoot, path.dirname(p.rel))) return 'blocked';
  let stat;
  try {
    stat = fs.lstatSync(p.full);
  } catch {
    return 'absent';
  }
  if (stat.isSymbolicLink()) return 'symlink';
  return stat.isFile() ? 'file' : 'other';
}

export function readStoreFile(file) {
  const p = storePathParts(file);
  if (!p) return null;
    if (!assertNoSymlinkAncestors(p.storeRoot, p.rel)) return null;
  return readFileNoFollow(p.full, { root: p.storeRoot, maxBytes: DEFAULT_MAX_BYTES });
}

export function writeStoreFile(file, content) {
  const p = storePathParts(file);
  if (!p) return false;
  quarantineSymlinkedStorePath(p.full);
  return Boolean(writeFileContained(p.storeRoot, p.rel, content));
}

export function appendStoreFile(file, content, { newlineGuard = false } = {}) {
  const p = storePathParts(file);
  if (!p) return false;
  quarantineSymlinkedStorePath(p.full);
  return Boolean(appendFileContained(p.storeRoot, p.rel, content, { newlineGuard }));
}

export function removeStoreFile(file) {
  const p = storePathParts(file);
  if (!p) return false;
  const full = assertRealpathContained(p.storeRoot, p.rel);
  if (!full) return false;
  try {
    fs.rmSync(full, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function quarantineSymlinkedStorePath(file) {
  const p = storePathParts(file);
  if (!p) return null;
  return quarantineLink(p.storeRoot, p.rel);
}

function quarantineLink(storeRoot, rel) {
  if (!assertNoSymlinkAncestors(storeRoot, path.dirname(rel))) return null;
  const full = path.join(storeRoot, rel);
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch {
    return null; // nothing there (or unreadable) — nothing to quarantine
  }
  if (!stat.isSymbolicLink()) return null;
  const destRel = path.join(QUARANTINE_DIR, `${rel.split(path.sep).join('__')}.${Date.now()}-${process.pid}.symlink`);
  const dest = assertNoSymlinkAncestors(storeRoot, destRel);
  if (!dest) return null;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(full, dest);
  } catch {
    return null;
  }
  return destRel.split(path.sep).join('/');
}

/** `learnings/` and, one level down, its domain directories. A store `learnings`
 * directory may contain ONLY real domain directories, so ANY symlink directly
 * inside it is a plant regardless of name. */
function scanLearningsTree(storeRoot, layerRel, found) {
  const rel = layerRel ? path.join(layerRel, 'learnings') : 'learnings';
  const full = path.join(storeRoot, rel);
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch {
    return; // absent — nothing to scan
  }
  if (stat.isSymbolicLink()) {
    found.push(rel);
    return; // never descend through a link
  }
  if (!stat.isDirectory()) return;
  let entries;
  try {
    entries = fs.readdirSync(full, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) found.push(path.join(rel, e.name));
  }
}

export function findSymlinkedStoreDirectories(storeRoot) {
  const root = path.resolve(storeRoot);
  if (!isPlausibleStoreRoot(root)) return [];
  const found = [];
  scanLearningsTree(root, '', found);
  const branchesFull = path.join(root, 'branches');
  let branchesStat = null;
  try {
    branchesStat = fs.lstatSync(branchesFull);
  } catch {
    branchesStat = null;
  }
  if (branchesStat) {
    if (branchesStat.isSymbolicLink()) {
      found.push('branches');
    } else if (branchesStat.isDirectory()) {
      let keys = [];
      try {
        keys = fs.readdirSync(branchesFull, { withFileTypes: true });
      } catch {
        keys = [];
      }
      for (const k of keys) {
        const keyRel = path.join('branches', k.name);
        if (k.isSymbolicLink()) found.push(keyRel);
        else if (k.isDirectory()) scanLearningsTree(root, keyRel, found);
      }
    }
  }
  return found.map((r) => r.split(path.sep).join('/'));
}

export function reclaimSymlinkedStoreDirectory(storeRoot, rel) {
  const root = path.resolve(storeRoot);
  if (!isPlausibleStoreRoot(root)) return { quarantined: null, ok: false };
  const relNative = String(rel).split('/').join(path.sep);
  const quarantinedTo = quarantineLink(root, relNative);
  if (!quarantinedTo) return { quarantined: null, ok: false };
  const full = assertNoSymlinkAncestors(root, relNative);
  if (!full) return { quarantined: quarantinedTo, ok: false };
  try {
    fs.mkdirSync(full, { recursive: true });
  } catch {
    return { quarantined: quarantinedTo, ok: false };
  }
  return { quarantined: quarantinedTo, ok: true };
}

/** Read a learning file, or null when it must not be read (see readStoreFile). */
export function readLearningFile(file) {
  return learningPathParts(file) ? readStoreFile(file) : null;
}

/** Contained, atomic learning write. False on any refusal. */
export function writeLearningFile(file, content) {
  return learningPathParts(file) ? writeStoreFile(file, content) : false;
}

/** Remove a learning file; refuses a symlink or an escaping path. */
export function removeLearningFile(file) {
  return learningPathParts(file) ? removeStoreFile(file) : false;
}

/** Quarantine a symlink planted at a LEARNING path (absorb's reporting path). */
export function quarantineSymlinkedLearning(file) {
  return learningPathParts(file) ? quarantineSymlinkedStorePath(file) : null;
}
