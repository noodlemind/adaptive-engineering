---
name: project-readme
description: Create or update the project README.md with overview, standards, workflows, components, data, and integrations. Not for quick questions -- @engineer Answer mode handles those.
argument-hint: "[optional project focus, README path, or update request]"
---

# Project README

## Pipeline Role

Documentation generator and maintainer. Use this skill to create or refresh a project-level `README.md`. The Engineer enters Deliver before the first edit and keeps the documentation plan proportional to the change. Read-only README questions stay in Answer or Investigate.

## When to Use

Activate when the user wants to:
- Create a new project `README.md`
- Update an existing README so it reflects the current repository
- Capture project overview, standards, conventions, workflows, components, data model, and integration points
- Prepare onboarding documentation for a development team

## Trigger Examples

**Should trigger:**
- "Create a README for this project"
- "Update README.md with the current architecture and conventions"
- "Document our components, workflows, data, and integrations"

**Should not trigger:**
- "What does this repo do?" -> use @engineer Answer mode for quick Q&A
- "Generate a plan for this feature" -> ask @engineer to plan it
- "Document a solved bug" -> use the compound-learnings skill

## Inputs and Outputs

**Inputs:** Existing README content if present, repository files, build/test config, docs, package manifests, source layout, and user-provided positioning.

**Outputs:** Created or updated project-level `README.md`, plus a short summary of evidence used and sections changed.

## Workflow

### 1. Determine README Scope

Identify the target README path:
- Default to repository root `README.md`
- If the user provides another path, use it explicitly
- If multiple project roots exist, ask which project README to update

### 2. Gather Repository Evidence

Use `ae report --facts --json` for generated inventory, declared/resolved versions, check configuration and declared graphs. Read `<copilot-home>/skills/references/factual-context.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/references/factual-context.md --json` prints the same file. Retrieve sources for missing or unsupported parsers. Read high-signal files before editing:
- Existing `README.md`
- `AGENTS.md`, `.github/copilot-instructions.md`, `.harness/agent-context.md` or `docs/agent-context.md`, and `docs/codebase-snapshot.md` when present
- Build and dependency manifests (`package.json`, `pyproject.toml`, `pom.xml`, `build.gradle`, `requirements.txt`, `go.mod`, etc.)
- Configuration files that reveal runtime, deployment, data stores, queues, or integrations
- Source tree entry points and docs under `docs/`

Do not invent missing architecture. Mark unknowns as gaps or ask the user.

### 3. Build the README Outline

Use these sections unless the existing README already has a stronger structure:

```markdown
# <Project Name>

## Overview
## Quick Start
## Development Workflow
## Architecture
## Components
## Data and Persistence
## External Integrations
## Standards and Conventions
## Testing and Verification
## Operations
## Repository Map
```

Section expectations:
- **Overview:** What the project does, who uses it, and why it exists.
- **Quick Start:** Minimal local setup, run, test, and common commands.
- **Development Workflow:** Branching, issue/plan workflow, review flow, and release notes if known.
- **Architecture:** High-level shape, major boundaries, request/event/data flow.
- **Components:** Important modules/services/packages and their responsibilities.
- **Data and Persistence:** Databases, schemas, queues, caches, object storage, migrations, and ownership.
- **External Integrations:** Incoming and outgoing APIs, webhooks, events, cloud services, auth providers, SDKs.
- **Standards and Conventions:** Languages, formatting, testing, security, dependency, and documentation conventions.
- **Testing and Verification:** Test commands and what each proves.
- **Operations:** Environment variables, deployment, monitoring, logs, alerts, background jobs, and runbooks if present.
- **Repository Map:** Directory structure with short descriptions.

### 4. Edit README

Reuse the current plan when its scope already includes the README. Otherwise use the ensure-plan skill with a concise full creation decision (`type: docs`), one phase, the README path, evidence-based acceptance criteria, and an inspected trusted documentation check. Full docs plans may have no required code review; retain any reviews required by the accepted plan or policy. A short plan retains its code-review requirement. Do not widen scope to code, configuration, or unrelated workflows.

Submit a start decision and require its successful implement gate before editing. A missing adequate named check remains a verification gap; do not invent a check or claim completion.

Preserve useful existing content. Remove stale or contradictory sections only when replacement content is evidence-backed.

### 5. Verification

Before finishing:
- Re-read the README and check that all links and paths are plausible
- Confirm no claims lack source evidence or user input
- Confirm project workflows and conventions match the repo artifacts
- Confirm incoming and outgoing integration points are called out when evidence exists

Record accepted progress through Harness. Collect any required review, require passed `ae verify`, record durable learning or explicit no-learning through `ae compound --learning-decision -` (the decision piped on stdin), then submit a complete decision. A README edit uses the same evidence and completion authority as other file changes.

## Non-Interactive Mode

When invoked by another skill, use its accepted Deliver plan and gate, update `README.md` using available evidence, add an `Open Questions` section for unknowns, and return changed sections and focused check results to the Engineer. The Engineer owns authoritative verification and completion.

## Error Handling

- **No clear project root** -> Ask which README path to update.
- **Sparse repository evidence** -> Create a minimal README with an `Open Questions` section instead of inventing details.
- **Existing README is large** -> Preserve structure, update stale sections, and avoid a full rewrite unless requested.
- **Conflicting evidence** -> Note the conflict and ask the user before choosing one source.

## Guardrails

- Keep documentation planning concise and reuse the existing work identity when its scope fits.
- Do not change code, configs, or workflows while updating README.
- Do not expose secrets or private credentials.
- Keep README practical for developers who need to build, run, understand, and safely change the project.
