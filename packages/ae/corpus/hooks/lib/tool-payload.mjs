import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { authorityBin } from './authority-bin.mjs';
import { windowsEnvironmentValue, spawnGitSync } from './git-executable.mjs';
import { runtimeHome, runtimeSetting, runtimeCopilotHome } from './runtime-identity.mjs';

export const FILE_MUTATION_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'edit',
  'editFiles',
  'multi_replace_string_in_file',
  'replace_string_in_file',
  'insert_edit_into_file',
  'edit_notebook_file',
  'create_new_jupyter_notebook',
  'apply_patch',
  'create_file',
  'createFile',
  'create_new_file',
  'create_directory',
]);

export const TERMINAL_TOOLS = new Set([
  'run_in_terminal',
  'runTerminalCommand',
  'execute',
  'execute/runInTerminal',
  'Bash',
]);

const SKILL_READ_TOOLS = new Set([
  'read',
  'Read',
  'read_file',
  'readFile',
  'copilot_readFile',
  'read_skill',
  'readSkill',
]);

export const READ_ONLY_TOOLS = new Set([
  ...SKILL_READ_TOOLS,
  'grep_search',
  'file_search',
  'list_dir',
  'semantic_search',
  'list_code_usages',
  'get_errors',
  'get_changed_files',
  'get_search_view_results',
  'test_search',
  'github_repo',
  'fetch_webpage',
  'open_file',
  'open_simple_browser',
  'codebase',
  'search',
  'usages',
  'changes',
  'problems',
  'terminalLastCommand',
  'get_terminal_output',
  'think',
  'todos',
]);

const PRIMITIVE_PREFIXES = [
  'packages/ae/corpus/skills/',
  'packages/ae/corpus/agents/',
  'packages/ae/corpus/instructions/',
  'packages/ae/corpus/enterprise/',
  '.github/checks/',
];

const PRIMITIVE_FILES = new Set(['packages/ae/corpus/knowledge/capability-registry.yaml']);

const PERSONAL_WRITE_PREFIXES = [
  '.github/skills/',
  '.github/agents/',
  '.github/instructions/',
  '.github/prompts/',
  'enterprise/skills/',
];

const PERSONAL_WRITE_FILES = new Set(['knowledge/capability-registry.yaml']);

function cleanShellToken(value) {
  const token = String(value || '').trim();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1);
  }
  return token;
}

export function tokenizeShell(segment) {
  return [...segment.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g)].map((match) => cleanShellToken(match[0]));
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const POWERSHELLS = new Set(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);
const PREFIX_UTILS = new Set(['timeout', 'nice', 'stdbuf', 'time', 'ionice', 'xargs']);
const PREFIX_VALUE_FLAGS = new Set([
  '-k', '--kill-after', '-s', '--signal',
  '-n', '--adjustment',
  '-c', '--class',
  '-i', '-o', '-e',
  '-I', '-J', '-L', '-P', '-E',
  '--replace', '--max-lines', '--max-args', '--max-procs', '--eof',
  '-a', '--arg-file',
]);

function takeEnvSplitString(normalized) {
  const arg = normalized[0];
  if (arg === '-S' || arg === '--split-string') {
    const payload = normalized[1];
    normalized.splice(0, 2);
    if (payload) normalized.unshift(...tokenizeShell(payload));
    return true;
  }
  if (arg.startsWith('--split-string=')) {
    normalized.shift();
    const payload = arg.slice('--split-string='.length);
    if (payload) normalized.unshift(...tokenizeShell(payload));
    return true;
  }
  return false;
}

/** Strip env/command/nohup/timeout wrappers and VAR=value prefixes from a token list. */
export function unwrapLeadingWrappers(tokens) {
  const normalized = tokens.slice();
  let progressed = true;
  while (progressed) {
    progressed = false;
    while (normalized[0] && ASSIGNMENT.test(normalized[0])) {
      normalized.shift();
      progressed = true;
    }
    const base = path.basename(normalized[0] || '').toLowerCase();
    if (base === 'env') {
      normalized.shift();
      while (normalized.length) {
        if (ASSIGNMENT.test(normalized[0])) normalized.shift();
        else if (normalized[0] === '--') {
          normalized.shift();
          break;
        } else if (takeEnvSplitString(normalized)) break;
        else if (normalized[0] === '-u' || normalized[0] === '--unset' || normalized[0] === '-C' || normalized[0] === '--chdir') {
          normalized.splice(0, 2);
        } else if (/^--(?:unset|chdir)=/.test(normalized[0]) || /^-(?:i|0)$/.test(normalized[0]) || normalized[0] === '--ignore-environment') {
          normalized.shift();
        } else break;
      }
      progressed = true;
    } else if (base === 'command' || base === 'nohup') {
      normalized.shift();
      if (base === 'command') {
        if (normalized[0] === '-p' || normalized[0] === '-v' || normalized[0] === '-V') normalized.shift();
        if (normalized[0] === '--') normalized.shift();
      } else {
        while (normalized[0]?.startsWith('-')) normalized.shift();
      }
      progressed = true;
    } else if (PREFIX_UTILS.has(base)) {
      const util = base;
      normalized.shift();
      while (normalized.length) {
        const arg = normalized[0];
        if (arg === '--') {
          normalized.shift();
          break;
        }
        if (arg.startsWith('--') && arg.includes('=')) {
          normalized.shift();
          continue;
        }
        if (PREFIX_VALUE_FLAGS.has(arg)) {
          normalized.splice(0, 2);
          continue;
        }
        if (arg.startsWith('-')) {
          normalized.shift();
          continue;
        }
        break;
      }
      if (util === 'timeout' && /^\d/.test(normalized[0] || '')) normalized.shift();
      if (util === 'nice' && /^[+-]?\d+$/.test(normalized[0] || '')) normalized.shift();
      progressed = true;
    }
  }
  return normalized;
}

/** Split a command into unwrapped argv segments, recursing into sh/bash/pwsh -c. */
export function unwrapShellSegments(command) {
  const out = [];
  function collect(text) {
    for (const segment of String(text || '').split(/(?:&&|\|\||[;|\n])/)) {
      const tokens = unwrapLeadingWrappers(tokenizeShell(segment));
      if (!tokens.length) continue;
      const exe = path.basename(tokens[0] || '').toLowerCase();
      if (POSIX_SHELLS.has(exe)) {
        const flagIndex = tokens.findIndex((token, index) => index > 0 && /^-[A-Za-z]*c$/.test(token));
        const nested = flagIndex > 0 ? tokens[flagIndex + 1] : null;
        if (nested) collect(nested);
        continue;
      }
      if (POWERSHELLS.has(exe)) {
        const flagIndex = tokens.findIndex((token, index) => index > 0 && /^-c(?:ommand)?$/i.test(token));
        const nested = flagIndex > 0 ? tokens[flagIndex + 1] : null;
        if (nested) collect(nested);
        continue;
      }
      out.push(tokens);
    }
  }
  collect(command);
  return out;
}

function withoutRedirections(args) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (/^(?:\d*>>?\|?|&>>?)$/.test(args[i])) {
      i += 1;
      continue;
    }
    if (/^(?:\d*>>?\|?|&>>?).+/.test(args[i])) continue;
    result.push(args[i]);
  }
  return result;
}

function parseGitInvocation(args) {
  const valueOptions = new Set([
    '-C',
    '-c',
    '--exec-path',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--super-prefix',
    '--config-env',
  ]);
  let cwd = '';
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '-C') {
      const value = args[index + 1];
      if (!value) return { subcommand: null, args: [], cwd };
      cwd = path.isAbsolute(value) ? value : path.join(cwd, value);
      index += 2;
      continue;
    }
    if (valueOptions.has(arg)) {
      index += 2;
      continue;
    }
    if (/^--(?:exec-path|git-dir|work-tree|namespace|super-prefix|config-env)=/.test(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      index += 1;
      continue;
    }
    return { subcommand: arg, args: args.slice(index + 1), cwd };
  }
  return { subcommand: null, args: [], cwd };
}

function withGitCwd(cwd, targets) {
  return targets.map((target) => (path.isAbsolute(target) || !cwd ? target : path.join(cwd, target)));
}

function withoutHeredocBodies(commandText) {
  let delimiter = null;
  return String(commandText || '')
    .split('\n')
    .map((line) => {
      if (delimiter) {
        if (line.trim() === delimiter) {
          delimiter = null;
          return '';
        }
        return '';
      }
      const opener = line.match(/<<-?\s*(?:(['"])([^'"]+)\1|([A-Za-z0-9_]+))\s*$/);
      if (opener) delimiter = opener[2] || opener[3];
      return line;
    })
    .join('\n');
}

const POWERSHELL_WRITERS = new Set([
  'set-content',
  'add-content',
  'clear-content',
  'out-file',
  'new-item',
  'copy-item',
  'move-item',
  'rename-item',
  'remove-item',
  'tee-object',
]);

const POWERSHELL_PATH_PARAMS = /^-(?:path|literalpath|filepath|destination|newname|outfile)$/i;

export function analyzeShellMutation(command) {
  const targets = [];
  const mkdirCreated = [];
  let mutation = false;
  const commandText = String(command || '');
  const shellControlText = withoutHeredocBodies(commandText);
  const shellRedirections = new Set(terminalSegments(shellControlText).redirections);
  const redirection = /(?<![<>])(?:\d*>>?\|?|&>>?)\s*("(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|]+)/g;
  for (const match of shellControlText.matchAll(redirection)) {
    if (!shellRedirections.has(match.index + match[0].indexOf('>'))) continue;
    const target = cleanShellToken(match[1]);
    if (target.startsWith('&') || /^\/dev\/(?:null|stdout|stderr)$/.test(target)) continue;
    mutation = true;
    targets.push(target);
  }

  const interpreterWrite = /(?:^|[;&|]\s*)(?:python\d*|node|ruby)\b[\s\S]*\b(?:write_text|write_bytes|writeFile(?:Sync)?|appendFile(?:Sync)?|rmSync|mkdirSync|renameSync|copyFileSync|File\.write|File\.open)\s*\(/m;
  const mutatingOpen = /\bopen\s*\(\s*(['"])([^'"]+)\1\s*,\s*(['"])[wa+][^'"]*\3/g;
  const interpreterInvocation = unwrapShellSegments(shellControlText).some(tokens => /^(?:python\d*|node|ruby)$/.test(path.basename(tokens[0] || '')));
  if (interpreterInvocation && (interpreterWrite.test(commandText) || mutatingOpen.test(commandText))) {
    mutation = true;
    for (const match of commandText.matchAll(/\b(?:pathlib\.)?Path\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
      targets.push(match[2]);
    }
    for (const match of commandText.matchAll(/\bopen\s*\(\s*(['"])([^'"]+)\1/g)) {
      targets.push(match[2]);
    }
  }

  for (const segment of shellControlText.split(/(?:&&|\|\||[;|\n])/)) {
    const tokens = unwrapLeadingWrappers(tokenizeShell(segment));
    const executable = path.basename(tokens[0] || '').toLowerCase();
    const args = withoutRedirections(tokens.slice(1));
    const positional = args.filter((arg) => !arg.startsWith('-'));

    if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(executable)) {
      const flagIndex = tokens.findIndex((token, index) => index > 0 && /^-[A-Za-z]*c$/.test(token));
      const nestedCommand = flagIndex > 0 ? tokens[flagIndex + 1] : null;
      if (nestedCommand) {
        const nested = analyzeShellMutation(nestedCommand);
        if (nested.mutation) mutation = true;
        targets.push(...nested.targets);
        mkdirCreated.push(...nested.mkdirTargets);
      }
      continue;
    }
    if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(executable)) {
      const flagIndex = tokens.findIndex((token, index) => index > 0 && /^-c(?:ommand)?$/i.test(token));
      const nestedCommand = flagIndex > 0 ? tokens[flagIndex + 1] : null;
      if (nestedCommand) {
        const nested = analyzeShellMutation(nestedCommand);
        if (nested.mutation) mutation = true;
        targets.push(...nested.targets);
        mkdirCreated.push(...nested.mkdirTargets);
      }
      continue;
    }
    if (POWERSHELL_WRITERS.has(executable)) {
      mutation = true;
      const named = [];
      const bare = [];
      const valueParams = /^-(?:value|itemtype|encoding|name)$/i;
      for (let index = 0; index < args.length; index += 1) {
        if (POWERSHELL_PATH_PARAMS.test(args[index])) {
          if (args[index + 1] && !args[index + 1].startsWith('-')) named.push(args[index + 1]);
          index += 1;
        } else if (valueParams.test(args[index])) {
          index += 1;
        } else if (!args[index].startsWith('-')) {
          bare.push(args[index]);
        }
      }
      // Positional form is `Set-Content <path> <value>`; only the first operand
      // is a path, and none are once -Path/-LiteralPath is given explicitly.
      const positionalPaths = ['set-content', 'add-content'].includes(executable)
        ? named.length
          ? []
          : bare.slice(0, 1)
        : bare;
      const cmdletTargets = [...named, ...positionalPaths];
      targets.push(...cmdletTargets);
      if (executable === 'new-item' && args.some((arg, index) => /^-itemtype$/i.test(arg) && /^dir/i.test(args[index + 1] || ''))) {
        mkdirCreated.push(...cmdletTargets);
      }
      continue;
    }

    if (['touch', 'rm', 'rmdir', 'unlink', 'truncate', 'del', 'erase', 'rd'].includes(executable)) {
      mutation = true;
      targets.push(...positional);
    } else if (executable === 'mkdir' || executable === 'md') {
      mutation = true;
      targets.push(...positional);
      mkdirCreated.push(...positional);
    } else if (executable === 'dd') {
      for (const arg of args) {
        const output = arg.match(/^of=(.+)$/);
        if (output) {
          mutation = true;
          targets.push(cleanShellToken(output[1]));
        }
      }
    } else if (['cp', 'install'].includes(executable)) {
      mutation = true;
      if (positional.length) targets.push(positional.at(-1));
    } else if (['mv', 'ln'].includes(executable)) {
      mutation = true;
      targets.push(...positional);
    } else if (executable === 'tee') {
      const teeTargets = args.filter((arg) => !arg.startsWith('-') && !arg.startsWith('/dev/'));
      if (teeTargets.length) {
        mutation = true;
        targets.push(...teeTargets);
      }
    } else if (
      ['sed', 'perl'].includes(executable) &&
      args.some((arg) => /^-[^-]*i/.test(arg) || (executable === 'sed' && /^--in-place(?:=|$)/.test(arg)))
    ) {
      mutation = true;
      if (positional.length > 1) targets.push(...positional.slice(1));
    } else if (executable === 'git') {
      const git = parseGitInvocation(args);
      if (
        ['apply', 'checkout', 'restore', 'rm', 'mv', 'clean', 'reset', 'stash', 'switch', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'pull'].includes(
          git.subcommand
        )
      ) {
        mutation = true;
        const separator = git.args.indexOf('--');
        let gitTargets = separator >= 0 ? git.args.slice(separator + 1) : [];
        if (separator < 0 && ['restore', 'rm', 'mv', 'clean'].includes(git.subcommand)) {
          gitTargets = git.args.filter((arg) => !arg.startsWith('-'));
        }
        targets.push(...withGitCwd(git.cwd, gitTargets));
      }
    }
  }

  // The planned-ancestor exception is only safe for paths that mkdir alone
  // touches: a compound command that also mutates the same path (for example
  // `mkdir -p src && rm -rf src`) gets no exception for it.
  const mkdirOnly = new Set(mkdirCreated);
  for (const target of targets) {
    let occurrences = 0;
    for (const candidate of targets) if (candidate === target) occurrences += 1;
    let created = 0;
    for (const candidate of mkdirCreated) if (candidate === target) created += 1;
    if (occurrences > created) mkdirOnly.delete(target);
  }
  return { mutation, targets, mkdirTargets: [...mkdirOnly] };
}

const QUERY_COMMANDS = new Set(['cat', 'ls', 'pwd', 'rg', 'grep', 'head', 'tail', 'wc', 'echo', 'printf', 'which', 'where', 'type', 'true', 'false']);
const POWERSHELL_QUERIES = new Set(['get-content', 'get-item', 'get-childitem', 'get-location', 'select-string', 'test-path', 'write-output']);
const EXPLICIT_WRITERS = new Set(['touch', 'rm', 'rmdir', 'unlink', 'truncate', 'del', 'erase', 'rd', 'mkdir', 'md', 'dd', 'cp', 'install', 'mv', 'ln', 'tee', ...POWERSHELL_WRITERS]);
const GIT_QUERIES = new Set(['status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'describe', 'blame', 'grep', 'check-ignore', 'version']);
const GIT_DIFF_QUERIES = new Set(['status', 'diff', 'log', 'show', 'blame', 'grep']);
const GIT_INDEX_QUERIES = new Set(['status', 'diff', 'ls-files', 'blame', 'grep', 'check-ignore']);
const GIT_HELPER_CONFIG = '^(core\\.(fsmonitor|pager|alternaterefscommand)|pager\\..*|diff\\.(external|.*\\.(command|textconv))|filter\\..*\\.(clean|smudge|process)|log\\.showsignature)$';
const HARNESS_CONTROL = new Set(['plan-new', 'plan-update', 'gate', 'worktree', 'verify', 'review', 'compound', 'status', 'orient', 'prepare', 'index', 'graph', 'recall', 'help', '--help', '-h', '--version', '-V', 'validate-plan', 'doctor', 'route']);

function terminalSegments(command) {
  const segments = [];
  let start = 0;
  let quote = null;
  let ambiguous = false;
  let opaqueExpansion = false;
  let redirection = false;
  const redirections = [];
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === '\\' && quote !== "'") { if (!quote) ambiguous = true; index += 1; continue; }
    if (char === quote) {
      if (command[index + 1] && !/[\s;&|]/.test(command[index + 1])) ambiguous = true;
      quote = null;
      continue;
    }
    if (!quote && (char === '"' || char === "'")) {
      if (index > 0 && !/[\s;&|]/.test(command[index - 1])) ambiguous = true;
      quote = char;
      continue;
    }
    if (quote === "'") continue;
    if (char === '`' || char === '$') ambiguous = true;
    if (quote) continue;
    if (char === '<' || char === '>') { redirection = true; redirections.push(index); }
    if (/[*?\[\]~]/.test(char)) opaqueExpansion = true;
    if (/[(){}]/.test(char) || (char === '&' && command[index + 1] !== '&' && command[index - 1] !== '&')) ambiguous = true;
    if (char === ';' || char === '|' || char === '\n' || (char === '&' && command[index + 1] === '&')) {
      segments.push(command.slice(start, index));
      if ((char === '|' || char === '&') && command[index + 1] === char) index += 1;
      start = index + 1;
    }
  }
  segments.push(command.slice(start));
  return { segments: segments.filter(segment => segment.trim()), ambiguous: ambiguous || Boolean(quote), opaqueExpansion, redirection, redirections };
}

function expandingHeredoc(command) {
  let delimiter = null;
  let literal = false;
  for (const line of command.split('\n')) {
    if (delimiter) {
      if (line.trim() === delimiter) delimiter = null;
      else if (!literal && /[$`]/.test(line)) return true;
      continue;
    }
    const opener = line.match(/<<-?\s*(?:(['"])([^'"]+)\1|([A-Za-z0-9_]+))\s*$/);
    if (opener) { delimiter = opener[2] || opener[3]; literal = Boolean(opener[1]); }
  }
  return false;
}

function isSystemCommand(token, base) {
  return token === base || token === `/usr/bin/${base}` || token === `/bin/${base}`;
}

function windowsGitQueryShadow(workspace) {
  const names = new Set(['git', 'git.exe', 'git.com', 'git.cmd', 'git.bat', 'git.ps1']);
  for (const suffix of (windowsEnvironmentValue(process.env, 'PATHEXT') || '').split(';')) {
    const extension = suffix.trim().toLowerCase();
    if (extension && !/[\\/\x00-\x1f\x7f]/.test(extension)) names.add(`git${extension.startsWith('.') ? extension : `.${extension}`}`);
  }
  const directories = new Set([workspace]);
  for (const entry of (windowsEnvironmentValue(process.env, 'PATH') || '').split(';')) {
    const directory = entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
    // Drive-relative and root-relative entries also depend on the execution cwd.
    if (directory && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(directory)) directories.add(path.resolve(workspace, directory));
  }
  for (const directory of directories) {
    try {
      if (fs.readdirSync(directory, { withFileTypes: true }).some(entry => names.has(entry.name.toLowerCase()) && !entry.isDirectory())) return true;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return true;
    }
  }
  return false;
}

function gitQueryIsResolved(tokens, git, workspace) {
  const args = tokens.slice(1);
  if (!GIT_QUERIES.has(git.subcommand) || args[0] !== git.subcommand) return false;
  if (args.some(arg => /^--(?:output|exec-path|config-env|ext-diff|textconv|open-files-in-pager|show-signature)(?:=|$)/.test(arg)
    || git.subcommand === 'grep' && /^(?:-[^-]*O|--op)/.test(arg) || /%G[?NGSKFPTR]/.test(arg))) return false;
  if (process.platform === 'win32' && tokens[0] === 'git' && windowsGitQueryShadow(workspace)) return false;
  if (git.subcommand === 'version') return true;
  if (GIT_DIFF_QUERIES.has(git.subcommand) && process.env.GIT_EXTERNAL_DIFF) return false;
  const result = spawnGitSync(['--no-pager', 'config', '--includes', '--null', '--get-regexp', GIT_HELPER_CONFIG], {
    cwd: workspace, encoding: 'utf8', timeout: 1000, maxBuffer: 64 * 1024, windowsHide: true,
  });
  if (result.error || ![0, 1].includes(result.status) || result.status === 1 && result.stdout) return false;
  const config = new Map();
  for (const entry of String(result.stdout || '').split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\n');
    const key = (separator < 0 ? entry : entry.slice(0, separator)).toLowerCase();
    if (!/^[a-z][a-z0-9.-]*$/.test(key)) return false;
    config.set(key, separator < 0 ? '' : entry.slice(separator + 1));
  }
  const boolean = /^(?:true|false|yes|no|on|off|1|0)$/i;
  const disabled = /^(?:false|no|off|0|)$/i;
  const fsmonitor = config.get('core.fsmonitor');
  if (GIT_INDEX_QUERIES.has(git.subcommand) && fsmonitor && !boolean.test(fsmonitor)) return false;
  if (GIT_DIFF_QUERIES.has(git.subcommand) && [...config].some(([key, value]) => value
    && (/^diff\.(?:external|.*\.(?:command|textconv))$/.test(key) || /^filter\..*\.(?:clean|smudge|process)$/.test(key)))) return false;
  if (args.includes('--alternate-refs') && config.get('core.alternaterefscommand')) return false;
  if (['log', 'show'].includes(git.subcommand) && config.has('log.showsignature') && !disabled.test(config.get('log.showsignature'))) return false;
  const pagerSetting = config.get(`pager.${git.subcommand}`);
  if (pagerSetting !== undefined && disabled.test(pagerSetting)) return true;
  if (pagerSetting && !boolean.test(pagerSetting)) return false;
  const pager = process.env.GIT_PAGER ?? config.get('core.pager') ?? process.env.PAGER;
  return !pager || ['cat', '/bin/cat', '/usr/bin/cat'].includes(pager);
}

function nativeResourcePath(full, kind, missing = false) {
  if (typeof full !== 'string' || !path.isAbsolute(full) || Buffer.byteLength(full) > 4096 || /[\x00-\x1f\x7f]/.test(full)) return false;
  const resolved = path.resolve(full), base = path.parse(resolved).root;
  let current = base;
  const parts = path.relative(base, resolved).split(path.sep).filter(Boolean);
  for (let index = 0; index <= parts.length; index++) {
    if (index) current = path.join(current, parts[index - 1]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return missing;
    if (stat.isSymbolicLink() || (index < parts.length || kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) return false;
  }
  return true;
}

function nativeResourceObject(full) {
  if (!nativeResourcePath(full, 'file')) return null;
  const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = fs.fstatSync(fd), max = 1024 * 1024;
    if (!stat.isFile() || stat.size > max) return null;
    const bytes = Buffer.alloc(max + 1);
    let total = 0, count;
    while ((count = fs.readSync(fd, bytes, total, bytes.length - total, null)) > 0) {
      total += count;
      if (total > max) return null;
    }
    const value = JSON.parse(bytes.subarray(0, total).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } finally { fs.closeSync(fd); }
}

const CONFIGURATION_ROOT_FLAGS = ['--workspace', '--copilot-home', '--skills-home', '--ae-home', '--harness-home'];
const CONTROL_BOOLEAN_FLAGS = new Set(['--json', '--dry-run', '--no-events', '--no-color', '--verbose', '-v']);

function boundedControlFlags(args, start, extra = [], { repeatable = [], additionalBoolean = [] } = {}) {
  const valued = new Set([...CONFIGURATION_ROOT_FLAGS, ...extra]);
  const seen = new Set(), values = new Map();
  for (let index = start; index < args.length; index++) {
    const token = args[index], split = token.indexOf('='), name = split < 0 ? token : token.slice(0, split);
    const key = name === '-v' ? '--verbose' : name === '--harness-home' ? '--ae-home' : name;
    if (seen.has(key) && !repeatable.includes(key)) return null;
    seen.add(key);
    if ((CONTROL_BOOLEAN_FLAGS.has(name) || additionalBoolean.includes(name) || name === '--read') && split < 0) {
      if (name === '--read' && args[0] !== 'orient') return null;
      continue;
    }
    if (!valued.has(name)) return null;
    const value = split < 0 ? args[++index] : token.slice(split + 1);
    if (!value || value.startsWith('-') && !(name === '--file' && value === '-') || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null;
    // Keep the hook's interpretation identical to the CLI's copilot-home parser.
    if (name === '--copilot-home' && split >= 0 && value.includes('=')) return null;
    values.set(key, value);
  }
  return values;
}

function selectedControlRoots(values, workspace) {
  if (!values || !path.isAbsolute(values.get('--workspace') || '') || path.resolve(values.get('--workspace')) !== path.resolve(workspace)
    || !nativeResourcePath(values.get('--workspace'), 'directory')) return false;
  const home = runtimeHome();
  const copilot = runtimeCopilotHome();
  const skills = runtimeSetting('SKILLS_HOME') || path.join(copilot, 'skills');
  runtimeSetting('HOST'); // Conflicting native aliases cannot select a different binding.
  for (const [flag, selected] of [['--ae-home', home], ['--copilot-home', copilot], ['--skills-home', skills]]) {
    if (!values.has(flag)) continue;
    const value = values.get(flag);
    if (!path.isAbsolute(value) || path.resolve(value) !== path.resolve(selected) || !nativeResourcePath(value, 'directory', flag === '--ae-home')) return false;
  }
  return true;
}

/** Configuration authorship cannot execute checks, approve trust or edit policy. */
function checkConfigurationControl(args, workspace) {
  if (args[1] !== 'configure') return null;
  try {
    const values = boundedControlFlags(args, 2, ['--file']);
    return values?.get('--file') === '-' && selectedControlRoots(values, workspace) ? 'checks' : null;
  } catch { return null; }
}

/** Only installed, bounded non-executing commands recover a changed manifest. */
export function checkConfigurationRecoveryControl(tokens, workspace) {
  try {
    const bin = authorityBin();
    if (!bin || tokens.length < 3 || !path.isAbsolute(tokens[0]) || !path.isAbsolute(tokens[1])
      || path.resolve(tokens[0]) !== path.resolve(process.execPath) || path.resolve(tokens[1]) !== path.resolve(bin)
      || fs.realpathSync.native(tokens[0]) !== fs.realpathSync.native(process.execPath)
      || fs.realpathSync.native(tokens[1]) !== fs.realpathSync.native(bin)) return null;
    const args = tokens.slice(2), command = args[0];
    if (command === 'checks' && args[1] === 'configure') return checkConfigurationControl(args, workspace);
    let start = 1, extra = [], repeatable = [];
    if (command === 'checks') {
      if (!['list', 'show'].includes(args[1])) return null;
      start = args[1] === 'show' ? 3 : 2;
      if (args[1] === 'show' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args[2] || '')) return null;
    } else if (command === 'trust') {
      if (args[1] !== 'status') return null;
      start = 2;
    } else if (command === 'plan-new') extra = ['--file'];
    else if (command === 'plan-update') extra = ['--plan', '--file'];
    else if (command === 'orient') { extra = ['--plan', '--query', '--file', '--context-version', '--intent-page', '--intent-page-size']; repeatable = ['--file']; }
    else return null;
    const values = boundedControlFlags(args, start, extra, { repeatable });
    if (!selectedControlRoots(values, workspace)) return null;
    if (['plan-new', 'plan-update'].includes(command) && values.get('--file') !== '-') return null;
    if (command === 'plan-update' && !values.has('--plan')) return null;
    return command;
  } catch { return null; }
}

/** The native writer owns schema/CAS checks; this admits only its saved binding. */
function nativePersonalSkillControl(args, workspace) {
  if (args[1] !== 'create' || !['skill', 'agent', 'instruction'].includes(args[2]) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args[3] || '')) return null;
  const boolean = new Set(['--json', '--dry-run', '--no-events', '--no-color', '--verbose', '-v']);
  const valued = new Set(['--file', '--workspace', '--copilot-home', '--skills-home', '--ae-home', '--harness-home']);
  const seen = new Set(), values = new Map();
  for (let index = 4; index < args.length; index++) {
    const token = args[index], split = token.indexOf('='), name = split < 0 ? token : token.slice(0, split);
    const key = name === '-v' ? '--verbose' : name === '--harness-home' ? '--ae-home' : name;
    if (seen.has(key)) return null;
    seen.add(key);
    if (boolean.has(name) && split < 0) continue;
    if (!valued.has(name)) return null;
    const value = split < 0 ? args[++index] : token.slice(split + 1);
    if (!value || value.startsWith('-') && !(name === '--file' && value === '-') || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null;
    // The CLI's copilot-home equals form takes only the first '=' component.
    if (name === '--copilot-home' && split >= 0 && value.includes('=')) return null;
    values.set(key, value);
  }
  try {
    const host = runtimeSetting('HOST');
    if (!host || ['copilot', 'copilot-cli', 'copilot-vscode', 'copilot-intellij'].includes(host)) {
      if (values.has('--skills-home') || runtimeSetting('SKILLS_HOME')) return null;
      if (!values.has('--workspace')) values.set('--workspace', workspace);
      if (!selectedControlRoots(values, workspace) || !values.has('--copilot-home') || !values.has('--ae-home')) return null;
      const config = path.resolve(runtimeCopilotHome()), state = path.resolve(runtimeHome());
      if (path.resolve(values.get('--copilot-home')) !== config || path.resolve(values.get('--ae-home')) !== state) return null;
      const lock = nativeResourceObject(path.join(config, '.harness-lock.json'));
      if (lock?.lockVersion !== 2 || lock.package !== 'ae-harness' || lock.installationRoot !== config
        || !Array.isArray(lock.targets) || !lock.targets.length || lock.targets.some(target => !['cli', 'vscode', 'intellij'].includes(target))
        || !Array.isArray(lock.files) || lock.files.some(file => typeof file !== 'string' || !file || path.isAbsolute(file) || path.win32.isAbsolute(file) || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..'))) return null;
      const installed = authorityBin({ includeOverride: false });
      if (!installed || ![path.join(config, '.ae-bin/bin/ae.mjs'), path.join(config, '.harness-bin/bin/harness.mjs')].includes(path.resolve(installed))
        || path.resolve(authorityBin()) !== path.resolve(installed)) return null;
      const input = values.get('--file');
      if (!input || input !== '-' && !nativeResourcePath(path.resolve(workspace, input), 'file')) return null;
      const destination = args[2] === 'skill' ? `skills/${args[3]}/SKILL.md`
        : args[2] === 'agent' ? `agents/${args[3]}.agent.md` : `instructions/${args[3]}.instructions.md`;
      if (lock.files.includes(destination) || !nativeResourcePath(path.join(config, destination), 'file', true)) return null;
      return 'resources';
    }
    if (!['claude-code', 'codex', 'cursor', 'terminal'].includes(host) || process.env.HARNESS_HOST && process.env.HARNESS_HOST !== host) return null;
    const bindings = [['--copilot-home', process.env.COPILOT_HOME], ['--skills-home', process.env.AE_SKILLS_HOME], ['--ae-home', process.env.AE_HOME]];
    for (const [flag, selected] of bindings) {
      const value = values.get(flag);
      if (!value || !selected || !path.isAbsolute(value) || !path.isAbsolute(selected) || path.resolve(value) !== path.resolve(selected)
        || !nativeResourcePath(value, 'directory', flag === '--ae-home')) return null;
    }
    if (process.env.HARNESS_SKILLS_HOME && path.resolve(process.env.HARNESS_SKILLS_HOME) !== path.resolve(process.env.AE_SKILLS_HOME)
      || process.env.HARNESS_HOME && path.resolve(process.env.HARNESS_HOME) !== path.resolve(process.env.AE_HOME)) return null;
    if (values.has('--workspace') && path.resolve(values.get('--workspace')) !== path.resolve(workspace)) return null;
    const config = path.resolve(values.get('--copilot-home')), skills = path.resolve(values.get('--skills-home'));
    const manifest = nativeResourceObject(path.join(config, '.ae-host.json')), owner = nativeResourceObject(path.join(skills, '.ae-host-skills.json'));
    if (manifest?.schema !== 1 || owner?.schema !== 1 || manifest.host !== host || owner.host !== host || manifest.configHome !== config || owner.configHome !== config
      || manifest.skillsHome !== skills || owner.skillsHome !== skills || !Array.isArray(manifest.files)) return null;
    for (const file of manifest.files) {
      if (!file || typeof file !== 'object' || !['config', 'skills'].includes(file.root) || typeof file.path !== 'string' || path.isAbsolute(file.path)
        || file.path.includes('\\') || file.path.split('/').some(part => !part || part === '.' || part === '..') || typeof file.owned !== 'boolean' || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) return null;
      if (args[2] === 'skill' && file.root === 'skills' && file.path.startsWith(`${args[3]}/`)) return null;
    }
    const input = values.get('--file');
    if (!input || input !== '-' && !nativeResourcePath(path.resolve(workspace, input), 'file')) return null;
    const destination = args[2] === 'skill' ? path.join(skills, args[3], 'SKILL.md')
      : args[2] === 'agent' ? path.join(config, 'agents', `${args[3]}${host === 'codex' ? '.toml' : '.md'}`)
        : path.join(config, host === 'codex' ? 'instructions' : 'rules', `${args[3]}${host === 'cursor' ? '.mdc' : '.md'}`);
    if (!nativeResourcePath(destination, 'file', true)) return null;
    return 'resources';
  } catch { return null; }
}

/** Preparing/recording a native verdict cannot grant consent or execute a product action. */
function nativeDecisionControl(args, workspace) {
  if (args[1] !== 'decision' && args[1] !== 'discover') return null;
  try {
    const values = boundedControlFlags(args, 2, args[1] === 'decision' ? ['--file'] : ['--query', '--limit'], { additionalBoolean: args[1] === 'discover' ? ['--refresh'] : [] });
    if (!values) return null;
    if (!values.has('--workspace')) values.set('--workspace', workspace);
    if (!selectedControlRoots(values, workspace)) return null;
    if (args[1] === 'decision') {
      const input = values.get('--file');
      if (!input || input !== '-' && !nativeResourcePath(path.resolve(workspace, input), 'file')) return null;
    } else if (args.includes('--refresh') && !args.includes('--json')) {
      return null;
    }
    return 'resources';
  } catch { return null; }
}

export function harnessControlCommand(tokens, workspace) {
  let args, nativeWriterAuthority = false;
  if (tokens[0] === 'ae' || tokens[0] === 'harness') args = tokens.slice(1);
  else if ((tokens[0] === 'node' || path.isAbsolute(tokens[0] || '') && path.resolve(tokens[0]) === path.resolve(process.execPath)) && tokens[1]) {
    const bin = authorityBin();
    if (!bin) return null;
    try {
      if (fs.realpathSync(path.resolve(workspace, tokens[1])) !== fs.realpathSync(bin)) return null;
      nativeWriterAuthority = path.isAbsolute(tokens[0]) && path.isAbsolute(tokens[1]) && path.resolve(tokens[1]) === path.resolve(bin)
        && fs.realpathSync.native(tokens[0]) === fs.realpathSync.native(process.execPath);
    } catch { return null; }
    args = tokens.slice(2);
  } else return null;
  if (!args.length) return 'help';
  if (HARNESS_CONTROL.has(args[0])) return args[0];
  if (args[0] === 'checks' && args[1] === 'configure') return nativeWriterAuthority ? checkConfigurationControl(args, workspace) : null;
  if (args[0] === 'resources') return nativeWriterAuthority ? nativeDecisionControl(args, workspace) || nativePersonalSkillControl(args, workspace) : null;
  if (args[0] === 'diagrams') {
    // Hydrated hooks cannot import package lib/. Keep this bounded grammar in
    // step with diagram-cmd.mjs; diagram-native tests cover the shared forms.
    const verb = args[1], options = {
      render: ['--file', '--sources', '--renderer', '--layout', '--timeout', '--scale'],
      graph: ['--root', '--operation', '--depth', '--limit', '--max-nodes', '--timeout', '--scale'],
      flow: ['--flow', '--limit', '--max-nodes', '--timeout', '--scale'],
      status: ['--receipt'],
    };
    if (!Object.hasOwn(options, verb)) return null;
    const boolean = new Set(['--json', '--dry-run', '--no-events', '--no-color', '--verbose', '-v', ...(verb === 'status' ? [] : ['--png'])]);
    const valued = new Set(['--workspace', '--ae-home', '--harness-home', '--copilot-home', '--skills-home', '--output', ...options[verb]]);
    const seen = new Set(), values = new Map();
    for (let index = 2; index < args.length; index++) {
      const token = args[index], split = token.indexOf('='), name = split < 0 ? token : token.slice(0, split), key = name === '-v' ? '--verbose' : name;
      if (seen.has(key)) return null;
      seen.add(key);
      if (boolean.has(name) && split < 0) continue;
      if (!valued.has(name)) return null;
      const value = split < 0 ? args[++index] : token.slice(split + 1);
      if (!value || value.startsWith('-') || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null;
      values.set(name, value);
    }
    const required = { render: '--file', graph: '--root', flow: '--flow', status: '--receipt' }[verb];
    if (!values.has(required)) return null;
    const contained = (value, scope = false) => {
      if (scope && value === '.') return true;
      return value.length <= 1024 && !/[\x00-\x1f\x7f\\:]/.test(value) && !path.isAbsolute(value) && !path.win32.isAbsolute(value)
        && !value.split('/').some(part => !part || part === '.' || part === '..' || scope && ['.git', '.harness', 'node_modules'].includes(part.toLowerCase()));
    };
    for (const key of ['--file', '--root', '--receipt']) if (values.has(key) && !contained(values.get(key))) return null;
    if (values.has('--sources') && values.get('--sources').split(',').some(value => !contained(value.trim(), true))) return null;
    const file = values.get('--file');
    if (file && !/\.(?:mmd|mermaid|d2)$/.test(file)) return null;
    const renderer = values.get('--renderer') || (file?.endsWith('.d2') ? 'd2' : undefined);
    if (renderer && !['pele', 'd2'].includes(renderer)) return null;
    if (values.has('--layout') && (renderer !== 'd2' || !['tala', 'elk', 'dagre'].includes(values.get('--layout')))) return null;
    if (values.has('--operation') && !['deps', 'dependents'].includes(values.get('--operation'))) return null;
    for (const [key, max] of [['--depth', 32], ['--limit', 200], ['--max-nodes', 200], ['--timeout', 30000]]) {
      if (!values.has(key)) continue;
      const value = values.get(key), number = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > max) return null;
    }
    if (values.has('--scale')) {
      const scale = values.get('--scale'), number = Number(scale);
      if (!seen.has('--png') || !/^\d+$/.test(scale) || !Number.isSafeInteger(number) || number < 1 || number > 4) return null;
    }
    if (values.has('--output') && !['json-envelope', 'agent'].includes(values.get('--output'))) return null;
    if (values.has('--workspace') && path.resolve(values.get('--workspace')) !== path.resolve(workspace)) return null;
    return 'diagrams';
  }
  if (args[0] === 'flows') {
    const verb = args[1];
    if (!['prepare', 'publish', 'status', 'show'].includes(verb)) return null;
    const boolean = new Set(['--json', '--dry-run', '--no-events', '--no-color', '--verbose', '-v']);
    const valued = new Set(['--file', '--workspace', '--ae-home', '--harness-home', '--copilot-home', '--skills-home']), seen = new Set(), values = new Map();
    for (let index = 2; index < args.length; index++) {
      const token = args[index], split = token.indexOf('='), name = split < 0 ? token : token.slice(0, split), key = name === '-v' ? '--verbose' : name;
      if (seen.has(key)) return null;
      seen.add(key);
      if (boolean.has(name) && split < 0) continue;
      if (!valued.has(name)) return null;
      const value = split < 0 ? args[++index] : token.slice(split + 1);
      if (!value || value.startsWith('-') || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null;
      values.set(name, value);
    }
    const file = values.get('--file');
    if (verb === 'publish' && !file || file && !['prepare', 'publish'].includes(verb)) return null;
    if (file && (path.isAbsolute(file) || path.win32.isAbsolute(file) || file.includes('\\') || file.includes(':') || file.split('/').some(part => !part || part === '.' || part === '..'))) return null;
    if (values.has('--workspace') && path.resolve(values.get('--workspace')) !== path.resolve(workspace)) return null;
    return 'flows';
  }
  if (args[0] === 'performance') {
    if (args[1] !== 'analyze') return null;
    const boolean = new Set(['--json', '--dry-run', '--no-events', '--no-color', '--verbose', '-v']);
    const valued = new Set(['--file', '--domain', '--workspace', '--ae-home', '--harness-home', '--copilot-home', '--skills-home']), seen = new Set(), values = new Map();
    for (let index = 2; index < args.length; index++) {
      const token = args[index], split = token.indexOf('='), name = split < 0 ? token : token.slice(0, split), key = name === '-v' ? '--verbose' : name;
      if (seen.has(key)) return null;
      seen.add(key);
      if (boolean.has(name) && split < 0) continue;
      if (!valued.has(name)) return null;
      const value = split < 0 ? args[++index] : token.slice(split + 1);
      if (!value || value.startsWith('-') || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null;
      values.set(name, value);
    }
    const domain = values.get('--domain'), file = values.get('--file');
    if (domain && (domain.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(domain))) return null;
    if (file && (path.isAbsolute(file) || path.win32.isAbsolute(file) || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..'))) return null;
    if (values.has('--workspace') && path.resolve(values.get('--workspace')) !== path.resolve(workspace)) return null;
    return 'performance';
  }
  if (args[0] === 'experiment') {
    const verb = args[1], options = { begin: ['--plan', '--file'], evaluate: ['--plan', '--attempt'], resolve: ['--plan', '--file'], status: ['--plan', '--attempt'] };
    if (!Object.hasOwn(options, verb)) return null;
    const boolean = new Set(['--json', '--dry-run', '--no-events', '--no-color', '--verbose', '-v']);
    const valued = new Set(['--workspace', '--ae-home', '--harness-home', '--copilot-home', '--skills-home', ...options[verb]]), seen = new Set(), values = new Map();
    for (let index = 2; index < args.length; index++) {
      const token = args[index], split = token.indexOf('='), name = split < 0 ? token : token.slice(0, split), key = name === '-v' ? '--verbose' : name;
      if (seen.has(key)) return null;
      seen.add(key);
      if (boolean.has(name) && split < 0) continue;
      if (!valued.has(name)) return null;
      const value = split < 0 ? args[++index] : token.slice(split + 1);
      if (!value || value.startsWith('-') || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null;
      values.set(name, value);
    }
    if (verb !== 'status' && options[verb].some(key => !values.has(key))) return null;
    if (values.has('--attempt') && !values.has('--plan')) return null;
    if (values.has('--attempt') && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(values.get('--attempt'))) return null;
    if (values.has('--workspace') && path.resolve(values.get('--workspace')) !== path.resolve(workspace)) return null;
    return 'experiment';
  }
  if (args[0] === 'domain') {
    const verb = args[1], reviewVerb = verb === 'review' ? args[2] : null;
    const options = {
      show: [], status: ['--plan'], get: ['--plan', '--offset', '--lines', '--max-bytes'], 'plan-new': ['--file'], 'plan-update': ['--plan', '--file'],
      gate: ['--plan', '--phase', '--enforcement'],
      review: ['--plan', '--base', '--domain', '--reviewer', '--file', '--max-bytes', '--packet'],
      verify: ['--plan', '--base', '--enforcement'], compound: ['--plan', '--learning-decision', '--enforcement'],
    };
    if (!Object.hasOwn(options, verb) || (verb === 'review' && !['prepare', 'assemble'].includes(reviewVerb))) return null;
    const boolean = new Set(['--json', '--dry-run', '--no-events', '--no-color', '--verbose', '-v', ...(verb === 'status' ? ['--validate-completion'] : [])]);
    const valued = new Set(['--workspace', '--ae-home', '--harness-home', '--copilot-home', '--skills-home', '--name', ...options[verb]]);
    const values = new Map(), seen = new Set();
    for (let index = verb === 'review' ? 3 : 2; index < args.length; index++) {
      const token = args[index], split = token.indexOf('=');
      const name = split < 0 ? token : token.slice(0, split), key = name === '-v' ? '--verbose' : name;
      const repeatable = verb === 'review' && reviewVerb === 'prepare' && ['--file', '--reviewer'].includes(name);
      if (seen.has(key) && !repeatable) return null;
      seen.add(key);
      if (boolean.has(name) && split < 0) continue;
      if (!valued.has(name)) return null;
      const value = split < 0 ? args[++index] : token.slice(split + 1);
      // `-` (stdin) is the only dash-led value: --file for plan-new and
      // plan-update, and --learning-decision for compound (a decision carrying
      // an evidence line is accepted only on stdin).
      const stdin = value === '-' && ((name === '--file' && ['plan-new', 'plan-update'].includes(verb)) || (name === '--learning-decision' && verb === 'compound'));
      if (!value || (value.startsWith('-') && !stdin) || /[\u0000-\u001f\u007f]/.test(value)) return null;
      values.set(name, value);
    }
    const name = values.get('--name');
    if (!name || name.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) return null;
    if (!['show', 'plan-new'].includes(verb) && !values.has('--plan')) return null;
    if (['plan-new', 'plan-update'].includes(verb) && !values.has('--file')) return null;
    if (verb === 'review' && reviewVerb === 'assemble' && (!values.has('--packet') || !values.has('--file'))) return null;
    if (verb === 'compound' && !values.has('--learning-decision')) return null;
    if (values.has('--phase') && !['implement', 'verify'].includes(values.get('--phase'))) return null;
    if (values.has('--enforcement') && !['observe', 'warn', 'enforce'].includes(values.get('--enforcement'))) return null;
    if (values.has('--domain') && !['code', 'document'].includes(values.get('--domain'))) return null;
    if (values.has('--max-bytes') && !/^\d+$/.test(values.get('--max-bytes'))) return null;
    return 'domain';
  }
  if (args[0] === 'inventory') {
    const inventory = args[0] === 'inventory', verb = args[1];
    if (!(inventory ? ['show', 'refresh'].includes(verb) : verb === 'show')) return null;
    const boolean = new Set(['--json', '--dry-run', '--no-events', '--no-color', '--verbose', '-v']);
    const valued = new Set(['--workspace', '--ae-home', '--harness-home', '--copilot-home', '--skills-home',
      ...(inventory && verb === 'refresh' ? ['--editor', '--profile', '--installation', '--launcher', '--user-data', '--config-root', '--plugins-root'] : []),
      ...(!inventory ? ['--name'] : [])]);
    const values = new Map(), seen = new Set();
    for (let index = 2; index < args.length; index++) {
      const token = args[index], split = token.indexOf('=');
      const name = split < 0 ? token : token.slice(0, split), key = name === '-v' ? '--verbose' : name;
      if (seen.has(key)) return null;
      seen.add(key);
      if (boolean.has(name) && split < 0) continue;
      if (!valued.has(name)) return null;
      const value = split < 0 ? args[++index] : token.slice(split + 1);
      if (!value || value.startsWith('-') || /[\u0000-\u001f\u007f]/.test(value)) return null;
      values.set(name, value);
    }
    if (inventory && verb === 'refresh' && !['vscode', 'cursor', 'jetbrains'].includes(values.get('--editor'))) return null;
    if (!inventory && (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(values.get('--name') || '') || values.get('--name').length > 64)) return null;
    return args[0];
  }
  if (args[0] === 'todo') {
    const hasVerb = args[1] && !args[1].startsWith('-');
    const verb = hasVerb ? args[1] : 'list';
    if (!['list', 'sync', 'complete'].includes(verb)) return null;
    const values = new Map();
    const boolean = new Set(['--json', '--dry-run', '--no-events', '--no-color', '--verbose', '-v']);
    const valued = new Set(['--plan', '--id', '--workspace', '--ae-home', '--harness-home', '--copilot-home', '--skills-home']);
    for (let index = hasVerb ? 2 : 1; index < args.length; index++) {
      const token = args[index], split = token.indexOf('=');
      const name = split < 0 ? token : token.slice(0, split);
      if (boolean.has(name) && split < 0) continue;
      if (!valued.has(name) || values.has(name)) return null;
      const value = split < 0 ? args[++index] : token.slice(split + 1);
      if (!value || value.startsWith('-')) return null;
      values.set(name, value);
    }
    if (verb !== 'list' && !values.has('--plan') || verb === 'complete' && !values.has('--id') || verb !== 'complete' && values.has('--id')) return null;
    return 'todo';
  }
  if (args[0] === 'checks' && ['list', 'show', 'help'].includes(args[1])) return 'checks';
  if (args[0] === 'trust' && (!args[1] || args[1] === 'status')) return 'trust';
  return null;
}

/** Unknown executable effects are kept separate from known write targets. */
export function analyzeTerminalEffects(command, workspace = process.cwd()) {
  const text = String(command || '');
  const shellControl = withoutHeredocBodies(text);
  const control = shellControl.replace(/<<-?\s*(?:(['"])([^'"]+)\1|([A-Za-z0-9_]+))\s*$/gm, '');
  const parsed = terminalSegments(control);
  if (expandingHeredoc(text)) parsed.ambiguous = true;
  const opaqueInvocations = [];
  const invocations = [];
  let ambiguous = parsed.ambiguous || parsed.opaqueExpansion || terminalSegments(shellControl).redirection;
  for (const segment of parsed.segments) {
    const tokens = tokenizeShell(segment);
    if (!tokens.length) continue;
    invocations.push(tokens);
    const base = path.basename(tokens[0]).toLowerCase();
    const args = tokens.slice(1);
    const wrapped = ASSIGNMENT.test(tokens[0]) || ['env', 'command', 'nohup', ...PREFIX_UTILS, ...POSIX_SHELLS, ...POWERSHELLS].includes(base);
    const knownWrite = analyzeShellMutation(segment).mutation;
    const git = base === 'git' ? parseGitInvocation(args) : null;
    const query = POWERSHELL_QUERIES.has(base) && tokens[0].toLowerCase() === base
      || isSystemCommand(tokens[0], base) && (QUERY_COMMANDS.has(base) && !(base === 'rg' && (args.some(arg => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg))
        || process.env.RIPGREP_CONFIG_PATH && args[0] !== '--no-config'))
      || (base === 'find' && !args.some(arg => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg)))
      || (git && gitQueryIsResolved(tokens, git, workspace))
      || (['node', 'python', 'python3', 'npm'].includes(base) && args.length === 1 && ['--version', '-v', '--help'].includes(args[0])));
    const controlCommand = !parsed.ambiguous && !wrapped ? harnessControlCommand(tokens, workspace) : null;
    const configuration = controlCommand === 'checks' && tokens[2] === 'checks' && tokens[3] === 'configure';
    if (!parsed.ambiguous && !wrapped && (query || controlCommand)
      && (!configuration || parsed.segments.length === 1 && !parsed.redirection)) continue;
    const inner = wrapped ? unwrapShellSegments(segment) : [tokens];
    const explicit = inner.length > 0 && inner.every(argv => {
      const executable = path.basename(argv[0] || '').toLowerCase();
      const invocation = argv.join(' ');
      return (isSystemCommand(argv[0], executable) || POWERSHELL_WRITERS.has(executable) && argv[0].toLowerCase() === executable)
        && (EXPLICIT_WRITERS.has(executable) && analyzeShellMutation(invocation).mutation
        || executable === 'git' && ['apply', 'checkout', 'restore', 'rm', 'mv', 'clean', 'reset', 'stash', 'switch', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'pull'].includes(parseGitInvocation(argv.slice(1)).subcommand));
    });
    if (!parsed.ambiguous && knownWrite && explicit) continue;
    if (wrapped) ambiguous = true;
    opaqueInvocations.push(tokens);
  }
  // A literal stdin decision adds input redirection, not a second executable.
  // Only the same closed installed recovery grammar may discard that marker.
  if (!parsed.ambiguous && !parsed.opaqueExpansion && !parsed.redirection && invocations.length === 1 && !opaqueInvocations.length
    && checkConfigurationRecoveryControl(invocations[0], workspace)) ambiguous = false;
  return { opaqueInvocations, invocations, ambiguous, hasOpaque: opaqueInvocations.length > 0 };
}

function addPath(targets, value) {
  if (typeof value === 'string' && value.trim()) targets.push(value.trim());
}

function itemPath(item) {
  if (typeof item === 'string') return item;
  return item?.filePath || item?.file_path || item?.path;
}

function canonicalPath(value) {
  const lexical = path.resolve(value);
  try {
    return fs.realpathSync(lexical);
  } catch {
    return lexical;
  }
}

function workspaceFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) return null;
  let cursor = path.dirname(path.resolve(transcriptPath));
  for (let depth = 0; depth < 6; depth += 1) {
    const metadataPath = path.join(cursor, 'workspace.json');
    if (fs.existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const value = metadata.folder || metadata.workspace;
        if (typeof value === 'string' && value) {
          return canonicalPath(value.startsWith('file:') ? fileURLToPath(value) : value);
        }
      } catch {
        return null;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function workspaceFromTarget(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return null;
  let cursor = path.resolve(target);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
  if (!fs.statSync(cursor).isDirectory()) cursor = path.dirname(cursor);
  while (true) {
    if (fs.existsSync(path.join(cursor, '.git')) || fs.existsSync(path.join(cursor, '.harness'))) {
      return canonicalPath(cursor);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

export function resolveHookWorkspace(payload = {}, targets = []) {
  if (typeof payload.workspace === 'string' && payload.workspace.trim()) return canonicalPath(payload.workspace);
  const transcriptWorkspace = workspaceFromTranscript(payload.transcript_path || payload.transcriptPath);
  if (transcriptWorkspace) return transcriptWorkspace;
  for (const target of targets) {
    const targetWorkspace = workspaceFromTarget(target);
    if (targetWorkspace) return targetWorkspace;
  }
  return canonicalPath(payload.cwd || process.cwd());
}

function parseToolInput(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeToolPayload(payload = {}) {
  // Copilot CLI's native envelopes use runtime names; PascalCase registration
  // supplies Claude-compatible names. Keep their effects identical.
  const canonicalName = value => {
    const name = String(value || '').trim();
    return ({ bash: 'Bash', powershell: 'Bash', view: 'Read', create: 'Write', str_replace_editor: 'Edit' })[name] || name;
  };
  const inputs = [payload.tool_input, payload.toolArgs, payload.toolInput].filter(value => value != null).map(parseToolInput);
  const input = inputs[0] || {};
  const names = [payload.tool_name, payload.toolName].filter(value => value != null).map(canonicalName);
  const toolName = names[0] || '';
  const conflicting = names.some(name => name !== toolName) || inputs.some(value => !isDeepStrictEqual(value, input));
  const targets = [];
  for (const candidate of [
    payload.filePath,
    payload.file_path,
    payload.path,
    input.filePath,
    input.file_path,
    input.path,
  ]) addPath(targets, candidate);

  for (const collection of [input.files, input.edits, input.replacements]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) addPath(targets, itemPath(item));
  }

  const patchText = input.patch || input.input || '';
  for (const match of String(patchText).matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to):\s+(.+)$/gm)) {
    addPath(targets, match[1]);
  }

  const command = input.command || payload.command || '';
  const workspace = resolveHookWorkspace(payload, targets);
  const shell = TERMINAL_TOOLS.has(toolName) || command
    ? analyzeShellMutation(command)
    : { mutation: false, targets: [], mkdirTargets: [] };
  targets.push(...shell.targets);
  const terminalEffects = command ? analyzeTerminalEffects(command, workspace) : { opaqueInvocations: [], invocations: [], ambiguous: false, hasOpaque: false };
  if (conflicting) { terminalEffects.ambiguous = true; terminalEffects.hasOpaque = true; }
  const uniqueTargets = [...new Set(targets)];
  // Fail closed on unrecognized tools: any payload naming a concrete file
  // target is a mutation unless the tool is a known read-only or terminal tool
  // (terminal mutations are decided by shell analysis above).
  const mutation = FILE_MUTATION_TOOLS.has(toolName)
    || shell.mutation
    || terminalEffects.hasOpaque
    || (uniqueTargets.length > 0 && !READ_ONLY_TOOLS.has(toolName) && !TERMINAL_TOOLS.has(toolName));
  const resolvedWorkspace = resolveHookWorkspace(payload, uniqueTargets);

  return {
    toolName,
    toolInput: input,
    command,
    mutation,
    terminalEffects,
    targets: uniqueTargets,
    mkdirTargets: [...new Set(shell.mkdirTargets)],
    targetResolved: !terminalEffects.hasOpaque && (!mutation || uniqueTargets.length > 0),
    sessionId: payload.session_id || payload.sessionId || null,
    hookEvent: payload.hook_event_name || payload.hookEventName || null,
    workspace: resolvedWorkspace,
  };
}

export function toolMutationSucceeded(payload = {}) {
  if (payload.success === false || payload.ok === false) return false;
  if (payload.error || payload.tool_error || payload.toolError) return false;
  if (['PostToolUseFailure', 'postToolUseFailure'].includes(payload.hook_event_name || payload.hookEventName)) return false;
  for (const result of [payload.tool_response, payload.tool_result, payload.toolResult]) {
    if (!result || typeof result !== 'object') continue;
    const type = result.result_type ?? result.resultType;
    if (result.success === false || result.error || type !== undefined && type !== 'success') return false;
  }
  return true;
}

export function activatedSkillFromPayload(payload = {}) {
  if (payload.truncated === true || payload.tool_response?.truncated === true) return null;
  const normalized = normalizeToolPayload(payload);
  if (!SKILL_READ_TOOLS.has(normalized.toolName)) return null;

  const candidates = [
    ...normalized.targets,
    normalized.toolInput?.skill,
    normalized.toolInput?.skillName,
    normalized.toolInput?.name,
  ].filter((value) => typeof value === 'string');
  for (const candidate of candidates) {
    const value = candidate.replace(/\\/g, '/');
    const pathMatch = value.match(/(?:^|\/)skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md(?:$|[?#])/i);
    if (pathMatch) return pathMatch[1].toLowerCase();
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(value) && /skill/i.test(normalized.toolName)) {
      return value.toLowerCase();
    }
  }
  return null;
}

export function isPrimitivePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return PRIMITIVE_FILES.has(normalized) || PRIMITIVE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isPersonalWritePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return PERSONAL_WRITE_FILES.has(normalized) || PERSONAL_WRITE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function planUsesCreatePrimitive(text) {
  const frontmatter = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
  const skills = frontmatter.match(/^skills_used:\s*\r?\n([\s\S]*?)(?=^[A-Za-z_][\w-]*:\s*|(?![\s\S]))/m)?.[1] || '';
  return /^\s*-\s*create-primitive\s*$/m.test(skills) || /skills_used:\s*\[[^\]]*\bcreate-primitive\b[^\]]*\]/m.test(frontmatter);
}
