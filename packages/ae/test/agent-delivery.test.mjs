import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DELIVER_AGENT_TOOLS, DELIVER_PROFILE, buildSystemPrompt, dispatchToolBatch, dispatchToolCall, runAgentLoop } from '../lib/agent-loop.mjs';
import { approveProject, trustStatus } from '../lib/trust.mjs';
import { deliveryCompletion, afterDeliveryTool, beforeDeliveryTool } from '../lib/agent-delivery.mjs';
import { initGit, writeVersionedPlan } from './helpers/cli-fixtures.mjs';
import { cliHarnessHome } from './helpers/cli.mjs';

process.env.HARNESS_HOME = cliHarnessHome();
const bin = path.resolve(import.meta.dirname, '../bin/ae.mjs');
const persona = { name: 'engineer', text: fs.readFileSync(path.resolve(import.meta.dirname, '../corpus/agents/engineer.agent.md'), 'utf8') };
const say = text => ({ text, toolCalls: [] });
const call = (name, input) => ({ text: '', toolCalls: [{ id: 'call', name, input }] });

test('lifecycle tools reject canonical home overrides before dispatch', () => {
  for (const selector of [['--ae-home', '/other/control'], ['--ae-home=/other/control'], ['--harness-home', '/other/control']]) {
    const result = beforeDeliveryTool({ name: 'harness', input: { argv: ['status', ...selector] } }, { workspace: process.cwd() });
    assert.equal(result.pass, false);
    assert.match(result.reason, /bound to this run workspace and homes/);
  }
  assert.equal(beforeDeliveryTool({ name: 'harness', input: { argv: ['status'] } }, { workspace: process.cwd() }).pass, true);
});

test('an explicit ordinary experiment replaces a previous domain completion selection', () => {
  for (const verb of ['begin', 'evaluate', 'resolve', 'status']) {
    const deliveryState = { domainPlan: { name: 'catalogue', path: 'parent.hplan' } };
    const checked = afterDeliveryTool({ name: 'harness', input: { argv: ['experiment', verb, '--plan', 'weights.hplan'] } }, { status: 'ok', exitCode: 0 }, { deliveryState });
    assert.equal(checked.pass, true);
    assert.equal(deliveryState.domainPlan, null);
  }
  const parent = { name: 'catalogue', path: 'parent.hplan' }, deliveryState = { domainPlan: parent };
  afterDeliveryTool({ name: 'harness', input: { argv: ['experiment', 'status'] } }, { status: 'ok', exitCode: 0 }, { deliveryState });
  assert.equal(deliveryState.domainPlan, parent, 'setup metadata does not select another work identity');
});

function fixture(t, { gated = false, reviewRequired = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-delivery-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, 'ws'), home = path.join(root, 'copilot');
  fs.mkdirSync(ws); fs.mkdirSync(home);
  const plan = writeVersionedPlan(ws);
  if (reviewRequired) fs.writeFileSync(path.join(ws, plan), fs.readFileSync(path.join(ws, plan), 'utf8').replace('required: []', 'required: [code-review]'));
  initGit(ws);
  assert.equal(spawnSync('git', ['checkout', '-b', 'feature/delivery'], { cwd: ws }).status, 0);
  approveProject({ workspace: ws, copilotHome: home });
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args, '--workspace', ws, '--copilot-home', home, '--harness-home', process.env.HARNESS_HOME, '--json', '--no-events'], { cwd: ws, encoding: 'utf8' });
  if (gated) {
    assert.equal(cli('orient', '--read', '--query', 'Change the example.', '--file', 'src/example.js').status, 0);
    assert.equal(cli('gate', '--phase', 'implement', '--plan', plan).status, 0);
  }
  const requests = [];
  const run = (script, maxTurns = script.length) => {
    let cursor = 0;
    return runAgentLoop({ task: 'Change the product and prove it.', workspace: ws, copilotHome: home, persona, profile: DELIVER_PROFILE, maxTurns, maxSeconds: 60,
      startProviderFn: () => ({ async complete(request) {
        requests.push(request);
        const step = script[cursor++];
        return { ...(typeof step === 'function' ? await step(request) : step || say('done')), blocks: [], usage: {} };
      }, close() {} }),
    });
  };
  return { ws, home, plan, cli, run, requests };
}

function worklistFixture(t, format) {
  const f = fixture(t);
  const harnessHome = path.join(path.dirname(f.ws), 'isolated-harness');
  approveProject({ workspace: f.ws, copilotHome: f.home, home: harnessHome });
  const playbook = path.join(f.home, 'skills/references/playbooks/feature.md');
  fs.mkdirSync(path.dirname(playbook), { recursive: true });
  fs.writeFileSync(playbook, '# Feature\n\n1. Inspect the accepted behavior.\n2. Prove the accepted change.\n');
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [bin, ...args, '--workspace', f.ws, '--copilot-home', f.home, '--harness-home', harnessHome, '--json', '--no-events'], { cwd: f.ws, encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const decisionFile = path.join(path.dirname(f.ws), 'worklist-decision.json');
  fs.writeFileSync(decisionFile, JSON.stringify({ version: 1, format, slug: `worklist-${format}`, status: 'planned', goal: 'Prove the accepted change.', acceptance: ['The behavior is verified.'], constraints: ['Keep the existing interface.'], scope: ['src/example.js'], check: 'unit-tests', playbook: 'feature' }));
  const created = cli('plan-new', '--file', decisionFile);
  assert.ok(created.path.startsWith(`${harnessHome}${path.sep}`), created.path);
  fs.writeFileSync(decisionFile, JSON.stringify({ version: 1, id: 'worklist-start', action: 'start', expect: created.revision }));
  cli('plan-update', '--plan', created.path, '--file', decisionFile);
  const planBytes = fs.readFileSync(created.path, 'utf8');
  return { ...f, harnessHome, worklistPlan: created.path, planBytes, worklistCli: cli, decisionFile };
}

test('the native todo card exposes plan-scoped synchronization', () => {
  const schema = DELIVER_AGENT_TOOLS.find(tool => tool.name === 'todo').schema;
  assert.equal(schema.properties.plan.type, 'string');
  assert.ok(schema.properties.verb.enum.includes('sync'));
});

for (const format of ['full', 'short']) test(`native todo sync, completion and replay use the isolated ${format} plan`, async t => {
  const f = worklistFixture(t, format);
  const options = { workspace: f.ws, copilotHome: f.home, ctx: { harnessHome: f.harnessHome }, profile: DELIVER_PROFILE };
  const run = async input => {
    const outcome = await dispatchToolCall(call('todo', { plan: f.worklistPlan, ...input }).toolCalls[0], options);
    assert.equal(outcome.dispatched, true, outcome.reason);
    assert.equal(outcome.result.status, 'ok', JSON.stringify(outcome.result));
    return outcome.result;
  };
  const synced = await run({ verb: 'sync' });
  assert.deepEqual(synced.items.map(item => item.text), ['Inspect the accepted behavior.', 'Prove the accepted change.']);
  await run({ verb: 'complete', id: synced.items[0].id });
  assert.equal((await run({ verb: 'list' })).performedCount, 1);
  const replayed = await run({ verb: 'sync' });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.performedCount, 1);
  assert.equal(replayed.pendingCount, 1);
  assert.equal(fs.readFileSync(f.worklistPlan, 'utf8'), f.planBytes, 'procedure completion cannot mark plan acceptance or tasks');
  assert.equal(fs.existsSync(path.join(f.ws, '.harness/todo.json')), false);
});

test('the lifecycle tool supports the exact scoped todo controls', async t => {
  const f = worklistFixture(t, 'full');
  const options = { workspace: f.ws, copilotHome: f.home, harnessHome: f.harnessHome, profile: DELIVER_PROFILE, remainingSeconds: 20 };
  const run = async argv => {
    const outcome = await dispatchToolCall(call('harness', { argv }).toolCalls[0], options);
    assert.equal(outcome.dispatched, true, outcome.reason);
    assert.equal(outcome.result.status, 'ok', JSON.stringify(outcome.result));
    return JSON.parse(outcome.result.output.filter(row => row.stream === 'stdout' && row.line).map(row => row.line).join('\n'));
  };
  const synced = await run(['todo', 'sync', '--plan', f.worklistPlan]);
  await run(['todo', 'complete', '--plan', f.worklistPlan, '--id', synced.items[0].id]);
  assert.equal((await run(['todo', 'list', '--plan', f.worklistPlan])).performedCount, 1);
  assert.equal((await run(['todo', 'sync', '--plan', f.worklistPlan])).replayed, true);
  assert.equal(fs.readFileSync(f.worklistPlan, 'utf8'), f.planBytes);
});

test('a native tool batch serializes scoped mutations before dependent reads', async t => {
  const f = worklistFixture(t, 'short');
  const options = { workspace: f.ws, copilotHome: f.home, harnessHome: f.harnessHome, profile: DELIVER_PROFILE };
  const todo = input => call('todo', { plan: f.worklistPlan, ...input }).toolCalls[0];
  const first = await dispatchToolBatch([todo({ verb: 'sync' }), todo({ verb: 'list' })], options);
  assert.equal(first[0].result.status, 'ok');
  assert.equal(first[1].result.pendingCount, 2);
  const next = await dispatchToolBatch([todo({ verb: 'complete', id: first[0].result.items[0].id }), todo({ verb: 'sync' }), todo({ verb: 'list' })], options);
  assert.equal(next[0].result.item.status, 'done');
  assert.equal(next[1].result.replayed, true);
  assert.equal(next[2].result.performedCount, 1);
  assert.equal(fs.readFileSync(f.worklistPlan, 'utf8'), f.planBytes);
});

test('Deliver completion reads a reviewed managed plan from its explicit home', async t => {
  const f = worklistFixture(t, 'full');
  const decide = (id, action, extra = {}) => {
    fs.writeFileSync(f.decisionFile, JSON.stringify({ version: 1, id, action, expect: createHash('sha256').update(fs.readFileSync(f.worklistPlan)).digest('hex'), ...extra }));
    f.worklistCli('plan-update', '--plan', f.worklistPlan, '--file', f.decisionFile);
  };
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 2;\n');
  decide('worklist-progress', 'progress', { progress: { tasks: ['P1T1'], criteria: ['AC1'] } });
  const packet = f.worklistCli('review', 'prepare', '--plan', f.worklistPlan, '--base', 'HEAD');
  fs.writeFileSync(f.decisionFile, JSON.stringify({ packet: packet.id, results: packet.required.map(reviewer => ({ reviewer, status: 'completed', findings: [], residual_risks: ['Scripted fixture has no model quality claim.'], testing_gaps: [] })) }));
  f.worklistCli('review', 'assemble', '--plan', f.worklistPlan, '--packet', packet.id, '--file', f.decisionFile);
  f.worklistCli('verify', '--plan', f.worklistPlan, '--base', 'HEAD');
  fs.writeFileSync(f.decisionFile, JSON.stringify({ operation: 'worklist-no-learning', decision: 'no-learning', rationale: 'Disposable integration fixture has no durable lesson.' }));
  f.worklistCli('compound', '--plan', f.worklistPlan, '--learning-decision', f.decisionFile);
  decide('worklist-complete', 'complete');
  const realpath = fs.realpathSync, native = realpath.native;
  t.mock.method(fs, 'realpathSync', (file, ...args) => path.resolve(String(file)) === path.resolve(f.worklistPlan)
    ? path.join(path.parse(f.worklistPlan).root, 'LEGACY~1', path.basename(f.worklistPlan))
    : realpath(file, ...args));
  fs.realpathSync.native = native;
  const result = deliveryCompletion({ workspace: f.ws, copilotHome: f.home, harnessHome: f.harnessHome });
  assert.equal(result.pass, true, result.message);
  t.mock.restoreAll();
  const run = await runAgentLoop({ task: 'Report the completed change.', workspace: f.ws, copilotHome: f.home, ctx: { harnessHome: f.harnessHome }, persona, profile: DELIVER_PROFILE, maxTurns: 1, maxSeconds: 30,
    startProviderFn: () => ({ async complete() { return { ...say('Complete.'), blocks: [], usage: {} }; }, close() {} }),
  });
  assert.equal(run.status, 'ok', run.stopDetail);
  assert.equal(run.stopReason, 'done');
});

test('unsupported lifecycle todo commands and shell wrappers are refused without effects', async t => {
  const f = fixture(t);
  const options = { workspace: f.ws, copilotHome: f.home, profile: DELIVER_PROFILE };
  for (const argv of [
    ['todo', 'add', '--text', 'unexpected'], ['todo', 'clear'], ['todo', 'invented'], ['todo', 'sync'],
    ['todo', 'complete', '--plan', f.plan], ['todo', 'list', '--id', 't1'],
    ['todo', 'list', '--unrecognized'], ['todo', 'list', '--plan', f.plan, '--plan', f.plan],
    ['todo', 'sync', '--plan', f.plan, '--workspace', '/tmp'],
    ['todo', 'list', '&&', 'touch', 'unexpected'], ['sh', '-c', 'ae todo list'],
  ]) {
    const outcome = await dispatchToolCall(call('harness', { argv }).toolCalls[0], options);
    assert.equal(outcome.dispatched, false, JSON.stringify(argv));
    assert.equal(outcome.fatal, false);
  }
  assert.equal(fs.existsSync(path.join(f.ws, '.harness/todo.json')), false);
  assert.equal(fs.existsSync(path.join(f.ws, 'unexpected')), false);
});

test('native todo keeps legacy commands and rejects malformed scope fields', async t => {
  const f = fixture(t);
  const options = { workspace: f.ws, copilotHome: f.home, profile: DELIVER_PROFILE };
  for (const input of [{ verb: 'invented' }, { verb: ['list'] }, { verb: 'list', plan: [] }, { verb: 'list', plan: '' }, { verb: 'list', plan: '--workspace' }]) {
    const outcome = await dispatchToolCall(call('todo', input).toolCalls[0], options);
    assert.equal(outcome.dispatched, false, JSON.stringify(input));
    assert.equal(outcome.fatal, false);
  }
  const text = 'legacy task; touch unexpected';
  const added = await dispatchToolCall(call('todo', { verb: 'add', text }).toolCalls[0], options);
  assert.equal(added.result.status, 'ok');
  assert.equal(added.result.item.text, text);
  assert.equal(fs.existsSync(path.join(f.ws, 'unexpected')), false);
  const done = await dispatchToolCall(call('todo', { verb: 'complete', id: added.result.item.id }).toolCalls[0], options);
  assert.equal(done.result.item.status, 'done');
  assert.equal((await dispatchToolCall(call('todo', { verb: 'list' }).toolCalls[0], options)).result.doneCount, 1);
  assert.equal((await dispatchToolCall(call('todo', { verb: 'clear' }).toolCalls[0], options)).result.cleared, 1);
});

test('Deliver retains the engineer completion rules and exposes lifecycle commands', () => {
  const system = buildSystemPrompt({ persona, profile: DELIVER_PROFILE });
  assert.match(system, /For changed work, run/);
  assert.match(system, /current AE proof/);
  assert.match(system, /require passed `ae verify`/);
  assert.match(system, /--query/);
  assert.ok(DELIVER_AGENT_TOOLS.some(tool => tool.name === 'harness'));
});

test('each Deliver run establishes a fresh session before reads and preserves lifecycle state', async t => {
  const f = fixture(t, { gated: true });
  const sessionPath = path.join(f.ws, '.harness/session.json');
  const previous = JSON.parse(fs.readFileSync(sessionPath));
  previous.lastEditAt = new Date().toISOString();
  previous.lastEditPlan = f.plan;
  previous.activatedSkills = { prior: { sessionId: previous.sessionId, activatedAt: previous.lastEditAt } };
  fs.writeFileSync(sessionPath, JSON.stringify(previous));
  const skillPath = path.join(f.home, 'skills/session-fixture/SKILL.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, '# Session fixture\nRead all of this skill.\n');

  let firstSession;
  const first = await f.run([() => {
    firstSession = JSON.parse(fs.readFileSync(sessionPath));
    assert.notEqual(firstSession.sessionId, previous.sessionId);
    assert.match(firstSession.sessionId, /^[a-f0-9-]{36}$/);
    assert.ok(Number.isFinite(Date.parse(firstSession.sessionStartedAt)));
    for (const field of ['activePlan', 'gatedPlan', 'gatedPlanDigest', 'gateStatus', 'lastGateAt', 'lastEditAt', 'lastEditPlan']) {
      assert.deepEqual(firstSession[field], previous[field], field);
    }
    assert.deepEqual(firstSession.activatedSkills.prior, previous.activatedSkills.prior);
    return call('read', { path: 'skills/session-fixture/SKILL.md' });
  }]);
  assert.equal(first.turns.length, 1, first.stopDetail);
  assert.equal(first.turns[0].tools[0].status, 'ok');
  const activated = JSON.parse(fs.readFileSync(sessionPath));
  assert.equal(activated.activatedSkills['session-fixture'].sessionId, firstSession.sessionId);
  assert.ok(Date.parse(activated.activatedSkills['session-fixture'].activatedAt) >= Date.parse(firstSession.sessionStartedAt));

  await f.run([say('Stopping before another skill read.')]);
  const secondSession = JSON.parse(fs.readFileSync(sessionPath));
  assert.notEqual(secondSession.sessionId, firstSession.sessionId);
  assert.deepEqual(secondSession.activatedSkills['session-fixture'], activated.activatedSkills['session-fixture']);
  assert.notEqual(secondSession.activatedSkills['session-fixture'].sessionId, secondSession.sessionId);
});

test('failed and partial Deliver reads do not activate a skill', async t => {
  const f = fixture(t);
  const skillPath = path.join(f.home, 'skills/partial-fixture/SKILL.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, '# Partial fixture\nDo not activate after reading only one line.\n');
  const largeSkillPath = path.join(f.home, 'skills/large-fixture/SKILL.md');
  fs.mkdirSync(path.dirname(largeSkillPath), { recursive: true });
  fs.writeFileSync(largeSkillPath, `# Large fixture\n${'x'.repeat(8500)}\n`);
  const result = await f.run([
    call('read', { path: 'skills/missing-fixture/SKILL.md' }),
    call('read', { path: 'skills/partial-fixture/SKILL.md', lines: 1 }),
    call('read', { path: 'skills/large-fixture/SKILL.md' }),
  ]);
  assert.equal(result.turns[0].tools[0].dispatched, false);
  assert.equal(result.turns[1].tools[0].status, 'ok');
  assert.equal(result.turns[2].tools[0].status, 'ok');
  const session = JSON.parse(fs.readFileSync(path.join(f.ws, '.harness/session.json')));
  assert.equal(session.activatedSkills?.['missing-fixture'], undefined);
  assert.equal(session.activatedSkills?.['partial-fixture'], undefined);
  assert.equal(session.activatedSkills?.['large-fixture'], undefined);
});

test('Deliver does not start the provider when a current workspace session cannot be established', async t => {
  if (process.platform === 'win32') return t.skip('symlink fixture requires privilege on Windows');
  const f = fixture(t);
  fs.mkdirSync(f.home, { recursive: true });
  fs.symlinkSync(f.home, path.join(f.ws, '.harness'));
  await assert.rejects(f.run([say('No run may start.')]), /could not establish.*session/i);
  assert.equal(f.requests.length, 0);
  assert.equal(fs.existsSync(path.join(f.home, 'session.json')), false);
});

for (const [name, input] of [
  ['edit', { path: '.github/harness/checks.yaml', old: 'version: 1', new: 'version: 2' }],
  ['write', { path: 'src/new.js', content: 'export const value = 2;\n' }],
  ['apply', { changes: [{ path: 'src/example.js', old: 'value = 1', new: 'value = 2' }] }],
  ['bash', { script: 'echo changed > src/example.js' }],
]) test(`Deliver refuses ${name} before an explicit implement gate`, async t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.ws, '.github/harness/checks.yaml'), 'utf8');
  const result = await f.run([call(name, input), say('done')]);
  assert.equal(result.turns[0].tools[0].dispatched, false);
  assert.match(result.turns[0].tools[0].reason, /implement.gate/i);
  assert.equal(fs.readFileSync(path.join(f.ws, '.github/harness/checks.yaml'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.ws, 'src/new.js')), false);
  assert.match(fs.readFileSync(path.join(f.ws, 'src/example.js'), 'utf8'), /value = 1/);
  assert.equal(trustStatus({ workspace: f.ws, copilotHome: f.home }).state, 'trusted');
  assert.notEqual(result.status, 'ok');
});

test('Deliver refuses files outside the orient read list, including atomic apply', async t => {
  const f = fixture(t, { gated: true });
  const sessionFile = path.join(f.ws, '.harness/session.json');
  const session = JSON.parse(fs.readFileSync(sessionFile));
  fs.writeFileSync(sessionFile, JSON.stringify({ ...session, files: ['src/other.js'] }));
  const result = await f.run([call('apply', { changes: [{ path: 'src/example.js', old: 'value = 1', new: 'value = 2' }] }), say('done')]);
  assert.equal(result.turns[0].tools[0].dispatched, false);
  assert.match(result.turns[0].tools[0].reason, /orient.*file list/);
});

test('a passed implement gate does not replace explicit orientation with touched files', async t => {
  const f = fixture(t, { gated: true });
  const file = path.join(f.ws, '.harness/session.json');
  const session = JSON.parse(fs.readFileSync(file));
  delete session.lastOrientReadAt;
  fs.writeFileSync(file, JSON.stringify({ ...session, files: [] }));
  const result = await f.run([call('edit', { path: 'src/example.js', old: 'value = 1', new: 'value = 2' }), say('done')]);
  assert.equal(result.turns[0].tools[0].dispatched, false);
  assert.match(result.turns[0].tools[0].reason, /missing-orient-read/);
});

test('Deliver cannot approve trust through exec, bash or the lifecycle tool', async t => {
  const f = fixture(t);
  const script = [
    call('exec', { argv: [process.execPath, bin, 'trust', 'approve'] }),
    call('bash', { script: 'ae trust approve' }),
    call('harness', { argv: ['trust', 'approve'] }), say('done'),
  ];
  const result = await f.run(script);
  for (const turn of result.turns.slice(0, 3)) {
    assert.equal(turn.tools[0].dispatched, false);
    assert.match(turn.tools[0].reason, /person|human/i);
  }
});

test('a no-tool final without a plan cannot count as Deliver success', async t => {
  const f = fixture(t);
  const result = await f.run([say('done')]);
  assert.equal(result.stopReason, 'delivery-incomplete');
  assert.equal(result.status, 'failed');
});

test('malformed execution arguments return a refusal without crashing Deliver', async t => {
  const f = fixture(t);
  const result = await f.run([call('exec', { argv: 'not-an-array' }), say('blocked')]);
  assert.equal(result.turns[0].tools[0].dispatched, false);
  assert.match(result.turns[0].tools[0].reason, /argv/);
  assert.equal(result.status, 'failed');
});

test('failed verify and uncollected review cannot count as Deliver success', async t => {
  const f = fixture(t, { gated: true });
  const planFile = path.join(f.ws, f.plan);
  fs.writeFileSync(planFile, fs.readFileSync(planFile, 'utf8').replace('required: []', 'required: [code-review]'));
  const result = await f.run([call('harness', { argv: ['verify', '--plan', f.plan, '--base', 'HEAD'] }), say('Verification failed, stopping.')]);
  assert.equal(result.turns[0].tools[0].status, 'failed');
  assert.equal(result.stopReason, 'delivery-incomplete');
  assert.equal(result.status, 'failed');
});

test('passed verify still requires compounding and bound completion; repair can continue', async t => {
  const f = fixture(t, { gated: true, reviewRequired: true });
  const result = await f.run([
    call('edit', { path: 'src/example.js', old: 'value = 1', new: 'value = 2' }),
    call('harness', { argv: ['review', 'prepare', '--plan', f.plan, '--base', 'HEAD'] }),
    () => {
      const packets = path.join(f.ws, '.harness/reviews/packets');
      const packet = JSON.parse(fs.readFileSync(path.join(packets, fs.readdirSync(packets)[0])));
      return call('harness', { argv: ['review', 'assemble', '--plan', f.plan, '--packet', packet.id], decision: { packet: packet.id, results: packet.required.map(reviewer => ({ reviewer, status: 'completed', findings: [], residual_risks: ['Scripted fixture judgment; no model quality claim.'], testing_gaps: [] })) } });
    },
    call('harness', { argv: ['verify', '--plan', f.plan, '--base', 'HEAD'] }),
    say('done'),
    call('harness', { argv: ['compound', '--plan', f.plan], decision: { operation: 'no-learning', decision: 'no-learning', rationale: 'Synthetic fixture has no durable lesson.' } }),
    () => call('harness', { argv: ['plan-update', '--plan', f.plan], decision: { version: 1, id: 'complete', action: 'complete', expect: createHash('sha256').update(fs.readFileSync(path.join(f.ws, f.plan))).digest('hex') } }),
    say('complete'),
  ]);
  assert.equal(result.status, 'ok', result.detail);
  assert.equal(result.stopReason, 'done');
  assert.ok(f.requests.some(request => request.messages.some(message => /Completion blocked/.test(message.text || ''))));
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.ws, '.harness/session.json'))).lastEditAt);
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), 'export const value = 3;\n');
  const stale = await f.run([say('done')]);
  assert.equal(stale.stopReason, 'delivery-incomplete');
});

test('a completed legacy plan cannot omit code review for changed Deliver work', async t => {
  const f = fixture(t, { gated: true });
  const result = await f.run([
    call('edit', { path: 'src/example.js', old: 'value = 1', new: 'value = 2' }),
    call('harness', { argv: ['verify', '--plan', f.plan, '--base', 'HEAD'] }),
    call('harness', { argv: ['compound', '--plan', f.plan], decision: { operation: 'no-learning', decision: 'no-learning', rationale: 'Synthetic fixture has no durable lesson.' } }),
    () => call('harness', { argv: ['plan-update', '--plan', f.plan], decision: { version: 1, id: 'complete', action: 'complete', expect: createHash('sha256').update(fs.readFileSync(path.join(f.ws, f.plan))).digest('hex') } }),
    say('complete'),
  ]);
  assert.equal(result.stopReason, 'delivery-incomplete');
  assert.match(result.stopDetail, /code.review/i);
});

test('an authorized pinned-policy edit stays stale until a person approves it', async t => {
  const f = fixture(t);
  const policyFile = '.github/harness/checks.yaml';
  const planFile = path.join(f.ws, f.plan);
  fs.writeFileSync(planFile, fs.readFileSync(planFile, 'utf8').replace('`src/example.js`', `\u0060${policyFile}\u0060`));
  assert.equal(f.cli('orient', '--read', '--query', 'Update the check configuration.', '--file', policyFile).status, 0);
  assert.equal(f.cli('gate', '--phase', 'implement', '--plan', f.plan).status, 0);
  const result = await f.run([
    call('edit', { path: policyFile, old: 'version: 1', new: 'version: 2' }),
    call('harness', { argv: ['verify', '--plan', f.plan, '--base', 'HEAD'] }), say('Approval needed.'),
  ]);
  assert.equal(result.turns[0].tools[0].status, 'ok');
  assert.equal(result.turns[1].tools[0].status, 'failed');
  assert.equal(trustStatus({ workspace: f.ws, copilotHome: f.home }).state, 'stale');
  assert.equal(result.status, 'failed');
});

test('orient without --file exposes constraints, trust and the planned import neighborhood', t => {
  const f = fixture(t, { gated: true });
  fs.writeFileSync(path.join(f.ws, f.plan), fs.readFileSync(path.join(f.ws, f.plan), 'utf8') + '\n## Constraints\n- Do not wait for a full rebuild\n');
  fs.writeFileSync(path.join(f.ws, 'src/example.js'), "import { publish } from './publish.js';\nexport const value = publish();\n");
  fs.writeFileSync(path.join(f.ws, 'src/publish.js'), 'export function publish() { return 1; }\n');
  assert.equal(spawnSync('git', ['add', 'src'], { cwd: f.ws }).status, 0);
  for (const read of [false, true]) {
    const result = f.cli('orient', ...(read ? ['--read'] : []), '--query', 'keep products searchable', '--plan', f.plan);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.ok(output.planGoal.constraints.includes('Do not wait for a full rebuild'));
    assert.equal(output.trust.state, 'trusted');
    assert.ok(output.neighborhood.files.some(file => file.rel === 'src/publish.js'));
  }
});
