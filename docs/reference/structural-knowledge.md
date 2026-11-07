# Structural evidence and impact context

AE keeps extraction and source validation inside the Harness CLI. Engineer chooses the question, inspects evidence and decides scope. Intent, plan, review and named-check authority remain unchanged.

## Ask a bounded question

```bash
ae graph deps src/orders/service.ts --depth 2 --limit 40 --json
ae graph dependents src/orders/service.ts --depth 2 --json
ae graph path src/api/orders.ts src/orders/repository.ts --json
ae graph explain src/api/orders.ts src/orders/service.ts --json
ae graph impact src/orders/service.ts --depth 2 --limit 40 --json
```

These are directed module-import relationships. `explain` returns supporting occurrences and resolver details. `impact` traverses reverse imports to affected candidates; it does not claim every caller or affected test. Live CLI/native paths prepare the shipped AST index when necessary; publication refusal, including the 10 MB table bound, returns explicitly labeled lexical evidence and a preparation reason. Source mutation still fails closed. Direct synchronous library queries can report a degraded lexical tier without a compatible prepared index. Read tier, scope, omissions and unresolved relationships before acting.

The default structural inventory covers recognized **Git-tracked source**, capped at 4,000 files and 200,000 bytes per file. Untracked callers are outside it. Complete inventory under this scope is not semantic completeness. AST syntax, lexical observations, resolver deductions and runtime observations have different guarantees. Qualified definitions and import bindings narrow candidates, but unsupported DI, Spring profiles, reflection, dynamic imports and generated code require further evidence.

AST JavaScript/TypeScript call candidates reject detected import shadows and require a supported direct named export. Private declarations, nested methods, default-export aliases, re-export routes and CommonJS export surfaces without supported provenance remain unresolved. Lexical named-import references remain labeled approximations for existing structural warnings; they do not establish call sites. Module-import observations remain available independently.

## Select evidence for the task

```bash
ae orient --read --context-version 2 --question-kind change-impact --file src/orders/service.ts --query 'change retry behavior' --json
ae orient --read --context-version 2 --question-kind dependency-path --file src/api/orders.ts --file src/orders/repository.ts --query 'trace persistence' --json
ae orient --read --context-version 2 --question-kind lookup --file src/orders/service.ts --json
ae orient --read --context-version 2 --question-kind prior-lesson --query 'retry ordering' --json
```

Select question kind explicitly. Ordinary orientation remains lightweight. `dependency-path` requires two files; at most four explicit seeds are accepted. Without seeds, eligible lookup/impact questions use lexical code search. A no-hit result needs a more specific symbol or path rather than an invented semantic match. Safe explicit lookup can inspect untracked files without adding them to the graph.

The v2 `slice.impactContext` contains `graphs`, occurrence-focused `sources`, `learnings`, `gaps`, `suggestedVerificationAreas`, coverage and content identity. Excerpts preserve source/representation hashes, exact ranges and redaction. The complete packet is bounded. Read a smaller batch when evidence clips or outer orientation returns a read barrier. Suggested verification areas are advisory paths and cannot select or waive named checks.

The native Harness tool accepts the same arguments. SessionStart and host-adapter reads preserve v2 `contextEvidence` beside the flat host slice, including coverage and barriers. Returned references do not prove that a model or editor consumed them.

## Immutable snapshots and currentness

```bash
ae index --structural --json
ae graph impact src/orders/service.ts --generation <returned-generation-id> --json
```

Use a returned generation identity. Selected generations read recorded facts and identify historical freshness; missing, corrupt, obsolete or evicted generations fail explicitly. They never fall back to live source. Existing retention keeps current and previous generations. New immutable table manifests authenticate historical reads; forward/reverse adjacency stays inside the same publication boundary.

Live freshness still validates bounded inventory, source bytes, recognized configuration and extractor identity. Reusing adjacency cannot justify checking only old nodes: new callers and previously missing targets can alter relationships. Configuration hashes detect change; they do not imply every build/framework configuration is understood. Differential fixtures compare normalized incremental output with clean rebuilds after source, inventory and config mutations.

## Self-contained parsing

Pinned ESM loader, runtime WASM and Java/JS/TS/TSX/Python grammars ship with license/provenance files. Loader and grammar hashes are verified. Ordinary offline installation needs no native parser bindings, build tool, extra executable or server, and performs no runtime download. Unsupported formats retain labeled lexical extraction.

The standalone test installs the actual archive with lifecycle scripts enabled and optional dependencies omitted, using a fresh offline cache, paths with spaces and a working directory outside the package. It parses all five languages, repacks the installed archive and rejects damaged grammar bytes. Installed-package proof remains separate from native editor acceptance.

## Learning applicability

New anchored learnings retain `applicability_version` and selected `{path, sha256}` source bindings. Retrieval and `ae learnings --why` compare them with current safe bytes and return `current`, `needs-review` or `unknown`, qualified as source bindings only.

Changed, missing or unsafe sources request review. Legacy, malformed, unavailable or foreign-repository bindings remain unknown. Even a comment-only edit can request review; it does not invalidate a general lesson by itself. Strengthening and promotion preserve old bindings instead of silently accepting changed bytes. Historical proof and claim status remain intact; no applicability result retires, promotes or verifies a learning. Golden/human authority and branch-local subordination remain unchanged. Memory is untrusted data.

## Qualification

The named `verify-structural-context` drive exercises actual CLI impact, citations, snapshots and packets. Run the separate multi-language corpus with `node packages/ae/eval/context/run-structural.mjs --out <new-external-directory>`. Its receipts are explicitly mechanical: model usage is unavailable and they cannot promote a context policy.

Live studies require frozen tasks, exact model identity, retention policy, budget and acceptance checks. Measure correctness, missed evidence, unsupported assertions, citations and abstention before time or tokens. Existing promotion requirements and legacy defaults remain unchanged. Mechanical tests establish no model-quality or productivity gain.

Use `ae diagrams graph` for a rendered dependency view. Its projections retain the additive graph evidence. Cited imports remain descriptive evidence, not runtime traces, architecture correctness or formal proof; flow diagrams separately retain their committed-default-branch model scope.

## Repository dependencies

Use the file graph when an orientation neighborhood needs more detail:

```bash
ae graph deps src/main.mjs --depth 2 --json
ae graph dependents src/service.mjs --depth 2 --json
ae graph path src/main.mjs src/audit.mjs --json
ae index --structural
```

Queries read current tracked source files and reuse extraction only when the
content hash matches. Dirty edits and deleted files affect the next query.
An uncached query uses lexical extraction and does not build an index.
`orient --read` advertises the commands without scanning the full graph.

The graph describes observed module imports. Relative paths and unique local
name matches have separate resolution labels; the latter are heuristics.
Lexical extraction is approximate, and dynamic runtime dependencies are outside
its guarantee. Stored symbol references are name matches, not an exact call
graph. `not-found` means no observed import path within complete reported
coverage. Missing files, parse errors, unresolved imports, source changes and
limits qualify absence as `unknown`.

Depth defaults to 1 for dependencies and dependents, and 8 for paths (maximum
32). Output defaults to 50 edges and unresolved imports (maximum 200 each).
Queries scan at most 4,000 tracked source files of 200 KB each and retain at
most 20,000 module edges and 4,000 unresolved imports. JSON reports coverage,
omissions, extraction tiers, a worktree snapshot hash and any reused generation.

Structural data lives locally under
`~/.ae/index/<repo-id>/<worktree-id>/structural/`. Each immutable
`generations/<id>/` contains `meta.json`, `files.json`, `symbols.json` and
`graph.json`; `current.json` selects one generation and records table hashes.
Each table is limited to 10 MB. Complete reads and publication share a short
lock, and publication retains the current and previous generations. A failed
publication preserves the previous selection. Busy or corrupt caches fall back
to current lexical facts for graph queries. Locks with a confirmed dead owner
can recover; missing ownership or interrupted recovery requires inspection.
Legacy flat indexes remain readable and upgrade on the next build; their
compatibility read cannot guarantee isolation from an older writer. The cache
is derived data and stays out of product repositories and Git.
