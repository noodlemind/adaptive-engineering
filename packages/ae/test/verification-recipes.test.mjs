import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import YAML from 'yaml';
import { tempDir } from './helpers/temp.mjs';
import { packageRoot } from './helpers/cli.mjs';
import { runNamedCheck } from '../lib/checks.mjs';
import { approveProject } from '../lib/trust.mjs';

const root = path.resolve(packageRoot, '../..');
const recipes = ['intent-lock', 'prepare', 'issue-worktree'];
const checks = YAML.parse(fs.readFileSync(path.join(root, '.github/harness/checks.yaml'), 'utf8')).checks;

for (const feature of recipes) {
  for (const fail of [false, true]) {
    test(`${feature} drive preserves evidence and cleans its fixtures on ${fail ? 'failure' : 'success'}`, t => {
      const evidenceRoot = tempDir('recipe-evidence-');
      t.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));
      const timeout = checks[`verify-${feature}`]?.timeout_seconds * 1000;
      assert.ok(Number.isSafeInteger(timeout) && timeout > 0, `${feature} requires a bounded configured timeout`);
      const result = spawnSync(process.execPath, [`.cursor/skills/verify-harness/scripts/prove-${feature}.mjs`], {
        cwd: root,
        encoding: 'utf8',
        timeout,
        env: { ...process.env, HARNESS_DRIVE_EVIDENCE_ROOT: evidenceRoot, HARNESS_DRIVE_FAIL_AFTER: fail ? '1' : '' },
      });
      assert.ifError(result.error);
      assert.equal(result.status, fail ? 1 : 0, result.stderr);
      const dir = path.join(evidenceRoot, feature);
      const files = fs.readdirSync(dir).filter(file => file.endsWith('.json'));
      assert.equal(files.length, 1);
      const receipt = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
      assert.equal(receipt.feature, feature);
      assert.equal(receipt.lifecycle.outcome, fail ? 'failed' : 'passed');
      assert.equal(receipt.lifecycle.doctor.exitCode, 0);
      assert.ok(receipt.lifecycle.commands.length > 0);
      assert.ok(receipt.lifecycle.resources.length >= 3);
      for (const resource of receipt.lifecycle.resources) assert.equal(fs.existsSync(resource), false, resource);
      assert.equal(receipt.lifecycle.cleaned, true);
      if (!fail && feature === 'intent-lock') {
        const drift = receipt.steps.find(step => step.command === 'gate --phase implement after spec rewrite');
        assert.equal(drift.exit, 1);
        assert.equal(drift.check.pass, false);
        assert.ok(receipt.steps.some(step => step.command === 'accepted source amendment' && step.exit === 0));
      }
    });
  }
}

test('each verification recipe is a configured behavioral named check', () => {
  for (const feature of recipes) {
    const check = checks[`verify-${feature}`];
    assert.ok(check, feature);
    assert.deepEqual(check.command, ['node', `.cursor/skills/verify-harness/scripts/prove-${feature}.mjs`]);
    assert.equal(check.proof, 'behavior');
  }
});

test('an interrupted drive cancels its child and preserves cleanup evidence', async t => {
  const evidenceRoot = tempDir('recipe-interrupt-');
  t.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['.cursor/skills/verify-harness/scripts/prove-prepare.mjs'], {
    cwd: root,
    env: { ...process.env, HARNESS_DRIVE_EVIDENCE_ROOT: evidenceRoot, HARNESS_DRIVE_PAUSE_AFTER: '1',
      ...(process.platform === 'win32' ? { HARNESS_RUN_CANCEL_FILE: path.join(evidenceRoot, 'cancel.json') } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const closed = once(child, 'close');
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 15_000);
  t.after(() => clearTimeout(watchdog));
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('verification-ready')) resolve();
    });
    child.once('close', () => reject(new Error('drive exited before its cancellable child started')));
  });
  if (process.platform === 'win32') fs.writeFileSync(path.join(evidenceRoot, 'cancel.json'), JSON.stringify({ version: 1, pid: child.pid }));
  else child.kill('SIGTERM');
  await closed;
  const dir = path.join(evidenceRoot, 'prepare');
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'));
  assert.equal(receipt.lifecycle.outcome, 'cancelled');
  assert.equal(receipt.lifecycle.cleaned, true);
  for (const resource of receipt.lifecycle.resources) assert.equal(fs.existsSync(resource), false);
  const probe = receipt.lifecycle.commands.find(command => command.command === 'owned cancellation probe');
  assert.equal(probe.status, 'cancelled');
  assert.equal(probe.groupReaped, true);
  assert.throws(() => process.kill(probe.pid, 0), { code: 'ESRCH' });
});

test('a real named-check parent cancellation lets the drive retain child and cleanup receipts', async t => {
  const evidenceRoot = tempDir('recipe-parent-cancel-');
  const home = tempDir('recipe-parent-home-');
  const copilotHome = tempDir('recipe-parent-copilot-');
  t.after(() => { for (const dir of [evidenceRoot, home, copilotHome]) fs.rmSync(dir, { recursive: true, force: true }); });
  approveProject({ workspace: root, copilotHome, home });
  const previous = process.env.HARNESS_DRIVE_PAUSE_AFTER;
  process.env.HARNESS_DRIVE_PAUSE_AFTER = '1';
  t.after(() => { if (previous === undefined) delete process.env.HARNESS_DRIVE_PAUSE_AFTER; else process.env.HARNESS_DRIVE_PAUSE_AFTER = previous; });
  const controller = new AbortController();
  let ready;
  const readiness = new Promise(resolve => { ready = resolve; });
  let probePid;
  const pending = runNamedCheck(root, 'verify-prepare', {
    command: [process.execPath, '.cursor/skills/verify-harness/scripts/prove-prepare.mjs'], artifacts: ['prepare/drive.json'], timeout_seconds: 20,
  }, { home, copilotHome, signal: controller.signal, recordRoot: evidenceRoot, onStdout: chunk => {
    const match = String(chunk).match(/verification-ready:(\d+)/);
    if (match) { probePid = Number(match[1]); ready(); }
  } });
  const watchdog = setTimeout(() => controller.abort(), 15000);
  t.after(() => clearTimeout(watchdog));
  await Promise.race([readiness, pending.then(result => { throw new Error(`drive ended before cancellation probe: ${JSON.stringify(result)}`); })]);
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true, JSON.stringify(result));
  assert.equal(result.artifactError, undefined, JSON.stringify(result));
  const receipt = JSON.parse(fs.readFileSync(path.join(evidenceRoot, result.artifactRoot, 'prepare/drive.json'), 'utf8'));
  assert.equal(receipt.lifecycle.outcome, 'cancelled');
  assert.equal(receipt.lifecycle.cleaned, true);
  for (const resource of receipt.lifecycle.resources) assert.equal(fs.existsSync(resource), false);
  const probe = receipt.lifecycle.commands.find(command => command.command === 'owned cancellation probe');
  assert.equal(probe.pid, probePid);
  assert.equal(probe.groupReaped, true);
  assert.throws(() => process.kill(probePid, 0), { code: 'ESRCH' });
  if (process.platform === 'win32') {
    assert.equal(result.execution.cancellationNotice.requested, true);
    assert.equal(result.execution.groupReaped, null, 'cooperative outer close must not claim an unmeasured tree reap');
  }
});
