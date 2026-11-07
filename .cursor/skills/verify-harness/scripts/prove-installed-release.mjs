import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

assert.equal(process.argv.length, 2, 'Run this check from the repository checkout without arguments.');
assert.equal(process.platform, 'darwin', 'This proof requires the currently supported macOS experiment sandbox.');
assert.ok(process.env.HARNESS_CHECK_ARTIFACT_DIR, 'The verification controller must provide HARNESS_CHECK_ARTIFACT_DIR.');
const artifactRoot = fs.realpathSync(path.resolve(process.env.HARNESS_CHECK_ARTIFACT_DIR));
assert.ok(fs.statSync(artifactRoot).isDirectory(), 'The verification controller must create its artifact directory.');
const repoRoot = fs.realpathSync(process.cwd());
const packageDirectory = path.join(repoRoot, 'packages/ae');
const sourceManifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
assert.equal(sourceManifest.name, 'ae-harness');
const version = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(sourceManifest.version);
assert.ok(version && (Number(version[1]) > 0 || Number(version[2]) >= 11), 'Installed proof requires Harness 0.11.0 or later.');
const sha = value => createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const output = path.join(artifactRoot, 'drive');
const buildRoot = path.join(artifactRoot, 'build');
fs.mkdirSync(output); fs.mkdirSync(buildRoot);
let tarball, sourceCommit;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-installed-release-')));
const prefix = path.join(root, 'installed'), home = path.join(root, 'harness'), copilotHome = path.join(root, 'copilot');
const primary = path.join(root, 'primary'), workspace = path.join(root, 'issue');
const env = { ...process.env, HOME: root, USERPROFILE: root, AE_HOME: home, HARNESS_HOME: home, COPILOT_HOME: copilotHome, HARNESS_NO_EVENTS: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0', npm_config_cache: path.join(root, 'npm-cache') };
for (const name of Object.keys(env)) if (name.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF'].includes(name)) delete env[name];
let commandNumber = 0, bin, plan;
const receipts = [];
const measurements = [];
const summary = { version: 1, startedAt: new Date().toISOString(), source: { repoRoot, packageVersion: sourceManifest.version },
  platform: { os: process.platform, arch: process.arch, osRelease: os.release(), node: process.version, nodePath: fs.realpathSync(process.execPath) },
  proofKind: 'Installed package and hydrated CLI scripted acceptance. No native editor or model quality claim.',
  limitations: ['Windows native editor acceptance is deferred to the user.', 'Native editor activation remains unverified.', 'No model calls occur in this proof.'],
  output, temporaryRoot: root, commands: receipts };

function run(executable, args, { cwd = root, timeout = 60_000, expected = 0, input } = {}) {
  const started = Date.now();
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, input });
  const file = `${String(++commandNumber).padStart(3, '0')}-${path.basename(executable).replace(/[^a-zA-Z0-9.-]/g, '-')}.json`;
  const receipt = { executable, args, cwd, elapsedMs: Date.now() - started, exitCode: result.status, signal: result.signal,
    error: result.error?.message, stdout: result.stdout || '', stderr: result.stderr || '' };
  fs.writeFileSync(path.join(output, file), JSON.stringify(receipt, null, 2) + '\n');
  receipts.push({ file, executable, args, exitCode: result.status, elapsedMs: receipt.elapsedMs });
  if (expected === 'nonzero') {
    assert.equal(result.error, undefined, `${args.join(' ')} failed to execute: ${result.error?.message}`);
    assert.ok(Number.isInteger(result.status) && result.status > 0, `${args.join(' ')} must return a normal nonzero exit code; received ${result.status} (${result.signal || 'no signal'})`);
  }
  else assert.equal(result.status, expected, `${args.join(' ')}\n${result.stdout}\n${result.stderr}\n${result.error || ''}`);
  return result;
}

const git = (cwd, ...args) => run('git', ['-c', 'core.fsmonitor=false', ...args], { cwd }).stdout.trim();
const raw = (args, { at = workspace, ...options } = {}) => run(process.execPath, [bin, ...args, '--workspace', at, path.basename(bin) === 'harness.mjs' ? '--harness-home' : '--ae-home', home, '--copilot-home', copilotHome, '--json', '--no-events'], { cwd: at, ...options });
const invoke = (...args) => JSON.parse(raw(args).stdout);
const decision = value => {
  const file = path.join(root, 'decision.json');
  fs.writeFileSync(file, JSON.stringify(value) + '\n');
  return file;
};
const revision = () => sha(fs.readFileSync(plan));
const update = (id, action, extra = {}) => invoke('plan-update', '--plan', plan, '--file', decision({ version: 1, id, expect: revision(), action, ...extra }));
const begin = (id, hypothesis) => {
  const result = invoke('experiment', 'begin', '--plan', plan, '--file', decision({ version: 1, id, expect: revision(), hypothesis }));
  assert.equal(result.attempt.cost, 2); assert.equal(result.attempt_id, result.attempt.id);
  return result.attempt_id;
};
const resolve = (id, attempt, choice, description) => invoke('experiment', 'resolve', '--plan', plan, '--file', decision({ version: 1, id, expect: revision(), attempt, decision: choice, description }));
const setWeights = weights => fs.writeFileSync(path.join(workspace, 'config/weights.json'), JSON.stringify({ version: 1, weights }) + '\n');
const weights = () => json(path.join(workspace, 'config/weights.json')).weights;
const status = () => invoke('experiment', 'status', '--plan', plan);

function evaluate(attempt, loss, correctness) {
  const result = JSON.parse(raw(['experiment', 'evaluate', '--plan', plan, '--attempt', attempt], { expected: correctness ? 0 : 'nonzero' }).stdout);
  const measurement = result.measurement;
  assert.equal(measurement.metric.value, loss);
  assert.equal(measurement.correctness.passed, correctness);
  assert.equal(measurement.groupReaped, true);
  assert.equal(measurement.isolation.supported, true);
  for (const proof of Object.values(measurement.isolation.proof)) assert.equal(proof, true);
  assert.equal(measurement.checks.length, 2);
  for (const check of measurement.checks) assert.equal(check.artifacts.length, 1);
  measurements.push(measurement);
  return measurement;
}

function filesBelow(directory) {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath || entry.path, entry.name)).sort();
}

function hook(filePath) {
  const hookPath = path.join(copilotHome, 'hooks/require-plan-gate.mjs');
  const result = run(process.execPath, [hookPath], { cwd: workspace, input: JSON.stringify({ workspace, tool_name: 'replace_string_in_file', tool_input: { filePath } }) });
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

try {
  sourceCommit = git(repoRoot, 'rev-parse', 'HEAD'); assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  summary.source.commit = sourceCommit;
  summary.source.porcelain = git(repoRoot, 'status', '--porcelain=v1', '--untracked-files=normal');
  summary.source.dirty = Boolean(summary.source.porcelain);
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', buildRoot, './packages/ae'], { cwd: repoRoot, timeout: 120_000 }).stdout);
  assert.equal(packed.length, 1); assert.equal(packed[0].name, sourceManifest.name); assert.equal(packed[0].version, sourceManifest.version);
  assert.equal(path.basename(packed[0].filename), packed[0].filename, 'Pack filename must remain inside the artifact build directory.');
  tarball = path.join(buildRoot, packed[0].filename); assert.ok(fs.statSync(tarball).isFile());
  summary.tarball = { path: tarball, sha256: sha(fs.readFileSync(tarball)), bytes: fs.statSync(tarball).size, npmIntegrity: packed[0].integrity, bundled: packed[0].bundled };
  run('npm', ['install', '--prefix', prefix, '--offline', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', tarball], { timeout: 120_000 });
  const packageRoot = path.join(prefix, 'node_modules/ae-harness');
  const manifest = json(path.join(packageRoot, 'package.json'));
  assert.equal(manifest.version, sourceManifest.version);
  bin = path.join(packageRoot, 'bin/ae.mjs');
  assert.equal(run(process.execPath, [bin, '--version']).stdout.trim(), manifest.version);
  fs.mkdirSync(workspace);
  const freshCopilot = path.join(root, 'fresh-copilot'), freshHarness = path.join(root, 'fresh-harness');
  run(process.execPath, [bin, 'install', '--target', 'cli', '--workspace', workspace, '--copilot-home', freshCopilot, '--ae-home', freshHarness, '--json', '--no-events'], { cwd: workspace });
  assert.equal(run(process.execPath, [path.join(freshCopilot, '.ae-bin/bin/ae.mjs'), '--version']).stdout.trim(), manifest.version);
  assert.equal(json(path.join(freshCopilot, '.harness-lock.json')).version, manifest.version);
  assert.match(fs.readFileSync(path.join(freshCopilot, '.ae-bin/config/plan-schema.v4.yaml'), 'utf8'), /^version: 4\s/m);
  summary.freshInstall = { version: manifest.version, matchedPackage: true, schema4: true };
  const predecessorPath = path.join(packageDirectory, 'test/fixtures/prior-harness-domain-1265403.tgz');
  const predecessor = json(predecessorPath.replace(/\.tgz$/, '.json'));
  assert.equal(predecessor.sourceCommit, '1265403577e2782ef56defb1dbe5b74021d95956');
  assert.equal(predecessor.packageVersion, '0.10.0');
  assert.equal(predecessor.sha256, '05c60c4deaab44e9da70a9143385ef2f96679cc582f7e525b58a38c7685f2205');
  assert.equal(sha(fs.readFileSync(predecessorPath)), predecessor.sha256);
  const oldPrefix = path.join(root, 'predecessor');
  run('npm', ['install', '--prefix', oldPrefix, '--offline', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', predecessorPath], { timeout: 120_000 });
  const finalPackageBin = bin;
  bin = path.join(oldPrefix, 'node_modules/harness/bin/harness.mjs');
  assert.equal(run(process.execPath, [bin, '--version']).stdout.trim(), '0.10.0');
  raw(['install', '--target', 'cli']);
  assert.equal(json(path.join(copilotHome, '.harness-lock.json')).version, '0.10.0');
  assert.equal(fs.existsSync(path.join(copilotHome, '.harness-bin/config/plan-schema.v3.yaml')), true);
  assert.equal(fs.existsSync(path.join(copilotHome, '.harness-bin/config/plan-schema.v4.yaml')), false);
  assert.equal(fs.existsSync(path.join(copilotHome, 'skills/caffeinated/references/experiment-workflow.md')), false);
  run(process.execPath, [path.join(copilotHome, '.harness-bin/bin/harness.mjs'), 'experiment', 'status', '--json', '--no-events'], { expected: 'nonzero' });
  const installBackup = path.join(root, 'predecessor-install-backup');
  fs.cpSync(copilotHome, installBackup, { recursive: true });
  bin = finalPackageBin;
  raw(['upgrade', '--target', 'cli']);
  assert.equal(json(path.join(copilotHome, '.harness-lock.json')).version, manifest.version);
  const legacyRuntimeVersion = run(process.execPath, [path.join(copilotHome, '.harness-bin/bin/harness.mjs'), '--version']).stdout.trim();
  assert.equal(legacyRuntimeVersion, manifest.version);
  assert.equal(json(path.join(copilotHome, '.harness-lock.json')).command, 'upgrade');
  assert.match(fs.readFileSync(path.join(copilotHome, 'skills/caffeinated/references/experiment-workflow.md'), 'utf8'), /ae experiment status/);
  assert.match(fs.readFileSync(path.join(copilotHome, 'skills/caffeinated/SKILL.md'), 'utf8'), /experiment-workflow\.md/);
  summary.upgrade = { predecessor: { sourceCommit: predecessor.sourceCommit, version: predecessor.packageVersion, sha256: predecessor.sha256, provenance: 'Exact pre-experiment source-package fixture, not a published release.' }, finalVersion: manifest.version, legacyRuntimeVersion, lockUpdated: true, newReferenceHydrated: true };
  fs.rmSync(workspace, { recursive: true });
  bin = path.join(copilotHome, '.ae-bin/bin/ae.mjs');
  env.AE_BIN = bin; env.HARNESS_BIN = bin;
  assert.equal(run(process.execPath, [bin, '--version']).stdout.trim(), manifest.version);
  assert.equal(run(process.execPath, [path.join(copilotHome, 'bin/harness'), '--version']).stdout.trim(), manifest.version);
  const installedRoot = path.join(copilotHome, '.ae-bin');
  assert.match(fs.readFileSync(path.join(installedRoot, 'config/plan-schema.v4.yaml'), 'utf8'), /^version: 4\s/m);
  const help = run(process.execPath, [bin, 'help', 'experiment']).stdout;
  for (const verb of ['begin', 'evaluate', 'resolve', 'status']) assert.match(help, new RegExp(`\\b${verb}\\b`));
  run(process.execPath, [bin, 'help', 'domain']);
  const skills = filesBelow(path.join(copilotHome, 'skills')).filter(file => path.basename(file) === 'SKILL.md');
  const agents = filesBelow(path.join(copilotHome, 'agents')).filter(file => file.endsWith('.agent.md'));
  const instructions = filesBelow(path.join(copilotHome, 'instructions')).filter(file => file.endsWith('.instructions.md'));
  const publicSkills = skills.filter(file => !/^user-invocable: false\s*$/m.test(fs.readFileSync(file, 'utf8'))).map(file => path.basename(path.dirname(file))).sort();
  assert.equal(skills.length, 28); assert.equal(agents.length, 22); assert.equal(instructions.length, 5);
  assert.deepEqual(publicSkills, ['engineer', 'harness-doctor', 'project-readme', 'triage-issues']);
  assert.equal(agents.filter(file => !/^user-invocable: false\s*$/m.test(fs.readFileSync(file, 'utf8'))).length, 1);
  const installedHooks = json(path.join(copilotHome, 'hooks/hooks.json'));
  for (const entries of Object.values(installedHooks.hooks || {})) for (const entry of entries) for (const command of entry.hooks || [entry]) if (command.cwd) assert.equal(command.cwd, path.join(copilotHome, 'hooks'));
  const hooks = filesBelow(path.join(copilotHome, 'hooks'));
  for (const file of hooks) assert.equal(fs.readFileSync(file).includes(Buffer.from(repoRoot)), false, `Source checkout path leaked into ${file}`);
  summary.package = { name: manifest.name, version: manifest.version, npmRoot: packageRoot, hydratedRoot: installedRoot, binSha256: sha(fs.readFileSync(bin)), schema4Sha256: sha(fs.readFileSync(path.join(installedRoot, 'config/plan-schema.v4.yaml'))), yamlVersion: json(path.join(installedRoot, 'node_modules/yaml/package.json')).version };
  summary.corpus = { skills: skills.length, agents: agents.length, instructions: instructions.length, publicSkills, publicAgents: agents.filter(file => !/^user-invocable: false\s*$/m.test(fs.readFileSync(file, 'utf8'))).map(file => path.basename(file)) };
  fs.mkdirSync(primary); git(primary, 'init', '-b', 'main');
  git(primary, 'config', 'user.name', 'Installed Release Acceptance'); git(primary, 'config', 'user.email', 'installed-release@example.invalid');
  raw(['init-repo'], { at: primary });
  fs.mkdirSync(path.join(primary, 'config'), { recursive: true }); fs.mkdirSync(path.join(primary, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(primary, 'config/weights.json'), JSON.stringify({ version: 1, weights: [0, 0] }) + '\n');
  const workload = { version: 1, objective: [{ features: [1, 0], expected: 2 }, { features: [0, 1], expected: 2 }], guards: [{ features: [1, 1], min: 0, max: 3 }] };
  fs.writeFileSync(path.join(primary, 'fixtures/weights-workload.json'), JSON.stringify(workload) + '\n');
  fs.writeFileSync(path.join(primary, '.github/harness/policy.yaml'), JSON.stringify({ version: 1, enforcement: 'enforce', gate_ttl_minutes: 30, evidence_ttl_hours: 24, exemptions: [], waivers: [] }));
  fs.mkdirSync(workspace);
  const setup = invoke('experiment', 'status').setup;
  fs.rmSync(workspace, { recursive: true });
  assert.equal(setup.workload, 'linear-json-v1'); assert.equal(setup.isolation, 'unprobed');
  assert.equal(setup.runtimePath, fs.realpathSync(process.execPath));
  assert.equal(setup.evaluatorPath, fs.realpathSync(path.join(installedRoot, 'lib/experiment-evaluator.mjs')));
  const checks = Object.fromEntries([['weights-loss', 'score'], ['weights-guards', 'guard']].map(([id, mode]) => [id, { command: [setup.runtimePath, setup.evaluatorPath, mode], timeout_seconds: 10, artifacts: setup.check.artifacts, experiment: { version: 1, workload: setup.workload, mode } }]));
  checks['weights-behavior'] = { command: [process.execPath, '-e', "const fs=require('fs');const c=JSON.parse(fs.readFileSync('config/weights.json','utf8'));const w=JSON.parse(fs.readFileSync('fixtures/weights-workload.json','utf8'));const ok=c.version===1&&Array.isArray(c.weights)&&c.weights.length===2&&c.weights.every(Number.isFinite)&&w.guards.every(r=>{const v=r.features.reduce((s,n,i)=>s+n*c.weights[i],0);return v>=r.min&&v<=r.max;});process.exit(ok?0:1);"], proof: 'behavior' };
  fs.writeFileSync(path.join(primary, '.github/harness/checks.yaml'), JSON.stringify({ version: 1, checks }));
  git(primary, 'add', '.'); git(primary, 'commit', '-m', 'Configure finite weights acceptance');
  git(primary, 'worktree', 'add', '-b', 'feature/installed-experiment', workspace, 'main');
  invoke('trust', 'approve');
  const experiment = { version: 1, workload: 'linear-json-v1', candidate: 'config/weights.json', editable_files: ['config/weights.json'], metric: { name: 'mean-absolute-error', units: 'absolute-error', direction: 'minimize' }, scorer_check: 'weights-loss', correctness_checks: ['weights-guards'], dependencies: ['fixtures/weights-workload.json'], protocol: { deterministic: true, repetitions: 1, minimum_improvement: 0.25 }, target: 0.5, budget: { max_invocations: 8, max_seconds: 300, timeout_seconds: 10, max_repair_reruns: 2 } };
  const creation = { version: 1, format: 'full', slug: 'installed-weights', type: 'feat', title: 'Retain bounded weights using the installed package', goal: 'Reach the accepted error target while preserving hard bounds.', status: 'planned', risk: 'green', scope: ['config/weights.json'], check: 'weights-behavior', outputs: ['config/weights.json'], acceptance: ['Weights remain finite and satisfy the accepted workload bounds.'], constraints: ['Preserve unrelated work and the user index.'], phases: [{ title: 'Measure and retain', tasks: ['Retain a correct target candidate.'] }], experiment };
  plan = invoke('plan-new', '--file', decision(creation)).path;
  assert.equal(path.extname(plan), '.hplan'); assert.match(fs.readFileSync(plan, 'utf8'), /^plan_schema: 4\s/m);
  update('start', 'start'); assert.equal(invoke('gate', '--plan', plan, '--phase', 'implement').pass, true);
  const head = git(workspace, 'rev-parse', 'HEAD'), indexPath = path.resolve(workspace, git(workspace, 'rev-parse', '--git-path', 'index'));
  const indexBytes = fs.readFileSync(indexPath);
  const preBaselineHook = hook('config/weights.json').hookSpecificOutput;
  assert.ok(preBaselineHook && (preBaselineHook.permissionDecision === 'deny' || preBaselineHook.decision === 'block'));
  const baseline = begin('baseline', 'Measure the untouched accepted baseline.');
  evaluate(baseline, 2, true); resolve('baseline-keep', baseline, 'keep', 'Keep the untouched baseline as the rollback origin.');
  const improvement = begin('improve', 'Increase both accepted weights to one.');
  assert.equal(hook('config/weights.json').continue, true);
  setWeights([1, 1]); evaluate(improvement, 1, true); resolve('improve-keep', improvement, 'keep', 'The observed improvement preserves all hard guards.');
  assert.deepEqual(fs.readFileSync(indexPath), indexBytes);
  const rejected = begin('bad-guard', 'Probe objective fit against the hard bounds.');
  setWeights([2, 2]);
  const unrelatedPath = path.join(workspace, 'unrelated.txt'), unrelatedBytes = Buffer.from('Preserve this staged unrelated change.\n');
  fs.writeFileSync(unrelatedPath, unrelatedBytes); git(workspace, 'add', 'unrelated.txt');
  const stagedIndex = fs.readFileSync(indexPath), stagedDiff = git(workspace, 'diff', '--cached', '--binary');
  evaluate(rejected, 0, false);
  raw(['experiment', 'resolve', '--plan', plan, '--file', decision({ version: 1, id: 'bad-guard-refuse-keep', expect: revision(), attempt: rejected, decision: 'keep', description: 'This keep must be rejected because correctness failed.' })], { expected: 'nonzero' });
  assert.deepEqual(weights(), [2, 2]);
  resolve('bad-guard-discard', rejected, 'discard', 'Restore the last kept bytes because a hard guard failed.');
  assert.deepEqual(weights(), [1, 1]); assert.deepEqual(fs.readFileSync(indexPath), stagedIndex);
  assert.deepEqual(fs.readFileSync(unrelatedPath), unrelatedBytes); assert.equal(git(workspace, 'diff', '--cached', '--binary'), stagedDiff);
  summary.preservation = { initialHead: head, initialIndexSha256: sha(indexBytes), stagedIndexSha256: sha(stagedIndex), stagedDiffSha256: sha(stagedDiff), unrelatedSha256: sha(unrelatedBytes), rejectedCandidateRestored: true, stagedIndexUnchanged: true, stagedDiffUnchanged: true, unrelatedBytesUnchanged: true };
  git(workspace, 'restore', '--staged', '--', 'unrelated.txt'); fs.rmSync(unrelatedPath);
  const cleanIndex = fs.readFileSync(indexPath);
  const target = begin('target', 'Retain one-and-a-half weights within the hard bounds.');
  setWeights([1.5, 1.5]); evaluate(target, 0.5, true); resolve('target-keep', target, 'keep', 'Retain the accepted target with current correctness proof.');
  const settled = status(); assert.equal(settled.status, 'target-reached'); assert.equal(settled.spent, 8); assert.equal(settled.active, null); assert.equal(settled.lastKept.id, target);
  assert.deepEqual(weights(), [1.5, 1.5]); assert.equal(git(workspace, 'rev-parse', 'HEAD'), head); assert.deepEqual(fs.readFileSync(indexPath), cleanIndex);
  raw(['experiment', 'begin', '--plan', plan, '--file', decision({ version: 1, id: 'after-target', expect: revision(), hypothesis: 'A new pair must be denied after the target.' })], { expected: 'nonzero' });
  update('progress', 'progress', { progress: { tasks: ['P1T1'], criteria: ['AC1'], phase: 1 } });
  const packet = invoke('review', 'prepare', '--plan', plan, '--base', 'HEAD');
  const results = packet.required.map(reviewer => ({ reviewer, status: 'completed', findings: [], residual_risks: ['Scripted installed-package fixture does not measure model quality or native editor activation.'], testing_gaps: [], provenance: { kind: 'same-context', method: 'Read and execute the installed finite JSON workload acceptance fixture.' } }));
  invoke('review', 'assemble', '--plan', plan, '--packet', packet.id, '--file', decision({ packet: packet.id, results }));
  const proof = invoke('verify', '--plan', plan, '--base', 'HEAD');
  assert.equal(proof.outcome, 'passed');
  for (const id of ['experiment-target', 'experiment-retention-stability']) assert.equal(proof.checks.find(check => check.id === id)?.status, 'passed');
  assert.equal(proof.checks.some(check => ['weights-loss', 'weights-guards'].includes(check.id)), false);
  invoke('compound', '--plan', plan, '--learning-decision', decision({ operation: 'no-learning', decision: 'no-learning', rationale: 'Disposable installed numerical acceptance is preserved in its receipt and implementation tests.' }));
  update('complete', 'complete'); assert.match(fs.readFileSync(plan, 'utf8'), /^status: done\s/m);
  assert.equal(invoke('status', '--validate-evidence', '--plan', plan).pass, true);
  assert.equal(invoke('status', '--validate-completion', '--plan', plan).pass, true);
  const artifacts = filesBelow(home).filter(file => path.basename(file) === 'measurement.json');
  assert.equal(artifacts.length, 8, 'Each of the four charged pairs must retain score and guard JSON artifacts.');
  const artifactModes = new Map();
  for (const file of artifacts) {
    const artifact = json(file), observed = measurements.find(measurement => measurement.attempt === artifact.attempt);
    assert.ok(observed, `Unexpected artifact attempt at ${file}`);
    assert.equal(artifact.metric.value, observed.metric.value); assert.equal(artifact.correctness.passed, observed.correctness.passed);
    assert.ok(['score', 'guard'].includes(artifact.mode));
    const modes = artifactModes.get(artifact.attempt) || [];
    modes.push(artifact.mode); artifactModes.set(artifact.attempt, modes);
  }
  for (const modes of artifactModes.values()) assert.deepEqual(modes.sort(), ['guard', 'score']);
  fs.cpSync(home, path.join(output, 'harness-records'), { recursive: true });
  fs.copyFileSync(plan, path.join(output, 'completed-plan.hplan'));
  fs.copyFileSync(path.join(workspace, proof.evidencePath), path.join(output, 'final-evidence.json'));
  fs.copyFileSync(path.join(workspace, 'config/weights.json'), path.join(output, 'retained-weights.json'));
  assert.equal(json(path.join(output, 'final-evidence.json')).version, 7);
  summary.setup = setup;
  summary.measurements = measurements.map(measurement => ({ attempt: measurement.attempt, value: measurement.metric.value, correctness: measurement.correctness.passed, isolation: measurement.isolation, artifacts: measurement.checks.flatMap(check => check.artifacts) }));
  summary.artifacts = artifacts.map(file => ({ sourcePath: file, archivedPath: path.join('harness-records', path.relative(home, file)), sha256: sha(fs.readFileSync(file)), bytes: fs.statSync(file).size }));
  summary.final = { experimentStatus: settled.status, spent: settled.spent, targetAttempt: target, planStatus: 'done', evidenceVersion: 7, outcome: proof.outcome, retainedWeights: weights(), headUnchanged: git(workspace, 'rev-parse', 'HEAD') === head, indexUnchanged: fs.readFileSync(indexPath).equals(cleanIndex), namedProof: proof.checks.filter(check => check.id.startsWith('experiment-')).map(check => ({ id: check.id, status: check.status })) };
  const migratedHome = path.join(root, 'migrated-home');
  const migration = JSON.parse(run(process.execPath, [bin, 'migrate', '--from-home', home, '--ae-home', migratedHome, '--json', '--no-events']).stdout);
  const migratedPlan = path.join(migratedHome, path.relative(home, plan));
  assert.equal(sha(fs.readFileSync(migratedPlan)), sha(fs.readFileSync(plan)));
  assert.ok(migration.files > 0); assert.equal(migration.backup, home);
  assert.equal(JSON.parse(run(process.execPath, [bin, 'migrate', '--from-home', home, '--ae-home', migratedHome, '--json', '--no-events']).stdout).unchanged, true);
  summary.homeMigration = { files: migration.files, bytes: migration.bytes, sourcePreserved: true, completedPlanUnchanged: true, replayUnchanged: true };
  fs.rmSync(copilotHome, { recursive: true }); fs.cpSync(installBackup, copilotHome, { recursive: true });
  assert.equal(run(process.execPath, [path.join(copilotHome, 'bin/harness'), '--version']).stdout.trim(), '0.10.0');
  summary.installRollback = { restoredSnapshot: true, version: '0.10.0' };
  summary.outcome = 'passed';
} catch (error) {
  summary.outcome = 'failed'; summary.error = { name: error.name, message: String(error.message).slice(0, 4096), stack: String(error.stack).slice(0, 16 * 1024) };
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  summary.cleanedTemporaryRoot = !fs.existsSync(root); summary.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(summary, null, 2) + '\n');
  const artifact = JSON.stringify(summary, null, 2) + '\n';
  assert.ok(Buffer.byteLength(artifact) <= 1024 * 1024, 'The installed-release artifact must remain within one MiB.');
  fs.writeFileSync(path.join(artifactRoot, 'installed-release.json'), artifact, { flag: 'wx' });
  console.log(JSON.stringify({ outcome: summary.outcome, receipt: path.join(output, 'receipt.json'), error: summary.error?.message }));
}
