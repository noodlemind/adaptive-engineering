import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';

test('Windows test shards allow the observed full-suite runtime with margin', () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../../../.github/workflows/harness-windows.yml', import.meta.url), 'utf8'));
  assert.ok(workflow.jobs.tests['timeout-minutes'] >= 60);
});

test('the Windows workflow gate rejects failed or unavailable suite and probe verdicts', {
  skip: process.platform !== 'win32' ? 'Executes the actual Windows PowerShell gate' : false,
}, () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../../../.github/workflows/harness-windows.yml', import.meta.url), 'utf8'));
  const gate = workflow.jobs.windows.steps.find((step) => step.name === 'Windows probe gate').run;
  const cases = [
    ['success', 'success', 'pass', 'pass', 0],
    ['failure', 'success', 'pass', 'pass', 1],
    ['cancelled', 'success', 'pass', 'pass', 1],
    ['', 'success', 'pass', 'pass', 1],
    ['success', 'failure', 'pass', 'pass', 1],
    ['success', '', 'pass', 'pass', 1],
    ['success', 'success', 'fail', 'pass', 1],
    ['success', 'success', '', 'pass', 1],
    ['success', 'success', 'pass', 'fail', 1],
    ['success', 'success', 'pass', '', 1],
  ];
  for (const [suite, inventory, redaction, cancellation, expected] of cases) {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', gate], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        SUITE_OUTCOME: suite,
        INVENTORY_OUTCOME: inventory,
        REDACTION_RESULT: redaction,
        REDACTION_REASON: 'fixture redaction verdict',
        CANCELLATION_RESULT: cancellation,
        CANCELLATION_REASON: 'fixture cancellation verdict',
        GITHUB_STEP_SUMMARY: '',
      },
    });
    assert.equal(result.status, expected, JSON.stringify({ suite, inventory, redaction, cancellation, stdout: result.stdout, stderr: result.stderr }));
    assert.match(result.stdout, /Harness test suite \(Windows\)/);
    assert.match(result.stdout, expected === 0 ? /full test suite and both gating probes passed/ : /GATE FAILED/);
  }
});
