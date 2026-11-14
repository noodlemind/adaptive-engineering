# Findings Schema

This file defines the structured output contract for review personas. Each persona returns JSON matching this schema. Harness review assembly validates, filters, and reports findings. The Engineer supplies semantic adjudications and decides fix authority.

## Persona Output Format

Each persona returns a single JSON object:

```json
{
  "reviewer": "architecture-strategist",
  "status": "completed",
  "provenance": {
    "kind": "host-invocation",
    "agent": "architecture-strategist",
    "via": "code-review-coordinator"
  },
  "findings": [
    {
      "file": "path/to/file.rb",
      "line": 42,
      "severity": "P1",
      "confidence": 0.85,
      "title": "Circular dependency between UserService and AuthService",
      "description": "UserService imports AuthService which imports UserService, creating a circular dependency that will cause initialization failures.",
      "suggested_fix": "Extract shared logic into a separate module that both services can depend on.",
      "autofix_class": "manual",
      "evidence": [
        "UserService line 3: require 'auth_service'",
        "AuthService line 5: require 'user_service'"
      ]
    }
  ],
  "residual_risks": [
    "The auth middleware chain has not been fully traced — additional circular dependencies may exist."
  ],
  "testing_gaps": [
    "No integration test verifies the full auth → user → auth chain."
  ]
}
```

## Field Definitions

### Finding Fields (required)

| Field | Type | Description |
|-------|------|-------------|
| `file` | string | Repo-relative product file path; for document review of an external current-project plan, use the exact packet source path |
| `line` | integer | Exact current line number in that readable packet source (a workspace file or current-project plan) |
| `severity` | enum | `P1` (critical), `P2` (important), `P3` (suggestion) |
| `confidence` | float | 0.0 to 1.0 — how confident the reviewer is that this is a real issue |
| `title` | string | One-line summary of the issue |
| `description` | string | What the problem is, why it matters, what the impact is |
| `suggested_fix` | string | Concrete recommendation (not "consider" or "might want to") |
| `autofix_class` | enum | How the finding should be routed (see Action Routing below) |
| `evidence` | array[string] | Specific code references, line quotes, or observations supporting the finding |

### Top-Level Fields

| Field | Type | Description |
|-------|------|-------------|
| `reviewer` | string | Required perspective/check ID declared in the packet |
| `status` | enum | `completed` or actual failure status such as `timed-out`; only completed validates as coverage |
| `provenance` | object | Recorded invocation: `kind: "host-invocation"`, `agent` matching `reviewer`, and `via: "engineer"` or `"code-review-coordinator"`. For same-context work use `kind: "same-context"` and `agent: "engineer"`; it does not count as independent review. These are declared records, not host-attested transcripts. |
| `findings` | array | List of finding objects |
| `residual_risks` | array[string] | Risks that remain even after all findings are addressed |
| `testing_gaps` | array[string] | Areas where test coverage is insufficient |
| `flow_ledger` | array | Required from `spec-flow-analyzer` in a code review, and ignored from other reviewers: one positive flow and every negative flow class, each row shaped as `flow-tracing.md` defines. A `defect` row names the exact title of a finding in the same result. |

## Severity Definitions

| Level | Meaning | Examples |
|-------|---------|---------|
| **P1 Critical** | Exploitable vulnerability, data loss/corruption, breaking change, security hole | SQL injection, auth bypass, N+1 on user-facing endpoint with unbounded data |
| **P2 Important** | High-impact defect likely hit in normal usage, breaking contract, meaningful downside | Missing validation of untrusted input, race condition under normal load, architectural violation |
| **P3 Suggestion** | Low-impact improvement, narrow scope, minor quality enhancement | Naming inconsistency, extra helper, comment on code this change did not need |

## Confidence Guidelines

| Confidence | When to use |
|-----------|-------------|
| **0.90-1.0** | Certain — the issue is provably present (e.g., visible in the diff, confirmed by reading the code) |
| **0.75-0.89** | High — strong evidence but not 100% verified (e.g., likely N+1 but haven't traced the full query chain) |
| **0.60-0.74** | Moderate — plausible issue but context-dependent (e.g., may be handled elsewhere, depends on runtime behavior) |
| **Below 0.60** | Low — speculative or uncertain. These are suppressed during synthesis (exception: P1 at 0.50+ survives) |

## Action Routing (autofix_class)

| Class | Meaning | Routed to |
|-------|---------|-----------|
| `safe_auto` | Local, deterministic fix that doesn't change behavior or contracts | Engineer assesses authority and behavior before applying |
| `gated_auto` | Concrete fix exists but changes behavior, contracts, or permissions | Applicable recorded authorization before applying |
| `manual` | Actionable work that requires human judgment or larger changes | Handoff as residual work |
| `advisory` | Report-only: learnings, rollout notes, residual risk observations | Included in report, no action taken |

### Routing Guidelines

- A typo or another demonstrated behavior-preserving local correction may be `safe_auto`; a missing null check requires judgment about valid inputs and behavior. Classification never grants tool authority.
- Changing a public API response format, modifying auth permissions, altering database constraints → `gated_auto`
- Architectural refactoring, redesigning a module boundary, rewriting a test strategy → `manual`
- "This area has historically been fragile", deployment considerations, monitoring suggestions → `advisory`

## Quality Rules for Findings

Before submitting findings, each persona should verify:

1. **Every finding is actionable** — it says exactly what to do, not "consider" or "might want to"
2. **No false positives from skimming** — the surrounding code was actually read; the "bug" isn't handled elsewhere
3. **Severity is calibrated** — a style nit is never P1; a SQL injection is never P3
4. **Line numbers are accurate** — verified against the actual file content
5. **Confidence is honest** — don't inflate confidence to get past the threshold
6. **Evidence supports the claim** — each finding has at least one concrete code reference
7. **Extra code is the defect** — a suggested fix that only adds a helper, option, comment, abstraction, or defensive check the spec did not name. Flag that extra code. Keep a missing check at a real boundary, and keep a negative flow whose current behavior is harmful.
