import fs from 'node:fs';
import path from 'node:path';

export const PROJECT_AUTHORITY_FILES = Object.freeze(['config.yaml', 'policy.yaml', 'checks.yaml', 'routing.yaml']);

function failure(message) {
  return Object.assign(new Error(message), { code: 'E_PROJECT_AUTHORITY', exit: 1, hint: 'Choose one local or shared project configuration; inspect both locations before moving any policy files.' });
}

function plannedCanonical(full) {
  const suffix = [];
  let current = path.resolve(full);
  while (!fs.lstatSync(current, { throwIfNoEntry: false })) {
    suffix.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) throw failure('State home identity is unavailable');
    current = parent;
  }
  return path.join(fs.realpathSync.native(current), ...suffix);
}

/** State remains private even when callers select a custom home or a subfolder. */
export function assertExternalStateHome(workspace, home, projectStore) {
  let product = plannedCanonical(workspace);
  for (let candidate = product; ; candidate = path.dirname(candidate)) {
    if (fs.lstatSync(path.join(candidate, '.git'), { throwIfNoEntry: false })) { product = candidate; break; }
    if (path.dirname(candidate) === candidate) break;
  }
  for (const selected of [home, projectStore].filter(Boolean)) {
    const relative = path.relative(product, plannedCanonical(selected));
    if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      throw failure('AE state home must be outside the product checkout; select --ae-home outside this repository');
    }
  }
}

function present(root, directory) {
  const relative = path.relative(root, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw failure('Project authority directory is outside its selected root');
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current, { throwIfNoEntry: false }); }
    catch { throw failure(`Project authority path is unreadable: ${current}`); }
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure(`Project authority path is unsafe or nonregular: ${current}`);
  }
  return PROJECT_AUTHORITY_FILES.some(name => {
    try { return Boolean(fs.lstatSync(path.join(directory, name), { throwIfNoEntry: false })); }
    catch { throw failure(`Project authority source is unreadable: ${path.join(directory, name)}`); }
  });
}

/** Diagnose a subfolder without inheriting another root's configuration. */
function enclosingSharedProject(workspace) {
  const parents = [];
  for (let current = path.resolve(workspace); ; current = path.dirname(current)) {
    if (fs.lstatSync(path.join(current, '.git'), { throwIfNoEntry: false })) {
      // A directory or worktree .git file marks this repository's boundary.
      // No Git command or parent policy is executed or selected by this probe.
      return parents.find(parent => present(parent, path.join(parent, '.github', 'harness'))) || null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    parents.push(parent);
  }
}

/** The CLI and hydrated hooks select one complete source, never an overlay. */
export function selectProjectAuthority(workspace, projectStore, { home, mode } = {}) {
  assertExternalStateHome(workspace, home, projectStore);
  if (mode !== undefined && !['local', 'shared'].includes(mode)) throw failure('Project authority mode must be local or shared');
  const shared = path.join(workspace, '.github', 'harness');
  const local = path.join(projectStore, 'authority');
  const sharedPresent = present(workspace, shared);
  const localPresent = present(home, local);
  if (!mode && !sharedPresent && !localPresent) {
    const enclosing = enclosingSharedProject(workspace);
    if (enclosing) {
      throw Object.assign(new Error(`Selected workspace ${workspace} is inside a project with shared configuration at ${path.join(enclosing, '.github', 'harness')}; retry with --workspace ${JSON.stringify(enclosing)}.`), {
        code: 'E_PROJECT_WORKSPACE', exit: 1,
        hint: `Use --workspace ${JSON.stringify(enclosing)} to select that project explicitly, or initialize separate shared configuration for this nested project.`,
      });
    }
  }
  if (sharedPresent && localPresent) throw failure(`Both local and shared project authority exist: ${local} and ${shared}`);
  if (mode === 'shared' && localPresent) throw failure(`Local project authority already exists at ${local}; explicitly migrate the reviewed files before selecting shared setup`);
  if (mode === 'local' && sharedPresent) throw failure(`Shared project authority already exists at ${shared}; existing team configuration must remain selected`);
  const selected = mode || (sharedPresent ? 'shared' : 'local');
  const directory = selected === 'shared' ? shared : local;
  return {
    mode: selected,
    directory,
    root: selected === 'shared' ? workspace : home,
    present: selected === 'shared' ? sharedPresent : localPresent,
    files: Object.fromEntries(PROJECT_AUTHORITY_FILES.map(name => [name, path.join(directory, name)])),
  };
}
