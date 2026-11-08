# Harness Evolution Blueprint: Local-First Adaptive Engineering System

Status: **approved.**
The `## Human Decision` section records approval on 2026-08-06; its listed conditions
remain binding on every implementation phase (per Decision Handling semantics in
`<copilot-home>/skills/references/capability-gap-proposal.md`, read with the host read tool. Outside the enforce hook, `ae get --reference skills/references/capability-gap-proposal.md --json` prints the same file).
This document is the approved design, not a behavior reference — current behavior is
documented in `docs/adaptive-engineering.md` and the harness tool contract as each phase ships.

This blueprint adapts nine externally supplied proposals — a two-layer golden/branch-local
knowledge model, deterministic retrieval, structural codebase indexing, layer-aware
compounding, structurally enriched plans and verification, knowledge lifecycle commands,
multi-project/worktree hardening, local token budgeting, and provenance governance — onto
the existing Adaptive Engineering architecture. It maps each proposal to what already
exists, what is genuinely new, and how the new parts compose with the contracts pinned by
`docs/adaptive-engineering.md` and the harness test
suite. Two proposals arrive largely satisfied and are marked verify-and-document.

## 1. Fixed decisions

Two design decisions were made by the repository owner during intake and are normative for
every section below. Alternatives are not reconsidered.

- **D1 — Branch-local knowledge extends the existing external store.**
  The two-layer model is implemented *inside* `~/.ae/knowledge/<repo-id>/`: golden
  remains the existing `learnings/` tree; branch-local is a new `branches/<branch-key>/`
  sibling. The raw proposal's in-repo `.harness/knowledge/golden|branches/` layout is
  rejected: it would not survive `git clean`/re-clone, would duplicate state per worktree,
  and would abandon the store's single-writer lock, transaction/rollback,
  commit-per-change history, and governance ledger.

- **D2 — Structural parsing adopts web-tree-sitter as an optional tier.**
  Lazy-loaded WASM grammars sit behind the existing injectable `extract` parameter of
  `buildRepoMap` (`packages/ae/lib/repo-map/index.mjs`). The lexical extractor
  remains the zero-install default and permanent fallback; grammar absence is silent,
  never an error.

## 2. Current-architecture anchors

| Subsystem | SSOT | Contract relevant here |
|---|---|---|
| T2 store identity + transactions | `packages/ae/lib/knowledge/store.mjs` | `repoId` = normalized origin remote + 8-hex hash; CLI-managed local git repo shared by every worktree/clone; `.lock` single-writer; commit per mutation |
| Sole learning writer | `packages/ae/lib/knowledge/apply.mjs` | Ops `ADD/STRENGTHEN/SUPERSEDE/MERGE/NOOP`; byte/ops/domain caps; secret scan; imperative lint; quarantine |
| Governance ledger | `store.mjs` `readGovernance` | Append-only `governance.jsonl`; latest-per-id replay; `action: promote` is sticky/terminal |
| Learning retrieval | `packages/ae/lib/knowledge/retrieve.mjs` | Top-3 injection, provisional damp, status exclusions |
| Orientation + context pack | `orient.mjs`, `context-pack.mjs` | Fully deterministic, no model calls; 2048-byte pack; priority-ordered sections; untrusted-memory preambles; `inertLine` + secret redaction at the data boundary |
| Document recall | `bm25.mjs`, `postings-index.mjs`, `recall-rank.mjs` | BM25 + weighted-overlap fallback |
| Repo map (structural, lexical tier) | `repo-map/index.mjs`, `lexical-extractor.mjs` | Injectable `extract(rel, content)` seam |
| Index staleness | `index-status.mjs` | `meta.headSha` stamp; drift signals |
| Verification evidence | `verify.mjs`, `evidence.mjs` | Binding `{base, planDigest, changedFiles, workspaceDigest}` |
| Events | `events.mjs` | `EVENT_TYPES` allow-list (known latent gap: `init_repo`/`recall`/`validate_plan`/`index` writes are silently dropped; `knowledge`-type events already flow) |
| Doctor | `doctor.mjs` | H1–H17, K1–K4, V1–V9 |
| Capability governance | Read `<copilot-home>/knowledge/capability-registry.yaml` and `<copilot-home>/skills/references/capability-gap-proposal.md` with the host read tool. Outside the enforce hook, `ae get --reference knowledge/capability-registry.yaml --json` and `ae get --reference skills/references/capability-gap-proposal.md --json` print the same files. | Lifecycle + registry mutation rules |
| Memory model + threat model | `docs/adaptive-engineering.md` | Three tiers, one writer each; day-granular episode dates are load-bearing |

## 3. Per-proposal mapping

### P1 — Two-layer knowledge model (golden + branch-local)

**Exists today.** Single shared corpus under `learnings/`.

**Gap.** Feature-branch work writes into the same corpus the default branch reads;
abandoned experiments can pollute golden knowledge; no branch/commit provenance.

**Adapted design (D1).**

```
~/.ae/knowledge/<repo-id>/
  learnings/<domain>/<slug>.md          # golden — unchanged
  governance.jsonl                      # single ledger, binding on BOTH layers (see §5)
  consolidated.jsonl                    # golden ledger
  INDEX.md
  branches/<branch-key>/
    meta.json                           # { branch, branchKey, baseSha, createdAt, promotable }
    consolidated.jsonl                  # per-bucket ledger (see §5 — promotion lane)
    learnings/<domain>/<slug>.md        # same schema + provenance fields
    INDEX.md
```

- Branch buckets inherit the store's lock, transactions, commit history, secret scanning,
  and byte caps. **They do not inherit the store's maintenance paths for free** — every
  root-anchored reader/writer (hand-edit absorption's learning-path matcher, the `purge`
  cascade, `consolidate --rebuild`, index regeneration, listing, commit-mode mirroring)
  must become layer-aware in the phase that ships buckets. The normative semantics are in
  §5a; treating these as free inheritance was reviewed and rejected.
- Every episode and learning gains optional, reader-tolerant provenance frontmatter:
  `commit:`, `branch:`, `base:`. Absent fields mean "pre-provenance artifact". Both
  serializers (`store.mjs` and `apply.mjs`) must emit these fields on re-render —
  reader tolerance alone is insufficient, since any STRENGTHEN, absorb, or purge delink
  re-renders the file and would silently drop them.
- Golden is the authoritative baseline. A new feature branch is assumed to start from the
  latest fetched main and then add local work on top.
- **Default-branch determination (normative):** an explicit `defaultBranch` field in the
  store `config.json`, seeded from `origin/HEAD` when resolvable. When neither is
  available, write routing fails closed **to branch-local** (never to golden), and doctor
  surfaces the unresolved default.
- Writes on a feature branch default to the branch-local layer. Golden writes require
  either being on the default branch or an explicit `--layer golden` override. Layer
  routing is derived from git context **at write time** — the branch recorded at orient
  is advisory display only; a write whose current HEAD disagrees with the oriented branch
  warns before routing.
- Promotion branch-local → golden is explicit and reviewable (see §5).

**Phase:** 1 (provenance + read path), 2 (bucket layout, write routing, promotion).

### P2 — Deterministic `orient` / `recall` — already satisfied; verify + document

**Exists today.** Fully local, deterministic, budgeted.

**Genuinely new.**
1. Branch / worktree detection recorded into session and pack header.
2. Layer overlay: golden actives ∪ branch-local actives; branch-local shadows same-id
   golden claims, subject to the protected-claim gate in §4.
3. When no branch bucket exists: golden + one advisory drift line from existing
   `index-status.mjs` signals (`commitsSince`, `filesChanged`) — labeled as recall-index
   drift, which is what those signals measure. Phase 3+ may upgrade this to a real
   structural delta.

**Phase:** 1.

### P3 — Structural codebase index

**Exists today.** Lexical tier only; injectable `extract` seam already present.

**Adapted design (D2).**

- New `treesitter-extractor.mjs` implementing the same `extract(rel, content)` shape with
  extended v2 result `{ symbols, imports, defs, refs, complexity }`.
- Languages in the first optional WASM set: **TypeScript/JavaScript, Python, Java**. All
  other languages (and missing grammars) fall back silently to the lexical extractor.
- Grammars ship as an optional install extra under `~/.copilot/.ae-bin/`. No runtime
  network. **Integrity (normative):** the package carries a lockfile of sha256 digests
  for every grammar; each grammar's hash is verified before instantiation, and on any
  mismatch the extractor falls back to lexical *loudly* (doctor S1 fails, not warns).
- **Storage location (resolved):** structural index lives **outside** the knowledge git
  store at `~/.ae/index/<repo-id>/<worktree-id>/structural/` so it can be freely
  deleted or rebuilt without touching governance history, and never collides across
  repos — nor across co-located worktrees of ONE repo, which share a `repo-id` (it
  hashes the origin remote) and can sit at the same `meta.sha` with different
  working-tree content. The worktree segment hashes the worktree root's realpath.
  - `files.json`, `symbols.json`, `graph.json`, `meta.json`
- Extracted content is untrusted repo text: symbols and excerpts pass the existing
  `scanSecrets`/`redactSecrets` boundary at index-write time and `inertLine` at every
  render, like all retrieved data.
- Incremental: mtime+size fast path, content-hash confirm.
- `ae index --structural --since <ref>` for targeted structural diffs (refs
  validated via `git rev-parse --verify`, always passed after `--`). **Soundness rule:**
  `--since` narrows only when the ref resolves to exactly the sha the PRIOR index was
  built at; any other ref would leave files changed in between stale under a freshly
  stamped `meta.sha`, so it is ignored (reported on every output lane) and the build
  falls back to a full incremental pass.
- Table caps (symbols, module/call edges, unresolved) are **recorded** in `meta.json`
  (`symbolsTruncated`, `moduleEdgesTruncated`, `callEdgesTruncated`,
  `unresolvedTruncated`, plus the routine per-symbol `symbolDetailTruncated`);
  consumers degrade to informational rather than assert a finding computed from a
  table-level truncation. An existing-but-unreadable table is reported
  loudly (doctor S1) instead of reading as empty.
- **Integrity covers the loader, not only the wasm:** `grammars.lock` also pins the
  sha256 of the JS entry point `import('web-tree-sitter')` executes, verified before the
  import; a missing or truncated lock refuses the treesitter tier and fails doctor S1
  rather than silently disabling verification.
- The lexical tier is a first-class tier, not a stub: it records the module export
  surface (JS/TS `export` forms and CommonJS, Python `__all__` or module-level public
  defs, Java `public` members) and explicit named-import references, so the structural
  checks are meaningful with no grammar installed.
- Opt-in first; consumers prefer structural tables when present and current, else
  lexical.
- **Output lanes:** the structural query surface renders per the three-audience contract
  in §9 — its agent rendering is token-capped and framed, never raw index JSON.

**Phase:** 3.

### P4 — Layer-aware compounding and knowledge writes

**Routing table (derived from git context at write time):**

| Git context | Default destination | Override |
|---|---|---|
| Feature branch | branch-local bucket | `--layer golden` (logged) |
| Default branch | golden | — |
| Detached HEAD / experiment | `branches/detached-<shortsha>/` (`promotable: false`) | none |

- `consolidate --apply` remains the sole writer of learning content for both layers.
- Only verified outcomes are eligible for compounding (unchanged).
- Golden consolidation skips episodes whose `branch:` provenance names a non-default
  branch that has not been promoted — merged evidence does not become golden claims
  without the explicit §5 step.

**Phase:** 2.

### P5 — Plans and verification enriched with structural data

- Plan enrichment (advisory): when structural index is current, append a short
  `Structural context` note under Research Notes (callers/dependents, exported symbols,
  hotspot flags). Budgeted, clearly marked generated, excluded from the plan contract
  digest, and rendered through the same data-framing as all retrieved content.
- Verification enrichment (advisory first): `structural-expectations` check comparing
  structural diff against the plan. Exit-code-neutral until a policy knob opts it into
  warn/enforce — this requires per-check severity in the verify model and policy schema,
  named in §6 as its own capability row.

**Phase:** 3 (enrichment), 4 (verify expectations).

### P6 — Knowledge lifecycle commands

- `ae knowledge status` — layer-aware report (golden counts, branch buckets, drift,
  promotability, structural freshness).
- `ae knowledge promote [--branch <key>] [--ids a,b] [--all]` — emits a reviewable
  op-set applied only through the §5 promotion lane.
- `ae knowledge prune [--branch <key>] [--merged] [--stale <days>]` —
  human-authority deletion; never mode-gated. Supports both merged and abandoned
  (unmerged) branches.
- Doctor: K5 (orphan buckets), K6 (layer misroute), S1 (structural health).
- Hygiene pre-work: add the four silently-dropped event types
  (`init_repo`/`recall`/`validate_plan`/`index`) to the `EVENT_TYPES` allow-list.
  `knowledge`-type events already flow, so the new lifecycle subcommands are visible to
  `ae report` from day one; the allow-list fix is independent cleanup, not a
  dependency.

**Phase:** 1 (`status`, events fix), 2 (`promote`, `prune`, K5, K6), 3 (S1).

### P7 — Multi-project and worktree hardening

- Branch-key: `<slug>-<8hex>` (slug normalized, 64-char max, hash disambiguates).
- Same branch in multiple worktrees shares one bucket (correct default).
- Detached HEAD → non-promotable `detached-<shortsha>` bucket.
- **Branch rename:** auto-migrate the bucket to the new key when possible (rare;
  best-effort). If auto-migration cannot be performed safely, leave the old bucket and
  surface it in `knowledge status` for manual prune or migrate.
- **Branch-name reuse:** `meta.baseSha` is checked for ancestry at read time
  (`git merge-base --is-ancestor`); a bucket whose recorded base is not an ancestor of
  the current branch (force-push reuse with unrelated history) is excluded from the
  overlay and surfaced in `knowledge status`.

**Phase:** 1 (key + detached), 2 (prune + rename handling).

### P8 — Local token budgeting and progressive disclosure — mostly satisfied

Only change: layer ordering inside existing caps → branch-local → golden → structural
delta → broader team knowledge.

**Phase:** 1 (rides P2).

### P9 — Governance and provenance

- Uniform generation-context stamp `{ sha, branch, baseSha, generatedAt }` on structural
  meta, knowledge manifests, episodes/learnings, and branch-bucket meta.
- Process knowledge (episodes, learnings) stays in T1/T2 under human governance.
- Structural facts remain derived, never stored as knowledge.
- Provenance fields (branch names, worktree paths, bucket keys) are attacker-influenced
  strings wherever a checkout can come from a fork: every rendering passes `inertLine`
  with a length cap, including the pack header.
- SHA provenance is recorded but the existing day-granular recency rule is left unchanged
  until a separate threat-model review.

**Phase:** 1 (stamps).

## 4. Overlay and ranking semantics

1. Candidate set = golden actives ∪ current branch-local actives.
2. **Shadowing (gated):** a branch-local learning with the same id replaces the golden
   claim in the candidate set, **unless the golden claim is protected** (≥3 verified
   fixes or `source: human`) — a protected claim is never shadowed; the branch-local
   claim renders as an additional, subordinate entry instead. The pack renders a
   `[branch-local]` / shadow marker either way. This mirrors the write-path
   protected-target rule so the read path cannot bypass a gate the writer enforces.
3. **Governance binds both layers:** the overlay consults `readGovernance` per id — an
   id under a standing `retire`/`dispute`/`promote` decision is never surfaced from a
   branch bucket. Reusing a governed id in a bucket triggers the standing decision, it
   does not escape it.
4. Ranking uses existing `scoreLearning`; branch-local wins equal-score ties (the layer
   tiebreak applies before the id tiebreak, since shadowed ids are identical). Top-3 and
   2048-byte pack caps unchanged.
5. Branch-local claims stay inside the existing untrusted-memory advisory framing; only
   an extra marker is added.
6. No branch bucket → golden + one-line drift advisory from `index-status.mjs`.

## 5. Promotion and pruning contract

- `knowledge promote` emits a reviewable op-set (`ADD` / `STRENGTHEN` / `SUPERSEDE`)
  applied **only** through `consolidate --apply` running in an explicit **promotion
  lane**. The lane exists because the standard candidacy gate would otherwise reject
  every promotion: branch-local episodes are already consumed in the bucket's own
  `consolidated.jsonl`, and their files live on the source branch. Normatively:
  - Each bucket carries its own `consolidated.jsonl`; branch consolidation consumes
    episodes per-bucket, golden consolidation consumes them in the golden ledger.
  - Promotion ops are exempt from the golden candidacy check — their evidence was
    disk-verified (sha256) at branch-apply time and is re-validated from the recorded
    hashes, not from working-tree presence.
  - Promotion rejections **never record quarantine strikes**; promotion is a distinct
    rejection class, not a content failure of the underlying episodes.
  - All other writer rules bind unchanged: byte cap, secret scan, imperative lint, and
    the protected-target dispute rule.
  - `promote --all` respects `MAX_OPS_PER_RUN` by chunking: deterministic ordering is
    the cursor (as in `consolidate --candidates`), and the command reports
    `remaining: N` until the bucket is drained.
- **Shadowed-claim promotion rule:** because golden is the authoritative baseline and a
  feature branch is assumed to start from latest main, a branch-local claim that shadows
  a golden claim is mapped to `SUPERSEDE` (or `STRENGTHEN` when appropriate). The
  promoted claim carries the branch-local evidence as the new authoritative version. If
  the golden claim is protected (≥3 verified fixes or `source: human`), the promotion is
  rejected and the golden claim is marked disputed for human review — exactly as any
  other SUPERSEDE of a protected target.
- **Ledger action:** branch→golden promotion records **`absorb-branch`** (never the
  sticky `promote` action). **Replay rule (normative):** `readGovernance`'s standing-
  decision replay considers only the decision set (`retire`, `dispute`, `confirm`,
  `promote`); `absorb-branch` entries are recorded for audit but never become the
  latest-standing decision for an id. Required regression test: `retire` →
  `absorb-branch` → `consolidate --rebuild --yes` still lands `retired`.
- On successful promotion the source branch-local entries are tombstoned
  (`promoted_to_golden:`), the tombstone is a retrieval exclusion (added to
  `retrievalExclusion` alongside `promoted_to`), and the bucket becomes prunable.
- Pruning is human-authority, never mode-gated, and supports both merged and abandoned
  branches.

### 5a. Layer-aware store maintenance (normative)

The following maintenance paths are root-anchored to `learnings/` today and MUST become
layer-aware in the phase that ships buckets — each is a data-loss or laundering hazard
otherwise:

- **Hand-edit absorption** recognizes `branches/<key>/learnings/**` paths; a hand edit
  in a bucket is snapshotted and absorbed exactly like a golden hand edit, never left
  for transaction rollback to destroy.
- **`knowledge purge <file>` / `purge --all`** cascade across all layers: a purged
  episode's branch-local learnings are delinked/removed too, and `purge --all` wipes
  `branches/`. Human deletion always wins in every layer.
- **`consolidate --rebuild --yes`** wipes and re-derives **per layer**, routing episodes
  by their `branch:` provenance. An episode without provenance in a store that has
  `branches/` routes to branch-local review — never silently into golden. Rebuild must
  not launder unpromoted branch claims into golden.
- **Commit-mode mirroring** (`knowledge commit repo`) remains golden-only and
  branch-oblivious; mirroring buckets is out of scope for Phases 1–4.
- **Store schema version:** `ensureStore` writes a schema marker; an older CLI on a
  versioned store refuses with a hint rather than operating layer-blind.

## 6. Capability-gap summary

| Future primitive | Type | Phase |
|---|---|---|
| `knowledge status` / `promote` / `prune` | CLI subcommands + contract | 1–2 |
| Layered read path in orient | CLI behavior | 1 |
| Structural index tier | CLI + optional extractor | 3 |
| Structural plan/verify enrichment | CLI behavior + advisory check | 3–4 |
| Per-check severity in verify + policy schema | Schema change (`policy.yaml` v2) | 4 |

No new skills or agents. Existing SKILL.md files receive short layer-awareness notes in
the shipping phase.

## 7. Phasing

- **Phase 0** — this blueprint + Human Decision.
- **Phase 1** — provenance stamps (emitted by both serializers), events allow-list fix,
  branch/worktree detection + branch-key derivation, layered read path (reads golden
  plus any buckets present; buckets appear once Phase 2 writes them), `knowledge status`
  (golden-only columns until Phase 2). Fully backward-compatible — no write path
  changes.
- **Phase 2** — `branches/` layout + detached bucket + per-bucket ledgers, layer-aware
  write routing, the §5a maintenance-path work (absorb/purge/rebuild/mirror/schema),
  `knowledge promote` (promotion lane) + `prune`, doctor K5 + K6, rename auto-migration
  (best-effort).
- **Phase 3** — tree-sitter WASM tier (TS/JS, Python, Java) with grammar integrity
  checks, persistent structural tables, incremental + `--since`, orient/plan enrichment,
  doctor S1.
- **Phase 4** — per-check severity (policy v2), advisory structural-expectations verify
  check, telemetry-gated decision on structural default-on.

## 8. Risks and open questions

- Store growth from long-lived branch buckets → `knowledge status` always hints; prune
  remains explicit human action for both merged and abandoned branches.
- Windows path lengths → 64-char branch-key truncation + existing slug caps; Phase 1
  must include a long-branch Windows-shaped fixture.
- WASM size → initial set limited to TypeScript/JavaScript, Python, Java.
- Store lock contention → one `.lock` now serializes every worktree and branch;
  long-running promotion must land cancellation on transaction checkpoint boundaries so
  the rollback floor holds.
- Recency-rule evolution using commit ancestry is deliberately deferred to a separate
  threat-model review.
- Branch-local governance ledger is omitted in Phase 1–2 (buckets are ephemeral; the
  golden ledger binds both layers per §4).

## 9. Relationship to the CLI workbench (TUI) track

A parallel evolution track — the harness CLI workbench with a TUI session ledger (command
registry dispatching every command, versioned JSON envelope plus JSONL streaming,
append-only run journal with distinct `cancelled` and `timed-out` outcomes, async runner
with cooperative cancellation, gate-state surfaces) — is planned separately and is not
governed by this blueprint. The two tracks compose, and this blueprint's new surfaces must
not paint the workbench into a corner:

- Every command proposed here (`knowledge status`/`promote`/`prune`, `index --structural`
  and any structural query surface) must be registry-dispatchable and emit the versioned
  JSON envelope, with JSONL streaming for long operations (structural indexing, promotion
  application), so the TUI renders them without bespoke adapters.
- The generation-context stamp (P9) is the `gen <hash>` identity the TUI shows beside
  knowledge and search results — keep it stable, short, and cheap to read.
- The structural index (P3) is the backing store for the workbench's
  `search --scope code` symbol hits; expose its query path as a command surface, not only
  as orient-internal plumbing, so the TUI can call it directly.
- Long-running operations proposed here must support cooperative cancellation and record
  distinct `cancelled` vs `timed-out` outcomes in events, matching the run journal's
  status model.
- `knowledge status` output should serve both the workbench's one-line footer summary and
  its expanded ledger view: summary scalars first, detail arrays after.
- **Three-audience output contract.** Every command surface proposed here renders one
  canonical result three ways, and all three renderings are deterministic CLI work —
  never a model pass:
  1. **Human** — the styled ledger (`lib/style.mjs` conventions) for eyes.
  2. **Program/TUI** — the versioned JSON envelope for the workbench and other tooling.
  3. **Agent** — a budgeted text rendering for LLM consumption, following the existing
     pattern (2048-byte context pack, 220-token plan slice, bounded `get` excerpts).
  Agents consume the budgeted lane, never the JSON envelope: JSON is token-inefficient
  and its arrays are unbounded, so envelope output must never enter model context. Agent
  renderings inherit the existing hardening and metering — data-not-instructions framing,
  `inertLine`, and secret redaction wherever the content is retrieved text, plus measured
  bytes so `ae report`'s utilization SLOs see their cost. The structural query's
  agent rendering carries a token cap, with the repo map's 1000-token budget as the
  precedent. This is what makes the workbench's dual human/LLM promise real: no tokens
  are ever spent translating one audience's output into another's.

Where the workbench track defines its own contracts (registry, envelope schema, run
journal), those contracts govern; this blueprint commits its surfaces only to being
conforming citizens of them.

## Human Decision

- **Decision:** Approved
- **Reviewer:** repository owner
- **Date:** 2026-08-06
- **Conditions or required edits:** The §4 protected-shadow and governance-binding gates,
  the §5 promotion-lane mechanics and `absorb-branch` replay rule, and the §5a
  layer-aware maintenance semantics are binding constraints on every implementation
  phase. Phases ship through the repo's plan pipeline — one live dated plan at a time,
  gated edits, trusted named checks — with registry `candidate` entries added via
  `/create-primitive` in the phase that ships each surface. The structural tier remains
  opt-in until the Phase 4 telemetry decision.
