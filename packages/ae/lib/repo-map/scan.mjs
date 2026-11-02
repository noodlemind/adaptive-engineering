import { spawnGitSync } from '../../corpus/hooks/lib/git-executable.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { SOURCE_EXTENSIONS } from './lexical-extractor.mjs';
import { readFileNoFollow, assertNoSymlinkAncestors } from '../fs-safe.mjs';

export const MAX_FILES_SCANNED = 4000;
export const MAX_FILE_BYTES = 200_000;

function filePrefix(prefix) {
  if (typeof prefix !== 'string' || !prefix) return '';
  const scope = prefix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!scope || scope.startsWith('/') || /^[A-Za-z]:/.test(scope) || scope.includes('\0')) return '';
  if (scope.split('/').includes('..')) return '';
  return scope;
}

export function listRepoFiles(workspace, { prefix = '' } = {}) {
  const scope = filePrefix(prefix);
  const args = ['-C', workspace, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  if (scope) args.push('--', scope);
  const res = spawnGitSync(args, {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error?.code === 'ENOENT') {
    return { files: [], total: 0, truncated: false, unavailable: true, fallback: 'git is not installed or not on PATH. Use the host search/codebase tool' };
  }
  if (res.error || res.status !== 0) {
    return { files: [], total: 0, truncated: false, unavailable: true, fallback: 'git ls-files failed. Use the host search/codebase tool' };
  }
  const all = [...new Set(res.stdout.split('\0').filter(Boolean))].sort();
  const cap = MAX_FILES_SCANNED;
  return {
    files: all.slice(0, cap),
    total: all.length,
    truncated: all.length > cap,
    unavailable: false,
    fallback: null,
  };
}

export function trackedSourceFiles(workspace) {
  const res = spawnGitSync(['-C', workspace, 'ls-files', '-z'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
  if (res.error || res.status !== 0) return { files: [], total: 0, inventoryHash: null, unavailable: true };
  const all = [...new Set(res.stdout
    .split('\0')
    .filter(Boolean)
    .filter((rel) => SOURCE_EXTENSIONS.has(path.extname(rel).toLowerCase())))].sort();
  return { files: all.slice(0, MAX_FILES_SCANNED), total: all.length, inventoryHash: createHash('sha256').update(JSON.stringify(all)).digest('hex'), unavailable: false };
}

export function inspectSourceFile(workspace, rel, { maxBytes = MAX_FILE_BYTES } = {}) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel)) return { state: 'excluded' };
  const full = assertNoSymlinkAncestors(workspace, rel);
  if (!full || full === path.resolve(workspace)) return { state: 'excluded' };
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  if (!stat.isFile()) return { state: 'excluded' };
  if (stat.size > maxBytes) return { state: 'oversized', size: stat.size };
  const bytes = readFileNoFollow(full, { root: workspace, maxBytes, encoding: null });
  if (bytes === null) return { state: 'unreadable' };
  if (bytes.includes(0)) return { state: 'unsupported', size: bytes.length };
  return { state: 'readable', hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, content: bytes.toString('utf8'), mtime: stat.mtimeMs };
}

export function readSourceFile(workspace, rel) {
  return inspectSourceFile(workspace, rel).content ?? null;
}

export function readFileSafe(workspace, rel) {
  return readSourceFile(workspace, rel) ?? '';
}
