import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveStudyOutput, runChecks, runPublicChecks, safePath, scopeResult, snapshot, trialEnvironment, writeFiles } from '../context/study.mjs';
import { KNOWLEDGE_FEEDBACK_STATES, KNOWLEDGE_MODES, readFeedbackConfig, readStoreConfig, repoId, storeDir, writeFeedbackConfig, writeStoreConfig } from '../../lib/knowledge/store.mjs';
import { applyOps } from '../../lib/knowledge/apply.mjs';
import { runOrient } from '../../lib/orient.mjs';
import { repeatEvidenceFromServed } from '../../lib/repeat-mistake.mjs';
import { projectStoreDir } from '../../lib/project-layout.mjs';
import { ensureHarnessDir } from '../../lib/session.mjs';

export { resolveStudyOutput };

const hash = value => createHash('sha256').update(value).digest('hex');
const here = import.meta.dirname;
const protocolFile = path.join(here, 'protocol.json');
const casesFile = path.join(here, 'cases.json');
const checker = path.resolve(here, '../context/check.mjs');
const CARRY_FILE_LIMIT = 200;
const CARRY_BYTE_LIMIT = 256 * 1024;
const TOLERANCE = 1e-9;
export const PROTOCOL = Object.freeze(JSON.parse(fs.readFileSync(protocolFile, 'utf8')));
export const CATALOG = Object.freeze(JSON.parse(fs.readFileSync(casesFile, 'utf8')));

/** The fixed, non-resolvable origin that pins one repository identity per series across tasks, arms and repeats. */
export function seriesOrigin(seriesId) {
  if (!/^[a-z0-9-]+$/.test(seriesId || '')) throw new TypeError(`invalid series id: ${seriesId}`);
  return `https://eval.invalid/ae-memory/${seriesId}.git`;
}

export const armSlug = id => id.replaceAll('+', '-plus-');

export function armById(protocol, id) {
  const arm = protocol.arms.find(candidate => candidate.id === id);
  if (!arm) throw new TypeError(`unknown arm: ${id}`);
  return arm;
}

/** Baseline chain from an arm to stateless, e.g. recall+feedback -> recall -> stateless. Throws on cycles or depth overruns. */
export function baselineChain(protocol, id) {
  const chain = [id];
  const limit = protocol.promotion?.maximumBaselineDepth ?? 2;
  let current = armById(protocol, id);
  while (current.baseline !== null) {
    if (typeof current.baseline !== 'string') throw new TypeError(`arm ${current.id} must declare a baseline`);
    if (chain.includes(current.baseline)) throw new TypeError(`baseline cycle at ${current.baseline}`);
    chain.push(current.baseline);
    if (chain.length - 1 > limit) throw new TypeError(`arm ${id} needs more than ${limit} steps to reach stateless`);
    current = armById(protocol, current.baseline);
  }
  if (current.id !== 'stateless') throw new TypeError(`arm ${id} does not resolve to stateless`);
  return chain;
}

export function validateProtocol(protocol = PROTOCOL) {
  if (protocol.schema !== 1 || !Array.isArray(protocol.arms) || !protocol.arms.length) throw new TypeError('protocol needs schema 1 and arms');
  const ids = protocol.arms.map(arm => arm.id);
  if (new Set(ids).size !== ids.length) throw new TypeError('arm ids must be unique');
  const roots = protocol.arms.filter(arm => arm.baseline === null);
  if (roots.length !== 1 || roots[0].id !== 'stateless' || roots[0].mode !== 'off') throw new TypeError('stateless (mode off) must be the only arm without a baseline');
  for (const arm of protocol.arms) {
    if (!/^[a-z0-9+-]+$/.test(arm.id)) throw new TypeError(`invalid arm id: ${arm.id}`);
    if (!Object.hasOwn(arm, 'baseline')) throw new TypeError(`arm ${arm.id} must declare a baseline`);
    if (!KNOWLEDGE_MODES.has(arm.mode)) throw new TypeError(`arm ${arm.id} has unknown knowledge mode ${arm.mode}`);
    if (arm.feedback !== undefined && !KNOWLEDGE_FEEDBACK_STATES.has(arm.feedback)) throw new TypeError(`arm ${arm.id} has unknown feedback state ${arm.feedback}`);
    if (arm.recheck !== undefined && arm.available !== false) throw new TypeError(`arm ${arm.id} sets knowledge.recheck, which this harness cannot configure yet`);
    if (arm.seed && arm.mode !== 'freeze') throw new TypeError(`seeded arm ${arm.id} must use mode freeze`);
    baselineChain(protocol, arm.id);
  }
  return protocol;
}

export function runnableArms(protocol = PROTOCOL) {
  return protocol.arms.filter(arm => arm.available !== false).map(arm => arm.id);
}

export function validateCatalog(catalog = CATALOG) {
  if (catalog.schema !== 1 || !Array.isArray(catalog.series) || !catalog.series.length) throw new TypeError('catalog needs schema 1 and series');
  const ids = new Set();
  const trapsBySplit = { development: new Set(), 'held-out': new Set() };
  for (const series of catalog.series) {
    seriesOrigin(series.id);
    if (ids.has(series.id)) throw new TypeError(`duplicate series ${series.id}`);
    ids.add(series.id);
    if (!Object.hasOwn(trapsBySplit, series.split)) throw new TypeError(`series ${series.id} has invalid split`);
    if (!/^[a-z0-9-]+$/.test(series.trap?.id || '')) throw new TypeError(`series ${series.id} needs a trap id`);
    trapsBySplit[series.split].add(series.trap.id);
    if (!Array.isArray(series.tasks) || series.tasks.length < 4 || series.tasks.length > 6) throw new TypeError(`series ${series.id} needs 4 to 6 tasks`);
    if (series.tasks[0].trap !== 'first') throw new TypeError(`series ${series.id} must plant its trap in task 1`);
    if (!series.tasks.slice(1).some(task => task.trap === 'recurrence')) throw new TypeError(`series ${series.id} needs a later recurrence of its trap`);
    const taskIds = new Set();
    for (const file of Object.keys(series.files || {})) safePath(file);
    for (const task of series.tasks) {
      if (!/^[a-z0-9-]+$/.test(task.id || '') || taskIds.has(task.id)) throw new TypeError(`series ${series.id} has an invalid or duplicate task id`);
      taskIds.add(task.id);
      if (![null, 'first', 'recurrence'].includes(task.trap ?? null)) throw new TypeError(`task ${task.id} has invalid trap role`);
      if (!task.checks?.length || !task.publicChecks?.length) throw new TypeError(`task ${task.id} needs private and public checks`);
      if (task.trap && !task.checks.some(check => check.trap)) throw new TypeError(`trap task ${task.id} needs a private trap check`);
      if (task.publicChecks.some(check => check.trap)) throw new TypeError(`task ${task.id} must keep trap checks private`);
      for (const file of [...task.editable, ...task.seeds, ...Object.keys(task.files || {}), ...task.checks.map(check => check.module)]) safePath(file);
    }
  }
  const shared = [...trapsBySplit['held-out']].filter(trap => trapsBySplit.development.has(trap));
  if (shared.length) throw new TypeError(`held-out series share traps with development series: ${shared.join(', ')}`);
  return catalog;
}

/** Fixture state for task `index`: the series base plus every task overlay up to and including it. */
export function seriesState(series, index) {
  return Object.assign({}, series.files, ...series.tasks.slice(0, index + 1).map(task => task.files || {}));
}

export function memoryPrompt(task) {
  return `${task.prompt}\nAllowed changed files: ${task.editable.join(', ')}. Preserve all other files. Do not change Git remotes. Independently check your changes before finishing.`;
}

export function memoryAgentArgs({ task, workspace, copilotHome, harnessHome, model, provider, verifyCmd, protocol = PROTOCOL }) {
  if (!verifyCmd) throw new TypeError('task needs a public verifier before an autonomous run');
  return [memoryPrompt(task), '--profile', protocol.profile, '--verify-cmd', verifyCmd, '--provider', provider, '--model', model,
    '--max-turns', String(protocol.maxTurns), '--max-seconds', String(protocol.maxSeconds),
    ...task.seeds.flatMap(file => ['--file', file]), '--workspace', workspace, '--copilot-home', copilotHome, '--harness-home', harnessHome, '--no-events', '--json'];
}

function gitEnv() {
  return { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Memory Eval', GIT_AUTHOR_EMAIL: 'memory@example.test', GIT_COMMITTER_NAME: 'Memory Eval', GIT_COMMITTER_EMAIL: 'memory@example.test' };
}

function readOrigin(workspace) {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: workspace, env: gitEnv(), encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function writeCheckFile(file, checks) {
  const text = JSON.stringify({ checks });
  fs.writeFileSync(file, text, { mode: 0o444 });
  return hash(text);
}

/** Fresh checkout of the series state for one task, with carried-forward episodes committed and origin pinned before any ae command. */
export function prepareTask({ series, index, runDir, carried = {}, extraFiles = {}, origin = seriesOrigin(series.id), copilotHome, harnessHome }) {
  const task = series.tasks[index];
  const trial = path.join(runDir, 'tasks', `${index + 1}-${task.id}`);
  fs.mkdirSync(trial, { recursive: true });
  const workspace = path.join(trial, 'workspace');
  fs.mkdirSync(workspace);
  writeFiles(workspace, seriesState(series, index));
  writeFiles(workspace, carried);
  writeFiles(workspace, extraFiles);
  const env = gitEnv();
  const git = args => execFileSync('git', args, { cwd: workspace, env, stdio: 'pipe' });
  git(['init', '-q']); git(['add', '.']); git(['commit', '-qm', `Series ${series.id} task ${index + 1}`]);
  git(['remote', 'add', 'origin', origin]);
  ensureHarnessDir(workspace, false);
  const control = path.join(workspace, '.harness');
  fs.writeFileSync(path.join(control, 'context-public-checks.json'), JSON.stringify({ checks: task.publicChecks }), { mode: 0o444 });
  fs.writeFileSync(path.join(control, 'context-verify.mjs'), `import fs from 'node:fs';\nimport { checkCases } from ${JSON.stringify(pathToFileURL(checker).href)};\nconst task = JSON.parse(fs.readFileSync(new URL('./context-public-checks.json', import.meta.url), 'utf8'));\nawait checkCases(process.cwd(), task.checks);\n`, { mode: 0o444 });
  const checkFile = path.join(trial, 'checks.json');
  const trapChecks = task.checks.filter(check => check.trap);
  const trapFile = path.join(trial, 'trap-checks.json');
  const checkerHash = hash(fs.readFileSync(checker));
  const fixture = {
    series, task, index, trial, workspace, copilotHome, harnessHome, origin,
    env: trialEnvironment({ trial, copilotHome, harnessHome }),
    verifyCmd: `"${process.execPath}" .harness/context-verify.mjs`,
    checkFile, checkHash: writeCheckFile(checkFile, task.checks), checkerHash,
    trap: trapChecks.length ? { workspace, task: { checks: trapChecks }, checkFile: trapFile, checkHash: writeCheckFile(trapFile, trapChecks), checkerHash } : null,
    carriedForward: Object.keys(carried).sort(),
  };
  fixture.before = snapshot(workspace);
  return fixture;
}

function listFiles(root, base = '') {
  const found = {};
  let entries;
  try { entries = fs.readdirSync(path.join(root, base), { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const rel = path.posix.join(base, entry.name);
    if (entry.isDirectory()) Object.assign(found, listFiles(root, rel));
    else if (entry.isFile()) found[rel] = path.join(root, rel);
  }
  return found;
}

function episodeHashes(fixture) {
  const roots = { workspace: path.join(fixture.workspace, PROTOCOL.carryForward), project: path.join(projectStoreDir(fixture.workspace, { home: fixture.harnessHome }), 'docs', 'solutions') };
  const hashes = {};
  for (const [label, root] of Object.entries(roots)) {
    for (const [rel, file] of Object.entries(listFiles(root))) hashes[`${label}:${rel}`] = hash(fs.readFileSync(file));
  }
  return hashes;
}

/** Episodes a real checkout would have committed: every regular file under docs/solutions, bounded. */
export function collectCarryForward(workspace) {
  const carried = {};
  const root = path.join(workspace, PROTOCOL.carryForward);
  for (const [rel, file] of Object.entries(listFiles(root)).sort(([a], [b]) => a.localeCompare(b)).slice(0, CARRY_FILE_LIMIT)) {
    const target = `${PROTOCOL.carryForward}/${rel}`;
    try { safePath(target); } catch { continue; }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > CARRY_BYTE_LIMIT) continue;
    carried[target] = fs.readFileSync(file);
  }
  return carried;
}

/** Writes the series seed learning while the store is briefly on, then sets the arm's mode. The seed episode must already be committed. */
export function seedStore({ workspace, home, series }) {
  if (!series.seed?.op || !series.seed?.episode) throw new TypeError(`series ${series.id} has no seed`);
  const set = writeStoreConfig(workspace, { home, mode: 'on' });
  if (!set.pass) throw new Error(`seed configuration failed: ${set.blockedReason}`);
  const episode = { path: series.seed.episode.path, sha256: hash(series.seed.episode.content), kind: 'fix', plan: null };
  const result = applyOps({ workspace, home, operations: { schema: 1, ops: [{ op: 'ADD', ...series.seed.op, episodes: [episode] }] } });
  if (result.applied?.length !== 1) throw new Error(`seed learning was not applied: ${JSON.stringify(result.rejected || []).slice(0, 500)}`);
  return `${series.seed.op.domain}/${series.seed.op.slug}`;
}

export function configureArm({ workspace, home, arm, series }) {
  let seeded = null;
  if (arm.seed) seeded = seedStore({ workspace, home, series });
  const mode = writeStoreConfig(workspace, { home, mode: arm.mode });
  if (!mode.pass) throw new Error(`knowledge mode configuration failed: ${mode.blockedReason}`);
  if (arm.feedback !== undefined) {
    const feedback = writeFeedbackConfig(workspace, { home, feedback: arm.feedback });
    if (!feedback.pass) throw new Error(`feedback configuration failed: ${feedback.blockedReason}`);
  }
  return { seeded };
}

/** What `ae orient` would inject for this task, computed without writing orientation artifacts or calling a model. */
export function plannedInjection({ workspace, copilotHome, home, task }) {
  try {
    const result = runOrient({ workspace, copilotHome, flags: { home, harnessHome: home, dryRun: true }, query: memoryPrompt(task), files: task.seeds });
    return { learnings: result.deliveredLearnings || [], learningsBytes: result.learningsBytes ?? 0, error: null };
  } catch (error) {
    return { learnings: [], learningsBytes: null, error: String(error.message).slice(0, 500) };
  }
}

function addedDiff(workspace, editable) {
  const env = gitEnv();
  const present = editable.filter(file => fs.existsSync(path.join(workspace, file)));
  if (present.length) spawnSync('git', ['add', '-N', '--', ...present], { cwd: workspace, env });
  const result = spawnSync('git', ['-c', 'core.quotepath=off', 'diff', 'HEAD', '--', ...editable], { cwd: workspace, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : '';
}

function usageOf(result) {
  const requests = (result.contextAccounting || []).filter(record => record.boundary === 'headless-request');
  const observed = field => requests.length > 0 && requests.every(row => row.modelUsage?.measurement === 'observed' && Number.isFinite(row.modelUsage[field]));
  const sum = field => requests.reduce((total, row) => total + (row.modelUsage?.[field] || 0), 0);
  const models = [...new Set(requests.map(record => record.model).filter(Boolean))];
  return {
    inputTokens: observed('inputTokens') ? sum('inputTokens') : null,
    outputTokens: observed('outputTokens') ? sum('outputTokens') : null,
    coverage: observed('inputTokens') && observed('outputTokens') ? 'complete' : requests.some(row => row.modelUsage?.measurement === 'observed') ? 'partial' : 'unavailable',
    observedModels: models,
    actualModel: requests.length && requests.every(record => record.model) && models.length === 1 && models[0] !== 'auto' ? models[0] : null,
  };
}

function provenanceFor({ catalog, protocol, arms, repeats, model, host, series }) {
  const repoRoot = path.resolve(here, '../../../..');
  const provenance = {
    corpusHash: hash(JSON.stringify(catalog)), checkerHash: hash(fs.readFileSync(checker)), protocolHash: hash(JSON.stringify(protocol)),
    runtime: process.version, platform: process.platform, arch: process.arch, host, model,
    modelSelection: model?.trim().toLowerCase() === 'auto' ? 'automatic' : 'fixed',
    runtimeIsolation: 'candidate-cli-v1',
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim(),
    sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: here, encoding: 'utf8' }).trim()),
    profile: protocol.profile, publicVerifier: protocol.publicVerifier, maxTurns: protocol.maxTurns, maxSeconds: protocol.maxSeconds,
    repeats, arms, series: series.map(item => item.id), origin: protocol.origin, carryForward: protocol.carryForward,
  };
  provenance.configHash = hash(JSON.stringify(provenance));
  provenance.sourceHash = hash(execFileSync('git', ['ls-files', '-z', 'packages/ae/lib', 'packages/ae/bin', 'packages/ae/corpus', 'packages/ae/eval/context', 'packages/ae/eval/memory'], { cwd: repoRoot }).toString().split('\0').filter(Boolean).map(file => `${file}:${hash(fs.readFileSync(path.resolve(repoRoot, file)))}`).join('\n'));
  return provenance;
}

/**
 * Runs every (series, arm, repeat) with one harness home shared across the series's tasks and a fresh checkout per task.
 * `originFor(series, index)` exists so tests can prove identity drift is caught; production runs use seriesOrigin.
 */
export async function runStudy({ root, catalog = CATALOG, protocol = PROTOCOL, arms = runnableArms(protocol), repeats = protocol.repeats, split = 'all', dryRun = false, execute, model = null, host = null, originFor = series => seriesOrigin(series.id) }) {
  validateProtocol(protocol);
  validateCatalog(catalog);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new TypeError('repeats must be 1..20');
  if (!arms.length || new Set(arms).size !== arms.length) throw new TypeError('invalid arms');
  for (const id of arms) {
    const arm = armById(protocol, id);
    if (arm.available === false) throw new TypeError(`arm ${id} is not runnable yet: requires ${arm.requires}`);
  }
  if (!['all', 'development', 'held-out'].includes(split)) throw new TypeError('split must be all, development or held-out');
  if (!dryRun && typeof execute !== 'function') throw new TypeError('live and scripted runs need an executor');
  const series = catalog.series.filter(item => split === 'all' || item.split === split);
  fs.mkdirSync(root, { recursive: true });
  const provenance = provenanceFor({ catalog, protocol, arms, repeats, model, host, series });
  fs.writeFileSync(path.join(root, 'provenance.json'), JSON.stringify(provenance, null, 2), { flag: 'wx' });
  const attempts = [];
  const runs = [];
  for (const [seriesIndex, item] of series.entries()) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const offset = (seriesIndex + repeat) % arms.length;
      for (const armId of [...arms.slice(offset), ...arms.slice(0, offset)]) {
        const arm = armById(protocol, armId);
        const runId = `${item.id}-${armSlug(armId)}-r${repeat + 1}`;
        const runDir = path.join(root, runId);
        const copilotHome = path.join(runDir, 'copilot');
        const harnessHome = path.join(runDir, 'home');
        fs.mkdirSync(copilotHome, { recursive: true });
        fs.mkdirSync(harnessHome, { recursive: true });
        let carried = {};
        let first = null;
        let seeded = null;
        let runEpisodes = 0;
        for (let index = 0; index < item.tasks.length; index++) {
          const task = item.tasks[index];
          const extraFiles = index === 0 && arm.seed ? { [item.seed.episode.path]: item.seed.episode.content } : {};
          const fixture = prepareTask({ series: item, index, runDir, carried, extraFiles, origin: originFor(item, index), copilotHome, harnessHome });
          if (index === 0) ({ seeded } = configureArm({ workspace: fixture.workspace, home: harnessHome, arm, series: item }));
          const identity = { repoId: repoId(fixture.workspace), storeDir: storeDir(fixture.workspace, { home: harnessHome }) };
          if (!first) first = identity;
          const modeBefore = readStoreConfig(fixture.workspace, { home: harnessHome }).mode;
          const feedbackBefore = readFeedbackConfig(fixture.workspace, { home: harnessHome });
          const baseline = await runChecks(fixture);
          const publicBaseline = runPublicChecks(fixture);
          const trapBaseline = fixture.trap ? await runChecks(fixture.trap) : null;
          if (baseline.pass || !baseline.integrity || baseline.error || publicBaseline?.pass || publicBaseline?.error || trapBaseline?.pass) throw new Error(`invalid broken baseline: ${runId} task ${index + 1}`);
          const episodesBefore = episodeHashes(fixture);
          const injection = plannedInjection({ workspace: fixture.workspace, copilotHome, home: harnessHome, task });
          const startedAt = Date.now();
          let result = {}, error = null;
          if (!dryRun) {
            try { result = await execute({ ...fixture, arm, repeat: repeat + 1, model, protocol, injection }) || {}; }
            catch (caught) { error = String(caught.message).slice(0, 2000); }
          }
          // A dry run changes nothing, so the baseline checks above already describe its workspace.
          const checks = dryRun ? null : await runChecks(fixture);
          const trapChecks = dryRun || !fixture.trap ? null : await runChecks(fixture.trap);
          const scope = scopeResult(fixture);
          const unexpected = scope.unexpected.filter(file => !file.startsWith('.harness/') && !file.startsWith(`${protocol.carryForward}/`));
          const originAfter = readOrigin(fixture.workspace);
          const modeAfter = readStoreConfig(fixture.workspace, { home: harnessHome }).mode;
          const episodesAfter = episodeHashes(fixture);
          const episodesWritten = Object.keys(episodesAfter).filter(key => episodesBefore[key] !== episodesAfter[key]).length;
          runEpisodes += episodesWritten;
          const kind = dryRun ? 'dry-run' : error ? 'runtime-error' : host === 'scripted-test' ? 'scripted' : 'live';
          const executed = kind === 'live' || kind === 'scripted';
          const invalidReasons = [
            identity.repoId !== first.repoId && 'repo-identity-drift',
            identity.storeDir !== first.storeDir && 'store-directory-drift',
            modeBefore !== arm.mode && 'knowledge-mode-mismatch',
            feedbackBefore !== (arm.feedback ?? 'off') && 'feedback-state-mismatch',
            modeAfter !== arm.mode && 'knowledge-mode-changed-by-agent',
          ].filter(Boolean);
          const valid = invalidReasons.length === 0;
          const originUnchanged = originAfter === fixture.origin;
          const usage = usageOf(result);
          let repeatMistake = null;
          if (executed && task.trap) {
            const evidence = repeatEvidenceFromServed({ workspace: fixture.workspace, home: harnessHome, session: { lastQuery: memoryPrompt(task), files: task.seeds }, delivered: addedDiff(fixture.workspace, task.editable) });
            repeatMistake = { flagged: evidence.length > 0, learnings: evidence.map(row => row.learning) };
          }
          const attempt = {
            id: `${runId}-t${index + 1}`, run: runId, series: item.id, split: item.split, trapId: item.trap.id, arm: armId, repeat: repeat + 1,
            task: task.id, taskIndex: index + 1, trapRole: task.trap ?? null, kind, valid, invalidReasons,
            pass: executed && valid && result.status === 'ok' && checks?.pass === true && unexpected.length === 0 && originUnchanged,
            baseline, publicBaseline, trapBaseline, checks, trapChecks,
            trapRecurred: executed && valid && task.trap === 'recurrence' ? !trapChecks.pass : null,
            trapFirstFailed: executed && valid && task.trap === 'first' ? !trapChecks.pass : null,
            repeatMistake,
            // Harness state and new episodes are expected writes; anything else outside the editable files fails scope.
            scope: { ...scope, pass: unexpected.length === 0, unexpected }, origin: { expected: fixture.origin, after: originAfter, unchanged: originUnchanged },
            repoId: identity.repoId, storeDir: identity.storeDir, knowledgeMode: modeBefore, knowledgeModeAfter: modeAfter, feedback: feedbackBefore, seeded,
            carriedForward: fixture.carriedForward,
            learningsInjected: injection.learnings, learningsBytes: injection.learningsBytes, injectionError: injection.error,
            episodesWritten,
            turns: Number.isInteger(result.turnCount) ? result.turnCount : Array.isArray(result.turns) ? result.turns.length : null,
            inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, usageCoverage: usage.coverage,
            requestedModel: result.model ?? model, observedModels: usage.observedModels, actualModel: usage.actualModel, provider: result.provider ?? null,
            status: result.status ?? null, stopReason: result.stopReason ?? null, error, durationMs: Date.now() - startedAt,
          };
          fs.writeFileSync(path.join(fixture.trial, 'attempt.json'), JSON.stringify(attempt, null, 2));
          attempts.push(attempt);
          carried = collectCarryForward(fixture.workspace);
        }
        runs.push({ id: runId, series: item.id, split: item.split, arm: armId, repeat: repeat + 1, harnessHome, episodesWritten: runEpisodes });
      }
    }
  }
  const output = { schema: 1, provenance, runs, attempts, summary: summarizeStudy({ attempts, runs, provenance, protocol }) };
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(output, null, 2));
  return output;
}

function rate(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

/** Per-arm statistics on one split; the promotion rule reads the held-out split. */
export function armStatistics({ attempts, runs, arm, split }) {
  const rows = attempts.filter(row => row.arm === arm && (split === 'all' || row.split === split));
  // Dry runs and runtime errors never count as measured task outcomes.
  const valid = rows.filter(row => row.valid && (row.kind === 'live' || row.kind === 'scripted'));
  const recurrence = valid.filter(row => row.trapRecurred !== null);
  const armRuns = runs.filter(row => row.arm === arm && (split === 'all' || row.split === split));
  const complete = field => valid.length > 0 && valid.every(row => row.usageCoverage === 'complete' && Number.isFinite(row[field]));
  return {
    attempts: rows.length, measuredAttempts: valid.length, invalidAttempts: rows.filter(row => !row.valid).length,
    heldOutAttempts: split === 'held-out' ? valid.length : valid.filter(row => row.split === 'held-out').length,
    passed: valid.filter(row => row.pass).length, passRate: rate(valid.filter(row => row.pass).length, valid.length),
    recurrenceAttempts: recurrence.length, recurred: recurrence.filter(row => row.trapRecurred).length,
    recurrenceRate: rate(recurrence.filter(row => row.trapRecurred).length, recurrence.length),
    repeatMistakesFlagged: valid.filter(row => row.repeatMistake?.flagged).length,
    episodesPerSeries: rate(armRuns.reduce((sum, row) => sum + row.episodesWritten, 0), armRuns.length),
    // Injection is computed before execution, so dry runs report it too.
    learningsInjected: rows.filter(row => row.valid).reduce((sum, row) => sum + row.learningsInjected.length, 0),
    learningsBytes: rows.filter(row => row.valid).reduce((sum, row) => sum + (row.learningsBytes || 0), 0),
    turns: valid.every(row => Number.isInteger(row.turns)) ? valid.reduce((sum, row) => sum + row.turns, 0) : null,
    inputTokens: complete('inputTokens') ? valid.reduce((sum, row) => sum + row.inputTokens, 0) : null,
    outputTokens: complete('outputTokens') ? valid.reduce((sum, row) => sum + row.outputTokens, 0) : null,
    usageCoverage: complete('inputTokens') && complete('outputTokens') ? 'complete' : valid.some(row => row.usageCoverage !== 'unavailable') ? 'partial' : 'unavailable',
  };
}

/** One arm against one reference arm, per the protocol's promotion thresholds. */
export function compareArms(candidate, reference, limits = PROTOCOL.promotion) {
  const reasons = [];
  if (!(candidate.heldOutAttempts >= limits.minimumHeldOutAttemptsPerArm && reference.heldOutAttempts >= limits.minimumHeldOutAttemptsPerArm)) reasons.push('insufficient-held-out-attempts');
  if (limits.requireCompleteObservedUsage && (candidate.usageCoverage !== 'complete' || reference.usageCoverage !== 'complete')) reasons.push('incomplete-observed-usage');
  let reduction = null;
  if (!Number.isFinite(candidate.recurrenceRate) || !Number.isFinite(reference.recurrenceRate)) reasons.push('recurrence-unmeasured');
  else if (!(reference.recurrenceRate > 0)) reasons.push('reference-has-no-recurrence');
  else {
    reduction = (reference.recurrenceRate - candidate.recurrenceRate) / reference.recurrenceRate;
    if (reduction < limits.minimumRelativeTrapRecurrenceReduction - TOLERANCE) reasons.push('recurrence-reduction-below-threshold');
  }
  const passDifference = Number.isFinite(candidate.passRate) && Number.isFinite(reference.passRate) ? candidate.passRate - reference.passRate : null;
  if (passDifference === null) reasons.push('pass-rate-unmeasured');
  else if (passDifference < -limits.passRateNonInferiorityMargin - TOLERANCE) reasons.push('pass-rate-regressed');
  if (limits.episodesMayRiseOnlyIfRecurrenceFalls && candidate.episodesPerSeries > reference.episodesPerSeries && !(candidate.recurrenceRate < reference.recurrenceRate)) reasons.push('episodes-rose-without-recurrence-falling');
  return { pass: reasons.length === 0, relativeRecurrenceReduction: reduction, passRateDifference: passDifference, reasons };
}

/**
 * Promotion rule: an arm is compared with its declared baseline; an incremental arm must also pass against stateless,
 * and cannot be promoted when its baseline is not promotable against stateless.
 */
export function scorePromotion(stats, { protocol = PROTOCOL, eligible = true, ineligibleReason = null } = {}) {
  const limits = protocol.promotion;
  const decisions = {};
  const decide = id => {
    if (decisions[id]) return decisions[id];
    const arm = armById(protocol, id);
    const chain = baselineChain(protocol, id);
    const reasons = [];
    const against = {};
    if (!stats[arm.baseline]) reasons.push(`baseline-${arm.baseline}-not-in-batch`);
    else against[arm.baseline] = compareArms(stats[id], stats[arm.baseline], limits);
    if (arm.baseline !== 'stateless' && limits.incrementalArmsMustAlsoPassAgainstStateless) {
      if (!stats.stateless) reasons.push('baseline-stateless-not-in-batch');
      else against.stateless = compareArms(stats[id], stats.stateless, limits);
      if (stats[arm.baseline] && !decide(arm.baseline).promotable) reasons.push(`baseline-${arm.baseline}-not-promotable`);
    }
    for (const [reference, comparison] of Object.entries(against)) for (const reason of comparison.reasons) reasons.push(`vs-${reference}:${reason}`);
    if (!eligible) reasons.unshift(`ineligible:${ineligibleReason || 'batch'}`);
    decisions[id] = { baseline: arm.baseline, chain, promotable: reasons.length === 0, against, reasons };
    return decisions[id];
  };
  for (const id of Object.keys(stats)) if (id !== 'stateless') decide(id);
  const promotable = Object.keys(decisions).filter(id => decisions[id].promotable);
  return { comparison: !eligible ? 'inconclusive' : promotable.length ? 'candidate-requires-review' : 'no-candidate', promotable, decisions };
}

export function summarizeStudy({ attempts, runs, provenance, protocol = PROTOCOL }) {
  const arms = {}, heldOut = {};
  for (const arm of provenance.arms) {
    arms[arm] = armStatistics({ attempts, runs, arm, split: 'all' });
    heldOut[arm] = armStatistics({ attempts, runs, arm, split: protocol.promotion.split });
  }
  let ineligibleReason = null;
  if (provenance.modelSelection === 'automatic' || provenance.model === 'auto') ineligibleReason = 'automatic-model-selection';
  else if (!attempts.length || attempts.some(row => row.kind !== 'live')) ineligibleReason = 'not-a-complete-live-batch';
  else if (attempts.some(row => row.actualModel !== provenance.model)) ineligibleReason = 'model-identity-not-observed-or-mixed';
  return { arms, heldOut, promotion: scorePromotion(heldOut, { protocol, eligible: !ineligibleReason, ineligibleReason }), limits: protocol.limits };
}
