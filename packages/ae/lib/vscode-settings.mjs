import fs from 'fs';
import os from 'node:os';
import path from 'path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { harnessGlobalHome, resolveCopilotHome, resolveVSCodeSettingsPaths } from './paths.mjs';
import { assertNoSymlinkAncestors, readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { EXIT } from './style.mjs';

const LOCATION_KEYS = {
  'chat.agentFilesLocations': 'agents',
  'chat.instructionsFilesLocations': 'instructions',
  'chat.agentSkillsLocations': 'skills',
  'chat.hookFilesLocations': 'hooks',
};
const MERGE_KEYS = {
  'chat.customAgentInSubagent.enabled': true,
  'chat.useAgentSkills': true,
  'chat.subagents.allowInvocationsFromSubagents': true,
};

export function vscodeCustomizationLocations(copilotHome = path.join(os.homedir(), '.copilot')) {
  const home = path.resolve(copilotHome);
  const prefix = path.relative(path.join(os.homedir(), '.copilot'), home) === '' ? '~/.copilot' : home.replace(/\\/g, '/');
  return Object.fromEntries(Object.entries(LOCATION_KEYS).map(([key, directory]) => [key, `${prefix}/${directory}`]));
}

function stripJsonComments(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        output += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index++;
      } else if (char === '\n') output += char;
      continue;
    }
    if (!inString && char === '/' && next === '/') {
      lineComment = true;
      index++;
      continue;
    }
    if (!inString && char === '/' && next === '*') {
      blockComment = true;
      index++;
      continue;
    }
    output += char;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
  }
  return output;
}

function stripTrailingCommas(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!inString && char === ',') {
      let next = index + 1;
      while (/\s/.test(text[next] || '')) next++;
      if (text[next] === '}' || text[next] === ']') continue;
    }
    output += char;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
  }
  return output;
}

export function parseVSCodeSettings(text) {
  const value = JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settings must be a JSON object');
  return value;
}

function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

export function mergeVSCodeSettings(settings = {}, { copilotHome } = {}) {
  const copy = JSON.parse(JSON.stringify(settings));
  const locations = Object.fromEntries(Object.entries(vscodeCustomizationLocations(copilotHome)).map(([key, location]) => [key, { [location]: true }]));
  for (const key of Object.keys(locations)) {
    if (Array.isArray(copy[key]) && copy[key].every(location => typeof location === 'string')) copy[key] = Object.fromEntries(copy[key].map(location => [location, true]));
  }
  return deepMerge(copy, { ...locations, ...MERGE_KEYS });
}

function readConfiguration(full) {
  if (!assertNoSymlinkAncestors(path.dirname(full), path.basename(full))) throw new Error('configuration path is symlinked');
  const stat = fs.lstatSync(full, { throwIfNoEntry: false });
  if (!stat) return { data: {}, mode: 0o600 };
  const raw = readFileNoFollow(full, { root: path.dirname(full), maxBytes: 1024 * 1024 });
  if (raw === null) throw new Error('source is unreadable, symlinked, nonregular or larger than 1 MiB');
  return { data: parseVSCodeSettings(raw), mode: stat.mode & 0o777 };
}

const serverHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function configuredVSCodeSettingsPaths({ copilotHome } = {}) {
  const home = resolveCopilotHome(copilotHome);
  const canonical = value => {
    if (typeof value !== 'string' || !value) return null;
    const full = path.resolve(value.replace(/^~(?=[/\\]|$)/, os.homedir()));
    return process.platform === 'win32' ? full.toLowerCase() : full;
  };
  const read = full => { try { return readConfiguration(full).data; } catch { return null; } };
  return resolveVSCodeSettingsPaths().filter(settingsPath => {
    const settings = read(settingsPath);
    if (Object.entries(LOCATION_KEYS).some(([key, directory]) => {
      const locations = settings?.[key];
      const enabled = Array.isArray(locations) ? locations : locations && typeof locations === 'object' ? Object.keys(locations).filter(key => locations[key] === true) : [];
      return enabled.some(location => canonical(location) === canonical(path.join(home, directory)));
    })) return true;
    const receipt = read(path.join(path.dirname(settingsPath), 'mcp.ae-lock.json'));
    const server = read(path.join(path.dirname(settingsPath), 'mcp.json'))?.servers?.ae;
    return receipt?.version === 1 && receipt.server === 'ae' && server && receipt.sha256 === serverHash(server)
      && Array.isArray(server.args) && canonical(server.args[0]) === canonical(path.join(home, '.ae-bin', 'bin', 'ae.mjs'))
      && canonical(server.args[server.args.indexOf('--copilot-home') + 1]) === canonical(home);
  });
}

export function configureVSCodeSettings(flags, log, { settingsPaths = resolveVSCodeSettingsPaths() } = {}) {
  const paths = settingsPaths;
  const failure = (settingsPath, reason) => Object.assign(new Error(`Cannot configure VS Code settings ${settingsPath}: ${reason}`), {
    code: 'E_VSCODE_SETTINGS', exit: EXIT.syncConflict,
    hint: 'Inspect the reported settings or MCP configuration and restore a readable regular JSONC object, then retry ae install --target vscode --configure-vscode with the same --copilot-home. Authored settings and conflicting MCP servers are not replaced.',
  });
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const server = {
    type: 'stdio', command: process.execPath, cwd: '${workspaceFolder}',
    args: [path.join(copilotHome, '.ae-bin', 'bin', 'ae.mjs'), 'mcp', 'serve', '--workspace', '${workspaceFolder}',
      '--ae-home', path.resolve(flags.harnessHome || flags.home || harnessGlobalHome()), '--copilot-home', copilotHome,
      '--skills-home', path.resolve(flags.skillsHome || process.env.AE_SKILLS_HOME || process.env.HARNESS_SKILLS_HOME || path.join(copilotHome, 'skills'))],
  };
  const read = full => {
    try {
      return readConfiguration(full);
    } catch (error) { throw failure(full, error.message); }
  };
  const prepared = (full, data, mode) => ({ settingsPath: full, content: JSON.stringify(data, null, 2) + '\n', mode });
  // Validate every discovered profile before updating any. In particular, a
  // malformed Insiders profile or MCP conflict must not leave partial setup.
  const updates = paths.flatMap(settingsPath => {
    const settings = read(settingsPath);
    const mcpPath = path.join(path.dirname(settingsPath), 'mcp.json');
    const receiptPath = path.join(path.dirname(settingsPath), 'mcp.ae-lock.json');
    const mcp = read(mcpPath);
    const receipt = read(receiptPath);
    if (mcp.data.servers !== undefined && (!mcp.data.servers || typeof mcp.data.servers !== 'object' || Array.isArray(mcp.data.servers))) throw failure(mcpPath, 'servers must be an object');
    if (Object.keys(receipt.data).length && (receipt.data.version !== 1 || receipt.data.server !== 'ae' || !/^[a-f0-9]{64}$/.test(receipt.data.sha256 || '')
      || Object.keys(receipt.data).some(key => !['version', 'server', 'sha256'].includes(key)))) throw failure(receiptPath, 'AE MCP ownership record is invalid');
    const current = mcp.data.servers?.ae;
    if (current !== undefined && !isDeepStrictEqual(current, server) && receipt.data.sha256 !== serverHash(current)) {
      throw failure(mcpPath, 'authored ae server conflicts with the selected AE binding; preserve or rename it before retrying');
    }
    return [
      prepared(settingsPath, mergeVSCodeSettings(settings.data, { copilotHome }), settings.mode),
      prepared(mcpPath, { ...mcp.data, servers: { ...mcp.data.servers, ae: server } }, mcp.mode),
      prepared(receiptPath, { version: 1, server: 'ae', sha256: serverHash(server) }, receipt.mode),
    ];
  });
  for (const { settingsPath, content, mode } of updates) {
    if (flags.dryRun) {
      log(`would update ${settingsPath}`);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      if (!writeFileContained(path.dirname(settingsPath), path.basename(settingsPath), content, { mode })) throw new Error('safe atomic write refused');
    } catch (error) { throw failure(settingsPath, error.message); }
    log(`updated ${settingsPath}`);
  }
  return paths.length;
}
