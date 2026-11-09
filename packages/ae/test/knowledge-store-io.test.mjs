/**
 * Knowledge store-io lock, quarantine, and write path safety.
 * Folded from knowledge-store-io-hardening.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { applyOps, rebuildIndex } from '../lib/knowledge/apply.mjs';
import { absorbHandEdits } from '../lib/knowledge/admin.mjs';
import { setLearningStatus } from '../lib/knowledge/lifecycle.mjs';
import { ensureBucket } from '../lib/knowledge/layer.mjs';
import {
  ensureStore,
  storeDir,
  listLearnings,
  parsePorcelainZ,
  withStoreTransaction,
  writeStoreConfig,
  readStoreConfig,
  readLedger,
  readGovernance,
  writeStaleExclusions,
  readStaleExclusions,
  acquireStoreLock,
  observeStaleLock,
  takeOverStaleLock,
  lockOwnership,
  commitStore,
} from '../lib/knowledge/store.mjs';
import { QUARANTINE_DIR, findSymlinkedStoreDirectories, storePathParts, writeStoreFile } from '../lib/knowledge/store-io.mjs';
import { appendFileContained } from '../lib/fs-safe.mjs';
import { tempDir, git, writeOps, storeScopes, packageRoot } from './helpers/index.mjs';

const ctx = () => storeScopes({ prefix: 'sio-' });

function EP(ws, rel) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const content = `fix evidence body for ${rel}.\n`;
  fs.writeFileSync(full, content, 'utf8');
  return { path: rel, sha256: crypto.createHash('sha256').update(content).digest('hex'), kind: 'fix', plan: 'docs/plans/p1.md' };
}

function seedLearning(c, slug = 'seeded-claim') {
  const res = applyOps({
    workspace: c.ws,
    opsPath: writeOps(c.ws, [
      {
        op: 'ADD',
        domain: 'sql',
        slug,
        trigger: `trigger for ${slug}`,
        body: `Claim body for ${slug}.`,
        episodes: [EP(c.ws, `docs/solutions/perf/${slug}.md`)],
      },
    ]),
    home: c.harnessHome,
  });
  assert.equal(res.exitCode, 0, JSON.stringify(res.rejected));
  return `sql/${slug}`;
}

/** A file OUTSIDE the store that a planted symlink points at. */
function outsideFile(name = 'zshrc') {
  const dir = tempDir('sio-outside-');
  const full = path.join(dir, name);
  const content = `# precious outside content for ${name}\nexport TOKEN=keepme\n`;
  fs.writeFileSync(full, content, 'utf8');
  return { full, content };
}

function plantSymlink(target, at) {
  fs.rmSync(at, { force: true });
  fs.symlinkSync(target, at);
}

function quarantined(dir) {
  const q = path.join(dir, QUARANTINE_DIR);
  return fs.existsSync(q) ? fs.readdirSync(q) : [];
}

test('R1: a symlinked INDEX.md cannot be written through — the outside target survives a retire', () => {
  const c = ctx();
  const id = seedLearning(c, 'index-victim');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const victim = outsideFile('zshrc');

  plantSymlink(victim.full, path.join(dir, 'INDEX.md'));

  const res = setLearningStatus({ workspace: c.ws, id, action: 'retire', reason: 'cleanup', home: c.harnessHome });
  assert.equal(res.pass, true, res.blockedReason || '');

  assert.equal(fs.readFileSync(victim.full, 'utf8'), victim.content, 'the outside file must be byte-identical');
  assert.equal(fs.lstatSync(path.join(dir, 'INDEX.md')).isSymbolicLink(), false, 'the planted link must not still stand at INDEX.md');
  assert.ok(quarantined(dir).some((f) => f.includes('INDEX.md')), 'the planted link is quarantined, not left live');
});

test('R1: a symlinked consolidated.jsonl cannot be appended through', () => {
  const c = ctx();
  seedLearning(c, 'ledger-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const victim = outsideFile('bashrc');

  plantSymlink(victim.full, path.join(dir, 'consolidated.jsonl'));

  const res = applyOps({
    workspace: c.ws,
    opsPath: writeOps(c.ws, [
      {
        op: 'ADD',
        domain: 'sql',
        slug: 'ledger-victim',
        trigger: 'trigger for ledger-victim',
        body: 'Claim body for ledger-victim.',
        episodes: [EP(c.ws, 'docs/solutions/perf/ledger-victim.md')],
      },
    ]),
    home: c.harnessHome,
  });
  assert.equal(res.exitCode, 0, JSON.stringify(res.rejected));

  assert.equal(fs.readFileSync(victim.full, 'utf8'), victim.content, 'the outside file must be byte-identical');
  assert.equal(fs.lstatSync(path.join(dir, 'consolidated.jsonl')).isSymbolicLink(), false);
  assert.ok(readLedger(dir).some((e) => e.learning === 'sql/ledger-victim'), 'the ledger entry still landed in the real store file');
});

test('R1: a symlinked governance.jsonl cannot be appended through', () => {
  const c = ctx();
  const id = seedLearning(c, 'gov-victim');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const victim = outsideFile('profile');

  plantSymlink(victim.full, path.join(dir, 'governance.jsonl'));

  const res = setLearningStatus({ workspace: c.ws, id, action: 'dispute', reason: 'wrong', home: c.harnessHome });
  assert.equal(res.pass, true, res.blockedReason || '');

  assert.equal(fs.readFileSync(victim.full, 'utf8'), victim.content, 'the outside file must be byte-identical');
  assert.equal(fs.lstatSync(path.join(dir, 'governance.jsonl')).isSymbolicLink(), false);
  assert.equal(readGovernance(dir).get(id)?.action, 'dispute', 'the decision still landed in the real store file');
});

test('R1: a symlinked config.json cannot be written through', () => {
  const c = ctx();
  seedLearning(c, 'config-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const victim = outsideFile('gitconfig');

  plantSymlink(victim.full, path.join(dir, 'config.json'));

  const res = writeStoreConfig(c.ws, { home: c.harnessHome, mode: 'freeze' });
  assert.equal(res.pass, true, res.blockedReason || '');

  assert.equal(fs.readFileSync(victim.full, 'utf8'), victim.content, 'the outside file must be byte-identical');
  assert.equal(fs.lstatSync(path.join(dir, 'config.json')).isSymbolicLink(), false);
  assert.equal(readStoreConfig(c.ws, { home: c.harnessHome }).mode, 'freeze');
});

test('R1: a symlinked stale.json cannot be written through', () => {
  const c = ctx();
  seedLearning(c, 'stale-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const victim = outsideFile('netrc');

  plantSymlink(victim.full, path.join(dir, 'stale.json'));
  writeStaleExclusions(dir, { excluded: { 'sql/stale-anchor': ['a.ts'] } });

  assert.equal(fs.readFileSync(victim.full, 'utf8'), victim.content, 'the outside file must be byte-identical');
  assert.equal(fs.lstatSync(path.join(dir, 'stale.json')).isSymbolicLink(), false);
  assert.deepEqual(readStaleExclusions(dir).excluded['sql/stale-anchor'], ['a.ts']);
});

test('R1: a symlinked bucket meta.json / INDEX.md cannot be written through', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const metaVictim = outsideFile('meta-target');
  const indexVictim = outsideFile('index-target');

  const bucketDir = path.join(dir, 'branches', 'feature-x');
  fs.mkdirSync(bucketDir, { recursive: true });
  plantSymlink(metaVictim.full, path.join(bucketDir, 'meta.json'));
  plantSymlink(indexVictim.full, path.join(bucketDir, 'INDEX.md'));

  ensureBucket(dir, { key: 'feature-x', branch: 'feature/x', baseSha: null });
  rebuildIndex(bucketDir);

  assert.equal(fs.readFileSync(metaVictim.full, 'utf8'), metaVictim.content, 'meta.json target must be byte-identical');
  assert.equal(fs.readFileSync(indexVictim.full, 'utf8'), indexVictim.content, 'INDEX.md target must be byte-identical');
  assert.equal(fs.lstatSync(path.join(bucketDir, 'meta.json')).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(path.join(bucketDir, 'INDEX.md')).isSymbolicLink(), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(bucketDir, 'meta.json'), 'utf8')).branchKey, 'feature-x');
});

const RAW_FS_ALLOW = new Map([
    ['knowledge/store-io.mjs', ['lstatSync', 'mkdirSync', 'readdirSync', 'renameSync', 'rmSync']],
    ['knowledge/store.mjs', ['existsSync', 'mkdirSync', 'readdirSync', 'realpathSync', 'renameSync', 'rmSync', 'statSync']],
    ['knowledge/admin.mjs', ['cpSync', 'existsSync', 'mkdirSync', 'readdirSync', 'renameSync', 'rmSync', 'rmdirSync']],
    ['knowledge/apply.mjs', ['existsSync', 'readFileSync']],
    ['knowledge/remember.mjs', ['existsSync', 'mkdirSync', 'readFileSync', 'rmSync', 'writeFileSync']],
  ['knowledge/consolidate.mjs', ['existsSync', 'readdirSync']],
  ['knowledge/eval.mjs', ['existsSync']],
  ['knowledge/layer.mjs', ['existsSync', 'mkdirSync', 'renameSync']],
  ['knowledge/lifecycle.mjs', ['existsSync']],
  ['knowledge/listing.mjs', ['existsSync']],
  ['knowledge/overlay.mjs', ['existsSync', 'readdirSync']],
  ['knowledge/promote.mjs', ['existsSync']],
  ['knowledge/prune.mjs', ['existsSync', 'rmSync']],
  ['knowledge/retrieve.mjs', ['existsSync']],
  ['knowledge/status.mjs', ['existsSync']],
]);

function stripCommentsJs(src) {
  const REGEX_ALLOWED_AFTER = /[(,=:[!&|?{};+\-*%~^<>]/;
  const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await']);
  let out = '';
  let prevSig = '';
  let prevWord = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const nx = src[i + 1];
    if (ch === '/' && nx === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && nx === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      out += ch;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        const done = src[i] === ch;
        i += 1;
        if (done) break;
      }
      prevSig = ch;
      prevWord = '';
      continue;
    }
    if (ch === '/' && (REGEX_ALLOWED_AFTER.test(prevSig) || REGEX_AFTER_WORD.has(prevWord) || prevSig === '')) {
      out += ch;
      i += 1;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        out += src[i];
        const done = src[i] === '/' && !inClass;
        i += 1;
        if (done) break;
      }
      prevSig = '/';
      prevWord = '';
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) {
      prevSig = ch;
      prevWord = /[A-Za-z_$\w]/.test(ch) ? prevWord + ch : '';
    }
    i += 1;
  }
  return out;
}

const FS_STATIC_IMPORT = /import\s+([^;'"]*?)\s*from\s*['"]((?:node:)?fs(?:\/promises)?)['"]/g;
function fsImportViolations(src) {
  const out = [];
  FS_STATIC_IMPORT.lastIndex = 0;
  let m;
  while ((m = FS_STATIC_IMPORT.exec(src)) !== null) {
    const [, clause, specifier] = m;
    if (clause.trim() !== 'fs' || specifier !== 'node:fs') {
      out.push(`only \`import fs from 'node:fs'\` may reach the fs module, found \`import ${clause.trim()} from '${specifier}'\``);
    }
  }
  return out;
}

/** The non-`import` ways a binding to fs (or to one of its verbs) can appear. */
const FS_REACH_VIOLATIONS = [
  [/require\s*\(\s*['"](node:)?fs/, 'require() of fs'],
  [/import\s*\(\s*['"](node:)?fs/, 'dynamic import() of fs'],
  [/(?:const|let|var)\s*\{[^}]*\}\s*=\s*fs\b/, 'destructuring verbs off the fs module object'],
  [/\bfs\s*\[/, 'computed member access on fs (fs[...])'],
  [/=\s*fs\s*[;,)]/, 'aliasing the whole fs module object'],
];

/** All `.mjs` under `dir`, recursively, as paths relative to `relativeTo`. */
function mjsFiles(dir, relativeTo) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...mjsFiles(full, relativeTo));
    else if (e.isFile() && e.name.endsWith('.mjs')) out.push({ key: path.relative(relativeTo, full).split(path.sep).join('/'), full });
  }
  return out;
}

/**
 * The checker, run against the SHIPPED source below and against a temp fixture
 * of every evasion shape. Returns a list of violation strings; empty means the
 * contract holds.
 */
function rawFsContractViolations({ libDir, knowledgeDir, allow = RAW_FS_ALLOW }) {
  const scanned = new Map();
  for (const f of mjsFiles(knowledgeDir, libDir)) scanned.set(f.key, f.full);
  // The import-graph half: a store-writing module ANYWHERE under lib/.
  for (const f of mjsFiles(libDir, libDir)) {
    if (scanned.has(f.key)) continue;
    const raw = fs.readFileSync(f.full, 'utf8');
    if (/from\s*['"][^'"]*store-io\.mjs['"]/.test(stripCommentsJs(raw))) scanned.set(f.key, f.full);
  }
  const violations = [];
  for (const [key, full] of [...scanned].sort()) {
    const src = stripCommentsJs(fs.readFileSync(full, 'utf8'));
    if (!/\bfs\b/.test(src)) continue;
    for (const why of fsImportViolations(src)) violations.push(`${key}: ${why}`);
    for (const [re, why] of FS_REACH_VIOLATIONS) {
      if (re.test(src)) violations.push(`${key}: ${why}`);
    }
    const permitted = new Set(allow.get(key) || []);
    const seen = new Set();
    const member = /\bfs\.([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = member.exec(src)) !== null) {
      if (permitted.has(m[1]) || seen.has(m[1])) continue;
      seen.add(m[1]);
      violations.push(
        allow.has(key)
          ? `${key}: fs.${m[1]} is not in the module's raw-fs allow-list`
          : `${key}: reaches raw fs but is not in the raw-fs allow-list at all`
      );
    }
  }
  return violations;
}

test('R1/R7: every store-writing module obeys the raw-fs source contract', () => {
  const libDir = path.join(packageRoot, 'lib');
  const knowledgeDir = path.join(libDir, 'knowledge');
  assert.deepEqual(rawFsContractViolations({ libDir, knowledgeDir }), [], 'every store-owned file must go through store-io.mjs');

  // The allow-list must not rot: an entry for a module that no longer exists
  // silently widens nothing today and hides a real module tomorrow.
  for (const key of RAW_FS_ALLOW.keys()) {
    assert.ok(fs.existsSync(path.join(libDir, key)), `stale raw-fs allow-list entry: ${key}`);
  }
  // Canary: prove the comment stripper did not eat live code (over-stripping is
  // the one failure direction a contract test must never have).
  const stripped = stripCommentsJs(fs.readFileSync(path.join(knowledgeDir, 'store.mjs'), 'utf8'));
  assert.match(stripped, /export function commitStore\(/);
  assert.match(stripped, /export function withStoreTransaction\(/);
});

// Every shape that evaded the old filename-literal grep, constructed as a temp
// fixture and fed to the SAME checker. Each fixture is named after a real
// module so the SHIPPED allow-list is the one being applied.
test('R1/R7: the raw-fs contract rejects every spelling that evaded the filename grep', () => {
  const evasions = [
    // The historical ensureStore bug's own shape: the literal is in a variable.
    ['knowledge/store.mjs', "const indexPath = path.join(dir, 'INDEX.md');\nfs.writeFileSync(indexPath, INDEX_STUB);", 'writeFileSync'],
    ['knowledge/store.mjs', 'fs.writeFileSync(path.join(dir, "INDEX.md"), INDEX_STUB);', 'double-quoted literal'],
    ['knowledge/store.mjs', 'fs.writeFileSync(path.join(dir, `INDEX.md`), INDEX_STUB);', 'template literal'],
    ['knowledge/store.mjs', "fs.writeFileSync(dir + '/INDEX.md', INDEX_STUB);", 'string concatenation'],
    ['knowledge/store.mjs', 'fs.promises.writeFile(p, INDEX_STUB);', 'fs.promises'],
    ['knowledge/store.mjs', 'const w = fs.writeFileSync;\nw(p, INDEX_STUB);', 'helper alias'],
    ['knowledge/store.mjs', 'fs.unlinkSync(p);', 'unlinkSync'],
    ['knowledge/store.mjs', 'const fd = fs.openSync(p, "w");\nfs.writeSync(fd, buf);', 'openSync + writeSync'],
    ['knowledge/store.mjs', 'fs.truncateSync(p, 0);', 'truncateSync'],
    ['knowledge/store.mjs', 'fs.cpSync(a, b);', 'cpSync'],
    ['knowledge/store.mjs', 'fs.appendFileSync(p, line);', 'appendFileSync'],
    ['knowledge/store.mjs', 'fs.createWriteStream(p).end(text);', 'createWriteStream'],
    ['knowledge/lifecycle.mjs', 'fs.lstatSync(p);', 'lstatSync in a module that may not stat'],
    ['knowledge/lifecycle.mjs', 'fs.readdirSync(p);', 'readdirSync in a module that may not walk'],
    ['knowledge/lifecycle.mjs', 'fs.renameSync(a, b);', 'renameSync in a module that may not rename'],
    // A future subdirectory under lib/knowledge — the non-recursive scan missed it.
    ['knowledge/sub/writer.mjs', "fs.writeFileSync(path.join(dir, 'INDEX.md'), text);", 'a module in a lib/knowledge subdirectory'],
    // A brand-new store-writing module with NO allow-list entry at all.
    ['knowledge/newcomer.mjs', 'fs.existsSync(p);', 'a new lib/knowledge module'],
  ];
  const importLine = "import fs from 'node:fs';\nimport path from 'node:path';\n";
  for (const [key, body, label] of evasions) {
    const root = tempDir('sio-contract-');
    const full = path.join(root, key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, importLine + body + '\n', 'utf8');
    const found = rawFsContractViolations({ libDir: root, knowledgeDir: path.join(root, 'knowledge') });
    assert.ok(found.length > 0, `the contract must reject: ${label}`);
  }

  // Rule 1: every way of reaching fs other than `import fs from 'node:fs'`.
  const reaches = [
    ["import { writeFileSync } from 'node:fs';\nwriteFileSync(p, text);", 'destructured import'],
    ["import * as nodefs from 'node:fs';\nnodefs.writeFileSync(p, text);", 'namespace import'],
    ["import fsp from 'node:fs/promises';\nawait fsp.writeFile(p, text);", 'node:fs/promises'],
    ["import fs from 'fs';\nfs.existsSync(p);", "bare 'fs' specifier"],
    ["const fs = require('node:fs');\nfs.existsSync(p);", 'require()'],
    ["const fs = await import('node:fs');\nfs.existsSync(p);", 'dynamic import()'],
    ["import fs from 'node:fs';\nconst { writeFileSync } = fs;\nwriteFileSync(p, text);", 'destructuring off fs'],
    ["import fs from 'node:fs';\nfs['writeFileSync'](p, text);", 'computed fs[...]'],
    ["import fs from 'node:fs';\nconst raw = fs;\nraw.writeFileSync(p, text);", 'aliasing the module object'],
    ["import fs, { writeFileSync } from 'node:fs';\nwriteFileSync(p, text);", 'default PLUS named import'],
    ["import myfs from 'node:fs';\nmyfs.writeFileSync(p, text);", 'default import bound to another name'],
  ];
  for (const [body, label] of reaches) {
    const root = tempDir('sio-reach-');
    const full = path.join(root, 'knowledge', 'store.mjs');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body + '\n', 'utf8');
    const found = rawFsContractViolations({ libDir: root, knowledgeDir: path.join(root, 'knowledge') });
    assert.ok(found.length > 0, `the contract must reject: ${label}`);
  }

  // And a store-writing module OUTSIDE lib/knowledge is scanned via the
  // import graph, not by its location.
  const root = tempDir('sio-graph-');
  fs.mkdirSync(path.join(root, 'knowledge'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'rogue-writer.mjs'),
    "import fs from 'node:fs';\nimport { writeStoreFile } from './knowledge/store-io.mjs';\nfs.writeFileSync(p, text);\nexport { writeStoreFile };\n",
    'utf8'
  );
  assert.ok(
    rawFsContractViolations({ libDir: root, knowledgeDir: path.join(root, 'knowledge') }).some((v) => v.startsWith('rogue-writer.mjs')),
    'a store-writing module outside lib/knowledge must be scanned too'
  );

  // Control: the shape the contract must NOT flag — an allow-listed verb in
  // the module that owns it, however the path is spelled.
  const okRoot = tempDir('sio-control-');
  fs.mkdirSync(path.join(okRoot, 'knowledge'), { recursive: true });
  fs.writeFileSync(
    path.join(okRoot, 'knowledge', 'store.mjs'),
    "import fs from 'node:fs';\nconst p = `${dir}/INDEX.md`;\nif (fs.existsSync(path.join(dir, '.git'))) fs.mkdirSync(p, { recursive: true });\n",
    'utf8'
  );
  assert.deepEqual(rawFsContractViolations({ libDir: okRoot, knowledgeDir: path.join(okRoot, 'knowledge') }), []);
});

// ---------------------------------------------------------------------------
// R2 — the quarantine must be reachable for the likeliest plant
// ---------------------------------------------------------------------------

// A TRACKED learning replaced by a symlink is a git TYPECHANGE: `git status`
// emits ` T`, which is neither `??` nor contains `M`, so the pre-filter
// `continue`d before the symlink branch ever ran. The link was never
// quarantined, never logged, and `git add -A` committed it into store history
// while listLearnings silently dropped the learning. REAL git state, not a
// hand-built status string.
test('R2: a tracked golden learning replaced by a symlink (real ` T` typechange) is quarantined, never committed', () => {
  const c = ctx();
  const id = seedLearning(c, 'typechange-victim');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const victim = outsideFile('ssh-config');
  const learningPath = path.join(dir, 'learnings', 'sql', 'typechange-victim.md');

  // The file is TRACKED (applyOps committed it) — replace it with a symlink.
  fs.rmSync(learningPath);
  fs.symlinkSync(victim.full, learningPath);

  const porcelain = git(dir, ['status', '--porcelain', '-uall', '-z']).stdout;
  const entry = parsePorcelainZ(porcelain).find((e) => e.path.endsWith('typechange-victim.md'));
  assert.ok(entry, 'git must report the replaced learning');
  assert.equal(entry.status.includes('T'), true, `git must report a typechange, got ${JSON.stringify(entry.status)}`);
  assert.equal(entry.status.includes('M'), false, 'the pre-filter that this test exists for excluded exactly this code');

  const notes = [];
  absorbHandEdits({ workspace: c.ws, home: c.harnessHome, log: (m) => notes.push(m) });

  assert.equal(fs.readFileSync(victim.full, 'utf8'), victim.content, 'the outside file must be byte-identical');
  assert.equal(fs.existsSync(learningPath), false, 'the planted link must be gone from learnings/');
  assert.ok(quarantined(dir).some((f) => f.includes('typechange-victim')), 'the link is quarantined');
  assert.ok(notes.some((n) => /symlink/i.test(n)), `the refusal must be logged: ${JSON.stringify(notes)}`);
  assert.equal(listLearnings(dir).some((l) => l.id === id), false, 'the symlink is never presented as a learning');

  const tracked = git(dir, ['ls-files', '-s', 'learnings/sql/typechange-victim.md']).stdout;
  assert.equal(/^120000/.test(tracked.trim()), false, `a symlink must never be committed into store history: ${tracked}`);
});

test('R2: a tracked BUCKET learning replaced by a symlink is quarantined too', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const victim = outsideFile('bucket-target');

  // Hand-build a tracked bucket learning, then commit it through the store's
  // own git so the replacement below is a REAL typechange.
  const rel = path.join('branches', 'feature-y', 'learnings', 'sql', 'bucket-victim.md');
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    '---\nschema: 1\ntrigger: "bucket claim"\nstatus: active\nsource: auto\nepisodes:\nanchors: []\nsuperseded_by: null\nlast_confirmed: null\norigin: unknown\n---\n\nBucket claim body.\n',
    'utf8'
  );
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'seed bucket']);

  fs.rmSync(full);
  fs.symlinkSync(victim.full, full);

  const notes = [];
  absorbHandEdits({ workspace: c.ws, home: c.harnessHome, log: (m) => notes.push(m) });

  assert.equal(fs.readFileSync(victim.full, 'utf8'), victim.content, 'the outside file must be byte-identical');
  assert.equal(fs.existsSync(full), false, 'the planted link must be gone from the bucket');
  assert.ok(quarantined(dir).some((f) => f.includes('bucket-victim')), 'the bucket link is quarantined');
});

// ---------------------------------------------------------------------------
// R3 — never clear a journal you do not own
// ---------------------------------------------------------------------------

// A's recovery rollback loses the lock; B acquires it and writes ITS journal;
// A finalizes and rmSyncs B's journal — so B runs UNMARKED, exactly the state
// the fail-closed journal check exists to prevent.
test('R3: a transaction never clears a transaction journal another writer owns', () => {
  const c = ctx();
  seedLearning(c, 'journal-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const journalPath = path.join(dir, '.git', 'harness-txn.json');
  const foreign = { pid: 999999, at: new Date().toISOString(), label: 'writer B', owner: 'B-token-abcdef', checkpoint: null, dirty: [] };

  const tx = withStoreTransaction(c.ws, { home: c.harnessHome, label: 'writer A' }, () => {
    // Writer B took the store while A was mid-flight and wrote its own journal.
    fs.writeFileSync(journalPath, JSON.stringify(foreign) + '\n', 'utf8');
    return { commitMessage: 'writer A finished' };
  });
  assert.equal(tx.ok, true, String(tx.error || ''));

  assert.equal(fs.existsSync(journalPath), true, "A must not delete B's journal");
  assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).owner, 'B-token-abcdef');
});

// ---------------------------------------------------------------------------
// R4 — no rollback may free the lock without an ownership re-check
// ---------------------------------------------------------------------------

test('R4: a mid-fn uncommitted rollback that finds a foreign lock aborts the transaction', () => {
  const c = ctx();
  seedLearning(c, 'rollback-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const lockPath = path.join(dir, '.lock');

  let rolledBack = null;
  const tx = withStoreTransaction(c.ws, { home: c.harnessHome, label: 'strike' }, ({ rollbackUncommitted }) => {
    // Another writer took the lock while this transaction was mid-flight.
    fs.rmSync(lockPath, { recursive: true, force: true });
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ token: 'other-writer', pid: 4242 }) + '\n', 'utf8');
    rolledBack = rollbackUncommitted();
    return { commitMessage: 'must never be committed' };
  });

  assert.equal(rolledBack, false, 'a rollback that lost the lock must report failure');
  assert.equal(tx.ok, false, 'the transaction must refuse to commit after a lost lock');
  assert.match(String(tx.error?.message || ''), /taken over by another writer/i);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).token,
    'other-writer',
    "the other writer's lock must be left strictly alone"
  );
});

test('R4: recordContentFailure no longer rolls back outside the transaction guard', () => {
  const src = fs.readFileSync(path.join(packageRoot, 'lib', 'knowledge', 'apply.mjs'), 'utf8');
  const code = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
    .join('\n');
  assert.equal(/[^a-zA-Z]rollbackStore\(/.test(code), false, 'apply.mjs must not call rollbackStore directly — it bypasses the latch and the ownership re-check');
  assert.match(code, /rollbackUncommitted\(\)/, 'the strike rollback goes through the transaction-owned guarded rollback');
});

// ---------------------------------------------------------------------------
// R5 — stale-lock takeover must be atomic, not merely narrowed
// ---------------------------------------------------------------------------

// Two processes both stat the same >10-min lock. A renames it to a tombstone,
// mkdirs, stamps, verifies owned, returns acquired. B's rename then succeeds
// against A's FRESH lock, B mkdirs, stamps, verifies owned — and both believe
// they hold it. Deterministic here: both observations are taken BEFORE either
// takeover runs, which is exactly the interleaving.
test('R5: two writers that both observed the same stale lock cannot both acquire it', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const lockPath = path.join(dir, '.lock');
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ token: 'dead-writer', pid: 1 }) + '\n', 'utf8');
  const old = Date.now() - 40 * 60 * 1000;
  fs.utimesSync(lockPath, old / 1000, old / 1000);

  const observedByA = observeStaleLock(lockPath);
  const observedByB = observeStaleLock(lockPath);
  assert.ok(observedByA && observedByB, 'both writers must see the same stale lock');

  const a = takeOverStaleLock(lockPath, observedByA, 'token-A');
  const b = takeOverStaleLock(lockPath, observedByB, 'token-B');

  assert.equal(a.acquired, true, 'the first writer takes over the stale lock');
  assert.equal(b.acquired, false, 'the second writer must NOT also acquire it');
  assert.equal(lockOwnership(lockPath, 'token-A'), 'owned', "the winner's lock must still stand");
});

// ---------------------------------------------------------------------------
// R6 — the smaller verified findings
// ---------------------------------------------------------------------------

// A failed owner stamp made lockOwnership report our OWN lock `foreign`, so
// releaseStoreLock never removed it and the store wedged for 10 minutes.
test('R6: a lock whose owner stamp cannot be written is never left live', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const lockPath = path.join(dir, '.lock');
  const realOpen = fs.openSync;
  fs.openSync = (p, ...rest) => {
    if (typeof p === 'string' && p.includes('.tmp-owner.json')) throw new Error('simulated stamp failure');
    return realOpen(p, ...rest);
  };
  let lock;
  try {
    lock = acquireStoreLock(lockPath);
  } finally {
    fs.openSync = realOpen;
  }
  assert.equal(lock.acquired, false, 'an unstampable lock must fail the acquisition');
  assert.equal(fs.existsSync(lockPath), false, 'and must never be left live to wedge the store');
});

test('R6: the store .gitignore is written under the lock, not by ensureStore', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  assert.equal(fs.existsSync(path.join(dir, '.gitignore')), false, 'ensureStore must not mutate the store outside the lock');

  const tx = withStoreTransaction(c.ws, { home: c.harnessHome, label: 'gitignore' }, () => ({ commitMessage: 'noop' }));
  assert.equal(tx.ok, true, String(tx.error || ''));
  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.match(gi, /^\/\.lock\/$/m);
  assert.match(gi, new RegExp(`^/${QUARANTINE_DIR}/$`, 'm'));
});

test('R6: a present-but-unreadable .gitignore is never clobbered', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  // Over the shared read cap (DEFAULT_MAX_BYTES): readFileNoFollow returns
  // null for a reason that is NOT "this is a symlink", so the entries cannot
  // be appended — but the file must not be REPLACED either.
  const huge = Buffer.alloc(10_000_001, 0x61);
  fs.writeFileSync(path.join(dir, '.gitignore'), huge);

  const tx = withStoreTransaction(c.ws, { home: c.harnessHome, label: 'gitignore-clobber' }, () => ({ commitMessage: 'noop' }));
  assert.equal(tx.ok, true, String(tx.error || ''));
  assert.equal(fs.statSync(path.join(dir, '.gitignore')).size, huge.length, 'an unexplained read failure must never become a rewrite');
});

test('R6: a crash recovery whose rollback cannot clean the tree refuses to run', { skip: process.getuid?.() === 0 ? 'root ignores the read-only directory mode this test relies on' : false }, () => {
  const c = ctx();
  seedLearning(c, 'recovery-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });

  // A dead writer's journal: nothing was dirty at start, so everything dirty
  // now is its residue and recovery takes the whole-tree rollback path.
  fs.writeFileSync(
    path.join(dir, '.git', 'harness-txn.json'),
    JSON.stringify({ pid: 999999, at: new Date().toISOString(), label: 'dead', checkpoint: 'f'.repeat(40), dirty: [] }) + '\n',
    'utf8'
  );
    const blocked = path.join(dir, 'blocked-residue');
  fs.mkdirSync(blocked, { recursive: true });
  fs.writeFileSync(path.join(blocked, 'residue.txt'), 'dead writer residue\n', 'utf8');
  const mode = fs.statSync(blocked).mode;
  fs.chmodSync(blocked, 0o555);
  let tx;
  try {
    tx = withStoreTransaction(c.ws, { home: c.harnessHome, label: 'after-crash' }, () => ({ commitMessage: 'must not run' }));
  } finally {
    fs.chmodSync(blocked, mode);
  }
  assert.equal(tx.ok, false, 'a recovery that could not discard the residue must refuse the run');
  assert.match(String(tx.error?.message || ''), /residue|rollback/i);
});

test('R6/S3: parsePorcelainZ decodes a REAL git rename new-path-first', () => {
  const repo = tempDir('sio-rename-');
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'orig-name.txt'), 'content\n');
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'seed']);
  git(repo, ['mv', 'orig-name.txt', 'new-name.txt']);

  const out = git(repo, ['status', '--porcelain', '-uall', '-z']).stdout;
  const entries = parsePorcelainZ(out);
  const rename = entries.find((e) => e.status.includes('R'));
  assert.ok(rename, `git must report a rename: ${JSON.stringify(out)}`);
  assert.equal(rename.path, 'new-name.txt', 'the FIRST field is the new path');
  assert.equal(rename.origPath, 'orig-name.txt', 'the SECOND field is the original path');
  assert.equal(entries.length, 1, 'the paired field must be consumed, not left to misalign the next entry');
});

/** A directory OUTSIDE the store a planted directory symlink points at. */
function outsideDir(name = 'evil') {
  const dir = tempDir(`sio-outside-${name}-`);
  fs.writeFileSync(path.join(dir, 'bystander.txt'), `outside content for ${name}\n`, 'utf8');
  return dir;
}

/** Every mode-120000 entry `git ls-files -s` reports — a symlink in history. */
function trackedSymlinks(dir) {
  return git(dir, ['ls-files', '-s'])
    .stdout.split('\n')
    .filter((l) => l.startsWith('120000'));
}

function plantDirSymlink(target, at) {
  fs.rmSync(at, { recursive: true, force: true });
  fs.symlinkSync(target, at);
}

for (const shape of ['learnings', path.join('learnings', 'sql'), 'branches']) {
  test(`R7: a symlink planted at <store>/${shape.split(path.sep).join('/')} is quarantined or refused, never committed`, () => {
    const c = ctx();
    const id = seedLearning(c, 'dir-plant-victim');
    const { dir } = ensureStore(c.ws, { home: c.harnessHome });
    // A bucket layer exists too, so `branches` is a real directory to replace.
    ensureBucket(dir, { key: 'feature-z', branch: 'feature/z', baseSha: null });
    commitStore(dir, 'seed bucket');
    const outside = outsideDir(shape.split(path.sep).join('-'));
    const outsideBefore = fs.readdirSync(outside);

    plantDirSymlink(outside, path.join(dir, shape));

    const res = setLearningStatus({ workspace: c.ws, id, action: 'retire', reason: 'cleanup', home: c.harnessHome });

    // 1. NEVER a silent success while a store directory is a symlink.
    assert.equal(res.pass, false, `a transaction must never report success with <store>/${shape} symlinked`);
    assert.match(String(res.blockedReason || ''), new RegExp(shape.split(path.sep).join('/')), 'the refusal must name the symlinked directory');

    // 2. The link itself is inert — quarantined out of the live tree.
    assert.equal(
      fs.existsSync(path.join(dir, shape)) && fs.lstatSync(path.join(dir, shape)).isSymbolicLink(),
      false,
      'the planted directory link must not still stand at a live store path'
    );
    assert.ok(
      quarantined(dir).some((f) => f.includes(shape.split(path.sep).join('__'))),
      `the planted directory link is quarantined: ${JSON.stringify(quarantined(dir))}`
    );

    // 3. It is NEVER recorded as a 120000 blob in store history.
    assert.deepEqual(trackedSymlinks(dir), [], 'a symlink must never be committed into store history');

    // 4. The outside target is untouched.
    assert.deepEqual(fs.readdirSync(outside), outsideBefore, 'the outside directory must be byte-for-byte unchanged');

    // 5. The learnings the plant hid are back, and the next run is clean.
    assert.ok(listLearnings(dir).some((l) => l.id === id), 'the real directory is restored, so the learnings reappear');
    const after = setLearningStatus({ workspace: c.ws, id, action: 'retire', reason: 'cleanup', home: c.harnessHome });
    assert.equal(after.pass, true, after.blockedReason || '');
    assert.deepEqual(trackedSymlinks(dir), [], 'and still no symlink in history after the healed run');
  });
}

test('R7: a symlink planted at a BUCKET learnings directory is quarantined or refused too', () => {
  const c = ctx();
  const id = seedLearning(c, 'bucket-dir-victim');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const bucketDir = ensureBucket(dir, { key: 'feature-q', branch: 'feature/q', baseSha: null });
  const bucketLearnings = path.join(dir, 'branches', 'feature-q', 'learnings', 'sql');
  fs.mkdirSync(bucketLearnings, { recursive: true });
  fs.writeFileSync(
    path.join(bucketLearnings, 'bucket-claim.md'),
    '---\nschema: 1\ntrigger: "bucket claim"\nstatus: active\nsource: auto\nepisodes:\nanchors: []\nsuperseded_by: null\nlast_confirmed: null\norigin: unknown\n---\n\nBucket claim body.\n',
    'utf8'
  );
  commitStore(dir, 'seed bucket learning');
  assert.ok(bucketDir);

  const outside = outsideDir('bucket');
  plantDirSymlink(outside, bucketLearnings);

  const res = setLearningStatus({ workspace: c.ws, id, action: 'retire', reason: 'cleanup', home: c.harnessHome });
  assert.equal(res.pass, false, 'a bucket learnings directory symlink must refuse the transaction too');
  assert.match(String(res.blockedReason || ''), /branches\/feature-q\/learnings\/sql/);
  assert.deepEqual(trackedSymlinks(dir), [], 'a symlink must never be committed into store history');
  assert.ok(quarantined(dir).some((f) => f.includes('feature-q')), 'the bucket directory link is quarantined');
});

test('R7: commitStore itself refuses to stage a store whose owned directory is a symlink', () => {
  const c = ctx();
  seedLearning(c, 'commit-guard-anchor');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const outside = outsideDir('commit');

  plantDirSymlink(outside, path.join(dir, 'learnings'));

  const res = commitStore(dir, 'must never land');
  assert.equal(res.ok, false, 'staging must fail closed');
  assert.equal(res.committed, false);
  assert.match(String(res.stderr || ''), /learnings/, 'the refusal must name the symlinked directory');
  assert.deepEqual(trackedSymlinks(dir), [], 'git add -A must never have run');
});

test('R7: findSymlinkedStoreDirectories reports every owned directory shape and nothing else', () => {
  const c = ctx();
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const outside = outsideDir('shapes');
  fs.mkdirSync(path.join(dir, 'learnings', 'sql'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'branches', 'k1', 'learnings', 'py'), { recursive: true });

  assert.deepEqual(findSymlinkedStoreDirectories(dir), [], 'a clean store reports nothing');

  plantDirSymlink(outside, path.join(dir, 'learnings', 'sql'));
  plantDirSymlink(outside, path.join(dir, 'branches', 'k1', 'learnings', 'py'));
  // A symlink OUTSIDE the owned shapes is not this scan's business.
  fs.symlinkSync(outside, path.join(dir, 'unrelated-link'));

  assert.deepEqual(findSymlinkedStoreDirectories(dir).sort(), ['branches/k1/learnings/py', 'learnings/sql']);
});

test('R7: a store-shaped basename outside any store root is refused, not contained against its own parent', () => {
  const home = tempDir('sio-plausible-');
  const ssh = path.join(home, '.ssh');
  fs.mkdirSync(ssh, { recursive: true });
  const victim = path.join(ssh, 'config.json');
  fs.writeFileSync(victim, 'Host secret\n  IdentityFile ~/.ssh/id_ed25519\n', 'utf8');
  const before = fs.readFileSync(victim, 'utf8');

  assert.equal(storePathParts(victim), null, 'a derived root that could not be a store root is not a store path');
  assert.equal(writeStoreFile(victim, 'owned by the store\n'), false, 'the write must be refused outright');
  assert.equal(fs.readFileSync(victim, 'utf8'), before, 'the outside file must be byte-identical');

    const store = path.join(home, 'knowledge', 'repo-id');
  fs.mkdirSync(store, { recursive: true });
  assert.equal(writeStoreFile(path.join(store, 'config.json'), '{"mode":"on"}\n'), true);
});

test('R7: appendFileContained loops until the whole record is written', () => {
  const root = tempDir('sio-append-');
  const record = `${JSON.stringify({ path: 'docs/solutions/x.md', learning: 'sql/x', at: '2026-01-01' })}\n`;
  const realWrite = fs.writeSync;
  let shortened = false;
  fs.writeSync = (fd, buf, off, len, ...rest) => {
    const offset = typeof off === 'number' ? off : 0;
    const length = typeof len === 'number' ? len : buf.length - offset;
    if (!shortened && length > 1) {
      shortened = true;
      return realWrite(fd, buf, offset, 1);
    }
    return realWrite(fd, buf, offset, length, ...rest);
  };
  let written;
  try {
    written = appendFileContained(root, 'consolidated.jsonl', record);
  } finally {
    fs.writeSync = realWrite;
  }
  assert.ok(shortened, 'the test must actually have forced a short write');
  assert.ok(written, 'the append must still succeed');
  assert.equal(fs.readFileSync(path.join(root, 'consolidated.jsonl'), 'utf8'), record, 'a short write must never truncate the record');
});

test('R7: an unmerged (deleted-by-one-side) learning is never absorbed as a hand deletion', () => {
  const c = ctx();
  const id = seedLearning(c, 'unmerged-victim');
  const { dir } = ensureStore(c.ws, { home: c.harnessHome });
  const rel = 'learnings/sql/unmerged-victim.md';
  const commit = (msg) => git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', msg]);

  // REAL git conflict state: one side edits the learning, the other deletes it.
  const base = git(dir, ['rev-parse', 'HEAD']).stdout.trim();
  git(dir, ['checkout', '-q', '-b', 'edited']);
  fs.appendFileSync(path.join(dir, rel), '\nEdited on the branch.\n', 'utf8');
  git(dir, ['add', '-A']);
  commit('edit on branch');
  git(dir, ['checkout', '-q', base]);
  git(dir, ['checkout', '-q', '-b', 'deleted-side']);
  fs.rmSync(path.join(dir, rel));
  git(dir, ['add', '-A']);
  commit('delete on branch');
  const merge = git(dir, ['merge', '--no-commit', 'edited']);
  assert.notEqual(merge.status, 0, 'the merge must actually conflict');

  const porcelain = git(dir, ['status', '--porcelain', '-uall', '-z']).stdout;
  const entry = parsePorcelainZ(porcelain).find((e) => e.path === rel);
    assert.ok(
    entry,
    `git must report the conflicted learning — merge exit ${merge.status}, stdout ${JSON.stringify(merge.stdout)}, stderr ${JSON.stringify(merge.stderr)}, porcelain ${JSON.stringify(porcelain)}`
  );
  assert.equal(entry.status.includes('D'), true, `the unmerged code must contain D, got ${JSON.stringify(entry.status)}`);
  assert.ok(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(entry.status), `must be an unmerged code, got ${JSON.stringify(entry.status)}`);

  const res = absorbHandEdits({ workspace: c.ws, home: c.harnessHome, log: () => {} });
  assert.deepEqual(res.deleted, [], 'an unresolved conflict is not a hand deletion');
  assert.equal(readGovernance(dir).get(id)?.action, undefined, 'and it must never record a governance retire');
});
