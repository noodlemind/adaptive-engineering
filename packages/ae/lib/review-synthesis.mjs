import path from 'node:path';
import { readFileNoFollow } from './fs-safe.mjs';
import { compareText, readReviewFile, reviewHash, stableJson } from './review-preparation.mjs';

const severityRank = { P1: 0, P2: 1, P3: 2 };
const actionRank = { manual: 0, gated_auto: 1, advisory: 2, safe_auto: 3 };
const unique = values => [...new Set(values)].sort(compareText);
const normalizedTitle = title => title.trim().replace(/\s+/g, ' ').toLowerCase();
const normalizedClaim = text => text.trim().replace(/\s+/g, ' ');
export const findingIdentity = finding => reviewHash({ file: finding.file, line: finding.line, title: normalizedTitle(finding.title), description: normalizedClaim(finding.description), suggested_fix: normalizedClaim(finding.suggested_fix) });
const findingOrder = (a, b) => severityRank[a.severity] - severityRank[b.severity] || b.confidence - a.confidence || compareText(a.file, b.file) || a.line - b.line || compareText(a.title, b.title) || compareText(stableJson(a), stableJson(b));

export function normalizeFinding(workspace, finding, sourceRefs = [], selectedOnly = false) {
  const errors = [];
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return { errors: ['Finding must be an object'] };
  const raw = typeof finding.file === 'string' ? finding.file.replace(/\\/g, '/') : '';
  const externalPlan = sourceRefs.find(ref => ref.origin === 'project-plan' && ref.path === raw);
  if (!raw || (!externalPlan && (path.posix.isAbsolute(raw) || /^[A-Za-z]:/.test(raw))) || raw.split('/').includes('..') || /[\0\r\n]/.test(raw)) errors.push('Invalid finding file');
  const file = externalPlan ? raw : path.posix.normalize(raw);
  const selectedRef = externalPlan || sourceRefs.find(ref => ref.origin === 'product' && ref.path === file);
  if (selectedOnly && !selectedRef) errors.push('Finding file is outside the selected document scope');
  const text = errors.length ? null : selectedOnly ? readReviewFile(workspace, selectedRef, { maxBytes: 1024 * 1024 }) : externalPlan ? readReviewFile(workspace, externalPlan, { maxBytes: 1024 * 1024 }) : readFileNoFollow(path.join(workspace, file), { root: workspace, maxBytes: 1024 * 1024 });
  if (text === null || !Number.isInteger(finding.line) || finding.line < 1 || finding.line > text.split(/\r?\n/).length) errors.push('Finding location is missing, unreadable, or outside the file');
  if (!['P1', 'P2', 'P3'].includes(finding.severity)) errors.push('Invalid severity');
  if (!Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) errors.push('Invalid confidence');
  for (const key of ['title', 'description', 'suggested_fix']) if (typeof finding[key] !== 'string' || !finding[key].trim()) errors.push(`Missing ${key}`);
  if (!Object.hasOwn(actionRank, finding.autofix_class)) errors.push('Invalid action routing');
  if (!Array.isArray(finding.evidence) || !finding.evidence.length || !finding.evidence.every(s => typeof s === 'string' && s.trim())) errors.push('Missing finding evidence');
  if (errors.length) return { errors };
  const value = { ...finding, file, title: finding.title.trim(), evidence: unique(finding.evidence) };
  return { errors, value: { ...value, id: findingIdentity(value) } };
}

function aggregate(group) {
  const ordered = group.toSorted(findingOrder), first = ordered[0];
  const reviewers = unique(group.map(f => f.reviewer));
  const originalConfidences = group.map(f => f.confidence).sort((a, b) => a - b);
  const original = Math.max(...originalConfidences), boost = reviewers.length > 1 ? 0.10 : 0;
  const separate = group.every(f => f.invocation === 'separate-reviewer');
  const rejected = group.some(f => f.invocation === 'rejected');
  const independence = separate ? 'separate-reviewer' : rejected ? 'rejected' : 'unverified';
  const base = { ...first };
  delete base.invocation;
  return { ...base, confidence: Math.min(1, Math.round((original + boost) * 1000000) / 1000000), originalConfidences, confidenceTransformation: { policy: 'perspective-agreement-v1', original, boost, independence }, reviewers, evidence: unique(group.flatMap(f => f.evidence)), autofix_class: group.map(f => f.autofix_class).sort((a, b) => actionRank[a] - actionRank[b])[0], provenance: independence === 'separate-reviewer' ? { kind: 'host-invocation', note: 'Recorded invocation names a separate reviewer' } : { kind: 'unknown', note: 'Reviewer identity and independence are host responsibilities' } };
}

const SEPARATE_CALLERS = new Set(['engineer', 'code-review-coordinator']);

function invocationEvidence(result, providerName = result?.reviewer) {
  const declared = result?.provenance;
  const record = declared && typeof declared === 'object' && !Array.isArray(declared) ? declared : null;
  const agent = typeof record?.agent === 'string' ? record.agent : '';
  const via = typeof record?.via === 'string' ? record.via : '';
  if (record?.kind === 'same-context' || agent === 'engineer' || result?.reviewer === 'engineer') {
    return { kind: 'rejected-self-review', independence: 'rejected', declared: declared ?? null };
  }
  if (record?.kind === 'host-invocation' && agent && agent === providerName && SEPARATE_CALLERS.has(via)) {
    return { kind: 'host-invocation', independence: 'separate-reviewer', agent, via, declared };
  }
  return { kind: 'unverified-declaration', independence: 'unverified', declared: declared ?? null };
}

function mergedPartitions(ids, decisions) {
  const parent = new Map(ids.map(id => [id, id]));
  const representative = id => { while (parent.get(id) !== id) id = parent.get(id); return id; };
  for (const decision of decisions.filter(d => d.action === 'merge')) for (const id of decision.resolvedMembers.slice(1)) parent.set(representative(id), representative(decision.resolvedMembers[0]));
  const groups = new Map();
  for (const id of ids) { const root = representative(id); groups.set(root, [...(groups.get(root) || []), id]); }
  return { representative, groups: [...groups.values()].map(group => group.sort(compareText)) };
}

export function synthesizeReview(workspace, required, input, preparationFailures = [], sourceRefs = [], selectedOnly = false, { requireIndependent = false, providers = [], observationFor } = {}) {
  const results = [], failures = preparationFailures.map(message => ({ reviewer: null, errors: [message] })), suppressed = [], accepted = [];
  for (const result of input.results) {
    const errors = [];
    if (!required.includes(result?.reviewer)) errors.push('Unexpected reviewer');
    if (result?.status !== 'completed') errors.push(`Reviewer did not complete: ${result?.status || 'unknown'}`);
    if (!Array.isArray(result?.findings)) errors.push('Missing findings array');
    for (const field of ['residual_risks', 'testing_gaps']) if (!Array.isArray(result?.[field]) || !result[field].every(s => typeof s === 'string')) errors.push(`Invalid ${field}`);
    const normalized = [];
    if (Array.isArray(result?.findings)) for (const finding of result.findings) {
      const parsed = normalizeFinding(workspace, finding, sourceRefs, selectedOnly);
      errors.push(...parsed.errors);
      if (parsed.value) normalized.push({ ...parsed.value, reviewer: result.reviewer });
    }
    const raw = result && typeof result === 'object' ? { ...result, ...(Array.isArray(result.findings) ? { findings: result.findings.toSorted((a, b) => compareText(stableJson(a), stableJson(b))) } : {}) } : result;
    const provider = providers.find(value => value.perspective === result?.reviewer);
    let provenance = invocationEvidence(result, provider?.name || result?.reviewer);
    if (requireIndependent && provenance.independence !== 'rejected') {
      let observation;
      try { observation = observationFor?.(result, provider); } catch (error) { observation = { valid: false, reason: error.message }; }
      provenance = observation?.valid
        ? { kind: 'observed-native-invocation', independence: 'separate-reviewer', agent: provider.name, sessionId: observation.sessionId,
          observationId: observation.observationId, assurance: observation.assurance }
        : { kind: 'unverified-declaration', independence: 'unverified', declared: result?.provenance ?? null,
          reason: observation?.reason || 'No matching current native reviewer observation' };
    }
    if (requireIndependent && provenance.independence !== 'separate-reviewer') errors.push('Required independent specialist invocation is missing or rejected');
    results.push({ reviewer: result?.reviewer || null, status: errors.length ? 'invalid' : 'completed', provenance, raw, errors: unique(errors) });
    if (errors.length) failures.push({ reviewer: result?.reviewer || null, errors: unique(errors) });
    else for (const finding of normalized) {
      const recorded = { ...finding, invocation: provenance.independence };
      if (finding.confidence >= (finding.severity === 'P1' ? 0.50 : 0.60)) accepted.push(recorded);
      else suppressed.push({ ...recorded, reason: 'Below confidence floor before aggregation' });
    }
  }
  const groups = new Map();
  for (const finding of accepted) { const group = groups.get(finding.id) || []; group.push(finding); groups.set(finding.id, group); }
  let findings = [...groups.values()].map(aggregate).sort(findingOrder);
  const originalOverlaps = [];
  for (let i = 0; i < findings.length; i++) for (let j = i + 1; j < findings.length; j++) {
    const a = findings[i], b = findings[j];
    if (a.file === b.file && Math.abs(a.line - b.line) <= 3 && normalizedTitle(a.title) === normalizedTitle(b.title)) originalOverlaps.push({ members: [a.id, b.id].sort(compareText), reason: 'Related locations or titles need semantic adjudication' });
  }
  const adjudications = [], aliases = new Map(findings.map(f => [f.id, [f.id]]));
  if (input.adjudications !== undefined && !Array.isArray(input.adjudications)) failures.push({ reviewer: null, errors: ['Adjudications must be an array'] });
  const pending = Array.isArray(input.adjudications) ? input.adjudications.toSorted((a, b) => compareText(stableJson(a), stableJson(b))) : [];
  while (pending.length) {
    let progress = false;
    for (let index = 0; index < pending.length;) {
      const decision = pending[index];
      if (!['merge', 'retain'].includes(decision?.action) || typeof decision?.rationale !== 'string' || !decision.rationale.trim() || !Array.isArray(decision.members) || decision.members.length < 2 || !decision.members.every(id => typeof id === 'string')) {
        failures.push({ reviewer: null, errors: ['Invalid review adjudication'] }); pending.splice(index, 1); progress = true; continue;
      }
      if (!decision.members.every(id => aliases.has(id))) { index++; continue; }
      const ids = unique(decision.members.flatMap(id => aliases.get(id)));
      if (ids.length < 2) failures.push({ reviewer: null, errors: ['Adjudication needs distinct members'] });
      else {
        adjudications.push({ ...decision, members: unique(decision.members), resolvedMembers: ids, memberGroups: unique(decision.members).map(id => aliases.get(id)), provenance: 'Agent-supplied judgment; no invocation authority granted' });
        if (decision.action === 'merge') aliases.set(reviewHash({ adjudicatedMembers: ids }), ids);
      }
      pending.splice(index, 1); progress = true;
    }
    if (!progress) { failures.push({ reviewer: null, errors: ['Adjudication references missing findings or a missing prior merge'] }); break; }
    for (const ids of mergedPartitions([...groups.keys()], adjudications).groups) if (ids.length > 1) aliases.set(reviewHash({ adjudicatedMembers: ids }), ids);
  }
  const partitions = mergedPartitions([...groups.keys()], adjudications);
  const retained = new Set();
  let conflict = false;
  for (const decision of adjudications.filter(d => d.action === 'retain')) for (let i = 0; i < decision.memberGroups.length; i++) for (let j = i + 1; j < decision.memberGroups.length; j++) for (const a of decision.memberGroups[i]) for (const b of decision.memberGroups[j]) {
    if (partitions.representative(a) === partitions.representative(b)) conflict = true;
    retained.add(stableJson([a, b].sort(compareText)));
  }
  const surviving = new Map(findings.map(f => [f.id, f.id]));
  if (conflict) failures.push({ reviewer: null, errors: ['Conflicting merge and retain adjudications'] });
  else {
    findings = partitions.groups.map(ids => {
      const sorted = ids.sort(compareText), merged = aggregate(sorted.flatMap(id => groups.get(id)));
      if (sorted.length > 1) { merged.id = reviewHash({ adjudicatedMembers: sorted }); merged.adjudicatedMembers = sorted; }
      sorted.forEach(id => surviving.set(id, merged.id));
      return merged;
    }).sort(findingOrder);
  }
  const unresolved = new Map();
  for (const overlap of originalOverlaps) {
    if (!conflict && retained.has(stableJson(overlap.members))) continue;
    const members = unique(overlap.members.map(id => surviving.get(id)));
    if (members.length < 2) continue;
    unresolved.set(stableJson(members), { ...overlap, members });
  }
  const overlaps = [...unresolved.values()];
  const missing = required.filter(id => results.filter(r => r.reviewer === id && r.status === 'completed').length !== 1);
  const complete = missing.length === 0 && failures.length === 0;
  const risks = unique(results.flatMap(r => Array.isArray(r.raw?.residual_risks) ? r.raw.residual_risks.filter(s => typeof s === 'string') : []));
  const gaps = unique(results.flatMap(r => Array.isArray(r.raw?.testing_gaps) ? r.raw.testing_gaps.filter(s => typeof s === 'string') : []));
  return { results: results.sort((a, b) => compareText(stableJson(a), stableJson(b))), findings, suppressed: suppressed.sort(findingOrder), overlaps: overlaps.sort((a, b) => compareText(stableJson(a), stableJson(b))), adjudications: adjudications.sort((a, b) => compareText(stableJson(a), stableJson(b))), failures: failures.sort((a, b) => compareText(stableJson(a), stableJson(b))), coverage: { complete, missing, collected: results.filter(r => r.status === 'completed').length, expected: required.length }, residual_risks: risks, testing_gaps: gaps, counts: { P1: findings.filter(f => f.severity === 'P1').length, P2: findings.filter(f => f.severity === 'P2').length, P3: findings.filter(f => f.severity === 'P3').length, suppressed: suppressed.length, failures: failures.length }, status: complete ? 'ok' : 'blocked' };
}

export function renderReview(record, maxBytes = 16384) {
  const escape = text => String(text).replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').replace(/`/g, "'");
  const recorded = Array.isArray(record.results) ? record.results : [];
  const identity = recorded.length && recorded.every(result => result.provenance?.independence === 'separate-reviewer')
    ? 'Recorded invocations name a separate reviewer.'
    : recorded.some(result => result.provenance?.independence === 'rejected')
      ? 'An engineer self-review is not an independent review.'
      : 'Reviewer identities and independence are unverified.';
  const lines = [`# ${record.kind === 'document' ? 'Document' : 'Code'} Review`, '', `Coverage: ${record.coverage.complete ? 'Complete' : 'Incomplete'} (${record.coverage.collected}/${record.coverage.expected} valid results).`, `Findings: ${record.counts.P1} P1, ${record.counts.P2} P2, ${record.counts.P3} P3. Suppressed: ${record.counts.suppressed}. Failures: ${record.counts.failures}.`, '', `${identity} Action classes do not grant permissions.`, '', '| File | Issue | Severity | Perspectives | Confidence | Route |', '|---|---|---|---|---|---|'];
  let omitted = 0;
  for (const f of record.findings) {
    const line = `| ${escape(f.file)}:${f.line} | ${escape(f.title)} | ${f.severity} | ${f.reviewers.map(escape).join(', ')} | ${f.confidence.toFixed(2)} | ${f.autofix_class} |`;
    if (Buffer.byteLength(lines.join('\n') + line) + 512 > maxBytes) omitted++; else lines.push(line);
  }
  lines.push('', `Missing results: ${record.coverage.missing.join(', ') || 'none'}.`, `Omitted finding rows: ${omitted}. Full results: ${record.recordPath}.`);
  return { text: lines.join('\n'), omittedRows: omitted };
}
