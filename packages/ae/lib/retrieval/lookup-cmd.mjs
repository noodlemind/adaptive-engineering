import path from 'node:path';
import { parseFlags } from '../flags.mjs';
import { resolveCopilotHome } from '../paths.mjs';
import { createStyle, keyWidthFor } from '../style.mjs';
import { redactedJson } from '../redact.mjs';
import { inertLine } from '../knowledge/store.mjs';
import { LOOKUP_KINDS, lookupEntity } from './lookup.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export function parseLookupArgv(argv) {
  const positionals = [];
  const flagsWithValues = new Set(['--workspace', '--copilot-home', '--ae-home', '--harness-home', '--output']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (flagsWithValues.has(a)) {
      i += 1;
      continue;
    }
    if (a.startsWith('--')) continue;
    positionals.push(a);
    if (positionals.length === 2) break;
  }
  return { kind: positionals[0] ?? null, identifier: positionals[1] ?? null };
}

function resolveContext(argv) {
  const flags = parseFlags(argv);
  const { kind, identifier } = parseLookupArgv(argv);
  return {
    flags,
    kind,
    identifier,
    workspace: path.resolve(flags.workspace),
    copilotHome: resolveCopilotHome(flags.copilotHome),
  };
}

export async function lookupResultOf(argv) {
  const { flags, kind, identifier, workspace, copilotHome } = resolveContext(argv);
  return lookupEntity({ kind, identifier, workspace, copilotHome, home: flags.harnessHome || flags.home });
}

export async function cmdLookup(argv) {
  const { flags, kind, identifier, workspace, copilotHome } = resolveContext(argv);
  const result = lookupEntity({ kind, identifier, workspace, copilotHome, home: flags.harnessHome || flags.home });

  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
    return 0;
  }

  const keyWidth = keyWidthFor(['location', 'provenance', 'preview', result.kind]);
  console.log(ui.line({ key: result.kind, value: result.id, note: result.title ?? undefined, keyWidth }));
  if (result.location) console.log(ui.line({ key: 'location', value: result.location, keyWidth }));

  const provenance = Object.entries(result.provenance ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
  if (provenance) console.log(ui.line({ key: 'provenance', value: provenance, keyWidth }));

  const metadata = Object.entries(result.metadata ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`)
    .join(' · ');
  if (metadata) console.log(ui.line({ key: 'metadata', value: metadata, keyWidth }));

  if (result.preview) {
    console.log('');
    console.log(result.preview.split('\n').map(inertLine).join('\n'));
  }

  if (result.related?.length) {
    console.log('');
    for (const rel of result.related) {
      console.log(ui.line({ key: 'related', value: rel.id, note: rel.location ?? undefined, keyWidth }));
    }
  }
  return 0;
}
