import { gitExecutable } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createStyle, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { assertNoSymlinkAncestors, writeFileContainedExclusive } from './fs-safe.mjs';

export const PREPARE_FILES = Object.freeze([
  { rel: 'docs/specs/overview.md', kind: 'spec' },
  { rel: 'docs/adr/0000-architecture.md', kind: 'adr' },
]);

const OBSERVED_CAP = 24;
const SKIP_TOPS = new Set(['.harness', 'node_modules']);

function listedPaths(workspace) {
  const listed = spawnSync(gitExecutable(), ['-C', workspace, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'buffer',
    timeout: 10_000,
  });
  if (listed.status !== 0) return [];
  return listed.stdout.toString('utf8').split('\0').filter(Boolean).map((rel) => rel.replace(/\\/g, '/'));
}

function gitWorkTree(workspace) {
  const inside = spawnSync(gitExecutable(), ['-C', workspace, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return inside.status === 0 && inside.stdout.trim() === 'true';
}

function pathIgnored(workspace, rel) {
  const checked = spawnSync(gitExecutable(), ['-C', workspace, 'check-ignore', '-q', '--', rel], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return checked.status === 0;
}

function observedLayout(workspace, inGit) {
  const tops = new Set();
  if (inGit) {
    for (const rel of listedPaths(workspace)) {
      const top = rel.split('/')[0];
      if (top && !SKIP_TOPS.has(top)) tops.add(top);
    }
  } else {
    let entries = [];
    try {
      entries = fs.readdirSync(workspace);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!name || name.startsWith('.') || SKIP_TOPS.has(name)) continue;
      tops.add(name);
    }
  }
  return [...tops].sort().slice(0, OBSERVED_CAP);
}

function fence(name) {
  return String(name).replace(/[`\r\n]/g, "'");
}

function layoutLines(observed) {
  if (!observed.length) return '- _(no tracked files yet)_';
  return observed.map((name) => `- \`${fence(name)}\``).join('\n');
}

function specTemplate(observed) {
  return `# Product overview

Starter spec for a brownfield Harness install. Humans and POs edit this file.
\`ae prepare\` skips it once it exists. Plan lock hashes this path; later
edits do not fail the implement gate. Do not rewrite this file from the code
in silence.

## TODO

- [ ] Name the product and who it serves
- [ ] Describe the main modules and how they talk
- [ ] List behaviors later plans must honor

## Observed layout

Top-level paths seen when this file was created. Edit freely.

${layoutLines(observed)}
`;
}

function adrTemplate(observed) {
  return `# ADR 0000: Architecture snapshot

Status: draft

Starter architecture note for a brownfield Harness install. Humans and POs
edit this file. \`ae prepare\` skips it once it exists. Plan lock hashes
this path. Do not rewrite this file from the code in silence.

## TODO

- [ ] Record the runtime, persistence, and deploy shape
- [ ] Name the module boundaries later plans must honor

## Context

Brownfield install. Observed top-level paths at prepare time:

${layoutLines(observed)}

## Decision

- [ ] Write the current architecture here

## Consequences

- [ ] Note what a later change must not silently undo
`;
}

function templateFor(kind, observed) {
  if (kind === 'spec') return specTemplate(observed);
  if (kind === 'adr') return adrTemplate(observed);
  throw new Error(`unknown prepare kind: ${kind}`);
}

function occupant(full) {
  try {
    return fs.lstatSync(full);
  } catch {
    return null;
  }
}

function fileEntry(item, status, extra = {}) {
  return { path: item.rel, kind: item.kind, status, ...extra };
}

export function prepareNextTool(workspace) {
  if (!gitWorkTree(workspace)) return 'ae prepare';
  if (PREPARE_FILES.every((item) => pathIgnored(workspace, item.rel))) {
    return 'un-ignore docs/specs and docs/adr, then ae prepare';
  }
  return 'ae prepare';
}

export function prepareIntentSources({ workspace, dryRun = false }) {
  const inGit = gitWorkTree(workspace);
  const observed = observedLayout(workspace, inGit);
  const files = [];
  for (const item of PREPARE_FILES) {
    const full = path.join(workspace, item.rel);
    const ignored = inGit && pathIgnored(workspace, item.rel);
    const stat = occupant(full);
    if (stat && (stat.isFile() || stat.isSymbolicLink())) {
      files.push(fileEntry(item, 'skipped', ignored ? { ignored: true } : {}));
      continue;
    }
    if (stat) {
      files.push(fileEntry(item, 'refused'));
      continue;
    }
    if (ignored) {
      files.push(fileEntry(item, 'ignored', { ignored: true }));
      continue;
    }
    if (!assertNoSymlinkAncestors(workspace, item.rel)) {
      files.push(fileEntry(item, 'refused'));
      continue;
    }
    if (dryRun) {
      files.push(fileEntry(item, 'would-create'));
      continue;
    }
    let written = null;
    try {
      written = writeFileContainedExclusive(workspace, item.rel, templateFor(item.kind, observed));
    } catch {
      written = null;
    }
    if (!written) {
      const landed = occupant(full);
      if (landed && (landed.isFile() || landed.isSymbolicLink())) {
        files.push(fileEntry(item, 'skipped'));
        continue;
      }
    }
    files.push(fileEntry(item, written ? 'created' : 'refused'));
  }
  return {
    created: files.filter((file) => file.status === 'created').length,
    skipped: files.filter((file) => file.status === 'skipped').length,
    git: inGit,
    files,
  };
}

export async function cmdPrepare(argv) {
  let workspace = process.cwd();
  let json = false;
  let dryRun = false;
  const boundary = argv.indexOf('--');
  const scan = boundary === -1 ? argv : argv.slice(0, boundary);
  for (let i = 0; i < scan.length; i++) {
    const token = scan[i];
    const next = () => scan[++i];
    if (token === '--workspace' || token.startsWith('--workspace=')) {
      const value = token === '--workspace' ? next() : token.slice('--workspace='.length);
      if (!value || value.startsWith('--')) throw Object.assign(new Error('prepare: --workspace requires a path'), { code: 'E_USAGE', exit: 2 });
      workspace = path.resolve(value);
    }
    else if (token === '--json') json = true;
    else if (token === '--dry-run') dryRun = true;
  }
  const result = prepareIntentSources({ workspace, dryRun });
  if (json) console.log(redactedJson(result));
  else {
    const ui = createStyle();
    const refused = result.files.some((file) => file.status === 'refused' || file.status === 'ignored');
    const ignoredCount = result.files.filter((file) => file.ignored).length;
    let note = dryRun
      ? result.files.some((file) => file.status === 'would-create')
        ? 'would create starter spec and ADR'
        : 'nothing to write'
      : result.created
        ? `created ${result.created}`
        : result.skipped
          ? `skipped ${result.skipped} existing`
          : 'nothing to write';
    if (!result.git) note = `${note}; not a git repo`;
    else if (ignoredCount) note = `${note}; ${ignoredCount} gitignored`;
    console.log(
      ui.line({
        state: refused || !result.git ? 'warn' : 'ok',
        key: 'prepare',
        value: note,
      })
    );
  }
  return EXIT.ok;
}
