import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// A drive-relative or root-relative Windows path still depends on cwd.
const windowsAbsolute = value => typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value)
  && /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(value) && path.win32.isAbsolute(value);
const unavailable = message => Object.assign(new Error(message), { code: 'E_GIT_EXECUTABLE', exit: 1 });

/** Match Node's first lexicographically sorted, case-insensitive environment key. */
export function windowsEnvironmentValue(env, name) {
  const key = Object.keys(env || {}).sort().find(key => key.toUpperCase() === name.toUpperCase());
  return key && typeof env[key] === 'string' ? env[key] : null;
}

function realWindowsExecutable(candidate) {
  try {
    const full = fs.realpathSync.native(candidate);
    return windowsAbsolute(full) && /\.exe$/i.test(full) && fs.statSync(full).isFile() ? full : null;
  } catch { return null; }
}

/** Filesystem-only selector: never search cwd, relative PATH entries or PATHEXT. */
export function selectWindowsGitExecutable(pathValue, inspectCandidate) {
  if (typeof pathValue !== 'string') return null;
  for (const entry of pathValue.split(';')) {
    const directory = entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
    if (!windowsAbsolute(directory)) continue;
    const full = inspectCandidate(path.win32.join(directory, 'git.exe'));
    if (windowsAbsolute(full) && /\.exe$/i.test(full)) return full;
  }
  return null;
}

let cachedPath = null;
let cachedExecutable = null;

/** Bind internal Git calls before spawning; Node 20 searches Windows cwd first. */
export function gitExecutable({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return 'git';
  const pathValue = windowsEnvironmentValue(env, 'PATH');
  if (cachedExecutable && cachedPath === pathValue) return cachedExecutable;
  const full = selectWindowsGitExecutable(pathValue, realWindowsExecutable);
  if (!full) throw unavailable('Git executable is unavailable in absolute PATH directories; configure Git for Windows before running AE');
  cachedPath = pathValue;
  cachedExecutable = full;
  return full;
}

/** Preserve failed-spawn handling without ever falling back to Windows cwd. */
export function spawnGitSync(args, options) {
  let executable;
  try { executable = gitExecutable(); }
  catch (error) {
    if (error?.code !== 'E_GIT_EXECUTABLE') throw error;
    return { error, status: null, signal: null, pid: 0, output: null, stdout: undefined, stderr: undefined };
  }
  return spawnSync(executable, args, options);
}

/** Select the system launcher directly; repository-local powershell.exe is never considered. */
export function windowsSystemPowerShellPath(systemRoot) {
  return windowsAbsolute(systemRoot) ? path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
}

export function windowsPowerShellExecutable(env = process.env) {
  const candidate = windowsSystemPowerShellPath(windowsEnvironmentValue(env, 'SystemRoot'));
  const full = candidate && realWindowsExecutable(candidate);
  if (!full) throw unavailable('System Windows PowerShell is unavailable; native AE hooks require its absolute executable path');
  return full;
}

/** Cleanup must not let Windows resolve a repository-local taskkill.exe. */
export function windowsSystemTaskkillPath(systemRoot) {
  return windowsAbsolute(systemRoot) ? path.win32.join(systemRoot, 'System32', 'taskkill.exe') : null;
}

export function windowsTaskkillExecutable(env = process.env) {
  const candidate = windowsSystemTaskkillPath(windowsEnvironmentValue(env, 'SystemRoot'));
  const full = candidate && realWindowsExecutable(candidate);
  if (!full) throw Object.assign(new Error('System Windows taskkill is unavailable; cleanup requires its absolute executable path'), { code: 'E_SYSTEM_EXECUTABLE', exit: 1 });
  return full;
}
