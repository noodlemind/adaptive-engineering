# Creator Workflow

Read this reference in full before governed primitive changes. Read `<copilot-home>/skills/create-primitive/SKILL.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/create-primitive/SKILL.md --json` prints the same file. That skill defines activation and authority.

## Pipeline Role

Canonical primitive creator and maintainer for the harness. Use it to keep the corpus skill-driven. Harness owns deterministic reusable operations, skills hold contextual judgment protocols, agents hold isolated roles, instructions hold scoped conventions, checks hold narrow review criteria, references hold dense supporting material, and solution docs hold verified learnings.

## When to Use

- A personal agent, skill, or instruction is created only by `ae resources create <skill|agent|instruction> <name>` with a schema1 decision file via `--file`. The command writes under the Copilot home.
- A skill for every install is a commit under `packages/ae/corpus/skills/<name>/SKILL.md`. Agents use `packages/ae/corpus/agents/<name>.agent.md`. Instructions use `packages/ae/corpus/instructions/<name>.instructions.md`.
- Creating a new review check (bundled under `packages/ae/corpus/skills/code-review/references/checks/*.md` or product-owned `.github/checks/*.md`)
- Creating or moving dense supporting material into skill `references/` or `assets/`
- Creating or updating a machine-local solution under `<copilot-home>/knowledge/solutions/` (kept across upgrade; the home defaults to `~/.copilot`, and `--copilot-home`, `COPILOT_HOME`, or an existing `$XDG_CONFIG_HOME/copilot` directory replaces it; `--ae-home` does not), a product solution under `~/.ae/projects/<repo-id>/docs/solutions/` or committed `docs/solutions/`, or a release solution under `packages/ae/corpus/knowledge/solutions/`
- Modifying any skill, agent, instruction, check, reference, or solution doc
- Understanding which primitive type should exist

## Trigger Examples

**Should trigger:**
- "Create a new agent"
- "Build a new skill"
- "Add a Java instruction file"
- "Add a review check for Sonar complexity issues"
- "Where should this new convention live?"
- "How do I write a skill, agent, or instruction?"

**Should not trigger:**
- "Import conventions from a repo" → use /import-conventions
- "Review my code" → use /code-review
- "Plan a feature" → use /plan-issue

## Primitive Decision Rules

Put deterministic reusable operations in Harness. Use a **skill** for a contextual judgment protocol. Do not create any artifact before classifying the primitive:

| Question | If yes, create |
|---|---|
| Is this a reusable deterministic operation? | Harness CLI |
| Is this a contextual judgment protocol or reviewer workflow? | Skill |
| Does it need separate judgment, tool authority, isolation, runtime profile, or accountability? | Agent |
| Should it load automatically for matching file patterns? | Instruction |
| Is it a narrow review-time rule? | Review check |
| Is it dense examples, schema, checklist detail, or a template used only by one skill? | Reference or asset under the owning skill |
| Is it a verified learning from completed work? | Solution doc |

Do not create a new agent just to store reference material. Put long criteria in `references/`, team conventions in scoped instructions, bundled review rules under the owning skill's references, and product-specific review rules in product `.github/checks/`.

### Host Mapping

The harness corpus is host-neutral source material. The current primary consumption target is GitHub Copilot in VS Code and IntelliJ IDEA.

| Primitive | Host-native status |
|---|---|
| Agent | Native in VS Code Copilot custom agents; native in current JetBrains Copilot custom agents when global customizations are enabled |
| Skill | Native in Copilot Agent Skills where available; hydrated globally for both VS Code and IntelliJ IDEA |
| Instruction | Native as Copilot custom instructions / instruction files |
| Review check | Shipped with the harness; consumed by `/code-review`, not a universal Copilot primitive |
| Reference/asset | Shipped with the harness as progressive disclosure material |
| Solution doc | Product-repo knowledge artifact, not a global prompt customization |

Do not claim feature parity across hosts. When a host lacks a primitive, document the fallback behavior.

## Creator Workflow

Ship-set edits under `packages/ae/corpus/skills/`, `packages/ae/corpus/agents/`, `packages/ae/corpus/instructions/`, `packages/ae/corpus/enterprise/`, `.github/checks/`, or `packages/ae/corpus/knowledge/capability-registry.yaml` are governed primitive work. `.github/prompts/` stays retired, and reintroduction requires this governance. A personal skill, agent, or instruction is created only by `ae resources create <skill|agent|instruction> <name>` with a schema1 decision file via `--file`, writing under the Copilot home. Do not plan an edit of the product repo or this checkout for a personal primitive. Before a ship-set edit, use this sequence: classify primitive → check overlap → decide minimal artifact structure → record the change rationale and, before creating or substantially expanding a skill, promotion evidence → create or reuse a plan → gate → edit → run primitive verification → report evidence.

Activation means this `SKILL.md` was actually loaded in the current chat session. Do not claim activation by only adding `create-primitive` to `skills_used`.

For a Java/Spring/AWS migration request, explicitly compare: Existing /java skill; Existing /aws skill; Reference under /java; Reference under /aws; New cross-domain migration skill. Select the smallest justified reusable option. Dense migration guidance belongs in a reference rather than bloating `SKILL.md`.

Inspect both repository-owned capabilities and, when those installed paths exist, read `<copilot-home>/skills/java/SKILL.md` and `<copilot-home>/skills/aws/SKILL.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/java/SKILL.md --json` and `ae get --reference skills/aws/SKILL.md --json` print the same files. State what was inspected and why reuse, a reference, or a new cross-domain skill is the smallest justified choice before editing.

Before writing files:

1. **Classify the primitive** using the decision rules above.
2. **Check for overlap** in `<copilot-home>/skills/`, `<copilot-home>/agents/`, `<copilot-home>/instructions/`, skill `references/`, `<copilot-home>/knowledge/solutions/`, optional product `.github/checks/`, and product `docs/solutions/`. The home defaults to `~/.copilot`. The home rule is in `knowledge-locations.md`.
3. **State the decision** before editing: "This should be a [primitive] because [boundary]."
4. **Define triggers and negative triggers** for discovery when the primitive is user/model selectable.
5. **Declare permissions/tool needs** using the smallest sufficient tool set.
6. **Define outputs and verification**: generated files, state changes, review criteria, or acceptance checks.
7. **Add eval scenarios**: for promoted or core/confusable skills, add 8–10 should-trigger prompts, 8–10 should-not/confusable prompts, outcome assertions, and supported-host coverage. Checks and instructions need good/bad examples.
8. **Update docs** listed in the validation checklist.
9. **Update growth inventory** when adding a skill or agent to the ship set:
   - Add the named entry to the version 2 `capabilities` mapping in `packages/ae/corpus/knowledge/capability-registry.yaml`, with its type, lifecycle status, owner, version, origin, and applicable trigger and eval evidence. Do not use the retired `starter_skills` or `starter_agents` inventories.
   - If new agent is delegatable from `@engineer`, add to `engineer_allowlist` and `engineer.agent.md` frontmatter `agents:` (human-approved).

Before the first full `ae verify`, map every acceptance criterion to trusted checks from the selected configuration source reported by `ae checks list --json`, complete only the tasks and criteria actually proven, and include `prompt-contracts` and `host-contracts` when those standard primitive checks are configured. Inspect candidate commands/assertions: a specialized check for another output (such as `schema-validation` with no schema artifact) is forbidden. In a product repo where standard primitive checks are absent, use only the generic or strongest relevant local named check and state that the harness contract checks are not present. Do not invent check names, run unrelated optional checks, repair their failures, widen scope for them, or fake registry updates.

## Capability Expansion Mode

When invoked because `@engineer` or another skill found a missing capability, read `<copilot-home>/skills/references/capability-gap-proposal.md` with the host read tool before creating or substantially changing primitives. Outside the enforce hook, `ae get --reference skills/references/capability-gap-proposal.md --json` prints the same file. Follow the steps in that template's `## Usage Workflow`.

Do not create primitives in non-interactive mode unless prior human approval is already recorded.

### Promotion evidence

Before creating or substantially expanding a skill, record the verified real-task evidence and satisfy at least one criterion:

- the procedure has succeeded more than once;
- the organization has strategically adopted the technology;
- multiple repositories need the workflow;
- the procedure is high-risk and benefits from standardization; or
- the procedure has fragile steps models repeatedly miss.

The evidence record must link passed verification artifacts, prior uses or strategic adoption, overlap analysis, an owner, proposed lifecycle state, a trigger eval suite, and an outcome eval suite. One unfamiliar API, a simple one-off task, adequate upstream documentation, or duplication of an existing skill is insufficient promotion evidence.

Primitive creation remains separate from learning classification. `/auto-compound` may recommend a candidate but must not create it.

#### Learning-sourced evidence

When the evidence for the promotion originates from the knowledge layer rather than ad hoc observation:

1. Find candidates via `ae consolidate --status --json` (`promotionCandidates`) or `ae learnings --json` (`promotionEligible`).
2. Pull the full claim and provenance for one candidate via `ae learnings --why <id> --json`.
3. Use that evidence in the promotion evidence record above, then create the primitive and open its PR through the normal creator workflow.
4. Only after the primitive's PR merges, record the promotion: `ae learning promote <id> --to <path>`. This leaves the learning's `status` untouched and stamps only `promoted_to`, which retires it from ranking, cap counts, and future promotion candidates.

Promotion is never automatic — the CLI only records history after a human has merged the PR; it never creates or approves the primitive itself.

## Primitive Creation Paths

### Skill

Use for contextual judgment protocols and reviewer workflows. Deterministic generators belong in Harness. Read `skill-template.md`.

A personal skill is `ae resources create skill <name>` with a schema1 decision file via `--file`.

A skill for every install:
- `packages/ae/corpus/skills/<name>/SKILL.md`

### Agent

Use only for separate judgment, authority, isolation, runtime profile, or accountability. Read `agent-template.md`.

A personal agent is `ae resources create agent <name>` with a schema1 decision file via `--file`.

A ship-set agent:
- `packages/ae/corpus/agents/<name>.agent.md`

### Instruction

Use for concise standards that should load by file pattern, such as language conventions, framework conventions, or quality standards.

Read `instruction-template.md`.

A personal instruction is `ae resources create instruction <name>` with a schema1 decision file via `--file`.

A ship-set instruction:
- `packages/ae/corpus/instructions/<name>.instructions.md`

### Review Check

Use for narrow review-time criteria that `/code-review` discovers, such as complexity budgets, Sonar maintainability concerns, logging standards, or API versioning rules.

Read `check-template.md`.

Required file:
- `packages/ae/corpus/skills/code-review/references/checks/<name>.md` for checks shipped with the harness
- `.github/checks/<name>.md` only for product-repo overlays

### Reference or Asset

Use when an existing skill needs dense criteria, templates, schemas, or examples without bloating `SKILL.md`.

For a product verification recipe or feature-map audit, read [product-verification.md](product-verification.md). Reuse the selected recipe directory. Create a recipe only as scoped Deliver work after its plan and implement gate pass.

Required location:
- `packages/ae/corpus/skills/<skill>/references/<name>.md` for readable supporting material in the ship set
- `packages/ae/corpus/skills/<skill>/assets/<name>` for templates or output resources in the ship set

### Solution Doc

Use only for verified learnings from completed work. Prefer `/compound-learnings` when the learning came from a pipeline issue.

Required locations:
- **This machine:** `<copilot-home>/knowledge/solutions/<category>/<slug>.md` (upgrade keeps this prefix). The home defaults to `~/.copilot`. `--copilot-home` or `COPILOT_HOME` replaces it. An existing `$XDG_CONFIG_HOME/copilot` directory is the home when neither is set. `--ae-home` does not move it.
- **This product:** `~/.ae/projects/<repo-id>/docs/solutions/<category>/<slug>.md`, or committed `docs/solutions/` when that directory is git-tracked
- **Next harness release:** `packages/ae/corpus/knowledge/solutions/<category>/<slug>.md`

## Detailed creation paths

For per-type creation detail — agent classifications and templates, skill patterns, cross-tool frontmatter, token budgets, review-check, and instruction creation — read `creation-details.md` on demand.

## Validation

Delegate mechanical checks, scaffolding and generated inventory to Harness. Read `<copilot-home>/skills/references/resource-operations.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/references/resource-operations.md --json` prints the same file. Use the versioned creation input for metadata, reference and permission checks; use `resources validate --corpus` for ship-set edits. Registry and delegation drift are diagnosed from source declarations. Do not maintain inventory counts by hand.

Judge description usefulness, artifact boundary, overlap, evaluation adequacy and minimum authority from evidence. A passing structural validator does not establish that a capability is useful. Read `<copilot-home>/skills/references/human-approval-policy.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/references/human-approval-policy.md --json` prints the same file. Use it for activation; existing direct authorization covers necessary work within its scope.
