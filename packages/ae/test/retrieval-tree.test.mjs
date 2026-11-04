import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { runTree, MAX_DEPTH, MAX_NODES, DEFAULT_DEPTH, TREE_SUBJECTS } from '../lib/retrieval/tree.mjs';
import { listRepoFiles, MAX_FILES_SCANNED } from '../lib/repo-map/scan.mjs';
import { storeDir, serializeLearning, repoId } from '../lib/knowledge/store.mjs';
import { runHarness } from './helpers/cli.mjs';

// Neutralize host git config, same as every other suite.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function initRepo(ws) {
  fs.mkdirSync(ws, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: ws, env: GIT_ENV });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: ws, env: GIT_ENV });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: ws, env: GIT_ENV });
}

function write(root, rel, body) {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

/** Tracked source files at five nesting levels, plus untracked build output. */
function fixture(t, prefix = 'harness-tree-') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  const home = path.join(tmp, 'home');
  const copilotHome = path.join(tmp, 'copilot');
  initRepo(ws);
  for (const rel of ['a.mjs', 'lib/b.mjs', 'lib/deep/c.mjs', 'lib/deep/deeper/d.mjs', 'lib/deep/deeper/deepest/e.mjs']) {
    write(ws, rel, `export const x = ${JSON.stringify(rel)};\n`);
  }
  execFileSync('git', ['add', '-A'], { cwd: ws, env: GIT_ENV });
    write(ws, 'dist/bundle.mjs', 'export const built = 1;\n');
  return { tmp, ws, home, copilotHome };
}

const names = (node) => node.children.map((c) => c.name);
const child = (node, name) => node.children.find((c) => c.name === name);

test('tree CLI preserves boolean ordering and literal option-shaped targets', t => {
  const { ws, home, copilotHome } = fixture(t);
  write(ws, '--files/literal.mjs', 'export const literal = true;\n');
  execFileSync('git', ['add', '--', '--files/literal.mjs'], { cwd: ws, env: GIT_ENV });
  const cli = argv => runHarness(['tree', '--workspace', ws, '--ae-home', home, '--copilot-home', copilotHome, '--json', '--no-events', ...argv], {
    cwd: ws, env: GIT_ENV, trust: false, injectHome: false,
  });
  const canonical = cli(['workspace', '--files']);
  const reordered = cli(['--files', 'workspace']);
  assert.equal(reordered.status, 0, reordered.stderr);
  assert.deepEqual(JSON.parse(reordered.stdout).files, JSON.parse(canonical.stdout).files);
  const literal = cli(['workspace', '--', '--files']);
  assert.equal(literal.status, 0, literal.stderr);
  const result = JSON.parse(literal.stdout);
  assert.equal(result.files, undefined);
  assert.equal(result.target, '--files');
  assert.deepEqual(names(result.root), ['literal.mjs']);
  const missingDepth = cli(['workspace', '--depth']);
  assert.equal(missingDepth.status, 2, missingDepth.stdout + missingDepth.stderr);
});

test('tree CLI does not read depth options beyond the literal boundary', t => {
  const { ws, home, copilotHome } = fixture(t);
  write(ws, '--depth=1/visible.mjs', 'export const visible = true;\n');
  execFileSync('git', ['add', '--', '--depth=1/visible.mjs'], { cwd: ws, env: GIT_ENV });
  const result = runHarness(['tree', 'workspace', '--workspace', ws, '--ae-home', home, '--copilot-home', copilotHome,
    '--json', '--no-events', '--', '--depth=1'], { cwd: ws, env: GIT_ENV, trust: false, injectHome: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).depth, DEFAULT_DEPTH);
  assert.equal(JSON.parse(result.stdout).target, '--depth=1');
});

test('tree workspace renders tracked source only, directories first, name-ordered', (t) => {
  const { ws, home, copilotHome } = fixture(t);
  const out = runTree({ subject: 'workspace', workspace: ws, home, copilotHome });

  assert.equal(out.subject, 'workspace');
  assert.equal(out.root.name, '.');
  assert.equal(out.root.type, 'dir');
  assert.deepEqual(names(out.root), ['lib', 'a.mjs'], 'directories precede files, then name order');
  assert.ok(!names(out.root).includes('dist'), 'untracked build output never enters the tree');
  assert.deepEqual(out.root.counts, { files: 5, dirs: 4 }, 'root counts every tracked file and directory beneath it');
  assert.equal(out.totals.files, 5);
  assert.equal(out.totals.dirs, 4);
  assert.equal(out.truncated, false);
  assert.equal(out.depth, DEFAULT_DEPTH);

  const leaf = child(out.root, 'a.mjs');
  assert.equal(leaf.type, 'file');
  assert.deepEqual(leaf.children, [], 'a file is a node with no children, not a special case');
});

test('depth bounds the rendered levels while counts still describe what was elided', (t) => {
  const { ws, home, copilotHome } = fixture(t);
  const out = runTree({ subject: 'workspace', depth: 3, workspace: ws, home, copilotHome });

  const deeper = child(child(child(out.root, 'lib'), 'deep'), 'deeper');
  assert.ok(deeper, 'a directory AT the depth bound is still shown');
  assert.deepEqual(deeper.children, [], 'its contents sit below the bound');
  assert.deepEqual(deeper.counts, { files: 2, dirs: 1 }, 'but it still reports what is inside');

  const shallow = runTree({ subject: 'workspace', depth: 1, workspace: ws, home, copilotHome });
  assert.deepEqual(names(shallow.root), ['lib', 'a.mjs']);
  assert.deepEqual(child(shallow.root, 'lib').children, [], 'depth 1 renders one level of children');
  assert.equal(shallow.totals.files, 5, 'totals are the corpus, not the rendered slice');
});

test('an out-of-range or non-numeric depth is a usage error, never a silent default', (t) => {
  const { ws, home, copilotHome } = fixture(t);
  const call = (depth) => runTree({ subject: 'workspace', depth, workspace: ws, home, copilotHome });

  assert.throws(() => call(MAX_DEPTH + 1), (err) => {
    assert.equal(err.code, 'E_USAGE');
    assert.equal(err.exit, 2);
    assert.match(err.message, /exceeds the maximum of 10/);
    return true;
  });
  assert.throws(() => call(999), /exceeds the maximum/);
  for (const bad of ['deep', 2.5, 0, -1]) {
    assert.throws(() => call(bad), (err) => err.code === 'E_USAGE', `depth ${bad} must be refused`);
  }
  assert.equal(call(MAX_DEPTH).depth, MAX_DEPTH, 'the boundary value itself is allowed');
});

test('a path escaping the workspace is refused, not answered with an empty tree', (t) => {
  const { ws, home, copilotHome } = fixture(t);
  for (const bad of ['../outside', 'lib/../../outside', '/etc', 'lib/../..']) {
    assert.throws(() => runTree({ subject: 'workspace', target: bad, workspace: ws, home, copilotHome }), (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.match(err.message, /escapes the workspace/);
      return true;
    }, `${bad} must be refused`);
  }

  const scoped = runTree({ subject: 'workspace', target: 'lib/deep', workspace: ws, home, copilotHome });
  assert.equal(scoped.root.name, 'lib/deep', 'an in-workspace path scopes the tree to that subtree');
  assert.deepEqual(names(scoped.root), ['deeper', 'c.mjs']);
  assert.equal(runTree({ subject: 'workspace', target: '.', workspace: ws, home, copilotHome }).root.name, '.');
});

test('an unknown subject names the subjects that exist', (t) => {
  const { ws, home, copilotHome } = fixture(t);
  assert.throws(() => runTree({ subject: 'plans', workspace: ws, home, copilotHome }), (err) => {
    assert.equal(err.code, 'E_USAGE');
    assert.match(err.message, /unknown tree subject: plans/);
    assert.match(err.hint, /workspace or knowledge/);
    return true;
  });
    assert.throws(() => runTree({ subject: 'run', workspace: ws, home, copilotHome }), (err) => {
    assert.match(err.hint, /Phase 4a/);
    return true;
  });
  // Bare tree defaults to workspace subject (TUX: tree without args is usable).
  const bare = runTree({ workspace: ws, home, copilotHome });
  assert.equal(bare.subject, 'workspace');
  assert.deepEqual([...TREE_SUBJECTS], ['workspace', 'knowledge']);
});

// --- knowledge -------------------------------------------------------------

function manifest(copilotHome, entries, workspace) {
  const lines = ['updated: 2026-01-01', ...(workspace ? [`repository: ${JSON.stringify(repoId(workspace))}`] : []), 'entries:'];
  for (const e of entries) {
    lines.push(`  - docid: ${e.docid}`);
    lines.push(`    kind: ${e.kind || 'solution'}`);
    lines.push(`    scope: ${e.scope}`);
    lines.push(`    path: ${e.path}`);
    lines.push(`    title: ${JSON.stringify(e.title)}`);
    lines.push(`    category: ${e.category}`);
    if (e.tags?.length) lines.push(`    tags: [${e.tags.map((tg) => JSON.stringify(tg)).join(', ')}]`);
  }
  write(copilotHome, 'knowledge/manifest.yaml', `${lines.join('\n')}\n`);
}

function collections(copilotHome, body) {
  write(copilotHome, 'knowledge/collections.yaml', body);
}

function seedKnowledge(copilotHome, workspace) {
  manifest(copilotHome, [
    { docid: 'zeta-fix', scope: 'global', path: 'solutions/patterns/zeta.md', title: 'Zeta fix', category: 'patterns', tags: ['db'] },
    { docid: 'alpha-fix', scope: 'global', path: 'solutions/patterns/alpha.md', title: 'Alpha fix', category: 'patterns', tags: ['db'] },
    { docid: 'beta-note', scope: 'global', path: 'solutions/testing/beta.md', title: 'Beta note', category: 'testing', tags: ['test'] },
    { docid: 'local-note', scope: 'product', path: 'docs/solutions/local.md', title: 'Local note', category: 'testing', tags: ['test'] },
  ], workspace);
  collections(
    copilotHome,
    ['collections:', '  db-only:', '    tags: [db]', '  product-only:', '    scope: product', ''].join('\n'),
  );
}

/** Write learning files straight through the store's own serializer. */
function seedLearnings(ws, home, entries) {
  const dir = storeDir(ws, { home });
  for (const e of entries) {
    const body = serializeLearning({ trigger: e.trigger, status: e.status || 'active' }, e.body || 'Do the thing.');
    write(dir, `learnings/${e.domain}/${e.slug}.md`, body);
  }
  return dir;
}

test('tree knowledge groups the manifest by scope then category', (t) => {
  const { ws, home, copilotHome } = fixture(t);
  seedKnowledge(copilotHome, ws);
  const out = runTree({ subject: 'knowledge', workspace: ws, home, copilotHome });

  assert.equal(out.root.name, 'knowledge');
  assert.deepEqual(names(out.root), ['global', 'product'], 'scope is the first grouping level');
  const global = child(out.root, 'global');
  assert.equal(global.kind, 'scope');
  assert.deepEqual(names(global), ['patterns', 'testing'], 'category is the second');
  const patterns = child(global, 'patterns');
  assert.equal(patterns.kind, 'category');
  assert.deepEqual(names(patterns), ['alpha-fix', 'zeta-fix'], 'documents are leaves, name-ordered');
  const doc = child(patterns, 'alpha-fix');
  assert.equal(doc.type, 'file');
  assert.equal(doc.kind, 'document');
  assert.equal(doc.title, 'Alpha fix');
  assert.equal(doc.location, 'solutions/patterns/alpha.md');
  assert.equal(out.totals.files, 4);
  assert.deepEqual(out.collections, ['db-only', 'product-only']);
  assert.equal(out.learningsStore, false, 'no store here, so no learnings group');
});

test('a named collection filters the corpus; an unknown one names the real ones', (t) => {
  const { ws, home, copilotHome } = fixture(t);
  seedKnowledge(copilotHome, ws);

  const filtered = runTree({ subject: 'knowledge', target: 'product-only', workspace: ws, home, copilotHome });
  assert.deepEqual(names(filtered.root), ['product'], 'only the collection\'s entries survive');
  assert.equal(filtered.totals.files, 1);
  assert.equal(filtered.target, 'product-only');

  assert.throws(() => runTree({ subject: 'knowledge', target: 'nope', workspace: ws, home, copilotHome }), (err) => {
    assert.equal(err.code, 'E_NOT_FOUND');
    assert.equal(err.exit, 9);
    assert.match(err.message, /unknown knowledge collection: nope/);
    assert.match(err.hint, /db-only, product-only/);
    return true;
  });
});

test('a collection filter against a workspace with no collections says so', (t) => {
  const { ws, home, copilotHome } = fixture(t);
  manifest(copilotHome, [{ docid: 'a', scope: 'global', path: 'a.md', title: 'A', category: 'patterns' }]);
  assert.throws(() => runTree({ subject: 'knowledge', target: 'anything', workspace: ws, home, copilotHome }), (err) => {
    assert.equal(err.code, 'E_NOT_FOUND');
    assert.match(err.hint, /no collections are defined/);
    return true;
  });
});

test('the learnings store is grouped by domain when one exists', (t) => {
  const { ws, home, copilotHome } = fixture(t);
  seedKnowledge(copilotHome, ws);
  seedLearnings(ws, home, [
    { domain: 'testing', slug: 'flaky-clock', trigger: 'a clock-dependent test flakes' },
    { domain: 'db', slug: 'lock-order', trigger: 'two transactions deadlock', status: 'quarantined' },
  ]);

  const out = runTree({ subject: 'knowledge', workspace: ws, home, copilotHome });
  assert.equal(out.learningsStore, true);
  const learnings = child(out.root, 'learnings');
  assert.deepEqual(names(learnings), ['db', 'testing'], 'domain is the grouping level');
  const one = child(child(learnings, 'testing'), 'flaky-clock');
  assert.equal(one.kind, 'learning');
  assert.equal(one.title, 'a clock-dependent test flakes');
  assert.equal(child(child(learnings, 'db'), 'lock-order').status, 'quarantined', 'governance state is visible in place');
  assert.equal(out.totals.files, 6, 'documents and learnings share one count');

    const filtered = runTree({ subject: 'knowledge', target: 'db-only', workspace: ws, home, copilotHome });
  assert.equal(child(filtered.root, 'learnings'), undefined);
});

test('free text sourced from file content is redacted before it is returned', (t) => {
  const { ws, home, copilotHome } = fixture(t);
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  manifest(copilotHome, [
    { docid: 'leaky', scope: 'global', path: `solutions/${secret}.md`, title: `token ${secret}`, category: 'patterns' },
  ]);
  seedLearnings(ws, home, [{ domain: 'creds', slug: 'leak', trigger: `pasted ${secret} into a log` }]);

  const out = runTree({ subject: 'knowledge', workspace: ws, home, copilotHome });
  const json = JSON.stringify(out);
  assert.doesNotMatch(json, /ghp_abcdefghij/, 'no rendered field may carry the credential');
  assert.match(json, /redacted/);
});

// --- determinism, bounding, and the read-path invariant ---------------------

test('the same corpus renders byte-identically across runs', (t) => {
  const { ws, home, copilotHome } = fixture(t);
  seedKnowledge(copilotHome, ws);
  seedLearnings(ws, home, [
    { domain: 'testing', slug: 'zzz-last', trigger: 'z' },
    { domain: 'testing', slug: 'aaa-first', trigger: 'a' },
  ]);
  const run = (args) => JSON.stringify(runTree({ workspace: ws, home, copilotHome, ...args }));

  for (const args of [{ subject: 'workspace' }, { subject: 'workspace', depth: 2 }, { subject: 'knowledge' }]) {
    assert.equal(run(args), run(args), `${args.subject} must be byte-identical across runs`);
  }
});

test('output is capped at MAX_NODES and reports the cap instead of returning it all', (t) => {
  const { ws, home, copilotHome } = fixture(t);
    const entries = [];
  for (let i = 0; i < MAX_NODES + 50; i += 1) {
    const id = String(i).padStart(5, '0');
    entries.push({ docid: `doc-${id}`, scope: 'global', path: `solutions/patterns/${id}.md`, title: `Doc ${id}`, category: 'patterns' });
  }
  manifest(copilotHome, entries);

  const out = runTree({ subject: 'knowledge', workspace: ws, home, copilotHome });
  assert.equal(out.truncated, true, 'a tree that did not fit must say so');
  assert.equal(out.totals.nodes, MAX_NODES, 'exactly the ceiling is returned');
  assert.equal(out.limits.maxNodes, MAX_NODES);
  assert.equal(out.limits.nodesDropped, entries.length + 3 - MAX_NODES, 'the shortfall is stated, not implied');
  assert.equal(out.totals.files, entries.length, 'totals still describe the whole corpus');

    const patterns = child(child(out.root, 'global'), 'patterns');
  assert.equal(patterns.children[0].name, 'doc-00000');
  assert.ok(runTree({ subject: 'knowledge', maxNodes: 5, workspace: ws, home, copilotHome }).totals.nodes <= 5);
  assert.equal(
    runTree({ subject: 'knowledge', maxNodes: 1e9, workspace: ws, home, copilotHome }).totals.nodes,
    MAX_NODES,
    'an override may only tighten the ceiling, never raise it',
  );
});

test('tree never creates the knowledge store or any directory', (t) => {
  const { tmp, ws, home, copilotHome } = fixture(t);
  seedKnowledge(copilotHome, ws);
  const dir = storeDir(ws, { home });
  assert.equal(fs.existsSync(dir), false, 'precondition: no store');
  assert.equal(fs.existsSync(home), false, 'precondition: no harness home at all');

  const before = fs.readdirSync(tmp).sort();
  const out = runTree({ subject: 'knowledge', workspace: ws, home, copilotHome });
  runTree({ subject: 'workspace', workspace: ws, home, copilotHome });

  assert.equal(out.learningsStore, false, 'the absent store is reported, not filled in');
  assert.equal(child(out.root, 'learnings'), undefined, 'and simply omitted from the tree');
  assert.equal(fs.existsSync(dir), false, 'the store directory must still not exist');
  assert.equal(fs.existsSync(home), false, 'nor the home that would contain it');
  assert.equal(fs.existsSync(path.join(ws, 'knowledge')), false, 'nor a workspace-local knowledge root');
  assert.deepEqual(fs.readdirSync(tmp).sort(), before, 'navigation left the filesystem untouched');
});

test('an empty corpus is a valid empty tree, not an error', (t) => {
  const { ws, home, copilotHome } = fixture(t);
  const out = runTree({ subject: 'knowledge', workspace: ws, home, copilotHome });
  assert.deepEqual(out.root.children, []);
  assert.deepEqual(out.totals, { files: 0, dirs: 0, nodes: 1 });
  assert.equal(out.truncated, false);
  assert.equal(out.manifest, null, 'a corpus with no manifest says so rather than inventing a path');

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tree-bare-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  const nonRepo = runTree({ subject: 'workspace', workspace: bare, home, copilotHome });
  assert.deepEqual(nonRepo.root.children, [], 'a workspace git cannot enumerate yields an empty tree, not a throw');
});

test('tree --files applies the folder filter before the path cap', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tree-cap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initRepo(root);
  for (let i = 0; i <= MAX_FILES_SCANNED; i += 1) {
    write(root, `early/${String(i).padStart(5, '0')}.txt`, 'x\n');
  }
  write(root, 'late-extra/nope.mjs', 'nope\n');
  write(root, 'late/keep.mjs', 'keep\n');
  const unscoped = listRepoFiles(root);
  assert.equal(unscoped.truncated, true);
  assert.equal(unscoped.files.includes('late/keep.mjs'), false);
  const out = runTree({ subject: 'workspace', workspace: root, files: true, target: 'late' });
  assert.deepEqual(out.files, ['late/keep.mjs']);
  assert.equal(out.total, 1);
  assert.equal(out.truncated, false);
});
