import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { checkEngineerExports } from '../lib/hosts/engineer-exports.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpus = path.join(packageRoot, 'corpus');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? YAML.parse(match[1]) : {};
}

function skillFile(name) {
  return path.join(corpus, 'skills', name, 'SKILL.md');
}

function skillIsInvocable(name) {
  const file = skillFile(name);
  if (!fs.existsSync(file)) return null;
  return frontmatter(read(file))['user-invocable'] !== false;
}

function slashCommands(text) {
  const names = [];
  const pattern = /(?:^|[\s`(])\/([a-z][a-z0-9-]*)\b/g;
  for (const match of text.matchAll(pattern)) names.push(match[1]);
  return names;
}

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

function advertisedFiles() {
  const files = [
    ...filesUnder(path.join(corpus, 'instructions')),
    path.join(corpus, 'copilot-instructions.md'),
    ...filesUnder(path.join(corpus, 'agents')),
  ];
  for (const skill of fs.readdirSync(path.join(corpus, 'skills'))) {
    const file = skillFile(skill);
    if (fs.existsSync(file) && skillIsInvocable(skill)) files.push(file);
  }
  return files;
}

test('slash commands in always-on instructions, agents, and invocable skills resolve', () => {
  const problems = [];
  for (const file of advertisedFiles()) {
    for (const name of slashCommands(read(file))) {
      const invocable = skillIsInvocable(name);
      if (invocable !== true) {
        problems.push(`${path.relative(packageRoot, file)}: /${name} ${invocable === null ? 'does not resolve to a skill' : 'is user-invocable: false'}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('the Investigate confirmation rule has one authored source and exact native projections', () => {
  const phrase = 'confirmed only when evidence demonstrates';
  const hits = filesUnder(corpus).filter((file) => /\.(md|mjs)$/.test(file) && read(file).includes(phrase));
  assert.deepEqual(hits.map((file) => path.relative(corpus, file).replaceAll('\\', '/')).sort(), [
    'agents/engineer.agent.md',
    'hosts/claude-code/engineer.md',
    'skills/engineer/references/contract.md',
  ]);
  assert.deepEqual(checkEngineerExports(packageRoot), [], 'copies must be exact generated projections of the authored contract');
  const contradicted = filesUnder(corpus).filter((file) => /\.(md|mjs)$/.test(file) && read(file).includes('confirmed race/retry defect'));
  assert.deepEqual(contradicted, []);
});

test('installed copilot instructions omit the repository project description', () => {
  const source = read(path.join(corpus, 'copilot-instructions.md'));
  assert.match(source, /## Project/);
  assert.match(source, /Skill-driven prompt library/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-corpus-install-'));
  const copilot = path.join(root, 'copilot');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(workspace);
  const result = spawnSync(process.execPath, [
    binPath, 'install', '--target', 'cli',
    '--copilot-home', copilot,
    '--workspace', workspace,
    '--ae-home', path.join(root, 'ae'),
    '--no-events',
  ], { encoding: 'utf8', cwd: workspace, env: { ...process.env, HOME: root, NO_COLOR: '1' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const installed = read(path.join(copilot, 'copilot-instructions.md'));
  assert.doesNotMatch(installed, /## Project/);
  assert.doesNotMatch(installed, /Skill-driven prompt library/);
  assert.match(installed, /## Primitives/);
});
