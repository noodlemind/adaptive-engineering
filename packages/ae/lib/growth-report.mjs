/**
 * Session-end Adaptive Engineering growth report (kernel-only, no LLM).
 * Producer is pure data; CLI/TUI only render.
 */
import path from 'node:path';
import { loadReportEvents } from './report.mjs';
import { readStoreConfig } from './knowledge/store.mjs';
import { consolidateStatus } from './knowledge/consolidate.mjs';
import { createRedactor } from './redact.mjs';

export const GROWTH_REPORT_SCHEMA = 1;

function asIdList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const id = typeof raw === 'string' ? raw : raw?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(typeof raw === 'string' ? { id } : { id, ...(raw.domain ? { domain: raw.domain } : {}) });
  }
  return out;
}

function lastOfType(events, type) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === type) return events[i];
  }
  return null;
}

function msBetween(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || tb < ta) return null;
  return tb - ta;
}

/**
 * Build a versioned growth report from workspace events + store status.
 * Missing data is null/unknown — never fabricated rates.
 */
export function buildGrowthReport({
  workspace,
  copilotHome = null,
  events = null,
  plan = null,
  home = null,
  now = () => new Date().toISOString(),
} = {}) {
  const redactor = createRedactor();
  const list = Array.isArray(events) ? events : loadReportEvents({ workspace });
  const store = readStoreConfig(workspace, { home: home || copilotHome });
  let promotion = [];
  try {
    const status = consolidateStatus({ workspace, copilotHome, home: home || copilotHome, withRecheck: false });
    promotion = (status.promotionCandidates || []).map((l) => ({
      id: l.id || l.fm?.id || l.path,
      ...(l.domain ? { domain: l.domain } : {}),
    })).filter((p) => p.id);
  } catch {
    promotion = [];
  }

  const recalled = [];
  const recalledSeen = new Set();
  const cited = [];
  const citedSeen = new Set();
  let verifyPassed = 0;
  let verifyTotal = 0;
  let compoundCompleted = 0;
  let compoundSkipped = 0;
  const compoundSkips = [];
  let lastVerifyPassAt = null;
  let lastCompoundAt = null;

  for (const e of list) {
    if (e.type === 'orient' && Array.isArray(e.learnings)) {
      for (const id of e.learnings) {
        if (!id || recalledSeen.has(id)) continue;
        recalledSeen.add(id);
        recalled.push({ id });
      }
    }
    if (e.type === 'verify') {
      verifyTotal += 1;
      if (e.result === 'pass' || e.outcome === 'passed') {
        verifyPassed += 1;
        lastVerifyPassAt = e.ts || lastVerifyPassAt;
      }
      if (Array.isArray(e.learnings)) {
        for (const id of e.learnings) {
          if (!id || citedSeen.has(id)) continue;
          citedSeen.add(id);
          cited.push({ id });
        }
      }
    }
    if (e.type === 'compound') {
      if (e.result === 'pass') {
        compoundCompleted += 1;
        lastCompoundAt = e.ts || lastCompoundAt;
      } else if (e.blockedReason || e.compoundStatus === 'skipped') {
        compoundSkipped += 1;
        if (e.blockedReason) compoundSkips.push(String(e.blockedReason));
      }
    }
  }

  const lastVerify = lastOfType(list, 'verify');
  const lastCompound = lastOfType(list, 'compound');

  let compound = { status: 'not-attempted', reason: null, plan: plan || null, at: null };
  if (lastCompound) {
    if (lastCompound.result === 'pass') {
      compound = {
        status: 'completed',
        reason: null,
        plan: lastCompound.plan || plan || null,
        at: lastCompound.ts || null,
        episodePath: lastCompound.path || null,
      };
    } else {
      compound = {
        status: 'skipped',
        reason: lastCompound.blockedReason || lastCompound.compoundStatus || 'compound did not pass',
        plan: lastCompound.plan || plan || null,
        at: lastCompound.ts || null,
      };
    }
  }

  const verify = lastVerify
    ? {
      outcome: lastVerify.outcome || lastVerify.result || null,
      evidencePath: lastVerify.evidencePath || null,
      at: lastVerify.ts || null,
      plan: lastVerify.plan || plan || null,
    }
    : { outcome: null, evidencePath: null, at: null, plan: plan || null };

  const primaryMetrics = {
    // % of verify-pass events that have a later compound pass (honest null if no pass)
    verifyPassCompoundRate: verifyPassed
      ? Number((Math.min(compoundCompleted, verifyPassed) / verifyPassed).toFixed(2))
      : null,
    // recalled → cited linkage when both present
    recallCiteRate: recalled.length
      ? Number((cited.filter((c) => recalledSeen.has(c.id)).length / recalled.length).toFixed(2))
      : null,
    verifyPassToCompoundMs: lastVerifyPassAt && lastCompoundAt
      ? msBetween(lastVerifyPassAt, lastCompoundAt)
      : null,
    promotionEligibleCount: promotion.length,
    compoundCompleted,
    compoundSkipped,
    // Secondary metrics (optional agent / fixtures) — not AE success definition
    secondary: {
      note: 'turn counts, search caps, and explore streak are optional-agent/benchmark fixtures — not Adaptive Engineering success',
    },
  };

  const report = {
    schema: GROWTH_REPORT_SCHEMA,
    workspace: path.resolve(workspace || process.cwd()),
    plan: plan || verify.plan || compound.plan || null,
    verify,
    learningsRecalled: recalled,
    learningsCited: cited,
    compound,
    promotionEligible: promotion,
    knowledgeMode: store.mode || 'on',
    metrics: primaryMetrics,
    compoundSkipReasons: compoundSkips.slice(-5),
    generatedAt: now(),
  };

  return redactor.redactValue(report);
}

export function renderGrowthReport(report, ui) {
  if (!ui) {
    // plain text fallback
    const lines = [
      `growth  schema ${report.schema}`,
      `mode    ${report.knowledgeMode}`,
      `verify  ${report.verify?.outcome ?? 'none'}`,
      `compound  ${report.compound?.status}${report.compound?.reason ? ` · ${report.compound.reason}` : ''}`,
      `recalled  ${report.learningsRecalled?.length ?? 0}`,
      `cited     ${report.learningsCited?.length ?? 0}`,
      `promote   ${report.promotionEligible?.length ?? 0}`,
    ];
    if (report.metrics?.verifyPassCompoundRate != null) {
      lines.push(`rate     verify→compound ${report.metrics.verifyPassCompoundRate}`);
    }
    if (report.metrics?.recallCiteRate != null) {
      lines.push(`rate     recall→cite ${report.metrics.recallCiteRate}`);
    }
    return lines.join('\n');
  }
  const keyWidth = 12;
  const out = [];
  out.push(ui.line({
    state: 'ok',
    key: 'growth',
    value: `schema ${report.schema}`,
    note: report.generatedAt,
    keyWidth,
  }));
  out.push(ui.line({
    key: 'mode',
    value: report.knowledgeMode,
    keyWidth,
  }));
  out.push(ui.line({
    state: report.verify?.outcome === 'passed' || report.verify?.outcome === 'pass' ? 'ok' : undefined,
    key: 'verify',
    value: report.verify?.outcome ?? 'none',
    note: report.verify?.plan || undefined,
    keyWidth,
  }));
  const c = report.compound || {};
  out.push(ui.line({
    state: c.status === 'completed' ? 'ok' : c.status === 'skipped' ? 'warn' : undefined,
    key: 'compound',
    value: c.status,
    note: c.reason || c.plan || undefined,
    keyWidth,
  }));
  out.push(ui.line({
    key: 'recalled',
    value: String(report.learningsRecalled?.length ?? 0),
    note: (report.learningsRecalled || []).slice(0, 5).map((x) => x.id).join(', ') || undefined,
    keyWidth,
  }));
  out.push(ui.line({
    key: 'cited',
    value: String(report.learningsCited?.length ?? 0),
    note: (report.learningsCited || []).slice(0, 5).map((x) => x.id).join(', ') || undefined,
    keyWidth,
  }));
  out.push(ui.line({
    key: 'promote',
    value: String(report.promotionEligible?.length ?? 0),
    note: (report.promotionEligible || []).slice(0, 5).map((x) => x.id).join(', ') || undefined,
    keyWidth,
  }));
  if (report.metrics?.verifyPassCompoundRate != null) {
    out.push(ui.line({
      key: 'v→c rate',
      value: String(report.metrics.verifyPassCompoundRate),
      note: 'primary AE metric · verify-pass runs that compound',
      keyWidth,
    }));
  }
  if (report.metrics?.recallCiteRate != null) {
    out.push(ui.line({
      key: 'r→c rate',
      value: String(report.metrics.recallCiteRate),
      note: 'recall→cite when both present',
      keyWidth,
    }));
  }
  out.push(ui.paint('muted', `  ${ui.arrow} secondary: agent turn/search caps are fixtures, not AE success`));
  return out.join('\n');
}
