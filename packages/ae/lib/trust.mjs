import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { EXIT } from './style.mjs';
import { writeFileContained, readFileNoFollow, canonicalPath, assertNoSymlinkAncestors } from './fs-safe.mjs';
import { harnessGlobalHome, resolveCopilotHome } from './paths.mjs';
import { runtimeSetting } from '../corpus/hooks/lib/runtime-identity.mjs';
import { aeWorktreePrimary } from './worktree.mjs';
import { withPlanUpdateLock } from './plan-update.mjs';

import { resolveProjectAuthority } from './project-authority.mjs';

export const TRUST_SCHEMA_VERSION = 1;

export const PINNED_FILES = Object.freeze([
  path.join('.github', 'harness', 'config.yaml'),
  path.join('.github', 'harness', 'policy.yaml'),
  path.join('.github', 'harness', 'checks.yaml'),
  path.join('.github', 'harness', 'routing.yaml'),
]);

/** Pins hashed before routing.yaml joined the list. */
export const LEGACY_PINNED_FILES = Object.freeze(PINNED_FILES.filter((rel) => !rel.endsWith(`${path.sep}routing.yaml`)));

export const TRUST_STATES = Object.freeze(['trusted', 'untrusted', 'stale', 'revoked']);

function trustRoot({ home, copilotHome } = {}) {
  if (home) return path.resolve(home);
  const selected = runtimeSetting('HOME');
  if (selected) return path.resolve(selected);
  if (copilotHome) {
    const given = path.resolve(copilotHome);
    const usual = path.resolve(resolveCopilotHome(undefined));
    if (given !== usual) return given;
  }
  return harnessGlobalHome();
}

/** User-scope approval file. A string argument is a copilot or fixture home. */
export function trustStorePath(homeOrCopilot) {
  if (typeof homeOrCopilot === 'string') return path.join(trustRoot({ copilotHome: homeOrCopilot }), 'trust.yaml');
  return path.join(trustRoot(homeOrCopilot || {}), 'trust.yaml');
}

export function legacyTrustStorePath(copilotHome) {
  return path.join(path.resolve(copilotHome || resolveCopilotHome(undefined)), 'harness', 'trust.yaml');
}

export function projectIdentity(workspace) {
  let root;
  try {
    root = canonicalPath(path.resolve(workspace));
  } catch {
    root = path.resolve(workspace);
  }
  return { root, id: crypto.createHash('sha256').update(root).digest('hex').slice(0, 16) };
}

function policySnapshot(workspace, files, options) {
  const hash = crypto.createHash('sha256'), legacyHash = crypto.createHash('sha256');
  let routingPresent = false;
  let root, authority;
  try {
    root = canonicalPath(path.resolve(workspace));
    authority = resolveProjectAuthority(root, options);
  } catch { return null; }
  // Preserve existing shared approvals; local authority has a distinct identity.
  if (authority.mode === 'local') {
    hash.update(`local-authority-v1\0${authority.directory}\0`);
    legacyHash.update(`local-authority-v1\0${authority.directory}\0`);
  }
  for (const rel of files) {
    const full = path.join(authority.directory, path.basename(rel));
    try {
      if (!assertNoSymlinkAncestors(authority.root, path.relative(authority.root, full))) return null;
      const stat = fs.lstatSync(full, { throwIfNoEntry: false });
      const content = stat ? readFileNoFollow(full, { root: authority.root, maxBytes: 1024 * 1024, encoding: null }) : undefined;
      if (content === null) return null;
      if (rel.endsWith(`${path.sep}routing.yaml`)) routingPresent = Boolean(stat);
      for (const target of LEGACY_PINNED_FILES.includes(rel) ? [hash, legacyHash] : [hash]) {
        target.update(rel);
        target.update('\0present\0');
        target.update(stat ? content : '\0absent\0');
      }
    } catch { return null; }
  }
  return { digest: hash.digest('hex'), legacyDigest: routingPresent ? null : legacyHash.digest('hex') };
}

export function policyDigest(workspace, files = PINNED_FILES, options) {
  return policySnapshot(workspace, files, options)?.digest ?? null;
}

function snapshotMatchesApproval(recordDigest, snapshot) {
  return Boolean(recordDigest && snapshot && (recordDigest === snapshot.digest || recordDigest === snapshot.legacyDigest));
}

/** Current digest, or the pre-routing digest when that file is still absent. */
export function digestMatchesApproval(recordDigest, workspace, options) {
  if (!recordDigest) return false;
  return snapshotMatchesApproval(recordDigest, policySnapshot(workspace, PINNED_FILES, options));
}

function parseStoreFile(file, root) {
  try {
    if (!assertNoSymlinkAncestors(root, path.relative(root, file))) throw new Error('unsafe trust store');
    const doc = YAML.parse(readFileNoFollow(file, { root, maxBytes: 1024 * 1024 }) || 'null', { maxAliasCount: 50 });
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { version: TRUST_SCHEMA_VERSION, projects: {}, unreadable: true };
    }
    const projects = doc.projects;
    if (projects === undefined || projects === null || typeof projects !== 'object' || Array.isArray(projects)) {
      return { version: TRUST_SCHEMA_VERSION, projects: {}, unreadable: true };
    }
    if ((doc.version !== undefined && doc.version !== TRUST_SCHEMA_VERSION) || Object.values(projects).some(record => !record || typeof record !== 'object' || Array.isArray(record)
      || !['trusted', 'revoked', 'conflict'].includes(record.status) || record.status === 'trusted' && typeof record.digest !== 'string')) {
      return { version: TRUST_SCHEMA_VERSION, projects: {}, unreadable: true };
    }
    return { version: doc.version || TRUST_SCHEMA_VERSION, projects };
  } catch {
    return { version: TRUST_SCHEMA_VERSION, projects: {}, unreadable: true };
  }
}

function withTrustStoreLock(options, action) {
  const root = trustRoot(options);
  if (!assertNoSymlinkAncestors(root, 'trust.yaml')) throw Object.assign(new Error('trust store path is unsafe or symlinked'), { code: 'E_TARGET', exit: 1 });
  fs.mkdirSync(root, { recursive: true });
  return withPlanUpdateLock(path.join(root, 'trust.yaml'), action);
}

function readStore({ copilotHome, home } = {}, { locked = false, migrate = true } = {}) {
  const file = trustStorePath({ copilotHome, home });
  try {
    const root = trustRoot({ copilotHome, home });
    if (!assertNoSymlinkAncestors(root, 'trust.yaml')) throw new Error('unsafe trust store');
    if (fs.lstatSync(file, { throwIfNoEntry: false })) return parseStoreFile(file, root);
    const legacyRoot = path.resolve(copilotHome || resolveCopilotHome(undefined));
    const legacy = legacyTrustStorePath(legacyRoot);
    if (path.resolve(legacy) === path.resolve(file)) return { version: TRUST_SCHEMA_VERSION, projects: {} };
    if (!assertNoSymlinkAncestors(legacyRoot, path.relative(legacyRoot, legacy))) throw new Error('unsafe legacy trust store');
    if (!fs.lstatSync(legacy, { throwIfNoEntry: false })) return { version: TRUST_SCHEMA_VERSION, projects: {} };
    if (!locked && migrate) return withTrustStoreLock({ copilotHome, home }, () => readStore({ copilotHome, home }, { locked: true }));
    const parsed = parseStoreFile(legacy, legacyRoot);
    if (parsed.unreadable || !migrate) return parsed;
    writeStore({ copilotHome, home }, parsed);
    return parsed;
  } catch {
    return { version: TRUST_SCHEMA_VERSION, projects: {}, unreadable: true };
  }
}

function writeStore({ copilotHome, home } = {}, store) {
  const root = trustRoot({ home, copilotHome });
  const written = writeFileContained(root, 'trust.yaml', YAML.stringify(store));
  if (!written) {
    throw Object.assign(new Error(`could not write the trust store at ${path.join(root, 'trust.yaml')}`), {
      code: 'E_TARGET',
      exit: 1,
      hint: 'the path is not writable, or an ancestor is a symlink out of the home directory',
    });
  }
  return written;
}

function approvalState(record, snapshot, store) {
  if (store.unreadable) return { state: 'untrusted', cause: 'store-unreadable', reason: 'the trust store could not be read, so nothing is trusted' };
  if (record?.status === 'conflict') return { state: 'untrusted', cause: 'own-conflict', reason: 'conflicting approvals for this project require inspection' };
  if (snapshot === null) return { state: 'untrusted', cause: 'authority-unavailable', reason: 'a pinned policy source is unreadable, unsafe, nonregular or larger than 1 MiB' };
  if (record?.status === 'revoked') return { state: 'revoked', cause: 'own-revoked', reason: 'trust was explicitly revoked' };
  if (record?.status === 'trusted') {
    if (snapshotMatchesApproval(record.digest, snapshot)) return { state: 'trusted', cause: 'approved', reason: `approved ${record.approvedAt}` };
    return { state: 'stale', cause: 'stale-approval', reason: 'the policy files have changed since this project was approved' };
  }
  return { state: 'untrusted', cause: 'never-approved', reason: 'this project has never been approved' };
}

function authorityFor(workspace, options) {
  try {
    const selected = resolveProjectAuthority(workspace, options);
    return { mode: selected.mode, directory: selected.directory };
  } catch (error) { return { mode: 'unavailable', error: error.message }; }
}

function comparePolicyFiles(workspace, primary, options) {
  const childAuthority = resolveProjectAuthority(workspace, options);
  const primaryAuthority = resolveProjectAuthority(primary, options);
  const bytes = (authority, name) => {
    const full = authority.files[name];
    if (!assertNoSymlinkAncestors(authority.root, path.relative(authority.root, full))) return null;
    if (!fs.lstatSync(full, { throwIfNoEntry: false })) return undefined;
    return readFileNoFollow(full, { root: authority.root, maxBytes: 1024 * 1024, encoding: null });
  };
  const differs = [], missingInChild = [];
  for (const rel of PINNED_FILES) {
    const name = path.basename(rel), childBytes = bytes(childAuthority, name), primaryBytes = bytes(primaryAuthority, name);
    if (primaryBytes !== undefined && childBytes === undefined) missingInChild.push(name);
    if (childBytes === null || primaryBytes === null || (childBytes === undefined || primaryBytes === undefined
      ? childBytes !== primaryBytes : !childBytes.equals(primaryBytes))) differs.push(name);
  }
  return { differs, missingInChild };
}

function personRecovery(binding, inspect, skillsHome) {
  const command = [fs.realpathSync(process.execPath), fileURLToPath(new URL('../bin/ae.mjs', import.meta.url)), 'trust', 'approve', '--workspace', binding.workspace, '--ae-home', binding.home, '--copilot-home', binding.copilotHome];
  if (skillsHome || process.env.AE_SKILLS_HOME) command.push('--skills-home', path.resolve(skillsHome || process.env.AE_SKILLS_HOME));
  command.push('--json');
  return { owner: 'person', kind: 'review-and-approve', message: 'A person must review the selected policy files and approve this workspace before project-authored commands run.', inspect, command };
}

function recoveryFor({ trusted, cause, reason, authority, pinned, binding, primary, digest, skillsHome }) {
  if (trusted) return null;
  const inspect = [...pinned];
  if (cause === 'store-unreadable' || cause === 'own-conflict') {
    return { owner: 'engineer', kind: 'inspect-store', message: `Inspect the trust store at ${binding.store}. ${reason}. Preserve existing approvals and revocations.`, inspect: [binding.store], command: null };
  }
  if (cause === 'authority-unavailable') {
    return { owner: 'engineer', kind: 'inspect-authority', message: `Inspect the selected project authority. ${authority.error || reason}.`, inspect, command: null };
  }
  if (binding.store !== path.join(binding.home, 'trust.yaml')) {
    return { owner: 'engineer', kind: 'select-binding', message: `Reconcile the selected authority home ${binding.home} and trust store ${binding.store} before requesting approval. Selecting --ae-home would change this invocation's trust store.`, inspect: [...inspect, binding.store], command: null };
  }
  if (primary) {
    const recovery = { owner: 'engineer', kind: cause === 'policy-mismatch' ? 'align-policy' : 'inspect-primary', message: `${reason}. Inspect the current primary and worktree policy sources before requesting a trust decision.`, inspect: [...inspect, ...primary.pinned], command: null };
    if (primary.digest && primary.authority.mode === authority.mode && !primary.missingInChild.length) {
      if (cause === 'policy-mismatch') {
        recovery.afterInspection = { ...personRecovery(binding, inspect, skillsHome), message: 'If Engineer confirms the complete worktree policy changes are intentional, a person reviews and approves this worktree.' };
      } else if (primary.digest === digest && primary.recovery?.owner === 'person') recovery.afterInspection = primary.recovery;
    }
    return recovery;
  }
  return personRecovery(binding, inspect, skillsHome);
}

/** Render recovery for POSIX shells or Windows PowerShell; argv remains authoritative. */
export function formatTrustRecovery(recovery, { platform = process.platform } = {}) {
  if (!recovery) return '';
  const quote = platform === 'win32'
    ? value => `'${value.replaceAll("'", "''")}'`
    : value => /^[a-zA-Z0-9_./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
  const command = recovery.command ? `${platform === 'win32' ? '& ' : ''}${recovery.command.map(quote).join(' ')}` : '';
  const after = recovery.afterInspection ? ` ${formatTrustRecovery(recovery.afterInspection, { platform })}` : '';
  return `${recovery.message}${command ? ` ${command}` : ''}${after}`;
}

function approvalMatches(root, identity) {
  const anchor = path.parse(root).root;
  return path.isAbsolute(root) && assertNoSymlinkAncestors(anchor, path.relative(anchor, root)) && projectIdentity(root).root === identity.root;
}

function projectApproval(store, identity) {
  const matches = Object.entries(store.projects).filter(([root]) => approvalMatches(root, identity));
  if (matches.length > 1) return { status: 'conflict' };
  return matches[0]?.[1] ?? null;
}

function setProjectApproval(store, identity, record) {
  for (const root of Object.keys(store.projects)) {
    if (approvalMatches(root, identity)) delete store.projects[root];
  }
  store.projects[identity.root] = record;
}

export function trustStatus({ workspace, copilotHome, home, skillsHome, readOnly = false }) {
  const identity = projectIdentity(workspace);
  const binding = { workspace: identity.root, home: path.resolve(home || harnessGlobalHome()), copilotHome: resolveCopilotHome(copilotHome), store: trustStorePath({ copilotHome, home }) };
  const authorityOptions = { home: binding.home };
  const store = readStore({ copilotHome, home }, { migrate: !readOnly });
  const record = projectApproval(store, identity);
  const snapshot = policySnapshot(workspace, PINNED_FILES, authorityOptions);
  const digest = snapshot?.digest ?? null;
  const authority = authorityFor(workspace, authorityOptions);
  const own = approvalState(record, snapshot, store);
  let { state, reason, cause } = own;
  let inherited = false;
  let inheritedFrom = null;
  let primary = null;
  let approvedAt = record?.approvedAt ?? null;
  let approvedDigest = record?.digest ?? null;
  const ownDecides = store.unreadable || digest === null || record?.status === 'revoked' || record?.status === 'conflict' || own.state === 'trusted';
  if (!ownDecides) {
    const primaryWorkspace = aeWorktreePrimary(workspace);
    if (primaryWorkspace) {
      const primaryIdentity = projectIdentity(primaryWorkspace);
      const primaryRecord = projectApproval(store, primaryIdentity);
      const primarySnapshot = policySnapshot(primaryWorkspace, PINNED_FILES, authorityOptions);
      const primaryDigest = primarySnapshot?.digest ?? null;
      const primaryState = approvalState(primaryRecord, primarySnapshot, store);
      const primaryAuthority = authorityFor(primaryWorkspace, authorityOptions);
      const primaryPinned = primaryAuthority.mode === 'unavailable' ? PINNED_FILES.map(rel => path.join(primaryIdentity.root, rel)) : PINNED_FILES.map(rel => path.join(primaryAuthority.directory, path.basename(rel)));
      primary = {
        project: primaryIdentity.root, state: primaryState.state, digest: primaryDigest, approvedDigest: primaryRecord?.digest ?? null,
        authority: primaryAuthority, pinned: primaryPinned,
        ...(primaryDigest === null ? { differs: [], missingInChild: [] } : comparePolicyFiles(workspace, primaryWorkspace, authorityOptions)),
        recovery: recoveryFor({ trusted: primaryState.state === 'trusted', ...primaryState, authority: primaryAuthority, pinned: primaryPinned, binding: { ...binding, workspace: primaryIdentity.root }, primary: null, skillsHome }),
      };
      inheritedFrom = primaryIdentity.root;
      if (primaryState.state === 'trusted' && digest === primaryDigest) {
        state = 'trusted';
        cause = 'inherited';
        inherited = true;
        reason = `inherited from trusted primary ${primaryIdentity.root}`;
        approvedAt = primaryRecord.approvedAt ?? null;
        approvedDigest = primaryRecord.digest ?? null;
      } else if (primaryState.state === 'trusted') {
        state = 'stale';
        cause = 'policy-mismatch';
        reason = `current worktree policy differs from trusted primary ${primaryIdentity.root}${primary.differs.length ? ` in ${primary.differs.join(', ')}` : ' in authority identity'}`;
      } else {
        state = primaryState.state === 'stale' || primaryRecord?.status === 'trusted' ? 'stale' : own.state;
        cause = 'primary-not-current';
        reason = `primary ${primaryIdentity.root} is ${primaryState.state}: ${primaryAuthority.error || primaryState.reason}`;
      }
    }
  }
  const pinned = authority.mode === 'unavailable' ? PINNED_FILES.map(rel => path.join(identity.root, rel)) : PINNED_FILES.map(rel => path.join(authority.directory, path.basename(rel)));
  const trusted = state === 'trusted';
  return {
    schema: 1,
    project: identity.root,
    id: identity.id,
    state,
    trusted,
    inherited,
    inheritedFrom,
    reason,
    digest,
    approvedAt,
    approvedDigest,
    pinned,
    authority,
    store: binding.store,
    binding,
    cause,
    primary,
    recovery: recoveryFor({ trusted, cause, reason, authority, pinned, binding, primary, digest, skillsHome }),
  };
}

/** Whether project-authored policy and configuration may take effect here. */
export function isProjectTrusted({ workspace, copilotHome, home }) {
  return trustStatus({ workspace, copilotHome, home }).trusted;
}

export function approveProject({ workspace, copilotHome, home, now = new Date().toISOString() }) {
  return withTrustStoreLock({ copilotHome, home }, () => {
    const identity = projectIdentity(workspace);
    const store = readStore({ copilotHome, home }, { locked: true, migrate: false });
    if (store.unreadable) {
      throw Object.assign(new Error('refusing to write over an unreadable trust store'), {
        code: 'E_TARGET',
        exit: 1,
        hint: `inspect ${trustStorePath({ copilotHome, home })} by hand — overwriting it would silently discard every approval it holds`,
      });
    }
    const digest = policyDigest(workspace, PINNED_FILES, { home: home || harnessGlobalHome() });
    if (!digest) throw Object.assign(new Error('refusing to approve unreadable, unsafe, nonregular or oversized pinned policy sources'), { code: 'E_TARGET', exit: 1, hint: 'inspect the pinned files and restore bounded regular sources inside the project before approving' });
    store.version = TRUST_SCHEMA_VERSION;
    setProjectApproval(store, identity, { status: 'trusted', approvedAt: now, digest });
    writeStore({ copilotHome, home }, store);
    return trustStatus({ workspace, copilotHome, home });
  });
}

export function revokeProject({ workspace, copilotHome, home, now = new Date().toISOString() }) {
  return withTrustStoreLock({ copilotHome, home }, () => {
    const identity = projectIdentity(workspace);
    const store = readStore({ copilotHome, home }, { locked: true, migrate: false });
    if (store.unreadable) {
      throw Object.assign(new Error('refusing to write over an unreadable trust store'), {
        code: 'E_TARGET',
        exit: 1,
        hint: `inspect ${trustStorePath({ copilotHome, home })} by hand`,
      });
    }
    store.version = TRUST_SCHEMA_VERSION;
    setProjectApproval(store, identity, { status: 'revoked', revokedAt: now });
    writeStore({ copilotHome, home }, store);
    return trustStatus({ workspace, copilotHome, home });
  });
}

export function trustError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_DENIED', exit: EXIT.needsApproval, hint });
}
