---
name: ensure-plan
description: Internal plan creation and locking procedure for trackable work. Use when no suitable explicit plan exists or a matched plan is unlocked; not for execution, review, or capability discovery.
user-invocable: false
---
# Ensure Plan (internal)

Bridge capture and planning for Engineer Deliver mode. Decide intent, scope, criteria, check adequacy, research needs, and risk. Harness owns plan representation and transitions.

## Trigger Examples

**Should trigger:**
- "Implement this feature" when no suitable plan exists.
- "Continue this task" when the matched plan is open and unlocked.
- "Make these trackable changes" when required intent or proof inputs are missing.

**Should not trigger:**
- "Log this issue for later." Use /capture-issue.
- "Research this captured issue." Use /plan-issue.
- "Execute this locked plan." Use Engineer Deliver mode.
- "How does this flow work across repos?" Engineer Investigate mode. Do not create a plan.

## Confusable Boundaries

Capture records the problem. Planning chooses the approach. Engineer executes the accepted plan. /ensure-capability handles encountered capability gaps.

## Proportional planning

Use concise content for one or two intended product files, expected completion in one session, a user-supplied target or reference, no architectural choice, and focused trusted verification. Use one phase and no broad repository scan. Consult a specialist only when its judgment is needed.

A read-only investigation does not use this skill, even when it spans many files or repos. During Deliver, escalate when the change reveals a data migration, security or concurrency implications, compatibility risk, more affected files, or unclear verification. Choose full or short representation through the same CLI contract; both require current proof.

## Establish the decision

1. Use `ae lookup` or `ae orient --read` to retrieve existing plans. Judge semantic overlap before creating another work item.
2. Read selected specs and relevant /recall evidence. Resolve ambiguity from available sources. If required intent remains ambiguous, capture an unlocked needs-info draft and state the missing decision.
   When orient supplies a relevant `flowModel` pointer, read its generation and source scope to check intent completeness: entry paths, guards, failure, cancellation, and recovery. Inspect the task's current sources separately. The shared map describes committed default-branch behavior; it cannot accept requirements, become an automatic `intent_sources` entry, or authorize a change. Missing or stale optional context does not block unrelated work. Read `<copilot-home>/skills/codebase-context/references/flow-models.md` with the host read tool only when expansion or regeneration is needed. Outside the enforce hook, `ae get --reference skills/codebase-context/references/flow-models.md --json` prints the same file.
3. Read the selected check source reported by `ae checks list --json` and inspect each candidate assertion. Never invent a named check. A schema-validation check is inadequate when no schema output is planned. Choose a relevant trusted check and explain any limitation.
   Inspect orient's `checkReadiness` separately from trust. For missing, empty, or inadequate checks, read `<copilot-home>/skills/create-primitive/references/named-checks.md` with the host read tool. Engineer owns recovery: inspect the product's tests, prepare concrete declarations through `ae checks configure --file - --json`, and present the exact changed commands for a person's approval when required. This bounded configuration operation can precede the implement gate; it grants no command execution or product-edit authority. Include only the exact prepared shared check source alongside the task's product files in the accepted plan; private configuration stays outside product scope. Do not require a separate setup plan or commit. Preserve usable existing checks and approvals across upgrades. After the required approval, resume this accepted task without another intake or permission request.
   For a visible behavior change, inspect orient's verification metadata and read the selected recipe. Resolve an ambiguous or incomplete inventory through an explicit accepted selection. Read `<copilot-home>/skills/create-primitive/references/product-verification.md` with the host read tool when creating or updating the recipe or feature map. Outside the enforce hook, `ae get --reference skills/create-primitive/references/product-verification.md --json` prints the same file. Choose affected features and shared prerequisites, then bind their named drives to criteria. Create a missing recipe only within the Deliver plan's accepted scope. Answer mode does not create plans or recipes.
   For a new critical property or a change touching an existing formal check, read `<copilot-home>/skills/create-primitive/references/formal-verification.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/create-primitive/references/formal-verification.md --json` prints the same file. Reuse the selected product recipe, inspect the property and coverage, and include its maintain and executable checks in accepted scope. An abstract model pass cannot replace proof against the implementation.
4. Dispatch the delivery classifier. Copy its `playbook` (`bug-fix`, `feature`, `refactor`, `perf`, or `investigation`) into the creation decision. Do not pass `--classification` with `--file`. Do not invent a playbook when the classifier abstains. `investigation` does not activate caffeinated. Use the current `workflow` and advertised workspace-bound `ae_plan_new` or `ae_plan_update` tool for accepted amendments, reasoning, phases, progress, findings, gaps, and completion. Reconcile pending `workflow.observedIntent` in that decision. CLI fallback is `ae plan-new --file - --json` or `ae plan-update --plan <path> --file - --json` through a supported stdin transport. Do not write the decision JSON to a file. Read `<copilot-home>/skills/references/plan-operations.md` with the host read tool when the tool schema and current workflow leave a decision unclear. Outside the enforce hook, `ae get --reference skills/references/plan-operations.md --json` prints the same file. Do not generate frontmatter, headings, dates, hashes, or activity records.
5. Before the first product edit on the default branch of a primary checkout, use `ae worktree --slug <slug> --workspace <primary>`. Keep later operations bound with `--workspace <worktree-path>` or by running from that checkout. A worktree created by `ae worktree` inherits trust from a trusted primary checkout of the same repository while that primary stays trusted. `ae trust status` in the worktree names the primary. Revoking the primary removes the inheritance. Any other folder still needs a person's `ae trust approve` before `ae verify`. The agent must not grant approval.
   CLI workspace selection does not change the editor's active workspace or host write permission. For access issues, read `<copilot-home>/skills/references/tool-native-loop.md` with the host read tool and resume this plan in the permitted checkout.
6. Submit a start decision as its own workspace-bound AE tool call, or use `ae plan-update --workspace <worktree-path> --plan <path> --file - --json` through supported stdin. AE validates readiness, changes state, and publishes the implement gate as one recoverable operation. Wait for explicit success before making a product edit in a later tool call. A blocked result supplies missing prerequisites and the current structured workflow.

## Continue delivery

After prerequisites pass, follow orient's procedure `command`. Read `<copilot-home>/skills/caffeinated/SKILL.md` with the host read tool when a playbook activates it. A not-truncated read of that SKILL.md is activation. Read the bound playbook at `<copilot-home>/skills/references/playbooks/<id>.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/caffeinated/SKILL.md --json` and `ae get --reference skills/references/playbooks/<id>.md --json` print the same files. Do not search the product workspace for either file. A path or `skills_used` declaration alone is insufficient. That skill continues the established Deliver work without repeating intake classification or planning. Missing prerequisites stay with /ensure-plan, and high uncertainty remains abstention.

Implement within the accepted scope. Use focused TDD checks during implementation. Record accepted progress through the CLI. Prepare review with `ae review prepare`, obtain the required judgments, fix valid findings, and collect them with `ae review assemble`. Require passed `ae verify`, then record durable learning or explicit no-learning with `ae compound --learning-decision -`. Submit a complete decision on stdin with `ae plan-update --plan <path> --file -`.

An intent amendment records accepted source bytes and affected evidence. Refresh the start/gate before a later product correction when its contract changed. Do not repair an unrelated optional check or add its files to scope.

## Guardrails

Use the CLI's missing prerequisites and allowed next actions. An operation retry returns the prior logical result; it does not renew an expired gate or bless changed content. Preserve authored reasoning. Do not edit a `~/.ae` plan in the editor.

Resolve a wrong workspace or selected home before changing checks. Do not treat `trusted: true` as verification readiness, ask the user to hand-author configuration, or loop between orient and ensure-plan without preparing the reported repair. Missing executable checks do not prevent recording a review; verification still needs current behavioral proof.

Respect existing user authorization and the single human approval policy. Under strict autonomy, stop at an unauthorized gated decision. This skill plans; it does not implement product code.
