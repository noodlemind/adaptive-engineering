# Formal flow models

The shared application map describes committed source on the resolved default branch. It is generated explicitly, stored privately by project and generation commit, and returned as bounded pointers only for matching work. Deep verification remains in the repository's optional specialized skill.

## Sub-features

- Cold status reports an absent model without creating private state.
- Preparation captures watched committed sources and the resolved default-branch generation.
- Publication validates the preparation and structured statechart, preserves immutable generation bytes, and admits identical retries.
- Matching orientation returns bounded descriptive references; unrelated work omits the map.
- Unrelated default-branch commits preserve currentness; watched changes mark the generation stale.
- Obsolete candidates cannot replace current knowledge. Explicit prepare and publish refresh the map after reviewed source changes.
- The delivery-evidence model separately checks every path through a Mermaid state diagram of the delivery workflow.

## How a person reaches it

Read the Verify Harness recipe and run its ordinary doctor. Use `ae flows status --json` to inspect availability and `ae flows show --json` to expand the current model. A resolved default branch and committed watched sources are prerequisites for generation.

Write a contained `scope.json` with `{"watchPaths":["src"]}`, then run `ae flows prepare --file scope.json --json`. Read its committed source bindings, author a candidate containing the exact returned preparation and a structured statechart, and run `ae flows publish --file candidate.json --json`. No command generates semantic flow content or accepts an obsolete preparation automatically.

Use `ae orient --read --context-version 2 --file src/app.js --json` for relevant work. Read returned references as needed. Select `verify-formal-flows` on the accepted verification plan to prove this route in a disposable repository.

## Driving it

The named check `verify-formal-flows` runs `node .cursor/skills/verify-harness/scripts/prove-formal-flows.mjs`. The helper owns doctor, temporary Git product and private homes, CLI commands, assertions, evidence, and cleanup. It establishes `origin/HEAD` and advances its fixture's remote-tracking ref locally; it never fetches a network repository.

The drive observes absent status, captures a `src` preparation, publishes and rereads a statechart, retries identical publication, and expands the model through `flows show`. Related orientation must carry its reference, digest and flow ID within 4 KiB, with no model body; unrelated orientation must omit it. An unrelated default advance remains current. A newly committed writer beneath `src` makes the old generation stale. Publishing the obsolete candidate must fail and preserve stored bytes. Fresh preparation and explicit publication restore currentness at a new generation.

The receipt records actual argv, working directory, exit status, stdout, stderr, observed generations, doctor, and owned cleanup in `formal-flows/drive.json` under `HARNESS_CHECK_ARTIFACT_DIR`. Without an artifact root it uses a unique private temporary evidence directory. The receipt survives success, failure and cancellation. A failed drive reruns doctor before another attempt.

The delivery-evidence model check is `node .cursor/skills/verify-harness/formal/delivery-evidence/scripts/check.mjs`; read its [skill](../formal/delivery-evidence/SKILL.md) first. Its receipt is `delivery-evidence-model.json`. The [workflow-invariant feature](./workflow-invariants.md) documents the implementation and negative-control drives that confirm the code follows that workflow.

## Gotchas

The scope is committed default-branch source, including when a feature worktree differs. Dirty feature edits do not become the shared generation. Unresolved or rewritten default history is unknown. Freshness proves captured byte identity under declared watch paths, not semantic completeness, correctness, or authority to edit.

Maintain watched paths so new writers are included. A passing statechart schema is distinct from a checked workflow rule and from implementation conformance. Shared maps grant no gate, intent, trust, or verification authority. Agent judgment and specialized rerunnable checks remain explicit. Neither this CLI drive nor the delivery-evidence model proves all application behavior, arbitrary schedules, or native editor activation. None of these checks needs Java.
