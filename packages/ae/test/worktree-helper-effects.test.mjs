import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runHarness } from './helpers/cli.mjs';
import { git } from './helpers/store.mjs';
import { tempDir } from './helpers/temp.mjs';

const RAW_BYTES = 'original tracked bytes\n';

function shellQuote(value) {
  return `'${String(value).replace(/\\/g, '/').replace(/'/g, `'"'"'`)}'`;
}

function fixture(t, mechanism) {
  const root = tempDir('worktree-helper-effects-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'project with spaces');
  const home = path.join(root, 'home');
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  const globalConfig = path.join(root, 'global.gitconfig');
  fs.writeFileSync(globalConfig, '');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: undefined,
    HARNESS_HOME: home,
  };
  const runGit = (args, cwd = workspace) => git(cwd, args, { env });
  const mustGit = (args, cwd = workspace) => {
    const result = runGit(args, cwd);
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    return result;
  };
  mustGit(['init', '-b', 'main']);
  fs.writeFileSync(path.join(workspace, 'payload.txt'), RAW_BYTES);
  fs.writeFileSync(path.join(workspace, '.gitattributes'), 'payload.txt filter=Probe\n');
  mustGit(['add', '.']);
  mustGit(['commit', '-qm', 'helper effects fixture']);
  const marker = path.join(root, 'helper-ran.txt');
  const primaryWrite = path.join(workspace, 'helper-write.txt');
  const helperSource = path.join(root, 'helper.mjs');
  fs.writeFileSync(helperSource, [
    "import fs from 'node:fs';",
    `fs.appendFileSync(${JSON.stringify(marker)}, 'executed\\n');`,
    `fs.writeFileSync(${JSON.stringify(primaryWrite)}, 'ungated helper mutation\\n');`,
    mechanism === 'smudge' ? 'process.stdout.write(fs.readFileSync(0));' : '',
    mechanism === 'fsmonitor' ? "process.stdout.write('token\\0');" : '',
  ].join('\n'));
  const helper = path.join(root, 'helper.sh');
  fs.writeFileSync(helper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(helperSource)}\n`);
  fs.chmodSync(helper, 0o755);
  const cli = (slug, cwd = workspace) => runHarness(['worktree', '--slug', slug, '--workspace', cwd, '--json', '--no-events'], {
    cwd, env, trust: false, injectHome: false,
  });
  const clearEffects = () => {
    fs.rmSync(marker, { force: true });
    fs.rmSync(primaryWrite, { force: true });
  };
  const assertNoEffects = () => {
    assert.equal(fs.existsSync(marker), false, `${mechanism}: configured helper must not run`);
    assert.equal(fs.existsSync(primaryWrite), false, `${mechanism}: primary checkout must not be changed by helpers`);
  };
  const assertRawCheckout = (result, slug) => {
    assertNoEffects();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const created = JSON.parse(result.stdout);
    assert.equal(created.created, true);
    assert.equal(created.branch, `harness/${slug}`);
    assert.equal(fs.readFileSync(path.join(created.path, 'payload.txt'), 'utf8'), RAW_BYTES);
    assert.equal(fs.statSync(path.join(created.path, '.git')).isFile(), true);
    return created;
  };
  return { root, workspace, marker, helper, mustGit, runGit, cli, clearEffects, assertNoEffects, assertRawCheckout };
}

for (const mechanism of ['post-checkout', 'smudge', 'process', 'fsmonitor']) {
  test(`untrusted worktree bootstrap suppresses ${mechanism} helpers and populates committed bytes`, (t) => {
    const f = fixture(t, mechanism);
    if (mechanism === 'post-checkout') {
      fs.copyFileSync(f.helper, path.join(f.workspace, '.git/hooks/post-checkout'));
      fs.chmodSync(path.join(f.workspace, '.git/hooks/post-checkout'), 0o755);
    } else if (mechanism === 'fsmonitor') {
      f.mustGit(['config', 'core.fsmonitor', f.helper.replace(/\\/g, '/')]);
    } else {
      f.mustGit(['config', `filter.Probe.${mechanism}`, shellQuote(f.helper)]);
      f.mustGit(['config', 'filter.Probe.required', 'true']);
    }
    f.runGit(['worktree', 'add', '-b', 'harness/control', path.join(f.root, 'control'), 'HEAD']);
    assert.equal(fs.existsSync(f.marker), true, `${mechanism}: direct Git control must actually execute the helper`);
    f.clearEffects();
    const created = f.assertRawCheckout(f.cli('bootstrap'), 'bootstrap');
    const reused = f.cli('bootstrap');
    f.assertNoEffects();
    assert.equal(reused.status, 0, reused.stderr + reused.stdout);
    assert.equal(JSON.parse(reused.stdout).created, false);
    assert.equal(JSON.parse(reused.stdout).path, created.path);
  });
}

test('worktree bootstrap suppresses required filters activated only by the target branch', (t) => {
  const f = fixture(t, 'smudge');
  const included = path.join(f.root, 'branch.gitconfig');
  fs.writeFileSync(included, `[filter "Probe"]\n\tsmudge = ${JSON.stringify(shellQuote(f.helper))}\n\trequired = true\n`);
  f.mustGit(['config', 'includeIf.onbranch:harness/**.path', included.replace(/\\/g, '/')]);
  f.runGit(['worktree', 'add', '-b', 'harness/control', path.join(f.root, 'control'), 'HEAD']);
  assert.equal(fs.existsSync(f.marker), true, 'conditional filter control must execute on the target branch');
  f.clearEffects();
  f.assertRawCheckout(f.cli('branch-filter'), 'branch-filter');
});

test('unresolved primary helper metadata fails before checkout or ignore-file mutation', (t) => {
  const f = fixture(t, 'metadata');
  fs.appendFileSync(path.join(f.workspace, '.git/config'), `[filter "Probe"]\n\tclean = ${'x'.repeat(70 * 1024)}\n`);
  const result = f.cli('metadata');
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.equal(fs.existsSync(path.join(f.workspace, '.gitignore')), false);
  assert.equal(fs.existsSync(path.join(f.workspace, '.worktrees')), false);
  assert.doesNotMatch(f.mustGit(['show-ref', '--heads']).stdout, /harness\/metadata/);
  f.assertNoEffects();
});

test('worktree reuse rejects a linked checkout belonging to another repository', t => {
  const f = fixture(t, 'metadata');
  const foreign = path.join(f.root, 'foreign');
  fs.mkdirSync(foreign);
  f.mustGit(['init', '-b', 'main'], foreign);
  fs.writeFileSync(path.join(foreign, 'foreign.txt'), 'belongs to the other repository\n');
  f.mustGit(['add', '.'], foreign);
  f.mustGit(['commit', '-qm', 'foreign repository'], foreign);
  const dest = path.join(f.workspace, '.worktrees', 'foreign');
  f.mustGit(['worktree', 'add', '-b', 'foreign-work', dest, 'HEAD'], foreign);
  const result = f.cli('foreign');
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /not a worktree of this repository/);
  assert.equal(fs.readFileSync(path.join(dest, 'foreign.txt'), 'utf8'), 'belongs to the other repository\n');
  assert.equal(fs.existsSync(path.join(f.workspace, '.git', 'ae-worktrees')), false);
});

for (const invalid of ['malformed', 'oversized']) {
  test(`unresolved ${invalid} target-branch metadata removes only the new checkout and supports a populated retry`, (t) => {
    const f = fixture(t, 'smudge');
    const included = path.join(f.root, 'branch.gitconfig');
    const helperConfig = `[filter "Probe"]\n\tsmudge = ${JSON.stringify(shellQuote(f.helper))}\n\trequired = true\n`;
    fs.writeFileSync(included, helperConfig + (invalid === 'malformed' ? '[broken\n' : `\tclean = ${'x'.repeat(70 * 1024)}\n`));
    f.mustGit(['config', 'includeIf.onbranch:harness/**.path', included.replace(/\\/g, '/')]);
    const result = f.cli('retry');
    assert.notEqual(result.status, 0, result.stderr + result.stdout);
    f.assertNoEffects();
    const dest = path.join(f.workspace, '.worktrees/retry');
    assert.equal(fs.existsSync(dest), false, 'failed bootstrap must not leave an empty checkout that a retry accepts');
    assert.equal(f.mustGit(['worktree', 'list', '--porcelain']).stdout.includes(dest), false);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'payload.txt'), 'utf8'), RAW_BYTES);
    fs.writeFileSync(included, helperConfig);
    f.assertRawCheckout(f.cli('retry'), 'retry');
  });
}
