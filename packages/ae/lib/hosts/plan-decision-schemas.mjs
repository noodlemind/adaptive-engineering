import { PLAN_ACTIONS } from '../plan-decisions.mjs';

const LINE = { type: 'string', minLength: 1, pattern: '^[^\\u0000\\r\\n]+$' };
const HASH = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const ID = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$' };
const NAME = { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' };
const record = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const list = (items, minItems = 1, limits = {}) => ({ type: 'array', items, minItems, ...limits });
const AUTHORITY = record({ scope: LINE, basis: LINE }, ['scope', 'basis']);
const NOTES = record(Object.fromEntries(['overview', 'context', 'memory', 'technical', 'research', 'routing', 'implementation'].map(name => [name, { type: 'string', minLength: 1 }])));
const PHASES = list(record({ title: LINE, tasks: list(LINE, 1, { maxItems: 1000 }) }, ['title', 'tasks']), 1, { maxItems: 100 });
const BINDING = record({ path: LINE, sha256: HASH }, ['path', 'sha256']);
const GAP = record({ id: ID, class: { enum: ['soft', 'bridge', 'hard'] }, scope: { enum: ['operation', 'criterion', 'plan'] }, required_for: LINE, evidence: list(LINE, 1, { maxItems: 32 }) }, ['id', 'class', 'scope', 'required_for', 'evidence']);
const CHANGES = record({
  scope: list(LINE), goal: LINE, constraints: list(LINE),
  criteria: list(record({ id: { type: 'string', pattern: '^[A-Za-z]+[0-9]+$' }, text: LINE, checks: list(NAME) }, ['text', 'checks'])),
  reviews: list(NAME, 0), notes: NOTES, phases: PHASES, gaps: list(GAP, 1, { maxItems: 100 }),
  verificationRecipe: LINE, playbook: LINE, skillsUsed: list(NAME, 1, { maxItems: 32 }),
  workflowNotApplicable: list(record({ playbook: LINE, sha256: HASH, step: LINE, reason: { ...LINE, maxLength: 1000 } }, ['playbook', 'sha256', 'step', 'reason']), 1, { maxItems: 100 }),
  domainBinding: { type: 'object' }, domainParent: { type: 'object' }, domainChild: { type: 'object' }, experiment: { type: 'object' },
});

export function planCreationDecisionSchema() {
  const common = {
    version: { const: 1 }, slug: NAME, goal: LINE, acceptance: list(LINE), constraints: list(LINE, 0), scope: list(LINE),
    check: LINE, intentSources: list(LINE, 0), status: { enum: ['open', 'planned', 'in-progress', 'needs-info'] },
    notes: NOTES, phases: PHASES, verificationRecipe: LINE, playbook: LINE,
  };
  return { type: 'object', oneOf: [
    record({ ...common, format: { const: 'full' }, type: { enum: ['feat', 'fix', 'docs', 'refactor', 'chore'] }, title: LINE,
      risk: { enum: ['green', 'amber', 'red'] }, outputs: list(LINE), skillsUsed: list(NAME), experiment: { type: 'object' } }, ['version', 'format', 'goal', 'acceptance']),
    record({ ...common, format: { const: 'short' } }, ['version', 'format', 'goal', 'acceptance']),
  ] };
}

export function planUpdateDecisionSchema() {
  const common = { version: { const: 1 }, id: ID, expect: HASH, rationale: LINE, authority: AUTHORITY };
  const action = (name, properties = {}, required = []) => record({ ...common, action: { const: name },
    ...(name === 'complete' ? {} : { observedIntent: record({ id: { type: 'string', minLength: 1, maxLength: 128 },
      disposition: name === 'amend' ? { enum: ['amend', 'unchanged'] } : { const: 'unchanged' },
      rationale: { type: 'string', minLength: 1, maxLength: 1000 },
    }, ['id', 'disposition', 'rationale']) }),
    ...properties,
  }, ['version', 'id', 'action', 'expect', ...required]);
  const actions = [
    action('start', { migrateIntent: { type: 'boolean' } }),
    action('amend', { changes: CHANGES, migrateIntent: { type: 'boolean' },
      intentSources: list(record({ path: LINE, oldHash: HASH, newHash: HASH }, ['path'])),
      intentSelection: record({ previous: list(BINDING, 0, { maxItems: 128 }), next: list(LINE, 0, { maxItems: 128 }) }, ['previous', 'next']),
    }, ['rationale']),
    action('progress', { progress: { ...record({ criteria: list({ type: 'string', pattern: '^[A-Za-z][A-Za-z0-9]*$' }), tasks: list({ type: 'string', pattern: '^[A-Za-z][A-Za-z0-9]*$' }), phase: { type: 'integer' } }), minProperties: 1 } }, ['progress']),
    action('finding', { finding: record({ id: ID, text: LINE }, ['id', 'text']) }, ['finding']),
    action('gap', { gap: record({ id: ID, fulfillment: { const: 'done' }, evidence: LINE }, ['id', 'fulfillment', 'evidence']) }, ['rationale', 'gap']),
    action('complete'),
  ];
  return { type: 'object', oneOf: [
    ...PLAN_ACTIONS.map(name => actions.find(shape => shape.properties.action.const === name)),
    record({ version: { const: 1 }, id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' }, action: { const: 'convert' }, expect: HASH,
      rationale: LINE, authority: record({ scope: { enum: ['domain-intent', 'experiment-intent'] }, basis: LINE }, ['scope', 'basis']),
      changes: record({ domain_binding: { type: 'object' }, domain_child: { type: 'object' }, experiment: { type: 'object' } }),
    }, ['version', 'id', 'action', 'expect', 'rationale', 'authority', 'changes']),
  ] };
}
