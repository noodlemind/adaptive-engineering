import { spawnGitSync } from '../corpus/hooks/lib/git-executable.mjs';
import { projectAuthorityFile } from './project-authority.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { runNamedCheck, loadNamedChecks } from './checks.mjs';
import { validateCheckArtifacts } from './check-artifacts.mjs';
import { readFileNoFollow, assertNoSymlinkAncestors, writeFileContained } from './fs-safe.mjs';
import { isProjectTrusted } from './trust.mjs';
import { intentSourceBindings } from './intent-sources.mjs';
import { planContractText } from './work-contract.mjs';
import { gitMetadataEnvironment } from '../corpus/hooks/lib/product-diff.mjs';
import { validateExperimentContract, parseExperimentJson, validateLinearCandidate, validateLinearWorkload, experimentSafePath, experimentDigest, EXPERIMENT_MAX_INPUT_BYTES, EXPERIMENT_EVALUATOR_PATH, EXPERIMENT_ENVIRONMENT, createExperimentInvocation } from './experiment-contract.mjs';
import { probeExperimentIsolation, experimentIsolationProfile, EXPERIMENT_SANDBOX_PATH } from './experiment-isolation.mjs';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = message => { throw new Error(`Experiment measurement: ${message}`); };
const same = (first, second) => experimentDigest(first) === experimentDigest(second);
const contractDigestOf = plan => plan?.text ? experimentDigest(planContractText(plan.text)) : plan?.digest || experimentDigest(plan?.fm);

function fileBinding(workspace, rel, { json = true } = {}) {
  if (!(json ? experimentSafePath(rel) : typeof rel === 'string' && !path.isAbsolute(rel) && !/[\\\x00-\x1f]/.test(rel) && !rel.split('/').some(part => !part || part === '.' || part === '..')) || !assertNoSymlinkAncestors(workspace, rel)) fail('input path is unsafe');
  const full = path.join(workspace, rel);
  const bytes = readFileNoFollow(full, { root: workspace, maxBytes: EXPERIMENT_MAX_INPUT_BYTES, encoding: null });
  if (!bytes) fail(`input is missing, nonregular or oversized: ${rel}`);
  const mode = fs.lstatSync(full).mode & 0o7777;
  if (mode & 0o111 || mode & 0o7000) fail(`executable or special input modes are unsupported: ${rel}`);
  return { binding: { path: rel, sha256: experimentDigest(bytes), mode, bytes: bytes.length }, bytes };
}

function binaryDigest(full) {
  const canonical = fs.realpathSync(full); const fd = fs.openSync(canonical, 'r');
  try {
    if (!fs.fstatSync(fd).isFile()) fail('trusted executable is nonregular');
    const hash = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024);
    for (;;) { const count = fs.readSync(fd, buffer, 0, buffer.length, null); if (!count) return hash.digest('hex'); hash.update(buffer.subarray(0, count)); }
  } finally { fs.closeSync(fd); }
}

function trustedCheck(id, config, mode, experiment, runtime, evaluator) {
  if (!config || Object.keys(config).some(key => !['command', 'artifacts', 'timeout_seconds', 'proof', 'experiment'].includes(key)) || !same(config.command, [runtime.path, evaluator.path, mode]) || !same(config.artifacts, ['measurement.json']) || config.timeout_seconds !== experiment.budget.timeout_seconds || config.proof !== undefined && config.proof !== 'behavior' || !same(config.experiment, { version: 1, workload: 'linear-json-v1', mode })) fail(`${id} must declare the exact trusted packaged evaluator invocation and artifact`);
  return { id, config, configDigest: experimentDigest(config) };
}

export function snapshotExperimentCheckSource(workspace, options) {
  const authority = projectAuthorityFile(workspace, 'checks.yaml', options);
  const captured = fileBinding(authority.root, authority.relative.split(path.sep).join('/'), { json: false });
  if (authority.mode === 'local') captured.binding.path = authority.path;
  return captured;
}

export function snapshotExperimentInputs({ workspace, plan, copilotHome, home } = {}) {
  workspace = fs.realpathSync(workspace);
  if (process.platform !== 'darwin') fail('experiment isolation is unsupported on this host');
  if (plan?.fm?.domain_parent || plan?.fm?.domain_child || plan?.fm?.domain_binding) fail('domain experiments are unsupported');
  const experiment = validateExperimentContract(plan?.fm?.experiment, { impactedFiles: plan?.impactedFiles ?? plan?.fm?.impacted_files });
  if (!UUID.test(plan?.fm?.plan_id || '')) fail('accepted plan UUID is required');
  if (!isProjectTrusted({ workspace, copilotHome, home })) fail('selected-home project trust is required');
  const candidateRead = fileBinding(workspace, experiment.candidate);
  const candidateValue = validateLinearCandidate(parseExperimentJson(candidateRead.bytes));
  const tracked = spawnGitSync(['-c', 'core.fsmonitor=false', 'ls-files', '--error-unmatch', '--', experiment.candidate], { cwd: workspace, env: gitMetadataEnvironment(), encoding: 'utf8', timeout: 10000 });
  if (tracked.status !== 0) fail('candidate must be tracked in the accepted workspace');
  const workloadRead = fileBinding(workspace, experiment.dependencies[0]);
  validateLinearWorkload(parseExperimentJson(workloadRead.bytes), candidateValue.weights.length);
  const candidate = { ...candidateRead.binding, dimensions: candidateValue.weights.length };
  const workload = workloadRead.binding;
  const checksRead = snapshotExperimentCheckSource(workspace, { home });
  const named = loadNamedChecks(workspace, { home }); if (named.error) fail(named.error);
  const runtime = { path: fs.realpathSync(process.execPath), version: process.version, sha256: binaryDigest(process.execPath) };
  const evaluator = { path: fs.realpathSync(EXPERIMENT_EVALUATOR_PATH), sha256: binaryDigest(EXPERIMENT_EVALUATOR_PATH) };
  const checks = { score: trustedCheck(experiment.scorer_check, named.checks[experiment.scorer_check], 'score', experiment, runtime, evaluator), guard: trustedCheck(experiment.correctness_checks[0], named.checks[experiment.correctness_checks[0]], 'guard', experiment, runtime, evaluator) };
  const intent = intentSourceBindings(plan, workspace).map(entry => {
    if (!entry.path || !HASH.test(entry.accepted || '') || entry.accepted !== entry.current || entry.path === experiment.candidate) fail('locked intent is stale or editable');
    return fileBinding(workspace, entry.path, { json: false }).binding;
  });
  const frozenContract = structuredClone(experiment); delete frozenContract.budget.max_invocations; delete frozenContract.budget.max_seconds;
  const environment = { values: { ...EXPERIMENT_ENVIRONMENT }, digest: experimentDigest(EXPERIMENT_ENVIRONMENT) };
  const isolation = { platform: process.platform, arch: process.arch, osRelease: os.release(), sandbox: { path: EXPERIMENT_SANDBOX_PATH, sha256: binaryDigest(EXPERIMENT_SANDBOX_PATH) }, profileVersion: 1 };
  const frozen = { version: 1, planId: plan.fm.plan_id, experiment: frozenContract, candidate: { path: candidate.path, mode: candidate.mode, dimensions: candidate.dimensions }, workload, dependencies: [workload], checksManifest: checksRead.binding, checks, runtime, evaluator, environment, intent, isolation };
  return Object.freeze({ ...frozen, candidate, frozenDigest: experimentDigest(frozen), contractDigest: contractDigestOf(plan) });
}

export function experimentInputsCheck({ workspace, plan, accepted, copilotHome, home } = {}) {
  try {
    const frozen = accepted && { ...accepted, candidate: { path: accepted.candidate?.path, mode: accepted.candidate?.mode, dimensions: accepted.candidate?.dimensions } };
    if (frozen) { delete frozen.frozenDigest; delete frozen.contractDigest; }
    if (!accepted || !HASH.test(accepted.frozenDigest || '') || experimentDigest(frozen) !== accepted.frozenDigest) return { pass: false, message: 'Accepted frozen experiment snapshot integrity changed' };
    const current = snapshotExperimentInputs({ workspace, plan, copilotHome, home });
    if (!accepted || !HASH.test(accepted.frozenDigest || '') || accepted.planId !== current.planId || accepted.frozenDigest !== current.frozenDigest) return { pass: false, message: 'Frozen experiment evaluator, workload, intent, candidate shape or check configuration changed' };
    return { pass: true, message: 'Frozen experiment inputs are current', current };
  } catch (error) { return { pass: false, message: String(error.message).slice(0, 500) }; }
}

function candidateIdentity(workspace, accepted) {
  const { binding, bytes } = fileBinding(workspace, accepted.candidate.path);
  const candidate = validateLinearCandidate(parseExperimentJson(bytes));
  if (candidate.weights.length !== accepted.candidate.dimensions || binding.mode !== accepted.candidate.mode) fail('candidate dimensions or mode changed');
  return { descriptor: { ...binding, dimensions: candidate.weights.length }, value: candidate, identity: { version: 1, files: [binding], digest: experimentDigest([binding]) } };
}

function inputCopies(recordRoot, reservation, descriptor, accepted) {
  const directory = reservation.inputDir;
  const rel = typeof directory === 'string' ? path.relative(recordRoot, directory) : '..';
  if (!path.isAbsolute(directory || '') || !rel.startsWith(`experiments/${accepted.planId}/`) || !assertNoSymlinkAncestors(recordRoot, rel)) fail('immutable attempt input directory lacks owned authority');
  const candidateBytes = readFileNoFollow(path.join(directory, 'candidate.json'), { root: recordRoot, maxBytes: EXPERIMENT_MAX_INPUT_BYTES, encoding: null });
  const workloadBytes = readFileNoFollow(path.join(directory, 'workload.json'), { root: recordRoot, maxBytes: EXPERIMENT_MAX_INPUT_BYTES, encoding: null });
  if (!candidateBytes || !workloadBytes || experimentDigest(candidateBytes) !== descriptor.sha256 || experimentDigest(workloadBytes) !== accepted.workload.sha256) fail('immutable attempt input copies changed or are missing');
  const candidate = validateLinearCandidate(parseExperimentJson(candidateBytes)); const workload = validateLinearWorkload(parseExperimentJson(workloadBytes), descriptor.dimensions);
  return { candidate, workload, inputPaths: { candidate: path.join(directory, 'candidate.json'), workload: path.join(directory, 'workload.json') } };
}

function expectedOutcome(candidate, workload) {
  const predict = features => features.reduce((sum, value, index) => sum + value * candidate.weights[index], 0);
  const loss = workload.objective.reduce((sum, row) => sum + Math.abs(predict(row.features) - row.expected), 0) / workload.objective.length;
  const guards = workload.guards.map((row, index) => { const output = predict(row.features); return { index, output, passed: Number.isFinite(output) && output >= row.min && output <= row.max }; });
  if (!Number.isFinite(loss) || guards.some(row => !Number.isFinite(row.output))) fail('finite inputs produced an unsupported nonfinite result');
  return { metric: { name: 'mean-absolute-error', units: 'absolute-error', direction: 'minimize', value: loss, samples: [loss] }, correctness: { passed: guards.every(row => row.passed), guards } };
}

function artifactExpectation({ plan, accepted, reservation, descriptor, mode, outcome, contractDigest }) {
  return { version: 1, workload: 'linear-json-v1', mode, invocation: reservation.childIds[mode], attempt: reservation.id, planId: plan.fm.plan_id, contractDigest, frozenDigest: accepted.frozenDigest, candidate: descriptor, workloadIdentity: accepted.workload, scorerDigest: experimentDigest({ checks: accepted.checks, dependencies: accepted.dependencies }), environmentDigest: accepted.environment.digest, runtimeDigest: accepted.runtime.sha256, evaluatorDigest: accepted.evaluator.sha256, metric: outcome.metric, correctness: outcome.correctness, repetitions: 1 };
}

export function validateExperimentArtifact(raw, expected, timeoutSeconds) {
  const receipt = parseExperimentJson(raw);
  const durationMs = receipt?.durationMs;
  const withoutDuration = receipt && { ...receipt }; if (withoutDuration) delete withoutDuration.durationMs;
  if (!same(withoutDuration, expected) || typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > timeoutSeconds * 1000) fail('measurement artifact identity, finite metric, repetition, duration or correctness is inconsistent');
  return receipt;
}

export async function runExperimentMeasurement({ workspace, plan, reservation, recordRoot, copilotHome, home, signal, events, onEvent } = {}) {
  const accepted = reservation?.acceptedInputs;
  const result = { version: 1, attempt: reservation?.id, candidate: reservation?.evaluatedCandidate ?? null, acceptedInputsDigest: accepted?.frozenDigest, contractDigest: contractDigestOf(plan), checks: [], metric: null, correctness: { passed: false }, status: signal?.aborted ? 'interrupted' : 'failed', groupReaped: true };
  try {
    const live = candidateIdentity(workspace, accepted);
    result.candidate ||= live.identity;
    if (signal?.aborted) return { ...result, message: 'Experiment measurement cancelled before launch' };
    if (!UUID.test(reservation.id || '') || !UUID.test(reservation.childIds?.score || '') || !UUID.test(reservation.childIds?.guard || '') || reservation.childIds.score === reservation.childIds.guard) fail('reserved score and guard child identities are required');
    if (!Number.isSafeInteger(reservation.origin) || reservation.origin <= 0 || reservation.origin > Date.now()) fail('original reserved wall-clock origin is required');
    const boundFile = result.candidate?.files?.find(file => file.path === accepted.candidate.path);
    if (!boundFile || !same(boundFile, { path: live.descriptor.path, sha256: live.descriptor.sha256, mode: live.descriptor.mode, bytes: live.descriptor.bytes })) fail('candidate no longer matches its one-time evaluated binding');
    const inputs = experimentInputsCheck({ workspace, plan, accepted, copilotHome, home }); if (!inputs.pass) fail(inputs.message);
    const copies = inputCopies(recordRoot, reservation, live.descriptor, accepted); const outcome = expectedOutcome(copies.candidate, copies.workload);
    const probe = await probeExperimentIsolation({ runtime: accepted.runtime.path, artifactRoot: path.join(reservation.inputDir, 'probe-output'), signal });
    if (!probe.supported) fail(probe.message);
    if (probe.identity.runtimeSha256 !== accepted.runtime.sha256 || probe.identity.evaluatorSha256 !== accepted.evaluator.sha256 || probe.identity.sandboxSha256 !== accepted.isolation.sandbox.sha256 || probe.identity.environmentDigest !== accepted.environment.digest) fail('host isolation probe identity differs from its frozen evaluator binding');
    result.isolation = probe;
    for (const mode of ['score', 'guard']) {
      if (signal?.aborted) { result.status = 'interrupted'; break; }
      const check = accepted.checks[mode]; let receipt = null;
      const expected = artifactExpectation({ plan, accepted, reservation, descriptor: live.descriptor, mode, outcome, contractDigest: result.contractDigest });
      const capability = createExperimentInvocation({ workspace, name: check.id, configDigest: check.configDigest, recordRoot,
        prepare({ artifactRoot }) {
          const manifest = { ...expected, mode, inputPaths: copies.inputPaths };
          const manifestRel = `${mode}-${reservation.childIds[mode]}.json`; const profileRel = `${mode}-${reservation.childIds[mode]}.sb`;
          if (!writeFileContained(reservation.inputDir, manifestRel, JSON.stringify(manifest), { exclusive: true }) || !writeFileContained(reservation.inputDir, profileRel, experimentIsolationProfile(artifactRoot), { exclusive: true })) fail('one-shot evaluator manifest already exists or could not be created');
          onEvent?.('beforeLaunch', { mode, childId: reservation.childIds[mode] });
          const remaining = reservation.origin + plan.fm.experiment.budget.max_seconds * 1000 - Date.now();
          if (remaining <= 0) fail('original wall-clock budget deadline expired before evaluator spawn');
          return { argv: [EXPERIMENT_SANDBOX_PATH, '-f', path.join(reservation.inputDir, profileRel), ...check.config.command, path.join(reservation.inputDir, manifestRel)], env: { ...EXPERIMENT_ENVIRONMENT, HARNESS_CHECK_ARTIFACT_DIR: artifactRoot }, timeoutMs: Math.min(check.config.timeout_seconds * 1000, remaining) };
        },
        onSpawn: details => onEvent?.('spawn', { mode, childId: reservation.childIds[mode], ...details }),
        validateRaw: (name, bytes) => { if (name !== 'measurement.json') fail('unexpected measurement artifact'); receipt = validateExperimentArtifact(bytes, expected, plan.fm.experiment.budget.timeout_seconds); },
      });
      const measured = await runNamedCheck(workspace, check.id, check.config, { signal, copilotHome, home, recordRoot, events, experimentInvocation: capability });
      const child = { ...measured, mode, childId: reservation.childIds[mode], receipt };
      result.checks.push(child);
      result.groupReaped &&= measured.execution?.groupReaped !== false;
      onEvent?.('settled', { mode, childId: reservation.childIds[mode], status: measured.status, groupReaped: measured.execution?.groupReaped ?? true, execution: measured.execution ?? null });
      if (measured.cancelled) { result.status = 'interrupted'; break; }
      if (measured.status !== 'passed' || !receipt || measured.execution?.groupReaped !== true) fail(measured.message || 'Measurement process group was not reaped');
      const current = experimentInputsCheck({ workspace, plan, accepted, copilotHome, home }); if (!current.pass) fail(current.message);
      if (!same(candidateIdentity(workspace, accepted).descriptor, live.descriptor)) fail('candidate changed during evaluation');
      inputCopies(recordRoot, reservation, live.descriptor, accepted);
    }
    if (result.checks.length === 2 && result.checks.every(check => check.status === 'passed' && check.receipt) && result.groupReaped) {
      result.metric = outcome.metric; result.correctness = outcome.correctness; result.status = 'passed';
    }
    return result;
  } catch (error) { return { ...result, message: String(error.message).slice(0, 500) }; }
}

export function validateExperimentMeasurement({ workspace, plan, accepted, attempt, recordRoot, copilotHome, home } = {}) {
  try {
    const measurement = attempt?.measurement;
    if (!measurement || measurement.status !== 'passed' || measurement.groupReaped !== true || measurement.attempt !== attempt.id || !HASH.test(measurement.contractDigest || '') || measurement.acceptedInputsDigest !== accepted?.frozenDigest || !Array.isArray(measurement.checks) || measurement.checks.length !== 2) fail('completed retained measurement is missing');
    const current = experimentInputsCheck({ workspace, plan, accepted, copilotHome, home }); if (!current.pass) fail(current.message);
    const file = measurement.candidate?.files?.find(entry => entry.path === accepted.candidate.path); if (!file) fail('retained candidate binding is missing');
    const descriptor = { ...file, dimensions: accepted.candidate.dimensions };
    if (!same(candidateIdentity(workspace, accepted).descriptor, descriptor)) fail('retained candidate bytes or mode changed');
    const copies = inputCopies(recordRoot, attempt, descriptor, accepted); const outcome = expectedOutcome(copies.candidate, copies.workload);
    for (const [index, mode] of ['score', 'guard'].entries()) {
      const result = measurement.checks[index]; const check = accepted.checks[mode];
      if (result.id !== check.id || result.mode !== mode || result.childId !== attempt.childIds?.[mode] || result.status !== 'passed' || result.execution?.groupReaped !== true || !validateCheckArtifacts(recordRoot, check.config, result).pass) fail('retained check invocation, ownership or artifact hash changed');
      const bytes = readFileNoFollow(path.join(recordRoot, result.artifacts[0].path), { root: recordRoot, maxBytes: EXPERIMENT_MAX_INPUT_BYTES, encoding: null });
      const expected = artifactExpectation({ plan, accepted, reservation: attempt, descriptor, mode, outcome, contractDigest: measurement.contractDigest });
      const receipt = validateExperimentArtifact(bytes, expected, plan.fm.experiment.budget.timeout_seconds);
      if (!same(receipt, result.receipt)) fail('retained measurement receipt changed');
    }
    if (!same(measurement.metric, outcome.metric) || !same(measurement.correctness, outcome.correctness)) fail('retained result differs from its bound artifacts');
    return { pass: true, message: 'Retained experiment measurement is current', binding: { version: 1, attempt: attempt.id, frozenDigest: accepted.frozenDigest, candidate: measurement.candidate, metric: measurement.metric, correctness: measurement.correctness, artifacts: measurement.checks.flatMap(check => check.artifacts) } };
  } catch (error) { return { pass: false, message: String(error.message).slice(0, 500) }; }
}
