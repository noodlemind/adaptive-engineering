# Context and recovery

How orientation builds bounded context, and who owns recovery after an interruption.

## Current and expandable context

Structural indexes bind working source bytes, tracked paths, resolver configuration, and extractor revisions. A dirty edit invalidates current reads. Orientation uses current lexical facts when the index is stale. Explicit new files contribute facts without indexing unrelated untracked files.

Orientation shares one fact collector across the pack and read response. Existing clients retain the current legacy read fields, including graph, intent discovery, verification and optional performance context. `ae orient --read --context-version 2` adds source identities, coverage limits, omissions, and accounting. Responses above 32 KiB return a read barrier with source pointers. A returned source reference refuses changed bytes. These records do not prove semantic completeness.

The optional headless runtime exposes experimental `legacy`, `selective`, and `subsystem` context policies. Selective evidence follows task seeds and import neighbors. Subsystem evidence adds files under seed directories. Each policy reports clipping and omissions. Structured retention reloads the existing plan and evidence after context changes. Both defaults remain legacy until task evaluation supports a change.

Reports separate produced-artifact estimates, runtime requests, and observed host usage. Missing host visibility remains unavailable. Model-task quality and installed-editor behavior require their own evidence.

## Recovery ownership

Compounding accepts an `in-progress` or `review` plan after current verification and required review pass. Learning precedes completion. Merging a branch, deleting its worktree or losing its local evidence does not require another implementation plan. Engineer inspects the explicit pushed target and accepted base, recreates a suitable isolated checkout, recovers current review/proof and completes the original plan. Different-parent backports keep separate plan and evidence contexts. A stale local main can remain in place. Finish learning and completion before removing worktrees; after a commit or merge, validate the final HEAD binding again.

Ignored shared authority is absent from a new worktree. Initialization must not turn that absence into competing repository-wide private policy. Inspect the primary source first. Exact matching or interrupted shared publication can use `init-repo --shared --dry-run` followed by the existing reconciler when shared publication is authorized. It retains a backup and grants no trust. Conflicting bytes or ambiguous destination intent require a specific decision, not moving files because one check matches.

Corrected verified episodes use a new publication operation. Existing sealed episodes retain their historical hashes; active consolidated claims use `SUPERSEDE`. Episode history remains separately indexed. The [post-merge procedure](../../packages/ae/corpus/skills/compound-learnings/references/post-merge-recovery.md) distinguishes these outcomes and preserves release-branch applicability.

The host's Engineer owns model choice, inference, context compaction, agent interruption, and optional agent subprocesses. A subprocess can read an accepted work contract and propose decisions through the CLI. Its reasoning and execution remain outside ae-harness. No subprocess result grants trust, accepts changed intent, or replaces named verification.

Harness owns deterministic state recovery. A structured plan operation records its accepted input and before/after state before publication. Retrying that same operation after an interrupted CLI process recovers the recorded result. Reusing its ID with a different payload fails. Dead update locks must meet the existing stale-lock conditions before recovery. A completed replay does not renew expired gates or evidence. These guarantees do not restart a host agent or reconstruct its private conversation.

Doctor and gate JSON include bounded recovery diagnostics keyed by the original checks. Actions are scoped command arguments or guidance, with automatic retry disabled. Installation, index, plan, intent, isolation, capability, and verification failures retain their existing authority. A changed locked source requires reviewed intent and an explicit amendment. A suggested orientation command only inspects that state.

A failed gate clears its accepted check binding. The hook permits standalone canonical inspection and amendment controls in that state while product edits and opaque execution remain blocked. A changed manifest with an accepted check binding still requires gate recovery.

The [native-host protocol](../../packages/ae/eval/host/README.md) keeps installed behavior, actual host delivery, and model comparisons separate.

## Recovery diagnostics

`doctor --json` and `gate --json` include `diagnostics` alongside their existing results. Schema 1 reports failed check IDs, blocking or advisory severity, evidence pointers, retry conditions, and proposed next actions. Command actions are argument arrays scoped to the selected workspace and homes. The CLI does not execute them. Inspect guidance before retrying a gate. Changed locked intent requires an explicit amendment.

The diagnostics field contains at most 20 failures and 16 KiB of JSON. `total` counts all failed checks and `omitted` counts excluded diagnostics. The original `checks` array remains available. Diagnostics do not change pass decisions, exit codes, trust, or mutation authority.

## Optional agent loop

The optional `ae agent` loop is an opt-in add-on for measured evaluations. It is not the product runtime; the host Engineer and the Harness are.

Context expansion is opt-in. `orient --read --context-version 2` returns source identities, coverage and expansion limits; the default read response keeps its current legacy shape. `get --path <path@sha256:hash> --context-version 2` refuses changed bytes. Knowledge references use `docid:<id>@sha256:<hash>` and expand through the same `get --path` command or the agent's `read` tool. Version 2 search cursors bind the query, filters and source generation. A sparse packet does not establish semantic completeness.

The optional agent loop accepts `--context-policy legacy|selective|subsystem` and repeatable `--file <path>`. Selective loads bounded seed neighborhoods; subsystem adds bounded source files from seed directories. Evidence refreshes before each model request. `--retention-policy structured` preserves task state and source references during loop compaction. Both defaults remain `legacy`. Native editor hosts control their own compaction; reorient and reload the plan after it occurs. See the context pilot in `eval/README.md` before changing defaults.

For the `github-copilot` provider, the signed-in VS Code editor is the only
transport. Harness never reads Copilot credentials, exchanges OAuth tokens, or
calls GitHub Copilot model/completion endpoints itself. The companion extension
uses `vscode.lm`, keeping authentication, proxy policy, and enterprise CA
handling inside VS Code.

An explicit `--model auto` selects VS Code's native Auto routing for GitHub Copilot. An omitted model keeps Harness default selection. Other providers interpret `auto` as their default model. Auto responses may identify only the routing alias, so resolved model identity remains unknown.

After installation or upgrade, reload the VS Code window and sign in to GitHub
Copilot Chat. The extension starts automatically, opens an authenticated
loopback bridge, and publishes its connection state under `~/.copilot/.harness/`.
Confirm that `ae model` reports `VS Code language model bridge`, then run:

```bash
ae model refresh github-copilot
```

If the bridge is not running, Harness stops with install/reload guidance. It
does not fall through to token-based HTTPS. A same-version legacy installation
whose lock predates the bridge is repaired automatically on the next TUI launch.
