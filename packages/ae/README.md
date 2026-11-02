# Adaptive Engineering CLI

CLI for the **Adaptive Engineer Harness**: configure a selected host from a shared corpus, run the deterministic kernel (orient → gate → verify → compound), optional TUI, and opt-in headless agent.

- Package name: **`ae-harness`** · command: **`ae`**
- Explanation: [docs/adaptive-engineering.md](../../docs/adaptive-engineering.md)
- Tool contract: [harness-tool-contract.md](corpus/skills/references/harness-tool-contract.md)

Choose the generated Engineer entry in the configured host; Copilot uses **`@engineer`**. The kernel never starts an LLM on the host path.

AE's native formal-evidence compiler is informed by [Lauren Tan's pstack `/statechart`
v0.15.36](https://github.com/cursor/plugins/tree/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe/pstack/skills/statechart).
Lauren's checking/evidence/projection boundaries and counterexample presentation inform
`ae diagrams formal --file <formal-verification.json> --model <Module.tla>`.
This draws retained counterexamples or positive explored graphs through bundled
rendering, with no Java, JAR, checker invocation, or runtime download. The optional
formal-check starter's `--capture-graph` retains same-run graph evidence using
only a checker deliberately configured by its caller. Keep the receipt beside
its referenced `Module.graph.dot` when copying a retained artifact bundle.
AE ships no pstack implementation. See [third-party notices](THIRD-PARTY-NOTICES.md).

## Install

`ae-harness` is not published to the npm registry. From the repository root:

```bash
npm install -g ./packages/ae
```

That installs the `ae` command from this checkout. Select a host explicitly:

```bash
ae host list
ae host setup --host claude-code
ae host status --host claude-code
```

Choose `claude-code`, `codex`, `cursor` or `terminal`. `copilot-vscode`,
`copilot-cli` and `copilot-intellij` delegate to the existing Copilot installer;
legacy `vscode`, `cli` and `intellij` aliases remain accepted by host setup.
The old `ae install`/`upgrade` paths retain backward compatibility. A fresh
`ae tui` does not install VS Code automatically; it can maintain a previously
selected legacy installation.

The npm package includes `corpus/`. Runtime setup projects its skills, specialist
roles and applicable instructions for the selected host and merges AE-owned
native hook groups while preserving unrelated user configuration. No setup
command grants project trust or proves live host activation.

Knowledge indexes bind their actual corpus and retain project-private metadata
beside each project's postings. Global notes remain shared. Older unbound private
rows are omitted with rebuild guidance until `ae index` runs in that repository;
another project's private rows are never a fallback corpus.

### Host homes, status and removal

| Host | Configuration root | Skills root | Declared limitation |
| --- | --- | --- | --- |
| Claude Code | `~/.claude` | `~/.claude/skills` | Engineer main-agent delegation differs from Claude subagent mode. |
| Codex | `~/.codex` | `~/.agents/skills` | Review/trust hooks with `/hooks`; role prose does not isolate parent permissions. |
| Cursor | `~/.cursor` | `~/.cursor/skills` | Stop follow-up is advisory, with a loop limit. |
| Terminal | `<AE_HOME>/terminal` | `<AE_HOME>/terminal/skills` | Manual CLI use; no native hooks or isolated agents. |

Override roots with `--config-home`, `--skills-home` and `--ae-home`; repeat the
same overrides for status/removal. `AE_SKILLS_HOME` separates native skill reads
from the configuration root, including Codex's independent skills directory.

```bash
ae host setup --host codex --dry-run --json
ae host status --host codex --json
ae host remove --host codex --dry-run --json
```

Setup records owned assets and preserves unowned or modified files on conflict.
Removal deletes unchanged AE-owned assets and hook groups while preserving user
changes and unrelated configuration. Neither operation deletes project state.
Use `--dry-run` before publication/removal; it reports actions without writes.

Setup reports declared capabilities separately from
`nativeQualification: unverified`. Native pre/post-tool and completion bridges
reuse existing kernel checks; unknown tool effects are refused. Configured
hooks, successful fixtures and a healthy status do not prove native editor
activation, actual mutation denial or a model-driven delivery. Cursor's stop
follow-up is not hard completion blocking. No command automatically approves
host hook trust or project check trust.

### Personal resources in a selected native host

After host setup, create a personal skill through the validated schema 1 writer:

```bash
ae resources create skill my-skill --file - --copilot-home <config> --skills-home <skills> --json
ae resources list --copilot-home <config> --skills-home <skills> --json
ae resources show my-skill --copilot-home <config> --skills-home <skills> --json
ae resources validate --copilot-home <config> --skills-home <skills> --json
```

The first command reads a JSON decision on stdin: `schema: 1`, `text` containing
the complete valid `SKILL.md`, and optional `expectedDigest` for replacement.
It requires the saved host setup binding, refuses replacement of shipped
setup-managed skills, and requires the observed digest before changing an
existing personal skill. Personal skills remain user-owned and survive host
removal. Discovery and validation inspect the selected native roots; managed
role/rule byte checks remain separate from native invocation proof.

Native personal agents/instructions are not yet mapped writers
(`personalRoleCreation: false`). Their creation and legacy bundle/primitive
mutators are explicitly refused for a selected native host; use a capability
proposal instead of falling back to Copilot metadata. This limit does not
prevent setup from projecting AE's existing shipped roles and instructions.

### Engineer source and generated examples

Engineer behavior is authored once in
[the shared contract](corpus/skills/engineer/references/contract.md), activated
by the Engineer skill. `corpus/hosts/engineer-adapters.json` supplies metadata for
the two committed Copilot/Claude examples. Runtime setup uses
`lib/hosts/projection.mjs` to project the complete current corpus and selected
roots; the committed examples remain inspectable source projections.

After editing an example source, run from this package:

```bash
npm run generate:engineer
npm run check:engineer
```

The equivalent direct script uses `node scripts/generate-engineer.mjs --write`
or `--check`. Release validation rejects stale generated examples. Do not edit
generated bodies independently of the canonical behavior.

### Local MCP tools and portable package

```bash
ae mcp serve --workspace <repo> --copilot-home <config> --skills-home <skills>
ae host export --output-directory <new-directory> --workspace <repo>
```

The MCP command serves ten fixed AE tools over local stdio. Calls reuse the
existing CLI authority, startup workspace and selected roots; there is no new
LLM loop, network listener or unrestricted command broker. Supported negotiated
compatibility versions are `2025-11-25`, `2025-03-26` and `2024-11-05`; this is
not a claim of 2026 MCP support. Existing trust and proof requirements still
apply, and required native skill activation cannot be replaced by a reference
retrieval. Unrelated host tools remain outside MCP mediation.

Portable export writes an Agent Plugins 1.0 package into a new directory. It
contains skills, specialist judgment criteria and explicit-workspace MCP
configuration. A compatible installed `ae` CLI and Node.js >=20 remain required.
The package supplies no native hooks, native agent registration, credentials or
trust. Criteria files do not establish isolated/independent review provenance.
Export again when selecting a different existing Git workspace.

The [implementation and qualification plan](../../.audit/ae-host-portability-plan-2026-10-30.md)
records software mechanics, migration boundaries and the remaining native
runtime/model/OS qualification. Automated disposable fixtures do not configure
the user's real hosts or approve trust.

### Validate and pack

From `packages/ae/` in a checkout, or from a standalone copy of that package:

```bash
npm ci
npm run prepack
npm pack
```

`prepack` runs the shipped `check:release` validator. It checks package and bridge versions, CLI entry points, bundled dependencies, corpus assets, and prompt budgets using package-local files. When a source lockfile exists, it also checks the manifest and installed dependencies against that lockfile. An offline-installed archive can run the same validator and be repacked without a global `ae` command, editor customizations, or the parent repository.

`npm run check:repo` retains the repository contract tests and requires a full checkout. Source CI runs both checks and packs with lifecycle scripts enabled. Packaging does not require repository-only `.cursor/`, `.github/`, documentation, or test files.

```bash
ae init-repo    # private checks and policy; no product configuration diff
ae init-repo --shared  # explicit team configuration to review and commit
ae prepare      # starter docs/specs/overview.md and docs/adr/0000-architecture.md
ae migrate      # move gitignored docs/plans and docs/solutions out of the product tree
```

### Project setup and selected version

Personal configuration lives in `~/.ae/projects/<repo-id>/authority/`. Existing
`.github/harness/` configuration remains selected. `ae init-repo --shared`
publishes shared project configuration; commit the returned inventory as a
reviewed setup change before product work. A teammate installs their own AE
runtime and reviews the commands with their own local approval.

Keep `--ae-home` outside the product checkout. Setup refuses an in-repository
state home before creating artifacts; it does not silently hide that directory.

`.harness/` contains private runtime artifacts, including its regenerated runner.
Git-local excludes keep untracked runtime files out of product changes without
rewriting the root `.gitignore`. Already-tracked artifacts remain tracked until
the team explicitly migrates them.

Check `ae --version` on each machine. The global runner does not read
`.harness-version` or enforce a repository dependency pin. Install the chosen
checkout or qualified archive deliberately; arbitrary version compatibility is
not implied.

The supplied manual workflow template provides plan diagnostics using an
explicit checksum-pinned archive and committed plan. It does not transfer local
approvals, run product checks, or establish delivery completion. Private plans
are unavailable on fresh CI until deliberately shared.

## Dual tracks

| Track | When | How |
|-------|------|-----|
| **Deliver** | Real product work | `@engineer` + `gate` / `verify` / `compound` / `report --growth` |
| **Autonomous** | Evals / unattended | `ae agent --profile autonomous --verify-cmd "…"` |

Same registry tools; autonomous does **not** require plans or compound. It is an opt-in add-on for a measured eval. See [eval/README.md](./eval/README.md).

The optional `ae agent --profile deliver` loop enforces explicit orientation with touched files, the host mutation hooks and current bound completion proof. Its `harness` tool runs lifecycle commands and stages authored decisions without editing product files. A final model message without completed review, passed verification, a learning decision and plan completion exits with `delivery-incomplete`. The agent can read trust status; approval remains a person action. These controls share the host's command analysis and do not provide operating-system confinement.

## Commands (summary)

### Setup

| Command | Purpose |
|---------|---------|
| `host list/setup/status/remove` | Select one integration, merge owned assets/hooks, inspect configured state, or remove unchanged owned assets |
| `host export` | Write a portable Agent Plugins package bound to an explicit Git workspace |
| `mcp serve` | Serve ten fixed AE operations over workspace-bound local stdio |
| `install` / `upgrade` | Hydrate `~/.copilot/` and install the VS Code bridge; upgrade retires lock paths |
| `doctor` | Health; `--host vscode` runs hook probes |
| `inventory show` / `inventory refresh --editor <family>` | Optional sourced local IDE snapshot in the selected Harness home |
| `domain show --name <name>` | Read-only local membership and identity drift from an existing domain configuration |
| `status` / `uninstall` | Version/lock; remove tracked files only |
| `init-repo` | Private project setup; `--shared` publishes reviewable team policy and checks |
| `prepare` | Starter spec and ADR when those paths are missing; skips files that already exist |
| `migrate` | Move gitignored `docs/plans` and `docs/solutions` to `.harness/plans` and `~/.ae/projects/<repo-id>/` |

Per-role models are a user rule, not an install stamp. Ask `@engineer` to load `setup-models`. It writes `~/.cursor/rules/ae-models.mdc` on Cursor, or `~/.claude/rules/ae-models.md` on Claude Code. A missing line or `inherit` omits the spawn model. Copilot subagents inherit the session model; set `model` in an agent file by hand. Codex profiles are also set by hand (`model` and `model_reasoning_effort`). `ae` does not call a model. See [model preferences](../../docs/model-preferences.md).

`doctor --json` and `gate --json` include `diagnostics` alongside their existing results. Schema 1 reports failed check IDs, blocking or advisory severity, evidence pointers, retry conditions, and proposed next actions. Command actions are argument arrays scoped to the selected workspace and homes. The CLI does not execute them. Inspect guidance before retrying a gate. Changed locked intent requires an explicit amendment.

The diagnostics field contains at most 20 failures and 16 KiB of JSON. `total` counts all failed checks and `omitted` counts excluded diagnostics. The original `checks` array remains available. Diagnostics do not change pass decisions, exit codes, trust, or mutation authority.

### Session Ledger (`tui`)

Projection of the kernel — not a second Engineer.

```text
/ palette   ! shell   ? help   shift+tab  commands→assist→plan
tree · learnings · walkthrough · agent on|off · config set · gate menu · runs
initialize this repo (`init-repo`) from the palette
```

### Deliver path (`@engineer`)

| Command | Purpose |
|---------|---------|
| `orient` | Context pack + recall (≤2 KB); `--explain` ranks learnings |
| `gate` | Plan lock before recognized mutations |
| `verify` | Named checks + evidence |
| `compound` | After **passed** verify — reindex/telemetry from plan evidence |
| `compound --insight` | Investigation capture (not promotable) |
| `report --growth` | AE growth scoreboard from events (**no LLM**) |
| `recall` / `get` / `search` / `lookup` / `tree` | Retrieval |
| `graph deps` / `dependents` / `path` / `explain` / `impact` | Bounded structural evidence and change-impact candidates |
| `flows prepare` / `flows publish` / `flows status` / `flows show` | Optional source-bound descriptive application model |
| `diagrams render` / `graph` / `flow` / `formal` / `status` | Local SVG/HTML views, recorded formal counterexamples, optional PNG, and source freshness receipts |
| `edit` / `write` / `apply` / `undo` | Mutations (`undo` operator-only) |
| `exec` / `bash` | Governed process / shell |
| `todo` | Durable worklist (`.harness/todo.json`) |
| `validate-plan` / `index` / `events` / `run` | Plan check, indexes, ledger, prior runs |

### Optional application flow models

```bash
ae flows prepare --file .harness/decisions/flow-scope.json --json
ae flows publish --file .harness/decisions/flow-candidate.json --json
ae flows status --json
ae flows show --json
```

The optional scope file is `{"watchPaths":["src/orders"]}` with paths chosen for this product. Preparation captures exact committed sources from the locally observed default branch. Without a scope file, it reuses existing watch paths or starts at `.`. Inspect those sources, retain the returned preparation unchanged, and author the candidate's structured statechart before publishing. Harness validates and stores immutable project/generation-commit snapshots; it does not fetch or invoke an LLM. See [flow model authoring](corpus/skills/codebase-context/references/flow-models.md) for the candidate fields and limits.

Status distinguishes `absent`, `current`, `stale`, and `unknown`. It describes the observed committed default ref, not a dirty feature checkout or unseen remote state. Relevant orientation receives bounded pointers rather than model bodies. Consult them for intent completeness, then inspect the task sources. A map never becomes automatic `intent_sources`, accepted intent, or verification proof.

Successful compound results may include advisory `flowMaintenance` for an existing model made stale by watched default-branch changes. The Engineer explicitly inspects and regenerates it; compound neither merges main nor starts that work. Linked worktrees share the selected home's project store; sharing does not imply cross-machine synchronization.

### Repository-local formal checks

When a critical property needs deeper verification, extend the selected product recipe through the existing [formal verification procedure](corpus/skills/create-primitive/references/formal-verification.md). Keep accepted properties, source coverage, models, tool configuration, negative controls, actual-code correspondence, and maintenance evidence together. Relevant code changes rerun and maintain that check; failed or blocked work cannot silently advance synchronization. An abstract model pass does not establish implementation correctness.

The optional [workflow invariant reference](corpus/skills/references/workflow-invariants.md) covers exactly three existing boundaries: intent before mutation, current verification before verified delivery learning, and mode-related mutation authority. It adds no ordinary-session injection or new Engineer–Harness contract. The Engineer still chooses modes; Harness checks operations and recorded authority.

Java/TLC are used only by an explicitly selected formal check. Normal `npm pack`, installation, and unrelated sessions need neither tool. These supporting checks add no global skill or external plugin prerequisite.

### Domain delivery

`domain_version: 2` separates logical repository and shared-source identities from local root `bindings` in `<harness-home>/domains/<name>.yaml`. Version 1 remains display-only. Shared specs and conventions declared authoritative bind their bytes. Accepted roots bind Git and physical directory identity. Drift requires an authored amendment; changed repository membership requires a new parent.

```bash
ae domain show --name catalogue --json
ae domain plan-new --name catalogue --file .harness/decisions/catalogue-create.json --json
ae domain get --name catalogue --plan <returned-parent-path> --json
ae domain status --name catalogue --plan <returned-parent-path> --json
```

Creation requires an authored full-plan decision covering every configured repository, exact touched scopes, child plan decisions, dependencies, configured named joint checks, release order, and rollback responsibility. The coordinator's named check must also exist. Creation does not approve trust. Existing isolation policy determines whether a touched repository needs a linked issue worktree. Use each returned child workspace and plan path for its ordinary delivery lifecycle.

Parent records live in `<harness-home>/domains/<name>/plans/`; children live in their ordinary external project stores. Both use full schema 3 `.hplan` records. The accepted parent binds its coordinator checkout and HEAD. A different checkout cannot mutate, review, verify, compound, or complete the parent. Parent operations use these explicit commands:

| Command | Purpose |
| --- | --- |
| `domain plan-update --name <name> --plan <path> --file <decision>` | Authored start, amendment, progress, or completion |
| `domain gate --name <name> --plan <path> --phase implement` | Parent gate |
| `domain review prepare` / `domain review assemble` | Parent captured review and collected results, with `--name` and `--plan` |
| `domain verify --name <name> --plan <path> --base <base>` | Coordinator check and integrated proof after child completion |
| `domain compound --name <name> --plan <path> --learning-decision <decision>` | Current parent learning or explicit no-learning |

Joint checks run in trusted repository contexts against the exact participating revisions, including unchanged dependencies. Harness supplies their roots and bindings through `HARNESS_DOMAIN_REVISION_MANIFEST` and rejects drift during execution. Valid child and joint receipts remain reusable on resume. Parent completion also requires its current review, learning, tasks, criteria, and closed hard gaps.

Private parent learning publishes and indexes under the selected domain store. Ordinary project recall does not yet search those episodes. Upgrade CLI, corpus, and hooks together; the prior packaged CLI rejects `.hplan` before mutation. See [shared intent and domain delivery](../../docs/adaptive-engineering.md#shared-intent-and-domain-delivery) for configuration, amendment, and authority rules.

### Performance analysis

```bash
ae performance analyze --json
ae performance analyze --domain catalogue --json
ae performance analyze --file .github/harness/performance.json --dry-run --json
```

Select exact source files in `.github/harness/performance.json`, using `self` or repository IDs from an existing version 2 domain. Declare each journey's completion, environment, workload, freshness bound, and constraints. Express latency, reliability, throughput, and cost goals separately; missing dimensions remain unknown. The [performance engineering reference](corpus/skills/engineer/references/performance-engineering.md) has the finite schema example and workflow.

Analysis reads selected local inputs, executes no product code, and makes no network requests. It returns content-bound JSON and self-contained HTML under `.harness/performance/<report-id>/`; dry-run creates no report files. The linked architecture/flow and implementation/dependency views distinguish declared structure, lexical extraction, and attributed measurements. Missing telemetry permits static gap analysis. Goal comparisons require compatible current observations and source mappings; unknown and stale evidence remain explicit.

Orientation and review use bounded matching context from the conventional profile. Applicable authoring and review apply the shared code principles. Reports are snapshots and grant no delivery or check authority. Use existing accepted plans, named checks, and supported experiments for changes. CLI evidence does not establish native VS Code or IntelliJ behavior, causal diagnosis, or production improvement.

### Optional agent (opt-in add-on)

```bash
ae config set agent.enabled true --scope user   # default off
ae agent "task" --profile autonomous --verify-cmd "node ./v.mjs"
ae agent "task" --dry-run --json
```

Profiles: `autonomous` (default) · `deliver` · `benchmark` (fixture). **Not** the Adaptive Engineering product runtime — host `@engineer` + kernel remain that.

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

### Knowledge

Learnings live in a local never-pushed store (`~/.ae/knowledge/<repo-id>/`). Sole writer: `consolidate --apply`.

| Command | Purpose |
|---------|---------|
| `knowledge` | Mode on/suggest/off, purge, optional `commit repo` mirror |
| `consolidate` | `--status` · `--candidates` · `--apply --ops` · `--rebuild` |
| `remember` / `learning` / `learnings` | Teach · retire/dispute/confirm/promote · list |
| `eval-knowledge` | Deterministic retrieval proxy (not model-graded benefit) |

Trust gradient: episodes stay private → learnings stay local → shared behavior only via human PR (unless `knowledge commit repo`).

### Repository dependencies

Use the file graph when an orientation neighborhood needs more detail:

```bash
ae graph deps src/main.mjs --depth 2 --json
ae graph dependents src/service.mjs --depth 2 --json
ae graph path src/main.mjs src/audit.mjs --json
ae index --structural
```

Queries read current tracked source files and reuse extraction only when the
content hash matches. Dirty edits and deleted files affect the next query.
An uncached query uses lexical extraction and does not build an index.
`orient --read` advertises the commands without scanning the full graph.

The graph describes observed module imports. Relative paths and unique local
name matches have separate resolution labels; the latter are heuristics.
Lexical extraction is approximate, and dynamic runtime dependencies are outside
its guarantee. Stored symbol references are name matches, not an exact call
graph. `not-found` means no observed import path within complete reported
coverage. Missing files, parse errors, unresolved imports, source changes and
limits qualify absence as `unknown`.

Depth defaults to 1 for dependencies and dependents, and 8 for paths (maximum
32). Output defaults to 50 edges and unresolved imports (maximum 200 each).
Queries scan at most 4,000 tracked source files of 200 KB each and retain at
most 20,000 module edges and 4,000 unresolved imports. JSON reports coverage,
omissions, extraction tiers, a worktree snapshot hash and any reused generation.

Structural data lives locally under
`~/.ae/index/<repo-id>/<worktree-id>/structural/`. Each immutable
`generations/<id>/` contains `meta.json`, `files.json`, `symbols.json` and
`graph.json`; `current.json` selects one generation and records table hashes.
Each table is limited to 10 MB. Complete reads and publication share a short
lock, and publication retains the current and previous generations. A failed
publication preserves the previous selection. Busy or corrupt caches fall back
to current lexical facts for graph queries. Locks with a confirmed dead owner
can recover; missing ownership or interrupted recovery requires inspection.
Legacy flat indexes remain readable and upgrade on the next build; their
compatibility read cannot guarantee isolation from an older writer. The cache
is derived data and stays out of product repositories and Git.

## Output and exits

Human lines: ledger rows (`✓` / `!` / `✗`; ASCII under `NO_COLOR`). `--json` is unstyled.

| Exit | Meaning |
|------|---------|
| 0 | ok |
| 1 | command failure |
| 2 | usage |
| 3 | not initialized |
| 4 | needs approval |
| 5 | sync conflict |
| 6 | doctor failed |
| 7 | network |
| 130 | interrupted |

Gate and verify keep their documented policy-driven exits. New ordinary full plans use `plan_schema: 2`, short plans use `short-v2`, domain plans use full schema 3 `.hplan` records, and supported ordinary experiments use full schema 4 `.hplan` records. Schema 4 preserves domain validation. Legacy plans retain their declared guarantee. Named checks use the selected private or shared source reported by `ae checks list --json`.

### Experiments

`experiment status --json` reports the installed trusted evaluator paths without probing or writing. An accepted full experiment binds one tracked finite JSON weights candidate, a frozen `linear-json-v1` workload, metric, hard correctness, target and budgets. Only an actual registered linked issue worktree on a probed supported macOS runtime can execute it.

Reserve with `experiment begin --plan <path> --file <decision.json>`, evaluate the returned `attempt_id` once with `experiment evaluate --plan <path> --attempt <UUID>`, then keep/discard/cancel through `experiment resolve --plan <path> --file <decision.json>`. Begin/resolve decisions are bound to the current raw plan hash. Establish and keep the baseline before reserving candidate edits. Every reserved score/guard pair spends two slots; crashes, failed launches and bounded repairs retain that cost. `experiment status --plan <path>` reads durable state without recovery.

Keep requires validated owned artifacts, hard correctness and meaningful improvement. Discard restores recognized editable bytes/modes while preserving HEAD, the user index and unrelated work. Frozen input drift, unknown bytes or unproven child ownership blocks unsafe transitions. An exhausted or cancelled series does not complete the plan; a retained correct target still needs ordinary review, separate behavioral verification, learning/no-learning and completion. See [bounded experiments](../../docs/adaptive-engineering.md#bounded-experiments) for exact contracts, check configuration and recovery.

**VS Code:** `install --configure-vscode` registers hooks (PreToolUse gate, PostToolUse record, Stop requires passed evidence). `ae doctor --host vscode` after install/upgrade.

## Maintainers

```bash
cd packages/ae
npm test
npm version patch --no-git-tag-version
npm pack
```

`package.json` is the CLI release authority. Use `npm version` to update it and both root version fields in `package-lock.json` together. Use a patch for compatible fixes and prompt maintenance, a minor for new compatible behavior, and a major for incompatible contracts. Review and commit the version change before publishing the reviewed package.

`npm run check:release` compares the manifests with both CLI version flags and checks the agent prompt budgets. It runs before and after `npm version` and before `npm pack` or `npm publish`. CI runs the same tests. A failed check blocks packaging. These checks catch inconsistent versions and prompt growth, but maintainers still choose the release increment.

The bundled VS Code bridge has its own version in `vscode-extension/package.json`. Increment it when bridge behavior or metadata changes. Agent and skill files ship under the CLI version. Schema versions, dependency ranges, host compatibility floors, and historical release examples describe separate contracts.

```text
bin/ae.mjs   lib/   test/   eval/   corpus/   config/
```

Node 20+. Runtime libraries: `yaml`, Pele and D2/WASM. Pinned Tree-sitter loader/runtime and Java, JavaScript, TypeScript, TSX and Python WASM grammars ship inside the package. No native parser build, optional dependency installation or runtime parser download is required. Unsupported inputs and unavailable/corrupt assets remain explicitly degraded; release checks reject damaged shipped assets. Diagram rendering uses bundled assets without a renderer executable, browser, server or runtime download.

## Structural evidence and impact

```bash
ae graph explain src/caller.ts src/processor.ts --json
ae graph impact src/processor.ts --depth 2 --json
ae orient --read --context-version 2 --question-kind change-impact --file src/processor.ts --query 'change retry behavior' --json
```

Graph output carries occurrence citations, extraction method, resolver status, inventory scope and omissions. Live CLI queries prepare the bundled AST index when needed. `--generation <id>` selects a retained immutable historical generation and never silently falls back to current source. See [the structural knowledge guide](../../docs/structural-knowledge.md) for snapshots, applicability and evaluation limits.

Impact suggestions are descriptive and do not select or waive accepted checks. Learning applicability compares selected source bytes separately from historical proof. Context policies remain opt-in until qualified model studies support a default change.

## Deterministic work operations (since 0.10.0)

Use `plan-new --file` and `plan-update --file` for accepted creation, amendments, notes, progress, new gap declarations and completion. Harness owns representation and revision/replay checks. Use `review prepare` and `review assemble` for captured scope and collected perspective coverage; semantic adjudication remains an explicit decision.

Publish accepted learning through `compound --learning-decision`; use frozen `consolidate --candidates` packets for consolidation decisions. `resources scaffold`, `validate`, `candidates` and `propose` generate structural facts and dormant proposals. Creation/activation uses the existing writer and approval contract. `report --facts` supplies bounded, source-bound reporting. Retrieve omitted rows rather than treating them as absent.

Upgrade CLI, corpus and hooks together. A structurally valid result does not establish check adequacy, independent reviewer identity or product quality. The installed Doctor proof entry covers the executable install path; selected-product and live editor evidence remain separate. For repeatable mechanical comparisons in a source checkout, see `packages/ae/eval/README.md`.
