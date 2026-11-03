import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

test('clean installed package expands current context and rejects stale source references', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.resolve(import.meta.dirname, '..');
  const npm = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(npm);
  // Cold archive setup unpacks the bundled WASM/font assets; runtime CLI calls
  // below retain their own deadlines.
  const packed = spawnSync(process.execPath, [npm, 'pack', '--json', '--pack-destination', root], { cwd: packageRoot, encoding: 'utf8', timeout: 120000 });
  assert.ifError(packed.error);
  assert.equal(packed.status, 0, packed.stderr);
  const metadata = JSON.parse(packed.stdout)[0];
  const archive = path.join(root, metadata.filename);
  const installed = spawnSync(process.execPath, [npm, 'install', '--prefix', root, '--offline', '--ignore-scripts', '--omit=optional', archive], { encoding: 'utf8', timeout: 120000 });
  assert.ifError(installed.error);
  assert.equal(installed.status, 0, installed.stderr);
  const runtime = path.join(root, 'node_modules/ae-harness');
  const workspace = path.join(root, 'workspace'), copilotHome = path.join(root, 'copilot'), harnessHome = path.join(root, 'control');
  for (const dir of [workspace, copilotHome, harnessHome]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(workspace, 'a.mjs'), "import { item } from './b.mjs';\nexport const value = item;\n");
  fs.writeFileSync(path.join(workspace, 'b.mjs'), 'export const item = 1;\n');
  const env = { ...process.env, COPILOT_HOME: copilotHome, AE_HOME: harnessHome, HARNESS_HOME: harnessHome, HARNESS_NO_EVENTS: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'Context fixture', GIT_AUTHOR_EMAIL: 'context@example.test', GIT_COMMITTER_NAME: 'Context fixture', GIT_COMMITTER_EMAIL: 'context@example.test' };
  delete env.HARNESS_BIN;
  delete env.AE_BIN;
  const git = args => {
    const result = spawnSync('git', args, { cwd: workspace, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q']); git(['add', '.']); git(['commit', '-qm', 'fixture']);
  const unrelated = path.join(root, 'unrelated-repository');
  fs.mkdirSync(unrelated);
  const unrelatedGit = spawnSync('git', ['init', '-q'], { cwd: unrelated, env, encoding: 'utf8' });
  assert.equal(unrelatedGit.status, 0, unrelatedGit.stderr);
  fs.writeFileSync(path.join(root, 'inactive.code-workspace'), JSON.stringify({ folders: [{ path: workspace }, { path: unrelated }] }));
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [path.join(runtime, 'bin/ae.mjs'), ...args, '--workspace', workspace, '--copilot-home', copilotHome, '--ae-home', harnessHome, '--json', '--no-events'], { cwd: workspace, env, encoding: 'utf8', timeout: 30000 });
    if (process.env.HARNESS_PROOF_LOG) fs.appendFileSync(process.env.HARNESS_PROOF_LOG, JSON.stringify({ kind: 'installed-context', runtime, archiveIntegrity: metadata.integrity, args, status: result.status, stdout: result.stdout, stderr: result.stderr }) + '\n');
    return result;
  };
  const ok = (...args) => {
    const result = cli(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  ok('install');
  assert.ok(fs.existsSync(path.join(copilotHome, 'skills/references/context-budget.md')));
  const binding = ok('orient', '--read');
  assert.equal(Object.keys(binding).length, 19);
  assert.equal(binding.checkReadiness.status, 'missing');
  assert.equal(binding.checkReadiness.ready, false);
  assert.equal(binding.checkReadiness.sourceMode, 'local');
  assert.equal(fs.realpathSync.native(binding.checkReadiness.remediation.command[1]), fs.realpathSync.native(path.join(runtime, 'bin/ae.mjs')));
  assert.equal(binding.layout.boundRoot, fs.realpathSync.native(workspace));
  assert.equal(path.relative(harnessHome, binding.layout.projectStore).split(path.sep)[0], 'projects');
  assert.deepEqual(binding.layout.roots, []);
  assert.equal(binding.layout.workspaceFile, null);
  assert.equal(binding.layout.domainSuggestion, null);
  const started = spawnSync(process.execPath, [path.join(copilotHome, 'hooks/grok-build.mjs'), 'start'], {
    cwd: workspace, env, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(started.status, 0, started.stderr + started.stdout);
  assert.deepEqual(JSON.parse(started.stdout).layout, binding.layout);
  ok('index', '--structural');
  const context = ok('orient', '--read', '--context-version', '2', '--query', 'repair item', '--file', 'a.mjs');
  assert.equal(context.schema, 'harness.context.v2');
  assert.equal(context.coverage.sourceState, 'validated');
  const first = ok('search', 'item', '--source', 'code', '--match', 'literal', '--limit', '1', '--context-version', '2');
  assert.ok(first.nextCursor);
  const reference = first.results[0].evidence.reference;
  assert.ok(ok('get', '--path', reference, '--context-version', '2').evidence.sha256);
  fs.writeFileSync(path.join(workspace, 'a.mjs'), "import { item } from './new.mjs';\nexport const value = item;\n");
  fs.writeFileSync(path.join(workspace, 'new.mjs'), 'export const item = 3;\n');
  const staleRead = cli('get', '--path', reference, '--context-version', '2');
  assert.notEqual(staleRead.status, 0);
  assert.match(staleRead.stdout + staleRead.stderr, /changed/i);
  assert.notEqual(cli('search', 'item', '--source', 'code', '--match', 'literal', '--cursor', first.nextCursor, '--context-version', '2').status, 0);
  const current = ok('orient', '--read', '--context-version', '2', '--query', 'repair item', '--file', 'a.mjs', '--file', 'new.mjs');
  assert.equal(current.coverage.sourceState, 'validated');
  assert.ok(current.evidence.some(row => row.location === 'new.mjs' && row.state === 'readable'));
  assert.notEqual(current.contextId, context.contextId);
  const policy = ok('agent', 'repair item', '--dry-run', '--context-policy', 'selective', '--retention-policy', 'structured', '--file', 'a.mjs', '--file', 'new.mjs');
  assert.equal(policy.contextPolicy, 'selective');
  assert.ok(policy.context.files.some(row => row.location === 'new.mjs'));
  assert.ok(policy.context.bytes <= 16000);
  const largeBody = `export const marker = 1;\n${' '.repeat(200_000)}`;
  fs.writeFileSync(path.join(workspace, 'large.mjs'), largeBody);
  const large = ok('orient', '--read', '--context-version', '2', '--query', 'repair the large file', '--file', './large.mjs');
  const largeEvidence = large.evidence.find(row => row.location === 'large.mjs');
  assert.equal(large.coverage.sourceState, 'validated');
  assert.equal(largeEvidence.sha256, createHash('sha256').update(largeBody).digest('hex'));
  assert.equal(ok('get', '--path', largeEvidence.reference, '--context-version', '2').evidence.sha256, largeEvidence.sha256);
  fs.writeFileSync(path.join(workspace, 'large.mjs'), largeBody.replace('marker = 1', 'marker = 2'));
  assert.notEqual(cli('get', '--path', largeEvidence.reference, '--context-version', '2').status, 0);
  const document = path.join(copilotHome, 'knowledge/docs/solutions/lesson.md');
  fs.mkdirSync(path.dirname(document), { recursive: true });
  fs.writeFileSync(document, '# Reference lesson\n');
  fs.writeFileSync(path.join(copilotHome, 'knowledge/manifest.yaml'), 'entries:\n  - id: lesson-id\n    path: docs/solutions/lesson.md\n    title: reference lesson\n    scope: global\n');
  const knowledgeReference = ok('search', 'reference lesson', '--source', 'knowledge', '--context-version', '2').results[0].evidence.reference;
  assert.equal(ok('get', '--path', knowledgeReference).excerpt, '# Reference lesson\n');
  fs.writeFileSync(document, '# Changed lesson\n');
  assert.match(cli('get', '--path', knowledgeReference).stderr, /source changed/);
  const lock = path.join(runtime, 'lib/repo-map/grammars.lock');
  const lockBytes = fs.readFileSync(lock);
  for (const state of ['missing', 'unreadable']) {
    await t.test(`${state} grammar lock preserves CLI startup and the integrity diagnostic`, () => {
      fs.rmSync(lock);
      if (state === 'unreadable') fs.mkdirSync(lock);
      try {
        const help = cli('help', 'doctor');
        assert.equal(help.status, 0, help.stdout + help.stderr);
        const index = ok('index', '--structural');
        assert.equal(index.tier, 'lexical');
        assert.ok(index.integrityFailures.some(row => row.language === 'lock'));
        const doctor = cli('doctor');
        assert.notEqual(doctor.status, 0);
        const check = JSON.parse(doctor.stdout).checks.find(row => row.id === 'S1');
        assert.equal(check.pass, false);
        assert.notEqual(check.optional, true);
        assert.match(check.hint, /grammars.lock missing or unreadable/);
      } finally {
        fs.rmSync(lock, { recursive: true, force: true });
        fs.writeFileSync(lock, lockBytes);
      }
    });
  }
});
