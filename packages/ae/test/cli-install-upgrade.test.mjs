import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { applyRetired, syncAssetsToTarget } from '../lib/sync.mjs';
import { parsePlanFrontmatter } from '../lib/plan-parse.mjs';
import { scanPlansForGate } from '../lib/gate.mjs';
import { CONTEXT_PACK_MAX_BYTES, buildContextPack } from '../lib/context-pack.mjs';
import { extractGoalFromPlan } from '../lib/plan-goal.mjs';
import { loadPlan } from '../lib/plan-parse.mjs';
import { createEvidenceBinding, readEvidence, validateEvidence, writeEvidence } from '../lib/evidence.mjs';
import { ensureHarnessDir } from '../lib/session.mjs';
import { installGlobalHarnessShim, globalHarnessShimPath, INSTALL_FIX_HINT } from '../lib/global-bin.mjs';
import { harnessRunnerSource, RUNNER_VERSION, writeHarnessRunner } from '../lib/resolve-harness-bin.mjs';
import { installHarnessBin } from '../lib/install-harness-bin.mjs';
import { ensureFirstRunInstall } from '../lib/tui-cmd.mjs';
import { recordSkillUsage } from '../lib/telemetry.mjs';
import { mergeVSCodeSettings, parseVSCodeSettings } from '../lib/vscode-settings.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { validatePlanScope } from '../lib/plan-scope.mjs';
import { listCommands } from '../lib/registry.mjs';
import { HELP_COMMAND_ORDER } from '../bin/ae.mjs';
import YAML from 'yaml';
import { approveProject } from '../lib/trust.mjs';
import { getCorpusRoot } from '../lib/commands.mjs';
import { tempDir, runHarness, writePlan, packageRoot, binPath } from './helpers/index.mjs';
import {
  writeKnowledgeSolution,
  runIndex,
  writeProductSolution,
  writeChecks,
  writeVersionedPlan,
  initGit,
  runHook,
  runHookWithPolicy,
  hookResponse,
  assertHookBlocked,
  recordSuccessfulEdit,
  primitiveAnalysis,
} from './helpers/cli-fixtures.mjs';

function readEvents(workspace) {
  const eventsPath = path.join(workspace, '.harness', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs
    .readFileSync(eventsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('preserved knowledge files are not reported as harness-owned', () => {
  const assetsRoot = tempDir('harness-assets-');
  const targetRoot = tempDir('harness-target-');
  const rel = path.join('knowledge', 'solutions', '.gitkeep');
  fs.mkdirSync(path.dirname(path.join(assetsRoot, rel)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(targetRoot, rel)), { recursive: true });
  fs.writeFileSync(path.join(assetsRoot, rel), '', 'utf8');
  fs.writeFileSync(path.join(targetRoot, rel), '', 'utf8');

  const stats = syncAssetsToTarget(
    assetsRoot,
    targetRoot,
    {
      dryRun: false,
      preserveKnowledge: true,
      verbose: false,
    },
    () => {}
  );

  assert.equal(stats.skipped, 1);
  assert.deepEqual(stats.files, []);
});

test('hook install rewrites source cwd to the hydrated user hook directory', () => {
  const assetsRoot = tempDir('harness-assets-');
  const targetRoot = tempDir('harness-target-');
  const hooksDir = path.join(assetsRoot, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'gate.mjs'), 'process.exit(0);\n');
  fs.writeFileSync(
    path.join(hooksDir, 'hooks.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node gate.mjs', cwd: 'hooks' }] }],
      },
    })
  );

  syncAssetsToTarget(assetsRoot, targetRoot, { dryRun: false, preserveKnowledge: true, verbose: false }, () => {});

  const installed = JSON.parse(fs.readFileSync(path.join(targetRoot, 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(installed.hooks.PreToolUse[0].hooks[0].cwd, path.join(targetRoot, 'hooks'));
});

test('VS Code doctor distinguishes a missing installed hook bundle from package assets', async () => {
  const copilotHome = tempDir('harness-copilot-');
  const assetsRoot = tempDir('harness-assets-');
  const workspace = tempDir('harness-workspace-');
  const sourceHooks = path.join(packageRoot, 'corpus', 'hooks');
  fs.cpSync(sourceHooks, path.join(assetsRoot, 'hooks'), { recursive: true });
  const settingsPath = path.join(tempDir('harness-vscode-'), 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(mergeVSCodeSettings({}, { copilotHome })));

  const result = await runDoctor({
    copilotHome,
    assetsRoot,
    pkgRoot: packageRoot,
    flags: { workspace, host: 'vscode' },
    vscodeSettingsPaths: [settingsPath],
  });

  assert.equal(fs.existsSync(path.join(assetsRoot, 'hooks', 'hooks.json')), true);
  assert.equal(fs.existsSync(path.join(copilotHome, 'hooks')), false);
  assert.equal(result.checks.find((check) => check.id === 'V1')?.pass, false);
});

test('retired cleanup refuses paths outside copilot home', () => {
  const parent = tempDir('harness-parent-');
  const copilotHome = path.join(parent, 'copilot');
  const outside = path.join(parent, 'outside-retired');
  fs.mkdirSync(copilotHome, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'do not delete', 'utf8');

  const stats = applyRetired(
    copilotHome,
    ['../outside-retired'],
    { files: ['../outside-retired'] },
    { dryRun: false },
    () => {}
  );

  assert.equal(fs.existsSync(path.join(outside, 'keep.txt')), true);
  assert.equal(stats.removed, 0);
  assert.equal(stats.skipped, 1);
});

test('uninstall refuses lock paths outside copilot home', () => {
  const parent = tempDir('harness-parent-');
  const copilotHome = path.join(parent, 'copilot');
  const outside = path.join(parent, 'outside-uninstall');
  fs.mkdirSync(copilotHome, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'do not delete', 'utf8');
  fs.writeFileSync(
    path.join(copilotHome, '.harness-lock.json'),
    JSON.stringify({ files: ['../outside-uninstall'] }, null, 2),
    'utf8'
  );

  const result = runHarness(['uninstall', '--copilot-home', copilotHome]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(outside, 'keep.txt')), true);
});

test('install creates global harness shim', () => {
  const copilotHome = tempDir('harness-copilot-');
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  installHarnessBin(packageRoot, copilotHome, { dryRun: false, verbose: false }, () => {});
  installGlobalHarnessShim(copilotHome, { dryRun: false, verbose: false }, () => {});
  const shim = globalHarnessShimPath(copilotHome);
  assert.ok(fs.existsSync(shim));
  const result = spawnSync(process.execPath, [shim, 'help'], {
    encoding: 'utf8',
    env: { ...process.env, COPILOT_HOME: copilotHome },
  });
  assert.equal(result.status, 0, result.stderr);
  const validate = spawnSync(
    process.execPath,
    [shim, 'validate-plan', '--plan', plan, '--workspace', workspace, '--json'],
    {
      encoding: 'utf8',
      env: { ...process.env, COPILOT_HOME: copilotHome },
    }
  );
  assert.equal(validate.status, 0, validate.stderr);
  assert.equal(JSON.parse(validate.stdout).pass, true);
});

test('getCorpusRoot is the packaged corpus and does not rebuild hooks', () => {
  const source = path.join(packageRoot, 'corpus', 'hooks', 'lib', 'tool-payload.mjs');
  const before = fs.readFileSync(source);
  const mtime = fs.statSync(source).mtimeMs;
  const root = getCorpusRoot();
  assert.equal(root, path.join(packageRoot, 'corpus'));
  assert.equal(fs.readFileSync(source).equals(before), true);
  assert.equal(fs.statSync(source).mtimeMs, mtime);
  assert.match(before.toString('utf8'), /unwrapShellSegments/);
  assert.equal(fs.existsSync(path.join(packageRoot, 'assets')), false);
  assert.equal(fs.existsSync(path.join(packageRoot, '..', '..', 'scripts', 'build-harness-assets.mjs')), false);
});

test('TUI launch leaves fresh homes untouched and upgrades only selected legacy hosts', async () => {
  const previousExtensions = process.env.HARNESS_VSCODE_EXTENSIONS_DIR;
  const copilotHome = tempDir('first-tui-home-');
  const workspace = tempDir('first-tui-workspace-');
  const extensionsDir = tempDir('first-tui-extensions-');
  process.env.HARNESS_VSCODE_EXTENSIONS_DIR = extensionsDir;
  try {
  const bridgePath = path.join(extensionsDir, 'ae-copilot-bridge');
  const packageVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
  const calls = [];
  const install = async (command, argv) => {
    calls.push({ command, argv });
    fs.mkdirSync(bridgePath, { recursive: true });
    fs.writeFileSync(path.join(bridgePath, 'extension.cjs'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(bridgePath, 'package.json'), JSON.stringify({
      name: 'ae-copilot-bridge',
      publisher: 'harness',
      version: '0.1.0',
    }));
    fs.writeFileSync(
      path.join(copilotHome, '.harness-lock.json'),
      JSON.stringify({
        package: 'harness',
        version: packageVersion,
        files: ['skills'],
        vscodeBridge: { id: 'ae-copilot-bridge', version: '0.1.0', path: bridgePath },
      }),
    );
    return 0;
  };

  assert.equal(await ensureFirstRunInstall({ copilotHome, workspace, install, packageVersion }), false);
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(copilotHome, '.harness-lock.json')), false);
  fs.writeFileSync(path.join(copilotHome, '.harness-lock.json'), JSON.stringify({ package: 'harness', version: '0.0.1', files: ['skills'], targets: ['vscode', 'cli'] }));
  assert.equal(await ensureFirstRunInstall({ copilotHome, workspace, install, packageVersion }), true);
  assert.deepEqual(calls.map((c) => c.command), ['upgrade']);
  assert.ok(calls[0].argv.includes('--configure-vscode'));
  assert.deepEqual(calls[0].argv.slice(calls[0].argv.indexOf('--target'), calls[0].argv.indexOf('--target') + 2), [
    '--target',
    'vscode,cli',
  ]);

  assert.equal(await ensureFirstRunInstall({ copilotHome, workspace, install, packageVersion }), false);
  assert.equal(calls.length, 1, 'an existing install lock suppresses repeat hydration');

  fs.writeFileSync(
    path.join(copilotHome, '.harness-lock.json'),
    JSON.stringify({ package: 'harness', version: '0.0.1', files: ['skills'] }),
  );
  assert.equal(await ensureFirstRunInstall({ copilotHome, workspace, install, packageVersion }), true);
  assert.deepEqual(calls.map((c) => c.command), ['upgrade', 'upgrade']);
  assert.equal(await ensureFirstRunInstall({ copilotHome, workspace, install, packageVersion }), false);
  assert.equal(calls.length, 2, 'the upgraded lock suppresses another upgrade');

  fs.writeFileSync(
    path.join(copilotHome, '.harness-lock.json'),
    JSON.stringify({ package: 'harness', version: '99.0.0', files: ['skills'] }),
  );
    assert.equal(await ensureFirstRunInstall({ copilotHome, workspace, install, packageVersion }), false);
    assert.equal(calls.length, 2, 'running an older CLI never auto-downgrades a newer hydrated install');
  } finally {
    if (previousExtensions === undefined) delete process.env.HARNESS_VSCODE_EXTENSIONS_DIR;
    else process.env.HARNESS_VSCODE_EXTENSIONS_DIR = previousExtensions;
  }
});

test('TUI dry-run install does not report hydration for the walkthrough', async () => {
  const copilotHome = tempDir('dry-tui-home-');
  const workspace = tempDir('dry-tui-workspace-');
  const calls = [];
  fs.writeFileSync(path.join(copilotHome, '.harness-lock.json'), JSON.stringify({ package: 'harness', version: '0.0.1', files: [], targets: ['cli'] }));
  const result = await ensureFirstRunInstall({
    copilotHome,
    workspace,
    dryRun: true,
    packageVersion: '1.0.0',
    install: async (command, argv) => {
      calls.push({ command, argv });
      return 0;
    },
  });
  assert.equal(result, false, 'a simulated install must not claim assets were written');
  assert.ok(calls[0].argv.includes('--dry-run'));
});

test('TUI never adds VS Code to an explicitly CLI-only installation', async () => {
  const copilotHome = tempDir('cli-only-tui-home-');
  const workspace = tempDir('cli-only-tui-workspace-');
  fs.writeFileSync(path.join(copilotHome, '.harness-lock.json'), JSON.stringify({ package: 'harness', version: '1.0.0', files: [], targets: ['cli'] }));
  const calls = [];
  const install = async (command, argv) => { calls.push({ command, argv }); return 0; };
  assert.equal(await ensureFirstRunInstall({ copilotHome, workspace, packageVersion: '1.0.0', install }), false);
  assert.equal(calls.length, 0);
  assert.equal(await ensureFirstRunInstall({ copilotHome, workspace, packageVersion: '1.1.0', install }), true);
  assert.deepEqual(calls[0].argv.slice(calls[0].argv.indexOf('--target'), calls[0].argv.indexOf('--target') + 2), ['--target', 'cli']);
  assert.equal(calls[0].argv.includes('--configure-vscode'), false);
});

test('TUI launch repairs a same-version legacy install that has no VS Code bridge', async () => {
  const copilotHome = tempDir('legacy-tui-home-');
  const workspace = tempDir('legacy-tui-workspace-');
  const packageVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
  fs.writeFileSync(
    path.join(copilotHome, '.harness-lock.json'),
    JSON.stringify({ package: 'harness', version: packageVersion, files: ['skills'] }),
  );
  const calls = [];

  assert.equal(await ensureFirstRunInstall({
    copilotHome,
    workspace,
    packageVersion,
    install: async (command, argv) => {
      calls.push({ command, argv });
      return 0;
    },
  }), true);
  assert.deepEqual(calls.map((call) => call.command), ['upgrade']);
  assert.ok(calls[0].argv.includes('--configure-vscode'));
});

test('TUI launch repairs a same-version lock whose bridge path is a decoy or symlink payload', async () => {
  const copilotHome = tempDir('decoy-tui-home-');
  const workspace = tempDir('decoy-tui-workspace-');
  const packageVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
  const decoy = tempDir('decoy-bridge-');
  fs.writeFileSync(path.join(decoy, 'extension.cjs'), 'module.exports = {};\n');
  fs.writeFileSync(
    path.join(copilotHome, '.harness-lock.json'),
    JSON.stringify({
      package: 'harness',
      version: packageVersion,
      files: ['skills'],
      vscodeBridge: { id: 'ae-copilot-bridge', version: '0.1.0', path: decoy },
    }),
  );
  const calls = [];
  assert.equal(await ensureFirstRunInstall({
    copilotHome,
    workspace,
    packageVersion,
    install: async (command) => {
      calls.push(command);
      return 0;
    },
  }), true);
  assert.deepEqual(calls, ['upgrade']);

  const linked = tempDir('linked-bridge-');
  fs.symlinkSync(decoy, path.join(linked, 'bridge'));
  fs.writeFileSync(
    path.join(copilotHome, '.harness-lock.json'),
    JSON.stringify({
      package: 'harness',
      version: packageVersion,
      files: ['skills'],
      vscodeBridge: { id: 'ae-copilot-bridge', version: '0.1.0', path: path.join(linked, 'bridge') },
    }),
  );
  calls.length = 0;
  assert.equal(await ensureFirstRunInstall({
    copilotHome,
    workspace,
    packageVersion,
    install: async (command) => {
      calls.push(command);
      return 0;
    },
  }), true);
  assert.deepEqual(calls, ['upgrade']);
});

test('install tracks the VS Code bridge across a CLI-only upgrade and uninstall removes it safely', () => {
  const copilotHome = tempDir('bridge-install-home-');
  const workspace = tempDir('bridge-install-workspace-');
  const extensionsDir = tempDir('bridge-install-extensions-');
  const env = { HARNESS_VSCODE_EXTENSIONS_DIR: extensionsDir };

  const installed = runHarness([
    'install', '--workspace', workspace, '--copilot-home', copilotHome, '--target', 'vscode,cli', '--json',
  ], { env });
  assert.equal(installed.status, 0, installed.stderr);
  const lockPath = path.join(copilotHome, '.harness-lock.json');
  const firstLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(firstLock.vscodeBridge.id, 'ae-copilot-bridge');
  assert.ok(fs.existsSync(firstLock.vscodeBridge.path));

  const upgraded = runHarness([
    'upgrade', '--workspace', workspace, '--copilot-home', copilotHome, '--target', 'cli', '--json',
  ], { env });
  assert.equal(upgraded.status, 0, upgraded.stderr);
  const upgradedLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.deepEqual(upgradedLock.vscodeBridge, firstLock.vscodeBridge, 'a targeted upgrade must not orphan an installed extension');

  const uninstalled = runHarness(['uninstall', '--copilot-home', copilotHome], { env });
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.equal(fs.existsSync(firstLock.vscodeBridge.path), false);
});

test('global harness shim embeds INSTALL_FIX_HINT via JSON.stringify, keeping the generated shim syntactically valid', () => {
  const copilotHome = tempDir('shim-quoting-home-');
  installGlobalHarnessShim(copilotHome, { dryRun: false, verbose: false }, () => {});
  const shim = globalHarnessShimPath(copilotHome);
  const src = fs.readFileSync(shim, 'utf8');
  assert.ok(
    src.includes(`' + ${JSON.stringify(INSTALL_FIX_HINT)});`),
    'the fix-hint line must be embedded via JSON.stringify concatenation, not raw ${...} interpolation into a single-quoted string'
  );
  const check = spawnSync(process.execPath, ['--check', shim], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);

    const result = spawnSync(process.execPath, [shim, 'help'], {
    encoding: 'utf8',
    env: { ...process.env, COPILOT_HOME: copilotHome },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /E_NO_RUNTIME/);
  assert.match(result.stderr, /ae install/);
});

test('resolve finds monorepo harness bin', () => {
  const repoRoot = path.resolve(packageRoot, '../..');
  const result = runHarness(['resolve', '--workspace', repoRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.bin);
  assert.ok(body.agentCommand);
});

test('init-repo creates harness runner', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-home-');
  const harnessHome = tempDir('harness-home-');
  const result = runHarness(['init-repo', '--shared', '--workspace', workspace, '--copilot-home', copilotHome], {
    env: { HARNESS_HOME: harnessHome },
  });
  assert.equal(result.status, 0, result.stderr);
  const runner = path.join(workspace, '.harness', 'run.mjs');
  assert.ok(fs.existsSync(runner));
  assert.ok(fs.existsSync(path.join(workspace, '.github', 'harness', 'checks.yaml')));
  assert.ok(fs.existsSync(path.join(workspace, '.github', 'harness', 'policy.yaml')));
  const runResult = spawnSync(process.execPath, [runner, 'resolve', '--json'], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, HARNESS_BIN: binPath },
  });
  assert.equal(runResult.status, 0, runResult.stderr);
});

test('harnessRunnerSource embeds INSTALL_FIX_HINT via JSON.stringify, keeping the generated runner syntactically valid', () => {
  const src = harnessRunnerSource();
  assert.ok(
    src.includes(`' + ${JSON.stringify(INSTALL_FIX_HINT)});`),
    'the fix-hint line must be embedded via JSON.stringify concatenation, not raw ${...} interpolation into a single-quoted string'
  );
  const dir = tempDir('runner-syntax-');
  const runnerPath = path.join(dir, 'run.mjs');
  fs.writeFileSync(runnerPath, src);
  const check = spawnSync(process.execPath, ['--check', runnerPath], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('the generated runner injects the default --workspace BEFORE a caller-supplied `--` boundary', () => {
  const workspace = tempDir('runner-inject-ws-');
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  const runnerPath = path.join(workspace, '.harness', 'run.mjs');
  fs.writeFileSync(runnerPath, harnessRunnerSource());
  // Stand in for the real harness bin: echo back exactly the argv it received.
  const argvStub = path.join(workspace, 'argv-stub.mjs');
  fs.writeFileSync(argvStub, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');

  const withBoundary = spawnSync(process.execPath, [runnerPath, 'learnings', '--why', '--', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_BIN: argvStub },
  });
  assert.equal(withBoundary.status, 0, withBoundary.stderr);
  const argv = JSON.parse(withBoundary.stdout);
  const injected = argv.indexOf('--workspace');
  const boundary = argv.indexOf('--');
  assert.notEqual(injected, -1, 'the default workspace is still injected');
  assert.ok(injected < boundary, `--workspace must precede the boundary, got ${JSON.stringify(argv)}`);
  assert.deepEqual(argv.slice(boundary), ['--', '--json'], 'the caller\'s literal content is untouched');
  assert.notEqual(argv[injected + 1], '--', 'the workspace value is a path, not the boundary token');

  // No boundary: the appended form is unchanged.
  const noBoundary = spawnSync(process.execPath, [runnerPath, 'learnings'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_BIN: argvStub },
  });
  assert.equal(noBoundary.status, 0, noBoundary.stderr);
  assert.deepEqual(JSON.parse(noBoundary.stdout).slice(0, 2), ['learnings', '--workspace']);

  // An explicit pre-boundary --workspace still suppresses the injection.
  const explicit = spawnSync(process.execPath, [runnerPath, 'learnings', '--workspace', workspace, '--', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_BIN: argvStub },
  });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).filter((a) => a === '--workspace').length, 1, 'no second --workspace is injected');
});

test('upgrade refreshes a stale workspace runner, and creates none where there is no runner', () => {
  const workspace = tempDir('runner-upgrade-ws-');
  const copilotHome = tempDir('runner-upgrade-home-');
  const runnerPath = path.join(workspace, '.harness', 'run.mjs');

  // No runner: upgrade must not conjure one (upgrade runs from anywhere).
  assert.equal(runHarness(['upgrade', '--workspace', workspace, '--copilot-home', copilotHome, '--target', 'cli']).status, 0);
  assert.equal(fs.existsSync(runnerPath), false, 'upgrade outside an initialized workspace creates nothing');

  // A runner stamped by an older harness is rewritten.
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  fs.writeFileSync(runnerPath, harnessRunnerSource().replace(`@harness-runner-version ${RUNNER_VERSION}`, '@harness-runner-version 1'));
  const res = runHarness(['upgrade', '--workspace', workspace, '--copilot-home', copilotHome, '--target', 'cli']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(fs.readFileSync(runnerPath, 'utf8'), new RegExp(`@harness-runner-version ${RUNNER_VERSION}\\b`),
    'a runner from an older harness is brought up to the installed version');
});

test('ae --version and -V print the package version and exit 0', () => {
  const expected = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
  ).version;
  for (const flag of ['--version', '-V']) {
    const res = runHarness([flag]);
    assert.equal(res.status, 0, `${flag}: ${res.stderr}`);
    assert.equal(res.stdout.trim(), expected, `${flag} prints the package version`);
  }
});

test('-v still means --verbose, never version', () => {
  const workspace = tempDir('vflag-ws-');
  const copilotHome = tempDir('vflag-home-');
  const res = runHarness(['status', '-v', '--workspace', workspace, '--copilot-home', copilotHome]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /home/, '-v runs status verbosely rather than printing a bare version');
});

test('doctor H9 detects a harness installed but never hydrated by upgrade', () => {
  const workspace = tempDir('lockdrift-ws-');
  const copilotHome = tempDir('lockdrift-home-');
  const h9 = () => {
    const res = runHarness(['doctor', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);
    return JSON.parse(res.stdout).checks.find((c) => c.id === 'H9');
  };

  assert.equal(runHarness(['upgrade', '--workspace', workspace, '--copilot-home', copilotHome, '--target', 'cli']).status, 0);
  assert.equal(h9().pass, true, 'a freshly upgraded home is current');

  const lockPath = path.join(copilotHome, '.harness-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  fs.writeFileSync(lockPath, JSON.stringify({ ...lock, version: '0.0.1-old' }));
  const drifted = h9();
  assert.equal(drifted.pass, false, 'a home hydrated by an older harness is not current');
  assert.match(drifted.hint, /run: ae upgrade/);
});

test('doctor H13 fails a runner that predates the installed harness', () => {
  const workspace = tempDir('runner-doctor-ws-');
  const copilotHome = tempDir('runner-doctor-home-');
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  const runnerPath = path.join(workspace, '.harness', 'run.mjs');
  const h13 = () => {
    const res = runHarness(['doctor', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);
    return JSON.parse(res.stdout).checks.find((c) => c.id === 'H13');
  };

  fs.writeFileSync(runnerPath, harnessRunnerSource().replace(`@harness-runner-version ${RUNNER_VERSION}`, '@harness-runner-version 1'));
  const stale = h13();
  assert.equal(stale.pass, false, 'a stale runner is not a healthy runner');
  assert.match(stale.hint, /predates runner v\d+/);

  fs.writeFileSync(runnerPath, harnessRunnerSource());
  assert.equal(h13().pass, true, 'a current runner passes');
});

test('the generated runner honors an explicit --workspace=<path> and injects no second one', () => {
  const workspace = tempDir('runner-eqform-ws-');
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  const runnerPath = path.join(workspace, '.harness', 'run.mjs');
  fs.writeFileSync(runnerPath, harnessRunnerSource());
  const argvStub = path.join(workspace, 'argv-stub.mjs');
  fs.writeFileSync(argvStub, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');

  const run = (args) => {
    const res = spawnSync(process.execPath, [runnerPath, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HARNESS_BIN: argvStub },
    });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  };

  const eqForm = run(['learnings', `--workspace=${workspace}`]);
  assert.equal(eqForm.filter((a) => a === '--workspace' || a.startsWith('--workspace=')).length, 1,
    `the equals form must suppress injection, got ${JSON.stringify(eqForm)}`);
  assert.ok(eqForm.includes(`--workspace=${workspace}`), 'the caller\'s own value is the one that survives');

    const literal = run(['learnings', '--', '--workspace=/not/a/flag']);
  const boundary = literal.indexOf('--');
  const injected = literal.indexOf('--workspace');
  assert.notEqual(injected, -1, 'a post-boundary equals form is content, not a caller-chosen workspace');
  assert.ok(injected < boundary, `injection must precede the boundary, got ${JSON.stringify(literal)}`);
});

test('writeHarnessRunner regenerates a runner stamped with an older @harness-runner-version', () => {
    assert.ok(RUNNER_VERSION > 2, 'RUNNER_VERSION must be bumped past the pre-fix value so existing runners regenerate');

  const workspace = tempDir('runner-version-ws-');
  const runnerDir = path.join(workspace, '.harness');
  fs.mkdirSync(runnerDir, { recursive: true });
  const runnerPath = path.join(runnerDir, 'run.mjs');
  fs.writeFileSync(runnerPath, `#!/usr/bin/env node\n/**\n * @harness-runner-version 2\n */\nconsole.log('stale runner stub');\n`);

  const result = writeHarnessRunner(workspace, false);
  assert.equal(result.updated, true, 'a runner pinned to version 2 must be regenerated, not left stale');
  const regenerated = fs.readFileSync(runnerPath, 'utf8');
  assert.match(regenerated, new RegExp(`@harness-runner-version ${RUNNER_VERSION}\\b`));
  assert.doesNotMatch(regenerated, /stale runner stub/);
});

test('Java and AWS migration primitive plans explicitly compare the installed domain skills', () => {
  const workspace = tempDir('harness-workspace-');
  const withoutDomainComparison = primitiveAnalysis
    .replace('Existing /java skill', 'Java guidance')
    .replace('Existing /aws skill', 'AWS guidance');
  let plan = writeVersionedPlan(workspace, {
    impacted: ['packages/ae/corpus/skills/example/SKILL.md'],
    skillsUsed: ['engineer', 'create-primitive'],
    technicalNotes: withoutDomainComparison,
    intent: 'Create a Java and AWS upgrade migration skill',
  });
  let result = runHarness(['gate', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(result.status, 1, result.stderr);
  let body = JSON.parse(result.stdout);
  assert.equal(body.checks.find((check) => check.id === 'PR8')?.pass, false);
  assert.match(body.nextTools.join('\n'), /create-primitive\/SKILL\.md/i);

  plan = writeVersionedPlan(workspace, {
    impacted: ['packages/ae/corpus/skills/example/SKILL.md'],
    skillsUsed: ['engineer', 'create-primitive'],
    technicalNotes: primitiveAnalysis,
    intent: 'Create a Java and AWS upgrade migration skill',
  });
  result = runHarness(['gate', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(result.status, 0, result.stderr);
  body = JSON.parse(result.stdout);
  assert.equal(body.checks.find((check) => check.id === 'PR8')?.pass, true);
});

test('upgrade purges retired prompt wrappers and single-entry retirements from hydrated homes', async () => {
  const { loadRetired, applyRetired } = await import('../lib/sync.mjs');
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const retired = loadRetired(pkgRoot);
  for (const expected of ['prompts', 'skills/btw', 'skills/start', 'skills/work-on-task', 'agents/pipeline-navigator.agent.md']) {
    assert.ok(retired.includes(expected), `retired.json missing ${expected}`);
  }

  // Old hydrated home: wrappers + retired skill + retired agent present and lock-tracked.
  const home = tempDir('harness-old-home-');
  const oldFiles = ['prompts/engineer.prompt.md', 'skills/btw/SKILL.md', 'agents/pipeline-navigator.agent.md'];
  for (const rel of oldFiles) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'legacy\n');
  }
  const userPrompt = path.join(home, 'prompts', 'user-owned.prompt.md');
  fs.writeFileSync(userPrompt, 'keep me\n');
  // Real pre-0.5 locks recorded shipped leaves, not their parent directories.
  const previousLock = { files: oldFiles };
  const stats = applyRetired(home, retired, previousLock, {}, () => {});
  assert.ok(stats.removed >= 3, `expected purge, removed=${stats.removed}`);
  assert.equal(fs.existsSync(path.join(home, 'prompts', 'engineer.prompt.md')), false, 'lock-tracked wrapper must be purged');
  assert.equal(fs.readFileSync(userPrompt, 'utf8'), 'keep me\n', 'untracked content under a directory tombstone must survive');
  assert.equal(fs.existsSync(path.join(home, 'skills', 'btw')), false);
  assert.equal(fs.existsSync(path.join(home, 'agents', 'pipeline-navigator.agent.md')), false);
});

test('applyRetired does not wipe untracked siblings when the lock named the directory tombstone', () => {
  const home = tempDir('retired-dir-lock-');
  fs.mkdirSync(path.join(home, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(home, 'prompts', 'engineer.prompt.md'), 'legacy\n');
  fs.writeFileSync(path.join(home, 'prompts', 'user-owned.prompt.md'), 'keep me\n');
  const stats = applyRetired(home, ['prompts'], { files: ['prompts'] }, {}, () => {});
  assert.equal(stats.removed, 0);
  assert.equal(fs.readFileSync(path.join(home, 'prompts', 'user-owned.prompt.md'), 'utf8'), 'keep me\n');
  assert.equal(fs.existsSync(path.join(home, 'prompts', 'engineer.prompt.md')), true);
});
