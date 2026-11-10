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

Each arm starts in a fresh Git workspace. The autonomous agent receives public task tests through a fixed verifier command. Private acceptance checks stay outside the editable workspace and run again after the agent stops. Both baselines must fail before an attempt begins. Public tests use separate probes; they do not replace private preservation checks. Hash checks detect checker changes. Private checks travel to the checker on stdin, never on a command line. The checker imports the workspace modules in a child process that receives only each check's module, export and arguments. The checker alone holds the expected values and error texts and compares them, so checked code cannot read them casually, replace `assert` or forge a `throws` match. The child captures the functions its reports depend on before any workspace import. It writes each finished check as one nonce-tagged ASCII line with the captured `fs.writeSync`, with no `Buffer` in the path. Report objects have a null prototype, and a `synchronous` check treats any native promise as asynchronous, even one whose `then` is hidden. A check that hangs or exits fails alone and the checker moves on to the next one; checks it cannot reach within its time budget fail. The private judge requires plain data, as `deepStrictEqual` on the JSON expectations would. **Threat model.** The checker defends against casual or accidental fitting: reading files or command lines, or simple monkey-patching of common globals. Checked code runs in the same JavaScript realm as the reporter, so a deliberately adversarial module can always forge a report, for example through prototype patches or by reading the nonce from `/proc/self/mem`. Code running as the same user can also read the checker's memory through `/proc/<pid>/mem` where ptrace is allowed. A separate user ID does not close the same-realm gap. Real defence needs a separate process boundary with no shared realm, plus a sandbox. The eval does not chase further same-realm patches. The runner waits for the checker without blocking its event loop, so a signal to the runner is handled at once. On SIGINT or SIGTERM the runner kills the checker process groups its study started, then exits. The checker discards its probe child's standard output and standard error, so checked code that writes a lot to either cannot overflow the checker's own output. File snapshots detect changes outside the allowed scope, including public verifier files and new files. A `node_modules/` directory counts as one entry, so an `npm install` cannot push a workspace past the snapshot's 1,000-entry limit. A new one is still an unexpected change. Valid native edit undo receipts are recorded metadata. Unregistered undo files remain scope violations. This protects measurement integrity; it is not an operating-system sandbox.

Each fixture supplies a private executable directory before the inherited `PATH`. Its wrapper pins the candidate Harness CLI and private homes even after governed execution filters the environment. The wrapper suppresses task telemetry. It does not broaden file-scope exclusions or alter installed user runtimes. Provenance records `candidate-cli-v1` isolation.

Results retain failed attempts, case/checker/protocol/source hashes, the autonomous profile, the public verifier method, runtime and model identity, observed usage coverage, conservative evidence-before-edit observations and unknown costs. Reads through shell commands and opaque hosts remain unobserved.

Use `--split development` for tuning. Run held-out cases only after freezing the policy. `--policies legacy,selective,subsystem` uses the same retention policy in each arm. Compare retention in separate runs with `--policies selective --retention-policy legacy` and `--policies selective --retention-policy structured`; preserve the same corpus, model, runtime and budgets. Do not attribute a combined change to selection alone.

The pilot has insufficient held-out attempts for its promotion threshold. Missing model access, mixed models or incomplete usage makes the comparison inconclusive. Keep experimental policies opt-in until an expanded independent corpus and reviewed results support a default change.

## Memory ablation

`memory/` measures whether AE memory improves sequential coding work, per model. It reuses the context pilot's fixture preparation, private checker, provenance and output-directory rule.

`memory/cases.json` holds two development and two held-out JavaScript task series. Each series has four ordered tasks on one small repository, and each checkout contains the reference solutions of earlier non-trap tasks, as if their work had merged. Earlier trap tasks keep their stubs, so the repository never shows a fix for the trap. Merging that fix would give every arm an in-repository cue and shrink the memory effect being measured. Each series plants one recurring trap, a repository gotcha such as case-insensitive display order or names that must be NFKC-normalized before comparison. In task 1 the obvious implementation passes the public verifier but fails a private trap check. A later task repeats the trap in a different form. No held-out series shares a trap with a development series.

Every trap task records its reference implementation, its naive implementation and a list of common alternative idioms, such as `localeCompare` or `Math.round(x * 100) / 100`. All of these stay outside the workspace. `test/memory-eval-cases.test.mjs` uses them to check four things:
- each baseline fails
- the reference passes
- the naive implementation and every idiom pass the public and non-trap checks but fail the trap check
- with all seeds in one store, each series's seed learning ranks first for that series's recurrence task

`memory/protocol.json` fixes arms, repeats, budgets and the promotion rule:

| Arm | Knowledge mode | Baseline |
| --- | --- | --- |
| `stateless` | `off` | none |
| `capture-only` | `capture-only`. Captures in every task but never reads back what earlier tasks captured | `stateless` |
| `recall` | `on` | `stateless` |
| `recall+feedback` | `on` with `knowledge.feedback=on` | `recall` |
| `recall+recheck` | `on` with `knowledge.recheck=on` | `recall`. Declared but not runnable until memory plan phase 2 adds the key |
| `frozen-seed` | `freeze`, with one seed learning written before task 1. Every task starts from the seeded memory | `stateless` |

```bash
node eval/memory/run.mjs --out /absolute/new/external/directory
node eval/memory/run.mjs --out /absolute/new/live/directory --live --provider <provider> --model <exact-available-id>
node eval/memory/run.mjs --out /absolute/new/dir --split development --arms stateless,recall --repeats 1
```

**Homes and identity.** Every task gets its own root, created with an unpredictable name. The root holds a fresh Copilot home, a fresh harness home and a fresh checkout of the series's next state. Only the memory under test reaches a later task's homes; see Memory channels below. Before any `ae` command runs, every checkout sets `origin` to `https://eval.invalid/ae-memory/<series-id>.git`. That URL pins one repository identity, so every task resolves the same project store. Arms and repeats differ only in their harness home and knowledge mode.

**Configuration.** The runner sets the arm's knowledge mode and feedback state before every task. If the agent changes them during a task, for example by following a suggested `ae knowledge on`, that attempt fails and the next task starts reset.

**Invalid attempts.** An attempt whose repository identity drifts from the series's first task is invalid, not failed. So is an attempt whose measurements cannot be read after the agent stops. That attempt records `scope-unmeasurable` and the study continues. A workspace with more files than the snapshot limit (1,000 outside `node_modules/`) is not unmeasurable: the agent caused it, so the attempt fails scope with the unexpected entry `(snapshot limit exceeded)` and stays valid and scored. A task after the first whose unchanged checkout already passes a check it must fail is invalid as `invalid-baseline`, and no agent runs for it; on task 1 that is a fixture error and stops the study. Invalid attempts are left out of scoring, and any invalid attempt makes the batch inconclusive. A refused memory capture stays invalid (`carried-memory-refused`, see Memory channels): the next task would run on memory that is incomplete or may be contaminated, so scoring it would measure the wrong arm.

**Origin.** The private check fails an attempt whose agent changed either the configured `origin` or its effective URL. The effective URL can change through a `url.*.insteadOf` rewrite. The runner then removes such rewrites, restores `origin` and checks both readings. If the restore does not hold, the attempt becomes invalid. Every after-state is read through the series identity.

**Isolation.** This protects against casual leakage only; it is not a sandbox. **Threat model:** the eval assumes a non-adversarial agent. A deliberately evasive agent running as the same operating-system user can escape every measure below, for example by changing directory modes back, moving a daemon out of its task root or reading the runner's memory. Strong isolation needs a container or virtual machine per task. Keeping the agent out of the runner's memory needs a separate user ID or a sandbox. Forged checker reports are a separate, same-realm gap; see the threat model above. An agent with shell access as the runner's user can read the runner's and the checker's memory (for example `/proc/<pid>/mem` where ptrace is allowed). It can also find the case catalog, because the candidate CLI runs from this checkout. It can also find the output directory through the process list. For a live run, the stronger option is to run the candidate from a packed copy that omits `eval/`, and to keep the output directory on a path the agent's account cannot read. Within those limits:
- Each task's agent-facing files sit in a root of its own with an unpredictable name, inside the run's temporary root, inside a per-study parent. That root holds the checkout, the CLI wrapper and both homes.
- Each task has its own empty `HOME` and its own `TMPDIR` (also `TMP` and `TEMP`).
- Each task's root is deleted once its measurements are read, without following links. The run root is deleted after the run. Before each removal the runner gives the owner full access to every directory in the tree, so an agent's `chmod 555` cannot stop it. A removal that still fails, such as `EBUSY` on Windows, is recorded in the run's `cleanupErrors` (the study parent's in the top-level `cleanupErrors`) and never stops the study.
- The study parent and every run root have mode `0311` while the study runs: the owner can create and enter entries but not list them, so a process left running cannot casually discover the unpredictable names of later run and task roots. Removal restores read access first. A process running as the same user can change the mode back, and Windows ignores it.
- Before each task, on Linux, the runner SIGKILLs every process of its own user whose working directory (`/proc/<pid>/cwd`) is under the study parent, which then holds only earlier task roots. Each attempt records `stragglersKilled`. This is best effort: it is skipped without `/proc`, and a daemon that changed its directory elsewhere escapes it.
- The study parent is removed on exit and on SIGINT, SIGTERM, SIGHUP or SIGQUIT (SIGQUIT does not exist on Windows). SIGKILL cannot be caught: it leaves the parent for the next study's sweep and orphans any running agent group. Its name carries the runner's PID, and study parents left by dead runners are swept when a new study starts. A parent that cannot be removed, such as another user's, is skipped. PIDs are checked in the runner's PID namespace: runners in other containers that share the temporary directory look dead, so give each container its own temporary directory.
- The public verifier is a standalone script that contains only the public checks.
- Private checks stay in the runner's memory and reach the checker only on stdin. No file holds them.
- Attempt records, which include checker diagnostics, are written only after the study parent is gone. A crash or a signal still writes the finished attempts, with a `results.json` marked `partial` and no summary.
- The agent runs in its own process group. When it exits, the runner kills the whole group once, so a background process it started does not outlive the task. After that exit the agent's PID may be reused, so the runner never signals it again. A timeout or an overflow of the output limit also kills the group; the output is cut at the limit and the result has no exit status. The output pipes then get a short grace period to close; a process that started its own session and still holds a pipe cannot delay the result past it. On a handled signal or on exit, the runner kills every live group this study started before it removes the study parent. A process that starts its own session escapes the group kill, but the next task's homes are new and its old root is deleted. On Windows there are no process groups: the kill reaches only the direct child.
- The private checker and the public verifier run the same way, in their own process groups, each killed when its checker exits. A daemon that checked code starts at import does not outlive the check, and a process left holding the checker's output cannot hold the result.
- When setup for a task fails, that attempt becomes invalid and records the error, no agent runs for it, and the study continues. Setup covers resolving the repository identity, copying the carried memory, configuring the arm and reading the configuration back. A refused copy also counts as a failed setup.

**Memory channels.** Only arms that read captured memory (`recall*`) carry `docs/solutions/` notes into the next checkout and commit them there. Carry-forward takes only regular files reached through real directories: a symlinked `docs`, `docs/solutions` or nested folder is skipped, as a checkout would commit the link and not its target. Each attempt lists the files it inherited. In other arms, notes written under `docs/solutions/` are allowed, because compound may still write them, but they are discarded.

The memory carried between homes is four targets: the project store's `docs/solutions/`, the recall manifest under the Copilot home, the retrieval index under the harness home, and the learnings store under the harness home, which holds the learnings and the knowledge mode and feedback config. Arms that read captured memory (`recall*`) also carry a fifth target, the project store's `feedback/` records under the harness home, because `recall+feedback` reads them back; without them it would measure the same memory as `recall`. Nothing else is carried. Storage aliases, plans, todos, `agent-context.md`, trust and check configuration all start fresh in every task, and so do feedback records in the other arms. Lock state is never carried: a store `.lock`, any other `*.lock` such as `.git/index.lock`, and `*.stale-*` tombstones are skipped, because copied with fresh times they would look live and wedge the next task's store. The runner reads the targets into its own memory and writes them into the next task's new homes before it configures the arm. The read checks every path with `lstat` and opens every file without following a final link. A symlink, a special file, an unreadable entry or a store over the limits (2,000 entries, 32 MiB) refuses its target. A refused target makes every later attempt in that run invalid (`carried-memory-refused`), and no agent runs for them.

Compound still writes episodes in `capture-only` and `freeze` modes, and orient recalls episodes whatever the knowledge mode. An agent in any arm, `stateless` included, can also turn knowledge on, compound and turn it off again. So for every arm that does not read captured memory (`stateless`, `capture-only` and `frozen-seed`) the runner captures the four targets once, after the first task is configured and before its agent runs. Every later task's fresh homes get that capture. `stateless` therefore never recalls anything an earlier task captured, `capture-only` never reads an earlier task's capture, and `frozen-seed` always starts from its seeded state. The `recall*` arms instead get what the previous task left in their five targets: that is the memory under test. No store is restored in place, so a process left running cannot redirect a restore. That does not confine it: a process that escaped the group kill and the straggler kill can still reach later run and task roots, for example by watching the temporary directory, and change the next task's checkout or homes before or while its agent runs. A tampered checkout whose baseline passes is caught as `invalid-baseline`; other tampering is not detected.

**Checks the runner supplies.** Before the agent runs, the runner, acting as the operator, registers the public verifier as the named check `public-checks` in the series's project authority under the harness home and approves project trust for the checkout. Deliver's completion gate needs passing named evidence, so without this a correct run could never finish with status `ok`. The agent may only read trust status. Changes under `.harness/` are ordinary Harness state and allowed, except to the files the runner supplies, such as `.harness/context-verify.mjs`. Changing one of those is a scope violation.

**Metrics.** Each attempt records:
- private-check pass
- trap recurrence, the primary metric
- the `lib/repeat-mistake.mjs` verdict
- turns and observed tokens
- `learningsBytes` and injected learnings
- episodes written (Markdown notes under `docs/solutions/`)

A recurrence counts only when the task's non-trap private checks and its public examples pass. The private checker runs the public examples from the runner's own copy, so a constant answer that passes the edge-case private checks is unscored, and a changed workspace verifier cannot fake them. An unsolved task is recorded as unscored (`rest-of-task-unsolved`), and each arm reports how many were unscored. A checker run that timed out, overflowed or lost integrity reports no verdicts. Its recurrence task is unscored as `checker-incomplete`, counted in the arm's `recurrenceCheckerIncomplete` and in its unscored rate, so the unscored-rate rule below catches an arm whose checker runs often fail. Injected learnings come from a dry `ae orient` computed before the agent runs. A dry run makes no model calls and skips the post-run checks. It validates broken baselines, identity pinning, arm configuration and planned injection.

**Promotion.** An arm is compared with its declared baseline on held-out attempts. It counts as an improvement only if all of these hold:
- trap recurrence falls by at least 30% relative to the baseline
- a one-sided Fisher exact test of that drop has p ≤ 0.05
- each arm has at least 30 scored recurrence observations
- the arms' unscored recurrence rates differ by at most 10 percentage points. Each comparison reports both rates.
- the pass rate does not fall by more than 2 percentage points
- episodes per series do not rise unless recurrence also falls. Only runs whose attempts were all valid and executed count.
- both arms have at least 30 held-out attempts, and every scored row of both arms carries the same batch stamp
- observed usage is complete

An incremental arm must also pass against `stateless`. It cannot be promoted when its baseline fails against `stateless`.

**Limits.**
- Each held-out series has one recurrence task. The default 4 repeats give each arm 8 recurrence observations. 15 repeats on the held-out split is only a floor, because unscored recurrence tasks push an arm below 30 observations.
- With 32 held-out attempts, one attempt is about 3 percentage points. The 2-point margin therefore tolerates no additional failure.
- The live path uses the `deliver` profile so that compound can write episodes. Turning episodes into learnings still depends on the agent running consolidation.
- This pilot has no recorded live run yet.
- Dry runs, scripted tests and Auto-routed models never qualify for promotion. A result applies only to the model and runtime that produced it.

## Mechanical extraction comparison

`node eval/mechanics/run.mjs --root <package-root> --out <new-external-directory> --label <revision-label> --lane common --runs 3` executes the maintained common regression fixtures repeatedly. The output argument is required and must be outside the candidate checkout, so receipts cannot make later comparisons dirty. Move any old in-checkout receipts outside before retrying; the evaluator never deletes them. Use lane `phase2` for the added record/proposal/report/install contracts. Run revisions sequentially with the same Node runtime and test concurrency; compare `fixtureHashes` before comparing shared trials. No paid/model calls occur.

The evaluator preserves TAP output and observations of synchronous CLI/hook calls without retaining inputs or environment values. It reports actual calls, bytes and wall time; asynchronous/internal calls are outside that observation count. Model tokens, agent repair turns and intervention frequency remain null. Synthetic assertion coverage and unchanged fixtures do not establish agent semantic quality or savings. Keep those measurements pending until representative native-host model runs are available.
