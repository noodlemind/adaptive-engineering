import crypto from 'node:crypto';
import { captureWorkingSources } from './repo-map/working-sources.mjs';
import { inspectSourceFile } from './repo-map/scan.mjs';
import { MAX_FILES_SCANNED, MAX_FILE_BYTES } from './repo-map/scan.mjs';
import { planDigest } from './evidence.mjs';
import { worktreeId } from './structural/shape.mjs';
import { loadPlan } from './plan-parse.mjs';
import { accountContext } from './token-meter.mjs';
import { policyDigest } from './trust.mjs';
import { DEFAULT_MAX_BYTES } from './fs-safe.mjs';

const EVIDENCE_LIMIT = 80;
const MAX_RECORD_BYTES = 32768;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function buildContextRecord({ workspace, flags = {}, query = '', facts }) {
  const snapshot = facts.sourceSnapshot || captureWorkingSources(workspace);
  const neighborhood = facts.slice.neighborhood;
  const inputs = new Map((neighborhood?.inputs || facts.namedFiles.map(rel => ({ rel }))).map(input => [input.rel, input]));
  const impactSources = facts.slice.impactContext?.sources || [];
  const paths = [...new Set([...inputs.keys(), ...(neighborhood?.files || []).map(file => file.rel), ...impactSources.map(source => source.location)])];
  const evidence = paths.slice(0, EVIDENCE_LIMIT).map((location) => {
    const input = inputs.get(location)?.state === 'excluded' ? { state: 'excluded' } : inspectSourceFile(workspace, location, { maxBytes: DEFAULT_MAX_BYTES });
    return {
      source: 'code', location, state: input.state,
      sha256: input.hash || null, bytes: input.size ?? null,
      reason: inputs.has(location) ? 'declared task file' : 'import neighborhood',
      reference: input.hash ? `${location}@sha256:${input.hash}` : null,
    };
  });
  const identity = {
    schema: 'harness.context.v2',
    worktree: worktreeId(workspace),
    task: { plan: facts.active?.path || null, contractDigest: facts.active ? planDigest(facts.active.text) : null },
    selection: { queryHash: digest(facts.query ?? query), files: facts.namedFiles },
    sourceState: snapshot.state || null,
    policyDigest: facts.slice.trust.digest || null,
    evidence,
  };
  const after = captureWorkingSources(workspace);
  const factHashes = new Map([
    ...(facts.slice.neighborhood?.files || []).filter(file => file.sha256).map(file => [file.rel, file.sha256]),
    ...impactSources.map(source => [source.location, source.sha256]),
  ]);
  const currentPlan = facts.active ? loadPlan(workspace, facts.active.path, { home: flags.harnessHome || flags.home }) : null;
  const planChanged = facts.active && (!currentPlan || planDigest(currentPlan.text) !== identity.task.contractDigest);
  const currentPolicy = policyDigest(workspace, undefined, { home: flags.harnessHome || flags.home });
  const changed = Boolean(facts.slice.impactContext?.coverage.sourceState === 'changed-or-unavailable' || planChanged || !currentPolicy || currentPolicy !== identity.policyDigest || !snapshot.valid || !after.valid || snapshot.state.digest !== after.state.digest || evidence.some((record) =>
    (record.sha256 && inspectSourceFile(workspace, record.location, { maxBytes: DEFAULT_MAX_BYTES }).hash !== record.sha256) ||
    (factHashes.has(record.location) && factHashes.get(record.location) !== record.sha256)));
  const stableFacts = { ...facts.slice, trust: { state: facts.slice.trust.state, digest: facts.slice.trust.digest } };
  const record = {
    ...identity,
    contextId: digest(JSON.stringify({ ...identity, facts: stableFacts })),
    slice: facts.slice,
    coverage: {
      sourceState: changed ? 'changed-or-unavailable' : 'validated',
      validationReason: !snapshot.valid ? snapshot.reason : !after.valid ? after.reason : changed ? 'Source, task or policy changed during assembly.' : null,
      semanticCompleteness: 'unverified',
      maxBytes: MAX_RECORD_BYTES,
      renderBarrier: false,
      failures: facts.failures,
      scan: { maxFiles: MAX_FILES_SCANNED, maxFileBytes: MAX_FILE_BYTES, total: snapshot.state?.total ?? null, truncated: snapshot.state?.truncated ?? null, resolverFiles: snapshot.state?.resolverFiles ?? null, resolverTruncated: snapshot.state?.resolverTruncated ?? null },
      evidenceOmitted: Math.max(0, paths.length - EVIDENCE_LIMIT),
      unavailable: evidence.filter((record) => record.state !== 'readable'),
      scanOmissions: snapshot.state?.omitted || [],
      limitations: ['Import relationships are heuristic and limited to one hop.', 'Unsaved editor buffers are unavailable through filesystem reads.'],
    },
    expansion: { command: 'ae orient --read --context-version 2', sourceChanged: changed },
    accounting: accountContext({ boundary: 'orientation-output', components: [{ category: 'evidence', id: 'orientation-facts', content: facts.slice }] }),
  };
  const represented = new Set(evidence.map(item => item.location));
  const omittedNewFile = neighborhood?.inputs?.some(input => input.state === 'new' && !represented.has(input.rel));
  if (!omittedNewFile && Buffer.byteLength(JSON.stringify(record)) <= MAX_RECORD_BYTES) return record;
  const barrier = {
    schema: record.schema, contextId: record.contextId, worktree: record.worktree,
    task: record.task, policyDigest: record.policyDigest,
    selection: { queryHash: identity.selection.queryHash, filesHash: digest(JSON.stringify(facts.namedFiles)), fileCount: facts.namedFiles.length },
    sourceState: snapshot.state ? { version: snapshot.state.version, digest: snapshot.state.digest, extractorRevision: snapshot.state.extractorRevision, configDigest: snapshot.state.configDigest } : null,
    evidence: [], slice: null,
    checkReadiness: facts.slice.checkReadiness ? { status: facts.slice.checkReadiness.status, ready: facts.slice.checkReadiness.ready, source: facts.slice.checkReadiness.source, sourceDigest: facts.slice.checkReadiness.sourceDigest, message: facts.slice.checkReadiness.message, inspectionCommand: facts.slice.checkReadiness.inspectionCommand, remediation: facts.slice.checkReadiness.remediation } : null,
    coverage: { sourceState: record.coverage.sourceState, validationReason: record.coverage.validationReason, semanticCompleteness: 'unverified', maxBytes: MAX_RECORD_BYTES, renderBarrier: true, evidenceOmitted: paths.length },
    expansion: { command: 'ae orient --read --context-version 2', reason: 'Read the source plan or task contract, then request a smaller explicit file batch. This response contains no partial editing context.' },
  };
  barrier.accounting = accountContext({ boundary: 'orientation-output', components: [{ category: 'evidence', id: 'orientation-barrier', content: barrier }] });
  return barrier;
}
