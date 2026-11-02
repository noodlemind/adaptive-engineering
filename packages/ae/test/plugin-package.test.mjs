import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';
import { buildPluginPackage } from '../lib/hosts/plugin-package.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-plugin-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);
  return fs.realpathSync.native(root);
}
const file = (result, rel) => result.files.find(item => item.path === rel)?.content;

test('portable package uses published matching schemas and binds MCP to the requested Git workspace', t => {
  const workspace = fixture(t);
  const result = buildPluginPackage({ packageRoot, workspace });
  const manifest = JSON.parse(file(result, 'plugin.json'));
  const mcp = JSON.parse(file(result, 'mcp.json'));
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, 'ae-engineer');
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version);
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  const server = mcp.mcpServers.ae;
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, 'ae');
  assert.deepEqual(server.args, ['mcp', 'serve', '--workspace', fs.realpathSync.native(workspace), '--copilot-home', '${PLUGIN_ROOT}', '--skills-home', '${PLUGIN_ROOT}/skills']);
  assert.equal(server.cwd, undefined);
  assert.equal(server.env, undefined);
  assert.equal(manifest.extensions, undefined);
  assert.deepEqual(result, buildPluginPackage({ packageRoot, workspace }));
});

test('all source skills and references ship with portable root bindings and criteria-only specialists', t => {
  const result = buildPluginPackage({ packageRoot, workspace: fixture(t) });
  for (const entry of fs.readdirSync(path.join(packageRoot, 'corpus/skills'), { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(packageRoot, 'corpus/skills', entry.name, 'SKILL.md'))) {
      assert.ok(file(result, `skills/${entry.name}/SKILL.md`), `missing ${entry.name}`);
    }
  }
  assert.ok(file(result, 'skills/references/plan-operations.md'));
  assert.ok(file(result, 'knowledge/manifest.yaml'));
  assert.ok(file(result, 'enterprise/capability-registry.enterprise.yaml'));
  const specialist = file(result, 'skills/engineer/references/specialists/security-sentinel.md');
  assert.match(specialist, /## Guardrails/);
  assert.doesNotMatch(specialist, /^---\n|tools:|user-invocable:/);
  assert.ok(!result.files.some(item => /^(agents|hooks)\//.test(item.path)));
  for (const item of result.files) {
    assert.doesNotMatch(item.content, /<copilot-home>|~\/\.copilot|__ae_portable_plugin__/);
    assert.ok(!path.posix.isAbsolute(item.path) && !item.path.split('/').includes('..'));
    assert.ok(!item.content.includes(packageRoot.replaceAll('\\', '/')), `portable output leaked source package path: ${item.path}`);
  }
  assert.equal(new Set(result.files.map(item => item.path)).size, result.files.length);
});

test('Engineer explains portable content roots, CLI context and unsupported authority', t => {
  const result = buildPluginPackage({ packageRoot, workspace: fixture(t) });
  const skill = file(result, 'skills/engineer/SKILL.md');
  assert.match(skill, /<ae-plugin-root>/);
  assert.match(skill, /two levels/);
  assert.match(skill, /AE_SKILLS_HOME/);
  assert.match(skill, /--copilot-home/);
  assert.match(skill, /independent.*review/i);
  assert.match(file(result, 'skills/create-primitive/SKILL.md'), /no saved native ownership manifest[\s\S]*ae host setup/);
  const meta = YAML.parse(skill.match(/^---\n([\s\S]*?)\n---/)[1]);
  assert.equal(meta.name, 'engineer');
  assert.ok(result.requirements.some(line => /Node.*20/.test(line)));
  assert.ok(result.limitations.some(line => /native.*hooks/i.test(line)));
  assert.match(file(result, 'README.md'), /installed.*ae.*CLI/i);
});

test('package generation rejects ambiguous or nonexistent workspaces instead of binding plugin cwd', t => {
  const workspace = fixture(t);
  fs.mkdirSync(path.join(workspace, 'src'));
  const result = buildPluginPackage({ packageRoot, workspace: path.join(workspace, 'src') });
  assert.equal(JSON.parse(file(result, 'mcp.json')).mcpServers.ae.args[3], fs.realpathSync.native(workspace));
  assert.throws(() => buildPluginPackage({ packageRoot, workspace: '.' }), /absolute.*Git workspace/i);
  assert.throws(() => buildPluginPackage({ packageRoot, workspace: path.join(workspace, 'missing') }), /Git workspace/i);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-plugin-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  assert.throws(() => buildPluginPackage({ packageRoot, workspace: outside }), /Git workspace/i);
});
