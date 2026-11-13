import { spawnGitSync } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { assertNoSymlinkAncestors, canonicalPath, readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { normalizeDomainOrigin, readDomain, validateDomainConfig, observeDomainRepositoryIdentity } from './domain-contract.mjs';

// `ae domain init` and `ae domain bind`: create or extend a domain from
// explicit inputs the user names. Nothing here searches for workspaces or
// neighbouring checkouts; every candidate comes from a named file, a named
// spec repository or a flag. Init writes a reviewable draft first; only
// `--accept` clones missing repositories and publishes the domain config.

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_CANDIDATES = 32;
const GIT_TIMEOUT = 4000;
const CLONE_TIMEOUT = 10 * 60 * 1000;
const DRAFT_VERSION = 1;
// Spec manifests AE reads, in order. The first YAML manifest found wins; the
// Markdown documents add repository tables and `repos` front matter.
export const SPEC_MANIFESTS = Object.freeze(['ae-domain.yaml', '.ae/domain.yaml', 'docs/ae-domain.yaml']);
export const SPEC_DOCUMENTS = Object.freeze(['README.md', 'architecture.md', 'docs/architecture.md', 'docs/architecture/index.md', 'prd.md', 'docs/prd.md', 'docs/prd/index.md']);

function failure(message, code = 'E_DOMAIN') {
  return Object.assign(new Error(`domain: ${message}`), { code, exit: code === 'E_USAGE' ? 2 : 1 });
}

function bounded(value, max = 4096) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value);
}

function safeDirectory(full, label) {
  if (!bounded(full) || !path.isAbsolute(full)) throw failure(`${label} must be an absolute path`, 'E_USAGE');
  const resolved = path.resolve(full), anchor = path.parse(resolved).root;
  if (!assertNoSymlinkAncestors(anchor, path.relative(anchor, resolved))) throw failure(`${label} is unsafe or symlinked`);
  return fs.existsSync(resolved) ? canonicalPath(resolved) : resolved;
}

function readBounded(full, label) {
  const resolved = safeDirectory(full, label);
  const text = readFileNoFollow(resolved, { maxBytes: MAX_INPUT_BYTES });
  if (text === null) throw failure(`${label} is missing, unreadable, oversized or not a regular file`);
  return { text, path: resolved };
}

function gitEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

function gitRead(cwd, args) {
  try {
    const result = spawnGitSync(['--no-pager', '-c', 'core.fsmonitor=false', ...args], { cwd, env: gitEnvironment(), encoding: 'utf8', timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024 });
    return result && !result.error && result.status === 0 ? String(result.stdout || '').trim() : null;
  } catch { return null; }
}

/** The Git toplevel and origin of an existing directory, or null. */
export function observeCheckout(dir) {
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return null;
  const root = gitRead(dir, ['rev-parse', '--show-toplevel']);
  if (!root || !path.isAbsolute(root)) return null;
  const urls = gitRead(root, ['config', '--get-all', 'remote.origin.url']);
  let origin = null, url = null;
  if (urls && !urls.includes('\n')) {
    try { origin = normalizeDomainOrigin(urls); url = urls; } catch { origin = null; }
  }
  return { root: canonicalPath(root), origin, url };
}

/** Strip comments and trailing commas from JSONC, respecting strings. */
export function stripJsonc(text) {
  let out = '', i = 0, inString = false;
  while (i < text.length) {
    const c = text[i], next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return dropTrailingCommas(out);
}

function dropTrailingCommas(text) {
  let out = '', inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

/** Folders listed by a VS Code `.code-workspace` file, resolved against it. */
export function workspaceFolders(file) {
  const { text, path: resolved } = readBounded(file, 'workspace file');
  let doc;
  try { doc = JSON.parse(stripJsonc(text)); } catch { throw failure('workspace file is not valid JSON with comments'); }
  if (!doc || !Array.isArray(doc.folders)) throw failure('workspace file has no folders list');
  if (doc.folders.length > MAX_CANDIDATES) throw failure(`workspace file lists more than ${MAX_CANDIDATES} folders`);
  const base = path.dirname(resolved);
  return doc.folders.map(folder => {
    if (!folder || !bounded(folder.path)) throw failure('workspace folder entries need a path');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(folder.path)) throw failure('remote workspace folders (URIs) are unsupported; use local folders');
    return { dir: path.resolve(base, folder.path), name: bounded(folder.name, 128) ? folder.name : null };
  });
}

function frontMatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  try { return YAML.parse(match[1], { maxAliasCount: 0 }); } catch { return null; }
}

function cells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  return trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function linkTarget(cell) {
  const link = cell.match(/\]\(([^)\s]+)\)/) || cell.match(/<([^>\s]+)>/);
  return (link ? link[1] : cell.replace(/`/g, '')).trim();
}

const COLUMN = {
  url: /^(repo|repository|repo url|repository url|git|git url|origin)$/i,
  id: /^(id|name|component|service|microservice|module)$/i,
  asset: /^(asset|domain area|group|system)$/i,
  role: /^(role|type|kind)$/i,
};

/** Repository rows from Markdown tables whose header names a repo column. */
export function markdownRepoTables(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i++) {
    const header = cells(lines[i]), divider = cells(lines[i + 1]);
    if (!header || !divider || !divider.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
    const column = key => header.findIndex(cell => COLUMN[key].test(cell.replace(/[*_`]/g, '')));
    const urlAt = column('url');
    if (urlAt < 0) continue;
    const idAt = column('id'), assetAt = column('asset'), roleAt = column('role');
    for (let j = i + 2; j < lines.length; j++) {
      const row = cells(lines[j]);
      if (!row) break;
      const url = linkTarget(row[urlAt] || '');
      if (!looksLikeUrl(url)) continue;
      try { normalizeDomainOrigin(url); } catch { continue; }
      rows.push({ url, id: idAt >= 0 ? row[idAt] : null, asset: assetAt >= 0 ? row[assetAt] : null, role: roleAt >= 0 ? row[roleAt] : null });
    }
  }
  return rows;
}

function manifestRepos(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw failure(`${label} repos must be a list`);
  return value.map(entry => {
    if (typeof entry === 'string') return { url: entry };
    if (!entry || typeof entry !== 'object') throw failure(`${label} repo entries must be URLs or mappings`);
    const text = value => (typeof value === 'string' && bounded(value, 1024) ? value : null);
    const url = text(entry.url ?? entry.origin ?? entry.repo ?? entry.repository);
    return { url, id: text(entry.id ?? entry.name), asset: text(entry.asset), role: text(entry.role), component: text(entry.component), path: text(entry.path) };
  });
}

/** Repositories a spec repository declares, from a manifest, `repos` front
 * matter or Markdown repository tables in its top-level documents. */
export function specRepos(specRoot) {
  const found = [], repos = [];
  for (const rel of SPEC_MANIFESTS) {
    const full = assertNoSymlinkAncestors(specRoot, rel);
    if (!full || !fs.lstatSync(full, { throwIfNoEntry: false })?.isFile()) continue;
    const text = readFileNoFollow(full, { root: specRoot, maxBytes: MAX_INPUT_BYTES });
    if (text === null) throw failure(`spec manifest ${rel} is unreadable or oversized`);
    let doc;
    try { doc = YAML.parse(text, { maxAliasCount: 0 }); } catch { throw failure(`spec manifest ${rel} is not valid YAML`); }
    repos.push(...manifestRepos(doc?.repos, rel));
    found.push(rel);
    break;
  }
  for (const rel of SPEC_DOCUMENTS) {
    const full = assertNoSymlinkAncestors(specRoot, rel);
    if (!full || !fs.lstatSync(full, { throwIfNoEntry: false })?.isFile()) continue;
    const text = readFileNoFollow(full, { root: specRoot, maxBytes: MAX_INPUT_BYTES });
    if (text === null) continue;
    const before = repos.length;
    repos.push(...manifestRepos(frontMatter(text)?.repos, rel), ...markdownRepoTables(text));
    if (repos.length > before) found.push(rel);
  }
  return { repos, found };
}

/** A lowercase domain ID from a free name or a repository URL. */
export function idFrom(value) {
  const base = String(value || '').replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() || '';
  const id = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 64).replace(/-+$/, '');
  return NAME.test(id) ? id : null;
}

function uniqueId(wanted, taken) {
  let id = wanted, n = 2;
  while (taken.has(id)) id = `${wanted.slice(0, 60)}-${n++}`;
  taken.add(id);
  return id;
}

/** Remove spec sources whose asset or component scope is gone; returns the removed ones. */
function pruneSpecScopes(specSources, assets) {
  const assetIds = new Set((assets || []).map(a => a.id));
  const componentIds = new Set((assets || []).flatMap(a => a.components.map(c => c.id)));
  const live = ref => ref.scope === 'domain' || (ref.scope.startsWith('asset/') && assetIds.has(ref.scope.slice(6))) || (ref.scope.startsWith('component/') && componentIds.has(ref.scope.slice(10)));
  const dropped = specSources.filter(ref => !live(ref));
  for (const ref of dropped) specSources.splice(specSources.indexOf(ref), 1);
  return dropped;
}

/** A target that is missing, or an empty real directory, can take a clone. */
function cloneTargetFree(target) {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return true;
  return stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(target).length === 0;
}

function draftPath(home, name) { return path.join(home, 'domains', `${name}.draft.yaml`); }

function selectedHome(home) {
  return safeDirectory(path.resolve(home), 'Harness home');
}

function existingConfig(name, home) {
  if (!fs.existsSync(path.join(home, 'domains', `${name}.yaml`))) return null;
  const { config } = readDomain(name, { home });
  if (config.domain_version !== 2) throw failure('an existing version 1 domain cannot be extended by init; migrate it to version 2 first');
  return config;
}

function parsePairs(entries, flag) {
  return (entries || []).map(entry => {
    const split = entry.indexOf('=');
    if (split < 1) throw failure(`${flag} expects id=value`, 'E_USAGE');
    const id = entry.slice(0, split), value = entry.slice(split + 1);
    if (!NAME.test(id) || id.length > 64) throw failure(`${flag} id must be a lowercase hyphenated name`, 'E_USAGE');
    if (!bounded(value)) throw failure(`${flag} requires a value`, 'E_USAGE');
    return { id, value };
  });
}

function looksLikeUrl(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[^@/:\s]+@[^@/:\s]+:/.test(value);
}

/**
 * Build or extend a draft from the named inputs. Writes
 * `<home>/domains/<name>.draft.yaml` unless dryRun, and returns it.
 */
export function initDomainDraft({ name, home, fromWorkspace = null, fromSpec = null, repos: repoFlags = [], assets: assetFlags = [], cloneRoot = null, dryRun = false }) {
  if (!NAME.test(name)) throw failure('--name must be a lowercase hyphenated name', 'E_USAGE');
  if (!fromWorkspace && !fromSpec && !repoFlags.length) throw failure('init needs --from-workspace, --from-spec or at least one --repo', 'E_USAGE');
  home = selectedHome(home);
  const existing = existingConfig(name, home);
  // A pending draft already holds the published config plus earlier inputs,
  // so a second init extends it rather than starting over.
  const prior = fs.existsSync(draftPath(home, name)) ? readDraft(home, name).draft : null;
  const base = prior?.config || existing;
  const repos = base ? base.repos.map(repo => ({ ...repo })) : [];
  const bindings = { repos: { ...(base?.bindings?.repos || {}) }, sources: { ...(base?.bindings?.sources || {}) } };
  const sources = base?.sources ? base.sources.map(source => ({ ...source })) : [];
  const assets = base?.assets ? base.assets.map(asset => ({ id: asset.id, components: asset.components.map(c => ({ ...c })) })) : [];
  const specSources = base?.spec_sources ? base.spec_sources.map(ref => ({ ...ref })) : [];
  const taken = new Set([...repos.map(r => r.id), ...sources.map(s => s.id)]);
  const byOrigin = new Map(repos.filter(r => r.origin).map(r => [r.origin, r]));
  const urls = Object.fromEntries((prior?.clones || []).map(clone => [clone.repo, clone.url]));
  const notes = [], inputs = [];
  let defaultCloneRoot = null;

  const addRepo = ({ id = null, origin = null, url = null, root = null, asset = null, role = null, path: subpath = null }) => {
    let entry = origin ? byOrigin.get(origin) : null;
    // A local-identity checkout is recognised again by its bound root.
    if (!entry && !origin && root) entry = repos.find(r => !r.origin && bindings.repos[r.id] === root) || null;
    if (!entry) {
      const wanted = (id && NAME.test(id) ? id : null) || idFrom(id) || idFrom(url) || idFrom(root);
      if (!wanted) { notes.push(`skipped a repository without a usable name: ${url || root}`); return null; }
      if (repos.length >= MAX_CANDIDATES) throw failure(`a domain holds at most ${MAX_CANDIDATES} repositories`);
      entry = origin ? { id: uniqueId(wanted, taken), origin } : { id: uniqueId(wanted, taken), local_identity: { id: wanted, approved: true } };
      repos.push(entry);
      if (origin) byOrigin.set(origin, entry);
    }
    if (url) urls[entry.id] = url;
    if (root && !bindings.repos[entry.id]) bindings.repos[entry.id] = root;
    if (asset) {
      const assetId = idFrom(asset);
      if (assetId) {
        let group = assets.find(a => a.id === assetId);
        if (!group) { group = { id: assetId, components: [] }; assets.push(group); }
        if (!assets.some(a => a.components.some(c => c.repo === entry.id && (c.path ?? null) === (subpath ?? null)))) {
          const componentIds = new Set(assets.flatMap(a => a.components.map(c => c.id)));
          group.components.push({ id: uniqueId(entry.id, componentIds), repo: entry.id, ...(subpath ? { path: subpath } : {}), ...(role && NAME.test(String(role).toLowerCase()) ? { role: String(role).toLowerCase() } : {}) });
        }
      }
    }
    return entry;
  };

  const addCheckout = (dir, id = null) => {
    const checkout = observeCheckout(dir);
    if (!checkout) { notes.push(`not a Git checkout, skipped: ${dir}`); return null; }
    if (!checkout.origin) notes.push(`${checkout.root} has no single usable origin; it joins as a local identity`);
    return addRepo({ id, origin: checkout.origin, url: checkout.url, root: checkout.root });
  };

  if (fromWorkspace) {
    const folders = workspaceFolders(fromWorkspace);
    inputs.push({ kind: 'workspace', path: safeDirectory(path.resolve(fromWorkspace), 'workspace file') });
    for (const folder of folders) addCheckout(folder.dir, folder.name ? idFrom(folder.name) : null);
    defaultCloneRoot ??= path.dirname(safeDirectory(path.resolve(fromWorkspace), 'workspace file'));
  }

  if (fromSpec) {
    const specDir = safeDirectory(path.resolve(fromSpec), 'spec repository');
    const checkout = observeCheckout(specDir);
    if (!checkout) throw failure('--from-spec must name a local Git checkout of the spec repository');
    let source = checkout.origin ? sources.find(s => s.origin === checkout.origin) : sources.find(s => !s.origin && bindings.sources[s.id] === checkout.root);
    if (!source) {
      source = checkout.origin ? { id: uniqueId(idFrom(checkout.url) || 'spec', taken), origin: checkout.origin } : { id: uniqueId(idFrom(checkout.root) || 'spec', taken), local_identity: { id: idFrom(checkout.root) || 'spec', approved: true } };
      sources.push(source);
    }
    // An existing binding is kept; ae domain bind moves it deliberately.
    if (bindings.sources[source.id] && bindings.sources[source.id] !== checkout.root) notes.push(`source ${source.id} stays bound to ${bindings.sources[source.id]}; use ae domain bind --source ${source.id}=<path> to move it`);
    bindings.sources[source.id] ??= checkout.root;
    if (!specSources.some(ref => ref.source === source.id && ref.scope === 'domain')) specSources.push({ source: source.id, scope: 'domain', include: [], authority: 'reference' });
    const declared = specRepos(checkout.root);
    inputs.push({ kind: 'spec', path: checkout.root, manifests: declared.found });
    if (!declared.repos.length) notes.push(`the spec repository lists no repositories in ${[...SPEC_MANIFESTS, ...SPEC_DOCUMENTS].join(', ')}`);
    for (const row of declared.repos) {
      let origin;
      try { origin = normalizeDomainOrigin(row.url); } catch (error) { notes.push(`skipped spec repository ${String(row.url).slice(0, 200)}: ${error.message}`); continue; }
      addRepo({ id: row.id ? idFrom(row.id) : null, origin, url: row.url, asset: row.asset, role: row.role, path: row.path });
    }
    // Clones sit beside the spec repository unless --clone-root says otherwise.
    defaultCloneRoot = path.dirname(checkout.root);
  }

  for (const { id, value } of parsePairs(repoFlags, '--repo')) {
    if (looksLikeUrl(value)) {
      const origin = normalizeDomainOrigin(value);
      addRepo({ id, origin, url: value });
    } else {
      if (!path.isAbsolute(value)) throw failure('--repo paths must be absolute', 'E_USAGE');
      addCheckout(safeDirectory(value, `--repo ${id}`), id);
    }
    inputs.push({ kind: 'flag', repo: id });
  }

  for (const { id, value } of parsePairs(assetFlags, '--asset')) {
    const members = value.split(',').map(part => part.trim()).filter(Boolean);
    let group = assets.find(a => a.id === id);
    if (!group) { group = { id, components: [] }; assets.push(group); }
    for (const member of members) {
      if (!repos.some(r => r.id === member)) throw failure(`--asset ${id} names an unknown repo: ${member}`, 'E_USAGE');
      // The whole repository moves into this asset; a moved component keeps its ID.
      let kept = null;
      for (const other of assets) {
        kept ??= other.components.find(c => c.repo === member && !c.path) || null;
        other.components = other.components.filter(c => !(c.repo === member && !c.path));
      }
      const componentIds = new Set(assets.flatMap(a => a.components.map(c => c.id)));
      group.components.push(kept ? (componentIds.add(kept.id), kept) : { id: uniqueId(member, componentIds), repo: member });
    }
  }
  for (let i = assets.length - 1; i >= 0; i--) if (!assets[i].components.length) assets.splice(i, 1);
  for (const ref of pruneSpecScopes(specSources, assets)) notes.push(`dropped spec source ${ref.source} for ${ref.scope}: that scope no longer exists`);

  if (!repos.length) throw failure('the inputs named no usable repositories');
  defaultCloneRoot ??= Object.values(bindings.repos)[0] ? path.dirname(Object.values(bindings.repos)[0]) : null;
  const root = cloneRoot ? safeDirectory(cloneRoot, '--clone-root') : defaultCloneRoot;
  const clones = [];
  for (const repo of repos) {
    if (bindings.repos[repo.id]) continue;
    if (!repo.origin) { notes.push(`${repo.id} has no origin and no checkout; it cannot be cloned`); continue; }
    if (!root) throw failure('some repositories are not checked out; pass --clone-root <absolute path> for their clones', 'E_USAGE');
    const target = path.join(root, repo.id);
    const present = observeCheckout(target);
    if (present && present.origin === repo.origin && present.root === canonicalPath(target)) { bindings.repos[repo.id] = present.root; continue; }
    if (!cloneTargetFree(target)) { notes.push(`clone target ${target} exists and is not a checkout of ${repo.origin}; bind ${repo.id} with ae domain bind after accepting, or pass another --clone-root`); continue; }
    clones.push({ repo: repo.id, url: urls[repo.id] || `${repo.origin}.git`, path: target });
  }

  const config = { domain_version: 2, name, repos, sources, bindings, ...(base?.shared_specs?.length ? { shared_specs: base.shared_specs } : {}), ...(base?.shared_conventions?.length ? { shared_conventions: base.shared_conventions } : {}), ...(assets.length ? { assets } : {}), ...(specSources.length ? { spec_sources: specSources } : {}) };
  // Validate everything except the bindings that clones will supply.
  const probe = structuredClone(config);
  for (const clone of clones) probe.bindings.repos[clone.repo] = clone.path;
  for (const repo of repos) if (!probe.bindings.repos[repo.id]) delete probe.bindings.repos[repo.id];
  const unbound = repos.filter(repo => !probe.bindings.repos[repo.id]).map(repo => repo.id);
  if (!unbound.length) validateDomainConfig(probe, name);
  const draft = { draft_version: DRAFT_VERSION, config, clones };
  const file = draftPath(home, name);
  if (!dryRun && !writeFileContained(home, path.relative(home, file), YAML.stringify(draft))) throw failure('could not write the domain draft');
  return {
    verb: 'init', status: 'ok', exitCode: 0, stage: 'draft', name, home, draftPath: file, written: !dryRun, extended: Boolean(existing),
    inputs, repos: repos.map(repo => ({ id: repo.id, origin: repo.origin ?? null, binding: bindings.repos[repo.id] ?? null, clone: clones.find(c => c.repo === repo.id)?.path ?? null })),
    assets, specSources, clones, unbound, notes,
    next: unbound.length ? `bind or remove ${unbound.join(', ')} in the draft, then: ae domain init --name ${name} --accept` : `review ${file}, then: ae domain init --name ${name} --accept`,
  };
}

function cloneHead({ url, path: target }) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // The user's own Git configuration and credential helpers apply; prompts
  // are disabled so an unattended run fails instead of hanging.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  // Only network transports by default; remote helpers and ext:: stay off
  // unless the user's own config allows a protocol by name.
  const protocols = ['-c', 'protocol.allow=never', ...['https', 'http', 'ssh', 'git'].flatMap(p => ['-c', `protocol.${p}.allow=always`])];
  const result = spawnGitSync([...protocols, 'clone', '--depth', '1', '--single-branch', '--no-tags', '--', url, target], { env, encoding: 'utf8', timeout: CLONE_TIMEOUT, maxBuffer: 1024 * 1024 });
  if (result?.status === 0) return { ok: true };
  const reason = String(result?.stderr || result?.error?.message || 'clone failed').trim().split('\n').pop().slice(0, 300);
  try { if (fs.existsSync(target) && !fs.readdirSync(target).length) fs.rmdirSync(target); } catch {}
  return { ok: false, reason };
}

function readDraft(home, name) {
  const file = draftPath(home, name);
  const text = readFileNoFollow(file, { root: home, maxBytes: MAX_INPUT_BYTES });
  if (text === null) throw failure(`no draft for ${name}; run ae domain init --name ${name} with an input first`);
  let draft;
  try { draft = YAML.parse(text, { maxAliasCount: 0 }); } catch { throw failure('the domain draft is not valid YAML'); }
  const mapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const members = value => value === undefined || (Array.isArray(value) && value.every(m => mapping(m) && typeof m.id === 'string'));
  const shaped = draft?.draft_version === DRAFT_VERSION && mapping(draft.config) && Array.isArray(draft.clones) && draft.clones.every(mapping)
    && Array.isArray(draft.config.repos) && members(draft.config.repos) && members(draft.config.sources)
    && mapping(draft.config.bindings) && [draft.config.bindings.repos, draft.config.bindings.sources].every(b => b === undefined || mapping(b))
    && (draft.config.assets === undefined || (Array.isArray(draft.config.assets) && draft.config.assets.every(a => mapping(a) && Array.isArray(a.components) && a.components.every(mapping))))
    && (draft.config.spec_sources === undefined || (Array.isArray(draft.config.spec_sources) && draft.config.spec_sources.every(r => mapping(r) && typeof r.scope === 'string')));
  if (!shaped) throw failure(`the domain draft has an unsupported shape; fix or delete ${file} and run init again`);
  if (draft.config.name !== name) throw failure('the domain draft names another domain');
  return { draft, file };
}

/** Two repositories of one domain cannot share a checkout. */
function assertDistinctRepoBindings(validated) {
  const seen = new Map();
  for (const repo of validated.repos) {
    const root = validated.bindings.repos[repo.id];
    if (seen.has(root)) throw failure(`repositories ${seen.get(root)} and ${repo.id} are both bound to ${root}`);
    seen.set(root, repo.id);
  }
}

/** The validated config in its canonical published form. */
function publishable(validated) {
  const { shared_specs: specs, shared_conventions: conventions, ...rest } = validated;
  return { ...rest, ...(specs?.length ? { shared_specs: specs } : {}), ...(conventions?.length ? { shared_conventions: conventions } : {}) };
}

/** Clone the draft's missing repositories and publish the domain config. */
export function acceptDomainDraft({ name, home, dryRun = false }) {
  if (!NAME.test(name)) throw failure('--name must be a lowercase hyphenated name', 'E_USAGE');
  home = selectedHome(home);
  const { draft, file } = readDraft(home, name);
  const config = structuredClone(draft.config);
  config.bindings ??= { repos: {}, sources: {} };
  config.bindings.repos ??= {};
  config.bindings.sources ??= {};
  const repoIds = new Set((config.repos || []).map(repo => repo?.id));
  const cloned = [], failed = [], pending = [];
  for (const clone of draft.clones) {
    if (!clone || !repoIds.has(clone.repo) || !bounded(clone.url) || !bounded(clone.path) || !path.isAbsolute(clone.path)) throw failure('the domain draft has a malformed clone entry');
    const repo = config.repos.find(r => r.id === clone.repo);
    let origin;
    try { origin = normalizeDomainOrigin(clone.url); } catch (error) { throw failure(`clone URL for ${clone.repo} is unsupported: ${error.message}`); }
    if (origin !== repo.origin) throw failure(`clone URL for ${clone.repo} does not match its origin`);
    const target = safeDirectory(clone.path, `clone path for ${clone.repo}`);
    const present = observeCheckout(target);
    if (present && present.origin === origin && present.root === target) { config.bindings.repos[clone.repo] = target; continue; }
    if (!cloneTargetFree(target)) { failed.push({ repo: clone.repo, path: target, reason: 'target exists and is not this repository' }); pending.push(clone); continue; }
    if (dryRun) { cloned.push({ repo: clone.repo, path: target, dryRun: true }); config.bindings.repos[clone.repo] = target; continue; }
    const outcome = cloneHead({ url: clone.url, path: target });
    if (outcome.ok) { cloned.push({ repo: clone.repo, path: target }); config.bindings.repos[clone.repo] = canonicalPath(target); } else { failed.push({ repo: clone.repo, path: target, reason: outcome.reason }); pending.push(clone); }
  }
  // Repositories still without a checkout stay in the draft for a retry.
  const unbound = config.repos.filter(repo => !config.bindings.repos[repo.id]).map(repo => repo.id);
  const published = structuredClone(config);
  if (unbound.length) {
    published.repos = published.repos.filter(repo => !unbound.includes(repo.id));
    if (published.assets) {
      published.assets = published.assets.map(asset => ({ ...asset, components: asset.components.filter(c => !unbound.includes(c.repo)) })).filter(asset => asset.components.length);
      if (!published.assets.length) delete published.assets;
    }
    if (published.spec_sources) {
      pruneSpecScopes(published.spec_sources, published.assets);
      if (!published.spec_sources.length) delete published.spec_sources;
    }
  }
  if (!published.repos.length) throw failure(`no repository could be bound; failed: ${failed.map(f => `${f.repo} (${f.reason})`).join('; ') || unbound.join(', ')}`);
  const validated = validateDomainConfig(published, name);
  assertDistinctRepoBindings(validated);
  const warnings = [];
  for (const repo of validated.repos) {
    if (dryRun && cloned.some(c => c.repo === repo.id)) continue;
    const observed = observeDomainRepositoryIdentity(validated.bindings.repos[repo.id], repo);
    const mismatch = observed.warnings.find(w => /differs|unavailable/i.test(w));
    if (observed.status !== 'available' || mismatch) throw failure(`${repo.id}: ${mismatch || observed.warnings[0] || `checkout at ${validated.bindings.repos[repo.id]} is ${observed.status}`}`);
  }
  for (const source of validated.sources) {
    const observed = observeDomainRepositoryIdentity(validated.bindings.sources[source.id], source);
    const mismatch = observed.warnings.find(w => /differs|unavailable/i.test(w));
    if (mismatch) warnings.push(`${source.id}: ${mismatch}`);
  }
  const configPath = path.join(home, 'domains', `${name}.yaml`);
  if (!dryRun) {
    if (!writeFileContained(home, path.relative(home, configPath), YAML.stringify(publishable(validated)))) throw failure('could not write the domain config');
    if (pending.length) {
      const rest = { draft_version: DRAFT_VERSION, config, clones: pending };
      if (!writeFileContained(home, path.relative(home, file), YAML.stringify(rest))) throw failure('could not update the domain draft');
    } else fs.rmSync(file, { force: true });
  }
  return {
    verb: 'init', status: failed.length ? 'partial' : 'ok', exitCode: 0, stage: 'accepted', name, home, configPath, written: !dryRun,
    repos: validated.repos.map(repo => ({ id: repo.id, binding: validated.bindings.repos[repo.id] })),
    cloned, failed, unbound, warnings,
    ...(pending.length ? { draftPath: file, next: `fix the failed clones, then rerun: ae domain init --name ${name} --accept` } : {}),
  };
}

/** Point an existing domain repo or source at a local checkout. */
export function bindDomain({ name, home, repos: repoFlags = [], sources: sourceFlags = [], dryRun = false }) {
  if (!repoFlags.length && !sourceFlags.length) throw failure('bind needs --repo id=<path> or --source id=<path>', 'E_USAGE');
  home = selectedHome(home);
  const config = existingConfig(name, home);
  if (!config) throw failure(`domain ${name} does not exist; create it with ae domain init`);
  const next = structuredClone(config);
  const changed = [];
  for (const [kind, entries, flag] of [['repos', repoFlags, '--repo'], ['sources', sourceFlags, '--source']]) {
    for (const { id, value } of parsePairs(entries, flag)) {
      const member = next[kind].find(m => m.id === id);
      if (!member) throw failure(`${flag} ${id} is not a ${kind === 'repos' ? 'repository' : 'source'} of ${name}`, 'E_USAGE');
      if (!path.isAbsolute(value)) throw failure(`${flag} paths must be absolute`, 'E_USAGE');
      const checkout = observeCheckout(safeDirectory(value, `${flag} ${id}`));
      if (!checkout) throw failure(`${value} is not a Git checkout`);
      if (member.origin && checkout.origin !== member.origin) throw failure(`${value} has origin ${checkout.origin ?? 'unknown'}, expected ${member.origin}`);
      next.bindings[kind][id] = checkout.root;
      changed.push({ kind, id, binding: checkout.root });
    }
  }
  const validated = validateDomainConfig(next, name);
  assertDistinctRepoBindings(validated);
  const configPath = path.join(home, 'domains', `${name}.yaml`);
  if (!dryRun && !writeFileContained(home, path.relative(home, configPath), YAML.stringify(publishable(validated)))) throw failure('could not write the domain config');
  return { verb: 'bind', status: 'ok', exitCode: 0, name, home, configPath, written: !dryRun, changed, repos: validated.repos.map(repo => ({ id: repo.id, binding: validated.bindings.repos[repo.id] })) };
}
