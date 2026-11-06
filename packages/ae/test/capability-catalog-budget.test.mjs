import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { configureDiscovery, discoveryPolicy } from '../lib/capability-catalog.mjs';
import { decisionPolicyFromDiscovery, prepareDecision } from '../lib/decision-agent.mjs';

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-catalog-budget-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'state'), copilotHome = path.join(root, 'config');
  fs.mkdirSync(workspace); fs.mkdirSync(copilotHome);
  const options = { workspace, home, copilotHome };
  return { ...options, configure: budgets => configureDiscovery({ ...options, input: { schema: 1, roots: [{ path: copilotHome, kind: 'config', included: true }], ongoing: true, grants: { decision: true, tools: ['read'], budgets } } }) };
}

test('unsupported native model spend cannot be configured as an enforced decision budget', t => {
  for (const maxSpend of [0, 1, 10000]) {
    const f = fixture(t);
    assert.throws(() => f.configure({ maxSpend }), /maxSpend.*unsupported|spend.*not.*expos|spend.*unavailable/i);
    assert.equal(discoveryPolicy(f).configured, false, 'unsupported spend authority must not be published');
  }
});

test('accepted maximum catalog counters and time remain exact in the native decision packet', t => {
  const f = fixture(t), budgets = { maxDecisions: 1000, maxRepairs: 1000, maxAcquisitions: 1000, maxSeconds: 86400 };
  f.configure(budgets);
  const snapshot = discoveryPolicy(f);
  assert.deepEqual(snapshot.policy.grants.budgets, budgets);
  const prepared = prepareDecision({ ...f, policy: decisionPolicyFromDiscovery(snapshot), input: { schema: 1, taskId: 'maximum-supported-budget', sessionId: 'native-session', type: 'action', intent: 'Inspect the selected local behavior.', action: { tool: 'Read', input: { file_path: 'source.mjs' }, cwd: f.workspace } } });
  assert.deepEqual(prepared.packet.budgets, budgets, 'accepted counts must never silently fall back to smaller runtime defaults');
});

test('catalog refuses counters and time beyond runtime enforcement limits before publishing consent', t => {
  for (const budgets of [{ maxDecisions: 1001 }, { maxRepairs: 1001 }, { maxAcquisitions: 1001 }, { maxSeconds: 86401 }]) {
    const f = fixture(t);
    assert.throws(() => f.configure(budgets), /invalid .* budget/i);
    assert.equal(discoveryPolicy(f).configured, false);
  }
});
