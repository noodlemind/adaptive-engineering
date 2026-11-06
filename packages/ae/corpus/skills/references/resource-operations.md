# Resource operations

The Engineer owns need, overlap, primitive type, authored content, meaningful evaluation cases and minimum permissions. Deterministic reusable operations belong in Harness; contextual judgment protocols belong in skills; separate perspective or authority belongs in agents; product assertions belong in product checks.

`ae resources validate --corpus --json` validates shipped source, metadata, descriptions, concrete trigger examples, relative Markdown references, capability registry and delegation targets. `resources validate --path <root>` inspects another resource root; `resources scaffold <skill|agent|instruction> <name> --json` emits a dormant template. Generated counts replace manual inventory arithmetic. Host support declarations are separate from live host proof.

Use `resources create <type> <name> --file <decision.json> --json` for validated creation through the selected host writer. Schema 1 accepts canonical host-neutral `text` and optional `expectedDigest` (`sha256-<native bytes hash>`) and `expectedSourceDigest`. Native agents declare name, description, `user-invocable: false`, explicit canonical `tools` and `agents` arrays, and authored Guardrails. Replacing a writer-owned personal resource requires its observed native digest; canonical metadata changes that project to unchanged native bytes also require `expectedSourceDigest` to bind that source change; arbitrary unowned or setup-owned resources cannot be overwritten. Direct caller `--yes` records explicit authorization, while autonomous creation/update uses a matching current user-owned standing grant; an input field cannot authorize either path. Dry-run validates without publication. Legacy text-on-stdin remains readable under its weaker discovery-only validation.

The writer returns `primitive.path`, `digest`, and `sourceDigest`. Personal roles can report `pending-reload`; approved delegation reconciliation and a source-bound first native invocation establish availability. Read [native decision inputs](native-decisions.md) for the exact action-receipt and observed-completion flow. Availability reports `loadedSourceHash: unverified`, preserving the host loader qualification limit. Codex instruction files are context-routed, not a claimed native automatic rule loader. Terminal activation is manual. Preserve host permission limits, and never substitute Copilot metadata for an unsupported selected-host mapping.

## Consented installed-source discovery

`ae resources discover --json` returns bounded inventory/status and onboarding needs; `--query <text>` narrows candidates. At setup, first ask what existing selected host roots/resources to include, then whether ongoing refresh is allowed. Configure only from user authority through `ae resources discover --file <decision.json> --json`:

```json
{"schema":1,"operation":"configure","roots":[{"path":"/absolute/host/root","kind":"config","host":"claude-code","scope":"personal","included":true}],"ongoing":true,"autoIncludeNew":false,"autoUpdate":false,"exclusions":[],"grants":{"create":["skill","agent","instruction"],"update":[],"memory":true,"decision":true,"hostAuthority":false,"tools":[],"agents":[],"budgets":{"maxDecisions":16,"maxRepairs":2,"maxAcquisitions":2,"maxSeconds":300}}}
```

Use the user's actual absolute selected roots and choices, not the example's authority. Include `expectedRevision` for an update. Project files cannot broaden this policy. Exclusions accept a resource ID, source-bound key, exact absolute file, or absolute directory subtree. Root order selects the first included resource for a duplicate ID. Tool and delegation grants bound newly adopted and created resources; budget limits bound internal decisions and repairs. `grants.hostAuthority` defaults false: automatically adopting or acquiring a role that inherits host/parent permissions requires explicit user consent for that authority. An omitted tool list or native format without role isolation does not establish a read-only role. Initial explicit inclusion can pin an existing inherited role; later permission expansion remains unapproved. Discovery retains metadata for excluded, changed, and revoked resources while routing only eligible resources. A refresh observes changed content; it does not silently approve wider permissions, delegation, or scope. On a gap, refresh at most once within ongoing consent, then reuse/acquire/block explicitly. Read a source in full before activation; catalog metadata alone is not execution evidence.

## Native decisions

Read [native decision inputs](native-decisions.md) before preparing `ae resources decision --file <decision.json> --json` with `operation: prepare|record|status`. It supplies concrete action, capability, memory and readiness shapes, actual session binding, and the prepare → native agent → observed result → record cycle. No external inference API is involved. Exact approved calls may receive supported host permission approval after all Harness gates pass; a verdict cannot expand user or sandbox authority. Action approval and final readiness are distinct. Adaptive review also requires observed full native provider output, not an authored invocation declaration.

`resources candidates --json` freezes recurring review and repeated-mistake evidence. Exact recorded identities stay distinct from suspected semantic matches. The packet exposes existing named checks without claiming relevance. Global-tag clustering does not establish verified use; legacy fix/plan links require proof review before promotion. Read the full `packetPath` when the bounded result reports omissions.

A dormant proposal uses `resources propose --file <proposal.json> --json`:

```json
{
  "schema": 1,
  "operation": "gap-review-order",
  "type": "skill",
  "name": "focused-review",
  "rationale": "Why reusable judgment is missing and existing capabilities do not cover it.",
  "text": "Authored canonical primitive text with frontmatter and concrete examples.",
  "evidence": [],
  "candidatePacket": "optional frozen packet ID",
  "candidate": "optional selected candidate ID"
}
```

Omit optional candidate fields when no recorded candidate applies. Evidence paths select current workspace files; Harness captures their hashes. Supported dormant types are skill, agent, instruction, check, test and cli. Same operation and accepted bytes replay one proposal; changed payload conflicts. Stale selected evidence blocks. No proposal installs a file, grants authority, registers a capability or changes an allowlist. Activation follows the existing writer and approval contract after the semantic decision is accepted.
