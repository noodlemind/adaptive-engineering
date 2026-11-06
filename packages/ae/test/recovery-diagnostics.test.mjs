import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { tempDir } from './helpers/temp.mjs';
import { initGit, writeChecks } from './helpers/cli-fixtures.mjs';
import { recoveryDiagnostics } from '../lib/diagnostics.mjs';
import { runDoctor } from '../lib/doctor.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/ae.mjs');

function fixture(t) {
  const root = tempDir('recovery-diagnostics-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product with spaces');
  const home = path.join(root, 'state');
  const copilot = path.join(root, 'copilot');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'README.md'), 'Disposable product.\n');
  initGit(workspace);
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [bin, ...args, '--workspace', workspace, '--ae-home', home, '--copilot-home', copilot, '--json'], { cwd: workspace, encoding: 'utf8', timeout: 30_000 });
    assert.ifError(result.error);
    return { ...result, value: JSON.parse(result.stdout) };
  };
  return { root, workspace, home, copilot, cli };
}

test('a missing plan yields scoped inspection guidance without changing gate authority', t => {
  const f = fixture(t);
  const result = f.cli('gate', '--phase', 'implement');
  assert.equal(result.status, 1);
  assert.equal(result.value.pass, false);
  assert.equal(result.value.checks.find(check => check.id === 'C1').pass, false);
  assert.equal(result.value.diagnostics.schema, 1);
  const failure = result.value.diagnostics.failures.find(item => item.checkId === 'C1');
  assert.equal(failure.category, 'plan');
  assert.equal(failure.severity, 'blocking');
  assert.deepEqual(failure.retry, { automatic: false, when: 'after-action' });
  assert.deepEqual(failure.nextActions[0], { kind: 'command', argv: ['ae', 'orient', '--read', '--context-version', '2', '--workspace', f.workspace, '--copilot-home', f.copilot, '--ae-home', f.home] });
  assert.deepEqual(failure.evidence, { checkId: 'C1', plan: null });
  assert.equal(fs.existsSync(f.copilot), false, 'guidance must not install anything');
});

test('doctor distinguishes installation failures from optional readiness observations', t => {
  const f = fixture(t);
  const result = f.cli('doctor');
  assert.equal(result.value.pass, false);
  const failures = result.value.diagnostics.failures;
  const profile = failures.find(item => item.checkId === 'H2');
  assert.equal(profile.category, 'installation');
  assert.equal(profile.severity, 'blocking');
  assert.deepEqual(profile.nextActions[0].argv, ['ae', 'install', '--target', 'cli', '--workspace', f.workspace, '--copilot-home', f.copilot, '--ae-home', f.home]);
  const pathFailure = failures.find(item => item.checkId === 'H16');
  if (pathFailure) assert.equal(pathFailure.severity, 'advisory');
  assert.equal(fs.existsSync(f.copilot), false);
});

test('a missing package corpus recommends reinstalling the CLI rather than running its broken installer', async t => {
  const f = fixture(t);
  const result = await runDoctor({
    copilotHome: f.copilot,
    assetsRoot: path.join(f.root, 'missing-corpus'),
    pkgRoot: path.resolve(import.meta.dirname, '..'),
    flags: { workspace: f.workspace, harnessHome: f.home },
  });
  assert.equal(result.checks.find(check => check.id === 'H8').pass, false);
  const failure = result.diagnostics.failures.find(item => item.checkId === 'H8');
  assert.equal(failure.category, 'installation');
  assert.ok(failure.nextActions.every(action => action.kind === 'guidance'));
  assert.ok(failure.nextActions.some(action => /reinstall.*packaged CLI/i.test(action.text)));
  assert.deepEqual(failure.retry, { automatic: false, when: 'after-inspection' });
  assert.equal(fs.existsSync(f.copilot), false);
});

for (const checkId of ['H2', 'H9']) {
  test(`${checkId} repair hydrates only the selected home and preserves other editor installations`, t => {
    const f = fixture(t);
    const failure = f.cli('doctor').value.diagnostics.failures.find(item => item.checkId === checkId);
    const userHome = path.join(f.root, 'simulated-user');
    const appData = path.join(userHome, 'AppData', 'Roaming');
    const localAppData = path.join(userHome, 'AppData', 'Local');
    const extensions = path.join(userHome, '.vscode', 'extensions');
    const bridge = path.join(extensions, 'ae-copilot-bridge');
    const intellij = process.platform === 'win32'
      ? path.join(localAppData, 'github-copilot', 'intellij')
      : process.platform === 'darwin'
        ? path.join(userHome, 'Library', 'Application Support', 'github-copilot', 'intellij')
        : path.join(userHome, '.local', 'share', 'github-copilot', 'intellij');
    fs.mkdirSync(bridge, { recursive: true });
    fs.writeFileSync(path.join(bridge, 'package.json'), JSON.stringify({ publisher: 'harness', name: 'ae-copilot-bridge', version: '0.0.0' }));
    fs.writeFileSync(path.join(bridge, 'extension.cjs'), 'Existing editor bridge.\n');
    fs.mkdirSync(path.join(intellij, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(intellij, 'agents', 'engineer.agent.md'), 'Existing IntelliJ engineer.\n');
    const env = { ...process.env, HOME: userHome, USERPROFILE: userHome, APPDATA: appData, LOCALAPPDATA: localAppData, AE_VSCODE_EXTENSIONS_DIR: extensions, HARNESS_VSCODE_EXTENSIONS_DIR: extensions };
    const repaired = spawnSync(process.execPath, [bin, ...failure.nextActions[0].argv.slice(1), '--json'], { cwd: f.workspace, env, encoding: 'utf8', timeout: 30_000 });
    assert.ifError(repaired.error);
    assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
    const installation = JSON.parse(repaired.stdout);
    assert.equal(installation.vscodeBridge, null);
    assert.equal(installation.intellij, null);
    assert.ok(fs.existsSync(path.join(f.copilot, 'knowledge', 'profile.md')));
    assert.ok(fs.existsSync(path.join(f.copilot, 'agents', 'engineer.agent.md')));
    assert.equal(fs.readFileSync(path.join(bridge, 'extension.cjs'), 'utf8'), 'Existing editor bridge.\n');
    assert.equal(fs.readFileSync(path.join(intellij, 'agents', 'engineer.agent.md'), 'utf8'), 'Existing IntelliJ engineer.\n');
  });
}

test('a changed locked intent source requires an explicit amendment rather than a blind retry', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.workspace, 'docs/specs'), { recursive: true });
  const spec = path.join(f.workspace, 'docs/specs/product.md');
  fs.writeFileSync(spec, '# Product\n\nPreserve the catalog.\n');
  writeChecks(f.workspace, { behavior: { command: ['node', '-e', 'process.exit(0)'] } });
  assert.equal(f.cli('trust', 'approve').status, 0);
  const created = f.cli('plan-new', '--goal', 'Preserve catalog', '--acceptance', 'Catalog is preserved', '--constraint', 'No unrelated changes', '--verification-check', 'behavior', '--intent-source', 'docs/specs/product.md');
  assert.equal(created.status, 0, created.stdout);
  fs.writeFileSync(spec, '# Product\n\nChange the catalog.\n');
  const result = f.cli('gate', '--plan', created.value.path);
  assert.equal(result.status, 1);
  const failure = result.value.diagnostics.failures.find(item => item.checkId === 'C-intent-sources');
  assert.equal(failure.category, 'intent');
  assert.ok(failure.nextActions.some(action => action.kind === 'guidance' && /explicit.*amend/i.test(action.text)));
  assert.equal(failure.retry.automatic, false);
});

test('unknown readiness checks retain evidence and require inspection', () => {
  const result = recoveryDiagnostics({ source: 'doctor', checks: [{ id: 'future-check', pass: false, optional: true, hint: 'Inspect adapter readiness.' }], workspace: '/product' });
  assert.equal(result.total, 1);
  assert.equal(result.failures[0].severity, 'advisory');
  assert.equal(result.failures[0].message, 'Inspect adapter readiness.');
  assert.deepEqual(result.failures[0].retry, { automatic: false, when: 'after-inspection' });
  assert.ok(result.failures[0].nextActions.every(action => action.kind === 'guidance'));
});

test('adaptive core skill gaps recommend scoped capability acquisition instead of a full installation', () => {
  const result = recoveryDiagnostics({ source: 'doctor', target: 'cli', workspace: '/product', copilotHome: '/selected', home: '/state',
    checks: [{ id: 'H7', name: 'Adaptive bootstrap skill /create-primitive', pass: false, remediation: 'capability-acquisition', hint: 'The selected source is excluded.' }] });
  const failure = result.failures[0];
  assert.equal(failure.category, 'capability');
  assert.equal(failure.severity, 'blocking');
  assert.ok(failure.nextActions.every(action => action.kind === 'guidance'));
  assert.ok(failure.nextActions.some(action => /consent.*source|included.*source/i.test(action.text)));
  assert.ok(failure.nextActions.some(action => /create-primitive/i.test(action.text)));
  assert.deepEqual(failure.retry, { automatic: false, when: 'after-inspection' });
  const legacy = recoveryDiagnostics({ source: 'doctor', target: 'cli', workspace: '/product', checks: [{ id: 'H7', pass: false }] });
  assert.equal(legacy.failures[0].category, 'installation');
  assert.equal(legacy.failures[0].nextActions[0].argv[1], 'install');
});

test('a domain parent retains its domain command context in recovery guidance', () => {
  const result = recoveryDiagnostics({ source: 'gate', checks: [{ id: 'C-intent-sources', pass: false, severity: 'fail', message: 'Changed spec.' }], workspace: '/coordinator', copilotHome: '/copilot', home: '/state', plan: '/state/domains/catalog/plans/delivery.hplan', domain: 'catalog' });
  assert.deepEqual(result.failures[0].nextActions[0].argv, ['ae', 'domain', 'status', '--name', 'catalog', '--plan', '/state/domains/catalog/plans/delivery.hplan', '--workspace', '/coordinator', '--copilot-home', '/copilot', '--ae-home', '/state']);
  assert.ok(result.failures[0].nextActions.some(action => /explicit.*amend/i.test(action.text || '')));
});

test('large diagnostics report omissions and stay within their byte bound', () => {
  const checks = Array.from({ length: 80 }, (_, index) => ({ id: `H${index + 1}`, pass: false, hint: '多'.repeat(1000) }));
  const result = recoveryDiagnostics({ source: 'doctor', checks, workspace: '/product/' + 'x'.repeat(4000) });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16_384);
  assert.equal(result.total, 80);
  assert.equal(result.failures.length + result.omitted, 80);
  assert.ok(result.omitted > 0);
});
