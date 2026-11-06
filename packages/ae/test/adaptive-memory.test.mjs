import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { writeSession } from '../lib/session.mjs';
import { loadedResourceUses } from '../lib/adaptive-context.mjs';
import { configureDiscovery } from '../lib/capability-catalog.mjs';
import { readSkillActivation } from '../corpus/hooks/lib/skill-activation.mjs';

test('learning attribution retains only complete current-session source-bound skill loads', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-memory-resource-')));
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
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-memory-revocation-')));
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

test('filesystem spelling aliases retain exact source attribution without admitting copies or redirects', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-memory-alias-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), copilotHome = path.join(root, 'copilot'), home = path.join(root, 'state');
  fs.mkdirSync(workspace);
  const source = path.join(copilotHome, 'skills', 'example', 'SKILL.md');
  const body = '---\nname: example\ndescription: Example workflow\n---\nInspect behavior.\n';
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, body);
  const alias = `${root}${path.sep}.${path.sep}${path.relative(root, source)}`;
  const payload = { cwd: workspace, session_id: 'session', tool_name: 'Read', tool_input: { file_path: alias }, tool_response: { content: body, truncated: false }, success: true };
  const observed = readSkillActivation(payload, { copilotHome, additionalSources: [alias], restrictSources: true });
  assert.ok(observed, 'A contained spelling alias of the selected regular source must establish its real source identity');
  assert.equal(observed.source.path, fs.realpathSync.native(source));
  const activation = { sessionId: 'session', complete: true, source: { version: 1, path: alias, sha256: createHash('sha256').update(body).digest('hex') } };
  writeSession(workspace, { sessionId: 'session', activatedSkills: { example: activation } });
  const options = { workspace, copilotHome, home };
  assert.equal(loadedResourceUses(options).length, 1);
  configureDiscovery({ ...options, input: { schema: 1, roots: [{ path: copilotHome, included: true }], ongoing: true, grants: {} } });
  assert.equal(loadedResourceUses(options).length, 1, 'Included catalog source identity must use the same guarded canonical comparison');
  const copy = path.join(root, 'copied-skill.md'); fs.writeFileSync(copy, body);
  writeSession(workspace, { sessionId: 'session', activatedSkills: { example: { ...activation, source: { ...activation.source, path: copy } } } });
  assert.deepEqual(loadedResourceUses(options), [], 'Equal bytes from another file do not establish source identity');
  const hardlink = path.join(root, 'hardlinked-skill.md');
  fs.linkSync(source, hardlink);
  writeSession(workspace, { sessionId: 'session', activatedSkills: { example: activation } });
  assert.equal(loadedResourceUses(options).length, 1, 'The selected source identity remains current after another name links its bytes');
  writeSession(workspace, { sessionId: 'session', activatedSkills: { example: { ...activation, source: { ...activation.source, path: hardlink } } } });
  assert.deepEqual(loadedResourceUses(options), [], 'The same inode under an unselected file name cannot borrow approved source identity');
  const redirected = path.join(root, 'redirected-skill.md');
  try { fs.symlinkSync(source, redirected); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
  writeSession(workspace, { sessionId: 'session', activatedSkills: { example: { ...activation, source: { ...activation.source, path: redirected } } } });
  assert.deepEqual(loadedResourceUses(options), [], 'Canonical comparison must not admit a symlink to the selected source');
});

test('Windows source drive casing matches the same current included file', { skip: process.platform !== 'win32' }, t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-memory-drive-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), copilotHome = path.join(root, 'copilot'), home = path.join(root, 'state');
  fs.mkdirSync(workspace);
  const source = path.join(copilotHome, 'skills', 'example', 'SKILL.md'), body = '---\nname: example\ndescription: Example workflow\n---\nInspect behavior.\n';
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, body);
  const differentlyCased = source[0] === source[0].toUpperCase() ? source[0].toLowerCase() + source.slice(1) : source[0].toUpperCase() + source.slice(1);
  writeSession(workspace, { sessionId: 'session', activatedSkills: { example: { sessionId: 'session', complete: true,
    source: { version: 1, path: differentlyCased, sha256: createHash('sha256').update(body).digest('hex') } } } });
  const options = { workspace, copilotHome, home };
  configureDiscovery({ ...options, input: { schema: 1, roots: [{ path: copilotHome, included: true }], ongoing: true, grants: {} } });
  assert.equal(loadedResourceUses(options).length, 1);
});
