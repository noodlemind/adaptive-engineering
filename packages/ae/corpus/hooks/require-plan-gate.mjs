#!/usr/bin/env node
/** PreToolUse gate: require a fresh explicit implement gate and planned scope. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { selectProjectAuthority } from './lib/project-authority.mjs';
import { readPolicySource } from './lib/policy-snapshot.mjs';
import { readProductDiff } from './lib/product-diff.mjs';
import { callProofAuthority } from './lib/proof-authority.mjs';
import { resolveAcceptedPlan, projectStoreDir, harnessHome } from './lib/external-plans.mjs';
import { writeHookEvent } from './lib/events.mjs';
import { syncSessionIdentity } from './lib/session-state.mjs';
import { skillActivationSourceCurrent } from './lib/skill-activation.mjs';
import { preToolDenyOutput } from './lib/hook-output.mjs';
import { loadHookPolicy, projectTrustIsCurrent } from './lib/policy.mjs';
import { checkConfigurationRecoveryControl, harnessControlCommand, isPersonalWritePath, isPrimitivePath, normalizeToolPayload, planUsesCreatePrimitive, unwrapShellSegments } from './lib/tool-payload.mjs';
import { parseImpactedText } from './lib/impacted-files.mjs';
import { decisionInputStaging } from './lib/decision-staging.mjs';

const startedAt = Date.now();
let payload = {};
let normalized = null;
let policy = { enforcement: 'enforce', ttl: 30 };
let policyObserved = false;
const RECOVER_MISSING_GATE = 'Read <copilot-home>/skills/ensure-plan/SKILL.md with the host read tool. A not-truncated read of that SKILL.md is activation. Create or amend only the canonical plan, then submit a standalone ae plan-update --file start decision. Harness binds state and the implement gate. Wait for explicit success before retrying the product mutation in a later tool call';
const NEW_PLAN_PATH = /^(?:docs|\.harness)\/plans\/\d{4}-\d{2}-\d{2}-(?:feat|fix|docs|refactor|chore)-[a-z0-9]+(?:-[a-z0-9]+)*-plan\.md$/;

function output(value) {
  console.log(JSON.stringify(value));
}

function isPlanRelative(relative) {
  return relative === 'docs/plans' || relative.startsWith('docs/plans/')
    || relative === '.harness/plans' || relative.startsWith('.harness/plans/');
}

function resolvePlanFile(workspace, rel) {
  return resolveAcceptedPlan(workspace, rel) || path.resolve(workspace, rel);
}

function record(fields) {
  const item = normalized || {
    workspace: path.resolve(payload.workspace || payload.cwd || process.cwd()),
    toolName: payload.tool_name || payload.toolName || null,
    mutation: true,
    targets: [],
    targetResolved: false,
  };
  writeHookEvent(item.workspace, payload, {
    type: 'pre_tool',
    tool: item.toolName,
    mutation: item.mutation,
    targets: item.targets,
    targetResolved: item.targetResolved,
    durationMs: Date.now() - startedAt,
    ...fields,
  });
}

function observePolicy() {
  if (policyObserved || !normalized?.workspace) return;
  policyObserved = true;
  policy = loadHookPolicy(normalized.workspace, { ttlKey: 'gate_ttl_minutes', ttlDefault: 30 });
}

function deny(reason, message, gate = 'missing') {
  try { observePolicy(); } catch { policy = { enforcement: 'enforce', ttl: 30 }; }
  const detail = `${reason}: ${message}`;
  console.error(`[harness hook] ${detail}`);
  if (policy.enforcement !== 'enforce') {
    record({ gate, decision: 'warn', blockedReason: detail, result: 'warn' });
    output({ continue: true, systemMessage: `[harness hook] ${detail}` });
    process.exit(0);
  }
  record({ gate, decision: 'block', blockedReason: detail, result: 'fail' });
  output(preToolDenyOutput(detail));
  process.exit(0);
}

function nonEmptyStrings(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'string' && item.trim());
}

function readPlanRecord(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith('{') && entry.endsWith('}'));
  if (!line) return null;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.goal !== 'string' || !value.goal.trim()) return null;
  if (!nonEmptyStrings(value.acceptance) || !nonEmptyStrings(value.constraints)) return null;
  return value;
}

function impactedFiles(text) {
  const section = text.match(/## Impacted Files\s*\n([\s\S]*?)(?=\n## |$)/i)?.[1] || '';
  return parseImpactedText(section);
}

function inScope(file, entries) {
  return entries.some((entry) => {
    if (entry.endsWith('/**')) return file === entry.slice(0, -3) || file.startsWith(entry.slice(0, -2));
    if (entry.endsWith('/')) return file.startsWith(entry);
    return file === entry;
  });
}

function existingAncestor(target) {
  let cursor = path.resolve(target);
  const missing = [];
  while (!fs.existsSync(cursor)) {
    missing.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
  try {
    return path.join(fs.realpathSync(cursor), ...missing);
  } catch {
    return null;
  }
}

function exclusiveFiles(session, workspace) {
  if (!Array.isArray(session?.files)) return [];
  let root;
  try {
    root = fs.realpathSync(workspace);
  } catch {
    root = path.resolve(workspace);
  }
  return session.files
    .filter((entry) => typeof entry === 'string')
    .map((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return '';
      if (!path.isAbsolute(trimmed)) return trimmed.replace(/^\.\//, '').replace(/\\/g, '/');
      const resolved = existingAncestor(trimmed);
      if (!resolved) return trimmed.replace(/\\/g, '/');
      const relative = path.relative(root, resolved).replace(/\\/g, '/');
      if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return trimmed.replace(/\\/g, '/');
      return relative;
    })
    .filter(Boolean);
}

function isPlannedAncestor(file, entries) {
  const prefix = `${file.replace(/\/+$/, '')}/`;
  return entries.some((entry) => {
    const planned = entry.replace(/\/\*\*$/, '').replace(/\/+$/, '');
    return planned.startsWith(prefix);
  });
}

function readFileText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function replacementChanges(file, previous, next) {
  if (typeof next !== 'string' || typeof previous !== 'string' || next === previous) return false;
  const current = readFileText(file);
  return current === null || current.includes(previous);
}

function editChangesBytes(normalized) {
  const input = normalized.toolInput || {};
  const files = normalized.targets;
  if (files.length === 1 && replacementChanges(files[0], input.old_string ?? input.oldString, input.new_string ?? input.newString)) {
    return true;
  }
  const content = input.contents ?? input.content;
  if (typeof content === 'string' && files.length === 1) {
    const current = readFileText(files[0]);
    if (current === null || current !== content) return true;
  }
  for (const collection of [input.files, input.edits, input.replacements]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (!item || typeof item !== 'object') continue;
      const target = files.length === 1 ? files[0] : null;
      if (target && replacementChanges(target, item.old_string ?? item.oldString, item.new_string ?? item.newString)) return true;
    }
  }
  return false;
}

function retryDecision(lastAttempt, nextAttempt) {
  const bin = process.env.HARNESS_BIN;
  const modulePath = bin && path.resolve(path.dirname(bin), '../lib/task-control.mjs');
  if (modulePath && fs.existsSync(modulePath)) {
    const href = pathToFileURL(modulePath).href;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import fs from 'node:fs';
import { decideNext } from ${JSON.stringify(href)};
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(decideNext(input)));`],
      {
        input: JSON.stringify({ lastAttempt, nextAttempt }),
        encoding: 'utf8',
        timeout: 4000,
      },
    );
    if (!result.error && result.status === 0 && result.stdout) {
      try {
        return JSON.parse(result.stdout);
      } catch {
      }
    }
  }
  // Copied into the host home, this file cannot import packages/ae.
  if (typeof nextAttempt === 'string' && nextAttempt.length > 0 && nextAttempt === lastAttempt) {
    return { action: 'block', reason: 'unchanged-retry' };
  }
  return { action: 'continue' };
}

function sessionActivatedSkill(session, skill, sessionId, ttlMinutes) {
  const activation = session?.activatedSkills?.[skill];
  if (!activation?.activatedAt || activation.complete !== true || !skillActivationSourceCurrent(activation, skill)) return false;
  if (sessionId) return activation.sessionId === sessionId;
  // Hosts may omit session_id; accept only a fresh activation so a stale
  // record from an earlier chat cannot satisfy the governance gate.
  const activatedAt = Date.parse(activation.activatedAt);
  return Number.isFinite(activatedAt) && Date.now() - activatedAt <= ttlMinutes * 60 * 1000;
}

function targetEscapesWorkspace(workspace, target) {
  let cursor = path.resolve(workspace, target);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  try {
    const realWorkspace = fs.realpathSync(workspace);
    const realAncestor = fs.realpathSync(cursor);
    const relative = path.relative(realWorkspace, realAncestor);
    return relative.startsWith('..') || path.isAbsolute(relative);
  } catch {
    return true;
  }
}

function parseInlineList(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return [];
  return text
    .slice(1, -1)
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function requiredChecks(planText) {
  const frontmatter = planText.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
  const lines = frontmatter.split(/\r?\n/);
  const verification = lines.findIndex((line) => /^verification:\s*(?:#.*)?$/.test(line));
  if (verification < 0) return [];
  for (let index = verification + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line)) break;
    const required = line.match(/^\s{2}required:\s*(.*?)\s*(?:#.*)?$/);
    if (!required) continue;
    if (required[1]) return parseInlineList(required[1]);
    const names = [];
    for (let child = index + 1; child < lines.length; child += 1) {
      const item = lines[child].match(/^\s{4}-\s+(.+?)\s*(?:#.*)?$/);
      if (!item) break;
      names.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
    }
    return names;
  }
  return [];
}

function configuredChecksDigest(workspace) {
  try {
    const home = harnessHome();
    const authority = selectProjectAuthority(workspace, projectStoreDir(workspace, { home }), { home });
    const bytes = readPolicySource(authority.files['checks.yaml']);
    return bytes === null ? null : crypto.createHash('sha256').update(bytes).digest('hex');
  } catch { return null; }
}

function normalizeArg(value) {
  return path.posix.normalize(String(value || '').replace(/\\/g, '/')).replace(/^\.\//, '');
}

function commandMatches(actual, expected) {
  if (actual.length < expected.length) return false;
  return expected.every((part, index) => {
    if (index === 0) return path.basename(actual[index] || '') === path.basename(part);
    return normalizeArg(actual[index]) === normalizeArg(part);
  });
}

function unplannedNamedChecks(commands, command, planText) {
  const required = new Set(requiredChecks(planText));
  const segments = unwrapShellSegments(command);
  return commands
    .filter(({ name, argv }) => !required.has(name) && segments.some((segment) => commandMatches(segment, argv)))
    .map(({ name }) => name);
}

function soleHarnessControl() {
  const effects = normalized.terminalEffects;
  if (normalized.mutation || effects.ambiguous || effects.hasOpaque || effects.invocations.length !== 1) return null;
  return harnessControlCommand(effects.invocations[0], normalized.workspace);
}

try {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw.trim()) throw new Error('payload is empty');
  payload = JSON.parse(raw);
} catch (error) {
  deny('invalid-hook-payload', error.message, 'invalid');
}

try {
  normalized = normalizeToolPayload(payload);
} catch (error) { deny('invalid-runtime-configuration', error.message, 'invalid'); }
if (decisionInputStaging(payload, normalized)) {
  output({ continue: true });
  process.exit(0);
}
try { syncSessionIdentity(normalized.workspace, normalized.sessionId); }
catch (error) { deny('invalid-session-identity', error.message, 'invalid'); }
if (normalized.command) {
    const sessionPath = path.join(normalized.workspace, '.harness', 'session.json');
    try {
      const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      const activePlan = session.gatedPlan || session.activePlan;
      const planText = activePlan ? fs.readFileSync(resolvePlanFile(normalized.workspace, activePlan), 'utf8') : '';
      const currentDigest = configuredChecksDigest(normalized.workspace);
      const control = soleHarnessControl();
      const effects = normalized.terminalEffects;
      const recovery = control && checkConfigurationRecoveryControl(effects.invocations[0], normalized.workspace);
      if (Object.hasOwn(session, 'gatedChecksDigest')
        && session.gatedChecksDigest !== currentDigest
        && !(session.gatedChecksDigest === null && control)
        && !['gate', 'worktree'].includes(control)
        && !recovery) {
        deny(
          'changed-check-config',
          session.gatedChecksDigest === null
            ? 'The failed implement gate has no accepted check binding. Run a standalone canonical ae control command to recover before product execution'
            : 'The configured check manifest changed after the implement gate. Inspect and repair it through the installed checks, trust status, orient or authored plan decision commands, then obtain required approval and refresh the gate before execution',
          'invalid'
        );
      }
      const commands = Array.isArray(session.gatedCheckCommands) ? session.gatedCheckCommands : [];
      const unplanned = unplannedNamedChecks(commands, normalized.command, planText);
      if (unplanned.length) {
        deny(
          'out-of-plan-verification',
          `Do not run configured checks outside this plan's verification.required list: ${unplanned.join(', ')}. Run only the required named checks, then ae verify; report unrelated failures without executing or repairing them`,
          'invalid'
        );
      }
    } catch {
      // No readable active session/plan means there is no plan-scoped verification contract to enforce here.
    }
}
if (!normalized.mutation) {
  output({ continue: true });
  process.exit(0);
}
try { observePolicy(); }
catch (error) { deny('invalid-runtime-configuration', error.message, 'invalid'); }
const opaque = normalized.terminalEffects.hasOpaque;
if (!normalized.targetResolved && !opaque) {
  deny('unresolved-mutation-target', 'Mutation target could not be resolved for scope validation; next: retry the edit with an explicit file path, or read <copilot-home>/skills/ensure-plan/SKILL.md with the host read tool', 'unresolved');
}

const relatives = normalized.targets.map((target) => {
  const relative = path.relative(normalized.workspace, path.resolve(normalized.workspace, target)).replace(/\\/g, '/');
  if (relative.startsWith('../') || path.isAbsolute(relative) || targetEscapesWorkspace(normalized.workspace, target)) {
    deny('outside-workspace', `Edit target is outside workspace: ${target}; next: edit only files inside the workspace`, 'invalid');
  }
  return relative;
});
for (const relative of relatives) {
  if (relative === 'docs/plans' || relative === '.harness/plans') continue;
  if (!relative.startsWith('docs/plans/') && !relative.startsWith('.harness/plans/')) continue;
  if (fs.existsSync(path.join(normalized.workspace, relative))) continue;
  if (!NEW_PLAN_PATH.test(relative)) {
    deny(
      'invalid-plan-path',
      'New plans must use docs/plans/ or .harness/plans/YYYY-MM-DD-<type>-<slug>-plan.md with type feat|fix|docs|refactor|chore; read <copilot-home>/skills/ensure-plan/SKILL.md with the host read tool and do not create an undated shortcut',
      'invalid'
    );
  }
}
const mutatesPlan = relatives.some((relative) => isPlanRelative(relative));
if (mutatesPlan && /\b(?:ae|harness)\s+(?:validate-plan|gate)\b/.test(normalized.command || '')) {
  deny(
    'mixed-plan-command',
    'Create or lock only the canonical plan in this mutation. After it succeeds, run validate-plan and the implement gate as separate non-mutating tool calls',
    'invalid'
  );
}
const governed = relatives.filter((relative) =>
  relative !== 'docs/plans'
  && !relative.startsWith('docs/plans/')
  && relative !== '.harness'
  && !relative.startsWith('.harness/')
);
if (governed.length === 0 && !opaque) {
  record({ gate: 'exempt', decision: 'allow', result: 'pass' });
  output({ continue: true });
  process.exit(0);
}

const sessionPath = path.join(normalized.workspace, '.harness', 'session.json');
if (!fs.existsSync(sessionPath)) {
  deny('missing-implement-gate', RECOVER_MISSING_GATE);
}

let session;
try {
  session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
} catch {
  deny('missing-implement-gate', 'Harness session is unreadable; next: rerun `ae gate --phase implement --plan <plan> --workspace . --json`', 'invalid');
}
if (session.gateStatus !== 'pass' || !session.gatedPlan || !session.lastGateAt) {
  deny('missing-implement-gate', RECOVER_MISSING_GATE);
}
const lastGateAt = Date.parse(session.lastGateAt);
if (!Number.isFinite(lastGateAt)) {
  deny('invalid-implement-gate', 'Implement gate timestamp is invalid; rerun the gate', 'invalid');
}
if (Date.now() - lastGateAt > policy.ttl * 60 * 1000) {
  deny('stale-implement-gate', 'Implement gate is stale; rerun the gate', 'stale');
}

const planPath = resolveAcceptedPlan(normalized.workspace, session.gatedPlan);
if (!planPath) deny('invalid-implement-gate', 'Gated plan is missing or outside the plan directories; next: rerun `ae gate --phase implement --plan <plan> --workspace . --json`', 'invalid');

const planText = fs.readFileSync(planPath, 'utf8');
// Digest the Activity-stripped contract text so routine session logging does
// not invalidate the gate; this must match the evidence-binding digest rule.
const planAuthority = callProofAuthority(normalized.workspace, ['--contract-digest', '--plan', session.gatedPlan]);
const planDigest = planAuthority?.digest || null;
if (planAuthority?.experiment && !planAuthority.experiment.pass) deny('unreserved-experiment-candidate', planAuthority.experiment.message || 'Keep the baseline and reserve a candidate before editing', 'invalid');
if (planAuthority?.experiment && (session.gatedPhase !== 'implement' || lastGateAt > Date.now())) deny('invalid-experiment-gate', 'Experiment edits require a current implement gate and reserved candidate', 'invalid');
if (!planDigest) deny('unreadable-plan-authority', planAuthority?.message || 'Installed Harness could not establish the current plan contract; restore required helpers and rerun the gate', 'invalid');
if (!session.gatedPlanDigest || session.gatedPlanDigest !== planDigest) {
  deny('changed-implement-plan', 'Plan changed after the implement gate; rerun the gate', 'invalid');
}
const planStatus = planText.match(/^status:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/m)?.[1] || null;
if (planStatus === 'planned') {
  deny(
    'plan-not-in-progress',
    'After the initial gate, change plan status from planned to in-progress, rerun the implement gate as its own tool call, wait for pass, then retry this product mutation',
    'invalid'
  );
}
if (opaque) {
  if (normalized.terminalEffects.ambiguous) {
    deny('ambiguous-terminal-command', 'Run each required named check with its exact argv, without wrappers, substitutions, or changed working directories; next: use ae verify for plan verification', 'invalid');
  }
  if (!Object.hasOwn(session, 'gatedChecksDigest') || session.gatedChecksDigest !== configuredChecksDigest(normalized.workspace)) {
    deny('unbound-terminal-command', 'Opaque execution needs a frozen current check manifest; next: rerun ae gate, then use the exact required check command', 'invalid');
  }
  if (!projectTrustIsCurrent(normalized.workspace)) {
    deny('untrusted-terminal-command', 'Project checks are not currently approved; next: request explicit project trust approval, then rerun ae gate and use ae verify', 'invalid');
  }
  const required = new Set(requiredChecks(planText));
  const commands = Array.isArray(session.gatedCheckCommands) ? session.gatedCheckCommands : [];
  const admitted = normalized.terminalEffects.opaqueInvocations.every(actual => commands.some(({ name, argv }) =>
    required.has(name) && Array.isArray(argv) && actual.length === argv.length && actual.every((part, index) => part === argv[index])
  ));
  if (!admitted) {
    deny('unclassified-terminal-command', 'Executable effects are unknown and the invocation is not an exact required named check; next: declare and approve the check, rerun ae gate, then use ae verify', 'invalid');
  }
}
const planRecord = readPlanRecord(planText);
const allowed = planAuthority?.experiment ? planAuthority.experiment.files || [] : impactedFiles(planText);
// The planned-ancestor exception applies only to paths mkdir itself creates,
// not to every target of a compound command that happens to include mkdir.
const mkdirRelatives = new Set(
  normalized.mkdirTargets.map((target) =>
    path.relative(normalized.workspace, path.resolve(normalized.workspace, target)).replace(/\\/g, '/')
  )
);
if (!planRecord || allowed.length > 0) {
  for (const relative of governed) {
    if (!inScope(relative, allowed) && !(mkdirRelatives.has(relative) && isPlannedAncestor(relative, allowed))) {
      deny('out-of-plan-scope', `File is outside the plan's ## Impacted Files: ${relative}; next: add it to ## Impacted Files and rerun the gate, or edit only planned files`, 'passed');
    }
  }
}
const exclusive = exclusiveFiles(session, normalized.workspace);
if (exclusive.length > 0) {
  for (const relative of governed) {
    const listed = exclusive.includes(relative);
    const mkdirAncestor = mkdirRelatives.has(relative) && isPlannedAncestor(relative, exclusive);
    if (!listed && !mkdirAncestor) {
      deny(
        'outside-exclusive-files',
        `File is outside the orient --read file list: ${relative}; next: call ae orient --read with the task text and this file, or edit only the listed files`,
        'passed',
      );
    }
  }
}
const personal = governed.filter(isPersonalWritePath);
if (personal.length) {
  deny(
    'personal-write',
    `personal primitives are created with ae resources create <skill|agent|instruction> <name>, not by planning an edit to ${personal.join(', ')}`,
    'invalid',
  );
}
if (governed.some(isPrimitivePath)) {
  if (!planUsesCreatePrimitive(planText)) {
    deny(
      'missing-create-primitive',
      'Read <copilot-home>/skills/create-primitive/SKILL.md with the host read tool and follow it before planning or editing primitive paths; then record create-primitive in plan skills_used',
      'passed'
    );
  }
  if (!sessionActivatedSkill(session, 'create-primitive', normalized.sessionId, policy.ttl)) {
    deny(
      'missing-create-primitive-activation',
      'Read the complete current <copilot-home>/skills/create-primitive/SKILL.md with the host read tool and follow it. Partial, clipped, look-alike or changed source reads cannot establish activation. Naming create-primitive in skills_used is not activation, so retry this mutation only after that skill read is recorded for this chat session',
      'passed'
    );
  }
}

if (!opaque && typeof session.diffFingerprint === 'string' && session.diffFingerprint.length > 0) {
  const nextDiff = readProductDiff(normalized.workspace, { planPath: session.activePlan });
  if (nextDiff === null) {
    deny('unreadable-diff', 'The current diff could not be read; retry the edit once git diff HEAD succeeds', 'invalid');
  }
  const decision = editChangesBytes(normalized)
    ? { action: 'allow' }
    : retryDecision(session.diffFingerprint, nextDiff);
  if (decision.action === 'block' && decision.reason === 'unchanged-retry') {
    deny(
      'unchanged-retry',
      'The diff matches the last verified attempt; change the diff before editing again',
      'passed'
    );
  }
}

record({ gate: 'passed', decision: 'allow', plan: session.gatedPlan, result: 'pass' });
output({ continue: true });
