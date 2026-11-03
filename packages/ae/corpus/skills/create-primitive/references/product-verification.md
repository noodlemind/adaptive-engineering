# Create and maintain a product verification recipe

Use this procedure when Deliver work changes visible behavior, needs a missing recipe, or requests a feature-map audit. Read the product's accepted intent before choosing assertions. The spec defines what must be true. The recipe and feature map define how to reach and observe that behavior.

## Select one directory

1. Read orient's verification metadata. Prefer the recipe explicitly selected on the accepted plan.
2. Otherwise, reuse the sole existing `.cursor/skills/verify-*/SKILL.md`. Read it by path on every host.
3. If no such recipe exists, reuse an existing `docs/verification/SKILL.md`.
4. If discovery reports `ambiguous` or `incomplete`, retrieve the candidate paths and record an explicit selection before use. A capped inventory cannot establish a sole recipe.
5. If no recipe exists and the user asks to prove visible behavior, plan creation of `docs/verification/SKILL.md` and `docs/verification/features/`. Wait for the successful implement gate before writing them.

Keep one recipe and map directory. Report an extra `docs/features/` directory and preserve it. `ae install` does not create product recipes. A returned path is discovery metadata. Record an actual successful recipe read before claiming loading. Reading a repository path does not establish native editor registration.

Classify this artifact as a product skill with supporting feature references. Reuse this creator workflow and its plan governance. No new public skill, agent, scheduled upkeep job, or separate map database is required.

## Write the six lifecycle sections

Fill each section with observed commands and prerequisites from this product. Leave no placeholders in a delivered recipe.

| Required heading | Required content |
|---|---|
| `## Launch` | The command that starts the product, the readiness observation, the owned handle, and teardown. For a short-lived CLI, build once and start each drive in its own session. State whether concurrent instances are supported and how they remain separate. |
| `## Doctor` | One read-only readiness check. Run it before the first drive and after every failed drive. A failed doctor blocks driving until its prerequisite is restored. |
| `## Drive` | The product's real commands, UI routes, and handles. Exercise each required entry path from the selected feature files. Assert the resulting state after each action. |
| `## Evidence` | The action, result, exit status, check ID, and artifact reference. Record the authoritative Harness verification outcome after it runs. Keep long logs out of conversational context. Preserve evidence through cleanup. |
| `## Cleanup` | Stop processes and remove disposable resources owned by the drive, including after failure or cancellation. Use owned PIDs or handles. Never kill by process name. Confirm that evidence still exists after cleanup. |
| `## Helpers` | Every helper's executable command, required inputs, output, and named-check ID. Mark platform prerequisites and unsupported paths. |

Register the doctor and drive helpers in the selected check source reported by `ae checks list --json` before the plan requires them. A drive may own its doctor and the rest of the lifecycle in one registered helper. Declare the corresponding check IDs on the accepted plan. Each required check must assert behavior and return a failed status when the assertion fails.

Use [named-checks.md](named-checks.md) when executable registration is missing. Engineer prepares the concrete declarations through the bounded configuration writer before requesting any necessary person approval. This configuration step can precede the implement gate; recipe, helper, feature-map, and product-code edits still need their accepted scope and successful gate.

Harness runs configured argv without a shell. Do not run an unknown helper beside the authoritative named-check path. An opaque terminal command still needs its existing gate and trust authority. A standalone audit that cannot register a missing check inside its accepted scope reports that prerequisite gap.

For declared artifact output, use explicit relative JSON filenames in the check's `artifacts` list. Write them beneath the runner-supplied `HARNESS_CHECK_ARTIFACT_DIR`. Each invocation receives a separate directory. Do not overwrite a shared latest receipt. The initial contract accepts at most 16 JSON objects of at most 1 MiB each. It rejects missing, malformed, symlinked, nonregular, or escaping files. Harness redacts the stored receipt and records its path, byte length, and SHA-256. Evidence validation rereads required artifacts before accepting current proof.

Artifact presence is not a behavioral pass. The helper must capture an actual action and assert its observable result. Screenshots and arbitrary log formats require a separately supported artifact contract. A unit suite or packaging check does not establish that the product route was driven.

## Write the feature map

Create `features/README.md` as the map index. List each mapped feature, its file, named check, prerequisites, and coverage limits. Seed the top three features relevant to the user's task. Record other known behavior as unmapped. Initial coverage is partial.

Each feature file has these four sections in this order:

1. `## Sub-features` lists the distinct behaviors the drive proves.
2. `## How a person reaches it` names every relevant user entry path and its prerequisites.
3. `## Driving it` gives the named helper, actions, observations, and expected results for those paths.
4. `## Gotchas` records environment constraints, failure behavior, ownership, and unreachable cases.

Read source to establish the entry paths. Then drive those paths through the product. A convenient internal API call does not prove a mapped UI or CLI route. The installed-product `product-flow-map.example.json` remains a doctor proof adapter. It is not the recipe or feature-map format.

## Exercise the recipe before handover

Run one scoped Deliver journey through launch, doctor, a mapped feature, evidence, and cleanup. Confirm that the artifact survives cleanup and names the action and resulting state. Collect required review, then run authoritative Harness verification against the completed change. A recipe that has never completed this journey remains a draft.

Record the actual package or commit, host and plugin when applicable, route, check IDs, artifacts, cleanup result, and coverage. Keep local CLI proof separate from native editor activation. A missing environment is a coverage gap.

If a route cannot be reached, record the missing prerequisite and attempted route. If behavior contradicts accepted intent, report or repair the product defect within authorized scope. Do not change an assertion to make the defect intentional without an accepted intent amendment.

## Maintain affected features

For an ordinary visible change, choose the affected feature files and shared prerequisites. Record why that selection covers the change. Update those files in the same work and bind their named drives to the acceptance criteria. Run the selected drives through the recipe's lifecycle.

Expand coverage when a shared authentication, route, or runtime change can affect other mapped features. Record the reason for full coverage. Do not impose a full feature audit on every local visible change.

## Audit the complete map when requested

Read source for every mapped feature. Drive every mapped feature through the selected recipe, even when source review finds no discrepancy. Run doctor before the first drive and after a failed drive.

Audit edits stay inside the selected verification directory. A product defect remains a reported gap unless a separately scoped Deliver change authorizes its repair. A missing check registration outside that directory remains a prerequisite gap. Preserve the observed behavior, attempted route, and prerequisite for unreachable features.

Report one of these outcomes:

- `clean` means the map matches the driven behavior and needs no edit.
- `changed` means the updated map has proof for the declared coverage.
- `blocked` means the report names the prerequisite or defect that stopped coverage.

Finish a changed audit through the existing review, verification, learning decision, and completion procedure. Do not report complete product coverage when any mapped feature is blocked or known behavior remains unmapped.
