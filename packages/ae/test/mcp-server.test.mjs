import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { MCP_PROTOCOL_VERSIONS, describeMcpTools } from '../lib/hosts/mcp-server.mjs';
import { writeVersionedPlan } from './helpers/cli-fixtures.mjs';
import { writeSessionState } from '../corpus/hooks/lib/session-state.mjs';
import { inspectHostIntent } from '../lib/host-intent.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = pathToFileURL(path.join(packageRoot, 'lib/hosts/mcp-server.mjs')).href;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-'));
  const cleanups = [];
  // Windows locks a process's cwd. Close every client before deleting fixtures,
  // including when the body or an earlier cleanup assertion has failed.
  t.after(async () => {
    const errors = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'MCP fixture cleanup failed');
  });
  const workspace = path.join(root, 'workspace'), home = path.join(root, 'state');
  fs.mkdirSync(workspace);
  spawnSync('git', ['init', '-q', workspace]);
  fs.writeFileSync(path.join(workspace, 'hello.txt'), 'hello\n');
  spawnSync('git', ['-C', workspace, 'add', 'hello.txt']);
  return { root, workspace, home, registerCleanup: cleanup => cleanups.push(cleanup) };
}

function client(t, options, { observeSpawns, cwd } = {}) {
  const probe = observeSpawns ? `import cp from 'node:child_process'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const nativeSpawn=cp.spawn; cp.spawn=(command,args,options)=>{fs.appendFileSync(${JSON.stringify(observeSpawns)},JSON.stringify({command,args})+'\\n');return nativeSpawn(command,args,options);};syncBuiltinESMExports();` : '';
  const child = spawn(process.execPath, ['--input-type=module', '-e', `${probe}import {startMcpServer} from ${JSON.stringify(moduleUrl)}; await startMcpServer(${JSON.stringify(options)});`], { ...(cwd ? { cwd } : {}), stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let next = 1, buffer = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const message = JSON.parse(line);
      if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    }
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, stderr })));
  const diagnostic = () => {
    let observations;
    try { observations = observeSpawns && fs.readFileSync(observeSpawns, 'utf8'); } catch {}
    return JSON.stringify({ pid: child.pid, cwd: cwd || process.cwd(), workspace: options.workspace,
      exitCode: child.exitCode, signalCode: child.signalCode, stderr: stderr.slice(-4000), observations });
  };
  const waitForExit = async (timeout = 7000) => {
    let timer;
    try {
      return await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`MCP server did not exit within ${timeout}ms: ${diagnostic()}`)), timeout);
      })]);
    } finally { clearTimeout(timer); }
  };
  const cleanup = async () => {
    child.stdin.end();
    try { await waitForExit(); }
    catch (error) {
      child.kill('SIGKILL');
      try { await waitForExit(2000); }
      catch { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
      throw error;
    }
  };
  if (typeof options.registerCleanup === 'function') options.registerCleanup(cleanup);
  else t.after(cleanup);
  const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
  const request = (method, params = {}) => {
    const id = next++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out: ${stderr}`)), 10000);
      pending.set(id, message => { clearTimeout(timer); resolve(message); });
    });
    send({ jsonrpc: '2.0', id, method, params });
    return { id, response };
  };
  const raw = text => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No malformed-message response: ${stderr}`)), 10000);
    pending.set(null, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(text);
  });
  const init = async () => {
    const result = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }).response;
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return result;
  };
  return { child, send, request, raw, init, get exited() { return waitForExit(); } };
}

test('stdio lifecycle negotiates explicit legacy versions and lists bounded typed tools', async t => {
  const f = fixture(t), c = client(t, f);
  assert.equal((await c.request('tools/list').response).error.code, -32002);
  const initialized = await c.init();
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  assert.deepEqual(initialized.result.capabilities, { tools: {} });
  assert.ok(MCP_PROTOCOL_VERSIONS.includes(initialized.result.protocolVersion));
  assert.deepEqual((await c.request('ping').response).result, {});
  const tools = (await c.request('tools/list').response).result.tools;
  assert.deepEqual(tools, describeMcpTools());
  assert.equal(tools.length, 12);
  assert.ok(tools.some(tool => tool.name === 'ae_orient'));
  assert.ok(tools.some(tool => tool.name === 'ae_plan_update'));
  assert.ok(tools.some(tool => tool.name === 'ae_checks_configure'));
  assert.equal(tools.find(tool => tool.name === 'ae_checks_list').annotations.readOnlyHint, true);
  assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));
  assert.ok(!tools.some(tool => /exec|shell|trust|install/.test(tool.name)));
  assert.equal(tools.find(tool => tool.name === 'ae_verify').annotations.readOnlyHint, false);
  assert.equal(tools.find(tool => tool.name === 'ae_verify').annotations.openWorldHint, true, 'trusted named checks may have external effects');
  assert.ok(initialized.result.instructions.includes(fs.realpathSync(f.workspace)), 'the client must see the actual workspace binding');
});

test('plan tools advertise creation formats and action-specific decision shapes', () => {
  const tools = describeMcpTools();
  const creation = tools.find(tool => tool.name === 'ae_plan_new').inputSchema.properties.decision;
  assert.deepEqual(creation.oneOf.map(shape => shape.properties.format.const), ['full', 'short']);
  for (const shape of creation.oneOf) {
    assert.deepEqual(shape.required, ['version', 'format', 'goal', 'acceptance']);
    assert.equal(shape.additionalProperties, false);
  }
  assert.equal(creation.oneOf[1].properties.experiment, undefined);
  const update = tools.find(tool => tool.name === 'ae_plan_update').inputSchema.properties.decision;
  assert.deepEqual(update.oneOf.map(shape => shape.properties.action.const), ['start', 'amend', 'progress', 'finding', 'gap', 'complete', 'convert']);
  const action = name => update.oneOf.find(shape => shape.properties.action.const === name);
  assert.ok(action('amend').properties.changes.properties.scope);
  assert.ok(action('amend').properties.changes.properties.intentSources === undefined);
  assert.ok(action('amend').properties.intentSelection);
  assert.ok(action('progress').properties.progress.properties.tasks);
  assert.equal(action('progress').properties.changes, undefined);
  assert.equal(action('complete').properties.progress, undefined);
  assert.equal(action('complete').properties.observedIntent, undefined);
  assert.deepEqual(action('amend').properties.observedIntent.properties.disposition.enum, ['amend', 'unchanged']);
  assert.equal(action('progress').properties.observedIntent.properties.disposition.const, 'unchanged');
  assert.ok(action('convert').properties.changes.properties.domain_child);
  assert.equal(action('convert').properties.changes.properties.domainChild, undefined);
});

test('invalid plan operation envelopes are refused without spawning a CLI', async t => {
  const f = fixture(t), observed = path.join(f.root, 'spawns.jsonl'), c = client(t, f, { observeSpawns: observed });
  await c.init();
  const base = { version: 1, id: 'update-1', action: 'progress', expect: 'a'.repeat(64) };
  for (const decision of [
    { ...base, changes: { scope: ['hello.txt'] } },
    { ...base, action: 'unknown' },
    { ...base, expect: 'guessed' },
    { ...base, workspace: os.tmpdir() },
  ]) {
    const response = await c.request('tools/call', { name: 'ae_plan_update', arguments: { plan: 'existing-plan.md', decision } }).response;
    assert.equal(response.error?.code, -32602, JSON.stringify(response));
  }
  assert.equal(fs.existsSync(observed), false);
});

test('authored amendment and progress objects reach CLI stdin without shell serialization', async t => {
  const f = fixture(t), fakePackage = path.join(f.root, 'fake');
  fs.mkdirSync(path.join(fakePackage, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(fakePackage, 'package.json'), '{"version":"0.0.0"}');
  fs.writeFileSync(path.join(fakePackage, 'bin/ae.mjs'), 'import fs from "node:fs"; console.log(JSON.stringify({argv:process.argv.slice(2),decision:JSON.parse(fs.readFileSync(0,"utf8"))}));');
  const c = client(t, { ...f, packageRoot: fakePackage }); await c.init();
  for (const input of [
    { action: 'amend', rationale: 'Accept the added context.', changes: { notes: { context: 'Preserve quotes: " and $() and newlines.\nAnother line.' }, scope: ['hello.txt'] } },
    { action: 'progress', progress: { tasks: ['P1T1'], criteria: ['AC1'], phase: 1 } },
    { action: 'convert', rationale: 'Accept the experiment.', authority: { scope: 'experiment-intent', basis: 'Accepted fixture.' }, changes: { experiment: {} } },
  ]) {
    const decision = { version: 1, id: `${input.action}-decision`, expect: 'a'.repeat(64), ...input };
    const response = await c.request('tools/call', { name: 'ae_plan_update', arguments: { plan: 'existing-plan.md', decision } }).response;
    assert.equal(response.result?.isError, false, JSON.stringify(response));
    const value = JSON.parse(response.result.content[0].text);
    assert.deepEqual(value.decision, decision);
    assert.deepEqual(value.argv.slice(0, 5), ['plan-update', '--plan', 'existing-plan.md', '--file', '-']);
    assert.equal(value.argv[value.argv.indexOf('--workspace') + 1], fs.realpathSync(f.workspace));
  }
  assert.deepEqual(fs.readdirSync(f.workspace).sort(), ['.git', 'hello.txt']);
});

test('MCP updates a real plan through amendments, progress and revision-bound replay', async t => {
  const f = fixture(t), plan = writeVersionedPlan(f.workspace, { impacted: ['hello.txt'], taskChecked: false });
  const full = path.join(f.workspace, plan), hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const c = client(t, f); await c.init();
  const call = decision => c.request('tools/call', { name: 'ae_plan_update', arguments: { plan, decision } }).response;
  const before = fs.readFileSync(full);
  const amend = { version: 1, id: 'accepted-context', action: 'amend', expect: hash(before), rationale: 'Accept the clarified behavior.', changes: { notes: { context: 'Preserve the greeting exactly.' } } };
  const amended = await call(amend);
  assert.equal(amended.result?.isError, false, JSON.stringify(amended));
  const amendment = JSON.parse(amended.result.content[0].text);
  assert.equal(amendment.revision, hash(fs.readFileSync(full)));
  assert.match(fs.readFileSync(full, 'utf8'), /Preserve the greeting exactly\./);
  const progress = { version: 1, id: 'record-task', action: 'progress', expect: amendment.revision, progress: { tasks: ['T1'] } };
  const advanced = await call(progress);
  assert.equal(advanced.result?.isError, false, JSON.stringify(advanced));
  assert.match(fs.readFileSync(full, 'utf8'), /- \[x\] Implement the example\./);
  const accepted = fs.readFileSync(full);
  const replayed = await call(progress);
  assert.equal(JSON.parse(replayed.result.content[0].text).replayed, true);
  assert.deepEqual(fs.readFileSync(full), accepted);
  const stale = await call({ ...amend, id: 'stale-context' });
  assert.equal(stale.result?.isError, true, JSON.stringify(stale));
  assert.deepEqual(fs.readFileSync(full), accepted);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'hello.txt'), 'utf8'), 'hello\n');
});

test('host prompt ingress and MCP decisions reconcile intent without replay accepting a later turn', async t => {
  const f = fixture(t), plan = writeVersionedPlan(f.workspace, { impacted: ['hello.txt'], taskChecked: false });
  const sessionId = 'mcp-host-intent-session', full = path.join(f.workspace, plan);
  writeSessionState(f.workspace, { sessionId, activePlan: plan });
  const observe = (timestamp, prompt) => {
    const result = spawnSync(process.execPath, [path.join(packageRoot, 'corpus/hooks/observe-user-intent.mjs')], {
      cwd: f.workspace, input: JSON.stringify({ cwd: f.workspace, sessionId, timestamp, prompt }),
      env: { ...process.env, AE_BIN: path.join(packageRoot, 'bin/ae.mjs'), AE_HOST: 'copilot' }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    return inspectHostIntent({ workspace: f.workspace, sessionId, planPath: plan, revision: createHash('sha256').update(fs.readFileSync(full)).digest('hex') });
  };
  const first = observe(1000, 'Preserve the public greeting API.');
  const c = client(t, f); await c.init();
  const call = (name, args = {}) => c.request('tools/call', { name, arguments: args }).response;
  const data = response => { assert.equal(response.result?.isError, false, JSON.stringify(response)); return JSON.parse(response.result.content[0].text); };
  const initial = data(await call('ae_orient'));
  assert.equal(initial.workflow.observedIntent.id, first.id);
  assert.equal(initial.workflow.observedIntent.state, 'pending');
  assert.equal(initial.workflow.plan.path, plan);
  const amend = { version: 1, id: 'accept-observed-api', action: 'amend', expect: initial.workflow.plan.revision,
    rationale: 'Accept the additional API constraint.', changes: { constraints: ['Preserve the public greeting API.'] },
    observedIntent: { id: first.id, disposition: 'amend', rationale: 'The user added an API constraint to the current plan.' },
  };
  const accepted = data(await call('ae_plan_update', { plan, decision: amend }));
  assert.equal(accepted.workflow.observedIntent.state, 'accepted');
  assert.equal(accepted.workflow.observedIntent.revision, accepted.revision);
  const progressed = data(await call('ae_plan_update', { plan, decision: { version: 1, id: 'record-observed-task', action: 'progress', expect: accepted.revision, progress: { tasks: ['T1'] } } }));
  assert.equal(progressed.workflow.observedIntent.state, 'accepted');
  const second = observe(2000, 'Also preserve whitespace in the output.');
  assert.notEqual(second.id, first.id);
  const replay = data(await call('ae_plan_update', { plan, decision: amend }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.current, false);
  assert.equal(replay.workflow.observedIntent.id, second.id);
  assert.equal(replay.workflow.observedIntent.state, 'pending');
  const beforeCompletion = fs.readFileSync(full);
  const completion = await call('ae_plan_update', { plan, decision: { version: 1, id: 'complete-pending-intent', action: 'complete', expect: replay.workflow.plan.revision } });
  assert.equal(completion.result?.isError, true, JSON.stringify(completion));
  assert.match(JSON.stringify(completion), /reconcile.*observed intent/i);
  assert.deepEqual(fs.readFileSync(full), beforeCompletion);
  assert.equal(inspectHostIntent({ workspace: f.workspace, sessionId }).state, 'pending');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'hello.txt'), 'utf8'), 'hello\n');
});

test('tool calls use the same CLI and cannot replace startup workspace or inject flags', async t => {
  const f = fixture(t), c = client(t, { ...f, corpusHome: path.join(packageRoot, 'corpus'), skillsHome: path.join(packageRoot, 'corpus/skills') });
  await c.init();
  const response = await c.request('tools/call', { name: 'ae_orient', arguments: { query: 'hello', files: ['hello.txt'] } }).response;
  assert.equal(response.result.isError, false, JSON.stringify(response));
  const actual = JSON.parse(response.result.content[0].text);
  const direct = spawnSync(process.execPath, [path.join(packageRoot, 'bin/ae.mjs'), 'orient', '--read', '--context-version', '2', '--query', 'hello', '--file', 'hello.txt', '--json', '--no-events', '--workspace', f.workspace, '--ae-home', f.home, '--copilot-home', path.join(packageRoot, 'corpus')], { encoding: 'utf8', env: { ...process.env, AE_SKILLS_HOME: path.join(packageRoot, 'corpus/skills') } });
  assert.equal(direct.status, 0, direct.stderr);
  const expected = JSON.parse(direct.stdout);
  assert.equal(actual.slice.layout.boundRoot, expected.slice.layout.boundRoot);
  assert.deepEqual(actual.selection, expected.selection);
  for (const [name, args] of [['ae_orient', { workspace: os.tmpdir() }], ['ae_get_reference', { reference: '--enforcement=observe' }], ['arbitrary_exec', { command: 'echo unsafe' }]]) {
    const result = await c.request('tools/call', { name, arguments: args }).response;
    assert.equal(result.error.code, -32602);
  }
  const failure = await c.request('tools/call', { name: 'ae_get_reference', arguments: { reference: 'skills/missing/SKILL.md' } }).response;
  assert.equal(failure.result.isError, true, 'CLI refusal must not become successful tool output');
});

test('malformed messages and newer protocol negotiation remain valid JSON-RPC responses', async t => {
  const f = fixture(t), c = client(t, f);
  const initialized = await c.request('initialize', { protocolVersion: 'future-version', capabilities: {}, clientInfo: { name: 'test', version: '1' } }).response;
  assert.ok(MCP_PROTOCOL_VERSIONS.includes(initialized.result.protocolVersion));
  c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal((await c.request('not/a/method').response).error.code, -32601);
  assert.equal((await c.request('tools/call', { name: 'ae_status', arguments: [] }).response).error.code, -32602);
  assert.equal((await c.raw('not-json\n')).error.code, -32700);
  assert.equal((await c.raw('{"jsonrpc":"2.0","id":null,"method":"ping"}\n')).error.code, -32600);
});

test('oversized messages are discarded through the next newline without poisoning later requests', async t => {
  const f = fixture(t), c = client(t, { ...f, maxMessageBytes: 256 });
  await c.init();
  const refusal = c.raw(`${'x'.repeat(300)}\n`);
  assert.equal((await refusal).error.code, -32600);
  assert.deepEqual((await c.request('ping').response).result, {});
});

test('invalid CLI JSON is an error even when its process exits successfully', async t => {
  const f = fixture(t), fakePackage = path.join(f.root, 'fake');
  fs.mkdirSync(path.join(fakePackage, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(fakePackage, 'package.json'), '{"version":"0.0.0"}');
  fs.writeFileSync(path.join(fakePackage, 'bin/ae.mjs'), 'console.log("partial-not-json");');
  const c = client(t, { ...f, packageRoot: fakePackage });
  await c.init();
  const response = await c.request('tools/call', { name: 'ae_status', arguments: {} }).response;
  assert.equal(response.result.isError, true);
  assert.match(JSON.parse(response.result.content[0].text).error, /complete JSON/);
});

test('cancellation stops a running CLI while ping remains responsive', async t => {
  const f = fixture(t), fakePackage = path.join(f.root, 'fake');
  fs.mkdirSync(path.join(fakePackage, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(fakePackage, 'package.json'), '{"version":"0.0.0"}');
  const pidFile = path.join(f.root, 'child.pid');
  fs.writeFileSync(path.join(fakePackage, 'bin/ae.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(()=>console.log('{}'), 30000);`);
  const c = client(t, { ...f, packageRoot: fakePackage });
  await c.init();
  const call = c.request('tools/call', { name: 'ae_status', arguments: {} });
  for (let tries = 0; !fs.existsSync(pidFile) && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(pidFile));
  const pid = +fs.readFileSync(pidFile, 'utf8');
  c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: call.id, reason: 'test' } });
  assert.equal((await call.response).error.code, -32800);
  assert.deepEqual((await c.request('ping').response).result, {});
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

test('closing the MCP connection reaps a still-running CLI', async t => {
  const f = fixture(t), fakePackage = path.join(f.root, 'fake');
  fs.mkdirSync(path.join(fakePackage, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(fakePackage, 'package.json'), '{"version":"0.0.0"}');
  const pidFile = path.join(f.root, 'child.pid');
  fs.writeFileSync(path.join(fakePackage, 'bin/ae.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(()=>console.log('{}'), 30000);`);
  const c = client(t, { ...f, packageRoot: fakePackage });
  await c.init();
  c.send({ jsonrpc: '2.0', id: 999, method: 'tools/call', params: { name: 'ae_status', arguments: {} } });
  for (let tries = 0; !fs.existsSync(pidFile) && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(pidFile));
  const pid = +fs.readFileSync(pidFile, 'utf8');
  c.child.stdin.end();
  const outcome = await c.exited;
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

test('bounded CLI capture refuses output overflow rather than returning partial success', async t => {
  const f = fixture(t), fakePackage = path.join(f.root, 'fake');
  fs.mkdirSync(path.join(fakePackage, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(fakePackage, 'package.json'), '{"version":"0.0.0"}');
  fs.writeFileSync(path.join(fakePackage, 'bin/ae.mjs'), "console.log('x'.repeat(2000)); setTimeout(()=>{}, 30000);");
  const c = client(t, { ...f, packageRoot: fakePackage, maxOutputBytes: 1024 });
  await c.init();
  const response = await c.request('tools/call', { name: 'ae_status', arguments: {} }).response;
  assert.equal(response.error.code, -32000);
  assert.match(response.error.message, /output exceeded/);
});

test('Windows cleanup with no trusted system launcher makes no executable lookup attempt', () => {
  const script = `
    import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    import {EventEmitter} from 'node:events'; import {PassThrough} from 'node:stream';
    Object.defineProperty(process,'platform',{value:'win32'});
    for(const key of Object.keys(process.env)) if(key.toUpperCase()==='SYSTEMROOT') delete process.env[key];
    process.env.SystemRoot='relative-system'; process.env.PATH=process.cwd();
    const attempted=[]; let cli,kills=0;
    cp.spawn=(command,args,options)=>{
      attempted.push(command);const child=new EventEmitter();child.pid=43123;
      child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.kill=()=>{kills++;setImmediate(()=>child.emit('close',null));return true;};
      if(attempted.length===1)cli=child;else setImmediate(()=>cli.emit('close',null));
      return child;
    };syncBuiltinESMExports();
    const {startMcpServer}=await import(${JSON.stringify(moduleUrl)});
    const input=new PassThrough(),output=new PassThrough();output.resume();
    const done=startMcpServer({workspace:process.cwd(),input,output});
    input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'probe',version:'1'}}})+'\\n');
    input.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\\n');
    input.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'ae_status',arguments:{}}})+'\\n');
    input.end();await done;console.log(JSON.stringify({attempted,kills}));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: packageRoot, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed.attempted, [process.execPath], 'cleanup must not attempt a bare taskkill before falling back');
  assert.equal(observed.kills, 1);
});

test('Windows cleanup bounds its system launcher and kills the owned CLI after a signalled exit', () => {
  const taskkill = 'C:\\Windows\\System32\\taskkill.exe';
  const script = `
    import cp from 'node:child_process'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    import {EventEmitter} from 'node:events'; import {PassThrough} from 'node:stream';
    Object.defineProperty(process,'platform',{value:'win32'});
    for(const key of Object.keys(process.env)) if(key.toUpperCase()==='SYSTEMROOT') delete process.env[key];
    process.env.SystemRoot=${JSON.stringify('C:\\Windows')};
    const taskkill=${JSON.stringify(taskkill)},realpath=fs.realpathSync.native,stat=fs.statSync;
    fs.realpathSync.native=(candidate,...args)=>candidate===taskkill?taskkill:realpath(candidate,...args);
    fs.statSync=(candidate,...args)=>candidate===taskkill?{isFile:()=>true}:stat(candidate,...args);
    const attempted=[];let cli,kills=0,cleanupOptions;
    cp.spawn=(command,args,options)=>{
      attempted.push(command);const child=new EventEmitter();child.pid=43123;
      child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.kill=()=>{kills++;setImmediate(()=>child.emit('close',null));return true;};
      if(attempted.length===1)cli=child;
      else {cleanupOptions=options;setImmediate(()=>child.emit('exit',null,'SIGKILL'));}
      return child;
    };syncBuiltinESMExports();
    const {startMcpServer}=await import(${JSON.stringify(moduleUrl)});
    const input=new PassThrough(),output=new PassThrough();output.resume();
    const done=startMcpServer({workspace:process.cwd(),input,output});
    input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'probe',version:'1'}}})+'\\n');
    input.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\\n');
    input.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'ae_status',arguments:{}}})+'\\n');
    input.end();await done;console.log(JSON.stringify({attempted,kills,cleanupOptions}));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: packageRoot, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed.attempted, [process.execPath, taskkill]);
  assert.equal(observed.cleanupOptions.timeout, 5000);
  assert.equal(observed.cleanupOptions.killSignal, 'SIGKILL');
  assert.equal(observed.kills, 1, 'a null exit code from the signalled launcher must trigger owned-child cleanup');
});

test('Windows EOF cleanup launches the verified system taskkill instead of the repository shadow', { skip: process.platform !== 'win32' }, async t => {
  const { windowsTaskkillExecutable } = await import('../corpus/hooks/lib/git-executable.mjs');
  const f = fixture(t), fakePackage = path.join(f.root, 'fake');
  fs.mkdirSync(path.join(fakePackage, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(fakePackage, 'package.json'), '{"version":"0.0.0"}');
  const pidFile = path.join(f.root, 'child.pid'), observations = path.join(f.root, 'spawns.jsonl');
  fs.writeFileSync(path.join(fakePackage, 'bin/ae.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>console.log('{}'),30000);`);
  fs.writeFileSync(path.join(f.workspace, 'taskkill.exe'), 'repository-controlled executable shadow');
  const c = client(t, { ...f, packageRoot: fakePackage }, { observeSpawns: observations, cwd: f.workspace });
  await c.init();
  c.send({ jsonrpc: '2.0', id: 999, method: 'tools/call', params: { name: 'ae_status', arguments: {} } });
  for (let tries = 0; !fs.existsSync(pidFile) && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(pidFile));
  const pid = +fs.readFileSync(pidFile, 'utf8');
  c.child.stdin.end();
  const outcome = await c.exited;
  assert.equal(outcome.code, 0, outcome.stderr);
  const spawns = fs.readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(spawns.map(item => item.command), [process.execPath, windowsTaskkillExecutable()]);
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});
