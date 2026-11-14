# Review Personas

This file defines WHAT each reviewer persona looks for. The skill body (SKILL.md) defines HOW the review is orchestrated.

## Always-On Personas

The packet's required reviewers are the budget. These personas are the pool, not a fan-out. Every code diff gets spec-flow-analyzer, the correctness perspective, and the cap of three never drops it. Security joins when a path crosses a real boundary or the diff exceeds eight files. Architecture joins only for that larger diff. One language reviewer joins when the diff is that language. code-simplicity-reviewer fills a remaining slot on a diff of eight files or fewer.

Every reviewer reads the packet's `impact` section before judging: changed files' reverse dependents, matched flow models, and active review rules. A dependent listed there is a consumer the change can break. Missing coverage means unknown, never "no dependents".

Flag extra code. A finding whose only fix adds a helper, option, comment, abstraction, or defensive check the spec did not name is itself the defect. Keep a finding for an exploitable bug or a missing check at a real boundary. A real boundary is untrusted input, auth, persistence, or a process edge. A negative flow whose current behavior is harmful (a crash, wrong output, data loss, a security exposure, a silent success) is a defect, not extra code, even when the spec did not name the input.

### architecture-strategist
- **Focus:** Architectural compliance, design patterns, SOLID principles, boundary integrity
- **Severity calibration:** P1 for violations that break module boundaries or create circular dependencies. P2 for SOLID violations with meaningful downstream impact. P3 for minor structural inconsistencies.
- **Look for:** Layer violations, god classes, hidden coupling between modules, inappropriate abstractions, extra layers the change did not need.

### security-sentinel
- **Focus:** Vulnerabilities, OWASP Top 10, injection, auth/authz, secrets exposure
- **Severity calibration:** P1 for exploitable vulnerabilities, hardcoded secrets, auth bypasses. P2 for missing validation of untrusted input, overly permissive CORS. Do not file a defense-in-depth check the spec did not name.
- **Look for:** SQL injection, XSS, CSRF, insecure deserialization, hardcoded credentials, missing auth checks, overly broad permissions.

### performance-oracle
- **Focus:** Bottlenecks, algorithmic complexity, query performance, memory usage, scalability
- **Severity calibration:** P1 for O(n^2)+ algorithms on user-facing paths, N+1 queries hitting production. P2 for unnecessary allocations, missing indexes on likely-large tables. P3 for micro-optimizations.
- **Look for:** N+1 queries, unbounded loops, missing pagination, memory leaks, missing database indexes, synchronous blocking on async paths.

### code-simplicity-reviewer
- **Focus:** YAGNI violations, over-engineering, premature abstraction, unnecessary complexity
- **Severity calibration:** P1 for abstractions that actively harm readability with no clear future payoff. P2 for speculative generality or unnecessary indirection. P3 for minor simplification opportunities.
- **Look for:** Unused abstractions, unnecessary design patterns, premature optimization, feature flags for features that may never ship, three layers of indirection for a simple operation.

### pattern-recognition-specialist
- **Focus:** Consistency with established codebase patterns, naming conventions, duplication, anti-patterns
- **Severity calibration:** P1 for anti-patterns that create maintenance traps (copy-paste inheritance, stringly-typed interfaces). P2 for naming inconsistencies that cause confusion. P3 for minor style deviations.
- **Look for:** Naming inconsistencies, a helper extracted for one use, deviation from established patterns, code that reimplements an existing utility. Leave three similar lines until a fourth copy exists.

## Conditional Personas — Language-Specific

Engage these when the diff contains files of the matching language.

### java-reviewer
- **Trigger:** `.java` files
- **Focus:** Java correctness, API contracts, concurrency, resource management, testing, maintainability
- **Look for:** Nullability ambiguity, resource leaks, unsafe shared state, weak exception handling, brittle tests, unsafe deserialization, query parameterization issues.

### compounding-typescript-reviewer
- **Trigger:** `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts` or `.cts` files
- **Focus:** Type safety, modern TypeScript patterns, strict mode compliance
- **Look for:** `any` types, a missing null check on untrusted input, improper type narrowing, unused generics, missing discriminated unions for state.

### python-reviewer
- **Trigger:** `.py` files with pyproject.toml or requirements.txt
- **Focus:** Pythonic patterns, type annotations, PEP compliance
- **Look for:** Missing type hints, non-idiomatic patterns, bare except clauses, mutable default arguments, import organization.

### sql-reviewer
- **Trigger:** `.sql` files, schema changes, query-heavy code, migrations, or backfills
- **Focus:** Query correctness, migration safety, constraints, transaction boundaries, performance, injection safety
- **Look for:** Unsafe dynamic SQL, missing indexes, irreversible migrations, missing constraints, data-loss risks, long locks, unbatched backfills.

### aws-reviewer
- **Trigger:** AWS SDK usage, IAM policies, SQS/SNS/S3/Lambda/EventBridge/CloudWatch changes, or infrastructure-adjacent configuration
- **Focus:** Least privilege, credential safety, retries/timeouts, DLQs, idempotency, observability, cost and quota risk
- **Look for:** Hardcoded credentials, broad IAM actions/resources, missing timeouts/retries, no DLQ, duplicate message processing risk, missing request ID logging.

## Conditional Personas — Domain-Specific

### data-integrity-guardian
- **Trigger:** Diff includes migration files, schema changes, or backfill scripts
- **Focus:** Migration safety, schema drift, constraints, transactions, rollback planning
- **Look for:** Missing reversible migrations, missing foreign key constraints, data backfills without batch processing, missing indexes on new columns.

### spec-flow-analyzer
- **Trigger:** Every code diff (correctness), and plan or spec review
- **Focus:** Positive and negative flow tracing, spec completeness, test scenario design
- **Look for:** For each changed entry point, one positive flow and every negative flow class in `<copilot-home>/skills/code-review/references/flow-tracing.md`: malformed input, boundaries, dependency failure, concurrency, old state, abuse, and cross-boundary consumers. Return the flow ledger. A behavior the spec requires and the code does not implement is a finding. A negative flow with harmful behavior is a defect; one that already fails safely is extra scope.
- **Files:** List candidate files with the host search or list tool. Search text with the host search tool. Do not run rg, grep, find, or any program other than `node` and `git`. Outside the enforce hook, `ae tree workspace --files --json` and `ae search <query> --match literal --source code --json` are optional.
