import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { createHash } from 'node:crypto';
import { readFileNoFollow } from './fs-safe.mjs';
import { readReviewRecord, publishReviewRecord, recordHash } from './review.mjs';
import { reviewHash } from './review-preparation.mjs';
import { withPlanUpdateLock } from './plan-update.mjs';
import { loadNamedChecks } from './checks.mjs';
import { consolidateStatus } from './knowledge/consolidate.mjs';
import { primitivePath, validatePrimitiveContent } from './resource-validation.mjs';
import { verifiedEpisodeRecurrence } from './resource-recurrence.mjs';
import { solutionsScanRoots } from './project-layout.mjs';

const fail = message => Object.assign(new Error(message), { code: 'E_USAGE', exit: 2 });
const digest = text => createHash('sha256').update(text).digest('hex');
const normalized = text => String(text).trim().replace(/\s+/g, ' ').toLowerCase();
function files(root, rel) {
  try { return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.json')).map(e => `${rel}/${e.name}`).sort(); } catch { return []; }
}
function source(root, rel) {
  const text = readFileNoFollow(path.join(root, rel), { root, maxBytes: 1024 * 1024 });
  return text === null ? null : { path: rel, sha256: digest(text) };
}
export function resourceCandidates({ workspace, copilotHome, home, dryRun = false }) {
  const exact = new Map(), suspected = new Map(), diagnostics = [];
  const verified = verifiedEpisodeRecurrence({ workspace, home });
  diagnostics.push(...verified.diagnostics);
  const observe = (map, key, observation, evidence, detail) => {
    const entry = map.get(key) || { identity: key, observations: new Map(), detail };
    if (!entry.observations.has(observation)) entry.observations.set(observation, evidence);
    map.set(key, entry);
  };
  for (const rel of files(workspace, '.harness/reviews/records')) {
    const record = readReviewRecord(workspace, rel);
    if (!record) { diagnostics.push({ path: rel, reason: 'unreadable review record' }); continue; }
    const { id, recordedAt, ...value } = record;
    if (record.version !== 2 || id !== reviewHash(value) || path.basename(rel, '.json') !== id) { diagnostics.push({ path: rel, reason: 'unsupported or damaged review identity' }); continue; }
    const evidence = { source: 'workspace', ...source(workspace, rel), record: id };
    const observation = reviewHash(record.scope);
    for (const finding of record.findings || []) {
      observe(exact, `review:${finding.id}`, observation, evidence, { kind: 'review-claim', file: finding.file, title: finding.title, independence: 'unverified' });
      const relatedKey = reviewHash({ file: finding.file, title: normalized(finding.title) });
      observe(suspected, relatedKey, `${observation}:${finding.id}`, evidence, { kind: 'related-review-title', file: finding.file, title: finding.title });
      const related = suspected.get(relatedKey);
      related.claims ||= new Set();
      related.claims.add(finding.id);
    }
  }
  for (const rel of files(workspace, '.harness/evidence/history')) {
    const record = readReviewRecord(workspace, rel);
    if (!record) { diagnostics.push({ path: rel, reason: 'unreadable verification observation' }); continue; }
    if (digest(JSON.stringify(record)) !== path.basename(rel, '.json')) { diagnostics.push({ path: rel, reason: 'damaged verification observation' }); continue; }
    if (record.outcome === 'repeated-mistake' && !record.repeatEvidence?.length) diagnostics.push({ path: rel, reason: 'legacy repeated-mistake observation has no claim identity' });
    for (const repeat of record.repeatEvidence || []) observe(exact, `mistake:${repeat.identity}`, reviewHash(record.binding), { source: 'workspace', ...source(workspace, rel), record: path.basename(rel, '.json') }, { kind: 'repeated-mistake', method: repeat.method, applicability: 'heuristic; agent must assess scope' });
  }
  const rows = [...exact.values()].filter(e => e.observations.size >= 2).map(e => ({ identity: e.identity, recurrence: 'exact-recorded-identity', count: e.observations.size, detail: e.detail, evidence: [...e.observations.values()] }));
  const related = [...suspected.values()].filter(e => e.claims.size >= 2).map(e => ({ identity: e.identity, recurrence: 'suspected-semantic', count: e.observations.size, distinctClaims: e.claims.size, detail: e.detail, evidence: [...new Map([...e.observations.values()].map(ref => [ref.path, ref])).values()] }));
  const tags = new Map(), globalRoot = path.join(copilotHome, 'knowledge');
  let categories = [];
  try { categories = fs.readdirSync(path.join(globalRoot, 'solutions'), { withFileTypes: true }).filter(e => e.isDirectory()); } catch { /* global knowledge absent */ }
  for (const category of categories) {
    let names = [];
    try { names = fs.readdirSync(path.join(globalRoot, 'solutions', category.name)).filter(n => n.endsWith('.md')); } catch { continue; }
    for (const name of names) {
      const rel = `solutions/${category.name}/${name}`, text = readFileNoFollow(path.join(globalRoot, rel), { root: globalRoot, maxBytes: 1024 * 1024 });
      if (!text) continue;
      let fm;
      try { fm = YAML.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || '', { maxAliasCount: 50 }); } catch { continue; }
      const values = Array.isArray(fm?.tags) ? fm.tags : typeof fm?.tags === 'string' ? fm.tags.split(',').map(t => t.trim()) : [];
      for (const tag of new Set(values.filter(t => typeof t === 'string' && t.trim()))) observe(tags, tag, digest(text), { source: 'copilot', path: `knowledge/${rel}`, sha256: digest(text) }, { kind: 'global-tag-cluster' });
    }
  }
  const globalTagClustering = [...tags.values()].filter(e => e.observations.size >= 3).map(e => { const value = { tag: e.identity, count: e.observations.size, evidence: [...e.observations.values()], eligibleToPropose: true, verifiedUse: false }; return { ...value, id: reviewHash(value) }; });
  const { checks, error } = loadNamedChecks(workspace);
  const existingChecks = checks ? Object.keys(checks).sort() : [];
  const candidates = [...rows, ...related, ...verified.claimRecurrence].map(e => ({ ...e, id: reviewHash(e), existingChecks, checkRelevance: 'unassessed; agent decides' })).sort((a, b) => a.id.localeCompare(b.id));
  const promotion = consolidateStatus({ workspace, copilotHome, home }).promotionCandidates || [];
  const packet = { schema: 1, verb: 'candidates', status: 'ok', candidates, resourceUseRecurrence: verified.resourceUseRecurrence, recurrenceCoverage: { omitted: verified.omitted, scanned: verified.scanned, assurance: verified.assurance }, globalTagClustering, verifiedUsePromotion: { source: 'consolidate --status', assurance: 'legacy fix/plan declarations; audit passed proof before promotion', candidates: promotion }, existingChecks, diagnostics: [...diagnostics, ...(error ? [{ path: '.github/harness/checks.yaml', reason: error }] : [])], activated: false };
  const id = reviewHash(packet), packetPath = `.harness/proposals/candidates/${id}.json`;
  if (!dryRun) publishReviewRecord(workspace, packetPath, packet);
  const bounded = { ...packet, candidates: candidates.slice(0, 100), resourceUseRecurrence: packet.resourceUseRecurrence.slice(0, 100), globalTagClustering: globalTagClustering.slice(0, 100), diagnostics: packet.diagnostics.slice(0, 100), existingChecks: existingChecks.slice(0, 100), verifiedUsePromotion: { ...packet.verifiedUsePromotion, candidates: promotion.slice(0, 100) }, omitted: { candidates: Math.max(0, candidates.length - 100), resourceUseRecurrence: Math.max(0, packet.resourceUseRecurrence.length - 100), globalTagClustering: Math.max(0, globalTagClustering.length - 100), diagnostics: Math.max(0, packet.diagnostics.length - 100), existingChecks: Math.max(0, existingChecks.length - 100), verifiedUsePromotion: Math.max(0, promotion.length - 100) }, id, packetPath, persisted: !dryRun };
  if (Buffer.byteLength(JSON.stringify(bounded)) > 65536) return { schema: 1, verb: 'candidates', status: 'ok', candidates: [], resourceUseRecurrence: [], recurrenceCoverage: packet.recurrenceCoverage, globalTagClustering: [], diagnostics: [], existingChecks: [], verifiedUsePromotion: { ...packet.verifiedUsePromotion, candidates: [] }, activated: false, omitted: { candidates: candidates.length, resourceUseRecurrence: packet.resourceUseRecurrence.length, globalTagClustering: globalTagClustering.length, diagnostics: packet.diagnostics.length, existingChecks: existingChecks.length, verifiedUsePromotion: promotion.length }, id, packetPath, persisted: !dryRun, detail: 'Rows exceed 64 KiB; retrieve the frozen packet by packetPath' };
  return bounded;
}

export function proposeResource({ workspace, copilotHome, home, input, dryRun = false }) {
  const allowed = ['schema', 'operation', 'type', 'name', 'rationale', 'text', 'evidence', 'candidatePacket', 'candidate'];
  if (input?.schema !== 1 || Object.keys(input).some(k => !allowed.includes(k)) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(input.operation || '') || typeof input.rationale !== 'string' || !input.rationale.trim()) throw fail('Proposal needs schema 1, operation, authored type/content and rationale; approval fields cannot activate it');
  const rel = primitivePath(input.type, input.name);
  if (rel) {
    const validation = validatePrimitiveContent({ type: input.type, name: input.name, text: input.text, root: copilotHome, rel });
    if (!validation.valid) throw fail(validation.errors.join('; '));
  } else if (!['check', 'test', 'cli'].includes(input.type) || typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 65536 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name || '')) throw fail('Unsupported proposal type, name or content');
  if (!Array.isArray(input.evidence || []) || (input.evidence || []).length > 100) throw fail('Evidence must be at most 100 workspace paths');
  const evidence = (input.evidence || []).map(rel => {
    if (typeof rel !== 'string') throw fail('Evidence selects a workspace path; Harness captures its bytes');
    const ref = source(workspace, rel);
    if (!ref) throw fail(`Evidence is missing or unsafe: ${rel}`);
    return { source: 'workspace', ...ref };
  });
  if (input.candidate) {
    if (!/^[a-f0-9]{64}$/.test(input.candidatePacket || '')) throw fail('Candidate requires a frozen candidate packet');
    const packet = readReviewRecord(workspace, `.harness/proposals/candidates/${input.candidatePacket}.json`);
    if (!packet || reviewHash(packet) !== input.candidatePacket) throw fail('Candidate packet is absent or damaged');
    const candidate = [...packet.candidates, ...packet.globalTagClustering, ...(packet.resourceUseRecurrence || [])].find(e => e.id === input.candidate);
    if (!candidate) throw fail('Candidate identity is absent from the packet');
    evidence.push(...candidate.evidence);
  }
  for (const ref of evidence) {
    const root = ref.source === 'copilot' ? copilotHome : ref.source === 'user' ? solutionsScanRoots(workspace, { home }).find(root => root.kind === 'user' && root.base === ref.base)?.base : workspace;
    if (!root) throw fail('Proposal episode source no longer belongs to the selected project store');
    if (source(root, ref.path)?.sha256 !== ref.sha256) throw fail('Proposal evidence changed; prepare again');
  }
  const value = { version: 1, input, evidence, activated: false, approvalPolicy: 'skills/references/human-approval-policy.md' }, id = reviewHash(value);
  const key = reviewHash(input.operation), proposalPath = `.harness/proposals/resources/${key}.json`;
  const perform = () => {
    const previous = readReviewRecord(workspace, proposalPath);
    if (!previous && fs.existsSync(path.join(workspace, proposalPath))) throw fail('Proposal receipt is unreadable; preserve it and inspect before retrying');
    if (previous && (previous.id !== id || reviewHash(previous.value) !== previous.id)) throw fail('Proposal operation conflicts with another decision or a damaged receipt');
    if (!dryRun && !previous) publishReviewRecord(workspace, proposalPath, { id, value });
    return { schema: 1, verb: 'propose', status: 'ok', id, proposalPath, activated: false, replayed: Boolean(previous), persisted: !dryRun };
  };
  if (dryRun) return perform();
  publishReviewRecord(workspace, '.harness/proposals/resources/.ready.json', { version: 1 });
  return withPlanUpdateLock(path.join(workspace, proposalPath), perform);
}
