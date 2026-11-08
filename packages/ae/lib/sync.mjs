import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { assertNoSymlinkAncestors } from './fs-safe.mjs';

const SYNC_TOP_LEVEL = ['skills', 'agents', 'instructions', 'hooks', 'knowledge', 'enterprise'];

const KNOWLEDGE_PRESERVE_PREFIXES = ['knowledge/solutions/'];
const KNOWLEDGE_NEVER_OVERWRITE = ['knowledge/profile.md'];

export function loadRetired(pkgRoot) {
  const p = path.join(pkgRoot, 'retired.json');
  if (!fs.existsSync(p)) return [];
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  return data.retired || [];
}

const ORPHAN_SCAN_DIRS = ['skills', 'agents', 'instructions', 'prompts', 'hooks'];

export function findStaleOrphans(copilotHome, assetsRoot, retiredList = [], lockFiles = null) {
  const current = new Set();
  for (const top of SYNC_TOP_LEVEL) {
    for (const f of walkFiles(path.join(assetsRoot, top))) current.add(`${top}/${f}`);
  }
  const retiredCovered = (rel) =>
    retiredList.some((r) => {
      const base = String(r).replace(/\/$/, '');
      return rel === base || rel.startsWith(`${base}/`);
    });

  const orphans = [];
  for (const top of ORPHAN_SCAN_DIRS) {
    for (const f of walkFiles(path.join(copilotHome, top))) {
      const rel = `${top}/${f}`;
      if (current.has(rel)) continue; // still shipped
      if (retiredCovered(rel)) continue; // explicitly retired — upgrade removes it
      if (lockFiles && !lockFiles.has(rel)) continue;
      if (/(^|\/)\.harness\//.test(rel)) continue;
      orphans.push(rel);
    }
  }
  return orphans.sort();
}

export function resolveContainedPath(root, rel) {
  if (!rel || typeof rel !== 'string') return null;
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel)) return null;

  const parts = rel.replace(/\\/g, '/').split('/');
  if (parts.some((part) => part === '..')) return null;

  const rootResolved = path.resolve(root);
  const dest = path.resolve(rootResolved, ...parts.filter(Boolean));
  const relative = path.relative(rootResolved, dest);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return assertNoSymlinkAncestors(rootResolved, relative);
}

function installTarget(root, rel) {
  const target = resolveContainedPath(root, rel);
  if (!target) throw Object.assign(new Error(`refusing an unsafe install target: ${rel}`), { code: 'E_TARGET', exit: 1 });
  return target;
}

function fileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hashBytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const REPOSITORY_PROJECT = '\n## Project\n\nAdaptive Engineering corpus: the skills, agents and instructions that AE installs into a selected host. Install writes them into the user profile. Product repositories do not receive a copy of that corpus.\n';

/** Installed global instructions describe the user's host, not this repository's own project blurb. */
export function installedCopilotInstructions(source) {
  const text = String(source).replace(/\r\n/g, '\n');
  if (!text.includes(REPOSITORY_PROJECT)) return source;
  return text.replace(REPOSITORY_PROJECT, '\n');
}

function renderTargetAsset(src, rel, targetRoot) {
  if (rel !== 'hooks/hooks.json') return null;
  const config = JSON.parse(fs.readFileSync(src, 'utf8'));
  for (const entries of Object.values(config.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const commands = Array.isArray(entry.hooks) ? entry.hooks : [entry];
      for (const command of commands) {
        if (command?.cwd === 'hooks') command.cwd = path.join(targetRoot, 'hooks');
      }
    }
  }
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function walkFiles(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(full, base));
    else if (ent.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function shouldSkipDest(rel, flags, destExists) {
  if (!flags.preserveKnowledge || !destExists) return false;
  const norm = rel.replace(/\\/g, '/');
  if (KNOWLEDGE_NEVER_OVERWRITE.some((p) => norm === p)) return true;
  if (KNOWLEDGE_PRESERVE_PREFIXES.some((p) => norm.startsWith(p))) return true;
  return false;
}

export function applyRetired(copilotHome, retiredList, previousLock, flags, log) {
  const stats = { removed: 0, skipped: 0 };
  const prevFiles = new Set((previousLock?.files || []).map((file) => String(file).replace(/\\/g, '/').replace(/\/$/, '')));
  for (const rawRel of retiredList) {
    const rel = String(rawRel).replace(/\\/g, '/').replace(/\/$/, '');
    const exactTracked = prevFiles.has(rel);
    const trackedDescendants = [...prevFiles].filter((file) => file.startsWith(`${rel}/`));
    if (!exactTracked && trackedDescendants.length === 0) {
      stats.skipped++;
      continue;
    }
    const dest = resolveContainedPath(copilotHome, rel);
    if (!dest) {
      log(`warn: skipped unsafe retired path: ${rel}`);
      stats.skipped++;
      continue;
    }
    if (exactTracked && fs.existsSync(dest)) {
      const destStat = fs.lstatSync(dest);
      if (!destStat.isDirectory() || destStat.isSymbolicLink()) {
        if (flags.dryRun) {
          log(`would remove retired: ${rel}`);
          stats.removed++;
          continue;
        }
        fs.rmSync(dest, { force: true });
        log(`removed retired: ${rel}`);
        stats.removed++;
        continue;
      }
      // Directory tombstones fall through and delete only lock-tracked leaves.
    }

    if (trackedDescendants.length === 0) continue;

    // Older locks record shipped leaf files. A directory tombstone owns those
    // descendants, but not unrelated user files that happen to share the dir.
    for (const tracked of trackedDescendants.sort((a, b) => b.length - a.length)) {
      const trackedDest = resolveContainedPath(copilotHome, tracked);
      if (!trackedDest || !fs.existsSync(trackedDest)) continue;
      if (flags.dryRun) {
        log(`would remove retired: ${tracked}`);
        stats.removed++;
        continue;
      }
      fs.rmSync(trackedDest, { recursive: true, force: true });
      log(`removed retired: ${tracked}`);
      stats.removed++;

      let parent = path.dirname(trackedDest);
      while (parent !== path.dirname(dest) && fs.existsSync(parent)) {
        if (!fs.statSync(parent).isDirectory() || fs.readdirSync(parent).length > 0) break;
        fs.rmdirSync(parent);
        if (parent === dest) break;
        parent = path.dirname(parent);
      }
    }
  }
  return stats;
}

export function syncAssetsToTarget(assetsRoot, targetRoot, flags, log) {
  const stats = { created: 0, updated: 0, skipped: 0, unchanged: 0, files: [] };

  for (const top of SYNC_TOP_LEVEL) {
    const srcDir = path.join(assetsRoot, top);
    if (!fs.existsSync(srcDir)) continue;
    const relFiles = walkFiles(srcDir, srcDir).map((f) => `${top}/${f}`);
    for (const rel of relFiles) {
      const src = path.join(assetsRoot, rel);
      const dest = installTarget(targetRoot, rel);
      const destDir = path.dirname(dest);
      const relPosix = rel.replace(/\\/g, '/');
      const rendered = renderTargetAsset(src, relPosix, targetRoot);

      if (shouldSkipDest(relPosix, flags, fs.existsSync(dest))) {
        stats.skipped++;
        if (flags.verbose) log(`skip preserve: ${relPosix}`);
        continue;
      }

      let action = 'create';
      if (fs.existsSync(dest)) {
        try {
          const same = rendered
            ? fs.readFileSync(dest).equals(rendered)
            : fs.statSync(src).size === fs.statSync(dest).size && fileHash(src) === fileHash(dest);
          if (same) {
            stats.unchanged++;
            stats.files.push(relPosix);
            if (flags.verbose) log(`unchanged: ${relPosix}`);
            continue;
          }
        } catch {
          /* copy */
        }
        action = 'update';
      }

      if (flags.dryRun) {
        log(`would ${action}: ${relPosix}`);
        stats[action === 'create' ? 'created' : 'updated']++;
        stats.files.push(relPosix);
        continue;
      }

      fs.mkdirSync(destDir, { recursive: true });
      if (rendered) fs.writeFileSync(dest, rendered);
      else fs.copyFileSync(src, dest);
      stats[action === 'create' ? 'created' : 'updated']++;
      stats.files.push(relPosix);
      if (flags.verbose) log(`${action}: ${relPosix}`);
    }
  }

  const copilotMd = path.join(assetsRoot, 'copilot-instructions.md');
  if (fs.existsSync(copilotMd)) {
    const rel = 'copilot-instructions.md';
    const dest = installTarget(targetRoot, rel);
    const rendered = Buffer.from(installedCopilotInstructions(fs.readFileSync(copilotMd, 'utf8')), 'utf8');
    const srcHash = hashBytes(rendered);
    const destHash = fs.existsSync(dest) ? fileHash(dest) : null;
    if (srcHash !== destHash) {
      if (!flags.dryRun) {
        fs.mkdirSync(targetRoot, { recursive: true });
        fs.writeFileSync(dest, rendered);
      }
      stats[destHash ? 'updated' : 'created']++;
      log(flags.dryRun ? `would update: ${rel}` : `update: ${rel}`);
    } else {
      stats.unchanged++;
    }
    stats.files.push(rel);
  }

  return stats;
}

export function seedProfile(assetsRoot, targetRoot, flags, log) {
  const template = path.join(assetsRoot, 'knowledge', 'profile.md.template');
  if (!fs.existsSync(template)) return;
  const dest = installTarget(targetRoot, 'knowledge/profile.md');
  if (fs.existsSync(dest) && !flags.forceProfile) {
    if (flags.verbose) log('skip profile.md (exists)');
    return;
  }
  let content = fs.readFileSync(template, 'utf8');
  if (flags.autonomy) {
    content = content.replace(
      /(\*\*autonomy:\*\*\s*)(\w+)/,
      `$1${flags.autonomy}`
    );
  }
  if (!flags.dryRun) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf8');
  }
  log(flags.dryRun ? 'would write knowledge/profile.md' : 'wrote knowledge/profile.md');
}

export function mergeIntelliJInstructions(assetsRoot, intellijRoot, flags, log) {
  const instrDir = path.join(assetsRoot, 'instructions');
  if (!fs.existsSync(instrDir)) return;
  const files = fs
    .readdirSync(instrDir)
    .filter((f) => f.endsWith('.instructions.md'))
    .sort((a, b) => {
      if (a === 'harness-global.instructions.md') return -1;
      if (b === 'harness-global.instructions.md') return 1;
      return a.localeCompare(b);
    });
  const parts = [];
  for (const f of files) {
    let text = fs.readFileSync(path.join(instrDir, f), 'utf8');
    text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    parts.push(`<!-- Source: ${f} -->\n${text.trim()}`);
  }
  if (parts.length === 0) return;
  const dest = installTarget(intellijRoot, 'global-copilot-instructions.md');
  const body = parts.join('\n\n');
  if (!flags.dryRun) {
    fs.mkdirSync(intellijRoot, { recursive: true });
    fs.writeFileSync(dest, body, 'utf8');
  }
  log(flags.dryRun ? 'would write IntelliJ global-copilot-instructions.md' : 'wrote IntelliJ global-copilot-instructions.md');
}

export function collectAllAssetFiles(assetsRoot) {
  const files = new Set();
  for (const top of SYNC_TOP_LEVEL) {
    const dir = path.join(assetsRoot, top);
    for (const f of walkFiles(dir, dir)) files.add(`${top}/${f}`.replace(/\\/g, '/'));
  }
  if (fs.existsSync(path.join(assetsRoot, 'copilot-instructions.md'))) {
    files.add('copilot-instructions.md');
  }
  return [...files].sort();
}
