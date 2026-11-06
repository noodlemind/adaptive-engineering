import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { assertNoSymlinkAncestors, readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { solutionsScanRoots, solutionsWriteTarget, projectStoreDir } from './project-layout.mjs';
import { recordHash } from './review.mjs';
import { verifyRetainedReviewUse } from './native-specialist-observation.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const HEX = /^[a-f0-9]{64}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const normalized = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();

function entries(base, relative, filter, limit, diagnostics, omitted, kind) {
  const full = assertNoSymlinkAncestors(base, relative);
  if (!full) { diagnostics.push({ path: relative, reason: 'recurrence source directory is redirected' }); return []; }
  let directory;
  try { directory = fs.opendirSync(full); } catch (error) { if (error.code !== 'ENOENT') diagnostics.push({ path: relative, reason: 'recurrence source directory is unreadable' }); return []; }
  const selected = []; let visited = 0;
  try {
    for (let entry; (entry = directory.readSync());) {
      if (++visited > limit * 4 + 64) { omitted[kind]++; break; }
      if (!filter(entry)) continue;
      if (selected.length >= limit) { omitted[kind]++; break; }
      selected.push(entry.name);
    }
  } finally { directory.closeSync(); }
  return selected.sort();
}

function read(base, relative, budget) {
  if (budget.bytes >= budget.max) return null;
  if (!assertNoSymlinkAncestors(base, relative)) return null;
  const text = readFileNoFollow(path.join(base, relative), { root: base, maxBytes: Math.min(262144, budget.max - budget.bytes) });
  budget.bytes += Buffer.byteLength(text || '');
  return text;
}

function historicalProof(evidence) {
  if (!object(evidence) || ![5, 6, 7].includes(evidence.version) || evidence.outcome !== 'passed' || typeof evidence.plan !== 'string' || !object(evidence.binding) || !Array.isArray(evidence.checks)) return null;
  if (!evidence.checks.some(check => check.status === 'passed' && check.proof === 'behavior') || !evidence.checks.some(check => check.id === 'criteria-evidence' && check.status === 'passed') || evidence.checks.some(check => !['passed', 'skipped'].includes(check.status) && check.severity !== 'advisory')) return null;
  const review = evidence.checks.find(check => check.id === 'required-reviews')?.record || null;
  return recordHash({ version: evidence.version, plan: evidence.plan, binding: evidence.binding, outcome: evidence.outcome, checks: evidence.checks.map(check => ({ id: check.id, status: check.status, proof: check.proof || null })), review });
}

function validLearning(record, operation, proof) {
  if (!object(record) || record.version !== 1 || record.operation !== operation || record.state !== 'done' || !record.result?.pass || !record.result?.indexed || record.result.publicationVersion !== 1 || record.decision?.decision !== 'publish' || ![undefined, 'private'].includes(record.decision.scope) || recordHash(record.decision.operation) !== operation || typeof record.decision.rationale !== 'string' || !record.decision.rationale.trim()) return false;
  if (!object(record.proof) || record.proof.verificationIdentity !== proof.identity || record.proof.plan !== proof.evidence.plan || record.proof.evidencePath !== proof.evidence.evidencePath || (record.proof.review || null) !== (proof.evidence.checks.find(check => check.id === 'required-reviews')?.record || null) || JSON.stringify(record.proof.binding) !== JSON.stringify(proof.evidence.binding)) return false;
  return record.digest === recordHash({ decision: record.decision, proof: record.proof.verificationIdentity, ...(record.destination ? { destination: record.destination } : {}) });
}

function usesOf(fm) {
  let uses = fm.resource_uses;
  if (typeof uses === 'string') { try { uses = JSON.parse(uses); } catch { return []; } }
  if (!Array.isArray(uses) || uses.length > 32) return [];
  return uses.flatMap(use => {
    const sha256 = use?.sha256 || use?.digest?.replace(/^sha256-/, '');
    const name = use?.name || use?.id;
    if (!object(use) || !['skill', 'agent', 'instruction'].includes(use.kind) || typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || typeof use.path !== 'string' || !path.isAbsolute(use.path) || use.path.length > 1024 || !HEX.test(sha256 || '')) return [];
    return [{ kind: use.kind, name, path: use.path, sha256, ...(HEX.test(use.policyRevision || '') ? { policyRevision: use.policyRevision } : {}), ...(use.kind === 'agent' ? { reviewUse: use.reviewUse } : {}) }];
  });
}

function group(map, identity, observation, detail) {
  const row = map.get(identity) || { identity, detail, observations: new Map() };
  // A new publication or verification of the same plan is not another task use.
  if (!row.observations.has(observation.plan)) row.observations.set(observation.plan, observation);
  map.set(identity, row);
}

function rows(map, recurrence) {
  return [...map.values()].filter(row => row.observations.size > 1).map(row => {
    const observations = [...row.observations.values()];
    const selected = observations.slice(0, 4);
    const evidence = [...new Map(selected.flatMap(item => item.evidence).map(ref => [`${ref.base || ''}:${ref.path}@${ref.sha256}`, ref])).values()];
    const value = { identity: row.identity, recurrence, count: observations.length, detail: row.detail, tasks: selected.map(item => ({ plan: item.plan, proofIdentity: item.proofIdentity, ...(item.nativeReview ? { nativeReview: item.nativeReview } : {}) })), evidence, omittedTasks: observations.length - selected.length, recommendation: 'reuse-or-improve', verifiedTaskEvidence: true, causalEffectiveness: 'unassessed' };
    return { ...value, id: recordHash(value) };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/** Historical passed work supports a recommendation; it does not certify a resource's causal effectiveness. */
export function verifiedEpisodeRecurrence({ workspace, home, maxRecords = 256, maxEpisodes = 512 } = {}) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 1024 || !Number.isSafeInteger(maxEpisodes) || maxEpisodes < 1 || maxEpisodes > 2048) throw new Error('Recurrence history limits are invalid');
  const diagnostics = [], omitted = { records: 0, episodes: 0, categories: 0, bytes: 0 };
  const budget = { bytes: 0, max: 8 * 1024 * 1024 }, proofs = new Map(), publications = new Map();
  const proofRoots = [{ base: path.resolve(workspace), source: 'workspace' }, { base: projectStoreDir(workspace, { home }), source: 'user' }];
  for (const proofRoot of proofRoots) for (const name of entries(proofRoot.base, '.harness/evidence/history', entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name), maxRecords, diagnostics, omitted, 'records')) {
    const relative = `.harness/evidence/history/${name}`, text = read(proofRoot.base, relative, budget);
    if (text === null) { diagnostics.push({ path: relative, reason: 'historical verification evidence is unsafe, unreadable or over budget' }); continue; }
    let evidence; try { evidence = JSON.parse(text); } catch { continue; }
    const identity = historicalProof(evidence);
    if (!identity || hash(JSON.stringify(evidence)) !== name.slice(0, -5)) continue;
    proofs.set(identity, { identity, evidence, ref: { source: proofRoot.source, ...(proofRoot.source === 'user' ? { base: proofRoot.base } : {}), path: relative, sha256: hash(text) } });
  }
  for (const proofRoot of proofRoots) for (const name of entries(proofRoot.base, '.harness/learning', entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name), maxRecords, diagnostics, omitted, 'records')) {
    const relative = `.harness/learning/${name}`, text = read(proofRoot.base, relative, budget);
    if (text === null) { diagnostics.push({ path: relative, reason: 'learning publication receipt is unsafe, unreadable or over budget' }); continue; }
    let record; try { record = JSON.parse(text); } catch { continue; }
    const proof = proofs.get(record?.proof?.verificationIdentity);
    if (!proof || !validLearning(record, name.slice(0, -5), proof)) continue;
    const publishedPath = record.result.publishedPath;
    if (typeof publishedPath !== 'string' || !path.isAbsolute(publishedPath)) continue;
    publications.set(`${publishedPath}@${record.result.publishedHash}`, { record, proof, ref: { source: proofRoot.source, ...(proofRoot.source === 'user' ? { base: proofRoot.base } : {}), path: relative, sha256: hash(text) } });
  }
  const claims = new Map(), resources = new Map(); let scanned = 0;
  for (const root of solutionsScanRoots(workspace, { home })) {
    const directoryRelative = path.relative(root.base, root.dir);
    for (const category of entries(root.base, directoryRelative, entry => entry.isDirectory(), 64, diagnostics, omitted, 'categories')) {
      const categoryRelative = path.join(directoryRelative, category);
      for (const name of entries(root.base, categoryRelative, entry => entry.isFile() && entry.name.endsWith('.md'), Math.max(1, maxEpisodes - scanned), diagnostics, omitted, 'episodes')) {
        if (scanned++ >= maxEpisodes) { omitted.episodes++; break; }
        const relative = path.join(categoryRelative, name).replaceAll('\\', '/'), full = path.resolve(root.base, relative), text = read(root.base, relative, budget);
        if (text === null) { diagnostics.push({ path: relative, reason: 'episode is unsafe, unreadable or over budget' }); continue; }
        let fm; try { fm = YAML.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || '', { maxAliasCount: 20 }); } catch { continue; }
        if (!object(fm) || fm.kind !== 'fix') continue;
        const publication = publications.get(`${full}@${recordHash(text)}`);
        if (!publication || fm.proof_identity !== publication.proof.identity || fm.work_contract !== publication.record.proof.binding.planDigest || publication.record.destination && (path.resolve(publication.record.destination.base) !== path.resolve(root.base) || !relative.startsWith(`${publication.record.destination.dirRel}/`))) {
          diagnostics.push({ path: relative, reason: 'fix episode lacks matching passed historical proof and current publication receipt' }); continue;
        }
        const episode = { source: root.kind === 'user' ? 'user' : 'workspace', ...(root.kind === 'user' ? { base: root.base } : {}), path: relative, sha256: hash(text) };
        const observation = { plan: publication.record.proof.plan, proofIdentity: publication.proof.identity, evidence: [episode, publication.ref, publication.proof.ref] };
        if (typeof fm.claim === 'string' && fm.claim.trim() && fm.claim.length <= 1024) group(claims, `claim:${hash(normalized(fm.claim))}`, observation, { kind: 'verified-private-claim', claim: fm.claim.trim() });
        for (const use of usesOf(fm)) {
          const { policyRevision, reviewUse, ...resource } = use;
          let nativeReview;
          if (resource.kind === 'agent') {
            if (!object(reviewUse) || reviewUse.schema !== 1 || reviewUse.plan !== observation.plan) {
              diagnostics.push({ path: relative, reason: 'agent resource use lacks an actual task-bound native consultation' }); continue;
            }
            const retained = verifyRetainedReviewUse({ home, workspace: reviewUse.workspace, observationId: reviewUse.observationId,
              packetId: reviewUse.packet, sessionId: reviewUse.sessionId, plan: observation.plan, name: resource.name, path: resource.path, sha256: resource.sha256, policyRevision });
            if (!retained.valid) { diagnostics.push({ path: relative, reason: `agent consultation evidence is invalid: ${retained.reason}` }); continue; }
            nativeReview = { ...reviewUse, policyRevision: retained.policyRevision, loadedSourceHash: 'unverified' };
          }
          // Consent revisions and observation IDs bind each use, not the source
          // version's recurrence identity across distinct verified tasks.
          group(resources, `resource:${recordHash(resource)}`, { ...observation, ...(nativeReview ? { nativeReview } : {}) }, { kind: 'resource-use', resource });
        }
      }
      if (scanned >= maxEpisodes) break;
    }
    if (scanned >= maxEpisodes) break;
  }
  if (budget.bytes >= budget.max) omitted.bytes = 1;
  return { claimRecurrence: rows(claims, 'verified-private-claim'), resourceUseRecurrence: rows(resources, 'verified-task-resource-use'), diagnostics: diagnostics.slice(0, 100), omitted, scanned, assurance: 'Local immutable verification history and exact publication bytes; historical source currentness and causal usefulness require separate assessment' };
}

/** Keep exact publication proof with private episodes when a disposable worktree is removed. */
export function retainVerifiedPublication({ workspace, home, record }) {
  if (record?.decision?.decision !== 'publish' || ![undefined, 'private'].includes(record.decision.scope)) return { retained: false, reason: 'Only private verified publications retain recurrence proof' };
  if (!HEX.test(record.operation || '')) throw new Error('Publication proof operation is invalid');
  const budget = { bytes: 0, max: 1024 * 1024 }, recordRelative = `.harness/learning/${record.operation}.json`;
  const recordedText = read(workspace, recordRelative, budget);
  let current; try { current = JSON.parse(recordedText); } catch { throw new Error('Current publication receipt is absent or unreadable'); }
  if (recordHash(current) !== recordHash(record)) throw new Error('Publication receipt changed before proof retention');
  const evidenceRelative = record.proof?.evidencePath;
  if (typeof evidenceRelative !== 'string' || !evidenceRelative.startsWith('.harness/evidence/') || evidenceRelative.split(/[\\/]/).includes('..')) throw new Error('Publication verification source is invalid');
  const evidenceText = read(workspace, evidenceRelative, budget);
  let evidence; try { evidence = JSON.parse(evidenceText); } catch { throw new Error('Publication verification source is unreadable'); }
  const identity = historicalProof(evidence), historyRelative = `.harness/evidence/history/${hash(JSON.stringify(evidence))}.json`;
  const historyText = read(workspace, historyRelative, budget);
  if (!identity || identity !== record.proof.verificationIdentity || historyText === null || !validLearning(record, record.operation, { identity, evidence })) throw new Error('Publication has no matching passed immutable verification history');
  let history; try { history = JSON.parse(historyText); } catch { throw new Error('Publication verification history is damaged'); }
  if (JSON.stringify(history) !== JSON.stringify(evidence)) throw new Error('Publication verification history changed');
  const target = solutionsWriteTarget(workspace, { home });
  if (record.destination && (path.resolve(record.destination.base) !== path.resolve(target.base) || record.destination.dirRel !== target.dirRel)) throw new Error('Publication destination does not match the selected private project store');
  const relative = record.result?.path;
  if (typeof relative !== 'string' || !relative.startsWith(`${target.dirRel}/`) || relative.split(/[\\/]/).includes('..') || record.result.publishedPath !== path.resolve(target.base, relative)) throw new Error('Publication episode source is invalid');
  const episodeText = read(target.base, relative, budget);
  if (episodeText === null || recordHash(episodeText) !== record.result.publishedHash) throw new Error('Publication episode bytes changed before proof retention');
  for (const [relative, text] of [[historyRelative, historyText], [recordRelative, recordedText]]) {
    const prior = readFileNoFollow(path.join(target.base, relative), { root: target.base, maxBytes: 262144 });
    if (prior === text) continue;
    if (prior !== null || fs.lstatSync(path.join(target.base, relative), { throwIfNoEntry: false })) throw new Error('Retained publication proof conflicts with existing bytes');
    if (!writeFileContained(target.base, relative, text, { exclusive: true, mode: 0o600 }) && readFileNoFollow(path.join(target.base, relative), { root: target.base, maxBytes: 262144 }) !== text) throw new Error('Publication proof retention was refused');
  }
  return { retained: true, base: target.base, learning: recordRelative, verification: historyRelative, verificationIdentity: identity };
}
