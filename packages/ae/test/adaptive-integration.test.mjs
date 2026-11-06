import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const bin = path.resolve(import.meta.dirname, '../bin/ae.mjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-adaptive-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), config = path.join(root, 'config'), home = path.join(root, 'state');
  fs.mkdirSync(workspace); fs.mkdirSync(config);
  const git = args => spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
  git(['init', '-q']); git(['config', 'user.name', 'AE Evaluation']); git(['config', 'user.email', 'ae@example.test']);
  fs.writeFileSync(path.join(workspace, 'index.js'), 'export const value = 1;\n');
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  const run = (args, input) => {
    const binding = args.includes('--config-home') ? [] : ['--copilot-home', config];
    const result = spawnSync(process.execPath, [bin, ...args, '--workspace', workspace, ...binding, '--ae-home', home, '--json'], {
      cwd: workspace, encoding: 'utf8', input: input ? JSON.stringify(input) : undefined,
      env: { ...process.env, AE_HOME: home, HARNESS_HOME: home, COPILOT_HOME: config, AE_SKILLS_HOME: '', HARNESS_SKILLS_HOME: '', AE_HOST: '', HARNESS_HOST: '' },
    });
    let body; try { body = JSON.parse(result.stdout); } catch { throw new Error(result.stderr + result.stdout); }
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return body;
  };
  return { root, workspace, config, home, run };
}

test('discovery onboarding and consent survive CLI processes and orientation exposes an included external skill', t => {
  const f = fixture(t);
  const skill = path.join(f.config, 'skills', 'enterprise-orders', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '---\nname: enterprise-orders\ndescription: Enterprise order processing and recovery\n---\nInspect order recovery invariants.\n');
  const before = f.run(['resources', 'discover']);
  assert.equal(before.configured, false);
  assert.ok(before.candidates.some(x => x.id === 'enterprise-orders'));
  f.run(['resources', 'discover', '--file', '-'], { operation: 'configure', schema: 1,
    roots: [{ path: f.config, kind: 'config', host: 'copilot', scope: 'personal', included: true }],
    ongoing: true, autoIncludeNew: true, autoUpdate: true, exclusions: [],
    grants: { create: ['agent', 'skill'], update: ['agent', 'skill'], memory: true, tools: ['read', 'search'] },
  });
  const after = f.run(['resources', 'discover']);
  assert.equal(after.configured, true);
  assert.ok(after.resources.some(x => x.id === 'enterprise-orders'));
  const unrelated = path.join(f.config, 'skills', 'frontend-layout', 'SKILL.md');
  fs.mkdirSync(path.dirname(unrelated), { recursive: true });
  fs.writeFileSync(unrelated, '---\nname: frontend-layout\ndescription: Frontend visual layout\n---\nInspect responsive layout.\n');
  const query = f.run(['resources', 'discover', '--query', 'enterprise orders']);
  assert.deepEqual(query.resources.map(resource => resource.id), ['enterprise-orders']);
  const refreshed = f.run(['resources', 'discover', '--query', 'frontend layout']);
  assert.equal(refreshed.refreshed, true);
  assert.deepEqual(refreshed.resources.map(resource => resource.id), ['frontend-layout']);
  const orientation = f.run(['orient', '--read', '--context-version', '2', '--query', 'enterprise order recovery']);
  assert.ok(orientation.slice.capabilities.resources.some(x => x.id === 'enterprise-orders'));
  assert.ok(Array.isArray(orientation.slice.adaptation.candidates));
});

test('native setup returns first-use discovery questions without granting inclusion or executing a model', t => {
  const f = fixture(t);
  const setup = f.run(['host', 'setup', '--host', 'claude-code', '--config-home', f.config, '--skills-home', path.join(f.config, 'skills')]);
  assert.equal(setup.discovery.configured, false);
  assert.equal(setup.discovery.questions.length, 2);
  assert.equal(setup.discovery.requiresModel, false);
});
