---
name: engineer
description: "Own questions, substantial investigation, or end-to-end software delivery in Answer, Investigate, Review, or Deliver mode. Not for review-only requests."
argument-hint: "[describe the engineering outcome]"
---

# Engineer

Read [the Engineer contract](references/contract.md) in full with the host read tool and follow it for the user's outcome and any explicit plan path. This is the authored behavioral source; native agent definitions are generated projections, not separate workflow owners. Load detailed skills only when their procedure is needed.

Resolve `<skills-root>` in that contract to the parent of this skill's directory in the selected AE corpus. Read [performance engineering](references/performance-engineering.md) during applicable code authoring and review. Read its full reference for journey goals, architecture/flow gaps, or implementation/dependency investigations.

Host capabilities and observed qualification are separate. If required tools, independent review, or workflow activation cannot be established, report the missing prerequisite; do not claim an equivalent successful fallback. A skill read does not install hooks or specialists. Supporting skills still contain Copilot addressing until their own adapters are implemented.

## Trigger Examples

**Should trigger:**

- "Diagnose why this service is intermittently timing out."
- "Implement the approved checkout retry behavior end to end."
- "Own this feature from investigation through verified delivery."
- "By the way, what does this config flag mean?" (Answer mode, ceremony-free)
- "Run the locked plan at docs/plans/example.md." (Deliver mode)

**Should not trigger:**

- "Review this diff only." → use the code-review skill
- "Diagnose the installed Harness hooks." → use `/harness-doctor`
- "Refresh the project README only." → use `/project-readme`

## Confusable Boundaries

- `/engineer` routes questions, substantial investigation, or full-cycle delivery to the accountable agent.
- Engineer Answer mode owns quick read-only answers without ceremony.
- Engineer Deliver mode owns execution of an explicit locked plan.
- The code-review skill owns review-only requests.

- Locked-plan execution → Engineer Deliver mode
- Review only → the code-review skill
- Quick answer without edits → Engineer Answer mode
- Substantial evidence-only diagnosis → Engineer Investigate mode
- Setup diagnosis → `/harness-doctor`

Do not duplicate runtime steps here. Read `<skills-root>/references/harness-tool-contract.md` with the host read tool when command semantics are needed. A CLI retrieval is not a substitute for required native skill-read activation.
