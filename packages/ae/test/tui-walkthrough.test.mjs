/**
 * Getting-started walkthrough: first-run overlay, replay, help line, no kernel path.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { listCommands } from '../lib/registry.mjs';
import { interpretLine } from '../lib/tui/session.mjs';
import { orderPaletteRows, TUI_COMMON_NOUNS } from '../lib/command-index.mjs';
import { runLedger } from '../lib/tui-cmd.mjs';
import { tempDir } from './helpers/index.mjs';
import {
  WALKTHROUGH_BEATS,
  WALKTHROUGH_SEEN_KEY,
  attachWalkthroughOverlay,
  createWalkthrough,
  renderWalkthrough,
  walkthroughLines,
  shouldAutoOpenWalkthrough,
} from '../lib/tui/walkthrough.mjs';
import { createStyle } from '../lib/style.mjs';
import { overlayBoxWidth } from '../lib/tui/overlay.mjs';
import { displayWidth } from '../lib/tui/width.mjs';
import { resolveConfig, setConfigValue } from '../lib/config.mjs';
import { createInput } from '../lib/tui/input.mjs';
import { fakeTty, plainUi } from './helpers/tty.mjs';

async function ledger(lines, { workspace, copilotHome, dispatcher, argv = ['--no-color', '--no-events'] } = {}) {
  const ws = workspace || tempDir('wt-ws-');
  const home = copilotHome || tempDir('wt-home-');
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => { text += c.toString(); });
  const done = runLedger({
    input,
    output,
    workspace: ws,
    copilotHome: home,
    argv,
    dispatcher: dispatcher || (async () => 0),
  });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  await done;
  return { text, workspace: ws, copilotHome: home };
}

test('walkthrough has three approved beats', () => {
  assert.equal(WALKTHROUGH_BEATS.length, 3);
  assert.equal(WALKTHROUGH_BEATS[0].title, 'Adaptive Engineering');
  assert.equal(WALKTHROUGH_BEATS[1].title, 'The loop that compounds');
  assert.equal(WALKTHROUGH_BEATS[2].title, 'Almost none of this is yours to run');
  assert.match(WALKTHROUGH_BEATS[1].body.join('\n'), /orient → lock intent → gate → work → verify → compound → index/);
  assert.match(WALKTHROUGH_BEATS[2].body.join('\n'), /@engineer/);
});

test('walkthrough keys: enter/space advance, arrows move, esc dismisses, last enter completes', () => {
  const wt = createWalkthrough();
  assert.equal(wt.beat, 0);
  assert.equal(wt.handleKey(null, { name: 'return' }).intent, 'next');
  assert.equal(wt.beat, 1);
  assert.equal(wt.handleKey(' ', { name: 'space' }).intent, 'next');
  assert.equal(wt.beat, 2);
  assert.equal(wt.handleKey(null, { name: 'left' }).intent, 'prev');
  assert.equal(wt.beat, 1);
  assert.equal(wt.handleKey(null, { name: 'right' }).intent, 'next');
  assert.equal(wt.beat, 2);
  assert.equal(wt.handleKey(null, { name: 'return' }).intent, 'complete');
  const skip = createWalkthrough();
  assert.equal(skip.handleKey(null, { name: 'escape' }).intent, 'dismiss');
});

test('unbound walkthrough keys are no-ops', () => {
  const wt = createWalkthrough();
  const result = wt.handleKey('x', { name: 'x' });
  assert.equal(result.intent, null);
  assert.equal(result.changed, false);
  assert.equal(wt.beat, 0);
});

test('hydrated first-run adds the install status line only on beat 1', () => {
  const wt = createWalkthrough({ hydrated: true });
  const ui = createStyle({ argv: ['--no-color'] });
  const first = renderWalkthrough(wt, { ui, width: 80 }).join('\n');
  assert.match(first, /Copilot assets and the editor bridge were installed/);
  wt.handleKey(null, { name: 'return' });
  const second = renderWalkthrough(wt, { ui, width: 80 }).join('\n');
  assert.doesNotMatch(second, /Copilot assets and the editor bridge were installed/);
});

test('walkthrough box rows fill the overlay width after display-width wrap', () => {
  const wt = createWalkthrough({ hydrated: true });
  const ui = createStyle({ argv: ['--no-color'] });
  const width = 48;
  const box = overlayBoxWidth(width);
  for (let i = 0; i < WALKTHROUGH_BEATS.length; i += 1) {
    for (const line of renderWalkthrough(wt, { ui, width })) {
      assert.equal(displayWidth(ui.stripAnsi(line)), box, line);
    }
    if (i < WALKTHROUGH_BEATS.length - 1) wt.handleKey(null, { name: 'return' });
  }
});

test('walkthrough paints a boxed card with progress and a stable height', () => {
  const wt = createWalkthrough({ hydrated: true });
  const ui = createStyle({ argv: ['--no-color'] });
  const heights = [];
  for (let i = 0; i < WALKTHROUGH_BEATS.length; i += 1) {
    const lines = renderWalkthrough(wt, { ui, width: 80 });
    heights.push(lines.length);
    assert.match(lines[0], /┌|^\+/);
    assert.match(lines.join('\n'), new RegExp(`${i + 1}/${WALKTHROUGH_BEATS.length}`));
    assert.doesNotMatch(lines.join('\n'), /undefined/);
    if (i < WALKTHROUGH_BEATS.length - 1) wt.handleKey(null, { name: 'return' });
  }
  assert.equal(new Set(heights).size, 1, 'advancing a beat must not jump the card height');
});

test('walkthrough overlay replaces the composer and does not blink a caret in the title', async () => {
  const output = fakeTty();
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const session = createInput({ input, output, ui: plainUi() });
  const pending = session.next();
  session.openOverlay(attachWalkthroughOverlay(createWalkthrough({ hydrated: true })));

  assert.ok(output.lines.some((l) => l.includes('Adaptive Engineering')));
  assert.ok(output.lines.some((l) => l.includes('1/3')));
  assert.equal(output.lines.filter((l) => l.includes('❯')).length, 0, 'the tour is not a prompt');
  assert.equal(output.lines.some((l) => l.includes('undefined')), false);
  const height = output.lines.filter((l) => /[┌┐└┘│]/.test(l)).length;

  input.emit('keypress', null, { name: 'return' });
  assert.ok(output.lines.some((l) => l.includes('The loop that compounds')));
  assert.ok(output.lines.some((l) => l.includes('2/3')));
  assert.equal(output.lines.filter((l) => /[┌┐└┘│]/.test(l)).length, height);

  input.emit('keypress', null, { name: 'escape' });
  await pending;
  session.close();
});

test('linear walkthrough lines carry all three beats', () => {
  const lines = walkthroughLines({ hydrated: false });
  const text = lines.join('\n');
  assert.match(text, /Adaptive Engineering/);
  assert.match(text, /The loop that compounds/);
  assert.match(text, /Almost none of this is yours to run/);
  assert.match(text, /@engineer/);
  assert.match(text, /ae index/);
});

test('auto-open overlay only for interactive unseen sessions', () => {
  assert.equal(shouldAutoOpenWalkthrough({ interactive: true, screenReader: false, seen: false }), 'overlay');
  assert.equal(shouldAutoOpenWalkthrough({ interactive: true, screenReader: false, seen: true }), null);
  assert.equal(shouldAutoOpenWalkthrough({ interactive: true, screenReader: true, seen: false }), 'lines');
  assert.equal(shouldAutoOpenWalkthrough({ interactive: false, screenReader: false, seen: false }), null);
  assert.equal(shouldAutoOpenWalkthrough({ interactive: false, screenReader: false, seen: true }), null);
});

test('interpretLine treats walkthrough as session chrome', () => {
  for (const line of ['walkthrough', '/walkthrough', 'tour', '/tour']) {
    assert.equal(interpretLine(line).kind, 'walkthrough', line);
  }
});

test('? help lists the keymap and exactly one walkthrough line', async () => {
  const { text } = await ledger(['help', 'exit']);
  assert.match(text, /walkthrough\s+what this harness is/);
  assert.equal((text.match(/walkthrough\s+what this harness is/g) || []).length, 1);
  assert.match(text, /\/ for commands/);
  assert.match(text, /shift\+tab/);
});

test('typed walkthrough emits the three beats as ledger lines when not interactive', async () => {
  const { text } = await ledger(['walkthrough', 'exit']);
  assert.match(text, /Adaptive Engineering/);
  assert.match(text, /orient → lock intent → gate → work → verify → compound → index/);
  assert.match(text, /@engineer/);
});

test('non-TTY first launch does not dump the walkthrough unasked', async () => {
  const { text } = await ledger(['exit']);
  assert.doesNotMatch(text, /Adaptive Engineering/);
  assert.doesNotMatch(text, /The loop that compounds/);
});

test('empty palette common section includes Walkthrough', () => {
  const rows = orderPaletteRows([
    { noun: 'search', label: 'Search', kind: 'command' },
    { noun: 'tree', label: 'Browse files', kind: 'command' },
    { label: 'Walkthrough', session: 'walkthrough', noun: 'walkthrough', note: 'what this harness is' },
    { label: 'help', session: 'help', note: 'the sigils and the keys' },
  ], { query: '' });
  const commonStart = rows.findIndex((r) => r.section && r.label === 'common');
  const moreStart = rows.findIndex((r) => r.section && r.label === 'more');
  assert.ok(commonStart >= 0);
  const common = rows.slice(commonStart + 1, moreStart).filter((r) => !r.section);
  assert.ok(common.some((r) => r.session === 'walkthrough'), 'walkthrough belongs in common, not more');
  assert.ok(TUI_COMMON_NOUNS.includes('walkthrough'));
});

test('walkthrough is not a kernel/registry command', () => {
  assert.equal(listCommands().includes('walkthrough'), false);
});

test('walkthrough.seen is a user-scoped config key defaulting to false', () => {
  const workspace = tempDir('wt-seen-ws-');
  const copilotHome = tempDir('wt-seen-home-');
  const unset = resolveConfig({ workspace, copilotHome, projectTrusted: true });
  assert.equal(unset.values[WALKTHROUGH_SEEN_KEY], false);
  setConfigValue({
    scope: 'user',
    key: WALKTHROUGH_SEEN_KEY,
    value: 'true',
    copilotHome,
    workspace,
  });
  const set = resolveConfig({ workspace, copilotHome, projectTrusted: true });
  assert.equal(set.values[WALKTHROUGH_SEEN_KEY], true);
  assert.equal(set.provenance[WALKTHROUGH_SEEN_KEY].source, 'user');
});

test('walkthrough.seen ignores project-scope values after a user value is set', () => {
  const workspace = tempDir('wt-user-ws-');
  const copilotHome = tempDir('wt-user-home-');
  setConfigValue({
    scope: 'user',
    key: WALKTHROUGH_SEEN_KEY,
    value: 'true',
    copilotHome,
    workspace,
  });
  const projectDir = path.join(workspace, '.github', 'harness');
  fs.mkdirSync(projectDir, { recursive: true });
  for (const projectValue of [false, true]) {
    fs.writeFileSync(
      path.join(projectDir, 'config.yaml'),
      `version: 1\n${WALKTHROUGH_SEEN_KEY}: ${projectValue}\n`,
    );
    const resolved = resolveConfig({ workspace, copilotHome, projectTrusted: true });
    assert.equal(resolved.values[WALKTHROUGH_SEEN_KEY], true, `project ${projectValue} must not win`);
    assert.equal(resolved.provenance[WALKTHROUGH_SEEN_KEY].source, 'user');
    assert.match(resolved.provenance[WALKTHROUGH_SEEN_KEY].note || '', /user-scoped/);
  }
});
