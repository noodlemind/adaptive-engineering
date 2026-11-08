import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2] && path.resolve(process.argv[2]);
if (!output || fs.existsSync(output)) throw new Error('Provide a new output directory.');
const repository = process.env.GITHUB_REPOSITORY || 'noodlemind/adaptive-engineering';
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository identity.');
const source = `https://github.com/${repository}/blob/main`;
fs.cpSync(path.join(root, 'docs/site'), output, { recursive: true });
const pages = [
  ['README.md', 'index.md', '/', 'Adaptive Engineering'],
  ['docs/getting-started.md', 'getting-started.md', '/getting-started/', 'Getting started'],
  ['docs/using-ae.md', 'using-ae.md', '/using-ae/', 'Using AE'],
  ['docs/hosts.md', 'hosts.md', '/hosts/', 'Hosts'],
  ['docs/adaptive-engineering.md', 'concept.md', '/concept/', 'How Adaptive Engineering works'],
  ['docs/migration/ae.md', 'migration.md', '/migration/', 'Migrate to ae'],
  ['docs/reference/project-setup.md', 'reference/project-setup.md', '/reference/project-setup/', 'Project setup and trust'],
  ['docs/reference/plans-and-proof.md', 'reference/plans-and-proof.md', '/reference/plans-and-proof/', 'Plans, gates and proof'],
  ['docs/reference/verification.md', 'reference/verification.md', '/reference/verification/', 'Product verification'],
  ['docs/reference/context.md', 'reference/context.md', '/reference/context/', 'Context and recovery'],
  ['docs/reference/structural-knowledge.md', 'reference/structural-knowledge.md', '/reference/structural-knowledge/', 'Structural knowledge'],
  ['docs/reference/workspace-layout-detection.md', 'reference/workspace-layout-detection.md', '/reference/workspace-layout-detection/', 'Workspace binding'],
  ['docs/reference/domains.md', 'reference/domains.md', '/reference/domains/', 'Domains'],
  ['docs/reference/flows.md', 'reference/flows.md', '/reference/flows/', 'Flow models and diagrams'],
  ['docs/reference/performance.md', 'reference/performance.md', '/reference/performance/', 'Performance analysis'],
  ['docs/reference/experiments.md', 'reference/experiments.md', '/reference/experiments/', 'Bounded experiments'],
  ['docs/reference/capability-lifecycle.md', 'reference/capability-lifecycle.md', '/reference/capability-lifecycle/', 'Adaptive capability lifecycle'],
  ['docs/reference/model-preferences.md', 'reference/model-preferences.md', '/reference/model-preferences/', 'Model preferences'],
];
const permalinks = new Map(pages.map(([input, , permalink]) => [input, permalink]));

// Published pages link to each other on the site; every other repository path links to GitHub.
// Fenced and inline code is copied unchanged.
function rewriteLinks(content, input) {
  return content.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, index) => (index % 2 ? part : rewriteProse(part, input))).join('');
}

function rewriteProse(content, input) {
  return content.replace(/\]\(([^)\s]+)\)/g, (match, href) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || /^[#?]/.test(href)) return match;
    const [target, anchor] = href.split('#');
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(input), target));
    if (resolved.startsWith('..')) return match;
    const suffix = anchor === undefined ? '' : `#${anchor}`;
    const permalink = permalinks.get(resolved);
    return permalink ? `]({{ "${permalink}" | relative_url }}${suffix})` : `](${source}/${resolved}${suffix})`;
  });
}

for (const [input, destination, permalink, title] of pages) {
  const content = rewriteLinks(fs.readFileSync(path.join(root, input), 'utf8'), input);
  fs.mkdirSync(path.dirname(path.join(output, destination)), { recursive: true });
  fs.writeFileSync(path.join(output, destination), `---\nlayout: default\ntitle: ${title}\npermalink: ${permalink}\n---\n\n${content}`);
}
fs.writeFileSync(path.join(output, '_config.yml'), `title: Adaptive Engineering\nrepository: ${repository}\nbaseurl: /${repository.split('/')[1]}\nmarkdown: kramdown\nexclude: [README.md]\n`);
console.log(output);
