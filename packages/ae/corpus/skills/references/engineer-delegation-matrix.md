# Engineer Delegation Matrix

Load when delegating from `@engineer`. Read `<copilot-home>/skills/references/subagent-context-packet.md` with the host read tool for every delegation. Outside the enforce hook, `ae get --reference skills/references/subagent-context-packet.md --json` prints the same file.

## Team Size

Default to **3-5 active agents per workstream**, including the orchestrator/planner, executor, and reviewers or researchers. Use more specialists only by batching them and recording the reason in the plan `## Agent Journal` or `## Activity`.

Read the matching role line in `~/.cursor/rules/ae-models.mdc` or `~/.claude/rules/ae-models.md`. Pass that model when the host spawn tool takes one. A missing file, a missing line, or `inherit` means omit the model. `engineer` is the orchestrator. `specialist` is `code-implementer` and `bug-reproduction-validator`. `researcher` is `repo-research-analyst`, `best-practices-researcher`, `framework-docs-researcher`, and `git-history-analyzer`. `reviewer` is a review specialist. `decision` is the read-only native `decision-agent`; prefer an effectively available small host model and report inheritance when unsupported.

The names below are shipped examples, not required dependencies. Resolve the necessary perspective from eligible shipped, user, or enterprise catalog sources, preserve its source binding and minimum authority, and follow `/ensure-capability` when no usable specialist exists. Do not substitute self-review for required independence.

| Situation | Delegate to | Include in task prompt |
|-----------|-------------|------------------------|
| Implementation tasks | `code-implementer` | Task, files + code excerpts, patterns, tests, constraints |
| Codebase patterns | `repo-research-analyst` | Feature, paths, questions |
| Unfamiliar technology | `best-practices-researcher` | Technology, goal, constraints |
| Framework APIs | `framework-docs-researcher` | Framework + version, API, need |
| Security-sensitive changes | `security-sentinel` | Diffs, behavior, threat model |
| Performance-critical code | `performance-oracle` | Files, load/volume, requirements |
| Architecture decisions | `architecture-strategist` | Design, alternatives, context |
| Java review | `java-reviewer` | Java files, conventions, tests, risks |
| Python review | `python-reviewer` | Python files, version, tests, risks |
| SQL/data review | `sql-reviewer` | SQL/schema/migration, volume, rollback |
| AWS review | `aws-reviewer` | Services, IAM/config, reliability |
| Bug reproduction | `bug-reproduction-validator` | Report, steps, environment |
| Code history | `git-history-analyzer` | Paths, history questions |
| Full code review | `code-review-coordinator` | Changed files, PR context, project type |
| One required reviewer | that specialist, including `code-simplicity-reviewer` and `pattern-recognition-specialist` | Packet, persona, findings schema |
| Bounded action/capability/memory/readiness decision | `decision-agent` | Exact prepared packet, authority revision, source bindings, budgets |
| Splunk / SPL validation (enterprise) | `splunk-reviewer` | Index, query, expected signal |
| Terraform / IaC review (enterprise) | `terraform-reviewer` | Modules, plan output, conventions |

Coordinators: use `tools: ['agent']`, parallel batches of 3–4, aggregate between batches.

Enterprise agents require consented eligible source discovery and actual host availability. Native delegation declarations remain host-enforced; a catalog entry cannot widen them. Use recorded direct or scoped standing authorization for necessary projection updates, preserving pending-reload status until invocation is observed.
