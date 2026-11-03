---
name: plan-issue
description: Generate a phased implementation plan with research and acceptance criteria. Power-user step; @engineer uses /ensure-plan. Not for quick fixes — @engineer Deliver mode handles those directly.
argument-hint: "[path to issue file]"
user-invocable: false
---
# Plan Issue

Choose an implementation approach for a captured issue. Preserve intent, evidence, constraints, research, scope, and review needs so another agent can continue. Harness owns plan layout, serialization, readiness, and lifecycle transitions.

## Trigger Examples

**Should trigger:**
- "Create an implementation plan for this issue."
- "Plan the approach for this feature."
- "Research this captured issue before implementation."

**Should not trigger:**
- "Just fix the bug." Use Engineer Deliver mode.
- "Start this locked plan." Use Engineer Deliver mode.
- "Record this observation for later." Use /capture-issue.

## Read the issue

Retrieve the selected plan and current revision. If it is already locked, judge whether the request calls for an amendment or execution. An existing lock is not a reason to silently unlock or replace the plan. Resolve needs-info questions from available evidence before seeking missing user decisions.

## Research and choose

Read selected intent sources and task-relevant repository context. Use /recall for applicable prior solutions. Delegate bounded research when separate expertise is useful; otherwise research within this session. Follow the shared subagent context packet contract. Researcher spawns use the `researcher` role. Read the matching role line in `~/.cursor/rules/ae-models.mdc` or `~/.claude/rules/ae-models.md`. Pass that model when the host spawn tool takes one. A missing file, a missing line, or `inherit` means omit the model.

Choose the smallest approach that meets the goal. Identify impacted paths and meaningful acceptance criteria. Inspect trusted named checks from the selected configuration source reported by `ae checks list --json`; judge assertion adequacy rather than matching a check name. Record source-backed reasoning, constraints, unresolved questions, and risk-aware review needs.

When named checks are missing or inadequate, follow `<copilot-home>/skills/create-primitive/references/named-checks.md`. Prepare the concrete configuration through the bounded writer before requesting a necessary approval. Keep the plan draft until its prerequisites pass; do not delegate configuration authoring back to the user.

For transaction races, lost updates, duplicate writes, or flush/commit misconceptions, require a failing concurrent reproduction before strategy selection. Route domain review when needed. Repeated missing capability becomes a proposal, not an inline installation.

## Submit the plan decision

Pipe the amend JSON to `ae plan-update --plan <path> --file - --json` for criteria/check bindings, scope, phases, and authored notes. Do not write the decision JSON to a file. Read `<copilot-home>/skills/references/plan-operations.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/references/plan-operations.md --json` prints the same file. Supply task descriptions and phase titles; Harness writes headings, task IDs, unchecked state, dates, references, and activity. Never put executable shell strings in a plan.

Use scoped source amendments when accepting changed selected specs. Harness records old/new hashes and affected evidence. Preserve the frozen selection; a relock cannot silently accept changed source bytes.

Report the returned path, phase/task counts, and missing prerequisites. Engineer submits the start decision when delivery is authorized. Starting work validates readiness, locks the resulting state, and binds its implement gate in one recoverable operation. Planning alone does not execute product changes.

## Errors and guardrails

Use the CLI diagnostics for missing plans, unsupported schemas, stale revisions, and unavailable proof. Reread a stale revision before making a new decision; replay an interrupted operation with the same payload and ID.

If optional research fails, retain successful evidence and state the gap. Read `<copilot-home>/skills/references/error-handling-patterns.md` with the host read tool for bounded recovery. Outside the enforce hook, `ae get --reference skills/references/error-handling-patterns.md --json` prints the same file. Read `<copilot-home>/skills/references/human-approval-policy.md` with the host read tool to preserve existing authorization. Outside the enforce hook, `ae get --reference skills/references/human-approval-policy.md --json` prints the same file. Obtain a missing gated decision before implementing it. Scope each phase so its outcome can be verified.
