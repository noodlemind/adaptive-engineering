import { gitExecutable } from '../../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectHostCorpus } from './projection.mjs';

function gitWorkspace(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || /[\u0000-\u001f\u007f]/.test(workspace)) {
    throw new Error('Plugin export requires an absolute existing Git workspace');
  }
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
  try {
    const root = execFileSync(gitExecutable(), ['-C', fs.realpathSync(workspace), 'rev-parse', '--show-toplevel'], {
      env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return fs.realpathSync(root);
  } catch { throw new Error('Plugin export requires an existing Git workspace; plugin cwd is not a default'); }
}

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const ROOT_BINDING = 'Resolve `<skills-root>` to the parent of this skill directory, and `<ae-plugin-root>` to its parent (two levels above this skill directory). For direct CLI calls pass `--copilot-home <ae-plugin-root> --skills-home <skills-root>` (the skills-home flag overrides `AE_SKILLS_HOME`); otherwise use the configured AE MCP tools with their bound workspace.';

/** Build portable package bytes only; the caller owns safe publication. */
export function buildPluginPackage({ packageRoot, workspace }) {
  const boundWorkspace = gitWorkspace(workspace);
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const marker = path.join(os.tmpdir(), '__ae_portable_plugin__');
  const projection = projectHostCorpus({ packageRoot, host: 'terminal', configHome: marker, skillsHome: path.join(marker, 'skills') });
  const portableMarker = marker.replaceAll('\\', '/');
  const portable = text => text.replaceAll(`${portableMarker}/skills`, '<skills-root>').replaceAll(portableMarker, '<ae-plugin-root>')
    .replace(/^If the `ae` command is unavailable on PATH, invoke the installed package directly with literal argv:.*$/gm, 'If `ae` is unavailable on PATH, install a compatible AE CLI separately before using this package. The portable package provides no runtime executable fallback.')
    .replace(/## Host hook boundary\n[\s\S]*?(?=\n## Context budget mapping\n)/, '## Host hook boundary\n\nThis portable package configures no native hooks. MCP guards only operations routed through AE; client permissions and unrelated native tools remain separate. Package loading is not evidence of native activation or independent review.\n');
  const files = projection.files.map(file => {
    let rel = file.root === 'skills' ? `skills/${file.path}` : file.path;
    let content = portable(file.content);
    if (rel.startsWith('agents/')) {
      rel = `skills/engineer/references/specialists/${rel.slice('agents/'.length)}`;
      content = content.replace(/^---\n[\s\S]*?\n---\n\n/, '');
    }
    if (/^skills\/[^/]+\/SKILL\.md$/.test(rel)) {
      content = content.replace(/^(---\n[\s\S]*?\n---\n)/, `$1\n${ROOT_BINDING}\n`);
      if (rel === 'skills/engineer/SKILL.md') content += '\nThis portable package supplies specialist judgment criteria in `references/specialists/`, not native agent registrations. If independent review is required and no qualified native specialist is available, report the missing review capability. Criteria files and MCP discovery do not install native hooks or establish isolated judgment.\n';
      if (rel === 'skills/create-primitive/SKILL.md') content = content.replace(/^Native personal skills .*$/m, 'This portable package has no saved native ownership manifest. Personal resource creation requires an explicitly configured native integration through `ae host setup` first, then that integration\'s selected roots and supported resources command. Copying this package does not establish permission or a native write target; report unsupported personal roles/instructions instead of falling back to Copilot metadata.');
    }
    if (rel === 'skills/references/harness-tool-contract.md') {
      content = content.replace(/^Installed to .*$/m, 'Use the separately installed compatible `ae` CLI. This portable plugin does not install runtime executables or a host-specific CLI shim.');
    }
    return { path: rel, content };
  });
  files.push({ path: 'plugin.json', content: json({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'ae-engineer', version: manifest.version,
    description: 'Shared AE Engineer skills and a workspace-bound interface to an installed AE Harness CLI.',
  }) });
  files.push({ path: 'mcp.json', content: json({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { ae: { type: 'stdio', command: 'ae', args: ['mcp', 'serve', '--workspace', boundWorkspace, '--copilot-home', '${PLUGIN_ROOT}', '--skills-home', '${PLUGIN_ROOT}/skills'] } },
  }) });
  const requirements = [`Node.js >=20 and an installed ae Harness CLI from ae-harness ${manifest.version}.`, 'A client supporting Agent Plugins 1.0 skills and stdio MCP; installation and permissions remain client-managed.', `The explicit Git workspace must remain available: ${boundWorkspace}`];
  const limitations = ['This package does not register native agents or native hooks, install credentials, or grant host/project trust.', 'MCP guards operations routed through AE; unrelated native host tools remain outside that mediation.', 'Specialist references provide criteria, not independent review provenance or role-specific permission isolation.'];
  files.push({ path: 'README.md', content: `# AE Engineer portable package\n\nRequires a separately installed compatible ae Harness CLI and Node.js >=20. Use the same ae-harness version as this package (${manifest.version}); the package contains skills and MCP configuration, not the executable.\n\nThe MCP server is bound to this existing Git workspace: ${boundWorkspace}. It never infers the product workspace from the plugin directory. Export again for a different workspace. The client resolves its own PLUGIN_ROOT for content only.\n\n## Requirements\n\n${requirements.map(line => `- ${line}`).join('\n')}\n\n## Boundaries\n\n${limitations.map(line => `- ${line}`).join('\n')}\n\nThe client owns installation, tool permissions, authentication and presentation. No native activation, executable skill-read evidence, editor qualification or universal enforcement is established by loading this package. Review requirements cannot be satisfied by a role filename or model assertion.\n` });
  const paths = new Set();
  for (const file of files) {
    if (path.posix.isAbsolute(file.path) || file.path.split('/').some(part => !part || part === '..') || paths.has(file.path)) throw new Error(`Invalid portable package path: ${file.path}`);
    paths.add(file.path);
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), requirements, limitations };
}
