import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windowsTaskkillExecutable } from '../../corpus/hooks/lib/git-executable.mjs';

// Explicit legacy stdio compatibility. No claim of the 2026 per-request protocol.
export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-03-26', '2024-11-05']);
const DEFAULT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TEXT = { type: 'string', minLength: 1, maxLength: 4096 };
const DECISION = { type: 'object' };
const DEFINITIONS = [
  { name: 'ae_orient', command: 'orient', description: 'Read current AE context for the startup-bound workspace. Does not establish skill activation.', properties: { query: TEXT, files: { type: 'array', items: TEXT, maxItems: 64 } }, read: true },
  { name: 'ae_status', command: 'status', description: 'Read AE installation and workspace status.', properties: {}, read: true },
  { name: 'ae_get_reference', command: 'get', description: 'Read a reference from the selected AE corpus. Not a substitute for required native skill activation.', properties: { reference: TEXT }, required: ['reference'], read: true },
  { name: 'ae_gate', command: 'gate', description: 'Ask the existing kernel for an implement gate on an accepted plan.', properties: { plan: TEXT }, required: ['plan'] },
  { name: 'ae_verify', command: 'verify', description: 'Run existing plan verification; repo-authored checks require the existing person-approved trust decision.', properties: { plan: TEXT, base: TEXT }, required: ['plan', 'base'] },
  { name: 'ae_plan_new', command: 'plan-new', description: 'Submit an authored plan creation decision to the existing CLI writer.', properties: { decision: DECISION }, required: ['decision'] },
  { name: 'ae_plan_update', command: 'plan-update', description: 'Submit a revision-bound authored decision to the existing plan writer.', properties: { plan: TEXT, decision: DECISION }, required: ['plan', 'decision'] },
  { name: 'ae_review_prepare', command: 'review', verb: 'prepare', description: 'Capture the accepted plan scope and current required review perspectives.', properties: { plan: TEXT, base: TEXT }, required: ['plan', 'base'] },
  { name: 'ae_review_assemble', command: 'review', verb: 'assemble', description: 'Collect actual packet-bound review results. Reviewer declarations never authenticate an invocation.', properties: { plan: TEXT, packet: TEXT, decision: DECISION }, required: ['plan', 'packet', 'decision'] },
  { name: 'ae_compound', command: 'compound', description: 'Submit a learning decision after current passed verification. Existing proof requirements remain authoritative.', properties: { plan: TEXT, decision: DECISION }, required: ['plan', 'decision'] },
];

export function describeMcpTools() {
  return DEFINITIONS.map(item => ({ name: item.name, description: item.description,
    inputSchema: { type: 'object', properties: item.properties, required: item.required || [], additionalProperties: false },
    annotations: { readOnlyHint: Boolean(item.read), destructiveHint: item.command === 'verify', openWorldHint: item.command === 'verify' },
  }));
}

function invalid(message) { return Object.assign(new Error(message), { rpcCode: -32602 }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validateArguments(definition, args) {
  if (!object(args)) throw invalid('Tool arguments must be an object');
  for (const key of Object.keys(args)) if (!Object.hasOwn(definition.properties, key)) throw invalid(`Unknown tool argument: ${key}`);
  for (const key of definition.required || []) if (!Object.hasOwn(args, key)) throw invalid(`Missing tool argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const type = definition.properties[key].type;
    if (type === 'string' && (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.startsWith('-') || /[\u0000-\u001f\u007f]/.test(value))) throw invalid(`Invalid string argument: ${key}`);
    if (type === 'object' && !object(value)) throw invalid(`Invalid decision object: ${key}`);
    if (type === 'array' && (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 4096 || item.startsWith('-') || /[\u0000-\u001f\u007f]/.test(item)))) throw invalid(`Invalid file list: ${key}`);
  }
}

function invocation(definition, args) {
  const argv = [definition.command];
  if (definition.verb) argv.push(definition.verb);
  if (definition.command === 'orient') {
    argv.push('--read', '--context-version', '2');
    if (args.query) argv.push('--query', args.query);
    for (const file of args.files || []) argv.push('--file', file);
  } else if (definition.command === 'get') argv.push('--reference', args.reference);
  else {
    if (args.plan) argv.push('--plan', args.plan);
    if (args.base) argv.push('--base', args.base);
    if (args.packet) argv.push('--packet', args.packet);
    if (definition.command === 'gate') argv.push('--phase', 'implement');
    if (args.decision) argv.push(definition.command === 'compound' ? '--learning-decision' : '--file', '-');
  }
  return { argv, stdin: args.decision ? JSON.stringify(args.decision) : '' };
}

function stopProcess(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    let executable;
    try { executable = windowsTaskkillExecutable(); }
    catch (error) {
      if (error?.code !== 'E_SYSTEM_EXECUTABLE') throw error;
      child.kill('SIGKILL');
      return;
    }
    const killer = spawn(executable, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false, timeout: 5000, killSignal: 'SIGKILL' });
    killer.on('error', () => child.kill('SIGKILL'));
    killer.on('exit', code => { if (code !== 0) child.kill('SIGKILL'); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

/** A local, workspace-bound stdio transport over the existing CLI authority. */
export function startMcpServer({ workspace = process.cwd(), home, corpusHome, skillsHome, packageRoot = DEFAULT_ROOT,
  input = process.stdin, output = process.stdout, timeoutMs = 300000, maxOutputBytes = 1024 * 1024, maxMessageBytes = 1024 * 1024 } = {}) {
  for (const [name, limit] of Object.entries({ timeoutMs, maxOutputBytes, maxMessageBytes })) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error(`MCP ${name} must be a positive bounded integer`);
  }
  workspace = fs.realpathSync(path.resolve(workspace));
  if (!fs.statSync(workspace).isDirectory()) throw new Error('MCP workspace must be a directory');
  const bin = path.join(path.resolve(packageRoot), 'bin/ae.mjs');
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
  if (!fs.statSync(bin).isFile()) throw new Error('MCP requires the installed AE executable');
  const active = new Map();
  let initialized = false, ready = false, closed = false, buffer = Buffer.alloc(0), discarding = false;
  const send = message => {
    if (!output.destroyed && !output.write(`${JSON.stringify(message)}\n`)) {
      input.pause(); output.once('drain', () => { if (!closed) input.resume(); });
    }
  };
  const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });

  function call(id, definition, args) {
    if (active.size) throw Object.assign(new Error('An AE operation is already running; wait or cancel it'), { rpcCode: -32000 });
    const request = invocation(definition, args);
    request.argv.push('--json', '--no-events', '--workspace', workspace);
    if (home) request.argv.push('--ae-home', path.resolve(home));
    if (corpusHome) request.argv.push('--copilot-home', path.resolve(corpusHome));
    const env = { ...process.env, HARNESS_HOST: 'mcp' };
    if (skillsHome) env.AE_SKILLS_HOME = path.resolve(skillsHome);
    const child = spawn(process.execPath, [bin, ...request.argv], { cwd: workspace, env, shell: false,
      detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const state = { child, cancellation: null };
    active.set(id, state);
    let stdout = '', stderr = '', bytes = 0, spawnError;
    const timer = setTimeout(() => { state.cancellation = 'AE operation timed out'; stopProcess(child); }, timeoutMs);
    for (const [stream, append] of [[child.stdout, value => { stdout += value; }], [child.stderr, value => { stderr += value; }]]) {
      stream.setEncoding('utf8');
      stream.on('data', value => {
        bytes += Buffer.byteLength(value);
        if (bytes > maxOutputBytes) { state.cancellation = 'AE operation output exceeded its limit'; stopProcess(child); }
        else append(value);
      });
    }
    child.on('error', exception => { spawnError = exception.message; });
    child.stdin.on('error', () => {});
    child.stdin.end(request.stdin);
    child.once('close', code => {
      clearTimeout(timer); active.delete(id);
      if (!closed) {
        if (state.cancellation) error(id, state.cancellation === 'Request cancelled' ? -32800 : -32000, state.cancellation);
        else {
          let data, parseFailed = false;
          try { data = JSON.parse(stdout.trim() || stderr.trim()); }
          catch { parseFailed = true; data = { error: spawnError || 'AE did not return a complete JSON result', exitCode: code }; }
          result(id, { content: [{ type: 'text', text: JSON.stringify(data) }], isError: code !== 0 || Boolean(spawnError) || parseFailed || !stdout.trim() });
        }
      }
      finishIfClosed();
    });
  }

  function message(raw) {
    let value;
    try { value = JSON.parse(raw); } catch { error(null, -32700, 'Invalid JSON'); return; }
    const request = object(value) && Object.hasOwn(value, 'id');
    const id = request && (typeof value.id === 'string' || Number.isFinite(value.id)) ? value.id : null;
    if (!object(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string' || request && id === null) { error(null, -32600, 'Invalid JSON-RPC request'); return; }
    if (!request) {
      if (value.method === 'notifications/initialized' && initialized) ready = true;
      if (value.method === 'notifications/cancelled') {
        const state = active.get(value.params?.requestId);
        if (state) { state.cancellation = 'Request cancelled'; stopProcess(state.child); }
      }
      return;
    }
    try {
      if (active.has(id)) throw Object.assign(new Error('Request ID is already active'), { rpcCode: -32600 });
      if (value.method === 'initialize') {
        if (initialized) throw Object.assign(new Error('Already initialized'), { rpcCode: -32600 });
        if (!object(value.params) || typeof value.params.protocolVersion !== 'string' || !object(value.params.capabilities) || !object(value.params.clientInfo)) throw invalid('Invalid initialize parameters');
        initialized = true;
        result(id, { protocolVersion: MCP_PROTOCOL_VERSIONS.includes(value.params.protocolVersion) ? value.params.protocolVersion : MCP_PROTOCOL_VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'ae-harness', version }, instructions: 'AE tools are bound to the startup workspace and existing trust/proof requirements. Native host tools outside AE are not intercepted by MCP.' });
      } else if (value.method === 'ping') result(id, {});
      else if (!ready) throw Object.assign(new Error('Initialize the MCP session first'), { rpcCode: -32002 });
      else if (value.method === 'tools/list') {
        if (value.params?.cursor !== undefined) throw invalid('This fixed tool catalog has no continuation cursor');
        result(id, { tools: describeMcpTools() });
      } else if (value.method === 'tools/call') {
        if (!object(value.params) || Object.keys(value.params).some(key => !['name', 'arguments', '_meta'].includes(key))) throw invalid('Invalid tools/call parameters');
        const definition = DEFINITIONS.find(item => item.name === value.params.name);
        if (!definition) throw invalid('Unknown AE tool');
        const args = value.params.arguments ?? {};
        validateArguments(definition, args); call(id, definition, args);
      } else error(id, -32601, 'Method not found');
    } catch (exception) { error(id, exception.rpcCode || -32603, exception.rpcCode ? exception.message : 'AE MCP request failed'); }
  }

  let resolveClosed;
  const done = new Promise(resolve => { resolveClosed = resolve; });
  function finishIfClosed() { if (closed && active.size === 0) resolveClosed(); }
  function close() {
    if (closed) return;
    closed = true;
    input.pause();
    for (const state of active.values()) stopProcess(state.child);
    finishIfClosed();
  }
  const onData = chunk => {
    if (closed) return;
    let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (data.length) {
      const newline = data.indexOf(10);
      const part = newline === -1 ? data : data.subarray(0, newline);
      if (!discarding) {
        if (buffer.length + part.length > maxMessageBytes) { error(null, -32600, 'MCP message exceeded its limit'); buffer = Buffer.alloc(0); discarding = true; }
        else buffer = Buffer.concat([buffer, part]);
      }
      if (newline === -1) break;
      if (!discarding && buffer.length) message(buffer.toString('utf8'));
      buffer = Buffer.alloc(0); discarding = false; data = data.subarray(newline + 1);
    }
  };
  input.on('data', onData);
  input.once('end', close); input.once('error', close); output.once('error', close);
  process.once('SIGTERM', close); process.once('SIGINT', close);
  input.resume();
  return done.finally(() => {
    input.off('data', onData); input.off('end', close); input.off('error', close); output.off('error', close);
    process.off('SIGTERM', close); process.off('SIGINT', close);
  });
}

export async function cmdMcp(argv, ctx = {}) {
  const options = { workspace: process.cwd(), home: ctx.harnessHome };
  let verb;
  const values = { '--workspace': 'workspace', '--ae-home': 'home', '--harness-home': 'home', '--copilot-home': 'corpusHome', '--skills-home': 'skillsHome' };
  try {
    for (let i = 0; i < argv.length; i++) {
      const token = argv[i];
      if (['--no-color', '--no-events', '--json', '--verbose', '-v'].includes(token)) continue;
      if (!token.startsWith('-') && !verb) { verb = token; continue; }
      const equal = token.indexOf('='), name = equal < 0 ? token : token.slice(0, equal), key = values[name];
      if (!key) throw new Error(`Unknown MCP option: ${name}`);
      const value = equal < 0 ? argv[++i] : token.slice(equal + 1);
      if (!value || value.startsWith('-') || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Missing MCP value: ${name}`);
      if (options[key] !== undefined && key !== 'workspace' && key !== 'home') throw new Error(`Duplicate MCP option: ${name}`);
      options[key] = value;
    }
    if (verb !== 'serve') throw new Error('Usage: ae mcp serve [--workspace <path>] [--ae-home <path>] [--copilot-home <path>] [--skills-home <path>]');
    await startMcpServer(options); return 0;
  } catch (exception) { console.error(exception.message); return 2; }
}
