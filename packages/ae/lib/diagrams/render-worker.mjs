import fs from 'node:fs';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const VERSIONS = { pele: '1.8.0', d2: '0.1.34' };
const PALETTE = {
  '--pele-bg': '#ffffff', '--pele-fg': '#182b36', '--pele-muted': '#526773', '--pele-line': '#526773',
  '--pele-surface': '#edf3f6', '--pele-surface-alt': '#dce7ed', '--pele-border': '#718a98', '--pele-accent': '#126b86',
  '--pele-font': 'sans-serif', '--pele-font-mono': 'monospace', '--pele-radius': '4px',
};

// Self-contained so the same guard can run before D2's worker module is loaded.
// This is defense in depth for a restricted DSL, not a sandbox for arbitrary code.
export async function installRendererNetworkGuard() {
  const denied = () => { throw Object.assign(new Error('diagram renderer networking is disabled'), { code: 'E_DIAGRAM_NETWORK' }); };
  const names = {
    http: ['request', 'get'], https: ['request', 'get'], net: ['connect', 'createConnection'], tls: ['connect'],
    dgram: ['createSocket'], dns: ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'],
  };
  for (const [name, methods] of Object.entries(names)) {
    const { default: module } = await import(`node:${name}`);
    for (const method of methods) if (typeof module[method] === 'function') module[method] = denied;
    if (name === 'net') module.Socket.prototype.connect = denied;
    if (name === 'dns') for (const method of methods) if (typeof module.promises?.[method] === 'function') module.promises[method] = denied;
  }
  globalThis.fetch = async () => denied();
  globalThis.WebSocket = class { constructor() { denied(); } };
  globalThis.EventSource = class { constructor() { denied(); } };
  const { syncBuiltinESMExports } = await import('node:module');
  syncBuiltinESMExports();
}

export async function guardNestedRendererWorkers() {
  const { default: threads } = await import('node:worker_threads');
  const OriginalWorker = threads.Worker;
  threads.Worker = class extends OriginalWorker {
    constructor(filename, options = {}) {
      const entry = filename instanceof URL ? filename.href : pathToFileURL(path.resolve(String(filename))).href;
      const body = options.eval ? String(filename) : `await import(${JSON.stringify(entry)});`;
      const bootstrap = `(async () => { await (${installRendererNetworkGuard.toString()})();\n${body}\n})().catch(error => { throw error; });`;
      super(bootstrap, {
        ...options, eval: true, execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      });
    }
  };
  syncBuiltinESMExports();
}

function d2PackageJson() {
  for (const directory of require.resolve.paths('@d2lang/d2') || []) {
    const candidate = path.join(directory, '@d2lang', 'd2', 'package.json');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('bundled d2 package metadata is missing');
}

function assertVersion(engine) {
  // D2 exports no package.json, and the installed runtime keeps only its node-esm build,
  // so locate the manifest through the module search path instead of a resolved entry.
  const location = engine === 'pele' ? require.resolve('pele/package.json') : d2PackageJson();
  const metadata = JSON.parse(fs.readFileSync(location, 'utf8'));
  if (metadata.version !== VERSIONS[engine]) throw new Error(`bundled ${engine} version must be ${VERSIONS[engine]}, found ${metadata.version}`);
}

function portablePeleSvg(svg) {
  const variables = { ...PALETTE };
  for (const match of svg.matchAll(/(--[\w-]+)\s*:\s*([^;"<>]+)\s*;/g)) if (!(match[1] in variables)) variables[match[1]] = match[2].trim();
  const resolve = value => {
    for (let pass = 0; pass < 8 && /var\(/.test(value); pass++) {
      const before = value;
      value = value.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (_, name, fallback) => variables[name] ?? fallback ?? '');
      if (value === before) break;
    }
    if (/var\(/.test(value)) throw new Error('unsupported unresolved SVG style variable');
    return value;
  };
  return svg.replace(/(\s(?:style|fill|stroke|color|font-family|font-size|rx|ry|width|height|stroke-width|opacity)=)(["'])(.*?)\2/gs,
    (_, prefix, quote, value) => `${prefix}${quote}${resolve(value)}${quote}`);
}

function assertStaticSvg(svg, maxBytes) {
  if (typeof svg !== 'string' || !/^<svg\s/.test(svg) || Buffer.byteLength(svg) > maxBytes) throw new Error('invalid or oversized SVG output');
  if (/<!DOCTYPE|<!ENTITY|@import/i.test(svg)) throw new Error('unsupported active SVG content');
  for (const tag of svg.match(/<[^>]+>/g) || []) {
    if (/^<\s*(?:script|foreignObject|image|a|iframe|object|embed)\b|\son[\w:-]+\s*=/i.test(tag)) throw new Error('unsupported active SVG content');
    for (const [, , href] of tag.matchAll(/\s(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gs)) {
      if (!/^#[\w:.-]+$/.test(href)) throw new Error('external SVG references are forbidden');
    }
  }
  for (const match of svg.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
    const value = (match[1] ?? match[2] ?? match[3]).trim();
    if (!/^#[\w:.-]+$/.test(value) && !/^data:(?:application\/font-woff|font\/woff2?);base64,[a-z\d+/=\s]+$/i.test(value)) {
      throw new Error('external SVG assets are forbidden');
    }
  }
}

async function render({ source, engine, layout, maxOutputBytes }) {
  await installRendererNetworkGuard(); await guardNestedRendererWorkers(); assertVersion(engine);
  let svg;
  if (engine === 'pele') {
    const { render } = await import('pele');
    svg = portablePeleSvg(render(source, {
      idPrefix: 'ae-diagram', responsive: false, autoDirection: false, now: 0,
      links: false, images: false, limit: 50_000, outputLimit: maxOutputBytes, maxEdges: 2048,
      fontFamily: 'sans-serif', fontFamilyMono: 'monospace',
    }).svg);
  } else {
    const { D2 } = await import('@d2lang/d2');
    const d2 = new D2();
    try {
      const fixedSource = `vars: { d2-config: { data: { tala-seeds: [1] } } }\n${source}`;
      const compiled = await d2.compile({ fs: { index: fixedSource }, inputPath: 'index', options: { layout, pad: 24, salt: 'ae-diagram', noXMLTag: true, themeID: 0, sketch: false } });
      svg = await d2.render(compiled.diagram, compiled.renderOptions);
    } finally { await d2.dispose(); }
  }
  assertStaticSvg(svg, maxOutputBytes);
  return {
    svg, engine, version: VERSIONS[engine], layout,
    settings: {
      policy: 'ae-static-diagrams-v1', palette: 'ae-light-v1', network: 'disabled', imports: 'disabled', externalAssets: 'disabled',
      maxInputBytes: 50_000, maxOutputBytes, ...(engine === 'd2' ? { talaSeeds: [1], themeID: 0, pad: 24 } : { idPrefix: 'ae-diagram', responsive: false, autoDirection: false, now: 0 }),
    },
  };
}

if (parentPort && workerData) {
  render(workerData).then(result => parentPort.postMessage({ result }), error => parentPort.postMessage({ error: String(error.message).slice(0, 2000) }));
}
