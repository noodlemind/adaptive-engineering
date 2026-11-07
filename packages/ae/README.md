# ae — Adaptive Engineering CLI

`ae` is the Harness in [Adaptive Engineering](../../README.md). It configures a coding host from the shared corpus and runs the deterministic kernel the Engineer works through: orient, gate, verify and compound. It never calls a model on the host path.

- Package: **`ae-harness`** · command: **`ae`** · Node.js 20 or later
- Guides: [Getting started](../../docs/getting-started.md) · [Using AE](../../docs/using-ae.md) · [Hosts](../../docs/hosts.md)
- Concepts: [How Adaptive Engineering works](../../docs/adaptive-engineering.md)
- Agent contract: [harness-tool-contract.md](corpus/skills/references/harness-tool-contract.md)

## Install

`ae-harness` is not yet published to the npm registry. From the repository root:

```bash
npm install -g ./packages/ae
```

That links the `ae` command to this checkout. Then connect a host:

```bash
ae host list
ae host setup --host claude-code
ae host status --host claude-code
```

Choose `claude-code`, `codex`, `cursor` or `terminal`. `copilot-vscode`, `copilot-cli` and `copilot-intellij` run the legacy Copilot installer, which `ae install` also provides. After updating the package, run `ae upgrade --host <id>` with the same root overrides you used for setup. See [Hosts](../../docs/hosts.md) for capabilities, the global-hooks caveat and removal.

## Commands

Run `ae help <command>` for usage and options. Every command accepts `--json`, `--dry-run`, `--workspace`, `--ae-home` and `--no-color`.

### Setup

| Command | Purpose |
| --- | --- |
| `host list` / `setup` / `status` / `remove` | Select a host, merge owned files and hooks, inspect drift, or remove unchanged owned files |
| `host export` | Write a portable Agent Plugins package bound to one Git workspace |
| `mcp serve` | Serve twelve fixed AE operations over workspace-bound local stdio |
| `upgrade --host <id>` | Refresh an existing host integration from the current package |
| `install` / `upgrade` / `doctor` / `status` / `uninstall` | Legacy Copilot installation, its health checks and removal |
| `init-repo` | Private project setup; `--shared` writes reviewable team policy and checks |
| `prepare` | Starter `docs/specs/overview.md` and `docs/adr/0000-architecture.md` when missing |
| `migrate` | Move older plans, solutions and state homes into the current layout |
| `trust status` / `approve` / `revoke` | Review and approve the project's policy and checks |
| `checks list` / `show` / `configure` / `run` | Inspect, configure or run named checks |
| `resources` | List, validate or create personal skills in a selected host |
| `inventory` | Optional local snapshot of installed editors and extensions |

`ae doctor` and `ae status` describe the legacy Copilot installation. On Claude Code, Codex, Cursor and terminal, use `ae host status`. Per-role models are a user rule written by the `setup-models` skill; see [model preferences](../../docs/reference/model-preferences.md).

### Deliver path

| Command | Purpose |
| --- | --- |
| `orient` | Context pack and recall; `--read` returns the work contract |
| `plan-new` / `plan-update` | Create or amend a plan from an authored decision file |
| `gate` | Lock the plan and grant the implement gate |
| `worktree --slug <name>` | Open a linked worktree for issue work |
| `review prepare` / `review assemble` | Capture the change for review and collect results |
| `verify` | Run named checks and record evidence |
| `compound` | Record a learning or no-learning decision after a passed verify; `--insight` captures investigation notes |
| `report` | `--growth` knowledge scoreboard, `--facts` source-bound inventory |
| `recall` / `get` / `search` / `lookup` / `tree` | Retrieval |
| `graph deps` / `dependents` / `path` / `explain` / `impact` | Bounded structural evidence; see [structural knowledge](../../docs/reference/structural-knowledge.md) |
| `flows` / `diagrams` | Descriptive flow models and local diagrams; see [flows](../../docs/reference/flows.md) |
| `domain` | Delivery across several repositories; see [domains](../../docs/reference/domains.md) |
| `performance analyze` | Journey-based performance reports; see [performance](../../docs/reference/performance.md) |
| `experiment` | Bounded, budgeted experiments; see [experiments](../../docs/reference/experiments.md) |
| `edit` / `write` / `apply` / `undo` | Governed mutations (`undo` is operator-only) |
| `exec` / `bash` | Governed process and shell execution |
| `todo` | Durable playbook worklist |
| `validate-plan` / `index` / `events` / `run` | Plan validation, indexes, event ledger, prior runs |

The full plan, review and evidence contract is in [Plans, gates and proof](../../docs/reference/plans-and-proof.md).

### Knowledge

Learnings live in a local, never-pushed store at `~/.ae/knowledge/<repo-id>/`. Only `consolidate --apply` writes learning content.

| Command | Purpose |
| --- | --- |
| `knowledge` | Mode `on` / `suggest` / `off`, purge, `migrate-store`, optional `commit repo` mirror |
| `consolidate` | `--status` · `--candidates` · `--apply --ops` · `--rebuild` |
| `remember` / `learning` / `learnings` | Teach · retire, dispute, confirm or promote · list |
| `eval-knowledge` | Deterministic retrieval proxy, not a model-graded benefit |

Trust gradient: episodes stay private, learnings stay local, and shared behavior changes only through a reviewed pull request, unless a team opts in with `knowledge commit repo`.

### Session Ledger (`tui`)

`ae tui` opens a terminal view of the same registry. It is a projection of the kernel, not a second Engineer.

```text
/ palette   ! shell   ? help   shift+tab  commands→assist→plan
tree · learnings · walkthrough · agent on|off · config set · gate menu · runs
```

### Optional agent (opt-in add-on)

```bash
ae config set agent.enabled true --scope user   # default off
ae agent "task" --profile autonomous --verify-cmd "node ./v.mjs"
ae agent "task" --dry-run --json
```

Profiles: `autonomous` (default), `deliver` and `benchmark`. The unattended loop exists for measured evaluations. It is not the Adaptive Engineering product runtime; the host Engineer and the kernel are. The `deliver` profile uses the same hooks and completion proof as the host path. See [eval/README.md](eval/README.md) and [context and recovery](../../docs/reference/context.md#optional-agent-loop).

## Output and exits

Human output uses ledger rows (`✓` / `!` / `✗`, ASCII under `NO_COLOR`). `--json` output is unstyled.

| Exit | Meaning |
| --- | --- |
| 0 | ok |
| 1 | command failure |
| 2 | usage, or a command-specific advisory |
| 3 | not initialized |
| 4 | needs approval |
| 5 | sync conflict |
| 6 | doctor failed |
| 7 | network |
| 130 | interrupted |

Gate and verify keep their policy-driven exits. A nonzero exit never grants mutation or completion authority.

## CI plan diagnostics

The supplied manual workflow template `.github/workflow-templates/harness-plan-verification.yml` runs plan diagnostics with an explicit checksum-pinned archive and a committed plan. It does not transfer local approvals, run product checks or establish delivery completion. Private plans are unavailable on a fresh CI runner until a team deliberately shares them.

## Validate and pack

From `packages/ae/`:

```bash
npm ci
npm run prepack
npm pack
```

`prepack` runs `check:release`, which checks package and bridge versions, CLI entry points, bundled dependencies, corpus assets and prompt budgets using package-local files. An offline-installed archive can run the same validator and be repacked without the parent repository. `npm run check:repo` runs the repository contract tests and needs a full checkout.

## Maintainers

```bash
cd packages/ae
npm test
npm version patch --no-git-tag-version
npm pack
```

`package.json` is the release authority. `npm version` updates it and both root version fields in `package-lock.json` together. Use a patch for compatible fixes and prompt maintenance, a minor for new compatible behavior, and a major for incompatible contracts. `check:release` runs before and after `npm version` and before `npm pack` or `npm publish`.

The bundled VS Code bridge has its own version in `vscode-extension/package.json`. Increment it when bridge behavior or metadata changes. Agent and skill files ship under the CLI version.

```text
bin/ae.mjs   lib/   test/   eval/   corpus/   config/
```

Runtime libraries are `yaml`, Pele and D2/WASM. Pinned Tree-sitter grammars ship inside the package, so no native parser build or runtime download is needed. Diagram rendering uses bundled assets only. See [third-party notices](THIRD-PARTY-NOTICES.md).
