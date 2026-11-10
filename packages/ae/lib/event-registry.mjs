import fs from 'node:fs';
import path from 'node:path';
import { createRedactor } from './redact.mjs';
import { pkgRootFromImportMeta } from './paths.mjs';
import { parseFlags } from './flags.mjs';
import { writeEvent as writeHarnessEvent } from './events.mjs';

const PKG_ROOT = pkgRootFromImportMeta(import.meta.url);

function readDefaultHarnessVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

export const EVENT_TYPE = Object.freeze({
  COMMAND_START: 'command.start',
  COMMAND_RESULT: 'command.result',
  AGENT_LANE: 'agent_lane',
  CONTEXT_ACCOUNTING: 'context.accounting',
});

export function detectActor(env = process.env) {
  if (env.CI || env.GITHUB_ACTIONS) return { kind: 'ci' };
  if (env.HARNESS_HOST) return { kind: 'host', host: env.HARNESS_HOST };
  return { kind: 'user' };
}

export function summarizeArgFlags(argv = [], knownFlags = null) {
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (typeof token !== 'string') continue;
    if (token === '--') break; // literal-argument boundary — nothing past this is a flag
    if (!token.startsWith('-') || token === '-') continue; // positional / bare '-'
    const eq = token.indexOf('=');
    const flagName = eq === -1 ? token : token.slice(0, eq);
    names.push(flagName);
    if (eq !== -1) continue; // inline `--flag=value` — nothing to look ahead for

    const next = argv[i + 1];
    const nextLooksLikeValue = next !== undefined && typeof next === 'string' && !next.startsWith('--');
    const def = knownFlags ? knownFlags.get(flagName) : undefined;
    // A literal-valued flag takes the next token whatever it looks like, as
    // validateArgs and commandHelpRequested read it, so a dash-led value is
    // never recorded as a flag name.
    const consumesNext = def
      ? def.type !== 'boolean' && typeof next === 'string' && (def.valueIsLiteral === true || nextLooksLikeValue)
      : nextLooksLikeValue;
    if (consumesNext) i++; // skip the value — never inspected as a potential name
  }
  return names;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertEventType(type, who) {
  if (typeof type !== 'string' || !type) {
    throw new TypeError(`${who}: type (string) is required`);
  }
}

export function createEventRegistry({
  writeEvent,
  redactor = createRedactor(),
  actor = detectActor(),
  clock = () => new Date().toISOString(),
  pid = process.pid,
  harnessVersion = readDefaultHarnessVersion(),
    run = null,
} = {}) {
  if (typeof writeEvent !== 'function') {
    throw new TypeError('createEventRegistry: writeEvent(payload) function is required');
  }

    function persist(type, payload, command) {
    const safePayload = redactor.redactValue(isPlainObject(payload) ? payload : {});
    const event = {
      type,
      ts: clock(),
      actor,
      ...(run ? { run } : {}),
      ...(command ? { command } : {}),
      ...safePayload,
    };
    if (type === EVENT_TYPE.COMMAND_START) {
      event.execution = { pid, harnessVersion };
    }
    return writeEvent(event);
  }

  function emit(type, payload = {}) {
    assertEventType(type, 'createEventRegistry.emit');
    return persist(type, payload, undefined);
  }

  /** A command-scoped emitter: every event it produces carries `command`
   * automatically, for the duration of one command's dispatch. */
  function withCommand(command) {
    if (typeof command !== 'string' || !command) {
      throw new TypeError('createEventRegistry.withCommand: command (string) is required');
    }
    return {
      emit(type, payload = {}) {
        assertEventType(type, 'createEventRegistry.withCommand(...).emit');
        return persist(type, payload, command);
      },
    };
  }

  return { emit, withCommand };
}

export function createProcessEventRegistry(rawArgs, run, { recordWorkspace = null } = {}) {
  const flags = parseFlags(rawArgs);
  const workspace = path.resolve(recordWorkspace || flags.workspace);
  return createEventRegistry({
    run,
    writeEvent: (payload) => writeHarnessEvent(workspace, flags, payload),
  });
}
