import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GLOBAL_FLAGS, getCommand, listCommands } from '../lib/registry.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpus = path.join(packageRoot, 'corpus');
const lib = path.join(packageRoot, 'lib');

const DENIED = new Set([
  'rg', 'ripgrep', 'grep', 'egrep', 'fgrep', 'find', 'sed', 'awk', 'jq', 'xargs',
  'python', 'python3', 'perl', 'curl', 'wget', 'bash', 'sh', 'zsh', 'pwsh', 'powershell',
  'which', 'where', 'taskkill', 'ps',
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(mjs|md)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function tokens(input) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of String(input).matchAll(re)) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

function flagNames(command) {
  const names = new Set(['--help', '-h']);
  for (const flag of [...GLOBAL_FLAGS, ...(command.args?.flags || [])]) {
    names.add(flag.name);
    for (const alias of flag.aliases || []) names.add(alias);
  }
  return names;
}

function flagType(command, name) {
  return [...GLOBAL_FLAGS, ...(command.args?.flags || [])].find((flag) => flag.name === name || (flag.aliases || []).includes(name))?.type;
}

function checkInvocation(raw) {
  const parts = tokens(raw).filter((part) => !part.startsWith('#'));
  if (parts[0] !== 'ae' || parts.length < 2) return null;
  if (parts[1] === '--version' || parts[1] === '-V') return null;
  if (parts[1] === 'help') {
    const subject = parts[2];
    if (subject && subject !== '<command>' && !subject.startsWith('-') && !getCommand(subject)) {
      return `unknown command in \`${raw}\``;
    }
    return null;
  }
  const command = getCommand(parts[1]);
  if (!command) return `unknown command in \`${raw}\``;
  const known = flagNames(command);
  const verbs = new Set((command.verbs || []).map((verb) => verb.verb || verb.name || verb));
  let index = 2;
  if (verbs.size && parts[index] && !parts[index].startsWith('-') && verbs.has(parts[index])) index += 1;
  while (index < parts.length) {
    const token = parts[index];
    if (token === '--') break;
    if (token === '-' || !token.startsWith('-')) {
      index += 1;
      continue;
    }
    const name = token.split('=')[0];
    if (!known.has(name)) return `${name} is not a flag of ae ${command.name} in \`${raw}\``;
    if (!token.includes('=') && flagType(command, name) !== 'boolean') {
      const next = parts[index + 1];
      if (next && (next === '-' || !next.startsWith('-'))) index += 1;
    }
    index += 1;
  }
  return null;
}

test('corpus invocation validation accepts version metadata and retains unknown-command refusals', () => {
  assert.equal(checkInvocation('ae --version'), null);
  assert.equal(checkInvocation('ae -V'), null);
  assert.match(checkInvocation('ae --versoin'), /unknown command/);
  assert.match(checkInvocation('ae nonexistent-command'), /unknown command/);
  assert.match(checkInvocation('ae orient --nonexistent-flag'), /not a flag/);
});

test('library code spawns only git or node', () => {
  const problems = [];
  const literal = /\b(?:spawnSync|spawn|execFileSync|execSync|execFile)\(\s*(['"`])([^'"`]+)\1/g;
  for (const file of walk(lib).filter((full) => full.endsWith('.mjs'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(literal)) {
      // Both process owners use a fixed argv Windows descendant cleanup;
      // neither exposes command selection or shell execution to callers.
      const windowsTreeKill = match[2] === 'taskkill' && [
        path.join(lib, 'runner.mjs'), path.join(lib, 'hosts', 'mcp-server.mjs'),
      ].includes(file);
      if (match[2] !== 'git' && !windowsTreeKill) problems.push(`${path.relative(packageRoot, file)} spawns ${match[2]}`);
    }
    if (/\b(?:which|where|taskkill|powershell|pwsh)\b/.test(text) && !text.includes('Do not')) {
      // Comments may name a removed tool. A call does not.
    }
  }
  assert.deepEqual(problems, []);
  const hooks = walk(path.join(corpus, 'hooks')).filter((full) => full.endsWith('.mjs'));
  for (const file of hooks) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(literal)) {
      if (match[2] !== 'git') problems.push(`${path.relative(packageRoot, file)} spawns ${match[2]}`);
    }
    if (/spawn(?:Sync)?\(\s*['"]ae['"]/.test(text)) problems.push(`${path.relative(packageRoot, file)} spawns an ae shell shim`);
  }
  assert.deepEqual(problems, []);
});

test('corpus commands do not require an external CLI', () => {
  const problems = [];
  for (const file of walk(corpus).filter((full) => full.endsWith('.md'))) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (/do not|never |must not|without /i.test(line)) continue;
      for (const match of line.matchAll(/`([^`\n]+)`/g)) {
        const first = tokens(match[1])[0];
        const hostAlias = tokens(match[1]).length === 1 && /execute|shell|host tool/i.test(line);
        if (DENIED.has(first) && !hostAlias) problems.push(`${path.relative(corpus, file)}: ${match[1]}`);
      }
      if (/<<'/.test(line)) problems.push(`${path.relative(corpus, file)} uses a shell heredoc`);
    }
    for (const match of text.matchAll(/`ae [^`\n]+`/g)) {
      const problem = checkInvocation(match[0].slice(1, -1));
      if (problem) problems.push(`${path.relative(corpus, file)}: ${problem}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(listCommands().includes('search'));
  assert.ok(getCommand('get').args.flags.some((flag) => flag.name === '--reference'));
});
