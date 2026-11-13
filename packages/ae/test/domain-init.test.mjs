import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';
import { domainResultOf } from '../lib/domain-cmd.mjs';
import { readDomain, inspectDomain, logicalDomainContract, validateDomainConfig } from '../lib/domain-contract.mjs';
import { stripJsonc, markdownRepoTables, specRepos, idFrom } from '../lib/domain-init.mjs';

const REMOTE = 'https://example.invalid/pay/';

function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'domain-init-')));
  const previous = process.env.GIT_CONFIG_GLOBAL;
  const gitconfig = path.join(dir, 'gitconfig');
  const remotes = path.join(dir, 'remotes');
  fs.mkdirSync(remotes);
  // Clones of https://example.invalid/pay/<name>.git resolve to local bare
  // repositories, so the real `git clone` path runs without a network.
  fs.writeFileSync(gitconfig, `[user]\n\tname = Domain Init\n\temail = init@example.invalid\n[init]\n\tdefaultBranch = main\n[url "file://${remotes}/"]\n\tinsteadOf = ${REMOTE}\n[protocol "file"]\n\tallow = always\n`);
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });
  const git = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: gitconfig } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const remote = (name, files = { 'README.md': `# ${name}\n` }) => {
    const work = path.join(dir, 'seed', name);
    fs.mkdirSync(work, { recursive: true });
    git(work, ['init', '-q']);
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
      fs.writeFileSync(path.join(work, rel), body);
    }
    git(work, ['add', '.']);
    git(work, ['commit', '-qm', 'seed']);
    git(work, ['commit', '-q', '--allow-empty', '-m', 'second']);
    git(dir, ['clone', '-q', '--bare', work, path.join(remotes, `${name}.git`)]);
    return `${REMOTE}${name}.git`;
  };
  const checkout = (name, parent = path.join(dir, 'work')) => {
    fs.mkdirSync(parent, { recursive: true });
    git(parent, ['clone', '-q', `${REMOTE}${name}.git`, name]);
    return path.join(parent, name);
  };
  const home = path.join(dir, 'harness');
  const run = argv => domainResultOf([...argv, '--workspace', dir], { harnessHome: home });
  return { dir, home, git, remote, checkout, run };
}

test('init from a VS Code workspace file drafts, then --accept publishes, the checked-out repositories', t => {
  const f = fixture(t);
  f.remote('ledger');
  f.remote('gateway');
  const ledger = f.checkout('ledger');
  const gateway = f.checkout('gateway');
  const workspace = path.join(f.dir, 'work', 'payments.code-workspace');
  fs.writeFileSync(workspace, `{
    // the editor workspace, with comments and trailing commas
    "folders": [
      { "path": "ledger" },
      { "path": "./gateway", "name": "Gateway API" }, /* named */
    ],
    "settings": { "url": "http://not-a-comment//really" },
  }`);
  const draft = f.run(['init', '--name', 'payments', '--from-workspace', workspace]);
  assert.equal(draft.stage, 'draft');
  assert.deepEqual(draft.repos.map(r => [r.id, r.binding, r.clone]), [['ledger', ledger, null], ['gateway-api', gateway, null]]);
  assert.deepEqual(draft.clones, []);
  assert.ok(fs.existsSync(draft.draftPath));
  assert.equal(fs.existsSync(path.join(f.home, 'domains/payments.yaml')), false, 'a draft publishes nothing');

  const accepted = f.run(['init', '--name', 'payments', '--accept']);
  assert.equal(accepted.status, 'ok');
  assert.equal(fs.existsSync(draft.draftPath), false, 'an accepted draft is removed');
  const { config } = readDomain('payments', { home: f.home });
  assert.deepEqual(config.repos.map(r => r.id), ['gateway-api', 'ledger']);
  assert.equal(config.bindings.repos.ledger, ledger);
  assert.equal(inspectDomain(readDomain('payments', { home: f.home })).repos.every(r => r.status === 'available'), true);
});

test('init from a spec repository clones missing repositories at a shallow head and records assets and a reference spec source', t => {
  const f = fixture(t);
  f.remote('ledger');
  f.remote('notify');
  f.remote('infra');
  f.remote('payments-spec', {
    'ae-domain.yaml': YAML.stringify({ repos: [
      { url: `${REMOTE}ledger.git`, asset: 'core', role: 'service' },
      { url: `${REMOTE}infra.git`, asset: 'core', role: 'infra' },
      { url: `${REMOTE}notify.git`, id: 'notifications', asset: 'messaging' },
    ] }),
  });
  const spec = f.checkout('payments-spec');
  const ledger = f.checkout('ledger');
  const cloneRoot = path.join(f.dir, 'clones');
  const draft = f.run(['init', '--name', 'payments', '--from-spec', spec, '--clone-root', cloneRoot]);
  assert.deepEqual(draft.inputs.find(i => i.kind === 'spec').manifests, ['ae-domain.yaml']);
  assert.deepEqual(draft.clones.map(c => c.repo).sort(), ['infra', 'ledger', 'notifications']);
  assert.equal(draft.repos.find(r => r.id === 'ledger').clone, path.join(cloneRoot, 'ledger'));

  // Bind ledger to the existing checkout instead of cloning it again.
  const doc = YAML.parse(fs.readFileSync(draft.draftPath, 'utf8'));
  doc.clones = doc.clones.filter(c => c.repo !== 'ledger');
  doc.config.bindings.repos.ledger = ledger;
  fs.writeFileSync(draft.draftPath, YAML.stringify(doc));

  const accepted = f.run(['init', '--name', 'payments', '--accept']);
  assert.equal(accepted.status, 'ok', JSON.stringify(accepted.failed));
  assert.deepEqual(accepted.cloned.map(c => c.repo).sort(), ['infra', 'notifications']);
  for (const id of ['infra', 'notifications']) {
    assert.equal(f.git(path.join(cloneRoot, id), ['rev-parse', '--is-shallow-repository']), 'true', `${id} is a shallow clone`);
  }
  const { config } = readDomain('payments', { home: f.home });
  assert.deepEqual(config.assets, [
    { id: 'core', components: [{ id: 'ledger', repo: 'ledger', role: 'service' }, { id: 'infra', repo: 'infra', role: 'infra' }] },
    { id: 'messaging', components: [{ id: 'notifications', repo: 'notifications' }] },
  ]);
  assert.deepEqual(config.spec_sources, [{ source: 'payments-spec', scope: 'domain', include: [], authority: 'reference' }]);
  assert.equal(config.bindings.sources['payments-spec'], spec);
  const shown = inspectDomain(readDomain('payments', { home: f.home }));
  assert.deepEqual(shown.specSources.map(s => s.authority), ['reference']);
});

test('a failed clone publishes the rest and keeps the failed repository in the draft for a retry', t => {
  const f = fixture(t);
  f.remote('ledger');
  const cloneRoot = path.join(f.dir, 'clones');
  f.run(['init', '--name', 'payments', '--repo', `ledger=${REMOTE}ledger.git`, '--repo', `ghost=${REMOTE}ghost.git`, '--clone-root', cloneRoot]);
  const accepted = f.run(['init', '--name', 'payments', '--accept']);
  assert.equal(accepted.status, 'partial');
  assert.deepEqual(accepted.failed.map(x => x.repo), ['ghost']);
  assert.deepEqual(accepted.unbound, ['ghost']);
  assert.deepEqual(readDomain('payments', { home: f.home }).config.repos.map(r => r.id), ['ledger']);
  const rest = YAML.parse(fs.readFileSync(accepted.draftPath, 'utf8'));
  assert.deepEqual(rest.clones.map(c => c.repo), ['ghost']);
  assert.equal(fs.existsSync(path.join(cloneRoot, 'ghost')), false, 'a failed clone leaves no empty directory');

  // Retrying after the remote appears extends the published domain.
  f.remote('ghost');
  const retried = f.run(['init', '--name', 'payments', '--accept']);
  assert.equal(retried.status, 'ok');
  assert.deepEqual(readDomain('payments', { home: f.home }).config.repos.map(r => r.id), ['ghost', 'ledger']);
});

test('re-running init extends an existing domain without losing its bindings', t => {
  const f = fixture(t);
  f.remote('ledger');
  f.remote('gateway');
  const ledger = f.checkout('ledger');
  f.run(['init', '--name', 'payments', '--repo', `ledger=${ledger}`]);
  f.run(['init', '--name', 'payments', '--accept']);
  const gateway = f.checkout('gateway');
  const draft = f.run(['init', '--name', 'payments', '--repo', `gateway=${gateway}`, '--asset', 'core=ledger,gateway']);
  assert.equal(draft.extended, true);
  f.run(['init', '--name', 'payments', '--accept']);
  const { config } = readDomain('payments', { home: f.home });
  assert.equal(config.bindings.repos.ledger, ledger);
  assert.equal(config.bindings.repos.gateway, gateway);
  assert.deepEqual(config.assets, [{ id: 'core', components: [{ id: 'ledger', repo: 'ledger' }, { id: 'gateway', repo: 'gateway' }] }]);
});

test('re-init recognises local checkouts, keeps component ids unique and prunes spec scopes that disappear', t => {
  const f = fixture(t);
  f.remote('ledger');
  const ledger = f.checkout('ledger');
  const local = path.join(f.dir, 'work', 'scratch');
  fs.mkdirSync(local, { recursive: true });
  f.git(local, ['init', '-q']);
  f.git(local, ['commit', '-q', '--allow-empty', '-m', 'seed']);
  f.run(['init', '--name', 'payments', '--repo', `ledger=${ledger}`, '--repo', `scratch=${local}`]);
  f.run(['init', '--name', 'payments', '--accept']);
  const again = f.run(['init', '--name', 'payments', '--repo', `scratch=${local}`]);
  assert.deepEqual(again.repos.map(r => r.id), ['ledger', 'scratch'], 'the local-identity checkout is not added twice');

  // A component named like a repo already used by another asset gets a distinct id.
  const doc = YAML.parse(fs.readFileSync(again.draftPath, 'utf8'));
  doc.config.assets = [{ id: 'core', components: [{ id: 'scratch', repo: 'ledger', path: 'pkg' }] }];
  doc.config.spec_sources = [];
  fs.writeFileSync(again.draftPath, YAML.stringify(doc));
  const grouped = f.run(['init', '--name', 'payments', '--repo', `scratch=${local}`, '--asset', 'tools=scratch']);
  const ids = grouped.assets.flatMap(a => a.components.map(c => c.id));
  assert.equal(new Set(ids).size, ids.length, `component ids are unique: ${ids}`);
  assert.deepEqual(grouped.assets.find(a => a.id === 'tools').components, [{ id: 'scratch-2', repo: 'scratch' }]);

  // A spec source scoped to an asset that a later --asset empties is dropped with a note.
  const withScope = YAML.parse(fs.readFileSync(grouped.draftPath, 'utf8'));
  withScope.config.sources = [{ id: 'spec', local_identity: { id: 'spec', approved: true } }];
  withScope.config.bindings.sources = { spec: local };
  withScope.config.spec_sources = [{ source: 'spec', scope: 'asset/tools', include: [], authority: 'reference' }];
  fs.writeFileSync(grouped.draftPath, YAML.stringify(withScope));
  const moved = f.run(['init', '--name', 'payments', '--repo', `scratch=${local}`, '--asset', 'core=scratch']);
  assert.deepEqual(moved.specSources, []);
  assert.ok(moved.notes.some(n => /dropped spec source spec for asset\/tools/.test(n)), moved.notes.join('\n'));
});

test('init and accept handle hostile drafts, occupied clone targets and remote helpers', t => {
  const f = fixture(t);
  f.remote('ledger');
  f.remote('gateway');
  const cloneRoot = path.join(f.dir, 'clones');
  fs.mkdirSync(cloneRoot);
  fs.writeFileSync(path.join(cloneRoot, 'gateway'), 'a file, not a directory');
  const draft = f.run(['init', '--name', 'payments', '--repo', `ledger=${REMOTE}ledger.git`, '--repo', `gateway=${REMOTE}gateway.git`, '--clone-root', cloneRoot]);
  assert.deepEqual(draft.clones.map(c => c.repo), ['ledger']);
  assert.deepEqual(draft.unbound, ['gateway']);
  assert.ok(draft.notes.some(n => /clone target .*gateway exists/.test(n)));

  // A second init keeps the first draft's repositories and clone plan.
  const second = f.run(['init', '--name', 'payments', '--repo', `gateway=${REMOTE}gateway.git`, '--clone-root', path.join(f.dir, 'other')]);
  assert.deepEqual(second.repos.map(r => r.id), ['ledger', 'gateway']);
  assert.deepEqual(second.clones.map(c => c.repo).sort(), ['gateway', 'ledger']);

  for (const broken of [{ draft_version: 1, config: { name: 'payments', repos: 'x', bindings: {} }, clones: [] }, { draft_version: 1, config: { name: 'payments', repos: [], bindings: [] }, clones: [] }, { draft_version: 1, config: { name: 'payments', repos: [], bindings: {} }, clones: [null] }]) {
    fs.writeFileSync(second.draftPath, YAML.stringify(broken));
    assert.throws(() => f.run(['init', '--name', 'payments', '--accept']), /unsupported shape/);
  }
  assert.throws(() => f.run(['init', '--name', 'other', '--repo', 'x=ext::sh -c touch% /tmp/pwned', '--clone-root', cloneRoot]), /absolute/);
  assert.throws(() => f.run(['init', '--name', 'other', '--repo', 'x=https://example.invalid/a::b', '--clone-root', cloneRoot]), /remote helper/);
});

test('accept refuses two repositories bound to the same checkout', t => {
  const f = fixture(t);
  f.remote('ledger');
  const ledger = f.checkout('ledger');
  const draft = f.run(['init', '--name', 'payments', '--repo', `ledger=${ledger}`]);
  const doc = YAML.parse(fs.readFileSync(draft.draftPath, 'utf8'));
  doc.config.repos.push({ id: 'twin', origin: doc.config.repos[0].origin.replace('ledger', 'twin') });
  doc.config.bindings.repos.twin = ledger;
  fs.writeFileSync(draft.draftPath, YAML.stringify(doc));
  assert.throws(() => f.run(['init', '--name', 'payments', '--accept']), /ledger and twin are both bound/);
});

test('bind repoints a repository only at a checkout with the expected origin', t => {
  const f = fixture(t);
  f.remote('ledger');
  f.remote('other');
  const first = f.checkout('ledger');
  f.run(['init', '--name', 'payments', '--repo', `ledger=${first}`]);
  f.run(['init', '--name', 'payments', '--accept']);
  const second = f.checkout('ledger', path.join(f.dir, 'elsewhere'));
  const bound = f.run(['bind', '--name', 'payments', '--repo', `ledger=${second}`]);
  assert.deepEqual(bound.changed, [{ kind: 'repos', id: 'ledger', binding: second }]);
  assert.equal(readDomain('payments', { home: f.home }).config.bindings.repos.ledger, second);
  const wrong = f.checkout('other');
  assert.throws(() => f.run(['bind', '--name', 'payments', '--repo', `ledger=${wrong}`]), /expected https:\/\/example\.invalid\/pay\/ledger/);
  assert.throws(() => f.run(['bind', '--name', 'payments', '--repo', `missing=${wrong}`]), /is not a repository of payments/);
});

test('init refuses unsafe or incomplete input before writing anything', t => {
  const f = fixture(t);
  assert.throws(() => f.run(['init', '--name', 'payments']), /needs --from-workspace, --from-spec or at least one --repo/);
  assert.throws(() => f.run(['init', '--name', 'payments', '--repo', 'x=https://user:secret@example.invalid/pay/x.git', '--clone-root', f.dir]), /credential-bearing/);
  assert.throws(() => f.run(['init', '--name', 'payments', '--repo', 'x=relative/path']), /absolute/);
  assert.throws(() => f.run(['init', '--name', 'payments', '--repo', `x=${REMOTE}x.git`]), /--clone-root/);
  assert.throws(() => f.run(['init', '--name', 'payments', '--accept']), /no draft for payments/);
  assert.throws(() => f.run(['init', '--name', 'payments', '--accept', '--repo', 'x=/tmp']), /takes no inputs/);
  assert.throws(() => f.run(['show', '--name', 'payments', '--accept']), /--accept is supported only for init/);
  assert.equal(fs.existsSync(path.join(f.home, 'domains')), false);
});

test('spec repositories declare repos through tables and front matter as well as manifests', t => {
  const f = fixture(t);
  const spec = path.join(f.dir, 'spec');
  fs.mkdirSync(path.join(spec, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(spec, 'docs/architecture.md'), [
    '# Architecture', '', '| Service | Repository | Asset | Role |', '| --- | :---: | --- | --- |',
    `| Ledger API | [ledger](${REMOTE}ledger.git) | Core | service |`,
    '| Not a repo | see wiki | Core | doc |',
    `| Billing | \`git@example.invalid:pay/billing.git\` | Core | worker |`, '', 'After the table.',
  ].join('\n'));
  fs.writeFileSync(path.join(spec, 'docs/prd.md'), `---\nrepos:\n  - ${REMOTE}notify.git\n---\n# PRD\n`);
  const found = specRepos(spec);
  assert.deepEqual(found.found, ['docs/architecture.md', 'docs/prd.md']);
  assert.deepEqual(found.repos.map(r => r.url), [`${REMOTE}ledger.git`, 'git@example.invalid:pay/billing.git', `${REMOTE}notify.git`]);
  assert.deepEqual(markdownRepoTables('| Name | Repo |\n| --- | --- |\n| a | https://h.invalid/a |').map(r => r.id), ['a']);
  assert.equal(idFrom('Ledger API'), 'ledger-api');
  assert.equal(idFrom('git@host:team/Billing_Svc.git'), 'billing-svc');
  assert.equal(idFrom('123'), null);
});

test('JSONC stripping keeps comment markers inside strings', () => {
  assert.deepEqual(JSON.parse(stripJsonc('{"a": "x//y", /* c */ "b": "/*z*/", // tail\n "c": [1,2,],}')), { a: 'x//y', b: '/*z*/', c: [1, 2] });
});

test('assets and spec sources are validated but stay out of the logical execution digest', () => {
  const base = { domain_version: 2, name: 'payments', repos: [{ id: 'ledger', origin: `${REMOTE}ledger` }], sources: [{ id: 'spec', origin: `${REMOTE}spec` }], bindings: { repos: { ledger: '/work/ledger' }, sources: { spec: '/work/spec' } } };
  const described = { ...base, assets: [{ id: 'core', components: [{ id: 'ledger-api', repo: 'ledger', role: 'service' }, { id: 'ledger-worker', repo: 'ledger', path: 'worker/' }] }], spec_sources: [{ source: 'spec', scope: 'component/ledger-worker', include: ['docs/**'], authority: 'authoritative' }, { source: 'spec', scope: 'asset/core' }] };
  assert.deepEqual(logicalDomainContract(described), logicalDomainContract(base));
  const config = validateDomainConfig(described, 'payments');
  assert.equal(config.assets[0].components[1].path, 'worker');
  assert.deepEqual(config.spec_sources.map(s => [s.scope, s.authority]), [['component/ledger-worker', 'authoritative'], ['asset/core', 'reference']]);
  const bad = (patch, pattern) => assert.throws(() => validateDomainConfig({ ...described, ...patch }, 'payments'), pattern);
  bad({ assets: [{ id: 'core', components: [{ id: 'x', repo: 'nope' }] }] }, /unknown repo/);
  bad({ assets: [{ id: 'core', components: [{ id: 'x', repo: 'ledger' }, { id: 'x', repo: 'ledger', path: 'w' }] }] }, /unique/);
  bad({ assets: [{ id: 'core', components: [{ id: 'x', repo: 'ledger', path: '../up' }] }] }, /safe relative path/);
  bad({ assets: [{ id: 'core', components: [] }] }, /at least one component/);
  bad({ spec_sources: [{ source: 'spec', scope: 'asset/missing' }] }, /unknown asset/);
  bad({ spec_sources: [{ source: 'spec', scope: 'domain/x' }] }, /scope must be/);
  bad({ spec_sources: [{ source: 'spec', authority: 'advisory' }] }, /reference or authoritative/);
  bad({ spec_sources: [{ source: 'spec', include: ['/etc/**'] }] }, /safe relative patterns/);
  bad({ spec_sources: [{ source: 'spec' }, { source: 'spec', scope: 'domain' }] }, /duplicate/);
});
