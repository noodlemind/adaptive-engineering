import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { binPath, runHarness } from './helpers/cli.mjs';

const SLICE_KEYS = ['activePlan', 'checkReadiness', 'contacts', 'contextEvidence', 'gateStatus', 'graph', 'index', 'instructions', 'intentDetail', 'intentDiscovery', 'intentSources', 'layout', 'learnings', 'neighborhood', 'planGoal', 'procedure', 'reviewCoverage', 'skills', 'trust', 'verification', 'workflow'];

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function coldRepo() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'host-adapter-ws-'));
  fs.writeFileSync(path.join(ws, 'README.md'), 'cold\n');
  git(ws, ['init', '-q']);
  git(ws, ['config', 'user.email', 'e@x.test']);
  git(ws, ['config', 'user.name', 'T']);
  git(ws, ['add', 'README.md']);
  const committed = git(ws, ['commit', '-qm', 'init']);
  assert.equal(committed.status, 0, committed.stderr || committed.stdout);
  return ws;
}

function productWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'host-adapter-product-'));
  fs.mkdirSync(path.join(ws, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'README.md'), 'product\n');
  return ws;
}

function harness(home, workspace, args) {
  return runHarness(
    [...args, '--workspace', workspace, '--copilot-home', home, '--json', '--no-events'],
    { env: { COPILOT_HOME: home, HARNESS_NO_EVENTS: '1' } },
  );
}

function checksOf(result) {
  assert.equal(result.status === 0 || result.status === 6, true, result.stderr + result.stdout);
  return JSON.parse(result.stdout).checks;
}

test('doctor --adapter checks the installed file and grok-build start preserves the delivery context', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-adapter-home-'));
  const harnessHome = fs.mkdtempSync(path.join(os.tmpdir(), 'host-adapter-hh-'));
  const product = productWorkspace();
  const plain = checksOf(harness(home, product, ['doctor']));
  assert.equal(plain.some((check) => check.id === 'A1'), false);

  const absent = harness(home, product, ['doctor', '--adapter', 'grok-build']);
  assert.equal(absent.status, 6, absent.stderr + absent.stdout);
  const missing = checksOf(absent).find((check) => check.id === 'A1');
  assert.equal(missing.pass, false);
  assert.equal(missing.optional, undefined);
  assert.match(missing.name, /grok-build/);

  const hostProbe = checksOf(harness(home, product, ['doctor', '--host', 'grok-build']));
  const unsupported = hostProbe.find((check) => check.id === 'V0');
  assert.equal(unsupported.pass, false);
  assert.match(unsupported.name, /Unsupported doctor host: grok-build/);
  assert.equal(hostProbe.some((check) => check.id === 'A1'), false);

  const installed = harness(home, product, ['install', '--target', 'cli']);
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  for (const name of ['grok-build.mjs', 'cursor.mjs', 'grok.mjs', 'codex.mjs']) {
    assert.equal(fs.existsSync(path.join(home, 'hooks', name)), true, name);
  }

  const present = harness(home, product, ['doctor', '--adapter', 'grok-build']);
  assert.equal(present.status, 0, present.stderr + present.stdout);
  assert.equal(checksOf(present).find((check) => check.id === 'A1').pass, true);

  const unknown = harness(home, product, ['doctor', '--adapter', 'does-not-exist']);
  assert.equal(unknown.status, 6, unknown.stderr + unknown.stdout);
  assert.equal(checksOf(unknown).find((check) => check.id === 'A1').pass, false);

  const after = checksOf(harness(home, product, ['doctor']));
  assert.deepEqual(after.map((check) => check.id), plain.map((check) => check.id));

  const ws = coldRepo();
  const started = spawnSync(process.execPath, [path.join(home, 'hooks', 'grok-build.mjs'), 'start'], {
    cwd: ws,
    encoding: 'utf8',
    env: {
      ...process.env,
      HARNESS_BIN: binPath,
      HARNESS_HOME: harnessHome,
      COPILOT_HOME: home,
      HARNESS_NO_EVENTS: '1',
    },
  });
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const slice = JSON.parse(started.stdout);
  assert.deepEqual(Object.keys(slice).sort(), SLICE_KEYS);
  assert.equal(slice.workflow.plan, null);
  assert.equal(slice.workflow.mutationAuthority, 'none');
  assert.equal(slice.workflow.actions[0].tool, 'ae_plan_new');
  assert.equal(slice.trust.trusted, false);
  assert.equal(slice.checkReadiness.status, 'missing');
  assert.equal(slice.checkReadiness.ready, false);
  assert.equal(slice.checkReadiness.remediation.owner, 'engineer');
  assert.equal(slice.planGoal, null);
  assert.equal(slice.neighborhood, null);
  assert.equal(slice.layout.boundRoot, fs.realpathSync.native(ws));
  assert.equal(path.relative(harnessHome, slice.layout.projectStore).split(path.sep)[0], 'projects');
  assert.deepEqual(slice.layout.roots, []);
  assert.equal(slice.layout.workspaceFile, null);
  assert.equal(slice.layout.domainSuggestion, null);
  assert.equal(fs.existsSync(path.join(ws, '.harness', 'repo-map.md')), false);
  assert.equal(fs.existsSync(path.join(ws, '.harness', 'context-pack.md')), false);
  assert.equal(fs.existsSync(path.join(ws, '.harness', 'session.json')), false);
});

test('edit passes --query and --file through orient and stores the task', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-adapter-home-'));
  const harnessHome = fs.mkdtempSync(path.join(os.tmpdir(), 'host-adapter-hh-'));
  const product = productWorkspace();
  const installed = harness(home, product, ['install', '--target', 'cli']);
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  const ws = coldRepo();
  const edited = spawnSync(process.execPath, [
    path.join(home, 'hooks', 'cursor.mjs'),
    'edit',
    '--query',
    'readme cold start',
    '--file',
    'README.md',
  ], {
    cwd: ws,
    input: JSON.stringify({ cwd: ws, workspace: ws, tool_name: 'read_file', file_path: 'README.md' }),
    encoding: 'utf8',
    env: {
      ...process.env,
      HARNESS_BIN: binPath,
      HARNESS_HOME: harnessHome,
      COPILOT_HOME: home,
      HARNESS_NO_EVENTS: '1',
    },
  });
  assert.equal(edited.status, 0, edited.stderr + edited.stdout);
  const body = JSON.parse(edited.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
  assert.equal(body.continue, true);
  assert.equal(body.neighborhood.files.some((file) => file.rel === 'README.md'), true);
  const session = JSON.parse(fs.readFileSync(path.join(ws, '.harness', 'session.json'), 'utf8'));
  assert.equal(session.lastQuery, 'readme cold start');
  assert.deepEqual(session.files, ['README.md']);
  assert.equal(fs.existsSync(path.join(ws, '.harness', 'repo-map.md')), false);
  assert.equal(fs.existsSync(path.join(ws, '.harness', 'context-pack.md')), false);
});
