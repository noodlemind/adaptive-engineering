import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';
import { specsResultOf, parseSpecArguments, cmdSpecs } from '../lib/specs-cmd.mjs';
import { getCommand } from '../lib/registry.mjs';
import { splitSections, labelOf, globToRegExp, detectFormats, parseSectionRef } from '../lib/spec-index.mjs';
import { kindOf, intentSourcesCheck, discoverIntent } from '../lib/intent-sources.mjs';

const PRD = `---
title: Payments PRD
---
# Payments PRD

## Functional Requirements

### FR1: Accept card payments
Cards are charged through the gateway.

### FR2: Refund window
Refunds are allowed for 30 days.

\`\`\`md
# Not a heading inside a fence
\`\`\`

## Epic 3 Notifications

### Story 3.2: Settlement notice
Notify the merchant when a payment settles.
`;

function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spec-index-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (cwd, args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const repo = (name, files, origin) => {
    const root = path.join(dir, name);
    fs.mkdirSync(root, { recursive: true });
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'Spec']);
    git(root, ['config', 'user.email', 'spec@example.invalid']);
    git(root, ['remote', 'add', 'origin', origin]);
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
    }
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'seed']);
    return root;
  };
  const ledger = repo('ledger', { 'README.md': '# Ledger\n' }, 'https://example.invalid/pay/ledger.git');
  const spec = repo('payments-spec', {
    'docs/prd.md': PRD,
    'docs/architecture.md': '# Architecture\n\n## Ledger service\nThe ledger publishes payment.completed.\n',
    'docs/ledger/api.md': '# Ledger API\n\n## Settlement endpoint\nPOST /settle records settlement.\n',
    'notes/todo.txt': 'not markdown',
    'docs/stories/3.2.story.md': '# Story 3.2: Settlement notice\n\n## Acceptance Criteria\n1. Merchant is notified.\n',
  }, 'https://example.invalid/pay/payments-spec.git');
  const home = path.join(dir, 'harness');
  const config = {
    domain_version: 2, name: 'payments',
    repos: [{ id: 'ledger', origin: 'https://example.invalid/pay/ledger' }],
    sources: [{ id: 'spec', origin: 'https://example.invalid/pay/payments-spec' }],
    bindings: { repos: { ledger }, sources: { spec } },
    assets: [{ id: 'core', components: [{ id: 'ledger', repo: 'ledger' }] }],
    spec_sources: [
      { source: 'spec', scope: 'domain', include: ['docs/*.md', 'docs/stories/**'] },
      { source: 'spec', scope: 'component/ledger', include: ['docs/ledger/**'], authority: 'authoritative' },
    ],
  };
  fs.mkdirSync(path.join(home, 'domains'), { recursive: true });
  fs.writeFileSync(path.join(home, 'domains/payments.yaml'), YAML.stringify(config));
  const run = argv => specsResultOf([...argv, '--name', 'payments'], { harnessHome: home });
  return { dir, home, spec, git, run };
}

test('index splits each spec file into labelled, hashed sections with their scopes', t => {
  const f = fixture(t);
  const indexed = f.run(['index']);
  assert.deepEqual(indexed.sources.map(s => [s.id, s.status, s.files, s.formats]), [['spec', 'indexed', 4, ['bmad']]]);
  const index = JSON.parse(fs.readFileSync(indexed.indexPath, 'utf8'));
  const prd = index.sources[0].files.find(file => file.path === 'docs/prd.md');
  assert.deepEqual(prd.sections.map(s => s.id), ['payments-prd', 'payments-prd/functional-requirements', 'fr1', 'fr2', 'epic-3', 'story-3.2']);
  assert.deepEqual(prd.scopes, [{ scope: 'domain', authority: 'reference' }]);
  const api = index.sources[0].files.find(file => file.path === 'docs/ledger/api.md');
  assert.deepEqual(api.scopes, [{ scope: 'component/ledger', authority: 'authoritative' }]);
  assert.equal(index.sources[0].files.some(file => file.path === 'notes/todo.txt'), false);
});

test('search ranks sections, filters by scope, and get returns exactly the referenced section', t => {
  const f = fixture(t);
  f.run(['index']);
  const found = f.run(['search', 'refund', 'days']);
  assert.equal(found.results[0].section, 'fr2');
  assert.match(found.results[0].snippet, /Refunds are allowed for 30 days/);
  const ref = found.results[0].ref;
  assert.deepEqual(parseSectionRef(ref).path, 'docs/prd.md');
  const got = f.run(['get', '--ref', ref]);
  assert.equal(got.text, '### FR2: Refund window\nRefunds are allowed for 30 days.\n\n```md\n# Not a heading inside a fence\n```\n');

  const scoped = f.run(['search', 'settlement', '--scope', 'component/ledger']);
  assert.ok(scoped.results.some(r => r.path === 'docs/ledger/api.md'), 'component scope includes its own files');
  assert.ok(scoped.results.some(r => r.path === 'docs/prd.md'), 'component scope includes domain-level files');
  const assetScoped = f.run(['search', 'settlement', '--scope', 'asset/core']);
  assert.equal(assetScoped.results.some(r => r.path === 'docs/ledger/api.md'), false, 'a component-scoped file is not shown for another scope');
});

test('an edit outside a section leaves its reference valid; an edit inside it is refused until reindexed', t => {
  const f = fixture(t);
  f.run(['index']);
  const fr1 = f.run(['search', 'card', 'payments']).results.find(r => r.section === 'fr1').ref;
  const fr2 = f.run(['search', 'refund']).results.find(r => r.section === 'fr2').ref;
  const prdPath = path.join(f.spec, 'docs/prd.md');
  fs.writeFileSync(prdPath, fs.readFileSync(prdPath, 'utf8').replace('30 days', '14 days'));
  assert.equal(f.run(['status']).sources[0].status, 'stale');
  assert.throws(() => f.run(['get', '--ref', fr2]), /changed since it was indexed/);
  assert.match(f.run(['get', '--ref', fr1]).text, /Accept card payments/);
  f.run(['index']);
  const fresh = f.run(['search', 'refund']).results.find(r => r.section === 'fr2');
  assert.notEqual(fresh.ref, fr2);
  assert.equal(fresh.ref.split('@')[0], fr2.split('@')[0], 'the section keeps its identity; only its hash moves');
});

test('specs refuse a domain without spec sources and malformed arguments', t => {
  const f = fixture(t);
  assert.throws(() => f.run(['search', 'x']), /no spec index/);
  assert.throws(() => parseSpecArguments(['search', '--name', 'payments']), /needs a query/);
  assert.throws(() => parseSpecArguments(['get', '--name', 'payments']), /requires --ref/);
  assert.throws(() => parseSpecArguments(['index', '--name', 'payments', '--ref', 'x']), /unsupported for index/);
  assert.throws(() => f.run(['get', '--ref', 'spec:spec/docs/prd.md#fr2']), /section reference looks like/);
  assert.throws(() => f.run(['index', '--scope', 'domain']), /unsupported for index/);
  const config = YAML.parse(fs.readFileSync(path.join(f.home, 'domains/payments.yaml'), 'utf8'));
  delete config.spec_sources;
  fs.writeFileSync(path.join(f.home, 'domains/payments.yaml'), YAML.stringify(config));
  assert.throws(() => f.run(['index']), /declares no spec_sources/);
});

test('section splitting, labels, globs and layout detection', () => {
  assert.deepEqual(splitSections('intro\n# A\none\n## B\ntwo\n# A\nthree\n', 'x.md').map(s => [s.id, s.startLine, s.endLine]), [['_preamble', 1, 1], ['a', 2, 3], ['a/b', 4, 5], ['a~2', 6, 8]]);
  assert.deepEqual(splitSections('---\na: 1\n---\n# T\n').map(s => s.id), ['t']);
  for (const [title, label] of [['FR12: x', 'fr12'], ['NFR-3 Latency', 'nfr3'], ['Epic 4', 'epic-4'], ['Story 1.2.3 Login', 'story-1.2.3'], ['AC1', 'ac-1'], ['Requirement 2', 'requirement-2'], ['REQ-Login-1', 'req-login-1'], ['ADR 7', 'adr-7'], ['Overview', null], ['FRAMEWORK', null]]) assert.equal(labelOf(title), label, title);
  assert.ok(globToRegExp('docs/**').test('docs/a/b.md'));
  assert.ok(globToRegExp('docs/**/x.md').test('docs/x.md'));
  assert.ok(!globToRegExp('docs/*.md').test('docs/a/b.md'));
  assert.ok(globToRegExp('a?c.md').test('abc.md'));
  assert.deepEqual(detectFormats(['.kiro/specs/login/requirements.md']), ['kiro']);
  assert.deepEqual(detectFormats(['specs/001-login/spec.md']), ['spec-kit']);
  assert.deepEqual(detectFormats(['openspec/specs/auth/spec.md']), ['openspec']);
  assert.deepEqual(detectFormats(['README.md']), ['markdown']);
});

test('in-repository intent discovery recognises BMAD, Kiro and OpenSpec documents', () => {
  for (const rel of ['docs/prd.md', 'prd.md', 'docs/prd/epic-1.md', 'payments.prd.md', 'docs/stories/1.2.story.md', 'docs/epics/epic-2.md', 'epic-3.md', '.kiro/specs/login/requirements.md', '.kiro/specs/login/design.md', 'openspec/changes/add-x/proposal.md', 'openspec/specs/auth/spec.md']) assert.equal(kindOf(rel), 'spec', rel);
  // General documentation keeps its old classification, so existing plans keep passing the intent gate.
  for (const rel of ['src/prd.ts', 'docs/architecture.png', 'README.md', 'docs/epicenter.md', 'ARCHITECTURE.md', 'docs/architecture.md', 'docs/architecture/overview.md', 'src/stories/button.md', 'web/epics/notes.md', 'lib/prd/notes.md', '.kiro/steering/design.md', 'tools/openspec/readme.md']) assert.equal(kindOf(rel), null, rel);
  assert.equal(kindOf('issues/12.yaml'), 'issue');
});

test('splitting follows CommonMark fences, front matter and closing hashes', () => {
  assert.deepEqual(splitSections('# A\n```\ncode\n```js\n# not heading\n```\n# B\n').map(s => s.id), ['a', 'b']);
  assert.deepEqual(splitSections('---\ntitle: x\n# yaml comment\n---\n# Real\n').map(s => s.id), ['real']);
  assert.deepEqual(splitSections('# Support for C#\n## Closing ##\n').map(s => s.title), ['Support for C#', 'Closing']);
  const many = Array.from({ length: 5 }, (_, i) => `# H${i}\nbody ${i}`).join('\n') + '\n';
  const capped = splitSections(many, 'x.md', { limit: 3 });
  assert.equal(capped.length, 3);
  assert.equal(capped.truncated, true);
  assert.match(capped[2].text, /body 4/, 'the last section runs to the end of the file');
});

test('search survives prototype-named terms, refs survive shifted lines, and snippets are redacted before clipping', t => {
  const f = fixture(t);
  const token = `ghp_${'A'.repeat(36)}`;
  const prdPath = path.join(f.spec, 'docs/prd.md');
  fs.writeFileSync(prdPath, fs.readFileSync(prdPath, 'utf8').replace('Refunds are allowed for 30 days.', `Refunds are allowed for 30 days with constructor injection. ${'x'.repeat(170)} ${token}`));
  f.git(f.spec, ['commit', '-qam', 'secret']);
  f.run(['index']);
  assert.equal(f.run(['search', 'constructor']).results[0].section, 'fr2');
  assert.equal(f.run(['search', 'refund', 'constructor']).results[0].section, 'fr2');
  const hit = f.run(['search', 'refund']).results.find(r => r.section === 'fr2');
  assert.doesNotMatch(hit.snippet, /ghp_A/);
  assert.doesNotMatch(f.run(['get', '--ref', hit.ref]).text, /ghp_A{10}/);

  fs.writeFileSync(prdPath, fs.readFileSync(prdPath, 'utf8').replace('# Payments PRD\n', '# Payments PRD\n\nA new paragraph.\n'));
  const got = f.run(['get', '--ref', hit.ref]);
  assert.match(got.text, /^### FR2: Refund window/);
  assert.equal(got.lines[0], 13, 'lines follow the current file (11 before the two inserted lines)');
  assert.throws(() => f.run(['search', 'x', '--limit', '0']), /1 to 50/);
});

test('status follows the current binding and counts only new files the includes would index; a corrupt index is refused', t => {
  const f = fixture(t);
  f.run(['index']);
  assert.equal(f.run(['status']).sources[0].unindexedTracked, 0, 'README.md and notes are outside the includes');
  fs.writeFileSync(path.join(f.spec, 'docs/new.md'), '# New\n');
  f.git(f.spec, ['add', '.']);
  f.git(f.spec, ['commit', '-qm', 'new']);
  f.run(['index']);
  fs.writeFileSync(path.join(f.spec, 'docs/later.md'), '# Later\n');
  f.git(f.spec, ['add', '.']);
  f.git(f.spec, ['commit', '-qm', 'later']);
  const status = f.run(['status']).sources[0];
  assert.equal(status.unindexedTracked, 1);
  assert.equal(status.status, 'stale');

  const configPath = path.join(f.home, 'domains/payments.yaml');
  const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
  const copy = path.join(f.dir, 'spec-copy');
  f.git(f.dir, ['clone', '-q', f.spec, copy]);
  f.git(copy, ['remote', 'set-url', 'origin', 'https://example.invalid/pay/payments-spec.git']);
  config.bindings.sources.spec = copy;
  fs.writeFileSync(configPath, YAML.stringify(config));
  assert.match(f.run(['status']).sources[0].reason, /different checkout/);

  const indexFile = f.run(['index']).indexPath;
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  index.sources[0].files[0].sections = null;
  fs.writeFileSync(indexFile, JSON.stringify(index));
  assert.throws(() => f.run(['search', 'refund']), /unsupported shape/);
  assert.throws(() => f.run(['status']), /unsupported shape/);
});

test('layout specs are discovered for new plans but do not fail plans that never recorded them', t => {
  const f = fixture(t);
  const repo = path.join(f.dir, 'bmad-only');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  f.git(repo, ['init', '-q']);
  fs.writeFileSync(path.join(repo, 'docs/prd.md'), '# PRD\n\n## FR1: Refund window\n');
  f.git(repo, ['add', '.']);
  assert.deepEqual(discoverIntent(repo, 'refund window').paths.map(p => p.path), ['docs/prd.md']);
  assert.equal(intentSourcesCheck({ fm: { intent: 'refund window change' } }, repo).pass, true);
  fs.mkdirSync(path.join(repo, 'specs'));
  fs.writeFileSync(path.join(repo, 'specs/refund.md'), '# Refund\n');
  f.git(repo, ['add', '.']);
  assert.equal(intentSourcesCheck({ fm: { intent: 'refund window change' } }, repo).pass, false, 'legacy spec paths still bind');
});

test('status reports spec sources added, removed or re-scoped after indexing', t => {
  const f = fixture(t);
  f.run(['index']);
  const configPath = path.join(f.home, 'domains/payments.yaml');
  const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
  config.spec_sources[0].include = ['docs/*.md'];
  fs.writeFileSync(configPath, YAML.stringify(config));
  assert.match(f.run(['status']).sources[0].reason, /scopes or include patterns changed/);
});

test('search counts every occurrence of a term, and redacts heading-keyed secrets and plain-text output', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.spec, 'docs/tf.md'), '# TF\n\n## Once\nwidget appears here.\n\n## Many\nwidget widget widget widget appears here.\n');
  fs.writeFileSync(path.join(f.spec, 'docs/keys.md'), '# Keys\n\n## API_KEY:\nabcd1234efgh5678ijkl\n');
  f.git(f.spec, ['add', '.']);
  f.git(f.spec, ['commit', '-qm', 'tf']);
  f.run(['index']);
  const ranked = f.run(['search', 'widget']).results.map(r => r.section);
  assert.ok(ranked.indexOf('tf/many') >= 0 && ranked.indexOf('tf/many') < ranked.indexOf('tf/once'), `repeated term outranks a single occurrence: ${ranked}`);
  const keyHit = f.run(['search', 'abcd1234efgh5678ijkl']).results.find(r => r.section === 'keys/apikey');
  assert.ok(keyHit, 'the key section is found');
  assert.doesNotMatch(keyHit.snippet, /abcd1234efgh5678ijkl/);

  const logged = [];
  const original = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  try { cmdSpecs(['search', 'refund', `ghp_${'B'.repeat(36)}`, '--name', 'payments'], { harnessHome: f.home }); }
  finally { console.log = original; }
  assert.doesNotMatch(logged.join('\n'), /ghp_B{10}/, 'the echoed query is redacted in text mode');
});

test('the specs registry declares the search query positional and requires --ref only for get', () => {
  const entry = getCommand('specs');
  assert.deepEqual(entry.verbs.find(v => v.verb === 'search').positionals, ['query']);
  const flag = name => entry.args.flags.find(x => x.name === name);
  assert.deepEqual(flag('--ref').verbs, ['get']);
  assert.equal(flag('--ref').required, true);
  assert.deepEqual(flag('--scope').verbs, ['search']);
  assert.deepEqual(flag('--limit').verbs, ['search']);
});
