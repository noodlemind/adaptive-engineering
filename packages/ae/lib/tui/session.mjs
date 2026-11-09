export function tokenize(line) {
  const argv = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const ch of String(line)) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current) argv.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) {
    throw Object.assign(new Error(`unterminated ${quote === '"' ? 'double' : 'single'} quote`), {
      code: 'E_USAGE', exit: 2, hint: 'close the quote, or drop it',
    });
  }
  if (started || current) argv.push(current);
  return argv;
}

const CONTROL_SEQUENCES = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripControl(text) {
  return String(text ?? '').replace(CONTROL_SEQUENCES, '');
}

const SESSION_WORDS = Object.freeze({
  exit: 'exit',
  quit: 'exit',
  help: 'help',
  '?': 'help',
  clear: 'clear',
  results: 'results',
  hits: 'results',
  walkthrough: 'walkthrough',
  tour: 'walkthrough',
});

/** Product verbs that compile to registry argv (host-first TUX). */
const AGENT_MODE_WORDS = Object.freeze({
  'agent on': { kind: 'agent-mode-set', enabled: true },
  'agent off': { kind: 'agent-mode-set', enabled: false },
  '/agent on': { kind: 'agent-mode-set', enabled: true },
  '/agent off': { kind: 'agent-mode-set', enabled: false },
});

const HOST_MODE_WORDS = Object.freeze({
  'mode commands': { kind: 'host-mode-set', mode: 'commands' },
  'mode assist': { kind: 'host-mode-set', mode: 'assist' },
  'mode plan': { kind: 'host-mode-set', mode: 'plan' },
  '/mode commands': { kind: 'host-mode-set', mode: 'commands' },
  '/mode assist': { kind: 'host-mode-set', mode: 'assist' },
  '/mode plan': { kind: 'host-mode-set', mode: 'plan' },
});

/** `replay` and `replay <id>` — re-run a block by name rather than by sigil. */
const REPLAY_WORDS = new Set(['replay', 'rerun', 're-run']);

export function interpretLine(rawLine) {
  const line = stripControl(rawLine).trim();
  if (!line) return { kind: 'empty' };

  const lower = line.toLowerCase();
  const agentVerb = AGENT_MODE_WORDS[lower];
  if (agentVerb) return { ...agentVerb };
  const modeVerb = HOST_MODE_WORDS[lower];
  if (modeVerb) return { ...modeVerb };

  // Gate menu (Grok-style approve / comment / quit)
  if (lower === 'gate menu' || lower === '/gate' || lower === 'gate actions') {
    return { kind: 'gate-menu' };
  }

  // Inspect product verbs
  const inspectMatch = lower.match(/^\/?inspect(?:\s+(config|permissions|workspace|tools))?(?:\s+(\S+))?$/);
  if (inspectMatch) {
    return {
      kind: 'inspect',
      verb: inspectMatch[1] || 'config',
      key: inspectMatch[2] || null,
    };
  }

  // Session recovery via run journal
  if (lower === 'runs' || lower === '/runs' || lower === 'run list' || lower === '/resume') {
    return { kind: 'runs-list' };
  }
  const resumeMatch = lower.match(/^(?:\/?resume|run resume)\s+(\S+)$/);
  if (resumeMatch) return { kind: 'runs-resume', id: resumeMatch[1] };

  // Demo question checkpoint: question "prompt" | a | b | c
  if (lower.startsWith('question ') || lower.startsWith('/question ')) {
    const body = line.replace(/^\/?question\s+/i, '');
    const parts = body.split('|').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return {
        kind: 'ask-question',
        prompt: parts[0],
        choices: parts.slice(1),
      };
    }
    return {
      kind: 'ask-question',
      prompt: body || 'Choose an option',
      choices: ['yes', 'no', 'skip'],
    };
  }

  const sessionKey = line.startsWith('/') ? line.slice(1).trim() : line;
  if (Object.hasOwn(SESSION_WORDS, sessionKey) && !sessionKey.includes(' ')) {
    return { kind: SESSION_WORDS[sessionKey] };
  }

  // `replay`, `replay <id>` — with or without a leading slash.
  const replayParts = sessionKey.split(/\s+/);
  if (REPLAY_WORDS.has(replayParts[0])) {
    const target = replayParts[1] ? replayParts[1].replace(/^#/, '') : null;
    if (!target) return { kind: 'rerun', target: null };
    if (/^[0-9a-z]+(-[0-9a-z]+)*$/i.test(target) && target.replace(/-/g, '').length >= 4) {
      return { kind: 'rerun', target };
    }
    return {
      kind: 'invalid',
      reason: `replay takes a block id, and ${JSON.stringify(target)} is not one`,
      hint: 'replay on its own repeats the last block; replay <id> takes an id from a record line',
    };
  }

    if (line.startsWith('!!')) {
    const target = line.slice(2).trim();
    if (!target) return { kind: 'rerun', target: null };
    if (/^[0-9a-z]+(-[0-9a-z]+)*$/i.test(target) && target.replace(/-/g, '').length >= 4) {
      return { kind: 'rerun', target };
    }
    return {
      kind: 'invalid',
      reason: `!! re-runs a block, and ${JSON.stringify(target)} is not a block id`,
      hint: 'use !! on its own for the last block, or !! <id> from the record line',
    };
  }
  if (line.startsWith('!')) {
    const script = line.slice(1).trim();
    // Bare `!` enters bash mode in the composer; that path is handled by input.
    // `!cmd` runs one governed script.
    if (!script) return { kind: 'bash-enter' };
    return { kind: 'shell', script };
  }

  // Bare product verbs — friendlier than kernel usage walls.
  if (lower === 'bash') return { kind: 'bash-enter' };
  if (lower === 'tree' || lower === 'tree workspace') {
    return { kind: 'command', argv: ['tree', 'workspace'] };
  }
  if (lower === 'tree knowledge') {
    return { kind: 'command', argv: ['tree', 'knowledge'] };
  }
  // `tree src` / `tree lib/foo` → workspace tree scoped to that path
  if (lower.startsWith('tree ')) {
    const rest = line.slice(5).trim();
    if (rest === 'workspace' || rest === 'knowledge') {
      return { kind: 'command', argv: ['tree', rest] };
    }
    if (rest) return { kind: 'command', argv: ['tree', 'workspace', rest] };
  }

  if (line.startsWith('/')) {
    return { kind: 'palette', query: line.slice(1).trim() };
  }

  if (line.startsWith('@')) {
    return { kind: 'reference', target: line.slice(1).trim() };
  }

  try {
    return { kind: 'command', argv: tokenize(line) };
  } catch (error) {
    return { kind: 'invalid', reason: error.message, hint: error.hint };
  }
}

export function createTally() {
  const counts = { commands: 0, ok: 0, failed: 0, cancelled: 0 };
  return {
    record(exitCode, { cancelled = false } = {}) {
      counts.commands += 1;
      if (cancelled) counts.cancelled += 1;
      else if (exitCode === 0) counts.ok += 1;
      else counts.failed += 1;
      return counts;
    },
    snapshot() {
      return { ...counts };
    },
  };
}
