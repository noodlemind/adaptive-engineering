# Review Perspectives Reference

## Always-Engaged Perspectives

### Correctness (flow tracing)
- One positive flow per changed entry point, with its covering test
- Malformed input, boundaries, dependency failure, concurrency, old state, abuse
- Consumers named in the packet's `impact` dependents
- Harmful negative behavior is a defect; a safe refusal is not

### Architecture
- Component boundaries and coupling
- Dependency direction (toward stable abstractions)
- Pattern consistency across the codebase
- SOLID principle compliance
- API contract stability

### Security
- Missing validation of untrusted input
- Authentication and authorization on every endpoint
- No hardcoded secrets or credentials
- SQL parameterization, XSS prevention, CSRF protection
- Dependency vulnerability scanning

### Performance
- Algorithmic complexity in hot paths
- N+1 query detection
- Memory allocation in loops
- A cache added without a measured miss
- I/O bottleneck identification

### Simplicity
- YAGNI violations and premature abstraction
- Dead code and unused imports
- Over-engineered error handling
- Unnecessary indirection layers

### Pattern Consistency
- Naming convention adherence
- Code organization matching existing patterns
- A helper extracted for one use
- Anti-pattern detection

### Data Integrity
- Migration reversibility
- Lock risk on large tables
- Constraint correctness
- Transaction boundary appropriateness

## Language-Specific Perspectives

### Java
- API contracts and nullability
- Resource lifecycle and thread safety
- Exception behavior and validation
- Modern Java conventions
- Test coverage at unit and integration boundaries

### TypeScript and JavaScript
- Runtime argument shapes and `undefined`/`null` flow in untyped modules
- Type safety (no `any`, proper narrowing)
- Strict mode compliance
- Modern patterns (optional chaining, nullish coalescing)
- React hook dependencies (when applicable)

### Python
- Type annotations on public functions
- Pythonic patterns (comprehensions, context managers)
- Specific exception handling
- Validation of untrusted input with the project's existing tools

### SQL/Data
- Query correctness and parameterization
- Index coverage and lock behavior
- Migration rollback and batching
- Constraints that enforce business invariants

### AWS
- Least-privilege IAM
- Credential and secret handling
- Retry, timeout, DLQ, and idempotency behavior
- Observability, quotas, and cost controls
