import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { verbOf } from './positionals.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { approveProject, revokeProject, trustStatus, formatTrustRecovery } from './trust.mjs';
import { inspectCheckReadiness } from './check-readiness.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export const TRUST_VERBS = Object.freeze(['status', 'approve', 'revoke']);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

function context(argv) {
  const flags = parseFlags(argv);
    const verb = verbOf(argv, TRUST_VERBS, { fallback: 'status' });
  return {
    flags,
    verb,
    workspace: path.resolve(flags.workspace),
    copilotHome: resolveCopilotHome(flags.copilotHome),
  };
}

export async function trustResultOf(argv, ctx = {}) {
  const { verb, workspace, copilotHome, flags } = context(argv);
  if (!TRUST_VERBS.includes(verb)) {
    throw usageError(`unknown trust verb: ${verb}`, `one of ${TRUST_VERBS.join(', ')}`);
  }

  if (verb === 'status') return { verb, ...trustStatus({ workspace, copilotHome, home: flags.harnessHome }), checkReadiness: inspectCheckReadiness({ workspace, copilotHome, home: flags.harnessHome }) };

  const before = trustStatus({ workspace, copilotHome, home: flags.harnessHome });
  const after = verb === 'approve'
    ? approveProject({ workspace, copilotHome, home: flags.harnessHome })
    : revokeProject({ workspace, copilotHome, home: flags.harnessHome });

    const events = ctx?.events;
  const sink = typeof events?.withCommand === 'function' ? events.withCommand('trust') : events;
  sink?.emit?.('trust', {
    result: 'pass',
    status: 'ok',
    trust: {
      verb,
      project: after.project,
      id: after.id,
      from: before.state,
      to: after.state,
      digest: after.digest,
    },
  });

  return { verb, ...after, previousState: before.state };
}

const STATE_STYLE = { trusted: 'ok', untrusted: 'warn', stale: 'warn', revoked: 'error' };

export async function cmdTrust(argv, ctx = {}) {
  const { flags } = context(argv);
  const result = await trustResultOf(argv, ctx);

  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
  } else {
    const keyWidth = keyWidthFor(['project', 'trust', 'pinned', 'store']);
    console.log(ui.line({ state: STATE_STYLE[result.state] || 'warn', key: 'trust', value: result.state, note: result.reason, keyWidth }));
    if (result.inherited) console.log(ui.line({ key: 'inherited', value: result.inheritedFrom, keyWidth }));
    console.log(ui.line({ key: 'project', value: result.project, keyWidth }));
    console.log(ui.line({ key: 'pinned', value: result.pinned.join(', '), keyWidth }));
    console.log(ui.line({ key: 'store', value: result.store, keyWidth }));
    if (result.checkReadiness && !result.checkReadiness.ready) console.log(ui.line({ state: 'warn', key: 'checks', value: result.checkReadiness.status, note: 'Engineer prepares concrete verification commands before delivery; trust is a separate decision', keyWidth }));
    if (result.recovery) console.log(ui.paint('muted', `  ${formatTrustRecovery(result.recovery)}`));
  }

    return 0;
}
