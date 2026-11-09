import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { redactedJson } from './redact.mjs';
import { diagramArtifactPaths, diagramPath, diagramStatus, renderDiagramView } from './diagram.mjs';

export const DIAGRAM_VERBS = Object.freeze(['render', 'graph', 'flow', 'status']);
const GLOBAL_VALUES = ['--workspace', '--ae-home', '--harness-home', '--copilot-home', '--output'];
const BOOLEAN = new Set(['--json', '--dry-run', '--no-events', '--no-color', '--verbose', '-v']);
const ALLOWED = { render: ['--file', '--sources', '--renderer', '--layout', '--timeout', '--scale'], graph: ['--root', '--operation', '--depth', '--limit', '--max-nodes', '--timeout', '--scale'], flow: ['--flow', '--limit', '--max-nodes', '--timeout', '--scale'], status: ['--receipt'] };
const VERB_BOOLEAN = { render: ['--png'], graph: ['--png'], flow: ['--png'], status: [] };
const usage = message => Object.assign(new Error(`diagrams: ${message}`), { code: 'E_USAGE', exit: 2, hint: 'ae help diagrams' });

export function parseDiagramArguments(argv) {
  const verb = argv[0];
  if (!DIAGRAM_VERBS.includes(verb)) throw usage(`expected ${DIAGRAM_VERBS.join('|')}`);
  const seen = new Set(), values = new Map();
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i], split = token.indexOf('='), name = split < 0 ? token : token.slice(0, split), key = name === '-v' ? '--verbose' : name;
    if (seen.has(key)) throw usage(`duplicate option ${key}`);
    seen.add(key);
    if ((BOOLEAN.has(name) || VERB_BOOLEAN[verb].includes(name)) && split < 0) continue;
    if (VERB_BOOLEAN[verb].includes(name)) throw usage(`${name} does not take a value`);
    if (![...GLOBAL_VALUES, ...ALLOWED[verb]].includes(name)) throw usage(`unsupported option ${name} for ${verb}`);
    const value = split < 0 ? argv[++i] : token.slice(split + 1);
    if (!value || value.startsWith('-') || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw usage(`${name} requires a bounded value`);
    values.set(name, value);
  }
  const required = { render: '--file', graph: '--root', flow: '--flow', status: '--receipt' }[verb];
  if (!values.has(required)) throw usage(`${verb} requires ${required}`);
  const numeric = (flag, fallback, min, max) => {
    const value = values.get(flag);
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw usage(`${flag} requires ${min} to ${max}`);
    return Number(value);
  };
  let file, root, receiptPath, sources = [];
  try {
    file = values.has('--file') ? diagramPath(values.get('--file')) : undefined;
    root = values.has('--root') ? diagramPath(values.get('--root')) : undefined;
    receiptPath = values.has('--receipt') ? diagramPath(values.get('--receipt')) : undefined;
    if (values.has('--sources')) sources = values.get('--sources').split(',').map(p => diagramPath(p.trim(), { scope: true }));
  } catch (error) { throw usage(error.message); }
  if (file && !/\.(?:mmd|mermaid|d2)$/.test(file)) throw usage('--file must end in .mmd, .mermaid or .d2');
  const renderer = values.get('--renderer') || (file?.endsWith('.d2') ? 'd2' : undefined);
  if (renderer && !['pele', 'd2'].includes(renderer)) throw usage('--renderer requires pele or d2');
  const layout = values.get('--layout');
  if (layout && (!['tala', 'elk', 'dagre'].includes(layout) || renderer !== 'd2')) throw usage('--layout is available only for d2 and requires tala, elk or dagre');
  const operation = values.get('--operation') || 'deps';
  if (!['deps', 'dependents'].includes(operation)) throw usage('--operation requires deps or dependents');
  const png = seen.has('--png');
  if (values.has('--scale') && !png) throw usage('--scale requires --png');
  const flags = parseFlags(argv);
  return { flags, verb, file, sources, root, operation, receiptPath, renderer, layout, png, scale: png ? numeric('--scale', 2, 1, 4) : undefined, flow: values.get('--flow'), depth: numeric('--depth', 2, 1, 32), limit: numeric('--limit', 50, 1, 200), maxNodes: numeric('--max-nodes', 50, 1, 200), timeoutMs: numeric('--timeout', 10000, 1, 30000) };
}

export function formatDiagramReport(result, workspace) {
  const lines = [`Diagram ${result.id?.slice(0, 12) || ''}: ${result.state || result.freshness?.state || 'unknown'} (${result.scope || result.freshness?.scope || 'unknown'})`];
  const paths = result.paths && Object.keys(result.paths).length ? result.paths : diagramArtifactPaths(workspace, result.artifacts);
  if (paths.svg) lines.push(`  SVG ${paths.svg}`);
  if (paths.html) lines.push(`  HTML ${paths.html}`);
  if (paths.png) lines.push(`  PNG ${paths.png}`);
  if (paths.receipt) lines.push(`  Receipt ${paths.receipt}`);
  if (paths.svg) lines.push('  Open the HTML page in a browser. Use the PNG for Slack, Confluence, Jira, email, or slides.');
  if (result.reason) lines.push(`  ${result.reason}`);
  if (result.dryRun) lines.push('  Dry run; no artifacts written.');
  return lines.join('\n');
}

export async function diagramsResultOf(argv, ctx = {}) {
  const options = parseDiagramArguments(argv), { flags } = options;
  const input = { ...options, workspace: path.resolve(flags.workspace), home: flags.harnessHome || ctx.harnessHome || harnessGlobalHome(), dryRun: Boolean(flags.dryRun) };
  return options.verb === 'status' ? diagramStatus(input) : renderDiagramView(input);
}

export async function cmdDiagrams(argv, ctx = {}) {
  const result = await diagramsResultOf(argv, ctx), { flags } = parseDiagramArguments(argv);
  if (flags.json) console.log(redactedJson(result, { pretty: flags.verbose }));
  else console.log(formatDiagramReport(result, path.resolve(flags.workspace)));
  ctx.reportStatus?.(result.status);
  return result.exitCode;
}
