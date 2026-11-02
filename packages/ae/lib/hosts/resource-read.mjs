import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileNoFollow } from '../fs-safe.mjs';
import { safeResolveUnderRoot } from '../path-safe.mjs';
import { validatePrimitiveContent } from '../resource-validation.mjs';
import { runHostSetup } from './setup.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const fail = message => Object.assign(new Error(message), { code: 'E_TARGET', exit: 1 });

/** Native discovery and asset validation, separate from Copilot registration. */
export function nativeResourceRead({ verb, target, configHome, skillsHome }) {
  const raw = readFileNoFollow(path.join(configHome, '.ae-host.json'), { root: configHome, maxBytes: 1024 * 1024 });
  let manifest;
  try { manifest = JSON.parse(raw); } catch { throw fail('Native resource reads require a current host setup binding'); }
  const status = runHostSetup({ verb: 'status', host: manifest.host, configHome, skillsHome });
  if (status.status !== 'ok') throw fail(status.reason || 'Native host ownership cannot be validated');
  const primitives = [];
  for (const entry of fs.readdirSync(skillsHome, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) continue;
    const rel = `${entry.name}/SKILL.md`, full = safeResolveUnderRoot(skillsHome, rel);
    const text = full ? readFileNoFollow(full, { root: skillsHome, maxBytes: 65536 }) : null;
    if (text === null) {
      // Shared reference directories are not skills. Existing unsafe/unreadable
      // SKILL.md candidates must remain visible as validation failures.
      try { fs.lstatSync(path.join(skillsHome, rel)); } catch (error) { if (error.code === 'ENOENT') continue; }
      primitives.push({ kind: 'skill', type: 'skill', name: entry.name, path: `skills/${rel}`, nativePath: full,
        state: 'invalid', valid: false, errors: ['SKILL.md is missing, unreadable, unsafe or exceeds 65536 bytes'], digest: null, text: null });
      continue;
    }
    const validation = validatePrimitiveContent({ type: 'skill', name: entry.name, text, root: skillsHome, rel });
    primitives.push({ kind: 'skill', type: 'skill', name: entry.name, path: `skills/${rel}`, nativePath: full,
      state: validation.valid ? 'discovered' : 'invalid', valid: validation.valid, errors: validation.errors, digest: `sha256-${hash(text)}`, text });
  }
  for (const file of manifest.files) {
    const kind = file.root === 'config' && file.path.startsWith('agents/') ? 'agent' : file.root === 'config' && file.path.startsWith('rules/') ? 'instruction' : null;
    if (!kind) continue;
    const full = safeResolveUnderRoot(configHome, file.path), text = full ? readFileNoFollow(full, { root: configHome, maxBytes: 65536 }) : null;
    const valid = text !== null && hash(text) === file.sha256;
    primitives.push({ kind, type: kind, path: file.path, nativePath: full, state: valid ? 'managed' : 'modified-or-missing', valid, digest: text === null ? null : `sha256-${hash(text)}`, text });
  }
  const base = { schema: 1, verb, home: configHome, skillsHome, nativeQualification: 'unverified', assurance: 'Native skill format and managed asset bytes; file presence is not native invocation proof' };
  if (verb === 'show') {
    const item = primitives.find(item => item.path === target || item.nativePath === target || item.kind === 'skill' && item.name === target);
    if (!item) throw fail('No selected native resource matches that path or skill name');
    return { ...base, status: 'ok', primitive: item };
  }
  const invalid = primitives.filter(item => !item.valid);
  return { ...base, status: verb === 'validate' && (invalid.length || status.assetState !== 'current') ? 'failed' : 'ok',
    counts: { total: primitives.length, invalid: invalid.length, skill: primitives.filter(item => item.kind === 'skill').length, agent: primitives.filter(item => item.kind === 'agent').length, instruction: primitives.filter(item => item.kind === 'instruction').length },
    primitives: primitives.map(({ text, ...item }) => item), assetState: status.assetState };
}
