import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInput } from './tui/input.mjs';
import { parseFlags } from './flags.mjs';
import { createStyle, EXIT } from './style.mjs';
import { dispatch, hasCommand, getCommand } from './registry.mjs';
import { openPalette, resolveSelection, selectionPlan, signatureOf } from './tui/palette.mjs';
import { routeTypedLine } from './tui/typed-line.mjs';
import { buildCommandIndex, orderPaletteRows } from './command-index.mjs';
import { createTally, interpretLine, stripControl, tokenize } from './tui/session.mjs';
import { createOverlay, splitPrefix, applyPrefix, treeRows, filterSectioned } from './tui/overlay.mjs';
import { createLedger, statusForExit } from './tui/ledger.mjs';
import { renderBlock, foldState, createBlock } from './tui/block.mjs';
import { renderHeader, renderExit } from './tui/chrome.mjs';
import { completePath } from './tui/complete.mjs';
import { resolveValues } from './tui/values.mjs';
import { deriveGitContext } from './git-context.mjs';
import { readSession } from './session.mjs';
import { resolveConfig, setConfigValue } from './config.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { readLock } from './lock.mjs';
import { isProjectTrusted } from './trust.mjs';
import { readJournal, foldRuns, runStatusFromReported } from './run-journal.mjs';
import { modelPickerRows, modelStatus } from './model-cmd.mjs';
import { createProcessEventRegistry, detectActor } from './event-registry.mjs';
import { setRunContext, currentRunContext } from './run-context.mjs';
import { previewSelection, renderPreviewLines } from './tui/preview.mjs';
import {
  normalizeHostMode,
  nextHostMode,
  agentEnabledForMode,
  modeChrome,
} from './tui/host-mode.mjs';
import { createQuestion, answerQuestion, questionLines, questionEvent } from './tui/question.mjs';
import { gateActionRows, parseGateAction, gatePromptLines } from './tui/gate-actions.mjs';
import { configSettingsRows, verbActionRows } from './tui/modals.mjs';
import { readBridgeIdentity, resolveVSCodeExtensionsDir, VSCODE_BRIDGE_DIR, VSCODE_BRIDGE_ID } from './install-vscode-bridge.mjs';
import {
  WALKTHROUGH_SEEN_KEY,
  attachWalkthroughOverlay,
  createWalkthrough,
  shouldAutoOpenWalkthrough,
  walkthroughLines,
} from './tui/walkthrough.mjs';

/** `/Users/me/x` reads better as `~/x`, and the header has one row. */
const tildePath = (full) => {
  const home = os.homedir();
  return home && full.startsWith(home) ? `~${full.slice(home.length)}` : full;
};

export function stripFlagSyntax(text) {
  return String(text ?? '')
    .replace(/--[a-z][a-z0-9-]*/gi, (m) => m.replace(/^--/, ''))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** How many palette rows one overlay shows. An overlay taller than a glance is
 * a list, and a list is what the palette exists instead of. */
export const PALETTE_PAGE = 9;

/** Repaint the live region at most this often while output streams. A command
 * printing 500 lines does not need 500 repaints, and a terminal asked for them
 * spends the whole run scrolling. */
const LIVE_REPAINT_MS = 60;

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

/** The registry declares a side-effect class per command; the palette shows it
 * so the consequence of a row is visible before it runs. */
const effectToken = (effect) => (effect === 'read' ? 'ok' : effect === 'mutate' ? 'warn' : 'error');

export async function runLedger({
  input = process.stdin,
  output = process.stdout,
  workspace = process.cwd(),
  copilotHome = null,
  argv = [],
  dispatcher = dispatch,
  now = () => new Date().toISOString(),
  config = null,
  hydrated = false,
} = {}) {
  // Declared before `createInput`, which closes over it for `onInterrupt`.
  let activeController = null;
  const settings = config ?? safeConfig({ copilotHome, workspace });
  const version = readVersion();
  const ui = createStyle({ argv, stream: output, tintMode: settings['tui.tint'] ?? 'auto', scheme: settings['tui.scheme'] ?? 'default' });
  const screenReader = settings['tui.verbosity'] === 'screen-reader';
  const tally = createTally();
  const started = now();
    const ledgerFlags = parseFlags(argv);
  const journaling = !(ledgerFlags.dryRun || ledgerFlags.noEvents || process.env.HARNESS_NO_EVENTS === '1');
  const ledger = createLedger({ workspace, harnessVersion: version, journaling });
    let pipedPalette = null;

  const session = createInput({
    input,
    output,
    ui,
    ascii: !ui.unicode,
    footerItems: settings['tui.statusline'],
    paletteChord: settings['tui.palette_chord'] ?? 'ctrl+p',
    classify: classifyWord,
    altScreen: settings['tui.alt_screen'] === true,
        onInterrupt: () => { if (activeController) activeController.abort(); },
        interactive: screenReader ? false : Boolean(input.isTTY),
  });
  const interactive = session.interactive;
  const termWidth = () => Math.max(40, output.columns || 80);

  const separator = () => {
    if (settings['tui.dividers'] === true) return [ui.paint('muted', (ui.unicode ? '─' : '-').repeat(termWidth()))];
    return settings['tui.density'] === 'comfortable' ? [''] : [];
  };

  /** Commit a block to scrollback, in the design's grammar. */
  const emit = (block) => {
    const rows = renderBlock(block, { ui, width: termWidth(), fold: {} });
    session.commit([...rows, ...separator()]);
  };

  const say = (rows) => {
    session.commit([...(Array.isArray(rows) ? rows : [rows]), ...separator()]);
  };

  function classifyWord(word, { first = false, head = '' } = {}) {
    if (!word) return null;
    if (word.startsWith('--')) return 'flag';
    if (['exit', 'quit', 'help', 'clear', 'walkthrough', 'tour'].includes(word)) return 'session';
    if (first) return hasCommand(word) ? 'command' : null;
        if (!head || !hasCommand(head)) return null;
    return (getCommand(head)?.verbs || []).some((v) => v.verb === word) ? 'verb' : null;
  }

  // ── session chrome ────────────────────────────────────────────────────
  const git = safeGit(workspace);
  const startup = new Set(settings['tui.startup'] ?? ['context', 'knowledge', 'shortcuts']);

  const gateOf = () => {
    try { return readSession(workspace)?.gateStatus || null; } catch { return null; }
  };
  const planOf = () => {
    try { return readSession(workspace)?.plan || null; } catch { return null; }
  };

  /** The configured provider and model, refreshed alongside the rest of the
   * lifecycle facts rather than on every repaint. */
  let activeModel = null;

  const readActiveModel = () => {
    try {
      const status = modelStatus({ workspace, copilotHome: resolveCopilotHome(copilotHome) });
      if (!status.agentEnabled) { activeModel = 'commands only'; return; }
      activeModel = status.model ? `${status.provider} · ${status.model}` : status.provider;
    } catch {
      activeModel = null;
    }
  };
  readActiveModel();

  const agentMode = () => {
    try {
      return modelStatus({ workspace, copilotHome: resolveCopilotHome(copilotHome) }).agentEnabled === true;
    } catch {
      return false;
    }
  };

  // Host mode: session-local chrome that keeps config agent.enabled in sync.
  let hostMode = agentMode() ? 'assist' : 'commands';
  let openQuestion = null;
  let gatePromptOpen = false;

  const applyHostMode = async (mode, { display = true } = {}) => {
    const next = normalizeHostMode(mode);
    const wantAgent = agentEnabledForMode(next);
    const on = agentMode();
    if (wantAgent !== on) {
      await runArgv(
        ['config', 'set', 'agent.enabled', wantAgent ? 'true' : 'false', '--scope', 'user'],
        { display: display ? (wantAgent ? 'agent mode on' : 'agent mode off') : null },
      );
    }
    hostMode = next;
    if (display) {
      const chrome = modeChrome(hostMode);
      say(ui.line({
        state: 'ok',
        key: 'mode',
        value: chrome.mode,
        note: chrome.note,
      }));
    }
    readActiveModel();
    refreshStatus();
  };

  let routingIndex = null;
  const indexForRouting = () => {
    routingIndex ??= buildCommandIndex({ surface: 'tui', workspace });
    return routingIndex;
  };

  const refreshStatus = () => {
    const gate = gateOf();
    const plan = planOf();
    const last = ledger.lastCommand();
    const chrome = modeChrome(hostMode);
    const agentOn = agentMode();
    const shell = settings['exec.bash_enabled'] === false ? 'denied' : 'allowed';
    session.setStatus({
      workspace: tildePath(workspace),
      branch: git.branch,
      gate,
      plan: plan ? path.basename(plan) : null,
      run: last?.run ? last.run.slice(0, 6) : null,
      runStatus: last?.status ?? null,
      version,
      model: activeModel,
      agent: agentOn,
      authority: chrome.authority,
      mode: chrome.mode,
      shell,
    });
    session.setHint({
      gate,
      shell,
      rerun: last?.command ? shortCommand(last.command) : null,
      agent: agentOn,
      mode: chrome.mode,
    });
    readActiveModel();
  };

  /** The session header. Printed once at the top and again after `clear`,
   * because those are the two moments where nothing above it says what this
   * session is about. */
  const writeHeader = () => {
    if (!startup.has('context')) return;
    const rows = renderHeader({
      ui,
      width: termWidth(),
      workspace: tildePath(workspace),
      branch: git.branch,
      commit: git.commit,
      version,
      plan: planOf() ? path.basename(planOf()) : null,
      gate: gateOf(),
    });
        const gate = gateOf();
    if (gate && gate !== 'pass' && gate !== 'ok') {
      rows.push(ui.line({
        state: 'warn',
        key: `gate ${gate}`,
        value: '',
        note: 'verify collects the evidence that opens it',
        keyWidth: `gate ${gate}`.length,
      }));
      rows.push('');
    }
    session.commit(rows);
  };
  writeHeader();

    const restoreLimit = Number.isInteger(settings['tui.restore']) ? settings['tui.restore'] : 8;
  if (restoreLimit > 0) {
    const restored = ledger.hydrate({
      limit: restoreLimit,
            restoreWorthy: (r) => {
        if (r.command === 'tui') return false;
        if (r.status !== 'succeeded') return true;
        return getCommand(r.command)?.sideEffect !== 'read';
      },
    });
    if (restored.length) {
      const failed = restored.filter((b) => b.status !== 'ok').length;
      const parts = [`${restored.length} prior run${restored.length === 1 ? '' : 's'}`];
      if (failed) parts.push(`${failed} failed`);
      session.commit([
        ui.paint('muted', `  ${ui.arrow} ${parts.join(' · ')} · ctrl+↑ to browse · run list for history`),
        ...separator(),
      ]);
    }
  }

  if (startup.has('shortcuts')) {
        session.commit([
      ui.paint('muted', '  / for commands · ! for bash'),
      ui.paint('muted', '  ? for shortcuts'),
      ...separator(),
    ]);
  }
  refreshStatus();

  const startTour = shouldAutoOpenWalkthrough({
    interactive,
    screenReader,
    seen: settings[WALKTHROUGH_SEEN_KEY] === true,
  });
  if (startTour === 'lines') {
    emitWalkthrough({ hydratedJustNow: hydrated });
    persistWalkthroughSeen();
  } else if (startTour === 'overlay') {
    showWalkthrough({ replay: false });
  }

    const onSigint = () => { if (activeController) activeController.abort(); };
  process.on('SIGINT', onSigint);

  const closeSession = () => {
    try { session.close(); } catch { /* nothing left to restore */ }
    process.off('SIGINT', onSigint);
  };

  const withSessionContext = (commandArgv) => {
    const out = [...commandArgv];
    const boundary = out.indexOf('--');
    const scan = boundary === -1 ? out : out.slice(0, boundary);
    const insertAt = boundary === -1 ? out.length : boundary;
    const extra = [];
    if (!scan.some((a) => a === '--workspace' || a.startsWith('--workspace='))) extra.push('--workspace', workspace);
    if (copilotHome && !scan.some((a) => a === '--copilot-home' || a.startsWith('--copilot-home='))) {
      extra.push('--copilot-home', copilotHome);
    }
    out.splice(insertAt, 0, ...extra);
    return out;
  };

  const runArgv = async (rawArgv, { display = null } = {}) => {
    if (!rawArgv.length) return null;
    const commandArgv = withSessionContext(rawArgv);
    const [name, ...rest] = commandArgv;
    if (!hasCommand(name)) {
      const block = ledger.open({ command: display ?? rawArgv.join(' '), argv: rawArgv });
      ledger.append(block, ui.line({ state: 'error', key: 'unknown', value: name, note: 'type / to see what exists' }));
      ledger.close(block, { status: 'usage', exitCode: EXIT.usage, tally: ui.summary({ ok: 0, err: 1, exit: EXIT.usage }) });
      tally.record(EXIT.usage, {});
      emit(block);
      return block;
    }

        const block = ledger.open({ command: display ?? rawArgv.join(' '), argv: rawArgv });
        if (name === 'agent') block.keepTail = true;
        const listing = new Set(['config', 'model']);
    if (listing.has(name) && !rest.some((a) => a === 'set' || a === 'clear')) block.folded = false;
    activeController = new AbortController();
    session.beginLive(block);

        const outerContext = currentRunContext();
    setRunContext({ run: block.run, actor: detectActor() });
    const events = block.run ? createProcessEventRegistry(commandArgv, block.run) : undefined;
    let reportedStatus = null;

        let lastPaint = 0;
    const capture = session.capture((line) => {
      ledger.append(block, line);
      const t = Date.now();
      if (t - lastPaint >= LIVE_REPAINT_MS) { lastPaint = t; session.refreshLive(); }
    });

    let exitCode = 0;
    let cancelled = false;
    let timedOut = false;
    try {
      exitCode = await dispatcher([name, ...rest], {
        style: ui,
        signal: activeController.signal,
        events,
                onRunStart: () => ledger.openRun(block),
                reportStatus: (reported) => { reportedStatus = reported; },
                reportSelection: (selection) => {
          if (selection?.items?.length) block.selection = selection;
        },
      });
    } catch (error) {
      exitCode = Number.isInteger(error?.exit) ? error.exit : 1;
      cancelled = error?.code === 'E_CANCELLED';
      timedOut = error?.code === 'E_TIMEOUT' || exitCode === EXIT.timedOut;
      for (const l of ui.errorBlock({
        code: error?.code || 'E_UNEXPECTED',
        message: error?.message || String(error),
        fix: error?.hint,
        exit: exitCode,
      })) ledger.append(block, l);
    } finally {
      capture.release();
      activeController = null;
      session.endLive();
      setRunContext(outerContext);
    }

        cancelled = cancelled || exitCode === EXIT.cancelled;
    const status = runStatusFromReported(reportedStatus)
      ?? statusForExit(exitCode, { cancelled, timedOut: timedOut && !cancelled });
    ledger.close(block, {
      status,
      exitCode,
      tally: closingTally(block, exitCode, cancelled),
      next: nextAction(name, status),
    });
    tally.record(exitCode, { cancelled });
    emit(block);
    refreshStatus();
    return block;
  };

  const closingTally = (block, exitCode, cancelled) => {
    const rows = block.lines.length;
    if (cancelled) return `cancelled · ${rows} line${rows === 1 ? '' : 's'} · journal entry appended`;
    if (exitCode !== 0) return `${rows} line${rows === 1 ? '' : 's'} ${ui.arrow} exit ${exitCode}`;
    const fold = foldState(block);
        const found = block.selection?.items?.length ?? 0;
    if (found) {
      const shown = fold.folded ? `${rows} lines · ${fold.hidden} folded · ` : '';
      return `${shown}${found} to open ${ui.arrow} results`;
    }
    return fold.folded ? `${rows} lines · ${fold.hidden} folded` : null;
  };

  /** The one action that follows. Suggested only where the registry makes it
   * unambiguous — a wrong next action is worse than none. */
  const nextAction = (name, status) => {
    if (status === 'succeeded') return null;
    if (name === 'verify' || name === 'checks') return 'run tree <id>';
    if (name === 'gate') return 'plan show';
    return null;
  };

  // ── the palette ───────────────────────────────────────────────────────

    const SESSION_ROWS = Object.freeze([
    { label: 'results', session: 'results', note: 'open one of the last search’s results', sideEffect: null },
    { label: 'replay', signature: '[id]', session: 'replay', note: 're-run the last block, or one by id', sideEffect: null },
    { label: 'exit', session: 'exit', note: 'close the session · also ctrl+d', sideEffect: null },
    { label: 'clear', session: 'clear', note: 'clear the viewport · scrollback survives', sideEffect: null },
    { label: 'help', session: 'help', note: 'the sigils and the keys', sideEffect: null },
    { label: 'Walkthrough', session: 'walkthrough', noun: 'walkthrough', note: 'what this harness is', sideEffect: null },
  ]);

  const paletteRows = (query) => {
    const { prefix, rest } = splitPrefix(query);
    const palette = openPalette({ workspace, copilotHome, query: rest });
    let rows = applyPrefix(palette.rows, prefix).map((row) => ({
      ...row,
      signature: signatureOf(row),
      // Product note first; fall back to cleaned registry summary.
      note: stripFlagSyntax(row.note || row.summary || ''),
      reason: row.unavailable || null,
    }));
    if (!prefix) {
      const q = rest.trim().toLowerCase();
      const matching = SESSION_ROWS.filter((r) => {
        if (!q) return true;
        return r.label.toLowerCase().includes(q)
          || (r.note || '').toLowerCase().includes(q)
          || (r.noun || r.session || '').toLowerCase().includes(q);
      });
      for (const row of matching) {
        if (q && row.label.startsWith(q)) rows.unshift(row);
        else rows.push(row);
      }
      // Empty query: common intents first (not A–Z registry dump).
      if (!q) rows = orderPaletteRows(rows, { query: '' });
    }
    return rows;
  };

  const openPaletteOverlay = (query = '') => {
        const overlay = createOverlay({
      title: '',
      query,
      rows: paletteRows(query),
      filter: (q) => paletteRows(q),
      footer: `${ui.unicode ? '↑↓' : 'up/down'} navigate · ${ui.unicode ? '↵' : 'enter'} run · tab complete · esc close · run: plan: search: learn: narrow`,
      page: PALETTE_PAGE,
    });
    session.openPalette({ overlay, filter: (q) => paletteRows(q) });
    return overlay;
  };

  /** Collecting values for a chosen palette row. The palette never asks anyone
   * to type flag syntax — it asks for the VALUE by name and assembles the argv
   * itself. */
  let pending = null;
  /** True while the composer holds an inline completion (`search ▏`) — the
   * next submitted line answers it, so the prompt clears then. */
  let inlineHint = false;
  /** The value picker currently open, and whether it accepts an answer that is
   * not on its list. Held here rather than read off the overlay because the
   * choose handler closes the overlay before it inspects the choice. */
  let valuePicker = null;

  const askPrompt = (prompt, title = '') => {
    const note = prompt.description
      || (prompt.type === 'boolean' ? 'yes / no' : prompt.required ? 'required' : 'optional — blank skips');
    if (interactive && openValuePicker(prompt, title)) return;
    if (interactive) {
      session.setPrompt({ title, label: prompt.label, note });
      return;
    }
    say(ui.line({ state: prompt.required ? 'warn' : 'pending', key: '?', value: prompt.label, note }));
  };

  const openValuePicker = (prompt, title = '') => {
    if (!prompt) return false;
    const resolved = prompt.type === 'boolean'
      ? { items: [{ value: true, label: 'yes', note: '' }, { value: false, label: 'no', note: '' }], free: false }
            : resolveValues(prompt.choices, { workspace, copilotHome: resolveCopilotHome(copilotHome), values: pending?.values ?? {} });
    if (!resolved.items.length) return false;

    const rows = resolved.items.map((it) => ({
      label: it.label,
      note: it.note,
      unavailable: it.unavailable,
            valueChoice: it.value,
    }));
        if (!prompt.required) rows.push({ label: 'skip', note: 'leave this unset', valueChoice: SKIP_VALUE });

    const hint = resolved.free ? 'type to filter or to enter your own' : 'type to filter';
    const overlay = createOverlay({
      title: title ? `${title} · ${prompt.label}` : prompt.label,
      rows,
      kind: 'value',
      page: 12,
      filter: (query) => {
        const q = String(query ?? '').toLowerCase();
        if (!q) return rows;
        return rows.filter((r) => r.label.toLowerCase().includes(q) || String(r.note ?? '').toLowerCase().includes(q));
      },
      footer: `${ui.unicode ? '↑↓' : 'up/down'} navigate · ${ui.unicode ? '↵' : 'enter'} select · ${hint} · esc cancels`,
    });
    valuePicker = { prompt, free: resolved.free };
    session.openOverlay(overlay);
    return true;
  };
  const clearPrompt = () => { if (interactive) session.setPrompt(null); };

  /** The sentinel a picker's "skip" row carries. A real answer of `undefined`
   * and a deliberate skip have to be told apart, and `null` is a legal value
   * for some flags. */
  const SKIP_VALUE = Symbol('skip');

  const answerPending = async (value) => {
    if (!pending) return;
    const prompt = pending.queue[pending.index];
    if (value !== SKIP_VALUE && value !== undefined) pending.values[prompt.key] = value;

        if (pending.untilResolves) {
      const attempt = resolveSelection(pending.row, pending.values);
      if (attempt.argv && !attempt.invalid && !(attempt.missing?.length)) {
        const { row, values } = pending;
        pending = null;
        await finishSelection(row, values);
        return;
      }
    }

    pending.index += 1;
    if (pending.index < pending.queue.length) { askPrompt(pending.queue[pending.index], pending.row.label); return; }
    const { row, values } = pending;
    pending = null;
    await finishSelection(row, values);
  };

  const finishSelection = async (row, values) => {
    clearPrompt();
    const { argv: resolved, invalid, missing } = resolveSelection(row, values);
    if (missing?.length) {
      say(ui.line({ state: 'warn', key: 'needs', value: missing.map((k) => String(k).replace(/^--/, '')).join(', '), note: 'still required' }));
      return;
    }
    if (invalid) {
      say(ui.line({ state: 'warn', key: 'needs', value: row.label, note: invalid }));
      return;
    }
    // A nested ledger would steal the same stdin and never return cleanly.
    if (resolved?.[0] === 'tui') {
      say(ui.line({ state: 'warn', key: 'tui', value: 'already open', note: 'the session ledger is this surface — pick another command' }));
      return;
    }
    if (resolved) {
      // Only surface needs:/warnings — never a multi-row argv dump (the run
      // block already shows the command; sparse key/value/scope rows look broken).
      const preview = previewSelection(row, values);
      if (!preview.skipLedger) {
        for (const line of renderPreviewLines(ui, preview)) say(line);
      }
      await runArgv(resolved);
    }
  };

  const openGatePrompt = () => {
    const snapshot = { plan: planOf() ? path.basename(planOf()) : null, gate: gateOf() };
    for (const line of gatePromptLines(snapshot)) {
      say(ui.paint('muted', `  ${line}`));
    }
    gatePromptOpen = true;
    session.setPrompt({
      title: 'gate',
      label: 'a / c / q',
      note: 'approve · comment · quit',
    });
  };

  const handleGateAnswer = async (raw) => {
    const action = parseGateAction(raw);
    gatePromptOpen = false;
    clearPrompt();
    if (!action || action.kind === 'dismiss') {
      say(ui.line({ state: 'warn', key: 'gate', value: 'dismissed', note: 'no command run' }));
      return;
    }
    if (action.kind === 'open-plan') {
      const plan = planOf();
      if (plan) say(ui.line({ key: 'plan', value: plan, note: 'edit notes in the plan file, then gate again' }));
      else say(ui.line({ state: 'warn', key: 'plan', value: 'none', note: 'no active plan in session' }));
      return;
    }
    if (action.argv) await runArgv(action.argv, { display: 'gate approve' });
  };

  const openQuestionPrompt = (question) => {
    openQuestion = question;
    for (const line of questionLines(question)) say(ui.paint('muted', `  ${line}`));
    session.setPrompt({
      title: 'question',
      label: 'choice',
      note: 'number or label · esc/skip → inconclusive',
    });
  };

  const handleQuestionAnswer = (raw) => {
    const result = answerQuestion(openQuestion, raw);
    clearPrompt();
    if (!result.ok) {
      say(ui.line({ state: 'warn', key: 'question', value: result.reason }));
      if (openQuestion?.status === 'open') {
        session.setPrompt({
          title: 'question',
          label: 'choice',
          note: 'number or label · esc/skip → inconclusive',
        });
      }
      return;
    }
    const q = result.question;
    openQuestion = null;
    const block = createBlock({
      command: 'question',
      status: result.inconclusive ? 'inconclusive' : 'ok',
      kind: 'note',
      lines: [JSON.stringify(questionEvent(q))],
    });
    if (result.inconclusive) {
      say(ui.line({
        state: 'warn',
        key: 'question',
        value: 'inconclusive',
        note: q.reason || 'gate unanswered',
      }));
    } else {
      say(ui.line({
        state: 'ok',
        key: 'question',
        value: q.selected?.label || q.selected?.id,
        note: q.prompt,
      }));
    }
    void block;
  };

  const beginSelection = async (choice, prefill = {}) => {
    if (choice?.unavailable) {
            say(ui.line({ state: 'warn', key: 'blocked', value: choice.label, note: choice.unavailable }));
      return;
    }
    if (choice?.argvTokens?.[0]?.value === 'tui' || choice?.noun === 'tui') {
      say(ui.line({ state: 'warn', key: 'tui', value: 'already open', note: 'the session ledger is this surface — pick another command' }));
      return;
    }
    const plan = selectionPlan(choice, prefill);
    if (plan.ready) { await finishSelection(choice, prefill); return; }
    if (!plan.queue.length) {
      say(ui.line({ state: 'warn', key: 'needs', value: choice.label, note: plan.invalid || 'nothing to run' }));
      return;
    }
        if (interactive && !Object.keys(prefill).length) {
      const tokens = choice.argvTokens || [];
            const inlineSafe = tokens.every((t) => t.kind !== 'flag')
        && plan.queue.every((q) => !q.choices)
        && plan.queue.every((q) => tokens.some((t) => t.kind === 'value' && t.positional === q.key));
      if (inlineSafe) {
        const words = tokens.filter((t) => t.kind === 'command' || t.kind === 'subcommand').map((t) => t.value);
        if (words.length) {
          session.composer.setValue(`${words.join(' ')} `);
          session.setPrompt({
            title: `${words.join(' ')} · ${plan.queue.map((q) => q.label).join(' · ')}`,
            label: plan.queue.map((q) => q.label).join(' · '),
            note: 'type it, ↵ runs',
          });
          inlineHint = true;
          return;
        }
      }
    }
    pending = { row: choice, queue: plan.queue, index: 0, values: { ...prefill }, untilResolves: plan.untilResolves };
    if (!interactive) say(ui.paint('muted', `${plan.queue.length} value(s) needed · blank skips optional · exit cancels`));
    askPrompt(plan.queue[0], choice.label);
  };

  // ── block navigation & the run tree ───────────────────────────────────
  const blockRows = () => ledger.blocks
    .filter((b) => b.kind !== 'note')
    .slice(-40)
    .reverse()
    .map((b) => ({
      label: `${b.marked ? (ui.unicode ? '★ ' : '* ') : ''}${shortCommand(b.command) || '(note)'}`,
      note: [b.status, b.id.slice(0, 6)].filter(Boolean).join(' · '),
      sideEffect: null,
      block: b,
    }));

  const openModelPicker = () => {
    const rows = modelPickerRows({ workspace, copilotHome: resolveCopilotHome(copilotHome) });
    const overlay = createOverlay({
      title: 'model',
      rows,
      kind: 'model',
      page: 14,
      actions: null,
      filter: (query) => filterSectioned(rows, query),
      footer: `${ui.unicode ? '↑↓' : 'up/down'} navigate · ${ui.unicode ? '↵' : 'enter'} select · type to filter · esc close`,
    });
    const activeAt = rows.findIndex((r) => r.active);
    if (activeAt > 0) for (let i = 0; i < activeAt; i += 1) overlay.handleKey(null, { name: 'down' });
    session.openOverlay(overlay);
    return overlay;
  };

  /** Settings modal — keys + effective values (Grok/Claude pattern, not config set/get/show). */
  const openConfigPicker = () => {
    const home = resolveCopilotHome(copilotHome);
    const rows = configSettingsRows({ workspace, copilotHome: home });
    const overlay = createOverlay({
      title: 'settings',
      rows,
      kind: 'config',
      page: 14,
      actions: null,
      filter: (query) => filterSectioned(rows, query),
      footer: `${ui.unicode ? '↑↓' : 'up/down'} · ${ui.unicode ? '↵' : 'enter'} change · type to filter · esc close`,
    });
    session.openOverlay(overlay);
    return overlay;
  };

  /** Action sheet for multi-verb families (checks, trust, runs, todos, …). */
  const openVerbSheet = (noun) => {
    const rows = verbActionRows(noun, { workspace });
    if (!rows.length) {
      say(ui.line({ state: 'warn', key: noun, value: 'no actions' }));
      return null;
    }
    const overlay = createOverlay({
      title: noun,
      rows,
      kind: 'verbs',
      page: 12,
      actions: null,
      filter: (query) => filterSectioned(rows, query),
      footer: `${ui.unicode ? '↑↓' : 'up/down'} · ${ui.unicode ? '↵' : 'enter'} run · type to filter · esc close`,
    });
    session.openOverlay(overlay);
    return overlay;
  };

  const openPicker = (picker, row = null) => {
    if (picker === 'model') return openModelPicker();
    if (picker === 'config') return openConfigPicker();
    if (picker === 'verbs' && row?.noun) return openVerbSheet(row.noun);
    return null;
  };

  /** After picking a settings key, ask for a new value and write user scope. */
  const editConfigKey = async (key) => {
    const home = resolveCopilotHome(copilotHome);
    const resolved = resolveValues(
      { source: 'config-value', literal: null },
      { workspace, copilotHome: home, values: { key } },
    );
    if (resolved.items?.length && !resolved.free) {
      const rows = resolved.items.map((item) => ({
        label: item.label || String(item.value),
        note: item.note || '',
        valueChoice: item.value,
        configKey: key,
      }));
      const overlay = createOverlay({
        title: key,
        rows,
        kind: 'config-value',
        page: 12,
        filter: (query) => filterSectioned(rows, query),
        footer: `${ui.unicode ? '↑↓' : 'up/down'} · ${ui.unicode ? '↵' : 'enter'} set · esc cancel`,
      });
      session.openOverlay(overlay);
      // Stash key for choose handler via overlay rows already carrying configKey
      return;
    }
    // Free-text value
    pending = {
      row: {
        id: 'verb:config:set',
        noun: 'config',
        verb: 'set',
        label: 'Set config value',
        argvTokens: [
          { kind: 'command', value: 'config' },
          { kind: 'subcommand', value: 'set' },
          { kind: 'value', positional: 'key', required: true },
          { kind: 'value', positional: 'value', required: true },
        ],
        prompts: [],
      },
      queue: [{ key: 'value', label: 'value', required: true, type: 'string', description: key }],
      index: 0,
      values: { key, '--scope': 'user' },
      untilResolves: false,
    };
    askPrompt(pending.queue[0], key);
  };

  const openResults = (block) => {
    const target = block ?? ledger.blocks.filter((b) => b.selection?.items?.length).at(-1) ?? null;
    if (!target?.selection?.items?.length) {
      say(ui.line({
        state: 'warn',
        key: 'results',
        value: 'nothing to open',
        note: block ? 'this block reported no results' : 'run a search first',
      }));
      return null;
    }
    const items = target.selection.items;
    const rows = items.map((item) => ({ label: item.label, note: item.note, openArgv: item.argv }));
        if (!interactive) {
      pipedPalette = rows.slice(0, PALETTE_PAGE);
      pipedPalette.forEach((row, i) => say(ui.line({
        key: String(i + 1),
        value: row.label,
        note: row.note,
      })));
      say(ui.paint('muted', `type 1–${pipedPalette.length} to open one`));
      return null;
    }
    const overlay = createOverlay({
      title: `${shortCommand(target.command)} · ${target.selection.title || `${items.length} result(s)`}`,
      rows,
      kind: 'results',
      page: 12,
      filter: (query) => filterSectioned(rows, query),
      footer: `${ui.unicode ? '↑↓' : 'up/down'} navigate · ${ui.unicode ? '↵' : 'enter'} open · type to filter · esc closes`,
    });
    session.openOverlay(overlay);
    return overlay;
  };

  const openBlockNav = () => {
    const rows = blockRows();
    if (!rows.length) { say(ui.paint('muted', 'nothing in the ledger yet')); return null; }
    const overlay = createOverlay({
      title: 'blocks',
      rows,
      actions: { y: 'copy', m: 'mark', r: 'rerun', q: 'quit', 'ctrl+o': 'fold', t: 'tree', o: 'open' },
      footer: `${ui.unicode ? '↑↓' : 'up/down'} walk · ${ui.unicode ? '↵' : 'enter'} inspect · o open results · ctrl+o fold · y copy · m mark · r re-run · t tree · q quit · esc closes`,
    });
    session.openOverlay(overlay);
    return overlay;
  };

  const openRunTree = (runId = null) => {
    let runs;
    try { runs = foldRuns(readJournal(workspace)); } catch { runs = []; }
        const named = runs.filter((r) => r.command);
    const target = runId
      ? named.find((r) => r.run === runId || String(r.run).startsWith(runId))
      : named.at(-1);
    if (!target) {
            say(ui.line({
        state: 'warn',
        key: 'run tree',
        value: runId ? String(runId).slice(0, 12) : 'latest',
        note: runId
          ? (named.length ? 'no run with that id — this block was never journaled' : 'no runs in the journal yet')
          : 'no runs in the journal yet',
      }));
      return null;
    }
    const node = {
      label: `${ui.paint('muted', 'run')} ${target.run.slice(0, 6)} ${ui.paint(target.status === 'succeeded' ? 'ok' : 'error', target.status)}`,
      status: target.status,
      duration: target.durationMs ? `${Math.round(target.durationMs / 1000)}s` : null,
      children: [{
        label: `${target.command} ${(target.argv || []).join(' ')}`.trim(),
        status: target.status,
        duration: null,
        children: [],
      }],
    };
    const overlay = createOverlay({
      title: `run tree · ${target.run.slice(0, 6)}`,
      rows: treeRows(node, { ui }),
      actions: { q: 'quit' },
      footer: `${ui.unicode ? '↑↓' : 'up/down'} walk · ${ui.unicode ? '↵' : 'enter'} inspect · esc closes`,
    });
    session.openOverlay(overlay);
    return overlay;
  };

  const askAgent = async (text) => {
    const status = modelStatus({ workspace, copilotHome: resolveCopilotHome(copilotHome) });
    if (!status.ready) {
      say(ui.line({ state: 'warn', key: 'ask', value: `${status.provider} is not connected`, note: status.reason || 'model to choose a provider' }));
      return;
    }
        await runArgv(['agent', text], { display: text });
  };

  /** Re-run a block: same argv, fresh record. Never edits the one it replays —
   * the journal is append-only and history is not a draft. */
  const rerun = async (block) => {
    if (!block?.command) { say(ui.line({ state: 'warn', key: 'rerun', value: 'nothing to re-run' })); return; }
        let argv = block.argv?.length ? [...block.argv] : null;
    if (!argv) {
      try { argv = tokenize(block.command); } catch { argv = null; }
    }
    if (!argv?.length) { say(ui.line({ state: 'warn', key: 'rerun', value: block.command, note: 'cannot be parsed back into a command' })); return; }
    await runArgv(argv, { display: block.command });
  };

  /** Clear the viewport (never scrollback), then restore the two things a
   * bare screen needs: the header saying which repository this is, and a
   * footer not pointing at blocks that are no longer in the ledger. */
  const doClear = () => {
    if (typeof session.clearScreen === 'function') session.clearScreen();
    else if (output.isTTY) output.write('\x1b[2J\x1b[H');
    ledger.clear();
    writeHeader();
    refreshStatus();
  };

  // ── the loop ──────────────────────────────────────────────────────────
  let lastEscape = 0;
  try {
    for (;;) {
      const event = await session.next();

      if (event.intent === 'exit') break;

      if (event.intent === 'escape') {
        if (activeController) { activeController.abort(); continue; }
        const t = Date.now();
                if (t - lastEscape < 600) { lastEscape = 0; openRunTree(); } else lastEscape = t;
        continue;
      }

      if (event.intent === 'cancel') {
        if (!event.hadInput) say(ui.paint('muted', '(nothing running — type exit to close)'));
        continue;
      }

      if (event.intent === 'palette') { openPaletteOverlay(''); continue; }
      if (event.intent === 'navigate') { openBlockNav(); continue; }

      if (event.intent === 'clear') { doClear(); continue; }

      if (event.intent === 'agent-mode') {
        await applyHostMode(nextHostMode(hostMode));
        continue;
      }

      if (event.intent === 'fold') {
        const last = ledger.lastCommand();
        if (last) { last.folded = !foldState(last).folded; emit(last); }
        continue;
      }

      if (event.intent === 'complete') {
        const hits = completePath(event.prefix ?? '', { workspace });
        session.composer.setCompletion(hits);
        continue;
      }

            if (event.intent === 'complete-row') {
        const row = event.row;
        const words = (row?.argvTokens || [])
          .filter((t) => t.kind === 'command' || t.kind === 'subcommand')
          .map((t) => t.value);
        if (words.length) {
          session.composer.setValue(`${words.join(' ')} `);
          const sig = signatureOf(row);
          session.setPrompt(sig
            ? { title: words.join(' '), label: sig, note: '↵ runs' }
            : null);
          inlineHint = Boolean(sig);
        }
        continue;
      }

            if (event.intent === 'close') {
        if (valuePicker) {
          valuePicker = null;
          if (pending) { pending = null; clearPrompt(); say(ui.paint('muted', 'cancelled')); }
        }
        continue;
      }

      if (event.intent === 'choose') {
        const picker = valuePicker;
        valuePicker = null;
        session.closeOverlay();
        const row = event.row;

                if (picker) {
          if (row && row.valueChoice !== undefined) {
            if (row.unavailable) {
              say(ui.line({ state: 'warn', key: 'blocked', value: row.label, note: row.unavailable }));
              askPrompt(picker.prompt, pending?.row?.label ?? '');
              continue;
            }
            await answerPending(row.valueChoice);
            continue;
          }
          const typed = String(event.query ?? '').trim();
          if (picker.free && typed) { await answerPending(typed); continue; }
                    if (pending) { pending = null; clearPrompt(); say(ui.paint('muted', 'cancelled')); }
          continue;
        }

        if (!row) continue; // Enter on an empty palette list is a dismissal
        if (row.session === 'exit') break;
        // Settings value pick (enum/bool) — write immediately.
        if (row.configKey && row.valueChoice !== undefined) {
          await runArgv(
            ['config', 'set', row.configKey, String(row.valueChoice), '--scope', 'user'],
            { display: `settings ${row.configKey}=${row.valueChoice}` },
          );
          refreshStatus();
          continue;
        }
        // Settings key → open value editor / free-text prompt.
        if (row.configKey) {
          await editConfigKey(row.configKey);
          continue;
        }
        // Product modal (Settings, Checks, Runs, Model, …) — not CLI verb dump.
        if (row.picker) {
          openPicker(row.picker, row);
          continue;
        }
        if (row.enableAgent !== undefined) {
                    await runArgv(['config', 'set', 'agent.enabled', row.enableAgent ? 'true' : 'false', '--scope', 'user'], {
            display: row.enableAgent ? 'agent mode on' : 'agent mode off',
          });
          readActiveModel();
          refreshStatus();
          continue;
        }
        if (row.clear) {
          await runArgv(['model', 'clear']);
          readActiveModel();
          refreshStatus();
          continue;
        }
        if (row.provider && row.model) {
                    await runArgv(['model', 'set', row.provider, row.model]);
          readActiveModel();
          refreshStatus();
          continue;
        }
        if (row.openArgv) { await runArgv(row.openArgv); continue; }
        if (row.session === 'results') { openResults(null); continue; }
        if (row.session === 'replay') { await rerun(ledger.lastCommand()); continue; }
        if (row.session === 'clear') { doClear(); continue; }
        if (row.session === 'help') { emitHelp(); continue; }
        if (row.session === 'walkthrough') { showWalkthrough({ replay: true }); continue; }
        if (row.block) { emit({ ...row.block, folded: false }); continue; }
        if (row.node) continue; // a tree row is a view, not a command
        await beginSelection(row);
        continue;
      }

      if (event.intent === 'action') {
        const block = event.row?.block ?? null;
        if (event.action === 'quit') { session.closeOverlay(); break; }
        if (event.action === 'fold' && block) { block.folded = !foldState(block).folded; session.closeOverlay(); emit(block); continue; }
        if (event.action === 'mark' && block) {
          const on = ledger.toggleMark(block);
          session.closeOverlay();
          say(ui.line({ state: on ? 'ok' : 'pending', key: 'mark', value: shortCommand(block.command), note: on ? 'kept with the journal' : 'unmarked' }));
          continue;
        }
        if (event.action === 'copy' && block) {
          session.closeOverlay();
                    say(ui.line({ key: 'copy', value: block.command, note: 'select with the terminal — scrollback is intact' }));
          continue;
        }
        if (event.action === 'open' && block) { session.closeOverlay(); openResults(block); continue; }
        if (event.action === 'rerun' && block) { session.closeOverlay(); await rerun(block); continue; }
        if (event.action === 'tree' && block) { session.closeOverlay(); openRunTree(block.run || block.id); continue; }
        session.closeOverlay();
        continue;
      }

      const line = stripControl(String(event.line ?? ''));
      if (inlineHint) { clearPrompt(); inlineHint = false; }

            if (event.bash && line.trim()) {
        await runArgv(['bash', '--', line.trim()], { display: `! ${line.trim()}` });
        continue;
      }

            if (pending) {
        const trimmed = line.trim();
        if (trimmed === 'exit' || trimmed === 'quit') { clearPrompt(); say(ui.paint('muted', 'cancelled')); pending = null; continue; }
        const prompt = pending.queue[pending.index];
        if (trimmed === '') {
          if (prompt.required) {
            say(ui.line({ state: 'warn', key: 'needs', value: prompt.label, note: 'required — enter a value, or exit to cancel' }));
            askPrompt(prompt, pending.row.label);
            continue;
          }
          await answerPending(SKIP_VALUE);
          continue;
        } else if (prompt.type === 'boolean') {
          const t = trimmed.toLowerCase();
          if (!['y', 'yes', 'true', '1', 'n', 'no', 'false', '0'].includes(t)) {
            say(ui.line({ state: 'warn', key: 'needs', value: prompt.label, note: 'yes or no' }));
            askPrompt(prompt, pending.row.label);
            continue;
          }
                    await answerPending(['y', 'yes', 'true', '1'].includes(t));
          continue;
        }
        await answerPending(trimmed);
        continue;
      }

      // Open gate / question prompts consume the next line.
      if (gatePromptOpen) {
        await handleGateAnswer(line);
        continue;
      }
      if (openQuestion?.status === 'open') {
        handleQuestionAnswer(line);
        continue;
      }

      const parsed = interpretLine(line);
      if (parsed.kind === 'empty') {
                if (pipedPalette) say(ui.paint('muted', `type 1–${pipedPalette.length} to pick a row, /text to refilter, or a command`));
        continue;
      }
      if (parsed.kind === 'exit') break;

      if (parsed.kind === 'palette') {
        if (interactive) { openPaletteOverlay(parsed.query); continue; }
                const rows = paletteRows(parsed.query).slice(0, PALETTE_PAGE);
        if (!rows.length) { say(ui.line({ state: 'warn', key: 'palette', value: `nothing matches ${JSON.stringify(parsed.query)}` })); continue; }
        rows.forEach((row, i) => say(ui.line({
                    state: row.sideEffect === 'read' ? 'ok' : row.sideEffect === 'mutate' ? 'warn' : row.sideEffect ? 'error' : undefined,
          key: String(i + 1),
          value: row.label,
          note: [row.sideEffect, row.note].filter(Boolean).join(' · '),
        })));
        pipedPalette = rows;
        continue;
      }

      if (pipedPalette && /^\d+$/.test(line.trim())) {
        const choice = pipedPalette[Number(line.trim()) - 1];
        pipedPalette = null;
        if (!choice) { say(ui.line({ state: 'warn', key: 'palette', value: 'no such row' })); continue; }
        if (choice.session === 'exit') break;
        if (choice.openArgv) { await runArgv(choice.openArgv); continue; }
        if (choice.picker) { openPicker(choice.picker, choice); continue; }
        if (choice.session === 'results') { openResults(null); continue; }
        if (choice.session === 'replay') { await rerun(ledger.lastCommand()); continue; }
        if (choice.session === 'clear') { doClear(); continue; }
        if (choice.session === 'help') { emitHelp(); continue; }
        if (choice.session === 'walkthrough') { showWalkthrough({ replay: true }); continue; }
        await beginSelection(choice);
        continue;
      }
      pipedPalette = null;

      if (parsed.kind === 'invalid') {
        say(ui.line({ state: 'error', key: 'input', value: parsed.reason, note: parsed.hint }));
      } else if (parsed.kind === 'rerun') {
        const target = parsed.target ? ledger.byId(parsed.target) : ledger.lastCommand();
        if (!target) {
          say(ui.line({ state: 'warn', key: 'rerun', value: parsed.target || 'last', note: parsed.target ? 'no block with that id in this session' : 'nothing has run yet' }));
        } else {
          await rerun(target);
        }
      } else if (parsed.kind === 'bash-enter') {
        session.composer.setBashMode(true);
        say(ui.paint('muted', '  bash mode · type a shell command · esc leaves'));
      } else if (parsed.kind === 'shell') {
        if (!parsed.script) {
          session.composer.setBashMode(true);
          say(ui.paint('muted', '  bash mode · type a shell command · esc leaves'));
        } else {
          await runArgv(['bash', '--', parsed.script], { display: `!${parsed.script}` });
        }
      } else if (parsed.kind === 'results') {
        openResults(null);
      } else if (parsed.kind === 'help') {
        emitHelp();
      } else if (parsed.kind === 'walkthrough') {
        showWalkthrough({ replay: true });
      } else if (parsed.kind === 'clear') {
        doClear();
      } else if (parsed.kind === 'agent-mode-set') {
        await applyHostMode(parsed.enabled ? 'assist' : 'commands');
      } else if (parsed.kind === 'host-mode-set') {
        await applyHostMode(parsed.mode);
      } else if (parsed.kind === 'gate-menu') {
        openGatePrompt();
      } else if (parsed.kind === 'ask-question') {
        openQuestionPrompt(createQuestion({
          prompt: parsed.prompt || 'Choose an option',
          choices: parsed.choices || ['yes', 'no', 'skip'],
        }));
      } else if (parsed.kind === 'inspect') {
        await runArgv(['inspect', parsed.verb || 'config', ...(parsed.key ? [parsed.key] : [])].filter(Boolean), {
          display: parsed.key ? `inspect ${parsed.verb || 'config'} ${parsed.key}` : `inspect ${parsed.verb || 'config'}`,
        });
      } else if (parsed.kind === 'runs-list') {
        await runArgv(['run', 'list', '--limit', '12'], { display: 'run list' });
      } else if (parsed.kind === 'runs-resume') {
        if (parsed.id) await runArgv(['run', 'resume', parsed.id], { display: `run resume ${parsed.id}` });
        else await runArgv(['run', 'list', '--limit', '12'], { display: 'run list' });
      } else if (parsed.kind === 'reference') {
        const hits = completePath(parsed.target, { workspace });
        if (!hits.length) say(ui.line({ state: 'warn', key: 'file', value: parsed.target, note: 'no match in this workspace' }));
        else hits.forEach((h) => say(ui.line({ state: 'pending', key: h.kind, value: h.path })));
      } else if (parsed.argv?.[0] === 'tui') {
                say(ui.line({ state: 'warn', key: 'tui', value: 'already open', note: 'the session ledger is this surface' }));
      } else if (parsed.argv?.length === 1 && parsed.argv[0] === 'bash') {
        session.composer.setBashMode(true);
        say(ui.paint('muted', '  bash mode · type a shell command · esc leaves'));
      } else if (parsed.argv?.length === 1 && parsed.argv[0] === 'tree') {
        await runArgv(['tree', 'workspace'], { display: 'tree workspace' });
      } else if (parsed.argv?.length && !hasCommand(parsed.argv[0]) && agentMode() && modeChrome(hostMode).agent) {
        if (hostMode === 'plan') {
          say(ui.line({
            state: 'pending',
            key: 'plan',
            value: 'proposal only',
            note: 'mode plan — agent may answer; use gate menu before mutate',
          }));
        }
        await askAgent(line);
      } else if (parsed.argv?.length > 1 && !hasCommand(parsed.argv[0])) {
                say(ui.line({ state: 'warn', key: 'ask', value: 'agent mode is off', note: 'shift+tab cycles modes · ! shell · / commands' }));
      } else {
                const routed = interactive ? routeTypedLine(parsed.argv, { workspace, index: indexForRouting() }) : null;
        if (routed?.picker) openPicker(routed.picker, routed.row);
        else if (routed) await beginSelection(routed.row, routed.values);
        else if (parsed.argv?.length === 1 && parsed.argv[0] === 'config') openConfigPicker();
        else await runArgv(parsed.argv);
      }
    }
  } finally {
    closeSession();
  }

    const counts = { ...tally.snapshot(), marked: ledger.markCount };
  for (const row of renderExit({ ui, counts, started, width: termWidth() })) output.write(`${row}\n`);
  return EXIT.ok;

  // ── helpers that need the closure ─────────────────────────────────────
  function persistWalkthroughSeen() {
    try {
      setConfigValue({
        scope: 'user',
        key: WALKTHROUGH_SEEN_KEY,
        value: true,
        copilotHome: resolveCopilotHome(copilotHome),
        workspace,
      });
    } catch {
      // Dismiss still stands; the next launch may show the tour again.
    }
  }

  function emitWalkthrough({ hydratedJustNow = false } = {}) {
    const lines = walkthroughLines({ hydrated: Boolean(hydratedJustNow) });
    say(lines.map((line) => (line ? ui.paint('muted', `  ${line}`) : '')));
  }

  function showWalkthrough({ replay = false } = {}) {
    const hydratedJustNow = Boolean(hydrated) && !replay;
    if (interactive && !screenReader) {
      const wt = createWalkthrough({ hydrated: hydratedJustNow });
      session.openOverlay(attachWalkthroughOverlay(wt, {
        onClose: replay ? undefined : persistWalkthroughSeen,
      }));
      return;
    }
    emitWalkthrough({ hydratedJustNow });
    if (!replay) persistWalkthroughSeen();
  }

  function emitHelp() {
    const rows = [
      ['help / ?', 'this keymap and grammar'],
      ['walkthrough', 'what this harness is'],
      ['/', 'open the command palette · common intents first'],
      ['/<text>', 'filter the palette (run: search: check: learn:)'],
      ['!', 'shell mode · esc leaves'],
      ['!<command>', 'one shell command without entering the mode'],
      ['tree', 'browse project files · tree knowledge for the store'],
      ['tree lib', 'file tree under a path'],
      ['learnings', 'list what was learned · why <id> for provenance'],
      ['search <query>', 'search code and knowledge · then type results'],
      ['remember <claim>', 'teach the harness a durable claim'],
      ['agent on|off', 'toggle optional agent'],
      ['mode commands|assist|plan', 'host modes · shift+tab cycles'],
      ['gate menu', 'approve / comment / quit for the active plan'],
      ['inspect config', 'why a setting has its effective value'],
      ['runs', 'list prior runs'],
      ['config set key=value', 'settings · user scope by default'],
      ['@<path>', 'complete a file path'],
      ['results', 'open one of the last search hits'],
      ['replay', 're-run the previous block'],
      ['replay <id>', 're-run any block by id'],
      ['shift+tab', 'cycle host mode: commands → assist → plan'],
      ['ctrl+\u2191', 'walk ledger blocks'],
      ['ctrl+o', 'fold or unfold the last block'],
      ['esc', 'interrupt a running command'],
      ['ctrl+d / exit', 'close the session'],
      ['clear', 'clear the viewport · scrollback survives'],
    ];
    const keyWidth = Math.max(...rows.map(([k]) => k.length));
    say(rows.map(([k, v]) => ui.line({ key: k, value: v, keyWidth })));
  }
}

/** `bash -- npm test` reads as `!npm test` in a hint row with one line. */
function shortCommand(command, max = 34) {
  const text = String(command ?? '').replace(/^bash\s+--\s+/, '!');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function safeGit(workspace) {
  try {
    const git = deriveGitContext({ workspace });
    return {
      branch: git?.branch || (git?.detached ? 'detached' : null),
            commit: git?.headSha ? String(git.headSha).slice(0, 7) : null,
    };
  } catch {
    // A container may have no repository; the header simply omits the fields.
    return { branch: null, commit: null };
  }
}

function safeConfig({ copilotHome, workspace }) {
  try {
    const home = resolveCopilotHome(copilotHome);
    const resolved = resolveConfig({
      copilotHome: home,
      workspace,
      projectTrusted: isProjectTrusted({ workspace, copilotHome: home }),
    });
    return resolved?.values ?? {};
  } catch {
    return {};
  }
}

/** The version shown in the header. Absent rather than guessed when the
 * package cannot be read. */
function readVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

export async function ensureFirstRunInstall({
  copilotHome,
  workspace,
  install = null,
  packageVersion = null,
  verbose = false,
  dryRun = false,
} = {}) {
  if (process.env.HARNESS_SKIP_FIRST_RUN_INSTALL === '1') return false;
  const lock = readLock(copilotHome);
  // A fresh CLI/TUI is host-neutral. Setup is an explicit user selection.
  if (!lock) return false;
  const targets = Array.isArray(lock.targets) && lock.targets.length ? lock.targets.filter(target => ['vscode', 'cli'].includes(target)) : ['vscode', 'cli'];
  if (!targets.length) return false;
  const usesVSCode = targets.includes('vscode');
  const currentVersion = packageVersion || readVersion();
  if (lock && isNewerPackageVersion(lock.version, currentVersion)) return false;
  if (lock && !isNewerPackageVersion(currentVersion, lock.version) && (!usesVSCode || hasInstalledVSCodeBridge(lock))) return false;
  const command = lock ? 'upgrade' : 'install';
  const runInstall = install || (await import('./commands.mjs')).cmdInstallOrUpgrade;
  const args = [
    '--copilot-home', copilotHome,
    '--workspace', workspace,
    '--target', targets.join(','),
    ...(usesVSCode ? ['--configure-vscode'] : []),
    ...(verbose ? ['--verbose'] : []),
    ...(dryRun ? ['--dry-run'] : []),
  ];
  const exit = await runInstall(command, args);
  if (exit !== 0) {
    throw Object.assign(new Error(`automatic ae ${command} failed with exit ${exit}`), { code: 'E_INSTALL', exit });
  }
  return !dryRun;
}

function hasInstalledVSCodeBridge(lock) {
  const bridge = lock?.vscodeBridge;
  if (bridge?.id !== VSCODE_BRIDGE_ID || typeof bridge.path !== 'string') return false;
  const expected = path.resolve(resolveVSCodeExtensionsDir(), VSCODE_BRIDGE_DIR);
  if (path.resolve(bridge.path) !== expected) return false;
  try {
    const dir = fs.lstatSync(expected);
    const entry = fs.lstatSync(path.join(expected, 'extension.cjs'));
    return dir.isDirectory()
      && !dir.isSymbolicLink()
      && entry.isFile()
      && !entry.isSymbolicLink()
      && readBridgeIdentity(expected) === VSCODE_BRIDGE_ID;
  } catch {
    return false;
  }
}

function isNewerPackageVersion(current, installed) {
  if (!current) return false;
  if (!installed) return true;
  if (current === installed) return false;
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(value));
    return match ? { core: match.slice(1, 4).map(Number), prerelease: match[4] || null } : null;
  };
  const next = parse(current);
  const prior = parse(installed);
  if (!next) return false;
  if (!prior) return true;
  for (let index = 0; index < 3; index += 1) {
    if (next.core[index] !== prior.core[index]) return next.core[index] > prior.core[index];
  }
  if (next.prerelease === prior.prerelease) return false;
  if (!next.prerelease) return true;
  if (!prior.prerelease) return false;
  return next.prerelease.localeCompare(prior.prerelease, 'en', { numeric: true }) > 0;
}

export async function cmdTui(argv, ctx = {}) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  if (flags.json) {
    throw usageError('tui has no JSON output', 'the ledger is a terminal surface; use the CLI for machine-readable output');
  }
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const didHydrate = await ensureFirstRunInstall({
    copilotHome,
    workspace,
    install: ctx.install || null,
    verbose: flags.verbose,
    dryRun: flags.dryRun,
  });
  return runLedger({ workspace, copilotHome, argv, hydrated: didHydrate });
}
