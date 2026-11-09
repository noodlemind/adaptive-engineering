import { createRedactor } from './redact.mjs';

// Stable exit codes — the agent contract. Values are append-only.
export const EXIT = Object.freeze({
  ok: 0,
  usage: 2,
  notInitialized: 3,
  needsApproval: 4,
  syncConflict: 5,
  doctorFailed: 6,
  network: 7,
  interrupted: 130,
    cancelled: 130,
    timedOut: 8,
    notFound: 9,
});

// token → [truecolor rgb, 256-color index]
const PALETTE = {
  ok: [[134, 201, 154], 114], // #86c99a — success, nominal, done
  warn: [[217, 164, 65], 179], // #d9a441 — attention, stale, degraded
  error: [[217, 124, 116], 174], // #d97c74 — failure, blocked, expired
  info: [[127, 166, 207], 110], // #7fa6cf — keys & fields in machine surface
  muted: [[111, 110, 105], 243], // #6f6e69 — notes, next actions, chrome
};

const PALETTE_CVD = {
  ok: [[86, 180, 233], 74], // sky blue — Okabe-Ito, the reference CVD-safe set
  warn: [[230, 159, 0], 214], // amber, unchanged in role and clearly warmer
  error: [[213, 94, 0], 166], // vermilion — darker and redder than warn
  info: [[0, 158, 115], 36], // bluish green, distinct from `ok` by lightness
  muted: [[111, 110, 105], 243], // unchanged: grey is grey to everyone
};

// state → [unicode glyph, ascii twin, paint token]
const GLYPHS = {
  ok: ['✓', '[ok]', 'ok'],
  warn: ['!', '[!]', 'warn'],
  error: ['✗', '[x]', 'error'],
  active: ['◐', '-', 'warn'],
  pending: ['·', '.', 'muted'],
};

const TINTS = {
    user: { dark: [28, 31, 35], light: [244, 243, 239], idx256: { dark: 234, light: 254 }, token: 'muted' },
  running: { dark: [27, 33, 40], light: [238, 241, 246], idx256: { dark: 236, light: 253 }, token: 'info' },
  ok: { dark: [26, 32, 33], light: [240, 245, 241], idx256: { dark: 235, light: 254 }, token: 'ok' },
  failed: { dark: [34, 30, 33], light: [248, 240, 239], idx256: { dark: 237, light: 252 }, token: 'error' },
  cancelled: { dark: [24, 26, 30], light: [246, 245, 241], idx256: { dark: 233, light: 255 }, token: 'muted' },
    panel: { dark: [23, 27, 32], light: [245, 244, 240], idx256: { dark: 234, light: 254 }, token: 'muted' },
  selected: { dark: [33, 41, 50], light: [228, 234, 242], idx256: { dark: 238, light: 251 }, token: 'info' },
};

/** The left stripe. Present on every block so the gutter is column-stable;
 * painted in the state's own token so it reads without the tint behind it. */
const STRIPE = { unicode: '▌', ascii: '|' };

function detectGround({ env }) {
  const raw = String(env.COLORFGBG || '');
  if (!raw) return 'dark';
  const bg = Number(raw.split(';').pop());
  if (!Number.isInteger(bg)) return 'dark';
    if (bg === 7 || bg === 15 || bg >= 250) return 'light';
  return 'dark';
}

const ASCII_GLYPH_WIDTH = 4; // '[ok]' — the widest twin

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function detectColor({ stream, env, argv, platform }) {
    const boundary = argv.indexOf('--');
  const flagArgs = boundary === -1 ? argv : argv.slice(0, boundary);
  if (flagArgs.includes('--no-color')) return 'none';
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  if (!stream || !stream.isTTY) return 'none';
  if (env.TERM === 'dumb') return 'none';
  if (/truecolor|24bit/i.test(env.COLORTERM || '')) return 'truecolor';
  if (/-256color$/i.test(env.TERM || '')) return '256';
    if (platform === 'win32') {
    if (env.WT_SESSION) return 'truecolor'; // Windows Terminal
    if (env.TERM_PROGRAM) return 'truecolor'; // VS Code, and others that say so
    if (/^on$/i.test(env.ConEmuANSI || '')) return '256'; // ConEmu / Cmder
  }
  return 'none'; // degrade honestly — never fake a capability the terminal didn't declare
}

function detectUnicode({ env, platform, color }) {
  if (color === 'none') return false; // the ascii surface is the no-color surface
  if (platform === 'win32') return Boolean(env.WT_SESSION || env.TERM_PROGRAM);
  return /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '');
}

export function createStyle({
  stream = process.stdout,
  env = process.env,
  argv = process.argv.slice(2),
  platform = process.platform,
  redactor,
    tintMode = 'auto',
  /** `default` | `colorblind` — which semantic palette carries state. */
  scheme = 'default',
} = {}) {
  const color = detectColor({ stream, env, argv, platform });
  const unicode = detectUnicode({ env, platform, color });
  const ground = tintMode === 'dark' || tintMode === 'light' ? tintMode : detectGround({ env });
  const palette = scheme === 'colorblind' ? PALETTE_CVD : PALETTE;
  const tintsOn = tintMode !== 'off' && color !== 'none';
    const activeRedactor = redactor || createRedactor({ env });
  const scrub = (text) => (typeof text === 'string' && text ? activeRedactor.redactText(text) : text);

  function paint(token, text) {
    const safe = scrub(text);
    const entry = palette[token];
    if (!entry || color === 'none') return safe;
    const open =
      color === 'truecolor'
        ? `\x1b[38;2;${entry[0][0]};${entry[0][1]};${entry[0][2]}m`
        : `\x1b[38;5;${entry[1]}m`;
        return `${open}${safe}\x1b[39m`;
  }

  function glyph(state) {
    const g = GLYPHS[state];
    if (!g) return '';
    return paint(g[2], unicode ? g[0] : g[1]);
  }

    function glyphGutter(state) {
    const g = GLYPHS[state];
    if (!g) return '';
    const raw = unicode ? g[0] : g[1];
    const pad = ' '.repeat((unicode ? 1 : ASCII_GLYPH_WIDTH) - raw.length);
    return `${paint(g[2], raw)}${pad}  `;
  }

  const arrow = unicode ? '→' : '->';

  function line({ state, key, value = '', note, next, keyWidth = 10 }) {
    let out = state ? glyphGutter(state) : '';
    out += `${String(key).padEnd(keyWidth)}  `;
    out += value;
    if (note) out += paint('muted', ` · ${note}`);
    if (next) out += paint('muted', ` ${arrow} ${next}`);
    return scrub(out.trimEnd());
  }

  /** The closing tally: "2 ok · 1 warn · 1 err → exit 6", all muted. */
  function summary({ ok = 0, warn = 0, err = 0, exit = 0 }) {
    const parts = [`${ok} ok`];
    if (warn) parts.push(`${warn} warn`);
    if (err) parts.push(`${err} err`);
    return paint('muted', `${parts.join(' · ')} ${arrow} exit ${exit}`);
  }

  /** Error & recovery block: code, plain message, one fix, optional docs. */
  function errorBlock({ code, message, fix, docs, exit = 1 }) {
    const lines = [`${glyph('error')} ${paint('error', code)}`];
    if (message) lines.push(`  ${scrub(String(message))}`);
    if (fix) lines.push(paint('muted', `  ${arrow} fix   ${fix}`));
    if (docs) lines.push(paint('muted', `  ${arrow} docs  ${docs}`));
    lines.push(paint('muted', `  exit ${exit}`));
    return lines;
  }

  function stripAnsi(text) {
    return text.replace(ANSI_RE, '');
  }

  function tintRow(state, paddedRow) {
    const entry = TINTS[state];
    if (!entry || !tintsOn) return paddedRow;
    const open = color === 'truecolor'
      ? `\x1b[48;2;${entry[ground][0]};${entry[ground][1]};${entry[ground][2]}m`
      : `\x1b[48;5;${entry.idx256[ground]}m`;
        return `${open}${paddedRow}\x1b[0m`;
  }

  function stripe(state) {
    const entry = TINTS[state];
    const mark = unicode ? STRIPE.unicode : STRIPE.ascii;
    if (!entry) return ' ';
    return paint(entry.token, mark);
  }

  return {
    color,
    unicode,
    arrow,
    ground,
    tints: tintsOn,
    paint,
    glyph,
    line,
    summary,
    errorBlock,
    stripAnsi,
    tintRow,
    stripe,
  };
}

/** The tint states, exported so a caller cannot invent one the renderer would
 * silently drop. */
export const BLOCK_STATES = Object.freeze(Object.keys(TINTS));

/** Fixed key gutter for a set of rows so columns hold across a command. */
export function keyWidthFor(keys, min = 10) {
  return Math.max(min, ...[...keys].map((k) => String(k).length));
}

export function clampNote(text, max = 160) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}… (--verbose for full)`;
}
