import { spawnGitSync } from '../../corpus/hooks/lib/git-executable.mjs';
import path from 'node:path';
import { extract, SOURCE_EXTENSIONS } from '../repo-map/lexical-extractor.mjs';
import { readFileSafe } from '../repo-map/scan.mjs';
import { matchesScope, parseImpactedFiles } from '../plan-scope.mjs';
import { readStructuralIndex } from './shape.mjs';

export const STRUCTURAL_CHECK_ID = 'structural-expectations';

const EXPECTATION_CHANGES = new Set(['added', 'removed', 'modified']);
const MAX_FINDING_NAMES = 50;

function capList(list) {
  return list.length > MAX_FINDING_NAMES ? list.slice(0, MAX_FINDING_NAMES) : list;
}

/** `{ added: [...] }` → `{ addedTotal: n }` for each list the cap shortened. */
function overflow(lists) {
  const extra = {};
  for (const [field, list] of Object.entries(lists)) {
    if (list.length > MAX_FINDING_NAMES) extra[`${field}Total`] = list.length;
  }
  return extra;
}

function shortSha(sha) {
  return String(sha || '').slice(0, 12);
}

function baselineIsAncestor(workspace, sha) {
  const result = spawnGitSync(['merge-base', '--is-ancestor', sha, 'HEAD'], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 15_000,
  });
  return result.status === 0;
}

function symbolFile(qualified) {
  const at = String(qualified || '').indexOf('#');
  return at === -1 ? String(qualified || '') : String(qualified).slice(0, at);
}

function diffChangedFiles({ workspace, index, changedFiles }) {
  const rowsByFile = new Map();
  for (const row of index.symbols) {
    if (!row || typeof row.file !== 'string' || typeof row.name !== 'string') continue;
    if (!rowsByFile.has(row.file)) rowsByFile.set(row.file, []);
    rowsByFile.get(row.file).push(row);
  }

  const diffs = new Map();
  const tierSkipped = new Map();
  const notEvaluated = new Map();
  for (const file of changedFiles) {
    const ext = path.extname(file).toLowerCase();
    const rows = rowsByFile.get(file) || [];
    const fileEntry = index.files[file];
    if (!SOURCE_EXTENSIONS.has(ext) && !fileEntry && rows.length === 0) {
      notEvaluated.set(file, `no baseline entry and ${ext || 'no extension'} is not a language this check reads`);
      continue;
    }
    const tier =
      typeof fileEntry?.tier === 'string'
        ? fileEntry.tier
        : typeof index.meta?.extractorTier === 'string'
          ? index.meta.extractorTier
          : null;
    if (tier && tier !== 'lexical') {
      tierSkipped.set(file, tier);
      continue;
    }

    let current = [];
    let currentExported = [];
    const content = readFileSafe(workspace, file);
    if (content) {
      try {
        const extracted = extract(file, content);
        current = extracted.symbols;
        currentExported = extracted.exported || [];
      } catch {
        current = [];
      }
    }
    const currentSet = new Set(current);
    const currentExportedSet = new Set(currentExported);
    const baselineNames = new Set([
      ...(Array.isArray(fileEntry?.symbols) ? fileEntry.symbols : []),
      ...rows.map((row) => row.name),
    ]);
    const exportedRows = rows.filter((row) => row.exported === true);
    const added = current.filter((name) => !baselineNames.has(name)).sort();

    diffs.set(file, {
      added,
            addedExported: added.filter((name) => currentExportedSet.has(name)),
      removed: [...baselineNames].filter((name) => !currentSet.has(name)).sort(),
      removedExported: [...new Set(exportedRows.map((row) => row.name))].filter((name) => !currentSet.has(name)).sort(),
      baselineNames,
      currentSet,
    });
  }
  return { diffs, tierSkipped, notEvaluated };
}

/** Caller lookup tables, built ONCE per run. Building them per removed symbol
 * re-walked the whole call-edge and symbol-row tables for every candidate. */
function callerIndex(index) {
  const byTarget = new Map();
  const add = (key, file) => {
    if (!file) return;
    if (!byTarget.has(key)) byTarget.set(key, new Set());
    byTarget.get(key).add(file);
  };
  for (const edge of index.graph.calls) {
    if (edge && typeof edge.to === 'string') add(edge.to, symbolFile(edge.from));
  }
  for (const row of index.symbols) {
    if (typeof row?.file !== 'string' || typeof row?.name !== 'string') continue;
    for (const ref of Array.isArray(row.refs) ? row.refs : []) {
      if (ref && typeof ref.file === 'string') add(`${row.file}#${row.name}`, ref.file);
    }
  }
  return byTarget;
}

function survivingCallers({ callers, file, symbol, changedSet }) {
  const found = callers.get(`${file}#${symbol}`);
  if (!found) return [];
  return [...found].filter((caller) => caller && caller !== file && !changedSet.has(caller)).sort();
}

function expectationObserved(expectation, diffs) {
  const diff = diffs.get(expectation.file);
  if (!diff) return false;
  if (expectation.change === 'added') return diff.added.includes(expectation.symbol);
  if (expectation.change === 'removed') return diff.removed.includes(expectation.symbol);
  // modified: the file changed and the symbol survived on both sides.
  return diff.baselineNames.has(expectation.symbol) && diff.currentSet.has(expectation.symbol);
}

function evaluateExpectations(plan, diffs, tierSkipped = new Map(), notEvaluated = new Map()) {
  const raw = plan.fm?.structural_expectations;
  const findings = [];
  const informational = [];
  if (raw === undefined || raw === null) return { findings, informational };
  if (!Array.isArray(raw)) {
    informational.push({ type: 'malformed-expectations', message: 'structural_expectations must be a list; block ignored' });
    return { findings, informational };
  }
  for (const entry of raw) {
    const valid =
      entry &&
      typeof entry === 'object' &&
      typeof entry.file === 'string' &&
      typeof entry.symbol === 'string' &&
      EXPECTATION_CHANGES.has(entry.change);
    if (!valid) {
      informational.push({ type: 'malformed-expectation', entry, message: 'expected {file, symbol, change: added|removed|modified}' });
      continue;
    }
    if (tierSkipped.has(entry.file)) {
      informational.push({
        type: 'tier-mismatch-skipped',
        file: entry.file,
        symbol: entry.symbol,
        change: entry.change,
        message: `expectation on ${entry.file} not evaluated: baseline entry tier '${tierSkipped.get(entry.file)}' does not match the lexical current side`,
      });
      continue;
    }
    if (notEvaluated.has(entry.file)) {
      informational.push({
        type: 'expectation-not-evaluated',
        file: entry.file,
        symbol: entry.symbol,
        change: entry.change,
        message: `expectation on ${entry.file} not evaluated: ${notEvaluated.get(entry.file)}`,
      });
      continue;
    }
    if (expectationObserved(entry, diffs)) continue;
    const description = { type: 'unmet-expectation', file: entry.file, symbol: entry.symbol, change: entry.change };
    if (entry.required === true) findings.push({ ...description, type: 'unmet-required-expectation' });
    else informational.push(description);
  }
  return { findings, informational };
}

export function runStructuralExpectations({ workspace, plan, changedFiles, home }) {
  try {
    const index = readStructuralIndex(workspace, { home });
    if (!index.present) {
      return { status: 'skipped', message: `Advisory structural check skipped: ${index.reason}`, findings: [], informational: [], baseline: null };
    }
    const baseline = {
      sha: index.meta.sha,
      generatedAt: index.meta.generatedAt ?? null,
      extractorTier: index.meta.extractorTier ?? null,
    };
    if (!baselineIsAncestor(workspace, index.meta.sha)) {
      return {
        status: 'skipped',
        message: `Structural baseline ${shortSha(index.meta.sha)} is not an ancestor of HEAD; rerun ae index --structural`,
        findings: [],
        informational: [],
        baseline,
      };
    }

    const changed = [...new Set(changedFiles || [])];
    const changedSet = new Set(changed);
    const allowed = parseImpactedFiles(plan);
    const { diffs, tierSkipped, notEvaluated } = diffChangedFiles({ workspace, index, changedFiles: changed });
    const tierNotes = [...tierSkipped].map(([file, tier]) => ({
      type: 'tier-mismatch-skipped',
      file,
      tier,
      message: `baseline entry for ${file} was built by the '${tier}' extractor tier; the current side is lexical — symbol diff skipped as unsound`,
    }));
    const notEvaluatedNotes = [...notEvaluated].map(([file, reason]) => ({
      type: 'file-not-evaluated',
      file,
      message: `${file} not compared: ${reason}`,
    }));

    const truncated = [
      index.meta?.symbolsTruncated ? 'symbol table' : null,
      index.meta?.callEdgesTruncated ? 'call edges' : null,
    ].filter(Boolean);
    const findings = [];
    const degraded = [];
    const record = (finding) => {
      if (truncated.length) {
        degraded.push({
          ...finding,
          type: `${finding.type}-informational`,
          message: `${finding.type} not asserted: the baseline ${truncated.join(' and ')} hit the index build cap, so this comparison is incomplete`,
        });
      } else {
        findings.push(finding);
      }
    };
    let callers = null;
    for (const [file, diff] of diffs) {
      const symbolChanges = [...diff.addedExported, ...diff.removedExported];
      if (symbolChanges.length && !matchesScope(file, allowed)) {
        record({
          type: 'unplanned-symbol-change',
          file,
          added: capList(diff.addedExported),
          removed: capList(diff.removedExported),
          ...overflow({ added: diff.addedExported, removed: diff.removedExported }),
        });
      }
      for (const symbol of diff.removedExported) {
        callers ??= callerIndex(index);
        const surviving = survivingCallers({ callers, file, symbol, changedSet });
        if (surviving.length) {
          record({
            type: 'removed-symbol-with-callers',
            file,
            symbol,
            callers: capList(surviving),
            ...overflow({ callers: surviving }),
          });
        }
      }
    }

    const expectations = evaluateExpectations(plan, diffs, tierSkipped, notEvaluated);
    findings.push(...expectations.findings);
    const informational = [...tierNotes, ...notEvaluatedNotes, ...degraded, ...expectations.informational];

    if (findings.length) {
      const kinds = [...new Set(findings.map((finding) => finding.type))].join(', ');
      return {
        status: 'failed',
        message: `${findings.length} structural finding${findings.length === 1 ? '' : 's'} (${kinds})`,
        findings,
        informational,
        baseline,
      };
    }
    const skippedFiles = tierSkipped.size + notEvaluated.size;
    if (diffs.size === 0) {
      return {
        status: 'skipped',
        message: `Structural check compared nothing (0 files examined${skippedFiles ? `, ${skippedFiles} skipped` : ''})`,
        findings,
        informational,
        baseline,
      };
    }
    return {
      status: 'passed',
      message: `Structural diff matches the plan (${diffs.size} file${diffs.size === 1 ? '' : 's'} examined${tierSkipped.size ? `, ${tierSkipped.size} tier-mismatch-skipped` : ''})`,
      findings,
      informational,
      baseline,
    };
  } catch (error) {
    // The advisory machinery must never be the reason a verify run breaks.
    return { status: 'skipped', message: `Advisory structural check skipped: ${error.message}`, findings: [], informational: [], baseline: null };
  }
}
