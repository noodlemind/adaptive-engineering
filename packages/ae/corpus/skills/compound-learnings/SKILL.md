---
name: compound-learnings
description: Document verified work as a reusable solution before plan completion. Capture problem, root cause, fix, and prevention after verification and required review. Not for planning or implementation.
argument-hint: "[path to verified plan or description of solved problem]"
user-invocable: false
---

# Compound Learnings

Use the verified work and its investigation notes to explain the problem, root cause, correction, prevention, and limits of applicability. Read `assets/solution-template.md` for content prompts when useful. Distinguish demonstrated lessons from hypotheses and recommendations.

The plan can still be `in-progress` or `review`. Current verification and required review permit publication; the learning decision is a prerequisite of plan completion. Reuse that plan. For merged or backported changes, removed worktrees, missing proof, or outdated learning, read `references/post-merge-recovery.md` before proposing another plan or an insight.

## Publication decision

Choose whether a durable lesson exists, its category and useful search tags, and the approved destination. `private` stays with this product; `global` persists in this machine's shared knowledge; `ship-set-proposal` creates a dormant proposal for a future Harness release. A proposal never activates or modifies the shipped corpus. Check the applicable approval boundary before choosing a wider destination.

Use the structured publication contract. Read `<copilot-home>/skills/references/learning-operations.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/references/learning-operations.md --json` prints the same file. With a plan, `ae compound --plan <path> --learning-decision <file> --json` consumes current passed proof and owns the episode path, dates, provenance, publication, index and replay record. Choose `no-learning` with a rationale when the task yielded no reusable lesson. Report the actual returned path and indexing or proposal state.

For an unverified investigation, use `ae compound --insight --title <title> --body-file <file> --json`. Recover an existing delivery's missing or stale proof before choosing this lane. An insight does not replace verified delivery learning or satisfy its completion.

## Curation judgment

Assess whether the lesson reveals a repository convention, architectural decision, recurring gotcha or need for a reusable capability. A one-time fix belongs in its episode. Recommend context or primitive changes only when the evidence supports them, through the governed creation workflow. Do not duplicate a full solution in contextual guidance.

The Engineer owns completion. It submits accepted memory notes through `plan-update` and a complete decision only after all prerequisites pass. This skill does not edit plan frontmatter, manufacture a completion summary, or calculate paths and timestamps.

## Trigger Examples

**Should trigger:**
- "Document what we learned from this bug fix"
- "Save this solution for future reference"
- "Let's compound this learning"

**Should not trigger:**
- "Plan this feature" → /plan-issue
- "Review this code" → /code-review
- "Fix this bug" → @engineer Deliver mode

## Guardrails

- Keep solution files focused — one problem, one solution per file.
- Include enough context that someone unfamiliar with the codebase can understand the learning.
- Use specific code examples, not vague descriptions.
- Tag accurately — tags are how future agents find relevant learnings.
