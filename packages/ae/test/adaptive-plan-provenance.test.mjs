import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { configureDiscovery, discoveryPolicy } from '../lib/capability-catalog.mjs';
import { updatePlanDecision } from '../lib/plan-update.mjs';
import { writeSession } from '../lib/session.mjs';
import { writeVersionedPlan } from './helpers/cli-fixtures.mjs';

test('plan skill provenance uses the selected state home when source consent is revoked', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-plan-provenance-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), copilotHome = path.join(root, 'copilot'), home = path.join(root, 'selected-state');
  fs.mkdirSync(workspace);
  const source = path.join(copilotHome, 'skills/enterprise-orders/SKILL.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const text = '---\nname: enterprise-orders\ndescription: Follow enterprise order conventions.\n---\nInspect request idempotency.\n';
  fs.writeFileSync(source, text);
  const options = { workspace, copilotHome, home };
  configureDiscovery({ ...options, input: { schema: 1, roots: [{ path: copilotHome, included: true }], ongoing: true, grants: {} } });
  const planPath = writeVersionedPlan(workspace);
  const expect = createHash('sha256').update(fs.readFileSync(path.join(workspace, planPath))).digest('hex');
  const now = new Date().toISOString();
  writeSession(workspace, { sessionId: 'actual-session', sessionStartedAt: now, activatedSkills: { 'enterprise-orders': { complete: true, sessionId: 'actual-session', activatedAt: now,
    source: { version: 1, path: source, sha256: createHash('sha256').update(text).digest('hex') } } } });
  const input = { version: 1, id: 'add-enterprise-source', action: 'amend', expect, rationale: 'Record the source read in this session.', changes: { skillsUsed: ['enterprise-orders'] } };
  assert.doesNotThrow(() => updatePlanDecision({ ...options, planPath, input, dryRun: true }));
  const prior = discoveryPolicy(options);
  configureDiscovery({ ...options, input: { ...prior.policy, expectedRevision: prior.policyRevision, exclusions: ['enterprise-orders'] } });
  assert.throws(() => updatePlanDecision({ ...options, planPath, input, dryRun: true }), /enterprise-orders.*actual complete read|enterprise-orders.*source/i);
});
