import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { types } from 'node:util';

const self = fileURLToPath(import.meta.url);

/** In-process checks. Used for public verifiers only, where the checked code may see the expectations. */
export async function checkCases(workspace, checks) {
  for (const check of checks) {
    const module = await import(pathToFileURL(path.join(workspace, check.module)));
    if (check.absent) {
      assert.equal(Object.hasOwn(module, check.export), false);
    } else {
      const evaluate = () => Object.hasOwn(check, 'args') ? module[check.export](...check.args) : module[check.export];
      if (check.throws) await assert.rejects(async () => evaluate(), error => String(error.message).includes(check.throws));
      else {
        const result = evaluate();
        if (check.synchronous) assert.equal(types.isPromise(result) || typeof result?.then !== 'undefined', false, `${check.export} must remain synchronous`);
        assert.deepEqual(await result, check.expected);
      }
    }
  }
}

/** Standalone public verifier for a workspace: the public checks and `checkCases`, with no path back to the AE checkout. */
export function publicVerifierSource(checks) {
  return `import assert from 'node:assert/strict';\nimport path from 'node:path';\nimport { pathToFileURL } from 'node:url';\nimport { types } from 'node:util';\n${checkCases.toString()}\nawait checkCases(process.cwd(), ${JSON.stringify(checks)});\n`;
}

/** What the probe child may know about a check: never the expected value or the expected error text. */
export const probeOf = check => ({ module: check.module, export: check.export, ...(Object.hasOwn(check, 'args') ? { args: check.args } : {}), ...(check.absent ? { absent: true } : {}) });

/**
 * Child side. Threat model: this defends against casual or accidental fitting, such as reading files or argv, or simple
 * monkey-patching of common globals. Checked code runs in the same JS realm as this reporter, so a deliberately adversarial
 * module can always forge a report (prototype patches, /proc/self/mem). Real defence needs a separate process boundary with
 * no shared realm, plus a sandbox.
 * Within that model: the functions a report depends on are captured before the first workspace import; each report is an
 * ASCII string written with the captured fs.writeSync to fd 3, with no Buffer in the path; result objects have a null prototype
 * and hold only primitives, so a planted Object.prototype.toJSON is never consulted. One nonce-tagged line per finished check
 * means a hang or exit loses only the checks not yet reported.
 */
async function probeMain(workspace) {
  const writeSync = fs.writeSync, stringify = JSON.stringify, apply = Reflect.apply, encodeText = encodeURIComponent;
  const base64Slice = Buffer.prototype.base64Slice, stringSlice = String.prototype.slice, toText = String, encode = serialize;
  const wellFormed = String.prototype.toWellFormed;
  const isPromise = types.isPromise;
  const getPrototype = Reflect.getPrototypeOf, ownKeys = Reflect.ownKeys, isArray = Array.isArray, hasOwn = Object.hasOwn;
  const objectPrototype = Object.prototype, arrayPrototype = Array.prototype;
  const { nonce, probes } = JSON.parse(fs.readFileSync(0, 'utf8'));
  // Every field is ASCII (base64 values, URI-encoded error text), so bytes written equal characters written on a short write.
  const report = (index, result) => {
    const text = `\n${nonce}:${index}:${stringify(result)}\n`;
    for (let offset = 0; offset < text.length;) {
      try { offset += writeSync(3, offset ? apply(stringSlice, text, [offset]) : text); } catch (error) { if (error?.code !== 'EAGAIN') throw error; }
    }
  };
  // The v8 round trip keeps values but drops prototypes; this flag keeps the private judge as strict as deepStrictEqual on JSON data.
  const plain = (value, depth) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return true;
    if (typeof value === 'function' || depth > 64) return false;
    if (getPrototype(value) !== (isArray(value) ? arrayPrototype : objectPrototype)) return false;
    const keys = ownKeys(value);
    for (let index = 0; index < keys.length; index++) {
      if (typeof keys[index] === 'symbol' || !plain(value[keys[index]], depth + 1)) return false;
    }
    return true;
  };
  // toWellFormed after the slice repairs a lone surrogate or an emoji cut at the limit, which encodeURIComponent would reject.
  const message = error => { try { return encodeText(apply(wellFormed, apply(stringSlice, toText(error?.message ?? error), [0, 2000]), [])); } catch { return 'unprintable%20error'; } };
  for (let index = 0; index < probes.length; index++) {
    const item = probes[index];
    let result;
    try {
      const module = await import(pathToFileURL(path.join(workspace, item.module)));
      if (item.absent) result = { __proto__: null, kind: 'presence', present: hasOwn(module, item.export) };
      else {
        let thenable = false;
        try {
          const value = hasOwn(item, 'args') ? module[item.export](...item.args) : module[item.export];
          // A promise with an own `then: undefined`, or with Promise.prototype.then deleted, is still a promise.
          thenable = isPromise(value) || typeof value?.then !== 'undefined';
          const settled = await value;
          let isPlain = false;
          try { isPlain = plain(settled, 0); } catch { isPlain = false; }
          try { result = { __proto__: null, kind: 'value', thenable, plain: isPlain, value: apply(base64Slice, encode(settled), []) }; }
          catch { result = { __proto__: null, kind: 'unserializable', thenable }; }
        } catch (error) {
          result = { __proto__: null, kind: 'threw', thenable, error: message(error) };
        }
      }
    } catch (error) {
      result = { __proto__: null, kind: 'import-failed', error: message(error) };
    }
    report(index, result);
  }
}

/**
 * Runs one probe child over `probes` and returns the results it reported, in order, until it finished, exited, went
 * `idleMs` without reporting, or reached `timeoutMs`. The child's stdout is discarded, so it cannot reach this process's output.
 */
function runProbe(workspace, probes, { timeoutMs, idleMs }) {
  const nonce = randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [self, '--probe', workspace], { stdio: ['pipe', 'ignore', 'inherit', 'pipe'] });
    const results = [];
    let buffer = '', done = false, idle = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(idle); clearTimeout(total);
      process.off('SIGTERM', kill); process.off('SIGINT', kill);
      child.kill('SIGKILL');
      resolve(results);
    };
    const kill = () => { child.kill('SIGKILL'); process.exit(1); };
    process.once('SIGTERM', kill);
    process.once('SIGINT', kill);
    const total = setTimeout(finish, Math.max(1, timeoutMs));
    const arm = () => { clearTimeout(idle); idle = setTimeout(finish, Math.max(1, Math.min(idleMs, timeoutMs))); };
    arm();
    child.stdio[3].setEncoding('utf8');
    child.stdio[3].on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16_000_000) return finish();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        const prefix = `${nonce}:${results.length}:`;
        if (!line.startsWith(prefix)) continue;
        try {
          const result = JSON.parse(line.slice(prefix.length));
          if (typeof result.error === 'string') {
            try { result.error = decodeURIComponent(result.error); } catch { /* keep the encoded text */ }
          }
          results.push(result);
        } catch { return finish(); }
        arm();
        if (results.length === probes.length) return finish();
      }
    });
    child.stdio[3].on('error', () => {});
    child.on('error', error => { if (!done) { done = true; clearTimeout(idle); clearTimeout(total); process.off('SIGTERM', kill); process.off('SIGINT', kill); reject(error); } });
    child.on('close', () => setImmediate(finish));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ nonce, probes }));
  });
}

function judge(check, result) {
  if (check.absent) return assert.ok(result.kind === 'presence' && result.present === false, `${check.export} must be absent`);
  if (check.throws) {
    assert.equal(result.kind, 'threw', `${check.export} must throw`);
    assert.ok(typeof result.error === 'string' && result.error.includes(check.throws), `${check.export} must throw ${check.throws}`);
    return;
  }
  assert.equal(result.kind, 'value', result.error || `${check.export} did not return a value (${result.kind})`);
  if (check.synchronous) assert.equal(result.thenable, false, `${check.export} must remain synchronous`);
  assert.equal(result.plain, true, `${check.export} must return plain data`);
  assert.deepStrictEqual(deserialize(Buffer.from(result.value, 'base64')), check.expected);
}

/**
 * Private checks: the checked modules run in a child process that receives only module, export and args, and this process
 * alone holds the expectations and compares them. This keeps expectations out of casual reach; it is not a sandbox. Code
 * running as the same user can still read this process's memory (for example /proc/<pid>/mem where ptrace is allowed).
 * A check that hangs or exits fails alone: the probe restarts after it. Checks left when `budgetMs` runs out fail.
 * Returns one verdict per check; `messages` holds the failure message for each failed check.
 */
export async function checkCasesIsolated(workspace, checks, { budgetMs = 12_000, idleMs = 8_000 } = {}) {
  const results = new Array(checks.length).fill(null);
  const deadline = Date.now() + budgetMs;
  let start = 0, stopped = 0;
  while (start < checks.length) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const reported = await runProbe(workspace, checks.slice(start).map(probeOf), { timeoutMs: remaining, idleMs });
    reported.forEach((result, offset) => { results[start + offset] = result; });
    start += reported.length;
    if (start >= checks.length) break;
    results[start] = { kind: 'stopped' };
    stopped++;
    start++;
  }
  const verdicts = [], messages = [];
  for (const [index, check] of checks.entries()) {
    const result = results[index];
    if (!result || result.kind === 'stopped') {
      verdicts.push(false);
      messages.push(result ? `${check.export}: checked code hung or exited before reporting` : `${check.export}: checker budget ran out before this check`);
      continue;
    }
    try { judge(check, result); verdicts.push(true); messages.push(null); }
    catch (error) { verdicts.push(false); messages.push(String(error?.message ?? error).slice(0, 1000)); }
  }
  return { verdicts, messages, stopped };
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  // The probe child exits on its own after the last report; the parent also kills it once every check has reported.
  if (process.argv[2] === '--probe') await probeMain(process.argv[3]);
  else await checkerMain();
}

async function checkerMain() {
  // The challenge, the time budget and the checks arrive on stdin, so none of them appears in any process's command line.
  const [workspace] = process.argv.slice(2);
  const input = fs.readFileSync(0, 'utf8');
  const split = input.indexOf('\n');
  const [challenge, budget, idle] = input.slice(0, split).trim().split(/\s+/);
  assert.match(challenge, /^[a-f0-9]{32}$/);
  const options = {};
  if (budget) options.budgetMs = Number(budget);
  if (idle) options.idleMs = Number(idle);
  for (const value of Object.values(options)) assert.ok(Number.isSafeInteger(value) && value > 0, 'budget and idle limit must be positive integers');
  const task = JSON.parse(input.slice(split + 1));
  const { verdicts, messages } = await checkCasesIsolated(workspace, task.checks, options);
  // Only this process writes to stdout (the probe's stdout is discarded), so checked code cannot casually forge verdict lines.
  const lines = verdicts.map((pass, index) => `harness-context-check-v1:${challenge}:${index}:${pass ? 'pass' : 'fail'}`);
  const passed = verdicts.every(Boolean);
  if (passed) lines.push(`harness-context-checked-v1:${challenge}:${task.checks.length}`);
  for (const message of messages.filter(Boolean)) process.stderr.write(`${message}\n`);
  process.stdout.write(`${lines.join('\n')}\n`, () => process.exit(passed ? 0 : 1));
}
