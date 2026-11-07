import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { authorityBin } from './authority-bin.mjs';

let runtime;
let candidates = [];
try { candidates = [authorityBin(), authorityBin({ includeOverride: false })].filter(Boolean); } catch {}
for (const bin of new Set(candidates)) {
  try {
    runtime = await import(pathToFileURL(path.resolve(path.dirname(bin), '../lib/host-intent.mjs')).href);
    break;
  } catch { /* The entry point reports unavailable installed authority. */ }
}

export function inspectHostIntent(options) {
  if (!runtime) throw new Error('AE host-intent authority is unavailable; upgrade AE');
  return runtime.inspectHostIntent(options);
}
