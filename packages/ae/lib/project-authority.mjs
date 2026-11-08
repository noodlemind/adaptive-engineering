import fs from 'node:fs';
import { readFileNoFollow, assertNoSymlinkAncestors, writeFileContainedExclusive } from './fs-safe.mjs';
import { withPlanUpdateLock } from './plan-update.mjs';
import path from 'node:path';
import { projectStoreDir } from './project-layout.mjs';
import { linkedPrimaryCheckout } from './knowledge/store.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { selectProjectAuthority, PROJECT_AUTHORITY_FILES, assertExternalStateHome } from '../corpus/hooks/lib/project-authority.mjs';

export { PROJECT_AUTHORITY_FILES, assertExternalStateHome };

export function resolveProjectAuthority(workspace, { home = harnessGlobalHome(), mode } = {}) {
  const root = path.resolve(workspace);
  home = path.resolve(home || harnessGlobalHome());
  // Alias routing and competing local/shared files stay live even within an
  // identity read phase; only the underlying Git identity may be reused.
  const project = projectStoreDir(root, { home });
  const authority = selectProjectAuthority(root, project, { home, mode });
  if (authority.mode !== 'local') return authority;
  let checkout = root;
  while (!fs.lstatSync(path.join(checkout, '.git'), { throwIfNoEntry: false })) {
    const parent = path.dirname(checkout);
    if (parent === checkout) return authority;
    checkout = parent;
  }
  const primary = linkedPrimaryCheckout(checkout);
  if (primary) {
    const primaryAuthority = selectProjectAuthority(primary, projectStoreDir(primary, { home }), { home });
    if (primaryAuthority.mode === 'shared') {
      throw Object.assign(new Error(`Workspace ${root} belongs to linked checkout ${checkout} without the shared project authority selected by primary ${primary}: ${primaryAuthority.directory}`), {
        code: 'E_PROJECT_AUTHORITY', exit: 1,
        hint: 'Inspect the complete primary shared configuration and establish the intended branch policy before preparing local authority; implicit local setup would conflict with the primary.',
      });
    }
  }
  return authority;
}

export function projectAuthorityFile(workspace, name, options) {
  if (!PROJECT_AUTHORITY_FILES.includes(name)) throw new Error(`Unknown project authority source: ${name}`);
  const authority = resolveProjectAuthority(workspace, options);
  return { ...authority, path: authority.files[name], relative: path.relative(authority.root, authority.files[name]), display: authority.mode === 'shared' ? `.github/harness/${name}` : authority.files[name] };
}


/** Explicit setup publication; normal reads never migrate or merge authority. */
export function promoteProjectAuthority(workspace, { home = harnessGlobalHome(), dryRun = false } = {}) {
  workspace = path.resolve(workspace); home = path.resolve(home);
  assertExternalStateHome(workspace, home);
  const project = projectStoreDir(workspace, { home });
  assertExternalStateHome(workspace, home, project);
  const local = path.join(project, 'authority'), shared = path.join(workspace, '.github', 'harness');
  const fail = message => { throw Object.assign(new Error(`Project authority promotion: ${message}`), { code: 'E_PROJECT_AUTHORITY', exit: 1 }); };
  const safeDirectory = (root, full) => {
    if (!assertNoSymlinkAncestors(root, path.relative(root, full))) fail(`unsafe or symlinked directory: ${full}`);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail(`unsafe or nonregular directory: ${full}`);
    return stat;
  };
  const readSet = (root, directory, privateSource = false) => {
    if (!safeDirectory(root, directory)) return new Map();
    const names = fs.readdirSync(directory);
    if (privateSource && names.some(name => !PROJECT_AUTHORITY_FILES.includes(name))) fail(`unexpected files in ${directory}; inspect them before publication`);
    return new Map(names.filter(name => PROJECT_AUTHORITY_FILES.includes(name)).map(name => {
      const bytes = readFileNoFollow(path.join(directory, name), { root, maxBytes: 1024 * 1024, encoding: null });
      if (bytes === null) fail(`unsafe, nonregular or oversized source: ${path.join(directory, name)}`);
      return [name, bytes];
    }));
  };
  const inspect = () => {
    const sources = readSet(home, local, true);
    const published = readSet(workspace, shared);
    for (const [name, bytes] of published) if (sources.size && (!sources.has(name) || !sources.get(name).equals(bytes))) fail(`shared source differs or conflicts: ${path.join(shared, name)}`);
    return { sources, published };
  };
  const initial = inspect();
  if (!initial.sources.size) return { promoted: false, files: [], backup: null, dryRun };
  if (dryRun) return { promoted: false, files: [...initial.sources.keys()], backup: null, dryRun: true };
  return withPlanUpdateLock(path.join(project, 'authority-promotion'), () => {
    const { sources, published } = inspect();
    if (!sources.size) return { promoted: false, files: [], backup: null, dryRun: false };
    const created = [];
    try {
      for (const [name, bytes] of sources) {
        if (published.has(name)) continue;
        const full = writeFileContainedExclusive(workspace, path.join('.github', 'harness', name), bytes);
        if (!full) fail(`could not exclusively publish ${name}; existing files were preserved`);
        const stat = fs.lstatSync(full);
        created.push({ name, full, dev: stat.dev, ino: stat.ino });
      }
      const after = inspect();
      if (after.sources.size !== sources.size || after.published.size !== sources.size || [...sources].some(([name, bytes]) => !after.sources.get(name)?.equals(bytes) || !after.published.get(name)?.equals(bytes))) fail('sources changed during publication; inspect both configurations');
      // Retain the entire private directory. An interrupted copy is resumable
      // only when all already-published files still match the private source.
      safeDirectory(home, local);
      const backupRoot = fs.mkdtempSync(path.join(project, '.authority-backup-'));
      const backup = path.join(backupRoot, 'authority');
      fs.renameSync(local, backup);
      return { promoted: true, files: [...sources.keys()], backup, dryRun: false };
    } catch (error) {
      for (const entry of created) {
        try {
          if (!assertNoSymlinkAncestors(workspace, path.relative(workspace, entry.full))) continue;
          const stat = fs.lstatSync(entry.full, { throwIfNoEntry: false });
          const bytes = readFileNoFollow(entry.full, { root: workspace, maxBytes: 1024 * 1024, encoding: null });
          if (stat?.isFile() && stat.dev === entry.dev && stat.ino === entry.ino && bytes?.equals(sources.get(entry.name))) fs.unlinkSync(entry.full);
        } catch { /* A conflicting successor remains for explicit recovery. */ }
      }
      throw error;
    }
  });
}
