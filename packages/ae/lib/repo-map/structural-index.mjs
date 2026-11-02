import { gitExecutable } from '../../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { harnessGlobalHome } from '../paths.mjs';
import { inertLine } from '../knowledge/store.mjs';
import { structuralCacheDir, structuralDir } from '../structural/shape.mjs';
import { readSnapshot, publishSnapshot } from '../structural/snapshot.mjs';
import { redactSecrets } from '../secret-scan.mjs';
import { estimateTokens } from '../token-meter.mjs';
import { EXIT } from '../style.mjs';
import { trackedSourceFiles } from './scan.mjs';
import { buildImportGraph, importResolver, resolveImportBinding, IMPORT_RESOLVER_VERSION } from './imports.mjs';
import { readFileFacts, readSourceHashes, FILE_FACTS_VERSION } from './facts.mjs';
import { MAX_IDENTIFIER_LENGTH } from './treesitter-extractor.mjs';
import { captureWorkingSources, structuralCurrentness } from './working-sources.mjs';

export const STRUCTURAL_INDEX_VERSION = 2;

const MAX_SYMBOL_TABLE = 20_000;
const MAX_DEFS_PER_SYMBOL = 20;
const MAX_REFS_PER_SYMBOL = 50;
const MAX_MODULE_EDGES = 20_000;
const MAX_CALL_EDGES = 20_000;
const MAX_UNRESOLVED = 4_000;
const MAX_DELTA_NAMES = 50;

function git(workspace, args) {
  const r = spawnSync(gitExecutable(), ['-C', workspace, ...args], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function structuralIndexDir(workspace, options = {}) {
  return structuralDir(workspace, options);
}

export function readStructuralIndex(workspace, options = {}) {
  const snapshot = readSnapshot(structuralCacheDir(workspace, options), options);
  if (!snapshot?.meta || !Number.isFinite(snapshot.meta.version) || snapshot.meta.version > STRUCTURAL_INDEX_VERSION) return null;
  return snapshot;
}

export function readStructuralIndexIfCurrent(workspace, options = {}) {
  const head = git(workspace, ['rev-parse', 'HEAD']);
  if (!head) return null;
  const index = readStructuralIndex(workspace, { ...options, expectedSha: head });
  return structuralIndexIsCurrent(workspace, index) ? index : null;
}

export function structuralIndexIsCurrent(workspace, index) {
  if (!index || index.unreadable.length || index.meta.sha !== git(workspace, ['rev-parse', 'HEAD'])) return false;
  if (!structuralCurrentness(workspace, index.meta).current) return false;
  const inventory = trackedSourceFiles(workspace);
  if (inventory.unavailable || index.meta.inventoryHash && index.meta.inventoryHash !== inventory.inventoryHash) return false;
  const hashes = readSourceHashes(workspace, inventory.files);
  if (Object.keys(index.files).sort().join('\0') !== [...hashes].filter(([, hash]) => hash !== null).map(([rel]) => rel).sort().join('\0')) return false;
  for (const [rel, row] of Object.entries(index.files)) {
    const hash = hashes.get(rel);
    if (!hash || !row || row.hash !== hash) return false;
  }
  return true;
}

export function validateSinceRef(workspace, ref) {
  const value = String(ref || '').trim();
  if (!value || value.startsWith('-')) {
    throw Object.assign(new Error(`invalid --since ref: ${JSON.stringify(String(ref || ''))}`), {
      code: 'E_USAGE',
      hint: 'pass a git ref (branch, tag, or sha) that does not start with "-"',
      exit: EXIT.usage,
    });
  }
  const sha = git(workspace, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${value}^{commit}`]);
  if (!sha) {
    throw Object.assign(new Error(`--since ref does not resolve to a commit: ${JSON.stringify(value)}`), {
      code: 'E_USAGE',
      hint: 'git rev-parse --verify <ref> must succeed in this workspace',
      exit: EXIT.usage,
    });
  }
  return sha;
}


function cleanName(name) {
  const redacted = redactSecrets(String(name ?? ''));
  return redacted.length > MAX_IDENTIFIER_LENGTH ? redacted.slice(0, MAX_IDENTIFIER_LENGTH) : redacted;
}

function sanitizeEntry(res, { hash, mtime, size }) {
  const range = value => value && Number.isSafeInteger(value.startLine) && value.startLine > 0
    && Number.isSafeInteger(value.endLine) && value.endLine >= value.startLine
    ? { startLine: value.startLine, endLine: value.endLine,
      ...(Number.isSafeInteger(value.startColumn) && value.startColumn > 0 ? { startColumn: value.startColumn } : {}),
      ...(Number.isSafeInteger(value.endColumn) && value.endColumn > 0 ? { endColumn: value.endColumn } : {}) } : undefined;
  return {
    hash,
    mtime,
    size,
    symbols: (res.symbols || []).map(cleanName),
    imports: (res.imports || []).map(specifier => redactSecrets(String(specifier))),
    importOccurrences: (res.importOccurrences || []).slice(0, 256).map(item => ({
      specifier: redactSecrets(String(item.specifier || '')),
      ...(range(item.range) ? { range: range(item.range) } : {}),
      method: item.method === 'ast' ? 'ast' : 'lexical',
      bindings: (item.bindings || []).slice(0, 256).map(binding => ({ imported: cleanName(binding.imported), local: cleanName(binding.local), kind: String(binding.kind || 'named').slice(0, 24) })),
    })),
    complexity: Number.isFinite(res.complexity) ? res.complexity : 1,
    defs: (res.defs || []).map((d) => ({
      name: cleanName(d.name),
      kind: String(d.kind || 'symbol').slice(0, 24),
      line: Number.isFinite(d.line) ? d.line : 0,
      exported: Boolean(d.exported),
      ...(['named', 'default'].includes(d.exportKind) ? { exportKind: d.exportKind } : {}),
      ...(typeof d.owner === 'string' ? { owner: cleanName(d.owner) } : {}),
      ...(typeof d.id === 'string' ? { id: redactSecrets(d.id).slice(0, 2048) } : {}),
      ...(range(d.range) ? { range: range(d.range) } : {}),
      ...(typeof d.signature === 'string' ? { signature: redactSecrets(d.signature).slice(0, 2048) } : {}),
    })),
    refs: (res.refs || []).map((r) => ({
      name: cleanName(r.name),
      line: Number.isFinite(r.line) ? r.line : 0,
      ...(range(r.range) ? { range: range(r.range) } : {}),
      ...(typeof r.owner === 'string' ? { owner: cleanName(r.owner) } : {}),
      ...(typeof r.receiver === 'string' ? { receiver: cleanName(r.receiver) } : {}),
      ...(r.importBinding === 'shadowed' ? { importBinding: 'shadowed' } : {}),
    })),
    tier: res.tier === 'treesitter' ? 'treesitter' : 'lexical',
    limitsReached: res.limitsReached || {},
    ...(res.hasErrors || res.errors ? { errors: true } : {}),
  };
}

function usablePriorEntry(entry) {
  return Boolean(
    entry &&
      typeof entry === 'object' &&
      typeof entry.hash === 'string' &&
      Array.isArray(entry.symbols) &&
      Array.isArray(entry.imports) &&
      Array.isArray(entry.defs) &&
      Array.isArray(entry.refs)
  );
}

function buildSymbolTable(files, truncation) {
  const symbols = Object.create(null);
  const rels = Object.keys(files).sort();
  let distinct = 0;
  for (const rel of rels) {
    for (const d of Array.isArray(files[rel]?.defs) ? files[rel].defs : []) {
      if (!d || typeof d.name !== 'string') continue;
      if (!symbols[d.name]) {
        if (distinct >= MAX_SYMBOL_TABLE) {
          truncation.symbols = true;
          continue;
        }
        symbols[d.name] = { defs: [], refs: [] };
        distinct += 1;
      }
      if (symbols[d.name].defs.length < MAX_DEFS_PER_SYMBOL) {
        symbols[d.name].defs.push({ file: rel, line: d.line, kind: d.kind, exported: d.exported,
          ...(d.exportKind ? { exportKind: d.exportKind } : {}),
          ...(d.id ? { id: d.id } : {}), ...(d.owner ? { owner: d.owner } : {}),
          ...(d.range ? { range: d.range } : {}), ...(d.signature ? { signature: d.signature } : {}) });
      } else {
        truncation.symbolDetail = true;
      }
    }
  }
  for (const rel of rels) {
    for (const r of Array.isArray(files[rel]?.refs) ? files[rel].refs : []) {
      if (!r || typeof r.name !== 'string') continue;
      const entry = symbols[r.name];
      if (!entry) continue;
      if (entry.refs.length < MAX_REFS_PER_SYMBOL) entry.refs.push({ file: rel, line: r.line });
      else truncation.symbolDetail = true;
    }
  }
  return symbols;
}

function buildGraph(files, symbols, truncation, workspace) {
  const rels = Object.keys(files).sort();
  const trackedSet = new Set(rels);
  const imports = buildImportGraph(new Map(rels.map(rel => [rel, files[rel]])), trackedSet, { workspace, maxEdges: MAX_MODULE_EDGES, maxUnresolved: MAX_UNRESOLVED });
  const { modules, unresolvedImports } = imports;
  truncation.moduleEdges = imports.moduleEdgesTruncated;
  truncation.unresolved = imports.unresolvedTruncated;
  const calls = [];
  const unresolvedCalls = [];
  const seenUnresolved = new Set();
  const resolve = importResolver(trackedSet, { workspace });
  for (const rel of rels) {
    const perFile = new Map();
    for (const r of Array.isArray(files[rel]?.refs) ? files[rel].refs : []) {
      if (!r || typeof r.name !== 'string') continue;
      const occurrenceKey = `${r.owner || ''}\0${r.receiver || ''}\0${r.name}\0${r.importBinding || ''}`;
      if (perFile.has(occurrenceKey)) continue;
      perFile.set(occurrenceKey, true);
      const entry = symbols[r.name];
      const lexicalReference = files[rel].tier === 'lexical';
      const importedNameReference = lexicalReference && /\.[cm]?[jt]sx?$/i.test(rel);
      const binding = r.importBinding === 'shadowed'
        ? { reason: 'shadowed-import-binding', bindings: [], evidence: [] }
        : resolveImportBinding(rel, r.receiver || r.name, files[rel], trackedSet, { workspace, resolve,
          ...(importedNameReference ? { referenceKind: 'imported-name' } : {}) });
      if (importedNameReference && binding.reason === 'no-explicit-binding') binding.reason = 'unsupported-import-binding';
      const bound = binding.reason !== 'no-explicit-binding';
      const bindings = r.receiver ? binding.bindings.filter(imported => imported.imported === '*' && ['namespace', 'module'].includes(imported.kind)) : binding.bindings;
      if (r.receiver && binding.reason === 'explicit-import-binding' && !bindings.length) binding.reason = 'unsupported-receiver-binding';
      const definitions = bound ? bindings.flatMap(imported => {
        if (imported.kind === 'type') return [];
        const name = r.receiver || imported.imported === '*' || imported.imported === 'default' ? r.name : imported.imported;
        return (symbols[name]?.defs || []).filter(def => def.file === imported.target
          && (!/\.[cm]?[jt]sx?$/i.test(imported.target) || imported.imported !== 'default' && !def.owner && def.exportKind === 'named'))
          .map(def => ({ ...def, name }));
      }) : r.receiver ? [] : (entry?.defs || []).map(def => ({ ...def, name: r.name }));
      if (bound && binding.bindings.length && !definitions.length && binding.reason === 'explicit-import-binding') binding.reason = 'unsupported-export-binding';
      const targets = [...new Set(definitions.map(def => def.file))].filter(file => file !== rel);
      const to = targets.slice(0, 5);
      const candidates = definitions.filter(def => to.includes(def.file)).slice(0, MAX_DEFS_PER_SYMBOL);
      const evidence = [
        ...(r.range ? [{ path: rel, sha256: files[rel].hash, range: r.range }] : []),
        ...(bound ? binding.evidence : []),
      ].slice(0, 32);
      if (to.length) {
        if (calls.length < MAX_CALL_EDGES) calls.push({ id: sha256(JSON.stringify(['call-candidate', rel, r.owner || '', r.receiver || '', r.name, to])), from: rel, symbol: r.name, to,
          relation: 'call-candidate', method: bound && !lexicalReference ? 'static-resolver' : files[rel].tier === 'treesitter' ? 'ast' : 'lexical',
          resolutionStatus: targets.length > 1 || candidates.length > 1 ? 'ambiguous' : 'candidate', candidates,
          reason: bound ? lexicalReference ? 'imported-name-reference' : binding.reason : 'name-reference-approximation',
          observation: files[rel].tier === 'treesitter' ? 'call-site' : 'imported-name-reference', evidence,
          ...(targets.length > to.length ? { candidatesOmitted: targets.length - to.length } : {}),
        });
        else truncation.callEdges = true;
      } else if (!entry || bound || r.receiver) {
        const key = `${rel}\0${r.name}`;
        if (seenUnresolved.has(key)) continue;
        if (unresolvedCalls.length < MAX_UNRESOLVED) {
          seenUnresolved.add(key);
          unresolvedCalls.push({ from: rel, symbol: r.name, relation: 'call-candidate', resolutionStatus: 'unresolved',
            reason: bound ? binding.reason : r.receiver ? 'unsupported-receiver' : 'no-definition', evidence });
        } else {
          truncation.unresolved = true;
        }
      }
    }
  }
  const adjacency = { version: 1, relation: 'observed-module-imports', forward: Object.create(null), reverse: Object.create(null) };
  modules.forEach((edge, index) => {
    (adjacency.forward[edge.from] ||= []).push(index);
    (adjacency.reverse[edge.to] ||= []).push(index);
  });
  return { modules, unresolvedImports, calls, unresolvedCalls, adjacency };
}

function symbolDelta(priorSymbols, nextSymbols) {
  const prior = priorSymbols || {};
  const added = [];
  const removed = [];
  const changed = [];
  // Own-key membership only: `prior` comes from JSON.parse (Object prototype
  // intact), so `'constructor' in prior` would be true for every table.
  for (const name of Object.keys(nextSymbols)) {
    if (!Object.hasOwn(prior, name)) added.push(name);
    // A CORRUPT PRIOR REBUILDS, IT NEVER CRASHES (review finding). `prior`
    // comes from a hand-editable, possibly truncated symbols.json, so an entry
    // may be null or a primitive — `prior[name].defs` then threw a TypeError
    // straight out of `ae index --structural`, and only deleting the index
    // by hand recovered. Same discipline as `usablePriorEntry` for files.json:
    // an entry that is not an object is not comparable, so it counts as CHANGED
    // (the safe direction — never silently "unchanged").
    else if (
      !prior[name] ||
      typeof prior[name] !== 'object' ||
      JSON.stringify(prior[name].defs) !== JSON.stringify(nextSymbols[name].defs)
    ) {
      changed.push(name);
    }
  }
  for (const name of Object.keys(prior)) {
    if (!Object.hasOwn(nextSymbols, name)) removed.push(name);
  }
  const cap = (list) => ({ count: list.length, names: list.sort().slice(0, MAX_DELTA_NAMES) });
  return { added: cap(added), removed: cap(removed), changed: cap(changed) };
}

/**
 * Publish the four tables as ONE generation (review finding).
 *
 * Each individual write is atomic, and meta.json is written LAST as the
 * completeness signal — but that only orders the writes, it does not make the
 * SET atomic. Both readers (`readStructuralIndex` here and shape.mjs's) read
 * meta.json first and then the tables, so a build landing between those reads
 * hands back meta.json from generation N-1 beside files.json from generation N
 * — mixed generations, with symbol rows citing files the meta never saw.
 *
 * The whole generation is therefore staged in a sibling directory and swapped
 * in with two renames. A concurrent reader sees the previous generation whole,
 * the new one whole, or — for the instant between the renames — no index
 * directory at all, which every reader already treats as "absent, skip". On any
 * failure the previous generation is renamed back, so a refused publish leaves
 * the index exactly as it was rather than empty. Returns `{ ok }` plus the
 * table name that refused, for the caller's log line.
 */
function sweepStaleGenerations(parent, baseName) {
  let names = [];
  try {
    names = fs.readdirSync(parent);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(`.staging-${baseName}-`) && !name.startsWith(`.retired-${baseName}-`)) continue;
    const full = path.join(parent, name);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs < 60_000) continue;
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // A live build owns a fresh staging directory. Leave anything we cannot stat.
    }
  }
}

/** Read and hash bounded file contents before reusing extraction. Stat metadata
 * and --since are provenance hints, never a substitute for current bytes. */
export async function buildStructuralIndex({ workspace, home, extractor, since = null, dryRun = false, log = () => {} }) {
  let dir = structuralCacheDir(workspace, { home });
  const onDisk = readStructuralIndex(workspace, { home });
  // An unreadable table is not a usable baseline: diffing against it would
  // report every symbol as added and silently re-derive the whole index.
  const priorUnreadable = onDisk?.unreadable?.length ? onDisk.unreadable : [];
  if (priorUnreadable.length) log(`prior structural index unusable: ${priorUnreadable.join('; ')} — rebuilding from scratch`);
  const prior = priorUnreadable.length ? null : onDisk;
  const snapshot = captureWorkingSources(workspace);
  const extractorSignature = sha256(JSON.stringify({ version: FILE_FACTS_VERSION, tier: extractor.tier || 'lexical', webTreeSitter: extractor.webTreeSitter || null, grammarVersions: extractor.grammarVersions || {} }));
  const sameExtractor = prior?.meta?.extractorSignature === extractorSignature && prior?.meta?.sourceState?.configDigest === snapshot.state?.configDigest && prior?.meta?.sourceState?.extractorRevision === snapshot.state?.extractorRevision;
  const inventory = trackedSourceFiles(workspace);
  const { files: tracked, total } = inventory;
  const sourceSha = git(workspace, ['rev-parse', 'HEAD']);
  const initialHashes = readSourceHashes(workspace, tracked);

  let sinceIgnored = null;
  let appliedSince = null;
  if (since && prior) {
    if (prior.meta?.sha === since) appliedSince = since;
    else sinceIgnored = `--since ${since.slice(0, 12)} does not match the prior index baseline ${String(prior.meta?.sha || 'unknown').slice(0, 12)}`;
  } else if (since) {
    sinceIgnored = '--since needs a prior index to narrow against';
  }
  if (sinceIgnored) log(`${sinceIgnored} — running a full incremental pass instead`);

  const nextFiles = {};
  let reparsed = 0;
  let reused = 0;
  for (const rel of tracked) {
    const raw = prior?.files?.[rel];
    // A hand-edited or partially written prior entry is discarded and rebuilt,
    // never reused: it flows into files.json and the symbol table verbatim.
    const priorEntry = sameExtractor && usablePriorEntry(raw) ? raw : undefined;
    let st;
    try { st = fs.statSync(path.join(workspace, rel)); }
    catch { continue; }
    const extract = (file, content) => {
      try { return extractor.extract(file, content); }
      catch (error) {
        log(`structural parse failed ${file}: ${error.message}`);
        return { symbols: [], imports: [], defs: [], refs: [], hasErrors: true, tier: 'lexical' };
      }
    };
    const read = readFileFacts(workspace, [rel], { extract, cachedFiles: priorEntry ? { [rel]: priorEntry } : null });
    const fact = read.facts.get(rel);
    if (fact.tier === 'unreadable') continue;
    nextFiles[rel] = sanitizeEntry(fact, { hash: fact.hash, mtime: st.mtimeMs, size: st.size });
    reused += read.reused;
    reparsed += 1 - read.reused;
  }
  const removedFiles = Object.keys(prior?.files || {}).filter((rel) => !(rel in nextFiles)).length;

  // Cap hits are RECORDED: past a cap a removed symbol simply has no callers
  // and the delta misreports, so consumers must be able to tell a complete
  // table from a truncated one instead of trusting a silently shortened one.
  // `symbols` is the TABLE-level cap (a declaration that never entered the
  // table at all — findings computed from it can be wrong); `symbolDetail` is
  // the routine per-symbol def/ref cap, which only shortens a list.
  const truncation = { symbols: false, symbolDetail: false, moduleEdges: false, callEdges: false, unresolved: false };
  const symbols = buildSymbolTable(nextFiles, truncation);
  const graph = buildGraph(nextFiles, symbols, truncation, workspace);
  const delta = symbolDelta(prior?.symbols, symbols);

  const errorFiles = Object.values(nextFiles).filter((f) => f.errors).length;
  // What the reported delta is measured against — always the prior index when
  // one was usable, so the ledger can qualify the numbers honestly.
  const basedOn = prior?.meta?.sha || null;
  const meta = {
    version: STRUCTURAL_INDEX_VERSION,
    sourceState: snapshot.state || null,
    fileFactsVersion: FILE_FACTS_VERSION,
    extractorSignature,
    sha: sourceSha,
    resolverVersion: IMPORT_RESOLVER_VERSION,
    callGraphKind: 'name-reference-approximation',
    inventoryHash: inventory.inventoryHash,
    branch: git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']),
    baseSha: appliedSince || null,
    generatedAt: new Date().toISOString(),
    extractorTier: extractor.tier || 'lexical',
    webTreeSitter: extractor.webTreeSitter || null,
    grammarVersions: extractor.grammarVersions || {},
    missingGrammars: extractor.missingGrammars || [],
    integrityFailures: extractor.integrityFailures || [],
    parseFailures: extractor.counters?.parseFailures ?? 0,
    errorFiles,
    filesIndexed: Object.keys(nextFiles).length,
    unreadableFiles: tracked.length - Object.keys(nextFiles).length,
    extractionTruncated: Object.values(nextFiles).some(row => Object.values(row.limitsReached).some(Boolean)),
    totalTracked: total,
    truncated: total > tracked.length,
    symbolsTruncated: truncation.symbols,
    symbolDetailTruncated: truncation.symbolDetail,
    moduleEdgesTruncated: truncation.moduleEdges,
    callEdgesTruncated: truncation.callEdges,
    unresolvedTruncated: truncation.unresolved,
  };

  const finalInventory = trackedSourceFiles(workspace);
  const finalSnapshot = captureWorkingSources(workspace);
  const finalHashes = readSourceHashes(workspace, tracked);
  const sourceChanged = inventory.unavailable || finalInventory.unavailable || inventory.inventoryHash !== finalInventory.inventoryHash || sourceSha !== git(workspace, ['rev-parse', 'HEAD']) || [...initialHashes].some(([rel, hash]) => hash !== finalHashes.get(rel)) || Object.entries(nextFiles).some(([rel, row]) => row.hash !== initialHashes.get(rel));
  const sourceStateChanged = snapshot.valid !== finalSnapshot.valid || snapshot.state && finalSnapshot.state && snapshot.state.digest !== finalSnapshot.state.digest;
  if (sourceChanged || !snapshot.valid || !finalSnapshot.valid || sourceStateChanged) {
    log('structural index not published: source inventory or content changed during extraction');
    return { dir, written: false, reparsed, reused, removedFiles, delta, meta, sinceIgnored, priorUnreadable, basedOn,
      sourceChanged: Boolean(sourceChanged || sourceStateChanged),
      reason: { code: 'E_STRUCTURAL_SOURCE_STATE', message: snapshot.reason || finalSnapshot.reason || 'Source inventory or content changed during extraction.' } };
  }

  if (!meta.sha) {
    log('structural index not published — git HEAD could not be read');
    return { dir, written: false, reparsed, reused, removedFiles, delta, meta, sinceIgnored, priorUnreadable, basedOn, reason: { code: 'E_STRUCTURAL_HEAD', message: 'Git HEAD could not be read.' } };
  }

  if (!dryRun) {
    sweepStaleGenerations(path.dirname(dir), path.basename(dir));
    const published = publishSnapshot(dir, [
      ['files.json', nextFiles],
      ['symbols.json', symbols],
      ['graph.json', graph],
      ['meta.json', meta],
    ]);
    if (!published.ok) {
      log(`structural index write refused: ${published.failed}`);
      return { dir, written: false, reparsed, reused, removedFiles, delta, meta, sinceIgnored, priorUnreadable, basedOn, reason: { code: 'E_STRUCTURAL_PUBLISH', message: published.failed } };
    }
    dir = published.dir;
    meta.generation = published.generation;
  }

  return { dir, written: !dryRun, reparsed, reused, removedFiles, delta, meta, sinceIgnored, priorUnreadable, basedOn };
}

export function renderStructuralDigest(index, { maxTokens = 1000 } = {}) {
  const { meta, files, symbols, graph } = index;
  const lines = [
    '# Structural Index Digest',
    '',
    inertLine(
      `> ${meta.filesIndexed} files @ ${(meta.sha || 'unknown').slice(0, 7)} (${meta.branch || '?'}) · tier ${meta.extractorTier}` +
        (meta.integrityFailures?.length ? ` · GRAMMAR INTEGRITY FAILED (${meta.integrityFailures.length})` : '')
    ),
    '',
  ];
  const push = (line) => {
    if (estimateTokens([...lines, line].join('\n')) > maxTokens) return false;
    lines.push(line);
    return true;
  };

  const topRefs = Object.entries(symbols)
    .filter(([, s]) => s.refs.length)
    .sort((a, b) => b[1].refs.length - a[1].refs.length || (a[0] < b[0] ? -1 : 1))
    .slice(0, 10);
  if (topRefs.length) {
    push('Most-referenced symbols:');
    for (const [name, s] of topRefs) {
      const def = s.defs[0];
      if (!push(inertLine(`- ${name} (${s.refs.length} refs) — ${def ? `${def.file}:${def.line}` : 'defs elsewhere'}`))) break;
    }
    push('');
  }

  const hotspots = Object.entries(files)
    .sort((a, b) => b[1].complexity - a[1].complexity || (a[0] < b[0] ? -1 : 1))
    .slice(0, 8);
  if (hotspots.length) {
    push('Complexity hotspots:');
    for (const [rel, f] of hotspots) {
      if (!push(inertLine(`- ${rel} (branches ~${f.complexity}, symbols ${f.symbols.length})`))) break;
    }
    push('');
  }

  push(
    inertLine(
      `Edges: ${graph.modules?.length ?? 0} module · ${graph.calls?.length ?? 0} approximate name references · unresolved ${graph.unresolvedImports?.length ?? 0} imports / ${graph.unresolvedCalls?.length ?? 0} references`
    )
  );
  const body = lines.join('\n');
  return { body, tokens: estimateTokens(body) };
}
