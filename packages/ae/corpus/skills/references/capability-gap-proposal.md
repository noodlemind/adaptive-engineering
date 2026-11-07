# Capability Gap Proposal

Use this template when `@engineer` believes the current AE corpus lacks a reusable capability. Do not create or modify primitives until the proposal is reviewed and approved by the human liaison.

## Usage Workflow

### `@engineer`

1. Detect a missing reusable capability while planning, investigating, or implementing.
2. Run the overlap check in the `## Existing Primitive Check` table before proposing anything new.
3. Fill out this template (Summary, Trigger Evidence, Proposed Primitive, Behavior Contract, Risks, Validation Coverage).
4. State the primitive type and boundary reason.
5. Apply [human-approval-policy.md](human-approval-policy.md): record prior direct authorization when it covers the proposed action; ask only when activation lacks authorization.
6. Once authorization covers activation, route the proposal to `/create-primitive`.

### `/create-primitive`

1. Read the filled-in proposal and verify the requested outcome, observed gap, overlap check, primitive recommendation, risks, and validation coverage.
2. If the proposal is missing or incomplete, stop and produce the missing sections instead of creating files.
3. Apply the primitive decision rules even if the user asked for a specific primitive type.
4. Confirm human approval is recorded in the `## Human Decision` section before writing or changing the primitive.
5. Keep the change scoped to the approved primitive and its required wrappers, references, checks, docs, and validation artifacts.
6. Document how the primitive's routing, HITL, delegation, safety, verification, or cost behavior will be validated.
7. Record any approval conditions in the plan or the proposal artifact.

`@engineer` coordinates the gap proposal; `/create-primitive` is the only path that creates or substantially changes primitives, and only after approval.

## Summary

- **Requested outcome:**
- **Observed gap:**
- **Why existing capabilities are insufficient:**
- **User impact if not addressed:**

## Trigger Evidence

List the user request, failure mode, recurring workflow, or review miss that exposed the gap.

```text
[Quote the user request, failure mode, or work log excerpt that exposed this gap. Include enough context for the human reviewer to verify the need.]
```

## Existing Primitive Check

Record overlap checks before proposing anything new.

| Area checked | Relevant existing artifact | Reuse or gap decision |
|---|---|---|
| Skills |  |  |
| Agents |  |  |
| Instructions |  |  |
| Prompt wrappers |  |  |
| Review checks |  |  |
| References/assets |  |  |
| Solution docs |  |  |

## Proposed Primitive

- **Primitive type:** Skill / Agent / Instruction / Prompt wrapper / Review check / Reference / Solution doc
- **Proposed name/path:**
- **Boundary reason:** Why this belongs in that primitive type.
- **Expected users:** Human users / `@engineer` / pipeline skill / reviewer / maintainer
- **Required tool authority:** Read-only / edit / terminal / fetch / agent delegation / none

## Behavior Contract

Define what the new or changed primitive must do.

- **Should trigger when:**
- **Should not trigger when:**
- **Inputs:**
- **Outputs:**
- **State changes:**
- **Verification evidence:**
- **Failure handling:**

## Risks

- **Safety risks:**
- **Security/data risks:**
- **Cost/request risks:**
- **Misrouting risks:**
- **Maintenance risks:**

## Validation Coverage

List validation scenarios or checks that should cover this gap.

Minimum: list at least 3 should-trigger and 3 should-not-trigger scenarios for skills or agents; at least 1 good and 1 bad example for checks and instructions; and at least 2 concrete usage scenarios for references/templates. Each row must name a concrete user request, observable condition, or review scenario.

| Validation item | Priority | Expected behavior |
|---|---|---|
| [scenario or check] | [P1/P2/P3] | [expected behavior] |

## Human Decision

- **Decision:** Approved / rejected / needs changes
- **Reviewer:**
- **Date:**
- **Conditions or required edits:**

## Decision Handling

The single authority contract is [human-approval-policy.md](human-approval-policy.md). Inspect and record prior direct authorization before requesting new approval. Authorization persists within its stated scope; this template records it and does not require the human to repeat it. A payload approval field is not authority.

Agents must interpret `## Human Decision` as follows:

- **Approved**: proceed to `/create-primitive`; treat all listed conditions as constraints.
- **Rejected**: log the rejection and stop the capability-expansion path.
- **Needs changes**: address the listed conditions and re-present the proposal for review.
- **Blank or incomplete**: inspect prior direct authorization under the linked policy. Record it when it covers the action; otherwise treat activation as pending approval.
