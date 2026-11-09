# AE agent memory: implementation, testing and delivery plan

Date: November 7, 2026, revised November 9, 2026. Owner: AE maintainers. Status: accepted for implementation. Phase 1's recording mechanics are being implemented first (see Sequencing).

**Revision, November 9.** Three review points are addressed:
1. The promotion rule now compares each incremental arm against the arm it extends, not against `stateless` (see Phase 0, Promotion rule).
2. Both new keys use one state ladder, `off|suggest|on`, with the same meaning everywhere, including rollout (see Configuration states).
3. Each eval series pins a stable repository identity, because a shared harness home alone does not give tasks a shared project store (see Phase 0, Repository identity).

Phase 1 also gains a second feedback source: whether each review finding was fixed or dismissed.

## Goal and authorization

Make AE's learning memory measurably useful across sessions. Today AE captures and protects learnings well. It cannot yet show that recalled learnings improve outcomes. It does not learn from failed work, and it does not check whether a recalled learning was right.

The user asked for "a more formalized implementation plan so that we can do the implementation testing and delivery". This came after an analysis that mapped Anthropic's agent-memory and harness research onto AE.

This document covers the design, phase sequence, test strategy, success metrics, rollout and rollback. It authorizes no change to:
- the knowledge-mode authority model
- promotion governance
- the sole-writer rule

CLI-owned plans keep execution state, gate, review, verification and completion authority for each phase.

## Source research

| Source | Finding used here |
| --- | --- |
| [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory) | **Memory layers:** transcripts → notes → linked representations (wiki) → small injected layer. **Dreaming:** an offline pass that checks notes against transcripts. A note is a prediction that it will matter again. **One writer per entity:** one page per contract with quoted terms kept 57 of 57 facts; a shared table kept 41 of 57. **Wiki plus search:** 61% vs 53% for search alone, with gains only on questions spanning several documents. **Fixed write rules hurt strong models:** Opus 5 lost 0.234 of its memory gain. **Explicit steps help weaker ones:** Sonnet 4.6 rose from 0.364 to 0.641 with reworded instructions. **Gains vary by model.** |
| [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | Each session starts by reading progress and running a baseline check. Agent-flippable state is kept in structured files. Agents declare victory too early. |
| [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) | Every harness component encodes an assumption about what the model can't do. Remove one at a time to find which carry weight. A separate skeptical evaluator beats self-evaluation. |
| [Managed Agents](https://www.anthropic.com/engineering/managed-agents) | The session is a durable, queryable log kept outside the context window. The harness is stateless over that log. |

The article's benchmarks are Pokémon, CL-Bench and corpus question answering, not coding loops. Whether its effects carry over to AE is a hypothesis. Phase 0 tests it before any default changes.

## Baseline

Main when this plan was written: `5184dbc4` (`fix(ae): stabilize upgrades, worktree trust and default-permission tools (#109)`).

### What already matches the research, and must be preserved

| Capability | Location | Research principle |
| --- | --- | --- |
| Sole content writer, ADD/STRENGTHEN/SUPERSEDE/MERGE/NOOP ops, frozen packets, bounded retry | `lib/knowledge/consolidate.mjs`, `lib/knowledge/apply.mjs`, `skills/consolidate/SKILL.md` | One writer per entity; dreaming merges and fixes |
| Learnings tied to file hashes (up to 8 paths with SHA-256); stale learnings excluded from retrieval | `lib/knowledge/applicability.mjs`, `lib/knowledge/retrieve.mjs` | Drift |
| Byte cap, imperative lint, secret scan on learnings | `lib/knowledge/apply.mjs`, `lib/knowledge/store.mjs` | Keep the top layer small; avoid over-recording |
| Explicit `no-learning` decision; promotion requires recurring evidence | `skills/auto-compound/SKILL.md`, `lib/learning-record.mjs` | Avoid over-recording |
| Bounded context pack: claim lines of at most 140 characters, rows dropped under budget | `lib/context-pack.mjs`, `lib/orient.mjs` | Small injected layer, index-style |
| Knowledge modes `on`, `suggest`, `off`, `freeze` (inject, no writes), `capture-only` (write, no inject) | `lib/knowledge/store.mjs:376`, `lib/orientation-facts.mjs:52` | These map directly onto eval arms |
| Insight lane: evidence-free capture | `lib/compound.mjs` (`runInsightCompound`) | In-session notes |
| Repeated-mistake judge | `lib/repeat-mistake.mjs` | Measures whether memory prevents repeats |
| Context study harness: dev and held-out cases, fresh Git workspaces, private checks, live providers, promotion thresholds | `eval/context/study.mjs`, `eval/context/protocol.json` | Comparisons with and without memory |

### Gaps this plan addresses

1. **No evidence that memory improves outcomes.** No eval isolates memory as the variable, and none runs per model.
2. **No record of whether a recall helped.**
   - `lib/orient.mjs` computes `deliveredLearnings`.
   - `lib/events.mjs` emits a `learnings` field in telemetry.
   - The learning decision (`.harness/learning/<op>.json`) never says whether those learnings helped, were irrelevant, or were wrong.
3. **Learning is gated on success.**
   - `/auto-compound` refuses to run on `failed` or `inconclusive`.
   - Failed verifies, review findings and abandoned plans only become learnings if the agent volunteers `--insight`.
4. **Consolidation reads episodes only.**
   - It starts when debt ≥ `CONSOLIDATION_THRESHOLD` (5). See `lib/knowledge/consolidate.mjs:10,231`.
   - It never re-checks active learnings against what happened afterwards.
5. **Skill rules have not been ablated per model.** Judgment skills are procedural, and no measurement shows which rules carry weight.
6. **No linked representation layer.** The store is flat, with BM25 retrieval. This is deferred until the evidence calls for it (Phase 4).

## Invariants (apply to every phase)

1. **No new authority.**
   - Feedback, re-check signals and failure clusters are *evidence for judgment*.
   - They never retire, dispute, promote or publish anything by themselves.
   - `ae learning <retire|dispute|confirm|promote>` and the knowledge-mode gate stay the only routes.
2. **Harness owns the bytes.** The agent writes semantic fields. Harness owns hashes, IDs, caps, indexing and replay. `ae consolidate --apply` stays the sole writer of learning content.
3. **Additive schemas.**
   - New decision and record fields are optional.
   - When they are absent, records must stay byte-identical, so existing digests and replay identities don't change.
   - Readers accept older records.
4. **Harness-owned inputs only.**
   - Re-check reads the run journal, evidence, review records, plan Activity and episodes.
   - It never reads host transcripts. `docs/adaptive-engineering.md:290` says they aren't authenticated.
5. **Measure before changing defaults.**
   - Every behavior change ships behind a config key, defaulting to off or the current behavior.
   - A default flips only when Phase 0 eval results meet the promotion rule.
6. **Deterministic tests don't measure model quality.** `npm test` uses scripted model responses and makes no paid calls. Live runs are diagnostic and recorded separately.
7. **TDD and surgical diffs**, as `AGENTS.md` requires.

## Phases

One PR per phase. Phase 1's recording mechanics may land before Phase 0, because with `knowledge.feedback=off` they only record and nothing reads them. No key moves past `off` until its Phase 0 arm meets the promotion rule. Phase 2 follows Phase 0. Phase 3 depends on Phase 0. Phase 4 is gated on Phase 0 results.

### Configuration states

Every new behavior key in this plan (`knowledge.feedback`, `knowledge.recheck`) takes the same three values. The states form a ladder over who *reads* the new records. Recording is not part of the ladder: Harness bookkeeping such as exposure records is written in every state, because Phase 0 needs it to measure the `off` arm too.

| State | Records written | Consolidation packet and status | `due` and packet ordering | Authority |
| --- | --- | --- | --- | --- |
| `off` (default) | yes | unchanged, byte-identical to main | unchanged | none |
| `suggest` | yes | show the new sections as evidence | unchanged | none |
| `on` | yes | show the new sections as evidence | may also become `due`, and ordering uses the new signals | none |

- No state grants authority. `ae learning <retire|dispute|confirm|promote>` and `ae consolidate --apply` stay the only routes in all three.
- Knowledge modes keep priority. Under knowledge mode `off`, `freeze` or `capture-only`, both keys behave as `off` for reading. Mode `off` also delivers no learnings, so no exposure is recorded.
- Rollout moves one step at a time, `off` → `suggest` → `on`, and rollback is setting `off`. The same words mean the same thing in the rollout section below.
- Unknown values are refused when set and read as `off`.

### Phase 0: memory ablation eval (prerequisite)

**Objective.** Measure whether AE memory improves sequential coding work, per model, and give every later phase a regression signal.

**Design.**

New `eval/memory/`, reusing `eval/context/study.mjs` fixture preparation, private checks, provenance and output-directory rules:

- `cases.json`: task series, each 4–6 ordered tasks on one fixture repo.
  - Each series plants a recurring trap: a non-obvious repo gotcha that first causes a failed private check in task 1, then reappears in a different form in a later task.
  - Example traps: a locale-sensitive sort, a test helper that must be reset, a path API that differs on Windows.
  - Split into development and held-out series, as `eval/context` does.
- `protocol.json`: arms, repeats, budgets, promotion thresholds. The arms:

  | Arm | Knowledge mode | Meaning |
  | --- | --- | --- |
  | `stateless` | `off` | No capture, no recall |
  | `capture-only` | `capture-only` | Learns but never injects; controls for "the act of writing helps" |
  | `recall` | `on` | Full current behavior |
  | `recall+feedback` | `on` + Phase 1 key | Added once Phase 1 lands |
  | `recall+recheck` | `on` + Phase 2 key | Added once Phase 2 lands |
  | `frozen-seed` | `freeze` with a pre-seeded store | Isolates retrieval quality from capture quality |

- Each series runs with **one harness home across its tasks**. That shared memory is the point. Each task still gets a fresh workspace checkout of the series's next state.
- **Repository identity.** A shared harness home is not enough. The knowledge store and project files live under `<home>/knowledge/<repo-id>/` and `<home>/projects/<repo-id>/`, and `repoId` comes from `lib/knowledge/store.mjs` (`readRepoIdentity`). It uses the `origin` remote when one exists and otherwise a hash of the local checkout path. Fresh checkouts at different temporary paths would therefore get different local IDs, and no task would see the previous task's memory. The eval pins identity explicitly:
  - every checkout in a series sets `origin` to a fixed, non-resolvable URL, `https://eval.invalid/ae-memory/<series-id>.git`, before any `ae` command runs
  - the series ID is the same across arms and repeats, so arms differ only in their harness home and knowledge mode, never in their repository identity
  - isolation between arms and repeats comes from a separate harness home per (series, arm, repeat), not from a different repository identity
  - the runner records `repoId` and the resolved store directory for every task in the attempt record, and an attempt whose `repoId` differs from its series's first task is invalid, not a failure
  - no task may run `git remote` changes, and the private check confirms `origin` is unchanged after the agent finishes
- `run.mjs`: same CLI shape as `eval/context/run.mjs` (`--out`, `--split`, `--live`, `--provider`, `--model`, `--allow-auto`). Dry run is the default.

**Metrics per attempt.**
- private-check pass
- trap recurrence: trap check fails on its second appearance (primary)
- `repeat-mistake.mjs` verdict
- turns
- observed input and output tokens
- `learningsBytes`
- learnings injected per task
- episodes written

**Promotion rule** (written into `protocol.json` before any live run). Each arm declares a `baseline`: the arm it extends. An arm is compared against its baseline, never only against `stateless`.

| Arm | Baseline | Question it answers |
| --- | --- | --- |
| `capture-only` | `stateless` | Does writing memory help without reading it? |
| `recall` | `stateless` | Does current memory help at all? |
| `frozen-seed` | `stateless` | Does retrieval help when capture quality is held fixed? |
| `recall+feedback` | `recall` | Does feedback add anything on top of current recall? |
| `recall+recheck` | `recall` | Does re-check add anything on top of current recall? |

An arm counts as an improvement for a model only if, against its baseline:
- held-out trap recurrence falls by ≥ 30% relative to the baseline arm
- private-check pass rate doesn't regress (difference ≥ −2 percentage points, the non-inferiority margin)
- episodes written per series don't rise unless trap recurrence also falls
- there are ≥ 30 held-out attempts per arm, run in the same batch as the baseline so both see the same model version
- observed usage is complete

An incremental arm must also still meet the rule against `stateless`. If the baseline itself fails against `stateless`, its incremental arms can't be promoted.

Example: with recurrence of 50% for `stateless`, 10% for `recall` and 30% for `recall+feedback`, feedback is 40% better than `stateless` but 200% *worse* than `recall`. Under this rule it is rejected. The earlier rule, which compared only against `stateless`, would have approved it.

Auto-routed models (`--allow-auto`) are diagnostic only, as in `eval/context`.

**Tests (`npm test`).**
- `test/memory-eval.test.mjs`, scripted model:
  - the arms set the right knowledge mode
  - the harness home persists across a series and is isolated between series and arms
  - every task in a series resolves the same `repoId` and store directory, and different series resolve different ones
  - an attempt whose `repoId` drifts is marked invalid
  - each arm's `baseline` is declared, acyclic, and resolves to `stateless` in at most two steps
  - promotion scoring rejects the 50/10/30 example above
  - a scripted episode written in task 1 is injected in task 3 under `recall` and absent under `stateless` and `capture-only`
  - trap-recurrence scoring
  - output directory outside the checkout
  - dry run makes no provider calls
- `test/memory-eval-cases.test.mjs`: every series has a failing baseline and a reachable trap, and no held-out series shares a trap with a dev series.

**Acceptance criteria.**
- `node eval/memory/run.mjs --out <dir>` dry run passes all fixture validations.
- One live diagnostic run is recorded for at least one available model, with provenance, even if the result is inconclusive.
- `eval/README.md` documents the protocol and its limits.

**Out of scope.** Changing retrieval or capture behavior. This phase only measures.

### Phase 1: recall feedback loop

**Objective.** Record which learnings each plan saw and whether they helped. Feed that back into consolidation as evidence.

**1a. Exposure record.**
- When `ae orient` builds a pack for an active plan, Harness appends the delivered learning IDs to a bounded exposure record at `.harness/learning/exposures/<plan-hash>.json`, using the same `recordHash` convention as review records.
- Each entry holds: learning ID, layer, first-exposed and last-exposed timestamps, exposure count.
- Cap: 64 entries per plan, keeping the most recent; 32 KiB per record.
- Written atomically. The record is outside the work contract, so it never invalidates evidence.
- Source of truth: the `deliveredLearnings` array already computed in `lib/orient.mjs`, so only IDs actually in the pack count.

**1b. Optional `recalled` field in the learning decision.**

```json
"recalled": [
  {"id": "<learning id>", "verdict": "helped|irrelevant|wrong", "note": "optional, ≤ 280 chars"}
]
```

Validation in `lib/learning-record.mjs` and the compound decision parser:
- every ID must appear in the plan's exposure record; unknown IDs are a schema error
- no duplicate IDs
- the note is secret-scanned

If the field is absent, the stored decision bytes and digest are unchanged (invariant 3). The field is allowed on both `publish` and `no-learning` decisions.

**1c. Consolidation inputs.**
- `ae consolidate --candidates` adds a `feedback` section: per-learning counts of `helped`, `irrelevant` and `wrong`, with plan references.
- A learning with any `wrong` verdict since its last mutation is listed under `review_required`.
- The agent may propose SUPERSEDE or NOOP with that as evidence. A dispute still needs `ae learning dispute`, which the skill recommends to the human in `suggest` mode.
- `helped` verdicts count as STRENGTHEN evidence only when cited by episode or plan reference. Counts never activate anything (invariant 1).

**1d. Visibility.**
- `ae knowledge --status` and the learnings listing show `exposed`, `helped`, `wrong` and `last_exposed` per learning.
- `/harness-doctor` reports learnings exposed ≥ 5 times with zero `helped`, as a pruning hint.

**1e. Debt weighting (only with `knowledge.feedback=on`).**
- Consolidation is `due` when debt ≥ threshold (unchanged) **or** at least one active learning has an unresolved `wrong` verdict.
- Packet ordering puts most-exposed and disputed-by-feedback learnings first.

**Skill and reference changes.**
- `skills/auto-compound/SKILL.md`: one paragraph on the purpose. Report whether recalled learnings held up so memory improves; include `recalled` when the pack listed learnings.
- `skills/references/learning-operations.md`: field contract.
- `skills/consolidate/SKILL.md`: how to read the `feedback` section.

**1f. Review-finding dispositions (second feedback source).**
- Review records already give every surviving finding a stable `id` (`findingIdentity` in `lib/review-synthesis.mjs`). Nothing records what happened to it afterwards.
- The learning decision gains an optional `findings` field:

  ```json
  "findings": [
    {"id": "<finding id>", "disposition": "fixed|dismissed", "note": "optional, ≤ 280 chars"}
  ]
  ```

- Every ID must appear in a review record bound to this plan (any record, not only the latest, because fixing a finding changes the scope and the next review no longer lists it). No duplicates. The note is secret-scanned.
- Consolidation's `feedback` section gains per-reviewer counts of `fixed` and `dismissed`, so resolution rate (fixed ÷ disposed) becomes a regression metric. Repeatedly dismissed findings from one reviewer are evidence for judgment about that check, never an automatic change.
- This follows Cursor Bugbot's learned-rules loop, the one source in the November 8 survey with published coding-loop evidence (resolution rate from 52% to 78%).

**1g. Feedback records.**
- When a learning decision with `recalled` or `findings` completes, Harness writes one immutable record per operation at `<home>/projects/<repo-id>/feedback/<operation>.json`. It holds the plan path, the verdicts and dispositions, and the decision's capture date.
- The record lives in the project store, not the worktree, so consolidation sees verdicts from every worktree of the repository. It is bookkeeping, not learning content, so the sole writer of learning content is unchanged.

**Config.** `knowledge.feedback`, with values `off|suggest|on` (see Configuration states), default `off` until the Phase 0 `recall+feedback` arm meets the promotion rule against `recall`. Set it with `ae knowledge feedback <off|suggest|on>`.
- `off`: exposure records, verdicts, dispositions and feedback records are written; consolidation, status and `due` are byte-identical to main.
- `suggest`: `ae consolidate --candidates` shows the `feedback` section (1c, 1f) and status shows feedback counts; `due` is unchanged.
- `on`: as `suggest`, and 1e applies (an unresolved `wrong` verdict makes consolidation `due`, and ordering uses feedback).

**Tests.**

| Test file | Covers |
| --- | --- |
| `test/learning-exposure.test.mjs` | record created only for delivered IDs; cap and truncation; atomic replace; no invalidation of evidence or review coverage; worktree isolation |
| `test/learning-decision-recalled.test.mjs` | valid, unknown-ID, duplicate and secret-in-note cases; absent field keeps the digest byte-identical to a fixture recorded from main; replay with the same input is idempotent |
| `test/consolidation-feedback.test.mjs` | feedback section counts; `review_required` listing; `due` with a `wrong` verdict below the debt threshold; ordering; a `wrong` verdict never changes learning status without `ae learning dispute` |
| `knowledge-status.test.mjs`, `learnings-listing.test.mjs` | extended for the new columns |
| `test/knowledge-governance-boundary.test.mjs` | extended so no feedback path reaches the promote, retire or dispute writers |
| `test/review-finding-disposition.test.mjs` | finding IDs validated against every review record of the plan; unknown, duplicate and secret-in-note cases; per-reviewer counts in the packet |
| `test/knowledge-feedback-config.test.mjs` | `off`, `suggest`, `on` each behave as the Configuration states table says; unknown values are refused and read as `off`; knowledge modes `freeze` and `capture-only` override the key |

**Acceptance criteria.**
- all tests above pass
- `npm test` is green
- the Phase 0 `recall+feedback` arm runs in dry-run mode
- `docs/adaptive-engineering.md` documents exposure and feedback

### Phase 2: re-check pass and failure-derived candidates

**Objective.** Let consolidation re-check active learnings against later evidence, and surface recurring failures as candidates for human or agent judgment. The name is `recheck`, not "dream", so its purpose is plain in the CLI.

**2a. `ae consolidate --candidates --recheck`.** This extends the frozen packet with a `recheck` section, built only from Harness-owned records:

| Signal | Source | Packet entry |
| --- | --- | --- |
| Stale file bindings on an exposed learning | `applicability.mjs` currentness, plus the Phase 1 exposure record | `stale_exposed`: ID, changed paths, last exposure |
| `wrong` feedback | Phase 1 decisions | `review_required` (shared with 1c) |
| Recurring failed check | failed `ae verify` evidence across plans (`lib/evidence.mjs`) and the run journal (`lib/run-journal.mjs`: `run.result` with failed status) | `failure_clusters`: check ID, plans, first and last seen, failing-output excerpt from the evidence record (bounded, secret-scanned) |
| Recurring review finding | review observations (`.harness/reviews/observations/`) grouped by finding category and file | `finding_clusters` |
| Insight episodes not yet consolidated | existing episode store, `kind: insight` | unchanged, listed as today |

- A cluster needs ≥ 2 distinct plans; one-off failures are not reported.
- Clusters are bounded (default 10 per packet) with omission counts, matching existing packet behavior.

**2b. Turning clusters into learnings, with no new write path.**
- A cluster is not an episode. To act on one, the agent records an episode through the existing insight lane with a reference to the cluster, as `kind: insight` with a `derived_from: failure-cluster:<id>` field.
- It then cites that episode in an ordinary ADD or STRENGTHEN op.
- This keeps the sole writer, caps, lint and governance unchanged (invariant 2), and makes every failure-derived learning traceable to its evidence.

**2c. Integrity checks during re-check.**
- Learnings whose body references another learning ID or a repository path that no longer exists are listed under `broken_references`.
- The agent proposes the fix through SUPERSEDE. Harness never rewrites text itself.

**2d. Read-only journal query.**
- `ae run list --plan <path> --status <status>` already exists (`lib/run-cmd.mjs`, through `readRuns` and `queryRuns`). Document it in the consolidate skill as the way to inspect a cluster's history.
- No new search index in this phase.

**Due.** Only with `knowledge.recheck=on`, `due` also becomes true when `stale_exposed` ≥ 3 or any failure cluster spans ≥ 3 plans.

**Config.** `knowledge.recheck`, with values `off|suggest|on` (see Configuration states), default `off`.
- `off`: packets are byte-identical to main.
- `suggest`: `--recheck` adds the `recheck` section; `due` is unchanged.
- `on`: as `suggest`, and the due rule above applies.

**Skill changes.** Update `skills/consolidate/SKILL.md` with a short section stating what re-check is for. A cluster or stale binding is a question to answer with evidence. The right answer is often NOOP.

**Tests.**

| Test file | Covers |
| --- | --- |
| `test/consolidate-recheck.test.mjs` | each signal from fixtures; ≥ 2-plan threshold; bounds and omission counts; secret-scanned excerpts; with the key off, packet bytes are identical to main |
| `test/consolidate-recheck-boundary.test.mjs` | no host-transcript paths are read; no store write happens outside `--apply`; a `derived_from` insight is traceable from the applied learning back to the cluster's evidence records |
| `consolidation-packets.test.mjs` | extended for packet schema compatibility (schema 2 readers ignore unknown sections) |
| `insight-compound.test.mjs` | extended for `derived_from` validation |

**Acceptance criteria.**
- tests pass
- the Phase 0 `recall+recheck` arm runs
- at least one dev series shows a failure cluster becoming a learning that prevents the trap's second appearance under a scripted model (a deterministic fixture, not a model-quality claim)

### Phase 3: skill-rule ablation

**Objective.** Find out which procedural rules in the judgment skills carry weight on the models AE users run, and simplify the ones that don't. This applies the harness-design lesson to remove one component at a time, and the memory finding that fixed write rules can cost strong models gains.

**Scope.**

| Skill | Rules to test |
| --- | --- |
| `skills/auto-compound/SKILL.md` | classification table; promotion test |
| `skills/consolidate/SKILL.md` | op selection guidance |
| `skills/compound-learnings/SKILL.md` | — |

Deterministic guarantees in Harness code are **not** in scope. That split is intended and stays.

**Method.**
1. For each skill, write a *purpose-first* variant: what memory is for, what a good learning looks like, and when no learning is right. Keep every Harness-required field and command.
2. Use Phase 0's `recall` arm with the skill variant swapped through the eval fixture's private Copilot home. The installed corpus is never touched.
3. Run the development split, then held-out, for every model the maintainers can access. Record the model identity each run reports.
4. **Decision rule.**
   - Adopt a variant only if, on every tested model, it doesn't regress trap recurrence or pass rate, and on at least one model it improves trap recurrence or reduces episodes written without lowering trap prevention.
   - Mixed results mean no change, recorded as evidence.
5. **Runtime per-model tiering is deferred.**
   - On Copilot, AE does not observe the serving model at runtime.
   - `/setup-models` writes host rules, and AE does not read model identity from them.
   - Tiering is reconsidered only if results diverge by model *and* a host exposes model identity.

**Tests.**
- `test/prompt-library-contracts.test.mjs` and `check:engineer` keep passing for any adopted variant.
- New eval fixture tests check that the variant swap is confined to the eval home.

**Acceptance criteria.**
- A results file goes under `eval/results/` (or external output, following the existing rule), with a written decision for each skill.
- Adopted variants ship with contract tests green.

### Phase 4 (gated): topic pages

**Entry criterion.** Phase 0 or 3 results show trap or task failures on work that spans several modules, where the needed learnings existed but weren't retrieved or weren't combined. Without that evidence, this phase doesn't start. The article saw no wiki gain on single-document tasks, and most AE fixes are local.

**Sketch, refined by its own plan if it starts.**
- `knowledge/topics/<domain>.md` pages maintained only through consolidation ops: a new `TOPIC` op, applied by the sole writer.
- Each page links to its learning IDs and to the files those learnings are tied to.
- Size budget: page bytes ≤ 0.5× the bytes of the learnings it cites. The article saw a wiki reach 1.77 times its corpus.
- Link-integrity check in re-check (reuses 2c).
- Retrieval returns a topic page's claim line plus links when ≥ 2 of its learnings match. The pack budget is unchanged.

### Phase 5: small changes (can ship with Phase 1 or 2)

**5a. Quoted evidence in episodes.**
- An optional `evidence_quote` field on publish decisions and insights: at most 600 bytes, verbatim error, test or diff text, secret-scanned, excluded from the claim byte cap the same way provenance is.
- Rationale: one page per entity with verbatim quotes kept 100% of facts in the article.
- Tests extend `knowledge-compound-write-safety.test.mjs` and `recall-secret-data-boundary.test.mjs`.

**5b. Freshness of verification on resume.**
- `load-context` already surfaces `verification.state`.
- Confirm what happens when a resumed plan's evidence is stale or failed. If it only reports the state, add `ae verify` as the first next-tool in the pack for that case, so a session checks for leftover breakage before new work.
- Advisory only; gates are unchanged.
- Tests extend `context-pack.test.mjs` and `knowledge-injection-and-plan.test.mjs`.

## Sequencing and delivery

```text
Phase 1a (records only, key off) ─────┐
Phase 0 (eval) ──┬────────────────────┴── Phase 1b (visibility; key may leave off) ──┐
                 ├── Phase 2 (recheck) ───────────────────────────────────────────────┼── Phase 3 (skill ablation) ── Phase 4 (gated)
                 └── Phase 5 (small, rides with 1 or 2)
```

| PR | Contents | Depends on | Default behavior after merge |
| --- | --- | --- | --- |
| P1a | exposure record, `recalled`, review-finding `findings`, feedback records, `feedback` packet section, `knowledge.feedback` key, skill text | none (records only while `off`) | records written; feedback `off` |
| P0 | `eval/memory/`, tests, README, including the `recall+feedback` arm | none | unchanged |
| P1b | listing columns, doctor pruning hint, debt weighting (1d, 1e) | P1a; flipping past `off` needs P0 | feedback `off` |
| P2 | `--recheck`, clusters, `derived_from`, integrity checks | P0; uses P1 exposure if present | off |
| P5 | `evidence_quote`, resume verification hint | none | additive or advisory |
| P3 | variant fixtures, results, adopted skill edits | P0 (+P1/P2 for full arms) | only evidence-backed edits |
| P4 | separate plan | P0/P3 evidence | n/a |

Each PR goes through the AE pipeline: locked plan → implementation with TDD → `/code-review` → `npm test` and `npm run check:repo` (plus `check:engineer` if any Engineer source changes) → learning decision.

## Test strategy

- **Unit and contract** (`npm test`): every behavior in the per-phase tables, with no model calls. Fixtures compare against byte snapshots from main where invariant 3 applies.
- **Deterministic end-to-end:** scripted-model series in `eval/memory` show the mechanics work. For example, an injected learning reaches the pack, a failure cluster becomes a learning, and the trap check then passes. These are not quality claims.
- **Live diagnostic:** `eval/memory/run.mjs --live`, per model, development split while tuning and held-out after freezing. Results keep failed attempts, model identity, usage coverage and all hashes, as in `eval/context`.
- **Regression:** the existing knowledge, consolidation and retrieval suites (`test/knowledge-*`, `test/consolidat*`, `test/retrieval-*`, `test/context-*`, `test/repeat-mistake.test.mjs`) must stay green in every PR.
- **Native-host trial:** before flipping any default, run one installed-Engineer trial per supported host using `eval/host/README.md`.

## Success metrics

| Metric | Source | Target to flip a default |
| --- | --- | --- |
| Trap recurrence (held-out) | Phase 0 | ≥ 30% relative reduction vs `stateless`, per model |
| Private-check pass rate | Phase 0 | no regression |
| Episodes written per series | Phase 0 | no increase without matching trap-prevention gain (guards against over-recording) |
| Injected learning bytes per task | `learningsBytes` | within the existing pack budget |
| Learnings with `wrong` feedback resolved within one consolidation cycle | Phase 1 status | ≥ 90% once feedback is on |
| Share of exposed learnings never marked `helped` after 5 exposures | Phase 1 status | tracked; feeds pruning, no fixed target |

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Agents mark every recalled learning `helped`, so feedback becomes noise | `helped` counts only when cited; `wrong` drives review, `helped` never activates anything; Phase 0 compares `recall` with `recall+feedback` |
| Failure clusters flood consolidation | ≥ 2-plan threshold, per-packet cap, omission counts; NOOP is an explicit valid answer |
| Schema changes break replay or digests | Invariant 3 with byte-snapshot tests against main |
| Eval too small to decide | Promotion rule fixed in `protocol.json` before live runs; inconclusive results change nothing |
| An incremental feature beats `stateless` while making recall worse | Each arm is compared against its declared baseline (`recall` for incremental features), with a non-inferiority margin |
| Eval tasks silently use separate project stores | Each series pins `origin` to a fixed URL; `repoId` is recorded per task and drift invalidates the attempt |
| Model access limits per-model conclusions | Report per model tested; never generalize to untested models; Auto routing diagnostic only |
| Re-check reads sensitive output | Only Harness-owned records; excerpts bounded and secret-scanned; same redaction as review records |
| Scope creep into a wiki | Phase 4 is gated on evidence and needs its own plan |

## Rollout and rollback

- **Keys:** `knowledge.feedback` and `knowledge.recheck` take `off|suggest|on` (see Configuration states) and default to `off`. Each one moves past `off` only after its Phase 0 arm meets the promotion rule against its baseline and a native-host trial passes.
- **Order of exposure:**
  1. maintainers set the keys to `suggest` or `on` locally
  2. the default becomes `suggest`: packets and status show the new sections as evidence, `due` is unchanged, and apply still needs the usual approval
  3. the default becomes `on`: the signals may also make consolidation `due` and change packet ordering
- **Rollback:** set the key to `off`. New records are additive and ignored when off. No migration is needed, and existing learnings are never rewritten by these phases.
- **Knowledge modes keep priority:** `off`, `freeze` and `capture-only` keep their current meanings and override both keys.

## Documentation to update, per PR

- `docs/adaptive-engineering.md`: exposure, feedback and re-check contracts (P1, P2).
- `packages/ae/corpus/skills/references/learning-operations.md`: `recalled`, `evidence_quote`, `derived_from` (P1, P2, P5).
- `packages/ae/eval/README.md`: memory eval protocol (P0).
- `CLAUDE.md`, `AGENTS.md`, `packages/ae/corpus/copilot-instructions.md`, `.github/agent-context.md`: only if a skill or agent is added or removed. This plan adds none.

## Open questions

1. Should exposure records be written when knowledge mode is `freeze`? Proposed yes: they're Harness bookkeeping, not learning content.
2. Should `irrelevant` verdicts lower retrieval rank directly, or only inform consolidation? Proposed: consolidation only, until Phase 0 shows rank changes help.
3. Which models can maintainers run live for Phase 0? The answer decides how far Phase 3's per-model conclusions can reach.
4. Should private-domain learning (`<harness-home>/domains/<name>/docs/solutions/`), which ordinary recall doesn't yet discover, join the exposure and feedback loop in Phase 1 or later?
