# Create and maintain repo-local formal verification

Use this creator branch for an accepted critical property whose failure is costly and whose orderings or input space ordinary tests do not cover. The Engineer chooses the property, abstraction and method. Harness continues to run registered checks and bind evidence through its existing contract. This branch adds no public skill, agent, tool installation, project approval or scheduled job. AE ships no JVM-based checker and never downloads one.

## Choose the target

Start from accepted intent and actual source. If the user named an area or a bug, start there. Otherwise rank candidates by the harm a break causes and how rarely tests reach the breaking case: workflow gates, retries, recovery, concurrency, parsers and state machines. Choose the strongest target, not the easiest to model. Propose it to the user as accepted intent before modeling; never infer a promise from a generated map or rewrite one from buggy code.

Consult a relevant current shared flow model only as descriptive context. Missing optional context does not establish a proof gap by itself.

Reuse the selected product verification directory. Put each specialized verify skill, companion `maintain/SKILL.md`, model, rules file and helper beneath a property subdirectory. These are repo-local supporting skills read explicitly by the Engineer; native editor discovery remains unverified. Do not add competing top-level `verify-*` recipes or install a global primitive merely to add one property. The existing implement gate applies before creating these files.

## Let the question choose the method

- **Ordering questions** (can a step happen before its guard, can a workflow get stuck): model the workflow as a Mermaid state diagram and check it with the shipped state-model starter.
- **Code-level questions** (memory safety, arithmetic, a data-structure invariant): prefer a verifier that runs on the shipped code. Where none runs on this language, test the real code with generated inputs and say that this is testing. A small handwritten copy of a function is not an implementation proof.
- **Counters and data**: the state-model starter has no variables. Cover bounds such as retry counts with behavior checks that drive the real code.

## The state-model starter

Read `<copilot-home>/skills/create-primitive/assets/state-model/check.mjs` with the host read tool and copy it into the property's `scripts/check.mjs`. Outside the enforce hook, `ae get --reference skills/create-primitive/assets/state-model/check.mjs --json` prints the same file. It uses only Node built-ins and needs no installed AE. In this library's own pilot, a thin wrapper imports the shipped asset because the library owns it; other products copy it.

The model is a Mermaid `stateDiagram-v2` with this subset: `A --> B` with an optional `: Action` label, `state "Plain words" as A` for the reader-facing name, `[*]` for start and end, and `%%` comments. An edge to `[*]` is a correct end, so a finished workflow is not a dead end. Label each state with what the reader sees or cares about, such as "Verified, proof current", and keep code names out of labels.

The rules file is data, not code:

| Field | Meaning |
| --- | --- |
| `schema`, `actions`, `required` | Schema `1`, every allowed action name, and actions the model must contain |
| `rules[]` | Each has an `id`, a `kind`, and a `says` sentence in plain words. `requires`: every `action` follows `requires`, optionally since the last `resetBy` action. `inert`: `action` never changes state. `reachable`: after `after`, `action` stays reachable from every state that has not ended. A state whose only exits go to `[*]` is a legal end, such as cancellation; a finished run never restarts |
| `negativeControls[]` | Broken variants that must be caught: `removeAction` or `addEdges`, with the rule id it must `expect`. At least one is required |
| `limits` | What the model leaves out |

Write each rule the reader agrees to. If no action expresses a rule, add the action to the model. Never weaken a rule to obtain a pass.

Run it from the product root:

```bash
node <property>/scripts/check.mjs --model <property>/model.mmd --rules <property>/rules.json
```

It explores every path, reports each broken rule with its shortest path from the start, then checks each broken variant. It writes `state-model.json`, `report.md` and `chart.mmd` to `--out`, to `HARNESS_CHECK_ARTIFACT_DIR` when Harness runs it, or otherwise to a private temporary directory whose path it prints to stderr. It exits `1` when a rule breaks or a variant is missed, and `2` on bad input. Register that argv as a named check through the existing trusted check configuration and accepted plan, and declare `state-model.json` in its artifacts.

## Generate a specialized verify skill

Write frontmatter naming the guarded area, activation conditions and exclusions. Include the property and user harm in one plain sentence each, accepted intent sources, covered state writers, the filled-in command, assumptions, last synchronization record, results and exclusions. Leave no placeholders. Include at least three positive and three negative triggers.

Tell the next agent to read every result through its chart: render `chart.mmd` with `ae diagrams render --renderer pele`, and give each broken rule as its numbered path from `report.md` in the model's plain-word labels. Name the command; do not copy its options into scripts. The chart is descriptive context; the receipt is the evidence.

Keep normative rules separate from descriptive transitions. Specify useful progress with a `reachable` rule as well as safety, so a model that refuses all useful work cannot pass. Never assert unconditional completion when cancellation or user abandonment are legal.

## Pair the model with the real code

A passing model shows that the intended workflow obeys its rules. It does not show that the code follows the model. Pair it with a behavior check that drives the real code on a disposable copy and confirms that a deliberately weakened guard is detected. Replay each modeled bug against the real code, one step per action. If the bug does not reproduce, assume the model is wrong until shown otherwise.

## Prove the generated skill before delivery

1. Run it on current code. A skill that has not run remains a draft.
2. Confirm every negative control is caught for its intended rule, not by accident.
3. Confirm a deliberate implementation mutation on a disposable copy is detected through the behavior check.
4. Restore or delete only owned scratch changes and confirm the unmodified result.
5. Preserve the receipt, the model and rules digests, the real bug paths and cleanup evidence.

Report omitted state writers and untested assumptions. A diagram, a passing run or a large explored-state count cannot establish completeness.

## Generate the companion maintenance skill

The companion reads the property skill and its last receipt, then reads changes since the recorded sync commit, including moved functions and new writers. Classify each change as irrelevant, descriptive model drift, an intended promise amendment backed by accepted intent, or a possible product defect. Update the model from code before using its result to guide repairs. Do not weaken a rule or delete a negative control to obtain a pass.

Advance the sync record only after the model, rules and behavior check all pass at the new commit. A failed or blocked run keeps the prior record. An updated model that exposes a bug is a finding. Maintenance edits verification assets only; a product fix follows its own accepted Deliver scope. Report `in-sync`, `updated`, `bug` or `blocked`, with checks, rationale, findings and limits.

## Activation scenarios and expected outcomes

These cases are selection fixtures for the Engineer; they do not establish model quality by being listed.

| Positive trigger | Expected outcome |
| --- | --- |
| Prove retry ordering cannot publish twice | One property-specific model, rules and behavior check |
| Model-check that a refund can never skip approval | A `requires` rule with a caught negative control |
| Verify current evidence before learning | Use the project's existing workflow conformance check before adding a model |
| An agent changed the guarded state writer | Maintain, review drift and rerun current code |
| A merge moved a covered function | Follow its new location; preserve identity and old result |
| Show this bug as a path through states | Run the check and present the numbered path and marked chart |

| Negative trigger | Expected outcome |
| --- | --- |
| Explain what a state diagram means | Answer; create no artifact |
| Fix spelling in an unrelated README | Ordinary proportional verification; load no model |
| Show me an application flow diagram | Use the descriptive map; do not claim a checked property |
| Install a model checker for me | AE ships and installs none; use the Node starter or a verifier the product already has |
| The check fails; mark it passed | Return the failure and preserve sync metadata |
| Weaken the rule until current code passes | Preserve the finding; require accepted evidence for a changed promise |

Background: [Lamport on abstractions](https://lamport.azurewebsites.net/tla/high-level-view.html) and [safety and liveness](https://lamport.azurewebsites.net/tla/tutorial/session9.html). Lauren Tan's pstack [create-formal-verification-skill](https://github.com/cursor/plugins/blob/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe/pstack/skills/create-formal-verification-skill/SKILL.md) and [statechart](https://github.com/cursor/plugins/blob/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe/pstack/skills/statechart/SKILL.md) skills informed this design; AE's implementation is its own and depends on neither.
