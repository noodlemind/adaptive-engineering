---
name: verify-delivery-evidence
description: Check the delivery-evidence workflow diagram against AE's delivery rules after gate, intent, proof, learning or recovery changes, and update the diagram when the workflow changes. Not for general code review, ordinary sessions or changing rules merely to pass.
---

# Verify delivery evidence

Read this skill explicitly from the selected verify-harness recipe. It is a repo-local maintainer check, not a shipped skill.

The promise: governed product edits require accepted intent, verified-delivery learning requires current proof, and recovery or insight capture does not complete delivery. The workflow is modeled as a Mermaid state diagram in [workflow.mmd](workflow.mmd). Each transition label is an action: `EnterDeliver`, `Lock`, `Edit`, `Amend`, `Review`, `Verify`, `Compound` or `CaptureInsight`. Each state carries a plain-word label for the reader. The rules live as data in [rules.json](rules.json).

Run from the repository root:

```bash
node .cursor/skills/verify-harness/formal/delivery-evidence/scripts/check.mjs
```

The check is a thin wrapper over the state-model starter that AE ships in create-primitive, and needs only Node. It follows every path through the diagram and checks five rules:

| Rule | Meaning |
| --- | --- |
| `intent-before-edit` | Every `Edit` follows a `Lock`. |
| `deliver-only-edits` | Every `Edit` follows `EnterDeliver`; Answer, Investigate and Review never edit. |
| `current-evidence` | `Compound` follows a `Verify` with no `Edit` or `Amend` since. |
| `insight-is-inert` | `CaptureInsight` never changes the delivery state. |
| `progress` | After a `Review`, `Compound` stays reachable. |

It then builds two broken variants, one with an unguarded `Compound` and one with no `Verify`, and fails unless each is caught. It writes the receipt `state-model.json` under `HARNESS_CHECK_ARTIFACT_DIR`, or under a private temporary directory it names on stderr for a manual run, together with a `report.md` that tells each broken rule as its shortest numbered path from the start in the diagram's plain words, and a marked `chart.mmd`. The receipt is also printed to stdout.

Read every failure through its chart: render `chart.mmd` with `ae diagrams render --renderer pele` and give each broken rule as its numbered path from `report.md`. The chart is descriptive context; the receipt is the evidence.

The diagram describes the intended workflow; it does not prove the code follows it. The [workflow-invariant checks](../../features/workflow-invariants.md), `verify-workflow-invariants` and `verify-workflow-invariants-negative`, drive the real CLI and hooks on a disposable copy and confirm a deliberately weakened guard is detected. Run them together with this check. The diagram has no counters or data, so bounds such as the number of edits are covered by those behavior checks, not here.

## When the workflow changes

Update `workflow.mmd` in the same change as the code. Keep to the supported syntax: `A --> B` with an optional `: Action` label, `state "Plain words" as A` for a reader-facing name, `[*]` for start and end, and `%%` comments. Rerun the check and the workflow-invariant checks. If the new diagram breaks a rule, treat it as a possible product defect; do not weaken a rule to get a pass. Changing a rule needs accepted intent, such as an updated spec.

## Trigger Examples

**Should trigger:**

- Check that changed locked intent still blocks implementation.
- A new step was added between review and verification.
- Recovery code moved and the workflow needs rechecking.

**Should not trigger:**

- Explain an ordinary CLI flag.
- Make a failing rule disappear without an accepted fix.
