import { displayWidth, clipTo, padTo } from './width.mjs';
import { containsFlagSyntax } from './palette.mjs';

/** Rows shown at once. An overlay taller than a glance is a list, and a list is
 * what the palette exists instead of. */
export const PAGE = 9;

export const PREFIXES = Object.freeze({
  run: ['run'],
  plan: ['plan', 'gate', 'verify'],
  search: ['search', 'lookup', 'tree'],
  check: ['checks', 'verify'],
  res: ['resources', 'bundles'],
  learn: ['learnings', 'learning', 'remember', 'consolidate', 'knowledge'],
});

/** Split `run:resume` into `{ prefix: 'run', rest: 'resume' }`. Returns a null
 * prefix for anything that is not a declared namespace, so a colon inside a
 * query (a path, a time) is left alone. */
export function splitPrefix(query) {
  const text = String(query ?? '');
  const at = text.indexOf(':');
  if (at <= 0) return { prefix: null, rest: text };
  const head = text.slice(0, at).toLowerCase();
  if (!Object.hasOwn(PREFIXES, head)) return { prefix: null, rest: text };
  return { prefix: head, rest: text.slice(at + 1).trimStart() };
}

/** Keep only the rows whose command belongs to a namespace. */
export function applyPrefix(rows, prefix) {
  if (!prefix) return rows;
  const allowed = PREFIXES[prefix] || [];
  return rows.filter((r) => {
    const noun = String(r.noun ?? r.argvTokens?.[0]?.value ?? r.label ?? '').split(/\s+/)[0];
    return allowed.includes(noun);
  });
}

export function filterSectioned(rows, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [...rows];
  const hit = (row) => `${row.label ?? ''} ${row.note ?? ''}`.toLowerCase().includes(q);
  const out = [];
  let heading = null;
  let kept = false;
  for (const row of rows) {
    if (row.section) {
      heading = row;
      kept = false;
      continue;
    }
    if (!hit(row)) continue;
    if (heading && !kept) { out.push(heading); kept = true; }
    out.push(row);
  }
  return out;
}

export function createOverlay({
  title = '',
  rows = [],
  query = '',
  footer = '',
  kind = 'palette',
  page = PAGE,
  /** Re-rank on every keystroke, in place. Filtering through the loop instead
   * would cost a round trip per character, which is exactly the latency a
   * palette must not have. */
  filter = null,

  actions = null,
} = {}) {
  let items = [...rows];
  let index = 0;
  let offset = 0;
  let text = query;

  const clamp = () => {
    if (!items.length) { index = 0; offset = 0; return; }
    index = Math.max(0, Math.min(index, items.length - 1));
    if (index < offset) offset = index;
    if (index >= offset + page) offset = index - page + 1;
    offset = Math.max(0, Math.min(offset, Math.max(0, items.length - page)));
  };

  /** Never land on a section heading — it is chrome, not a choice. */
  const landOnChoice = (from = 0, step = 1) => {
    if (!items.length) { index = 0; offset = 0; return; }
    const n = items.length;
    let next = ((from % n) + n) % n;
    const dir = step === 0 ? 1 : Math.sign(step);
    for (let guard = 0; guard < n && items[next]?.section; guard += 1) {
      next = (next + dir + n) % n;
    }
    index = next;
    clamp();
  };

  const move = (delta) => {
    if (!items.length) return false;
    const step = delta === 0 ? 1 : Math.sign(delta);
    landOnChoice(index + delta, step);
    return true;
  };

  landOnChoice(0, 1);

  return {
    kind,
    get title() { return title; },
    get query() { return text; },
    get rows() { return items; },
    get index() { return index; },
    get selected() { return items[index] ?? null; },
    get visible() { return items.slice(offset, offset + page); },
    get offset() { return offset; },
    setRows(next) { items = [...next]; landOnChoice(0, 1); },
    setQuery(next) { text = String(next ?? ''); },
    setFooter(next) { footer = next; },
    get footerText() { return footer; },

    handleKey(str, key = {}) {
      const name = key.name;
      const ctrl = Boolean(key.ctrl);
      if (name === 'escape' || (ctrl && name === 'c')) return { intent: 'close', changed: true };
      if (name === 'up' || (ctrl && name === 'p')) return { intent: null, changed: move(-1) };
      if (name === 'down' || (ctrl && name === 'n')) return { intent: null, changed: move(1) };
      if (name === 'pageup') return { intent: null, changed: move(-page) };
      if (name === 'pagedown') return { intent: null, changed: move(page) };
      if (name === 'home') { landOnChoice(0, 1); return { intent: null, changed: true }; }
      if (name === 'end') { landOnChoice(Math.max(0, items.length - 1), -1); return { intent: null, changed: true }; }
      if (name === 'return' || name === 'enter' || name === 'tab') {
        if (!items.length) return { intent: null, changed: false };
        if (items[index]?.section) {
          landOnChoice(index + 1, 1);
          return { intent: null, changed: true };
        }
        return { intent: 'choose', row: items[index], changed: true };
      }
      if (actions) {
        if (name === 'backspace') return { intent: 'close', changed: true };
        const pressed = typeof str === 'string' ? str.toLowerCase() : null;
        if (!ctrl && !key.meta && pressed && Object.hasOwn(actions, pressed)) {
          return { intent: 'action', action: actions[pressed], row: items[index] ?? null, changed: true };
        }
        // `ctrl+o` folds, and reaches here as a chord rather than a character.
        if (ctrl && name === 'o' && Object.hasOwn(actions, 'ctrl+o')) {
          return { intent: 'action', action: actions['ctrl+o'], row: items[index] ?? null, changed: true };
        }
        return { intent: null, changed: false };
      }
      if (name === 'backspace') {
        if (!text) return { intent: 'close', changed: true };
        text = text.slice(0, -1);
        if (filter) { items = [...filter(text)]; index = 0; offset = 0; }
        return { intent: 'filter', query: text, changed: true };
      }
      if (!ctrl && !key.meta && typeof str === 'string' && str.length === 1 && str >= ' ' && str !== '\x7f') {
        text += str;
        if (filter) { items = [...filter(text)]; index = 0; offset = 0; }
        return { intent: 'filter', query: text, changed: true };
      }
      return { intent: null, changed: false };
    },
  };
}

/** Cells the side-effect class needs, so the label knows how much it may keep.
 * The class is the last thing a narrow row gives up — see the contract note. */
function effectFloor(row, ui) {
  return row?.sideEffect ? displayWidth(ui.stripAnsi(row.sideEffect)) + 1 : 0;
}

/**
 * Modal / action-sheet width. Matches the composer and palette: nearly the full
 * terminal, not a fixed 110-cell postage stamp on a wide window. `maxWidth`
 * remains for tests and rare tight surfaces; product callers leave it unset.
 */
export function overlayBoxWidth(width = 80, maxWidth = null) {
  const cols = Math.max(24, Number(width) || 80);
  // 1-cell side margin keeps the border off the edge without shrinking a lot.
  const room = Math.max(20, cols - 2);
  if (maxWidth == null || maxWidth === Infinity) return room;
  return Math.max(20, Math.min(room, maxWidth));
}

/** Shared box chrome for overlay and walkthrough so borders cannot drift. */
export function overlayBoxChrome(ui, inner) {
  const paint = ui?.paint ? (token, text) => ui.paint(token, text) : (_t, text) => text;
  const b = ui?.unicode
    ? { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' }
    : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };
  return {
    b,
    edge: (l, r) => paint('info', `${l}${b.h.repeat(inner)}${r}`),
    rowOf: (content, tint = null) => {
      const padded = padTo(content, inner);
      const body = ui?.tintRow ? ui.tintRow(tint || 'panel', padded) : padded;
      return `${paint('info', b.v)}${body}${paint('info', b.v)}`;
    },
    divider: () => paint('info', `${b.v}${paint('muted', b.h.repeat(inner))}${b.v}`),
  };
}

export function renderOverlay(overlay, { ui, width = 80, maxWidth = null } = {}) {
  const box = overlayBoxWidth(width, maxWidth);
  const inner = box - 2;
  const { b, edge, rowOf, divider } = overlayBoxChrome(ui, inner);

  const out = [edge(b.tl, b.tr)];

  // The input row: what is being typed, with the caret at the end.
  const prompt = `${ui.paint('info', ui.unicode ? '❯' : '>')} ${overlay.title ? `${ui.paint('muted', `${overlay.title} `)}` : ''}${overlay.query}${ui.paint('info', ui.unicode ? '▏' : '_')}`;
  out.push(rowOf(` ${clipTo(prompt, inner - 2)}`));
  out.push(divider());

  if (!overlay.visible.length) {
    out.push(rowOf(` ${ui.paint('muted', 'nothing matches')}`));
  }
    const nounWidth = overlay.kind === 'palette'
    ? Math.min(12, Math.max(0, ...overlay.visible
        .filter((r) => !(r.unavailable || r.disabled))
        .map((r) => {
          const at = String(r.label ?? '').indexOf(' ');
          return at > 0 ? at : 0;
        })))
    : 0;
  for (const [i, row] of overlay.visible.entries()) {
    const chosen = overlay.offset + i === overlay.index;
    const disabled = Boolean(row.unavailable || row.disabled);
    const effect = row.sideEffect
      ? ui.paint(row.sideEffect === 'read' ? 'ok' : row.sideEffect === 'mutate' ? 'warn' : 'error', row.sideEffect)
      : '';
        const splitLabel = () => {
      if (disabled) return ui.paint('muted', row.label);
      if (overlay.kind !== 'palette') return row.label;
      const at = String(row.label).indexOf(' ');
      const noun = at > 0 ? row.label.slice(0, at) : '';
      const rest = at > 0 ? row.label.slice(at + 1) : row.label;
      const pad = ' '.repeat(Math.max(0, nounWidth - noun.length));
      return noun
        ? `${pad}${ui.paint('muted', noun)}  ${rest}`
        : `${' '.repeat(nounWidth ? nounWidth + 2 : 0)}${rest}`;
    };
    const label = splitLabel();
    const headRoom = Math.max(4, inner - effectFloor(row, ui) - 3);
    const head = ` ${displayWidth(label) > headRoom ? clipTo(label, headRoom - 1).concat(ui.paint('muted', '…')) : label}`;
    const effectCells = effect ? displayWidth(effect) + 1 : 0;
    const room = inner - displayWidth(head) - effectCells - 3;
    const source = row.section
      ? (row.note || '')
      : disabled
        ? (row.reason || row.unavailable || 'unavailable')
        : (row.note || row.summary || '');
    const plainNote = ui.stripAnsi(String(source));
    const clipped = room > 4 ? clipTo(plainNote, room) : '';
    const shownNote = clipped && clipped.length < plainNote.length
      ? `${clipTo(plainNote, room - 1)}…`
      : clipped;
    const paintedNote = shownNote ? ui.paint('muted', shownNote) : '';
    const tail = `${paintedNote}${paintedNote && effect ? ui.paint('muted', ' · ') : ''}${effect}${effect || paintedNote ? ' ' : ''}`;
    let gap = inner - displayWidth(head) - displayWidth(tail);
    let body = `${head}${' '.repeat(Math.max(0, gap))}${tail}`;
    if (gap < 1) {
      const spill = 1 - gap;
      const tighter = clipTo(plainNote, Math.max(0, displayWidth(shownNote) - spill - 1));
      const note2 = tighter ? ui.paint('muted', `${tighter}…`) : '';
      const tail2 = `${note2}${note2 && effect ? ui.paint('muted', ' · ') : ''}${effect}${effect || note2 ? ' ' : ''}`;
      gap = Math.max(1, inner - displayWidth(head) - displayWidth(tail2));
      body = `${head}${' '.repeat(gap)}${tail2}`;
    }
    out.push(rowOf(body, chosen ? 'selected' : null));
  }

  if (overlay.footerText) {
    out.push(divider());
    out.push(rowOf(` ${ui.paint('muted', clipTo(overlay.footerText, inner - 2))}`));
  }
  out.push(edge(b.bl, b.br));
  return out;
}

export function treeRows(node, { ui, prefix = '', last = true, depth = 0 } = {}) {
  const rows = [];
  const stem = depth === 0 ? '' : `${prefix}${last ? (ui.unicode ? '└─ ' : '\\- ') : (ui.unicode ? '├─ ' : '+- ')}`;
  const state = node.status === 'succeeded' || node.status === 'ok' ? 'ok'
    : node.status === 'failed' ? 'error'
      : node.status === 'running' ? 'active' : 'pending';
  const tail = [node.status, node.duration].filter(Boolean).join(' · ');
  rows.push({
    label: `${ui.paint('muted', stem)}${node.label}`,
    note: tail,
    sideEffect: null,
    state,
    node,
  });
  const kids = node.children || [];
  kids.forEach((child, i) => {
    const nextPrefix = depth === 0 ? '' : `${prefix}${last ? '   ' : (ui.unicode ? '│  ' : '|  ')}`;
    rows.push(...treeRows(child, { ui, prefix: nextPrefix, last: i === kids.length - 1, depth: depth + 1 }));
  });
  return rows;
}

export function renderPaletteRows(overlay, { ui, width = 80 } = {}) {
  const rows = overlay.visible;
  if (!rows.length) {
    return [ui.tintRow('panel', padTo(`  ${ui.paint('muted', 'nothing matches')}`, width))];
  }
    // Noun left, human signature muted — never concatenate flags onto the name.
    const labelOf = (r) => {
      const sig = r.signature && !containsFlagSyntax(r.signature) ? String(r.signature).trim() : '';
      if (!sig) return String(r.label ?? '');
      return `${r.label}  ${sig}`;
    };
  const labelW = Math.min(36, Math.max(12, ...rows.map((r) => displayWidth(labelOf(r)))));
  const out = [];
  for (const [i, row] of rows.entries()) {
    const chosen = overlay.offset + i === overlay.index;
    const disabled = Boolean(row.unavailable || row.disabled);
    if (row.section) {
      // A provider heading: the name in the accent, its readiness beside it.
      const head = `  ${ui.paint(row.ready ? 'info' : 'muted', row.label)}${row.note ? ui.paint('muted', `  ${row.note}`) : ''}`;
      out.push(ui.tintRow('panel', padTo(head, width)));
      continue;
    }
    const effect = row.sideEffect
      ? ui.paint(row.sideEffect === 'read' ? 'ok' : row.sideEffect === 'mutate' ? 'warn' : 'error', row.sideEffect)
      : '';
    const effectW = row.sideEffect ? row.sideEffect.length + 1 : 0;
    const plainLabel = clipTo(labelOf(row), labelW);
    const pad = ' '.repeat(Math.max(0, labelW - displayWidth(plainLabel)));
    let labelOut;
    if (disabled) {
      labelOut = ui.paint('muted', plainLabel) + pad;
    } else if (row.signature && plainLabel.startsWith(row.label)) {
      // Keep an explicit gap so "write" + "path · content" never becomes "write--path".
      const rawTail = plainLabel.slice(String(row.label).length).replace(/^\s*/, '');
      const tail = rawTail ? `  ${rawTail}` : '';
      labelOut = `${ui.paint('info', row.label)}${ui.paint('muted', tail)}${pad}`;
    } else {
      labelOut = plainLabel + pad;
    }
    const descRoom = Math.max(8, width - 2 - labelW - 2 - effectW - 1);
    const source = disabled ? (row.reason || row.unavailable || 'unavailable') : (row.note || row.summary || '');
    const plain = ui.stripAnsi(String(source));
    const desc = displayWidth(plain) > descRoom ? `${clipTo(plain, descRoom - 1)}…` : plain;
    const body = `  ${labelOut}  ${ui.paint('muted', desc)}`;
    const gap = Math.max(1, width - displayWidth(body) - effectW);
    const line = `${body}${' '.repeat(gap)}${effect}${effect ? ' ' : ''}`;
    out.push(ui.tintRow(chosen ? 'selected' : 'panel', padTo(line, width)));
  }
  if (overlay.footerText) {
    out.push(ui.tintRow('panel', padTo(`  ${ui.paint('muted', clipTo(overlay.footerText, width - 4))}`, width)));
  }
  return out;
}
