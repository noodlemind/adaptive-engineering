import fs from 'node:fs';
import path from 'node:path';
import { inspectCheckReadiness } from './check-readiness.mjs';
import { workspaceRunnerStatus } from './resolve-harness-bin.mjs';
import { trustStatus, formatTrustRecovery } from './trust.mjs';

export function readWorkspaceOutcome({ workspace, home, copilotHome, skillsHome }) {
  const result = { path: path.resolve(workspace), status: 'unavailable', runner: null, authority: null, checkReadiness: null, trust: null, nextActions: [] };
  try {
    if (!fs.statSync(result.path).isDirectory()) throw new Error('Workspace is not a directory');
    result.runner = workspaceRunnerStatus(result.path);
    result.checkReadiness = inspectCheckReadiness({ workspace: result.path, home, copilotHome, skillsHome });
    result.trust = trustStatus({ workspace: result.path, home, copilotHome, skillsHome, readOnly: true });
    result.authority = result.trust.authority;
    if (result.checkReadiness.remediation) result.nextActions.push(result.checkReadiness.remediation);
    const runnerBlocked = ['unsafe', 'custom', 'newer', 'stale'].includes(result.runner.state);
    if (runnerBlocked) result.nextActions.push({ owner: 'engineer', message: `Inspect the ${result.runner.state} workspace runner at ${result.runner.path}; preserve it and use the installed AE runtime directly until the runner conflict is resolved.`, command: null });
    if (result.trust.recovery && result.checkReadiness.ready) result.nextActions.push(result.trust.recovery);
    else if (result.trust.recovery?.owner === 'engineer') result.nextActions.push({ ...result.trust.recovery, afterInspection: null });
    result.status = result.checkReadiness.ready && result.trust.trusted && !runnerBlocked ? 'prerequisites-ready' : 'blocked';
  } catch (error) {
    result.reason = error.message;
  }
  return result;
}

export function formatWorkspaceOutcome(workspace) {
  const lines = [`workspace ${workspace.status}: ${workspace.path}`];
  if (workspace.reason) lines.push(workspace.reason);
  if (workspace.checkReadiness) lines.push(`checks ${workspace.checkReadiness.status}: ${workspace.checkReadiness.source || workspace.checkReadiness.message}`);
  if (workspace.trust) lines.push(`trust ${workspace.trust.state}: ${workspace.trust.reason}`);
  for (const action of workspace.nextActions) {
    lines.push(`${action.owner}: ${formatTrustRecovery(action)}`);
  }
  return lines.join('\n');
}
