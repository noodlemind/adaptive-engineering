import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CORE_CORPUS_MANIFEST, lifecycleNpmCommand, parseEpisodeResourceUses, runAdaptiveLifecycle } from '../eval/adaptive/lifecycle.mjs';
import { materializeMinimalCorpus } from '../eval/adaptive/core-corpus.mjs';
import { createLifecycleFixture, run, writeFile } from '../eval/adaptive/lifecycle-fixture.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('installed full and reduced corpora complete the adaptive capability lifecycle', { timeout: 600_000 }, () => {
  const report = runAdaptiveLifecycle({ packageRoot, keepArtifacts: process.env.AE_LIFECYCLE_KEEP === '1' });
  if (process.env.AE_LIFECYCLE_REPORT) fs.writeFileSync(path.resolve(process.env.AE_LIFECYCLE_REPORT), `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(report.qualification.liveModel, false);
  assert.equal(report.qualification.liveEditor, false);
  assert.deepEqual(report.evaluatedCorpora, ['full', 'minimal', 'sparse']);
  assert.deepEqual(report.arms.map(arm => arm.corpus), ['full', 'minimal']);
  for (const arm of report.arms) {
    assert.equal(arm.pass, true, JSON.stringify(arm, null, 2));
    for (const id of ['consent-persistence', 'bounded-miss-refresh', 'native-action-decision', 'exclusion-revocation', 'specialist-acquisition', 'independent-review', 'verification-negative-control', 'source-bound-tour', 'verified-human-handoff', 'cross-session-memory', 'verified-learning-recurrence']) {
      assert.equal(arm.checks.find(check => check.id === id)?.pass, true, `${arm.corpus}: ${id}\n${JSON.stringify(arm, null, 2)}`);
    }
  }
  assert.equal(report.fullCorpusUnchanged, true);
  assert.equal(report.fullInstalledCorpusUnchanged, true);
  assert.equal(report.sparse.pass, true, JSON.stringify(report.sparse));
  assert.equal(report.sparse.inventory.agents, 2);
  assert.equal(report.sparse.inventory.skills, 4);
  assert.equal(report.sparse.action, 'acquire');
  assert.equal(report.sparse.checks.find(check => check.id === 'bootstrap-diagnostics')?.pass, true);
  assert.equal(report.sparse.checks.find(check => check.id === 'specialist-acquisition')?.evidence?.missingReviewPrerequisite?.state, 'missing-provider');
  assert.equal(report.sparse.checks.find(check => check.id === 'independent-review')?.evidence?.acquiredNativeProviderUsed, true);
  assert.equal(report.sparse.checks.find(check => check.id === 'sparse-skill-acquisition')?.evidence?.actualSourceRead, true);
  assert.deepEqual(report.sparse.checks.find(check => check.id === 'sparse-skill-acquisition')?.evidence?.acquired.map(row => row.name), ['architect', 'code-review']);
  assert.equal(report.sparse.checks.find(check => check.id === 'verified-human-handoff')?.pass, true);
  assert.equal(report.sparse.checks.find(check => check.id === 'verified-learning-recurrence')?.pass, true);
  assert.equal(report.sparse.sharedReferencesPresent, true);
  assert.ok(report.arms[1].inventory.skills < report.arms[0].inventory.skills);
  assert.ok(report.arms[1].inventory.agents < report.arms[0].inventory.agents);
});

test('the minimal kernel declares its workflow dependencies and excludes domain specialists', () => {
  assert.ok(CORE_CORPUS_MANIFEST.skills.includes('engineer'));
  for (const name of ['create-primitive', 'ensure-plan', 'code-review', 'recall', 'compound-learnings']) assert.ok(CORE_CORPUS_MANIFEST.skills.includes(name), name);
  assert.ok(CORE_CORPUS_MANIFEST.agents.includes('decision-agent'));
  assert.deepEqual(CORE_CORPUS_MANIFEST.bootstrapSkills, ['engineer', 'ensure-plan', 'create-primitive', 'ensure-capability']);
  assert.deepEqual(CORE_CORPUS_MANIFEST.skills.filter(name => !CORE_CORPUS_MANIFEST.optionalSkillDependencies.includes(name)), CORE_CORPUS_MANIFEST.bootstrapSkills);
  for (const name of ['java', 'aws', 'python', 'sql']) assert.equal(CORE_CORPUS_MANIFEST.skills.includes(name), false, name);
  for (const name of ['java-reviewer', 'security-sentinel', 'performance-oracle', 'code-simplicity-reviewer']) assert.equal(CORE_CORPUS_MANIFEST.agents.includes(name), false, name);
  for (const name of CORE_CORPUS_MANIFEST.skills) assert.ok(fs.existsSync(path.join(packageRoot, 'corpus/skills', name, 'SKILL.md')), name);
  assert.throws(() => materializeMinimalCorpus(packageRoot), /refusing to prune the source corpus/);
});

test('installed fixture rejects synchronous and asynchronous reads from unselected corpora', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-corpus-probe-'));
  try {
    const source = path.join(root, 'source'), full = path.join(root, 'full'), selected = path.join(root, 'selected');
    const original = writeFile(source, 'corpus/probe.md', 'original');
    const unselected = writeFile(full, 'corpus/probe.md', 'unselected');
    const allowed = writeFile(selected, 'corpus/probe.md', 'selected');
    const sourceAlias = path.join(root, 'source-alias'), fullAlias = path.join(root, 'full-alias');
    for (const [target, alias] of [[source, sourceAlias], [full, fullAlias]]) fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    fs.mkdirSync(path.join(source, 'corpus/child'));
    fs.symlinkSync(path.join(source, 'corpus/child'), path.join(selected, 'parent-link'), process.platform === 'win32' ? 'junction' : 'dir');
    const linkedParent = `${path.join(selected, 'parent-link')}${path.sep}..${path.sep}probe.md`;
    const fx = createLifecycleFixture({ directory: path.join(root, 'fixture'), installedPackageRoot: selected, sourcePackageRoot: source, forbiddenCorpusRoots: [path.join(full, 'corpus')] });
    const invoke = text => run(process.execPath, ['--input-type=module', '-e', text], { cwd: fx.workspace, env: fx.env });
    const deniedReads = [
      `import fs from 'node:fs'; fs.readFileSync(${JSON.stringify(original)});`,
      `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(unselected)});`,
      `import { readFile } from 'node:fs/promises'; await readFile(${JSON.stringify(original)});`,
      `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(path.join(sourceAlias, 'corpus/probe.md'))});`,
      `import { readFile } from 'node:fs/promises'; await readFile(${JSON.stringify(path.join(fullAlias, 'corpus/probe.md'))});`,
    ];
    if (fs.existsSync(linkedParent)) deniedReads.push(`import fs from 'node:fs'; process.stdout.write(fs.readFileSync(${JSON.stringify(linkedParent)}));`);
    if (process.platform === 'win32' && fs.existsSync(original.toUpperCase())) deniedReads.push(`import fs from 'node:fs'; fs.readFileSync(${JSON.stringify(original.toUpperCase())});`);
    for (const text of deniedReads) {
      const denied = invoke(text);
      assert.notEqual(denied.status, 0, 'unselected corpus was readable');
      assert.match(denied.stderr, /unselected-corpus fallback/);
    }
    const read = invoke(`import { readFile } from 'node:fs/promises'; process.stdout.write(await readFile(${JSON.stringify(allowed)}));`);
    assert.equal(read.status, 0, read.stderr);
    assert.equal(read.stdout, 'selected');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lifecycle npm launcher executes the shared Node translation and preserves archive arguments', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-npm-launch-'));
  const previous = process.env.npm_execpath;
  try {
    const cli = writeFile(root, 'npm directory/npm-cli.js', 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    process.env.npm_execpath = cli;
    const args = ['install', '--offline', '--prefix', path.join(root, 'install space'), path.join(root, 'archive & literal!.tgz')];
    const invocation = lifecycleNpmCommand(args);
    assert.equal(invocation.command, process.execPath);
    const result = run(invocation.command, invocation.args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args, 'npm launcher changed the actual prefix or archive path');
  } finally {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fixture path aliases retain one exact native workspace identity', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-fixture-alias-')));
  try {
    const physical = path.join(root, 'physical'), alias = path.join(root, 'alias');
    fs.mkdirSync(physical);
    fs.symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const selected = path.join(alias, 'fixture');
    const fx = createLifecycleFixture({ directory: selected, installedPackageRoot: path.join(root, 'installation'), sourcePackageRoot: packageRoot });
    assert.equal(fx.root, fs.realpathSync.native(selected));
    assert.equal(fx.workspace, fs.realpathSync.native(path.join(selected, 'product')));
    const observed = run(process.execPath, ['--input-type=module', '-e', 'import fs from "node:fs"; process.stdout.write(fs.realpathSync.native(process.cwd()));'], { cwd: fx.workspace, env: fx.env });
    assert.equal(observed.status, 0, observed.stderr);
    assert.equal(observed.stdout, fx.workspace, 'native observation and fixture must bind the identical canonical workspace');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('episode provenance decodes native Windows paths and exact source hashes', () => {
  const resource = { kind: 'skill', name: 'enterprise-payments', path: path.win32.join('C:\\Users\\runneradmin', 'enterprise', 'skills', 'enterprise-payments', 'SKILL.md'), sha256: 'a'.repeat(64) };
  const episode = `---\r\nresource_uses: ${JSON.stringify([resource])}\r\n---\r\n# Verified learning\r\n`;
  const parsed = parseEpisodeResourceUses(episode);
  assert.equal(parsed[0].path, resource.path);
  assert.equal(parsed[0].sha256, resource.sha256);
  assert.throws(() => parseEpisodeResourceUses(`---\ntitle: No provenance\n---\nresource_uses: ${JSON.stringify([resource])}\n`), /omitted observed loaded resources/);
});
