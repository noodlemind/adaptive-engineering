import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const PAYMENT_BAD = `export function capturePayment(order, request, ledger) {
  if (order.status !== 'ready') throw new Error('Order is not payable');
  const cents = Math.round(request.amount * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('Invalid amount');
  const receipt = { orderId: order.id, requestId: request.id, cents };
  ledger.push(receipt);
  return receipt;
}
`;

export const PAYMENT_FIXED = `export function capturePayment(order, request, ledger) {
  if (order.status !== 'ready') throw new Error('Order is not payable');
  const cents = Math.round(request.amount * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('Invalid amount');
  const previous = ledger.find(entry => entry.orderId === order.id && entry.requestId === request.id);
  if (previous) {
    if (previous.cents !== cents) throw new Error('Idempotency conflict');
    return previous;
  }
  const receipt = { orderId: order.id, requestId: request.id, cents };
  ledger.push(receipt);
  return receipt;
}
`;

const PAYMENT_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capturePayment } from '../src/payment.mjs';
test('a retry returns the original receipt without charging again', () => {
  const ledger = [], order = { id: 'order-1', status: 'ready' };
  const request = { id: 'request-1', amount: 12.34 };
  const first = capturePayment(order, request, ledger);
  assert.equal(capturePayment(order, request, ledger), first);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].cents, 1234);
});
test('a reused key cannot silently accept a different amount', () => {
  const ledger = [], order = { id: 'order-1', status: 'ready' };
  capturePayment(order, { id: 'request-1', amount: 12.34 }, ledger);
  assert.throws(() => capturePayment(order, { id: 'request-1', amount: 99 }, ledger), /conflict/i);
  assert.equal(ledger.length, 1);
});
test('the same request id is independently scoped to each order', () => {
  const ledger = [];
  for (const id of ['order-1', 'order-2']) capturePayment({ id, status: 'ready' }, { id: 'request-1', amount: 12.34 }, ledger);
  assert.equal(ledger.length, 2);
});
test('unpayable orders and invalid amounts cannot mutate the ledger', () => {
  const ledger = [];
  assert.throws(() => capturePayment({ id: 'order-1', status: 'cancelled' }, { id: 'r', amount: 12 }, ledger));
  assert.throws(() => capturePayment({ id: 'order-1', status: 'ready' }, { id: 'r', amount: -1 }, ledger));
  assert.equal(ledger.length, 0);
});
`;

export function writeFile(root, relative, content) {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 90_000, ...options });
  if (result.error) throw result.error;
  return result;
}

export function requireExit(result, status, label) {
  if (result.status !== status) throw new Error(`${label}: expected exit ${status}, got ${result.status}\n${result.stdout}\n${result.stderr}`);
  const output = result.stdout.trim() || result.stderr.trim();
  try { return JSON.parse(output); } catch { return { output }; }
}

export function createLifecycleFixture({ directory, installedPackageRoot, sourcePackageRoot, forbiddenCorpusRoots = [], corpus = 'minimal' }) {
  const root = directory || fs.mkdtempSync(path.join(os.tmpdir(), 'ae-adaptive-lifecycle-'));
  const fx = { root, installedPackageRoot, corpus, bootstrap: corpus === 'sparse', reviewAgent: corpus === 'sparse' ? 'payment-retry-specialist' : 'enterprise-payment-reviewer', sessionId: 'lifecycle-session', workspace: path.join(root, 'product'), userHome: path.join(root, 'user'), home: path.join(root, 'state'), configHome: path.join(root, 'user/.claude'), skillsHome: path.join(root, 'user/.claude/skills'), enterpriseRoot: path.join(root, 'enterprise'), bin: path.join(installedPackageRoot, 'bin/ae.mjs') };
  for (const dir of [fx.workspace, fx.userHome, fx.home, fx.configHome, fx.skillsHome, fx.enterpriseRoot]) fs.mkdirSync(dir, { recursive: true });
  fx.env = { ...process.env, HOME: fx.userHome, HARNESS_HOME: fx.home, HARNESS_NO_EVENTS: '1', COPILOT_HOME: fx.configHome, AE_SKILLS_HOME: fx.skillsHome, HARNESS_SKILLS_HOME: fx.skillsHome, AE_HOST: 'claude-code', HARNESS_HOST: 'claude-code', AE_BIN: fx.bin, HARNESS_BIN: fx.bin, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'AE lifecycle fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'AE lifecycle fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  delete fx.env.HARNESS_ENFORCEMENT;
  delete fx.env.AE_HOME;
  // Every child CLI is prevented from silently reading the original corpus.
  const probe = writeFile(root, 'deny-source-corpus.mjs', `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
const forbidden = ${JSON.stringify([path.join(sourcePackageRoot, 'corpus'), ...forbiddenCorpusRoots])};
const protect = (owner, keys) => {
  for (const key of keys) {
    const original = owner[key];
    owner[key] = function (file, ...args) {
    const full = file instanceof URL ? fileURLToPath(file) : typeof file === 'string' || Buffer.isBuffer(file) ? path.resolve(String(file)) : null;
    if (full && forbidden.some(root => full === root || full.startsWith(root + path.sep))) throw new Error('Evaluation detected unselected-corpus fallback: ' + full);
    return original.call(this, file, ...args);
    };
  }
};
protect(fs, ['readFileSync', 'readdirSync', 'openSync', 'readFile', 'readdir', 'open', 'createReadStream']);
protect(fs.promises, ['readFile', 'readdir', 'open']);
syncBuiltinESMExports();
`);
  fx.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(probe).href}`].filter(Boolean).join(' ');
  fx.cli = (args, { input } = {}) => run(process.execPath, [fx.bin, ...args, '--workspace', fx.workspace, '--copilot-home', fx.configHome, '--skills-home', fx.skillsHome, '--harness-home', fx.home, '--json', '--no-events'], { cwd: fx.workspace, env: fx.env, input: input === undefined ? undefined : JSON.stringify(input) });
  fx.json = (args, input, expected = 0) => requireExit(fx.cli([...args, '--file', '-'], { input }), expected, args.join(' '));
  fx.hook = (event, payload) => run(process.execPath, [path.join(installedPackageRoot, 'lib/hosts/native-hook.mjs'), '--host', 'claude-code', '--event', event, '--config-home', fx.configHome, '--skills-home', fx.skillsHome, '--ae-home', fx.home], { cwd: fx.workspace, env: fx.env, input: JSON.stringify({ cwd: fx.workspace, workspace: fx.workspace, ...payload }) });
  return fx;
}

export function seedEnterprise(fx) {
  writeFile(fx.enterpriseRoot, 'skills/enterprise-payments/SKILL.md', '---\nname: enterprise-payments\ndescription: Enterprise payment retry and idempotency implementation conventions.\nuser-invocable: false\n---\n# Enterprise payments\nUse an order-scoped request identity. Review duplicate delivery and conflicting amounts independently.\n');
  writeFile(fx.enterpriseRoot, 'agents/enterprise-payment-reviewer.agent.md', '---\nname: enterprise-payment-reviewer\ndescription: Independent payment correctness and code simplicity reviewer.\nuser-invocable: false\ntools: [read, search]\nagents: []\ncapabilities: [code-simplicity-reviewer]\n---\n# Payment reviewer\nJudge retry identity, duplicate writes and mutation ordering from source and executable evidence. Return findings independently from the implementation author.\n');
  writeFile(fx.enterpriseRoot, 'instructions/payment-currency.instructions.md', '---\nname: payment-currency\ndescription: Enterprise currency convention.\napplyTo: "**/payment.mjs"\n---\nPersist integer minor currency units.\n');
  writeFile(fx.enterpriseRoot, 'skills/excluded-private/SKILL.md', '---\nname: excluded-private\ndescription: Excluded payroll export procedure.\nuser-invocable: false\n---\n# Private payroll\nThis excluded resource must never become eligible.\n');
}

export function seedPaymentProject(fx) {
  writeFile(fx.workspace, '.gitignore', '.harness/\n');
  writeFile(fx.workspace, 'src/payment.mjs', 'export function capturePayment() { throw new Error("Payment capture not implemented"); }\n');
  writeFile(fx.workspace, 'test/payment.test.mjs', PAYMENT_TEST);
  writeFile(fx.workspace, 'docs/specs/retry.md', '# Payment delivery retries\n\nThe same payment delivery can arrive more than once. Within an order, a repeated request must return its original receipt and leave exactly one ledger entry. A request identity reused with another amount must reject without mutation. Separate orders can use the same request identity independently. Keep integer minor currency units and existing invalid-order/input protections.\n');
  writeFile(fx.workspace, '.github/harness/checks.yaml', `version: 1\nchecks:\n  payment-behavior:\n    command: ${JSON.stringify([process.execPath, '--test', 'test/payment.test.mjs'])}\n`);
  fx.plan = 'docs/plans/2026-11-06-payment-retries.md';
  writeFile(fx.workspace, fx.plan, `---
plan_schema: 1
title: Payment retry correctness
type: fix
status: in-progress
plan_lock: true
phase: 1
risk: green
intent: Make payment delivery idempotent within each order.
intent_source_policy: content-v1
intent_sources:
  - path: docs/specs/retry.md
    sha256: ${createHash('sha256').update(fs.readFileSync(path.join(fx.workspace, 'docs/specs/retry.md'))).digest('hex')}
expected_outputs: ["A retry-safe capture operation"]
success_criteria: ["AC1 Duplicate delivery cannot charge twice"]
verification:
  required: [payment-behavior]
  criteria:
    AC1: [payment-behavior]
reviews:
  required: [code-review]
  completed: []
  critical_open: []
capability_gaps: []
skills_used: [engineer]
---
# Payment retry correctness

## Overview
Make payment delivery idempotent within each order.

## Intent Contract
- **Goal:** Prevent duplicate payment capture.
- **Expected outputs:** Retry-safe capture.
- **Success criteria:** AC1 is established by executable behavioral checks.

## Acceptance Criteria
- [x] **AC1** Retried delivery returns the same receipt, conflicts reject, and separate orders remain independent.

## Plan
### Phase 1 — Implement
- [x] Implement retry-safe capture and verify its behavior.

## Impacted Files
- \`src/payment.mjs\`
- \`test/payment.test.mjs\`

## Technical Notes
Review request identity, amount conflicts and mutation ordering.

## Verification Plan
Run payment-behavior; it must detect duplicate ledger writes.

## Risk & Review Routing
Obtain an independent payment correctness and simplicity judgment.

## Review Findings
Pending independent review.

## Activity
- Evaluation fixture prepared.
`);
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-qm', 'Payment baseline']]) requireExit(run('git', args, { cwd: fx.workspace, env: fx.env }), 0, `git ${args[0]}`);
  writeFile(fx.workspace, 'src/payment.mjs', PAYMENT_BAD);
}

export function forwardTask(fx) {
  return `Use the installed AE Engineer at ${fx.skillsHome}/engineer/SKILL.md to implement the payment retry fix described in docs/specs/retry.md in ${fx.workspace}, and make it ready for my review. The selected AE CLI is ${fx.bin}; host config is ${fx.configHome}, skills root ${fx.skillsHome}, and state home ${fx.home}. Our enterprise customization root ${fx.enterpriseRoot} is part of the consented setup; preserve our conventions. Work only inside these disposable fixture roots.`;
}
