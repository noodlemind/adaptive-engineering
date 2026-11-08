import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

/** Workflow dependency closure, deliberately excluding every domain specialist.
 * The sparse case below also removes optional planning/design procedures. Neither
 * selection edits the source corpus or relies on a second corpus search path.
 */
export const CORE_CORPUS_MANIFEST = Object.freeze({
  schema: 1,
  skills: Object.freeze(['engineer', 'ensure-plan', 'create-primitive', 'ensure-capability', 'code-review', 'document-review', 'recall', 'compound-learnings', 'consolidate', 'index-memory', 'auto-compound', 'auto-skill-draft', 'setup-models', 'architect', 'plan-issue', 'caffeinated', 'capture-issue', 'codebase-context']),
  agents: Object.freeze(['engineer', 'decision-agent']),
  instructions: Object.freeze(['harness-global']),
  shared: Object.freeze(['skills/references', 'skills/codebase-context/references/diagrams.md', 'skills/codebase-context/references/flow-models.md', 'hooks', 'hosts', 'knowledge', 'copilot-instructions.md']),
  bootstrapSkills: Object.freeze(['engineer', 'ensure-plan', 'create-primitive', 'ensure-capability']),
  optionalSkillDependencies: Object.freeze(['code-review', 'document-review', 'recall', 'compound-learnings', 'consolidate', 'index-memory', 'auto-compound', 'auto-skill-draft', 'setup-models', 'architect', 'plan-issue', 'caffeinated', 'capture-issue', 'codebase-context']),
  reason: 'Engineer activation, plan operations, primitive creation, review, recall and compounding retain their complete references. Domain judgment is supplied by consented external or acquired resources.',
});

function walk(directory, prefix = '') {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Corpus fixture refuses a symbolic link: ${rel}`);
    return entry.isDirectory() ? walk(path.join(directory, entry.name), rel) : [rel];
  });
}

export function corpusDigest(corpus) {
  const hash = createHash('sha256');
  for (const rel of walk(corpus)) hash.update(rel).update('\0').update(fs.readFileSync(path.join(corpus, rel))).update('\0');
  return hash.digest('hex');
}

export function corpusInventory(corpus) {
  const names = (section, extension) => fs.existsSync(path.join(corpus, section)) ? fs.readdirSync(path.join(corpus, section)).filter(name => extension ? name.endsWith(extension) : fs.existsSync(path.join(corpus, section, name, 'SKILL.md'))).sort() : [];
  return { skills: names('skills').length, agents: names('agents', '.agent.md').length, instructions: names('instructions', '.instructions.md').length };
}

export function materializeMinimalCorpus(installedPackageRoot, { sparse = false } = {}) {
  const authoredPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  if (fs.realpathSync(installedPackageRoot) === fs.realpathSync(authoredPackageRoot)) throw new Error('Reduced-corpus evaluation requires a disposable installed package; refusing to prune the source corpus');
  const corpus = path.join(installedPackageRoot, 'corpus');
  const retainedReferences = new Map(CORE_CORPUS_MANIFEST.shared.filter(relative => relative.endsWith('.md') && relative.startsWith('skills/')).map(relative => [relative, fs.readFileSync(path.join(corpus, relative))]));
  const skills = CORE_CORPUS_MANIFEST.skills.filter(name => !sparse || !CORE_CORPUS_MANIFEST.optionalSkillDependencies.includes(name));
  for (const name of skills) if (!fs.existsSync(path.join(corpus, 'skills', name, 'SKILL.md'))) throw new Error(`Minimal core dependency is absent: skill ${name}`);
  for (const name of CORE_CORPUS_MANIFEST.agents) if (!fs.existsSync(path.join(corpus, 'agents', `${name}.agent.md`))) throw new Error(`Minimal core dependency is absent: agent ${name}`);
  for (const [section, keep, suffix] of [['skills', [...skills, 'references'], ''], ['agents', CORE_CORPUS_MANIFEST.agents, '.agent.md'], ['instructions', CORE_CORPUS_MANIFEST.instructions, '.instructions.md']]) {
    for (const name of fs.readdirSync(path.join(corpus, section))) if (!keep.includes(suffix ? name.replace(suffix, '') : name)) fs.rmSync(path.join(corpus, section, name), { recursive: true, force: true });
  }
  for (const [relative, bytes] of retainedReferences) {
    fs.mkdirSync(path.dirname(path.join(corpus, relative)), { recursive: true });
    fs.writeFileSync(path.join(corpus, relative), bytes);
  }
  // A reduced role set must not advertise removed roles as present delegates.
  const adapters = path.join(corpus, 'hosts', 'engineer-adapters.json');
  if (fs.existsSync(adapters)) {
    const metadata = JSON.parse(fs.readFileSync(adapters, 'utf8'));
    for (const adapter of Object.values(metadata.adapters || {})) if (Array.isArray(adapter.frontmatter?.agents)) adapter.frontmatter.agents = adapter.frontmatter.agents.filter(name => CORE_CORPUS_MANIFEST.agents.includes(name));
    fs.writeFileSync(adapters, `${JSON.stringify(metadata, null, 2)}\n`);
  }
  const engineer = path.join(corpus, 'agents', 'engineer.agent.md');
  const document = fs.readFileSync(engineer, 'utf8');
  const header = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(document);
  if (header) {
    const metadata = YAML.parse(header[1]);
    if (Array.isArray(metadata.agents)) metadata.agents = metadata.agents.filter(name => CORE_CORPUS_MANIFEST.agents.includes(name));
    fs.writeFileSync(engineer, `---\n${YAML.stringify(metadata, { lineWidth: 0 })}---\n${document.slice(header[0].length)}`);
  }
  return { ...corpusInventory(corpus), manifest: { ...CORE_CORPUS_MANIFEST, skills }, sparse };
}
