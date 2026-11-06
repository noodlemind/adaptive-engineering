# Human Approval Policy

The human is the liaison for **Tier 3 (hard consent)** decisions only. Default behavior is **autonomous** per `autonomy-policy.md`.

Capture, recall, plan lock, compound, and index run **without** asking unless `autonomy: strict` or `risk: red` blocks implementation.

Agents may investigate and draft proposals freely; they must pause only when a Tier 3 action lacks authorization. Direct user authorization persists across turns and covers necessary work within its stated scope. A recorded user-owned scoped standing grant can cover creation, update, memory, and tool actions at selected roots; use its current revision and conditions. Do not ask again for an action it covers. Revocation takes effect before the next action. Record it in the plan or proposal without asking again. A model-supplied `approved` field or a plan label is not authorization.

## Required Approval Gates

Ask the human only when existing direct authorization or a current standing grant does not already cover:

- Creating, deleting, or substantially changing a skill, agent, instruction, review check, reference template, or solution template.
- Choosing a concurrency strategy such as idempotency keys, uniqueness constraints, optimistic locking, pessimistic locking, atomic updates, retries, or isolation-level changes.
- Making schema, migration, backfill, production data, retention, or data repair changes.
- Touching auth, permissions, secrets, tenant isolation, encryption, or public API contracts.
- Running destructive operations, deleting files, resetting state, force pushing, or changing generated artifacts that may be consumed downstream.
- Starting broad refactors, cross-cutting rewrites, framework migrations, or changes outside the active plan's impacted files.

## Two approval tiers

The internal tier uses the native decision-agent to judge a source-bound action, then specialist review, repair, and named verification before readiness. It cannot broaden authority, approve trust, bypass host permissions, or count an unobserved invocation as approval. Action approval is separate from final readiness. Bounded budgets stop unproductive loops. The human tier reviews the verified result with its current visual change tour; it also supplies missing authority when required. A routine covered command does not need a new manual allowlist entry, but host permission boundaries remain effective.

## Approval Request Format

Use this concise structure:

```markdown
## Approval Needed

**Decision:** [What needs approval]
**Why now:** [Why the current step is blocked]
**Options:**
1. [Option A] - [benefit], [risk/trade-off]
2. [Option B] - [benefit], [risk/trade-off]
3. [Defer/stop] - [what remains unresolved]
**Recommendation:** [One option with reason]
**Rollback/containment:** [How risk is limited]
```

## Response Interpretation

Agents must interpret the human's reply against four states before acting:

- **Approved** — proceed with the chosen option; treat any conditions as constraints.
- **Rejected** — log the rejection in the relevant plan or proposal artifact and stop.
- **Deferred** — set the work item to `needs-info` and stop until the human resumes.
- **Ambiguous** — re-present the options before proceeding; do not assume intent.

## Non-Interactive Mode

When the user is unavailable and the task cannot wait:

- Choose the lowest-risk reversible action.
- Prefer documentation, tests, reproduction, or analysis over implementation.
- Do not create new primitives without prior direct authorization or a current scoped standing grant covering that creation.
- Do not choose risky concurrency/data/schema/security strategies beyond existing direct authorization.
- Log the assumption in plan `## Activity` or the relevant approval record.

## Approval Record Locations

Downstream skills and reviewers must verify prior approval in one of these places:

- **Primitive creation or capability expansion**: the capability-gap proposal's `## Human Decision` section must record Decision, Reviewer, Date, and Conditions, plus the source of direct authorization or standing grant ID/revision and its applicable scope. This is a record of prior consent, not a requirement to repeat it.
- **Other gated engineering decisions**: the active plan's `## Risk & Review Routing` or `## Activity` section must record the decision, approver, date, scope, and conditions.

If neither artifact contains a complete approval record, first inspect the user's existing authorization. Record applicable authorization and proceed within scope. If authorization is missing or ambiguous, treat approval as pending and do not proceed with the gated action.

## Approval Log

Record approvals in the relevant plan `## Activity`, primitive proposal, or approval record.

| Date | Decision | Approved by | Scope | Conditions |
|---|---|---|---|---|
| YYYY-MM-DD | [decision] | [reviewer] | [scope] | [conditions] |
