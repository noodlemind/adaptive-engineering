import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function usage(message) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: 2, hint: 'ae help' });
}

export function runtimeSetting(name, env = process.env) {
  const canonical = env[`AE_${name}`];
  const legacy = env[`HARNESS_${name}`];
  const normalize = value => ['HOME', 'BIN'].includes(name) ? path.resolve(value) : value;
  if (canonical && legacy && normalize(canonical) !== normalize(legacy)) {
    throw usage(`AE_${name} conflicts with HARNESS_${name}; select one value`);
  }
  return canonical || legacy;
}

export function runtimeHome() {
  const selected = runtimeSetting('HOME');
  if (selected) return path.resolve(selected);
  const canonical = path.join(os.homedir(), '.ae');
  const legacy = path.join(os.homedir(), '.harness');
  const populated = dir => {
    try { return fs.readdirSync(dir).length > 0; } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  };
  const oldRecords = populated(legacy);
  if (oldRecords && populated(canonical)) {
    throw usage('Both ~/.ae and ~/.harness contain records; select --ae-home explicitly');
  }
  return oldRecords ? legacy : canonical;
}

/** The copied hook's own location binds custom legacy installation roots. */
export function runtimeCopilotHome() {
  if (process.env.COPILOT_HOME) return path.resolve(process.env.COPILOT_HOME);
  const local = fileURLToPath(new URL('../..', import.meta.url));
  const packaged = path.basename(path.resolve(local)) === 'corpus' && fs.existsSync(path.resolve(local, '../bin/ae.mjs'));
  if (!packaged) return path.resolve(local);
  const xdg = process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, 'copilot');
  return xdg && fs.existsSync(xdg) ? xdg : path.join(os.homedir(), '.copilot');
}

export function normalizeRuntimeEnvironment(env = process.env) {
  for (const key of Object.keys(env)) {
    if (!/^AE_[A-Z0-9_]+$/.test(key) || !env[key]) continue;
    const name = key.slice(3);
    env[`HARNESS_${name}`] = runtimeSetting(name, env);
  }
  return env;
}
