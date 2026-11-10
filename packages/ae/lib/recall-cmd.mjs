import { rankRecall, findMatchingPlans, loadManifest } from './recall-rank.mjs';
import { parseQueryFromArgv } from './argv.mjs';
import { redactRecallEntry } from './secret-scan.mjs';

export function runRecall({ workspace, copilotHome, flags, argv }) {
  const query = parseQueryFromArgv(argv, flags);
  if (!query) {
    throw new Error('recall requires a query string, e.g. ae recall "orders timeout"');
  }

  const manifest = loadManifest(copilotHome, workspace, { home: flags.harnessHome || flags.home });
  const recall = rankRecall(query, {
    copilotHome,
    workspace,
    limit: flags.limit || 3,
    collection: flags.collection,
    minScore: flags.minScore ?? 0.15,
    home: flags.harnessHome || flags.home,
    manifest,
      }).map((e) => redactRecallEntry({
    docid: e.docid || e.id,
    path: e.path,
    title: e.title || e.id,
    score: Number(e.score.toFixed(3)),
    summary: e.summary || '',
    snippet: e.snippet || '',
    scope: e.scope,
    kind: e.kind || 'solution',
    ranker: e.ranker || 'overlap',
  }));

  const plans = flags.includePlans
    ? findMatchingPlans(workspace, query, flags.limit || 3)
    : [];

  return { query, recall, plans, ...(manifest.warnings?.length ? { warnings: manifest.warnings } : {}) };
}
