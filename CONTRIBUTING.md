# Contributing

Thanks for helping improve Adaptive Engineering.

## Before you start

- **Open an issue first** for anything larger than a small fix: a new command, a new skill or agent, or a change to how plans, gates or verification behave. Agreeing on the shape first saves a rewrite.
- Small fixes, such as typos, broken links or a clear bug with a test, can go straight to a pull request.

## Set up

```bash
git clone https://github.com/noodlemind/adaptive-engineering.git
cd adaptive-engineering
npm ci --prefix packages/ae
```

Run the CLI from source with `node packages/ae/bin/ae.mjs <command>`, or link it globally with `npm install -g ./packages/ae`.

## Test

From `packages/ae/`:

```bash
npm test               # full suite
npm run check:repo     # repository contract tests, including docs
npm run check:engineer # generated Engineer files match the contract
npm run check:release  # versions, packaged assets and prompt budgets
```

CI runs the full suite on Linux and Windows for every pull request.

On macOS, `/var` is a symlink and AE refuses redirected temporary paths. Run tests with the resolved temporary directory:

```bash
TMPDIR="$(cd "$TMPDIR" && pwd -P)/" npm test
```

One release-workflow test (`archive hash refusal ...`) expects `sha256sum` in `/usr/bin`, so it fails on macOS. CI runs it on Linux.

## Where to make changes

| Change | Edit |
| --- | --- |
| CLI behavior | `packages/ae/lib/`, with a test in `packages/ae/test/` |
| Engineer behavior | `packages/ae/corpus/skills/engineer/references/contract.md`, then `npm run generate:engineer` |
| Skills, agents, instructions | `packages/ae/corpus/` — see `AGENTS.md` for which files must stay in sync |
| User docs | `README.md` and `docs/` |

Add a skill before an agent. Agents exist for separate judgment, permissions or isolation; a repeated procedure is a skill. Read [How capability is acquired](docs/adaptive-engineering.md#how-capability-is-acquired) before adding either.

## Pull requests

- Keep each pull request focused on one change.
- Start commit messages with a type: `feat`, `fix`, `docs`, `test`, `refactor` or `chore`.
- Update docs in the same pull request when behavior changes. `npm run check:repo` fails on broken relative links.
- Include the test that proves the change.

## Reporting bugs

Include the `ae --version` output, the host and its version, your OS, the command you ran, and what you expected. Add `--json` output where it helps. For security problems, follow [SECURITY.md](SECURITY.md) instead.
