# Installed release

The packed checkout must install and upgrade into a matching CLI, hooks, schemas, and corpus. Its hydrated runtime must complete the bounded numerical experiment and the ordinary review, verification, learning, and completion lifecycle.

## Sub-features

- `release-fresh` installs the locally built archive into isolated homes and checks its version and schema 4.
- `release-upgrade` upgrades the exact pre-experiment 0.10.0 source-package fixture into the current package version.
- `release-corpus` checks that the hydrated skills, agents and instructions match the source corpus counts, with four public skills, one public agent, and relocatable hooks.
- `release-experiment` measures four charged score/guard pairs, refuses an incorrect keep, restores the last kept candidate, and reaches the accepted target.
- `release-preserve` preserves unrelated staged work, the user index, and HEAD through measurement and rollback.
- `release-complete` produces current evidence version 7 and a completed plan through the installed runtime.

## How to get to it (user POV)

- Bind `verify-installed-release` as a required behavior check in the accepted release plan, then run `ae verify --plan <plan> --json`.
- Run `ae checks run verify-installed-release --json` for a focused drive before full plan verification.
- Read the captured `installed-release.json` and its referenced `build/` and `drive/` files after the disposable homes are removed.

## Driving it with prove-installed-release.mjs

Preconditions:

- Doctor exited `0`; Node, npm, and Git are available.
- The source package is version 0.11.0 or later, with its bundled dependencies present for an offline local installation.
- The check runs on macOS, the supported experiment sandbox host. The Windows pilot was waived; it is not reported as verified.
- The checkout's check configuration is trusted. The verification controller creates `HARNESS_CHECK_ARTIFACT_DIR`.

- **Drive.** Run `node packages/ae/bin/ae.mjs checks run verify-installed-release --json` from the checkout. Require exit `0`, check status `passed`, and the captured `installed-release.json` artifact.
- **Installation.** Read that artifact. `freshInstall.matchedPackage`, `freshInstall.schema4`, `upgrade.lockUpdated`, and `upgrade.newReferenceHydrated` are `true`; the package and upgrade versions match the source version.
- **Measurement.** Read `measurements` and the eight archived `measurement.json` artifacts. The four observed losses are `2`, `1`, `0`, and `0.5`; correctness is `true`, `true`, `false`, and `true`. Each attempt has one score and one guard artifact.
- **Retention.** Read `final` and `preservation`. The experiment is `target-reached`, spent invocations are `8`, retained weights are `[1.5, 1.5]`, and index, HEAD, unrelated bytes, and staged diff preservation assertions passed.
- **Completion.** Read `drive/completed-plan.hplan` and `drive/final-evidence.json`. The plan is `done`, evidence version is `7`, and both experiment target and retention stability checks passed without an extra unbudgeted scorer run.
- **Cleanup.** Read `cleanedTemporaryRoot`. It is `true`; the captured archive and receipts remain available.

## Gotchas

- The predecessor archive is an exact source-package fixture from commit `1265403`, not proof of a published 0.10.0 release.
- The receipt reports a dirty checkout honestly. Commit the final release and rerun the drive when a clean source SHA is required.
- This scripted acceptance checks installed behavior. It does not establish native editor activation or model quality; those require separate evidence.
- Do not invoke the helper directly without its controller-owned artifact directory. It intentionally refuses missing setup or an unsupported host.
- The helper removes only its temporary installation and workspaces. Keep the controller-owned archive and receipt directory for review.
