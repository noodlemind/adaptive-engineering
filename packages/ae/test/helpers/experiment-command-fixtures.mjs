import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { initGit, scriptedFlowLedger } from './cli-fixtures.mjs';

export const experimentBin = path.resolve(import.meta.dirname, '../../bin/ae.mjs');
export const evaluatorPath = path.resolve(import.meta.dirname, '../../lib/experiment-evaluator.mjs');
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const workload = { version: 1, objective: [{ features: [1, 0], expected: 2 }, { features: [0, 1], expected: 2 }], guards: [{ features: [1, 1], min: 0, max: 3 }] };

export function experimentContract(overrides = {}) {
  return { version: 1, workload: 'linear-json-v1', candidate: 'config/weights.json', editable_files: ['config/weights.json'], metric: { name: 'mean-absolute-error', units: 'absolute-error', direction: 'minimize' }, scorer_check: 'weights-loss', correctness_checks: ['weights-guards'], dependencies: ['fixtures/weights-workload.json'], protocol: { deterministic: true, repetitions: 1, minimum_improvement: 0.25 }, target: 0.5, budget: { max_invocations: 8, max_seconds: 300, timeout_seconds: 10, max_repair_reruns: 2 }, ...overrides };
}

export function creationDecision(overrides = {}) {
  return { version: 1, format: 'full', slug: 'bounded-weights', type: 'feat', title: 'Improve weights with retained correctness proof', goal: 'Reach the accepted error target while preserving hard bounds.', status: 'planned', risk: 'green', scope: ['config/weights.json'], check: 'weights-behavior', outputs: ['config/weights.json'], acceptance: ['Weights remain finite and satisfy the accepted workload bounds.'], constraints: ['Preserve unrelated work and the user index.'], phases: [{ title: 'Measure and retain', tasks: ['Retain a correct target candidate.'] }], experiment: experimentContract(), ...overrides };
}

export function experimentFixture(t, { linked = true, candidate = [0, 0], contract = experimentContract(), workloadData = workload } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'experiment-cli-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), copilotHome = path.join(root, 'copilot');
  const primary = path.join(root, 'primary'), issue = path.join(root, 'issue');
  fs.mkdirSync(primary); initGit(primary);
  const env = { ...process.env, HARNESS_HOME: home, COPILOT_HOME: copilotHome, HARNESS_NO_EVENTS: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (workspace, ...args) => {
    const result = spawnSync('git', args, { cwd: workspace, env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(primary, 'branch', '-M', 'main');
  const raw = (workspace, ...args) => spawnSync(process.execPath, [experimentBin, ...args, '--workspace', workspace, '--harness-home', home, '--copilot-home', copilotHome, '--json', '--no-events'], { cwd: workspace, env, encoding: 'utf8', timeout: 45_000 });
  const initialized = raw(primary, 'init-repo', '--shared');
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
  fs.mkdirSync(path.join(primary, 'config'), { recursive: true });
  fs.mkdirSync(path.join(primary, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(primary, 'config/weights.json'), JSON.stringify({ version: 1, weights: candidate }) + '\n');
  fs.writeFileSync(path.join(primary, 'fixtures/weights-workload.json'), JSON.stringify(workloadData) + '\n');
  fs.writeFileSync(path.join(primary, '.github/harness/policy.yaml'), YAML.stringify({ version: 1, enforcement: 'enforce', gate_ttl_minutes: 30, evidence_ttl_hours: 24, exemptions: [], waivers: [] }));
  const evaluator = fs.existsSync(evaluatorPath) ? fs.realpathSync(evaluatorPath) : evaluatorPath;
  const checks = Object.fromEntries([['weights-loss', 'score'], ['weights-guards', 'guard']].map(([name, mode]) => [name, { command: [fs.realpathSync(process.execPath), evaluator, mode], timeout_seconds: contract.budget.timeout_seconds, artifacts: ['measurement.json'], experiment: { version: 1, workload: 'linear-json-v1', mode } }]));
  checks['weights-behavior'] = { command: [process.execPath, '-e', "const fs=require('fs');const c=JSON.parse(fs.readFileSync('config/weights.json','utf8'));const w=JSON.parse(fs.readFileSync('fixtures/weights-workload.json','utf8'));const ok=c.version===1&&Array.isArray(c.weights)&&c.weights.length===2&&c.weights.every(Number.isFinite)&&w.guards.every(r=>{const v=r.features.reduce((s,n,i)=>s+n*c.weights[i],0);return v>=r.min&&v<=r.max;});process.exit(ok?0:1);"], proof: 'behavior' };
  fs.writeFileSync(path.join(primary, '.github/harness/checks.yaml'), YAML.stringify({ version: 1, checks }));
  git(primary, 'add', '.'); git(primary, 'commit', '-m', 'Configure finite weights workload');
  if (linked) git(primary, 'worktree', 'add', '-b', 'feature/experiment-weights', issue, 'main');
  const workspace = linked ? issue : primary;
  const cli = (...args) => raw(workspace, ...args);
  const startProcess = (...args) => spawn(process.execPath, [experimentBin, ...args, '--workspace', workspace, '--harness-home', home, '--copilot-home', copilotHome, '--json', '--no-events'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const invoke = (...args) => {
    const result = cli(...args);
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  invoke('trust', 'approve');
  const input = path.join(root, 'decision.json');
  const writeDecision = value => { fs.writeFileSync(input, JSON.stringify(value)); return input; };
  let plan;
  const create = (extra = {}) => {
    const created = invoke('plan-new', '--file', writeDecision(creationDecision({ experiment: contract, ...extra })));
    plan = created.path;
    return created;
  };
  const revision = () => hash(fs.readFileSync(plan));
  const authored = (command, value) => invoke(command, '--plan', plan, '--file', writeDecision(value));
  const op = (id, action, extra = {}) => {
    const result = authored('plan-update', { version: 1, id, action, expect: revision(), ...extra });
    if (action === 'convert') plan = result.path;
    return result;
  };
  const start = () => { op('start', 'start'); return invoke('gate', '--plan', plan, '--phase', 'implement'); };
  const setWeights = weights => fs.writeFileSync(path.join(workspace, 'config/weights.json'), JSON.stringify({ version: 1, weights }) + '\n');
  const weights = () => JSON.parse(fs.readFileSync(path.join(workspace, 'config/weights.json'), 'utf8')).weights;
  const beginInput = (id, hypothesis, extra = {}) => ({ version: 1, id, expect: revision(), hypothesis, ...extra });
  const begin = (id, hypothesis, extra = {}) => invoke('experiment', 'begin', '--plan', plan, '--file', writeDecision(beginInput(id, hypothesis, extra)));
  const status = (attempt) => invoke('experiment', 'status', '--plan', plan, ...(attempt ? ['--attempt', attempt] : []));
  const evaluate = attempt => invoke('experiment', 'evaluate', '--plan', plan, '--attempt', attempt);
  const resolve = (id, attempt, decision, description = 'Authored acceptance of the observed result.') => invoke('experiment', 'resolve', '--plan', plan, '--file', writeDecision({ version: 1, id, expect: revision(), attempt, decision, description }));
  const review = () => {
    const packet = invoke('review', 'prepare', '--plan', plan, '--base', 'HEAD');
    const results = packet.required.map(reviewer => ({ ...scriptedFlowLedger(packet, reviewer), reviewer, status: 'completed', findings: [], residual_risks: ['Scripted fixture validates CLI behavior without a model quality claim.'], testing_gaps: [], provenance: { kind: 'same-context', method: 'Finite JSON workload CLI acceptance fixture.' } }));
    return invoke('review', 'assemble', '--plan', plan, '--packet', packet.id, '--file', writeDecision({ packet: packet.id, results }));
  };
  const hook = filePath => {
    const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../../corpus/hooks/require-plan-gate.mjs')], { cwd: workspace, env: { ...env, HARNESS_BIN: experimentBin }, input: JSON.stringify({ workspace, tool_name: 'replace_string_in_file', tool_input: { filePath } }), encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  };
  return { root, home, copilotHome, primary, workspace, input, cli, startProcess, invoke, git, create, start, op, revision, writeDecision, beginInput, begin, status, evaluate, resolve, setWeights, weights, review, hook, get plan() { return plan; } };
}
