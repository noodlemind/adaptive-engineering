import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildTaskContext } from '../../lib/context-policy.mjs';
import { buildStructuralIndex } from '../../lib/repo-map/structural-index.mjs';
import { lexicalV2 } from '../../lib/repo-map/treesitter-extractor.mjs';
import { ensureHarnessDir, writeSession } from '../../lib/session.mjs';
import { readOrientSlice } from '../../lib/orient-read.mjs';
import { publicVerifierSource } from './check.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const here = import.meta.dirname;
const protocolFile = path.join(here, 'protocol.json');
const checker = path.join(here, 'check.mjs');
const GENERATED_METADATA = new Set(['.harness/context-pack.md', '.harness/repo-map.md', '.harness/session.json', '.harness/todo.json']);
export const PROTOCOL = Object.freeze(JSON.parse(fs.readFileSync(protocolFile, 'utf8')));

export function contextAgentArgs({ task, workspace, copilotHome, harnessHome, policy, model, provider, verifyCmd, protocol = PROTOCOL }) {
  if (!verifyCmd) throw new TypeError('case needs a public task verifier before an autonomous run');
  const prompt = `${task.prompt}\nAllowed changed files: ${task.editable.join(', ')}. Preserve all other files. Independently check your changes before finishing.`;
  return [prompt, '--profile', protocol.profile, '--verify-cmd', verifyCmd, '--provider', provider, '--model', model,
    '--max-turns', String(protocol.maxTurns), '--max-seconds', String(protocol.maxSeconds), '--context-policy', policy, '--retention-policy', protocol.retentionPolicy,
    ...task.seeds.flatMap(file => ['--file', file]), '--workspace', workspace, '--copilot-home', copilotHome, '--harness-home', harnessHome, '--no-events', '--json'];
}

export function resolveStudyOutput({ checkout, output }) {
  const requested = path.resolve(output);
  const resolved = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested));
  const relative = path.relative(fs.realpathSync(checkout), resolved);
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (!outside || fs.existsSync(resolved)) throw new Error('--out must be a new directory outside the checkout');
  return resolved;
}

export function safePath(file) {
  if (typeof file !== 'string' || !file || file.includes('\\') || path.posix.isAbsolute(file) || file.split('/').some(part => ['.', '..', '.git', '.harness', ''].includes(part))) {
    throw new TypeError(`invalid fixture path: ${file}`);
  }
  return file;
}

export function writeFiles(workspace, files = {}) {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(workspace, safePath(file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

export function trialEnvironment({ trial, copilotHome, harnessHome }) {
  const bin = path.resolve(here, '../../bin/ae.mjs');
  const directory = path.join(trial, 'runtime-bin');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'package.json'), '{"private":true,"type":"commonjs"}\n');
  const pinned = { HOME: trial, USERPROFILE: trial, COPILOT_HOME: copilotHome, AE_HOME: harnessHome, HARNESS_HOME: harnessHome, AE_BIN: bin, HARNESS_BIN: bin, AE_NO_EVENTS: '1', HARNESS_NO_EVENTS: '1' };
  const source = `#!/usr/bin/env node\nconst { spawnSync } = require('node:child_process');\nconst child = spawnSync(process.execPath, [${JSON.stringify(bin)}, ...process.argv.slice(2)], { cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, ...${JSON.stringify(pinned)} } });\nif (child.error) throw child.error;\nprocess.exit(child.status ?? 1);\n`;
  fs.writeFileSync(path.join(directory, 'ae'), source, { mode: 0o755 });
  fs.writeFileSync(path.join(directory, 'ae.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0ae" %*\r\n`);
  const env = { ...process.env, ...pinned };
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH');
  const inheritedPath = pathKey ? env[pathKey] : '';
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = `${directory}${path.delimiter}${inheritedPath}`;
  return env;
}

export function snapshot(workspace) {
  const files = {};
  const walk = dir => {
    for (const entry of fs.readdirSync(path.join(workspace, dir), { withFileTypes: true })) {
      if (!dir && entry.name === '.git') continue;
      const file = path.posix.join(dir, entry.name);
      if (GENERATED_METADATA.has(file) && entry.isFile()) continue;
      if (Object.keys(files).length > 1000) throw new Error('fixture file limit exceeded');
      if (entry.isDirectory()) walk(file);
      else files[file] = entry.isFile() ? hash(fs.readFileSync(path.join(workspace, file))) : 'unsupported';
    }
  };
  walk('');
  return files;
}

export async function prepareCase({ task, root, id }) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new TypeError('invalid trial id');
  if (!task.checks?.length) throw new TypeError('case needs independent checks');
  if (task.publicChecks !== undefined && (!Array.isArray(task.publicChecks) || !task.publicChecks.length)) throw new TypeError('publicChecks must be a nonempty array');
  if (task.resume) {
    const line = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\r\n]/.test(value);
    if (!line(task.resume.intent, 1000) || !Array.isArray(task.resume.constraints) || task.resume.constraints.length > 20 || task.resume.constraints.some(value => !line(value, 250))) throw new TypeError('invalid resume contract');
  }
  for (const file of [...task.editable, ...task.seeds, ...task.requiredEvidence, ...task.checks.map(check => check.module), ...(task.publicChecks || []).map(check => check.module)]) safePath(file);
  const trial = path.join(root, id);
  fs.mkdirSync(trial, { recursive: false });
  const workspace = path.join(trial, 'workspace');
  const copilotHome = path.join(trial, 'copilot');
  const harnessHome = path.join(trial, 'control');
  for (const dir of [workspace, copilotHome, harnessHome]) fs.mkdirSync(dir);
  writeFiles(workspace, task.files);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Context Eval', GIT_AUTHOR_EMAIL: 'context@example.test', GIT_COMMITTER_NAME: 'Context Eval', GIT_COMMITTER_EMAIL: 'context@example.test' };
  const git = args => execFileSync('git', args, { cwd: workspace, env, stdio: 'pipe' });
  git(['init', '-q']); git(['add', '.']); git(['commit', '-qm', 'Frozen case baseline']);
  if (task.indexBeforeEdits) await buildStructuralIndex({ workspace, home: harnessHome, extractor: { tier: 'lexical', extract: lexicalV2 } });
  ensureHarnessDir(workspace, false);
  if (task.resume) {
    const plan = '.harness/plans/2026-10-19-feat-context-reset-plan.md';
    fs.mkdirSync(path.join(workspace, '.harness/plans'));
    fs.writeFileSync(path.join(workspace, plan), `---\nplan_schema: 1\ntitle: "Frozen accepted task"\nstatus: in-progress\nplan_lock: true\nphase: 1\nintent: ${JSON.stringify(task.resume.intent)}\n---\n\n## Constraints\n${task.resume.constraints.map(value => `- ${value}`).join('\n')}\n`);
    writeSession(workspace, { activePlan: plan, files: task.seeds });
    readOrientSlice({ workspace, copilotHome, flags: { home: harnessHome, contextVersion: 2, plan }, query: task.resume.intent, files: task.seeds });
  }
  writeFiles(workspace, task.workingEdits);
  writeFiles(workspace, task.newFiles);
  let verifyCmd = null;
  if (task.publicChecks) {
    const control = path.join(workspace, '.harness');
    fs.mkdirSync(control, { recursive: true });
    fs.writeFileSync(path.join(control, 'context-public-checks.json'), JSON.stringify({ checks: task.publicChecks }), { mode: 0o444 });
    // The verifier embeds the public checks and the check function, so it never names the AE checkout.
    fs.writeFileSync(path.join(control, 'context-verify.mjs'), publicVerifierSource(task.publicChecks), { mode: 0o444 });
    verifyCmd = `"${process.execPath}" .harness/context-verify.mjs`;
  }
  const checkFile = path.join(trial, 'checks.json');
  const checkText = JSON.stringify({ checks: task.checks });
  fs.writeFileSync(checkFile, checkText, { mode: 0o444 });
  return { task, workspace, copilotHome, harnessHome, env: trialEnvironment({ trial, copilotHome, harnessHome }), verifyCmd, checkFile, checkHash: hash(checkText), checkerHash: hash(fs.readFileSync(checker)), before: snapshot(workspace), trial };
}

function integrity(fixture) {
  try { return (fixture.checkText !== undefined || hash(fs.readFileSync(fixture.checkFile)) === fixture.checkHash) && hash(fs.readFileSync(checker)) === fixture.checkerHash; }
  catch { return false; }
}

export async function runChecks(fixture) {
  if (!integrity(fixture)) return { pass: false, integrity: false, reason: 'check content changed' };
  const challenge = randomBytes(16).toString('hex');
  // The checks travel on stdin, so the check-file path never appears in a command line the checked code could read.
  // A fixture may hold its checks in memory (`checkText`), so no private file exists for checked code to find.
  let checkText = fixture.checkText;
  if (checkText === undefined) {
    try { checkText = fs.readFileSync(fixture.checkFile, 'utf8'); } catch { return { pass: false, integrity: false, reason: 'check content unreadable' }; }
  }
  if (hash(checkText) !== fixture.checkHash) return { pass: false, integrity: false, reason: 'check content changed' };
  // The checker gets a budget below the outer timeout, so a hang or exit in checked code still yields per-check verdicts.
  // spawnSync blocks this event loop: a SIGINT or SIGTERM sent meanwhile is handled only after the checker returns (at most checkerTimeoutMs).
  const budget = Math.max(1000, PROTOCOL.checkerTimeoutMs - 3000);
  const result = spawnSync(process.execPath, [checker, fixture.workspace], { input: `${challenge} ${budget} ${Math.min(8000, budget)}\n${checkText}`, encoding: 'utf8', timeout: PROTOCOL.checkerTimeoutMs, maxBuffer: 256_000 });
  const intact = integrity(fixture);
  const lines = (result.stdout || '').split(/\r?\n/);
  const completed = lines.includes(`harness-context-checked-v1:${challenge}:${fixture.task.checks.length}`);
  // Per-check verdicts let a caller score subsets (for example trap checks) from one run; null when the checker did not report.
  const verdicts = fixture.task.checks.map((_, index) => lines.includes(`harness-context-check-v1:${challenge}:${index}:pass`) ? true : lines.includes(`harness-context-check-v1:${challenge}:${index}:fail`) ? false : null);
  return { pass: intact && !result.error && result.status === 0 && completed, integrity: intact, completed, verdicts: intact && !result.error ? verdicts : verdicts.map(() => null), exitCode: result.status, signal: result.signal, error: result.error?.code ?? null, diagnostic: result.stderr?.slice(0, 2000) || (!completed ? 'Checker did not report completed assertions.' : null) };
}

export function runPublicChecks(fixture) {
  if (!fixture.verifyCmd) return null;
  const result = spawnSync(process.execPath, ['.harness/context-verify.mjs'], { cwd: fixture.workspace, encoding: 'utf8', timeout: PROTOCOL.checkerTimeoutMs, maxBuffer: 64_000 });
  return { pass: !result.error && result.status === 0, exitCode: result.status, error: result.error?.code ?? null, diagnostic: result.stderr?.slice(0, 2000) || null };
}

function undoMetadata(fixture, after) {
  const log = '.harness/undo.jsonl';
  if (!/^[a-f0-9]{64}$/.test(after[log] || '')) return [];
  try {
    const entries = fs.readFileSync(path.join(fixture.workspace, log), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    if (!entries.length) return [];
    const ids = new Set(), files = [log];
    for (const entry of entries) {
      if (entry.type === 'undone' && ids.has(entry.ref)) continue;
      if (entry.type !== 'mutation' || !/^[a-z0-9]+-[a-f0-9]{8}$/.test(entry.id || '') || ids.has(entry.id)
        || !['edit', 'write'].includes(entry.mode) || !fixture.task.editable.includes(entry.path)
        || typeof entry.existedBefore !== 'boolean' || !/^[a-f0-9]{64}$/.test(entry.sha256After || '')) return [];
      ids.add(entry.id);
      if (entry.existedBefore) {
        const backup = `.harness/undo/${entry.id}.bak`;
        if (!/^[a-f0-9]{64}$/.test(after[backup] || '')) return [];
        files.push(backup);
      }
    }
    return files;
  } catch {
    return [];
  }
}

export function scopeResult(fixture) {
  const after = snapshot(fixture.workspace);
  const metadata = new Set(undoMetadata(fixture, after));
  const changed = [...new Set([...Object.keys(fixture.before), ...Object.keys(after)])].filter(file => !metadata.has(file) && fixture.before[file] !== after[file]);
  const unexpected = changed.filter(file => !fixture.task.editable.includes(file));
  return { pass: unexpected.length === 0, changed, unexpected, metadataExcluded: [...GENERATED_METADATA, ...metadata] };
}

function evidenceResult(task, result) {
  if (!Array.isArray(result.turns) || !result.turns.length) return null;
  const seen = new Set();
  for (const turn of result.turns) {
    for (const source of turn.contextEvidence || []) seen.add(source.location);
    if ((turn.tools || []).some(tool => ['edit', 'write', 'apply', 'exec', 'bash'].includes(tool.tool) && tool.dispatched)) {
      return { missing: task.requiredEvidence.filter(file => !seen.has(file)), measuredBy: 'source-snapshot-and-read-tools', limits: 'Search, exec and external host reads are not observed as file evidence. Same-batch reads are excluded.' };
    }
    for (const tool of turn.tools || []) {
      if (tool.source?.path && tool.status === 'ok') seen.add(tool.source.path);
    }
  }
  return null;
}

export async function runStudy({ root, cases, repeats = PROTOCOL.repeats, policies = PROTOCOL.policies, retentionPolicy = PROTOCOL.retentionPolicy, dryRun = false, execute, model = null, host = null }) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new TypeError('repeats must be 1..20');
  if (!policies.length || new Set(policies).size !== policies.length || policies.some(policy => !PROTOCOL.policies.includes(policy))) throw new TypeError('invalid policies');
  if (!['legacy', 'structured'].includes(retentionPolicy)) throw new TypeError('invalid retention policy');
  fs.mkdirSync(root, { recursive: true });
  const provenance = {
    corpusHash: hash(JSON.stringify(cases)), checkerHash: hash(fs.readFileSync(checker)), protocolHash: hash(fs.readFileSync(protocolFile)),
    runtime: process.version, platform: process.platform, arch: process.arch, host, model,
    modelSelection: model?.trim().toLowerCase() === 'auto' ? 'automatic' : 'fixed',
    runtimeIsolation: 'candidate-cli-v1',
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim(),
    sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: here, encoding: 'utf8' }).trim()),
    profile: PROTOCOL.profile, publicVerifier: PROTOCOL.publicVerifier,
    retentionPolicy, maxTurns: PROTOCOL.maxTurns, maxSeconds: PROTOCOL.maxSeconds, repeats, policies,
  };
  provenance.configHash = hash(JSON.stringify(provenance));
  provenance.sourceHash = hash(execFileSync('git', ['ls-files', '-z', 'packages/ae/lib', 'packages/ae/bin', 'packages/ae/corpus', 'packages/ae/eval/context'], { cwd: path.resolve(here, '../../../..') }).toString().split('\0').filter(Boolean).map(file => `${file}:${hash(fs.readFileSync(path.resolve(here, '../../../..', file)))}`).join('\n'));
  fs.writeFileSync(path.join(root, 'provenance.json'), JSON.stringify(provenance, null, 2), { flag: 'wx' });
  const attempts = [];
  for (const [caseIndex, task] of cases.entries()) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const offset = (caseIndex + repeat) % policies.length;
      const ordered = [...policies.slice(offset), ...policies.slice(0, offset)];
      for (const policy of ordered) {
        const id = `${task.id}-${repeat + 1}-${policy}`;
        const fixture = await prepareCase({ task, root, id });
        const baseline = await runChecks(fixture);
        const publicBaseline = runPublicChecks(fixture);
        if (baseline.pass || !baseline.integrity || baseline.error || publicBaseline?.pass || publicBaseline?.error) throw new Error(`invalid broken baseline: ${id}`);
        const startedAt = Date.now();
        let result = {}, error = null;
        try {
          result = dryRun ? { dryRun: true, context: buildTaskContext({ workspace: fixture.workspace, copilotHome: fixture.copilotHome, home: fixture.harnessHome, task: task.prompt, files: task.seeds, policy }) } : await execute({ ...fixture, policy, model, protocol: { ...PROTOCOL, retentionPolicy } });
        } catch (caught) { error = String(caught.message).slice(0, 2000); }
        const checks = await runChecks(fixture);
        const scope = scopeResult(fixture);
        const kind = dryRun || result.dryRun ? 'dry-run' : error ? 'runtime-error' : host === 'scripted-test' ? 'scripted' : 'live';
        const requests = (result.contextAccounting || []).filter(record => record.boundary === 'headless-request');
        const models = [...new Set(requests.map(record => record.model).filter(Boolean))];
        const attempt = {
          id, case: task.id, split: task.split, family: task.family, repeat: repeat + 1, policy, kind,
          pass: ['live', 'scripted'].includes(kind) && result.status === 'ok' && checks.pass && scope.pass,
          baseline, publicBaseline, checks, scope, error, durationMs: Date.now() - startedAt, stopReason: result.stopReason ?? null,
          requestedModel: result.model ?? model, observedModels: models,
          actualModel: requests.length && requests.every(record => record.model) && models.length === 1 && models[0] !== 'auto' ? models[0] : null,
          provider: result.provider ?? null,
          accounting: result.contextAccounting || [], evidenceBeforeEdit: evidenceResult(task, result),
          context: result.context ? { files: result.context.files, coverage: result.context.coverage } : null,
        };
        fs.writeFileSync(path.join(fixture.trial, 'attempt.json'), JSON.stringify(attempt, null, 2));
        attempts.push(attempt);
      }
    }
  }
  const result = { schema: 1, provenance, attempts, summary: summarizeStudy(attempts, provenance) };
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(result, null, 2));
  return result;
}

export function summarizeStudy(attempts, provenance) {
  const arms = {};
  for (const policy of provenance.policies) {
    const rows = attempts.filter(row => row.policy === policy);
    const requests = rows.flatMap(row => row.accounting || []).filter(row => row.boundary === 'headless-request');
    const known = field => requests.filter(row => row.modelUsage?.measurement === 'observed' && Number.isFinite(row.modelUsage[field])).reduce((sum, row) => sum + row.modelUsage[field], 0);
    const complete = field => requests.length > 0 && rows.every(row => row.accounting?.length) && requests.every(row => row.modelUsage?.measurement === 'observed' && Number.isFinite(row.modelUsage[field]));
    const observed = requests.filter(row => row.modelUsage?.measurement === 'observed').length;
    const evidence = rows.filter(row => row.evidenceBeforeEdit);
    arms[policy] = {
      attempts: rows.length, passed: rows.filter(row => row.pass).length, failed: rows.filter(row => !row.pass).length,
      heldOutAttempts: rows.filter(row => row.split === 'held-out').length,
      heldOutFailed: rows.filter(row => row.split === 'held-out' && !row.pass).length,
      inputTokens: complete('inputTokens') ? known('inputTokens') : null,
      outputTokens: complete('outputTokens') ? known('outputTokens') : null,
      cachedInputTokens: complete('cachedInputTokens') ? known('cachedInputTokens') : null,
      knownInputTokens: observed ? known('inputTokens') : null,
      usageCoverage: complete('inputTokens') && complete('outputTokens') ? 'complete' : observed ? 'partial' : 'unavailable',
      evidenceCoverage: evidence.length === rows.length && rows.length ? 'complete' : evidence.length ? 'partial' : 'unavailable',
      observedMissingEvidence: evidence.reduce((sum, row) => sum + row.evidenceBeforeEdit.missing.length, 0),
      durationMs: rows.reduce((sum, row) => sum + (row.durationMs || 0), 0), cost: null,
      inputTokensPerAcceptedTask: complete('inputTokens') && rows.some(row => row.pass) ? known('inputTokens') / rows.filter(row => row.pass).length : null,
    };
  }
  const limits = PROTOCOL.promotion;
  const eligible = provenance.modelSelection !== 'automatic' && provenance.model !== 'auto'
    && attempts.length && attempts.every(row => row.kind === 'live' && row.actualModel === provenance.model)
    && ['legacy', 'selective', 'subsystem'].every(policy => arms[policy]?.heldOutAttempts >= limits.minimumHeldOutAttemptsPerArm && arms[policy].usageCoverage === 'complete')
    && arms.legacy.passed / arms.legacy.attempts >= limits.minimumBaselinePassRate;
  const candidates = eligible ? ['selective', 'subsystem'].filter(policy => arms[policy].failed <= arms.legacy.failed + limits.maximumAdditionalFailures
    && arms[policy].heldOutFailed <= arms.legacy.heldOutFailed + limits.maximumAdditionalFailures
    && arms[policy].inputTokens <= arms.legacy.inputTokens * (1 - limits.minimumInputTokenReduction)) : [];
  return { arms, comparison: eligible ? candidates.length ? 'candidate-requires-review' : 'no-candidate' : 'inconclusive', candidates,
    cost: null, costReason: 'No versioned price schedule supplied. Unknown usage is never zero cost.',
    limits: PROTOCOL.limits,
  };
}
