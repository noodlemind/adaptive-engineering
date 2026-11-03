#!/usr/bin/env node
/** PreToolUse terminal guard: block destructive shell commands. */
import fs from 'node:fs';
import { preToolDenyOutput } from './lib/hook-output.mjs';
import { normalizeToolPayload, unwrapShellSegments } from './lib/tool-payload.mjs';

let policy = { enforcement: 'enforce' };

const BLOCKED = [
  /\brm\s+-rf\s+\//,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b[^;\n|&]*(?:-[a-zA-Z]*[dxX][a-zA-Z]*|\s+-[dxX]\b)/,
  /\bgit\s+config\s+--global\b/,
];

function protectedDestination(refspec) {
  const withoutForce = String(refspec || '').replace(/^\+/, '');
  const separator = withoutForce.lastIndexOf(':');
  const destination = (separator >= 0 ? withoutForce.slice(separator + 1) : withoutForce).replace(/^refs\/heads\//i, '');
  return /^(?:main|master)$/i.test(destination);
}

function gitPushArgs(tokens) {
  const valueOptions = new Set(['-C', '-c', '--exec-path', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
  for (let git = 0; git < tokens.length; git += 1) {
    if (!/(?:^|[\\/])git(?:\.exe)?$/i.test(tokens[git])) continue;
    let index = git + 1;
    while (index < tokens.length) {
      const arg = tokens[index];
      if (valueOptions.has(arg)) index += 2;
      else if (/^--(?:exec-path|git-dir|work-tree|namespace|super-prefix|config-env)=/.test(arg) || arg.startsWith('-')) index += 1;
      else break;
    }
    if (String(tokens[index] || '').toLowerCase() === 'push') return tokens.slice(index + 1);
  }
  return null;
}

function isShortFlag(arg, letter) {
  return /^-[^-]/.test(arg) && arg.includes(letter);
}

function destructiveProtectedPush(command) {
  for (const tokens of unwrapShellSegments(command)) {
    const args = gitPushArgs(tokens);
    if (!args) continue;
    const forced = args.some((arg) => /^--force(?:-with-lease)?(?:=|$)/.test(arg) || isShortFlag(arg, 'f'));
    const deleting = args.some((arg) => arg === '--delete' || isShortFlag(arg, 'd'));
    const mirrored = args.some((arg) => arg === '--mirror');
    const all = args.some((arg) => arg === '--all');
    const positional = [];
    let remoteByOption = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '--repo') {
        remoteByOption = true;
        index += 1;
      } else if (arg.startsWith('--repo=')) remoteByOption = true;
      else if (['-o', '--push-option'].includes(arg)) index += 1;
      else if (!arg.startsWith('-')) positional.push(arg);
    }
    const refspecs = positional.slice(remoteByOption ? 0 : 1);
    if (mirrored || (forced && (all || refspecs.length === 0))) return true;
    if (refspecs.some((refspec) => protectedDestination(refspec)
      && (forced || deleting || refspec.startsWith('+') || refspec.startsWith(':')))) return true;
  }
  return false;
}

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

let payload;
try {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw.trim()) throw new Error('payload is empty');
  payload = JSON.parse(raw);
} catch (error) {
  deny(`invalid-hook-payload: ${error.message}`);
}

const { command, workspace } = normalizeToolPayload(payload);
if (destructiveProtectedPush(command) || BLOCKED.some(pattern => pattern.test(command))) {
  const { loadHookPolicy } = await import('./lib/policy.mjs');
  policy = loadHookPolicy(workspace, { rule: 'destructive' });
  deny('destructive-command: command blocked by Harness policy');
}

output({ continue: true });
