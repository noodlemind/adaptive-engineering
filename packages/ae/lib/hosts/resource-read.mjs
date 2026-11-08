import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileNoFollow } from '../fs-safe.mjs';
import { safeResolveUnderRoot } from '../path-safe.mjs';
import { validatePrimitiveContent } from '../resource-validation.mjs';
import { runHostSetup } from './setup.mjs';
import { inspectNativeResource } from './native-resource.mjs';
import { readPersonalResources } from './personal-resource.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const fail = message => Object.assign(new Error(message), { code: 'E_TARGET', exit: 1 });

/** Native discovery and asset validation, separate from Copilot registration. */
export function nativeResourceRead({ verb, target, configHome, skillsHome }) {
  const raw = readFileNoFollow(path.join(configHome, '.ae-host.json'), { root: configHome, maxBytes: 1024 * 1024 });
  let manifest;
  try { manifest = JSON.parse(raw); } catch { throw fail('Native resource reads require a current host setup binding'); }
  const status = runHostSetup({ verb: 'status', host: manifest.host, configHome, skillsHome });
  if (status.status !== 'ok') throw fail(status.reason || 'Native host ownership cannot be validated');
  const personal = readPersonalResources({ configHome, skillsHome, host: manifest.host });
  const primitives = [];
  const omissions = { resources: 0 };
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
  const seen = new Set();
  for (const file of manifest.files) {
    const kind = file.root === 'config' && file.path.startsWith('agents/') ? 'agent' : file.root === 'config' && file.path.startsWith('rules/') ? 'instruction' : null;
    if (!kind) continue;
    const full = safeResolveUnderRoot(configHome, file.path), text = full ? readFileNoFollow(full, { root: configHome, maxBytes: 65536 }) : null;
    const valid = text !== null && hash(text) === file.sha256;
    const name = path.basename(file.path).replace(/\.(?:md|mdc|toml)$/, '');
    seen.add(file.path);
    primitives.push({ kind, type: kind, name, path: file.path, nativePath: full, state: valid ? 'managed' : 'modified-or-missing', valid, digest: text === null ? null : `sha256-${hash(text)}`, text });
  }
  for (const [directory, kind] of [['agents', 'agent'], ['rules', 'instruction'], ['instructions', 'instruction']]) {
    let entries;
    const directoryPath = safeResolveUnderRoot(configHome, directory);
    if (!directoryPath) throw fail(`Native resource directory is unsafe or redirected: ${directory}`);
    try { entries = fs.readdirSync(directoryPath, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw fail(`Native resource directory is unreadable: ${directory}`); }
    if (entries.length > 256) omissions.resources += entries.length - 256;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 256)) {
      const expectedExtension = kind === 'agent' && manifest.host === 'codex' ? '.toml' : directory === 'rules' && manifest.host === 'cursor' ? '.mdc' : '.md';
      if (!entry.name.endsWith(expectedExtension)) continue;
      const name = entry.name.slice(0, -expectedExtension.length);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) continue;
      const relative = `${directory}/${entry.name}`;
      if (seen.has(relative)) continue;
      const full = safeResolveUnderRoot(configHome, relative), text = full ? readFileNoFollow(full, { root: configHome, maxBytes: 65536 }) : null;
      const validation = inspectNativeResource({ host: manifest.host, type: kind, name, text });
      const record = personal.resources[`${kind}:${name}`];
      const digest = text === null ? null : `sha256-${hash(text)}`;
      if (record && (record.path !== relative || record.digest !== digest)) validation.errors.push('Native bytes differ from the recorded personal source binding');
      const valid = !validation.errors.length;
      primitives.push({ kind, type: kind, name, path: relative, nativePath: full, state: valid ? record ? 'personal' : 'discovered' : 'invalid', valid, errors: validation.errors, digest,
        ...(record ? { sourceDigest: record.sourceDigest, sourceText: record.sourceText, activation: record.activation } : {}),
        nativeQualification: 'unverified', text });
    }
  }
  const base = { schema: 1, verb, home: configHome, skillsHome, nativeQualification: 'unverified', omissions, assurance: 'Native skill format and managed asset bytes; file presence is not native invocation proof' };
  if (verb === 'show') {
    const matches = primitives.filter(item => item.path === target || item.nativePath === target || item.name === target);
    if (matches.length > 1) throw fail('Native resource name is ambiguous; select its exact path');
    const item = matches[0];
    if (!item) throw fail('No selected native resource matches that path or name');
    return { ...base, status: 'ok', primitive: item };
  }
  const invalid = primitives.filter(item => !item.valid);
  return { ...base, status: verb === 'validate' && (invalid.length || status.assetState !== 'current') ? 'failed' : 'ok',
    counts: { total: primitives.length, invalid: invalid.length, skill: primitives.filter(item => item.kind === 'skill').length, agent: primitives.filter(item => item.kind === 'agent').length, instruction: primitives.filter(item => item.kind === 'instruction').length },
    primitives: primitives.map(({ text, sourceText, ...item }) => item), assetState: status.assetState };
}
