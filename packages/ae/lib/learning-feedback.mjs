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
  for (const item of delivered) {
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

export function readFeedbackRecords({ workspace, home }) {
  const base = projectStoreDir(workspace, { home });
  if (!assertNoSymlinkAncestors(base, feedbackDirRel)) return { records: [], omitted: 0 };
  let names = [];
  try { names = fs.readdirSync(path.join(base, feedbackDirRel)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort(); } catch { return { records: [], omitted: 0 }; }
  const records = [];
  for (const name of names.slice(0, FEEDBACK_RECORD_SCAN_CAP)) {
    const text = readFileNoFollow(path.join(base, feedbackDirRel, name), { root: base, maxBytes: 1024 * 1024 });
    try {
      const record = JSON.parse(text);
      if (record?.version === 1 && `${record.operation}.json` === name) records.push(record);
    } catch { /* unreadable records are skipped */ }
  }
  return { records, omitted: Math.max(0, names.length - FEEDBACK_RECORD_SCAN_CAP) };
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
