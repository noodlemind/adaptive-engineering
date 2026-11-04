# VS Code Default Permissions follow-up

Goal: support routine Engineer delivery in VS Code Default/Manual Permissions without unnecessary permission requests. Full Permissions is not a prerequisite.

## Evidence and limits

- Baseline is PR #109 at `8086ed8d5f4b9fcb90b928bb63be162f18a947b4`. Main still contains 0.14.1; the PR is unmerged.
- Engineer, code-implementer and bug-reproduction-validator declare `edit/editFiles` but no creation capability. The current official Copilot custom-agent reference supports the `edit` group. Local tool documentation distinguishes editing from creation.
- Shared fallback instructions infer a restricted subagent from an unavailable tool and do not distinguish absence from denial.
- `ae worktree` binds subsequent CLI operations to a checkout. It does not bind VS Code's workspace or grant host access. Nested `.worktrees` is not necessarily outside an open primary folder.
- Plan decisions use CLI writes to an external state home. Host terminal approval is independent of AE trust. Existing MCP tools are not automatically registered for VS Code and cannot silently rebind roots.
- There is no live VS Code session here. CLI, projection and contract checks cannot establish that the user's Allow windows disappeared. The active host, target shown in the dialog and effective workspace remain unobserved.

## Designs considered

1. Correct the existing writer capabilities and permission/workspace contracts. Preserve role boundaries, state writers and host-owned approval. This addresses confirmed source defects without changing user settings.
2. Integrate workspace-bound MCP lifecycle tools with VS Code setup. This could reduce generic terminal transport for bookkeeping, but requires host configuration ownership, root rebinding and native qualification. MCP tools can still require approval. Defer this architecture until a real approval trace establishes the need.

Choose design 1. Do not add a permissions broker, broad writable roots, global autoapproval, an in-repository state store or a terminal workaround for denied edits.

## Work and checks

1. Add failing writer-capability, native projection and validation regressions.
2. Use the supported `edit` group for the three implementation roles. Keep decision-only plan-coordinator and read-only reviewers unchanged.
3. Update projection and resource validation consistently. Regenerate Engineer examples from their canonical owners.
4. Clarify missing capability versus denial, existing task authorization versus host approval, and worktree CLI selection versus active editor scope. Keep managed plans with the existing CLI writer.
5. Run affected tests, corpus validation, generated export and release checks. Review independently, then publish a reviewable PR update.
6. Native acceptance remains open: installed candidate in the actual VS Code host under Default/Manual Permissions; create a worktree, create/edit product files, make two plan updates and run a named check. Record tool, target path, active root and approval scope for each prompt. Do not label this passed using a different surface.

## Decision trail

- Prior trust tests did not test host Allow dialogs. Treating them as the same gate was the incorrect premise.
- Reuse existing agent declarations and shared permission guidance; create no new skill or agent. Existing user authorization covers these source fixes.
- Available delegates use the inherited model because the requested skill's Claude/Grok model families are unavailable in this environment. Independent reports are not cross-family evidence.

## Verification

- Failing-first capability suite: 36 cases, 31 passed and five expected failures before source changes. Failures covered the generated writer declaration, implementation role creation access, edit-group projection, authorized resource expansion and shared validation.
- After the fix and generation: the same 36 cases passed with zero skips or failures. A fresh reviewer independently reran this suite successfully.
- Broader prompt/host/setup/settings/MCP run: 191 cases, 188 passed, three platform skips, zero failures. Some files are also imported by the prompt contract suite; these are run totals, not a unique combined inventory.
- `resources validate --corpus --json` passed for 28 skills, 22 agents and five instructions. `check:engineer`, `check:release` and `git diff --check` passed.
- Fresh-context guidance exercise handled six cases: advertised creation without a named Create File tool; pending native approval; explicit write denial; an accessible nested worktree; an out-of-scope worktree without a handoff tool; and an external plan update needing host approval. Each response selected the permitted action, preserved denial and reused the plan. This is behavioral guidance evidence, not native VS Code execution.
- Independent correctness review found no concrete defects. No approval presets, writable roots or global autoapproval settings changed. No live user configuration or trust records were modified.

## Acceptance still open

The actual user's host, effective permission policy, active workspace, exact dialog and installed runtime are unknown. Current VS Code documentation calls the Copilot default Manual and the direct Codex preset Default Permissions. The edit-group declaration fixes Copilot/Local capability configuration; Codex inherits parent host permissions. Do not infer the host from the user's wording or claim this change fixes Codex writable roots.

Keep the native acceptance sequence above open. External plan updates may still need host approval under the existing storage design. Integrating MCP is deferred, not a completed fix for those prompts. The previous candidate and its CI results are historical evidence and do not qualify these changed package bytes.
