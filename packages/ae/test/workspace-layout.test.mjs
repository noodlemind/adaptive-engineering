import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readOrientSlice } from '../lib/orient-read.mjs';
import { runOrient } from '../lib/orient.mjs';
import { estimateTokens } from '../lib/token-meter.mjs';
import { projectStoreDir } from '../lib/project-layout.mjs';
import { repoId } from '../lib/knowledge/store.mjs';
import { gitExecutable } from '../corpus/hooks/lib/git-executable.mjs';
import {
  classifyRepo,
  detectWorkspace,
  gradleIncludeCount,
  mavenModuleCount,
} from '../lib/workspace-layout.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');

function git(cwd, args) {
  const result = spawnSync(gitExecutable(), args, { cwd, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function tempRoot(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'layout-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initRepo(dir, origin) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  if (origin) git(dir, ['remote', 'add', 'origin', origin]);
  return fs.realpathSync.native(dir);
}

test('monorepo markers are file presence, package workspaces, repeated gradle includes, and maven modules', (t) => {
  const root = tempRoot(t);
  assert.equal(classifyRepo(root).kind, 'product-repo');
  assert.deepEqual(classifyRepo(root).markers, []);

  fs.writeFileSync(path.join(root, 'package.json'), '{ "workspaces": [] }\n');
  assert.equal(classifyRepo(root).kind, 'product-repo');
  fs.writeFileSync(path.join(root, 'package.json'), '{ "workspaces": ["packages/*"] }\n');
  assert.deepEqual(classifyRepo(root).markers, ['package.json']);
  fs.writeFileSync(path.join(root, 'package.json'), '{ "workspaces": { "packages": ["packages/*"] } }\n');
  assert.ok(classifyRepo(root).markers.includes('package.json'));
  fs.writeFileSync(path.join(root, 'package.json'), '{');
  assert.equal(classifyRepo(root).kind, 'product-repo');

  for (const name of ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json', 'MODULE.bazel', 'WORKSPACE', 'WORKSPACE.bazel']) {
    const dir = path.join(root, name.replace(/[^a-z.]/gi, '-'));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, name), '');
    assert.deepEqual(classifyRepo(dir).markers, [name], name);
    assert.equal(classifyRepo(dir).kind, 'monorepo');
  }

  const gradle = path.join(root, 'gradle-app');
  fs.mkdirSync(gradle);
  fs.writeFileSync(path.join(gradle, 'settings.gradle'), "include ':app'\nincludeBuild '../shared'\n");
  assert.equal(gradleIncludeCount(fs.readFileSync(path.join(gradle, 'settings.gradle'), 'utf8')), 1);
  assert.equal(classifyRepo(gradle).kind, 'product-repo');
  fs.writeFileSync(path.join(gradle, 'settings.gradle'), "// include ':hidden'\ninclude ':app', ':core'\n");
  assert.equal(classifyRepo(gradle).markers.includes('settings.gradle'), true);
  const kts = path.join(root, 'gradle-kts');
  fs.mkdirSync(kts);
  fs.writeFileSync(path.join(kts, 'settings.gradle.kts'), 'include(":app")\ninclude(":core")\n');
  assert.equal(classifyRepo(kts).kind, 'monorepo');

  const maven = path.join(root, 'maven-app');
  fs.mkdirSync(maven);
  fs.writeFileSync(path.join(maven, 'pom.xml'), '<project><!-- <modules><module>x</module></modules> --></project>\n');
  assert.equal(mavenModuleCount(fs.readFileSync(path.join(maven, 'pom.xml'), 'utf8')), 0);
  assert.equal(classifyRepo(maven).kind, 'product-repo');
  fs.writeFileSync(path.join(maven, 'pom.xml'), '<project><modules><module>child</module></modules></project>\n');
  assert.deepEqual(classifyRepo(maven).markers, ['pom.xml']);

  const linked = path.join(root, 'linked');
  fs.mkdirSync(linked);
  fs.writeFileSync(path.join(root, 'real-marker.yaml'), '');
  fs.symlinkSync(path.join(root, 'real-marker.yaml'), path.join(linked, 'pnpm-workspace.yaml'));
  assert.equal(classifyRepo(linked).kind, 'product-repo');
});

test('binding reports unknown for a non-repository without creating a store', (t) => {
  const parent = tempRoot(t), home = path.join(parent, 'home');
  const layout = detectWorkspace(parent, { home });
  assert.equal(layout.boundRoot, null);
  assert.equal(layout.projectStore, null);
  assert.equal(layout.kind, 'unknown');
  assert.equal(fs.existsSync(home), false);
});

test('unavailable storage bindings do not hide the observed repository', (t) => {
  const parent = tempRoot(t), home = path.join(parent, 'home');
  const alpha = initRepo(path.join(parent, 'repo-a'), 'https://example.invalid/team/alpha.git');
  fs.mkdirSync(path.join(home, 'storage-aliases'), { recursive: true });
  fs.writeFileSync(path.join(home, 'storage-aliases', `${repoId(alpha)}.json`), '{');
  const layout = detectWorkspace(alpha, { home });
  assert.equal(layout.boundRoot, alpha);
  assert.equal(layout.kind, 'product-repo');
  assert.equal(layout.projectStore, null);
});

test('full and read orientation report the same selected binding without a domain draft', (t) => {
  const parent = tempRoot(t), home = path.join(parent, 'home'), copilotHome = path.join(parent, 'copilot');
  const alpha = initRepo(path.join(parent, 'repo-a'));
  const beta = initRepo(path.join(parent, 'repo-b'));
  fs.mkdirSync(home); fs.mkdirSync(copilotHome);
  fs.writeFileSync(path.join(parent, 'dev.code-workspace'), JSON.stringify({ folders: [{ path: alpha }, { path: beta }] }));
  const flags = { workspace: alpha, home, copilotHome, dryRun: true };
  const full = runOrient({ workspace: alpha, copilotHome, flags, query: 'layout' });
  const read = readOrientSlice({ workspace: alpha, copilotHome, flags, query: 'layout' });
  const record = readOrientSlice({ workspace: alpha, copilotHome, flags: { ...flags, contextVersion: 2 }, query: 'layout' });
  for (const layout of [full.layout, read.layout, record.slice.layout]) {
    assert.equal(layout.boundRoot, alpha);
    assert.equal(layout.projectStore, projectStoreDir(alpha, { home }));
    assert.equal(layout.kind, 'product-repo');
    assert.equal(layout.workspaceType, 'none');
    assert.equal(layout.workspaceFile, null);
    assert.deepEqual(layout.roots, []);
    assert.equal(layout.domainSuggestion, null);
  }
  assert.equal(fs.existsSync(path.join(home, 'domains')), false);
});

test('shipped investigation guidance selects repositories by task relevance', () => {
  const engineer = fs.readFileSync(path.join(packageRoot, 'corpus/agents/engineer.agent.md'), 'utf8');
  assert.ok(estimateTokens(engineer) <= 900, `engineer is ${estimateTokens(engineer)} tokens`);
  assert.ok(Math.ceil(Buffer.byteLength(engineer) / 4) <= 900);
  for (const file of ['corpus/skills/references/playbooks/investigation.md', 'corpus/instructions/harness-global.instructions.md']) {
    const text = fs.readFileSync(path.join(packageRoot, file), 'utf8');
    assert.doesNotMatch(text, /one researcher per repo|When `ae orient` lists other Git roots|When `domainSuggestion` is present/);
    assert.match(text, /task|dependency/);
    assert.match(text, /Plans stay on the bound repo/);
  }
  const doc = fs.readFileSync(path.join(repoRoot, 'docs/reference/workspace-layout-detection.md'), 'utf8');
  assert.match(doc, /does not\s+discover saved workspaces/i);
  assert.match(doc, /projectStore/);
});

test('orientation keeps the bound repository when inactive saved workspaces list more roots', (t) => {
  const parent = tempRoot(t), home = path.join(parent, 'home');
  const alpha = initRepo(path.join(parent, 'repo-a'));
  const beta = initRepo(path.join(parent, 'repo-b'));
  const gamma = initRepo(path.join(parent, 'repo-c'));
  fs.writeFileSync(path.join(parent, 'active.code-workspace'), JSON.stringify({ folders: [{ path: './repo-a' }] }));
  fs.writeFileSync(path.join(parent, 'inactive.code-workspace'), JSON.stringify({ folders: [alpha, beta, gamma].map(root => ({ path: root })) }));
  fs.mkdirSync(path.join(parent, '.idea'));
  fs.writeFileSync(path.join(parent, '.idea', 'vcs.xml'), `<project><mapping directory="${beta}" vcs="Git" /></project>`);
  const originalRead = fs.readFileSync, originalOpen = fs.opendirSync, originalSpawn = childProcess.spawnSync;
  const executable = gitExecutable();
  const reads = [], directories = [], probes = [];
  fs.readFileSync = (file, ...args) => { reads.push(String(file)); return originalRead(file, ...args); };
  fs.opendirSync = (directory, ...args) => { directories.push(String(directory)); return originalOpen(directory, ...args); };
  childProcess.spawnSync = (command, args, options) => {
    if (command === executable) probes.push(options?.cwd);
    return originalSpawn(command, args, options);
  };
  syncBuiltinESMExports();
  let layout;
  try { layout = detectWorkspace(alpha, { home }); }
  finally {
    fs.readFileSync = originalRead; fs.opendirSync = originalOpen; childProcess.spawnSync = originalSpawn;
    syncBuiltinESMExports();
  }
  assert.equal(layout.boundRoot, alpha);
  assert.equal(layout.projectStore, projectStoreDir(alpha, { home }));
  assert.equal(layout.workspaceType, 'none');
  assert.equal(layout.workspaceFile, null);
  assert.deepEqual(layout.roots, []);
  assert.equal(layout.domainSuggestion, null);
  assert.deepEqual(directories, [], 'binding does not enumerate workspace candidates');
  assert.ok(reads.every(file => !file.endsWith('.code-workspace') && !file.endsWith('vcs.xml')), 'saved editor configuration is not task scope');
  assert.ok(probes.every(cwd => cwd !== beta && cwd !== gamma), 'no other repository is probed');
  assert.equal(fs.existsSync(path.join(home, 'domains')), false);
});

test('binding reports the aliased project store in the selected home', (t) => {
  const parent = tempRoot(t), home = path.join(parent, 'selected-home');
  const alpha = initRepo(path.join(parent, 'repo-a'), 'https://example.invalid/team/alpha.git');
  const id = repoId(alpha), storageId = 'local-123456789abc';
  const projectStore = path.join(home, 'projects', storageId);
  fs.mkdirSync(path.join(home, 'storage-aliases'), { recursive: true });
  fs.mkdirSync(projectStore, { recursive: true });
  fs.writeFileSync(path.join(projectStore, 'saved.md'), 'existing private record\n');
  fs.writeFileSync(path.join(home, 'storage-aliases', `${id}.json`), JSON.stringify({ schema: 1, repoId: id, storageId }));
  const layout = detectWorkspace(alpha, { home });
  assert.equal(layout.projectStore, projectStore);
  assert.equal(projectStoreDir(alpha, { home }), projectStore);
  assert.equal(fs.existsSync(path.join(home, 'projects', id)), false);
});

test('unrelated saved workspaces do not change task context identity', (t) => {
  const parent = tempRoot(t), home = path.join(parent, 'home'), copilotHome = path.join(parent, 'copilot');
  const alpha = initRepo(path.join(parent, 'repo-a'));
  const beta = initRepo(path.join(parent, 'repo-b'));
  fs.mkdirSync(copilotHome);
  const flags = { home, contextVersion: 2, dryRun: true };
  const before = readOrientSlice({ workspace: alpha, copilotHome, flags, query: 'explain this repository' });
  fs.writeFileSync(path.join(parent, 'unrelated.code-workspace'), JSON.stringify({ folders: [{ path: alpha }, { path: beta }] }));
  const after = readOrientSlice({ workspace: alpha, copilotHome, flags, query: 'explain this repository' });
  assert.equal(after.contextId, before.contextId);
  assert.deepEqual(after.slice.layout, before.slice.layout);
});
