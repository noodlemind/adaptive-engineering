import { displayWidth, padTo, wrapCells, clipTo } from './width.mjs';

export const FOLD_THRESHOLD = 12;
/** How much of a folded block still shows. Enough to see what it was. */
export const FOLD_HEAD = 6;

const STATUS = {
  user: ['user', null, 'muted'],
  running: ['running', 'active', 'info'],
  ok: ['ok', 'ok', 'ok'],
  succeeded: ['ok', 'ok', 'ok'],
  failed: ['failed', 'error', 'muted'],
  blocked: ['failed', 'error', 'muted'],
  /** Usage / bad argv — repairable; not a failed engineering task. */
  usage: ['usage', 'warn', 'warn'],
  inconclusive: ['failed', 'warn', 'warn'],
  cancelled: ['cancelled', 'error', 'muted'],
  'timed-out': ['failed', 'warn', 'warn'],
};

const statusOf = (status) => STATUS[status] || STATUS.user;

/** `0m12s` — the mock's shape. Minutes never roll into hours because a command
 * that ran for an hour should read as `73m` rather than as a clock time you
 * have to subtract. */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}

export function formatActor(actor) {
  if (!actor) return null;
  if (typeof actor === 'string') return actor;
  if (actor.kind === 'user') return 'you';
  if (actor.kind === 'ci') return 'ci';
  if (actor.kind === 'host') return actor.host || 'host';
  return actor.kind || null;
}

/** `14:07:03` — local wall time, which is what someone reading their own
 * scrollback is comparing against. */
export function formatClock(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

let counter = 0;
/** A local block id. Short enough to type after `!!`, and drawn from the same
 * alphabet as the run journal's ids so the two read alike. */
export function newBlockId() {
  counter = (counter + 1) % 0xffff;
  return `${Date.now().toString(36).slice(-4)}${counter.toString(36).padStart(2, '0')}`;
}

export function createBlock({
  id = newBlockId(),
  command = '',
  status = 'running',
  exit = null,
  startedAt = new Date().toISOString(),
  durationMs = null,
  actor = 'you',
  run = null,
  lines = [],
  tally = null,
  next = null,
  marked = false,
  folded = null,
  cwd = null,
  kind = 'command',
    argv = [],
} = {}) {
  return {
    id, command, status, exit, startedAt, durationMs, actor, run,
    lines: [...lines], tally, next, marked, folded, cwd, kind, argv: [...argv],
  };
}

export function recordSegments(block) {
  const [, , wordToken] = statusOf(block.status);
  const segments = [{ token: wordToken, text: block.status }];
  if (Number.isInteger(block.exit)) segments.push({ token: 'faint', text: `exit ${block.exit}` });
  const dur = formatDuration(block.durationMs);
  if (dur) segments.push({ token: 'faint', text: dur });
    const actor = formatActor(block.actor);
  if (actor) segments.push({ token: 'faint', text: actor });
  const clock = formatClock(block.startedAt);
  if (clock) segments.push({ token: 'faint', text: clock });
    if (block.run) segments.push({ token: 'faint', text: `#${shortId(block.run)}` });
  return segments;
}

/** The addressable spelling of a run id: the random tail, which is the part
 * that cannot collide. What the record line prints after `#`, and what `!!`
 * and the overlays accept back. */
export function shortId(run) {
  return String(run ?? '').slice(-6);
}

/** How much of a tail-bearing block's END still shows. See `foldState`. */
export const FOLD_TAIL = 8;

export function foldState(block, { threshold = FOLD_THRESHOLD, head = FOLD_HEAD, tail = FOLD_TAIL } = {}) {
  const total = block.lines.length;
    const folded = block.folded === null ? total > threshold : block.folded;
  if (!folded || total <= head) return { folded: false, shown: total, hidden: 0, tailShown: 0 };
  if (!block.keepTail) return { folded: true, shown: head, hidden: total - head, tailShown: 0 };
  // Nothing is gained by eliding fewer rows than the notice announcing it.
  if (total <= head + tail + 1) return { folded: false, shown: total, hidden: 0, tailShown: 0 };
  return { folded: true, shown: head, hidden: total - head - tail, tailShown: tail };
}

export function renderBlock(block, {
  ui,
  width = 80,
  selected = false,
  showRecord = true,
  fold = {},
} = {}) {
  const [tintState, glyphState] = statusOf(block.status);
  const stripeMark = selected
    ? ui.paint('info', ui.unicode ? '┃' : '>')
    : ui.stripe(tintState);
  const gutter = `${stripeMark} `;
    const inner = Math.max(8, width - 2);

  const rows = [];
  const push = (content) => {
    for (const piece of wrapCells(content, inner)) {
      rows.push(ui.tintRow(tintState, padTo(`${gutter}${piece}`, width)));
    }
  };
    const pushStyled = (content) => {
    const visible = displayWidth(content);
    if (visible > inner && !content.includes('\x1b')) {
      const indent = /^\s*/.exec(content)[0];
      for (const piece of wrapCells(content.slice(indent.length), Math.max(8, inner - indent.length))) {
        rows.push(ui.tintRow(tintState, padTo(`${gutter}${indent}${piece}`, width)));
      }
      return;
    }
    const body = visible <= inner ? content : `${clipTo(ui.stripAnsi(content), inner - 1)}…`;
    const pad = ' '.repeat(Math.max(0, inner - displayWidth(body)));
    rows.push(ui.tintRow(tintState, `${gutter}${body}${pad}`));
  };

    if (block.command) {
    push(`${ui.paint('info', ui.unicode ? '❯' : '>')} ${block.command}`);
  }

  // 2 — the record line.
  if (showRecord && block.status !== 'user') {
    const parts = recordSegments(block).map((s) => (
      s.token === 'faint' ? ui.paint('muted', s.text) : ui.paint(s.token, s.text)
    ));
    const mark = block.marked ? `${ui.paint('warn', ui.unicode ? '★' : '*')} ` : '';
    pushStyled(`  ${mark}${parts.join(ui.paint('muted', ' · '))}`);
  }

    const state = foldState(block, fold);
  const shell = block.command.startsWith('!') || block.argv?.[0] === 'bash';
  const corner = ui.unicode ? '└' : '\\';
  block.lines.slice(0, state.shown).forEach((line, i) => {
    pushStyled(shell ? `  ${i === 0 ? ui.paint('muted', corner) : ' '} ${line}` : `  ${line}`);
  });
  if (state.folded) {
    pushStyled(`  ${ui.paint('muted', `… ${state.hidden} more line${state.hidden === 1 ? '' : 's'}`)}${ui.paint('muted', ' (ctrl+o)')}`);
    // The tail, for a block whose payload is at the end — see `foldState`.
    for (const line of block.lines.slice(block.lines.length - state.tailShown)) {
      pushStyled(shell ? `    ${line}` : `  ${line}`);
    }
  }

  // 4 — the closing tally, and the one action that follows.
  if (block.tally) {
    const next = block.next ? ui.paint('info', ` ${ui.arrow} ${block.next}`) : '';
    pushStyled(`  ${ui.paint('muted', block.tally)}${next}`);
  } else if (block.next) {
    pushStyled(`  ${ui.paint('info', `${ui.arrow} ${block.next}`)}`);
  }

    void glyphState;
  return rows;
}

export function runningHeader(block, { ui, width = 80, lineCount = 0 } = {}) {
  const label = block.command || 'running';
  const tail = `esc cancels${lineCount ? ` · ${lineCount} lines` : ''}`;
  const head = `  ${ui.paint('info', ui.unicode ? '◐' : '-')} ${clipTo(label, Math.max(8, width - tail.length - 8))}`;
  const gap = Math.max(1, width - displayWidth(head) - displayWidth(tail) - 2);
  return ui.tintRow('running', padTo(`${ui.stripe('running')} ${head.slice(2)}${' '.repeat(gap)}${ui.paint('muted', tail)}`, width));
}
