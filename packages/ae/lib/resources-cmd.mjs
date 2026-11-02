import fs from 'node:fs';
import path from 'node:path';
import { copyDirectorySync } from './fs-copy.mjs';
import { parseFlags } from './flags.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { inertLine } from './knowledge/store.mjs';
import { approvedBundleNames, readPlacements, syncBundles } from './bundle-sync.mjs';
import { listLocalPrimitives, primitiveOrigins, shippedAssetFiles } from './primitive-origins.mjs';
import { bundleDigest, discoverBundles, parseManifest, MANIFEST_FILE, resourcesRoot } from './resources.mjs';
import { getCorpusRoot } from './assets.mjs';
import { resourceInput, scaffoldPrimitive, createStructuredPrimitive, validateResourceInventory } from './resource-validation.mjs';
import { resourceCandidates, proposeResource } from './resource-candidates.mjs';
import { readBoundedInput } from './fs-safe.mjs';
import { createHostSkill } from './hosts/personal-skill.mjs';
import { nativeResourceRead } from './hosts/resource-read.mjs';
import {
  createPersonalPrimitive,
  discardPrimitive,
  localPrimitiveStatus,
  registerPrimitive,
  registeredPath,
  unregisterPrimitive,
  validatePrimitive,
} from './local-primitives.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export const RESOURCES_VERBS = Object.freeze([
  'list', 'show', 'register', 'unregister', 'discard', 'create', 'validate', 'scaffold', 'candidates', 'propose',
    'add', 'update', 'remove', 'bundles',
]);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

/** Flags on this entry that take a value — a BOOLEAN flag before the verb must
 * not swallow it, which is the bug the same parser had in `run`. */
const VALUE_FLAGS = new Set(['--workspace', '--copilot-home', '--skills-home', '--ae-home', '--harness-home', '--file', '--path']);

function context(argv) {
  const flags = parseFlags(argv);
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (!a.includes('=') && VALUE_FLAGS.has(a) && argv[i + 1] !== undefined) i += 1;
      continue;
    }
    positionals.push(a);
  }
  if (positionals.length > 3) {
    throw usageError(
      'resources accepts at most a verb, a kind, and a name',
      'ae resources create <skill|agent|instruction> <name>',
    );
  }
  if (flags.files?.length && !['create', 'propose'].includes(positionals[0])) {
    throw usageError(
      'resources create reads the primitive body from stdin',
      'ae resources create <skill|agent|instruction> <name>',
    );
  }
  return {
    flags,
    verb: positionals[0] ?? 'list',
    target: positionals[1] ?? null,
    name: positionals[2] ?? null,
    copilotHome: resolveCopilotHome(flags.copilotHome),
  };
}

export { listLocalPrimitives };

/** Re-place every enabled bundle. Shared by add/update/remove so the three
 * cannot drift about what "applied" means. */
function applyBundles(copilotHome) {
  return syncBundles({ copilotHome, shippedFiles: shippedAssetFiles(), trustedNames: approvedBundleNames(copilotHome) });
}

/** Copy a bundle directory in, refusing anything whose manifest does not parse
 * — an invalid bundle installed is one that fails later, further from the
 * decision that caused it. */
function addBundle(copilotHome, source) {
  const from = path.resolve(source);
  const manifestPath = path.join(from, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    throw Object.assign(new Error(`no ${MANIFEST_FILE} in ${source}`), {
      code: 'E_USAGE', exit: EXIT.usage, hint: 'a bundle is a directory containing a manifest',
    });
  }
  const { manifest, errors } = parseManifest(fs.readFileSync(manifestPath, 'utf8'), { source });
  if (!manifest) {
    throw Object.assign(new Error(`invalid bundle: ${errors[0]}`), { code: 'E_USAGE', exit: EXIT.usage });
  }
    const dest = resolveBundleDir(copilotHome, manifest.name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  copyDirectorySync(from, dest);
    for (const marker of ['.enabled', '.disabled']) {
    fs.rmSync(path.join(dest, marker), { force: true });
  }
  return { name: manifest.name, version: manifest.version, dir: dest, digest: bundleDigest(dest) };
}

export function resolveBundleDir(copilotHome, name) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw usageError(
      `invalid bundle name: ${JSON.stringify(name)}`,
      'a bundle name is a plain directory name — ae resources bundles',
    );
  }
  const root = path.resolve(resourcesRoot(copilotHome));
  const dir = path.resolve(root, name);
  if (path.dirname(dir) !== root) {
    throw usageError(
      `bundle name escapes the resources directory: ${JSON.stringify(name)}`,
      'ae resources bundles',
    );
  }
  return dir;
}

export async function resourcesResultOf(argv, ctx = {}) {
  const { flags, verb, target, name, copilotHome } = context(argv);
  if (!RESOURCES_VERBS.includes(verb)) {
    throw usageError(`unknown resources verb: ${verb}`, `one of ${RESOURCES_VERBS.join(', ')}`);
  }
  if (process.env.AE_SKILLS_HOME) {
    if (['list', 'show', 'validate'].includes(verb) && !flags.corpus && !flags.path) {
      return nativeResourceRead({ verb, target, configHome: copilotHome, skillsHome: process.env.AE_SKILLS_HOME });
    }
    if (verb === 'create') {
      if (target !== 'skill') throw usageError('Native personal agents/instructions require a mapped host writer; Copilot-format fallback is refused', 'Create a capability proposal; native personal skills use resources create skill --file');
      if (!flags.files?.length) throw usageError('Native personal skills require a schema 1 decision through --file', 'ae resources create skill <name> --file -');
      const inputFlags = flags.files.length === 1 && flags.files[0] === '-' ? { ...flags, files: null } : flags;
      return createHostSkill({ configHome: copilotHome, skillsHome: process.env.AE_SKILLS_HOME, name, input: resourceInput(inputFlags), dryRun: flags.dryRun });
    }
    if (['add', 'update', 'remove', 'register', 'unregister', 'discard'].includes(verb)) {
      throw usageError('Legacy bundle and primitive mutation is not mapped for the selected native host', 'Use ae host setup/status/remove for managed assets; preserve personal files');
    }
  }
  if (verb === 'scaffold') return scaffoldPrimitive(target, name);
  if (verb === 'validate') return validateResourceInventory(flags.corpus ? getCorpusRoot() : flags.path ? path.resolve(flags.workspace, flags.path) : copilotHome, { shipped: flags.corpus, shippedFiles: !flags.path ? shippedAssetFiles() : new Set() });
  if (verb === 'candidates') return resourceCandidates({ workspace: path.resolve(flags.workspace), copilotHome, home: flags.harnessHome, dryRun: flags.dryRun });
  if (verb === 'propose') return proposeResource({ workspace: path.resolve(flags.workspace), copilotHome, input: resourceInput(flags), dryRun: flags.dryRun });
  const { shippedFiles, lockFiles } = primitiveOrigins(copilotHome);
  const primitives = localPrimitiveStatus({ copilotHome, shippedFiles, lockFiles });

  if (verb === 'bundles') {
    const bundles = discoverBundles(copilotHome, { trustedNames: approvedBundleNames(copilotHome) });
    const placements = readPlacements(copilotHome);
    return {
      schema: 1,
      verb,
      status: bundles.some((b) => b.state === 'tampered' || b.state === 'invalid') ? 'failed' : 'ok',
      bundles: bundles.map((b) => ({
        name: b.name,
        dir: b.dir,
        version: b.manifest?.version ?? null,
        state: b.state,
        reason: b.reason,
        placed: placements.bundles[b.name]?.files ?? [],
      })),
    };
  }

  if (verb === 'add' || verb === 'update') {
    if (!target) throw usageError(`resources ${verb} requires a bundle directory`, `ae resources ${verb} ./my-bundle`);
    const added = addBundle(copilotHome, target);
        const sync = applyBundles(copilotHome);
    return { schema: 1, verb, bundle: added, sync };
  }

  if (verb === 'remove') {
    if (!target) throw usageError('resources remove requires a bundle name', 'ae resources bundles');
    if (/^(skills|agents|instructions)\//.test(target) || primitives.some((p) => p.path === target)) {
      throw usageError(
        `resources remove uninstalls a bundle, not ${JSON.stringify(target)}`,
        `ae resources discard ${target}`,
      );
    }
        const dir = resolveBundleDir(copilotHome, target);
    if (!fs.existsSync(dir)) {
      throw Object.assign(new Error(`no bundle named ${JSON.stringify(target)}`), {
        code: 'E_NOT_FOUND', exit: EXIT.notFound, hint: 'ae resources discard <path> deletes a local skill or extra file',
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
        const sync = applyBundles(copilotHome);
    return { schema: 1, verb, bundle: { name: target }, sync };
  }

  if (verb === 'create') {
    if (!target || !name) {
      throw usageError(
        'resources create requires a kind and a name',
        'ae resources create <skill|agent|instruction> <name>',
      );
    }
    if (flags.files?.length) return createStructuredPrimitive({ flags, copilotHome, type: target, name, input: resourceInput(flags), shippedFiles, lockFiles });
    if (process.stdin.isTTY) {
      throw usageError(
        'resources create reads the primitive body from stdin',
        'ae resources create <skill|agent|instruction> <name>',
      );
    }
    const text = readBoundedInput();
    const primitive = createPersonalPrimitive({ copilotHome, kind: target, name, text, shippedFiles, lockFiles });
    return { schema: 1, verb: 'create', primitive, assurance: 'legacy discovery validation; use --file for complete validation and permission checks' };
  }

  if (verb === 'list') {
    const invalid = primitives.filter((p) => p.state === 'invalid').length;
    const stray = primitives.filter((p) => p.state === 'stray').length;
    return {
      schema: 1,
      verb,
      home: copilotHome,
      registry: registeredPath(copilotHome),
            status: invalid ? 'failed' : 'ok',
      counts: {
        total: primitives.length,
        registered: primitives.filter((p) => p.state === 'registered').length,
        pending: primitives.filter((p) => p.state === 'pending').length,
        stale: primitives.filter((p) => p.state === 'stale').length,
        stray,
        invalid,
      },
      primitives,
    };
  }

  if (!target) throw usageError(`resources ${verb} requires a path`, 'ae resources list');
    const matches = (p) => p.path === target
    || p.path.endsWith(`/${target}`)
    || p.name === target
    || p.path.split('/')[1] === target
    || path.basename(p.path).replace(/\.(agent|instructions)\.md$/, '') === target;
  const hits = primitives.filter(matches);
  const found = hits[0] || null;
  if (verb === 'show') {
    if (!found) {
      throw Object.assign(new Error(`no locally-added primitive matching ${JSON.stringify(target)}`), {
        code: 'E_NOT_FOUND', exit: EXIT.notFound, hint: 'ae resources list',
      });
    }
    return { schema: 1, verb, primitive: found, validation: validatePrimitive(copilotHome, found.path) };
  }

  const rel = found?.path ?? target;
  if (verb === 'register') {
    const result = registerPrimitive({ copilotHome, rel, shippedFiles, lockFiles });
    return { schema: 1, verb, primitive: { ...result, reason: 'registered' } };
  }
  if (verb === 'discard') {
    if (hits.length > 1) {
      throw usageError(
        `ambiguous discard target ${JSON.stringify(target)} matches ${hits.length} files`,
        hits.map((p) => p.path).sort().join(', '),
      );
    }
    const result = discardPrimitive({ copilotHome, rel, shippedFiles, lockFiles });
    return { schema: 1, verb, primitive: { ...result, reason: 'discarded' } };
  }
  if (found && (found.state === 'invalid' || found.state === 'stray' || found.state === 'pending')) {
    throw Object.assign(new Error(`not registered: ${found.path}`), {
      code: 'E_NOT_FOUND',
      exit: EXIT.notFound,
      hint: `unregister only withdraws recognition. To delete the file: ae resources discard ${found.path}`,
    });
  }
  return { schema: 1, verb, primitive: unregisterPrimitive({ copilotHome, rel }) };
}

const STATE_STYLE = {
  registered: 'ok',
  created: 'ok',
  unchanged: 'ok',
  replaced: 'ok',
  pending: 'warn',
  stale: 'warn',
  stray: 'warn',
  invalid: 'error',
};

export async function cmdResources(argv, ctx = {}) {
  const { flags } = context(argv);
  const result = await resourcesResultOf(argv, ctx);

  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
  } else if (['validate', 'scaffold', 'candidates', 'propose'].includes(result.verb) || result.validation) {
    console.log(redactedJson(result, { pretty: true }));
  } else if (result.verb === 'list') {
    const keyWidth = keyWidthFor(['primitives', ...result.primitives.map((p) => p.path)]);
    const c = result.counts;
    console.log(ui.line({
      key: 'primitives',
      value: `${c.total} locally added`,
      note: [`${c.registered} registered`, `${c.pending} pending`, c.stale ? `${c.stale} stale` : null, c.stray ? `${c.stray} stray` : null, c.invalid ? `${c.invalid} invalid` : null].filter(Boolean).join(' · '),
      keyWidth,
    }));
    for (const p of result.primitives) {
            console.log(ui.line({
        state: STATE_STYLE[p.state] || 'warn',
        key: p.path,
        value: p.state,
        note: inertLine(String(p.reason || '')),
        keyWidth,
      }));
    }
    if (!result.primitives.length) {
      console.log(ui.paint('muted', `  nothing added by hand under ${result.home}/skills or /agents`));
    }
  } else if (result.verb === 'bundles') {
    const keyWidth = keyWidthFor(['bundles', ...result.bundles.map((b) => b.name)]);
    console.log(ui.line({ key: 'bundles', value: `${result.bundles.length} installed`, keyWidth }));
    for (const b of result.bundles) {
      console.log(ui.line({
        state: b.state === 'enabled' ? 'ok' : b.state === 'tampered' || b.state === 'invalid' ? 'error' : 'warn',
        key: b.name,
        value: `${b.version ?? '(no version)'} · ${b.state}`,
        note: inertLine(b.reason || `${b.placed.length} file(s) placed`),
        keyWidth,
      }));
    }
    if (!result.bundles.length) console.log(ui.paint('muted', '  no bundles installed'));
  } else if (result.verb === 'add' || result.verb === 'update' || result.verb === 'remove') {
    const keyWidth = keyWidthFor(['bundle', 'placed', 'withdrew', 'refused']);
    console.log(ui.line({ state: 'ok', key: result.verb, value: inertLine(result.bundle.name), note: result.bundle.version || undefined, keyWidth }));
    console.log(ui.line({ key: 'placed', value: `${result.sync.placed.length} file(s)`, keyWidth }));
    if (result.sync.withdrawn.length) console.log(ui.line({ key: 'withdrew', value: `${result.sync.withdrawn.length} file(s)`, keyWidth }));
    for (const r of result.sync.refused) {
      console.log(ui.line({ state: 'warn', key: 'refused', value: inertLine(r.target), note: inertLine(r.reason), keyWidth }));
    }
    for (const s of result.sync.shadowed) {
      console.log(ui.paint('muted', `  ${inertLine(s.target)} — ${inertLine(s.bundle)} shadowed by ${inertLine(s.winner)}`));
    }
  } else if (result.verb === 'show') {
    const p = result.primitive;
    const keyWidth = keyWidthFor(['primitive', 'state', 'kind', 'digest']);
    console.log(ui.line({ state: STATE_STYLE[p.state] || 'warn', key: 'primitive', value: inertLine(p.path), note: p.state, keyWidth }));
    console.log(ui.line({ key: 'kind', value: `${p.kind ?? 'unknown'}${p.name ? ` · ${inertLine(p.name)}` : ''}`, keyWidth }));
    console.log(ui.line({ key: 'digest', value: p.digest ?? '(unreadable)', keyWidth }));
    console.log(ui.line({ state: p.state === 'invalid' ? 'error' : 'muted', key: 'reason', value: inertLine(String(p.reason || '')), keyWidth }));
    for (const error of result.validation.errors) console.log(ui.paint('muted', `  ${inertLine(error)}`));
  } else {
    const p = result.primitive;
    const keyWidth = keyWidthFor(['register', 'unregister', 'discard', 'create']);
    console.log(ui.line({
      state: STATE_STYLE[p.state] || (p.state === 'discarded' ? 'ok' : 'warn'),
      key: result.verb,
      value: inertLine(p.path),
      note: p.state,
      keyWidth,
    }));
  }

  return resourcesExitFor(result);
}

export function resourcesExitFor(result) {
    if (result?.verb === 'validate' && result.status !== 'ok') return 1;
    if ((result?.verb === 'list' || result?.verb === 'bundles') && result.status !== 'ok') return 1;
    if (result?.sync?.refused?.length) return 1;
  return EXIT.ok;
}
