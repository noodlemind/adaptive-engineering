import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settingsModule = pathToFileURL(path.join(packageRoot, 'lib/vscode-settings.mjs')).href;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixture(t, { profiles = ['Code'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-vscode-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileBase = process.platform === 'win32' ? path.join(root, 'AppData/Roaming')
    : process.platform === 'darwin' ? path.join(root, 'Library/Application Support') : path.join(root, '.config');
  const users = profiles.map(profile => path.join(profileBase, profile, 'User'));
  for (const user of users) fs.mkdirSync(user, { recursive: true });
  const copilotHome = path.join(root, 'selected copilot');
  const aeHome = path.join(root, 'selected ae');
  const skillsHome = path.join(root, 'selected skills');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const flags = { copilotHome, harnessHome: aeHome, skillsHome };
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'AppData/Roaming'), LOCALAPPDATA: path.join(root, 'AppData/Local'), AE_HOME: aeHome, HARNESS_HOME: aeHome, COPILOT_HOME: copilotHome, NO_COLOR: '1' };
  const configure = extra => spawnSync(process.execPath, ['--input-type=module', '-e', `import { configureVSCodeSettings } from ${JSON.stringify(settingsModule)}; try { configureVSCodeSettings(JSON.parse(process.argv[1]), console.log); } catch (error) { console.error(error.code, error.message); process.exitCode=2; }`, JSON.stringify({ ...flags, ...extra })], { env, encoding: 'utf8', timeout: 20_000 });
  const cli = args => spawnSync(process.execPath, [path.join(packageRoot, 'bin/ae.mjs'), ...args, '--ae-home', aeHome, '--copilot-home', copilotHome, '--workspace', workspace, '--no-events'], { cwd: workspace, env, encoding: 'utf8', timeout: 60_000 });
  return { root, users, copilotHome, aeHome, skillsHome, workspace, flags, env, configure, cli };
}

test('VS Code configuration advertises AE structured tools bound to the opened folder', t => {
  const f = fixture(t);
  const settingsPath = path.join(f.users[0], 'settings.json');
  const mcpPath = path.join(f.users[0], 'mcp.json');
  const approvals = { 'chat.tools.terminal.autoApprove': { node: false }, 'chat.tools.global.autoApprove': false };
  fs.writeFileSync(settingsPath, JSON.stringify(approvals));
  const otherServer = { type: 'http', url: 'https://example.test/mcp' };
  fs.writeFileSync(mcpPath, '{\n// Keep the unrelated server\n"servers":{"other":' + JSON.stringify(otherServer) + ',},"inputs":[],\n}');
  const configured = f.configure();
  assert.equal(configured.status, 0, configured.stdout + configured.stderr);
  const config = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  assert.deepEqual(config.servers.other, otherServer);
  assert.deepEqual(config.inputs, []);
  assert.deepEqual(config.servers.ae, {
    type: 'stdio', command: process.execPath, cwd: '${workspaceFolder}',
    args: [path.join(f.copilotHome, '.ae-bin/bin/ae.mjs'), 'mcp', 'serve', '--workspace', '${workspaceFolder}', '--ae-home', f.aeHome, '--copilot-home', f.copilotHome, '--skills-home', f.skillsHome],
  });
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const [key, value] of Object.entries(approvals)) assert.deepEqual(settings[key], value);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.users[0], 'mcp.ae-lock.json'), 'utf8'));
  assert.equal(receipt.sha256, digest(config.servers.ae));
  assert.equal(fs.existsSync(path.join(f.root, '.mcp.json')), false);
  assert.equal(fs.existsSync(path.join(f.copilotHome, 'mcp-config.json')), false);
  const before = fs.readFileSync(mcpPath, 'utf8');
  assert.equal(f.configure().status, 0);
  assert.equal(fs.readFileSync(mcpPath, 'utf8'), before);
});

test('structured tool setup dry run writes neither configuration nor ownership', t => {
  const f = fixture(t);
  const result = f.configure({ dryRun: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /mcp\.json/);
  assert.deepEqual(fs.readdirSync(f.users[0]), []);
});

for (const invalid of ['{ broken', '[]', '{"servers":[]}']) test(`all profiles preflight before updating settings or structured transport: ${invalid}`, t => {
  const f = fixture(t, { profiles: ['Code', 'Code - Insiders'] });
  const original = '{\n  // Preserve authored settings\n  "editor.fontSize": 19\n}\n';
  fs.writeFileSync(path.join(f.users[0], 'settings.json'), original);
  fs.writeFileSync(path.join(f.users[1], 'mcp.json'), invalid);
  const result = f.configure();
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /E_VSCODE_SETTINGS.*mcp\.json/);
  assert.equal(fs.readFileSync(path.join(f.users[0], 'settings.json'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(f.users[0], 'mcp.json')), false);
  assert.equal(fs.existsSync(path.join(f.users[1], 'settings.json')), false);
});

test('authored AE MCP bindings are preserved and reported as conflicts', t => {
  const f = fixture(t);
  const mcpPath = path.join(f.users[0], 'mcp.json');
  const original = JSON.stringify({ servers: { ae: { type: 'stdio', command: 'authored-tool', args: ['custom'] } } });
  fs.writeFileSync(mcpPath, original);
  const result = f.configure();
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /conflict|authored/i);
  assert.equal(fs.readFileSync(mcpPath, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(f.users[0], 'settings.json')), false);
});

test('an unchanged owned binding can refresh a relocated Node runtime', t => {
  const f = fixture(t);
  assert.equal(f.configure().status, 0);
  const mcpPath = path.join(f.users[0], 'mcp.json');
  const receiptPath = path.join(f.users[0], 'mcp.ae-lock.json');
  const config = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  config.servers.ae.command = path.join(f.root, 'previous-node');
  fs.writeFileSync(mcpPath, JSON.stringify(config));
  fs.writeFileSync(receiptPath, JSON.stringify({ version: 1, server: 'ae', sha256: digest(config.servers.ae) }));
  const upgraded = f.configure();
  assert.equal(upgraded.status, 0, upgraded.stdout + upgraded.stderr);
  assert.equal(JSON.parse(fs.readFileSync(mcpPath, 'utf8')).servers.ae.command, process.execPath);
  const changed = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  changed.servers.ae.args.push('--authored-option');
  fs.writeFileSync(mcpPath, JSON.stringify(changed));
  assert.equal(f.configure().status, 2, 'an authored edit invalidates ownership');
  assert.deepEqual(JSON.parse(fs.readFileSync(mcpPath, 'utf8')), changed);
});

test('symlinked MCP configuration is refused before settings update', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'authored-mcp.json');
  const original = '{"servers":{}}';
  fs.writeFileSync(outside, original);
  fs.symlinkSync(outside, path.join(f.users[0], 'mcp.json'));
  const result = f.configure();
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(f.users[0], 'settings.json')), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), original);
});

for (const [name, content] of [['mcp.json', '{"padding":"' + 'x'.repeat(1024 * 1024) + '"}'], ['mcp.ae-lock.json', '{"version":1,"server":"ae","sha256":"invalid"}']]) test(`unsafe ${name} is refused before profile updates`, t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.users[0], name), content);
  const result = f.configure();
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(f.users[0], 'settings.json')), false);
  assert.equal(fs.readFileSync(path.join(f.users[0], name), 'utf8'), content);
});

test('install preflights MCP conflicts before hydrating any AE assets', t => {
  const f = fixture(t);
  const mcpPath = path.join(f.users[0], 'mcp.json');
  const original = '{"servers":{"ae":{"type":"stdio","command":"authored"}}}';
  fs.writeFileSync(mcpPath, original);
  const result = spawnSync(process.execPath, [path.join(packageRoot, 'bin/ae.mjs'), 'install', '--target', 'vscode', '--configure-vscode', '--ae-home', f.aeHome, '--copilot-home', f.copilotHome, '--workspace', f.root, '--no-events'], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 60_000 });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /E_VSCODE_SETTINGS/);
  assert.equal(fs.existsSync(path.join(f.copilotHome, 'agents/engineer.agent.md')), false);
  assert.equal(fs.readFileSync(mcpPath, 'utf8'), original);
});

test('bare upgrade refreshes legacy configured profiles without changing product policies or unconfigured profiles', t => {
  const f = fixture(t, { profiles: ['Code', 'Code - Insiders'] });
  const settingsPath = path.join(f.users[0], 'settings.json');
  const untouched = '{"editor.fontSize":21}';
  const approvals = { 'chat.tools.terminal.autoApprove': { node: false } };
  fs.writeFileSync(settingsPath, JSON.stringify({ ...approvals, 'chat.agentFilesLocations': { [path.join(f.copilotHome, 'agents').replace(/\\/g, '/')]: true } }));
  fs.writeFileSync(path.join(f.users[1], 'settings.json'), untouched);
  const policy = path.join(f.workspace, '.github/harness/policy.yaml');
  fs.mkdirSync(path.dirname(policy), { recursive: true });
  const policyBytes = 'enforcement: enforce\n# Keep authored policy unchanged.\n';
  fs.writeFileSync(policy, policyBytes);
  const result = f.cli(['upgrade']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const server = JSON.parse(fs.readFileSync(path.join(f.users[0], 'mcp.json'), 'utf8')).servers.ae;
  assert.equal(server.cwd, '${workspaceFolder}');
  assert.equal(server.args[server.args.indexOf('--ae-home') + 1], f.aeHome);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))['chat.tools.terminal.autoApprove'], approvals['chat.tools.terminal.autoApprove']);
  assert.equal(fs.readFileSync(policy, 'utf8'), policyBytes);
  assert.equal(fs.readFileSync(path.join(f.users[1], 'settings.json'), 'utf8'), untouched);
  assert.equal(fs.existsSync(path.join(f.users[1], 'mcp.json')), false);
});

test('bare upgrade refreshes an owned MCP binding even after discovery settings were removed', t => {
  const f = fixture(t);
  assert.equal(f.configure().status, 0);
  fs.writeFileSync(path.join(f.users[0], 'settings.json'), '{}');
  const mcpPath = path.join(f.users[0], 'mcp.json');
  const config = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  config.servers.ae.command = path.join(f.root, 'previous-node');
  fs.writeFileSync(mcpPath, JSON.stringify(config));
  fs.writeFileSync(path.join(f.users[0], 'mcp.ae-lock.json'), JSON.stringify({ version: 1, server: 'ae', sha256: digest(config.servers.ae) }));
  const result = f.cli(['upgrade', '--target', 'cli']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(mcpPath, 'utf8')).servers.ae.command, process.execPath);
});

for (const target of ['cli', 'intellij']) test(`bare ${target} upgrade preserves previously unconfigured VS Code profiles`, t => {
  const f = fixture(t);
  const settingsPath = path.join(f.users[0], 'settings.json');
  const original = '{"editor.fontSize":21}';
  fs.writeFileSync(settingsPath, original);
  const result = f.cli(['upgrade', '--target', target]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(f.users[0], 'mcp.json')), false);
});

test('IntelliJ-only upgrade leaves a previously configured VS Code integration alone', t => {
  const f = fixture(t);
  const settingsPath = path.join(f.users[0], 'settings.json');
  const original = JSON.stringify({ 'chat.hookFilesLocations': { [path.join(f.copilotHome, 'hooks').replace(/\\/g, '/')]: true } });
  fs.writeFileSync(settingsPath, original);
  const result = f.cli(['upgrade', '--target', 'intellij']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(f.users[0], 'mcp.json')), false);
});

test('bare upgrade preflights authored MCP conflicts before replacing installed assets', t => {
  const f = fixture(t);
  const settingsPath = path.join(f.users[0], 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ 'chat.hookFilesLocations': { [path.join(f.copilotHome, 'hooks').replace(/\\/g, '/')]: true } }));
  const mcpPath = path.join(f.users[0], 'mcp.json');
  const original = '{"servers":{"ae":{"type":"stdio","command":"authored"}}}';
  fs.writeFileSync(mcpPath, original);
  const result = f.cli(['upgrade', '--target', 'cli']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /E_VSCODE_SETTINGS/);
  assert.equal(fs.existsSync(path.join(f.copilotHome, 'agents/engineer.agent.md')), false);
  assert.equal(fs.readFileSync(mcpPath, 'utf8'), original);
});

test('explicit configure on upgrade includes profiles without previous discovery', t => {
  const f = fixture(t);
  const result = f.cli(['upgrade', '--target', 'cli', '--configure-vscode']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.users[0], 'mcp.json'), 'utf8')).servers.ae.cwd, '${workspaceFolder}');
});

test('upgrade detection requires enabled selected-home discovery or a valid matching receipt', t => {
  const f = fixture(t);
  const settingsPath = path.join(f.users[0], 'settings.json');
  const detect = () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { configuredVSCodeSettingsPaths } from ${JSON.stringify(settingsModule)}; console.log(JSON.stringify(configuredVSCodeSettingsPaths(JSON.parse(process.argv[1]))));`, JSON.stringify({ copilotHome: f.copilotHome })], { env: f.env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  fs.writeFileSync(settingsPath, JSON.stringify({ 'chat.hookFilesLocations': { [path.join(f.copilotHome, 'hooks')]: false, [path.join(f.root, 'other copilot/hooks')]: true } }));
  assert.deepEqual(detect(), []);
  fs.writeFileSync(path.join(f.users[0], 'mcp.ae-lock.json'), '{"version":1,"server":"ae","sha256":"not-proof"}');
  assert.deepEqual(detect(), []);
  fs.writeFileSync(settingsPath, JSON.stringify({ 'chat.agentFilesLocations': [path.join(f.copilotHome, 'agents')] }));
  assert.deepEqual(detect(), [settingsPath]);
});
