import fs from 'fs';
import path from 'node:path';
import { planStateFacts } from './report-facts.mjs';
import { rankRecall } from './recall-rank.mjs';
import { buildContextPack, learningsSectionBytes, learningRendered } from './context-pack.mjs';
import { buildPlanView } from './plan-view.mjs';
import { buildRepoMap } from './repo-map/index.mjs';
import { ensureHarnessDir, writeSession } from './session.mjs';
import { parseQueryFromArgv } from './argv.mjs';
import { explainLearnings } from './knowledge/retrieve.mjs';
import { storeDir } from './knowledge/store.mjs';
import { consolidateStatus } from './knowledge/consolidate.mjs';
import { deriveGitContext } from './git-context.mjs';
import { redactRecallEntry, redactSecrets } from './secret-scan.mjs';
import { inertLine } from './knowledge/store.mjs';
import { prepareNextTool } from './prepare.mjs';
import { inspectIsolation, planSlugFromPath } from './worktree.mjs';
import { collectOrientationFacts } from './orientation-facts.mjs';
import { buildContextRecord } from './context-record.mjs';
import { accountContext } from './token-meter.mjs';
import { writeFileContained } from './fs-safe.mjs';
import { recordExposure } from './learning-feedback.mjs';
import { planRecordRoot, planTrustHome } from './domain-context.mjs';
import { readEvidence, validateEvidence } from './evidence.mjs';
import { loadPolicy } from './policy.mjs';

const ORIENT_BRANCH_CAP = 80;
function writeContextFile(workspace, rel, content) {
  const stat = fs.lstatSync(path.join(workspace, rel), { throwIfNoEntry: false });
  return writeFileContained(workspace, rel, content, stat ? { mode: stat.mode & 0o777 } : {});
}

function jsonGitContext(gitContext) {
  if (!gitContext) return null;
  return {
    branch: gitContext.branch ? inertLine(redactSecrets(String(gitContext.branch))).slice(0, ORIENT_BRANCH_CAP) : null,
    branchKey: gitContext.branchKey,
    detached: gitContext.detached,
    headSha: gitContext.headSha,
    baseSha: gitContext.baseSha,
  };
}

/**
 * A resumed plan whose last `ae verify` evidence failed or no longer matches
 * the work may hide breakage left by the previous session. Advisory only: it
 * reorders next tools and never changes a gate. Null when there is no active
 * plan, no evidence yet, or the evidence is current.
 *
 * States: `failed` (the last run failed), `changed` (head, plan or workspace
 * moved since the run), `config` (policy, trust or check configuration moved;
 * re-verifying cannot reveal leftover breakage and may first need trust or
 * check repair) and `expired` (only older than the evidence TTL).
 */
const EVIDENCE_AGE_MESSAGE = 'Verification evidence is stale';
// The fixed policy, trust and named-check messages from validateEvidence and loadNamedChecks.
const CONFIG_MESSAGES = [
  message => message === 'Policy or trust changed after verification; refresh trust and reverify',
  message => message === 'Required named check is missing',
  message => message.startsWith('Trusted check config not found: '),
  message => message.startsWith('Invalid project checks'),
  message => message.endsWith(' must declare version: 1 and checks'),
];

function resumeVerification({ workspace, copilotHome, flags, active }) {
  if (!active?.path) return null;
  try {
    const evidence = readEvidence(planRecordRoot(workspace, active), active.path);
    if (!evidence) return null;
    const reason = message => inertLine(message || 'verification evidence is not current').replace(/`/g, "'").slice(0, 160);
    if (evidence.outcome !== 'passed') return { state: 'failed', reason: reason(`Latest ae verify outcome is ${evidence.outcome || 'unknown'}`) };
    // One validation, unbounded in age, tells a real change from plain expiry;
    // the age is then checked here against the policy's evidence TTL.
    const current = validateEvidence({ workspace, plan: active, evidence, maxAgeHours: Number.MAX_SAFE_INTEGER, copilotHome });
    if (current.pass) {
      const maxAgeHours = loadPolicy(workspace, flags.enforcement, { copilotHome, home: planTrustHome(workspace, active) }).evidenceTtlHours;
      const verifiedAt = Date.parse(evidence.verifiedAt || '');
      // An unparsable verifiedAt cannot prove freshness, so it counts as expired.
      return !Number.isFinite(verifiedAt) || Date.now() - verifiedAt > maxAgeHours * 60 * 60 * 1000 ? { state: 'expired', reason: reason(EVIDENCE_AGE_MESSAGE) } : null;
    }
    const message = current.message;
    // Only policy, trust and named-check configuration count as `config`.
    // Intent-source, gap and playbook messages describe plan contract changes
    // and stay `changed`.
    return { state: CONFIG_MESSAGES.some(test => test(message || '')) ? 'config' : 'changed', reason: reason(message) };
  } catch {
    return null;
  }
}

/**
 * Replaces the plain verify entry with the hint. A failed or changed run goes
 * after any readiness step; a configuration change stays in the plain verify
 * slot, ahead of compound and completion, preceded by any trust recovery step.
 * Nothing changes while the gate or worktree isolation is blocked, since the
 * isolation step is only listed then.
 */
// A plan path as one shell word: bare when it holds only safe characters,
// otherwise single-quoted, so a space, `#` or `$` cannot split or end the command.
const shellArg = value => (/^[\w./@:+-]+$/.test(value) ? value : `'${String(value).replace(/'/g, "'\\''")}'`);

export function withResumeVerification(nextTools, check, { planPath, gatePass, isolationBlocked }) {
  if (!check || check.state === 'expired' || !gatePass || isolationBlocked) return nextTools;
  const hint = check.state === 'config'
    ? `ae verify --plan ${shellArg(planPath)}  # prior verification no longer matches configuration: ${check.reason}; first use trust.recovery or repair checks if listed`
    : `ae verify --plan ${shellArg(planPath)}  # prior verification ${check.state}: ${check.reason}; check for leftover breakage before new work`;
  if (check.state === 'config') {
    const recovery = nextTools.filter(tool => /^(Use|Inspect) trust\.recovery/.test(tool));
    const rest = nextTools.filter(tool => tool !== 'ae verify' && !recovery.includes(tool));
    const at = nextTools.filter(tool => !recovery.includes(tool)).indexOf('ae verify');
    return at === -1 ? [...rest, ...recovery, hint] : [...rest.slice(0, at), ...recovery, hint, ...rest.slice(at)];
  }
  const rest = nextTools.filter(tool => tool !== 'ae verify');
  const lead = rest.findIndex(tool => !tool.startsWith('Use checkReadiness.'));
  const at = lead === -1 ? rest.length : lead;
  return [...rest.slice(0, at), hint, ...rest.slice(at)];
}

export function runOrient({ workspace, copilotHome, flags, query, files }) {
  const q = query || flags.query || '';
  // Refuse unsafe state paths before producing orientation artifacts.
  if (ensureHarnessDir(workspace, flags.dryRun) === null) throw Object.assign(new Error('orientation state directory or ignore file is unsafe or unavailable'), { code: 'E_ORIENT_WRITE', exit: 1 });

    let gitContext = null;
  try {
    gitContext = deriveGitContext({ workspace });
    if (!gitContext.branch && !gitContext.detached) gitContext = null;
  } catch {
    gitContext = null;
  }

  const home = flags.harnessHome || flags.home;
  const facts = collectOrientationFacts({ workspace, copilotHome, flags, query: q, files });
  const { active, session, namedFiles, gate: gatePreview, routingLines, status, procedure, obligation } = facts;
  const { planGoal, learnings, trust, checkReadiness, reviewCoverage, index, skills, instructions, contacts, neighborhood, verification, intentDiscovery, intentDetail, performance, flowModel } = facts.slice;
  const recall = rankRecall(q, {
    copilotHome,
    workspace,
    limit: flags.limit || 3,
    collection: flags.collection,
    minScore: flags.minScore ?? 0.15,
    home,
      }).map((e) => redactRecallEntry({
    docid: e.docid || e.id,
    path: e.path,
    title: e.title,
    score: Number(e.score.toFixed(3)),
    summary: e.summary || '',
    snippet: e.snippet || '',
    scope: e.scope,
    kind: e.kind || 'solution',
    ranker: e.ranker || 'overlap',
  }));

  const planFacts = planStateFacts(workspace);
  const planTotal = planFacts.total;
  const plans = facts.matches.map((p) => ({
    path: p.path,
    status: p.status,
    plan_lock: p.plan_lock,
    score: Number(p.score.toFixed(3)),
  }));

  const planView = active ? buildPlanView(active) : null;

  let memoryExcerpt = '';
  if (active) {
    const cards = active.sections.memoryCards || '';
    memoryExcerpt = cards
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 12)
      .join('\n');
  }

  const explain = flags.explain ? explainLearnings({ workspace, query: q, home }) : null;

    let repoMapRef = null;
  try {
    const repoMapRel = '.harness/repo-map.md';
    const repoMap = buildRepoMap({ workspace, query: q, home });
    if (!repoMap.empty) {
      if (!flags.dryRun && !writeContextFile(workspace, repoMapRel, repoMap.body)) throw new Error('repo map target is unsafe or unavailable');
      repoMapRef = { path: repoMapRel, files: repoMap.files.length, totalFiles: repoMap.totalFiles };
    }
  } catch {
    // Repo map is advisory context; never fail orientation on it.
  }

  const nextTools = gatePreview.pass
    ? ['ae gate --phase implement', 'read plan ## Impacted Files', `ae review prepare --plan ${active?.path || '<path>'}`, 'ae verify', `ae compound --plan ${active?.path || '<path>'} --learning-decision -`, `ae plan-update --workspace "${workspace}" --plan "${active?.path || '<path>'}" --file - --json\n{"version":1,"id":"complete-decision","action":"complete","expect":"<observed revision>"}`]
    : [`ae gate --plan ${active?.path || '<path>'}`, 'read ensure-plan/SKILL.md'];
  if (trust.recovery && checkReadiness.ready) nextTools.push('Use trust.recovery');
  else if (trust.recovery?.owner === 'engineer') nextTools.push('Inspect trust.recovery; prepare checks before approval');
  if (!checkReadiness.ready) nextTools.unshift('Use checkReadiness.inspectionCommand');

  const intentSources = obligation.paths;
  const isolation = inspectIsolation({ workspace, home, allowInplace: flags.allowInplace });
  if (isolation.blocked) {
    nextTools.unshift(`ae worktree --slug ${planSlugFromPath(active?.path)}`);
  }
  if (flowModel) nextTools.push('ae flows show --json');
  if (intentSources[0]) nextTools.push(`read ${intentSources[0].path}`);
  if (procedure) nextTools.push(`read ${inertLine(procedure.path)}`);
  if (verification.path) nextTools.push(`read ${inertLine(verification.path)}`);
  if (obligation.reason === 'none') nextTools.push(prepareNextTool(workspace));
  if (intentDiscovery?.omittedCount) nextTools.push('ae orient --read --intent-page 1 --json');

  if (status?.stale) nextTools.push('ae index  # knowledge index is behind HEAD');
  if (status?.structural?.unreadable?.length) nextTools.push('ae index --structural  # code index is unreadable');
  else if (!status?.structural?.indexed || status.structural.stale) nextTools.push('ae index --structural  # refresh current code facts');

    let knowledgeDebt = null;
  try {
    if (fs.existsSync(storeDir(workspace))) {
      const debt = consolidateStatus({ workspace, copilotHome });
      if (['on', 'suggest'].includes(debt.mode)) {
        knowledgeDebt = { debt: debt.debt, threshold: debt.threshold, due: debt.due };
        if (debt.due && !active) {
          const next = debt.nextTools?.[0] || 'ae consolidate --candidates';
          // Status names the --recheck packet only when re-check evidence made consolidation due.
          const recheckDue = next.endsWith('--recheck');
          const reason = recheckDue && debt.debt < debt.threshold ? 'consolidation due: re-check evidence'
            : `knowledge debt ${debt.debt}/${debt.threshold}${recheckDue ? '; re-check evidence' : ''}`;
          nextTools.push(`${next}  # ${reason}`);
        }
      }
    }
  } catch {
    // Advisory; never block orientation on it.
  }

  // Computed whatever the gate says: the hint is shown only when the gate
  // passes, but the state is always reported as resumeVerification.
  const resumeCheck = resumeVerification({ workspace, copilotHome, flags, active });
  if (resumeCheck) nextTools.splice(0, nextTools.length, ...withResumeVerification(nextTools, resumeCheck, { planPath: active.path, gatePass: gatePreview.pass, isolationBlocked: isolation.blocked }));

  if (gatePreview.pass && routingLines) {
    for (const line of routingLines) if (line.startsWith('read ') && !nextTools.includes(line)) nextTools.push(line);
    const javaFile = namedFiles.find(rel => rel.endsWith('.java'));
    if (javaFile) nextTools.push(`read ${javaFile}`);
  }

  const packBody = buildContextPack({
    flowModel,
    performance,
    verification,
    intentDiscovery,
    reviewCoverage,
    trust,
    checkReadiness,
    query: q,
    recall,
    learnings,
    plans,
    planTotal,
    planStateCounts: planFacts.counts,
    activePlan: active
      ? {
          path: active.path,
          status: active.status,
          plan_lock: active.plan_lock,
          phase: active.phase,
          memoryExcerpt,
        }
      : null,
    planGoal,
    planView,
    repoMapRef,
    gatePreview: { pass: gatePreview.pass, blockedReason: gatePreview.blockedReason },
    nextTools,
    gitContext,
    routingLines,
    neighborhood,
    intentSources,
    worktree: isolation,
  });

    const learningsBytes = learningsSectionBytes(packBody);

    // A learning is delivered when its own line, layer mark included, starts a line of the learnings section.
  const renderedLearnings = learnings.filter((l) => learningRendered(packBody, l));
  const deliveredLearnings = renderedLearnings.map((l) => l.id);

  const packRel = '.harness/context-pack.md';
  if (!flags.dryRun && !writeContextFile(workspace, packRel, packBody)) throw Object.assign(new Error('context pack target is unsafe or unavailable; no context pack was written'), { code: 'E_ORIENT_WRITE', exit: 1 });
  if (!flags.dryRun && active?.path && deliveredLearnings.length) {
    try {
      recordExposure({ recordRoot: planRecordRoot(workspace, active), workspace, home, planPath: active.path, delivered: renderedLearnings });
    } catch {
      // Exposure is bookkeeping for the feedback loop; never fail orientation on it.
    }
  }

  const newSession = {
    ...session,
    lastQuery: q,
    lastOrientAt: new Date().toISOString(),
    activePlan: active?.path || null,
    lastContextFiles: namedFiles,
    contextPack: packRel,
    gateStatus: gatePreview.pass ? 'pass' : 'blocked',
    blockedReason: gatePreview.blockedReason,
        gitBranch: gitContext?.branch || null,
    gitBranchKey: gitContext?.branchKey || null,
    gitDetached: gitContext?.detached || false,
    gitHeadSha: gitContext?.headSha || null,
  };
  writeSession(workspace, newSession, flags.dryRun);

  return {
    recall,
    ...(flowModel ? { flowModel } : {}),
    ...(performance ? { performance } : {}),
    verification,
    intentDiscovery,
    intentDetail,
    trust,
    checkReadiness,
    workflow: facts.slice.workflow,
    learnings,
    deliveredLearnings,
    explain,
    learningsBytes,
    plans,
    planTotal,
    planStateCounts: planFacts.counts,
    activePlan: active ? { path: active.path, status: active.status, plan_lock: active.plan_lock } : null,
    planGoal: planGoal
      ? {
          planPath: planGoal.planPath,
          intent: planGoal.intent,
          success_criteria: planGoal.success_criteria,
          constraints: planGoal.constraints,
          expected_outputs: planGoal.expected_outputs,
          intentContractExcerpt: planGoal.intentContractExcerpt,
        }
      : null,
    contextPack: packRel,
    repoMap: repoMapRef,
    contextAccounting: accountContext({ boundary: 'orientation-output', components: [{ category: 'pack', id: packRel, content: packBody }] }),
    knowledgeDebt,
    ...(resumeCheck ? { resumeVerification: resumeCheck } : {}),
    gitContext: jsonGitContext(gitContext),
    worktree: {
      blocked: isolation.blocked,
      linked: isolation.linked,
      onDefault: isolation.onDefault,
      isolated: isolation.isolated,
      skipReason: isolation.skipReason,
    },
    intentSources,
    reviewCoverage,
    gateStatus: newSession.gateStatus,
    blockedReason: newSession.blockedReason,
    nextTools,
    layout: facts.slice.layout,
    neighborhood,
    skills,
    instructions,
    contacts,
    ...(facts.slice.capabilities ? { capabilities: facts.slice.capabilities, adaptation: facts.slice.adaptation } : {}),
    index,
    ...(flags.contextVersion === 2 ? { context: buildContextRecord({ workspace, flags, query: q, facts }) } : {}),
  };
}

export { parseQueryFromArgv };
