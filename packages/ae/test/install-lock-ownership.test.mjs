import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir, runHarness } from './helpers/index.mjs';
import { readLock } from '../lib/lock.mjs';

const linked = { skip: process.platform === 'win32' ? 'symlink creation needs Windows privilege' : false };
const retired = 'prompts/personal.prompt.md';
function write(root, rel, body) {
  const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return file;
}
function fixture(t, sameHome = false) {
  const root = tempDir('install-lock-ownership-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const copilot = path.join(root, 'copilot'), intellij = sameHome ? copilot : path.join(root, 'intellij');
  fs.mkdirSync(copilot); if (!sameHome) fs.mkdirSync(intellij);
  const invoke = (...args) => runHarness([...args, '--copilot-home', copilot, '--workspace', root,
    '--ae-home', path.join(root, 'state'), '--no-events', '--json'], { trust: false, env: { AE_INTELLIJ_HOME: intellij } });
  return { root, copilot, intellij, invoke };
}
function okay(r) { assert.equal(r.status, 0, r.stderr + r.stdout); return JSON.parse(r.stdout); }

test('a linked install lock is refused before corpus or runtime publication, including dry run', linked, t => {
  const f = fixture(t), outside = write(f.root, 'outside.json', '{"marker":"keep"}');
  fs.symlinkSync(outside, path.join(f.copilot, '.harness-lock.json'));
  for (const extra of [[], ['--dry-run']]) {
    const r = f.invoke('install', '--target', 'cli', ...extra);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /lock.*(?:unsafe|symlink)|(?:unsafe|symlink).*lock/i);
    assert.equal(fs.readFileSync(outside, 'utf8'), '{"marker":"keep"}');
    assert.equal(fs.existsSync(path.join(f.copilot, 'skills')), false);
    assert.equal(fs.existsSync(path.join(f.copilot, '.ae-bin')), false);
    assert.equal(readLock(f.copilot), null, 'diagnostic reads do not follow an unsafe ownership record');
  }
});

test('all selected target locks are preflighted before writing the first home', linked, t => {
  const f = fixture(t), outside = write(f.root, 'outside.json', '{"marker":"keep"}');
  fs.symlinkSync(outside, path.join(f.intellij, '.harness-lock.json'));
  const r = f.invoke('install', '--target', 'cli,intellij');
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(outside, 'utf8'), '{"marker":"keep"}');
  assert.equal(fs.existsSync(path.join(f.copilot, 'skills')), false);
  assert.equal(fs.existsSync(path.join(f.copilot, '.ae-bin')), false);
});

test('a linked target home is refused before changing another selected home', linked, t => {
  const f = fixture(t), outside = path.join(f.root, 'outside-home');
  fs.mkdirSync(outside); fs.rmdirSync(f.intellij); fs.symlinkSync(outside, f.intellij, 'dir');
  const r = f.invoke('install', '--target', 'cli,intellij');
  assert.notEqual(r.status, 0);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(fs.readdirSync(f.copilot), []);
});

test('physical-home deduplication does not bypass preflight of a selected symlink root', linked, t => {
  const f = fixture(t);
  fs.rmdirSync(f.intellij); fs.symlinkSync(f.copilot, f.intellij, 'dir');
  const r = f.invoke('install', '--target', 'cli,intellij');
  assert.notEqual(r.status, 0);
  assert.deepEqual(fs.readdirSync(f.copilot), []);
});

test('a corrupt install lock remains observable and is preserved before any upgrade writes', t => {
  const f = fixture(t), file = write(f.copilot, '.harness-lock.json', '{broken');
  const r = f.invoke('upgrade', '--target', 'cli');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /lock.*(?:invalid|unreadable|corrupt)/i);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  assert.equal(fs.existsSync(path.join(f.copilot, 'skills')), false);
});

test('a Copilot ownership ledger cannot retire personal IntelliJ files', t => {
  const f = fixture(t);
  write(f.copilot, '.harness-lock.json', JSON.stringify({ package: 'ae-harness', targets: ['vscode'], files: [retired] }));
  const personal = write(f.intellij, retired, 'unowned IntelliJ customization');
  const before = fs.readFileSync(path.join(f.copilot, '.harness-lock.json'));
  okay(f.invoke('upgrade', '--target', 'intellij'));
  assert.equal(fs.readFileSync(personal, 'utf8'), 'unowned IntelliJ customization');
  assert.deepEqual(fs.readFileSync(path.join(f.copilot, '.harness-lock.json')), before, 'an unselected home is not relabelled');
  const own = readLock(f.intellij);
  assert.deepEqual(own.targets, ['intellij']);
  assert.ok(own.files.includes('global-copilot-instructions.md'));
  assert.equal(own.files.includes(retired), false);
  assert.equal(own.installationRoot, fs.realpathSync.native(f.intellij));
});

test('each target retires only its own prior managed leaves and repeated upgrades preserve personal siblings', t => {
  const f = fixture(t);
  okay(f.invoke('install', '--target', 'cli,intellij'));
  for (const [home, target] of [[f.copilot, 'cli'], [f.intellij, 'intellij']]) {
    const lock = readLock(home);
    assert.deepEqual(lock.targets, [target]);
    lock.files.push(retired); write(home, retired, 'old managed customization');
    write(home, '.harness-lock.json', JSON.stringify(lock));
    write(home, 'prompts/personal-sibling.md', 'keep personal sibling');
  }
  okay(f.invoke('upgrade', '--target', 'intellij'));
  assert.equal(fs.existsSync(path.join(f.intellij, retired)), false);
  assert.equal(fs.existsSync(path.join(f.copilot, retired)), true);
  assert.equal(fs.readFileSync(path.join(f.intellij, 'prompts/personal-sibling.md'), 'utf8'), 'keep personal sibling');
  okay(f.invoke('upgrade', '--target', 'cli'));
  assert.equal(fs.existsSync(path.join(f.copilot, retired)), false);
  assert.equal(fs.readFileSync(path.join(f.copilot, 'prompts/personal-sibling.md'), 'utf8'), 'keep personal sibling');
  okay(f.invoke('upgrade', '--target', 'cli,intellij'));
  assert.deepEqual(readLock(f.copilot).targets, ['cli']);
  assert.deepEqual(readLock(f.intellij).targets, ['intellij']);
});

test('legacy aggregate ownership cannot authorize ambiguous retirement during migration', t => {
  const f = fixture(t);
  write(f.copilot, '.harness-lock.json', JSON.stringify({ package: 'harness', targets: ['vscode', 'intellij'], files: [retired] }));
  const personal = write(f.copilot, retired, 'ambiguous legacy file');
  const migrated = okay(f.invoke('upgrade', '--target', 'cli'));
  assert.equal(fs.readFileSync(personal, 'utf8'), 'ambiguous legacy file');
  assert.match(migrated.ownershipWarnings.join(' '), /preserved legacy files.*unproven target-home ownership/);
  const next = readLock(f.copilot);
  assert.equal(next.files.includes(retired), false, 'unproven aggregate leaves do not become new deletion authority');
  assert.ok(next.targets.includes('vscode'));
  assert.equal(next.targets.includes('intellij'), false);
});

test('one physical home can intentionally serve multiple targets without ledger loss', t => {
  const f = fixture(t, true);
  okay(f.invoke('install', '--target', 'cli,intellij'));
  let lock = readLock(f.copilot);
  assert.deepEqual(lock.targets, ['cli', 'intellij']);
  assert.ok(lock.files.includes('.ae-bin/bin/ae.mjs'));
  assert.ok(lock.files.includes('global-copilot-instructions.md'));
  okay(f.invoke('upgrade', '--target', 'cli'));
  lock = readLock(f.copilot);
  assert.deepEqual(lock.targets, ['cli', 'intellij']);
  assert.ok(lock.files.includes('global-copilot-instructions.md'));
  assert.equal(fs.existsSync(path.join(f.copilot, 'global-copilot-instructions.md')), true);
});

test('aliases through an existing parent still name one physical installation home', linked, t => {
  const f = fixture(t), alias = path.join(f.root, 'parent-alias');
  fs.rmdirSync(f.copilot);
  fs.symlinkSync(f.root, alias, 'dir');
  const r = runHarness(['install', '--target', 'cli,intellij', '--copilot-home', f.copilot, '--workspace', f.root,
    '--ae-home', path.join(f.root, 'state'), '--no-events', '--json'], {
    trust: false, env: { AE_INTELLIJ_HOME: path.join(alias, 'copilot') },
  });
  okay(r);
  assert.deepEqual(readLock(f.copilot).targets, ['cli', 'intellij']);
  okay(f.invoke('upgrade', '--target', 'cli'));
  assert.deepEqual(readLock(f.copilot).targets, ['cli', 'intellij']);
});

test('a copied bound ledger cannot grant ownership in another selected home', t => {
  const f = fixture(t);
  okay(f.invoke('install', '--target', 'cli'));
  fs.copyFileSync(path.join(f.copilot, '.harness-lock.json'), path.join(f.intellij, '.harness-lock.json'));
  const personal = write(f.intellij, retired, 'unowned copied-ledger sibling');
  const r = f.invoke('upgrade', '--target', 'intellij');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /lock.*(?:home|root|destination)/i);
  assert.equal(fs.readFileSync(personal, 'utf8'), 'unowned copied-ledger sibling');
  assert.equal(fs.existsSync(path.join(f.intellij, 'skills')), false);
});

test('installation inventory with nested state grants no product discovery consent', t => {
  const f = fixture(t);
  const result = okay(f.invoke('install', '--target', 'cli'));
  assert.equal(result.discovery.configured, false);
  const state = path.join(f.root, 'state');
  assert.equal(fs.existsSync(path.join(state, 'capabilities')), false, 'read-only onboarding must not create policy or cache state');
  const input = write(f.root, 'discovery.json', JSON.stringify({ schema: 1, operation: 'configure', roots: [{ path: f.copilot, included: true, host: 'copilot' }], ongoing: false, autoIncludeNew: false }));
  const denied = f.invoke('resources', 'discover', '--file', input);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr + denied.stdout, /AE home must be outside the product workspace/);
  assert.equal(fs.existsSync(path.join(state, 'capabilities')), false);
});
