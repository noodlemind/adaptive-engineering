---
name: code-review
description: Multi-agent code review with confidence-scored findings, persona synthesis, and action routing. Use when reviewing PRs, changes, or branches. Not for single-domain review — delegate to the specialist directly.
user-invocable: false
---

# Code Review

## Pipeline Role

**Step 4** of the connected pipeline: Capture → Plan → Work → **Review** → Compound.

This skill coordinates multiple specialist personas to provide comprehensive code review. Each persona returns structured findings with severity and confidence scores. Harness captures the review scope, validates coverage, applies confidence policy, and renders the factual report. The Engineer assesses defects and ambiguous overlaps.

The Engineer owns CLI `prepare` and `assemble`, including decision-file publication. The read-only `code-review-coordinator` dispatches the supplied packet and returns raw results; it does not acquire execution authority or replace Harness assembly.

## When to Use

Activate when the user wants to:
- Review a pull request or set of code changes
- Get multi-perspective analysis of code quality
- Audit code for security, performance, or architecture concerns

## Trigger Examples

**Should trigger:**
- "Review this PR"
- "Can you do a code review of my changes?"
- "Check this branch for issues before I merge"

**Should not trigger:**
- "Check this code for security issues only" → delegate to @security-sentinel directly
- "Is this Java code idiomatic?" → delegate to @java-reviewer directly
- "Review this plan document" → use /document-review

## References

Read these installed files with the host read tool. Do not search the product workspace for them, and do not open a checkout-relative path. They live under `<copilot-home>/skills/`.

- **Persona definitions:** Read `<copilot-home>/skills/code-review/references/review-personas.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/code-review/references/review-personas.md --json` prints the same file.
- **Findings schema:** Read `<copilot-home>/skills/code-review/references/findings-schema.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/code-review/references/findings-schema.md --json` prints the same file.

## Workflow

### 1. Capture Scope

Use `ae review prepare --plan <path> --base <base> --json` for delivery review. Omit `--plan` for standalone review. The packet supplies current head, working changes, required reviewers, applicable checks, source hashes, excerpts, retrieval paths, and explicit omissions. Use the host's PR tools to establish the requested comparison when reviewing a PR. A missing base or omitted source is an investigation input, never evidence of an empty scope.

Review criteria and executable named checks have separate roles. Missing executable checks or unapproved project trust do not prevent `prepare` or `assemble`; preserve the actual review results. For delivery, complete any needed check configuration and approval before the final review, because changing policy or trust makes an earlier packet stale. Diagnose a refused assembly from its actual error rather than attributing it to missing executable checks.

Read the full packet at `packetPath` and retrieve omitted source content before judging that area. Do not manually discover checks or reconstruct the packet. A changed source requires fresh preparation.

### 2. Gather Context and Detect Intent

- Read modified files and understand the changes
- Check available repository context for accumulated codebase knowledge: `README.md`, `.harness/agent-context.md` or `docs/agent-context.md`, and `docs/codebase-snapshot.md`.
- Use `/recall` for prior solutions and current-project private episodes. Read `<copilot-home>/skills/references/knowledge-locations.md` with the host read tool. Legacy committed `docs/solutions/` remains readable. Do not search only the checkout's solution directory. Outside the enforce hook, `ae get --reference skills/references/knowledge-locations.md --json` prints the same file.
- If a plan file is referenced, read `## Implementation Notes` for decisions and trade-offs
- Detect project type (Java, Python, TypeScript, SQL/data, AWS) from project files
- Read related code and dependencies touched by the changes
- Write a 2-3 line intent summary: what the change is trying to accomplish

Read `<copilot-home>/skills/engineer/references/performance-engineering.md` with the host read tool and apply it to applicable code and dependency choices in every review. Outside the enforce hook, `ae get --reference skills/engineer/references/performance-engineering.md --json` prints the same file. When the packet includes performance context or journey goals, read the full reference and assess both lenses. Missing telemetry permits static gap analysis; it cannot support a measured bottleneck claim.

### 3. Choose Additional Perspectives

Dispatch the packet's required reviewers and the matched checks. Do not add a persona the packet omitted. Read `<copilot-home>/skills/references/delivery-principles.md` with the host read tool for the review budget. Read `<copilot-home>/skills/code-review/references/review-personas.md` with the host read tool for what a selected persona judges.

### 4. Dispatch Personas and Checks

**Orchestration:** If the `agent` tool is available, the Engineer invokes each packet-required specialist directly, or sends the prepared packet, intent summary, and retrieved full sources to `code-review-coordinator` for isolated dispatch in batches of 3-4. Reviewer spawns use the `reviewer` role. Read the matching role line in `~/.cursor/rules/ae-models.mdc` or `~/.claude/rules/ae-models.md`. Pass that model when the host spawn tool takes one. A missing file, a missing line, or `inherit` means omit the model. Return all packet-required perspective/check results to the Engineer. A coordinator cannot run CLI commands through `terminalLastCommand`. Record provenance kind `host-invocation`, with `agent` set to the specialist that returned the judgment and `via` set to `engineer` or `code-review-coordinator`. Otherwise, the Engineer applies each required perspective in this session and records kind `same-context` with `agent` set to `engineer`. That same-context result is not an independent review.

Each persona receives:
1. Their persona definition from `<copilot-home>/skills/code-review/references/review-personas.md`, read with the host read tool
2. The findings schema from `<copilot-home>/skills/code-review/references/findings-schema.md`, read with the host read tool
3. Review context: intent summary, file list, diff, project type
4. Instruction to return structured JSON matching the schema

### Test scenario design

Owned by `spec-flow-analyzer` and by any review check whose criteria ask whether tests cover the change. List candidate files with the host search or list tool. Search file text with the host search tool. Do not run rg, grep, find, sed, awk, jq, or any program other than `node` and `git`. Outside the enforce hook, `ae tree workspace --files --json` and `ae search <query> --match literal --source code --json` are optional.

**Check dispatch:** Each discovered check is dispatched as a focused subagent. The subagent receives:
1. The check's full content (criteria, examples)
2. The findings schema from `<copilot-home>/skills/code-review/references/findings-schema.md`, read with the host read tool
3. The same review context as personas
4. The check's `severity-default` as the default severity for findings

Checks run in parallel with personas when the host supports that bounded delegation. If the coordinator cannot dispatch a required check under its declared tools and agent allowlist, it reports the limitation to the Engineer for direct judgment or authorized dispatch. Do not drop a reviewer the packet requires, and do not add one the packet omitted.

Each persona returns JSON:
```json
{
  "reviewer": "persona-name",
  "status": "completed",
  "findings": [...],
  "residual_risks": [...],
  "testing_gaps": [...]
}
```

### 5. Collect and Adjudicate

Pipe `{ "packet": "<id>", "results": [...] }` to `ae review assemble --plan <path> --packet <id> --file - --json`. Omit `--plan` for standalone review. Do not write the results JSON to a file. Each required result needs `status: completed`, findings, residual risks, and testing gaps. Retain a failed or timed-out result with its actual status.

Harness validates locations and schema, applies the confidence floor before aggregation, merges exact claims, preserves suppressed/raw results, and renders `report`. Exact claims share location, normalized title, description, and suggested fix. Different claims at one location and nearby locations remain candidate overlaps. Decide whether they describe the same defect from their evidence. Submit explicit `adjudications` with `action: merge|retain`, member IDs, and a rationale. Include prior adjudications when deciding a surviving overlap involving a merged finding. No automatic proximity clustering or severity escalation is permitted.

Use the returned report and coverage counts. Retrieve full raw evidence at `recordPath` and exact invocation payload at `observationPath`. Incomplete coverage blocks delivery completion. A supplied reviewer name does not authenticate the invocation; a confidence boost does not establish independent corroboration. Do not recalculate tables or counts in prose.

### 6. Quality Gates

Before delivering the review, verify:

1. **Each finding is actionable** — if it says "consider" or "might want to" without a concrete fix, rewrite it
2. **No false positives from skimming** — verify the "bug" isn't handled elsewhere in the same function
3. **Severity is calibrated** — a style nit is never P1; a SQL injection is never P3
4. **Line numbers are accurate** — verified against file content
5. **Findings don't duplicate linter output** — focus on semantic issues the linter won't catch
6. **Extra code is the defect** — a finding whose only fix adds a helper, option, comment, abstraction, or defensive check the spec did not name. Flag that extra code. Keep an exploitable bug and a missing check at a real boundary.

### 7. Continue from Evidence

Assess fix authority and behavior before acting. `autofix_class` is advisory routing metadata; it never grants permissions. Apply a finding only when it names a defect in the spec. Reject a finding whose fix only adds a helper, option, comment, abstraction, or defensive check the plan did not name. Before finishing, the diff is the smallest change that meets the spec. Apply authorized fixes, then prepare a new packet. The previous packet is stale once a reviewed file changes. Dispatch the packet's required reviewers for that packet. One filing reviewer does not complete coverage. Stop after two rounds and report the findings that remain. Clearing a plan string cannot discharge a recorded critical finding.

When current coverage is complete and critical findings are resolved, run `ae verify`. Completion and Stop consume this same bound review record. After passed verification, record durable learning or explicit no-learning with `ae compound --learning-decision <file>`, then submit a complete plan-update decision. A standalone read-only review ends with its report and has no delivery completion ceremony.

If verification reports missing check declarations, Engineer prepares the bounded configuration recovery described in `<copilot-home>/skills/create-primitive/references/named-checks.md`. `ae verify` can report diagnostics before that repair, but cannot pass delivery without its required checks. Refresh the affected plan/gate and review after authority changes, then continue automatically within the user's accepted scope.

## Error Handling

Use the CLI's missing/failure/omission diagnostics. Retry the affected judgment with its full evidence. Do not turn malformed, partial, timed-out, or unavailable results into a clean review. If a required capability is unavailable, report the degraded coverage. For semantic disagreements, retain both claims until the Engineer adjudicates them explicitly.

## Guardrails

- Be specific: reference exact file paths and line numbers.
- Be constructive: suggest concrete fixes, not just problems.
- Prioritize: most important issues first.
- Adjudicate candidate overlaps using the evidence; retain different defects separately.
- Separate pre-existing issues from newly introduced issues when the diff makes the distinction clear.
