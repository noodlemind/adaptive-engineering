# Flow models and diagrams

Optional descriptive application maps and local diagram rendering.

## Shared descriptive flow models

The optional shared application map describes committed default-branch behavior through a lightweight structured statechart. It complements import facts and product verification recipes. The Engineer authors states, events, guards, failure paths, assumptions, and limitations after inspecting exact sources. Harness prepares source bindings, validates the schema, and publishes immutable snapshots keyed by the existing project identity and generation commit. It never fetches a remote or invokes an LLM.

```bash
ae flows prepare --file .harness/decisions/flow-scope.json --json
ae flows publish --file .harness/decisions/flow-candidate.json --json
ae flows status --json
ae flows show --json
```

The optional scope file contains `watchPaths`, for example `{"watchPaths":["src/orders"]}`. Preparation returns the locally observed default ref, commit, exact regular source paths, modes, hashes, and digest. A candidate preserves that preparation verbatim and adds a version 1 `statechart` model. Publish rechecks the observed tip and bindings; identical retries replay, while conflicting bytes at an existing generation fail. The [flow-model reference](../../packages/ae/corpus/skills/codebase-context/references/flow-models.md) defines the authoring and maintenance procedure.

The baseline is the locally available default ref resolved from configuration or `origin/HEAD`, not feature HEAD, dirty worktree bytes, or an unseen remote tip. Status distinguishes absent, current, stale, and unknown. Watched changes on a later observed default tip make the map stale; an unrelated linear advance may preserve currentness for that scope. New committed files beneath watched directories participate. Unresolved or divergent metadata remains unknown. Linked worktrees share the project's local model store in the selected Harness home; no distributed synchronization is implied.

Orientation returns bounded relevant pointers, at most 4096 bytes, when task files or an exact flow ID match. It does not include the model body in the response. The Engineer can expand the pointer to check intent completeness, then inspect the task candidate separately. This descriptive context cannot accept requirements, enter `intent_sources` automatically, grant mutation authority, or satisfy verification. Missing optional maps leave unrelated work available.

A successful compound may return an advisory `flowMaintenance` pointer when an existing map is stale after relevant observed-default advancement. Compound does not merge main, generate a map, or run an agent. The Engineer explicitly prepares again, inspects the new committed sources, and publishes an authored generation within authorized scope. Explicit regeneration uses the same procedure. Deep rerunnable proof stays in the maintained product recipe rather than the descriptive map.

## Local diagram rendering

The existing Codebase Context skill owns diagram interpretation through its on-demand [diagram reference](../../packages/ae/corpus/skills/codebase-context/references/diagrams.md). The host Engineer authors source-backed explanations and labels inferred or proposed relationships; Harness renders bounded local inputs, captures provenance, and reports freshness. This adds no agent, MCP server, model call, network request, or runtime installer. Bundled Pele and D2 dependencies load on demand in workers and produce SVG plus self-contained HTML. Optional `--png` adds a PNG beside the SVG through bundled resvg WebAssembly.

```bash
ae diagrams render --file docs/diagrams/ae-rendering.d2 --sources src/orders,config/orders.json --renderer d2 --layout tala --json
ae diagrams render --file docs/diagrams/recovery.mmd --sources src/orders --renderer pele --json
ae diagrams graph --root src/orders/service.ts --operation deps --depth 2 --limit 40 --json
ae diagrams flow --flow order-recovery --json
ae diagrams status --receipt .harness/diagrams/<id>/receipt.json --json
```

Render accepts a restricted Mermaid/D2 subset with Harness-owned options; imports, remote assets, author-controlled renderer configuration, links, and markup are unsupported. TALA handles architecture layout, with ELK or Dagre available for directional views. TALA is part of the bundled D2 WebAssembly build, so the command does not install a separate layout binary. The returned `id` and `artifacts` identify immutable output under `.harness/diagrams/<id>/`, including `svg`, `html`, `receipt`, and `png` when requested. The text report prints those absolute paths. `--scale` accepts 1 to 4 and defaults to 2. Without `--sources`, authored text remains `diagram-only`; selected files or directories bind the view to worktree bytes and watched inventory, including new files.

Dependency diagrams reuse bounded current-worktree import facts and retain unresolved edges and coverage limits. Flow diagrams render existing committed-default-branch descriptive models without regenerating them; keep their recorded generation and freshness distinct from the worktree. Artifact integrity and source currentness do not prove architecture correctness, complete behavior, accepted intent, or a checked property. [Hand-authored examples](../diagrams/README.md) illustrate these limits.

A state-model check from the [formal verification reference](../../packages/ae/corpus/skills/create-primitive/references/formal-verification.md) writes a `chart.mmd` that marks where each rule breaks and numbers the shortest path to it. Render it with `ae diagrams render --renderer pele` like any authored Mermaid file. The chart explains a result; the check's receipt remains the evidence.
