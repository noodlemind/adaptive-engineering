import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parseFlags } from '../lib/flags.mjs';
import { VALUE_FLAGS, positionalsOf, verbOf } from '../lib/positionals.mjs';
import { GLOBAL_FLAGS, getCommand, listCommands } from '../lib/registry.mjs';

const binPath = path.resolve(import.meta.dirname, '..', 'bin', 'ae.mjs');

const SEPARATED_VALUE_FLAGS = [
  '--query', '--phase', '--limit', '--autonomy', '--copilot-home', '--target',
  '--plan', '--base', '--enforcement', '--learnings', '--workspace', '--collection',
  '-c', '--min-score', '--docid', '--path', '--lines', '--max-bytes', '--host',
  '--session', '--title', '--category', '--tags', '--trigger', '--claim', '--body',
  '--body-file', '--ops', '--domain', '--reason', '--to', '--why', '--since',
  '--layer', '--branch', '--ids', '--stale',
];

test('parseFlags: --target with a missing value is a named usage error, never a TypeError', () => {
  assert.throws(() => parseFlags(['--target']), /invalid --target/, 'trailing --target (pre-fix: TypeError from .split)');
  assert.throws(
    () => parseFlags(['install', '--target', '--', 'x']),
    /invalid --target/,
    'the boundary slice legitimately removes the value — the parser must say so, not crash'
  );
  assert.throws(() => parseFlags(['--target', '--json']), /invalid --target/, 'a flag-shaped next token is a missing value, not a target list');
  assert.throws(() => parseFlags(['--target=']), /invalid --target/, 'the inline form with an empty value is the same missing value');
});

test('parseFlags: every previously-working --target form still parses identically', () => {
  assert.deepEqual([...parseFlags(['--target', 'cli']).targets], ['cli']);
  assert.deepEqual([...parseFlags(['--target', 'vscode, intellij']).targets], ['vscode', 'intellij'], 'whitespace is still trimmed');
  assert.deepEqual([...parseFlags(['--target=cli,vscode']).targets], ['cli', 'vscode']);
  assert.deepEqual([...parseFlags(['upgrade', '--target', 'cli', '--json']).targets], ['cli']);
  assert.deepEqual([...parseFlags([]).targets], ['vscode', 'cli', 'intellij'], 'the default target set is untouched');
});

test('parseFlags: no separated value flag throws a raw TypeError when its value is missing', () => {
  for (const flag of SEPARATED_VALUE_FLAGS) {
    try {
      parseFlags([flag]);
    } catch (error) {
      assert.equal(
        error instanceof TypeError,
        false,
        `${flag} with a missing value threw a TypeError (E_UNEXPECTED at the CLI): ${error.message}`
      );
      assert.match(error.message, /^invalid /, `${flag} must fail with the package's named flag error: ${error.message}`);
    }
  }
});

test('CLI: `install --target` names the flag instead of reporting an undefined-property crash', () => {
  const result = spawnSync(process.execPath, [binPath, 'install', '--target', '--json'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  const body = JSON.parse(result.stderr.trim());
  assert.match(body.error.message, /invalid --target/, 'pre-fix: "Cannot read properties of undefined (reading \'split\')"');
});

// --- registry / positionals contracts (folded from review souvenirs) ------

test('the value-flag set covers every non-boolean flag the registry declares', () => {
  const declared = new Set();
  for (const f of GLOBAL_FLAGS) if (f.type !== 'boolean') { declared.add(f.name); (f.aliases || []).forEach((a) => declared.add(a)); }
  for (const n of listCommands()) {
    for (const f of getCommand(n).args?.flags || []) {
      if (f.type !== 'boolean') { declared.add(f.name); (f.aliases || []).forEach((a) => declared.add(a)); }
    }
  }
  const missing = [...declared].filter((n) => !VALUE_FLAGS.has(n));
  assert.deepEqual(missing, [], 'a value flag missing from the set means its value is read as a positional');
});

test('the value-flag set covers every flag parseFlags reads a value for', () => {
  const consumes = (name) => ['SENTINEL', '7'].some((v) => {
    try { return JSON.stringify(parseFlags([name, v]) ?? {}).includes(v); } catch { return true; }
  });
  const candidates = ['--target', '--since', '--until', '--ids', '--branch', '--why', '--query', '--plan', '--host', '--limit', '--collection'];
  const missing = candidates.filter((n) => consumes(n) && !VALUE_FLAGS.has(n));
  assert.deepEqual(missing, []);
});

test('host path flags do not become positional arguments or verbs', () => {
  for (const flag of ['--skills-home', '--config-home', '--host-home', '--output-directory']) {
    assert.deepEqual(positionalsOf([flag, '/native host', 'setup']), ['setup'], flag);
    assert.deepEqual(positionalsOf([`${flag}=/native host`, 'setup', 'sample']), ['setup', 'sample'], flag);
    assert.equal(verbOf([flag, '/native host', 'setup'], ['list', 'setup']), 'setup', flag);
  }
});

test('a boolean flag never consumes the token after it', () => {
  assert.deepEqual(positionalsOf(['--json', 'list']), ['list']);
  assert.deepEqual(positionalsOf(['--verbose', 'run', 'slow']), ['run', 'slow']);
  assert.deepEqual(positionalsOf(['-v', 'list']), ['list'], 'short flags too — `-v` does not start with `--`');
  assert.deepEqual(positionalsOf(['--no-events', 'approve']), ['approve']);
  assert.deepEqual(positionalsOf(['--status', 'succeeded', 'list']), ['list']);
  assert.deepEqual(positionalsOf(['--limit=5', 'list']), ['list']);
  assert.deepEqual(positionalsOf(['show', 'abc', '--', '--json']), ['show', 'abc'], 'nothing after `--` belongs to us');
});

test('verbOf matches a known verb wherever it appears, rather than guessing by position', () => {
  assert.equal(verbOf(['--json', 'approve'], ['status', 'approve', 'revoke'], { fallback: 'status' }), 'approve');
  assert.equal(verbOf(['--verbose', 'revoke'], ['status', 'approve', 'revoke'], { fallback: 'status' }), 'revoke');
  assert.equal(verbOf([], ['status', 'approve'], { fallback: 'status' }), 'status');
  assert.equal(verbOf(['frobnicate'], ['status'], { fallback: 'status' }), 'frobnicate');
});

test('an invalid verb is not skipped in favour of a later valid one', () => {
  assert.equal(verbOf(['frobnicate', 'approve'], ['status', 'approve', 'revoke'], { fallback: 'status' }), 'frobnicate',
    'a typo must not become a security mutation');
  assert.equal(verbOf(['--json', 'approve'], ['status', 'approve', 'revoke'], { fallback: 'status' }), 'approve');
});

test('a value flag cannot swallow the `--` boundary', () => {
  assert.deepEqual(positionalsOf(['--status', '--', 'resume', 'abc']), [],
    '`--` must not be read as a flag value');
  assert.deepEqual(positionalsOf(['--status', 'ok', 'list']), ['list'], 'a real value is still consumed');
});

test('every declared flag name is a single flag, not a comma-joined string', () => {
  const bad = [];
  for (const n of listCommands()) {
    for (const f of getCommand(n).args?.flags || []) {
      if (/[,\s]/.test(f.name)) bad.push(`${n}: ${JSON.stringify(f.name)}`);
    }
  }
  assert.deepEqual(bad, [],
    'a name like "-c, --collection" registers one flag with a comma in it');
});
