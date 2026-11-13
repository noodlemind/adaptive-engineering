import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import YAML from 'yaml';
import { readDomain, inspectDomain, observeDomainRepositoryIdentity } from '../lib/domain-contract.mjs';
import { domainResultOf, cmdDomain, DOMAIN_VERBS } from '../lib/domain-cmd.mjs';
import { gitExecutable } from '../corpus/hooks/lib/git-executable.mjs';

function git(root, args) {
  const result = spawnSync(gitExecutable(), args, { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout.trim();
}

function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'domain-view-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
  const home = path.join(dir, 'harness');
  const root = path.join(dir, 'product');
  fs.mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Domain Test']);
  git(root, ['config', 'user.email', 'domain@example.invalid']);
  git(root, ['remote', 'add', 'origin', 'https://example.invalid/team/product.git']);
  fs.mkdirSync(path.join(root, '.github/harness'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/harness/checks.yaml'), 'checks: []\n');
  fs.writeFileSync(path.join(root, 'spec.md'), '# Shared intent\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Initial product']);
  const config = { domain_version: 1, name: 'catalog', repos: [{ id: 'product', origin: 'https://example.invalid/team/product.git', root }], shared_specs: [{ repo: 'product', path: 'spec.md' }], shared_conventions: [] };
  const file = path.join(home, 'domains/catalog.yaml');
  const write = (value = config) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : YAML.stringify(value));
  };
  const show = () => inspectDomain(readDomain('catalog', { home }));
  return { dir, home, root, config, file, write, show };
}

const IDENTITY_ARGS = ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'];
const BATCH_ARGS = [...IDENTITY_ARGS, '--verify', 'HEAD'];

function observeGitCalls(t, override = () => undefined) {
  const native = childProcess.spawnSync;
  const executable = gitExecutable();
  const calls = [];
  t.mock.method(childProcess, 'spawnSync', function(command, args, options) {
    if (command !== executable) return native.apply(this, arguments);
    calls.push({ args, options });
    const replaced = override(args, options);
    return replaced === undefined ? native.apply(this, arguments) : replaced;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

function gitCommand(args) {
  return args.slice(args.findIndex(value => ['rev-parse', 'symbolic-ref', 'config', 'status'].includes(value)));
}

function identityOutput(f) {
  return `${f.root}\n${path.join(f.root, '.git')}\n.git\n`;
}

function identityObservation(f, root = f.root) {
  return observeDomainRepositoryIdentity(root, { id: 'product', origin: 'https://example.invalid/team/product' });
}

test('identity-only observation freshly reads bounded Git identity, HEAD and origin without branch or status', t => {
  const f = fixture(t);
  const head = git(f.root, ['rev-parse', 'HEAD']);
  const calls = observeGitCalls(t);
  const repo = identityObservation(f);
  assert.equal(repo.status, 'available');
  assert.equal(repo.observed.head, head);
  assert.equal(repo.observed.root, f.root);
  assert.equal(repo.observed.gitDir, path.join(f.root, '.git'));
  assert.equal(repo.observed.commonDir, path.join(f.root, '.git'));
  assert.equal(repo.observed.origin, f.config.repos[0].origin);
  assert.equal(repo.observed.branch, null);
  assert.equal(repo.observed.dirty, null);
  assert.equal(repo.observed.statusEntries, null);
  assert.doesNotMatch(repo.warnings.join(' '), /origin.*differs|Branch|Working tree/);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.slice(1).map(call => gitCommand(call.args)), [BATCH_ARGS, ['config', '--null', '--get-all', 'remote.origin.url']]);
  for (const { args, options } of calls) {
    assert.equal(args[0], '--no-pager');
    assert.ok(args.includes('core.fsmonitor=false'));
    assert.equal(options.timeout, 4000);
    assert.equal(options.maxBuffer, 64 * 1024);
    assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
  }
});

test('identity-only calls observe current HEAD and origin after changes and detached checkout', t => {
  const f = fixture(t);
  const first = identityObservation(f).observed.head;
  git(f.root, ['commit', '--allow-empty', '-m', 'Changed HEAD']);
  const next = git(f.root, ['rev-parse', 'HEAD']);
  assert.notEqual(next, first);
  git(f.root, ['checkout', '--detach', next]);
  git(f.root, ['remote', 'set-url', 'origin', 'https://example.invalid/team/changed.git']);
  fs.writeFileSync(path.join(f.root, 'spec.md'), 'Changed intent\n');
  const calls = observeGitCalls(t);
  for (let index = 0; index < 2; index++) {
    const repo = identityObservation(f);
    assert.equal(repo.status, 'available');
    assert.equal(repo.observed.head, next);
    assert.equal(repo.observed.origin, 'https://example.invalid/team/changed.git');
    assert.equal(repo.observed.branch, null);
    assert.equal(repo.observed.dirty, null);
    assert.match(repo.warnings.join(' '), /origin.*differs/i);
  }
  assert.equal(calls.length, 6, 'each call obtains new identity and origin reads');
});

test('identity-only observations preserve linked worktree and missing HEAD semantics', t => {
  const f = fixture(t);
  const linked = path.join(f.dir, 'identity-linked');
  git(f.root, ['worktree', 'add', '--detach', linked]);
  let repo = identityObservation(f, linked);
  assert.equal(repo.status, 'available');
  assert.equal(repo.observed.root, linked);
  assert.equal(repo.observed.commonDir, path.join(f.root, '.git'));
  assert.equal(repo.observed.isLinkedWorktree, true);
  const unborn = path.join(f.dir, 'identity-unborn');
  fs.mkdirSync(unborn);
  git(unborn, ['init', '-b', 'main']);
  const calls = observeGitCalls(t);
  repo = identityObservation(f, unborn);
  assert.equal(repo.status, 'available');
  assert.equal(repo.observed.root, unborn);
  assert.equal(repo.observed.head, null);
  assert.equal(repo.observed.origin, null);
  assert.match(repo.warnings.join(' '), /HEAD is unavailable/);
  assert.match(repo.warnings.join(' '), /origin is unavailable/);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.filter(call => call.args.includes('rev-parse')).map(call => gitCommand(call.args)), [BATCH_ARGS, IDENTITY_ARGS, ['rev-parse', '--verify', 'HEAD']]);
});

test('identity-only observations reject uncertain and malformed batch responses before origin', async t => {
  const variants = [
    ['null result', () => null],
    ['timeout', () => ({ status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) })],
    ['signal', f => ({ status: 0, signal: 'SIGTERM', stdout: `${identityOutput(f)}${'a'.repeat(40)}\n` })],
    ['output overflow', () => ({ status: 0, stdout: 'x'.repeat(64 * 1024 + 1) })],
    ['buffer error', f => ({ status: 0, error: Object.assign(new Error('bounded'), { code: 'ENOBUFS' }), stdout: `${identityOutput(f)}${'a'.repeat(40)}\n` })],
    ['partial HEAD', f => ({ status: 0, stdout: `${identityOutput(f)}${'a'.repeat(39)}\n` })],
    ['mixed framing', f => ({ status: 0, stdout: `${f.root}\r\n${path.join(f.root, '.git')}\n.git\n${'a'.repeat(40)}\n` })],
    ['unexpected status', f => ({ status: 1, stdout: identityOutput(f) })],
  ];
  for (const [name, response] of variants) await t.test(name, child => {
    const f = fixture(child);
    const calls = observeGitCalls(child, args => gitCommand(args).join(' ') === BATCH_ARGS.join(' ') ? response(f) : undefined);
    const repo = identityObservation(f);
    assert.equal(repo.status, 'unavailable');
    assert.equal(repo.observed.root, null);
    assert.equal(repo.observed.head, null);
    assert.equal(repo.observed.origin, null);
    assert.equal(calls.length, 2);
  });
});

test('identity-only fallback discards partial identity and observes current separate identity and HEAD', t => {
  const f = fixture(t);
  const foreign = path.join(f.dir, 'identity-foreign');
  fs.mkdirSync(foreign);
  fs.mkdirSync(path.join(foreign, '.git'));
  const head = git(f.root, ['rev-parse', 'HEAD']);
  const calls = observeGitCalls(t, args => gitCommand(args).join(' ') === BATCH_ARGS.join(' ')
    ? { status: 128, stdout: `${foreign}\n${path.join(foreign, '.git')}\n.git\n` }
    : undefined);
  const repo = identityObservation(f);
  assert.equal(repo.status, 'available');
  assert.equal(repo.observed.root, f.root);
  assert.equal(repo.observed.gitDir, path.join(f.root, '.git'));
  assert.equal(repo.observed.head, head);
  assert.equal(calls.length, 5);
});

test('identity-only fallback uncertainty stops before origin and other advisory metadata', async t => {
  for (const stage of ['identity', 'HEAD']) await t.test(stage, child => {
    const f = fixture(child);
    const calls = observeGitCalls(child, args => {
      const command = gitCommand(args).join(' ');
      if (command === BATCH_ARGS.join(' ')) return { status: 128, stdout: identityOutput(f) };
      if (command === (stage === 'identity' ? IDENTITY_ARGS.join(' ') : 'rev-parse --verify HEAD')) return { status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
    });
    const repo = identityObservation(f);
    assert.equal(repo.status, 'unavailable');
    assert.equal(repo.observed.head, null);
    assert.equal(repo.observed.origin, null);
    assert.equal(calls.length, stage === 'identity' ? 3 : 4);
  });
});

test('identity-only fallback rechecks the raw Git path before fresh reads', t => {
  const f = fixture(t);
  const calls = observeGitCalls(t, args => {
    if (gitCommand(args).join(' ') !== BATCH_ARGS.join(' ')) return;
    fs.renameSync(path.join(f.root, '.git'), path.join(f.dir, 'identity-moved-git'));
    fs.symlinkSync(path.join(f.dir, 'identity-moved-git'), path.join(f.root, '.git'), 'dir');
    return { status: 128, stdout: identityOutput(f) };
  });
  assert.throws(() => identityObservation(f), /Git identity path is unsafe or symlinked/);
  assert.equal(calls.length, 2);
});

test('identity-only observation refuses a raw symlink checkout before Git reads', t => {
  const f = fixture(t);
  const link = path.join(f.dir, 'identity-root-link');
  fs.symlinkSync(f.root, link, 'dir');
  const calls = observeGitCalls(t);
  assert.throws(() => identityObservation(f, link), /unsafe or symlinked/);
  assert.equal(calls.length, 0);
});

test('identity-only missing and ambiguous origin observations remain explicitly unknown', async t => {
  for (const output of ['', 'https://example.invalid/team/product.git\0https://example.invalid/team/other.git\0']) await t.test(output ? 'multiple URLs' : 'missing URL', child => {
    const f = fixture(child);
    const calls = observeGitCalls(child, args => gitCommand(args).join(' ') === 'config --null --get-all remote.origin.url'
      ? { status: output ? 0 : 1, stdout: output }
      : undefined);
    const repo = identityObservation(f);
    assert.equal(repo.status, 'available');
    assert.equal(repo.observed.origin, null);
    assert.match(repo.warnings.join(' '), /origin is unavailable/);
    assert.equal(calls.length, 3);
  });
});

test('one fresh bounded Git request observes checkout identity and HEAD', t => {
  const f = fixture(t);
  f.write();
  const expectedHead = git(f.root, ['rev-parse', 'HEAD']);
  const calls = observeGitCalls(t);
  const repo = f.show().repos[0];
  assert.equal(repo.status, 'available');
  assert.equal(repo.observed.head, expectedHead);
  assert.equal(calls.length, 5, 'normal observation removes one Git process');
  assert.deepEqual(calls.filter(call => call.args.includes('rev-parse')).map(call => gitCommand(call.args)), [BATCH_ARGS]);
  for (const { args, options } of calls) {
    assert.equal(args[0], '--no-pager');
    assert.ok(args.includes('core.fsmonitor=false'));
    assert.equal(options.timeout, 4000);
    assert.equal(options.maxBuffer, 64 * 1024);
    assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
  }
  assert.deepEqual(calls.slice(2).map(call => gitCommand(call.args)), [
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    ['config', '--null', '--get-all', 'remote.origin.url'],
    ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
  ]);
});

test('batch records handle CRLF without trimming path or hash bytes', t => {
  const f = fixture(t);
  f.write();
  const head = git(f.root, ['rev-parse', 'HEAD']);
  const commonDir = path.join(f.dir, 'common directory ');
  fs.mkdirSync(commonDir);
  const calls = observeGitCalls(t, args => args.includes('--verify') && args.includes('--show-toplevel')
    ? { status: 0, stdout: `${f.root}\r\n${path.join(f.root, '.git')}\r\n${commonDir}\r\n${head}\r\n` }
    : undefined);
  const repo = f.show().repos[0];
  assert.equal(repo.status, 'available');
  assert.equal(repo.observed.head, head);
  assert.equal(repo.observed.commonDir, commonDir, 'a path-ending space remains part of the identity');
  assert.equal(calls.length, 5);
});

test('mixed LF and CRLF identity framing is unavailable without later reads', async t => {
  for (const stage of ['initial success', 'initial missing HEAD', 'fresh fallback identity']) {
    for (const ending of ['\n', '\r\n']) await t.test(`${stage}, ${ending === '\n' ? 'LF' : 'CRLF'} final record`, child => {
      const f = fixture(child);
      f.write();
      const head = git(f.root, ['rev-parse', 'HEAD']);
      const records = [f.root, path.join(f.root, '.git'), '.git', ...(stage === 'initial success' ? [head] : [])];
      const mixed = records.map((value, index) => value + (index === 0 ? (ending === '\n' ? '\r\n' : '\n') : ending)).join('');
      const calls = observeGitCalls(child, args => {
        const command = gitCommand(args).join(' ');
        if (command === BATCH_ARGS.join(' ')) return stage === 'fresh fallback identity'
          ? { status: 128, stdout: identityOutput(f) }
          : { status: stage === 'initial success' ? 0 : 128, stdout: mixed };
        if (stage === 'fresh fallback identity' && command === IDENTITY_ARGS.join(' ')) return { status: 0, stdout: mixed };
      });
      const repo = f.show().repos[0];
      assert.equal(repo.status, 'unavailable');
      assert.equal(repo.observed.root, null);
      assert.equal(repo.observed.gitDir, null);
      assert.equal(repo.observed.commonDir, null);
      assert.equal(repo.observed.head, null);
      assert.equal(calls.length, stage === 'fresh fallback identity' ? 3 : 2, 'mixed identity framing stops before fallback or later HEAD reads');
    });
  }
});

test('a real Git directory ending in a carriage return cannot become its clean sibling', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  f.write();
  const actualGit = path.join(f.dir, 'actual-git\r');
  const cleanSibling = path.join(f.dir, 'actual-git');
  fs.renameSync(path.join(f.root, '.git'), actualGit);
  fs.mkdirSync(cleanSibling);
  fs.writeFileSync(path.join(f.root, '.git'), `gitdir: ${actualGit}/\n`);
  const response = spawnSync(gitExecutable(), BATCH_ARGS, { cwd: f.root, encoding: 'utf8', timeout: 4000 });
  assert.equal(response.status, 0, response.stderr);
  assert.equal(response.stdout, `${f.root}\n${actualGit}\n${actualGit}\n${git(f.root, ['rev-parse', 'HEAD'])}\n`);
  const calls = observeGitCalls(t);
  const repo = f.show().repos[0];
  assert.equal(repo.status, 'unavailable');
  assert.equal(repo.observed.gitDir, null, 'the literal CR path is rejected before clean-sibling canonicalization');
  assert.equal(repo.observed.commonDir, null);
  assert.equal(calls.length, 2);
});

test('completed malformed and uncertain batch responses grant no observation or fallback', async t => {
  const variants = [
    ['null result', () => null],
    ['timeout', f => ({ status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), stdout: identityOutput(f) })],
    ['signal', f => ({ status: 128, signal: 'SIGTERM', stdout: identityOutput(f) })],
    ['output bound', f => ({ status: 0, error: Object.assign(new Error('bounded'), { code: 'ENOBUFS' }), stdout: `${identityOutput(f)}${'a'.repeat(40)}\n` })],
    ['missing status', f => ({ stdout: identityOutput(f) })],
    ['other status', f => ({ status: 1, stdout: identityOutput(f) })],
    ['noninteger status', f => ({ status: 0.5, stdout: identityOutput(f) })],
    ['truncated hash', f => ({ status: 0, stdout: `${identityOutput(f)}${'a'.repeat(39)}\n` })],
    ['unterminated hash', f => ({ status: 0, stdout: `${identityOutput(f)}${'a'.repeat(40)}` })],
    ['hash trailing space', f => ({ status: 0, stdout: `${identityOutput(f)}${'a'.repeat(40)} \n` })],
    ['hash leading space', f => ({ status: 0, stdout: `${identityOutput(f)} ${'a'.repeat(40)}\n` })],
    ['extra record', f => ({ status: 0, stdout: `${identityOutput(f)}${'a'.repeat(40)}\nextra\n` })],
    ['extra blank record', f => ({ status: 0, stdout: `${identityOutput(f)}${'a'.repeat(40)}\n\n` })],
    ['empty identity record', f => ({ status: 0, stdout: `${f.root}\n\n.git\n${'a'.repeat(40)}\n` })],
    ['control in identity', f => ({ status: 0, stdout: `${f.root}\n${path.join(f.root, '.git')}\n.git\t\n${'a'.repeat(40)}\n` })],
    ['oversized identity', f => ({ status: 0, stdout: `${f.root}\n${'x'.repeat(4097)}\n.git\n${'a'.repeat(40)}\n` })],
    ['oversized response', () => ({ status: 0, stdout: 'x'.repeat(64 * 1024 + 1) })],
    ['128 partial record', f => ({ status: 128, stdout: identityOutput(f).trimEnd() })],
    ['128 extra record', f => ({ status: 128, stdout: `${identityOutput(f)}HEAD\n` })],
    ['128 empty record', f => ({ status: 128, stdout: `${f.root}\n\n.git\n` })],
    ['128 control in record', f => ({ status: 128, stdout: `${f.root}\n${path.join(f.root, '.git')}\n.git\r\r\n` })],
    ['128 nonabsolute root', f => ({ status: 128, stdout: `relative\n${path.join(f.root, '.git')}\n.git\n` })],
    ['128 nonabsolute Git directory', f => ({ status: 128, stdout: `${f.root}\n.git\n.git\n` })],
  ];
  for (const [name, response] of variants) await t.test(name, child => {
    const f = fixture(child);
    f.write();
    const calls = observeGitCalls(child, args => args.includes('--verify') && args.includes('--show-toplevel') ? response(f) : undefined);
    const repo = f.show().repos[0];
    assert.equal(repo.status, 'unavailable');
    assert.deepEqual(repo.observed, { root: null, gitDir: null, commonDir: null, head: null, origin: null, branch: null, isLinkedWorktree: null, dirty: null, statusEntries: null });
    assert.equal(calls.length, 2, 'uncertainty stops after config and the batch');
  });
});

for (const corrupt of [false, true]) test(`${corrupt ? 'corrupt ref' : 'unborn checkout'} retains advisory missing HEAD through fresh separate reads`, t => {
  const f = fixture(t);
  const root = path.join(f.dir, 'no-head');
  fs.mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  if (corrupt) fs.writeFileSync(path.join(root, '.git/refs/heads/main'), 'broken ref\n');
  f.config.repos[0].root = root;
  f.write();
  const calls = observeGitCalls(t);
  const repo = f.show().repos[0];
  assert.equal(repo.status, 'available');
  assert.equal(repo.observed.root, root);
  assert.equal(repo.observed.head, null);
  assert.match(repo.warnings.join(' '), /HEAD is unavailable/);
  assert.equal(calls.length, 7, 'recognized missing HEAD adds only one process over the prior separate reads');
  assert.deepEqual(calls.filter(call => call.args.includes('rev-parse')).map(call => gitCommand(call.args)), [BATCH_ARGS, IDENTITY_ARGS, ['rev-parse', '--verify', 'HEAD']]);
});

test('fallback discards partial identities and observes current separate identity and HEAD', t => {
  const f = fixture(t);
  f.write();
  const foreign = path.join(f.dir, 'foreign');
  fs.mkdirSync(foreign);
  fs.mkdirSync(path.join(foreign, '.git'));
  const head = git(f.root, ['rev-parse', 'HEAD']);
  const calls = observeGitCalls(t, args => args.includes('--verify') && args.includes('--show-toplevel')
    ? { status: 128, stdout: `${foreign}\n${path.join(foreign, '.git')}\n.git\n` }
    : undefined);
  const repo = f.show().repos[0];
  assert.equal(repo.status, 'available');
  assert.equal(repo.observed.root, f.root);
  assert.equal(repo.observed.gitDir, path.join(f.root, '.git'));
  assert.equal(repo.observed.head, head);
  assert.equal(calls.length, 7);
});

test('uncertain or malformed fresh fallback HEAD stops without later metadata reads', async t => {
  const variants = [
    ['null result', () => null],
    ['process error', () => ({ status: null, error: Object.assign(new Error('unavailable'), { code: 'ENOENT' }) })],
    ['timeout', () => ({ status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) })],
    ['signal', () => ({ status: 128, signal: 'SIGTERM', stdout: '' })],
    ['output bound', () => ({ status: 0, error: Object.assign(new Error('bounded'), { code: 'ENOBUFS' }), stdout: `${'a'.repeat(40)}\n` })],
    ['missing status', () => ({ stdout: `${'a'.repeat(40)}\n` })],
    ['other completed status', () => ({ status: 1, stdout: '' })],
    ['unterminated hash', () => ({ status: 0, stdout: 'a'.repeat(40) })],
    ['hash whitespace', () => ({ status: 0, stdout: `${'a'.repeat(40)} \n` })],
    ['extra hash record', () => ({ status: 0, stdout: `${'a'.repeat(40)}\n${'a'.repeat(40)}\n` })],
    ['partial hash', () => ({ status: 0, stdout: `${'a'.repeat(39)}\n` })],
    ['unexpected missing HEAD output', () => ({ status: 128, stdout: 'HEAD\n' })],
    ['oversized response', () => ({ status: 0, stdout: 'a'.repeat(64 * 1024 + 1) })],
  ];
  for (const [name, response] of variants) await t.test(name, child => {
    const f = fixture(child);
    f.write();
    const calls = observeGitCalls(child, args => {
      const command = gitCommand(args).join(' ');
      if (command === BATCH_ARGS.join(' ')) return { status: 128, stdout: identityOutput(f) };
      if (command === 'rev-parse --verify HEAD') return response();
    });
    const repo = f.show().repos[0];
    assert.equal(repo.status, 'unavailable');
    assert.equal(repo.observed.head, null);
    assert.equal(repo.observed.origin, null);
    assert.equal(repo.observed.branch, null);
    assert.equal(repo.observed.dirty, null);
    assert.equal(calls.length, 4, 'fresh HEAD uncertainty stops before branch, origin and status');
  });
});

test('uncertain or malformed fresh fallback identity stops without reading HEAD', async t => {
  const variants = [
    ['timeout', () => ({ status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) })],
    ['signal', f => ({ status: 0, signal: 'SIGTERM', stdout: identityOutput(f) })],
    ['truncated identity', f => ({ status: 0, stdout: identityOutput(f).trimEnd() })],
    ['nonzero identity', f => ({ status: 128, stdout: identityOutput(f) })],
  ];
  for (const [name, response] of variants) await t.test(name, child => {
    const f = fixture(child);
    f.write();
    const calls = observeGitCalls(child, args => {
      const command = gitCommand(args).join(' ');
      if (command === BATCH_ARGS.join(' ')) return { status: 128, stdout: identityOutput(f) };
      if (command === IDENTITY_ARGS.join(' ')) return response(f);
    });
    const repo = f.show().repos[0];
    assert.equal(repo.status, 'unavailable');
    assert.equal(repo.observed.root, null);
    assert.equal(repo.observed.head, null);
    assert.equal(calls.length, 3, 'fresh identity uncertainty stops before HEAD');
  });
});

test('fallback rejects a changed checkout identity before reading HEAD', t => {
  const f = fixture(t);
  f.write();
  const foreign = path.join(f.dir, 'foreign');
  fs.mkdirSync(foreign);
  fs.mkdirSync(path.join(foreign, '.git'));
  const calls = observeGitCalls(t, args => {
    const command = gitCommand(args);
    if (command.join(' ') === BATCH_ARGS.join(' ')) return { status: 128, stdout: identityOutput(f) };
    if (command.join(' ') === IDENTITY_ARGS.join(' ')) return { status: 0, stdout: `${foreign}\n${path.join(foreign, '.git')}\n.git\n` };
  });
  const repo = f.show().repos[0];
  assert.equal(repo.status, 'unavailable');
  assert.equal(repo.observed.root, foreign, 'only the fresh fallback identity reaches the existing root comparison');
  assert.equal(repo.observed.head, null);
  assert.equal(calls.length, 3);
});

test('fallback rechecks the raw Git path after the completed batch', t => {
  const f = fixture(t);
  f.write();
  let changed = false;
  const calls = observeGitCalls(t, args => {
    if (!args.includes('--verify') || !args.includes('--show-toplevel')) return;
    fs.renameSync(path.join(f.root, '.git'), path.join(f.dir, 'moved-git'));
    fs.symlinkSync(path.join(f.dir, 'moved-git'), path.join(f.root, '.git'), 'dir');
    changed = true;
    return { status: 128, stdout: identityOutput(f) };
  });
  assert.throws(() => f.show(), /Git identity path is unsafe or symlinked/);
  assert.equal(changed, true);
  assert.equal(calls.length, 2, 'unsafe raw identity never reaches separate fallback reads');
});

test('later observations see changed and detached HEAD without reusing a batch', t => {
  const f = fixture(t);
  f.write();
  const first = f.show().repos[0].observed.head;
  git(f.root, ['commit', '--allow-empty', '-m', 'New HEAD']);
  const next = git(f.root, ['rev-parse', 'HEAD']);
  assert.notEqual(next, first);
  git(f.root, ['checkout', '--detach', next]);
  const calls = observeGitCalls(t);
  for (let index = 0; index < 2; index++) {
    const repo = f.show().repos[0];
    assert.equal(repo.observed.head, next);
    assert.equal(repo.observed.branch, null);
    assert.equal(repo.observed.dirty, false);
  }
  assert.equal(calls.length, 10, 'each public observation obtains its own full batch');
});

test('SHA-256 HEAD remains exact on Git versions that support it', t => {
  const f = fixture(t);
  const root = path.join(f.dir, 'sha256');
  fs.mkdirSync(root);
  const initialized = spawnSync(gitExecutable(), ['init', '-b', 'main', '--object-format=sha256'], { cwd: root, encoding: 'utf8', timeout: 4000 });
  if (initialized.status !== 0) { t.skip('Installed Git has no SHA-256 repository support'); return; }
  git(root, ['-c', 'user.name=Domain Test', '-c', 'user.email=domain@example.invalid', 'commit', '--allow-empty', '-m', 'SHA-256 seed']);
  f.config.repos[0].root = root;
  f.write();
  const head = git(root, ['rev-parse', 'HEAD']);
  assert.equal(head.length, 64);
  const calls = observeGitCalls(t);
  assert.equal(f.show().repos[0].observed.head, head);
  assert.equal(calls.length, 5);
});

test('domain show observes membership, advisory references and Git identity without writes', t => {
  const f = fixture(t);
  f.write();
  const configBytes = fs.readFileSync(f.file);
  const index = fs.readFileSync(path.join(f.root, '.git/index'));
  const before = git(f.root, ['status', '--porcelain=v1']);
  const result = f.show();
  assert.equal(result.status, 'ok');
  assert.equal(result.executionSupported, false);
  assert.equal(result.domainVersion, 1);
  assert.equal(result.configPath, f.file);
  assert.deepEqual(result.sharedSpecs, [{ repo: 'product', path: 'spec.md', authority: 'advisory' }]);
  const repo = result.repos[0];
  assert.equal(repo.id, 'product');
  assert.equal(repo.status, 'available');
  assert.equal(repo.expected.origin, f.config.repos[0].origin);
  assert.equal(repo.observed.origin, repo.expected.origin);
  assert.equal(repo.observed.root, f.root);
  assert.equal(repo.observed.head, git(f.root, ['rev-parse', 'HEAD']));
  assert.equal(repo.observed.commonDir, path.join(f.root, '.git'));
  assert.equal(repo.observed.isLinkedWorktree, false);
  assert.equal(repo.observed.dirty, false);
  assert.equal(repo.checks.present, true);
  assert.equal(fs.existsSync(path.join(f.root, '.harness')), false);
  assert.deepEqual(fs.readFileSync(f.file), configBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.git/index')), index);
  assert.equal(git(f.root, ['status', '--porcelain=v1']), before);
  assert.deepEqual(fs.readdirSync(f.home), ['domains']);
});

test('show flags and explicit Harness home work outside any product workspace', t => {
  const f = fixture(t);
  f.write();
  const result = domainResultOf(['show', '--name', 'catalog', '--harness-home', f.home, '--workspace', path.join(f.dir, 'does-not-exist'), '--json'], { harnessHome: path.join(f.dir, 'wrong-home') });
  assert.equal(result.name, 'catalog');
  assert.equal(result.configPath, f.file);
  assert.deepEqual(DOMAIN_VERBS, ['init', 'bind', 'show', 'status', 'get', 'plan-new', 'plan-update', 'gate', 'review', 'verify', 'compound']);
  assert.equal(domainResultOf(['show', '--name=catalog'], { harnessHome: f.home }).configPath, f.file);
});

test('a missing home/config is an error and creates no directories', t => {
  const f = fixture(t);
  assert.throws(() => readDomain('catalog', { home: f.home }), /missing|unreadable/i);
  assert.equal(fs.existsSync(f.home), false);
});

test('missing local repositories remain explicit unavailable observations', t => {
  const f = fixture(t);
  f.config.repos.push({ id: 'consumer', origin: 'https://example.invalid/consumer.git', root: path.join(f.dir, 'missing') });
  f.write();
  const result = f.show();
  assert.equal(result.repos[1].status, 'unavailable');
  assert.equal(result.repos[1].observed.root, null);
  assert.match(result.repos[1].warnings.join(' '), /missing|unavailable/i);
  assert.equal(fs.existsSync(f.config.repos[1].root), false);
});

test('origin drift, dirty state and missing checks are reported separately', t => {
  const f = fixture(t);
  f.write();
  git(f.root, ['remote', 'set-url', 'origin', 'https://example.invalid/new-product.git']);
  fs.unlinkSync(path.join(f.root, '.github/harness/checks.yaml'));
  const result = f.show();
  assert.equal(result.repos[0].status, 'available');
  assert.equal(result.repos[0].expected.origin, f.config.repos[0].origin);
  assert.equal(result.repos[0].observed.origin, 'https://example.invalid/new-product.git');
  assert.equal(result.repos[0].observed.dirty, true);
  assert.equal(result.repos[0].checks.present, false);
  assert.match(result.repos[0].warnings.join(' '), /origin.*differs/i);
  assert.match(result.repos[0].warnings.join(' '), /checks/i);
});

test('linked worktrees report canonical checkout and common repository identity', t => {
  const f = fixture(t);
  const linked = path.join(f.dir, 'linked');
  git(f.root, ['worktree', 'add', '-b', 'feature/domain', linked]);
  f.config.repos[0].root = linked;
  f.write();
  const repo = f.show().repos[0];
  assert.equal(repo.observed.root, linked);
  assert.equal(repo.observed.commonDir, path.join(f.root, '.git'));
  assert.equal(repo.observed.isLinkedWorktree, true);
  assert.equal(repo.observed.branch, 'feature/domain');
  assert.equal(repo.observed.dirty, false);
});

test('a nested directory and a non-Git directory cannot masquerade as the expected checkout', t => {
  const f = fixture(t);
  const nested = path.join(f.root, 'nested');
  fs.mkdirSync(nested);
  f.config.repos[0].root = nested;
  f.write();
  let repo = f.show().repos[0];
  assert.equal(repo.status, 'unavailable');
  assert.match(repo.warnings.join(' '), /checkout root/i);
  const plain = path.join(f.dir, 'plain');
  fs.mkdirSync(plain);
  fs.mkdirSync(path.join(plain, '.github/harness'), { recursive: true });
  fs.writeFileSync(path.join(plain, '.github/harness/checks.yaml'), 'checks: []\n');
  f.config.repos[0].root = plain;
  f.write();
  repo = f.show().repos[0];
  assert.equal(repo.status, 'unavailable');
  assert.match(repo.warnings.join(' '), /Git|metadata/i);
  assert.equal(repo.checks.present, true);
});

test('Git helpers are disabled and filesystem metadata calls do not refresh the index', t => {
  const f = fixture(t);
  const marker = path.join(f.dir, 'helper-ran');
  const helper = path.join(f.dir, 'helper.sh');
  fs.writeFileSync(helper, `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o755 });
  git(f.root, ['config', 'core.fsmonitor', helper]);
  git(f.root, ['config', 'filter.fixture.clean', helper]);
  git(f.root, ['config', 'filter.fixture.smudge', helper]);
  git(f.root, ['config', 'filter.fixture.process', helper]);
  git(f.root, ['config', 'filter.fixture.required', 'true']);
  fs.writeFileSync(path.join(f.root, '.gitattributes'), '* filter=fixture\n');
  f.write();
  const index = fs.readFileSync(path.join(f.root, '.git/index'));
  assert.equal(f.show().repos[0].status, 'available');
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.git/index')), index);
});

test('ambient Git tracing and repository overrides cannot write into or redirect domain observations', t => {
  const f = fixture(t);
  f.write();
  const marker = path.join(f.root, 'git-trace.log');
  const saved = { GIT_TRACE: process.env.GIT_TRACE, GIT_DIR: process.env.GIT_DIR };
  try {
    process.env.GIT_TRACE = marker;
    process.env.GIT_DIR = path.join(f.dir, 'not-a-repo');
    assert.equal(f.show().repos[0].status, 'available');
    assert.equal(fs.existsSync(marker), false);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('malformed Git identity and bounded working-tree status stay explicit', t => {
  const f = fixture(t);
  f.write();
  fs.writeFileSync(path.join(f.root, '.git/HEAD'), 'malformed Git HEAD\n');
  const before = fs.readFileSync(path.join(f.root, '.git/HEAD'));
  const repo = f.show().repos[0];
  assert.equal(repo.status, 'unavailable');
  assert.match(repo.warnings.join(' '), /Git|metadata/i);
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.git/HEAD')), before);
});

test('oversized working-tree metadata is unknown instead of clean', t => {
  const f = fixture(t);
  f.write();
  for (let index = 0; index < 1000; index++) fs.writeFileSync(path.join(f.root, `${String(index).padStart(4, '0')}-${'a'.repeat(70)}`), 'x');
  const repo = f.show().repos[0];
  assert.equal(repo.status, 'available');
  assert.equal(repo.observed.dirty, null);
  assert.equal(repo.observed.statusEntries, null);
  assert.match(repo.warnings.join(' '), /status.*bound|status.*unavailable/i);
});

test('display masks embedded remote credentials in JSON and plain output', async t => {
  const f = fixture(t);
  const origin = 'https://remote-user:private-credential@example.invalid/team/product.git';
  f.config.repos[0].origin = origin;
  f.write();
  git(f.root, ['remote', 'set-url', 'origin', origin]);
  const oldLog = console.log;
  for (const extra of [['--json'], []]) {
    const output = [];
    try {
      console.log = line => output.push(String(line));
      assert.equal(await cmdDomain(['show', '--name', 'catalog', '--harness-home', f.home, ...extra]), 0);
    } finally { console.log = oldLog; }
    assert.doesNotMatch(output.join('\n'), /remote-user|private-credential/);
    assert.match(output.join('\n'), /redacted/);
  }
});

test('unsafe and unsupported names fail before reading a config', t => {
  const f = fixture(t);
  for (const name of ['', '../catalog', 'catalog/other', 'Catalog', 'with space', 'a'.repeat(65), '-catalog', 'catalog-', 'catalog--other', 'catalog\n']) {
    assert.throws(() => readDomain(name, { home: f.home }), /name/i, name);
  }
  assert.equal(fs.existsSync(f.home), false);
});

test('malformed versions, duplicate keys/IDs, aliases and unknown fields are rejected', async t => {
  const cases = [
    f => ({ ...f.config, domain_version: 2 }),
    f => ({ ...f.config, name: 'other' }),
    f => ({ ...f.config, extra: 'not supported' }),
    f => ({ ...f.config, repos: [...f.config.repos, { ...f.config.repos[0] }] }),
    f => ({ ...f.config, repos: Array.from({ length: 33 }, (_, index) => ({ ...f.config.repos[0], id: `repo-${index}` })) }),
    f => ({ ...f.config, repos: [{ ...f.config.repos[0], root: 'relative' }] }),
    f => ({ ...f.config, repos: [{ ...f.config.repos[0], origin: '' }] }),
    f => ({ ...f.config, repos: [{ ...f.config.repos[0], enabled: true }] }),
    f => ({ ...f.config, shared_specs: [{ repo: 'unknown', path: 'spec.md' }] }),
    f => ({ ...f.config, shared_specs: [{ repo: 'product', path: '../spec.md' }] }),
    f => ({ ...f.config, shared_specs: [{ repo: 'product', path: '/spec.md' }] }),
    f => ({ ...f.config, shared_specs: [{ repo: 'product', path: 'sub\\spec.md' }] }),
    f => ({ ...f.config, shared_specs: [{ repo: 'product', path: 'spec.md', authoritative: true }] }),
    f => ({ ...f.config, shared_specs: [...f.config.shared_specs, ...f.config.shared_specs] }),
    () => 'domain_version: 1\ndomain_version: 1\nname: catalog\nrepos: []\n',
    f => `domain_version: 1\nname: catalog\nrepos:\n  - &repo\n    id: product\n    origin: https://example.invalid/team/product.git\n    root: ${JSON.stringify(f.root)}\n  - *repo\n`,
    () => 'x'.repeat(64 * 1024 + 1),
  ];
  for (let index = 0; index < cases.length; index++) {
    await t.test(`invalid case ${index + 1}`, child => {
      const f = fixture(child);
      f.write(cases[index](f));
      const before = fs.readFileSync(f.file);
      assert.throws(() => readDomain('catalog', { home: f.home }), /domain|version|repo|field|YAML|config|reference/i);
      assert.deepEqual(fs.readFileSync(f.file), before);
      assert.equal(fs.existsSync(path.join(f.root, '.harness')), false);
    });
  }
});

test('config/home/root symlinks and nonregular files fail safely', async t => {
  const cases = [
    f => { f.write(); fs.renameSync(f.file, `${f.file}.real`); fs.symlinkSync(`${f.file}.real`, f.file); },
    f => { f.write(); fs.renameSync(f.home, `${f.home}.real`); fs.symlinkSync(`${f.home}.real`, f.home); },
    f => { f.write(); const domains = path.dirname(f.file); fs.renameSync(domains, `${domains}.real`); fs.symlinkSync(`${domains}.real`, domains); },
    f => { f.write(); fs.unlinkSync(f.file); fs.mkdirSync(f.file); },
    f => { const link = path.join(f.dir, 'root-link'); fs.symlinkSync(f.root, link); f.config.repos[0].root = link; f.write(); },
    f => { f.config.repos[0].root = path.join(f.dir, 'root-file'); fs.writeFileSync(f.config.repos[0].root, 'not a directory'); f.write(); },
  ];
  for (let index = 0; index < cases.length; index++) {
    await t.test(`unsafe case ${index + 1}`, child => {
      const f = fixture(child);
      cases[index](f);
      assert.throws(() => f.show(), /unsafe|symlink|regular|directory|unreadable/i);
    });
  }
});

test('FIFO domain configs are rejected without blocking', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  f.write();
  fs.unlinkSync(f.file);
  const made = spawnSync('mkfifo', [f.file], { timeout: 4000 });
  assert.equal(made.status, 0);
  assert.throws(() => readDomain('catalog', { home: f.home }), /regular|unreadable|config/i);
});

test('only explicit supported show syntax is accepted', t => {
  const f = fixture(t);
  f.write();
  for (const args of [['show'], ['create', '--name', 'catalog'], ['show', '--name', 'catalog', '--name', 'catalog'], ['show', '--name', '--json'], ['show', 'catalog'], ['show', '--name', 'catalog', 'extra']]) {
    assert.throws(() => domainResultOf(args, { harnessHome: f.home }), /name|usage|verb|argument|show/i);
  }
});

test('version 2 separates logical descriptors from safe local root bindings', t => {
  const f = fixture(t);
  const v2 = { domain_version: 2, name: 'catalog', repos: [{ id: 'product', origin: f.config.repos[0].origin }], sources: [{ id: 'specs', origin: f.config.repos[0].origin }], bindings: { repos: { product: f.root }, sources: { specs: f.root } }, shared_specs: [{ source: 'specs', path: 'spec.md' }], shared_conventions: [{ source: 'specs', path: 'spec.md', authority: 'advisory' }] };
  f.write(v2);
  const read = readDomain('catalog', { home: f.home });
  assert.deepEqual(read.config, { ...v2, repos: [{ id: 'product', origin: 'https://example.invalid/team/product' }], sources: [{ id: 'specs', origin: 'https://example.invalid/team/product' }] });
  const view = inspectDomain(read);
  assert.equal(view.domainVersion, 2);
  assert.equal(view.repos[0].observed.root, f.root);
  assert.doesNotMatch(view.repos[0].warnings.join(' '), /origin.*differs/i);
  assert.equal(view.executionSupported, true);
  assert.equal(fs.existsSync(path.join(f.root, '.harness')), false);
});

test('version 2 rejects credentials and ambiguous identity or binding shapes', async t => {
  const cases = [
    v => { v.repos[0].origin = 'https://reader:private-password@example.invalid/product.git'; },
    v => { v.repos[0].origin = '//reader:private-password@example.invalid/product.git'; },
    v => { v.repos[0].origin = 'https://example.invalid/product.git?token=private-password'; },
    v => { v.repos[0].origin = 'reader:private-password@example.invalid:product.git'; },
    v => { v.repos[0].local_identity = { id: 'local-product', approved: true }; },
    v => { delete v.repos[0].origin; v.repos[0].local_identity = { id: 'local-product', approved: false }; },
    v => { v.bindings.repos.unknown = v.bindings.repos.product; },
    v => { delete v.bindings.sources.specs; },
    v => { v.sources.push({ ...v.sources[0] }); },
    v => { v.shared_specs[0].repo = 'product'; },
    v => { v.shared_specs[0].path = '../spec.md'; },
    v => { v.shared_conventions = [{ source: 'specs', path: 'spec.md', authority: 'unsupported' }]; },
  ];
  for (let i = 0; i < cases.length; i++) await t.test(`invalid executable config ${i + 1}`, child => {
    const f = fixture(child);
    const v2 = { domain_version: 2, name: 'catalog', repos: [{ id: 'product', origin: f.config.repos[0].origin }], sources: [{ id: 'specs', origin: f.config.repos[0].origin }], bindings: { repos: { product: f.root }, sources: { specs: f.root } }, shared_specs: [{ source: 'specs', path: 'spec.md' }] };
    cases[i](v2);
    f.write(v2);
    assert.throws(() => readDomain('catalog', { home: f.home }), /domain|identity|binding|credential|origin|authority|source|reference/i);
  });
});

test('executable SSH identities normalize transport usernames without persisting them', t => {
  const f = fixture(t);
  const v2 = { domain_version: 2, name: 'catalog', repos: [{ id: 'product', origin: 'ssh://git@example.invalid/team/product.git' }], sources: [], bindings: { repos: { product: f.root }, sources: {} } };
  f.write(v2);
  assert.equal(readDomain('catalog', { home: f.home }).config.repos[0].origin, 'ssh://example.invalid/team/product');
  v2.repos[0].origin = 'ssh://reader:private-password@example.invalid/team/product.git';
  f.write(v2);
  assert.throws(() => readDomain('catalog', { home: f.home }), /credential/i);
});
