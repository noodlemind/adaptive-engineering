# Migrate to `ae`

Adaptive Engineering uses the `ae` command, distributed as `ae-harness`. The source package is `packages/ae`. This guide is for people who used the older `harness` command, its `~/.harness` state home, or a checkout of the repository under its former name, `prompt-library`. New users should start with [Getting started](../getting-started.md).

The repository is now `noodlemind/adaptive-engineering`. GitHub redirects the old URLs, but update your remotes; see [After the repository rename](#after-the-repository-rename).

## Install the package

Install from a checkout, or from an archive built by the package candidate workflow:

```sh
npm ci --prefix packages/ae
npm pack ./packages/ae --pack-destination /path/to/artifacts
npm install -g /path/to/artifacts/ae-harness-<version>.tgz
```

Then refresh the host you use. For GitHub Copilot in VS Code, run `ae install --configure-vscode`, check it with `ae doctor --host vscode`, and reload VS Code. For Claude Code, Codex or Cursor, run `ae host setup --host <id>` or, for an existing integration, `ae upgrade --host <id>`. Registry installation becomes available once `ae-harness` is published. The archive exposes `ae`; a fresh installation does not claim a `harness` executable. An owned legacy Copilot shim is retargeted to the same runtime during upgrade. An unrelated command is preserved.

Before upgrading, retain the previous package archive and a backup of the Copilot home and its managed bridge extension directory. Installation replaces managed assets, so these are separate from the saved-state backup described below. To roll back installation, restore those snapshots and reinstall the previous archive. Keep the candidate archive and checksum with its qualification results.

## Move existing saved work

The new CLI discovers a populated `~/.harness` and continues to use it. It starts fresh users in `~/.ae`. Installation alone therefore keeps existing plans, solutions, knowledge and indexes accessible. It does not silently move or merge them.

To move the complete saved-state home, stop other CLI processes and editor agents that could write it. Choose an absent or empty destination whose parent directory already exists:

```sh
ae migrate --from-home ~/.harness --ae-home ~/.ae --dry-run --json
ae migrate --from-home ~/.harness --ae-home ~/.ae --json
```

This copies every regular file and directory, including project plans, private docs and solutions, knowledge stores, indexes, domain records, settings, storage aliases and trust. It checks content hashes before publication and writes a migration receipt in the destination. Source bytes stay untouched; the original home is the rollback backup. Symlinks, special files, apparent writer locks, overlapping roots and populated destinations are refused. No file contents are sent to a model or registry.

Repeat the identical command after an interrupted run. An unpublished staging directory cannot become the selected destination; the source remains usable. A completed repeat reports `unchanged`. It does not synchronize later changes between homes. If the source has changed after migration, the command refuses to merge it.

Select the destination consistently in your shell and editor launch environment:

```sh
export AE_HOME="$HOME/.ae"
```

Remove or update a conflicting `HARNESS_HOME`. Restart editor windows so hooks inherit the same selection. When both default homes contain records and no home is selected, AE refuses to guess. On PowerShell use `$env:AE_HOME = Join-Path $HOME '.ae'`; configure the same value for future editor sessions.

For each active checkout, run `ae orient`, `ae index`, and `ae index --structural`. Migrated indexes are retained; rebuild derived indexes for the selected home and repository identity. Start a fresh gate and re-run review and verification for active delivery. Frozen plan, intent-source and historical proof bytes are not rewritten or reapproved by migration. Old session references to absolute plan paths may need reorientation.

Committed `docs/` files remain in Git. To move legacy gitignored product plans and solutions through the existing layout migration, run `ae migrate --dry-run`, inspect the result, then `ae migrate` from that product checkout. User-authored global Copilot resources and team knowledge remain in the Copilot home and are preserved by the installer; `COPILOT_HOME` does not change.

To roll back saved state, select the original home with `AE_HOME` or `--ae-home`. Preserve the new home if it contains subsequent work; rollback never merges two divergent stores.

## After the repository rename

The repository ID is derived from the `origin` remote, so pointing an existing checkout at the renamed repository changes its ID. Before you change the remote, note the current ID: the directory under `~/.ae/projects/` named after the old remote, such as `github.com-noodlemind-prompt-library-<hash>`. Then update the remote and bind the new identity to the original store:

```sh
git remote set-url origin https://github.com/noodlemind/adaptive-engineering.git
ae knowledge migrate-store --from-id <previous-repository-id> --ae-home ~/.ae --dry-run --json
ae knowledge migrate-store --from-id <previous-repository-id> --ae-home ~/.ae --json
```

The explicit binding keeps saved plans and knowledge at their original physical paths. It refuses an occupied destination or another binding. Repeated application is safe. Rebuild indexes for the new remote ID and refresh active-work proof. Renaming a governing document still requires the existing content-bound intent amendment.

Package metadata and documentation links already point to the renamed repository. The local directory name can remain unchanged. The `.github/harness` policy directory, `.harness` workspace records, lock filenames, JSON fields, protocol keys and historical evidence retain their existing contracts.

## Recover learnings that are still on disk

An empty `learnings/` directory is the shell created the first time a checkout is opened. It is not evidence that a learning file was deleted. Consolidated learning files are written only by `ae consolidate --apply`. A store whose git history has never contained a file under `learnings/` never received that command. `config.json` with `"commit": "none"` skips only the checkout mirror at `docs/knowledge/learnings/`. Schema 2 is the current store schema and accepts writes. `ae compound` and `ae remember` write episode files to `projects/<id>/docs/solutions/` in the harness home. A global publication writes `~/.copilot/knowledge/solutions/`. The harness home has no `knowledge/solutions/` directory. From the product checkout, point the command at the home you want to repair:

```sh
ae knowledge migrate-store --ae-home ~/.harness --dry-run --json
ae knowledge migrate-store --ae-home ~/.harness --json
```

Run the command from any directory inside the product checkout. The dry run writes nothing. Its JSON `merges` array is the list of existing ids for this repo: each row has `fromId`, `toId`, and `namespace` (`knowledge` or `projects`). `stableId` is the id they merge into, and `repo` is the origin URL or the main worktree path. The real run copies a missing learning, store config, or project file only when the destination does not already have that file. A destination file with different bytes is left alone and reported as a conflict. Source directories are never deleted or overwritten. A second run reports `unchanged`. The search covers ids whose path is the main worktree, another worktree, a directory inside those trees, or an older spelling of those paths (including macOS `/var` and `/private/var`), plus learning files still stored in that store's git history, a `docs/knowledge/learnings/` mirror in the checkout, and the same ids in the home named by a migration receipt. It does not import unrelated `local-*` directories from other checkouts.

## Qualification

Source tests and isolated archive checks do not establish native editor acceptance. Release notes state the exact archive digest and distinguish automated Windows checks from native editor runs. Publication requires an owner-controlled npm name and chosen license terms.
