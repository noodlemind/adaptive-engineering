import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { startMcpServer, describeMcpTools } from '../lib/hosts/mcp-server.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function session(t, existing) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-check-recovery-')));
  const workspace = path.join(root, 'product'), home = path.join(root, 'state'), corpusHome = path.join(root, 'corpus');
  fs.mkdirSync(workspace); fs.mkdirSync(home); fs.mkdirSync(corpusHome);
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'app.mjs'), 'export const answer = 42;\n');
  const marker = path.join(workspace, 'check-executed');
  fs.writeFileSync(path.join(workspace, 'test/behavior.mjs'), `import assert from 'node:assert/strict'; import fs from 'node:fs'; import {answer} from '../app.mjs'; assert.equal(answer,42); fs.writeFileSync(${JSON.stringify(marker)},'executed');\n`);
  const shared = path.join(workspace, '.github/harness/checks.yaml');
  if (existing !== null) { fs.mkdirSync(path.dirname(shared), { recursive: true }); fs.writeFileSync(shared, existing); }
  const input = new PassThrough(), output = new PassThrough(), pending = new Map(); let next = 1, buffer = '';
  output.setEncoding('utf8'); output.on('data', chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message); pending.delete(message.id);
    }
  });
  const done = startMcpServer({ workspace, home, corpusHome, packageRoot, input, output, timeoutMs: 10000 });
  t.after(async () => { input.end(); await done; fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const send = message => input.write(JSON.stringify(message) + '\n');
  const request = (method, params = {}) => {
    const id = next++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP check recovery timed out: ${method}`)); }, 15000);
      pending.set(id, message => { clearTimeout(timer); resolve(message); });
    });
    send({ jsonrpc: '2.0', id, method, params }); return response;
  };
  const init = async () => {
    const result = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'check-recovery', version: '1' } });
    assert.ok(result.result); send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  };
  const call = (name, args = {}) => request('tools/call', { name, arguments: args });
  const data = response => { assert.equal(response.result?.isError, false, JSON.stringify(response)); return JSON.parse(response.result.content[0].text); };
  return { root, workspace, home, shared, marker, call, init, data };
}

test('MCP publishes twelve fixed tools with bounded check inspection and preparation', () => {
  const tools = describeMcpTools();
  assert.equal(tools.length, 12);
  const list = tools.find(tool => tool.name === 'ae_checks_list'), configure = tools.find(tool => tool.name === 'ae_checks_configure');
  assert.equal(list.annotations.readOnlyHint, true);
  assert.deepEqual(list.inputSchema.properties, {});
  assert.equal(configure.annotations.readOnlyHint, false);
  assert.deepEqual(configure.inputSchema.required, ['decision']);
  assert.deepEqual(configure.inputSchema.properties, { decision: { type: 'object' } });
  for (const tool of [list, configure]) assert.equal(tool.inputSchema.additionalProperties, false);
});

for (const existing of [null, '# existing upgraded policy\nversion: 1\nchecks: {}\n']) test(`MCP prepares ${existing === null ? 'missing private' : 'empty shared'} checks without execution or approval`, async t => {
  const f = session(t, existing); await f.init();
  const listed = f.data(await f.call('ae_checks_list'));
  assert.deepEqual(listed.checks, []); assert.equal(listed.sourceDigest, existing === null ? null : digest(existing));
  const command = [process.execPath, 'test/behavior.mjs'];
  const prepared = f.data(await f.call('ae_checks_configure', { decision: { schema: 1, expectedDigest: listed.sourceDigest, checks: { behavior: { command, proof: 'behavior' } }, rationale: 'Register the existing answer assertion before delivery.' } }));
  assert.equal(prepared.changed, true); assert.equal(prepared.approvalRequired, true); assert.equal(prepared.trust.trusted, false);
  assert.deepEqual(prepared.changes[0].current.command, command);
  assert.equal(fs.existsSync(f.marker), false); assert.equal(fs.existsSync(path.join(f.home, 'trust.yaml')), false);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'app.mjs'), 'utf8'), 'export const answer = 42;\n');
  assert.deepEqual(fs.readdirSync(f.workspace).sort(), existing === null ? ['app.mjs', 'test'] : ['.github', 'app.mjs', 'test']);
  const after = f.data(await f.call('ae_checks_list'));
  assert.equal(after.sourceDigest, prepared.sourceDigest); assert.equal(after.checks.length, 1); assert.deepEqual(after.checks[0].command, command);
  assert.equal(prepared.sourceMode, existing === null ? 'local' : 'shared');
  if (existing !== null) assert.match(fs.readFileSync(f.shared, 'utf8'), /# existing upgraded policy/);
});

test('MCP denies root/argv/trust injection and preserves sources on invalid decisions', async t => {
  const bytes = 'version: 1\nchecks: {}\n', f = session(t, bytes); await f.init();
  for (const [name, args] of [
    ['ae_checks_list', { workspace: os.tmpdir() }], ['ae_checks_list', { home: os.tmpdir() }],
    ['ae_checks_configure', { decision: {}, workspace: os.tmpdir() }], ['ae_checks_configure', { decision: {}, trust: true }],
    ['ae_checks_configure', { decision: {}, argv: ['trust', 'approve'] }], ['ae_checks_configure', {}],
    ['ae_checks_configure', { decision: [] }], ['ae_trust_approve', {}],
  ]) assert.equal((await f.call(name, args)).error?.code, -32602, JSON.stringify([name, args]));
  for (const decision of [
    { schema: 1, expectedDigest: digest(bytes), checks: { behavior: { command: [process.execPath, 'test/behavior.mjs'] } }, rationale: 'Prepare tests', workspace: f.root },
    { schema: 1, expectedDigest: null, checks: { behavior: { command: [process.execPath, 'test/behavior.mjs'] } }, rationale: 'Stale token' },
    { schema: 1, expectedDigest: digest(bytes), checks: { behavior: { command: [process.execPath, 'test/behavior.mjs'], shell: true } }, rationale: 'Invalid field' },
  ]) {
    const response = await f.call('ae_checks_configure', { decision });
    assert.equal(response.result?.isError, true, JSON.stringify(response)); assert.equal(fs.readFileSync(f.shared, 'utf8'), bytes);
  }
  assert.equal(fs.existsSync(f.marker), false); assert.equal(fs.existsSync(path.join(f.home, 'trust.yaml')), false);
});
