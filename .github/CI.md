# Continuous integration

Every pull request runs the complete source suite on Linux and Windows. Each
platform discovers every top-level `packages/ae/test/*.test.mjs` file. The CLI's
trusted named checks remain unchanged.

Windows runs automatically on pull requests and can also be started manually.
Branch pushes no longer start a second copy. New revisions cancel older runs of
the same workflow and ref, including package candidate runs.

## Checks and evidence

| Work | Why it runs | Evidence |
| --- | --- | --- |
| Full Linux suite | Source behavior and prompt contracts on Node 22 | Console log and installed-delivery transcripts |
| Four Windows test shards | Complete source behavior on the primary platform, with each file assigned once | Selected inventory, exact file timings, counts, console logs, transcripts and process diagnostics |
| Windows final gate | All shards passed; same-revision inventory is complete; native CLI, redaction and descendant termination work | Combined inventory verdict and native probe output |
| Package installation on Linux and Windows | The exact Node 24 archive installs offline and hydrates a runnable `ae` | Archive, checksum and source metadata |
| Documentation | Canonical pages build with Jekyll | Pages artifact |

The former delivery and adaptive jobs and separate Linux prompt-contract step
repeated files already in the full suites.
Their evidence now comes from those suites. Uploads run after failure. Linux and
Windows log capture preserve the real test process's exit code. The final Windows
gate rejects failed, cancelled or missing shard/probe verdicts and missing,
duplicated or mixed-revision inventory.

## Windows latency

Removing duplicate jobs saves work but does not shorten a single two-worker
Windows run. The complete passing run at `abd9aaae` took 51 minutes 4 seconds for
the source suite and recorded 100.21 aggregate test-minutes. The slow
cases drive real CLI commands and many Git subprocesses. These are elapsed test
durations, not CPU time.

`scripts/ci-tests.mjs` assigns the longest estimated files first to four balanced
shards. Each runner keeps two workers. Unknown files receive a default weight and
still run. Every shard emits its selected inventory and completion records; the
final gate requires their union to match the current discovered inventory exactly
once and to name the same source revision.

Initial weights in `.github/ci/windows-test-costs.json` come from that complete
passing run ([39330090134](https://github.com/noodlemind/adaptive-engineering/actions/runs/39330090134)).
File attribution was inferred from unique test titles and covered about 92% of
observed duration. These are scheduling hints,
not correctness proof or a speedup claim. New runs use Node's file-completion
events to record actual file-process durations and test counts. Use those records
for rebalancing rather than inferring time from buffered console timestamps.

The target is Windows feedback within 15 minutes, subject to measured results.
Compare complete runs using queue time, runner image, Node version, elapsed
feedback time, billed runner time, failures and skips. Parallel shards increase
useful job count while every test file still executes once per platform.

## Conditional work

Package candidates run for changes inside `packages/ae/`, the package workflow,
root npm configuration or license files. Both operating systems install their
exact archive. Manual execution remains available.

Documentation runs when its workflow, renderer, site templates or one of its
Markdown inputs changes. The input list follows
`scripts/build-docs.mjs`. Publishing still requires a manual run with the publish
input enabled.

Source jobs always report on pull requests. Docs and package workflows use native
path filters and are absent for unrelated changes. Do not make these conditional
workflow checks mandatory in branch protection: GitHub leaves path-filtered
required checks pending. If they become required, replace workflow filters with
job conditions and an always-reporting gate first.
