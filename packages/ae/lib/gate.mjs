import fs from 'fs';
import { domainLinkCheck } from './domain-delivery.mjs';
import { planRecordRoot, planHome, planTrustHome, validateDomainContext } from './domain-context.mjs';
import path from 'path';
import { readSession, writeSession } from './session.mjs';
import { loadPlan, pickActivePlan, listPlanRels, parsePlanFrontmatter } from './plan-parse.mjs';
import { findMatchingPlans } from './recall-rank.mjs';
import { intentContractHasContent } from './plan-goal.mjs';
import { planDigest, readEvidence, validateEvidence } from './evidence.mjs';
import { loadPolicy } from './policy.mjs';
import { harnessGlobalHome, resolveCopilotHome } from './paths.mjs';
import { primitivePlanGovernance } from './primitive-governance.mjs';
import { validateRoutingSnapshot } from './route.mjs';
import { configuredCheckSnapshot, validatePlanReadiness } from './plan-readiness.mjs';
import { readPlanRecord } from './plan-record.mjs';
import { validatePlanSchema } from './plan-schema.mjs';
import { intentSourcesCheck } from './intent-sources.mjs';
import { inspectIsolation, isolatedWorktreeDestination, planSlugFromPath, worktreeGateMessage } from './worktree.mjs';
import { recoveryDiagnostics } from './diagnostics.mjs';
import { withGitIdentityCache } from './git-observation-cache.mjs';

export function runGate(options) {
  return withGitIdentityCache(() => readGate(options));
}

function readGate({ workspace, flags, query = '', planOverride = null, domainContext = null }) {
  const sessionRoot = domainContext ? validateDomainContext(domainContext, workspace).root : planOverride ? planRecordRoot(workspace, planOverride) : workspace;
  const session = readSession(sessionRoot);
  const phase = flags.phase || 'implement';
  const checks = [];
  let pass = true;
  let exitCode = 0;
  let primitiveGovernanceFailed = false;

  const planPaths = listPlanRels(workspace);
  const matches = query ? findMatchingPlans(workspace, query, 5) : [];
  const plan = planOverride || (flags.plan
    ? loadPlan(workspace, flags.plan, { home: flags.harnessHome, domainContext })
    : pickActivePlan(workspace, session, matches, planPaths));

  if (!plan && planPaths.length === 0) {
    checks.push({
      id: 'C1',
      pass: false,
      message: 'No plan in the project store, docs/plans/, or .harness/plans/',
      severity: 'fail',
    });
    pass = false;
  } else if (!plan) {
    checks.push({
      id: 'C1',
      pass: false,
      message: flags.plan ? 'Selected plan is unreadable, outside its authorized store, or has an unsupported schema/extension' : `Plans exist (${planPaths.length}) but no active plan — run ae orient or set session.activePlan`,
      severity: 'fail',
    });
    pass = false;
  } else {
    checks.push({ id: 'C1', pass: true, message: `Plan: ${plan.path}`, severity: 'ok' });
    if (plan.fm.plan_schema !== undefined || plan.fm.plan_format !== undefined) {
      const schema = validatePlanSchema(plan);
      checks.push({ id: 'C-plan-schema', pass: schema.pass, message: schema.pass ? 'Declared plan schema is supported' : schema.checks.filter(check => !check.pass).map(check => check.message).join('; '), severity: schema.pass ? 'ok' : 'fail' });
      if (!schema.pass) pass = false;
    }

    const readiness = validatePlanReadiness(workspace, plan, { copilotHome: resolveCopilotHome(flags.copilotHome) });
    for (const check of readiness.checks) {
      checks.push({
        id: `C-${check.id}`,
        pass: check.pass,
        message: check.message,
        severity: check.pass ? 'ok' : 'fail',
      });
    }
    if (!readiness.pass) pass = false;

    const record = readPlanRecord(plan.text);
    if (!record && !plan.sections.overview) {
      checks.push({ id: 'C1a', pass: false, message: 'Missing ## Overview', severity: 'fail' });
      pass = false;
    }
    if (!record && !plan.sections.acceptance) {
      checks.push({ id: 'C1b', pass: false, message: 'Missing ## Acceptance Criteria', severity: 'fail' });
      pass = false;
    }
    if (!record && !plan.sections.activity) {
      checks.push({
        id: 'C4',
        pass: false,
        message: 'Missing ## Activity',
        severity: phase === 'implement' ? 'fail' : 'warn',
      });
      if (phase === 'implement') pass = false;
      else exitCode = Math.max(exitCode, 2);
    } else if (!record) {
      checks.push({ id: 'C4', pass: true, message: '## Activity present', severity: 'ok' });
    }

    if (!record && plan.plan_lock) {
      const intentSectionOk = intentContractHasContent(plan.text);
      if (intentSectionOk) {
        checks.push({ id: 'C-goal', pass: true, message: '## Intent Contract present', severity: 'ok' });
      } else {
        checks.push({
          id: 'C-goal',
          pass: false,
          message: 'Missing or empty ## Intent Contract on locked plan',
          severity: flags.strictIntent ? 'fail' : 'warn',
        });
        if (flags.strictIntent) pass = false;
        else exitCode = Math.max(exitCode, 2);
      }

      checkIntentField({
        checks,
        flags,
        plan,
        id: 'I1',
        field: 'intent',
        message: 'Missing intent frontmatter on locked plan',
      });
      checkIntentField({
        checks,
        flags,
        plan,
        id: 'I2',
        field: 'expected_outputs',
        message: 'Missing expected_outputs frontmatter on locked plan',
      });
      checkIntentField({
        checks,
        flags,
        plan,
        id: 'I3',
        field: 'success_criteria',
        message: 'Missing success_criteria frontmatter on locked plan',
      });
      const intentFailures = checks.filter((check) => check.id.startsWith('I') && !check.pass);
      if (intentFailures.length) {
        if (flags.strictIntent) pass = false;
        else exitCode = Math.max(exitCode, 2);
      }
    }

    if (plan.status === 'blocked-capability') {
      checks.push({
        id: 'CAP',
        pass: false,
        message: 'status: blocked-capability — fulfill gap before implement',
        severity: 'fail',
      });
      pass = false;
    }

    if (phase === 'implement') {
      if (!['planned', 'in-progress', 'review'].includes(plan.status)) {
        checks.push({
          id: 'C2',
          pass: false,
          message: `Plan status is not implementable: ${plan.status}`,
          severity: 'fail',
        });
        pass = false;
      } else {
        checks.push({ id: 'C2', pass: true, message: `Implementable status: ${plan.status}`, severity: 'ok' });
      }
      if (!plan.plan_lock) {
        checks.push({
          id: 'C3',
          pass: false,
          message: 'plan_lock is not true — run /ensure-plan before editFiles',
          severity: 'fail',
        });
        pass = false;
      } else {
        checks.push({ id: 'C3', pass: true, message: 'plan_lock: true', severity: 'ok' });
      }
      const routingCheck = validateRoutingSnapshot(plan.fm.routing);
      if (!routingCheck.legacy) {
        checks.push({
          id: 'R1',
          pass: routingCheck.ok,
          message: routingCheck.ok ? 'routing snapshot is valid' : routingCheck.errors.join('; '),
          severity: routingCheck.ok ? 'ok' : 'fail',
        });
        if (!routingCheck.ok) pass = false;
      }
      const primitive = primitivePlanGovernance(plan);
      if (primitive.required) {
        checks.push(...primitive.checks);
        if (primitive.checks.some((check) => !check.pass)) {
          pass = false;
          primitiveGovernanceFailed = true;
        }
      }

      const isolation = plan.fm.domain_parent ? { blocked: false } : inspectIsolation({
        workspace,
        allowInplace: Boolean(flags.allowInplace),
      });
      checks.push({
        id: 'C-worktree',
        pass: !isolation.blocked,
        message: plan.fm.domain_parent ? 'Domain coordinator gate grants no product edit authority' : worktreeGateMessage(isolation),
        severity: isolation.blocked ? 'fail' : 'ok',
      });
      if (isolation.blocked) pass = false;

      const intentCheck = intentSourcesCheck(plan, workspace);
      checks.push(intentCheck);
      if (!intentCheck.pass) pass = false;
    }

    if (phase === 'verify') {
      const evidence = readEvidence(planRecordRoot(workspace, plan), plan.path);
      const freshness = validateEvidence({
        workspace,
        plan,
        evidence,
        copilotHome: resolveCopilotHome(flags.copilotHome),
        maxAgeHours: loadPolicy(workspace, flags.enforcement, { copilotHome: resolveCopilotHome(flags.copilotHome), home: planTrustHome(workspace, plan) }).evidenceTtlHours,
      });
      if (!freshness.pass) {
        pass = false;
        checks.push({
          id: 'V1',
          pass: false,
          message: freshness.message,
          severity: 'fail',
        });
      } else {
        checks.push({ id: 'V1', pass: true, message: freshness.message, severity: 'ok' });
      }
    }
  }

  if (session?.waiver?.capture && phase === 'implement') {
    checks.push({
      id: 'WAIVER',
      pass: true,
      message: `Capture waiver: ${session.waiver.capture}`,
      severity: 'warn',
    });
    exitCode = Math.max(exitCode, 2);
  }

  const slug = planSlugFromPath(plan?.path);
  const quote = (value) => {
    const text = String(value);
    return /^[A-Za-z0-9_./:+@=-]+$/.test(text) ? text : `"${text.replaceAll('"', '')}"`;
  };
  const stdinDecision = (checkout, action) => [
    `ae plan-update --workspace ${quote(path.resolve(checkout))} --plan ${quote(plan?.path || '<path>')} --file - --json`,
    `{"version":1,"id":"${action}-decision","action":"${action}","expect":"<observed revision>"}`,
  ].join('\n');
  const worktreeBlocked = checks.some((check) => check.id === 'C-worktree' && !check.pass);
  const result = {
    pass,
    phase,
    exitCode: pass ? exitCode : 1,
    plan: plan
      ? {
          path: plan.path,
          status: plan.status,
          plan_lock: plan.plan_lock,
          digest: planDigest(plan.text),
        }
      : null,
    checks,
    blockedReason: pass ? null : checks.filter((c) => !c.pass).map((c) => c.message).join('; '),
    nextTools: pass
      ? phase === 'verify'
        ? ['ae compound', '/auto-compound']
        : plan?.status === 'planned'
          ? [stdinDecision(workspace, 'start')]
          : ['editFiles (scoped)', `ae verify --workspace ${quote(path.resolve(workspace))} --plan ${quote(plan?.path || '<path>')}`]
      : plan?.status === 'blocked-capability'
        ? ['Read <copilot-home>/skills/ensure-capability/SKILL.md with the host read tool']
        : // Lock the plan before primitive governance: an unlocked plan must
          // recover through /ensure-plan even if primitive checks also fail.
          plan && plan.plan_lock && primitiveGovernanceFailed
          ? [
              'Read <copilot-home>/skills/create-primitive/SKILL.md with the host read tool. A not-truncated read of that SKILL.md is activation',
              `update ${plan?.path || '<plan>'} with the create-primitive decision and evidence contract`,
              `ae gate --phase implement --plan ${plan?.path || '<plan>'}`,
            ]
          : worktreeBlocked
            ? [
                `ae worktree --slug ${slug} --workspace ${quote(path.resolve(workspace))}`,
                stdinDecision(isolatedWorktreeDestination(workspace, slug), 'start'),
              ]
            : ['ae orient', '/ensure-plan'],
  };

  result.diagnostics = recoveryDiagnostics({ source: 'gate', checks, workspace, copilotHome: resolveCopilotHome(flags.copilotHome), home: domainContext?.home || flags.harnessHome || flags.home || harnessGlobalHome(), plan: plan?.path || null, domain: domainContext?.name });
  return result;
}

export function publishGateSession({ workspace, plan = null, result, policy, dryRun = false }) {
  const recordRoot = planRecordRoot(workspace, plan);
  if (plan?.fm?.domain_parent) {
    const actor = domainLinkCheck({ workspace, plan, home: planHome(workspace, plan) });
    if (!actor.pass) throw Object.assign(new Error(actor.message), { code: 'E_DOMAIN', exit: 1 });
  }
  const previous = readSession(recordRoot) || {};
  const passed = result.pass && result.exitCode === 0;
  const snapshot = passed ? configuredCheckSnapshot(workspace, { home: planTrustHome(workspace, plan) }) : null;
  if (passed && snapshot.error) throw new Error(snapshot.error);
  const written = writeSession(recordRoot, {
    ...previous,
    activePlan: result.plan?.path || previous.activePlan || null,
    gatedPlan: result.plan?.path || null,
    gatedPlanDigest: passed ? result.plan?.digest || null : null,
    gatedPhase: passed ? result.phase || null : null,
    gatedChecksDigest: passed ? snapshot.digest : null,
    gatedCheckCommands: passed ? snapshot.commands : [],
    lastGateAt: new Date().toISOString(),
    gateStatus: passed ? 'pass' : policy.enforcement === 'enforce' && !result.pass ? 'blocked' : 'warn',
    blockedReason: result.blockedReason,
  }, dryRun);
  if (!written) throw new Error('Could not publish the gate session');
  return written;
}

/** Quick scan for any locked plan without full gate context */
export function scanPlansForGate(workspace) {
  for (const rel of listPlanRels(workspace)) {
    const full = path.join(workspace, rel);
    try {
      const text = fs.readFileSync(full, 'utf8');
      const fm = parsePlanFrontmatter(text);
      if (fm.plan_lock === 'true' || fm.plan_lock === true) return rel;
    } catch {
      // A malformed plan must not prevent scanning the remaining candidates.
    }
  }
  return null;
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
}

function checkIntentField({ checks, flags, plan, id, field, message }) {
  const ok = hasValue(plan.fm[field]);
  if (ok) {
    checks.push({ id, pass: true, message: `${field} present`, severity: 'ok' });
    return;
  }
  checks.push({
    id,
    pass: false,
    message,
    severity: flags.strictIntent ? 'fail' : 'warn',
  });
}
