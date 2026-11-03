import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { randomUUID } from 'node:crypto';
import { bindPlaybook } from './playbook-binding.mjs';
import { createStyle } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { loadConfiguredChecks, validatePlanReadiness } from './plan-readiness.mjs';
import { assertNoPersonalWrite, isPrimitivePath } from './primitive-governance.mjs';
import { plansWriteTarget } from './project-layout.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { ensureHarnessDir } from './session.mjs';
import { applyClassification, readClassification } from './classification.mjs';
import { ensureIndexes } from './ensure-indexes.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { loadPlan, planFromText } from './plan-parse.mjs';
import { parseImpactedFiles } from './plan-scope.mjs';
import { emptySnapshot, routeWorkspace } from './route.mjs';
import { shortPlanDocument } from './plan-record.mjs';
import { bindLockedIntentSources, lockIntentSources } from './intent-sources.mjs';
import { planRevision, scopePaths, applyPlanNotes, renderPlanPhases, planState } from './plan-decisions.mjs';
import { readBoundedInput, readFileNoFollow, writeFileContainedExclusive } from './fs-safe.mjs';
import { locateVerification } from './verification-location.mjs';
import { authorizeDomainPlan, authorizeProjectPlan, validateDomainContext, domainPlanPath } from './domain-context.mjs';
import { domainLinkCheck } from './domain-delivery.mjs';
import { validatePlanSchema } from './plan-schema.mjs';
import { parseExperimentJson, validateExperimentContract } from './experiment-contract.mjs';

const TYPES = ['feat', 'fix', 'docs', 'refactor', 'chore'];
const RISKS = ['green', 'amber', 'red'];
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function shortSlug(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 48)
    .replace(/^-+|-+$/g, '');
  if (!SLUG_RE.test(slug)) throw new Error('plan-new: --slug is required and must be lowercase-hyphen (a-z0-9-)');
  return slug;
}

function warnIndexPlanes(report) {
  const lines = [];
  if (!report || report.error) lines.push(report?.error || 'index refresh failed');
  else {
    for (const plane of ['knowledge', 'structural']) {
      const item = report[plane];
      if (item?.attempted && !item.ok) lines.push(`${plane}: ${item.error || 'failed'}`);
    }
  }
  for (const line of lines) process.stderr.write(`index  ${line}\n`);
}

function scalar(value, name, { multiline = false, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`plan-new: --${name} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || value.includes('\0') || (!multiline && /[\r\n]/.test(value))) {
    throw new Error(`plan-new: --${name} must be a ${multiline ? 'text' : 'single-line'} scalar`);
  }
  if (required && !value.trim()) throw new Error(`plan-new: --${name} is required`);
  return value;
}

function classify(primitivePath) {
  const normalized = String(primitivePath || '').replace(/\\/g, '/');
  if (/^packages\/(?:ae|harness)\/corpus\/skills\//.test(normalized)) return 'skill';
  if (/^packages\/(?:ae|harness)\/corpus\/agents\//.test(normalized)) return 'agent';
  if (/^packages\/(?:ae|harness)\/corpus\/instructions\//.test(normalized)) return 'instruction';
  if (/^\.github\/checks\//.test(normalized)) return 'check';
  if (normalized === 'packages/ae/corpus/knowledge/capability-registry.yaml') return 'capability registry';
  if (/^packages\/(?:ae|harness)\/corpus\/enterprise\//.test(normalized)) return 'enterprise';
  return 'primitive';
}

export function buildPlanSkeleton({
  type = 'feat',
  slug,
  title,
  intent,
  date,
  impacted = [],
  criteria = [],
  gap = null,
  risk = 'green',
  status,
  check,
  plansRel = 'docs/plans',
  plansBase = null,
  routing = null,
  domains = [],
  playbook = null,
  intentSources = [],
  constraints = [],
  notes = {},
  phases,
  outputs,
  skillsUsed = [],
  verificationRecipe = null,
  copilotHome = null,
  planId = null,
  planSchema = 2,
  domainParent = null,
  domainChild = null,
  domainBinding = null,
  experiment = null,
} = {}) {
  const draft = ['open', 'needs-info'].includes(status);
  assertNoPersonalWrite([...(impacted || []), gap?.primitive]);
  scalar(slug, 'slug', { required: true });
  scalar(title, 'title');
  scalar(intent, 'intent', { multiline: true, required: true });
  scalar(type, 'type', { required: true });
  scalar(risk, 'risk', { required: true });
  scalar(status, 'status');
  scalar(check, 'check', { required: !draft });
  if (!slug || !SLUG_RE.test(slug)) throw new Error('plan-new: --slug is required and must be lowercase-hyphen (a-z0-9-)');
  if (!TYPES.includes(type)) throw new Error(`plan-new: --type must be one of ${TYPES.join('|')}`);
  if (!RISKS.includes(risk)) throw new Error(`plan-new: --risk must be one of ${RISKS.join('|')}`);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('plan-new: date must be YYYY-MM-DD');
  for (const value of impacted) scalar(value, 'impacted', { required: true });
  for (const value of criteria) scalar(value, 'criteria', { multiline: true, required: true });
  if (gap) {
    scalar(gap.id, 'gap', { required: true });
    scalar(gap.primitive, 'gap', { required: true });
  }

  const fileName = `${date}-${type}-${slug}-plan.${planSchema >= 3 ? 'hplan' : 'md'}`;
  const rel = plansBase ? path.join(plansBase, plansRel, fileName) : `${plansRel}/${fileName}`;
  const impactedList = impacted.length ? impacted.slice() : gap?.primitive ? [gap.primitive] : [];
  const primitive = impactedList.some(isPrimitivePath) || isPrimitivePath(gap?.primitive);
  const finalStatus = status || (gap ? 'blocked-capability' : 'in-progress');
  const acs = (criteria.length ? criteria : [`${intent} is delivered`]).map((text, i) => ({ id: `AC${i + 1}`, text }));
  const skills = [...new Set(['engineer', ...skillsUsed])];
  const heading = title || slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const frontmatter = {
    plan_schema: planSchema,
    plan_id: planId || randomUUID(),
    ...(domainParent ? { domain_parent: domainParent } : {}),
    ...(domainChild ? { domain_child: domainChild } : {}),
    ...(domainBinding ? { domain_binding: domainBinding } : {}),
    ...(experiment ? { experiment } : {}),
    intent_source_policy: 'content-v1',
    title: heading,
    type,
    status: finalStatus,
    plan_lock: !draft,
    phase: draft ? 0 : 1,
    risk,
    intent,
    expected_outputs: outputs || [`${slug} delivered`],
    success_criteria: [intent],
    verification: {
      ...(verificationRecipe ? { recipe: verificationRecipe } : {}),
      required: check ? [check] : [],
      criteria: Object.fromEntries(acs.map((ac) => [ac.id, check ? [check] : []])),
    },
    reviews: { required: type === 'docs' ? [] : ['code-review'], completed: [], critical_open: [] },
    skills_used: skills,
    ...(routing ? { routing } : {}),
    ...(domains?.length ? { domains } : {}),
    ...(playbook ? { playbook, playbook_binding: bindPlaybook(playbook, { copilotHome }) } : {}),
    ...(planSchema >= 3 || intentSources?.length ? { intent_sources: intentSources } : {}),
    capability_gaps: gap
      ? [{ id: gap.id, class: 'hard', fulfillment: 'proposed', primitive: gap.primitive }]
      : [],
  };

  const governanceSection = primitive
    ? `\n## Primitive Governance\n\n- Primitive classification: ${classify(impactedList.find(isPrimitivePath) || gap?.primitive || '')}\n- Existing-capability overlap analysis: reviewed existing primitives; none cover this need (refine with specifics).\n- Intended artifact structure: \`${impactedList.find(isPrimitivePath) || gap?.primitive}\` with frontmatter and body per the template.\n- Trigger and negative-trigger implications: triggers on this workflow; does not trigger for unrelated edits (refine).\n- Verification expectations: ${check} confirms the artifact is well-formed.\n- Registry and documentation impact: update the inventory; no registry entry needed unless externally shared (refine).\n`
    : '';

  const impactedLines = domainParent ? 'The coordinator grants no product file edits.' : impactedList.length ? impactedList.map((f) => `- \`${f}\``).join('\n') : '- `TODO: add the files this plan will change`';
  const acLines = acs.map((ac) => `- [ ] **${ac.id}** ${ac.text}`).join('\n');

  let content = `---
${YAML.stringify(frontmatter, { lineWidth: 0 })}---

# ${heading}

## Overview

${intent}

## Context

Pending authored context.

## Intent Contract

- Goal: ${intent}

## Memory Cards

Pending relevance assessment through recall.

## Acceptance Criteria

${acLines}
${constraints.length ? `\n## Constraints\n\n${constraints.map(value => `- ${scalar(value, 'constraint', { required: true })}`).join('\n')}\n` : ''}
${governanceSection}
## Technical Notes

Pending implementation reasoning.

## Plan

${renderPlanPhases(phases || [{ title: 'Implementation', tasks: [acs[0].text.replace(/[\r\n]+/g, ' ')] }])}

## Research Notes

Pending research when the task requires it.

## Impacted Files

${impactedLines}

## Verification Plan

${check ? `- Named check \`${check}\` binds the acceptance criteria.` : '- Pending named check selection.'}

## Risk & Review Routing

- ${risk.charAt(0).toUpperCase() + risk.slice(1)}.

## Implementation Notes

Implementation has not started.

## Review Findings

- None.

## Activity

- ${date} Scaffolded by \`ae plan-new\`.${gap ? ` Blocked on the ${gap.id} capability gap.` : ''}
`;
  content = applyPlanNotes(content, notes);

  return { path: rel, content };
}

export function createFullPlan({ workspace, home = harnessGlobalHome(), domainContext = null, decision, planId = null, copilotHome = null, dryRun = false }) {
  if (!decision || decision.format !== 'full' || decision.version !== 1 || !Array.isArray(decision.acceptance) || !decision.acceptance.length) throw new Error('plan-new: full authored creation decision required');
  const parent = decision.domain_parent, child = decision.domain_child;
  const extended = Boolean(parent || child || decision.domain_binding);
  if (parent && decision.status !== undefined && decision.status !== 'planned') throw new Error('plan-new: accepted domain parents are created locked in planned state');
  if (extended && (Boolean(parent) === Boolean(child) || !decision.domain_binding || !planId)) throw new Error('plan-new: domain plans require one authority, a binding and reserved UUID');
  const target = parent ? { base: validateDomainContext(domainContext, workspace).root, dirRel: 'plans' } : plansWriteTarget(workspace, { home });
  const generated = buildPlanSkeleton({
    type: decision.type || 'feat', slug: decision.slug || shortSlug(decision.goal), title: decision.title, intent: decision.goal,
    date: decision.date || new Date().toISOString().slice(0, 10), impacted: decision.scope || [], criteria: decision.acceptance,
    risk: decision.risk || 'green', status: decision.status || (parent ? 'planned' : 'open'), check: decision.check, constraints: decision.constraints || [],
    notes: decision.notes || {}, phases: decision.phases, outputs: decision.outputs, skillsUsed: decision.skillsUsed || [],
    playbook: decision.playbook, verificationRecipe: decision.verificationRecipe, copilotHome,
    plansBase: target.base, plansRel: target.dirRel, planId, planSchema: decision.experiment ? 4 : extended ? 3 : 2,
    domainParent: parent, domainChild: child, domainBinding: decision.domain_binding,
    experiment: decision.experiment,
    intentSources: bindLockedIntentSources(workspace, decision.intentSources || [], { query: decision.goal }),
  });
  let plan = planFromText(generated.content, { path: generated.path, fullPath: generated.path });
  if (parent) { domainPlanPath(domainContext, generated.path); plan = authorizeDomainPlan(domainContext, plan); }
  else plan = authorizeProjectPlan(plan, home);
  const schema = validatePlanSchema(plan);
  if (!schema.pass) throw new Error(`plan-new: ${schema.checks.filter(check => !check.pass).map(check => check.message).join('; ')}`);
  if (parent) {
    const coordinator = domainLinkCheck({ workspace, plan, copilotHome, home });
    if (!coordinator.pass) throw new Error(`plan-new: ${coordinator.message}`);
  }
  if (!dryRun) {
    fs.mkdirSync(target.base, { recursive: true });
    if (!writeFileContainedExclusive(target.base, path.relative(target.base, generated.path), generated.content)) throw new Error('plan-new: destination exists or is unsafe');
  }
  return { plan, path: generated.path, revision: planRevision(generated.content), created: !dryRun };
}

/** CLI: parse the plan-new flags, write the skeleton, print the path. */
export async function cmdPlanNew(argv) {
  const opts = { impacted: [], criteria: [], acceptance: [], constraints: [], intentSources: [] };
  let workspace = process.cwd();
  let json = false;
  let dryRun = false;
  let toStdout = false;
  let file;

  // Fix-wave C1: honor the literal-argument boundary, matching
  // lib/flags.mjs#parseFlags and lib/registry.mjs#validateArgs — nothing after
  // a bare `--` is ever interpreted as a flag. Sliced BEFORE the loop, not
  // broken out of inside it, for the exact reason parseFlags gives: a mid-loop
  // `break` cannot stop a value flag from having already consumed the literal
  // `--` via `next()`. Verified pre-fix: `--workspace -- --json` resolved the
  // workspace to `--` AND then re-interpreted the post-boundary `--json`.
  const boundary = argv.indexOf('--');
  const scan = boundary === -1 ? argv : argv.slice(0, boundary);
  for (let i = 0; i < scan.length; i++) {
    const a = scan[i];
    const next = () => scan[++i];
    if (a === '--type') opts.type = next();
    else if (a === '--file' || a.startsWith('--file=')) {
      file = a === '--file' ? next() : a.slice('--file='.length);
      if (!file) throw new Error('plan-new: --file requires a path or - for stdin');
    }
    else if (a === '--slug') opts.slug = next();
    else if (a === '--title') opts.title = next();
    else if (a === '--intent') opts.intent = next();
    else if (a === '--goal') opts.goal = next();
    else if (a === '--acceptance') opts.acceptance.push(next());
    else if (a === '--constraint') opts.constraints.push(next());
    else if (a === '--date') opts.date = next();
    else if (a === '--risk') opts.risk = next();
    else if (a === '--status') opts.status = next();
    else if (a === '--verification-check') opts.check = next();
    else if (a === '--impacted') opts.impacted.push(...String(next() || '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--criteria') opts.criteria.push(String(next() || '').trim());
    else if (a === '--intent-source') opts.intentSources.push(String(next() || '').trim());
    else if (a === '--gap') {
      const raw = String(next() || '');
      const idx = raw.indexOf(':');
      if (idx < 0) throw new Error('plan-new: --gap must be <id>:<primitive-path>');
      opts.gap = { id: raw.slice(0, idx), primitive: raw.slice(idx + 1) };
    } else if (a === '--from') opts.from = next();
    else if (a === '--classification') opts.classification = next();
    else if (a === '--copilot-home') opts.copilotHome = next();
    else if (a === '--workspace' || a.startsWith('--workspace=')) {
      const value = a === '--workspace' ? next() : a.slice('--workspace='.length);
      if (!value || value.startsWith('--')) throw new Error('plan-new: --workspace requires a path');
      workspace = path.resolve(value);
    }
    else if (a === '--json') json = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--stdout') toStdout = true;
  }

  if (file) {
    if (Object.keys(opts).some(key => !['impacted', 'criteria', 'acceptance', 'constraints', 'intentSources', 'copilotHome'].includes(key)) || [opts.impacted, opts.criteria, opts.acceptance, opts.constraints, opts.intentSources].some(values => values.length)) throw new Error('plan-new: --file cannot be combined with authoring flags');
    const raw = file === '-' ? readBoundedInput() : readFileNoFollow(path.resolve(workspace, file), { maxBytes: 1024 * 1024 });
    if (file === '-' && !raw) throw new Error('plan-new: decision on stdin is missing, unreadable, or over 1 MiB');
    let input;
    try { input = parseExperimentJson(raw); } catch { throw new Error('plan-new: decision file must contain bounded JSON without duplicate keys or nonfinite values'); }
    const keys = ['version', 'format', 'slug', 'type', 'title', 'goal', 'acceptance', 'constraints', 'scope', 'check', 'intentSources', 'risk', 'status', 'notes', 'phases', 'outputs', 'skillsUsed', 'verificationRecipe', 'playbook', 'experiment'];
    if (!input || input.version !== 1 || !['full', 'short'].includes(input.format) || Object.keys(input).some(key => !keys.includes(key))) throw new Error('plan-new: unsupported creation decision schema');
    if (Object.hasOwn(input, 'experiment')) validateExperimentContract(input.experiment, { impactedFiles: input.scope });
    scalar(input.goal, 'goal', { required: true });
    if (!Array.isArray(input.acceptance) || input.acceptance.length === 0) throw new Error('plan-new: authored acceptance criteria are required');
    if (input.outputs !== undefined && (!Array.isArray(input.outputs) || input.outputs.length === 0)) throw new Error('plan-new: outputs must be a non-empty list');
    if (input.format === 'short' && ['type', 'title', 'risk', 'outputs', 'skillsUsed', 'experiment'].some(key => input[key] !== undefined)) throw new Error('plan-new: type, title, risk, outputs, skillsUsed and experiment require the full format');
    if (input.skillsUsed !== undefined && (!Array.isArray(input.skillsUsed) || !input.skillsUsed.length || !input.skillsUsed.every(value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)))) throw new Error('plan-new: skillsUsed must be a nonempty list of skill names actually loaded');
    for (const key of ['acceptance', 'constraints', 'intentSources', 'outputs']) if (input[key] !== undefined && (!Array.isArray(input[key]) || !input[key].every(value => typeof value === 'string' && value.trim()))) throw new Error(`plan-new: ${key} must be a list of text`);
    if (input.status !== undefined && !['open', 'planned', 'in-progress', 'needs-info'].includes(input.status)) throw new Error('plan-new: unsupported initial status');
    if (input.verificationRecipe !== undefined && (!input.verificationRecipe || typeof input.verificationRecipe !== 'string' || locateVerification(workspace, input.verificationRecipe).state !== 'selected')) throw new Error('plan-new: verificationRecipe requires a safe existing SKILL.md');
    Object.assign(opts, { playbook: input.playbook, verificationRecipe: input.verificationRecipe, structured: true, slug: input.slug || shortSlug(input.goal), title: input.title, check: input.check, status: input.status, impacted: input.scope ? scopePaths(input.scope) : [], constraints: input.constraints || [], intentSources: input.intentSources || [], notes: input.notes || {}, phases: input.phases, outputs: input.outputs });
    if (input.format === 'short') { opts.goal = input.goal; opts.acceptance = input.acceptance || []; }
    else { opts.type = input.type || 'feat'; opts.intent = input.goal; opts.criteria = input.acceptance || []; opts.risk = input.risk; opts.skillsUsed = input.skillsUsed || []; opts.experiment = input.experiment; opts.planSchema = input.experiment ? 4 : 2; }
  }

  if (opts.from) {
    if (opts.slug || opts.type || opts.intent || opts.gap || opts.goal !== undefined || opts.acceptance.length > 0 || opts.constraints.length > 0) {
      throw new Error('plan-new: --from cannot be combined with new-plan flags');
    }
    return relockPlan({ workspace, from: opts.from, dryRun, toStdout, json, classification: opts.classification, copilotHome: opts.copilotHome });
  }

  if (!opts.date) opts.date = new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new Error('plan-new: date must be YYYY-MM-DD');
  assertNoPersonalWrite([...(opts.impacted || []), opts.gap?.primitive]);
  if (opts.goal !== undefined) {
    if (opts.type || opts.risk || opts.status && !opts.structured) {
      throw new Error('plan-new: --goal does not take --type, --risk, or legacy --status');
    }
    const acceptance = opts.acceptance.filter((value) => typeof value === 'string' && value.trim());
    const constraints = opts.constraints.filter((value) => typeof value === 'string' && value.trim());
    if (!String(opts.goal).trim() || acceptance.length === 0 || constraints.length === 0) {
      throw new Error('plan-new: --goal requires at least one --acceptance and one --constraint');
    }
    const slug = shortSlug(opts.slug || opts.goal);
    const fileName = `${opts.date}-feat-${slug}-plan.md`;
    const plansTarget = plansWriteTarget(workspace, { home: harnessGlobalHome() });
    const full = path.join(plansTarget.base, plansTarget.dirRel, fileName);
    if (opts.check) {
      const configured = loadConfiguredChecks(workspace);
      if (configured.error) throw new Error(`plan-new: ${configured.error}`);
      const command = configured.checks?.[opts.check]?.command;
      if (!Array.isArray(command) || !command.length || !command.every(part => typeof part === 'string' && part.trim())) {
        throw new Error(`plan-new: --verification-check ${opts.check} is not an executable configured check`);
      }
    }
    const intentSources = bindLockedIntentSources(workspace, opts.intentSources, { query: opts.goal });
    let content = shortPlanDocument({ goal: opts.goal, acceptance, constraints, check: opts.check, intentSources, scope: opts.impacted, status: opts.status });
    if (opts.verificationRecipe || opts.playbook) content = content.replace(/^---\n([\s\S]*?)\n---/, (_match, source) => {
      const fm = YAML.parse(source);
      if (opts.verificationRecipe) fm.verification.recipe = opts.verificationRecipe;
      if (opts.playbook) { fm.playbook = opts.playbook; fm.playbook_binding = bindPlaybook(opts.playbook, { copilotHome: opts.copilotHome }); }
      return `---\n${YAML.stringify(fm)}---`;
    });
    content = applyPlanNotes(content, opts.notes || {});
    if (opts.phases) content += `\n## Plan\n\n${renderPlanPhases(opts.phases)}\n`;
    if (toStdout) {
      process.stdout.write(content);
      return 0;
    }
    if (!dryRun) {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      if (fs.existsSync(full)) throw new Error(`plan-new: ${full} already exists`);
      fs.writeFileSync(full, content, { encoding: 'utf8', flag: 'wx' });
    }
    if (json) console.log(redactedJson(creationResult(workspace, full, content, dryRun, opts.copilotHome)));
    else {
      const ui = createStyle();
      console.log(ui.line({ state: 'ok', key: 'plan-new', value: dryRun ? `would create ${full}` : full }));
    }
    return 0;
  }
  const plansTarget = plansWriteTarget(workspace, { home: harnessGlobalHome() });
  opts.plansBase = plansTarget.base;
  opts.plansRel = plansTarget.dirRel;
  if (!toStdout) ensureHarnessDir(workspace, dryRun);

  const configured = loadConfiguredChecks(workspace);
  if (configured.error) throw new Error(`plan-new: ${configured.error}`);
  const names = Object.entries(configured.checks || {})
    .filter(([, config]) => Array.isArray(config?.command)
      && config.command.length > 0
      && config.command.every((part) => typeof part === 'string' && part.trim().length > 0))
    .map(([name]) => name);
  const draft = ['open', 'needs-info'].includes(opts.status);
  if (names.length === 0 && !draft) {
    throw new Error(`plan-new: configure at least one named check in ${configured.source}; Engineer inspects the project tests and prepares declarations with ae checks configure --file - before generating a gate-ready plan`);
  }
  if (opts.check) {
    if (!names.includes(opts.check)) {
      throw new Error(`plan-new: --verification-check ${opts.check} is not an executable configured check; choose one of: ${names.join(', ')}`);
    }
  } else if (draft) {
    opts.check = undefined;
  } else if (names.length === 1) {
    [opts.check] = names;
  } else {
    throw new Error(`plan-new: --verification-check is required when multiple checks are configured: ${names.join(', ')}`);
  }

  const prepared = prepareRouting({
    workspace,
    impacted: opts.impacted,
    risk: opts.risk || 'green',
    domains: [],
    classification: opts.classification,
    copilotHome: resolveCopilotHome(opts.copilotHome),
  });
  opts.impacted = prepared.impacted;
  opts.risk = prepared.risk;
  opts.domains = prepared.domains;
  opts.playbook = opts.playbook || prepared.playbook;
  opts.routing = prepared.routing;
  opts.intentSources = bindLockedIntentSources(workspace, opts.intentSources, { query: opts.intent || '' });

  const { path: rel, content } = buildPlanSkeleton(opts);
  const full = path.isAbsolute(rel) ? rel : path.join(workspace, rel);
  if (opts.experiment) {
    const schema = validatePlanSchema(planFromText(content, { path: rel, fullPath: full }));
    if (!schema.pass) throw new Error(`plan-new: ${schema.checks.filter(check => !check.pass).map(check => check.message).join('; ')}`);
  }
  if (toStdout) {
    process.stdout.write(content);
    return 0;
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (fs.existsSync(full)) throw new Error(`plan-new: ${rel} already exists`);
    const indexes = await ensureIndexes({
      workspace,
      copilotHome: resolveCopilotHome(opts.copilotHome),
      mode: 'missing-or-stale',
      dryRun: false,
    }).catch((error) => ({ error: error.message }));
    warnIndexPlanes(indexes);
    if (fs.existsSync(full)) throw new Error(`plan-new: ${rel} already exists`);
    fs.writeFileSync(full, content, { encoding: 'utf8', flag: 'wx' });
  }
  // Fix-wave C2: legacy --json serializer routed through the shared
  // redacting emission boundary (lib/redact.mjs) like every other sink.
  if (json) console.log(redactedJson(creationResult(workspace, rel, content, dryRun, opts.copilotHome)));
  else {
    const ui = createStyle();
    console.log(ui.line({ state: 'ok', key: 'plan-new', value: dryRun ? `would create ${rel}` : rel }));
    console.log(ui.paint('muted', `${ui.arrow} ae gate --phase implement --plan ${rel} --json`));
  }
  return 0;
}

function creationResult(workspace, rel, content, dryRun, copilotHome) {
  const plan = planFromText(content, { path: rel, fullPath: path.resolve(workspace, rel) });
  const readiness = validatePlanReadiness(workspace, plan, { copilotHome: resolveCopilotHome(copilotHome) });
  return { path: rel, created: !dryRun, revision: planRevision(content), planState: planState(plan), missing: readiness.checks.filter(check => !check.pass).map(check => check.message), allowedNextActions: ['Read the generated plan and selected sources', 'Submit accepted amendments or a start decision'] };
}

function prepareRouting({ workspace, impacted, risk, domains, classification, copilotHome }) {
  let next = { impacted: impacted.slice(), risk, domains: domains.slice(), playbook: null, primitive: false, abstain: false };
  if (classification) {
    next = applyClassification({
      workspace,
      declaredRisk: risk,
      declaredDomains: domains,
      declaredImpacted: impacted,
      classification: readClassification(classification, workspace),
    });
  }
  if (next.abstain) next = { ...next, primitive: false, playbook: null };
  const routed = routeWorkspace({
    workspace,
    copilotHome,
    impacted: next.impacted,
    risk: next.risk,
    domains: next.domains,
    primitive: next.primitive === true || next.impacted.some(isPrimitivePath),
    planLock: false,
  });
  if (!routed.ok) throw new Error(`plan-new: ${routed.errors.join('; ')}`);
  return { ...next, routing: routed.snapshot };
}

async function relockPlan({ workspace, from, dryRun, toStdout, json, classification, copilotHome }) {
  const plan = loadPlan(workspace, from);
  if (!plan) throw new Error('plan-new: --from plan was not found');
  if (plan.fm.__parseError) throw new Error(`plan-new: --from plan frontmatter is invalid (${plan.fm.__parseError})`);
  if (Number(plan.fm.plan_schema) >= 3) throw new Error('plan-new: extended plans require an authored plan-update --file decision; legacy --from cannot relock them');
  if (plan.plan_lock) throw new Error('plan-new: --from requires an unlocked plan');
  const original = fs.readFileSync(plan.fullPath, 'utf8');
  const prepared = prepareRouting({
    workspace,
    impacted: parseImpactedFiles(plan),
    risk: plan.risk || 'green',
    domains: Array.isArray(plan.fm.domains) ? plan.fm.domains : [],
    classification,
    copilotHome: resolveCopilotHome(copilotHome),
  });
  if (plan.fm.playbook_binding && prepared.playbook && prepared.playbook !== plan.fm.playbook) throw new Error('plan-new: accepted playbook is frozen; use a workflow amendment');
  const frontmatter = {
    ...plan.fm,
    plan_lock: true,
    status: plan.fm.status === 'open' || !plan.fm.status ? 'planned' : plan.fm.status,
    risk: prepared.risk,
    routing: prepared.routing,
    ...(prepared.domains.length ? { domains: prepared.domains } : {}),
    ...(prepared.playbook ? { playbook: prepared.playbook } : {}),
  };
  if (frontmatter.playbook && !frontmatter.playbook_binding) {
    frontmatter.playbook_binding = bindPlaybook(frontmatter.playbook, { copilotHome });
    if (!frontmatter.plan_id) frontmatter.plan_id = randomUUID();
  }
  const lockedSources = frontmatter.intent_source_policy === 'content-v1' && frontmatter.intent_sources?.length
    ? lockIntentSources(workspace, frontmatter.intent_sources, { rehash: false })
    : bindLockedIntentSources(workspace, frontmatter.intent_sources, { query: typeof frontmatter.intent === 'string' ? frontmatter.intent : '' });
  if (lockedSources.length) frontmatter.intent_sources = lockedSources;
  else delete frontmatter.intent_sources;
  const content = original.replace(/^---\r?\n[\s\S]*?\r?\n---/, `---\n${YAML.stringify(frontmatter)}---`);
  if (toStdout) {
    process.stdout.write(content);
    return 0;
  }
  if (!dryRun) {
    const indexes = await ensureIndexes({
      workspace,
      copilotHome: resolveCopilotHome(copilotHome),
      mode: 'missing-or-stale',
    }).catch((error) => ({ error: error.message }));
    warnIndexPlanes(indexes);
    if (fs.readFileSync(plan.fullPath, 'utf8') !== original) throw new Error('plan-new: plan changed before relock');
    fs.writeFileSync(plan.fullPath, content, 'utf8');
  }
  if (json) console.log(redactedJson({ path: plan.path, created: !dryRun, relocked: true, revision: planRevision(content) }));
  else {
    const ui = createStyle();
    console.log(ui.line({ state: 'ok', key: 'plan-new', value: dryRun ? `would relock ${plan.path}` : plan.path }));
  }
  return 0;
}
