import { planRecordRoot } from './domain-context.mjs';
import fs from 'fs';
import path from 'path';
import { runBuildPostingsIndex } from './postings-index.mjs';
import { resolveIndexDir } from './recall-config.mjs';
import { readFileNoFollow, assertNoSymlinkAncestors, writeFileContained } from './fs-safe.mjs';
import { solutionsScanRoots } from './project-layout.mjs';
import { withPlanUpdateLock } from './plan-update.mjs';
import YAML from 'yaml';
import { repoId } from './knowledge/store.mjs';
import { manifestCorpusContent, projectManifestContent, PROJECT_MANIFEST_FILE } from './knowledge-manifest.mjs';

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function summaryFromBody(text) {
  const prob = text.match(/## Problem\s*\n+([^\n#]+)/i);
  if (prob) return prob[1].trim().slice(0, 200);
  return (
    text
      .replace(/^---[\s\S]*?---\n/, '')
      .trim()
      .split('\n')
      .find((l) => l.trim())
      ?.slice(0, 200) || ''
  );
}

function excerptFromBody(text) {
  const body = text.replace(/^---[\s\S]*?---\n/, '').trim();
  const prob = body.match(/## Problem\s*\n+([\s\S]*?)(?=\n## |\n# |$)/i);
  const source = prob ? prob[1].trim() : body;
  return source.replace(/\s+/g, ' ').slice(0, 400);
}

function yamlQuote(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Same physical-containment pattern collectEpisodes (consolidate.mjs) uses:
 * every candidate — the scanned root directory itself, each category
 * directory, and each file — is validated with assertNoSymlinkAncestors
 * (fs-safe.mjs) against `base`, never trusted merely because it was
 * lexically reachable under `dir`. This manifest builder reads the SAME
 * docs/solutions trees collectEpisodes scans and feeds title/summary/
 * excerpt straight into recall's manifest — a symlinked docs/solutions (or a
 * symlinked category directory) previously had no containment check at all
 * here, not even a lexical one, and would leak outside file content into the
 * manifest the same way collectEpisodes did before it was hardened.
 */
function collectSolutions(dir, scope, base) {
  const entries = [];
  if (!fs.existsSync(dir)) return entries;
  const dirRel = path.relative(base, dir);
  if (!assertNoSymlinkAncestors(base, dirRel)) return entries;
  for (const cat of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!cat.isDirectory()) continue;
    const catRel = path.join(dirRel, cat.name);
    if (!assertNoSymlinkAncestors(base, catRel)) continue; // symlinked category directory
    const catPath = path.join(dir, cat.name);
    for (const f of fs.readdirSync(catPath)) {
      if (!f.endsWith('.md') || f === 'README.md') continue;
      const fileRel = path.join(catRel, f);
      const full = assertNoSymlinkAncestors(base, fileRel);
      if (!full) continue; // symlinked leaf (or any ancestor) — never follow
      // `root: base` → readFileNoFollow verifies the opened inode's realpath
      // is contained under the real base (canonicalize-after-acquire), closing
      // the ancestor-swap window between the walk above and this read.
      const text = readFileNoFollow(full, { root: base });
      if (text === null) continue;
      const fm = parseFrontmatter(text);
      const rel = fileRel.split(path.sep).join('/');
      const slug = f.replace(/\.md$/, '');
      const entryId = `${scope}-${cat.name}-${slug}`;
      entries.push({
        id: entryId,
        docid: entryId,
        kind: fm.kind === 'insight' ? 'insight' : 'solution',
        scope,
        path: rel,
        title: fm.title || slug,
        category: fm.category || cat.name,
        tags: fm.tags ? fm.tags.split(',').map((t) => t.trim()) : [],
        module: fm.module || '',
        symptom: fm.symptom || '',
        trigger: fm.trigger || '',
        claim: fm.claim || '',
        summary: summaryFromBody(text),
        excerpt: excerptFromBody(text),
        date: fm.date || fm.updated || '',
        updated: fm.updated || fm.date || '',
      });
    }
  }
  return entries;
}

export function withKnowledgeIndexLock(options, action) {
  if (options.plan?.fm?.domain_parent) {
    const root = planRecordRoot(options.workspace, options.plan);
    for (const rel of ['.harness/knowledge', '.harness/knowledge/manifest.yaml', '.harness/knowledge-index', '.harness/knowledge-index/postings.json', '.harness/knowledge-index/meta.json']) {
      if (!assertNoSymlinkAncestors(root, rel)) throw new Error('Private domain index store is unsafe or symlinked');
    }
  }
  const rebuild = () => rebuildKnowledgeIndex(options);
  const manifestRoot = options.knowledgeRoot || (options.copilotHome ? path.join(options.copilotHome, 'knowledge') : null);
  if (options.flags.dryRun || !manifestRoot) return action(rebuild);
  fs.mkdirSync(manifestRoot, { recursive: true });
  const manifestPath = path.join(fs.realpathSync(manifestRoot), 'manifest.yaml');
  return withPlanUpdateLock(manifestPath, () => action(rebuild));
}

export function runIndexKnowledge(options) {
  return withKnowledgeIndexLock(options, rebuild => rebuild());
}

function rebuildKnowledgeIndex({ knowledgeRoot, workspace, copilotHome, flags, log, home, plan = null }) {
  const roots = [];
  const manifestRoot = knowledgeRoot || (copilotHome ? path.join(copilotHome, 'knowledge') : null);
  if (manifestRoot) {
    roots.push({
      dir: path.join(manifestRoot, 'solutions'),
      scope: 'global',
      base: manifestRoot,
    });
  }
  for (const scanned of solutionsScanRoots(workspace, { home: home ?? flags?.home })) {
    roots.push({
      dir: scanned.dir,
      scope: scanned.kind === 'user' ? 'product-user' : 'product',
      base: scanned.base,
    });
  }

  if (plan?.fm?.domain_parent) {
    const base = planRecordRoot(workspace, plan);
    roots.push({ dir: path.join(base, 'docs/solutions'), scope: `domain-${plan.fm.domain_parent.name}`, base });
  }
  const selectedIndexDir = plan?.fm?.domain_parent ? path.join(planRecordRoot(workspace, plan), '.harness/knowledge-index') : null;
  let entries = [];
  for (const { dir, scope, base } of roots) {
    entries = entries.concat(collectSolutions(dir, scope, base));
  }

  const seenIds = new Map();
  for (const e of entries) {
    const prior = seenIds.get(e.id);
    if (prior) {
      throw new Error(`duplicate manifest id "${e.id}" — ${prior} and ${e.scope}:${e.path}`);
    }
    seenIds.set(e.id, `${e.scope}:${e.path}`);
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));

  if (!manifestRoot) {
    throw new Error('ae index needs a copilot home; it does not write knowledge/ into the repository');
  }
  const manifestPath = path.join(manifestRoot, 'manifest.yaml');
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    '# Team knowledge index — rebuilt by ae index',
    'version: 1',
    `updated: ${today}`,
    `repository: ${yamlQuote(repoId(workspace))}`,
    'entries:',
  ];
  for (const e of entries) {
    lines.push(`  - id: ${e.id}`);
    lines.push(`    docid: ${e.docid}`);
    lines.push(`    kind: ${e.kind}`);
    lines.push(`    scope: ${e.scope}`);
    lines.push(`    path: ${e.path}`);
    lines.push(`    title: ${yamlQuote(e.title)}`);
    lines.push(`    category: ${e.category}`);
    if (e.tags?.length) lines.push(`    tags: [${e.tags.map((t) => yamlQuote(t)).join(', ')}]`);
    if (e.module) lines.push(`    module: ${yamlQuote(e.module)}`);
    if (e.symptom) lines.push(`    symptom: ${yamlQuote(e.symptom)}`);
    if (e.trigger) lines.push(`    trigger: ${yamlQuote(e.trigger)}`);
    if (e.claim) lines.push(`    claim: ${yamlQuote(e.claim)}`);
    if (e.date) lines.push(`    date: ${e.date}`);
    if (e.summary) lines.push(`    summary: ${yamlQuote(e.summary)}`);
    if (e.excerpt) lines.push(`    excerpt: ${yamlQuote(e.excerpt)}`);
  }

  const body = lines.join('\n') + '\n';
  const manifestEntries = YAML.parse(body).entries || [];
  const corpus = manifestCorpusContent(manifestEntries);
  const projectManifest = projectManifestContent(repoId(workspace), today, manifestEntries);
  if (flags.dryRun) {
    log(`would write ${manifestPath} (${entries.length} entries)`);
    const indexDir = selectedIndexDir || resolveIndexDir(copilotHome || '', workspace, home);
    runBuildPostingsIndex({ entries, indexDir, manifestUpdated: today, manifestContent: corpus, projectManifest, flags });
    log(`would write ${indexDir} (${entries.length} postings)`);
    return { entries: entries.length, manifestPath, indexDir };
  }
  const indexDir = selectedIndexDir || resolveIndexDir(copilotHome || '', workspace, home);
  const previous = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath) : null;
  const before = [PROJECT_MANIFEST_FILE, 'postings.json', 'meta.json'].map(name => {
    const full = path.join(indexDir, name);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!stat) return [name, null];
    const bytes = readFileNoFollow(full, { root: indexDir, encoding: null });
    if (bytes === null) throw new Error(`knowledge index ${name} is unsafe or unreadable`);
    return [name, { bytes, mode: stat.mode & 0o777 }];
  });
  let indexResult;
  try {
    writeManifestAtomic(manifestPath, body);
    log(`wrote ${manifestPath} (${entries.length} entries)`);
    indexResult = runBuildPostingsIndex({
      entries,
      indexDir,
      manifestUpdated: today,
      manifestContent: corpus,
      projectManifest,
      flags,
    });
  } catch (error) {
    if (previous === null) fs.rmSync(manifestPath, { force: true });
    else writeManifestAtomic(manifestPath, previous);
    const failed = [];
    for (const [name, snapshot] of before) {
      try {
        if (snapshot === null) fs.rmSync(path.join(indexDir, name), { force: true });
        else if (!writeFileContained(indexDir, name, snapshot.bytes, { mode: snapshot.mode })) failed.push(name);
      } catch { failed.push(name); }
    }
    if (failed.length) throw new Error(`knowledge index rebuild failed and rollback is incomplete (${failed.join(', ')}): ${error.message}`);
    throw error;
  }
  log(`wrote ${indexDir} (${indexResult.entryCount} postings)`);

  return { entries: entries.length, manifestPath, indexDir, indexEntries: indexResult.entryCount };
}

function writeManifestAtomic(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  const mode = stat ? stat.mode & 0o777 : 0o600;
  if (!writeFileContained(path.dirname(file), path.basename(file), body, { mode })) throw new Error('knowledge manifest publication failed');
}
