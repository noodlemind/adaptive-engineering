# Capability Gap Proposal: `/consolidate` skill

Read `<copilot-home>/skills/references/capability-gap-proposal.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/references/capability-gap-proposal.md --json` prints the same file. This is the approval artifact for the `consolidate` capability activated in the knowledge-layer delivery (PR #37). The registry entry is `<copilot-home>/knowledge/capability-registry.yaml`, read with the host read tool. Outside the enforce hook, `ae get --reference knowledge/capability-registry.yaml --json` prints the same file (`capabilities.consolidate.proposal`).

## Summary

- **Requested outcome:** Drain accumulated learning-episode debt into the T2 learnings store on a governed schedule, per `docs/adaptive-engineering.md`.
- **Observed gap:** The knowledge layer shipped the deterministic half of the consolidation loop as CLI commands (`ae consolidate --status | --candidates | --apply`), but the model half — reading the work packet, deciding one `ADD`/`STRENGTHEN`/`SUPERSEDE`/`MERGE`/`NOOP` op per episode cluster, writing the ops JSON, and honoring the mode gate — had no invocable primitive.
- **Why existing capabilities are insufficient:** `/auto-compound` and `compound --insight` capture episodes but never cluster them; `/compound-learnings` publishes solution docs; `/index-memory` rebuilds the BM25 manifest over solution docs and does not touch the learnings store; `/harness-doctor` diagnoses without writing. No surviving skill produces consolidation ops.
- **User impact if not addressed:** Episode debt accumulates unconsolidated; `orient` cannot inject condensed learnings, and the `due: true` drain signal from `ae consolidate --status` has no responder.

## Trigger Evidence

```text
Session-end: /auto-compound persists a learning, then `ae consolidate --status --json`
reports `due: true` with no skill to run the drain.
Session-start: @engineer orient reads a `consolidate --candidates` next-hint in the context
pack with no skill to route it to.
Direct ask: a human requests "run the knowledge consolidation loop now."
```

## Existing Primitive Check

| Area checked | Relevant existing artifact | Reuse or gap decision |
|---|---|---|
| Skills | `/auto-compound`, `/compound-learnings`, `/index-memory`, `/recall` | Gap — all capture, publish, or index episodes/solution docs; none clusters episodes into learnings-store ops. |
| Agents | `engineer`, `code-implementer` | Reuse — the Engineer invokes the skill; no separate judgment standard or tool authority warrants a new agent. |
| Instructions | `~/.copilot/instructions/*` | Reuse — no file-scoped convention involved. |
| Prompt wrappers | Retired | N/A. |
| Review checks | `capability-expansion-quality.md` | Reuse — governs this proposal itself. |
| References/assets | `harness-tool-contract.md`, `error-handling-patterns.md` | Reuse — the skill links both. |
| Solution docs | `docs/solutions/`, `knowledge/solutions/` | Reuse — they are the T1 input, not the workflow. |

## Proposed Primitive

- **Primitive type:** Skill
- **Proposed name/path:** `packages/ae/corpus/skills/consolidate/SKILL.md` (engineer-internal, `user-invocable: false`)
- **Boundary reason:** A repeatable procedure (read packet → decide ops → write ops file → mode-gated apply) with no distinct judgment standard, tool authority, or isolation need — skill-first boundaries route it to a skill, not an agent.
- **Expected users:** `@engineer` (via `/auto-compound` session-end drain and orient session-start hint); humans by explicit request.
- **Required tool authority:** Read-only plus writing `.harness/consolidate-ops.json` and invoking `ae consolidate`; `ae consolidate --apply` remains the sole writer of learning content.

## Behavior Contract

- **Should trigger when:** `consolidate --status` reports `due: true` after a persisted learning; orient surfaces a `consolidate --candidates` next-hint; a human explicitly asks to run the consolidation loop.
- **Should not trigger when:** an episode is being captured (`ae compound` lanes own that); a human hand-edits a learning file directly (a supported store-absorbed path, not a consolidation trigger); `due: false` and no human asked.
- **Inputs:** `ae consolidate --candidates --json` work packet (clusters, active learnings, domain caps, governed ids).
- **Outputs:** `.harness/consolidate-ops.json` (`{ "schema": 1, "ops": [...] }`); applied ledger line or reviewable diff depending on mode.
- **State changes:** The skill writes only the ops file; the learnings store changes only through `ae consolidate --apply` (byte cap, delta contract, secret scan, imperative lint, governance reapplication enforced there).
- **Verification evidence:** Trigger/outcome evals at `evals/skill-trigger-evals.yaml#consolidate`; apply-boundary behavior covered by `packages/ae/test/consolidate*.test.mjs`, `domain-cap-merge.test.mjs`, and the harness contract tests under `packages/ae/test/`.
- **Failure handling:** Per-code fix-and-retry once (`E_SCHEMA`, `E_BYTE_CAP`, `E_DELTA_CONTRACT`, `E_LINT`), then quarantine; shared patterns are in `<copilot-home>/skills/references/error-handling-patterns.md`, read with the host read tool. Outside the enforce hook, `ae get --reference skills/references/error-handling-patterns.md --json` prints the same file. Mode gate stops `--apply` outside `on`/approved `suggest`.

## Risks

- **Safety risks:** Unapproved writes in `suggest`/`off`/`freeze`/`capture-only` — mitigated by the authoritative mode gate and `E_MODE` in apply.
- **Security/data risks:** Secret-shaped content reaching the store — mitigated by apply's secret scan (`E_SECRET`) and the imperative lint.
- **Cost/request risks:** Unbounded drains — mitigated by the bounded work packet (`truncated`/`remaining`) and the ≤5-file delta contract per run.
- **Misrouting risks:** Confusion with `/auto-compound` (episode capture) or `/index-memory` (manifest) — mitigated by explicit Confusable Boundaries and should-not-trigger evals.
- **Maintenance risks:** Skill prose drifting from `apply.mjs` semantics — mitigated by contract tests pinning the CLI surface and review checks on skill changes.

## Validation Coverage

| Validation item | Priority | Expected behavior |
|---|---|---|
| `/auto-compound` sees `due: true` after persisting a learning | P1 | Activates `/consolidate` (session-end drain). |
| Orient context pack carries a `consolidate --candidates` next-hint | P1 | Activates `/consolidate` (session-start drain). |
| Human asks to run the knowledge consolidation loop now | P1 | Activates `/consolidate`. |
| "Record this fix as a learning" | P1 | Does not activate; routes to `ae compound` capture lanes. |
| "Edit this learning file directly" | P2 | Does not activate; hand edits are a store-absorbed human path, not a consolidation trigger. |
| `consolidate --status` reports `due: false`, no human ask | P2 | Does not activate. |
| Apply rejects (`E_DOMAIN_CAP`, `E_LINT`, `E_MODE`, `E_DISPUTED`) | P1 | Skill follows its retry/stop table; never writes the store directly. |

## Human Decision

- **Decision:** Approved
- **Reviewer:** repository owner
- **Date:** 2026-07-30
- **Conditions or required edits:** Approval recorded via the owner's directed milestone review of the knowledge-layer delivery (PR #37). Skill stays engineer-internal (`user-invocable: false`); `ae consolidate --apply` remains the sole writer of learning content; trigger evals at `evals/skill-trigger-evals.yaml#consolidate` stay current with the skill.
