import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { inertLine } from './knowledge/store.mjs';
import { parseFlags, hasFlag } from './flags.mjs';
import { positionalsOf } from './positionals.mjs';
import { safeResolveUnderRoot } from './path-safe.mjs';
import { readFileNoFollow, writeFileContained, appendFileContained } from './fs-safe.mjs';
import { ensureHarnessDir } from './session.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export const EDIT_SCHEMA = 1;

/** Extensions that get a cheap syntax refuse before write (AC18). Non-code is skipped. */
export const LINT_ON_EDIT_EXTENSIONS = Object.freeze(new Set([
  '.json', '.js', '.cjs', '.mjs',
]));

/**
 * Optional syntax check for known code extensions. Returns null if ok or skipped;
 * returns an error string if the content should be refused.
 */
export function syntaxCheckContent(relPath, content) {
  if (typeof content !== 'string') return null;
  const ext = path.extname(relPath || '').toLowerCase();
  if (!LINT_ON_EDIT_EXTENSIONS.has(ext)) return null;
  if (ext === '.json') {
    try {
      JSON.parse(content);
      return null;
    } catch (error) {
      return `JSON syntax error: ${error.message}`;
    }
  }
  // .js / .cjs / .mjs — cheap parse via vm.Script; ESM import/export is skipped (not a hard refuse).
  try {
    // eslint-disable-next-line no-new
    new vm.Script(content, { filename: relPath || 'edit.js' });
    return null;
  } catch (error) {
    const msg = String(error?.message || error);
    if (/Cannot use import statement|Unexpected token 'export'|await is only valid/.test(msg)) {
      return null;
    }
    return `JS syntax error: ${msg}`;
  }
}

const LOCK_STALE_MS = 30_000;

/** The minimum `--expect` prefix. Eight hex characters is 32 bits — enough that
 * a caller cannot pass a plausible-looking stub by accident, short enough to
 * type from a `get` result. */
const MIN_EXPECT_CHARS = 8;

const UNDO_LOG = '.harness/undo.jsonl';
const UNDO_DIR = '.harness/undo';
const LOCK_DIR = '.harness/locks';

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function literalFlag(argv, name) {
  const seen = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') break;
    if (token === name) {
      if (argv[i + 1] === undefined) throw usageError(`${name} requires a value`, `e.g. ${name} <text>`);
      seen.push(argv[i + 1]);
      i += 1;
    } else if (token.startsWith(`${name}=`)) {
      seen.push(token.slice(name.length + 1));
    }
  }
  if (!seen.length) return null;
  if (seen.length > 1) {
    throw usageError(`${name} was given more than once`, 'pass it once so there is no question which value applies');
  }
  return seen[0];
}

/** What a mutation reports when `--dry-run` stopped it at the last step. The
 * digests are of what IS and what WOULD BE, so a caller can diff them without
 * the command having touched anything. */
function dryRunResult(mode, relPath, before, after) {
  return {
    schema: EDIT_SCHEMA,
    mode,
    path: relPath,
    status: 'ok',
    exitCode: 0,
    reason: null,
    dryRun: true,
    created: before === null,
    matches: null,
    bytesBefore: before === null ? null : Buffer.byteLength(before, 'utf8'),
    bytesAfter: Buffer.byteLength(after, 'utf8'),
    sha256Before: before === null ? null : sha256(before),
    sha256After: sha256(after),
    undo: null,
    output: [],
  };
}

function failed(mode, relPath, reason, message, hint) {
  return {
    schema: EDIT_SCHEMA,
    mode,
    path: relPath,
    status: 'failed',
    exitCode: 1,
    reason,
    created: false,
    matches: null,
    bytesBefore: null,
    bytesAfter: null,
    sha256Before: null,
    sha256After: null,
    undo: null,
    output: hint ? [{ line: message }, { line: hint }] : [{ line: message }],
  };
}

function acquireLock(workspace, relPath) {
  const dir = path.join(workspace, LOCK_DIR);
    const key = path.resolve(workspace, relPath);
  const file = path.join(dir, `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 32)}.lock`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return { held: false, degraded: 'no lock directory', release: () => {} };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx' });
      return { held: true, degraded: null, release: () => { try { fs.unlinkSync(file); } catch { /* already released */ } } };
    } catch {
      let age = 0;
      try {
        age = Date.now() - fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (age < LOCK_STALE_MS) {
        return { held: false, degraded: null, busy: true, release: () => {} };
      }
      try {
        fs.unlinkSync(file);
      } catch {
        /* someone else broke it first; the retry below settles it */
      }
    }
  }
    return { held: false, degraded: 'could not take the lock', busy: true, release: () => {} };
}

/** Resolve a workspace-relative path, or null when it escapes. Kept as one
 * function so `edit`, `write` and `undo` cannot drift into three different
 * ideas of what is inside the workspace. */
function resolveTarget(workspace, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) return null;
  return safeResolveUnderRoot(path.resolve(workspace), relPath);
}

function readTarget(fullPath, workspaceResolved) {
  if (!fs.existsSync(fullPath)) return { exists: false, content: null, binary: false };
  const raw = readFileNoFollow(fullPath, { root: workspaceResolved });
  if (raw === null) return { exists: false, content: null, binary: false };
  if (raw.includes('\u0000')) return { exists: true, content: null, binary: true };
  return { exists: true, content: raw, binary: false };
}

function snapshot(workspace, relPath, previous) {
  if (ensureHarnessDir(workspace, false) === null) {
    return { id: null, reason: '.harness is not a real directory — this change was not made undoable' };
  }
  const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  if (previous.exists) {
    if (writeFileContained(workspace, `${UNDO_DIR}/${id}.bak`, previous.content) === null) {
      return { id: null, reason: 'the undo snapshot could not be written — this change was not made undoable' };
    }
  }
  return { id, reason: null, existedBefore: previous.exists };
}

function commitUndo(workspace, mode, relPath, snap, sha256After) {
  if (!snap.id) return null;
  const line = `${JSON.stringify({
    id: snap.id,
    type: 'mutation',
    mode,
    path: relPath,
    existedBefore: snap.existedBefore,
    sha256After,
    at: new Date().toISOString(),
  })}\n`;
  if (appendFileContained(workspace, UNDO_LOG, line, { newlineGuard: true }) === null) return null;
  return { id: snap.id };
}

/** The undo stack, newest first, with everything already undone removed. The
 * log is append-only — an undo appends a marker rather than rewriting history —
 * so "what would undo do next" is a fold over it and never a file rewrite. */
export function readUndoStack(workspace) {
  const full = resolveTarget(workspace, UNDO_LOG);
  if (!full || !fs.existsSync(full)) return [];
  const raw = readFileNoFollow(full, { root: path.resolve(workspace) });
  if (raw === null) return [];
  const entries = [];
  const undone = new Set();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed?.type === 'undone' && parsed.ref) undone.add(parsed.ref);
    else if (parsed?.type === 'mutation' && parsed.id) entries.push(parsed);
  }
  return entries.filter((e) => !undone.has(e.id)).reverse();
}

// --- edit -----------------------------------------------------------------

export function runEdit({ workspace, path: relPath, old, next, dryRun = false }) {
  const workspaceResolved = path.resolve(workspace);
  const full = resolveTarget(workspaceResolved, relPath);
  if (!full) {
    return failed('edit', relPath, 'escapes-workspace', `refusing to edit outside the workspace: ${relPath}`, 'paths are relative to the workspace root, and may not traverse above it or through a symlink');
  }
  if (old === next) {
    return failed('edit', relPath, 'no-change', '--old and --new are identical, so this edit would change nothing', 'pass the replacement text in --new');
  }

  const lock = acquireLock(workspaceResolved, relPath);
  if (lock.busy) {
    return failed('edit', relPath, 'locked', `another mutation is in progress on ${relPath}`, 'retry once it completes');
  }
  try {
    const target = readTarget(full, workspaceResolved);
    if (!target.exists) {
      return failed('edit', relPath, 'not-found', `no such file: ${relPath}`, 'use `ae write` to create it');
    }
    if (target.binary) {
      return failed('edit', relPath, 'binary', `${relPath} contains NUL bytes, so it is not editable as text`, null);
    }

    let matches = 0;
    let at = target.content.indexOf(old);
    const first = at;
    while (at !== -1) {
      matches += 1;
      if (matches > 1) break;
      at = target.content.indexOf(old, at + old.length);
    }
    if (matches === 0) {
      return failed('edit', relPath, 'no-match', `--old does not appear in ${relPath}`, 'read the file first — the match must be byte-exact, including indentation');
    }
    if (matches > 1) {
      return failed('edit', relPath, 'ambiguous', `--old appears more than once in ${relPath}`, 'extend --old with surrounding lines until it identifies exactly one place');
    }

    const before = target.content;
    const lineNumber = before.slice(0, first).split(/\r?\n/).length;
    const after = before.slice(0, first) + next + before.slice(first + old.length);
    const syntaxError = syntaxCheckContent(relPath, after);
    if (syntaxError) {
      return failed('edit', relPath, 'syntax', `refusing to write invalid syntax to ${relPath}`, syntaxError);
    }
    if (dryRun) {
      return {
        ...dryRunResult('edit', relPath, before, after),
        matches: 1,
        line: lineNumber,
        output: [{ line: `would edit ${relPath} on line ${lineNumber}` }, { line: `1 replacement · ${Buffer.byteLength(before, 'utf8')} → ${Buffer.byteLength(after, 'utf8')} bytes` }],
      };
    }
    const snap = snapshot(workspaceResolved, relPath, target);
    if (writeFileContained(workspaceResolved, relPath, after) === null) {
      return failed('edit', relPath, 'write-refused', `the write to ${relPath} was refused`, 'the path resolved outside the workspace at write time, or the file is not writable');
    }
    const sha256After = sha256(after);
    const undo = commitUndo(workspaceResolved, 'edit', relPath, snap, sha256After);
    return {
      schema: EDIT_SCHEMA,
      mode: 'edit',
      path: relPath,
      status: 'ok',
      exitCode: 0,
      reason: null,
      created: false,
      matches: 1,
      bytesBefore: Buffer.byteLength(before, 'utf8'),
      bytesAfter: Buffer.byteLength(after, 'utf8'),
      sha256Before: sha256(before),
      sha256After,
      undo,
      degraded: lock.degraded,
      line: lineNumber,
      output: [
        { line: `edited ${relPath} on line ${lineNumber}` },
        { line: `1 replacement · ${Buffer.byteLength(before, 'utf8')} → ${Buffer.byteLength(after, 'utf8')} bytes` },
        ...(snap.reason ? [{ line: snap.reason }] : []),
      ],
    };
  } finally {
    lock.release();
  }
}

// --- write ----------------------------------------------------------------

function isSuspiciousShrink(beforeBytes, afterBytes) {
  return afterBytes < beforeBytes / 2 && beforeBytes - afterBytes > 2048;
}

export function runWrite({ workspace, path: relPath, content, expect = null, allowShrink = false, dryRun = false }) {
  const workspaceResolved = path.resolve(workspace);
  const full = resolveTarget(workspaceResolved, relPath);
  if (!full) {
    return failed('write', relPath, 'escapes-workspace', `refusing to write outside the workspace: ${relPath}`, 'paths are relative to the workspace root, and may not traverse above it or through a symlink');
  }
    const expected = expect === null ? null : expect.trim().toLowerCase();
  if (expected !== null && expected.length < MIN_EXPECT_CHARS) {
    return failed('write', relPath, 'expect-too-short', `--expect needs at least ${MIN_EXPECT_CHARS} characters of the sha256`, 'ae get --path <file> --json reports the full digest');
  }

  const lock = acquireLock(workspaceResolved, relPath);
  if (lock.busy) {
    return failed('write', relPath, 'locked', `another mutation is in progress on ${relPath}`, 'retry once it completes');
  }
  try {
    const target = readTarget(full, workspaceResolved);
    if (target.exists && target.binary) {
      return failed('write', relPath, 'binary', `${relPath} contains NUL bytes; refusing to replace it through a text API`, null);
    }
    if (target.exists && expected === null) {
      return failed(
        'write',
        relPath,
        'exists',
        `${relPath} already exists, and no --expect was given`,
        `read it first, then pass --expect ${sha256(target.content).slice(0, 12)} to replace exactly what you read`,
      );
    }
    if (target.exists) {
      const current = sha256(target.content);
      if (!current.startsWith(expected)) {
        return failed(
          'write',
          relPath,
          'stale',
          `${relPath} has changed since it was read`,
          `--expect was ${expected}, the file is now ${current.slice(0, 12)} — read it again before replacing it`,
        );
      }
    } else if (expected !== null) {
      return failed(
        'write',
        relPath,
        'stale',
        `${relPath} does not exist, but --expect says it should hold known content`,
        'the file was removed or renamed since it was read — drop --expect to create it fresh',
      );
    }

    if (target.exists && !allowShrink) {
      const beforeBytes = Buffer.byteLength(target.content, 'utf8');
      const afterBytes = Buffer.byteLength(content, 'utf8');
      if (isSuspiciousShrink(beforeBytes, afterBytes)) {
        return failed(
          'write',
          relPath,
          'shrink',
          `refusing to replace ${relPath} (${beforeBytes} bytes) with much smaller content (${afterBytes} bytes)`,
          'a digest match proves the file was read, not that all of it was — use `edit` for a change to part of it, or pass --allow-shrink if replacing it with less is genuinely intended',
        );
      }
    }

    const syntaxError = syntaxCheckContent(relPath, content);
    if (syntaxError) {
      return failed('write', relPath, 'syntax', `refusing to write invalid syntax to ${relPath}`, syntaxError);
    }

    if (dryRun) {
      return {
        ...dryRunResult('write', relPath, target.exists ? target.content : null, content),
        output: [{ line: `would ${target.exists ? 'replace' : 'create'} ${relPath}` }, { line: `${Buffer.byteLength(content, 'utf8')} bytes` }],
      };
    }
    const snap = snapshot(workspaceResolved, relPath, target);
    if (writeFileContained(workspaceResolved, relPath, content) === null) {
      return failed('write', relPath, 'write-refused', `the write to ${relPath} was refused`, 'the path resolved outside the workspace at write time, or the file is not writable');
    }
    const sha256After = sha256(content);
    const undo = commitUndo(workspaceResolved, 'write', relPath, snap, sha256After);
    return {
      schema: EDIT_SCHEMA,
      mode: 'write',
      path: relPath,
      status: 'ok',
      exitCode: 0,
      reason: null,
      created: !target.exists,
      matches: null,
      bytesBefore: target.exists ? Buffer.byteLength(target.content, 'utf8') : null,
      bytesAfter: Buffer.byteLength(content, 'utf8'),
      sha256Before: target.exists ? sha256(target.content) : null,
      sha256After,
      undo,
      degraded: lock.degraded,
      output: [
        { line: `${target.exists ? 'replaced' : 'created'} ${relPath}` },
        { line: `${Buffer.byteLength(content, 'utf8')} bytes` },
        ...(snap.reason ? [{ line: snap.reason }] : []),
      ],
    };
  } finally {
    lock.release();
  }
}

// --- undo -----------------------------------------------------------------

/** Outstanding mutations, newest first — read-only; does not consume the stack. */
export function runUndoList({ workspace }) {
  const stack = readUndoStack(path.resolve(workspace));
  const entries = stack.map((e) => ({ id: e.id, mode: e.mode, path: e.path }));
  return {
    schema: EDIT_SCHEMA,
    mode: 'undo-list',
    path: null,
    status: 'ok',
    exitCode: 0,
    reason: null,
    entries,
    undo: null,
    degraded: null,
    output: entries.length
      ? entries.map((e) => ({ line: `${e.id}  ${e.mode}  ${e.path}` }))
      : [{ line: 'nothing outstanding to undo' }],
  };
}

export function runUndo({ workspace, dryRun = false }) {
  const workspaceResolved = path.resolve(workspace);
  const stack = readUndoStack(workspaceResolved);
  if (!stack.length) {
    return failed('undo', null, 'nothing-to-undo', 'nothing to undo — no recorded edit or write is outstanding', null);
  }
  const entry = stack[0];
  const full = resolveTarget(workspaceResolved, entry.path);
  if (!full) {
    return failed('undo', entry.path, 'escapes-workspace', `the recorded path no longer resolves inside the workspace: ${entry.path}`, null);
  }

  const lock = acquireLock(workspaceResolved, entry.path);
  if (lock.busy) {
    return failed('undo', entry.path, 'locked', `another mutation is in progress on ${entry.path}`, 'retry once it completes');
  }
  try {
    const target = readTarget(full, workspaceResolved);
    if (!target.exists) {
      return failed('undo', entry.path, 'not-found', `${entry.path} no longer exists, so there is nothing to put back`, null);
    }
    if (target.binary || sha256(target.content) !== entry.sha256After) {
      return failed(
        'undo',
        entry.path,
        'drifted',
        `${entry.path} has changed since the edit being undone`,
        'undoing now would overwrite that later change — inspect it first',
      );
    }

    if (dryRun) {
      return {
        ...dryRunResult('undo', entry.path, target.content, target.content),
        output: [{ line: `would undo ${entry.mode} ${entry.id} on ${entry.path}` }],
      };
    }

    let restored;
    if (entry.existedBefore) {
      const backup = resolveTarget(workspaceResolved, `${UNDO_DIR}/${entry.id}.bak`);
      const previous = backup ? readFileNoFollow(backup, { root: workspaceResolved }) : null;
      if (previous === null) {
        return failed('undo', entry.path, 'snapshot-missing', `the snapshot for ${entry.path} is gone`, null);
      }
      if (writeFileContained(workspaceResolved, entry.path, previous) === null) {
        return failed('undo', entry.path, 'write-refused', `restoring ${entry.path} was refused`, null);
      }
      restored = { bytes: Buffer.byteLength(previous, 'utf8'), removed: false, sha256: sha256(previous) };
    } else {
      try {
        fs.unlinkSync(full);
      } catch (error) {
        return failed('undo', entry.path, 'write-refused', `removing ${entry.path} was refused: ${error.message}`, null);
      }
      restored = { bytes: 0, removed: true, sha256: null };
    }

    appendFileContained(workspaceResolved, UNDO_LOG, `${JSON.stringify({ type: 'undone', ref: entry.id, at: new Date().toISOString() })}\n`, { newlineGuard: true });
    return {
      schema: EDIT_SCHEMA,
      mode: 'undo',
      path: entry.path,
      status: 'ok',
      exitCode: 0,
      reason: null,
      created: false,
      matches: null,
      bytesBefore: Buffer.byteLength(target.content, 'utf8'),
      bytesAfter: restored.bytes,
      sha256Before: entry.sha256After,
      sha256After: restored.sha256,
      undo: { id: entry.id, undone: true },
      degraded: lock.degraded,
      output: [
        { line: restored.removed ? `removed ${entry.path}, which that change created` : `restored ${entry.path}` },
        { line: `undid ${entry.mode} ${entry.id}` },
      ],
    };
  } finally {
    lock.release();
  }
}

// --- command surface ------------------------------------------------------

function emitAudit(ctx, result) {
    if (result.dryRun) return;
  const events = ctx?.events;
  const sink = typeof events?.withCommand === 'function' ? events.withCommand(result.mode) : events;
  sink?.emit?.(result.mode, {
    result: result.status === 'ok' ? 'pass' : 'fail',
    status: result.status,
    exitCode: result.exitCode,
        file: {
      path: result.path,
      reason: result.reason,
      created: result.created,
      matches: result.matches,
      bytesBefore: result.bytesBefore,
      bytesAfter: result.bytesAfter,
      sha256Before: result.sha256Before,
      sha256After: result.sha256After,
      undoId: result.undo?.id ?? null,
      line: result.line ?? null,
    },
  });
}

function requirePath(relPath, mode) {
  if (typeof relPath === 'string' && relPath.trim()) return;
  throw usageError(`${mode} requires --path <relative-path>`, `ae ${mode} --path <file> …`);
}

/** Every flag whose value is arbitrary text on this surface. One list, because
 * the stripping below and the parsers above must agree byte-for-byte about
 * which values are opaque. */
const LITERAL_FLAGS = Object.freeze(['--path', '--old', '--new', '--content', '--expect']);

function withoutLiteralFlags(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      out.push(...argv.slice(i));
      break;
    }
    const name = LITERAL_FLAGS.find((n) => token === n || token.startsWith(`${n}=`));
    if (name) {
      if (token === name) i += 1; // the space form: skip the value token too
      continue;
    }
    out.push(token);
  }
  return out;
}

function planEdit(argv) {
  const flags = parseFlags(withoutLiteralFlags(argv));
  const workspace = path.resolve(flags.workspace);
  const relPath = literalFlag(argv, '--path');
  requirePath(relPath, 'edit');
  const old = literalFlag(argv, '--old');
  const next = literalFlag(argv, '--new');
    if (!old) throw usageError('edit requires --old <text>', 'ae edit --path <file> --old <text> --new <text>');
  if (next === null) throw usageError('edit requires --new <text>', 'ae edit --path <file> --old <text> --new <text>');
  return { flags, workspace, relPath, old, next };
}

function planWrite(argv) {
  const flags = parseFlags(withoutLiteralFlags(argv));
  const workspace = path.resolve(flags.workspace);
  const relPath = literalFlag(argv, '--path');
  requirePath(relPath, 'write');
  const content = literalFlag(argv, '--content');
  if (content === null) throw usageError('write requires --content <text>', 'ae write --path <file> --content <text>');
  return { flags, workspace, relPath, content, expect: literalFlag(argv, '--expect'), allowShrink: hasFlag(argv, '--allow-shrink') };
}

export async function editResultOf(argv, ctx = {}) {
  const p = planEdit(argv);
  const result = runEdit({ workspace: p.workspace, path: p.relPath, old: p.old, next: p.next, dryRun: p.flags.dryRun });
  emitAudit(ctx, result);
  return result;
}

export async function writeResultOf(argv, ctx = {}) {
  const p = planWrite(argv);
  const result = runWrite({ workspace: p.workspace, path: p.relPath, content: p.content, expect: p.expect, allowShrink: p.allowShrink, dryRun: p.flags.dryRun });
  emitAudit(ctx, result);
  return result;
}

export async function undoResultOf(argv, ctx = {}) {
  const flags = parseFlags(argv);
  const verb = positionalsOf(argv)[0] ?? null;
  if (verb === 'list') {
    // Read-only listing — no audit mutation event.
    return runUndoList({ workspace: path.resolve(flags.workspace) });
  }
  if (verb && verb !== 'list') {
    throw usageError(`unknown undo verb: ${verb}`, 'ae undo [list]');
  }
  const result = runUndo({ workspace: path.resolve(flags.workspace), dryRun: flags.dryRun });
  emitAudit(ctx, result);
  return result;
}

function render(result, flags) {
  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
    return;
  }
  const keyWidth = keyWidthFor(['status', result.mode]);
  if (result.mode === 'undo-list') {
    console.log(ui.line({
      state: 'ok',
      key: 'undo',
      value: result.entries?.length ? `${result.entries.length} outstanding` : 'empty',
      keyWidth,
    }));
    for (const row of result.output || []) console.log(`  ${inertLine(row.line)}`);
    return;
  }
  console.log(ui.line({
    state: result.status === 'ok' ? 'ok' : 'error',
    key: result.mode,
    value: result.path ?? '—',
    keyWidth,
  }));
  for (const row of result.output || []) console.log(`  ${inertLine(row.line)}`);
  if (result.degraded) {
    console.log(ui.line({ state: 'warn', key: 'control', value: `unserialized: ${result.degraded}`, keyWidth }));
  }
  if (result.status === 'ok' && result.undo?.id) {
    console.log(ui.line({ key: 'undo', value: 'ae undo', note: result.undo.id, keyWidth }));
  }
}

export function exitFor(result) {
  return result.status === 'ok' ? EXIT.ok : result.exitCode || 1;
}

async function runCommand(argv, ctx, resultOf) {
  const result = await resultOf(argv, ctx);
    render(result, parseFlags(withoutLiteralFlags(argv)));
  ctx.reportStatus?.(result.status);
  return exitFor(result);
}

export const cmdEdit = (argv, ctx = {}) => runCommand(argv, ctx, editResultOf);
export const cmdWrite = (argv, ctx = {}) => runCommand(argv, ctx, writeResultOf);
export const cmdUndo = (argv, ctx = {}) => runCommand(argv, ctx, undoResultOf);
