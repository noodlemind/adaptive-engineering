# Enterprise Capability Overlay

Optional company registry. Install copies this folder to `~/.copilot/enterprise/`. Skills, agents, and instructions that routing loads stay in the corpus trees named below.

## Purpose

| Layer | Examples | Hydrated to |
|-------|----------|-------------|
| **AE corpus (base)** | java and aws skills, `@aws-reviewer` | `~/.copilot/` |
| **Enterprise (this folder)** | company registry, corp logging rules | `~/.copilot/enterprise/` (via `ae install`) |

`@engineer` reads the enterprise registry next to the base registry. Routing loads skills, agents, and instructions from `~/.copilot/skills`, `~/.copilot/agents`, `~/.copilot/instructions`, and the same three directories under `packages/ae/corpus/`.

## Layout

```text
packages/ae/corpus/enterprise/
  README.md
  capability-registry.enterprise.yaml
  capability-gaps/
  knowledge/
    solutions/
```

A skill for every install is a commit under `packages/ae/corpus/skills/<name>/SKILL.md`. An agent for every install is `packages/ae/corpus/agents/<name>.agent.md`. An instruction for every install is `packages/ae/corpus/instructions/<name>.instructions.md`. A personal primitive is `ae resources create <skill|agent|instruction> <name>` with the body on stdin.

## Adding a specialist (e.g. Splunk expert)

1. Add `packages/ae/corpus/agents/splunk-reviewer.agent.md` (judgment-criteria reviewer).
2. Register in `capability-registry.enterprise.yaml`.
3. Add `splunk-reviewer` to `engineer.agent.md` frontmatter `agents:` in the **enterprise-maintained** patch or central platform PR (Tier 3 once).
4. `ae upgrade`.
5. Engineer auto-delegates when tasks mention Splunk/SPL.

## Adding a domain skill (e.g. Terraform)

1. Run the import-conventions skill on your Terraform standards repo **or** add `packages/ae/corpus/skills/terraform/SKILL.md`.
2. Register in `capability-registry.enterprise.yaml`.
3. `ae upgrade` — engineer routes `.tf` work without a terraform slash command.

## Not the same as knowledge

- **Skill/agent** = how to work (procedure, review criteria).
- **Knowledge** = what we learned. Recall reads `~/.copilot/knowledge/solutions/`. Read `<copilot-home>/knowledge/solutions/<file>.md` with the host read tool. Outside the enforce hook, `ae get --reference knowledge/solutions/<file>.md --json` prints the same file. Do not search the product workspace for it.

Capability lifecycle and approval remain governed by `packages/ae/corpus/knowledge/capability-registry.yaml` and `/create-primitive`. Read `<copilot-home>/skills/references/capability-gap-proposal.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/references/capability-gap-proposal.md --json` prints the same file.
