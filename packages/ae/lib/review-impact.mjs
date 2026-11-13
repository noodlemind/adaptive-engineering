import path from 'node:path';
import { queryGraph } from './graph.mjs';
import { flowModelContext } from './flow-model.mjs';
import { SOURCE_EXTENSIONS } from './repo-map/lexical-extractor.mjs';
import { readFeedbackConfig } from './knowledge/store.mjs';
import { reviewRules, rulesForFiles } from './feedback-records.mjs';

// Descriptive review context: who depends on the changed files. It never selects reviewers,
// grants authority or waives a check, and missing coverage is reported as unknown.
export const IMPACT_SCHEMA = 'review-impact-v1';
export const MAX_IMPACT_SEEDS = 6;
const IMPACT_DEPTH = 2, IMPACT_LIMIT = 20;
const LIMITATIONS = Object.freeze([
  'Dependents are reverse module imports from bounded static observation, not runtime calls, dependency injection or configuration wiring.',
  'An unknown or incomplete seed means relationships were not established; it never means the file has no dependents.',
  'Listed dependents are bound by content hash; a dependent added after preparation is not listed.',
]);

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const isSource = file => SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase());

function outcomeReason(graph) {
  if (graph.outcome === 'truncated') return 'Reverse dependents exceeded the bound; listed dependents are partial.';
  if (graph.outcome === 'missing') return 'The file is not git-tracked source the graph can read; it may be new, untracked or unreadable.';
  if (graph.coverage?.sourceChanged) return 'Source changed during graph observation; relationships were not established.';
  if (graph.coverage?.unavailable) return 'The import graph is unavailable for this checkout.';
  return `Graph outcome ${graph.outcome || 'missing'}; relationships were not established.`;
}

function seedImpact(workspace, home, file) {
  try {
    const graph = queryGraph({ workspace, home, operation: 'impact', files: [file], depth: IMPACT_DEPTH, limit: IMPACT_LIMIT });
    const dependents = (graph.affected || []).map(node => ({ file: node.file, distance: node.distance, sha256: node.hash }));
    return {
      file, outcome: graph.outcome, freshness: graph.freshness?.state || 'unknown', complete: graph.coverage?.complete === true,
      dependents, omittedEdges: graph.omitted?.edges || 0, depthLimitReached: graph.depthLimitReached === true,
      ...(graph.outcome === 'found' ? {} : { reason: outcomeReason(graph) }),
    };
  } catch (error) {
    return { file, outcome: 'unknown', freshness: 'unknown', complete: false, dependents: [], omittedEdges: 0, depthLimitReached: false,
      reason: String(error?.message || error).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 300) };
  }
}

/**
 * Learned review rules that cover the changed files, read only when the person turned
 * `knowledge.feedback` to suggest or on. Advisory text for reviewers; synthesis never reads it.
 */
function matchedRules(workspace, home, files) {
  try {
    if (readFeedbackConfig(workspace, { home }) === 'off') return null;
    const rules = rulesForFiles(reviewRules({ workspace, home }), files);
    return rules.length ? rules : null;
  } catch {
    return null;
  }
}

/** Bounded impact context for a code review packet: reverse dependents, matched flow models and learned rules. */
export function reviewImpact({ workspace, home, files = [] }) {
  const candidates = [...new Set(files)].filter(isSource).sort(compare);
  const seeds = candidates.slice(0, MAX_IMPACT_SEEDS).map(file => seedImpact(workspace, home, file));
  const flows = flowModelContext({ workspace, home, files: [...new Set(files)].slice(0, 128) });
  const rules = matchedRules(workspace, home, files);
  return {
    schema: IMPACT_SCHEMA, authority: 'descriptive-context', depth: IMPACT_DEPTH, limit: IMPACT_LIMIT,
    seeds, omittedSeeds: candidates.length - seeds.length, flows: flows || null, ...(rules ? { rules } : {}), limitations: [...LIMITATIONS],
  };
}

/** The bound dependents of an impact section, for currency checks against live bytes. */
export function impactDependents(impact) {
  const rows = new Map();
  for (const seed of Array.isArray(impact?.seeds) ? impact.seeds : []) {
    for (const dependent of Array.isArray(seed?.dependents) ? seed.dependents : []) rows.set(dependent.file, dependent.sha256);
  }
  return [...rows].map(([file, sha256]) => ({ file, sha256 }));
}
