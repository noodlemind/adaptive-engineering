import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens } from '../lib/token-meter.mjs';
import { CONTEXT_PACK_MAX_BYTES } from '../lib/context-pack.mjs';
import { assertNoSymlinkAncestors } from '../lib/fs-safe.mjs';
import { checkEngineerExports } from '../lib/hosts/engineer-exports.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-z-][\da-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][\da-z-]*))*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i;

// The package currently ships stable dependencies with exact or nonzero-major
// caret ranges. Fail closed if release policy adds another range syntax.
function dependencyMatches(version, range) {
  if (version === range) return true;
  const minimum = /^\^([1-9]\d*)\.(\d+)\.(\d+)$/.exec(range);
  const actual = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return Boolean(minimum && actual && actual[1] === minimum[1] &&
    (+actual[2] > +minimum[2] || (+actual[2] === +minimum[2] && +actual[3] >= +minimum[3])));
}

export function validateRelease() {
  assert.deepEqual(checkEngineerExports(packageRoot), [], 'Engineer exports drifted; run npm run generate:engineer');
  const read = rel => fs.readFileSync(path.join(packageRoot, rel), 'utf8').replace(/\r\n/g, '\n');
  const json = rel => JSON.parse(read(rel));
  const manifest = json('package.json');
  assert.equal(manifest.name, 'ae-harness', 'release package name must be ae-harness');
  assert.equal(path.posix.normalize(manifest.bin?.ae || ''), 'bin/ae.mjs', 'release bin must expose ae from bin/ae.mjs');
  assert.match(manifest.version, semver, 'package release version is invalid');
  const bridge = json('vscode-extension/package.json');
  assert.match(bridge.version, semver, 'bridge release version is invalid');
  assert.equal(bridge.name, 'ae-copilot-bridge');
  for (const rel of ['bin/ae.mjs', 'config', 'corpus', 'corpus/hooks/hooks.json', 'lib/repo-map/grammars.lock', 'README.md', 'retired.json', 'scripts/check-release.mjs', path.join('vscode-extension', bridge.main)]) {
    assert.ok(fs.existsSync(path.join(packageRoot, rel)), `missing release asset: ${rel}`);
  }
  assert.ok(Array.isArray(json('retired.json').retired), 'retired asset manifest is invalid');

  const grammarLock = json('lib/repo-map/grammars.lock');
  const vendorRoot = path.join(packageRoot, 'lib/repo-map/vendor');
  const parserManifest = json('lib/repo-map/vendor/manifest.json');
  assert.equal(parserManifest.schema, 1, 'parser asset manifest is invalid');
  assert.ok(Array.isArray(parserManifest.assets), 'parser asset records are missing');
  for (const recorded of parserManifest.assets) {
    assert.match(recorded.path, /^[a-z0-9-]+\/[A-Za-z0-9.-]+$/, 'invalid bundled parser path');
    const full = assertNoSymlinkAncestors(packageRoot, `lib/repo-map/vendor/${recorded.path}`);
    assert.ok(full && fs.lstatSync(full).isFile(), `bundled parser asset is not a regular file: ${recorded.path}`);
    const bytes = fs.readFileSync(full);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), recorded.sha256, `bundled parser integrity mismatch: ${recorded.path}`);
    assert.equal(bytes.length, recorded.bytes, `bundled parser size drift: ${recorded.path}`);
  }
  assert.ok(fs.statSync(path.join(vendorRoot, 'THIRD_PARTY_NOTICES.md')).isFile(), 'bundled parser notices are missing');
  const parserAssets = [grammarLock.runtime, { ...grammarLock.runtime.loader, package: grammarLock.runtime.package }, ...Object.values(grammarLock.grammars)];
  for (const asset of parserAssets) {
    assert.match(asset.package, /^[a-z0-9-]+$/, 'invalid parser package identity');
    assert.match(asset.file, /^[a-z0-9.-]+$/, 'invalid parser asset identity');
    const relative = `${asset.package}/${asset.file}`;
    const full = path.join(vendorRoot, asset.package, asset.file);
    assert.ok(fs.lstatSync(full).isFile(), `bundled parser asset is not a regular file: ${relative}`);
    const bytes = fs.readFileSync(full);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, `bundled parser integrity mismatch: ${relative}`);
    const recorded = parserManifest.assets.find(item => item.path === relative);
    assert.equal(recorded?.sha256, asset.sha256, `bundled parser manifest drift: ${relative}`);
    assert.equal(recorded.bytes, bytes.length, `bundled parser size drift: ${relative}`);
    assert.ok(fs.statSync(path.join(vendorRoot, asset.package, 'LICENSE')).isFile(), `bundled parser license missing: ${asset.package}`);
  }

  // npm intentionally excludes package-lock.json from archives. Source releases
  // check it; installed distributions check the dependency bytes they will bundle.
  const lock = fs.existsSync(path.join(packageRoot, 'package-lock.json')) ? json('package-lock.json') : null;
  if (lock) {
    assert.equal(lock.name, manifest.name, 'lockfile package name drifted');
    assert.equal(lock.version, manifest.version, 'lockfile release version drifted');
    assert.equal(lock.packages[''].name, manifest.name, 'lockfile root package name drifted');
    assert.equal(lock.packages[''].version, manifest.version, 'lockfile root package version drifted');
    assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies, 'lockfile dependencies drifted');
    assert.deepEqual(lock.packages[''].optionalDependencies, manifest.optionalDependencies, 'lockfile optional dependencies drifted');
    assert.deepEqual(lock.packages[''].bundleDependencies, manifest.bundledDependencies, 'lockfile bundled dependencies drifted');
  }
  for (const name of Object.keys(manifest.dependencies || {})) {
    assert.ok(manifest.bundledDependencies.includes(name), `${name} must be bundled for offline installation`);
    const dependency = json(`node_modules/${name}/package.json`);
    assert.equal(dependency.name, name);
    assert.ok(dependencyMatches(dependency.version, manifest.dependencies[name]), `${name} bundled version does not satisfy ${manifest.dependencies[name]}`);
    if (lock) assert.equal(dependency.version, lock.packages[`node_modules/${name}`]?.version, `${name} installed version differs from lockfile`);
  }
  for (const rel of [
    'THIRD-PARTY-NOTICES.md',
    'node_modules/pele/dist/pele.js', 'node_modules/pele/LICENSE',
    'node_modules/@d2lang/d2/dist/node-esm/index.js',
    'node_modules/@d2lang/d2/dist/node-esm/worker.js',
    'node_modules/@d2lang/d2/dist/node-esm/wasm_exec.js',
    'node_modules/@d2lang/d2/dist/node-esm/d2.wasm',
    'node_modules/@d2lang/d2/LICENSE.txt', 'node_modules/@d2lang/d2/THIRD_PARTY_NOTICES.txt',
    'node_modules/@resvg/resvg-wasm/index.mjs', 'node_modules/@resvg/resvg-wasm/index_bg.wasm',
    'lib/diagrams/fonts/SourceSans3-Regular.ttf', 'lib/diagrams/fonts/SourceSans3-Bold.ttf',
    'lib/diagrams/fonts/SourceSans3-It.ttf', 'lib/diagrams/fonts/LICENSE.md',
  ]) assert.ok(fs.existsSync(path.join(packageRoot, rel)), `missing bundled renderer asset: ${rel}`);

  const cli = (...args) => execFileSync(process.execPath, [path.join(packageRoot, 'bin/ae.mjs'), ...args], { cwd: packageRoot, encoding: 'utf8' });
  for (const flag of ['--version', '-V']) assert.equal(cli(flag).trim(), manifest.version, `${flag} must report the shipped version`);
  const corpus = JSON.parse(cli('resources', 'validate', '--corpus', '--json'));
  assert.equal(corpus.status, 'ok', JSON.stringify(corpus));
  assert.ok(corpus.counts.agent > 0 && corpus.counts.skill > 0, 'release corpus is empty');
  const agents = fs.readdirSync(path.join(packageRoot, 'corpus/agents')).filter(name => name.endsWith('.agent.md'));
  assert.ok(agents.includes('engineer.agent.md'), 'release corpus lacks the Engineer');
  for (const name of agents) {
    const source = read(`corpus/agents/${name}`);
    const body = source.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    assert.ok(body.split('\n').length <= 20, `${name}: agent body exceeds 20 lines`);
    const cap = name === 'engineer.agent.md' ? 900 : 600;
    assert.ok(estimateTokens(source) <= cap, `${name}: prompt exceeds ${cap} estimated tokens including metadata`);
  }
  for (const entry of fs.readdirSync(path.join(packageRoot, 'corpus/skills'), { withFileTypes: true })) {
    const rel = `corpus/skills/${entry.name}/SKILL.md`;
    if (entry.isDirectory() && fs.existsSync(path.join(packageRoot, rel))) {
      assert.ok(read(rel).split('\n').length <= 300, `${entry.name}: SKILL.md exceeds 300 lines`);
    }
  }
  assert.ok(CONTEXT_PACK_MAX_BYTES <= 4096, 'context pack byte budget must stay small');
  return { name: manifest.name, version: manifest.version, lockfile: lock ? 'checked' : 'not-shipped', agents: agents.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = validateRelease();
  console.error(`Release checks passed: ${result.name}@${result.version}; lockfile ${result.lockfile}; ${result.agents} agents.`);
}
