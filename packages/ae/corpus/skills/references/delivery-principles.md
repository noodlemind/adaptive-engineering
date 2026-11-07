# Delivery principles

Read this file before the first edit of a Deliver task. Name a principle in the report only after reading its section. The harness does not treat the name as proof.

For code changes, read `<copilot-home>/skills/engineer/references/performance-engineering.md` with the host read tool and apply its code principles even when the request does not name performance. Outside the enforce hook, `ae get --reference skills/engineer/references/performance-engineering.md --json` prints the same file. Use applicable journey goals and constraints returned by orientation; measure runtime claims through the existing named checks.

| Name | Rule |
|---|---|
| smallest-change | The diff is the smallest change that meets the spec. |
| prove-with-evidence | A pass is the named check output, not a claim that it passed. |
| behavior-not-implementation | Tests assert the observed behavior. |
| bind-before-lock | The routing snapshot on the plan is the contract. |
| classify-inputs-only | Classification proposes paths, risk, domains, and a playbook. Policy binds procedure names. |
| pointers-not-bodies | Context carries paths. It does not paste skill or principle bodies. |
| harness-never-calls-a-model | Routing, plan creation, indexing, and projection do not start a model client. |
| legacy-stays-valid | A locked plan without `routing:` does not gain a new failure. |
| attack-the-premise | After two failed fixes that share one premise, stop and list who holds that premise. |
| subtract-before-you-add | Remove the dead path before adding a new one. |
| build-the-lever | A repeated edit becomes a script or check a reviewer can rerun. |
| model-the-domain | Choose the data shape before writing the logic that uses it. |
| sequence-verifiable-units | Each commit ends in a state someone can check. |
| ask-only-when-undrivable | Ask the owner only with a stated reason the product surface could not answer the question. Gate denial and destructive actions still stop. |
| standards-over-local-drift | Match the module layout. New code follows the language or framework standard when the surrounding code does not. |
| one-writer | When `orient --read` stored a non-empty file list, a product path must be one of those files. `mkdir` may create a parent of a listed file. |
| parent-reads-the-diff | The implementer report is evidence. The Engineer reads the diff and writes the summary the person sees. |
| verify-between-units | Run focused TDD checks between units; collect required review before authoritative `ae verify`. |
| spec-before-code | Read in-repo specs and intents named by orient before implementing. A repo with none yet runs `ae prepare`, then a person edits the starter files. Ambiguity is `needs-info`, not a guess. If shipped behavior contradicts a locked spec, update that spec in the same PR or a stacked PR. |
| isolate-issue-work | Automatic issue work runs in a linked git worktree from `ae worktree`, not the current default-branch checkout. |

## smallest-change

The diff is the smallest change that meets the spec. Reuse the code that is already there. Do not add a helper, option, dependency, abstraction, or comment unless the plan names it. Validate only at a real boundary. A real boundary is untrusted input, auth, persistence, or a process edge. Three similar lines are enough until a fourth appears.

## review-budget

Review the finished diff once before `ae verify`, not after each task. Cap the default at three. A fix re-dispatches only the files the fix touched. Stop after two rounds. Count a finding only when it names a defect in the spec.

## prove-with-evidence

See `docs/reference/plans-and-proof.md`. Run the checks named on the plan. Paste the result that shows the pass.

## behavior-not-implementation

Assert what a caller observes. A test that only mirrors the current private structure does not lock the behavior.

## bind-before-lock

`evaluateRouting` writes the snapshot. Later steps read it. They do not match the live policy again.

## classify-inputs-only

The host sub-agent returns the classification object. Copy its `playbook` into the `ae plan-new --file -` creation JSON. `ae plan-new --classification` validates the legacy flag form and cannot be combined with `--file`. A glob match wins a disagreement. The CLI does not choose a playbook.

## pointers-not-bodies

Orient and SessionStart name files to read. They do not inline the skill.

## harness-never-calls-a-model

`plan-new`, `route`, orient, hooks, and the index builders do not start a provider. The optional agent switch is outside delivery routing.

## legacy-stays-valid

R1 checks a snapshot when the plan has one. A plan locked before routing existed stays valid.

## attack-the-premise

If two fixes fail for the same reason, the premise is the next thing to test. Do not ship a third patch on top of it.

## subtract-before-you-add

Delete the unused branch, flag, or copy before introducing a replacement.

## build-the-lever

When the same edit has already been repeated, leave a check or script that a reviewer can run.

## model-the-domain

Name the type, table, or state machine in the plan before the implementer writes behavior around it.

## sequence-verifiable-units

For a bug, land the failing repro before the fix. For a feature, keep each commit independently checkable.

## standards-over-local-drift

Use the same directories, names, and test layout as the module you are editing. If that module contains a pattern that conflicts with the current language or framework standard, the new code follows the standard. A prior change is not a reason to repeat the break.

## ask-only-when-undrivable

Drive the real surface first. A question to the owner includes the reason that surface could not reach the answer. Approval for a destructive action, and a denied gate, still wait.

## one-writer

When `orient --read` stored a non-empty file list, the edit gate allows a product path only when that path is one of those files. A directory or glob entry does not allow other files. `mkdir` may create a parent directory of a listed file. Two writers do not share a workspace. Each writer calls `orient --read` with its own files before editing.

## parent-reads-the-diff

The implementer report is evidence. The Engineer reads the diff and writes the summary the person sees.

## verify-between-units

Run focused tests through the failing-test, minimal-fix, cleanup TDD loop for each unit. Record the command, outcome, and what the check proves. Focused tests do not establish delivery completion. After changed work has complete required review, the Engineer runs `ae verify` and requires outcome `passed`. Outcome `type-check-only` is not a pass for behavioral work. A changed contract, product content, selected content-v1 intent bytes, or new git head invalidates relevant stored evidence.

## spec-before-code

Orient lists in-repo specs, ADRs, RFCs, intent files, and issue notes. A repository with none of those yet runs `ae prepare`, then a person supplies the missing intent in the starter files. Read those paths before implementing. Record them on plan `intent_sources`. Under content-v1, lock writes `{ path, sha256 }` for each source on that tip and later changed, missing, or unreadable selected bytes block current authority. Accept reviewed source changes with an explicit plan-intent amendment, then refresh the gate; relock does not silently accept new bytes. Legacy plans retain their paths-only guarantee until explicit migration. If a source is ambiguous, capture `needs-info` and missing questions through plan decisions. Do not invent the requirement. If shipped behavior contradicts a locked spec, update that spec in the same PR or a stacked PR. Do not rewrite the spec from the code in silence.

## isolate-issue-work

Do not edit the current default-branch checkout in place. Run `ae worktree --slug <issue-slug>` and continue with `--workspace` on that path. CI and `--allow-inplace` skip the check.
