# Harness CLI verification map

This directory is the maintained source for verifying user-facing Harness CLI behavior. Read this index before driving the CLI, then use the matching feature file as the recipe.

## Baseline preconditions

- Work from an Adaptive Engineering checkout that contains `packages/ae/bin/ae.mjs`.
- Run `node .cursor/skills/verify-harness/scripts/doctor.mjs` and require exit `0`.
- Drive only disposable git workspaces. Never pass `--workspace` at the operator checkout for a mutating proof.
- Set `AE_HOME` and `--copilot-home` to temp directories owned by the drive.
- Keep `CI` and `HARNESS_ALLOW_INPLACE` unset unless a recipe names them.

## Driving conventions

- Start every recipe from a fresh `git init` workspace unless its preconditions say otherwise.
- Treat every command as literal. Keep flag names unchanged.
- Parse `--json` stdout. Then read the files the command wrote.
- Restore nothing to the operator tree. Delete the temp workspace after the drive.

## Proof and skip reporting

- Capture the command, exit code, stdout, and the resulting plan or gate JSON.
- Mutation proof includes a second read of the written file.
- Record the feature ID and entry point with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How a person reaches it` names user entry points and their prerequisites.
3. `Driving it` pairs user actions with exact commands and observable results.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Structural evidence and impact context](./structural-context.md) covers real AST import evidence, bounded impact, historical snapshots and source packets through `verify-structural-context`.
- [Intent lock](./intent-lock.md), named check `verify-intent-lock`, covers spec discovery, accepted hashes, changed/missing-source rejection, frozen selections, and explicit amendments.
- [Issue worktree](./issue-worktree.md) covers isolation from the default-branch checkout and `ae worktree --slug`.
- [Prepare](./prepare.md) covers starter spec and ADR files, orient discovery, skip-on-edit, and gitignored `docs/`.
- [Journey performance](./performance.md) covers a disposable domain, linked analysis views, stale measurements and scoped authoring/review context through `verify-performance`.
- [Installed release](./installed-release.md) covers a packed fresh installation, predecessor upgrade, matching hydrated runtime and corpus, and completed bounded experiment delivery.
- [Self-contained diagrams](./diagrams.md), named check `adaptive-diagram-tests`, covers authored views, import and flow projections, source freshness, native tool admission, and offline renderer installation.
- [Formal models](./formal-models.md), named check `verify-formal-flows`, covers committed-default-branch preparation, authored map publication, relevant bounded orientation, freshness, obsolete-candidate rejection, and explicit maintenance. It needs ordinary Node/Git readiness; deeper checking is opt-in.
- [Workflow invariants](./workflow-invariants.md), named checks `verify-workflow-invariants` and `verify-workflow-invariants-negative`, cover actual mutation/recovery/completion authority and deliberate-break detection in an owned package copy. They do not require TLC.
- The [delivery-evidence model](../formal/delivery-evidence/SKILL.md), named check `verify-formal-delivery`, checks every path through a Mermaid state diagram of the delivery workflow. It needs only Node and describes the intended workflow; the workflow-invariant checks confirm the code follows it.
