import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { readFileNoFollow, readBoundedInput, writeFileContained, assertNoSymlinkAncestors } from './fs-safe.mjs';
import { createHash } from 'node:crypto';
import { createPersonalPrimitive, readPrimitiveOnce, registeredPath } from './local-primitives.mjs';
import { withPlanUpdateLock } from './plan-update.mjs';
const primitiveDigest = text => `sha256-${createHash('sha256').update(text).digest('hex')}`;
const SUPPORTED_HOST_TOOLS = new Set(['agent', 'edit', 'edit/editFiles', 'execute', 'execute/getTerminalOutput', 'githubRepo', 'read', 'read/problems', 'read/terminalLastCommand', 'search', 'search/changes', 'search/codebase', 'search/usages', 'web/fetch']);

export const primitivePath = (type, name) => ({ skill: `skills/${name}/SKILL.md`, agent: `agents/${name}.agent.md`, instruction: `instructions/${name}.instructions.md` })[type];
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const fail = message => Object.assign(new Error(message), { code: 'E_USAGE', exit: 2, hint: 'ae help resources' });
export function primitiveFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  if (!match) throw fail('Primitive needs YAML frontmatter');
  const fm = YAML.parse(match[1], { maxAliasCount: 50 });
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) throw fail('Frontmatter must be a mapping');
  return fm;
}

export function validatePrimitiveContent({ type, name, text, root, rel, shipped = false }) {
  const errors = [], references = [];
  if (!namePattern.test(name || '') || !primitivePath(type, name)) errors.push('Unknown type or noncanonical name');
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) errors.push('Primitive must be UTF-8 text of at most 64 KiB');
  let fm;
  try { fm = primitiveFrontmatter(text); } catch (error) { errors.push(error.message); }
  if (!fm) return { valid: false, errors, references, frontmatter: null };
  if ((!shipped || type === 'skill') && fm.name !== name) errors.push('Frontmatter name must match the canonical path');
  const cap = type === 'agent' ? 180 : type === 'skill' ? 220 : 512;
  if (typeof fm.description !== 'string' || !fm.description.trim() || /^TODO\b/i.test(fm.description) || fm.description.length > cap) errors.push(`Description must contain 1–${cap} authored characters`);
  if ('model' in fm) errors.push('Provider model pinning is unsupported in the host-neutral corpus');
  if (type === 'skill') {
    for (const label of ['Should trigger', 'Should not trigger']) {
      const match = new RegExp(`(?:\\*\\*|#{1,6} )${label}:?(?:\\*\\*)?[^\\n]*\\n([\\s\\S]*?)(?=\\n(?:#{1,6} |\\*\\*)|$)`, 'i').exec(text);
      const examples = match?.[1].split('\n').filter(line => /^\s*[-*] /.test(line) && !/TODO|\[scenario\]|\[prompt\]/i.test(line)) || [];
      if (examples.length < 3) errors.push(`${label} needs at least three concrete examples`);
    }
  }
  if (type === 'agent') {
    for (const key of ['tools', 'agents']) if (!Array.isArray(fm[key]) || fm[key].some(v => typeof v !== 'string' || !v.trim())) errors.push(`${key} must be an explicit array of names`);
    if (!shipped && fm['user-invocable'] !== false) errors.push('Personal specialists must declare user-invocable: false');
    const guardrail = /\n## (?:Guardrails|Safety|Boundaries)\s*\n([\s\S]*?)(?=\n## |$)/i.exec(text)?.[1]?.trim();
    if (!guardrail || /^TODO\b/i.test(guardrail)) errors.push('Agent needs an authored guardrail section');
    if (/^\s*TODO\s*$/m.test(text)) errors.push('Agent has unfinished placeholder sections');
    if (Array.isArray(fm.tools) && fm.tools.some(tool => !SUPPORTED_HOST_TOOLS.has(tool))) errors.push('Unsupported host tool declaration');
  }
  if (type === 'instruction' && (typeof fm.applyTo !== 'string' || !fm.applyTo.trim() || /^TODO\b/i.test(fm.applyTo))) errors.push('Instruction needs an applyTo glob');
  if (!shipped && type === 'instruction') for (const label of ['Good example', 'Bad example']) {
    const section = new RegExp(`\\n## ${label}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'i').exec(text)?.[1]?.trim();
    if (!section || /^TODO\b/i.test(section)) errors.push(`${label} needs a concrete authored example`);
  }
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(?:[a-z]+:|~\/|\/)/i.test(target)) continue;
    if (!root || !rel) { references.push({ path: target, status: 'unverified' }); continue; }
    const file = path.resolve(root, path.dirname(rel), target), relative = path.relative(root, file);
    const exists = !relative.startsWith('..') && readFileNoFollow(file, { root, maxBytes: 1024 * 1024 }) !== null;
    references.push({ path: relative, status: exists ? 'present' : 'missing' });
    if (!exists) errors.push(`Reference is missing, unreadable or outside the resource root: ${target}`);
  }
  return { valid: !errors.length, errors, references, frontmatter: fm };
}

export function resourceInput(flags) {
  if (flags.files?.length > 1) throw fail('Use one structured input file');
  const text = flags.files?.length ? readFileNoFollow(path.resolve(flags.workspace, flags.files[0]), { maxBytes: 1024 * 1024 }) : readBoundedInput();
  if (!text) throw fail('Input is absent, unreadable or exceeds 1 MiB');
  try { return JSON.parse(text); } catch { throw fail('Input must be JSON'); }
}

export function scaffoldPrimitive(type, name) {
  const rel = primitivePath(type, name);
  if (!rel || !namePattern.test(name || '')) throw fail('Use skill, agent or instruction and a kebab-case name');
  const fm = { name, description: 'TODO: state what this capability judges and when it applies.', ...(type === 'instruction' ? { applyTo: 'TODO' } : { 'user-invocable': false }), ...(type === 'agent' ? { tools: [], agents: [] } : {}) };
  const examples = type === 'skill' ? '\n## Should trigger\n- TODO\n- TODO\n- TODO\n\n## Should not trigger\n- TODO\n- TODO\n- TODO\n' : '\n## Good example\nTODO\n\n## Bad example\nTODO\n';
  const text = `---\n${YAML.stringify(fm)}---\n\n# ${name}\n\n## Judgment\nTODO\n${examples}\n## Guardrails\nTODO\n\n## Output\nTODO\n`;
  return { schema: 1, verb: 'scaffold', status: 'ok', path: rel, text, requiresJudgment: true, activated: false };
}

export function createStructuredPrimitive({ flags, copilotHome, type, name, input, shippedFiles, lockFiles }) {
  if (input?.schema !== 1 || Object.keys(input).some(k => !['schema', 'text', 'expectedDigest'].includes(k))) throw fail('Creation input requires schema 1, text, and optional expectedDigest; payload approval cannot authorize writes');
  const rel = primitivePath(type, name), validation = validatePrimitiveContent({ type, name, text: input.text, root: copilotHome, rel });
  if (!validation.valid) throw fail(validation.errors.join('; '));
  const perform = () => {
    if (shippedFiles.has(rel) || lockFiles.has(rel)) throw fail(`${rel} is shipped with Harness; personal writes cannot replace it`);
    if (!assertNoSymlinkAncestors(copilotHome, rel)) throw fail('Primitive destination is unsafe');
    let prior = null;
    try { prior = readPrimitiveOnce(copilotHome, rel); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (input.expectedDigest !== undefined && prior?.digest !== input.expectedDigest) throw fail('Expected primitive bytes are stale');
    if (prior && prior.text !== input.text && !input.expectedDigest) throw fail('Replacing a primitive requires its expectedDigest');
    const old = prior ? primitiveFrontmatter(prior.text) : { tools: [], agents: [] };
    if (type === 'agent') {
      for (const agent of validation.frontmatter.agents) {
        if (!namePattern.test(agent) || readFileNoFollow(path.join(copilotHome, 'agents', `${agent}.agent.md`), { root: copilotHome, maxBytes: 65536 }) === null) throw fail(`Delegation target is absent or unsafe: ${agent}`);
      }
    }
    const expanded = ['tools', 'agents'].some(key => (validation.frontmatter[key] || []).some(value => !(old[key] || []).includes(value)));
    if (expanded && !flags.yes) throw fail('Permission expansion requires caller --yes after human authorization; a payload field is not authority');
    if (flags.dryRun) return { schema: 1, verb: 'create', status: 'ok', validation, primitive: { path: rel, state: 'preview' }, activated: false };
    const primitive = createPersonalPrimitive({ copilotHome, kind: type, name, text: input.text, shippedFiles, lockFiles });
    return { schema: 1, verb: 'create', status: 'ok', validation, primitive: { ...primitive, digest: readPrimitiveOnce(copilotHome, rel).digest }, activated: true };
  };
  if (flags.dryRun) return perform();
  if (!writeFileContained(copilotHome, 'harness/.resource-ready.json', '{"version":1}\n')) throw fail('Resource root is unsafe or unwritable');
  return withPlanUpdateLock(registeredPath(copilotHome), perform);
}

export function validateResourceInventory(root, { shipped = false, shippedFiles = new Set() } = {}) {
  const primitives = [], diagnostics = [];
  if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory()) return { schema: 1, verb: 'validate', status: 'failed', root, counts: { skill: 0, agent: 0, instruction: 0 }, primitives, diagnostics: [{ path: root, reason: 'resource root is absent or unsafe' }], registry: null };
  for (const type of ['skill', 'agent', 'instruction']) {
    const dir = path.join(root, `${type}s`);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { continue; }
    for (const entry of entries) {
      if (type === 'skill' && entry.name === 'references') continue;
      if (type === 'skill' ? !entry.isDirectory() : !entry.isFile() || !entry.name.endsWith(`.${type === 'agent' ? 'agent' : 'instructions'}.md`)) continue;
      const name = type === 'skill' ? entry.name : entry.name.replace(/\.(agent|instructions)\.md$/, '');
      const rel = primitivePath(type, name), text = readFileNoFollow(path.join(root, rel), { root, maxBytes: 65536 });
      if (text === null) { diagnostics.push({ path: rel, reason: 'missing, unsafe or exceeds 64 KiB' }); continue; }
      const validation = validatePrimitiveContent({ type, name, text, root, rel, shipped: shipped || shippedFiles.has(rel) });
      primitives.push({ type, name, path: rel, digest: primitiveDigest(text), ...validation });
    }
  }
  let registry = null;
  const registryRel = 'knowledge/capability-registry.yaml';
  const text = readFileNoFollow(path.join(root, registryRel), { root, maxBytes: 1024 * 1024 });
  if (text !== null) {
    try { registry = YAML.parse(text, { maxAliasCount: 50 }); } catch { diagnostics.push({ path: registryRel, reason: 'unreadable registry' }); }
  }
  if (shipped && !registry) diagnostics.push({ path: registryRel, reason: 'required registry is absent' });
  const isMapping = value => value && typeof value === 'object' && !Array.isArray(value);
  if (registry) {
    if (!isMapping(registry) || !isMapping(registry.capabilities)) diagnostics.push({ path: registryRel, reason: 'invalid registry capabilities declaration' });
    const live = [];
    for (const [key, value] of Object.entries(isMapping(registry.capabilities) ? registry.capabilities : {})) {
      if (!isMapping(value)) { diagnostics.push({ path: registryRel, reason: `invalid registry entry: ${key}` }); continue; }
      if (value.status !== 'retired' && ['skill', 'agent'].includes(value.type)) live.push([key, value]);
    }
    const managed = primitives.filter(p => (shipped || shippedFiles.has(p.path)) && p.type !== 'instruction');
    for (const p of managed) if (!live.some(([key, v]) => (v.name || key) === p.name && v.type === p.type)) diagnostics.push({ path: p.path, reason: 'missing live capability registry entry' });
    for (const [key, value] of live) if (!primitives.some(p => p.type === value.type && p.name === (value.name || key))) diagnostics.push({ path: registryRel, reason: `live entry has no source: ${key}` });
    const engineer = primitives.find(p => p.type === 'agent' && p.name === 'engineer');
    const declared = Array.isArray(engineer?.frontmatter?.agents) ? engineer.frontmatter.agents : [];
    const indexed = Array.isArray(registry.engineer_allowlist) && registry.engineer_allowlist.every(v => typeof v === 'string') ? registry.engineer_allowlist : [];
    if (!Array.isArray(registry.engineer_allowlist)) diagnostics.push({ path: registryRel, reason: 'invalid engineer allowlist declaration' });
    if (JSON.stringify([...new Set(declared)].sort()) !== JSON.stringify([...new Set(indexed)].sort())) diagnostics.push({ path: registryRel, reason: 'Engineer delegation registry differs from declared agents' });
  }
  for (const p of primitives.filter(p => p.type === 'agent')) for (const target of Array.isArray(p.frontmatter?.agents) ? p.frontmatter.agents : []) if (!primitives.some(q => q.type === 'agent' && q.name === target)) diagnostics.push({ path: p.path, reason: `delegation target absent: ${target}` });
  const personal = primitives.filter(p => !shipped && !shippedFiles.has(p.path));
  if (personal.length) {
    const registeredRel = 'harness/registered.yaml', raw = readFileNoFollow(path.join(root, registeredRel), { root, maxBytes: 1024 * 1024 });
    let registered = null;
    try { registered = raw === null ? null : YAML.parse(raw, { maxAliasCount: 50 }); } catch { /* diagnostic below */ }
    for (const p of personal) if (!isMapping(registered?.primitives) || registered.primitives[p.path]?.digest !== p.digest) diagnostics.push({ path: p.path, reason: 'personal registration absent, damaged or stale', registry: registeredRel });
  }
  return { schema: 1, verb: 'validate', status: diagnostics.length || primitives.some(p => !p.valid) ? 'failed' : 'ok', root, counts: Object.fromEntries(['skill', 'agent', 'instruction'].map(type => [type, primitives.filter(p => p.type === type).length])), primitives, diagnostics, registry: registry ? { path: registryRel, version: registry.version } : null, hostSupport: { vscode: 'declared; live integration unverified', intellij: 'declared; live integration unverified' } };
}
