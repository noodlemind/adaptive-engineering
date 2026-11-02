import { gitExecutable } from '../../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EXIT } from '../style.mjs';
import { redactSecrets } from '../secret-scan.mjs';
import { readFileNoFollow } from '../fs-safe.mjs';
import { tokenize, FIELD_BOOSTS } from '../tokenize.mjs';
import { loadPostingsIndex, postingsMatchManifest } from '../postings-index.mjs';
import { loadManifest, rankRecall, findMatchingPlans } from '../recall-rank.mjs';
import { loadCollections, entryMatchesCollection, resolveIndexDir } from '../recall-config.mjs';
import { storeDir, inertLine, readStaleExclusions, repoId } from '../knowledge/store.mjs';
import { rankLearnings, retrievalExclusion } from '../knowledge/retrieve.mjs';
import { learningApplicability } from '../knowledge/applicability.mjs';
import { loadLayeredLearnings } from '../knowledge/overlay.mjs';
import { trackedSourceFiles, readFileSafe } from '../repo-map/scan.mjs';
import { readStructuralIndex } from '../structural/shape.mjs';
import { SOURCES, createRetrievalResult, federate } from './kernel.mjs';
import { planReadDirs } from '../project-layout.mjs';
import { captureWorkingSources } from '../repo-map/working-sources.mjs';
import { runGet } from '../get-cmd.mjs';

/** The settled mode list, in the order the architecture doc states it. */
export const MATCH_MODES = Object.freeze(['ranked', 'literal', 'regex', 'path', 'symbol']);
export const DEFAULT_MATCH_MODE = 'ranked';

export const REGEX_MAX_PATTERN = 200;
export const REGEX_MAX_LINE = 2000;

const SOURCE_CANDIDATE_CAP = 200;

/** Counting stops here per file: the count is a relevance signal, not a census,
 * and a generated file with 100k hits does not deserve 100k iterations. */
const MATCHED_LINE_CAP = 1000;

const SNIPPET_MAX = 160;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const PLAN_RANK_HEAD = 4000;

const PENDING_SOURCES = Object.freeze({
  skills: 'skills have no kernel corpus yet — reach them with --match path',
  checks: 'checks have no kernel corpus yet — reach one with: ae lookup check <name>',
  events: 'events have no kernel corpus yet — reach them with: ae lookup event <session>',
  runs: 'the Phase 4a run journal creates the run corpus',
});

const MODE_UNSUPPORTED = Object.freeze({
    ranked: {},
  literal: {},
  regex: {},
  path: {
    learnings: 'learnings are addressed by <domain>/<slug>, not by path — use --match ranked or literal',
  },
  symbol: {
    knowledge: 'the structural index covers code only',
    learnings: 'the structural index covers code only',
    plans: 'the structural index covers code only',
  },
});

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

/** A corpus entry federate accepts, in the one shape every helper below returns. */
const sourceEntry = (source, status, { reason = null, generation = null, results = [] } = {}) => ({
  source,
  status,
  reason,
  generation,
  results,
});

const skipped = (source, reason) => sourceEntry(source, 'skipped', { reason });
const failed = (source, reason) => sourceEntry(source, 'failed', { reason });

function snippetOf(text) {
  if (typeof text !== 'string' || !text) return null;
  const flat = inertLine(redactSecrets(text)).trim();
  return flat ? flat.slice(0, SNIPPET_MAX) : null;
}

function digestOf(parts) {
  return `sha256:${crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)}`;
}

function workspaceGeneration(workspace) {
  const res = spawnSync(gitExecutable(), ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 });
  return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : null;
}

/** Query tokens through the SHARED tokenizer. A private one here would explain
 * matches in terms the ranker never saw. */
function queryTokensOf(query) {
  return tokenize(query);
}

/** `field: term, term` fragments for `--explain`, computed with the same
 * tokenizer that produced the score. */
function fieldHits(queryTokens, fields) {
  const out = [];
  for (const { name, text } of fields) {
    if (!text) continue;
    const tokens = new Set(tokenize(text));
    const matched = queryTokens.filter((t) => tokens.has(t));
    if (matched.length) out.push(`${name}: ${matched.join(', ')}`);
  }
  return out;
}

function compileRegex(pattern) {
  if (pattern.length > REGEX_MAX_PATTERN) {
    throw usageError(
      `regex pattern is ${pattern.length} characters, over the ${REGEX_MAX_PATTERN}-character bound`,
      'narrow the pattern, or use --match literal for a fixed string',
    );
  }
  try {
        return new RegExp(pattern, 'i');
  } catch (error) {
    throw usageError(`invalid regex: ${error.message}`, 'escape regex metacharacters, or use --match literal');
  }
}

function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

function pathMatcher(query) {
  if (query.length > REGEX_MAX_PATTERN) {
    throw usageError(
      `path pattern is ${query.length} characters, over the ${REGEX_MAX_PATTERN}-character bound`,
      'narrow the pattern',
    );
  }
  const needle = query.toLowerCase();
  const glob = /[*?]/.test(query) ? globToRegExp(query) : null;
  return (rel) => {
    const lower = String(rel).toLowerCase();
    if (glob) return glob.test(rel) ? 3 : 0;
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    if (base === needle) return 3;
    if (base.includes(needle)) return 2;
    return lower.includes(needle) ? 1 : 0;
  };
}

function lineMatcher(mode, query) {
  if (mode === 'literal') {
    const needle = query.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
  const re = compileRegex(query);
    return (line) => re.test(line.length > REGEX_MAX_LINE ? line.slice(0, REGEX_MAX_LINE) : line);
}

/** Matched-line count plus the first hit, which is all any content mode needs:
 * one row per document, count as the score, first line as location + snippet. */
function scanText(text, match) {
  const lines = String(text).split(/\r?\n/);
  let hits = 0;
  let firstLine = 0;
  let firstText = '';
  for (let i = 0; i < lines.length && hits < MATCHED_LINE_CAP; i += 1) {
    if (!match(lines[i])) continue;
    hits += 1;
    if (hits === 1) {
      firstLine = i + 1;
      firstText = lines[i];
    }
  }
  return { hits, firstLine, firstText };
}

/** Deterministic candidate selection inside one corpus: same shape as the
 * kernel's total order, so trimming here can never reorder what survives. */
function topCandidates(results) {
  return results
    .sort((a, b) => b.sourceScore - a.sourceScore || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, SOURCE_CANDIDATE_CAP);
}

// ---------------------------------------------------------------- code

function codeSymbols({ query, workspace, home, explain }) {
  const index = readStructuralIndex(workspace, { home, requireCurrent: true });
    if (!index.present) return skipped('code', `${index.reason} — build one with: ae index --structural`);
  const generation = index.meta.sourceState.digest;
  const needle = query.toLowerCase();
  const results = [];
  for (const symbol of index.symbols || []) {
    if (typeof symbol.name !== 'string' || !symbol.name || typeof symbol.file !== 'string' || !symbol.file) continue;
    const lower = symbol.name.toLowerCase();
    const exact = lower === needle;
    if (!exact && !lower.startsWith(needle)) continue;
    const line = Number.isFinite(symbol.def?.line) ? symbol.def.line : null;
    results.push(
      createRetrievalResult({
        source: 'code',
        id: `${symbol.file}#${symbol.name}`,
        location: line ? `${symbol.file}:${line}` : symbol.file,
        title: symbol.name,
        kind: symbol.kind || 'symbol',
        score: exact ? 2 : 1,
        generation,
        reason: explain ? `symbol name ${exact ? 'exact' : 'prefix'} match in ${symbol.file}` : null,
      }),
    );
  }
  return sourceEntry('code', 'ok', { generation, results: topCandidates(results) });
}

function codeRanked({ query, workspace, home, explain, headSha }) {
  const { files } = trackedSourceFiles(workspace);
  if (!files.length) return skipped('code', 'no tracked source files (not a git repository, or nothing tracked)');

  const terms = [...new Set(String(query).toLowerCase().split(/\s+/).filter(Boolean))];
  if (!terms.length) return sourceEntry('code', 'ok', { generation: headSha, results: [] });
  const matchers = terms.map((t) => lineMatcher('literal', t));

  const results = [];
  for (const rel of files) {
    const text = readFileSafe(workspace, rel);
    if (!text) continue;
    let distinct = 0;
    let total = 0;
    let firstLine = 0;
    let firstText = '';
    for (const match of matchers) {
      const { hits, firstLine: line, firstText: snippet } = scanText(text, match);
      if (!hits) continue;
      distinct += 1;
      total += hits;
      if (!firstLine) { firstLine = line; firstText = snippet; }
    }
    if (!distinct) continue;
    results.push(
      createRetrievalResult({
        source: 'code',
        id: rel,
        location: `${rel}:${firstLine}`,
        title: path.posix.basename(rel),
        snippet: snippetOf(firstText),
        kind: 'file',
        // Distinct-term coverage dominates; matched-line volume breaks ties.
        score: distinct * 1000 + Math.min(total, 999),
        generation: headSha,
        reason: explain ? `${distinct} of ${terms.length} terms · ${total} matching line(s)` : null,
      }),
    );
  }

    const symbols = codeSymbols({ query, workspace, home, explain });
  if (symbols.status === 'ok') results.push(...symbols.results);
  return sourceEntry('code', 'ok', { generation: headSha, results: topCandidates(results) });
}

function codeSource({ mode, query, workspace, home, explain, headSha }) {
  if (mode === 'ranked') return codeRanked({ query, workspace, home, explain, headSha });
  if (mode === 'symbol') return codeSymbols({ query, workspace, home, explain });

  const { files } = trackedSourceFiles(workspace);
    if (!files.length) return skipped('code', 'no tracked source files (not a git repository, or nothing tracked)');

  if (mode === 'path') {
    const rank = pathMatcher(query);
    const results = [];
    for (const rel of files) {
      const score = rank(rel);
      if (!score) continue;
      results.push(
        createRetrievalResult({
          source: 'code',
          id: rel,
          location: rel,
          title: path.posix.basename(rel),
          kind: 'file',
          score,
          generation: headSha,
          reason: explain ? `path matched ${query} (${['', 'in path', 'in filename', 'exact'][score]})` : null,
        }),
      );
    }
    return sourceEntry('code', 'ok', { generation: headSha, results: topCandidates(results) });
  }

  const match = lineMatcher(mode, query);
  const results = [];
  for (const rel of files) {
    const text = readFileSafe(workspace, rel);
    if (!text) continue;
    const { hits, firstLine, firstText } = scanText(text, match);
    if (!hits) continue;
    results.push(
      createRetrievalResult({
        source: 'code',
        id: rel,
        location: `${rel}:${firstLine}`,
        title: path.posix.basename(rel),
        snippet: snippetOf(firstText),
        kind: 'file',
        score: hits,
        generation: headSha,
        reason: explain ? `${mode} match on ${hits} line(s), first at ${rel}:${firstLine}` : null,
      }),
    );
  }
  return sourceEntry('code', 'ok', { generation: headSha, results: topCandidates(results) });
}

// ----------------------------------------------------------- knowledge

function knowledgeGeneration({ mode, copilotHome, workspace, updated, sha256, home }) {
  if (!updated) return null;
  if (mode !== 'ranked') return `${updated}:${sha256}`;
  const indexDir = resolveIndexDir(copilotHome, workspace, home);
  const index = loadPostingsIndex(indexDir);
  const fresh = postingsMatchManifest(index, updated, sha256) && index.N > 0;
  return `${fresh ? 'bm25' : 'overlap'}@${updated}:${sha256}`;
}

const KNOWLEDGE_TEXT_FIELDS = ['symptom', 'title', 'summary', 'excerpt', 'module'];

/** The manifest is generated but hand-editable, so neither the id nor `tags`
 * is trusted to have its declared shape. An entry with no usable id is skipped
 * rather than thrown on: one malformed row must not fail the whole corpus. */
const knowledgeId = (entry) => {
  const id = entry.docid || entry.id;
  return typeof id === 'string' && id ? id : null;
};

const knowledgeFields = (entry) => [
  ...KNOWLEDGE_TEXT_FIELDS.map((name) => ({ name, text: entry[name] })),
  { name: 'tags', text: Array.isArray(entry.tags) ? entry.tags.join(' ') : '' },
];

function knowledgeSource({ mode, query, workspace, copilotHome, home, explain, collection, collections, queryTokens }) {
  const manifest = loadManifest(copilotHome, workspace, { home });
    if (manifest.error) return failed('knowledge', `knowledge manifest unreadable: ${manifest.error}`);
  if (!manifest.path) return skipped('knowledge', 'no knowledge manifest — build one with: ae index');

  const generation = knowledgeGeneration({ mode, copilotHome, workspace, updated: manifest.updated, sha256: manifest.sha256, home });

  if (mode === 'ranked') {
    const ranked = rankRecall(query, { copilotHome, workspace, limit: SOURCE_CANDIDATE_CAP, collection, home, manifest });
    const results = [];
    for (const entry of ranked) {
      const id = knowledgeId(entry);
      if (!id) continue;
      const hits = explain ? fieldHits(queryTokens, knowledgeFields(entry)) : [];
      results.push(
        createRetrievalResult({
          source: 'knowledge',
          scope: entry.scope ?? null,
          id,
          location: entry.path ?? null,
          title: entry.title ?? null,
          snippet: snippetOf(entry.snippet),
          kind: entry.kind ?? null,
          score: entry.score,
          generation,
          reason: explain
            ? hits.length
              ? `${entry.ranker} ranked on ${hits.join('; ')}`
              : `${entry.ranker} ranked on synonym expansion or recency, with no direct field hit`
            : null,
        }),
      );
    }
  return sourceEntry('knowledge', 'ok', { generation, reason: manifest.warnings?.join('; ') || null, results });
  }

  const entries = manifest.entries.filter((entry) => entryMatchesCollection(entry, collection, collections));

  if (mode === 'path') {
    const rank = pathMatcher(query);
    const results = [];
    for (const entry of entries) {
      const id = knowledgeId(entry);
      const score = id && entry.path ? rank(entry.path) : 0;
      if (!score) continue;
      results.push(
        createRetrievalResult({
          source: 'knowledge',
          scope: entry.scope ?? null,
          id,
          location: entry.path,
          title: entry.title ?? null,
          kind: entry.kind ?? null,
          score,
          generation,
          reason: explain ? `document path matched ${query}` : null,
        }),
      );
    }
    return sourceEntry('knowledge', 'ok', { generation, results: topCandidates(results) });
  }

  const match = lineMatcher(mode, query);
  const results = [];
  for (const entry of entries) {
    const id = knowledgeId(entry);
    if (!id) continue;
        let score = 0;
    let firstField = null;
    let firstText = '';
    for (const { name, text } of knowledgeFields(entry)) {
      if (!text) continue;
      const { hits, firstText: line } = scanText(text, match);
      if (!hits) continue;
      score += FIELD_BOOSTS[name] ?? 1;
      if (!firstField) {
        firstField = name;
        firstText = line;
      }
    }
    if (!score) continue;
    results.push(
      createRetrievalResult({
        source: 'knowledge',
        scope: entry.scope ?? null,
        id,
        location: entry.path ?? null,
        title: entry.title ?? null,
        snippet: snippetOf(firstText),
        kind: entry.kind ?? null,
        score,
        generation,
        reason: explain ? `${mode} match in field ${firstField}` : null,
      }),
    );
  }
  return sourceEntry('knowledge', 'ok', { generation, results: topCandidates(results) });
}

// ----------------------------------------------------------- learnings

function learningsSource({ mode, query, workspace, home, explain, queryTokens }) {
  const dir = storeDir(workspace, { home });
    if (!fs.existsSync(dir)) return skipped('learnings', 'no knowledge store for this workspace');

  const { learnings } = loadLayeredLearnings({ workspace, home });
    const generation = learnings.length ? digestOf(learnings.map((l) => `${l.id}:${l.bytes}`)) : null;

  if (mode === 'ranked') {
    const ranked = rankLearnings({ workspace, query, limit: SOURCE_CANDIDATE_CAP, home });
    const fileById = new Map(learnings.map((l) => [l.id, l.file ?? null]));
    const results = ranked.map((entry) =>
      createRetrievalResult({
        source: 'learnings',
        id: entry.id,
        location: fileById.get(entry.id) ?? null,
        title: entry.trigger ?? null,
        snippet: snippetOf(entry.claimLine),
        kind: 'learning',
        score: entry.score,
        applicability: entry.applicability,
        generation,
        reason: explain
          ? fieldHits(queryTokens, [
              { name: 'trigger', text: entry.trigger },
              { name: 'claim', text: entry.claimLine },
            ]).join('; ') || `status ${entry.status} matched with no single-field hit`
          : null,
      }),
    );
    return sourceEntry('learnings', 'ok', { generation, results });
  }

  const match = lineMatcher(mode, query);
    const { excluded } = readStaleExclusions(dir);
  const applicabilityCache = new Map();
  const repository = repoId(workspace);
  const results = [];
  for (const learning of learnings) {
        if (retrievalExclusion(learning, excluded)) continue;
    const text = `${learning.fm?.trigger || ''}\n${learning.body || ''}`;
    const { hits, firstText } = scanText(text, match);
    if (!hits) continue;
    results.push(
      createRetrievalResult({
        source: 'learnings',
        id: learning.id,
        location: learning.file ?? null,
        title: learning.fm?.trigger ?? null,
        snippet: snippetOf(firstText),
        kind: 'learning',
        score: hits,
        applicability: learningApplicability({ workspace, fm: learning.fm, repository, cache: applicabilityCache }),
        generation,
        reason: explain ? `${mode} match on ${hits} line(s) of trigger or claim` : null,
      }),
    );
  }
  return sourceEntry('learnings', 'ok', { generation, results: topCandidates(results) });
}

// --------------------------------------------------------------- plans

function loadPlans(workspace) {
  const plans = [];
  const seen = new Set();
  let anyRoot = false;
  for (const { dir, label } of planReadDirs(workspace, { home: process.env.HARNESS_HOME })) {
    anyRoot = true;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.md') || seen.has(name)) continue;
      const rel = path.isAbsolute(label) ? path.join(label, name) : `${label}/${name}`;
      const text = readFileNoFollow(path.join(dir, name), { root: dir });
      if (!text) continue;
      seen.add(name);
      plans.push({ rel, name, text });
    }
  }
  if (!anyRoot) return { ok: false, reason: 'no plan directory in this workspace or its project store', plans: [] };
  return { ok: true, reason: null, plans };
}

function plansSource({ mode, query, workspace, explain, headSha, queryTokens }) {
  const loaded = loadPlans(workspace);
  if (!loaded.ok) return skipped('plans', loaded.reason);

  if (mode === 'ranked') {
    const textByRel = new Map(loaded.plans.map((p) => [p.rel, p.text]));
    const matches = findMatchingPlans(workspace, query, SOURCE_CANDIDATE_CAP);
    const results = matches.map((entry) =>
      createRetrievalResult({
        source: 'plans',
        id: entry.path,
        location: entry.path,
        title: path.posix.basename(entry.path),
        kind: 'plan',
        score: entry.score,
        generation: headSha,
        reason: explain
          ? [
              fieldHits(queryTokens, [{ name: 'plan', text: (textByRel.get(entry.path) || '').slice(0, PLAN_RANK_HEAD) }]).join('; ') ||
                'matched on plan frontmatter or body tokens',
              `status ${entry.status}`,
              `plan_lock ${entry.plan_lock}`,
            ].join(' — ')
          : null,
      }),
    );
    return sourceEntry('plans', 'ok', { generation: headSha, results });
  }

  if (mode === 'path') {
    const rank = pathMatcher(query);
    const results = [];
    for (const plan of loaded.plans) {
      const score = rank(plan.rel);
      if (!score) continue;
      results.push(
        createRetrievalResult({
          source: 'plans',
          id: plan.rel,
          location: plan.rel,
          title: plan.name,
          kind: 'plan',
          score,
          generation: headSha,
          reason: explain ? `plan path matched ${query}` : null,
        }),
      );
    }
    return sourceEntry('plans', 'ok', { generation: headSha, results: topCandidates(results) });
  }

  const match = lineMatcher(mode, query);
  const results = [];
  for (const plan of loaded.plans) {
    const { hits, firstLine, firstText } = scanText(plan.text, match);
    if (!hits) continue;
    results.push(
      createRetrievalResult({
        source: 'plans',
        id: plan.rel,
        location: `${plan.rel}:${firstLine}`,
        title: plan.name,
        snippet: snippetOf(firstText),
        kind: 'plan',
        score: hits,
        generation: headSha,
        reason: explain ? `${mode} match on ${hits} line(s), first at ${plan.rel}:${firstLine}` : null,
      }),
    );
  }
  return sourceEntry('plans', 'ok', { generation: headSha, results: topCandidates(results) });
}

// ------------------------------------------------------------ dispatch

const SOURCE_HANDLERS = {
  code: codeSource,
  knowledge: knowledgeSource,
  learnings: learningsSource,
  plans: plansSource,
};

function resolveMode(mode, modes) {
    const selected = mode ?? modes ?? DEFAULT_MATCH_MODE;
  const normalized = String(Array.isArray(selected) ? selected[0] : selected).trim().toLowerCase();
  if (!MATCH_MODES.includes(normalized)) {
    throw usageError(`unknown match mode: ${normalized}`, `one of ${MATCH_MODES.join(', ')}`);
  }
  return normalized;
}

function resolveSources(sources) {
  if (sources == null) return [...SOURCES];
  const raw = Array.isArray(sources) ? sources : String(sources).split(',');
  const wanted = raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (!wanted.length || wanted.includes('all')) return [...SOURCES];
  for (const name of wanted) {
    if (SOURCES.includes(name)) continue;
    const pending = PENDING_SOURCES[name];
    throw usageError(
      pending ? `source not available yet: ${name}` : `unknown source: ${name}`,
      pending || `one of ${SOURCES.join(', ')}, or all`,
    );
  }
    return SOURCES.filter((s) => wanted.includes(s));
}

function resolveLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.trunc(n), MAX_LIMIT);
}

export function runSearch({
  query,
  workspace,
  copilotHome,
  home,
  mode,
  modes,
  sources,
  limit,
  cursor = null,
  explain = false,
  collection = null,
  contextVersion = 1,
} = {}) {
  const text = typeof query === 'string' ? query.trim() : '';
  if (!text) throw usageError('search requires a query', 'ae search <query> [--match ranked|literal|regex|path|symbol]');

  const selectedMode = resolveMode(mode, modes);
  const selectedSources = resolveSources(sources);

    if (selectedMode === 'regex') compileRegex(text);
  if (selectedMode === 'path') pathMatcher(text);

    const collections = collection ? loadCollections(copilotHome, workspace) : {};
  if (collection && !collections[collection]) {
    const known = Object.keys(collections);
        throw usageError(
      `unknown collection: ${collection}`,
      known.length ? `one of ${known.join(', ')}` : 'no collections are defined in knowledge/collections.yaml',
    );
  }

  const queryTokens = queryTokensOf(text);
  const sourceSnapshot = contextVersion === 2 && selectedSources.includes('code') ? captureWorkingSources(workspace) : null;
    const headSha =
    sourceSnapshot?.state?.digest || (selectedSources.includes('code') || selectedSources.includes('plans') ? workspaceGeneration(workspace) : null);

  const entries = [];
  for (const source of selectedSources) {
    const unsupported = MODE_UNSUPPORTED[selectedMode][source];
    if (unsupported) {
      entries.push(skipped(source, unsupported));
      continue;
    }
    try {
      entries.push(
        SOURCE_HANDLERS[source]({
          mode: selectedMode,
          query: text,
          workspace,
          copilotHome,
          home,
          explain,
          collection,
          collections,
          queryTokens,
          headSha,
        }),
      );
    } catch (error) {
            entries.push(failed(source, error?.message || String(error)));
    }
  }

  const cursorContext = contextVersion === 2 ? digestOf([JSON.stringify([2, text, selectedMode, [...selectedSources].sort(), collection])]) : null;
  if (contextVersion === 2) {
    for (const entry of entries) {
      if (entry.source !== 'code') entry.generation = digestOf([JSON.stringify([entry.generation, entry.status, entry.results])]);
    }
  }
  const result = { ...federate({ sources: entries, limit: resolveLimit(limit), cursor, cursorContext }), match: selectedMode };
  if (contextVersion === 2) {
    for (const row of result.results) {
      if (!['code', 'knowledge'].includes(row.source)) continue;
      try {
        const location = String(row.location || row.id).replace(/:\d+(?::\d+)?$/, '');
        const offset = Number(/:(\d+)$/.exec(row.location || '')?.[1]) || 1;
        const excerpt = runGet({ workspace, copilotHome, home, flags: { ...(row.source === 'knowledge' ? { docid: row.id } : { path: location }), offset, lines: 5, maxBytes: 800, contextVersion: 2 } });
        row.excerpt = excerpt.excerpt;
        row.evidence = { ...excerpt.evidence, representationField: 'excerpt' };
        row.context = excerpt.context;
      } catch {
        row.evidence = { state: 'unavailable', reference: null };
      }
    }
    const after = sourceSnapshot ? captureWorkingSources(workspace) : null;
    if (sourceSnapshot && (!sourceSnapshot.valid || !after.valid || sourceSnapshot.state.digest !== after.state.digest)) {
      result.results = result.results.filter(row => row.source !== 'code');
      result.partial = true;
      result.nextCursor = null;
      const code = result.sources.find(source => source.source === 'code');
      if (code) { code.status = 'failed'; code.reason = sourceSnapshot.reason || after.reason || 'working sources changed during search; retry'; code.count = 0; }
    }
    result.contextVersion = 2;
    result.coverage = { candidateLimitPerSource: SOURCE_CANDIDATE_CAP, matchedLineLimitPerFile: MATCHED_LINE_CAP, sourceState: sourceSnapshot?.state || null, semanticCompleteness: 'unverified', unavailableReferences: result.results.filter(row => row.evidence?.state === 'unavailable').map(row => ({ source: row.source, id: row.id })) };
  }
  return result;
}
