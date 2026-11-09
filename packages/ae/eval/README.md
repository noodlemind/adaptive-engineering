# Internal eval pack (autonomous track)

Verifier-shaped tasks on the same kernel. **Not** a public leaderboard claim (SWE-bench / Terminal-Bench / DeepSWE).

| Track | How | Scoreboard |
|-------|-----|------------|
| Deliver | `@engineer` + gate / verify / compound | `ae report --growth` |
| Adaptive ladder | `node ./eval/adaptive/run.mjs` | trust, orient, verify, exclusive edit, stop between units |
| Autonomous | `ae agent --profile autonomous --verify-cmd …` | pass / steps / tokens / duration |

The adaptive ladder spawns `bin/ae.mjs`. It does not start a model and it does not exercise the TUI. `npm test` runs the same rungs through `test/adaptive-ladder.test.mjs`. Two rungs record the current verify contract and are not release-bar passes: an omitted `--shows` symbol stays `passed`, and an instruction is not a diff predicate.

## Tasks

Use the [native-host protocol](host/README.md) for an installed Engineer trial in an actual editor. It keeps model execution in that host and records interruptions, stale-source refusal, review, verification, and completion separately. Scripted delivery tests cannot substitute for this trial.

Deliver regressions in `test/agent-delivery.test.mjs` and `test/orient-delivery-contract.test.mjs` use scripted model responses and disposable repositories. They cover ungated edits, missing touched-file orientation, stale trust, failed or stale verification, missing review/learning/completion, recovery after a premature final message, and crowded context packs. They make no paid model calls and do not establish Luna or Sonnet task quality. Configure the final check and routing files before approving the eval workspace; approval of an init stub does not cover later agent edits.

| Id | Intent |
|----|--------|
| `fix-typo` | One-char fix; `verify.mjs` green |
| `add-function` | Export `double(n)` |
| `multi-file-rename` | Rename across two files |

```text
eval/tasks/<id>/task.json · workspace/ · verify.mjs
```

## Run

```bash
cd packages/ae
ae config set agent.enabled true --scope user   # live runs only
node ./eval/scripts/run-pack.mjs                     # dry-run by default
node ./eval/scripts/run-task.mjs fix-typo --dry-run
node ./eval/scripts/run-pack.mjs --live              # needs provider credentials
```

Metrics: `eval/results/latest.json` (autonomous only — do not merge into AE growth).

## Adapter notes (honest)

| Target | Reality here |
|--------|----------------|
| **SWE-like** | Issue → tools → tests as `--verify-cmd` → `git diff`. Report as **native** scores, not official SWE-bench. |
| **Terminal-Bench** | Per-call `exec`/`bash --cwd` only — **no** durable multi-turn shell. Fixed-harness wrapper under-reports vs Terminus. |
| **DeepSWE-style** | Short card, todo, compaction, parallel reads, apply, verifier stop. No embeddings / browser / first-class subagents. |

**Residual:** durable shell session; public submission pipelines; TB Harbor/Terminus adapter.

## Context policy pilot

`context/cases.json` freezes seven development and seven held-out JavaScript cases. They include an investigation with no seed files and recovery from an accepted plan with stale source evidence. The recovery case simulates a headless context reset. It does not test native editor compaction. `context/protocol.json` fixes budgets, repeats and promotion thresholds. Run the diagnostic before changing a selection rule:

```bash
node eval/context/run.mjs --out /absolute/new/external/directory
node eval/context/run.mjs --out /absolute/new/live/directory --live --provider <provider> --model <exact-available-id>
node eval/context/run.mjs --out /absolute/new/auto/directory --live --provider github-copilot --model auto --allow-auto
```

The output directory must be new, its parent must exist, and its physical path must be outside the checkout. The first command makes no model calls. Its 126 trials validate broken baselines, fixture preparation and policy packaging. Dry runs and scripted tests never count as model task success. Live runs require configured provider access. The runner selects no fallback model.

`--allow-auto` permits an explicit native GitHub Copilot Auto diagnostic. The agent preserves that selection through the editor bridge. Auto responses identify the routing alias. The resolved model identity remains unknown unless the provider reports it. Automatic selection remains ineligible for policy promotion, even with complete usage. Other providers keep their existing default-model behavior.

Each arm starts in a fresh Git workspace. The autonomous agent receives public task tests through a fixed verifier command. Private acceptance checks stay outside the editable workspace and run again after the agent stops. Both baselines must fail before an attempt begins. Public tests use separate probes; they do not replace private preservation checks. Hash checks detect checker changes. The checker binds its assertion functions before it imports any workspace module, so a checked module cannot disable them by replacing `assert` methods. File snapshots detect changes outside the allowed scope, including public verifier files and new files. Valid native edit undo receipts are recorded metadata. Unregistered undo files remain scope violations. This protects measurement integrity; it is not an operating-system sandbox.

Each fixture supplies a private executable directory before the inherited `PATH`. Its wrapper pins the candidate Harness CLI and private homes even after governed execution filters the environment. The wrapper suppresses task telemetry. It does not broaden file-scope exclusions or alter installed user runtimes. Provenance records `candidate-cli-v1` isolation.

Results retain failed attempts, case/checker/protocol/source hashes, the autonomous profile, the public verifier method, runtime and model identity, observed usage coverage, conservative evidence-before-edit observations and unknown costs. Reads through shell commands and opaque hosts remain unobserved.

Use `--split development` for tuning. Run held-out cases only after freezing the policy. `--policies legacy,selective,subsystem` uses the same retention policy in each arm. Compare retention in separate runs with `--policies selective --retention-policy legacy` and `--policies selective --retention-policy structured`; preserve the same corpus, model, runtime and budgets. Do not attribute a combined change to selection alone.

The pilot has insufficient held-out attempts for its promotion threshold. Missing model access, mixed models or incomplete usage makes the comparison inconclusive. Keep experimental policies opt-in until an expanded independent corpus and reviewed results support a default change.

## Memory ablation

`memory/` measures whether AE memory improves sequential coding work, per model. It reuses the context pilot's fixture preparation, private checker, provenance and output-directory rule.

`memory/cases.json` holds two development and two held-out JavaScript task series. Each series has four ordered tasks on one small repository, and each checkout contains the earlier tasks' reference solutions, as if their work had merged. Each series plants one recurring trap, a repository gotcha such as case-insensitive display order or names that must be NFKC-normalized before comparison. In task 1 the obvious implementation passes the public verifier but fails a private trap check. A later task repeats the trap in a different form. No held-out series shares a trap with a development series.

Every trap task records its reference implementation, its naive implementation and a list of common alternative idioms, such as `localeCompare` or `Math.round(x * 100) / 100`. All of these stay outside the workspace. `test/memory-eval-cases.test.mjs` uses them to check four things:
- each baseline fails
- the reference passes
- the naive implementation and every idiom pass the public and non-trap checks but fail the trap check
- with all seeds in one store, each series's seed learning ranks first for that series's recurrence task

`memory/protocol.json` fixes arms, repeats, budgets and the promotion rule:

| Arm | Knowledge mode | Baseline |
| --- | --- | --- |
| `stateless` | `off` | none |
| `capture-only` | `capture-only` | `stateless` |
| `recall` | `on` | `stateless` |
| `recall+feedback` | `on` with `knowledge.feedback=on` | `recall` |
| `recall+recheck` | `on` with `knowledge.recheck=on` | `recall`. Declared but not runnable until memory plan phase 2 adds the key |
| `frozen-seed` | `freeze`, with one seed learning written before task 1 | `stateless` |

```bash
node eval/memory/run.mjs --out /absolute/new/external/directory
node eval/memory/run.mjs --out /absolute/new/live/directory --live --provider <provider> --model <exact-available-id>
node eval/memory/run.mjs --out /absolute/new/dir --split development --arms stateless,recall --repeats 1
```

**Homes and identity.** Each (series, arm, repeat) gets its own harness home, and that home is shared by the series's tasks. Each task gets a fresh checkout of the series's next state. Before any `ae` command runs, every checkout sets `origin` to `https://eval.invalid/ae-memory/<series-id>.git`. That URL pins one repository identity, so every task resolves the same project store. Arms and repeats differ only in their harness home and knowledge mode.

**Configuration.** The runner sets the arm's knowledge mode and feedback state before every task. If the agent changes them during a task, for example by following a suggested `ae knowledge on`, that attempt fails and the next task starts reset.

**Invalid attempts.** An attempt whose repository identity drifts from the series's first task is invalid, not failed. Invalid attempts are left out of scoring, and any invalid attempt makes the batch inconclusive.

**Origin.** The private check fails an attempt whose agent changed `origin`. The runner then restores `origin` and reads every after-state through the series identity.

**Isolation.** This keeps the measurement honest; it is not an operating-system sandbox.
- Each run's agent-facing files sit in a fresh temporary root outside the output directory: the checkout, an empty `HOME`, the CLI wrapper and the harness home.
- Each task's checkout is deleted after its attempt, and the temporary root is deleted after the run.
- Private checks live under `<out>/private/`, which is outside that root and outside `HOME`.

**Memory channels.** Only arms that capture memory (`capture-only` and `recall*`) carry `docs/solutions/` notes into the next checkout and commit them there. Each attempt lists the files it inherited. In other arms, notes written under `docs/solutions/` are allowed, because compound may still write them, but they are discarded. Plans kept outside the checkout under the harness home are cleared before every task in every arm. Learnings and private episodes in the project store are the memory under test and persist.

**Metrics.** Each attempt records:
- private-check pass
- trap recurrence, the primary metric
- the `lib/repeat-mistake.mjs` verdict
- turns and observed tokens
- `learningsBytes` and injected learnings
- episodes written (Markdown notes under `docs/solutions/`)

A recurrence counts only when the task's non-trap private checks pass. An unsolved task is recorded as unscored, and each arm reports how many were unscored. Injected learnings come from a dry `ae orient` computed before the agent runs. A dry run makes no model calls and skips the post-run checks. It validates broken baselines, identity pinning, arm configuration and planned injection.

**Promotion.** An arm is compared with its declared baseline on held-out attempts. It counts as an improvement only if all of these hold:
- trap recurrence falls by at least 30% relative to the baseline
- a one-sided Fisher exact test of that drop has p ≤ 0.05
- each arm has at least 30 scored recurrence observations
- the pass rate does not fall by more than 2 percentage points
- episodes per series do not rise unless recurrence also falls. Only runs whose attempts were all valid and executed count.
- both arms have at least 30 held-out attempts from the same batch
- observed usage is complete

An incremental arm must also pass against `stateless`. It cannot be promoted when its baseline fails against `stateless`.

**Limits.**
- Each held-out series has one recurrence task. The default 4 repeats give each arm 8 recurrence observations, so a batch that can promote needs at least 15 repeats on the held-out split.
- With 32 held-out attempts, one attempt is about 3 percentage points. The 2-point margin therefore tolerates no additional failure.
- The live path uses the `deliver` profile so that compound can write episodes. Turning episodes into learnings still depends on the agent running consolidation.
- This pilot has no recorded live run yet.
- Dry runs, scripted tests and Auto-routed models never qualify for promotion. A result applies only to the model and runtime that produced it.

## Mechanical extraction comparison

`node eval/mechanics/run.mjs --root <package-root> --out <new-external-directory> --label <revision-label> --lane common --runs 3` executes the maintained common regression fixtures repeatedly. The output argument is required and must be outside the candidate checkout, so receipts cannot make later comparisons dirty. Move any old in-checkout receipts outside before retrying; the evaluator never deletes them. Use lane `phase2` for the added record/proposal/report/install contracts. Run revisions sequentially with the same Node runtime and test concurrency; compare `fixtureHashes` before comparing shared trials. No paid/model calls occur.

The evaluator preserves TAP output and observations of synchronous CLI/hook calls without retaining inputs or environment values. It reports actual calls, bytes and wall time; asynchronous/internal calls are outside that observation count. Model tokens, agent repair turns and intervention frequency remain null. Synthetic assertion coverage and unchanged fixtures do not establish agent semantic quality or savings. Keep those measurements pending until representative native-host model runs are available.
