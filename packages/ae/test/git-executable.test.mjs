import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const moduleUrl = new URL('../corpus/hooks/lib/git-executable.mjs', import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Windows Git lookup ignores cwd, empty and non-absolute PATH entries', async () => {
  const { selectWindowsGitExecutable } = await import(moduleUrl);
  const visited = [];
  const selected = selectWindowsGitExecutable(';.;bin;C:tools;\\tools;"C:\\Program Files\\Git\\cmd";D:\\Git\\bin', candidate => {
    visited.push(candidate);
    return candidate === 'D:\\Git\\bin\\git.exe' ? candidate : null;
  });
  assert.equal(selected, 'D:\\Git\\bin\\git.exe');
  assert.deepEqual(visited, ['C:\\Program Files\\Git\\cmd\\git.exe', 'D:\\Git\\bin\\git.exe']);
});

test('Windows Git lookup accepts absolute UNC paths and refuses unsafe resolved targets', async () => {
  const { selectWindowsGitExecutable } = await import(moduleUrl);
  const selected = selectWindowsGitExecutable('C:\\first;C:\\second;\\\\server\\share\\Git', candidate => {
    if (candidate.startsWith('C:\\first')) return 'git.exe';
    if (candidate.startsWith('C:\\second')) return 'C:\\second\\git.cmd';
    return '\\\\server\\share\\Git\\git.exe';
  });
  assert.equal(selected, '\\\\server\\share\\Git\\git.exe');
  assert.equal(selectWindowsGitExecutable(';relative;C:relative;\\relative', () => { throw new Error('must not inspect relative paths'); }), null);
});

test('Windows environment selection follows Node case-insensitive key precedence', async () => {
  const { windowsEnvironmentValue } = await import(moduleUrl);
  assert.equal(windowsEnvironmentValue({ Path: 'second', PATH: 'first', path: 'third' }, 'PATH'), 'first');
  assert.equal(windowsEnvironmentValue({ SystemRoot: 'C:\\Windows' }, 'SYSTEMROOT'), 'C:\\Windows');
});

test('Windows native launchers come from an absolute SystemRoot, never cwd or PATH', async () => {
  const { windowsSystemPowerShellPath } = await import(moduleUrl);
  assert.equal(windowsSystemPowerShellPath('C:\\Windows'), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  for (const root of [null, '', '.', 'Windows', 'C:Windows', '\\Windows']) assert.equal(windowsSystemPowerShellPath(root), null);
});

test('Windows Git unavailability fails closed while other platforms retain existing lookup', async () => {
  const { gitExecutable } = await import(moduleUrl);
  for (const env of [{}, { PATH: ';.;relative;C:relative;\\relative' }]) {
    assert.throws(() => gitExecutable({ platform: 'win32', env }), error => error.code === 'E_GIT_EXECUTABLE');
  }
  assert.equal(gitExecutable({ platform: 'linux', env: {} }), 'git');
  assert.equal(gitExecutable({ platform: 'darwin', env: {} }), 'git');
});

test('doctor retains Node and failed Git diagnostics when Windows executable selection is unavailable', async () => {
  const { gitExecutable } = await import(moduleUrl);
  const { prerequisiteChecks } = await import('../lib/doctor.mjs');
  let checks;
  assert.doesNotThrow(() => {
    checks = prerequisiteChecks({ resolveGit: () => gitExecutable({ platform: 'win32', env: { PATH: ';.;relative;C:relative' } }) });
  });
  assert.equal(checks.find(check => check.id === 'R1').pass, true);
  const git = checks.find(check => check.id === 'R2');
  assert.equal(git.pass, false);
  assert.match(git.hint, /Git executable is unavailable in absolute PATH directories/);
});

test('installed-home doctor returns failed hook checks when Windows Git is unavailable', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-doctor-no-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), copilotHome = path.join(root, 'copilot'), home = path.join(root, 'home');
  fs.mkdirSync(workspace);
  const env = { ...process.env, TEMP: root, TMP: root, AE_HOME: home, HARNESS_HOME: home, COPILOT_HOME: copilotHome };
  const installed = spawnSync(process.execPath, [path.join(packageRoot, 'bin/ae.mjs'), 'install', '--target', 'cli', '--workspace', workspace, '--copilot-home', copilotHome, '--ae-home', home, '--json'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  const options = { copilotHome, assetsRoot: path.join(packageRoot, 'corpus'), pkgRoot: packageRoot, workspace,
    flags: { workspace, copilotHome, harnessHome: home, targetsExplicit: true, targets: ['cli'] } };
  // Platform substitution is confined to this child. Exercise the real Windows
  // resolver and complete installed-home report without changing the test host.
  const script = `Object.defineProperty(process, 'platform', { value: 'win32' }); process.env.PATH = ';.;relative;C:relative'; const { runDoctor } = await import(${JSON.stringify(new URL('../lib/doctor.mjs', import.meta.url).href)}); console.log(JSON.stringify(await runDoctor(${JSON.stringify(options)})));`;
  const checked = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: workspace, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  const report = JSON.parse(checked.stdout);
  assert.equal(report.pass, false);
  assert.equal(report.checks.find(check => check.id === 'R1').pass, true);
  assert.match(report.checks.find(check => check.id === 'R2').hint, /Git executable is unavailable in absolute PATH directories/);
  assert.equal(report.checks.find(check => check.id === 'R2').pass, false);
  assert.equal(report.checks.find(check => check.id === 'C2').pass, true, 'installed hook configuration must enter the behavioral probe');
  for (const id of ['C4', 'C5', 'C6', 'C7', 'C8', 'C9']) assert.equal(report.checks.find(check => check.id === id).pass, false, id);
});

test('packaged metadata and lifecycle helpers never spawn a bare Git executable', () => {
  const files = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.mjs')) files.push(full);
    }
  };
  for (const directory of ['bin', 'lib', 'corpus/hooks']) walk(path.join(packageRoot, directory));
  const unsafe = /\b(?:spawnSync|spawn|execFileSync|execFile|execSync)\s*\(\s*(['"`])git(?:\.(?:exe|com))?\1/gi;
  const problems = files.filter(file => {
    unsafe.lastIndex = 0;
    return unsafe.test(fs.readFileSync(file, 'utf8'));
  }).map(file => path.relative(packageRoot, file));
  assert.deepEqual(problems, []);
  assert.doesNotMatch(fs.readFileSync(path.join(packageRoot, 'corpus/hooks/lib/tool-payload.mjs'), 'utf8'), /spawnSync\s*\(\s*tokens\[0\]/);
});
