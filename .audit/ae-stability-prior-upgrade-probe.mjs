import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
if (process.argv.length !== 5 || process.platform !== 'linux') {
  console.error('Usage (Linux): node ae-stability-prior-upgrade-probe.mjs OLD_ARCHIVE CANDIDATE_ARCHIVE OUTPUT_DIRECTORY');
  process.exit(2);
}
const oldArchive = path.resolve(process.argv[2]);
const candidateArchive = path.resolve(process.argv[3]);
const outputDirectory = path.resolve(process.argv[4]);
for (const archive of [oldArchive, candidateArchive]) assert.ok(fs.statSync(archive).isFile(), `Not an archive file: ${archive}`);
fs.mkdirSync(outputDirectory, { recursive: true });
const runRoot = fs.mkdtempSync(path.join(outputDirectory, 'prior-upgrade-run-'));
const transcript = path.join(runRoot, 'transcript.jsonl');
const evidencePath = path.join(runRoot, 'evidence.json');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AE_|HARNESS_|COPILOT_HOME$|CODEX_HOME$|CLAUDE_CONFIG_DIR$|CURSOR_HOME$)/.test(key)));
Object.assign(env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Simulated upgrade fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Simulated upgrade fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  npm_config_userconfig: '/dev/null', npm_config_cache: path.join(runRoot, 'npm-cache'),
  npm_config_update_notifier: 'false',
});
const evidence = {
  schema: 1, verdict: 'INCONCLUSIVE', runRoot, transcript,
  limits: ['Simulated disposable approvals only', 'Installed native bridge qualification only; no live editor/model acceptance', 'Linux only'],
  oldSource: { commit: 'e1d1cdff2743d16b1d2522374e18267df5e205af', version: '0.14.1' },
  candidateSource: { commit: '4bbd786a71e19a793128f35e9854cbb7b689024a', version: '0.14.2' },
  sourceIdentityBasis: 'Exact recorded archive digests; verify source-byte identity with the companion provenance script.',
  archives: {}, hosts: [], missingChecks: null,
};
function command(label, executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: runRoot, env, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...options });
  fs.appendFileSync(transcript, JSON.stringify({ label, executable, args, cwd: options.cwd || runRoot, status: result.status, signal: result.signal, error: result.error?.message || null, stdout: result.stdout, stderr: result.stderr }) + '\n');
  return result;
}
function ok(label, executable, args, options) {
  const result = command(label, executable, args, options);
  assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
  return result;
}
function json(label, executable, args, options) {
  return JSON.parse(ok(label, executable, args, options).stdout);
}
function snapshot(root) {
  const result = {};
  if (!fs.existsSync(root)) return result;
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) result[path.relative(root, full)] = digest(fs.readFileSync(full));
      else result[path.relative(root, full)] = `unsupported:${entry.name}`;
    }
  }
  visit(root);
  return result;
}
function fixture(name, withAuthority = true) {
  const root = path.join(runRoot, name), workspace = path.join(root, 'repository');
  const configHome = path.join(root, 'native config'), skillsHome = path.join(root, 'native skills'), home = path.join(root, 'state');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'example.txt'), 'original\n');
  fs.writeFileSync(path.join(workspace, 'behavior.test.mjs'), "import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport { test } from 'node:test';\ntest('original fixture bytes', () => assert.equal(fs.readFileSync(new URL('./example.txt', import.meta.url), 'utf8'), 'original\\n'));\n");
  const checks = 'version: 1\nchecks:\n  behavior:\n    command: [node, --test, behavior.test.mjs]\n    proof: behavior\n';
  if (withAuthority) {
    fs.mkdirSync(path.join(workspace, '.github/harness'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.github/harness/checks.yaml'), checks);
    fs.writeFileSync(path.join(workspace, '.github/harness/policy.yaml'), 'version: 1\nenforcement: enforce\n');
  }
  ok(`${name}:git-init`, 'git', ['init', '-q'], { cwd: workspace });
  ok(`${name}:git-add`, 'git', ['add', '.'], { cwd: workspace });
  ok(`${name}:git-commit`, 'git', ['commit', '-qm', 'Disposable upgrade fixture'], { cwd: workspace });
  ok(`${name}:behavior-test`, process.execPath, ['--test', 'behavior.test.mjs'], { cwd: workspace });
  const bindings = ['--workspace', workspace, '--ae-home', home, '--copilot-home', configHome, '--skills-home', skillsHome, '--json', '--no-events'];
  const native = ['--config-home', configHome, '--skills-home', skillsHome, '--ae-home', home, '--workspace', workspace, '--json', '--no-events'];
  return { root, workspace, configHome, skillsHome, home, checks, bindings, native };
}
function cli(label, runtime, args, f, native = false) {
  return json(label, process.execPath, [path.join(runtime, 'bin/ae.mjs'), ...args, ...(native ? f.native : f.bindings)], { cwd: f.workspace });
}
function hookCommand(f, host) {
  const filename = path.join(f.configHome, host === 'claude-code' ? 'settings.json' : 'hooks.json');
  const document = JSON.parse(fs.readFileSync(filename));
  return host === 'cursor' ? document.hooks.preToolUse[0].command : document.hooks.PreToolUse[0].hooks[0].command;
}
function hook(label, f, host, tool = 'Read') {
  const payload = { cwd: f.workspace, session_id: `fixture-${host}`, tool_name: tool, tool_input: { file_path: path.join(f.workspace, 'example.txt'), ...(tool === 'Write' ? { content: 'should never be written\n' } : {}) } };
  return command(label, hookCommand(f, host), [], { shell: true, cwd: f.configHome, input: JSON.stringify(payload), timeout: 30000 });
}
function fallback(f, runtime, label) {
  const text = fs.readFileSync(path.join(f.skillsHome, 'engineer/references/ae-instructions.md'), 'utf8');
  const argv = JSON.parse(text.match(/invoke the installed package directly with literal argv: `([^`]+)`/)[1]);
  const binding = JSON.parse(text.match(/append these literal argv elements before any `--` argument boundary: `([^`]+)`/)[1]);
  assert.equal(argv[1], path.join(runtime, 'bin/ae.mjs'));
  assert.deepEqual(binding, ['--copilot-home', f.configHome, '--skills-home', f.skillsHome, '--ae-home', f.home]);
  const result = json(label, argv[0], [...argv.slice(1), 'orient', '--read', ...binding, '--workspace', f.workspace, '--json', '--no-events'], { cwd: f.configHome });
  assert.equal(result.trust.state, 'trusted');
  assert.equal(result.checkReadiness.status, 'ready');
  return { argv, binding, status: 0, trust: result.trust.state, checks: result.checkReadiness.status };
}
try {
  for (const [role, archive, expected] of [['old', oldArchive, '0.14.1'], ['candidate', candidateArchive, '0.14.2']]) {
    const bytes = fs.readFileSync(archive), prefix = path.join(runRoot, `${role} installation`);
    const recordedDigest = role === 'old' ? '253273e04c7464c6eb1cfee0f9ad5d43e2197f8e6c04e82c0f531a976d573a5b' : '5dc67be1ee0645eba72eeb1341889fc53ea78a425fdee778f16ad1cf6ad1db17';
    assert.equal(digest(bytes), recordedDigest, `${role} archive differs from the qualified artifact`);
    const packed = JSON.parse(ok(`${role}:archive-package-metadata`, 'tar', ['-xOf', archive, 'package/package.json']).stdout);
    assert.equal(packed.version, expected);
    ok(`${role}:offline-install`, 'npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, archive], { timeout: 180000 });
    const runtime = path.join(prefix, 'node_modules/ae-harness');
    const metadata = JSON.parse(fs.readFileSync(path.join(runtime, 'package.json')));
    assert.equal(metadata.version, expected);
    const version = ok(`${role}:installed-version`, path.join(prefix, 'node_modules/.bin/ae'), ['--version']).stdout.trim();
    assert.match(version, new RegExp(expected.replaceAll('.', '\\.')));
    evidence.archives[role] = { path: archive, sha256: digest(bytes), sha512: crypto.createHash('sha512').update(bytes).digest('hex'), bytes: bytes.length, version, packageVersion: metadata.version, prefix, runtime };
  }
  const oldRuntime = evidence.archives.old.runtime, candidateRuntime = evidence.archives.candidate.runtime;
  const fixtures = [];
  for (const host of ['codex', 'claude-code', 'cursor']) {
    const f = fixture(host);
    cli(`${host}:old-setup`, oldRuntime, ['host', 'setup', '--host', host], f, true);
    const oldManifest = JSON.parse(fs.readFileSync(path.join(f.configHome, '.ae-host.json')));
    assert.equal(oldManifest.packageVersion, '0.14.1');
    assert.equal(oldManifest.packageRoot, oldRuntime);
    const oldHook = hook(`${host}:old-hook`, f, host);
    assert.equal(oldHook.status, 0, oldHook.stderr);
    assert.deepEqual(JSON.parse(oldHook.stdout), {});
    const approved = cli(`${host}:simulated-old-approval`, oldRuntime, ['trust', 'approve'], f);
    assert.equal(approved.state, 'trusted');
    const trustBytes = fs.readFileSync(path.join(f.home, 'trust.yaml'));
    const repository = snapshot(f.workspace);
    const outdated = cli(`${host}:candidate-status-before-upgrade`, candidateRuntime, ['host', 'status', '--host', host], f, true);
    assert.equal(outdated.assetState, 'outdated');
    fixtures.push({ host, f, approved, trustBytes, repository, oldManifest, oldCommand: hookCommand(f, host) });
  }
  const removedRuntime = `${oldRuntime}.temporarily-removed`;
  fs.renameSync(oldRuntime, removedRuntime);
  for (const item of fixtures) {
    const result = hook(`${item.host}:old-hook-negative-control`, item.f, item.host);
    assert.notEqual(result.status, 0, 'Removing old runtime must break old hook');
    item.control = { status: result.status, errorMentionsOldRuntime: result.stderr.includes(oldRuntime) };
  }
  fs.renameSync(removedRuntime, oldRuntime);
  for (const item of fixtures) {
    const { host, f, approved, trustBytes, repository } = item;
    const result = cli(`${host}:candidate-upgrade`, candidateRuntime, ['upgrade', '--host', host], f, true);
    assert.equal(result.integration.assetState, 'current');
    assert.equal(result.integration.nativeQualification, 'unverified');
    assert.equal(result.workspace.status, 'prerequisites-ready');
    assert.equal(result.workspace.trust.state, 'trusted');
    assert.equal(result.workspace.trust.digest, approved.digest);
    assert.equal(result.workspace.trust.approvedAt, approved.approvedAt);
    assert.deepEqual(result.workspace.nextActions, []);
    assert.deepEqual(fs.readFileSync(path.join(f.home, 'trust.yaml')), trustBytes);
    assert.deepEqual(snapshot(f.workspace), repository);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.configHome, '.ae-host.json')));
    assert.equal(manifest.packageVersion, '0.14.2');
    assert.equal(manifest.packageRoot, candidateRuntime);
    for (const key of ['configHome', 'skillsHome', 'home']) assert.equal(manifest[key], f[key]);
    assert.notEqual(hookCommand(f, host), item.oldCommand);
    assert.ok(!hookCommand(f, host).includes(oldRuntime));
    item.result = { host, verdict: 'VERIFIED', from: item.oldManifest.packageVersion, to: manifest.packageVersion, roots: { configHome: f.configHome, skillsHome: f.skillsHome, home: f.home }, negativeControl: item.control, approvedAt: approved.approvedAt, policyDigest: approved.digest, trustSha256: digest(trustBytes), repositorySnapshotSha256: digest(JSON.stringify(repository)), preservedTrustBytes: true, preservedRepositoryBytes: true, integration: { assetState: result.integration.assetState, nativeQualification: result.integration.nativeQualification }, actions: result.integration.actions.length };
  }
  fs.rmSync(evidence.archives.old.prefix, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  assert.equal(fs.existsSync(evidence.archives.old.prefix), false);
  for (const item of fixtures) {
    const { host, f } = item;
    const read = hook(`${host}:regenerated-hook-after-old-install-deletion`, f, host);
    assert.equal(read.status, 0, read.stderr);
    assert.deepEqual(JSON.parse(read.stdout), {});
    assert.deepEqual(snapshot(f.workspace), item.repository);
    item.result.oldInstallationRemoved = true;
    item.result.regeneratedHook = { status: read.status, output: JSON.parse(read.stdout) };
    item.result.fallback = fallback(f, candidateRuntime, `${host}:projected-fallback-after-old-install-deletion`);
    const currentConfig = snapshot(f.configHome), currentSkills = snapshot(f.skillsHome);
    const repeat = cli(`${host}:candidate-repeat-upgrade`, candidateRuntime, ['upgrade', '--host', host], f, true);
    assert.deepEqual(repeat.integration.actions, []);
    assert.deepEqual(snapshot(f.configHome), currentConfig);
    assert.deepEqual(snapshot(f.skillsHome), currentSkills);
    assert.deepEqual(snapshot(f.workspace), item.repository);
    assert.deepEqual(fs.readFileSync(path.join(f.home, 'trust.yaml')), item.trustBytes);
    item.result.repeatUpgrade = 'no actions or byte changes';
    evidence.hosts.push(item.result);
  }
  const missing = fixture('missing-checks', false);
  const missingSetup = cli('missing-checks:candidate-setup', candidateRuntime, ['host', 'setup', '--host', 'codex'], missing, true);
  const missingUpgrade = cli('missing-checks:candidate-upgrade', candidateRuntime, ['upgrade', '--host', 'codex'], missing, true);
  for (const result of [missingSetup, missingUpgrade]) {
    assert.equal(result.workspace.checkReadiness.status, 'missing');
    assert.equal(result.workspace.trust.state, 'untrusted');
    assert.ok(result.workspace.nextActions.length > 0);
    assert.ok(result.workspace.nextActions.every(action => action.owner === 'engineer'));
    assert.equal(result.workspace.nextActions.some(action => action.afterInspection?.owner === 'person'), false);
  }
  assert.equal(fs.existsSync(path.join(missing.home, 'trust.yaml')), false);
  assert.equal(fs.existsSync(path.join(missing.workspace, '.github/harness')), false);
  const preparation = missingUpgrade.workspace.nextActions.find(action => action.command?.includes('configure')).command;
  assert.equal(preparation[1], path.join(candidateRuntime, 'bin/ae.mjs'));
  const checkDecision = { schema: 1, expectedDigest: null, checks: { behavior: { command: [process.execPath, '--test', 'behavior.test.mjs'], proof: 'behavior' } }, rationale: 'Register the fixture behavior assertion after inspecting and running it.' };
  json('missing-checks:execute-engineer-preparation', preparation[0], preparation.slice(1), { cwd: missing.workspace, input: JSON.stringify(checkDecision) });
  const prepared = cli('missing-checks:after-preparation', candidateRuntime, ['upgrade', '--host', 'codex'], missing, true);
  assert.equal(prepared.workspace.checkReadiness.status, 'ready');
  assert.equal(prepared.workspace.trust.state, 'untrusted');
  assert.ok(prepared.workspace.nextActions.some(action => action.owner === 'person'));
  assert.equal(fs.existsSync(path.join(missing.home, 'trust.yaml')), false);
  evidence.missingChecks = { verdict: 'VERIFIED', setupOwners: missingSetup.workspace.nextActions.map(action => action.owner), upgradeOwners: missingUpgrade.workspace.nextActions.map(action => action.owner), preparation, preparedChecks: prepared.workspace.checkReadiness.status, afterPreparationOwners: prepared.workspace.nextActions.map(action => action.owner), trustFileCreated: false };
  evidence.verdict = 'VERIFIED';
} catch (error) {
  evidence.verdict = 'ISSUES';
  evidence.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ verdict: evidence.verdict, evidencePath, runRoot, failure: evidence.failure?.message || null }) + '\n');
}
