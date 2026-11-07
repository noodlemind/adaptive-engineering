import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeScopes, initGit, runHarness, cliHarnessHome, writeChecks, git, approveProject } from './helpers/index.mjs';
import { buildContextPack } from '../lib/context-pack.mjs';
import { parseFlags } from '../lib/flags.mjs';
import { collectOrientationFacts } from '../lib/orientation-facts.mjs';
import { buildContextRecord } from '../lib/context-record.mjs';
import { validateContextSnapshot } from '../lib/task-handoff.mjs';
import { addIsolatedWorktree } from '../lib/worktree.mjs';
import { trustStatus } from '../lib/trust.mjs';

function fixture(t) {
  const f = makeScopes();
  f.workspace = fs.realpathSync.native(f.workspace);
  f.copilotHome = fs.realpathSync.native(f.copilotHome);
  t.after(() => fs.rmSync(f.workspace, { recursive: true, force: true }));
  t.after(() => fs.rmSync(f.copilotHome, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.workspace, 'a.mjs'), 'export const alpha = 1;\n');
  initGit(f.workspace);
  const invoke = (...args) => {
    const r = runHarness(['orient', '--workspace', f.workspace, '--copilot-home', f.copilotHome, '--json', ...args], { trust: false, env: { CI: '1' } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return JSON.parse(r.stdout);
  };
  return { ...f, invoke };
}

test('version two is opt-in and a cold read writes no context artifacts', (t) => {
  const f = fixture(t);
  const result = f.invoke('--read', '--context-version', '2', '--file', 'a.mjs');
  assert.equal(result.schema, 'harness.context.v2');
  assert.equal(Object.keys(result.slice).length, 20);
  assert.equal(result.slice.checkReadiness.status, 'missing');
  assert.equal(result.slice.checkReadiness.ready, false);
  assert.equal(fs.existsSync(result.slice.checkReadiness.source), false);
  assert.equal(result.slice.layout.workspaceType, 'none');
  assert.equal(result.evidence[0].location, 'a.mjs');
  assert.match(result.evidence[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.coverage.semanticCompleteness, 'unverified');
  assert.equal(fs.existsSync(path.join(f.workspace, '.harness', 'context-pack.md')), false);
  assert.equal(fs.existsSync(path.join(f.workspace, '.harness', 'session.json')), false);
});

test('both orientation paths assemble the same facts and stable context identity', (t) => {
  const f = fixture(t);
  const read = f.invoke('--read', '--context-version', '2', '--file', 'a.mjs', '--dry-run');
  const normal = f.invoke('--context-version', '2', '--file', 'a.mjs', '--dry-run');
  assert.deepEqual(normal.context.slice, read.slice);
  assert.equal(normal.context.contextId, read.contextId);
  assert.equal(f.invoke('--read', '--context-version', '2', '--file', 'a.mjs', '--dry-run').contextId, read.contextId);
  fs.writeFileSync(path.join(f.workspace, 'a.mjs'), 'export const alpha = 2;\n');
  assert.notEqual(f.invoke('--read', '--context-version', '2', '--file', 'a.mjs', '--dry-run').contextId, read.contextId);
});

test('orientation exposes its trust diagnosis and bound recovery without another status request', t => {
  const f = fixture(t), home = path.join(f.copilotHome, 'ae state');
  const args = ['--ae-home', home, '--context-version', '2', '--file', 'a.mjs', '--dry-run'];
  const result = f.invoke(...args), read = f.invoke('--read', ...args);
  assert.deepEqual(result.trust, read.slice.trust);
  assert.equal(result.trust.cause, 'never-approved');
  assert.deepEqual(result.trust.binding, { workspace: f.workspace, home, copilotHome: f.copilotHome, store: path.join(home, 'trust.yaml') });
  assert.equal(result.trust.recovery.owner, 'person');
  assert.equal(result.trust.recovery.kind, 'review-and-approve');
  assert.deepEqual(result.trust.recovery.command.slice(2), ['trust', 'approve', '--workspace', f.workspace, '--ae-home', home, '--copilot-home', f.copilotHome, '--json']);
  assert.equal(result.checkReadiness.ready, false);
  assert.ok(!result.nextTools.some(tool => /trust\.recovery|trust approve/.test(tool)), JSON.stringify(result.nextTools));
  assert.ok(!result.nextTools.some(tool => /^ae trust status\b/.test(tool)), JSON.stringify(result.nextTools));
  assert.equal(fs.existsSync(result.trust.binding.store), false);

  writeChecks(f.workspace, { behavior: { command: [process.execPath, '--test'] } });
  const prepared = f.invoke(...args);
  assert.equal(prepared.checkReadiness.ready, true);
  assert.ok(prepared.nextTools.includes('Use trust.recovery'), JSON.stringify(prepared.nextTools));
  assert.deepEqual(prepared.trust.recovery.command, result.trust.recovery.command);
  assert.ok(!prepared.nextTools.some(tool => tool.includes(prepared.trust.recovery.command[1])), JSON.stringify(prepared.nextTools));
  assert.equal(fs.existsSync(result.trust.binding.store), false);
});

test('orientation retains Engineer trust inspection while checks need preparation', t => {
  const f = fixture(t), home = path.join(f.copilotHome, 'ae state');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'trust.yaml'), 'projects: [broken');
  const result = f.invoke('--ae-home', home, '--dry-run');
  assert.equal(result.checkReadiness.ready, false);
  assert.equal(result.trust.recovery.owner, 'engineer');
  assert.equal(result.trust.recovery.kind, 'inspect-store');
  assert.ok(result.nextTools.includes('Inspect trust.recovery; prepare checks before approval'), JSON.stringify(result.nextTools));
  assert.ok(!result.nextTools.some(tool => /trust approve/.test(tool)), JSON.stringify(result.nextTools));
});

test('orientation withholds conditional child approval until named checks are ready', t => {
  const f = fixture(t), home = path.join(f.copilotHome, 'ae state');
  fs.mkdirSync(path.join(f.workspace, '.github/harness'), { recursive: true });
  fs.writeFileSync(path.join(f.workspace, '.github/harness/checks.yaml'), 'version: 1\nchecks: {}\n');
  fs.writeFileSync(path.join(f.workspace, '.github/harness/policy.yaml'), 'enforcement: enforce\n');
  assert.equal(git(f.workspace, ['add', '.github/harness']).status, 0);
  assert.equal(git(f.workspace, ['commit', '-qm', 'policy with empty checks']).status, 0);
  approveProject({ workspace: f.workspace, copilotHome: f.copilotHome, home });
  const child = addIsolatedWorktree({ workspace: f.workspace, slug: 'orientation-recovery', from: 'HEAD' });
  t.after(() => fs.rmSync(child.path, { recursive: true, force: true }));
  fs.writeFileSync(path.join(child.path, '.github/harness/policy.yaml'), 'enforcement: warn\n');
  const scopes = { workspace: child.path, copilotHome: f.copilotHome, home };
  const invoke = (...args) => {
    const result = runHarness(['orient', '--workspace', child.path, '--copilot-home', f.copilotHome, '--ae-home', home, '--context-version', '2', '--file', 'a.mjs', '--dry-run', '--json', ...args], { trust: false, env: { CI: '1' } });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  assert.equal(trustStatus(scopes).recovery.afterInspection.owner, 'person');
  const result = invoke();
  assert.equal(result.checkReadiness.status, 'empty');
  assert.equal(result.trust.cause, 'policy-mismatch');
  assert.equal(result.trust.recovery.owner, 'engineer');
  assert.equal(result.trust.recovery.afterInspection, null);
  assert.deepEqual(result.context.slice.trust, result.trust);
  assert.deepEqual(invoke('--read').slice.trust, result.trust);
  assert.ok(result.nextTools.includes('Inspect trust.recovery; prepare checks before approval'));

  writeChecks(child.path, { behavior: { command: [process.execPath, '--test'] } });
  const prepared = invoke();
  assert.equal(prepared.checkReadiness.ready, true);
  assert.deepEqual(prepared.trust.recovery.afterInspection, trustStatus(scopes).recovery.afterInspection);
  assert.equal(prepared.trust.recovery.afterInspection.owner, 'person');
  assert.ok(prepared.trust.recovery.afterInspection.command.includes(fs.realpathSync.native(child.path)));
  assert.ok(prepared.nextTools.includes('Use trust.recovery'));
  assert.deepEqual(prepared.context.slice.trust, prepared.trust);
  assert.deepEqual(invoke('--read').slice.trust, prepared.trust);
});

test('unknown context versions fail explicitly', (t) => {
  const f = fixture(t);
  const r = runHarness(['orient', '--read', '--context-version', '9', '--workspace', f.workspace, '--json']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /context.version|version.*1.*2/i);
});

test('version two preserves exclusion and selection reasons for requested inputs', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, '.gitignore'), 'ignored.mjs\n');
  fs.writeFileSync(path.join(f.workspace, 'ignored.mjs'), 'export const ignored = 1;\n');
  const result = f.invoke('--read', '--context-version', '2', '--file', 'ignored.mjs');
  const evidence = result.evidence.find(row => row.location === 'ignored.mjs');
  assert.equal(evidence.state, 'excluded');
  assert.equal(evidence.sha256, null);
  assert.equal(evidence.reference, null);
  assert.equal(evidence.reason, 'declared task file');
  assert.deepEqual(result.coverage.unavailable, [evidence]);
});

test('the shared parser rejects missing or unsupported context versions', () => {
  assert.throws(() => parseFlags(['--context-version']), /invalid --context-version/);
  assert.throws(() => parseFlags(['--context-version', '9']), /invalid --context-version/);
});

test('policy changes during context assembly invalidate the record', (t) => {
  const f = fixture(t);
  const facts = collectOrientationFacts({ workspace: f.workspace, copilotHome: f.copilotHome, flags: { contextVersion: 2 }, files: ['a.mjs'] });
  fs.mkdirSync(path.join(f.workspace, '.github/harness'), { recursive: true });
  fs.writeFileSync(path.join(f.workspace, '.github/harness/policy.yaml'), 'version: 1\n');
  const result = buildContextRecord({ workspace: f.workspace, facts });
  assert.equal(result.coverage.sourceState, 'changed-or-unavailable');
});

test('an oversized version two response returns a bounded read barrier', (t) => {
  const f = fixture(t);
  const facts = collectOrientationFacts({ workspace: f.workspace, copilotHome: f.copilotHome, flags: { contextVersion: 2 }, files: ['a.mjs'] });
  facts.slice.planGoal = { intent: 'Preserve every accepted constraint', constraints: ['Never discard a constraint. '.repeat(4000)] };
  const result = buildContextRecord({ workspace: f.workspace, facts });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
  assert.equal(result.coverage.renderBarrier, true);
  assert.equal(result.slice, null);
  assert.match(result.expansion.reason, /read.*plan|task.*contract/i);
});

test('bare version two expansion restores selected files and accepts the equals spelling', (t) => {
  const f = fixture(t);
  f.invoke('--file', path.join(f.workspace, 'a.mjs'), '--query', 'alpha');
  const expanded = f.invoke('--read', '--context-version=2');
  assert.equal(expanded.evidence[0].location, 'a.mjs');
  assert.equal(expanded.evidence[0].state, 'readable');
  assert.equal(expanded.evidence[0].reason, 'declared task file');
  assert.equal(expanded.coverage.sourceState, 'validated');
});

test('an explicit version two read records source identities for later edit checks', (t) => {
  const f = fixture(t);
  const record = f.invoke('--read', '--context-version', '2', '--query', 'alpha', '--file', 'a.mjs');
  const session = JSON.parse(fs.readFileSync(path.join(f.workspace, '.harness/session.json'), 'utf8'));
  assert.equal(session.contextSnapshot.version, 2);
  assert.equal(session.contextSnapshot.state, 'validated');
  assert.equal(session.contextSnapshot.evidence[0].sha256, record.evidence[0].sha256);
});

test('bare version two refresh replaces a stale session snapshot before edits resume', (t) => {
  const f = fixture(t);
  f.invoke('--read', '--context-version', '2', '--query', 'alpha', '--file', 'a.mjs');
  const before = JSON.parse(fs.readFileSync(path.join(f.workspace, '.harness/session.json'), 'utf8')).contextSnapshot;
  fs.writeFileSync(path.join(f.workspace, 'a.mjs'), 'export const alpha = 2;\n');
  assert.equal(validateContextSnapshot({ workspace: f.workspace, snapshot: before, targets: ['a.mjs'], home: cliHarnessHome() }).pass, false);
  const current = f.invoke('--read', '--context-version', '2');
  const session = JSON.parse(fs.readFileSync(path.join(f.workspace, '.harness/session.json'), 'utf8'));
  assert.equal(session.contextSnapshot.evidence[0].sha256, current.evidence[0].sha256);
  assert.equal(validateContextSnapshot({ workspace: f.workspace, snapshot: session.contextSnapshot, targets: ['a.mjs'], home: cliHarnessHome() }).pass, true);
  assert.equal(validateContextSnapshot({ workspace: f.workspace, snapshot: session.contextSnapshot, targets: ['a.mjs'], home: f.copilotHome }).pass, false);
});

test('bare expansion restores the selection from the most recent explicit read', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, 'b.mjs'), 'export const beta = 2;\n');
  f.invoke('--context-version', '2', '--query', 'alpha', '--file', 'a.mjs');
  f.invoke('--read', '--context-version', '2', '--query', 'beta', '--file', 'b.mjs');
  const current = f.invoke('--read', '--context-version', '2');
  assert.deepEqual(current.selection.files, ['b.mjs']);
  assert.equal(current.evidence[0].location, 'b.mjs');
});

test('a crowded contract keeps a complete expansion reference or returns a barrier', () => {
  const body = buildContextPack({
    query: 'repair', recall: [], plans: [],
    planGoal: { intent: 'Repair the selected behavior', constraints: ['Keep all constraints. '.repeat(55)] },
    trust: { state: 'trusted', trusted: true, reason: 'approved' },
    gatePreview: { pass: true },
    repoMapRef: { path: '.harness/repo-map.md', files: 4, totalFiles: 50 },
    nextTools: ['ae verify'],
  });
  assert.ok(Buffer.byteLength(body) <= 2048);
  assert.match(body, /ae orient --read --context-version 2/);
  assert.ok(body.includes('Keep all constraints. '.repeat(55).trim()) || body.includes('Context blocked'));
});
