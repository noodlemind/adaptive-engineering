import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { isProjectTrusted } from './trust.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import {
  CONFIG_KEYS,
  CONFIG_SCHEMA,
  SCOPES,
  configPathFor,
  resolveConfig,
  setConfigValue,
} from './config.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export const CONFIG_VERBS = Object.freeze(['show', 'get', 'set', 'validate']);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

function notFoundError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_NOT_FOUND', exit: EXIT.notFound, hint });
}

function readValueFlag(argv, name) {
  const boundary = argv.indexOf('--');
  const scan = boundary === -1 ? argv : argv.slice(0, boundary);
  const eq = scan.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = scan.indexOf(name);
  if (i === -1) return null;
  const next = scan[i + 1];
  return next === undefined || next.startsWith('--') ? '' : next;
}

/**
 * Normalize set-style positionals so humans can type frontier-style sugar:
 *   set agent.enabled false
 *   set agent.enabled=false
 *   set agent.enabled = false
 * Without collapsing unrelated positionals (get still takes one key only).
 */
export function normalizeConfigPositionals(positionals, { verb }) {
  const out = [...positionals];
  if (verb !== 'set' && out[0] !== 'set') return out;

  // After verb: ["set", "agent.enabled=false"] or ["set", "agent.enabled", "=", "false"]
  const verbIdx = out[0] === 'set' ? 0 : -1;
  const start = verbIdx === 0 ? 1 : 0;
  if (out.length <= start) return out;

  const head = out[start];
  if (typeof head === 'string' && head.includes('=') && !head.startsWith('=')) {
    const eq = head.indexOf('=');
    const key = head.slice(0, eq);
    const value = head.slice(eq + 1);
    if (key) {
      const rest = out.slice(start + 1);
      return verbIdx === 0 ? ['set', key, value, ...rest] : [key, value, ...rest];
    }
  }

  // ["set", "agent.enabled", "=", "false"] or ["set", "agent.enabled", "="]
  if (out[start + 1] === '=') {
    const key = out[start];
    const value = out[start + 2] ?? null;
    const rest = out.slice(start + 3);
    if (verbIdx === 0) return value === null ? ['set', key] : ['set', key, value, ...rest];
    return value === null ? [key] : [key, value, ...rest];
  }

  return out;
}

function context(argv) {
  const flags = parseFlags(argv);
  const rawPositionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (a.startsWith('--')) {
      if (!a.includes('=') && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i += 1;
      continue;
    }
    rawPositionals.push(a);
    // Allow one extra token for the `key = value` sugar before collapsing.
    if (rawPositionals.length === 5) break;
  }
  const verb = rawPositionals[0] ?? null;
  const positionals = normalizeConfigPositionals(rawPositionals, { verb });
  return {
    flags,
    scope: readValueFlag(argv, '--scope'),
    verb: positionals[0] ?? null,
    key: positionals[1] ?? null,
    value: positionals[2] ?? null,
    workspace: path.resolve(flags.workspace),
    copilotHome: resolveCopilotHome(flags.copilotHome),
  };
}

export async function configResultOf(argv, ctx = {}) {
  const { verb, key, value, scope: rawScope, workspace, copilotHome } = context(argv);
  if (!verb) throw usageError('config requires a verb', `ae config <${CONFIG_VERBS.join('|')}>`);
  if (!CONFIG_VERBS.includes(verb)) {
    throw usageError(`unknown config verb: ${verb}`, `one of ${CONFIG_VERBS.join(', ')}`);
  }

  const projectTrusted = isProjectTrusted({ workspace, copilotHome });
  const resolved = resolveConfig({ copilotHome, workspace, projectTrusted });

  if (verb === 'show') {
    return {
      schema: 1,
      verb,
            status: resolved.errors.length ? 'failed' : 'ok',
      files: resolved.files,
      settings: CONFIG_KEYS.map((k) => ({
        key: k,
        value: resolved.values[k],
        default: CONFIG_SCHEMA[k].default,
        description: CONFIG_SCHEMA[k].description,
        ...resolved.provenance[k],
      })),
      errors: resolved.errors,
    };
  }

  if (verb === 'validate') {
    return {
      schema: 1,
      verb,
      status: resolved.errors.length ? 'failed' : 'ok',
      files: resolved.files,
      valid: resolved.errors.length === 0,
      errors: resolved.errors,
    };
  }

  if (!key) throw usageError(`config ${verb} requires a key`, `known keys: ${CONFIG_KEYS.join(', ')}`);
  if (!(key in CONFIG_SCHEMA)) {
    throw notFoundError(`unknown config key: ${key}`, `known keys: ${CONFIG_KEYS.join(', ')}`);
  }

  if (verb === 'get') {
    return {
      schema: 1,
      verb,
      key,
      value: resolved.values[key],
      default: CONFIG_SCHEMA[key].default,
      ...resolved.provenance[key],
    };
  }

  // `set`.
  if (value === null || value === '') {
    throw usageError(
      `config set requires a value`,
      `config set ${key} <value>   (scope defaults to user; use --scope project for the repo)`,
    );
  }
  // Default scope is user — matches frontier TUIs (Claude/Codex settings land
  // in user scope unless project is explicit). Project still requires --scope.
  const scopeDefaulted = !rawScope;
  const scope = rawScope || 'user';
  if (!SCOPES.includes(scope)) {
    throw usageError(
      `unknown scope: ${scope}`,
      `--scope ${SCOPES.join(' or --scope ')}  (not session)`,
    );
  }

  const written = setConfigValue({ scope, key, value, copilotHome, workspace });
  const trustedAfter = isProjectTrusted({ workspace, copilotHome });
  const after = resolveConfig({ copilotHome, workspace, projectTrusted: trustedAfter });
  return {
    schema: 1,
    verb,
    key,
    scope,
    scopeDefaulted,
    written: written.value,
    file: written.file,
    value: after.values[key],
    ...after.provenance[key],
    effectiveChanged: configValuesEqual(after.values[key], written.value),
    ...(scope === 'project' && !trustedAfter ? { trustNowStale: true } : {}),
  };
}

/** Scalar === ; arrays compare by joined form so list keys do not false-warn. */
function configValuesEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const as = Array.isArray(a) ? a.map(String).join(',') : String(a ?? '');
    const bs = Array.isArray(b) ? b.map(String).join(',') : String(b ?? '');
    return as === bs;
  }
  return a === b;
}

function renderShow(result) {
  const keyWidth = keyWidthFor(['config', ...CONFIG_KEYS]);
  console.log(ui.line({ key: 'config', value: `${result.settings.length} keys`, note: `user: ${result.files.user.exists ? 'set' : 'unset'} · project: ${result.files.project.exists ? 'set' : 'unset'}`, keyWidth }));
  for (const s of result.settings) {
    const note = [s.source, s.note].filter(Boolean).join(' · ');
    console.log(ui.line({
      state: s.source === 'default' ? 'muted' : 'ok',
      key: s.key,
      value: Array.isArray(s.value) ? (s.value.length ? s.value.join(',') : '(empty)') : String(s.value),
      note,
      keyWidth,
    }));
  }
  for (const error of result.errors) console.log(ui.line({ state: 'error', key: 'error', value: error, keyWidth }));
}

export async function cmdConfig(argv, ctx = {}) {
  const { flags } = context(argv);
  const result = await configResultOf(argv, ctx);

  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
  } else if (result.verb === 'show') {
    renderShow(result);
  } else if (result.verb === 'validate') {
    const keyWidth = keyWidthFor(['config', 'errors']);
    console.log(ui.line({ state: result.valid ? 'ok' : 'error', key: 'config', value: result.valid ? 'valid' : 'invalid', keyWidth }));
    for (const error of result.errors) console.log(ui.line({ state: 'error', key: 'error', value: error, keyWidth }));
  } else if (result.verb === 'get') {
    const keyWidth = keyWidthFor([result.key, 'source']);
    console.log(ui.line({ key: result.key, value: Array.isArray(result.value) ? result.value.join(',') : String(result.value), note: [result.source, result.note].filter(Boolean).join(' · '), keyWidth }));
  } else {
    // Compact product lines — avoid a sparse 4-row key dump that fills a wide
    // tinted block with empty columns on the session ledger.
    const written = Array.isArray(result.written) ? result.written.join(',') : String(result.written);
    const effective = Array.isArray(result.value) ? result.value.join(',') : String(result.value);
    const scopeNote = result.scopeDefaulted ? `${result.scope} (default)` : result.scope;
    const keyWidth = keyWidthFor(['set', 'file']);
    console.log(ui.line({
      state: 'ok',
      key: 'set',
      value: `${result.key} = ${written}`,
      note: scopeNote,
      keyWidth,
    }));
    console.log(ui.line({ key: 'file', value: result.file, keyWidth }));
    if (!result.effectiveChanged) {
      console.log(ui.line({
        state: 'warn',
        key: 'effective',
        value: effective,
        note: [result.source, result.note, 'not effective'].filter(Boolean).join(' · '),
        keyWidth: keyWidthFor(['set', 'file', 'effective']),
      }));
    }
  }

  // One rule, shared with the lane path through the registry's `exitOf`.
  return configExitFor(result);
}

export function configExitFor(result) {
  if (result?.verb === 'validate') return result.valid ? EXIT.ok : 1;
  if (result?.verb === 'show') return result.errors?.length ? 1 : EXIT.ok;
  return EXIT.ok;
}

export { configPathFor };
