import { authorizeCapabilityChange, declaredCapabilityPermissions, discoveryPolicy } from '../capability-catalog.mjs';

const fail = message => Object.assign(new Error(message), { code: 'E_USAGE', exit: 2, hint: 'Inspect the current discovery consent and retry the native decision.' });

/** Schema 1 does not publish executable host configuration as primitive metadata. */
export function personalResourcePermissions({ text, metadata, host, type }) {
  if (['hooks', 'mcpServers', 'mcp_servers'].some(key => Object.hasOwn(metadata, key))
    || ['permissionMode', 'permission_mode'].some(key => metadata[key] !== undefined && metadata[key] !== 'default')
    || metadata.context === 'fork') throw fail('Executable hooks, MCP configuration, forked contexts and nondefault permission metadata are unsupported in personal resource schema 1');
  try { return declaredCapabilityPermissions({ text, kind: type, host, format: 'markdown' }); }
  catch (error) { throw fail(`Personal resource permission metadata is invalid: ${error.message}`); }
}

/** Decide once; subsequent checks verify standing authority without consuming another receipt. */
export function personalResourceAuthorization({ home, configHome, skillsHome, host, request, yes = false, authorize, legacySkill = false, legacyAllowed = false }) {
  const options = { home, copilotHome: configHome, skillsHome, host };
  const boundRequest = { ...request, tools: [...(request.tools || [])], agents: [...(request.agents || [])] };
  const initial = discoveryPolicy(options);
  const verdict = typeof authorize === 'function' ? authorize({ ...boundRequest, tools: [...boundRequest.tools], agents: [...boundRequest.agents] }) : null;
  const assertCurrent = () => {
    const current = discoveryPolicy(options);
    if (current.policyRevision !== initial.policyRevision || current.configured !== initial.configured) throw fail('Standing authorization consent changed during personal resource publication');
    if (initial.configured && !yes) {
      const permission = authorizeCapabilityChange({ ...options, ...boundRequest });
      if (!permission.allowed) throw fail(`Personal resource permission authorization is absent: ${permission.reason}`);
    }
  };
  assertCurrent();
  const legacy = !initial.configured && (legacyAllowed || legacySkill && !boundRequest.tools.length && !boundRequest.agents.length && boundRequest.authority === 'declared');
  if (!yes && verdict?.allowed !== true && !legacy) throw fail(`Personal resource permission authorization is absent${verdict?.reason ? `: ${verdict.reason}` : '; use standing consent or explicit caller --yes'}`);
  return { assertCurrent, record: { source: yes ? 'explicit-caller' : initial.configured || verdict?.allowed ? 'standing' : 'legacy',
    policyRevision: initial.configured ? initial.policyRevision : null } };
}
