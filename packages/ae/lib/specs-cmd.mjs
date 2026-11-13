import { parseFlags } from './flags.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { redactedJson } from './redact.mjs';
import { inertLine } from './knowledge/store.mjs';
import { SPEC_VERBS, indexDomainSpecs, specStatus, searchSpecs, getSpecSection } from './spec-index.mjs';

const BOOLEAN = new Set(['--json', '--dry-run', '--no-events', '--no-color', '--verbose', '-v']);
const VALUED = new Set(['--name', '--scope', '--limit', '--ref', '--workspace', '--ae-home', '--harness-home', '--copilot-home']);
const PER_VERB = { index: [], status: [], search: ['--scope', '--limit'], get: ['--ref'] };
const usage = message => Object.assign(new Error(`specs: ${message}`), { code: 'E_USAGE', exit: 2, hint: 'ae help specs' });

export function parseSpecArguments(argv) {
  const verb = argv[0];
  if (!SPEC_VERBS.includes(verb)) throw usage(`expected ${SPEC_VERBS.join('|')}`);
  const seen = new Set(), values = new Map(), words = [];
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('-')) { words.push(token); continue; }
    const split = token.indexOf('='), name = split < 0 ? token : token.slice(0, split), key = name === '-v' ? '--verbose' : name;
    if (seen.has(key)) throw usage(`duplicate option ${key}`);
    seen.add(key);
    if (BOOLEAN.has(name) && split < 0) continue;
    if (!VALUED.has(name)) throw usage(`unsupported option ${name}`);
    const value = split < 0 ? argv[++i] : token.slice(split + 1);
    if (!value || value.startsWith('-') || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw usage(`${name} requires a bounded value`);
    values.set(name, value);
  }
  for (const key of values.keys()) {
    if (['--name', '--workspace', '--ae-home', '--harness-home', '--copilot-home'].includes(key)) continue;
    if (!PER_VERB[verb].includes(key)) throw usage(`${key} is unsupported for ${verb}`);
  }
  const name = values.get('--name');
  if (!name || name.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) throw usage('--name must identify an existing domain');
  if (verb === 'search' && !words.length) throw usage('search needs a query');
  if (verb !== 'search' && words.length) throw usage('unexpected positional argument');
  if (verb === 'get' && !values.get('--ref')) throw usage('get requires --ref');
  if (values.has('--limit') && !/^\d+$/.test(values.get('--limit'))) throw usage('--limit requires an integer');
  return { verb, name, query: words.join(' '), values, flags: parseFlags(argv) };
}

export function specsResultOf(argv, ctx = {}) {
  const { verb, name, query, values, flags } = parseSpecArguments(argv);
  const home = flags.harnessHome || ctx.harnessHome || harnessGlobalHome();
  let result;
  if (verb === 'index') result = indexDomainSpecs({ name, home, dryRun: Boolean(flags.dryRun) });
  else if (verb === 'status') result = specStatus({ name, home });
  else if (verb === 'search') result = searchSpecs({ name, home, query, scope: values.get('--scope') ?? null, limit: values.has('--limit') ? Number(values.get('--limit')) : 10 });
  else result = getSpecSection({ name, home, ref: values.get('--ref') });
  return { schema: 1, mode: 'specs', ...result };
}

export function cmdSpecs(argv, ctx = {}) {
  const result = specsResultOf(argv, ctx), { flags } = parseSpecArguments(argv);
  if (flags.json) console.log(redactedJson(result, { pretty: flags.verbose }));
  else if (result.verb === 'search') {
    console.log(`${result.results.length} of ${result.total} section(s) for "${inertLine(result.query)}"`);
    for (const hit of result.results) console.log(`  ${inertLine(hit.ref)}${hit.stale ? ' (stale)' : ''}\n    ${inertLine(hit.headingPath.join(' > '))}: ${inertLine(hit.snippet)}`);
  } else if (result.verb === 'get') console.log(result.text);
  else console.log(redactedJson(result, { pretty: true }));
  ctx.reportStatus?.(result.status);
  return result.exitCode;
}
