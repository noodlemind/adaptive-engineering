import { gitExecutable } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { indexStatus } from './index-status.mjs';
import { runIndexKnowledge } from './index-knowledge.mjs';

function headSha(workspace) {
  const result = spawnSync(gitExecutable(), ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function needsBuild(plane, mode) {
  if (!plane?.indexed) return true;
  return mode === 'missing-or-stale' && Boolean(plane.stale);
}

/**
 * Build the existing knowledge and structural indexes. One plane failing
 * does not cancel the other. Callers decide whether a failure is advisory.
 */
export async function ensureIndexes({ workspace, copilotHome, mode = 'missing', dryRun = false, log = () => {} }) {
  const home = process.env.HARNESS_HOME;
  const before = indexStatus({ workspace, copilotHome, home });
  const report = {
    knowledge: { attempted: false, ok: true, error: null },
    structural: { attempted: false, ok: true, error: null },
  };
  const head = headSha(workspace);
  if (needsBuild(before.knowledge, mode)) {
    report.knowledge.attempted = true;
    try {
      const knowledgeRoot = path.join(copilotHome, 'knowledge');
      if (!dryRun) fs.mkdirSync(knowledgeRoot, { recursive: true });
      runIndexKnowledge({
        knowledgeRoot,
        workspace,
        copilotHome,
        flags: { dryRun, headSha: head, home },
        log,
        home,
      });
    } catch (error) {
      report.knowledge.ok = false;
      report.knowledge.error = error.message;
    }
  }
  if (needsBuild(before.structural, mode)) {
    report.structural.attempted = true;
    if (!dryRun) {
      try {
        const { buildStructuralIndex } = await import('./repo-map/structural-index.mjs');
        const { createTreesitterExtract } = await import('./repo-map/treesitter-extractor.mjs');
        const extractor = await createTreesitterExtract();
        const built = await buildStructuralIndex({
          workspace,
          home,
          extractor,
          dryRun,
          log,
        });
        if (head && !built.written) {
          report.structural.ok = false;
          report.structural.error = 'code index was not published';
        }
      } catch (error) {
        report.structural.ok = false;
        report.structural.error = error.message;
      }
    }
  }
  report.after = dryRun ? before : indexStatus({ workspace, copilotHome, home });
  return report;
}
