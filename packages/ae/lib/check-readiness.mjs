import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNamedChecks, validateCommand } from './checks.mjs';
import { projectAuthorityFile } from './project-authority.mjs';
import { harnessGlobalHome, resolveCopilotHome } from './paths.mjs';

/** A concrete invocation of this runtime, never a PATH alias or product binary. */
export function checkConfigurationCommand({ workspace, home, copilotHome, skillsHome, verb = 'configure' }) {
  const command = [fs.realpathSync(process.execPath), fileURLToPath(new URL('../bin/ae.mjs', import.meta.url)), 'checks', verb];
  if (verb === 'configure') command.push('--file', '-');
  command.push('--workspace', path.resolve(workspace), '--ae-home', path.resolve(home || harnessGlobalHome()), '--copilot-home', resolveCopilotHome(copilotHome));
  if (skillsHome || process.env.AE_SKILLS_HOME) command.push('--skills-home', path.resolve(skillsHome || process.env.AE_SKILLS_HOME));
  command.push('--json');
  return command;
}

/** Readiness means configured behavioral commands, never executed or adequate proof. */
export function inspectCheckReadiness({ workspace, home, copilotHome, skillsHome }) {
  let source;
  const bounded = value => String(value).slice(0, 512);
  const repair = (message, verb = 'configure') => ({ owner: 'engineer', message, command: checkConfigurationCommand({ workspace, home, copilotHome, skillsHome, verb }) });
  try {
    source = projectAuthorityFile(workspace, 'checks.yaml', { home });
    const loaded = loadNamedChecks(workspace, { home });
    const missing = !fs.lstatSync(source.path, { throwIfNoEntry: false });
    const checks = Object.keys(loaded.checks || {}).sort();
    const invalid = checks.map(name => ({ name, reason: validateCommand(name, loaded.checks[name]) })).filter(entry => entry.reason);
    const invalidNames = new Set(invalid.map(entry => entry.name));
    const behavioralChecks = checks.filter(name => !invalidNames.has(name) && loaded.checks[name].proof !== 'type-check');
    const status = missing ? 'missing' : loaded.error ? 'invalid' : behavioralChecks.length ? 'ready' : invalid.length ? 'invalid' : !checks.length ? 'empty' : 'unusable';
    const message = bounded(loaded.error || (status === 'ready'
      ? 'Behavioral checks are configured; inspect their assertions and bind relevant checks to task criteria. This is not a verification pass.'
      : status === 'unusable' ? 'Only type checks are configured; delivery needs a meaningful behavioral check.'
      : status === 'invalid' ? 'Repair invalid named check declarations before starting delivery.'
      : 'Engineer must inspect the project tests and prepare concrete named checks before starting delivery.'));
    return {
      status, ready: status === 'ready', source: source.path, sourceMode: source.mode,
      sourceDigest: loaded.sourceDigest || null, inspectionCommand: checkConfigurationCommand({ workspace, home, copilotHome, skillsHome, verb: 'list' }),
      checks: checks.slice(0, 20).map(name => name.slice(0, 160)), behavioralChecks: behavioralChecks.slice(0, 20).map(name => name.slice(0, 160)),
      invalid: invalid.slice(0, 8).map(entry => ({ name: entry.name.slice(0, 160), reason: bounded(entry.reason) })),
      totals: { checks: checks.length, behavioralChecks: behavioralChecks.length, invalid: invalid.length },
      omitted: { checks: Math.max(0, checks.length - 20), behavioralChecks: Math.max(0, behavioralChecks.length - 20), invalid: Math.max(0, invalid.length - 8) }, message,
      remediation: status === 'ready' ? null : repair(message, loaded.error && !missing ? 'list' : 'configure'),
    };
  } catch (error) {
    return { status: 'invalid', ready: false, source: source?.path || null, sourceMode: source?.mode || null, sourceDigest: null, checks: [], behavioralChecks: [], invalid: [], message: bounded(error.message), remediation: { owner: 'engineer', message: bounded(error.hint || error.message), command: null } };
  }
}
