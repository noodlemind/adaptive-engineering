import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('diagram renderers are pinned and bundled in the AE distribution', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries({ pele: '1.8.0', '@d2lang/d2': '0.1.34', '@resvg/resvg-wasm': '2.6.2' })) {
    assert.equal(manifest.dependencies[name], version, `${name} must have a pinned version`);
    assert.ok(manifest.bundledDependencies.includes(name), `${name} must ship inside the archive`);
  }
});

test('offline local and global archives render both bundled backends from foreign directories and repack', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae diagram package '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const npm = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(npm, 'npm CLI is required for the archive rendering proof');
  const toolBin = path.join(root, 'tool bin');
  fs.mkdirSync(toolBin);
  if (process.platform === 'win32') fs.writeFileSync(path.join(toolBin, 'npm.cmd'), `@echo off\r\n"${process.execPath.replace(/%/g, '%%')}" "${npm.replace(/%/g, '%%')}" %*\r\n`);
  else fs.writeFileSync(path.join(toolBin, 'npm'), `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(npm).href)}).catch(error => { console.error(error); process.exitCode = 1; });\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), COPILOT_HOME: path.join(root, 'copilot'),
    AE_HOME: path.join(root, 'control'), HARNESS_HOME: path.join(root, 'control'),
    PATH: [toolBin, path.dirname(process.execPath), process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32') : '/bin'].join(path.delimiter),
    npm_config_ignore_scripts: 'false', npm_config_update_notifier: 'false',
    npm_config_userconfig: path.join(root, 'npm-userconfig'), npm_config_globalconfig: path.join(root, 'npm-globalconfig') };
  fs.writeFileSync(env.npm_config_userconfig, '');
  fs.writeFileSync(env.npm_config_globalconfig, '');
  delete env.AE_BIN;
  delete env.HARNESS_BIN;
  delete env.NODE_TEST_CONTEXT;
  for (const command of ['ae', 'd2', 'pstack', 'tlc']) assert.ok(spawnSync(command, ['--version'], { env }).error, `${command} must not be supplied by the environment`);
  const run = (command, args, cwd, extraEnv = {}) => {
    const result = spawnSync(command, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const npmRun = (args, cwd, cache) => run(process.execPath, [npm, ...args], cwd, { npm_config_cache: cache });
  const archives = path.join(root, 'archives');
  fs.mkdirSync(archives);
  const [packed] = JSON.parse(npmRun(['pack', '--json', '--pack-destination', archives], packageRoot, path.join(root, 'pack cache')));
  assert.equal(packed.files.some(file => /\.jar$/i.test(file.path)), false, 'diagram archive must contain no Java JAR payload');
  const archive = path.join(archives, packed.filename);
  const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const originalHash = digest(archive);
  for (const global of [false, true]) {
    const mode = global ? 'global' : 'local', prefix = path.join(root, `${mode} installed prefix`), cache = path.join(root, `${mode} fresh cache`);
    const installation = ['install', ...(global ? ['--global'] : []), '--prefix', prefix, '--offline', '--ignore-scripts=false', '--omit=optional', '--no-audit', '--no-fund', archive];
    npmRun(installation, root, cache);
    const moduleRoot = global ? npmRun(['root', '--global', '--prefix', prefix], root, cache).trim() : path.join(prefix, 'node_modules');
    const installed = path.join(moduleRoot, 'ae-harness'), cli = path.join(installed, 'bin/ae.mjs');
    const command = path.join(global ? process.platform === 'win32' ? prefix : path.join(prefix, 'bin') : path.join(prefix, 'node_modules/.bin'), process.platform === 'win32' ? 'ae.cmd' : 'ae');
    assert.ok(fs.existsSync(command), `${mode} installation must expose ae`);
    assert.equal(fs.existsSync(path.join(installed, 'test')), false);
    assert.equal(fs.existsSync(path.join(installed, 'node_modules/tree-sitter-java')), false, 'optional grammars are omitted');
    for (const asset of ['THIRD-PARTY-NOTICES.md', 'node_modules/pele/LICENSE', 'node_modules/@d2lang/d2/LICENSE.txt', 'node_modules/@d2lang/d2/THIRD_PARTY_NOTICES.txt', 'node_modules/@d2lang/d2/dist/node-esm/d2.wasm', 'node_modules/@d2lang/d2/dist/node-esm/worker.js', 'node_modules/@resvg/resvg-wasm/index_bg.wasm', 'lib/diagrams/fonts/SourceSans3-Regular.ttf', 'lib/diagrams/fonts/LICENSE.md', 'corpus/skills/create-primitive/assets/state-model/check.mjs']) assert.ok(fs.existsSync(path.join(installed, asset)), `${mode} archive is missing ${asset}`);
    assert.equal(run(process.execPath, [cli, '--version'], root).trim(), packed.version);
    const workspace = path.join(root, `${mode} fixture workspace`), foreign = path.join(root, `${mode} foreign working directory`);
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(workspace, 'src/input.mjs'), 'export const receive = () => "ready";\n');
    fs.writeFileSync(path.join(workspace, 'diagram.mmd'), 'flowchart LR\n  received[Received] --> processed[Processed]\n');
    fs.writeFileSync(path.join(workspace, 'diagram.d2'), 'direction: right\nreceived: Received\nprocessed: Processed\nreceived -> processed\n');
    for (const renderer of ['pele', 'd2']) {
      const result = JSON.parse(run(process.execPath, [cli, 'diagrams', 'render', '--file', renderer === 'pele' ? 'diagram.mmd' : 'diagram.d2', '--sources', 'src/input.mjs', '--renderer', renderer, ...(renderer === 'd2' ? ['--layout', 'tala'] : []), '--png', '--scale', '1', '--workspace', workspace, '--ae-home', path.join(root, `${mode} ae home`), '--json'], foreign));
      assert.equal(result.status, 'ok');
      assert.match(result.id, /^[a-f0-9]{64}$/);
      for (const [kind, filename] of Object.entries({ svg: 'diagram.svg', html: 'report.html', png: 'diagram.png', receipt: 'receipt.json' })) {
        assert.equal(result.artifacts[kind], `.harness/diagrams/${result.id}/${filename}`);
        assert.ok(fs.statSync(path.join(workspace, result.artifacts[kind])).size > 0);
      }
      const svg = fs.readFileSync(path.join(workspace, result.artifacts.svg), 'utf8');
      assert.match(svg, /<svg\b/);
      assert.match(svg, /Received/);
      assert.match(svg, /Processed/);
    }
    npmRun(['run', 'prepack'], installed, cache);
    const repacked = path.join(root, `${mode} repacked`);
    fs.mkdirSync(repacked);
    const [again] = JSON.parse(npmRun(['pack', '--json', '--pack-destination', repacked], installed, cache));
    assert.equal(digest(path.join(repacked, again.filename)), originalHash, `${mode} installed repack must preserve the complete source archive`);
  }
});
