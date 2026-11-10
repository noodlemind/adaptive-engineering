import fs from 'fs';
import path from 'path';
import { findEntryByDocid, resolveDocPath } from './recall-rank.mjs';
import { safeResolveUnderRoot } from './path-safe.mjs';
import { readFileNoFollow } from './fs-safe.mjs';
import { getCorpusRoot } from './assets.mjs';
import { assertSourceCurrent, parseSourceReference, sourceContext, sourceHash } from './retrieval/source-evidence.mjs';
import { redactSecrets } from './secret-scan.mjs';
import { externalPlansDir } from './project-layout.mjs';
import { domainContextOf, planRecordRoot } from './domain-context.mjs';
import { installedCorpusHomes, resolveInstalledReference } from './corpus-reference.mjs';

const PACKAGED_REL = /^(skills|agents|instructions)\//;
// Internal read provenance for the headless adapter; omitted from CLI JSON.
export const READ_SOURCE = Symbol('ae.readSource');

function resolvePackagedRel(relPath, copilotHome) {
  const normalized = path.posix.normalize(String(relPath).replace(/\\/g, '/'));
  if (!PACKAGED_REL.test(normalized)) return null;
  const roots = [];
  if (copilotHome) roots.push(path.resolve(copilotHome));
  try {
    roots.push(getCorpusRoot());
  } catch {
    // Fall through to the workspace when the package corpus is missing.
  }
  for (const root of roots) {
    const fullPath = safeResolveUnderRoot(root, normalized);
    if (fullPath && fs.existsSync(fullPath)) return { fullPath, readRoot: root };
  }
  return null;
}

function resolveReadPointer(fullPath, workspace, copilotHome, home) {
  if (!path.isAbsolute(fullPath)) return null;
  const roots = [{ root: workspace, allow: () => true },
    { root: copilotHome, allow: rel => PACKAGED_REL.test(rel) },
    { root: getCorpusRoot(), allow: rel => PACKAGED_REL.test(rel) },
    { root: externalPlansDir(workspace, { home }), allow: rel => !rel.includes('/') && /\.(?:md|hplan)$/.test(rel) }];
  for (const { root, allow } of roots) {
    if (!root) continue;
    const rel = path.relative(root, fullPath).replace(/\\/g, '/');
    if (!rel || !allow(rel)) continue;
    const safe = safeResolveUnderRoot(root, rel);
    if (safe) return { fullPath: safe, readRoot: root };
  }
  return null;
}

export const GET_DEFAULT_LINES = 40;
export const GET_DEFAULT_MAX_BYTES = 2048;

function truncateUtf8(text, maxBytes) {
  const marker = '\n…(truncated)';
  const markerBytes = Buffer.byteLength(marker);
  if (maxBytes < markerBytes) return new TextDecoder().decode(Buffer.from(marker).subarray(0, maxBytes), { stream: true });
  const prefix = new TextDecoder().decode(Buffer.from(text).subarray(0, maxBytes - markerBytes), { stream: true });
  return prefix + marker;
}

export function runGet({ workspace, copilotHome, flags, home, authorizedPlan = null }) {
  const reference = parseSourceReference(flags.docid || flags.path);
  const documentReference = reference.sha256 && reference.path.startsWith('docid:');
  const docid = documentReference ? reference.path.slice('docid:'.length) : flags.docid ? reference.path : null;
  let relPath = flags.path && !documentReference ? reference.path : null;
  const maxLines = flags.lines || GET_DEFAULT_LINES;
  const maxBytes = flags.maxBytes || GET_DEFAULT_MAX_BYTES;
  const offset = Math.max(1, Math.floor(flags.offset || 1));
  const workspaceResolved = path.resolve(workspace);

  let entry = null;
  let fullPath = null;
  let readRoot = null;

  if (flags.reference) {
    const found = resolveInstalledReference(flags.reference, installedCorpusHomes({ copilotHome }));
    if (!found) {
      throw new Error(`installed reference not found: ${flags.reference}. Pass a path under skills/, agents/, or instructions/ from ae install. Do not search the workspace.`);
    }
    fullPath = found.fullPath;
    readRoot = found.readRoot;
    relPath = found.rel;
    entry = { docid: null, path: found.rel, title: path.basename(found.fullPath) };
  } else if (docid) {
    entry = findEntryByDocid(copilotHome, workspace, docid, { home: home || flags.home || flags.harnessHome });
    if (!entry) throw new Error(`docid not found in manifest: ${docid}`);
    const resolved = resolveDocPath(copilotHome, workspace, entry, {
      home: home || flags.home,
    });
    fullPath = resolved?.full ?? null;
    readRoot = resolved?.root ?? null;
  } else if (relPath) {
    let authorized = null;
    if (authorizedPlan && domainContextOf(authorizedPlan) && path.resolve(relPath) === authorizedPlan.fullPath) {
      authorized = { fullPath: authorizedPlan.fullPath, readRoot: planRecordRoot(workspaceResolved, authorizedPlan) };
    }
    const packaged = authorized || resolveReadPointer(relPath, workspaceResolved, copilotHome, home || flags.home) || resolvePackagedRel(relPath, copilotHome);
    if (packaged) {
      fullPath = packaged.fullPath;
      readRoot = packaged.readRoot;
    } else {
      fullPath = safeResolveUnderRoot(workspaceResolved, relPath);
      if (!fullPath) throw new Error(`path escapes workspace: ${relPath}`);
      readRoot = workspaceResolved;
    }
    entry = findEntryByDocid(copilotHome, workspace, path.basename(relPath, '.md'), { home: home || flags.home || flags.harnessHome }) || {
      docid: null,
      path: relPath,
      title: path.basename(relPath),
    };
  } else {
    throw new Error('get requires --docid <id>, --path <relative-path>, or --reference <installed-corpus-path>');
  }

  if (!fullPath || !fs.existsSync(fullPath)) {
    throw new Error(`file not found for ${docid || relPath}`);
  }

  const rawBytes = readFileNoFollow(fullPath, { root: readRoot, encoding: null });
  if (rawBytes === null) throw new Error(`file not found for ${docid || relPath}`);
  const raw = rawBytes.toString('utf8');
  const sha256 = sourceHash(rawBytes);
  assertSourceCurrent(reference.sha256, sha256);
  const allLines = raw.split(/\r?\n/);
  const start = Math.min(offset - 1, allLines.length);
  const lines = allLines.slice(start, start + maxLines);
  const selectedText = lines.join('\n');
  let excerpt = redactSecrets(selectedText);
  const wasRedacted = excerpt !== selectedText;
  const clipped = Buffer.byteLength(excerpt, 'utf8') > maxBytes;
  if (clipped) {
    excerpt = truncateUtf8(excerpt, maxBytes);
  }
  const sourceExcerpt = wasRedacted ? selectedText : clipped ? excerpt.split('\n…(truncated)')[0] : excerpt;
  const truncated = clipped || start > 0 || start + lines.length < allLines.length;

  const result = {
    docid: entry.docid || entry.id || docid || null,
    path: entry.path || relPath,
    title: entry.title || path.basename(fullPath),
    excerpt,
    bytes: Buffer.byteLength(excerpt, 'utf8'),
    lines: excerpt === '' ? 0 : excerpt.split('\n').length,
    offset,
    totalLines: allLines.length,
    sha256,
    truncated,
    ...(flags.contextVersion === 2 ? {
      context: sourceContext(entry.path || relPath || '', raw, offset),
      evidence: {
        reference: `${docid ? `docid:${docid}` : relPath}@sha256:${sha256}`,
        sha256,
        representationSha256: sourceHash(excerpt),
        redacted: wasRedacted,
        provenance: { root: readRoot, scope: readRoot === workspaceResolved ? 'workspace' : 'external-resource' },
        range: { startLine: offset, endLine: sourceExcerpt ? offset + sourceExcerpt.split('\n').length - 1 : null, partialLastLine: clipped },
      },
    } : {}),
  };
  Object.defineProperty(result, READ_SOURCE, { value: fullPath });
  return result;
}
