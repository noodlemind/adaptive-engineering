import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';

const corpus = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../corpus');
const read = relative => fs.readFileSync(path.join(corpus, relative), 'utf8');

test('Engineer discovers eligible external capabilities and acquires first-needed specialists', () => {
  const contract = read('skills/engineer/references/contract.md');
  assert.match(contract, /adaptive-lifecycle\.md/);
  const lifecycle = read('skills/engineer/references/adaptive-lifecycle.md');
  assert.match(lifecycle, /one bounded.*refresh/i);
  assert.match(lifecycle, /first task.*specialist|specialist.*first task/i);
  assert.match(lifecycle, /recurrence.*skill|skill.*recurrence/i);
  assert.match(lifecycle, /pending.reload/i);
  assert.match(lifecycle, /exclu.*revok|revok.*exclu/i);
});

test('internal decision role evaluates evidence without inventing execution authority', () => {
  const source = read('agents/decision-agent.agent.md');
  const frontmatter = YAML.parse(source.match(/^---\n([\s\S]*?)\n---/)[1]);
  assert.equal(frontmatter['user-invocable'], false);
  assert.deepEqual(frontmatter.agents, []);
  assert.equal(frontmatter.model, undefined);
  assert.match(source, /host.*model/i);
  assert.match(source, /no external.*API/i);
  assert.match(source, /cannot grant.*authority/i);
  assert.match(source, /untrusted.*evidence|evidence.*untrusted/i);
  assert.match(source, /failed.*verification|verification.*failed/i);
  assert.match(read('skills/setup-models/SKILL.md'), /decision.*inherit/);
});

test('standing consent does not need per-primitive repetition and human review receives a current tour', () => {
  const approval = read('skills/references/human-approval-policy.md');
  assert.match(approval, /standing.*grant/i);
  assert.match(approval, /does not.*broaden|cannot.*broaden/i);
  assert.match(read('skills/code-review/SKILL.md'), /review tour/);
  const lifecycle = read('skills/engineer/references/adaptive-lifecycle.md');
  assert.match(lifecycle, /source attribution/);
  assert.match(lifecycle, /explicit.*instruction.*inferred|inferred.*explicit.*instruction/i);
  assert.match(lifecycle, /diagram.*proof|proof.*diagram/i);
});
