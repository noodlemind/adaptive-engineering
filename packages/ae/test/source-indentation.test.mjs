import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function sources(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const rel = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : sources(rel);
    return entry.name.endsWith('.mjs') ? [rel] : [];
  });
}

// Automated edits once left statements indented deeper than their block with no
// syntactic reason. Flag a jump past one level that no opener or continuation explains.
function strayIndents(text) {
  const hits = [];
  let previous = null, inTemplate = false;
  text.split('\n').forEach((line, index) => {
    const wasInTemplate = inTemplate;
    // Backticks inside regex character classes (e.g. [^`]) do not open templates.
    const code = line.replace(/\[\^?[^\]]*\]/g, '');
    if (((code.match(/`/g) || []).length - (code.match(/\\`/g) || []).length) % 2) inTemplate = !inTemplate;
    if (!line.trim() || wasInTemplate) return;
    const indent = line.match(/^ */)[0].length;
    if (previous && !/^\s*(\/\/|\*|[.?:|&+])/.test(line)) {
      const opener = /[{([]$/.test(previous.text);
      const continued = /[,=>:?+|&]$|^\s*(\/\/|\*)/.test(previous.text);
      if ((!opener && !continued && indent > previous.indent + 2) || (opener && indent > previous.indent + 4)) hits.push(index + 1);
    }
    previous = { indent, text: line.trimEnd() };
  });
  return hits;
}

test('runtime sources keep statements at their block indentation', () => {
  const offenders = [];
  for (const rel of [...sources('lib'), ...sources('bin'), ...sources('corpus/hooks'), ...sources('scripts')]) {
    const hits = strayIndents(fs.readFileSync(path.join(root, rel), 'utf8'));
    if (hits.length) offenders.push(`${rel}:${hits.slice(0, 5).join(',')}`);
  }
  assert.deepEqual(offenders, []);
});
