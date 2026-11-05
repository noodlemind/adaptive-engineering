# AE workflow ownership correction

Chai reported that Engineer reconstructs delivery from command references, sometimes edits plans through host tools, and behaves differently across models. The goal is consistent lifecycle invariants through the existing AE kernel while preserving host Default Permissions.

## Confirmed failures

- Existing legacy plans under `docs/plans/` were exempt from the implement gate. Native edits, PowerShell writes and shell redirection could bypass the canonical plan writer.
- Supported PowerShell writer casing changed classification; `Get-Item` was treated as an opaque operation.
- Normal VS Code configuration did not configure the existing structured AE transport. Instructions assumed an execute tool with an independent stdin field.
- Orientation suggested command strings without exposing one consistent revision-bound workflow snapshot.
- Host adapters did not observe new user prompts, so an old plan/gate did not prove that later intent had been reconciled.

## Boundary decision

Extend existing plan operations and host integration. Do not add an independent model loop, another command family, a TUI dependency, or implicit trust grants.

The model supplies semantic decisions. AE owns plan serialization, revisions, operation journals, current workflow facts, and transition checks. Host prompt events supply intent observations; agent queries never impersonate those events. An explicit accepted disposition binds a current observation to a plan decision. Host tool hooks check that binding before product mutation.

Data crossing the boundary:

- Workflow snapshot: current plan path/revision/status/task counts, partial structured decisions, and evaluated or unknown prerequisites. A snapshot grants no mutation authority.
- Plan decision: existing version/id/action/expect payload plus optional `observedIntent` containing the current observation ID, disposition and rationale.
- Observation: host session identity, event identity and prompt digest; no raw prompt persistence. A newer observation cannot be acknowledged by replaying an old decision.
- Transport: existing workspace-bound MCP operations, with action-specific schemas and CLI semantic validation. VS Code profile configuration uses the active workspace at server startup. A running server never follows another checkout implicitly.

## Throughput checkpoint

- [x] Blocking first steps: reproduce source/hook boundaries and sketch owner/data shape before implementation.
- [x] Independent workstreams: plan ownership, PowerShell parsing, structured workflow, MCP schemas, host observations, and VS Code binding use disjoint primary files.
- [x] Shared mutable state: serialize integration of the gate hook and plan-decision fields; keep host observations isolated by session and reject stale publication.
- [x] Smallest safe decomposition: retain current lifecycle validators and transport instead of a second controller; independent review follows integrated tests.

## Acceptance

1. Direct managed-plan writes fail before and after a valid product gate; reads and canonical plan operations remain usable.
2. Supported PowerShell casing behaves consistently; reads stay reads and opaque mutation expressions remain conservative.
3. Orientation, creation, update, replay and status expose current revision-bound workflow facts, including context-size barriers.
4. Structured plan tools reject incompatible decision envelopes and preserve all supported operation forms.
5. A host-observed prompt is pending until a successful current decision accepts its disposition. Stale, failed and old replayed operations cannot acknowledge a later prompt.
6. Configuring VS Code preserves other servers/settings, preflights malformed/conflicting configurations, supports dry runs, and never changes permission or auto-approval settings.
7. Worktree selection stays explicit. Tool-server binding, host write permission and AE check trust remain separate.

## Qualification

Source and subprocess fixtures can establish kernel and hook behavior. They cannot establish live VS Code Default Permissions behavior, host-event coverage, or model-provider equivalence. Record those limits separately from passing source tests.

Implementation and verification results will be appended after integrated review.
