import path from 'node:path';
import { parseFlags } from '../flags.mjs';
import { parseQueryFromArgv } from '../argv.mjs';
import { positionalsOf } from '../positionals.mjs';
import { resolveCopilotHome } from '../paths.mjs';
import { createStyle, keyWidthFor } from '../style.mjs';
import { redactedJson } from '../redact.mjs';
import { inertLine } from '../knowledge/store.mjs';
import { runSearch, MATCH_MODES, DEFAULT_MATCH_MODE } from './search.mjs';
import { runTree, TREE_SUBJECTS } from './tree.mjs';
import { SOURCES } from './kernel.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

function readValueFlag(argv, name) {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const next = argv[i + 1];
  return next === undefined || next.startsWith('--') ? '' : next;
}

function searchContext(argv) {
  const flags = parseFlags(argv);
  return {
    flags,
    query: parseQueryFromArgv(argv, flags),
    mode: readValueFlag(argv, '--match') ?? undefined,
    sources: readValueFlag(argv, '--source'),
    cursor: readValueFlag(argv, '--cursor'),
    explain: flags.explain,
    collection: flags.collection,
    limit: flags.limit ?? undefined,
    workspace: path.resolve(flags.workspace),
    copilotHome: resolveCopilotHome(flags.copilotHome),
  };
}

function searchResult(argv) {
  const ctx = searchContext(argv);
  return runSearch({
    query: ctx.query,
    workspace: ctx.workspace,
    home: ctx.flags.harnessHome || ctx.flags.home,
    contextVersion: ctx.flags.contextVersion,
    copilotHome: ctx.copilotHome,
    mode: ctx.mode || undefined,
    sources: ctx.sources ? ctx.sources.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    limit: ctx.limit,
    cursor: ctx.cursor || null,
    explain: ctx.explain,
    collection: ctx.collection,
  });
}

export async function searchResultOf(argv) {
  return searchResult(argv);
}

function openArgvFor(row) {
  if (row.source === 'knowledge' && row.id) return ['get', '--docid', String(row.id)];
  const location = typeof row.location === 'string' ? row.location : '';
  const file = location.replace(/:\d+(?::\d+)?$/, '').trim();
  if (file) return ['get', '--path', file];
  if (row.id) return ['get', '--docid', String(row.id)];
  return null;
}

/** Max hits printed in the ledger by default. Full set still goes to results picker. */
export const SEARCH_LEDGER_PREVIEW = 8;

function shortLocation(row) {
  const where = String(row.location || row.id || '');
  // Drop redundant basename note when location already ends with the same file.
  return where;
}

function hitLabel(row, index) {
  const where = shortLocation(row);
  const title = row.title && row.title !== path.basename(where.replace(/:\d+(?::\d+)?$/, ''))
    ? row.title
    : null;
  return {
    index: index + 1,
    source: row.source || 'hit',
    where: inertLine(where),
    title: title ? inertLine(String(title)) : undefined,
    reason: row.reason ? inertLine(String(row.reason)) : undefined,
  };
}

/**
 * Human ledger lines for search. Never dumps raw --cursor tokens.
 * @param {object} result runSearch result
 * @param {{ verbose?: boolean, explain?: boolean, preview?: number, compact?: boolean }} opts
 */
export function formatSearchLedger(result, opts = {}) {
  const preview = Number.isInteger(opts.preview) ? opts.preview : SEARCH_LEDGER_PREVIEW;
  const lines = [];
  lines.push({
    key: 'search',
    value: `${result.total} result${result.total === 1 ? '' : 's'}`,
    note: `match ${result.match}`,
  });

  const skipped = (result.sources || []).filter((x) => x.status !== 'ok');
  if (skipped.length) {
    if (opts.verbose) {
      for (const s of skipped) {
        lines.push({
          state: s.status === 'failed' ? 'error' : 'warn',
          key: s.source,
          value: s.status,
          note: s.reason ?? undefined,
        });
      }
    } else {
      const names = skipped.map((s) => s.source).join(', ');
      const failed = skipped.some((s) => s.status === 'failed');
      lines.push({
        state: failed ? 'error' : 'muted',
        key: 'skipped',
        value: names,
        note: skipped.length === 1 ? (skipped[0].reason || undefined) : `${skipped.length} sources`,
      });
    }
  }

  const page = result.results || [];
  const show = opts.compact ? page.slice(0, preview) : page;
  show.forEach((row, i) => {
    const hit = hitLabel(row, i);
    lines.push({
      key: String(hit.index),
      value: hit.where,
      note: [hit.source, hit.title].filter(Boolean).join(' · ') || undefined,
    });
    if (opts.explain && hit.reason) {
      lines.push({ key: 'why', value: hit.reason, state: 'muted' });
    }
  });

  if (opts.compact && page.length > show.length) {
    lines.push({
      state: 'muted',
      key: 'shown',
      value: `${show.length} of ${page.length}`,
      note: 'type results to browse all',
    });
  }

  if (result.truncated && result.nextCursor) {
    if (opts.verbose) {
      lines.push({
        key: 'more',
        value: `${page.length}+ remaining`,
        note: `re-run with --cursor (see --json)`,
      });
      lines.push({
        state: 'muted',
        key: 'cursor',
        value: String(result.nextCursor),
      });
    } else {
      lines.push({
        state: 'muted',
        key: 'more',
        value: 'next page available',
        note: opts.compact ? 'results · or search again with --verbose for cursor' : 'pass --cursor from --json nextCursor',
      });
    }
  }

  return lines;
}

export async function cmdSearch(argv, ctx = {}) {
  const { flags } = searchContext(argv);
  const result = searchResult(argv);

  // TUI (and any host that registers a selection) gets a full pick list.
  ctx.reportSelection?.({
    kind: 'results',
    title: `${result.total} result(s)`,
    items: result.results
      .map((row, i) => ({
        label: `${i + 1}. ${String(row.location || row.id || '')}`,
        note: [row.source, row.title].filter(Boolean).join(' · '),
        argv: openArgvFor(row),
      }))
      .filter((item) => item.label && item.argv),
  });

  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
    return 0;
  }

  // When selection is wired (ledger/TUI), keep the scrollback short.
  const compact = typeof ctx.reportSelection === 'function' && !flags.verbose;
  const ledgerLines = formatSearchLedger(result, {
    verbose: flags.verbose,
    explain: flags.explain,
    compact,
    preview: SEARCH_LEDGER_PREVIEW,
  });
  const keyWidth = keyWidthFor(['search', 'skipped', 'shown', 'more', 'cursor', 'why', ...ledgerLines.map((l) => l.key)]);
  for (const line of ledgerLines) {
    console.log(ui.line({ ...line, keyWidth }));
  }
  return 0;
}

function treeContext(argv) {
  const flags = parseFlags(argv);
  const boundary = argv.indexOf('--');
  const scan = boundary === -1 ? argv : argv.slice(0, boundary);
  const positionals = [...positionalsOf(scan), ...(boundary === -1 ? [] : argv.slice(boundary + 1))];
  const depthRaw = readValueFlag(scan, '--depth');
  return {
    flags,
    subject: positionals[0] ?? null,
    target: positionals[1] ?? null,
    depth: depthRaw === null ? undefined : Number(depthRaw),
    files: scan.includes('--files'),
    workspace: path.resolve(flags.workspace),
    copilotHome: resolveCopilotHome(flags.copilotHome),
  };
}

function treeResult(argv) {
  const ctx = treeContext(argv);
  return runTree({
    subject: ctx.subject,
    target: ctx.target,
    depth: ctx.depth,
    files: ctx.files,
    workspace: ctx.workspace,
    copilotHome: ctx.copilotHome,
  });
}

export async function treeResultOf(argv) {
  return treeResult(argv);
}

function printNode(node, prefix, keyWidth) {
  const label = node.type === 'dir' ? `${node.name}/` : node.name;
  console.log(ui.line({ key: '', value: `${prefix}${inertLine(label)}`, note: node.title ? inertLine(node.title) : undefined, keyWidth }));
  for (const child of node.children || []) printNode(child, `${prefix}  `, keyWidth);
}

export async function cmdTree(argv) {
  const { flags } = treeContext(argv);
  const result = treeResult(argv);

  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
    return 0;
  }
  if (Array.isArray(result.files)) {
    for (const file of result.files) console.log(file);
    if (result.unavailable) console.error(result.emptyReason);
    return result.unavailable ? 1 : 0;
  }

  const keyWidth = keyWidthFor(['tree', 'totals', 'limits']);
  console.log(ui.line({ key: 'tree', value: result.subject, note: result.target ?? undefined, keyWidth }));
  for (const child of result.root?.children || []) printNode(child, '', keyWidth);

  if (result.emptyReason) {
    console.log(ui.line({ state: 'warn', key: '', value: result.emptyReason, keyWidth }));
  }

  const totals = Object.entries(result.totals ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
  if (totals) console.log(ui.line({ key: 'totals', value: totals, keyWidth }));
  if (result.truncated) {
    const dropped = Object.entries(result.limits ?? {})
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(' · ');
    console.log(ui.line({ state: 'warn', key: 'limits', value: 'output truncated', note: dropped || undefined, keyWidth }));
  }
  return 0;
}

export const SEARCH_MATCH_MODES = MATCH_MODES;
export const SEARCH_DEFAULT_MODE = DEFAULT_MATCH_MODE;
export const SEARCH_SOURCE_NAMES = SOURCES;
export const TREE_SUBJECT_NAMES = TREE_SUBJECTS;
