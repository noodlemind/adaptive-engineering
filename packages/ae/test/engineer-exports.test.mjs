import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';
import { checkEngineerExports, renderEngineerExport } from '../lib/hosts/engineer-exports.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const body = text => text.replace(/^---\n[\s\S]*?\n---\n\n/, '');
const metadata = text => YAML.parse(text.match(/^---\n([\s\S]*?)\n---/)[1]);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-engineer-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const rel of ['corpus/hosts', 'corpus/agents/engineer.agent.md', 'corpus/skills/engineer', 'lib/hosts/engineer-exports.mjs', 'lib/fs-safe.mjs', 'scripts/generate-engineer.mjs', 'node_modules/yaml']) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(path.join(root, rel), dest, { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  return dir;
}

test('both native exports contain exactly the canonical behavior with only skills addressing translated', () => {
  const canonical = fs.readFileSync(path.join(root, 'corpus/skills/engineer/references/contract.md'), 'utf8');
  assert.doesNotMatch(canonical, /copilot|claude|search\/codebase|@engineer/i);
  for (const [host, skillsRoot] of [['copilot', '<copilot-home>/skills'], ['claude-code', '~/.claude/skills']]) {
    const text = renderEngineerExport(root, host);
    assert.equal(body(text), canonical.replaceAll('<skills-root>', skillsRoot));
    for (const clause of ['**Answer**', '**Investigate**', '**Review**', '**Deliver**', 'successful implement gate before editing', "Do not edit the CLI's state store", 'a plan label is not activation', 'require passed `ae verify`']) assert.ok(text.includes(clause), `${host}: missing ${clause}`);
    assert.doesNotMatch(body(text), /<skills-root>/);
  }
  assert.deepEqual(checkEngineerExports(root), []);
});

test('Copilot authority and handoffs are preserved; Claude gets native metadata without permission escalation', () => {
  const copilot = metadata(renderEngineerExport(root, 'copilot'));
  assert.deepEqual(copilot.tools, ['agent', 'search/codebase', 'search', 'read', 'edit/editFiles', 'search/changes', 'execute', 'read/terminalLastCommand', 'execute/getTerminalOutput', 'read/problems', 'search/usages', 'web/fetch', 'githubRepo']);
  const registry = YAML.parse(fs.readFileSync(path.join(root, 'corpus/knowledge/capability-registry.yaml'), 'utf8'));
  assert.deepEqual([...copilot.agents].sort(), [...registry.engineer_allowlist].sort());
  assert.equal(copilot.handoffs.find(item => item.label === 'Capture for Later').send, false);
  assert.equal(copilot.handoffs.find(item => item.label === 'Plan and Fix').send, false);
  const claude = metadata(renderEngineerExport(root, 'claude-code'));
  assert.equal(claude.name, 'engineer');
  assert.equal(claude.permissionMode, undefined);
  assert.equal(claude.model, undefined);
  assert.equal(claude.agents, undefined);
  assert.equal(claude.handoffs, undefined);
  assert.doesNotMatch(claude.tools, /\bAgent\b/, 'delegation is unavailable until specialist exports are implemented');
  const skill = fs.readFileSync(path.join(root, 'corpus/skills/engineer/SKILL.md'), 'utf8');
  assert.match(skill, /\[the Engineer contract\]\(references\/contract\.md\)/);
  assert.doesNotMatch(skill, /@engineer|copilot-home/);
  assert.doesNotMatch(renderEngineerExport(root, 'claude-code'), /copilot-home|search\/codebase|edit\/editFiles/);
  assert.throws(() => renderEngineerExport(root, 'unknown'), /Unsupported Engineer export/);
});

test('standalone generator detects missing, stale, and edited projections without repairing them in check mode', t => {
  const dir = fixture(t);
  const run = (...args) => spawnSync(process.execPath, [path.join(dir, 'scripts/generate-engineer.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(run('--check').status, 0);
  const target = path.join(dir, 'corpus/hosts/claude-code/engineer.md');
  fs.writeFileSync(target, 'hand-edited\n');
  assert.equal(run('--check').status, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'hand-edited\n');
  assert.equal(run('--write').status, 0);
  assert.deepEqual(checkEngineerExports(dir), []);
  const source = path.join(dir, 'corpus/skills/engineer/references/contract.md');
  fs.appendFileSync(source, '\nAdditional accepted contract requirement.\n');
  assert.equal(checkEngineerExports(dir).length, 2);
  assert.equal(run('--write').status, 0);
  assert.equal(run('--check').status, 0);
  fs.unlinkSync(target);
  assert.ok(checkEngineerExports(dir).includes('corpus/hosts/claude-code/engineer.md'));
  assert.equal(run('--write').status, 0);
  assert.equal(run('--unsupported').status, 2);
});

test('generation refuses a redirected output before replacing either export', t => {
  const dir = fixture(t);
  const target = path.join(dir, 'corpus/hosts/claude-code/engineer.md');
  const other = path.join(dir, 'other.md');
  fs.writeFileSync(other, 'user-owned\n');
  fs.unlinkSync(target);
  try { fs.symlinkSync(other, target, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'ENOTSUP'].includes(error.code)) {
      t.skip('Creating file symlinks requires Windows symlink privileges');
      return;
    }
    throw error;
  }
  const before = fs.readFileSync(path.join(dir, 'corpus/agents/engineer.agent.md'), 'utf8');
  const result = spawnSync(process.execPath, [path.join(dir, 'scripts/generate-engineer.mjs'), '--write'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(other, 'utf8'), 'user-owned\n');
  assert.equal(fs.readFileSync(path.join(dir, 'corpus/agents/engineer.agent.md'), 'utf8'), before);
});
