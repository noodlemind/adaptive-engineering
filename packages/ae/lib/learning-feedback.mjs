import fs from 'node:fs';
import path from 'node:path';
import { readReviewRecord, publishReviewRecord, recordHash } from './review.mjs';
import { readFileNoFollow, readPrefixNoFollow, writeFileContained, assertNoSymlinkAncestors } from './fs-safe.mjs';
import { acquireFileLock, releaseFileLock } from './file-lock.mjs';
import { ensureHarnessDir } from './session.mjs';
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
const FEEDBACK_SECTION_CAP = 20;
// One cap for every feedback record read or write. Plain-text notes keep a
// full record near 110 KiB; escaped content can exceed it and is refused.
const FEEDBACK_RECORD_MAX_BYTES = 256 * 1024;
const FEEDBACK_RECORD_RESERVE_BYTES = 2 * 1024;
const ID = /^[a-f0-9]{64}$/;
const LEARNING_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export const exposureRel = planPath => `.harness/learning/exposures/plan-${recordHash(planPath)}.json`;
const feedbackDirRel = 'feedback';

/** Content identity of a learning version; any mutation, confirmation or supersession changes it. */
export const learningVersion = learning => recordHash({ fm: learning.fm, body: learning.body });

function learningVersions({ workspace, home }) {
  try {
    // A subordinate branch twin shares its protected golden's ID; key it apart so each layer keeps its own version.
    return new Map(loadLayeredLearnings({ workspace, home }).learnings.map(learning => [learning.subordinate ? `${learning.id}#branch` : learning.id, learningVersion(learning)]));
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
export function recordExposure(options) {
  const { recordRoot, planPath, delivered } = options;
  if (!planPath || !Array.isArray(delivered) || !delivered.length) return null;
  // Serialize read/merge/publish so concurrent orientations for one plan cannot drop each other's entries.
  const full = ensureHarnessDir(recordRoot) && assertNoSymlinkAncestors(recordRoot, exposureRel(planPath));
  if (!full) throw new Error('exposure record target is unsafe');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const lock = acquireFileLock(path.join(path.dirname(full), `.${path.basename(full)}.lock`));
  try {
    return mergeExposure(options);
  } finally {
    releaseFileLock(lock);
  }
}

function mergeExposure({ recordRoot, workspace, home, planPath, delivered, now = new Date() }) {
  const versions = learningVersions({ workspace, home });
  const at = now.toISOString();
  const prior = readExposure(recordRoot, planPath);
  // One entry per learning ID and layer, so a golden learning and a branch
  // learning with the same ID keep separate counts. Older entries carry their
  // single layer and read the same way.
  const entryKey = entry => `${entry.id}#${entry.layer === 'branch' ? 'branch' : 'golden'}`;
  // Prior entries are read back from disk; a malformed one is dropped rather than carried forward.
  // A time later than the present (say, written before a backward clock correction) is clamped to the
  // present, never dropped, so its count survives. A caller-supplied clock never makes the real present
  // look like the future.
  const nowMs = Math.max(now.getTime(), Date.now());
  const clamp = value => exposureTime(value) > nowMs ? new Date(nowMs).toISOString() : value;
  const entries = new Map((prior?.entries || []).filter(wellFormedExposure).map(entry => [entryKey(entry), {
    ...entry,
    ...(exposureTime(entry.firstExposedAt) !== null ? { firstExposedAt: clamp(entry.firstExposedAt) } : {}),
    lastExposedAt: clamp(entry.lastExposedAt),
  }]));
  // When both a protected golden and its subordinate twin are delivered, the golden is authoritative.
  const goldenDelivered = new Set(delivered.filter(item => item && typeof item === 'object' && !item.subordinate).map(item => item.id));
  const seen = new Set();
  for (const item of delivered) {
    const id = typeof item === 'string' ? item : item?.id;
    if (typeof id !== 'string' || !LEARNING_ID.test(id)) continue;
    if (item?.subordinate && goldenDelivered.has(id)) continue;
    const layer = item?.layer === 'branch' ? 'branch' : 'golden';
    const key = entryKey({ id, layer });
    if (seen.has(key)) continue;
    seen.add(key);
    const before = entries.get(key);
    // The version of the layer actually credited: a subordinate twin keeps its own.
    const version = versions.get(item?.subordinate ? `${id}#branch` : id) || null;
    entries.set(key, {
      id,
      layer,
      ...(version ? { version } : {}),
      firstExposedAt: before?.firstExposedAt || at,
      lastExposedAt: at,
      count: saturatingAdd(before?.count || 0, 1),
    });
  }
  const byIdLayer = (a, b) => a.id.localeCompare(b.id) || String(a.layer).localeCompare(String(b.layer));
  // This delivery's entries are kept first; carried entries are then kept newest first.
  const delivering = entry => seen.has(entryKey(entry)) ? 1 : 0;
  let kept = [...entries.values()].sort((a, b) => delivering(b) - delivering(a) || b.lastExposedAt.localeCompare(a.lastExposedAt) || byIdLayer(a, b)).slice(0, EXPOSURE_ENTRY_CAP);
  const serialize = list => ({ version: 1, plan: planPath, entries: list.toSorted(byIdLayer) });
  // +1 for the trailing newline publishReviewRecord appends.
  while (kept.length > 1 && Buffer.byteLength(JSON.stringify(serialize(kept), null, 2)) + 1 > EXPOSURE_BYTE_CAP) kept = kept.slice(0, -1);
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

// Review records are published as {"version": N, "plan": ..., ...}; anything else reads in full.
const REVIEW_HEADER = /^\{\s*"version":\s*\d+,\s*"plan":\s*("(?:[^"\\]|\\.)*"|null)/;

/** The plan named in a review record's header, or undefined when the header is not recognized. */
function reviewHeaderPlan(full, root) {
  const prefix = readPrefixNoFollow(full, { root });
  const match = prefix && REVIEW_HEADER.exec(prefix.toString('utf8'));
  if (!match) return undefined;
  try { return JSON.parse(match[1]); } catch { return undefined; }
}

/** Findings from every review record bound to this plan; fixing a finding drops it from the next review. */
export function planReviewFindings(recordRoot, planPath) {
  const dir = path.join(recordRoot, '.harness/reviews/records');
  const found = new Map();
  if (!assertNoSymlinkAncestors(recordRoot, '.harness/reviews/records')) return found;
  let names = [];
  // Every record is considered: a hash-ordered prefix could skip this plan's records and reject a real finding.
  // Review records carry no per-plan index, so another plan's record is skipped from its first 8 KiB header.
  try { names = fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort(); } catch { return found; }
  for (const name of names) {
    const header = reviewHeaderPlan(path.join(dir, name), recordRoot);
    if (header !== undefined && header !== planPath) continue;
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
    // A learning ID can have one entry per layer; the verdict binds the most recently delivered version.
    const exposed = new Map(), nowMs = Date.now();
    for (const entry of exposure?.entries || []) {
      if (!wellFormedExposure(entry)) continue;
      const prior = exposed.get(entry.id);
      if (!prior || clampedExposureTime(entry.lastExposedAt, nowMs) > clampedExposureTime(prior.lastExposedAt, nowMs)) exposed.set(entry.id, entry);
    }
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
  // Notes are bounded in characters, not bytes; refuse before acceptance a record that could never be published.
  // The reserve covers operation, digest, capture date and a readiness citation.
  const bytes = Buffer.byteLength(JSON.stringify({ version: 1, plan: planPath, ...out }, null, 2));
  if (bytes + FEEDBACK_RECORD_RESERVE_BYTES > FEEDBACK_RECORD_MAX_BYTES) throw new Error(`recalled and findings serialize to ${bytes} bytes; the feedback record limit is ${FEEDBACK_RECORD_MAX_BYTES - FEEDBACK_RECORD_RESERVE_BYTES}`);
  return out;
}

// Operation receipts are checkout-local, so two worktrees can accept different
// decisions under one operation name. The project-wide key adds the plan and
// the accepted decision/proof digest; records without a digest keep the
// operation key.
const feedbackKey = ({ operation, plan, digest }) => digest ? recordHash({ operation, plan, digest }) : operation;
const feedbackRecordRel = key => `${feedbackDirRel}/${key}.json`;

function readFeedbackFile(base, rel) {
  const text = readFileNoFollow(path.join(base, rel), { root: base, maxBytes: FEEDBACK_RECORD_MAX_BYTES });
  try { return text === null ? null : JSON.parse(text); } catch { return null; }
}

/** The authored part of a verdict set; Harness observations such as versions may differ on replay. */
const feedbackIdentity = ({ recalled, findings }) => JSON.stringify([
  (Array.isArray(recalled) ? recalled : []).map(entry => [entry?.id, entry?.verdict, entry?.note || null]),
  (Array.isArray(findings) ? findings : []).map(entry => [entry?.id, entry?.disposition, entry?.note || null]),
]);

/**
 * A record accepted before keys carried the digest lives at `<operation>.json`.
 * It is this decision's record only when plan and authored verdicts match.
 */
function legacyAccepted(base, { operation, plan, digest, feedback }) {
  if (!digest || !feedback) return null;
  const rel = feedbackRecordRel(operation);
  const record = readFeedbackFile(base, rel);
  return record?.version === 1 && record.operation === operation && record.plan === plan && record.digest === undefined
    && feedbackIdentity(record) === feedbackIdentity(feedback) ? path.join(base, rel) : null;
}

/**
 * Whether a regular file already holds this record. A file over the read limit
 * (only possible by hand) still marks the decision as recorded; it is never
 * replaced and the caller reports written:false.
 */
function feedbackFileExists(base, rel) {
  const full = assertNoSymlinkAncestors(base, rel);
  if (!full) return false;
  try { return fs.lstatSync(full).isFile(); } catch { return false; }
}

/** One immutable record per accepted learning decision, in the project store so every worktree's verdicts aggregate. */
export function publishFeedbackRecord({ workspace, home, operation, digest, planPath, captureDate, feedback }) {
  if (!feedback || !ID.test(operation || '') || (digest !== undefined && !ID.test(digest || ''))) return null;
  const base = projectStoreDir(workspace, { home });
  const legacy = legacyAccepted(base, { operation, plan: planPath, digest, feedback });
  if (legacy) return { path: legacy, written: false };
  const rel = feedbackRecordRel(feedbackKey({ operation, plan: planPath, digest }));
  // Cite the decision agent's latest readiness receipt so dispositions can measure its judgments later.
  const readiness = latestReadinessReceipt({ workspace, home, planPath });
  const record = { version: 1, operation, ...(digest ? { digest } : {}), plan: planPath, captureDate, ...feedback, ...(readiness ? { readiness } : {}) };
  if (Buffer.byteLength(JSON.stringify(record, null, 2)) + 1 > FEEDBACK_RECORD_MAX_BYTES) throw new Error(`feedback record exceeds ${FEEDBACK_RECORD_MAX_BYTES} bytes`);
  if (feedbackFileExists(base, rel)) return { path: path.join(base, rel), written: false };
  if (!writeFileContained(base, rel, `${JSON.stringify(record, null, 2)}\n`, { exclusive: true })) {
    if (feedbackFileExists(base, rel)) return { path: path.join(base, rel), written: false };
    throw new Error('feedback record target is unsafe or unavailable');
  }
  return { path: path.join(base, rel), written: true };
}

/** Path of the feedback record already accepted for this decision (`feedback` holds its authored verdicts), or null. */
export function acceptedFeedbackRecord({ workspace, home, operation, digest, planPath, feedback }) {
  if (!ID.test(operation || '') || (digest !== undefined && !ID.test(digest || ''))) return null;
  const base = projectStoreDir(workspace, { home });
  const legacy = legacyAccepted(base, { operation, plan: planPath, digest, feedback });
  if (legacy) return legacy;
  const rel = feedbackRecordRel(feedbackKey({ operation, plan: planPath, digest }));
  return feedbackFileExists(base, rel) ? path.join(base, rel) : null;
}

export function readFeedbackRecords({ workspace, home }) {
  const base = projectStoreDir(workspace, { home });
  if (!assertNoSymlinkAncestors(base, feedbackDirRel)) return { records: [] };
  let names = [];
  try { names = fs.readdirSync(path.join(base, feedbackDirRel)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort(); } catch { return { records: [] }; }
  // The full history decides review_required and due; only displayed rows are
  // capped. Callers read it only under `suggest` or `on`, and each file is small.
  const records = [];
  for (const name of names) {
    const record = readFeedbackFile(base, `${feedbackDirRel}/${name}`);
    if (record?.version === 1 && (record.digest === undefined || ID.test(record.digest)) && `${feedbackKey(record)}.json` === name) records.push(record);
  }
  // A keyed record repeating a legacy record's operation, plan and authored verdicts is the same decision; count it once.
  const sameDecision = record => JSON.stringify([record.operation, record.plan, feedbackIdentity(record)]);
  const legacy = new Set(records.filter(record => record.digest === undefined).map(sameDecision));
  return { records: records.filter(record => record.digest === undefined || !legacy.has(sameDecision(record))) };
}

/**
 * Evidence for consolidation: per-learning verdict counts, learnings whose
 * current version was judged `wrong`, and per-reviewer finding dispositions.
 * Counts never activate, retire or dispute anything. A `verdicts` Map, when
 * passed, receives the `helped` and `wrong` tallies feedbackColumns uses.
 */
export function feedbackSummary({ workspace, home, learnings, verdicts = null }) {
  const { records } = readFeedbackRecords({ workspace, home });
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
      // Optional caller tally for feedbackColumns, filled in this same pass so the history is read once.
      if (verdicts) tallyVerdict(verdicts, entry);
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
// Only a strict ISO-8601 UTC timestamp (as toISOString writes) is a valid exposure time; it compares by parsed time.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const exposureTime = value => {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
};
// An exposure time later than the present is read as the present: after a backward clock correction
// real entries look future, and they must neither be lost nor sort first forever.
const clampedExposureTime = (value, nowMs = Date.now()) => {
  const ms = exposureTime(value);
  return ms === null ? null : Math.min(ms, nowMs);
};
// One exposure entry as read back from disk. The writer carries forward, the reader counts and the
// delivered gate accepts exactly the entries that pass this test: a learning ID, a count of at least
// one, a version that is absent or a content hash, and a strict ISO exposure time. A future time is
// valid; every comparison clamps it to the present.
const wellFormedExposure = entry => Boolean(entry) && typeof entry.id === 'string' && LEARNING_ID.test(entry.id)
  && Number.isSafeInteger(entry.count) && entry.count >= 1 && (entry.version === undefined || ID.test(entry.version))
  && exposureTime(entry.lastExposedAt) !== null;
const later = (a, b, nowMs = Date.now()) => {
  const next = clampedExposureTime(b, nowMs);
  if (next === null) return a;
  const prior = clampedExposureTime(a, nowMs);
  return prior === null || next > prior ? new Date(next).toISOString() : a;
};
// Counts are safe integers; a sum saturates rather than overflowing to Infinity.
const saturatingAdd = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);

/**
 * Per-learning exposure totals summed over every plan's exposure record under
 * this record root, with a per-layer split. Every record is read; each is
 * read with a 32 KiB + 1 byte limit. Counts are lower bounds: a record keeps at most 64
 * (id, layer) entries per plan and an evicted entry restarts at 1. Exposure records live
 * in each worktree, so another worktree's exposures are not visible here.
 * Branch-layer exposure is not scoped to a bucket: after a branch switch, a
 * same-ID branch learning on the new branch inherits the old branch's count.
 */
export function exposureTotals(recordRoot) {
  const totals = new Map(), nowMs = Date.now();
  if (!recordRoot || !assertNoSymlinkAncestors(recordRoot, EXPOSURE_DIR_REL)) return totals;
  let names = [];
  try { names = fs.readdirSync(path.join(recordRoot, EXPOSURE_DIR_REL)).filter(name => /^plan-[a-f0-9]{64}\.json$/.test(name)).sort(); } catch { return totals; }
  for (const name of names) {
    const rel = `${EXPOSURE_DIR_REL}/${name}`;
    // Records are written under EXPOSURE_BYTE_CAP; earlier writers could reach one byte more
    // (the trailing newline). A larger file is not ours and is skipped.
    const text = readFileNoFollow(path.join(recordRoot, rel), { root: recordRoot, maxBytes: EXPOSURE_BYTE_CAP + 1 });
    let record = null;
    try { record = text === null ? null : JSON.parse(text); } catch { record = null; }
    if (!record || record.version !== 1 || typeof record.plan !== 'string' || exposureRel(record.plan) !== rel || !Array.isArray(record.entries)) continue;
    for (const entry of record.entries) {
      if (!wellFormedExposure(entry)) continue;
      const row = totals.get(entry.id) || { exposed: 0, last_exposed: null, layers: {} };
      const key = layerOf(entry.layer);
      const layer = row.layers[key] || { exposed: 0, last_exposed: null };
      row.exposed = saturatingAdd(row.exposed, entry.count);
      layer.exposed = saturatingAdd(layer.exposed, entry.count);
      row.last_exposed = later(row.last_exposed, entry.lastExposedAt, nowMs);
      layer.last_exposed = later(layer.last_exposed, entry.lastExposedAt, nowMs);
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
export function feedbackColumns({ workspace, home, recordRoot = workspace, verdicts = null }) {
  let exposure = new Map();
  // Evidence only: an unreadable source degrades to zero counts, never a failure.
  try { exposure = exposureTotals(recordRoot); } catch { exposure = new Map(); }
  // A caller that already read the history (feedbackSummary's `verdicts`) passes its tallies.
  if (verdicts) return { exposure, verdicts };
  const tallies = new Map();
  try {
    for (const record of readFeedbackRecords({ workspace, home }).records) {
      for (const entry of Array.isArray(record.recalled) ? record.recalled : []) tallyVerdict(tallies, entry);
    }
  } catch { /* feedback records unreadable */ }
  return { exposure, verdicts: tallies };
}

function tallyVerdict(verdicts, entry) {
  if (typeof entry?.id !== 'string' || !['helped', 'wrong'].includes(entry.verdict)) return;
  const row = verdicts.get(entry.id) || { helped: 0, wrong: 0 };
  row[entry.verdict] += 1;
  verdicts.set(entry.id, row);
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

// A subordinate branch twin shares its protected golden learning's ID: one row
// per ID. The twin is dropped only when its golden is in this same set, so a
// retired golden filtered out by the caller does not hide an active twin.
const primary = learnings => {
  const list = learnings || [];
  const golden = new Set(list.filter(learning => !learning.subordinate).map(learning => learning.id));
  return list.filter(learning => !learning.subordinate || !golden.has(learning.id));
};

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
    .map(learning => ({ id: learning.id, layer: layerOf(learning.layer), file: typeof learning.file === 'string' ? learning.file : null, ...(columnsFor(columns, learning.id, learning.layer) || emptyFeedbackColumns()) }))
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
