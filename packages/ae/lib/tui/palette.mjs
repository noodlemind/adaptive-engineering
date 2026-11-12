import { buildCommandIndex, resolveArgv } from '../command-index.mjs';
import { getCommand, validateArgs } from '../registry.mjs';
import { parseFlags } from '../flags.mjs';
import { rankRows } from './ranking.mjs';

/** Flag syntax must never appear in a row a person is asked to read, nor in
 * anything they are asked to type. Exported so the contract test and the
 * renderer share one definition rather than two that can drift. */
export const FLAG_SYNTAX = /(^|\s)--(\s|$)|(^|\s)--[a-z]/i;

export function containsFlagSyntax(text) {
  return FLAG_SYNTAX.test(String(text ?? ''));
}

export function openPalette({ workspace = process.cwd(), copilotHome, query = '' } = {}) {
  const index = buildCommandIndex({ surface: 'tui', workspace, copilotHome });
  const rows = rankRows(index.rows, query);
  return {
    query,
    total: index.rows.length,
    rows,
    generation: index.generation ?? null,
  };
}

export function resolveSelection(row, values = {}) {
  if (!row) return { argv: null, missing: [], invalid: null };
  const filled = { ...values };
  // Ledger soft defaults — keep CLI strict; TUI fills what config-cmd already defaults.
  if (row.noun === 'config' && row.verb === 'set' && !filled['--scope'] && !filled.scope) {
    filled['--scope'] = 'user';
  }

  const missing = [];
  for (const token of row.argvTokens || []) {
    if (token.kind !== 'value') continue;
    const key = token.flag ?? token.positional;
    const value = filled[key];
    if (value === undefined || value === null || value === '') missing.push(key);
  }
  // Only require prompts that are requiredInTui (scope is soft).
  for (const p of row.prompts || []) {
    if (p.requiredInTui === false) continue;
    if (!p.required) continue;
    const key = p.flag || p.key;
    if (filled[key] === undefined || filled[key] === null || filled[key] === '') missing.push(key);
  }
  if (missing.length) return { argv: null, missing, invalid: null };

  const argv = resolveArgv(row, filled);
  if (!argv || !argv.length) return { argv: null, missing: [], invalid: 'this row resolves to no command' };
  // Ensure soft-defaulted scope lands on argv for config set.
  if (row.noun === 'config' && row.verb === 'set' && !argv.includes('--scope')) {
    argv.push('--scope', filled['--scope'] || 'user');
  }
  const [name, ...rest] = argv;
  const entry = getCommand(name);
  if (!entry) return { argv: null, missing: [], invalid: `unknown command: ${name}` };
  try {
    validateArgs(entry, rest);
    if (typeof entry.requireArgs === 'function') {
      const message = entry.requireArgs(rest, parseFlags(rest));
      // A hook may return a ready usage error, as dispatch accepts.
      if (message instanceof Error) return { argv: null, missing: [], invalid: message.message };
      if (message) return { argv: null, missing: [], invalid: message };
    }
  } catch (error) {
    return { argv: null, missing: [], invalid: error.message };
  }
  return { argv, missing: [], invalid: null };
}

/**
 * Human signature for the palette — never flag soup, never angle-bracket CLI.
 * People see "path · content", not "write--path <path> --content …".
 */
export function signatureOf(row) {
  if (!row) return '';
  const parts = [];
  for (const token of row.argvTokens || []) {
    if (token.kind !== 'value') continue;
    // Verb already lives in the product label ("Set config value").
    if (token.positional === 'verb') continue;
    const name = humanLabel(token.valueName || token.positional || token.flag);
    if (!name || name === 'verb') continue;
    parts.push(token.required === false ? `[${name}]` : name);
  }
  const flags = row.prompts || [];
  for (const flag of flags) {
    // Soft / defaulted prompts (scope) stay off the signature strip.
    if (flag.requiredInTui === false) continue;
    if (!flag.required) continue;
    if (flag.tui === 'cli-only') continue;
    const name = humanLabel(flag.flag || flag.valueName || flag.label);
    if (name) parts.push(name);
  }
  const optional = flags.filter((f) => !f.required && f.requiredInTui !== false && f.tui !== 'cli-only').length;
  if (optional) parts.push(`+${optional}`);
  return parts.join(' · ');
}

function humanLabel(flagOrPositional) {
  const raw = String(flagOrPositional ?? '');
  const long = raw.match(/--([A-Za-z0-9][A-Za-z0-9-]*)/);
  if (long) return long[1];
  return raw.replace(/^-+/, '');
}

export function promptsFor(row) {
  if (!row) return [];
  const fromTokens = (row.argvTokens || [])
    .filter((t) => t.kind === 'value')
    .map((t) => ({
      key: t.flag ?? t.positional,
            label: humanLabel(t.flag ?? t.positional),
            required: t.required !== false,
      type: 'string',
      description: t.valueName || '',
      // Where the answer can be picked from, when the registry declared it.
      choices: t.choices ?? null,
    }));
  const fromPrompts = (row.prompts || []).map((p) => ({
    key: p.flag,
    label: humanLabel(p.flag),
        required: Boolean(p.required),
    type: p.type || 'string',
    description: p.description || '',
    choices: p.choices ?? null,
  }));
  const seen = new Set();
  return [...fromTokens, ...fromPrompts].filter((p) => {
    if (!p.key || seen.has(p.key)) return false;
    seen.add(p.key);
    return true;
  });
}

export function selectionPlan(row, values = {}) {
  if (!row) return { ready: null, queue: [], untilResolves: false, invalid: 'no row' };

  const known = (key) => values[key] !== undefined && values[key] !== null && values[key] !== '';

  const all = promptsFor(row).filter((p) => p.tui !== 'cli-only' && p.requiredInTui !== false);
  const required = all.filter((p) => p.required && p.requiredInTui !== false && !known(p.key));
  if (required.length) {
    return { ready: null, queue: required, untilResolves: false, invalid: null };
  }

  const empty = resolveSelection(row, values);
  if (empty.argv) return { ready: empty.argv, queue: [], untilResolves: false, invalid: null };
  if (empty.missing?.length) {
    const byKey = new Map(all.map((p) => [p.key, p]));
    const queue = empty.missing.filter((key) => !known(key)).map((key) => byKey.get(key) || {
      key, label: humanLabel(key), required: true, type: 'string', description: '',
    });
    if (queue.length) return { ready: null, queue, untilResolves: false, invalid: null };
  }

    const optional = all.filter((p) => !p.required && p.type !== 'boolean' && !known(p.key));
  if (optional.length) {
    return { ready: null, queue: optional, untilResolves: true, invalid: null };
  }
  return { ready: null, queue: [], untilResolves: false, invalid: empty.invalid || 'this row cannot be resolved' };
}
