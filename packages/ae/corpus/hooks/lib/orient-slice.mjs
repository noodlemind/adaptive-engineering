const REQUIRED = ['neighborhood', 'learnings', 'skills', 'instructions', 'contacts', 'index', 'gateStatus', 'activePlan'];

export function unwrapOrientSlice(parsed, empty) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
  const version2 = parsed.schema === 'harness.context.v2';
  const value = version2 ? parsed.slice : parsed;
  const contextEvidence = version2 ? {
    schema: parsed.schema, contextId: parsed.contextId, sourceState: parsed.sourceState,
    task: parsed.task, evidence: parsed.evidence, coverage: parsed.coverage, expansion: parsed.expansion,
  } : null;
  if (!value || typeof value !== 'object' || !REQUIRED.every(key => Object.hasOwn(value, key))) {
    return contextEvidence ? { ...empty, ...(parsed.workflow ? { workflow: parsed.workflow } : {}), contextEvidence } : empty;
  }
  return { ...empty, ...value, ...(contextEvidence ? { contextEvidence } : {}) };
}
