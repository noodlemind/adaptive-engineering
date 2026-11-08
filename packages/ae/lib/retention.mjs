import fs from 'node:fs';
import path from 'node:path';

/** Below this the file is not worth reading to prune. ~1 MiB of JSONL is on the
 * order of ten thousand entries; nobody is served by rewriting less. */
export const PRUNE_MIN_BYTES = 1024 * 1024;

export const DEFAULT_RETENTION_DAYS = 30;

/** The lock a prune holds and an append respects. Same path derivation on both
 * sides, so the two cannot disagree about which file they are coordinating on. */
export function pruneLockPath(file) {
  return `${file}.prune-lock`;
}

export function appendGuarded(file, line, { retries = 20, waitMs = 5, fsImpl = fs } = {}) {
  const lockPath = pruneLockPath(file);
  let held = null;
  for (let i = 0; i < retries; i += 1) {
    try {
      held = fsImpl.openSync(lockPath, 'wx');
      break;
    } catch {
      const until = Date.now() + waitMs;
      while (Date.now() < until) { /* spin */ }
    }
  }
  try {
    fsImpl.appendFileSync(file, line, 'utf8');
  } finally {
    if (held !== null) {
      try { fsImpl.closeSync(held); } catch { /* already closed */ }
      try { fsImpl.unlinkSync(lockPath); } catch { /* already gone */ }
    }
  }
}

const pruned = new Set();

export function resetRetentionState() {
  pruned.clear();
}

function cutoffIso(retentionDays, now) {
  return new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

export function pruneJournalFile(file, {
  retentionDays = DEFAULT_RETENTION_DAYS,
  now = Date.now(),
  minBytes = PRUNE_MIN_BYTES,
  oncePerProcess = true,
  markerFor = null,
} = {}) {
  if (oncePerProcess && pruned.has(file)) return { removed: 0, kept: 0, skipped: true };
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { removed: 0, kept: 0, skipped: true };
  }
  if (oncePerProcess) pruned.add(file);
  if (size < minBytes) return { removed: 0, kept: 0, skipped: true };

  const cutoffMs = now - retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = cutoffIso(retentionDays, now);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

    const parsed = lines.map((line) => {
    try {
      const record = JSON.parse(line);
      const at = Date.parse(record?.ts);
      return { line, record, at: Number.isFinite(at) ? at : null };
    } catch {
      return { line, record: null, at: null };
    }
  });

    const newestByRun = new Map();
  for (const entry of parsed) {
    const id = entry.record?.run;
    if (!id) continue;
    const current = newestByRun.get(id);
    if (entry.at === null) newestByRun.set(id, Infinity);
    else if (current === undefined || entry.at > current) newestByRun.set(id, entry.at);
  }

    const dropped = new Set();
  let removed = 0;
  let keptCount = 0;
  for (const entry of parsed) {
    const id = entry.record?.run;
    const age = id ? newestByRun.get(id) : entry.at;
    if (age !== null && age !== undefined && Number.isFinite(age) && age < cutoffMs) {
      removed += 1;
      dropped.add(entry.line);
      continue;
    }
    keptCount += 1;
  }
  if (removed === 0) return { removed: 0, kept: keptCount, skipped: false };

    const lockPath = pruneLockPath(file);
  let lockFd;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
  } catch {
    return { removed: 0, kept: 0, skipped: true };
  }

  try {
    const snapshot = fs.statSync(file);
    const currentLines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const finalLines = currentLines.filter((line) => !dropped.has(line));
    if (markerFor) finalLines.push(JSON.stringify(markerFor({ removed, cutoff })));

    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.prune-${process.pid}`);
    fs.writeFileSync(tmp, finalLines.length ? `${finalLines.join('\n')}\n` : '', 'utf8');

    const now = fs.statSync(file);
    if (now.size !== snapshot.size || now.mtimeMs !== snapshot.mtimeMs) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      return { removed: 0, kept: 0, skipped: true, abandoned: 'the journal changed while pruning' };
    }
    fs.renameSync(tmp, file);
    return { removed, kept: finalLines.length, skipped: false };
  } finally {
    fs.closeSync(lockFd);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* best effort */
    }
  }
}
