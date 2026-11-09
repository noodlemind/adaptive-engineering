---
name: consolidate
description: Internal knowledge consolidation loop. Clusters learning episodes into an ops JSON; consolidate --apply is the learnings store's sole content writer. Use when a debt drain is due; not episode capture or manual edits.
user-invocable: false
---

# Consolidate (internal)

## Trigger Examples

**Should trigger:**

- `/auto-compound` finds `ae consolidate --status --json` reports `due: true` after persisting a learning (session-end drain).
- `@engineer` orient reads a `consolidate --candidates` next-hint in the context pack (session-start drain).
- A human explicitly asks to run the knowledge consolidation loop now.

**Should not trigger:**

- "Record this fix as a learning." → `ae compound --plan <path>` or `--insight` captures the episode; consolidation clusters episodes later.
- "Edit this learning file directly." → a human hand edit is a supported path the store absorbs with `source: human` provenance on the next mutation. It is a user action, not a consolidation trigger. This skill itself never edits store files.
- `consolidate --status` reports `due: false` and no human asked.

## Confusable Boundaries

- `/consolidate` clusters already-captured episodes into learnings; `/auto-compound` and `ae compound --insight` are what capture an episode in the first place.
- `/consolidate` never writes the learnings store itself — `ae consolidate --apply` is the sole writer, enforcing the byte cap, delta contract, secret scan, and imperative lint.
- `/index-memory` rebuilds the BM25 manifest over solution docs; it does not touch the learnings store.

## Read and judge the frozen packet

Run `ae consolidate --candidates --json`. Read its episode clusters, active learning references, domain pressure, standing human decisions, omission counts and contract. Retrieve source records when an excerpt is insufficient.

When the packet has a `feedback` section, it records whether recalled learnings helped and whether review findings were fixed. Its purpose is to keep memory honest: a learning listed in `review_required` was judged wrong in its current form, so check it against evidence before anything else. The right answer may be SUPERSEDE, a dispute recommended to the human, or NOOP. Counts alone never justify a change; `learning-operations.md` has the contract.

### Re-check

When `ae knowledge recheck` is `suggest` or `on`, run `ae consolidate --candidates --recheck --json`. Its `recheck` section re-checks active learnings against later Harness evidence: exposed learnings whose source bindings changed, learnings judged wrong, checks and review findings that failed in at least two plans, and learning bodies that cite missing learnings or paths. Each entry is a question to answer with evidence, not a defect to fix; NOOP is often right. Inspect a failure cluster's history with `ae run list --plan <path> --status failed --json` for each listed plan, and read its evidence records. To turn a cluster into a learning, capture an insight with `ae compound --insight --derived-from failure-cluster:<id>`, then cite that episode in an ordinary ADD or STRENGTHEN. Fix a broken reference or stale claim through SUPERSEDE.

A cluster is a category group and a grouping hint. Choose multiple ops when it contains unrelated claims. The agent decides `ADD`, `STRENGTHEN`, `SUPERSEDE`, `MERGE` or `NOOP` for each supported claim. Compare nearest existing learnings before adding. Re-derive a strengthened or merged claim from raw evidence, and preserve its meaning and applicability. A derivable code fact often warrants NOOP. A cap never justifies a lossy merge or discarding a valuable claim: defer it and explain the pressure when no sound change fits.

## Submit the semantic proposal

Read `<copilot-home>/skills/references/learning-operations.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/references/learning-operations.md --json` prints the same file. Submit schema 2 with the returned packet ID, a logical operation ID, attempt 1, and authored ops using episode IDs. Harness expands evidence paths, hashes and kinds and checks currentness under the store transaction. It owns byte and delta limits, domain projections, lint, governance, indexing, and operation receipts. Do not copy hashes or reproduce those algorithms.

Use `ae consolidate --apply --ops <file> --dry-run --json` to obtain diagnostics without spending a repair attempt. Apply after the proposal is ready. The existing mode gate remains authoritative: `on` allows apply; `suggest` requires the human's explicit approval and then `--yes`; `off`, `freeze` and `capture-only` refuse it. A payload cannot grant authority or change mode.

Use returned `diagnostics` and `retry`: repair the claim only when `retry.eligible` is true, submitting the returned `nextAttempt`. Persisted state enforces the bound across sessions. A terminal failure needs inspection or a human decision. Replaying the same attempt returns its prior result; changing an accepted attempt's payload conflicts.

After successful application, request another packet to continue draining debt. Omitted episodes remain candidates; an empty packet ends the drain. Never claim that a truncated packet covered every episode. Report actual applied IDs, any disputed targets, deferred claims and unresolved diagnostics.

## Guardrails

- Only the Harness writer changes learning content. Direct human hand edits are a separate supported path; preserve their provenance and standing decisions.
- Promotion, retirement and dispute authority remain governed. A recurring claim, count or candidate is evidence for judgment, never activation authority.
- For tool unavailability and subagent failure, use the shared error-handling reference; do not blindly resubmit a terminal operation.
