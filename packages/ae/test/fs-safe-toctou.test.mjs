import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileNoFollow, readFileTailNoFollow, readPrefixNoFollow, writeFileContained, assertRealpathContained, realpathParentContained, copyFileContainedExclusive } from '../lib/fs-safe.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const SENTINEL = 'OUTSIDE_SECRET_SENTINEL must never be read through a swapped ancestor.\n';

test('read: a symlinked ANCESTOR redirecting outside the root refuses the read — and the no-root call is the fail-before that leaks', () => {
  const ws = tmp('toctou-read-ws-');
  const outside = tmp('toctou-read-outside-');
  fs.writeFileSync(path.join(outside, 'x.md'), SENTINEL, 'utf8');
    fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));
  const full = path.join(ws, 'docs', 'solutions', 'x.md');

    assert.equal(readFileNoFollow(full), SENTINEL, 'no-root read leaks outside content (documents the window)');

    const refused = readFileNoFollow(full, { root: ws });
  assert.equal(refused, null, 'canonicalize-after-acquire refuses the ancestor-swap read');
});

test('read: a symlinked LEAF pointing outside is refused with or without a root (O_NOFOLLOW leaf guard)', () => {
  const ws = tmp('toctou-leaf-ws-');
  const outside = tmp('toctou-leaf-outside-');
  fs.writeFileSync(path.join(outside, 'secret.md'), SENTINEL, 'utf8');
  fs.mkdirSync(path.join(ws, 'docs', 'solutions'), { recursive: true });
  const full = path.join(ws, 'docs', 'solutions', 'evil.md');
  fs.symlinkSync(path.join(outside, 'secret.md'), full);

  assert.equal(readFileNoFollow(full, { root: ws }), null, 'symlinked leaf refused (with root)');
  assert.equal(readFileNoFollow(full), null, 'symlinked leaf refused (without root — O_NOFOLLOW/lstat leaf guard)');
});

test('readPrefixNoFollow returns null for a fifo without waiting for a writer', { timeout: 2000 }, () => {
  if (process.platform === 'win32') return;
  const ws = tmp('toctou-fifo-');
  const full = path.join(ws, 'spec.md');
  assert.equal(spawnSync('mkfifo', [full]).status, 0);
  const started = Date.now();
  assert.equal(readPrefixNoFollow(full, { root: ws }), null);
  assert.equal(readPrefixNoFollow(full), null);
  assert.ok(Date.now() - started < 1000);
});

test('readPrefixNoFollow does not block when a regular file becomes a fifo before open', { timeout: 5000 }, () => {
  if (process.platform === 'win32') return;
  const ws = tmp('toctou-fifo-swap-');
  const lib = new URL('../lib/fs-safe.mjs', import.meta.url).href;
  const probe = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { spawnSync } from 'node:child_process';
    const dir = process.argv[1];
    const full = path.join(dir, 'spec.md');
    const fifo = path.join(dir, 'pipe');
    fs.writeFileSync(full, 'hello spec\\n');
    if (spawnSync('mkfifo', [fifo]).status !== 0) process.exit(2);
    const original = fs.lstatSync;
    let swapped = false;
    fs.lstatSync = function (file, ...args) {
      const stat = original.call(fs, file, ...args);
      if (!swapped && path.resolve(String(file)) === full && stat.isFile()) {
        swapped = true;
        fs.renameSync(full, full + '.real');
        fs.renameSync(fifo, full);
      }
      return stat;
    };
    const { readPrefixNoFollow } = await import(process.argv[2]);
    const started = Date.now();
    const got = readPrefixNoFollow(full);
    process.stdout.write(JSON.stringify({
      got: got == null ? null : got.toString('utf8'),
      elapsed: Date.now() - started,
      swapped,
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, ws, lib], {
    encoding: 'utf8',
    timeout: 2000,
  });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.swapped, true);
  assert.equal(body.got, null);
  assert.ok(body.elapsed < 1000, `elapsed=${body.elapsed}`);
});

test('readPrefixNoFollow reads a regular file prefix', () => {
  const ws = tmp('toctou-prefix-ok-');
  const full = path.join(ws, 'spec.md');
  fs.writeFileSync(full, 'hello spec\n');
  assert.equal(readPrefixNoFollow(full, { root: ws }).toString('utf8'), 'hello spec\n');
});

test('read: a legitimately deep all-real path (no symlinks) still reads — no false refusal', () => {
  const ws = tmp('toctou-ok-ws-');
  const rel = path.join('a', 'b', 'c', 'd', 'deep.md');
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'legit deep content\n', 'utf8');
  assert.equal(readFileNoFollow(full, { root: ws }), 'legit deep content\n');
});

test('read: a root reached through a symlink (e.g. symlinked temp dir) still reads its own files — canonical-vs-canonical, no false refusal', () => {
    const base = tmp('toctou-symroot-');
  const realWs = path.join(base, 'real-ws');
  fs.mkdirSync(realWs, { recursive: true });
  const linkedWs = path.join(base, 'linked-ws');
  fs.symlinkSync(realWs, linkedWs);
  const full = path.join(realWs, 'note.md');
  fs.writeFileSync(full, 'contained via symlinked root\n', 'utf8');
  assert.equal(readFileNoFollow(path.join(linkedWs, 'note.md'), { root: linkedWs }), 'contained via symlinked root\n');
});

test('write: writeFileContained refuses a symlinked ancestor redirecting outside and publishes nothing outside; writes a legit nested path normally', () => {
  const ws = tmp('toctou-write-ws-');
  const outside = tmp('toctou-write-outside-');
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));

  const refused = writeFileContained(ws, path.join('docs', 'solutions', 'new.md'), 'WRITE_CONTENT must never publish outside\n');
  assert.equal(refused, null, 'write refused through the symlinked ancestor');
  assert.ok(!fs.existsSync(path.join(outside, 'new.md')), 'no final file published outside');
  assert.equal(
    fs.readdirSync(outside).filter((f) => !f.startsWith('.tmp-')).length,
    0,
    'no published (non-temp) file landed outside'
  );

  // No false refusal on a genuinely contained nested path.
  const ok = writeFileContained(ws, path.join('docs', 'real', 'good.md'), 'good\n');
  assert.equal(ok, path.join(ws, 'docs', 'real', 'good.md'));
  assert.equal(fs.readFileSync(ok, 'utf8'), 'good\n');
});

test('write: the POST-CREATE verify branch refuses, cleans up, and NEVER lands content — proven by observing the temp is still empty at verify time (content-never-lands)', (t) => {
    const ws = tmp('toctou-postverify-ws-');
  const outside = tmp('toctou-postverify-outside-');
  const rel = path.join('docs', 'real', 'ep.md');
  const full = path.join(ws, rel);
  const parentDir = path.dirname(full);
  const CONTENT = 'CONTENT_BYTES_THAT_MUST_NEVER_LAND_BEFORE_VERIFY\n';

  const realRealpath = fs.realpathSync;
  const realRealpathNative = fs.realpathSync.native;
  let tmpSizeAtVerify = null; // temp file size observed at the instant of the verify
  let tmpsAtVerify = null;
    const interceptParent = (real) => (p, ...rest) => {
    if (path.resolve(p) === path.resolve(parentDir)) {
            tmpsAtVerify = fs.readdirSync(parentDir).filter((f) => f.startsWith('.tmp-'));
      if (tmpsAtVerify.length === 1) tmpSizeAtVerify = fs.statSync(path.join(parentDir, tmpsAtVerify[0])).size;
      return outside; // parent "resolves" outside the root → containment fails
    }
    return real(p, ...rest);
  };
    t.mock.method(fs, 'realpathSync', interceptParent(realRealpath));
  fs.realpathSync.native = interceptParent(realRealpathNative);
  t.after(() => {
    fs.realpathSync.native = realRealpathNative;
  });

  const result = writeFileContained(ws, rel, CONTENT);

  assert.equal(result, null, 'post-create verify failure refuses the write');
  assert.equal(tmpsAtVerify.length, 1, 'exactly one temp file existed before the verify ran');
  assert.equal(tmpSizeAtVerify, 0, 'the temp was still EMPTY at verify time — content never landed before containment passed');
    assert.equal(fs.readdirSync(parentDir).filter((f) => f.startsWith('.tmp-')).length, 0, 'the empty temp was cleaned up');
  assert.ok(!fs.existsSync(full), 'the final file was never published');
  for (const dir of [parentDir, outside]) {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).isFile()) {
        assert.ok(!fs.readFileSync(fp, 'utf8').includes('CONTENT_BYTES_THAT_MUST_NEVER_LAND'), `no content bytes written to ${fp}`);
      }
    }
  }
});

test('delete/rename guard: assertRealpathContained refuses a symlinked-ancestor target, accepts a real contained target, and refuses a missing one', () => {
  const ws = tmp('toctou-del-ws-');
  const outside = tmp('toctou-del-outside-');
  fs.writeFileSync(path.join(outside, 'x.md'), 'outside survivor\n', 'utf8');
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));

  // Ancestor docs/solutions → outside: the delete target resolves outside → refused.
  assert.equal(assertRealpathContained(ws, path.join('docs', 'solutions', 'x.md')), null);
  assert.ok(fs.existsSync(path.join(outside, 'x.md')), 'nothing was acted on outside');

  // A genuinely contained, existing target is accepted (returns its lexical path).
  const okRel = path.join('docs', 'real', 'y.md');
  const okFull = path.join(ws, okRel);
  fs.mkdirSync(path.dirname(okFull), { recursive: true });
  fs.writeFileSync(okFull, 'inside\n', 'utf8');
  assert.equal(assertRealpathContained(ws, okRel), okFull);

  // A non-existent target has nothing safe to act on → null (realpath refuses).
  assert.equal(assertRealpathContained(ws, path.join('docs', 'real', 'missing.md')), null);
});

test('symmetry: realpathParentContained refuses a file whose parent resolves OUTSIDE the root (the post-create verify reserveEpisodePath and writeFileContained now share), and passes a genuinely contained one', () => {
  const ws = tmp('rpc-ws-');
  const outside = tmp('rpc-outside-');
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
    fs.symlinkSync(outside, path.join(ws, 'docs', 'solutions'));
  const escaped = path.join(ws, 'docs', 'solutions', 'ep.md');
  fs.writeFileSync(escaped, 'landed outside via the symlinked ancestor\n');

    assert.equal(realpathParentContained(ws, escaped), false, 'a parent resolving outside the root is refused');
  assert.ok(fs.existsSync(path.join(outside, 'ep.md')), 'precondition: the file really did land outside via the symlink');

  const inside = path.join(ws, 'docs', 'real', 'ep.md');
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, 'contained\n');
  assert.equal(realpathParentContained(ws, inside), true, 'a genuinely contained parent passes — no false refusal');
});

test('Windows posture: O_NOFOLLOW is feature-detected — POSIX takes the atomic leaf-open branch, win32 falls back to lstat+realpath+inode (inspection-verified only)', () => {
    if (process.platform === 'win32') {
    assert.equal(fs.constants.O_NOFOLLOW, undefined, 'win32 exposes no O_NOFOLLOW → fallback branch is active');
  } else {
    assert.equal(typeof fs.constants.O_NOFOLLOW, 'number', 'POSIX exposes O_NOFOLLOW → atomic branch is active');
  }
});

test('copyFileContainedExclusive preserves bytes and refuses to replace an existing destination', () => {
  const srcRoot = tmp('copy-excl-src-');
  const destRoot = tmp('copy-excl-dest-');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
  fs.writeFileSync(path.join(srcRoot, 'chart.png'), bytes);
  const written = copyFileContainedExclusive(srcRoot, 'chart.png', destRoot, 'docs/chart.png');
  assert.equal(written, path.join(destRoot, 'docs/chart.png'));
  assert.deepEqual(fs.readFileSync(written), bytes);

  fs.writeFileSync(path.join(srcRoot, 'chart.png'), Buffer.from([0x01, 0x02]));
  assert.equal(copyFileContainedExclusive(srcRoot, 'chart.png', destRoot, 'docs/chart.png'), null);
  assert.deepEqual(fs.readFileSync(written), bytes, 'existing destination must be left intact');
});

test('copyFileContainedExclusive retries short writes until the full source is copied', () => {
  const srcRoot = tmp('copy-short-src-');
  const destRoot = tmp('copy-short-dest-');
  const bytes = Buffer.from('abcdefghij');
  fs.writeFileSync(path.join(srcRoot, 'a.bin'), bytes);
  const orig = fs.writeSync;
  fs.writeSync = (fd, buf, offset, length, position) => {
    const n = Math.min(1, length ?? buf.length);
    return orig.call(fs, fd, buf, offset, n, position);
  };
  try {
    const written = copyFileContainedExclusive(srcRoot, 'a.bin', destRoot, 'a.bin');
    assert.equal(written, path.join(destRoot, 'a.bin'));
    assert.deepEqual(fs.readFileSync(written), bytes);
  } finally {
    fs.writeSync = orig;
  }
});

test('copyFileContainedExclusive refuses a symlinked source and copies an empty file', () => {
  const srcRoot = tmp('copy-link-src-');
  const destRoot = tmp('copy-link-dest-');
  fs.writeFileSync(path.join(srcRoot, 'real.bin'), Buffer.from([1, 2, 3]));
  fs.symlinkSync(path.join(srcRoot, 'real.bin'), path.join(srcRoot, 'link.bin'));
  assert.equal(copyFileContainedExclusive(srcRoot, 'link.bin', destRoot, 'out.bin'), null);
  assert.equal(fs.existsSync(path.join(destRoot, 'out.bin')), false);

  fs.writeFileSync(path.join(srcRoot, 'empty.bin'), Buffer.alloc(0));
  const empty = copyFileContainedExclusive(srcRoot, 'empty.bin', destRoot, 'empty.bin');
  assert.equal(empty, path.join(destRoot, 'empty.bin'));
  assert.equal(fs.readFileSync(empty).length, 0);
});

test('readFileTailNoFollow: returns the last bytes with a truncated flag, and refuses symlinked leaves and ancestors', () => {
  const ws = tmp('tail-ws-');
  const outside = tmp('tail-outside-');
  fs.mkdirSync(path.join(ws, 'logs'));
  fs.writeFileSync(path.join(ws, 'logs', 'run.jsonl'), 'abcdefghij', 'utf8');
  const whole = readFileTailNoFollow(path.join(ws, 'logs', 'run.jsonl'), { root: ws, maxBytes: 64 });
  assert.equal(whole.buffer.toString('utf8'), 'abcdefghij');
  assert.equal(whole.truncated, false);
  const tail = readFileTailNoFollow(path.join(ws, 'logs', 'run.jsonl'), { root: ws, maxBytes: 4 });
  assert.equal(tail.buffer.toString('utf8'), 'ghij');
  assert.equal(tail.truncated, true);

  fs.writeFileSync(path.join(outside, 'secret.jsonl'), SENTINEL, 'utf8');
  fs.symlinkSync(path.join(outside, 'secret.jsonl'), path.join(ws, 'logs', 'leaf.jsonl'));
  assert.equal(readFileTailNoFollow(path.join(ws, 'logs', 'leaf.jsonl'), { root: ws }), null, 'a symlinked leaf is refused');
  assert.equal(readFileTailNoFollow(path.join(ws, 'logs', 'leaf.jsonl')), null, 'even without a root');
  fs.symlinkSync(outside, path.join(ws, 'away'));
  assert.equal(readFileTailNoFollow(path.join(ws, 'away', 'secret.jsonl'), { root: ws }), null, 'an ancestor escaping the root is refused');
  assert.equal(readFileTailNoFollow(path.join(ws, 'logs'), { root: ws }), null, 'a directory is not a regular file');
});
