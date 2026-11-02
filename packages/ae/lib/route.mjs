import fs from 'node:fs';
import path from 'node:path';
import { getCorpusRoot } from './assets.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { createStyle } from './style.mjs';
import { loadPlan } from './plan-parse.mjs';
import { parseImpactedFiles } from './plan-scope.mjs';
import { isPrimitivePath } from './primitive-governance.mjs';
import { projectAuthorityFile } from './project-authority.mjs';
import { isProjectTrusted } from './trust.mjs';
import {
  ID_RE,
  collectIds,
  loadRoutingPolicy,
  parseRoutingPolicy,
  ruleMatches,
} from './routing-policy.mjs';

const RELATIVE = Object.freeze({
  skills: (id) => path.join('skills', id, 'SKILL.md'),
  instructions: (id) => path.join('instructions', `${id}.instructions.md`),
  agents: (id) => path.join('agents', `${id}.agent.md`),
});

export function discoverInventory(roots) {
  const inventory = { skills: new Map(), instructions: new Map(), agents: new Map() };
  for (const root of roots.filter(Boolean)) {
    if (!fs.existsSync(root)) continue;
    for (const kind of Object.keys(inventory)) {
      const dir = path.join(root, kind === 'skills' ? 'skills' : kind);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const id = kind === 'skills' ? name : name.replace(/\.(agent|instructions)\.md$/, '');
        if (!ID_RE.test(id) || inventory[kind].has(id)) continue;
        const rel = RELATIVE[kind](id);
        const found = containedFile(root, rel);
        if (found) inventory[kind].set(id, found);
      }
    }
  }
  if (process.env.AE_SKILLS_HOME) {
    const selected = path.resolve(process.env.AE_SKILLS_HOME);
    inventory.skills.clear();
    if (fs.existsSync(selected)) for (const id of fs.readdirSync(selected)) {
      if (!ID_RE.test(id)) continue;
      const file = containedFile(selected, path.join(id, 'SKILL.md'));
      if (file) inventory.skills.set(id, file);
    }
  }
  return inventory;
}

function containedFile(root, rel) {
  const full = path.resolve(root, rel);
  if (!fs.existsSync(full)) return null;
  let realRoot;
  let realFile;
  try {
    realRoot = fs.realpathSync(root);
    realFile = fs.realpathSync(full);
  } catch {
    return null;
  }
  const relative = path.relative(realRoot, realFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return realFile;
}

export function emptySnapshot(reason) {
  return {
    version: 1,
    skills: { required: [], optional: [] },
    instructions: [],
    specialists: { required: [], consult_if: [] },
    skipped: true,
    reason,
  };
}

export function evaluateRouting({ policyText, policy, impacted = [], risk = 'green', domains = [], primitive = false, planLock = false, inventory }) {
  const loaded = policy ? { missing: false, policy, errors: [] } : policyText ? parseRoutingPolicy(policyText) : { missing: true, policy: null, errors: [] };
  if (loaded.missing) return { ok: true, errors: [], snapshot: emptySnapshot('missing policy') };
  if (loaded.errors.length || !loaded.policy) return { ok: false, errors: loaded.errors, snapshot: null };

  const ids = collectIds(loaded.policy);
  const errors = [];
  for (const [kind, values] of Object.entries(ids)) {
    for (const id of values) {
      if (!inventory?.[kind]?.has(id)) errors.push(`unknown ${kind.replace(/s$/, '')} id: ${id}`);
    }
  }
  if (errors.length) return { ok: false, errors, snapshot: null };

  const input = { impacted, risk, domains, primitive, planLock };
  const skills = [];
  const instructions = [];
  const specialists = [];
  for (const rule of loaded.policy.skills || []) if (ruleMatches(rule, input)) pushUnique(skills, rule.skill);
  for (const rule of loaded.policy.instructions || []) if (ruleMatches(rule, input)) pushUnique(instructions, rule.instruction);
  for (const rule of loaded.policy.specialists || []) if (ruleMatches(rule, input)) pushUnique(specialists, rule.agent);

  if (skills.length + instructions.length + specialists.length === 0) {
    return { ok: true, errors: [], snapshot: emptySnapshot('no matching rule') };
  }
  return {
    ok: true,
    errors: [],
    snapshot: {
      version: 1,
      skills: { required: skills, optional: [] },
      instructions,
      specialists: { required: specialists, consult_if: [] },
      skipped: false,
    },
  };
}

function pushUnique(list, id) {
  if (!list.includes(id)) list.push(id);
}

export function validateRoutingSnapshot(routing) {
  if (routing === undefined || routing === null) return { legacy: true, ok: true, errors: [] };
  const errors = [];
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) return { legacy: false, ok: false, errors: ['routing must be a mapping'] };
  if (routing.version !== 1) errors.push('routing.version must be 1');
  const requiredSkills = routing.skills?.required;
  const optionalSkills = routing.skills?.optional;
  if (!Array.isArray(requiredSkills) || !Array.isArray(optionalSkills)) errors.push('routing.skills.required and optional must be lists');
  if (!Array.isArray(routing.instructions)) errors.push('routing.instructions must be a list');
  if (!Array.isArray(routing.specialists?.required) || !Array.isArray(routing.specialists?.consult_if)) {
    errors.push('routing.specialists.required and consult_if must be lists');
  }
  for (const id of [...(requiredSkills || []), ...(optionalSkills || []), ...(routing.instructions || []), ...(routing.specialists?.required || []), ...(routing.specialists?.consult_if || [])]) {
    if (!ID_RE.test(String(id))) errors.push(`routing contains an invalid id: ${id}`);
  }
  if (typeof routing.skipped !== 'boolean') errors.push('routing.skipped must be boolean');
  else if (routing.skipped && (typeof routing.reason !== 'string' || !routing.reason.trim())) errors.push('a skipped snapshot needs a reason');
  else if (!routing.skipped && routing.reason !== undefined) errors.push('a matched snapshot has no reason');
  return { legacy: false, ok: errors.length === 0, errors };
}

function idList(ids) {
  return Array.isArray(ids) ? ids : [];
}

export function routingReadPointers(snapshot, inventory) {
  if (!snapshot || snapshot.skipped) return snapshot?.reason ? [`skipped: ${snapshot.reason}`] : [];
  const lines = [];
  for (const id of idList(snapshot.skills?.required)) lines.push(pointer(inventory, 'skills', id));
  for (const id of idList(snapshot.instructions)) lines.push(pointer(inventory, 'instructions', id));
  for (const id of idList(snapshot.specialists?.required)) lines.push(pointer(inventory, 'agents', id));
  return lines.filter(Boolean);
}

export function routingCards(snapshot, inventory) {
  if (!snapshot || snapshot.skipped) return { skills: [], instructions: [], contacts: [] };
  return {
    skills: idCards(snapshot.skills?.required, inventory, 'skills'),
    instructions: idCards(snapshot.instructions, inventory, 'instructions'),
    // Specialist ids have no condition text on the snapshot.
    contacts: idCards(snapshot.specialists?.required, inventory, 'agents').map((card) => ({ ...card, when: null })),
  };
}

function idCards(ids, inventory, kind) {
  return idList(ids).map((id) => ({ id, path: inventory?.[kind]?.get(id) || null }));
}

function pointer(inventory, kind, id) {
  const full = inventory?.[kind]?.get(id);
  return full ? `read ${full}` : `unavailable ${kind.replace(/s$/, '')} ${id}`;
}

export function primitiveReadRoots(copilotHome) {
  const roots = [];
  if (copilotHome) roots.push(copilotHome);
  try {
    roots.push(getCorpusRoot());
  } catch {
    // A missing corpus must not stop policy evaluation.
  }
  return roots;
}

export function routeWorkspace({ workspace, impacted, risk, domains, primitive, planLock, roots, copilotHome }) {
  const policyPath = projectAuthorityFile(workspace, 'routing.yaml').path;
  if (fs.existsSync(policyPath) && !isProjectTrusted({ workspace, copilotHome, home: process.env.HARNESS_HOME })) {
    return { ok: true, errors: [], snapshot: emptySnapshot('project is not trusted') };
  }
  const loaded = loadRoutingPolicy(workspace);
  if (loaded.missing) return { ok: true, errors: [], snapshot: emptySnapshot('missing policy') };
  if (loaded.errors.length) return { ok: false, errors: loaded.errors, snapshot: null };
  const inventory = discoverInventory(roots || primitiveReadRoots(copilotHome));
  return evaluateRouting({
    policy: loaded.policy,
    impacted,
    risk,
    domains,
    primitive: primitive ?? impacted.some(isPrimitivePath),
    planLock,
    inventory,
  });
}

export async function cmdRoute(argv) {
  const planFlag = argv.indexOf('--plan');
  if (planFlag < 0 || !argv[planFlag + 1]) throw new Error('route: --plan is required');
  const workspaceFlag = argv.indexOf('--workspace');
  const workspace = path.resolve(workspaceFlag >= 0 ? argv[workspaceFlag + 1] : process.cwd());
  const plan = loadPlan(workspace, argv[planFlag + 1]);
  if (!plan) throw new Error('route: plan not found');
  const snapshotCheck = validateRoutingSnapshot(plan.fm.routing);
  const homeFlag = argv.indexOf('--copilot-home');
  const live = routeWorkspace({
    workspace,
    copilotHome: resolveCopilotHome(homeFlag >= 0 ? argv[homeFlag + 1] : undefined),
    impacted: parseImpactedFiles(plan),
    risk: plan.risk || 'green',
    domains: Array.isArray(plan.fm.domains) ? plan.fm.domains : [],
    primitive: parseImpactedFiles(plan).some(isPrimitivePath),
    planLock: false,
  });
  const body = {
    plan: plan.path,
    snapshot: plan.fm.routing || null,
    snapshotOk: snapshotCheck.ok,
    snapshotErrors: snapshotCheck.errors,
    live: live.ok ? live.snapshot : null,
    liveErrors: live.errors,
  };
  if (argv.includes('--json')) console.log(JSON.stringify(body));
  else {
    const ui = createStyle();
    console.log(ui.line({ state: snapshotCheck.ok ? 'ok' : 'error', key: 'route', value: plan.path }));
    console.log(ui.paint('muted', JSON.stringify(body.snapshot)));
  }
  if (snapshotCheck.legacy) return live.ok ? 0 : 1;
  return snapshotCheck.ok ? 0 : 1;
}
