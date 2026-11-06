/** Installed-package contract evaluation. Native events below are deterministic
 * fixtures, never evidence that an editor or model actually ran a child agent.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CORE_CORPUS_MANIFEST, corpusDigest, corpusInventory, materializeMinimalCorpus } from './core-corpus.mjs';
import { createLifecycleFixture, seedEnterprise, seedPaymentProject, forwardTask, writeFile, run, requireExit, PAYMENT_FIXED } from './lifecycle-fixture.mjs';
import { npmCommand } from '../../test/helpers/npm-launch.mjs';

export { CORE_CORPUS_MANIFEST, forwardTask };

/** Prefer npm-cli.js through Node; never interpolate unsafe archive paths into cmd. */
export function lifecycleNpmCommand(args) {
  const invocation = npmCommand(args);
  if (invocation.args[0] === '/d' && invocation.args[1] === '/s' && invocation.args[2] === '/c') {
    assert.ok(args.every(value => typeof value === 'string' && value.length > 0 && !/[\s"%!^&|<>()\u0000-\u001f]/.test(value)), 'Windows npm shell fallback requires plain arguments; install npm-cli.js to preserve paths containing spaces or command characters');
  }
  return invocation;
}

export function installLifecyclePackage({ packageRoot, directory }) {
  fs.mkdirSync(directory, { recursive: true });
  const pack = lifecycleNpmCommand(['pack', '--ignore-scripts', '--json', '--pack-destination', directory]);
  const packed = requireExit(run(pack.command, pack.args, { cwd: packageRoot }), 0, 'npm pack');
  assert.ok(Array.isArray(packed) && packed[0]?.filename, 'npm pack must return a tarball');
  const tarball = path.join(directory, packed[0].filename);
  const prefix = path.join(directory, 'installation');
  const install = lifecycleNpmCommand(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, tarball]);
  requireExit(run(install.command, install.args), 0, 'offline installed tarball');
  const name = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).name;
  const installedPackageRoot = path.join(prefix, 'node_modules', name);
  assert.ok(fs.existsSync(path.join(installedPackageRoot, 'bin/ae.mjs')));
  assert.equal(fs.lstatSync(installedPackageRoot).isSymbolicLink(), false, 'evaluation must execute an installed package, not a source link');
  return { installedPackageRoot, tarball };
}

// Runtime files are immutable during this evaluation. Hard links retain each
// package's own import paths while avoiding three copies of bundled WASM in a
// small test tmpfs. Corpus files are copied independently before reduction.
function cloneInstalledPackage(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const immutable = (from, to) => {
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) {
      const target = fs.realpathSync(from);
      if (!target.startsWith(source + path.sep)) throw new Error(`Installed evaluation runtime redirects outside its package: ${from}`);
      const clonedTarget = path.join(destination, path.relative(source, target));
      fs.symlinkSync(path.relative(path.dirname(to), clonedTarget), to, fs.statSync(target).isDirectory() ? 'dir' : 'file');
      return;
    }
    if (stat.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      for (const entry of fs.readdirSync(from)) immutable(path.join(from, entry), path.join(to, entry));
    } else {
      try { fs.linkSync(from, to); }
      catch (error) { if (['EXDEV', 'EPERM', 'ENOTSUP'].includes(error.code)) fs.copyFileSync(from, to); else throw error; }
    }
  };
  for (const entry of fs.readdirSync(source)) {
    if (entry === 'corpus') fs.cpSync(path.join(source, entry), path.join(destination, entry), { recursive: true, dereference: false });
    else immutable(path.join(source, entry), path.join(destination, entry));
  }
}

export function prepareForwardAdaptiveFixture({ packageRoot, directory, corpus = 'minimal' }) {
  const installed = installLifecyclePackage({ packageRoot, directory: path.join(directory, 'package') });
  if (corpus !== 'full') materializeMinimalCorpus(installed.installedPackageRoot, { sparse: corpus === 'sparse' });
  const fx = createLifecycleFixture({ directory: path.join(directory, 'fixture'), installedPackageRoot: installed.installedPackageRoot, sourcePackageRoot: packageRoot, corpus });
  seedEnterprise(fx);
  seedPaymentProject(fx);
  requireExit(fx.cli(['host', 'setup', '--host', 'claude-code']), 0, 'forward fixture host setup');
  fx.json(['resources', 'discover'], discoveryInput(fx));
  requireExit(fx.cli(['trust', 'approve']), 0, 'forward fixture named-check consent');
  return { fx, prompt: forwardTask(fx) };
}

function discoveryInput(fx, extra = {}) {
  return { schema: 1, operation: 'configure', roots: [
    { path: fx.configHome, kind: 'config', host: 'claude-code', scope: 'personal', included: true },
    { path: fx.skillsHome, kind: 'skills', host: 'claude-code', scope: 'personal', included: true },
    { path: fx.enterpriseRoot, kind: 'config', host: 'copilot', scope: 'enterprise', included: true },
  ], ongoing: true, autoIncludeNew: true, autoUpdate: true, exclusions: ['excluded-private', 'code-simplicity-reviewer', ...(fx.bootstrap ? ['enterprise-payment-reviewer'] : [])], grants: { tools: ['read', 'search', 'edit', 'execute', 'agent'], agents: [], create: ['agent', 'skill', 'instruction'], update: ['agent', 'skill', 'instruction'], memory: true, decision: true, budgets: { maxDecisions: 100, maxRepairs: 3, maxAcquisitions: 5, maxSeconds: 3600 } }, ...extra };
}

const query = (fx, text, taskId) => fx.json(['resources', 'discover'], { schema: 1, operation: 'query', query: text, taskId });
const rows = result => result.resources || [];
const has = (result, name) => rows(result).some(row => row.name === name || row.id === name);
const textDigest = text => `sha256-${createHash('sha256').update(text).digest('hex')}`;

function observeDecision(fx, prepared, verdict, suffix) {
  const requestId = prepared.requestId;
  assert.ok(requestId, JSON.stringify(prepared));
  const output = { schema: 1, requestId, verdict, reason: 'Scoped fixture judgment based on current source and executable evidence.', evidence: ['src/payment.mjs'] };
  requireExit(fx.hook('post', { session_id: prepared.packet?.sessionId || fx.sessionId, tool_name: 'Agent', tool_input: { subagent_type: 'decision-agent' }, tool_use_id: `fixture-decision-${suffix}`, tool_response: { content: [{ type: 'text', text: JSON.stringify(output) }] }, success: true }), 0, 'native decision completion fixture');
  return fx.json(['resources', 'decision'], { schema: 1, operation: 'record', requestId });
}

function observeSkillRead(fx, name, source = path.join(fx.skillsHome, name, 'SKILL.md')) {
  requireExit(fx.hook('post', { session_id: fx.sessionId, tool_name: 'Read', tool_input: { file_path: source }, tool_response: { content: fs.readFileSync(source, 'utf8') }, success: true }), 0, `source-bound ${name} read fixture`);
}

function decisionRequest(fx, type, context = {}, extra = {}) {
  return fx.json(['resources', 'decision'], { schema: 1, operation: 'prepare', taskId: `payment-${type}`, sessionId: fx.sessionId, type, intent: 'Prevent duplicate payment capture and prepare a verified human handoff.', action: { tool: 'Bash', input: { command: `${JSON.stringify(process.execPath)} --test test/payment.test.mjs` }, cwd: fx.workspace }, sources: ['src/payment.mjs', 'test/payment.test.mjs'], context, ...extra });
}

function nativePre(fx, payload, { denied = false } = {}) {
  const result = requireExit(fx.hook('pre', { session_id: fx.sessionId, ...payload }), 0, 'native delegation admission fixture');
  assert.equal(result.hookSpecificOutput?.permissionDecision === 'deny', denied, JSON.stringify(result));
  return result;
}

function observeReview(fx, packet, results, suffix) {
  const payload = { tool_name: 'Agent', tool_input: { subagent_type: fx.reviewAgent, prompt: `Independently assess current immutable review packet ${packet.id}.` }, tool_use_id: `fixture-review-${suffix}` };
  nativePre(fx, payload);
  requireExit(fx.hook('post', { session_id: fx.sessionId, ...payload, tool_response: { content: [{ type: 'text', text: JSON.stringify({ schema: 1, packet: packet.id, results }) }] }, success: true }), 0, 'source-bound native review result fixture');
}

function acquireFixtureSkill(fx, name, text) {
  const prepared = decisionRequest(fx, 'capability', { missingCapability: name, reason: 'The bootstrap installation needs this bounded procedure for the payment change.', capabilityText: text }, { taskId: `sparse-${name}-acquisition`, capability: { operation: 'create', kind: 'skill', name, textDigest: textDigest(text), tools: [], agents: [] } });
  const receipt = observeDecision(fx, prepared, 'acquire', `sparse-${name}`);
  assert.equal(receipt.verdict, 'acquire', JSON.stringify(receipt));
  const created = fx.json(['resources', 'create', 'skill', name], { schema: 1, text });
  assert.equal(created.status, 'ok', JSON.stringify(created));
  const resolved = rows(query(fx, name, `sparse-created-${name}`)).find(row => row.kind === 'skill' && row.id === name);
  assert.ok(resolved, `created ${name} skill was not adopted into the catalog`);
  assert.equal(resolved.digest, textDigest(text), 'catalog did not bind the exact acquired skill source');
  assert.equal(resolved.path, path.join(fx.skillsHome, name, 'SKILL.md'));
  observeSkillRead(fx, name);
  const activation = JSON.parse(fs.readFileSync(path.join(fx.workspace, '.harness/session.json'), 'utf8')).activatedSkills?.[name];
  assert.equal(activation?.complete, true, 'actual acquired skill read did not produce source-bound activation');
  assert.equal(activation.source.path, resolved.path);
  assert.equal(activation.source.sha256, resolved.digest.replace(/^sha256-/, ''));
  return { name, action: receipt.verdict, source: resolved.path, sha256: activation.source.sha256, actualSourceRead: true };
}

const summary = result => JSON.stringify({ status: result.status, resources: rows(result).map(row => ({ id: row.id, path: row.path })), counts: result.counts, refreshed: result.refreshed, refreshBlocked: result.refreshBlocked });

function check(arm, id, fn) {
  try { const evidence = fn(); arm.checks.push({ id, pass: true, evidence }); return evidence; }
  catch (error) { arm.checks.push({ id, pass: false, error: error.message }); throw error; }
}

function runArm({ packageRoot, installedPackageRoot, root, corpus, forbiddenCorpusRoots = [], acquireDesignSkill = false }) {
  const fx = createLifecycleFixture({ directory: root, installedPackageRoot, sourcePackageRoot: packageRoot, corpus, forbiddenCorpusRoots });
  const arm = { corpus, inventory: corpusInventory(path.join(installedPackageRoot, 'corpus')), checks: [], pass: false };
  let acquiredProvider;
  try {
    seedEnterprise(fx);
    seedPaymentProject(fx);
    requireExit(fx.cli(['host', 'setup', '--host', 'claude-code']), 0, 'selected host setup');
    observeSkillRead(fx, 'engineer');
    let configured;
    check(arm, 'consent-persistence', () => {
      configured = fx.json(['resources', 'discover'], discoveryInput(fx));
      assert.equal(configured.configured, true);
      observeSkillRead(fx, 'enterprise-payments', path.join(fx.enterpriseRoot, 'skills/enterprise-payments/SKILL.md'));
      const skill = query(fx, 'enterprise-payments', 'consent-session-two');
      assert.equal(has(skill, 'enterprise-payments'), true, summary(skill));
      assert.equal(has(query(fx, 'excluded-private', 'excluded-session'), 'excluded-private'), false);
      for (const resource of rows(skill)) assert.ok(!String(resource.path).startsWith(path.join(packageRoot, 'corpus')), 'selection leaked original corpus');
      return { policyRevision: skill.policyRevision, selected: rows(skill).map(row => ({ name: row.id, path: row.path })), freshProcesses: true };
    });
    if (acquireDesignSkill) check(arm, 'bootstrap-diagnostics', () => {
      const result = fx.cli(['doctor']);
      assert.ok([0, 6].includes(result.status), `${result.stdout}\n${result.stderr}`);
      const diagnosed = JSON.parse(result.stdout);
      const core = diagnosed.checks.filter(row => row.id === 'H7' && !row.optional);
      assert.equal(core.length, CORE_CORPUS_MANIFEST.bootstrapSkills.length, JSON.stringify(diagnosed));
      assert.equal(core.every(row => row.pass), true, JSON.stringify(core));
      assert.deepEqual(core.map(row => row.skill).sort(), [...CORE_CORPUS_MANIFEST.bootstrapSkills].sort());
      const optional = diagnosed.checks.filter(row => row.id === 'H7' && ['auto-compound', 'auto-skill-draft'].includes(row.skill));
      assert.equal(optional.length, 2);
      for (const row of optional) {
        assert.equal(row.optional, true);
        assert.equal(row.available, false);
        assert.equal(row.status, 'unavailable');
        assert.match(row.hint, /acquir|ensure-capability/i);
      }
      return { requiredWorkflowSkills: core.map(row => row.skill), optionalWorkflows: optional.map(row => ({ skill: row.skill, status: row.status, hint: row.hint })), bootstrapSkills: [...CORE_CORPUS_MANIFEST.bootstrapSkills] };
    });
    if (acquireDesignSkill) check(arm, 'sparse-skill-acquisition', () => {
      for (const name of CORE_CORPUS_MANIFEST.optionalSkillDependencies) {
        assert.equal(fs.existsSync(path.join(installedPackageRoot, 'corpus/skills', name, 'SKILL.md')), false, `${name} was retained in sparse package`);
        assert.equal(has(query(fx, name, `sparse-${name}`), name), false, `${name} leaked from another package`);
      }
      for (const name of ['code-implementer', 'plan-coordinator', 'code-review-coordinator', 'java-reviewer', 'performance-oracle', 'code-simplicity-reviewer']) assert.equal(fs.existsSync(path.join(installedPackageRoot, 'corpus/agents', `${name}.agent.md`)), false, name);
      const text = '---\nname: architect\ndescription: Bounded architecture consultation for payment state ownership and retry boundaries.\nuser-invocable: false\n---\n# Architecture consultation\nIdentify state ownership and order-scoped request identity. Examine duplicate delivery and amount conflicts before the ledger mutation. Bind the design to executable behavioral checks; do not claim database atomicity from this in-memory fixture.\n\n## Should trigger\n- Identify the owner of payment retry state.\n- Assess duplicate delivery before a ledger mutation.\n- Design order-scoped request identity and amount conflict handling.\n\n## Should not trigger\n- Publish a production release.\n- Translate user-facing copy.\n- Change an unrelated authentication policy.\n';
      const reviewText = '---\nname: code-review\ndescription: Review a payment change using an independent selected provider and executable source evidence.\nuser-invocable: false\n---\n# Code review\nPrepare an immutable review packet from the current diff. Consult the independently invocable payment reviewer selected by the current packet; acquire and activate that provider when absent. An implementation self-review does not satisfy coverage. Assemble concrete findings against source and named checks, create a source-bound tour, and verify the current packet before requesting human review.\n\n## Should trigger\n- Review a payment retry implementation before human handoff.\n- Recheck changed source after a reviewer finding is repaired.\n- Establish independent review coverage for a payment change.\n\n## Should not trigger\n- Approve an unrelated production deployment.\n- Replace a missing behavioral test with a prose claim.\n- Invent a native reviewer invocation record.\n';
      const acquired = [acquireFixtureSkill(fx, 'architect', text), acquireFixtureSkill(fx, 'code-review', reviewText)];
      const validation = requireExit(fx.cli(['resources', 'validate']), 0, 'sparse native primitive validation');
      assert.equal(validation.status, 'ok', JSON.stringify(validation));
      return { action: 'acquire', acquired, actualSourceRead: acquired.every(row => row.actualSourceRead), validation: validation.status };
    });
    check(arm, 'bounded-miss-refresh', () => {
      assert.equal(has(query(fx, 'enterprise-refunds', 'refund-task-before'), 'enterprise-refunds'), false);
      writeFile(fx.enterpriseRoot, 'skills/enterprise-refunds/SKILL.md', '---\nname: enterprise-refunds\ndescription: Enterprise refund reconciliation procedure.\nuser-invocable: false\n---\n# Refund reconciliation\nCheck captured receipts before applying a refund.\n');
      const bounded = query(fx, 'enterprise-refunds', 'refund-task-before');
      assert.equal(has(bounded, 'enterprise-refunds'), false, 'one task must not repeatedly refresh the same miss');
      const refreshed = query(fx, 'enterprise-refunds', 'refund-task-after');
      assert.equal(has(refreshed, 'enterprise-refunds'), true, summary(refreshed));
      return { selected: rows(refreshed).map(row => row.id), refreshed: refreshed.refreshed, sameTaskRefreshBounded: true };
    });
    check(arm, 'native-action-decision', () => {
      const prepared = decisionRequest(fx, 'action');
      const unobserved = fx.cli(['resources', 'decision', '--file', '-'], { input: { schema: 1, operation: 'record', requestId: prepared.requestId } });
      assert.notEqual(unobserved.status, 0, 'an unobserved declaration authorized a native action');
      const receipt = observeDecision(fx, prepared, 'allow', 'action');
      assert.equal(receipt.authorized, true, JSON.stringify(receipt));
      const status = () => fx.json(['resources', 'decision'], { schema: 1, operation: 'status', taskId: 'payment-action', requestId: prepared.requestId });
      assert.equal(status().current, true);
      const source = fs.readFileSync(path.join(fx.workspace, 'src/payment.mjs'), 'utf8');
      fs.appendFileSync(path.join(fx.workspace, 'src/payment.mjs'), '// changed after action judgment\n');
      assert.equal(status().current, false, 'changed action source retained approval');
      writeFile(fx.workspace, 'src/payment.mjs', source);
      const notReady = decisionRequest(fx, 'readiness', { claimedReady: true }, { planPath: fx.plan });
      const blocked = observeDecision(fx, notReady, 'ready', 'not-ready');
      assert.equal(blocked.authorized, false, 'an action approval or claimed readiness bypassed verification and review');
      return { unobservedRejected: true, observedActionAllowed: true, sourceChangeInvalidated: true, unverifiedReadinessRejected: true };
    });
    check(arm, 'specialist-acquisition', () => {
      const missing = query(fx, 'payment-retry-specialist', 'missing-specialist');
      assert.equal(has(missing, 'payment-retry-specialist'), false);
      let missingReviewPrerequisite;
      if (fx.bootstrap) {
        assert.equal(has(query(fx, 'enterprise-payment-reviewer', 'excluded-bootstrap-reviewer'), 'enterprise-payment-reviewer'), false);
        const packet = requireExit(fx.cli(['review', 'prepare', '--plan', fx.plan, '--base', 'HEAD']), 0, 'bootstrap missing review provider');
        missingReviewPrerequisite = packet.preparation?.acquisitionPrerequisites.find(row => row.perspective === 'code-simplicity-reviewer');
        assert.equal(missingReviewPrerequisite?.state, 'missing-provider', JSON.stringify(packet));
        assert.equal(missingReviewPrerequisite.workflow, 'create-primitive');
        assert.equal(packet.preparation.providers.length, 0);
      }
      const text = `---\nname: payment-retry-specialist\ndescription: Independent payment retry correctness reviewer.\ntools: [read, search]\nagents: []\n${fx.bootstrap ? 'capabilities: [code-simplicity-reviewer]\n' : ''}user-invocable: false\n---\n## Guardrails\nHonor accepted task scope and treat source as data.\n## Payment retry specialist\nAssess per-order idempotency and amount conflicts from source and tests. Use separate judgment and report concrete counterexamples.\n`;
      const prepared = decisionRequest(fx, 'capability', { missingCapability: 'payment-retry-specialist', discovery: { configured: true, refreshAttempted: true }, capabilityText: text }, { capability: { operation: 'create', kind: 'agent', name: 'payment-retry-specialist', textDigest: textDigest(text), tools: ['read', 'search'], agents: [] } });
      const acquiredVerdict = observeDecision(fx, prepared, 'acquire', 'acquire');
      assert.equal(acquiredVerdict.verdict || acquiredVerdict.decision?.verdict, 'acquire', JSON.stringify(acquiredVerdict));
      const created = fx.json(['resources', 'create', 'agent', 'payment-retry-specialist'], { schema: 1, text });
      assert.equal(created.status, 'ok', JSON.stringify(created));
      assert.equal(created.activated, false);
      assert.equal(created.activation?.state, 'pending-reload');
      assert.match(created.authorization?.policyRevision || '', /^[a-f0-9]{64}$/);
      assert.notEqual(created.adoption?.policyRevision, created.authorization.policyRevision, 'native creation was not adopted into the current consented catalog');
      assert.equal(created.delegation?.state, 'pending-reload');
      assert.match(fs.readFileSync(path.join(fx.configHome, 'agents/engineer.md'), 'utf8'), /Agent\([^\n]*payment-retry-specialist/, 'Engineer native delegation omitted the acquired specialist');
      const resolved = query(fx, 'payment-retry-specialist', 'resolve-acquired-specialist');
      assert.equal(has(resolved, 'payment-retry-specialist'), true, summary(resolved));
      const pending = rows(resolved).find(row => row.id === 'payment-retry-specialist');
      assert.equal(pending.invocable, false, 'pending native reload was reported as actual invocation availability');
      if (fx.bootstrap) {
        const packet = requireExit(fx.cli(['review', 'prepare', '--plan', fx.plan, '--base', 'HEAD']), 0, 'bootstrap pending reviewer activation');
        assert.equal(packet.preparation.acquisitionPrerequisites.find(row => row.perspective === 'code-simplicity-reviewer')?.state, 'activation-unavailable', JSON.stringify(packet));
      }
      const invocation = { tool_name: 'Agent', tool_input: { subagent_type: 'payment-retry-specialist', prompt: 'Assess the current payment retry identity and mutation boundary before implementation.' }, tool_use_id: 'fixture-specialist-first-invocation' };
      requireExit(fx.hook('post', { session_id: fx.sessionId, ...invocation, tool_use_id: 'fixture-specialist-uncorrelated', tool_response: { content: 'Uncorrelated completion must not activate a newly published role.' }, success: true }), 0, 'uncorrelated specialist completion fixture');
      assert.equal(rows(query(fx, 'payment-retry-specialist', 'uncorrelated-specialist')).find(row => row.id === 'payment-retry-specialist').invocable, false, 'an uncorrelated successful payload activated the new native role');
      fx.sessionId = 'lifecycle-session-reloaded';
      observeSkillRead(fx, 'engineer');
      observeSkillRead(fx, 'enterprise-payments', path.join(fx.enterpriseRoot, 'skills/enterprise-payments/SKILL.md'));
      for (const name of ['architect', 'code-review']) if (fs.existsSync(path.join(fx.skillsHome, name, 'SKILL.md'))) observeSkillRead(fx, name);
      const probe = decisionRequest(fx, 'action', { purpose: 'Permit one exact native invocation attempt for the published specialist; availability is established only by a correlated successful completion.' }, { taskId: 'first-native-specialist-invocation', planPath: fx.plan, action: { tool: 'Agent', input: invocation.tool_input, cwd: fx.workspace } });
      const allowed = observeDecision(fx, probe, 'allow', 'first-specialist-invocation');
      assert.equal(allowed.authorized, true, JSON.stringify(allowed));
      nativePre(fx, invocation);
      nativePre(fx, invocation, { denied: true });
      requireExit(fx.hook('post', { session_id: fx.sessionId, ...invocation, tool_response: { content: 'Assess order-scoped identity, duplicate ledger writes, amount conflicts, and executable negative controls before the ledger mutation.' }, success: true }), 0, 'correlated specialist completion fixture');
      const available = rows(query(fx, 'payment-retry-specialist', 'observed-specialist-availability')).find(row => row.id === 'payment-retry-specialist');
      assert.equal(available?.invocable, true, 'correlated first native invocation did not resolve pending activation');
      assert.equal(available.activation, 'available');
      assert.equal(available.digest, pending.digest);
      assert.equal(available.nativeQualification, 'observed-invocation');
      assert.equal(available.activationEvidence?.loadedSourceHash, 'unverified');
      assert.equal(available.activationEvidence?.sessionId, fx.sessionId);
      assert.equal(available.activationEvidence?.requestId, probe.requestId);
      assert.equal(available.activationEvidence?.receiptId, allowed.id);
      assert.equal(available.activationEvidence?.toolUseId, invocation.tool_use_id);
      acquiredProvider = available;
      return { decision: acquiredVerdict.verdict || acquiredVerdict.decision?.verdict, creation: created.status, missingReviewPrerequisite, initialActivation: created.activation, activation: available.activationEvidence, source: available.path, nativeFirstInvocationFixture: true, liveModelInvocation: false };
    });
    check(arm, 'verification-negative-control', () => {
      requireExit(fx.cli(['trust', 'approve']), 0, 'approve disposable project checks');
      requireExit(fx.cli(['gate', '--phase', 'implement', '--plan', fx.plan]), 0, 'disposable implementation gate');
      const failed = fx.cli(['checks', 'run', 'payment-behavior']);
      assert.notEqual(failed.status, 0, 'seeded duplicate-charge defect escaped the behavioral check');
      assert.match(`${failed.stdout}\n${failed.stderr}`, /fail|failed/i);
      writeFile(fx.workspace, 'src/payment.mjs', PAYMENT_FIXED);
      const passed = requireExit(fx.cli(['checks', 'run', 'payment-behavior']), 0, 'repaired behavioral check');
      return { seededDefectRejected: true, repairedCheckPassed: true, status: passed.status || passed.outcome?.status };
    });
    let packet, tourInput;
    check(arm, 'independent-review', () => {
      packet = requireExit(fx.cli(['review', 'prepare', '--plan', fx.plan, '--base', 'HEAD']), 0, 'external review preparation');
      const selected = packet.preparation?.providers || [];
      const provider = selected.find(row => row.name === fx.reviewAgent);
      assert.ok(provider, JSON.stringify(packet));
      if (fx.bootstrap) {
        assert.equal(provider.path, acquiredProvider.path, 'bootstrap review did not select the acquired native role');
        assert.equal(provider.digest, acquiredProvider.digest);
        assert.equal(path.dirname(provider.path), path.join(fx.configHome, 'agents'));
      }
      const results = packet.required.map(reviewer => ({ reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [], provenance: { kind: 'host-invocation', agent: fx.reviewAgent, via: 'engineer' } }));
      const self = fx.json(['review', 'assemble', '--plan', fx.plan, '--packet', packet.id], { packet: packet.id, results: results.map(result => ({ ...result, provenance: { kind: 'self-review', agent: 'engineer', via: 'engineer' } })) }, 1);
      assert.equal(self.coverage.complete, false, JSON.stringify(self));
      const unobserved = fx.json(['review', 'assemble', '--plan', fx.plan, '--packet', packet.id], { packet: packet.id, results }, 1);
      assert.equal(unobserved.coverage.complete, false, 'authored provider provenance replaced an observed native result');
      observeReview(fx, packet, results, 'first-task');
      const assembled = fx.json(['review', 'assemble', '--plan', fx.plan, '--packet', packet.id], { packet: packet.id, results });
      assert.equal(assembled.coverage.complete, true, JSON.stringify(assembled));
      return { packet: packet.id, selected, acquiredNativeProviderUsed: fx.bootstrap, selfReviewRejected: true, unobservedProvenanceRejected: true, observedNativeResultRequired: true, assurance: 'Deterministic source-bound native result fixture; no live model invocation claimed.' };
    });
    check(arm, 'source-bound-tour', () => {
      const ref = (file, line) => ({ path: file, line });
      const tour = { schema: 1, packet: packet.id, purpose: 'Prevent duplicate charges when payment delivery is retried.', before: 'Repeated delivery appended another ledger entry.', after: 'A matching retry returns the original receipt; amount conflicts reject before mutation.', context: { summary: 'Payment capture validates the order and amount before consulting the order-scoped ledger identity.', components: [{ id: 'capture', label: 'Payment capture', role: 'changed', source: ref('src/payment.mjs', 1) }, { id: 'ledger', label: 'Receipt ledger', role: 'context', source: ref('src/payment.mjs', 5) }, { id: 'tests', label: 'Behavioral checks', role: 'context', source: ref('test/payment.test.mjs', 1) }], edges: [{ from: 'capture', to: 'ledger', claim: 'A matching request returns the prior receipt before any ledger mutation.', kind: 'observed', evidence: [ref('src/payment.mjs', 5), ref('src/payment.mjs', 8)] }, { from: 'tests', to: 'capture', claim: 'The duplicate-delivery check compares receipt identity and ledger length.', kind: 'observed', evidence: [ref('test/payment.test.mjs', 4)] }] }, readingOrder: [{ step: 'Read validation and order-scoped retry lookup.', component: 'capture', code: [ref('src/payment.mjs', 1), ref('src/payment.mjs', 5)], tests: [ref('test/payment.test.mjs', 4)] }, { step: 'Read conflict rejection before mutation, then its behavioral assertions.', component: 'ledger', code: [ref('src/payment.mjs', 7), ref('src/payment.mjs', 11)], tests: [ref('test/payment.test.mjs', 12)] }], verification: [{ claim: 'Retry, amount conflict, order scope and invalid inputs are checked.', refs: [ref('test/payment.test.mjs', 4), ref('test/payment.test.mjs', 12), ref('test/payment.test.mjs', 19)] }], risks: ['This fixture uses an in-memory ledger; database transaction isolation is outside its scope.'], questions: ['Does the production storage boundary enforce the same order and request identity atomically?'] };
      tourInput = tour;
      const created = fx.json(['review', 'tour', '--plan', fx.plan, '--packet', packet.id], tour);
      assert.ok(created.id && created.persisted, JSON.stringify(created));
      const before = fs.readFileSync(path.join(fx.workspace, 'src/payment.mjs'), 'utf8');
      fs.appendFileSync(path.join(fx.workspace, 'src/payment.mjs'), '// source changed after tour\n');
      const stale = fx.cli(['review', 'tour', '--plan', fx.plan, '--packet', packet.id, '--file', '-'], { input: tour });
      assert.notEqual(stale.status, 0, 'a stale reviewed source retained tour readiness');
      writeFile(fx.workspace, 'src/payment.mjs', before);
      return { tour: created.id || created.tour?.id, sourceChangeRejected: true, diagram: created.diagram || created.tour?.diagram };
    });
    check(arm, 'verified-human-handoff', () => {
      const verified = requireExit(fx.cli(['verify', '--plan', fx.plan, '--base', 'HEAD']), 0, 'verified human handoff');
      assert.equal(verified.outcome, 'passed', JSON.stringify({ outcome: verified.outcome, failures: verified.checks?.filter(row => row.status === 'failed') }));
      const prepared = decisionRequest(fx, 'readiness', { purpose: 'Human review handoff after independent review and named verification.' }, { taskId: 'payment-final-readiness', planPath: fx.plan });
      const receipt = observeDecision(fx, prepared, 'ready', 'ready');
      assert.equal(receipt.verdict, 'ready', JSON.stringify(receipt));
      assert.equal(receipt.authorized, true);
      return { passedVerification: true, readiness: receipt.verdict, observedInvocation: receipt.observedInvocation };
    });
    check(arm, 'cross-session-memory', () => {
      requireExit(fx.cli(['knowledge', 'on']), 0, 'knowledge on');
      const claim = 'Use integer minor currency units for payment receipts.';
      const learned = requireExit(fx.cli(['correct', claim, '--trigger', 'payment receipt currency units', '--authority', 'instruction', '--why', 'The user explicitly requires stable currency arithmetic.', '--applies', 'The service stores payment receipt amounts.', '--does-not-apply', 'The UI formats display amounts.', '--domain', 'payments']), 0, 'persist explicit teaching');
      const next = requireExit(fx.cli(['orient', '--read', '--query', 'payment receipt currency units', '--context-version', '2']), 0, 'later-session memory recall');
      assert.ok(JSON.stringify(next).includes('integer minor currency'), JSON.stringify(next));
      return { learningId: learned.learningId, futureOrientationContainsTeaching: true, freshProcesses: true };
    });
    check(arm, 'verified-learning-recurrence', () => {
      const published = new Set();
      const memoryReceipts = [];
      const publish = (plan, operation) => {
        const args = ['compound', '--plan', plan, '--learning-decision', '-'];
        const input = { operation, decision: 'publish', rationale: 'The verified task established a reusable payment retry check.', scope: 'private', title: 'Order-scoped payment retry validation', body: 'Review duplicate receipt identity and amount conflicts before ledger mutation. Preserve integer minor currency units and exercise invalid input cases.', category: 'payments', tags: ['payments', 'retry'], trigger: 'payment retry validation', claim: 'Validate request identity within each order before writing the ledger.' };
        if (!published.has(operation)) {
          const previewResult = fx.cli([...args, '--dry-run'], { input });
          assert.ok([0, 2].includes(previewResult.status), `${previewResult.stdout}\n${previewResult.stderr}`);
          const preview = JSON.parse(previewResult.stdout.trim() || previewResult.stderr.trim());
          const memory = preview.memoryDecision;
          assert.ok(memory, 'publication preview omitted the exact native memory decision descriptor');
          assert.equal(memory.scope, 'private');
          assert.equal(fs.existsSync(memory.destination), false, 'decision preview published memory before its approval');
          assert.match(memory.contentDigest, /^sha256-[a-f0-9]{64}$/);
          assert.match(memory.proofIdentity, /^[a-f0-9]{64}$/);
          assert.equal(typeof preview.memoryContent, 'string', 'memory judgment omitted the proposed raw content');
          assert.equal(textDigest(preview.memoryContent), memory.contentDigest);
          const prepared = decisionRequest(fx, 'memory', { purpose: 'Publish a verified task lesson with exact destination, serialized bytes and proof.', memoryContent: preview.memoryContent }, { taskId: `memory-${operation}`, planPath: plan, memory });
          const receipt = observeDecision(fx, prepared, 'allow', `memory-${operation}`);
          assert.equal(receipt.authorized, true, JSON.stringify(receipt));
        }
        const result = requireExit(fx.cli(args, { input }), 0, 'verified private compounding');
        if (!published.has(operation)) {
          assert.match(result.memoryDecisionReceipt || '', /^[a-f0-9]{64}$/, 'actual publication did not consume its observed exact memory decision');
          memoryReceipts.push(result.memoryDecisionReceipt);
          published.add(operation);
        }
        return result;
      };
      const first = publish(fx.plan, 'lifecycle-first-payment-task');
      assert.equal(first.pass, true, JSON.stringify(first));
      const observedAgent = first.resourceUses?.find(row => row.kind === 'agent' && row.name === fx.reviewAgent);
      assert.ok(observedAgent, 'verified publication omitted the actual observed reviewer source');
      const selectedReviewer = packet.preparation.providers.find(row => row.name === fx.reviewAgent);
      assert.equal(observedAgent.path, selectedReviewer.path);
      assert.equal(observedAgent.sha256, selectedReviewer.digest.replace(/^sha256-/, ''));
      assert.equal(observedAgent.loadedSourceHash, 'unverified');
      assert.equal(observedAgent.reviewUse?.schema, 1);
      assert.equal(observedAgent.reviewUse?.packet, packet.id);
      assert.equal(observedAgent.reviewUse?.sessionId, fx.sessionId);
      assert.equal(observedAgent.reviewUse?.plan, fx.plan);
      assert.equal(observedAgent.reviewUse?.workspace, fx.workspace);
      assert.match(observedAgent.reviewUse?.observationId || '', /^[a-f0-9]{64}$/);
      assert.equal(publish(fx.plan, 'lifecycle-first-payment-task').replayed, true, 'an idempotent publication replay became another task');
      const episode = fs.readFileSync(first.publishedPath, 'utf8');
      assert.match(episode, /resource_uses:/, 'verified episode omitted observed loaded resources');
      assert.ok(episode.includes(path.join(fx.enterpriseRoot, 'skills/enterprise-payments/SKILL.md')), 'verified episode omitted the approved external skill source');
      const secondPlan = '.harness/plans/2026-11-06-payment-invalid-amounts.md';
      const secondText = fs.readFileSync(path.join(fx.workspace, fx.plan), 'utf8').replaceAll('Payment retry correctness', 'Payment non-finite amount coverage').replaceAll('Make payment delivery idempotent within each order.', 'Prove non-finite and sub-cent amounts cannot mutate the payment ledger.');
      writeFile(fx.workspace, secondPlan, secondText);
      fs.appendFileSync(path.join(fx.workspace, 'test/payment.test.mjs'), `\ntest('non-finite and sub-cent amounts cannot mutate the ledger', () => {\n  const ledger = [];\n  for (const amount of [NaN, Infinity, 0.001]) assert.throws(() => capturePayment({ id: 'order-1', status: 'ready' }, { id: 'r', amount }, ledger));\n  assert.equal(ledger.length, 0);\n});\n`);
      requireExit(fx.cli(['gate', '--phase', 'implement', '--plan', secondPlan]), 0, 'second distinct task gate');
      const secondPacket = requireExit(fx.cli(['review', 'prepare', '--plan', secondPlan, '--base', 'HEAD']), 0, 'second distinct task review');
      const results = secondPacket.required.map(reviewer => ({ reviewer, status: 'completed', findings: [], residual_risks: [], testing_gaps: [], provenance: { kind: 'host-invocation', agent: fx.reviewAgent, via: 'engineer' } }));
      observeReview(fx, secondPacket, results, 'second-task');
      const reviewed = fx.json(['review', 'assemble', '--plan', secondPlan, '--packet', secondPacket.id], { packet: secondPacket.id, results });
      assert.equal(reviewed.coverage.complete, true);
      const addedTestLine = fs.readFileSync(path.join(fx.workspace, 'test/payment.test.mjs'), 'utf8').split('\n').findIndex(line => line.includes("test('non-finite and sub-cent amounts")) + 1;
      assert.ok(addedTestLine > 0);
      const addedTest = { path: 'test/payment.test.mjs', line: addedTestLine };
      fx.json(['review', 'tour', '--plan', secondPlan, '--packet', secondPacket.id], { ...tourInput, packet: secondPacket.id, purpose: 'Extend payment validation evidence to non-finite and sub-cent input.', before: 'The retry suite lacked explicit non-finite and sub-cent mutation checks.', after: 'The added test rejects NaN, Infinity and a sub-cent amount while proving the ledger remains empty.', readingOrder: [...tourInput.readingOrder, { step: 'Read the amount conversion and guard beside the new invalid-amount no-mutation assertions.', component: 'tests', code: [{ path: 'src/payment.mjs', line: 3 }, { path: 'src/payment.mjs', line: 4 }], tests: [addedTest] }], verification: [...tourInput.verification, { claim: 'Non-finite and sub-cent requests cannot mutate the ledger.', refs: [addedTest] }] });
      assert.equal(requireExit(fx.cli(['verify', '--plan', secondPlan, '--base', 'HEAD']), 0, 'second distinct task verification').outcome, 'passed');
      const second = publish(secondPlan, 'lifecycle-second-payment-task');
      assert.equal(second.pass, true, JSON.stringify(second));
      const candidates = requireExit(fx.cli(['resources', 'candidates']), 0, 'recurrence after reopening');
      const repeated = (candidates.resourceUseRecurrence || []).find(candidate => candidate.detail?.resource?.kind === 'skill' && candidate.detail.resource.name === 'enterprise-payments');
      assert.ok(repeated, 'two distinct verified task episodes did not surface external skill recurrence');
      assert.equal(repeated.count, 2, 'publication replay inflated distinct verified task evidence');
      assert.equal(repeated.tasks.length, 2);
      assert.equal(repeated.verifiedTaskEvidence, true);
      const repeatedAgent = (candidates.resourceUseRecurrence || []).find(candidate => candidate.detail?.resource?.kind === 'agent' && candidate.detail.resource.name === fx.reviewAgent);
      assert.ok(repeatedAgent, 'two verified native review outputs did not produce source-bound agent recurrence');
      assert.equal(repeatedAgent.count, 2);
      assert.equal(repeatedAgent.tasks.length, 2);
      assert.equal(repeatedAgent.verifiedTaskEvidence, true);
      const next = requireExit(fx.cli(['orient', '--read', '--context-version', '2', '--query', 'enterprise-payments payment retry']), 0, 'later-session recurrence orientation');
      assert.equal(next.coverage?.renderBarrier, false, `verified recurrence made the next-session context unavailable: ${JSON.stringify(next.coverage)}`);
      assert.ok(next.slice?.adaptation, 'later orientation omitted the adaptation context');
      assert.ok(JSON.stringify(next.slice.adaptation).includes('enterprise-payments'), 'later orientation omitted the recurrence recommendation');
      return { privateEpisodes: [first.publishedPath, second.publishedPath], memoryReceipts, recurrence: repeated, agentRecurrence: repeatedAgent, sourceBoundExternalSkill: true, sourceBoundObservedReviewer: observedAgent, futureOrientationContainsRecommendation: true };
    });
    check(arm, 'exclusion-revocation', () => {
      const current = query(fx, 'enterprise-payments', 'before-revoke');
      assert.equal(has(current, 'enterprise-payments'), true);
      const frozen = fx.json(['resources', 'discover'], discoveryInput(fx, { expectedRevision: current.policyRevision, ongoing: false }));
      writeFile(fx.enterpriseRoot, 'skills/enterprise-settlement/SKILL.md', '---\nname: enterprise-settlement\ndescription: Enterprise settlement reconciliation procedure.\nuser-invocable: false\n---\n# Settlement\nReconcile captured receipts against the settlement batch.\n');
      const blocked = query(fx, 'enterprise-settlement', 'discovery-no-ongoing-consent');
      assert.equal(blocked.refreshBlocked, true, 'inclusion consent was mistaken for ongoing scan consent');
      assert.equal(has(blocked, 'enterprise-settlement'), false);
      assert.equal(has(query(fx, 'enterprise-payments', 'frozen-existing-resource'), 'enterprise-payments'), true, 'disabling ongoing scans discarded an already-included source');
      const prepared = decisionRequest(fx, 'action', { purpose: 'Verify standing authority freshness independently of unchanged source bytes.' }, { taskId: 'revoke-current-action' });
      assert.equal(observeDecision(fx, prepared, 'allow', 'before-revoke').authorized, true);
      const revoked = fx.json(['resources', 'discover'], discoveryInput(fx, { expectedRevision: frozen.policyRevision, ongoing: false, roots: discoveryInput(fx).roots.map(root => ({ ...root, included: false })) }));
      assert.equal(has(query(fx, 'enterprise-payments', 'after-revoke'), 'enterprise-payments'), false);
      assert.equal(has(query(fx, 'excluded-private', 'after-revoke-excluded'), 'excluded-private'), false);
      const stale = fx.json(['resources', 'decision'], { schema: 1, operation: 'status', taskId: 'revoke-current-action', requestId: prepared.requestId });
      assert.equal(stale.current, false, 'revoked standing consent retained an action approval');
      assert.match(stale.reason, /authority|revoked/i);
      return { policyRevision: revoked.policyRevision, revokedResourceSelectable: false, ongoingConsentIndependent: true, actionApprovalRevoked: true };
    });
    arm.pass = true;
  } catch (error) { arm.error = error.message; }
  return arm;
}

function runSparseCase({ packageRoot, installedPackageRoot, root, forbiddenCorpusRoots = [] }) {
  const sparse = path.join(root, 'package');
  cloneInstalledPackage(installedPackageRoot, sparse);
  const inventory = materializeMinimalCorpus(sparse, { sparse: true });
  const arm = runArm({ packageRoot, installedPackageRoot: sparse, root: path.join(root, 'fixture'), corpus: 'sparse', forbiddenCorpusRoots, acquireDesignSkill: true });
  return { ...arm, inventory: { skills: inventory.skills, agents: inventory.agents }, optionalAbsent: [...CORE_CORPUS_MANIFEST.optionalSkillDependencies], action: arm.checks.find(row => row.id === 'sparse-skill-acquisition')?.evidence?.action, sharedReferencesPresent: fs.existsSync(path.join(sparse, 'corpus/skills/references/plan-operations.md')) && fs.existsSync(path.join(sparse, 'corpus/skills/codebase-context/references/diagrams.md')), noFullCorpusFallback: true };
}

export function runAdaptiveLifecycle({ packageRoot, keepArtifacts = false, corpora = ['full', 'minimal', 'sparse'] } = {}) {
  assert.ok(path.isAbsolute(packageRoot || ''), 'packageRoot must be explicit and absolute');
  assert.ok(Array.isArray(corpora) && corpora.length > 0 && new Set(corpora).size === corpora.length && corpora.every(name => ['full', 'minimal', 'sparse'].includes(name)), 'corpora must select distinct full, minimal or sparse cases');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-installed-lifecycle-'));
  const original = corpusDigest(path.join(packageRoot, 'corpus'));
  try {
    const { installedPackageRoot } = installLifecyclePackage({ packageRoot, directory: path.join(root, 'packed') });
    const installedOriginal = corpusDigest(path.join(installedPackageRoot, 'corpus'));
    const reduced = path.join(root, 'minimal-package');
    if (corpora.includes('minimal')) {
      cloneInstalledPackage(installedPackageRoot, reduced);
      materializeMinimalCorpus(reduced);
    }
    const arms = [];
    if (corpora.includes('full')) arms.push(runArm({ packageRoot, installedPackageRoot, root: path.join(root, 'full-fixture'), corpus: 'full' }));
    if (corpora.includes('minimal')) arms.push(runArm({ packageRoot, installedPackageRoot: reduced, root: path.join(root, 'minimal-fixture'), corpus: 'minimal', forbiddenCorpusRoots: [path.join(installedPackageRoot, 'corpus')] }));
    const sparse = corpora.includes('sparse') ? runSparseCase({ packageRoot, installedPackageRoot, root: path.join(root, 'sparse'), forbiddenCorpusRoots: [path.join(installedPackageRoot, 'corpus'), path.join(reduced, 'corpus')] }) : null;
    const fullCorpusUnchanged = corpusDigest(path.join(packageRoot, 'corpus')) === original;
    const fullInstalledCorpusUnchanged = corpusDigest(path.join(installedPackageRoot, 'corpus')) === installedOriginal;
    return { schema: 1, evaluatedCorpora: [...corpora], pass: arms.every(arm => arm.pass) && (!sparse || sparse.pass) && fullCorpusUnchanged && fullInstalledCorpusUnchanged, qualification: { installedPackage: true, freshCliProcesses: true, nativeHookFixtures: true, liveModel: false, liveEditor: false, note: 'Recorded native completion payloads validate adapter contracts. Independent live-agent and editor qualification must be reported separately.' }, arms, sparse, fullCorpusUnchanged, fullInstalledCorpusUnchanged, ...(keepArtifacts ? { directory: root } : {}) };
  } finally { if (!keepArtifacts) fs.rmSync(root, { recursive: true, force: true }); }
}
