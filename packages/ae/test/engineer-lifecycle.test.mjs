import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(packageRoot, 'corpus', 'agents', 'engineer.agent.md');

test('the engineer agent drops the numbered delivery checklist', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.doesNotMatch(source, /^[0-9]+\. /m);
  assert.doesNotMatch(source, /--query` and `--file/);
  assert.match(source, /Own delivery/);
  assert.match(source, /## Select the task mode/);
  assert.match(source, /## Gaps and consultation/);
  assert.match(source, /Consult for bounded expertise, review, isolation, or authority/);
  assert.match(source, /\*\*Answer\*\*/);
  assert.match(source, /\*\*Investigate\*\*/);
  assert.match(source, /\*\*Deliver\*\*/);
  assert.match(source, /\*\*Review\*\*/);
  assert.match(source, /create-primitive\/SKILL\.md/);
  assert.match(source, /A person approves a new skill or specialist before installation/);
  assert.match(source, /Before edits, call `ae orient --read --context-version 2` with task text and target files/);
  assert.match(source, /Check readiness apart from trust; recover through ensure-plan/);
  assert.equal(fs.existsSync(path.join(packageRoot, 'assets', 'agents', 'engineer.agent.md')), false);
});
