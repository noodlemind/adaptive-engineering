import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { authorityBin } from './lib/authority-bin.mjs';

try {
  const bin = authorityBin();
  if (!bin) throw new Error('AE authority is unavailable');
  const runtime = relative => pathToFileURL(path.resolve(path.dirname(bin), '../lib', relative)).href;
  const { readBoundedInput } = await import(runtime('fs-safe.mjs'));
  const bytes = readBoundedInput(0, { maxBytes: 2 * 1024 * 1024 });
  if (!bytes?.trim()) throw new Error('Prompt event is empty or oversized');
  const payload = JSON.parse(bytes);
  const { observeHostIntent } = await import(runtime('host-intent.mjs'));
  observeHostIntent({ workspace: payload.cwd || payload.workspace, sessionId: payload.session_id || payload.sessionId,
    prompt: payload.prompt, eventId: payload.prompt_id ?? payload.timestamp,
    ...(payload.timestamp === undefined ? {} : { eventTimestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.parse(payload.timestamp) }),
    host: process.env.AE_HOST === 'claude-code' ? 'claude-code' : 'copilot' });
  console.log('{}');
} catch (error) {
  console.error(`AE prompt observation refused: ${error.message}`);
  process.exitCode = 2;
}
