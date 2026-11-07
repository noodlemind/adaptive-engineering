# Model preferences

AE does not call a model. The host runs the model, and shipped agents omit `model`, so every subagent inherits the session model by default.

To choose a model per role, ask the Engineer to load the engineer-internal `setup-models` skill. It asks once and writes one user rule that spawn sites read. The approach follows [pstack's `setup-pstack`](https://github.com/cursor/plugins/blob/main/pstack/skills/setup-pstack/SKILL.md).

## What `setup-models` does

1. It lists the model slugs the session can pass to a subagent. If it cannot see any, it asks you to paste them. It never writes a slug that was not confirmed. `inherit` is always allowed.
2. It asks for one reasoning budget: `unlimited — max reasoning`, `large — xhigh reasoning`, `medium — high reasoning` or `small — medium reasoning`.
3. It shows the four roles, `engineer`, `specialist`, `researcher` and `reviewer`, and lets you accept or change each one.
4. It writes the rule file for the host. A re-run reads the existing file and keeps roles you changed.

A spawn reads the matching role line and passes the model when the host's spawn tool accepts one. A missing file, a missing line or `inherit` omits the model. There is no parser in the `ae` CLI.

## Where the rule lives

| Host | File | Notes |
| --- | --- | --- |
| Cursor | `~/.cursor/rules/ae-models.mdc` | Written with `alwaysApply: true`. |
| Claude Code | `~/.claude/rules/ae-models.md` | No frontmatter. A slug such as `claude-opus-5-5-xhigh` is stored as `opus xhigh`. A non-Claude slug is stored as `inherit`. |
| Codex | Set by hand | Put `model` and `model_reasoning_effort` in `~/.codex/<profile>.config.toml` or in a role `config_file`. [openai/codex#33881](https://github.com/openai/codex/issues/33881) reports that `codex exec` 0.144.5 ignored a role file's model and effort. |
| GitHub Copilot | Set by hand | Subagents inherit the session model. To pin one, set `model` in that agent's frontmatter. A name with parentheses can fail to resolve in JetBrains ([copilot-intellij-feedback#1536](https://github.com/microsoft/copilot-intellij-feedback/issues/1536)). |

The user home is `USERPROFILE` on Windows and `HOME` on macOS and Linux.

Sample Cursor rule after accepting the defaults:

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
```

## Host documentation

- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents): `model` is `inherit`, a family alias or a full model id. The per-invocation parameter wins, then the subagent file, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main conversation's model.
- [Cursor subagents](https://cursor.com/docs/subagents): `model` is `inherit` (the default) or a model id; bracket parameters such as `[effort=high]` set options.
- [Codex advanced configuration](https://developers.openai.com/codex/config-advanced): profiles are separate files selected with `codex --profile <profile>`.
- [GitHub Copilot custom agents](https://docs.github.com/en/copilot/reference/custom-agents-configuration): `model` in the agent frontmatter; an unset model inherits the default.
