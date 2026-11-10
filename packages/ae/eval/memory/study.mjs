import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { killLiveGroups, resolveStudyOutput, runChecks, runGroupedProcess, runPublicChecks, safePath, scopeResult, snapshot, trialEnvironment, writeFiles } from '../context/study.mjs';
import { KNOWLEDGE_FEEDBACK_STATES, KNOWLEDGE_MODES, readFeedbackConfig, readStoreConfig, repoId, storeDir, writeFeedbackConfig, writeStoreConfig } from '../../lib/knowledge/store.mjs';
import { applyOps } from '../../lib/knowledge/apply.mjs';
import { runOrient } from '../../lib/orient.mjs';
import { repeatEvidenceFromServed } from '../../lib/repeat-mistake.mjs';
import { ensureHarnessDir } from '../../lib/session.mjs';
import { publicVerifierSource } from '../context/check.mjs';
import { configureCheckConfiguration, inspectCheckConfiguration } from '../../lib/check-configuration.mjs';
import { approveProject } from '../../lib/trust.mjs';

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
  if (!Number.isSafeInteger(protocol.checkerTimeoutMs) || protocol.checkerTimeoutMs <= 0) throw new TypeError('protocol checkerTimeoutMs must be a positive integer');
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
      if (task.publicChecks.some(check => check.throws != null || check.absent != null || check.synchronous != null)) throw new TypeError(`task ${task.id} public checks must be plain value checks`);
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

/**
 * Runs an agent process in its own process group (POSIX), so a background process the agent started cannot outlive its task.
 * The group is killed once when the agent exits, and on timeout or output overflow; see `runGroupedProcess`. A process that
 * started its own session escapes the group kill, but the next task's fresh homes never hold anything it can still reach.
 */
export const runAgentProcess = runGroupedProcess;

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

/**
 * Arms whose later tasks may read what earlier tasks captured. Only they inherit earlier tasks' docs/solutions notes.
 * `capture-only` writes memory but must not read it back, so it carries nothing forward.
 */
export const readsCapturedMemory = arm => arm.mode === 'on' || arm.mode === 'suggest';

/**
 * Arms whose recallable memory is fixed for the whole run: every arm that does not read captured memory. `stateless` keeps
 * the empty state it started with, `capture-only` keeps the state it started with, and `frozen-seed` (mode freeze) keeps
 * its seeded state. Compound still writes episodes in capture-only and freeze, an agent in any arm can turn knowledge on and
 * compound before turning it off again, and orient recalls episodes whatever the knowledge mode, so every later task's fresh
 * homes get the first task's memory, captured after configuration and before its agent ran.
 */
export const fixesRecallableMemory = arm => !readsCapturedMemory(arm);

const MEMORY_FILE_LIMIT = 2000;
const MEMORY_BYTE_LIMIT = 32 * 1024 * 1024;
const OPEN_NO_FOLLOW = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * The memory carried from one task's homes into the next task's fresh homes, as [root, path under root]: the project
 * store's episodes (docs/solutions), the recall manifest, its postings index and the learnings store (harnessHome/knowledge,
 * every storage id), which holds the learnings and the knowledge mode and feedback config. Nothing else in the homes is
 * carried: storage aliases, plans, todos, feedback records, trust and check configuration all start fresh in every task.
 */
function memoryTargets({ copilotHome, harnessHome, projectDir }) {
  return [[copilotHome, 'knowledge'], [harnessHome, 'index'], [harnessHome, 'knowledge'], [harnessHome, path.relative(harnessHome, path.join(projectDir, 'docs', 'solutions'))]];
}

const refusal = message => Object.assign(new Error(message), { refusal: true });

/**
 * Reads the carried memory of one task's homes into this process's memory, as validated regular files and directories, so
 * nothing an agent does afterwards can change the copy. Every path is checked with lstat, every directory's realpath must
 * still be its place under the home, and every file is opened without following a final symlink and checked again on the
 * open descriptor. A symlink, a special file, an unreadable entry, or a capture over the file count or byte limit refuses
 * its target: the target is left out and `refused` names it, which makes the next attempt invalid. An absent target is
 * recorded as absent.
 */
export function captureMemory(homes) {
  const refused = [];
  const targets = [];
  let entries = 0, bytes = 0;
  for (const [slot, [root, rel]] of memoryTargets(homes).entries()) {
    const key = rel.split(path.sep).join('/');
    try {
      const rootStat = fs.lstatSync(root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw refusal('home is not a real directory');
      const rootReal = fs.realpathSync(root);
      let current = root, absent = false;
      for (const part of rel.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        const stat = fs.lstatSync(current, { throwIfNoEntry: false });
        if (!stat) { absent = true; break; }
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw refusal(`${path.relative(root, current).split(path.sep).join('/')} is not a real directory`);
      }
      if (absent) { targets.push({ slot, rel, entries: null }); continue; }
      const saved = [];
      const walk = sub => {
        const dir = path.join(root, rel, sub);
        if (fs.realpathSync(dir) !== path.join(rootReal, rel, sub)) throw refusal(`${sub || '.'} resolves outside the home`);
        for (const name of fs.readdirSync(dir).sort()) {
          const entryRel = sub ? path.join(sub, name) : name;
          const full = path.join(dir, name);
          const stat = fs.lstatSync(full);
          if (++entries > MEMORY_FILE_LIMIT) throw refusal('more files than the memory limit');
          if (stat.isDirectory()) { saved.push({ path: entryRel, directory: true }); walk(entryRel); continue; }
          if (!stat.isFile()) throw refusal(`${entryRel.split(path.sep).join('/')} is a symlink or special file`);
          const fd = fs.openSync(full, OPEN_NO_FOLLOW);
          let content;
          try {
            if (!fs.fstatSync(fd).isFile()) throw refusal(`${entryRel.split(path.sep).join('/')} is not a regular file`);
            content = fs.readFileSync(fd);
          } finally { fs.closeSync(fd); }
          bytes += content.length;
          if (bytes > MEMORY_BYTE_LIMIT) throw refusal('more bytes than the memory limit');
          saved.push({ path: entryRel, content });
        }
      };
      walk('');
      targets.push({ slot, rel, entries: saved });
    } catch (error) {
      refused.push(`${key}: ${error.refusal ? error.message : `unreadable (${error.code || error.message})`}`);
    }
  }
  return { targets, refused };
}

/**
 * Writes captured memory into a task's fresh homes. The runner made those homes moments earlier under an unpredictable name
 * and no agent has run in them, so there is nothing to remove first; every file is created exclusively.
 */
export function writeMemory(homes, captured) {
  for (const [slot, [root, rel]] of memoryTargets(homes).entries()) {
    const target = captured.targets.find(row => row.slot === slot && row.rel === rel);
    if (!target?.entries) continue;
    const base = path.join(root, rel);
    fs.mkdirSync(base, { recursive: true });
    for (const entry of target.entries) {
      const full = path.join(base, entry.path);
      if (entry.directory) fs.mkdirSync(full, { recursive: true });
      else fs.writeFileSync(full, entry.content, { flag: 'wx' });
    }
  }
}

/** Named check that runs the runner-supplied public verifier; the Deliver completion gate needs named evidence. */
export const PUBLIC_CHECK = 'public-checks';

/**
 * Operator setup before an agent runs: registers the public verifier as the named check PUBLIC_CHECK in the series project
 * authority under the harness home, then approves project trust for this checkout. The runner grants trust as the operator;
 * the agent itself may only read trust status. Without both, `ae verify` reports the check unavailable and a correct Deliver
 * run can never finish with status ok. Runs in every task, because every task starts from fresh homes.
 */
export function authorizeFixtureChecks({ workspace, copilotHome, harnessHome }) {
  const current = inspectCheckConfiguration({ workspace, home: harnessHome });
  configureCheckConfiguration({ workspace, home: harnessHome, copilotHome, input: {
    schema: 1, expectedDigest: current.sourceDigest, rationale: 'Memory study operator: the runner-supplied public verifier for this fixture.',
    checks: { [PUBLIC_CHECK]: { command: [process.execPath, '.harness/context-verify.mjs'], proof: 'behavior' } },
  } });
  const trust = approveProject({ workspace, copilotHome, home: harnessHome });
  if (!trust.trusted) throw new Error('fixture trust approval did not take effect');
  return { check: PUBLIC_CHECK, trust };
}

/**
 * Fresh checkout of the series state for one task, with carried-forward episodes committed and origin pinned before any ae command.
 * Agent-reachable material (workspace, empty HOME, runtime wrapper) lives under `runRoot`, the task's own root, which the
 * study creates with an unpredictable name next to that task's fresh homes. Private checks stay in this
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
  const checkText = JSON.stringify({ checks: scoredChecks(task) });
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

/** Regular files under `root`, never following a symlink: `root` and every directory walked are lstat'd, and links are skipped. */
function listFiles(root, base = '') {
  const found = {};
  let entries;
  try {
    if (!fs.lstatSync(path.join(root, base)).isDirectory()) return found;
    entries = fs.readdirSync(path.join(root, base));
  } catch { return found; }
  for (const name of entries) {
    const rel = path.posix.join(base, name);
    let stat;
    try { stat = fs.lstatSync(path.join(root, rel)); } catch { continue; }
    if (stat.isDirectory()) Object.assign(found, listFiles(root, rel));
    else if (stat.isFile()) found[rel] = path.join(root, rel);
  }
  return found;
}

/**
 * Regular files under `base/rel` as a real checkout would hold them: every path component from `base` down must be a real
 * directory, not a symlink, so a linked `docs` or `docs/solutions` cannot pull files from outside into the count or the next task.
 */
function filesInside(base, rel) {
  let current = base;
  for (const part of rel.split('/').filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch { return {}; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return {};
  }
  return listFiles(current);
}

/** Episode-shaped files (Markdown notes under docs/solutions, .md or .markdown in any case) in the workspace and in the series project store. */
export function episodeHashes(workspace, projectDir) {
  const roots = { workspace: [workspace, PROTOCOL.carryForward], project: [projectDir, 'docs/solutions'] };
  const hashes = {};
  for (const [label, [base, sub]] of Object.entries(roots)) {
    for (const [rel, file] of Object.entries(filesInside(base, sub))) if (/\.(md|markdown)$/i.test(rel)) hashes[`${label}:${rel}`] = hash(fs.readFileSync(file));
  }
  return hashes;
}

/**
 * Plans kept outside the checkout. Every task starts from fresh homes, so none should exist; the clear stays as a check.
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
  for (const [rel, file] of Object.entries(filesInside(workspace, PROTOCOL.carryForward)).sort(([a], [b]) => a.localeCompare(b)).slice(0, CARRY_FILE_LIMIT)) {
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

/**
 * Checks the private checker runs for a task: its private checks, then its public examples. The public examples run there
 * too, from this process's copy, so a constant answer that passes the edge-case private checks but fails the public examples
 * is an unsolved task, not a trap recurrence, and a changed workspace verifier cannot fake them.
 */
export const scoredChecks = task => [...task.checks, ...task.publicChecks];

/** Files under `.harness/` that the runner supplies; any change to them is a scope violation, unlike ordinary Harness state. */
export const SUPPLIED_FILES = Object.freeze(['.harness/context-verify.mjs']);

/** Pass result for the trap (or non-trap) checks of a task, from one checker run's per-check verdicts. Public examples count as non-trap. */
function subsetResult(task, result, trap) {
  const verdicts = scoredChecks(task).map((check, index) => [Boolean(check.trap) === trap, result.verdicts?.[index]]).filter(([selected]) => selected).map(([, verdict]) => verdict);
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
    runtimeIsolation: 'candidate-cli-v1', agentIsolation: 'per-task-fresh-homes-v3',
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim(),
    sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: here, encoding: 'utf8' }).trim()),
    profile: protocol.profile, publicVerifier: protocol.publicVerifier, maxTurns: protocol.maxTurns, maxSeconds: protocol.maxSeconds,
    checkerTimeoutMs: protocol.checkerTimeoutMs, repeats, arms, series: series.map(item => item.id), origin: protocol.origin, carryForward: protocol.carryForward,
  };
  provenance.configHash = hash(JSON.stringify(provenance));
  provenance.sourceHash = hash(execFileSync('git', ['ls-files', '-z', 'packages/ae/lib', 'packages/ae/bin', 'packages/ae/corpus', 'packages/ae/eval/context', 'packages/ae/eval/memory'], { cwd: repoRoot }).toString().split('\0').filter(Boolean).map(file => `${file}:${hash(fs.readFileSync(path.resolve(repoRoot, file)))}`).join('\n'));
  provenance.batch = hash(`${provenance.configHash}:${provenance.sourceHash}:${randomBytes(8).toString('hex')}`);
  return provenance;
}

const STUDY_PREFIX = 'aem-study-';
const STUDY_NAME = /^aem-study-(\d+)-[A-Za-z0-9]{6}$/;
const LEGACY_STUDY_NAME = /^aem-study-[A-Za-z0-9]{6}$/;

/**
 * Removes study parents left by runner processes that no longer exist (for example after SIGKILL). The owner PID is part of
 * the folder name, so there is no window in which a fresh parent lacks an owner. Folders that cannot be removed (for example
 * another user's) are skipped, never fatal. Parents in the earlier format (no PID in the name) are swept only when their
 * owner.pid names a dead process. PIDs are checked in this PID namespace: runners in other containers that share this
 * temporary directory look dead, so give each container its own temporary directory.
 */
export function sweepStaleStudies(base = os.tmpdir()) {
  const swept = [];
  let names = [];
  try { names = fs.readdirSync(base); } catch { return swept; }
  for (const name of names) {
    const match = STUDY_NAME.exec(name);
    let pid = null;
    if (match) pid = Number(match[1]);
    else if (LEGACY_STUDY_NAME.test(name)) {
      // An empty or malformed owner.pid is skipped: Number('') is 0, which would make a live folder look dead.
      let text;
      try { text = fs.readFileSync(path.join(base, name, 'owner.pid'), 'utf8'); } catch { continue; }
      if (!/^[1-9]\d{0,9}\s*$/.test(text)) continue;
      pid = Number(text);
    } else continue;
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

/** Signals that remove the study parent and end the runner. SIGQUIT does not exist on Windows. */
const STUDY_SIGNALS = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

/**
 * One temporary parent per study, removed on normal exit and on SIGINT, SIGTERM, SIGHUP or SIGQUIT. Run roots are created
 * inside it. `onAbort` runs on a signal after the parent (and so every checkout) is gone, to save what the study has recorded.
 * SIGKILL cannot be caught: it leaves the parent for the next study's sweep and orphans any running agent group.
 */
function openStudyParent({ base = os.tmpdir(), onAbort = () => {} } = {}) {
  sweepStaleStudies(base);
  const parent = fs.mkdtempSync(path.join(base, `${STUDY_PREFIX}${process.pid}-`));
  const remove = () => { killLiveGroups(); try { fs.rmSync(parent, { recursive: true, force: true }); } catch { /* best effort */ } };
  const onSignal = signal => {
    // Agents run detached in their own process groups, so the signal does not reach them; `remove` kills them first.
    remove();
    try { onAbort(signal); } catch { /* best effort */ }
    process.exit(128 + (os.constants.signals[signal] ?? 15));
  };
  process.on('exit', remove);
  for (const signal of STUDY_SIGNALS) process.once(signal, onSignal);
  return { parent, close() { remove(); process.off('exit', remove); for (const signal of STUDY_SIGNALS) process.off(signal, onSignal); } };
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
 * Runs every (series, arm, repeat). Every task gets a new root with an unpredictable name (fs.mkdtempSync) inside the run's
 * temporary root, outside `root`, holding fresh Copilot and harness homes and a fresh checkout. Only the carried memory
 * targets reach a later task's homes, as validated regular files: arms that read captured memory get the previous task's
 * memory, and the other arms get the first task's memory as configured before its agent ran. Everything else in the homes,
 * storage aliases included, starts fresh, and each task's root is deleted once its measurements are read, so an agent cannot
 * casually list sibling runs, earlier tasks or private checks. This guards against casual leakage only: an agent running as
 * this user can read this process's memory. Real protection needs a separate user ID or a sandbox. `studyBase` sets where
 * the study parent is created (tests use a private directory). `originFor(series, index)` lets tests prove identity drift is
 * caught; `inspect(fixture, attempt)` lets tests look at a task before its root is removed. Production runs use neither.
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
        let carried = {};
        // The series identity from task 1: its repository id and its store directory relative to the harness home.
        let first = null;
        let seeded = null;
        // Fixed arms: task 1's memory after configuration. Arms that read captured memory: the previous task's memory.
        let fixedMemory = null;
        let previousMemory = null;
        // A refused capture breaks the memory chain, so every later task of the run is invalid.
        const carryRefused = [];
        const runAttempts = [];
        try {
          for (let index = 0; index < item.tasks.length; index++) {
            const task = item.tasks[index];
            const taskRoot = fs.mkdtempSync(path.join(runRoot, 'task-'));
            const copilotHome = path.join(taskRoot, 'copilot');
            const harnessHome = path.join(taskRoot, 'state');
            for (const dir of [copilotHome, harnessHome]) fs.mkdirSync(dir);
            try {
            const extraFiles = arm.seed ? { [item.seed.episode.path]: item.seed.episode.content } : {};
            const fixture = prepareTask({ series: item, index, runRoot: taskRoot, carried, extraFiles, origin: originFor(item, index), copilotHome, harnessHome });
            // What an earlier agent left behind can make setup fail; that fails this attempt, never the whole study.
            const setupErrors = [];
            const setupStep = (step, action, fallback) => {
              try { return action(); } catch (caught) { setupErrors.push({ step, message: String(caught?.message ?? caught).slice(0, 500) }); return fallback; }
            };
            // Identity reads Git and the storage aliases, so it runs as a setup step too.
            const identity = setupStep('identity', () => {
              const dir = storeDir(fixture.workspace, { home: harnessHome });
              return { repoId: repoId(fixture.workspace), storeDir: dir, storeId: path.relative(harnessHome, dir) };
            }, null);
            if (!first && index === 0) first = identity;
            if (!first && index > 0) setupStep('identity', () => { throw new Error('the series identity is unknown: task 1 could not resolve it'); });
            const seriesStore = path.join(harnessHome, first ? first.storeId : path.join('knowledge', '.unresolved'));
            const projectDir = path.join(harnessHome, 'projects', path.basename(seriesStore));
            const homes = { copilotHome, harnessHome, projectDir };
            const fixed = fixesRecallableMemory(arm);
            const memoryRefused = [...carryRefused];
            // Carried memory is written before configuration, so the arm's mode and feedback state always win.
            if (index > 0 && first) {
              const source = fixed ? fixedMemory : previousMemory;
              if (source) setupStep('carry-memory', () => writeMemory(homes, source));
              else if (!memoryRefused.length) memoryRefused.push('(no captured memory)');
            }
            const configured = setupStep('configure', () => configureArm({ workspace: fixture.workspace, home: harnessHome, arm, series: item, seed: index === 0 }), { seeded: null });
            if (index === 0) seeded = configured.seeded;
            if (fixed && index === 0) {
              fixedMemory = setupStep('snapshot', () => captureMemory(homes), null);
              for (const reason of fixedMemory?.refused || []) { carryRefused.push(reason); memoryRefused.push(reason); }
            }
            const plans = setupStep('clear-plans', () => clearExternalPlans(harnessHome, projectDir), { cleared: 0, refused: ['(clear failed)'] });
            const before = setupStep('read-config', () => ({ ...storedConfig(identity.storeDir), observed: readStoreConfig(fixture.workspace, { home: harnessHome }).mode, feedbackObserved: readFeedbackConfig(fixture.workspace, { home: harnessHome }) }),
              { mode: null, feedback: null, observed: null, feedbackObserved: null });
            // A refused copy or plan clear counts as a failed setup too, so no agent runs on stores that may be contaminated.
            const setupFailed = setupErrors.length > 0 || memoryRefused.length > 0 || plans.refused.length > 0;
            // Both checkers run under this study's own protocol timeout, the value recorded in provenance.
            const checkerOptions = { timeoutMs: protocol.checkerTimeoutMs };
            const baseline = await runChecks(fixture, checkerOptions);
            const publicBaseline = await runPublicChecks(fixture, checkerOptions);
            const trapBaseline = task.trap ? subsetResult(task, baseline, true) : null;
            if (baseline.pass || !baseline.integrity || baseline.error || baseline.verdicts.some(verdict => verdict === null) || publicBaseline?.pass || publicBaseline?.error || trapBaseline?.pass) throw new Error(`invalid broken baseline: ${runId} task ${index + 1}`);
            const episodesBefore = episodeHashes(fixture.workspace, projectDir);
            const injection = plannedInjection({ workspace: fixture.workspace, copilotHome, home: harnessHome, task });
            const startedAt = Date.now();
            let result = {}, error = null;
            // A task whose setup failed is invalid whatever the agent does, so no agent runs for it.
            const ran = !dryRun && !setupFailed;
            if (setupFailed) {
              const failures = [...setupErrors.map(row => `${row.step}: ${row.message}`), ...memoryRefused.map(reason => `carry-memory: ${reason}`), ...plans.refused.map(rel => `clear-plans: refused ${rel}`)];
              error = `setup failed: ${failures.join('; ')}`.slice(0, 2000);
            } else if (!dryRun) {
              try { result = await execute({ ...fixture, arm, repeat: repeat + 1, model, protocol, injection }) || {}; }
              catch (caught) { error = String(caught.message).slice(0, 2000); }
            }
            // A dry run (or a skipped task) changes nothing, so the baseline checks above already describe its workspace.
            const checks = ran ? await runChecks(fixture, checkerOptions) : null;
            // One checker run scores the whole task; trap and non-trap results are subsets of its per-check verdicts.
            const trapChecks = !ran || !task.trap ? null : subsetResult(task, checks, true);
            const otherChecks = !ran || !task.trap ? null : subsetResult(task, checks, false);
            // What the agent left in the workspace can make a measurement throw (for example a file count over the snapshot
            // limit). That makes this attempt invalid as scope-unmeasurable; the study continues.
            const measurementErrors = [];
            const measure = (step, action, fallback) => {
              try { return action(); } catch (caught) { measurementErrors.push({ step, message: String(caught?.message ?? caught).slice(0, 500) }); return fallback; }
            };
            const scope = measure('scope', () => scopeResult(fixture), { pass: false, changed: [], unexpected: [], metadataExcluded: [] });
            // Ordinary Harness state is an expected write. Notes under docs/solutions are expected for every arm; only capturing arms carry them forward.
            // Runner-supplied files under .harness/, such as the public verifier, stay protected.
            const unexpected = scope.unexpected.filter(file => SUPPLIED_FILES.includes(file) || (!file.startsWith('.harness/') && !file.startsWith(`${protocol.carryForward}/`)));
            const originAfter = readOrigin(fixture.workspace);
            const originUnchanged = originAfter.configured === fixture.origin && originAfter.effective === fixture.origin;
            // Read every after-state through the series identity, never through an origin the agent may have changed.
            const originRestored = originUnchanged || restoreOrigin(fixture.workspace, fixture.origin);
            const after = storedConfig(seriesStore);
            const episodesAfter = measure('episodes', () => episodeHashes(fixture.workspace, projectDir), episodesBefore);
            const episodesWritten = Object.keys(episodesAfter).filter(key => episodesBefore[key] !== episodesAfter[key]).length;
            const kind = setupFailed ? 'setup-error' : dryRun ? 'dry-run' : error ? 'runtime-error' : host === 'scripted-test' ? 'scripted' : 'live';
            const executed = kind === 'live' || kind === 'scripted';
            const invalidReasons = [
              identity && first && identity.repoId !== first.repoId && 'repo-identity-drift',
              identity && first && identity.storeId !== first.storeId && 'store-directory-drift',
              before.observed !== arm.mode && 'knowledge-mode-mismatch',
              before.feedbackObserved !== (arm.feedback ?? 'off') && 'feedback-state-mismatch',
              plans.refused.length > 0 && 'external-plans-not-cleared',
              memoryRefused.length > 0 && 'carried-memory-refused',
              setupErrors.some(row => row.step === 'identity') && 'identity-resolution-failed',
              setupErrors.some(row => row.step === 'carry-memory') && 'carried-memory-write-failed',
              setupErrors.some(row => row.step === 'snapshot') && 'memory-snapshot-failed',
              setupErrors.some(row => row.step === 'configure') && 'arm-configuration-failed',
              setupErrors.some(row => row.step === 'clear-plans') && 'external-plans-clear-failed',
              setupErrors.some(row => row.step === 'read-config') && 'arm-configuration-unreadable',
              !originRestored && 'origin-restore-failed',
            ].filter(Boolean);
            const modeUnchanged = after.mode === arm.mode && after.feedback === (arm.feedback ?? 'off');
            const usage = usageOf(result);
            let repeatMistake = null;
            if (executed && invalidReasons.length === 0 && measurementErrors.length === 0 && task.trap) {
              const evidence = measure('repeat-evidence', () => repeatEvidenceFromServed({ workspace: fixture.workspace, home: harnessHome, session: { lastQuery: memoryPrompt(task), files: task.seeds }, delivered: addedDiff(fixture.workspace, task.editable) }), null);
              if (evidence) repeatMistake = { flagged: evidence.length > 0, learnings: evidence.map(row => row.learning) };
            }
            if (measurementErrors.length) invalidReasons.push('scope-unmeasurable');
            const valid = invalidReasons.length === 0;
            // A recurrence is scored only when the rest of the task was solved; an unsolved task says nothing about the trap.
            const scorable = executed && valid && task.trap === 'recurrence';
            // A checker that timed out, overflowed or lost integrity reports no verdicts; that recurrence is unscored and says why.
            const checkerIncomplete = Boolean(checks && (checks.error || !checks.integrity || checks.verdicts?.some(verdict => verdict === null)));
            const attempt = {
              batch: provenance.batch,
              id: `${runId}-t${index + 1}`, run: runId, series: item.id, split: item.split, trapId: item.trap.id, arm: armId, repeat: repeat + 1,
              task: task.id, taskIndex: index + 1, trapRole: task.trap ?? null, kind, valid, invalidReasons,
              pass: executed && valid && result.status === 'ok' && checks?.pass === true && unexpected.length === 0 && originUnchanged && modeUnchanged,
              baseline, publicBaseline, trapBaseline, checks, trapChecks, otherChecks,
              trapRecurred: scorable && otherChecks?.pass ? !trapChecks.pass : null,
              recurrenceUnscored: scorable && !otherChecks?.pass ? (checkerIncomplete ? 'checker-incomplete' : 'rest-of-task-unsolved') : null,
              trapFirstFailed: executed && valid && task.trap === 'first' && otherChecks?.pass ? !trapChecks.pass : null,
              repeatMistake,
              scope: { ...scope, pass: unexpected.length === 0, unexpected },
              origin: { expected: fixture.origin, after: originAfter, unchanged: originUnchanged },
              repoId: identity?.repoId ?? null, storeDir: identity?.storeDir ?? null, storeId: identity?.storeId ?? null, knowledgeMode: before.observed, feedback: before.feedbackObserved,
              knowledgeModeAfter: after.mode, feedbackAfter: after.feedback, configChangedByAgent: !modeUnchanged, seeded,
              carriedForward: fixture.carriedForward, externalPlansCleared: plans.cleared, externalPlansRefused: plans.refused, carriedMemoryRefused: memoryRefused, setupErrors, measurementErrors,
              learningsInjected: injection.learnings, learningsBytes: injection.learningsBytes, injectionError: injection.error,
              episodesWritten,
              turns: Number.isInteger(result.turnCount) ? result.turnCount : Array.isArray(result.turns) ? result.turns.length : null,
              inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, usageCoverage: usage.coverage,
              requestedModel: result.model ?? model, observedModels: usage.observedModels, actualModel: usage.actualModel, provider: result.provider ?? null,
              status: result.status ?? null, stopReason: result.stopReason ?? null, error, durationMs: Date.now() - startedAt,
            };
            attempts.push(attempt);
            runAttempts.push(attempt);
            if (readsCapturedMemory(arm)) {
              try { carried = collectCarryForward(fixture.workspace); }
              catch (caught) { carried = {}; carryRefused.push(`${protocol.carryForward}: unreadable (${caught?.code || caught?.message})`); }
              previousMemory = captureMemory(homes);
              carryRefused.push(...previousMemory.refused);
            } else carried = {};
            if (inspect) await inspect(fixture, attempt);
            } finally {
              // The task's root goes once its measurements are read; rmSync removes links without following them.
              try { fs.rmSync(taskRoot, { recursive: true, force: true, maxRetries: 3 }); } catch { /* the run root removal retries */ }
            }
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
    // A failed partial write must never replace the error that ended the study.
    if (!finished && owned) { try { writeStudyOutput({ root, provenance, runs, attempts, protocol, partial: true }); } catch { /* keep the original error */ } }
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
    // Recurrence rows whose checker reported no verdicts (timeout, overflow, integrity); they also count as unscored.
    recurrenceCheckerIncomplete: valid.filter(row => row.recurrenceUnscored === 'checker-incomplete').length,
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
