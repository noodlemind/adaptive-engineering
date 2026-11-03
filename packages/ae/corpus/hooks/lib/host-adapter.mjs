import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRuntimeEnvironment } from './runtime-identity.mjs';
import { preToolDenyOutput, stopBlockOutput } from './hook-output.mjs';
import { unwrapOrientSlice } from './orient-slice.mjs';
import { nodeAuthority } from './authority-bin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function emptySlice() {
  return {
    neighborhood: null,
    graph: null,
    intentSources: [],
    intentDiscovery: null,
    intentDetail: null,
    verification: { state: 'unknown', path: null, warnings: [] },
    planGoal: null,
    trust: null,
    checkReadiness: null,
    reviewCoverage: null,
    learnings: [],
    skills: [],
    procedure: { id: null, reason: null },
    instructions: [],
    contacts: [],
    index: { knowledge: 'missing', structural: 'missing' },
    gateStatus: 'blocked',
    activePlan: null,
    layout: {
      boundRoot: null,
      projectStore: null,
      kind: 'unknown',
      markers: [],
      workspaceType: 'none',
      workspaceFile: null,
      roots: [],
      domainSuggestion: null,
    },
  };
}

function harnessCommand() {
  const node = nodeAuthority();
  if (!node) return null;
  return { command: node.command, prefix: node.args };
}

function takeFlag(argv, name) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === name && i + 1 < argv.length) values.push(argv[++i]);
    else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
  }
  return values;
}

function sliceFrom(parsed) {
  return unwrapOrientSlice(parsed, emptySlice());
}

function orientSlice(workspace, { query = '', files = [], readOnly = true } = {}) {
  const harness = harnessCommand();
  if (!harness) return emptySlice();
  const { command, prefix } = harness;
  const args = [...prefix, 'orient', ...(readOnly ? ['--read', '--context-version', '2'] : []), '--json', '--no-events', '--workspace', workspace];
  if (query) args.push('--query', query);
  for (const file of files) args.push('--file', file);
  if (process.env.COPILOT_HOME) args.push('--copilot-home', process.env.COPILOT_HOME);
  if (process.env.HARNESS_HOME) args.push('--harness-home', process.env.HARNESS_HOME);
  const res = spawnSync(command, args, {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 8000,
    env: process.env,
  });
  if (!res || res.error || res.status !== 0 || !res.stdout) return emptySlice();
  try {
    return sliceFrom(JSON.parse(res.stdout));
  } catch {
    return emptySlice();
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseLastJson(text) {
  const line = String(text || '').trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function runHostAdapter() {
  const event = process.argv[2];
  try { normalizeRuntimeEnvironment(); }
  catch (error) {
    const reason = `Invalid runtime configuration: ${error.message}`;
    process.stdout.write(JSON.stringify(event === 'stop' ? stopBlockOutput(reason) : preToolDenyOutput(reason)) + '\n');
    process.exit(2);
  }
  const workspace = process.cwd();
  const query = takeFlag(process.argv.slice(3), '--query')[0] || '';
  const files = takeFlag(process.argv.slice(3), '--file');
  const ranked = Boolean(query || files.length);
  const slice = orientSlice(workspace, {
    query: event === 'start' ? '' : query,
    files: event === 'start' ? [] : files,
    readOnly: event === 'start' || event === 'edit' || !ranked,
  });
  if (event === 'start') {
    process.stdout.write(`${JSON.stringify(slice)}\n`);
    process.exit(0);
  }
  if (event === 'edit') {
    const gate = spawnSync(process.execPath, [path.join(here, '..', 'require-plan-gate.mjs')], {
      cwd: workspace,
      input: readStdin(),
      encoding: 'utf8',
      timeout: 40000,
      env: process.env,
    });
    const decision = parseLastJson(gate.stdout) || {};
    process.stdout.write(`${JSON.stringify({ ...slice, ...decision })}\n`);
    process.exit(gate.status ?? 1);
  }
  if (event === 'stop') {
    const harness = harnessCommand();
    if (!harness) {
      process.stdout.write(`${JSON.stringify({ ...slice, outcome: null })}\n`);
      process.exit(1);
    }
    const { command, prefix } = harness;
    const args = [...prefix, 'verify', '--json', '--no-events', '--workspace', workspace];
    if (process.env.COPILOT_HOME) args.push('--copilot-home', process.env.COPILOT_HOME);
    if (process.env.HARNESS_HOME) args.push('--harness-home', process.env.HARNESS_HOME);
    const verified = spawnSync(command, args, {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 80000,
      env: process.env,
    });
    const body = parseLastJson(verified.stdout) || {};
    process.stdout.write(`${JSON.stringify({ ...slice, outcome: body.outcome ?? null })}\n`);
    process.exit(verified.status ?? 1);
  }
  process.stderr.write('host adapter event must be start, edit, or stop\n');
  process.exit(2);
}
