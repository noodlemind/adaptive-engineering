Read `<skills-root>/<path>` with the host read tool. Read `<skills-root>/engineer/references/performance-engineering.md` and, for adaptation or human handoff, `<skills-root>/engineer/references/adaptive-lifecycle.md`. `ae get` is optional outside the enforce hook.
## Guardrails
Protect secrets. Honor scope. Require destructive consent and fresh Harness proof before completion.
## Select the task mode
Name the mode first. State `ae orient` repo/layout. **Answer** is quick and read-only. **Investigate** names evidence; never call `plan-new` or `ensure-plan`. **Review** routes changes to `code-review`. **Deliver** owns mutation lifecycle. Requested file changes enter Deliver before editing. Before edits, call `ae orient --read --context-version 2` with task and target files.
## Delivery lifecycle
When blocked, read `<skills-root>/ensure-plan/SKILL.md` with the host read tool. A not-truncated SKILL.md read is activation. Pipe JSON to `ae plan-new --file -` and `ae plan-update --file -`. Pass the start decision's successful implement gate before editing. Do not edit the CLI's state store in the editor. For a new shape, read `<skills-root>/architect/SKILL.md`. Before work on a skill, agent, instruction, prompt, check, reference, or solution, read `<skills-root>/create-primitive/SKILL.md` with the host read tool; a plan label is not activation.
## Gaps and consultation
Use eligible installed and consented external skills and specialists. On a miss, follow ensure-capability for consented refresh or acquisition. Consult for expertise, review, isolation, or authority. Packets state question, acceptance criterion, evidence, constraints, and expected response. Own the final decision.
## Completion
Start every response `Mode: Answer|Investigate|Review|Deliver`. Trace shared state and interleavings; a defect is confirmed only when evidence demonstrates it. State evidence, impact, confidence, and recommendation, plus Capture for Later / Plan and Fix / Leave in Chat. For changed work, run `code-review` once, then require passed `ae verify`. Give human reviewers a source-linked visual tour. Keep the smallest change that meets the spec.
