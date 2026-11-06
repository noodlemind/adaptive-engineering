import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { decisionInputStaging } from '../corpus/hooks/lib/decision-staging.mjs';
import { normalizeToolPayload } from '../corpus/hooks/lib/tool-payload.mjs';

const hooks = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../corpus/hooks');
function fixture(t) {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-decision-staging-')));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const payload = (content = { schema: 1, operation: 'status', taskId: 'work' }, target = '.harness/decisions/start.v1.json', tool = 'Write') => ({ workspace, session_id: 'stage-session', tool_name: tool, tool_input: { file_path: `${workspace}/${target}`, content: typeof content === 'string' ? content : JSON.stringify(content) } });
  const allowed = value => decisionInputStaging(value, normalizeToolPayload(value));
  return { workspace, payload, allowed };
}

test('bounded whole decision input stages before plan/critical gates without opening receipt state', t => {
  const f = fixture(t), payload = f.payload();
  assert.equal(f.allowed(payload), true);
  const copilot = { cwd: f.workspace, toolName: 'create', toolArgs: { path: `${f.workspace}/.harness/decisions/copilot.json`, file_text: JSON.stringify({ schema: 1, operation: 'status', taskId: 'work' }) } };
  assert.equal(f.allowed(copilot), true, 'the official Copilot create schema uses file_text');
  for (const script of ['guard-critical-files.mjs', 'require-plan-gate.mjs']) {
    const result = spawnSync(process.execPath, [path.join(hooks, script)], { cwd: f.workspace, env: { ...process.env, HARNESS_NO_EVENTS: '1' }, input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).continue, true, `${script}: ${result.stdout}`);
  }
  assert.equal(fs.existsSync(path.join(f.workspace, '.harness')), false, 'staging predicates must not create authorization state');
});

test('decision staging rejects executable changes, extra authority, malformed JSON, traversal and oversized inputs', t => {
  const f = fixture(t);
  for (const payload of [f.payload({ schema: 1, operation: 'status', approved: true }), f.payload('{'), f.payload({ schema: 1, operation: 'record', requestId: 'x', provenance: 'native' }),
    f.payload({ schema: 1, operation: 'policy' }), f.payload(' '.repeat(65537)), f.payload(undefined, '.harness/session.json'),
    f.payload(undefined, '.harness/decisions/../decisions/start.json'), f.payload(undefined, '.harness/decisions/start.json', 'Edit')]) assert.equal(f.allowed(payload), false);
});

test('decision staging rejects symlink roots and ancestor links and existing hardlinked destinations', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.workspace, '.harness/decisions'), { recursive: true });
  const source = path.join(f.workspace, 'source.json'); fs.writeFileSync(source, '{}');
  fs.linkSync(source, path.join(f.workspace, '.harness/decisions/start.v1.json'));
  assert.equal(f.allowed(f.payload()), false);
  fs.unlinkSync(path.join(f.workspace, '.harness/decisions/start.v1.json'));
  fs.rmdirSync(path.join(f.workspace, '.harness/decisions'));
  fs.symlinkSync(f.workspace, path.join(f.workspace, '.harness/decisions'));
  assert.equal(f.allowed(f.payload()), false);
});
