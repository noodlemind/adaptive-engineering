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

### Quoted evidence

A `publish` decision accepts an optional `evidence_quote`: the single most specific line of error, test output or diff text that showed the lesson, copied exactly rather than paraphrased.

```json
"evidence_quote": "AssertionError: expected 2, actual 1 (export keeps value)"
```

The quote is a single line of at most 600 bytes: a CR, LF, NEL or Unicode line or paragraph separator is refused, so pick the one failing line that shows the lesson. It may contain tabs but no other control characters (C0 or C1), no bidirectional, zero-width, invisible format, filler or tag characters, no blank glyphs such as the Braille blank, and no private-use, unassigned or lone surrogate characters, so strip terminal color codes. Emoji presentation is the exception: variation selectors 15 and 16, keycaps, and a zero-width joiner between two pictographs are accepted and shown as written. Text in any script, accented letters and combining marks are accepted.

Secrets are screened by token shape first, with no list of formats. The quote is split into tokens on whitespace, quotes, brackets, `,` `;` `=` `:` `@` `/` `\` and similar punctuation; `_`, `-`, `.` and `+` stay inside a token. A token of 20 or more characters that holds both a letter and a digit is refused when one of its parts between `.`, `-` and `_` is 16 or more characters mixing letters and digits, is 8 or more characters mixing upper case, lower case and digits, or mixes a non-ASCII letter with an ASCII digit. Hexadecimal hashes (7 to 64 characters) and UUIDs pass, and so do identifiers and paths made of short parts, such as `test_user_login_flow_v2` or `/home/user/отчёт_2024.pdf`. A run of 32 or more base64 characters holding `/` or `+`, upper case, lower case and digits, with no word-like piece, is refused too. Screening reads the text with invisible characters and combining marks removed and fullwidth letters folded, so a look-alike or broken token is seen whole. The shape rule may refuse an ordinary line with a long random-looking identifier, such as a ULID request ID or `shouldRetry3TimesWithBackoff`; quote a different line. A second layer refuses anything the known secret patterns or the shared redactor match, including key-value pairs such as `password=...` or `token: ...`, credentials in URLs, private key headers and bearer tokens.

`no-learning` decisions refuse the field. The `--evidence-quote` command-line flag is accepted only with `--insight` and never with `--learning-decision` (put the quote in the decision file); anywhere else, or with a missing value, it is a usage error. A value that is itself a flag of `ae compound`, such as `--json`, `--category=logic` or `-h`, must use the `--evidence-quote=<text>` form; other dash-led text, such as a diff line, is taken as the quote. Harness stores the quote as one escaped `evidence_quote` frontmatter line on the episode, leaves the body unchanged and never indexes the quote for recall. `/consolidate` sees it in the packet as one inert line under the same rules. The whole quote is withheld when it holds a secret (`[redacted: <pattern>]`), a token-shaped run (`[redacted: token-shaped]`) or a control sequence, when a hand-edited quote is over 4,096 bytes (`[redacted: oversize]`, not screened), and when the episode stores it as anything but one value on the key's own line: a line break, a duplicate key or a value folded onto an indented line gives `[redacted: multi-line]`, and an unclosed, flow, block, anchored or aliased value gives `[redacted: malformed]`. A trailing `# comment` after the value is ignored, as YAML ignores it. A hand-edited quote over 600 bytes is cut and marked `[truncated]`. Raw views of an episode (CLI file reads, lookup previews, review excerpts) show `evidence_quote: [withheld]` with the lines YAML reads as its value emptied, along with any stray lines after it up to the next well-formed `key:` line. They withhold the whole frontmatter when the key appears in any other form, when a quoted value is left open, or when any double-quoted key is spelled with a backslash escape (`"evidence\x5fquote":`); a manifest field is cut at either. Other spellings YAML would not read as `evidence_quote` are not treated as the key. The quote never enters a learning, so the 1,200-byte learning cap still measures only the claim. Omit the field when no short verbatim evidence exists; an absent field leaves the decision, its identity and the episode bytes unchanged. `ae compound --insight --evidence-quote "<text>"` applies the same contract to an insight.

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
