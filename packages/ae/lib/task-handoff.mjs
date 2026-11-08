import path from 'node:path';
import { createHash } from 'node:crypto';
import { readSession } from './session.mjs';
import { loadPlan, extractSection } from './plan-parse.mjs';
import { extractGoalFromPlan } from './plan-goal.mjs';
import { buildPlanView } from './plan-view.mjs';
import { planDigest, readEvidence } from './evidence.mjs';
import { inspectSourceFile } from './repo-map/scan.mjs';
import { redactSecrets } from './secret-scan.mjs';
import { policyDigest } from './trust.mjs';
import { captureWorkingSources } from './repo-map/working-sources.mjs';
import { DEFAULT_MAX_BYTES } from './fs-safe.mjs';
import { planWorkflow, compactPlanWorkflow } from './plan-decisions.mjs';

export function validateContextSnapshot({ workspace, snapshot, targets, home }) {
  if (snapshot?.version !== 2) return { pass: true };
  const currentPolicy = policyDigest(workspace, undefined, { home });
  if (!currentPolicy || snapshot.state !== 'validated' || snapshot.policyDigest !== currentPolicy) return { pass: false, reason: 'context-stale: reorient after source or policy changes' };
  if (snapshot.sourceState?.digest) {
    const current = captureWorkingSources(workspace);
    if (!current.valid || current.state.digest !== snapshot.sourceState.digest) return { pass: false, reason: 'context-stale: reload the current source generation' };
  }
  if (snapshot.plan) {
    const plan = loadPlan(workspace, snapshot.plan, { home });
    if (!plan || planDigest(plan.text) !== snapshot.contractDigest) return { pass: false, reason: 'context-stale: reload the current task contract' };
  }
  const relative = value => path.relative(workspace, path.resolve(workspace, value)).replaceAll('\\', '/');
  const entries = new Map((snapshot.evidence || []).map(item => [relative(item.location), item]));
  const locations = new Set([...entries.keys(), ...targets.map(relative)]);
  for (const location of locations) {
    const expected = entries.get(location);
    const current = inspectSourceFile(workspace, location, { maxBytes: DEFAULT_MAX_BYTES });
    if (expected?.state === 'missing' && current.state === 'missing') continue;
    if (!expected?.sha256 || expected.sha256 !== current.hash) return { pass: false, reason: 'context-stale: read each touched file with orient --read --context-version 2 before editing' };
  }
  return { pass: true };
}

export function buildTaskHandoff({ workspace, task = '', domainPlan = null, home }) {
  if (domainPlan) return {
    schema: 1, contract: null, domainPlan, requiresRead: true,
    reason: 'Reload the selected domain coordinator contract and delegated work before continuing. Local plan recovery does not establish domain state.',
    next: ['harness', 'domain', 'status', '--name', domainPlan.name, '--plan', domainPlan.path, '--json'],
  };
  const session = readSession(workspace) || {};
  const source = session.contextSnapshot?.sourceState?.digest ? captureWorkingSources(workspace) : null;
  const generationChanged = source && (!source.valid || source.state.digest !== session.contextSnapshot.sourceState.digest);
  const plan = session.activePlan ? loadPlan(workspace, session.activePlan, { home }) : null;
  const contract = plan ? extractGoalFromPlan(plan) : { intent: task, constraints: [] };
  const references = session.contextSnapshot?.evidence || (session.files || []).map(location => ({ location }));
  const evidence = references.slice(0, 40).map(prior => {
    const location = path.isAbsolute(prior.location) ? path.relative(workspace, prior.location) : prior.location;
    const current = inspectSourceFile(workspace, location, { maxBytes: DEFAULT_MAX_BYTES });
    const changed = prior.sha256 ? current.hash !== prior.sha256 : prior.state === 'missing' ? current.state !== 'missing' : false;
    const hash = prior.sha256 || current.hash;
    return { location, reference: hash ? `${location}@sha256:${hash}` : null, state: changed ? 'changed' : current.state === 'readable' ? prior.sha256 ? 'current' : 'available' : current.state };
  });
  const notes = plan ? ['Research Notes', 'Implementation Notes', 'Review Findings'].map(name => extractSection(plan.text, name)).filter(Boolean).join('\n') : '';
  const oversized = Buffer.byteLength(JSON.stringify({ task, contract, notes })) > 6000;
  const proof = plan ? readEvidence(workspace, plan.path) : null;
  const result = {
    schema: 1,
    taskInput: oversized ? null : redactSecrets(task),
    taskInputDigest: createHash('sha256').update(task).digest('hex'),
    plan: plan ? { path: plan.path, status: plan.status, locked: plan.plan_lock, phase: plan.phase } : null,
    workflow: planWorkflow(plan, { workspace }),
    contractDigest: plan ? planDigest(plan.text) : null,
    contract: oversized ? null : JSON.parse(JSON.stringify(contract, (_key, value) => typeof value === 'string' ? redactSecrets(value) : value)),
    notes: oversized ? null : redactSecrets(notes),
    progress: plan ? buildPlanView(plan)?.body || null : null,
    verification: proof ? { outcome: proof.outcome, currentness: 'not-validated' } : null,
    evidence,
    evidenceOmitted: Math.max(0, references.length - 40) + (session.contextSnapshot?.evidenceOmitted || 0),
    requiresRead: Boolean(generationChanged || (session.activePlan && !plan) || !contract || oversized || evidence.some(item => !['current', 'missing'].includes(item.state)) || references.length > 40 || session.contextSnapshot?.evidenceOmitted),
    reason: oversized ? 'Task input, contract or notes exceed the handoff budget; read the original task and source plan.' : generationChanged ? 'Source generation changed; reorient before using prior evidence.' : null,
    next: plan ? ['harness', 'orient', '--read', '--context-version', '2', '--plan', plan.path] : ['harness', 'orient', '--read', '--context-version', '2'],
    authority: 'Derived from existing task and plan records. Current gates and proof still govern edits and completion.',
  };
  while (Buffer.byteLength(JSON.stringify(result)) > 8000 && result.evidence.length) {
    result.evidence.pop();
    result.evidenceOmitted++;
    result.requiresRead = true;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 8000) return { schema: 1, taskInput: null, contract: null, workflow: compactPlanWorkflow(result.workflow), requiresRead: true, reason: 'Handoff exceeds the budget; reload the source records.', next: result.next };
  return result;
}
