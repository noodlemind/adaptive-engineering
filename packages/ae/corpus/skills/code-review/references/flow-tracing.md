# Flow Tracing

This reference defines how the correctness perspective (`spec-flow-analyzer`) reviews a code diff. It traces positive and negative flows through each changed entry point and returns a flow ledger beside its findings. Harness review assembly rejects a `spec-flow-analyzer` result whose ledger is missing or malformed.

## Entry points and lenses

An entry point is a CLI command, hook, exported function, request handler, job, or event consumer whose behavior the diff changes. Read the packet's `impact` section first: its dependents are the callers and consumers that the change can break.

Trace each entry point through two lenses:

- **User flow:** the journey a person or agent takes through commands, screens, and states.
- **Data flow:** how one value travels from its source through transforms to its sink, such as an argument through path resolution to a file write.

## Flow classes

Trace one positive flow and every negative class. Mark a class `not-applicable` only when no input of that class can reach the changed code, and say why in `observed`.

| Class | What to ask |
| --- | --- |
| `positive` | Valid input reaches the intended state, and a test proves it. |
| `malformed-input` | CRLF line endings, a byte-order mark, control and ANSI escape characters, zero-width or confusable Unicode, empty values, oversized values. |
| `boundary` | First, last, zero, one, the limit, and one past the limit. |
| `dependency-failure` | A file is missing, locked, or unreadable; Git is too old; the network is down; a child process fails or times out. |
| `concurrency` | Two worktrees, processes, or sessions at once; a retry after a crash; the same command replayed. |
| `old-state` | Records written by an earlier version, a stale packet or index, a half-written file. |
| `abuse` | Path traversal and symlinks, flag-like values swallowed by the argument parser (`--x=value`, `-h`), injection into shell, regex, or SQL, catastrophic regex backtracking, secrets reaching output or storage, including secrets split across lines. |
| `cross-boundary` | A caller, consumer, or other repository that depends on the old shape, taken from the packet's `impact` dependents. |

## Defect or extra scope

Report a negative flow as a defect when its current behavior is harmful: a crash, wrong output, data loss or corruption, a security exposure, or a silent success that hides a failure. Report it even when the spec did not name that input.

A negative flow that already fails safely, with a refusal or a clear error, is not a defect. Do not file a finding that only asks for a nicer message, an extra option, or a defensive check at a non-boundary. That is extra scope.

## Ledger rows

Return `flow_ledger` as an array in the result object. Each row has exactly these fields:

| Field | Meaning |
| --- | --- |
| `flow_class` | One of the classes above. |
| `entry` | The entry point traced. |
| `input` | The concrete input or state that starts the flow. |
| `path` | The hops through changed code as `file:line` strings. Empty only for `not-applicable`. |
| `expected` | What the code should do. |
| `observed` | What the code actually does, from reading it; for `not-applicable`, why no input of the class can reach the change. |
| `verdict` | `pass`, `defect`, `gap`, or `not-applicable`. |
| `test` | The test that covers the flow, or `null`. |
| `finding` | Only on a `defect`: the exact title of the finding this flow produced. |

A `pass` needs a covering test. A traced flow with correct behavior but no test is a `gap`, and it belongs in `testing_gaps` too. A positive flow is never `not-applicable`. Keep the ledger to at most 64 rows and 24 hops per row.

```json
{
  "flow_class": "abuse",
  "entry": "ae compound --evidence-quote",
  "input": "--evidence-quote followed by --category=logic",
  "path": ["packages/ae/lib/compound.mjs:474"],
  "expected": "Refuse with E_USAGE because the quote value is missing",
  "observed": "Stores the flag text as the quote and exits 0",
  "verdict": "defect",
  "test": null,
  "finding": "Swallowed flag accepted as evidence text"
}
```
