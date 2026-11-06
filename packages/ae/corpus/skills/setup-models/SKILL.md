---
name: setup-models
description: Ask once for a reasoning budget and a model per AE role, then write the host user rule. Use when configuring AE models or changing a role model. Does not call a model.
user-invocable: false
---

# Setup models

Write one user rule that names the model for each AE role. AE does not call a model. Do not stamp Copilot agent files and do not write a Codex profile.

## Trigger Examples

**Should trigger:**
- "Configure which model each AE role uses."
- "Set a reasoning budget for reviewers and researchers."
- "Change the specialist model and keep my other choices."

**Should not trigger:**
- "Review this diff." Use /code-review.
- "Implement the feature." Use Engineer Deliver mode.
- "Pin a model inside an agent file during install." Leave shipped agent frontmatter unset.

## Steps

### 1. Detect available models

List the model slugs this session can pass to a subagent. On Cursor that is a Task `model`. On Claude Code that is an Agent tool `model`. If none are visible, keep `inherit`; for optional role customization, ask the user to paste the slugs they have. Never write a real slug you have not confirmed. `inherit` is always allowed.

### 2. Load the current rule

The roles are `engineer`, `specialist`, `researcher`, `reviewer`, and `decision`. Each default is `inherit`; prefer a detected small model for `decision` when the user accepts it. The user home is `USERPROFILE` on Windows and `HOME` on macOS and Linux. Cursor stores `.cursor/rules/ae-models.mdc` under that home. Claude Code stores `.claude/rules/ae-models.md` under that home. If the file exists, read its `# budget` line and its role values. On a re-run, keep a role the user changed by family or by `inherit`, and apply the new budget only to the effort token of a real slug. Drop a role line that is not one of those five.

### 3. Ask for one budget

Prefer the host question tool over free text. Offer these labels. With no rule, say that `large` matches the `inherit` defaults, so every role omits the model until the user picks a slug.

- `unlimited — max reasoning`
- `large — xhigh reasoning`
- `medium — high reasoning`
- `small — medium reasoning`

`unlimited`, `large`, `medium`, and `small` set the effort token of every real slug to `max`, `xhigh`, `high`, or `medium`. The effort token is the last token, or the one before a trailing `fast`, on the ladder `max` > `xhigh` > `high` > `medium` > `low`. If that slug was not detected, use the same family's detected slug at the highest effort at or below the target, or mark the role as needing a choice. `inherit` stays `inherit`.

### 4. Show each role

Show `engineer`, `specialist`, `researcher`, `reviewer`, and `decision`, and ask the user to accept or change each one. Offer the detected slugs plus `inherit`. Prefer the host question tool.

`engineer` is the orchestrator. `specialist` is `code-implementer` and `bug-reproduction-validator`. `researcher` is `repo-research-analyst`, `best-practices-researcher`, `framework-docs-researcher`, and `git-history-analyzer`. `reviewer` is a review specialist, including reviewers dispatched by `code-review` and document-review personas. `decision` is the internal `decision-agent` for bounded action/capability/memory/readiness judgment; it is not an external inference API. Select a small model only from effectively available host choices. When per-role selection is unsupported or ignored, report inheritance rather than claiming a small model ran.

### 5. Validate

Every real slug in the file must be one the session detected or one the user pasted. `inherit` always passes. If a chosen real slug is not available, stop and ask again.

### 6. Write the rule

Overwrite the whole file so a re-run stays idempotent. Tell the user it applies to new sessions.

On Cursor, write `~/.cursor/rules/ae-models.mdc` with `alwaysApply: true`, a `# budget` line, and one line per role:

```
---
description: AE per-role model choices
alwaysApply: true
---
# AE model configuration. One line per role. Delete a line to omit the model.
# `inherit` omits the spawn model so the subagent uses the parent session.
# budget: large (xhigh)
engineer: inherit
specialist: inherit
researcher: inherit
reviewer: inherit
decision: inherit
```

On Claude Code, write `~/.claude/rules/ae-models.md` with no frontmatter, then the same comment lines, the `# budget` line, and one line per role. Map a Claude slug such as `claude-opus-5-5-xhigh` to `opus xhigh`, which is `model` `opus` and `effort` `xhigh`. The family is `opus`, `sonnet`, `haiku`, or `fable`. Drop `-fast`. A `grok-*`, `gpt-*`, or other non-Claude slug is omitted: write `inherit` for that role. `inherit` means omit `model`. Do not put the role lines in `CLAUDE.md` or `AGENTS.md`.

### 7. Copilot and Codex

Copilot has no spawn argument for a model. Subagents inherit the session model. A user who wants a pin sets `model` by hand in that agent's frontmatter. A name that contains parentheses can fail to resolve in JetBrains agent frontmatter. This skill does not write that field.

Codex stores `model` and `model_reasoning_effort` in `~/.codex/<profile>.config.toml`, selected with `codex --profile`. A role `config_file` can set the same keys. Omitted values inherit. `codex exec` 0.144.5 ignored a role file's `model` and `model_reasoning_effort` (https://github.com/openai/codex/issues/33881). This skill does not run that case and does not write a profile.

## Spawn

A spawn reads the matching role line and passes that model when the host spawn tool takes one. A missing file, a missing line, or `inherit` means omit the model.
