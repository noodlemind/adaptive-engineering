# Using AE

You work with AE by talking to the Engineer in your host. The `ae` command is mostly for the Engineer; you use it to set things up, approve checks and look at what was recorded.

## Ask for an outcome

Describe what you want, not the steps. The Engineer picks the mode and says which one it chose.

| You want | Ask like this | Mode |
| --- | --- | --- |
| A quick answer | "What does `retryPolicy` default to?" | Answer |
| To understand a system or a bug | "Investigate why checkout times out under load." | Investigate |
| A change | "Make the importer skip blank rows, with a test." | Deliver |
| A second opinion | "Review the diff on this branch for security issues." | Review |

Answer and Investigate never edit files. If an investigation finds something worth fixing, the Engineer offers to plan the fix, capture it for later, or leave it in the chat.

## What a Deliver task gives you

At the end of a Deliver task the Engineer reports:

- **What changed**, and which acceptance criteria it meets.
- **Evidence**: the named checks that ran on the final code and their result.
- **Review**: which reviewers assessed the change and how each finding was handled.
- **Learning**: what was recorded for next time, or that nothing was.

If verification fails, the task is not done. The Engineer goes back to work or tells you what blocks it. It cannot report success without current proof; the Harness rejects completion, and on Claude Code and Codex the Stop hook holds the session open.

## Good habits

- **Write down intent.** Specs in `docs/specs/` and decisions in `docs/adr/` become the intent a plan must honor. A locked spec that changes invalidates the gate until someone accepts the new text.
- **Keep checks meaningful.** Trust is only as good as the commands you approve. Prefer the test command your CI runs.
- **Let the plan be the memory.** Plans live in `~/.ae/projects/<repo-id>/plans/` and carry context, research notes and progress between sessions. Ask the Engineer to resume a plan by name.
- **Teach it directly.** `ae remember "<claim>" --trigger "<when it applies>"` records something you know, such as "integration tests need the local queue running". It surfaces in later tasks.
- **Correct it.** `ae learnings` lists what AE has learned for this repository. `ae learning` lets you confirm, dispute, retire or promote an entry.

## Commands you will use

| Command | When |
| --- | --- |
| `ae host status --host <id>` | Check the host integration |
| `ae init-repo` | Once per repository |
| `ae checks list` | See the named checks and where they are configured |
| `ae trust status` / `ae trust approve` | Review and approve the project's checks and policy |
| `ae worktree --slug <name>` | Open an isolated worktree for a task |
| `ae learnings` | Browse what AE has learned here |
| `ae remember` | Teach a durable fact |
| `ae report --growth` | See how knowledge has grown, from the local event log |
| `ae tui` | Open the session ledger, a terminal view of the same commands |
| `ae help <command>` | Usage and options for any command |

Most commands accept `--json` for scripts and `--dry-run` to show what it would change; `ae help <command>` lists the options each one supports. The full list is in the [CLI reference](../packages/ae/README.md).

## Working with a team

By default each person's AE configuration is private. To share it:

1. One person runs `ae init-repo --shared`. That writes `.github/harness/` with the policy, checks and routing for review and commit.
2. Each teammate installs `ae`, sets up their own host, and runs `ae trust approve` after reviewing the committed checks. Approval never travels with the repository.
3. Teams can add review criteria for their product in `.github/checks/*.md`; the code-review skill applies them alongside its bundled checks.

Learnings stay on each machine unless the team deliberately opts in with `ae knowledge commit repo`.

## Troubleshooting

**An edit is denied with `missing-implement-gate`.** The hook found no accepted plan and gate for this repository. In Deliver mode the Engineer handles this itself. If you see it in a repository where you did not mean to use AE, start the host with `HARNESS_ENFORCEMENT=observe`, or remove the integration. See [Hosts](hosts.md#hooks-apply-to-every-repository).

**Trust is `untrusted`.** No one has approved this project's checks on this machine, or the checks changed since approval. Run `ae trust status` to see the pinned files, review them, then run `ae trust approve`.

**Verify reports no checks.** The project has no named checks yet. Ask the Engineer to configure them; it proposes commands for you to approve.

**`ae doctor` or `ae status` reports errors after a correct setup.** Those commands describe the legacy Copilot installation. On Claude Code, Codex, Cursor or terminal, use `ae host status --host <id>`.

**Codex does not run the hooks.** Codex asks you to review new hooks. Open `/hooks` in Codex and trust the AE hooks.

**Hooks fail after you moved or deleted the clone.** The global `ae` command and the hooks point into your clone. Clone again, run `npm install -g ./packages/ae`, then `ae upgrade --host <id>`.

**The wrong repository ID.** After you add or rename a Git remote, the repository ID changes. `ae knowledge migrate-store --dry-run` shows what it would copy from the old ID; run it again without `--dry-run` to merge. See [Project setup and trust](reference/project-setup.md).
