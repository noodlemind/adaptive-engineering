---
name: verify-delivery-evidence
description: Check the bounded delivery-evidence model plus actual AE CLI/hook behavior after relevant gate, intent, proof, learning or recovery changes. Not for general code review, ordinary sessions or automatic tool installation.
---

# Verify delivery evidence

Read this skill explicitly from the selected verify-harness recipe. It is a repo-local specialized skill, not a new global entry or a claim of native editor registration.

The promise is that governed product edits require accepted intent, verified-delivery learning requires current source/intent-bound proof, and recovery controls do not authorize mixed product mutations. Violations can allow unintended edits or certify stale work. Accepted authority is `docs/adaptive-engineering.md`, `docs/reference/plans-and-proof.md` and the shipped Harness tool contract, recorded in `manifest.json`.

Run from the repository root:

```bash
node .cursor/skills/verify-harness/formal/delivery-evidence/scripts/check.mjs
```

Set `AE_TLC_JAR` explicitly to the official v1.7.4 `tla2tools.jar` with SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`. It reports TLC `2.19 of 08 August 2024`; Java 17+, Node 20+ and Git supporting the global `--no-lazy-fetch` option are prerequisites. Upgrade Git if it rejects that option; the checker blocks and preserves synchronization instead of retrying without its no-fetch guard. The checker never downloads tools or approves a project. Use an explicit absolute `AE_TLC_JAVA` only to select another installed Java executable.

`manifest.json` records the exact watched roots, explicit sources and last successful synchronization commit/digests. Every regular file under those roots is inventoried, including untracked writers. Files outside that declared inventory remain outside source coverage. A stale result must go through [maintenance](maintain/SKILL.md) before claiming current proof.

The command runs real TLC on `DeliveryEvidence.tla`, checks the safety-negative model produces its actual counterexample, and checks the no-progress model produces its actual liveness counterexample. It then drives the real CLI/hooks and a deliberately weakened guard on an owned disposable copy. Expected implementation negative detection is distinct from a tool/setup failure.

The mathematical model covers a baseline plus at most two edits and two accepted intent versions. Progress assumes successful available tools, fair scheduling and the finite edit/amend bound. It does not assert that cancelled, abandoned or permanently blocked work completes. `mode` represents the Engineer's documented obligation; Harness does not authenticate a declared semantic mode. Actual AE-I3 correspondence concerns operation/recovery authority. The unverified `--insight` lane remains distinct from verified-delivery learning and completion.

`formal-verification.json` retains results, finite scope, tool identity, traces, actual observations and bindings. Named checks use `HARNESS_CHECK_ARTIFACT_DIR`; manual runs return a unique temporary evidence path. A completed finite model pass and observed traces are not full implementation refinement or semantic completeness. The receipt says so explicitly. Missing tools, drift and incomplete runs return nonzero, not a skip or pass.

Treat failures as evidence. A model step that cannot occur in code indicates a modeling problem; a reachable violation indicates a possible product bug. Do not weaken the accepted property to obtain green output. Do not edit production code while maintaining verification unless the accepted Deliver scope authorizes that fix.

## Trigger Examples

**Should trigger:**

- Prove that changed locked intent blocks implementation.
- Check source changes invalidate verified-delivery learning authority.
- Model-check failed-gate recovery without admitting mixed mutations.

**Should not trigger:**

- Explain an ordinary CLI flag.
- Review unrelated UI styling.
- Install a formal methods tool without an explicit setup task.
