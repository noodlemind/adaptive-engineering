import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runRecall } from '../lib/recall-cmd.mjs';
import { runOrient } from '../lib/orient.mjs';
import { redactRecallEntry } from '../lib/secret-scan.mjs';
import { rankLearnings } from '../lib/knowledge/retrieve.mjs';
import { buildContextPack } from '../lib/context-pack.mjs';
import { ensureStore, storeDir, serializeLearning } from '../lib/knowledge/store.mjs';

const AWS = 'AKIAIOSFODNN7EXAMPLE'; // canonical \bAKIA[0-9A-Z]{16}\b shape
const CONN = 's3://user:AKIAIOSFODNN7EXAMPLE@host'; // \w+://[^:@/]+:[^@/]+@… shape

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function seedHome() {
  const home = tmp('recall-secret-home-');
  const kdir = path.join(home, 'knowledge');
  fs.mkdirSync(kdir, { recursive: true });
  fs.writeFileSync(
    path.join(kdir, 'manifest.yaml'),
    [
      'updated: 2026-07-30',
      'entries:',
      `  - id: "orders-leak-${AWS}"`, // docid secret
      `    path: "docs/solutions/${CONN}/x.md"`, // path secret (connection string)
      `    title: "${AWS}"`, // title secret (ranks via symptom/summary instead)
      `    symptom: "orders timeout ${AWS}"`, // snippet-source secret + query terms
      '    summary: "orders timeout retry clean summary"',
      '    kind: solution',
      '    scope: global',
      '  - id: "orders-normal-clean"',
      '    path: "docs/solutions/perf/orders-timeout.md"',
      '    title: "orders timeout retry fix"',
      '    summary: "orders timeout retry clean summary"',
      '    kind: solution',
      '    scope: global',
      '',
    ].join('\n'),
    'utf8'
  );
  return home;
}

function assertNoRawSecret(serialized, where) {
  assert.ok(!serialized.includes(AWS), `raw AWS key must not appear in ${where}`);
  assert.ok(!serialized.includes(CONN), `raw connection string must not appear in ${where}`);
  assert.ok(serialized.includes('[redacted:'), `a redaction marker replaces the secret in ${where}`);
}

// Finding 1 — `ae recall` (render + --json) redacts path AND docid. -------
test('runRecall redacts path/docid (and title/summary/snippet) for both the object and its --json serialization', () => {
  const result = runRecall({
    workspace: tmp('recall-secret-ws-'),
    copilotHome: seedHome(),
    flags: { query: 'orders timeout', limit: 5 },
    argv: [],
  });

  // FAIL-BEFORE: path/docid were passed through raw here.
  assertNoRawSecret(JSON.stringify(result), 'ae recall --json');

  const leak = result.recall.find((r) => r.docid === '[redacted: aws-access-key]');
  assert.ok(leak, 'the leak entry docid is redacted');
  assert.ok(!leak.path.includes(AWS) && !leak.path.includes(CONN), 'the leak entry path is redacted');
  assert.match(leak.path, /\[redacted:/, 'the redacted path names a matched pattern');

  // False-positive safety: the clean sibling passes through untouched.
  const clean = result.recall.find((r) => r.docid === 'orders-normal-clean');
  assert.ok(clean, 'the clean entry survives');
  assert.equal(clean.path, 'docs/solutions/perf/orders-timeout.md', 'a normal path is left unchanged');
  assert.equal(clean.title, 'orders timeout retry fix', 'a normal title is left unchanged');
});

// Finding 2 — `ae orient --json` redacts the covered fields too. ----------
test('runOrient redacts every untrusted recall field in BOTH the written pack and the --json result', () => {
  const workspace = tmp('orient-secret-ws-');
  const result = runOrient({
    workspace,
    copilotHome: seedHome(),
    flags: { query: 'orders timeout', limit: 5 },
    query: 'orders timeout',
  });

    assertNoRawSecret(JSON.stringify(result), 'ae orient --json');

  const pack = fs.readFileSync(path.join(workspace, result.contextPack), 'utf8');
  assertNoRawSecret(pack, '.harness/context-pack.md');

  const leak = result.recall.find((r) => r.docid === '[redacted: aws-access-key]');
  assert.ok(leak, 'the leak entry docid is redacted in the orient result');
  assert.match(leak.path, /\[redacted:/, 'the leak entry path is redacted in the orient result');
  assert.equal(leak.title, '[redacted: aws-access-key]', 'a secret-shaped title is redacted');
  assert.match(leak.snippet, /\[redacted:/, 'the snippet built from the secret-bearing symptom is redacted');
});

// Unit — the helper covers exactly the untrusted string fields, false-positive-safe.
test('redactRecallEntry redacts docid/path/title/summary/snippet but never structural fields or normal values', () => {
  const out = redactRecallEntry({
    docid: `leak-${AWS}`,
    path: `docs/solutions/${CONN}/x.md`,
    title: AWS,
    summary: `note ${AWS}`,
    snippet: `line ${AWS}`,
    scope: 'global',
    kind: 'solution',
    ranker: 'overlap',
    score: 0.9,
  });
  for (const f of ['docid', 'path', 'title', 'summary', 'snippet']) {
    assert.match(out[f], /\[redacted:/, `${f} is redacted`);
    assert.ok(!out[f].includes(AWS), `${f} carries no raw secret`);
  }
  assert.equal(out.scope, 'global', 'scope (classification token) is untouched');
  assert.equal(out.kind, 'solution', 'kind (enum) is untouched');
  assert.equal(out.ranker, 'overlap', 'ranker (code-set) is untouched');
  assert.equal(out.score, 0.9, 'score (number) is untouched');

  // A wholly normal entry is returned byte-for-byte equal (no corruption).
  const normal = { docid: 'a', path: 'docs/solutions/perf/x.md', title: 't', summary: 's', snippet: 'n' };
  assert.deepEqual(redactRecallEntry(normal), normal, 'a normal entry is unchanged');
});

// Finding 3 — the learnings section of the same pack. -------------------------

/** A hand-edited learning store: written straight to disk, bypassing the write
 * path's secret screen exactly as a human hand edit does (human authority
 * overrides the cap/scan there by design). */
function seedLearningStore({ trigger, claim }) {
  const workspace = tmp('learn-secret-ws-');
  const harnessHome = tmp('learn-secret-hh-');
  const { dir } = ensureStore(workspace, { home: harnessHome });
  fs.mkdirSync(path.join(dir, 'learnings', 'sql'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'learnings', 'sql', 'orders-timeout.md'),
    serializeLearning(
      {
        trigger,
        status: 'active',
        source: 'human',
        episodes: [],
        anchors: [],
        superseded_by: null,
        last_confirmed: null,
        origin: 'hand-edit',
      },
      claim
    ),
    'utf8'
  );
  assert.equal(storeDir(workspace, { home: harnessHome }), dir);
  return { workspace, harnessHome };
}

test('a secret-shaped learning trigger or claim is redacted in the ranked result and the rendered pack', () => {
  for (const field of ['trigger', 'claim']) {
    const { workspace, harnessHome } = seedLearningStore({
      trigger: field === 'trigger' ? `orders timeout ${AWS}` : 'orders timeout on retry',
      claim: field === 'claim' ? `Rotate ${AWS} before shipping.` : 'Retry with a bounded backoff.',
    });

    const ranked = rankLearnings({ workspace, query: 'orders timeout', limit: 3, home: harnessHome });
    assert.equal(ranked.length, 1, `the learning is surfaced for the ${field} case`);

    // FAIL-BEFORE: the raw key rode through the ranked object into orient --json.
    const serialized = JSON.stringify(ranked);
    assert.ok(!serialized.includes(AWS), `no raw key in the ranked ${field}`);
    assert.match(serialized, /\[redacted:/, `a redaction marker replaces the ${field}`);

    // …and through the pack the model actually reads.
    const pack = buildContextPack({
      query: 'orders timeout',
      recall: [],
      learnings: ranked,
      plans: [],
      gatePreview: { pass: true },
      nextTools: [],
    });
    assert.ok(!pack.includes(AWS), `no raw key in the rendered pack for the ${field}`);
    assert.match(pack, /\[redacted:/, `the pack bullet shows the redaction marker for the ${field}`);
  }
});

test('a clean learning is surfaced byte-for-byte unchanged (no false-positive damage)', () => {
  const { workspace, harnessHome } = seedLearningStore({
    trigger: 'orders timeout on retry',
    claim: 'Retry with a bounded backoff.',
  });

  const [ranked] = rankLearnings({ workspace, query: 'orders timeout', limit: 3, home: harnessHome });
  assert.equal(ranked.trigger, 'orders timeout on retry');
  assert.equal(ranked.claimLine, 'Retry with a bounded backoff.');
});
