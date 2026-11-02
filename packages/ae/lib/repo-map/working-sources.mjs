import { gitExecutable } from '../../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { MAX_FILES_SCANNED, inspectSourceFile } from './scan.mjs';
import { SOURCE_EXTENSIONS } from './lexical-extractor.mjs';

export const SOURCE_STATE_VERSION = 1;
const RESOLVER_FILE = /^(?:package\.json|[jt]sconfig[^/]*\.json|pyproject\.toml|setup\.cfg|pom\.xml|build\.gradle(?:\.kts)?|\.gitignore|\.gitattributes)$/;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const EXTRACTOR_REVISION = digest(JSON.stringify(['scan.mjs', 'facts.mjs', 'imports.mjs', 'occurrences.mjs', 'resolver-config.mjs', 'index.mjs', 'structural-index.mjs', 'working-sources.mjs', 'lexical-extractor.mjs', 'treesitter-extractor.mjs', 'grammars.lock'].map((rel) => {
  try {
    return [rel, digest(fs.readFileSync(new URL(rel, import.meta.url)))];
  } catch (error) {
    if (rel !== 'grammars.lock') throw error;
    return [rel, null];
  }
})));

export function captureWorkingSources(workspace, { allowUnborn = false } = {}) {
  const options = { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 };
  const listed = spawnSync(gitExecutable(), ['-C', workspace, 'ls-files', '-z'], options);
  const head = spawnSync(gitExecutable(), ['-C', workspace, 'rev-parse', 'HEAD'], options);
  if (listed.status !== 0 || head.status !== 0 && !allowUnborn) return { valid: false, reason: 'source state unavailable' };
  const sourceHead = head.status === 0 ? head.stdout.trim() : null;
  const paths = [...new Set(listed.stdout.split('\0').filter(Boolean))].sort();
  const sourcePaths = paths.filter((rel) => SOURCE_EXTENSIONS.has(path.extname(rel).toLowerCase()));
  const selected = sourcePaths.slice(0, MAX_FILES_SCANNED);
  const configs = paths.filter((rel) => RESOLVER_FILE.test(path.posix.basename(rel)));
  const selectedConfigs = configs.slice(0, MAX_FILES_SCANNED);
  const configSet = new Set(configs);
  const entries = Object.fromEntries([...new Set([...selected, ...selectedConfigs])].map((rel) => {
    const { content, mtime, ...identity } = inspectSourceFile(workspace, rel);
    return [rel, identity];
  }));
  const identities = Object.entries(entries).map(([rel, { state, hash, size }]) => [rel, state, hash || null, size ?? null]);
  return {
    valid: configs.length <= MAX_FILES_SCANNED,
    reason: configs.length > MAX_FILES_SCANNED ? 'resolver files exceed the source scan budget' : null,
    head: sourceHead,
    files: selected,
    entries,
    state: {
      version: SOURCE_STATE_VERSION,
      digest: digest(JSON.stringify([SOURCE_STATE_VERSION, EXTRACTOR_REVISION, sourceHead, sourcePaths, configs, identities])),
      extractorRevision: EXTRACTOR_REVISION,
      configDigest: digest(JSON.stringify(identities.filter(([rel]) => configSet.has(rel)))),
      scanned: selected.length,
      total: sourcePaths.length,
      truncated: sourcePaths.length > selected.length,
      resolverFiles: configs.length,
      resolverTruncated: configs.length > selectedConfigs.length,
      omitted: Object.entries(entries).filter(([, entry]) => entry.state !== 'readable').map(([rel, entry]) => ({ rel, state: entry.state })),
    },
  };
}

export function structuralCurrentness(workspace, meta) {
  if (meta?.sourceState?.version !== SOURCE_STATE_VERSION) return { current: false, reason: 'source state missing or obsolete; rebuild the index' };
  const snapshot = captureWorkingSources(workspace);
  if (!snapshot.valid) return { current: false, reason: snapshot.reason };
  const current = meta.sha === snapshot.head && meta.sourceState.digest === snapshot.state.digest;
  return { current, reason: current ? null : 'source bytes, tracked paths, configuration or HEAD changed', sourceState: snapshot.state };
}
