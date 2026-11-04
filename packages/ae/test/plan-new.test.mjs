import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import YAML from 'yaml';
import { buildPlanSkeleton } from '../lib/plan-new.mjs';
import { tempDir } from './helpers/temp.mjs';

const binPath = path.resolve(import.meta.dirname, '..', 'bin', 'ae.mjs');
const roots = [];
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const aeHome = ws => path.join(path.dirname(ws), 'harness-home');
const copilotHome = ws => path.join(path.dirname(ws), '.copilot-home');
const runtimeEnv = ws => ({ ...process.env, COPILOT_HOME: copilotHome(ws), AE_HOME: aeHome(ws), HARNESS_HOME: aeHome(ws) });

function workspace() {
  const root = tempDir('harness-plannew-');
  roots.push(root);
  const ws = path.join(root, 'product');
  fs.mkdirSync(path.join(ws, 'docs', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'policy.yaml'), 'version: 1\nenforcement: enforce\ngate_ttl_minutes: 30\nevidence_ttl_hours: 24\n');
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'checks.yaml'), 'version: 1\nchecks:\n  unit-tests:\n    command: [npm, test]\n');
  const git = (a) => spawnSync('git', a, { cwd: ws, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  git(['init', '-q']);
  git(['config', 'user.email', 'e@x.test']);
  git(['config', 'user.name', 'T']);
  return ws;
}

function harness(ws, args) {
  const home = copilotHome(ws);
  fs.mkdirSync(home, { recursive: true });
  const r = spawnSync(process.execPath, [binPath, ...args, '--workspace', ws, '--copilot-home', home], {
    cwd: ws,
    encoding: 'utf8',
    env: runtimeEnv(ws),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function writePlan(ws, opts) {
  const { path: rel, content } = buildPlanSkeleton({ check: 'unit-tests', ...opts });
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return rel;
}

test('scaffolded feat plan passes validate-plan and the implement gate', () => {
  const ws = workspace();
  const rel = writePlan(ws, { type: 'feat', slug: 'payment-audit', intent: 'Add audit logging to the override path', date: '2026-07-21', impacted: ['src/PaymentController.java'] });
  assert.equal(harness(ws, ['validate-plan', '--plan', rel]).status, 0);
  const gate = harness(ws, ['gate', '--phase', 'implement', '--plan', rel, '--json']);
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  assert.equal(JSON.parse(gate.stdout).pass, true);
  const session = JSON.parse(fs.readFileSync(path.join(ws, '.harness', 'session.json'), 'utf8'));
  assert.match(session.gatedChecksDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(session.gatedCheckCommands, [{ name: 'unit-tests', argv: ['npm', 'test'] }]);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('a personal skill path is refused and no plan file is written', () => {
  const ws = workspace();
  assert.throws(
    () => buildPlanSkeleton({
      check: 'unit-tests',
      type: 'feat',
      slug: 'payment-check-skill',
      intent: 'Create the payment-check skill',
      date: '2026-07-21',
      impacted: ['.github/skills/payment-check/SKILL.md'],
    }),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.equal(err.exit, 1);
      assert.match(err.message, /ae resources create/);
      assert.match(err.message, /\.github\/skills\/payment-check\/SKILL\.md/);
      return true;
    },
  );
  const cli = harness(ws, [
    'plan-new', '--type', 'feat', '--slug', 'payment-check-skill', '--intent', 'Create the payment-check skill',
    '--date', '2026-07-21', '--impacted', '.github/skills/payment-check/SKILL.md', '--json',
  ]);
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(`${cli.stdout}\n${cli.stderr}`, /ae resources create/);
  assert.deepEqual(fs.readdirSync(path.join(ws, 'docs', 'plans')), []);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('scaffolded corpus skill plan includes governance and the gate requires create-primitive', () => {
  const ws = workspace();
  const rel = writePlan(ws, { type: 'feat', slug: 'payment-check-skill', intent: 'Create the payment-check skill', date: '2026-07-21', impacted: ['packages/ae/corpus/skills/payment-check/SKILL.md'] });
  const content = fs.readFileSync(path.join(ws, rel), 'utf8');
  assert.match(content, /## Primitive Governance/);
  assert.match(content, /Primitive classification: skill/);
  assert.deepEqual(YAML.parse(content.match(/^---\n([\s\S]*?)\n---/)[1]).skills_used, ['engineer']);
  const gate = harness(ws, ['gate', '--phase', 'implement', '--plan', rel, '--json']);
  assert.equal(JSON.parse(gate.stdout).pass, false, gate.stdout);
  assert.match(gate.stdout, /create-primitive/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('a full creation decision can record the skills actually loaded for primitive maintenance', () => {
  const ws = workspace();
  try {
    const decision = {
      version: 1, format: 'full', type: 'fix', slug: 'maintain-skill',
      goal: 'Repair an existing workflow', acceptance: ['The contract is consistent'],
      scope: ['packages/ae/corpus/skills/existing/SKILL.md'], check: 'unit-tests',
      skillsUsed: ['engineer', 'create-primitive', 'architect'],
    };
    fs.writeFileSync(path.join(ws, 'decision.json'), JSON.stringify(decision));
    const created = harness(ws, ['plan-new', '--file', 'decision.json', '--json']);
    assert.equal(created.status, 0, created.stdout + created.stderr);
    const content = fs.readFileSync(JSON.parse(created.stdout).path, 'utf8');
    assert.deepEqual(YAML.parse(content.match(/^---\n([\s\S]*?)\n---/)[1]).skills_used, decision.skillsUsed);
    decision.skillsUsed = ['create-primitive\nengineer'];
    fs.writeFileSync(path.join(ws, 'decision.json'), JSON.stringify(decision));
    const invalid = harness(ws, ['plan-new', '--file', 'decision.json', '--json']);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stdout + invalid.stderr, /skillsUsed/);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('scaffolded capability-gap plan is blocked-capability and the gate denies it', () => {
  const ws = workspace();
  const rel = writePlan(ws, {
    type: 'feat',
    slug: 'payment-audit',
    intent: 'Add audit logging',
    date: '2026-07-21',
    impacted: ['src/PaymentController.java'],
    gap: { id: 'payment-audit-skill', primitive: 'src/PaymentAudit.java' },
  });
  const content = fs.readFileSync(path.join(ws, rel), 'utf8');
  assert.match(content, /status: blocked-capability/);
  assert.match(content, /id: payment-audit-skill\n\s+class: hard\n\s+fulfillment: proposed/);
  const gate = harness(ws, ['gate', '--phase', 'implement', '--plan', rel, '--json']);
  const body = JSON.parse(gate.stdout);
  assert.equal(body.pass, false);
  assert.match(body.blockedReason || '', /blocked-capability/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('CLI: plan-new rejects trailing operands without parsing them as flags', () => {
  const ws = workspace();
  const r = spawnSync(
    process.execPath,
    [
      binPath, 'plan-new', '--type', 'feat', '--slug', 'boundary-demo', '--intent', 'Do the thing',
      '--date', '2026-07-21', '--workspace', ws, '--title', '--', '--json',
    ],
    { cwd: ws, encoding: 'utf8', env: runtimeEnv(ws) }
  );
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unexpected argument --json/);
  assert.throws(() => JSON.parse(r.stderr), 'the post-boundary --json must not select JSON output');
  assert.equal(fs.existsSync(aeHome(ws)) && fs.readdirSync(aeHome(ws), { recursive: true }).some(name => String(name).endsWith('boundary-demo-plan.md')), false);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('CLI: plan-new accepts an equals file path with spaces and equals characters', () => {
  const ws = workspace();
  const file = 'creation decision=ready.json';
  fs.writeFileSync(path.join(ws, file), JSON.stringify({ version: 1, format: 'full', slug: 'equals-input', goal: 'Preserve the exact input path', acceptance: ['The plan is authored'], check: 'unit-tests' }));
  const result = harness(ws, ['plan-new', `--file=${file}`, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(JSON.parse(result.stdout).path, 'utf8'), /Preserve the exact input path/);
});

test('CLI: plan-new preserves equals authoring flags in the written full plan', () => {
  const ws = workspace();
  const result = harness(ws, [
    'plan-new', '--type=fix', '--slug=inline-authoring', '--title=Keep title = exact',
    '--intent=Keep every authored input = exact', '--date=2026-07-21',
    '--impacted=src/critical=a.js,src/with spaces.js', '--criteria=Preserve the declared scope',
    '--risk=amber', '--status=planned', '--verification-check=unit-tests', '--json',
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const content = fs.readFileSync(JSON.parse(result.stdout).path, 'utf8');
  const fm = YAML.parse(content.match(/^---\n([\s\S]*?)\n---/)[1]);
  assert.equal(fm.title, 'Keep title = exact');
  assert.equal(fm.intent, 'Keep every authored input = exact');
  assert.equal(fm.type, 'fix');
  assert.equal(fm.risk, 'amber');
  assert.equal(fm.status, 'planned');
  assert.deepEqual(fm.verification.required, ['unit-tests']);
  assert.match(content, /\*\*AC1\*\* Preserve the declared scope/);
  assert.match(content, /- `src\/critical=a\.js`\n- `src\/with spaces\.js`/);
});

test('CLI: plan-new preserves inline short-plan goals and mixed scope flags', () => {
  for (const goalArgs of [['--goal=Preserve every input = exact'], ['--goal', 'Preserve every input = exact']]) {
    const ws = workspace();
    const result = harness(ws, [
      'plan-new', ...goalArgs, '--acceptance=The scope is recorded',
      '--constraint', 'Keep the implementation bounded', '--impacted=critical=a.js',
      '--impacted', 'with spaces.js', '--verification-check=unit-tests', '--json',
    ]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const content = fs.readFileSync(JSON.parse(result.stdout).path, 'utf8');
    assert.match(content, /Preserve every input = exact/);
    assert.match(content, /The scope is recorded/);
    assert.match(content, /Keep the implementation bounded/);
    assert.match(content, /- `critical=a\.js`\n- `with spaces\.js`/);
  }
});

test('CLI: plan-new rejects JSON decisions mixed with inline authoring before reading the file', () => {
  for (const fileArgs of [['--file', 'decision.json'], ['--file=decision.json']]) {
    const ws = workspace();
    for (const authored of ['--title=ShouldReject', '--impacted=critical.js']) {
      const decision = { version: 1, format: 'full', slug: 'conflicting-input', goal: 'Keep every input', acceptance: ['No inputs are lost'], check: 'unit-tests' };
      fs.writeFileSync(path.join(ws, 'decision.json'), JSON.stringify(decision));
      const result = harness(ws, ['plan-new', ...fileArgs, authored, '--json']);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /--file cannot be combined with authoring flags/);
      assert.equal(fs.existsSync(aeHome(ws)) && fs.readdirSync(aeHome(ws), { recursive: true }).some(name => String(name).includes('conflicting-input-plan')), false);
      fs.unlinkSync(path.join(ws, 'decision.json'));
      const missing = harness(ws, ['plan-new', ...fileArgs, authored, '--json']);
      assert.match(missing.stderr, /--file cannot be combined with authoring flags/);
    }
  }
});

test('CLI: plan-new keeps consumed option-shaped titles literal', () => {
  for (const title of ['--impacted=x', '--goal', '--from']) {
    const ws = workspace();
    const result = harness(ws, [
      'plan-new', '--slug', 'literal-title', '--intent', 'Keep the literal title',
      '--title', title, '--json',
    ]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const content = fs.readFileSync(JSON.parse(result.stdout).path, 'utf8');
    assert.equal(YAML.parse(content.match(/^---\n([\s\S]*?)\n---/)[1]).title, title);
    assert.doesNotMatch(content, /- `x`/);
  }
});

test('CLI: plan-new rejects missing values and inline booleans without writing a plan', () => {
  for (const suffix of [['--title'], ['--title='], ['--title', '--'], ['--impacted'], ['--impacted='], ['--dry-run=false'], ['--dry-run=true'], ['--stdout=false'], ['--json=false']]) {
    const ws = workspace();
    const result = spawnSync(process.execPath, [
      binPath, 'plan-new', '--workspace', ws, '--copilot-home', copilotHome(ws),
      '--slug', 'invalid-input', '--intent', 'Keep every input', '--json', ...suffix,
    ], { cwd: ws, encoding: 'utf8', env: runtimeEnv(ws) });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, 'E_USAGE');
    assert.equal(fs.existsSync(aeHome(ws)) && fs.readdirSync(aeHome(ws), { recursive: true }).some(name => String(name).includes('invalid-input-plan')), false);
  }
  const ws = workspace();
  const unread = harness(ws, ['plan-new', '--file', 'missing.json', '--dry-run=true', '--json']);
  assert.equal(unread.status, 2, unread.stdout + unread.stderr);
  assert.match(unread.stderr, /--dry-run does not accept a value/);
});

test('CLI: plan-new bare dry-run accepts inline authoring and does not create a plan', () => {
  const ws = workspace();
  const result = harness(ws, [
    'plan-new', '--slug=preview-input', '--intent=Preview every input', '--title=Review this title', '--dry-run', '--json',
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.created, false);
  assert.equal(fs.existsSync(preview.path), false);
});

test('CLI: plan-new refuses repeated or bare file inputs without creating a plan', () => {
  const ws = workspace();
  fs.writeFileSync(path.join(ws, 'decision.json'), JSON.stringify({ version: 1, format: 'full', slug: 'no-lost-input', goal: 'Keep every input', acceptance: ['No inputs are lost'], check: 'unit-tests' }));
  for (const args of [
    ['--file', 'missing.json', '--file', 'decision.json'],
    ['--file=missing.json', '--file=decision.json'],
    ['--file', 'decision.json', '--file=decision.json'],
    ['--file', '-', '--file', 'decision.json'],
    ['--file', 'decision.json', 'extra.json'],
  ]) {
    const result = harness(ws, ['plan-new', ...args, '--json']);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, 'E_USAGE');
    assert.match(result.stderr, /one JSON document|unexpected argument extra.json/);
  }
  assert.equal(fs.existsSync(aeHome(ws)) && fs.readdirSync(aeHome(ws), { recursive: true }).some(name => String(name).endsWith('no-lost-input-plan.md')), false);
});

test('CLI: plan-new --status is declared and writes the requested status frontmatter', () => {
  const ws = workspace();
  const explicit = harness(ws, [
    'plan-new', '--type', 'feat', '--slug', 'status-demo', '--intent', 'Do the demo',
    '--date', '2026-07-21', '--status', 'planned', '--json',
  ]);
  assert.equal(explicit.status, 0, `${explicit.stdout}${explicit.stderr}`);
  assert.match(fs.readFileSync(JSON.parse(explicit.stdout).path, 'utf8'), /^status: planned$/m);

  // The documented default is untouched by declaring the override.
  const implicit = harness(ws, [
    'plan-new', '--type', 'feat', '--slug', 'status-default', '--intent', 'Do the demo',
    '--date', '2026-07-21', '--json',
  ]);
  assert.equal(implicit.status, 0, `${implicit.stdout}${implicit.stderr}`);
  assert.match(fs.readFileSync(JSON.parse(implicit.stdout).path, 'utf8'), /^status: in-progress$/m);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('cmdPlanNew CLI writes the dated plan file', () => {
  const ws = workspace();
  const r = harness(ws, ['plan-new', '--type', 'feat', '--slug', 'demo-thing', '--intent', 'Do the demo', '--date', '2026-07-21', '--impacted', 'src/A.java,src/B.java', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(path.isAbsolute(out.path), true);
  assert.ok(out.path.endsWith('2026-07-21-feat-demo-thing-plan.md'));
  assert.ok(out.path.includes(`${path.sep}harness-home${path.sep}`));
  assert.equal(out.path.includes(`${path.sep}docs${path.sep}plans${path.sep}`), false);
  assert.ok(fs.existsSync(out.path));
  const content = fs.readFileSync(out.path, 'utf8');
  assert.deepEqual(YAML.parse(content.match(/^---\n([\s\S]*?)\n---/)[1]).verification.required, ['unit-tests']);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('cmdPlanNew requires a configured check and an explicit choice when several exist', () => {
  const ws = workspace();
  const checksPath = path.join(ws, '.github', 'harness', 'checks.yaml');
  fs.writeFileSync(checksPath, 'version: 1\nchecks: {}\n');
  const none = harness(ws, ['plan-new', '--type', 'feat', '--slug', 'no-check', '--intent', 'Do work', '--date', '2026-07-21']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /configure at least one named check/i);

  fs.writeFileSync(checksPath, 'version: 1\nchecks:\n  unit-tests:\n    command: [npm, test]\n  lint:\n    command: [npm, run, lint]\n');
  const ambiguous = harness(ws, ['plan-new', '--type', 'feat', '--slug', 'many-checks', '--intent', 'Do work', '--date', '2026-07-21']);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /--verification-check.*unit-tests.*lint/i);
  const selected = harness(ws, ['plan-new', '--type', 'feat', '--slug', 'selected-check', '--intent', 'Do work', '--date', '2026-07-21', '--verification-check', 'lint']);
  assert.equal(selected.status, 0, selected.stderr);

  fs.writeFileSync(checksPath, 'version: 1\nchecks:\n  docs-only:\n    timeout_seconds: 10\n  unit-tests:\n    command: [npm, test]\n');
  const docsOnly = harness(ws, ['plan-new', '--type', 'feat', '--slug', 'docs-only-check', '--intent', 'Do work', '--date', '2026-07-21', '--verification-check', 'docs-only']);
  assert.equal(docsOnly.status, 1);
  assert.match(docsOnly.stderr, /not configured|executable/i);
  const autoExec = harness(ws, ['plan-new', '--type', 'feat', '--slug', 'auto-exec', '--intent', 'Do work', '--date', '2026-07-21', '--json']);
  assert.equal(autoExec.status, 0, autoExec.stderr);
  assert.deepEqual(
    YAML.parse(fs.readFileSync(JSON.parse(autoExec.stdout).path, 'utf8').match(/^---\n([\s\S]*?)\n---/)[1]).verification.required,
    ['unit-tests'],
  );
  fs.rmSync(ws, { recursive: true, force: true });
});

test('plan YAML safely serializes quotes, multiline intents, and Windows paths', () => {
  const intent = 'Handle "quoted" input\nwithout decoding C:\\temp';
  const { content } = buildPlanSkeleton({
    type: 'fix',
    slug: 'quoted-input',
    title: 'Fix "quoted" input',
    intent,
    date: '2026-07-21',
    impacted: ['src/parser.js'],
    check: 'unit-tests',
  });
  const frontmatter = YAML.parse(content.match(/^---\n([\s\S]*?)\n---/)[1]);
  assert.equal(frontmatter.title, 'Fix "quoted" input');
  assert.equal(frontmatter.intent, intent);
  assert.deepEqual(frontmatter.success_criteria, [intent]);
});

test('product plans require code-review and docs plans do not', () => {
  for (const type of ['feat', 'fix', 'refactor', 'chore']) {
    const { content } = buildPlanSkeleton({
      type,
      slug: `${type}-shape`,
      intent: 'Do the work',
      date: '2026-07-21',
      check: 'unit-tests',
    });
    const frontmatter = YAML.parse(content.match(/^---\n([\s\S]*?)\n---/)[1]);
    assert.deepEqual(frontmatter.reviews, { required: ['code-review'], completed: [], critical_open: [] }, type);
  }
  const { content } = buildPlanSkeleton({
    type: 'docs',
    slug: 'docs-note',
    intent: 'Write the note',
    date: '2026-07-21',
    check: 'unit-tests',
  });
  const frontmatter = YAML.parse(content.match(/^---\n([\s\S]*?)\n---/)[1]);
  assert.deepEqual(frontmatter.reviews.required, []);
});

test('plan-new reuses the canonical primitive path classifier', () => {
  for (const impacted of ['packages/ae/corpus/enterprise/skills/payment/SKILL.md', 'packages/ae/corpus/knowledge/capability-registry.yaml']) {
    const { content } = buildPlanSkeleton({
      slug: impacted.includes('/enterprise/') ? 'enterprise-skill' : 'capability-registry',
      intent: 'Update the governed primitive',
      date: '2026-07-21',
      impacted: [impacted],
      check: 'unit-tests',
    });
    const frontmatter = YAML.parse(content.match(/^---\n([\s\S]*?)\n---/)[1]);
    assert.deepEqual(frontmatter.skills_used, ['engineer'], impacted);
    assert.match(content, /## Primitive Governance/, impacted);
  }
});
