import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { beforeDeliveryTool, runDeliveryCommand } from '../lib/agent-delivery.mjs';
import { DELIVER_PROFILE, dispatchToolCall } from '../lib/agent-loop.mjs';

const decision = { schema: 1, expectedDigest: null, checks: { behavior: { command: [process.execPath, 'assert-behavior.mjs'], proof: 'behavior' } }, rationale: 'Bind the existing behavior assertion.' };
const call = (argv, value) => ({ id: 'recovery-check', name: 'harness', input: { argv, ...(value === undefined ? {} : { decision: value }) } });

test('headless recovery admits only bounded inspection and authored check configuration', () => {
  const options = { workspace: process.cwd() };
  for (const request of [call(['checks', 'list']), call(['checks', 'list', '--json']), call(['checks', 'show', 'behavior']), call(['checks', 'configure'], decision), call(['checks', 'configure', '--dry-run'], decision)]) {
    const admitted = beforeDeliveryTool(request, options);
    assert.equal(admitted.pass, true, `${JSON.stringify(request.input)}: ${admitted.reason}`);
  }
  for (const request of [
    call(['checks', 'run', 'behavior']), call(['checks', 'remove', 'behavior']), call(['checks', 'configure']),
    call(['checks', 'list', 'behavior']), call(['checks', 'show']), call(['checks', 'show', 'behavior', 'another']),
    call(['checks', 'list', '--file', '-']), call(['checks', 'configure', '--file', '-'], decision),
    call(['checks', 'configure', '--file=outside.json'], decision), call(['checks', 'configure', '--unknown'], decision),
    call(['checks', 'configure', '&&', 'touch', 'unexpected'], decision), call(['checks', 'configure', '--workspace', '/elsewhere'], decision),
    call(['checks', 'configure', '--ae-home=/elsewhere'], decision), call(['checks', 'configure', '--copilot-home', '/elsewhere'], decision),
    call(['checks', 'configure', '--skills-home', '/elsewhere'], decision), call(['checks', 'list'], decision),
    call(['trust', 'approve']), call(['trust', 'revoke']),
  ]) assert.equal(beforeDeliveryTool(request, options).pass, false, JSON.stringify(request.input));
});

test('headless recovery stages authored configuration outside product scope and removes the owned input', async () => {
  let staged;
  const result = await runDeliveryCommand(call(['checks', 'configure'], decision).input, async argv => {
    assert.deepEqual(argv.slice(0, 2), ['checks', 'configure']);
    staged = argv[argv.indexOf('--file') + 1];
    assert.deepEqual(JSON.parse(fs.readFileSync(staged, 'utf8')), decision);
    return { status: 'ok' };
  });
  assert.equal(result.status, 'ok');
  assert.equal(fs.existsSync(staged), false);
});

test('headless recovery dispatch prepares real check policy without executing or approving it', { timeout: 60_000 }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-recovery-adapter-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'state'), copilotHome = path.join(root, 'copilot');
  fs.mkdirSync(path.join(workspace, '.github/harness'), { recursive: true });
  const source = path.join(workspace, '.github/harness/checks.yaml');
  fs.writeFileSync(source, 'version: 1\nchecks: {}\n');
  const marker = path.join(workspace, 'must-not-execute');
  const input = { ...decision, expectedDigest: createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
    checks: { behavior: { command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`], proof: 'behavior' } } };
  const options = { workspace, copilotHome, harnessHome: home, profile: DELIVER_PROFILE, remainingSeconds: 30 };
  const configured = await dispatchToolCall(call(['checks', 'configure'], input), options);
  assert.equal(configured.dispatched, true, configured.reason);
  assert.equal(configured.result.status, 'ok', JSON.stringify(configured.result));
  assert.equal(fs.existsSync(marker), false, 'configuration cannot execute the declared command');
  assert.equal(fs.existsSync(path.join(home, 'trust.yaml')), false, 'configuration cannot approve execution trust');
  const listed = await dispatchToolCall(call(['checks', 'list']), options);
  assert.equal(listed.dispatched, true, listed.reason);
  assert.equal(listed.result.status, 'ok', JSON.stringify(listed.result));
  assert.match(JSON.stringify(listed.result), /behavior/);
  const approved = await dispatchToolCall(call(['trust', 'approve']), options);
  assert.equal(approved.dispatched, false);
  assert.equal(fs.existsSync(path.join(home, 'trust.yaml')), false);
});
