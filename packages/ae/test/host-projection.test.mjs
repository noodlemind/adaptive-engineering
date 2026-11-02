import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';
import { projectHostCorpus } from '../lib/hosts/projection.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configHome = path.resolve(os.tmpdir(), 'ae projection config');
const skillsHome = path.resolve(os.tmpdir(), 'ae projection skills');
const project = host => projectHostCorpus({ packageRoot, host, configHome, skillsHome });
const portablePath = value => value.replaceAll('\\', '/');
const metadata = text => YAML.parse(text.match(/^---\n([\s\S]*?)\n---\n/)[1]);
const find = (result, root, rel) => result.files.find(file => file.root === root && file.path === rel)?.content;

test('every supporting skill is projected to the selected skill root without changing the source', () => {
  const source = path.join(packageRoot, 'corpus/skills/ensure-plan/SKILL.md');
  const before = fs.readFileSync(source, 'utf8');
  const result = project('codex');
  const skills = fs.readdirSync(path.join(packageRoot, 'corpus/skills'), { withFileTypes: true })
    .filter(item => item.isDirectory() && fs.existsSync(path.join(packageRoot, 'corpus/skills', item.name, 'SKILL.md')));
  for (const skill of skills) assert.ok(find(result, 'skills', `${skill.name}/SKILL.md`), `missing ${skill.name}`);
  assert.ok(find(result, 'skills', 'references/plan-operations.md'));
  assert.ok(find(result, 'config', 'knowledge/manifest.yaml'));
  assert.ok(find(result, 'config', 'enterprise/capability-registry.enterprise.yaml'));
  for (const file of result.files) assert.doesNotMatch(file.content, /<copilot-home>|~\/\.copilot|<skills-root>|@engineer/);
  assert.ok(find(result, 'skills', 'ensure-plan/SKILL.md').includes(portablePath(path.join(skillsHome, 'references/plan-operations.md'))));
  assert.ok(find(result, 'skills', 'references/knowledge-locations.md').includes(portablePath(path.join(configHome, 'knowledge'))));
  assert.equal(fs.readFileSync(source, 'utf8'), before);
  assert.deepEqual(result, project('codex'));
});

test('Claude native roles preserve read-only tool boundaries and bounded main-thread delegation', () => {
  const result = project('claude-code');
  const reviewer = metadata(find(result, 'config', 'agents/security-sentinel.md'));
  assert.equal(reviewer.name, 'security-sentinel');
  assert.deepEqual([...reviewer.tools].sort(), ['Glob', 'Grep', 'Read']);
  const actor = metadata(find(result, 'config', 'agents/code-implementer.md'));
  assert.ok(actor.tools.includes('Bash') && actor.tools.includes('Edit') && actor.tools.includes('Write'));
  assert.ok(!actor.tools.some(tool => tool.startsWith('Agent')));
  const engineer = metadata(find(result, 'config', 'agents/engineer.md'));
  assert.ok(engineer.tools.some(tool => tool.startsWith('Agent(code-implementer,')));
  assert.equal(engineer.model, undefined);
  assert.equal(engineer.permissionMode, undefined);
  assert.ok(result.limitations.some(line => /subagent.*allowlist/i.test(line)));
});

test('Codex agents use standalone TOML and report inherited permission limitations', () => {
  const result = project('codex');
  const text = find(result, 'config', 'agents/engineer.toml');
  assert.match(text, /^name = "engineer"\ndescription = /);
  const prompt = JSON.parse(text.split('\n').find(line => line.startsWith('developer_instructions = ')).slice('developer_instructions = '.length));
  assert.match(prompt, /successful implement gate before editing/);
  assert.ok(prompt.includes(portablePath(path.join(skillsHome, 'engineer/references/ae-instructions.md'))));
  assert.doesNotMatch(text, /sandbox_mode|approval_policy|model_provider|config_file/);
  assert.equal(find(result, 'config', 'AGENTS.md'), undefined);
  assert.ok(result.limitations.some(line => /inherit.*permission/i.test(line)));
  assert.equal(result.capabilities.roleToolIsolation, false);
});

test('Cursor roles and scoped instructions use native metadata without claiming hard stop parity', () => {
  const result = project('cursor');
  assert.equal(metadata(find(result, 'config', 'agents/security-sentinel.md')).readonly, true);
  assert.equal(metadata(find(result, 'config', 'agents/code-implementer.md')).readonly, false);
  const rule = metadata(find(result, 'config', 'rules/typescript.mdc'));
  assert.equal(rule.globs, '**/*.{ts,tsx}');
  assert.equal(rule.alwaysApply, false);
  assert.equal(metadata(find(result, 'config', 'rules/harness-global.mdc')).alwaysApply, true);
  assert.equal(result.capabilities.stopBlocking, false);
});

test('Claude scoped rules preserve paths and terminal projections are explicitly manual', () => {
  const result = project('claude-code');
  assert.deepEqual(metadata(find(result, 'config', 'rules/typescript.md')).paths, ['**/*.{ts,tsx}']);
  const manual = project('terminal');
  assert.ok(find(manual, 'config', 'agents/engineer.md'));
  assert.equal(manual.capabilities.nativeAgents, false);
  assert.equal(manual.capabilities.nativeHooks, false);
  assert.ok(manual.limitations.some(line => /manual/i.test(line)));
});

test('projection rejects unsupported hosts and ambiguous roots without creating files', () => {
  assert.throws(() => project('future-host'), /Unsupported host/);
  assert.throws(() => projectHostCorpus({ packageRoot, host: 'codex', configHome: 'relative', skillsHome }), /absolute/);
  assert.throws(() => projectHostCorpus({ packageRoot, host: 'codex', configHome, skillsHome: '' }), /absolute/);
  assert.throws(() => projectHostCorpus({ packageRoot, host: 'codex', configHome, skillsHome, home: 'relative' }), /absolute/);
});

test('native Engineer, skills and actor prompts bind every CLI call to the selected corpus and optional state home', () => {
  const home = path.resolve(os.tmpdir(), 'ae selected state');
  const expected = JSON.stringify(['--copilot-home', portablePath(configHome), '--skills-home', portablePath(skillsHome), '--ae-home', portablePath(home)]);
  for (const host of ['claude-code', 'codex', 'cursor', 'terminal']) {
    const result = projectHostCorpus({ packageRoot, host, configHome, skillsHome, home });
    const native = find(result, 'config', `agents/engineer.${host === 'codex' ? 'toml' : 'md'}`);
    const actor = find(result, 'config', `agents/code-implementer.${host === 'codex' ? 'toml' : 'md'}`);
    const prompt = text => host === 'codex' ? JSON.parse(text.split('\n').find(line => line.startsWith('developer_instructions = ')).slice('developer_instructions = '.length)) : text;
    for (const text of [prompt(native), prompt(actor), find(result, 'skills', 'engineer/SKILL.md'), find(result, 'skills', 'ensure-plan/SKILL.md')]) {
      assert.ok(text.includes(expected), `${host}: missing literal CLI binding`);
      assert.match(text, /before.*`--`.*boundary/);
    }
    if (host === 'terminal') assert.ok(find(result, 'config', 'ae-start.md').includes(expected));
  }
  const noState = find(project('claude-code'), 'skills', 'engineer/SKILL.md');
  const bindingLine = noState.split('\n').find(line => line.startsWith('For every AE CLI invocation'));
  assert.ok(!bindingLine.includes('--ae-home'));
});

test('delegation-only native roles consume the prepared packet without acquiring Read or execution authority', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-projection-delegation-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.cpSync(path.join(packageRoot, 'corpus'), path.join(fixture, 'corpus'), { recursive: true });
  const role = path.join(fixture, 'corpus/agents/code-review-coordinator.agent.md');
  fs.writeFileSync(role, `---\n${YAML.stringify({ description: 'Dispatch the supplied review packet.', tools: ['agent'], agents: ['security-sentinel'] })}---\n\nDispatch the caller-supplied packet and return raw results.\n`);
  const result = projectHostCorpus({ packageRoot: fixture, host: 'claude-code', configHome, skillsHome });
  const text = find(result, 'config', 'agents/code-review-coordinator.md');
  assert.deepEqual(metadata(text).tools, ['Agent(security-sentinel)']);
  assert.doesNotMatch(text, /Read `.*ae-instructions|For every AE CLI invocation/);
  assert.match(text, /prepared packet/i);
  const ordinaryReviewer = find(result, 'config', 'agents/security-sentinel.md');
  assert.match(ordinaryReviewer, /Read `.*ae-instructions/);
  assert.doesNotMatch(ordinaryReviewer, /For every AE CLI invocation/);
});

test('transitive native guidance uses the installed package fallback instead of legacy Copilot setup', () => {
  const result = project('claude-code');
  for (const item of result.files.filter(item => /\.(md|mdc)$/.test(item.path))) {
    assert.ok(!item.content.includes(`${portablePath(configHome)}/bin/ae`), item.path);
    assert.doesNotMatch(item.content, /ae install --configure-(?:path|vscode)|ae\.mjs install --configure-path/, item.path);
  }
  for (const [root, rel] of [['config', 'rules/harness-global.md'], ['skills', 'engineer/references/ae-instructions.md'], ['skills', 'references/harness-tool-contract.md']]) {
    const content = find(result, root, rel);
    assert.ok(content.includes(portablePath(path.join(packageRoot, 'bin/ae.mjs'))), rel);
    assert.ok(content.includes(JSON.stringify(['--copilot-home', portablePath(configHome), '--skills-home', portablePath(skillsHome)])), rel);
  }
});

test('CRLF source instructions receive the same native invocation guidance', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-projection-crlf-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.cpSync(path.join(packageRoot, 'corpus'), path.join(fixture, 'corpus'), { recursive: true });
  for (const rel of ['instructions/harness-global.instructions.md', 'skills/references/harness-tool-contract.md']) {
    const full = path.join(fixture, 'corpus', rel);
    fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
  }
  const result = projectHostCorpus({ packageRoot: fixture, host: 'claude-code', configHome, skillsHome });
  for (const content of [find(result, 'config', 'rules/harness-global.md'), find(result, 'skills', 'references/harness-tool-contract.md')]) {
    assert.ok(content.includes(portablePath(path.join(fixture, 'bin/ae.mjs'))));
    assert.doesNotMatch(content, /ae install --configure|node .*\/bin\/ae …/);
  }
});

test('native personal skill creation is mapped while personal roles and instructions remain explicit capability gaps', () => {
  for (const host of ['claude-code', 'codex', 'cursor', 'terminal']) {
    const result = project(host);
    const creator = find(result, 'skills', 'create-primitive/SKILL.md');
    assert.equal(result.capabilities.personalSkillCreation, true);
    assert.equal(result.capabilities.personalRoleCreation, false);
    assert.match(creator, /Native personal skills[\s\S]*schema 1[\s\S]*`ae resources create skill/);
    assert.match(creator, /personal agents and instructions[\s\S]*unmapped capability/i);
    assert.match(creator, /Do not fall back to Copilot/);
  }
});
