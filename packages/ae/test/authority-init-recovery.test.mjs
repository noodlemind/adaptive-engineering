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
  const run = (cwd, args, input) => spawnSync(process.execPath, [bin, ...args, '--workspace', cwd, '--ae-home', home, '--copilot-home', copilotHome, '--json', '--no-events'], { cwd, env, input, encoding: 'utf8', timeout: 30000 });
  const cli = (cwd, ...args) => run(cwd, args);
  const input = (cwd, decision, ...args) => run(cwd, args, JSON.stringify(decision));
  const ok = (cwd, ...args) => {
    const result = cli(cwd, ...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  return { workspace, home, copilotHome, cli, input, ok, git };
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
    const metadata = () => ({ head: f.git('rev-parse', 'HEAD'), refs: f.git('for-each-ref', '--format=%(refname) %(objectname)'), exclude: fs.readFileSync(path.join(f.workspace, '.git/info/exclude'), 'utf8') });
    const before = { home: files(f.home), child: files(child), metadata: metadata() };
    const result = f.cli(child, 'init-repo', ...(dryRun ? ['--dry-run'] : []));
    assert.notEqual(result.status, 0, 'missing shared policy must not become implicit private authority');
    assert.match(result.stdout + result.stderr, /primary|shared authority|shared configuration/i);
    const refusal = JSON.parse(result.stderr || result.stdout).error;
    assert.equal(refusal.code, 'E_PROJECT_AUTHORITY');
    assert.ok(refusal.message.includes(fs.realpathSync.native(f.workspace)), refusal.message);
    assert.deepEqual({ home: files(f.home), child: files(child), metadata: metadata() }, before);
    assert.equal(resolveProjectAuthority(f.workspace, { home: f.home }).mode, 'shared');
  });
});

test('linked subfolder initialization preserves primary shared authority before migration', async t => {
  for (const dryRun of [false, true]) await t.test(dryRun ? 'dry-run' : 'initialize', t => {
    const f = fixture(t);
    f.ok(f.workspace, 'init-repo', '--shared');
    const child = f.ok(f.workspace, 'worktree', '--slug', 'nested').path;
    const nested = path.join(child, 'src');
    fs.mkdirSync(path.join(nested, 'docs/plans'), { recursive: true });
    fs.writeFileSync(path.join(nested, 'docs/plans/pending.md'), '# Preserve this legacy plan\n');
    const before = { home: files(f.home), child: files(child) };
    const result = f.cli(nested, 'init-repo', ...(dryRun ? ['--dry-run'] : []));
    assert.notEqual(result.status, 0, 'a subfolder must not bypass linked-primary authority selection');
    assert.match(result.stdout + result.stderr, /primary|shared authority|shared configuration/i);
    const refusal = JSON.parse(result.stderr || result.stdout).error;
    assert.equal(refusal.code, 'E_PROJECT_AUTHORITY');
    assert.ok(refusal.message.includes(fs.realpathSync.native(f.workspace)), refusal.message);
    assert.deepEqual({ home: files(f.home), child: files(child) }, before);
    assert.equal(resolveProjectAuthority(f.workspace, { home: f.home }).mode, 'shared');
  });
});

test('bounded check preparation cannot shadow missing linked-primary shared authority', async t => {
  for (const nested of [false, true]) for (const dryRun of [false, true]) {
    await t.test(`${nested ? 'subfolder' : 'checkout'} ${dryRun ? 'dry-run' : 'configure'}`, t => {
      const f = fixture(t);
      f.ok(f.workspace, 'init-repo', '--shared');
      const child = f.ok(f.workspace, 'worktree', '--slug', 'checks').path;
      const selected = nested ? path.join(child, 'src') : child;
      fs.mkdirSync(selected, { recursive: true });
      const before = { home: files(f.home), child: files(child) };
      const listed = f.cli(selected, 'checks', 'list');
      const decision = { schema: 1, expectedDigest: null, rationale: 'Prepare a behavioral command.', checks: { 'unit-tests': { command: [process.execPath, '--test', 'app.mjs'] } } };
      const configured = f.input(selected, decision, 'checks', 'configure', '--file', '-', ...(dryRun ? ['--dry-run'] : []));
      assert.notEqual(configured.status, 0, 'check preparation must not create competing local authority');
      assert.notEqual(listed.status, 0, 'inspection must diagnose missing primary policy instead of selecting a new local source');
      assert.match(configured.stdout + configured.stderr, /primary|shared authority|shared configuration/i);
      assert.deepEqual({ home: files(f.home), child: files(child) }, before);
      assert.equal(resolveProjectAuthority(f.workspace, { home: f.home }).mode, 'shared');
    });
  }
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

test('shared promotion previews defer check readiness until publication without inventing check repairs', async t => {
  for (const publication of ['partial', 'complete']) for (const state of ['ready', 'empty', 'invalid']) {
    await t.test(`${publication} publication with ${state} checks`, t => {
      const f = fixture(t);
      f.ok(f.workspace, 'init-repo');
      const local = resolveProjectAuthority(f.workspace, { home: f.home });
      const marker = path.join(f.workspace, 'check-ran.txt');
      const checks = state === 'empty' ? {} : { 'unit-tests': { command: state === 'invalid' ? [] : [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected execution')`] } };
      fs.writeFileSync(local.files['checks.yaml'], JSON.stringify({ version: 1, checks }));
      const shared = path.join(f.workspace, '.github/harness');
      fs.mkdirSync(shared, { recursive: true });
      for (const name of publication === 'partial' ? ['checks.yaml'] : ['checks.yaml', 'policy.yaml', 'routing.yaml']) {
        fs.copyFileSync(local.files[name], path.join(shared, name));
      }
      const before = { home: files(f.home), workspace: files(f.workspace) };
      const preview = f.ok(f.workspace, 'init-repo', '--shared', '--dry-run');
      assert.equal(preview.promotion.dryRun, true);
      assert.equal(preview.checkReadiness.status, 'deferred');
      assert.equal(preview.checkReadiness.ready, false);
      assert.equal(preview.checkReadiness.reason, 'authority-promotion-preview');
      assert.equal(preview.checkReadiness.sourceMode, 'shared');
      assert.match(preview.checkReadiness.message, /apply.*promotion.*inspect/i);
      assert.equal(preview.checkReadiness.remediation, null);
      assert.ok(!preview.prerequisites?.some(entry => entry.id === 'named-checks'));
      assert.doesNotMatch(JSON.stringify(preview), /checks configure|person.s trust approval/i);
      assert.deepEqual({ home: files(f.home), workspace: files(f.workspace) }, before);
      const applied = f.ok(f.workspace, 'init-repo', '--shared');
      assert.equal(applied.promotion.promoted, true);
      assert.equal(applied.checkReadiness.status, state);
      assert.equal(applied.checkReadiness.ready, state === 'ready');
      assert.equal(Boolean(applied.prerequisites?.some(entry => entry.id === 'named-checks')), state !== 'ready');
      assert.equal(fs.existsSync(marker), false);
      assert.equal(fs.existsSync(path.join(f.home, 'trust.yaml')), false);
    });
  }
});

test('shared dry-run without a pending promotion retains ordinary check inspection', t => {
  const f = fixture(t);
  f.ok(f.workspace, 'init-repo', '--shared');
  const shared = resolveProjectAuthority(f.workspace, { home: f.home });
  fs.writeFileSync(shared.files['checks.yaml'], JSON.stringify({ version: 1, checks: { 'unit-tests': { command: [process.execPath, '--test', 'app.mjs'] } } }));
  const before = { home: files(f.home), workspace: files(f.workspace) };
  const preview = f.ok(f.workspace, 'init-repo', '--shared', '--dry-run');
  assert.deepEqual(preview.promotion.files, []);
  assert.equal(preview.checkReadiness.status, 'ready');
  assert.equal(preview.checkReadiness.ready, true);
  assert.deepEqual({ home: files(f.home), workspace: files(f.workspace) }, before);
});

test('conflicting shared publication still refuses preview and recovery without moving source bytes', t => {
  for (const name of ['checks.yaml', 'policy.yaml']) {
    const f = fixture(t);
    f.ok(f.workspace, 'init-repo');
    const local = resolveProjectAuthority(f.workspace, { home: f.home });
    const shared = path.join(f.workspace, '.github/harness');
    fs.mkdirSync(shared, { recursive: true });
    fs.copyFileSync(local.files['checks.yaml'], path.join(shared, 'checks.yaml'));
    fs.writeFileSync(path.join(shared, name), name === 'checks.yaml' ? 'version: 1\nchecks: {}\n# conflicting source\n' : 'version: 1\nenforcement: warn\n');
    const before = { home: files(f.home), workspace: files(f.workspace) };
    for (const args of [['--shared', '--dry-run'], ['--shared']]) {
      const result = f.cli(f.workspace, 'init-repo', ...args);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /conflict|differs/i);
      assert.deepEqual({ home: files(f.home), workspace: files(f.workspace) }, before);
    }
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

test('an independent nested repository keeps its own authority boundary', t => {
  const f = fixture(t);
  f.ok(f.workspace, 'init-repo', '--shared');
  const child = f.ok(f.workspace, 'worktree', '--slug', 'outer').path;
  const nested = path.join(child, 'independent');
  fs.mkdirSync(nested);
  const initialized = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: nested, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  assert.equal(initialized.status, 0, initialized.stderr);
  const result = f.ok(nested, 'init-repo');
  assert.equal(result.authority.mode, 'local');
  assert.equal(resolveProjectAuthority(nested, { home: f.home }).mode, 'local');
  assert.equal(resolveProjectAuthority(f.workspace, { home: f.home }).mode, 'shared');
});

test('a linked branch keeps its own explicit shared policy instead of copying the primary policy', t => {
  const f = fixture(t);
  f.ok(f.workspace, 'init-repo', '--shared');
  f.git('add', '-f', '.github/harness'); f.git('commit', '-qm', 'shared authority');
  const child = f.ok(f.workspace, 'worktree', '--slug', 'release-policy').path;
  const primaryPolicy = fs.readFileSync(path.join(f.workspace, '.github/harness/policy.yaml'), 'utf8');
  const policy = path.join(child, '.github/harness/policy.yaml'), branchPolicy = 'version: 1\nenforcement: warn\n';
  fs.writeFileSync(policy, branchPolicy);
  const result = f.ok(child, 'init-repo');
  assert.equal(result.authority.mode, 'shared');
  assert.equal(fs.readFileSync(policy, 'utf8'), branchPolicy);
  assert.equal(fs.readFileSync(path.join(f.workspace, '.github/harness/policy.yaml'), 'utf8'), primaryPolicy);
  assert.equal(fs.existsSync(path.join(f.home, 'trust.yaml')), false);
});

test('shared preview refuses a redirected empty directory without a private source', t => {
  const f = fixture(t), outside = path.join(path.dirname(f.workspace), 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(f.workspace, '.github'));
  const shared = path.join(f.workspace, '.github/harness');
  fs.symlinkSync(outside, shared, process.platform === 'win32' ? 'junction' : 'dir');
  const result = f.cli(f.workspace, 'init-repo', '--shared', '--dry-run');
  assert.notEqual(result.status, 0, 'preview must preserve shared-directory validation without private authority');
  assert.match(result.stdout + result.stderr, /unsafe|symlink|nonregular/i);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(f.home), false);
  assert.equal(fs.lstatSync(shared).isSymbolicLink(), true);
});
