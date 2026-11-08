import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { writeFileContained } from './fs-safe.mjs';
import { CONTRIBUTION_KINDS, discoverBundles, resolvePrecedence } from './resources.mjs';

export const PLACEMENTS_FILE = path.join('harness', 'bundles.yaml');
export const PLACEMENTS_SCHEMA = 1;

export function approvedBundleNames(copilotHome) {
  const root = path.join(copilotHome, 'resources');
  if (!fs.existsSync(root)) return new Set();
  const names = new Set();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(root, entry.name, '.enabled'))) names.add(entry.name);
  }
  return names;
}

export function placementsPath(copilotHome) {
  return path.join(copilotHome, PLACEMENTS_FILE);
}

export function readPlacements(copilotHome) {
  const file = placementsPath(copilotHome);
  if (!fs.existsSync(file)) return { version: PLACEMENTS_SCHEMA, bundles: {} };
  try {
    const doc = YAML.parse(fs.readFileSync(file, 'utf8'), { maxAliasCount: 50 });
    const bundles = doc?.bundles;
    if (!bundles || typeof bundles !== 'object' || Array.isArray(bundles)) {
      return { version: PLACEMENTS_SCHEMA, bundles: {}, unreadable: true };
    }
    for (const record of Object.values(bundles)) {
      if (!record || !Array.isArray(record.files)) continue;
      if (!record.files.every((f) => isContainedPlacement(typeof f === 'string' ? f : f?.path))) {
        return { version: PLACEMENTS_SCHEMA, bundles: {}, unreadable: true };
      }
    }
    return { version: doc.version || PLACEMENTS_SCHEMA, bundles };
  } catch {
    return { version: PLACEMENTS_SCHEMA, bundles: {}, unreadable: true };
  }
}

function writePlacements(copilotHome, placements) {
  const written = writeFileContained(copilotHome, PLACEMENTS_FILE, YAML.stringify(placements));
  if (!written) throw Object.assign(new Error(`could not write ${placementsPath(copilotHome)}`), { code: 'E_TARGET', exit: 1 });
  return written;
}

/** Every file any bundle has placed here, for callers that need to tell a
 * bundle's file from a hand-added one. */
export function placedFiles(copilotHome) {
  const placements = readPlacements(copilotHome);
  const all = new Set();
  for (const record of Object.values(placements.bundles)) {
    for (const entry of record?.files || []) all.add(typeof entry === 'string' ? entry : entry.path);
  }
  return all;
}

export function placementFor(kind, rel) {
  return { source: path.join(kind, rel), target: `${kind}/${rel}`.split(path.sep).join('/') };
}

export function isContainedPlacement(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return false;
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false;
  const normalized = path.normalize(rel).split(path.sep).join('/');
  if (normalized.startsWith('../') || normalized === '..') return false;
  return !normalized.split('/').includes('..');
}

function readSourceOnce(full) {
  const stat = fs.lstatSync(full);
  if (stat.isSymbolicLink()) throw Object.assign(new Error('is a symlink'), { code: 'E_TARGET' });
  if (!stat.isFile()) throw Object.assign(new Error('is not a regular file'), { code: 'E_TARGET' });
  return fs.readFileSync(full);
}

const digestOf = (bytes) => `sha256-${crypto.createHash('sha256').update(bytes).digest('hex')}`;

export function syncBundles({ copilotHome, shippedFiles = new Set(), trustedNames = new Set(), dryRun = false } = {}) {
  const bundles = discoverBundles(copilotHome, { trustedNames });
  const winners = resolvePrecedence(bundles);
  const byId = new Map(bundles.map((b) => [b.id ?? b.dir.split(path.sep).pop(), b]));

  const placed = [];
  const refused = [];
  const shadowed = [];
  const nextBundles = {};

  for (const row of winners) {
    const bundle = byId.get(row.winnerId) || byId.get(row.winner);
    if (!bundle) continue;
    const { source, target } = placementFor(row.kind, row.path);

    // The package always wins — see the module note.
    if (shippedFiles.has(target)) {
      refused.push({ bundle: row.winner, target, reason: 'the harness ships this path; a bundle may not replace it' });
      continue;
    }
    const from = path.join(bundle.dir, source);
    let bytes;
    try {
      bytes = readSourceOnce(from);
    } catch (error) {
      refused.push({
        bundle: row.winner,
        target,
        reason: error.code === 'E_TARGET' ? `${source} ${error.message}` : `declared but missing from the bundle: ${source}`,
      });
      continue;
    }
    if (!dryRun) {
      const written = writeFileContained(copilotHome, target, bytes);
      if (!written) {
        refused.push({ bundle: row.winner, target, reason: 'refused by path containment' });
        continue;
      }
    }
    placed.push({ bundle: row.winner, target });
    (nextBundles[row.winner] ||= { version: bundle.manifest?.version ?? null, files: [] })
      .files.push({ path: target, digest: digestOf(bytes) });
    for (const loser of row.shadowed) shadowed.push({ bundle: loser, target, winner: row.winner });
  }

    const previous = readPlacements(copilotHome);
  const stillPlaced = new Set(placed.map((p) => p.target));
  const withdrawn = [];
  const retained = [];
  if (!previous.unreadable) {
    for (const [name, record] of Object.entries(previous.bundles)) {
      for (const entry of record?.files || []) {
        const rel = typeof entry === 'string' ? entry : entry.path;
        const recordedDigest = typeof entry === 'string' ? null : entry.digest;
        if (stillPlaced.has(rel)) continue;

        if (shippedFiles.has(rel)) {
          retained.push({ bundle: name, target: rel, reason: 'the harness now ships this path' });
          continue;
        }
        const full = path.join(copilotHome, rel);
        let current = null;
        try {
          current = fs.lstatSync(full).isFile() ? digestOf(fs.readFileSync(full)) : null;
        } catch (error) {
          if (error.code === 'ENOENT') { withdrawn.push(rel); continue; }
          retained.push({ bundle: name, target: rel, reason: `unreadable (${error.code || error.message})` });
          continue;
        }
        if (current === null) {
          retained.push({ bundle: name, target: rel, reason: 'not a regular file' });
          continue;
        }
        if (!recordedDigest) {
          retained.push({ bundle: name, target: rel, reason: 'placed before placements recorded content; remove it by hand' });
          continue;
        }
        if (current !== recordedDigest) {
          retained.push({ bundle: name, target: rel, reason: 'the file has changed since this bundle placed it' });
          continue;
        }
        if (dryRun) { withdrawn.push(rel); continue; }
        try {
          fs.rmSync(full);
          withdrawn.push(rel);
        } catch (error) {
          if (error.code === 'ENOENT') { withdrawn.push(rel); continue; }
          retained.push({ bundle: name, target: rel, reason: `could not remove (${error.code || error.message})` });
          (nextBundles[name] ||= { version: record?.version ?? null, files: [] }).files.push(entry);
        }
      }
    }
  }

  if (!dryRun && !previous.unreadable) {
    writePlacements(copilotHome, { version: PLACEMENTS_SCHEMA, bundles: nextBundles });
  }
  return { placed, withdrawn, retained, refused, shadowed, unreadable: previous.unreadable === true };
}
