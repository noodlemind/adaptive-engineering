import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeRuntimeEnvironment, runtimeHome } from '../corpus/hooks/lib/runtime-identity.mjs';

export function resolveCopilotHome(override) {
  if (override) return path.resolve(override);
  if (process.env.COPILOT_HOME) return path.resolve(process.env.COPILOT_HOME);
  if (process.env.XDG_CONFIG_HOME) {
    const xdg = path.join(process.env.XDG_CONFIG_HOME, 'copilot');
        if (fs.existsSync(xdg)) return xdg;
  }
  return path.join(os.homedir(), '.copilot');
}

export function resolveIntelliJHome() {
  if (process.env.AE_INTELLIJ_HOME) return path.resolve(process.env.AE_INTELLIJ_HOME);
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'github-copilot', 'intellij');
  }
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'github-copilot',
      'intellij'
    );
  }
  return path.join(os.homedir(), '.local', 'share', 'github-copilot', 'intellij');
}

export function resolveVSCodeSettingsPaths() {
  const paths = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    paths.push(path.join(appData, 'Code', 'User', 'settings.json'));
    paths.push(path.join(appData, 'Code - Insiders', 'User', 'settings.json'));
  } else if (process.platform === 'darwin') {
    const base = path.join(os.homedir(), 'Library', 'Application Support');
    paths.push(path.join(base, 'Code', 'User', 'settings.json'));
    paths.push(path.join(base, 'Code - Insiders', 'User', 'settings.json'));
  } else {
    const base = path.join(os.homedir(), '.config');
    paths.push(path.join(base, 'Code', 'User', 'settings.json'));
    paths.push(path.join(base, 'Code - Insiders', 'User', 'settings.json'));
  }
  return paths.filter((p) => fs.existsSync(path.dirname(p)));
}

export function pkgRootFromImportMeta(metaUrl) {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), '..');
}

/** Shared CLI and hook state authority, including legacy store discovery. */
export function harnessGlobalHome() {
  return runtimeHome();
}

/** Apply --harness-home before any command reads the home. The flag wins over HARNESS_HOME. A repeated flag uses the last path, matching parseFlags. */
export function applyHarnessHomeFlag(argv, { valueFlags = new Set() } = {}) {
  const scan = argv.slice(0, argv.indexOf('--') === -1 ? argv.length : argv.indexOf('--'));
  for (let i = 0; i < scan.length; i++) {
    const token = scan[i];
    if (token !== '--skills-home' && !token.startsWith('--skills-home=')) {
      if (!token.includes('=') && valueFlags.has(token)) i++;
      continue;
    }
    const value = token === '--skills-home' ? scan[++i] : token.slice('--skills-home='.length);
    if (!value || value.startsWith('--') || /[\u0000-\u001f\u007f]/.test(value)) throw Object.assign(new Error('--skills-home requires a directory path'), { code: 'E_USAGE', exit: 2 });
    process.env.AE_SKILLS_HOME = path.resolve(value);
  }
  let chosen = null;
  const selections = new Map();
  for (let i = 0; i < scan.length; i++) {
    const token = scan[i];
    let value;
    let name;
    if (/^--(?:ae|harness)-home=/.test(token)) {
      name = token.slice(0, token.indexOf('='));
      value = token.slice(token.indexOf('=') + 1);
    } else if (token === '--ae-home' || token === '--harness-home') {
      name = token;
      value = scan[++i];
    }
    else continue;
    if (!value || value.startsWith('--')) {
      throw Object.assign(new Error('invalid --harness-home: requires a directory path'), {
        code: 'E_USAGE',
        hint: 'ae help',
        exit: 2,
      });
    }
    chosen = value;
    selections.set(name, path.resolve(value));
  }
  if (selections.size > 1 && new Set(selections.values()).size > 1) {
    throw Object.assign(new Error('--ae-home conflicts with --harness-home'), { code: 'E_USAGE', exit: 2 });
  }
  if (!chosen) {
    normalizeRuntimeEnvironment();
    return null;
  }
  process.env.HARNESS_HOME = path.resolve(chosen);
  if (selections.has('--ae-home') || process.env.AE_HOME) process.env.AE_HOME = process.env.HARNESS_HOME;
  normalizeRuntimeEnvironment();
  return process.env.HARNESS_HOME;
}
