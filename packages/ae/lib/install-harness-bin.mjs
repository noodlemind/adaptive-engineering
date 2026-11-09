import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readLock } from './lock.mjs';
import { resolveContainedPath } from './sync.mjs';
import { readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { withPlanUpdateLock } from './plan-update.mjs';

const require = createRequire(import.meta.url);
// Dependency builds the runtime never loads. D2 ships the same 42 MB wasm for CommonJS and
// ESM plus a browser bundle; lib/diagrams imports only dist/node-esm (see check-release).
const RUNTIME_DEPENDENCY_SKIP = Object.freeze({ '@d2lang/d2': ['dist/node-cjs/', 'dist/browser/'] });
const COPY_DIRS = ['bin', 'lib', 'config', 'corpus', 'vscode-extension'];
const COPY_FILES = ['package.json', 'retired.json'];

/**
 * Copy harness CLI into ~/.copilot/.ae-bin so agents can run without npx.
 */
export function installHarnessBin(pkgRoot, copilotHome, flags, log) {
  if (flags.dryRun) return installRuntime(pkgRoot, copilotHome, flags, log);
  if (!resolveContainedPath(copilotHome, '.ae-bin')) throw runtimeError('refusing an unsafe runtime target');
  fs.mkdirSync(copilotHome, { recursive: true });
  return withPlanUpdateLock(path.join(copilotHome, '.ae-runtime-install'), () => installRuntime(pkgRoot, copilotHome, flags, log));
}

function installRuntime(pkgRoot, copilotHome, flags, log) {
  recoverRuntime(copilotHome, flags.dryRun);
  const stats = { created: 0, updated: 0, removed: 0, files: [] };
  const previous = readLock(copilotHome);
  const previousFiles = Array.isArray(previous?.files) ? previous.files : [];
  const sources = [];

  for (const dir of COPY_DIRS) {
    const srcDir = path.join(pkgRoot, dir);
    if (!fs.existsSync(srcDir)) continue;
    collectFiles(srcDir, dir, sources);
  }

  for (const file of COPY_FILES) {
    const src = path.join(pkgRoot, file);
    if (!fs.existsSync(src)) continue;
    sources.push({ src, rel: file });
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies || {})) {
    const src = resolveDependencyRoot(dependency);
    const skip = RUNTIME_DEPENDENCY_SKIP[dependency] || [];
    collectFiles(src, `node_modules/${dependency}`, sources, rel => skip.some(prefix => rel.startsWith(`node_modules/${dependency}/${prefix}`)));
  }

  // Refuse unsafe targets before replacing any part of the current runtime.
  for (const { rel } of sources) runtimeTarget(copilotHome, rel);
  let stage = null;
  try {
    if (!flags.dryRun) {
      stage = fs.mkdtempSync(path.join(copilotHome, '.ae-bin-stage-'));
      const current = path.join(copilotHome, '.ae-bin');
      if (fs.existsSync(current)) fs.cpSync(current, stage, { recursive: true, dereference: false, verbatimSymlinks: true });
    }
    for (const { src, rel } of sources) {
      copyFile(src, stage ? path.join(stage, rel) : runtimeTarget(copilotHome, rel), rel, flags, log, stats);
    }

    if (['harness', 'ae-harness'].includes(previous?.package)) {
      const current = new Set(stats.files);
      for (const rel of new Set(previousFiles)) {
        if (typeof rel !== 'string' || !rel.startsWith('.ae-bin/') || current.has(rel)) continue;
        const stale = resolveContainedPath(stage || copilotHome, stage ? rel.slice('.ae-bin/'.length) : rel);
        if (!stale || !fs.lstatSync(stale, { throwIfNoEntry: false })?.isFile()) continue;
        log(`${flags.dryRun ? 'would remove' : 'removed'} obsolete harness-bin: ${rel}`);
        if (!flags.dryRun) fs.unlinkSync(stale);
        stats.removed++;
      }
    }
    if (stage) publishRuntime(copilotHome, stage);
  } finally {
    // A retained journal owns its stage until recovery; never remove it here.
    if (stage && !fs.existsSync(path.join(copilotHome, RUNTIME_JOURNAL))) fs.rmSync(stage, { recursive: true, force: true });
  }

  const legacyRel = '.harness-bin/bin/harness.mjs';
  if (['harness', 'ae-harness'].includes(previous?.package) && previousFiles.includes(legacyRel)) {
    const segments = ['.harness-bin', '.harness-bin/bin', legacyRel];
    const managed = segments.every((relative, index) => {
      const stat = fs.lstatSync(path.join(copilotHome, relative), { throwIfNoEntry: false });
      return stat && !stat.isSymbolicLink() && (index === segments.length - 1 ? stat.isFile() : stat.isDirectory());
    });
    if (managed) {
      if (!flags.dryRun) fs.writeFileSync(path.join(copilotHome, legacyRel), "#!/usr/bin/env node\nimport { main } from '../../.ae-bin/bin/ae.mjs';\n\nawait main();\n");
      stats.updated++;
      stats.files.push(legacyRel);
      log(`${flags.dryRun ? 'would update' : 'updated'} owned legacy runtime: ${legacyRel}`);
    }
  }

  return stats;
}

const RUNTIME_JOURNAL = '.ae-runtime-install.json';
const runtimeError = message => Object.assign(new Error(`runtime installation: ${message}`), { code: 'E_TARGET', exit: 1 });

function directoryIdentity(full) {
  const stat = fs.lstatSync(full, { bigint: true, throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw runtimeError(`unsafe directory ${full}`);
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
const sameDirectory = (left, right) => left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
const validIdentity = value => value && Object.keys(value).sort().join(',') === 'dev,ino' && /^\d+$/.test(value.dev) && /^\d+$/.test(value.ino);

function recoverRuntime(home, dryRun = false) {
  const journalPath = path.join(home, RUNTIME_JOURNAL);
  if (!fs.lstatSync(journalPath, { throwIfNoEntry: false })) return;
  const bytes = readFileNoFollow(journalPath, { root: home, maxBytes: 4096 });
  let record;
  try { record = JSON.parse(bytes); } catch { throw runtimeError('unreadable recovery journal; inspect before retrying'); }
  if (!record || Object.keys(record).sort().join(',') !== 'backup,new,old,stage,version' || record.version !== 1
      || !/^\.ae-bin-stage-[A-Za-z0-9]{6}$/.test(record.stage) || !/^\.ae-bin-backup-[0-9a-f-]{36}$/.test(record.backup)
      || !validIdentity(record.new) || record.old !== null && !validIdentity(record.old)) throw runtimeError('invalid recovery journal; inspect before retrying');
  const active = path.join(home, '.ae-bin'), stage = path.join(home, record.stage), backup = path.join(home, record.backup);
  const observed = { active: directoryIdentity(active), stage: directoryIdentity(stage), backup: directoryIdentity(backup) };
  if (observed.stage && !sameDirectory(observed.stage, record.new) || observed.backup && !sameDirectory(observed.backup, record.old)) throw runtimeError('recovery directory identity changed; retained for inspection');
  if (sameDirectory(observed.active, record.new) && observed.stage === null) {
    if (dryRun) throw runtimeError('pending publication cleanup; run install without --dry-run to recover');
    if (observed.backup) fs.rmSync(backup, { recursive: true });
  } else if ((sameDirectory(observed.active, record.old) && observed.backup === null)
      || observed.active === null && (sameDirectory(observed.backup, record.old) || record.old === null && observed.backup === null)) {
    if (dryRun) throw runtimeError('pending publication recovery; run install without --dry-run to recover');
    if (observed.backup) fs.renameSync(backup, active);
    if (observed.stage) fs.rmSync(stage, { recursive: true });
  } else throw runtimeError('ambiguous publication state; retained for inspection');
  fs.unlinkSync(journalPath);
}

function publishRuntime(home, stage) {
  const active = path.join(home, '.ae-bin'), backup = path.join(home, `.ae-bin-backup-${randomUUID()}`);
  const record = { version: 1, stage: path.basename(stage), backup: path.basename(backup), old: directoryIdentity(active), new: directoryIdentity(stage) };
  if (!writeFileContained(home, RUNTIME_JOURNAL, JSON.stringify(record) + '\n', { exclusive: true, mode: 0o600 })) throw runtimeError('recovery journal could not be published');
  try {
    if (record.old) fs.renameSync(active, backup);
    fs.renameSync(stage, active);
  } catch (error) {
    // Recovery either restores the old complete runtime or retains all owned state.
    try { recoverRuntime(home); } catch (recovery) { error.hint = recovery.message; }
    throw error;
  }
  recoverRuntime(home);
}

function resolveDependencyRoot(name) {
  let current = path.dirname(require.resolve(name));
  while (true) {
    const manifest = path.join(current, 'package.json');
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (pkg.name === name) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Unable to locate runtime dependency: ${name}`);
    current = parent;
  }
}

function collectFiles(srcDir, relative, files, skip = () => false) {
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, ent.name);
    const rel = `${relative}/${ent.name}`;
    if (ent.isDirectory()) {
      if (skip(`${rel}/`)) continue;
      collectFiles(src, rel, files, skip);
    } else if (!skip(rel)) {
      files.push({ src, rel });
    }
  }
}

function runtimeTarget(copilotHome, rel) {
  const target = resolveContainedPath(copilotHome, `.ae-bin/${rel}`);
  if (!target) throw Object.assign(new Error(`refusing an unsafe runtime target: ${rel}`), { code: 'E_TARGET', exit: 1 });
  return target;
}

function copyFile(src, dest, rel, flags, log, stats) {
  const exists = fs.existsSync(dest);
  if (flags.dryRun) {
    log(`would ${exists ? 'update' : 'create'} harness-bin: ${rel}`);
    stats[exists ? 'updated' : 'created']++;
    stats.files.push(`.ae-bin/${rel}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  stats[exists ? 'updated' : 'created']++;
  stats.files.push(`.ae-bin/${rel}`);
  if (flags.verbose) log(`${exists ? 'update' : 'create'} harness-bin: ${rel}`);
}
