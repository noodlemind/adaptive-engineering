import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildPlanSkeleton } from '../lib/plan-new.mjs';
import { normalizeToolPayload } from '../corpus/hooks/lib/tool-payload.mjs';
import { packageRoot, binPath as bin, runHarness } from './helpers/cli.mjs';
import { tempDir } from './helpers/temp.mjs';
import { git } from './helpers/store.mjs';

const hooks = path.join(packageRoot, 'corpus/hooks');

function fixture(t) {
  const root = tempDir('terminal-effects-');
  const workspace = path.join(root, 'project');
  const home = path.join(root, 'home');
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  const globalConfig = path.join(root, 'global.gitconfig');
  fs.writeFileSync(globalConfig, '');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_PAGER: undefined, PAGER: undefined, RIPGREP_CONFIG_PATH: undefined, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig, HARNESS_HOME: home, HARNESS_BIN: bin, HARNESS_ENFORCEMENT: 'enforce' };
  const run = (executable, argv, extra = {}) => spawnSync(executable, argv, { cwd: workspace, encoding: 'utf8', env, ...extra });
  const cli = (...argv) => runHarness([...argv, '--workspace', workspace, '--json', '--no-events'], { cwd: workspace, env, trust: false, injectHome: false });
  const hook = (name, command, extra = {}, environment = {}) => {
    const result = run(process.execPath, [path.join(hooks, name)], {
      env: { ...env, ...environment },
      input: JSON.stringify({ workspace, session_id: 'terminal-fixture', tool_name: 'run_in_terminal', tool_input: { command }, ...extra }),
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  };
  assert.equal(git(workspace, ['init', '-b', 'feature/fixture']).status, 0);
  fs.mkdirSync(path.join(workspace, '.github/harness'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src/generated.txt'), 'before\n');
  fs.writeFileSync(path.join(workspace, 'generator.mjs'), "import fs from 'node:fs'; fs.writeFileSync('src/generated.txt', 'after\\n'); if (process.argv.includes('--fail')) process.exit(1);\n");
  assert.equal(git(workspace, ['add', 'src/generated.txt', 'generator.mjs']).status, 0);
  assert.equal(git(workspace, ['commit', '-qm', 'fixture baseline']).status, 0);
  fs.writeFileSync(path.join(workspace, '.github/harness/checks.yaml'), 'version: 1\nchecks:\n  generate:\n    command: [node, generator.mjs]\n  unrelated:\n    command: [node, unrelated.mjs]\n');
  const skeleton = buildPlanSkeleton({ type: 'fix', slug: 'terminal-fixture', date: '2026-10-11', intent: 'Track generated product edits', impacted: ['src/generated.txt'], check: 'generate', criteria: ['Generated edits require fresh verification'], status: 'in-progress' });
  const plan = skeleton.path;
  fs.mkdirSync(path.dirname(path.join(workspace, plan)), { recursive: true });
  fs.writeFileSync(path.join(workspace, plan), skeleton.content);
  const sessionPath = path.join(workspace, '.harness/session.json');
  const session = () => JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const changeSession = (changes) => fs.writeFileSync(sessionPath, JSON.stringify({ ...session(), ...changes }));
  const gate = () => {
    const result = cli('gate', '--phase', 'implement', '--plan', plan, '--allow-inplace');
    assert.equal(result.status, 0, result.stderr + result.stdout);
  };
  const approve = () => assert.equal(cli('trust', 'approve').status, 0);
  return { workspace, home, env, run, cli, hook, session, changeSession, gate, approve, plan };
}

function gitHelper(f) {
  const helper = path.join(f.workspace, 'git-helper');
  fs.writeFileSync(helper, "#!/bin/sh\nprintf 'helper changed bytes' > src/hidden.txt\nprintf '\\0'\n");
  fs.chmodSync(helper, 0o755);
  return helper;
}

for (const mechanism of ['environment external diff', 'configured external diff', 'configured fsmonitor']) {
  test(`Git query ${mechanism} is opaque without executing its helper during inspection`, (t) => {
    const f = fixture(t);
    const helper = gitHelper(f);
    const environment = mechanism === 'environment external diff' ? { GIT_EXTERNAL_DIFF: helper } : {};
    const query = mechanism === 'configured fsmonitor' ? ['status', '--short'] : ['diff', '--', 'src/generated.txt'];
    if (mechanism === 'configured external diff') assert.equal(f.run('git', ['config', 'diff.external', helper]).status, 0);
    if (mechanism === 'configured fsmonitor') assert.equal(f.run('git', ['config', 'core.fsmonitor', helper]).status, 0);
    fs.writeFileSync(path.join(f.workspace, 'src/generated.txt'), 'changed\n');
    const command = `git ${query.join(' ')}`;
    const admission = f.hook('require-plan-gate.mjs', command, {}, environment);
    assert.equal(fs.existsSync(path.join(f.workspace, 'src/hidden.txt')), false, 'metadata inspection must not execute the helper');
    if (process.platform !== 'win32') {
      const execution = f.run('git', query, { env: { ...f.env, ...environment } });
      assert.equal(execution.status, 0, execution.stderr);
      assert.equal(fs.readFileSync(path.join(f.workspace, 'src/hidden.txt'), 'utf8'), 'helper changed bytes');
    } else t.diagnostic('Actual Git helper writes use POSIX executable scripts; metadata and hook policy assertions still execute on Windows.');
    assert.equal(admission.permissionDecision, 'deny');
    f.hook('record-successful-edit.mjs', command, { hook_event_name: 'PostToolUse' }, environment);
    assert.equal(f.session().lastEditEffect, 'unknown');
    assert.deepEqual(f.session().lastEditTargets, []);
  });
}

test('Git query inspection follows included and environment configuration without caching or helper execution', (t) => {
  const f = fixture(t);
  const helper = gitHelper(f);
  const included = path.join(f.workspace, 'included.gitconfig');
  fs.writeFileSync(included, `[diff]\n\texternal = ${JSON.stringify(helper)}\n`);
  assert.equal(f.hook('require-plan-gate.mjs', 'git diff').continue, true);
  assert.equal(f.run('git', ['config', 'include.path', included]).status, 0);
  assert.equal(f.hook('require-plan-gate.mjs', 'git diff').permissionDecision, 'deny');
  assert.equal(f.run('git', ['config', '--unset', 'include.path']).status, 0);
  assert.equal(f.hook('require-plan-gate.mjs', 'git diff').continue, true);
  const environment = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.external', GIT_CONFIG_VALUE_0: helper };
  assert.equal(f.hook('require-plan-gate.mjs', 'git diff', {}, environment).permissionDecision, 'deny');
  assert.equal(fs.existsSync(path.join(f.workspace, 'src/hidden.txt')), false);
});

test('Git query inspection respects Boolean fsmonitor and effective helper applicability', (t) => {
  const f = fixture(t);
  for (const value of ['true', 'false', 'yes', 'no', 'on', 'off', '1', '0']) {
    assert.equal(f.run('git', ['config', 'core.fsmonitor', value]).status, 0);
    assert.equal(f.hook('require-plan-gate.mjs', 'git status --short').continue, true, value);
  }
  assert.equal(f.run('git', ['config', '--unset', 'core.fsmonitor']).status, 0);
  for (const key of ['diff.fixture.command', 'diff.fixture.textconv', 'filter.fixture.clean', 'filter.fixture.process']) {
    assert.equal(f.run('git', ['config', key, './git-helper']).status, 0);
    assert.equal(f.hook('require-plan-gate.mjs', 'git diff').permissionDecision, 'deny', key);
    assert.equal(f.run('git', ['config', '--unset', key]).status, 0);
  }
  assert.equal(f.run('git', ['config', 'core.pager', './git-helper']).status, 0);
  assert.equal(f.hook('require-plan-gate.mjs', 'git log -1').permissionDecision, 'deny');
  assert.equal(f.run('git', ['config', 'pager.log', 'false']).status, 0);
  assert.equal(f.hook('require-plan-gate.mjs', 'git log -1').continue, true);
  assert.equal(f.hook('require-plan-gate.mjs', 'git diff').permissionDecision, 'deny');
  assert.equal(fs.existsSync(path.join(f.workspace, 'src/hidden.txt')), false);
});

test('Git queries with unresolved metadata or explicit global execution contexts remain opaque', (t) => {
  const f = fixture(t);
  for (const command of ['git -C . status', 'git --git-dir=.git status', 'git --work-tree=. diff', 'git --no-pager log', 'git --paginate log', 'git -p log', 'git -P log', 'git grep --open-files-in-pager=./git-helper needle', 'git grep -O./git-helper needle', "git log '--format=%G?'"]) {
    assert.equal(f.hook('require-plan-gate.mjs', command).permissionDecision, 'deny', command);
  }
  fs.appendFileSync(path.join(f.workspace, '.git/config'), '\ninvalid configuration\n');
  assert.equal(f.hook('require-plan-gate.mjs', 'git status --short').permissionDecision, 'deny');
});

for (const option of ['-nO', '--open-files-in-page=', '--open-files-in-p=', '--op=']) {
  test(`Git grep pager spelling ${option} requires opaque admission and effect recording`, (t) => {
    const f = fixture(t);
    const helper = gitHelper(f);
    const query = ['grep', `${option}${helper}`, 'before'];
    const command = `git grep '${option}${helper}' before`;
    const admission = f.hook('require-plan-gate.mjs', command);
    assert.equal(fs.existsSync(path.join(f.workspace, 'src/hidden.txt')), false, 'hook inspection must not execute the pager');
    if (process.platform !== 'win32') {
      const execution = f.run('git', query);
      assert.equal(execution.status, 0, execution.stderr);
      assert.equal(fs.readFileSync(path.join(f.workspace, 'src/hidden.txt'), 'utf8'), 'helper changed bytes');
    } else t.diagnostic('Actual pager execution uses a POSIX helper; hook admission and effect recording still execute on Windows.');
    assert.equal(admission.permissionDecision, 'deny');
    f.hook('record-successful-edit.mjs', command, { hook_event_name: 'PostToolUse' });
    assert.equal(f.session().lastEditEffect, 'unknown');
    assert.deepEqual(f.session().lastEditTargets, []);
  });
}

test('ordinary Git grep queries remain read-only', (t) => {
  const f = fixture(t);
  for (const query of [['grep', 'before'], ['grep', '-n', 'before']]) {
    const command = `git ${query.join(' ')}`;
    assert.equal(f.hook('require-plan-gate.mjs', command).continue, true);
    assert.equal(f.run('git', query).status, 0);
    f.hook('record-successful-edit.mjs', command, { hook_event_name: 'PostToolUse' });
    assert.equal(fs.existsSync(path.join(f.workspace, '.harness/session.json')), false);
  }
});

test('Git metadata inspection is bounded and recognizes an exact cat pager', (t) => {
  const f = fixture(t);
  assert.equal(f.hook('require-plan-gate.mjs', 'git diff', {}, { GIT_PAGER: 'cat' }).continue, true);
  assert.equal(f.hook('require-plan-gate.mjs', 'git diff', {}, { GIT_PAGER: './git-helper' }).permissionDecision, 'deny');
  assert.equal(f.hook('require-plan-gate.mjs', 'git diff', {}, { GIT_PAGER: 'cat > src/hidden.txt' }).permissionDecision, 'deny');
  fs.appendFileSync(path.join(f.workspace, '.git/config'), `\n[diff]\n\texternal = ${'x'.repeat(70 * 1024)}\n`);
  assert.equal(f.hook('require-plan-gate.mjs', 'git diff').permissionDecision, 'deny');
  assert.equal(fs.existsSync(path.join(f.workspace, 'src/hidden.txt')), false);
});

test('opaque terminal generators fail before execution without a current gate on both native aliases', (t) => {
  const f = fixture(t);
  for (const tool_name of ['run_in_terminal', 'execute/runInTerminal']) {
    const pre = f.hook('require-plan-gate.mjs', 'node generator.mjs', { tool_name });
    assert.equal(pre.permissionDecision, 'deny', tool_name);
    assert.match(pre.permissionDecisionReason, /missing-implement-gate/);
    const decoy = f.hook('require-plan-gate.mjs', 'node generator.mjs', { tool_name, tool_input: { command: 'node generator.mjs', filePath: f.plan } });
    assert.equal(decoy.permissionDecision, 'deny', tool_name);
    assert.match(decoy.permissionDecisionReason, /managed-plan-write/);
  }
  assert.equal(fs.readFileSync(path.join(f.workspace, 'src/generated.txt'), 'utf8'), 'before\n');
});

test('actual generated bytes create pending verification even without a session or on failure', (t) => {
  const f = fixture(t);
  for (const [tool_name, argv] of [['run_in_terminal', ['generator.mjs']], ['execute/runInTerminal', ['generator.mjs', '--fail']]]) {
    const execution = f.run(process.execPath, argv);
    assert.equal(execution.status, argv.length === 1 ? 0 : 1);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'src/generated.txt'), 'utf8'), 'after\n');
    assert.match(git(f.workspace, ['diff', '--', 'src/generated.txt']).stdout, /\+after/);
    f.hook('record-successful-edit.mjs', `node ${argv.join(' ')}`, { tool_name, hook_event_name: 'PostToolUse', success: execution.status === 0 });
    assert.ok(f.session().lastEditAt, tool_name);
    assert.equal(f.session().lastEditEffect, 'unknown');
    assert.deepEqual(f.session().lastEditTargets, []);
    const stopped = f.hook('require-verification.mjs', '', { hook_event_name: 'Stop', stop_hook_active: false });
    assert.equal(stopped.decision, 'block');
  }
});

test('opaque admission requires genuine current trust, frozen required checks, and an unchanged gate', (t) => {
  const f = fixture(t);
  f.gate();
  assert.match(f.hook('require-plan-gate.mjs', 'node generator.mjs').permissionDecisionReason, /untrusted-terminal-command/);
  f.approve();
  assert.equal(f.hook('require-plan-gate.mjs', 'node generator.mjs').continue, true);
  assert.match(f.hook('require-plan-gate.mjs', 'node unrelated.mjs').permissionDecisionReason, /out-of-plan-verification/);
  for (const command of ['node generator.mjs --extra', 'node ./generator.mjs', '/fake/node generator.mjs', 'node generator.mjs && node other.mjs', 'ae exec node generator.mjs', 'ae checks run generate']) {
    assert.equal(f.hook('require-plan-gate.mjs', command).permissionDecision, 'deny', command);
  }
  f.changeSession({ lastGateAt: '2000-01-01T00:00:00Z' });
  assert.match(f.hook('require-plan-gate.mjs', 'node generator.mjs').permissionDecisionReason, /stale-implement-gate/);
  f.gate();
  const planPath = path.join(f.workspace, f.plan);
  fs.writeFileSync(planPath, fs.readFileSync(planPath, 'utf8').replace('Track generated product edits', 'Changed product intent'));
  assert.match(f.hook('require-plan-gate.mjs', 'node generator.mjs').permissionDecisionReason, /changed-implement-plan/);
});

test('opaque check wrappers, preloads, substitutions and changed directories are denied', (t) => {
  const f = fixture(t);
  f.approve();
  f.gate();
  for (const command of ['CI=1 node generator.mjs', 'env NODE_OPTIONS=--require=./preload.cjs node generator.mjs', 'env -C other node generator.mjs', 'command node generator.mjs', 'nohup node generator.mjs', 'timeout 5 node generator.mjs', "sh -c 'node generator.mjs'", 'cd other && node generator.mjs', 'node generator.mjs "$(touch src/hidden)"', 'node generator.mjs `touch src/hidden`']) {
    assert.equal(f.hook('require-plan-gate.mjs', command).permissionDecision, 'deny', command);
  }
});

test('changed check configuration remains the first diagnostic and cannot be renewed inline', (t) => {
  const f = fixture(t);
  f.approve();
  f.gate();
  fs.appendFileSync(path.join(f.workspace, '.github/harness/checks.yaml'), '\n# changed\n');
  for (const command of ['node generator.mjs', 'ae gate --json; node generator.mjs']) {
    assert.match(f.hook('require-plan-gate.mjs', command).permissionDecisionReason, /changed-check-config/);
  }
  assert.equal(f.hook('require-plan-gate.mjs', `node '${bin}' gate --json`).continue, true);
});

test('ordinary queries and canonical lifecycle commands remain usable before a gate', (t) => {
  const f = fixture(t);
  for (const command of ['git status --short', 'rg needle src', "printf '%s' 'a;b'", 'cat src/generated.txt', 'node --version', 'Get-Content src/generated.txt', 'Get-ChildItem src', 'Get-Location', "Select-String -Path src/generated.txt -Pattern 'before'", 'Test-Path src/generated.txt', 'Write-Output fixture', 'ae plan-new --file .harness/decisions/new.json', `node '${bin}' plan-update --file .harness/decisions/start.json`, `node '${bin}' verify --json`, 'ae checks list']) {
    assert.equal(f.hook('require-plan-gate.mjs', command).continue, true, command);
    if (!command.startsWith('git ')) assert.equal(normalizeToolPayload({ workspace: f.workspace, tool_name: 'run_in_terminal', tool_input: { command } }).mutation, false, command);
    else {
      f.hook('record-successful-edit.mjs', command, { hook_event_name: 'PostToolUse' });
      assert.equal(fs.existsSync(path.join(f.workspace, '.harness/session.json')), false, 'ordinary Git queries must not create pending verification');
    }
  }
  for (const command of ['node fake/ae.mjs plan-new --file input.json', './ae status', 'npm run build', 'python generator.py', './custom-build']) {
    assert.equal(f.hook('require-plan-gate.mjs', command).permissionDecision, 'deny', command);
  }
  assert.equal(f.hook('require-plan-gate.mjs', 'ae gate --json && node generator.mjs').permissionDecision, 'deny');
});

test('escaped execution flags, joined quotes, script files and git executable overrides fail closed', (t) => {
  const f = fixture(t);
  for (const command of ['rg --p\\re ./preprocessor needle src', 'rg --p"re" ./preprocessor needle src', 'rg --"pre" ./preprocessor needle src', 'sed -f program.sed src/generated.txt', "sed 's/before/after/e' src/generated.txt", 'git -ccore.pager=./preprocessor log', 'git -Cother status', 'git diff --ext-diff', 'git show --textconv']) {
    assert.equal(f.hook('require-plan-gate.mjs', command).permissionDecision, 'deny', command);
  }
});

test('unquoted heredoc expansion is opaque while a quoted heredoc remains a literal query', (t) => {
  const f = fixture(t);
  const command = 'cat <<EOF\n$(node generator.mjs)\nEOF';
  const execution = f.run('sh', ['-c', command]);
  if (execution.error?.code === 'ENOENT') t.diagnostic('Actual heredoc execution needs an installed POSIX shell; lexical assertions still execute.');
  else {
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'src/generated.txt'), 'utf8'), 'after\n');
  }
  assert.equal(f.hook('require-plan-gate.mjs', command).permissionDecision, 'deny');
  f.hook('record-successful-edit.mjs', command, { hook_event_name: 'PostToolUse' });
  assert.equal(f.session().lastEditEffect, 'unknown');
  const literal = "cat <<'EOF'\n$(node generator.mjs)\nnode -e 'require(\"fs\").writeFileSync(\"src/hidden.txt\", \"literal\")'\nopen('src/hidden.txt', 'w')\nEOF";
  assert.equal(f.hook('require-plan-gate.mjs', literal).continue, true);
  assert.equal(normalizeToolPayload({ workspace: f.workspace, tool_name: 'run_in_terminal', tool_input: { command: literal } }).mutation, false);
});

test('inline runtime code cannot infer complete scope from strings or comments', (t) => {
  const f = fixture(t);
  f.gate();
  const source = '/* Path("src/generated.txt") */ require("fs").writeFileSync("src/hidden.txt", "hidden")';
  const command = `node -e '${source}'`;
  assert.equal(f.hook('require-plan-gate.mjs', command).permissionDecision, 'deny');
  assert.equal(f.run(process.execPath, ['-e', source]).status, 0);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'src/hidden.txt'), 'utf8'), 'hidden');
  f.hook('record-successful-edit.mjs', command, { hook_event_name: 'PostToolUse' });
  assert.equal(f.session().lastEditEffect, 'unknown');
  assert.deepEqual(f.session().lastEditTargets, []);
});

test('in-place interpreter programs remain opaque despite their inferred output path', (t) => {
  const f = fixture(t);
  f.gate();
  for (const command of ["perl -pi -e 'system(\"touch src/hidden.txt\")' src/generated.txt", "sed -i 's/before/after/e' src/generated.txt", 'sed -i -f program.sed src/generated.txt']) {
    assert.equal(f.hook('require-plan-gate.mjs', command).permissionDecision, 'deny', command);
  }
});

test('shell expansion cannot change the argv admitted for a frozen opaque check', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, '.github/harness/checks.yaml'), 'version: 1\nchecks:\n  generate:\n    command: [node, generator.mjs, "src/*.txt"]\n');
  f.approve();
  f.gate();
  for (const command of ['node generator.mjs src/*.txt', 'node generator.mjs src/?.txt', 'node generator.mjs src/[ab].txt', 'node generator.mjs ~/fixture']) {
    assert.equal(f.hook('require-plan-gate.mjs', command).permissionDecision, 'deny', command);
  }
  assert.equal(f.hook('require-plan-gate.mjs', "node generator.mjs 'src/*.txt'").continue, true);
  assert.equal(f.hook('require-plan-gate.mjs', 'cat src/*.txt').continue, true);
});

test('opaque shell redirection cannot add input or reinterpret frozen literal arguments', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, '.github/harness/checks.yaml'), 'version: 1\nchecks:\n  generate:\n    command: [node]\n');
  f.approve();
  f.gate();
  const source = 'require("node:fs").writeFileSync("src/hidden.txt", "stdin changed bytes")';
  const heredoc = `node <<'EOF'\n${source}\nEOF`;
  assert.equal(f.hook('require-plan-gate.mjs', heredoc).permissionDecision, 'deny');
  assert.equal(f.run(process.execPath, [], { input: source }).status, 0);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'src/hidden.txt'), 'utf8'), 'stdin changed bytes');
  f.hook('record-successful-edit.mjs', heredoc, { hook_event_name: 'PostToolUse' });
  assert.equal(f.session().lastEditEffect, 'unknown');
  for (const argument of ['<generator.mjs', '>src/generated.txt']) {
    fs.writeFileSync(path.join(f.workspace, '.github/harness/checks.yaml'), `version: 1\nchecks:\n  generate:\n    command: [node, ${JSON.stringify(argument)}]\n`);
    f.approve();
    f.gate();
    assert.equal(f.hook('require-plan-gate.mjs', `node ${argument}`).permissionDecision, 'deny', argument);
    assert.equal(f.hook('require-plan-gate.mjs', `node '${argument}'`).continue, true, argument);
  }
  assert.equal(f.hook('require-plan-gate.mjs', "cat <<'EOF'\nliteral input\nEOF").continue, true);
});

test('opaque post events invalidate older verification while failed nonterminal edits stay ignored', (t) => {
  const f = fixture(t);
  f.approve();
  f.gate();
  f.changeSession({ lastVerifyAt: '2000-01-01T00:00:00Z' });
  f.hook('record-successful-edit.mjs', 'node generator.mjs', { hook_event_name: 'PostToolUseFailure', success: false });
  assert.ok(Date.parse(f.session().lastEditAt) > Date.parse(f.session().lastVerifyAt));
  const timestamp = f.session().lastEditAt;
  f.hook('record-successful-edit.mjs', '', { tool_name: 'replace_string_in_file', tool_input: { filePath: 'src/generated.txt' }, hook_event_name: 'PostToolUseFailure', success: false });
  assert.equal(f.session().lastEditAt, timestamp);
});

test('failed explicit terminal attempts retain pending verification after partial writes', (t) => {
  const f = fixture(t);
  const command = 'printf after > src/generated.txt && false';
  const execution = f.run('sh', ['-c', command]);
  if (execution.error?.code === 'ENOENT') t.diagnostic('Actual partial shell write needs an installed POSIX shell; recorder assertions still execute.');
  else {
    assert.equal(execution.status, 1, execution.stderr);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'src/generated.txt'), 'utf8'), 'after');
  }
  f.hook('record-successful-edit.mjs', command, { hook_event_name: 'PostToolUseFailure', success: false });
  assert.ok(f.session().lastEditAt);
  assert.equal(f.session().lastEditEffect, 'unknown');
  assert.deepEqual(f.session().lastEditTargets, []);
  assert.equal(f.hook('require-verification.mjs', '', { hook_event_name: 'Stop', stop_hook_active: false }).decision, 'block');
});

test('ripgrep execution options are opaque even though ordinary searches are queries', (t) => {
  const f = fixture(t);
  const preprocessor = path.join(f.workspace, 'preprocessor');
  fs.writeFileSync(preprocessor, "#!/bin/sh\nprintf 'preprocessor changed bytes\\n' > src/generated.txt\nif [ \"$#\" -eq 0 ]; then printf fixture-host; else cat \"$1\"; fi\n");
  fs.chmodSync(preprocessor, 0o755);
  const help = f.run('rg', ['--help']);
  if (process.platform !== 'win32' && !help.error && help.status === 0) {
    const execution = f.run('rg', ['--pre', preprocessor, 'preprocessor', 'src/generated.txt']);
    assert.equal(execution.status, 0, execution.stderr);
    assert.match(fs.readFileSync(path.join(f.workspace, 'src/generated.txt'), 'utf8'), /preprocessor changed bytes/);
    if (help.stdout.includes('--hostname-bin')) {
      fs.writeFileSync(path.join(f.workspace, 'src/generated.txt'), 'before hostname\n');
      const hostname = f.run('rg', ['--hostname-bin', preprocessor, '--hyperlink-format=file://{host}{path}', 'preprocessor', 'src/generated.txt']);
      assert.equal(hostname.status, 0, hostname.stderr);
      assert.match(fs.readFileSync(path.join(f.workspace, 'src/generated.txt'), 'utf8'), /preprocessor changed bytes/);
    } else t.diagnostic('Installed ripgrep lacks --hostname-bin; its lexical denial still executes.');
  } else t.diagnostic('Actual ripgrep execution probes need ripgrep and POSIX executable scripts; lexical denials still execute.');
  for (const command of [`rg --pre '${preprocessor}' needle src`, `rg --pre='${preprocessor}' needle src`, `rg --hostname-bin '${preprocessor}' needle src`, `rg --hostname-bin='${preprocessor}' needle src`]) {
    assert.equal(f.hook('require-plan-gate.mjs', command).permissionDecision, 'deny', command);
  }
});

function ripgrepConfig(f) {
  const preprocessor = path.join(f.workspace, 'configured-preprocessor');
  const config = path.join(f.workspace, 'ripgrep-config');
  const marker = path.join(f.workspace, '.ripgrep-helper-effect');
  fs.writeFileSync(preprocessor, "#!/bin/sh\nprintf 'configured helper changed bytes' > .ripgrep-helper-effect\ncat \"$1\"\n");
  fs.chmodSync(preprocessor, 0o755);
  fs.writeFileSync(config, `--pre=${preprocessor}\n`);
  return { preprocessor, marker, environment: { RIPGREP_CONFIG_PATH: config } };
}

test('ambient ripgrep configuration gates a query whose helper changes hidden bytes', (t) => {
  const f = fixture(t);
  const configured = ripgrepConfig(f);
  const command = 'rg before src/generated.txt';
  const admission = f.hook('require-plan-gate.mjs', command, {}, configured.environment);
  assert.equal(fs.existsSync(configured.marker), false, 'hook inspection must not execute the configured preprocessor');
  const help = f.run('rg', ['--help']);
  if (process.platform !== 'win32' && !help.error && help.status === 0) {
    const execution = f.run('rg', ['before', 'src/generated.txt'], { env: { ...f.env, ...configured.environment } });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(fs.readFileSync(configured.marker, 'utf8'), 'configured helper changed bytes');
  } else t.diagnostic('Actual ambient ripgrep helper execution needs ripgrep and POSIX executable scripts; hook policy assertions still execute.');
  assert.equal(admission.permissionDecision, 'deny');
  assert.match(admission.permissionDecisionReason, /missing-implement-gate/);
});

for (const success of [true, false]) {
  test(`ambient ripgrep configuration records potential effects after a ${success ? 'successful' : 'failed'} query`, (t) => {
    const f = fixture(t);
    const configured = ripgrepConfig(f);
    f.hook('record-successful-edit.mjs', 'rg before src/generated.txt', { hook_event_name: success ? 'PostToolUse' : 'PostToolUseFailure', success }, configured.environment);
    assert.equal(fs.existsSync(path.join(f.workspace, '.harness/session.json')), true, 'configured helpers require pending verification even when query execution fails');
    assert.equal(f.session().lastEditEffect, 'unknown');
    assert.deepEqual(f.session().lastEditTargets, []);
    assert.equal(f.hook('require-verification.mjs', '', { hook_event_name: 'Stop', stop_hook_active: false }).decision, 'block');
  });
}

test('explicit ripgrep --no-config remains a query with a configured preprocessor in the environment', (t) => {
  const f = fixture(t);
  const configured = ripgrepConfig(f);
  const command = 'rg --no-config before src/generated.txt';
  assert.equal(f.hook('require-plan-gate.mjs', command, {}, configured.environment).continue, true);
  const help = f.run('rg', ['--help']);
  if (process.platform !== 'win32' && !help.error && help.status === 0) {
    const execution = f.run('rg', ['--no-config', 'before', 'src/generated.txt'], { env: { ...f.env, ...configured.environment } });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(fs.existsSync(configured.marker), false, '--no-config must disable the actual configured helper');
  } else t.diagnostic('Actual --no-config execution needs ripgrep and POSIX executable scripts; hook policy assertions still execute.');
  f.hook('record-successful-edit.mjs', command, { hook_event_name: 'PostToolUse' }, configured.environment);
  assert.equal(fs.existsSync(path.join(f.workspace, '.harness/session.json')), false, 'a configuration-disabled query must not create pending verification');
});

test('explicit ripgrep helper flags remain opaque with --no-config', (t) => {
  const f = fixture(t);
  const configured = ripgrepConfig(f);
  const command = `rg --no-config --pre '${configured.preprocessor}' before src/generated.txt`;
  assert.equal(f.hook('require-plan-gate.mjs', command, {}, configured.environment).permissionDecision, 'deny');
  f.hook('record-successful-edit.mjs', command, { hook_event_name: 'PostToolUse' }, configured.environment);
  assert.equal(f.session().lastEditEffect, 'unknown');
  assert.deepEqual(f.session().lastEditTargets, []);
});

for (const [label, argv] of [
  ['pattern', ['--regexp', '--no-config', 'src/generated.txt']],
  ['path', ['before', '--', '--no-config', 'src/generated.txt']],
]) {
  test(`ripgrep ${label} text --no-config cannot exempt an ambient configured helper`, (t) => {
    const f = fixture(t);
    const configured = ripgrepConfig(f);
    const command = `rg ${argv.join(' ')}`;
    const admission = f.hook('require-plan-gate.mjs', command, {}, configured.environment);
    const help = f.run('rg', ['--help']);
    if (process.platform !== 'win32' && !help.error && help.status === 0) {
      const execution = f.run('rg', argv, { env: { ...f.env, ...configured.environment } });
      assert.equal(execution.error, undefined);
      assert.equal(fs.readFileSync(configured.marker, 'utf8'), 'configured helper changed bytes');
    } else t.diagnostic('Actual configured helper execution needs ripgrep and POSIX executable scripts; hook policy assertions still execute.');
    assert.equal(admission.permissionDecision, 'deny');
    f.hook('record-successful-edit.mjs', command, { hook_event_name: 'PostToolUse' }, configured.environment);
    assert.equal(f.session().lastEditEffect, 'unknown');
  });
}

test('missing or unreadable ambient ripgrep configuration stays opaque without reading or executing it', (t) => {
  const f = fixture(t);
  const unreadable = path.join(f.workspace, 'unreadable-ripgrep-config');
  fs.writeFileSync(unreadable, '--pre=./missing-helper\n');
  fs.chmodSync(unreadable, 0);
  for (const config of [path.join(f.workspace, 'missing-ripgrep-config'), unreadable]) {
    assert.equal(f.hook('require-plan-gate.mjs', 'rg before src/generated.txt', {}, { RIPGREP_CONFIG_PATH: config }).permissionDecision, 'deny', config);
  }
});

test('decision authoring admits only direct contained JSON inputs', (t) => {
  const f = fixture(t);
  const edit = (filePath) => f.hook('guard-critical-files.mjs', '', { tool_name: 'create_file', tool_input: { filePath } });
  assert.equal(edit('.harness/decisions/start-1.json').continue, true);
  for (const filePath of ['.harness/session.json', '.harness/decisions/session.yaml', '.harness/decisions/nested/start.json', '.harness/decisions/.hidden.json', '.harness/decisions/../session.json', '.env/.harness/decisions/start.json']) {
    assert.equal(edit(filePath).permissionDecision, 'deny', filePath);
  }
  fs.mkdirSync(path.join(f.workspace, '.harness/decisions'), { recursive: true });
  fs.mkdirSync(path.join(f.workspace, '.harness/decisions/directory.json'));
  assert.equal(edit('.harness/decisions/directory.json').permissionDecision, 'deny');
  try { fs.symlinkSync(path.join(f.home, 'trust.yaml'), path.join(f.workspace, '.harness/decisions/link.json'), 'file'); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    t.diagnostic('Symlink containment probes need OS symlink permission; direct-path assertions still execute.');
    return;
  }
  assert.equal(edit('.harness/decisions/link.json').permissionDecision, 'deny');
  fs.rmSync(path.join(f.workspace, '.harness/decisions'), { recursive: true });
  fs.symlinkSync(f.home, path.join(f.workspace, '.harness/decisions'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(edit('.harness/decisions/escaped.json').permissionDecision, 'deny');
});

test('decision authoring rejects a hard link to protected lifecycle state', (t) => {
  const f = fixture(t);
  const directory = path.join(f.workspace, '.harness/decisions');
  fs.mkdirSync(directory, { recursive: true });
  const protectedFile = path.join(f.workspace, '.harness/session.json');
  const alias = path.join(directory, 'start.json');
  fs.writeFileSync(protectedFile, '{"protected":true}');
  try { fs.linkSync(protectedFile, alias); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error.code)) throw error;
    t.skip('Filesystem does not support the hard-link execution probe');
    return;
  }
  fs.writeFileSync(alias, '{"control":"shared bytes"}');
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), '{"control":"shared bytes"}');
  assert.equal(f.hook('guard-critical-files.mjs', '', { tool_name: 'create_file', tool_input: { filePath: '.harness/decisions/start.json' } }).permissionDecision, 'deny');
  fs.rmSync(alias);
  fs.writeFileSync(alias, '{}');
  assert.equal(f.hook('guard-critical-files.mjs', '', { tool_name: 'create_file', tool_input: { filePath: '.harness/decisions/start.json' } }).continue, true);
});

test('opaque terminal admission binds personal checks and refuses changed local authority', async t => {
  const f = fixture(t);
  const { projectStoreDir } = await import('../lib/project-layout.mjs');
  const local = path.join(projectStoreDir(f.workspace, { home: f.home }), 'authority');
  fs.mkdirSync(local, { recursive: true });
  const checks = path.join(local, 'checks.yaml');
  fs.copyFileSync(path.join(f.workspace, '.github/harness/checks.yaml'), checks);
  fs.rmSync(path.join(f.workspace, '.github/harness'), { recursive: true });
  f.gate(); f.approve();
  assert.equal(f.hook('require-plan-gate.mjs', 'node generator.mjs').continue, true);
  assert.match(f.hook('require-plan-gate.mjs', 'node unrelated.mjs').permissionDecisionReason, /out-of-plan-verification/);
  fs.appendFileSync(checks, '# authority changed\n');
  assert.equal(f.hook('require-plan-gate.mjs', 'node generator.mjs').permissionDecision, 'deny');
});
