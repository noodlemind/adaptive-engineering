import fs from 'node:fs';
import path from 'node:path';
import {
  startRun,
  finishRun,
  newRunId,
  readJournal,
  foldRuns,
  runStatusForExit as journalStatusForExit,
} from '../run-journal.mjs';
import { createBlock, newBlockId, formatActor } from './block.mjs';
import { detectActor } from '../event-registry.mjs';
import { writeFileContained } from '../fs-safe.mjs';
import { EXIT } from '../style.mjs';

/** How many prior runs a fresh session restores. Enough that yesterday's work
 * is on screen; few enough that opening the ledger is not a history dump. */
export const HYDRATE_LIMIT = 8;

const MARKS_FILE = path.join('.harness', 'tui-marks.json');

function readMarks(workspace) {
  try {
    const raw = fs.readFileSync(path.join(workspace, MARKS_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed?.marked) ? parsed.marked : []);
  } catch {
    return new Set();
  }
}

function writeMarks(workspace, marks) {
  try {
    writeFileContained(workspace, MARKS_FILE, `${JSON.stringify({ marked: [...marks] }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Map a run-journal status onto the block vocabulary. They agree everywhere
 * except `succeeded`, which the block layer renders as `ok` — the ledger
 * grammar's word — while the journal keeps the contract's. */
const STATUS_FROM_RUN = {
  succeeded: 'ok',
  failed: 'failed',
  cancelled: 'cancelled',
  'timed-out': 'timed-out',
  blocked: 'blocked',
  inconclusive: 'inconclusive',
  usage: 'usage',
  running: 'running',
};

/**
 * Map process exit to ledger block status. Usage (exit 2) projects as `usage`
 * so the TUI can show a correction card — not work-failed "inconclusive".
 * Journal automation still receives exit 2.
 */
export function statusForExit(code, opts = {}) {
  if (!opts.cancelled && !opts.timedOut && code === EXIT.usage) return 'usage';
  return journalStatusForExit(code, opts);
}

export function createLedger({
  workspace = process.cwd(),
    actor = detectActor(),
  harnessVersion = null,
  journaling = true,
  now = () => Date.now(),
} = {}) {
  const blocks = [];
  const marks = readMarks(workspace);

  function hydrate({ limit = HYDRATE_LIMIT, restoreWorthy = null } = {}) {
    if (!journaling) return [];
    let folded;
    try {
      folded = foldRuns(readJournal(workspace));
    } catch {
      return [];
    }
    const worthKeeping = restoreWorthy ?? ((r) => {
      if (r.command === 'tui') return false;
      if (r.status !== 'succeeded') return true;
      return !['search', 'lookup', 'tree', 'run', 'orient', 'status', 'get', 'recall', 'help', 'doctor', 'report'].includes(r.command);
    });
    const interesting = folded
      .filter((r) => r.terminal && r.command)
      .filter(worthKeeping)
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
      .slice(-limit);

    const restored = interesting.map((r) => createBlock({
      id: r.run,
      run: r.run,
      command: [r.command, ...(r.argv || [])].join(' ').trim(),
      status: STATUS_FROM_RUN[r.status] || 'failed',
      exit: Number.isInteger(r.exitCode) ? r.exitCode : null,
      startedAt: r.startedAt,
      durationMs: r.durationMs,
      actor: formatActor(r.actor) || 'you',
      marked: marks.has(r.run),
            argv: [r.command, ...(r.argv || [])].filter(Boolean),
            lines: [],
      tally: 'restored from the run journal',
      kind: 'restored',
    }));
    blocks.push(...restored);
    return restored;
  }

  function open({ command, argv = [], plan = null, kind = 'command' } = {}) {
    const run = journaling ? newRunId() : newBlockId();
    const block = createBlock({
      id: run,
      run: journaling ? run : null,
      command,
      status: 'running',
      startedAt: new Date().toISOString(),
      actor: formatActor(actor),
      kind,
      cwd: workspace,
    });
    block.argv = [...argv];
    block._startedMs = now();
    block._plan = plan;
    blocks.push(block);
    return block;
  }

  function openRun(block) {
    if (!block || !journaling || !block.run || block._runOpened) return block;
    block._runOpened = true;
    try {
      startRun(workspace, {
        run: block.run,
        command: block.argv?.[0] || block.command,
        argv: block.argv?.slice(1) ?? [],
        plan: block._plan ?? null,
        host: process.env.HARNESS_HOST || 'harness-tui',
        actor,
        harnessVersion,
      });
    } catch {
      block.run = null;
    }
    return block;
  }

  /** Close a block and its run.
   * `status` may be ledger vocabulary (`ok`, `usage`) or journal vocabulary
   * (`succeeded`, `inconclusive`). The journal only stores RUN_STATUSES. */
  function close(block, { status, exitCode = null, tally = null, next = null } = {}) {
    if (!block) return null;
    const durationMs = block._startedMs ? now() - block._startedMs : null;
    // Display: prefer explicit ledger words (usage, ok) over journal aliases.
    if (status === 'usage') block.status = 'usage';
    else if (status === 'ok' || status === 'succeeded') block.status = 'ok';
    else block.status = STATUS_FROM_RUN[status] || status || 'failed';
    block.exit = exitCode;
    block.durationMs = durationMs;
    if (tally) block.tally = tally;
    if (next) block.next = next;
    if (block.run && block._runOpened) {
      const journalStatus = status === 'usage'
        ? 'inconclusive'
        : status === 'ok'
          ? 'succeeded'
          : status;
      try {
        finishRun(workspace, { run: block.run, status: journalStatus, exitCode, durationMs });
      } catch { /* see openRun() — durability is best effort, the session is not */ }
    }
    return block;
  }

  return {
    workspace,
    get blocks() { return blocks; },
    hydrate,
    open,
    openRun,
    close,
    /** Append an output row to a block as it streams. */
    append(block, line) {
      if (block && line !== undefined && line !== null) block.lines.push(String(line));
      return block;
    },
    /** The most recent block that actually ran something — what bare `!!`
     * repeats. Notes and restored records are skipped: repeating a note is
     * meaningless, and a restored block's command is a string we did not parse. */
    lastCommand() {
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        if (blocks[i].kind === 'command' && blocks[i].command) return blocks[i];
      }
      return null;
    },
    /** Find a block by id or unique id prefix, so `!! 5e08c7` works from what
     * is on screen rather than from a full run id. */
    byId(id) {
      const wanted = String(id ?? '').trim().replace(/^#/, '');
      if (!wanted) return null;
      const exact = blocks.find((b) => b.id === wanted || b.run === wanted);
      if (exact) return exact;
      const matches = (v) => String(v ?? '').startsWith(wanted) || String(v ?? '').endsWith(wanted);
      const hits = blocks.filter((b) => matches(b.id) || matches(b.run));
      return hits.length === 1 ? hits[0] : null;
    },
    /** Toggle a mark, persisting it. Returns the new state, or null when the
     * block has no durable id to hang a mark on. */
    toggleMark(block) {
      if (!block?.run) return null;
      const key = block.run;
      block.marked = !block.marked;
      if (block.marked) marks.add(key);
      else marks.delete(key);
      writeMarks(workspace, marks);
      return block.marked;
    },
    get markCount() { return blocks.filter((b) => b.marked).length; },
    /** Drop everything on screen. The journal is untouched — `clear` is a
     * viewport gesture, and erasing history is not something a viewport does. */
    clear() { blocks.length = 0; },
  };
}
