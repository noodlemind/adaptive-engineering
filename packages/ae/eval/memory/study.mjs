import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolveStudyOutput, runChecks, runPublicChecks, safePath, scopeResult, snapshot, trialEnvironment, writeFiles } from '../context/study.mjs';
import { KNOWLEDGE_FEEDBACK_STATES, KNOWLEDGE_MODES, readFeedbackConfig, readStoreConfig, repoId, storeDir, writeFeedbackConfig, writeStoreConfig } from '../../lib/knowledge/store.mjs';
import { applyOps } from '../../lib/knowledge/apply.mjs';
import { runOrient } from '../../lib/orient.mjs';
import { repeatEvidenceFromServed } from '../../lib/repeat-mistake.mjs';
import { ensureHarnessDir } from '../../lib/session.mjs';
import { publicVerifierSource } from '../context/check.mjs';

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
      if (task.trap && !task.checks.some(check => !check.trap)) throw new TypeError(`trap task ${task.id} needs a non-trap private check, so an unsolved task is not scored as a recurrence`);
      if (task.publicChecks.some(check => check.trap)) throw new TypeError(`task ${task.id} must keep trap checks private`);
      if (task.publicChecks.some(check => check.throws || check.absent || check.synchronous)) throw new TypeError(`task ${task.id} public checks must be plain value checks`);
      for (const file of [...task.editable, ...task.seeds, ...Object.keys(task.files || {}), ...task.checks.map(check => check.module)]) safePath(file);
    }
  }
  const shared = [...trapsBySplit['held-out']].filter(trap => trapsBySplit.development.has(trap));
  if (shared.length) throw new TypeError(`held-out series share traps with development series: ${shared.join(', ')}`);
  return catalog;
}

/**
 * Fixture state for task `index`: the series base, earlier tasks as merged, then this task's overlay. Earlier trap tasks
 * keep their stubs: merging their reference would put the trap's fix in the repository as a cue for every arm.
 */
export function seriesState(series, index) {
  return Object.assign({}, series.files, ...series.tasks.slice(0, index).flatMap(task => [task.files || {}, task.trap ? {} : task.reference || {}]), series.tasks[index].files || {});
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

/** The configured origin URL and the effective one after url.*.insteadOf rewriting, which is what repository identity reads. */
function readOrigin(workspace) {
  const read = args => {
    const result = spawnSync('git', args, { cwd: workspace, env: gitEnv(), encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  return { configured: read(['config', '--local', '--get', 'remote.origin.url']), effective: read(['remote', 'get-url', 'origin']) };
}

/** Removes agent-added url rewrites and resets origin; returns whether both readings now match the series origin. */
function restoreOrigin(workspace, expected) {
  const env = gitEnv();
  const rewrites = spawnSync('git', ['config', '--local', '--name-only', '--get-regexp', '^url\\.'], { cwd: workspace, env, encoding: 'utf8' });
  for (const key of new Set((rewrites.stdout || '').split(/\r?\n/).filter(Boolean))) spawnSync('git', ['config', '--local', '--unset-all', key], { cwd: workspace, env });
  const current = readOrigin(workspace);
  const fixed = current.configured === null
    ? spawnSync('git', ['remote', 'add', 'origin', expected], { cwd: workspace, env })
    : spawnSync('git', ['remote', 'set-url', 'origin', expected], { cwd: workspace, env });
  const after = readOrigin(workspace);
  return fixed.status === 0 && after.configured === expected && after.effective === expected;
}

/** Arms whose knowledge mode writes memory. Only they inherit earlier tasks' docs/solutions notes. */
export const capturesMemory = arm => arm.mode === 'on' || arm.mode === 'suggest' || arm.mode === 'capture-only';

/**
 * Fresh checkout of the series state for one task, with carried-forward episodes committed and origin pinned before any ae command.
 * Agent-reachable material (workspace, empty HOME, runtime wrapper) lives under `runRoot`. Private checks stay in this
 * process's memory and reach the checker on stdin, so no file holds them while an agent runs.
 */
export function prepareTask({ series, index, runRoot, carried = {}, extraFiles = {}, origin = seriesOrigin(series.id), copilotHome, harnessHome }) {
  const task = series.tasks[index];
  const trial = path.join(runRoot, `t${index + 1}`);
  fs.mkdirSync(trial);
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
  fs.writeFileSync(path.join(control, 'context-verify.mjs'), publicVerifierSource(task.publicChecks), { mode: 0o444 });
  const checkerHash = hash(fs.readFileSync(checker));
  const checkText = JSON.stringify({ checks: task.checks });
  const env2 = trialEnvironment({ trial, copilotHome, harnessHome });
  // The agent gets an empty HOME and its own temporary directory for this task only; the ae wrapper keeps its pinned homes.
  const agentHome = path.join(trial, 'home');
  const agentTemp = path.join(trial, 'tmp');
  fs.mkdirSync(agentHome); fs.mkdirSync(agentTemp);
  env2.HOME = agentHome; env2.USERPROFILE = agentHome;
  env2.TMPDIR = agentTemp; env2.TMP = agentTemp; env2.TEMP = agentTemp;
  const fixture = {
    series, task, index, trial, workspace, copilotHome, harnessHome, origin, env: env2,
    verifyCmd: `"${process.execPath}" .harness/context-verify.mjs`,
    checkText, checkHash: hash(checkText), checkerHash,
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

/** Project-store directory for the series identity, independent of the workspace's current origin. */
const projectDirFor = (home, identity) => path.join(home, 'projects', path.basename(identity.storeDir));

/** Episode-shaped files (Markdown notes under docs/solutions) in the workspace and in the series project store. */
function episodeHashes(workspace, projectDir) {
  const roots = { workspace: path.join(workspace, PROTOCOL.carryForward), project: path.join(projectDir, 'docs', 'solutions') };
  const hashes = {};
  for (const [label, root] of Object.entries(roots)) {
    for (const [rel, file] of Object.entries(listFiles(root))) if (rel.endsWith('.md')) hashes[`${label}:${rel}`] = hash(fs.readFileSync(file));
  }
  return hashes;
}

/**
 * Plans persisted outside the checkout survive between tasks through the shared home; every arm clears them before a task.
 * Every path component from the harness home down must be a real directory that resolves inside the harness home, so a
 * planted symlink cannot redirect the deletion. A refused clear is reported and makes the attempt invalid.
 */
export function clearExternalPlans(harnessHome, projectDir) {
  const home = fs.realpathSync(harnessHome);
  let cleared = 0;
  const refused = [];
  for (const rel of ['plans', path.join('docs', 'plans')]) {
    const target = path.join(projectDir, rel);
    const parts = path.relative(harnessHome, target).split(path.sep);
    if (parts[0] === '..' || path.isAbsolute(path.relative(harnessHome, target))) { refused.push(rel); continue; }
    let current = harnessHome, ok = true, exists = true;
    for (const part of parts) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); } catch { exists = false; break; }
      if (stat.isSymbolicLink() || !stat.isDirectory()) { ok = false; break; }
    }
    if (!ok) { refused.push(rel); continue; }
    if (!exists) continue;
    const real = fs.realpathSync(target);
    if (path.relative(home, real).startsWith('..') || path.isAbsolute(path.relative(home, real))) { refused.push(rel); continue; }
    cleared += Object.keys(listFiles(real)).length;
    fs.rmSync(real, { recursive: true, force: true });
  }
  return { cleared, refused };
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

/** Writes the series seed learning while the store is briefly on. The seed episode must already be committed. */
export function seedStore({ workspace, home, series }) {
  if (!series.seed?.op || !series.seed?.episode) throw new TypeError(`series ${series.id} has no seed`);
  const set = writeStoreConfig(workspace, { home, mode: 'on' });
  if (!set.pass) throw new Error(`seed configuration failed: ${set.blockedReason}`);
  const episode = { path: series.seed.episode.path, sha256: hash(series.seed.episode.content), kind: 'fix', plan: null };
  const result = applyOps({ workspace, home, operations: { schema: 1, ops: [{ op: 'ADD', ...series.seed.op, episodes: [episode] }] } });
  if (result.applied?.length !== 1) throw new Error(`seed learning was not applied: ${JSON.stringify(result.rejected || []).slice(0, 500)}`);
  return `${series.seed.op.domain}/${series.seed.op.slug}`;
}

/** Sets the arm's knowledge mode and feedback state. Runs before every task, so an agent-made change never carries over. */
export function configureArm({ workspace, home, arm, series, seed = false }) {
  let seeded = null;
  if (arm.seed && seed) seeded = seedStore({ workspace, home, series });
  const mode = writeStoreConfig(workspace, { home, mode: arm.mode });
  if (!mode.pass) throw new Error(`knowledge mode configuration failed: ${mode.blockedReason}`);
  const feedback = writeFeedbackConfig(workspace, { home, feedback: arm.feedback ?? 'off' });
  if (!feedback.pass) throw new Error(`feedback configuration failed: ${feedback.blockedReason}`);
  return { seeded };
}

/** Pass result for the trap (or non-trap) checks of a task, from one checker run's per-check verdicts. */
function subsetResult(task, result, trap) {
  const verdicts = task.checks.map((check, index) => [Boolean(check.trap) === trap, result.verdicts?.[index]]).filter(([selected]) => selected).map(([, verdict]) => verdict);
  return { pass: result.integrity !== false && verdicts.length > 0 && verdicts.every(verdict => verdict === true), verdicts };
}

/** Knowledge mode and feedback state stored for an identity, read by directory so an agent-changed origin cannot redirect the read. */
function storedConfig(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    return { mode: KNOWLEDGE_MODES.has(parsed?.mode) ? parsed.mode : 'on', feedback: KNOWLEDGE_FEEDBACK_STATES.has(parsed?.feedback) ? parsed.feedback : 'off' };
  } catch {
    return { mode: 'on', feedback: 'off' };
  }
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
    runtimeIsolation: 'candidate-cli-v1', agentIsolation: 'per-run-temporary-root-v2',
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim(),
    sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: here, encoding: 'utf8' }).trim()),
    profile: protocol.profile, publicVerifier: protocol.publicVerifier, maxTurns: protocol.maxTurns, maxSeconds: protocol.maxSeconds,
    repeats, arms, series: series.map(item => item.id), origin: protocol.origin, carryForward: protocol.carryForward,
  };
  provenance.configHash = hash(JSON.stringify(provenance));
  provenance.sourceHash = hash(execFileSync('git', ['ls-files', '-z', 'packages/ae/lib', 'packages/ae/bin', 'packages/ae/corpus', 'packages/ae/eval/context', 'packages/ae/eval/memory'], { cwd: repoRoot }).toString().split('\0').filter(Boolean).map(file => `${file}:${hash(fs.readFileSync(path.resolve(repoRoot, file)))}`).join('\n'));
  provenance.batch = hash(`${provenance.configHash}:${provenance.sourceHash}:${randomBytes(8).toString('hex')}`);
  return provenance;
}

const STUDY_PREFIX = 'aem-study-';
const STUDY_NAME = /^aem-study-(\d+)-[A-Za-z0-9]{6}$/;

/**
 * Removes study parents left by runner processes that no longer exist (for example after SIGKILL). The owner PID is part of
 * the folder name, so there is no window in which a fresh parent lacks an owner. Folders that cannot be removed (for example
 * another user's) are skipped, never fatal.
 */
export function sweepStaleStudies(base = os.tmpdir()) {
  const swept = [];
  let names = [];
  try { names = fs.readdirSync(base); } catch { return swept; }
  for (const name of names) {
    const match = STUDY_NAME.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    let alive = false;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
    }
    if (alive) continue;
    const dir = path.join(base, name);
    try { fs.rmSync(dir, { recursive: true, force: true }); swept.push(dir); } catch { /* not ours to remove */ }
  }
  return swept;
}

/**
 * One temporary parent per study, removed on normal exit and on SIGINT/SIGTERM. Run roots are created inside it.
 * `onAbort` runs on a signal after the parent (and so every checkout) is gone, to save what the study has recorded.
 */
function openStudyParent({ base = os.tmpdir(), onAbort = () => {} } = {}) {
  sweepStaleStudies(base);
  const parent = fs.mkdtempSync(path.join(base, `${STUDY_PREFIX}${process.pid}-`));
  const remove = () => { try { fs.rmSync(parent, { recursive: true, force: true }); } catch { /* best effort */ } };
  const onSignal = signal => {
    remove();
    try { onAbort(signal); } catch { /* best effort */ }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('exit', remove);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return { parent, close() { remove(); process.off('exit', remove); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); } };
}

/**
 * Writes attempt records and results. Attempt records carry checker diagnostics with expected values, so this runs only after
 * the study parent (every checkout and agent-facing file) is gone. A partial write follows a crash or signal; it has no summary.
 */
function writeStudyOutput({ root, provenance, runs, attempts, protocol, partial }) {
  for (const attempt of attempts) {
    const dir = path.join(root, 'attempts', attempt.run);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `t${attempt.taskIndex}-${attempt.task}.json`), JSON.stringify(attempt, null, 2));
  }
  const output = partial
    ? { schema: 1, partial: true, provenance, runs, attempts, summary: null }
    : { schema: 1, provenance, runs, attempts, summary: summarizeStudy({ attempts, runs, provenance, protocol }) };
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(output, null, 2));
  return output;
}

/**
 * Runs every (series, arm, repeat) with one harness home shared across the series's tasks and a fresh checkout per task.
 * Each run's agent-facing files live in a fresh temporary root outside `root`, deleted after the run; each task's checkout
 * is deleted after its attempt, so an agent cannot casually list sibling runs, earlier tasks or private checks. This guards
 * against casual leakage only: an agent running as this user can read this process's memory. Real protection needs a
 * separate user ID or a sandbox. `studyBase` sets where the study parent is created (tests use a private directory).
 * `originFor(series, index)` lets tests prove identity drift is caught; `inspect(fixture, attempt)` lets tests look at a
 * task before its checkout is removed. Production runs use neither.
 */
export async function runStudy({ root, catalog = CATALOG, protocol = PROTOCOL, arms = runnableArms(protocol), repeats = protocol.repeats, split = 'all', dryRun = false, execute, model = null, host = null, originFor = series => seriesOrigin(series.id), inspect = null, studyBase = os.tmpdir() }) {
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
  const attempts = [];
  const runs = [];
  let finished = false, owned = false;
  // The study parent opens first, so a failure there leaves no provenance.json behind to block a retry into the same root.
  // Partial output is written only into a root this study claimed with provenance.json, never over another study's results.
  const study = openStudyParent({ base: studyBase, onAbort: () => { if (owned) writeStudyOutput({ root, provenance, runs, attempts, protocol, partial: true }); } });
  try {
  fs.writeFileSync(path.join(root, 'provenance.json'), JSON.stringify(provenance, null, 2), { flag: 'wx' });
  owned = true;
  for (const [seriesIndex, item] of series.entries()) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const offset = (seriesIndex + repeat) % arms.length;
      for (const armId of [...arms.slice(offset), ...arms.slice(0, offset)]) {
        const arm = armById(protocol, armId);
        const runId = `${item.id}-${armSlug(armId)}-r${repeat + 1}`;
        const runRoot = fs.mkdtempSync(path.join(study.parent, 'run-'));
        const copilotHome = path.join(runRoot, 'copilot');
        const harnessHome = path.join(runRoot, 'state');
        for (const dir of [copilotHome, harnessHome]) fs.mkdirSync(dir);
        let carried = {};
        let first = null;
        let seeded = null;
        const runAttempts = [];
        try {
          for (let index = 0; index < item.tasks.length; index++) {
            const task = item.tasks[index];
            const extraFiles = arm.seed ? { [item.seed.episode.path]: item.seed.episode.content } : {};
            const fixture = prepareTask({ series: item, index, runRoot, carried, extraFiles, origin: originFor(item, index), copilotHome, harnessHome });
            const configured = configureArm({ workspace: fixture.workspace, home: harnessHome, arm, series: item, seed: index === 0 });
            if (index === 0) seeded = configured.seeded;
            const identity = { repoId: repoId(fixture.workspace), storeDir: storeDir(fixture.workspace, { home: harnessHome }) };
            if (!first) first = identity;
            const projectDir = projectDirFor(harnessHome, first);
            const plans = clearExternalPlans(harnessHome, projectDir);
            const before = { ...storedConfig(identity.storeDir), observed: readStoreConfig(fixture.workspace, { home: harnessHome }).mode, feedbackObserved: readFeedbackConfig(fixture.workspace, { home: harnessHome }) };
            const baseline = await runChecks(fixture);
            const publicBaseline = runPublicChecks(fixture);
            const trapBaseline = task.trap ? subsetResult(task, baseline, true) : null;
            if (baseline.pass || !baseline.integrity || baseline.error || baseline.verdicts.some(verdict => verdict === null) || publicBaseline?.pass || publicBaseline?.error || trapBaseline?.pass) throw new Error(`invalid broken baseline: ${runId} task ${index + 1}`);
            const episodesBefore = episodeHashes(fixture.workspace, projectDir);
            const injection = plannedInjection({ workspace: fixture.workspace, copilotHome, home: harnessHome, task });
            const startedAt = Date.now();
            let result = {}, error = null;
            if (!dryRun) {
              try { result = await execute({ ...fixture, arm, repeat: repeat + 1, model, protocol, injection }) || {}; }
              catch (caught) { error = String(caught.message).slice(0, 2000); }
            }
            // A dry run changes nothing, so the baseline checks above already describe its workspace.
            const checks = dryRun ? null : await runChecks(fixture);
            // One checker run scores the whole task; trap and non-trap results are subsets of its per-check verdicts.
            const trapChecks = dryRun || !task.trap ? null : subsetResult(task, checks, true);
            const otherChecks = dryRun || !task.trap ? null : subsetResult(task, checks, false);
            const scope = scopeResult(fixture);
            // Harness state is an expected write. Notes under docs/solutions are expected for every arm; only capturing arms carry them forward.
            const unexpected = scope.unexpected.filter(file => !file.startsWith('.harness/') && !file.startsWith(`${protocol.carryForward}/`));
            const originAfter = readOrigin(fixture.workspace);
            const originUnchanged = originAfter.configured === fixture.origin && originAfter.effective === fixture.origin;
            // Read every after-state through the series identity, never through an origin the agent may have changed.
            const originRestored = originUnchanged || restoreOrigin(fixture.workspace, fixture.origin);
            const after = storedConfig(first.storeDir);
            const episodesAfter = episodeHashes(fixture.workspace, projectDir);
            const episodesWritten = Object.keys(episodesAfter).filter(key => episodesBefore[key] !== episodesAfter[key]).length;
            const kind = dryRun ? 'dry-run' : error ? 'runtime-error' : host === 'scripted-test' ? 'scripted' : 'live';
            const executed = kind === 'live' || kind === 'scripted';
            const invalidReasons = [
              identity.repoId !== first.repoId && 'repo-identity-drift',
              identity.storeDir !== first.storeDir && 'store-directory-drift',
              before.observed !== arm.mode && 'knowledge-mode-mismatch',
              before.feedbackObserved !== (arm.feedback ?? 'off') && 'feedback-state-mismatch',
              plans.refused.length > 0 && 'external-plans-not-cleared',
              !originRestored && 'origin-restore-failed',
            ].filter(Boolean);
            const valid = invalidReasons.length === 0;
            const modeUnchanged = after.mode === arm.mode && after.feedback === (arm.feedback ?? 'off');
            const usage = usageOf(result);
            let repeatMistake = null;
            if (executed && valid && task.trap) {
              const evidence = repeatEvidenceFromServed({ workspace: fixture.workspace, home: harnessHome, session: { lastQuery: memoryPrompt(task), files: task.seeds }, delivered: addedDiff(fixture.workspace, task.editable) });
              repeatMistake = { flagged: evidence.length > 0, learnings: evidence.map(row => row.learning) };
            }
            // A recurrence is scored only when the rest of the task was solved; an unsolved task says nothing about the trap.
            const scorable = executed && valid && task.trap === 'recurrence';
            const attempt = {
              batch: provenance.batch,
              id: `${runId}-t${index + 1}`, run: runId, series: item.id, split: item.split, trapId: item.trap.id, arm: armId, repeat: repeat + 1,
              task: task.id, taskIndex: index + 1, trapRole: task.trap ?? null, kind, valid, invalidReasons,
              pass: executed && valid && result.status === 'ok' && checks?.pass === true && unexpected.length === 0 && originUnchanged && modeUnchanged,
              baseline, publicBaseline, trapBaseline, checks, trapChecks, otherChecks,
              trapRecurred: scorable && otherChecks?.pass ? !trapChecks.pass : null,
              recurrenceUnscored: scorable && !otherChecks?.pass ? 'rest-of-task-unsolved' : null,
              trapFirstFailed: executed && valid && task.trap === 'first' && otherChecks?.pass ? !trapChecks.pass : null,
              repeatMistake,
              scope: { ...scope, pass: unexpected.length === 0, unexpected },
              origin: { expected: fixture.origin, after: originAfter, unchanged: originUnchanged },
              repoId: identity.repoId, storeDir: identity.storeDir, knowledgeMode: before.observed, feedback: before.feedbackObserved,
              knowledgeModeAfter: after.mode, feedbackAfter: after.feedback, configChangedByAgent: !modeUnchanged, seeded,
              carriedForward: fixture.carriedForward, externalPlansCleared: plans.cleared, externalPlansRefused: plans.refused,
              learningsInjected: injection.learnings, learningsBytes: injection.learningsBytes, injectionError: injection.error,
              episodesWritten,
              turns: Number.isInteger(result.turnCount) ? result.turnCount : Array.isArray(result.turns) ? result.turns.length : null,
              inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, usageCoverage: usage.coverage,
              requestedModel: result.model ?? model, observedModels: usage.observedModels, actualModel: usage.actualModel, provider: result.provider ?? null,
              status: result.status ?? null, stopReason: result.stopReason ?? null, error, durationMs: Date.now() - startedAt,
            };
            attempts.push(attempt);
            runAttempts.push(attempt);
            carried = capturesMemory(arm) ? collectCarryForward(fixture.workspace) : {};
            if (inspect) await inspect(fixture, attempt);
            fs.rmSync(fixture.trial, { recursive: true, force: true });
          }
        } finally {
          fs.rmSync(runRoot, { recursive: true, force: true });
        }
        runs.push({ id: runId, series: item.id, split: item.split, arm: armId, repeat: repeat + 1,
          measured: runAttempts.every(row => row.valid && (row.kind === 'live' || row.kind === 'scripted')),
          episodesWritten: runAttempts.reduce((sum, row) => sum + row.episodesWritten, 0) });
      }
    }
  }
  finished = true;
  } finally {
    study.close();
    // A crash still saves every finished attempt, marked partial; a normal end writes the full results below.
    if (!finished && owned) writeStudyOutput({ root, provenance, runs, attempts, protocol, partial: true });
  }
  return writeStudyOutput({ root, provenance, runs, attempts, protocol, partial: false });
}

function rate(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

/** Per-arm statistics on one split; the promotion rule reads the held-out split. */
export function armStatistics({ attempts, runs, arm, split }) {
  const rows = attempts.filter(row => row.arm === arm && (split === 'all' || row.split === split));
  // Dry runs, runtime errors and invalid attempts never count as measured task outcomes.
  const valid = rows.filter(row => row.valid && (row.kind === 'live' || row.kind === 'scripted'));
  const recurrence = valid.filter(row => row.trapRecurred !== null);
  const armRuns = runs.filter(row => row.arm === arm && row.measured && (split === 'all' || row.split === split));
  const batches = new Set(valid.map(row => row.batch));
  const recurrenceRows = valid.filter(row => row.trapRole === 'recurrence');
  const complete = field => valid.length > 0 && valid.every(row => row.usageCoverage === 'complete' && Number.isFinite(row[field]));
  return {
    // Every scored row must come from one batch; mixed or unstamped rows leave no batch and fail the same-batch rule.
    batch: batches.size === 1 && !batches.has(undefined) ? [...batches][0] : null,
    attempts: rows.length, measuredAttempts: valid.length, invalidAttempts: rows.filter(row => !row.valid).length,
    heldOutAttempts: split === 'held-out' ? valid.length : valid.filter(row => row.split === 'held-out').length,
    passed: valid.filter(row => row.pass).length, passRate: rate(valid.filter(row => row.pass).length, valid.length),
    recurrenceAttempts: recurrence.length, recurred: recurrence.filter(row => row.trapRecurred).length,
    recurrenceRate: rate(recurrence.filter(row => row.trapRecurred).length, recurrence.length),
    recurrenceUnscored: valid.filter(row => row.recurrenceUnscored).length,
    unscoredRate: rate(valid.filter(row => row.recurrenceUnscored).length, recurrenceRows.length),
    configChangedByAgent: valid.filter(row => row.configChangedByAgent).length,
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

function logChoose(n, k) {
  let total = 0;
  for (let i = 1; i <= k; i++) total += Math.log(n - k + i) - Math.log(i);
  return total;
}

/** One-sided Fisher exact test: probability of the candidate recurring this rarely or less if both arms shared one rate. */
export function fisherOneSided({ candidateRecurred, candidateObservations, referenceRecurred, referenceObservations }) {
  const recurred = candidateRecurred + referenceRecurred;
  const total = candidateObservations + referenceObservations;
  const denominator = logChoose(total, candidateObservations);
  let p = 0;
  for (let x = Math.max(0, candidateObservations - (total - recurred)); x <= candidateRecurred; x++) {
    p += Math.exp(logChoose(recurred, x) + logChoose(total - recurred, candidateObservations - x) - denominator);
  }
  return Math.min(1, p);
}

/** One arm against one reference arm, per the protocol's promotion thresholds. */
export function compareArms(candidate, reference, limits = PROTOCOL.promotion) {
  const reasons = [];
  if (limits.requireSameBatchBaseline && (!candidate.batch || candidate.batch !== reference.batch)) reasons.push('reference-not-in-same-batch');
  if (!(candidate.heldOutAttempts >= limits.minimumHeldOutAttemptsPerArm && reference.heldOutAttempts >= limits.minimumHeldOutAttemptsPerArm)) reasons.push('insufficient-held-out-attempts');
  if (!(candidate.recurrenceAttempts >= limits.minimumRecurrenceObservationsPerArm && reference.recurrenceAttempts >= limits.minimumRecurrenceObservationsPerArm)) reasons.push('insufficient-recurrence-observations');
  if (limits.requireCompleteObservedUsage && (candidate.usageCoverage !== 'complete' || reference.usageCoverage !== 'complete')) reasons.push('incomplete-observed-usage');
  let reduction = null, pValue = null;
  if (!Number.isFinite(candidate.recurrenceRate) || !Number.isFinite(reference.recurrenceRate)) reasons.push('recurrence-unmeasured');
  else if (!(reference.recurrenceRate > 0)) reasons.push('reference-has-no-recurrence');
  else {
    reduction = (reference.recurrenceRate - candidate.recurrenceRate) / reference.recurrenceRate;
    if (reduction < limits.minimumRelativeTrapRecurrenceReduction - TOLERANCE) reasons.push('recurrence-reduction-below-threshold');
    pValue = fisherOneSided({ candidateRecurred: candidate.recurred, candidateObservations: candidate.recurrenceAttempts, referenceRecurred: reference.recurred, referenceObservations: reference.recurrenceAttempts });
    if (!(pValue <= limits.maximumRecurrenceTestPValue)) reasons.push('recurrence-reduction-not-significant');
  }
  const unscoredDifference = Number.isFinite(candidate.unscoredRate) && Number.isFinite(reference.unscoredRate) ? candidate.unscoredRate - reference.unscoredRate : null;
  if (unscoredDifference !== null && Math.abs(unscoredDifference) > limits.maximumUnscoredRateDifference + TOLERANCE) reasons.push('unscored-rates-differ');
  const passDifference = Number.isFinite(candidate.passRate) && Number.isFinite(reference.passRate) ? candidate.passRate - reference.passRate : null;
  if (passDifference === null) reasons.push('pass-rate-unmeasured');
  else if (passDifference < -limits.passRateNonInferiorityMargin - TOLERANCE) reasons.push('pass-rate-regressed');
  if (limits.episodesMayRiseOnlyIfRecurrenceFalls && candidate.episodesPerSeries > reference.episodesPerSeries && !(candidate.recurrenceRate < reference.recurrenceRate)) reasons.push('episodes-rose-without-recurrence-falling');
  return { pass: reasons.length === 0, relativeRecurrenceReduction: reduction, recurrencePValue: pValue, passRateDifference: passDifference,
    candidateUnscoredRate: candidate.unscoredRate ?? null, referenceUnscoredRate: reference.unscoredRate ?? null, unscoredRateDifference: unscoredDifference, reasons };
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
  else if (attempts.some(row => !row.valid)) ineligibleReason = 'invalid-attempts-in-batch';
  else if (attempts.some(row => row.actualModel !== provenance.model)) ineligibleReason = 'model-identity-not-observed-or-mixed';
  return { arms, heldOut, promotion: scorePromotion(heldOut, { protocol, eligible: !ineligibleReason, ineligibleReason }), limits: protocol.limits };
}
