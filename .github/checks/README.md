# Review Checks

Product-repo automated review criteria. Each `.md` file in this directory defines a workspace-specific check that `/code-review` discovers and applies during reviews.

Bundled checks ship with the `/code-review` skill under `packages/ae/corpus/skills/code-review/references/checks/`, so every installation loads them with the skill. Use `.github/checks/` only for product-specific additions.

## How It Works

1. `/code-review` scans bundled checks first, then workspace `.github/checks/` for product-specific check files
2. Each check spawns a focused review subagent with the check's criteria
3. Findings use the same severity (P1-P3) and confidence (0.0-1.0) scoring as persona reviewers
4. Project teams add their own workspace checks without modifying global agents or skills

## Check Format

```markdown
---
name: check-name
description: "One-line description of what this check looks for"
severity-default: P2
globs: "**/*.java"
---

## What to Look For

- [Specific pattern or anti-pattern to detect]
- [Another specific pattern]

## Examples

**Bad:**
[Code example showing the anti-pattern]

**Good:**
[Code example showing the correct approach]
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Kebab-case identifier |
| `description` | Yes | What the check detects — used by the reviewer to decide relevance |
| `severity-default` | No | Default severity for findings from this check (P1/P2/P3). Default: P2 |
| `globs` | No | File patterns this check applies to. If omitted, applies to all files |

## Size Guidance

- Keep each check under 50 lines — focused on one concern
- Use examples to show good/bad patterns
- Reference external docs when the full convention is too long to inline

## Adding Product-Specific Checks

Product repositories may create their own `.github/checks/` directory for product-owned review overlays:

```
.github/checks/
  no-raw-sql.md              # Prevent raw SQL strings
  api-versioning.md          # Ensure API endpoints are versioned
  logging-standards.md       # Consistent structured logging
  test-naming.md             # Test method naming conventions
```
