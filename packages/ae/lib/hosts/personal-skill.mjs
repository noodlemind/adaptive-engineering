import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertNoSymlinkAncestors, readFileNoFollow, writeFileContained } from '../fs-safe.mjs';
import { validatePrimitiveContent } from '../resource-validation.mjs';
import { withPlanUpdateLock } from '../plan-update.mjs';

const fail = message => Object.assign(new Error(message), { code: 'E_USAGE', exit: 2, hint: 'ae host status --host <host>; ae help resources' });
const digest = text => `sha256-${createHash('sha256').update(text).digest('hex')}`;
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const ROOTS = new Set(['config', 'skills']);

function safeRoot(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) throw fail(`${label} must be an absolute path`);
  const full = path.resolve(value), base = path.parse(full).root;
  if (!assertNoSymlinkAncestors(base, path.relative(base, full)) || !fs.lstatSync(full, { throwIfNoEntry: false })?.isDirectory()) throw fail(`Host setup binding is absent or redirected: ${label}`);
  return full;
}

function readObject(root, relative) {
  if (!assertNoSymlinkAncestors(root, relative)) throw fail('Host setup binding is unsafe or redirected');
  const text = readFileNoFollow(path.join(root, relative), { root, maxBytes: 1024 * 1024 });
  if (text === null) throw fail('A current host setup binding is required for personal skills');
  try {
    const value = JSON.parse(text);
    if (isObject(value)) return value;
  } catch { /* Report the same bounded invalid binding below. */ }
  throw fail('Host setup binding is malformed');
}

function checkBinding(configHome, skillsHome, name) {
  const manifest = readObject(configHome, '.ae-host.json');
  const owner = readObject(skillsHome, '.ae-host-skills.json');
  if (manifest.schema !== 1 || !['claude-code', 'codex', 'cursor', 'terminal'].includes(manifest.host) || manifest.configHome !== configHome || manifest.skillsHome !== skillsHome || !Array.isArray(manifest.files) || owner.schema !== 1 || owner.host !== manifest.host || owner.configHome !== configHome || owner.skillsHome !== skillsHome) throw fail('Selected roots do not match the saved host setup binding');
  for (const file of manifest.files) {
    if (!isObject(file) || !ROOTS.has(file.root) || typeof file.path !== 'string' || path.isAbsolute(file.path) || file.path.includes('\\') || file.path.split('/').some(part => !part || part === '.' || part === '..') || typeof file.owned !== 'boolean' || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) throw fail('Host setup ownership is malformed');
    if (file.root === 'skills' && file.path.startsWith(`${name}/`)) throw fail(`${name} is a setup-managed shipped skill; personal writes cannot replace it`);
  }
}

/** Create only a personal native skill; setup retains authority over shipped assets. */
export function createHostSkill({ configHome, skillsHome, name, input, dryRun = false }) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name || '')) throw fail('Personal skill name must be canonical kebab-case');
  if (!isObject(input) || input.schema !== 1 || Object.keys(input).some(key => !['schema', 'text', 'expectedDigest'].includes(key))) throw fail('Personal skill input requires schema 1, text and optional expectedDigest');
  if (input.expectedDigest !== undefined && !/^sha256-[a-f0-9]{64}$/.test(input.expectedDigest)) throw fail('Personal skill expectedDigest must be a sha256 digest');
  const config = safeRoot(configHome, 'configHome'), skills = safeRoot(skillsHome, 'skillsHome');
  const relative = `${name}/SKILL.md`, full = path.join(skills, relative);
  const perform = () => {
    checkBinding(config, skills, name);
    if (!assertNoSymlinkAncestors(skills, relative)) throw fail('Personal skill destination is unsafe or redirected');
    const validation = validatePrimitiveContent({ type: 'skill', name, text: input.text, root: skills, rel: relative });
    if (!validation.valid) throw fail(validation.errors.join('; '));
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    const prior = stat ? readFileNoFollow(full, { root: skills, maxBytes: 65536 }) : null;
    if (stat && prior === null) throw fail('Existing personal skill is unsafe or unreadable');
    const previousDigest = prior === null ? null : digest(prior);
    if (input.expectedDigest !== undefined && previousDigest !== input.expectedDigest) throw fail('Expected personal skill bytes are stale');
    if (prior !== null && prior !== input.text && input.expectedDigest === undefined) throw fail('Replacing a personal skill requires its expectedDigest');
    const changed = prior !== input.text;
    if (!dryRun && changed) {
      // Repeat the byte check immediately before publication under both locks.
      const current = fs.lstatSync(full, { throwIfNoEntry: false }) ? readFileNoFollow(full, { root: skills, maxBytes: 65536 }) : null;
      if (current !== prior) throw fail('Personal skill changed before publication; inspect and retry');
      if (!writeFileContained(skills, relative, input.text, { exclusive: prior === null, mode: 0o600 })) throw fail('Personal skill publication was refused; inspect the selected destination');
    }
    return {
      schema: 1, verb: 'create', status: 'ok', exitCode: 0, validation, dryRun: Boolean(dryRun),
      primitive: { path: full, name, kind: 'skill', digest: digest(input.text), state: dryRun ? 'preview' : !changed ? 'unchanged' : prior === null ? 'created' : 'replaced' },
      activated: !dryRun && changed,
    };
  };
  if (dryRun) return perform();
  // Share setup/remove's ownership lock, then serialize the selected resource.
  const lock = path.join(skills, '.ae-host-skills.lock');
  if (!assertNoSymlinkAncestors(skills, '.ae-host-skills.lock')) throw fail('Personal skill ownership lock is unsafe');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw fail('Host skills are being updated; retry after setup or removal finishes'); throw error; }
  try { return withPlanUpdateLock(path.join(skills, `.ae-personal-${name}`), perform); }
  finally { fs.rmdirSync(lock); }
}
