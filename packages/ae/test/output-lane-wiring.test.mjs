import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EXIT } from '../lib/style.mjs';
import { dispatch, registerCommand } from '../lib/registry.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runHarness(args) {
  return spawnSync(process.execPath, [binPath, ...args], { cwd: packageRoot, encoding: 'utf8' });
}

/** Capture everything written to stdout during `fn()` (covers both
 * `console.log` and a direct `process.stdout.write` — dispatchLane uses both). */
async function withCapturedStdout(fn) {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = (chunk) => {
    captured += chunk.toString();
    return true;
  };
  try {
    const code = await fn();
    return { code, stdout: captured };
  } finally {
    process.stdout.write = originalWrite;
  }
}

/** Same as `withCapturedStdout`, for stderr — dispatchLane's json-envelope
 * error branch writes there via `console.error`. */
async function withCapturedStderr(fn) {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk) => {
    captured += chunk.toString();
    return true;
  };
  try {
    const code = await fn();
    return { code, stderr: captured };
  } finally {
    process.stderr.write = originalWrite;
  }
}

// --- CLI-level: bin/ae.mjs's extractOutputLane -----------------------

test('CLI: --output json-envelope produces the versioned envelope for a registered pilot', () => {
  const workspace = tempDir('lane-json-ws-');
  const copilotHome = tempDir('lane-json-home-');
  const result = runHarness(['status', '--workspace', workspace, '--copilot-home', copilotHome, '--output', 'json-envelope']);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.schema, 1);
  assert.equal(body.command, 'status');
  assert.equal(body.status, 'ok');
  assert.ok('packageVersion' in body);
});

test('CLI: --output agent produces budgeted plain text, not JSON', () => {
  const workspace = tempDir('lane-agent-ws-');
  const copilotHome = tempDir('lane-agent-home-');
  const result = runHarness(['status', '--workspace', workspace, '--copilot-home', copilotHome, '--output', 'agent']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^\s*\{/);
  // Minor #10: the agent lane opens with the untrusted-data fence.
  assert.match(result.stdout, /^«untrusted-data»/);
  assert.match(result.stdout, /\nschema 1\n/);
  assert.match(result.stdout, /command status/);
});

test('CLI: --output=agent (equals-form) is honored, matching the rest of the harness flag vocabulary', () => {
  const workspace = tempDir('lane-eq-agent-ws-');
  const copilotHome = tempDir('lane-eq-agent-home-');
  const result = runHarness(['status', '--workspace', workspace, '--copilot-home', copilotHome, '--output=agent']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^«untrusted-data»/);
  assert.match(result.stdout, /\nschema 1\n/);
  assert.match(result.stdout, /command status/);
});

test('CLI: --output=json-envelope (equals-form) is honored', () => {
  const workspace = tempDir('lane-eq-json-ws-');
  const copilotHome = tempDir('lane-eq-json-home-');
  const result = runHarness(['status', '--workspace', workspace, '--copilot-home', copilotHome, '--output=json-envelope']);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.schema, 1);
});

test('CLI: --output with a missing value is a structured usage error, exit 2', () => {
  const workspace = tempDir('lane-missing-ws-');
  const copilotHome = tempDir('lane-missing-home-');
  const result = runHarness(['status', '--workspace', workspace, '--copilot-home', copilotHome, '--output']);
  assert.equal(result.status, EXIT.usage);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid --output: \(missing\)/);
});

test('CLI: --output with an unrecognized value is a structured usage error, exit 2', () => {
  const workspace = tempDir('lane-bogus-ws-');
  const copilotHome = tempDir('lane-bogus-home-');
  const result = runHarness(['status', '--workspace', workspace, '--copilot-home', copilotHome, '--output', 'bogus']);
  assert.equal(result.status, EXIT.usage);
  assert.match(result.stderr, /invalid --output: "bogus"/);
});

test('CLI: beside compound evidence flags an invalid --output value is not echoed', () => {
  const workspace = tempDir('lane-evidence-ws-');
  const copilotHome = tempDir('lane-evidence-home-');
  const result = runHarness(['compound', '--insight', '--evidence-quote', '-', '--workspace', workspace, '--copilot-home', copilotHome, '--output', 'SECRETLANE']);
  assert.equal(result.status, EXIT.usage);
  assert.match(result.stderr, /invalid --output: not a known lane/);
  assert.doesNotMatch(result.stderr, /SECRETLANE/);
});

// --- CRITICAL repro (fix round 1): the `--` literal-argument boundary -----

test('CLI: --output after a literal `--` is inert free-text content — legacy --json stays byte-shape-identical (no envelope wrapper)', () => {
  const workspace = tempDir('lane-boundary-ws-');
  const copilotHome = tempDir('lane-boundary-home-');

  const withBoundary = runHarness([
    'orient',
    '--json',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--',
    '--output',
    'agent',
  ]);
  assert.equal(withBoundary.status, 0, withBoundary.stderr);
  const body = JSON.parse(withBoundary.stdout);
    assert.ok(!('schema' in body), 'the legacy --json shape must never gain an envelope wrapper');
  assert.ok(!('status' in body), 'the raw orient result has no top-level status field — an envelope would add one');
  assert.ok('contextPack' in body);
  assert.ok('gateStatus' in body);
  assert.ok('recall' in body);
});

test('CLI: --output before a literal `--` still works, proving the boundary check is positional, not blanket-disabling --output', () => {
  const workspace = tempDir('lane-boundary-ok-ws-');
  const copilotHome = tempDir('lane-boundary-ok-home-');
  const result = runHarness(['status', '--workspace', workspace, '--copilot-home', copilotHome, '--output', 'agent', '--', 'ignored-literal']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^«untrusted-data»/);
  assert.match(result.stdout, /\nschema 1\n/);
});

// --- lib/registry.mjs: dispatch/dispatchLane ctx.output branching ---------

test('dispatch: ctx.output "json" renders the versioned envelope via dispatchLane, bypassing the legacy handler', async () => {
  const copilotHome = tempDir('dispatch-json-home-');
  const { code, stdout } = await withCapturedStdout(() => dispatch(['status', '--copilot-home', copilotHome], { output: 'json' }));
  assert.equal(code, 0);
  const body = JSON.parse(stdout.trim());
  assert.equal(body.schema, 1);
  assert.equal(body.command, 'status');
});

test('dispatch: ctx.output "agent" renders budgeted plain text via dispatchLane', async () => {
  const copilotHome = tempDir('dispatch-agent-home-');
  const { code, stdout } = await withCapturedStdout(() => dispatch(['status', '--copilot-home', copilotHome], { output: 'agent' }));
  assert.equal(code, 0);
  assert.match(stdout, /^«untrusted-data»/);
  assert.match(stdout, /\nschema 1\n/);
});

test('dispatch: ctx.output omitted (or "ledger") runs the legacy handler untouched — every pre-P1.2 caller is unaffected', async () => {
  const copilotHome = tempDir('dispatch-ledger-home-');
  const codeNoCtx = await dispatch(['status', '--copilot-home', copilotHome, '--json'], {});
  assert.equal(codeNoCtx, 0);
  const copilotHome2 = tempDir('dispatch-ledger-home2-');
  const codeExplicitLedger = await dispatch(['status', '--copilot-home', copilotHome2, '--json'], { output: 'ledger' });
  assert.equal(codeExplicitLedger, 0);
});

// --- Important-1 regression: error-path agent-lane rendering must be budgeted too ---

test('dispatchLane error path honors entry.agentBudgetBytes, same as the success path (regression: budget was previously dropped on error)', async () => {
    const budgetBytes = 150;
  registerCommand({
    name: '__test-lane-error-budget',
    summary: 'test fixture for the error-path agent-lane budget regression',
    sideEffect: 'read',
    agentBudgetBytes: budgetBytes,
    args: { flags: [], positionals: [] },
    handler: async () => 0,
    resultOf: async () => {
      throw Object.assign(new Error('x'.repeat(500)), { code: 'E_TEST_FIXTURE', exit: 1 });
    },
  });

  const { code, stdout } = await withCapturedStdout(() => dispatch(['__test-lane-error-budget'], { output: 'agent' }));
  assert.equal(code, 1);
    assert.ok(
    Buffer.byteLength(stdout, 'utf8') <= budgetBytes,
    `error-path agent-lane output (${Buffer.byteLength(stdout, 'utf8')} bytes) must honor agentBudgetBytes (${budgetBytes})`
  );
  assert.match(stdout, /^«untrusted-data»/, 'the fence survives even at a tight error budget');
});

const PLANTED_SECRET = 'token=abcdef1234567890';
const KV_SECRET_MASK = '«redacted:kv-secret»';

test('dispatchLane json-envelope SUCCESS path redacts a secret-shaped result field before writing stdout', async () => {
  registerCommand({
    name: '__test-lane-json-redact-success',
    summary: 'test fixture for the json-envelope success redaction regression',
    sideEffect: 'read',
    args: { flags: [], positionals: [] },
    handler: async () => 0,
    resultOf: async () => ({ note: `lookup failed: ${PLANTED_SECRET}` }),
  });

  const { code, stdout } = await withCapturedStdout(() => dispatch(['__test-lane-json-redact-success'], { output: 'json' }));
  assert.equal(code, 0);
  assert.doesNotMatch(stdout, /abcdef1234567890/, 'the raw secret must never reach stdout');
  const body = JSON.parse(stdout);
  assert.equal(body.note, `lookup failed: token=${KV_SECRET_MASK}`);
});

test('dispatchLane json-envelope ERROR path redacts a secret-shaped error message before writing stderr', async () => {
  registerCommand({
    name: '__test-lane-json-redact-error',
    summary: 'test fixture for the json-envelope error redaction regression',
    sideEffect: 'read',
    args: { flags: [], positionals: [] },
    handler: async () => 0,
    resultOf: async () => {
            throw Object.assign(new Error(`no learning ${PLANTED_SECRET}`), { code: 'E_TARGET', exit: 1 });
    },
  });

  const { code, stderr } = await withCapturedStderr(() => dispatch(['__test-lane-json-redact-error'], { output: 'json' }));
  assert.equal(code, 1);
  assert.doesNotMatch(stderr, /abcdef1234567890/, 'the raw secret must never reach stderr');
  const body = JSON.parse(stderr);
  assert.equal(body.error.message, `no learning token=${KV_SECRET_MASK}`);
});

test('CLI: a non-lane-aware command (gate) rejects --output json-envelope with a structured usage error, exit 2', () => {
  const workspace = tempDir('lane-unsupported-gate-ws-');
  const copilotHome = tempDir('lane-unsupported-gate-home-');
  const result = runHarness(['gate', '--workspace', workspace, '--copilot-home', copilotHome, '--output', 'json-envelope']);

  assert.equal(result.status, EXIT.usage);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /gate does not support --output json-envelope/);
  assert.match(result.stderr, /lane-bearing commands/);
    assert.equal(fs.existsSync(path.join(workspace, '.harness', 'session.json')), false, 'gate must not have run at all');
});

test('dispatch: a non-lane-aware command (gate) rejects ctx.output "json" with a structured E_USAGE error naming lane-bearing commands', async () => {
  const workspace = tempDir('dispatch-unsupported-gate-ws-');
  await assert.rejects(
    () => dispatch(['gate', '--workspace', workspace], { output: 'json' }),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.equal(err.exit, 2);
      assert.match(err.message, /command gate does not support --output json-envelope/);
            assert.match(err.message, /lane-bearing commands: .*\borient\b/);
      assert.match(err.message, /\blearnings\b/);
      assert.match(err.message, /\bstatus\b/);
      assert.match(err.message, /\(--output json-envelope\|agent\)/);
      assert.match(err.message, /\bverify\b.*\(--output jsonl\)/);
      return true;
    }
  );
  assert.equal(fs.existsSync(path.join(workspace, '.harness')), false, 'gate must not have run at all — the check happens before the handler');
});

test('dispatch: a non-lane-aware command (gate) rejects ctx.output "agent" the same way', async () => {
  const workspace = tempDir('dispatch-unsupported-gate-agent-ws-');
  await assert.rejects(
    () => dispatch(['gate', '--workspace', workspace], { output: 'agent' }),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.equal(err.exit, 2);
      assert.match(err.message, /command gate does not support --output agent/);
      return true;
    }
  );
});

test('dispatch: verify (jsonl-only, no resultOf) rejects ctx.output "json"/"agent" — jsonl support does not imply envelope/agent support', async () => {
  const workspace = tempDir('dispatch-unsupported-verify-ws-');
  await assert.rejects(
    () => dispatch(['verify', '--workspace', workspace], { output: 'json' }),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.match(err.message, /command verify does not support --output json-envelope/);
      return true;
    }
  );
  await assert.rejects(
    () => dispatch(['verify', '--workspace', workspace], { output: 'agent' }),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.match(err.message, /command verify does not support --output agent/);
      return true;
    }
  );
});

test('dispatch: a non-lane-aware command (gate) rejects ctx.output "jsonl" too — jsonl is a verify-only opt-in, not a generic fallback', async () => {
  const workspace = tempDir('dispatch-unsupported-gate-jsonl-ws-');
  await assert.rejects(
    () => dispatch(['gate', '--workspace', workspace], { output: 'jsonl' }),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.match(err.message, /command gate does not support --output jsonl/);
      return true;
    }
  );
});

test('dispatch: ctx.output "ledger" (or omitted) is always accepted, regardless of lane support', async () => {
  const workspace = tempDir('dispatch-ledger-always-ok-ws-');
  const code = await dispatch(['gate', '--workspace', workspace, '--json'], { output: 'ledger' });
  assert.ok(Number.isInteger(code));
});

test('CLI: the agent_lane event byte count equals the bytes actually written to stdout, newline included', () => {
  const workspace = tempDir('lane-meter-ws-');
  const copilotHome = tempDir('lane-meter-home-');
  const result = runHarness(['status', '--workspace', workspace, '--copilot-home', copilotHome, '--output', 'agent']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.endsWith('\n'), 'the emitted text is newline-terminated (inside the budget)');

  const eventsFile = path.join(workspace, '.harness', 'events.jsonl');
  assert.ok(fs.existsSync(eventsFile), 'the agent lane run must have recorded events');
  const rows = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const metered = rows.find((r) => r.type === 'agent_lane');
  assert.ok(metered, `expected an agent_lane metering event: ${JSON.stringify(rows)}`);
  assert.equal(
    metered.bytes,
    Buffer.byteLength(result.stdout, 'utf8'),
    'metered agent-lane bytes must equal the bytes actually emitted'
  );
});
