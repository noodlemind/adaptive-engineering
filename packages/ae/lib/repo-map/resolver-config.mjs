import { spawnGitSync } from '../../corpus/hooks/lib/git-executable.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileNoFollow, assertNoSymlinkAncestors } from '../fs-safe.mjs';
import { sourceMasks } from './occurrences.mjs';

function jsonConfig(text) {
  const masks = sourceMasks('config.ts', text);
  const trailing = /,\s*(?=[}\]])/g;
  const remove = new Set();
  for (const match of masks.text.matchAll(trailing)) if (masks.code[match.index] === ',') remove.add(match.index);
  return JSON.parse(masks.text.split('').filter((_, index) => !remove.has(index)).join(''));
}

/** Only tracked, bounded regular configuration participates in resolution. */
export function loadResolverConfigs(workspace) {
  if (!workspace) return [];
  const listed = spawnGitSync(['-C', workspace, 'ls-files', '-z'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) return [];
  const files = [...new Set(listed.stdout.split('\0').filter(Boolean))].filter(file => /^(?:tsconfig|jsconfig)\.json$/.test(path.posix.basename(file))).sort();
  if (files.length > 64) return [{ directory: '.', unsupported: true, evidence: { path: '', reason: 'configuration-budget' } }];
  const output = [];
  for (const rel of files) {
    const directory = path.posix.dirname(rel);
    const barrier = evidence => output.push({ directory, unsupported: true, evidence: { path: rel, ...evidence } });
    const full = assertNoSymlinkAncestors(workspace, rel);
    if (!full) { barrier({ reason: 'unsafe-configuration' }); continue; }
    const bytes = readFileNoFollow(full, { root: workspace, maxBytes: 200_000, encoding: null });
    if (bytes === null) { barrier({ reason: 'unavailable-configuration' }); continue; }
    const source = bytes.toString('utf8');
    const evidence = { path: rel, sha256: createHash('sha256').update(bytes).digest('hex'), range: { startLine: 1, startColumn: 1, endLine: source.split('\n').length, endColumn: source.length - source.lastIndexOf('\n') } };
    try {
      const value = jsonConfig(source);
      if (!value || typeof value !== 'object' || value.extends || value.compilerOptions !== undefined && (!value.compilerOptions || typeof value.compilerOptions !== 'object')) { barrier(evidence); continue; }
      if (['include', 'exclude', 'files'].some(key => value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > 256 || value[key].some(item => typeof item !== 'string')))) { barrier(evidence); continue; }
      const options = value.compilerOptions || {};
      if (options.baseUrl !== undefined && (typeof options.baseUrl !== 'string' || path.posix.isAbsolute(options.baseUrl) || /^[A-Za-z]:/.test(options.baseUrl))) { barrier(evidence); continue; }
      const base = typeof options.baseUrl === 'string' ? path.posix.normalize(path.posix.join(directory, options.baseUrl)) : directory;
      if (base === '..' || base.startsWith('../') || path.posix.isAbsolute(base)) { barrier(evidence); continue; }
      if (options.paths !== undefined && (!options.paths || typeof options.paths !== 'object' || Array.isArray(options.paths))) { barrier(evidence); continue; }
      const mappings = Object.entries(options.paths || {});
      if (mappings.length > 256 || mappings.some(([key, targets]) => key.length > 512 || (key.match(/\*/g)?.length || 0) > 1 || !Array.isArray(targets) || !targets.length || targets.length > 16 || targets.some(target => typeof target !== 'string' || target.length > 512 || (target.match(/\*/g)?.length || 0) > 1))) { barrier(evidence); continue; }
      mappings.sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.indexOf('*') - a.indexOf('*') || b.length - a.length || (a < b ? -1 : 1));
      output.push({ directory, base, baseUrl: typeof options.baseUrl === 'string', mappings, include: value.include, exclude: value.exclude, files: value.files, evidence });
    } catch {
      barrier(evidence);
    }
  }
  return output.sort((a, b) => b.directory.length - a.directory.length || Number(path.posix.basename(b.evidence.path) === 'tsconfig.json') - Number(path.posix.basename(a.evidence.path) === 'tsconfig.json') || (a.evidence.path < b.evidence.path ? -1 : 1));
}

function matchesPattern(file, pattern) {
  if (typeof pattern !== 'string' || pattern.length > 512) return false;
  const normalized = pattern.replace(/^\.\//, '').replace(/\/$/, '');
  if (!/[?*]/.test(normalized)) return file === normalized || file.startsWith(`${normalized}/`);
  let expression = '';
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] === '*' && normalized[i + 1] === '*') { i++; if (normalized[i + 1] === '/') { i++; expression += '(?:.*/)?'; } else expression += '.*'; }
    else if (normalized[i] === '*') expression += '[^/]*';
    else if (normalized[i] === '?') expression += '[^/]';
    else expression += normalized[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`).test(file);
}

export function configuredTargets(from, specifier, configs, candidates) {
  if (!/\.[cm]?[jt]sx?$/i.test(from) || specifier.startsWith('.')) return null;
  const config = configs.find(item => item.directory === '.' || from.startsWith(`${item.directory}/`));
  if (!config) return null;
  if (config.unsupported) return { candidates: [], unsupported: true, evidence: config.evidence.sha256 ? [config.evidence] : [] };
  const local = config.directory === '.' ? from : from.slice(config.directory.length + 1);
  const selected = !Array.isArray(config.include) && !Array.isArray(config.files) || (config.include || []).some(pattern => matchesPattern(local, pattern)) || (config.files || []).some(file => file === local);
  if (!selected || (config.exclude || []).some(pattern => matchesPattern(local, pattern))) return null;
  for (const [pattern, paths] of config.mappings) {
    const star = pattern.indexOf('*');
    const prefix = star < 0 ? pattern : pattern.slice(0, star), suffix = star < 0 ? '' : pattern.slice(star + 1);
    if (star < 0 ? specifier !== pattern : !specifier.startsWith(prefix) || !specifier.endsWith(suffix) || specifier.length < prefix.length + suffix.length) continue;
    const capture = star < 0 ? '' : specifier.slice(prefix.length, suffix ? -suffix.length : undefined);
    for (const target of paths) {
      const normalized = path.posix.normalize(path.posix.join(config.base, target.replace('*', capture)));
      const found = candidates(normalized);
      if (found.length) return { candidates: found, evidence: [config.evidence] };
    }
    return { candidates: [], evidence: [config.evidence] };
  }
  if (config.baseUrl) {
    const found = candidates(path.posix.normalize(path.posix.join(config.base, specifier)));
    if (found.length) return { candidates: found, evidence: [config.evidence] };
  }
  return null;
}
