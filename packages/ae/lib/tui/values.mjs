import { PROVIDER_MODELS, providerReadiness } from '../provider.mjs';
import { readModelCache } from '../model-cache.mjs';
import { CONFIG_SCHEMA, CONFIG_KEYS, SCOPES } from '../config.mjs';
import { readJournal, foldRuns } from '../run-journal.mjs';
import { completePath } from './complete.mjs';
import { listLocalPrimitives } from '../primitive-origins.mjs';

/** How many rows a value picker offers before it stops being a glance. Paths
 * and runs are truncated to this; the filter is how you reach the rest. */
export const MAX_VALUES = 40;

/** One offerable value. `value` is what goes on argv; everything else is for
 * the eye. `unavailable` greys the row and states why, the same contract the
 * command palette follows for a command that cannot run. */
function item(value, { label = null, note = '', unavailable = null } = {}) {
  return { value, label: label ?? String(value), note, unavailable };
}

function providers({ parentEnv }) {
  const ready = providerReadiness({ parentEnv });
  return [...ready]
    .sort((a, b) => (a.ready === b.ready ? a.id.localeCompare(b.id) : a.ready ? -1 : 1))
    .map((p) => item(p.id, {
      note: p.ready ? p.how || 'ready' : p.reason || 'not configured',
      unavailable: p.ready ? null : p.reason || 'not configured',
    }));
}

function models({ values, copilotHome }) {
  const cache = copilotHome ? readModelCache(copilotHome) : {};
  const listFor = (id) => {
    const fetched = cache?.[id];
    if (fetched?.models?.length) return { models: fetched.models, labels: fetched.labels ?? {}, fetched: true };
    return { models: PROVIDER_MODELS[id] ?? [], labels: {}, fetched: false };
  };
  const chosen = values?.provider ?? values?.['--provider'] ?? null;
  if (chosen && (PROVIDER_MODELS[chosen] || cache?.[chosen]?.models?.length)) {
    const { models: list, labels, fetched } = listFor(chosen);
    return list.map((m, i) => item(m, {
      note: labels[m] || (i === 0 ? (fetched ? 'provider default · fetched' : 'provider default') : ''),
    }));
  }
  const out = [];
  const ids = new Set([...Object.keys(PROVIDER_MODELS), ...Object.keys(cache ?? {})]);
  for (const provider of ids) {
    for (const m of listFor(provider).models) out.push(item(m, { note: provider }));
  }
  return out;
}

/** Configuration keys, each with the sentence the schema already carries. */
function configKeys() {
  return CONFIG_KEYS.map((key) => item(key, { note: CONFIG_SCHEMA[key]?.description || '' }));
}

function configValues({ values }) {
  const key = values?.key ?? null;
  const schema = key ? CONFIG_SCHEMA[key] : null;
  if (!schema) return [];
  if (schema.type === 'enum' && Array.isArray(schema.values)) {
    return schema.values.map((v) => item(v, { note: v === schema.default ? 'default' : '' }));
  }
  if (schema.type === 'boolean') {
    return [true, false].map((v) => item(String(v), { note: v === schema.default ? 'default' : '' }));
  }
  return [];
}

/** Workspace-relative paths. `completePath` already refuses traversal, so the
 * picker inherits the confinement rather than re-deciding it. */
function paths({ workspace, query }) {
  return completePath(String(query ?? ''), { workspace, limit: MAX_VALUES })
    .map((hit) => item(hit.path, { note: hit.kind === 'dir' ? 'directory' : '' }));
}

/** Plan files, newest name first — plans are date-prefixed, so a reverse sort
 * on the name is a reverse sort on the date without reading any of them. */
function plans({ workspace }) {
    const hits = [
    ...completePath('docs/plans/', { workspace, limit: Number.MAX_SAFE_INTEGER }),
    ...completePath('.harness/plans/', { workspace, limit: Number.MAX_SAFE_INTEGER }),
  ];
  return hits
    .filter((hit) => hit.kind === 'file' && hit.path.endsWith('.md'))
    .sort((a, b) => b.path.localeCompare(a.path))
    .slice(0, MAX_VALUES)
    .map((hit) => item(hit.path, { note: '' }));
}

/** Runs from the journal, most recent first. Degrades to nothing in a
 * workspace that has never run a command, which is a normal state and not an
 * error worth reporting inside a picker. */
function runs({ workspace }) {
    const folded = foldRuns(readJournal(workspace));
  return [...folded]
    .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
    .slice(0, MAX_VALUES)
    .map((r) => item(r.run, {
      label: String(r.run ?? '').slice(0, 8),
      note: [r.command, r.status].filter(Boolean).join(' · '),
    }));
}

const STATE_RANK = { invalid: 0, stray: 1, stale: 2, pending: 3, registered: 4 };

function primitives({ copilotHome }) {
  if (!copilotHome) return [];
  return listLocalPrimitives(copilotHome)
    .sort((a, b) => (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9) || a.path.localeCompare(b.path))
    .slice(0, MAX_VALUES)
    .map((p) => item(p.path, { note: `${p.state} · ${p.reason}` }));
}

const FREE = new Set(['path', 'plan', 'model', 'config-value', 'primitive']);

const RESOLVERS = {
  provider: providers,
  model: models,
  scope: () => SCOPES.map((s) => item(s, {
    note: s === 'user' ? 'applies everywhere for you' : 'applies to this project, for everyone',
  })),
  'config-key': configKeys,
  'config-value': configValues,
  path: paths,
  plan: plans,
  run: runs,
  primitive: primitives,
};

export function resolveValues(choices, { workspace = process.cwd(), copilotHome = null, parentEnv = process.env, values = {}, query = '' } = {}) {
  if (!choices) return { items: [], free: true };
  if (choices.literal) {
    return { items: choices.literal.map((v) => item(v)), free: false };
  }
  const resolver = RESOLVERS[choices.source];
  if (!resolver) return { items: [], free: true };
  let items = [];
  try {
    items = resolver({ workspace, copilotHome, parentEnv, values, query }) || [];
  } catch {
    return { items: [], free: true };
  }
  return { items: items.slice(0, MAX_VALUES), free: FREE.has(choices.source) || items.length === 0 };
}
