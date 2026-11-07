import { planRecordRoot, planHome, planTrustHome } from './domain-context.mjs';
import { domainPrerequisites } from './domain-delivery.mjs';
import { readEvidence, validateEvidence } from './evidence.mjs';
import { loadPolicy } from './policy.mjs';
import { validateReview, recordHash, readReviewRecord, publishReviewRecord } from './review.mjs';
import { validateLearningDecision } from './learning-record.mjs';
import { experimentProof } from './experiment-authority.mjs';
import { withGitObservationCache } from './git-observation-cache.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileNoFollow } from './fs-safe.mjs';
import { inspectHostIntent } from './host-intent.mjs';

export function openHardGaps(plan, policy) {
  return (plan.fm.capability_gaps || []).filter(gap => {
    if (!gap || typeof gap !== 'object' || gap.class !== 'hard' || gap.fulfillment === 'done') return false;
    if (!['bridge', 'waived'].includes(gap.fulfillment)) return true;
    return !policy.waivers.some(waiver => waiver && typeof waiver === 'object' && waiver.plan === plan.path && waiver.gap === gap.id && waiver.action === gap.fulfillment && typeof waiver.reason === 'string' && waiver.reason.trim());
  });
}

function requireReconciledIntent(workspace, plan) {
  let message;
  try {
    const current = readFileNoFollow(plan.fullPath || path.resolve(workspace, plan.path), { maxBytes: 1024 * 1024 });
    const observation = inspectHostIntent({ workspace, planPath: plan.fullPath || plan.path,
      revision: current === null ? undefined : createHash('sha256').update(current).digest('hex') });
    if (observation.state === 'pending') message = 'Observed intent must be reconciled by a current plan decision before completion';
  } catch (error) {
    message = `Host intent cannot be established: ${error.message}`;
  }
  if (message) throw Object.assign(new Error(`Completion blocked: ${message}`), { code: 'E_TARGET', exit: 1 });
}

export function proofPrerequisites({ workspace, plan, copilotHome }) {
  const recordRoot = planRecordRoot(workspace, plan);
  const domain = domainPrerequisites({ workspace, plan, copilotHome, home: planHome(workspace, plan) });
  if (!domain.pass) return domain;
  const experiment = experimentProof({ workspace, plan, copilotHome, home: planHome(workspace, plan) });
  if (!experiment.pass) return experiment;
  const policy = loadPolicy(workspace, null, { copilotHome, home: planTrustHome(workspace, plan) });
  const evidence = readEvidence(recordRoot, plan.path);
  const proof = validateEvidence({ workspace, plan, evidence, maxAgeHours: policy.evidenceTtlHours, copilotHome });
  if (!proof.pass) return { pass: false, message: proof.message };
  const review = validateReview({ workspace, plan, copilotHome });
  if (!review.pass) return { pass: false, message: review.message };
  if ((evidence.checks?.find(check => check.id === 'required-reviews')?.record || null) !== (review.record?.id || null)) return { pass: false, message: 'Collected review changed after verification; reverify against the current review record' };
  const critical = [...(plan.fm.reviews?.critical_open || []), ...review.critical];
  if (critical.length) return { pass: false, message: 'Unresolved critical findings block completion' };
  if (openHardGaps(plan, policy).length) return { pass: false, message: 'Open hard gaps or unapproved waivers block completion' };
  const verificationIdentity = recordHash({ version: evidence.version, plan: evidence.plan, binding: evidence.binding, outcome: evidence.outcome, checks: evidence.checks.map(c => ({ id: c.id, status: c.status, proof: c.proof || null })), review: review.record?.id || null });
  const value = { version: 1, plan: plan.path, binding: evidence.binding, verificationIdentity, evidencePath: evidence.evidencePath, review: review.record?.id || null };
  return { pass: true, value, id: recordHash(value), message: 'Current work has passed proof and complete required review coverage' };
}

export function completionPrerequisites(options) {
  const proof = proofPrerequisites(options);
  if (!proof.pass) return proof;
  const openTasks = [...(options.plan.sections.plan || '').matchAll(/^-\s*\[ \]\s+(.+)$/gm)];
  if (openTasks.length) return { pass: false, message: `${openTasks.length} plan tasks remain open across the full plan; record accepted progress before completion` };
  const learning = validateLearningDecision(planRecordRoot(options.workspace, options.plan), proof.value, { workspace: options.workspace, plan: options.plan, copilotHome: options.copilotHome, home: planHome(options.workspace, options.plan) });
  if (!learning.pass) return learning;
  const value = { ...proof.value, version: 2, learning: learning.reference };
  return { pass: true, value, id: recordHash(value), message: 'Current proof, review and completed learning decision are bound' };
}

const completionRel = plan => `.harness/completions/${recordHash(plan.path)}.json`;

export function completeWork({ workspace, plan, copilotHome, dryRun = false }) {
  requireReconciledIntent(workspace, plan);
  const recordRoot = planRecordRoot(workspace, plan);
  const checked = completionPrerequisites({ workspace, plan, copilotHome });
  if (!checked.pass) throw Object.assign(new Error(`Completion blocked: ${checked.message}`), { code: 'E_TARGET', exit: 1 });
  const rel = completionRel(plan);
  const existing = readReviewRecord(recordRoot, rel);
  if (existing?.id === checked.id && recordHash(existing.value) === checked.id) return existing;
  const record = { version: 2, id: checked.id, value: checked.value, completedAt: new Date().toISOString(), path: rel };
  if (!dryRun) {
    const fresh = completionPrerequisites({ workspace, plan, copilotHome });
    if (!fresh.pass || fresh.id !== record.id) throw new Error('Work changed before completion publication');
    requireReconciledIntent(workspace, plan);
    publishReviewRecord(recordRoot, rel, record);
  }
  return record;
}

export function validateCompletion(options) {
  return withGitObservationCache(() => validateCompletionRecord(options));
}

function validateCompletionRecord({ workspace, plan, copilotHome }) {
  const recordRoot = planRecordRoot(workspace, plan);
  const checked = completionPrerequisites({ workspace, plan, copilotHome });
  if (!checked.pass) return checked;
  const record = readReviewRecord(recordRoot, completionRel(plan));
  if (!record || record.version !== 2 || record.id !== checked.id || recordHash(record.value) !== record.id) return { pass: false, message: 'No current bound completion record; pipe a complete decision to ae plan-update --file - after review and verify' };
  if (plan.status !== 'done') return { pass: false, message: 'Completion transaction is pending; retry the same complete decision on ae plan-update --file -' };
  return { pass: true, record: record.id, message: 'Current bound completion record validated' };
}
