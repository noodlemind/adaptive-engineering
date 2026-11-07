# Getting started

This guide installs `ae`, connects it to your coding host, and runs a first task in one of your repositories. It takes about ten minutes.

## Before you start

- Node.js 20 or later, and Git.
- One supported host: Claude Code, Codex, Cursor, GitHub Copilot, or any terminal agent. See [Hosts](hosts.md).
- A repository with a test command you trust, for the first Deliver task.

## 1. Install `ae`

`ae` is distributed as the `ae-harness` npm package. It is not yet published to the npm registry, so install it from a clone:

```bash
git clone https://github.com/noodlemind/adaptive-engineering.git
cd adaptive-engineering
npm ci --prefix packages/ae
npm install -g ./packages/ae
ae --version
```

`npm install -g ./packages/ae` links the global `ae` command to this clone, and the host hooks run from it. Keep the clone where it is. To update, `git pull`, then refresh your host (step 5).

## 2. Connect your host

```bash
ae host list
ae host setup --host claude-code
ae host status --host claude-code
```

Replace `claude-code` with `codex`, `cursor` or `terminal`. For GitHub Copilot, see [Legacy GitHub Copilot setup](hosts.md#legacy-github-copilot-setup).

> **The hooks apply to every repository.** Setup installs hooks in your user-level host configuration. By default they deny edits that have no accepted plan, even in repositories where you have not run `ae init-repo`. While you are trying AE, start your host with `HARNESS_ENFORCEMENT=observe` to get advice instead of denials, or run `ae host remove --host <id>` when you finish. See [Hosts](hosts.md#hooks-apply-to-every-repository).

## 3. Prepare a repository

In the product repository you want to work on:

```bash
cd ~/code/your-project
ae init-repo
```

`init-repo` creates a private project configuration under `~/.ae/projects/<repo-id>/` and a `.harness/` runtime folder that Git ignores locally. Nothing new needs committing. To share policy and checks with your team instead, use `ae init-repo --shared`, which writes `.github/harness/` for review.

If the repository has no written spec yet, `ae prepare` adds starter files at `docs/specs/overview.md` and `docs/adr/0000-architecture.md`. Fill them in; the Engineer treats them as the intent a change must honor.

## 4. Run a first task

Open the repository in your host and start the Engineer. In Claude Code or Cursor, type `/engineer`; in Codex, mention `$engineer`; in Copilot Chat, select `@engineer`. With the terminal host, point your agent at `<AE_HOME>/terminal/skills/engineer/SKILL.md`. The examples below use `/engineer`.

Start with a read-only request to see how it works:

```text
/engineer Investigate how request errors are handled in this service.
```

Then ask for a change:

```text
/engineer Add validation for an empty email address on the signup form.
```

On the first Deliver task in a repository, expect these steps:

1. **Checks.** The Engineer reads your test setup and proposes named checks, such as `["npm", "test"]`. It writes them with `ae checks configure`; it never runs them yet.
2. **Your approval.** It shows you the exact commands and asks you to approve them. Review them, then run the printed command yourself in a terminal:

   ```bash
   ae trust approve
   ```

   Run this yourself; don't ask the Engineer to. On hosts with hooks, AE blocks the agent from running it, but the command itself does not check who runs it. Approval is bound to the exact check commands; if they change later, you review again.
3. **Plan.** The Engineer writes a plan with acceptance criteria mapped to checks. The Harness locks it.
4. **Worktree.** If you are on the default branch of your main checkout, the Engineer opens an isolated worktree with `ae worktree`.
5. **Work, review, verify.** It makes the change, collects the required code review, and runs `ae verify`. A failing check sends it back to work.
6. **Learn and report.** It records what the task taught, if anything, and reports the change with its evidence.

Later tasks in the same repository skip steps 1 and 2 unless the checks change.

## 5. Keep it current

```bash
cd adaptive-engineering
git pull
npm ci --prefix packages/ae
ae upgrade --host claude-code
```

## Remove AE

```bash
ae host remove --host claude-code
npm uninstall -g ae-harness
```

Removal keeps your plans, learnings and approvals in `~/.ae`. Delete that directory if you want them gone too.

## Next

- [Using AE](using-ae.md): what to ask for, and how to read what comes back.
- [How Adaptive Engineering works](adaptive-engineering.md): the model behind the loop.
- [Troubleshooting](using-ae.md#troubleshooting).
