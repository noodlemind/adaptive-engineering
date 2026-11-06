---
name: create-primitive
description: "Decide and create the right skill, agent, instruction, check, reference, or solution doc. Not for importing external repos — use /import-conventions."
user-invocable: false
---

# Create Primitive

Classify and maintain Harness capabilities. Before any governed change, read `<copilot-home>/skills/create-primitive/references/creator-workflow.md` with the host read tool, in full, using bounded pages if the tool truncates. It owns creation paths, host mapping, promotion, and validation. Load the relevant template before writing.

## Triggers

**Should trigger:**
- "Create a new agent."
- "Build or update a skill."
- "Where should this convention or review check live?"

**Should not trigger:**
- "Import conventions from a repo." → /import-conventions
- "Review my code." → /code-review
- "Plan a feature." → /plan-issue

## Authority and activation

Governed paths include `packages/ae/corpus/skills/`, `packages/ae/corpus/agents/`, `packages/ae/corpus/instructions/`, `packages/ae/corpus/enterprise/`, `.github/checks/`, and `packages/ae/corpus/knowledge/capability-registry.yaml`. `.github/prompts/` stays retired. Reintroduction, reference, and solution changes use this governance.

Personal skills, agents, and instructions use only `ae resources create <skill|agent|instruction> <name> --file <decision>` with schema 1 text under selected host roots. Honor native mapping, ownership, expected digests, and pending-reload status. Do not edit the product repo or ship set for a personal primitive. Follow the required creator reference for host limits.

Activation means this `SKILL.md` was actually loaded in the current chat session. Do not claim activation by only adding `create-primitive` to `skills_used`. Classify → check overlap → choose the smallest artifact → record rationale → create or reuse a plan → pass the implement gate → edit → verify → report evidence.

For gaps, read `<copilot-home>/skills/references/capability-gap-proposal.md` and `<copilot-home>/skills/references/human-approval-policy.md` with the host read tool. Direct or scoped standing authorization must cover target roots, permissions, and effects, including in non-interactive mode. Do not repeat covered consent. A decision-agent cannot grant or expand authority.

## Choose the owner

| Need | Owner |
|---|---|
| Reusable deterministic operation | Harness CLI |
| Contextual judgment protocol or reviewer workflow | Skill |
| Separate judgment, authority, isolation, runtime profile, or accountability | Agent |
| Automatically loaded file-pattern conventions | Instruction |
| Narrow review-time rule | Review check |
| Dense examples, schemas, criteria, or templates for one skill | Its reference or asset |
| Verified learning from completed work | Solution doc |

Check eligible shipped/external capabilities for overlap; refresh once within discovery consent on a miss. Do not create agents to store references. Read `<copilot-home>/skills/references/knowledge-locations.md` with the host read tool for learning destinations.

For Java/Spring/AWS migrations, compare explicitly: Existing /java skill; Existing /aws skill; Reference under /java; Reference under /aws; New cross-domain migration skill. When those installed paths are present, read `<copilot-home>/skills/java/SKILL.md` and `<copilot-home>/skills/aws/SKILL.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/java/SKILL.md --json` and `ae get --reference skills/aws/SKILL.md --json` print the same files. State the inspected evidence and smallest justified option before editing. Keep dense migration guidance in references.

## Promotion evidence

Before skill creation/expansion, link passed artifacts, prior use/adoption, overlap, owner, lifecycle, trigger evals, and outcome evals. Require recurrence, strategic adoption, cross-repo need, high-risk standardization, or repeatedly missed fragile steps. One unfamiliar API, adequate upstream docs, or duplication is insufficient.

Promoted, core, or confusable skills need 8–10 trigger and 8–10 negative/confusable prompts, outcome assertions, and host coverage. Checks and instructions need good/bad examples. Structural validation does not prove usefulness.

Learning classification and model verdicts cannot authorize creation or merge. Use native decision judgment and review/verification within current authority. First-needed specialists need separate judgment and evaluation, not recurrence. Follow the creator reference for provenance and post-merge promotion recording.

## Execute and verify

Load the relevant template and creation detail through the already-required creator reference before writing. Read `<copilot-home>/skills/create-primitive/references/product-verification.md` with the host read tool for product recipes and feature maps. Reuse the selected directory after a scoped Deliver plan and gate pass.

For durable critical-state, retry, concurrency, or input properties, read `<copilot-home>/skills/create-primitive/references/formal-verification.md` with the host read tool. The creator reference defines maintenance and evidence requirements.

Before full `ae verify`, map every acceptance criterion to trusted checks from `ae checks list --json`. Inspect commands/assertions and complete only proven work. Include `prompt-contracts` and `host-contracts` when configured; otherwise use the strongest relevant local check and report the absence. Do not invent check names, use checks for another output, run unrelated checks, widen scope for their failures, or fake registry updates. The creator reference retains these proof requirements.

Read `<copilot-home>/skills/references/resource-operations.md` with the host read tool. Run `resources validate --corpus` for ship-set edits. Update version 2 `capabilities` with lifecycle and eval evidence; authorized delegatable agents also update `engineer_allowlist` and Engineer `agents:` through generation. Derive inventory from source.

Use the selected host's declared capabilities; preserve isolation/reload limits without claiming parity. Judge boundary, overlap, usefulness, evaluation, and authority from evidence.
