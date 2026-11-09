# Harness Tool Contract

**SSOT** for ae agent-runtime commands. Skills and `@engineer` **call ae**; harness does not invoke skills. `ae-harness` is the npm package; `ae` is the command.

Budget: [`context-budget.md`](context-budget.md)

## Two-tier boundary

| Tier | Location | Use when |
|------|----------|----------|
| **A — Harness CLI** | `ae` command from the `ae-harness` npm package or local clone | Same behavior needed across product repos (recall, gate, index, compound, validate-plan) |
| **B — Skill-local scripts** | `packages/ae/corpus/skills/<name>/scripts/` | Narrow, read-only validators for one skill only — **exception**, not default |

**Rule:** Cross-repo → harness command. Product-only → product check or script.

## Invocation (agents)

**Run commands with the `execute` tool** (`shell` / `bash` / `execute/runInTerminal`). `terminalLastCommand` only reads prior output — it cannot start `ae orient`, tests, or builds.

**Primary** — global CLI (after `ae install`):

```bash
ae <command> [args] --workspace . --json
```

Installed to `~/.copilot/bin/ae` on every `ae install`. Add to PATH with `ae install --configure-path`, or invoke as `node ~/.copilot/bin/ae …` from any directory.

**Install paths (all produce the same global CLI):**

| Method | Command |
|--------|---------|
| Checkout | `npm install -g ./packages/ae` from the repository root, then `ae install` |
| Local clone | `node packages/ae/bin/ae.mjs install --configure-path` |

**Per-repo bootstrap:** `ae init-repo` creates private project configuration in the external AE project store and `.harness/run.mjs` (delegates to the selected installation + sets `--workspace`). `ae init-repo --shared` explicitly publishes team configuration under `.github/harness/`. Review its returned commit inventory before locking product work. Existing shared configuration stays selected; user approval remains private.

- Select a deliberately installed AE version and inspect `ae --version`. The global runner does not enforce a product dependency pin or read `.harness-version`.
- If `ae` is not on `PATH`, install from a checkout of this repository with `npm install -g ./packages/ae` at the repository root, then `ae install --configure-path`. The package is not on the npm registry.
- Do not use `npx ae-harness` in agent runtime instructions. There is no published registry package to execute.
- Start with `.harness/context-pack.md` after `orient`. Expand missing evidence with `orient --read --context-version 2`; keep source identities and reported limits.
- Developers use Copilot agents/skills; they do not prompt the CLI directly.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Command completed; inspect its result |
| `1` | Failure |
| `2` | Usage refusal (`E_USAGE`) or command-specific advisory; inspect the result |
| `3`–`9` | Setup, approval, conflict, doctor, network, timeout, or target failure |
| `130` | Interrupted or cancelled |

A nonzero exit never establishes mutation or completion authority. Read stdout and stderr, including structured `ok:false` errors, and inspect the command-specific `pass`, `outcome` and advisory checks. An advisory result may be reported as such; `E_USAGE` means the operation was refused. Require the current passed gate and verification records before the corresponding next operation.

**Envelope versioning (Phase 1 workbench, additive).** `--output` is a lane-bearing, opt-in surface, not a blanket capability every command gained — only the commands named below accept it; every other registered command now REJECTS `--output` with a structured `E_USAGE` error (exit 2) naming the lane-bearing commands, instead of silently ignoring it and rendering plain ledger output (fixed post-P1.6; see `lib/registry.mjs`'s `assertLaneSupported`). The lane-bearing set today: `orient`, `learnings`, `status`, and the Phase 2 retrieval commands `search`, `lookup`, `tree`, `recall` and `get` accept `--output json-envelope|agent` (`--output=value` works too) — `json-envelope` wraps the command's result in a versioned `{schema, command, status, ...}` envelope, `agent` renders a budgeted plain-text summary for LLM callers; `verify` additionally accepts `--output jsonl`, streaming row-per-event with a terminal `result` row (no `json-envelope`/`agent` support of its own). `status` in all of these uses one shared vocabulary — `ok\|failed\|cancelled\|timed-out`, plus `blocked` where gate-like semantics already use it. These are opt-in, additive lanes: legacy results documented below (the default ledger render and `--json`) remain **unversioned** — no `schema` field or wrapper. Named-check truncation metadata is additive; retained diagnostics are bounded and sanitized as described below. Recognized secret redaction (Phase 1 AC6) is applied at one shared emission boundary (`lib/redact.mjs#redactedJson`) that every legacy serializer routes through before anything reaches stdout, so a payload that contains a registered secret emits `«redacted:<kind>»` where the credential used to be. Existing core fields remain available; a recognized credential value is redacted. Do not rely on `--output` for a command not named above — it will error, not silently no-op; a command's help (`ae help <command>`) also states whether it supports a lane.

## Command catalog

This table tracks only what differs in runtime character across commands — which turn a command runs on, whether it writes its own DOMAIN-SPECIFIC lifecycle event (the closed vocabulary in `lib/events.mjs#EVENT_TYPES` — `orient`, `gate`, `verify`, `compound`, `consolidate`, `remember`, `learning`, `knowledge`, plus the hook-only `session_start`/`pre_tool`/`post_tool`/`skill_activation`/`session_end`), and whether it mutates anything. This is separate from the dispatch-level `command.start`/`command.result` bracketing every registered command now also gets — see the footnote below the table. Sigs and flags: `ae help <command>` (the registry, `lib/registry.mjs`, is the single source of truth — the hand-written CLI CATALOG this line used to reference was retired in P1.6; `ae help`/`ae help <command>` render live from the same registry entries this doc is generated by hand from, so treat any drift you notice as a doc bug, not a second source of truth).

| Command | Tier | Events (domain-specific) | Store |
|---------|------|--------|-------|
| `install` / `upgrade` | human/CI | none | mutates `~/.copilot/` |
| `doctor` | human/CI | none | read-only (`--host vscode` runs an isolated hook-lifecycle fixture) |
| `init-repo` | human/CI | writes¹ | writes private project configuration, local runtime state and Git-local excludes; `--shared` publishes team configuration |
| `prepare` | human/CI | none | writes `docs/specs/overview.md` and `docs/adr/0000-architecture.md` only when missing |
| `status` / `uninstall` | human/CI | none | read-only / mutates `~/.copilot/` (uninstall removes hydrated files) |
| `orient` | agent-runtime | writes | mutates `.harness/` (context-pack, repo-map, session) |
| `recall` | agent-runtime | writes¹ | read-only |
| `gate` | agent-runtime | writes | mutates session state |
| `verify` | agent-runtime | writes | mutates (evidence file + session) |
| `validate-plan` | agent-runtime | writes¹ | read-only |
| `plan-new` | agent-runtime | none | writes a plan in the current project's Harness store (`--stdout` prints instead) |
| `plan-update` | agent-runtime | none | mutates the plan file |
| `worktree` | agent-runtime | none | mutates git worktrees under `.worktrees/<slug>` |
| `index` | agent-runtime | writes¹ | mutates the knowledge index (`--status` read-only); `--structural` mutates `~/.ae/index/<repo-id>/<worktree-id>/structural/` |
| `get` | agent-runtime | none | read-only |
| `search` | agent-runtime | none | read-only (never creates the knowledge store) |
| `lookup` | agent-runtime | none | read-only (never creates the knowledge store) |
| `tree` | agent-runtime | none | read-only (never creates the knowledge store) |
| `compound` | agent-runtime | writes | mutates (index + solution doc + telemetry) |
| `consolidate` | agent-runtime | writes | read-only (`--status`/`--candidates`); mutates the learnings store (`--apply`/`--rebuild --yes`) |
| `remember` | agent-runtime | writes | mutates the learnings store |
| `learning` | agent-runtime | writes | mutates the learnings store + governance ledger |
| `learnings` | agent-runtime | none | read-only |
| `knowledge` | agent-runtime | writes | mutates `config.json`, cascade-deletes, or mirrors to the product repo |
| `eval-knowledge` | agent-runtime | none | read-only |
| `events` | agent-runtime | none³ | read-only |
| `report` | agent-runtime | none | read-only (`--sync` writes `~/.ae/telemetry/`) |

¹ `init-repo`/`recall`/`validate-plan`/`index` historically called `writeEvent` (types `init_repo`/`recall`/`validate_plan`/`index`) while those four type strings were absent from the `EVENT_TYPES` allow-list (`events.mjs`), so the calls silently no-opped. The allow-list now includes all four (harness evolution Phase 1 hygiene) — the events record in `events.jsonl` like every other lifecycle write, in ADDITION to the dispatch-level bracketing of footnote ².

² **Every registered command dispatch (P1.6, `lib/registry.mjs`) is bracketed with `command.start`/`command.result` telemetry, independent of the domain-specific "Events" column above** — this is a dispatch-pipeline concern, not a per-command opt-in, so it applies uniformly regardless of whether that column says "writes" or "none". Two commands opt out — `events` and `report`, the two that read `events.jsonl` themselves (footnote ³). A real, observable side effect: running any instrumented registered `ae` command — every one except the two that opt out above — including ones whose Events column says "none", like `get`, `learnings`, or `eval-knowledge` — creates/appends `.harness/events.jsonl` under whatever `--workspace` resolves to (default: the current directory), in ANY cwd, even one with no other `.harness/` state. Opt out with `--no-events`, `--dry-run`, or `HARNESS_NO_EVENTS=1` (all three short-circuit `lib/events.mjs#writeEvent` before anything is written, for both the domain-specific events above and this dispatch-level bracketing).

³ `events` and `report` are the two commands excluded from footnote ² (`entry.instrument === false`, `lib/registry.mjs`) — neither emits `command.start`/`command.result` for its own dispatch. For `events`, its own handler's job is reading and summarizing everything already in `events.jsonl`, so bracketing its own dispatch would append that very invocation's own `command.start` to the file an instant before the handler reads it back — a self-referential read-your-own-write that would inflate `ae events`'s own totals on every call. `report` opts out for the same reason (it reads `events.jsonl` via `loadReportEvents`, and `--sync` would copy the phantom row into the global store).

**Query construction (deterministic-retrieval discipline):** build `--query` from the user's salient nouns and identifiers **verbatim** (e.g. `SYSTEM-OVERRIDE`, `payment`, `token`) — do not paraphrase intent into synonyms. The retrieval tokenizer normalizes identifier formats and morphology, but it cannot recover a term the query never contained. Passing the literal request terms is what keeps recall stable across phrasings.

**Brownfield starters.** `ae prepare` writes `docs/specs/overview.md` and `docs/adr/0000-architecture.md` when those paths are absent. It does not call a model. A second run skips a file that already exists, including an empty file or a symlink. A directory at the path, or a symlink ancestor that leaves the repo, is refused and nothing is published outside the workspace. A gitignored path is not written; orient says to un-ignore `docs/specs` and `docs/adr`. Orient discovers written files as `intentSources`. `docs/codebase-map.md` is not an intent source.

**Repository and knowledge freshness.** Structural currentness binds HEAD, tracked source paths, readable source bytes, resolver configuration, and extractor revisions. Dirty changes invalidate current-only map, neighborhood, symbol-search, and symbol-lookup reads. Historical baseline readers remain available for structural comparisons. Orientation falls back to lexical facts when the current index is unavailable. Extraction remains bounded and heuristic. SQL and HCL use lexical fallback. Version two reports missing inputs, scan limits, omitted evidence, and unverified semantic completeness. An explicitly selected new file can contribute facts without indexing unrelated untracked files.

`orient` and `orient --read` share fact collection. Default read output retains its current fields and cold reads write no context artifacts. `--context-version 2` adds source-bound evidence, task and policy identities, coverage, and artifact accounting. Source or policy changes during assembly produce a refresh requirement. A query-bearing read records the snapshot used for later edit checks. This metadata does not replace plan, trust, review, or completion authority.

`get --context-version 2` adds bounded surrounding context and source ranges. `get --path <path@sha256:hash>` and file lookup refuse changed bytes. Version 2 search supplies the hashed source excerpt separately from its ranking snippet. Its cursors bind the query, selection policy, and source generations. Legacy cursors also reject changed recorded generations. The knowledge index remains an explicit rebuild through `ae index`; historical memory remains untrusted evidence.

The optional agent runtime keeps legacy context and retention defaults. `--context-policy selective` supplies seed files and import neighbors. `subsystem` adds tracked files under seed directories. Both refresh before each request, cap the additional evidence block, and report omissions. `--retention-policy structured` reloads existing task records and retains unresolved failures and mutation receipts. Older reads become source references. These are experimental policies, not claims of measured task improvement.

Context accounting uses existing events and reports. Artifact estimates, runtime requests, and host observations remain separate because they may overlap. Request records retain sizes and usage, not prompt bodies. `context.accounting` records completed and failed model attempts. Unknown host input remains unavailable.

**Structural index.** `ae index --structural [--since <ref>]` publishes coherent, checksummed generations under `~/.ae/index/<repo-id>/<worktree-id>/structural/`. Current reads validate source bytes, tracked inventory, resolver configuration and extractor revisions. Old indexes without that state require a rebuild. Incremental reuse validates content hashes; metadata and `--since` are provenance hints. Pinned Tree-sitter Java/JS/TS/TSX/Python WASM assets ship inside AE and retain integrity checks. SQL, HCL and unsupported inputs use labeled lexical extraction. Damaged parser assets require repair of the AE package, not another installation. Table and extraction caps remain explicit. Historical generations remain separate from live facts. Raw tables do not enter the compact pack.

`graph explain <file> <target>` and `graph impact <file>` return bounded observed imports, occurrence citations, method and resolution status. Live CLI/native paths prepare the shipped AST index as needed; `--dry-run` does not publish an index. `--generation <id>` reads only a retained immutable historical generation, with independent table hashes and no fallback to current source. Coverage is bounded Git-tracked inventory rather than semantic completeness. Candidate calls cannot establish runtime behavior.

`orient --read --context-version 2 --question-kind change-impact|dependency-path|lookup|prior-lesson` selects a bounded source packet in `slice.impactContext`. Select up to four explicit `--file` seeds. The packet includes graph relationships, hash-validated occurrence excerpts, applicability-bearing learning records, omissions and advisory verification areas. It grants no check or mutation authority. SessionStart/host adapters retain v2 evidence beside their flat slice. Learning applicability compares selected source bytes; historical proof and governance remain separate. Legacy records remain unknown until explicitly bound. Read `<copilot-home>/skills/codebase-context/references/structural-evidence.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/codebase-context/references/structural-evidence.md --json` prints the same file.

**index --structural**
```json
{
  "pass": true,
  "exitCode": 0,
  "dir": "~/.ae/index/<repo-id>/<worktree-id>/structural",
  "written": true,
  "sha": "<head-sha>",
  "baseSha": null,
  "tier": "treesitter",
  "filesIndexed": 42,
  "reparsed": 3,
  "reused": 39,
  "removedFiles": 0,
  "parseFailures": 0,
  "grammarVersions": { "javascript": "0.23.1", "typescript": "0.23.2", "tsx": "0.23.2", "python": "0.23.6", "java": "0.23.5" },
  "missingGrammars": [],
  "integrityFailures": [],
  "truncated": { "files": false, "symbols": false, "symbolDetail": false, "moduleEdges": false, "callEdges": false, "unresolved": false },
  "sinceIgnored": null,
  "priorUnreadable": [],
  "delta": { "added": { "count": 1, "names": ["chargeV2"] }, "removed": { "count": 0, "names": [] }, "changed": { "count": 0, "names": [] } }
}
```

### JSON shapes (stable fields)

**orient**
```json
{
  "recall": [{ "docid": "...", "path": "...", "title": "...", "score": 0.82, "summary": "...", "snippet": "...", "ranker": "bm25" }],
  "learnings": [{ "id": "domain/slug", "trigger": "...", "claimLine": "...", "status": "provisional", "advisory": false, "score": 0.42 }],
  "explain": null,
  "learningsBytes": 0,
  "plans": [{ "path": "docs/plans/...", "status": "planned", "plan_lock": true, "score": 0.67 }],
  "activePlan": { "path": "...", "status": "...", "plan_lock": true },
  "planGoal": {
    "planPath": "docs/plans/...",
    "intent": "...",
    "success_criteria": ["..."],
    "expected_outputs": ["..."],
    "intentContractExcerpt": "..."
  },
  "contextPack": ".harness/context-pack.md",
  "intentSources": [{ "path": "docs/specs/checkout.md", "kind": "spec" }],
  "worktree": { "blocked": false, "linked": true, "onDefault": false, "isolated": true, "skipReason": null },
  "gateStatus": "pass|blocked",
  "blockedReason": null,
  "nextTools": ["ae worktree --slug checkout-retry", "read docs/specs/checkout.md", "ae gate --phase implement"]
}
```

**gate / validate-plan**
```json
{
  "pass": true,
  "exitCode": 0,
  "plan": { "path": "...", "status": "...", "plan_lock": true },
  "checks": [{ "id": "C1", "pass": true, "message": "...", "severity": "ok|warn|fail" }],
  "blockedReason": null,
  "nextTools": []
}
```

For locked plans, both commands enforce criterion-to-check mappings and configured-check relevance. A `planned` plan must leave new criteria and tasks unchecked, and a schema-focused check cannot satisfy outputs that contain no schema artifact. The implement gate repeats these readiness checks so skipping `validate-plan` cannot bypass them, and `verify` refuses to execute named checks when readiness fails.

**verify**
```json
{
  "outcome": "passed",
  "plan": "docs/plans/example-plan.md",
  "checks": [{ "id": "scope", "status": "passed", "message": "...", "severity": "enforce" }],
  "advisoryFailures": [],
  "refusedSeverityDowngrades": [],
  "unverifiedCriteria": [],
  "scopeViolations": [],
  "openHardGaps": [],
  "requiredReviews": [],
  "enforcement": "enforce",
  "binding": {
    "base": "<git-ref>",
    "planDigest": "<sha256>",
    "changedFiles": ["src/example.ts"],
    "workspaceDigest": "<sha256>"
  },
  "evidencePath": ".harness/evidence/example-plan.json"
}
```

Allowed outcomes are `passed`, `failed`, and `inconclusive`. Only fresh `passed` evidence bound to the current plan contract, base ref, changed-file set, and workspace contents permits a delivery completion claim or compound. Plan Activity entries are excluded from the contract digest so the append-only ledger can record the returned evidence path. Read-only Answer and Investigate modes do not run delivery verification. Plan frontmatter names checks; executable argv arrays come only from the selected local or shared check source reported by `ae checks list --json` and run without a shell. Approved one-off commands run outside harness through explicit host tool approval and are recorded as external evidence.

Use focused TDD checks during implementation. The Engineer prepares a review packet, dispatches its required judgment, and assembles raw results before running authoritative `ae verify`. Read-only coordinators cannot start CLI commands using `terminalLastCommand`; incomplete coverage remains a verification prerequisite. Under content-v1, selected intent bytes are also bound and changed bytes require an explicit source amendment. Legacy plans retain their declared paths-only guarantee until deliberately migrated.

**Per-check severity (policy v2).** The selected project `policy.yaml` may declare `version: 2` with an optional `checks:` map assigning each verify check a severity — the check-level knob is orthogonal to the run-level `enforcement` mode:

| Severity | Effect of a failed check |
|----------|--------------------------|
| `enforce` | Fails verification (v1 behavior; default for every check without a policy entry or built-in default) |
| `warn` | Degrades the outcome to `inconclusive` (exit 2 under enforce) |
| `advisory` | Reported only — never affects outcome or exit code |

Every check in the `verify` payload carries its effective `severity`; non-passing advisory checks are additionally listed under `advisoryFailures` (with their findings) so an exit-neutral signal is never silently lost. A v1 policy file (no `checks:` map) behaves exactly as before.

`advisory` is refused for the built-in gating checks at policy load (error names the check and points at `warn`), and — because a policy file is plan-agnostic — it is also refused per run for any check the ACTIVE PLAN gates on: everything in `verification.required` plus every check mapped under `verification.criteria`. That refusal does not abort the run (aborting would write no evidence at all, failing open): the downgrade is ignored, the check runs at its built-in default severity, and the run reports it in `refusedSeverityDowngrades` (`[{ "id": "team-lint", "requested": "advisory", "effective": "enforce" }]`) plus a `warn` line on the CLI. `warn` stays available for every check, including plan-required ones.

**Sanitized check payloads.** Every check `message`, `findings`, and `informational` payload in the `verify` result is secret-redacted, flattened to one line, and capped (240 chars per string, 20 entries per list, 50 findings) before it reaches `--json`, `.harness/evidence/*.json`, or the event log — those fields carry current-side repo text (extracted symbol names, plan-declared expectations) with no length bound of their own. A check's `id`, `status`, `severity`, and numeric fields pass through unchanged. Named check `stdout`/`stderr` retain up to 4000 characters of content from the beginning and ending of each stream, with a truncation marker and omitted-character metadata. Raw-stream observation detects recognized secrets before truncation: a detected private key or a truncated secret-bearing stream is suppressed; intact ordinary secrets are redacted. Retained output stays multi-line.

**structural-expectations (built-in verify check, advisory by default).** Compares the structural diff of the change against the plan using the structural index at `~/.ae/index/<repo-id>/<worktree-id>/structural/` (`files.json`/`symbols.json`/`graph.json`/`meta.json` — shape contract in `packages/ae/lib/structural/shape.mjs`). Flags: changed **exported** symbols in files outside `## Impacted Files` (`unplanned-symbol-change` — export flags come from the index, so a purely local addition never fires); removed exported symbols whose callers in the graph survive the change (`removed-symbol-with-callers`); unmet plan-frontmatter `structural_expectations:` entries marked `required: true` (`unmet-required-expectation` — unmarked entries stay informational). The check never asserts what it could not compare: a missing index or a baseline `meta.sha` that is not an ancestor of HEAD reports `skipped`; a per-file extractor-tier mismatch (`tier-mismatch-skipped`), a changed file in a language it cannot read (`file-not-evaluated` / `expectation-not-evaluated`), and findings computed from a table that hit an index build cap (`<finding>-informational`) all stay informational; and a run where NOTHING was compared reports `skipped`, never `passed`. `skipped` never affects the outcome at any severity. Policy `checks: { structural-expectations: { severity: warn|enforce } }` opts the flags into blocking.

**Learning attribution (cited half).** `orient` records the learning ids it surfaced in a session; `verify --learnings <id1,id2>` closes the loop by recording the ids the skill actually applied while doing the work — pass only ids that materially changed an action, not every id the pack mentioned. `orient` also records `learningsBytes` on its own event — the post-truncation byte size of the "## Learnings (memory)" section actually injected into the pack — which `ae report`'s token ledger sums into an approximate injected-token count (`slos.knowledgeTokens`), a cost figure only, never a "tokens saved" claim. `ae report` derives knowledge-layer utilization from cited ÷ surfaced across the event log (both a unique-id rate and an occurrence-weighted rate), and `ae doctor` warns when the weighted utilization stays under 15% with 20+ surfaced occurrences.

**recall**
```json
{ "query": "...", "recall": [{ "docid": "...", "path": "...", "title": "...", "score": 0.5, "snippet": "...", "ranker": "bm25|overlap" }], "plans": [] }
```

**get**
```json
{ "docid": "...", "path": "...", "title": "...", "excerpt": "...", "bytes": 512, "lines": 12 }
```

**compound**

For delivery completion, submit a publish or explicit no-learning decision with `ae compound --plan <path> --learning-decision <file> --json`; see [learning-operations.md](learning-operations.md). A bare legacy compound call does not record the required decision. Then pipe a revision-bound complete decision to `ae plan-update --plan <path> --file - --json`; see [plan-operations.md](plan-operations.md). The legacy result shape below remains readable; use the returned decision/publication record for the current operation.

```json
{
  "pass": true,
  "exitCode": 0,
  "indexed": { "entries": 12, "manifestPath": "..." },
  "verificationEvidence": { "outcome": "passed", "evidencePath": "..." },
  "telemetry": { "updated": ["engineer"] },
  "nextTools": ["/auto-compound", "/compound-learnings"]
}
```

**events**
```json
{
  "count": 2,
  "summary": { "total": 2, "pass": 1, "warn": 0, "fail": 1, "lastActivePlan": "docs/plans/example-plan.md", "latestBlockedReason": "..." },
  "events": [{ "version": 2, "type": "pre_tool", "session": "...", "host": "vscode", "tool": "replace_string_in_file", "targets": ["src/example.ts"], "gate": "missing", "decision": "block", "durationMs": 4 }]
}
```

**consolidate** (`--status` default shown; `--candidates` returns `{ schema, contract, clusters, learnings, domains, governed, storeDir }` — `governed: [{ id, action }]` lists every id a human already retired/disputed/promoted so the skill doesn't propose an op a governed write would just reapply over, and each cluster episode carries its raw `kind` (`fix`/`insight`/`human-teaching`), never flattened, so a rebuild-regenerated op can re-derive `source: human`; `--apply` returns `{ applied, rejected, committed, exitCode, governed }` — `applied[].op` includes `MERGE`, `rejected[].code` includes `E_DOMAIN_CAP`, `governed: [{ id, action }]` lists ids whose regenerated write just reapplied a standing retire/dispute/promote decision (always `[]` on a dry run); `--rebuild --yes` returns `{ pass, exitCode, archived, debt, nextTools }`)
```json
{
  "mode": "on",
  "due": true,
  "debt": 6,
  "threshold": 5,
  "learnings": { "active": 12, "total": 14 },
  "domains": [{ "domain": "sql", "active": 12, "cap": 25, "atCap": false }],
  "promotionCandidates": [{ "id": "sql/adding-not-null-columns-to-hot-tables", "verified": 3, "plans": 2 }],
  "quarantined": [],
  "nextTools": ["ae consolidate --candidates"]
}
```

**remember**
```json
{
  "pass": true,
  "exitCode": 0,
  "episodePath": "docs/solutions/teachings/2026-07-27-adding-not-null-columns-to-hot-tables.md",
  "learningId": "sql/adding-not-null-columns-to-hot-tables",
  "blockedReason": null,
  "nextTools": ["ae learnings sql"]
}
```

**learning** (`<retire|dispute|confirm>` shown; `promote <id> --to <path>` returns the same shape with `status: "promoted"`)
```json
{ "pass": true, "exitCode": 0, "id": "sql/adding-not-null-columns-to-hot-tables", "status": "retired", "blockedReason": null }
```

**learnings** (default listing; `--why <id>` returns the single-learning provenance shape shown second; `status` can be `active|provisional|disputed|retired|superseded|promoted`)
```json
{
  "learnings": [{ "id": "sql/adding-not-null-columns-to-hot-tables", "status": "active", "source": "human", "trigger": "...", "verified": 3, "plans": 2, "promotionEligible": true, "failures": 0 }],
  "counts": { "active": 12, "total": 14 },
  "quarantined": [{ "path": "docs/solutions/...", "sha256": "..." }]
}
```
```json
{
  "id": "sql/adding-not-null-columns-to-hot-tables",
  "trigger": "...",
  "claimLine": "...",
  "status": "active",
  "source": "human",
  "lastConfirmed": "2026-07-20",
  "supersededBy": null,
  "promotedTo": null,
  "mergedFrom": null,
  "episodes": [{ "path": "docs/solutions/...", "kind": "fix", "plan": "docs/plans/..." }],
  "verified": 3,
  "plans": 2,
  "promotionEligible": true,
  "failures": 0
}
```

**knowledge** (`--status`/default shown, returns `{ mode, commit }`; `<on|suggest|off|freeze|capture-only>` returns `{ pass, mode }`; `commit <none|repo>` returns `{ pass, commit }`; `purge` returns the shape below)
```json
{ "mode": "on", "commit": "none" }
```
```json
{ "pass": true, "exitCode": 0, "removed": { "episode": "docs/solutions/...", "learnings": ["..."], "links": ["..."], "ledger": 1 }, "blockedReason": null }
```

**knowledge status** — read-only layer-aware report (golden per-domain counts, branch-bucket rows when buckets exist, recall-index drift). Emits a `knowledge` event; never creates or mutates the store. Bucket `promotable` is derived from the key shape (`detached-*` is never promotable); `ancestryOk: false` marks a bucket whose recorded base is not an ancestor of the current HEAD (excluded from the read overlay).
```json
{
  "pass": true,
  "exitCode": 0,
  "storeExists": true,
  "mode": "on",
  "commit": "none",
  "context": { "branch": "feature/x", "branchKey": "feature-x-1a2b3c4d", "detached": false },
  "golden": { "active": 12, "total": 14, "domains": [{ "domain": "sql", "active": 12, "total": 14 }] },
  "buckets": [{ "key": "feature-x-1a2b3c4d", "branch": "feature/x", "baseSha": "<sha>", "ageDays": 3, "promotable": true, "active": 2, "total": 2, "promoted": 0, "prunable": false, "ancestryOk": true }],
  "drift": { "indexed": true, "stale": false, "commitsSince": null, "filesChanged": null, "recommendation": "index is current with HEAD" }
}
```

**knowledge promote** — emits a reviewable, digest-bound branch→golden op-set at `.harness/promote-ops.json` (never writes the store itself); applied only through `consolidate --apply` in promotion mode, where evidence re-validates from the sha256s recorded at branch-apply time, rejections never record quarantine strikes, promoted sources are tombstoned `promoted_to_golden:` (a retrieval exclusion), and an `absorb-branch` audit entry lands in the governance ledger (audit-only — the replay never lets it become an id's standing decision). `--all` chunks under the 5-op delta contract with deterministic id ordering as the cursor and `remaining: N` reporting. Detached-HEAD buckets (`detached-*`) are never promotable — derived from the key shape.
```json
{ "pass": true, "exitCode": 0, "opsPath": ".harness/promote-ops.json", "ops": 2, "remaining": 0, "skipped": [{ "id": "sql/x", "reason": "standing governance decision: retire" }], "bucketKey": "feature-x-1a2b3c4d", "nextTools": ["ae consolidate --apply --ops .harness/promote-ops.json"] }
```

**knowledge prune** — deletes branch buckets (`--branch <key>`, `--merged` via workspace git state plus fully-tombstoned buckets, `--stale <days>`; selectors combine). Human authority, never mode-gated — exactly like purge. Removal is one store commit.
```json
{ "pass": true, "exitCode": 0, "removed": ["feature-x-1a2b3c4d"], "blockedReason": null }
```

**eval-knowledge** — deterministic retrieval PROXY (hit/false-surface/token cost per arm on a temporally held-out split); never a model-graded net-benefit number, and no benefit claim is published from it
```json
{
  "pass": true,
  "exitCode": 0,
  "split": { "train": 8, "heldOut": 4, "cutoff": "2026-07-10", "undated": 0, "unscorable": 1 },
  "arms": {
    "none": { "hitRate": 0, "falseSurfaceRate": 0, "injectedTokens": 0 },
    "frontmatter": { "hitRate": 0.5, "falseSurfaceRate": 0, "injectedTokens": 140 },
    "wholeIndex": { "hitRate": 1, "falseSurfaceRate": 0.083, "injectedTokens": 260 },
    "bm25": { "hitRate": 0.75, "falseSurfaceRate": 0, "injectedTokens": 90 }
  },
  "recommendation": "whole-index"
}
```

DOMAIN-specific lifecycle events (the `EVENT_TYPES` allow-list a command names for its OWN event, distinct from the dispatch-level `command.start`/`command.result` bracketing — see the Command catalog table's footnote ²) are limited to `session_start`, `orient`, `gate`, `pre_tool`, `post_tool`, `skill_activation`, `verify`, `compound`, `consolidate`, `remember`, `learning`, `knowledge`, `session_end`, `init_repo`, `recall`, `validate_plan`, and `index` (the last four were formerly dropped by the allow-list despite their call sites — fixed as harness evolution Phase 1 hygiene; see the Command catalog table's footnote ¹). The dispatch pipeline adds three more types of its own — `command.start`, `command.result`, and `agent_lane` (P1.6, `lib/registry.mjs` / `lib/agent-lane.mjs`) — which are never named by a command. Non-lifecycle commands `get`, `report`, `learnings`, and `eval-knowledge` never call `writeEvent` under their OWN domain type — but post-P1.6 they are not event-free: every registered command's dispatch is still bracketed with `command.start`/`command.result` regardless (footnote ² again), so all four DO append to `events.jsonl`, just never under a `get`/`report`/`learnings`/`eval-knowledge`-named event. Every append-attempting command never stores prompt or query content; `skill_activation` stores only the skill and session binding.

## Host hook boundary

- VS Code user hooks are installed under `~/.copilot/hooks`; `--configure-vscode` merges `chat.hookFilesLocations` without replacing unrelated settings.
- `PreToolUse` recognizes supported editor and terminal payload variants, requires a fresh explicit implement gate, blocks direct `.harness/` state mutation except a contained regular decision-input file, fails closed on unresolved mutation targets, and returns structured `permissionDecision: deny` output when blocked. Opaque terminal execution requires an exact current trusted planned named check. The gate records a SHA-256 digest of the plan, so a later plan edit requires rerunning the gate before product mutation.
- `PostToolUse` records successful governed edits and potentially mutating terminal attempts, including failed terminal commands and opaque execution with unknown effects, as pending verification. It separately records successful on-demand skill activation. Primitive mutation requires `create-primitive` activation in the current session; plan metadata alone cannot satisfy it.
- `Stop` returns a structured block until current completion and fresh passed evidence are bound after the latest recorded potential mutation. Read-only sessions remain free of completion ceremony.
- `ae doctor --host vscode` proves the installed V1–V9 lifecycle in an isolated fixture. If hooks are unavailable, explicit CLI gate/verify is degraded evidence and must not be described as native hook enforcement.

## Context budget mapping

| Tier | Max | Harness enforcement |
|------|-----|---------------------|
| F0 Frozen | 600–900 tokens | Thin `engineer.agent.md` — identity, task modes, canonical delivery lifecycle, guardrails, core actions |
| F1 Recall | 2048 bytes | Start with `context-pack.md`; expand missing evidence through version-two reads |
| F2 Plan slice | ~1500 tokens | Read plan sections from `activePlan.path` on demand |
| F3 On demand | skill-defined | Load gate/delegation refs when `gate` fails |

After orient, start with at most three memory matches and expand the required sections per [`context-budget.md`](context-budget.md). Goal lives in the active plan — `orient` surfaces it in context-pack `## Goal (Intent Contract)`; no separate goal file or CLI command.

## Skill integration

| Skill | Harness command(s) |
|-------|-------------------|
| `@engineer` Deliver mode | proportional `orient` → read pack → start/gate → focused TDD → required review prepare/assemble → `verify [--learnings <ids>]` → `compound --learning-decision` → complete plan-update decision |
| `@engineer` Answer/Investigate modes | minimal reads → evidence-backed report; no `plan-new`, delivery gate, verification, or compound |
| `/recall` | `orient` or `recall` (`-c`, `--min-score`) |
| `/index-memory` | `index` (manifest + BM25 postings) |
| `/auto-compound` | classify durable learning or no-learning, then publish through `compound --learning-decision`; Engineer records completion |
| `/code-review` plan-compliance audit | `validate-plan`, `gate` |

Investigate starts with a short list of questions and records findings with file:line refs in chat, or one notes file if long. A large scope splits by repo or area across parallel researchers, one narrow question each. Pick each researcher's model with the `researcher` role rule in `<copilot-home>/skills/references/subagent-context-packet.md`. A plan starts only when the user asks for a change and the mode switches to Deliver.

## CI examples

```yaml
- run: ae validate-plan --plan "$PLAN" --workspace . --json
- run: ae gate --phase implement --plan "$PLAN" --workspace . --json
- run: ae verify --plan "$PLAN" --base "$BASE_SHA" --enforcement enforce --workspace . --json
```

## Related

- [`tool-native-loop.md`](tool-native-loop.md)
- [`packages/ae/README.md`](../../../README.md)
