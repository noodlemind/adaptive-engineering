---
name: Harness Global Workflow
description: Global Engineer Harness workflow guidance for GitHub Copilot users.
applyTo: "**"
---

# Harness Global Workflow

Use the hydrated skills, agents, and instructions as the default engineering workflow.

## Entry Points

- **`@engineer`** is the single entry point: its mode selection (Answer / Investigate / Review / Deliver) routes the work. Answer mode handles quick repository or general questions without ceremony; Investigate is read-only diagnosis; Deliver owns delivery from proportional orientation through deterministic verification and learning. **Do not** ask users to run internal pipeline steps manually.
- Power-user pipeline (debugging only): capture-issue, then plan-issue, then `@engineer` Deliver mode, then the code-review skill, then compound-learnings. Those steps are engineer-internal, not slash commands.
- Use `/project-readme` for project-level README creation or refresh.
- java, python, sql, and aws are engineer-internal skills. Ask `@engineer`.
- Use `/harness-doctor` when harness or `@engineer` misbehaves.

## Harness CLI (agents)

After `ae install`, use the **global** command from any repo:

```bash
ae orient --query "..." --workspace . --json
```

Not on PATH? `node ~/.copilot/bin/ae …` or `ae install --configure-path`.

## Operating Rules

- Use host-native creation and edit tools for product files under Default/Manual Permissions. Existing task authorization needs no extra prose approval; native host approval remains binding. For a missing tool, approval request, or worktree access issue, read `<copilot-home>/skills/references/tool-native-loop.md` with the host read tool.
- Keep skills, agents, and instructions in the user profile. Do not copy the harness corpus into product repositories.
- Product repositories may still receive work artifacts such as `docs/plans/`, `docs/solutions/`, and README changes when a skill intentionally creates them.
- Skills are on-demand procedures. Load one when its trigger matches the work; do not bulk-read the catalog at session start.
- Before planning or editing a skill, agent, instruction, check, or reference, read `<copilot-home>/skills/create-primitive/SKILL.md` with the host read tool; merely naming the skill in plan metadata does not activate it. Outside the enforce hook, `ae get --reference skills/create-primitive/SKILL.md --json` prints the same file.
- After a missing-gate denial, bootstrap the canonical plan in a standalone plan-only mutation; never batch plan creation with product paths.
- Resolve capability gaps when explicit, high-risk, or encountered. Missing optional capability does not block ordinary work; a safety-critical gap blocks only the affected operation.
- Deliver runs the code-review skill once on the finished diff, not after each task. Fix a finding that names a defect in the spec, and reject one that only adds a helper, option, comment, or check. Before finishing, the diff is the smallest change that meets the spec. Then require passed `ae verify`. Update plans with `ae plan-update`. Do not edit a `~/.ae` plan in the editor. Read-only answers and investigations report supporting evidence without plan or completion ceremony.
- Investigate never calls `plan-new` or `ensure-plan`, even for a large codebase or several repos. Start with a short list of questions. Record findings with file:line refs as you go, in chat or one notes file if long. Split a large scope by repo or area across parallel researchers, one narrow question each. Read the `researcher` line in `~/.cursor/rules/ae-models.mdc` or `~/.claude/rules/ae-models.md`. Pass that model when the host spawn tool takes one. A missing file, a missing line, or `inherit` means omit the model. A plan starts only when the user asks for a change, which switches to Deliver. Include another repository only when the task names it or a demonstrated dependency requires it. A saved editor folder list does not establish task relevance or require delegation. Plans stay on the bound repo.
- Run only checks named by the active plan; report unrelated failures without repairing them or widening scope.
- When `@engineer` is active, obey the task-mode contract in `engineer.agent.md` and name the mode first.
- Preserve project-specific conventions when they conflict with global defaults.
