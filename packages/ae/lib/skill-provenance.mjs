import { discoveryPolicy, resolveCapability } from './capability-catalog.mjs';
import { skillActivationSourceCurrent, sameSkillSourcePath } from '../corpus/hooks/lib/skill-activation.mjs';

/** Extra source paths come only from current included catalog entries, never a tool payload. */
export function authorizedSkillSources(name, options = {}) {
  if (!discoveryPolicy(options).configured) return [];
  const resource = resolveCapability({ ...options, kind: 'skill', id: name });
  return resource ? [resource.path] : [];
}

export function currentSkillActivation(activation, name, options = {}) {
  const additionalSources = authorizedSkillSources(name, options);
  const sourceCurrent = skillActivationSourceCurrent(activation, name, { ...options, additionalSources });
  if (!sourceCurrent) return false;
  const consent = discoveryPolicy(options);
  if (!consent.configured) return true;
  return additionalSources.some(source => sameSkillSourcePath(source, activation.source.path));
}
