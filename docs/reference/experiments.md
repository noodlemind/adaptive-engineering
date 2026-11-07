# Bounded experiments

Measured, budgeted experiments on a tracked candidate file. This is an advanced, macOS-only feature.

An ordinary full schema 4 `.hplan` may declare one strict `experiment` contract. Schema 4 also preserves the schema 3 domain contract; combined domain experiment execution is unsupported. Authored creation uses `plan-new --file` with the full format. An authored `convert` decision can extend an ordinary schema 2 full plan using `authority.scope: experiment-intent` and `changes: {experiment: <contract>}`, preserving its UUID through the same journaled `.md` retirement and `.hplan` publication. Prior packaged CLIs reject `.hplan` before mutation.

The initial supported workload is `linear-json-v1`: one tracked JSON candidate `{version: 1, weights: [<finite numbers>]}` and one frozen workload `{version: 1, objective: [{features: [...], expected: <number>}], guards: [{features: [...], min: <number>, max: <number>}]}`. Dimensions must match. The fixed packaged evaluator calculates mean absolute error and hard guard results without loading product code. Excessive dimensions/rows, duplicate keys, unknown fields, nonfinite values, executable files and unsafe paths are rejected. Noisy, timing, executable or external-effect workloads require a separate design.

The accepted contract is explicit:

```json
{
  "version": 1,
  "workload": "linear-json-v1",
  "candidate": "config/weights.json",
  "editable_files": ["config/weights.json"],
  "metric": {"name": "mean-absolute-error", "units": "absolute-error", "direction": "minimize"},
  "scorer_check": "weights-loss",
  "correctness_checks": ["weights-guards"],
  "dependencies": ["fixtures/weights-workload.json"],
  "protocol": {"deterministic": true, "repetitions": 1, "minimum_improvement": 0.25},
  "target": 0.5,
  "budget": {"max_invocations": 8, "max_seconds": 300, "timeout_seconds": 10, "max_repair_reruns": 2}
}
```

Declare each trusted named check in `checks.yaml` with exactly `command: [<canonical Node path>, <canonical installed experiment-evaluator.mjs path>, score|guard]`, `timeout_seconds` matching the contract, `artifacts: [measurement.json]`, and `experiment: {version: 1, workload: linear-json-v1, mode: score|guard}`. Optional `proof` must be `behavior`. `experiment status --json` supplies installed paths without probing or writing. Upgrade/rebind the check paths through normal trust approval; arbitrary product commands cannot claim this evaluator. These scorer checks refuse ordinary `checks run` and final verification, which must use separate behavioral checks.

Begin requires a fresh bound implement gate and current selected-home trust. Experiments require an actual registered linked issue worktree with its Git backlink and physical directory identities; ordinary in-place and CI exceptions grant no experiment authority. A fixed claim in its linked Git directory prevents another Harness home from taking the same workspace. Candidate scope excludes intent, workload, checks, policy, routing and helpers. Frozen authority covers evaluator/runtime/host/profile bytes, check config, dependencies, metric, target, protocol, candidate shape/mode and intent.

`experiment begin --plan <path> --file <decision>` reserves the baseline first, then one candidate or repair hypothesis. Its JSON decision includes `version: 1`, unique `id`, current raw plan hash in `expect`, and `hypothesis`; a repair also includes `repair_of`. Each reservation immediately spends two slots for the score and guard pair, even if neither starts. `experiment evaluate --plan <path> --attempt <returned UUID>` launches that pair once. It uses immutable copies outside the writable artifact directory and sanitized environment values. The macOS deny-default sandbox must pass an actual selected-runtime canary proving artifact writes, rejected dependency writes and rejected connection to a listening parent server. Other hosts or a failed probe report unsupported. This is a boundary for a fixed trusted evaluator, not a general untrusted-code sandbox.

Versioned metric artifacts bind attempt/child/plan identity, contract, candidate, scorer/dependencies, environment, workload, duration, repetitions and hard correctness. Harness validates bounded raw JSON before redaction can erase duplicate keys and revalidates owned retained bytes later. Candidate stdout supplies no metric authority. Each child's PID, group, start identity and reaping observation are durable. A dead controller alone cannot authorize a rerun or process termination. Timeout and controlled cancellation remove owned process groups and retain consumed budget.

`experiment resolve --plan <path> --file <decision>` accepts `version`, `id`, `expect`, `attempt`, `decision: keep|discard|cancel`, and `description`. Keep requires valid current artifacts, hard correctness and minimum improvement. A lower error with failed guards is discarded. Discard can restore recognized candidate bytes and exact filesystem modes despite invalid evaluator/metric data; unknown bytes are preserved and block recovery. Private Git indexes and snapshot refs never move HEAD or the user's index. Only exact editable files enter snapshots and restore journals. Unrelated staged, dirty, untracked and ignored work survives restoration.

Immutable series/reservation/transition journals live in `<project-store>/experiments/<plan UUID>/`; `state.json` and the TSV report are projections. Deleting a projection cannot reset spent slots or the original wall-clock origin. A replay must match its original authored input. Restore/ref publication is journaled before mutation and resumes only recognized before/after states. Read-only `experiment status` performs no recovery. Explicit evaluate/resolve can recover an interrupted attempt after owned groups are proven gone; repair requires a new charged reservation and the original hypothesis, at most twice within the same global limits.

Target satisfaction, exhaustion, cancellation, evaluator invalidity and unknown ownership stop new candidate attempts. None completes the plan. Increasing global invocation or wall limits requires an accepted amendment on this same plan and preserves origin, baseline and spent count; changing other frozen inputs invalidates the series. After retaining a correct target, complete ordinary progress, required review, separate behavioral `verify`, learning/no-learning and completion. Evidence version 7 binds retained measurement/artifacts before and after final verification. Mandatory `experiment-target` and `experiment-retention-stability` checks cannot become advisory or disappear from accepted proof. An unmet target remains unfinished even when ordinary behavior is green.

These mechanisms have dedicated CLI and process tests. Native editor delivery and comparative model outcomes remain separate acceptance evidence. The interactive Windows product/editor pilot was waived. Supported macOS measurement does not establish Windows experiment isolation; headless Windows CLI regressions remain separate required proof.
