import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { harnessControlCommand, analyzeTerminalEffects } from '../corpus/hooks/lib/tool-payload.mjs';

const packageRoot = path.resolve(import.meta.dirname, '..');
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-discovery-control-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'), home = path.join(root, 'state'), config = path.join(root, 'config'), skills = path.join(root, 'skills');
  for (const directory of [workspace, home, config, skills]) fs.mkdirSync(directory);
  const bin = path.join(packageRoot, 'bin/ae.mjs');
  const selected = { AE_HOME: home, HARNESS_HOME: home, AE_BIN: bin, HARNESS_BIN: bin, COPILOT_HOME: config, AE_SKILLS_HOME: skills, HARNESS_SKILLS_HOME: skills, AE_HOST: 'claude-code', HARNESS_HOST: 'claude-code' };
  const previous = Object.fromEntries(Object.keys(selected).map(key => [key, process.env[key]]));
  Object.assign(process.env, selected);
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const input = path.join(workspace, 'discovery.json'), roots = ['--workspace', workspace, '--ae-home', home, '--copilot-home', config, '--skills-home', skills, '--json'];
  const argv = (extra = []) => [process.execPath, bin, 'resources', 'discover', ...extra, ...roots];
  const write = value => fs.writeFileSync(input, typeof value === 'string' ? value : JSON.stringify(value));
  return { root, workspace, input, roots, argv, write };
}

test('installed native discovery admits immutable refresh flags and preserves no-file inspection', t => {
  const f = fixture(t);
  for (const flags of [['--refresh'], ['--refresh', '--query', 'enterprise conventions', '--limit', '20']]) {
    assert.equal(harnessControlCommand(f.argv(flags), f.workspace), 'resources');
    const command = f.argv(flags).map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
    assert.equal(analyzeTerminalEffects(command, f.workspace).hasOpaque, false);
  }
  assert.equal(harnessControlCommand(f.argv(), f.workspace), 'resources');
});

test('automatic discovery never admits mutable file input even when initially read-only', t => {
  const f = fixture(t);
  for (const value of [
    { schema: 1, operation: 'scan' }, { schema: 1, operation: 'query', query: 'service' }, { schema: 1, operation: 'status' },
    { schema: 1, operation: 'configure', grants: { decision: true } },
    { schema: 1, operation: 'scan', approved: true },
    { schema: 1, operation: 'scan', provenance: { kind: 'user' } },
    { schema: 1, operation: 'scan', roots: [] },
    { schema: 2, operation: 'scan' }, { schema: 1, operation: 'unknown' },
    { schema: 1, operation: 'query', query: 1 }, { schema: 1, operation: 'scan', query: 'x'.repeat(4001) },
    { schema: 1, operation: 'scan', taskId: '' }, { schema: 1, operation: 'scan', limit: 2001 },
    { schema: 1, operation: 'scan', limit: 0 }, { schema: 1, operation: 'scan', limit: '20' },
    [], 'malformed JSON', `${JSON.stringify({ schema: 1, operation: 'scan' })}${' '.repeat(65536)}`,
  ]) {
    f.write(value);
    for (const flags of [['--file', f.input], ['--refresh', '--file', f.input], [`--file=${f.input}`]]) assert.equal(harnessControlCommand(f.argv(flags), f.workspace), null, JSON.stringify(value).slice(0, 100));
  }
});

test('refresh is specific to discovery and cannot broaden argv, roots or stdin authority', t => {
  const f = fixture(t);
  f.write({ schema: 1, operation: 'scan' });
  const symlink = path.join(f.workspace, 'linked.json'), hardlink = path.join(f.workspace, 'hardlinked.json');
  fs.symlinkSync(f.input, symlink); fs.linkSync(f.input, hardlink);
  for (const file of [symlink, hardlink, f.input, path.join(f.workspace, 'missing.json'), f.workspace, '-']) assert.equal(harnessControlCommand(f.argv(['--refresh', '--file', file]), f.workspace), null);
  for (const extra of [['--yes'], ['--refresh'], ['--unexpected'], ['--ae-home', f.root], ['--refresh=true']]) assert.equal(harnessControlCommand([...f.argv(['--refresh']), ...extra], f.workspace), null);
  assert.equal(harnessControlCommand(['node', ...f.argv(['--refresh']).slice(1)], f.workspace), null);
  assert.equal(harnessControlCommand([process.execPath, path.join(packageRoot, 'bin/ae.mjs'), 'resources', 'decision', '--refresh', '--file', '-', ...f.roots], f.workspace), null);
  f.write({ schema: 1, operation: 'configure' });
  assert.equal(harnessControlCommand(f.argv(['--refresh', '--file', f.input]), f.workspace), null, 'changing a previously benign file cannot change the admitted operation');
  assert.equal(harnessControlCommand(f.argv(['--refresh']), f.workspace), 'resources');
});
