import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { harnessControlCommand, normalizeToolPayload } from '../corpus/hooks/lib/tool-payload.mjs';
import { parseDiagramArguments } from '../lib/diagram-cmd.mjs';
import { beforeDeliveryTool } from '../lib/agent-delivery.mjs';
import { DELIVER_PROFILE, dispatchToolCall } from '../lib/agent-loop.mjs';
import { approveProject } from '../lib/trust.mjs';
import { initGit, writeVersionedPlan } from './helpers/cli-fixtures.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/ae.mjs');
const hooks = path.resolve(import.meta.dirname, '../corpus/hooks');

test('diagram controls admit exact CLI grammar without broad command authority', () => {
  const workspace = process.cwd();
  const accepted = [
    ['render', '--file', 'docs/view.mmd', '--sources', 'src,config/app.json', '--renderer', 'pele', '--json'],
    ['render', '--file=docs/view.d2', '--layout=tala', '--sources=.', '--timeout=30000', '--dry-run', '-v'],
    ['render', '--file', 'docs/view.mermaid', '--renderer', 'pele'],
    ['render', '--file', 'docs/view.d2', '--renderer', 'd2', '--layout', 'elk', '--png', '--scale', '2'],
    ['graph', '--root', 'src/app.ts', '--png'],
    ['flow', '--flow', 'order-recovery', '--png', '--scale=1'],
    ['graph', '--root', 'src/app.ts', '--operation', 'dependents', '--depth', '32', '--limit', '200', '--max-nodes', '200', '--timeout', '1'],
    ['flow', '--flow', 'order-recovery', '--limit', '1', '--max-nodes', '1', '--no-events', '--no-color'],
    ['status', '--receipt', '.harness/diagrams/example/receipt.json', '--workspace', workspace, '--ae-home', '/private/state', '--copilot-home', '/private/copilot'],
    ['status', '--receipt=.harness/diagrams/example/receipt.json', '--output', 'json-envelope'],
  ];
  for (const args of accepted) {
    assert.doesNotThrow(() => parseDiagramArguments(args), args.join(' '));
    for (const prefix of [['ae'], ['harness'], [process.execPath, bin]]) {
      assert.equal(harnessControlCommand([...prefix, 'diagrams', ...args], workspace), 'diagrams', args.join(' '));
    }
  }
  const refused = [
    [], ['install'], ['render'], ['graph'], ['flow'], ['status'],
    ['formal', '--file', 'evidence/receipt.json', '--model', 'Unsafe.tla'],
    ['render', '--file', 'view.svg'], ['render', '--file', '/absolute.mmd'], ['render', '--file', 'C:/view.d2'],
    ['render', '--file', 'src\\view.mmd'], ['render', '--file', './view.mmd'], ['render', '--file', 'src/../view.d2'],
    ['render', '--file', 'view.mmd', '--sources', 'src,,config'], ['render', '--file', 'view.mmd', '--sources', 'node_modules'],
    ['render', '--file', 'view.d2', '--sources', '.harness'], ['render', '--file', 'view.d2', '--sources', 'src/.git'],
    ['render', '--file', 'view.mmd', '--sources', 'Node_Modules'], ['render', '--file', 'view.mmd', '--sources', '.Harness'],
    ['render', '--file', 'view.d2', '--sources', 'src/.GIT'],
    ['render', '--file', 'view.mmd', '--renderer', 'unknown'], ['render', '--file', 'view.mmd', '--layout', 'tala'],
    ['render', '--file', 'view.mmd', '--scale', '2'], ['render', '--file', 'view.mmd', '--png', '--scale', '5'],
    ['render', '--file', 'view.mmd', '--png=1'], ['status', '--receipt', 'receipt.json', '--png'],
    ['graph', '--root', 'src/app.ts', '--scale', '2'],
    ['render', '--file', 'view.d2', '--layout', 'unknown'], ['render', '--file', 'view.mmd', '--operation', 'deps'],
    ['graph', '--root', 'src/app.ts', '--operation', 'path'], ['graph', '--root', 'src/app.ts', '--depth', '0'],
    ['graph', '--root', 'src/app.ts', '--depth', '33'], ['graph', '--root', 'src/app.ts', '--limit', '201'],
    ['graph', '--root', 'src/app.ts', '--max-nodes', '0'], ['flow', '--flow', 'orders', '--timeout', '30001'],
    ['flow', '--flow', 'orders', '--timeout', '1.5'], ['flow', '--flow', 'orders', '--limit', '9007199254740992'],
    ['status', '--receipt', 'receipt.json', '--flow', 'orders'], ['status', '--receipt', 'receipt.json', '--unknown'],
    ['status', '--receipt', 'receipt.json', '--json', '--json'], ['status', '--receipt', 'receipt.json', '--verbose', '-v'],
    ['status', '--receipt', 'receipt.json', '--json=true'], ['status', '--receipt', 'receipt.json', '--workspace'],
    ['status', '--receipt', 'receipt.json', '--workspace', 'bad\npath'], ['status', '--receipt', 'receipt.json', '--ae-home', 'x'.repeat(4097)],
    ['status', '--receipt', 'receipt.json', 'unexpected'], ['status', '--receipt', 'receipt.json', '--', 'node', 'opaque.mjs'],
  ];
  for (const args of refused) {
    assert.throws(() => parseDiagramArguments(args), undefined, args.join(' '));
    assert.equal(harnessControlCommand(['ae', 'diagrams', ...args], workspace), null, args.join(' '));
  }
  assert.equal(harnessControlCommand(['ae', 'diagrams', 'status', '--receipt', 'receipt.json', '--workspace', path.dirname(workspace)], workspace), null);
});

test('diagram controls remain available through native hooks without granting mixed-command exemptions', t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-controls-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-control-home-'));
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(workspace, '.github/harness'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.github/harness/policy.yaml'), 'version: 1\nenforcement: enforce\n');
  fs.writeFileSync(path.join(workspace, '.github/harness/checks.yaml'), 'version: 1\nchecks: {}\n');
  const hook = command => {
    const result = spawnSync(process.execPath, [path.join(hooks, 'require-plan-gate.mjs')], {
      cwd: workspace, input: JSON.stringify({ workspace, cwd: workspace, session_id: 'diagram-controls', tool_name: 'run_in_terminal', tool_input: { command } }), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, AE_BIN: bin, HARNESS_BIN: bin, AE_HOME: state, HARNESS_HOME: state, COPILOT_HOME: path.join(state, 'copilot'), HARNESS_ENFORCEMENT: 'enforce' },
    });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  };
  const commands = [
    'ae diagrams render --file docs/view.mmd --sources src --renderer pele --json',
    'ae diagrams render --file docs/view.d2 --layout tala --json',
    'ae diagrams graph --root src/app.ts --operation deps --depth 2 --limit 40 --json',
    'ae diagrams flow --flow orders --json',
    'ae diagrams status --receipt .harness/diagrams/example/receipt.json --json',
    `node "${bin}" diagrams status --receipt .harness/diagrams/example/receipt.json --json`,
  ];
  for (const command of commands) {
    const normalized = normalizeToolPayload({ cwd: workspace, tool_name: 'run_in_terminal', tool_input: { command } });
    assert.equal(normalized.mutation, false, command);
    assert.equal(normalized.terminalEffects.hasOpaque, false, command);
    assert.equal(hook(command).continue, true, command);
  }
  const sessionPath = path.join(workspace, '.harness/session.json');
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify({ version: 1, sessionId: 'diagram-controls', gateStatus: 'fail', gatedChecksDigest: null }));
  for (const command of commands) assert.equal(hook(command).continue, true, command);
  for (const command of [
    'ae diagrams install', 'ae diagrams render --file view.mmd --unknown',
    'ae diagrams render --file view.mmd; node opaque.mjs',
    'ae diagrams render --file view.mmd; ae status --json',
    'env ae diagrams graph --root src/app.ts',
    'ae diagrams status --receipt receipt.json > product.txt',
    'ae diagrams formal --file evidence/receipt.json --model Unsafe.tla --png --json',
  ]) assert.equal(hook(command).hookSpecificOutput?.permissionDecision, 'deny', command);
  assert.equal(fs.existsSync(path.join(workspace, 'product.txt')), false);
});

test('native lifecycle admission accepts only exact diagrams controls', () => {
  const options = { workspace: process.cwd() };
  for (const argv of [
    ['diagrams', 'render', '--file', 'view.mmd', '--sources', 'src', '--renderer', 'pele'],
    ['diagrams', 'graph', '--root', 'src/app.mjs', '--operation', 'dependents'],
    ['diagrams', 'flow', '--flow', 'order-recovery'],
    ['diagrams', 'status', '--receipt', '.harness/diagrams/example/receipt.json'],
  ]) assert.equal(beforeDeliveryTool({ name: 'harness', input: { argv } }, options).pass, true, argv.join(' '));
  for (const argv of [
    ['diagrams', 'install'], ['diagrams', 'render', '--file', 'view.mmd', '--unknown'],
    ['diagrams', 'render', '--file', 'view.mmd', '--file', 'other.mmd'],
    ['diagrams', 'status', '--receipt', 'receipt.json', '--', 'node', 'opaque.mjs'],
    ['diagrams', 'graph', '--root', '../outside.mjs'],
    ['diagrams', 'formal', '--file', 'evidence/receipt.json', '--model', 'Unsafe.tla', '--png'],
  ]) assert.equal(beforeDeliveryTool({ name: 'harness', input: { argv } }, options).pass, false, argv.join(' '));
  for (const selector of [['--copilot-home', '/other/control'], ['--ae-home=/other/control'], ['--workspace', process.cwd()]]) {
    const result = beforeDeliveryTool({ name: 'harness', input: { argv: ['diagrams', 'status', '--receipt', 'receipt.json', ...selector] } }, options);
    assert.equal(result.pass, false);
    assert.match(result.reason, /bound to this run workspace and homes/);
  }
});

test('native lifecycle renders a local view and checks its receipt before an implement gate', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-diagram-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, 'workspace'), home = path.join(root, 'copilot'), harnessHome = path.join(root, 'state');
  fs.mkdirSync(ws); fs.mkdirSync(home);
  const plan = writeVersionedPlan(ws);
  initGit(ws);
  approveProject({ workspace: ws, copilotHome: home, home: harnessHome });
  const f = { ws, home, plan };
  const planBefore = fs.readFileSync(path.join(f.ws, f.plan), 'utf8');
  const productBefore = fs.readFileSync(path.join(f.ws, 'src/example.js'), 'utf8');
  fs.writeFileSync(path.join(f.ws, 'view.mmd'), 'flowchart TB\n  Entry --> Complete\n');
  const options = { workspace: f.ws, copilotHome: f.home, harnessHome, profile: DELIVER_PROFILE, remainingSeconds: 20 };
  const run = async argv => {
    const outcome = await dispatchToolCall({ id: 'diagram', name: 'harness', input: { argv } }, options);
    assert.equal(outcome.dispatched, true, outcome.reason);
    assert.equal(outcome.result.status, 'ok', JSON.stringify(outcome.result));
    const stdout = outcome.result.output.filter(row => row.stream === 'stdout' && row.line).map(row => row.line).join('\n');
    assert.ok(stdout, JSON.stringify(outcome.result));
    return JSON.parse(stdout);
  };
  const rendered = await run(['diagrams', 'render', '--file', 'view.mmd', '--sources', 'src/example.js', '--renderer', 'pele']);
  assert.equal(fs.existsSync(path.join(f.ws, rendered.artifacts.svg)), true);
  assert.equal(fs.existsSync(path.join(f.ws, rendered.artifacts.html)), true);
  assert.equal((await run(['diagrams', 'status', '--receipt', rendered.artifacts.receipt])).state, 'current');
  assert.equal(fs.readFileSync(path.join(f.ws, f.plan), 'utf8'), planBefore);
  assert.equal(fs.readFileSync(path.join(f.ws, 'src/example.js'), 'utf8'), productBefore);
});
