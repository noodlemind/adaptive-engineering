const MAX_FAILURES = 20;
const MAX_BYTES = 16_384;

const INSTALL_CHECKS = new Set(['H1', 'H2', 'H3', 'H4', 'H7', 'H9', 'H12', 'H14', 'H15', 'A1']);
const PLAN_CHECKS = new Set(['C1', 'C1a', 'C1b', 'C2', 'C3', 'C4', 'C-goal', 'C-plan-schema']);

function recoveryFor(source, check, target) {
  if (source === 'doctor') {
    if (check.id === 'H7' && check.remediation === 'capability-acquisition') return { category: 'capability', guidance: 'Inspect consented sources and restore an included current skill, or acquire the missing procedure through /create-primitive within standing authority. Reinstallation is not required for an intentionally reduced corpus.' };
    if (check.id === 'H8') return { category: 'installation', guidance: 'Reinstall the packaged CLI from the selected package source, then rerun doctor.' };
    if (check.id === 'V3' && target === 'vscode') return { category: 'installation', command: ['install', '--target', target, '--configure-vscode'] };
    if (INSTALL_CHECKS.has(check.id) || check.id === 'T2' && target === 'intellij'
      || ['V1', 'V2'].includes(check.id) && target === 'vscode' || ['C1', 'C2'].includes(check.id) && target === 'cli') {
      return { category: 'installation', command: [check.id === 'H9' ? 'upgrade' : 'install', '--target', target || 'cli'] };
    }
    if (['H10', 'H11'].includes(check.id)) return { category: 'index', command: ['index'] };
    return { category: 'environment', guidance: 'Inspect this readiness check and its hint before changing the environment.' };
  }
  if (check.id === 'C-intent-sources') return { category: 'intent', command: ['orient', '--read', '--context-version', '2'], guidance: 'Review the changed intent and submit an explicit amendment before another implement gate. Relocking does not accept changed intent.' };
  if (check.id === 'C-worktree') return { category: 'isolation', guidance: 'Use ae worktree with an authored task slug, then orient in that worktree before editing.' };
  if (check.id === 'CAP') return { category: 'capability', guidance: 'Read ensure-capability/SKILL.md and resolve the declared gap within the accepted scope.' };
  if (check.id === 'V1') return { category: 'verification', command: ['status', '--validate-evidence'], guidance: 'Inspect current evidence and repair its prerequisite before requesting fresh verification.' };
  if (PLAN_CHECKS.has(check.id)) return { category: 'plan', command: ['orient', '--read', '--context-version', '2'], guidance: 'Inspect the plan and use an accepted plan decision to repair the reported prerequisite.' };
  return { category: 'prerequisite', guidance: 'Inspect the failed check and repair its prerequisite through the existing lifecycle. This diagnostic grants no additional authority.' };
}

export function recoveryDiagnostics({ source, checks, workspace, copilotHome, home, plan = null, domain = null, target = null }) {
  const scope = ['--workspace', workspace];
  if (copilotHome) scope.push('--copilot-home', copilotHome);
  if (home) scope.push('--ae-home', home);
  const failed = checks.filter(check => check.pass === false);
  const failures = failed.slice(0, MAX_FAILURES).map(check => {
    const recovery = recoveryFor(source, check, target);
    const nextActions = [];
    const command = domain ? ['domain', 'status', '--name', domain] : recovery.command;
    if (command) nextActions.push({ kind: 'command', argv: ['ae', ...command, ...(plan && source === 'gate' ? ['--plan', plan] : []), ...scope] });
    if (recovery.guidance) nextActions.push({ kind: 'guidance', text: recovery.guidance });
    return {
      checkId: check.id,
      category: recovery.category,
      severity: check.optional || check.severity === 'warn' ? 'advisory' : 'blocking',
      message: String(check.message || check.hint || check.name || '').slice(0, 512),
      evidence: { checkId: check.id, plan },
      retry: { automatic: false, when: command ? 'after-action' : 'after-inspection' },
      nextActions,
    };
  });
  const result = { schema: 1, source, failures, total: failed.length, omitted: failed.length - failures.length };
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES && failures.length) {
    failures.pop();
    result.omitted++;
  }
  return result;
}
