# AE host portability: implementation and qualification plan

Date: October 30, 2026. Owner: AE maintainers. Status: software implementation scope complete; final automated validation is recorded separately, and native runtime/model/OS qualification remains open.

## Goal and authorization

Install one AE harness/CLI, then let a user configure one or more selected hosts from the same Engineer, skills, specialist criteria and project state. Native configuration must not create separately maintained Engineer behavior. Each integration states both its declared capabilities and the limits of observed qualification.

The initial user request was: “Prepare a detailed plan and start implementing this change in a new PR.” Subsequent user direction expanded this PR from the first extraction slice to completing the planned software mechanics. The resulting scope includes canonical behavior, complete corpus projections, selected-host setup/status/removal, native event bridges, a bounded local MCP surface and portable packaging. It does not include merging, publishing a package, changing the user's actual host setup, approving trust or representing unobserved native behavior as passed.

This committed document records the design, implementation sequence and remaining qualification. CLI-owned plans retain execution state, gate, review, verification and completion authority.

## Baseline and dependency

- Merged main when work began: `0d44caad145bb3ef8ab9a7cf301ecfa00569615a`.
- Stabilization dependency: open PR [#104](https://github.com/noodlemind/prompt-library/pull/104), first inspected at `a89869b2151d804633dd9dfe862ed7c87a24b4b0`; its later observed head is `b6d8ecb5723b0e781bdc30bfcc879de7b0d239d6`. Main remains `0d44caad145bb3ef8ab9a7cf301ecfa00569615a`.
- Stabilization commit `63fcdddb9b175d7bc1fbe4ff451e4fcde1e2f354` was incorporated into the portability working branch. This is not a merge of PR #104 into main. PR [#106](https://github.com/noodlemind/prompt-library/pull/106) remains stacked on #104; incorporate subsequent dependency changes and rerun affected checks, then retarget after #104 merges.
- The first stage extracted behavior from the Copilot agent, generated two committed examples and documented later phases. Its Claude file was only a reviewable example. The expanded implementation adds full runtime projections; the earlier limited export is not the runtime setup mechanism.
- Preserve #104's canonical `AE_HOME`, private/shared project authority, selected-target recovery and ownership protections. Host portability does not require restarting project-state migration.

## Architecture and ownership

The corpus stays. Behavior, native representation, publication and execution each have an owner.

| Owner | Implemented responsibility | Boundary |
| --- | --- | --- |
| `corpus/skills/engineer/references/contract.md` | One authored Engineer behavior contract with neutral skill-root addresses | No native tool catalogue or installer policy |
| `corpus/skills/engineer/SKILL.md` | Discover and activate shared behavior with progressive references | No mandatory Copilot redirect or second lifecycle |
| `corpus/hosts/engineer-adapters.json` and `lib/hosts/engineer-exports.mjs` | Metadata/rendering for the two committed, inspectable Copilot/Claude examples | These examples are not a complete runtime installer |
| `lib/hosts/projection.mjs` | Translate the current corpus's skills, roles, known root references and applicable instruction representations for a selected host | Generated configuration does not prove native activation |
| `lib/hosts/setup.mjs` | Selected roots, owned assets, conflicts, hook merging, setup/status/removal and dry-run | No project trust approval or inferred native qualification |
| `lib/hosts/personal-skill.mjs` | Validated schema 1 personal skill publication under the selected native binding | Cannot replace shipped skills or create unmapped native roles/instructions |
| `lib/hosts/resource-read.mjs` | Selected native skill discovery and managed role/rule integrity reads | No native invocation or independent review proof |
| `lib/hosts/native-hook.mjs` | Native event normalization, effect classification and output mapping around existing kernel hooks | No blanket permission for unfamiliar native/MCP tools |
| `lib/hosts/mcp-server.mjs` | Ten fixed local stdio tools forwarding to existing CLI operations and startup workspace | No arbitrary shell, model loop or network listener |
| `lib/hosts/plugin-package.mjs` | Portable skills/criteria package and explicit-workspace MCP configuration | No bundled executable, native hooks or independent review provenance |
| Existing Harness kernel | Accepted intent, scope, gates, checks, evidence, review records and learning authority | No host model selection |

The Copilot Engineer remains inline and generated, preserving immediate behavior without another activation prerequisite. Its current metadata and native skill-read obligations remain source-contract checks. The existing primitive registry is not expanded merely because the same roles are projected into another representation.

## Delivered software phases

### 1. Canonical Engineer behavior

The shared contract owns modes, intent-before-mutation, successful implement gate, genuine skill activation, review/verification requirements, consultation responsibility and finding dispositions. The Engineer skill activates it rather than outsourcing ownership to `@engineer`.

`npm --prefix packages/ae run generate:engineer` regenerates the two committed examples; `check:engineer` and release validation detect drift. Generation retains Copilot authority and prompt budgets. Tests must distinguish exact source-to-projection parity from semantic host qualification.

### 2. Neutral installation and explicit host selection

Installing the npm package installs `ae`. Native configuration is a separate user selection:

```bash
npm install -g ./packages/ae
ae host list
ae host setup --host claude-code
ae host status --host claude-code
```

New integration IDs are `claude-code`, `codex`, `cursor` and `terminal`. Explicit Copilot IDs are `copilot-vscode`, `copilot-cli` and `copilot-intellij`; compatibility aliases retain existing surface names. Copilot setup delegates to the established installer instead of maintaining another implementation. The old `ae install`/`upgrade` behavior remains compatible.

A fresh TUI does not automatically configure VS Code. Upkeep for an already selected legacy installation remains available. Adding one integration does not choose another on the user's behalf.

`setup`, `status` and `remove` accept `--host`, `--config-home`, `--skills-home` and `--ae-home`, plus `--json`. Repeat root overrides for later operations. `--dry-run` reports mutations without publication. Status reports asset configuration/drift separately from `nativeQualification: unverified`.

### 3. Complete runtime corpus projections

Setup projects the current skills, supporting references, knowledge, specialist roles and applicable instruction criteria. Known Copilot-root references are translated to the selected roots. Claude receives its role/rule representation; Codex receives TOML role definitions and explicit skill-root separation; Cursor receives its role/rule representation; terminal receives manual-use assets.

| Host | Default configuration | Default skills | Capability boundary |
| --- | --- | --- | --- |
| Claude Code | `~/.claude` | `~/.claude/skills` | Main-agent delegation and subagent mode differ; preserve reported limits. |
| Codex | `~/.codex` | `~/.agents/skills` | Parent permissions remain authoritative; role prose does not create tool isolation. |
| Cursor | `~/.cursor` | `~/.cursor/skills` | Stop follow-up is advisory and bounded. |
| Terminal | `<AE_HOME>/terminal` | `<AE_HOME>/terminal/skills` | Manual CLI path, without native hooks or isolated agent registration. |

`AE_SKILLS_HOME` separates native skill discovery and activation from the configuration root. The selected skills path participates in content resolution; Codex must not infer its skills directory from `~/.codex`.

Scoped instructions preserve their path criteria. Where a host lacks an equivalent native instruction representation, matching criteria are available through the generated instruction reference. A missing required tool, independent reviewer or isolated delegation capability must be reported; serial criteria use is not independent-context proof.

### 4. Owned setup, upgrade and removal

Setup records generated file ownership and native hook groups, merges with unrelated user configuration and refuses conflicting unowned/modified assets. Roots and sources reject unsafe redirection. A shared skills directory cannot be silently acquired from another integration.

Repeat setup refreshes the selected integration's generated content. Removal deletes unchanged owned assets/groups while preserving changed user files and unrelated configuration. Neither removal nor a host switch deletes project plans, episodes or other shared AE state. Dry-run performs no publication. Native hook trust and project check trust remain person decisions.

These mechanics need disposable fixtures for fresh setup, replay, modified-owned and unowned collisions, redirected paths, mid-publication failure, coexistence and selective removal. Passing those fixtures establishes software behavior in their environment, not that a running editor consumed the result.

### 4a. Personal resources and explicit unsupported writers

A selected native host can create personal skills through
`ae resources create skill <name> --file - --copilot-home <config> --skills-home <skills>`.
The stdin decision is schema 1 with a complete valid skill `text` and optional
`expectedDigest`. The writer requires current host ownership bindings, refuses
setup-managed shipped-skill replacement and guards personal replacement with
the observed digest. Personal skills are not setup-owned and survive removal
of the integration.

`resources list`, `show` and `validate` with the same roots read native skills
and managed role/rule bytes. Their format/integrity evidence does not prove
host invocation. Native personal agents and instructions have no mapped writer
in this release (`personalRoleCreation: false`); creation and legacy
bundle/primitive mutations are refused under the native binding. Use a
capability proposal for the missing writer, preserving this boundary until its
permissions, schema, ownership and native behavior have their own implementation
and tests. Projection of existing shipped roles/instructions remains supported.

### 5. Native hooks around the existing kernel

Native bridges cover context/start, before-tool decisions, after-tool observations, compaction and completion where the host exposes the necessary semantics. They reuse existing checks rather than reimplement gates or proof rules in host configuration.

Claude and Codex mappings distinguish native before/after events and completion responses. Codex users must review/trust configured hooks through `/hooks`; generating a file does not complete that user step. Cursor's stop event can request bounded follow-up but cannot establish hard completion blocking. Terminal integration installs no native hooks.

Unknown native tool effects are refused rather than silently classified as reads. An unfamiliar MCP namespace is not a blanket exception. Optional MCP tools remain a separate surface; mediation covers only the operations actually routed through AE. After-action notification cannot undo or prevent an already completed mutation. Error/timeout semantics and alternate tool paths require actual native qualification.

### 6. Bounded local MCP interface

```bash
ae mcp serve --workspace <repo> --copilot-home <config> --skills-home <skills>
```

The stdio server fixes the workspace and selected roots at startup. Ten tools expose orientation, status, reference retrieval, gate, verify, plan creation/update, review preparation/assembly and compounding. Authored decisions go to existing CLI writers, preserving their validation, state, trust, review and proof authority. There is no generic command dispatcher, arbitrary shell, new LLM loop or network listener.

The implemented negotiated compatibility versions are `2025-11-25`, `2025-03-26` and `2024-11-05`. This is explicitly a legacy stdio compatibility surface, not a claim of the 2026 per-request protocol. Future protocol upgrades need their own negotiated semantics and interoperability tests.

Reference retrieval through MCP does not establish required native skill activation. Tools outside this mediation remain outside its enforcement. Tests cover fixed schemas, invalid/unknown inputs, workspace binding, bounded input/output, cancellation and forwarding results/errors without converting failures to success.

### 7. Portable Agent Plugins package

```bash
ae host export --output-directory <new-directory> --workspace <repo>
```

Export publishes a new Agent Plugins 1.0 directory containing skills, specialist judgment criteria, `plugin.json` and MCP configuration explicitly bound to an existing Git workspace. Existing output is refused. The configured product workspace is not inferred from the plugin directory; export again for another workspace.

The client requires a compatible separately installed `ae` CLI and Node.js >=20. The package does not install executables, credentials, native agents or hooks, and does not grant trust. Specialist criteria are references, not independent review provenance or role-specific permission isolation. Client support, loading, permissions and presentation remain client-owned.

## Qualification work still open

Software implementation and generated configuration are not native runtime qualification. No Windows/macOS editor session, actual user host setup or model-driven delivery is claimed by this PR's Linux/disposable fixtures. Keep the existing native protocol in `packages/ae/eval/host/README.md` as the qualification owner.

Qualify at least Copilot and Claude Code, then Codex and Cursor, under explicit runtime/version, surface, OS, trust/settings and configuration identities. Record separate observations for skills, role discovery, native tool invocation, before-action denial, after-action handling, delegation, completion and resume. A successful MCP call cannot stand in for an untested native edit hook.

| Native scenario | Required observation | Failure classification |
| --- | --- | --- |
| Fresh setup/discovery | Engineer loads the current contract and binds the right workspace without tool-name coaching | Installation or activation gap |
| Edit before accepted intent | Covered native edit and shell paths deny before any product bytes change | Missing pre-action coverage |
| Accepted scoped delivery | Intent, gate, implementation, required review and verification retain current evidence | Workflow/translation gap |
| Out-of-plan action | Attempt every declared native edit/process path; inspect actual files and receipts | Scope coverage narrower than advertised |
| Stale proof | Changed source/intent cannot complete or compound using old proof | Freshness or authority defect |
| Failure and timeout | Native errors/timeouts do not create false success; exact fall-through behavior is recorded | Host failure-semantics gap |
| Cancellation/resume | Resume preserves workspace, accepted authority and current evidence | Recovery/identity gap |
| Missing capability | Required absent review, tool or hook blocks its dependent operation or reports its exact weaker guarantee | Silent unsupported behavior |
| Two-host coexistence | Upgrade/remove one integration preserves the other and user settings | Ownership defect |

Inspect actual product bytes, native transcripts and retained receipts. Configuration existence and mocked event response prove only their bounded software assertions. Advertise a guarded capability only for observed paths and versions, with exclusions. No hook or MCP claim establishes OS-level confinement.

## Verification and evidence accounting

Automated checks cover canonical/export parity, native metadata/permissions, corpus references and activation paths, full projections, root overrides, ownership/conflict/replay/removal, personal-skill replacement and removal preservation, selected native resource discovery/validation and explicit unsupported-writer refusals, native normalization and decisions, CLI registration, fixed MCP tools and transport limits, portable export, neutral TUI startup and standalone packaging. Release checks must include the canonical source and runtime modules without requiring parent-repository assets or global host setup.

Final automated counts and failed/blocked checks belong in the PR's validation record; do not infer them from this roadmap. A blocked Harness proof remains distinct from direct test results. Preserve failures without weakening assertions or granting trust from the agent. Passing fixtures does not mark native qualification complete.

The pivotal assumption remains that AE's useful discipline comes from shared behavior and deterministic state rather than a single provider's orchestration. The paired native delivery/negative-control exercise tests that assumption. Measure time to first valid task, manual interventions, omitted required steps, false completion and scope violations. Small trials guide support decisions; they do not establish universal reliability.

## Storage and compatibility

Keep canonical corpus/runtime authority in the installed AE package and native generated configuration in the selected host roots. Preserve `AE_HOME` project state, existing private/shared policy authority and legacy state bindings. Deliberate team policy/checks remain distinct from personal host preferences and hook trust.

The legacy `.github/harness` path remains compatible. Host portability does not require renaming it or exempting all `.github` changes from verification. Follow #104's local excludes and ownership rules instead of requiring root `.gitignore` edits to hide personal runtime state.

Native host assets record ownership before replacement/removal. Project trust is never copied from another user, host or plugin package. A configured runtime does not imply approved repo-authored commands. The runtime/CLI version and generated asset version still need deliberate upgrade selection.

## Rollout, rollback and continuing maintenance

Review PR #106 against its open #104 dependency so the portability diff remains isolated. After #104 merges into main, retarget/rebase and rerun affected checks. Incorporating a dependency commit into the working branch does not mean that dependency is merged upstream. No upstream merge, package publication or real-user setup is part of implementation verification.

The canonical extraction and projections can be reverted with this PR; the kernel/state schema has no portability-driven migration. User-selected host removal operates from the generated ownership record and preserves changed/unowned files. Retain backups and receipts when a later rollout deliberately replaces existing configuration. Never delete project state to roll back one host.

Maintain runtime+surface+version compatibility observations as vendors change hook/tool contracts. Qualify cloud and local surfaces separately. A future MCP revision, new host or broader tool classification requires current primary documentation, scoped regression controls and native trials before expanding advertised guarantees.
