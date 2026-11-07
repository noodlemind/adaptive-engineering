# Team Knowledge (Global)

Compounded learnings and index for cross-repository recall. Installed globally by `ae` to:

- `%USERPROFILE%\.copilot\knowledge\` (VS Code / shared Copilot)
- `%LOCALAPPDATA%\github-copilot\intellij\knowledge\` (IntelliJ)

## Layout

```text
knowledge/
  manifest.yaml       # Index for /recall and /index-memory
  profile.md          # User preferences (from profile.md.template on first hydrate)
  solutions/          # Team-wide solution docs from /compound-learnings
```

## Product vs global

| Artifact | Location |
|----------|----------|
| Active issues / plans | `~/.ae/projects/<repo-id>/plans/`; existing `.harness/plans/` and `docs/plans/` stay readable |
| Reusable fixes / patterns | Here (`knowledge/solutions/`) |
| Repo-private episodes | `~/.ae/projects/<repo-id>/docs/solutions/` or committed `docs/solutions/` |
| Repo-specific conventions | `.harness/agent-context.md` or committed `docs/agent-context.md` |

Do not put secrets, customer PII, or proprietary code blocks in global solutions — use symptoms, patterns, and safe snippets only.

## Maintenance

- After compounding: run `/index-memory` or let `/compound-learnings` update `manifest.yaml`.
- Re-hydrate with `ae upgrade`.

Context paths are defined by the hydrated shared reference `knowledge-locations.md`.
