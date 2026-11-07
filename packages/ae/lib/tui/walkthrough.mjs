/** First-run / replay Adaptive Engineering story. Session chrome, not a kernel command. */

import { overlayBoxChrome, overlayBoxWidth } from './overlay.mjs';
import { clipTo, displayWidth, wrapCells } from './width.mjs';

export const WALKTHROUGH_SEEN_KEY = 'walkthrough.seen';

export const WALKTHROUGH_BEATS = Object.freeze([
  {
    title: 'Adaptive Engineering',
    footer: 'Enter next · ← → · Esc skip',
    body: Object.freeze([
      'This is the evidence-governed kernel behind @engineer. The model may be stochastic. Delivery is not: intent is locked, mutation is gated, "done" requires fresh proof, and only proven work is allowed to become team memory.',
    ]),
  },
  {
    title: 'The loop that compounds',
    footer: 'Enter next · ← → · Esc skip',
    body: Object.freeze([
      'Each Deliver pass runs the same contract:',
      '',
      'orient → lock intent → gate → work → verify → compound → index',
      '',
      'You watch it on this ledger. Plan and gate are the live chips in the header. Orient, verify, and compound run in the kernel — they are not chores you type here. The next task can recall only what this one proved. That is what makes the engineer adaptive.',
    ]),
  },
  {
    title: 'Almost none of this is yours to run',
    footer: 'Enter start · ← · Esc close',
    body: Object.freeze([
      'In VS Code or GitHub Copilot Chat, open the agent dropdown and pick @engineer. Answer, Investigate, and Review stay read-only. Deliver is the only mode that mutates. Behind the scenes the kernel orients, gates, verifies, and auto-compounds after a green verify.',
      '',
      'You only touch this UI when:',
      '',
      'First install — reload VS Code so the Copilot bridge loads.',
      'New product repo — palette Initialize this repo if there is no plan/checks scaffolding.',
      'After a win — ask @engineer to compound if you want a deliberate write-up, or auto-compound did not fire.',
      'As HEAD grows — run Index (palette) or ae index when knowledge is behind the current commit.',
    ]),
  },
]);

const INSTALL_LINE = 'Copilot assets and the editor bridge were installed.';

function lastBeatIndex() {
  return WALKTHROUGH_BEATS.length - 1;
}

export function createWalkthrough({ hydrated = false } = {}) {
  let beat = 0;
  return {
    kind: 'walkthrough',
    hydrated: Boolean(hydrated),
    get beat() { return beat; },
    handleKey(str, key = {}) {
      const name = key.name;
      const ctrl = Boolean(key.ctrl);
      if (name === 'escape' || (ctrl && name === 'c')) {
        return { intent: 'dismiss', changed: true };
      }
      if (name === 'left' || name === 'up') {
        if (beat === 0) return { intent: null, changed: false };
        beat -= 1;
        return { intent: 'prev', changed: true };
      }
      const advance = name === 'right' || name === 'down'
        || name === 'return' || name === 'enter'
        || name === 'space' || str === ' ';
      if (!advance) return { intent: null, changed: false };
      if (name === 'right' || name === 'down') {
        if (beat >= lastBeatIndex()) return { intent: null, changed: false };
        beat += 1;
        return { intent: 'next', changed: true };
      }
      if (beat >= lastBeatIndex()) return { intent: 'complete', changed: true };
      beat += 1;
      return { intent: 'next', changed: true };
    },
  };
}

export function attachWalkthroughOverlay(wt, { onClose } = {}) {
  return {
    kind: 'walkthrough',
    get title() { return ''; },
    get query() { return ''; },
    get beat() { return wt.beat; },
    get hydrated() { return wt.hydrated; },
    handleKey(str, key) {
      const result = wt.handleKey(str, key);
      if (result.intent === 'dismiss' || result.intent === 'complete') {
        try { onClose?.(result.intent); } catch { /* persist must not crash the session */ }
        return { intent: 'close', changed: true };
      }
      return { intent: null, changed: Boolean(result.changed) };
    },
  };
}

export function walkthroughLines({ hydrated = false } = {}) {
  const lines = [];
  for (const [i, spec] of WALKTHROUGH_BEATS.entries()) {
    if (i > 0) lines.push('');
    lines.push(spec.title);
    for (const paragraph of spec.body) lines.push(paragraph);
    if (i === 0 && hydrated) lines.push(INSTALL_LINE);
  }
  return lines;
}

function beatBodyLines(spec, { hydrated = false, beat = 0, width = 80 } = {}) {
  const lines = [];
  for (const paragraph of spec.body) {
    if (!paragraph) { lines.push(''); continue; }
    lines.push(...wrapCells(String(paragraph), width));
  }
  if (hydrated && beat === 0) {
    lines.push('');
    lines.push(INSTALL_LINE);
  }
  return lines;
}

function stableBodyHeight({ hydrated = false, width = 80 } = {}) {
  let max = 0;
  for (const [i, spec] of WALKTHROUGH_BEATS.entries()) {
    max = Math.max(max, beatBodyLines(spec, { hydrated, beat: i, width }).length);
  }
  return max;
}

export function renderWalkthrough(wt, { ui, width = 80 } = {}) {
  const spec = WALKTHROUGH_BEATS[wt.beat] || WALKTHROUGH_BEATS[0];
  const paint = ui?.paint ? (token, text) => ui.paint(token, text) : (_t, text) => text;
  const box = overlayBoxWidth(width);
  const inner = box - 2;
  const textWidth = Math.max(20, inner - 2);
  const body = beatBodyLines(spec, { hydrated: wt.hydrated, beat: wt.beat, width: textWidth });
  const height = stableBodyHeight({ hydrated: wt.hydrated, width: textWidth });
  while (body.length < height) body.push('');

  const { b, edge, rowOf, divider } = overlayBoxChrome(ui, inner);

  const progress = `${(wt.beat ?? 0) + 1}/${WALKTHROUGH_BEATS.length}`;
  const titlePlain = String(spec.title);
  const titleRoom = Math.max(8, inner - 2 - progress.length - 2);
  const titleText = displayWidth(titlePlain) > titleRoom ? clipTo(titlePlain, titleRoom - 1).concat('…') : titlePlain;
  const titleGap = Math.max(1, inner - 2 - displayWidth(titleText) - progress.length);
  const titleRow = ` ${paint('info', titleText)}${' '.repeat(titleGap)}${paint('muted', progress)} `;

  const out = [edge(b.tl, b.tr), rowOf(titleRow), divider()];
  for (const line of body) {
    out.push(rowOf(line ? ` ${paint('muted', clipTo(line, textWidth))}` : ''));
  }
  out.push(divider());
  out.push(rowOf(` ${paint('muted', clipTo(spec.footer, textWidth))}`));
  out.push(edge(b.bl, b.br));
  return out;
}

export function shouldAutoOpenWalkthrough({ interactive = false, screenReader = false, seen = false } = {}) {
  if (seen) return null;
  if (screenReader) return 'lines';
  if (interactive) return 'overlay';
  return null;
}
