import { getCommand, hasCommand, validateArgs } from '../registry.mjs';
import { buildCommandIndex } from '../command-index.mjs';
import { selectionPlan } from './palette.mjs';

function rejectedByValidation(name, rest) {
  const entry = getCommand(name);
  if (!entry) return true;
  try {
    validateArgs(entry, rest);
  } catch {
    return true;
  }
  return false;
}

function leadingWords(row) {
  const words = [];
  for (const token of row.argvTokens || []) {
    if (token.kind === 'command' || token.kind === 'subcommand') words.push(token.value);
    else if (token.kind === 'flag') words.push(String(token.value).replace(/^-+/, ''));
    else break;
  }
  return words;
}

function bestRow(rows, argv) {
  let best = null;
  for (const row of rows) {
    const words = leadingWords(row);
    if (!words.length || words.length > argv.length) continue;
    if (words.some((w, i) => w !== argv[i])) continue;
    if (!best || words.length > leadingWords(best).length) best = row;
  }
  return best;
}

export function routeTypedLine(argv, { workspace = process.cwd(), index = null } = {}) {
  if (!Array.isArray(argv) || !argv.length) return null;
  const [name, ...rest] = argv;
  if (typeof name !== 'string' || !hasCommand(name)) return null;
    if (argv.some((a) => typeof a === 'string' && (a === '--' || a.startsWith('-')))) return null;
    if (rejectedByValidation(name, rest)) return null;

  const rows = (index ?? buildCommandIndex({ surface: 'tui', workspace })).rows.filter((r) => r.noun === name);
  const row = bestRow(rows, argv);
  if (!row) return null;

  const words = leadingWords(row);
  const supplied = argv.slice(words.length);

    if (row.picker) return supplied.length ? { row, values: {}, plan: null, picker: row.picker } : null;

  const slots = (row.argvTokens || []).filter((t) => t.kind === 'value');
    if (supplied.length > slots.length) return null;

  const values = {};
  for (let i = 0; i < supplied.length; i += 1) {
    const slot = slots[i];
    if (!slot) return null;
    const allowed = slot.choices?.literal;
    if (Array.isArray(allowed) && allowed.length && !allowed.includes(supplied[i])) return null;
    values[slot.flag ?? slot.positional] = supplied[i];
  }

    const plan = selectionPlan(row, values);
  if (!plan.queue.length) return null;

  return { row, values, plan };
}
