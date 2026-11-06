import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { authorityBin } from './authority-bin.mjs';
import { runtimeHome, runtimeCopilotHome } from './runtime-identity.mjs';
import { normalizeToolPayload } from './tool-payload.mjs';


/** Hydrated hooks resolve the installed package rather than importing a checkout. */
async function authority(payload) {
  // The imported packaged runtime must use the same binding as this copied
  // hook, including its closed command parser. This affects only this hook
  // process and never accepts a configuration root from the tool payload.
  process.env.COPILOT_HOME ||= runtimeCopilotHome();
  const bin = authorityBin();
  if (!bin) throw new Error('Installed AE decision authority is unavailable');
  const root = path.resolve(path.dirname(bin), '..');
  const [decision, catalog, session, safe] = await Promise.all([
    import(pathToFileURL(path.join(root, 'lib/decision-agent.mjs')).href),
    import(pathToFileURL(path.join(root, 'lib/capability-catalog.mjs')).href),
    import(pathToFileURL(path.join(root, 'lib/session.mjs')).href),
    import(pathToFileURL(path.join(root, 'lib/fs-safe.mjs')).href),
  ]);
  const options = { home: runtimeHome(), workspace: normalizeToolPayload(payload).workspace, copilotHome: runtimeCopilotHome(), skillsHome: process.env.AE_SKILLS_HOME };
  const snapshot = catalog.discoveryPolicy(options), policy = decision.decisionPolicyFromDiscovery(snapshot);
  if (snapshot.configured) {
    const ids = [payload.session_id, payload.sessionId].filter(value => value !== undefined && value !== null), actual = ids[0];
    if (ids.some(value => value !== actual) || typeof actual !== 'string' || !actual.trim() || actual.length > 200 || /[\u0000-\u001f\u007f]/.test(actual)) throw new Error('Observed native session identity is missing, conflicting or invalid');
    const relative = '.harness/session.json', full = path.join(options.workspace, relative);
    if (!safe.assertNoSymlinkAncestors(options.workspace, relative)) throw new Error('Native session state is unsafe or redirected');
    const bytes = safe.readFileNoFollow(full, { root: options.workspace, maxBytes: 1024 * 1024 });
    if (bytes === null && fs.lstatSync(full, { throwIfNoEntry: false })) throw new Error('Native session state is unreadable');
    let previous = null;
    if (bytes !== null) {
      const parsed = JSON.parse(bytes);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Native session state is malformed');
      previous = session.readSession(options.workspace);
      if (JSON.stringify(previous) !== JSON.stringify(parsed)) throw new Error('Native session state changed while reading');
    }
    if (previous?.sessionId !== actual && !session.writeSession(options.workspace, { ...(previous || {}), sessionId: actual })) throw new Error('Observed native session could not be retained');
  }
  return { decision, root, options: { ...options, policy, configured: snapshot.configured, resolveAgent: id => catalog.resolveCapability({ ...options, kind: 'agent', id, taskId: payload.session_id || payload.sessionId || 'native-delegation' }) } };
}

export async function observeNativeDecision(payload) {
  const tool = payload.ae_native_tool_name || payload.tool_name || payload.toolName;
  const stop = ['SubagentStop', 'subagentStop'].includes(payload.hook_event_name || payload.hookEventName) || payload.agentName && typeof payload.response === 'string' && payload.stopReason === 'end_turn';
  if (!stop && !['Agent', 'Task', 'task', 'spawn_agent', 'wait_agent'].includes(tool)) return { observed: false };
  const { decision, root, options } = await authority(payload);
  if (!options.configured) return { observed: false };
  const judgment = options.policy.enabled ? decision.observeDecisionInvocation({ ...options, payload }) : { observed: false };
  if (judgment.observed || judgment.pending) return judgment;
  const specialist = await import(pathToFileURL(path.join(root, 'lib/native-specialist-observation.mjs')).href);
  return specialist.observeNativeSpecialist({ ...options, payload });
}

export async function guardNativeDecision(payload) {
  const { decision, options } = await authority(payload);
  return decision.guardDecisionTool({ ...options, payload });
}

/** Approved additional source roots are resolved by installed authority, not by file-read payloads. */
export async function nativeSkillSources(payload) {
  process.env.COPILOT_HOME ||= runtimeCopilotHome();
  const normalized = normalizeToolPayload(payload);
  if (normalized.mutation) return null;
  const bin = authorityBin();
  if (!bin) return null;
  const root = path.resolve(path.dirname(bin), '..');
  const catalog = await import(pathToFileURL(path.join(root, 'lib/capability-catalog.mjs')).href);
  const options = { home: runtimeHome(), workspace: normalized.workspace, copilotHome: runtimeCopilotHome(), skillsHome: process.env.AE_SKILLS_HOME };
  if (!catalog.discoveryPolicy(options).configured) return null;
  const targets = normalized.targets.map(target => path.resolve(normalized.workspace, target));
  const named = normalized.toolInput.skill || normalized.toolInput.skillName || normalized.toolInput.name;
  return catalog.discoverCapabilities({ ...options, onboarding: false, limit: 2000 }).resources
    .filter(resource => resource.kind === 'skill' && (targets.includes(resource.path) || !targets.length && resource.id === named)).map(resource => resource.path);
}
