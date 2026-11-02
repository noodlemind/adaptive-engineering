import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';
import { estimateTokens } from '../lib/token-meter.mjs';
import { CONTEXT_PACK_MAX_BYTES } from '../lib/context-pack.mjs';
import { hasCommand, describeCommand } from '../lib/registry.mjs';
import { harnessControlCommand } from '../corpus/hooks/lib/tool-payload.mjs';
// Keep projection behavior and standalone/drift controls in the named prompt-contracts check.
import './engineer-exports.test.mjs';
import './host-projection.test.mjs';
import './host-setup.test.mjs';
import './host-cli.test.mjs';
import './host-native-hooks.test.mjs';
import './host-personal-admission.test.mjs';
import './git-executable.test.mjs';
import './mcp-server.test.mjs';
import './plugin-package.test.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const ENGINEER_AGENT_MAX_TOKENS = 900;
const SKILL_BODY_MAX_LINES = 300;
const AGENT_BODY_MAX_LINES = 20;
const SPECIALIST_AGENT_MAX_TOKENS = 600;
const architecturePath = 'docs/adaptive-engineering.md';
const supersededArchitectureDocs = [
  'architecture/engineer-harness.md',
  'architecture/skill-driven-prompt-library.md',
  'architecture/harness-cli-workbench.md',
  'MEMORY-MODEL.md',
  'install.md',
  'onboarding/harness-quickstart.md',
];

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
}

function exists(rel) {
  return fs.existsSync(path.join(repoRoot, rel));
}

function isTracked(rel) {
  const out = execFileSync('git', ['-C', repoRoot, 'ls-files', '--', rel], { encoding: 'utf8' }).trim();
  return out.length > 0;
}

test('doctor procedure preserves the selected target and distinguishes unselected native support', () => {
  const skill = read('packages/ae/corpus/skills/harness-doctor/SKILL.md');
  assert.match(skill, /--target <selected-target>/);
  assert.match(skill, /vscode.*cli.*intellij/);
  assert.match(skill, /selected.*homes/i);
  assert.match(skill, /target is unknown[\s\S]*without `--target`/i);
  assert.doesNotMatch(skill, /`ae doctor[^`]*--host vscode[^`]*`/);
  assert.match(skill, /IntelliJ[\s\S]*native lifecycle hooks.*unavailable/i);
});

test('agent exit guidance preserves actual usage refusals and command-specific advisories', () => {
  const contract = read('packages/ae/corpus/skills/references/harness-tool-contract.md');
  assert.doesNotMatch(contract, /\| `2` \| Warn.*may proceed/i);
  assert.match(contract, /`2`[^\n]*[Uu]sage.*E_USAGE/);
  assert.match(contract, /nonzero[^.]*never[^.]*authority/i);
  assert.match(contract, /command-specific[^.]*advisory/i);
  assert.match(contract, /stderr/);
  for (const args of [['status', '--bogus'], ['install', '--target', 'codex']]) {
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'packages/ae/bin/ae.mjs'), ...args, '--json', '--no-events'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    const error = JSON.parse(result.stderr);
    assert.equal(error.ok, false);
    assert.equal(error.error.code, 'E_USAGE');
    assert.equal(result.stdout, '', 'refused commands do not emit successful output');
  }
});

test('canonical concept doc defines task modes, ownership, gap handling, and runtime modes', () => {
  const model = read(architecturePath);

  for (const phrase of [
    'Task modes',
    'Answer',
    'Investigate',
    'Deliver',
    'Review',
    'Engineer',
    'Skill-first',
    'Standalone',
    'Degraded',
    'Governed',
    'Bounded delegation',
  ]) {
    assert.match(model, new RegExp(phrase, 'i'), `missing ${phrase}`);
  }
});

test('Engineer review handoff reaches the role that can prepare the packet', () => {
  const engineer = read('packages/ae/corpus/agents/engineer.agent.md');
  const fm = YAML.parse(engineer.match(/^---\n([\s\S]*?)\n---/)[1]);
  const review = fm.handoffs.find(handoff => handoff.label === 'Code Review');
  assert.equal(review.agent, 'engineer');
  assert.match(review.prompt, /code-review.*prepare.*packet/i);
});

test('docs surface is the adaptive engineering explanation', () => {
  const docsRoot = path.join(repoRoot, 'docs');
  const generatedTopLevel = ['codebase-map.md', 'codebase-snapshot.md'];
  for (const name of generatedTopLevel) {
    assert.equal(
      isTracked(`docs/${name}`),
      false,
      `docs/${name} is generated and must remain untracked`,
    );
  }
  const generated = new Set(generatedTopLevel);
  const topLevel = fs
    .readdirSync(docsRoot)
    .filter((name) => !name.startsWith('.') && !generated.has(name))
    .sort();
  assert.deepEqual(topLevel, ['adaptive-engineering.md', 'diagrams', 'migration', 'model-preferences.md', 'site', 'structural-knowledge.md', 'workspace-layout-detection.md']);
  assert.equal(exists('docs/architecture'), false, 'docs/architecture should be removed');
  for (const name of supersededArchitectureDocs) {
    assert.equal(exists(`docs/${name}`), false, `docs/${name} should be removed`);
  }
  const concept = read('docs/adaptive-engineering.md');
  for (const phrase of ['Host-first', 'Kernel-always', 'Agent-optional', 'Benchmark-test-only']) {
    assert.match(concept, new RegExp(phrase, 'i'), `product model missing ${phrase}`);
  }
  assert.match(concept, /Benchmark-test-only/);
  assert.match(concept, /@engineer/);
  assert.doesNotMatch(read('packages/ae/README.md'), /ae agent[\s\S]{0,80}Adaptive Engineer runtime/i);
  assert.match(read('packages/ae/README.md'), /opt-in add-on/i);
});

test('adaptive engineering doc states the start and the growth path', () => {
  const doc = read('docs/adaptive-engineering.md');
  for (const phrase of ['Engineer', 'Harness', 'acquired', 'compound', 'argv arrays', 'without a shell']) {
    assert.match(doc, new RegExp(phrase, 'i'), `doc missing ${phrase}`);
  }
  assert.doesNotMatch(doc, /next big thing/i);
});

test('named checks execute argv from checks.yaml, not plan text', () => {
  const verify = read('packages/ae/lib/verify.mjs');
  assert.match(verify, /loadNamedChecks/, 'verify loads repository-owned named checks');
  assert.match(verify, /runNamedCheck/, 'verify runs named checks, not plan command strings');
  assert.doesNotMatch(verify, /verification_commands/, 'verify must not read plan command strings');
  const checks = read('packages/ae/lib/checks.mjs');
  assert.match(checks, /CHECKS_REL = '\.github\/harness\/checks\.yaml'/, 'named checks live in checks.yaml');
  const runner = read('packages/ae/lib/runner.mjs');
  assert.match(runner, /shell:\s*false/, 'named checks must not run through a shell');
});

test('engineer agent is frozen, thin, and leaves the delivery checklist to the harness', () => {
  const engineer = read('packages/ae/corpus/agents/engineer.agent.md');
  const estimatedTokens = Math.ceil(Buffer.byteLength(engineer, 'utf8') / 4);

  assert.ok(estimatedTokens >= 600, `Engineer context is too small (${estimatedTokens} estimated tokens)`);
  assert.ok(estimatedTokens <= 900, `Engineer context is too large (${estimatedTokens} estimated tokens)`);
  assert.doesNotMatch(engineer, /^[0-9]+\. /m);
  for (const mode of ['Answer', 'Investigate', 'Deliver', 'Review']) {
    assert.match(engineer, new RegExp(`\\*\\*${mode}\\*\\*`), `missing ${mode} mode`);
  }
  assert.match(engineer, /Switch .* to Deliver before editing/i);
  assert.match(engineer, /For changed work/i);
  assert.match(engineer, /code-review[\s\S]{0,80}require passed `ae verify`/);
  assert.match(engineer, /ae plan-update/);
  assert.match(engineer, /architect\/SKILL\.md/);
  assert.match(engineer, /do not edit the CLI's state store in the editor/i);

  assert.equal(exists('packages/ae/corpus/skills/engineer-autopilot/SKILL.md'), false);
  assert.equal(exists('packages/ae/corpus/skills/references/engineer-runtime.md'), false);
  assert.doesNotMatch(read('packages/ae/corpus/skills/references/tool-native-loop.md'), /1\. Orient[\s\S]*9\. Report/i);
});

test('engineer recovers blocked mutations, routes primitives, and exposes finding disposition', () => {
  const engineer = read('packages/ae/corpus/agents/engineer.agent.md');
  const globalWorkflow = read('packages/ae/corpus/instructions/harness-global.instructions.md');
  const frontmatter = YAML.parse(engineer.match(/^---\n([\s\S]*?)\n---/)?.[1] || '');
  const handoffs = new Map((frontmatter.handoffs || []).map((handoff) => [handoff.label, handoff]));

  assert.match(engineer, /requested file mutation enters Deliver before the first edit/i);
  assert.match(engineer, /blocked[\s\S]*ensure-plan[\s\S]*start decision[\s\S]*implement gate before editing/i);
  assert.match(engineer, /skill, agent, instruction, prompt, check, reference, or solution[\s\S]{0,100}create-primitive/i);
  assert.match(engineer, /skills\/create-primitive\/SKILL\.md[\s\S]{0,180}not activation/i);
  assert.match(engineer, /host read tool[\s\S]{0,220}not activation/i);
  assert.doesNotMatch(engineer, /ae get --reference skills\/create-primitive\/SKILL\.md/);
  assert.match(engineer, /Capture for Later[\s\S]{0,120}Plan and Fix[\s\S]{0,120}Leave in Chat/i);
  assert.match(engineer, /Name the mode first/i);
  assert.match(engineer, /shared state and interleavings[\s\S]{0,100}confirmed only when evidence demonstrates/i);
  assert.doesNotMatch(engineer, /MUST call.*confirmed race/i);
  assert.match(engineer, /evidence, impact, confidence, and recommendation/i);
  assert.equal(handoffs.get('Capture for Later')?.send, false);
  assert.match(handoffs.get('Capture for Later')?.prompt || '', /open, unlocked issue/i);
  assert.equal(handoffs.get('Plan and Fix')?.send, false);
  assert.match(handoffs.get('Plan and Fix')?.prompt || '', /proportional plan/i);
  assert.match(globalWorkflow, /@engineer[\s\S]{0,160}name the mode first/i);
  assert.doesNotMatch(globalWorkflow, /confirmed only when evidence demonstrates/i);
  assert.doesNotMatch(globalWorkflow, /confirmed race/i);
});

test('gated reads name a host file read the hook already records', () => {
  const engineer = read('packages/ae/corpus/agents/engineer.agent.md');
  const gate = read('packages/ae/corpus/hooks/require-plan-gate.mjs');
  const context = read('packages/ae/corpus/hooks/load-context.mjs');
  const review = read('packages/ae/corpus/skills/code-review/SKILL.md');
  const personas = read('packages/ae/corpus/skills/code-review/references/review-personas.md');
  const loop = read('packages/ae/corpus/skills/references/tool-native-loop.md');
  const spec = read('packages/ae/corpus/agents/spec-flow-analyzer.agent.md');
  for (const source of [engineer, gate, context]) {
    assert.match(source, /host read tool/);
    assert.match(source, /not-truncated/);
    assert.match(source, /<copilot-home>\/skills\/create-primitive\/SKILL\.md/);
  }
  assert.match(gate, /skills\/create-primitive\/SKILL\.md[\s\S]{0,240}not activation/);
  assert.doesNotMatch(gate, /ae get --reference skills\/create-primitive\/SKILL\.md/);
  assert.doesNotMatch(context, /ae get --reference skills\/ensure-plan\/SKILL\.md/);
  for (const source of [review, personas, loop, spec]) {
    assert.match(source, /host search/);
    assert.match(source, /outside the enforce hook/i);
    assert.match(source, /ae tree workspace --files --json/);
  }
  for (const args of [
    ['ae', 'get', '--reference', 'skills/create-primitive/SKILL.md', '--json'],
    ['ae', 'tree', 'workspace', '--files', '--json'],
    ['ae', 'search', 'plan', '--match', 'literal', '--source', 'code', '--json'],
  ]) {
    assert.equal(harnessControlCommand(args, process.cwd()), null, args.join(' '));
  }
});

test('corpus ae reads lead with the host tool and stay optional outside enforce', () => {
  const problems = [];
  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.name.endsWith('.md')) out.push(full);
    }
    return out;
  };
  const corpus = path.join(repoRoot, 'packages/ae/corpus');
  const command = /`ae (?:get|tree|search)\b|(?<!`)ae (?:get|tree|search)\b/g;
  for (const full of walk(corpus)) {
    const rel = path.relative(repoRoot, full);
    read(rel).split('\n').forEach((line, index) => {
      command.lastIndex = 0;
      let match;
      while ((match = command.exec(line))) {
        const before = line.slice(0, match.index);
        const host = /host (?:read|search|list)/i.test(before);
        const outside = /outside the enforce hook/i.test(line);
        if (!host || !outside) {
          problems.push(`${rel}:${index + 1} ${host ? 'missing outside enforce' : 'missing host tool'}: ${line.trim().slice(0, 160)}`);
        }
      }
    });
  }
  assert.deepEqual(problems, []);
});

test('every agent handoff declares a target agent that exists', () => {
  const agentsDir = path.join(repoRoot, 'packages/ae/corpus/agents');
  const agentFiles = fs.readdirSync(agentsDir).filter((file) => file.endsWith('.agent.md'));
  const agentNames = new Set(agentFiles.map((file) => file.replace(/\.agent\.md$/, '')));

  for (const file of agentFiles) {
    const source = read(path.join('packages/ae/corpus/agents', file));
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    assert.ok(match, `${file}: invalid or missing YAML frontmatter`);
    const frontmatter = YAML.parse(match[1]);
    for (const handoff of frontmatter?.handoffs || []) {
      assert.ok(
        typeof handoff.agent === 'string' && handoff.agent.length > 0,
        `${file}: handoff "${handoff.label}" is missing the required agent property`,
      );
      assert.ok(
        agentNames.has(handoff.agent),
        `${file}: handoff "${handoff.label}" targets unknown agent "${handoff.agent}"`,
      );
    }
  }
});

test('existing skills own structured findings, proportional plans, and primitive governance', () => {
  const capture = read('packages/ae/corpus/skills/capture-issue/SKILL.md');
  for (const field of [
    'Title',
    'Observed behavior',
    'Expected invariant',
    'Evidence paths',
    'Impact',
    'Confidence',
    'Recommended direction',
  ]) assert.match(capture, new RegExp(field, 'i'), `capture packet missing ${field}`);
  assert.match(capture, /packet is sufficient[\s\S]{0,220}do not ask/i);

  const ensure = read('packages/ae/corpus/skills/ensure-plan/SKILL.md');
  for (const phrase of [
    'one or two intended product files',
    'one session',
    'no architectural choice',
    'focused trusted verification',
    'one phase',
    'no broad repository scan',
    'data migration',
    'security or concurrency',
    'unclear verification',
  ]) assert.match(ensure, new RegExp(phrase, 'i'), `fast plan missing ${phrase}`);
  assert.match(ensure, /read the selected check source[\s\S]{0,180}ae checks list --json[\s\S]{0,180}never invent/i);
  assert.match(ensure, /schema-validation[\s\S]{0,100}no schema output/i);
  assert.match(ensure, /ae plan-update/);

  const primitive = read('packages/ae/corpus/skills/create-primitive/SKILL.md');
  assert.match(primitive, /ae resources create/);
  for (const governed of ['packages/ae/corpus/skills/', 'packages/ae/corpus/agents/', 'packages/ae/corpus/instructions/', 'packages/ae/corpus/enterprise/', '.github/checks/']) {
    assert.ok(primitive.includes(governed), `primitive path missing ${governed}`);
  }
  assert.match(primitive, /\.github\/checks\//);
  for (const option of ['Existing /java skill', 'Existing /aws skill', 'Reference under /java', 'Reference under /aws', 'New cross-domain migration skill']) {
    assert.match(primitive, new RegExp(option.replaceAll('/', '\\/'), 'i'), `migration decision missing ${option}`);
  }
  assert.match(primitive, /actually loaded in the current chat session[\s\S]{0,180}not claim activation/i);
  assert.match(primitive, /ae get --reference skills\/java\/SKILL\.md[\s\S]{0,160}ae get --reference skills\/aws\/SKILL\.md/i);
  assert.match(primitive, /map every acceptance criterion/i);
  assert.match(primitive, /do not invent check names/i);
});

test('engineer loads capabilities on demand and owns bounded consultations', () => {
  const surfaces = [
    read('packages/ae/corpus/agents/engineer.agent.md'),
    read('packages/ae/corpus/instructions/harness-global.instructions.md'),
  ].join('\n');

  assert.doesNotMatch(surfaces, /mandatory before any work.*read/i);
  assert.doesNotMatch(surfaces, /read these SKILL\.md files before acting/i);
  assert.match(surfaces, /on[- ]demand/i);

  const engineer = read('packages/ae/corpus/agents/engineer.agent.md');
  for (const field of ['question', 'acceptance criterion', 'evidence', 'constraints', 'expected response']) {
    assert.match(engineer, new RegExp(field, 'i'), `consultation packet missing ${field}`);
  }
  assert.match(engineer, /own(?:s| the) final/i);
});

test('README maintenance enters proportional docs delivery before mutation', () => {
  const skill = read('packages/ae/corpus/skills/project-readme/SKILL.md');
  assert.match(skill, /Deliver before the first edit/i);
  assert.match(skill, /type: docs/);
  assert.match(skill, /one phase/i);
  assert.match(skill, /start decision[\s\S]{0,160}implement gate/i);
  assert.match(skill, /ae verify/);
  assert.match(skill, /no-learning/);
  assert.match(skill, /complete decision/);
  assert.doesNotMatch(skill, /Do not create a plan file/i);
});

test('review delegation keeps CLI authority with the Engineer and returns packet-bound raw results', () => {
  const coordinator = read('packages/ae/corpus/agents/code-review-coordinator.agent.md');
  const fm = YAML.parse(coordinator.match(/^---\n([\s\S]*?)\n---/)[1]);
  assert.ok(!fm.tools.some(tool => tool === 'execute' || tool.startsWith('execute/')));
  assert.match(coordinator, /Engineer[\s\S]{0,160}ae review prepare/);
  assert.match(coordinator, /Engineer[\s\S]{0,160}ae review assemble/);
  assert.match(coordinator, /packet\.required/);
  assert.match(coordinator, /"packet":/);
  assert.match(coordinator, /"results":/);
  assert.match(coordinator, /timed-out/);
  assert.doesNotMatch(coordinator, /Ask the user to run|Cap at 8|dedupe same-location|Code Review Summary/i);
  const skill = read('packages/ae/corpus/skills/code-review/SKILL.md');
  assert.match(skill, /Engineer owns[\s\S]{0,180}prepare[\s\S]{0,180}assemble/i);
  assert.match(skill, /coordinator[\s\S]{0,140}raw results/i);
});

test('review runs once on the finished diff and stops after two rounds', () => {
  const principles = read('packages/ae/corpus/skills/references/delivery-principles.md');
  const budget = principles.split('## review-budget')[1].split('\n## ')[0];
  assert.match(budget, /once before `ae verify`/i);
  assert.match(budget, /not after each task/i);
  assert.match(budget, /cap the default at three/i);
  assert.match(budget, /files the fix touched/i);
  assert.match(budget, /two rounds/i);
  assert.match(budget, /defect in the spec/i);
  const surfaces = [
    'packages/ae/corpus/agents/engineer.agent.md',
    'packages/ae/corpus/instructions/harness-global.instructions.md',
    'packages/ae/corpus/skills/code-review/SKILL.md',
    'packages/ae/corpus/skills/code-review/references/review-personas.md',
    'packages/ae/corpus/skills/references/playbooks/feature.md',
    'packages/ae/corpus/skills/references/playbooks/refactor.md',
    'packages/ae/corpus/skills/java/SKILL.md',
    'packages/ae/corpus/skills/aws/SKILL.md',
    'packages/ae/corpus/skills/document-review/SKILL.md',
  ].map(read).join('\n');
  assert.match(read('packages/ae/corpus/agents/engineer.agent.md'), /code-review` once/);
  assert.doesNotMatch(surfaces, /five mandatory|engaged on every review|prepare and collect a new review|Review the diff with `\/code-review`/i);
  assert.doesNotMatch(surfaces, /until (?:there are )?zero findings|until no findings|review after each task/i);
  assert.match(read('packages/ae/corpus/skills/code-review/SKILL.md'), /packet's required reviewers/i);
});

test('delivery keeps the smallest change and review flags extra code', () => {
  const smallest = read('packages/ae/corpus/skills/references/delivery-principles.md')
    .split('## smallest-change')[1]
    .split('\n## ')[0];
  assert.match(smallest, /smallest change that meets the spec/i);
  assert.match(smallest, /helper, option, dependency, abstraction, or comment/i);
  assert.match(smallest, /real boundary/i);
  assert.match(smallest, /untrusted input, auth, persistence, or a process edge/i);
  assert.match(read('packages/ae/corpus/skills/references/delivery-principles.md'), /same edit has already been repeated/);

  const review = read('packages/ae/corpus/skills/code-review/SKILL.md');
  assert.match(review, /Extra code is the defect/);
  assert.match(review, /Before finishing, the diff is the smallest change that meets the spec/);

  const personas = read('packages/ae/corpus/skills/code-review/references/review-personas.md');
  assert.match(personas, /Flag extra code/);
  assert.doesNotMatch(personas, /defense-in-depth improvements/);
  assert.doesNotMatch(personas, /duplicated logic that should be extracted/);
  assert.doesNotMatch(personas, /unhandled edge cases in specs/);

  const schema = read('packages/ae/corpus/skills/code-review/references/findings-schema.md');
  assert.match(schema, /Extra code is the defect/);
  assert.doesNotMatch(schema, /Missing validation on public API/);

  const engineer = read('packages/ae/corpus/agents/engineer.agent.md');
  assert.match(engineer, /smallest change that meets the spec/);
  assert.match(engineer, /Investigate\*\* names evidence and never calls `plan-new` or `ensure-plan`/);
  assert.doesNotMatch(engineer, /fix the findings/);

  const globalWorkflow = read('packages/ae/corpus/instructions/harness-global.instructions.md');
  assert.match(globalWorkflow, /smallest change that meets the spec/);
  assert.doesNotMatch(globalWorkflow, /fixes the findings/);

  assert.match(
    read('packages/ae/corpus/agents/code-implementer.agent.md'),
    /helper, option, dependency, or comment the task did not name/,
  );
  assert.match(read('packages/ae/corpus/skills/references/playbooks/feature.md'), /smallest change that meets those criteria/);
  assert.match(read('packages/ae/corpus/skills/references/playbooks/bug-fix.md'), /smallest fix that meets the spec/);
  assert.doesNotMatch(read('packages/ae/corpus/agents/spec-flow-analyzer.agent.md'), /Unicode, timezone/);
  assert.match(
    read('packages/ae/corpus/agents/pattern-recognition-specialist.agent.md'),
    /three similar lines until a fourth copy/,
  );
  assert.doesNotMatch(read('packages/ae/corpus/agents/security-sentinel.agent.md'), /defense gaps/);
  const perspectives = read('packages/ae/corpus/skills/code-review/references/review-perspectives.md');
  assert.doesNotMatch(perspectives, /Input validation at all entry points/);
  assert.doesNotMatch(perspectives, /Duplication that should be extracted/);
  const criteria = read('packages/ae/corpus/skills/document-review/references/review-criteria.md');
  assert.match(criteria, /Flag extra scope/);
  assert.doesNotMatch(criteria, /Additional scenario suggestions/);
  assert.doesNotMatch(criteria, /Suggestions for more robust approaches/);
  const java = read('packages/ae/corpus/instructions/java.instructions.md');
  assert.doesNotMatch(java, /defensive null checks/);
  assert.match(java, /untrusted input/);
});

test('document review preserves one packet and routes managed-plan fixes through decisions', () => {
  const skill = read('packages/ae/corpus/skills/document-review/SKILL.md');
  assert.equal((skill.match(/ae review prepare --domain document/g) || []).length, 1);
  assert.match(skill, /same packet/i);
  assert.match(skill, /ae plan-update/);
  assert.match(skill, /Deliver[\s\S]{0,120}gate/i);
  const schema = read('packages/ae/corpus/skills/code-review/references/findings-schema.md');
  assert.match(schema, /exact[\s\S]{0,80}packet[\s\S]{0,80}path/i);
});

test('focused implementation checks precede review and authoritative verification', () => {
  const principles = read('packages/ae/corpus/skills/references/delivery-principles.md');
  const section = principles.split('## verify-between-units')[1].split('\n## ')[0];
  assert.match(section, /focused[\s\S]{0,100}TDD/i);
  assert.match(section, /required review[\s\S]{0,140}ae verify/i);
  assert.doesNotMatch(section, /require outcome `passed` before the next unit/i);
  const gate = read('packages/ae/corpus/skills/references/capture-gate.md');
  assert.match(gate, /content-v1[\s\S]{0,180}changed[\s\S]{0,160}amend/i);
  assert.match(gate, /legacy[\s\S]{0,100}paths-only/i);
  assert.doesNotMatch(gate, /sha256.*is not compared|User waived capture/i);
});

test('active entry points use the accountable Engineer vocabulary', () => {
  const activeEntryPoints = [
    'README.md',
    'packages/ae/corpus/agents/engineer.agent.md',
    'docs/adaptive-engineering.md',
  ];
  for (const rel of activeEntryPoints) {
    const contract = read(rel);
    assert.doesNotMatch(contract, /autopilot/i, `${rel} still advertises the retired autopilot model`);
    assert.doesNotMatch(contract, /engineer-runtime\.md/i, `${rel} references a retired runtime`);
  }
});

test('execution, gap resolution, and compounding skills have distinct boundaries', () => {
  // Phase execution is owned by the Engineer's Deliver lifecycle (work-on-task retired).
  const engineerContract = read('packages/ae/corpus/agents/engineer.agent.md');
  assert.match(engineerContract, /Deliver\*{0,2} owns mutation lifecycle/i);
  assert.match(engineerContract, /successful implement gate before editing/);
  assert.match(engineerContract, /require passed `ae verify`/i);

  const gaps = read('packages/ae/corpus/skills/ensure-capability/SKILL.md');
  assert.match(gaps, /on-demand/i);
  assert.match(gaps, /when encountered/i);
  assert.doesNotMatch(gaps, /runs at ingest/i);
  assert.doesNotMatch(gaps, /mandatory preflight/i);

  const compound = read('packages/ae/corpus/skills/auto-compound/SKILL.md');
  for (const field of [
    'destination',
    'recurrence',
    'candidate_primitive',
    'candidate_name',
    'evidence',
    'recommendation',
  ]) {
    assert.match(compound, new RegExp(field), `compound classification missing ${field}`);
  }
  assert.match(compound, /ae status --validate-evidence --plan/i);

  const primitive = read('packages/ae/corpus/skills/create-primitive/SKILL.md');
  assert.match(primitive, /promotion evidence/i);
  assert.match(primitive, /trigger eval/i);
  assert.match(primitive, /outcome eval/i);
});

test('corpus hooks are the only hook tree and their cwd token is hooks', () => {
  const files = [
    'block-destructive-commands.mjs',
    'require-plan-gate.mjs',
    'lib/tool-payload.mjs',
  ];
  for (const rel of files) {
    const source = read(`packages/ae/corpus/hooks/${rel}`);
    assert.match(source, /unwrapShellSegments/, `${rel} must contain the shared unwrap helper`);
  }
  assert.equal(exists('packages/ae/assets'), false);
  assert.equal(exists('scripts/build-harness-assets.mjs'), false);
  const hooks = JSON.parse(read('packages/ae/corpus/hooks/hooks.json'));
  const cwds = [];
  for (const entries of Object.values(hooks.hooks || {})) {
    for (const entry of entries) {
      for (const command of entry.hooks || []) cwds.push(command.cwd);
    }
  }
  assert.deepEqual(cwds, ['hooks', 'hooks', 'hooks', 'hooks', 'hooks', 'hooks', 'hooks']);
});

test('prompt-library retains at most one non-terminal PR plan and documents cleanup', () => {
  const plansDir = path.join(repoRoot, 'docs', 'plans');
  if (!fs.existsSync(plansDir)) return;
  const datedPlans = fs
    .readdirSync(plansDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(name));
  const live = [];
  for (const name of datedPlans) {
    const frontmatter = read(`docs/plans/${name}`).match(/^---\n([\s\S]*?)\n---/)?.[1];
    const plan = YAML.parse(frontmatter || '');
    assert.ok(plan?.plan_schema, `${name} must use the current plan schema`);
    // Only in-progress execution plans count as "live". planned/deferred/done may coexist.
    if (plan.status !== 'in-progress') continue;
    live.push(name);
  }
  assert.ok(live.length <= 1, `expected at most one in-progress PR plan, found ${live.length}: ${live.join(', ')}`);
  const policy = read('docs/plans/README.md');
  assert.match(policy, /transient/i);
  assert.match(policy, /after[^\n]*merge[^\n]*(?:remove|delete)/i);
  assert.match(policy, /status.*plan_lock.*phase/i);
});

test('hooks and CI enforce explicit plans and passed verification evidence', () => {
  const hooks = JSON.parse(read('packages/ae/corpus/hooks/hooks.json'));
  const preEditCommands = hooks.hooks.PreToolUse.flatMap((entry) => entry.hooks.map((hook) => hook.command));
  assert.ok(preEditCommands.includes('node require-plan-gate.mjs'));
  // Every tool call funnels through one wildcard PreToolUse chain so
  // unrecognized or future host tool names cannot bypass the guards.
  assert.equal(hooks.hooks.PreToolUse.length, 1, 'PreToolUse must be a single wildcard chain');
  const preEntry = hooks.hooks.PreToolUse[0];
  assert.equal(preEntry.matcher, '*', 'PreToolUse must match every tool');
  const preHooks = preEntry.hooks;
  const criticalIndex = preHooks.findIndex((hook) => hook.command === 'node guard-critical-files.mjs');
  const destructiveIndex = preHooks.findIndex((hook) => hook.command === 'node block-destructive-commands.mjs');
  const gateIndex = preHooks.findIndex((hook) => hook.command === 'node require-plan-gate.mjs');
  assert.notEqual(criticalIndex, -1, 'mutations require the critical-file guard');
  assert.notEqual(destructiveIndex, -1, 'terminal commands require the destructive-command blocker');
  assert.notEqual(gateIndex, -1, 'mutations require the plan gate');
  assert.ok(
    criticalIndex < destructiveIndex && destructiveIndex < gateIndex,
    'safety guards must run before the plan gate'
  );
  const postEditCommands = (hooks.hooks.PostToolUse || []).flatMap((entry) => entry.hooks.map((hook) => hook.command));
  assert.ok(postEditCommands.includes('node record-successful-edit.mjs'));
  const stopCommands = (hooks.hooks.Stop || []).flatMap((entry) => entry.hooks.map((hook) => hook.command));
  assert.ok(stopCommands.includes('node require-verification.mjs'));

  const planGate = read('packages/ae/corpus/hooks/require-plan-gate.mjs');
  assert.match(planGate, /gatedPlan/);
  assert.match(planGate, /gatedPlanDigest/);
  assert.match(planGate, /gateStatus/);
  assert.match(planGate, /Impacted Files/);

  const completion = read('packages/ae/corpus/hooks/require-verification.mjs');
  assert.match(completion, /outcome\s*!==\s*['"]passed['"]/);
  assert.match(completion, /if \(!session\.lastEditAt\) allow/);
  assert.match(completion, /lastCompletedEditAt/);
  assert.match(completion, /validateEvidenceBinding/);

  const workflow = read('.github/workflow-templates/harness-plan-verification.yml');
  assert.match(workflow, /validate-plan --plan/);
  assert.doesNotMatch(workflow, /ae (?:gate|verify|trust approve)\b/);
  assert.match(workflow, /upload-artifact@v4/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /plan_path:/);
  assert.match(workflow, /No delivery proof/i);
  assert.match(workflow, /private plans/i);
  assert.match(workflow, /persist-credentials: false/);

  const policy = YAML.parse(read('.github/harness/policy.yaml'));
  assert.equal(policy.version, 1);
  assert.ok(['observe', 'warn', 'enforce'].includes(policy.enforcement));
  assert.ok(Array.isArray(policy.exemptions));
  assert.ok(Array.isArray(policy.waivers));
});

test('single-entry: the engineer is the only user-invocable agent', () => {
  const agentsDir = path.join(repoRoot, 'packages/ae/corpus/agents');
  const invocable = fs
    .readdirSync(agentsDir)
    .filter((name) => name.endsWith('.agent.md'))
    .filter((name) => {
      const fm = read(`packages/ae/corpus/agents/${name}`).match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
      return !/^user-invocable:\s*false\s*$/m.test(fm);
    })
    .map((name) => name.replace(/\.agent\.md$/, ''))
    .sort(); // readdir order is filesystem-defined; sort so this set compare is deterministic
  assert.deepEqual(invocable, ['engineer'], `@ menu must expose only the engineer, found: ${invocable.join(', ')}`);
  // Retired routing surfaces stay gone.
  for (const gone of [
    'packages/ae/corpus/agents/pipeline-navigator.agent.md',
    'packages/ae/corpus/agents/feedback-codifier.agent.md',
    'packages/ae/corpus/agents/pr-comment-resolver.agent.md',
    'packages/ae/corpus/skills/btw',
    'packages/ae/corpus/skills/start',
    'packages/ae/corpus/skills/analyze-and-plan',
    'packages/ae/corpus/skills/tdd-fix',
    'packages/ae/corpus/skills/review-guardrails',
    'packages/ae/corpus/skills/work-on-task',
    '.github/prompts',
  ]) {
    assert.ok(!exists(gone), `${gone} is retired and must not exist`);
  }
});

test('single-entry: the / menu is pinned to the approved skill set', () => {
  const skillsDir = path.join(repoRoot, 'packages/ae/corpus/skills');
  const invocable = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && exists(`packages/ae/corpus/skills/${entry.name}/SKILL.md`))
    .filter((entry) => {
      const fm = read(`packages/ae/corpus/skills/${entry.name}/SKILL.md`).match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
      return !/^user-invocable:\s*false\s*$/m.test(fm);
    })
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(invocable, ['engineer', 'harness-doctor', 'project-readme', 'triage-issues']);
});

test('single-entry: retired primitives carry registry tombstones', () => {
  const registry = YAML.parse(read('packages/ae/corpus/knowledge/capability-registry.yaml'));
  for (const name of ['btw', 'start', 'analyze-and-plan', 'tdd-fix', 'review-guardrails', 'work-on-task', 'pipeline-navigator', 'feedback-codifier', 'pr-comment-resolver']) {
    const entry = registry.capabilities[name];
    assert.ok(entry, `registry missing tombstone for ${name}`);
    assert.equal(entry.status, 'retired', `${name} must be retired`);
    assert.match(entry.replacement || '', /\S/, `${name} tombstone needs a replacement`);
    assert.match(entry.reason || '', /\S/, `${name} tombstone needs a reason`);
  }
});

test('agent tool identifiers are pinned to the current VS Code taxonomy', () => {
  const canonical = new Set([
    'agent', 'agent/runSubagent',
    'edit', 'edit/createDirectory', 'edit/createFile', 'edit/editFiles', 'edit/editNotebook',
    'execute', 'execute/createAndRunTask', 'execute/getTerminalOutput', 'execute/runInTerminal',
    'execute/runNotebookCell', 'execute/testFailure',
    'read', 'read/getNotebookSummary', 'read/problems', 'read/readFile',
    'read/readNotebookCellOutput', 'read/terminalLastCommand', 'read/terminalSelection',
    'search', 'search/changes', 'search/codebase', 'search/fileSearch', 'search/listDirectory',
    'search/textSearch', 'search/usages',
    'web', 'web/fetch',
    'githubRepo', 'githubTextSearch', 'todos',
  ]);
  const agentsDir = path.join(repoRoot, 'packages/ae/corpus/agents');
  for (const name of fs.readdirSync(agentsDir).filter((n) => n.endsWith('.agent.md'))) {
    const frontmatter = read(`packages/ae/corpus/agents/${name}`).match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
    const tools = YAML.parse(frontmatter)?.tools || [];
    for (const tool of tools) {
      assert.ok(canonical.has(tool), `${name} declares unknown tool id "${tool}" — update the canonical allowlist deliberately if the host renamed it`);
    }
  }
});

test('token budget: engineer agent and context pack stay within their caps', () => {
  const agent = read('packages/ae/corpus/agents/engineer.agent.md');
  const agentTokens = estimateTokens(agent);
  assert.ok(
    agentTokens <= ENGINEER_AGENT_MAX_TOKENS,
    `engineer.agent.md is ~${agentTokens} tokens, over the ${ENGINEER_AGENT_MAX_TOKENS} budget`
  );

  // The context pack has a hard byte cap; assert the constant is enforced and small.
  assert.ok(CONTEXT_PACK_MAX_BYTES <= 4096, 'context pack byte budget must stay small');
});

test('agent bodies stay concise without hiding their prompt cost in long lines', () => {
  const agentsDir = path.join(repoRoot, 'packages/ae/corpus/agents');
  for (const name of fs.readdirSync(agentsDir).filter(name => name.endsWith('.agent.md'))) {
    const source = read(`packages/ae/corpus/agents/${name}`);
    const body = source.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    const lines = body.split('\n').length;
    assert.ok(lines <= AGENT_BODY_MAX_LINES, `${name}: ${lines} body lines exceed ${AGENT_BODY_MAX_LINES}`);
    const cap = name === 'engineer.agent.md' ? ENGINEER_AGENT_MAX_TOKENS : SPECIALIST_AGENT_MAX_TOKENS;
    assert.ok(estimateTokens(source) <= cap, `${name}: prompt exceeds ${cap} estimated tokens including metadata`);
  }
});

test('deterministic retrieval: repo map, tokenizer, and staleness require no model', () => {
  // The retrieval/orientation pipeline must be model-free (AC64).
  for (const rel of [
    'packages/ae/lib/tokenize.mjs',
    'packages/ae/lib/repo-map/index.mjs',
    'packages/ae/lib/repo-map/lexical-extractor.mjs',
    'packages/ae/lib/index-status.mjs',
  ]) {
    const src = read(rel);
    assert.doesNotMatch(src, /api\.anthropic\.com|openai|fetch\(|getProvider|ANTHROPIC_API_KEY/, `${rel} must be model-free`);
  }
  // The verbatim-query discipline (AC56) is documented in the tool contract.
  assert.match(read('packages/ae/corpus/skills/references/harness-tool-contract.md'), /salient nouns and identifiers \*{0,2}verbatim/i);
  // The extractor is a seam with a documented tree-sitter tier (AC62).
  assert.match(read('packages/ae/lib/repo-map/lexical-extractor.mjs'), /tree-sitter tier/i);
  assert.match(read('packages/ae/corpus/skills/references/harness-tool-contract.md'), /lexical fallback for SQL\/HCL|SQL and HCL/i);
  // init-repo invokes both index planes and points at status (AC61).
  const commands = read('packages/ae/lib/commands.mjs');
  assert.match(commands, /ensureIndexes/);
  assert.match(commands, /ae index --status/);
});

test('enforcement is query-independent (deterministic-first invariant)', () => {
  // Verification — the completion gate and evidence binding — must never read
  // the free-text query. (The implement gate may use the query only to *rank*
  // candidate plans via findMatchingPlans; its pass/fail checks are plan-based.)
  const verify = read('packages/ae/lib/verify.mjs');
  const binding = read('packages/ae/lib/evidence.mjs');
  assert.doesNotMatch(verify, /\bquery\b/, 'verify must not read the query');
  assert.doesNotMatch(binding, /\bquery\b/, 'evidence binding must not read the query');
  // In gate, the only query use is plan ranking, not a check decision.
  const gate = read('packages/ae/lib/gate.mjs');
  const gateQueryLines = gate.split('\n').filter((l) => /\bquery\b/.test(l));
  for (const line of gateQueryLines) {
    assert.match(line, /query = ''|findMatchingPlans|const matches/, `gate query use must be plan-ranking only: ${line.trim()}`);
  }
});

test('eval running is not a shipped harness command', () => {
  // Keeps AC14/surface intact even though the eval tree itself is retired.
  const bin = read('packages/ae/bin/ae.mjs');
  assert.doesNotMatch(bin, /case 'eval'/, 'eval must not be a harness CLI command');
});

test('engineer step 8 runs ae compound to close the learn loop', () => {
  const engineer = read('packages/ae/corpus/agents/engineer.agent.md');
  assert.doesNotMatch(engineer, /8\.\s*Compound/i);
  // The CI budget gate must reference the read-only check.
  const workflow = read('.github/workflow-templates/harness-plan-verification.yml');
  assert.match(workflow, /ae report --check/, 'CI must run the budget gate');
});

// Registry entries own ae command help, including explicit usage overrides.
test('report exposes current usage without mutating lifecycle state', () => {
  assert.equal(hasCommand('report'), true, 'report command must be registered');
  const help = describeCommand('report');
  assert.equal(help.usage, '[--facts] [--growth] [--sync] [--global] [--check] [--json]', 'help documents report');
  // --sync writes telemetry under the selected home (~/.ae by default, with legacy fallback).
  // Report must not write session or plan state.
  const commands = read('packages/ae/lib/commands.mjs');
  const reportFn = commands.slice(commands.indexOf('export async function cmdReport'), commands.indexOf('export async function cmdValidatePlan'));
  assert.doesNotMatch(reportFn, /writeSession\(/, 'report must not mutate session state');
  assert.doesNotMatch(reportFn, /writeEvent\(/, 'report must not emit lifecycle events');
});

test('consolidate skill treats a cluster as a category group the skill may split into multiple ops', () => {
  const skill = read('packages/ae/corpus/skills/consolidate/SKILL.md');
  assert.doesNotMatch(skill, /choose exactly one op/i, 'the one-op-per-cluster mandate must be removed');
  assert.match(skill, /category group/i, 'a cluster is documented as a category group');
  assert.match(skill, /multiple ops/i, 'the skill may emit multiple ops for one category group');
});

test('knowledge layer surface: consolidate command and insight lane stay documented', () => {
  // The knowledge group and its three modes are the M1 public contract.
  assert.equal(describeCommand('knowledge')?.group, 'knowledge', 'knowledge command is in the knowledge group');
  assert.equal(hasCommand('consolidate'), true, 'consolidate command registered');
  assert.equal(
    describeCommand('consolidate')?.usage,
    '[--status | --candidates | --apply --ops <path> | --rebuild --yes]',
    'help documents consolidate modes'
  );
  assert.ok(
    describeCommand('compound')?.options.some(([label]) => label.includes('--insight')),
    'compound help documents the insight lane'
  );
  // The M2 human-authority and read-only surfaces are the same public contract.
  assert.equal(hasCommand('remember'), true, 'remember command registered');
  assert.equal(hasCommand('learning'), true, 'learning command registered');
  assert.equal(hasCommand('learnings'), true, 'learnings command registered');
  assert.equal(hasCommand('knowledge'), true, 'knowledge command registered');
  assert.equal(hasCommand('eval-knowledge'), true, 'eval-knowledge command registered');
    assert.equal(
    describeCommand('knowledge')?.usage,
    '<on|suggest|off|freeze|capture-only> | --status | purge <file|--all> | commit <none|repo> | migrate-store',
    'help documents the knowledge suggest mode, opt-in commit mode, and stranded-store migration'
  );
  assert.equal(
    describeCommand('learning')?.usage,
    '<retire|dispute|confirm|promote> <id> [--reason "<r>"] [--to <path>]',
    'help documents learning promote'
  );
  // The skill never writes learnings directly — apply is the sole writer.
  const apply = read('packages/ae/lib/knowledge/apply.mjs');
  assert.match(apply, /MAX_OPS_PER_RUN/, 'delta contract enforced in apply');
  assert.match(apply, /scanSecrets/, 'secret scan runs at the write boundary');
  assert.match(apply, /'MERGE'/, 'apply.mjs recognizes the MERGE op');
  assert.match(apply, /E_DOMAIN_CAP/, 'apply.mjs enforces the domain cap with E_DOMAIN_CAP');
  // The new human-authority commands must emit real lifecycle events, not silently drop.
  const events = read('packages/ae/lib/events.mjs');
  assert.match(events, /'remember'/, 'EVENT_TYPES includes remember');
  assert.match(events, /'learning'/, 'EVENT_TYPES includes learning');
  assert.match(events, /'knowledge'/, 'EVENT_TYPES includes knowledge');
  assert.match(events, /'migrate_layout'/, 'EVENT_TYPES includes migrate_layout');
    const store = read('packages/ae/lib/knowledge/store.mjs');
  assert.match(store, /KNOWLEDGE_MODES = new Set\(\[[^\]]*'suggest'[^\]]*\]\)/, 'store.mjs KNOWLEDGE_MODES includes suggest');
  const commands = read('packages/ae/lib/commands.mjs');
  assert.doesNotMatch(commands, /const KNOWLEDGE_MODES\s*=\s*new Set/, 'commands.mjs must not keep its own copy of KNOWLEDGE_MODES');
  const concept = read('docs/adaptive-engineering.md');
  assert.match(concept, /stateDiagram/, 'concept doc includes the learning lifecycle stateDiagram');
  assert.match(concept, /promote/, 'concept doc documents learning promote');
  assert.match(read('packages/ae/README.md'), /knowledge commit/, 'README documents knowledge commit');
  assert.match(store, /export function readGovernance/, 'store.mjs exports readGovernance');
  assert.match(apply, /governed/, 'apply.mjs tracks governed reapplication');
  assert.match(concept, /governance/i, 'concept doc documents the governance ledger');
    assert.match(
    commands,
    /quarantined episode\(s\) — inspect with ae consolidate --status, clear with knowledge purge <path>/,
    'commands.mjs renders the learnings quarantine line'
  );
});

test('token budget: no SKILL.md body exceeds the line cap', () => {
  const skillsDir = path.join(repoRoot, 'packages/ae/corpus/skills');
  const oversized = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && exists(`packages/ae/corpus/skills/${entry.name}/SKILL.md`))
    .map((entry) => ({ name: entry.name, lines: read(`packages/ae/corpus/skills/${entry.name}/SKILL.md`).split('\n').length }))
    .filter((s) => s.lines > SKILL_BODY_MAX_LINES);
  assert.deepEqual(
    oversized,
    [],
    `SKILL.md over ${SKILL_BODY_MAX_LINES} lines (split dense content into references/): ${oversized.map((s) => `${s.name}=${s.lines}`).join(', ')}`
  );
});

test('domain instructions do not triple-stack on a single Java file', () => {
  const instrDir = path.join(repoRoot, 'packages/ae/corpus/instructions');
  const javaScoped = fs
    .readdirSync(instrDir)
    .filter((name) => name.endsWith('.instructions.md'))
    .filter((name) => /applyTo:\s*['"]\*\*\/\*\.java['"]/.test(read(`packages/ae/corpus/instructions/${name}`)));
  assert.deepEqual(
    javaScoped,
    ['java.instructions.md'],
    `exactly one always-on instruction may match **/*.java; found: ${javaScoped.join(', ')}`
  );
  // The relocated deep guides live as on-demand skill references.
  assert.ok(exists('packages/ae/corpus/skills/java/references/spring-boot.md'), 'Spring Boot guide moved to /java references');
  assert.ok(exists('packages/ae/corpus/skills/aws/references/aws-sdk.md'), 'AWS SDK guide moved to /aws references');
});

test('capability registry inventories every current primitive with ownership and lifecycle', () => {
  const registry = YAML.parse(read('packages/ae/corpus/knowledge/capability-registry.yaml'));
  assert.equal(registry.version, 2);
  assert.deepEqual(registry.lifecycle_states, ['candidate', 'experimental', 'active', 'deprecated', 'retired']);

  const skillsDir = path.join(repoRoot, 'packages/ae/corpus/skills');
  const currentSkills = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && exists(`packages/ae/corpus/skills/${entry.name}/SKILL.md`))
    .map((entry) => entry.name);
  const currentAgents = fs
    .readdirSync(path.join(repoRoot, 'packages/ae/corpus/agents'))
    .filter((name) => name.endsWith('.agent.md'))
    .map((name) => name.replace(/\.agent\.md$/, ''));

  for (const [name, type] of [
    ...currentSkills.map((name) => [name, 'skill']),
    ...currentAgents.map((name) => [name, 'agent']),
  ]) {
    const entry = Object.entries(registry.capabilities || {}).find(
      ([key, value]) => (value.name || key) === name && value.type === type
    )?.[1];
    assert.ok(entry, `registry missing ${type} ${name}`);
    assert.equal(entry.type, type, `${name} type`);
    assert.match(entry.owner || '', /\S/, `${name} owner`);
    assert.ok(registry.lifecycle_states.includes(entry.status), `${name} lifecycle status`);
  }

  for (const [name, entry] of Object.entries(registry.capabilities)) {
    assert.match(entry.owner || '', /\S/, `${name} owner`);
    assert.ok(registry.lifecycle_states.includes(entry.status), `${name} lifecycle status`);
    if (entry.origin === 'promoted' && entry.type === 'skill') {
      assert.match(entry.eval_suite || '', /\S/, `${name} trigger/outcome eval suite`);
      assert.ok(entry.promotion_evidence?.length > 0, `${name} promotion evidence`);
    }
  }
});

test('canonical architecture defines capability promotion through retirement', () => {
  const lifecycle = read(architecturePath);
  for (const state of ['candidate', 'experimental', 'active', 'deprecated', 'retired']) {
    assert.match(lifecycle, new RegExp(state, 'i'));
  }
  assert.match(lifecycle, /trigger eval/i);
  assert.match(lifecycle, /outcome eval/i);
  assert.match(lifecycle, /promotion evidence/i);
  assert.match(lifecycle, /tombstone/i);
  assert.match(lifecycle, /overlap/i);
});

test('review fixes preserve thin wrappers, complete skill metadata, and CI pinning', () => {
  // Prompt wrappers are retired: the directory is gone and upgrades purge hydrated copies.
  assert.ok(!exists('.github/prompts'), 'prompt wrappers must not exist');
  const retired = JSON.parse(read('packages/ae/retired.json'));
  assert.ok(retired.retired.includes('prompts'), 'retired.json must purge hydrated prompts');

  for (const rel of [
    'packages/ae/corpus/skills/engineer/SKILL.md',
    'packages/ae/corpus/skills/ensure-plan/SKILL.md',
    'packages/ae/corpus/skills/ensure-capability/SKILL.md',
    'packages/ae/corpus/skills/auto-compound/SKILL.md',
  ]) {
    const skill = read(rel);
    assert.match(skill, /Should trigger:/i, `${rel} missing positive trigger examples`);
    assert.match(skill, /Should not trigger:/i, `${rel} missing negative trigger examples`);
    assert.match(skill, /Confusable/i, `${rel} missing confusable boundaries`);
  }

  const workflow = read('.github/workflow-templates/harness-plan-verification.yml');
  assert.match(workflow, /archive_sha256:/i);
  assert.match(workflow, /sha256sum --check/i);
  assert.doesNotMatch(workflow, /pull_request:|pull_request_target:/);

  const checks = YAML.parse(read('.github/harness/checks.yaml'));
  assert.match(checks.checks['prompt-contracts'].command.join(' '), /prompt-library-contracts\.test\.mjs/);
  assert.equal(checks.checks['build-assets'], undefined);
  assert.equal(exists('scripts/build-harness-assets.mjs'), false);

  assert.match(read('packages/ae/corpus/skills/harness-doctor/SKILL.md'), /ae doctor/);

  const concept = read(architecturePath);
  assert.match(concept, /exemptions/i);
  assert.match(concept, /waivers/i);
  assert.match(concept, /plan_schema:\s*1/);
  assert.match(concept, /verification:\s*\n\s+required:[\s\S]*criteria:/);
  assert.match(concept, /reviews:\s*\n\s+required:[\s\S]*completed:[\s\S]*critical_open:/);

  const packageReadme = read('packages/ae/README.md');
  assert.match(packageReadme, /manual[^\n]*diagnostic/i);
  assert.match(packageReadme, /private plans/i);

  assert.match(read('packages/ae/corpus/skills/references/harness-tool-contract.md'), /ae help <command>/);
  assert.match(read(architecturePath), /bounded delegation/i);

  const agents = read('AGENTS.md');
  for (const mode of ['Answer', 'Investigate', 'Deliver']) assert.match(agents, new RegExp(mode));
  assert.match(agents, /skill chain[^\n]*Deliver mode/i);
  assert.match(read('README.md'), /```text\n@engineer:/);
});

test('architect is an internal design skill and names no model', () => {
  const skill = read('packages/ae/corpus/skills/architect/SKILL.md');
  const frontmatter = YAML.parse(skill.match(/^---\n([\s\S]*?)\n---/)[1]);
  assert.equal(frontmatter.name, 'architect');
  assert.equal(frontmatter['user-invocable'], false);
  assert.ok(frontmatter.description.length <= 220, `description is ${frontmatter.description.length} characters`);
  assert.match(frontmatter.description, /\/code-review/);
  assert.match(skill, /## Trigger Examples/);
  assert.match(skill, /references\/design-red-flags\.md/);
  assert.equal(exists('packages/ae/corpus/skills/architect/references/design-red-flags.md'), true);
  assert.doesNotMatch(skill, /\b(gpt|claude|grok|gemini|opus|sonnet)-\d/i);
  assert.doesNotMatch(read('packages/ae/corpus/skills/architect/references/design-red-flags.md'), /\b(gpt|claude|grok|gemini|opus|sonnet)-\d/i);
});

test('repository authoring routing uses checked-in procedures and stays out of hydration', () => {
  assert.equal(exists('scripts/build-harness-assets.mjs'), false);
  assert.equal(exists('packages/ae/assets'), false);
  assert.equal(fs.existsSync(path.join(repoRoot, 'packages/ae/corpus/.cursor')), false);
  assert.doesNotMatch(read('packages/ae/lib/sync.mjs'), /['"`]\.cursor/);

  const rule = read('.cursor/rules/edit-kind.mdc');
  assert.match(rule, /^alwaysApply:\s*true$/m);
  const rows = rule.split('\n').filter((line) => /^\| [^|]+ \|/.test(line) && !/^\|\s*-/.test(line)).slice(1);
  assert.ok(rows.length > 0, 'authoring guidance must route edits to repository sources');
  for (const row of rows) {
    const source = row.split('|')[2].trim().match(/^`([^`]+)`$/)?.[1];
    assert.ok(source, `procedure must name one repository file: ${row}`);
    assert.equal(path.isAbsolute(source), false, `${source} must be repository-relative`);
    assert.equal(source.split(/[\\/]/).includes('..'), false, `${source} must stay in the repository`);
    assert.equal(isTracked(source), true, `${source} must be available in a fresh checkout`);
    assert.equal(fs.statSync(path.join(repoRoot, source)).isFile(), true);
  }
  for (const skill of ['architect', 'create-primitive', 'code-review']) {
    assert.ok(rule.includes(`packages/ae/corpus/skills/${skill}/SKILL.md`));
  }
  assert.match(rule, /packages\/ae\/corpus\/agents\/engineer\.agent\.md/);
  assert.match(rule, /node packages\/ae\/bin\/ae\.mjs orient --read --context-version 2/);
  assert.match(rule, /node packages\/ae\/bin\/ae\.mjs verify/);
  assert.doesNotMatch(rule, /pstack|poteto|~[\\/]|\|\s*(?:how|why|tdd|unslop)\s*\|/i);

  const modelPin = /\b(gpt|claude|grok|gemini|opus|sonnet|composer)-\d/i;
  const rulesDir = path.join(repoRoot, '.cursor', 'rules');
  const rules = fs.readdirSync(rulesDir).filter((name) => name.endsWith('.mdc'));
  assert.ok(rules.includes('edit-kind.mdc'));
  for (const name of rules) {
    assert.doesNotMatch(read(`.cursor/rules/${name}`), modelPin, `${name} names a model`);
  }
});

const REPO_POINTER = /prompt-library/i;
const REPO_POINTER_SKIP = new Set([
  'packages/ae/package.json',
  'packages/ae/retired.json',
  'packages/ae/test/prompt-library-contracts.test.mjs',
]);
const DELETED_DOC_POINTERS = [
  'docs/architecture/engineer-harness.md',
  'docs/onboarding/harness-quickstart.md',
  'MEMORY-MODEL.md',
];

function filesUnder(relDir, found) {
  const abs = path.join(repoRoot, relDir);
  if (!fs.existsSync(abs)) return;
  for (const name of fs.readdirSync(abs)) {
    if (name === 'node_modules' || name === '.git' || name === '.harness') continue;
    const rel = `${relDir}/${name}`;
    const stat = fs.statSync(path.join(repoRoot, rel));
    if (stat.isDirectory()) filesUnder(rel, found);
    else if (stat.isFile()) found.push(rel);
  }
}

test('harness package prose does not name the prompt-library repository', () => {
  const files = [];
  filesUnder('packages/ae', files);
  const repoHits = [];
  const docHits = [];
  for (const rel of files) {
    if (REPO_POINTER_SKIP.has(rel)) continue;
    const buf = fs.readFileSync(path.join(repoRoot, rel));
    if (buf.includes(0)) continue;
    const text = buf.toString('utf8');
    if (REPO_POINTER.test(text)) repoHits.push(rel);
    if (!rel.startsWith('packages/ae/corpus/')) continue;
    for (const pointer of DELETED_DOC_POINTERS) {
      if (text.includes(pointer)) docHits.push(`${rel} → ${pointer}`);
    }
  }
  assert.deepEqual(repoHits.sort(), [], 'package prose names the prompt-library repository');
  assert.deepEqual(docHits.sort(), [], 'installed corpus points at a deleted doc');
});

test('repository startup context preserves Engineer review authority and exact-claim synthesis', () => {
  const context = read('.github/agent-context.md');
  const branch = context.split('### Code Review Branch Diffs\n')[1].split('\n### ', 1)[0];
  assert.match(branch, /Engineer.*ae review prepare/);
  assert.match(branch, /ae review assemble/);
  assert.doesNotMatch(branch, /ask the user to run|coordinator uses `terminalLastCommand`/i);
  const synthesis = context.split('### Confidence-Gated Code Review\n')[1].split('\n### ', 1)[0];
  assert.match(synthesis, /description.*suggested_fix/);
  assert.match(synthesis, /independence.*unverified|unverified.*independence/);
  assert.match(synthesis, /Engineer.*adjudicat/i);
  const document = context.split('### Document Review as Quality Gate\n')[1].split('\n### ', 1)[0];
  assert.match(document, /authoriz/i);
  assert.match(document, /revision-bound|ae plan-update/);
  assert.doesNotMatch(document, /P2\/P3 auto-applied/);
});

test('setup-models asks for confirmed slugs and spawn sites omit a missing model', () => {
  const skill = read('packages/ae/corpus/skills/setup-models/SKILL.md');
  const frontmatter = YAML.parse(skill.match(/^---\n([\s\S]*?)\n---/)[1]);
  assert.equal(frontmatter.name, 'setup-models');
  assert.equal(frontmatter['user-invocable'], false);
  assert.ok(frontmatter.description.length <= 220);
  for (const phrase of [
    'paste',
    'not confirmed',
    'inherit',
    'unlimited — max reasoning',
    'large — xhigh reasoning',
    'medium — high reasoning',
    'small — medium reasoning',
    'engineer',
    'specialist',
    'researcher',
    'reviewer',
    're-run',
    '.cursor/rules/ae-models.mdc',
    '.claude/rules/ae-models.md',
    'alwaysApply: true',
    'opus',
    'effort',
    'USERPROFILE',
    'Copilot',
    'by hand',
    'Codex',
    'model_reasoning_effort',
    '33881',
  ]) assert.match(skill, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `setup skill missing ${phrase}`);
  assert.match(skill, /does not call a model/i);
  assert.doesNotMatch(skill, /\b(rg|grep|find|sed|awk|jq)\b/);
  const sites = [
    'packages/ae/corpus/skills/references/engineer-delegation-matrix.md',
    'packages/ae/corpus/skills/references/subagent-context-packet.md',
    'packages/ae/corpus/skills/code-review/SKILL.md',
    'packages/ae/corpus/skills/document-review/SKILL.md',
    'packages/ae/corpus/skills/plan-issue/SKILL.md',
  ];
  for (const rel of sites) {
    const text = read(rel);
    assert.match(text, /ae-models\.mdc/);
    assert.match(text, /ae-models\.md/);
    assert.match(text, /omit the model/i);
    assert.match(text, /inherit/);
  }
});

test('host hook reference requires proof after recorded potential terminal mutations', () => {
  const contract = read('packages/ae/corpus/skills/references/harness-tool-contract.md');
  const boundary = contract.split('## Host hook boundary')[1];
  assert.ok(boundary, 'host hook boundary must be documented');
  assert.match(boundary, /opaque|unknown/);
  assert.match(boundary, /failed[^\n]*terminal|terminal[^\n]*fail/i);
  assert.match(boundary, /latest recorded potential mutation/);
  assert.doesNotMatch(boundary, /only for a successful mutation|latest successful mutation/);
});
