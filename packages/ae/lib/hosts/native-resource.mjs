import YAML from 'yaml';

const HOSTS = new Set(['claude-code', 'codex', 'cursor', 'terminal']);
const TOOL_MAP = {
  read: ['Read'], search: ['Glob', 'Grep'], 'search/codebase': ['Glob', 'Grep'],
  'search/usages': ['Grep'], 'search/changes': ['Read'], 'read/problems': ['Read'],
  'read/terminalLastCommand': [], 'execute/getTerminalOutput': [],
  edit: ['Edit', 'Write'], 'edit/editFiles': ['Edit', 'Write'], execute: ['Bash'], 'web/fetch': ['WebFetch'], githubRepo: [],
};
const canonicalName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const markdown = (metadata, body) => `---\n${YAML.stringify(metadata, { lineWidth: 0 })}---\n\n${body.trimEnd()}\n`;

export function splitNativeSource(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text || '');
  return match ? { metadata: YAML.parse(match[1], { maxAliasCount: 50 }), body: text.slice(match[0].length).trimStart() } : { metadata: {}, body: text || '' };
}

/** The common native representation for shipped and acquired agent roles. */
export function nativeAgentAsset({ host, name, metadata, body, extraDelegates = [] }) {
  if (!HOSTS.has(host) || !canonicalName.test(name || '')) throw new Error('Unsupported host or noncanonical native agent');
  const declared = Array.isArray(metadata.tools) ? metadata.tools : [];
  const actor = declared.includes('edit') || declared.includes('edit/editFiles');
  const agents = [...new Set([...(Array.isArray(metadata.agents) ? metadata.agents : []), ...extraDelegates])];
  if (agents.some(id => !canonicalName.test(id))) throw new Error('Invalid native delegation target');
  if (host === 'claude-code') {
    const tools = [...new Set(declared.flatMap(tool => TOOL_MAP[tool] || []))];
    if (declared.includes('agent') && agents.length) tools.unshift(`Agent(${agents.join(', ')})`);
    return { root: 'config', path: `agents/${name}.md`, content: markdown({ name, description: metadata.description, tools }, body), mode: 'native' };
  }
  if (host === 'codex') return { root: 'config', path: `agents/${name}.toml`, content: `name = ${JSON.stringify(name)}\ndescription = ${JSON.stringify(metadata.description)}\ndeveloper_instructions = ${JSON.stringify(body)}\n`, mode: 'native' };
  return { root: 'config', path: `agents/${name}.md`, content: markdown({ name, description: metadata.description, ...(host === 'cursor' ? { readonly: !actor } : {}) }, body), mode: host === 'terminal' ? 'manual' : 'native' };
}

/** Codex/terminal instructions are context-routed; no nonexistent rule loader is claimed. */
export function nativeInstructionAsset({ host, name, metadata, body }) {
  if (!HOSTS.has(host) || !canonicalName.test(name || '')) throw new Error('Unsupported host or noncanonical native instruction');
  const pattern = metadata.applyTo || '**';
  if (host === 'claude-code') return { root: 'config', path: `rules/${name}.md`, content: markdown(pattern === '**' ? {} : { paths: [pattern] }, body), mode: 'native' };
  if (host === 'cursor') return { root: 'config', path: `rules/${name}.mdc`, content: markdown({ description: metadata.description || name, globs: pattern, alwaysApply: pattern === '**' }, body), mode: 'native' };
  return { root: 'config', path: `instructions/${name}.md`, content: markdown({ description: metadata.description || name, appliesTo: pattern }, body), mode: 'context-routed' };
}

function tomlString(text, key) {
  const line = new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm').exec(text)?.[1]?.trim();
  if (!line) return null;
  if (line.startsWith('"""')) {
    const value = new RegExp(`^${key}\\s*=\\s*"""([\\s\\S]*?)"""`, 'm').exec(text)?.[1];
    return typeof value === 'string' ? value.replace(/^\r?\n/, '') : null;
  }
  if (/^'[^']*'$/.test(line)) return line.slice(1, -1);
  try { const value = JSON.parse(line); return typeof value === 'string' ? value : null; } catch { return null; }
}

/** Bounded format inspection; resource presence does not establish host invocation. */
export function inspectNativeResource({ host, type, name, text }) {
  const errors = [];
  let metadata = {}, body = '';
  if (!HOSTS.has(host) || !['agent', 'instruction'].includes(type) || !canonicalName.test(name || '')) errors.push('Unsupported native resource identity');
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 65536) errors.push('Native resource is empty, unsafe or exceeds 64 KiB');
  if (!errors.length) try {
    if (host === 'codex' && type === 'agent') {
      metadata = { name: tomlString(text, 'name'), description: tomlString(text, 'description') };
      body = tomlString(text, 'developer_instructions');
      if (metadata.name !== name || !metadata.description || !body?.trim()) errors.push('Unsupported or incomplete native agent TOML');
    } else {
      const doc = splitNativeSource(text); metadata = doc.metadata; body = doc.body;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) errors.push('Native frontmatter must be a mapping');
      else if (type === 'agent') {
        if (metadata.name !== name || typeof metadata.description !== 'string' || !metadata.description.trim() || !body.trim()) errors.push('Native agent requires matching name, description and authored body');
        if (host === 'claude-code' && !(typeof metadata.tools === 'string' && metadata.tools.trim() || Array.isArray(metadata.tools) && metadata.tools.every(tool => typeof tool === 'string'))) errors.push('Native Claude tools must be explicit names');
      } else if (!body.trim()) errors.push('Native instruction requires an authored body');
    }
  } catch (error) { errors.push(`Invalid native resource format: ${error.message}`); }
  return { valid: !errors.length, errors, metadata, body };
}
