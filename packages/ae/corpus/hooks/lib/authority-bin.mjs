import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeRuntimeEnvironment, runtimeSetting, runtimeCopilotHome } from './runtime-identity.mjs';

export function authorityBin({ includeOverride = true } = {}) {
  process.env.COPILOT_HOME ||= runtimeCopilotHome();
  normalizeRuntimeEnvironment();
  if (includeOverride && runtimeSetting('BIN')) return runtimeSetting('BIN');
  const candidates = ['../../.ae-bin/bin/ae.mjs', '../../../bin/ae.mjs', '../../.harness-bin/bin/harness.mjs'];
  return candidates.map(rel => fileURLToPath(new URL(rel, import.meta.url))).find(full => {
    try { return fs.statSync(full).isFile(); } catch { return false; }
  }) || null;
}

/** Run the installed CLI with Node. Never invokes an `ae` shell shim. */
export function nodeAuthority() {
  const bin = authorityBin();
  if (!bin) return null;
  return { command: process.execPath, args: [bin] };
}
