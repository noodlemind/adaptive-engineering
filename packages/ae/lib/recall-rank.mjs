import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { scoreDocuments, normalizeScores } from './bm25.mjs';
import { tokenize, FIELD_BOOSTS } from './tokenize.mjs';
import {
  loadRecallSynonyms,
  loadCollections,
  expandQueryTokens,
  entryMatchesCollection,
  resolveIndexDir,
} from './recall-config.mjs';
import { loadPostingsIndex, postingsMatchManifest } from './postings-index.mjs';
import { safeResolveUnderRoot } from './path-safe.mjs';
import { assertNoSymlinkAncestors, readFileNoFollow, DEFAULT_MAX_BYTES } from './fs-safe.mjs';
import { planReadDirs, projectStoreDir } from './project-layout.mjs';
import { selectProjectManifest } from './knowledge-manifest.mjs';

const require = createRequire(import.meta.url);

const SNIPPET_FIELDS = [
  { key: 'symptom', boost: FIELD_BOOSTS.symptom },
  { key: 'title', boost: FIELD_BOOSTS.title },
  { key: 'summary', boost: FIELD_BOOSTS.summary },
  { key: 'excerpt', boost: FIELD_BOOSTS.excerpt },
  { key: 'module', boost: FIELD_BOOSTS.module },
];

function recencyBoost(entry) {
  const dateStr = entry.date || entry.updated;
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return 0;
  return Math.max(0, 1 - (Date.now() - new Date(dateStr).getTime()) / (365 * 86400000));
}

function bestSnippet(entry, queryTokens) {
  let best = { text: entry.summary || '', score: 0 };
  for (const { key } of SNIPPET_FIELDS) {
    const text = entry[key] || '';
    if (!text) continue;
    const tokens = new Set(tokenize(text));
    let hits = 0;
    for (const t of queryTokens) if (tokens.has(t)) hits++;
    if (hits > best.score) best = { text, score: hits };
  }
  return best.text.slice(0, 120);
}

function weightedOverlapScore(queryTokens, entry) {
  const fieldTexts = [
    { text: entry.symptom, weight: FIELD_BOOSTS.symptom },
    { text: entry.title, weight: FIELD_BOOSTS.title },
    { text: (entry.tags || []).join(' '), weight: FIELD_BOOSTS.tags },
    { text: entry.module, weight: FIELD_BOOSTS.module },
    { text: entry.summary, weight: FIELD_BOOSTS.summary },
    { text: entry.excerpt, weight: FIELD_BOOSTS.excerpt },
        { text: entry.trigger, weight: FIELD_BOOSTS.symptom },
    { text: entry.claim, weight: FIELD_BOOSTS.summary },
  ];

  let weightedHits = 0;
  let maxWeight = 0;
  for (const { text, weight } of fieldTexts) {
    if (!text) continue;
    maxWeight += weight;
    const fieldTokens = new Set(tokenize(text));
    for (const t of queryTokens) {
      if (fieldTokens.has(t)) weightedHits += weight;
    }
  }

  if (maxWeight <= 0) return 0;
  const overlap = weightedHits / (maxWeight * Math.max(queryTokens.length, 1));
  return overlap * 0.85 + recencyBoost(entry) * 0.15;
}

export function loadManifest(copilotHome, workspace, { home } = {}) {
  const paths = [
    { root: copilotHome, file: path.join(copilotHome, 'knowledge', 'manifest.yaml'), workspaceBound: false },
    { root: workspace, file: path.join(workspace, 'knowledge', 'manifest.yaml'), workspaceBound: true },
  ];
  for (const { root, file, workspaceBound } of paths) {
    try {
      const readRoot = fs.lstatSync(root, { throwIfNoEntry: false }) ? fs.realpathSync.native(root) : path.resolve(root);
      const contained = assertNoSymlinkAncestors(readRoot, path.relative(root, file));
      if (!contained) throw new Error('knowledge manifest is unsafe or symlinked');
      if (!fs.lstatSync(contained, { throwIfNoEntry: false })) continue;
      const content = readFileNoFollow(contained, { root: readRoot, maxBytes: DEFAULT_MAX_BYTES });
      if (content === null) throw new Error(`knowledge manifest is unsafe, unreadable or exceeds the ${DEFAULT_MAX_BYTES}-byte read cap`);
      const yaml = require('yaml');
      const doc = yaml.parse(content);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.entries != null && !Array.isArray(doc.entries)) throw new Error('knowledge manifest entries must be an array');
      return selectProjectManifest({ workspace, copilotHome, home, shared: { entries: doc.entries || [], path: file, updated: doc.updated || null, repository: doc.repository || null, workspaceBound, error: null } });
    } catch (err) {
      return { entries: [], path: file, updated: null, error: err.message || String(err) };
    }
  }
  return selectProjectManifest({ workspace, copilotHome, home, shared: { entries: [], path: null, updated: null, error: null } });
}

function rankWithBm25(queryTokens, index, entriesById, minScore) {
  const rawScores = scoreDocuments(queryTokens, index);
  const normalized = normalizeScores(rawScores);
  const results = [];

  for (const [docId, score] of normalized) {
    const entry = entriesById.get(docId) || index.entries?.[docId];
    if (!entry) continue;
    // Insights are unverified — rank below verified fixes at equal relevance.
    const kindPenalty = entry.kind === 'insight' ? 0.7 : 1;
    const withRecency = (score * 0.85 + recencyBoost(entry) * 0.15) * kindPenalty;
    if (withRecency < minScore) continue;
    results.push({
      ...entry,
      docid: docId,
      id: docId,
      score: withRecency,
      snippet: bestSnippet(entry, queryTokens),
      ranker: 'bm25',
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

function rankWithOverlap(queryTokens, entries, minScore) {
  return entries
    .map((e) => ({
      ...e,
      docid: e.docid || e.id,
      score: weightedOverlapScore(queryTokens, e) * (e.kind === 'insight' ? 0.7 : 1),
      snippet: bestSnippet(e, queryTokens),
      ranker: 'overlap',
    }))
    .filter((e) => e.score >= minScore)
    .sort((a, b) => b.score - a.score);
}

export function rankRecall(query, { copilotHome, workspace, limit = 3, collection = null, minScore = 0.15, home, manifest } = {}) {
  const { entries, updated, sha256, path: manifestPath, error } = manifest || loadManifest(copilotHome, workspace, { home });
  if (error && manifestPath) {
    throw new Error(
      `manifest parse failed (${manifestPath}): ${error} — run npm install in packages/ae or ae index`
    );
  }
  const synonyms = loadRecallSynonyms(copilotHome, workspace);
  const collections = loadCollections(copilotHome, workspace);
  const queryTokens = expandQueryTokens(tokenize(query), synonyms);
  if (!queryTokens.length) return [];

  const filtered = entries.filter((e) => entryMatchesCollection(e, collection, collections));
  const entryKey = (e) => e.docid || e.id;
  const entriesById = new Map(filtered.map((e) => [entryKey(e), e]));

  const indexDir = resolveIndexDir(copilotHome, workspace, home);
  const index = loadPostingsIndex(indexDir);
  const useBm25 = postingsMatchManifest(index, updated, sha256) && index.N > 0;

  let scored;
  if (useBm25) {
    scored = rankWithBm25(queryTokens, index, entriesById, minScore).filter((e) =>
      entriesById.has(e.docid)
    );
  } else {
    scored = rankWithOverlap(queryTokens, filtered, minScore);
  }

  return scored.slice(0, limit).map((e) => ({
    ...e,
    score: Number(e.score.toFixed(3)),
  }));
}

export function findMatchingPlans(workspace, query, limit = 3) {
  const queryTokens = new Set(tokenize(query));
  const results = [];
  const seen = new Set();

  for (const { dir, label } of planReadDirs(workspace)) {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(?:md|hplan)$/.test(f) || seen.has(f)) continue;
      const full = path.join(dir, f);
      const raw = readFileNoFollow(full, { root: dir });
      if (raw === null) continue;
      seen.add(f);
      const text = raw.slice(0, 4000);
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      let status = 'unknown';
      let plan_lock = false;
      if (fm) {
        const sl = fm[1].match(/status:\s*(\S+)/);
        const pl = fm[1].match(/plan_lock:\s*(\S+)/);
        if (sl) status = sl[1];
        if (pl) plan_lock = pl[1] === 'true';
      }
      const fileRel = path.isAbsolute(label) ? full : path.join(label, f);
      const tokens = new Set(tokenize(text));
      let hit = 0;
      for (const t of queryTokens) if (tokens.has(t)) hit++;
      const score = hit / Math.max(queryTokens.size, 1);
      if (score > 0.1) {
        results.push({
          path: path.isAbsolute(fileRel) ? fileRel : fileRel.replace(/\\/g, '/'),
          score,
          status,
          plan_lock,
        });
      }
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function resolveDocPath(copilotHome, workspace, entry, { home } = {}) {
  if (!entry?.path) return null;
  const overlay = path.resolve(projectStoreDir(workspace, { home }));
  const globalRoot = copilotHome ? path.resolve(copilotHome, 'knowledge') : null;
  const wsKnowledge = path.join(workspace, 'knowledge');
  const ws = path.resolve(workspace);
  let knowledgeRoots;
  if (entry.scope === 'product-user') {
    knowledgeRoots = [overlay, ws, wsKnowledge, globalRoot];
  } else if (entry.scope === 'global') {
    knowledgeRoots = [globalRoot, wsKnowledge, ws, overlay];
  } else {
    knowledgeRoots = [ws, wsKnowledge, overlay, globalRoot];
  }
  for (const root of knowledgeRoots.filter(Boolean)) {
    const full = safeResolveUnderRoot(root, entry.path);
    if (full && fs.existsSync(full)) return { full, root };
  }
  return null;
}

export function findEntryByDocid(copilotHome, workspace, docid, { home } = {}) {
  const { entries, error } = loadManifest(copilotHome, workspace, { home });
  if (error) throw new Error(error);
  return entries.find((e) => e.id === docid || e.docid === docid) || null;
}
