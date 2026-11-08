import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { configureDiscovery, discoverCapabilities } from '../lib/capability-catalog.mjs';
import { adaptationContext, capabilityContext } from '../lib/adaptive-context.mjs';
import { resourceCandidates } from '../lib/resource-candidates.mjs';
import { readOrientSlice } from '../lib/orient-read.mjs';
import { reviewHash } from '../lib/review-preparation.mjs';
import { initGit } from './helpers/cli-fixtures.mjs';

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-adaptive-context-bounds-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { workspace: path.join(root, 'product'), home: path.join(root, 'state'), copilotHome: path.join(root, 'config') };
  fs.mkdirSync(options.workspace); fs.mkdirSync(options.copilotHome);
  fs.writeFileSync(path.join(options.workspace, '.gitignore'), '.harness/\n');
  fs.writeFileSync(path.join(options.workspace, 'index.js'), 'export const value = 1;\n');
  initGit(options.workspace);
  for (let index = 0; index < 8; index++) {
    const name = `enterprise-payments-${index}`, full = path.join(options.copilotHome, 'skills', name, 'SKILL.md');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `---\nname: ${name}\ndescription: ${'Enterprise payments transaction convention. '.repeat(70)}\ncapabilities: [enterprise-payments]\n---\nApply the enterprise procedure.\n`);
  }
  configureDiscovery({ ...options, input: { schema: 1, roots: [{ path: options.copilotHome, kind: 'config', included: true }], ongoing: false, grants: {} } });
  for (const revision of ['one', 'two']) {
    const value = { version: 2, scope: { revision }, findings: Array.from({ length: 6 }, (_, index) => ({ id: `payments-${index}`, file: 'index.js', title: `Enterprise payments repeated defect ${index}. ${'Exact transaction context. '.repeat(50)}` })) };
    const id = reviewHash(value), file = path.join(options.workspace, '.harness/reviews/records', `${id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ...value, id, recordedAt: '2026-11-06' }));
  }
  return options;
}

test('rich capability metadata and recurring evidence remain useful within actual orientation v2 limits', t => {
  const options = fixture(t), query = 'enterprise payments';
  const fullCatalog = discoverCapabilities({ ...options, query, limit: 8 });
  const fullCandidates = resourceCandidates({ ...options, dryRun: true });
  assert.equal(fullCatalog.resources.length, 8); assert.ok(fullCandidates.candidates.length >= 6);
  assert.ok(Buffer.byteLength(JSON.stringify(fullCatalog)) > 32768, 'fixture must reproduce rich source metadata pressure');
  const capabilities = capabilityContext({ ...options, query, limit: 8 });
  const adaptation = adaptationContext({ ...options, query, limit: 50 });
  assert.ok(Buffer.byteLength(JSON.stringify(capabilities)) <= 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(adaptation)) <= 4096);
  assert.ok(adaptation.candidates.length > 0 && adaptation.candidates.length <= 4);
  assert.equal(adaptation.coverage.state, 'partial'); assert.ok(adaptation.omitted > 0);
  assert.equal(adaptation.candidatePacket.id, fullCandidates.id);
  assert.equal(adaptation.candidatePacket.path, fullCandidates.packetPath);
  assert.equal(adaptation.candidatePacket.persisted, false);
  assert.ok(adaptation.candidates.every(row => row.id && row.kind && row.name && row.count >= 2));
  assert.ok(adaptation.candidates.every(row => !row.detail && !row.tasks && !row.existingChecks));
  const orientation = readOrientSlice({ ...options, query, files: ['index.js'], flags: { contextVersion: 2, read: true, dryRun: true, harnessHome: options.home } });
  assert.equal(orientation.coverage.renderBarrier, false);
  assert.ok(orientation.slice?.adaptation.candidates.length);
  assert.ok(Buffer.byteLength(JSON.stringify(orientation)) <= 32768);
  assert.ok(resourceCandidates({ ...options, dryRun: true }).candidates.some(row => row.detail.title.length > 1000), 'detailed evidence must remain expandable');
});
