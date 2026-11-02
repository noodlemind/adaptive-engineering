# Agent Context

This file contains accumulated knowledge about the codebase, discovered by agents over time. Read this at the start of any session.

## Project Structure

This repository is a skill-driven prompt library containing AI agent systems:
Source paths below describe the shared corpus and legacy Copilot hydration. `ae host setup` projects the same content into a selected runtime's owned configuration and skill roots; those configuration facts remain separate from native qualification.
- `packages/ae/corpus/agents/` — 22 agents (17 specialists + 1 delivery classifier + 1 engineer + 1 implementer + 2 coordinators, judgment-criteria style), read from `~/.copilot/agents/`
- `packages/ae/corpus/skills/` — 28 skills including internal planning (`ensure-plan`), experimental accepted delivery (`caffeinated`), on-demand gap resolution (`ensure-capability`), design-before-code (`architect`), per-role model setup (`setup-models`), verified learning (`auto-compound`), and knowledge consolidation (`consolidate`), read from `~/.copilot/skills/`
- `packages/ae/corpus/enterprise/` — optional corp overlay (skills, agents, capability-gaps) hydrated to `~/.copilot/enterprise/`
- `ae index` — deterministic manifest rebuild (replaces manual index steps)
- `docs/adaptive-engineering.md` — canonical Engineer and Harness explanation
- `packages/ae/corpus/knowledge/` — team-wide solutions and manifest (hydrated to `~/.copilot/knowledge/`), primitive creation, domain workflows, README maintenance, quick Q&A, and utilities
- `packages/ae/corpus/instructions/` — 5 scoped instructions (harness-global, TypeScript, Python, Java, PostgreSQL); Spring Boot and AWS SDK guidance live as on-demand skill references under `~/.copilot/skills/java/` and `~/.copilot/skills/aws/`
- `packages/ae/corpus/skills/code-review/references/checks/` — bundled review checks discovered by `/code-review`
- `.github/checks/` — optional product-specific review check examples
- `~/.ae/projects/<repo-id>/plans/` — new plans; existing `docs/plans/` and `.harness/plans/` remain readable legacy locations
- `packages/ae/corpus/knowledge/solutions/` — team-wide compounded learnings (hydrated to `~/.copilot/knowledge/`); product repos write new private episodes to `~/.ae/projects/<repo-id>/docs/solutions/`; committed `docs/solutions/` remains readable
- `docs/brainstorms/` — brainstorm documents from `/brainstorming` skill

## Conventions

- Agents use judgment-criteria design (define outcomes, not procedures)
- Skills are the primary reusable contract. Default repeated procedures, checklists, generators, and workflow guidance to skills; create agents only for separate judgment, authority, isolation, runtime profile, or accountability.
- Agents are classified as reviewers (read-only), researchers, actors (can modify code), engineers (full-cycle: modify code + delegate to subagents), or coordinators/navigation.
- Agent tools follow generous-but-meaningful permissions: reviewers get `codebase`, `search`, `read`, `usages`, `changes`, `problems`, `terminalLastCommand` (no editFiles); researchers get `codebase`, `search`, `read`, `fetch`, `problems`, `terminalLastCommand`; actors get tools matching their responsibilities plus `codebase`, `problems`, `usages`, `terminalLastCommand`; coordinators get `agent`, `codebase`, `problems` plus their operational tools; engineer has a broad but explicit tool allowlist, not wildcard access.
- Leaf-node agents set `user-invocable: false` to keep the `@` menu focused and `agents: []` to prevent accidental subagent spawning. Treat `user-invocable` as discovery/UX, not a security boundary.
- Coordinators and the engineer define `agents:` allowlists restricting which specialists they can invoke
- Coordinators dispatch subagents in parallel batches (3-4 at a time) rather than sequentially
- All review agents include prompt injection guardrails (Guardrails section before Mission)
- Skills follow progressive disclosure (frontmatter → body → references)
- The connected pipeline: `/brainstorming` (optional) → `/capture-issue` → `/plan-issue` → `/deepen-plan` (optional) → `@engineer` Deliver mode → `/code-review` → `/compound-learnings`. `@engineer` Answer mode covers quick Q&A outside the pipeline. `/project-readme` uses proportional docs delivery before editing. `/create-primitive` is the canonical primitive creator for skills, agents, instructions, checks, references, and solution docs. `/java`, `/python`, `/sql`, and `/aws` are reusable domain workflow skills that pair with scoped instructions and specialist reviewers.
- State machine: `status` (open/planned/in-progress/review/done/blocked-capability), `plan_lock`, `phase`, `domains`, `capability_gaps`
- Engineer's shared behavior is authored in `packages/ae/corpus/skills/engineer/references/contract.md`; the Engineer skill activates it and native entry points contain generated projections. Quick Answer and read-only Investigate modes stay outside the Deliver lifecycle. Skills load on demand, and users are not asked to run internal support steps manually.
- Activity logs in plan files provide session continuity
- Plan files are the local context pack. Standard sections include `## Context`, `## Acceptance Criteria`, `## Research Notes`, `## Impacted Files`, `## Verification Plan`, `## Risk & Review Routing`, `## Implementation Notes`, `## Review Findings`, and `## Activity`.

## Technology Notes

_This section grows as agents discover patterns. Add notes here when you learn something about the codebase that future sessions should know._

### Subagent Tool Restrictions
When agents run as subagents (dispatched by coordinators), VS Code may restrict tool access even if the tool is in the agent's `tools:` array. Terminal and editor tools are most commonly restricted. Agents should check tool availability at execution time and use fallbacks from the cross-environment compatibility table in copilot-instructions.md. Extension-provided diagnostics (SonarQube, ESLint, Checkstyle) are accessed via the `problems` tool, not as individual named tools — they contribute to workspace diagnostics, not the tool registry.

### Codebase Snapshot
`docs/codebase-snapshot.md` is a point-in-time snapshot of the project structure, conventions, and architecture diagrams (Mermaid). Generated by `/codebase-context`. Fully replaced on each invocation — not append-only. Distinct from `agent-context.md`: the snapshot captures project structure and diagrams, while agent-context captures patterns discovered during agent work sessions. Refresh the snapshot by running `/codebase-context` when the codebase changes significantly.

### Code Review Branch Diffs
The Engineer runs `ae review prepare` with the selected base to capture a current review packet and provides the packet and required sources to the coordinator. The coordinator delegates judgment and returns raw reviewer results; the Engineer runs `ae review assemble` to bind those results to the packet's current content. The coordinator does not need terminal or editor authority.

### Intelligent Intake Routing
`@engineer` mode selection (Answer / Investigate / Review / Deliver) is the intake router: the Engineer classifies each incoming request, checks for existing plans/brainstorms, and picks the mode or pipeline skill that fits. Engineer handoffs cover pipeline transitions — both "where am I?" and "where should I begin?" resolve through the Engineer rather than a dedicated routing skill.

### Confidence-Gated Code Review
The `/code-review` skill uses persona-based review with structured JSON findings. Each persona returns severity (P1-P3) and confidence (0.0-1.0). Harness validates, confidence-gates, and merges exact claims using file, line, normalized title, description, and suggested_fix, then applies its declared perspective-agreement policy and action routing. Agreement can add 0.10 confidence. That boost does not verify independence. A host invocation counts when its agent is the specialist and its caller is the engineer or the code-review coordinator. An engineer same-context result stays unverified and is not independent evidence. Semantic disagreement or overlap requires explicit Engineer adjudication rather than coordinator synthesis. Persona definitions are in `references/review-personas.md`; the output schema is in `references/findings-schema.md`.

### Document Review as Quality Gate
The `/document-review` skill uses 4 personas (design, scope, coherence, feasibility) with per-document-type criteria. Available between brainstorm→plan and plan→work as a quality gate. Evaluation criteria are in `references/review-criteria.md`. Fixes require authorization: P1/P2 findings may be addressed within the accepted scope, and P3 fixes require a request. Managed plan changes use a revision-bound plan-update decision; product edits require the Deliver gate. Changed source bytes require a fresh review packet. Document review does not accept or lock a plan.

### Explicit execution boundary
`@engineer` Deliver mode executes or resumes locked plans and owns ordinary end-to-end work, while planning, review, and compounding retain their dedicated procedures.

Orient returns the internal experimental `/caffeinated` procedure read pointer only for an accepted Deliver plan with a current playbook binding. `/ensure-plan` follows that pointer after establishing prerequisites. Actual skill loading, scoped worklist use and named proof need their own evidence; declaration and packaging do not establish model outcomes or native editor activation.

### Verification Before Completion
`@engineer` Deliver mode runs evidence-based verification before claiming completion: tests pass (actual output reported), files match plan scope, all phase tasks checked, clean working state. Verification results logged in activity entries. Failed verification blocks completion claims.

### Skill-Specific Error Recovery
Four orchestrating skills (code-review, plan-issue, deepen-plan, engineer) have error handling specific to their failure modes. Common patterns (subagent failure, tool unavailability, file not found, timeout) are in `~/.copilot/skills/references/error-handling-patterns.md`. Each skill references shared patterns plus adds domain-specific errors.

### Solution Document Format
`/compound-learnings` publishes to **`knowledge/solutions/<category>/<slug>.md`** (global, cross-repo after hydrate). Template: `assets/solution-template.md`. Then **required** `/index-memory`. New repo-private episodes use `~/.ae/projects/<repo-id>/docs/solutions/`; committed product `docs/solutions/` remains readable. Tags: specific ("n-plus-one", "java-21"), 3-7 per doc.

### Knowledge Lookup SSOT
`~/.copilot/skills/references/knowledge-locations.md` — single list of read/write paths; do not duplicate in other primitives.

### Engineer Agent
The Copilot Engineer is an inline generated projection within the existing 600–900 estimated-token budget. Author behavior in `corpus/skills/engineer/references/contract.md` and metadata for committed examples in `corpus/hosts/engineer-adapters.json`, both beneath `packages/ae/`. `lib/hosts/engineer-exports.mjs` renders those examples; `npm --prefix packages/ae run generate:engineer` regenerates them and `check:engineer` rejects drift. Runtime `lib/hosts/projection.mjs` exports the current skills, roles and applicable instructions for user-selected Claude Code, Codex, Cursor or terminal setup. The two committed example files are inspectable projections, not the installer input for every host. Native configuration preserves declared capability limits: Codex role prose does not isolate permissions, Claude subagent mode differs from main-agent delegation, Cursor stop follow-up is advisory, and terminal use has no native hooks. No configuration file establishes native activation or successful model behavior.

`ae host list`, `setup`, `status`, `remove` and `export` use the common command registry. Keep ownership records and root resolution with host setup; merge/remove only AE-owned assets and hook groups. `AE_SKILLS_HOME` separates skill discovery from the native configuration root, especially Codex's `~/.agents/skills` versus `~/.codex`. The local stdio MCP façade exposes ten fixed AE operations against one startup workspace; it does not proxy arbitrary host tools or grant project trust. Portable Agent Plugins export contains skills, specialist criteria and explicit-workspace MCP configuration, with a separately installed `ae`/Node prerequisite and no native hooks.

Selected native resource reads use `lib/hosts/resource-read.mjs`; schema 1 personal skill publication uses `lib/hosts/personal-skill.mjs` with explicit configuration/skills roots and saved ownership bindings. Personal skills survive host removal. Native personal agents/instructions and legacy mutators are refused until a mapped writer exists (`personalRoleCreation: false`); setup can still project existing shipped roles and instructions.

### Engineer Memory System
Canonical model: `docs/adaptive-engineering.md` — three tiers, each with a single writer. T1 episodic ground truth spans several artifacts, each with its own writer: new private episodes (`~/.ae/projects/<repo-id>/docs/solutions/`) come from `/auto-compound` (verified fixes), `compound --insight`, and `ae remember` (human teachings); global solution docs are published by `/compound-learnings`; new plans (`~/.ae/projects/<repo-id>/plans/`) are created and extended through Harness decisions by `/capture-issue` and `/plan-issue`; and `## Activity` logs are maintained by Harness plan operations. `/consolidate` clusters T1 episodes into the T2 learnings store at `~/.ae/knowledge/<repo-id>/` (CLI-managed local git repo outside the working tree; `ae consolidate --apply` is the sole writer of learning content, and direct human hand edits are absorbed with `source: human` provenance). Human retire/dispute/confirm/promote decisions persist in the governance ledger and are mechanically reapplied across rebuilds; `orient` injects the top-matching learnings into the context pack. T3 is behavior: `.github/` primitives via `/create-primitive` + human PR. `/recall` runs before investigate; `/compound-learnings` publishes globally; `/index-memory` rebuilds `manifest.yaml`. Capture gate: `~/.copilot/skills/references/capture-gate.md`.

### Adaptive Engineer Harness
`@engineer` is the central coordinator for adaptive capability expansion. It routes to known skills first, uses `~/.copilot/skills/references/subagent-context-packet.md` for delegated work, and uses `~/.copilot/skills/references/human-approval-policy.md` before risky strategy choices. Missing reusable capability must be documented with `~/.copilot/skills/references/capability-gap-proposal.md` and then routed to `/create-primitive` after human approval. Architecture details live in `docs/adaptive-engineering.md`.

### Skill-Driven Standardization
`docs/adaptive-engineering.md` defines primitive boundaries for teams adapting this repo. Workflows live in skills, long criteria and library-managed checks go in skill `references/`, product-owned review overlays can live in product `.github/checks/`, file-scoped conventions use ship-set files under `packages/ae/corpus/instructions/` or the legacy Copilot personal instruction writer; selected native hosts explicitly refuse unmapped personal instruction creation, and solution docs graduate to `agent-context.md` only when they capture durable project-level knowledge.
