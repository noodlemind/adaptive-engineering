# Continuous integration

Pull-request CI is a fast tier that aims for about 10 job-minutes in total.
The complete suite runs on the machine that opens the PR, before every push
that is ready for review:

```
node scripts/full-suite.mjs              # every test file; prints a receipt
node scripts/full-suite.mjs --check      # does a passing receipt match HEAD?
git config core.hooksPath .githooks      # opt in: pre-push runs --check
```

The receipt is written to `ci-test-results/full-suite-receipt.json` and printed
as one line, for example
`Full suite: PASS · 4120 tests in 346 files · win32 Node 22.11.0 · 0123456789ab · 38 min`.
Paste it into the PR description (the template has a slot). The
`full-suite-receipt` check warns, without failing, when the description has no
passing receipt for the PR's head commit. A receipt is the author's attestation,
not CI evidence. Run it on Windows when you can: that is the primary platform.

| Trigger | Linux | Windows |
| --- | --- | --- |
| Pull request | One job: the fast tier (`--suite fast`, every file recorded at 30 s or less on Windows plus every unmeasured file), about two thirds of the files | Touching `packages/ae/`, the Windows workflow, `.github/ci/`, the CI test scripts or `.npmrc`: one `windows` job with a Windows-sensitive subset (hooks, install, runner, paths, trust, redaction, Git and shell boundaries) plus the native probes. Otherwise skipped, which still satisfies branch protection |
| Manual dispatch | The complete suite in four shards | The complete suite in twelve shards |

The Windows subset lives in `WINDOWS_SUBSET` in `harness-windows.yml`; its
inventory step fails if a listed file disappears. Pushes to `main` start no
copy. New revisions cancel older runs of the same workflow and ref.

## Checks and evidence

| Work | Why it runs | Evidence |
| --- | --- | --- |
| Linux fast tier (pull requests) | Most source behavior and prompt contracts on Node 22 | Console log, file inventory and installed-delivery transcripts |
| Complete suite (author's machine; CI on dispatch) | Every test file before review | Receipt line in the PR description; full manifests on dispatch |
| Windows-sensitive subset (pull requests) | Win32 behavior users hit first, on every relevant revision | Subset console log and file-presence inventory |
| Twelve Windows test shards (manual) | Complete source behavior on the primary platform, with each file assigned once | Selected inventory, exact file timings, counts, console logs, transcripts and process diagnostics |
| Windows final gate | The subset or all shards passed; the inventory is complete; native CLI, redaction and descendant termination work | Combined inventory verdict and native probe output |
| Package installation (Linux on PRs; Linux and Windows on dispatch) | The exact archive installs offline and hydrates a runnable `ae` | Archive, checksum and source metadata |
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
exact archive. Pull requests install on Linux with Node 24 only. Manual
qualification (workflow dispatch) installs on both systems with Node 20 and 24 and the Git integration
regressions on every OS/runtime; run it before a release. On pull requests
those regressions would repeat files that the full Linux suite runs on every PR
and the complete Windows suite runs nightly.

Documentation runs when its workflow, renderer, site templates or one of its
Markdown inputs changes. The input list follows
`scripts/build-docs.mjs`. Publishing still requires a manual run with the publish
input enabled.

Linux source jobs always report on pull requests. The Windows workflow always
starts, and its scope job skips the Windows jobs for unrelated changes, so its
checks are safe to require. Docs and package workflows use native
path filters and are absent for unrelated changes. Do not make these conditional
workflow checks mandatory in branch protection: GitHub leaves path-filtered
required checks pending. If they become required, replace workflow filters with
job conditions and an always-reporting gate first.
