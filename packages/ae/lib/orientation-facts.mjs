import { rankLearnings } from './knowledge/retrieve.mjs';
import { readStoreConfig } from './knowledge/store.mjs';
import { runGate } from './gate.mjs';
import { indexStatus } from './index-status.mjs';
import { buildNeighborhood } from './repo-map/index.mjs';
import { pickActivePlan, listPlanRels, loadPlan } from './plan-parse.mjs';
import { readSession } from './session.mjs';
import { findMatchingPlans } from './recall-rank.mjs';
import { discoverInventory, routingCards, routingReadPointers, primitiveReadRoots } from './route.mjs';
import { extractGoalFromPlan } from './plan-goal.mjs';
import { parseImpactedFiles } from './plan-scope.mjs';
import { trustStatus } from './trust.mjs';
import { inspectCheckReadiness } from './check-readiness.mjs';
import { reviewCoverageFacts } from './report-facts.mjs';
import { captureWorkingSources } from './repo-map/working-sources.mjs';
import { caffeinatedPointer } from './playbook-binding.mjs';
import { PLAYBOOKS } from './routing-policy.mjs';
import { locateVerification } from './verification-location.mjs';
import { resolveObligation, intentPage } from './intent-sources.mjs';
import { performanceContext } from './performance.mjs';
import { buildChangeImpactContext } from './change-impact.mjs';
import { flowModelContext } from './flow-model.mjs';
import { detectWorkspace, emptyLayout } from './workspace-layout.mjs';
import { withGitIdentityCache } from './git-observation-cache.mjs';

function indexPlane(plane) {
  if (!plane?.indexed) return 'missing';
  if (plane.unreadable?.length) return 'unreadable';
  return plane.stale ? 'stale' : 'current';
}

export function collectOrientationFacts(options = {}) {
  return withGitIdentityCache(() => readOrientationFacts(options));
}

function readOrientationFacts({ workspace, copilotHome, flags = {}, query = '', files, graphPreparation } = {}) {
  const session = readSession(workspace) || {};
  const q = query || flags.query || (flags.contextVersion === 2 ? session.lastQuery || '' : '');
  const sourceSnapshot = flags.contextVersion === 2 ? captureWorkingSources(workspace) : null;
  const home = flags.harnessHome || flags.home;
  const failures = [];
  const advisory = (name, fallback, read) => {
    try { return read(); } catch { failures.push(name); return fallback; }
  };
  const matches = advisory('plans', [], () => findMatchingPlans(workspace, q, flags.limit || 3));
  const active = advisory('active-plan', null, () => flags.plan ? loadPlan(workspace, flags.plan) : pickActivePlan(workspace, session, matches, listPlanRels(workspace)));
  const supplied = Array.isArray(files) ? files : flags.files;
  const priorFiles = flags.contextVersion === 2 ? session.lastContextFiles || session.files : session.files;
  const namedFiles = supplied?.length ? supplied : active ? parseImpactedFiles(active) : priorFiles || [];
  const learnings = advisory('learnings', [], () => {
    const { mode } = readStoreConfig(workspace, { home });
    return mode === 'off' || mode === 'capture-only' ? [] : rankLearnings({ workspace, query: q, limit: flags.limit || 3, home, signals: namedFiles });
  });
  const gate = advisory('gate', { pass: false, blockedReason: 'gate unavailable' }, () => runGate({ workspace, flags: { ...flags, phase: 'implement' }, query: q }));
  const status = advisory('index', null, () => indexStatus({ workspace, copilotHome, home }));
  let skills = [], instructions = [], contacts = [], routingLines = null;
  if (active?.fm?.routing) {
    const routing = advisory('routing', null, () => {
      const inventory = discoverInventory(primitiveReadRoots(copilotHome));
      return { ...routingCards(active.fm.routing, inventory), lines: routingReadPointers(active.fm.routing, inventory) };
    });
    if (routing) ({ skills, instructions, contacts, lines: routingLines } = routing);
  }
  const neighborhood = namedFiles.length ? advisory('neighborhood', null, () => buildNeighborhood({ workspace, files: namedFiles, home, includeEvidence: flags.contextVersion === 2 })) : null;
  const procedure = caffeinatedPointer(active, { copilotHome });
  const activating = PLAYBOOKS.filter((id) => id !== 'investigation');
  const procedureFact = procedure
    ? { id: procedure.id, path: procedure.path, command: 'Read <copilot-home>/skills/caffeinated/SKILL.md with the host read tool. A not-truncated read of that SKILL.md is activation' }
    : {
        id: null,
        reason: active?.fm?.playbook === 'investigation'
          ? `Playbook investigation does not activate caffeinated. The playbooks that activate it are ${activating.join(', ')}.`
          : active?.fm?.playbook
            ? `Playbook ${active.fm.playbook} does not activate caffeinated. The playbooks that activate it are ${activating.join(', ')}. investigation does not.`
            : `No playbook is bound. caffeinated activates when the plan playbook is ${activating.join(', ')}. investigation does not. The CLI does not choose a playbook.`,
      };
  const obligation = resolveObligation(workspace, active, q);
  const performance = performanceContext({ workspace, home, files: namedFiles || [] });
  const flowModel = advisory('flow-model', null, () => flowModelContext({ workspace, home, files: namedFiles || [], query: q }));
  let trust = trustStatus({ workspace, copilotHome, home });
  const checkReadiness = inspectCheckReadiness({ workspace, copilotHome, home });
  // Check preparation can change policy bytes, so defer the approval handoff until checks are ready.
  if (!checkReadiness.ready && trust.recovery?.afterInspection) trust = { ...trust, recovery: { ...trust.recovery, afterInspection: null } };
  const slice = {
    ...(flowModel ? { flowModel } : {}),
    ...(performance ? { performance } : {}),
    neighborhood,
    graph: { commands: ['ae graph deps', 'ae graph dependents', 'ae graph path', 'ae graph explain', 'ae graph impact'], source: 'current-worktree', scope: 'git-tracked-source', semanticCompleteness: 'unverified', bounded: true, calls: 'approximate references only' },
    intentSources: obligation.paths,
    intentDiscovery: obligation.metadata,
    intentDetail: flags.intentPage ? intentPage(workspace, active?.fm?.intent || q, { page: flags.intentPage, pageSize: flags.intentPageSize || 8 }) : null,
    verification: locateVerification(workspace, active?.fm?.verification?.recipe),
    planGoal: active ? extractGoalFromPlan(active) : null,
    trust,
    checkReadiness,
    reviewCoverage: reviewCoverageFacts({ workspace, plan: active, copilotHome }),
    learnings, skills: procedure && !skills.some(skill => skill.id === procedure.id) ? [...skills, procedure] : skills, procedure: procedureFact, instructions, contacts,
    index: { knowledge: indexPlane(status?.knowledge), structural: indexPlane(status?.structural) },
    gateStatus: gate.pass ? 'pass' : 'blocked',
    activePlan: active ? { path: active.path, status: active.status, plan_lock: active.plan_lock } : null,
    layout: advisory('layout', emptyLayout(), () => detectWorkspace(workspace, { home })),
  };
  if (flags.questionKind) slice.impactContext = buildChangeImpactContext({ workspace, copilotHome, home, query: q, files: flags.files || [], questionKind: flags.questionKind, graphPreparation });
  return { slice, active, session, namedFiles, matches, gate, status, routingLines, failures, sourceSnapshot, query: q, procedure, obligation };
}
