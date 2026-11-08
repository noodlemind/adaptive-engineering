import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAdaptiveLifecycle } from '../eval/adaptive/lifecycle.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const caseIndex = process.argv.indexOf('--case');
const report = runAdaptiveLifecycle({ packageRoot, keepArtifacts: process.argv.includes('--keep'), ...(caseIndex >= 0 ? { corpora: [process.argv[caseIndex + 1]] } : {}) });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.pass && report.fullCorpusUnchanged ? 0 : 1;
