import { spawnGitSync } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import { planContractText } from './work-contract.mjs';
import { domainContextOf, domainPlanPath, planHome, planRecordRoot } from './domain-context.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getCorpusRoot } from './assets.mjs';
import { externalPlansDir } from './project-layout.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { performanceContext, performanceContextIsCurrent } from './performance.mjs';
import { parsePlanFrontmatter } from './plan-parse.mjs';
import { readFileNoFollow, assertNoSymlinkAncestors, canonicalPath } from './fs-safe.mjs';
import { readProductDiff, gitMetadataEnvironment } from '../corpus/hooks/lib/product-diff.mjs';
import { discoverCapabilities, resolveCapability } from './capability-catalog.mjs';

export const CODE_REVIEWERS = Object.freeze(['architecture-strategist', 'security-sentinel', 'performance-oracle', 'code-simplicity-reviewer', 'pattern-recognition-specialist']);
export const REVIEW_BUDGET_CAP = 3;
const LANGUAGE_REVIEWERS = Object.freeze([
  ['java-reviewer', /\.java$/i],
  ['compounding-typescript-reviewer', /\.tsx?$/i],
  ['python-reviewer', /\.py$/i],
  ['sql-reviewer', /\.sql$/i],
]);
export const LANGUAGE_REVIEWER_IDS = Object.freeze(LANGUAGE_REVIEWERS.map(([id]) => id));

function crossesBoundary(file) {
  return /\.sql$/i.test(file) || /(?:^|[\\/_.-])(?:auth|secrets?|passwords?|migrations?|schemas?|iam)(?:[\\/_.-]|$)/i.test(file);
}

export function reviewBudget(files) {
  const paths = [...new Set((files || []).map(file => String(file).replace(/\\/g, '/')).filter(Boolean))];
  const large = paths.length > 8;
  const selected = ['code-simplicity-reviewer'];
  if (paths.some(crossesBoundary) || large) selected.push('security-sentinel');
  if (large) selected.push('architecture-strategist');
  const languages = new Set();
  for (const file of paths) {
    for (const [id, pattern] of LANGUAGE_REVIEWERS) {
      if (pattern.test(file)) languages.add(id);
    }
  }
  if (languages.size === 1) {
    const [id] = languages;
    if (!selected.includes(id)) selected.push(id);
  }
  return selected.slice(0, REVIEW_BUDGET_CAP);
}
export const DOCUMENT_REVIEWERS = Object.freeze(['design', 'scope', 'coherence', 'feasibility']);
export const DOCUMENT_REVIEW_DEFINITIONS = Object.freeze(['skills/document-review/references/review-criteria.md', 'skills/code-review/references/findings-schema.md']);
export const reviewHash = value => createHash('sha256').update(stableJson(value)).digest('hex');
export function stableJson(value) {
  return JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
}
export const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function expandPatterns(value) {
  const patterns = [], tokens = [];
  let depth = 0, token = '';
  for (const char of value) {
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (depth < 0) throw new Error('Unbalanced check glob');
    if (char === ',' && depth === 0) { tokens.push(token); token = ''; } else token += char;
  }
  if (depth !== 0) throw new Error('Unbalanced check glob');
  tokens.push(token);
  for (const part of tokens) {
    const brace = part.match(/\{([^{}]+)\}/);
    if (brace) for (const option of brace[1].split(',')) patterns.push(...expandPatterns(part.replace(brace[0], option)));
    else if (part.trim()) patterns.push(part.trim());
    if (patterns.length > 100) throw new Error('Check glob expansion exceeds 100 patterns');
  }
  return patterns;
}
function globRegex(glob) {
  let pattern = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; pattern += '(?:.*/)?'; } else pattern += '.*';
    } else if (c === '*') pattern += '[^/]*';
    else if (c === '?') pattern += '[^/]';
    else pattern += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(pattern + '$');
}
function source(root, rel, origin) {
  const full = path.join(root, rel);
  const bytes = readFileNoFollow(full, { root, encoding: null });
  let missing = false;
  try { fs.lstatSync(full); } catch (error) { missing = error.code === 'ENOENT' && Boolean(assertNoSymlinkAncestors(root, rel)); }
  return { origin, path: rel.replace(/\\/g, '/'), state: bytes === null ? (missing ? 'missing' : 'unreadable') : 'regular', sha256: bytes === null ? null : createHash('sha256').update(origin === 'domain-plan' ? planContractText(bytes.toString('utf8')) : bytes).digest('hex'), ...(origin === 'domain-plan' ? { hashPolicy: 'work-contract-v3' } : {}) };
}

function installedSource(resource) {
  const bytes = readFileNoFollow(resource.path, { root: resource.root, encoding: null });
  return { origin: 'installed', path: resource.path, resourceId: resource.key, name: resource.id, format: resource.format, state: bytes === null ? 'unreadable' : 'regular', sha256: bytes === null ? null : createHash('sha256').update(bytes).digest('hex') };
}

function projectPlanLocation(workspace, file, { plan } = {}) {
  const context = domainContextOf(plan);
  if (context && typeof file === 'string') {
    try {
      const full = domainPlanPath(context, file);
      if (full === plan.fullPath) {
        const root = planRecordRoot(workspace, plan);
        return { root, rel: path.relative(root, full), full, origin: 'domain-plan' };
      }
    } catch { /* other selected files still require project-store authority below */ }
  }
  if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.(?:md|hplan)$/.test(file) || /[\0\r\n]/.test(file)) return null;
  const home = plan ? planHome(workspace, plan) : harnessGlobalHome();
  const raw = path.resolve(file);
  let full;
  try {
    const rawHome = [home, harnessGlobalHome()].find(candidate => {
      const relative = path.relative(candidate, raw);
      return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && canonicalPath(candidate) === canonicalPath(home);
    });
    if (!rawHome || !assertNoSymlinkAncestors(rawHome, path.relative(rawHome, raw))) return null;
    full = canonicalPath(raw);
  } catch { return null; }
  let root;
  try { root = canonicalPath(externalPlansDir(workspace, { home })); } catch { return null; }
  const rel = path.relative(root, full);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  const canonicalHome = canonicalPath(home);
  return { root: canonicalHome, rel: path.relative(canonicalHome, full), full };
}

/** Rederive the selected project's store rather than trusting a root in a packet. */
export function readReviewFile(workspace, ref, options = {}) {
  if (['project-plan', 'domain-plan'].includes(ref?.origin)) {
    const location = projectPlanLocation(workspace, ref.path, options);
    return location ? readFileNoFollow(location.full, { ...options, root: location.root }) : null;
  }
  if (!['product', 'corpus'].includes(ref?.origin) || typeof ref.path !== 'string' || path.isAbsolute(ref.path) || path.win32.isAbsolute(ref.path)) return null;
  const root = ref.origin === 'corpus' ? getCorpusRoot() : workspace;
  return readFileNoFollow(path.join(root, ref.path), { ...options, root });
}

function currentSource(workspace, ref, options = {}) {
  if (ref.origin === 'installed') {
    const resource = resolveCapability({ ...options, workspace, kind: 'agent', id: ref.name });
    return resource && resource.key === ref.resourceId && resource.path === ref.path && resource.format === ref.format && resource.invocable !== false
      ? installedSource(resource) : { ...ref, state: 'unavailable', sha256: null };
  }
  if (['project-plan', 'domain-plan'].includes(ref.origin)) {
    const location = projectPlanLocation(workspace, ref.path, options);
    return location ? { ...source(location.root, location.rel, ref.origin), path: ref.path } : { ...ref, state: 'unreadable', sha256: null };
  }
  return source(ref.origin === 'corpus' ? getCorpusRoot() : workspace, ref.path, ref.origin);
}

function selectedSource(workspace, file, kind, plan, requireSafeAncestors = false) {
  const full = path.resolve(workspace, file), rel = path.relative(workspace, full).replace(/\\/g, '/');
  if (rel && rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel)) {
    if (requireSafeAncestors && !assertNoSymlinkAncestors(workspace, rel)) throw new Error('Selected document path has unsafe symlink ancestors');
    return source(workspace, rel, 'product');
  }
  if (kind === 'document' || domainContextOf(plan)) {
    const location = projectPlanLocation(workspace, full, { plan });
    if (location) {
      const ref = { ...source(location.root, location.rel, location.origin || 'project-plan'), path: full.replace(/\\/g, '/') };
      if (ref.sha256) return ref;
    }
  }
  throw new Error('Review files must be inside the workspace or readable plans in the current project store for document reviews');
}

export function selectedDocumentSources(workspace, files) {
  if (!Array.isArray(files) || !files.length) throw new Error('Selected document review requires a nonempty file list');
  const refs = new Map();
  for (const file of files) {
    if (typeof file !== 'string' || !file || /[\0\r\n]/.test(file) || (path.win32.isAbsolute(file) && !path.isAbsolute(file))) throw new Error(`Invalid selected document path: ${file}`);
    let ref;
    try { ref = selectedSource(workspace, file.replace(/\\/g, '/'), 'document', undefined, true); }
    catch (error) { throw new Error(`Selected document ${file}: ${error.message}`); }
    if (ref.state !== 'regular' || !ref.sha256) throw new Error(`Selected document ${file} is ${ref.state}; require a readable regular source within the source hash limit`);
    refs.set(`${ref.origin}:${ref.path}`, ref);
  }
  return [...refs.values()].sort((a, b) => compareText(a.origin, b.origin) || compareText(a.path, b.path));
}

export function refreshDocumentSources(workspace, refs) {
  return refs.map(ref => ref.origin === 'product' && !assertNoSymlinkAncestors(workspace, ref.path)
    ? { ...ref, state: 'unreadable', sha256: null }
    : currentSource(workspace, ref));
}

export function discoverReviewChecks(workspace, files) {
  const corpus = getCorpusRoot(), checks = [], failures = [];
  for (const [root, dir, origin] of [[corpus, 'skills/code-review/references/checks', 'corpus'], [workspace, '.github/checks', 'product']]) {
    if (!assertNoSymlinkAncestors(root, dir)) { failures.push(`${origin} check directory is unsafe`); continue; }
    let entries;
    try { entries = fs.readdirSync(path.join(root, dir)); } catch (error) { if (error.code !== 'ENOENT') failures.push(`${origin} checks unreadable`); continue; }
    for (const file of entries.filter(f => f.endsWith('.md')).sort(compareText)) {
      const ref = source(root, `${dir}/${file}`, origin);
      const text = readFileNoFollow(path.join(root, ref.path), { root, maxBytes: 1024 * 1024 });
      try {
        if (text === null) throw new Error('Missing, unsafe or oversized check');
        if (file.toLowerCase() === 'readme.md' && !/^---\r?\n/.test(text)) continue;
        const fm = parsePlanFrontmatter(text);
        if (typeof fm.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fm.name)) throw new Error('Check needs a valid name');
        if (fm.globs !== undefined && typeof fm.globs !== 'string' && !(Array.isArray(fm.globs) && fm.globs.every(g => typeof g === 'string'))) throw new Error('Check globs must be strings');
        const patterns = fm.globs === undefined ? [] : (Array.isArray(fm.globs) ? fm.globs : [fm.globs]).flatMap(expandPatterns).map(globRegex);
        const mapped = files.map(f => f.replace(/^packages\/(?:ae|harness)\/corpus\/(agents|skills|instructions)\//, '.github/$1/'));
        const matched = patterns.length === 0 || mapped.some(f => patterns.some(pattern => pattern.test(f)));
        checks.push({ name: fm.name, ref, globs: fm.globs ?? null, matched, severityDefault: fm['severity-default'] || 'P2' });
      } catch (error) { failures.push(`${origin}:${ref.path}: ${error.message}`); checks.push({ name: null, ref, matched: false, invalid: true }); }
    }
  }
  const ids = checks.filter(c => c.matched).map(c => c.name);
  if (ids.length !== new Set(ids).size) failures.push('Duplicate applicable review check names');
  return { checks, failures };
}

export function reviewPreparation({ workspace, scope, plan, kind, reviewers, files, maxBytes = 16384, home, copilotHome }) {
  const corpus = getCorpusRoot();
  const selectedDocument = scope.mode === 'selected-document-v1';
  const selectedRefs = new Map(selectedDocument ? scope.files.map(ref => [ref.path, ref]) : (files?.length ? files : scope.changedFiles).map(file => {
    const ref = selectedSource(workspace, file, kind, plan);
    return [ref.path, ref];
  }));
  const selected = [...selectedRefs.keys()].sort(compareText);
  const covered = selectedDocument ? scope.files.map(ref => ref.path) : [...new Set([...scope.changedFiles, ...selected])].sort(compareText);
  const discovery = kind === 'code' ? discoverReviewChecks(workspace, covered) : { checks: [], failures: [] };
  const declaredRequired = [...new Set(plan?.fm.reviews?.required || [])].sort(compareText);
  const selectedReviewers = kind === 'document' ? DOCUMENT_REVIEWERS : reviewBudget(covered);
  const required = [...new Set([...selectedReviewers, ...declaredRequired.filter(r => r !== 'code-review'), ...reviewers, ...discovery.checks.filter(c => c.matched).map(c => c.name)])].sort(compareText);
  if (required.some(id => typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) throw new Error('Invalid required review IDs');
  const perspectives = kind === 'document' ? DOCUMENT_REVIEWERS : [...new Set([...selectedReviewers, ...reviewers, ...declaredRequired.filter(id => id !== 'code-review')])];
  const reserved = kind === 'document' ? perspectives : [...new Set([...CODE_REVIEWERS, ...LANGUAGE_REVIEWERS.map(([id]) => id), ...perspectives])];
  const collisions = discovery.checks.filter(c => c.matched && reserved.includes(c.name)).map(c => `Review check name collides with a required perspective: ${c.name}`);
  const catalogOptions = { workspace, home: plan ? planHome(workspace, plan) : home, copilotHome };
  const catalog = kind === 'code' ? discoverCapabilities({ ...catalogOptions, limit: 1 }) : null;
  const adaptive = Boolean(catalog?.configured);
  const providers = [], acquisitionPrerequisites = [];
  const sources = kind === 'document' ? [source(corpus, DOCUMENT_REVIEW_DEFINITIONS[0], 'corpus')] : [];
  if (adaptive) {
    for (const perspective of required) {
      // A check is a criterion assigned to a specialist, rather than a new agent role.
      const criterion = discovery.checks.some(check => check.matched && check.name === perspective);
      const resource = resolveCapability({ ...catalogOptions, kind: 'agent', id: perspective })
        || (criterion ? resolveCapability({ ...catalogOptions, kind: 'agent', id: 'code-simplicity-reviewer' }) : null);
      if (!resource || resource.invocable === false) {
        acquisitionPrerequisites.push({ perspective, kind: 'agent', workflow: 'create-primitive', state: resource ? 'activation-unavailable' : 'missing-provider', action: 'Acquire or activate an independently invocable specialist, then prepare a new packet' });
        continue;
      }
      providers.push({ perspective, name: resource.id, resourceId: resource.key, path: resource.path, format: resource.format, digest: resource.digest, activation: resource.activation, nativeQualification: resource.nativeQualification });
      const ref = installedSource(resource);
      if (!sources.some(value => value.resourceId === ref.resourceId)) sources.push(ref);
    }
  } else if (kind === 'code') sources.push(...perspectives.map(id => source(corpus, `agents/${id}.agent.md`, 'corpus')));
  if (!adaptive) sources.push(source(corpus, DOCUMENT_REVIEW_DEFINITIONS[1], 'corpus'));
  const failures = [...discovery.failures, ...collisions, ...sources.filter(s => !s.sha256).map(s => `Review definition unavailable: ${s.path}`), ...acquisitionPrerequisites.map(value => `Independent review provider unavailable for ${value.perspective}; follow create-primitive` )];
  const performance = kind === 'code' ? performanceContext({ workspace, home: plan ? planHome(workspace, plan) : home || harnessGlobalHome(), files: covered }) : null;
  if (performance?.state === 'invalid') failures.push('Performance profile is invalid; inspect the current profile before completing review');
  const refs = selectedDocument ? scope.files : covered.map(file => selectedRefs.get(file) || source(workspace, file, 'product'));
  const diff = selectedDocument ? null : readProductDiff(workspace, { base: scope.base || 'HEAD', planPath: plan?.path });
  const branchResult = spawnGitSync(['branch', '--show-current'], { cwd: workspace, encoding: 'utf8', timeout: 4000, env: gitMetadataEnvironment() });
  const budget = Math.max(1024, Math.min(maxBytes, 131072));
  const included = [], omitted = [];
  let bytes = 0;
  for (const ref of refs) {
    if (!selected.includes(ref.path)) { omitted.push({ ...ref, reason: 'not selected for excerpts; remains in the review scope' }); continue; }
    const text = readReviewFile(workspace, ref, { maxBytes: 1024 * 1024, plan });
    const remaining = budget - bytes;
    if (text === null || remaining < 256) { omitted.push({ ...ref, reason: text === null ? 'deleted, unsafe, binary or over read limit' : 'packet byte budget' }); continue; }
    const excerpt = Buffer.from(text).subarray(0, Math.min(remaining, 4096)).toString('utf8');
    bytes += Buffer.byteLength(excerpt);
    included.push({ ...ref, excerpt, truncated: Buffer.byteLength(text) > Buffer.byteLength(excerpt) });
  }
  return { declaredRequired, required, ...(adaptive ? { adaptive: { schema: 1, policyRevision: catalog.policyRevision, independentReview: true, tourRequired: true } } : {}), preparation: { kind, ...(adaptive ? { catalog: { policyRevision: catalog.policyRevision }, providers, acquisitionPrerequisites, findingsSchema: 'review-findings-v1' } : {}), ...(performance ? { performance } : {}), branch: branchResult.status === 0 ? branchResult.stdout.trim() : null, checks: discovery.checks, sources, refs, files: included, omitted, diff: diff === null ? null : Buffer.from(diff).subarray(0, budget).toString('utf8'), diffTruncated: selectedDocument ? false : diff === null || Buffer.byteLength(diff) > budget, coverage: { totalFiles: covered.length, includedFiles: included.length, omittedFiles: omitted.length, byteBudget: budget, excerptBytes: bytes }, failures, provenance: 'Host invocation identity unknown; declarations and same-context perspectives are not independent evidence' } };
}

export function preparationIsCurrent(workspace, preparation, options = {}) {
  if (preparation.catalog) {
    const catalogOptions = { ...options, workspace, home: options.plan ? planHome(workspace, options.plan) : options.home };
    const catalog = discoverCapabilities({ ...catalogOptions, limit: 1 });
    if (!catalog.configured || catalog.policyRevision !== preparation.catalog.policyRevision) return false;
    for (const provider of preparation.providers) {
      const resource = resolveCapability({ ...catalogOptions, kind: 'agent', id: provider.perspective })
        || (preparation.checks.some(check => check.matched && check.name === provider.perspective) ? resolveCapability({ ...catalogOptions, kind: 'agent', id: 'code-simplicity-reviewer' }) : null);
      if (!resource || resource.invocable === false || resource.key !== provider.resourceId || resource.path !== provider.path || resource.digest !== provider.digest || resource.format !== provider.format) return false;
    }
  }
  if (preparation.kind === 'code') {
    const home = options.plan ? planHome(workspace, options.plan) : options.home || harnessGlobalHome();
    if (preparation.performance) {
      if (!performanceContextIsCurrent({ workspace, home, context: preparation.performance })) return false;
    } else if (performanceContext({ workspace, home, files: preparation.refs.map(ref => ref.path) }) !== null) return false;
  }
  if (preparation.kind !== 'document' && preparation.refs.some(ref => ref.origin === 'project-plan')) return false;
  if (preparation.kind === 'code') {
    const discovery = discoverReviewChecks(workspace, preparation.refs.map(ref => ref.path));
    if (stableJson(discovery.checks) !== stableJson(preparation.checks)) return false;
  }
  return [...preparation.sources, ...preparation.checks.map(c => c.ref), ...preparation.refs].every(ref => {
    const current = currentSource(workspace, ref, options);
    return current.hashPolicy === ref.hashPolicy && current.sha256 === ref.sha256 && (ref.sha256 !== null || (ref.state === 'missing' && current.state === 'missing'));
  });
}
