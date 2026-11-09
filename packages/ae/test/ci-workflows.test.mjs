import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { test } from 'node:test';
import YAML from 'yaml';

const root = new URL('../../../', import.meta.url);
const workflow = name => YAML.parse(fs.readFileSync(new URL(`.github/workflows/${name}.yml`, root), 'utf8'));
const suite = job => job.steps.find(step => step.name === 'Harness test suite' || step.name === 'Harness test suite (Windows)');
const upload = job => job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));

test('Windows cancellation probe fails when a descendant outlives the runner', () => {
  const command = workflow('harness-windows').jobs.windows.steps.find(step => step.id === 'cancellation').run;
  const start = command.indexOf('const failures = [];');
  const end = command.indexOf("'@", start);
  assert.ok(start > 0 && end > start);
  for (const grandchildAlive of [false, true]) {
    let exitCode = 0;
    const logs = [];
    const context = {
      res: { status: 'cancelled' }, settledMs: 2500, ABORT_AT_MS: 1500, grandchildPid: 42, grandchildAlive,
      console: { log: message => logs.push(message), error: message => logs.push(message) },
      process: { kill() {}, exit(code) { exitCode = code; throw new Error('probe-exit'); } },
    };
    try { vm.runInNewContext(command.slice(start, end), context); }
    catch (error) { assert.equal(error.message, 'probe-exit'); }
    assert.equal(exitCode, grandchildAlive ? 1 : 0, logs.join('\n'));
    if (grandchildAlive) assert.match(logs.join('\n'), /EXPECTED.*grandchild/);
  }
});

test('Windows runs once automatically per PR revision and remains manually runnable', () => {
  const windows = workflow('harness-windows');
  assert.deepEqual(Object.keys(windows.on).sort(), ['pull_request', 'schedule', 'workflow_dispatch']);
  assert.equal(windows.on.schedule.length, 1);
  assert.equal(windows.concurrency['cancel-in-progress'], true);
  assert.match(windows.concurrency.group, /github\.workflow/);
  assert.match(windows.concurrency.group, /github\.ref/);
});

test('full suites retain discovery and replace the repeated delivery and adaptive jobs', () => {
  const linux = workflow('harness-tests');
  const windows = workflow('harness-windows');
  assert.deepEqual(Object.keys(linux.jobs), ['suites', 'test']);
  assert.equal(linux.on.pull_request?.paths, undefined);
  assert.equal(windows.on.pull_request?.paths, undefined);
  assert.deepEqual(linux.jobs.suites.strategy.matrix.shard, [1, 2, 3, 4]);
  assert.equal(linux.jobs.suites.strategy['fail-fast'], false);
  assert.match(suite(linux.jobs.suites).run, /node scripts\/ci-tests\.mjs --shard \$\{\{ matrix.shard \}\} --shards 4/);
  assert.equal(linux.jobs.test.needs, 'suites');
  assert.equal(linux.jobs.test.if, 'always()');
  assert.ok(linux.jobs.test.steps.some(step => /--verify-manifests linux-shards --shards 4/.test(step.run || '')));
  assert.deepEqual(windows.jobs.tests.strategy.matrix.shard, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(windows.jobs.tests.strategy['fail-fast'], false);
  assert.match(suite(windows.jobs.tests).run, /node scripts\/ci-tests\.mjs --shard \$\{\{ matrix.shard \}\} --shards 12/);
  assert.deepEqual(windows.jobs.windows.needs, ['scope', 'tests']);
  assert.match(windows.jobs.windows.if, /^always\(\) && /);
  assert.match(windows.jobs.windows.if, /needs\.scope\.result != 'success'/, 'a broken scope job must not skip Windows');
  for (const file of ['deterministic-delivery', 'insight-compound', 'domain-commands', 'windows-authority', 'ci-workflows']) {
    assert.ok(fs.existsSync(new URL(`packages/ae/test/${file}.test.mjs`, root)), file);
  }
});

test('both full suites preserve installed-delivery transcripts and captured output after failure', () => {
  for (const [name, key, log] of [['harness-tests', 'suites', 'harness-tests.log'], ['harness-windows', 'tests', 'windows-tests.log']]) {
    const job = workflow(name).jobs[key];
    assert.equal(suite(job).env.HARNESS_PROOF_LOG, '${{ github.workspace }}/delivery-transcripts.jsonl');
    assert.match(suite(job).run, new RegExp(log.replaceAll('.', '\\.')));
    assert.equal(upload(job).if, 'always()');
    assert.ok(upload(job).with.path.includes(log));
    assert.ok(upload(job).with.path.includes('delivery-transcripts.jsonl'));
  }
});

test('Linux log capture preserves the real suite exit code', { skip: process.platform === 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-ci-pipeline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const node = path.join(directory, 'node');
  const command = suite(workflow('harness-tests').jobs.suites);
  assert.equal(command.shell, 'bash');
  for (const code of [0, 7]) {
    fs.writeFileSync(node, `#!/bin/sh\nprintf 'suite-marker\\n'\nexit ${code}\n`, { mode: 0o755 });
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', command.run.replaceAll('${{ matrix.shard }}', '1')], {
      cwd: directory, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, code, result.stdout + result.stderr);
    assert.match(fs.readFileSync(path.join(directory, 'harness-tests.log'), 'utf8'), /suite-marker/);
  }
});

test('Windows consolidation retains the native probes and the final fail-closed gate', () => {
  const windows = workflow('harness-windows');
  const job = windows.jobs.windows;
  assert.match(suite(windows.jobs.tests).run, /Tee-Object -FilePath windows-tests\.log/);
  assert.match(suite(windows.jobs.tests).run, /exit \$LASTEXITCODE/);
  assert.equal(suite(windows.jobs.tests)['continue-on-error'], undefined);
  for (const name of ['CLI scenarios', 'Redaction on Windows', 'Runner cancellation terminates the owned process', 'Environment fingerprint']) {
    assert.ok(job.steps.some(step => step.name === name), name);
  }
  const gate = job.steps.at(-1);
  assert.equal(gate.name, 'Windows probe gate');
  assert.equal(gate.if, 'always()');
  assert.equal(gate.env.SUITE_OUTCOME, "${{ needs.scope.outputs.full == 'true' && needs.tests.result || steps.subset.outcome }}");
  assert.equal(gate.env.SUITE_SCOPE, "${{ needs.scope.outputs.full == 'true' && 'full' || 'subset' }}");
  assert.equal(gate.env.INVENTORY_OUTCOME, '${{ steps.inventory.outcome }}');
  assert.equal(gate.env.REDACTION_RESULT, '${{ steps.redaction.outputs.result }}');
  assert.equal(gate.env.CANCELLATION_RESULT, '${{ steps.cancellation.outputs.result }}');
  assert.ok(upload(windows.jobs.tests).with.path.includes('.harness/diagnostics/windows-parent-full/'));
  assert.ok(upload(windows.jobs.tests).with.path.includes('ci-test-results/'));
  assert.ok(job.steps.some(step => step.id === 'inventory' && /--verify-manifests windows-shards --shards 12/.test(step.run)));
});

test('native Windows log capture preserves the real suite exit code', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-ci-pipeline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const command = suite(workflow('harness-windows').jobs.tests).run.trim().split('\n').slice(-2).join('\n');
  const probe = command.replace('node scripts/ci-tests.mjs --shard ${{ matrix.shard }} --shards 12',
    '& $env:AE_CI_TEST_NODE -e \'console.log("suite-marker"); process.exit(Number(process.env.AE_CI_TEST_EXIT));\'');
  assert.notEqual(probe, command);
  for (const code of [0, 7]) {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', probe], {
      cwd: directory, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, AE_CI_TEST_NODE: process.execPath, AE_CI_TEST_EXIT: String(code) },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, code, result.stdout + result.stderr);
    assert.match(fs.readFileSync(path.join(directory, 'windows-tests.log'), 'utf8'), /suite-marker/);
  }
});

test('documentation triggers cover every canonical build input and retain manual publishing', () => {
  const docs = workflow('docs');
  const paths = docs.on.pull_request.paths;
  const builder = fs.readFileSync(new URL('scripts/build-docs.mjs', root), 'utf8');
  const inputs = [...builder.matchAll(/\['([^']+\.md)',/g)].map(match => match[1]);
  assert.ok(inputs.length >= 3);
  for (const input of [...inputs, 'docs/site/**', 'scripts/build-docs.mjs', '.github/workflows/docs.yml']) {
    assert.ok(paths.includes(input), input);
  }
  assert.equal(docs.on.workflow_dispatch.inputs.publish.default, false);
  assert.equal(docs.jobs.deploy.if, "github.event_name == 'workflow_dispatch' && inputs.publish");
});

test('package qualification filters its inputs, cancels stale runs and keeps both exact archive installs', () => {
  const candidate = workflow('package-candidate');
  for (const input of ['packages/ae/**', '.github/workflows/package-candidate.yml', '.npmrc', 'LICENSE*']) {
    assert.ok(candidate.on.pull_request.paths.includes(input), input);
  }
  assert.ok(Object.hasOwn(candidate.on, 'workflow_dispatch'));
  assert.equal(candidate.concurrency['cancel-in-progress'], true);
  assert.match(candidate.concurrency.group, /github\.workflow/);
  assert.match(candidate.concurrency.group, /github\.ref/);
  const job = candidate.jobs.archive;
  assert.deepEqual(job.strategy.matrix.os, ['ubuntu-latest', 'windows-latest']);
  assert.equal(job.strategy.matrix.node, `\${{ fromJSON(github.event_name == 'pull_request' && '["24"]' || '["20", "24"]') }}`, 'PRs install on Node 24; manual qualification adds Node 20');
  const runtime = job.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
  assert.equal(runtime.with['node-version'], '${{ matrix.node }}');
  const release = job.steps.find(step => step.name === 'Validate release contracts');
  assert.match(release.run, /npm run --prefix packages\/ae check:release/);
  assert.match(release.run, /npm run --prefix packages\/ae check:repo/);
  const pack = job.steps.find(step => step.name === 'Pack and identify candidate');
  assert.doesNotMatch(pack.run, /--ignore-scripts/);
  const install = job.steps.find(step => step.name === 'Install the exact archive and drive its runtime');
  assert.match(install.run, /--offline/);
  assert.match(install.run, /artifacts\/\$AE_ARCHIVE/);
  assert.match(install.run, /\.ae-bin\/bin\/ae\.mjs/);
  const delivery = job.steps.find(step => step.name === 'Prove installed delivery lifecycle');
  assert.match(delivery.run, /--test-name-pattern=.*installed package proves behavior/);
  assert.equal(delivery.env.AE_TEST_ARCHIVE, '${{ github.workspace }}/artifacts/${{ env.AE_ARCHIVE }}');
  assert.match(delivery.env.HARNESS_PROOF_LOG, /artifacts\/delivery-transcripts\.jsonl$/);
  assert.equal(upload(job).if, 'always()');
  assert.match(upload(job).with.name, /matrix\.node/);
  assert.equal(job.steps.some(step => step.name === 'Validate Git integration regressions'), false, 'archive feedback must not wait for unrelated source suites');
  const git = candidate.jobs['git-regressions'];
  assert.equal(git.if, "github.event_name != 'pull_request'", 'Git regressions repeat full-suite files on PRs; they run on manual qualification');
  assert.equal(git.strategy['fail-fast'], false);
  const expected = [];
  for (const os of ['ubuntu-latest', 'windows-latest']) for (const node of ['20', '24']) {
    for (let shard = 1; shard <= (os === 'windows-latest' ? 3 : 1); shard++) expected.push({ os, node, shard, shards: os === 'windows-latest' ? 3 : 1 });
  }
  assert.deepEqual(git.strategy.matrix.include, expected);
  assert.match(git.steps.find(step => step.name === 'Validate Git integration regressions').run, /--suite git.*--shard.*matrix\.shard.*--shards.*matrix\.shards/);
  assert.equal(upload(git).if, 'always()');
  const gate = candidate.jobs.package;
  assert.deepEqual(gate.needs, ['archive', 'git-regressions']);
  assert.equal(gate.if, 'always()');
  assert.equal(gate.name, 'package (${{ matrix.os }}, ${{ matrix.node }})');
  assert.ok(gate.steps.some(step => /--verify-manifests git-shards.*--suite git/.test(step.run || '')));
  const result = gate.steps.find(step => step.name === 'Require archive and Git regression success');
  assert.equal(result.env.ARCHIVE_RESULT, '${{ needs.archive.result }}');
  assert.equal(result.env.GIT_RESULT, "${{ github.event_name == 'pull_request' && 'success' || needs['git-regressions'].result }}");
  for (const step of gate.steps.filter(item => item.uses?.startsWith('actions/download-artifact@') || item.name === 'Require complete same-revision Git inventory')) {
    assert.equal(step.if, "github.event_name != 'pull_request'");
  }
  assert.match(result.run, /success/);
});

test('stable Linux and package gates refuse failed, cancelled, skipped or absent dependencies', () => {
  const linux = workflow('harness-tests').jobs.test.steps.find(step => step.name === 'Require every shard job to succeed');
  const candidate = workflow('package-candidate').jobs.package.steps.find(step => step.name === 'Require archive and Git regression success');
  for (const [step, fields] of [[linux, ['SUITES_RESULT']], [candidate, ['ARCHIVE_RESULT', 'GIT_RESULT']]]) {
    assert.equal(step.if, 'always()');
    const code = /^node --input-type=module -e "([^"]+)"$/.exec(step.run.trim())?.[1];
    assert.ok(code, step.run);
    for (const field of fields) for (const status of ['success', 'failure', 'cancelled', 'skipped', undefined]) {
      let exitCode = 0;
      const env = Object.fromEntries(fields.map(name => [name, name === field ? status : 'success']));
      vm.runInNewContext(code, { process: { env, exit(value) { exitCode = value; } } });
      assert.equal(exitCode, status === 'success' ? 0 : 1, `${field}: ${status}`);
    }
  }
});

test('the complete Windows suite runs only on schedule or dispatch; pull requests get one subset job', () => {
  const windows = workflow('harness-windows');
  assert.equal(windows.jobs.tests.needs, 'scope');
  assert.equal(windows.jobs.tests.if, "needs.scope.outputs.full == 'true'");
  assert.equal(windows.jobs.scope['runs-on'], 'ubuntu-latest');
  const job = windows.jobs.windows;
  const subset = job.env.WINDOWS_SUBSET.trim().split(/\s+/);
  assert.ok(subset.length >= 20, 'the pull-request subset must stay meaningful');
  assert.equal(new Set(subset).size, subset.length);
  for (const file of subset) assert.ok(fs.existsSync(new URL(`packages/ae/test/${file}`, root)), file);
  for (const file of ['hook-runtime.test.mjs', 'host-native-hooks.test.mjs', 'cli-vscode-hooks.test.mjs', 'runner.test.mjs', 'paths.test.mjs', 'redact.test.mjs', 'windows-authority.test.mjs', 'windows-workflow.test.mjs', 'ci-workflows.test.mjs']) {
    assert.ok(subset.includes(file), file);
  }
  const step = job.steps.find(item => item.id === 'subset');
  assert.equal(step.if, "env.FULL_SUITE != 'true'");
  assert.match(step.run, /--test-concurrency=2 @files/);
  assert.match(step.run, /exit \$code/);
  assert.ok(upload(job).with.path.includes('windows-subset.log'));
});

test('Windows scope skips unrelated pull requests and runs the full suite only on demand or after relevant changes', { skip: process.platform === 'win32' }, t => {
  const decide = workflow('harness-windows').jobs.scope.steps.find(step => step.id === 'decide');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-ci-scope-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.email=ci@example.com', '-c', 'user.name=ci', ...args], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  const run = event => {
    const output = path.join(directory, '..', `${path.basename(directory)}-out`);
    const summary = `${output}-summary`;
    fs.writeFileSync(output, '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', decide.run], {
      cwd: directory, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, EVENT: event, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const values = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')));
    fs.rmSync(output, { force: true });
    fs.rmSync(summary, { force: true });
    return values;
  };
  // Model the pull_request merge commit: HEAD^1 is the base tip.
  const commit = (file, message) => {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), message);
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };
  git('init', '-q');
  commit('README.md', 'base');
  commit('docs/guide.md', 'docs only');
  assert.deepEqual(run('pull_request'), { run: 'false', full: 'false' });
  commit('packages/ae/lib/hooks.mjs', 'hook change');
  assert.deepEqual(run('pull_request'), { run: 'true', full: 'false' });
  commit('.github/workflows/harness-windows.yml', 'workflow change');
  assert.deepEqual(run('pull_request'), { run: 'true', full: 'false' });
  assert.deepEqual(run('workflow_dispatch'), { run: 'true', full: 'true' });
  assert.deepEqual(run('schedule'), { run: 'true', full: 'true' });
});
