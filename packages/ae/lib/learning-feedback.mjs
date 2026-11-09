import fs from 'node:fs';
import path from 'node:path';
import { readReviewRecord, publishReviewRecord, recordHash } from './review.mjs';
import { readFileNoFollow, writeFileContained, assertNoSymlinkAncestors } from './fs-safe.mjs';
import { scanSecrets } from './secret-scan.mjs';
import { projectStoreDir } from './project-layout.mjs';
import { loadLayeredLearnings } from './knowledge/overlay.mjs';
import { readFeedbackConfig, readStoreConfig } from './knowledge/store.mjs';
import { latestReadinessReceipt } from './decision-agent.mjs';

// Recall feedback loop (agent memory plan, Phase 1). Everything here is
// Harness bookkeeping and evidence for judgment: nothing in this module
// changes a learning's status or content, and no state of
// `knowledge.feedback` grants authority.

export const EXPOSURE_ENTRY_CAP = 64;
export const EXPOSURE_BYTE_CAP = 32 * 1024;
export const FEEDBACK_NOTE_CAP = 280;
export const RECALLED_VERDICTS = Object.freeze(['helped', 'irrelevant', 'wrong']);
export const FINDING_DISPOSITIONS = Object.freeze(['fixed', 'dismissed']);
const FINDING_ENTRY_CAP = 128;
const REVIEW_RECORD_SCAN_CAP = 256;
const FEEDBACK_RECORD_SCAN_CAP = 512;
const FEEDBACK_SECTION_CAP = 20;
const ID = /^[a-f0-9]{64}$/;
const LEARNING_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export const exposureRel = planPath => `.harness/learning/exposures/plan-${recordHash(planPath)}.json`;
const feedbackDirRel = 'feedback';

/** Content identity of a learning version; any mutation, confirmation or supersession changes it. */
export const learningVersion = learning => recordHash({ fm: learning.fm, body: learning.body });

function learningVersions({ workspace, home }) {
  try {
    return new Map(loadLayeredLearnings({ workspace, home }).learnings.map(learning => [learning.id, learningVersion(learning)]));
  } catch {
    return new Map();
  }
}

/**
 * Effective read state. Knowledge modes keep priority: `off`, `freeze` and
 * `capture-only` read feedback as `off` whatever the key says.
 */
export function feedbackState({ workspace, home }) {
  const { mode } = readStoreConfig(workspace, { home });
  if (!['on', 'suggest'].includes(mode)) return 'off';
  return readFeedbackConfig(workspace, { home });
}

export function readExposure(recordRoot, planPath) {
  const record = readReviewRecord(recordRoot, exposureRel(planPath));
  if (!record || record.version !== 1 || record.plan !== planPath || !Array.isArray(record.entries)) return null;
  return record;
}

/**
 * Append the learning IDs actually delivered in a context pack to the plan's
 * bounded exposure record. Written in every feedback state: it is Harness
 * bookkeeping, outside the work contract, and never invalidates evidence.
 */
export function recordExposure({ recordRoot, workspace, home, planPath, delivered, now = new Date() }) {
  if (!planPath || !Array.isArray(delivered) || !delivered.length) return null;
  const versions = learningVersions({ workspace, home });
  const at = now.toISOString();
  const prior = readExposure(recordRoot, planPath);
  const entries = new Map((prior?.entries || []).map(entry => [entry.id, entry]));
  // One exposure per learning ID per pack: a protected golden learning and its
  // subordinate branch twin share an ID, and the golden entry wins.
  const unique = new Map();
  for (const item of delivered) {
    const key = typeof item === 'string' ? item : item?.id;
    if (!unique.has(key) || (unique.get(key)?.subordinate && !item?.subordinate)) unique.set(key, item);
  }
  for (const item of unique.values()) {
    const id = typeof item === 'string' ? item : item?.id;
    if (typeof id !== 'string' || !LEARNING_ID.test(id)) continue;
    const before = entries.get(id);
    const version = versions.get(id) || null;
    entries.set(id, {
      id,
      layer: item?.layer === 'branch' ? 'branch' : 'golden',
      ...(version ? { version } : {}),
      firstExposedAt: before?.firstExposedAt || at,
      lastExposedAt: at,
      count: (before?.count || 0) + 1,
    });
  }
  let kept = [...entries.values()].sort((a, b) => b.lastExposedAt.localeCompare(a.lastExposedAt) || a.id.localeCompare(b.id)).slice(0, EXPOSURE_ENTRY_CAP);
  const serialize = list => ({ version: 1, plan: planPath, entries: list.toSorted((a, b) => a.id.localeCompare(b.id)) });
  while (kept.length > 1 && Buffer.byteLength(JSON.stringify(serialize(kept), null, 2)) > EXPOSURE_BYTE_CAP) kept = kept.slice(0, -1);
  const record = serialize(kept);
  publishReviewRecord(recordRoot, exposureRel(planPath), record);
  return record;
}

function checkNote(note, label) {
  if (note === undefined) return;
  if (typeof note !== 'string' || note.length > FEEDBACK_NOTE_CAP) throw new Error(`${label} note must be text of at most ${FEEDBACK_NOTE_CAP} characters`);
  if (scanSecrets(note).length) throw new Error(`${label} note looks like it contains a secret; remove it`);
}

function checkEntries(value, { field, cap, keys, choiceKey, choices }) {
  if (!Array.isArray(value) || !value.length || value.length > cap) throw new Error(`${field} must be a nonempty array of at most ${cap} entries`);
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !keys.includes(key))) throw new Error(`${field} entries allow only ${keys.join(', ')}`);
    if (typeof entry.id !== 'string' || !entry.id) throw new Error(`${field} entry requires an id`);
    if (seen.has(entry.id)) throw new Error(`${field} lists ${entry.id} more than once`);
    seen.add(entry.id);
    if (!choices.includes(entry[choiceKey])) throw new Error(`${field} ${choiceKey} must be one of ${choices.join(', ')}`);
    checkNote(entry.note, field);
  }
}

/** Findings from every review record bound to this plan; fixing a finding drops it from the next review. */
export function planReviewFindings(recordRoot, planPath) {
  const dir = path.join(recordRoot, '.harness/reviews/records');
  const found = new Map();
  if (!assertNoSymlinkAncestors(recordRoot, '.harness/reviews/records')) return found;
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort().slice(0, REVIEW_RECORD_SCAN_CAP); } catch { return found; }
  for (const name of names) {
    const record = readReviewRecord(recordRoot, `.harness/reviews/records/${name}`);
    if (!record || record.plan !== planPath || !Array.isArray(record.findings)) continue;
    for (const finding of record.findings) {
      if (!ID.test(finding?.id || '')) continue;
      const reviewers = Array.isArray(finding.reviewers) ? finding.reviewers : finding.reviewer ? [finding.reviewer] : [];
      const prior = found.get(finding.id) || [];
      found.set(finding.id, [...new Set([...prior, ...reviewers.filter(r => typeof r === 'string')])].sort());
    }
  }
  return found;
}

/** Finding IDs in the plan's latest review record, or null when there is none. */
export function latestReviewFindingIds(recordRoot, planPath) {
  const pointer = readReviewRecord(recordRoot, `.harness/reviews/latest/${recordHash(planPath)}.json`);
  if (!ID.test(pointer?.id || '')) return null;
  const record = readReviewRecord(recordRoot, `.harness/reviews/records/${pointer.id}.json`);
  if (!record || record.plan !== planPath || !Array.isArray(record.findings)) return null;
  return new Set(record.findings.map(finding => finding?.id).filter(id => ID.test(id || '')));
}

/**
 * Harness's own observation of a finding, recorded beside the agent's claimed
 * disposition so a mismatch is visible: a finding claimed `fixed` that the
 * latest review still reports is contradicted.
 */
const observedFinding = (latest, id) => latest === null ? 'no-latest-review' : latest.has(id) ? 'still-reported' : 'no-longer-reported';

/**
 * Validate the optional `recalled` and `findings` fields of a learning
 * decision. Absent fields return null and change nothing, so existing
 * decision bytes and digests stay identical.
 */
export function validateFeedbackFields(decision, { recordRoot, planPath }) {
  const hasRecalled = decision.recalled !== undefined, hasFindings = decision.findings !== undefined;
  if (!hasRecalled && !hasFindings) return null;
  const out = {};
  if (hasRecalled) {
    checkEntries(decision.recalled, { field: 'recalled', cap: EXPOSURE_ENTRY_CAP, keys: ['id', 'verdict', 'note'], choiceKey: 'verdict', choices: RECALLED_VERDICTS });
    const exposure = readExposure(recordRoot, planPath);
    const exposed = new Map((exposure?.entries || []).map(entry => [entry.id, entry]));
    const unknown = decision.recalled.filter(entry => !exposed.has(entry.id)).map(entry => entry.id);
    if (unknown.length) throw new Error(`recalled lists learnings this plan's context packs never delivered: ${unknown.join(', ')}`);
    out.recalled = decision.recalled.map(entry => ({ id: entry.id, verdict: entry.verdict, ...(exposed.get(entry.id).version ? { version: exposed.get(entry.id).version } : {}), ...(entry.note ? { note: entry.note } : {}) }));
  }
  if (hasFindings) {
    checkEntries(decision.findings, { field: 'findings', cap: FINDING_ENTRY_CAP, keys: ['id', 'disposition', 'note'], choiceKey: 'disposition', choices: FINDING_DISPOSITIONS });
    const known = planReviewFindings(recordRoot, planPath);
    const unknown = decision.findings.filter(entry => !known.has(entry.id)).map(entry => entry.id);
    if (unknown.length) throw new Error(`findings lists IDs that no review record of this plan contains: ${unknown.join(', ')}`);
    const latest = latestReviewFindingIds(recordRoot, planPath);
    out.findings = decision.findings.map(entry => ({ id: entry.id, disposition: entry.disposition, reviewers: known.get(entry.id), observed: observedFinding(latest, entry.id), ...(entry.note ? { note: entry.note } : {}) }));
  }
  return out;
}

const feedbackRecordRel = operation => `${feedbackDirRel}/${operation}.json`;

/** One immutable record per learning operation, in the project store so every worktree's verdicts aggregate. */
export function publishFeedbackRecord({ workspace, home, operation, planPath, captureDate, feedback }) {
  if (!feedback || !ID.test(operation || '')) return null;
  const base = projectStoreDir(workspace, { home });
  const rel = feedbackRecordRel(operation);
  // Cite the decision agent's latest readiness receipt so dispositions can measure its judgments later.
  const readiness = latestReadinessReceipt({ workspace, home, planPath });
  const record = { version: 1, operation, plan: planPath, captureDate, ...feedback, ...(readiness ? { readiness } : {}) };
  const existing = readFileNoFollow(path.join(base, rel), { root: base, maxBytes: 1024 * 1024 });
  if (existing !== null) return { path: path.join(base, rel), written: false };
  if (!writeFileContained(base, rel, `${JSON.stringify(record, null, 2)}\n`, { exclusive: true })) {
    if (readFileNoFollow(path.join(base, rel), { root: base, maxBytes: 1024 * 1024 }) !== null) return { path: path.join(base, rel), written: false };
    throw new Error('feedback record target is unsafe or unavailable');
  }
  return { path: path.join(base, rel), written: true };
}

export function readFeedbackRecords({ workspace, home, cap = FEEDBACK_RECORD_SCAN_CAP }) {
  const base = projectStoreDir(workspace, { home });
  if (!assertNoSymlinkAncestors(base, feedbackDirRel)) return { records: [], omitted: 0 };
  let names = [];
  try { names = fs.readdirSync(path.join(base, feedbackDirRel)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort(); } catch { return { records: [], omitted: 0 }; }
  const records = [];
  for (const name of names.slice(0, cap)) {
    const text = readFileNoFollow(path.join(base, feedbackDirRel, name), { root: base, maxBytes: 1024 * 1024 });
    try {
      const record = JSON.parse(text);
      if (record?.version === 1 && `${record.operation}.json` === name) records.push(record);
    } catch { /* unreadable records are skipped */ }
  }
  return { records, omitted: Math.max(0, names.length - cap) };
}

/**
 * Evidence for consolidation: per-learning verdict counts, learnings whose
 * current version was judged `wrong`, and per-reviewer finding dispositions.
 * Counts never activate, retire or dispute anything.
 */
export function feedbackSummary({ workspace, home, learnings }) {
  const { records, omitted } = readFeedbackRecords({ workspace, home });
  const current = new Map((learnings || []).map(learning => [learning.id, learningVersion(learning)]));
  const perLearning = new Map(), perReviewer = new Map();
  for (const record of records) {
    for (const entry of Array.isArray(record.recalled) ? record.recalled : []) {
      if (!RECALLED_VERDICTS.includes(entry?.verdict) || typeof entry.id !== 'string') continue;
      const row = perLearning.get(entry.id) || { id: entry.id, helped: 0, irrelevant: 0, wrong: 0, plans: new Set(), wrongCurrent: false };
      row[entry.verdict] += 1;
      if (typeof record.plan === 'string') row.plans.add(record.plan);
      if (entry.verdict === 'wrong' && entry.version && entry.version === current.get(entry.id)) row.wrongCurrent = true;
      perLearning.set(entry.id, row);
    }
    for (const entry of Array.isArray(record.findings) ? record.findings : []) {
      if (!FINDING_DISPOSITIONS.includes(entry?.disposition)) continue;
      for (const reviewer of Array.isArray(entry.reviewers) && entry.reviewers.length ? entry.reviewers : ['unknown']) {
        const row = perReviewer.get(reviewer) || { reviewer, fixed: 0, dismissed: 0, contradicted: 0 };
        row[entry.disposition] += 1;
        if (entry.disposition === 'fixed' && entry.observed === 'still-reported') row.contradicted += 1;
        perReviewer.set(reviewer, row);
      }
    }
  }
  const learningRows = [...perLearning.values()]
    .filter(row => current.has(row.id))
    .sort((a, b) => Number(b.wrongCurrent) - Number(a.wrongCurrent) || b.wrong - a.wrong || a.id.localeCompare(b.id));
  const reviewerRows = [...perReviewer.values()].sort((a, b) => a.reviewer.localeCompare(b.reviewer));
  return {
    records: records.length,
    ...(omitted ? { omittedRecords: omitted } : {}),
    learnings: learningRows.slice(0, FEEDBACK_SECTION_CAP).map(({ plans, wrongCurrent, ...row }) => ({ ...row, plans: [...plans].sort().slice(0, 5) })),
    ...(learningRows.length > FEEDBACK_SECTION_CAP ? { omittedLearnings: learningRows.length - FEEDBACK_SECTION_CAP } : {}),
    review_required: learningRows.filter(row => row.wrongCurrent).map(row => row.id),
    reviewers: reviewerRows.map(row => ({ ...row, resolutionRate: Number((row.fixed / (row.fixed + row.dismissed)).toFixed(3)) })),
  };
}

// Visibility (memory plan 1d, rest of 1e). Readers only: nothing below writes
// learning content, governance or status.

export const PRUNING_EXPOSURE_THRESHOLD = 5;
const EXPOSURE_DIR_REL = '.harness/learning/exposures';
const layerOf = value => value === 'branch' ? 'branch' : 'golden';
const later = (a, b) => typeof b === 'string' && (!a || b > a) ? b : a;

/**
 * Per-learning exposure totals summed over every plan's exposure record under
 * this record root, with a per-layer split. Every record is read (each one is
 * capped at 32 KiB). Counts are lower bounds: a record keeps at most 64
 * entries per plan and an evicted entry restarts at 1. Exposure records live
 * in each worktree, so another worktree's exposures are not visible here.
 */
export function exposureTotals(recordRoot) {
  const totals = new Map();
  if (!recordRoot || !assertNoSymlinkAncestors(recordRoot, EXPOSURE_DIR_REL)) return totals;
  let names = [];
  try { names = fs.readdirSync(path.join(recordRoot, EXPOSURE_DIR_REL)).filter(name => /^plan-[a-f0-9]{64}\.json$/.test(name)).sort(); } catch { return totals; }
  for (const name of names) {
    const rel = `${EXPOSURE_DIR_REL}/${name}`;
    const record = readReviewRecord(recordRoot, rel);
    if (!record || record.version !== 1 || typeof record.plan !== 'string' || exposureRel(record.plan) !== rel || !Array.isArray(record.entries)) continue;
    for (const entry of record.entries) {
      if (typeof entry?.id !== 'string' || !LEARNING_ID.test(entry.id) || !Number.isInteger(entry.count) || entry.count < 1) continue;
      const row = totals.get(entry.id) || { exposed: 0, last_exposed: null, layers: {} };
      const key = layerOf(entry.layer);
      const layer = row.layers[key] || { exposed: 0, last_exposed: null };
      row.exposed += entry.count;
      layer.exposed += entry.count;
      row.last_exposed = later(row.last_exposed, entry.lastExposedAt);
      layer.last_exposed = later(layer.last_exposed, entry.lastExposedAt);
      row.layers[key] = layer;
      totals.set(entry.id, row);
    }
  }
  return totals;
}

export const emptyFeedbackColumns = () => ({ exposed: 0, helped: 0, wrong: 0, last_exposed: null });

/**
 * Sources for the `exposed`, `helped`, `wrong` and `last_exposed` columns.
 * Verdicts are tallied over the full feedback history, never a capped scan,
 * because the pruning hint and ordering decide on them. Read one learning's
 * row with `columnsFor`.
 */
export function feedbackColumns({ workspace, home, recordRoot = workspace }) {
  let exposure = new Map();
  // Evidence only: an unreadable source degrades to zero counts, never a failure.
  try { exposure = exposureTotals(recordRoot); } catch { exposure = new Map(); }
  const verdicts = new Map();
  try {
    for (const record of readFeedbackRecords({ workspace, home, cap: Infinity }).records) {
      for (const entry of Array.isArray(record.recalled) ? record.recalled : []) {
        if (typeof entry?.id !== 'string' || !['helped', 'wrong'].includes(entry.verdict)) continue;
        const row = verdicts.get(entry.id) || { helped: 0, wrong: 0 };
        row[entry.verdict] += 1;
        verdicts.set(entry.id, row);
      }
    }
  } catch { /* feedback records unreadable */ }
  return { exposure, verdicts };
}

/**
 * One learning's columns, or null when it has no exposure in its layer and no
 * `helped` or `wrong` verdict. Exposure is credited to the layer the pack
 * delivered; verdicts carry no layer and count for the ID.
 */
export function columnsFor(columns, id, layer = 'golden') {
  const exposed = columns.exposure.get(id)?.layers[layerOf(layer)];
  const verdict = columns.verdicts.get(id);
  if (!exposed && !verdict) return null;
  return { exposed: exposed?.exposed || 0, helped: verdict?.helped || 0, wrong: verdict?.wrong || 0, last_exposed: exposed?.last_exposed || null };
}

// A subordinate branch twin shares its protected golden learning's ID: one row per ID.
const primary = learnings => (learnings || []).filter(learning => !learning.subordinate);

/**
 * Status rows for learnings with any exposure, `helped` or `wrong` verdict;
 * null when the effective feedback state is `off`, so status output stays
 * byte-identical.
 */
export function feedbackStatusView({ workspace, home, learnings, recordRoot = workspace }) {
  let state = 'off';
  try { state = feedbackState({ workspace, home }); } catch { state = 'off'; }
  if (state === 'off') return null;
  const columns = feedbackColumns({ workspace, home, recordRoot });
  const rows = primary(learnings)
    .map(learning => ({ id: learning.id, columns: columnsFor(columns, learning.id, learning.layer) }))
    .filter(row => row.columns)
    .map(row => ({ id: row.id, ...row.columns }))
    .sort((a, b) => b.exposed - a.exposed || b.wrong - a.wrong || a.id.localeCompare(b.id));
  return {
    state,
    learnings: rows.slice(0, FEEDBACK_SECTION_CAP),
    ...(rows.length > FEEDBACK_SECTION_CAP ? { omittedLearnings: rows.length - FEEDBACK_SECTION_CAP } : {}),
  };
}

/**
 * Advisory pruning hint: learnings delivered in at least the threshold of
 * context packs (orient runs, not distinct plans) with no `helped` verdict.
 */
export function pruningCandidates({ columns, learnings, threshold = PRUNING_EXPOSURE_THRESHOLD }) {
  return primary(learnings)
    .map(learning => ({ id: learning.id, ...(columnsFor(columns, learning.id, learning.layer) || emptyFeedbackColumns()) }))
    .filter(row => row.exposed >= threshold && row.helped === 0)
    .sort((a, b) => b.exposed - a.exposed || a.id.localeCompare(b.id));
}

/**
 * Packet ordering under `knowledge.feedback=on`: learnings whose current
 * version needs review first, then learnings with any `wrong` verdict, then
 * the most exposed in this layer. Ties keep the incoming order. Ordering
 * only: nothing is activated, disputed or retired.
 */
export function feedbackOrder(learnings, { columns, reviewRequired = [], layer = 'golden' }) {
  const review = new Set(reviewRequired);
  const col = id => columnsFor(columns, id, layer) || emptyFeedbackColumns();
  return learnings.toSorted((a, b) =>
    Number(review.has(b.id)) - Number(review.has(a.id))
    || Number(col(b.id).wrong > 0) - Number(col(a.id).wrong > 0)
    || col(b.id).exposed - col(a.id).exposed);
}
