# AE upgrade and trust stability

Chai needs existing repositories to continue delivery after an AE upgrade without repeated manual trust diagnostics or duplicate approval requests. This run covers the reported `--files` mistake, upgrade readiness, trust inheritance, and the transitions between those operations.

Current package source is `e8ab86203c4c46f7927a5591da23239dc0007fee`; archive SHA-256 is `fab554a19d393d1f8f21390706c90bf7a6f65393795287e632118ce23929bb28`. Local required checks and clean installed migration pass. Final Linux/Windows/package CI results are recorded in PR #109. Earlier candidates below are retained as qualification history.

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
- Phase E: Verify and hand back; the final same-revision CI assessment is recorded in PR #109.

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

## First candidate qualification (superseded)

The frozen product source is `9b0c310c184ca7eaf9e58c8e4a7f0811e4b8a770`, version 0.14.2. The offline-installable candidate SHA-256 is `751a94fd08cf4d1597bca40751010984a2ac0e0a8723b95e4fbf7913db2f69f3`. Audit-only commits do not change these package bytes.

- Focused argument, trust, worktree and upgrade regressions passed, including the shared/private complete delivery journey. The final independent delta review passed 34 cases.
- `npm run check:repo` passed 152 cases with two skips and zero failures. `npm run check:release` passed for source and the installed archive.
- A fresh offline installation of the final archive reports 0.14.2. Its installed behavioral delivery lifecycle passed, including the failing-before product assertion and hooks.
- A genuine archived 0.14.1 installation was upgraded to the final archived 0.14.2 candidate for Codex, Claude Code and Cursor. Deleting the old runtime breaks the negative control; after upgrade the regenerated hooks and literal projected fallback run successfully. Split roots, repository bytes, trust bytes, policy digest and approval time remain unchanged. Repeating upgrade produces no reconciliation actions. The durable prior-upgrade receipt records archive provenance and all host outcomes.

The first broad local run was interrupted for corrections. The final broad local run is **not a pass**: experiment tests fail because the sandbox cannot establish Linux process identity. The same behavioral test fails on unchanged 0.14.1 with `process identity is unavailable; absence is not proven`. This fail-closed protection is retained. Two renderer cases also failed under the broad workload but passed individually on both revisions. A short delivery case hit the existing 10-second proof-authority timeout. Isolated rechecks of the same case pass on both the frozen candidate and exact 0.14.1; the hook timeout and proof-authority implementation are unchanged. Shared workload is a plausible cause, not a proven diagnosis. Exact-head GitHub Linux, Windows and archive jobs must qualify the full inventory before release. The PR checks are the authoritative changing CI record; this file records the pre-submission observations.

Native editor/model acceptance and the original Mac state remain unverified. Available reviewers were independent agents within one model family. No conversation-wide agent transcript was supplied for audit; installed qualification has command transcripts. The evidence derives from observed commands, behavioral test output, source and commits.

## Principle choices

- **Fix Root Causes / Model the Domain:** trust owns authority and recovery; upgrade composes a workspace snapshot and delegates selected native reconciliation to the existing setup owner.
- **Test Behavior, Not Implementation / Prove It Works:** exercise the actual CLI and installed archives, include old-path negative controls, preserve denial cases, and compare environment failures with exact baseline source.
- **Separate Before Serializing Shared State:** implementation units used separate worktrees, then landed as reviewable commits with targeted integration gates.
- **Attack the Premise / Encode Lessons in Structure:** reject the file-only equals fix after authored scope loss was reproduced; make preflight and execution share canonical argument consumption.

The PR verification section records Phase E after same-revision CI is assessed, with actual qualification limits. This audit snapshot is written before that changing CI result. The candidate is not merged, published, or installed on the user's machine by this work.

## GitHub source identity

Direct Git push had no credentials. The connected GitHub Git Data API published product commit `eb319b4c1d442644926a0db3caee7f3fa295bab5`. Its complete source tree and local tested commit `9b0c310c184ca7eaf9e58c8e4a7f0811e4b8a770` both resolve to `ae59640d0af4216b0300000df68da2685c34ee5d`. A read-only Git fetch independently confirmed the published tree. Historical observations retain their original local commit IDs; the portable provenance and migration probes use the byte-identical published commit. Audit commits add no package source changes.

## Broad-run correction

The first settled-source broad run completed 4,224 cases with 4,146 passes and 32 failures. It is not a passing qualification. Three context-budget failures are introduced: serializing the complete bound recovery command into the 2KB `Next tools` section displaces useful learning and application-flow entries, and a person approval can appear while checks remain missing. A focused correction keeps the complete diagnosis and argv in structured `trust.recovery`, uses a compact reference in the pack, and respects the same check-preparation sequence as workspace outcomes. The candidate must be rebuilt and installed qualification repeated after this correction. Remaining failures are being classified through exact-baseline comparisons and isolated rechecks; the PR CI record will distinguish superseded runs from final qualification.

## Broad-run correction

The first settled-source broad run completed 4,224 cases with 4,146 passes and 32 failures. It is not a passing qualification. Three context-budget failures are introduced: serializing the complete bound recovery command into the 2KB `Next tools` section displaces useful learning and application-flow entries, and a person approval can appear while checks remain missing. A focused correction keeps the complete diagnosis and argv in structured `trust.recovery`, uses a compact reference in the pack, and respects the same check-preparation sequence as workspace outcomes. The candidate must be rebuilt and installed qualification repeated after this correction. Remaining failures are being classified through exact-baseline comparisons and isolated rechecks; the PR CI record will distinguish superseded runs from final qualification.

## Corrected candidate

The context-budget regression was reproduced independently on the candidate and passes on exact 0.14.1. The corrected display keeps bound recovery in structured output and uses concise pack references. All three observed context failures, new sequencing regressions, and seven owning files pass: **54/54**. Independent delta review found no further issue. The four other isolated timeout cases (lock publication, multiline compilation, FIFO no-follow race and fresh primitive activation) pass on the candidate, and their test files plus directly exercised modules are unchanged from baseline. These are recheck results, not a claimed proven timeout cause.

The final product source is published commit `4bbd786a71e19a793128f35e9854cbb7b689024a`, tree `cb1572ccf52e88be57c4d39ffb919ff1131b06ea`, matching local `54d49dc`. The rebuilt 0.14.2 archive SHA-256 is `5dc67be1ee0645eba72eeb1341889fc53ea78a425fdee778f16ad1cf6ad1db17`. Installed delivery and genuine prior-version qualification are repeated against this archive before submission of the final review head. The first candidate archive, source and CI are historical evidence and are superseded.

Final pre-CI qualification passed: the rebuilt archive's installed behavioral lifecycle passes, release contracts pass, and repository contracts pass with 152 passes, two skips and no failures. Genuine 0.14.1-to-final-0.14.2 migration passed again on Codex, Claude Code and Cursor. Provenance compares all 449 old and 450 final shipped source files with their exact published commits. The prior-upgrade receipt contains final results and preserves the original candidate as superseded history. PR #109 carries final same-revision Linux/Windows inventory and archive check results as the changing Phase E record.

The hosted Linux run on the superseded head independently completed all 4,224 cases: 4,176 passed, the three known context-budget regressions failed, and 45 skipped. No process-identity or completion-timeout failure occurred there. Its failed aggregate correctly rejected the inventory. This supports the environment classification of the additional local failures while leaving the corrected revision to its own CI qualification.

The superseded Windows run also exposed three new trust test expectations using an 8.3 temporary-parent spelling while AE correctly returns the native canonical workspace path. The fixture now uses `fs.realpathSync.native`, matching the existing identity owner. Exact binding and approval-command assertions remain intact. The 25-case Linux owning suite passes and independent review found no issue; native confirmation remains in final Windows CI. This changes test setup only and does not change the qualified archive.

## PR review correction

Repository review identified a P1 mixed-snapshot authorization flaw in the candidate inheritance path: `primaryDigest` observed policy A, while `approvalState` reread primary B and could approve B before comparing child A with the earlier A digest. This is an accepted finding. Deterministic regressions reproduce both current and pre-routing approval races and direct status inconsistency. The correction computes current and eligible legacy approval digests from one bounded pin read and passes that checked snapshot to the approval decision and inheritance comparison. The orientation conditional `afterInspection` handoff is also withheld centrally until checks are ready, including normal and read output. The rebuilt archive and complete qualification must supersede the prior candidate. These findings are fixed and verified before any release handoff.

## Snapshot-consistent candidate

The accepted PR findings are corrected in published product commit `e8ab86203c4c46f7927a5591da23239dc0007fee`, tree `60114e22d859ffd63f2b49c563afe2bd78f1f7c0`, byte-identical to local `001b479997286aeca3f9debba2e39ecc1a4f93c3`. The rebuilt archive SHA-256 is `fab554a19d393d1f8f21390706c90bf7a6f65393795287e632118ce23929bb28`. Earlier candidates and CI are superseded qualification history.

Trust owning/boundary/recovery tests pass **88/88**. Independent review passes all 64 modern/legacy digest compatibility comparisons, 64 corresponding approval outcomes and four reported deterministic race cases. No hash format, API schema or revocation behavior changes. The central orientation facts owner withholds conditional person handoffs until checks are ready across normal, embedded v2 and explicit read output; its final seven-file context group passes **55/55**. Independent review finds no remaining issue. Native canonical fixtures retain exact path assertions.

The source is frozen while installed delivery and genuine prior-release qualification are repeated against this archive. The final PR revision then runs the complete Linux/Windows inventory and Node 20/24 package matrix. Repository bot findings are included in the audit; collaboration reviewers remain within one known model family, and no bot model-family identity is assumed.

## Final pre-CI receipts

The final archive's installed behavioral lifecycle passes. Source release checks pass. Repository contracts pass **152/154**, with two platform skips and no failures. A root-run independent clean qualification passes all 53 recorded steps for the genuine 0.14.1-to-final-0.14.2 migration across all three native hosts. Its three intentional old-runtime negative controls fail as designed; every required positive command exits successfully. The active prior-upgrade receipt records this result and exact published-source provenance.

One earlier final-archive attempt stopped on leftover empty setup-lock directories at its repeat-upgrade step. The original fixture remains preserved. Eight fresh lifecycle controls across temporary and workspace storage release their locks, and the complete independent run passes. The cause remains unproven; no product lock change was made. This inconclusive attempt is retained alongside superseded archive evidence.

Windows exposed a second fixture assumption: global `core.autocrlf=true` transformed child policy to CRLF while the primary fixture retained LF. The product correctly rejected exact byte mismatch. The fixture now disables conversion locally and asserts approved digest parity. It passes 29/29 cases both normally and with forced global conversion. No product newline normalization was added.

A pre-existing native launcher test used a 15-second outer cap although the configured host allows 60 seconds. The unchanged Windows quoted command previously passed in 2.177 seconds; its later null-status failure did not capture an error code, so its cause is unproven. The test now uses the declared hook deadline, and direct bridge fixture calls allow 60 seconds while production deadlines stay unchanged. Failures report measured elapsed time, status, signal, error and output. Root's complete repository check supplies final local qualification; mixed logs and an unavailable empty-log verification session are excluded. Final native Windows execution remains a PR CI gate.
