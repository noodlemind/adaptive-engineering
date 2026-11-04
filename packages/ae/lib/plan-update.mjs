import { planRecordRoot, planHome, domainPlanPath, validateDomainContext } from './domain-context.mjs';
import { planWithText } from './plan-parse.mjs';
import { sharedIntentCheck } from './domain-bindings.mjs';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { randomUUID } from 'node:crypto';
import { createStyle, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { externalPlansDir, planReadDirs, projectStoreDir, conversionPointerRel, canonicalPlanFilePath, readPlanConversionGuard } from './project-layout.mjs';
import { harnessGlobalHome, resolveCopilotHome } from './paths.mjs';
import { parseFlags } from './flags.mjs';
import { loadPlan, parsePlanFrontmatter, planFromText } from './plan-parse.mjs';
import { completeWork, completionPrerequisites, validateCompletion } from './completion.mjs';
import { bindLockedIntentSources, lockIntentSources, sourcePath, hashIntentFile, intentSourcesCheck } from './intent-sources.mjs';
import { readBoundedInput, readFileNoFollow, assertNoSymlinkAncestors, writeFileContainedExclusive, canonicalPath } from './fs-safe.mjs';
import { applyPlanDecision, validatePlanDecision, planRevision, planState } from './plan-decisions.mjs';
import { runGate, publishGateSession } from './gate.mjs';
import { loadPolicy } from './policy.mjs';
import { validatePlanSchema } from './plan-schema.mjs';
import { validatePlanReadiness, gapEvidenceCheck } from './plan-readiness.mjs';
import { inspectCheckReadiness } from './check-readiness.mjs';
import { validatePlanScope } from './plan-scope.mjs';
import { readReviewRecord, publishReviewRecord, recordHash } from './review.mjs';
import { reviewHash } from './review-preparation.mjs';
import { readEvidence, planDigest } from './evidence.mjs';
import { readPlanRecord } from './plan-record.mjs';
import { authorizeProjectPlan } from './domain-context.mjs';
import { domainLinkCheck, domainCoordinatorCheck, snapshotDomainCoordinator, validateCoordinatorBinding } from './domain-delivery.mjs';

const PLAN_STATUSES = ['open', 'planned', 'in-progress', 'review', 'done', 'blocked-capability', 'needs-info'];
const REVIEW_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GAP_FULFILLMENTS = ['done', 'bridge', 'waived'];
const LEGACY_PLAN_RELS = ['docs/plans', '.harness/plans'];
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30000;

function usage(message) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint: 'ae help plan-update' });
}

function contained(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function realDirectory(dir) {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return canonicalPath(dir);
  } catch {
    return null;
  }
}

/** Directories a plan-update may write. The external store, plus legacy in-repo plans. */
export function planUpdateRoots(workspace, { home, domainContext } = {}) {
  if (domainContext) return [validateDomainContext(domainContext, workspace).plansDir];
  return [
    externalPlansDir(workspace, { home }),
    ...LEGACY_PLAN_RELS.map((rel) => path.join(workspace, rel)),
  ];
}

/** Directory containing the current owner's token while a plan-update holds the file. */
export function planUpdateLockDir(full) {
  return path.join(path.dirname(full), `.${path.basename(full)}.lock`);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function singleLockEntry(dir) {
  const entries = fs.opendirSync(dir, { bufferSize: 2 });
  try {
    const first = entries.readSync();
    return first && !entries.readSync() ? first : null;
  } finally { entries.closeSync(); }
}

function planLockOwner(dir) {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const entry = singleLockEntry(dir);
    const match = entry?.name.match(/^owner-v1-([1-9][0-9]{0,15})-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/);
    if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
    const stamp = path.join(dir, entry.name), stampStat = fs.lstatSync(stamp);
    if (!stampStat.isDirectory() || stampStat.isSymbolicLink()) return null;
    const contents = fs.opendirSync(stamp, { bufferSize: 1 });
    try { if (contents.readSync()) return null; }
    finally { contents.closeSync(); }
    return { version: 1, pid: Number(match[1]), token: match[2], stamp: entry.name };
  } catch { return null; }
}

function removePlanLock(dir, token) {
  const owner = planLockOwner(dir);
  if (owner?.token !== token) throw usage('plan-update: lock ownership lost; inspect the retained lock');
  fs.rmdirSync(path.join(dir, owner.stamp));
  fs.rmdirSync(dir);
}

function retirePlanLock(dir, token, parent = path.dirname(dir)) {
  if (planLockOwner(dir)?.token !== token) throw usage('plan-update: lock ownership lost; inspect the retained lock');
  const retirement = fs.mkdtempSync(path.join(parent, '.retired-'));
  try {
    const retired = path.join(retirement, 'lock');
    fs.renameSync(dir, retired);
    removePlanLock(retired, token);
  } finally {
    try { fs.rmdirSync(retirement); } catch { /* preserve mismatched or unexpected retired contents */ }
  }
}

function acquirePlanLock(full) {
  const lockDir = planUpdateLockDir(full);
  const recovery = `${lockDir}.recovery`;
  const owner = { version: 1, token: randomUUID(), pid: process.pid };
  const start = Date.now();
  while (true) {
    const recovering = fs.lstatSync(recovery, { throwIfNoEntry: false });
    if (recovering) {
      if (!recovering.isDirectory() || recovering.isSymbolicLink()) throw usage('plan-update: unsafe lock recovery path; inspect before retrying');
      if (Date.now() - start > LOCK_WAIT_MS) throw usage('plan-update: lock recovery is busy; inspect the retained recovery directory before retrying');
      sleepMs(25);
      continue;
    }
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      // Empty owner directories keep legacy in-repo plan locks out of Git-observed proof scope.
      try { fs.mkdirSync(path.join(lockDir, `owner-v1-${owner.pid}-${owner.token}`), { mode: 0o700 }); }
      catch {
        try { fs.rmdirSync(lockDir); } catch { /* retain a nonempty or changed lock for inspection */ }
        throw usage('plan-update: lock owner could not be recorded');
      }
      if (fs.lstatSync(recovery, { throwIfNoEntry: false })) {
        retirePlanLock(lockDir, owner.token);
        continue;
      }
      return { dir: lockDir, token: owner.token };
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      if (Date.now() - start > LOCK_WAIT_MS) {
        if (error.code !== 'EEXIST') throw error;
        throw usage('plan-update: plan is locked by another update');
      }
      if (error.code === 'EEXIST') {
        const stat = fs.lstatSync(lockDir, { throwIfNoEntry: false });
        if (!stat) continue;
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw usage('plan-update: unsafe lock path; inspect before removing it');
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          const previous = planLockOwner(lockDir);
          if (!previous) throw usage('plan-update: lock owner is unreadable; inspect before removing it');
          let absent = false;
          try { process.kill(previous.pid, 0); }
          catch (error) {
            if (error.code === 'ESRCH') absent = true;
            else throw usage('plan-update: lock owner liveness is unavailable; absence is not proven');
          }
          if (absent) {
            try { fs.mkdirSync(recovery, { mode: 0o700 }); }
            catch (error) { if (error.code === 'EEXIST') continue; throw error; }
            try {
              if (planLockOwner(lockDir)?.token !== previous.token) continue;
              const retired = path.join(recovery, 'retired');
              fs.renameSync(lockDir, retired);
              removePlanLock(retired, previous.token);
            } finally {
              try { fs.rmdirSync(recovery); } catch { /* retain unexpected recovery contents for inspection */ }
            }
            continue;
          }
        }
      }
      sleepMs(25);
    }
  }
}

function releasePlanLock(lock) {
  const recovery = `${lock.dir}.recovery`;
  try { fs.mkdirSync(recovery, { mode: 0o700 }); }
  catch { throw usage('plan-update: lock recovery is busy; inspect before releasing the retained lock'); }
  try {
    retirePlanLock(lock.dir, lock.token, recovery);
  } finally {
    try { fs.rmdirSync(recovery); } catch { /* preserve a mismatched retired owner for inspection */ }
  }
}

export function withPlanUpdateLock(full, fn) {
  const lockDir = acquirePlanLock(full);
  try {
    return fn();
  } finally {
    releasePlanLock(lockDir);
  }
}

/**
 * Resolve `--plan` to a real plan file inside a plan root.
 * A bare name may match one plan. An explicit path is used as given.
 * Symlinks are refused before any path is resolved through them.
 */
export function resolvePlanUpdateFile(workspace, planArg, { home, domainContext } = {}) {
  if (typeof planArg !== 'string' || !planArg.trim()) throw usage('plan-update: --plan is required');
  const raw = planArg.trim();
  if (domainContext) {
    validateDomainContext(domainContext, workspace);
    const full = domainPlanPath(domainContext, raw);
    if (!loadPlan(workspace, full, { home, domainContext })) throw usage('domain parent is unreadable or outside its authorized plan store');
    return full;
  }
  const bare = !raw.includes('/') && !raw.includes('\\');
  let listedPath;
  if (bare) {
    const matches = planReadDirs(workspace, { home })
      .map((entry) => path.join(entry.dir, raw))
      .filter((candidate) => fs.existsSync(candidate));
    if (matches.length === 0) throw usage('plan-update: path is outside the plan store');
    listedPath = matches[0];
  } else {
    listedPath = path.resolve(workspace, raw);
  }
  let listed;
  try {
    listed = fs.lstatSync(listedPath);
  } catch {
    throw usage('plan-update: path is outside the plan store');
  }
  if (!listed.isFile() || listed.isSymbolicLink()) throw usage('plan-update: path is outside the plan store');
  const real = canonicalPath(listedPath);
  const base = path.basename(real);
  if (!/\.(?:md|hplan)$/.test(real) || base === 'README.md' || base.startsWith('_')) {
    throw usage('plan-update: path is outside the plan store');
  }
  const roots = planUpdateRoots(workspace, { home }).map(realDirectory).filter(Boolean);
  if (!roots.some((root) => contained(root, real))) throw usage('plan-update: path is outside the plan store');
  return real;
}

function appendLines(current, incoming, flag) {
  const next = Array.isArray(current) ? current.map(String) : [];
  for (const item of incoming) {
    const text = oneLine(item, flag);
    if (!next.includes(text)) next.push(text);
  }
  return next;
}

function appendIntentSources(current, incoming) {
  const next = Array.isArray(current) ? current.slice() : [];
  const seen = new Set(next.map(sourcePath).filter(Boolean));
  for (const item of incoming) {
    const rel = oneLine(item, '--intent-source').replace(/\\/g, '/');
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    next.push(rel);
  }
  return next;
}

function appendChecks(verification, incoming) {
  const record = verification && typeof verification === 'object' && !Array.isArray(verification) ? verification : {};
  const required = Array.isArray(record.required) ? record.required.map(String) : [];
  for (const name of incoming) {
    const id = oneLine(name, '--verification-check');
    if (!REVIEW_ID.test(id)) throw usage('plan-update: --verification-check must be a lowercase id');
    if (!required.includes(id)) required.push(id);
  }
  return { ...record, required };
}

function fulfillGaps(current, incoming) {
  const gaps = Array.isArray(current) ? current : [];
  for (const spec of incoming) {
    const text = oneLine(spec, '--gap-fulfillment');
    const split = text.indexOf(':');
    const id = split > 0 ? text.slice(0, split) : '';
    const fulfillment = split > 0 ? text.slice(split + 1) : '';
    if (!REVIEW_ID.test(id) || !GAP_FULFILLMENTS.includes(fulfillment)) {
      throw usage('plan-update: --gap-fulfillment must be id:done|bridge|waived');
    }
    const gap = gaps.find((item) => item && item.id === id);
    if (!gap) throw usage(`plan-update: no capability gap ${id}`);
    gap.fulfillment = fulfillment;
  }
  return gaps;
}

function oneLine(value, flag) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
    throw usage(`plan-update: ${flag} must be a single non-empty line`);
  }
  return value.trim();
}

function appendActivity(body, line) {
  const bullet = line.startsWith('- ') ? line : `- ${line}`;
  const start = body.search(/^## Activity[ \t]*$/m);
  if (start < 0) {
    const sep = body.endsWith('\n') ? '' : '\n';
    return `${body}${sep}\n## Activity\n\n${bullet}\n`;
  }
  const rest = body.slice(start + 1);
  const nextHeading = rest.search(/^## /m);
  const sectionEnd = nextHeading === -1 ? body.length : start + 1 + nextHeading;
  const section = body.slice(start, sectionEnd);
  if (section.split('\n').some((entry) => entry.trim() === bullet)) return body;
  const head = body.slice(0, sectionEnd).replace(/\s*$/, '\n');
  const tail = body.slice(sectionEnd);
  return `${head}${bullet}\n${tail}`;
}

/** Apply a structured plan change. Frontmatter moves only through the named fields. `--old` matches the body once. */
export function applyPlanUpdate(text, change) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw usage('plan-update: plan has no frontmatter');
  let fm;
  try {
    fm = YAML.parse(match[1], { maxAliasCount: 50 });
  } catch (error) {
    throw usage(`plan-update: frontmatter is invalid (${error.message})`);
  }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) throw usage('plan-update: frontmatter is invalid');

  if (change.status !== undefined) {
    if (!PLAN_STATUSES.includes(change.status)) {
      throw usage(`plan-update: --status must be one of ${PLAN_STATUSES.join('|')}`);
    }
    fm.status = change.status;
  }
  if (change.lock) fm.plan_lock = true;
  if (change.intent !== undefined) fm.intent = oneLine(change.intent, '--intent');
  if (change.intentSources?.length) fm.intent_sources = appendIntentSources(fm.intent_sources, change.intentSources);
  if (change.expectedOutputs?.length) fm.expected_outputs = appendLines(fm.expected_outputs, change.expectedOutputs, '--expected-output');
  if (change.successCriteria?.length) fm.success_criteria = appendLines(fm.success_criteria, change.successCriteria, '--success-criterion');
  if (change.verificationChecks?.length) fm.verification = appendChecks(fm.verification, change.verificationChecks);
  if (change.gapFulfillment?.length) fm.capability_gaps = fulfillGaps(fm.capability_gaps, change.gapFulfillment);

  const reviews = fm.reviews && typeof fm.reviews === 'object' && !Array.isArray(fm.reviews) ? fm.reviews : {};
  fm.reviews = {
    ...reviews,
    required: Array.isArray(reviews.required) ? reviews.required : [],
    completed: Array.isArray(reviews.completed) ? reviews.completed.slice() : [],
    critical_open: Array.isArray(reviews.critical_open) ? reviews.critical_open.slice() : [],
  };

  if (change.clearCritical && change.criticalOpen) {
    throw usage('plan-update: --clear-critical cannot be combined with --critical-open');
  }
  if (change.clearCritical) fm.reviews.critical_open = [];
  if (change.criticalOpen) {
    fm.reviews.critical_open = change.criticalOpen.map((item) => {
      const text = oneLine(item, '--critical-open');
      if (text.length > 200) throw usage('plan-update: --critical-open must be at most 200 characters');
      return text;
    });
  }
  for (const id of change.completed || []) {
    const review = oneLine(id, '--review-completed');
    if (!REVIEW_ID.test(review)) throw usage('plan-update: --review-completed must be a lowercase id');
    if (!fm.reviews.completed.includes(review)) fm.reviews.completed.push(review);
  }

  let body = text.slice(match[0].length).replace(/^(?:\r?\n)/, '');
  if (change.old !== undefined || change.next !== undefined) {
    if (typeof change.old !== 'string' || typeof change.next !== 'string') {
      throw usage('plan-update: --old and --new are required together');
    }
    if (change.old.length === 0) throw usage('plan-update: --old must not be empty');
    let count = 0;
    let from = 0;
    let at = -1;
    while (from <= body.length) {
      const found = body.indexOf(change.old, from);
      if (found === -1) break;
      if (count === 0) at = found;
      count += 1;
      from = found + change.old.length;
    }
    if (count !== 1) throw usage(`plan-update: --old matched ${count} times in the plan body`);
    body = body.slice(0, at) + change.next + body.slice(at + change.old.length);
  }
  for (const line of change.activity || []) {
    const text = oneLine(line, '--activity');
    if (text.length > 400) throw usage('plan-update: --activity must be at most 400 characters');
    body = appendActivity(body, text);
  }

  return `---\n${YAML.stringify(fm, { lineWidth: 0 })}---\n${body}`;
}

function stampLockedIntentSources(workspace, text, { rehash, mergeDiscovered }) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return text;
  let fm;
  try {
    fm = YAML.parse(match[1], { maxAliasCount: 50 });
  } catch {
    return text;
  }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm) || !fm.plan_lock) return text;
  const listed = Array.isArray(fm.intent_sources) ? fm.intent_sources : [];
  const locked = mergeDiscovered
    ? bindLockedIntentSources(workspace, listed, { query: typeof fm.intent === 'string' ? fm.intent : '' })
    : lockIntentSources(workspace, listed, { rehash });
  if (!locked.length) {
    if (!listed.length) return text;
    delete fm.intent_sources;
  } else {
    fm.intent_sources = locked;
  }
  const body = text.slice(match[0].length).replace(/^(?:\r?\n)/, '');
  return `---\n${YAML.stringify(fm, { lineWidth: 0 })}---\n${body}`;
}

function take(scan, index) {
  const value = scan[index + 1];
  if (value === undefined) throw usage(`plan-update: ${scan[index]} requires a value`);
  return { value, index: index + 1 };
}

function publishPlanFile(full, text) {
  const temporary = path.join(path.dirname(full), `.${path.basename(full)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: fs.statSync(full).mode & 0o777 });
    fs.renameSync(temporary, full);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function planUpdateActorCheck({ workspace, plan, input }) {
  if (!plan?.fm?.domain_parent) return { pass: true, message: 'No domain coordinator mutation authority' };
  const next = input?.action === 'amend' && input.authority?.scope === 'domain-intent' ? input.changes?.domainParent?.coordinator : null;
  if (!next) return domainCoordinatorCheck({ workspace, plan });
  try {
    const current = snapshotDomainCoordinator(workspace), accepted = plan.fm.domain_parent.coordinator;
    if (reviewHash({ ...current, initial_head: null }) !== reviewHash({ ...accepted, initial_head: null })) return { pass: false, message: 'A coordinator refresh must be accepted by the original coordinator physical identity' };
    return validateCoordinatorBinding(next.root, next);
  } catch (error) { return { pass: false, message: error.message }; }
}

function proposedDomainLink({ workspace, original, proposed, input, copilotHome }) {
  if (original.fm.domain_parent && input.action === 'amend' && input.authority?.scope === 'domain-intent' && input.changes?.domainParent?.coordinator) {
    return validateCoordinatorBinding(proposed.fm.domain_parent.coordinator.root, proposed.fm.domain_parent.coordinator);
  }
  return domainLinkCheck({ workspace, plan: proposed, copilotHome, home: planHome(workspace, proposed) });
}

function structuredPlanUpdate({ workspace, full, input, flags, dryRun, domainContext = null, home }) {
  validatePlanDecision(input);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const preview = loadPlan(workspace, full, { home, domainContext });
  if (!preview) throw usage('plan is unreadable');
  const actor = planUpdateActorCheck({ workspace, plan: preview, input });
  if (!actor.pass) throw usage(actor.message);
  return withPlanUpdateLock(full, () => {
    const plan = loadPlan(workspace, full, { home, domainContext });
    if (!plan) throw usage('plan is unreadable');
    const actor = planUpdateActorCheck({ workspace, plan, input });
    if (!actor.pass) throw usage(actor.message);
    const recordRoot = planRecordRoot(workspace, plan);
    const shared = () => sharedIntentCheck(workspace, plan, { home: planHome(workspace, plan) });
    const rel = `.harness/operations/plans/${reviewHash({ plan: plan.path, operation: input.id })}.json`;
    const inputDigest = reviewHash(input);
    const existing = readReviewRecord(recordRoot, rel);
    if (!existing && fs.lstatSync(path.join(recordRoot, rel), { throwIfNoEntry: false })) throw usage('operation identity has a corrupt journal');
    const operation = reviewHash({ plan: plan.path, inputDigest });
    if (existing && (existing.version !== 1 || existing.operation !== operation || existing.inputDigest !== inputDigest || existing.plan !== plan.path || existing.value?.plan !== plan.path || existing.value?.before !== input.expect || existing.value?.action !== input.action || typeof existing.value?.text !== 'string' || planRevision(existing.value.text) !== existing.value.after || reviewHash(existing.value) !== existing.integrity)) throw usage('operation identity has different or corrupt payload');
    if (existing?.state === 'completed') return { ...existing.result, replayed: true, currentRevision: planRevision(plan.text), current: planRevision(plan.text) === existing.value.after && intentSourcesCheck(plan, workspace).pass && gapEvidenceCheck(workspace, plan).pass && validatePlanSchema(plan).pass && shared().pass && domainLinkCheck({ workspace, plan, copilotHome, home: planHome(workspace, plan) }).pass && (input.action !== 'complete' || validateCompletion({ workspace, plan, copilotHome }).pass), allowedNextActions: ['Inspect current state; a replay does not renew an expired gate'] };
    if (existing && existing.state !== 'pending') throw usage('operation state is invalid');
    const current = planRevision(plan.text);
    if (existing ? ![existing.value.before, existing.value.after].includes(current) : input.expect !== current) throw usage('stale plan revision; reread before accepting a new decision');
    const recordedAt = existing?.value.recordedAt || new Date().toISOString();
    const decision = existing ? { text: existing.value.text, amendments: existing.value.amendments, authority: existing.value.authority } : applyPlanDecision(workspace, plan, input, { applyUpdate: applyPlanUpdate, recordedAt, copilotHome });
    const proposed = planWithText(plan, decision.text);
    const schema = validatePlanSchema(proposed);
    const missing = schema.checks.filter(check => !check.pass).map(check => check.message);
    let gate = null;
    if (input.action === 'start') {
      if (!existing) missing.push(...validatePlanReadiness(workspace, plan, { copilotHome }).checks.filter(check => !check.pass).map(check => check.message));
      gate = runGate({ workspace, flags: { ...flags, plan: plan.path, phase: 'implement' }, planOverride: proposed });
      missing.push(...gate.checks.filter(check => !check.pass).map(check => check.message));
      const scope = validatePlanScope({ workspace, plan: proposed });
      if (scope.status !== 'passed') missing.push(scope.message);
    }
    if (input.changes?.criteria) missing.push(...validatePlanReadiness(workspace, proposed, { copilotHome }).checks.filter(check => !check.pass).map(check => check.message));
    if (plan.fm.domain_binding || proposed.fm.domain_binding) {
      if (!sharedIntentCheck(workspace, proposed, { home: planHome(workspace, proposed) }).pass) missing.push('Accepted domain shared authority changed; explicitly amend it before publication');
      const link = proposedDomainLink({ workspace, original: plan, proposed, input, copilotHome });
      if (!link.pass) missing.push(link.message);
    }
    if (input.action === 'complete') {
      const prerequisites = completionPrerequisites({ workspace, plan: proposed, copilotHome });
      if (!prerequisites.pass) missing.push(prerequisites.message);
    }
    if (missing.length || gate && (!gate.pass || gate.exitCode !== 0)) {
      const checkReadiness = inspectCheckReadiness({ workspace, copilotHome, home: planHome(workspace, proposed) });
      return { status: 'blocked', path: full, missing: [...new Set(missing)], checkReadiness,
        allowedNextActions: checkReadiness.ready ? ['Repair the named prerequisites, then retry the same decision if the revision is unchanged'] : ['Engineer inspects the project tests and prepares the concrete check declarations; request person approval only after showing the changed commands, then resume this task'],
        ...(gate?.nextTools ? { nextTools: gate.nextTools } : {}), updated: false };
    }
    if (!decision.amendments.every(source => source.newHash === null || hashIntentFile(workspace, source.path) === source.newHash)) throw usage('intent source changed while applying the amendment');
    if (input.intentSelection && !intentSourcesCheck(proposed, workspace).pass) throw usage('selected intent source changed before amendment publication');
    if (gate && !intentSourcesCheck(proposed, workspace).pass) throw usage('selected intent source changed before start publication');
    const completion = input.action === 'complete' ? completeWork({ workspace, plan: proposed, copilotHome, dryRun }) : null;
    const affectedEvidence = planDigest(plan.text) === planDigest(proposed.text) ? null : {
      verification: readEvidence(recordRoot, plan.path)?.evidencePath || null,
      review: readReviewRecord(recordRoot, `.harness/reviews/latest/${recordHash(plan.path)}.json`)?.id || null,
      completion: readReviewRecord(recordRoot, `.harness/completions/${recordHash(plan.path)}.json`)?.id || null,
    };
    const value = existing?.value || { plan: plan.path, action: input.action, recordedAt, before: current, after: planRevision(decision.text), text: decision.text, amendments: decision.amendments, authority: decision.authority, affectedEvidence };
    const result = { version: 1, status: 'ok', path: full, operation, operationPath: rel, action: input.action, revision: value.after, planState: planState(proposed), amendments: value.amendments, authority: value.authority, affectedEvidence: value.affectedEvidence, completion: completion?.id || null, missing: [], allowedNextActions: input.action === 'start' ? ['Edit within the accepted scope', 'Run required review and verification'] : ['Inspect the updated contract', 'Start or refresh the implement gate before edits'], dryRun, updated: !dryRun && current !== value.after };
    const record = { version: 1, state: 'pending', plan: plan.path, inputDigest, operation, integrity: reviewHash(value), value, result };
    if (!dryRun) {
      publishReviewRecord(recordRoot, rel, record);
      planRecordRoot(workspace, proposed);
      const actor = planUpdateActorCheck({ workspace, plan, input });
      if (!actor.pass) throw usage(actor.message);
      const link = proposedDomainLink({ workspace, original: plan, proposed, input, copilotHome });
      if (!link.pass) throw usage(link.message);
      if (proposed.fm.domain_binding && !sharedIntentCheck(workspace, proposed, { home: planHome(workspace, proposed) }).pass) throw usage('Domain shared authority changed before publication');
      if (readFileNoFollow(full) !== plan.text) throw usage('plan changed during the operation; reread before retry');
      if (current !== value.after) publishPlanFile(full, value.text);
      if (gate) publishGateSession({ workspace, plan: proposed, result: gate, policy: loadPolicy(workspace, flags.enforcement, { copilotHome, home: planHome(workspace, proposed) }) });
      publishReviewRecord(recordRoot, rel, { ...record, state: 'completed' });
    }
    return result;
  });
}

export function updatePlanDecision({ workspace, home, domainContext = null, planPath, input, copilotHome, dryRun = false, flags = {} }) {
  if (input?.action === 'convert') return convertFullPlan({ workspace, home, domainContext, planPath, input, copilotHome, dryRun });
  const full = resolvePlanUpdateFile(workspace, planPath, { home, domainContext });
  return structuredPlanUpdate({ workspace, full, input, flags: { ...flags, copilotHome }, dryRun, domainContext, home });
}

export function convertFullPlan({ workspace, home = harnessGlobalHome(), domainContext = null, planPath, input, copilotHome, dryRun = false }) {
  const fields = ['version', 'id', 'action', 'expect', 'rationale', 'authority', 'changes'];
  const experiment = Boolean(input?.changes?.experiment);
  const validChanges = experiment ? Object.keys(input.changes).length === 1 : input?.changes && Object.keys(input.changes).length === 2 && input.changes.domain_child && input.changes.domain_binding;
  if (domainContext || input?.changes?.domain_parent) throw usage('Parent plans require fresh domain creation; project history cannot be moved into a parent');
  if (!input || Object.keys(input).some(key => !fields.includes(key)) || input.version !== 1 || input.action !== 'convert' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.id || '') || !/^[a-f0-9]{64}$/.test(input.expect || '') || typeof input.rationale !== 'string' || !input.rationale.trim() || input.authority?.scope !== (experiment ? 'experiment-intent' : 'domain-intent') || typeof input.authority.basis !== 'string' || !input.authority.basis.trim() || Object.keys(input.authority).some(key => !['scope', 'basis'].includes(key)) || !validChanges) throw usage('Conversion requires a revision-bound authored child domain or experiment decision with matching authority');
  const raw = typeof planPath === 'string' && planPath;
  if (!raw || !raw.endsWith('.md')) throw usage('Conversion requires an ordinary full .md plan');
  const requested = path.isAbsolute(raw) ? path.resolve(raw) : raw.includes('/') ? path.resolve(workspace, raw) : path.join(externalPlansDir(workspace, { home }), raw);
  const declaredRoots = planUpdateRoots(workspace, { home });
  const rawRoot = declaredRoots.find(candidate => contained(path.resolve(candidate), requested)) || path.parse(requested).root;
  if (!assertNoSymlinkAncestors(rawRoot, path.relative(rawRoot, requested))) throw usage('Conversion path is outside the safe project plan store');
  let full = canonicalPlanFilePath(requested);
  const roots = declaredRoots.map(realDirectory).filter(Boolean);
  let root = roots.find(candidate => contained(candidate, full));
  if (!root || !assertNoSymlinkAncestors(root, path.relative(root, full))) throw usage('Conversion path is outside the safe project plan store');
  const existingGuard = readPlanConversionGuard(workspace, full, { home });
  if (existingGuard?.legacy || existingGuard?.state === 'invalid') throw usage('Conversion has a legacy, ambiguous or corrupt guard; preserve the existing journal and repair its authority explicitly');
  if (existingGuard?.value) {
    full = canonicalPlanFilePath(existingGuard.value.oldPath);
    root = roots.find(candidate => contained(candidate, full));
    if (!root || !assertNoSymlinkAncestors(root, path.relative(root, full))) throw usage('Conversion path is outside the safe project plan store');
  }
  return withPlanUpdateLock(full, () => {
    const guard = readPlanConversionGuard(workspace, full, { home });
    if (guard?.legacy || guard?.state === 'invalid') throw usage('Conversion has a legacy, ambiguous or corrupt guard; preserve the existing journal and repair its authority explicitly');
    const recordRoot = projectStoreDir(workspace, { home });
    const rel = `.harness/operations/plans/${reviewHash({ plan: full, operation: input.id })}.json`;
    const prior = readReviewRecord(recordRoot, rel), inputDigest = reviewHash(input);
    if (!prior && fs.lstatSync(path.join(recordRoot, rel), { throwIfNoEntry: false })) throw usage('Conversion operation identity has a corrupt journal');
    const pointerPath = path.join(recordRoot, conversionPointerRel(full));
    if (fs.lstatSync(pointerPath, { throwIfNoEntry: false })) {
      let pointer;
      try { pointer = JSON.parse(readFileNoFollow(pointerPath, { root: recordRoot, maxBytes: 4096 })); } catch { throw usage('Conversion operation identity has a corrupt pointer'); }
      if (pointer?.version !== 1 || pointer.record !== rel || pointer.inputDigest !== inputDigest) throw usage('Conversion operation identity is reserved by another conversion or has a corrupt pointer');
    }
    const nextPath = full.replace(/\.md$/, '.hplan');
    if (prior && (prior.kind !== 'conversion' || prior.inputDigest !== inputDigest || prior.id !== recordHash(prior.value) || prior.value.oldPath !== full || prior.value.newPath !== nextPath || typeof prior.value.original !== 'string' || planRevision(prior.value.original) !== input.expect || prior.value.oldRevision !== input.expect || typeof prior.value.text !== 'string' || planRevision(prior.value.text) !== prior.value.newRevision)) throw usage('Conversion operation identity has different or corrupt payload');
    if (prior?.state === 'completed') {
      const current = loadPlan(workspace, nextPath, { home });
      return { ...prior.result, replayed: true, current: Boolean(current && current.fm.plan_id === prior.value.planId && !fs.lstatSync(full, { throwIfNoEntry: false }) && sharedIntentCheck(workspace, current, { home }).pass && domainLinkCheck({ workspace, plan: current, copilotHome, home }).pass) };
    }
    if (prior && prior.state !== 'pending') throw usage('Conversion journal state is invalid');
    const source = readFileNoFollow(full, { root, maxBytes: 1024 * 1024 });
    if (source === null && fs.lstatSync(full, { throwIfNoEntry: false })) throw usage('Conversion original plan is unsafe or unreadable');
    const original = prior?.value.original ?? source;
    if (original === null || planRevision(original) !== input.expect || (source !== null && source !== original)) throw usage('Stale plan revision; conversion cannot replace changed or missing original bytes');
    const plan = authorizeProjectPlan(planFromText(original, { path: full, fullPath: full }), home);
    if (Number(plan.fm.plan_schema) !== 2 || readPlanRecord(original) || plan.fm.domain_parent || plan.fm.domain_child || plan.fm.domain_binding || plan.fm.experiment || !plan.fm.plan_id) throw usage('Only ordinary schema 2 full plans with an existing UUID can convert to an extended contract');
    const fm = { ...plan.fm, plan_schema: experiment ? 4 : 3, ...(experiment ? { experiment: input.changes.experiment } : { domain_child: input.changes.domain_child, domain_binding: input.changes.domain_binding }) };
    const text = original.replace(/^---\r?\n[\s\S]*?\r?\n---/, `---\n${YAML.stringify(fm, { lineWidth: 0 })}---`);
    const proposed = authorizeProjectPlan(planFromText(text, { path: nextPath, fullPath: nextPath }), home);
    const schema = validatePlanSchema(proposed), shared = sharedIntentCheck(workspace, proposed, { home }), link = domainLinkCheck({ workspace, plan: proposed, copilotHome, home });
    if (!schema.pass || !shared.pass || !link.pass) throw usage(`Conversion contract is invalid: ${[...schema.checks.filter(check => !check.pass).map(check => check.message), !shared.pass && shared.message, !link.pass && link.message].filter(Boolean).join('; ')}`);
    const value = { oldPath: full, newPath: nextPath, oldRevision: input.expect, newRevision: planRevision(text), original, text, planId: plan.fm.plan_id };
    if (prior && recordHash(value) !== prior.id) throw usage('Conversion accepted contract changed while recovering');
    const destination = readFileNoFollow(nextPath, { root, maxBytes: 1024 * 1024 });
    if (destination === null && fs.lstatSync(nextPath, { throwIfNoEntry: false })) throw usage('Conversion destination is unsafe or unreadable');
    if (destination !== null && destination !== text) throw usage('Conversion destination already contains another plan');
    const result = { version: 1, status: 'ok', action: 'convert', path: nextPath, previousPath: full, revision: value.newRevision, planState: planState(proposed), updated: !dryRun, dryRun, invalidatedProof: true, ...(prior ? { replayed: true } : {}) };
    if (dryRun) return result;
    const record = prior || { version: 1, kind: 'conversion', state: 'pending', inputDigest, id: recordHash(value), value, result };
    publishReviewRecord(recordRoot, conversionPointerRel(full), { version: 1, record: rel, inputDigest });
    publishReviewRecord(recordRoot, rel, record);
    if (!sharedIntentCheck(workspace, proposed, { home }).pass || !domainLinkCheck({ workspace, plan: proposed, copilotHome, home }).pass || readFileNoFollow(full, { root, maxBytes: 1024 * 1024 }) !== source) throw usage('Authority or original plan changed before conversion retirement');
    if (source !== null) fs.unlinkSync(full);
    if (fs.lstatSync(full, { throwIfNoEntry: false }) || !sharedIntentCheck(workspace, proposed, { home }).pass || !domainLinkCheck({ workspace, plan: proposed, copilotHome, home }).pass) throw usage('Authority or original plan changed before conversion publication');
    const currentNext = readFileNoFollow(nextPath, { root, maxBytes: 1024 * 1024 });
    if (currentNext !== null && currentNext !== text) throw usage('Conversion destination changed before publication');
    if (currentNext === null && !writeFileContainedExclusive(root, path.relative(root, nextPath), text)) throw usage('Conversion destination exists or is unsafe');
    if (fs.lstatSync(full, { throwIfNoEntry: false }) || readFileNoFollow(nextPath, { root, maxBytes: 1024 * 1024 }) !== text) throw usage('Conversion paths changed before completion publication');
    publishReviewRecord(recordRoot, rel, { ...record, state: 'completed' });
    return result;
  });
}

export async function cmdPlanUpdate(argv) {
  const boundary = argv.indexOf('--');
  const scan = boundary === -1 ? argv : argv.slice(0, boundary);
  if (boundary !== -1 && boundary + 1 < argv.length) throw usage(`plan-update: unexpected argument ${argv[boundary + 1]}`);
  let workspace = process.cwd();
  let json = false;
  let dryRun = false;
  let planArg;
  let fileArg;
  const change = {
    activity: [],
    completed: [],
    expectedOutputs: [],
    successCriteria: [],
    verificationChecks: [],
    gapFulfillment: [],
    intentSources: [],
  };

  for (let i = 0; i < scan.length; i++) {
    const token = scan[i];
    if (token === '--file' || token.startsWith('--file=')) {
      if (fileArg !== undefined) throw usage('plan-update: --file accepts one JSON document; combine the decision into one file');
      if (token === '--file') ({ value: fileArg, index: i } = take(scan, i));
      else fileArg = token.slice('--file='.length);
      if (!fileArg) throw usage('plan-update: --file requires a path or - for stdin');
    } else if (token === '--plan') {
      ({ value: planArg, index: i } = take(scan, i));
    } else if (token === '--status') {
      ({ value: change.status, index: i } = take(scan, i));
    } else if (token === '--activity') {
      const next = take(scan, i);
      change.activity.push(next.value);
      i = next.index;
    } else if (token === '--review-completed') {
      const next = take(scan, i);
      change.completed.push(next.value);
      i = next.index;
    } else if (token === '--critical-open') {
      const next = take(scan, i);
      change.criticalOpen = change.criticalOpen || [];
      change.criticalOpen.push(next.value);
      i = next.index;
    } else if (token === '--clear-critical') {
      change.clearCritical = true;
    } else if (token === '--lock') {
      change.lock = true;
    } else if (token === '--intent') {
      ({ value: change.intent, index: i } = take(scan, i));
    } else if (token === '--intent-source') {
      const next = take(scan, i);
      change.intentSources.push(next.value);
      i = next.index;
    } else if (token === '--expected-output') {
      const next = take(scan, i);
      change.expectedOutputs.push(next.value);
      i = next.index;
    } else if (token === '--success-criterion') {
      const next = take(scan, i);
      change.successCriteria.push(next.value);
      i = next.index;
    } else if (token === '--verification-check') {
      const next = take(scan, i);
      change.verificationChecks.push(next.value);
      i = next.index;
    } else if (token === '--gap-fulfillment') {
      const next = take(scan, i);
      change.gapFulfillment.push(next.value);
      i = next.index;
    } else if (token === '--old') {
      ({ value: change.old, index: i } = take(scan, i));
    } else if (token === '--new') {
      ({ value: change.next, index: i } = take(scan, i));
    } else if (token === '--workspace' || token.startsWith('--workspace=')) {
      let value;
      if (token === '--workspace') ({ value, index: i } = take(scan, i));
      else value = token.slice('--workspace='.length);
      if (!value || value.startsWith('--')) throw usage('plan-update: --workspace requires a path');
      workspace = path.resolve(value);
    } else if (token === '--json') json = true;
    else if (token === '--dry-run') dryRun = true;
    else if (token === '--ae-home' || token === '--harness-home' || token === '--copilot-home' || token === '--no-events' || token === '--verbose' || token === '--no-color') {
      if (token !== '--no-events' && token !== '--verbose' && token !== '--no-color') i += 1;
    } else if (token.startsWith('-')) throw usage(`plan-update: unknown flag ${token}`);
    else throw usage(`plan-update: unexpected argument ${token}`);
  }

  const hasChange = change.status !== undefined
    || change.lock
    || change.intent !== undefined
    || change.intentSources.length > 0
    || change.activity.length > 0
    || change.completed.length > 0
    || change.expectedOutputs.length > 0
    || change.successCriteria.length > 0
    || change.verificationChecks.length > 0
    || change.gapFulfillment.length > 0
    || change.criticalOpen
    || change.clearCritical
    || change.old !== undefined
    || change.next !== undefined;
  if (!hasChange && !fileArg) throw usage('plan-update: provide a structured decision or a status, activity, review, or body change');

  const flags = parseFlags(argv);
  const home = flags.harnessHome || harnessGlobalHome();
  if (fileArg) {
    if (hasChange) throw usage('--file cannot be combined with legacy mutation flags');
    const content = fileArg === '-' ? readBoundedInput() : readFileNoFollow(path.resolve(workspace, fileArg), { maxBytes: 1024 * 1024 });
    if (content === null || content === '') throw usage(fileArg === '-' ? 'decision on stdin is missing, unreadable, or over 1 MiB' : 'decision file is missing, unsafe or over 1 MiB');
    let input;
    try { input = JSON.parse(content); } catch { throw usage('decision file must contain JSON'); }
    const result = updatePlanDecision({ workspace, home, planPath: planArg, input, flags, copilotHome: flags.copilotHome, dryRun });
    console.log(redactedJson(result));
    return result.status === 'blocked' ? 1 : 0;
  }
  const full = resolvePlanUpdateFile(workspace, planArg, { home });
  const lockDir = acquirePlanLock(full);
  let written;
  let original = '';
  let next = '';
  let completion = null;
  try {
    original = fs.readFileSync(full, 'utf8');
    const currentPlan = loadPlan(workspace, full);
    if (!currentPlan) throw usage('Plan is unreadable or has a pending conversion; recover the authored operation before changing it');
    if (Number(currentPlan?.fm.plan_schema) >= 3) throw usage('Extended plans require an authored --file decision');
    if (currentPlan?.fm.intent_source_policy === 'content-v1' && currentPlan.plan_lock) {
      if (change.intentSources.length) throw usage('selected sources are frozen; use an explicit amendment');
      if (change.lock && !intentSourcesCheck(currentPlan, workspace).pass) throw usage('selected intent source changed; use an explicit amendment instead of rehashing --lock');
    }
    next = applyPlanUpdate(original, change);
    if (change.lock || change.intentSources.length) {
      next = stampLockedIntentSources(workspace, next, {
        rehash: Boolean(change.lock) && !(currentPlan?.fm.intent_source_policy === 'content-v1' && currentPlan.plan_lock),
        mergeDiscovered: Boolean(change.lock) && !(currentPlan?.fm.intent_source_policy === 'content-v1' && currentPlan.plan_lock),
      });
    }
    if (change.status === 'done') {
      const plan = loadPlan(workspace, full);
      const fm = parsePlanFrontmatter(next);
      completion = completeWork({ workspace, plan: planWithText(plan, next), copilotHome: resolveCopilotHome(parseFlags(argv).copilotHome), dryRun });
    }
    if (!dryRun && next !== original) {
      publishPlanFile(full, next);
    }
    written = dryRun ? next : fs.readFileSync(full, 'utf8');
  } finally {
    releasePlanLock(lockDir);
  }
  const fm = YAML.parse(written.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  if (json) {
    console.log(redactedJson({
      path: full,
      updated: !dryRun && next !== original,
      dryRun,
      status: fm.status,
      reviews: fm.reviews,
      completion: completion?.id || null,
      revision: planRevision(written),
    }));
  } else {
    const ui = createStyle();
    console.log(ui.line({
      state: 'ok',
      key: 'plan-update',
      value: dryRun ? `would update ${full}` : full,
    }));
  }
  return 0;
}
