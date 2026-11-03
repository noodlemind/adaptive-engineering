import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runNamedCheck } from '../lib/checks.mjs';

test('a Node test check executes its assertions when invoked from another Node test runner', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-check-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'ae'), copilotHome = path.join(root, 'copilot');
  fs.mkdirSync(workspace);
  const marker = path.join(workspace, 'assertions-ran');
  const suite = path.join(workspace, 'behavior.test.mjs');
  fs.writeFileSync(suite, `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\ntest('real behavior', () => { fs.writeFileSync(${JSON.stringify(marker)}, 'ran'); assert.equal(1, 2); });\n`);
  const result = await runNamedCheck(workspace, 'behavior', { command: [process.execPath, '--test', suite] }, { home, copilotHome });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran', 'nested test execution must not be silently skipped');
  assert.equal(result.status, 'failed');
  assert.notEqual(result.exitCode, 0);
});
