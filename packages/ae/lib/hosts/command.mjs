import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { runHostSetup } from './setup.mjs';
import { buildPluginPackage } from './plugin-package.mjs';
import { readLock } from '../lock.mjs';
import { resolveCopilotHome, resolveIntelliJHome, harnessGlobalHome } from '../paths.mjs';
import { assertNoSymlinkAncestors } from '../fs-safe.mjs';
import { redactedJson } from '../redact.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const HOST_VERBS = ['list', 'setup', 'status', 'remove', 'export'];
const legacy = { 'copilot-vscode': 'vscode', 'copilot-cli': 'cli', 'copilot-intellij': 'intellij' };
const aliases = { vscode: 'copilot-vscode', cli: 'copilot-cli', intellij: 'copilot-intellij', claude: 'claude-code' };

function parse(argv) {
  const result = { verb: null, packageRoot, workspace: process.cwd() };
  const values = { '--host': 'host', '--config-home': 'configHome', '--host-home': 'configHome', '--copilot-home': 'configHome', '--skills-home': 'skillsHome', '--ae-home': 'home', '--harness-home': 'home', '--workspace': 'workspace', '--output-directory': 'outputDirectory' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (['--json', '--dry-run'].includes(token)) { result[token === '--json' ? 'json' : 'dryRun'] = true; continue; }
    if (['--no-color', '--no-events', '--verbose', '-v'].includes(token)) continue;
    if (token.startsWith('-')) {
      const equal = token.indexOf('=');
      const name = equal < 0 ? token : token.slice(0, equal), key = values[name];
      if (!key || seen.has(key)) throw new Error(`Unknown or duplicate host option: ${name}`);
      seen.add(key);
      const value = equal < 0 ? argv[++i] : token.slice(equal + 1);
      if (!value || value.startsWith('-') || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name} requires a value`);
      result[key] = key === 'host' ? (aliases[value] || value) : path.resolve(value);
    } else if (!result.verb) result.verb = token;
    else throw new Error('Unexpected host argument');
  }
  result.verb ||= 'list';
  if (!HOST_VERBS.includes(result.verb)) throw new Error('Unknown host operation');
  if (result.verb === 'list' && (result.host || result.outputDirectory)) throw new Error('host list takes no host or output directory');
  if (result.verb === 'export' && (result.host || !result.outputDirectory)) throw new Error('host export requires --output-directory and no --host (portable Agent Plugins package)');
  if (!['list', 'export'].includes(result.verb) && !result.host) throw new Error('Select --host claude-code, codex, cursor, terminal or a legacy copilot target');
  if (result.verb !== 'export' && result.outputDirectory) throw new Error('--output-directory requires host export');
  result.home ||= harnessGlobalHome();
  return result;
}

function runLegacy(options) {
  const target = legacy[options.host];
  const root = options.configHome || (target === 'intellij' ? resolveIntelliJHome() : resolveCopilotHome());
  const lock = readLock(root, { strict: true });
  const capabilities = { legacy: true, nativeQualification: 'unverified' };
  if (options.verb === 'status') return { schema: 1, status: 'ok', exitCode: 0, host: options.host, roots: { configHome: root }, configured: lock ? (Array.isArray(lock.targets) ? lock.targets.includes(target) : null) : false, capabilities, nativeQualification: 'unverified' };
  if (options.verb === 'remove' && lock && (!Array.isArray(lock.targets) || lock.targets.some(item => item !== target))) {
    return { schema: 1, status: 'conflict', exitCode: 1, reason: 'This legacy home is shared by multiple Copilot surfaces. Use ae uninstall only when removing all of them.', capabilities };
  }
  const command = options.verb === 'remove' ? 'uninstall' : lock ? 'upgrade' : 'install';
  const args = [path.join(packageRoot, 'bin/ae.mjs'), command, '--copilot-home', root, '--ae-home', options.home, '--workspace', options.workspace, '--json',
    ...(command === 'uninstall' ? [] : ['--target', target, ...(target === 'vscode' ? ['--configure-vscode'] : [])]), ...(options.dryRun ? ['--dry-run'] : [])];
  const child = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ...(target === 'intellij' ? { AE_INTELLIJ_HOME: root } : {}) } });
  let details;
  try { details = JSON.parse(child.stdout); } catch { details = { stdout: child.stdout, stderr: child.stderr }; }
  return { schema: 1, host: options.host, status: child.status === 0 ? 'ok' : 'failed', exitCode: child.status ?? 1, details, capabilities, nativeQualification: 'unverified' };
}

function exportPlugin(options) {
  const output = options.outputDirectory;
  const root = path.parse(output).root;
  if (!assertNoSymlinkAncestors(root, path.relative(root, output))) throw new Error('Refusing redirected plugin output');
  if (fs.existsSync(output)) throw new Error('Plugin output must be a new directory; existing files are never replaced');
  const built = buildPluginPackage({ packageRoot, workspace: options.workspace });
  if (options.dryRun) return { schema: 1, status: 'ok', exitCode: 0, dryRun: true, output, files: built.files.map(item => item.path), requirements: built.requirements, limitations: built.limitations };
  const stage = `${output}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(stage, { recursive: true });
    for (const item of built.files) {
      const full = assertNoSymlinkAncestors(stage, item.path);
      if (!full) throw new Error('Unsafe plugin output path');
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, item.content, { flag: 'wx' });
    }
    fs.renameSync(stage, output);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  return { schema: 1, status: 'ok', exitCode: 0, output, files: built.files.length, requirements: built.requirements, limitations: built.limitations };
}

export function hostResultOf(argv) {
  try {
    const options = parse(argv);
    if (options.verb === 'export') return exportPlugin(options);
    if (Object.hasOwn(legacy, options.host)) return runLegacy(options);
    const result = runHostSetup(options);
    if (options.verb === 'list') {
      result.hosts = result.hosts.map(item => ({ ...item, id: item.id || item.host }));
      result.hosts.push(...Object.keys(legacy).map(id => ({ id, legacy: true, nativeQualification: 'unverified' })));
    }
    return result;
  } catch (error) { return { schema: 1, status: 'failed', exitCode: 2, reason: error.message }; }
}

export function cmdHost(argv) {
  const result = hostResultOf(argv);
  if (argv.includes('--json')) console.log(redactedJson(result));
  else if (result.hosts) for (const host of result.hosts) console.log(`${host.id}${host.legacy ? ' (legacy Copilot setup)' : ''}`);
  else console.log(result.reason || `${result.status}: ${result.host || result.output || 'host export'}`);
  return result.exitCode;
}
