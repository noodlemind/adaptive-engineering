# AE upgrade and trust stability

Chai needs existing repositories to continue delivery after an AE upgrade without repeated manual trust diagnostics or duplicate approval requests. This run covers the reported `--files` mistake, upgrade readiness, trust inheritance, and the transitions between those operations.

## Workflow

- [x] Read the Principles section of the poteto-mode skill.
- [x] Phase A: Frame
- [x] Phase B: Design the workflow
- [x] Phase C: Run the loop
- [x] Reproduce argument, upgrade, and worktree failures through the real CLI in isolated fixture homes.
- [x] Compare two designs and record the selected data shape, invariants, and rejected alternatives.
- [x] Fix command parsing and recovery without changing single-document or tree-list semantics.
- [x] Fix bound trust diagnosis and eligible worktree inheritance while preserving explicit revocation and policy-change review.
- [x] Report upgrade installation and workspace readiness accurately and exercise the complete worktree recovery journey.
- [x] Verify each unit, review the combined diff independently, and resolve accepted findings.
- [x] Phase D: Keep the audit trail
- [ ] Phase E: Verify and hand back

## Done predicate

The reported failures have reproducible regressions that fail against 0.14.1 and pass after the fixes. An unchanged approved primary and eligible AE worktree continue without renewed approval. Changed executable policy has one correctly bound human approval action. Diagnostics run through the agent. Upgrade reports installation separately from workspace readiness. Unsupported flag forms return an actionable error or have an explicit lossless multi-file grammar. Relevant security negatives, the complete Linux suite, package checks, and repository contract checks pass. A pull request contains the plan, evidence, and exact remaining qualification limits.

## Scope and rigor

Four related units cover argument grammar, trust resolution, upgrade readiness, and installed lifecycle coverage. The baseline is `e1d1cdff2743d16b1d2522374e18267df5e205af`, package version 0.14.1. Existing authored policy and explicit revocation remain authority. No real user trust record is approved by this run. Fixture approvals simulate a person only inside disposable test homes.

The critical assumption is that the primary and worktree use the same AE home and equivalent selected authority. Tests must vary both conditions instead of assuming them. A local user's exact incident remains unconfirmed until its state is observed. The release fix must cover the demonstrated conditions without claiming that it inspected that machine.

## Throughput checkpoint

Read-only exploration is partitioned into trust, upgrade, and argument grammar. Two independent design candidates precede implementation. Writers receive separate branches or disjoint owned files. Targeted behavioral tests run before each integration. The full suite and package qualification follow the combined candidate. Native editor/model activation and native Windows execution are reported separately from Linux fixture results.

The requested Mac skill path is unavailable in this environment. The existing workspace copy of poteto-mode supplies the workflow. Its named Claude and Grok model families are unavailable in the collaboration tool. Available Codex agents supply independent exploration and review, with that diversity limit reported.

## Trace and decisions

The append-only decision trail is `ae-stability-recovery-2026-11-03.tsv` in this directory. Source citations, failing reproductions, chosen design, verification commands, and open limits are added as the run advances.

## Selected design

Candidate A extends the existing trust owner with `binding`, `cause`, current `primary` observations, and one `recovery` action. The action names its owner, reason, and exact argv when a command is safe. Existing trust fields remain compatible. A stale direct grant may fall back to an independently current primary grant only when registration, repository identity, and exact approved policy still match. Explicit revocation, conflicts, unreadable state, unsafe authority, and policy mismatch continue to deny.

Candidate B makes upgrade own a broader reconciliation workflow. Its useful parts are an observed workspace result after upgrade and worktree creation, plus explicit selected-host delegation to the existing native setup owner. The first candidate is the base because trust resolution already owns the necessary decisions. The second contributes outcome composition. A second host reconciler, global host scan, new trust schema, automatic policy copying, and automatic `init-repo` are rejected. Native upgrade routing must earn its scope through an old-package-path reproduction before implementation.

The independent design judge scored A 22/25 and B 18/25 for authority safety, demonstrated causes, caller simplicity, scope compatibility, and rerunnable coverage. Available Codex agents supplied independent judgment. A different model family was unavailable.

The workspace result reports configuration prerequisites, never task adequacy or completed proof. Check preparation belongs to the Engineer. A person receives a trust approval action only after concrete executable policy is available for review. Invalid authority and mismatched primary/worktree policy receive diagnostic recovery first. Legacy split authority/store homes must remain visible instead of silently selecting a different approval target.

## Confirmed defects and regressions

| Defect | Owning code | Required behavior |
| --- | --- | --- |
| A stale direct worktree grant blocks a current exact matching primary grant | `packages/ae/lib/trust.mjs` | Eligible worktree inherits without a duplicate approval; denial cases remain denied. |
| Bare recovery commands discard workspace and home selection | Trust command, orient, check and verification consumers | All callers consume one bound recovery action. Read-only diagnosis stays agent-owned. |
| Upgrade success hides unresolved repository prerequisites | `packages/ae/lib/commands.mjs` | Installation and workspace outcomes are explicit and independently observable. |
| Native generated commands can retain an old package path | Existing native setup owner | Demonstrate the old binding failure before adding explicit selected-host upgrade routing. |
| Worktree reuse accepts a linked checkout from a foreign repository | `packages/ae/lib/worktree.mjs` | Reject before carrying plans or recording provenance. Actual CLI regression failed before the fix and passed afterward. |
| Scalar file inputs discard repeated or extra operands | Plan and review argument handlers | Reject before reading a document or mutating state. |
| Inline plan creation input fails preflight | Registry preflight | `--file=value` and separated syntax have equivalent behavior. |
| Inline authored plan fields bypass the decision-input combination guard or disappear from scope | Plan creation preflight and executor | Both consume one canonical argument representation, including literal values and boundaries. |
| Review treats a flag value as a verb | Review parser | Only declared positionals select the operation. |
| Plural input error gives no useful correction | Registry unknown-option validation | Explain canonical repeatable or singular `--file` syntax while preserving `tree --files`. |

The existing trust/upgrade/install baseline passed all 66 tests. A new CLI reproduction still denied matching worktree policy after primary approval. The existing tests therefore did not prove the reported transition. New shared/private full-lifecycle tests explicitly create and reuse a worktree after upgrade, execute a failing behavioral assertion before the product edit, complete the workflow there, retain one fixture approval, and preserve the primary product bytes.

## Independent review and corrections

The comments review requested no deletions or suppression changes. The correctness review found three additional P2 cases. Missing checks exposed an approval step before concrete preparation. Failed native root selection could display an ambient configuration home. Inline authoring flags could bypass a JSON-input combination guard or drop scope. The first two now have failing-first CLI regressions and passing integration coverage. The third is fixed by canonicalizing plan creation arguments and consuming values consistently in both preflight and execution. Its 20 owning cases pass; the independent final delta review passed 34 cases without another finding.

The rejected premise was that fixing `--file=` alone established equals-form correctness. Actual CLI calls with `--title=` and `--impacted=` disproved it. The final parser repair addresses the shared input representation, including flag-shaped literal values, instead of adding another field-specific branch.

The first complete-source run was intentionally interrupted after review found these cases. It is not recorded as a pass. Qualification restarts only after the reviewed source is settled. The earlier offline archive installation and installed delivery run passed, but the final archive is rebuilt after these corrections.

## Candidate qualification

The frozen product source is `9b0c310c184ca7eaf9e58c8e4a7f0811e4b8a770`, version 0.14.2. The offline-installable candidate SHA-256 is `751a94fd08cf4d1597bca40751010984a2ac0e0a8723b95e4fbf7913db2f69f3`. Audit-only commits do not change these package bytes.

- Focused argument, trust, worktree and upgrade regressions passed, including the shared/private complete delivery journey. The final independent delta review passed 34 cases.
- `npm run check:repo` passed 152 cases with two skips and zero failures. `npm run check:release` passed for source and the installed archive.
- A fresh offline installation of the final archive reports 0.14.2. Its installed behavioral delivery lifecycle passed, including the failing-before product assertion and hooks.
- A genuine archived 0.14.1 installation was upgraded to the final archived 0.14.2 candidate for Codex, Claude Code and Cursor. Deleting the old runtime breaks the negative control; after upgrade the regenerated hooks and literal projected fallback run successfully. Split roots, repository bytes, trust bytes, policy digest and approval time remain unchanged. Repeating upgrade produces no reconciliation actions. The durable prior-upgrade receipt records archive provenance and all host outcomes.

The first broad local run was interrupted for corrections. The final broad local run is **not a pass**: experiment tests fail because the sandbox cannot establish Linux process identity. The same behavioral test fails on unchanged 0.14.1 with `process identity is unavailable; absence is not proven`. This fail-closed protection is retained. Two renderer cases also failed under the broad workload but passed individually on both revisions. A short delivery case hit the existing 10-second proof-authority timeout. Isolated rechecks of the same case pass on both the frozen candidate and exact 0.14.1; the hook timeout and proof-authority implementation are unchanged. Shared workload is a plausible cause, not a proven diagnosis. Exact-head GitHub Linux, Windows and archive jobs must qualify the full inventory before release. The PR checks are the authoritative changing CI record; this file records the pre-submission observations.

Native editor/model acceptance and the original Mac state remain unverified. Available reviewers were independent agents within one model family. No persisted run transcript was supplied for audit; the evidence derives from observed commands, behavioral test output, source and commits.

## Principle choices

- **Fix Root Causes / Model the Domain:** trust owns authority and recovery; upgrade composes a workspace snapshot and delegates selected native reconciliation to the existing setup owner.
- **Test Behavior, Not Implementation / Prove It Works:** exercise the actual CLI and installed archives, include old-path negative controls, preserve denial cases, and compare environment failures with exact baseline source.
- **Separate Before Serializing Shared State:** implementation units used separate worktrees, then landed as reviewable commits with targeted integration gates.
- **Attack the Premise / Encode Lessons in Structure:** reject the file-only equals fix after authored scope loss was reproduced; make preflight and execution share canonical argument consumption.

Phase E remains open until exact-head CI is assessed and the PR is handed back with its actual qualification limits. The candidate is not merged, published, or installed on the user's machine by this work.

## GitHub source identity

Direct Git push had no credentials. The connected GitHub Git Data API published product commit `eb319b4c1d442644926a0db3caee7f3fa295bab5`. Its complete source tree and local tested commit `9b0c310c184ca7eaf9e58c8e4a7f0811e4b8a770` both resolve to `ae59640d0af4216b0300000df68da2685c34ee5d`. A read-only Git fetch independently confirmed the published tree. Historical observations retain their original local commit IDs; the portable provenance and migration probes use the byte-identical published commit. Audit commits add no package source changes.
