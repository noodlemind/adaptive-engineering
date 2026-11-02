import { spawnGitSync } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { gitMetadataEnvironment } from '../corpus/hooks/lib/product-diff.mjs';
import { appendFileContained, assertNoSymlinkAncestors, canonicalPath, readFileNoFollow, writeFileContained } from './fs-safe.mjs';

/** Local Git metadata is shared by linked worktrees, never committed to the product. */
export function ensureLocalGitExclude(workspace, patterns, { dryRun = false } = {}) {
  if (!Array.isArray(patterns) || patterns.some(pattern => !['/.harness/', '/.worktrees/'].includes(pattern))) return null;
  const env = gitMetadataEnvironment();
  const options = { cwd: workspace, encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024, env };
  const observed = spawnGitSync(['-c', 'core.fsmonitor=false', 'rev-parse', '--git-common-dir'], options);
  if (observed.error || observed.status !== 0) {
    try {
      const marker = fs.lstatSync(path.join(workspace, '.git'), { throwIfNoEntry: false });
      return !marker && !observed.error && /not a git repository/i.test(observed.stderr || '') ? { git: false } : null;
    } catch { return null; }
  }
  // Observe paths separately: a valid checkout name may itself contain a newline.
  const trimTerminator = value => String(value || '').replace(process.platform === 'win32' ? /\r?\n$/ : /\n$/, '');
  const common = trimTerminator(observed.stdout);
  const checkout = spawnGitSync(['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], options);
  if (checkout.error || checkout.status !== 0) return null;
  const toplevel = trimTerminator(checkout.stdout);
  if (!common || !toplevel || common.includes('\0') || toplevel.includes('\0')) return null;
  let prefix;
  try { prefix = path.relative(canonicalPath(toplevel), canonicalPath(workspace)); }
  catch { return null; }
  if (prefix === '..' || prefix.startsWith(`..${path.sep}`) || path.isAbsolute(prefix) || /[\r\n]/.test(prefix)) return null;
  prefix = prefix.split(path.sep).join('/');
  const escaped = prefix.replace(/[\\*?\[\]#! ]/g, '\\$&');
  const scoped = patterns.map(pattern => prefix ? `/${escaped}${pattern}` : pattern);
  const root = path.resolve(workspace, common);
  const rel = path.join('info', 'exclude');
  if (!assertNoSymlinkAncestors(root, rel)) return null;
  let stat;
  try { stat = fs.lstatSync(path.join(root, rel), { throwIfNoEntry: false }); }
  catch { return null; }
  const current = stat ? readFileNoFollow(path.join(root, rel), { root, maxBytes: 1024 * 1024 }) : '';
  if (current === null) return null;
  const lines = current.split(/\r?\n/);
  const missing = [...new Set(scoped)].filter(pattern => !lines.includes(pattern));
  if (!dryRun && missing.length) {
    const content = `${missing.join('\n')}\n`;
    if (Buffer.byteLength(current) + Buffer.byteLength(content) + 1 > 1024 * 1024) return null;
    try {
      const written = stat
        ? appendFileContained(root, rel, content, { newlineGuard: true })
        : writeFileContained(root, rel, content, { exclusive: true });
      if (!written) return null;
    } catch { return null; }
  }
  if (!dryRun) {
    // Product .gitignore rules have higher precedence. Report that conflict
    // rather than claim private state is excluded or rewrite authored policy.
    for (const pattern of patterns) {
      const checked = spawnGitSync(['-c', 'core.fsmonitor=false', 'check-ignore', '--quiet', '--no-index', '--', pattern.slice(1)], options);
      if (checked.error || checked.status !== 0) return null;
    }
  }
  return { git: true, path: path.join(root, rel) };
}
