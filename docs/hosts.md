# Hosts

AE runs inside the coding host you already use. `ae host setup` installs the Engineer, the skills, the specialist agents and the lifecycle hooks into that host's own configuration directory.

| Host | `--host` | Hooks | Stop hook blocks completion | Isolated specialist tools |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | Yes | Yes | Yes |
| Codex | `codex` | Yes | Yes | No |
| Cursor | `cursor` | Yes | No, advisory | No |
| Terminal | `terminal` | No | No | No |
| GitHub Copilot (legacy) | `copilot-vscode`, `copilot-cli`, `copilot-intellij` | VS Code and CLI | See [Legacy Copilot setup](#legacy-github-copilot-setup) | — |

## Set up a host

```bash
ae host list
ae host setup --host claude-code --dry-run   # show what would change
ae host setup --host claude-code
ae host status --host claude-code
```

The legacy aliases `vscode`, `cli`, `intellij` and `claude` are still accepted for `--host`.

Setup records which files it owns. It merges its hook groups into your existing configuration and refuses to overwrite files it does not own or files you have changed.

Then start the Engineer in that host:

| Host | Start the Engineer |
| --- | --- |
| Claude Code | `/engineer <what you want>` |
| Codex | Mention `$engineer` in your request. Review and trust the new hooks with `/hooks` first. |
| Cursor | `/engineer <what you want>` |
| Terminal | Point any agent at `<AE_HOME>/terminal/skills/engineer/SKILL.md` and let it run `ae` |
| GitHub Copilot | Select `@engineer` in Copilot Chat |

## Hooks apply to every repository

Host setup writes hooks into your user-level host configuration, so they run in every repository you open with that host, not only the ones where you ran `ae init-repo`. Under the default `enforce` mode, an edit with no accepted plan and gate is denied, even in a repository that has never used AE.

To try AE without blocking other work:

- Start the host with `HARNESS_ENFORCEMENT=observe` (or `warn`) in its environment. Hooks then explain what is missing without denying the edit.
- Or remove the integration when you are done: `ae host remove --host <id>`.

## Check a host

Use `ae host status --host <id>`. It reports owned files, configuration drift and declared capability limits.

`ae doctor` and `ae status` describe the legacy Copilot installation. On a Claude Code, Codex, Cursor or terminal setup they report a missing Copilot install and failing Copilot checks. That is expected; use `ae host status`.

## Upgrade and remove

After you update the `ae` package, refresh each host you set up:

```bash
ae upgrade --host claude-code
```

Pass the same `--config-home`, `--skills-home` and `--ae-home` overrides you used for setup. Upgrade refreshes owned files and hook commands and reports any file you modified as a conflict instead of overwriting it.

```bash
ae host remove --host claude-code --dry-run
ae host remove --host claude-code
```

Removal deletes unchanged AE-owned files and hook groups. It keeps your changes, unrelated configuration, personal skills and all project state.

## Legacy GitHub Copilot setup

AE began as a GitHub Copilot customization set, and the original installer remains for existing users:

```bash
ae install --configure-vscode   # VS Code: agents, skills, instructions and hooks in ~/.copilot
ae install --target cli         # Copilot CLI
ae install --target intellij    # IntelliJ IDEA (no lifecycle hooks)
ae doctor --target vscode       # health of the installed surface
```

`ae host setup --host copilot-vscode` (or `copilot-cli`, `copilot-intellij`) runs the same installer. IntelliJ customizations can be healthy while native lifecycle hooks are unavailable, so edits there are not gated.

## Details

### Setup guarantees

`ae host setup`, `status` and `remove` take `--host`, optional `--config-home`,
`--skills-home` and `--ae-home`, plus `--json`. Use the same root overrides for
later status/removal. `--dry-run` reports intended mutations without publishing
them. Setup tracks file ownership, merges owned hook groups with existing user
configuration and refuses conflicting unowned or modified assets. Removal
preserves user changes and unrelated configuration; it does not remove project
state or approve trust.

| Host | Default configuration | Default skills | Important boundary |
| --- | --- | --- | --- |
| Claude Code | `~/.claude` | `~/.claude/skills` | Main-agent delegation and subagent mode have different capabilities. |
| Codex | `~/.codex` | `~/.agents/skills` | Review/trust configured hooks with `/hooks`; parent permissions remain authoritative. |
| Cursor | `~/.cursor` | `~/.cursor/skills` | Stop follow-up is advisory and bounded, not hard completion blocking. |
| Terminal | `<AE_HOME>/terminal` | `<AE_HOME>/terminal/skills` | Manual CLI use; no native hooks or isolated agent registration. |

`AE_SKILLS_HOME` selects the native skill root independently of the configuration
root. This lets direct CLI reads and native activation checks resolve Codex's
separate skills directory rather than infer it from `~/.codex`. Host setup
translates known corpus-root references and supplies matching instruction
criteria. Native before/after-tool, context and completion bridges reuse the
existing kernel. Unknown native tool effects are refused; an arbitrary MCP
namespace is not a blanket read-only exception.

Setup reports declared capabilities and `nativeQualification: unverified`.
Neither generated configuration nor automated event fixtures proves the host
loaded its hooks, blocked an actual native edit, or completed a model-driven
journey. No user host configuration or trust is changed by this repository's
automated disposable fixtures. Qualify the actual runtime/version, surface, OS,
settings and mutation paths before relying on a native enforcement claim.

### Native personal resources

`ae resources create skill <name> --file - --copilot-home <config> --skills-home <skills>`
accepts a schema 1 JSON decision on stdin containing the complete skill text.
It requires a current selected-host binding and validates the skill before
publication. Shipped setup-owned skills cannot be replaced by this writer;
changing a personal skill requires its observed `expectedDigest`. Personal
skills survive host removal.

`resources list`, `show` and `validate` with the same selected roots discover
native skills and inspect managed role/rule bytes. This is resource-format and
asset-integrity evidence, not native invocation proof. `resources create agent|instruction` accepts schema 1 canonical host-neutral text and projects it through the selected native writer. It requires direct authorization or a current matching standing grant; updates require the observed native `expectedDigest`. The writer cannot replace arbitrary unowned or setup-owned assets. Personal roles begin pending reload; approved delegation reconciliation and an exact source-bound first-invocation action receipt allow a controlled native availability check. Only the correlated successful completion marks that current role available. The retained observation reports `loadedSourceHash: unverified`, since a hook event does not attest a host's cached definition. Codex instruction files are context-routed. Terminal resources remain manual. Refuse an unmapped type rather than using a Copilot-format fallback.

### Local tools and portable distribution

`ae mcp serve --workspace <repo> --copilot-home <config> --skills-home <skills>`
starts a local stdio server bound to the selected workspace and roots. Its twelve
fixed tools forward authored decisions and operations to the existing CLI;
there is no new model loop, network listener or generic shell/tool broker. The
implemented compatibility versions are `2025-11-25`, `2025-03-26` and
`2024-11-05`; the server does not claim the 2026 per-request MCP protocol.
Existing trust, native skill-read evidence, review and proof requirements still
apply. MCP guards routed AE operations, not unrelated host tools.

`ae_checks_list` reports the bound workspace's selected check source and digest.
`ae_checks_configure` forwards the bounded configuration decision without
executing its commands or granting trust, so MCP delivery has the same recovery
path as the CLI.

`ae install --configure-vscode` also configures this server in the VS Code user
profile. Each startup resolves `${workspaceFolder}` and keeps that checkout
bound for the server's lifetime. Reconnect in the opened worktree instead of
reusing a server bound to the primary checkout. Setup preserves other servers
and approval settings; native MCP trust remains a host decision. Authored
configuration conflicts are reported before installation writes.
`ae upgrade` refreshes profiles already configured for the selected AE home;
use `--configure-vscode` to configure previously unconfigured profiles.

Plan tools advertise action-specific decision schemas. Orient, status and plan
operations return a shared `workflow` containing the current plan revision and
candidate decisions. These facts grant no mutation authority. Where a supported
host supplies user-prompt events, new intent stays pending until a successful
plan decision records its disposition. Direct managed-plan edits are refused;
missing host observations remain explicitly unobserved.

`ae host export --output-directory <new-directory> --workspace <repo>` writes an
Agent Plugins 1.0 package into a new directory. It contains skills, specialist
judgment criteria and an MCP configuration explicitly bound to that existing
Git workspace. The client still needs a compatible installed `ae` CLI and
Node.js >=20. Export does not install hooks or native agents, embed credentials,
grant trust or establish independent review provenance. Export again for a
different workspace; the plugin directory is never inferred to be the product.