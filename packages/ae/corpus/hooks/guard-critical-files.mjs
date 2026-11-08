#!/usr/bin/env node
/** PreToolUse mutation guard: block secrets and Harness-owned global files. */
import fs from 'node:fs';
import path from 'node:path';
import { preToolDenyOutput } from './lib/hook-output.mjs';
import { normalizeToolPayload } from './lib/tool-payload.mjs';
import { decisionInputTarget } from './lib/decision-staging.mjs';

let policy = { enforcement: 'enforce' };

const BLOCKED = [
  /(?:^|\/)\.env(?:rc$|\.|$)/i,
  /(?:^|\/)[._]?credentials(?:\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /node_modules\//,
  /(?:^|\/)\.harness(?:\/|$)/,
  /(?:^|\/)\.copilot\//,
];

function output(value) {
  console.log(JSON.stringify(value));
}

function deny(reason) {
  if (policy.enforcement !== 'enforce') {
    output({ continue: true, systemMessage: `[harness hook] ${reason}` });
    process.exit(0);
  }
  output(preToolDenyOutput(reason));
  process.exit(0);
}

/** Resolve symlinks through the nearest existing ancestor so a link inside the
 * workspace cannot smuggle a write into a protected path. */
function resolvedTarget(workspace, target) {
  try {
    let cursor = path.resolve(workspace, target);
    const missing = [];
    while (!fs.existsSync(cursor)) {
      missing.unshift(path.basename(cursor));
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      cursor = parent;
    }
    return path.join(fs.realpathSync(cursor), ...missing);
  } catch {
    return null;
  }
}

let payload;
try {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw.trim()) throw new Error('payload is empty');
  payload = JSON.parse(raw);
} catch (error) {
  deny(`invalid-hook-payload: ${error.message}`);
}

const mutation = normalizeToolPayload(payload);
if (!mutation.mutation) {
  output({ continue: true });
  process.exit(0);
}
for (const target of mutation.targets) {
  if (decisionInputTarget(payload, mutation) && !BLOCKED.some(pattern => pattern.test(`${mutation.workspace.replaceAll('\\', '/')}/`))) continue;
  const candidates = [target, resolvedTarget(mutation.workspace, target)]
    .filter(Boolean)
    .map((value) => value.replace(/\\/g, '/'));
  for (const candidate of candidates) {
    if (BLOCKED.some((pattern) => pattern.test(candidate))) {
      const { loadHookPolicy } = await import('./lib/policy.mjs');
      policy = loadHookPolicy(mutation.workspace, { rule: 'critical' });
      deny(`sensitive-path: ${target}`);
    }
  }
}

output({ continue: true });
