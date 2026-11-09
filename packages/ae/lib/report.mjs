import fs from 'node:fs';
import path from 'node:path';
import { eventPath } from './events.mjs';
import { measuredUsage, summarizeUsage, summarizeContextAccounting } from './token-meter.mjs';
import { createStyle, keyWidthFor } from './style.mjs';

const REPORT_EVENT_CAP = 2000;

// Static budget caps. The contract test enforces the same numbers.
export const BUDGETS = { agentTokens: 900, skillLines: 300, packBytes: 2048 };
const RECOVERY_LOOP_MIN_BLOCKS = 2;
const RECOVERY_LOOP_FLAT_COST = 2500; // baseline tokens per block→recover→retry cycle
const TREND_DRIFT_RATIO = 1.2;

function eventTime(event) {
  const parsed = Date.parse(event?.ts || '');
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function chronologicalCap(events) {
  return events
    .map((event, index) => ({ event, index, time: eventTime(event) }))
    .sort((a, b) => a.time - b.time || a.index - b.index)
    .slice(-REPORT_EVENT_CAP)
    .map(({ event }) => event);
}

function estimateTokensLite(text) {
  return text ? Math.ceil(text.length / 4) : 0;
}

/** Read events for a report from an explicit list or a workspace log, capped. */
export function loadReportEvents({ workspace, events }) {
  if (Array.isArray(events)) return chronologicalCap(events);
  const file = eventPath(workspace);
  if (!fs.existsSync(file)) return [];
  const parsed = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return chronologicalCap(parsed);
}

function rankSinks(events) {
  const byType = new Map();
  for (const event of events) {
    const total = measuredUsage(event.usage)?.totalTokens;
    if (total == null || total === 0) continue;
    const bucket = byType.get(event.type) || { type: event.type, tokens: 0, count: 0, source: 'est' };
    bucket.tokens += total;
    bucket.count += 1;
    if (event.source === 'host') bucket.source = 'host';
    byType.set(event.type, bucket);
  }
  return [...byType.values()]
    .map((b) => ({ ...b, avg: Math.round(b.tokens / b.count) }))
    .sort((a, b) => b.tokens - a.tokens);
}

function topSessions(events, limit = 3) {
  const bySession = new Map();
  for (const event of events) {
    const total = measuredUsage(event.usage)?.totalTokens;
    if (total == null) continue;
    const key = event.session || '(no session)';
    const bucket = bySession.get(key) || { session: key, tokens: 0, count: 0 };
    bucket.tokens += total;
    bucket.count += 1;
    bySession.set(key, bucket);
  }
  return [...bySession.values()].sort((a, b) => b.tokens - a.tokens).slice(0, limit);
}

export function budgetBreaches({ workspace, copilotHome }) {
  const roots = [
    { agents: path.join(workspace, '.github', 'agents'), skills: path.join(workspace, '.github', 'skills') },
    copilotHome ? { agents: path.join(copilotHome, 'agents'), skills: path.join(copilotHome, 'skills') } : null,
  ].filter(Boolean);
  const root = roots.find(
    (r) => fs.existsSync(path.join(r.agents, 'engineer.agent.md')) || fs.existsSync(r.skills)
  );
  if (!root) return [];

  const breaches = [];
  const agentFile = path.join(root.agents, 'engineer.agent.md');
  if (fs.existsSync(agentFile)) {
    const tokens = Math.ceil(fs.statSync(agentFile).size / 4);
    if (tokens > BUDGETS.agentTokens) {
      breaches.push({ kind: 'agent', target: 'engineer.agent.md', value: tokens, cap: BUDGETS.agentTokens });
    }
  }
  if (fs.existsSync(root.skills)) {
    for (const entry of fs.readdirSync(root.skills, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(root.skills, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const lines = fs.readFileSync(skillFile, 'utf8').split('\n').length;
      if (lines > BUDGETS.skillLines) {
        breaches.push({ kind: 'skill', target: `${entry.name}/SKILL.md`, value: lines, cap: BUDGETS.skillLines });
      }
    }
  }
  return breaches;
}

/** Sessions where enforcement blocked repeatedly, with an estimated token cost. */
export function recoveryLoops(events) {
  const bySession = new Map();
  for (const event of events) {
    const key = event.session || '(no session)';
    const blocked = event.decision === 'block' || event.result === 'fail';
    const bucket = bySession.get(key) || { session: key, blocks: 0, burned: 0 };
    if (blocked) {
      bucket.blocks += 1;
      bucket.burned += event.usage?.['gen_ai.usage.total_tokens'] || RECOVERY_LOOP_FLAT_COST;
    }
    bySession.set(key, bucket);
  }
  return [...bySession.values()]
    .filter((s) => s.blocks >= RECOVERY_LOOP_MIN_BLOCKS)
    .sort((a, b) => b.burned - a.burned);
}

/** Tokens-per-session trend: recent half vs earlier half. Null under 2 sessions. */
export function trendRegression(events) {
  const bySession = new Map();
  for (const event of events) {
    const key = event.session || null;
    if (!key) continue;
    const total = measuredUsage(event.usage)?.totalTokens;
    if (total == null) continue;
    const bucket = bySession.get(key) || { session: key, tokens: 0, firstTs: event.ts };
    bucket.tokens += total;
    if (event.ts && event.ts < bucket.firstTs) bucket.firstTs = event.ts;
    bySession.set(key, bucket);
  }
  const sessions = [...bySession.values()].sort((a, b) => String(a.firstTs).localeCompare(String(b.firstTs)));
  if (sessions.length < 2) return null;
  const mid = Math.floor(sessions.length / 2);
  const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x.tokens, 0) / arr.length : 0);
  const earlier = mean(sessions.slice(0, mid));
  const recent = mean(sessions.slice(mid));
  const ratio = earlier ? recent / earlier : 1;
  return {
    earlier: Math.round(earlier),
    recent: Math.round(recent),
    ratio: Number(ratio.toFixed(2)),
    regressed: ratio >= TREND_DRIFT_RATIO,
    sessions: sessions.length,
  };
}

export function knowledgeSlos(events) {
  const surfaced = new Set(); const cited = new Set();
  let surfacedOccurrences = 0;
    const citedIdOccurrences = [];
  let consolidations = 0; let humanActions = 0;
    const layersById = new Map(); // id -> Set of layers the id surfaced from
  let anyLayerInfo = false;
  const recordLayer = (id, layer) => {
    if (!layersById.has(id)) layersById.set(id, new Set());
    layersById.get(id).add(layer === 'branch' ? 'branch' : 'golden');
  };
  for (const e of events) {
    if (e.type === 'orient' && Array.isArray(e.learnings)) {
      e.learnings.forEach((id) => surfaced.add(id));
      surfacedOccurrences += e.learnings.length;
      if (Array.isArray(e.learningLayers)) {
        anyLayerInfo = true;
        for (const entry of e.learningLayers) {
          if (entry && typeof entry.id === 'string') recordLayer(entry.id, entry.layer);
        }
      } else if (e.learningLayers && typeof e.learningLayers === 'object') {
        anyLayerInfo = true;
        for (const [id, layer] of Object.entries(e.learningLayers)) recordLayer(id, layer);
      }
    }
    if (e.type === 'verify' && Array.isArray(e.learnings)) {
      e.learnings.forEach((id) => cited.add(id));
      citedIdOccurrences.push(...e.learnings);
    }
    if (e.type === 'consolidate' && e.decision === 'apply' && e.result === 'pass') consolidations += 1;
    if (e.type === 'remember' || e.type === 'learning') humanActions += 1;
  }
  const citedSurfaced = [...cited].filter((id) => surfaced.has(id)).length;
  const citedOccurrences = citedIdOccurrences.filter((id) => surfaced.has(id)).length;
    let layers;
  if (anyLayerInfo) {
    layers = { golden: { surfaced: 0, cited: 0 }, branch: { surfaced: 0, cited: 0 } };
    for (const id of surfaced) {
      const idLayers = layersById.get(id) || new Set(['golden']);
      for (const layer of idLayers) {
        layers[layer].surfaced += 1;
        if (cited.has(id)) layers[layer].cited += 1;
      }
    }
  }
  return { surfaced: surfaced.size, cited: cited.size, citedSurfaced,
    utilization: surfaced.size ? Number((citedSurfaced / surfaced.size).toFixed(2)) : null,
    surfacedOccurrences, citedOccurrences,
    utilizationWeighted: surfacedOccurrences ? Number((citedOccurrences / surfacedOccurrences).toFixed(2)) : null,
    consolidations, humanActions,
    engagement: consolidations ? Number((humanActions / consolidations).toFixed(2)) : null,
    ...(layers ? { layers } : {}) };
}

export function knowledgeTokenLedger(events) {
  let bytes = 0;
  let orientsWithLearnings = 0;
  let consolidations = 0;
  for (const e of events) {
    if (e.type === 'orient' && e.learningsBytes) {
      bytes += e.learningsBytes;
      orientsWithLearnings += 1;
    }
    if (e.type === 'consolidate' && e.decision === 'apply' && e.result === 'pass') consolidations += 1;
  }
  return { injectedTokens: Math.ceil(bytes / 4), orientsWithLearnings, consolidations };
}

// How many per-session performance rows the report shows (highest-token first).
const SESSION_PERF_CAP = 10;

/** Trust an explicit total, or derive one only when both input and output are
 * present. Partial usage remains null so rankings cannot turn it into zero. */
function eventTokens(event) {
  return measuredUsage(event.usage)?.totalTokens ?? null;
}

function incrementCoverage(acc, prefix, status) {
  const normalized = ['complete', 'partial', 'unavailable'].includes(status)
    ? status
    : 'unavailable';
  const suffix = normalized[0].toUpperCase() + normalized.slice(1);
  acc[`${prefix}${suffix}Sessions`] += 1;
}

function coreCoverageProjection(coverage = {}) {
  return {
    sessionTotals: coverage.sessionTotals || 'unavailable',
    finalContextSnapshot: coverage.finalContextSnapshot || 'unavailable',
    perRequestInputTokens: coverage.perRequestInputTokens || 'unavailable',
  };
}

function coverageLabel(coverage) {
  const context = coverage.finalContextSnapshot === 'complete'
    ? 'final-context-snapshot'
    : `final-context-snapshot-${coverage.finalContextSnapshot}`;
  return [
    `${coverage.sessionTotals}-session-totals`,
    context,
    `per-request-input-${coverage.perRequestInputTokens}`,
  ].join('; ');
}

function humanCoverage(coverage) {
  const context = coverage.finalContextSnapshot === 'complete'
    ? 'final context snapshot'
    : `final context snapshot ${coverage.finalContextSnapshot}`;
  return [
    `${coverage.sessionTotals} session totals`,
    context,
    `per-request input ${coverage.perRequestInputTokens}`,
  ].join(' · ');
}

/** Per-session performance rows and roll-up, from host events carrying metrics. */
export function sessionPerformance(events) {
  const rows = events
    .filter((e) => e.metrics)
    .map((e) => ({
      session: e.session || '(no session)',
      ts: e.ts || null,
      tokens: eventTokens(e),
      ...e.metrics,
    }));
  rows.sort((a, b) => {
    if (a.tokens == null && b.tokens == null) return 0;
    if (a.tokens == null) return 1;
    if (b.tokens == null) return -1;
    return b.tokens - a.tokens;
  });
  const totals = rows.reduce(
    (acc, r) => {
      acc.sessions += 1;
      if (Number.isFinite(r.tokens)) {
        acc.tokens += r.tokens;
        acc.tokenSessions += 1;
      }
      if (Number.isFinite(r.aiCredits)) {
        acc.aiCredits += r.aiCredits;
        acc.aiCreditSessions += 1;
      }
      acc.premiumRequests += r.premiumRequests || 0;
      acc.apiRequests += r.apiRequests || 0;
      acc.apiDurationMs += r.apiDurationMs || 0;
      acc.turns += r.turns || 0;
      acc.toolCalls += r.toolCalls || 0;
      acc.toolFailures += r.toolFailures || 0;
      const systemMessages = r.promptEvidence?.systemMessages || [];
      const loadedSkills = r.promptEvidence?.loadedSkills || [];
      acc.systemMessages += systemMessages.length;
      acc.systemMessageChars += systemMessages.reduce((sum, message) => sum + (message.chars || 0), 0);
      acc.loadedSkills += loadedSkills.length;
      acc.loadedSkillBytes += loadedSkills.reduce((sum, skill) => sum + (skill.contentBytes || 0), 0);
      acc.skillInvocations += loadedSkills.reduce((sum, skill) => sum + (skill.invocations || 0), 0);
      const systemEvidenceCoverage = r.promptEvidence?.coverage?.systemMessages || 'unavailable';
      const skillEvidenceCoverage = r.promptEvidence?.coverage?.loadedSkills || 'unavailable';
      incrementCoverage(acc, 'systemMessageEvidence', systemEvidenceCoverage);
      incrementCoverage(acc, 'loadedSkillEvidence', skillEvidenceCoverage);
      acc.compactions += r.compaction?.completed || 0;
      acc.compactionTokens += r.compaction?.compactionTokensUsed || 0;
      const compactionCoverage = r.compaction?.coverage || 'unavailable';
      incrementCoverage(acc, 'compactionEvidence', compactionCoverage);
      const assistantCoverage = r.assistantOutput?.coverage || 'unavailable';
      incrementCoverage(acc, 'assistantOutput', assistantCoverage);
      if (r.assistantOutput?.messagesWithTokens > 0) {
        acc.assistantOutputSessions += 1;
        acc.assistantOutputTokens += r.assistantOutput.observedTokens || 0;
        acc.assistantToolCallingTokens += r.assistantOutput.byPhase?.toolCalling || 0;
        acc.assistantResponseOnlyTokens += r.assistantOutput.byPhase?.responseOnly || 0;
      }
      acc.linesAdded += r.linesAdded || 0;
      acc.linesRemoved += r.linesRemoved || 0;
      return acc;
    },
    {
      sessions: 0,
      tokens: 0,
      tokenSessions: 0,
      aiCredits: 0,
      aiCreditSessions: 0,
      premiumRequests: 0,
      apiRequests: 0,
      apiDurationMs: 0,
      turns: 0,
      toolCalls: 0,
      toolFailures: 0,
      systemMessages: 0,
      systemMessageChars: 0,
      loadedSkills: 0,
      loadedSkillBytes: 0,
      skillInvocations: 0,
      systemMessageEvidenceCompleteSessions: 0,
      systemMessageEvidencePartialSessions: 0,
      systemMessageEvidenceUnavailableSessions: 0,
      loadedSkillEvidenceCompleteSessions: 0,
      loadedSkillEvidencePartialSessions: 0,
      loadedSkillEvidenceUnavailableSessions: 0,
      compactions: 0,
      compactionTokens: 0,
      compactionEvidenceCompleteSessions: 0,
      compactionEvidencePartialSessions: 0,
      compactionEvidenceUnavailableSessions: 0,
      assistantOutputSessions: 0,
      assistantOutputCompleteSessions: 0,
      assistantOutputPartialSessions: 0,
      assistantOutputUnavailableSessions: 0,
      assistantOutputTokens: 0,
      assistantToolCallingTokens: 0,
      assistantResponseOnlyTokens: 0,
      linesAdded: 0,
      linesRemoved: 0,
    }
  );
  totals.knownTokens = totals.tokens;
  if (totals.tokenSessions !== totals.sessions) totals.tokens = null;
  const coverageDetails = [...new Map(rows.map((row) => {
    const projection = coreCoverageProjection(row.telemetryCoverage);
    return [JSON.stringify(projection), projection];
  })).values()];
  const coverage = coverageDetails.map(coverageLabel);
  return { rows: rows.slice(0, SESSION_PERF_CAP), totals, coverage, coverageDetails };
}

export function buildReport({ workspace, copilotHome, events }) {
  const all = loadReportEvents({ workspace, events });
  const usage = summarizeUsage(all);
  const span = {
    from: all.length ? all[0].ts : null,
    to: all.length ? all[all.length - 1].ts : null,
    sessions: new Set(all.map((e) => e.session).filter(Boolean)).size,
  };
  const hostBacked = all.some((e) => e.source === 'host');
  const performance = sessionPerformance(all);
  return {
    workspace: workspace ?? null,
    copilotHome: copilotHome ?? null,
    totals: {
      tokens: usage.totalTokens,
      knownTokens: usage.knownTotalTokens,
      input: usage.inputTokens,
      output: usage.outputTokens,
      events: all.length,
      measured: usage.completeTotalEvents,
      partialMeasured: usage.partialUsageEvents,
      usageEvents: usage.usageEvents,
      usageCoverage: usage.coverage,
    },
    span,
    hostBacked,
    contextAccounting: summarizeContextAccounting(all),
    sinks: rankSinks(all),
    topSessions: topSessions(all),
    sessions: performance.rows,
    sessionTotals: performance.totals,
    sessionCoverage: performance.coverage,
    sessionCoverageDetails: performance.coverageDetails,
    flags: {
      budgetBreaches: budgetBreaches({ workspace, copilotHome }),
      recoveryLoops: recoveryLoops(all),
      trend: trendRegression(all),
    },
    slos: { knowledge: knowledgeSlos(all), knowledgeTokens: knowledgeTokenLedger(all) },
  };
}

function bar(value, max, ui, width = 24) {
  if (!max) return '';
  const full = Math.round((value / max) * width);
  const [on, off] = ui.unicode ? ['█', '░'] : ['#', '-'];
  return ui.paint('muted', on.repeat(full) + off.repeat(Math.max(0, width - full)));
}

/** Group digits for the human surface only ("4,641,293"); JSON stays raw. */
function fmtGroup(n) {
  return n == null ? '-' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtDuration(ms) {
  if (!ms) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

function fmtPct(r) {
  return r == null ? '-' : `${Math.round(r * 100)}%`;
}

function fmtTokens(n) {
  if (n == null) return '-';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function fmtCredits(n) {
  if (!Number.isFinite(n)) return '-';
  if (n > 0 && n < 0.01) return '<0.01';
  return n.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function fmtContext(r) {
  if ([r.contextTokens, r.systemTokens, r.conversationTokens, r.toolDefinitionsTokens].every((n) => n == null)) {
    return '-';
  }
  const total = fmtTokens(r.contextTokens);
  const parts = [r.systemTokens, r.conversationTokens, r.toolDefinitionsTokens].map(fmtTokens);
  return `${total}(${parts.join('/')})`;
}

/** Compact per-session performance table (local session metrics). */
function renderSessionPerformance(report, ui, keyWidth) {
  const rows = report.sessions || [];
  if (!rows.length) return [];
  const tt = report.sessionTotals || {};
  const creditSummary = !tt.aiCreditSessions
    ? ''
    : tt.aiCreditSessions === tt.sessions
      ? ` · ${fmtCredits(tt.aiCredits)} AIC`
      : ` · ${fmtCredits(tt.aiCredits)} AIC reported (${tt.aiCreditSessions}/${tt.sessions} sessions)`;
  const out = [
    '',
    ui.line({
      key: 'sessions',
      value: `${tt.sessions}${creditSummary} · ${tt.premiumRequests} premium · ${fmtDuration(tt.apiDurationMs)} API · ${tt.turns} turns · ${tt.toolCalls} tools (${tt.toolFailures} failed)`,
      note: `+${tt.linesAdded}/-${tt.linesRemoved} lines`,
      keyWidth,
    }),
  ];
  const header = ['session', 'model', 'tokens', 'AIC', 'prem', 'turns', 'tools(f)', 'skills', 'cli', 'API', 'cache', 'ctx(s/c/t)', 'lines'];
  const table = rows.map((r) => [
    String(r.session).slice(0, 8),
    r.model || '-',
    fmtTokens(r.tokens),
    fmtCredits(r.aiCredits),
    String(r.premiumRequests ?? '-'),
    String(r.turns ?? '-'),
    `${r.toolCalls ?? 0}(${r.toolFailures ?? 0})`,
    String(r.skills ?? 0),
    String(r.harnessCliCalls ?? '-'),
    fmtDuration(r.apiDurationMs),
    fmtPct(r.cacheReadRatio),
    fmtContext(r),
    `+${r.linesAdded ?? 0}/-${r.linesRemoved ?? 0}`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const fmtRow = (row) => '  ' + row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  out.push(ui.paint('muted', fmtRow(header)));
  for (const row of table) out.push(fmtRow(row));
  out.push(ui.paint('muted', '  ctx(system/conversation/tools) · AIC is host-reported for the session'));
  if (tt.systemMessages || tt.loadedSkills) {
    out.push(
      ui.paint(
        'muted',
        `  prompt evidence ${tt.systemMessages} system message${tt.systemMessages === 1 ? '' : 's'} · ${fmtGroup(tt.systemMessageChars)} chars · ${tt.loadedSkills} loaded skill${tt.loadedSkills === 1 ? '' : 's'} · ${fmtGroup(tt.loadedSkillBytes)} bytes (${tt.skillInvocations} invocations)`
      )
    );
  }
  if (tt.sessions) {
    out.push(
      ui.paint(
        'muted',
        `  prompt coverage system ${tt.systemMessageEvidenceCompleteSessions}/${tt.sessions} complete (${tt.systemMessageEvidencePartialSessions} partial, ${tt.systemMessageEvidenceUnavailableSessions} unavailable) · skills ${tt.loadedSkillEvidenceCompleteSessions}/${tt.sessions} complete (${tt.loadedSkillEvidencePartialSessions} partial, ${tt.loadedSkillEvidenceUnavailableSessions} unavailable)`
      )
    );
  }
  if (tt.compactions || tt.compactionTokens) {
    out.push(
      ui.paint(
        'muted',
        `  ${tt.compactions} compaction${tt.compactions === 1 ? '' : 's'} · ${fmtGroup(tt.compactionTokens)} tokens · ${tt.compactionEvidenceCompleteSessions}/${tt.sessions} sessions complete · ${tt.compactionEvidencePartialSessions} partial · ${tt.compactionEvidenceUnavailableSessions} unavailable`
      )
    );
  } else if (tt.sessions) {
    out.push(
      ui.paint(
        'muted',
        `  compaction evidence ${tt.compactionEvidenceCompleteSessions}/${tt.sessions} sessions complete · ${tt.compactionEvidencePartialSessions} partial · ${tt.compactionEvidenceUnavailableSessions} unavailable`
      )
    );
  }
  if (tt.assistantOutputSessions) {
    const coverage = `${tt.assistantOutputCompleteSessions}/${tt.sessions} sessions complete · ${tt.assistantOutputPartialSessions} partial · ${tt.assistantOutputUnavailableSessions} unavailable`;
    out.push(
      ui.paint(
        'muted',
        `  assistant output observed ${fmtGroup(tt.assistantOutputTokens)} · tool-calling ${fmtGroup(tt.assistantToolCallingTokens)} · response-only ${fmtGroup(tt.assistantResponseOnlyTokens)} · ${coverage}`
      )
    );
  } else if (tt.sessions) {
    out.push(
      ui.paint(
        'muted',
        `  assistant output evidence ${tt.assistantOutputCompleteSessions}/${tt.sessions} sessions complete · ${tt.assistantOutputPartialSessions} partial · ${tt.assistantOutputUnavailableSessions} unavailable`
      )
    );
  }
  for (const coverage of report.sessionCoverageDetails || []) {
    out.push(ui.paint('muted', `  coverage ${humanCoverage(coverage)}`));
  }
  const silent = rows.filter((r) => (r.turns ?? 0) > 0 && (r.harnessCliCalls ?? 0) === 0);
  if (silent.length) {
    out.push(
      ui.line({
        state: 'warn',
        key: 'engagement',
        value: `harness CLI never invoked in ${silent.length} session(s)`,
        note: 'agent turns ran but no orient/gate/verify calls — check that the engineer contract is engaging',
        keyWidth,
      })
    );
  }
  return out;
}

export function renderReport(report, ui = createStyle()) {
  const lines = [];
  const t = report.totals;
  const keyWidth = keyWidthFor(['report', 'span', 'sinks', 'sessions', 'flags', 'knowledge'], 8);
  const src = report.hostBacked ? 'host-backed + estimated' : 'estimated (chars/4)';
  const incompleteUsage = t.usageEvents > 0 && t.tokens == null;
  const tokenValue = incompleteUsage
    ? t.usageCoverage?.total === 'partial'
      ? `token total partial · ${fmtGroup(t.knownTokens)} known`
      : 'token total unavailable'
    : `~${fmtGroup(t.tokens)} tokens`;
  const tokenNote = incompleteUsage
    ? `input ${t.input == null ? 'unavailable' : fmtGroup(t.input)} · output ${t.output == null ? 'unavailable' : fmtGroup(t.output)} · partial usage ${t.partialMeasured}/${t.usageEvents} event${t.usageEvents === 1 ? '' : 's'}`
    : `${t.events} events · ${report.span.sessions} session(s) · ${src}` +
      (t.partialMeasured > 0 ? ` · partial usage ${t.partialMeasured}/${t.usageEvents}` : '');
  lines.push(
    ui.line({
      key: 'report',
      value: tokenValue,
      note: tokenNote,
      keyWidth,
    })
  );
  if (report.span.from) {
    lines.push(
      ui.line({ key: 'span', value: `${report.span.from} ${ui.arrow} ${report.span.to}`, keyWidth })
    );
  }

  lines.push('');
  if (!report.sinks.length) {
    const partialOnly = t.usageEvents > 0;
    lines.push(ui.line({
      key: 'sinks',
      value: partialOnly ? 'no complete token totals' : 'none yet',
      note: partialOnly
        ? 'partial usage remains available in the session coverage below'
        : 'run some harness commands, then report',
      keyWidth,
    }));
    const sessionStateDir = !partialOnly && report.copilotHome ? path.join(report.copilotHome, 'session-state') : null;
    const vscodeUsage = report.copilotHome ? path.join(report.copilotHome, 'host-usage', 'vscode.jsonl') : null;
    const countSessions = (dir) => {
      try {
        return fs.readdirSync(dir).length;
      } catch {
        return null;
      }
    };
    const hostSessions = sessionStateDir ? countSessions(sessionStateDir) : null;
    if (!partialOnly) {
      lines.push('');
      lines.push(ui.line({ key: 'looked in', value: `workspace ${report.workspace}`, note: 'harness event store (.harness) — run report from the instrumented workspace, or use --global for all synced workspaces', keyWidth }));
      lines.push(
        ui.line({
          key: '',
          value: `copilot home ${report.copilotHome ?? '(unresolved)'}`,
          note:
            hostSessions == null
              ? 'session-state missing — set COPILOT_HOME if Copilot stores sessions elsewhere on this machine'
              : `session-state present · ${hostSessions} session dir(s)`,
          keyWidth,
        })
      );
      if (vscodeUsage) {
        lines.push(
          ui.line({
            key: '',
            value: `vscode usage ${vscodeUsage}`,
            note: fs.existsSync(vscodeUsage) ? 'present' : 'absent — the VS Code emitter hook has not written host usage here',
            keyWidth,
          })
        );
      }
    }
  } else {
    lines.push(ui.line({ key: 'sinks', value: `${report.sinks.length} event type(s)`, keyWidth }));
    const max = report.sinks[0].tokens;
    const pad = Math.max(...report.sinks.map((s) => s.type.length));
    const numPad = Math.max(...report.sinks.map((s) => fmtGroup(s.tokens).length));
    for (const s of report.sinks) {
      lines.push(
        `  ${s.type.padEnd(pad)}  ${fmtGroup(s.tokens).padStart(numPad)}  ${bar(s.tokens, max, ui)}  ` +
          ui.paint('muted', `n=${s.count} avg=${fmtGroup(s.avg)}`)
      );
    }
  }

  lines.push(...renderSessionPerformance(report, ui, keyWidth));

  const k = report.slos?.knowledge;
  if (k && !(k.surfaced === 0 && k.consolidations === 0)) {
    lines.push('');
    lines.push(
      ui.line({
        state: k.utilizationWeighted !== null && k.utilizationWeighted < 0.15 && k.surfacedOccurrences >= 20 ? 'warn' : 'ok',
        key: 'knowledge',
        value: `utilization ${fmtPct(k.utilization)} unique · ${fmtPct(k.utilizationWeighted)} weighted (${k.citedSurfaced}/${k.surfaced} surfaced)`,
        note: `engagement ${k.engagement ?? '-'} human actions/${k.consolidations} consolidations`,
        keyWidth,
      })
    );
    const kt = report.slos?.knowledgeTokens;
    if (kt && !(kt.injectedTokens === 0 && kt.orientsWithLearnings === 0 && kt.consolidations === 0)) {
      lines.push(
        ui.paint(
          'muted',
          `  ~${fmtGroup(kt.injectedTokens)} tok injected across ${kt.orientsWithLearnings} orients · ${kt.consolidations} consolidations`
        )
      );
    }
  }

  const f = report.flags;
  const flagLines = [];
  for (const b of f.budgetBreaches) {
    flagLines.push(
      ui.line({ state: 'warn', key: 'budget', value: `${b.kind} ${b.target} = ${b.value}`, note: `cap ${b.cap}`, keyWidth })
    );
  }
  for (const loop of f.recoveryLoops) {
    flagLines.push(
      ui.line({
        state: 'warn',
        key: 'recovery',
        value: `session ${loop.session} · ${loop.blocks} blocks`,
        note: `~${fmtGroup(loop.burned)} tokens burned`,
        keyWidth,
      })
    );
  }
  if (f.trend?.regressed) {
    flagLines.push(
      ui.line({
        state: 'warn',
        key: 'trend',
        value: `tokens/session rising · ${fmtGroup(f.trend.earlier)} ${ui.arrow} ${fmtGroup(f.trend.recent)}`,
        note: `${f.trend.ratio}× over ${f.trend.sessions} sessions`,
        keyWidth,
      })
    );
  }
  lines.push('');
  if (flagLines.length) lines.push(...flagLines);
  else lines.push(ui.line({ key: 'flags', value: 'none', keyWidth }));
  return lines.join('\n');
}

/** True when any budget cap is breached (for `--check` / CI use). */
export function hasBudgetBreach(report) {
  return report.flags.budgetBreaches.length > 0;
}
