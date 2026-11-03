import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { validateCommand } from './checks.mjs';
import { projectAuthorityFile } from './project-authority.mjs';
import { assertNoSymlinkAncestors, readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { withPlanUpdateLock } from './plan-update.mjs';
import { trustStatus } from './trust.mjs';

const MAX_BYTES = 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => Object.assign(new Error(message), { code: 'E_CHECK_CONFIGURATION', exit: 2, hint: 'Inspect ae checks list --json and retry with its current sourceDigest; a person approves execution trust after reviewing the prepared commands.' });
const identity = stat => stat && `${stat.dev}:${stat.ino}`;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}

function observe(workspace, home) {
  const source = projectAuthorityFile(workspace, 'checks.yaml', { home });
  if (!assertNoSymlinkAncestors(source.root, source.relative)) throw fail('Selected check source is redirected or unsafe');
  const stat = fs.lstatSync(source.path, { throwIfNoEntry: false });
  const bytes = stat ? readFileNoFollow(source.path, { root: source.root, maxBytes: MAX_BYTES, encoding: null }) : null;
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || bytes === null || identity(fs.lstatSync(source.path)) !== identity(stat))) throw fail('Selected check source is unreadable, changed, nonregular or oversized');
  return { source, stat, bytes, sourceDigest: bytes === null ? null : digest(bytes) };
}

function documentOf(snapshot) {
  const doc = YAML.parseDocument(snapshot.bytes === null ? 'version: 1\nchecks: {}\n' : snapshot.bytes.toString('utf8'));
  let value;
  try { value = doc.toJS({ maxAliasCount: 50 }); } catch { throw fail('Selected check configuration cannot be parsed safely'); }
  if (doc.errors.length || !object(value) || value.version !== 1 || !object(value.checks) || !YAML.isMap(doc.get('checks', true))) throw fail('Selected check configuration must declare version: 1 and a checks mapping without duplicate keys');
  return { doc, checks: value.checks };
}

/** The exact selected source is also the compare-and-swap token for preparation. */
export function inspectCheckConfiguration({ workspace, home }) {
  const snapshot = observe(workspace, home), { checks } = documentOf(snapshot);
  return { config: snapshot.source.path, sourceMode: snapshot.source.mode, sourceDigest: snapshot.sourceDigest, missing: snapshot.bytes === null, checks };
}

function validateInput(input) {
  if (!object(input) || input.schema !== 1 || Object.keys(input).some(key => !['schema', 'expectedDigest', 'checks', 'rationale'].includes(key))
    || !Object.hasOwn(input, 'expectedDigest') || input.expectedDigest !== null && !/^[a-f0-9]{64}$/.test(input.expectedDigest)
    || typeof input.rationale !== 'string' || !input.rationale.trim() || input.rationale.length > 4000
    || !object(input.checks) || !Object.keys(input.checks).length || Object.keys(input.checks).length > 100) throw fail('Configuration requires schema 1, expectedDigest (hex SHA-256 or null for absence), a nonempty checks mapping and rationale');
  for (const [name, entry] of Object.entries(input.checks)) {
    if (name.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || ['constructor', 'prototype'].includes(name)
      || !object(entry) || Object.keys(entry).some(key => !['command', 'timeout_seconds', 'proof', 'artifacts'].includes(key))) throw fail(`Unsupported check name or configuration fields: ${name}`);
    const error = validateCommand(name, entry);
    if (error) throw fail(error);
    if (entry.command.length > 256 || entry.command.some(part => part.length > 8192 || !part.trim() || /\0/.test(part))) throw fail(`${name}.command exceeds bounded argv limits or contains empty/NUL arguments`);
  }
}

function unchanged(workspace, home, original) {
  const current = observe(workspace, home);
  if (current.source.path !== original.source.path || current.source.root !== original.source.root || current.source.mode !== original.source.mode
    || current.sourceDigest !== original.sourceDigest || identity(current.stat) !== identity(original.stat)) throw fail('Selected check source changed; inspect the current source and retry');
  return current;
}

/** Claim the old name before publishing exclusively, so an external successor is
 * never overwritten by rename. A conflicting old inode is retained for recovery. */
function publish(workspace, home, original, bytes) {
  const { source } = original, parent = path.dirname(source.path);
  const staging = fs.mkdtempSync(path.join(parent, '.checks-configure-'));
  const staged = path.join(staging, 'prepared'), retained = path.join(staging, 'original');
  let moved = false, published = null;
  const read = full => readFileNoFollow(full, { root: source.root, maxBytes: MAX_BYTES, encoding: null });
  const safe = () => assertNoSymlinkAncestors(source.root, source.relative) && assertNoSymlinkAncestors(source.root, path.relative(source.root, staging));
  const removePublished = () => {
    if (!published || !safe()) return;
    const stat = fs.lstatSync(source.path, { throwIfNoEntry: false });
    if (identity(stat) === identity(published) && read(source.path)?.equals(bytes)) fs.unlinkSync(source.path);
  };
  try {
    if (!writeFileContained(source.root, path.relative(source.root, staged), bytes, { exclusive: true, mode: original.stat ? original.stat.mode & 0o777 : 0o600 })) throw fail('Could not stage the check configuration safely');
    unchanged(workspace, home, original);
    if (original.stat) {
      fs.renameSync(source.path, retained); moved = true;
      if (!safe() || identity(fs.lstatSync(retained)) !== identity(original.stat) || !read(retained)?.equals(original.bytes)) throw fail('Check source changed during replacement');
    }
    if (!safe()) throw fail('Check source directory changed before publication');
    try { fs.linkSync(staged, source.path); }
    catch { throw fail('Check configuration publication conflicted with a concurrent change'); }
    published = fs.lstatSync(source.path);
    const current = observe(workspace, home);
    if (current.source.path !== source.path || current.source.mode !== source.mode || identity(current.stat) !== identity(published) || !current.bytes?.equals(bytes)) throw fail('Selected check source changed during publication');
    if (moved && (!read(retained)?.equals(original.bytes) || identity(fs.lstatSync(retained)) !== identity(original.stat))) throw fail('Original check source changed during publication');
    if (moved) { fs.unlinkSync(retained); moved = false; }
  } catch (error) {
    removePublished();
    if (moved && safe()) {
      // Linking fails if a user has published a successor. Preserve both files.
      try { fs.linkSync(retained, source.path); fs.unlinkSync(retained); moved = false; } catch { /* retain the original for inspection */ }
    }
    if (moved) error.message += `; previous source retained at ${retained}`;
    throw error;
  } finally {
    if (safe()) {
      try { fs.unlinkSync(staged); } catch { /* retain unexpected state */ }
      try { fs.rmdirSync(staging); } catch { /* retained originals are never deleted */ }
    }
  }
}

/** Prepare named commands only. Execution and the person's trust decision remain
 * separate operations, including when the workspace was previously trusted. */
export function configureCheckConfiguration({ workspace, home, copilotHome, input, dryRun = false }) {
  validateInput(input);
  const original = observe(workspace, home);
  if (original.sourceDigest !== input.expectedDigest) throw fail('Expected check source digest is stale');
  const { doc, checks } = documentOf(original), changes = [];
  for (const [name, entry] of Object.entries(input.checks)) {
    const previous = Object.hasOwn(checks, name) ? checks[name] : null;
    const current = { ...(object(previous) ? previous : {}), ...entry };
    if (same(previous, current)) continue;
    changes.push({ name, previous, current });
    if (!YAML.isMap(doc.getIn(['checks', name], true))) doc.setIn(['checks', name], doc.createNode({}));
    for (const [key, value] of Object.entries(entry)) {
      if (same(object(previous) ? previous[key] : undefined, value)) continue;
      const old = doc.getIn(['checks', name, key], true), next = doc.createNode(value);
      if (old) for (const comment of ['comment', 'commentBefore', 'spaceBefore']) if (old[comment] !== undefined) next[comment] = old[comment];
      doc.setIn(['checks', name, key], next);
    }
  }
  const changed = changes.length > 0, bytes = changed ? Buffer.from(doc.toString()) : original.bytes;
  if (bytes && bytes.length > MAX_BYTES) throw fail('Prepared check configuration exceeds the 1 MiB source limit');
  const perform = () => {
    unchanged(workspace, home, original);
    if (!dryRun && changed) publish(workspace, home, original, bytes);
    const trust = trustStatus({ workspace, copilotHome, home });
    return {
      schema: 1, verb: 'configure', status: 'ok', config: original.source.path, sourceMode: original.source.mode,
      previousDigest: original.sourceDigest, sourceDigest: dryRun ? original.sourceDigest : bytes === null ? null : digest(bytes),
      proposedDigest: bytes === null ? null : digest(bytes), changed, dryRun: Boolean(dryRun), changes,
      approvalRequired: dryRun && changed || !trust.trusted, trust: { state: trust.state, trusted: trust.trusted },
      nextActions: changed || !trust.trusted ? ['Review the prepared check commands and selected policy files; a person runs ae trust approve before named checks execute.'] : [],
    };
  };
  if (dryRun || !changed) return perform();
  if (!assertNoSymlinkAncestors(original.source.root, original.source.relative)) throw fail('Selected check source is unsafe before locking');
  fs.mkdirSync(path.dirname(original.source.path), { recursive: true });
  if (!assertNoSymlinkAncestors(original.source.root, original.source.relative)) throw fail('Selected check source directory changed before locking');
  return withPlanUpdateLock(original.source.path, perform);
}
