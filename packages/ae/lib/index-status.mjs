import { spawnGitSync } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { resolveIndexDir } from './recall-config.mjs';
import { structuralIndexDir, readStructuralIndex, structuralIndexIsCurrent } from './repo-map/structural-index.mjs';
import { POSTINGS_INDEX_VERSION, loadPostingsIndex } from './postings-index.mjs';
import { structuralCurrentness } from './repo-map/working-sources.mjs';
import { loadManifest } from './recall-rank.mjs';

function git(workspace, args) {
  const r = spawnGitSync(['-C', workspace, ...args], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

function driftFromHead(workspace, indexedHead) {
  const head = git(workspace, ['rev-parse', 'HEAD']);
  let commitsSince = null;
  let filesChanged = null;
  if (head && indexedHead && indexedHead !== head) {
    const count = git(workspace, ['rev-list', '--count', `${indexedHead}..HEAD`]);
    commitsSince = count ? Number(count) : null;
    const diff = git(workspace, ['diff', '--name-only', indexedHead, 'HEAD']);
    filesChanged = diff ? diff.split('\n').filter(Boolean).length : null;
  }
  // Any HEAD mismatch is stale — including checkouts of ancestors (commitsSince
  // is 0) and divergent histories where rev-list cannot count a range.
  const stale = !head || !indexedHead || indexedHead !== head;
  return { head, commitsSince, filesChanged, stale };
}

/**
 * Knowledge / BM25 postings index under <harness-home>/index/<repo-id>/knowledge.
 * Built by bare `ae index`. The manifest stays in the Copilot knowledge home.
 */
export function knowledgeIndexStatus({ workspace, copilotHome, home }) {
  const indexDir = resolveIndexDir(copilotHome, workspace, home);
  const metaPath = path.join(indexDir, 'meta.json');
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    meta = null;
  }
  if (!meta) {
    return {
      plane: 'knowledge',
      indexed: false,
      empty: null,
      entryCount: null,
      updated: null,
      indexedHead: null,
      currentHead: git(workspace, ['rev-parse', 'HEAD']),
      commitsSince: null,
      filesChanged: null,
      stale: false,
      recommendation: 'run `ae index` — knowledge index not built yet',
      next: 'ae index',
    };
  }

  if (meta.version !== POSTINGS_INDEX_VERSION) {
    return {
      plane: 'knowledge',
      indexed: true,
      empty: null,
      entryCount: Number.isFinite(meta.entryCount) ? meta.entryCount : null,
      updated: meta.updated || null,
      indexedHead: meta.headSha || null,
      currentHead: git(workspace, ['rev-parse', 'HEAD']),
      commitsSince: null,
      filesChanged: null,
      stale: true,
      recommendation: `knowledge index format ${meta.version ?? 'unknown'} is obsolete — run \`ae index\` to rebuild format ${POSTINGS_INDEX_VERSION}`,
      next: 'ae index',
    };
  }

  const entryCount = Number.isFinite(meta.entryCount) ? meta.entryCount : null;
  const empty = entryCount === 0;
  const { head, commitsSince, filesChanged, stale: headStale } = driftFromHead(workspace, meta.headSha || null);
  const manifest = loadManifest(copilotHome, workspace, { home });
  const manifestStale = !loadPostingsIndex(indexDir) || !manifest.sha256 || meta.manifestSha256 !== manifest.sha256;
  const stale = headStale || manifestStale;
  const freshnessReason = manifestStale ? 'knowledge manifest changed, unavailable, or not bound to this index' : headStale ? 'repository HEAD changed or unavailable' : null;

  if (!meta.headSha) {
    return {
      plane: 'knowledge',
      indexed: true,
      empty,
      entryCount,
      updated: meta.updated || null,
      indexedHead: null,
      currentHead: head || null,
      commitsSince: null,
      filesChanged: null,
      stale: true,
      recommendation: empty
        ? 'knowledge index is empty (0 solutions) and has no HEAD baseline — run `ae index` after compound/remember'
        : 'index has no recorded HEAD baseline — run `ae index` to refresh knowledge',
      next: 'ae index',
    };
  }

  let recommendation;
  let next = null;
  if (empty && !stale) {
    recommendation =
      'knowledge index built but empty (0 solutions) — `ae compound` or `ae remember`, then `ae index`';
    next = 'ae compound / ae remember';
  } else if (manifestStale) {
    recommendation = `${freshnessReason} — run \`ae index\``;
    next = 'ae index';
  } else if (stale) {
    recommendation = `${commitsSince ?? '?'} commits / ${filesChanged ?? '?'} files since last knowledge index — run \`ae index\``;
    next = 'ae index';
  } else {
    recommendation = empty
      ? 'knowledge index current with HEAD (empty corpus)'
      : 'knowledge index is current with HEAD';
  }

  return {
    plane: 'knowledge',
    indexed: true,
    empty,
    entryCount,
    updated: meta.updated || null,
    indexedHead: meta.headSha,
    currentHead: head || null,
    commitsSince,
    filesChanged,
    stale,
    freshnessReason,
    recommendation,
    next,
  };
}

/**
 * Structural / code-symbol index under ~/.harness/index/.../structural.
 * Built by `ae index --structural`.
 */
export function structuralIndexStatus(workspace, { home } = {}) {
  const index = readStructuralIndex(workspace, { home });
  if (!index?.meta) {
    return {
      plane: 'structural',
      indexed: false,
      filesIndexed: null,
      tier: null,
      indexedHead: null,
      currentHead: git(workspace, ['rev-parse', 'HEAD']),
      commitsSince: null,
      filesChanged: null,
      stale: false,
      unreadable: null,
      recommendation: 'run `ae index --structural` — code symbol index not built yet',
      next: 'ae index --structural',
    };
  }

  const meta = index.meta;
  const unreadable = Array.isArray(index.unreadable) ? index.unreadable.filter(Boolean) : [];
  if (unreadable.length) {
    return {
      plane: 'structural',
      indexed: true,
      filesIndexed: Number.isFinite(meta.filesIndexed) ? meta.filesIndexed : null,
      tier: meta.extractorTier || null,
      updated: meta.updated || meta.builtAt || null,
      indexedHead: meta.sha || meta.headSha || meta.baseSha || null,
      currentHead: git(workspace, ['rev-parse', 'HEAD']),
      commitsSince: null,
      filesChanged: null,
      stale: true,
      unreadable,
      recommendation: `code symbol index unreadable (${unreadable.join('; ')}) — run \`ae index --structural\``,
      next: 'ae index --structural',
    };
  }

  const indexedHead = meta.sha || meta.headSha || meta.baseSha || null;
  const { head, commitsSince, filesChanged } = driftFromHead(workspace, indexedHead);
  const freshness = structuralCurrentness(workspace, meta);
  const stale = !freshness.current || !structuralIndexIsCurrent(workspace, index);
  const freshnessReason = freshness.reason || (stale ? 'source or index changed during validation' : null);
  const filesIndexed = Number.isFinite(meta.filesIndexed) ? meta.filesIndexed : null;
  const tier = meta.extractorTier || null;

  return {
    plane: 'structural',
    indexed: true,
    filesIndexed,
    tier,
    updated: meta.updated || meta.builtAt || meta.generatedAt || null,
    indexedHead,
    currentHead: head || null,
    commitsSince,
    filesChanged,
    stale,
    freshnessReason,
    unreadable: null,
    recommendation: stale
      ? `${commitsSince === null ? freshnessReason : `${commitsSince} commits / ${filesChanged ?? '?'} files since last code index`} — run \`ae index --structural\``
      : `code symbol index current${filesIndexed != null ? ` · ${filesIndexed} files` : ''}${tier ? ` · tier ${tier}` : ''}`,
    next: stale ? 'ae index --structural' : null,
  };
}

/**
 * Combined index status for CLI/TUI.
 * Backward-compatible top-level fields describe the **knowledge** plane
 * (what `indexed` historically meant). Prefer `knowledge` / `structural`.
 */
export function indexStatus({ workspace, copilotHome, home } = {}) {
  const knowledge = knowledgeIndexStatus({ workspace, copilotHome, home });
  const structural = structuralIndexStatus(workspace, { home });

  const parts = [];
  if (!knowledge.indexed) parts.push('knowledge: not built — run `ae index`');
  else if (knowledge.empty) parts.push('knowledge: empty (0 solutions)');
  else if (knowledge.stale) parts.push(`knowledge: stale (${knowledge.commitsSince ?? '?'} commits)`);
  else parts.push('knowledge: current');

  if (!structural.indexed) parts.push('code: not built — run `ae index --structural`');
  else if (structural.unreadable?.length) parts.push('code: unreadable — run `ae index --structural`');
  else if (structural.stale) parts.push(`code: stale (${structural.commitsSince === null ? structural.freshnessReason : `${structural.commitsSince} commits`})`);
  else parts.push('code: current');

  return {
    indexed: knowledge.indexed,
    empty: knowledge.empty,
    entryCount: knowledge.entryCount,
    updated: knowledge.updated,
    indexedHead: knowledge.indexedHead,
    currentHead: knowledge.currentHead,
    commitsSince: knowledge.commitsSince,
    filesChanged: knowledge.filesChanged,
    stale: knowledge.stale,
    recommendation: parts.join(' · '),
    knowledge,
    structural,
    structuralDir: structural.indexed ? structuralIndexDir(workspace, { home }) : null,
  };
}
