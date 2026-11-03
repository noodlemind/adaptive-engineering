import { resolveConfig } from './config.mjs';
import { isProjectTrusted } from './trust.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { DEFAULT_RETENTION_DAYS } from './retention.mjs';
import { withGitIdentityCache } from './git-observation-cache.mjs';

export function retentionDaysFor(workspace, flags = {}) {
  return withGitIdentityCache(() => readRetentionDays(workspace, flags));
}

function readRetentionDays(workspace, flags) {
  try {
    const copilotHome = resolveCopilotHome(flags.copilotHome);
    const policyWorkspace = flags.workspace || workspace;
    const config = resolveConfig({
      copilotHome,
      workspace: policyWorkspace,
      projectTrusted: isProjectTrusted({ workspace: policyWorkspace, copilotHome, home: flags.harnessHome }),
    });
    const days = config.values['runs.retention_days'];
    return Number.isInteger(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
  } catch {
    return DEFAULT_RETENTION_DAYS;
  }
}
