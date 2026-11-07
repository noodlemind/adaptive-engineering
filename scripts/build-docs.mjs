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
  ['docs/adaptive-engineering.md', 'concept.md', '/concept/', 'How Adaptive Engineering works'],
  ['docs/migration/ae.md', 'migration.md', '/migration/', 'Migrate to ae'],
];
for (const [input, destination, permalink, title] of pages) {
  const content = fs.readFileSync(path.join(root, input), 'utf8')
    .replaceAll('(docs/adaptive-engineering.md)', '({{ "/concept/" | relative_url }})')
    .replaceAll('(docs/migration/ae.md)', '({{ "/migration/" | relative_url }})')
    .replaceAll('(migration/ae.md)', '({{ "/migration/" | relative_url }})')
    .replaceAll('(../packages/', `(${source}/packages/`);
  fs.writeFileSync(path.join(output, destination), `---\nlayout: default\ntitle: ${title}\npermalink: ${permalink}\n---\n\n${content}`);
}
fs.writeFileSync(path.join(output, '_config.yml'), `title: Adaptive Engineering\nrepository: ${repository}\nbaseurl: /${repository.split('/')[1]}\nmarkdown: kramdown\nexclude: [README.md]\n`);
console.log(output);
