import fs from 'node:fs';
import path from 'node:path';
import { safeResolveUnderRoot } from './path-safe.mjs';
import { resolveCopilotHome, resolveIntelliJHome } from './paths.mjs';

/** Trees `ae install` copies into a host home. */
export const REFERENCE_ROOTS = Object.freeze(['skills', 'agents', 'instructions', 'knowledge', 'enterprise', 'hooks']);

export function installedCorpusHomes({ copilotHome } = {}) {
  const homes = [];
  const copilot = path.resolve(copilotHome || resolveCopilotHome());
  homes.push(copilot);
  if (process.env.AE_SKILLS_HOME) return homes;
  const intellij = path.resolve(resolveIntelliJHome());
  if (intellij !== copilot) homes.push(intellij);
  return homes;
}

/** Drop a fragment and a home prefix. Reject `..`. */
export function normalizeReferenceSpec(spec) {
  let text = String(spec || '').trim().replace(/\\/g, '/');
  const hash = text.indexOf('#');
  if (hash >= 0) text = text.slice(0, hash);
  if (text.startsWith('~/')) text = text.replace(/^~\/\.copilot\//, '');
  if (text.startsWith('<copilot-home>/')) text = text.slice('<copilot-home>/'.length);
  if (text.startsWith('<skills-root>/')) text = `skills/${text.slice('<skills-root>/'.length)}`;
  text = text.replace(/^\.\//, '');
  if (!text || text.split('/').includes('..')) return null;
  return text;
}

export function referenceCandidates(spec) {
  const text = normalizeReferenceSpec(spec);
  if (!text) return [];
  if (text === 'copilot-instructions.md' || REFERENCE_ROOTS.some((root) => text === root || text.startsWith(`${root}/`))) {
    return [text];
  }
  return [`skills/${text}`];
}

/** Installed file for a corpus id. Never reads the product workspace. */
export function resolveInstalledReference(spec, homes) {
  const candidates = referenceCandidates(spec);
  if (!candidates.length) return null;
  for (const home of homes) {
    if (!home) continue;
    for (const rel of candidates) {
      if (process.env.AE_SKILLS_HOME && rel.startsWith('skills/')) {
        const skillsRoot = path.resolve(process.env.AE_SKILLS_HOME);
        const selected = safeResolveUnderRoot(skillsRoot, rel.slice('skills/'.length));
        if (selected) {
          try {
            if (fs.statSync(selected).isFile()) return { rel, fullPath: selected, readRoot: skillsRoot };
          } catch { /* A selected skill never falls back to a different host. */ }
        }
        continue;
      }
      const full = safeResolveUnderRoot(home, rel);
      if (!full) continue;
      try {
        if (fs.statSync(full).isFile()) return { rel, fullPath: full, readRoot: path.resolve(home) };
      } catch {
        // The next home may have the file.
      }
    }
  }
  return null;
}

export function referenceReadCommand(rel) {
  return `ae get --reference ${rel} --json`;
}
