import fs from 'node:fs';
import { storeDir, listLearnings, inertLine, repoId } from './store.mjs';
import { redactSecrets } from '../secret-scan.mjs';
import { readEvents, EVENTS_MAX_LIMIT } from '../events.mjs';
import { verifiedAndPlans, isPromotionEligible, consolidateStatus } from './consolidate.mjs';
import { APPLICABILITY_VERSION, learningApplicability } from './applicability.mjs';
import { feedbackState, feedbackColumns, columnsFor, emptyFeedbackColumns } from '../learning-feedback.mjs';

function failureCounts(workspace) {
  const counts = new Map();
  try {
    for (const e of readEvents(workspace, { failures: true, limit: EVENTS_MAX_LIMIT })) {
      if (e.type === 'verify' && e.result === 'fail' && Array.isArray(e.learnings)) {
        for (const id of e.learnings) counts.set(id, (counts.get(id) || 0) + 1);
      }
    }
  } catch {
    // missing/corrupt events file — no failure annotations
  }
  return counts;
}

const STATUS_VALUES = new Set(['active', 'provisional', 'retired', 'disputed', 'superseded', 'promoted']);
const SOURCE_VALUES = new Set(['auto', 'human']);
const EPISODE_KINDS = new Set(['fix', 'insight', 'human-teaching']);

const allowed = (set, value, fallback) => (set.has(value) ? value : fallback);

function effectiveStatus(fm) {
  if (fm.superseded_by) return 'superseded';
  if (fm.promoted_to) return 'promoted';
  return allowed(STATUS_VALUES, fm.status || 'active', 'unknown');
}

export function parseMergedFrom(raw) {
  if (!raw) return null;
  const items = String(raw)
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : null;
}

export function parseMergedFromForRender(raw) {
  const items = parseMergedFrom(raw);
  return items ? items.map((id) => inertLine(id)) : null;
}

export function listingView({ workspace, copilotHome, domain, home }) {
  const dir = storeDir(workspace, { home });
    if (!fs.existsSync(dir)) return { learnings: [], counts: { active: 0, total: 0 }, quarantined: [] };
  const all = listLearnings(dir);
  const scoped = domain ? all.filter((l) => l.domain === domain) : all;
  const failures = failureCounts(workspace);
  const repository = scoped.some(learning => String(learning.fm.applicability_version) === String(APPLICABILITY_VERSION)) ? repoId(workspace) : null;
  const sourceCache = new Map();
  // Feedback columns appear only under `suggest` or `on`, so `off` output is byte-identical.
  let state = 'off';
  try { state = feedbackState({ workspace, home }); } catch { state = 'off'; }
  const columns = state === 'off' ? null : feedbackColumns({ workspace, home });

  const learnings = scoped
    .map((l) => {
      const { verified, plans } = verifiedAndPlans(l.fm);
      return {
        id: inertLine(l.id),
        status: effectiveStatus(l.fm),
        source: allowed(SOURCE_VALUES, l.fm.source || 'auto', 'unknown'),
                trigger: inertLine(redactSecrets(l.fm.trigger || '')),
        verified,
        plans,
                promotionEligible: l.fm.promoted_to ? false : isPromotionEligible(verified, plans),
        failures: failures.get(l.id) || 0,
        applicability: learningApplicability({ workspace, repository, cache: sourceCache, fm: l.fm }),
        // The listing reads the golden store only, so only golden-layer exposure counts.
        ...(columns ? columnsFor(columns, l.id, 'golden') || emptyFeedbackColumns() : {}),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const active = learnings.filter((l) => !['retired', 'disputed', 'superseded', 'promoted'].includes(l.status)).length;
    const quarantined = consolidateStatus({ workspace, copilotHome, home, withRecheck: false }).quarantined.map((q) => ({
    path: q.path,
    sha256: q.sha256,
  }));
  return { learnings, counts: { active, total: learnings.length }, quarantined, ...(columns ? { feedback: state } : {}) };
}

export function whyView({ workspace, id, home }) {
  const dir = storeDir(workspace, { home });
    if (!fs.existsSync(dir)) return null;
  const learning = listLearnings(dir).find((l) => l.id === id);
  if (!learning) return null;

  const { fm, body } = learning;
  const { verified, plans } = verifiedAndPlans(fm);
    const claimLine = inertLine(redactSecrets((body.split('\n').find((line) => line.trim()) || '').trim())).slice(0, 140);
  const failures = failureCounts(workspace).get(id) || 0;
  const repository = String(fm.applicability_version) === String(APPLICABILITY_VERSION) ? repoId(workspace) : null;

  return {
    // `id` is the caller's lookup string echoed back into a rendered row.
    id: inertLine(id),
        trigger: inertLine(redactSecrets(fm.trigger || '')),
    claimLine,
    status: effectiveStatus(fm),
    source: allowed(SOURCE_VALUES, fm.source || 'auto', 'unknown'),
        lastConfirmed: fm.last_confirmed ? inertLine(fm.last_confirmed) : null,
    supersededBy: fm.superseded_by ? inertLine(fm.superseded_by) : null,
    promotedTo: fm.promoted_to ? inertLine(redactSecrets(String(fm.promoted_to))) : null,
    mergedFrom: parseMergedFromForRender(fm.merged_from),
        episodes: (fm.episodes || []).map((e) => ({
      path: inertLine(redactSecrets(String(e.path || ''))),
            kind: allowed(EPISODE_KINDS, e.kind, 'unknown'),
      plan: e.plan ? inertLine(redactSecrets(String(e.plan))) : null,
    })),
    verified,
    plans,
        promotionEligible: fm.promoted_to ? false : isPromotionEligible(verified, plans),
    failures,
    applicability: learningApplicability({ workspace, repository, fm }),
  };
}

export function resolveLearningsView({ argv, flags, workspace, copilotHome, home, hasFlag }) {
    if (hasFlag(argv, '--why') && !flags.why) {
    return { outcome: 'usage', message: 'usage: ae learnings --why <id>' };
  }
  if (flags.why) {
    const result = whyView({ workspace, id: flags.why, home });
    return result ? { outcome: 'why', result } : { outcome: 'not-found', id: flags.why };
  }
  const domain = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  return { outcome: 'listing', result: listingView({ workspace, copilotHome, domain, home }) };
}
