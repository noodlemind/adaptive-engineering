# Project setup and trust

How `ae init-repo`, project configuration, trust approval and named checks work in a product repository. Start with [Getting started](../getting-started.md); this page holds the full contract.

## Initialize a repository

On an existing repository that has no spec or ADR yet, seed the workspace and the starter docs:

```bash
ae init-repo
ae prepare
```

`ae prepare` writes `docs/specs/overview.md` and `docs/adr/0000-architecture.md` when those paths are missing. Edit them. A later run leaves an existing file alone. Orient lists them as `intentSources`. Plan lock hashes them. If `docs/` is gitignored, prepare writes nothing and orient says to un-ignore those paths. Prepare does not rewrite a spec from the code.

Initialization defaults to personal configuration under
`~/.ae/projects/<repo-id>/authority/`, with no new product configuration to
commit. Existing shared `.github/harness/` authority remains selected.
`ae init-repo --shared` explicitly publishes shared configuration and returns
the exact commit inventory. Review that inventory within its accepted setup
scope. A bounded check repair may accompany the authorized product task as
described below; it needs no separate setup plan or commit. Approval is always user-local; cloning team policy does
not clone a person's execution decision.

The state home must stay outside the product checkout. An in-repository
`--ae-home`, including a redirected alias or one above a selected subfolder,
is refused before initialization writes; choose an external directory instead.

Policy, checks, routing, configuration, hooks and evidence resolve one selected
source. They do not overlay competing local/shared files or fall back from an
unsafe source. Changing source identity or accepted bytes invalidates approval
and proof. `ae trust status` names the pinned files.

Runtime `.harness/` state and `.worktrees/` use narrowly scoped Git-local
excludes; routine setup does not edit the root `.gitignore`. Already-tracked
runtime artifacts remain visible until explicitly migrated. Initialization
refreshes a private codebase map rather than rewriting a shared authored map.
The generated runner is checked by content and ownership, so stale generated
install guidance is refreshed while custom and newer runners are preserved.

New `init-repo` policy stubs use `enforce`; existing authored policies remain unchanged. Initialization does not guess behavioral commands. Engineer inspects the product's tests and prepares any missing declarations through `ae checks configure --file - --json`. That bounded writer can run before an implement gate and changes only the selected check configuration; it never runs commands or grants trust. A person reviews the resulting command arrays and pinned policy files before approving changed execution authority. Engineer then resumes the accepted task without repeating intake or requesting the same approval again. Installing AE or passing doctor does not grant that approval or prove a task. Unreadable, redirected, nonregular or oversized pinned sources cannot establish current trust.


## Existing workspaces and verification readiness

Upgrade preserves authored project checks and policy. A CLI upgrade alone does not require renewed project approval. Its `checkReadiness` result and orientation distinguish usable checks from missing, empty, invalid, or unusable configuration, independently of the trust result. `trusted: true` with no checks means the current configuration is approved, while delivery still needs a meaningful proof command.

Upgrade reports installation separately from the selected `workspace`
observation. Worktree creation and reuse return the same observation for the
destination checkout. It includes the current authority, check readiness,
trust diagnosis, runner status, and next actions. `prerequisites-ready` describes
configured checks and current approval. It does not certify task-specific check
adequacy or product behavior. A blocked workspace can accompany a completed
package installation.

The trust diagnosis carries its workspace, selected authority home, and exact
approval store. Recovery names the Engineer or the person who owns the next
action. Invalid stores and unavailable or mismatched policy require inspection
before approval. A stale direct worktree grant can yield to an independently
current primary grant when the recorded worktree belongs to the same repository
and contains exactly the approved policy. Direct revocation remains decisive.
Read-only status and recovery inspection belong to the Engineer.

Ignored shared policy is not carried into a worktree. Initialization refuses to create competing private authority when that primary policy is absent from the linked checkout. Matching interrupted shared publication can be inspected with `ae init-repo --shared --dry-run` and recovered through the existing reconciler when shared publication is authorized. All supported policy sources matter; one matching check does not resolve a conflict. An unapplied shared-promotion preview reports readiness as `deferred`. Apply the reviewed promotion before inspecting delivery prerequisites.

VS Code Default/Manual Permissions is a supported setup. AE trust accepts the
repository's execution policy; it does not approve editor tools or terminal
commands. Installation and upgrade preserve host approval settings. Selecting
a worktree with `--workspace` changes the CLI target, not the editor's active
workspace. A nested `.worktrees` directory can already be inside the open
folder. When a target is outside the host's permitted scope, resume the same
plan after opening that checkout through the host's supported workspace flow.
Managed plans remain in the external AE store and can require host approval
for CLI writes. Repeated Allow dialogs need the actual tool, target path or
command, active workspace and approval scope to diagnose. Full Permissions is
not a prerequisite, and passing AE trust checks does not prove this editor
workflow.

Engineer owns recovery rather than asking the person to write YAML. It inspects the existing test setup and relevant assertions, reads the selected path and `sourceDigest` from `ae checks list --json`, and submits concrete upserts through `ae checks configure --file - --json`. The schema 1 decision contains `expectedDigest`, `checks`, and `rationale`. The writer preserves unrelated checks and refuses concurrent changes. A no-op preserves existing approval. Changed commands are presented for a necessary person approval before execution. The accepted task plan may include the exact prepared shared check source alongside its product files, reviewing both together without a separate setup plan or unguarded commit. Private configuration stays outside product scope. The [named-check procedure](../../packages/ae/corpus/skills/create-primitive/references/named-checks.md) supplies the decision shape and recovery details.

Use the same workspace and AE home throughout the task. A subfolder that would hide an enclosing repository's shared configuration is reported with a concrete root retry; AE does not silently adopt a different execution root. Resolve that selection before creating new checks.

Recording review and executing verification are separate operations. Missing executable checks do not prevent `ae review prepare` or `ae review assemble`. `ae verify` can report diagnostics, but cannot pass delivery without required behavioral proof. Settle configuration and approval before the final review, since changes to policy or trust stale earlier review packets. After that one authority decision, Engineer continues plan start, implementation, review, verification, learning, and completion within the accepted scope.

Then select the generated Engineer entry in the configured host. In Copilot Chat, select `@engineer`.

`ae doctor` inspects the legacy Copilot installation. For Claude Code, Codex, Cursor and terminal setups, use `ae host status --host <id>` instead. Use `ae doctor --target vscode`, `--target cli`, or `--target intellij` to inspect one installed Copilot surface and its selected home. Doctor separates customization files, mechanical hook checks and live-host evidence. CLI checks do not require VS Code settings. IntelliJ customization can be healthy while native lifecycle hooks are unavailable; installed agents and instructions do not establish enforced mutation denial there. A mechanical probe is not an observed editor/model trial.

Doctor's proposed installation repairs preserve its selected target and home. Read command-specific outcomes and structured errors: exit 2 can be a usage refusal or an advisory, and supplies no successful mutation/completion authority by itself.

Every checkout uses one canonical repository ID. A checkout with an origin remote uses that normalized remote. A checkout without one uses the native path of the main worktree, so a subdirectory, a linked worktree, a symlink, and a different path casing share that id. `ae knowledge migrate-store` copies missing knowledge and project files from other ids of the same checkout into that id. The JSON result lists `stableId`, `repo`, and `merges`. Source directories stay in place, a second run reports `unchanged`, and `--dry-run` writes nothing. `--from-id` still binds one existing store in place. That binding preserves knowledge, plans, and their absolute references. It refuses an occupied destination, unsafe paths, and replacement of an existing binding. The CLI and installed hooks share the project-layout resolver. When an origin remote replaces a path-keyed id, the same command copies missing learning files into the current store and leaves the source untouched.

## Versions and CI

Check `ae --version` on each machine. The global runner does not read
`.harness-version` or enforce a repository dependency pin. Install the chosen
checkout or qualified archive deliberately; arbitrary version compatibility is
not implied.

The supplied manual workflow template provides plan diagnostics using an
explicit checksum-pinned archive and committed plan. It does not transfer local
approvals, run product checks, or establish delivery completion. Private plans
are unavailable on fresh CI until deliberately shared.
