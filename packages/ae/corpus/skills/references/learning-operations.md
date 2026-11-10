# Learning operations

The agent authors the durable claim and chooses an approved destination. Harness owns representation, publication, evidence bindings, indexing, caps and replay. Learning and consolidation records remain outside the work contract.

Explicit user instructions and corrections can be remembered during work under direct authority or a current scoped memory grant; they do not wait for passed task verification. Retain source attribution, scope, and authority. Inferred lessons stay provisional and cannot silently override an explicit instruction. Use the native decision-agent to judge a proposed update's evidence and conflicts, never to manufacture authority. The ordinary post-success publication path below remains verification-bound. Orientation and compounding surface recurring-use candidates for `/auto-skill-draft`; distinct passed evidence, overlap checks, and creator governance determine whether a reusable skill is warranted.

## Publication

Pipe the decision JSON to `ae compound --plan <path> --learning-decision - --json` (stdin):

```json
{
  "operation": "accepted-boundary-lesson",
  "decision": "publish",
  "scope": "private",
  "rationale": "The verified work demonstrated a reusable boundary.",
  "title": "Preserve publication identity during recovery",
  "category": "reliability",
  "tags": ["publication", "recovery"],
  "body": "Evidence, root cause, correction, prevention and applicability."
}
```

Scopes: `private` uses the product solution store; `global` uses the selected Copilot home's knowledge; `ship-set-proposal` saves a dormant proposal under the workspace's `.harness/proposals/`. It never activates a primitive or edits the shipped corpus. Use a wider scope only within the applicable approval contract. To record no durable learning, submit `decision: "no-learning"` with an operation and rationale.

Harness requires current passed verification and required review coverage. It reports the actual published path, content identity, indexing result and learning record. Same identity/content/destination/proof replays; different content, destination or proof conflicts. Retry an interrupted operation with the same input. Changed publication bytes are a conflict; missing accepted bytes can be recovered. Unrestored shared retrieval state requires reconciliation through `ae index` before recovery. Use the returned diagnostics; do not claim a partial rollback succeeded.

An `in-progress` or `review` plan can publish after those prerequisites pass. The learning decision precedes plan completion. For merged changes, deleted worktrees or outdated learning, read `<copilot-home>/skills/compound-learnings/references/post-merge-recovery.md`. Reuse the original plan and recover current proof before publication; a remote merge or the conversation is not a substitute for that proof.

### Recall and review feedback

Both decision types accept two optional fields. Omit them when there is nothing to judge; an absent field leaves the decision and its identity unchanged.

```json
"recalled": [{"id": "<learning id from the context pack>", "verdict": "helped|irrelevant|wrong", "note": "optional, at most 280 characters"}],
"findings": [{"id": "<finding id from a review record>", "disposition": "fixed|dismissed", "note": "optional"}]
```

Harness records the learning IDs each context pack actually delivered for the plan. A `recalled` ID outside that record, a finding ID that no review record of this plan contains, a duplicate, or a note that looks like a secret is rejected. Judge honestly: `helped` means the learning changed what you did, `irrelevant` means it did not apply, `wrong` means following it would have been a mistake. `dismissed` means the finding was deliberately not acted on. Harness records its own observation beside each disposition (`still-reported`, `no-longer-reported` or `no-latest-review` in the plan's latest review), so a `fixed` claim the latest review still reports shows as contradicted. Verdicts are written to an immutable feedback record in the project store, which also cites the decision agent's latest readiness receipt for the plan. They are evidence for consolidation only and never retire, dispute, confirm or promote anything.

### Evidence line

A `publish` decision accepts an optional `evidence_quote`: the single failing line of check or test output that showed the lesson, copied exactly.

```json
"evidence_quote": "not ok 1 - example exports two # expected: 2, actual: 1"
```

It must be one line: CR, LF, NEL and the Unicode line and paragraph separators are refused. Harness never stores or shows the line. It normalises it by removing a leading byte-order mark and terminal escape sequences, applying Unicode NFC and trimming both ends; an unterminated OSC sequence loses only its ESC. The normalised line must be 1 to 600 bytes with no control character other than tab (raw input may be up to 4 KB, to allow colour codes). Harness then records only `evidence_sha256` (the SHA-256 of the normalised line) and `evidence_bytes` (its length) in the episode frontmatter and the learning decision record. No secret screening is needed, because no text is kept, and the run journal and events record the flag with its value replaced. A decision carrying `evidence_quote` is accepted only on stdin (`--learning-decision -`); from a file path it is a usage error, so no copy of the line is left on disk. `no-learning` decisions refuse the field. For an insight, pipe the line in with `ae compound --insight --evidence-quote -`, so it stays out of argv, shell history and terminal guards (a line that looks like a destructive command can trip them); `--evidence-quote "<line>"` also works. The flag is a usage error without `--insight`, beside `--learning-decision`, or without a value, and a value that is itself a flag of `ae compound` needs the `--evidence-quote=<line>` form. An `evidence_quote` key written into an episode by hand is never read.

`/consolidate` sees an episode's `evidence` as `{ sha256_prefix, bytes }`. To confirm it, re-run the check and save its output, then run `ae compound --match-evidence <sha256_prefix> --evidence-bytes <bytes> --check-output <file>`. A relative file resolves against `--workspace`; `-` reads stdin; `--evidence-bytes` is optional and hex may be in either case. Each output line is normalised the same way. It exits 0 with the matching line number, 1 when no line matches, and 2 for a usage error, including an unreadable or oversize file or any other `ae compound` flag. Output lines over 64 KB are skipped. It writes nothing besides the normal run record, which records a mismatch as a completed run, not a failure. Under `ae agent` delivery, `--check-output` must be `-` or a relative path inside the workspace. A failing line usually disappears once the fix lands, so a mismatch on fixed code leaves the evidence unconfirmed rather than wrong.

`--dry-run` validates without publication. Optional authored `trigger` and `claim` fields are supported. Investigation capture without passed work uses the existing `compound --insight` lane and remains an insight.

## Consolidation

`ae consolidate --candidates --json` returns a persisted schema-2 frozen packet. Read its clusters and learning records, then supply semantic ops:

```json
{
  "schema": 2,
  "packet": "<returned packet ID>",
  "operation": "accepted-claim-consolidation",
  "attempt": 1,
  "ops": [{
    "op": "ADD",
    "domain": "reliability",
    "slug": "publication-identity",
    "trigger": "Recovering a publication operation",
    "body": "The accepted publication identity remains bound to its content and evidence.",
    "reason": "Nearest existing claims do not cover this boundary.",
    "episodes": [{"id": "<returned episode ID>"}]
  }]
}
```

`ADD` needs domain, slug, trigger and body. `STRENGTHEN` needs target. `SUPERSEDE` needs target plus replacement fields. `MERGE` needs targets plus replacement fields. `NOOP` needs its evidence and preferably a rationale. Every op selects nonempty episode IDs; optional authored `plan` references retain the legacy plan-link contract. Harness expands paths, hashes and kinds. Category grouping is a hint; semantic grouping remains the agent's decision.

Run `consolidate --apply --ops <file> --dry-run --json` for the same schema, bytes, cap, lint and governance validation used by apply. Dry-run spends no attempt. The returned `diagnostics` and `retry` fields own repair eligibility. An eligible failure permits the returned second attempt; terminal failures and completed operations do not. Reusing one attempt with different content conflicts. The receipt is committed with the store's effects, so interrupted outer bookkeeping recovers without consuming episodes twice.

When `ae knowledge feedback` is `suggest` or `on`, the packet also carries a `feedback` section: per-learning `helped`, `irrelevant` and `wrong` counts with plan references, `review_required` for learnings whose current version was judged `wrong`, and per-reviewer `fixed`, `dismissed` and `contradicted` counts. Treat `review_required` as a question to answer with evidence: SUPERSEDE or STRENGTHEN with the citing episodes, recommend `ae learning dispute` or `ae learning confirm` to the human, or leave it for later. A `helped` count is not STRENGTHEN evidence unless an episode or plan reference supports it. With `on`, an unresolved `wrong` verdict also makes consolidation due. With `off` (the default) the packet is unchanged.

Existing schema-1 proposals remain readable through the existing validator; new workflows use frozen packets. Existing knowledge modes and explicit human approval for suggest mode or authority expansion remain unchanged. Standing human retire, dispute and promotion decisions remain authoritative. A stale packet needs fresh source inspection and a new operation, not a blind replay. After applying a bounded packet, request another; omission counts preserve the remaining debt.
