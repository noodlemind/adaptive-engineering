import { spawnGitSync } from '../corpus/hooks/lib/git-executable.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { assertNoSymlinkAncestors, readFileNoFollow, readPrefixNoFollow } from './fs-safe.mjs';
import { gitMetadataEnvironment } from '../corpus/hooks/lib/product-diff.mjs';

const PATH_CAP = 8;
const LINE_BUDGET = 512;
const LINE_SEPARATOR = ', ';

/**
 * @typedef {'frozen'|'selected'|'missing'|'omitted'|'none'} ObligationReason
 * @typedef {{ path: string, kind: string|null }} IntentSource
 * @typedef {{ candidateCount: number, selectedCount: number, omittedCount: number, bytes: number, truncated: boolean }} IntentMetadata
 * @typedef {{ reason: ObligationReason, paths: IntentSource[], metadata: IntentMetadata }} IntentObligation
 */

function kindOf(rel) {
  const posix = String(rel || '').replace(/\\/g, '/');
  if (posix === '.specify/memory/constitution.md') return 'spec';
  const lower = posix.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (/(^|\/)(adr|adrs|decisions)(\/|$)/.test(lower) || /^adr[-.]/.test(base) || base.endsWith('.adr.md')) return 'adr';
  if (/(^|\/)(rfc|rfcs)(\/|$)/.test(lower) || base.endsWith('.rfc.md')) return 'rfc';
  if (/(^|\/)(intent|intents)(\/|$)/.test(lower) || base.endsWith('.intent.md')) return 'intent';
  if (/(^|\/)(spec|specs)(\/|$)/.test(lower) || base.endsWith('.spec.md')) return 'spec';
  if (/(^|\/)issues?(\/|$)/.test(lower)) return 'issue';
  return null;
}

function queryTokens(text) {
  const seen = new Set();
  const tokens = [];
  for (const token of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length <= 1 || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function prefixText(workspace, rel) {
  try {
    const full = assertNoSymlinkAncestors(workspace, rel);
    if (!full) return '';
    const buf = readPrefixNoFollow(full, { root: workspace });
    if (!buf || buf.length === 0) return '';
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function scoreSource(item, tokens, prefix) {
  const body = prefix.includes('\0') ? '' : prefix;
  const hay = `${item.path} ${item.kind} ${body}`.toLowerCase();
  return tokens.reduce((count, token) => count + (hay.includes(token) ? 1 : 0), 0);
}

function preferredBasename(item) {
  const base = item.path.slice(item.path.lastIndexOf('/') + 1);
  return base === 'spec.md' || base === 'constitution.md' ? 0 : 1;
}

function catalog(workspace) {
  if (!workspace) return [];
  const listed = spawnGitSync(['-C', workspace, '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'buffer',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: { ...gitMetadataEnvironment(), LC_ALL: 'C' },
  });
  if (listed.status !== 0 || !listed.stdout) {
    if (!listed.error && listed.stderr?.toString('utf8').includes('fatal: not a git repository')) return [];
    throw Object.assign(new Error('Intent catalog unavailable; Git source enumeration failed or exceeded its bounds'), { code: 'E_INTENT_CATALOG' });
  }
  const found = [];
  for (const rel of listed.stdout.toString('utf8').split('\0')) {
    if (!rel) continue;
    const posix = rel.replace(/\\/g, '/');
    if (posix === '.harness' || posix.startsWith('.harness/')) continue;
    const kind = kindOf(posix);
    if (!kind) continue;
    found.push({ path: posix, kind });
  }
  return found;
}

export function obligationLine(paths) {
  return (paths || []).map((item) => item.path).join(LINE_SEPARATOR);
}

function takeLine(ranked) {
  const kept = [];
  for (const item of ranked) {
    if (kept.length >= PATH_CAP) break;
    const next = kept.concat(item);
    if (Buffer.byteLength(obligationLine(next), 'utf8') > LINE_BUDGET) break;
    kept.push(item);
  }
  return kept.map(({ path, kind }) => ({ path, kind }));
}

function rankedIntent(workspace, text) {
  const tokens = queryTokens(text);
  const ranked = catalog(workspace);
  for (const item of ranked) {
    item.score = tokens.length === 0 ? 0 : scoreSource(item, tokens, prefixText(workspace, item.path));
  }
  ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const prefer = preferredBasename(a) - preferredBasename(b);
    if (prefer) return prefer;
    return a.path.localeCompare(b.path);
  });
  return ranked;
}

function metadataFor(candidates, paths) {
  const selected = new Set(paths.map(source => source.path));
  const omittedCount = candidates.filter(source => !selected.has(source.path)).length;
  return {
    candidateCount: candidates.length,
    selectedCount: paths.length,
    omittedCount,
    bytes: Buffer.byteLength(obligationLine(paths), 'utf8'),
    truncated: omittedCount > 0,
  };
}

export function discoverIntent(workspace, text = '') {
  const ranked = rankedIntent(workspace, text);
  const paths = takeLine(ranked);
  return { paths, metadata: metadataFor(ranked, paths) };
}

export function selectIntent(workspace, text = '') {
  return discoverIntent(workspace, text).paths;
}

export function intentPage(workspace, text = '', { page = 1, pageSize = PATH_CAP } = {}) {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 32) {
    throw Object.assign(new Error('Intent page must be a positive safe integer; pageSize must be between 1 and 32'), { code: 'E_INTENT_PAGE' });
  }
  const ranked = rankedIntent(workspace, text);
  const pageCount = Math.ceil(ranked.length / pageSize);
  const paths = page > pageCount ? [] : ranked.slice((page - 1) * pageSize, page * pageSize).map(({ path, kind }) => ({ path, kind }));
  return { paths, page, pageSize, pageCount, hasMore: page < pageCount, metadata: metadataFor(ranked, paths) };
}

export function resolveObligation(workspace, plan, text = '') {
  const stored = listedIntentSources(plan);
  if (plan && stored && stored.length) {
    const paths = stored.map((path) => ({ path, kind: kindOf(path) }));
    return { reason: 'frozen', paths, metadata: metadataFor(catalog(workspace), paths) };
  }
  const discovered = discoverIntent(workspace, plan ? (typeof plan.fm?.intent === 'string' ? plan.fm.intent : '') : text);
  if (!discovered.paths.length) return { reason: discovered.metadata.candidateCount ? 'omitted' : 'none', ...discovered };
  return { reason: plan ? 'missing' : 'selected', ...discovered };
}

export function sourcePath(value) {
  if (typeof value === 'string') return value.replace(/\\/g, '/').trim();
  if (value && typeof value === 'object' && typeof value.path === 'string') {
    return value.path.replace(/\\/g, '/').trim();
  }
  return '';
}

export function sourceHash(value) {
  if (value && typeof value === 'object' && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256)) {
    return value.sha256;
  }
  return null;
}

export function hashIntentFile(workspace, rel) {
  if (!workspace || !rel) return null;
  const full = assertNoSymlinkAncestors(workspace, rel);
  if (!full) return null;
  let stat = null;
  try {
    stat = fs.lstatSync(full);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const bytes = readFileNoFollow(full, { root: workspace, encoding: null });
  if (bytes == null) return null;
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function lockIntentSources(workspace, entries, { rehash = true } = {}) {
  const seen = new Set();
  const out = [];
  for (const entry of entries || []) {
    const rel = sourcePath(entry);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const kept = rehash ? null : sourceHash(entry);
    const sha256 = kept || hashIntentFile(workspace, rel);
    if (!sha256) throw Object.assign(new Error(`intent source unreadable: ${rel}`), { code: 'E_INTENT_SOURCE' });
    out.push({ path: rel, sha256 });
  }
  return out;
}

export function bindLockedIntentSources(workspace, entries, { query = '' } = {}) {
  const explicit = entries || [];
  return lockIntentSources(workspace, explicit.length ? explicit : selectIntent(workspace, query), { rehash: true });
}

export function listedIntentSources(plan) {
  const raw = plan?.fm?.intent_sources;
  if (!Array.isArray(raw)) return null;
  return raw.map(sourcePath).filter(Boolean);
}

export function intentSourcesCheck(plan, workspace) {
  const policy = plan?.fm?.intent_source_policy;
  if (policy !== undefined && policy !== 'content-v1' || (plan?.fm?.plan_schema === 2 || plan?.fm?.plan_format === 'short-v2') && policy !== 'content-v1') {
    return { id: 'C-intent-sources', pass: false, message: 'Unsupported intent source policy; upgrade or explicitly migrate the plan', severity: 'fail' };
  }
  if (policy === 'content-v1') {
    const entries = plan.fm.intent_sources ?? [];
    if (!Array.isArray(entries) || entries.some(entry => !sourcePath(entry) || !sourceHash(entry)) || new Set(entries.map(sourcePath)).size !== entries.length) return { id: 'C-intent-sources', pass: false, message: 'Selected intent sources require unique paths and accepted content hashes', severity: 'fail', policy };
    const sources = intentSourceBindings(plan, workspace);
    const stale = sources.filter(source => !source.accepted || source.accepted !== source.current);
    if (stale.length) return { id: 'C-intent-sources', pass: false, message: `Selected intent source changed or unreadable; accept an explicit amendment: ${stale.map(s => s.path).join(', ')}`, severity: 'fail', policy, stale };
  }
  const obligation = resolveObligation(workspace, plan);
  if (obligation.reason === 'omitted') {
    return { id: 'C-intent-sources', pass: false, message: `${obligation.metadata.candidateCount} in-repo intent source(s) omitted by compact bounds; retrieve an intent detail page and record reviewed intent_sources`, severity: 'fail', metadata: obligation.metadata };
  }
  if (obligation.reason === 'missing') {
    return {
      id: 'C-intent-sources',
      pass: false,
      message: `Read in-repo specs before implementing and record them on intent_sources. Missing: ${obligationLine(obligation.paths)}`,
      severity: 'fail',
    };
  }
  if (obligation.reason === 'none') {
    return { id: 'C-intent-sources', pass: true, message: 'no in-repo spec or intent sources', severity: 'ok', guarantee: policy ? 'content-bound' : 'legacy-paths-only' };
  }
  return {
    id: 'C-intent-sources',
    pass: true,
    message: `intent_sources covers ${obligation.paths.length} source(s)${policy ? '; selected bytes bound' : '; legacy paths-only guarantee; explicit migration is available'}`,
    severity: 'ok',
    guarantee: policy ? 'content-bound' : 'legacy-paths-only',
  };
}

export function intentSourceBindings(plan, workspace) {
  return (Array.isArray(plan?.fm?.intent_sources) ? plan.fm.intent_sources : []).map(entry => ({ path: sourcePath(entry), accepted: sourceHash(entry), current: hashIntentFile(workspace, sourcePath(entry)) }));
}
