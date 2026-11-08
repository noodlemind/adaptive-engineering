import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installGlobalHarnessShim } from '../lib/global-bin.mjs';
import { installHarnessBin } from '../lib/install-harness-bin.mjs';
import { mergeIntelliJInstructions, seedProfile, syncAssetsToTarget } from '../lib/sync.mjs';

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-install-boundaries-'));
  try { return run(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function packageFixture(root) {
  const pkg = path.join(root, 'package');
  write(pkg, 'package.json', JSON.stringify({ name: 'ae-harness', dependencies: {} }));
  write(pkg, 'lib/current.mjs', 'export const current = true;\n');
  return pkg;
}

function configurePath(shellHome, copilotHome, flags = {}) {
  const module = new URL('../lib/global-bin.mjs', import.meta.url).href;
  const script = `import { configureShellPath } from ${JSON.stringify(module)};
console.log(JSON.stringify(configureShellPath(${JSON.stringify(copilotHome)}, ${JSON.stringify(flags)}, () => {})));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: shellHome, USERPROFILE: shellHome }, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

function findOnPath(entries) {
  const module = new URL('../lib/global-bin.mjs', import.meta.url).href;
  const script = `import { findHarnessOnPath } from ${JSON.stringify(module)};
console.log(JSON.stringify(findHarnessOnPath()));`;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = entries.join(path.delimiter);
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

const symlinks = { skip: process.platform === 'win32' ? 'symlink creation needs Windows privilege' : false };

test('a shim installed in a selected home finds that runtime without a home environment override', () => fixture(root => {
  const home = path.join(root, 'selected home');
  const otherHome = path.join(root, 'ordinary-home');
  fs.mkdirSync(otherHome);
  write(home, '.ae-bin/bin/ae.mjs', 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  installGlobalHarnessShim(home, {}, () => {});
  const env = { ...process.env, HOME: otherHome, USERPROFILE: otherHome };
  delete env.COPILOT_HOME;
  const run = spawnSync(process.execPath, [path.join(home, 'bin/ae'), 'help', 'literal argument'], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), ['help', 'literal argument']);
}));

test('an explicitly selected COPILOT_HOME still overrides the shim location', () => fixture(root => {
  const home = path.join(root, 'selected');
  const override = path.join(root, 'override');
  write(home, '.ae-bin/bin/ae.mjs', 'console.log("selected");\n');
  write(override, '.ae-bin/bin/ae.mjs', 'console.log("override");\n');
  installGlobalHarnessShim(home, {}, () => {});
  const run = spawnSync(process.execPath, [path.join(home, 'bin/ae')], {
    env: { ...process.env, COPILOT_HOME: override }, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'override');
}));

test('shell PATH configuration uses the selected bin, quotes special characters and does not repeat it', () => fixture(root => {
  const shellHome = path.join(root, 'shell-home');
  const selected = path.join(root, "selected home 'quoted' $value `literal`");
  const profile = write(shellHome, '.profile', '# personal startup\n# harness global bin\nexport PATH="$HOME/.copilot/bin:$PATH"\n');
  assert.equal(configurePath(shellHome, selected).updated, 1);
  const configured = fs.readFileSync(profile, 'utf8');
  assert.equal(configurePath(shellHome, selected).updated, 0);
  assert.equal(fs.readFileSync(profile, 'utf8'), configured);
  assert.match(configured, /selected home/);
  if (process.platform !== 'win32') {
    const shell = spawnSync('/bin/sh', ['-c', '. "$1"; printf "%s" "$PATH"', 'sh', profile], {
      env: { ...process.env, HOME: shellHome, PATH: 'original-path' }, encoding: 'utf8',
    });
    assert.equal(shell.status, 0, shell.stderr);
    assert.equal(shell.stdout, `${path.join(selected, 'bin')}:${path.join(shellHome, '.copilot/bin')}:original-path`);
  }
}));

test('default shell PATH spelling is retained and custom-home dry-runs do not edit startup files', () => fixture(root => {
  const shellHome = path.join(root, 'shell-home');
  const profile = write(shellHome, '.profile', '# personal startup\n');
  assert.equal(configurePath(shellHome, path.join(root, 'custom'), { dryRun: true }).updated, 1);
  assert.equal(fs.readFileSync(profile, 'utf8'), '# personal startup\n');
  assert.equal(configurePath(shellHome, path.join(shellHome, '.copilot')).updated, 1);
  const content = fs.readFileSync(profile, 'utf8');
  assert.match(content, /export PATH="\$HOME\/\.copilot\/bin:\$PATH"/);
  assert.equal(configurePath(shellHome, path.join(shellHome, '.copilot')).updated, 0);
  assert.equal(fs.readFileSync(profile, 'utf8'), content);
}));

test('POSIX PATH discovery skips a nonexecutable ae file and finds the next executable', { skip: process.platform === 'win32' }, () => fixture(root => {
  const nonexecutable = write(root, 'first/ae', '#!/bin/sh\n');
  const executable = write(root, 'second/ae', '#!/bin/sh\n');
  fs.chmodSync(nonexecutable, 0o644); fs.chmodSync(executable, 0o755);
  assert.equal(findOnPath([path.dirname(nonexecutable)]), null);
  assert.equal(findOnPath([path.dirname(nonexecutable), path.dirname(executable)]), executable);
}));

test('PATH discovery accepts an executable POSIX command or Windows command shim', () => fixture(root => {
  const command = write(root, process.platform === 'win32' ? 'bin/ae.cmd' : 'bin/ae', 'command fixture\n');
  fs.chmodSync(command, 0o755);
  assert.equal(findOnPath([path.dirname(command)]), command);
}));

test('asset hydration refuses linked directories and leaves external files unchanged, including dry-runs', symlinks, () => fixture(root => {
  const assets = path.join(root, 'assets');
  const target = path.join(root, 'target');
  const outside = path.join(root, 'outside');
  write(assets, 'skills/probe.md', 'shipped bytes');
  write(outside, 'probe.md', 'user bytes');
  fs.mkdirSync(target);
  fs.symlinkSync(outside, path.join(target, 'skills'), 'dir');
  for (const dryRun of [true, false]) {
    assert.throws(() => syncAssetsToTarget(assets, target, { dryRun }, () => {}), { code: 'E_TARGET' });
    assert.equal(fs.readFileSync(path.join(outside, 'probe.md'), 'utf8'), 'user bytes');
  }
}));

test('asset hydration refuses linked leaves, including global instructions', symlinks, () => fixture(root => {
  for (const rel of ['skills/probe.md', 'copilot-instructions.md']) {
    const assets = path.join(root, rel.startsWith('skills') ? 'skill-assets' : 'instruction-assets');
    const target = path.join(root, rel.startsWith('skills') ? 'skill-target' : 'instruction-target');
    write(assets, rel, 'shipped bytes');
    const outside = write(root, `${rel.replaceAll('/', '-')}.outside`, 'user bytes');
    fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
    fs.symlinkSync(outside, path.join(target, rel));
    assert.throws(() => syncAssetsToTarget(assets, target, {}, () => {}), { code: 'E_TARGET' });
    assert.equal(fs.readFileSync(outside, 'utf8'), 'user bytes');
  }
}));

test('profile and IntelliJ instruction hydration refuse linked output leaves', symlinks, () => fixture(root => {
  const assets = path.join(root, 'assets');
  const target = path.join(root, 'target');
  write(assets, 'knowledge/profile.md.template', '**autonomy:** low\n');
  write(assets, 'instructions/harness-global.instructions.md', '# Instruction\n');
  const profile = write(root, 'profile.outside', 'personal profile');
  const instructions = write(root, 'instructions.outside', 'personal instructions');
  fs.mkdirSync(path.join(target, 'knowledge'), { recursive: true });
  fs.symlinkSync(profile, path.join(target, 'knowledge/profile.md'));
  fs.symlinkSync(instructions, path.join(target, 'global-copilot-instructions.md'));
  assert.throws(() => seedProfile(assets, target, { forceProfile: true }, () => {}), { code: 'E_TARGET' });
  assert.throws(() => mergeIntelliJInstructions(assets, target, {}, () => {}), { code: 'E_TARGET' });
  assert.equal(fs.readFileSync(profile, 'utf8'), 'personal profile');
  assert.equal(fs.readFileSync(instructions, 'utf8'), 'personal instructions');
}));

test('shim installation refuses a linked bin directory before writing a command', symlinks, () => fixture(root => {
  const home = path.join(root, 'home');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(home); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(home, 'bin'), 'dir');
  for (const dryRun of [true, false]) {
    assert.throws(() => installGlobalHarnessShim(home, { dryRun }, () => {}), { code: 'E_TARGET' });
    assert.equal(fs.existsSync(path.join(outside, 'ae')), false);
  }
}));

test('runtime hydration refuses both a linked runtime root and a linked nested directory', symlinks, () => fixture(root => {
  const pkg = packageFixture(root);
  for (const rel of ['.ae-bin', '.ae-bin/lib']) {
    const home = path.join(root, rel === '.ae-bin' ? 'root-target' : 'nested-target');
    const outside = path.join(root, rel === '.ae-bin' ? 'root-outside' : 'nested-outside');
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(home, rel), 'dir');
    for (const dryRun of [true, false]) {
      assert.throws(() => installHarnessBin(pkg, home, { dryRun }, () => {}), { code: 'E_TARGET' });
      assert.deepEqual(fs.readdirSync(outside), []);
    }
  }
}));

test('runtime upgrade removes only obsolete lock-owned leaves and preserves unrelated files', () => fixture(root => {
  const pkg = packageFixture(root);
  const home = path.join(root, 'home');
  write(pkg, 'corpus/skills/retired/SKILL.md', 'old skill');
  const first = installHarnessBin(pkg, home, {}, () => {});
  const stale = '.ae-bin/corpus/skills/retired/SKILL.md';
  write(home, '.ae-bin/corpus/skills/retired/personal.md', 'personal sibling');
  write(home, '.ae-bin/local-only.txt', 'personal runtime file');
  const outside = write(root, 'outside.txt', 'outside');
  write(home, '.harness-lock.json', JSON.stringify({
    package: 'ae-harness', files: [...first.files, '.ae-bin/corpus', '.ae-bin/../../outside.txt'],
  }));
  fs.rmSync(path.join(pkg, 'corpus/skills/retired'), { recursive: true });
  const result = installHarnessBin(pkg, home, {}, () => {});
  assert.equal(fs.existsSync(path.join(home, stale)), false);
  assert.equal(result.removed, 1);
  assert.equal(fs.readFileSync(path.join(home, '.ae-bin/corpus/skills/retired/personal.md'), 'utf8'), 'personal sibling');
  assert.equal(fs.readFileSync(path.join(home, '.ae-bin/local-only.txt'), 'utf8'), 'personal runtime file');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  assert.equal(result.files.includes(stale), false);
}));

test('runtime retirement dry-run preserves files and unowned runtime files are not pruned', () => fixture(root => {
  const pkg = packageFixture(root);
  const home = path.join(root, 'home');
  const stale = '.ae-bin/lib/retired.mjs';
  write(home, stale, 'old runtime');
  write(home, '.harness-lock.json', JSON.stringify({ package: 'ae-harness', files: [stale] }));
  const dry = installHarnessBin(pkg, home, { dryRun: true }, () => {});
  assert.equal(dry.removed, 1);
  assert.equal(fs.readFileSync(path.join(home, stale), 'utf8'), 'old runtime');
  write(home, '.harness-lock.json', JSON.stringify({ package: 'unrelated', files: [stale] }));
  installHarnessBin(pkg, home, {}, () => {});
  assert.equal(fs.readFileSync(path.join(home, stale), 'utf8'), 'old runtime');
}));

test('runtime install keeps only the D2 build the renderer loads', () => fixture(root => {
  const pkg = fileURLToPath(new URL('..', import.meta.url));
  const { files } = installHarnessBin(pkg, path.join(root, 'home'), { dryRun: true }, () => {});
  const d2 = files.filter(rel => rel.startsWith('.ae-bin/node_modules/@d2lang/d2/'));
  assert.ok(d2.includes('.ae-bin/node_modules/@d2lang/d2/dist/node-esm/d2.wasm'));
  assert.ok(d2.includes('.ae-bin/node_modules/@d2lang/d2/package.json'));
  assert.deepEqual(d2.filter(rel => /\/dist\/(?:node-cjs|browser)\//.test(rel)), []);
}));
