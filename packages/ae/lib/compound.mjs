import { spawnGitSync } from '../corpus/hooks/lib/git-executable.mjs';
import { flowMaintenance } from './flow-model.mjs';
import { gitMetadataEnvironment } from '../corpus/hooks/lib/product-diff.mjs';
import { planRecordRoot, planHome, planTrustHome, validateDomainContext } from './domain-context.mjs';
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { runIndexKnowledge, withKnowledgeIndexLock } from './index-knowledge.mjs';
import { resolveIndexDir } from './recall-config.mjs';
import { readSession, writeSession } from './session.mjs';
import { readEvidence, validateEvidence } from './evidence.mjs';
import { selectPlan } from './plan-parse.mjs';
import { loadPolicy } from './policy.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { recordSkillUsage } from './telemetry.mjs';
import { scanSecrets } from './secret-scan.mjs';
import { readStoreConfig } from './knowledge/store.mjs';
import { deriveGitContext } from './git-context.mjs';
import { assertNoSymlinkAncestors, writeFileContainedExclusive, readFileNoFollow, readBoundedInput } from './fs-safe.mjs';
import { withPlanUpdateLock } from './plan-update.mjs';
import { proofPrerequisites } from './completion.mjs';
import { recordHash, readReviewRecord, publishReviewRecord } from './review.mjs';
import { learningPointerRel, publicationTarget, learningPublicationCurrent } from './learning-record.mjs';
import { validateFeedbackFields, publishFeedbackRecord, acceptedFeedbackRecord } from './learning-feedback.mjs';
import { capabilityOptions, capabilityContext, adaptationContext, loadedResourceUses } from './adaptive-context.mjs';
import { retainVerifiedPublication } from './resource-recurrence.mjs';
import { discoveryPolicy } from './capability-catalog.mjs';
import { decisionPolicyFromDiscovery, inspectMemoryDecision } from './decision-agent.mjs';
import { FAILURE_CLUSTER_REF } from './learning-recheck.mjs';

import { buildStructuralIndex } from './repo-map/structural-index.mjs';
import { createTreesitterExtract } from './repo-map/treesitter-extractor.mjs';

function snapshotFile(p) {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}
function restoreFile(p, snap) {
  try {
    if (snap === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, snap);
  } catch {
    // best effort — `ae index` reconciles retrieval state on the next run
  }
}

function snapshotRestored(p, snap) {
  try {
    if (snap === null) return !fs.existsSync(p);
    return fs.readFileSync(p).equals(snap);
  } catch {
    return false;
  }
}

function reserveEpisodePath(baseRoot, dirRel, base, doc, { replay = false, authorize } = {}) {
  const dirFull = assertNoSymlinkAncestors(baseRoot, dirRel);
  if (!dirFull) return { ok: false };
  fs.mkdirSync(dirFull, { recursive: true });
  let candidate = `${base}.md`;
  let n = 2;
  for (let attempt = 0; attempt < 100000; attempt++) {
    const rel = path.join(dirRel, candidate);
    const full = assertNoSymlinkAncestors(baseRoot, rel);
    if (!full) return { ok: false };
    if (fs.existsSync(full)) {
      if (replay) return readFileNoFollow(full, { root: baseRoot }) === doc ? { ok: true, rel, replayed: true } : { ok: false, error: new Error('Learning operation conflicts with existing episode bytes') };
      candidate = `${base}-${n}.md`;
      n += 1;
      continue;
    }
    // Judge the final collision-selected path and exact serialized bytes. A
    // consumed verdict cannot be reused if an external writer wins this path.
    const authority = authorize?.(rel);
    if (authority && !authority.authorized) return { ok: false, ...authority };
    if (writeFileContainedExclusive(baseRoot, rel, doc)) return { ok: true, rel, ...(authority?.receiptId ? { memoryDecisionReceipt: authority.receiptId } : {}) };
    if (authority?.required) return { ok: false, ...authority, authorized: false, reason: 'Memory publication lost its exclusive destination; prepare a new exact memory decision before retrying' };
    if (fs.existsSync(full)) {
      candidate = `${base}-${n}.md`;
      n += 1;
      continue;
    }
    return { ok: false, error: new Error('Atomic episode publication failed before the final file was published') };
  }
  return { ok: false };
}

function memoryPublicationAuthority({ workspace, copilotHome, home, kind, scope, recordRoot, memory, consume = false }) {
  // Human teaching is a separate explicit-authority lane. Automatic inferred
  // knowledge may use only the project-private destination chosen by the
  // harness; memory:true does not grant global/corpus publication authority.
  if (kind === 'human-teaching') return null;
  const options = capabilityOptions({ workspace, copilotHome, home });
  const consent = discoveryPolicy(options);
  if (!consent.configured) return null;
  const base = { required: true, memoryDecision: memory };
  if (!consent.policy.grants.memory) return { ...base, authorized: false, reason: 'Standing memory authority does not permit inferred publication' };
  if (scope !== 'private') return { ...base, authorized: false, reason: 'Standing memory authority covers private project learning; shared or corpus publication requires explicit authority' };
  if (!consent.policy.grants.decision) return { ...base, authorized: false, reason: 'Memory publication requires the native decision agent under standing decision authority' };
  if (!consume) return { ...base, authorized: true };
  const sessionId = readSession(recordRoot || workspace)?.sessionId;
  if (!sessionId) return { ...base, authorized: false, reason: 'Memory decision requires a current native task session' };
  return { ...base, ...inspectMemoryDecision({ ...options, policy: decisionPolicyFromDiscovery(consent), sessionId, memory, consume: true }) };
}

function slugify(text) {
  return (
    String(text)
      .toLowerCase()
      .normalize('NFC')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'insight'
  );
}

function yamlQuote(value) {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

/**
 * Insight lane: evidence-free capture of investigation learnings. The quality
 * gate on the verified lane is untouched — insights are a separate episode
 * kind, ranked below verified fixes and barred from promotion.
 */
export function runInsightCompound({ workspace, copilotHome, flags, log = () => {}, kind = 'insight', home, domainContext = null, authorizedPlan = null }) {
  let verifiedProof = null;
  let publicationPlan = authorizedPlan;
  if (kind === 'fix') {
    const selected = authorizedPlan ? { plan: authorizedPlan } : selectPlan(workspace, { planPath: flags.plan, home, domainContext, requireUnique: true });
    if (!selected.plan) return { pass: false, exitCode: 2, kind, path: null, blockedReason: 'Verified fix requires a selected plan' };
    const checked = proofPrerequisites({ workspace, plan: selected.plan, copilotHome });
    if (!checked.pass) return { pass: false, exitCode: 2, kind, path: null, blockedReason: checked.message };
    verifiedProof = checked.value;
    publicationPlan = selected.plan;
  }
  // Kill switch: only the fully-off mode blocks insight capture — freeze and
  // capture-only both keep this lane open (the mode matrix, Task 4).
  const { mode } = readStoreConfig(workspace, { home });
  if (mode === 'off') {
    return {
      pass: false,
      exitCode: 2,
      kind,
      path: null,
      indexed: null,
      blockedReason: `knowledge mode is ${mode} — run: ae knowledge on`,
      nextTools: ['ae knowledge on'],
    };
  }
  // The one-liner form is the contract the approved TUI mock shows in its own
  // composer example: `compound --insight "windows taskkill needs its own
  // probe"`. When the insight text is all there is, it IS the title and the
  // body — demanding both separately for a one-sentence observation turned a
  // capture affordance into a form.
  const insightText = typeof flags.insight === 'string' ? flags.insight.trim() : '';
  const title = flags.title || (insightText.length > 3 ? insightText.slice(0, 96) : '');
  const body = flags.body
    || (flags.bodyFile ? fs.readFileSync(path.resolve(flags.bodyFile), 'utf8') : '')
    || (flags.title ? '' : insightText);
  if (!title || !body.trim()) {
    return {
      pass: false,
      exitCode: 2,
      kind,
      path: null,
      indexed: null,
      blockedReason: 'insight capture needs --title and --body (or --body-file)',
      nextTools: ['ae compound --insight --title "..." --body "..."'],
    };
  }
  // A failure-cluster reference (plan Phase 2b) keeps a failure-derived learning
  // traceable to its evidence. Only the format is checked: the ID is a digest of
  // the cluster key that `consolidate --candidates --recheck` recomputes, and
  // evidence history may be pruned or live in another checkout by the time the
  // insight is written.
  if (flags.derivedFrom != null && (kind !== 'insight' || !FAILURE_CLUSTER_REF.test(flags.derivedFrom))) {
    return { pass: false, exitCode: 2, kind, path: null, indexed: null,
      blockedReason: kind !== 'insight' ? '--derived-from is accepted only on an insight'
        : /^finding-cluster:/.test(flags.derivedFrom) ? 'finding clusters are informational and cannot be answered: --derived-from must be failure-cluster:<id> as listed by ae consolidate --candidates --recheck'
          : '--derived-from must be failure-cluster:<id> as listed by ae consolidate --candidates --recheck',
      nextTools: ['ae consolidate --candidates --recheck --json'] };
  }
  const date = flags.captureDate || new Date().toISOString().slice(0, 10);
  // Category is one safe path segment — never a traversal vector.
  const category = slugify(flags.category || 'insights');
  const tags = flags.tags
    ? flags.tags
        .split(',')
        .map((t) => t.replace(/[^\w. -]/g, '').trim())
        .filter(Boolean)
        .join(',')
    : '';
  const fmLines = [`title: ${yamlQuote(title)}`, `kind: ${kind}`, `date: ${date}`];
  if (verifiedProof) fmLines.push(`verification: ${yamlQuote(verifiedProof.evidencePath)}`, `work_contract: ${verifiedProof.binding.planDigest}`, `proof_identity: ${verifiedProof.verificationIdentity}`);
  const resourceUses = verifiedProof ? loadedResourceUses({ workspace, copilotHome, home, plan: publicationPlan }) : [];
  if (resourceUses.length) fmLines.push(`resource_uses: ${JSON.stringify(resourceUses)}`);
  if (tags) fmLines.push(`tags: ${tags}`);
  if (flags.trigger) fmLines.push(`trigger: ${yamlQuote(flags.trigger)}`);
  if (flags.claim) fmLines.push(`claim: ${yamlQuote(flags.claim)}`);
  if (flags.derivedFrom != null) fmLines.push(`derived_from: ${flags.derivedFrom}`);
  // Git provenance (blueprint P1/P9): optional commit/branch/base stamped at
  // capture time from the CURRENT workspace HEAD. This is the sole CLI
  // episode writer — `compound --insight` (kind: insight) and
  // `ae remember` (kind: human-teaching) both land here — so every
  // CLI-captured episode carries provenance; skill-authored fix episodes stay
  // reader-tolerant (absent fields are fine everywhere). Shas are stamped
  // bare; the branch name is attacker-influenced text on fork checkouts, so
  // it rides through yamlQuote like every other quoted field here.
  const gitContext = deriveGitContext({ workspace, home });
  if (gitContext.headSha) fmLines.push(`commit: ${gitContext.headSha}`);
  if (gitContext.branch) fmLines.push(`branch: ${yamlQuote(gitContext.branch)}`);
  if (gitContext.baseSha) fmLines.push(`base: ${gitContext.baseSha}`);
  const doc = `---\n${fmLines.join('\n')}\n---\n\n${body.trim()}\n`;
  const secrets = scanSecrets(doc);
  if (secrets.length) {
    return {
      pass: false,
      exitCode: 1,
      kind,
      path: null,
      indexed: null,
      blockedReason: `secret-shaped content blocked capture: ${secrets
        .map((s) => `${s.id}@${s.line}`)
        .join(', ')}`,
      nextTools: ['redact the credential and re-run'],
    };
  }
  // Never silently overwrite an earlier capture: same-day same-title collisions
  // get a deterministic numeric suffix.
  const base = `${date}-${slugify(title)}${flags.operationSuffix ? `-${flags.operationSuffix}` : ''}`;
  const scope = flags.publicationScope || 'private';
  const target = publicationTarget({ workspace, copilotHome, home, scope, plan: publicationPlan });
  const dirRel = path.join(target.dirRel, category);
  // Physical containment: a symlinked docs/solutions (or category) directory
  // must never let the write land outside the chosen base (workspace or the
  // user-level project store).
  if (!assertNoSymlinkAncestors(target.base, dirRel)) {
    return {
      pass: false,
      exitCode: 1,
      kind,
      path: null,
      indexed: null,
      blockedReason: 'episode path escapes the workspace (symlinked docs/solutions?)',
      nextTools: ['remove or replace the symlinked docs/solutions directory and re-run'],
    };
  }
  const privateParent = publicationPlan?.fm?.domain_parent && scope === 'private' ? publicationPlan : null;
  const memoryFor = rel => ({ operation: 'publish', kind, scope, destination: path.resolve(target.base, rel), contentDigest: `sha256-${createHash('sha256').update(doc).digest('hex')}`, proofIdentity: verifiedProof?.verificationIdentity || null });
  const authorizeMemory = (rel, consume) => memoryPublicationAuthority({ workspace, copilotHome, home, kind, scope, recordRoot: privateParent ? planRecordRoot(workspace, privateParent) : workspace, memory: memoryFor(rel), consume });
  const knowledgeRoot = privateParent ? path.join(planRecordRoot(workspace, privateParent), '.harness/knowledge') : copilotHome ? path.join(copilotHome, 'knowledge') : null;
  return withKnowledgeIndexLock({ knowledgeRoot, workspace, copilotHome, flags, log, home, plan: privateParent }, rebuild => {
    let rel;
    let replayed = false;
    let memoryAuthority;
    const memoryBlocked = authority => ({ pass: false, exitCode: 2, kind, path: null, indexed: null,
      blockedReason: `Memory decision required: ${authority.reason}`, memoryDecision: authority.memoryDecision, memoryContent: doc,
      nextTools: ['Prepare a memory decision packet with memoryDecision, invoke native decision-agent, and record its observed verdict before retrying'] });
    // Consent is also checked on an idempotent replay. Existing exact bytes do
    // not consume a second verdict, but revocation remains immediately binding.
    const currentAuthority = authorizeMemory(path.join(dirRel, `${base}.md`), false);
    if (currentAuthority && !currentAuthority.authorized) return memoryBlocked(currentAuthority);
    if (flags.dryRun) {
      // Dry run writes nothing, so a plain existence probe is enough to report a
      // representative would-be name (no reservation, no file created).
      rel = path.join(dirRel, `${base}.md`);
      let n = 2;
      while (fs.existsSync(path.join(target.base, rel))) {
        if (flags.operationSuffix && readFileNoFollow(path.join(target.base, rel), { root: target.base }) === doc) break;
        rel = path.join(dirRel, `${base}-${n}.md`);
        n += 1;
      }
      memoryAuthority = authorizeMemory(rel, false);
    } else {
      const reserved = reserveEpisodePath(target.base, dirRel, base, doc, { replay: Boolean(flags.operationSuffix), authorize: candidate => authorizeMemory(candidate, true) });
      if (!reserved.ok) {
        if (reserved.memoryDecision) return memoryBlocked(reserved);
        return {
          pass: false,
          exitCode: 1,
          kind,
          path: null,
          indexed: null,
          blockedReason: reserved.error
            ? `could not write episode file: ${reserved.error.message}`
            : 'episode path escapes the workspace (symlinked docs/solutions?)',
          nextTools: ['remove or replace the symlinked docs/solutions directory and re-run'],
        };
      }
      rel = reserved.rel;
      replayed = Boolean(reserved.replayed);
      memoryAuthority = reserved;
    }
    // Under dryRun nothing was actually written (the write above is skipped), so
    // the log line must not claim otherwise.
    log(`${flags.dryRun ? 'would write' : 'wrote'} ${rel}`);
    const publication = { publicationVersion: 1, scope, publishedPath: path.resolve(target.base, rel), publishedHash: recordHash(doc),
      ...(currentAuthority ? { memoryDecision: memoryFor(rel), ...(flags.dryRun ? { memoryContent: doc } : {}) } : {}), ...(memoryAuthority?.memoryDecisionReceipt ? { memoryDecisionReceipt: memoryAuthority.memoryDecisionReceipt } : {}) };
    if (scope === 'ship-set-proposal') return { pass: true, exitCode: 0, kind, path: rel.split(path.sep).join('/'), ...publication, indexed: null, proposal: true, activated: false, blockedReason: null, nextTools: ['Review the proposal before requesting a shipped-corpus change'] };
    // runIndexKnowledge can throw (a duplicate manifest id, an fs error). An
    // unhandled throw here would leave the episode we JUST wrote orphaned on disk
    // and, for the `remember` caller, skip its rollback path entirely (the throw
    // never reaches `if (!episode.pass)`). Snapshot the ENTIRE retrieval state it
    // writes — the manifest AND the postings (index-knowledge writes manifest
    // then postings.json/meta.json, so a throw between them can leave postings
    // referencing the rolled-back episode) — and on any index failure delete the
    // just-written episode and restore all of it so retrieval state is exactly
    // pre-write, then return a clean, recoverable failure the caller handles.
    const manifestPath = path.join(knowledgeRoot || path.join(workspace, 'knowledge'), 'manifest.yaml');
    const indexDir = privateParent ? path.join(planRecordRoot(workspace, privateParent), '.harness/knowledge-index') : resolveIndexDir(copilotHome || '', workspace, home);
    const snapshots = [
      [manifestPath, snapshotFile(manifestPath)],
      [path.join(indexDir, 'postings.json'), snapshotFile(path.join(indexDir, 'postings.json'))],
      [path.join(indexDir, 'meta.json'), snapshotFile(path.join(indexDir, 'meta.json'))],
      [path.join(indexDir, 'manifest.json'), snapshotFile(path.join(indexDir, 'manifest.json'))],
    ];
    let indexed;
    try {
      indexed = rebuild();
    } catch (err) {
      // Rollback WITH verified postconditions (P2): the prior code swallowed
      // every recovery error yet always reported "episode rolled back" /
      // `path: null` — so a rollback that left the episode on disk or failed to
      // restore retrieval state was indistinguishable from a clean one. Now each
      // step is verified against disk and any residue is named in the result.
      const episodeFull = path.join(target.base, rel);
      let episodeRemains = false;
      const unrestored = [];
      if (!flags.dryRun) {
        try {
          if (!replayed) fs.rmSync(episodeFull, { force: true });
        } catch {
          // best effort — verified below regardless of whether rmSync threw
        }
        episodeRemains = fs.existsSync(episodeFull);
        // Restore manifest + postings + meta to exactly pre-write (write back the
        // snapshot, or delete if it was absent), then confirm each landed.
        for (const [p, snap] of snapshots) {
          restoreFile(p, snap);
          if (!snapshotRestored(p, snap)) unrestored.push(p);
        }
      }
      const recovered = !episodeRemains && unrestored.length === 0;
      let blockedReason;
      if (recovered) {
        blockedReason = `knowledge index rebuild failed, episode rolled back: ${err.message}`;
      } else {
        const residue = [];
        if (episodeRemains) residue.push(`episode still on disk at ${rel.split(path.sep).join('/')}`);
        if (unrestored.length) residue.push(`retrieval state not restored: ${unrestored.join(', ')}`);
        blockedReason = `knowledge index rebuild failed AND rollback incomplete (${residue.join('; ')}) — run: ae index. Original error: ${err.message}`;
      }
      return {
        pass: false,
        exitCode: 1,
        kind,
        path: null,
        indexed: null,
        blockedReason,
        // Name the residue explicitly so a caller never treats a partial
        // recovery as a clean one.
        ...(recovered ? {} : { partialRecovery: { episodeRemains, unrestored } }),
        nextTools: ['ae index'],
      };
    }
    return {
      pass: true,
      exitCode: 0,
      kind,
      path: rel.split(path.sep).join('/'),
      ...publication,
      indexed,
      resourceUses,
      blockedReason: null,
      nextTools: ['ae consolidate --status'],
    };
  });
}

async function runLearningDecision({ workspace, copilotHome, flags, log, domainContext = null }) {
  if (flags.insight) throw new Error('A verified learning decision cannot be combined with --insight');
  const text = flags.learningDecision === '-' ? readBoundedInput() : readFileNoFollow(path.resolve(workspace, flags.learningDecision), { maxBytes: 1024 * 1024 });
  if (!text || Buffer.byteLength(text) > 1024 * 1024) throw new Error('Learning decision is missing, unreadable, or too large');
  const decision = JSON.parse(text);
  if (!decision || typeof decision !== 'object' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(decision.operation || '') || !['no-learning', 'publish'].includes(decision.decision)
    || typeof decision.rationale !== 'string' || !decision.rationale.trim() || (decision.scope && !['private', 'global', 'ship-set-proposal'].includes(decision.scope)) || Object.keys(decision).some(key => !['operation', 'decision', 'rationale', 'scope', 'title', 'body', 'category', 'tags', 'trigger', 'claim', 'recalled', 'findings'].includes(key))) throw new Error('Learning decision requires operation, decision, rationale, and a supported publication scope');
  if (decision.decision === 'publish' && (typeof decision.title !== 'string' || !decision.title.trim() || typeof decision.body !== 'string' || !decision.body.trim() || decision.tags !== undefined && (!Array.isArray(decision.tags) || !decision.tags.every(tag => typeof tag === 'string')))) throw new Error('Publication requires authored title, body and optional text tags');
  const selected = selectPlan(workspace, { planPath: flags.plan, session: readSession(workspace), requireUnique: true, home: flags.harnessHome, domainContext });
  if (!selected.plan) throw new Error('Learning decision requires an unambiguous plan');
  const recordRoot = planRecordRoot(workspace, selected.plan);
  const home = planHome(workspace, selected.plan, flags.harnessHome || process.env.HARNESS_HOME);
  // Exposure is mutable bookkeeping: only new work is judged against it. An
  // exact replay of a completed operation reuses the feedback it accepted.
  let feedback = null, feedbackError = null;
  try { feedback = validateFeedbackFields(decision, { recordRoot, planPath: selected.plan.path }); } catch (error) { feedbackError = error; }
  if (feedbackError && readReviewRecord(recordRoot, `.harness/learning/${recordHash(decision.operation)}.json`)?.state !== 'done') throw feedbackError;
  const recordFeedback = record => {
    if (!feedback && !feedbackError) return {};
    try {
      if (feedbackError) {
        const accepted = acceptedFeedbackRecord({ workspace, home, operation: record.operation, digest: record.digest, planPath: selected.plan.path, feedback: decision });
        return { feedbackRecord: accepted ? { path: accepted, written: false } : { written: false, reason: feedbackError.message } };
      }
      return { feedbackRecord: publishFeedbackRecord({ workspace, home, operation: record.operation, digest: record.digest, planPath: selected.plan.path, captureDate: record.captureDate, feedback }) };
    } catch (error) {
      return { feedbackRecord: { written: false, reason: error.message } };
    }
  };
  const checked = proofPrerequisites({ workspace, plan: selected.plan, copilotHome });
  if (!checked.pass) return { pass: false, exitCode: 2, blockedReason: checked.message, plan: selected.plan.path, path: null };
  const operation = recordHash(decision.operation);
  const target = decision.decision === 'publish' ? publicationTarget({ workspace, copilotHome, home, plan: selected.plan, scope: decision.scope || 'private' }) : null;
  const destination = target ? { base: path.resolve(target.base), dirRel: target.dirRel.replace(/\\/g, '/') } : null;
  const digest = recordHash({ decision, proof: checked.value.verificationIdentity, ...(destination ? { destination } : {}) });
  const compatible = record => {
    if (!record) return;
    if (record.destination && JSON.stringify(record.destination) !== JSON.stringify(destination)) throw new Error('Learning operation destination conflicts with the accepted destination');
    if (!record.destination && record.result?.publishedPath && (!destination || record.result.publishedPath !== path.resolve(destination.base, record.result.path))) throw new Error('Learning operation destination conflicts with the accepted destination');
    const legacy = !record.destination && record.digest === recordHash({ decision, proof: checked.value.verificationIdentity });
    if (record.digest !== digest && !legacy) throw new Error('Learning operation identity conflicts with a different decision, destination or proof');
  };
  const rel = `.harness/learning/${operation}.json`;
  const existing = readReviewRecord(recordRoot, rel);
  compatible(existing);
  const publish = captureDate => runInsightCompound({ workspace, copilotHome, flags: { ...flags, plan: selected.plan.path, title: decision.title, body: decision.body, category: decision.category, tags: Array.isArray(decision.tags) ? decision.tags.join(',') : '', trigger: decision.trigger, claim: decision.claim, captureDate, operationSuffix: operation.slice(0, 16), publicationScope: decision.scope || 'private' }, log, kind: 'fix', home, domainContext, authorizedPlan: selected.plan });
  if (flags.dryRun) return decision.decision === 'publish' ? { ...publish(existing?.captureDate), dryRun: true } : { pass: true, exitCode: 0, dryRun: true, decision: decision.decision, path: null, indexed: null };
  publishReviewRecord(recordRoot, '.harness/learning/.ready.json', { version: 1 });
  const pointer = learningPointerRel(selected.plan.path);
  return withPlanUpdateLock(path.join(recordRoot, pointer), () => withPlanUpdateLock(path.join(recordRoot, rel), () => {
    const prior = readReviewRecord(recordRoot, rel);
    compatible(prior);
    const priorPublicationCurrent = !prior || learningPublicationCurrent(recordRoot, prior, { workspace, copilotHome, home, plan: selected.plan });
    if (prior?.state === 'done' && priorPublicationCurrent) {
      if (decision.decision === 'publish') {
        const memory = prior.result.memoryDecision || null;
        const authority = memoryPublicationAuthority({ workspace, copilotHome, home, kind: 'fix', scope: decision.scope || 'private', recordRoot, memory });
        if (authority && !authority.authorized) return { pass: false, exitCode: 2, kind: 'fix', path: null, indexed: null,
          blockedReason: `Memory decision required: ${authority.reason}`, memoryDecision: memory, learningRecord: rel };
      }
      publishReviewRecord(recordRoot, pointer, { version: 1, operation, record: rel });
      return { ...prior.result, learningRecord: rel, replayed: true, ...recordFeedback(prior) };
    }
    if (feedbackError) throw feedbackError;
    const pending = prior ? { ...prior, digest, ...(destination ? { destination } : {}) } : { version: 1, operation, digest, decision, ...(destination ? { destination } : {}), proof: checked.value, captureDate: new Date().toISOString().slice(0, 10), state: 'pending' };
    const fresh = proofPrerequisites({ workspace, plan: selected.plan, copilotHome });
    if (!fresh.pass || fresh.id !== checked.id) throw new Error('Work changed before learning publication');
    publishReviewRecord(recordRoot, pointer, { version: 1, operation, record: rel });
    publishReviewRecord(recordRoot, rel, pending);
    const result = decision.decision === 'no-learning'
      ? { pass: true, exitCode: 0, decision: 'no-learning', path: null, indexed: null, plan: selected.plan.path, verificationEvidence: checked.value.evidencePath }
      : publish(pending.captureDate);
    const completed = { ...pending, state: result.pass ? 'done' : result.partialRecovery ? 'blocked' : 'pending', result };
    publishReviewRecord(recordRoot, rel, completed);
    let retainedEvidence;
    if (result.pass && !selected.plan.fm.domain_parent && decision.decision === 'publish' && (!decision.scope || decision.scope === 'private')
      && capabilityContext({ workspace, copilotHome, home, limit: 1 })) {
      try {
        retainedEvidence = retainVerifiedPublication({ workspace: recordRoot, home, record: completed });
        if (!retainedEvidence.retained) throw new Error('Verified learning proof could not be retained outside the worktree');
      } catch (error) {
        const failure = { ...result, pass: false, exitCode: 2, blockedReason: `Learning evidence retention failed: ${error.message}` };
        publishReviewRecord(recordRoot, rel, { ...completed, state: 'blocked', result: failure });
        return { ...failure, learningRecord: rel };
      }
    }
    return { ...result, learningRecord: rel, ...(retainedEvidence ? { retainedEvidence } : {}), ...(result.pass ? recordFeedback(completed) : {}) };
  }));
}

async function runCompoundCore({ workspace, copilotHome, flags, log = () => {}, domainContext = null }) {
  if (flags.learningDecision) {
    const result = await runLearningDecision({ workspace, copilotHome, flags, log, domainContext });
    if (result.pass) {
      try {
        const home = flags.harnessHome || flags.home;
        if (capabilityContext({ workspace, copilotHome, home, limit: 1 })) result.adaptation = adaptationContext({ workspace, copilotHome, home });
      } catch (error) { result.adaptation = { candidates: [], assessment: 'Recurrence assessment unavailable', reason: error.message }; }
    }
    return result;
  }
  if (domainContext && flags.insight) throw new Error('Domain learning requires a selected verified parent and an authored learning decision');
  if (flags.insight) return runInsightCompound({ workspace, copilotHome, flags, log, home: flags.harnessHome || flags.home });
  const session = readSession(domainContext ? validateDomainContext(domainContext, workspace).root : workspace);
  const selected = selectPlan(workspace, { planPath: flags.plan, session, requireUnique: true, home: flags.harnessHome, domainContext });
  if (!selected.plan) {
    return {
      pass: false,
      exitCode: 2,
      plan: null,
      verificationEvidence: null,
      indexed: null,
      blockedReason: selected.error || 'No unambiguous plan; pass --plan explicitly',
      nextTools: ['ae verify --plan <path>', '/auto-compound'],
    };
  }

  const evidence = readEvidence(planRecordRoot(workspace, selected.plan), selected.plan.path);
  const freshness = validateEvidence({
    workspace,
    plan: selected.plan,
    evidence,
    maxAgeHours: loadPolicy(workspace, flags.enforcement, { copilotHome: resolveCopilotHome(flags.copilotHome), home: planTrustHome(workspace, selected.plan) }).evidenceTtlHours,
    copilotHome,
  });
  if (!freshness.pass) {
    return {
      pass: false,
      exitCode: evidence?.outcome === 'failed' ? 1 : 2,
      plan: selected.plan.path,
      verificationEvidence: evidence,
      indexed: null,
      blockedReason: freshness.message,
      nextTools: [`ae verify --plan ${selected.plan.path}`, '/auto-compound'],
    };
  }

  const knowledgeRoot = selected.plan.fm.domain_parent ? path.join(planRecordRoot(workspace, selected.plan), '.harness/knowledge') : copilotHome ? path.join(copilotHome, 'knowledge') : null;

  const indexed = runIndexKnowledge({
    knowledgeRoot,
    workspace,
    copilotHome,
    flags,
    log,
    home: planHome(workspace, selected.plan, flags.harnessHome || flags.home),
    plan: selected.plan,
  });

  let codeIndex = null;
  if (!flags.dryRun) {
    try {
      const extractor = await createTreesitterExtract();
      codeIndex = await buildStructuralIndex({
        workspace,
        home: flags?.home || process.env.HARNESS_HOME,
        extractor,
        log,
      });
      if (!codeIndex.written) log('code index was not published');
    } catch (error) {
      codeIndex = { written: false, error: error.message };
      log(`code index refresh failed: ${error.message}`);
    }
  }

  const head = spawnGitSync(['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 4000, env: gitMetadataEnvironment() });
  if (!flags.dryRun && head.status === 0 && codeIndex && !codeIndex.written) {
    return {
      pass: false,
      exitCode: 1,
      plan: selected.plan.path,
      verificationEvidence: evidence,
      indexed,
      codeIndex,
      blockedReason: codeIndex.error || 'code index was not published',
      nextTools: ['ae index --structural'],
    };
  }

  const telemetry = recordSkillUsage({
    copilotHome,
    plan: selected.plan,
    evidence,
    dryRun: flags.dryRun,
  });

  const recordRoot = planRecordRoot(workspace, selected.plan);
  const sessionState = readSession(recordRoot) || {};
  writeSession(
    recordRoot,
    {
      ...sessionState,
      lastCompoundAt: new Date().toISOString(),
      lastIndexEntries: indexed.entries,
    },
    flags.dryRun
  );

  return {
    pass: true,
    exitCode: 0,
    plan: selected.plan.path,
    verificationEvidence: evidence,
    learning: selected.plan.fm.learning || null,
    telemetry,
    indexed,
    codeIndex,
    blockedReason: null,
    nextTools: ['/compound-learnings', '/auto-compound'],
  };
}

// Optional main-generation maintenance is advisory after the existing proof path.
export async function runCompound(options) {
  const result = await runCompoundCore(options);
  const { flags = {}, workspace, domainContext } = options;
  if (result.pass && !flags.insight && !flags.dryRun && !domainContext) {
    try {
      const maintenance = flowMaintenance({ workspace, home: flags.harnessHome || flags.home });
      if (maintenance) return { ...result, flowMaintenance: maintenance };
    } catch { /* Descriptive context cannot overturn verified delivery. */ }
  }
  return result;
}
