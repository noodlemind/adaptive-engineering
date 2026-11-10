# Native decision inputs

Use the selected host's agent tool and installed Harness. No inference endpoint or API key is required. Read this reference before preparing action, acquisition, memory, or readiness judgment. Examples show input shapes; replace every placeholder with the observed value. They grant no authority.

## Bind the current session and source

Read `.harness/session.json` in the product workspace after a configured native hook has observed the current session. Use its actual `sessionId`; do not invent one or reuse an old chat's ID. If native session evidence is unavailable, report that prerequisite. `taskId` is a descriptive label, not a way to renew decision budgets. An accepted plan retains its budget across sessions.

Use the same explicit workspace, configuration, skills, and AE state roots as setup. Run `resources decision --file <input.json> --json` using the literal absolute Node/package argv supplied by setup. Omit `--skills-home` on the legacy Copilot path. Bare `ae`, `harness`, or `node` aliases are not admitted for native bootstrap controls. Only bounded prepare/record/status inputs may be staged under `.harness/decisions/` before a plan; other writes retain their own gates.

## Prepare an action

```json
{
  "schema": 1,
  "operation": "prepare",
  "taskId": "payment-retry-check",
  "sessionId": "<current observed native sessionId>",
  "type": "action",
  "intent": "Run the accepted payment behavior check.",
  "planPath": "<returned accepted plan path>",
  "sources": ["src/payment.mjs", "test/payment.test.mjs"],
  "action": {
    "tool": "Bash",
    "input": {"command": "node --test test/payment.test.mjs"},
    "cwd": "<absolute product workspace>"
  },
  "context": {"criterion": "Duplicate retries must not charge twice."}
}
```

Match the host's actual tool name, complete input object and execution directory. Add relevant script/config dependencies to `sources`; Harness cannot infer arbitrary executable effects. A changed argument or bound source needs fresh judgment. An exact consumed receipt can supply a supported host permission `allow` only after the remaining Harness guards pass. It cannot approve scope expansion, bypass a later denial, or grant a sandbox escape.

## Prepare acquisition

Reuse the same schema, task/session, intent, plan and relevant source fields, set `type: "capability"`, omit `action`, and supply:

```json
{
  "operation": "create",
  "kind": "agent",
  "name": "payment-reviewer",
  "tools": ["read", "search"],
  "agents": [],
  "textDigest": "sha256-<64 hex digits of the exact canonical UTF-8 text>"
}
```

This object is the prepare input's `capability` field, not a standalone request. Put the complete proposed canonical text in `context.capabilityText` so the judge can inspect its instructions and declared permissions, rather than assess an opaque digest. For replacement use `operation: "update"` and the observed native `expectedDigest`. Include every declared tool and delegate; use normalized canonical tool names. The writer rechecks standing authority and the exact text, then consumes an `acquire` receipt. Publish the same canonical text through `resources create <kind> <name> --file <source-decision>`; source decision schema is `{schema:1,text,...observed expected digests}`. Do not supply an authored approval field.

A newly published role remains `pending-reload`. Complete required approved delegation reconciliation and reload the host when needed. To test availability, prepare an exact `action` for its first native Agent/Task invocation under current tool/delegate grants, obtain `allow`, then invoke those identical arguments once. Only a correlated successful native completion can transition the same current source to `available`. Failed, uncorrelated, changed-source, or revoked calls leave it pending. Retained adapter evidence reports `nativeQualification: observed-invocation` and `loadedSourceHash: unverified`; it does not attest the host's cached role bytes. There is no authored activation command.

## Prepare inferred memory publication

Preview the unchanged compound request with `--dry-run`. Copy the returned `memoryDecision` into the prepare input's `memory` field and the exact returned `memoryContent` into `context.memoryContent`. Use `type: "memory"`, the same observed session and accepted plan, and an intent explaining the evidence and applicability. The derived descriptor is:

```json
{
  "operation": "publish",
  "kind": "fix",
  "scope": "private",
  "destination": "<exact absolute final episode file from preview>",
  "contentDigest": "sha256-<64 hex digits from preview>",
  "proofIdentity": "<64 hex digits from current verified proof>"
}
```

An insight uses `kind: "insight"` and its returned `proofIdentity`, which may be `null`. Copy raw serialized document bytes, including newlines; a summary or opaque digest does not let the judge inspect the proposed memory. After an observed `allow`, retry the identical publication. The writer consumes one receipt immediately before publication and checks content, destination, proof, consent and session again. The standing memory grant covers private inferred episodes; it does not authorize global publication or ship-set promotion. Explicit user teaching/correction retains its separate attributed authority and writer.

## Prepare human-review readiness

Use the common schema/task/session/intent fields with `type: "readiness"` and `planPath` for the current accepted plan. Omit `action`, `capability` and `memory`. Harness derives current independent review, tour and named verification evidence. A supplied `passed`, `ready`, or provenance claim cannot establish readiness. The judge may return `ready` only when those prerequisites pass; human acceptance, merge and release remain separate.

## Invoke, observe, record

Invoke native `decision-agent` with the returned complete packet. Select a detected small host model for the decision role when supported; otherwise retain and report inheritance. Its response is exactly:

```json
{"schema":1,"requestId":"<returned requestId>","verdict":"allow","reason":"<evidence-based assessment>","evidence":["<source or check reference>"]}
```

`allow` applies to action or memory; `acquire` to capability; `ready` to readiness. `revise`, `deny`, or `escalate` preserve the actual unfinished state. The host hook records the complete result. Then execute the returned `recordCommand` with `{schema:1,operation:"record",requestId:"<returned requestId>"}` on stdin. Do not author the verdict or invocation provenance in the record input. `operation: "status"` may inspect a `requestId` without consuming it. Status is read-only. Its `readiness-index` warning means a plan's readiness index may name an older receipt than the newest one archived. A noted plan's citation uses its archived receipt; a plan not yet reconciled may cite an older one until the warning clears. Only `prepare` and `record` retry the index and advance its reconciliation. When the warning lists `files` under its `archive` path, it stays until you act. Each file comes with a reason and the matching remedy: for a `readiness/` file that is a symlink or not a regular file, remove it. For a `readiness/` file whose read or write was refused, fix its permissions or its directory, or remove it. For a `requests/` record that can't be read or proves nothing, make it readable, restore it, or move it out of the archive. For an archive past 65,536 request records, trim it. Budgets, source changes, revocation and one-shot use remain authoritative.

## Native specialist review output

Give the actual selected provider its immutable review packet and request:

```json
{"schema":1,"packet":"<review packet id>","results":[{"reviewer":"<required perspective id>","status":"completed","findings":[],"residual_risks":[],"testing_gaps":[]}]}
```

Use the packet's findings schema for real findings. Each row must match a perspective that the invoked provider supplies. Retain actual failures, risks and gaps. Adaptive assembly requires the full response observed through the native adapter and bound to the packet, provider source and session. Copy its results into `review assemble`; authored `provenance: host-invocation` or Engineer self-review cannot replace an observed independent result. Adapter events are retained evidence, not authenticated host transcripts or proof that a particular model ran.
