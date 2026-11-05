import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EXIT } from './style.mjs';

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30000;

function usage(message) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint: 'ae help plan-update' });
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function singleLockEntry(dir) {
  const entries = fs.opendirSync(dir, { bufferSize: 2 });
  try {
    const first = entries.readSync();
    return first && !entries.readSync() ? first : null;
  } finally { entries.closeSync(); }
}

function fileLockOwner(dir) {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const entry = singleLockEntry(dir);
    const match = entry?.name.match(/^owner-v1-([1-9][0-9]{0,15})-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/);
    if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
    const stamp = path.join(dir, entry.name), stampStat = fs.lstatSync(stamp);
    if (!stampStat.isDirectory() || stampStat.isSymbolicLink()) return null;
    const contents = fs.opendirSync(stamp, { bufferSize: 1 });
    try { if (contents.readSync()) return null; }
    finally { contents.closeSync(); }
    return { version: 1, pid: Number(match[1]), token: match[2], stamp: entry.name };
  } catch { return null; }
}

function removeFileLock(dir, token) {
  const owner = fileLockOwner(dir);
  if (owner?.token !== token) throw usage('plan-update: lock ownership lost; inspect the retained lock');
  fs.rmdirSync(path.join(dir, owner.stamp));
  fs.rmdirSync(dir);
}

function retireFileLock(dir, token, parent = path.dirname(dir)) {
  if (fileLockOwner(dir)?.token !== token) throw usage('plan-update: lock ownership lost; inspect the retained lock');
  const retirement = fs.mkdtempSync(path.join(parent, '.retired-'));
  try {
    const retired = path.join(retirement, 'lock');
    fs.renameSync(dir, retired);
    removeFileLock(retired, token);
  } finally {
    try { fs.rmdirSync(retirement); } catch { /* preserve mismatched or unexpected retired contents */ }
  }
}

export function acquireFileLock(lockDir) {
  const recovery = `${lockDir}.recovery`;
  const owner = { version: 1, token: randomUUID(), pid: process.pid };
  const start = Date.now();
  while (true) {
    const recovering = fs.lstatSync(recovery, { throwIfNoEntry: false });
    if (recovering) {
      if (!recovering.isDirectory() || recovering.isSymbolicLink()) throw usage('plan-update: unsafe lock recovery path; inspect before retrying');
      if (Date.now() - start > LOCK_WAIT_MS) throw usage('plan-update: lock recovery is busy; inspect the retained recovery directory before retrying');
      sleepMs(25);
      continue;
    }
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      // Empty owner directories keep legacy in-repo plan locks out of Git-observed proof scope.
      try { fs.mkdirSync(path.join(lockDir, `owner-v1-${owner.pid}-${owner.token}`), { mode: 0o700 }); }
      catch {
        try { fs.rmdirSync(lockDir); } catch { /* retain a nonempty or changed lock for inspection */ }
        throw usage('plan-update: lock owner could not be recorded');
      }
      if (fs.lstatSync(recovery, { throwIfNoEntry: false })) {
        retireFileLock(lockDir, owner.token);
        continue;
      }
      return { dir: lockDir, token: owner.token };
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      if (Date.now() - start > LOCK_WAIT_MS) {
        if (error.code !== 'EEXIST') throw error;
        throw usage('plan-update: plan is locked by another update');
      }
      if (error.code === 'EEXIST') {
        const stat = fs.lstatSync(lockDir, { throwIfNoEntry: false });
        if (!stat) continue;
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw usage('plan-update: unsafe lock path; inspect before removing it');
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          const previous = fileLockOwner(lockDir);
          if (!previous) throw usage('plan-update: lock owner is unreadable; inspect before removing it');
          let absent = false;
          try { process.kill(previous.pid, 0); }
          catch (error) {
            if (error.code === 'ESRCH') absent = true;
            else throw usage('plan-update: lock owner liveness is unavailable; absence is not proven');
          }
          if (absent) {
            try { fs.mkdirSync(recovery, { mode: 0o700 }); }
            catch (error) { if (error.code === 'EEXIST') continue; throw error; }
            try {
              if (fileLockOwner(lockDir)?.token !== previous.token) continue;
              const retired = path.join(recovery, 'retired');
              fs.renameSync(lockDir, retired);
              removeFileLock(retired, previous.token);
            } finally {
              try { fs.rmdirSync(recovery); } catch { /* retain unexpected recovery contents for inspection */ }
            }
            continue;
          }
        }
      }
      sleepMs(25);
    }
  }
}

export function releaseFileLock(lock) {
  const recovery = `${lock.dir}.recovery`;
  try { fs.mkdirSync(recovery, { mode: 0o700 }); }
  catch { throw usage('plan-update: lock recovery is busy; inspect before releasing the retained lock'); }
  try {
    retireFileLock(lock.dir, lock.token, recovery);
  } finally {
    try { fs.rmdirSync(recovery); } catch { /* preserve a mismatched retired owner for inspection */ }
  }
}

