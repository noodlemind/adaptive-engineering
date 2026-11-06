---
name: ensure-capability
description: Internal on-demand gap-resolution procedure. Use when a task explicitly requires specialized capability, high-risk work needs assurance, or uncertainty/blockage is encountered. Not a session-start checklist.
user-invocable: false
---

# Ensure Capability (on demand)

## Activation

Resolve gaps when encountered. Invoke only when:

- the acceptance criteria explicitly require a skill, specialist, convention, or tool;
- security, data, concurrency, infrastructure, or destructive work needs capability assurance; or
- investigation encounters unresolved uncertainty or an executable blocker.

Use bounded relevant catalog pointers from orientation; do not load the full registry before ordinary work. Missing optional capability never blocks low-risk work. On a specific miss, refresh selected external roots once when ongoing discovery consent permits, then inspect eligible matches. Excluded or revoked resources cannot fulfill a gap; discovered metadata does not activate a skill or grant tool authority.

### Trigger examples

**Should trigger:**

- An acceptance criterion requires a security review capability that is not currently available.
- A destructive database migration needs independent data-integrity assurance.
- Investigation reaches an executable blocker after repository evidence and authoritative documentation are exhausted.

**Should not trigger:**

- A routine low-risk change can proceed with current repository patterns and tests.
- A quick read-only question needs `@engineer` Answer mode, not capability acquisition.
- A one-off unfamiliar API can be resolved from authoritative documentation without creating or importing a primitive.

### Confusable boundaries

- `/ensure-capability` resolves a specific encountered gap; `/ensure-plan` establishes the work contract.
- `/create-primitive` acquires a first-needed specialist when separate judgment is necessary, and promotes a durable skill only after promotion evidence; one unfamiliar API is not skill promotion evidence.
- `/harness-doctor` diagnoses installed harness health; it does not fulfill task-specific expertise or tool gaps.

## Gap classification

| Gap | First response | Escalation |
|---|---|---|
| Missing fact or API | Inspect code and authoritative docs | Bounded research consultation |
| Unfamiliar framework | Inspect repository conventions, docs, and one relevant skill | Domain expert |
| Specialized judgment | Consult an eligible installed specialist | Acquire a missing specialist on first need; independent review |
| Reusable deterministic procedure | Inspect existing Harness commands | CLI enhancement proposal |
| Contextual judgment protocol | Search installed skills | Import or draft after promotion evidence |
| Missing executable capability | Find an approved tool or integration | Governed tool proposal |
| Missing organizational convention | Search instructions and knowledge | Instruction or check proposal |
| Safety-critical capability | Stop the affected operation | Expert review or recorded waiver |

## Resolution workflow

1. State the blocked criterion or decision, evidence already inspected, and why direct investigation is insufficient.
2. Classify the gap as `soft`, `bridge`, or `hard`; declare it through a revision-bound plan amendment.
3. Search eligible shipped, user, and enterprise capabilities. On a miss, call `ae resources discover --refresh --query "<gap>" --json` once within ongoing discovery consent. This immutable scan operation reconciles eligible agents in the selected host root into managed Engineer delegation; it never changes inclusion or grants. Query, status and orientation leave profiles unchanged. Honor returned reconciliation and `pending-reload`: publication is not actual host loading or invocation evidence. Respect exclusions, source changes and revocation. Choose the smallest response from the table. Consultations use `subagent-context-packet.md`.
4. If necessary specialist judgment is still missing, route to `/create-primitive` with the gap, overlap evidence, minimum permissions, and direct or standing authorization. Use the native decision-agent for the bounded acquire/reuse judgment. Do not require recurrence for this first-use specialist. A created resource is unavailable until actual host activation is observed; `pending-reload` is not invocation evidence. For a durable skill candidate, require the promotion evidence below.
5. For a hard gap, record its affected criterion or operation and stop only that scope until fulfillment, an approved bridge, or an explicit waiver is recorded.
6. Keep unrelated safe work available. Choose plan scope only when no executable safe work remains; Harness records `blocked-capability` for a declared hard plan-scope gap.

## Plan record

Read `<copilot-home>/skills/references/plan-operations.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/references/plan-operations.md --json` prints the same file. An `amend` decision's `changes.gaps` supplies new gap IDs, class, scope, affected criterion/operation and authored evidence observations. Harness writes the plan representation, pending state and activity; existing gaps cannot be overwritten by this input. Criterion scope names an existing criterion. Observations are claims; they do not assert verified file bytes.

Use the `gap` operation to close an existing gap with the accepted evidence path. Harness binds its current bytes. Bridge and waiver authority remains in trusted policy with the human decision's reason and scope. A declaration cannot grant that authority or claim fulfillment. Read the resulting state and allowed next actions instead of editing frontmatter.

## Promotion boundary

Solving an unfamiliar API once produces plan notes or knowledge, not a skill. Creating or substantially expanding a durable skill requires verified promotion evidence: recurrence, strategic adoption, cross-repository need, high-risk standardization value, or repeated fragile steps. This restriction does not prevent first-needed specialist acquisition for independent judgment. Existing scoped standing consent covers matching creation; ask only for uncovered authority.

## Output

Return the gap classification, affected criterion, chosen response, evidence, remaining restriction, and next safe action. The Engineer evaluates the result and owns the final decision.
