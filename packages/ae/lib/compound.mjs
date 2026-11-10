import { spawnGitSync } from '../corpus/hooks/lib/git-executable.mjs';
import { flowMaintenance } from './flow-model.mjs';
import { gitMetadataEnvironment } from '../corpus/hooks/lib/product-diff.mjs';
import { planRecordRoot, planHome, planTrustHome, validateDomainContext } from './domain-context.mjs';
import fs from 'fs';
import path from 'path';
import os from 'node:os';
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
import { evidenceLineError, evidenceFingerprint, evidenceFrontmatterLines, evidencePrefixError, evidenceBytesError, evidenceSummary, matchEvidence, EVIDENCE_OUTPUT_CAP, EVIDENCE_RAW_CAP } from './knowledge/evidence-fingerprint.mjs';
import { EXIT } from './style.mjs';
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
  // A learning decision hands over the fingerprint it already took; the CLI
  // flag hands over the line, which is checked and fingerprinted here.
  const evidenceQuote = flags.evidenceQuote ?? null;
  const quoteError = evidenceQuote === null ? null : evidenceLineError(evidenceQuote);
  if (quoteError) return { pass: false, exitCode: 2, kind, path: null, indexed: null, blockedReason: quoteError, nextTools: ['pass the single failing line of check output in --evidence-quote and re-run'] };
  const evidence = flags.evidenceFingerprint ?? (evidenceQuote === null ? null : evidenceFingerprint(evidenceQuote));
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
  // Only the fingerprint of the evidence line is stored; the line itself is
  // never written or shown (see evidence-fingerprint.mjs).
  if (evidence) fmLines.push(...evidenceFrontmatterLines(evidence));
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
      ...(evidence ? { evidence: evidenceSummary(evidence) } : {}),
      blockedReason: null,
      nextTools: ['ae consolidate --status'],
    };
  });
}

// Under `ae agent` delivery Harness itself stages an inline decision in an
// owned temporary directory (see runDeliveryCommand in agent-delivery.mjs)
// and deletes it when the command ends, so that file is accepted too.
const STAGED_DECISION_PREFIX = 'harness-agent-decision-';
export function harnessStagedDecision(file) {
  if (typeof file !== 'string' || path.basename(file) !== 'decision.json') return false;
  const dir = path.dirname(path.resolve(file));
  return path.basename(dir).startsWith(STAGED_DECISION_PREFIX) && path.dirname(dir) === path.resolve(os.tmpdir());
}

async function runLearningDecision({ workspace, copilotHome, flags, log, domainContext = null }) {
  if (flags.insight) throw new Error('A verified learning decision cannot be combined with --insight');
  const text = flags.learningDecision === '-' ? readBoundedInput() : readFileNoFollow(path.resolve(workspace, flags.learningDecision), { maxBytes: 1024 * 1024 });
  if (!text || Buffer.byteLength(text) > 1024 * 1024) throw new Error('Learning decision is missing, unreadable, or too large');
  let decision;
  try {
    decision = JSON.parse(text);
  } catch (error) {
    // The parser's message can quote the decision text, evidence line
    // included, so only the position is reported.
    const at = String(error?.message || '').match(/position (\d+)/);
    throw new Error(`Learning decision is not valid JSON${at ? ` at position ${at[1]}` : ''}`);
  }
  if (!decision || typeof decision !== 'object' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(decision.operation || '') || !['no-learning', 'publish'].includes(decision.decision)
    || typeof decision.rationale !== 'string' || !decision.rationale.trim() || (decision.scope && !['private', 'global', 'ship-set-proposal'].includes(decision.scope)) || Object.keys(decision).some(key => !['operation', 'decision', 'rationale', 'scope', 'title', 'body', 'category', 'tags', 'trigger', 'claim', 'recalled', 'findings', 'evidence_quote'].includes(key))) throw new Error('Learning decision requires operation, decision, rationale, and a supported publication scope');
  if (decision.decision === 'publish' && (typeof decision.title !== 'string' || !decision.title.trim() || typeof decision.body !== 'string' || !decision.body.trim() || decision.tags !== undefined && (!Array.isArray(decision.tags) || !decision.tags.every(tag => typeof tag === 'string')))) throw new Error('Publication requires authored title, body and optional text tags');
  if (decision.evidence_quote !== undefined) {
    // A decision file would leave the evidence line on disk, so a decision
    // carrying one must arrive on stdin.
    if (flags.learningDecision !== '-' && !harnessStagedDecision(flags.learningDecision)) throw Object.assign(new Error('evidence_quote is accepted only from stdin; pipe the decision to --learning-decision - instead of naming a file, and delete that file'), { code: 'E_USAGE', exit: EXIT.usage, hint: 'ae compound --plan <path> --learning-decision - --json' });
    if (decision.decision !== 'publish') throw new Error('evidence_quote applies only to a publish decision');
    const quoteError = evidenceLineError(decision.evidence_quote);
    if (quoteError) throw new Error(quoteError);
    // The line is replaced by its fingerprint before anything is recorded, so
    // the stored decision, its digest and the episode never hold it.
    const { evidence_quote: line, ...rest } = decision;
    const fingerprint = evidenceFingerprint(line);
    decision = { ...rest, evidence_sha256: fingerprint.sha256, evidence_bytes: fingerprint.bytes };
  }
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
  const publish = captureDate => runInsightCompound({ workspace, copilotHome, flags: { ...flags, plan: selected.plan.path, title: decision.title, body: decision.body, category: decision.category, tags: Array.isArray(decision.tags) ? decision.tags.join(',') : '', trigger: decision.trigger, claim: decision.claim, evidenceQuote: null, evidenceFingerprint: decision.evidence_sha256 ? { sha256: decision.evidence_sha256, bytes: decision.evidence_bytes } : null, captureDate, operationSuffix: operation.slice(0, 16), publicationScope: decision.scope || 'private' }, log, kind: 'fix', home, domainContext, authorizedPlan: selected.plan });
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

/**
 * `ae compound --match-evidence <sha256-prefix> --check-output <path|->`:
 * reports whether any line of check output an agent obtained by re-running
 * the check matches an episode's evidence fingerprint (see matchEvidence).
 * Reads only; the output is never stored or echoed.
 */
// The `ae compound` flags a read-only match refuses, as [flags key, flag name].
const MATCH_EXCLUSIVE_FLAGS = [['learningDecision', '--learning-decision'], ['plan', '--plan'], ['insight', '--insight'], ['title', '--title'], ['body', '--body'], ['bodyFile', '--body-file'],
  ['category', '--category'], ['tags', '--tags'], ['trigger', '--trigger'], ['claim', '--claim'], ['evidenceQuote', '--evidence-quote'], ['enforcement', '--enforcement'], ['dryRun', '--dry-run']];

export function runEvidenceMatch({ workspace, flags }) {
  const usage = (message, hint) => Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
  const hint = 'ae compound --match-evidence <sha256_prefix> --check-output <path|->';
  const other = MATCH_EXCLUSIVE_FLAGS.filter(([key]) => flags[key] != null && flags[key] !== false).map(([, name]) => name);
  if (other.length) throw usage(`--match-evidence only reads check output; it cannot be combined with ${other.join(', ')}`, hint);
  if (flags.matchEvidence == null) throw usage('--check-output and --evidence-bytes are used only with --match-evidence', hint);
  const prefixError = evidencePrefixError(flags.matchEvidence);
  if (prefixError) throw usage(prefixError, hint);
  const bytesError = flags.evidenceBytes == null ? null : evidenceBytesError(flags.evidenceBytes);
  if (bytesError) throw usage(bytesError, hint);
  if (!flags.checkOutput) throw usage('--match-evidence needs --check-output <path|->: the output of the re-run check', hint);
  // A relative path resolves against --workspace, as --learning-decision does.
  const output = flags.checkOutput === '-'
    ? readBoundedInput(0, { maxBytes: EVIDENCE_OUTPUT_CAP })
    : readFileNoFollow(path.resolve(workspace, flags.checkOutput), { maxBytes: EVIDENCE_OUTPUT_CAP });
  // An unreadable input is a usage error (exit 2), never a mismatch (exit 1).
  if (output === null) throw usage(`--check-output is missing, not a regular file, unreadable, or over ${EVIDENCE_OUTPUT_CAP} bytes`, hint);
  const { matched, line } = matchEvidence(output, flags.matchEvidence, { bytes: flags.evidenceBytes == null ? null : Number(flags.evidenceBytes) });
  return {
    pass: matched,
    exitCode: matched ? 0 : 1,
    matched,
    line,
    sha256Prefix: flags.matchEvidence.toLowerCase(),
    blockedReason: matched ? null : 'No line of the check output matches the evidence fingerprint',
    nextTools: matched ? [] : ['confirm the same check was re-run on the code the episode describes, or treat the evidence as unconfirmed'],
  };
}

// The flag names `ae compound` accepts, read from its registry definition.
// Imported on use: the registry imports this module through commands.mjs.
async function compoundFlagNames() {
  const { getCommand, GLOBAL_FLAGS } = await import('./registry.mjs');
  const defs = [...(getCommand('compound')?.args?.flags || []), ...GLOBAL_FLAGS];
  return new Set(['-h', '--help', ...defs.flatMap(def => [def.name, ...(def.aliases || [])])]);
}

async function runCompoundCore({ workspace, copilotHome, flags, log = () => {}, domainContext = null }) {
  if (flags.evidenceQuote != null) {
    const usage = (message, hint) => Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
    // The value is taken literally, so a forgotten value swallows the next flag.
    // Only the space form can swallow a flag; --evidence-quote=--dry-run is a deliberate value.
    // These come before the --insight check: a swallowed --insight is reported as swallowed.
    if (flags.evidenceQuoteForm === 'missing') throw usage('--evidence-quote needs a value', 'pass the quoted text right after --evidence-quote, or use --evidence-quote=<text>');
    // Only a real flag of this command counts: its own or a global flag name or
    // alias, alone or with =value, or -h/--help. Other dash-led text, such as
    // `--- a/x`, `-  removed line`, `-x` or `--max-old-space-size=4096`, is a quote.
    if (flags.evidenceQuoteForm === 'space' && (await compoundFlagNames()).has(flags.evidenceQuote.split('=')[0])) throw usage(`--evidence-quote needs a value but got the flag ${flags.evidenceQuote.split('=')[0]}`, 'pass the quoted text right after --evidence-quote, or use --evidence-quote=<text>');
    // A learning decision carries its own evidence_quote; a flag beside it
    // would otherwise be dropped without a word.
    if (flags.learningDecision) throw usage('--evidence-quote cannot be combined with --learning-decision', 'put evidence_quote in the learning decision file instead');
    if (!flags.insight) throw usage('--evidence-quote is accepted only with --insight', 'put evidence_quote in a learning decision instead');
    if (flags.evidenceQuote === '-') {
      // `-` reads the line from stdin, so it never appears in argv or shell
      // history. One trailing line break (as echo or a pipe adds) is dropped.
      const piped = readBoundedInput(0, { maxBytes: EVIDENCE_RAW_CAP + 2 });
      if (piped === null) throw usage(`--evidence-quote - could not read stdin, or it holds more than ${EVIDENCE_RAW_CAP} bytes`, 'pipe the single failing line into ae compound --insight --evidence-quote -');
      flags = { ...flags, evidenceQuote: piped.replace(/\r?\n$/, '') };
    }
  }
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
