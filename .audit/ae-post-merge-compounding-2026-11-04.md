# Post-merge compounding recovery

## Goal and baseline

Recover and compound work delivered through two different-parent feature-branch worktrees after merges, using the original plans and implementation evidence. Refresh outdated current knowledge while retaining historical proof and release-branch applicability. Do not require a duplicate implementation plan for bookkeeping or treat a chat transcript as passed verification.

Baseline is merged PR #109, main `5184dbc475a5f9be7a25baffa175bdec8061e91d`, version 0.14.2. This is a new follow-up branch, `codex/ae-compound-merge-recovery-20261104`.

## Reproduced findings

1. Ignored shared authority is absent in a newly created worktree. `init-repo` there creates repository-wide local authority, causing the primary to reject competing local/shared sources. The primary's existing authority must be inspected before implicit initialization mutates project state.
2. Matching-source authority promotion works, but the CLI's `init-repo --shared --dry-run` rejects the same recoverable state before applying its projected descriptor.
3. An existing `harness/<slug>` branch can make `ae worktree --from <requested-tip>` silently reuse a branch that does not contain the requested start commit. Inline `--from=<ref>` was discarded, and workspace-relative `HEAD` resolved in the primary rather than the calling worktree. Explicit starts must resolve in the caller and remain compatible with existing work without resetting it.
4. The quoted in-progress-plan restriction is false. Current verification and required review permit compounding before completion; learning is a prerequisite of completion. The current wording about a completed issue/plan can create a circular agent interpretation.
5. Ordinary proof/review/learning bookkeeping is workspace-local. Deleting a worktree loses those records while external plans and published episodes survive. A remote merge or chat history cannot replace lost proof. A disposable CLI journey recovered the original plan in a recreated trusted checkout, reverified it and completed compounding without Plan 3.
6. Episode publication is immutable and replay-bound. Existing consolidation can supersede active claims, but it does not overwrite original solution episodes. Two contrary same-title captures remain separately indexed. A hash-bound, branch-aware episode supersession feature is a distinct capability gap; title-based overwrite would break prior publication/completion identities.

These fixtures reproduce mechanisms, not the exact private repository, placeholder paths or commit IDs in the user's report.

## Designs and decision

- Choose bounded CLI authority-resolution preflight and the existing promotion reconciler. An initial init-only implementation was rejected after independent review reproduced subfolder and bounded-check-writer bypasses. Protect the common selection owner before writers publish; retain early initialization selection before migration. Defer a repository-wide canonical-mode migration, which would change authority and trust identity across branches.
- Treat `--from` as a start point. An existing branch/worktree must contain that commit; allow valid descendants, reject stale/divergent reuse, and recommend a fresh slug. Do not reset or transplant files.
- Recover the existing plan on the intended branch/tip and obtain fresh verification/review when records are missing or stale. Preserve different release branches as separate evidence contexts. Complete learning and plan bookkeeping before deleting delivery worktrees.
- Publish corrected verified evidence under a new operation, then use existing consolidation `SUPERSEDE` for affected active claims. Keep historical episodes and explicit applicability. Defer automatic episode replacement until source hashes, branch applicability, atomic indexing and historical retrieval have a complete contract.

The episode capability gap is tracked in [issue #110](https://github.com/noodlemind/prompt-library/issues/110), with concrete proof, applicability, replay and retrieval acceptance. This follow-up must not claim that sealed episode replacement is implemented.

## Implementation and acceptance

1. Add failing authority cascade and promotion dry-run CLI regressions. Preflight before migration/authority/runner/index mutations; ordinary event journaling is outside this guarantee.
2. Add failing explicit worktree-start reuse regressions, including stale existing checkout, stale existing branch, legitimate descendant, dry-run and unchanged implicit reuse.
3. Correct compounding/recovery guidance: inspect fetched target commits and diffs, reuse original plans, distinguish lost proof from absent trust, preserve branch identity, and avoid automatic insight downgrade or a new implementation plan.
4. Add a CLI recovery journey showing in-progress publication and completion with the same plan after original-worktree removal. Retain current-head proof and required review checks.
5. Run focused tests, corpus/generated/release checks, independent review and current-head CI. Open a new PR; do not rewrite merged PR #109.
6. Prepare patch version 0.14.3 so the follow-up has a distinct installable identity.

## Scope and authority

Existing user authorization covers tracing and fixing AE stability and compounding recovery. New work belongs to existing CLI owners and existing workflow references; no new skill or specialist is installed. Do not choose local/shared precedence from one matching check, move private files into Git, grant trust, reset branch tips, transplant proof or rewrite sealed episodes.

Available independent agents use the inherited model. Claude/Grok model families requested by the standing workflow are unavailable here. Native VS Code approval behavior and the user's actual private repository remain unobserved.

## Naming clarification

The user also asked why `harness` remains visible. The migration deliberately names the public executable `ae` and starts fresh global state in `~/.ae`, while retaining `.github/harness`, `.harness`, persisted protocol keys and old stores. `harness/<slug>` remains the generated branch prefix. Correct the stale `harness compound` example to `ae compound`; a broader branch/storage rename needs compatibility work and is outside this recovery patch.

## Final source and verification

Frozen 0.14.3 product source is local commit `f8bdb18789fec257f7de4c01555eed548d1b723d`. Connected GitHub publication produced commit `7498d1eacab32daef64d15093bc4345a51c9e117`. Both have the identical complete Git tree `0b1f8be6608b9585e689f8c789ddc11688ebd17d`. Subsequent evidence-only changes do not alter package bytes.

- Failing CLI regressions were committed before source fixes. They demonstrate implicit authority shadowing, invalid promotion preview, discarded inline start, stale/divergent worktree reuse and incorrect caller-relative HEAD. Final review added and reproduced both subfolder and bounded-check-writer bypasses before the central correction.
- Final authority/check/layout suite: 71 cases, 67 passed, four platform skips, zero failures.
- Final worktree/start/helper suite: 24 cases, 23 passed, one Windows-only skip, zero failures.
- Learning/publication/plan-update suite: 48 passed, no skips or failures.
- Final repository/release contracts: 156 cases, 154 passed, two skips, zero failures. Corpus validation, generated Engineer checks, release validation and whitespace checks passed.
- Independent reviews rejected the init-only guard, then accepted the central correction with no remaining concrete findings. The guard preserves nested-repository and pure hook-selector boundaries. No newly introduced source comments or suppressions remain.
- A fresh-context guidance exercise reused both original plans, inspected complete authority sets, selected explicit fetched targets, refreshed proof and distinguished corrected episodes from active-claim supersession. This evaluates guidance, not live editor behavior.

### Two different-parent branches

The [rerunnable probe](ae-post-merge-recovery-probe.mjs) and [receipt](ae-post-merge-recovery-evidence.json) passed **67 assertions across 106 actual Git/AE CLI steps** against an immutable archive of the frozen product commit. All 17 recorded runtime owners matched that commit and stayed unchanged. The receipt SHA-256 is `1da48f678257ea11176613add8c25f39b4fc92f0a4ed9a5169584163fc071ad1`.

Alpha was completed before cleanup; beta remained in-progress with a published lesson. Both used current full schema-2 plans, content-bound intent and revision-bound lifecycle decisions. After merging and removing both original worktrees, recovery kept each original path and UUID, selected its exact fetched release target, obtained fresh review records and proof, published a new proof-specific lesson and completed the same plan. No third plan or renewed trust approval was needed. Local main remained stale and unchanged. All prior episode hashes were preserved.

Negative controls rejected the original hardcoded behavior, missing review coverage, proof recorded before a new commit and missing checkout records despite a still-trusted primary.

The probe uses source CLI assets from a Git archive with linked dependencies, not an installed npm archive. Review declarations are synthetic and explicitly retain unverified independence. Native editor behavior, extended domain/experiment plans, active-claim `SUPERSEDE` in this journey and automatic episode replacement are unqualified. The actual user's artifact type, authority differences and branch commits were not supplied, so this receipt does not claim to repair their private repository.

### CI corpus pointer correction

The initial PR revision failed the existing corpus-reference test because the new skill named a bare relative read pointer. The same test failed locally before the installed-corpus/host-read correction and passed afterward, three cases with zero skips or failures. Release validation passed again. The two-branch probe was rerun against the corrected frozen source identified above; it again passed 67 assertions and 106 CLI/Git steps. Superseded CI is not a passing result.
