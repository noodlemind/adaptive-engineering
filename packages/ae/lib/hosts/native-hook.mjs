import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBoundedInput } from '../fs-safe.mjs';
import { windowsPowerShellExecutable } from '../../corpus/hooks/lib/git-executable.mjs';
import { FILE_MUTATION_TOOLS, READ_ONLY_TOOLS, TERMINAL_TOOLS } from '../../corpus/hooks/lib/tool-payload.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOSTS = new Set(['claude-code', 'codex', 'cursor']);
const EVENTS = new Set(['start', 'pre', 'post', 'stop', 'compact']);
const scripts = {
  start: ['load-context.mjs'],
  pre: ['guard-critical-files.mjs', 'block-destructive-commands.mjs', 'require-plan-gate.mjs'],
  post: ['record-successful-edit.mjs'],
  stop: ['require-verification.mjs'],
  compact: ['preserve-context.mjs'],
};

function assertHost(host) {
  if (!HOSTS.has(host)) throw new Error(`Unsupported native host: ${host}`);
}

export function nativeHookCommand(args, { platform = process.platform, powerShellExecutable } = {}) {
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  if (platform !== 'win32') return args.map(quote).join(' ');
  // Explicit PowerShell avoids cmd/PowerShell ambiguity in native command fields.
  const executable = powerShellExecutable || windowsPowerShellExecutable();
  if (!path.win32.isAbsolute(executable) || path.win32.parse(executable).root === '\\' || /["%!?<>|\u0000-\u001f\u007f]/.test(executable) || !/\.exe$/i.test(executable)) throw new Error('Native hooks require an absolute system PowerShell executable');
  const launcher = /[\s&()^]/.test(executable) ? `"${executable}"` : executable;
  const ps = '& ' + args.map(value => `'${String(value).replaceAll("'", "''")}'`).join(' ');
  return `${launcher} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`;
}

/** Native configuration only; the installer owns merging and hook ownership. */
export function nativeHookConfig({ host, configHome, skillsHome, home, packageRoot: root = packageRoot }) {
  assertHost(host);
  for (const value of [configHome, skillsHome, home, root]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Native hook roots must be absolute paths');
  }
  const invoke = event => nativeHookCommand([process.execPath, path.join(root, 'lib/hosts/native-hook.mjs'), '--host', host, '--event', event,
    '--config-home', configHome, '--skills-home', skillsHome, '--ae-home', home]);
  if (host === 'cursor') {
    const hooks = {};
    for (const [name, event] of Object.entries({ sessionStart: 'start', preToolUse: 'pre', postToolUse: 'post', postToolUseFailure: 'post', stop: 'stop', preCompact: 'compact' })) {
      hooks[name] = [{ command: invoke(event), ...(event === 'pre' ? { matcher: '*', failClosed: true } : {}), ...(event === 'stop' ? { loop_limit: 5 } : {}) }];
    }
    return { path: 'hooks.json', value: { version: 1, hooks } };
  }
  const hooks = {};
  const mapping = { SessionStart: 'start', PreToolUse: 'pre', PostToolUse: 'post', Stop: 'stop', PreCompact: 'compact' };
  if (host === 'claude-code') mapping.PostToolUseFailure = 'post';
  for (const [name, event] of Object.entries(mapping)) {
    hooks[name] = [{ ...(['pre', 'post'].includes(event) ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: invoke(event), timeout: event === 'stop' ? 90 : 60 }] }];
  }
  return { path: host === 'claude-code' ? 'settings.json' : 'hooks.json', value: { hooks } };
}

function options(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--host', '--event', '--config-home', '--skills-home', '--ae-home'].includes(key) || !argv[i + 1] || Object.hasOwn(out, key)) throw new Error('Invalid native hook arguments');
    out[key] = argv[i + 1];
  }
  assertHost(out['--host']);
  if (!EVENTS.has(out['--event'])) throw new Error('Unsupported native hook event');
  for (const key of ['--config-home', '--skills-home', '--ae-home']) if (!path.isAbsolute(out[key] || '')) throw new Error('Native hook roots must be absolute paths');
  return { host: out['--host'], event: out['--event'], configHome: out['--config-home'], skillsHome: out['--skills-home'], home: out['--ae-home'] };
}

function normalize(raw, host, event) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Native hook payload must be an object');
  const cwd = raw.cwd || (host === 'cursor' && raw.workspace_roots?.length === 1 ? raw.workspace_roots[0] : null);
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('Native hook payload requires an absolute workspace cwd');
  const workspace = fs.realpathSync.native(cwd);
  if (raw.workspace && fs.realpathSync.native(raw.workspace) !== workspace) throw new Error('Native hook payload has conflicting workspace identities');
  const result = { ...raw, workspace, cwd: workspace, session_id: raw.session_id || raw.conversation_id || null };
  if (!['pre', 'post'].includes(event)) return result;
  if (typeof raw.tool_name !== 'string' || !raw.tool_name || !raw.tool_input || typeof raw.tool_input !== 'object' || Array.isArray(raw.tool_input)) throw new Error('Native tool event requires tool_name and object tool_input');
  for (const field of ['working_directory', 'workdir', 'cwd']) {
    if (!Object.hasOwn(raw.tool_input, field)) continue;
    const selected = raw.tool_input[field];
    if (typeof selected !== 'string' || !selected.trim()) throw new Error('Native tool execution directory is invalid');
    const resolved = fs.realpathSync.native(path.resolve(workspace, selected));
    if (!fs.statSync(resolved).isDirectory()) throw new Error('Native tool execution directory is invalid');
    if (resolved !== workspace) throw new Error('Native tool execution directory conflicts with native workspace');
  }
  const aliases = { Shell: 'Bash', Glob: 'file_search', Grep: 'grep_search', LS: 'list_dir', LSP: 'codebase', WebFetch: 'fetch_webpage', WebSearch: 'search', Agent: 'think', Task: 'think' };
  // These native dispatch controls do not execute product edits; child tool use
  // still passes through the separately configured native mutation hooks.
  if (host === 'codex') for (const name of ['spawn_agent', 'wait_agent', 'send_input', 'close_agent', 'resume_agent']) aliases[name] = 'think';
  result.tool_name = aliases[raw.tool_name] || raw.tool_name;
  result.tool_input = { ...raw.tool_input };
  if (TERMINAL_TOOLS.has(result.tool_name) && (typeof result.tool_input.command !== 'string' || !result.tool_input.command.trim())) throw new Error('Native shell event requires a command');
  if (raw.tool_name === 'apply_patch' && typeof raw.tool_input.command === 'string') {
    result.tool_input.patch = raw.tool_input.command;
    delete result.tool_input.command;
  }
  if (event === 'pre' && !FILE_MUTATION_TOOLS.has(result.tool_name) && !READ_ONLY_TOOLS.has(result.tool_name) && !TERMINAL_TOOLS.has(result.tool_name)) {
    throw new Error(`Unclassified native tool effect: ${raw.tool_name}; use a governed AE operation`);
  }
  if (host === 'cursor' && Object.hasOwn(raw, 'tool_output')) {
    result.tool_response = typeof raw.tool_output === 'string' ? JSON.parse(raw.tool_output) : raw.tool_output;
  }
  // Preserve returned bytes; never invent success, a complete range or truncation=false.
  if (typeof result.tool_response === 'string') result.tool_response = { content: result.tool_response };
  const response = result.tool_response;
  if (response?.file && typeof response.file.content === 'string') result.tool_response = { ...response, content: response.file.content };
  if (response && [response.exit_code, response.exitCode].some(value => Number.isInteger(value) && value !== 0)) result.success = false;
  if (raw.failure_type || raw.error_message) result.success = false;
  return result;
}

function translated(value, roots) {
  if (typeof value === 'string') return value.replaceAll('<copilot-home>/skills', roots.skillsHome).replaceAll('<copilot-home>', roots.configHome).replaceAll('@engineer', 'Engineer');
  if (Array.isArray(value)) return value.map(item => translated(item, roots));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, translated(item, roots)]));
  return value;
}

function nativeOutput(host, event, result) {
  const reason = result.permissionDecisionReason || result.hookSpecificOutput?.permissionDecisionReason || result.reason || result.systemMessage;
  const denied = result.permissionDecision === 'deny' || result.hookSpecificOutput?.permissionDecision === 'deny' || result.decision === 'block';
  const context = result.additionalContext || result.hookSpecificOutput?.additionalContext || result.systemMessage;
  if (host === 'cursor') {
    if (event === 'pre') return denied ? { permission: 'deny', user_message: reason, agent_message: reason } : {};
    if (event === 'stop') return denied ? { followup_message: reason } : {};
    return context ? { additional_context: context } : {};
  }
  if (denied && event === 'pre') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  if (denied && event === 'stop') return { decision: 'block', reason };
  const names = { start: 'SessionStart', post: 'PostToolUse' };
  return context ? (names[event] ? { hookSpecificOutput: { hookEventName: names[event], additionalContext: context } } : { additionalContext: context }) : {};
}

function execute(roots, payload) {
  const bin = path.join(packageRoot, 'bin/ae.mjs');
  const env = { ...process.env, COPILOT_HOME: roots.configHome, AE_SKILLS_HOME: roots.skillsHome, HARNESS_SKILLS_HOME: roots.skillsHome, AE_HOME: roots.home, HARNESS_HOME: roots.home, AE_BIN: bin, HARNESS_BIN: bin, AE_HOST: roots.host, HARNESS_HOST: roots.host };
  const messages = [];
  const deadline = Date.now() + (roots.event === 'stop' ? 85000 : 45000);
  for (const script of scripts[roots.event]) {
    const child = spawnSync(process.execPath, [path.join(packageRoot, 'corpus/hooks', script)], { cwd: payload.workspace, env, input: JSON.stringify(payload), encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()), maxBuffer: 2 * 1024 * 1024 });
    if (child.error || child.status !== 0) throw new Error(`Native hook ${script} failed${child.error?.code ? `: ${child.error.code}` : ''}`);
    const line = child.stdout.trim().split('\n').filter(Boolean).at(-1);
    const result = line ? JSON.parse(line) : {};
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`Native hook ${script} returned invalid output`);
    if (result.permissionDecision === 'deny' || result.hookSpecificOutput?.permissionDecision === 'deny' || result.decision === 'block') return result;
    if (result.systemMessage) messages.push(result.systemMessage);
    if (result.additionalContext || result.hookSpecificOutput?.additionalContext) return result;
  }
  return messages.length ? { systemMessage: messages.join('\n') } : {};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let roots;
  try {
    roots = options(process.argv.slice(2));
    const input = readBoundedInput(0, { maxBytes: 2 * 1024 * 1024 });
    if (!input?.trim()) throw new Error('Native hook payload is empty or oversized');
    const payload = normalize(JSON.parse(input), roots.host, roots.event);
    const interrupted = roots.host === 'cursor' && roots.event === 'stop' && ['aborted', 'error'].includes(payload.status);
    console.log(JSON.stringify(interrupted ? {} : nativeOutput(roots.host, roots.event, translated(execute(roots, payload), roots))));
  } catch (error) {
    const reason = `AE native hook refused: ${error.message}`;
    if (roots) console.log(JSON.stringify(nativeOutput(roots.host, roots.event, { permissionDecision: 'deny', decision: 'block', reason, permissionDecisionReason: reason, systemMessage: reason })));
    else { console.error(reason); process.exitCode = 2; }
  }
}
