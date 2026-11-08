import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { assertNoSymlinkAncestors, writeFileContained } from './fs-safe.mjs';

export const REGISTERED_FILE = path.join('harness', 'registered.yaml');
export const REGISTRY_SCHEMA = 1;

/** The directories a user may drop a primitive into, and what shape each
 * expects. Closed: a kind the harness cannot validate is one it should not
 * claim to have registered. */
export const PRIMITIVE_KINDS = Object.freeze({
  skills: { dir: 'skills', match: /^skills\/[^/]+\/SKILL\.md$/, describe: 'skills/<name>/SKILL.md' },
  agents: { dir: 'agents', match: /^agents\/[^/]+\.agent\.md$/, describe: 'agents/<name>.agent.md' },
  instructions: { dir: 'instructions', match: /^instructions\/[^/]+\.instructions\.md$/, describe: 'instructions/<name>.instructions.md' },
});

export function registeredPath(copilotHome) {
  return path.join(copilotHome, REGISTERED_FILE);
}

function walk(root, base = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(root, entry.name), rel));
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(rel);
  }
  return out;
}

export function fileDigest(full) {
  try {
    return `sha256-${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
  } catch {
    return null;
  }
}

export function readPrimitiveOnce(copilotHome, rel) {
  const full = path.join(copilotHome, rel);
  const stat = fs.lstatSync(full);
  if (stat.isSymbolicLink()) {
    throw Object.assign(new Error(`${rel}: is a symlink`), { code: 'E_TARGET', exit: 1 });
  }
  if (!stat.isFile()) {
    throw Object.assign(new Error(`${rel}: is not a regular file`), { code: 'E_TARGET', exit: 1 });
  }
  const bytes = fs.readFileSync(full);
    return { bytes, text: bytes.toString('utf8'), digest: `sha256-${crypto.createHash('sha256').update(bytes).digest('hex')}` };
}

export function isCanonicalPrimitive(rel) {
  const kind = primitiveKind(rel);
  return Boolean(kind && kind.match.test(rel));
}

function primitiveKind(rel) {
  const key = Object.keys(PRIMITIVE_KINDS).find((k) => rel.startsWith(`${PRIMITIVE_KINDS[k].dir}/`));
  return key ? { key, ...PRIMITIVE_KINDS[key] } : null;
}

export function validatePrimitive(copilotHome, rel, snapshot = null) {
  const errors = [];
  const kindInfo = primitiveKind(rel);
  const kindKey = kindInfo?.key ?? null;
  const kind = kindInfo;
  if (!kind) return { valid: false, kind: null, name: null, errors: [`${rel}: not under a primitive directory`] };
  if (!kind.match.test(rel)) {
    errors.push(`${rel}: a ${kindKey.replace(/s$/, '')} must be ${kind.describe} — a file elsewhere is never discovered`);
  }

    let text = '';
  let digest = null;
  try {
    const read = snapshot || readPrimitiveOnce(copilotHome, rel);
    text = read.text;
    digest = read.digest;
  } catch (error) {
    return { valid: false, kind: kindKey, name: null, digest: null, errors: [`${rel}: unreadable (${error.code || error.message})`] };
  }

  // Frontmatter: the host reads it to learn the primitive exists at all.
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) {
    errors.push(`${rel}: no YAML frontmatter — the host cannot discover a primitive without it`);
    return { valid: false, kind: kindKey, name: null, digest, errors };
  }
  let front;
  try {
    front = YAML.parse(match[1], { maxAliasCount: 50 });
  } catch (error) {
    errors.push(`${rel}: frontmatter is not valid YAML (${error.message})`);
    return { valid: false, kind: kindKey, name: null, digest, errors };
  }
  if (!front || typeof front !== 'object' || Array.isArray(front)) {
    errors.push(`${rel}: frontmatter must be a mapping`);
    return { valid: false, kind: kindKey, name: null, digest, errors };
  }
  const name = typeof front.name === 'string' ? front.name.trim() : '';
  if (!name) errors.push(`${rel}: frontmatter needs a name`);

    const onDisk = kindKey === 'skills'
    ? rel.split('/')[1]
    : path.basename(rel).replace(/\.(agent|instructions)\.md$/, '');
  if (name && onDisk && name !== onDisk) {
    errors.push(`${rel}: frontmatter name ${JSON.stringify(name)} does not match its path (${onDisk})`);
  }

  return { valid: errors.length === 0, kind: kindKey, name: name || null, digest, errors };
}

function readRegistry(copilotHome) {
  const file = registeredPath(copilotHome);
  if (!fs.existsSync(file)) return { version: REGISTRY_SCHEMA, primitives: {} };
  try {
    const doc = YAML.parse(fs.readFileSync(file, 'utf8'), { maxAliasCount: 50 });
    const primitives = doc?.primitives;
    if (!primitives || typeof primitives !== 'object' || Array.isArray(primitives)) {
      return { version: REGISTRY_SCHEMA, primitives: {}, unreadable: true };
    }
    return { version: doc.version || REGISTRY_SCHEMA, primitives };
  } catch {
    return { version: REGISTRY_SCHEMA, primitives: {}, unreadable: true };
  }
}

function writeRegistry(copilotHome, registry) {
  const written = writeFileContained(copilotHome, REGISTERED_FILE, YAML.stringify(registry));
  if (!written) {
    throw Object.assign(new Error(`could not write ${registeredPath(copilotHome)}`), {
      code: 'E_TARGET',
      exit: 1,
      hint: 'the path is not writable, or an ancestor is a symlink out of the home directory',
    });
  }
  return written;
}

export function classifyPrimitives({ copilotHome, shippedFiles = new Set(), lockFiles = new Set() }) {
  const out = { shipped: [], orphan: [], local: [] };
  for (const key of Object.keys(PRIMITIVE_KINDS)) {
    const dir = PRIMITIVE_KINDS[key].dir;
    for (const file of walk(path.join(copilotHome, dir))) {
      const rel = `${dir}/${file}`;
      if (shippedFiles.has(rel)) out.shipped.push(rel);
      else if (lockFiles.has(rel)) out.orphan.push(rel);
      else out.local.push(rel);
    }
  }
  return out;
}

export function localPrimitiveStatus({ copilotHome, shippedFiles = new Set(), lockFiles = new Set() }) {
  const registry = readRegistry(copilotHome);
  const { local } = classifyPrimitives({ copilotHome, shippedFiles, lockFiles });
  return local.map((rel) => {
    const validation = validatePrimitive(copilotHome, rel);
    const record = registry.primitives[rel] || null;
    const digest = fileDigest(path.join(copilotHome, rel));
    let state = 'pending';
    let reason = 'found but not registered — `ae resources register` after reading it';
    if (!isCanonicalPrimitive(rel)) {
      state = 'stray';
      reason = 'not a canonical skill, agent, or instruction file — `ae resources discard` removes it';
    } else if (!validation.valid) {
      state = 'invalid';
      reason = validation.errors[0];
    } else if (registry.unreadable) {
      reason = 'the registration store could not be read, so nothing counts as registered';
    } else if (record) {
      if (record.digest === digest) {
        state = 'registered';
        reason = `registered ${record.registeredAt}`;
      } else {
        state = 'stale';
        reason = 'changed since it was registered — read it again, then re-register';
      }
    }
    return { path: rel, kind: validation.kind, name: validation.name, state, reason, digest, errors: validation.errors };
  });
}

const CREATE_KINDS = Object.freeze({
  skill: (name) => `skills/${name}/SKILL.md`,
  agent: (name) => `agents/${name}.agent.md`,
  instruction: (name) => `instructions/${name}.instructions.md`,
});

const CREATE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function createPersonalPrimitive({
  copilotHome,
  kind,
  name,
  text,
  shippedFiles = new Set(),
  lockFiles = new Set(),
  now = new Date().toISOString(),
  validatePublication,
  activation,
}) {
  if (!Object.prototype.hasOwnProperty.call(CREATE_KINDS, kind)) {
    throw Object.assign(new Error(`unknown primitive kind: ${JSON.stringify(kind)}`), {
      code: 'E_USAGE',
      exit: 2,
      hint: 'ae resources create <skill|agent|instruction> <name>',
    });
  }
  if (typeof name !== 'string' || !CREATE_NAME.test(name)) {
    throw Object.assign(new Error(`invalid primitive name: ${JSON.stringify(name)}`), {
      code: 'E_USAGE',
      exit: 2,
      hint: 'ae resources create <skill|agent|instruction> <name>',
    });
  }
  const rel = CREATE_KINDS[kind](name);
  if (shippedFiles.has(rel) || lockFiles.has(rel)) {
    throw Object.assign(new Error(`${rel} is shipped with the harness`), {
      code: 'E_TARGET',
      exit: 1,
      hint: 'a skill for every install is a commit under packages/ae/corpus',
    });
  }
  const bytes = Buffer.from(String(text ?? ''), 'utf8');
  const digest = `sha256-${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  const validation = validatePrimitive(copilotHome, rel, { text: bytes.toString('utf8'), digest, bytes });
  if (!validation.valid) {
    throw Object.assign(new Error(validation.errors[0]), {
      code: 'E_USAGE',
      exit: 2,
      hint: 'ae resources create <skill|agent|instruction> <name>',
    });
  }
  const full = assertNoSymlinkAncestors(copilotHome, rel);
  if (!full) {
    throw Object.assign(new Error(`refusing to write ${rel}: path escapes the Copilot home or is a symlink`), {
      code: 'E_TARGET',
      exit: 1,
    });
  }
  let stat = null;
  try {
    stat = fs.lstatSync(full);
  } catch {
    stat = null;
  }
  if (stat?.isSymbolicLink()) {
    throw Object.assign(new Error(`refusing to write ${rel}: is a symlink`), { code: 'E_TARGET', exit: 1 });
  }
  if (stat && !stat.isFile()) {
    throw Object.assign(new Error(`refusing to write ${rel}: is not a regular file`), { code: 'E_TARGET', exit: 1 });
  }
  if (stat?.isFile()) {
    const current = readPrimitiveOnce(copilotHome, rel);
    if (current.digest === digest) {
      const registry = readRegistry(copilotHome);
      const record = registry.primitives?.[rel];
      if (!registry.unreadable && record?.digest === digest) {
        return { path: rel, state: 'unchanged', kind: validation.kind, name: validation.name };
      }
      const registered = registerPrimitive({ copilotHome, rel, now, shippedFiles, lockFiles, validatePublication, activation });
      return { ...registered, state: 'registered' };
    }
  }
  validatePublication?.('before-source');
  const written = writeFileContained(copilotHome, rel, bytes.toString('utf8'));
  if (!written) {
    throw Object.assign(new Error(`could not write ${rel}`), {
      code: 'E_TARGET',
      exit: 1,
      hint: 'the path is not writable, or an ancestor is a symlink out of the home directory',
    });
  }
  validatePublication?.('after-source');
  const registered = registerPrimitive({ copilotHome, rel, now, shippedFiles, lockFiles, validatePublication, activation });
  return { ...registered, state: stat?.isFile() ? 'replaced' : 'created' };
}

export function registerPrimitive({ copilotHome, rel, now = new Date().toISOString(), shippedFiles = new Set(), lockFiles = new Set(), validatePublication, activation }) {
  const { local } = classifyPrimitives({ copilotHome, shippedFiles, lockFiles });
  if (!local.includes(rel)) {
    throw Object.assign(new Error(`not a locally-added primitive: ${rel}`), {
      code: 'E_NOT_FOUND',
      exit: 9,
      hint: 'ae resources list — only files the harness did not ship can be registered',
    });
  }
    let snapshot;
  try {
    snapshot = readPrimitiveOnce(copilotHome, rel);
  } catch (error) {
    throw Object.assign(new Error(`refusing to register ${rel}: ${error.message}`), {
      code: error.code || 'E_TARGET',
      exit: error.exit || 1,
      hint: 'registration pins content, which requires a regular file it can read once',
    });
  }
  const validation = validatePrimitive(copilotHome, rel, snapshot);
  if (!validation.valid) {
    throw Object.assign(new Error(`refusing to register an invalid primitive: ${validation.errors[0]}`), {
      code: 'E_USAGE',
      exit: 2,
      hint: `fix it, then: ae resources register ${rel}`,
    });
  }
  validatePublication?.('before-registry');
  const registry = readRegistry(copilotHome);
  if (registry.unreadable) {
    throw Object.assign(new Error('refusing to write over an unreadable registration store'), {
      code: 'E_TARGET',
      exit: 1,
      hint: `inspect ${registeredPath(copilotHome)} by hand — overwriting it would discard every registration it holds`,
    });
  }
  registry.version = REGISTRY_SCHEMA;
  const previous = registry.primitives[rel];
  const retainedActivation = previous?.activation
    ? previous.digest === snapshot.digest ? previous.activation : { state: 'pending-reload', reason: 'Registered source changed; actual native invocation must be observed again.' }
    : null;
  registry.primitives[rel] = {
    registeredAt: now,
    digest: snapshot.digest,
    kind: validation.kind,
    name: validation.name,
    ...(activation || retainedActivation ? { activation: activation || retainedActivation } : {}),
  };
  validatePublication?.('before-registry');
  writeRegistry(copilotHome, registry);
  validatePublication?.('after-registry');
  return { path: rel, state: 'registered', kind: validation.kind, name: validation.name };
}

export function unregisterPrimitive({ copilotHome, rel }) {
  const registry = readRegistry(copilotHome);
  if (registry.unreadable) {
    throw Object.assign(new Error('refusing to write over an unreadable registration store'), {
      code: 'E_TARGET', exit: 1, hint: `inspect ${registeredPath(copilotHome)} by hand`,
    });
  }
  if (!registry.primitives[rel]) {
    throw Object.assign(new Error(`not registered: ${rel}`), { code: 'E_NOT_FOUND', exit: 9, hint: 'ae resources list' });
  }
  delete registry.primitives[rel];
  writeRegistry(copilotHome, registry);
    return { path: rel, state: 'pending' };
}

export function discardPrimitive({ copilotHome, rel, shippedFiles = new Set(), lockFiles = new Set() }) {
  const kind = primitiveKind(rel);
  if (!kind) {
    throw Object.assign(new Error(`not under a primitive directory: ${rel}`), {
      code: 'E_USAGE',
      exit: 2,
      hint: 'discard only removes files under skills/, agents/, or instructions/',
    });
  }
  if (shippedFiles.has(rel) || lockFiles.has(rel)) {
    throw Object.assign(new Error(`refusing to discard a harness-owned file: ${rel}`), {
      code: 'E_TARGET',
      exit: 1,
      hint: 'uninstall or `ae resources remove <bundle>` withdraws files the harness placed',
    });
  }
  const { local } = classifyPrimitives({ copilotHome, shippedFiles, lockFiles });
  if (!local.includes(rel)) {
    throw Object.assign(new Error(`not a locally-added file: ${rel}`), {
      code: 'E_NOT_FOUND',
      exit: 9,
      hint: 'ae resources list',
    });
  }
  const full = assertNoSymlinkAncestors(copilotHome, rel);
  if (!full) {
    throw Object.assign(new Error(`refusing to discard ${rel}: path escapes the Copilot home or is a symlink`), {
      code: 'E_TARGET',
      exit: 1,
    });
  }
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch {
    throw Object.assign(new Error(`not found: ${rel}`), { code: 'E_NOT_FOUND', exit: 9, hint: 'ae resources list' });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw Object.assign(new Error(`refusing to discard ${rel}: not a regular file`), {
      code: 'E_TARGET',
      exit: 1,
    });
  }

  const registry = readRegistry(copilotHome);
  if (registry.unreadable) {
    throw Object.assign(new Error('refusing to write over an unreadable registration store'), {
      code: 'E_TARGET', exit: 1, hint: `inspect ${registeredPath(copilotHome)} by hand`,
    });
  }
  if (registry.primitives[rel]) {
    delete registry.primitives[rel];
    writeRegistry(copilotHome, registry);
  }

  fs.unlinkSync(full);
  const removed = [rel];
  const kindRoot = path.join(path.resolve(copilotHome), kind.dir);
  let dir = path.dirname(full);
  while (dir !== kindRoot && dir.startsWith(`${kindRoot}${path.sep}`)) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      break;
    }
    if (entries.length) break;
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
  return { path: rel, state: 'discarded', removed };
}
