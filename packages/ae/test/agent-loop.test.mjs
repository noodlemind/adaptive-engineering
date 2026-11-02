import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { agentJournalArgv, agentResultOf, taskFromArgv } from '../lib/agent-cmd.mjs';
import { hasCommand } from '../lib/registry.mjs';
import {
  AGENT_TOOLS,
  AGENT_VALUE_FLAGS,
  BENCHMARK_PROFILE,
  MAX_EXPLORE_STREAK,
  MAX_SEARCH_PER_RUN,
  STOP_REASONS,
  buildSystemPrompt,
  dispatchToolCall,
  exploreGate,
  renderToolResult,
  resolvePersona,
  resolveToolTimeout,
} from '../lib/agent-loop.mjs';
import { GLOBAL_FLAGS, getCommand } from '../lib/registry.mjs';
import { parseFlags } from '../lib/flags.mjs';
import { EXIT } from '../lib/style.mjs';
import { setRunContext, clearRunContext } from '../lib/run-context.mjs';
import { createEventRegistry } from '../lib/event-registry.mjs';
import { writeEvent as writeHarnessEvent } from '../lib/events.mjs';
import { initGit } from './helpers/index.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');
const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

/** A workspace and a Copilot home, with the persona hydrated the way `install`
 * would leave it. */
function scaffold(prefix, { persona = 'engineer', personaText = '# Engineer\n\nBe careful.\n' } = {}) {
  const ws = tempDir(`${prefix}-ws-`);
  const home = tempDir(`${prefix}-home-`);
  if (persona) {
    fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, 'agents', `${persona}.agent.md`), personaText);
  }
  return { ws, home };
}

function scriptedProvider(script) {
  const requests = [];
  let i = 0;
  const start = () => ({
    provider: 'scripted',
    model: 'scripted-1',
    alive: true,
    logs: [],
    async complete(request) {
      requests.push(request);
      const step = script[i];
      i += 1;
      const completion = typeof step === 'function' ? await step(request, requests) : step;
      return completion || { text: 'finished', toolCalls: [], blocks: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
    close() {},
  });
  return { start, requests, get consumed() { return i; } };
}

const say = (text) => ({ text, toolCalls: [], blocks: [{ type: 'text', text }], usage: { inputTokens: 5, outputTokens: 5 } });
const callTool = (id, name, input) => ({
  text: '',
  toolCalls: [{ id, name, input }],
  blocks: [{ type: 'tool_use', id, name, input }],
  usage: { inputTokens: 5, outputTokens: 5 },
});

/** Historical efficiency-fixture profile (benchmark). First-class autonomous needs --verify-cmd. */
const argvFor = (ws, home, task, extra = []) => [
  ...task.split(' '),
  '--workspace', ws,
  '--copilot-home', home,
  '--no-events',
  '--profile', 'benchmark',
  ...extra,
];

// --- P5AC9: the loop completes a task -------------------------------------

test('P5AC9: the loop orients, acts through a tool, and stops when the model asks for nothing more', async () => {
  const { ws, home } = scaffold('agent-e2e');
  const provider = scriptedProvider([
    callTool('t1', 'bash', { script: 'echo hello > done.txt' }),
    say('wrote the file'),
  ]);
  const result = await agentResultOf(argvFor(ws, home, 'write a file'), {}, { startProviderFn: provider.start });

  assert.equal(result.stopReason, 'done');
  assert.equal(result.status, 'ok');
  assert.equal(result.exitCode, EXIT.ok);
  assert.equal(result.turnCount, 2, 'one acting turn and one finishing turn');
  assert.equal(fs.readFileSync(path.join(ws, 'done.txt'), 'utf8').trim(), 'hello', 'the tool actually ran');
  assert.equal(result.text, 'wrote the file');
  assert.equal(result.usage.outputTokens, 10, 'usage accumulates across turns');
});

test('context accounting records actual runtime requests and repeated reads without storing payload content', async (t) => {
  const { ws, home } = scaffold('agent-context-accounting');
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, 'target.txt'), 'private payload marker');
  const provider = scriptedProvider([callTool('r1', 'read', { path: 'target.txt' }), callTool('r2', 'read', { path: 'target.txt' }), say('finished')]);
  const result = await agentResultOf(argvFor(ws, home, 'inspect target'), {}, { startProviderFn: provider.start });
  assert.equal(result.contextAccounting.length, 3);
  assert.equal(result.contextAccounting[2].reads, 2);
  assert.equal(result.contextAccounting[2].repeatedReads, 1);
  assert.equal(result.contextAccounting[2].modelUsage.inputTokens, 5);
  assert.equal(result.contextAccounting[2].modelInputCoverage, 'runtime-request-only');
  assert.equal(JSON.stringify(result.contextAccounting).includes('private payload marker'), false);
});

test('structured retention is opt-in and sends a current handoff to the provider', async (t) => {
  const { ws, home } = scaffold('agent-structured-retention');
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const provider = scriptedProvider([say('finished')]);
  const result = await agentResultOf(argvFor(ws, home, 'continue accepted work', ['--retention-policy', 'structured']), {}, { startProviderFn: provider.start });
  assert.equal(result.task, 'continue accepted work');
  assert.equal(result.retentionPolicy, 'structured');
  assert.ok(provider.requests[0].messages.some(message => message.contextCategory === 'handoff' && message.text.includes('continue accepted work')));
});

test('structured retention compacts old searches while preserving references and pagination', async (t) => {
  const { ws, home } = scaffold('agent-search-retention');
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, 'a.mjs'), 'export const retentionMarker = 1;\n');
  fs.writeFileSync(path.join(ws, 'b.mjs'), 'export const retentionMarker = 2;\n');
  initGit(ws);
  const provider = scriptedProvider([
    callTool('old-search', 'search', { query: 'retentionMarker', contextVersion: 2, limit: 1 }),
    ...Array.from({ length: 7 }, (_, i) => callTool(`read-${i}`, 'read', { path: 'a.mjs' })),
    say('finished'),
  ]);
  const result = await agentResultOf(argvFor(ws, home, 'inspect sources', ['--retention-policy', 'structured', '--max-turns', '12']), {}, { startProviderFn: provider.start });
  assert.equal(result.stopReason, 'done');
  const findSearch = request => request.messages.flatMap(message => message.toolResults || []).find(row => row.id === 'old-search');
  const original = findSearch(provider.requests[1]);
  const compacted = findSearch(provider.requests.at(-1));
  assert.match(compacted.output, /Earlier search omitted/);
  assert.doesNotMatch(compacted.output, /export const retentionMarker/);
  assert.equal(compacted.search.query, 'retentionMarker');
  assert.equal(compacted.search.nextCursor, original.search.nextCursor);
  assert.ok(compacted.search.nextCursor);
  assert.equal(compacted.search.results[0].reference, original.search.results[0].reference);
  assert.match(compacted.output, /a\.mjs@sha256:|b\.mjs@sha256:/);
});

test('selective context refreshes source data before each model request', async (t) => {
  const { ws, home } = scaffold('agent-selective-context');
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, 'src'));
  fs.writeFileSync(path.join(ws, 'src/target.mjs'), 'export function item() { return 1; }\n');
  initGit(ws);
  const provider = scriptedProvider([callTool('edit', 'edit', { path: 'src/target.mjs', old: 'return 1;', new: 'return 2;' }), say('finished')]);
  const result = await agentResultOf(argvFor(ws, home, 'update target', ['--context-policy', 'selective', '--file', 'src/target.mjs']), {}, { startProviderFn: provider.start });
  assert.equal(result.task, 'update target');
  assert.equal(result.contextPolicy, 'selective');
  assert.equal(result.turns[0].contextEvidence[0].location, 'src/target.mjs');
  assert.match(provider.requests[0].messages.find(message => message.contextCategory === 'evidence').text, /return 1/);
  const evidence = provider.requests[1].messages.filter(message => message.contextCategory === 'evidence');
  assert.equal(evidence.length, 1);
  assert.match(evidence[0].text, /return 2/);
  assert.doesNotMatch(evidence[0].text, /return 1/);
});

test('request receipts distinguish a reported model identity from the requested model', async (t) => {
  const { ws, home } = scaffold('agent-model-receipt');
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const provider = scriptedProvider([{ ...say('finished'), model: 'reported-model-revision' }]);
  const result = await agentResultOf(argvFor(ws, home, 'answer'), {}, { startProviderFn: provider.start });
  assert.equal(result.model, 'scripted-1');
  assert.equal(result.contextAccounting[0].model, 'reported-model-revision');
});

test('a tool timeout above exec\'s maximum clamps to the maximum instead of killing the run', async () => {
  const { ws } = (() => {
    const dir = tempDir('agent-timeout-clamp-');
    return { ws: dir };
  })();
  const outcome = await dispatchToolCall(
    { id: '1', name: 'bash', input: { script: 'echo ok', timeout: 7200 } },
    { workspace: ws, copilotHome: null },
  );
  assert.equal(outcome.dispatched, true, 'asking for more than the maximum means the maximum, not a dead run');
  assert.equal(outcome.timeoutSeconds, 3600);

  // The operator's ceiling still applies, and still only ever lowers.
  assert.equal(resolveToolTimeout({ requested: 7200, ceiling: 300 }), 300);
  assert.equal(resolveToolTimeout({ requested: 7200 }), 3600);
  assert.equal(resolveToolTimeout({ requested: 30 }), 30);
});

test('a length-truncated message has its tool calls refused, not dispatched', async () => {
  const { ws, home } = scaffold('agent-truncated');
  const provider = scriptedProvider([
    {
      text: '',
      toolCalls: [
        { id: 't1', name: 'write', input: { path: 'half.txt', content: 'the beginning of somethi' } },
        { id: 't2', name: 'bash', input: { script: 'echo hi' } },
      ],
      blocks: [],
      stopReason: 'length',
      usage: { inputTokens: 5, outputTokens: 5 },
    },
    (request) => {
      // The refusal reaches the model as per-call errors it can act on.
      const results = request.messages.at(-1)?.toolResults ?? [];
      assert.equal(results.length, 2, 'every call in the truncated message is answered');
      assert.ok(results.every((r) => r.isError), 'all answered as errors');
      assert.match(results[0].output, /token limit|truncated/i);
      return say('re-issuing nothing, done');
    },
  ]);
  const result = await agentResultOf(argvFor(ws, home, 'do a thing'), {}, { startProviderFn: provider.start });

  assert.equal(result.stopReason, 'done');
  assert.equal(fs.existsSync(path.join(ws, 'half.txt')), false, 'the truncated write must never touch the disk');
  const truncatedTurn = result.turns[0];
  assert.ok(truncatedTurn.tools.every((t) => t.dispatched === false), 'the journal says the calls were refused');
  assert.match(truncatedTurn.tools[0].reason, /truncated/);
});

// Benchmark: text nudges lost to search incentives. Explore is hard-capped.
test('search and read are refused after the explore streak', async () => {
  const { ws, home } = scaffold('agent-explore-gate');
  fs.writeFileSync(path.join(ws, 'a.txt'), 'seed\n');
  const provider = scriptedProvider([
    callTool('r1', 'read', { path: 'a.txt' }),
    callTool('r2', 'read', { path: 'a.txt' }),
    callTool('r3', 'read', { path: 'a.txt' }),
    // 3 explore turns already → next explore tools are refused (tool-level).
    callTool('s1', 'search', { query: 'anything' }),
    callTool('r4', 'read', { path: 'a.txt' }),
    callTool('b1', 'bash', { script: 'echo act' }),
    say('done'),
  ]);
  const result = await agentResultOf(
    argvFor(ws, home, 'poke around', ['--max-turns', '12']),
    {},
    { startProviderFn: provider.start },
  );
  assert.equal(result.stopReason, 'done');
  const searchTurn = result.turns.find((t) => t.tools.some((x) => x.tool === 'search'));
  assert.ok(searchTurn, 'search was attempted');
  assert.equal(searchTurn.tools[0].dispatched, false, 'search after explore streak must be refused');
  assert.match(searchTurn.tools[0].reason, /explore streak|search budget/);
  const fourthRead = result.turns.find((t) => t.tools.some((x) => x.tool === 'read' && x.dispatched === false));
  assert.ok(fourthRead, 'further read after the streak must also be refused');
});

test('a failed bash/exec tool result tells the model to edit next', async () => {
  const { ws, home } = scaffold('agent-act-nudge');
  const provider = scriptedProvider([
    callTool('t1', 'exec', { argv: [process.execPath, '-e', 'process.exit(2)'] }),
    (request) => {
      const last = request.messages.at(-1);
      assert.equal(last.role, 'user');
      assert.match(last.toolResults[0].output, /command failed/i);
      assert.match(last.toolResults[0].output, /edit/i);
      return say('done');
    },
  ]);
  const result = await agentResultOf(argvFor(ws, home, 'fix it'), {}, { startProviderFn: provider.start });
  assert.equal(result.stopReason, 'done');
});

test('a timed-out completion is retried once with a short continue message', async () => {
  const { ws, home } = scaffold('agent-timeout-retry');
  let calls = 0;
  const provider = {
    start: () => ({
      provider: 'scripted',
      model: 'scripted-1',
      alive: true,
      logs: [],
      async complete() {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('plugin request complete timed out after 90000ms'), { code: 'E_TIMEOUT' });
        return { text: 'recovered', toolCalls: [], blocks: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
      close() {},
    }),
  };
  const result = await agentResultOf(argvFor(ws, home, 'keep going'), {}, { startProviderFn: provider.start });
  assert.equal(result.stopReason, 'done');
  assert.equal(calls, 2, 'exactly one retry after timeout');
});

test('approaching the turn budget injects a budget check; steady action is not blocked', async () => {
  const { ws, home } = scaffold('agent-budget-nudge');
  const provider = scriptedProvider([
    callTool('t1', 'bash', { script: 'echo one' }),
    callTool('t2', 'bash', { script: 'echo two' }),
    callTool('t3', 'bash', { script: 'echo three' }),
    callTool('t4', 'bash', { script: 'echo four' }),
    callTool('t5', 'bash', { script: 'echo five' }),
    callTool('t6', 'bash', { script: 'echo six' }),
    callTool('t7', 'bash', { script: 'echo seven' }),
    callTool('t8', 'bash', { script: 'echo eight' }),
    (request) => {
      const texts = request.messages.filter((m) => typeof m.text === 'string').map((m) => m.text);
      assert.ok(
        texts.some((t) => /Budget check: 2 of 10 turns remain/.test(t)),
        'budget pressure remains as a secondary signal',
      );
      return say('done');
    },
  ]);
  const result = await agentResultOf(
    argvFor(ws, home, 'do work', ['--max-turns', '10']),
    {},
    { startProviderFn: provider.start },
  );
  assert.equal(result.stopReason, 'done');
});

test('P5AC9: the tool result is fed back, so a non-zero exit continues the loop instead of ending it', async () => {
  const { ws, home } = scaffold('agent-nonzero');
  const provider = scriptedProvider([
    callTool('t1', 'exec', { argv: [process.execPath, '-e', 'process.exit(3)'] }),
    say('recovered'),
  ]);
  const result = await agentResultOf(argvFor(ws, home, 'try something'), {}, { startProviderFn: provider.start });

  assert.equal(result.stopReason, 'done', 'a failing command is information, not a terminal state');
  assert.equal(result.turns[0].tools[0].exitCode, 3);
  const followUp = provider.requests[1].messages.at(-1);
  assert.equal(followUp.role, 'user');
  assert.match(followUp.toolResults[0].output, /exit: 3/);
  assert.equal(followUp.toolResults[0].isError, true);
});

test('P5AC9: an unknown or malformed tool call is answered, not fatal', async () => {
  const { ws, home } = scaffold('agent-badtool');
  const provider = scriptedProvider([
    callTool('t1', 'telepathy', { wish: 'be done' }),
    callTool('t2', 'bash', { script: '' }),
    say('ok then'),
  ]);
  const result = await agentResultOf(argvFor(ws, home, 'do a thing'), {}, { startProviderFn: provider.start });

  assert.equal(result.stopReason, 'done');
  assert.equal(result.turns[0].tools[0].dispatched, false);
  assert.match(result.turns[0].tools[0].reason, /unknown tool: telepathy/);
  assert.match(result.turns[1].tools[0].reason, /non-empty `script`/);
});

// --- P5AC9: the model reaches nothing but the governed surface -------------

test('P5AC9: a model-issued command gets the same deny-all environment an operator’s does', async () => {
  const { ws, home } = scaffold('agent-env');
  process.env.AGENT_TEST_SECRET = 'must-not-be-visible';
  try {
    const provider = scriptedProvider([
      callTool('t1', 'exec', { argv: [process.execPath, '-e', 'console.log("SECRET=" + process.env.AGENT_TEST_SECRET)'] }),
      say('done'),
    ]);
    const result = await agentResultOf(argvFor(ws, home, 'print the secret'), {}, { startProviderFn: provider.start });
    const output = provider.requests[1].messages.at(-1).toolResults[0].output;
    assert.match(output, /SECRET=undefined/, 'asking through a model must not widen what a child can see');
    assert.equal(result.turns[0].tools[0].status, 'ok');
  } finally {
    delete process.env.AGENT_TEST_SECRET;
  }
});

test('P5AC9: the tool call starts in the workspace (which is NOT confinement — see below)', async () => {
  const { ws, home } = scaffold('agent-cwd');
  const outcome = await dispatchToolCall(
    { id: 't1', name: 'exec', input: { argv: [process.execPath, '-e', 'console.log(process.cwd())'] } },
    { workspace: ws, copilotHome: home },
  );
  assert.equal(outcome.dispatched, true);
  assert.equal(outcome.result.cwd, ws);
  assert.equal(outcome.result.output.map((r) => r.line).join('\n').trim(), ws);
});

test('P5AC9: and the harness does NOT confine a model to the workspace — asserted so the claim cannot drift back', async () => {
    const ws = tempDir('agent-escape-ws-');
  const outside = path.join(ws, '..', `escape-probe-${process.pid}`);
  const outcome = await dispatchToolCall(
    { id: 't1', name: 'bash', input: { script: `cd .. && printf x > ${JSON.stringify(path.basename(outside))}` } },
    { workspace: ws },
  );
  assert.equal(outcome.dispatched, true);
  const escaped = fs.existsSync(outside);
  if (escaped) fs.rmSync(outside, { force: true });
  assert.equal(escaped, true,
    'if this ever fails, real confinement has been added — delete this test and restore the stronger claim in agent-loop.mjs');
});

test('P5AC9: a refusal from the governed surface stops the loop rather than being re-tried forever', async () => {
  const { ws, home } = scaffold('agent-denied');
    fs.mkdirSync(path.join(home, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(home, 'harness', 'config.yaml'), '"exec.bash_enabled": false\n');

  const provider = scriptedProvider([callTool('t1', 'bash', { script: 'echo hi' }), say('unreachable')]);
  const result = await agentResultOf(argvFor(ws, home, 'run a script'), {}, { startProviderFn: provider.start });

  assert.equal(result.stopReason, 'tool-error');
  assert.equal(result.status, 'failed');
  assert.match(result.stopDetail, /bash is disabled/);
  assert.equal(provider.consumed, 1, 'the loop stopped rather than spending the budget on a settled no');
});

// --- P5AC9: the stop conditions -------------------------------------------

test('P5AC9: every stop reason maps to a distinct, named outcome', () => {
  assert.deepEqual(Object.keys(STOP_REASONS).sort(), [
    'cancelled', 'delivery-incomplete', 'done', 'provider-error', 'time-budget', 'tool-error', 'turn-budget',
    'verifier-failed', 'verifier-missing', 'verifier-pass',
  ]);
  assert.equal(STOP_REASONS.done.status, 'ok');
  assert.equal(STOP_REASONS['verifier-pass'].status, 'ok');
  assert.equal(STOP_REASONS['verifier-missing'].status, 'failed');
  assert.equal(STOP_REASONS['time-budget'].status, 'timed-out');
  assert.equal(STOP_REASONS.cancelled.status, 'cancelled');
  assert.notEqual(STOP_REASONS.done.exit, STOP_REASONS['turn-budget'].exit,
    '"finished" and "ran out of turns" must not be one exit code apart from each other');
});

test('P5AC9: the turn budget stops the loop and says so', async () => {
  const { ws, home } = scaffold('agent-turns');
  const provider = scriptedProvider(Array.from({ length: 10 }, (_, i) => callTool(`t${i}`, 'exec', { argv: [process.execPath, '-e', '0'] })));
  const result = await agentResultOf(argvFor(ws, home, 'loop forever', ['--max-turns', '3']), {}, { startProviderFn: provider.start });

  assert.equal(result.stopReason, 'turn-budget');
  assert.equal(result.status, 'failed');
  assert.equal(result.turnCount, 3);
  assert.notEqual(result.exitCode, EXIT.ok, 'a run that never finished must not report success');
});

test('P5AC9: a provider that cannot answer is a named outcome, not a crash', async () => {
  const { ws, home } = scaffold('agent-provfail');
  const provider = { start: () => ({
    provider: 'scripted', model: 'scripted-1', alive: false, logs: [],
    async complete() { throw new Error('anthropic request failed: ENOTFOUND'); },
    close() {},
  }) };
  const result = await agentResultOf(argvFor(ws, home, 'do a thing'), {}, { startProviderFn: provider.start });

  assert.equal(result.stopReason, 'provider-error');
  assert.equal(result.exitCode, EXIT.network);
  assert.match(result.stopDetail, /ENOTFOUND/);
});

test('P5AC9: an aborted signal ends the run as cancelled, not as a failure', async () => {
  const { ws, home } = scaffold('agent-cancel');
  const controller = new AbortController();
  const provider = scriptedProvider([
    (() => { controller.abort(); return callTool('t1', 'exec', { argv: [process.execPath, '-e', '0'] }); }),
    say('unreachable'),
  ]);
  const result = await agentResultOf(argvFor(ws, home, 'do a thing'), { signal: controller.signal }, { startProviderFn: provider.start });

  assert.equal(result.stopReason, 'cancelled');
  assert.equal(result.status, 'cancelled');
  assert.equal(result.exitCode, EXIT.cancelled);
});

// --- the benchmark profile ------------------------------------------------

test('the benchmark profile names the dropped lifecycle steps instead of faking their preconditions', async () => {
  const { ws, home } = scaffold('agent-profile');
  const provider = scriptedProvider([say('nothing to do')]);
  const result = await agentResultOf(argvFor(ws, home, 'a task'), {}, { startProviderFn: provider.start });

  assert.equal(result.profile.id, 'benchmark');
  assert.deepEqual(result.profile.drops.map((d) => d.step).sort(), ['compound', 'gate', 'human-review', 'verify']);
  for (const drop of result.profile.drops) assert.ok(drop.precondition, `${drop.step} must say what it lacks`);

  assert.equal(fs.existsSync(path.join(ws, 'docs', 'plans')), false,
    'a plan file synthesized to satisfy `gate` would measure ceremony, not capability');

  const system = provider.requests[0].system;
  assert.match(system, /OUT OF SCOPE/, 'the model is told which steps are impossible here, so it does not spend turns finding out');
  for (const drop of BENCHMARK_PROFILE.drops) assert.ok(system.includes(drop.step));
});

test('the persona is the hydrated agent file, and a missing one degrades rather than refuses', async () => {
  const hydrated = scaffold('agent-persona', { personaText: '# Engineer\n\nSPECIFIC-PERSONA-MARKER\n' });
  const provider = scriptedProvider([say('ok')]);
  const result = await agentResultOf(argvFor(hydrated.ws, hydrated.home, 'a task'), {}, { startProviderFn: provider.start });
  assert.equal(result.persona.name, 'engineer');
  assert.equal(result.persona.hydrated, true);
  assert.match(provider.requests[0].system, /SPECIFIC-PERSONA-MARKER/);

  const bare = scaffold('agent-nopersona', { persona: null });
  const provider2 = scriptedProvider([say('ok')]);
  const result2 = await agentResultOf(argvFor(bare.ws, bare.home, 'a task'), {}, { startProviderFn: provider2.start });
  assert.equal(result2.status, 'ok', 'a container that never ran `install` still has a task to attempt');
  assert.equal(result2.persona.hydrated, false, 'and the result says so rather than implying a persona it did not have');
});

test('a persona name cannot walk out of the agents directory', () => {
  assert.throws(() => resolvePersona('/tmp/home', '../../etc/passwd'), (e) => e.code === 'E_USAGE');
  assert.throws(() => resolvePersona('/tmp/home', 'a/b'), (e) => e.code === 'E_USAGE');
});

test('orientation degrades cleanly when there is nothing to orient over', async () => {
  const { ws, home } = scaffold('agent-noorient');
  const provider = scriptedProvider([say('ok')]);
  const result = await agentResultOf(
    argvFor(ws, home, 'a task'),
    {},
    { startProviderFn: provider.start, runOrientFn: () => { throw new Error('no repo here'); } },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.orientation.available, false);
  assert.match(result.orientation.reason, /no repo here/);
});

// --- P5AC10: inspectable through the existing run surface ------------------

test('P5AC10: `agent` is a registered execute-class command, so bin/ae.mjs journals it like any other', () => {
  const entry = getCommand('agent');
  assert.ok(entry, 'an unregistered command would bypass the run journal entirely');
  assert.equal(entry.sideEffect, 'execute',
    'anything softer would let the loop run where `exec` itself is refused');
  assert.ok(typeof entry.resultOf === 'function' && typeof entry.exitOf === 'function',
    'the envelope lane must carry the same stop reason and exit code the ledger does');
});

test('P5AC10: a real dispatch appears in `run list` as an agent run', () => {
  const { ws, home } = scaffold('agent-journal');
    fs.mkdirSync(path.join(home, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(home, 'harness', 'config.yaml'), 'agent.enabled: true\n');
    const res = spawnSync(process.execPath, [
    binPath, 'agent', 'a task', '--workspace', ws, '--copilot-home', home, '--max-seconds', '1', '--max-turns', '1',
  ], { cwd: packageRoot, encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: 'not-a-real-key' } });
  assert.notEqual(res.status, EXIT.ok);

  const listed = spawnSync(process.execPath, [binPath, 'run', 'list', '--workspace', ws, '--json'], {
    cwd: packageRoot, encoding: 'utf8',
  });
  const runs = JSON.parse(listed.stdout).runs;
  const agentRun = runs.find((r) => r.command === 'agent');
  assert.ok(agentRun, '`run list` is the surface an operator already has; the loop must appear there');
  assert.ok(agentRun.run, 'every run carries its id');
  assert.ok(agentRun.actor, 'and its actor');
  assert.ok(['failed', 'timed-out'].includes(agentRun.status), `unexpected status: ${agentRun.status}`);
});

test('P5AC10: every turn event carries the run id and actor, and no transcript', async () => {
  const { ws, home } = scaffold('agent-events');
  setRunContext({ run: 'run-fixture-1', actor: { kind: 'ci' } });
  try {
    const events = createEventRegistry({ run: 'run-fixture-1', writeEvent: (payload) => writeHarnessEvent(ws, {}, payload) });
    const provider = scriptedProvider([
      callTool('t1', 'bash', { script: 'echo SENTINEL-OUTPUT' }),
      say('the SENTINEL-ANSWER is 42'),
    ]);
    await agentResultOf(
      [...'a task'.split(' '), '--workspace', ws, '--copilot-home', home],
      { events },
      { startProviderFn: provider.start },
    );

    const lines = fs.readFileSync(path.join(ws, '.harness', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const turns = lines.filter((e) => e.type === 'agent.turn');
    assert.equal(turns.length, 2, 'one record per turn');
    for (const turn of turns) {
      assert.equal(turn.run, 'run-fixture-1', 'a turn with no run id cannot be correlated with the tools it caused');
      assert.ok(turn.actor, 'nor attributed');
    }
    assert.deepEqual(turns[0].agent.tools.map((t) => t.tool), ['bash']);
    assert.equal(turns[1].agent.ended, true);

    const raw = JSON.stringify(lines);
    assert.equal(raw.includes('SENTINEL-ANSWER'), false,
      'the journal is durable, and a transcript is where a pasted credential ends up');
    assert.ok(lines.some((e) => e.type === 'bash'), 'what the tool DID is still recorded, in the execution audit');
  } finally {
    clearRunContext();
  }
});

// --- the surface ----------------------------------------------------------

test('--dry-run reports the resolved plan and calls no model', async () => {
  const { ws, home } = scaffold('agent-dry');
  let started = false;
  const result = await agentResultOf(argvFor(ws, home, 'a task', ['--dry-run']), {}, {
    startProviderFn: () => { started = true; throw new Error('must not start'); },
  });
  assert.equal(started, false, 'a flag whose whole meaning is "show me what you would do" must not do it');
  assert.equal(result.dryRun, true);
  assert.equal(result.persona.name, 'engineer');
  assert.ok(result.systemPromptBytes > 0);
  assert.equal(result.exitCode, EXIT.ok);
});

test('the budget flags are validated, never best-guessed', async () => {
  const { ws, home } = scaffold('agent-flags');
  const bad = async (extra) => assert.rejects(
    () => agentResultOf(argvFor(ws, home, 'a task', extra), {}, { startProviderFn: () => { throw new Error('unreachable'); } }),
    (e) => e.code === 'E_USAGE',
  );
  await bad(['--max-turns', '0']);
  await bad(['--max-turns', 'lots']);
  await bad(['--max-turns=']);
  await bad(['--max-turns', '3', '--max-turns', '4']);
  await bad(['--max-seconds', '-1']);
  await bad(['--provider', 'telepathy']);
});

test('the task is every bare word, so an unquoted task is not truncated to its first token', () => {
  assert.equal(taskFromArgv(['make', 'the', 'test', 'pass', '--max-turns', '3']), 'make the test pass');
  assert.equal(taskFromArgv(['--max-turns=3', 'fix', 'it']), 'fix it');
  assert.equal(taskFromArgv(['--dry-run']), '');
});

// --- provider neutrality --------------------------------------------------

test('the loop builds no provider wire shape — every one of them lives in the adapter', () => {
  const code = fs.readFileSync(path.join(packageRoot, 'lib', 'agent-loop.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const wire of ['tool_use_id', 'input_schema', 'tool_result', 'max_tokens', 'anthropic']) {
    assert.equal(code.includes(wire), false,
      `${wire} in the loop would make it an Anthropic-shaped loop wearing a neutral name; the second provider would be what discovered that`);
  }
});

test('the declared tools are exactly the governed surfaces, and every one of them is a command', () => {
  assert.deepEqual(
    AGENT_TOOLS.map((t) => t.name).sort(),
    ['apply', 'bash', 'edit', 'exec', 'read', 'search', 'todo', 'write'],
  );
  // Act tools lead; search is last (benchmark: search attractor).
  assert.ok(AGENT_TOOLS.findIndex((t) => t.name === 'bash') < AGENT_TOOLS.findIndex((t) => t.name === 'search'));
  assert.match(AGENT_TOOLS.find((t) => t.name === 'search').description, /Last resort/i);
  assert.match(buildSystemPrompt({ persona: { name: 'engineer', text: null } }), /Reproduce|reproduce/i);
  assert.equal(typeof exploreGate, 'function');
  assert.ok(MAX_EXPLORE_STREAK >= 2);
  assert.ok(MAX_SEARCH_PER_RUN >= 3);
  for (const tool of AGENT_TOOLS) {
    assert.ok(tool.description.length > 40, 'a tool the model must reason about needs its constraints described');
    assert.equal(tool.schema.type, 'object');
  }
  const commandFor = {
    bash: 'bash', exec: 'exec', read: 'get', search: 'search',
    edit: 'edit', write: 'write', todo: 'todo', apply: 'apply',
  };
  for (const tool of AGENT_TOOLS) {
    assert.ok(hasCommand(commandFor[tool.name]), `${tool.name} must dispatch to a registered command`);
  }
});

test('undo is deliberately not a tool the model can call', () => {
  assert.equal(AGENT_TOOLS.some((t) => t.name === 'undo'), false);
  assert.ok(hasCommand('undo'), 'but it is still a command an operator can run');
  assert.equal(getCommand('undo').surfaces.includes('agent'), false);
});

test('tool output handed back to the model is bounded', () => {
  const result = { status: 'ok', exitCode: 0, output: [{ line: 'x'.repeat(100_000) }] };
  const text = renderToolResult(result, { maxBytes: 2048 });
  assert.ok(Buffer.byteLength(text, 'utf8') <= 2048 + 32);
  assert.match(text, /truncated/);
});

test('the system prompt survives a persona that is absent, empty, or enormous', () => {
  for (const persona of [
    { name: 'engineer', text: null, hydrated: false },
    { name: 'engineer', text: '', hydrated: true },
    { name: 'engineer', text: 'x'.repeat(200_000), hydrated: true },
  ]) {
    const system = buildSystemPrompt({ persona });
    assert.ok(system.includes('OUT OF SCOPE'), 'the profile section is never the part that gets dropped');
    assert.ok(Buffer.byteLength(system, 'utf8') <= 2048 + 64, 'autonomous card stays short');
  }
});

// --- the three gaps found reading my own code back -------------------------

test('--dry-run writes nothing into the workspace', async () => {
  const { ws, home } = scaffold('agent-drywrite');
  await agentResultOf(
    [...'a task'.split(' '), '--workspace', ws, '--copilot-home', home, '--dry-run'],
    {},
    { startProviderFn: () => { throw new Error('must not start'); } },
  );
  const written = fs.existsSync(path.join(ws, '.harness'))
    ? fs.readdirSync(path.join(ws, '.harness'), { recursive: true })
    : [];
  assert.deepEqual(written, [],
    'orientation writes a context pack and a session; a dry run must not, and it was being handed no dry-run flag at all');
});

test('--dry-run still reports whether orientation would succeed, rather than claiming it failed', async () => {
  const { ws, home } = scaffold('agent-dryreport');
  const result = await agentResultOf(
    [...'a task'.split(' '), '--workspace', ws, '--copilot-home', home, '--dry-run'],
    {},
    { startProviderFn: () => { throw new Error('must not start'); } },
  );
  assert.equal(result.orientation.available, true, 'not writing the pack is not the same as being unable to orient');
  assert.equal(result.orientation.materialized, false, 'and the report says the pack is not on disk');
});

test('the operator’s --tool-timeout is a ceiling the model cannot raise', async () => {
  const { ws, home } = scaffold('agent-ceiling');
  const provider = scriptedProvider([
    // 3600 is the configured maximum; without a ceiling the model simply wins.
    callTool('t1', 'bash', { script: 'true', timeout: 3600 }),
    say('done'),
  ]);
  const result = await agentResultOf(
    argvFor(ws, home, 'run something', ['--tool-timeout', '5']),
    {},
    { startProviderFn: provider.start },
  );
  assert.equal(result.turns[0].tools[0].timeoutSeconds, 5,
    'a control the operator set must bound the model, not default beneath it');
});

test('a tool cannot run past the wall clock the operator set', async () => {
  const { ws, home } = scaffold('agent-wallclock');
  const provider = scriptedProvider([
        callTool('t1', 'bash', { script: 'sleep 3600', timeout: 3600 }),
    say('done'),
  ]);
  const started = Date.now();
  const result = await agentResultOf(
    argvFor(ws, home, 'run something', ['--max-seconds', '1']),
    {},
    { startProviderFn: provider.start },
  );
  assert.ok(Date.now() - started < 30_000, 'the deadline stopped the tool rather than waiting on its own timeout');
  assert.equal(result.turns[0].tools[0].status, 'cancelled', 'and the tool reports the truth about why it stopped');
  assert.equal(result.stopReason, 'time-budget');
});

test('the loop never RAISES a timeout the operator lowered in their config', async () => {
    assert.equal(resolveToolTimeout({ requested: undefined, ceiling: null }), null,
    'saying nothing is what lets `exec` apply the configured timeout');
  assert.equal(resolveToolTimeout({ requested: 3600, ceiling: 5 }), 5, 'the operator ceiling wins');
  assert.equal(resolveToolTimeout({ requested: 2, ceiling: 5 }), 2, 'and a shorter request is honored');
  assert.equal(resolveToolTimeout({ requested: undefined, ceiling: 5 }), 5);
  assert.equal(resolveToolTimeout({ requested: 0, ceiling: null }), null, 'a nonsense request is not a bound');
  assert.equal(resolveToolTimeout({ requested: -5, ceiling: 10 }), 10);
});

// --- folded from review souvenirs -----------------------------------------

test('`agent` is in the SIGINT bridge, so cancellation runs its cleanup', () => {
  const source = fs.readFileSync(binPath, 'utf8');
  const match = /let signal;[\s\S]*?\[([^\]]*)\]\.includes\(command\)/.exec(source);
  assert.ok(match, 'the signal bridge should still be a declared list');
  assert.match(match[1], /'agent'/,
    'without it Ctrl-C skips the `finally` that closes the provider');
});

test('the wall clock stops a batch of tool calls partway through', async () => {
  const { ws, home } = scaffold('agent-batch-deadline');
  const calls = ['a', 'b', 'c'].map((id) => ({ id, name: 'bash', input: { script: 'sleep 2' } }));
  const provider = scriptedProvider([
    { text: '', toolCalls: calls, blocks: [], usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  const result = await agentResultOf(
    argvFor(ws, home, 'a task', ['--max-seconds', '1']),
    {},
    { startProviderFn: provider.start },
  );
  assert.equal(result.stopReason, 'time-budget');
  const dispatched = result.turns.flatMap((t) => t.tools).filter((t) => t.dispatched);
  assert.equal(dispatched.length, 1,
    'the first call consumed the budget; the other two must not still be spawned');
});

test('a completion that arrives after the deadline is time-budget, not done', async () => {
  const { ws, home } = scaffold('agent-late-complete');
  const provider = () => ({
    provider: 'scripted', model: 's', alive: true, logs: [],
    async complete() {
      await new Promise((r) => setTimeout(r, 1200));
      return { text: 'finished', toolCalls: [], blocks: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
    close() {},
  });
  const result = await agentResultOf(
    argvFor(ws, home, 'a task', ['--max-seconds', '1']),
    {},
    { startProviderFn: provider },
  );
  assert.equal(result.stopReason, 'time-budget',
    'a run that ran out of time must not report itself as finished');
  assert.notEqual(result.exitCode, 0);
});

test('a provider failure after the deadline is a time budget, not a provider error', async () => {
  const { ws, home } = scaffold('agent-late-provider-fail');
  const provider = () => ({
    provider: 'scripted', model: 's', alive: true, logs: [],
    async complete() { await new Promise((r) => setTimeout(r, 1400)); throw new Error('gateway exploded'); },
    close() {},
  });
  const result = await agentResultOf(
    argvFor(ws, home, 'a task', ['--max-seconds', '1']),
    {},
    { startProviderFn: provider },
  );
  assert.equal(result.stopReason, 'time-budget',
    'blaming the provider for the operator budget produces the wrong exit');
});

test('the run journal records the task by size and digest, never its words', () => {
  const projected = agentJournalArgv([
    'summarize', 'the', 'BLUEBIRD', 'acquisition',
    '--provider', 'openrouter', '--max-turns', '5', '--dry-run',
  ]);
  const joined = projected.join(' ');
  assert.equal(/BLUEBIRD/.test(joined), false,
    'the journal must not store the task transcript');
  assert.match(joined, /<task:\d+b:[0-9a-f]{12}>/, 'two runs still have to be tellable apart');
  assert.match(joined, /--provider openrouter/, 'configuration is not conversation and stays readable');
  assert.match(joined, /--max-turns 5/);
  assert.match(joined, /--dry-run/);
});

test('the journal projection is wired to the registry entry', () => {
  assert.equal(typeof getCommand('agent').journalArgv, 'function');
});

test('a boolean flag before the task does not eat its first word', () => {
  assert.equal(taskFromArgv(['--dry-run', 'fix', 'the', 'bug']), 'fix the bug');
  assert.equal(taskFromArgv(['--no-events', 'fix', 'the', 'bug']), 'fix the bug');
  assert.equal(taskFromArgv(['--json', '--verbose', 'fix', 'it']), 'fix it');
  assert.equal(taskFromArgv(['--provider', 'ollama', 'fix', 'it']), 'fix it');
  assert.equal(taskFromArgv(['--max-turns', '3', 'fix', 'it']), 'fix it');
});

test('every declared value-taking agent flag is one the task parser knows about', () => {
  const declared = [...GLOBAL_FLAGS, ...(getCommand('agent').args?.flags || [])]
    .filter((f) => f.type !== 'boolean')
    .map((f) => f.name);
  const missing = declared.filter((name) => !AGENT_VALUE_FLAGS.includes(name));
  assert.deepEqual(missing, [],
    'a value-taking flag missing from the set silently eats the first word of the task');
});

test('native skills-home binding is not included in the agent task', () => {
  assert.equal(taskFromArgv(['--skills-home', '/native skills', 'fix', 'the', 'bug']), 'fix the bug');
  assert.equal(taskFromArgv(['--skills-home=/native skills', 'fix', 'it']), 'fix it');
});

test('nothing in AGENT_VALUE_FLAGS is actually a boolean that would skip a task word', () => {
  const declared = new Map(
    [...GLOBAL_FLAGS, ...(getCommand('agent').args?.flags || [])].map((f) => [f.name, f.type]),
  );
  const consumesAValue = (name) => ['SENTINEL', '7'].some((value) => {
    try {
      return JSON.stringify(parseFlags([name, value]) ?? {}).includes(value);
    } catch {
      return true;
    }
  });
  const notValueTaking = AGENT_VALUE_FLAGS.filter((name) => {
    if (name === '--output') return false;
    if (declared.get(name) && declared.get(name) !== 'boolean') return false;
    return !consumesAValue(name);
  });
  assert.deepEqual(notValueTaking, [],
    'listing a boolean here makes the parser skip a word that belonged to the task');
});
