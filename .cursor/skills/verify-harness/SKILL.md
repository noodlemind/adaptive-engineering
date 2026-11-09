---
name: verify-harness
description: Prove AE CLI intent lock, preparation, worktree isolation, structural context, diagrams, flows, workflow invariants, and installed releases. Use for runtime verification. Not for code review or general CLI questions.
---

# Verify Harness

The user-facing surface is the `ae` CLI in `packages/ae`. There is no web UI. Agents call `orient`, `prepare`, `plan-new --file`, `plan-update --file`, `gate --phase implement`, `worktree`, and `flows`. Prove those commands in disposable git workspaces. The installed-release drive packs the checkout, installs that archive, upgrades the preceding source-package fixture, and then runs the hydrated CLI.

## Launch

There is no long-lived server. Install package deps once, then start each drive in its own temp git workspace.

From the repository root:

```bash
node packages/ae/bin/ae.mjs help
```

Ready when that command exits `0` and prints command names including `orient`, `prepare`, `plan-new`, `gate`, and `worktree`.

Teardown is per drive. Delete the temp workspace and `AE_HOME` directory that drive created. Do not kill by process name.

Two drives can run side by side. Give each drive its own `--workspace`, `--copilot-home`, and `AE_HOME`.

## Doctor

Each named drive runs this read-only check before its first action. Run it again after a failed drive before re-driving:

```bash
node .cursor/skills/verify-harness/scripts/doctor.mjs
```

Doctor exits `0` only when Node is 20 or newer, `packages/ae/bin/ae.mjs` exists, the `yaml` package loads, and `git` is on `PATH`. Do not drive an instance whose doctor failed.

## Drive

Use isolated temp git repos. Do not drive the operator checkout.

1. Create a temp workspace with `git init`, a tracked spec under `docs/specs/`, and `.github/harness/checks.yaml`.
2. Set `AE_HOME` to a temp directory. Pass `--workspace` and `--copilot-home` on every command.
3. Spawn `node packages/ae/bin/ae.mjs <command> --json`.
4. Parse stdout JSON and the written plan file. Assert the observable values named in the feature map.

Bind the affected feature's named checks to the accepted plan. Harness runs their configured helper argv. Each helper owns readiness, drive, evidence, and cleanup. Run doctor before selecting a drive. These helpers do not start a long-lived server. Shared flow-map verification and workflow conformance need only the ordinary doctor. The delivery-evidence model check needs only Node.

## Evidence

Proof standards:

- Exercise the real CLI path (`plan-new`, authored `plan-update`, `gate`, `orient`, `worktree`), not internal setters.
- Capture the command, argv, exit code, stdout, and the resulting plan frontmatter or gate check.
- For a mutation, read the file again after the command returns.
- Do not treat a passing unit test file as proof of the CLI.

Write artifacts to `.cursor/skills/verify-harness/evidence/<feature>/`. The helper can use `HARNESS_DRIVE_EVIDENCE_ROOT` for an isolated output root. Keep evidence out of git. Each receipt records invocations, owned resource paths, doctor outcome, and cleanup. When `/opt/cursor/artifacts` exists, copy the same files there.

The installed-release drive requires the verification controller's `HARNESS_CHECK_ARTIFACT_DIR`. It writes `installed-release.json` there and preserves its archive, command receipts, completed plan, numerical artifacts, and final evidence in `build/` and `drive/`. The receipt records the source SHA and dirty state. It distinguishes the preceding source-package fixture from a published release and makes no native editor or model-quality claim.

The formal-flow and workflow-invariant drives write `formal-flows/drive.json`, `workflow-invariants/drive.json`, or `workflow-invariants-negative/drive.json` beneath `HARNESS_CHECK_ARTIFACT_DIR`. Their manual runs use private invocation directories when no artifact root is selected. The delivery-evidence model check writes `state-model.json`, `report.md` and `chart.mmd`; its [repo-local skill](./formal/delivery-evidence/SKILL.md) separates the diagram check from the behavior checks that drive the real code. None of these receipts establishes model quality or native editor activation.

A proof includes the action and the resulting state. Example for intent lock: `plan-new` stdout path, the plan's `intent_sources[0].path`, `intent_sources[0].sha256` equal to the sha256 of the spec bytes at lock, then `gate --phase implement` exits `1` after the spec file is rewritten and exits `0` only after an accepted source amendment.

## Cleanup

Delete temp workspaces, temp `AE_HOME` dirs, and linked git worktrees the drive created. Kill only PIDs the drive started. Leave evidence files in place. Confirm the evidence path still exists after cleanup.

## Helpers

- Doctor: `node .cursor/skills/verify-harness/scripts/doctor.mjs`
- Intent lock proof: `node .cursor/skills/verify-harness/scripts/prove-intent-lock.mjs`
- Worktree proof: `node .cursor/skills/verify-harness/scripts/prove-issue-worktree.mjs`
- Prepare proof: `node .cursor/skills/verify-harness/scripts/prove-prepare.mjs`
- Journey performance: `ae checks run verify-performance --json`; the [feature recipe](./features/performance.md) records the CLI and separate browser proof.
- Installed release proof: `ae checks run verify-installed-release --json` from a trusted checkout on macOS; see [the installed-release recipe](./features/installed-release.md).
- Structural evidence and impact: `ae checks run verify-structural-context --json`; see [the feature recipe](features/structural-context.md).
- Shared flow models: `node .cursor/skills/verify-harness/scripts/prove-formal-flows.mjs`, named check `verify-formal-flows`; see [formal models](./features/formal-models.md).
- Self-contained diagrams: `ae checks run adaptive-diagram-tests --json`; see [diagram rendering](./features/diagrams.md) for real CLI, native tool, offline installation, freshness and negative-control coverage.
- Workflow conformance: `node .cursor/skills/verify-harness/scripts/prove-workflow-invariants.mjs`, named check `verify-workflow-invariants`.
- Deliberate-break detection: `node .cursor/skills/verify-harness/scripts/prove-workflow-invariants.mjs --negative-control`, named check `verify-workflow-invariants-negative`; see [workflow invariants](./features/workflow-invariants.md).
- Delivery-evidence workflow model: `node .cursor/skills/verify-harness/formal/delivery-evidence/scripts/check.mjs`, named check `verify-formal-delivery`. It checks every path through a Mermaid state diagram and needs only Node; read the [skill](./formal/delivery-evidence/SKILL.md) first.

## Trigger Examples

**Should trigger:**

- "Prove that changed locked specs block implementation."
- "Verify prepare preserves edited starter documents."
- "Demonstrate issue worktree isolation through the CLI."

**Should not trigger:**

- "Review this code diff." Use code review.
- "Explain a CLI option." Answer from command help.
- "Verify a web application's login." Use that product's own recipe.
