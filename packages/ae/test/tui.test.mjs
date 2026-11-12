import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EXIT } from '../lib/style.mjs';
import { getCommand, listCommands, validateArgs } from '../lib/registry.mjs';
import { buildCommandIndex } from '../lib/command-index.mjs';
import { rankRows, scoreRow, SCORE } from '../lib/tui/ranking.mjs';
import { containsFlagSyntax, openPalette, promptsFor, resolveSelection, selectionPlan } from '../lib/tui/palette.mjs';
import { createTally, interpretLine, stripControl, tokenize } from '../lib/tui/session.mjs';
import { runLedger } from '../lib/tui-cmd.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');
const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const ESC = String.fromCharCode(27);

/** Drive the whole loop over strings — the reason input/output are injected. */

const LEDGER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ledger-home-'));

async function ledger(lines, { workspace = process.cwd(), dispatcher, copilotHome = LEDGER_HOME } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => { text += c.toString(); });
    const done = runLedger({ input, output, workspace, copilotHome, argv: ['--no-color', '--no-events'], dispatcher });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  await done;
  return text;
}

// --- P4bAC9: deterministic ranking -----------------------------------------

test('P4bAC9: word-boundary matches rank above interior ones', () => {
  const rows = [
    { id: 'a', label: 'prune' },
    { id: 'b', label: 'run list' },
    { id: 'c', label: 'knowledge prune' },
  ];
  const ranked = rankRows(rows, 'run').map((r) => r.label);
  assert.equal(ranked[0], 'run list',
    'a person typing three letters is naming a thing, not describing where the letters appear');
  assert.ok(ranked.includes('prune'), 'an interior match still matches — it just loses');
  assert.ok(ranked.indexOf('run list') < ranked.indexOf('prune'));
});

test('P4bAC9: the same query against the same rows yields the same order, every time', () => {
  const index = buildCommandIndex({ surface: 'tui', workspace: process.cwd() });
  for (const query of ['run', 'kn', 'status', 'trust ap', 'x']) {
    const first = rankRows(index.rows, query).map((r) => r.id);
    for (let i = 0; i < 5; i += 1) {
      assert.deepEqual(rankRows(index.rows, query).map((r) => r.id), first,
        `ranking for ${JSON.stringify(query)} must not vary between calls`);
    }
        const shuffled = [...index.rows].reverse();
    assert.deepEqual(rankRows(shuffled, query).map((r) => r.id), first,
      'a total tie-break, not sort stability');
  }
});

test('P4bAC9: the score hierarchy is exact > prefix > word-boundary > interior', () => {
  assert.equal(scoreRow({ label: 'status' }, 'status'), SCORE.EXACT);
  assert.equal(scoreRow({ label: 'status' }, 'stat'), SCORE.PREFIX);
  assert.equal(scoreRow({ label: 'index status' }, 'stat'), SCORE.WORD_BOUNDARY);
  assert.equal(scoreRow({ label: 'substatus' }, 'tatu'), SCORE.INTERIOR);
  assert.equal(scoreRow({ label: 'nothing alike' }, 'zzzz'), null, 'a non-match is dropped, not shown last');
});

// --- P4bAC6: nobody types `--` ---------------------------------------------

test('P4bAC6: no palette row asks a person to read or type flag syntax', () => {
  const palette = openPalette({ workspace: process.cwd() });
  assert.ok(palette.rows.length > 0);
  for (const row of palette.rows) {
    assert.equal(containsFlagSyntax(row.label), false,
      `palette row ${JSON.stringify(row.label)} shows flag syntax — the palette is where a capability is CHOSEN, not spelled`);
    for (const prompt of promptsFor(row)) {
      assert.equal(containsFlagSyntax(prompt.label), false,
        `prompt ${JSON.stringify(prompt.label)} asks for flag syntax`);
      assert.equal(prompt.label.startsWith('-'), false, 'a person is asked for the VALUE by name');
    }
  }
});

// --- P4bAC7: the palette and dispatch cannot drift --------------------------

test('P4bAC7: every tui-surfaced command is reachable from the palette', () => {
  const palette = openPalette({ workspace: process.cwd() });
  const reachable = new Set(palette.rows.map((r) => r.argvTokens?.[0]?.value).filter(Boolean));
  const missing = [];
  for (const name of listCommands()) {
    const entry = getCommand(name);
    const surfaces = entry.surfaces || ['cli', 'tui'];
    if (!surfaces.includes('tui')) continue;
    if (!reachable.has(name)) missing.push(name);
  }
  assert.deepEqual(missing, [], 'a command the palette cannot reach is one the TUI user cannot run');
});

test('P4bAC7: every palette row resolves to an argv the CLI actually accepts', () => {
  const palette = openPalette({ workspace: process.cwd() });
  const offenders = [];
  for (const row of palette.rows) {
        const { argv, missing } = resolveSelection(row, {});
    if (missing.length || !argv) continue;
    const [name, ...rest] = argv;
    const entry = getCommand(name);
    if (!entry) { offenders.push(`${row.label} -> unknown command ${name}`); continue; }
    try {
      validateArgs(entry, rest);
    } catch (error) {
      offenders.push(`${row.label} -> ${argv.join(' ')}: ${error.message}`);
    }
  }
  assert.deepEqual(offenders, [], 'the palette must never offer a row the CLI would refuse');
});

// --- the input grammar -----------------------------------------------------

test('the sigils parse, and `!!` wins over `!`', () => {
  assert.deepEqual(interpretLine('/run'), { kind: 'palette', query: 'run' });
  assert.deepEqual(interpretLine('/'), { kind: 'palette', query: '' });
  assert.deepEqual(interpretLine('!ls -a'), { kind: 'shell', script: 'ls -a' });
    assert.deepEqual(interpretLine('!!'), { kind: 'rerun', target: null });
  assert.deepEqual(interpretLine('!! 5e08c7'), { kind: 'rerun', target: '5e08c7' },
    'the longer sigil must win, or a re-run parses as a shell command starting with `!`');
  assert.equal(interpretLine('!! not an id').kind, 'invalid',
    'anything that is not id-shaped is a mistake worth naming rather than a command worth guessing at');
  assert.deepEqual(interpretLine('@notes.md'), { kind: 'reference', target: 'notes.md' });
  assert.equal(interpretLine('   ').kind, 'empty');
  assert.equal(interpretLine('exit').kind, 'exit');
  assert.deepEqual(interpretLine('status --json'), { kind: 'command', argv: ['status', '--json'] });
});

test('session words work with or without a leading slash', () => {
    for (const [line, kind] of [
    ['exit', 'exit'], ['quit', 'exit'], ['/exit', 'exit'], ['/quit', 'exit'],
    ['clear', 'clear'], ['/clear', 'clear'],
    ['help', 'help'], ['/help', 'help'], ['?', 'help'], ['/?', 'help'],
  ]) {
    assert.equal(interpretLine(line).kind, kind, line);
  }
  // A real palette filter is still a filter — only reserved words are special.
  assert.deepEqual(interpretLine('/status'), { kind: 'palette', query: 'status' });
  // Shell escape still wins for !clear (even though native clear is preferred).
  assert.deepEqual(interpretLine('!clear'), { kind: 'shell', script: 'clear' });
});

test('tokenize honors quotes but is deliberately not a shell', () => {
  assert.deepEqual(tokenize('search "two words" --limit 5'), ['search', 'two words', '--limit', '5']);
  assert.deepEqual(tokenize("recall 'a b'"), ['recall', 'a b']);
    assert.deepEqual(tokenize('exec $HOME *'), ['exec', '$HOME', '*']);
});

test('the tally counts outcomes apart', () => {
  const tally = createTally();
  tally.record(0);
  tally.record(1);
  tally.record(130, { cancelled: true });
  assert.deepEqual(tally.snapshot(), { commands: 3, ok: 1, failed: 1, cancelled: 1 });
});

// --- P4bAC1 / P4bAC8: one behavior path, and it says what it ran ------------

test('P4bAC1: the ledger dispatches through the registry rather than shelling out', async () => {
  const calls = [];
  const text = await ledger(['status', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.equal(calls.length, 1, 'the ledger must call dispatch, not spawn a CLI');
  assert.equal(calls[0][0], 'status');
  assert.match(text, /session/);
});

test('P4bAC8: a palette-initiated run echoes the resolved argv into the ledger', async () => {
  const calls = [];
  const text = await ledger(['/status', '1', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.ok(calls.length >= 1, 'choosing a row must run something');
  assert.match(text, /[>❯] status/,
    'a transcript showing a choice but not the command cannot be replayed or reviewed — the block carries the resolved argv');
});

test('the session context reaches every command the ledger dispatches', async () => {
  const calls = [];
  const workspace = tempDir('tui-ctx-');
  await ledger(['status', 'search foo', 'exit'], {
    workspace,
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  for (const argv of calls) {
    assert.ok(argv.includes('--workspace'), `${argv[0]} must carry the session workspace`);
    assert.equal(argv[argv.indexOf('--workspace') + 1], workspace);
  }
});

test('a command that names its own workspace keeps it', async () => {
  const calls = [];
  await ledger(['status --workspace /elsewhere', 'exit'], {
    workspace: tempDir('tui-ctx2-'),
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.equal(calls[0][calls[0].indexOf('--workspace') + 1], '/elsewhere',
    'an explicit argument is the operator speaking now — the session default must not override it');
});

test('a shell escape is routed through the gated bash command, not spawned directly', async () => {
  const calls = [];
  await ledger(['!echo hi', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.equal(calls[0][0], 'bash',
    'the shell gate, env allowlist, cwd containment and audit must all apply to a ledger shell-out');
  assert.deepEqual(calls[0].slice(calls[0].indexOf('--')), ['--', 'echo hi'],
    'the script reaches bash unchanged, after the session context');
});

test('an unknown command is answered, not dispatched', async () => {
  const calls = [];
  const text = await ledger(['definitely-not-a-command', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.deepEqual(calls, []);
  assert.match(text, /unknown/);
});

test('the exit ritual prints the tally and how to pick the thread back up', async () => {
  const text = await ledger(['exit'], { dispatcher: async () => 0 });
  assert.match(text, /session/);
  assert.match(text, /resume with: ae tui/);
});

// --- P4bAC4 / P4bAC2 -------------------------------------------------------

test('P4bAC4: the ledger renders through lib/style.mjs and degrades to ASCII', async () => {
  const text = await ledger(['/status', 'exit'], { dispatcher: async () => 0 });
    assert.equal(text.includes(ESC), false, 'a limited terminal must get no escape sequences');
  assert.match(text, /\[ok\]/, 'the ASCII state token, from style.mjs rather than a local literal');
});

test('P4bAC2: tui declares no output lanes, so --output is refused rather than ignored', () => {
  const res = spawnSync(process.execPath, [binPath, 'tui', '--output', 'json-envelope', '--workspace', tempDir('tui-lane-')], {
    cwd: packageRoot, encoding: 'utf8',
  });
  assert.equal(res.status, EXIT.usage);
  assert.match(res.stdout + res.stderr, /does not support --output/);
});

// --- the session was unusable interactively, and these are the reasons ------

test('an arrow key cannot corrupt the command it precedes', () => {
  const UP = '\u001b[A';
  const DOWN = '\u001b[B';
    assert.equal(interpretLine(`${UP}${UP}${UP}exit`).kind, 'exit',
    'this arrived as ^[[A^[[A^[[Aexit and was rejected as an unknown command');
  assert.equal(interpretLine(`${DOWN}status`).kind, 'command');
  assert.deepEqual(interpretLine(`${DOWN}status`).argv, ['status']);
    assert.equal(interpretLine(`${UP}${UP}${DOWN}${DOWN}`).kind, 'empty');
  assert.equal(stripControl('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(stripControl('a\u0007b\u007f'), 'ab', 'bell and delete are not input either');
});

test('`help` and `/help` answer instead of reporting nothing matches', () => {
  for (const line of ['help', '/help', '?', '/?']) {
    assert.equal(interpretLine(line).kind, 'help',
      `${line} fell through to the palette, which cannot contain \`help\` — it is handled in bin/ae.mjs and never registered`);
  }
});

test('the session renders a visible prompt naming the workspace it acts on', async () => {
    const { createComposer } = await import('../lib/tui/composer.mjs');
  const c = createComposer({ width: 60 });
  c.setHint('  deliver · gate ok · shell allowed');
  const block = c.render();
  assert.ok(block.length >= 3, 'the input is a ruled region, not a blank line');
  assert.match(block.join('\n'), /\u276f/, 'with a caret, so a waiting session never reads as a hung one');
    assert.match(block.join('\n'), /deliver · gate ok/, 'the editor carries consequence, not identity');
  const { renderFooter } = await import('../lib/tui/chrome.mjs');
  const { plainUi } = await import('./helpers/tty.mjs');
  assert.match(
    renderFooter({ plan: 'x.md', gate: 'pass', run: 'abc123' }, { ui: plainUi(), width: 80 }),
    /plan x\.md/,
    'and the footer names what a command would act on',
  );
});

// --- palette value collection (the ledger was unusable without this) --------

test('required flag prompts keep their required bit from the command index', () => {
  const row = openPalette({ workspace: process.cwd(), query: 'plan-new' }).rows[0];
  const required = promptsFor(row).filter((p) => p.required).map((p) => p.label);
  assert.deepEqual(required, ['type', 'slug', 'intent'],
    'hard-coding required:false made plan-new look optional and the ledger never asked');
});

test('selectionPlan asks for search query and plan-new required flags', () => {
  const search = selectionPlan(openPalette({ workspace: process.cwd(), query: 'search' }).rows[0]);
  assert.equal(search.ready, null);
  assert.deepEqual(search.queue.map((p) => p.label), ['query']);

  const planNew = selectionPlan(openPalette({ workspace: process.cwd(), query: 'plan-new' }).rows[0]);
  assert.deepEqual(planNew.queue.map((p) => p.label), ['type', 'slug', 'intent']);

  const status = selectionPlan(openPalette({ workspace: process.cwd(), query: 'status' }).rows[0]);
  assert.deepEqual(status.ready, ['status']);
});

test('the ledger collects required values from a palette choice and dispatches', async () => {
  const calls = [];
  const text = await ledger(['/search', '1', 'hello world', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.equal(calls.length, 1, 'search must run after the query is supplied');
  assert.equal(calls[0][0], 'search');
  assert.ok(calls[0].includes('hello world'), `argv was ${calls[0].join(' ')}`);
  assert.match(text, /[>❯] search/, 'resolved argv is still echoed into the ledger');
  assert.equal(text.includes('not available from a piped session'), false,
    'the previous dead-end message must not appear once collection works');
});

test('the ledger collects plan-new required flags by name, not flag syntax', async () => {
  const calls = [];
  await ledger(['/plan-new', '1', 'feat', 'fix-tui-prompts', 'make the palette ask for values', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'plan-new');
  assert.ok(calls[0].includes('--slug'));
  assert.ok(calls[0].includes('fix-tui-prompts'));
  assert.ok(calls[0].includes('--intent'));
});

test('either/or rows like get stop collecting once resolveSelection accepts', async () => {
  const calls = [];
  // docid left blank, path answered — must not keep asking for lines/max-bytes.
  const text = await ledger(['/get', '1', '', 'README.md', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.equal(calls.length, 1, `expected one get, got ${calls.length}: ${JSON.stringify(calls)}`);
  assert.equal(calls[0][0], 'get');
  assert.ok(calls[0].includes('--path'));
  assert.ok(calls[0].includes('README.md'));
  assert.equal(calls[0].includes('--lines'), false, 'untilResolves must not force every optional field');
  assert.match(text, /[>❯] get/);
});

test('the ledger is not offered inside itself, and typing it is still refused', async () => {
    const { buildCommandIndex } = await import('../lib/command-index.mjs');
  const rows = buildCommandIndex({ surface: 'tui', workspace: process.cwd() }).rows;
  assert.equal(rows.some((r) => r.noun === 'tui'), false, 'no palette row opens the surface you are already in');

  const calls = [];
  const text = await ledger(['tui', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.deepEqual(calls, [], 'opening the ledger from inside the ledger must not dispatch');
  assert.match(text, /already open/);
});

test('exit during value collection cancels the choice without running', async () => {
  const calls = [];
  const text = await ledger(['/search', '1', 'exit', 'status', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'status', 'exit cancels the pending search, then status still runs');
  assert.match(text, /cancelled/);
});

test('/exit closes the session instead of filtering the palette', async () => {
  const text = await ledger(['/exit'], { dispatcher: async () => 0 });
  assert.match(text, /session/);
  assert.match(text, /resume with: ae tui/);
  assert.equal(text.includes('nothing matches'), false);
});

test('clear is a session builtin, not an unknown command', async () => {
  const calls = [];
  const text = await ledger(['clear', 'status', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'status');
  assert.equal(text.includes('unknown'), false, 'clear must not dispatch as a harness command');
    const headers = text.split('\n').filter((l) => /^[●o] /.test(l)).length;
  assert.equal(headers, 2,
    'once at startup and once after clear — otherwise a cleared viewport reads as a session that ended');
});

test('empty Enter after the palette restates how to pick a row', async () => {
  const text = await ledger(['/', '', 'exit'], { dispatcher: async () => 0 });
  assert.match(text, /type 1/);
  assert.match(text, /pick a row/);
  });

// --- review findings: replay fidelity and run attribution -------------------

test('!! replays the governed argv of a shell block, not the string that was typed', async () => {
    const calls = [];
  await ledger(['!echo hi', '!!', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv.filter((a) => !a.startsWith('--') && a !== process.cwd())); return 0; },
  });
  assert.equal(calls.length, 2, 'the shell command ran, and then ran again');
  assert.deepEqual(calls[1], calls[0], 'the replay is the same argv, not a re-parse of the display string');
  assert.equal(calls[1][0], 'bash', 'and it is still the governed bash, not a bare `!echo`');
});

test('!! <id> resolves a block by id or unique prefix, and says so when it cannot', async () => {
    const { createLedger } = await import('../lib/tui/ledger.mjs');
    const ledgerStore = createLedger({ workspace: tempDir('tui-byid-'), journaling: true });
  const a = ledgerStore.open({ command: 'verify', argv: ['verify'] });
  const b = ledgerStore.open({ command: '!echo hi', argv: ['bash', '--', 'echo hi'] });

  assert.notEqual(a.id, b.id);
  assert.equal(ledgerStore.byId(a.id)?.command, 'verify', 'an exact id resolves');
  assert.equal(ledgerStore.byId(b.id.slice(0, 12))?.command, '!echo hi', 'so does a unique prefix');
  assert.equal(ledgerStore.byId(b.id.slice(-6))?.command, '!echo hi',
    'and a unique SUFFIX — the record line prints the id tail (#xxxxxx), because the time-ordered head is the colliding part');
  assert.equal(ledgerStore.byId(`#${b.id.slice(-6)}`)?.command, '!echo hi', 'with or without the # sigil');
  assert.equal(ledgerStore.byId('zzzzzzzz'), null, 'and an id that matches nothing resolves to nothing');
  assert.deepEqual(b.argv, ['bash', '--', 'echo hi'],
    'the block keeps the argv that was dispatched, which is what a replay needs');
  assert.equal(ledgerStore.lastCommand().command, '!echo hi',
    'asserted before the ambiguity blocks below are opened, which become the new last command');
    const c = ledgerStore.open({ command: 'first', argv: ['first'] });
  const d = ledgerStore.open({ command: 'second', argv: ['second'] });
  c.id = 'shared0head-aaaa'; c.run = c.id;
  d.id = 'shared0head-bbbb'; d.run = d.id;
  assert.equal(ledgerStore.byId('shared0head'), null,
    'a prefix matching two blocks resolves to neither — replaying the wrong one is worse than asking');
  assert.equal(ledgerStore.byId('shared0head-aa')?.command, 'first', 'one more character disambiguates');
  assert.equal(ledgerStore.byId(''), null, 'and an empty id resolves to nothing at all');
});

test('an unknown block id is reported rather than guessed at', async () => {
  const text = await ledger([`!! ${'z'.repeat(8)}`, 'exit'], { dispatcher: async () => 0 });
  assert.match(text, /no block with that id in this session/);
});

/** The shared `ledger` helper passes `--no-events`, which turns journaling off
 * for the whole session — correct for grammar tests, and blinding for these
 * two. They run their own session with journaling ON in a temp workspace. */
async function journalingLedger(lines, { workspace, dispatcher, copilotHome = LEDGER_HOME }) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => { text += c.toString(); });
  const done = runLedger({ input, output, workspace, copilotHome, argv: ['--no-color'], dispatcher });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  await done;
  return text;
}

const readRuns = (workspace) => {
  const file = path.join(workspace, '.harness', 'runs.jsonl');
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
};

test('a TUI dispatch carries its own run into the event registry', async () => {
    const workspace = tempDir('tui-events-');
  let ctx = null;
  await journalingLedger(['status', 'exit'], {
    workspace,
    dispatcher: async (_argv, received) => {
      ctx = received;
      // The registry calls this once validation passes; the stub stands in.
      received.onRunStart?.();
      return 0;
    },
  });
  assert.ok(ctx, 'the command dispatched');
  assert.ok(ctx.events, 'the dispatch carries the run’s own event registry');
  assert.equal(typeof ctx.onRunStart, 'function',
    'the run record is deferred past validation, exactly as bin/ae.mjs defers it');
  assert.equal(typeof ctx.reportStatus, 'function',
    'and the command can report its own status, which beats reverse-mapping an exit code');

  const runs = readRuns(workspace);
  const starts = runs.filter((r) => r.type === 'run.start' && r.command === 'status');
  const results = runs.filter((r) => r.type === 'run.result');
  assert.equal(starts.length, 1, 'the command opened exactly one run');
  assert.ok(results.some((r) => r.run === starts[0].run && r.status === 'succeeded'),
    'and closed it with a terminal status');
});

test('a refused command journals no run — while an accepted one does', async () => {
    const workspace = tempDir('tui-refused-');
  await journalingLedger(['definitely-not-a-command', 'status', 'exit'], {
    workspace,
    dispatcher: async (_argv, received) => { received.onRunStart?.(); return 0; },
  });
  const runs = readRuns(workspace);
  const starts = runs.filter((r) => r.type === 'run.start');
  assert.equal(starts.length, 1, `only the accepted command opened a run: ${JSON.stringify(starts.map((r) => r.command))}`);
  assert.equal(starts[0].command, 'status');
  assert.ok(!starts.some((r) => r.command === 'definitely-not-a-command'),
    'a command refused before dispatch never reaches the journal');
});

test('a TUI run journals a command through its journalArgv, hides only a compound evidence value, and shows an agent task as typed', async () => {
  const workspace = tempDir('tui-journal-argv-');
  const text = await journalingLedger(['compound --insight --title t --body b --evidence-quote "QX7MARKER failing line"', 'agent QX7TASK secret task', 'exit'], {
    workspace,
    dispatcher: async (_argv, received) => { received.onRunStart?.(); return 0; },
  });
  const runs = readRuns(workspace);
  const compound = runs.find((r) => r.type === 'run.start' && r.command === 'compound');
  assert.ok(compound, JSON.stringify(runs));
  assert.deepEqual(compound.argv.slice(-2), ['--evidence-quote', '<evidence>']);
  assert.ok(runs.some((r) => r.type === 'run.start' && r.command === 'agent'), 'the agent run is journaled');
  const journal = fs.readFileSync(path.join(workspace, '.harness', 'runs.jsonl'), 'utf8');
  assert.ok(!journal.includes('QX7MARKER') && !journal.includes('QX7TASK'), journal);
  assert.ok(!text.includes('QX7MARKER'), 'the ledger block does not show the evidence value');
  assert.ok(text.includes('QX7TASK secret task'), 'the live ledger shows the agent task the person typed');
  assert.equal(getCommand('compound').args.flags.find((f) => f.name === '--evidence-quote').tui, 'cli-only', 'the palette never prompts for it');
});

// --- folded from review souvenirs -----------------------------------------

test('a running command can still be cancelled from the keyboard', async () => {
  const { createInput } = await import('../lib/tui/input.mjs');
  const { PassThrough } = await import('node:stream');
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 60 });
  const interrupts = [];
  const ui = { paint: (_t, s2) => s2, unicode: true, arrow: '->', glyph: () => '', stripe: () => '|', tintRow: (_st, r) => r, stripAnsi: (t) => t, line: () => '' };
  const session = createInput({ input, output, ui, onInterrupt: () => interrupts.push('abort') });

  input.emit('keypress', '\u0003', { name: 'c', ctrl: true });
  assert.deepEqual(interrupts, ['abort'], 'Ctrl-C during a command must reach the abort controller');
  input.emit('keypress', null, { name: 'escape' });
  assert.equal(interrupts.length, 2, 'and so must Esc');

  const pending = session.next();
  input.emit('keypress', null, { name: 'escape' });
  const event = await pending;
  assert.equal(event.intent, 'escape');
  assert.equal(interrupts.length, 2, 'an idle Esc is not an interrupt');
  session.close();
});

test('input close is idempotent and removes the resize listener', async () => {
  const { createInput } = await import('../lib/tui/input.mjs');
  const { PassThrough } = await import('node:stream');
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 60 });
  const session = createInput({ input, output, ui: { paint: (_t, s) => s, unicode: true, arrow: '->' }, label: 'x' });
  session.close();
  session.close();
  assert.equal(output.listenerCount('resize'), 0, 'an anonymous listener must not stay attached');
});
