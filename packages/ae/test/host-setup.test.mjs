import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runHostSetup } from '../lib/hosts/setup.mjs';
import { createHostSkill } from '../lib/hosts/personal-skill.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture(t, host = 'claude-code') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-host-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { host, packageRoot, home: path.join(root, 'state'), configHome: path.join(root, 'config'), skillsHome: path.join(root, 'skills') };
  return { root, options, run: (verb, extra = {}) => runHostSetup({ ...options, verb, ...extra }) };
}

function snapshotFixture(t, host = 'terminal') {
  const f = fixture(t, host);
  f.options.packageRoot = path.join(f.root, 'package');
  const corpus = path.join(f.options.packageRoot, 'corpus');
  fs.mkdirSync(path.join(corpus, 'skills/probe'), { recursive: true });
  fs.writeFileSync(path.join(f.options.packageRoot, 'package.json'), '{"version":"1.0.0"}\n');
  fs.writeFileSync(path.join(corpus, 'copilot-instructions.md'), '# Shared fixture\n');
  fs.writeFileSync(path.join(corpus, 'skills/probe/SKILL.md'), '---\nname: probe\ndescription: Probe the fixture.\n---\n\n# Probe\n');
  fs.writeFileSync(path.join(corpus, 'skills/probe/retired.md'), 'Retired fixture.\n');
  return f;
}

function afterInitialObservation(target, edit, action) {
  const open = fs.openSync, close = fs.closeSync, exists = fs.existsSync;
  const descriptors = new Set();
  let edited = false;
  const inject = () => { edited = true; edit(); };
  fs.openSync = function(full, ...args) {
    const fd = open.call(this, full, ...args);
    if (!edited && path.resolve(String(full)) === target) descriptors.add(fd);
    return fd;
  };
  fs.closeSync = function(fd) {
    const matched = descriptors.delete(fd);
    const result = close.call(this, fd);
    if (matched && !edited) inject();
    return result;
  };
  fs.existsSync = function(full) {
    const result = exists.call(this, full);
    if (!edited && full === target && !result) inject();
    return result;
  };
  let result;
  try { result = action(); }
  finally { fs.openSync = open; fs.closeSync = close; fs.existsSync = exists; }
  assert.equal(edited, true, 'the edit must follow the original read or absence observation');
  return result;
}

function assertPlanningEditPreserved(f, target, editedBytes, verb) {
  const witnesses = [path.join(f.options.configHome, '.ae-host.json'), path.join(f.options.skillsHome, '.ae-host-skills.json'), path.join(f.options.configHome, 'copilot-instructions.md')]
    .filter(full => full !== target)
    .map(full => [full, fs.existsSync(full) ? fs.readFileSync(full) : null]);
  const result = afterInitialObservation(target, () => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, editedBytes);
  }, () => f.run(verb));
  assert.equal(result.status, 'failed', JSON.stringify(result));
  assert.match(result.reason, /changed during setup/);
  assert.deepEqual(fs.readFileSync(target), Buffer.from(editedBytes));
  for (const [full, previous] of witnesses) {
    assert.deepEqual(fs.existsSync(full) ? fs.readFileSync(full) : null, previous, full);
  }
  assert.equal(fs.existsSync(path.join(f.options.configHome, '.ae-host.lock')), false);
  assert.equal(fs.existsSync(path.join(f.options.skillsHome, '.ae-host-skills.lock')), false);
}

test('list, absent status, and setup dry-run create no directories', t => {
  const f = fixture(t);
  assert.equal(runHostSetup({ verb: 'list' }).exitCode, 0);
  assert.equal(f.run('status').configured, false);
  const dry = f.run('setup', { dryRun: true });
  assert.equal(dry.exitCode, 0, JSON.stringify(dry));
  assert.ok(dry.actions.length > 0);
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('setup is idempotent, merges native groups, and removes only owned assets', t => {
  const f = fixture(t);
  fs.mkdirSync(f.options.configHome);
  const settings = path.join(f.options.configHome, 'settings.json');
  const userGroup = { matcher: 'Read', hooks: [{ type: 'command', command: 'user-owned-command' }] };
  fs.writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { PreToolUse: [userGroup] } }));
  fs.mkdirSync(path.join(f.options.home, 'projects'), { recursive: true });
  const state = path.join(f.options.home, 'projects/retained.txt');
  fs.writeFileSync(state, 'retained');
  const setup = f.run('setup');
  assert.equal(setup.exitCode, 0, JSON.stringify(setup));
  assert.equal(setup.configured, true);
  assert.equal(setup.nativeQualification, 'unverified');
  assert.ok(fs.existsSync(path.join(f.options.skillsHome, 'engineer/SKILL.md')));
  const first = fs.readFileSync(settings, 'utf8');
  const again = f.run('setup');
  assert.equal(again.exitCode, 0, JSON.stringify(again));
  assert.equal(fs.readFileSync(settings, 'utf8'), first);
  assert.equal(f.run('status').assetState, 'current');
  assert.equal(f.run('remove').exitCode, 0);
  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(after.permissions, { allow: ['Read'] });
  assert.deepEqual(after.hooks.PreToolUse, [userGroup]);
  assert.equal(fs.existsSync(path.join(f.options.skillsHome, 'engineer/SKILL.md')), false);
  assert.equal(fs.readFileSync(state, 'utf8'), 'retained');
  assert.equal(f.run('status').configured, false);
});

test('unowned collisions refuse the whole setup before any generated publication', t => {
  const f = fixture(t);
  const target = path.join(f.options.configHome, 'agents/engineer.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'personal engineer\n');
  const result = f.run('setup');
  assert.equal(result.status, 'conflict');
  assert.ok(result.conflicts.includes(target));
  assert.equal(fs.readFileSync(target, 'utf8'), 'personal engineer\n');
  assert.equal(fs.existsSync(f.options.skillsHome), false);
  assert.equal(fs.existsSync(path.join(f.options.configHome, '.ae-host.json')), false);
});

test('edited generated files are refused on update and preserved on removal', t => {
  const f = fixture(t);
  assert.equal(f.run('setup').exitCode, 0);
  const target = path.join(f.options.skillsHome, 'engineer/SKILL.md');
  fs.writeFileSync(target, 'personalized contract\n');
  assert.equal(f.run('status').assetState, 'changed');
  assert.equal(f.run('setup').status, 'conflict');
  const removed = f.run('remove');
  assert.equal(removed.exitCode, 0, JSON.stringify(removed));
  assert.ok(removed.preserved.includes(target));
  assert.equal(fs.readFileSync(target, 'utf8'), 'personalized contract\n');
});

test('a second host cannot claim another integration skills root', t => {
  const f = fixture(t);
  assert.equal(f.run('setup').exitCode, 0);
  const second = path.join(f.root, 'codex');
  const result = f.run('setup', { host: 'codex', configHome: second });
  assert.equal(result.status, 'conflict');
  assert.equal(fs.existsSync(second), false);
});

test('modified native groups survive removal while unrelated fields remain intact', t => {
  const f = fixture(t, 'cursor');
  assert.equal(f.run('setup').exitCode, 0);
  const filename = path.join(f.options.configHome, 'hooks.json');
  const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
  data.user = 'retained';
  const group = data.hooks.preToolUse[0];
  group.command += ' --user-edit';
  fs.writeFileSync(filename, JSON.stringify(data));
  const removed = f.run('remove');
  assert.equal(removed.exitCode, 0, JSON.stringify(removed));
  const after = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(after.user, 'retained');
  assert.deepEqual(after.hooks.preToolUse, [group]);
});

test('redirection and malformed ownership records fail closed', t => {
  const f = fixture(t);
  fs.mkdirSync(f.options.configHome);
  fs.writeFileSync(path.join(f.options.configHome, '.ae-host.json'), '{"schema":999}');
  assert.equal(f.run('setup').status, 'failed');
  fs.unlinkSync(path.join(f.options.configHome, '.ae-host.json'));
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  try { fs.symlinkSync(outside, f.options.skillsHome, 'dir'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows symlink privileges unavailable'); throw error; }
  assert.equal(f.run('setup').status, 'failed');
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('terminal installation has no native hook configuration', t => {
  const f = fixture(t, 'terminal');
  const result = f.run('setup');
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.capabilities.nativeHooks, false);
  assert.equal(fs.existsSync(path.join(f.options.configHome, 'hooks.json')), false);
  assert.equal(f.run('remove').exitCode, 0);
});

test('a publication failure rolls back generated assets and preserves original configuration', t => {
  const f = fixture(t);
  fs.mkdirSync(f.options.configHome);
  const settings = path.join(f.options.configHome, 'settings.json');
  const original = '{ "personal": true }\n';
  fs.writeFileSync(settings, original);
  const rename = fs.renameSync;
  fs.renameSync = function(source, target) {
    if (target === path.join(f.options.skillsHome, 'engineer/SKILL.md')) throw Object.assign(new Error('Injected publication failure'), { code: 'EIO' });
    return rename.call(this, source, target);
  };
  let result;
  try { result = f.run('setup'); } finally { fs.renameSync = rename; }
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /Injected publication failure/);
  assert.equal(fs.readFileSync(settings, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(f.options.configHome, 'agents/engineer.md')), false);
  assert.equal(fs.existsSync(path.join(f.options.configHome, '.ae-host.json')), false);
  assert.equal(fs.existsSync(path.join(f.options.configHome, '.ae-host.lock')), false);
});

test('upgrade updates unchanged generated content and removes only unchanged retired assets', t => {
  const f = fixture(t);
  const source = path.join(f.root, 'package');
  fs.mkdirSync(source);
  fs.cpSync(path.join(packageRoot, 'corpus'), path.join(source, 'corpus'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), '{"version":"1.0.0"}\n');
  const shared = path.join(source, 'corpus/skills/engineer/references/contract.md');
  const retired = path.join(source, 'corpus/skills/engineer/references/retired-fixture.md');
  fs.writeFileSync(retired, 'old fixture\n');
  assert.equal(f.run('setup', { packageRoot: source }).exitCode, 0);
  fs.appendFileSync(shared, '\nAccepted upgrade fixture.\n');
  fs.unlinkSync(retired);
  fs.writeFileSync(path.join(source, 'package.json'), '{"version":"1.1.0"}\n');
  const result = f.run('setup', { packageRoot: source });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(fs.readFileSync(path.join(f.options.skillsHome, 'engineer/references/contract.md'), 'utf8'), /Accepted upgrade fixture/);
  assert.equal(fs.existsSync(path.join(f.options.skillsHome, 'engineer/references/retired-fixture.md')), false);
  assert.equal(f.run('status', { packageRoot: source }).assetState, 'current');
});

test('settings changed by an editor during asset publication survive and trigger rollback', t => {
  const f = fixture(t);
  fs.mkdirSync(f.options.configHome);
  const settings = path.join(f.options.configHome, 'settings.json');
  fs.writeFileSync(settings, '{"personal":"before"}\n');
  const rename = fs.renameSync;
  let edited = false;
  fs.renameSync = function(source, target) {
    const result = rename.call(this, source, target);
    if (!edited && target !== settings) {
      edited = true;
      fs.writeFileSync(settings, '{"personal":"concurrent edit"}\n');
    }
    return result;
  };
  let result;
  try { result = f.run('setup'); } finally { fs.renameSync = rename; }
  assert.equal(edited, true);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /changed during setup/);
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).personal, 'concurrent edit');
  assert.equal(fs.existsSync(path.join(f.options.configHome, '.ae-host.json')), false);
  assert.equal(fs.existsSync(path.join(f.options.configHome, 'agents/engineer.md')), false);
});

test('asset planning retains the bytes used to authorize create, update and removal', async t => {
  for (const scenario of ['upgrade', 'retirement', 'removal', 'new unowned file']) {
    await t.test(scenario, t => {
      const f = snapshotFixture(t);
      if (scenario !== 'new unowned file') assert.equal(f.run('setup').exitCode, 0);
      const relative = scenario === 'retirement' ? 'probe/retired.md' : 'probe/SKILL.md';
      if (scenario === 'upgrade') fs.appendFileSync(path.join(f.options.packageRoot, 'corpus/skills', relative), '\nAccepted upgrade.\n');
      if (scenario === 'retirement') fs.unlinkSync(path.join(f.options.packageRoot, 'corpus/skills', relative));
      assertPlanningEditPreserved(f, path.join(f.options.skillsHome, relative), 'Concurrent personal asset.\n', scenario === 'removal' ? 'remove' : 'setup');
    });
  }
});

test('native settings planning retains the document used to merge or remove hooks', async t => {
  for (const verb of ['setup', 'remove']) {
    await t.test(verb, t => {
      const f = snapshotFixture(t, 'claude-code');
      assert.equal(f.run('setup').exitCode, 0);
      const target = path.join(f.options.configHome, 'settings.json');
      const edited = JSON.stringify({ ...JSON.parse(fs.readFileSync(target, 'utf8')), personal: 'Concurrent setting' });
      assertPlanningEditPreserved(f, target, edited, verb);
    });
  }
});

test('ownership snapshots remain dependencies even when setup would not rewrite them', async t => {
  for (const record of ['manifest', 'skills owner']) {
    for (const verb of ['setup', 'remove']) {
      await t.test(`${record} ${verb}`, t => {
        const f = snapshotFixture(t);
        assert.equal(f.run('setup').exitCode, 0);
        const target = record === 'manifest' ? path.join(f.options.configHome, '.ae-host.json') : path.join(f.options.skillsHome, '.ae-host-skills.json');
        const previous = JSON.parse(fs.readFileSync(target, 'utf8'));
        const edit = record === 'manifest' ? { concurrentMarker: true } : { host: 'codex', configHome: path.join(f.root, 'other-config') };
        assertPlanningEditPreserved(f, target, JSON.stringify({ ...previous, ...edit }), verb);
      });
    }
  }
});

test('unchanged ownership dependencies are checked after publication and preserve edits during rollback', async t => {
  for (const record of ['manifest', 'skills owner']) {
    await t.test(record, t => {
      const f = snapshotFixture(t, 'claude-code');
      assert.equal(f.run('setup').exitCode, 0);
      const settings = path.join(f.options.configHome, 'settings.json');
      const originalSettings = JSON.stringify(JSON.parse(fs.readFileSync(settings, 'utf8')));
      fs.writeFileSync(settings, originalSettings);
      const target = record === 'manifest' ? path.join(f.options.configHome, '.ae-host.json') : path.join(f.options.skillsHome, '.ae-host-skills.json');
      const editedBytes = JSON.stringify({ ...JSON.parse(fs.readFileSync(target, 'utf8')), concurrentMarker: true });
      const rename = fs.renameSync;
      let edited = false;
      fs.renameSync = function(source, destination) {
        const result = rename.call(this, source, destination);
        if (!edited && destination === settings) {
          edited = true;
          fs.writeFileSync(target, editedBytes);
        }
        return result;
      };
      let result;
      try { result = f.run('setup'); }
      finally { fs.renameSync = rename; }
      assert.equal(edited, true);
      assert.equal(result.status, 'failed', JSON.stringify(result));
      assert.match(result.reason, /changed during setup/);
      assert.equal(fs.readFileSync(target, 'utf8'), editedBytes);
      assert.equal(fs.readFileSync(settings, 'utf8'), originalSettings);
    });
  }
});

test('a held skills boundary lock blocks another config root before ownership publication', t => {
  const f = fixture(t);
  const mkdir = fs.mkdirSync;
  let competing;
  const sharedLock = path.join(f.options.skillsHome, '.ae-host-skills.lock');
  fs.mkdirSync = function(target, ...args) {
    const result = mkdir.call(this, target, ...args);
    if (target === sharedLock && !competing) {
      competing = { pending: true };
      competing = f.run('setup', { host: 'codex', configHome: path.join(f.root, 'other-config') });
    }
    return result;
  };
  let result;
  try { result = f.run('setup'); } finally { fs.mkdirSync = mkdir; }
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(competing.status, 'failed');
  assert.match(competing.reason, /already locked/);
  assert.equal(fs.existsSync(path.join(f.root, 'other-config/.ae-host.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.options.skillsHome, '.ae-host-skills.json'), 'utf8')).host, 'claude-code');
});

function personalSkill(name, suffix = '') {
  return `---\nname: ${name}\ndescription: Investigate the personal fixture and explain its evidence.\n---\n\n# Personal fixture\n\n## Should trigger\n- Investigate my fixture failure.\n- Explain the fixture's evidence.\n- Diagnose the personal scenario.\n\n## Should not trigger\n- Plan an unrelated UI.\n- Publish a new release.\n- Change production policy.\n\n${suffix}`;
}

test('a personal skill is created in Codex split skills root and survives host removal', t => {
  const f = fixture(t, 'codex');
  assert.equal(f.run('setup').exitCode, 0);
  const result = createHostSkill({ ...f.options, name: 'personal-probe', input: { schema: 1, text: personalSkill('personal-probe') } });
  assert.equal(result.status, 'ok');
  assert.equal(result.activated, true);
  assert.equal(result.primitive.path, path.join(f.options.skillsHome, 'personal-probe/SKILL.md'));
  assert.match(result.primitive.digest, /^sha256-[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(f.options.configHome, 'skills/personal-probe/SKILL.md')), false);
  assert.equal(f.run('remove').exitCode, 0);
  assert.equal(fs.readFileSync(result.primitive.path, 'utf8'), personalSkill('personal-probe'));
});

test('personal skill replacement requires current expected bytes and dry-run writes nothing', t => {
  const f = fixture(t, 'codex');
  assert.equal(f.run('setup').exitCode, 0);
  const options = { ...f.options, name: 'personal-probe', input: { schema: 1, text: personalSkill('personal-probe') } };
  const preview = createHostSkill({ ...options, dryRun: true });
  assert.equal(preview.activated, false);
  assert.equal(fs.existsSync(path.join(f.options.skillsHome, 'personal-probe')), false);
  const first = createHostSkill(options);
  const changed = { ...options, input: { schema: 1, text: personalSkill('personal-probe', 'New accepted guidance.\n') } };
  assert.throws(() => createHostSkill(changed), /expectedDigest/);
  assert.throws(() => createHostSkill({ ...changed, input: { ...changed.input, expectedDigest: 'sha256-' + '0'.repeat(64) } }), /stale/);
  const second = createHostSkill({ ...changed, input: { ...changed.input, expectedDigest: first.primitive.digest } });
  assert.equal(second.activated, true);
  assert.notEqual(second.primitive.digest, first.primitive.digest);
  const repeated = createHostSkill({ ...changed, input: { ...changed.input, expectedDigest: second.primitive.digest } });
  assert.equal(repeated.activated, false);
});

test('personal skill creation refuses managed names, invalid content, redirected paths and absent binding', t => {
  const f = fixture(t, 'codex');
  const options = { ...f.options, name: 'personal-probe', input: { schema: 1, text: personalSkill('personal-probe') } };
  assert.throws(() => createHostSkill(options), /setup|binding/i);
  assert.equal(f.run('setup').exitCode, 0);
  assert.throws(() => createHostSkill({ ...options, name: 'engineer', input: { schema: 1, text: personalSkill('engineer') } }), /managed|shipped/i);
  assert.throws(() => createHostSkill({ ...options, input: { schema: 1, text: 'not a skill' } }), /frontmatter/i);
  assert.throws(() => createHostSkill({ ...options, name: '../outside' }), /name/i);
  const outside = path.join(f.root, 'outside-personal');
  fs.mkdirSync(outside);
  try { fs.symlinkSync(outside, path.join(f.options.skillsHome, 'personal-probe'), 'dir'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows symlink privileges unavailable'); throw error; }
  assert.throws(() => createHostSkill(options), /unsafe|redirect/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});
