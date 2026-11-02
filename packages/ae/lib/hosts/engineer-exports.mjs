import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { assertNoSymlinkAncestors } from '../fs-safe.mjs';

const OUTPUTS = Object.freeze({
  copilot: 'corpus/agents/engineer.agent.md',
  'claude-code': 'corpus/hosts/claude-code/engineer.md',
});

function safePath(root, rel) {
  const full = assertNoSymlinkAncestors(root, rel);
  if (!full) throw new Error(`Refusing redirected Engineer export path: ${rel}`);
  const stat = fs.lstatSync(full, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error(`Engineer export must be a regular file: ${rel}`);
  return full;
}

function read(root, rel) {
  return fs.readFileSync(safePath(root, rel), 'utf8').replaceAll('\r\n', '\n');
}

/** Translate addressing and native metadata only. Lifecycle prose has one owner. */
export function renderEngineerExport(root, host) {
  if (!Object.hasOwn(OUTPUTS, host)) throw new Error(`Unsupported Engineer export: ${host}`);
  const descriptors = JSON.parse(read(root, 'corpus/hosts/engineer-adapters.json'));
  if (descriptors.schema !== 1) throw new Error('Unsupported Engineer adapter schema');
  const adapter = descriptors.adapters?.[host];
  if (!adapter || typeof adapter.skillsRoot !== 'string' || !adapter.skillsRoot ||
      !adapter.frontmatter || typeof adapter.frontmatter !== 'object' || Array.isArray(adapter.frontmatter)) {
    throw new Error(`Invalid Engineer adapter: ${host}`);
  }
  const contract = read(root, 'corpus/skills/engineer/references/contract.md');
  const document = new YAML.Document(adapter.frontmatter);
  for (const key of ['tools', 'agents']) {
    const node = document.get(key, true);
    if (YAML.isSeq(node)) node.flow = true;
  }
  return `---\n# Generated; npm run generate:engineer\n${document.toString({ lineWidth: 0 })}---\n\n${contract.replaceAll('<skills-root>', adapter.skillsRoot)}`;
}

/** Missing or edited projections are drift; check mode never repairs them. */
export function checkEngineerExports(root) {
  return Object.entries(OUTPUTS).filter(([host, rel]) => {
    const expected = renderEngineerExport(root, host);
    const full = safePath(root, rel);
    return !fs.existsSync(full) || read(root, rel) !== expected;
  }).map(([, rel]) => rel);
}

export function writeEngineerExports(root) {
  // Validate every destination before writing either one. Never follow symlinks.
  const outputs = Object.entries(OUTPUTS).map(([host, rel]) => ({
    rel, full: safePath(root, rel), text: renderEngineerExport(root, host),
  }));
  for (const { full, text } of outputs) {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const temp = `${full}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, text, { flag: 'wx' });
      fs.renameSync(temp, full);
    } finally { fs.rmSync(temp, { force: true }); }
  }
  return outputs.map(item => item.rel);
}
