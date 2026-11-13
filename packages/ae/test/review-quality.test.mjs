import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { validateFlowLedger, synthesizeReview, workspaceLines, FLOW_CLASSES } from '../lib/review-synthesis.mjs';
import { reviewBudget, FLOW_REVIEWER } from '../lib/review-preparation.mjs';
import { reviewImpact, impactDependents, MAX_IMPACT_SEEDS } from '../lib/review-impact.mjs';
import { prepareDecision, observeDecisionInvocation, recordDecision, findingVerification } from '../lib/decision-agent.mjs';
import { reviewRules, rulesForFiles, feedbackIdentity, RULE_THRESHOLDS } from '../lib/feedback-records.mjs';
import { validateFeedbackFields } from '../lib/learning-feedback.mjs';

const tmp = (t, prefix) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const row = (flow_class, fields = {}) => ({ flow_class, entry: 'ae example', input: `${flow_class} input`, path: ['src/a.mjs:1'], expected: 'Refuse', observed: 'Refuses', verdict: 'gap', test: null, ...fields });
const fullLedger = (overrides = {}) => FLOW_CLASSES.map(flowClass => row(flowClass, overrides[flowClass] || {}));

test('the flow ledger needs every class, evidence for each verdict and a matching finding for each defect', () => {
  assert.match(validateFlowLedger(undefined).errors[0], /Missing flow_ledger/);
  assert.match(validateFlowLedger([]).errors[0], /Missing flow_ledger/);
  assert.deepEqual(validateFlowLedger(fullLedger()).errors, []);
  assert.deepEqual(validateFlowLedger(fullLedger({ positive: { finding: null }, boundary: { finding: null } })).errors, [], 'a null finding on a non-defect row is allowed');
  assert.equal(validateFlowLedger(fullLedger()).rows.length, FLOW_CLASSES.length);
  const missing = validateFlowLedger(fullLedger().filter(r => r.flow_class !== 'abuse'));
  assert.ok(missing.errors.some(e => /missing flow classes: abuse/.test(e)));
  // Each traced entry point covers every class: a second entry with one row is incomplete.
  const twoEntries = validateFlowLedger([...fullLedger(), row('positive', { entry: 'ae other' })]);
  assert.ok(twoEntries.errors.some(e => /entry ae other is missing flow classes: malformed-input/.test(e)));
  assert.deepEqual(validateFlowLedger([...fullLedger(), ...FLOW_CLASSES.map(c => row(c, { entry: 'ae  other' }))]).errors, []);
  // With a workspace resolver, hops and tests must name real files and lines.
  const lineCount = file => ({ 'src/a.mjs': 3, 'test/a.test.mjs': 10 })[file] ?? null;
  assert.deepEqual(validateFlowLedger(fullLedger({ positive: { verdict: 'pass', test: 'test/a.test.mjs: exports a' } }), [], { lineCount }).errors, []);
  assert.ok(validateFlowLedger(fullLedger({ boundary: { path: ['src/a.mjs:4'] } }), [], { lineCount }).errors.some(e => /does not name a line/.test(e)));
  assert.ok(validateFlowLedger(fullLedger({ boundary: { path: ['src/missing.mjs:1'] } }), [], { lineCount }).errors.some(e => /does not name a line/.test(e)));
  assert.ok(validateFlowLedger(fullLedger({ positive: { verdict: 'pass', test: 'it works' } }), [], { lineCount }).errors.some(e => /existing test file/.test(e)));
  assert.ok(validateFlowLedger(fullLedger({ positive: { verdict: 'pass', test: 'src/a.mjs' } }), [], { lineCount }).errors.some(e => /existing test file/.test(e)), 'a source file is not a covering test');
  // Entries that differ only in case or spacing are one entry.
  assert.deepEqual(validateFlowLedger(FLOW_CLASSES.map((c, i) => row(c, { entry: i % 2 ? 'AE  Example' : 'ae example' }))).errors, []);
  assert.deepEqual(missing.rows, []);
  const cases = [
    [{ positive: { verdict: 'pass' } }, /without a covering test is a gap/],
    [{ positive: { verdict: 'not-applicable', path: [] } }, /positive flow cannot be not-applicable/],
    [{ boundary: { path: [] } }, /needs at least one file:line hop/],
    [{ boundary: { path: ['src/a.mjs'] } }, /file:line hops/],
    [{ boundary: { path: Array.from({ length: 25 }, (_, i) => `src/a.mjs:${i + 1}`) } }, /file:line hops/],
    [{ abuse: { verdict: 'defect', finding: 'Not reported' } }, /defect must name the title of a finding/],
    [{ abuse: { finding: 'Stray' } }, /only a defect names a finding/],
    [{ concurrency: { verdict: 'maybe' } }, /invalid verdict/],
    [{ concurrency: { extra: true } }, /unknown fields: extra/],
    [{ 'old-state': { observed: '' } }, /needs observed text/],
  ];
  for (const [overrides, pattern] of cases) assert.ok(validateFlowLedger(fullLedger(overrides)).errors.some(e => pattern.test(e)), String(pattern));
  // A not-applicable negative class needs no hop; a defect binds the finding by normalized title.
  const ok = validateFlowLedger(fullLedger({ concurrency: { verdict: 'not-applicable', path: [] }, abuse: { verdict: 'defect', finding: 'swallowed  FLAG' } }), [{ title: 'Swallowed flag' }]);
  assert.deepEqual(ok.errors, []);
  assert.match(validateFlowLedger(Array.from({ length: 129 }, () => row('positive'))).errors[0], /exceeds 128 rows/);
});

test('the review budget always spends one seat on correctness and covers JavaScript with the language reviewer', () => {
  assert.deepEqual(reviewBudget(['src/a.mjs']), [FLOW_REVIEWER, 'compounding-typescript-reviewer', 'code-simplicity-reviewer']);
  assert.deepEqual(reviewBudget(['lib/x.cjs', 'lib/y.jsx']), [FLOW_REVIEWER, 'compounding-typescript-reviewer', 'code-simplicity-reviewer']);
  assert.deepEqual(reviewBudget(['docs/readme.md']), [FLOW_REVIEWER, 'code-simplicity-reviewer']);
  const large = reviewBudget(Array.from({ length: 9 }, (_, i) => `src/f${i}.mjs`));
  assert.deepEqual(large, [FLOW_REVIEWER, 'security-sentinel', 'architecture-strategist']);
  assert.ok(reviewBudget(['src/auth/login.mjs']).includes('security-sentinel'));
  for (const files of [['a.py'], ['a.java', 'b.mjs'], Array.from({ length: 20 }, (_, i) => `auth/f${i}.py`)]) assert.ok(reviewBudget(files).length <= 3);
});

function graphRepo(t) {
  const ws = tmp(t, 'ae-impact-'), home = tmp(t, 'ae-impact-home-');
  fs.mkdirSync(path.join(ws, 'src'));
  fs.writeFileSync(path.join(ws, 'src/core.mjs'), 'export const core = 1;\n');
  fs.writeFileSync(path.join(ws, 'src/use.mjs'), "import { core } from './core.mjs';\nexport const use = core + 1;\n");
  fs.writeFileSync(path.join(ws, 'src/top.mjs'), "import { use } from './use.mjs';\nexport const top = use;\n");
  git(ws, 'init', '-q'); git(ws, 'add', '.'); git(ws, 'commit', '-qm', 'init');
  return { ws, home };
}

test('impact lists bound reverse dependents and reports unknown coverage with a reason, never as no dependents', t => {
  const { ws, home } = graphRepo(t);
  fs.writeFileSync(path.join(ws, 'src/new.mjs'), 'export const fresh = true;\n');
  const impact = reviewImpact({ workspace: ws, home, files: ['src/core.mjs', 'src/new.mjs', 'README.md', 'src/core.mjs'] });
  assert.equal(impact.schema, 'review-impact-v1');
  assert.equal(impact.authority, 'descriptive-context');
  assert.deepEqual(impact.seeds.map(seed => seed.file), ['src/core.mjs', 'src/new.mjs']);
  const core = impact.seeds[0];
  assert.equal(core.outcome, 'found', JSON.stringify(core));
  assert.deepEqual(core.dependents.map(d => [d.file, d.distance]), [['src/use.mjs', 1], ['src/top.mjs', 2]]);
  assert.ok(core.dependents.every(d => /^[a-f0-9]{64}$/.test(d.sha256)));
  assert.equal(core.reason, undefined);
  const fresh = impact.seeds[1];
  assert.notEqual(fresh.outcome, 'found');
  assert.ok(fresh.reason && fresh.reason.length <= 300);
  assert.deepEqual(fresh.dependents, []);
  assert.ok(impact.limitations.some(text => /never means the file has no dependents/.test(text)));
  assert.equal(impact.rules, undefined, 'learned rules stay out while knowledge.feedback is off');
  assert.deepEqual(impactDependents(impact).map(d => d.file).sort(), ['src/top.mjs', 'src/use.mjs']);
  assert.deepEqual(impactDependents({ seeds: [{ dependents: 'x' }, null] }), []);
  const many = reviewImpact({ workspace: ws, home, files: Array.from({ length: MAX_IMPACT_SEEDS + 3 }, (_, i) => `src/x${i}.mjs`) });
  assert.equal(many.seeds.length, MAX_IMPACT_SEEDS);
  assert.equal(many.omittedSeeds, 3);
});

function synthesisWorkspace(t) {
  const ws = tmp(t, 'ae-verify-');
  fs.mkdirSync(path.join(ws, 'src'));
  fs.writeFileSync(path.join(ws, 'src/a.mjs'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  return ws;
}
const finding = (fields = {}) => ({ file: 'src/a.mjs', line: 1, title: 'Unchecked input', description: 'Input reaches the write unchecked.', suggested_fix: 'Validate it.', severity: 'P2', confidence: 0.8, autofix_class: 'manual', evidence: ['src/a.mjs:1'], ...fields });
const PACKET = 'a'.repeat(64);

test('decision-agent verification confirms, refutes or disputes a finding only through a matching receipt', t => {
  const ws = synthesisWorkspace(t);
  const input = { results: [{ reviewer: 'code-simplicity-reviewer', status: 'completed', residual_risks: [], testing_gaps: [], findings: [finding(), finding({ line: 2, title: 'Second' }), finding({ line: 3, title: 'Critical', severity: 'P1' })] }] };
  const base = synthesizeReview(ws, ['code-simplicity-reviewer'], input, [], [], false, { packetId: PACKET });
  const ids = Object.fromEntries(base.findings.map(f => [f.title, f]));
  const receipts = new Map();
  const judge = (f, verdict, request) => receipts.set(request, { requestId: request, verdict, receipt: 'r'.repeat(64), reason: 'Checked.', finding: { packet: PACKET, id: f.id, file: f.file, line: f.line, severity: f.severity, title: f.title } });
  judge(ids['Unchecked input'], 'allow', '1'.repeat(64));
  judge(ids.Second, 'deny', '2'.repeat(64));
  judge(ids.Critical, 'deny', '3'.repeat(64));
  const verifications = [...receipts.values()].map(r => ({ finding: r.finding.id, request: r.requestId }));
  const verified = synthesizeReview(ws, ['code-simplicity-reviewer'], { ...input, verifications }, [], [], false, { packetId: PACKET, verificationFor: id => receipts.get(id) });
  assert.deepEqual(verified.failures, []);
  const byTitle = Object.fromEntries(verified.findings.map(f => [f.title, f]));
  assert.equal(byTitle['Unchecked input'].verification.state, 'confirmed');
  assert.equal(byTitle.Critical.verification.state, 'disputed', 'a refuted P1 stays open for a person');
  assert.equal(byTitle.Second.verification.state, 'refuted', 'a refuted P2 stays listed until refutation accuracy is measured');
  assert.equal(verified.suppressed.length, 0);
  // The receipt must also carry the finding's title.
  const retitled = new Map([['5'.repeat(64), { ...receipts.get('1'.repeat(64)), requestId: '5'.repeat(64), finding: { ...receipts.get('1'.repeat(64)).finding, title: 'Another claim' } }]]);
  const wrongTitle = synthesizeReview(ws, ['code-simplicity-reviewer'], { ...input, verifications: [{ finding: ids['Unchecked input'].id, request: '5'.repeat(64) }] }, [], [], false, { packetId: PACKET, verificationFor: id => retitled.get(id) });
  assert.ok(wrongTitle.failures.some(f => f.errors.some(e => /no recorded decision-agent receipt/.test(e))));
  // A receipt for another packet, location or severity never applies.
  const other = new Map([['4'.repeat(64), { ...receipts.get('1'.repeat(64)), requestId: '4'.repeat(64), finding: { ...receipts.get('1'.repeat(64)).finding, packet: 'b'.repeat(64) } }]]);
  const mismatched = synthesizeReview(ws, ['code-simplicity-reviewer'], { ...input, verifications: [{ finding: ids['Unchecked input'].id, request: '4'.repeat(64) }] }, [], [], false, { packetId: PACKET, verificationFor: id => other.get(id) });
  assert.ok(mismatched.failures.some(f => f.errors.some(e => /no recorded decision-agent receipt/.test(e))));
  assert.equal(mismatched.findings.find(f => f.title === 'Unchecked input').verification, undefined);
  for (const bad of [[{ finding: 'x', request: 'y' }], [{ finding: ids.Second.id, request: '2'.repeat(64), approved: true }], 'all', Array.from({ length: 65 }, () => ({}))]) {
    const result = synthesizeReview(ws, ['code-simplicity-reviewer'], { ...input, verifications: bad }, [], [], false, { packetId: PACKET, verificationFor: id => receipts.get(id) });
    assert.ok(result.failures.length, JSON.stringify(bad).slice(0, 40));
  }
  const duplicate = synthesizeReview(ws, ['code-simplicity-reviewer'], { ...input, verifications: [verifications[0], { ...verifications[0], request: '2'.repeat(64) }] }, [], [], false, { packetId: PACKET, verificationFor: id => receipts.get(id) });
  assert.ok(duplicate.failures.some(f => f.errors.some(e => /more than one verification/.test(e))));
});

test('the decision agent judges a finding moment and the receipt is readable for review assembly', t => {
  const root = tmp(t, 'ae-finding-');
  const workspace = path.join(root, 'product'), home = path.join(root, 'state');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true }); fs.mkdirSync(home);
  fs.writeFileSync(path.join(workspace, 'src/a.mjs'), 'export const a = 1;\n');
  const policy = { revision: 'consent-1', enabled: true, tools: ['Bash'], types: ['finding', 'action'], create: [], update: [], memory: false, budgets: { maxDecisions: 8, maxRepairs: 2, maxAcquisitions: 2, maxSeconds: 60 } };
  const value = { packet: PACKET, id: 'c'.repeat(64), file: 'src/a.mjs', line: 1, severity: 'P2', title: 'Unchecked input' };
  const input = { schema: 1, taskId: 'task-1', sessionId: 'session-1', type: 'finding', intent: 'Verify one review finding against the code.', finding: value, sources: [] };
  assert.throws(() => prepareDecision({ workspace, home, policy, input: { ...input, finding: undefined } }), /require the exact review finding/);
  assert.throws(() => prepareDecision({ workspace, home, policy, input: { ...input, type: 'action', action: { tool: 'Bash', input: { command: 'true' }, cwd: workspace } } }), /only finding decisions/);
  assert.throws(() => prepareDecision({ workspace, home, policy, input: { ...input, finding: { ...value, file: '../x' } } }), /inside the workspace/);
  const prepared = prepareDecision({ workspace, home, policy, input });
  assert.deepEqual(prepared.packet.finding, value);
  assert.equal(findingVerification({ workspace, home, requestId: prepared.requestId }), null, 'no receipt before a recorded verdict');
  const judgment = { schema: 1, requestId: prepared.requestId, verdict: 'deny', reason: 'The input is validated at the caller.', evidence: ['src/a.mjs:1 is only reached after validation.'] };
  const payload = { cwd: workspace, session_id: 'session-1', tool_name: 'Agent', tool_use_id: 'call-1', tool_input: { subagent_type: 'decision-agent' }, tool_response: { content: [{ type: 'text', text: JSON.stringify(judgment) }] }, success: true };
  assert.equal(observeDecisionInvocation({ workspace, home, policy, payload }).observed, true);
  recordDecision({ workspace, home, policy, input: { schema: 1, requestId: prepared.requestId } });
  const verification = findingVerification({ workspace, home, requestId: prepared.requestId });
  assert.equal(verification.verdict, 'deny');
  assert.deepEqual(verification.finding, value);
  assert.match(verification.receipt, /^[a-f0-9]{64}$/);
  assert.equal(findingVerification({ workspace, home, requestId: 'not-an-id' }), null);
  // Finding moments use their own counter: a tight decision budget still allows verification, and vice versa.
  const tight = { ...policy, budgets: { ...policy.budgets, maxDecisions: 1 } };
  for (let i = 0; i < 3; i += 1) prepareDecision({ workspace, home, policy: tight, input: { ...input, taskId: 'task-2', finding: { ...value, id: String(i).repeat(64) } } });
  prepareDecision({ workspace, home, policy: tight, input: { schema: 1, taskId: 'task-2', sessionId: 'session-1', type: 'action', intent: 'Run a check.', action: { tool: 'Bash', input: { command: 'true' }, cwd: workspace }, sources: [] } });
});

const record = (plan, findings = [], missed) => ({ version: 1, operation: 'op', plan, findings, ...(missed ? { missed } : {}) });
const dismissed = (file, reviewer = 'code-simplicity-reviewer') => ({ id: 'f'.repeat(64), disposition: 'dismissed', reviewers: [reviewer], file });

test('learned review rules need repeated dismissals across plans and never quiet correctness or security', () => {
  const t = RULE_THRESHOLDS;
  assert.deepEqual(reviewRules({ records: [] }).active, []);
  const two = reviewRules({ records: [record('p1', [dismissed('lib/a.mjs')]), record('p2', [dismissed('lib/b.mjs')])] });
  assert.equal(two.active.length, 0);
  assert.equal(two.candidates[0].kind, 'noise');
  const records = [record('p1', [dismissed('lib/a.mjs'), dismissed('lib/b.mjs')]), record('p2', [dismissed('lib/c.mjs')])];
  const three = reviewRules({ records });
  assert.equal(three.active.length, 1);
  assert.deepEqual([three.active[0].reviewer, three.active[0].area, three.active[0].dismissed, three.active[0].plans], ['code-simplicity-reviewer', 'lib', 3, 2]);
  assert.match(three.active[0].guidance, /never lower a P1/);
  assert.equal(three.authority, 'advisory');
  // One plan alone, or a low dismissed share, stays a candidate.
  assert.equal(reviewRules({ records: [record('p1', [dismissed('lib/a.mjs'), dismissed('lib/b.mjs'), dismissed('lib/c.mjs')])] }).active.length, 0);
  const fixed = { ...dismissed('lib/d.mjs'), disposition: 'fixed' };
  assert.equal(reviewRules({ records: [...records, record('p3', [fixed, { ...fixed, id: '2'.repeat(64) }])] }).active.length, 0);
  for (const reviewer of ['spec-flow-analyzer', 'security-sentinel']) {
    const exempt = reviewRules({ records: [1, 2, 3, 4].map(n => record(`p${n}`, [dismissed('lib/a.mjs', reviewer)])) });
    assert.equal(exempt.active.length + exempt.candidates.length, 0, reviewer);
  }
  // Unsafe or absent files never form a rule.
  assert.equal(reviewRules({ records: [1, 2, 3].map(n => record(`p${n}`, [dismissed('../x.mjs'), dismissed(undefined)])) }).candidates.length, 0);
  assert.ok(t.noiseActive >= t.noiseCandidate);
  // Repeated decisions of one plan count a disposition once.
  const repeated = { ...dismissed('lib/a.mjs'), id: '1'.repeat(64) };
  assert.equal(reviewRules({ records: [record('p1', [repeated]), record('p1', [repeated]), record('p2', [dismissed('lib/b.mjs')])] }).active.length, 0);
});

test('missed defects become rules for their area and match changed files under it', () => {
  const miss = (file, source = 'copilot') => ({ file, title: `Bug in ${file}`, source });
  const one = reviewRules({ records: [record('p1', [], [miss('lib/knowledge/a.mjs'), miss('lib/knowledge/b.mjs')])] });
  assert.equal(one.active.length, 0);
  assert.equal(one.candidates[0].kind, 'missed');
  const rules = reviewRules({ records: [record('p1', [], [miss('lib/knowledge/a.mjs')]), record('p2', [], [miss('lib/knowledge/b.mjs', 'ci')])] });
  assert.equal(rules.active[0].area, 'lib/knowledge');
  assert.deepEqual(rules.active[0].sources, ['ci', 'copilot']);
  assert.equal(rulesForFiles(rules, ['lib/knowledge/a.mjs']).length, 1);
  assert.equal(rulesForFiles(rules, ['lib/knowledge/deep/c.mjs']).length, 1);
  assert.equal(rulesForFiles(rules, ['lib/knowledgebase/c.mjs']).length, 0);
  assert.equal(rulesForFiles(rules, ['lib/other.mjs']).length, 0);
  // The same miss repeated in two decisions of one plan stays a candidate.
  const same = reviewRules({ records: [record('p1', [], [miss('lib/x/a.mjs')]), record('p1', [], [miss('lib/x/a.mjs')])] });
  assert.equal(same.active.length, 0);
  assert.equal(same.candidates[0].missed, 1);
  assert.equal(reviewRules({ records: [record('p1', [], [miss('docs/My File.md')]), record('p2', [], [miss('docs/Ünïcode.md')])] }).active[0].area, 'docs');
  assert.equal(reviewRules({ records: [record('p1', [], [miss('docs/Cafe\u0301.md')]), record('p2', [], [miss('docs/x.md')])] }).active[0].missed, 2, 'decomposed names count');
  assert.equal(reviewRules({ records: [record('p1', [], [miss('docs/\u0301x.md')]), record('p2', [], [miss('docs/\u0301y.md')])] }).candidates.length + reviewRules({ records: [record('p1', [], [miss('docs/\u0301x.md')])] }).active.length, 0, 'no segment starts with a combining mark');
});

test('a missed field is validated, joins feedback identity only when present and never needs a review record', t => {
  const root = tmp(t, 'ae-missed-');
  const decision = { missed: [{ file: 'lib/a.mjs', title: 'Swallowed flag accepted', source: 'copilot' }] };
  assert.deepEqual(validateFeedbackFields(decision, { recordRoot: root, planPath: 'docs/plans/x.md' }).missed, decision.missed);
  const bad = [
    { missed: [] },
    { missed: [{ file: '/etc/passwd', title: 'x', source: 'copilot' }] },
    { missed: [{ file: 'lib/../x', title: 'x', source: 'copilot' }] },
    { missed: [{ file: 'lib/a.mjs', title: 'line\nbreak', source: 'copilot' }] },
    { missed: [{ file: 'lib/a.mjs', title: 'x', source: 'Copilot Review' }] },
    { missed: [{ file: 'lib/a.mjs', title: 'x', source: 'ci', severity: 'P1' }] },
    { missed: [{ file: 'lib/a.mjs', title: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', source: 'ci' }] },
    { missed: [decision.missed[0], decision.missed[0]] },
  ];
  for (const value of bad) assert.throws(() => validateFeedbackFields(value, { recordRoot: root, planPath: 'docs/plans/x.md' }), JSON.stringify(value).slice(0, 60));
  assert.equal(feedbackIdentity({ recalled: [], findings: [] }), JSON.stringify([[], []]), 'records without missed keep their identity');
  assert.notEqual(feedbackIdentity({ recalled: [], findings: [], missed: decision.missed }), feedbackIdentity({ recalled: [], findings: [] }));
});

test('workspace line counts ignore a trailing newline and refuse paths outside the workspace', t => {
  const ws = tmp(t, 'ae-lines-');
  fs.writeFileSync(path.join(ws, 'two.txt'), 'a\nb\n');
  fs.writeFileSync(path.join(ws, 'open.txt'), 'a\nb');
  fs.writeFileSync(path.join(ws, 'empty.txt'), '');
  fs.writeFileSync(path.join(ws, 'crlf.txt'), 'a\r\nb\r\n');
  fs.symlinkSync(os.tmpdir(), path.join(ws, 'out'));
  const lines = workspaceLines(ws);
  assert.deepEqual(['two.txt', 'open.txt', 'empty.txt', 'crlf.txt'].map(lines), [2, 2, 0, 2]);
  for (const bad of ['../x', '/etc/passwd', 'C:/x', 'missing.txt', 'out/anything', '']) assert.equal(lines(bad), null, bad);
});

test('old decision state with a malformed finding counter is refused', t => {
  const root = tmp(t, 'ae-finding-state-');
  const workspace = path.join(root, 'product'), home = path.join(root, 'state');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true }); fs.mkdirSync(home);
  fs.writeFileSync(path.join(workspace, 'src/a.mjs'), 'export const a = 1;\n');
  const policy = { revision: 'consent-1', enabled: true, tools: [], types: ['finding'], create: [], update: [], memory: false, budgets: { maxDecisions: 8, maxRepairs: 2, maxAcquisitions: 2, maxSeconds: 60 } };
  const input = { schema: 1, taskId: 'task-1', sessionId: 'session-1', type: 'finding', intent: 'Verify one finding.', finding: { packet: PACKET, id: 'c'.repeat(64), file: 'src/a.mjs', line: 1, severity: 'P2', title: 'T' }, sources: [] };
  const prepared = prepareDecision({ workspace, home, policy, input });
  const store = prepared.storePath, state = JSON.parse(fs.readFileSync(store, 'utf8'));
  for (const task of Object.values(state.tasks)) task.counts.findings = -5;
  fs.writeFileSync(store, JSON.stringify(state));
  assert.throws(() => prepareDecision({ workspace, home, policy, input: { ...input, finding: { ...input.finding, id: 'd'.repeat(64) } } }), /malformed/);
});
