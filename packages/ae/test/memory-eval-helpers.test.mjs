import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { killLiveGroups, runGroupedProcess, trackStudyGroups } from '../eval/context/study.mjs';
import { UNLISTED_DIR_MODE, killStragglers, processStartTicks, removeTree, sweepStaleStudies } from '../eval/memory/study.mjs';

// Fast unit tests for the memory study's process and cleanup helpers. The study tests that exercise them end to end
// (memory-eval.test.mjs, context-eval.test.mjs) are too slow for the pull-request tier, so these keep the helpers covered there.

const posix = process.platform !== 'win32';
const root = process.getuid?.() === 0;

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-helpers-'));
  t.after(() => removeTree(dir));
  return dir;
}

/** Whether `pid` is running; a zombie (killed but not yet reaped) counts as dead. */
function running(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '')[0] !== 'Z'; } catch { return true; }
}

async function waitDead(pid, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (!running(pid)) return true;
    await new Promise(done => setTimeout(done, 20));
  }
  return !running(pid);
}

test('runGroupedProcess returns output and status, and kills what the leader left in its group', { skip: !posix && 'POSIX process groups' }, async t => {
  const dir = directory(t);
  const marker = path.join(dir, 'child.pid');
  const script = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(c.pid)); c.unref(); process.stdout.write('done'); process.exitCode = 3;`;
  const result = await runGroupedProcess(process.execPath, ['-e', script], { cwd: dir, env: process.env, timeoutMs: 10_000 });
  assert.equal(result.status, 3);
  assert.equal(result.stdout, 'done');
  assert.equal(result.error, null);
  const pid = Number(fs.readFileSync(marker, 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  assert.equal(await waitDead(pid), true, 'the background child died with its group');
  const slow = await runGroupedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, env: process.env, timeoutMs: 150 });
  assert.equal(slow.error?.code, 'ETIMEDOUT');
  assert.equal(slow.status, null);
});

test('trackStudyGroups collects a study\'s live groups and killLiveGroups kills only those', { skip: !posix && 'POSIX process groups' }, async t => {
  const dir = directory(t);
  const mine = new Set();
  const other = new Set();
  const forever = ['-e', 'setInterval(() => {}, 1000)'];
  let pending;
  await trackStudyGroups(mine, async () => { pending = runGroupedProcess(process.execPath, forever, { cwd: dir, env: process.env, timeoutMs: 20_000 }); });
  let otherPending;
  await trackStudyGroups(other, async () => { otherPending = runGroupedProcess(process.execPath, forever, { cwd: dir, env: process.env, timeoutMs: 20_000 }); });
  assert.equal(mine.size, 1);
  assert.equal(other.size, 1);
  const [otherPid] = other;
  t.after(() => killLiveGroups(other));
  killLiveGroups(mine);
  assert.equal(mine.size, 0, 'the killed set is cleared');
  const result = await pending;
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(running(otherPid), true, 'another study\'s group is untouched');
  killLiveGroups(other);
  assert.equal((await otherPending).signal, 'SIGKILL');
});

test('removeTree removes read-only and unlisted directories and records failures instead of throwing', t => {
  const dir = directory(t);
  const tree = path.join(dir, 'tree');
  const locked = path.join(tree, 'locked');
  const unlisted = path.join(tree, 'unlisted');
  fs.mkdirSync(path.join(locked, 'deep'), { recursive: true });
  fs.mkdirSync(unlisted);
  fs.writeFileSync(path.join(locked, 'deep', 'file'), 'x');
  fs.writeFileSync(path.join(unlisted, 'file'), 'x');
  if (posix) { fs.chmodSync(locked, 0o555); fs.chmodSync(unlisted, UNLISTED_DIR_MODE); }
  const failures = [];
  assert.equal(removeTree(tree, failures), true);
  assert.deepEqual(failures, []);
  assert.equal(fs.existsSync(tree), false);
  assert.equal(removeTree(path.join(dir, 'absent'), failures), true, 'an absent tree is already removed');
});

test('the unlisted mode gives the owner write and search only', () => {
  assert.equal(UNLISTED_DIR_MODE, 0o300);
});

test('sweepStaleStudies never follows or chmods a planted symlink, and skips entries another user owns', { skip: !posix && 'POSIX modes and symlinks' }, t => {
  const base = directory(t);
  const victim = path.join(base, 'victim');
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, 'keep'), 'x');
  fs.chmodSync(victim, 0o755);
  const link = path.join(base, 'aem-study-999999-abcdef');
  fs.symlinkSync(victim, link);
  // A stale parent of this user holding a planted run- link: the parent goes, the link's target keeps its mode.
  const inner = path.join(base, 'inner-victim');
  fs.mkdirSync(inner);
  fs.chmodSync(inner, 0o755);
  const stale = path.join(base, 'aem-study-999998-ghijkl');
  fs.mkdirSync(stale);
  fs.symlinkSync(inner, path.join(stale, 'run-abcdef'));
  const swept = sweepStaleStudies(base);
  assert.equal(fs.lstatSync(victim).mode & 0o7777, 0o755, 'the symlink target keeps its mode');
  assert.equal(fs.existsSync(path.join(victim, 'keep')), true);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the planted link is left alone');
  assert.equal(swept.includes(link), false);
  assert.deepEqual(swept, [stale]);
  assert.equal(fs.lstatSync(inner).mode & 0o7777, 0o755, 'a run- link inside a stale parent is not followed');
  if (root) {
    // Only root can make a directory another user owns; the sweep must leave it, mode included.
    const foreign = path.join(base, 'aem-study-999997-mnopqr');
    fs.mkdirSync(foreign, { mode: 0o755 });
    fs.chmodSync(foreign, 0o755);
    fs.chownSync(foreign, 12345, 12345);
    assert.deepEqual(sweepStaleStudies(base), []);
    assert.equal(fs.existsSync(foreign), true);
    assert.equal(fs.lstatSync(foreign).mode & 0o7777, 0o755);
  }
});

test('killStragglers kills processes working under the study parent only if they started after the runner', { skip: process.platform !== 'linux' && '/proc' }, async t => {
  const dir = directory(t);
  const inside = path.join(dir, 'task');
  fs.mkdirSync(inside);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: inside, detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve(signal)));
  // Wait until its working directory is visible in /proc.
  for (let i = 0; i < 100; i++) {
    try { if (fs.readlinkSync(`/proc/${child.pid}/cwd`) === fs.realpathSync(inside)) break; } catch { /* starting */ }
    await new Promise(done => setTimeout(done, 10));
  }
  const started = processStartTicks(child.pid);
  assert.ok(Number.isSafeInteger(started), 'the start time is readable');
  assert.ok(started >= processStartTicks(process.pid), 'the child started after this process');
  // A process older than the guard, such as an operator's shell that changed into a task root, is spared.
  assert.deepEqual(killStragglers(dir, { since: started + 1 }), []);
  assert.equal(running(child.pid), true);
  // Outside the parent nothing is killed.
  const elsewhere = path.join(dir, 'elsewhere');
  fs.mkdirSync(elsewhere);
  assert.deepEqual(killStragglers(elsewhere), []);
  // By default the guard is this runner's own start, and the child started later.
  assert.deepEqual(killStragglers(dir), [child.pid]);
  assert.equal(await exited, 'SIGKILL');
});
