# Recover learning after merges

Engineer owns inspection, checkout recovery and bookkeeping. Use the existing plan and its implementation, review and learning context. A missing worktree or an `in-progress` status does not require another implementation plan.

## Inspect authority and the intended commits

Run read-only `ae trust status --json` with the selected workspace and homes. An authority conflict does not mean every command is unavailable or that only the person can inspect it. Compare all supported local/shared source files and their presence. One matching check does not establish equivalent policy.

When shared publication is already authorized and the complete source sets satisfy the existing promotion contract, inspect `ae init-repo --shared --dry-run --json`, then use that reconciler. It preserves the local source as a backup and grants no trust. If bytes or destination intent differ, prepare the exact difference and obtain only the missing decision. Do not move ignored policy aside, copy it across branches, or choose precedence silently.

Inspect the recorded source plans, accepted bases, pushed branch tips and merge commits. Fetch the named remote refs through the permitted Git tool when needed, then resolve their commit IDs and inspect the relevant diffs. A stale local main can remain in place. A remote merge proves integration; it does not supply current verification. Chat history supplies context, not a verification receipt.

## Recover each delivery context

For different-parent release or feature branches, retain each original plan, accepted base and target commit. Do not infer that proof for one branch covers the other. Reuse a suitable checkout or create an AE recovery worktree with a fresh slug and explicit `--from <resolved-commit>`. Check its actual HEAD and branch before proceeding. CLI workspace selection does not change the editor's access scope.

Run trust status in that checkout. A trusted primary with exactly matching authority can supply ordinary AE inheritance. Missing proof is separate from missing trust; never ask for approval merely because a verification record was deleted. Prepare any genuine trust decision with exact policy differences. The agent must not grant it.

Read the original plan and update only necessary accepted progress or context through `plan-update`. Preserve its frozen intent, scope and base. Recollect required review and run verification for that plan in the intended checkout when proof is stale or absent. A new commit or merge can invalidate earlier proof. Use the original accepted base, not a guessed `HEAD^`. If the integrated change exceeds accepted scope, prepare the specific amendment instead of inventing a duplicate plan.

Publish the learning against current proof, then complete that same plan. Use a new learning operation when proof or content changes; replay the same operation only for identical accepted input. Inspect all delivery plans and finish their learning/completion transactions before removing worktrees. After committing or merging, check the final HEAD binding before treating an earlier completion as current.

## Refresh outdated knowledge

Read the actual earlier artifact and identify whether it is a solution episode or a consolidated claim. Compare it with the verified target and name the changed behavior, such as configurable retries replacing three attempts and a 500 ms delay. Preserve applicability when an older rule remains valid on another release branch.

Publish a corrected verified episode under a new operation, citing the earlier artifact and applicable commits. Original episodes have sealed content identities; overwriting one would invalidate its publication and completion records. Inspect `ae consolidate --candidates --json` and use the frozen-packet `SUPERSEDE` operation for an affected active claim, following `<copilot-home>/skills/references/learning-operations.md`. Preserve any required governance decision.

Episode publication and active-claim supersession are separate results. Report the corrected episode and the returned claim update. Historical episodes remain indexed; do not claim they were replaced or excluded from retrieval. If no active claim exists, state that limit and record the old episode's historical role in the corrected lesson. Do not silently leave a recognized outdated claim active, downgrade a verified fix to an insight for convenience, or report a planned refresh as completed.
