import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveProjectAuthority } from '../lib/project-authority.mjs';

const bin = fileURLToPath(new URL('../bin/ae.mjs', import.meta.url));

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-authority-init-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'state'), copilotHome = path.join(root, 'copilot');
  fs.mkdirSync(workspace);
  const env = { ...process.env, AE_HOME: home, HARNESS_HOME: home, COPILOT_HOME: copilotHome, HARNESS_NO_EVENTS: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'Authority fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Authority fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: workspace, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(workspace, '.gitignore'), '.github/harness/\n');
  fs.writeFileSync(path.join(workspace, 'app.mjs'), 'export const value = 1;\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  const cli = (cwd, ...args) => spawnSync(process.execPath, [bin, ...args, '--workspace', cwd, '--ae-home', home, '--copilot-home', copilotHome, '--json', '--no-events'], { cwd, env, encoding: 'utf8', timeout: 30000 });
  const ok = (cwd, ...args) => {
    const result = cli(cwd, ...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  return { workspace, home, copilotHome, cli, ok, git };
}

function files(root) {
  if (!fs.existsSync(root)) return {};
  const result = {};
  const walk = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const rel = path.join(relative, entry.name), full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else result[rel] = fs.readFileSync(full).toString('base64');
    }
  };
  walk(root);
  return result;
}

test('linked initialization cannot hide primary shared authority behind new private policy', async t => {
  for (const dryRun of [false, true]) await t.test(dryRun ? 'dry-run' : 'initialize', t => {
    const f = fixture(t);
    f.ok(f.workspace, 'init-repo', '--shared');
    const child = f.ok(f.workspace, 'worktree', '--slug', 'fix').path;
    assert.equal(fs.existsSync(path.join(child, '.github/harness')), false);
    const legacy = path.join(child, 'docs/plans/pending.md');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, '# Preserve pending legacy plan\n');
    const before = { home: files(f.home), child: files(child) };
    const result = f.cli(child, 'init-repo', ...(dryRun ? ['--dry-run'] : []));
    assert.notEqual(result.status, 0, 'missing shared policy must not become implicit private authority');
    assert.match(result.stdout + result.stderr, /primary|shared authority|shared configuration/i);
    assert.ok((result.stdout + result.stderr).includes(f.workspace));
    assert.deepEqual({ home: files(f.home), child: files(child) }, before);
    assert.equal(resolveProjectAuthority(f.workspace, { home: f.home }).mode, 'shared');
  });
});

test('matching interrupted shared publication previews and recovers through the CLI without approving trust', t => {
  const f = fixture(t);
  f.ok(f.workspace, 'init-repo');
  const local = resolveProjectAuthority(f.workspace, { home: f.home });
  const shared = path.join(f.workspace, '.github/harness');
  fs.mkdirSync(shared, { recursive: true });
  fs.copyFileSync(local.files['checks.yaml'], path.join(shared, 'checks.yaml'));
  const before = { home: files(f.home), workspace: files(f.workspace) };
  const preview = f.cli(f.workspace, 'init-repo', '--shared', '--dry-run');
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  const result = JSON.parse(preview.stdout);
  assert.equal(result.authority.mode, 'shared');
  assert.equal(result.promotion.dryRun, true);
  assert.deepEqual(result.authority.files, ['policy.yaml', 'checks.yaml', 'routing.yaml'].map(name => `.github/harness/${name}`));
  assert.deepEqual({ home: files(f.home), workspace: files(f.workspace) }, before);
  const recovered = f.ok(f.workspace, 'init-repo', '--shared');
  assert.equal(recovered.promotion.promoted, true);
  assert.equal(fs.existsSync(path.join(recovered.promotion.backup, 'checks.yaml')), true);
  assert.equal(resolveProjectAuthority(f.workspace, { home: f.home }).mode, 'shared');
  assert.equal(fs.existsSync(path.join(f.home, 'trust.yaml')), false);
});

test('conflicting shared publication still refuses preview and recovery without moving source bytes', t => {
  const f = fixture(t);
  f.ok(f.workspace, 'init-repo');
  const shared = path.join(f.workspace, '.github/harness');
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, 'checks.yaml'), 'version: 1\nchecks: {}\n# conflicting source\n');
  const before = { home: files(f.home), workspace: files(f.workspace) };
  for (const args of [['--shared', '--dry-run'], ['--shared']]) {
    const result = f.cli(f.workspace, 'init-repo', ...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /conflict|differs/i);
    assert.deepEqual({ home: files(f.home), workspace: files(f.workspace) }, before);
  }
});

test('ordinary linked private setup still shares its existing primary authority', t => {
  const f = fixture(t);
  f.ok(f.workspace, 'init-repo');
  const local = resolveProjectAuthority(f.workspace, { home: f.home });
  const child = f.ok(f.workspace, 'worktree', '--slug', 'personal').path;
  const result = f.ok(child, 'init-repo');
  assert.equal(result.authority.mode, 'local');
  assert.equal(result.authority.directory, local.directory);
  assert.equal(fs.existsSync(path.join(child, '.github/harness')), false);
});
