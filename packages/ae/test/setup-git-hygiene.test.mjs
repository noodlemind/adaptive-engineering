import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { ensureHarnessDir } from '../lib/session.mjs';
import { addIsolatedWorktree } from '../lib/worktree.mjs';
import { initGit, runHarness, tempDir } from './helpers/index.mjs';
import { TEST_GIT_ENV } from './helpers/store.mjs';

function git(workspace, args) {
  const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', env: { ...process.env, ...TEST_GIT_ENV } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t, { separate = false } = {}) {
  const root = tempDir('ae-setup-git-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product');
  fs.mkdirSync(workspace);
  if (separate) git(workspace, ['init', '-q', '--separate-git-dir', path.join(root, 'metadata')]);
  initGit(workspace);
  // Worktree checkout and isolated helper commands must use the same byte policy.
  git(workspace, ['config', 'core.autocrlf', 'false']);
  return { root, workspace };
}

test('orientation keeps all private artifacts out of Git without creating product ignore files', (t) => {
  const { root, workspace } = fixture(t);
  const result = runHarness(['orient', '--workspace', workspace, '--query', 'value', '--ae-home', path.join(root, 'ae'), '--no-events', '--json'], { trust: false });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  fs.writeFileSync(path.join(workspace, '.harness', 'run.mjs'), '// local launcher\n');
  fs.writeFileSync(path.join(workspace, '.harness', 'future-runtime.json'), '{}\n');
  assert.equal(git(workspace, ['status', '--porcelain', '--untracked-files=all']), '');
  assert.equal(fs.existsSync(path.join(workspace, '.gitignore')), false);
  assert.equal(fs.existsSync(path.join(workspace, '.harness', '.gitignore')), false);
});

test('routine preparation preserves a tracked legacy ignore file exactly', (t) => {
  const { workspace } = fixture(t);
  const ignore = path.join(workspace, '.harness', '.gitignore');
  fs.mkdirSync(path.dirname(ignore));
  fs.writeFileSync(ignore, '# team-authored legacy exclusions\ncontext-pack.md');
  git(workspace, ['add', '.harness/.gitignore']);
  git(workspace, ['commit', '-qm', 'legacy ignore']);
  assert.ok(ensureHarnessDir(workspace, false));
  assert.equal(fs.readFileSync(ignore, 'utf8'), '# team-authored legacy exclusions\ncontext-pack.md');
  assert.equal(git(workspace, ['status', '--porcelain', '--untracked-files=all']), '');
});

test('worktree setup preserves root ignore bytes and uses common Git-local metadata', (t) => {
  const { workspace } = fixture(t);
  const ignore = path.join(workspace, '.gitignore');
  fs.writeFileSync(ignore, '# deliberately uncommitted\nnode_modules');
  const before = git(workspace, ['status', '--porcelain', '--untracked-files=all']);
  const tree = addIsolatedWorktree({ workspace, slug: 'personal', record: false });
  assert.equal(fs.readFileSync(ignore, 'utf8'), '# deliberately uncommitted\nnode_modules');
  assert.equal(git(workspace, ['status', '--porcelain', '--untracked-files=all']), before);
  assert.ok(ensureHarnessDir(tree.path, false));
  fs.writeFileSync(path.join(tree.path, '.harness', 'run.mjs'), '// local\n');
  assert.equal(git(tree.path, ['status', '--porcelain', '--untracked-files=all']), '');
  assert.equal(fs.existsSync(path.join(tree.path, '.gitignore')), false);
  fs.appendFileSync(path.join(tree.path, 'src', 'example.js'), '// tracked product edit\n');
  assert.equal(git(tree.path, ['status', '--porcelain', '--untracked-files=all']), 'M src/example.js');
});

test('separate Git directories receive private exclusions without product changes', (t) => {
  const { root, workspace } = fixture(t, { separate: true });
  assert.ok(ensureHarnessDir(workspace, false));
  fs.writeFileSync(path.join(workspace, '.harness', 'run.mjs'), '// local\n');
  assert.equal(git(workspace, ['status', '--porcelain', '--untracked-files=all']), '');
  assert.match(fs.readFileSync(path.join(root, 'metadata', 'info', 'exclude'), 'utf8'), /^\/\.harness\/$/m);
});

test('private exclude updates preserve authored entries and missing newline boundaries', (t) => {
  const { workspace } = fixture(t);
  const exclude = path.join(workspace, '.git', 'info', 'exclude');
  fs.writeFileSync(exclude, '# local sentinel\n/local-only');
  assert.ok(ensureHarnessDir(workspace, false));
  assert.ok(ensureHarnessDir(workspace, false));
  const content = fs.readFileSync(exclude, 'utf8');
  assert.equal(content, '# local sentinel\n/local-only\n/.harness/\n');
});

test('unsafe Git-local exclude paths refuse setup without modifying their target', (t) => {
  const { root, workspace } = fixture(t);
  const outside = path.join(root, 'outside');
  fs.writeFileSync(outside, 'outside sentinel\n');
  const exclude = path.join(workspace, '.git', 'info', 'exclude');
  fs.rmSync(exclude);
  try { fs.symlinkSync(outside, exclude, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('host does not permit file symlinks'); return; }
    throw error;
  }
  assert.equal(ensureHarnessDir(workspace, false), null);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside sentinel\n');
  assert.throws(() => addIsolatedWorktree({ workspace, slug: 'unsafe', record: false }), /ignore|exclude/i);
  assert.equal(fs.existsSync(path.join(workspace, '.worktrees')), false);
});

test('dry-run preparation leaves both repository and Git metadata unchanged', (t) => {
  const { workspace } = fixture(t);
  const exclude = path.join(workspace, '.git', 'info', 'exclude');
  const before = fs.readFileSync(exclude, 'utf8');
  assert.ok(ensureHarnessDir(workspace, true));
  assert.equal(fs.readFileSync(exclude, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(workspace, '.harness')), false);
});

test('a fresh clone creates its own exclusions without inheriting user metadata', (t) => {
  const { root, workspace } = fixture(t);
  assert.ok(ensureHarnessDir(workspace, false));
  const clone = path.join(root, 'clone');
  git(root, ['clone', '-q', workspace, clone]);
  assert.ok(ensureHarnessDir(clone, false));
  fs.writeFileSync(path.join(clone, '.harness', 'run.mjs'), '// this user\n');
  assert.equal(git(clone, ['status', '--porcelain', '--untracked-files=all']), '');
  assert.equal(fs.existsSync(path.join(clone, '.harness', '.gitignore')), false);
});

test('nested workspace exclusions name only their actual checkout-relative state', (t) => {
  const { workspace } = fixture(t);
  const nested = path.join(workspace, 'src');
  assert.ok(ensureHarnessDir(nested, false));
  fs.writeFileSync(path.join(nested, '.harness', 'run.mjs'), '// nested\n');
  assert.equal(git(workspace, ['status', '--porcelain', '--untracked-files=all']), '');
  const exclude = fs.readFileSync(path.join(workspace, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\/src\/\.harness\/$/m);
  assert.doesNotMatch(exclude, /^\/\.harness\/$/m);
});

test('a symlinked Git info directory cannot redirect private exclude writes', (t) => {
  const { root, workspace } = fixture(t);
  const outside = path.join(root, 'outside-info');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'exclude'), '# outside\n');
  const info = path.join(workspace, '.git', 'info');
  fs.rmSync(info, { recursive: true });
  try { fs.symlinkSync(outside, info, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('host does not permit directory symlinks'); return; }
    throw error;
  }
  assert.equal(ensureHarnessDir(workspace, false), null);
  assert.equal(fs.readFileSync(path.join(outside, 'exclude'), 'utf8'), '# outside\n');
});

test('a product ignore override reports refusal instead of leaving private artifacts visible', (t) => {
  const { workspace } = fixture(t);
  fs.writeFileSync(path.join(workspace, '.gitignore'), '!/.harness/\n');
  assert.equal(ensureHarnessDir(workspace, false), null);
  assert.equal(fs.existsSync(path.join(workspace, '.harness')), false);
  assert.equal(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8'), '!/.harness/\n');
});

test('nested Git pattern metacharacters stay literal in private exclusions', (t) => {
  const { workspace } = fixture(t);
  const nested = path.join(workspace, 'src', '..data [literal]');
  fs.mkdirSync(nested);
  assert.ok(ensureHarnessDir(nested, false));
  fs.writeFileSync(path.join(nested, '.harness', 'run.mjs'), '// nested\n');
  assert.equal(git(workspace, ['status', '--porcelain', '--untracked-files=all']), '');
});

test('an exclude already at the read bound is refused without appending unreadable metadata', (t) => {
  const { workspace } = fixture(t);
  const exclude = path.join(workspace, '.git', 'info', 'exclude');
  const before = '#'.repeat(1024 * 1024);
  fs.writeFileSync(exclude, before);
  assert.equal(ensureHarnessDir(workspace, false), null);
  assert.equal(fs.readFileSync(exclude, 'utf8'), before);
});
