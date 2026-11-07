import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runHarness } from './helpers/cli.mjs';
import { git } from './helpers/store.mjs';
import { tempDir } from './helpers/temp.mjs';

function fixture(t) {
  const root = tempDir('worktree-start-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product');
  const home = path.join(root, 'state');
  fs.mkdirSync(workspace);
  const runGit = (args, cwd = workspace) => {
    const result = git(cwd, args);
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    return result.stdout.trim();
  };
  runGit(['init', '-b', 'main']);
  fs.writeFileSync(path.join(workspace, 'source.txt'), 'first parent\n');
  runGit(['add', '.']);
  runGit(['commit', '-qm', 'first parent']);
  const base = runGit(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(workspace, 'source.txt'), 'requested recovery tip\n');
  runGit(['commit', '-qam', 'requested recovery tip']);
  const tip = runGit(['rev-parse', 'HEAD']);
  const cli = (slug, args = []) => runHarness(['worktree', '--slug', slug, ...args, '--workspace', workspace, '--ae-home', home, '--json', '--no-events'], {
    cwd: workspace, trust: false, injectHome: false, env: { HARNESS_HOME: home },
  });
  const ok = (slug, args = []) => {
    const result = cli(slug, args);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  return { root, workspace, base, tip, git: runGit, cli, ok };
}

for (const dryRun of [false, true]) {
  test(`explicit start rejects a stale existing branch before creating a checkout${dryRun ? ' in dry-run' : ''}`, t => {
    const f = fixture(t);
    f.git(['branch', 'harness/stale-branch', f.base]);
    const exclude = path.join(f.workspace, '.git', 'info', 'exclude');
    const before = fs.readFileSync(exclude);
    const result = f.cli('stale-branch', ['--from', f.tip, ...(dryRun ? ['--dry-run'] : [])]);
    assert.notEqual(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stderr, /does not contain.*--from/);
    assert.match(result.stderr, /fresh.*--slug/);
    assert.equal(f.git(['rev-parse', 'harness/stale-branch']), f.base);
    assert.equal(fs.existsSync(path.join(f.workspace, '.worktrees')), false);
    assert.deepEqual(fs.readFileSync(exclude), before);
  });

  test(`explicit start rejects a stale existing checkout and preserves its files${dryRun ? ' in dry-run' : ''}`, t => {
    const f = fixture(t);
    const created = f.ok('stale-checkout', ['--from', f.base]);
    const dirty = path.join(created.path, 'keep.txt');
    fs.writeFileSync(dirty, 'unrelated user work\n');
    const record = path.join(f.workspace, '.git', 'ae-worktrees');
    const before = fs.readFileSync(record);
    const result = f.cli('stale-checkout', ['--from', f.tip, ...(dryRun ? ['--dry-run'] : [])]);
    assert.notEqual(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stderr, /does not contain.*--from/);
    assert.equal(f.git(['rev-parse', 'HEAD'], created.path), f.base);
    assert.equal(fs.readFileSync(dirty, 'utf8'), 'unrelated user work\n');
    assert.deepEqual(fs.readFileSync(record), before);
  });
}

test('explicit start rejects a divergent parent without resetting the existing branch', t => {
  const f = fixture(t);
  f.git(['switch', '-c', 'harness/divergent', f.base]);
  fs.writeFileSync(path.join(f.workspace, 'other.txt'), 'different release parent\n');
  f.git(['add', '.']);
  f.git(['commit', '-qm', 'different release parent']);
  const branchTip = f.git(['rev-parse', 'HEAD']);
  f.git(['switch', 'main']);
  const result = f.cli('divergent', ['--from', f.tip]);
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /does not contain.*--from/);
  assert.equal(f.git(['rev-parse', 'harness/divergent']), branchTip);
  assert.equal(fs.existsSync(path.join(f.workspace, '.worktrees')), false);
});

test('explicit start accepts valid descendants when reusing a checkout or retained branch', t => {
  const f = fixture(t);
  const created = f.ok('advanced', ['--from', f.tip]);
  fs.writeFileSync(path.join(created.path, 'later.txt'), 'completed issue work\n');
  f.git(['add', '.'], created.path);
  f.git(['commit', '-qm', 'completed issue work'], created.path);
  const branchTip = f.git(['rev-parse', 'HEAD'], created.path);
  const reused = f.ok('advanced', ['--from', f.tip]);
  assert.equal(reused.created, false);
  assert.equal(f.git(['rev-parse', 'HEAD'], reused.path), branchTip);
  assert.equal(f.ok('advanced', ['--from', f.tip, '--dry-run']).dryRun, true);
  f.git(['worktree', 'remove', created.path]);
  assert.equal(f.ok('advanced', ['--from', f.tip, '--dry-run']).dryRun, true);
  assert.equal(fs.existsSync(created.path), false);
  const restored = f.ok('advanced', ['--from', f.tip]);
  assert.equal(restored.created, true);
  assert.equal(f.git(['rev-parse', 'HEAD'], restored.path), branchTip);
});

test('implicit start preserves existing branch and checkout reuse', t => {
  const f = fixture(t);
  f.git(['branch', 'harness/implicit', f.base]);
  const created = f.ok('implicit');
  assert.equal(f.git(['rev-parse', 'HEAD'], created.path), f.base);
  const reused = f.ok('implicit');
  assert.equal(reused.created, false);
  assert.equal(f.git(['rev-parse', 'HEAD'], reused.path), f.base);
});

test('inline explicit start selects the requested commit and rejects stale reuse', t => {
  const f = fixture(t);
  const created = f.ok('inline', [`--from=${f.base}`]);
  assert.equal(f.git(['rev-parse', 'HEAD'], created.path), f.base);
  const result = f.cli('inline', [`--from=${f.tip}`]);
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /does not contain.*--from/);
  assert.equal(f.git(['rev-parse', 'HEAD'], created.path), f.base);
});

test('an explicit workspace-relative HEAD resolves in the calling worktree', t => {
  const f = fixture(t);
  const caller = f.ok('caller', ['--from', f.base]);
  const home = path.join(f.root, 'state');
  const result = runHarness(['worktree', '--slug', 'caller-head', '--from', 'HEAD', '--workspace', caller.path, '--ae-home', home, '--json', '--no-events'], {
    cwd: caller.path, trust: false, injectHome: false, env: { HARNESS_HOME: home },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const created = JSON.parse(result.stdout);
  assert.equal(f.git(['rev-parse', 'HEAD'], created.path), f.base);
  assert.equal(f.git(['rev-parse', 'HEAD']), f.tip);
});

for (const revision of ['missing-recovery-tip', '--detach']) {
  test(`unresolvable or option-shaped explicit start ${revision} fails without creating state`, t => {
    const f = fixture(t);
    for (const args of [[], ['--dry-run']]) {
      const result = f.cli('invalid', [`--from=${revision}`, ...args]);
      assert.notEqual(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stderr, /--from|unknown flag/);
      assert.equal(fs.existsSync(path.join(f.workspace, '.worktrees')), false);
    }
  });
}
