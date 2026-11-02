import { gitExecutable } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertNoSymlinkAncestors, canonicalPath, readFileNoFollow } from './fs-safe.mjs';
import { gitMetadataEnvironment } from '../corpus/hooks/lib/product-diff.mjs';

const MAX_BYTES = 1024 * 1024;
const OID = /^[a-f0-9]{40,64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => Object.assign(new Error(`experiment: ${message}`), { code: 'E_EXPERIMENT', exit: 1 });

function exactPath(workspace, rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 4096 || path.isAbsolute(rel) || /[\x00-\x1f\x7f\\]/.test(rel) || rel.split('/').some(part => !part || part === '.' || part === '..') || rel.startsWith('.git/')) throw fail('editable path must be exact and contained');
  const full = assertNoSymlinkAncestors(workspace, rel);
  if (!full) throw fail('editable path must be contained without symlinks');
  return full;
}

function regularBytes(workspace, rel) {
  const full = exactPath(workspace, rel);
  const stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES || stat.mode & 0o111) throw fail('candidate must be bounded regular nonexecutable bytes');
  const bytes = readFileNoFollow(full, { root: workspace, maxBytes: MAX_BYTES, encoding: null });
  if (bytes === null) throw fail('candidate bytes are unreadable');
  return { bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), mode: stat.mode & 0o777 };
}

export function readExperimentCandidate({ workspace, paths }) {
  if (!Array.isArray(paths) || paths.length !== 1 || new Set(paths).size !== paths.length) throw fail('supported candidate requires one exact editable file');
  const files = paths.map(rel => { const { bytes, mode } = regularBytes(workspace, rel); return { path: rel, sha256: hash(bytes), mode, bytes: bytes.length }; });
  return { version: 1, files, digest: hash(JSON.stringify(files)) };
}

function safeRoot(root, create = false) {
  const resolved = path.resolve(root);
  if (!assertNoSymlinkAncestors(path.parse(resolved).root, path.relative(path.parse(resolved).root, resolved))) throw fail('snapshot authority contains a symlink');
  if (create) fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(resolved).isDirectory()) throw fail('snapshot authority must be a directory');
  return canonicalPath(resolved);
}

function writeRecord(root, name, record) {
  const bytes = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw fail('snapshot record is oversized');
  const destination = assertNoSymlinkAncestors(root, name);
  if (!destination) throw fail('snapshot record path is unsafe');
  try { fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST' || readFileNoFollow(destination, { root, maxBytes: MAX_BYTES }) !== bytes) throw fail('snapshot replay conflicts with existing record');
  }
}

function git(workspace, args, { input, index } = {}) {
  const env = { ...gitMetadataEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_LITERAL_PATHSPECS: '1' };
  if (index) env.GIT_INDEX_FILE = index;
  const result = spawnSync(gitExecutable(), ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'core.untrackedCache=false', ...args], { cwd: workspace, env, input, timeout: 10000, maxBuffer: 2 * MAX_BYTES });
  if (result.error || result.status !== 0) throw fail('private snapshot Git operation failed');
  return result.stdout;
}

function expectedCandidateCheck(workspace, expectedCandidate, candidate) {
  if (!expectedCandidate) return;
  if (JSON.stringify(candidate) !== JSON.stringify(expectedCandidate) || JSON.stringify(readExperimentCandidate({ workspace, paths: expectedCandidate.files.map(file => file.path) })) !== JSON.stringify(expectedCandidate)) throw fail('snapshot candidate changed from the expected measured bytes');
}

export function createExperimentSnapshot({ workspace, root, id, paths, now = Date.now(), beforePublish, expectedCandidate }) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id || '')) throw fail('snapshot ID is invalid');
  const authority = safeRoot(root, true);
  const candidate = readExperimentCandidate({ workspace, paths });
  expectedCandidateCheck(workspace, expectedCandidate, candidate);
  const recordName = `${id}.json`;
  const existing = readFileNoFollow(path.join(authority, recordName), { root: authority, maxBytes: MAX_BYTES });
  if (existing !== null) {
    const snapshot = JSON.parse(existing);
    expectedCandidateCheck(workspace, expectedCandidate, snapshot.candidate);
    verifyExperimentSnapshot({ workspace, snapshot });
    return snapshot;
  }
  const pending = readFileNoFollow(path.join(authority, `${id}.publication.json`), { root: authority, maxBytes: MAX_BYTES });
  if (pending !== null) {
    const journal = JSON.parse(pending);
    if (journal.snapshot?.id !== id || journal.next !== journal.snapshot?.oid || journal.ref !== journal.snapshot?.ref) throw fail('pending snapshot publication is corrupt');
    expectedCandidateCheck(workspace, expectedCandidate, journal.snapshot.candidate);
    verifyExperimentSnapshot({ workspace, snapshot: journal.snapshot, requireRef: false });
    beforePublish?.(journal.snapshot);
    return publishExperimentSnapshot({ workspace, root: authority, snapshot: journal.snapshot, expectedCandidate });
  }
  const head = git(workspace, ['rev-parse', 'HEAD']).toString().trim();
  if (!OID.test(head)) throw fail('snapshot base HEAD is invalid');
  const index = path.join(authority, `${id}.${randomUUID()}.index`);
  const ref = `refs/harness/experiments/${hash(authority).slice(0, 16)}/${id}`;
  let snapshot;
  try {
    git(workspace, ['read-tree', head], { index });
    const files = candidate.files.map(file => {
      const { bytes } = regularBytes(workspace, file.path);
      if (hash(bytes) !== file.sha256) throw fail('candidate changed while creating snapshot');
      const blob = git(workspace, ['hash-object', '-w', '--no-filters', '--stdin'], { input: bytes }).toString().trim();
      if (!OID.test(blob)) throw fail('snapshot blob identity is invalid');
      git(workspace, ['update-index', '-z', '--index-info'], { index, input: Buffer.from(`100644 ${blob}\t${file.path}\0`) });
      return { ...file, blob };
    });
    const tree = git(workspace, ['write-tree'], { index }).toString().trim();
    const timestamp = Math.floor(now / 1000);
    const env = { ...gitMetadataEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Harness Experiment', GIT_AUTHOR_EMAIL: 'experiment@harness.invalid', GIT_COMMITTER_NAME: 'Harness Experiment', GIT_COMMITTER_EMAIL: 'experiment@harness.invalid', GIT_AUTHOR_DATE: `${timestamp} +0000`, GIT_COMMITTER_DATE: `${timestamp} +0000` };
    const committed = spawnSync(gitExecutable(), ['-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit-tree', tree, '-p', head], { cwd: workspace, env, input: `Harness experiment ${id}\n`, encoding: 'utf8', timeout: 10000 });
    const oid = committed.stdout?.trim();
    if (committed.status !== 0 || !OID.test(oid || '')) throw fail('private snapshot commit failed');
    snapshot = { version: 1, id, head, tree, oid, ref, candidate, files };
    expectedCandidateCheck(workspace, expectedCandidate || candidate, snapshot.candidate);
    writeRecord(authority, `${id}.publication.json`, { version: 1, ref, old: '0'.repeat(oid.length), next: oid, snapshot });
    beforePublish?.(snapshot);
    publishExperimentSnapshot({ workspace, root: authority, snapshot, expectedCandidate });
  } finally {
    fs.rmSync(index, { force: true });
    fs.rmSync(`${index}.lock`, { force: true });
  }
  return snapshot;
}

export function publishExperimentSnapshot({ workspace, root, snapshot, expectedCandidate }) {
  const authority = safeRoot(root);
  expectedCandidateCheck(workspace, expectedCandidate, snapshot.candidate);
  const raw = readFileNoFollow(path.join(authority, `${snapshot.id}.publication.json`), { root: authority, maxBytes: MAX_BYTES });
  if (raw === null) throw fail('snapshot publication intent is missing');
  const intent = JSON.parse(raw);
  if (JSON.stringify(intent.snapshot) !== JSON.stringify(snapshot) || intent.next !== snapshot.oid || intent.ref !== snapshot.ref || intent.old !== '0'.repeat(snapshot.oid.length)) throw fail('snapshot publication intent changed');
  verifyExperimentSnapshot({ workspace, snapshot, requireRef: false });
  const old = spawnSync(gitExecutable(), ['rev-parse', '--verify', snapshot.ref], { cwd: workspace, env: gitMetadataEnvironment(), encoding: 'utf8', timeout: 4000 });
  if (old.status === 0 && old.stdout.trim() !== snapshot.oid) throw fail('private snapshot ref conflicts');
  if (old.status !== 0) git(workspace, ['update-ref', snapshot.ref, snapshot.oid, intent.old]);
  writeRecord(authority, `${snapshot.id}.json`, snapshot);
  return snapshot;
}

export function verifyExperimentSnapshot({ workspace, snapshot, requireRef = true }) {
  if (snapshot?.version !== 1 || !OID.test(snapshot.oid || '') || !Array.isArray(snapshot.files) || snapshot.files.length !== 1 || snapshot.candidate?.digest !== hash(JSON.stringify(snapshot.candidate.files))) throw fail('snapshot receipt is invalid');
  if (!/^refs\/harness\/experiments\/[a-f0-9]{16}\/[a-zA-Z0-9-]{1,100}$/.test(snapshot.ref || '')) throw fail('snapshot ref identity is invalid');
  if (requireRef && git(workspace, ['rev-parse', '--verify', snapshot.ref]).toString().trim() !== snapshot.oid) throw fail('snapshot ref changed');
  return snapshot.files.map(file => {
    exactPath(workspace, file.path);
    if (!OID.test(file.blob || '') || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777 || file.mode & 0o111) throw fail('snapshot file identity is invalid');
    const { blob, ...descriptor } = file;
    if (JSON.stringify(descriptor) !== JSON.stringify(snapshot.candidate.files[0])) throw fail('snapshot candidate descriptor changed');
    const treeEntry = git(workspace, ['ls-tree', '-z', snapshot.oid, '--', file.path]).toString();
    if (treeEntry !== `100644 blob ${file.blob}\t${file.path}\0`) throw fail('snapshot tree does not bind the candidate blob');
    const bytes = git(workspace, ['cat-file', 'blob', file.blob]);
    if (bytes.length > MAX_BYTES || hash(bytes) !== file.sha256 || bytes.length !== file.bytes) throw fail('snapshot blob bytes changed');
    return { ...file, data: bytes };
  });
}

export function restoreExperimentSnapshot({ workspace, root, id, snapshot, before, afterWrite }) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id || '')) throw fail('restore ID is invalid');
  const authority = safeRoot(root, true);
  const files = verifyExperimentSnapshot({ workspace, snapshot });
  if (before?.version !== 1 || before.files?.length !== files.length || before.digest !== hash(JSON.stringify(before.files))) throw fail('restore before identity is invalid');
  const journal = { version: 1, id, snapshot: snapshot.oid, before, after: snapshot.candidate };
  writeRecord(authority, `${id}.restore.json`, journal);
  for (const file of files) {
    const original = before.files.find(value => value.path === file.path);
    if (!original) throw fail('restore path is outside recognized candidate');
    const current = regularBytes(workspace, file.path);
    const currentHash = hash(current.bytes);
    const recognizedBefore = currentHash === original.sha256 && current.mode === original.mode;
    const recognizedAfter = currentHash === file.sha256 && (current.mode === file.mode || current.mode === original.mode || current.mode === 0o600);
    if (!recognizedBefore && !recognizedAfter) throw fail('restore refuses unknown owned bytes or modes');
    const full = exactPath(workspace, file.path);
    if (currentHash !== file.sha256) {
      const temporary = `${full}.harness-${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, file.data, { flag: 'wx', mode: 0o600 });
        const rechecked = regularBytes(workspace, file.path);
        if (hash(rechecked.bytes) !== original.sha256 || rechecked.mode !== original.mode || !assertNoSymlinkAncestors(workspace, file.path)) throw fail('candidate changed before restore publication');
        fs.renameSync(temporary, full);
      } finally { fs.rmSync(temporary, { force: true }); }
      afterWrite?.(file.path);
    }
    fs.chmodSync(exactPath(workspace, file.path), file.mode);
    const restored = regularBytes(workspace, file.path);
    if (hash(restored.bytes) !== file.sha256 || restored.mode !== file.mode) throw fail('restored candidate did not match snapshot');
  }
  writeRecord(authority, `${id}.restored.json`, journal);
  return { pass: true, candidate: snapshot.candidate, snapshot: snapshot.oid };
}
