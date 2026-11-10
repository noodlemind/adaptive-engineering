import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../lib/style.mjs';
import { LOOKUP_KINDS, PENDING_KINDS, lookupEntity } from '../lib/retrieval/lookup.mjs';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fixtureWorkspace() {
  const ws = tempDir('lookup-ws-');
  fs.mkdirSync(path.join(ws, 'docs', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.github', 'skills', 'demo'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, 'docs', 'plans', '2026-01-01-demo.md'),
    '---\nplan_schema: 1\ntitle: "Demo plan"\nstatus: review\nplan_lock: true\nphase: 2\n---\n\n# Demo plan\n\nbody line\n',
  );
  fs.writeFileSync(
    path.join(ws, '.github', 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: A demo skill\n---\n\nBody.\n',
  );
  fs.writeFileSync(
    path.join(ws, '.github', 'harness', 'checks.yaml'),
    'version: 1\nchecks:\n  harness-tests:\n    command: ["npm", "test"]\n    timeout_seconds: 600\n  build-assets:\n    command: ["npm", "run", "build:assets"]\n',
  );
  fs.writeFileSync(path.join(ws, 'README.md'), 'hello world\nsecond line\n');
  return ws;
}

const call = (kind, identifier, ws, extra = {}) =>
  lookupEntity({ kind, identifier, workspace: ws, copilotHome: extra.copilotHome ?? tempDir('lookup-home-'), home: extra.home });

function expectThrow(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw, got a result');
}

test('the kind list matches the settled architecture contract, in order', () => {
  assert.deepEqual([...LOOKUP_KINDS], [
    'file', 'symbol', 'document', 'plan', 'skill', 'check', 'run', 'event', 'resource', 'learning', 'episode',
  ]);
});

test('an unknown KIND is a usage error; a missing ENTITY is a not-found', () => {
  const ws = fixtureWorkspace();

  const badKind = expectThrow(() => call('nonsense', 'x', ws));
  assert.equal(badKind.code, 'E_USAGE');
  assert.equal(badKind.exit, EXIT.usage);

  const missing = expectThrow(() => call('plan', 'no-such-plan.md', ws));
  assert.equal(missing.code, 'E_NOT_FOUND');
  assert.equal(missing.exit, EXIT.notFound);
  assert.equal(missing.exit, 9, 'not-found has its own exit code, distinct from usage(2) and failure(1)');
  assert.equal(missing.kind, 'plan');
  assert.equal(missing.identifier, 'no-such-plan.md');
});

test('a missing identifier is a usage error naming the kind', () => {
  const ws = fixtureWorkspace();
  const err = expectThrow(() => call('plan', '', ws));
  assert.equal(err.code, 'E_USAGE');
  assert.match(err.message, /requires an identifier/);
});

test('run and resource stay in the kind list and answer not-found naming their phase', () => {
  const ws = fixtureWorkspace();
  for (const kind of Object.keys(PENDING_KINDS)) {
    const err = expectThrow(() => call(kind, 'anything', ws));
    assert.equal(err.code, 'E_NOT_FOUND', `${kind} is a known kind, not a usage error`);
    assert.match(err.hint, /Phase 4a|Phase 5/, `${kind} names the phase that will populate it`);
  }
});

test('lookup plan resolves by filename or full path and reports frontmatter state', () => {
  const ws = fixtureWorkspace();
  for (const id of ['2026-01-01-demo.md', 'docs/plans/2026-01-01-demo.md']) {
    const out = call('plan', id, ws);
    assert.equal(out.kind, 'plan');
    assert.equal(out.id, '2026-01-01-demo.md', 'the id normalizes to the filename either way');
    assert.equal(out.location, 'docs/plans/2026-01-01-demo.md');
    assert.equal(out.title, 'Demo plan');
    assert.equal(out.metadata.status, 'review');
    assert.equal(out.metadata.planLock, 'true');
    assert.match(out.preview, /# Demo plan/);
  }
});

test('lookup file reads under the workspace and refuses to escape it', () => {
  const ws = fixtureWorkspace();
  const out = call('file', 'README.md', ws);
  assert.equal(out.id, 'README.md');
  assert.match(out.preview, /hello world/);
  assert.equal(out.metadata.lines >= 2, true);

  const escaped = expectThrow(() => call('file', '../../../etc/passwd', ws));
  assert.equal(escaped.code, 'E_USAGE');
  assert.match(escaped.message, /escapes the workspace/);
});

test('lookup skill resolves from the Copilot home and check stays on workspace config', () => {
  const ws = fixtureWorkspace();
  const copilotHome = tempDir('lookup-skill-');
  const skillFile = path.join(copilotHome, 'skills', 'demo', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, '---\nname: demo\ndescription: A demo skill\n---\n\nBody.\n');
  const skill = call('skill', 'demo', ws, { copilotHome });
  assert.equal(skill.id, 'demo');
  assert.equal(skill.title, 'demo');
  assert.equal(skill.metadata.description, 'A demo skill');
  assert.equal(skill.location, skillFile);
  assert.equal(skill.provenance.source, 'copilot-home');

  const check = call('check', 'harness-tests', ws);
  assert.equal(check.id, 'harness-tests');
  assert.equal(check.location, '.github/harness/checks.yaml');
  assert.equal(check.metadata.timeoutSeconds, 600);
});

// A typo should be recoverable without a second command.
test('a near-miss returns related candidates rather than a bare failure', () => {
  const ws = fixtureWorkspace();
  const err = expectThrow(() => call('check', 'harness-test', ws));
  assert.equal(err.code, 'E_NOT_FOUND');
  assert.ok(err.related.length > 0, 'the real check names are offered');
  assert.ok(err.related.some((r) => r.id === 'harness-tests'));
});

test('no resolver creates the knowledge store', () => {
  const ws = fixtureWorkspace();
  const home = tempDir('lookup-store-home-');
  const storeRoot = path.join(home, 'knowledge');

  for (const kind of ['learning', 'episode']) {
    const err = expectThrow(() => call(kind, 'missing/thing', ws, { home }));
    assert.equal(err.code, 'E_NOT_FOUND', `${kind} reports absence rather than seeding`);
  }
  assert.equal(fs.existsSync(storeRoot), false, 'looking for a learning must not create the store');
});

test('lookup symbol without a structural index says so instead of reporting no matches', () => {
  const ws = fixtureWorkspace();
  const err = expectThrow(() => call('symbol', 'someSymbol', ws, { home: tempDir('lookup-sym-home-') }));
  assert.equal(err.code, 'E_NOT_FOUND');
  assert.match(err.hint, /structural index/, 'an absent index is distinguishable from a genuine miss');
});

test('lookup event reports the identifier it actually accepts', () => {
  const ws = fixtureWorkspace();
  const err = expectThrow(() => call('event', 'sess-1', ws));
  assert.equal(err.code, 'E_NOT_FOUND');

  fs.mkdirSync(path.join(ws, '.harness'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.harness', 'events.jsonl'),
    `${JSON.stringify({ type: 'command.start', session: 'sess-1' })}\n${JSON.stringify({ type: 'command.result', session: 'sess-1' })}\n`,
  );
  const out = call('event', 'sess-1', ws);
  assert.equal(out.metadata.count, 2);
  assert.deepEqual(out.metadata.types, ['command.start', 'command.result']);
});

test('a secret in file content never reaches the preview', () => {
  const ws = fixtureWorkspace();
  fs.writeFileSync(path.join(ws, 'leak.txt'), 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
  const out = call('file', 'leak.txt', ws);
  assert.doesNotMatch(out.preview, /ghp_abcdefghij/, 'the preview is redacted at the data boundary');
});

test('a malformed events file does not crash the resolver', () => {
  const ws = fixtureWorkspace();
  fs.mkdirSync(path.join(ws, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.harness', 'events.jsonl'), 'not json\n{"type":"x","session":"s"}\n');
  const out = call('event', 's', ws);
  assert.equal(out.metadata.count, 1, 'unparseable lines are skipped, not fatal');
});

test('an episode evidence_quote line is withheld from every raw-file preview, excerpt and snippet', async () => {
  const { runGet } = await import('../lib/get-cmd.mjs');
  const { runSearch } = await import('../lib/retrieval/search.mjs');
  const { spawnSync } = await import('node:child_process');
  const ws = fixtureWorkspace();
  const copilotHome = tempDir('lookup-quote-home-');
  const home = tempDir('lookup-quote-hh-');
  const half1 = 'A1b2C3d4E5f6G7h8I9';
  const half2 = 'J0k1L2m3N4o5P6q7R8';
  const token = `ghp_${half1}${half2}`;
  // Hand-written: the stored line holds the token split by an escaped newline,
  // so no secret pattern sees it on the raw line, and a block scalar quote
  // whose continuation lines are the rest of the value.
  const rel = 'docs/solutions/insights/split-quote.md';
  fs.mkdirSync(path.join(ws, 'docs', 'solutions', 'insights'), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), `---\ntitle: "quotewitness split"\nkind: insight\nevidence_quote: ${JSON.stringify(`quotewitness auth failed ghp_${half1}\n${half2}`)}\n---\n\nThe login retry masks a 401.\n`);
  const blockRel = 'docs/solutions/insights/block-quote.md';
  fs.writeFileSync(path.join(ws, blockRel), `---\ntitle: "quotewitness block"\nevidence_quote: |\n  quotewitness ghp_${half1}\n  ${half2}\nkind: insight\n---\n\nBody.\n`);
  fs.mkdirSync(path.join(ws, 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'knowledge', 'manifest.yaml'), ['updated: "2026-11-01T00:00:00Z"', 'entries:', '  - id: split-quote', `    path: ${rel}`, '    title: "quotewitness split"', '    kind: insight', `    summary: "evidence_quote: quotewitness ghp_${half1}\\n${half2}"`, '  - id: block-quote', `    path: ${blockRel}`, '    title: "quotewitness block"', '    kind: insight', ''].join('\n'));
  for (const args of [['init', '-q'], ['config', 'user.email', 'harness@local'], ['config', 'user.name', 'harness'], ['add', '-A'], ['commit', '-q', '-m', 'fixture']]) spawnSync('git', ['-C', ws, ...args]);

  const windows = Array.from({ length: token.length - 7 }, (_, i) => token.slice(i, i + 8));
  const assertWithheld = (value, where) => {
    const text = JSON.stringify(value);
    for (const w of windows) assert.ok(!text.includes(w), `${where} leaked ${w}: ${text}`);
  };
  for (const [id, file] of [['split-quote', rel], ['block-quote', blockRel]]) {
    const doc = lookupEntity({ kind: 'document', identifier: id, workspace: ws, copilotHome, home });
    assert.ok(doc.preview.includes('evidence_quote: [withheld]'), doc.preview);
    assert.ok(doc.preview.includes('kind: insight'), 'the rest of the frontmatter is still shown');
    assertWithheld(doc, `lookup document ${id}`);
    assertWithheld(lookupEntity({ kind: 'file', identifier: file, workspace: ws, copilotHome, home }), `lookup file ${file}`);
    const got = runGet({ workspace: ws, copilotHome, home, flags: { docid: id, contextVersion: 2 } });
    assert.ok(got.excerpt.includes('evidence_quote: [withheld]'), got.excerpt);
    assert.equal(got.evidence.redacted, true, 'a withheld line counts as redacted');
    assert.equal(got.totalLines, fs.readFileSync(path.join(ws, file), 'utf8').split('\n').length, 'line numbers do not move');
    assertWithheld(got, `get --docid ${id}`);
    assertWithheld(runGet({ workspace: ws, copilotHome, home, flags: { path: file, offset: 4 } }), `get --path ${file} --offset 4`);
  }
  // A hand-edited manifest field that holds a copied quote line.
  const found = runSearch({ query: 'quotewitness ghp', workspace: ws, copilotHome, home, mode: 'literal', sources: ['knowledge'] });
  assert.ok(found.results.some((r) => r.id === 'split-quote' && r.snippet === 'evidence_quote: [withheld]'), JSON.stringify(found.results));
  assertWithheld(found, 'search snippets');
});

test('get and lookup withhold a folded or hand-edited evidence_quote shape whole', async () => {
  const { runGet } = await import('../lib/get-cmd.mjs');
  const ws = fixtureWorkspace();
  const copilotHome = tempDir('lookup-shape-home-');
  const home = tempDir('lookup-shape-hh-');
  const secret = 'AKIAABCDEFGHIJKLMNOP';
  const files = {
    'docs/solutions/insights/folded.md': `---\ntitle: "folded"\nevidence_quote: "connect failed with key ${secret.slice(0, 8)}\n  ${secret.slice(8)} and more"\nkind: insight\n---\n\nBody.\n`,
    'docs/solutions/insights/bom.md': `﻿---\ntitle: "bom"\nevidence_quote: "QUOTE_MARKER"\n---\n\nBody.\n`,
    'docs/solutions/insights/blank.md': `\n---\ntitle: "blank"\nevidence_quote: "QUOTE_MARKER"\n---\n\nBody.\n`,
    'docs/solutions/insights/cr.md': `---\rtitle: "cr"\revidence_quote: "QUOTE_MARKER"\r---\r\rBody.\r`,
    'docs/solutions/insights/quoted-key.md': `---\ntitle: "quoted"\n"evidence_quote": "QUOTE_MARKER"\n---\n\nBody.\n`,
    'docs/solutions/insights/flow.md': `---\n{title: flow, evidence_quote: "QUOTE_MARKER"}\n---\n\nBody.\n`,
    'docs/solutions/insights/complex.md': `---\ntitle: "complex"\n? evidence_quote\n: "QUOTE_MARKER"\n---\n\nBody.\n`,
    'docs/solutions/insights/alias.md': `---\ntitle: &a "QUOTE_MARKER"\nevidence_quote: *a\n---\n\nBody.\n`,
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), text);
  }
  const { spawnSync } = await import('node:child_process');
  for (const args of [['init', '-q'], ['config', 'user.email', 'harness@local'], ['config', 'user.name', 'harness'], ['add', '-A'], ['commit', '-q', '-m', 'fixture']]) spawnSync('git', ['-C', ws, ...args]);
  for (const rel of Object.keys(files)) {
    for (const [where, value] of [
      ['get', runGet({ workspace: ws, copilotHome, home, flags: { path: rel } })],
      ['get --offset 3', runGet({ workspace: ws, copilotHome, home, flags: { path: rel, offset: 3 } })],
      ['lookup file', lookupEntity({ kind: 'file', identifier: rel, workspace: ws, copilotHome, home })],
    ]) {
      const text = JSON.stringify(value);
      for (const leak of ['QUOTE_MARKER', secret.slice(0, 8), secret.slice(8)]) assert.ok(!text.includes(leak), `${where} ${rel} leaked ${leak}: ${text}`);
    }
  }
});

test('a doc or source file that only mentions evidence_quote comes back unchanged from get and lookup', async () => {
  const { runGet } = await import('../lib/get-cmd.mjs');
  const ws = fixtureWorkspace();
  const copilotHome = tempDir('lookup-mention-home-');
  const home = tempDir('lookup-mention-hh-');
  const files = {
    'docs/evidence.md': '# Evidence quotes\n\nAn episode may carry one line:\n\nevidence_quote: "expected 3, received 4"\n\n    const quote = readEvidenceQuote(text);\n    show(quote);\n\nThe field is optional.\n',
    'src/record.ts': 'export const record = {\n  evidence_quote: "x",\n    nested: 1,\n};\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), text);
  }
  const { spawnSync } = await import('node:child_process');
  for (const args of [['init', '-q'], ['config', 'user.email', 'harness@local'], ['config', 'user.name', 'harness'], ['add', '-A'], ['commit', '-q', '-m', 'fixture']]) spawnSync('git', ['-C', ws, ...args]);
  for (const [rel, text] of Object.entries(files)) {
    const got = runGet({ workspace: ws, copilotHome, home, flags: { path: rel, contextVersion: 2 } });
    assert.equal(got.excerpt, text, rel);
    assert.equal(got.evidence.redacted, false, rel);
    const looked = lookupEntity({ kind: 'file', identifier: rel, workspace: ws, copilotHome, home });
    assert.ok(!JSON.stringify(looked).includes('[withheld]'), JSON.stringify(looked));
  }
});
