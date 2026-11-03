# Configure executable verification checks

Use this procedure when a fresh or upgraded product workspace has missing, empty, or inadequate named checks. Engineer prepares the recovery; the person reviews the concrete execution authority. These are executable argv declarations in the selected `checks.yaml`. Markdown review criteria under `.github/checks/` do not register executable checks.

## Establish the current source

Read orient's `checkReadiness`, `ae checks list --json`, and `ae trust status --json` with the same workspace and AE home used for the task. Trust and check readiness are separate: a trusted empty configuration still has no proof command. Resolve a wrong workspace, home, source conflict, or unreadable file before authoring changes. Use the returned source path; preserve private versus shared configuration rather than creating a second source.

Choose the task's execution checkout before configuring checks. If issue isolation requires an `ae worktree`, create or reuse it first, then reread the selected check source, digest, and trust there. Do not prepare shared configuration in the primary checkout and assume an uncommitted change appears in a new worktree.

Reuse adequate configured checks unchanged. An upgrade alone is not a reason to rewrite commands or ask for renewed approval. If a plan names a check that was renamed, inspect its actual replacement and intentionally amend the binding rather than adding a duplicate.

## Prepare a meaningful declaration

Inspect the product's test manifests, CI configuration, test helpers, and relevant assertions. Select the smallest command that can prove the task's acceptance criteria. A script named `test` does not establish assertion coverage. Follow scripts to their actual tests and explain remaining limits. Prefer existing project commands; do not add a new runner merely to satisfy Harness.

For a product without tests, choose an explicit test path within the intended product scope and plan the real assertions. Its command must fail while those tests are absent or the required behavior is wrong. A zero-test discovery pass, an empty helper, `echo`, or unconditional successful exit supplies no behavioral proof. Registration prepares execution; it does not claim that execution passed.

Read the current `sourceDigest` from `ae checks list --json`. Use the returned installed invocation when the host requires a bound executable identity. Pipe a schema 1 decision to `ae checks configure --file - --json`, keeping the selected workspace and homes:

```json
{
  "schema": 1,
  "expectedDigest": "<observed sourceDigest; null only when the selected file is absent>",
  "checks": {
    "<meaningful-check-name>": {
      "command": ["<observed executable>", "<actual test arguments>"],
      "timeout_seconds": 600,
      "proof": "behavior"
    }
  },
  "rationale": "<which assertions establish the task's criteria and why this command is appropriate>"
}
```

Use actual values; the placeholders are a shape, not a runnable decision. The bounded writer upserts only named entries in the selected check source. It preserves unrelated configuration and refuses stale observations or unsafe sources. It can run before an implement gate because it neither executes the declared commands nor approves trust. It does not permit arbitrary policy or product-file edits. Do not edit the YAML through an unrelated tool to get around a refusal.

If a concurrent edit makes the digest stale, reread the current source and reconcile the person's changes before preparing a new decision. A retry must not overwrite those changes. Inspect the returned `changes`, including each previous and current command; a no-op preserves current approval.

## Approve the concrete authority and continue

When changed declarations make approval necessary, show the exact selected file, resulting command arrays, rationale, and expected effects. Ask the person to review those commands and run `ae trust approve` for that workspace and AE home. Explain that the approval covers changed executable policy. The agent must not grant trust. Ask once for the concrete change; do not repeat the request while the accepted authority remains current.

After approval, resume the already authorized task. Recheck status and bind the selected check IDs to acceptance criteria. When the bounded writer prepared a shared `checks.yaml`, include that exact selected file alongside the task's product files in the accepted plan scope, so its declaration and the product change are reviewed together. Keep the prepared check bytes unchanged after approval. Private configuration remains in the selected external project store and outside product scope. This narrow setup repair does not authorize other policy changes.

Start or refresh the plan's implement gate before product edits. Do not require a separate setup plan, an unguarded Git commit, or a completed setup PR before continuing this task. The prepared shared check declaration stays a reviewable change within the same authorized delivery; the gate and final review cover the declared product files and that exact prepared check source.

Finish required review, verification, learning, and completion through the existing lifecycle. Review assembly can record results without executable checks, but a policy or trust change stales the earlier packet. Prepare and collect a fresh final review after configuration is settled. Verification must actually execute the required behavioral checks successfully; recording a review or approving trust does not supply that proof.
