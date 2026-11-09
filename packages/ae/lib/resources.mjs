import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { byteCompare } from './tui/ranking.mjs';

export const MANIFEST_FILE = 'harness-resource.yaml';
export const RESOURCES_DIRNAME = 'resources';
export const MANIFEST_SCHEMA = 1;

/** The contribution kinds a bundle may declare. Closed, for the same reason the
 * event-type allow-list is closed: an unlisted kind that silently contributes
 * nothing is invisible by construction. */
export const CONTRIBUTION_KINDS = Object.freeze(['skills', 'agents', 'instructions', 'checks']);

/** Capabilities a bundle may request. A bundle that asks for nothing gets
 * nothing; there is no implicit grant. */
export const CAPABILITIES = Object.freeze(['read-workspace', 'read-knowledge', 'network', 'execute']);

export function resourcesRoot(copilotHome) {
  return path.join(copilotHome, RESOURCES_DIRNAME);
}

function fail(errors, message) {
  errors.push(message);
  return errors;
}

export function parseManifest(text, { source = '(inline)' } = {}) {
  const errors = [];
  let doc;
  try {
    doc = YAML.parse(text, { maxAliasCount: 50 });
  } catch (error) {
    return { manifest: null, errors: [`${source}: ${error.message}`] };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { manifest: null, errors: [`${source}: expected a YAML mapping`] };
  }
  if (doc.schema !== MANIFEST_SCHEMA) fail(errors, `${source}: schema must be ${MANIFEST_SCHEMA}`);
  if (!doc.name || typeof doc.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(doc.name)) {
    fail(errors, `${source}: name must be a lowercase slug`);
  }
  if (!doc.version || typeof doc.version !== 'string') fail(errors, `${source}: version is required`);
  if (doc.priority !== undefined && !Number.isInteger(doc.priority)) {
    fail(errors, `${source}: priority must be an integer when present`);
  }

  const contributes = doc.contributes && typeof doc.contributes === 'object' && !Array.isArray(doc.contributes)
    ? doc.contributes
    : {};
  for (const kind of Object.keys(contributes)) {
    if (!CONTRIBUTION_KINDS.includes(kind)) {
      fail(errors, `${source}: unknown contribution kind ${kind} (one of ${CONTRIBUTION_KINDS.join(', ')})`);
      continue;
    }
    const list = contributes[kind];
    if (!Array.isArray(list)) {
      fail(errors, `${source}: contributes.${kind} must be a list of paths`);
      continue;
    }
    for (const rel of list) {
      if (typeof rel !== 'string' || !rel) {
        fail(errors, `${source}: contributes.${kind} entries must be non-empty strings`);
        continue;
      }
      if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
        fail(errors, `${source}: contributes.${kind} entry must be relative to the bundle: ${rel}`);
        continue;
      }
      const normalized = path.normalize(rel).split(path.sep).join('/');
      if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
        fail(errors, `${source}: contributes.${kind} entry escapes the bundle: ${rel}`);
      }
    }
  }
  const capabilities = Array.isArray(doc.capabilities) ? doc.capabilities : [];
  for (const cap of capabilities) {
    if (!CAPABILITIES.includes(cap)) {
      fail(errors, `${source}: unknown capability ${cap} (one of ${CAPABILITIES.join(', ')})`);
    }
  }

  if (errors.length) return { manifest: null, errors };
  return {
    manifest: {
      schema: doc.schema,
      name: doc.name,
      version: doc.version,
      description: typeof doc.description === 'string' ? doc.description : '',
            priority: Number.isInteger(doc.priority) ? doc.priority : 0,
      contributes,
      capabilities,
      // A plugin entry point is optional: a bundle may contribute only files.
      plugin: typeof doc.plugin === 'string' ? doc.plugin : null,
      integrity: typeof doc.integrity === 'string' ? doc.integrity : null,
    },
    errors: [],
  };
}

const NON_CONTENT_FILES = new Set(['.enabled', '.disabled']);

/** The digest a bundle's integrity pin is checked against: every contributed
 * file's path and content, in a stable order. */
export function bundleDigest(dir) {
  const files = [];
  const walk = (current, rel = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const relative = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile() && !NON_CONTENT_FILES.has(relative)) files.push([relative, full]);
      else if (entry.isSymbolicLink()) files.push([relative, full, 'symlink']);
    }
  };
  walk(dir);
  const hash = crypto.createHash('sha256');
  for (const [rel, full, kind] of files) {
    hash.update(rel);
    hash.update('\0');
    if (kind === 'symlink') {
      hash.update('symlink\0');
      hash.update(fs.readlinkSync(full));
      continue;
    }
    if (rel === MANIFEST_FILE) {
      hash.update(fs.readFileSync(full, 'utf8').split(/\r?\n/).filter((l) => !/^\s*integrity\s*:/.test(l)).join('\n'));
    } else {
      hash.update(fs.readFileSync(full));
    }
  }
  return `sha256-${hash.digest('hex')}`;
}

export function discoverBundles(copilotHome, { trustedNames = new Set() } = {}) {
  const root = resourcesRoot(copilotHome);
  if (!fs.existsSync(root)) return [];
  const bundles = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => byteCompare(a.name, b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifestPath = path.join(dir, MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) {
      bundles.push({ dir, name: entry.name, manifest: null, state: 'invalid', reason: `no ${MANIFEST_FILE}`, errors: [] });
      continue;
    }
    const { manifest, errors } = parseManifest(fs.readFileSync(manifestPath, 'utf8'), { source: `${entry.name}/${MANIFEST_FILE}` });
    if (!manifest) {
      bundles.push({ dir, name: entry.name, manifest: null, state: 'invalid', reason: errors[0], errors });
      continue;
    }

    const disabled = fs.existsSync(path.join(dir, '.disabled'));
    let state = disabled ? 'disabled' : 'enabled';
    let reason = disabled ? 'disabled by the operator' : null;

    const digest = bundleDigest(dir);
    if (manifest.integrity && manifest.integrity !== digest) {
      state = 'tampered';
      reason = `integrity pin does not match the bundle's contents (${manifest.integrity} vs ${digest})`;
    } else if (state === 'enabled' && !trustedNames.has(entry.name)) {
      state = 'untrusted';
      reason = 'not approved — run `ae resources enable` after reading what it contributes';
    }

    bundles.push({ id: entry.name, dir, name: manifest.name, manifest, state, reason, errors: [], digest });
  }

    const claims = new Map();
  for (const b of bundles) {
    if (b.state !== 'enabled' || !b.manifest) continue;
    (claims.get(b.name) || claims.set(b.name, []).get(b.name)).push(b);
  }
  for (const [name, group] of claims) {
    if (group.length < 2) continue;
    for (const b of group) {
      b.state = 'conflicted';
      b.reason = `another enabled bundle also declares the name ${JSON.stringify(name)} (${group.map((g) => g.id).join(', ')}) — disable or rename one`;
    }
  }
  return bundles;
}

export function resolvePrecedence(bundles) {
  const enabled = bundles.filter((b) => b.state === 'enabled' && b.manifest);
  const ordered = [...enabled].sort((a, b) => (
    (b.manifest.priority ?? 0) - (a.manifest.priority ?? 0)
    || byteCompare(a.name, b.name)
  ));
  const byPath = new Map();
  for (const bundle of ordered) {
    for (const kind of CONTRIBUTION_KINDS) {
      for (const rel of bundle.manifest.contributes[kind] || []) {
        const key = `${kind}/${rel}`;
        if (!byPath.has(key)) byPath.set(key, { kind, path: rel, winner: bundle.name, winnerId: bundle.id, shadowed: [] });
        else byPath.get(key).shadowed.push(bundle.name);
      }
    }
  }
  return [...byPath.values()].sort((a, b) => byteCompare(`${a.kind}/${a.path}`, `${b.kind}/${b.path}`));
}
