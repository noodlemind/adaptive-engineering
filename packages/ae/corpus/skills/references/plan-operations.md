# Plan decisions

The agent chooses intent, scope, tasks, acceptance criteria, check adequacy, research, risk, and whether observed work satisfies the goal. AE writes their representation and applies state transitions. It does not infer authorization from a payload field. Use the current `workflow` returned by orient, status, creation or update for the plan path, exact revision and structured candidate decisions. Candidate actions are not permission grants; their prerequisites may still be unevaluated.

Prefer the advertised workspace-bound `ae_plan_new` and `ae_plan_update` tools. They accept a decision object and handle stdin without shell quoting or temporary files. When those tools are unavailable, use `--file -` only with an execute transport that supports stdin. Do not write decision JSON into the repo, a worktree, or the system temp folder, or improvise a direct managed-plan edit. Read this reference when a decision needs detail beyond its tool schema.

When `workflow.observedIntent.state` is `pending`, include `observedIntent: {id, disposition, rationale}` in a current start, amend, progress, finding or gap decision. Copy the observed ID. Use `amend` disposition with an actual amendment when the contract changes; use `unchanged` with a rationale when the accepted contract still covers the request. A successful operation binds that disposition to the resulting plan revision. New host observations require another disposition; stale decisions, failed operations and old replays do not accept them. Completion cannot reconcile pending intent. `unobserved` means the host did not supply this evidence; a query is not a host event.

```text
ae plan-new --file - --json
```

```json
{"version":1,"format":"full","goal":"Reject invalid parser input."}
```

`.harness/decisions/` remains a valid on-disk location when a person already has a file there. Inputs are bounded JSON. Use `ae help plan-new` and `ae help plan-update` for the installed contract. Keep plan operations separate from product mutations.

## Create

Use `ae plan-new --file - --json` and pipe the creation JSON. `scope` is an array of repo-relative paths; Harness writes one path per line under `## Impacted Files`. A creation decision has version 1, format `full|short`, and a goal. Supply acceptance text, constraints, scope paths, the inspected named check, and selected intent-source paths. Copy the delivery classifier's `playbook` into this JSON. `ae plan-new --classification` validates the legacy flag form and cannot be combined with `--file`. Optional full-plan fields include type, slug, title, risk, outputs, authored notes, phases, and `skillsUsed`. Record only skills actually loaded. Primitive maintenance requires `create-primitive`; its declaration does not replace the successful skill read recorded for the session. Omit slug to let Harness derive it. Use open or needs-info status for an unlocked capture; such a draft can omit a check. Missing proof remains explicit.

```json
{
  "version": 1,
  "format": "full",
  "goal": "Reject invalid parser input.",
  "acceptance": ["Invalid input returns the documented error."],
  "scope": ["src/parser.js", "test/parser.test.js"],
  "check": "parser-behavior",
  "outputs": ["src/parser.js", "test/parser.test.js"],
  "notes": {"context": "Preserve the existing parser API."},
  "phases": [{"title": "Guard and proof", "tasks": ["Validate parser input.", "Exercise valid and invalid input."]}]
}
```

The example check must exist in the product's trusted configuration. A short plan requires acceptance and constraints. `scope` renders as one `` `- \`path\`` `` line per file under `## Impacted Files`. A hand-written section may also use `*` or numbered markers, several paths separated by commas or spaces, or a trailing description after the path. Scope failure names the parsed paths. Harness chooses storage, writes the date, headings, IDs, unchecked task state, initial status and source bindings, and returns `path`, `revision`, `planState`, `missing`, and `allowedNextActions`.

## Update

Use `ae plan-update --workspace <checkout> --plan <path> --file - --json` and pipe the decision JSON. Every operation supplies version 1, a stable decision `id`, an `action`, and `expect` copied from the observed revision. Supported actions are start, amend, progress, finding, gap, and complete. Get that revision from plan creation, a preceding operation, or `ae status --contract-digest --plan <path> --json`. Do not calculate it in the model.

```json
{"version":1,"id":"start-accepted-work","action":"start","expect":"<observed revision>"}
```

Supported decisions:

| Action | Agent input | Harness operation |
|---|---|---|
| start | Accepted readiness and current revision | Validate readiness and scope, lock and start the plan, publish its implement gate, recover interrupted publication |
| amend | Rationale and accepted changes | Validate and serialize scope, goal, constraints, criteria/check bindings, reviews, notes, phases, or selected source-byte amendments |
| progress | Accepted criterion/task IDs and optional current phase | Record checked state and phase without fabricating proof |
| finding | Stable finding ID and accepted text | Append once; reject conflicting content under the same finding ID |
| gap | Existing gap ID, done fulfillment, evidence path, and rationale | Bind the evidence hash, update the gap and resulting state; leave waivers and bridges to trusted policy |
| complete | Decision to finish | Require current review, executed proof, learning decision, and completed tasks across all phases; publish completion and done state |

Start accepts a resolved `open` or `needs-info` draft only after readiness passes and sets its initial execution phase. Closing the final hard gap returns new work to `planned` and preserves partially completed work as `in-progress`. New gap file bindings use `evidence_binding`; existing `evidence` observations remain authored observations and do not claim verified bytes.

An amendment's `changes` can contain `scope`, `goal`, `constraints`, `criteria`, `reviews`, `notes`, `phases`, or new `gaps`. Criteria use `{ "id": "AC1", "text": "...", "checks": ["named-check"] }`; omit a new ID to let Harness allocate it. Reviews cannot remove an existing code-review baseline. Phases use `{ "title": "...", "tasks": ["..."] }`; Harness numbers phases and generates task IDs such as P1T1. Existing unlabelled tasks can be addressed by their list IDs T1, T2, and so on.

Authored note keys are overview, context, memory, technical, research, routing, and implementation. Values contain prose or Markdown content without owned `##` headings. Harness creates or updates the corresponding section while preserving other reasoning. Progress uses `{ "criteria": ["AC1"], "tasks": ["P1T1"], "phase": 1 }`; omit fields that did not change. Accepted progress is a declaration. Executed verification remains a separate requirement.

## Procedure and verification amendments

Full and short creation can select a `playbook` and an explicit `verificationRecipe`. Harness binds the selected playbook's source identity and content. An amendment can change either field with a rationale. Changed playbook bytes require a fresh accepted binding; relock preserves the prior binding.

Use `changes.workflowNotApplicable` entries with `playbook`, `sha256`, `step`, and a nonempty `reason` for accepted exceptions to bound numbered steps. Synchronize with `ae todo sync --plan <path>`. Worklist completion records performed procedure steps. It cannot check acceptance criteria or plan tasks.

For a full plan, `changes.skillsUsed` appends skill names only after a complete successful read recorded under the current session identity. An old activation, partial read, declaration, or missing session identity cannot establish provenance. Short plans keep the activation in session activity instead.

## Selected intent bytes

New full plans use plan_schema 2. New short plans use short-v2. Both declare intent_source_policy content-v1. Source selection freezes when locked. Changed, missing, or unreadable selected bytes block current authority and invalidate proof. Relock never silently accepts them.

Accept a reviewed spec change with an amend decision, rationale, `authority` containing scope `plan-intent` and the basis for the decision, and `intentSources` containing `{ "path": "selected/spec.md" }`. Harness reads and records old/new hashes and affected evidence. Optional supplied oldHash/newHash values act as additional conflict guards. The authority field records the decision's scope; it grants no tool permissions.

Use top-level `intentSelection` with the complete observed `previous` path/hash list and the desired `next` path list to replace a frozen selection. Supply a rationale and plan-intent authority. The revision and prior bindings guard the amendment. Orient's paged discovery reports omitted candidates; absence of a selected path does not mean absence of intent.

Legacy plan_schema 1 and short-v1 retain their declared paths-only policy. Explicit migration uses `migrateIntent: true`, rationale, and plan-intent authority on an amend or start decision. Harness preserves an existing frozen selection and records upgraded bindings. Never describe a legacy plan as content-bound until migration succeeds.

## Recovery and completion

Missing prerequisites return blocked work and allowed next actions without a successful transition. A stale revision requires rereading before accepting a new decision. Retry the identical operation ID and payload after interruption; a completed retry returns the prior logical result. Reusing an ID with different content conflicts. Replaying start does not renew an expired gate.

After implementation and collected review, require passed `ae verify`. Record durable learning or explicit no-learning with `ae compound --learning-decision`. Submit complete only after all planned work is accepted. A completion record remains current only while its product, policy, contract, review, and selected source bindings remain valid.

## Encountered capability gaps

Declare new gaps in an amend decision with rationale and `changes.gaps`. Each entry supplies `id`, class `soft|bridge|hard`, scope `operation|criterion|plan`, `required_for` and a nonempty list of authored `evidence` observations. Criterion scope refers to an existing criterion. Harness initializes pending fulfillment, rejects duplicate/existing IDs and records the change under the revision guard. It cannot infer verified bytes or waiver authority from observations.

Choosing hard plan scope means the agent has determined that no safe planned work remains; Harness sets blocked-capability. Criterion and operation declarations preserve the plan lifecycle. Any pending hard gap prevents passed verification and completion. Resolve an existing gap through the evidence-bound gap operation. Payload fields cannot mark a declaration done, bridge or waived; scoped bridge/waiver authority belongs in trusted policy. Completed work requires a new work identity for newly encountered gaps.
