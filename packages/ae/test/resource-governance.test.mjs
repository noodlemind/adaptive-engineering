import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { getCorpusRoot } from '../lib/assets.mjs';
import { validatePrimitiveContent } from '../lib/resource-validation.mjs';
import { reviewHash } from '../lib/review-preparation.mjs';

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'resources-governance-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const copilot = path.join(workspace, 'copilot');
  const cli = (...args) => spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/ae.mjs'), 'resources', ...args, '--workspace', workspace, '--copilot-home', copilot, '--json'], { encoding: 'utf8', env: { ...process.env, HARNESS_NO_EVENTS: '1' } });
  const input = value => { fs.writeFileSync(path.join(workspace, 'input.json'), JSON.stringify(value)); return 'input.json'; };
  return { workspace, copilot, cli, input };
}
const skill = `---\nname: focused-review\ndescription: Evaluate focused review questions.\nuser-invocable: false\n---\n\n# Focused Review\n\n## Should trigger\n- Review a race.\n- Evaluate ordering.\n- Assess a lock.\n\n## Should not trigger\n- Translate prose.\n- Tell the time.\n- Generate artwork.\n\n## Output\nEvidence and a judgment.\n`;

test('structured resources validate before one writer and dry-run leaves no primitive', t => {
  const f = fixture(t), file = f.input({ schema: 1, text: skill });
  const dry = f.cli('create', 'skill', 'focused-review', '--file', file, '--dry-run');
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  assert.equal(fs.existsSync(path.join(f.copilot, 'skills/focused-review/SKILL.md')), false);
  const first = f.cli('create', 'skill', 'focused-review', '--file', file);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.equal(JSON.parse(f.cli('create', 'skill', 'focused-review', '--file', file).stdout).primitive.state, 'unchanged');
  const bad = f.cli('create', 'skill', 'focused-review', '--file', f.input({ schema: 1, text: skill.replace('Review a race.', 'TODO') }));
  assert.notEqual(bad.status, 0);
  assert.equal(fs.readFileSync(path.join(f.copilot, 'skills/focused-review/SKILL.md'), 'utf8'), skill);
});

test('permission expansion requires caller authorization and expected bytes; payload approval cannot grant it', t => {
  const agent = tools => `---\nname: bounded-expert\ndescription: Judge a bounded question.\nuser-invocable: false\ntools: [${tools}]\nagents: []\n---\n\n# Expert\n\n## Guardrails\nHonor scope.\n\n## Output\nEvidence.\n`;
  for (const tool of ['execute', 'edit']) {
    const f = fixture(t);
    const first = f.cli('create', 'agent', 'bounded-expert', '--file', f.input({ schema: 1, text: agent('read') }), '--yes');
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const expanded = { schema: 1, text: agent(`read, ${tool}`), expectedDigest: JSON.parse(first.stdout).primitive.digest };
    assert.notEqual(f.cli('create', 'agent', 'bounded-expert', '--file', f.input({ ...expanded, approved: true })).status, 0);
    assert.notEqual(f.cli('create', 'agent', 'bounded-expert', '--file', f.input(expanded)).status, 0);
    assert.equal(f.cli('create', 'agent', 'bounded-expert', '--file', f.input(expanded), '--yes').status, 0);
    assert.notEqual(f.cli('create', 'agent', 'bounded-expert', '--file', f.input(expanded), '--yes').status, 0);
  }
});

test('scaffolding and proposals stay dormant; exact recurring claims deduplicate replay', t => {
  const f = fixture(t);
  const scaffold = f.cli('scaffold', 'skill', 'focused-review');
  assert.equal(scaffold.status, 0, scaffold.stderr + scaffold.stdout);
  assert.equal(JSON.parse(scaffold.stdout).requiresJudgment, true);
  assert.equal(fs.existsSync(f.copilot), false);
  const proposal = { schema: 1, operation: 'review-gap', type: 'skill', name: 'focused-review', rationale: 'Judgment is missing.', text: skill, evidence: [] };
  const first = f.cli('propose', '--file', f.input(proposal));
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const value = JSON.parse(first.stdout);
  assert.equal(value.activated, false);
  assert.equal(JSON.parse(f.cli('propose', '--file', f.input(proposal)).stdout).id, value.id);
  assert.notEqual(f.cli('propose', '--file', f.input({ ...proposal, rationale: 'A different decision.' })).status, 0);
  assert.equal(fs.existsSync(f.copilot), false);
});

test('unfilled scaffolds and absent resource roots cannot pass validation', t => {
  const f = fixture(t);
  const template = JSON.parse(f.cli('scaffold', 'agent', 'bounded-expert').stdout);
  assert.notEqual(f.cli('create', 'agent', 'bounded-expert', '--file', f.input({ schema: 1, text: template.text })).status, 0);
  assert.notEqual(f.cli('validate', '--path', 'missing-root').status, 0);
});

test('recurrence separates exact claims, replay and related titles; proposal evidence stays current', t => {
  const f = fixture(t), rel = '.harness/reviews/records';
  fs.mkdirSync(path.join(f.workspace, rel), { recursive: true });
  for (const [record, sequence] of [[0, 1], [1, 1], [2, 2]]) {
    const value = { version: 2, scope: { productDigest: sequence }, findings: [{ id: 'one-claim', file: 'src/example.js', title: 'Missing guard' }], residual_risks: [`Observation ${record}`] };
    const id = reviewHash(value);
    fs.writeFileSync(path.join(f.workspace, rel, `${id}.json`), JSON.stringify({ ...value, id, recordedAt: '2026-10-09' }));
  }
  const result = f.cli('candidates');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.candidates.length, 1);
  assert.equal(packet.candidates[0].recurrence, 'exact-recorded-identity');
  assert.equal(packet.candidates[0].count, 2);
  assert.equal(packet.activated, false);
  const proposal = { schema: 1, operation: 'claim-gap', type: 'skill', name: 'focused-review', rationale: 'Repeated judgment miss.', text: skill, candidatePacket: packet.id, candidate: packet.candidates[0].id };
  assert.equal(f.cli('propose', '--file', f.input(proposal)).status, 0);
  fs.appendFileSync(path.join(f.workspace, packet.candidates[0].evidence[0].path), ' ');
  assert.notEqual(f.cli('propose', '--file', f.input(proposal)).status, 0);
  assert.equal(fs.existsSync(f.copilot), false);
});

test('permission declarations cannot name absent agents or unsupported host tools', t => {
  const f = fixture(t);
  for (const declarations of ['tools: [read, nonexistent-tool]\nagents: []', 'tools: [agent]\nagents: [missing-agent]']) {
    const text = `---\nname: bounded-expert\ndescription: Judge a bounded question.\nuser-invocable: false\n${declarations}\n---\n\n## Guardrails\nHonor the scope.\n`;
    assert.notEqual(f.cli('create', 'agent', 'bounded-expert', '--file', f.input({ schema: 1, text }), '--yes').status, 0);
  }
});

test('damaged proposal receipts cannot be overwritten or used as approval', t => {
  const f = fixture(t), proposal = { schema: 1, operation: 'damaged-gap', type: 'skill', name: 'focused-review', rationale: 'Judgment gap.', text: skill };
  const value = JSON.parse(f.cli('propose', '--file', f.input(proposal)).stdout);
  fs.writeFileSync(path.join(f.workspace, value.proposalPath), '{broken');
  assert.notEqual(f.cli('propose', '--file', f.input(proposal)).status, 0);
  assert.equal(fs.readFileSync(path.join(f.workspace, value.proposalPath), 'utf8'), '{broken');
});

test('registry drift is diagnosed and shipped inventory uses the same validator', t => {
  const f = fixture(t), root = path.join(f.workspace, 'resources');
  fs.mkdirSync(path.join(root, 'skills/focused-review'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills/focused-review/SKILL.md'), skill);
  fs.mkdirSync(path.join(root, 'knowledge'));
  fs.writeFileSync(path.join(root, 'knowledge/capability-registry.yaml'), 'version: 2\ncapabilities:\n  focused-review: {type: skill, status: active}\n  ghost: {type: agent, status: active}\nengineer_allowlist: []\n');
  const invalid = f.cli('validate', '--path', 'resources');
  assert.equal(invalid.status, 1);
  const result = JSON.parse(invalid.stdout);
  assert.equal(result.counts.skill, 1);
  assert.ok(result.diagnostics.some(d => d.reason.includes('ghost')));
  const actual = f.cli('validate', '--corpus');
  assert.equal(actual.status, 0, actual.stderr + actual.stdout);
  assert.equal(JSON.parse(actual.stdout).primitives.length, Object.values(JSON.parse(actual.stdout).counts).reduce((sum, n) => sum + n, 0));
});


test('dry-run refuses shipped collisions and instruction creation requires concrete examples', t => {
  const f = fixture(t);
  assert.notEqual(f.cli('create', 'skill', 'engineer', '--dry-run', '--file', f.input({ schema: 1, text: skill.replace('name: focused-review', 'name: engineer') })).status, 0);
  const header = '---\nname: sql-boundary\ndescription: Apply a narrow SQL convention.\napplyTo: "**/*.sql"\n---\n\nUse parameterized queries.\n';
  assert.notEqual(f.cli('create', 'instruction', 'sql-boundary', '--file', f.input({ schema: 1, text: header })).status, 0);
  const text = header + '\n## Good example\nUse a bound parameter for a value.\n\n## Bad example\nInterpolate an untrusted value into SQL.\n';
  const accepted = f.cli('create', 'instruction', 'sql-boundary', '--file', f.input({ schema: 1, text }));
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
});


test('installed shipped resources retain shipped metadata while personal resources get strict validation', t => {
  const f = fixture(t);
  fs.cpSync(getCorpusRoot(), f.copilot, { recursive: true });
  const installed = f.cli('validate');
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  fs.mkdirSync(path.join(f.copilot, 'instructions/personal-boundary'), { recursive: true });
  fs.writeFileSync(path.join(f.copilot, 'instructions/personal-boundary.instructions.md'), '---\nname: Wrong name\ndescription: Personal boundary\napplyTo: "**/*.js"\n---\n');
  assert.equal(f.cli('validate').status, 1);
});


test('a registered personal capability validates alongside the shipped corpus', t => {
  const f = fixture(t);
  fs.cpSync(getCorpusRoot(), f.copilot, { recursive: true });
  assert.equal(f.cli('create', 'skill', 'focused-review', '--file', f.input({ schema: 1, text: skill })).status, 0);
  const r = f.cli('validate');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('observed inventory digest replaces matching bytes and rejects a removed destination', t => {
  const f = fixture(t);
  assert.equal(f.cli('create', 'skill', 'focused-review', '--file', f.input({ schema: 1, text: skill })).status, 0);
  const inventory = JSON.parse(f.cli('validate').stdout), expectedDigest = inventory.primitives[0].digest;
  const replacement = f.input({ schema: 1, text: skill.replace('Evidence and a judgment.', 'Explain accepted evidence and uncertainty.'), expectedDigest });
  assert.equal(f.cli('create', 'skill', 'focused-review', '--file', replacement).status, 0);
});

test('removed destination conflicts with an observed replacement even under caller confirmation', t => {
  const f = fixture(t), created = JSON.parse(f.cli('create', 'skill', 'focused-review', '--file', f.input({ schema: 1, text: skill })).stdout);
  fs.rmSync(path.join(f.copilot, created.primitive.path));
  assert.notEqual(f.cli('create', 'skill', 'focused-review', '--file', f.input({ schema: 1, text: skill, expectedDigest: created.primitive.digest }), '--yes').status, 0);
  assert.equal(fs.existsSync(path.join(f.copilot, created.primitive.path)), false);
});

test('global tag evidence is selectable and changed global bytes reject dormant proposal replay', t => {
  const f = fixture(t), dir = path.join(f.copilot, 'knowledge/solutions/design');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(dir, `lesson-${i}.md`), `---\ntags: [publication]\n---\nLesson ${i}.\n`);
  const packet = JSON.parse(f.cli('candidates').stdout), candidate = packet.globalTagClustering[0];
  assert.match(candidate.id, /^[a-f0-9]{64}$/);
  const proposal = { schema: 1, operation: 'global-cluster', type: 'skill', name: 'focused-review', text: skill, rationale: 'Reusable judgment.', candidatePacket: packet.id, candidate: candidate.id };
  assert.equal(f.cli('propose', '--file', f.input(proposal)).status, 0);
  fs.appendFileSync(path.join(f.copilot, candidate.evidence[0].path), 'Human refinement.');
  assert.notEqual(f.cli('propose', '--file', f.input(proposal)).status, 0);
});

test('all candidate result lists fit the response bound and preserve full packet retrieval', t => {
  const f = fixture(t), dir = path.join(f.workspace, '.github/harness');
  fs.mkdirSync(dir, { recursive: true });
  const checks = Array.from({ length: 700 }, (_, i) => `  check-${i}-${'x'.repeat(120)}: {command: [node, test.js]}`).join('\n');
  fs.writeFileSync(path.join(dir, 'checks.yaml'), `version: 1\nchecks:\n${checks}\n`);
  const r = f.cli('candidates');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Buffer.byteLength(r.stdout) <= 65536);
  const value = JSON.parse(r.stdout);
  assert.ok(value.omitted.existingChecks > 0);
  const full = JSON.parse(fs.readFileSync(path.join(f.workspace, value.packetPath)));
  assert.equal(full.existingChecks.length, 700);
});

test('parseable malformed registry declarations return diagnostics instead of throwing', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.copilot, 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(f.copilot, 'knowledge/capability-registry.yaml'), 'version: 2\ncapabilities: {ghost: null}\nengineer_allowlist: {bad: shape}\n');
  const r = f.cli('validate');
  assert.equal(r.status, 1, r.stderr + r.stdout);
  const result = JSON.parse(r.stdout);
  assert.ok(result.diagnostics.some(d => /registry|declaration|allowlist/.test(d.reason)));
});

test('filling a scaffold description does not authorize unfinished agent sections', t => {
  const f = fixture(t), scaffold = JSON.parse(f.cli('scaffold', 'agent', 'bounded-expert').stdout);
  const text = scaffold.text.replace('TODO: state what this capability judges and when it applies.', 'Judge a bounded engineering question.');
  assert.notEqual(f.cli('create', 'agent', 'bounded-expert', '--file', f.input({ schema: 1, text })).status, 0);
});

test('shared validation rejects unsupported host tools independently of creation', () => {
  const text = '---\nname: bounded-expert\ndescription: Judge a bounded engineering question.\nuser-invocable: false\ntools: [nonexistent-tool]\nagents: []\n---\n\n## Judgment\nAssess evidence.\n\n## Guardrails\nHonor scope.\n\n## Output\nExplain the finding.\n';
  const result = validatePrimitiveContent({ type: 'agent', name: 'bounded-expert', text });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => /Unsupported host tool/.test(e)));
});

test('shared validation accepts the supported native edit group and legacy editFiles', () => {
  for (const tool of ['edit', 'edit/editFiles']) {
    const text = `---\nname: bounded-expert\ndescription: Implement a bounded engineering task.\nuser-invocable: false\ntools: [read, ${tool}]\nagents: []\n---\n\n## Guardrails\nHonor the authorized scope.\n\n## Output\nReport the changed files and verification.\n`;
    const result = validatePrimitiveContent({ type: 'agent', name: 'bounded-expert', text });
    assert.equal(result.valid, true, result.errors.join('; '));
  }
});
