import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
        if (check.synchronous) assert.equal(typeof result?.then, 'undefined', `${check.export} must remain synchronous`);
        assert.deepEqual(await result, check.expected);
      }
    }
  }
}

/** What the probe child may know about a check: never the expected value or the expected error text. */
export const probeOf = check => ({ module: check.module, export: check.export, ...(Object.hasOwn(check, 'args') ? { args: check.args } : {}), ...(check.absent ? { absent: true } : {}) });

/** Child side: import each module, evaluate, and report serialized results. It never sees expectations. */
async function probe(workspace, probes) {
  const results = [];
  for (const item of probes) {
    try {
      const module = await import(pathToFileURL(path.join(workspace, item.module)));
      if (item.absent) { results.push({ present: Object.hasOwn(module, item.export) }); continue; }
      let thenable = false;
      try {
        const result = Object.hasOwn(item, 'args') ? module[item.export](...item.args) : module[item.export];
        thenable = typeof result?.then !== 'undefined';
        const value = await result;
        try { results.push({ ok: true, thenable, value: serialize(value).toString('base64') }); }
        catch { results.push({ ok: false, thenable, error: 'result is not serializable' }); }
      } catch (error) {
        results.push({ ok: false, thenable, error: String(error?.message ?? error) });
      }
    } catch (error) {
      results.push({ ok: false, thenable: false, error: `import failed: ${String(error?.message ?? error)}` });
    }
  }
  return results;
}

function runProbe(workspace, probes) {
  const nonce = randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [self, '--probe', workspace], { stdio: ['pipe', 'pipe', 'inherit'] });
    const kill = () => { child.kill('SIGKILL'); process.exit(1); };
    process.once('SIGTERM', kill);
    process.once('SIGINT', kill);
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (output.length < 8_000_000) output += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      const line = output.split(/\r?\n/).filter(entry => entry.startsWith(`${nonce}:`)).at(-1);
      if (!line) return reject(new Error('checked code stopped before reporting results'));
      try { resolve(JSON.parse(Buffer.from(line.slice(nonce.length + 1), 'base64').toString('utf8'))); }
      catch { reject(new Error('unreadable probe results')); }
    });
    child.stdin.end(JSON.stringify({ nonce, probes }));
  });
}

function judge(check, result) {
  if (check.absent) return assert.equal(result.present, false, `${check.export} must be absent`);
  if (check.throws) {
    assert.equal(result.ok, false, `${check.export} must throw`);
    assert.ok(typeof result.error === 'string' && result.error.includes(check.throws), `${check.export} must throw ${check.throws}`);
    return;
  }
  assert.equal(result.ok, true, result.error || `${check.export} failed`);
  if (check.synchronous) assert.equal(result.thenable, false, `${check.export} must remain synchronous`);
  assert.deepStrictEqual(deserialize(Buffer.from(result.value, 'base64')), check.expected);
}

/**
 * Private checks: the checked modules run in a child process that receives only module, export and args.
 * This process alone holds the expectations and compares them, so checked code cannot read or forge them.
 * Returns one verdict per check; `messages` holds the first failure's message for each failed check.
 */
export async function checkCasesIsolated(workspace, checks) {
  const results = await runProbe(workspace, checks.map(probeOf));
  if (!Array.isArray(results) || results.length !== checks.length) throw new Error('probe returned the wrong number of results');
  const verdicts = [], messages = [];
  for (const [index, check] of checks.entries()) {
    try { judge(check, results[index] || {}); verdicts.push(true); messages.push(null); }
    catch (error) { verdicts.push(false); messages.push(String(error?.message ?? error).slice(0, 1000)); }
  }
  return { verdicts, messages };
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  if (process.argv[2] === '--probe') {
    const { nonce, probes } = JSON.parse(fs.readFileSync(0, 'utf8'));
    const results = await probe(process.argv[3], probes);
    process.stdout.write(`\n${nonce}:${Buffer.from(JSON.stringify(results)).toString('base64')}\n`, () => process.exit(0));
    await new Promise(() => {});
  }
  // The challenge and the checks arrive on stdin, so neither appears in any process's command line.
  const [workspace] = process.argv.slice(2);
  const input = fs.readFileSync(0, 'utf8');
  const split = input.indexOf('\n');
  const challenge = input.slice(0, split).trim();
  assert.match(challenge, /^[a-f0-9]{32}$/);
  const task = JSON.parse(input.slice(split + 1));
  const { verdicts, messages } = await checkCasesIsolated(workspace, task.checks);
  // Only this process writes to stdout (the probe's output is captured), so verdict lines cannot be forged by checked code.
  const lines = verdicts.map((pass, index) => `harness-context-check-v1:${challenge}:${index}:${pass ? 'pass' : 'fail'}`);
  const passed = verdicts.every(Boolean);
  if (passed) lines.push(`harness-context-checked-v1:${challenge}:${task.checks.length}`);
  for (const message of messages.filter(Boolean)) process.stderr.write(`${message}\n`);
  process.stdout.write(`${lines.join('\n')}\n`, () => process.exit(passed ? 0 : 1));
}
