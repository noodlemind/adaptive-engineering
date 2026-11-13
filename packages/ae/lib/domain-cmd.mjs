import path from 'node:path';
import YAML from 'yaml';
import { parseFlags } from './flags.mjs';
import { fileInputHint } from './argv.mjs';
import { harnessGlobalHome, resolveCopilotHome } from './paths.mjs';
import { redactedJson, createRedactor } from './redact.mjs';
import { inertLine } from './knowledge/store.mjs';
import { readDomain, inspectDomain } from './domain-contract.mjs';
import { assertNoSymlinkAncestors, canonicalPath, readBoundedInput, readFileNoFollow } from './fs-safe.mjs';
import { resolveDomainContext, validateDomainContext } from './domain-context.mjs';
import { createDomainPlans } from './domain-plans.mjs';
import { domainStatus, domainCoordinatorCheck } from './domain-delivery.mjs';
import { loadPlan } from './plan-parse.mjs';
import { updatePlanDecision, planUpdateActorCheck } from './plan-update.mjs';
import { runGate, publishGateSession } from './gate.mjs';
import { loadPolicy } from './policy.mjs';
import { prepareReview, assembleReview } from './review.mjs';
import { runVerify, exitCodeForOutcome, statusForVerifyResult } from './verify.mjs';
import { runCompound } from './compound.mjs';
import { runGet } from './get-cmd.mjs';
import { validateCompletion } from './completion.mjs';

export const DOMAIN_VERBS = Object.freeze(['show', 'status', 'get', 'plan-new', 'plan-update', 'gate', 'review', 'verify', 'compound']);
const OPTIONS = {
  show: [], status: ['--plan'], get: ['--plan', '--offset', '--lines', '--max-bytes'], 'plan-new': ['--file'], 'plan-update': ['--plan', '--file'],
  gate: ['--plan', '--phase', '--enforcement'],
  review: ['--plan', '--base', '--domain', '--reviewer', '--file', '--max-bytes', '--packet'],
  verify: ['--plan', '--base', '--enforcement'], compound: ['--plan', '--learning-decision', '--enforcement'],
};

function usage(message, hint = 'ae help domain') {
  return Object.assign(new Error(`domain: ${message}`), { code: 'E_USAGE', exit: 2, hint });
}

export function parseDomainArguments(argv) {
  const positionals = [], values = new Map(), seen = new Set();
  const boolean = new Set(['--json', '--dry-run', '--no-events', '--no-color', '--verbose', '-v', '--validate-completion']);
  const allValued = new Set(['--workspace', '--ae-home', '--harness-home', '--copilot-home', '--name', ...Object.values(OPTIONS).flat()]);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--') {
      if (index !== argv.length - 1) throw usage('unexpected literal arguments');
      break;
    }
    if (!token.startsWith('-')) { positionals.push(token); continue; }
    const split = token.indexOf('='), name = split < 0 ? token : token.slice(0, split);
    const key = name === '-v' ? '--verbose' : name;
    if (seen.has(key) && !['--reviewer', '--file'].includes(key)) throw usage(`duplicate option ${key}`);
    seen.add(key);
    if (boolean.has(name) && split < 0) continue;
    if (!allValued.has(name)) throw usage(`unsupported option ${name}`, name === '--files' ? fileInputHint('domain') : undefined);
    const value = split < 0 ? argv[++index] : token.slice(split + 1);
    if (!value || (value.startsWith('-') && !(['--file', '--learning-decision'].includes(name) && value === '-')) || /[\x00-\x1f\x7f]/.test(value)) throw usage(`${name} requires a bounded value`);
    const entries = values.get(name) || [];
    if (entries.length >= 32 || Buffer.byteLength(value) > 4096) throw usage(`${name} exceeds the input bound`);
    entries.push(value); values.set(name, entries);
  }
  const [verb, reviewVerb] = positionals;
  if (!DOMAIN_VERBS.includes(verb) || positionals.length !== (verb === 'review' ? 2 : 1) || (verb === 'review' && !['prepare', 'assemble'].includes(reviewVerb))) throw usage('unsupported verb or unexpected positional argument');
  if (seen.has('--validate-completion') && verb !== 'status') throw usage('--validate-completion is supported only for status');
  const allowed = new Set(['--workspace', '--ae-home', '--harness-home', '--copilot-home', '--name', ...OPTIONS[verb]]);
  for (const [key, entries] of values) {
    if (!allowed.has(key)) throw usage(`${key} is unsupported for ${verb}`);
    if (entries.length > 1 && !(verb === 'review' && reviewVerb === 'prepare' && ['--reviewer', '--file'].includes(key))) throw usage(`duplicate option ${key}`);
  }
  const value = key => values.get(key)?.[0];
  if (value('--file') === '-' && !['plan-new', 'plan-update'].includes(verb)) throw usage('--file - is supported only for plan-new and plan-update');
  const name = value('--name');
  if (!name || name.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) throw usage('--name must identify an existing bounded domain');
  const required = [];
  if (!['show', 'plan-new'].includes(verb)) required.push('--plan');
  if (['plan-new', 'plan-update'].includes(verb)) required.push('--file');
  if (verb === 'compound') required.push('--learning-decision');
  if (reviewVerb === 'assemble') required.push('--packet', '--file');
  for (const key of required) if (!values.has(key)) throw usage(`${verb} requires ${key}`);
  if (value('--domain') && !['code', 'document'].includes(value('--domain'))) throw usage('review domain must be code or document');
  if (value('--max-bytes') && !/^\d+$/.test(value('--max-bytes'))) throw usage('--max-bytes requires an integer');
  return { verb, reviewVerb, name, values, value, flags: parseFlags(argv) };
}

export function resolveDomainCommandContext(argv, ctx = {}) {
  return resolveParsedDomainContext(parseDomainArguments(argv), ctx);
}

function resolveParsedDomainContext(parsed, ctx) {
  if (parsed.verb === 'show') return null;
  parsed.decision = ctx.domainInput?.decision;
  const workspace = path.resolve(parsed.flags.workspace), home = parsed.flags.harnessHome || ctx.harnessHome || harnessGlobalHome();
  let context = ctx.domainContext;
  if (context) {
    const authority = validateDomainContext(ctx.domainContext, workspace);
    let selectedHome = null;
    try {
      const requested = path.resolve(home), anchor = path.parse(requested).root;
      if (assertNoSymlinkAncestors(anchor, path.relative(anchor, requested))) selectedHome = canonicalPath(requested);
    } catch {}
    if (authority.name !== parsed.name || authority.home !== selectedHome) throw usage('selected domain differs from command authority');
  } else context = resolveDomainContext({ workspace, home, name: parsed.name });
  if (!['status', 'get', 'plan-new'].includes(parsed.verb) || parsed.flags.validateCompletion) {
    const plan = loadPlan(workspace, parsed.flags.plan, { home, domainContext: context });
    if (!plan) throw usage('parent plan is missing or outside the selected domain store');
    const checked = domainCoordinatorCheck({ workspace, plan });
    if (!checked.pass && !acceptedCoordinatorRefresh(parsed, workspace, plan)) throw usage(checked.message);
  }
  if (ctx.domainInput && parsed.decision) ctx.domainInput.decision = parsed.decision;
  return context;
}

function acceptedCoordinatorRefresh(parsed, workspace, plan) {
  if (parsed.verb !== 'plan-update') return false;
  parsed.decision ??= readDecision(workspace, parsed.value('--file'));
  return planUpdateActorCheck({ workspace, plan, input: parsed.decision }).pass;
}

function readDecision(workspace, argument) {
  const text = argument === '-' ? readBoundedInput() : readFileNoFollow(path.resolve(workspace, argument), { maxBytes: 1024 * 1024 });
  try {
    if (text === null || YAML.parseDocument(text, { schema: 'json', uniqueKeys: true, maxAliasCount: 0 }).errors.length) throw new Error();
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw usage('decision must contain bounded JSON without duplicate keys'); }
}

export function domainResultOf(argv, ctx = {}) {
  const parsed = parseDomainArguments(argv), { flags, verb, name } = parsed;
  const workspace = path.resolve(flags.workspace), home = flags.harnessHome || ctx.harnessHome || harnessGlobalHome();
  if (verb === 'show') return inspectDomain(readDomain(name, { home }));
  return runDomainOperation(parsed, { ...ctx, workspace, home, domainContext: resolveParsedDomainContext(parsed, ctx) });
}

async function runDomainOperation(parsed, ctx) {
  const { verb, reviewVerb, name, value, values, flags } = parsed;
  const { workspace, home, domainContext } = ctx;
  const copilotHome = resolveCopilotHome(flags.copilotHome || ctx.copilotHome);
  const common = { workspace, home, domainContext, copilotHome, dryRun: flags.dryRun };
  let result;
  if (verb === 'plan-new') result = await createDomainPlans({ ...common, name, decision: readDecision(workspace, value('--file')) });
  else if (verb === 'plan-update') result = updatePlanDecision({ ...common, planPath: flags.plan, input: parsed.decision ?? readDecision(workspace, value('--file')), flags });
  else {
    const plan = loadPlan(workspace, flags.plan, { home, domainContext });
    if (!plan) throw usage('parent plan is missing or outside the selected domain store');
    if (verb === 'status') result = flags.validateCompletion ? validateCompletion({ workspace, plan, copilotHome }) : domainStatus({ ...common, plan });
    else if (verb === 'get') result = runGet({ workspace, copilotHome, home, flags: { ...flags, path: plan.fullPath }, authorizedPlan: plan });
    else if (verb === 'gate') {
      result = runGate({ workspace, flags, domainContext });
      publishGateSession({ workspace, plan, result, policy: loadPolicy(workspace, flags.enforcement, { copilotHome, home }), dryRun: flags.dryRun });
    } else if (verb === 'review') {
      result = reviewVerb === 'prepare'
        ? prepareReview({ ...common, plan, base: flags.base, kind: value('--domain') || 'code', reviewers: values.get('--reviewer') || [], files: values.get('--file') || null, maxBytes: value('--max-bytes') ? Number(value('--max-bytes')) : undefined })
        : await (async () => {
          const input = readDecision(workspace, value('--file'));
          // Same lazy lookup as `ae review assemble`, so recorded finding verifications apply here too.
          let verificationFor;
          if (input?.verifications !== undefined) {
            const { findingVerification } = await import('./decision-agent.mjs');
            verificationFor = requestId => findingVerification({ workspace, home: flags.harnessHome, requestId });
          }
          return assembleReview({ ...common, plan, packetId: value('--packet'), input, verificationFor });
        })();
    } else if (verb === 'verify') {
      result = await runVerify({ workspace, flags, domainContext, signal: ctx.signal, events: ctx.events });
      result.status = statusForVerifyResult(result);
      result.exitCode = exitCodeForOutcome(result.outcome, flags.enforcement || 'enforce');
    } else if (verb === 'compound') result = await runCompound({ workspace, copilotHome, flags, domainContext });
  }
  const pass = result.pass ?? (result.outcome ? result.outcome === 'passed' : !['failed', 'blocked', 'needs-info'].includes(result.status));
  return { mode: 'domain', verb, name, ...result, status: result.status || (pass ? 'ok' : 'failed'), exitCode: result.exitCode ?? (pass ? 0 : 1) };
}

export async function cmdDomain(argv, ctx = {}) {
  const flags = parseFlags(argv);
  const result = await domainResultOf(argv, ctx);
  const redactor = createRedactor();
  if (flags.json || result.verb !== 'show') console.log(redactedJson(result, { pretty: flags.verbose, redactor }));
  else {
    const { redactText } = redactor;
    console.log(`domain ${inertLine(result.name)} (version ${result.domainVersion})`);
    for (const repo of result.repos) {
      console.log(`  ${inertLine(repo.id)}: ${repo.status}; ${inertLine(redactText(repo.expected.root))}`);
      console.log(`    origin expected: ${inertLine(redactText(repo.expected.origin))}`);
      console.log(`    origin observed: ${inertLine(redactText(repo.observed.origin || 'unknown'))}`);
      console.log(`    HEAD: ${repo.observed.head || 'unknown'}; checks: ${repo.checks.status}`);
      for (const warning of repo.warnings) console.log(`    ${inertLine(warning)}`);
    }
    for (const warning of result.warnings) console.log(`  ${inertLine(warning)}`);
  }
  ctx.reportStatus?.(result.status);
  return result.exitCode;
}
