# Structural evidence and impact context

Read cited source relationships, bounded change impact and retained historical graphs through the CLI or existing native Harness tool. The installed archive supplies the parser assets needed for supported AST extraction offline.

## Sub-features

- `imports`: Dependencies, dependents, paths and explanations carry occurrence citations and explicit extraction/resolution methods.
- `snapshots`: Historical `--generation` queries retain recorded facts after worktree edits and never claim current source.
- `impact`: Explicit change-impact orientation returns a bounded source packet with advisory verification areas.
- `archive`: The packed archive ships verified AST assets; ordinary use needs no native compiler, parser installation or server.

## How a person reaches it

- Run `ae graph deps <file>`, `ae graph dependents <file>` or `ae graph impact <file>` from a Git repository.
- Run `ae graph path <file> <target>` or `ae graph explain <file> <target>` for a directed relationship; add `--generation <id>` to select retained historical facts.
- Run `ae orient --read --context-version 2 --question-kind change-impact --file <path> --json` for a source packet.
- Pass the same arguments through the existing native Harness tool. Returned evidence does not prove editor or model consumption.
- Read [the structural knowledge guide](../../../../docs/structural-knowledge.md) for selection, scope and freshness semantics.

## Driving it

Preconditions: Work from the repository checkout with Git, a supported Node runtime and package dependencies installed. Require the verification recipe's Doctor to pass. Each proof owns and cleans its disposable workspaces and temporary homes.

- **Doctor.** Run `node .cursor/skills/verify-harness/scripts/doctor.mjs`; require exit `0` before driving.
- **Relationships and impact.** Run `node packages/ae/bin/ae.mjs checks run verify-structural-context --json`; require exit `0`, check status `passed` and the captured `structural-context/drive.json` artifact. The real CLI must include a caller in impact, exclude a commented import, cite the import occurrence, retain historical facts after an edit, refresh live impact and return a current source-bound orientation packet.
- **Offline archive.** Run `node packages/ae/bin/ae.mjs checks run structural-package-tests --json`; require exit `0` and check status `passed`. The standalone test packs and installs the actual archive offline into local and global prefixes, parses Java/JS/TS/TSX/Python with shipped AST assets, repacks the installation and rejects damaged parser bytes. Release tests validate versions, corpus and distribution contents.
- **Broader installed release.** On macOS, `node packages/ae/bin/ae.mjs checks run verify-installed-release --json` separately qualifies hydrated installation, predecessor upgrade and bounded experiment delivery. It is optional for this structural feature's archive proof; require its own passing result and `installed-release.json` artifact before claiming those broader behaviors.

## Gotchas

Coverage refers to bounded Git-tracked sources. New untracked dependents are outside that inventory. Only retained immutable generations can be selected; eviction is explicit. Static imports do not identify active Spring wiring, dynamic dispatch or every affected test. Suggested verification areas cannot select or waive accepted checks. Learning applicability compares selected source bytes and is separate from historical proof and claim correctness.
