# Create and maintain repo-local formal verification

Use this creator branch for an accepted critical property whose failure is costly and whose interleavings or input space ordinary tests do not cover. The Engineer chooses the property, abstraction and tool. Harness continues to run registered checks and bind evidence through its existing contract. This branch adds no public skill, agent, implicit tool installation, project approval or scheduled job.

## Choose the question and location

Read accepted intent, actual source and orient's selected verification recipe. Consult a relevant current shared flow model only as descriptive context; missing optional context does not establish a proof gap by itself. Preserve its source identity and omissions. Do not infer accepted promises from a generated map or rewrite them from buggy code.

Reuse the selected product verification directory. Put each specialized verify skill, companion `maintain/SKILL.md`, manifest, model/configuration and helper beneath a property subdirectory. These are repo-local supporting skills read explicitly by the Engineer; native editor discovery remains unverified. Do not add competing top-level `verify-*` recipes or install a global primitive merely to add one property. The existing implement gate applies before creating these files.

Prefer a model checker for event ordering, retries, coordination and recovery; TLA+/PlusCal is a suitable default. For memory safety, arithmetic or input properties, prefer a verifier that checks actual shipped code. Where the language has no suitable verifier, use generated inputs against actual code and state that this is testing. A small handwritten copy of a function is not an implementation proof. Do not force every question into TLA+.

## Generate a specialized verify skill

Write frontmatter naming the guarded area, activation conditions and exclusions. Include the property and user harm, accepted intent sources, covered state writers, command, prerequisites, exact bounds/fault/fairness assumptions, last synchronization record, results, counterexample interpretation and exclusions. Leave no placeholders in a delivered skill. Include at least three positive and three negative triggers.

Keep normative properties separate from descriptive model transitions. Model an atomic action only when its implementation correspondence is justified. Specify useful progress or reachable successful paths as well as safety, so a model that refuses all useful work cannot obtain an unqualified pass. Never assert unconditional eventual completion when cancellation, unavailable tools or user abandonment are legal.

For a TLC-based check, read the standalone runner at `<copilot-home>/skills/create-primitive/assets/formal-verification/check.mjs` with the host read tool and copy it into that property's `scripts/check.mjs`. Outside the enforce hook, `ae get --reference skills/create-primitive/assets/formal-verification/check.mjs --json` prints the same file. The copied file uses Node built-ins and an explicitly supplied JAR; it does not require installed AE or any other plugin. In this library's own pilot, a thin wrapper imports the same shipped asset because the library owns it. Other products copy it.

Write a concrete `manifest.json` with these fields:

| Field | Required meaning |
| --- | --- |
| `schema`, `id`, `property` | Schema `1`, stable property ID and the plain-language promise |
| `intentSources`, `limitations` | Existing contained accepted-intent files and explicit assurance limits |
| `tool` | The runner's reviewed official TLC release/version/SHA-256 and minimum Java major |
| `models` | Contained `.tla` modules/configurations and expected completed positive, safety-negative and liveness-negative outcomes; negative controls name the intended `property` so an accidental type error cannot count as sensitivity |
| `coverage.sources` | Explicit bounded regular source files |
| `coverage.watchRoots`, `extensions` | Contained roots whose actual file inventory is covered, including untracked files; use `['*']` to detect writers in any file type |
| `coverage.lastSync` | `null` for a draft; only the successful maintenance runner publishes commit, source digest, verification digest and exact file hashes |
| `conformance` | Reviewed `command`/`negativeControl` node script argv, distinct `positiveFeature`/`negativeFeature` receipt types, and required `invariantIds`/`negativeInvariantIds` |

The starter configuration has exactly three directives: `SPECIFICATION Spec`, one inline invariant list and one inline temporal-property list. It rejects additional configuration directives, including constraints, views, symmetry and deadlock suppression. It supplies no custom tool flags. The runner copies only declared model/configuration files into a fresh working directory, excluding adjacent Java override classes. Review the model and its standard-library behavior; this isolation is not an operating-system sandbox. More elaborate configurations need their own reviewed runner rather than bypassing these checks. PlusCal must be translated and reviewed beforehand; the starter never silently retranslates or installs tools.

## Tool prerequisites and execution

Install tools deliberately outside the repository's source artifacts. The starter pins the official [TLC v1.7.4 JAR](https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar), SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`, reporting `2.19 of 08 August 2024`, and requires Java 17 or newer. Set `AE_TLC_JAR` to its absolute regular-file path. `AE_TLC_JAVA` may select an explicit absolute Java executable. A different tool version requires a reviewed runner/protocol update; do not change a manifest pin merely to accept unknown bytes.

The optional checker also requires Git supporting the global `--no-lazy-fetch` option. If Git rejects that option, upgrade Git before rerunning. Safe metadata inspection refuses to retry without the no-fetch guard and leaves synchronization unchanged.

Run the copied helper with `--manifest <repo-relative manifest.json>` from the product root. The specialized skill should give its real filled-in command. Register that argv as a named check through the existing trusted check configuration and accepted plan. Declare `formal-verification.json` in its artifacts. Each invocation receives its own `HARNESS_CHECK_ARTIFACT_DIR`; manual runs use a unique private temporary directory and return its evidence path. Receipt collection does not itself establish semantic truth or authority to execute an unreviewed helper.

The receipt separates completed finite model checking, actual expected counterexamples, implementation observations, tool identity, source/verification bindings and synchronization. Missing tools, checksum mismatch, stale inputs, timeout, parse/evaluation error, malformed output or incomplete exploration never become a pass. The runner does not use `-continue`, simulation, or a skipped check to establish model checking. It preserves errors and actual traces, not just a success-shaped exit status.

The conformance helper must assert real actions and resulting states and emit one JSON object with `schema: 1`, `passed: true`, its declared `feature`, performed `steps` and checked `invariantIds`. Its implementation negative control uses the distinct negative feature and `checkedInvariantIds`, performs a deliberate source mutation on an owned disposable copy, and sets `detected: true` only after showing the unchanged check detects that mutation. A negative-control receipt cannot substitute for the positive drive. Setup failure and an arbitrary nonzero tool exit do not count as detection. Both helpers exit zero only after their own assertions pass.

The existing `behavior` category is appropriate only for the combined result requiring actual implementation observations and mutation sensitivity. A pure abstract model pass does not establish shipped-code behavior. No new proof category or Engineer–Harness contract is implied.

## Prove the generated skill before delivery

1. Run it on current code. A skill that has not run remains a draft.
2. Confirm completed safety and conditional liveness checking within the stated finite scope.
3. Confirm model mutations produce the intended safety/liveness counterexamples; parse errors are not negative controls.
4. Confirm a deliberate implementation mutation on a disposable copy is detected through the real behavior/conformance path.
5. Restore or delete only owned scratch changes and confirm the unmodified implementation result.
6. Preserve the tool/argv/results, source bindings, real counterexample, observations and cleanup evidence.

Treat source correspondence as observed, not a full refinement proof. A shared flow map, three passing files, or a large explored-state count cannot establish completeness. Report any omitted state writers and assumptions that remain untested.

When explaining retained evidence, the Engineer can use `ae diagrams formal --file <workspace-relative formal-verification.json> --model <ExactModule.tla> --json`. This reads recorded stdout and any selected bound graph without running or installing Java/TLC. Preserve the receipt's checker identity, source/model/configuration bindings, negative-control role and currentness. Violating runs retain their ordered counterexample and temporal loop; a positive model can show its exported finite graph. The current starter accepts explicit `--capture-graph` to retain same-run `Module.graph.dot` beside the receipt using only the caller's deliberately configured checker. Keep both files together. Missing or damaged evidence refuses a chart; a positive pass without a graph does not invent one. Output remains `verification: not-verified`. The [diagram reference](../../codebase-context/references/diagrams.md#replay-recorded-formal-evidence) defines limits and provenance. Actual modeled defects still require a real-code repro or conformance check.

## Generate the companion maintenance skill

The companion discovers the selected property skill and reads its current manifest and receipt. It first records the old check's result or stale-status refusal, then reads changes from the recorded sync commit, including moved/split functions and new writers. The runner inventories tracked and untracked files under declared roots, but the Engineer must review whether those roots still cover all relevant writers.

Classify each change as irrelevant, descriptive model drift, an intended promise amendment backed by accepted intent, or a possible product defect. Update the description from code before using the result to guide repairs. Do not weaken a property or reduce bounds to obtain a pass. Record any intentional amendment and its supporting evidence.

After reviewing code/model correspondence, run the specialized command with:

```text
--maintain --rationale '<reviewed source/model correspondence decision>'
```

The rationale is an authored review decision, not automatic semantic certification. The runner captures candidate source/model/helper/intent bindings, runs all real checks, and rereads inputs before publishing synchronization. A failed or blocked run retains the prior manifest bytes and sync record. Only a complete successful joint run advances metadata. An updated model that exposes a bug is still a finding; do not claim current passing synchronization.

Maintenance edits verification assets only. A discovered product fix follows its own accepted Deliver scope. Scratch implementation mutations belong to owned disposable copies. Finish changed verification through ordinary review, verification and learning/completion. Report `in-sync`, `updated`, `bug` or `blocked`, with old/new bindings, checks, rationale, findings and limits. `updated` and `bug` may coexist; the successful sync stamp remains unchanged on a failing run.

## Activation scenarios and expected outcomes

These sixteen cases are selection/evaluation fixtures for the Engineer; they do not establish model quality by being listed.

| Positive trigger | Expected outcome |
| --- | --- |
| Prove retry ordering cannot publish twice | Create one property-specific model/check for the accepted promise |
| Model-check the lease takeover race | Include failure, fencing and interleaving assumptions |
| Verify current evidence before learning | Use the project's existing workflow conformance check before adding a model |
| An agent changed the guarded state writer | Maintain, review drift and rerun current code |
| A merge moved a covered function | Follow its new location; preserve identity and old result |
| A new untracked file writes guarded state | Inventory changes; block stale proof until reviewed |
| The accepted promise changed deliberately | Record the accepted amendment before changing the property |
| A formal model passes but might describe old code | Run maintenance and an implementation negative control |

| Negative trigger | Expected outcome |
| --- | --- |
| Explain what TLA+ means | Answer; create no artifact |
| Fix spelling in an unrelated README | Ordinary proportional verification; load no model |
| Make this Java style more idiomatic | Use domain/review criteria; do not claim formal verification |
| Search a missing project fact | Retrieve evidence; do not generate a verification skill |
| Show me an application flow diagram | Use the descriptive map; do not claim a checked property |
| Install all verification tools automatically | State explicit prerequisites; install/approve nothing implicitly |
| The checker is unavailable; mark it passed | Return blocked/unavailable and preserve sync metadata |
| Weaken the invariant until current code passes | Preserve the finding; require accepted evidence for a changed promise |

Primary background: [Lamport on abstractions](https://lamport.azurewebsites.net/tla/high-level-view.html), [safety/liveness/fairness](https://lamport.azurewebsites.net/tla/tutorial/session9.html), [TLC options](https://github.com/tlaplus/tlaplus/blob/v1.7.4/general/docs/current-tools.md), and [implementation trace validation](https://arxiv.org/abs/2404.16075). The original [create](https://github.com/cursor/plugins/blob/190d28736eff128ec94f502a22c7fe0c4b56cd37/pstack/skills/create-formal-verification-skill/SKILL.md) and [maintain](https://github.com/cursor/plugins/blob/190d28736eff128ec94f502a22c7fe0c4b56cd37/pstack/skills/maintain-formal-verification-skill/SKILL.md) workflows informed this design; they are not operational dependencies.
