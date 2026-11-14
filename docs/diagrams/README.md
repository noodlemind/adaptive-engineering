# Diagram sources and local rendering

These small, hand-authored examples exercise the local diagram commands. They are explanatory inferences, not automatically extracted architecture facts, exhaustive behavior models, or model-checker results.

Open the [rendered gallery](generated/gallery.html) or inspect the [architecture](generated/architecture.svg), [dependency](generated/dependencies.svg), and [recovery](generated/recovery.svg) SVGs. These are actual CLI outputs; [samples.json](generated/samples.json) records the commands, renderer settings, observed freshness and output hashes. They are saved examples and must be regenerated to describe later source changes.

| Source | Purpose | Evidence and limits |
| --- | --- | --- |
| [ae-rendering.d2](ae-rendering.d2) | Explain the Engineer/Harness rendering boundary | The documented diagram command contract and [Adaptive Engineering](../adaptive-engineering.md); conceptual responsibilities, not a runtime call graph |
| [recovery.mmd](recovery.mmd) | Explain a simplified structured plan-update retry | `structuredPlanUpdate` in [plan-update.mjs](../../packages/ae/lib/plan-update.mjs); omits detailed locks, authority checks, completion prerequisites, and conversion handling |

The Engineer authors the view after inspecting sources. Harness renders the selected text and records source/artifact bindings. Optional directory watches include newly added regular files in freshness checks. Keeping a receipt current does not validate the explanation's semantics.

From the repository root with AE installed:

```bash
ae diagrams render --file docs/diagrams/ae-rendering.d2 --sources docs/adaptive-engineering.md,packages/ae/lib/diagram.mjs,packages/ae/lib/diagram-cmd.mjs,packages/ae/lib/diagrams --renderer d2 --layout tala --png --json
ae diagrams render --file docs/diagrams/recovery.mmd --sources packages/ae/lib/plan-update.mjs --renderer pele --png --json
ae diagrams graph --root packages/ae/lib/diagram-cmd.mjs --operation deps --depth 2 --limit 24 --max-nodes 7 --png --json
```

The JSON result supplies immutable `.harness/diagrams/<id>/` paths for the SVG, self-contained HTML, receipt, and PNG when `--png` is set. The text report prints the absolute paths and one line on how to open them. Open the returned HTML locally, or attach the PNG where SVG is not shown. Check freshness with `ae diagrams status --receipt <returned-receipt-path> --json`. Raw rendering without `--sources` remains `diagram-only`.

`ae diagrams flow --flow <existing-flow-id> --json` visualizes an already published descriptive statechart; it does not generate or update that model. Flow baselines describe the locally observed committed default branch. Dependency diagrams describe current worktree imports and retain coverage limitations. Neither is a complete runtime architecture map.

The bundled renderers load on demand; these operations require no MCP server, network request, runtime package installation, or global rendering executable. Only a bounded subset of Mermaid/D2 is accepted. Keep examples plain: no imports, remote assets, links, directives, configuration, or injected markup. The Harness chooses renderer options and TALA seeds.

In regular work, ask the Engineer to inspect the sources and explain one boundary or recovery question. Use the import view to check dependency assumptions, author the explanation in D2 or Mermaid, render it, and inspect the returned HTML. Before reusing it during review, run receipt status. The editable diagram source stays with the design; SVG, HTML, and PNG are derived outputs. PNGs in this folder are documentation previews of the same views. Pass `--png` on the commands above to write `diagram.png` beside the SVG.

## Animated walkthroughs

The [animated](animated/) folder holds three short walkthroughs used in the documentation:

| Animation | Shows | Used in |
| --- | --- | --- |
| [deliver-loop.svg](animated/deliver-loop.svg) | One Deliver task: orient, an edit denied before the gate, lock intent, gate, work, review, a failing check sent back to work, verify, compound and report | [README](../../README.md#how-it-works), [How a Deliver task runs](../adaptive-engineering.md#how-a-deliver-task-runs) |
| [engineer-grows.svg](animated/engineer-grows.svg) | How verified tasks compound into learnings, and how an authorized gap or a proven recurrence becomes a specialist or a skill | [How capability is acquired](../adaptive-engineering.md#how-capability-is-acquired) |
| [decision-receipt.svg](animated/decision-receipt.svg) | How the decision-agent judges one exact action and why its receipt does not cover a changed one | [Adaptive capability lifecycle](../reference/capability-lifecycle.md) |

They are explanatory sketches of the documented contracts, like the diagrams above, not recordings of a real session. The task names, check names and commands in them are examples.

Each one is a self-contained SVG animated with CSS. GitHub and the documentation site show it as an ordinary image, it follows the light or dark preference of the reader's system or browser (not GitHub's own theme setting) on its own opaque background, and readers who ask for reduced motion see a static summary. Each one plays three times and then stops on that summary, and the guides embed it in an open `<details>` block so a reader can collapse it at any time. Nothing is installed to view or build them: [build-doc-animations.mjs](../../scripts/build-doc-animations.mjs) generates all three from scene timelines using Node built-ins only. Edit the timeline there, never the SVG, then run:

```bash
node scripts/build-doc-animations.mjs          # write the SVGs
node scripts/build-doc-animations.mjs --check  # report SVGs that no longer match their timeline
```

The flow diagrams in the guides themselves are Mermaid blocks, which GitHub and the documentation site render from the Markdown source.
