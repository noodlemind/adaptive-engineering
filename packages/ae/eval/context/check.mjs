import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Captured before any workspace module is imported: a checked module can replace methods on the shared
// assert object, but not these bindings.
const { equal, deepEqual, rejects } = assert;
const hasOwn = Object.hasOwn;

export async function checkCases(workspace, checks) {
  for (const check of checks) {
    const module = await import(pathToFileURL(path.join(workspace, check.module)));
    if (check.absent) {
      equal(hasOwn(module, check.export), false);
    } else {
      const evaluate = () => hasOwn(check, 'args') ? module[check.export](...check.args) : module[check.export];
      if (check.throws) await rejects(async () => evaluate(), error => String(error.message).includes(check.throws));
      else {
        const result = evaluate();
        if (check.synchronous) equal(typeof result?.then, 'undefined', `${check.export} must remain synchronous`);
        deepEqual(await result, check.expected);
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [workspace, checkFile] = process.argv.slice(2);
  const challenge = fs.readFileSync(0, 'utf8').trim();
  assert.match(challenge, /^[a-f0-9]{32}$/);
  const task = JSON.parse(fs.readFileSync(checkFile, 'utf8'));
  await checkCases(workspace, task.checks);
  console.log(`harness-context-checked-v1:${challenge}:${task.checks.length}`);
}
