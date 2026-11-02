import { gitExecutable } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { projectStoreDir } from './project-layout.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { withPlanUpdateLock } from './plan-update.mjs';
import { assertNoSymlinkAncestors, canonicalPath, readFileNoFollow } from './fs-safe.mjs';
import { gitMetadataEnvironment } from '../corpus/hooks/lib/product-diff.mjs';
import { createExperimentSnapshot, publishExperimentSnapshot, readExperimentCandidate, restoreExperimentSnapshot, verifyExperimentSnapshot } from './experiment-snapshots.mjs';

const MAX_BYTES = 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const fail = message => Object.assign(new Error(`experiment: ${message}`), { code: 'E_EXPERIMENT', exit: 1 });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function git(workspace, args) {
  const result = spawnSync(gitExecutable(), ['-c', 'core.fsmonitor=false', ...args], { cwd: workspace, env: gitMetadataEnvironment(), encoding: 'utf8', timeout: 5000, maxBuffer: MAX_BYTES });
  if (result.error?.code === 'ENOENT') throw fail('git is not installed or not on PATH');
  if (result.error || result.status !== 0) throw fail('workspace Git identity is unavailable');
  return result.stdout.trim();
}

function directoryIdentity(full) {
  const stat = fs.lstatSync(full, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonicalPath(full) !== full) throw fail('workspace identity requires canonical physical directories');
  const value = Object.fromEntries(['dev', 'ino', 'birthtimeNs'].map(key => [key, stat[key]?.toString()]));
  if (Object.values(value).some(item => !/^[1-9][0-9]{0,19}$/.test(item || ''))) throw fail('stable workspace filesystem identity is unavailable');
  return value;
}

function physicalPath(full) {
  const resolved = path.resolve(full);
  if (!assertNoSymlinkAncestors(path.parse(resolved).root, path.relative(path.parse(resolved).root, resolved))) throw fail('workspace identity path contains a symlink');
  return canonicalPath(resolved);
}

function bindingOf(workspace) {
  const root = physicalPath(workspace);
  if (physicalPath(git(root, ['rev-parse', '--show-toplevel'])) !== root) throw fail('experiment requires exact repository root');
  const gitDir = physicalPath(git(root, ['rev-parse', '--absolute-git-dir']));
  const commonDir = physicalPath(path.resolve(root, git(root, ['rev-parse', '--git-common-dir'])));
  const registered = path.relative(path.join(commonDir, 'worktrees'), gitDir);
  const dotGit = readFileNoFollow(path.join(root, '.git'), { root, maxBytes: 4096 });
  const backlink = readFileNoFollow(path.join(gitDir, 'gitdir'), { root: gitDir, maxBytes: 4096 });
  const listed = git(root, ['worktree', 'list', '--porcelain', '-z']);
  const listedRoot = listed.split('\0').filter(value => value.startsWith('worktree ')).some(value => {
    try { return physicalPath(value.slice(9)) === root; } catch { return false; }
  });
  if (root === commonDir || gitDir === commonDir || !registered || registered.includes(path.sep) || registered.startsWith('.') || !dotGit?.startsWith('gitdir: ') || physicalPath(path.resolve(root, dotGit.slice(8).trim())) !== gitDir || !backlink || physicalPath(path.resolve(gitDir, backlink.trim())) !== physicalPath(path.join(root, '.git')) || !listedRoot) throw fail('experiment requires a registered linked issue worktree and its backlink');
  const head = git(root, ['rev-parse', 'HEAD']);
  const headRef = readFileNoFollow(path.join(gitDir, 'HEAD'), { root: gitDir, maxBytes: 4096 })?.trim();
  if (!/^[a-f0-9]{40,64}$/.test(head) || !headRef || !/^(?:ref: refs\/heads\/[a-zA-Z0-9._/-]+|[a-f0-9]{40,64})$/.test(headRef)) throw fail('accepted workspace HEAD identity is unavailable');
  return { version: 1, root, commonDir, gitDir, head, headRef, filesystemIdentity: Object.fromEntries([['root', root], ['commonDir', commonDir], ['gitDir', gitDir]].map(([key, full]) => [key, directoryIdentity(full)])) };
}

function context({ workspace, plan, home }) {
  if (!UUID.test(plan?.fm?.plan_id || '') || !plan?.fullPath || !path.isAbsolute(plan.fullPath) || !plan.fm.experiment) throw fail('accepted experiment plan identity is required');
  const canonicalWorkspace = physicalPath(workspace);
  const requestedHome = home || harnessGlobalHome();
  const selectedHome = fs.existsSync(requestedHome) ? physicalPath(requestedHome) : path.resolve(requestedHome);
  const store = path.resolve(projectStoreDir(canonicalWorkspace, { home: selectedHome }));
  const root = path.join(store, 'experiments', plan.fm.plan_id);
  const homeIdentity = path.resolve(selectedHome || path.resolve(store, '../..'));
  if (!assertNoSymlinkAncestors(path.parse(root).root, path.relative(path.parse(root).root, root))) throw fail('experiment authority contains a symlink');
  return { workspace: canonicalWorkspace, plan, planId: plan.fm.plan_id, store, root, home: fs.existsSync(homeIdentity) ? physicalPath(homeIdentity) : homeIdentity };
}

function readRecord(root, rel, absent = false) {
  const full = assertNoSymlinkAncestors(root, rel);
  if (!full) throw fail('experiment record contains a symlink');
  const raw = readFileNoFollow(full, { root, maxBytes: MAX_BYTES });
  if (raw === null) {
    if (absent && !fs.lstatSync(full, { throwIfNoEntry: false })) return null;
    throw fail('experiment record is missing, corrupt or oversized');
  }
  let record;
  try { record = JSON.parse(raw); } catch { throw fail('experiment record is corrupt'); }
  if (record?.version !== 1 || !HASH.test(record.digest || '') || hash(record.value) !== record.digest) throw fail('experiment journal integrity failed');
  return record.value;
}

function durableWrite(full, bytes, exclusive) {
  const fd = fs.openSync(full, exclusive ? 'wx' : 'w', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { const directory = fs.openSync(path.dirname(full), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } } catch { /* Directory fsync is unavailable on some supported filesystems. */ }
}

function publish(root, rel, value, projection = false) {
  const full = assertNoSymlinkAncestors(root, rel);
  if (!full) throw fail('experiment publication path is unsafe');
  fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
  const bytes = JSON.stringify({ version: 1, digest: hash(value), value }) + '\n';
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw fail('experiment record is oversized');
  if (projection) {
    const temporary = `${full}.${randomUUID()}.tmp`;
    durableWrite(temporary, bytes, true);
    fs.renameSync(temporary, full);
    return;
  }
  try { durableWrite(full, bytes, true); }
  catch (error) {
    if (error.code !== 'EEXIST' || !same(readRecord(root, rel), value)) throw fail('experiment operation replay conflicts');
  }
}

function authority(options) {
  if (!options.authorityCheck) return;
  const result = options.authorityCheck();
  if (result && typeof result.then === 'function') throw fail('authority check must be synchronous');
  if (result === false || result?.pass === false) throw fail(result?.message || 'current experiment authority is blocked');
}

function claimValue(ctx, binding) {
  return { version: 1, planId: ctx.planId, home: ctx.home, store: ctx.store, root: ctx.root, binding };
}

function matchingClaim(value, expected) {
  const { seriesStart, ...identity } = value || {};
  return same(identity, expected);
}

export function claimExperimentWorkspace(options) {
  const ctx = context(options);
  authority(options);
  const binding = bindingOf(ctx.workspace);
  const full = path.join(binding.gitDir, 'harness-experiment-owner.json');
  const expected = claimValue(ctx, binding);
  const old = readRecord(binding.gitDir, path.basename(full), true);
  if (old && !matchingClaim(old, expected)) throw fail('linked workspace is owned by another experiment, home or physical identity');
  if (old && options.seriesStart && !same(old.seriesStart, options.seriesStart)) throw fail('workspace initial reservation replay conflicts');
  const next = options.seriesStart ? { ...expected, seriesStart: options.seriesStart } : expected;
  if (!old && !options.dryRun) publish(binding.gitDir, path.basename(full), next);
  return { pass: true, ...(old || next), dryRun: Boolean(options.dryRun) };
}

export function validateExperimentWorkspace(options) {
  try {
    const ctx = context(options);
    const binding = bindingOf(ctx.workspace);
    const claim = readRecord(binding.gitDir, 'harness-experiment-owner.json', true);
    if (!claim || !matchingClaim(claim, claimValue(ctx, binding))) throw fail('workspace claim or physical identity changed');
    return { pass: true, binding, claim };
  } catch (error) { return { pass: false, message: error.message }; }
}

function requireWorkspace(options) {
  const result = validateExperimentWorkspace(options);
  if (!result.pass) throw fail(result.message);
  return result;
}

function project(ctx) {
  const series = readRecord(ctx.root, 'series.json', true);
  const reservationsDir = path.join(ctx.root, 'reservations');
  if (!series) {
    if (fs.existsSync(reservationsDir) && fs.readdirSync(reservationsDir).length) throw fail('series anchor is missing while reservations exist');
    const begin = readRecord(ctx.root, 'begin.json', true);
    return { version: 1, root: ctx.root, status: begin ? 'initializing' : 'absent', spent: begin ? 2 : 0, attempts: [], active: null, lastKept: null, origin: begin?.origin || null, begin, generation: begin ? 1 : 0 };
  }
  if (series.planId !== ctx.planId || !HASH.test(series.frozenDigest || '') || !Number.isFinite(series.origin)) throw fail('series anchor identity is invalid');
  const names = fs.existsSync(reservationsDir) ? fs.readdirSync(reservationsDir).sort() : [];
  if (names.length > 10000 || names.some(name => !/^\d{6}-[a-f0-9-]{36}\.json$/.test(name))) throw fail('reservation journal shape is invalid');
  if (names.length === 0) {
    const begin = readRecord(ctx.root, 'begin.json');
    if (begin.origin !== series.origin || begin.acceptedInputs?.frozenDigest !== series.frozenDigest || begin.id !== series.baselineSnapshot?.id || !same(begin.candidate, series.baselineSnapshot.candidate)) throw fail('initial series anchor differs from its committed guard');
    return { version: 1, root: ctx.root, status: 'initializing', spent: 2, attempts: [], active: null, lastKept: null, origin: begin.origin, begin, generation: 1, series };
  }
  const attempts = names.map((name, index) => {
    const reservation = readRecord(ctx.root, `reservations/${name}`);
    if (reservation.planId !== ctx.planId || reservation.ordinal !== index + 1 || reservation.cost !== 2 || reservation.origin !== series.origin || reservation.frozenDigest !== series.frozenDigest || !UUID.test(reservation.id || '') || !UUID.test(reservation.childIds?.score || '') || !UUID.test(reservation.childIds?.guard || '')) throw fail('reservation journal is invalid');
    let attempt = { ...reservation, state: 'reserved', children: { score: { state: 'reserved' }, guard: { state: 'reserved' } }, sequence: 0 };
    const transitionsDir = path.join(ctx.root, 'attempts', reservation.id);
    const records = fs.existsSync(transitionsDir) ? fs.readdirSync(transitionsDir).sort() : [];
    if (records.length > 100 || records.some(name => !/^\d{3}\.json$/.test(name))) throw fail('attempt transition journal shape is invalid');
    for (const [offset, rel] of records.entries()) {
      const transition = readRecord(ctx.root, `attempts/${reservation.id}/${rel}`);
      if (transition.attempt !== reservation.id || transition.sequence !== offset + 1 || transition.beforeDigest !== hash(attempt)) throw fail('attempt transition chain is invalid');
      attempt = { ...attempt, ...transition.changes, sequence: offset + 1 };
    }
    return attempt;
  });
  const unsettled = attempts.filter(value => !['kept', 'discarded', 'cancelled'].includes(value.state));
  if (unsettled.length > 1) throw fail('multiple unresolved attempts exist');
  const kept = attempts.filter(value => value.state === 'kept');
  const lastKept = kept.at(-1) || null;
  const terminal = attempts.at(-1);
  const targetReached = lastKept && Number.isFinite(lastKept.measurement?.metric?.value) && lastKept.measurement.metric.value <= series.target;
  const budget = ctx.plan.fm.experiment.budget;
  const frozenInvalid = Boolean(ctx.plan.fm.experiment.target !== series.target);
  const status = frozenInvalid ? 'evaluator-invalid' : terminal?.seriesStop || (targetReached ? 'target-reached' : unsettled.length ? unsettled[0].state : attempts.length * 2 + 2 > budget.max_invocations ? 'exhausted' : 'ready');
  return { version: 1, root: ctx.root, series, frozenDigest: series.frozenDigest, origin: series.origin, spent: attempts.length * 2, attempts, active: unsettled[0] || null, lastKept, status, generation: attempts.reduce((sum, attempt) => sum + attempt.sequence + 1, 0), budget };
}

function transition(ctx, attempt, changes) {
  publish(ctx.root, `attempts/${attempt.id}/${String(attempt.sequence + 1).padStart(3, '0')}.json`, { version: 1, attempt: attempt.id, sequence: attempt.sequence + 1, beforeDigest: hash(attempt), changes });
  const state = project(ctx);
  publishProjection(ctx, state);
  return state.attempts.find(value => value.id === attempt.id);
}

function attemptsReport(state) {
  const escape = value => String(value ?? '').replace(/[\t\r\n]/g, ' ');
  const lines = ['attempt\tmetric\tstatus\tdescription'];
  for (const attempt of state.attempts) lines.push([attempt.id, Number.isFinite(attempt.measurement?.metric?.value) ? attempt.measurement.metric.value : '', attempt.state, attempt.resolution?.description || attempt.hypothesis].map(escape).join('\t'));
  return lines.join('\n') + '\n';
}

function publishProjection(ctx, state) {
  publish(ctx.root, 'state.json', { version: 1, planId: ctx.planId, status: state.status, spent: state.spent, origin: state.origin, generation: state.generation, active: state.active?.id || null, lastKept: state.lastKept?.id || null, frozenDigest: state.frozenDigest || null }, true);
  const bytes = attemptsReport(state);
  if (Buffer.byteLength(bytes) > MAX_BYTES) return;
  const full = assertNoSymlinkAncestors(ctx.root, 'attempts.tsv');
  if (!full) throw fail('attempts projection contains a symlink');
  const temporary = `${full}.${randomUUID()}.tmp`;
  durableWrite(temporary, bytes, true);
  fs.renameSync(temporary, full);
}

function locked(options, callback) {
  const ctx = context(options);
  const binding = bindingOf(ctx.workspace);
  const claim = readRecord(binding.gitDir, 'harness-experiment-owner.json', true);
  return withPlanUpdateLock(ctx.plan.fullPath, () => {
    if (claim && (!matchingClaim(readRecord(binding.gitDir, 'harness-experiment-owner.json'), claimValue(ctx, binding)) || Object.entries(binding.filesystemIdentity).some(([key, identity]) => !same(identity, directoryIdentity(binding[key]))))) throw fail('physical workspace ownership changed before state publication');
    authority(options);
    return callback(ctx, project(ctx));
  });
}

function currentAttempt(state, reservation, token) {
  const attempt = state.attempts.find(value => value.id === (reservation?.id || reservation));
  if (!attempt) throw fail('attempt reservation does not exist');
  if (reservation?.inputDigest && reservation.inputDigest !== attempt.inputDigest) throw fail('reservation payload changed');
  if (token && attempt.token !== token) throw fail('attempt execution token changed');
  return attempt;
}

function budgetCheck(experiment) {
  const budget = experiment.budget;
  if (!budget || !Number.isSafeInteger(budget.max_invocations) || budget.max_invocations < 1 || budget.max_invocations > 10000 || !Number.isSafeInteger(budget.max_seconds) || budget.max_seconds < 1 || !Number.isSafeInteger(budget.timeout_seconds) || budget.timeout_seconds < 1 || !Number.isSafeInteger(budget.max_repair_reruns) || budget.max_repair_reruns < 0 || budget.max_repair_reruns > 2) throw fail('positive bounded experiment budgets are required');
  return budget;
}

export function reserveExperimentAttempt(options) {
  const ctx = context(options);
  const operation = options.operation;
  if (typeof operation !== 'string' || !operation || operation.length > 128 || /[\x00-\x1f]/.test(operation)) throw fail('reservation operation is invalid');
  if (options.authoredDigest !== undefined && !HASH.test(options.authoredDigest)) throw fail('authored decision digest is invalid');
  const kind = options.kind || 'candidate';
  if (!['baseline', 'candidate', 'repair'].includes(kind)) throw fail('attempt kind is invalid');
  const hypothesis = options.hypothesis;
  if (typeof hypothesis !== 'string' || !hypothesis.trim() || hypothesis.length > 2000) throw fail('attempt requires one bounded hypothesis');
  const acceptedInputs = options.acceptedInputs;
  if (acceptedInputs?.planId !== ctx.planId || !HASH.test(acceptedInputs?.frozenDigest || '')) throw fail('frozen accepted evaluator inputs are required');
  const budget = budgetCheck(ctx.plan.fm.experiment);
  const input = { operation, kind, hypothesis, repairOf: options.repairOf || null, frozenDigest: acceptedInputs.frozenDigest, authoredDigest: options.authoredDigest || null };
  const inputDigest = hash(input);
  let existing = project(ctx);
  const replay = existing.attempts.find(value => value.operation === operation);
  if (replay) {
    if (replay.inputDigest !== inputDigest) throw fail('reservation operation replay conflicts');
    requireWorkspace(options);
    return replay;
  }
  authority(options);
  const first = ['absent', 'initializing'].includes(existing.status);
  if (existing.begin && existing.begin.inputDigest !== inputDigest) throw fail('initial reservation operation replay conflicts');
  if (first && kind !== 'baseline') throw fail('first reservation must establish the baseline');
  if (!first && kind === 'baseline') throw fail('baseline cannot be reset');
  if (existing.active) throw fail('another reserved or running attempt is unresolved');
  if (!first && (['target-reached', 'cancelled', 'blocked-workspace'].includes(existing.status) || (existing.status === 'evaluator-invalid' && kind !== 'repair'))) throw fail('series is stopped or target is reached');
  if (!first && existing.frozenDigest !== acceptedInputs.frozenDigest) throw fail('evaluator inputs changed; baseline cannot be rebased');
  const highWater = existing.attempts.reduce((limits, attempt) => ({ max_invocations: Math.max(limits.max_invocations, attempt.acceptedBudget?.max_invocations || 0), max_seconds: Math.max(limits.max_seconds, attempt.acceptedBudget?.max_seconds || 0) }), existing.series?.initialBudget || budget);
  if (!first && (budget.max_invocations < highWater.max_invocations || budget.max_seconds < highWater.max_seconds)) throw fail('accepted budget cannot decrease below its prior accepted limits');
  if ((first ? 0 : existing.spent) + 2 > budget.max_invocations) throw fail('invocation budget cannot reserve the score and guard pair');
  let now = existing.begin?.origin ?? options.now ?? Date.now();
  if (!first && now >= existing.origin + budget.max_seconds * 1000) throw fail('original wall-clock budget is exhausted');
  if (!first && !existing.lastKept && kind !== 'repair') throw fail('retained baseline is required before candidate edits');
  const repaired = kind === 'repair' ? existing.attempts.find(value => value.id === options.repairOf) : null;
  if (kind === 'repair' && (!repaired || !['discarded', 'cancelled'].includes(repaired.state))) throw fail('repair requires a settled failed attempt');
  const hypothesisId = repaired?.hypothesisId || randomUUID();
  if (kind === 'repair' && (hypothesis !== repaired.hypothesis || existing.attempts.filter(value => value.kind === 'repair' && value.hypothesisId === hypothesisId).length >= budget.max_repair_reruns)) throw fail('repair count or original hypothesis changed');
  const candidate = readExperimentCandidate({ workspace: ctx.workspace, paths: ctx.plan.fm.experiment.editable_files });
  if (first && acceptedInputs.candidate?.sha256 && (acceptedInputs.candidate.path !== candidate.files[0].path || acceptedInputs.candidate.sha256 !== candidate.files[0].sha256 || (acceptedInputs.candidate.mode !== undefined && acceptedInputs.candidate.mode !== candidate.files[0].mode))) throw fail('baseline candidate changed since accepted live input snapshot');
  if (!first && existing.lastKept && !same(candidate, existing.lastKept.evaluatedCandidate)) throw fail('new reservation requires exact last-kept candidate bytes');
  let id = randomUUID();
  let initial;
  if (first) {
    const binding = bindingOf(ctx.workspace);
    const previousClaim = readRecord(binding.gitDir, 'harness-experiment-owner.json', true);
    initial = existing.begin || previousClaim?.seriesStart || { version: 1, id, operation, inputDigest, origin: now, candidate, acceptedInputs, childIds: { score: randomUUID(), guard: randomUUID() } };
    if (previousClaim && !previousClaim.seriesStart) throw fail('workspace claim has no durable initial reservation; initialization is blocked');
    if (initial.operation !== operation || initial.inputDigest !== inputDigest || !same(initial.candidate, candidate)) throw fail('initial baseline reservation identity or bytes changed');
    id = initial.id;
    now = initial.origin;
    claimExperimentWorkspace({ ...options, seriesStart: initial });
    locked(options, (inner, live) => {
      if (!['absent', 'initializing'].includes(live.status)) throw fail('series changed before initial reservation guard');
      publish(inner.root, 'begin.json', initial);
    });
    options.afterGuard?.();
    existing = project(ctx);
  } else claimExperimentWorkspace(options);
  const snapshot = first ? createExperimentSnapshot({ workspace: ctx.workspace, root: path.join(ctx.root, 'snapshots'), id, paths: ctx.plan.fm.experiment.editable_files, now, expectedCandidate: candidate }) : null;
  const binding = requireWorkspace(options).binding;
  return locked(options, (inner, state) => {
    const racingReplay = state.attempts.find(value => value.operation === operation);
    if (racingReplay) { if (racingReplay.inputDigest !== inputDigest) throw fail('reservation operation replay conflicts'); return racingReplay; }
    if (state.generation !== existing.generation || state.spent !== existing.spent || state.status !== existing.status) throw fail('series changed before reservation publication');
    if (first) publish(inner.root, 'series.json', { version: 1, planId: inner.planId, origin: now, frozenDigest: acceptedInputs.frozenDigest, acceptedInputs, initialBudget: budget, target: inner.plan.fm.experiment.target, binding, baselineSnapshot: snapshot });
    const origin = first ? now : state.origin;
    const reservation = { version: 1, id, invocation: id, planId: inner.planId, operation, kind, hypothesis, repairOf: options.repairOf || null, hypothesisId, ordinal: state.attempts.length + 1, childIds: initial?.childIds || { score: randomUUID(), guard: randomUUID() }, cost: 2, origin, acceptedBudget: { ...budget }, acceptedInputs, frozenDigest: acceptedInputs.frozenDigest, parentKeptCandidate: state.lastKept?.evaluatedCandidate || candidate, baselineCandidate: first ? candidate : repaired?.baselineCandidate || null, snapshot: first ? snapshot : state.lastKept?.retainedSnapshot || snapshot, inputDigest };
    publish(inner.root, `reservations/${String(reservation.ordinal).padStart(6, '0')}-${id}.json`, reservation);
    publishProjection(inner, project(inner));
    return reservation;
  });
}

const selfStartMs = String(Math.round(Date.now() - process.uptime() * 1000));

function linuxStartTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return '';
    const ticks = stat.slice(end + 2).trim().split(/\s+/)[19];
    return ticks && /^\d+$/.test(ticks) ? ticks : '';
  } catch {
    return '';
  }
}

export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return null;
    throw fail('process identity is unavailable; absence is not proven');
  }
  if (process.platform === 'linux' || process.platform === 'android') {
    const ticks = linuxStartTicks(pid);
    if (ticks) return `linux:${ticks}`;
  } else if (process.platform === 'darwin') {
    // Node can see that another pid is alive. It cannot read that process's kernel
    // start time. One identity per live pid lets evaluation record the child, and a
    // reused pid stays blocked until it exits.
    return `darwin:${pid}`;
  } else if (pid === process.pid && /^[1-9][0-9]{0,19}$/.test(selfStartMs)) {
    const prefix = process.platform === 'win32' ? 'windows' : process.platform;
    return `${prefix}:${pid}:${selfStartMs}`;
  }
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return null; }
  throw fail('process identity is unavailable; absence is not proven');
}

function copies(ctx, attempt, candidate) {
  const inputDir = path.join(ctx.root, 'inputs', attempt.id);
  if (!assertNoSymlinkAncestors(ctx.root, path.relative(ctx.root, inputDir))) throw fail('input copy directory is unsafe');
  fs.mkdirSync(inputDir, { recursive: true, mode: 0o700 });
  for (const [name, file] of [['candidate.json', candidate.files[0]], ['workload.json', attempt.acceptedInputs.workload]]) {
    if (!file?.path) continue;
    const source = assertNoSymlinkAncestors(ctx.workspace, file.path);
    const raw = source && readFileNoFollow(source, { root: ctx.workspace, maxBytes: MAX_BYTES });
    if (raw === null || (file.sha256 && hash(raw) !== file.sha256)) throw fail('immutable candidate or workload copy changed');
    const full = path.join(inputDir, name);
    try { durableWrite(full, raw, true); }
    catch (error) { if (error.code !== 'EEXIST' || readFileNoFollow(full, { root: inputDir, maxBytes: MAX_BYTES }) !== raw) throw fail('immutable input copy replay conflicts'); }
  }
  return inputDir;
}

export function markExperimentRunning(options) {
  const ctx = context(options);
  requireWorkspace(options);
  authority(options);
  const state = project(ctx);
  const attempt = currentAttempt(state, options.reservation);
  if (attempt.state !== 'reserved') throw fail('attempt is already running, started or settled and cannot launch again');
  const candidate = readExperimentCandidate({ workspace: ctx.workspace, paths: ctx.plan.fm.experiment.editable_files });
  if (attempt.baselineCandidate && !same(candidate, attempt.baselineCandidate)) throw fail('baseline candidate changed after begin');
  if (attempt.kind === 'repair') {
    const repaired = state.attempts.find(value => value.id === attempt.repairOf);
    if (repaired.evaluatedCandidate && !same(candidate, repaired.evaluatedCandidate)) throw fail('repair candidate bytes differ from the original hypothesis');
  }
  const inputDir = copies(ctx, attempt, candidate);
  const owner = { pid: process.pid, startIdentity: processIdentity(process.pid) };
  if (!owner.startIdentity) throw fail('controller process identity is unavailable');
  const token = options.token || randomUUID();
  return locked(options, (inner, live) => {
    const current = currentAttempt(live, attempt);
    if (current.state !== 'reserved' || current.sequence !== attempt.sequence) throw fail('attempt is already running or started');
    if ((options.now ?? Date.now()) >= current.origin + inner.plan.fm.experiment.budget.max_seconds * 1000) throw fail('original wall-clock budget expired before evaluation');
    return transition(inner, current, { state: 'running', token, owner, evaluatedCandidate: candidate, inputDir, startedAt: Date.now() });
  });
}

export function markExperimentChildStarted(options) {
  const ctx = context(options);
  requireWorkspace(options);
  if (!['score', 'guard'].includes(options.mode)) throw fail('child mode is invalid');
  return locked(options, (inner, state) => {
    const now = options.now ?? Date.now();
    const attempt = currentAttempt(state, options.reservation, options.token);
    if (attempt.state !== 'running' || attempt.children[options.mode].state !== 'reserved') throw fail('child already started; launch is one-shot');
    if (now >= attempt.origin + inner.plan.fm.experiment.budget.max_seconds * 1000) throw fail('original wall-clock budget expired before child launch');
    return transition(inner, attempt, { children: { ...attempt.children, [options.mode]: { state: 'started', childId: attempt.childIds[options.mode], token: options.token, beforeSpawn: true, startedAt: now } } });
  });
}

export function recordExperimentChildSpawn(options) {
  requireWorkspace(options);
  const identity = options.startIdentity || processIdentity(options.pid);
  if (!identity) throw fail('spawned child start identity is unavailable; recovery remains blocked');
  return locked({ ...options, authorityCheck: undefined }, (ctx, state) => {
    const attempt = currentAttempt(state, options.reservation, options.token);
    const child = attempt.children[options.mode];
    if (child?.state !== 'started' || child.pid) throw fail('child spawn provenance was already published or not started');
    return transition(ctx, attempt, { children: { ...attempt.children, [options.mode]: { ...child, beforeSpawn: false, pid: options.pid, groupId: options.groupId || options.pid, startIdentity: identity } } });
  });
}

export function recordExperimentChildResult(options) {
  requireWorkspace(options);
  return locked({ ...options, authorityCheck: undefined }, (ctx, state) => {
    const attempt = currentAttempt(state, options.reservation, options.token);
    const child = attempt.children[options.mode];
    if (!child || child.state !== 'started') throw fail('child result requires one started invocation');
    if (!options.result || typeof options.result.groupReaped !== 'boolean') throw fail('child result must state owned process-group reaping');
    return transition(ctx, attempt, { children: { ...attempt.children, [options.mode]: { ...child, state: 'settled', result: options.result } } });
  });
}

export function recordExperimentMeasurement(options) {
  const ctx = context(options);
  requireWorkspace(options);
  const candidate = readExperimentCandidate({ workspace: ctx.workspace, paths: ctx.plan.fm.experiment.editable_files });
  return locked({ ...options, authorityCheck: undefined }, (inner, state) => {
    const attempt = currentAttempt(state, options.reservation, options.token);
    const metricPresent = options.result?.metric && Number.isFinite(options.result.metric.value);
    const childrenSafe = Object.values(attempt.children).every(child => child.state === 'reserved' ? !metricPresent : child.state === 'settled' && child.result?.groupReaped === true);
    if (attempt.state !== 'running' || !childrenSafe) throw fail('measurement requires all started children settled and reaped, and both children for a metric');
    if (!same(candidate, attempt.evaluatedCandidate) || options.result?.attempt !== attempt.id || options.result.acceptedInputsDigest !== attempt.frozenDigest || !same(options.result.candidate, candidate)) throw fail('measurement candidate or immutable inputs changed');
    return transition(inner, attempt, { state: metricPresent ? 'measured' : 'failed', measurement: options.result });
  });
}

function measurementValid(options, attempt) {
  if (!options.measurementCheck) return { pass: false, message: 'trusted measurement revalidation is required' };
  const result = typeof options.measurementCheck === 'function' ? options.measurementCheck(attempt) : options.measurementCheck;
  if (result && typeof result.then === 'function') throw fail('measurement validation must finish before state publication');
  return result || { pass: false };
}

export function resolveExperimentAttempt(options) {
  const ctx = context(options);
  requireWorkspace(options);
  const state = project(ctx);
  const attempt = currentAttempt(state, options.invocation || options.reservation);
  const operation = options.operation;
  const decision = options.decision;
  if (!['keep', 'discard', 'cancel'].includes(decision) || typeof operation !== 'string' || !operation || operation.length > 128) throw fail('bounded resolve operation and keep/discard/cancel decision are required');
  if (options.authoredDigest !== undefined && !HASH.test(options.authoredDigest)) throw fail('authored decision digest is invalid');
  if (['kept', 'discarded', 'cancelled'].includes(attempt.state)) {
    if (attempt.resolution?.operation !== operation || attempt.resolution?.decision !== decision || attempt.resolution?.description !== (options.description || '') || attempt.resolution?.authoredDigest !== (options.authoredDigest || null)) throw fail('settled attempt resolve replay conflicts');
    return attempt;
  }
  if (attempt.state === 'running' && Object.values(attempt.children).some(child => child.state === 'started' && child.result?.groupReaped !== true)) throw fail('owned child group is not proven gone; resolve is blocked');
  const candidate = readExperimentCandidate({ workspace: ctx.workspace, paths: ctx.plan.fm.experiment.editable_files });
  const recognized = attempt.evaluatedCandidate || attempt.baselineCandidate || attempt.parentKeptCandidate;
  if (!same(candidate, recognized)) throw fail('resolve refuses unknown owned candidate bytes');
  authority(options);
  let snapshot;
  let stop;
  let resolving;
  let resolution;
  const publishResolution = prepared => {
    if (decision === 'keep' && !same(prepared.candidate, attempt.evaluatedCandidate)) throw fail('retained snapshot candidate differs from the trusted measurement');
    resolution = { version: 1, operation, decision, description: options.description || '', authoredDigest: options.authoredDigest || null, snapshot: prepared, before: recognized, generation: state.generation, seriesStop: stop || null };
    resolving = locked(options, (inner, live) => {
      const current = currentAttempt(live, attempt);
      if (current.sequence !== attempt.sequence || live.generation !== state.generation) throw fail('attempt changed before resolution journal publication');
      return transition(inner, current, { state: 'resolving', resolution });
    });
    options.afterResolution?.(resolving);
  };
  if (decision === 'keep') {
    const valid = measurementValid(options, attempt);
    if (!valid.pass || attempt.state !== 'measured' || attempt.measurement.status !== 'passed' || attempt.measurement.correctness?.passed !== true || !Number.isFinite(attempt.measurement.metric?.value)) throw fail(valid.message || 'keep requires trusted measurement and hard correctness guards');
    const previous = state.lastKept?.measurement.metric.value;
    if (previous !== undefined && previous - attempt.measurement.metric.value < ctx.plan.fm.experiment.protocol.minimum_improvement) throw fail('candidate lacks the required meaningful improvement');
    snapshot = createExperimentSnapshot({ workspace: ctx.workspace, root: path.join(ctx.root, 'snapshots'), id: `keep-${attempt.id}`, paths: ctx.plan.fm.experiment.editable_files, now: attempt.origin, beforePublish: publishResolution, expectedCandidate: attempt.evaluatedCandidate });
  } else {
    snapshot = state.lastKept?.retainedSnapshot || state.series.baselineSnapshot;
    verifyExperimentSnapshot({ workspace: ctx.workspace, snapshot });
    if (decision === 'cancel') stop = 'cancelled';
    else if (!Number.isFinite(attempt.measurement?.metric?.value)) stop = attempt.measurement?.status === 'cancelled' ? 'cancelled' : 'evaluator-invalid';
    else if (options.measurementCheck && !measurementValid(options, attempt).pass) stop = 'evaluator-invalid';
    publishResolution(snapshot);
  }
  if (!resolving) publishResolution(snapshot);
  if (decision !== 'keep') restoreExperimentSnapshot({ workspace: ctx.workspace, root: path.join(ctx.root, 'snapshots'), id: `restore-${attempt.id}`, snapshot, before: recognized, afterWrite: options.afterWrite });
  return locked(options, (inner, live) => {
    const current = currentAttempt(live, resolving);
    if (current.state !== 'resolving' || !same(current.resolution, resolution)) throw fail('resolution ownership changed');
    if (decision === 'keep' && (!same(snapshot.candidate, current.evaluatedCandidate) || !same(readExperimentCandidate({ workspace: ctx.workspace, paths: ctx.plan.fm.experiment.editable_files }), current.evaluatedCandidate))) throw fail('candidate changed before retained snapshot settlement');
    return transition(inner, current, { state: decision === 'keep' ? 'kept' : decision === 'cancel' ? 'cancelled' : 'discarded', retainedSnapshot: decision === 'keep' ? snapshot : null, seriesStop: stop || null });
  });
}

export function recoverExperimentAttempt(options) {
  const ctx = context(options);
  requireWorkspace(options);
  const state = project(ctx);
  const attempt = currentAttempt(state, options.invocation || options.reservation);
  if (['kept', 'discarded', 'cancelled'].includes(attempt.state)) return attempt;
  if (attempt.state === 'resolving') {
    const resolution = attempt.resolution;
    if (resolution.decision !== 'keep') restoreExperimentSnapshot({ workspace: ctx.workspace, root: path.join(ctx.root, 'snapshots'), id: `restore-${attempt.id}`, snapshot: resolution.snapshot, before: resolution.before });
    else {
      const valid = measurementValid(options, attempt);
      if (!valid.pass) throw fail(valid.message || 'trusted measurement is stale during retained snapshot recovery');
      const candidate = readExperimentCandidate({ workspace: ctx.workspace, paths: ctx.plan.fm.experiment.editable_files });
      if (!same(candidate, resolution.snapshot.candidate) || !same(resolution.snapshot.candidate, attempt.evaluatedCandidate)) throw fail('keep recovery refuses changed candidate bytes or snapshot identity');
      publishExperimentSnapshot({ workspace: ctx.workspace, root: path.join(ctx.root, 'snapshots'), snapshot: resolution.snapshot, expectedCandidate: attempt.evaluatedCandidate });
    }
    return locked(options, (inner, live) => {
      const current = currentAttempt(live, attempt);
      if (!same(current.resolution, resolution)) throw fail('recovery resolution changed');
      if (resolution.decision === 'keep' && (!same(resolution.snapshot.candidate, current.evaluatedCandidate) || !same(readExperimentCandidate({ workspace: ctx.workspace, paths: ctx.plan.fm.experiment.editable_files }), current.evaluatedCandidate))) throw fail('candidate changed before retained snapshot recovery settlement');
      return transition(inner, current, { state: resolution.decision === 'keep' ? 'kept' : resolution.decision === 'cancel' ? 'cancelled' : 'discarded', retainedSnapshot: resolution.decision === 'keep' ? resolution.snapshot : null, seriesStop: resolution.seriesStop || null });
    });
  }
  if (attempt.state !== 'running') return attempt;
  if (processIdentity(attempt.owner?.pid) === attempt.owner?.startIdentity) throw fail('execution controller is still live');
  for (const child of Object.values(attempt.children)) {
    if (child.state === 'reserved' || child.result?.groupReaped === true) continue;
    if (child.beforeSpawn || !child.startIdentity || !child.pid) throw fail('spawn crash window leaves owned group provenance unknown');
    const currentIdentity = processIdentity(child.pid);
    if (currentIdentity !== null) throw fail('owned process group is not proven reaped; recovery will not kill a recycled PID');
    if (process.platform === 'win32') throw fail('owned process-group absence is unavailable on this host; recovery remains blocked');
    try { process.kill(-child.groupId, 0); throw fail('owned process group remains live'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  return locked(options, (inner, live) => {
    const current = currentAttempt(live, attempt);
    if (current.sequence !== attempt.sequence) throw fail('attempt changed during process recovery');
    return transition(inner, current, { state: 'interrupted', interruption: { reason: 'controller died; owned groups proven absent', at: Date.now() } });
  });
}

export function experimentEditabilityCheck(options) {
  try {
    const ctx = context(options);
    const state = project(ctx);
    if (state.status !== 'absent') requireWorkspace(options);
    const attempt = state.active;
    const wallExpired = state.origin !== null && (options.now ?? Date.now()) >= state.origin + ctx.plan.fm.experiment.budget.max_seconds * 1000;
    const pass = Boolean(state.lastKept && ['candidate', 'repair'].includes(attempt?.kind) && !attempt.baselineCandidate && attempt.state === 'reserved' && !wallExpired && !['target-reached', 'cancelled', 'evaluator-invalid', 'blocked-workspace'].includes(state.status));
    return { pass, message: pass ? 'one reserved hypothesis may edit its exact candidate' : 'candidate edits require a retained baseline and an unstarted candidate reservation', files: pass ? ctx.plan.fm.experiment.editable_files : [], attempt: pass ? attempt.id : null };
  } catch (error) { return { pass: false, message: error.message, files: [] }; }
}

export function experimentStatus(options) {
  try {
    const ctx = context(options);
    const state = project(ctx);
    const workspace = state.status === 'absent' ? { pass: true, unclaimed: true } : validateExperimentWorkspace(options);
    if (state.status === 'ready' && (options.now ?? Date.now()) >= state.origin + ctx.plan.fm.experiment.budget.max_seconds * 1000) state.status = 'exhausted';
    return { ...state, workspace, editability: experimentEditabilityCheck(options), status: workspace.pass ? state.status : 'blocked-workspace' };
  } catch (error) { return { version: 1, status: 'blocked-workspace', pass: false, message: error.message, editability: { pass: false, files: [] } }; }
}

export function experimentExecutionBinding(options) {
  try {
    const ctx = context(options);
    const ownership = requireWorkspace(options);
    const state = project(ctx);
    const kept = state.lastKept;
    if (!kept) throw fail('retained baseline is missing');
    const candidate = readExperimentCandidate({ workspace: ctx.workspace, paths: ctx.plan.fm.experiment.editable_files });
    if (!same(candidate, kept.evaluatedCandidate)) throw fail('current candidate differs from latest retained measurement');
    if (!same(kept.retainedSnapshot.candidate, kept.evaluatedCandidate)) throw fail('retained snapshot candidate differs from latest retained measurement');
    verifyExperimentSnapshot({ workspace: ctx.workspace, snapshot: kept.retainedSnapshot });
    return { pass: true, binding: { version: 1, planId: ctx.planId, frozenDigest: state.frozenDigest, origin: state.origin, spent: state.spent, owner: ownership.claim, retainedAttempt: kept.id, candidate, metric: kept.measurement.metric, correctness: kept.measurement.correctness, measurement: kept.measurement, snapshot: kept.retainedSnapshot, target: ctx.plan.fm.experiment.target, status: state.status } };
  } catch (error) { return { pass: false, message: error.message }; }
}

export function experimentCompletionCheck(options) {
  const binding = experimentExecutionBinding(options);
  if (!binding.pass) return binding;
  try {
    const ctx = context(options);
    const state = project(ctx);
    if (state.active || state.status !== 'target-reached' || state.lastKept.measurement.correctness?.passed !== true || state.lastKept.measurement.metric.value > ctx.plan.fm.experiment.target) throw fail('experiment target is unmet or an attempt remains unresolved');
    const valid = measurementValid(options, state.lastKept);
    if (!valid.pass) throw fail(valid.message || 'retained trusted measurement validation failed');
    return { ...binding, pass: true };
  } catch (error) { return { pass: false, message: error.message }; }
}
