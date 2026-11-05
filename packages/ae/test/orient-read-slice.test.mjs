import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { getCorpusRoot } from '../lib/assets.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');
const hooksRoot = path.join(packageRoot, 'corpus', 'hooks');
const readOnlySkip = process.platform === 'win32'
  ? 'chmod does not make a directory read-only on Windows'
  : typeof process.getuid === 'function' && process.getuid() === 0
    ? 'chmod is not enforced for root'
    : false;
const SLICE_KEYS = [
  'neighborhood',
  'graph',
  'intentSources',
  'intentDiscovery',
  'intentDetail',
  'verification',
  'planGoal',
  'trust',
  'checkReadiness',
  'reviewCoverage',
  'learnings',
  'skills',
  'procedure',
  'instructions',
  'contacts',
  'index',
  'gateStatus',
  'activePlan',
  'workflow',
  'layout',
];

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function coldRepo() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-orient-read-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-orient-read-copilot-'));
  const harnessHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-orient-read-home-'));
  fs.writeFileSync(path.join(ws, 'README.md'), 'cold\n');
  git(ws, ['init', '-q']);
  git(ws, ['config', 'user.email', 'e@x.test']);
  git(ws, ['config', 'user.name', 'T']);
  const committed = git(ws, ['add', 'README.md']);
  assert.equal(committed.status, 0, committed.stderr || committed.stdout);
  const done = git(ws, ['commit', '-qm', 'init']);
  assert.equal(done.status, 0, done.stderr || done.stdout);
  return { ws, home, harnessHome };
}

function removeRepo(c) {
  fs.rmSync(c.ws, { recursive: true, force: true });
  fs.rmSync(c.home, { recursive: true, force: true });
  fs.rmSync(c.harnessHome, { recursive: true, force: true });
}

function hookEnv(c, extra = {}) {
  return {
    ...process.env,
    HARNESS_BIN: binPath,
    HARNESS_HOME: c.harnessHome,
    COPILOT_HOME: c.home,
    HARNESS_NO_EVENTS: '1',
    ...extra,
  };
}

function orient(c, args = []) {
  return spawnSync(process.execPath, [
    binPath,
    'orient',
    ...args,
    '--json',
    '--no-events',
    '--workspace',
    c.ws,
    '--copilot-home',
    c.home,
    '--harness-home',
    c.harnessHome,
  ], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: c.harnessHome, COPILOT_HOME: c.home, HARNESS_NO_EVENTS: '1' },
  });
}

function runLoadContext(c, env = hookEnv(c)) {
  return spawnSync(process.execPath, [path.join(hooksRoot, 'load-context.mjs')], {
    cwd: c.ws,
    input: JSON.stringify({
      cwd: c.ws,
      session_id: 'vscode-session',
      hook_event_name: 'SessionStart',
    }),
    encoding: 'utf8',
    env,
    timeout: 20000,
  });
}

function sliceFrom(additionalContext) {
  const marker = 'harness-orient-slice: ';
  const start = String(additionalContext || '').indexOf(marker);
  assert.notEqual(start, -1, additionalContext);
  const line = additionalContext.slice(start + marker.length).split('\n')[0];
  return JSON.parse(line);
}

function assertColdSlice(slice, { contextVersion = 1 } = {}) {
  assert.deepEqual(Object.keys(slice).sort(), (contextVersion === 2 ? [...SLICE_KEYS, 'contextEvidence'] : SLICE_KEYS).slice().sort());
  assert.equal(slice.neighborhood, null);
  assert.deepEqual(slice.learnings, []);
  assert.deepEqual(slice.skills, []);
  assert.deepEqual(slice.instructions, []);
  assert.deepEqual(slice.contacts, []);
  assert.deepEqual(slice.index, { knowledge: 'missing', structural: 'missing' });
  assert.equal(slice.checkReadiness.status, 'missing');
  assert.equal(slice.checkReadiness.ready, false);
  assert.equal(slice.checkReadiness.remediation.owner, 'engineer');
  assert.equal(fs.existsSync(slice.checkReadiness.source), false, 'cold orientation must not initialize the missing check source');
  assert.equal(slice.gateStatus, 'blocked');
  assert.equal(slice.activePlan, null);
  assert.equal(slice.layout.kind, 'product-repo');
  assert.equal(slice.layout.workspaceType, 'none');
  assert.deepEqual(slice.layout.roots, []);
  assert.equal(slice.layout.domainSuggestion, null);
  assert.equal(typeof slice.layout.boundRoot, 'string');
  assert.equal(typeof slice.layout.projectStore, 'string');
  if (contextVersion === 2) {
    const evidence = slice.contextEvidence;
    assert.equal(evidence.schema, 'harness.context.v2');
    assert.match(evidence.contextId, /^[a-f0-9]{64}$/);
    assert.equal(evidence.sourceState.version, 1);
    assert.match(evidence.sourceState.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(evidence.task, { plan: null, contractDigest: null });
    assert.deepEqual(evidence.evidence, []);
    assert.equal(evidence.coverage.sourceState, 'validated');
    assert.equal(evidence.coverage.semanticCompleteness, 'unverified');
    assert.equal(evidence.coverage.renderBarrier, false);
    assert.deepEqual(evidence.coverage.failures, []);
    assert.equal(evidence.expansion.command, 'ae orient --read --context-version 2');
    assert.equal(evidence.expansion.sourceChanged, false);
  }
}

function assertNoOrientWrites(ws) {
  assert.equal(fs.existsSync(path.join(ws, '.harness', 'repo-map.md')), false);
  assert.equal(fs.existsSync(path.join(ws, '.harness', 'context-pack.md')), false);
  assert.equal(fs.existsSync(path.join(ws, '.harness', 'session.json')), false);
  assert.equal(fs.existsSync(path.join(ws, 'docs', 'plans')), false);
  assert.equal(fs.existsSync(path.join(ws, '.harness', 'plans')), false);
}

test('SessionStart injects the cold orient slice and does not write orient files', () => {
  const c = coldRepo();
  try {
    const result = runLoadContext(c);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(output.additionalContext, /Mode: Answer\|Investigate\|Review\|Deliver/);
    const slice = sliceFrom(output.additionalContext);
    assert.deepEqual(slice, sliceFrom(output.hookSpecificOutput.additionalContext));
    assertColdSlice(slice, { contextVersion: 2 });
    assertNoOrientWrites(c.ws);
  } finally {
    removeRepo(c);
  }
});

test('a broken index read still returns JSON with both labels missing', () => {
  const c = coldRepo();
  const failBin = path.join(c.harnessHome, 'fail-orient.mjs');
  fs.writeFileSync(failBin, "process.stderr.write('index read failed\\n'); process.exit(1);\n");
  try {
    const result = runLoadContext(c, hookEnv(c, { HARNESS_BIN: failBin }));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    const slice = sliceFrom(output.additionalContext);
    assert.equal(slice.neighborhood, null);
    assert.deepEqual(slice.index, { knowledge: 'missing', structural: 'missing' });
    assert.equal(slice.checkReadiness, null, 'unavailable orientation must not invent check readiness');
    assert.equal(slice.workflow, undefined, 'unavailable orientation must not invent workflow state');
    assert.deepEqual(Object.keys(slice), SLICE_KEYS.filter(key => key !== 'workflow'));
  } finally {
    removeRepo(c);
  }
});

test('getCorpusRoot returns the packaged corpus and does not rewrite it', () => {
  const source = path.join(packageRoot, 'corpus', 'hooks', 'load-context.mjs');
  const before = fs.readFileSync(source);
  const mtime = fs.statSync(source).mtimeMs;
  const root = getCorpusRoot();
  assert.equal(root, path.join(packageRoot, 'corpus'));
  assert.equal(fs.readFileSync(source).equals(before), true);
  assert.equal(fs.statSync(source).mtimeMs, mtime);
  assert.match(fs.readFileSync(path.join(root, 'hooks', 'lib', 'tool-payload.mjs'), 'utf8'), /unwrapShellSegments/);
});

test('ae orient --read --json on a cold repo prints neighborhood null and writes nothing', () => {
  const c = coldRepo();
  try {
    const result = spawnSync(process.execPath, [
      binPath,
      'orient',
      '--read',
      '--json',
      '--no-events',
      '--workspace',
      c.ws,
      '--copilot-home',
      c.home,
      '--harness-home',
      c.harnessHome,
    ], {
      encoding: 'utf8',
      env: { ...process.env, HARNESS_HOME: c.harnessHome, COPILOT_HOME: c.home, HARNESS_NO_EVENTS: '1' },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const slice = JSON.parse(result.stdout);
    assertColdSlice(slice);
    assert.equal('schema' in slice, false);
    assert.equal('status' in slice, false);
    assertNoOrientWrites(c.ws);
  } finally {
    removeRepo(c);
  }
});

test('an empty orient --read leaves an existing session file unchanged', () => {
  const c = coldRepo();
  try {
    const sessionPath = path.join(c.ws, '.harness', 'session.json');
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    const body = '{"version":1,"lastQuery":"keep"}\n';
    fs.writeFileSync(sessionPath, body);
    const result = orient(c, ['--read']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(sessionPath, 'utf8'), body);
    assert.equal(fs.existsSync(path.join(c.ws, '.harness', 'repo-map.md')), false);
    assert.equal(fs.existsSync(path.join(c.ws, '.harness', 'context-pack.md')), false);
  } finally {
    removeRepo(c);
  }
});

test('orient --read with a query stores the query and the file list only', () => {
  const c = coldRepo();
  try {
    const sessionPath = path.join(c.ws, '.harness', 'session.json');
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, `${JSON.stringify({ version: 1, activePlan: 'docs/plans/keep.md' }, null, 2)}\n`);
    const result = orient(c, ['--read', '--query', 'save skips the audit stamp', '--file', 'src/example.js']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    assert.equal(session.lastQuery, 'save skips the audit stamp');
    assert.deepEqual(session.files, ['src/example.js']);
    assert.equal(session.activePlan, 'docs/plans/keep.md');
    assert.equal(fs.existsSync(path.join(c.ws, '.harness', 'repo-map.md')), false);
    assert.equal(fs.existsSync(path.join(c.ws, '.harness', 'context-pack.md')), false);
  } finally {
    removeRepo(c);
  }
});

test('orient --read on a read-only workspace still returns the slice', { skip: readOnlySkip }, () => {
  const c = coldRepo();
  try {
    fs.chmodSync(c.ws, 0o555);
    const result = orient(c, ['--read', '--query', 'save skips the audit stamp']);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const slice = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(slice), SLICE_KEYS);
    assert.match(result.stderr, /repeat check was not armed/);
    assert.equal(fs.existsSync(path.join(c.ws, '.harness', 'session.json')), false);
    assert.equal(fs.existsSync(path.join(c.ws, '.harness', 'repo-map.md')), false);
    assert.equal(fs.existsSync(path.join(c.ws, '.harness', 'context-pack.md')), false);
  } finally {
    fs.chmodSync(c.ws, 0o755);
    removeRepo(c);
  }
});

test('intent detail retrieves an omitted long path and orientation does not prepare over it', t => {
  const c = coldRepo();
  t.after(() => removeRepo(c));
  const rel = ['specs', ...Array.from({ length: 3 }, () => '界'.repeat(60)), 'spec.md'].join('/');
  fs.mkdirSync(path.dirname(path.join(c.ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(c.ws, rel), '# Accepted intent\nKeep the public contract.\n');
  const compact = orient(c);
  assert.equal(compact.status, 0, compact.stderr);
  const current = JSON.parse(compact.stdout);
  assert.deepEqual(current.intentSources, []);
  assert.equal(current.intentDiscovery.candidateCount, 1);
  assert.equal(current.intentDiscovery.omittedCount, 1);
  assert.equal(current.nextTools.some(tool => tool.startsWith('ae prepare')), false);
  const priorSession = fs.readFileSync(path.join(c.ws, '.harness/session.json'), 'utf8');
  const page = orient(c, ['--read', '--intent-page', '1', '--intent-page-size', '1']);
  assert.equal(page.status, 0, page.stderr);
  assert.equal(JSON.parse(page.stdout).intentDetail.paths[0].path, rel);
  assert.equal(fs.readFileSync(path.join(c.ws, '.harness/session.json'), 'utf8'), priorSession);
  for (const bad of [['--intent-page', '0'], ['--intent-page-size', '33']]) assert.equal(orient(c, ['--read', ...bad]).status, 2);
});
