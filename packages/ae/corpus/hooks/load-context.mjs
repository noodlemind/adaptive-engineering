#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { planDisplayPath, planRoots } from './lib/external-plans.mjs';
import { resolveHookWorkspace } from './lib/tool-payload.mjs';
import { unwrapOrientSlice } from './lib/orient-slice.mjs';
import { nodeAuthority } from './lib/authority-bin.mjs';

function emptyOrientSlice() {
  return {
    neighborhood: null,
    graph: null,
    intentSources: [],
    intentDiscovery: null,
    intentDetail: null,
    verification: { state: 'unknown', path: null, warnings: [] },
    planGoal: null,
    trust: null,
    checkReadiness: null,
    reviewCoverage: null,
    learnings: [],
    skills: [],
    procedure: { id: null, reason: null },
    instructions: [],
    contacts: [],
    index: { knowledge: 'missing', structural: 'missing' },
    gateStatus: 'blocked',
    activePlan: null,
    layout: {
      boundRoot: null,
      projectStore: null,
      kind: 'unknown',
      markers: [],
      workspaceType: 'none',
      workspaceFile: null,
      roots: [],
      domainSuggestion: null,
    },
  };
}

function orientSlice(workspace) {
  const node = nodeAuthority();
  if (!node) return emptyOrientSlice();
  const args = [
    ...node.args,
    'orient',
    '--read',
    '--context-version',
    '2',
    '--json',
    '--no-events',
    '--workspace',
    workspace,
  ];
  const res = spawnSync(node.command, args, {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 8000,
    env: process.env,
  });
  if (!res || res.error || res.status !== 0 || !res.stdout) return emptyOrientSlice();
  try {
    return unwrapOrientSlice(JSON.parse(res.stdout), emptyOrientSlice());
  } catch {
    return emptyOrientSlice();
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parsePlanFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

function planPriority(fm) {
  let score = 0;
  if (fm.plan_lock === 'true') score += 10;
  if (fm.status === 'in-progress') score += 5;
  if (fm.status === 'planned') score += 2;
  return score;
}

function findActivePlan(workspace) {
  const sessionPath = path.join(workspace, '.harness', 'session.json');
  if (fs.existsSync(sessionPath)) {
    try {
      const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      if (typeof session.activePlan === 'string' && session.activePlan) return session.activePlan;
    } catch {
      /* ignore */
    }
  }

  const candidates = [];
  for (const root of planRoots(workspace)) {
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.md') || name.startsWith('_') || name === 'README.md') continue;
      const full = path.join(root, name);
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const fm = parsePlanFrontmatter(text);
      if (fm.status === 'done') continue;
      candidates.push({ display: planDisplayPath(workspace, full), fm });
    }
  }
  candidates.sort((a, b) => {
    const score = planPriority(b.fm) - planPriority(a.fm);
    if (score !== 0) return score;
    if (a.display < b.display) return -1;
    if (a.display > b.display) return 1;
    return 0;
  });
  return candidates[0]?.display || null;
}

const raw = readStdin();
let workspace = process.cwd();
try {
  const payload = raw ? JSON.parse(raw) : {};
  workspace = resolveHookWorkspace(payload);
} catch {
  /* use cwd */
}

const parts = [
  'When @engineer is active, start every reply `Mode: Answer|Investigate|Review|Deliver` — mode selection is the intake router for every request. Follow the Investigate contract in engineer.agent.md. Report evidence, impact, confidence, recommendation, and Capture for Later / Plan and Fix / Leave in Chat.',
  'When a Deliver mutation is denied missing-implement-gate, read <copilot-home>/skills/ensure-plan/SKILL.md with the host read tool. A not-truncated read of that SKILL.md is activation. Create or lock only the canonical plan in a standalone mutation with no product paths, pass the standalone implement gate, then retry the product mutation and verify.',
  'Before planning or editing a skill, agent, instruction, check, reference, or solution, read <copilot-home>/skills/create-primitive/SKILL.md with the host read tool and follow it. A not-truncated read of that SKILL.md is activation. A plan label is not skill activation.',
  'During Deliver verification, run only checks named in the plan verification.required list. Report unrelated check failures; do not repair them or expand Impacted Files for them.',
];
const pack = path.join(workspace, '.harness', 'context-pack.md');
if (fs.existsSync(pack)) {
  parts.push(`Read harness context pack: .harness/context-pack.md`);
}
const plan = findActivePlan(workspace);
if (plan) {
  parts.push(`Active plan candidate: ${plan}`);
}
const agentCtx = [
  path.join(workspace, 'docs', 'agent-context.md'),
  path.join(workspace, '.harness', 'agent-context.md'),
].find((p) => fs.existsSync(p));
if (agentCtx) {
  parts.push(`Project conventions: ${path.relative(workspace, agentCtx).replace(/\\/g, '/')}`);
}

const message = `[harness hooks] Session context:\n- ${parts.join('\n- ')}`;
let routingNote = '';
if (fs.existsSync(pack)) {
  const packText = fs.readFileSync(pack, 'utf8');
  const start = packText.indexOf('\n## Routing');
  if (start !== -1) {
    const rest = packText.slice(start + 1);
    const next = rest.indexOf('\n## ');
    routingNote = (next === -1 ? rest : rest.slice(0, next)).trim();
  }
}
const contextBody = routingNote
  ? `${message}\n\nRouting pointers apply only when the mode is Deliver:\n${routingNote}`
  : message;
const additionalContext = `${contextBody}\nharness-orient-slice: ${JSON.stringify(orientSlice(workspace))}`;
console.log(JSON.stringify({
  additionalContext,
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext,
  },
}));
