import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { killLiveGroups, runGroupedProcess, trackStudyGroups } from '../eval/context/study.mjs';
import { UNLISTED_DIR_MODE, captureMemory, collectCarryForward, killStragglers, processStartTicks, removeTree, sweepStaleStudies, writeMemory } from '../eval/memory/study.mjs';

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

/**
 * PIDs verified dead at runtime: each is a short-lived child's, spawned and reaped here, and checked again before use, so no
 * test relies on a fixed PID being unused.
 */
function deadPids(count) {
  const pids = new Set();
  while (pids.size < count) {
    const pid = spawnSync(process.execPath, ['-e', '']).pid;
    let dead = false;
    try { process.kill(pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
    if (dead) pids.add(pid);
  }
  return [...pids];
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
  const [linkPid, stalePid, foreignPid] = deadPids(3);
  const victim = path.join(base, 'victim');
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, 'keep'), 'x');
  fs.chmodSync(victim, 0o755);
  const link = path.join(base, `aem-study-${linkPid}-abcdef`);
  fs.symlinkSync(victim, link);
  // A stale parent of this user holding a planted run- link: the parent goes, the link's target keeps its mode.
  const inner = path.join(base, 'inner-victim');
  fs.mkdirSync(inner);
  fs.chmodSync(inner, 0o755);
  const stale = path.join(base, `aem-study-${stalePid}-ghijkl`);
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
    const foreign = path.join(base, `aem-study-${foreignPid}-mnopqr`);
    fs.mkdirSync(foreign, { mode: 0o755 });
    fs.chmodSync(foreign, 0o755);
    fs.chownSync(foreign, 12345, 12345);
    assert.deepEqual(sweepStaleStudies(base), []);
    assert.equal(fs.existsSync(foreign), true);
    assert.equal(fs.lstatSync(foreign).mode & 0o7777, 0o755);
  }
});

test('sweepStaleStudies removes a stale parent holding a read-only directory deep inside it', { skip: !posix && 'POSIX modes' }, t => {
  const base = directory(t);
  const [stalePid] = deadPids(1);
  const stale = path.join(base, `aem-study-${stalePid}-stuvwx`);
  const deep = path.join(stale, 'run-abcdef', 'task-ghijkl', 'workspace', 'src');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'file.js'), 'x');
  // An agent made src read-only, then the runner was SIGKILLed; the runner had made the parent and run root unlisted.
  fs.chmodSync(deep, 0o555);
  fs.chmodSync(path.join(stale, 'run-abcdef'), UNLISTED_DIR_MODE);
  fs.chmodSync(stale, UNLISTED_DIR_MODE);
  if (root) {
    // Root ignores directory modes, so a stub makes removal fail the way it does for any other user: a directory without
    // owner write permission cannot lose its entries.
    const realRm = fs.rmSync;
    const locked = dir => {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory()) return false;
      return (stat.mode & 0o200) === 0 || fs.readdirSync(dir).some(name => locked(path.join(dir, name)));
    };
    t.mock.method(fs, 'rmSync', function (target, ...rest) {
      if (fs.existsSync(target) && locked(String(target))) throw Object.assign(new Error(`EACCES: permission denied, rmdir '${target}'`), { code: 'EACCES' });
      return realRm.call(this, target, ...rest);
    });
  }
  const swept = sweepStaleStudies(base);
  t.mock.restoreAll();
  assert.deepEqual(swept, [stale]);
  assert.equal(fs.existsSync(stale), false);
});

test('collectCarryForward counts the notes it drops for size and for the file limit', t => {
  const workspace = directory(t);
  const notes = path.join(workspace, 'docs', 'solutions', 'eval');
  fs.mkdirSync(notes, { recursive: true });
  const dropped = { oversized: 0, overFileLimit: 0, unsafe: 0, nonRegular: 0 };
  fs.writeFileSync(path.join(notes, 'a-large.md'), Buffer.alloc(256 * 1024 + 1, 'x'));
  fs.writeFileSync(path.join(notes, 'a-small.md'), 'note\n');
  assert.deepEqual(Object.keys(collectCarryForward(workspace, dropped)), ['docs/solutions/eval/a-small.md']);
  assert.deepEqual(dropped, { oversized: 1, overFileLimit: 0, unsafe: 0, nonRegular: 0 });
  for (let i = 0; i < 205; i++) fs.writeFileSync(path.join(notes, `n${String(i).padStart(3, '0')}.md`), 'n\n');
  const more = { oversized: 0, overFileLimit: 0, unsafe: 0, nonRegular: 0 };
  const carried = collectCarryForward(workspace, more);
  // 207 files: the first 200 by path are considered (the large one among them), the last 7 are past the limit.
  assert.equal(Object.keys(carried).length, 199);
  assert.deepEqual(more, { oversized: 1, overFileLimit: 7, unsafe: 0, nonRegular: 0 });
  assert.equal(carried['docs/solutions/eval/n204.md'], undefined);
});

test('collectCarryForward cuts at the first 200 paths by code point, and counts unsafe paths without giving them a slot', { skip: !posix && 'backslash file names' }, t => {
  const workspace = directory(t);
  const notes = path.join(workspace, 'docs', 'solutions', 'eval');
  fs.mkdirSync(notes, { recursive: true });
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(notes, `n${String(i).padStart(3, '0')}.md`), 'n\n');
  // Upper case sorts before lower case by code point, whatever the machine's locale; a locale collation puts it last.
  fs.writeFileSync(path.join(notes, 'Z.md'), 'z\n');
  // Paths a fixture may not hold sort first, so they would take slots if they were counted before the cut.
  fs.writeFileSync(path.join(notes, '0\\a.md'), 'x\n');
  fs.mkdirSync(path.join(notes, '.git'));
  fs.writeFileSync(path.join(notes, '.git', 'HEAD'), 'x\n');
  const dropped = { oversized: 0, overFileLimit: 0, unsafe: 0, nonRegular: 0 };
  const carried = collectCarryForward(workspace, dropped);
  assert.deepEqual(dropped, { oversized: 0, overFileLimit: 1, unsafe: 2, nonRegular: 0 });
  assert.equal(Object.keys(carried).length, 200);
  assert.ok(carried['docs/solutions/eval/Z.md'], 'Z.md is within the first 200 by code point');
  assert.ok(carried['docs/solutions/eval/n198.md'], 'unsafe paths take no slot');
  assert.equal(carried['docs/solutions/eval/n199.md'], undefined, 'the last path by code point is past the limit');
});

test('collectCarryForward refuses names Git would refuse or control, counting each as unsafe, and the rest still commit', { skip: !posix && 'trailing dots, spaces and colons in file names' }, t => {
  const workspace = directory(t);
  const notes = path.join(workspace, 'docs', 'solutions', 'eval');
  fs.mkdirSync(notes, { recursive: true });
  // Each passes safePath, but core.protectNTFS (on by default everywhere) makes `git add` refuse the first group, and the
  // second are Git control files: an agent-written `.gitignore` of `*` would silently keep the other notes out of the commit.
  const directories = ['.GIT', '.Git', '.git.', '.git ', '.git. .', '.git:stream', 'git~1', 'GIT~2', 'gitmod~1', '.g\u200cit', '.HARNESS'];
  const controlFiles = ['.gitignore', '.gitmodules', '.gitattributes', '.GITIGNORE', '.gitignore.'];
  for (const name of directories) {
    fs.mkdirSync(path.join(notes, name));
    fs.writeFileSync(path.join(notes, name, 'n.md'), 'n\n');
  }
  for (const name of controlFiles) fs.writeFileSync(path.join(notes, name), '*\n');
  fs.writeFileSync(path.join(notes, 'ok.md'), 'ok\n');
  fs.writeFileSync(path.join(notes, '.gitkeep'), '');
  fs.mkdirSync(path.join(notes, 'git~x'));
  fs.writeFileSync(path.join(notes, 'git~x', 'n.md'), 'n\n');
  const dropped = { oversized: 0, overFileLimit: 0, unsafe: 0, nonRegular: 0 };
  const carried = collectCarryForward(workspace, dropped);
  assert.deepEqual(Object.keys(carried).sort(), ['docs/solutions/eval/.gitkeep', 'docs/solutions/eval/git~x/n.md', 'docs/solutions/eval/ok.md']);
  assert.deepEqual(dropped, { oversized: 0, overFileLimit: 0, unsafe: directories.length + controlFiles.length, nonRegular: 0 });
  // What is carried commits in the next checkout.
  const next = path.join(directory(t), 'next');
  for (const [file, content] of Object.entries(carried)) {
    fs.mkdirSync(path.dirname(path.join(next, file)), { recursive: true });
    fs.writeFileSync(path.join(next, file), content);
  }
  const git = args => spawnSync('git', args, { cwd: next, encoding: 'utf8' });
  assert.equal(git(['init', '-q']).status, 0);
  assert.equal(git(['add', '.']).status, 0);
  assert.deepEqual(git(['ls-files']).stdout.trim().split('\n').sort(), Object.keys(carried).sort());
});

test('collectCarryForward counts entries that are not regular files before the file-limit cut, and gives them no slot', { skip: !posix && 'symlinks and FIFOs' }, t => {
  const workspace = directory(t);
  const notes = path.join(workspace, 'docs', 'solutions', 'eval');
  fs.mkdirSync(notes, { recursive: true });
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(notes, `n${String(i).padStart(3, '0')}.md`), 'n\n');
  // Both sort before every note, so they would take slots if they were cut first.
  fs.symlinkSync(path.join(notes, 'n000.md'), path.join(notes, 'a-link.md'));
  assert.equal(spawnSync('mkfifo', [path.join(notes, 'a-fifo.md')]).status, 0);
  const dropped = { oversized: 0, overFileLimit: 0, unsafe: 0, nonRegular: 0 };
  const carried = collectCarryForward(workspace, dropped);
  assert.deepEqual(dropped, { oversized: 0, overFileLimit: 0, unsafe: 0, nonRegular: 2 });
  assert.equal(Object.keys(carried).length, 200);
  assert.ok(carried['docs/solutions/eval/n199.md']);
});

test('collectCarryForward does not follow a note swapped for a symlink after it was listed', { skip: !posix && 'symlinks' }, t => {
  const workspace = directory(t);
  const notes = path.join(workspace, 'docs', 'solutions', 'eval');
  fs.mkdirSync(notes, { recursive: true });
  const secret = path.join(directory(t), 'secret');
  fs.writeFileSync(secret, 'secret\n');
  const note = path.join(notes, 'note.md');
  fs.writeFileSync(note, 'note\n');
  // The note becomes a link to a file outside just before it is opened for reading, whichever call opens it.
  let swapped = false;
  const swap = file => { if (!swapped && file === note) { swapped = true; fs.rmSync(note); fs.symlinkSync(secret, note); } };
  const { openSync, readFileSync } = fs;
  t.mock.method(fs, 'openSync', function (file, ...rest) { swap(file); return openSync.call(this, file, ...rest); });
  t.mock.method(fs, 'readFileSync', function (file, ...rest) { swap(file); return readFileSync.call(this, file, ...rest); });
  const dropped = { oversized: 0, overFileLimit: 0, unsafe: 0, nonRegular: 0 };
  const carried = collectCarryForward(workspace, dropped);
  t.mock.restoreAll();
  assert.equal(swapped, true);
  assert.deepEqual(carried, {});
  assert.equal(dropped.nonRegular, 1);
});

test('memory limits apply to each target on its own, and structural caches keyed by an earlier checkout are not carried', t => {
  const base = directory(t);
  const make = name => {
    const homes = { copilotHome: path.join(base, name, 'copilot'), harnessHome: path.join(base, name, 'state'), feedback: true };
    homes.projectDir = path.join(homes.harnessHome, 'projects', 'repo-id');
    fs.mkdirSync(homes.copilotHome, { recursive: true });
    fs.mkdirSync(homes.harnessHome, { recursive: true });
    return homes;
  };
  const from = make('from');
  const put = (file, text = 'x\n') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  // 1,990 index files, 20 notes and 1 feedback record: over 2,000 entries together, well under it for each target.
  const postings = path.join(from.harnessHome, 'index', 'repo-id', 'knowledge');
  for (let i = 0; i < 1990; i++) put(path.join(postings, `p${i}.json`));
  for (let i = 0; i < 20; i++) put(path.join(from.projectDir, 'docs', 'solutions', 'eval', `n${i}.md`), 'note\n');
  put(path.join(from.projectDir, 'feedback', 'r1.json'), '{}\n');
  // An earlier task's structural cache, keyed by that checkout's path, which no later checkout reads.
  const cache = path.join(from.harnessHome, 'index', 'repo-id', 'wt-0123456789ab', 'structural');
  for (let i = 0; i < 20; i++) put(path.join(cache, `s${i}.json`));
  const captured = captureMemory(from);
  assert.deepEqual(captured.refused, []);
  const to = make('to');
  writeMemory(to, captured);
  assert.equal(fs.readdirSync(path.join(to.harnessHome, 'index', 'repo-id', 'knowledge')).length, 1990);
  assert.equal(fs.readdirSync(path.join(to.projectDir, 'docs', 'solutions', 'eval')).length, 20);
  assert.deepEqual(fs.readdirSync(path.join(to.projectDir, 'feedback')), ['r1.json']);
  assert.deepEqual(fs.readdirSync(path.join(to.harnessHome, 'index', 'repo-id')), ['knowledge'], 'the structural cache stays behind');
  // One target over the limit on its own is still refused, and the refusal names it.
  for (let i = 1990; i < 2001; i++) put(path.join(postings, `p${i}.json`));
  const over = captureMemory(from);
  assert.deepEqual(over.refused, ['index: more files than the memory limit']);
});

test('only lock state the lock code writes is skipped; notes with lock-like names are carried', t => {
  const base = directory(t);
  const make = name => {
    const homes = { copilotHome: path.join(base, name, 'copilot'), harnessHome: path.join(base, name, 'state'), feedback: true };
    homes.projectDir = path.join(homes.harnessHome, 'projects', 'repo-id');
    fs.mkdirSync(homes.copilotHome, { recursive: true });
    fs.mkdirSync(homes.harnessHome, { recursive: true });
    return homes;
  };
  const from = make('from');
  const store = path.join(from.harnessHome, 'knowledge', 'repo-id');
  const put = (file, text = 'x\n') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  // Lock artifacts: the store lock and its takeover tombstone, git's lock files, and the skill usage lock.
  put(path.join(store, '.lock', 'owner.json'));
  put(path.join(store, '.lock.stale-0123456789abcdef', 'owner.json'));
  put(path.join(store, '.git', 'index.lock'));
  put(path.join(store, '.git', 'refs', 'heads', 'main.lock'));
  put(path.join(store, '.git', 'HEAD'));
  put(path.join(from.copilotHome, 'knowledge', 'skill-usage.yaml.lock'));
  put(path.join(from.copilotHome, 'knowledge', 'skill-usage.yaml'));
  // Legitimate notes whose names only look like locks.
  const notes = [
    path.join(store, 'learnings', 'javascript', 'db.stale-cache.md'),
    path.join(store, 'learnings', 'javascript', 'package.lock'),
    path.join(store, 'learnings', '.lock'),
    path.join(from.projectDir, 'docs', 'solutions', 'eval', 'yarn.lock'),
    path.join(from.projectDir, 'docs', 'solutions', 'eval', 'retry.stale-reads.md'),
    path.join(from.projectDir, 'feedback', 'x.lock'),
    path.join(from.copilotHome, 'knowledge', 'notes', 'skill-usage.yaml.lock'),
  ];
  for (const note of notes) put(note, 'note\n');
  const captured = captureMemory(from);
  assert.deepEqual(captured.refused, []);
  const to = make('to');
  writeMemory(to, captured);
  const moved = file => file.startsWith(from.copilotHome + path.sep)
    ? path.join(to.copilotHome, path.relative(from.copilotHome, file))
    : path.join(to.harnessHome, path.relative(from.harnessHome, file));
  for (const note of notes) assert.equal(fs.readFileSync(moved(note), 'utf8'), 'note\n', path.relative(base, note));
  const toStore = path.join(to.harnessHome, 'knowledge', 'repo-id');
  assert.deepEqual(fs.readdirSync(toStore).sort(), ['.git', 'learnings']);
  assert.deepEqual(fs.readdirSync(path.join(toStore, '.git')).sort(), ['HEAD', 'refs']);
  assert.deepEqual(fs.readdirSync(path.join(toStore, '.git', 'refs', 'heads')), []);
  assert.deepEqual(fs.readdirSync(path.join(to.copilotHome, 'knowledge')).sort(), ['notes', 'skill-usage.yaml']);
});

test('run.mjs accepts only a plain positive decimal --repeats', t => {
  const out = path.join(directory(t), 'fresh');
  const run = path.join(import.meta.dirname, '..', 'eval', 'memory', 'run.mjs');
  for (const value of ['0', '0x2', '1e1', ' 3 ', '2.0', '-1', '+2', '03']) {
    const cli = spawnSync(process.execPath, [run, '--out', out, '--repeats', value], { encoding: 'utf8' });
    assert.notEqual(cli.status, 0, value);
    assert.match(cli.stderr, /--repeats must be a positive decimal integer/, value);
    assert.equal(fs.existsSync(out), false, value);
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
