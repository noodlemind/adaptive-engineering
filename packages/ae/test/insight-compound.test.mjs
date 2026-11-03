import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { collectEpisodes } from '../lib/knowledge/consolidate.mjs';
import { runInsightCompound } from '../lib/compound.mjs';
import { projectStoreDir } from '../lib/project-layout.mjs';
import { trackWorkspaceSolutions } from './helpers/workspace.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'ae.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

for (const competingOperation of ['capture', 'index']) {
  test(`capture and ${competingOperation} publish shared retrieval state in order`, async t => {
    const dir = tempDir('insight-index-order-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const workspace = path.join(dir, 'product'), copilotHome = path.join(dir, 'copilot'), home = path.join(dir, 'harness');
    fs.mkdirSync(workspace);
    const worker = path.join(dir, 'worker.mjs');
    fs.writeFileSync(worker, `
import fs from 'node:fs';
import path from 'node:path';
import { runInsightCompound } from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'lib/compound.mjs')).href)};
import { runIndexKnowledge } from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'lib/index-knowledge.mjs')).href)};
const [dir, name, operation] = process.argv.slice(2);
const workspace = path.join(dir, 'product'), copilotHome = path.join(dir, 'copilot'), home = path.join(dir, 'harness');
const rename = fs.renameSync;
fs.renameSync = (source, destination) => {
  if (path.basename(destination) === 'manifest.yaml') {
    if (name === 'first') {
      fs.writeFileSync(path.join(dir, 'held'), '');
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(path.join(dir, 'release'))) {
        if (Date.now() > deadline) throw new Error('Publication barrier timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    fs.appendFileSync(path.join(dir, 'publications'), name + '\\n');
  }
  return rename(source, destination);
};
fs.writeFileSync(path.join(dir, name + '-started'), '');
const options = { workspace, copilotHome, home, flags: { title: name, body: name + ' complete lesson' }, log: () => {} };
const result = operation === 'index' ? runIndexKnowledge(options) : runInsightCompound(options);
if (result.pass === false) throw new Error(result.blockedReason);
`);
    const children = [];
    const launch = (name, operation) => {
      const child = spawn(process.execPath, [worker, dir, name, operation]);
      children.push(child);
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      return new Promise(resolve => child.on('close', status => resolve({ status, stderr })));
    };
    t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill(); }));
    const waitFor = async name => {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(path.join(dir, name))) {
        assert.ok(Date.now() < deadline, `worker must reach ${name}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    const first = launch('first', 'capture');
    await waitFor('held');
    const second = launch('second', competingOperation);
    await waitFor('second-started');
    await Promise.race([second, new Promise(resolve => setTimeout(resolve, 1000))]);
    fs.writeFileSync(path.join(dir, 'release'), '');
    for (const result of await Promise.all([first, second])) assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'publications'), 'utf8').trim().split('\n'), ['first', 'second']);
    const manifest = fs.readFileSync(path.join(copilotHome, 'knowledge/manifest.yaml'), 'utf8');
    assert.equal((manifest.match(/  - id:/g) || []).length, competingOperation === 'capture' ? 2 : 1);
  });
}

test('interrupted episode content write leaves no final file and the same operation recovers', t => {
  const ws = tempDir('episode-interrupt-ws-'), copilotHome = tempDir('episode-interrupt-cp-'), home = tempDir('episode-interrupt-hh-');
  t.after(() => [ws, copilotHome, home].forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
  const args = { workspace: ws, copilotHome, home, kind: 'insight', flags: { title: 'Interrupted content', body: 'One complete published lesson.', operationSuffix: 'same-operation', captureDate: '2026-10-07' } };
  const original = fs.writeFileSync;
  let interrupted = false;
  fs.writeFileSync = (file, data, ...rest) => {
    if (!interrupted && typeof file === 'number' && typeof data === 'string' && data.includes('One complete published lesson.')) {
      interrupted = true;
      original(file, data.slice(0, 25), ...rest);
      throw new Error('Injected interruption during episode bytes');
    }
    return original(file, data, ...rest);
  };
  let failed;
  try { failed = runInsightCompound(args); } finally { fs.writeFileSync = original; }
  assert.equal(interrupted, true);
  assert.equal(failed.pass, false);
  const dir = path.join(projectStoreDir(ws, { home }), 'docs/solutions/insights');
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.md')), []);
  const recovered = runInsightCompound(args);
  assert.equal(recovered.pass, true, recovered.blockedReason);
  assert.equal(runInsightCompound(args).path, recovered.path);
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.md')).length, 1);
});
function keepSolutionsInWorkspace(ws) {
  return trackWorkspaceSolutions(ws);
}
function cliHarnessHome(args, env) {
  if (env.HARNESS_HOME) return env.HARNESS_HOME;
  const index = args.indexOf('--copilot-home');
  return index >= 0 ? path.join(args[index + 1], 'hh') : undefined;
}
function cliEpisode(ws, copilotHome, rel) {
  return path.join(projectStoreDir(ws, { home: path.join(copilotHome, 'hh') }), rel);
}
const run = (args, env = {}) => {
  const harnessHome = cliHarnessHome(args, env);
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(harnessHome ? { HARNESS_HOME: harnessHome } : {}), ...env },
  });
};
const runAsync = (args, env = {}, { timeoutMs = 0 } = {}) =>
  new Promise((resolve) => {
    const harnessHome = cliHarnessHome(args, env);
    const child = spawn(process.execPath, [binPath, ...args], {
      env: { ...process.env, ...(harnessHome ? { HARNESS_HOME: harnessHome } : {}), ...env },
      timeout: timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });

function captureAcquisitionBusy(result) {
  if (result.status !== 2) return false;
  try {
    const error = JSON.parse(result.stderr.trim()).error;
    return error?.code === 'E_USAGE' && error.message === 'plan-update: plan is locked by another update';
  } catch { return false; }
}

test('compound --insight writes a kind: insight doc without any plan or evidence', () => {
  const ws = keepSolutionsInWorkspace(tempDir('insight-ws-'));
  const home = tempDir('insight-home-');
  const res = run([
    'compound', '--insight', '--title', 'Orders pool exhaustion under bulk load',
    '--category', 'debugging', '--tags', 'orders,timeout',
    '--body', 'Connection pool exhausts under N+1 on /orders/bulk. Suspect missing batch fetch.',
    '--workspace', ws, '--copilot-home', home, '--json',
  ]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.kind, 'insight');
  assert.match(out.path, /^docs\/solutions\/debugging\/\d{4}-\d{2}-\d{2}-orders-pool-exhaustion/);
  const doc = fs.readFileSync(cliEpisode(ws, home, out.path), 'utf8');
  assert.match(doc, /kind: insight/);
  assert.match(doc, /title: "Orders pool exhaustion under bulk load"/);
  assert.match(doc, /Connection pool exhausts/);
});

test('runInsightCompound rolls back the just-written episode (no orphan) and reports a clean recoverable failure when indexing throws', () => {
  const ws = keepSolutionsInWorkspace(tempDir('insight-idxfail-ws-'));
  const copilotHome = tempDir('insight-idxfail-ch-');
  const home = tempDir('insight-idxfail-hh-');
    fs.mkdirSync(path.join(copilotHome, 'knowledge', 'manifest.yaml'), { recursive: true });

  const res = runInsightCompound({
    workspace: ws,
    copilotHome,
    home,
    kind: 'insight',
    flags: { title: 'Index throw rollback', body: 'This episode must not orphan when indexing throws.' },
  });

  assert.equal(res.pass, false);
  assert.equal(res.exitCode, 1);
  assert.match(res.blockedReason, /index/i);
  const insightsDir = path.join(projectStoreDir(ws, { home }), 'docs', 'solutions', 'insights');
  const md = fs.existsSync(insightsDir) ? fs.readdirSync(insightsDir).filter((f) => f.endsWith('.md')) : [];
  assert.deepEqual(md, [], 'the just-written episode must be deleted after an index-failure rollback');
});

test('P2: runInsightCompound reports PARTIAL recovery (not a false clean rollback) when the episode cannot be removed on rollback', () => {
  const ws = keepSolutionsInWorkspace(tempDir('insight-partial-ws-'));
  const copilotHome = tempDir('insight-partial-ch-');
  const home = tempDir('insight-partial-hh-');
  // Force runIndexKnowledge to throw (manifest path is a directory → EISDIR).
  fs.mkdirSync(path.join(copilotHome, 'knowledge', 'manifest.yaml'), { recursive: true });

    const insightsMarker = path.join('docs', 'solutions', 'insights');
  const origRm = fs.rmSync;
  fs.rmSync = (p, opts) => {
    if (String(p).includes(insightsMarker)) return; // pretend the delete failed
    return origRm(p, opts);
  };
  let res;
  try {
    res = runInsightCompound({
      workspace: ws,
      copilotHome,
      home,
      kind: 'insight',
      flags: { title: 'Partial rollback', body: 'This episode cannot be removed on rollback.' },
    });
  } finally {
    fs.rmSync = origRm;
  }

  assert.equal(res.pass, false);
  assert.equal(res.exitCode, 1);
  assert.match(res.blockedReason, /rollback incomplete/i, 'a partial rollback must not be reported as a clean one');
  assert.match(res.blockedReason, /still on disk/i);
  assert.ok(res.partialRecovery, 'partial-recovery details are attached');
  assert.equal(res.partialRecovery.episodeRemains, true);

  // The orphaned episode really is still there — proving the report is honest.
  const insightsDir = path.join(projectStoreDir(ws, { home }), 'docs', 'solutions', 'insights');
  const md = fs.existsSync(insightsDir) ? fs.readdirSync(insightsDir).filter((f) => f.endsWith('.md')) : [];
  assert.equal(md.length, 1, 'the episode the rollback could not remove is still on disk (honest partial)');
});

test('runInsightCompound --dry-run logs "would write" (never "wrote") and creates no file', () => {
  const ws = keepSolutionsInWorkspace(tempDir('insight-dry-ws-'));
  const copilotHome = tempDir('insight-dry-ch-');
  const home = tempDir('insight-dry-hh-');
  const logs = [];
  const res = runInsightCompound({
    workspace: ws,
    copilotHome,
    home,
    kind: 'insight',
    flags: { title: 'Dry run wording', body: 'Body text', dryRun: true },
    log: (m) => logs.push(m),
  });
  assert.equal(res.pass, true);
    const toPosix = (p) => p.split(path.sep).join('/');
  const episodeLog = logs.find((m) => toPosix(m).includes(res.path));
  assert.ok(episodeLog, 'an episode-path log line is emitted under dry-run');
  assert.match(episodeLog, /would write/);
  assert.doesNotMatch(episodeLog, /^wrote /);
  assert.equal(fs.existsSync(cliEpisode(ws, copilotHome, res.path)), false, 'dry-run must not write the episode file');
});

test('compound --insight refuses to write when the body contains a secret', () => {
  const ws = tempDir('insight-sec-');
  const res = run([
    'compound', '--insight', '--title', 'leak', '--body', 'key=AKIAIOSFODNN7EXAMPLE',
    '--workspace', ws, '--copilot-home', tempDir('insight-sech-'), '--json',
  ]);
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /secret/i);
  assert.ok(!fs.existsSync(path.join(ws, 'docs', 'solutions')));
});

test('compound --insight requires --title and body', () => {
  const res = run([
    'compound', '--insight', '--workspace', tempDir('insight-req-'),
    '--copilot-home', tempDir('insight-reqh-'), '--json',
  ]);
  assert.notEqual(res.status, 0);
  assert.match(res.stdout + res.stderr, /--title/);
});

test('compound --insight reads body from --body-file and indexes the doc', () => {
  const ws = keepSolutionsInWorkspace(tempDir('insight-bf-'));
  const home = tempDir('insight-bfh-');
  const bodyFile = path.join(ws, 'note.md');
  fs.writeFileSync(bodyFile, 'Retry storms amplify 429s when jitter is missing.\n');
  const res = run([
    'compound', '--insight', '--title', 'Retry storms need jitter',
    '--body-file', bodyFile, '--workspace', ws, '--copilot-home', home, '--json',
  ]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.kind, 'insight');
  assert.ok(out.indexed.entries >= 1);
  const manifest = fs.readFileSync(path.join(home, 'knowledge', 'manifest.yaml'), 'utf8');
  assert.match(manifest, /retry-storms-need-jitter/);
});

test('P1#1: N concurrent same-title captures never overwrite — N distinct files and N distinct reported paths', async t => {
  const root = tempDir('insight-race-');
  const ws = keepSolutionsInWorkspace(path.join(root, 'product'));
  const home = path.join(root, 'copilot'); fs.mkdirSync(home);
  const N = 16;
  // Other cases exercise CLI parsing. Here all sixteen independent processes
  // finish module loading before entering the actual writer together, so the
  // publication budget measures contention rather than CLI cold starts.
  const worker = path.join(root, 'capture-worker.mjs');
  fs.writeFileSync(worker, `
import { runInsightCompound } from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'lib/compound.mjs')).href)};
const index = Number(process.argv[2]);
process.once('message', () => {
  const started = Date.now(), deadline = started + 30000;
  let attempts = 0;
  try {
    while (attempts < 4 && Date.now() < deadline) {
      attempts++;
      try {
        const result = runInsightCompound({ workspace: ${JSON.stringify(ws)}, copilotHome: ${JSON.stringify(home)}, home: ${JSON.stringify(path.join(home, 'hh'))},
          flags: { title: 'Concurrent duplicate lesson', body: 'Racing observation from writer ' + index + '.' }, log: () => {} });
        process.stdout.write(JSON.stringify({ ...result, worker: index, attempts, elapsedMs: Date.now() - started }) + '\\n');
        process.exitCode = result.pass ? 0 : 1;
        return;
      } catch (error) {
        // Only this acquisition refusal precedes publication. Never retry an
        // error that could follow a write and duplicate an anonymous capture.
        if (error.code !== 'E_USAGE' || error.message !== 'plan-update: plan is locked by another update') throw error;
        if (attempts === 4) throw error;
      }
    }
    throw new Error('Capture publication deadline expired');
  } catch (error) {
    process.stderr.write(JSON.stringify({ worker: index, attempts, elapsedMs: Date.now() - started, code: error.code, message: error.message }) + '\\n');
    process.exitCode = 1;
  } finally { process.disconnect(); }
});
process.send({ ready: true, worker: index });
`);
  const workers = [];
  t.after(async () => {
    for (const { child } of workers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(workers.map(value => value.done));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const launch = index => {
    const started = Date.now(), child = spawn(process.execPath, [worker, String(index)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stdout = '', stderr = '', startupTimedOut = false, publicationTimedOut = false, publicationTimer, ready = false, spawnError;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { spawnError = error.message; });
    const startupTimer = setTimeout(() => { startupTimedOut = true; child.kill('SIGKILL'); }, 30000);
    let readyResolve, readyReject;
    const loaded = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    child.once('message', message => {
      if (message?.ready === true && message.worker === index) { ready = true; clearTimeout(startupTimer); readyResolve(); }
    });
    const done = new Promise(resolve => child.once('close', (status, signal) => {
      clearTimeout(startupTimer); clearTimeout(publicationTimer);
      const result = { status, signal, stdout, stderr, worker: index, elapsedMs: Date.now() - started, startupTimedOut, publicationTimedOut, spawnError, root };
      if (!ready) readyReject(new Error(`Capture worker did not reach its start barrier: ${JSON.stringify(result)}`));
      resolve(result);
    }));
    const value = { child, loaded, done, start() {
      publicationTimer = setTimeout(() => { publicationTimedOut = true; child.kill('SIGKILL'); }, 30000);
      child.send('capture');
    } };
    workers.push(value); return value;
  };
  const captures = Array.from({ length: N }, (_, index) => launch(index));
  await Promise.all(captures.map(value => value.loaded));
  for (const value of captures) value.start();
  const results = await Promise.all(captures.map(value => value.done));
  for (const result of results) assert.equal(result.status, 0, JSON.stringify(result));

  const reported = results.map((r) => JSON.parse(r.stdout).path);
  assert.equal(new Set(reported).size, N, `every process must report a DISTINCT path (got ${new Set(reported).size}/${N})`);
  for (const [index, p] of reported.entries()) {
    const full = cliEpisode(ws, home, p);
    assert.ok(fs.existsSync(full), `reported path ${p} must exist on disk`);
    assert.match(fs.readFileSync(full, 'utf8'), new RegExp(`Racing observation from writer ${index}\\.`), `writer ${index} must retain its own content`);
  }

  const dir = path.join(projectStoreDir(ws, { home: path.join(home, 'hh') }), 'docs', 'solutions', 'insights');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, N, `all ${N} episode files must survive — no silent overwrite (got ${files.length})`);
});

test('capture acquisition refusal publishes nothing and one retry after release publishes one episode', async t => {
  const dir = tempDir('insight-busy-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ws = keepSolutionsInWorkspace(path.join(dir, 'product')), home = path.join(dir, 'copilot');
  const knowledge = path.join(home, 'knowledge'); fs.mkdirSync(knowledge, { recursive: true });
  const held = path.join(dir, 'held'), release = path.join(dir, 'release');
  const script = `import fs from 'node:fs';import {withPlanUpdateLock} from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'lib/plan-update.mjs')).href)};
withPlanUpdateLock(${JSON.stringify(path.join(knowledge, 'manifest.yaml'))},()=>{fs.writeFileSync(${JSON.stringify(held)},'');const deadline=Date.now()+20000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>deadline)throw Error('release timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}});`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', script], { timeout: 30000 });
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  let holderError = '';
  holder.stderr.on('data', chunk => holderError += chunk);
  const finished = new Promise(resolve => holder.on('close', status => resolve(status)));
  const started = Date.now();
  while (!fs.existsSync(held)) {
    assert.ok(Date.now() - started < 10000, 'holder must acquire the real publication lock');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const args = ['compound', '--insight', '--title', 'Busy capture', '--body', 'One observation.', '--workspace', ws, '--copilot-home', home, '--json'];
  const episodes = path.join(projectStoreDir(ws, { home: path.join(home, 'hh') }), 'docs/solutions/insights');
  let refused, filesBeforeRelease;
  try {
    refused = await runAsync(args, {}, { timeoutMs: 15000 });
    filesBeforeRelease = fs.existsSync(episodes) ? fs.readdirSync(episodes).filter(file => file.endsWith('.md')) : [];
  } finally { fs.writeFileSync(release, ''); }
  assert.equal(await finished, 0, holderError);
  assert.equal(captureAcquisitionBusy(refused), true, refused.stderr || refused.stdout);
  assert.deepEqual(filesBeforeRelease, []);
  const retried = await runAsync(args, {}, { timeoutMs: 15000 });
  assert.equal(retried.status, 0, retried.stderr || retried.stdout);
  const result = JSON.parse(retried.stdout);
  assert.deepEqual(fs.readdirSync(episodes).filter(file => file.endsWith('.md')), [path.basename(result.path)]);
  assert.match(fs.readFileSync(cliEpisode(ws, home, result.path), 'utf8'), /One observation\./);
});

test('P1#1: a pre-existing file at the chosen suffix forces the next suffix (exclusive-create, never overwrite)', () => {
  const ws = keepSolutionsInWorkspace(tempDir('insight-excl-ws-'));
  const home = tempDir('insight-excl-home-');
  const args = ['compound', '--insight', '--title', 'Exclusive suffix lesson', '--body', 'One.', '--workspace', ws, '--copilot-home', home, '--json'];

  const first = JSON.parse(run(args).stdout);
  assert.match(first.path, /-exclusive-suffix-lesson\.md$/, 'first capture takes the bare base name');
  const firstBody = fs.readFileSync(cliEpisode(ws, home, first.path), 'utf8');

  // Pre-plant a file exactly where the SECOND capture would land (`-2.md`).
  const planted = first.path.replace(/\.md$/, '-2.md');
  fs.mkdirSync(path.dirname(cliEpisode(ws, home, planted)), { recursive: true });
  fs.writeFileSync(cliEpisode(ws, home, planted), 'PRE-EXISTING — must never be overwritten\n');

  const second = JSON.parse(run(args).stdout);
  assert.equal(second.path, first.path.replace(/\.md$/, '-3.md'), 'the occupied -2 suffix is skipped for -3');
  assert.notEqual(second.path, planted);
  assert.equal(fs.readFileSync(cliEpisode(ws, home, planted), 'utf8'), 'PRE-EXISTING — must never be overwritten\n', 'the planted file is untouched');
  assert.equal(fs.readFileSync(cliEpisode(ws, home, first.path), 'utf8'), firstBody, 'the first capture is untouched');
});

test('same-day same-title insights never overwrite — deterministic suffix', () => {
  const ws = keepSolutionsInWorkspace(tempDir('insight-dup-'));
  const home = tempDir('insight-duph-');
  const args = [
    'compound', '--insight', '--title', 'Duplicate lesson', '--body', 'First observation.',
    '--workspace', ws, '--copilot-home', home, '--json',
  ];
  const first = JSON.parse(run(args).stdout);
  const second = JSON.parse(run(args).stdout);
  assert.notEqual(first.path, second.path);
  assert.match(second.path, /-2\.md$/);
  assert.ok(fs.existsSync(cliEpisode(ws, home, first.path)));
  assert.ok(fs.existsSync(cliEpisode(ws, home, second.path)));
});

test('category input is confined to one safe path segment', () => {
  const ws = tempDir('insight-cat-');
  const harnessHome = tempDir('insight-cathh-');
  const res = run([
    'compound', '--insight', '--title', 'Escape attempt', '--body', 'body text',
    '--category', '../../outside', '--workspace', ws, '--copilot-home', tempDir('insight-cath-'), '--json',
  ], { HARNESS_HOME: harnessHome });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  assert.match(out.path, /^docs\/solutions\/outside\//);
  assert.ok(!fs.existsSync(path.join(path.dirname(ws), 'outside')));
});

test('an embedded newline in the title cannot break the line-oriented frontmatter', () => {
  const ws = keepSolutionsInWorkspace(tempDir('insight-nl-'));
  const home = tempDir('insight-nlh-');
  const res = run([
    'compound', '--insight', '--title', 'Title line one\nline two: fake-key',
    '--body', 'Body text.', '--workspace', ws, '--copilot-home', home, '--json',
  ]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  const doc = fs.readFileSync(cliEpisode(ws, home, out.path), 'utf8');

    const fmBlock = doc.match(/^---\n([\s\S]*?)\n---/)[1];
  const fmLines = fmBlock.split('\n');
  assert.ok(fmLines.length >= 3, 'title/kind/date (plus optional git provenance) present');
  assert.ok(fmLines.every((l) => /^[\w-]+:/.test(l)), 'every frontmatter line is still a key: value line');
  assert.equal(fmLines.filter((l) => /^fake-key:/.test(l)).length, 0, 'embedded newline must not inject a new key');
  assert.match(doc, /title: "Title line one\\nline two: fake-key"/);

    const episodes = collectEpisodes({ workspace: ws, copilotHome: home, home: path.join(home, 'hh') });
  const episode = episodes.find((e) => e.path === out.path);
  assert.ok(episode, 'episode discoverable after round-trip');
  assert.equal(episode.title, 'Title line one\\nline two: fake-key');
});

test('verified compound lane still requires a plan (unchanged)', () => {
  const ws = tempDir('insight-vl-');
  const res = run([
    'compound', '--workspace', ws, '--copilot-home', tempDir('insight-vlh-'), '--json',
  ]);
  assert.equal(res.status, 2);
  const out = JSON.parse(res.stdout);
  assert.match(out.blockedReason, /plan/i);
});
