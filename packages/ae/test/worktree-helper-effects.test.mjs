import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { runHarness } from './helpers/cli.mjs';
import { git } from './helpers/store.mjs';
import { tempDir } from './helpers/temp.mjs';
import { aeWorktreePrimary } from '../lib/worktree.mjs';

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
  const cli = (slug, cwd = workspace, overrides = {}) => runHarness(['worktree', '--slug', slug, '--workspace', cwd, '--json', '--no-events'], {
    cwd, env: { ...env, ...overrides }, trust: false, injectHome: false,
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

test('worktree reuse compares physical repository paths when generic realpath retains an alias', t => {
  const f = fixture(t, 'metadata'), alias = path.join(f.root, 'project alias');
  fs.symlinkSync(f.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fs.realpathSync.native(alias), fs.realpathSync.native(f.workspace));
  const preload = path.join(f.root, 'alias-realpath.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
import path from 'node:path';
const alias = ${JSON.stringify(alias)};
const original = fs.realpathSync;
const keepAlias = (target, ...args) => {
  const result = original(target, ...args), requested = path.resolve(String(target));
  return requested === alias || requested.startsWith(alias + path.sep) ? requested : result;
};
keepAlias.native = original.native;
fs.realpathSync = keepAlias;
`);
  const env = { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${pathToFileURL(preload).href}`.trim() };
  const created = f.assertRawCheckout(f.cli('alias-reuse', alias, env), 'alias-reuse');
  const reused = f.cli('alias-reuse', alias, env);
  assert.equal(reused.status, 0, reused.stderr + reused.stdout);
  assert.equal(JSON.parse(reused.stdout).created, false);
  assert.equal(fs.realpathSync.native(JSON.parse(reused.stdout).path), fs.realpathSync.native(created.path));
  f.assertNoEffects();
});

test('registered worktrees retain absolute legacy aliases without accepting relative records', t => {
  const f = fixture(t, 'metadata'), created = f.assertRawCheckout(f.cli('legacy-alias'), 'legacy-alias');
  const alias = path.join(f.root, 'legacy project alias');
  fs.symlinkSync(f.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const record = path.join(f.workspace, '.git', 'ae-worktrees');
  fs.writeFileSync(record, `${path.relative(f.workspace, created.path)}\n`);
  assert.equal(aeWorktreePrimary(created.path), null);
  const legacy = `${path.join(alias, '.worktrees', 'legacy-alias')}\n`;
  fs.writeFileSync(record, legacy);
  assert.equal(aeWorktreePrimary(created.path), fs.realpathSync.native(f.workspace));
  assert.equal(aeWorktreePrimary(path.join(alias, '.worktrees', 'legacy-alias')), fs.realpathSync.native(f.workspace));
  const reused = f.cli('legacy-alias', alias);
  assert.equal(reused.status, 0, reused.stderr + reused.stdout);
  assert.equal(JSON.parse(reused.stdout).created, false);
  assert.equal(fs.readFileSync(record, 'utf8'), legacy);
});

test('Windows root-relative registration cannot select the caller drive', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t, 'metadata'), created = f.assertRawCheckout(f.cli('root-relative'), 'root-relative');
  const real = fs.realpathSync.native(created.path), root = path.parse(real).root;
  fs.writeFileSync(path.join(f.workspace, '.git', 'ae-worktrees'), `${real.slice(root.length - 1)}\n`);
  const module = new URL('../lib/worktree.mjs', import.meta.url).href;
  const script = `import { aeWorktreePrimary } from ${JSON.stringify(module)}; console.log(JSON.stringify(aeWorktreePrimary(${JSON.stringify(real)})));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: f.workspace, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout), null);
});

test('worktree reuse refuses unavailable repository identity', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t, 'metadata');
  f.assertRawCheckout(f.cli('unavailable-identity'), 'unavailable-identity');
  const lookup = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  assert.equal(lookup.status, 0, lookup.stderr);
  const gitPath = lookup.stdout.trim(), bin = path.join(f.root, 'git transport');
  fs.mkdirSync(bin);
  const marker = path.join(f.root, 'unavailable-observations');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
if [ "$1" = rev-parse ] && [ "$2" = --git-common-dir ]; then
  printf 'unavailable\\n' >> ${shellQuote(marker)}
  exit 1
fi
exec ${shellQuote(gitPath)} "$@"
`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const record = path.join(f.workspace, '.git', 'ae-worktrees'), before = fs.readFileSync(record);
  const result = f.cli('unavailable-identity', f.workspace, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /not a worktree of this repository/);
  assert.match(fs.readFileSync(marker, 'utf8'), /unavailable/);
  assert.deepEqual(fs.readFileSync(record), before);
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
