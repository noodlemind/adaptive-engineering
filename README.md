# Adaptive Engineering

**The Engineer decides. The Harness checks the work and keeps the record.**

Adaptive Engineering (AE) turns the coding agent you already use into an accountable engineer. The agent still does the thinking. AE adds a deterministic harness around it: a change needs an accepted plan before the first edit, "done" needs your own checks passing on the final code, and lessons from verified work carry into the next task.

AE starts small: one Engineer and the `ae` harness. Skills, specialist reviewers and project rules are acquired when the work shows they are needed, under authority a person grants, either for one action or as a scoped standing grant.

## Why

Coding agents are fast, and they are confident whether or not they are right. Three problems come up again and again:

- **Edits without intent.** The agent starts changing files before anyone agreed on what "done" means.
- **Claims without proof.** "All tests pass" is a sentence in the chat, not evidence bound to the code that shipped.
- **Lessons that evaporate.** What one session learned is gone in the next.

AE answers each one with a mechanism rather than a prompt. Host hooks deny product edits until a plan is locked. `ae verify` runs the project's own named checks and records the result against the exact bytes. A Deliver task records a lesson only after its checks pass; you can also teach AE directly with `ae remember`. Learnings come back in the next task's context.

## How it works

```text
@engineer: Answer      → direct, read-only reply
           Investigate → evidence-backed, read-only report
           Deliver     → orient → lock intent → gate → work → review → verify → compound → report
           Review      → independent assessment
```

You ask the Engineer for an outcome. It picks one of four modes. Only Deliver can edit files, and every Deliver task runs the same loop. The `ae` harness never calls a model: it orients the task, locks the plan, gates edits, runs checks without a shell, and stores evidence and learnings outside your repository.

Read [How Adaptive Engineering works](docs/adaptive-engineering.md) for the full model.

## Quick start

Requires Node.js 20+, Git and a supported host.

```bash
git clone https://github.com/noodlemind/adaptive-engineering.git
cd adaptive-engineering
npm ci --prefix packages/ae
npm install -g ./packages/ae

ae host setup --host claude-code     # or codex, cursor, terminal
cd ~/code/your-project && ae init-repo
```

Then open your project in the host and start the Engineer: `/engineer` in Claude Code and Cursor, `$engineer` in Codex. [Hosts](docs/hosts.md#set-up-a-host) covers the others.

Host setup installs hooks that apply to every repository you open with that host. Read [Getting started](docs/getting-started.md) before you install, including how to try AE in advisory mode.

## Documentation

| Read | To |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install, connect a host and run a first task |
| [Using AE](docs/using-ae.md) | Ask well, read results, work with a team, troubleshoot |
| [Hosts](docs/hosts.md) | Per-host setup, capabilities and limits |
| [How Adaptive Engineering works](docs/adaptive-engineering.md) | Understand the Engineer, the Harness and how capability grows |
| [Reference](docs/adaptive-engineering.md#reference) | Detailed contracts for plans, verification, domains and more |
| [CLI reference](packages/ae/README.md) | Every `ae` command |
| [Migration guide](docs/migration/ae.md) | Move from the older `harness` command and `~/.harness` state |

## Supported hosts

| Host | Setup | Gated edits | Completion held until proof |
| --- | --- | --- | --- |
| Claude Code | `ae host setup --host claude-code` | Yes | Yes |
| Codex | `ae host setup --host codex` | Yes | Yes |
| Cursor | `ae host setup --host cursor` | Yes | Advisory |
| Terminal | `ae host setup --host terminal` | No hooks; manual CLI | No |
| GitHub Copilot | `ae install --configure-vscode` (legacy) | VS Code and Copilot CLI | See [Hosts](docs/hosts.md) |

## Status

AE is at version 0.14.3 and changes quickly. `ae --version` prints the version you installed.

- **Install from source.** The `ae-harness` package is not yet published to npm.
- **Native behavior is not certified.** Setup reports `nativeQualification: unverified`. The mechanics are covered by automated tests on Linux and Windows, but a configured hook is not proof that a particular host version loaded it. Try AE on the host, version and OS you plan to rely on.
- **Hooks are global.** Host setup affects every repository you open with that host. Use `HARNESS_ENFORCEMENT=observe` while evaluating.
- **`ae doctor` is for the legacy Copilot install.** On other hosts use `ae host status`.

## Repository layout

```text
packages/ae/            the ae CLI (npm package ae-harness)
  bin/ lib/             command entry point and harness kernel
  corpus/               skills, agents, instructions and knowledge that ae installs into a host
  test/                 Node test suite
docs/                   guides, the concept doc and reference pages
.github/                CI workflows and this repository's own AE configuration
```

## Contributing

Issues and pull requests are welcome. Open an issue before a large change. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Report security problems privately as described in [SECURITY.md](SECURITY.md).

## Acknowledgements

AE's planning, review and compounding loop builds on ideas from [Compound Engineering](https://github.com/EveryInc/compound-engineering-plugin). Its Node-only state-model checker's report, with a shortest path for each broken rule and a chart that marks where it breaks, learns from [Lauren Tan's pstack `/statechart`](https://github.com/cursor/plugins/tree/main/pstack/skills/statechart). AE ships its own implementation and no pstack source. See [third-party notices](packages/ae/THIRD-PARTY-NOTICES.md).

## License

No license has been chosen yet. Until one is added, the code is published for reading and evaluation, and all rights are reserved.
