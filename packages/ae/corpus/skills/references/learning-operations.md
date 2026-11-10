# Learning operations

The agent authors the durable claim and chooses an approved destination. Harness owns representation, publication, evidence bindings, indexing, caps and replay. Learning and consolidation records remain outside the work contract.

Explicit user instructions and corrections can be remembered during work under direct authority or a current scoped memory grant; they do not wait for passed task verification. Retain source attribution, scope, and authority. Inferred lessons stay provisional and cannot silently override an explicit instruction. Use the native decision-agent to judge a proposed update's evidence and conflicts, never to manufacture authority. The ordinary post-success publication path below remains verification-bound. Orientation and compounding surface recurring-use candidates for `/auto-skill-draft`; distinct passed evidence, overlap checks, and creator governance determine whether a reusable skill is warranted.

## Publication

Write a decision under `.harness/decisions/` and call `ae compound --plan <path> --learning-decision <file> --json`:

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

When `ae knowledge recheck` is `suggest` or `on`, `ae consolidate --candidates --recheck --json` adds a `recheck` section built only from Harness records in the checkout and the store: `stale_exposed` (exposed learnings whose source bindings changed, with the changed paths and last exposure), `review_required` (shared with feedback, read whatever the feedback key says), `failure_clusters` (a named check that failed in `ae verify` evidence, or a command whose run journal result failed, in at least two plans, ranked by plan count, with up to five plans, `plan_count` (distinct plans as shown), first and last seen, `evidence_count` (how many evidence records the cluster was built from; their paths are not listed, because they hold retained output) and up to five failure records, newest first, with per-cluster `omitted`, each carrying metadata only (check name, status, exit code, line counts and an output hash, never the output: re-run the check as the `hint` says to read it); Harness's own gate rows such as `phase-tasks` or `required-reviews` are not failure evidence), `finding_clusters` (review findings grouped by perspective and file across at least two plans; informational only: they never make consolidation due and no answer clears them. Their IDs have the form `finding-cluster:<20-hex>`, which `--derived-from` refuses), and `broken_references` (inline-code references in a learning body to a learning, golden or branch, that does not exist, or to a path whose first directory exists at the root or beside the learning's anchors but whose full path does not). The path rule favours silence: it skips tokens containing `@`, tokens starting with `origin/`, `upstream/`, `refs/`, `heads/`, `tags/` or `remotes/` even when such a directory exists, and package-relative paths in a learning without anchors. Each list holds at most 10 entries; `counts` and `omitted` report the rest. Identity fields are shown only when an allowlist outside the record vouches for them, never because of what the value looks like: a check name only when the workspace's checks configuration declares that check (otherwise `[check:<12-hex digest>]`, and the `hint` says to run the workspace's checks without naming it); a run-journal command only when it is a command the `ae` command registry defines, the same check the CLI makes before it journals a run (otherwise `[command:<12-hex digest>]`); a finding category only when it is a review perspective Harness defines (otherwise `[reviewer:<12-hex digest>]`); a finding file or a plan only when it names an existing regular file in the checkout, reached without following a symlink, or in the project's plan store (otherwise `[unnamed:<12-hex digest>]`). Shown values must also fit a narrow character set and pass both secret screens, as an extra layer. A plan in the project's external plan store (managed plans and domain child plans) is shown by its file name, which `ae verify --plan <name>` resolves to the same plan; the home directory is never shown. Run-journal plans are resolved as `ae verify --plan` resolves them before they are counted, so different spellings of one plan count once. Timestamps are shown in canonical UTC, and a time more than five minutes in the future is dropped. Status and orient compute only what decides due: stale exposed learnings and named-check evidence clusters from the newest 128 evidence records by modification time, so their `counts` hold only `stale_exposed`, `review_required` and `failure_clusters` (named-check clusters only); the run journal, review observations and learning-body references are read only for the packet, which opens up to 1,024 evidence records. Only named-check clusters among those newest 128 records decide due, whoever asks, so status, orient and the packet agree: the packet's `due_clusters` lists the IDs of such clusters that span three plans and `max_cluster_plans` is the widest, while older clusters from its wider read are listed as context only. At most 4,096 entries of each record directory are read, and `omitted.directories` says when more were left; past that cap the scan is a sample in directory order, not the newest records, and nothing prunes the history. With `on`, three stale exposed learnings or one named-check failure cluster across three plans also makes consolidation due; run-journal clusters never do. Nothing in the section changes a learning.

A cluster is not an episode. To act on a failure cluster, capture an insight that names it, then cite that episode in an ordinary ADD or STRENGTHEN:

```bash
ae compound --insight --title "..." --body "..." --derived-from failure-cluster:<id>
```

The episode records `derived_from: failure-cluster:<id>` in its frontmatter. Harness checks only the format (`failure-cluster:` and 16 lowercase hex characters) and refuses the field on any other episode kind; a finding-cluster ID is refused with its own message, because finding clusters are informational. An empty or missing value is refused. It does not require the cluster to exist when the insight is written, because evidence history can be pruned or live in another checkout. The ID is a digest of the cluster key (the check or command name), not of specific records, so the applied learning names which cluster it answered; the packet that listed the cluster counts its evidence. When an ADD, STRENGTHEN, SUPERSEDE or MERGE consumes an insight episode citing a cluster (the same line on any other episode kind answers nothing), apply records `answers` and `answeredAt` on that ledger entry. It does this whatever the `knowledge.recheck` setting, so an answer given while re-check is off still counts once it is turned on. The cluster then clears in every branch, whatever branch recorded the answer, because the cluster is keyed by check name rather than by branch. Editing or deleting the episode file keeps the answer. `ae knowledge purge` of the episode removes its ledger entry and reopens the cluster. A failure timestamped after the answer, the same day included, also reopens it. A NOOP or a quarantine never answers a cluster, and neither does an `answeredAt` more than five minutes in the future. Failure clusters read only digest-named evidence history and count only named checks whose process failed (a nonzero exit, or any timeout). A check killed by a signal or that could not start is recorded `unavailable` and never clusters. Answer a broken reference or stale binding through SUPERSEDE; Harness never rewrites learning text itself.

Existing schema-1 proposals remain readable through the existing validator; new workflows use frozen packets. Existing knowledge modes and explicit human approval for suggest mode or authority expansion remain unchanged. Standing human retire, dispute and promotion decisions remain authoritative. A stale packet needs fresh source inspection and a new operation, not a blind replay. After applying a bounded packet, request another; omission counts preserve the remaining debt.
