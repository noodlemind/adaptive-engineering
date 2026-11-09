---
name: harness-doctor
description: Diagnose Harness installation, knowledge and hook enforcement. Use after onboarding or upgrades, or when mutation and completion gates misbehave.
argument-hint: "[optional product repo path]"
---

# Harness Doctor

Select the target from the requested host or observed session: `vscode`, `cli`, or `intellij`. Run `ae doctor --workspace <product-path> --target <selected-target> --json`, preserving the selected homes with `--copilot-home`, `--ae-home`, and the configured `AE_INTELLIJ_HOME` when applicable. If the target is unknown, run base diagnosis without `--target` and report native target readiness as unselected. Harness owns discovery, runtime probes, check criteria, counts and diagnostic hints. Read its actual results, diagnose causes, and choose an authorized repair; file presence alone is not success.

The VS Code and CLI hook probes use isolated fixtures and the installed bundle. Passing them proves those executable contracts, not live host activation. IntelliJ customization health does not establish mutation enforcement: native lifecycle hooks are unavailable. Report unsupported hosts as degraded; explicit gate and verify require an available CLI.

Doctor is read-only. Check K8 appears only under `knowledge.feedback` `suggest` or `on`: it lists learnings exposed five or more times with no `helped` verdict. Treat it as a pruning hint for the human; retiring still needs `ae learning retire`. Product changes enter Engineer Deliver mode. When an agreed product adapter is available, read `<copilot-home>/skills/references/installed-product-proof.md` with the host read tool. Outside the enforce hook, `ae get --reference skills/references/installed-product-proof.md --json` prints the same file.

When a task names an editor or a host failure needs installation context, read `ae inventory show --json`. Missing or dated inventory is an observation, not a delivery blocker. Request an on-demand `ae inventory refresh --editor vscode|cursor|jetbrains --json` only when fresh metadata helps the diagnosis. Refresh writes the selected Harness home's cache; it does not change editor settings or open an editor. Installed extensions and settings overrides do not prove enabled, effective or running capabilities. Prove the actual task operation separately.

Use `ae domain show --name <name> --json` for an existing local domain configuration. Version 1 reports membership and identity drift only. Shared conventions are advisory; the view cannot authorize cross-repository edits or create plans and worktrees.

## Trigger Examples

**Should trigger:**
- "Check Harness after upgrading."
- "Explain why the installed edit hook denies this change."
- "Diagnose completion enforcement during onboarding."

**Should not trigger:**
- "Implement a product feature."
- "Review this diff."
- "Publish a learning from verified work."
