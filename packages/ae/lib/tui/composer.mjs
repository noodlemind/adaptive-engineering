import { displayWidth, graphemes, wrapCells, cellOffset } from './width.mjs';

const UNICODE = { rule: '─', caret: '❯' };
const ASCII = { rule: '-', caret: '>' };

export const DEFAULT_HISTORY_LIMIT = 200;

/** Gate state → the token the hairlines are painted in. Unknown gate reads as
 * muted rather than green: an unverified gate is not a passing one. */
const GATE_TOKEN = {
  pass: 'ok',
  ok: 'ok',
  blocked: 'warn',
  failed: 'error',
  expired: 'warn',
};

/** A control character is a key press, never text. Inserting one is how a raw
 * escape sequence used to end up in the dispatched command. */
const isPrintable = (ch) => typeof ch === 'string' && ch.length >= 1 && ch >= ' ' && ch !== '\x7f';

export function createComposer({
  width = 80,
  ascii = false,
  history = [],
  historyLimit = DEFAULT_HISTORY_LIMIT,
  hint = '',
  gate = null,
  paint = (_token, text) => text,
    paletteChord = 'ctrl+p',

  classify = null,
} = {}) {
  const glyphs = ascii ? ASCII : UNICODE;
    let lines = [[]];
  let row = 0;
  let col = 0;
  const past = [...history];
  let historyIndex = null;
  let draft = null;
  let completion = null;
  /** Right-embedded label on the top rule — mode and posture, the way Claude
   * Code carries the session title in its hairline and Amp carries the mode in
   * its border. A rule is a row already being spent; the label rides free. */
  let ruleLabel = '';

  let bashMode = false;

  // Leading middot avoids the caret glyph colliding with the first letter of
  // "ask" in some terminals (read as a broken box + "sk, or run…").
  const DEFAULT_PLACEHOLDER = '· ask or run a command · / palette';
  let placeholder = DEFAULT_PLACEHOLDER;

  const asText = (clusters) => clusters.join('');
  const clampCursor = () => {
    row = Math.max(0, Math.min(row, lines.length - 1));
    col = Math.max(0, Math.min(col, lines[row].length));
  };
  const setValue = (text) => {
    lines = String(text).split('\n').map((l) => graphemes(l));
    if (!lines.length) lines = [[]];
    row = lines.length - 1;
    col = lines[row].length;
  };
  const insert = (text) => {
    const clusters = graphemes(text);
    lines[row].splice(col, 0, ...clusters);
    col += clusters.length;
    historyIndex = null;
  };

  const currentValue = () => lines.map(asText).join('\n');
  /** As dispatched: rows joined by a space, because a multiline entry is one
   * command typed across several rows, not several commands. */
  const dispatchValue = () => lines.map((l) => asText(l).replace(/\\$/, '').trim()).filter(Boolean).join(' ');

  function recallHistory(direction) {
    if (!past.length) return false;
    if (direction === 'back') {
      if (historyIndex === null) { draft = currentValue(); historyIndex = past.length - 1; }
      else if (historyIndex > 0) historyIndex -= 1;
      else return true;
      setValue(past[historyIndex]);
      return true;
    }
    if (historyIndex === null) return false;
    if (historyIndex < past.length - 1) { historyIndex += 1; setValue(past[historyIndex]); return true; }
    historyIndex = null;
    setValue(draft ?? '');
    draft = null;
    return true;
  }

  function submit() {
    const value = dispatchValue();
    lines = [[]]; row = 0; col = 0; historyIndex = null; draft = null; completion = null;
    if (!value) return { changed: true };
    past.push(value);
    while (past.length > historyLimit) past.shift();
    return { submitted: value, bash: bashMode, changed: true };
  }

  function activeReference() {
    const clusters = lines[row];
    if (col === 0) return null;
    let start = col - 1;
    while (start >= 0 && !/\s/.test(clusters[start])) start -= 1;
    start += 1;
    if (clusters[start] !== '@') return null;
    return { start, end: col, prefix: clusters.slice(start + 1, col).join('') };
  }

  /** Replace the active `@` token with a chosen path. */
  function applyCompletion(pathText) {
    const ref = activeReference();
    if (!ref) return false;
    const replacement = graphemes(`@${pathText}`);
    lines[row].splice(ref.start, ref.end - ref.start, ...replacement);
    col = ref.start + replacement.length;
    completion = null;
    return true;
  }

  const matchesPaletteChord = (name, ctrl, meta) => {
    if (paletteChord === 'ctrl+p') return ctrl && name === 'p';
    if (paletteChord === 'ctrl+k') return ctrl && name === 'k';
    if (paletteChord === 'ctrl+space') return ctrl && name === 'space';
    return ctrl && name === 'p';
  };

  function handleKey(str, key = {}) {
    const name = key.name;
    const ctrl = Boolean(key.ctrl);
    const meta = Boolean(key.meta);
    const shift = Boolean(key.shift);

    if (matchesPaletteChord(name, ctrl, meta)) return { intent: 'palette', changed: false };
    if (meta && name === 'k') return { intent: 'palette', changed: false };
    // The mock's chord, honoured only with an empty line — see `paletteChord`.
    if (ctrl && name === 'k' && !dispatchValue()) return { intent: 'palette', changed: false };
    if (ctrl && name === 'up') return { intent: 'navigate', changed: false };
    if (ctrl && name === 'c') {
      const had = Boolean(dispatchValue());
      lines = [[]]; row = 0; col = 0; historyIndex = null; completion = null;
      return { intent: 'cancel', hadInput: had, changed: true };
    }
    if (ctrl && name === 'd') {
      if (dispatchValue()) return { changed: false };
      return { intent: 'exit', changed: false };
    }
    if (ctrl && name === 'a') { col = 0; return { changed: true }; }
    if (ctrl && name === 'e') { col = lines[row].length; return { changed: true }; }
    if (ctrl && name === 'u') { lines[row] = lines[row].slice(col); col = 0; return { changed: true }; }
    if (ctrl && name === 'k') { lines[row] = lines[row].slice(0, col); return { changed: true }; }
    if (ctrl && name === 'o') return { intent: 'fold', changed: false };
    if (ctrl && name === 'l') return { intent: 'clear', changed: false };
    if (ctrl && name === 'j') {
      const rest = lines[row].slice(col);
      lines[row] = lines[row].slice(0, col);
      lines.splice(row + 1, 0, rest);
      row += 1; col = 0;
      return { changed: true };
    }

    if (name === 'escape' && bashMode) {
      bashMode = false;
      return { intent: 'bash-mode', changed: true };
    }

    if (name === 'escape') {
      return { intent: 'escape', changed: false };
    }

    if (completion?.items?.length) {
      if (name === 'up') { completion.index = (completion.index - 1 + completion.items.length) % completion.items.length; return { changed: true }; }
      if (name === 'down') { completion.index = (completion.index + 1) % completion.items.length; return { changed: true }; }
      if (name === 'tab' || name === 'return' || name === 'enter') {
        const chosen = completion.items[completion.index];
        if (chosen && applyCompletion(chosen.path ?? chosen)) return { changed: true };
      }
    }
    if (name === 'tab' && shift) return { intent: 'agent-mode', changed: false };
    if (name === 'tab') {
      const ref = activeReference();
      if (ref) return { intent: 'complete', prefix: ref.prefix, changed: false };
    }

    switch (name) {
      case 'return':
      case 'enter': {
        if (shift || meta || asText(lines[row]).endsWith('\\')) {
          const rest = lines[row].slice(col);
          lines[row] = lines[row].slice(0, col);
          lines.splice(row + 1, 0, rest);
          row += 1; col = 0;
          return { changed: true };
        }
        return submit();
      }
      case 'backspace':
        if (col > 0) { lines[row].splice(col - 1, 1); col -= 1; }
        else if (row > 0) { const merged = lines[row]; lines.splice(row, 1); row -= 1; col = lines[row].length; lines[row] = [...lines[row], ...merged]; }
        completion = null;
        return { changed: true };
      case 'delete':
        if (col < lines[row].length) lines[row].splice(col, 1);
        else if (row < lines.length - 1) { lines[row] = [...lines[row], ...lines[row + 1]]; lines.splice(row + 1, 1); }
        return { changed: true };
      case 'left':
        if (col > 0) col -= 1;
        else if (row > 0) { row -= 1; col = lines[row].length; }
        return { changed: true };
      case 'right':
        if (col < lines[row].length) col += 1;
        else if (row < lines.length - 1) { row += 1; col = 0; }
        return { changed: true };
      case 'up':
                if (row > 0) { row -= 1; clampCursor(); return { changed: true }; }
        return { changed: recallHistory('back') };
      case 'down':
        if (row < lines.length - 1) { row += 1; clampCursor(); return { changed: true }; }
        return { changed: recallHistory('forward') };
      case 'home': col = 0; return { changed: true };
      case 'end': col = lines[row].length; return { changed: true };
      default: break;
    }

    if (!ctrl && !meta && isPrintable(str)) {
      const atStartOfEmptyLine = row === 0 && col === 0 && lines.length === 1 && lines[0].length === 0;
      if (str === '/' && atStartOfEmptyLine && !bashMode) {
        return { intent: 'palette', changed: false };
      }
      // The sigil is consumed by the mode it opens, exactly as `/` is.
      if (str === '!' && atStartOfEmptyLine && !bashMode) {
        bashMode = true;
        return { intent: 'bash-mode', changed: true };
      }
      insert(str);
      completion = null;
      const ref = activeReference();
      if (ref) return { intent: 'complete', prefix: ref.prefix, changed: true };
      return { changed: true };
    }
    return { changed: false };
  }

  function render() {
    const caret = `${glyphs.caret} `;
    const caretCells = displayWidth(caret);
    const inner = Math.max(8, width - caretCells);
    const token = GATE_TOKEN[gate] ?? 'muted';
    const rule = paint(token, glyphs.rule.repeat(Math.max(1, width)));
    let topRule = rule;
    if (ruleLabel) {
      const tail = ` ${ruleLabel} `;
      const lead = Math.max(1, width - displayWidth(tail) - 2);
      topRule = paint(token, glyphs.rule.repeat(lead)) + paint('muted', tail) + paint(token, glyphs.rule.repeat(2));
    }

    const body = [];
    const empty = lines.length === 1 && lines[0].length === 0;
    // Always end caret with a space so the placeholder never sits under the glyph.
    const caretOut = bashMode
      ? paint('warn', '! ')
      : paint('info', `${glyphs.caret} `);
    if (empty) {
      const ph = bashMode ? '· shell command · esc leaves bash' : placeholder;
      body.push(`${caretOut}${paint('muted', ph)}`);
    } else {
      lines.forEach((clusters, i) => {
        const text = asText(clusters);
        const wrapped = wrapCells(text, inner);
        wrapped.forEach((piece, j) => {
          const prefix = i === 0 && j === 0 ? caretOut : ' '.repeat(caretCells);
          const shown = i === 0 && wrapped.length === 1 ? highlight(piece) : piece;
          body.push(`${prefix}${shown}`);
        });
      });
    }

    const out = [topRule, ...body, rule];
    if (completion?.items?.length) out.push(...renderCompletion());
    if (hint) out.push(hint);
    return out;
  }

  function highlight(text) {
    if (bashMode) return text; // the shell owns this grammar, not the registry
    if (!classify || !text) return text;
    const sigil = /^(!!|!|@|\/)/.exec(text);
    if (sigil) {
      return `${paint('info', sigil[1])}${text.slice(sigil[1].length)}`;
    }
    const head = (text.trim().split(/\s+/)[0] || '');
    let index = -1;
    return text.replace(/\S+/g, (word) => {
      index += 1;
      const kind = classify(word, { first: index === 0, head });
      if (kind === 'command' || kind === 'session') return paint('info', word);
      if (kind === 'verb') return paint('ok', word);
      if (kind === 'flag') return paint('warn', word);
      return word;
    });
  }

  /** The `@` list, drawn under the editor as an inline chooser rather than an
   * overlay: it is a refinement of what is already being typed, so moving the
   * eye somewhere else to pick would be the wrong gesture. */
  function renderCompletion() {
    const items = completion.items.slice(0, 6);
    return items.map((item, i) => {
      const path = item.path ?? item;
      const chosen = i === completion.index;
      const mark = chosen ? paint('info', ascii ? '>' : '❯') : ' ';
      const note = item.kind ? paint('muted', ` · ${item.kind}`) : '';
      return `${mark} ${chosen ? path : paint('muted', path)}${note}`;
    });
  }

  return {
    handleKey,
    render,
    get value() { return currentValue(); },
    get lines() { return lines.map(asText); },
    get height() { return render().length; },
    get history() { return [...past]; },
    get reference() { return activeReference(); },
    get completionOpen() { return Boolean(completion?.items?.length); },
    /** Where the terminal cursor belongs, relative to the block's first line.
     * Row 0 is the top rule, so the text starts at 1. */
    get cursor() {
      const caretCells = displayWidth(`${glyphs.caret} `);
      const inner = Math.max(8, width - caretCells);
      let y = 1;
      for (let i = 0; i < row; i += 1) y += wrapCells(asText(lines[i]), inner).length;
      const cells = cellOffset(asText(lines[row]), col);
      y += Math.floor(cells / inner);
      return { row: y, col: caretCells + (cells % inner) };
    },
    setWidth(next) { width = Math.max(24, next); },
    setHint(next) { hint = next; },
    setRuleLabel(next) { ruleLabel = String(next ?? ''); },
    setPlaceholder(next) { placeholder = next == null ? DEFAULT_PLACEHOLDER : String(next); },
    get bashMode() { return bashMode; },
    setBashMode(on) { bashMode = Boolean(on); },
    setGate(next) { gate = next; },
    setCompletion(items) {
      completion = items?.length ? { items, index: 0 } : null;
    },
    clearCompletion() { completion = null; },
    setValue,
  };
}
