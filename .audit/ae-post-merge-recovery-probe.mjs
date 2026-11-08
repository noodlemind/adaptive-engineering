import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  assert.ok(['--runtime-root', '--output', '--source-revision'].includes(process.argv[index]), `Unknown option ${process.argv[index]}`);
  assert.ok(process.argv[index + 1], `Missing value for ${process.argv[index]}`);
  values.set(process.argv[index], process.argv[index + 1]);
}
const runtimeRoot = path.resolve(values.get('--runtime-root') || path.join(repository, 'packages/ae'));
const output = path.resolve(values.get('--output') || path.join(repository, '.audit/ae-post-merge-recovery-evidence.json'));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-post-merge-recovery-'));
const primary = path.join(fixture, 'product'), home = path.join(fixture, 'state'), copilot = path.join(fixture, 'copilot');
const remote = path.join(fixture, 'remote.git');
for (const directory of [primary, home, copilot]) fs.mkdirSync(directory);
const emptyConfig = path.join(fixture, 'empty-git-config');
fs.writeFileSync(emptyConfig, '');
const environmentKeys = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'ComSpec', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'];
const env = Object.fromEntries(environmentKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
Object.assign(env, {
  AE_HOME: home, HARNESS_HOME: home, COPILOT_HOME: copilot, HARNESS_NO_EVENTS: '1',
  GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'AE recovery fixture', GIT_AUTHOR_EMAIL: 'recovery@example.test',
  GIT_COMMITTER_NAME: 'AE recovery fixture', GIT_COMMITTER_EMAIL: 'recovery@example.test',
});
const hash = value => createHash('sha256').update(value).digest('hex');
const owners = ['package.json', 'bin/ae.mjs', 'lib/compound.mjs', 'lib/completion.mjs', 'lib/evidence.mjs', 'lib/verify.mjs', 'lib/review.mjs', 'lib/review-synthesis.mjs', 'lib/plan-new.mjs', 'lib/plan-update.mjs', 'lib/plan-parse.mjs', 'lib/init-repo.mjs', 'lib/project-authority.mjs', 'corpus/hooks/lib/project-authority.mjs', 'lib/worktree.mjs', 'lib/trust.mjs', 'lib/project-layout.mjs'];
const sourceFiles = Object.fromEntries(owners.map(file => [file, hash(fs.readFileSync(path.join(runtimeRoot, file)))]));
const revision = values.get('--source-revision') || null;
let sourceTree = null;
if (revision) {
  assert.match(revision, /^[a-f0-9]{40,64}$/);
  const tree = spawnSync('git', ['-C', repository, 'rev-parse', `${revision}^{tree}`], { env, encoding: 'utf8' });
  assert.equal(tree.status, 0, tree.stderr);
  sourceTree = tree.stdout.trim();
  for (const file of owners) {
    const committed = spawnSync('git', ['-C', repository, 'show', `${revision}:packages/ae/${file}`], { env, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(committed.status, 0, committed.stderr?.toString());
    assert.equal(hash(committed.stdout), sourceFiles[file], `${file} differs from the declared source revision`);
  }
}
const receipt = {
  schema: 1, generatedAt: new Date().toISOString(), outcome: 'running',
  source: { runtimeRoot, revision, tree: sourceTree, declaredOwnerBytesMatch: revision ? true : null, packageVersion: JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'))).version, probeSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))), files: sourceFiles },
  runtime: { node: process.version, executable: process.execPath, platform: process.platform },
  fixture: { root: fixture, primary, remote, home, copilot },
  qualification: { surface: 'actual CLI in disposable Git repositories', planCreation: 'plan-new full schema2 with content-bound intent and revision-bound lifecycle decisions; extended domain/experiment hplan formats are outside this probe', liveEditor: 'unverified', reviewJudgment: 'synthetic packet-bound declarations; independence remains unverified', activeClaimSupersession: 'not exercised', episodeReplacement: 'not implemented or claimed' },
  branches: [], assertions: [], steps: [],
};
const save = () => fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
function requireValue(condition, label) {
  assert.ok(condition, label);
  receipt.assertions.push(label);
}
function run(kind, label, cwd, args, input) {
  const result = spawnSync(kind === 'git' ? 'git' : process.execPath, kind === 'git' ? args : [path.join(runtimeRoot, 'bin/ae.mjs'), ...args, '--workspace', cwd, '--ae-home', home, '--copilot-home', copilot, '--json', '--no-events'], {
    cwd, env, encoding: 'utf8', input, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  });
  let value;
  try { value = JSON.parse(result.stdout); } catch { value = null; }
  receipt.steps.push({ kind, label, cwd, args, status: result.status, signal: result.signal,
    ...(result.error ? { error: result.error.message } : {}),
    ...(value ? { result: { pass: value.pass, outcome: value.outcome, path: value.path, publishedPath: value.publishedPath, blockedReason: value.blockedReason,
      trusted: value.trusted, inherited: value.inherited, inheritedFrom: value.inheritedFrom, id: value.id, revision: value.revision, planState: value.planState,
      checks: value.checks?.map(check => ({ id: check.id, status: check.status, proof: check.proof })),
      coverage: value.coverage, reviewProvenance: value.results?.map(entry => ({ reviewer: entry.reviewer, provenance: entry.provenance })),
      work: value.work, state: value.state, message: value.message } } : { stdout: result.stdout?.trim() }),
    ...(result.stderr?.trim() ? { stderr: result.stderr.trim() } : {}),
  });
  save();
  return { ...result, value };
}
function git(cwd, ...args) {
  const result = run('git', args[0], cwd, args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function cli(cwd, ...args) { return run('ae', args[0], cwd, args); }
function passed(cwd, ...args) {
  const result = cli(cwd, ...args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.value;
}
function decision(cwd, plan, data) {
  const result = run('ae', 'compound decision', cwd, ['compound', '--plan', plan, '--learning-decision', '-'], JSON.stringify(data));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.value.pass, true);
  return result.value;
}
function planUpdate(cwd, plan, action, id, fields = {}) {
  const observed = passed(cwd, 'status', '--contract-digest', '--plan', plan);
  const data = { version: 1, action, id, expect: observed.revision, ...fields };
  const result = run('ae', `plan-update ${action}`, cwd, ['plan-update', '--plan', plan, '--file', '-'], JSON.stringify(data));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.value;
}
function review(cwd, plan, base) {
  const packet = passed(cwd, 'review', 'prepare', '--plan', plan, '--base', base);
  const results = packet.required.map(reviewer => ({ reviewer, status: 'completed', findings: [],
    residual_risks: ['Synthetic fixture tests record binding, not reviewer judgment.'],
    testing_gaps: ['No live model review was invoked.'], provenance: { kind: 'fixture-assertions' } }));
  const result = run('ae', 'review assemble', cwd, ['review', 'assemble', '--plan', plan, '--packet', packet.id, '--file', '-'], JSON.stringify({ packet: packet.id, results }));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  requireValue(result.value.coverage.complete, `${path.basename(cwd)} has current packet-bound required review coverage`);
  requireValue(result.value.results.every(entry => entry.provenance.independence === 'unverified'), `${path.basename(cwd)} review provenance does not invent model invocation`);
  return packet.id;
}
try {
  git(fixture, 'init', '--bare', remote);
  git(primary, 'init', '-b', 'main');
  fs.mkdirSync(path.join(primary, 'src'));
  fs.mkdirSync(path.join(primary, 'docs/specs'), { recursive: true });
  fs.mkdirSync(path.join(primary, '.github/harness'), { recursive: true });
  fs.writeFileSync(path.join(primary, '.gitignore'), '.harness/\n.worktrees/\n');
  fs.writeFileSync(path.join(primary, 'src/retry.mjs'), 'export const retrySettings = () => ({ attempts: 3, pauseMs: 500 });\n');
  fs.writeFileSync(path.join(primary, 'behavior.mjs'), "import assert from 'node:assert/strict';\nimport { retrySettings } from './src/retry.mjs';\nassert.deepEqual(retrySettings({ attempts: 7, pauseMs: 20 }), { attempts: 7, pauseMs: 20 });\nassert.deepEqual(retrySettings(), { attempts: 3, pauseMs: 500 });\n");
  fs.writeFileSync(path.join(primary, 'docs/specs/retry.md'), '# Retry settings\nHonor configured attempts and pause while retaining defaults of three attempts and a 500 ms pause. Preserve the release-specific parent and exported retrySettings interface.\n');
  fs.writeFileSync(path.join(primary, '.github/harness/policy.yaml'), 'version: 1\nenforcement: enforce\n');
  fs.writeFileSync(path.join(primary, '.github/harness/checks.yaml'), `version: 1\nchecks:\n  behavior:\n    command: ${JSON.stringify([process.execPath, './behavior.mjs'])}\n`);
  git(primary, 'remote', 'add', 'origin', remote);
  passed(primary, 'install', '--target', 'cli');
  passed(primary, 'init-repo');
  git(primary, 'add', '.');
  git(primary, 'commit', '-m', 'Common release parent');
  const alphaBase = git(primary, 'rev-parse', 'HEAD');
  git(primary, 'branch', 'release/alpha');
  git(primary, 'switch', '-c', 'release/beta');
  fs.writeFileSync(path.join(primary, 'release.txt'), 'beta has a distinct pipeline parent\n');
  git(primary, 'add', 'release.txt');
  git(primary, 'commit', '-m', 'Beta release parent');
  const betaBase = git(primary, 'rev-parse', 'HEAD');
  requireValue(alphaBase !== betaBase, 'The two release branches have different accepted parent commits');
  git(primary, 'switch', 'main');
  git(primary, 'push', 'origin', 'main', 'release/alpha', 'release/beta');
  git(primary, 'fetch', 'origin');
  passed(primary, 'trust', 'approve');
  const { externalPlansDir } = await import(pathToFileURL(path.join(runtimeRoot, 'lib/project-layout.mjs')));
  const plans = externalPlansDir(primary, { home });
  fs.mkdirSync(plans, { recursive: true });
  const corrected = 'export const retrySettings = ({ attempts = 3, pauseMs = 500 } = {}) => ({ attempts, pauseMs });\n';

  for (const [name, base] of [['alpha', alphaBase], ['beta', betaBase]]) {
    const worktree = passed(primary, 'worktree', '--slug', `${name}-delivery`, '--from', `origin/release/${name}`).path;
    const trust = passed(worktree, 'trust', 'status');
    requireValue(trust.trusted && trust.inherited, `${name} original worktree inherits current primary trust`);
    const creation = run('ae', 'plan-new', worktree, ['plan-new', '--file', '-'], JSON.stringify({ version: 1, format: 'full', type: 'fix', slug: `${name}-retry`,
      goal: `Honor configurable retry settings on release/${name}.`, acceptance: ['Configured attempts and pause are honored.'],
      constraints: [`Preserve the release/${name} parent and exported interface.`], scope: ['src/retry.mjs'], outputs: ['src/retry.mjs'],
      check: 'behavior', intentSources: ['docs/specs/retry.md'], phases: [{ title: 'Configurable retry', tasks: ['Implement configurable retry settings.'] }] }));
    assert.equal(creation.status, 0, creation.stderr || creation.stdout);
    const plan = creation.value.path;
    const planBytes = fs.readFileSync(plan, 'utf8');
    const planId = planBytes.match(/^plan_id: ([0-9a-f-]+)$/m)?.[1];
    requireValue(/^[0-9a-f-]{36}$/.test(planId || ''), `${name} current plan has a persistent authored work identity`);
    requireValue(planBytes.includes('plan_schema: 2') && planBytes.includes('intent_source_policy: content-v1') && planBytes.includes('path: docs/specs/retry.md') && planBytes.includes(hash(fs.readFileSync(path.join(worktree, 'docs/specs/retry.md')))), `${name} current full-plan creation binds the selected intent bytes`);
    planUpdate(worktree, plan, 'start', `${name}-start`);
    requireValue(fs.readFileSync(plan, 'utf8').includes('status: in-progress'), `${name} original external plan remains in-progress`);
    const broken = cli(worktree, 'verify', '--plan', plan, '--base', base);
    requireValue(broken.status !== 0 && broken.value.checks.some(check => check.id === 'behavior' && check.status !== 'passed'), `${name} behavioral proof rejects the original hardcoded implementation`);
    passed(worktree, 'gate', '--plan', plan, '--phase', 'implement');
    fs.writeFileSync(path.join(worktree, 'src/retry.mjs'), corrected);
    planUpdate(worktree, plan, 'progress', `${name}-implementation`, { progress: { criteria: ['AC1'], tasks: ['P1T1'] } });
    const beforeReview = cli(worktree, 'verify', '--plan', plan, '--base', base);
    requireValue(beforeReview.status !== 0 && beforeReview.value.checks.some(check => check.id === 'required-reviews' && check.status !== 'passed'), `${name} verification requires collected review coverage`);
    const originalReview = review(worktree, plan, base);
    const verified = passed(worktree, 'verify', '--plan', plan, '--base', base);
    requireValue(verified.outcome === 'passed', `${name} in-progress plan verifies before completion`);
    const originalLearning = decision(worktree, plan, { operation: `${name}-precommit-learning`, decision: 'publish', scope: 'private',
      rationale: 'Preserve the verified correction and the precise historical baseline.', title: `${name} retry settings`, category: 'reliability',
      body: `On release/${name}, base ${base} used hardcoded three attempts and a 500 ms pause. This verified correction accepts configured settings while preserving those defaults. The verification ran before the implementation commit.` });
    const originalLearningHash = hash(fs.readFileSync(originalLearning.publishedPath));
    requireValue(fs.readFileSync(plan, 'utf8').includes('status: in-progress'), `${name} verified learning publication does not require done status`);
    git(worktree, 'add', 'src/retry.mjs');
    git(worktree, 'commit', '-m', `${name} configurable retry`);
    const target = git(worktree, 'rev-parse', 'HEAD');
    const stale = cli(worktree, 'compound', '--plan', plan);
    requireValue(stale.status !== 0 && /different head/.test(stale.value.blockedReason), `${name} committing the implementation invalidates precommit proof`);
    let completedDeliveryLearning = null;
    if (name === 'alpha') {
      review(worktree, plan, base);
      requireValue(passed(worktree, 'verify', '--plan', plan, '--base', base).outcome === 'passed', 'Alpha first fix obtains fresh committed-head proof before completion');
      const publication = decision(worktree, plan, { operation: 'alpha-delivery-completion', decision: 'publish', scope: 'private',
        rationale: 'Complete the first fix against its committed delivery target.', title: 'Alpha committed retry correction', category: 'reliability',
        body: `Release/alpha correction ${target} accepts configured retry settings while retaining defaults of three attempts and a 500 ms pause. This lesson is bound to the committed first fix.` });
      completedDeliveryLearning = { path: publication.publishedPath, sha256: hash(fs.readFileSync(publication.publishedPath)) };
      planUpdate(worktree, plan, 'complete', 'alpha-delivery-complete');
      requireValue(passed(worktree, 'status', '--validate-completion', '--plan', plan).pass, 'Alpha first fix is completed before original worktree cleanup');
    }
    const initialPlanStatus = fs.readFileSync(plan, 'utf8').match(/^status: (.+)$/m)?.[1];
    requireValue(initialPlanStatus === (name === 'alpha' ? 'done' : 'in-progress'), `${name} original plan has the intended ${name === 'alpha' ? 'completed' : 'in-progress'} recovery state`);
    git(worktree, 'push', 'origin', `harness/${name}-delivery:feature/${name}-retry`);
    receipt.branches.push({ name, acceptedBase: base, originalWorktree: worktree, plan, planId, target, originalReview, initialPlanStatus, completedDeliveryLearning, originalLearning: { path: originalLearning.publishedPath, sha256: originalLearningHash } });
  }
  const originalPlanPaths = fs.readdirSync(plans).filter(name => /\.(md|hplan)$/.test(name)).sort();
  requireValue(originalPlanPaths.length === 2, 'Exactly the two original external plans exist before merge recovery');

  for (const branch of receipt.branches) {
    git(primary, 'switch', `release/${branch.name}`);
    git(primary, 'merge', '--ff-only', `harness/${branch.name}-delivery`);
    git(primary, 'push', 'origin', `release/${branch.name}`);
    git(primary, 'worktree', 'remove', '--force', branch.originalWorktree);
    requireValue(!fs.existsSync(branch.originalWorktree) && fs.existsSync(branch.plan), `${branch.name} original checkout records are removed while its external plan survives`);
    const trust = passed(primary, 'trust', 'status');
    requireValue(trust.trusted, `${branch.name} loss of checkout proof does not mean no trusted workspace exists`);
    const missing = cli(primary, 'compound', '--plan', branch.plan);
    requireValue(missing.status !== 0 && /No ae verify evidence artifact/.test(missing.value.blockedReason), `${branch.name} missing workspace evidence is reported independently of trust`);
  }
  git(primary, 'switch', 'main');
  const originalMain = git(primary, 'rev-parse', 'main');
  git(primary, 'push', 'origin', 'release/alpha:main');
  git(primary, 'fetch', 'origin');
  const observedRemoteMain = git(primary, 'rev-parse', 'origin/main');
  requireValue(originalMain !== observedRemoteMain, 'Local main remains behind observed origin/main during recovery');
  git(primary, 'merge-base', '--is-ancestor', originalMain, observedRemoteMain);
  receipt.fixture.localMain = originalMain;
  receipt.fixture.observedOriginMain = observedRemoteMain;

  for (const branch of receipt.branches) {
    const worktree = passed(primary, 'worktree', '--slug', `${branch.name}-recovery`, '--from', `origin/release/${branch.name}`).path;
    requireValue(git(worktree, 'rev-parse', 'HEAD') === branch.target, `${branch.name} recovery uses the exact fetched release target`);
    requireValue(fs.readFileSync(branch.plan, 'utf8').match(/^plan_id: ([0-9a-f-]+)$/m)?.[1] === branch.planId, `${branch.name} recovery retains the exact original plan identity`);
    requireValue(fs.readFileSync(branch.plan, 'utf8').match(/^status: (.+)$/m)?.[1] === branch.initialPlanStatus, `${branch.name} recovery preserves the original plan state without reopening it`);
    const trust = passed(worktree, 'trust', 'status');
    requireValue(trust.trusted && trust.inherited, `${branch.name} recovery inherits trust without another approval`);
    const missing = cli(worktree, 'compound', '--plan', branch.plan);
    requireValue(missing.status !== 0 && /No ae verify evidence artifact/.test(missing.value.blockedReason), `${branch.name} recovery cannot transplant the deleted checkout's proof`);
    const beforeReview = cli(worktree, 'verify', '--plan', branch.plan, '--base', branch.acceptedBase);
    requireValue(beforeReview.status !== 0 && beforeReview.value.checks.some(check => check.id === 'required-reviews' && check.status !== 'passed'), `${branch.name} recovery needs a fresh required review record`);
    const recoveryReview = review(worktree, branch.plan, branch.acceptedBase);
    requireValue(recoveryReview !== branch.originalReview, `${branch.name} recovery review is bound to the committed target`);
    const verified = passed(worktree, 'verify', '--plan', branch.plan, '--base', branch.acceptedBase);
    requireValue(verified.outcome === 'passed', `${branch.name} original plan re-verifies the accepted branch diff`);
    const publication = decision(worktree, branch.plan, { operation: `${branch.name}-recovered-${branch.target.slice(0, 12)}`, decision: 'publish', scope: 'private',
      rationale: 'Refresh the operational lesson with current committed-target proof after cleanup.', title: `${branch.name} retry recovery`, category: 'reliability',
      body: `For release/${branch.name} at ${branch.target}, retry settings are configurable. Recovery recreated the pushed target, reviewed and verified the original accepted diff from ${branch.acceptedBase}, and reused the original plan. The earlier episode at ${branch.originalLearning.path} is retained as historical precommit evidence, not overwritten or relabeled as current proof.` });
    requireValue(hash(fs.readFileSync(branch.originalLearning.path)) === branch.originalLearning.sha256, `${branch.name} corrected publication preserves the prior episode's sealed bytes`);
    if (branch.completedDeliveryLearning) requireValue(hash(fs.readFileSync(branch.completedDeliveryLearning.path)) === branch.completedDeliveryLearning.sha256, 'Alpha recovery preserves the completed first fix publication bytes');
    planUpdate(worktree, branch.plan, 'complete', `${branch.name}-complete`);
    const completion = passed(worktree, 'status', '--validate-completion', '--plan', branch.plan);
    requireValue(completion.pass, `${branch.name} the same original plan completes with current learning and proof`);
    requireValue(git(primary, 'rev-parse', 'main') === originalMain, `${branch.name} recovery does not reset or advance stale local main`);
    Object.assign(branch, { recoveryWorktree: worktree, recoveryReview, correctedLearning: publication.publishedPath, completion: completion.record, status: 'done' });
  }
  requireValue(JSON.stringify(fs.readdirSync(plans).filter(name => /\.(md|hplan)$/.test(name)).sort()) === JSON.stringify(originalPlanPaths), 'Recovery creates no duplicate implementation plan or Plan 3');
  requireValue(receipt.steps.filter(step => step.kind === 'ae' && step.args[0] === 'trust' && step.args[1] === 'approve').length === 1, 'Only the initial disposable primary policy approval was issued');
  requireValue(owners.every(file => hash(fs.readFileSync(path.join(runtimeRoot, file))) === sourceFiles[file]), 'Runtime owner bytes stayed unchanged throughout the probe');
  receipt.outcome = 'passed';
} catch (error) {
  receipt.outcome = 'failed';
  receipt.error = { name: error.name, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  save();
  console.log(JSON.stringify({ outcome: receipt.outcome, output, fixture, assertions: receipt.assertions.length, steps: receipt.steps.length, error: receipt.error?.message }));
}
