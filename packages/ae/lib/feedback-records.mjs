import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileNoFollow, assertNoSymlinkAncestors } from './fs-safe.mjs';
import { projectStoreDir } from './project-layout.mjs';

// Reading accepted feedback records, and the review rules learned from them.
// This module imports neither review.mjs nor learning-feedback.mjs, so review
// preparation can read rules without an import cycle. Nothing here writes.

export const FEEDBACK_RECORD_MAX_BYTES = 256 * 1024;
export const feedbackDirRel = 'feedback';
const ID = /^[a-f0-9]{64}$/;
// Same digest as review.mjs recordHash; kept local to avoid importing review.mjs.
const recordHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Operation receipts are checkout-local, so two worktrees can accept different
// decisions under one operation name. The project-wide key adds the plan and
// the accepted decision/proof digest; records without a digest keep the
// operation key.
export const feedbackKey = ({ operation, plan, digest }) => digest ? recordHash({ operation, plan, digest }) : operation;
export const feedbackRecordRel = key => `${feedbackDirRel}/${key}.json`;

export function readFeedbackFile(base, rel) {
  const text = readFileNoFollow(path.join(base, rel), { root: base, maxBytes: FEEDBACK_RECORD_MAX_BYTES });
  try { return text === null ? null : JSON.parse(text); } catch { return null; }
}

/**
 * The authored part of a verdict set; Harness observations such as versions may differ on replay.
 * `missed` joins the identity only when present, so records written before it keep their identity.
 */
export const feedbackIdentity = ({ recalled, findings, missed }) => JSON.stringify([
  (Array.isArray(recalled) ? recalled : []).map(entry => [entry?.id, entry?.verdict, entry?.note || null]),
  (Array.isArray(findings) ? findings : []).map(entry => [entry?.id, entry?.disposition, entry?.note || null]),
  ...(missed === undefined ? [] : [(Array.isArray(missed) ? missed : []).map(entry => [entry?.file, entry?.title, entry?.source, entry?.note || null])]),
]);

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

// Learned review rules. A rule is advisory guidance for a reviewer, derived
// from accepted dispositions and authored misses. It never suppresses a
// finding, lowers a severity or skips a reviewer; synthesis ignores it.
export const REVIEW_RULES_SCHEMA = 'review-rules-v1';
export const RULE_THRESHOLDS = Object.freeze({
  noiseCandidate: 2, noiseActive: 3, noisePlans: 2, noiseShare: 0.75, missCandidate: 1, missActive: 2,
});
// Correctness and security findings are never treated as noise, whatever their dismissal history.
export const NOISE_EXEMPT_REVIEWERS = Object.freeze(['spec-flow-analyzer', 'flow-tracer', 'security-reviewer', 'security-sentinel']);
const RULE_CAP = 12, TITLE_CAP = 3;
export const SAFE_RELATIVE_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+\/-]{1,300}$/;
const areaOf = file => {
  const dir = path.posix.dirname(file);
  return dir === '.' ? '.' : dir;
};
const share = (part, whole) => whole ? Number((part / whole).toFixed(3)) : 0;
const order = (a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Rules learned from feedback history; `records` may be passed when the caller already read them. */
export function reviewRules({ workspace, home, records = null }) {
  const history = records || readFeedbackRecords({ workspace, home }).records;
  const noise = new Map(), misses = new Map();
  for (const record of history) {
    const plan = typeof record?.plan === 'string' ? record.plan : null;
    for (const entry of Array.isArray(record?.findings) ? record.findings : []) {
      if (!['fixed', 'dismissed'].includes(entry?.disposition) || typeof entry.file !== 'string' || !SAFE_RELATIVE_FILE.test(entry.file)) continue;
      const area = areaOf(entry.file);
      for (const reviewer of Array.isArray(entry.reviewers) ? entry.reviewers.filter(r => typeof r === 'string' && r) : []) {
        const key = `${reviewer}\u0000${area}`;
        const row = noise.get(key) || { key, reviewer, area, fixed: 0, dismissed: 0, plans: new Set() };
        row[entry.disposition] += 1;
        if (entry.disposition === 'dismissed' && plan) row.plans.add(plan);
        noise.set(key, row);
      }
    }
    for (const entry of Array.isArray(record?.missed) ? record.missed : []) {
      if (typeof entry?.file !== 'string' || !SAFE_RELATIVE_FILE.test(entry.file) || typeof entry.title !== 'string') continue;
      const area = areaOf(entry.file);
      const row = misses.get(area) || { key: area, area, missed: 0, sources: new Set(), titles: [], plans: new Set() };
      row.missed += 1;
      if (typeof entry.source === 'string') row.sources.add(entry.source);
      if (row.titles.length < TITLE_CAP && !row.titles.includes(entry.title)) row.titles.push(entry.title);
      if (plan) row.plans.add(plan);
      misses.set(area, row);
    }
  }
  const t = RULE_THRESHOLDS, active = [], candidates = [];
  for (const row of noise.values()) {
    if (NOISE_EXEMPT_REVIEWERS.includes(row.reviewer) || row.dismissed < t.noiseCandidate) continue;
    const total = row.fixed + row.dismissed, rate = share(row.dismissed, total);
    const rule = {
      kind: 'noise', reviewer: row.reviewer, area: row.area, dismissed: row.dismissed, fixed: row.fixed, plans: row.plans.size, dismissedShare: rate,
      guidance: `${row.dismissed} of ${total} ${row.reviewer} findings in ${row.area} were dismissed across ${row.plans.size} plan(s). Report there only defects with concrete evidence; never lower a P1.`,
      weight: row.dismissed, key: row.key,
    };
    (row.dismissed >= t.noiseActive && row.plans.size >= t.noisePlans && rate >= t.noiseShare ? active : candidates).push(rule);
  }
  for (const row of misses.values()) {
    if (row.missed < t.missCandidate) continue;
    const rule = {
      kind: 'missed', area: row.area, missed: row.missed, plans: row.plans.size, sources: [...row.sources].sort(), titles: row.titles,
      guidance: `Reviews missed ${row.missed} defect(s) in ${row.area} that ${[...row.sources].sort().join(', ') || 'a later reviewer'} caught, such as: ${row.titles.join('; ')}. Trace the negative flows there before reporting a clean result.`,
      weight: row.missed, key: row.key,
    };
    (row.missed >= t.missActive ? active : candidates).push(rule);
  }
  const strip = ({ weight, key, ...rule }) => rule;
  active.sort(order); candidates.sort(order);
  return {
    schema: REVIEW_RULES_SCHEMA, authority: 'advisory', thresholds: { ...t },
    active: active.slice(0, RULE_CAP).map(strip), candidates: candidates.slice(0, RULE_CAP).map(strip),
    omitted: Math.max(0, active.length - RULE_CAP) + Math.max(0, candidates.length - RULE_CAP),
  };
}

/** Active rules whose area holds one of the changed files (the area itself or an ancestor of the file). */
export function rulesForFiles(rules, files) {
  const dirs = [...new Set((files || []).filter(file => typeof file === 'string').map(areaOf))];
  const covers = area => area === '.' ? dirs.includes('.') : dirs.some(dir => dir === area || dir.startsWith(`${area}/`));
  return (rules?.active || []).filter(rule => covers(rule.area));
}
