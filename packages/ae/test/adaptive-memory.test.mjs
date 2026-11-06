import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { writeSession } from '../lib/session.mjs';
import { loadedResourceUses } from '../lib/adaptive-context.mjs';
import { configureDiscovery } from '../lib/capability-catalog.mjs';

test('learning attribution retains only complete current-session source-bound skill loads', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-memory-resource-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), copilotHome = path.join(root, 'copilot');
  fs.mkdirSync(workspace);
  const source = path.join(copilotHome, 'skills', 'enterprise-orders', 'SKILL.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const text = '---\nname: enterprise-orders\ndescription: Enterprise orders\n---\nReview idempotency.\n';
  fs.writeFileSync(source, text);
  const sha256 = createHash('sha256').update(text).digest('hex');
  const activation = { sessionId: 'actual-current-session', complete: true, activatedAt: new Date().toISOString(), source: { version: 1, path: source, sha256 } };
  writeSession(workspace, { sessionId: 'actual-current-session', activatedSkills: { 'enterprise-orders': activation } });
  const uses = loadedResourceUses({ workspace, copilotHome });
  assert.equal(uses.length, 1);
  assert.equal(uses[0].sha256, sha256);
  assert.match(uses[0].assurance, /does not prove causal effectiveness/);
  fs.appendFileSync(source, 'Changed after loading.\n');
  assert.deepEqual(loadedResourceUses({ workspace, copilotHome }), []);
  fs.writeFileSync(source, text);
  writeSession(workspace, { sessionId: 'fresh-session', activatedSkills: { 'enterprise-orders': activation } });
  assert.deepEqual(loadedResourceUses({ workspace, copilotHome }), []);
});

test('revoking an installed skill root or excluding its resource key removes learning attribution', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-memory-revocation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), copilotHome = path.join(root, 'copilot'), home = path.join(root, 'state');
  fs.mkdirSync(workspace);
  const source = path.join(copilotHome, 'skills', 'example', 'SKILL.md'), body = '---\nname: example\ndescription: Example workflow\n---\nInspect behavior.\n';
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, body);
  writeSession(workspace, { sessionId: 'session', activatedSkills: { example: { sessionId: 'session', complete: true,
    source: { version: 1, path: source, sha256: createHash('sha256').update(body).digest('hex') } } } });
  const options = { workspace, copilotHome, home };
  const input = { schema: 1, roots: [{ path: copilotHome, kind: 'config', included: true }], ongoing: true, grants: {} };
  const first = configureDiscovery({ ...options, input });
  assert.equal(loadedResourceUses(options).length, 1);
  configureDiscovery({ ...options, input: { ...input, expectedRevision: first.policyRevision, roots: [{ ...input.roots[0], included: false }] } });
  assert.deepEqual(loadedResourceUses(options), []);
});
