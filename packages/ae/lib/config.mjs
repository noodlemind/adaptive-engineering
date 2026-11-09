import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { EXIT } from './style.mjs';
import { writeFileContained, readFileNoFollow, assertNoSymlinkAncestors, canonicalPath } from './fs-safe.mjs';
import { DEFAULT_PROVIDER, PROVIDER_IDS } from './provider.mjs';

import { projectAuthorityFile } from './project-authority.mjs';

export const CONFIG_SCHEMA_VERSION = 1;

export const AGENT_LIMITS = Object.freeze({
  maxTurns: Object.freeze({ min: 1, max: 500 }),
  maxSeconds: Object.freeze({ min: 1, max: 86_400 }),
  toolTimeout: Object.freeze({ min: 1, max: 3600 }),
});

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

export const CONFIG_SCHEMA = Object.freeze({
  'exec.timeout_seconds': {
    type: 'number',
    default: 600,
        merge: 'restrictive',
    restrict: (a, b) => Math.min(a, b),
    description: 'default seconds before an executed process tree is terminated',
    validate: (value) => {
      if (!Number.isInteger(value) || value < 1 || value > 3600) {
        throw usageError('exec.timeout_seconds must be an integer from 1 to 3600');
      }
      return value;
    },
  },
  'exec.allow_env': {
    type: 'list',
    default: [],
        merge: 'union',
    description: 'environment variable names passed through to executed processes',
    validate: (value) => {
      for (const name of value) {
        if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          throw usageError(`exec.allow_env entries must be environment variable names (got ${JSON.stringify(name)})`);
        }
      }
      return value;
    },
  },
  'exec.network': {
    type: 'enum',
    values: ['allow', 'deny'],
    default: 'allow',
        merge: 'restrictive',
    restrict: (a, b) => (a === 'deny' || b === 'deny' ? 'deny' : 'allow'),
    description: 'whether executed processes may reach the network (deny is enforced only where the platform has a primitive)',
  },
  'checks.env_allowlist': {
    type: 'boolean',
        default: false,
        merge: 'restrictive',
    restrict: (a, b) => a || b,
    description: 'apply the exec environment allowlist to named checks too',
  },
  'runs.retention_days': {
    type: 'number',
    default: 30,
        merge: 'override',
    description: 'days of run and event history to keep before pruning',
    validate: (value) => {
      if (!Number.isInteger(value) || value < 1 || value > 3650) {
        throw usageError('runs.retention_days must be an integer from 1 to 3650');
      }
      return value;
    },
  },
  'exec.bash_enabled': {
    type: 'boolean',
    default: true,
        merge: 'restrictive',
    restrict: (a, b) => a && b,
    description: 'whether `ae bash` may run a shell at all',
  },

  'agent.enabled': {
    type: 'boolean',
    default: false,
    merge: 'restrictive',
    restrict: (a, b) => a && b,
    description: 'master switch for the agent loop; off = no provider is ever started',
  },
    'agent.providers': {
    type: 'list',
    default: [DEFAULT_PROVIDER],
    merge: 'restrictive',
    restrict: (a, b) => {
      const allowed = new Set(a);
      return b.filter((id) => allowed.has(id));
    },
    description: 'enabled provider ids (disabled providers are hidden and cannot start)',
    validate: (value) => {
      if (!Array.isArray(value) || value.length === 0) {
        throw usageError('agent.providers must list at least one known provider id');
      }
      const out = [];
      const seen = new Set();
      for (const raw of value) {
        const id = String(raw ?? '').trim();
        if (!id) continue;
        if (!PROVIDER_IDS.includes(id)) {
          throw usageError(
            `unknown provider in agent.providers: ${id}`,
            `known providers: ${PROVIDER_IDS.join(', ')}`,
          );
        }
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
      if (!out.length) {
        throw usageError('agent.providers must list at least one known provider id');
      }
      return out;
    },
  },
  'agent.provider': {
    type: 'string',
    default: DEFAULT_PROVIDER,
    merge: 'override',
    description: 'default provider for `ae agent` (must also be in agent.providers)',
  },
  'agent.model': {
    type: 'string',
    default: '',
    merge: 'override',
    description: 'default model id; empty means the provider default (or auto)',
  },
  'agent.max_turns': {
    type: 'number',
    default: 30,
        merge: 'restrictive',
    restrict: (a, b) => Math.min(a, b),
    description: 'default turn budget for `ae agent` (--max-turns overrides)',
    validate: (value) => {
      const { min, max } = AGENT_LIMITS.maxTurns;
      if (!Number.isInteger(value) || value < min || value > max) {
        throw usageError(`agent.max_turns must be an integer from ${min} to ${max}`);
      }
      return value;
    },
  },
  'agent.max_seconds': {
    type: 'number',
    default: 1800,
    merge: 'restrictive',
    restrict: (a, b) => Math.min(a, b),
    description: 'default wall-clock budget in seconds for `ae agent` (--max-seconds overrides)',
    validate: (value) => {
      const { min, max } = AGENT_LIMITS.maxSeconds;
      if (!Number.isInteger(value) || value < min || value > max) {
        throw usageError(`agent.max_seconds must be an integer from ${min} to ${max}`);
      }
      return value;
    },
  },
  'agent.profile': {
    type: 'enum',
    values: ['deliver', 'autonomous', 'bench', 'benchmark'],
    default: 'autonomous',
    merge: 'override',
    description:
      'optional agent track: deliver (product-minded) or autonomous/bench (verifier-shaped long-horizon; no plan/gate/compound). '
      + 'benchmark is a test fixture alias. Does not enable agent.enabled.',
  },

    'tui.density': {
    type: 'enum',
    values: ['compact', 'comfortable'],
        default: 'comfortable',
    merge: 'override',
    description: 'blank line between ledger blocks (comfortable, default) or none (compact)',
  },
  'tui.dividers': {
    type: 'boolean',
    default: false,
    merge: 'override',
    description: 'draw a rule between ledger blocks instead of relying on the tint',
  },
  'tui.statusline': {
    type: 'list',
        ordered: true,
    default: ['plan', 'gate', 'agent', 'shell', 'run', 'knowledge'],
    merge: 'override',
    description: 'footer items, in order (plan, gate, agent, shell, run, knowledge)',
    validate: (value) => {
      const allowed = ['plan', 'gate', 'agent', 'shell', 'run', 'knowledge'];
      for (const item of value) {
        if (!allowed.includes(item)) {
          throw usageError(`tui.statusline entries must be one of ${allowed.join(', ')} (got ${JSON.stringify(item)})`);
        }
      }
      return value;
    },
  },
  'tui.scheme': {
    type: 'enum',
    values: ['default', 'colorblind'],
    default: 'default',
    merge: 'override',
        description: 'semantic palette: default, or colorblind (Okabe-Ito, no green/red axis)',
  },
  'tui.tint': {
    type: 'enum',
    values: ['auto', 'dark', 'light', 'off'],
    default: 'auto',
    merge: 'override',
        description: 'block tint ground: auto-detect, force dark/light, or off for maximum contrast',
  },
  'tui.palette_chord': {
    type: 'enum',
    values: ['ctrl+p', 'ctrl+k', 'ctrl+space'],
    default: 'ctrl+p',
    merge: 'override',
        description: 'chord that opens the command palette',
  },
  'tui.startup': {
    type: 'list',
    default: ['context', 'knowledge', 'shortcuts'],
    merge: 'override',
    description: 'sections shown when the ledger opens (context, knowledge, shortcuts)',
    validate: (value) => {
      const allowed = ['context', 'knowledge', 'shortcuts'];
      for (const item of value) {
        if (!allowed.includes(item)) {
          throw usageError(`tui.startup entries must be one of ${allowed.join(', ')} (got ${JSON.stringify(item)})`);
        }
      }
      return value;
    },
  },
  'tui.verbosity': {
    type: 'enum',
    values: ['normal', 'screen-reader'],
    default: 'normal',
    merge: 'override',
        description: 'screen-reader mode: no repainting region, no tints, status stated in words',
  },
  'tui.alt_screen': {
    type: 'boolean',
    default: false,
    merge: 'override',
        description: 'render in the alternate screen instead of the main buffer (costs scrollback)',
  },
  'tui.restore': {
    type: 'number',
    default: 8,
    merge: 'override',
    description: 'how many prior runs the ledger restores from the journal on open',
    validate: (value) => {
      if (!Number.isInteger(value) || value < 0 || value > 100) {
        throw usageError('tui.restore must be an integer from 0 to 100');
      }
      return value;
    },
  },
  'walkthrough.seen': {
    type: 'boolean',
    default: false,
    merge: 'user',
    description: 'first-run Adaptive Engineer walkthrough has been dismissed',
  },
});

export const CONFIG_KEYS = Object.freeze(Object.keys(CONFIG_SCHEMA));

export const SCOPES = Object.freeze(['user', 'project']);

/** Where each scope's file lives. Project sits beside policy.yaml and
 * checks.yaml, because a reader looking for harness configuration should find
 * all of it in one directory. */
export function configPathFor(scope, { copilotHome, workspace, home }) {
  if (scope === 'user') return path.join(copilotHome, 'harness', 'config.yaml');
  if (scope === 'project') return projectAuthorityFile(workspace, 'config.yaml', { home }).path;
  throw usageError(`unknown scope: ${scope}`, `scope must be one of: ${SCOPES.join(', ')}`);
}

export function coerceValue(key, raw) {
    const spec = Object.hasOwn(CONFIG_SCHEMA, key) ? CONFIG_SCHEMA[key] : null;
  if (!spec) {
    throw usageError(`unknown config key: ${key}`, `known keys: ${CONFIG_KEYS.join(', ')}`);
  }
  let value = raw;
  if (spec.type === 'number') {
    if (typeof raw === 'string') {
      if (!/^-?\d+$/.test(raw.trim())) throw usageError(`${key} must be an integer (got ${JSON.stringify(raw)})`);
      value = Number(raw.trim());
    }
    if (typeof value !== 'number') throw usageError(`${key} must be a number (got ${JSON.stringify(raw)})`);
  } else if (spec.type === 'boolean') {
    if (typeof raw === 'string') {
      const t = raw.trim().toLowerCase();
      if (!['true', 'false'].includes(t)) throw usageError(`${key} must be true or false (got ${JSON.stringify(raw)})`);
      value = t === 'true';
    }
    if (typeof value !== 'boolean') throw usageError(`${key} must be a boolean (got ${JSON.stringify(raw)})`);
  } else if (spec.type === 'list') {
    if (typeof raw === 'string') {
      value = raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(value)) throw usageError(`${key} must be a list (got ${JSON.stringify(raw)})`);
  } else if (spec.type === 'string') {
    if (typeof value !== 'string') throw usageError(`${key} must be a string (got ${JSON.stringify(raw)})`);
    value = value.trim();
  } else if (spec.type === 'enum') {
    if (typeof value !== 'string' || !spec.values.includes(value)) {
      throw usageError(`${key} must be one of ${spec.values.join(', ')} (got ${JSON.stringify(raw)})`);
    }
  }
  return spec.validate ? spec.validate(value) : value;
}

export function loadConfigFile(file, { root = path.dirname(file) } = {}) {
  let doc;
  try {
    if (!fs.lstatSync(file, { throwIfNoEntry: false })) return { exists: false, values: {}, errors: [] };
    if (!assertNoSymlinkAncestors(canonicalPath(root), path.relative(path.resolve(root), path.resolve(file)))) throw new Error('configuration source is unsafe or symlinked');
    const text = readFileNoFollow(file, { root, maxBytes: 1024 * 1024 });
    if (text === null) throw new Error('configuration source is unreadable, nonregular or larger than 1 MiB');
    doc = YAML.parse(text, { maxAliasCount: 50 });
  } catch (error) {
    return { exists: true, values: {}, errors: [`${file}: ${error.message}`] };
  }
  if (doc === null || doc === undefined) return { exists: true, values: {}, errors: [] };
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    return { exists: true, values: {}, errors: [`${file}: expected a YAML mapping`] };
  }

  const errors = [];
  const values = {};
  const settings = doc.config && typeof doc.config === 'object' && !Array.isArray(doc.config) ? doc.config : doc;
  for (const [key, raw] of Object.entries(settings)) {
    if (key === 'version') continue;
    if (!Object.hasOwn(CONFIG_SCHEMA, key)) {
      errors.push(`${file}: unknown key ${key}`);
      continue;
    }
    try {
      values[key] = coerceValue(key, raw);
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
    }
  }
  return { exists: true, values, errors };
}

export function resolveConfig({ copilotHome, workspace, projectTrusted = true, home } = {}) {
  const userFile = configPathFor('user', { copilotHome, workspace });
  let projectFile;
  const user = loadConfigFile(userFile, { root: copilotHome });
  let project;
  try {
    const authority = projectAuthorityFile(workspace, 'config.yaml', { home });
    projectFile = authority.path;
    project = loadConfigFile(projectFile, { root: authority.root });
  } catch (error) {
    project = { exists: true, values: {}, errors: [error.message] };
  }

  const values = {};
  const provenance = {};
  for (const key of CONFIG_KEYS) {
    const spec = CONFIG_SCHEMA[key];
    let value = spec.default;
    let source = 'default';
    let file = null;
    let note;

    if (key in user.values) {
      value = user.values[key];
      source = 'user';
      file = userFile;
    }

    const projectSets = key in project.values;
    if (projectSets && !projectTrusted) {
      // Parsed and shown, never applied — see the module note on trust.
      note = 'ignored: project is not trusted';
    } else if (projectSets) {
      const projectValue = project.values[key];
      if (spec.merge === 'user') {
        note = 'ignored: this key is user-scoped';
      } else if (spec.merge === 'restrictive') {
        const restricted = spec.restrict(value, projectValue);
        if (restricted !== value) {
          value = restricted;
          source = 'project';
          file = projectFile;
        } else if (restricted !== projectValue) {
          note = source === 'default'
            ? 'project asked for a less restrictive value than the default; the default wins'
            : 'project asked for a less restrictive value; the user scope wins';
        }
      } else if (spec.merge === 'union') {
        const merged = [...new Set([...(Array.isArray(value) ? value : []), ...projectValue])].sort();
        value = merged;
        source = source === 'default' ? 'project' : 'user+project';
        file = projectFile;
      } else {
        value = projectValue;
        source = 'project';
        file = projectFile;
      }
    }

    values[key] = spec.type === 'list' && Array.isArray(value)
      ? (spec.ordered ? [...new Set(value)] : [...new Set(value)].sort())
      : value;
    provenance[key] = { source, file, ...(note ? { note } : {}) };
  }

  return {
    values,
    provenance,
    errors: [...user.errors, ...project.errors],
    files: {
      user: { path: userFile, exists: user.exists },
      project: { path: projectFile, exists: project.exists, trusted: projectTrusted },
    },
  };
}

export function setConfigValue({ scope, key, value, copilotHome, workspace, home }) {
  if (!SCOPES.includes(scope)) {
    throw usageError(`unknown scope: ${scope}`, `scope must be one of: ${SCOPES.join(', ')}`);
  }
  if (CONFIG_SCHEMA[key]?.merge === 'user' && scope === 'project') {
    throw usageError(`${key} is user-scoped`, 'use --scope user');
  }
  const coerced = coerceValue(key, value);
  const file = configPathFor(scope, { copilotHome, workspace, home });
  const existing = loadConfigFile(file, { root: scope === 'user' ? copilotHome : projectAuthorityFile(workspace, 'config.yaml', { home }).root });
  if (existing.errors.length && existing.exists) {
    throw Object.assign(new Error(`refusing to write over a config with errors: ${existing.errors[0]}`), {
      code: 'E_TARGET',
      exit: 1,
      hint: 'fix the file by hand, or run `ae config validate` to see every error',
    });
  }

  const merged = { version: CONFIG_SCHEMA_VERSION, ...existing.values, [key]: coerced };
  const root = scope === 'user' ? copilotHome : projectAuthorityFile(workspace, 'config.yaml', { home }).root;
  const rel = path.relative(root, file);
  const written = writeFileContained(root, rel, YAML.stringify(merged));
  if (!written) {
    throw Object.assign(new Error(`could not write ${file}`), {
      code: 'E_TARGET',
      exit: 1,
      hint: 'the path is not writable, or an ancestor is a symlink out of the scope root',
    });
  }
  return { file: written, key, value: coerced, scope };
}

export function unsetConfigValue({ scope, keys, copilotHome, workspace, home }) {
  if (!SCOPES.includes(scope)) {
    throw usageError(`unknown scope: ${scope}`, `scope must be one of: ${SCOPES.join(', ')}`);
  }
  const named = Array.isArray(keys) ? keys : [keys];
  for (const key of named) {
    if (!Object.hasOwn(CONFIG_SCHEMA, key)) {
      throw usageError(`unknown config key: ${key}`, `known keys: ${CONFIG_KEYS.join(', ')}`);
    }
  }
  const file = configPathFor(scope, { copilotHome, workspace, home });
  const existing = loadConfigFile(file, { root: scope === 'user' ? copilotHome : projectAuthorityFile(workspace, 'config.yaml', { home }).root });
  if (!existing.exists) return { file, keys: named, scope, removed: [] };
  if (existing.errors.length) {
    throw Object.assign(new Error(`refusing to write over a config with errors: ${existing.errors[0]}`), {
      code: 'E_TARGET',
      exit: 1,
      hint: 'fix the file by hand, or run `ae config validate` to see every error',
    });
  }
  const removed = named.filter((key) => key in existing.values);
  if (!removed.length) return { file, keys: named, scope, removed };
  const remaining = { ...existing.values };
  for (const key of removed) delete remaining[key];
  const root = scope === 'user' ? copilotHome : projectAuthorityFile(workspace, 'config.yaml', { home }).root;
  const written = writeFileContained(root, path.relative(root, file), YAML.stringify({ version: CONFIG_SCHEMA_VERSION, ...remaining }));
  if (!written) {
    throw Object.assign(new Error(`could not write ${file}`), {
      code: 'E_TARGET',
      exit: 1,
      hint: 'the path is not writable, or an ancestor is a symlink out of the scope root',
    });
  }
  return { file: written, keys: named, scope, removed };
}
