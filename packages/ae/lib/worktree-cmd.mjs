import path from 'node:path';
import { createStyle, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { addIsolatedWorktree } from './worktree.mjs';
import { parseFlags } from './flags.mjs';
import { readWorkspaceOutcome, formatWorkspaceOutcome } from './workspace-outcome.mjs';

export async function cmdWorktree(argv) {
  let workspace = process.cwd();
  let json = false;
  let dryRun = false;
  let slug;
  let from;
  const boundary = argv.indexOf('--');
  const scan = boundary === -1 ? argv : argv.slice(0, boundary);
  for (let i = 0; i < scan.length; i++) {
    const token = scan[i];
    const next = () => scan[++i];
    if (token === '--slug') slug = next();
    else if (token === '--from') from = next();
    else if (token === '--workspace' || token.startsWith('--workspace=')) {
      const value = token === '--workspace' ? next() : token.slice('--workspace='.length);
      if (!value || value.startsWith('--')) throw Object.assign(new Error('worktree: --workspace requires a path'), { code: 'E_USAGE', exit: 2 });
      workspace = path.resolve(value);
    }
    else if (token === '--json') json = true;
    else if (token === '--dry-run') dryRun = true;
  }
  const result = addIsolatedWorktree({ workspace, slug, from, dryRun });
  const flags = parseFlags(scan);
  result.workspace = readWorkspaceOutcome({ workspace: result.path, home: flags.harnessHome, copilotHome: flags.copilotHome, skillsHome: flags.skillsHome });
  if (json) console.log(redactedJson(result));
  else {
    const ui = createStyle();
    console.log(
      ui.line({
        state: 'ok',
        key: 'worktree',
        value: result.path,
        note: `${result.branch}${result.created ? '' : ' (existing)'}`,
      })
    );
    console.log(formatWorkspaceOutcome(result.workspace));
  }
  return EXIT.ok;
}
