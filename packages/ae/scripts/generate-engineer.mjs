import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEngineerExports, writeEngineerExports } from '../lib/hosts/engineer-exports.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 1 || !['--check', '--write'].includes(args[0])) {
  console.error('Usage: node scripts/generate-engineer.mjs --check|--write');
  process.exitCode = 2;
} else {
  try {
    const files = args[0] === '--write' ? writeEngineerExports(root) : checkEngineerExports(root);
    if (args[0] === '--check' && files.length) {
      console.error(`Engineer export drift: ${files.join(', ')}. Run npm run generate:engineer.`);
      process.exitCode = 1;
    } else console.log(args[0] === '--write' ? `Generated ${files.join(', ')}` : 'Engineer exports are current.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
