# Subagent Context Packet

Use this template for every delegated task. Subagents run in isolated context; assume they do not remember prior conversation, hidden plan details, or unstated constraints.

Read the matching role line in `~/.cursor/rules/ae-models.mdc` or `~/.claude/rules/ae-models.md`. The role is `engineer`, `specialist`, `researcher`, `reviewer`, or `decision`. Pass that model when the host spawn tool takes one. A missing file, a missing line, or `inherit` means omit the model. Preserve the effective model observation; an unsupported selection is inheritance, not evidence that a small model ran.

## Delegation Header

- **Delegating agent/skill:**
- **Subagent target:**
- **Task id:**
- **Priority:** P1 / P2 / P3
- **Risk level:** low / medium / high
- **Expected output format:**
- **Eligible provider source path/digest:**
- **Current authorization or standing grant revision:**

## Objective

State the concrete question to answer or work to perform. Include the decision the parent agent needs from the subagent.

## Required Context

- **User request:**
- **Current route/skill:**
- **Plan file, if any:**
- **Acceptance criteria:**
- **Constraints:**
- **Non-goals:**

## Relevant Artifacts

Include exact paths and focused excerpts. Do not rely on the subagent to discover context that is already known.

| Artifact | Why it matters | Excerpt or summary |
|---|---|---|
| [path or artifact] | [why relevant] | [focused excerpt or summary] |

## Current Findings

Summarize what has already been learned so the subagent does not duplicate work.

## Scope Boundaries

- **Files allowed to inspect:**
- **Files allowed to modify, if any:**
- **Files not to touch:**
- **Commands/tests allowed:**
- **Commands/tests not allowed:**

## Review Criteria

List the domain-specific criteria the subagent should apply.

- Correctness:
- Security:
- Data integrity:
- Performance:
- Maintainability:
- Test coverage:

## Approval Dependencies

List boundaries not covered by existing direct authorization or scoped standing grants. A subagent cannot broaden consent or delegate beyond host authority. Native decision-agent requests retain the exact Harness packet and versioned reply schema; do not replace it with this generic response template.

## Expected Response

If the subagent has a defined output format, reference that format here instead of overriding it. Examples include reviewer JSON findings, confidence-scored review outputs, or researcher Markdown sections. Use the default template below only when the subagent has no predefined response format.

```markdown
## Result

## Evidence

## Risks

## Recommendation

## Follow-up Questions
```
