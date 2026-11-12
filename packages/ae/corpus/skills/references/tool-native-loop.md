# Tool-native integration

The task-mode boundary and normative delivery lifecycle are in `engineer.agent.md`; this reference only maps Deliver mode to deterministic tools.

- `ae orient --query "<task>" --workspace . --json` writes the bounded context pack.
- When `intentSources` is empty, run `ae prepare` and have the person supply missing intent in `docs/specs/overview.md` and `docs/adr/0000-architecture.md`, then orient again. Any agent-authored starter edits still require a scoped Deliver plan and gate; accept changed selected bytes through an explicit source amendment.
- `ae worktree --slug <slug> --workspace . --json` creates `.worktrees/<slug>` on `harness/<slug>` when orient `worktree.blocked` is true.
- `ae gate --phase implement --plan <path> --workspace . --json` checks edit preconditions, including `C-intent-sources` and `C-worktree`.
- Focused test commands run the implementation TDD loop; they do not replace required review or delivery proof.
- The Engineer prepares review, dispatches required judgments, and collects them with `ae review assemble` before authoritative verification. The coordinator returns raw results without CLI execution.
- `ae verify --plan <path> --workspace . --json` runs trusted named checks, scope validation, and evidence capture.
- Piping the decision to `ae compound --plan <path> --learning-decision - --workspace . --json` records durable learning or explicit no-learning against current passed proof.
- Pipe the revision-bound complete decision to `ae plan-update --plan <path> --workspace . --file - --json`. Required review, current proof, completed tasks, and completed learning must agree before Stop permits delivery completion. List files with the host search or list tool. Search file text with the host search tool. Do not run rg, grep, find, or any program other than `node` and `git`. Outside the enforce hook, `ae tree workspace --files --json` and `ae search <query> --match literal --source code --json` are optional.

After orient, read every `intentSources` path. If a source is ambiguous, set `needs-info` and write `## Missing`. Do not implement a guessed requirement.

Use `execute` to run commands; `terminalLastCommand` only reads output. Users interact with agents and skills, not the CLI. In standalone or degraded mode, report missing governance explicitly; an unavailable required check produces `inconclusive`, never success.

Session state and evidence are ephemeral under `.harness/`. Durable goal, scope, decisions, and activity stay in the explicit plan. Full command and exit semantics: `harness-tool-contract.md`.

## Host permissions and worktrees

Support Default/Manual Permissions. Use advertised native creation and edit tools for product files. A tool declaration, AE trust approval, and the host's permission to write are separate.

- Missing capability: use an advertised equivalent only if the host permits the same scoped action. Report the affected operation if none exists.
- Pending host approval: let the native dialog carry the request. Do not ask for a second prose approval of already authorized work.
- Explicit denial: stop the affected action. Do not switch to terminal or another tool to evade it.

`ae worktree` and `--workspace` select the CLI checkout. They do not open that checkout in the editor or change writable roots. Check the actual target path against the active host workspace when access fails. A nested `.worktrees` directory can already be inside the open folder. Its name or Git-ignore status does not establish an access failure. If the target is outside the active scope, use the host's supported workspace handoff and resume the existing plan there. If no handoff tool is available, report the exact checkout to open once before resuming. Do not recreate the plan or request approval for each file.

Managed plans stay with `ae plan-new` and `ae plan-update`, including when their store is outside the workspace. Terminal or external-state approval can still be required by the host. Use a configured workspace-bound AE tool only when it is advertised and bound to this checkout. A server bound to the primary checkout does not follow a new worktree automatically. Never edit managed state directly or move it into the checkout to avoid approval.

When prompts repeat, record the actual host/tool, target path or command, active workspace and approval scope. Distinguish these prompts from `ae trust` before proposing a repair. Do not require Full Permissions, alter approval settings or widen writable roots. Installation and upgrade refresh AE-owned assets; they cannot silently grant host permission.
