import { planRecordRoot } from './domain-context.mjs';
import { assertNoSymlinkAncestors, readFileNoFollow } from './fs-safe.mjs';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import YAML from 'yaml';
import { runProcess } from './runner.mjs';
import { resolveConfig } from './config.mjs';
import { resolveControls } from './controls.mjs';
import { buildChildEnv } from './exec-policy.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { isProjectTrusted } from './trust.mjs';
import { createRedactor, redactionMarker } from './redact.mjs';
import { artifactPathsProblem, allocateCheckArtifacts, captureCheckArtifacts, discardCheckArtifacts } from './check-artifacts.mjs';
import { isExperimentCheck, consumeExperimentInvocation } from './experiment-contract.mjs';

import { projectAuthorityFile } from './project-authority.mjs';

export const CHECKS_REL = '.github/harness/checks.yaml';

/** The complete schema a check entry accepts. Anything else is ignored. */
export const CHECK_TIMEOUT_DEFAULT_SECONDS = 600;
export const CHECK_TIMEOUT_MIN_SECONDS = 1;
export const CHECK_TIMEOUT_MAX_SECONDS = 3600;
export const CHECK_OUTPUT_MAX_CHARS = 4000;
const CHECK_SECRET_PATTERN_OVERLAP_CHARS = 64 * 1024;

/** Legacy per-check status vocabulary, preserved byte-for-byte from the
 * pre-runner spawnSync era. Distinct from the unified status vocabulary in
 * lib/envelope.mjs; `unifiedStatusForCheck` in verify.mjs is the only bridge. */
export const CHECK_STATUSES = Object.freeze(['passed', 'failed', 'timeout', 'unavailable']);

function resultCheck(id, status, message, extra = {}) {
  return { id, status, message, ...extra };
}

export function loadNamedChecks(workspace, options) {
  let source;
  try {
    source = projectAuthorityFile(workspace, 'checks.yaml', options);
    const full = source.path;
    if (!fs.lstatSync(full, { throwIfNoEntry: false })) return { checks: null, error: `Trusted check config not found: ${full}`, source: full };
    const content = readFileNoFollow(full, { root: source.root, maxBytes: 1024 * 1024, encoding: null });
    if (content === null) throw new Error('Named check source is unreadable or nonregular');
    const parsed = YAML.parse(content.toString('utf8'), { maxAliasCount: 50 });
    if (parsed?.version !== 1 || !parsed.checks || typeof parsed.checks !== 'object' || Array.isArray(parsed.checks)) {
      return { checks: null, error: `${source.display} must declare version: 1 and checks` };
    }
    return { checks: parsed.checks, error: null, source: source.path, sourceRoot: source.root, sourceMode: source.mode, sourceDigest: createHash('sha256').update(content).digest('hex') };
  } catch (error) {
    return { checks: null, error: `Invalid project checks${source ? ` ${source.display}` : ''}: ${error.message}` };
  }
}

function declaredProof(config) {
  if (!config || !Object.hasOwn(config, 'proof')) return 'behavior';
  if (config.proof === 'type-check' || config.proof === 'behavior') return config.proof;
  return null;
}

export function validateCommand(name, config) {
  if (!config || !Array.isArray(config.command) || config.command.length === 0) {
    return `${name}.command must be a non-empty argv array`;
  }
  if (!config.command.every((part) => typeof part === 'string' && part.length > 0)) {
    return `${name}.command entries must be non-empty strings`;
  }
  const timeout = config.timeout_seconds ?? CHECK_TIMEOUT_DEFAULT_SECONDS;
  if (!Number.isInteger(timeout) || timeout < CHECK_TIMEOUT_MIN_SECONDS || timeout > CHECK_TIMEOUT_MAX_SECONDS) {
    return `${name}.timeout_seconds must be an integer from ${CHECK_TIMEOUT_MIN_SECONDS} to ${CHECK_TIMEOUT_MAX_SECONDS}`;
  }
  if (config.proof !== undefined && config.proof !== 'type-check' && config.proof !== 'behavior') {
    return `${name}.proof must be type-check or behavior`;
  }
  const artifactProblem = artifactPathsProblem(config.artifacts);
  return artifactProblem ? `${name}.${artifactProblem}` : null;
}

/** The canonical spelling of a path, falling back to the resolved lexical form
 * when it does not exist — an audit record is worth writing either way. */
function canonicalPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function secretScanOverlap(redactText) {
  let overlap = CHECK_SECRET_PATTERN_OVERLAP_CHARS;
  for (const value of Object.values(process.env)) {
    if (typeof value !== 'string') continue;
    if (value.length > overlap && redactText(value) !== value) overlap = value.length;
    try {
      const encoded = encodeURIComponent(value);
      if (encoded.length > overlap && redactText(encoded) !== encoded) overlap = encoded.length;
    } catch {
      // The shared redactor also falls back to a raw literal for lone surrogates.
    }
  }
  return overlap;
}

function observeCheckOutput(onChunk, redactText, overlap) {
  let carry = '';
  let privateKeySeen = false;
  let secretSeen = false;
  return {
    push(chunk) {
      const text = carry + String(chunk);
      privateKeySeen ||= /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text);
      secretSeen ||= privateKeySeen || redactText(text) !== text;
      carry = text.slice(-overlap);
      onChunk?.(chunk);
    },
    retained(text, omittedChars) {
      if (privateKeySeen) return redactionMarker('private-key');
      if (secretSeen && omittedChars > 0) return redactionMarker('truncated-output');
      return redactText(text);
    },
  };
}

export async function runNamedCheck(workspace, name, config, { signal, onStdout, onStderr, copilotHome = null, events = null, recordRoot = workspace, controllerEnv = null, controllerPlan = null, controllerWorkspace = workspace, home: harnessHome, experimentInvocation = null } = {}) {
  const proof = declaredProof(config);
  let extraEnv = {};
  if (controllerEnv) {
    const authorized = controllerPlan && planRecordRoot(controllerWorkspace, controllerPlan);
    const manifest = controllerEnv.HARNESS_DOMAIN_REVISION_MANIFEST;
    const rel = typeof manifest === 'string' ? path.relative(recordRoot, manifest).replace(/\\/g, '/') : '..';
    if (authorized !== path.resolve(recordRoot) || Object.keys(controllerEnv).length !== 1 || !path.isAbsolute(manifest || '') || !rel.startsWith('.harness/domain/') || !assertNoSymlinkAncestors(recordRoot, rel) || readFileNoFollow(manifest, { root: recordRoot, maxBytes: 1024 * 1024 }) === null) return { id: name, status: 'unavailable', message: 'Joint check manifest lacks controller authority or is unsafe' };
    extraEnv = { HARNESS_DOMAIN_REVISION_MANIFEST: manifest };
  }
  const finish = (result) => (proof == null ? result : { ...result, proof });
  const invalid = validateCommand(name, config);
  if (invalid) return finish(resultCheck(name, 'unavailable', invalid));
  let experiment = null;
  if (isExperimentCheck(config) || experimentInvocation) {
    try { experiment = consumeExperimentInvocation(experimentInvocation, { workspace, name, config, recordRoot }); }
    catch (error) { return finish(resultCheck(name, 'unavailable', error.message)); }
  }

  const timeoutSeconds = config.timeout_seconds ?? CHECK_TIMEOUT_DEFAULT_SECONDS;

    const home = copilotHome ?? resolveCopilotHome(null);
  const cfg = resolveConfig({ copilotHome: home, home: harnessHome, workspace, projectTrusted: isProjectTrusted({ workspace, copilotHome: home, home: harnessHome }) });
    if (cfg.errors.length) {
    return finish({
      status: 'unavailable',
      reason: 'refusing to run: the harness configuration has errors',
      hint: `run \`ae config validate\` — first error: ${cfg.errors[0]}`,
    });
  }
    const allowlisted = cfg.values['checks.env_allowlist'] === true;
  const envReport = allowlisted ? buildChildEnv({ allow: cfg.values['exec.allow_env'] }) : null;

  const { controls, networkWrapper, degraded } = resolveControls({
    networkPolicy: cfg.values['exec.network'],
    environmentAllowlisted: allowlisted,
  });

  const { redactText, redactValue } = createRedactor();
  const overlap = secretScanOverlap(redactText);
  const stdout = observeCheckOutput(onStdout, redactText, overlap);
  const stderr = observeCheckOutput(onStderr, redactText, overlap);
  let artifactRoot = null;
  try { if (config.artifacts) artifactRoot = allocateCheckArtifacts(recordRoot, name); }
  catch (error) { return finish(resultCheck(name, 'unavailable', error.message)); }
  let isolated = null;
  if (experiment) {
    try { isolated = experiment.prepare({ artifactRoot: path.join(recordRoot, artifactRoot) }); }
    catch (error) { if (artifactRoot) discardCheckArtifacts(recordRoot, artifactRoot); return finish(resultCheck(name, 'unavailable', error.message)); }
  }
  // A named check is a new run, not a worker of an enclosing node:test process.
  // Inheriting this private marker makes `node --test` skip its assertions.
  const checkEnv = isolated ? { ...isolated.env } : { ...(envReport ? envReport.env : process.env), ...(artifactRoot ? { HARNESS_CHECK_ARTIFACT_DIR: path.join(recordRoot, artifactRoot) } : {}), ...extraEnv };
  delete checkEnv.NODE_TEST_CONTEXT;
  const execution = await runProcess({
    argv: isolated?.argv || [...networkWrapper, ...config.command],
    cwd: workspace,
    env: checkEnv,
    timeoutMs: isolated?.timeoutMs ?? timeoutSeconds * 1000,
    signal,
    ...(process.platform === 'win32' && artifactRoot && !experiment ? { cancellationFile: path.join(recordRoot, artifactRoot, '.harness-cancel.json') } : {}),
    onStdout: chunk => stdout.push(chunk),
    onStderr: chunk => stderr.push(chunk),
    maxBuffer: CHECK_OUTPUT_MAX_CHARS,
    bufferMode: 'head-tail',
    ...(experiment ? { onSpawn: experiment.onSpawn } : {}),
  });

    const sink = typeof events?.withCommand === 'function' ? events.withCommand('exec') : events;
  sink?.emit?.('exec', {
    result: execution.status === 'ok' ? 'pass' : 'fail',
    status: execution.status,
    exitCode: execution.exitCode,
    durationMs: execution.durationMs,
    exec: {
      shell: false,
      check: name,
      argv: config.command,
            cwd: canonicalPath(workspace),
      timeoutSeconds,
      env: isolated ? { sanitized: true, allowed: Object.keys(isolated.env), droppedCount: Object.keys(process.env).filter(key => !Object.hasOwn(isolated.env, key)).length } : envReport
        ? { allowed: envReport.allowed, droppedCount: envReport.dropped.length, refused: envReport.refused }
        : { inherited: true },
      signal: execution.signalName,
      truncated: execution.truncated,
      outputTruncation: execution.outputTruncation,
      controls: isolated ? [{ id: 'fixed-evaluator-isolation', declared: 'read-only/no-network', realized: 'read-only/no-network' }] : controls,
      degraded: isolated ? [] : degraded.map((c) => ({ id: c.id, declared: c.declared, realized: c.realized, reason: c.reason })),
    },
  });
  const output = {
    stdout: stdout.retained(execution.stdout, execution.outputTruncation.stdout.omittedChars),
    stderr: stderr.retained(execution.stderr, execution.outputTruncation.stderr.omittedChars),
    truncated: execution.truncated,
    outputTruncation: execution.outputTruncation,
    durationMs: execution.durationMs,
    ...(experiment || execution.cancellationNotice ? { execution: { status: execution.status, pid: execution.pid, groupId: execution.groupId, groupReaped: execution.groupReaped, provenanceError: execution.provenanceError,
      ...(execution.cancellationNotice ? { cancellationNotice: execution.cancellationNotice, treeTermination: execution.treeTermination } : {}) } } : {}),
    ...(artifactRoot ? { artifactRoot } : {}),
  };

  if (artifactRoot) {
    try { output.artifacts = captureCheckArtifacts(recordRoot, artifactRoot, config.artifacts, redactValue, experiment?.validateRaw); }
    catch (error) {
      discardCheckArtifacts(recordRoot, artifactRoot);
      if (execution.status === 'ok') return finish(resultCheck(name, 'failed', error.message, { ...output, exitCode: execution.exitCode }));
      output.artifactError = error.message;
    }
  }

  if (execution.status === 'cancelled') {
    return finish(resultCheck(name, 'unavailable', 'Cancelled — verification was interrupted', { ...output, cancelled: true }));
  }
  if (execution.status === 'timed-out') {
    return finish(resultCheck(name, 'timeout', isolated ? `Experiment invocation timed out after ${isolated.timeoutMs}ms within its remaining wall budget` : `Timed out after ${timeoutSeconds}s`, output));
  }
  if (execution.status === 'failed' && execution.exitCode === null) {
    const detail = execution.signalName ? `Terminated by signal ${execution.signalName}` : 'Named check could not be spawned';
    return finish(resultCheck(name, 'unavailable', detail, output));
  }
  if (execution.status === 'failed') {
    return finish(resultCheck(name, 'failed', `Exited with status ${execution.exitCode}`, { ...output, exitCode: execution.exitCode }));
  }
  return finish(resultCheck(name, 'passed', 'Named check passed', { ...output, exitCode: 0 }));
}
