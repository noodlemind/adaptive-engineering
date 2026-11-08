import { harnessControlCommand } from '../corpus/hooks/lib/tool-payload.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';
import { planContractText } from '../lib/evidence.mjs';
import { publishGateSession } from '../lib/gate.mjs';
import { observeHostIntent, publishObservedIntent, validateObservedIntent } from '../lib/host-intent.mjs';
import { externalPlansDir } from '../corpus/hooks/lib/external-plans.mjs';
import { PROOF_AUTHORITY_TIMEOUT_MS, callProofAuthority } from '../corpus/hooks/lib/proof-authority.mjs';
import {
  activatedSkillFromPayload,
  analyzeShellMutation,
  normalizeToolPayload,
  planUsesCreatePrimitive,
  toolMutationSucceeded,
} from '../corpus/hooks/lib/tool-payload.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const hooksRoot = path.join(repoRoot, 'packages', 'ae', 'corpus', 'hooks');
const binPath = path.join(repoRoot, 'packages', 'ae', 'bin', 'ae.mjs');

test('protection hooks leave time to return a denial after authority timeouts', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-deadline-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'app.js'), 'old\n');
  const authority = path.join(root, 'authority.mjs');
  const marker = path.join(root, 'authority.pid');
  fs.writeFileSync(authority, `import fs from 'node:fs';
if (process.argv[2] === 'orient') console.log('{}');
else { fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000); }
`);
  const input = JSON.stringify({ cwd: workspace, session_id: 'deadline-fixture', tool_name: 'replace_string_in_file', tool_input: { filePath: path.join(workspace, 'app.js'), oldString: 'old', newString: 'new' } });
  const env = { ...process.env, AE_BIN: authority, HARNESS_BIN: authority, AE_HOME: path.join(root, 'home'), HARNESS_HOME: path.join(root, 'home'), COPILOT_HOME: path.join(root, 'copilot') };
  const hooks = JSON.parse(fs.readFileSync(path.join(hooksRoot, 'hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks;
  for (const hook of hooks) {
    const calls = hook.command.includes('require-plan-gate') ? 3 : 1;
    assert.ok(hook.timeout * 1000 > PROOF_AUTHORITY_TIMEOUT_MS * calls + (calls === 3 ? 4000 : 0), hook.command);
  }
  const configured = hooks.find(hook => hook.command.includes('require-plan-gate'));
  const adapter = path.join(root, 'adapter.mjs');
  fs.writeFileSync(adapter, `import { runHostAdapter } from ${JSON.stringify(pathToFileURL(path.join(hooksRoot, 'lib/host-adapter.mjs')).href)}; runHostAdapter();\n`);
  for (const [entry, args, timeout] of [
    [path.join(hooksRoot, 'require-plan-gate.mjs'), [], configured.timeout * 1000],
    [adapter, ['edit'], 45000],
  ]) {
    let result;
    try {
      result = spawnSync(process.execPath, [entry, ...args], { cwd: workspace, input, env, encoding: 'utf8', timeout });
    } finally {
      if (fs.existsSync(marker)) {
        try { process.kill(Number(fs.readFileSync(marker, 'utf8'))); } catch { /* authority already timed out */ }
      }
    }
    assert.ifError(result.error);
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(output.hookSpecificOutput?.permissionDecision, 'deny', result.stdout + result.stderr);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /missing-implement-gate/);
  }
});

test('proof authority retains bounded failure cause without command output or credentials', () => {
  const timedOut = callProofAuthority(repoRoot, [], { spawnFn: () => ({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stderr: 'token=private-value' }), timeout: 2500 });
  assert.equal(timedOut.pass, false);
  assert.equal(timedOut.authority.reason, 'timeout');
  assert.equal(timedOut.authority.timeoutMs, 2500);
  assert.equal(PROOF_AUTHORITY_TIMEOUT_MS, 10000);
  assert.equal(timedOut.authority.errorCode, 'ETIMEDOUT');
  assert.equal(timedOut.authority.signalName, 'SIGTERM');
  const failed = callProofAuthority(repoRoot, [], { spawnFn: () => ({ status: 3, signal: null, stdout: '', stderr: 'token=private-value' }) });
  assert.equal(failed.authority.reason, 'exit-error');
  assert.equal(failed.authority.exitCode, 3);
  assert.match(failed.message, /exit=3/);
  assert.ok(!JSON.stringify([timedOut, failed]).includes('private-value'));
  assert.ok(Buffer.byteLength(JSON.stringify([timedOut, failed])) < 2048);
});

function tempWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hook-fixture-'));
  fs.mkdirSync(path.join(workspace, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, '.github', 'harness', 'policy.yaml'),
    'version: 1\nenforcement: enforce\ngate_ttl_minutes: 30\nevidence_ttl_hours: 24\n'
  );
  return workspace;
}

function writePlan(workspace, { createPrimitive = false } = {}) {
  const rel = 'docs/plans/hook-fixture-plan.md';
  const full = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    `---
plan_schema: 1
title: "Hook fixture"
type: fix
status: in-progress
plan_lock: true
phase: 1
risk: amber
intent: "Exercise hook governance"
expected_outputs: ["fixture"]
success_criteria: ["fixture passes"]
verification:
  required: [harness-tests, prompt-contracts, host-contracts, build-assets]
  criteria: {AC1: [harness-tests]}
reviews: {required: [], completed: [], critical_open: []}
skills_used: [engineer${createPrimitive ? ', create-primitive' : ''}]
capability_gaps: []
---

# Hook fixture

## Overview

Fixture plan.

## Intent Contract

- Goal: Exercise hook governance.

## Acceptance Criteria

- [x] **AC1** Fixture passes.

## Plan

### Phase 1

- [x] Exercise hooks.

## Technical Notes

- Primitive classification: modify an existing skill.
- Existing-capability overlap analysis: reuse the existing skill.
- Intended artifact structure: keep the existing SKILL.md.
- Trigger and negative-trigger implications are covered.
- Verification expectations include registry and documentation impact.

## Impacted Files

- \`src/schema.json\`
- \`.github/skills/example/SKILL.md\`
- \`.github/checks/example.md\`
- \`packages/ae/corpus/skills/example/SKILL.md\`

## Verification Plan

- Run trusted checks.

## Risk & Review Routing

- Amber.

## Review Findings

- None.

## Activity

- Fixture.
`
  );
  return rel;
}

function writePassedGate(workspace, plan) {
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  const checksPath = path.join(workspace, '.github', 'harness', 'checks.yaml');
  const checksText = fs.existsSync(checksPath) ? fs.readFileSync(checksPath, 'utf8') : null;
  const configured = checksText ? YAML.parse(checksText)?.checks || {} : {};
  fs.writeFileSync(
    path.join(workspace, '.harness', 'session.json'),
    JSON.stringify({
      version: 1,
      sessionId: 'fixture-session',
      activePlan: plan,
      gatedPlan: plan,
      gatedPlanDigest: crypto
        .createHash('sha256')
        .update(planContractText(fs.readFileSync(path.join(workspace, plan), 'utf8')))
        .digest('hex'),
      gateStatus: 'pass',
      lastGateAt: new Date().toISOString(),
      gatedChecksDigest: checksText ? crypto.createHash('sha256').update(checksText).digest('hex') : null,
      gatedCheckCommands: Object.entries(configured)
        .filter(([, config]) => Array.isArray(config?.command) && config.command.every((part) => typeof part === 'string' && part.length > 0))
        .map(([name, config]) => ({ name, argv: config.command })),
    })
  );
}

/** Workspace-local stand-in for ~/.copilot/skills/<name>/SKILL.md so
 * target-based workspace resolution can never land on the real $HOME. */
function skillFixturePath(workspace, skill) {
  const full = path.join(workspace, 'copilot-home', 'skills', skill, 'SKILL.md');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (!fs.existsSync(full)) fs.writeFileSync(full, `# ${skill}\n`, 'utf8');
  return full;
}

test('an external project-store plan can pass the implement gate', () => {
  const workspace = tempWorkspace();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-ext-home-'));
  const previous = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  try {
    writePlan(workspace);
    const dir = externalPlansDir(workspace);
    fs.mkdirSync(dir, { recursive: true });
    const plan = path.join(dir, '2026-09-26-fix-external-plan.md');
    fs.copyFileSync(path.join(workspace, 'docs/plans/hook-fixture-plan.md'), plan);
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src', 'schema.json'), '{}\n');
    fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.harness', 'session.json'), JSON.stringify({
      version: 1,
      sessionId: 'fixture-session',
      activePlan: plan,
      gatedPlan: plan,
      gatedPlanDigest: crypto.createHash('sha256').update(planContractText(fs.readFileSync(plan, 'utf8'))).digest('hex'),
      gateStatus: 'pass',
      lastGateAt: new Date().toISOString(),
      gatedChecksDigest: null,
      gatedCheckCommands: [],
    }));
    const allowed = spawnSync(process.execPath, [path.join(hooksRoot, 'require-plan-gate.mjs')], {
      cwd: workspace,
      input: JSON.stringify({
        cwd: workspace,
        session_id: 'vscode-session',
        hook_event_name: 'PreToolUse',
        tool_name: 'replace_string_in_file',
        tool_input: { filePath: 'src/schema.json' },
      }),
      encoding: 'utf8',
      env: { ...process.env, HARNESS_HOME: home, HARNESS_ENFORCEMENT: 'enforce' },
    });
    assert.equal(allowed.status, 0, allowed.stderr + allowed.stdout);
    assert.equal(outputJson(allowed).continue, true, allowed.stderr + allowed.stdout);
  } finally {
    if (previous === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function runHook(name, workspace, payload, { authorityBin = binPath } = {}) {
  return spawnSync(process.execPath, [path.join(hooksRoot, name)], {
    cwd: workspace,
    input: JSON.stringify({
      cwd: workspace,
      session_id: 'vscode-session',
      hook_event_name: name === 'record-successful-edit.mjs' ? 'PostToolUse' : 'PreToolUse',
      ...payload,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      COPILOT_HOME: path.join(workspace, 'copilot-home'),
      HARNESS_ENFORCEMENT: 'enforce',
      HARNESS_BIN: authorityBin,
      ...(authorityBin === binPath ? {} : { AE_BIN: authorityBin }),
    },
  });
}

function outputJson(result) {
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return line ? JSON.parse(line) : {};
}

test('unreadable plan authority denies mutation with the exact safe process failure', t => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);
  const failingBin = path.join(workspace, '.harness', 'failed-authority.mjs');
  fs.writeFileSync(failingBin, "process.stderr.write('token=private-authority-value'); process.exit(3);\n");
  const result = spawnSync(process.execPath, [path.join(hooksRoot, 'require-plan-gate.mjs')], {
    cwd: workspace, input: JSON.stringify({ cwd: workspace, tool_name: 'replace_string_in_file', tool_input: { filePath: 'src/schema.json' } }),
    encoding: 'utf8', env: { ...process.env, HARNESS_BIN: failingBin, HARNESS_ENFORCEMENT: 'enforce' },
  });
  const output = outputJson(result);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /unreadable-plan-authority/);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /reason=exit-error, exit=3/);
  assert.ok(!JSON.stringify(output).includes('private-authority-value'));
});

test('normalizes observed VS Code and compatible mutation payloads', () => {
  const cases = [
    ['multi_replace_string_in_file', { files: [{ filePath: 'src/a.json' }, { file_path: 'src/b.json' }] }, ['src/a.json', 'src/b.json']],
    ['multi_replace_string_in_file', { replacements: [{ filePath: 'src/a.json' }, { file_path: 'src/b.json' }] }, ['src/a.json', 'src/b.json']],
    ['replace_string_in_file', { filePath: 'src/a.json' }, ['src/a.json']],
    ['editFiles', { edits: [{ path: 'src/a.json' }] }, ['src/a.json']],
    ['create_file', { path: 'src/a.json' }, ['src/a.json']],
    ['createFile', { file_path: 'src/a.json' }, ['src/a.json']],
    ['apply_patch', { patch: '*** Begin Patch\n*** Update File: src/a.json\n*** End Patch' }, ['src/a.json']],
    ['run_in_terminal', { command: 'printf changed > src/a.json' }, ['src/a.json']],
    ['run_in_terminal', { command: 'printf changed>src/no-space.json' }, ['src/no-space.json']],
    ['runTerminalCommand', { command: 'touch src/a.json' }, ['src/a.json']],
    ['run_in_terminal', { command: "python3 - <<'PY'\nfrom pathlib import Path\npath = Path('src/a.json')\npath.write_text('changed')\nPY" }, ['src/a.json']],
    ['execute', { command: 'mkdir generated' }, ['generated']],
    ['Bash', { command: 'rg TODO src' }, []],
  ];

  for (const [toolName, toolInput, targets] of cases) {
    const normalized = normalizeToolPayload({ tool_name: toolName, tool_input: toolInput });
    assert.equal(normalized.toolName, toolName);
    assert.deepEqual(normalized.targets, targets, toolName);
    assert.equal(normalized.mutation, targets.length > 0, toolName);
  }
});

test('terminal hook blocks configured named checks outside plan verification.required', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-check-trust-'));
  const previous = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const workspace = tempWorkspace();
  const plan = writePlan(workspace);
  fs.writeFileSync(
    path.join(workspace, '.github', 'harness', 'checks.yaml'),
    `version: 1
checks:
  harness-tests:
    command:
      - node
      - scripts/run-harness-tests.mjs
  schema-validation:
    command: [node, scripts/validate-schema.mjs]
`,
    'utf8'
  );
  writePassedGate(workspace, plan);
  const approved = spawnSync(process.execPath, [binPath, 'trust', 'approve', '--workspace', workspace, '--json', '--no-events'], {
    cwd: workspace, encoding: 'utf8', env: process.env,
  });
  assert.equal(approved.status, 0, approved.stderr);

  const denied = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: {
      command: 'node scripts/run-harness-tests.mjs && node scripts/validate-schema.mjs && ae verify --json',
    },
  });
  assert.equal(denied.status, 0, denied.stderr);
  const denial = outputJson(denied).hookSpecificOutput;
  assert.equal(denial.permissionDecision, 'deny');
  assert.match(denial.permissionDecisionReason, /out-of-plan-verification[\s\S]*schema-validation/i);

  const allowed = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: { command: 'node scripts/run-harness-tests.mjs && ae verify --json' },
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(outputJson(allowed).continue, true);

  for (const command of [
    'CI=1 node scripts/validate-schema.mjs',
    'env CI=1 node scripts/validate-schema.mjs',
    'command node scripts/validate-schema.mjs',
    'command -p node scripts/validate-schema.mjs',
    "bash -c 'node scripts/validate-schema.mjs'",
    'node ./scripts/validate-schema.mjs',
    "env -S 'node scripts/validate-schema.mjs'",
    'timeout node scripts/validate-schema.mjs',
  ]) {
    const wrapped = runHook('require-plan-gate.mjs', workspace, {
      tool_name: 'run_in_terminal',
      tool_input: { command },
    });
    assert.equal(outputJson(wrapped).hookSpecificOutput?.permissionDecision, 'deny', command);
  }
});

test('changed checks.yaml does not block legacy sessions or sole ae gate', () => {
  const workspace = tempWorkspace();
  const plan = writePlan(workspace);
  fs.writeFileSync(
    path.join(workspace, '.github', 'harness', 'checks.yaml'),
    `version: 1
checks:
  harness-tests:
    command: [node, scripts/run-harness-tests.mjs]
`
  );
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, '.harness', 'session.json'),
    JSON.stringify({
      version: 1,
      gatedPlan: plan,
      gatedPlanDigest: 'abc',
      gateStatus: 'pass',
      lastGateAt: new Date().toISOString(),
    })
  );

  const legacy = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: { command: 'pwd' },
  });
  assert.equal(outputJson(legacy).continue, true, 'missing gatedChecksDigest is a legacy session, not a hard deny');

  writePassedGate(workspace, plan);
  fs.writeFileSync(
    path.join(workspace, '.github', 'harness', 'checks.yaml'),
    `version: 1
checks:
  harness-tests:
    command: [node, scripts/run-harness-tests.mjs]
  extra:
    command: [node, scripts/extra.mjs]
`
  );

  const mixed = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: { command: 'ae gate --json; node scripts/extra.mjs' },
  });
  assert.equal(outputJson(mixed).hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(outputJson(mixed).hookSpecificOutput?.permissionDecisionReason || '', /changed-check-config/);

  const sole = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: { command: 'ae gate --json' },
  });
  assert.equal(outputJson(sole).continue, true);
});

test('a failed gate permits recovery controls without authorizing product execution', t => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const plan = writePlan(workspace);
  const checksPath = path.join(workspace, '.github/harness/checks.yaml');
  fs.writeFileSync(checksPath, 'version: 1\nchecks:\n  harness-tests:\n    command: [node, scripts/check.mjs]\n');
  writePassedGate(workspace, plan);
  publishGateSession({ workspace, result: { pass: false, exitCode: 1, phase: 'implement', plan: { path: plan }, blockedReason: 'Selected intent source changed' }, policy: { enforcement: 'enforce' } });
  const session = JSON.parse(fs.readFileSync(path.join(workspace, '.harness/session.json'), 'utf8'));
  assert.equal(session.gateStatus, 'blocked');
  assert.equal(session.gatedChecksDigest, null);
  for (const command of ['ae orient --read --json', `node "${binPath}" status --json`, `ae plan-update --plan ${plan} --file .harness/decisions/amend.json --json`]) {
    const result = outputJson(runHook('require-plan-gate.mjs', workspace, { tool_name: 'run_in_terminal', tool_input: { command } }));
    assert.equal(result.continue, true, command + ': ' + JSON.stringify(result));
  }
  for (const command of ['node scripts/check.mjs', 'ae orient --read; node scripts/check.mjs', 'ae worktree --slug mixed && git status', 'ae orient --read; ae status --json']) {
    const result = outputJson(runHook('require-plan-gate.mjs', workspace, { tool_name: 'run_in_terminal', tool_input: { command } }));
    assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny', command);
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /standalone canonical/);
  }
  const edit = outputJson(runHook('require-plan-gate.mjs', workspace, { tool_name: 'replace_string_in_file', tool_input: { filePath: path.join(workspace, 'src/example.js'), oldString: 'old', newString: 'new' } }));
  assert.equal(edit.hookSpecificOutput?.permissionDecision, 'deny');
  writePassedGate(workspace, plan);
  fs.appendFileSync(checksPath, '  extra:\n    command: [node, scripts/extra.mjs]\n');
  const changed = outputJson(runHook('require-plan-gate.mjs', workspace, { tool_name: 'run_in_terminal', tool_input: { command: 'ae orient --read --json' } }));
  assert.match(changed.hookSpecificOutput?.permissionDecisionReason || '', /changed-check-config/);
  writePassedGate(workspace, plan);
  const sessionPath = path.join(workspace, '.harness/session.json');
  fs.writeFileSync(sessionPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(sessionPath, 'utf8')), gatedChecksDigest: 0 }));
  const malformed = outputJson(runHook('require-plan-gate.mjs', workspace, { tool_name: 'run_in_terminal', tool_input: { command: 'ae orient --read --json' } }));
  assert.match(malformed.hookSpecificOutput?.permissionDecisionReason || '', /changed-check-config/);
});

test('non-mutation VS Code tools remain read-only even when their payload includes a path', () => {
  for (const toolName of ['read_file', 'readFile', 'copilot_readFile', 'grep_search', 'file_search', 'list_dir']) {
    const normalized = normalizeToolPayload({
      tool_name: toolName,
      tool_input: { filePath: '/private/tmp/workspace/src/example.js' },
    });
    assert.equal(normalized.mutation, false, toolName);
    assert.equal(normalized.targetResolved, true, toolName);
  }
});

test('recognizes successful native skill reads without treating them as mutations', () => {
  const workspace = tempWorkspace();
  const payload = {
    tool_name: 'read_file',
    tool_input: { filePath: skillFixturePath(workspace, 'create-primitive') },
  };
  assert.equal(activatedSkillFromPayload(payload), 'create-primitive');
  assert.equal(normalizeToolPayload(payload).mutation, false);
  assert.equal(activatedSkillFromPayload({ tool_name: 'read_file', tool_input: { filePath: 'src/example.js' } }), null);
});

test('explicitly truncated native skill reads cannot establish activation', t => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const payload = {
    tool_name: 'read_file',
    tool_input: { filePath: skillFixturePath(workspace, 'create-primitive') },
  };
  for (const metadata of [{ truncated: true }, { tool_response: { truncated: true } }]) {
    assert.equal(activatedSkillFromPayload({ ...payload, ...metadata }), null);
    assert.equal(runHook('record-successful-edit.mjs', workspace, { ...payload, ...metadata }).status, 0);
    assert.equal(fs.existsSync(path.join(workspace, '.harness/session.json')), false);
  }
  assert.equal(activatedSkillFromPayload({ ...payload, tool_response: { truncated: false } }), 'create-primitive');
});

test('native skill read updates current session identity while preserving prior lifecycle and activation state', t => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const plan = writePlan(workspace, { createPrimitive: true });
  writePassedGate(workspace, plan);
  const sessionPath = path.join(workspace, '.harness/session.json');
  const previous = JSON.parse(fs.readFileSync(sessionPath));
  previous.sessionStartedAt = '2000-01-01T00:00:00.000Z';
  previous.activatedSkills = { prior: { sessionId: previous.sessionId, activatedAt: previous.lastGateAt } };
  fs.writeFileSync(sessionPath, JSON.stringify(previous));
  const result = runHook('record-successful-edit.mjs', workspace, {
    session_id: 'new-native-session',
    tool_name: 'read_file',
    tool_input: { filePath: skillFixturePath(workspace, 'create-primitive') },
    tool_response: { truncated: false },
  });
  assert.equal(result.status, 0, result.stderr);
  const current = JSON.parse(fs.readFileSync(sessionPath));
  assert.equal(current.sessionId, 'new-native-session');
  assert.equal(current.activatedSkills['create-primitive'].sessionId, current.sessionId);
  assert.equal(current.sessionStartedAt, current.activatedSkills['create-primitive'].activatedAt);
  assert.deepEqual(current.activatedSkills.prior, previous.activatedSkills.prior);
  for (const field of ['activePlan', 'gatedPlan', 'gatedPlanDigest', 'gateStatus', 'lastGateAt']) {
    assert.deepEqual(current[field], previous[field], field);
  }
});

test('native skill reads without a host session id retain only TTL activation evidence', t => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const plan = writePlan(workspace, { createPrimitive: true });
  writePassedGate(workspace, plan);
  const read = runHook('record-successful-edit.mjs', workspace, {
    session_id: null,
    tool_name: 'read_file',
    tool_input: { filePath: skillFixturePath(workspace, 'create-primitive') },
    tool_response: { truncated: false },
  });
  assert.equal(read.status, 0, read.stderr);
  const current = JSON.parse(fs.readFileSync(path.join(workspace, '.harness/session.json')));
  assert.equal(current.sessionId, 'fixture-session');
  assert.equal(current.activatedSkills['create-primitive'].sessionId, null);
  const mutation = runHook('require-plan-gate.mjs', workspace, {
    session_id: null,
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'packages/ae/corpus/skills/example/SKILL.md' },
  });
  assert.notEqual(outputJson(mutation).hookSpecificOutput?.permissionDecision, 'deny');
});

test('workspace normalization resolves host path aliases before scope checks', () => {
  const workspace = tempWorkspace();
  const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hook-alias-'));
  const alias = path.join(aliasRoot, 'workspace');
  fs.symlinkSync(workspace, alias);
  const normalized = normalizeToolPayload({ cwd: alias });
  assert.equal(normalized.workspace, fs.realpathSync(workspace));
});

test('VS Code transcript metadata resolves the product workspace instead of the installed hook cwd', () => {
  const workspace = tempWorkspace();
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-vscode-storage-'));
  const transcript = path.join(storage, 'GitHub.copilot-chat', 'transcripts', 'session.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(path.join(storage, 'workspace.json'), JSON.stringify({ folder: `file://${workspace}` }));
  const normalized = normalizeToolPayload({
    cwd: path.join(os.homedir(), '.copilot', 'hooks'),
    transcript_path: transcript,
    tool_name: 'replace_string_in_file',
    tool_input: JSON.stringify({ filePath: path.join(workspace, 'src', 'schema.json') }),
  });
  assert.equal(normalized.workspace, fs.realpathSync(workspace));
  assert.deepEqual(normalized.targets, [path.join(workspace, 'src', 'schema.json')]);
});

test('primitive skill parser handles a block list at the end of frontmatter', () => {
  assert.equal(planUsesCreatePrimitive('---\ntitle: Example\nskills_used:\n  - engineer\n  - create-primitive\n---\n'), true);
});

test('recognized file mutation without a resolvable target fails closed', () => {
  const normalized = normalizeToolPayload({
    tool_name: 'replace_string_in_file',
    tool_input: { oldString: 'a', newString: 'b' },
  });
  assert.equal(normalized.mutation, true);
  assert.equal(normalized.targetResolved, false);
});

test('successful tool detection does not treat explicit failures as edits', () => {
  assert.equal(toolMutationSucceeded({ hook_event_name: 'PostToolUse', tool_response: 'ok' }), true);
  assert.equal(toolMutationSucceeded({ hook_event_name: 'PostToolUse', success: false, error: 'failed' }), false);
  assert.equal(toolMutationSucceeded({ hook_event_name: 'PostToolUseFailure', tool_error: 'failed' }), false);
});

test('camelCase ungated mutation returns a structured deny decision', () => {
  const workspace = tempWorkspace();
  const result = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = outputJson(result).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PreToolUse');
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /missing-implement-gate/i);
  assert.match(output.permissionDecisionReason, /ensure-plan\/SKILL\.md/);
  assert.match(output.permissionDecisionReason, /standalone ae plan-update --file start decision/i);
  assert.match(output.permissionDecisionReason, /explicit success[\s\S]*product mutation in a later tool call/i);
});

test('ungated interpreter heredoc mutation returns a structured deny decision', () => {
  const workspace = tempWorkspace();
  const result = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: {
      command: "python3 - <<'PY'\nfrom pathlib import Path\npath = Path('src/schema.json')\npath.write_text('changed')\nPY",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = outputJson(result).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PreToolUse');
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /missing-implement-gate/i);
});

test('heredoc prose is not parsed as additional shell mutation targets', () => {
  const normalized = normalizeToolPayload({
    tool_name: 'run_in_terminal',
    tool_input: {
      command: "mkdir -p docs/guides .github/skills/example\ncat > docs/guides/example.md <<'EOF'\nInstall and use the guide.\nEOF\ncat > .github/skills/example/SKILL.md <<'EOF'\nUse this skill for migrations.\nEOF",
    },
  });
  assert.deepEqual(normalized.targets, [
    'docs/guides/example.md',
    '.github/skills/example/SKILL.md',
    'docs/guides',
    '.github/skills/example',
  ]);
});

test('direct plan creation requires the AE writer before the implement gate', () => {
  const workspace = tempWorkspace();
  const result = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: { command: 'mkdir -p docs/plans && printf plan > docs/plans/2026-07-21-feat-example-plan.md' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(outputJson(result).hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(outputJson(result).hookSpecificOutput.permissionDecisionReason, /managed-plan-write/);
});

test('direct plan writes cannot batch validation or the implement gate', () => {
  const workspace = tempWorkspace();
  const result = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: {
      command: 'printf plan > docs/plans/2026-07-21-feat-example-plan.md && ae gate --phase implement --plan docs/plans/2026-07-21-feat-example-plan.md --workspace . --json',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = outputJson(result).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /managed-plan-write/i);
  assert.match(output.permissionDecisionReason, /ae plan-new.*ae plan-update/i);
});

test('new plan shortcut path is denied before the implement gate', () => {
  const workspace = tempWorkspace();
  const result = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: { command: 'printf plan > docs/plans/example.md' },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = outputJson(result).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /managed-plan-write/i);
});

test('managed plan edits are denied through native, shell, and mixed writes with or without a gate', t => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const plan = writePlan(workspace);
  const legacy = '.harness/plans/existing.hplan';
  fs.mkdirSync(path.join(workspace, '.harness/plans'), { recursive: true });
  fs.writeFileSync(path.join(workspace, legacy), 'existing');
  const original = fs.readFileSync(path.join(workspace, plan), 'utf8');
  const payloads = [
    { tool_name: 'replace_string_in_file', tool_input: { filePath: plan, oldString: 'Fixture', newString: 'Changed' } },
    { tool_name: 'create_file', tool_input: { filePath: 'docs/plans/2026-11-04-fix-new-plan.md', content: 'new' } },
    { tool_name: 'apply_patch', tool_input: { patch: `*** Begin Patch\n*** Update File: ${legacy}\n@@\n-existing\n+changed\n*** End Patch` } },
    { tool_name: 'multi_replace_string_in_file', tool_input: { files: [{ filePath: 'src/schema.json' }, { filePath: plan }] } },
    ...[`set-content -LiteralPath '${plan}' -Value changed`, `Set-Content -LiteralPath '${plan}' -Value changed`, `printf changed > ${plan}`, `printf changed > ${plan} && printf changed > src/schema.json`]
      .map(command => ({ tool_name: 'run_in_terminal', tool_input: { command } })),
  ];
  for (const gated of [false, true]) {
    if (gated) writePassedGate(workspace, plan);
    for (const payload of payloads) {
      const result = runHook('require-plan-gate.mjs', workspace, payload);
      assert.equal(result.status, 0, result.stderr);
      const output = outputJson(result).hookSpecificOutput;
      assert.equal(output?.permissionDecision, 'deny', JSON.stringify({ gated, payload, output }));
      assert.match(output.permissionDecisionReason, /managed-plan-write/, JSON.stringify(payload));
    }
  }
  assert.equal(fs.readFileSync(path.join(workspace, plan), 'utf8'), original);
});

test('plan inspection and standalone canonical plan decisions remain available without a gate', t => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const plan = writePlan(workspace);
  for (const payload of [
    { tool_name: 'read_file', tool_input: { filePath: plan } },
    { tool_name: 'run_in_terminal', tool_input: { command: `Get-Content -LiteralPath '${plan}'` } },
    ...[`"${process.execPath}" "${binPath}" plan-new --workspace "${workspace}" --file - --json`, `"${process.execPath}" "${binPath}" plan-update --workspace "${workspace}" --plan "${plan}" --file - --json`]
      .map(command => ({ tool_name: 'run_in_terminal', tool_input: { command } })),
  ]) {
    const result = runHook('require-plan-gate.mjs', workspace, payload);
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(outputJson(result).hookSpecificOutput?.permissionDecision, 'deny', result.stdout + result.stderr);
  }
});

test('plan protection follows in-workspace aliases and blocks replacing plan ancestors', t => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const plan = writePlan(workspace);
  const full = path.join(workspace, plan);
  fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace('- `src/schema.json`', '- `src/schema.json`\n- `docs`\n- `docs/`\n- `saved-docs`\n- `saved-plan.md`'));
  writePassedGate(workspace, plan);
  const targets = [
    { tool_name: 'run_in_terminal', tool_input: { command: 'mv docs saved-docs' } },
    { tool_name: 'run_in_terminal', tool_input: { command: `mv ${plan} saved-plan.md` } },
    { tool_name: 'create_file', tool_input: { filePath: 'docs/plans/..backup/plan.md', content: 'changed' } },
  ];
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(workspace, 'docs/plans'), path.join(workspace, 'plan-link'), 'dir');
    targets.push({ tool_name: 'replace_string_in_file', tool_input: { filePath: 'plan-link/hook-fixture-plan.md' } });
    targets.push({ tool_name: 'create_file', tool_input: { filePath: 'plan-link/new.hplan', content: 'new' } });
  }
  for (const payload of targets) {
    const result = runHook('require-plan-gate.mjs', workspace, payload);
    assert.equal(outputJson(result).hookSpecificOutput?.permissionDecision, 'deny', result.stdout + result.stderr);
    assert.match(outputJson(result).hookSpecificOutput.permissionDecisionReason, /managed-plan-write/);
  }
  for (const payload of [
    { tool_name: 'create_file', tool_input: { filePath: 'docs/guide.md', content: 'guide' } },
    { tool_name: 'run_in_terminal', tool_input: { command: 'mkdir -p docs' } },
  ]) {
    const result = runHook('require-plan-gate.mjs', workspace, payload);
    assert.notEqual(outputJson(result).hookSpecificOutput?.permissionDecision, 'deny', result.stdout + result.stderr);
  }
});

test('external plan roots inside the workspace remain CLI-owned', t => {
  const workspace = tempWorkspace();
  const previous = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = path.join(workspace, 'ae-state');
  t.after(() => {
    if (previous === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous;
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const root = externalPlansDir(workspace);
  fs.mkdirSync(root, { recursive: true });
  const plan = path.join(root, 'managed.hplan');
  fs.writeFileSync(plan, 'existing');
  for (const target of [plan, path.join(root, 'new.md')]) {
    const result = runHook('require-plan-gate.mjs', workspace, { tool_name: 'create_file', tool_input: { filePath: target, content: 'changed' } });
    assert.equal(outputJson(result).hookSpecificOutput?.permissionDecision, 'deny', result.stdout + result.stderr);
    assert.match(outputJson(result).hookSpecificOutput.permissionDecisionReason, /managed-plan-write/);
  }
});

test('a hardlinked product target cannot mutate a managed plan through its alias', t => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const plan = writePlan(workspace);
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.linkSync(path.join(workspace, plan), path.join(workspace, 'src/schema.json'));
  writePassedGate(workspace, plan);
  const result = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file', tool_input: { filePath: 'src/schema.json' },
  });
  assert.equal(outputJson(result).hookSpecificOutput?.permissionDecision, 'deny', result.stdout + result.stderr);
  assert.match(outputJson(result).hookSpecificOutput.permissionDecisionReason, /hardlink|shared.*target/i);
});

test('new host intent blocks a gated edit until a current plan decision accepts it', t => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);
  const options = { workspace, sessionId: 'vscode-session', planPath: plan };
  const first = observeHostIntent({ ...options, prompt: 'Continue the scoped change.', eventId: 'turn-1', host: 'copilot' });
  const payload = { tool_name: 'replace_string_in_file', tool_input: { filePath: 'src/schema.json' } };
  const probe = () => outputJson(runHook('require-plan-gate.mjs', workspace, payload));
  assert.match(probe().hookSpecificOutput?.permissionDecisionReason || '', /unreconciled-host-intent/);
  const revision = crypto.createHash('sha256').update(fs.readFileSync(path.join(workspace, plan))).digest('hex');
  const input = { action: 'progress', observedIntent: { id: first.id, disposition: 'unchanged', rationale: 'The current scope covers this request.' } };
  const captured = validateObservedIntent({ ...options, input });
  assert.equal(publishObservedIntent({ ...options, captured, input, beforeRevision: revision, afterRevision: revision, operationId: 'accept-turn-1' }), true);
  assert.notEqual(probe().hookSpecificOutput?.permissionDecision, 'deny');
  observeHostIntent({ ...options, prompt: 'Also change the parser behavior.', eventId: 'turn-2', host: 'copilot' });
  assert.equal(publishObservedIntent({ ...options, captured, input, beforeRevision: revision, afterRevision: revision, operationId: 'accept-turn-1' }), false);
  assert.match(probe().hookSpecificOutput?.permissionDecisionReason || '', /unreconciled-host-intent/);
});

test('passed gate allows scoped mutation and primitive target requires current-session create-primitive activation', () => {
  const workspace = tempWorkspace();
  let plan = writePlan(workspace);
  writePassedGate(workspace, plan);

  const allowed = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'multi_replace_string_in_file',
    tool_input: { files: [{ filePath: 'src/schema.json' }] },
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.notEqual(outputJson(allowed).hookSpecificOutput?.permissionDecision, 'deny');

  const primitiveBlocked = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'packages/ae/corpus/skills/example/SKILL.md' },
  });
  assert.equal(outputJson(primitiveBlocked).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(outputJson(primitiveBlocked).hookSpecificOutput.permissionDecisionReason, /create-primitive/i);

  plan = writePlan(workspace, { createPrimitive: true });
  writePassedGate(workspace, plan);
  const notActivated = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'packages/ae/corpus/skills/example/SKILL.md' },
  });
  assert.equal(outputJson(notActivated).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(outputJson(notActivated).hookSpecificOutput.permissionDecisionReason, /create-primitive-activation/i);
  assert.match(outputJson(notActivated).hookSpecificOutput.permissionDecisionReason, /create-primitive\/SKILL\.md/i);

  runHook('record-successful-edit.mjs', workspace, {
    tool_name: 'read_file', tool_input: { filePath: skillFixturePath(workspace, 'create-primitive'), startLine: 1, endLine: 1 },
    tool_response: { content: '---' },
  });
  const partial = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file', tool_input: { filePath: 'packages/ae/corpus/skills/example/SKILL.md' },
  });
  assert.match(outputJson(partial).hookSpecificOutput.permissionDecisionReason, /create-primitive-activation/i);

  const activation = runHook('record-successful-edit.mjs', workspace, {
    hook_event_name: 'PostToolUse',
    tool_name: 'read_file',
    tool_input: { filePath: skillFixturePath(workspace, 'create-primitive') },
    tool_response: { content: fs.readFileSync(skillFixturePath(workspace, 'create-primitive'), 'utf8'), truncated: false },
  });
  assert.equal(activation.status, 0, activation.stderr);
  const recorded = JSON.parse(fs.readFileSync(path.join(workspace, '.harness', 'session.json'), 'utf8'));
  assert.equal(recorded.activatedSkills['create-primitive'].sessionId, 'vscode-session');
  const events = fs.readFileSync(path.join(workspace, '.harness', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.findLast((event) => event.type === 'skill_activation')?.skill, 'create-primitive');

  const primitiveAllowed = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'packages/ae/corpus/skills/example/SKILL.md' },
  });
  assert.notEqual(outputJson(primitiveAllowed).hookSpecificOutput?.permissionDecision, 'deny');
  fs.appendFileSync(skillFixturePath(workspace, 'create-primitive'), 'Changed workflow.\n');
  const changedSource = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'packages/ae/corpus/skills/example/SKILL.md' },
  });
  assert.match(outputJson(changedSource).hookSpecificOutput?.permissionDecisionReason || '', /create-primitive-activation/);
});

test('scoped shell creation permits only ancestor directories of planned files', () => {
  const workspace = tempWorkspace();
  const plan = writePlan(workspace, { createPrimitive: true });
  writePassedGate(workspace, plan);
  runHook('record-successful-edit.mjs', workspace, {
    hook_event_name: 'PostToolUse',
    tool_name: 'read_file',
    tool_input: { filePath: skillFixturePath(workspace, 'create-primitive') },
    tool_response: { content: fs.readFileSync(skillFixturePath(workspace, 'create-primitive'), 'utf8'), truncated: false },
  });

  const allowed = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: {
      command: "mkdir -p packages/ae/corpus/skills/example && printf '%s' skill > packages/ae/corpus/skills/example/SKILL.md",
    },
  });
  assert.notEqual(outputJson(allowed).hookSpecificOutput?.permissionDecision, 'deny');

  const denied = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: { command: 'mkdir -p unrelated' },
  });
  assert.equal(outputJson(denied).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(outputJson(denied).hookSpecificOutput.permissionDecisionReason, /out-of-plan-scope/i);
});

function writeSessionFiles(workspace, files) {
  const sessionPath = path.join(workspace, '.harness', 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  session.files = files;
  fs.writeFileSync(sessionPath, JSON.stringify(session));
}

// These four path-policy unit cases assume an available proof authority. Keep
// the real CLI for the other hook integration cases, including stale gates and
// authority failures. This fixture accepts one captured request and reads only
// its captured plan; unsupported policy requests retain enforce/30 defaults.
function scopeAuthorityFixture(workspace, plan) {
  const canonicalWorkspace = fs.realpathSync(workspace);
  const planPath = path.join(canonicalWorkspace, plan);
  const bytes = fs.readFileSync(planPath);
  const bytesHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const digest = crypto.createHash('sha256').update(planContractText(bytes.toString('utf8'))).digest('hex');
  const expected = ['status', '--contract-digest', '--plan', plan, '--json', '--no-events', '--workspace', canonicalWorkspace];
  const authority = path.join(canonicalWorkspace, '.harness', 'exclusive-scope-authority.mjs');
  fs.mkdirSync(path.dirname(authority), { recursive: true });
  fs.writeFileSync(authority, `import fs from 'node:fs';
import crypto from 'node:crypto';
const expected = ${JSON.stringify(expected)};
const actual = process.argv.slice(2);
if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) process.exit(2);
try {
  if (fs.realpathSync(process.cwd()) !== ${JSON.stringify(canonicalWorkspace)}) process.exit(2);
  const planPath = ${JSON.stringify(planPath)};
  if (!fs.lstatSync(planPath).isFile()) process.exit(3);
  const bytes = fs.readFileSync(planPath);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== ${JSON.stringify(bytesHash)}) process.exit(3);
} catch { process.exit(3); }
process.stdout.write(JSON.stringify({ digest: ${JSON.stringify(digest)} }) + '\\n');
`);
  return authority;
}

function hookDiagnostic(result) {
  return JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2);
}

test('exclusive scope authority fixture accepts only its captured plan request and bytes', (t) => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const plan = writePlan(workspace), authority = scopeAuthorityFixture(workspace, plan);
  const expected = ['status', '--contract-digest', '--plan', plan, '--json', '--no-events', '--workspace', fs.realpathSync(workspace)];
  const run = args => spawnSync(process.execPath, [authority, ...args], { cwd: workspace, encoding: 'utf8', timeout: 10000 });
  const valid = run(expected);
  assert.equal(valid.status, 0, valid.stderr + valid.stdout);
  assert.deepEqual(JSON.parse(valid.stdout), { digest: crypto.createHash('sha256').update(planContractText(fs.readFileSync(path.join(workspace, plan), 'utf8'))).digest('hex') });
  for (const args of [
    ['status', '--effective-policy', '--json', '--no-events', '--workspace', workspace],
    [...expected, '--validate-completion'],
    expected.map((value, index) => index === 3 ? '../outside-plan.md' : value),
    expected.map((value, index) => index === 7 ? path.dirname(workspace) : value),
  ]) {
    const rejected = run(args);
    assert.equal(rejected.status, 2, rejected.stderr + rejected.stdout);
    assert.equal(rejected.stdout, '');
  }
  fs.appendFileSync(path.join(workspace, plan), '\nChanged fixture bytes.\n');
  const changed = run(expected);
  assert.equal(changed.status, 3, changed.stderr + changed.stdout);
  assert.equal(changed.stdout, '');
});

test('a non-empty orient file list allows only those governed paths', (t) => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);
  const authorityBin = scopeAuthorityFixture(workspace, plan);
  writeSessionFiles(workspace, ['src/schema.json']);

  const allowed = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
  }, { authorityBin });
  assert.equal(allowed.status, 0, hookDiagnostic(allowed));
  assert.equal(outputJson(allowed).continue, true, hookDiagnostic(allowed));

  const denied = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: '.github/skills/example/SKILL.md' },
  }, { authorityBin });
  assert.equal(denied.status, 0, hookDiagnostic(denied));
  const reason = outputJson(denied).hookSpecificOutput.permissionDecisionReason;
  assert.equal(outputJson(denied).hookSpecificOutput.permissionDecision, 'deny', hookDiagnostic(denied));
  assert.match(reason, /outside-exclusive-files/, hookDiagnostic(denied));
  assert.match(reason, /\.github\/skills\/example\/SKILL\.md/);
  assert.match(reason, /ae orient --read/);
  assert.doesNotMatch(reason, /--query/);
  assert.doesNotMatch(reason, /--file/);

  writeSessionFiles(workspace, []);
  const emptyList = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
  }, { authorityBin });
  assert.equal(emptyList.status, 0, hookDiagnostic(emptyList));
  assert.equal(outputJson(emptyList).continue, true, hookDiagnostic(emptyList));
});

test('an exclusive directory or glob entry does not authorize other files', (t) => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);
  const authorityBin = scopeAuthorityFixture(workspace, plan);

  for (const entry of ['src/', 'src/**']) {
    writeSessionFiles(workspace, [entry]);
    const denied = runHook('require-plan-gate.mjs', workspace, {
      tool_name: 'replace_string_in_file',
      tool_input: { filePath: 'src/schema.json' },
    }, { authorityBin });
    assert.equal(denied.status, 0, hookDiagnostic(denied));
    const output = outputJson(denied).hookSpecificOutput || {};
    assert.equal(output.permissionDecision, 'deny', `${entry}\n${hookDiagnostic(denied)}`);
    assert.match(output.permissionDecisionReason, /outside-exclusive-files/, hookDiagnostic(denied));
    assert.match(output.permissionDecisionReason, /src\/schema\.json/);
  }
});

test('an absolute exclusive path allows the same workspace file and rejects a path outside it', (t) => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);
  const authorityBin = scopeAuthorityFixture(workspace, plan);
  writeSessionFiles(workspace, [path.join(workspace, 'src', 'schema.json')]);

  const allowed = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
  }, { authorityBin });
  assert.equal(allowed.status, 0, hookDiagnostic(allowed));
  assert.equal(outputJson(allowed).continue, true, hookDiagnostic(allowed));

  writeSessionFiles(workspace, [path.join(os.tmpdir(), 'outside-exclusive', 'src', 'schema.json')]);
  const denied = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
  }, { authorityBin });
  assert.equal(denied.status, 0, hookDiagnostic(denied));
  const output = outputJson(denied).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny', hookDiagnostic(denied));
  assert.match(output.permissionDecisionReason, /outside-exclusive-files/, hookDiagnostic(denied));
});

test('mkdir may create a parent of an exclusive file and no other directory', (t) => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const plan = writePlan(workspace);
  const planPath = path.join(workspace, plan);
  fs.writeFileSync(
    planPath,
    fs.readFileSync(planPath, 'utf8').replace('- `src/schema.json`', '- `src/schema.json`\n- `src/new/file.js`'),
  );
  writePassedGate(workspace, plan);
  const authorityBin = scopeAuthorityFixture(workspace, plan);
  writeSessionFiles(workspace, ['src/new/file.js']);

  const parent = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: { command: 'mkdir -p src/new' },
  }, { authorityBin });
  assert.equal(parent.status, 0, hookDiagnostic(parent));
  assert.equal(outputJson(parent).continue, true, hookDiagnostic(parent));

  const sibling = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: { command: 'mkdir -p .github/skills' },
  }, { authorityBin });
  assert.equal(sibling.status, 0, hookDiagnostic(sibling));
  const output = outputJson(sibling).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny', hookDiagnostic(sibling));
  assert.match(output.permissionDecisionReason, /outside-exclusive-files/, hookDiagnostic(sibling));
});

test('planned gate requires an in-progress transition and fresh gate before product mutation', () => {
  const workspace = tempWorkspace();
  const plan = writePlan(workspace);
  const planPath = path.join(workspace, plan);
  fs.writeFileSync(planPath, fs.readFileSync(planPath, 'utf8').replace('status: in-progress', 'status: planned'));
  writePassedGate(workspace, plan);

  const result = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
  });

  const output = outputJson(result).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /plan-not-in-progress/i);
  assert.match(output.permissionDecisionReason, /planned to in-progress[\s\S]*rerun the implement gate/i);
});

test('passed gate rejects a lexically scoped symlink that escapes the workspace', () => {
  const workspace = tempWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hook-outside-'));
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);
  fs.symlinkSync(outside, path.join(workspace, 'linked'));

  const result = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'linked/escape.json' },
  });

  const output = outputJson(result).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /outside-workspace/i);
});

test('safety guards preserve force-push coverage without overblocking ordinary credential names', () => {
  const workspace = tempWorkspace();
  for (const command of [
    'git push --force-with-lease origin main',
    'git push origin main --force',
    'git push -f origin main',
    'git push -fv origin main',
    'git push origin main -f',
    'git push origin main -fv',
  ]) {
    const blocked = runHook('block-destructive-commands.mjs', process.cwd(), {
      tool_name: 'Bash',
      tool_input: { command },
    });
    assert.equal(outputJson(blocked).hookSpecificOutput?.permissionDecision, 'deny', command);
  }

  const ordinary = runHook('guard-critical-files.mjs', process.cwd(), {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/credentialsManager.ts' },
  });
  assert.notEqual(outputJson(ordinary).hookSpecificOutput?.permissionDecision, 'deny');
  const secret = runHook('guard-critical-files.mjs', process.cwd(), {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: '.env.local' },
  });
  assert.equal(outputJson(secret).hookSpecificOutput?.permissionDecision, 'deny');

  const recoverySkillRead = runHook('guard-critical-files.mjs', process.cwd(), {
    tool_name: 'read_file',
    tool_input: { filePath: skillFixturePath(workspace, 'ensure-plan') },
  });
  assert.notEqual(outputJson(recoverySkillRead).hookSpecificOutput?.permissionDecision, 'deny');

  const terminalSecret = runHook('guard-critical-files.mjs', process.cwd(), {
    tool_name: 'Bash',
    tool_input: { command: 'printf secret>.env.local' },
  });
  assert.equal(outputJson(terminalSecret).hookSpecificOutput?.permissionDecision, 'deny');

  const runtimeState = runHook('guard-critical-files.mjs', process.cwd(), {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: '.harness/session.json' },
  });
  assert.equal(outputJson(runtimeState).hookSpecificOutput?.permissionDecision, 'deny');

  const terminalRuntimeState = runHook('guard-critical-files.mjs', process.cwd(), {
    tool_name: 'Bash',
    tool_input: { command: 'printf "{}">.harness/session.json' },
  });
  assert.equal(outputJson(terminalRuntimeState).hookSpecificOutput?.permissionDecision, 'deny');
});

test('plan edits require a fresh implement gate before product mutation', () => {
  const workspace = tempWorkspace();
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);

    fs.appendFileSync(path.join(workspace, plan), '\n### Session log\n\n- Activity appended mid-phase.\n');
  const activityAllowed = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
  });
  assert.notEqual(outputJson(activityAllowed).hookSpecificOutput?.permissionDecision, 'deny');

  fs.appendFileSync(path.join(workspace, plan), '\n## Extra Scope\n\n- `src/other.json`\n');
  const result = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
  });

  const output = outputJson(result).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /plan changed after the implement gate/i);
});

test('PostToolUse records only successful mutations and emits event schema v2', () => {
  const workspace = tempWorkspace();
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);

  const failed = runHook('record-successful-edit.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
    success: false,
    error: 'edit failed',
  });
  assert.equal(failed.status, 0, failed.stderr);
  let session = JSON.parse(fs.readFileSync(path.join(workspace, '.harness', 'session.json'), 'utf8'));
  assert.equal(session.lastEditAt, undefined);

  const passed = runHook('record-successful-edit.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
    tool_response: 'File edited successfully',
  });
  assert.equal(passed.status, 0, passed.stderr);
  session = JSON.parse(fs.readFileSync(path.join(workspace, '.harness', 'session.json'), 'utf8'));
  assert.match(session.lastEditAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(session.lastEditTool, 'replace_string_in_file');
  assert.equal(session.lastEditPlan, plan);
  assert.deepEqual(session.lastEditTargets, ['src/schema.json']);

  const events = fs.readFileSync(path.join(workspace, '.harness', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const event = events.at(-1);
  assert.equal(event.version, 2);
  assert.equal(event.type, 'post_tool');
  assert.equal(event.session, 'vscode-session');
  assert.equal(event.host, 'github-copilot-vscode');
  assert.equal(event.tool, 'replace_string_in_file');
  assert.equal(event.mutation, true);
  assert.deepEqual(event.targets, ['src/schema.json']);
  assert.equal(event.decision, 'record');
  assert.equal(event.success, true);
});

test('successful PostToolUse without a session persists pending completion state', () => {
  const workspace = tempWorkspace();
  const post = runHook('record-successful-edit.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
    tool_response: 'File edited successfully',
  });
  assert.equal(post.status, 0, post.stderr);
  assert.match(outputJson(post).systemMessage, /without an implement gate/i);

  const session = JSON.parse(fs.readFileSync(path.join(workspace, '.harness', 'session.json'), 'utf8'));
  assert.equal(session.gateStatus, 'missing');
  assert.match(session.lastEditAt, /^\d{4}-\d{2}-\d{2}T/);
  const stop = runHook('require-verification.mjs', workspace, {
    hook_event_name: 'Stop',
    stop_hook_active: false,
  });
  assert.equal(outputJson(stop).hookSpecificOutput?.decision, 'block');
});

test('Stop returns a structured block while a successful edit lacks verification', () => {
  const workspace = tempWorkspace();
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);
  const sessionPath = path.join(workspace, '.harness', 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  session.lastEditAt = new Date().toISOString();
  fs.writeFileSync(sessionPath, JSON.stringify(session));

  const result = runHook('require-verification.mjs', workspace, {
    hook_event_name: 'Stop',
    stop_hook_active: false,
  });

  assert.equal(result.status, 0, result.stderr);
  const output = outputJson(result).hookSpecificOutput;
  assert.equal(output.hookEventName, 'Stop');
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /verification outcome is (inconclusive|failed)/i);
});

test('Stop resolves the product workspace from VS Code transcript metadata', () => {
  const workspace = tempWorkspace();
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);
  const sessionPath = path.join(workspace, '.harness', 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  session.lastEditAt = new Date().toISOString();
  fs.writeFileSync(sessionPath, JSON.stringify(session));

  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-vscode-stop-storage-'));
  const transcript = path.join(storage, 'GitHub.copilot-chat', 'transcripts', 'session.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(path.join(storage, 'workspace.json'), JSON.stringify({ folder: `file://${workspace}` }));

  const result = runHook('require-verification.mjs', workspace, {
    cwd: path.join(os.homedir(), '.copilot', 'hooks'),
    transcript_path: transcript,
    hook_event_name: 'Stop',
    stop_hook_active: false,
  });

  const output = outputJson(result).hookSpecificOutput;
  assert.equal(output.hookEventName, 'Stop');
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /verification outcome is (inconclusive|failed)/i);
});

test('hook configuration registers official lifecycle events from a deterministic cwd', () => {
  const config = JSON.parse(fs.readFileSync(path.join(hooksRoot, 'hooks.json'), 'utf8'));
  assert.ok(config.hooks.PreToolUse?.length);
  assert.ok(config.hooks.PostToolUse?.length);
  assert.ok(config.hooks.Stop?.length);
  for (const event of ['PreToolUse', 'PostToolUse', 'Stop']) {
    const commands = config.hooks[event].flatMap((entry) => entry.hooks || [entry]);
    assert.ok(commands.every((command) => command.cwd === 'hooks'), `${event} cwd`);
  }
});

test('SessionStart runtime context reinforces the critical Engineer Investigate contract', () => {
  const workspace = tempWorkspace();
  const result = runHook('load-context.mjs', workspace, {});
  assert.equal(result.status, 0, result.stderr);
  const output = outputJson(result);
  assert.match(output.additionalContext, /@engineer[\s\S]{0,100}Mode: Answer\|Investigate\|Review\|Deliver/i);
  assert.match(output.additionalContext, /engineer\.agent\.md/);
  assert.doesNotMatch(output.additionalContext, /confirmed race\/retry defect/i);
  assert.match(output.additionalContext, /missing-implement-gate[\s\S]{0,160}ensure-plan\/SKILL\.md/i);
});

function writeScoredPlan(full, { lock, status }) {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `---\nplan_lock: ${lock}\nstatus: ${status}\n---\n\n# ${path.basename(full)}\n`);
}

function withExternalHome(run) {
  const workspace = tempWorkspace();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-ext-home-'));
  const previous = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  try {
    return run(workspace, home);
  } finally {
    if (previous === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous;
    const cleanup = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
    try {
      fs.rmSync(workspace, cleanup);
    } finally {
      fs.rmSync(home, cleanup);
    }
  }
}

function activePlanLine(additionalContext) {
  return String(additionalContext || '').split('\n').find((entry) => entry.startsWith('- Active plan candidate:'));
}

test('SessionStart names an external plan when session.activePlan is unset', () => {
  withExternalHome((workspace) => {
    const plan = path.join(externalPlansDir(workspace), '2026-10-02-fix-external-only.md');
    writeScoredPlan(plan, { lock: true, status: 'in-progress' });
    const result = runHook('load-context.mjs', workspace, {});
    assert.equal(result.status, 0, result.stderr);
    const output = outputJson(result);
    assert.equal(activePlanLine(output.additionalContext), `- Active plan candidate: ${plan}`);
  });
});

test('SessionStart keeps a docs/plans candidate workspace-relative', () => {
  const workspace = tempWorkspace();
  try {
    const rel = writePlan(workspace);
    const result = runHook('load-context.mjs', workspace, {});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(activePlanLine(outputJson(result).additionalContext), `- Active plan candidate: ${rel}`);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('SessionStart prefers the higher-scoring plan when an external plan and a docs plan both exist', () => {
  withExternalHome((workspace) => {
    const external = path.join(externalPlansDir(workspace), '2026-10-02-fix-external-plan.md');
    writeScoredPlan(external, { lock: true, status: 'in-progress' });
    writeScoredPlan(path.join(workspace, 'docs/plans/open-plan.md'), { lock: false, status: 'open' });
    const result = runHook('load-context.mjs', workspace, {});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(activePlanLine(outputJson(result).additionalContext), `- Active plan candidate: ${external}`);
  });
});

test('SessionStart skips a done plan when session.activePlan is unset', () => {
  withExternalHome((workspace) => {
    const finished = path.join(externalPlansDir(workspace), '2026-10-02-fix-finished-plan.md');
    writeScoredPlan(finished, { lock: true, status: 'done' });
    const rel = 'docs/plans/open-plan.md';
    writeScoredPlan(path.join(workspace, rel), { lock: false, status: 'planned' });
    const result = runHook('load-context.mjs', workspace, {});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(activePlanLine(outputJson(result).additionalContext), `- Active plan candidate: ${rel}`);
  });

  withExternalHome((workspace) => {
    const finished = path.join(externalPlansDir(workspace), '2026-10-02-fix-finished-plan.md');
    writeScoredPlan(finished, { lock: true, status: 'done' });
    const result = runHook('load-context.mjs', workspace, {});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(activePlanLine(outputJson(result).additionalContext), undefined);
  });
});

test('session.activePlan wins over a higher-scoring plan file', () => {
  withExternalHome((workspace) => {
    const external = path.join(externalPlansDir(workspace), '2026-10-02-fix-external-plan.md');
    writeScoredPlan(external, { lock: true, status: 'in-progress' });
    const chosen = 'docs/plans/open-plan.md';
    writeScoredPlan(path.join(workspace, chosen), { lock: false, status: 'open' });
    fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.harness', 'session.json'), JSON.stringify({
      activePlan: chosen,
      gateStatus: 'pass',
    }));
    const result = runHook('load-context.mjs', workspace, {});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(activePlanLine(outputJson(result).additionalContext), `- Active plan candidate: ${chosen}`);
  });
});

test('SessionStart skips an external plans path that is not a directory', () => {
  withExternalHome((workspace) => {
    const external = externalPlansDir(workspace);
    fs.mkdirSync(path.dirname(external), { recursive: true });
    fs.writeFileSync(external, 'not a directory\n');
    const rel = 'docs/plans/open-plan.md';
    writeScoredPlan(path.join(workspace, rel), { lock: true, status: 'in-progress' });
    const result = runHook('load-context.mjs', workspace, {});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(activePlanLine(outputJson(result).additionalContext), `- Active plan candidate: ${rel}`);
    const preserved = runHook('preserve-context.mjs', workspace, {});
    assert.equal(preserved.status, 0, preserved.stderr);
    assert.equal(
      outputJson(preserved).additionalContext,
      '[harness hook] Preserve before compact:\n- plans dir: docs/plans/'
    );
  });
});

test('preserve-context names an external plan directory and still names docs/plans', () => {
  withExternalHome((workspace) => {
    const dir = externalPlansDir(workspace);
    fs.mkdirSync(dir, { recursive: true });
    const externalOnly = runHook('preserve-context.mjs', workspace, {});
    assert.equal(externalOnly.status, 0, externalOnly.stderr);
    assert.equal(
      outputJson(externalOnly).additionalContext,
      `[harness hook] Preserve before compact:\n- plans dir: ${dir}/`
    );
  });

  const workspace = tempWorkspace();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-ext-home-'));
  const previous = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  try {
    fs.mkdirSync(path.join(workspace, 'docs', 'plans'), { recursive: true });
    const docsOnly = runHook('preserve-context.mjs', workspace, {});
    assert.equal(docsOnly.status, 0, docsOnly.stderr);
    assert.equal(
      outputJson(docsOnly).additionalContext,
      '[harness hook] Preserve before compact:\n- plans dir: docs/plans/'
    );
  } finally {
    if (previous === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('shell analyzer catches clobber redirects, dd, nested shells, and PowerShell writers', () => {
  const cases = [
    ['echo x >| .harness/session.json', ['.harness/session.json']],
    ['echo x 1>| .env', ['.env']],
    ['dd if=/dev/zero of=.env bs=1 count=1', ['.env']],
    ['sh -c "rm -rf docs"', ['docs']],
    ['bash -lc "touch src/a.json"', ['src/a.json']],
    ['env FOO=1 touch src/a.json', ['src/a.json']],
    ['echo x | tee src/a.json', ['src/a.json']],
    ["python3 -c \"open('src/a.json', 'w').write('x')\"", ['src/a.json']],
    ['Set-Content .env secret', ['.env']],
    ['Add-Content -Path .env secret', ['.env']],
    ['Out-File -FilePath src/a.json', ['src/a.json']],
    ['Remove-Item -Recurse -Force src', ['src']],
    ['powershell -Command "Set-Content .env secret"', ['.env']],
  ];
  for (const [command, targets] of cases) {
    const analyzed = analyzeShellMutation(command);
    assert.equal(analyzed.mutation, true, command);
    assert.deepEqual(analyzed.targets, targets, command);
  }
});

test('mkdir ancestor exception applies only to paths mkdir alone creates', () => {
  const compound = analyzeShellMutation('mkdir -p src && rm -rf src');
  assert.equal(compound.mutation, true);
  assert.deepEqual(compound.mkdirTargets, []);
  const benign = analyzeShellMutation('mkdir -p src/generated && touch src/generated/a.json');
  assert.deepEqual(benign.mkdirTargets, ['src/generated']);

  const workspace = tempWorkspace();
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);
  const denied = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: { command: 'mkdir -p src && rm -rf src' },
  });
  assert.equal(outputJson(denied).hookSpecificOutput?.permissionDecision, 'deny');
});

test('unrecognized tools carrying file targets fail closed as mutations', () => {
  const normalized = normalizeToolPayload({
    tool_name: 'future_edit_tool',
    tool_input: { filePath: 'src/a.json' },
  });
  assert.equal(normalized.mutation, true);
  assert.deepEqual(normalized.targets, ['src/a.json']);

  for (const toolName of ['insert_edit_into_file', 'edit_notebook_file', 'create_directory']) {
    assert.equal(
      normalizeToolPayload({ tool_name: toolName, tool_input: { filePath: 'src/a.json' } }).mutation,
      true,
      toolName
    );
  }

  const workspace = tempWorkspace();
  const denied = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'future_edit_tool',
    tool_input: { filePath: 'src/a.json' },
  });
  assert.equal(outputJson(denied).hookSpecificOutput?.permissionDecision, 'deny');

  const pending = runHook('record-successful-edit.mjs', workspace, {
    hook_event_name: 'PostToolUse',
    tool_name: 'future_edit_tool',
    tool_input: { filePath: 'src/a.json' },
    tool_response: 'File edited successfully',
  });
  assert.equal(pending.status, 0, pending.stderr);
  const session = JSON.parse(fs.readFileSync(path.join(workspace, '.harness', 'session.json'), 'utf8'));
  assert.ok(session.lastEditAt, 'unknown edit tools must still create pending verification state');
});

test('apply_patch move destinations are scoped targets', () => {
  const normalized = normalizeToolPayload({
    tool_name: 'apply_patch',
    tool_input: {
      patch: '*** Begin Patch\n*** Update File: src/a.json\n*** Move to: src/renamed.json\n*** End Patch',
    },
  });
  assert.deepEqual(normalized.targets, ['src/a.json', 'src/renamed.json']);
});

test('hook denials expose both VS Code and Copilot CLI decision shapes', () => {
  const workspace = tempWorkspace();
  const denied = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/a.json' },
  });
  const output = outputJson(denied);
  assert.equal(output.permissionDecision, 'deny');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(output.permissionDecisionReason, output.hookSpecificOutput.permissionDecisionReason);

  writePassedGate(workspace, writePlan(workspace));
  runHook('record-successful-edit.mjs', workspace, {
    hook_event_name: 'PostToolUse',
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
    tool_response: 'File edited successfully',
  });
  const stop = runHook('require-verification.mjs', workspace, { hook_event_name: 'Stop', stop_hook_active: false });
  const stopOutput = outputJson(stop);
  assert.equal(stopOutput.decision, 'block');
  assert.equal(stopOutput.hookSpecificOutput.decision, 'block');
});

test('safety guards fail closed on malformed payloads', () => {
  for (const hook of ['guard-critical-files.mjs', 'block-destructive-commands.mjs']) {
    const result = spawnSync(process.execPath, [path.join(hooksRoot, hook)], {
      cwd: tempWorkspace(),
      input: '{not-json',
      encoding: 'utf8',
      env: { ...process.env, HARNESS_ENFORCEMENT: 'enforce' },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = outputJson(result);
    assert.equal(output.hookSpecificOutput?.permissionDecision, 'deny', hook);
    assert.match(output.hookSpecificOutput?.permissionDecisionReason || '', /invalid-hook-payload/, hook);
  }

  const recorder = spawnSync(process.execPath, [path.join(hooksRoot, 'record-successful-edit.mjs')], {
    cwd: tempWorkspace(),
    input: '{not-json',
    encoding: 'utf8',
  });
  assert.equal(recorder.status, 0, recorder.stderr);
  const recorderOutput = outputJson(recorder);
  assert.equal(recorderOutput.continue, true);
  assert.match(recorderOutput.systemMessage || '', /invalid-hook-payload/);
});

test('destructive push guard blocks refspec force pushes without overblocking benign flags', () => {
  const workspace = tempWorkspace();
  for (const command of [
    'git push origin +main',
    'git push origin +HEAD:main',
    'git push origin :main',
    'git push --force origin feature:main',
    'git push --repo origin +HEAD:main',
    'git -C . push --force origin main',
    "sh -c 'git push --force origin main'",
    'bash -lc "git push --force origin main"',
    'pwsh -Command "git push --force origin main"',
    'git push --delete origin main',
    'git push origin -d main',
    'git PUSH --force origin main',
    'git push --mirror origin',
    'git push --force --all origin',
    'git push --force origin',
    "env -S 'git push --force origin main'",
    "timeout 5 bash -c 'git push --force origin main'",
    "nice bash -c 'git push --force origin main'",
    'xargs git push --force origin',
    'xargs -I {} git push --force origin main',
  ]) {
    const blocked = runHook('block-destructive-commands.mjs', workspace, {
      tool_name: 'Bash',
      tool_input: { command },
    });
    assert.equal(outputJson(blocked).hookSpecificOutput?.permissionDecision, 'deny', command);
  }
  for (const command of [
    'git push --ff-only origin main',
    'git push --follow-tags origin main',
    'git push origin main',
    'git push origin HEAD:main',
    'git push origin +main:feature',
    'git push --force origin main:feature',
  ]) {
    const allowed = runHook('block-destructive-commands.mjs', workspace, {
      tool_name: 'Bash',
      tool_input: { command },
    });
    assert.notEqual(outputJson(allowed).hookSpecificOutput?.permissionDecision, 'deny', command);
  }
});

test('critical-file guard blocks .envrc and symlinked sensitive paths', () => {
  const workspace = tempWorkspace();
  const envrc = runHook('guard-critical-files.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: '.envrc' },
  });
  assert.equal(outputJson(envrc).hookSpecificOutput?.permissionDecision, 'deny');

  fs.writeFileSync(path.join(workspace, '.env'), 'SECRET=1\n');
  fs.symlinkSync(path.join(workspace, '.env'), path.join(workspace, 'config.txt'));
  const symlinked = runHook('guard-critical-files.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'config.txt' },
  });
  assert.equal(outputJson(symlinked).hookSpecificOutput?.permissionDecision, 'deny');
});

test('out-of-plan verification enforcement parses block-list verification.required', () => {
  const workspace = tempWorkspace();
  const plan = writePlan(workspace);
  const planPath = path.join(workspace, plan);
  const blockList = fs
    .readFileSync(planPath, 'utf8')
    .replace(
      'required: [harness-tests, prompt-contracts, host-contracts, build-assets]',
      'required:\n    - harness-tests\n    - prompt-contracts\n    - host-contracts\n    - build-assets'
    );
  fs.writeFileSync(planPath, blockList);
  fs.writeFileSync(
    path.join(workspace, '.github', 'harness', 'checks.yaml'),
    'version: 1\nchecks:\n  harness-tests:\n    command: ["node", "scripts/run-harness-tests.mjs"]\n  schema-validation:\n    command: ["node", "scripts/validate-schema.mjs"]\n',
    'utf8'
  );
  writePassedGate(workspace, plan);
  const denied = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'run_in_terminal',
    tool_input: { command: 'node scripts/validate-schema.mjs' },
  });
  assert.equal(outputJson(denied).hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(outputJson(denied).hookSpecificOutput?.permissionDecisionReason || '', /out-of-plan-verification/);
});

test('primitive activation without a host session id is accepted only while fresh', () => {
  const workspace = tempWorkspace();
  const plan = writePlan(workspace, { createPrimitive: true });
  writePassedGate(workspace, plan);
  runHook('record-successful-edit.mjs', workspace, {
    session_id: null,
    tool_name: 'read_file',
    tool_input: { filePath: skillFixturePath(workspace, 'create-primitive') },
    tool_response: { truncated: false },
  });
  const session = JSON.parse(fs.readFileSync(path.join(workspace, '.harness', 'session.json'), 'utf8'));

  const noSession = spawnSync(process.execPath, [path.join(hooksRoot, 'require-plan-gate.mjs')], {
    cwd: workspace,
    input: JSON.stringify({
      cwd: workspace,
      hook_event_name: 'PreToolUse',
      tool_name: 'replace_string_in_file',
      tool_input: { filePath: '.github/checks/example.md' },
    }),
    encoding: 'utf8',
    env: { ...process.env, COPILOT_HOME: path.join(workspace, 'copilot-home'), HARNESS_ENFORCEMENT: 'enforce' },
  });
  assert.notEqual(outputJson(noSession).hookSpecificOutput?.permissionDecision, 'deny', noSession.stdout);

  session.activatedSkills['create-primitive'].activatedAt = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(workspace, '.harness', 'session.json'), JSON.stringify(session));
  const stale = spawnSync(process.execPath, [path.join(hooksRoot, 'require-plan-gate.mjs')], {
    cwd: workspace,
    input: JSON.stringify({
      cwd: workspace,
      hook_event_name: 'PreToolUse',
      tool_name: 'replace_string_in_file',
      tool_input: { filePath: '.github/checks/example.md' },
    }),
    encoding: 'utf8',
    env: { ...process.env, COPILOT_HOME: path.join(workspace, 'copilot-home'), HARNESS_ENFORCEMENT: 'enforce' },
  });
  assert.equal(outputJson(stale).hookSpecificOutput?.permissionDecision, 'deny');

  const personal = spawnSync(process.execPath, [path.join(hooksRoot, 'require-plan-gate.mjs')], {
    cwd: workspace,
    input: JSON.stringify({
      cwd: workspace,
      hook_event_name: 'PreToolUse',
      tool_name: 'replace_string_in_file',
      tool_input: { filePath: '.github/skills/example/SKILL.md' },
    }),
    encoding: 'utf8',
    env: { ...process.env, HARNESS_ENFORCEMENT: 'enforce' },
  });
  assert.equal(outputJson(personal).hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(outputJson(personal).hookSpecificOutput?.permissionDecisionReason || '', /ae resources create/);
});

test('hook and CLI primitive path rules and plan digests stay in parity', async () => {
  const cliGovernance = await import('../lib/primitive-governance.mjs');
  const cliEvidence = await import('../lib/evidence.mjs');
  const hookPayload = await import('../corpus/hooks/lib/tool-payload.mjs');
  const samples = [
    '.github/skills/example/SKILL.md',
    '.github/agents/engineer.agent.md',
    '.github/instructions/global.instructions.md',
    'packages/ae/corpus/skills/example/SKILL.md',
    'packages/ae/corpus/agents/engineer.agent.md',
    'packages/ae/corpus/instructions/global.instructions.md',
    'packages/ae/corpus/enterprise/skills/example/SKILL.md',
    'packages/ae/corpus/knowledge/capability-registry.yaml',
    '.github/prompts/example.prompt.md',
    '.github/checks/example.md',
    'enterprise/skills/example/SKILL.md',
    'knowledge/capability-registry.yaml',
    'src/app.js',
    'docs/plans/example-plan.md',
    '.github/workflows/ci.yml',
  ];
  for (const sample of samples) {
    assert.equal(
      cliGovernance.isPrimitivePath(sample),
      hookPayload.isPrimitivePath(sample),
      `primitive-path divergence: ${sample}`
    );
  }

  const fixture = '---\ntitle: X\n---\n\n## Overview\n\nBody.\n\n## Activity\n\n- Logged.\n';
  const hookDigest = crypto.createHash('sha256').update(planContractText(fixture)).digest('hex');
  assert.equal(cliEvidence.planDigest(fixture), hookDigest, 'plan digest algorithms diverged');
});

test('every enforcement denial names an actionable next command', () => {
  const workspace = tempWorkspace();
  // Missing-gate denial (PreToolUse)
  const missing = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/a.json' },
  });
  const missingReason = outputJson(missing).hookSpecificOutput?.permissionDecisionReason || '';
  assert.match(missingReason, /ensure-plan\/SKILL\.md|ae gate|Read ~/, 'gate denial must carry a recipe');

  // Out-of-plan-scope denial
  const plan = writePlan(workspace);
  writePassedGate(workspace, plan);
  const outOfScope = runHook('require-plan-gate.mjs', workspace, {
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/unplanned-file.json' },
  });
  assert.match(
    outputJson(outOfScope).hookSpecificOutput?.permissionDecisionReason || '',
    /next: add it to ## Impacted Files/,
    'scope denial must tell the agent how to recover'
  );

  // Stop-hook denial carries a verify recipe
  runHook('record-successful-edit.mjs', workspace, {
    hook_event_name: 'PostToolUse',
    tool_name: 'replace_string_in_file',
    tool_input: { filePath: 'src/schema.json' },
    tool_response: 'File edited successfully',
  });
  const stop = runHook('require-verification.mjs', workspace, { hook_event_name: 'Stop', stop_hook_active: false });
  assert.match(outputJson(stop).hookSpecificOutput?.reason || '', /next: run `ae verify/, 'Stop denial must carry a verify recipe');
});

test('scoped todo controls recognize only exact supported metadata operations', () => {
  assert.equal(harnessControlCommand(['harness', 'todo', 'list'], process.cwd()), 'todo');
  assert.equal(harnessControlCommand(['harness', 'todo', '--json', '--plan', 'accepted.md'], process.cwd()), 'todo');
  assert.equal(harnessControlCommand(['harness', 'todo', 'sync', '--plan', 'docs/plans/accepted.md', '--json'], process.cwd()), 'todo');
  assert.equal(harnessControlCommand(['harness', 'todo', 'complete', '--plan=docs/plans/accepted.md', '--id', `${'a'.repeat(64)}:S1`], process.cwd()), 'todo');
  for (const args of [['sync'], ['clear'], ['add', '--text', 'opaque'], ['sync', '--plan', 'accepted.md', '--unknown'], ['complete', '--id', 't1'], ['list', '--plan'], ['sync', '--plan', 'a', '--plan', 'b']]) assert.equal(harnessControlCommand(['harness', 'todo', ...args], process.cwd()), null);
});
