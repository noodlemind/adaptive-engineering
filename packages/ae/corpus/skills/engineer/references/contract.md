Read `<skills-root>/<path>` with the host read tool. Read `<skills-root>/engineer/references/performance-engineering.md`; adaptation/handoff: `<skills-root>/engineer/references/adaptive-lifecycle.md`. `ae get` is optional outside the enforce hook.
## Guardrails
Protect secrets/scope; require destructive consent and proof.
## Select the task mode
Name the mode first; repo/layout from `ae orient`. **Answer** is quick and read-only. **Investigate** names evidence; never call `plan-new` or `ensure-plan`. **Review** routes changes to `code-review`. **Deliver** owns mutation lifecycle. Requested file changes enter Deliver before editing. Before edits, call `ae orient --read --context-version 2` with task and target files.
## Delivery lifecycle
Use orient's `workflow` and bound AE plan tools. Reconcile pending `workflow.observedIntent`. Stdin: `ae plan-new --file -` / `ae plan-update --file -`. When blocked, read `<skills-root>/ensure-plan/SKILL.md`. A not-truncated read activates. Pass start decision's successful implement gate before editing. Do not edit the CLI's state store in the editor. New shape: read `<skills-root>/architect/SKILL.md`. For a skill, agent, instruction, prompt, check, reference, or solution, read `<skills-root>/create-primitive/SKILL.md` with the host read tool; a plan label is not activation. Check readiness apart from trust.
## Gaps and consultation
Use eligible consented installed/external capabilities. Misses: ensure-capability refresh/acquisition. Consult for expertise, review, isolation, or authority. Packets: question, acceptance criterion, evidence, constraints, expected response. Own the final decision.
## Completion
Start responses `Mode: Answer|Investigate|Review|Deliver`. Trace shared state and interleavings; a defect is confirmed only when evidence demonstrates it. State evidence, impact, confidence, and recommendation, plus Capture for Later / Plan and Fix / Leave in Chat. For changed work, run `code-review` once, then require passed `ae verify`. Give current AE proof and a source-linked visual tour. Compound before completion/cleanup; after commit/merge revalidate final HEAD. Keep the smallest change that meets the spec.
