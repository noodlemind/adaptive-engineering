import fs from 'node:fs';
import path from 'node:path';

const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : null;
export const DEFAULT_MAX_BYTES = 10_000_000;

export function readBoundedInput(fd = 0, { maxBytes = 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return null;
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const buffer = Buffer.alloc(Math.min(4096, maxBytes + 1 - total));
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) return Buffer.concat(chunks, total).toString('utf8');
      total += count;
      if (total > maxBytes) return null;
      chunks.push(buffer.subarray(0, count));
    }
  } catch { return null; }
}

export function canonicalPath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return fs.realpathSync(p);
  }
}

function canonicalRoot(root) {
  if (root == null) return null;
  try {
    return canonicalPath(path.resolve(root));
  } catch {
    return null;
  }
}

/** Is the already-canonical absolute `candidate` inside the canonical `realRoot`? */
function containedUnder(candidate, realRoot) {
  return candidate === realRoot || candidate.startsWith(realRoot + path.sep);
}

function fdMatchesCanonicalUnderRoot(full, fdStat, realRoot) {
  let real;
  try {
    real = canonicalPath(full);
  } catch {
    return false;
  }
  if (!containedUnder(real, realRoot)) return false;
  let lst;
  try {
    lst = fs.lstatSync(real);
  } catch {
    return false;
  }
  return lst.dev === fdStat.dev && lst.ino === fdStat.ino;
}

export function assertNoSymlinkAncestors(root, rel) {
  const rootFull = path.resolve(root);
  try {
    if (fs.lstatSync(rootFull).isSymbolicLink()) return null;
  } catch {
      }
  const full = path.resolve(rootFull, rel);
  const relative = path.relative(rootFull, full);
  if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) return null;
  let cur = rootFull;
  const parts = relative === '' ? [] : relative.split(path.sep);
  for (const part of parts) {
    cur = path.join(cur, part);
    let stat;
    try {
      stat = fs.lstatSync(cur);
    } catch {
      break; // nothing here yet — the rest of the path is safe to create
    }
    if (stat.isSymbolicLink()) return null;
  }
  return full;
}

export function assertRealpathContained(root, rel) {
  const rootFull = path.resolve(root);
  const full = assertNoSymlinkAncestors(rootFull, rel);
  if (!full) return null;
  const realRoot = canonicalRoot(rootFull);
  if (realRoot === null) return null;
  let realFull;
  try {
    realFull = canonicalPath(full);
  } catch {
    return null; // target doesn't exist / unreadable — nothing safe to act on
  }
  if (!containedUnder(realFull, realRoot)) return null;
  return full;
}

const PREFIX_BYTES = 8192;

function isRegularFile(full) {
  try {
    return fs.lstatSync(full).isFile();
  } catch {
    return false;
  }
}

function openReadNoFollow(full) {
  const base = fs.constants.O_RDONLY | (O_NOFOLLOW ?? 0);
  const nonblock = fs.constants.O_NONBLOCK;
  if (typeof nonblock === 'number' && process.platform !== 'win32') {
    try {
      return fs.openSync(full, base | nonblock);
    } catch (error) {
      if (!error || (error.code !== 'EINVAL' && error.code !== 'ENOTSUP')) throw error;
    }
  }
  return fs.openSync(full, base);
}

export function readPrefixNoFollow(full, { root = null } = {}) {
  const realRoot = canonicalRoot(root);
  if (root != null && realRoot === null) return null;
  if (!isRegularFile(full)) return null;

  let fd;
  try {
    fd = openReadNoFollow(full);
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    if (O_NOFOLLOW === null) {
      try {
        if (fs.lstatSync(full).isSymbolicLink()) return null;
      } catch {
        return null;
      }
    }
    if (realRoot !== null && !fdMatchesCanonicalUnderRoot(full, stat, realRoot)) return null;
    const toRead = Math.min(stat.size, PREFIX_BYTES);
    if (toRead === 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(toRead);
    let offset = 0;
    while (offset < toRead) {
      const n = fs.readSync(fd, buf, offset, toRead - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    return buf.subarray(0, offset);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export function readFileNoFollow(full, { maxBytes = DEFAULT_MAX_BYTES, root = null, encoding = 'utf8' } = {}) {
  const realRoot = canonicalRoot(root);
    if (root != null && realRoot === null) return null;
  if (!isRegularFile(full)) return null;

  if (O_NOFOLLOW !== null) {
    let fd;
    try {
      fd = openReadNoFollow(full);
    } catch {
      return null;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > maxBytes) return null;
      if (realRoot !== null && !fdMatchesCanonicalUnderRoot(full, stat, realRoot)) return null;
      const buf = Buffer.alloc(stat.size);
      fs.readSync(fd, buf, 0, stat.size, 0);
      return encoding == null ? buf : buf.toString(encoding);
    } catch {
      return null;
    } finally {
      fs.closeSync(fd);
    }
  }

  // Windows / no O_NOFOLLOW.
  let fd;
  try {
    fd = openReadNoFollow(full);
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    try {
      if (fs.lstatSync(full).isSymbolicLink()) return null;
    } catch {
      return null;
    }
    if (realRoot !== null && !fdMatchesCanonicalUnderRoot(full, stat, realRoot)) return null;
    const buf = Buffer.alloc(stat.size);
    fs.readSync(fd, buf, 0, stat.size, 0);
    return encoding == null ? buf : buf.toString(encoding);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export function realpathParentContained(root, full) {
  const realRoot = canonicalRoot(root);
  if (realRoot === null) return false;
  let realParent;
  try {
    realParent = canonicalPath(path.dirname(full));
  } catch {
    return false;
  }
  return containedUnder(realParent, realRoot);
}

export function appendFileContained(root, rel, content, { newlineGuard = false } = {}) {
  const rootFull = path.resolve(root);
  const full = assertNoSymlinkAncestors(rootFull, rel);
  if (!full) return null;
  const realRoot = canonicalRoot(rootFull);
  if (realRoot === null) return null;
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
  } catch {
    return null;
  }
  let existedBefore = true;
  try {
    fs.lstatSync(full);
  } catch {
    existedBefore = false;
  }
  const flags = fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | (O_NOFOLLOW === null ? 0 : O_NOFOLLOW);
  let fd;
  try {
    fd = fs.openSync(full, flags, 0o666);
  } catch {
    return null;
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      fs.closeSync(fd);
    } catch {
      /* already gone */
    }
  };
  const refuse = () => {
    close();
    if (!existedBefore) {
      try {
        fs.unlinkSync(full);
      } catch {
        /* best effort */
      }
    }
    return null;
  };
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return refuse();
    if (O_NOFOLLOW === null) {
      try {
        if (fs.lstatSync(full).isSymbolicLink()) return refuse();
      } catch {
        return refuse();
      }
    }
    if (!fdMatchesCanonicalUnderRoot(full, stat, realRoot)) return refuse();
    let prefix = '';
    if (newlineGuard && stat.size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, stat.size - 1);
      if (last.toString('utf8') !== '\n') prefix = '\n';
    }
    const buf = Buffer.from(prefix + content, 'utf8');
    let written = 0;
    while (written < buf.length) {
      const n = fs.writeSync(fd, buf, written, buf.length - written);
      if (!(n > 0)) return refuse();
      written += n;
    }
    close();
    return full;
  } catch {
    return refuse();
  }
}

export function writeFileContained(root, rel, content, { exclusive = false, mode } = {}) {
  if (mode !== undefined && (!Number.isInteger(mode) || mode < 0 || mode > 0o777)) return null;
  const rootFull = path.resolve(root);
  const full = assertNoSymlinkAncestors(rootFull, rel);
  if (!full) return null;
  const parent = path.dirname(full);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = path.join(parent, `.tmp-${path.basename(full)}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let fd;
  try {
    fd = mode === undefined ? fs.openSync(tmp, 'wx') : fs.openSync(tmp, 'wx', mode);
  } catch {
    return null;
  }
  const cleanup = () => {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort — a swapped-away temp is not ours to chase */
    }
  };
    if (!realpathParentContained(rootFull, full)) {
    try {
      fs.closeSync(fd);
    } catch {
      /* fd may already be gone if the leaf was swapped away */
    }
    cleanup();
    return null;
  }
  // Verify passed: write content THROUGH the verified descriptor, then close.
  try {
    fs.writeFileSync(fd, content, { encoding: 'utf8' });
    if (mode !== undefined) fs.fchmodSync(fd, mode);
    fs.closeSync(fd);
  } catch {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed / gone */
    }
    cleanup();
    return null;
  }
  try {
    if (exclusive) fs.linkSync(tmp, full);
    else fs.renameSync(tmp, full);
  } catch {
    cleanup();
    return null;
  }
  if (exclusive) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The published name is the hard link. A leftover temp is the same inode.
    }
  }
  return full;
}

export function writeFileContainedExclusive(root, rel, content) {
  return writeFileContained(root, rel, content, { exclusive: true });
}

/** Copy bytes from srcRel under srcRoot to destRel under destRoot. Fails if
 * dest already exists (exclusive create) or any ancestor is a symlink. */
export function copyFileContainedExclusive(srcRoot, srcRel, destRoot, destRel) {
  const srcBase = path.resolve(srcRoot);
  const destBase = path.resolve(destRoot);
  const srcFull = assertNoSymlinkAncestors(srcBase, srcRel);
  const destFull = assertNoSymlinkAncestors(destBase, destRel);
  if (!srcFull || !destFull) return null;

  const srcFlags = O_NOFOLLOW != null ? fs.constants.O_RDONLY | O_NOFOLLOW : fs.constants.O_RDONLY;
  let srcFd;
  try {
    srcFd = fs.openSync(srcFull, srcFlags);
  } catch {
    return null;
  }

  const abortDest = (destFd) => {
    if (destFd != null) {
      try {
        fs.closeSync(destFd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.unlinkSync(destFull);
    } catch {
      /* best effort — a swapped-away dest is not ours to chase */
    }
  };

  try {
    const srcStat = fs.fstatSync(srcFd);
    if (!srcStat.isFile() || srcStat.size > DEFAULT_MAX_BYTES) return null;
    const srcRealRoot = canonicalRoot(srcBase);
    if (srcRealRoot === null || !fdMatchesCanonicalUnderRoot(srcFull, srcStat, srcRealRoot)) return null;

    try {
      fs.mkdirSync(path.dirname(destFull), { recursive: true });
    } catch {
      return null;
    }
    if (!realpathParentContained(destBase, destFull)) return null;

    const destFlags = O_NOFOLLOW != null
      ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW
      : 'wx';
    let destFd;
    try {
      destFd = fs.openSync(destFull, destFlags, 0o644);
    } catch {
      return null;
    }
    try {
      const destStat = fs.fstatSync(destFd);
      const destRealRoot = canonicalRoot(destBase);
      if (destRealRoot === null || !fdMatchesCanonicalUnderRoot(destFull, destStat, destRealRoot)) {
        abortDest(destFd);
        return null;
      }
      const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(srcStat.size, 1)));
      let offset = 0;
      while (offset < srcStat.size) {
        const n = fs.readSync(srcFd, chunk, 0, Math.min(chunk.length, srcStat.size - offset), offset);
        if (n <= 0) break;
        let wrote = 0;
        while (wrote < n) {
          const w = fs.writeSync(destFd, chunk, wrote, n - wrote);
          if (w <= 0) {
            abortDest(destFd);
            return null;
          }
          wrote += w;
        }
        offset += n;
      }
      if (offset !== srcStat.size) {
        abortDest(destFd);
        return null;
      }
      fs.closeSync(destFd);
      return destFull;
    } catch {
      abortDest(destFd);
      return null;
    }
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(srcFd);
    } catch {
      /* already closed */
    }
  }
}
