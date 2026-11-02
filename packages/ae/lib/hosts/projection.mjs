import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const HOSTS = new Set(['claude-code', 'codex', 'cursor', 'terminal']);
const TOOL_MAP = {
  read: ['Read'], search: ['Glob', 'Grep'], 'search/codebase': ['Glob', 'Grep'],
  'search/usages': ['Grep'], 'search/changes': ['Read'], 'read/problems': ['Read'],
  'read/terminalLastCommand': [], 'execute/getTerminalOutput': [],
  'edit/editFiles': ['Edit', 'Write'], execute: ['Bash'], 'web/fetch': ['WebFetch'], githubRepo: [],
};

function sourceFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing redirected corpus source: ${full}`);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.isFile()) files.push(full);
    else throw new Error(`Unsupported corpus source: ${full}`);
  }
  return files;
}

function splitDocument(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  return match ? { metadata: YAML.parse(match[1]), body: text.slice(match[0].length).trimStart() } : { metadata: {}, body: text };
}

function markdown(metadata, body) {
  return `---\n${YAML.stringify(metadata, { lineWidth: 0 })}---\n\n${body.trimEnd()}\n`;
}

/** Pure native assets: setup owns publication, file ownership, and configuration. */
export function projectHostCorpus({ packageRoot, host, configHome, skillsHome, home }) {
  if (!HOSTS.has(host)) throw new Error(`Unsupported host projection: ${host}`);
  for (const [name, root] of Object.entries({ packageRoot, configHome, skillsHome, ...(home === undefined ? {} : { home }) })) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || /[\u0000-\u001f\u007f]/.test(root)) throw new Error(`${name} must be an absolute path`);
  }
  const corpus = path.join(packageRoot, 'corpus');
  const nativePath = value => value.replaceAll('\\', '/');
  const config = nativePath(configHome), skills = nativePath(skillsHome);
  const cliArgs = ['--copilot-home', config, '--skills-home', skills, ...(home === undefined ? [] : ['--ae-home', nativePath(home)])];
  const cliBinding = `For every AE CLI invocation, append these literal argv elements before any \`--\` argument boundary: \`${JSON.stringify(cliArgs)}\`. Preserve the task workspace and host model/tool context; do not rely on ambient corpus-home variables.\n`;
  const packageCli = nativePath(path.join(packageRoot, 'bin/ae.mjs'));
  const cliFallback = `If the \`ae\` command is unavailable on PATH, invoke the installed package directly with literal argv: \`${JSON.stringify(['node', packageCli])}\`, followed by the AE command and arguments. Do not configure another host to repair PATH.\n`;
  const invocationGuide = `Use the installed \`ae\` CLI with the host-approved execution tool.\n\n${cliFallback}\n${cliBinding}\nKeep the product workspace explicit with \`--workspace\` when necessary. Host configuration does not grant project trust or completion authority.\n`;
  const roleSources = sourceFiles(path.join(corpus, 'agents')).filter(file => file.endsWith('.agent.md'));
  const roleNames = roleSources.map(file => path.basename(file, '.agent.md'));
  const translate = text => {
    let result = text.replaceAll('\r\n', '\n').replaceAll('<copilot-home>/skills', skills).replaceAll('~/.copilot/skills', skills)
      .replaceAll('<copilot-home>', config).replaceAll('~/.copilot', config).replaceAll('<skills-root>', skills);
    for (const role of roleNames) result = result.replaceAll(`@${role}`, role === 'engineer' ? 'Engineer' : role);
    result = result.replace(/## Harness CLI \(agents\)\n[\s\S]*?(?=\n## Operating Rules\n)/, `## Harness CLI (agents)\n\n${invocationGuide}`);
    result = result.replace(/## Invocation \(agents\)\n[\s\S]*?(?=\n## Exit codes\n)/, `## Invocation (agents)\n\n${invocationGuide}\nUse \`ae init-repo\` for private per-repository setup; \`--shared\` deliberately publishes team policy. Inspect actual command results and require current accepted proof before mutation or completion.\n`);
    result = result.replace(/## Host hook boundary\n[\s\S]*?(?=\n## Context budget mapping\n)/, `## Host hook boundary\n\nThe selected host's native configuration invokes AE's existing lifecycle authority. Native hook trust, event coverage and completion controls depend on that host. Use \`ae host status --host ${host}\` with the selected binding to inspect configuration; file presence and mechanical probes do not establish live editor qualification. Explicit CLI gate and verify do not intercept unrelated native tools.\n`);
    if (result.includes('# Harness Doctor\n')) {
      result = result.replace(/Select the target from[\s\S]*?(?=\nDoctor is read-only\.)/, `Use \`ae host status --host ${host}\` with the selected corpus/state binding to diagnose this integration. Harness reports owned files, configuration drift and capability limits. Native hook trust and actual task-operation proof remain separate; configured files are not a live-host qualification.\n\n${cliFallback}`);
      result = result.replace(/When an agreed product adapter is available,[^\n]+/, 'The legacy installed-product-proof helper is Copilot-specific; do not use it as evidence of native qualification for this integration.');
    }
    result = result.replaceAll('`ae install`', `\`ae host setup --host ${host}\``);
    return result;
  };
  const files = [];
  const add = (root, rel, content) => files.push({ root, path: rel.replaceAll('\\', '/'), content });
  for (const section of ['skills', 'knowledge', 'enterprise']) {
    const sourceRoot = path.join(corpus, section);
    for (const file of sourceFiles(sourceRoot)) {
      const rel = path.relative(sourceRoot, file);
      let content = translate(fs.readFileSync(file, 'utf8'));
      if (section === 'skills' && /^[^/]+\/SKILL\.md$/.test(rel.replaceAll('\\', '/'))) {
        const doc = splitDocument(content);
        const instructions = rel.replaceAll('\\', '/') === 'engineer/SKILL.md' ? `Read \`${skills}/engineer/references/ae-instructions.md\` with the host read tool and apply the guidance relevant to this task.\n\n` : '';
        const personal = rel.replaceAll('\\', '/') === 'create-primitive/SKILL.md'
          ? `Native personal skills use a schema 1 decision with \`ae resources create skill <name> --file <decision.json>\`. For this writer, use these literal argv elements: \`${JSON.stringify([nativePath(process.execPath), packageCli, 'resources', 'create', 'skill', '<name>', '--file', '<decision.json>', ...cliArgs, '--json'])}\`. Replace only the name and decision-file placeholders. The absolute installed Node executable and package entry point are required; bare ae, harness or node aliases are not admitted for this writer. Native personal agents and instructions are an unmapped capability: stop that creation, prepare a proposal or report the limitation. Do not fall back to Copilot metadata or legacy bundle mutators for a native personal role/instruction.\n\n`
          : '';
        content = markdown(doc.metadata, `${cliBinding}\n${instructions}${personal}${doc.body}`);
      }
      add(section === 'skills' ? 'skills' : 'config', section === 'skills' ? rel : path.join(section, rel), content);
    }
  }
  const instructions = sourceFiles(path.join(corpus, 'instructions')).filter(file => file.endsWith('.instructions.md')).map(file => {
    const doc = splitDocument(translate(fs.readFileSync(file, 'utf8')));
    return { name: path.basename(file, '.instructions.md'), ...doc };
  });
  const shared = translate(fs.readFileSync(path.join(corpus, 'copilot-instructions.md'), 'utf8'));
  add('config', 'copilot-instructions.md', shared);
  const instructionIndex = `# AE instruction selection\n\nApply the conventions whose path patterns match the files under consideration. These declarations do not grant tool permissions or prove native enforcement.\n\n${instructions.map(item => `## ${item.metadata.name || item.name}\n\nApplies to: \`${item.metadata.applyTo || '**'}\`\n\n${item.body.trim()}`).join('\n\n')}\n`;
  add('skills', 'engineer/references/ae-instructions.md', instructionIndex);
  for (const item of instructions) {
    const pattern = item.metadata.applyTo || '**';
    if (host === 'claude-code') add('config', `rules/${item.name}.md`, markdown(pattern === '**' ? {} : { paths: [pattern] }, item.body));
    if (host === 'cursor') add('config', `rules/${item.name}.mdc`, markdown({ description: item.metadata.description || item.name, globs: pattern, alwaysApply: pattern === '**' }, item.body));
  }
  for (const file of roleSources) {
    const name = path.basename(file, '.agent.md');
    const doc = splitDocument(fs.readFileSync(file, 'utf8'));
    const declared = Array.isArray(doc.metadata.tools) ? doc.metadata.tools : [];
    const actor = declared.includes('edit/editFiles');
    const canRead = name === 'engineer' || declared.includes('read');
    const canExecute = name === 'engineer' || declared.includes('execute');
    let body = name === 'engineer'
      ? fs.readFileSync(path.join(corpus, 'skills/engineer/references/contract.md'), 'utf8')
      : doc.body;
    const context = canRead
      ? `Read \`${skills}/engineer/references/ae-instructions.md\` with the host read tool; apply matching conventions.`
      : 'Use the prepared packet and context supplied by the caller. Report missing inputs; do not acquire file-read or execution authority.';
    body = `${canExecute ? `${cliBinding}\n` : ''}${context}\n\n${translate(body)}`;
    if (host === 'claude-code') {
      const tools = [...new Set(declared.flatMap(tool => TOOL_MAP[tool] || []))];
      if (declared.includes('agent') && doc.metadata.agents?.length) tools.unshift(`Agent(${doc.metadata.agents.join(', ')})`);
      add('config', `agents/${name}.md`, markdown({ name, description: doc.metadata.description, tools }, body));
    } else if (host === 'codex') {
      add('config', `agents/${name}.toml`, `name = ${JSON.stringify(name)}\ndescription = ${JSON.stringify(doc.metadata.description)}\ndeveloper_instructions = ${JSON.stringify(body)}\n`);
    } else if (host === 'cursor') {
      add('config', `agents/${name}.md`, markdown({ name, description: doc.metadata.description, readonly: !actor }, body));
    } else add('config', `agents/${name}.md`, markdown({ name, description: doc.metadata.description }, body));
  }
  const limitations = ['Generated assets establish configuration, not live host activation or enforcement.', 'Model selection remains host-owned; required missing tools or independent review must be reported.'];
  if (host === 'claude-code') limitations.push('Claude subagent mode does not preserve the main-thread Agent role allowlist; run Engineer as the main agent when that bound delegation authority is required.');
  if (host === 'codex') limitations.push('Codex agents inherit parent permissions; read-only role prose does not establish role-specific tool isolation.');
  if (host === 'cursor') limitations.push('Cursor stop follow-up has a loop limit and does not establish hard completion blocking.');
  if (host === 'terminal') limitations.push('Terminal integration is manual; role files and explicit CLI gate/verify do not install native hooks or isolated agents.');
  if (host === 'terminal') add('config', 'ae-start.md', `# Start AE in this host\n\n${cliBinding}\nRead \`${skills}/engineer/SKILL.md\` with the host read tool, then follow its shared Engineer contract. Native role isolation and lifecycle hooks are unavailable in this manual integration.\n`);
  return {
    files: files.sort((a, b) => `${a.root}/${a.path}`.localeCompare(`${b.root}/${b.path}`)),
    capabilities: { nativeSkills: host !== 'terminal', nativeAgents: host !== 'terminal', nativeHooks: host !== 'terminal', roleToolIsolation: host === 'claude-code', stopBlocking: ['claude-code', 'codex'].includes(host), personalSkillCreation: true, personalRoleCreation: false },
    limitations,
  };
}
