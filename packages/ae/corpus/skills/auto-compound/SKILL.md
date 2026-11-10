---
name: auto-compound
description: Internal post-success learning classifier. Use only after ae verify passes to route durable learning and recommend, but never directly create, reusable primitives.
user-invocable: false
---

# Auto Compound

## Trigger Examples

**Should trigger:**

- "Verification passed; classify what this task taught us."
- "Route the durable learning from this verified plan."
- "Record post-success learning and decide whether promotion is warranted."

**Should not trigger:**

- "Verification failed; summarize what happened." → fix verification first
- "Create a new reusable skill now." → use `/create-primitive` after approval
- "Review this implementation." → use `/code-review`

## Confusable Boundaries

- `/auto-compound` is the Engineer's internal, automatic post-success classifier and recorder.
- `/compound-learnings` is the manual, user-invoked learning publication workflow.
- `/create-primitive` governs approved primitive creation; classification never creates one directly.
- `/code-review` evaluates work before learning is compounded.

## Gate

Require explicit passed evidence:

```bash
ae status --validate-evidence --plan <path> --workspace . --json
```

Do not run on `failed` or `inconclusive`, with open hard gaps, or before required review is satisfied.

An `in-progress` or `review` plan can pass this gate. Learning precedes completion. For merged changes, missing worktrees or outdated knowledge, read `<copilot-home>/skills/compound-learnings/references/post-merge-recovery.md` and recover the existing plan before classifying the result as an insight.

## Classify the learning

| Learning | Destination |
|---|---|
| Task-specific implementation detail | Plan Implementation Notes |
| Reusable fact or gotcha | Knowledge solution |
| Repository convention | Instruction or agent context candidate |
| Reusable deterministic operation | Harness CLI candidate |
| Contextual judgment protocol | Skill candidate |
| Deterministic invariant | Check, hook, or CI candidate |
| Need for independent expertise | Specialist-agent candidate |
| External executable capability | Tool/integration candidate |

Supply a learning decision to Harness with an approved private/global publication destination or dormant ship-set proposal. Read `<copilot-home>/skills/references/learning-operations.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/references/learning-operations.md --json` prints the same file. Record recurrence evidence and any candidate_primitive, candidate_name, and recommendation as proposals. Keep the learning outside the work contract:

```json
{
  "operation": "task-learning-1",
  "decision": "publish",
  "scope": "private",
  "rationale": "A durable, reusable lesson was demonstrated by this task",
  "title": "Task-specific lesson",
  "category": "testing",
  "body": "Evidence, root cause, correction, and applicability in Markdown"
}
```

When one failing line of check output shows the lesson, add it as `evidence_quote` (one line, at most 600 bytes). Harness stores only its SHA-256 and length, never the text; the contract is in `learning-operations.md`. Use `decision: "no-learning"` with a rationale when no durable lesson exists. It produces no episode. Operation IDs support safe replay; reuse an ID only for the same decision and proof. Promotion recommendations are proposals, never activation authority.

Report whether memory held up, so it can improve. When this plan's context pack listed learnings, add `recalled` with a `helped`, `irrelevant` or `wrong` verdict for each one you can judge. When review raised findings, add `findings` with `fixed` or `dismissed` for each one you resolved. Both fields are optional, work on `publish` and `no-learning` decisions, and are evidence for consolidation only. The field contract is in `learning-operations.md`.

## Continuous memory and recurring work

Explicit user instructions and corrections can be captured during work through the existing memory writer under recorded authority; do not postpone them until this success gate. Preserve source attribution, scope, and instruction authority. Inferred lessons remain provisional and cannot silently override explicit user instructions. The native decision-agent can assess conflicts, evidence, and a proposed scoped update, but cannot grant memory-write authority. Revoked grants stop subsequent autonomous updates.

On recurrence candidates surfaced by orientation or after a checkpoint, invoke `/auto-skill-draft` to assess reuse, update, or creation from distinct verified uses. Preserve superseded and conflicting claims with their provenance. Classification itself does not create a primitive; the Engineer can route an authorized candidate to `/create-primitive` without repeating a consent request already covered by a standing grant.

## Promotion test

Recommend primitive creation only when at least one is evidenced: the procedure succeeded more than once; organizational strategy adopted it; multiple repositories need it; high risk warrants standardization; or repeated fragile steps are commonly missed. A one-time unfamiliar API, simple task, adequate upstream documentation, or overlap with an existing skill is not promotion evidence.

Every promoted skill must have 8–10 positive trigger evals, 8–10 negative/confusable evals, outcome assertions, and supported-host coverage. Primitive creation is a separate governed `/create-primitive` action.

## Persist

For configured autonomous private publication, first preview this same request with `--dry-run`. Read `<copilot-home>/skills/references/native-decisions.md` with the host read tool. Prepare `type: memory` using the returned `memoryDecision` and exact raw `memoryContent` in `context.memoryContent`; use the observed current native session and accepted plan. Obtain the native decision-agent's observed `allow`, record it, then retry the unchanged publication. The writer consumes that exact receipt once and rechecks bytes, destination, proof and standing memory consent. This private grant does not authorize global publication or ship-set promotion. Explicit user teaching retains its separate attributed authority.

Pass the JSON decision file to the writer:

```bash
ae compound --plan <path> --learning-decision <file> --workspace . --json
```

The command validates current proof, publishes through the existing writer, and reports the persisted destination and index or dormant proposal result. Never edit learning frontmatter before publication. Reuse valid proof; refresh verification and required review when the checkout, HEAD or evidence binding changed or records are missing. Report actual evidence and publication outcomes.

When a successful compound result includes `flowMaintenance`, treat it as advisory context maintenance. It identifies an existing shared model made stale by watched changes on the observed default branch. Read `<copilot-home>/skills/codebase-context/references/flow-models.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/codebase-context/references/flow-models.md --json` prints the same file. Inspect the bound committed sources, and regenerate explicitly through `/codebase-context` within authorized scope. Compound neither merges the default branch nor invokes an agent, rewrites the model, or creates a missing one. Flow maintenance does not replace the learning decision or change delivery completion authority.

## Debt check (session-end drain)

After persisting, run:

```bash
ae consolidate --status --json
```

When the packet reports `due: true`, invoke `/consolidate` before ending the session.
