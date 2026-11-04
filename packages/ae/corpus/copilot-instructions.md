# Copilot Instructions

Shared context loaded into every agent and skill session.

## Project

Skill-driven prompt library for software development using GitHub Copilot in VS Code and IntelliJ IDEA on Windows. Install hydrates agents, skills, and instructions into the user profile. Product repositories do not receive a copy of that corpus.

## Primitives

Skills = workflows. Agents = isolated judgment. Instructions = file-pattern rules.

## Plans and knowledge

- Product **`~/.ae/projects/<repo-id>/plans/`** — new per-issue context packs (`status`, `plan_lock`, `phase`, `## Memory Cards`); existing **`.harness/plans/`** and **`docs/plans/`** remain readable legacy locations. Use CLI-returned plan paths and decision files for managed updates.
- New repo-private episodes **`~/.ae/projects/<repo-id>/docs/solutions/`**; committed `docs/solutions/` remains readable.
- Team **`packages/ae/corpus/knowledge/solutions/`** — cross-repo learnings (hydrated to `~/.copilot/knowledge/`).
- Lookup order: `<copilot-home>/skills/references/knowledge-locations.md` (the home defaults to `~/.copilot`).

**`@engineer` only:** task modes, delivery lifecycle, capture gate, and checklist live in `engineer.agent.md`. They are not duplicated here.

## Conventions

- Follow existing patterns. Consistency over preference.
- Keep primitive boundaries clear: workflows belong in skills, role-specific judgment belongs in agents, file-scoped conventions belong in instructions, bundled review checks belong in the owning skill's references, and narrow product-specific review rules belong in product `.github/checks`.
- TDD: failing test → minimal fix → cleanup.
- Surgical diffs only. No drive-by refactoring. Three similar lines > premature abstraction.
- Never commit secrets or credentials. Validate input at boundaries. Parameterized queries.

## Orchestration

The engineer selects the skill/flow first, then delegates only when separate judgment, authority, or isolation improves the result. Coordinators delegate to specialist subagents via the `agent` tool. Subagents run in isolated context — include all necessary context in the task prompt. The plan-issue and code-review skills may delegate bounded judgment to their coordinators (`plan-coordinator`, `code-review-coordinator`) when the `agent` tool is available. The Engineer applies planning decisions and owns CLI review preparation and assembly; the review coordinator returns packet-bound raw results. Coordinators use `agents:` allowlists and dispatch in parallel batches of 3-4. Missing required judgment remains incomplete coverage.

Engineer harness: `@engineer` agent file owns the only normative delivery lifecycle; read-only modes stay outside it. Runtime details: `harness-tool-contract.md`. Delegation: `subagent-context-packet.md`. Risky work: `human-approval-policy.md`.

For an accepted Deliver plan with a current playbook binding, follow orient's procedure read pointer to the internal experimental caffeinated skill. It continues the existing lifecycle and scoped worklist. A returned path or declaration alone is not activation evidence.

## Cross-Environment Tool Compatibility

This library primarily targets GitHub Copilot in VS Code and IntelliJ IDEA. Agent frontmatter declares VS Code tool names. When a capability is absent, use an advertised host-native equivalent only if the host permits the same scoped action:

| VS Code Tool | Fallback |
|-------------|----------|
| `codebase` | Repository search and targeted file reads |
| `usages` | Text search or IDE find references |
| `problems` | Run linter/compiler/test command and inspect output |
| `awaitTerminal` | Wait for the command in the host terminal |
| `execute` | Run shell commands (`execute/runInTerminal`, `shell`, `bash`) — required to run harness CLI, tests, builds |
| `changes` | `git diff` or IDE changes view |
| `terminalLastCommand` | Read output from the last terminal command (does not run new commands) |
| `githubRepo` | GitHub UI, GitHub integration, or `gh` CLI |
| `fetch` | Host-approved web/documentation lookup |
| `edit` | Host-native file creation and edit tools |
| `editFiles` | Host-native file edit tool |

Skills that reference `changes`, `terminalLastCommand`, or `githubRepo` include inline fallback instructions for non-VS Code environments.

## Tool Access Constraints

Inspect the session's advertised tools and actual tool results. A declaration does not prove availability. Do not infer a restricted subagent context from a missing tool alone.

- If a capability is missing, use an advertised equivalent only when the host permits the same scoped action. Prefer native creation and edit tools for product files.
- If host approval is pending, let the native dialog carry the request. Existing task authorization needs no second prose request to continue.
- If the host denies an action, stop that action. Do not switch to terminal or another tool to evade the denial.

Default/Manual Permissions is a supported setup. Do not require Full Permissions, change approval settings, or widen writable roots to continue. For worktree scope and external plan writes, read `<copilot-home>/skills/references/tool-native-loop.md` with the host read tool.

**Extension-contributed tools:** VS Code extensions (SonarQube, ESLint, Checkstyle, etc.) contribute diagnostics that appear via the `problems` tool (workspace diagnostics panel). They do NOT register as individually-named tools in agent frontmatter. To leverage extension diagnostics:
- Use the `problems` tool to read workspace diagnostics (includes all extension findings)
- Run extension-provided commands via terminal when available (e.g., `sonar-scanner`, `eslint --fix`)
- Extension tools are NOT discoverable via `tools:` frontmatter — they work through the diagnostics system
