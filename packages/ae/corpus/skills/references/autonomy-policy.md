# Autonomy Policy

Default: **run the pipeline autonomously**. Human consent is for **Tier 3** only.

Profiles install as knowledge/profile.md from this template. Read `<copilot-home>/knowledge/profile.md.template` with the host read tool. Outside the enforce hook, `ae get --reference knowledge/profile.md.template --json` prints the same file. Do not search the product workspace for it:

```yaml
autonomy: full   # full | balanced | strict
```

| Profile | Tier 0 (auto) | Tier 1 (notify) | Tier 2 (soft) | Tier 3 (block) |
|---------|---------------|-----------------|---------------|----------------|
| **full** | All green + amber | Same | Enabled | uncovered red or primitive authority |
| **balanced** | green | amber + compound | limited | same as full Tier 3 |
| **strict** | Answer mode + direct TDD fixes only | — | — | capture, plan, implement, primitives |

## Tier 0 — Autonomous (no ask)

`@engineer` and internal pipeline skills **must** run without user approval:

- **Recall** — top-3 manifest + plan memory cards (`context-budget.md`)
- **Ensure plan** — create `docs/plans/*.md` via capture rules if missing
- **Auto-plan** — lock plan when trackable and `risk: green|amber`
- **Implement** — within `## Impacted Files`
- **Verify** — tests and verification plan
- **Compound + index** — on verified success (tests reported, criteria met)
- **Memory cards** — append with `source:`

Do **not** tell the user to “run `/capture-issue`” — execute capture/plan logic yourself or invoke the skill internally.

## Tier 1 — Notify (proceed + Activity log)

Proceed and append `## Activity`:

- Autonomous plan created (path, risk tier)
- Global solution published (`knowledge/solutions/…`)
- Specialist review delegated and summarized
- Minor scope drift (one extra file) with justification

## Tier 2 — Soft consent (balanced + non-interactive only)

May proceed if user unavailable; log assumption in Activity:

- Amber plan amendment without scope expansion
- Default fix strategy when tests already reproduce failure

Never use Tier 2 for Tier 3 topics.

## Tier 3 — Hard consent (block)

The gates and approval interpretation are defined only in [Human Approval Policy](human-approval-policy.md). That policy is authoritative for primitives, scope expansion, data/security/concurrency changes, and destructive actions. Honor authorization already supplied by the user and record its scope; do not ask for the same decision again.

### Primitives

| Change | Autonomous? |
|--------|-------------|
| Solution + manifest + memory cards | Yes (Tier 0) |
| Review check from repeated pattern | Draft proposal; activate under Human Approval Policy |
| New skill from approved proposal | Yes if proposal approved |
| New skill/agent without a scoped proposal | Draft the boundary and evidence before activation |
| First-needed specialist | Yes within recorded direct or scoped standing authorization, creator validation, and observed host availability |

Capability-gap proposals may be drafted on first need for separate judgment, independence, isolation, or tool authority. Repetition is a durable-skill promotion signal, not a specialist prerequisite. Creation or activation follows Human Approval Policy for every primitive type. The native decision-agent judges an exact covered action and readiness; it cannot supply missing user consent. Record standing grants once, apply their current revision, and stop further autonomous actions when revoked.

## Risk tier (plan frontmatter)

```yaml
risk: green   # green | amber | red
```

| risk | Auto-plan | Auto-implement |
|------|-----------|----------------|
| green | yes | yes |
| amber | yes | yes + Tier 1 notify on sensitive files |
| red | plan draft yes; lock/implement Tier 3 | Tier 3 |

Engineer sets `risk` at intake from signals (schema, auth, prod, payments → red; test fix → green).

## Composer alignment

- **One loop** — engineer owns Tier 0 chain end-to-end
- **Memory automatic** — compound/index not user commands
- **Consent on red** — not on every step
