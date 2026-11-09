import { EXIT } from './style.mjs';
import { createRedactor, redactedJson } from './redact.mjs';

export const ENVELOPE_SCHEMA_VERSION = 1;

export const STATUS = Object.freeze({
  OK: 'ok',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed-out',
  BLOCKED: 'blocked',
});

export const STATUS_VALUES = Object.freeze(Object.values(STATUS));

function assertKnownStatus(status, who) {
  if (!STATUS_VALUES.includes(status)) {
    throw new TypeError(`${who}: unknown status ${JSON.stringify(status)} (expected ${STATUS_VALUES.join(' | ')})`);
  }
}

const STATUS_EXIT_CODES = Object.freeze({
  [STATUS.OK]: EXIT.ok,
  [STATUS.CANCELLED]: EXIT.cancelled,
  [STATUS.TIMED_OUT]: EXIT.timedOut,
});

/** Exit code for a status, when the caller has no more specific one. */
export function exitForStatus(status, fallback = 1) {
  return STATUS_EXIT_CODES[status] ?? fallback;
}

function isScalarValue(value) {
  return value === null || value === undefined || (typeof value !== 'object' && typeof value !== 'function');
}

export function splitScalarsAndDetails(data) {
  const scalars = {};
  const details = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (isScalarValue(value)) scalars[key] = value;
    else details[key] = value;
  }
  return { scalars, details };
}

export function createEnvelope({ command, schema = ENVELOPE_SCHEMA_VERSION, status = STATUS.OK, ...data } = {}) {
  if (!command || typeof command !== 'string') {
    throw new TypeError('createEnvelope: command (string) is required');
  }
  assertKnownStatus(status, 'createEnvelope');
  const { scalars, details } = splitScalarsAndDetails(data);
  return { schema, command, status, ...scalars, ...details };
}

export function createErrorEnvelope({
  command,
  schema = ENVELOPE_SCHEMA_VERSION,
  status = STATUS.FAILED,
  code,
  message,
  fix,
  exit,
} = {}) {
  if (!command || typeof command !== 'string') {
    throw new TypeError('createErrorEnvelope: command (string) is required');
  }
  assertKnownStatus(status, 'createErrorEnvelope');
  if (!code || typeof code !== 'string') {
    throw new TypeError('createErrorEnvelope: error.code (string) is required');
  }
  const error = { code, message: message ?? '' };
  if (fix !== undefined && fix !== null) error.fix = fix;
  error.exit = Number.isInteger(exit) ? exit : exitForStatus(status);
  return { schema, command, status, error };
}

// The closed event vocabulary for a JSONL stream row (requirement #2).
const JSONL_EVENTS = new Set(['start', 'progress', 'row', 'result']);

export function createJsonlStream(stream, { schema = ENVELOPE_SCHEMA_VERSION, redactor } = {}) {
  if (!stream || typeof stream.write !== 'function') {
    throw new TypeError('createJsonlStream: stream with a write(chunk) method is required');
  }
  const activeRedactor = redactor || createRedactor();
  let lastWriteOk = true;

  function emit(event, fields = {}) {
    if (!JSONL_EVENTS.has(event)) {
      throw new TypeError(`createJsonlStream: unknown event ${JSON.stringify(event)} (expected ${[...JSONL_EVENTS].join(' | ')})`);
    }
    if (event === 'result' && fields.status !== undefined) {
      assertKnownStatus(fields.status, 'createJsonlStream result row');
    }
    lastWriteOk = stream.write(`${redactedJson({ schema, event, ...fields }, { redactor: activeRedactor })}\n`) !== false;
  }

  /** Resolve once the stream is writable again after backpressure — or
   * immediately when the last write did not signal backpressure, or the sink
   * has no event interface (a plain in-memory test sink). */
  function drained() {
    if (lastWriteOk || typeof stream.once !== 'function') return Promise.resolve();
    return new Promise((resolve) => stream.once('drain', () => {
      lastWriteOk = true;
      resolve();
    }));
  }

  return {
    start: (fields) => emit('start', fields),
    progress: (fields) => emit('progress', fields),
    row: (fields) => emit('row', fields),
    result: (fields) => emit('result', fields),
    write: emit,
    drained,
  };
}
