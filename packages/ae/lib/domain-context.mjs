import { spawnGitSync } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import { gitMetadataEnvironment } from '../corpus/hooks/lib/product-diff.mjs';
import path from 'node:path';
import { readDomain } from './domain-contract.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { assertNoSymlinkAncestors, canonicalPath } from './fs-safe.mjs';
import { cachedGitObservation } from './git-observation-cache.mjs';

const contexts = new WeakMap();
const plans = new WeakMap();
const homes = new WeakMap();

function failure(message) {
  return Object.assign(new Error(`Domain plan authority: ${message}`), { code: 'E_DOMAIN', exit: 1 });
}

function safePath(full) {
  const resolved = path.resolve(full), anchor = path.parse(resolved).root;
  if (!assertNoSymlinkAncestors(anchor, path.relative(anchor, resolved))) throw failure('storage is unsafe or symlinked');
  return fs.existsSync(resolved) ? canonicalPath(resolved) : resolved;
}

function directoryIdentity(full) {
  const stat = fs.lstatSync(full, { throwIfNoEntry: false, bigint: true });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('authority directory is unsafe or not a directory');
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

function coordinatorIdentity(workspace) {
  return cachedGitObservation(['coordinator', path.resolve(workspace)], () => readCoordinatorIdentity(workspace));
}

function readCoordinatorIdentity(workspace) {
  const root = safePath(workspace);
  if (!fs.lstatSync(root).isDirectory()) throw failure('coordinator is not a directory');
  const result = spawnGitSync(['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { cwd: root, encoding: 'utf8', timeout: 4000, maxBuffer: 16384, env: gitMetadataEnvironment() });
  const values = String(result.stdout || '').trimEnd().split('\n');
  if (result.error || result.status !== 0 || values.length !== 3) throw failure('coordinator Git identity is unavailable');
  const identity = values.map(value => canonicalPath(safePath(path.resolve(root, value))));
  if (identity[0] !== canonicalPath(root)) throw failure('coordinator must be the checkout root');
  return identity;
}

export function resolveDomainContext({ workspace, home = harnessGlobalHome(), name }) {
  const record = readDomain(name, { home });
  if (record.config.domain_version !== 2) throw failure('execution requires domain_version 2');
  const root = safePath(path.join(record.home, 'domains', name));
  const context = Object.freeze({ name, home: record.home, workspace: canonicalPath(workspace), root, plansDir: path.join(root, 'plans') });
  contexts.set(context, { ...context, identity: coordinatorIdentity(workspace), directories: new Map([context.home, context.root, context.plansDir].map(full => [full, directoryIdentity(full)])) });
  return context;
}

function contextAuthority(context) {
  const authority = contexts.get(context);
  if (!authority) throw failure('an explicit domain context is required; copied context data grants no authority');
  return authority;
}

export function validateDomainContext(context, workspace = context?.workspace) {
  const authority = contextAuthority(context);
  if (canonicalPath(workspace) !== authority.workspace || JSON.stringify(coordinatorIdentity(workspace)) !== JSON.stringify(authority.identity)) throw failure('coordinator identity changed');
  for (const full of [authority.home, authority.root, authority.plansDir]) {
    safePath(full);
    const current = directoryIdentity(full), accepted = authority.directories.get(full);
    if (accepted !== null && current !== accepted) throw failure('authority directory identity changed or disappeared');
    if (accepted === null && current !== null) authority.directories.set(full, current);
  }
  return authority;
}

function resolveParentPath(authority, argument) {
  if (typeof argument !== 'string' || !argument || argument.includes('\0')) throw failure('parent plan path is invalid');
  const full = safePath(path.isAbsolute(argument) ? path.resolve(argument) : path.join(authority.plansDir, argument));
  if (path.dirname(full) !== authority.plansDir || !/^[^._/][^/]*\.hplan$/.test(path.basename(full))) throw failure('parent plan must be an .hplan directly inside the selected domain plans directory');
  return full;
}

export function domainPlanPath(context, argument) {
  const authority = contextAuthority(context);
  resolveParentPath(authority, argument);
  validateDomainContext(context);
  return resolveParentPath(authority, argument);
}

export function authorizeDomainPlan(context, plan) {
  const authority = contextAuthority(context);
  if (!plan?.fm?.domain_parent || plan.fm.domain_child || plan.fm.domain_parent.name !== authority.name || Number(plan.fm.plan_schema) < 3) throw failure('plan does not match the explicit domain parent authority');
  const full = resolveParentPath(authority, plan.fullPath);
  validateDomainContext(context);
  if (resolveParentPath(authority, plan.fullPath) !== full) throw failure('plan does not match the explicit domain parent authority');
  plans.set(plan, context);
  return plan;
}

export function domainContextOf(plan) { return plans.get(plan) || null; }

export function authorizeProjectPlan(plan, home) {
  if (plan?.fm?.domain_parent) throw failure('project context cannot authorize a parent');
  const selected = home || harnessGlobalHome();
  homes.set(plan, { home: fs.existsSync(selected) ? canonicalPath(selected) : path.resolve(selected), explicit: home !== undefined && home !== null });
  return plan;
}

export function withPlanAuthority(original, updated) {
  const context = plans.get(original);
  if (context) return authorizeDomainPlan(context, updated);
  if (homes.has(original)) homes.set(updated, homes.get(original));
  return updated;
}

export function planRecordRoot(workspace, plan) {
  const context = plans.get(plan);
  if (context) {
    const authority = contextAuthority(context);
    resolveParentPath(authority, plan.fullPath);
    validateDomainContext(context, workspace);
    resolveParentPath(authority, plan.fullPath);
    return authority.root;
  }
  if (plan?.fm?.domain_parent) throw failure('parent plan has no explicit domain context authority');
  return path.resolve(workspace);
}

export function planHome(workspace, plan, fallback = harnessGlobalHome()) {
  const context = plans.get(plan);
  if (!context) { planRecordRoot(workspace, plan); return homes.get(plan)?.home || path.resolve(fallback || harnessGlobalHome()); }
  return validateDomainContext(context, workspace).home;
}

export function planTrustHome(workspace, plan) {
  const context = plans.get(plan);
  if (context) return validateDomainContext(context, workspace).home;
  planRecordRoot(workspace, plan);
  const selected = homes.get(plan);
  return selected?.explicit ? selected.home : undefined;
}
