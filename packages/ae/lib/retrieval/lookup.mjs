import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from '../style.mjs';
import { redactSecrets } from '../secret-scan.mjs';
import { readFileNoFollow } from '../fs-safe.mjs';
import { safeResolveUnderRoot } from '../path-safe.mjs';
import { findEntryByDocid, resolveDocPath } from '../recall-rank.mjs';
import { storeDir, listLearnings } from '../knowledge/store.mjs';
import { collectEpisodes } from '../knowledge/consolidate.mjs';
import { readStructuralIndex } from '../structural/shape.mjs';
import { planReadDirs } from '../project-layout.mjs';
import { getCorpusRoot } from '../assets.mjs';
import { projectAuthorityFile } from '../project-authority.mjs';
import { assertSourceCurrent, parseSourceReference, sourceHash } from './source-evidence.mjs';

/** The settled kind list, in the order the architecture doc states it. */
export const LOOKUP_KINDS = Object.freeze([
  'file',
  'symbol',
  'document',
  'plan',
  'skill',
  'check',
  'run',
  'event',
  'resource',
  'learning',
  'episode',
]);

export const LOOKUP_KIND_SUMMARIES = Object.freeze({
  file: 'a tracked workspace file by relative path',
  symbol: 'a declaration by name, from the structural index',
  document: 'a knowledge doc by manifest docid',
  plan: 'a plan under .harness/plans or docs/plans by filename',
  skill: 'a skill by its directory name under the Copilot home or the packaged corpus',
  check: 'a named check from the trusted check config',
  run: 'a recorded run (Phase 4a)',
  event: 'the events of one session id',
  resource: 'an installed resource bundle (Phase 5)',
  learning: 'a learning by <domain>/<slug>',
  episode: 'an episode by path, or path@sha256',
});

export const PENDING_KINDS = Object.freeze({
  run: 'Phase 4a (durable runs) creates the run journal',
  resource: 'Phase 5 (resources and plugins) creates the resource model',
});

const PREVIEW_MAX_BYTES = 2048;
const PREVIEW_MAX_LINES = 40;

export function notFound({ kind, identifier, hint = null, related = [] }) {
  return Object.assign(new Error(`no ${kind} matching ${JSON.stringify(identifier)}`), {
    code: 'E_NOT_FOUND',
    exit: EXIT.notFound,
    hint,
    kind,
    identifier,
    related,
  });
}

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

/** Truncate on a UTF-8 boundary, then on a line boundary, then redact. */
function preview(raw) {
  if (typeof raw !== 'string') return null;
  let text = raw.split(/\r?\n/).slice(0, PREVIEW_MAX_LINES).join('\n');
  if (Buffer.byteLength(text, 'utf8') > PREVIEW_MAX_BYTES) {
    const buf = Buffer.from(text, 'utf8').subarray(0, PREVIEW_MAX_BYTES);
    text = buf.toString('utf8').replace(/�+$/, '');
  }
  return redactSecrets(text);
}

function readUnderWorkspace(workspace, rel) {
  const root = path.resolve(workspace);
  const full = safeResolveUnderRoot(root, rel);
  if (!full) return { escaped: true, raw: null, full: null };
  const bytes = readFileNoFollow(full, { root, encoding: null });
  return { escaped: false, raw: bytes?.toString('utf8') ?? null, bytes, full };
}

function fileEntity({ workspace, identifier }) {
  const reference = parseSourceReference(identifier);
  identifier = reference.path;
  const { escaped, raw, bytes, full } = readUnderWorkspace(workspace, identifier);
  if (escaped) {
    throw usageError(`path escapes the workspace: ${identifier}`, 'lookup file <workspace-relative-path>');
  }
  if (raw === null) throw notFound({ kind: 'file', identifier, hint: 'lookup file <workspace-relative-path>' });
  const sha256 = sourceHash(bytes);
  assertSourceCurrent(reference.sha256, sha256);
  return {
    kind: 'file',
    id: identifier,
    location: identifier,
    title: path.basename(identifier),
    provenance: { source: 'workspace', root: path.resolve(workspace) },
    metadata: { bytes: bytes.length, lines: raw.split(/\r?\n/).length, absent: !full, sha256 },
    preview: preview(raw),
    related: [],
  };
}

function symbolEntity({ workspace, identifier, home }) {
  const index = readStructuralIndex(workspace, { home, requireCurrent: true });
  if (!index.present) {
    throw notFound({
      kind: 'symbol',
      identifier,
      hint: `no structural index (${index.reason}) — build one with: ae index --structural`,
    });
  }
  const matches = (index.symbols || []).filter((s) => s.name === identifier);
  if (!matches.length) {
        const near = (index.symbols || [])
      .filter((s) => typeof s.name === 'string' && s.name.toLowerCase().includes(identifier.toLowerCase()))
      .slice(0, 5)
      .map((s) => ({ kind: 'symbol', id: s.name, location: s.file }));
    throw notFound({ kind: 'symbol', identifier, hint: 'exact symbol name; see related', related: near });
  }
  const first = matches[0];
  return {
    kind: 'symbol',
    id: identifier,
    location: first.file ? `${first.file}:${first.def?.line ?? ''}`.replace(/:$/, '') : null,
    title: identifier,
    provenance: { source: 'structural-index', generation: index.meta.sourceState.digest },
    metadata: {
      definitions: matches.length,
      exported: Boolean(first.exported),
      symbolKind: first.kind ?? null,
      references: Array.isArray(first.refs) ? first.refs.length : 0,
    },
    preview: null,
    related: matches.slice(1, 6).map((s) => ({ kind: 'symbol', id: s.name, location: s.file })),
  };
}

function documentEntity({ workspace, copilotHome, identifier, home }) {
  const entry = findEntryByDocid(copilotHome, workspace, identifier, { home });
  if (!entry) throw notFound({ kind: 'document', identifier, hint: 'a docid from the knowledge manifest' });
  const resolved = resolveDocPath(copilotHome, workspace, entry, { home });
  const raw = resolved?.full ? readFileNoFollow(resolved.full, { root: resolved.root }) : null;
  return {
    kind: 'document',
    id: entry.docid || entry.id || identifier,
    location: entry.path ?? null,
    title: entry.title ?? null,
    provenance: { source: 'knowledge-manifest', scope: entry.scope ?? null, docKind: entry.kind ?? null },
    metadata: { tags: entry.tags ?? [], module: entry.module ?? null, updated: entry.updated ?? entry.date ?? null },
    preview: preview(raw),
    related: [],
  };
}

function planEntity({ workspace, identifier }) {
  const name = path.posix.basename(String(identifier).replace(/\\/g, '/'));
  let rel = identifier;
  let raw = null;
  for (const { dir, label } of planReadDirs(workspace, { home: process.env.HARNESS_HOME })) {
    const full = path.join(dir, name);
    const text = readFileNoFollow(full, { root: dir });
    if (text === null) continue;
    rel = path.isAbsolute(label) ? full : `${label}/${name}`;
    raw = text;
    break;
  }
  if (raw === null) {
    const near = [];
    for (const { dir, label } of planReadDirs(workspace, { home: process.env.HARNESS_HOME })) {
      for (const f of fs.readdirSync(dir).filter((entry) => entry.endsWith('.md')).slice(0, 5)) {
        near.push({ kind: 'plan', id: f, location: path.isAbsolute(label) ? path.join(label, f) : `${label}/${f}` });
      }
    }
    throw notFound({ kind: 'plan', identifier, hint: 'a plan filename in docs/plans, .harness/plans, or the project store', related: near });
  }
  const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const field = (name) => fm.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
  return {
    kind: 'plan',
    id: path.posix.basename(rel),
    location: rel,
    title: field('title'),
    provenance: { source: 'workspace', root: path.resolve(workspace) },
    metadata: { status: field('status'), planLock: field('plan_lock'), phase: field('phase'), risk: field('risk') },
    preview: preview(raw),
    related: [],
  };
}

function skillEntity({ identifier, copilotHome }) {
  const rel = path.posix.join('skills', identifier, 'SKILL.md');
  const roots = [];
  if (process.env.AE_SKILLS_HOME) roots.push({ root: path.resolve(process.env.AE_SKILLS_HOME), rel: `${identifier}/SKILL.md`, source: 'host-skills' });
  else if (copilotHome) roots.push({ root: path.resolve(copilotHome), source: 'copilot-home' });
  try {
    if (!process.env.AE_SKILLS_HOME) roots.push({ root: getCorpusRoot(), source: 'corpus' });
  } catch {
    // A missing corpus still lets a home skill resolve.
  }
  for (const candidate of roots) {
    const full = safeResolveUnderRoot(candidate.root, candidate.rel || rel);
    if (!full) continue;
    const raw = readFileNoFollow(full, { root: candidate.root });
    if (raw === null) continue;
    const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const field = (name) => fm.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
    return {
      kind: 'skill',
      id: identifier,
      location: full,
      title: field('name') ?? identifier,
      provenance: { source: candidate.source, root: candidate.root },
      metadata: { description: field('description'), userInvocable: field('user-invocable') },
      preview: preview(raw),
      related: [],
    };
  }
  throw notFound({ kind: 'skill', identifier, hint: 'a skill directory name under the Copilot home or the packaged corpus' });
}

function checkEntity({ workspace, identifier, home }) {
  const source = projectAuthorityFile(workspace, 'checks.yaml', { home });
  const rel = source.mode === 'shared' ? '.github/harness/checks.yaml' : source.path;
  const raw = readFileNoFollow(source.path, { root: source.root, maxBytes: 1024 * 1024 });
  if (raw === null) throw notFound({ kind: 'check', identifier, hint: `no ${rel} in this workspace` });
  // Deliberately a line scan rather than a YAML parse: lookup is a read-only
  // navigation command and must not fail because an unrelated part of the file
  // is malformed. Named checks are top-level keys under `checks:`.
  const names = [...raw.matchAll(/^ {2}([A-Za-z0-9._-]+):/gm)].map((m) => m[1]);
  if (!names.includes(identifier)) {
    throw notFound({
      kind: 'check',
      identifier,
      hint: `a named check in ${rel}`,
      related: names.slice(0, 5).map((n) => ({ kind: 'check', id: n, location: rel })),
    });
  }
  const block = raw.split(new RegExp(`^ {2}${identifier}:`, 'm'))[1]?.split(/^ {2}\S/m)[0] ?? '';
  return {
    kind: 'check',
    id: identifier,
    location: rel,
    title: identifier,
    provenance: { source: 'trusted-check-config', root: path.resolve(workspace) },
    metadata: { timeoutSeconds: Number(block.match(/timeout_seconds:\s*(\d+)/)?.[1] ?? 0) || null },
    preview: preview(block.trim()),
    related: [],
  };
}

function learningEntity({ workspace, identifier, home }) {
  const dir = storeDir(workspace, { home });
  // Existence probe only — never create. listLearnings on an absent directory
  // returns empty, which keeps the read-path invariant (P2AC6) intact.
  const all = fs.existsSync(dir) ? listLearnings(dir) : [];
  const hit = all.find((l) => l.id === identifier);
  if (!hit) {
    const near = all
      .filter((l) => l.id.includes(identifier))
      .slice(0, 5)
      .map((l) => ({ kind: 'learning', id: l.id, location: l.file }));
    throw notFound({ kind: 'learning', identifier, hint: 'a learning id in the form <domain>/<slug>', related: near });
  }
  return {
    kind: 'learning',
    id: hit.id,
    location: hit.file ?? null,
    title: hit.fm?.trigger ?? null,
    provenance: {
      source: 'knowledge-store',
      status: hit.fm?.status ?? null,
      origin: hit.fm?.origin ?? null,
      commit: hit.fm?.commit ?? null,
      branch: hit.fm?.branch ?? null,
    },
    metadata: { domain: hit.domain ?? null, slug: hit.slug ?? null, bytes: hit.bytes ?? null },
    preview: preview(hit.body ?? null),
    related: [],
  };
}

function episodeEntity({ workspace, copilotHome, identifier, home }) {
  const episodes = collectEpisodes({ workspace, copilotHome, home });
  // `path@sha256` is the whole key, but addressing by bare path is the common
  // case and unambiguous whenever one episode holds that path.
  const byKey = episodes.find((e) => `${e.path}@${e.sha256}` === identifier);
  const byPath = byKey ? null : episodes.filter((e) => e.path === identifier);
  const hit = byKey || (byPath && byPath.length === 1 ? byPath[0] : null);
  if (!hit) {
    const ambiguous = byPath && byPath.length > 1;
    throw notFound({
      kind: 'episode',
      identifier,
      hint: ambiguous
        ? 'that path has several recorded revisions — address one as path@sha256'
        : 'an episode path, or path@sha256',
      related: (ambiguous ? byPath : episodes.slice(0, 5)).slice(0, 5).map((e) => ({
        kind: 'episode',
        id: `${e.path}@${e.sha256}`,
        location: e.path,
      })),
    });
  }
  return {
    kind: 'episode',
    id: `${hit.path}@${hit.sha256}`,
    location: hit.path,
    title: hit.title ?? null,
    provenance: { source: 'episodes', episodeKind: hit.kind ?? null, branch: hit.branch ?? null, date: hit.date ?? null },
    metadata: { sha256: hit.sha256, category: hit.category ?? null, tags: hit.tags ?? [], quarantined: Boolean(hit.quarantined) },
    preview: preview(hit.excerpt ?? null),
    related: [],
  };
}

function eventEntity({ workspace, identifier }) {
  const rel = '.harness/events.jsonl';
  const { raw } = readUnderWorkspace(workspace, rel);
  if (raw === null) throw notFound({ kind: 'event', identifier, hint: `no ${rel} in this workspace` });
  const rows = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  // Events carry no id of their own until the Phase 4a journal, so they are
  // addressed by session id — the only stable handle that exists today. Stated
  // rather than silently reinterpreting the identifier as something else.
  const matches = rows.filter((e) => e.session === identifier || e.sessionId === identifier);
  if (!matches.length) {
    throw notFound({
      kind: 'event',
      identifier,
      hint: 'events are addressed by session id until the Phase 4a run journal gives them stable ids',
    });
  }
  return {
    kind: 'event',
    id: identifier,
    location: rel,
    title: `${matches.length} event(s) for session ${identifier}`,
    provenance: { source: 'events', root: path.resolve(workspace) },
    metadata: { count: matches.length, types: [...new Set(matches.map((e) => e.type).filter(Boolean))].slice(0, 10) },
    preview: preview(matches.slice(0, 10).map((e) => JSON.stringify(e)).join('\n')),
    related: [],
  };
}

const RESOLVERS = {
  file: fileEntity,
  symbol: symbolEntity,
  document: documentEntity,
  plan: planEntity,
  skill: skillEntity,
  check: checkEntity,
  event: eventEntity,
  learning: learningEntity,
  episode: episodeEntity,
};

/**
 * Resolve one entity. Throws `E_USAGE` for a bad kind or missing identifier and
 * `E_NOT_FOUND` (exit 9) when the kind is valid but the entity is absent — the
 * distinction a caller scripting against lookup needs, and the reason
 * not-found does not collapse into either usage or an internal fault.
 */
export function lookupEntity({ kind, identifier, workspace, copilotHome, home }) {
  if (!kind) throw usageError('lookup requires a kind', `ae lookup <${LOOKUP_KINDS.join('|')}> <identifier>`);
  if (!LOOKUP_KINDS.includes(kind)) {
    throw usageError(`unknown lookup kind: ${kind}`, `one of ${LOOKUP_KINDS.join(', ')}`);
  }
  if (!identifier) throw usageError(`lookup ${kind} requires an identifier`, `ae lookup ${kind} <identifier>`);
  if (PENDING_KINDS[kind]) {
    throw notFound({ kind, identifier, hint: `${PENDING_KINDS[kind]}; nothing of this kind exists yet` });
  }
  const entity = RESOLVERS[kind]({ kind, identifier, workspace, copilotHome, home });
  return { schema: 1, ...entity };
}
