import path from 'node:path';
import fs from 'node:fs';
import { harnessGlobalHome } from './paths.mjs';
import { discoverCapabilities, discoveryPolicy, resolveCapability } from './capability-catalog.mjs';
import { resourceCandidates } from './resource-candidates.mjs';
import { readSession } from './session.mjs';
import { currentSkillActivation } from './skill-provenance.mjs';
import { loadPlan } from './plan-parse.mjs';
import { planRecordRoot } from './domain-context.mjs';
import { recordHash, readReviewRecord, nativeReviewPacketBinding } from './review.mjs';
import { reviewHash } from './review-preparation.mjs';
import { validateReviewObservation } from './native-specialist-observation.mjs';

export function capabilityOptions({ home, workspace, copilotHome, skillsHome, host } = {}) {
  return { home: home || harnessGlobalHome(), workspace, copilotHome,
    skillsHome: skillsHome || process.env.AE_SKILLS_HOME || undefined, host: host || undefined };
}

/** Startup never calls a model. Source inclusion and ongoing scans remain separate choices. */
export function onboardingDiscovery(options = {}) {
  const result = discoverCapabilities({ ...capabilityOptions(options), onboarding: true, query: options.query || '', limit: options.limit ?? 100 });
  return { ...result, requiresModel: false, questions: result.configured ? [] : [
    { id: 'include-existing', prompt: 'Which existing skills, agents and instructions should AE include?', candidates: result.candidates.map(item => ({ id: item.id, name: item.name || item.id, kind: item.kind, path: item.path })) },
    { id: 'ongoing-discovery', prompt: 'May AE refresh these selected sources and adopt eligible changes under your standing permissions?' },
  ], nextAction: result.configured ? null : 'Engineer records the inclusion choices and ongoing permission through resources discover; no consent is inferred from installation.' };
}

export function capabilityContext(options = {}) {
  const result = discoverCapabilities({ ...capabilityOptions(options), onboarding: false, query: options.query || '', limit: Math.min(options.limit || 8, 8) });
  if (!result.configured) return null;
  const resources = result.resources.map(item => ({ id: item.id, kind: item.kind, path: item.path, digest: item.digest,
    description: item.description.slice(0, 120), scope: item.scope, invocable: item.invocable, activation: item.activation, nativeQualification: item.nativeQualification }));
  const summary = { schema: 1, status: result.status, configured: true, policyRevision: result.policyRevision, resources, counts: result.counts,
    refreshed: result.refreshed, refreshBlocked: result.refreshBlocked, omitted: 0, coverage: { state: 'partial', metadata: 'Shortlist; source definitions, permissions and pending candidates require expansion' },
    expansion: { command: 'ae resources discover --json' }, assurance: 'Included metadata; native invocation and usefulness need their own evidence' };
  const omissions = () => { summary.omitted = Math.max(0, result.counts.matched - resources.length) + result.omitted; };
  omissions();
  while (Buffer.byteLength(JSON.stringify(summary)) > 4096 && resources.length) { resources.pop(); omissions(); }
  return summary;
}

/** Surface evidence automatically; recurrence is a reason to assess, never authority to install. */
export function adaptationContext({ workspace, copilotHome, home, query = '', limit = 4 } = {}) {
  const evidence = resourceCandidates({ workspace, copilotHome, home, dryRun: true });
  const tokens = query.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [];
  const rows = [
    ...evidence.candidates.map(item => ({ item, collection: 'candidates', basis: item.recurrence, recommendation: 'assess-reuse-update-or-create' })),
    ...(evidence.resourceUseRecurrence || []).map(item => ({ item, collection: 'resourceUseRecurrence', basis: 'verified-task-resource-recurrence', recommendation: 'reuse-or-improve-existing-capability' })),
    ...evidence.verifiedUsePromotion.candidates.map(item => ({ item, collection: 'verifiedUsePromotion.candidates', basis: 'recorded-learning-candidate', recommendation: 'audit-proof-and-overlap' })),
    ...evidence.globalTagClustering.map(item => ({ item, collection: 'globalTagClustering', basis: 'shared-tags-only', recommendation: 'assess-semantic-overlap' })),
  ];
  const nameOf = item => String(item.detail?.resource?.name || item.name || item.tag || item.detail?.claim || item.detail?.title || item.id || item.identity || 'candidate');
  // Evidence filenames are shared across many resources. Rank actual owners
  // and claims rather than letting a task path make every card look relevant.
  const score = row => {
    const name = nameOf(row.item).toLowerCase(), words = name.split(/[^a-z0-9]+/), semantic = `${row.item.detail?.claim || ''} ${row.item.detail?.title || ''}`.toLowerCase();
    return tokens.reduce((sum, token) => sum + (name === token ? 20 : words.includes(token) ? 8 : name.includes(token) ? 4 : 0) + (semantic.includes(token) ? 2 : 0), 0);
  };
  const ranked = rows.map((item, index) => ({ item, index, score: score(item) }))
    .filter(row => !tokens.length || row.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const candidates = ranked.slice(0, Math.max(0, Math.min(4, limit))).map(({ item: row }) => {
    const item = row.item, references = item.evidence || [], resource = item.detail?.resource;
    const first = references.find(ref => typeof ref.path === 'string' && ref.path.length <= 512 && (!ref.base || ref.base.length <= 512));
    return { id: item.id || recordHash(item), kind: resource?.kind || item.detail?.kind || row.basis, name: nameOf(item).slice(0, 120),
      count: item.count ?? null, basis: row.basis, recommendation: row.recommendation, verifiedTaskEvidence: item.verifiedTaskEvidence === true, causalEffectiveness: 'unassessed',
      source: { collection: row.collection }, ...(resource ? { resource: { kind: resource.kind, name: resource.name, sha256: resource.sha256 } } : {}),
      evidence: first ? [{ source: first.source, path: first.path, sha256: first.sha256, ...(first.base ? { base: first.base } : {}) }] : [], omittedEvidence: Math.max(0, references.length - (first ? 1 : 0)) };
  });
  const omittedEvidence = Object.values(evidence.omitted || {}).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  const summary = { schema: 1, candidates, omitted: 0,
    candidatePacket: { id: evidence.id, path: evidence.packetPath, persisted: evidence.persisted },
    coverage: { state: 'partial', omitted: evidence.omitted || {}, detail: evidence.detail || 'Cards summarize evidence; expand the exact candidate packet before deciding' },
    assessment: candidates.length ? 'Native decision agent assesses existing owner, overlap and real proof; reuse, update or propose only within standing scope.'
      : omittedEvidence || evidence.detail ? 'Candidate evidence was omitted; inspect the frozen packet before deciding there is no relevant recurrence.' : 'No relevant recurrence candidate.',
    nextAction: candidates.length || omittedEvidence || evidence.detail ? 'ae resources candidates --json' : null,
    assurance: 'Evidence candidates, not automatic skill promotion or proven resource effectiveness' };
  const omissions = () => { summary.omitted = Math.max(0, ranked.length - candidates.length) + omittedEvidence + candidates.reduce((count, item) => count + item.omittedEvidence, 0); };
  omissions();
  while (Buffer.byteLength(JSON.stringify(summary)) > 4096 && candidates.length) {
    const detailed = candidates.findLast(item => item.evidence.length);
    if (detailed) { detailed.omittedEvidence += detailed.evidence.length; detailed.evidence = []; }
    else candidates.pop();
    omissions();
  }
  if (!candidates.length && ranked.length) {
    summary.assessment = 'Candidate evidence was omitted; inspect the frozen packet before deciding there is no relevant recurrence.';
    summary.nextAction = 'ae resources candidates --json';
  }
  if (!summary.omitted && !evidence.detail && !candidates.length) summary.coverage = { ...summary.coverage, state: 'complete', detail: null };
  return summary;
}

function reviewedAgentUses(options, session) {
  try {
    if (!session.activePlan) return [];
    const consent = discoveryPolicy(options);
    if (!consent.configured) return [];
    const plan = loadPlan(options.workspace, session.activePlan, { home: options.home });
    if (!plan || options.plan && plan.path !== (options.plan.path || options.plan)) return [];
    const recordRoot = planRecordRoot(options.workspace, plan);
    const pointer = readReviewRecord(recordRoot, `.harness/reviews/latest/${recordHash(plan.path)}.json`);
    if (!/^[a-f0-9]{64}$/.test(pointer?.id || '')) return [];
    const record = readReviewRecord(recordRoot, `.harness/reviews/records/${pointer.id}.json`);
    if (record?.version !== 2 || record.id !== pointer.id || record.plan !== plan.path || !record.adaptive?.independentReview || !Array.isArray(record.results)) return [];
    const { id, recordedAt, ...value } = record;
    if (reviewHash(value) !== id) return [];
    const packet = nativeReviewPacketBinding({ ...options, packetId: record.packet });
    if (!packet.current || reviewHash(packet.binding.scope) !== reviewHash(record.scope)) return [];
    const uses = new Map();
    for (const result of record.results.slice(0, 32)) {
      if (result.status !== 'completed') continue;
      const provider = packet.providers.find(item => item.perspective === result.reviewer);
      if (!provider || uses.has(provider.name)) continue;
      const observed = validateReviewObservation({ ...options, packetId: record.packet, result: result.raw, provider, sessionId: session.sessionId });
      if (!observed.valid) continue;
      const resource = resolveCapability({ ...options, kind: 'agent', id: provider.name });
      if (!resource?.included || !resource.current || !resource.invocable || resource.path !== provider.path || resource.digest !== provider.digest) continue;
      uses.set(provider.name, { kind: 'agent', name: provider.name, path: resource.path, sha256: resource.digest.slice(7), policyRevision: consent.policyRevision,
        reviewUse: { schema: 1, observationId: observed.observationId, packet: record.packet, sessionId: session.sessionId, plan: plan.path, workspace: fs.realpathSync.native(options.workspace) },
        loadedSourceHash: 'unverified', assurance: 'Native review adapter event; host loaded definition hash unverified; task outcome does not prove causal effectiveness' });
      if (uses.size >= 16) break;
    }
    return [...uses.values()];
  } catch { return []; } // Attribution cannot infer consultation from unreadable evidence.
}

/** Preserve actual loaded resource versions without accepting authored provenance fields. */
export function loadedResourceUses({ workspace, copilotHome, home, skillsHome, host, plan } = {}) {
  const session = readSession(workspace);
  if (!session?.sessionId) return [];
  const options = capabilityOptions({ workspace, copilotHome, home, skillsHome, host });
  const agents = reviewedAgentUses({ ...options, plan }, session);
  const skills = Object.entries(session.activatedSkills || {}).slice(0, 32)
    .filter(([name, activation]) => activation.complete === true && activation.sessionId === session.sessionId
      && currentSkillActivation(activation, name, options))
    .map(([name, activation]) => ({ kind: 'skill', name, path: path.resolve(activation.source.path),
      sha256: activation.source.sha256, assurance: 'source-loaded; task outcome does not prove causal effectiveness' }));
  return [...skills.slice(0, 32 - agents.length), ...agents];
}
