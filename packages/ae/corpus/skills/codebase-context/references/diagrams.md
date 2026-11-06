# Local architecture and flow diagrams

Use this reference when the user requests a rendered view, or a diagram materially clarifies the requested codebase explanation. Keep ordinary orientation lightweight. Reuse this skill; a renderer does not need a separate agent, model, MCP server, or workflow entry point.

The Engineer chooses the question, inspects evidence, authors the explanation, and judges whether it is useful. Harness performs deterministic source capture, bounded rendering, artifact publication, and receipt checks. Neither a successful render nor a current receipt proves that the authored relationships are correct or complete.

## Choose the evidence and view

| Need | Input and operation | Interpretation |
| --- | --- | --- |
| Explain an architecture boundary or proposed design | Authored `.d2` or `.mmd` and explicit source paths with `diagrams render` | Agent-authored inference; name assumptions and uncertainty |
| Inspect module dependencies or dependents | Current repository file with `diagrams graph` | Bounded observed import relationships, not runtime calls |
| Visualize a published descriptive statechart | Existing exact flow ID with `diagrams flow` | The recorded committed-default-branch model, with its freshness and limitations |
| Inspect retained formal model evidence | AE `formal-verification.json` and an exact recorded module with `diagrams formal` | Counterexample replay, or a positive model's bound explored graph; no new checker execution |

For an architecture view, inspect entry points, configuration, state writers, and the relevant dependencies. Record which relationships are directly observed, inferred, proposed, or unresolved in the accompanying explanation. A declared product or harness delegation graph is not a runtime architecture map. Do not silently convert an import edge into a request, event, or data-flow assertion.

Use a small view around one question. Keep context, components, deployment, and behavior in separate views when combining them would obscure the answer. Preserve readable labels, meaningful boundaries, edge direction, and uncertainty before spending effort on appearance.

## Render an authored view

```bash
ae diagrams render --file docs/diagrams/architecture.d2 --sources src/orders,config/orders.json --renderer d2 --layout tala --png --json
ae diagrams render --file docs/diagrams/recovery.mmd --sources src/orders --renderer pele --png --scale 2 --json
```

All paths are repository-relative. `--sources` is a comma-separated selection of explicit files or directories. Include likely locations of additional writers: directory watches capture their inventory so a new file can invalidate freshness. A diagram source alone cannot establish source coverage. Without `--sources`, the result is explicitly `diagram-only`; do not present it as source-bound architecture evidence.

Pele renders Mermaid to SVG without a browser. D2 uses its bundled JavaScript/WASM engine; TALA is the architecture layout, while ELK and Dagre are available for directional views. TALA ships inside that WASM build under the same MPL-2.0 terms as D2. It does not need a license key or a separate TALA binary. The default layout stays TALA. The dependencies load on demand in bounded workers. Rendering invokes no model, fetches no remote, and installs no executable, package, or browser at runtime. Users do not need global D2, TALA, Graphviz, Java, or Chromium installations for these commands.

`--png` also writes `diagram.png` next to the SVG. `--scale` is an integer from 1 to 4 and defaults to 2. The PNG is produced by the bundled resvg WebAssembly rasterizer, with Source Sans 3 for Mermaid text and the faces embedded in a D2 SVG. It does not open a browser or read system fonts, so the same SVG produces the same PNG on Windows, macOS, and Linux. Omit `--png` when only the SVG and HTML are needed.

The Harness accepts a deliberately restricted subset of each source language, rather than every feature in upstream Mermaid or D2. Use plain Mermaid flow or state syntax without author-controlled directives, clicks, styles, or HTML. Use plain D2 nodes, labels, containers, and connections without imports, configuration, variables, links, icons, or markup. Harness owns renderer options and TALA seeds. A rejected feature is an explicit unsupported-input result; simplify the view rather than bypassing validation or installing another renderer during the task.

## Inspect existing facts and flows

```bash
ae diagrams graph --root src/orders/service.ts --operation deps --depth 2 --limit 40 --json
ae diagrams graph --root src/orders/service.ts --operation dependents --depth 2 --limit 40 --json
ae diagrams flow --flow order-recovery --json
```

Dependency views reuse the current worktree import query. Read coverage, unresolved imports, clipping, and other limitations before interpreting missing edges. Current worktree bytes may differ from feature HEAD and from the default branch. This is an import graph, not a complete codebase or architecture extractor.

Flow views reuse the published model from [flow-models.md](flow-models.md); they do not author or regenerate one. Its baseline is the locally observed committed default branch, not dirty files or an unseen remote tip. Preserve the returned generation and freshness when explaining it. An absent or stale model is not repaired by rendering. Regeneration is a separate explicit source-inspection and publication procedure.

## Replay recorded formal evidence

Use a retained AE formal-check receipt inside the workspace and select the exact module recorded in it:

```bash
ae diagrams formal --file evidence/formal-verification.json --model UnsafeDeliveryEvidence.tla --png --json
```

The command reads framed TLC stdout already in that receipt. It runs no Java, TLC, JAR, shell, installer or remote service, and accepts no executable view module. It uses the same bundled renderer and artifact publication as other diagrams. AE's native evidence compiler is informed by Lauren Tan's pstack `/statechart` architecture; no upstream parser, runner or view implementation ships in AE.

Violating runs retain every witness state occurrence and transition. Temporal failures keep their back edge or stuttering witness. Expected safety/liveness negative controls are labeled `expected-negative-control`; an unexpected model failure and a mismatched control are labeled separately. Even when a violating run retained a partial graph, its witness remains the default view so an infinite behavior is not lost. A receipt's old `passed` field cannot turn a view into fresh verification.

A positive run can draw its exported explored graph. For a product checker based on the current formal-check starter, request `--capture-graph` on that existing checker command. This deliberately uses its already configured Java/TLC; it does not install tools or rerun a modified model. The same model invocation writes `Module.graph.dot` next to `formal-verification.json`, referenced by a hash and complete/partial exploration label. Copy both files when moving the bundle. Existing copied product runners require their ordinary reviewed maintenance update before using the new option.

The graph reader preserves concrete checker IDs, distinct same-label states, initial states and distinct transitions. Only identical duplicate transition triples are coalesced. States remain neutral: no unchecked state is colored safe, and no rule-specific marks are inferred. Complete coverage requires completed positive output, an empty exploration queue and matching recorded state count. A partial graph is explicitly partial. No state merging, executable label view, parallel region abstraction, or hidden transition is performed. A positive receipt without an exported graph refuses with capture guidance; a `.tla` file alone is not a source of explored states.

Keep `recordedTool`, `recordedSource`, the original receipt hash, exact file bindings, recorded expectation, and reported source freshness when explaining the view. `current` means recorded bound bytes still match, `stale` means they changed, and `unknown` means relevant files are unavailable. The retained trace remains inspectable when its current correspondence is stale or unknown. Newly added writers outside the recorded inventory are not detected. The producer's `<copied-runner>` identity is retained as provenance; it is not interpreted as a workspace filename or compared with the viewer's installed runner.

Only framed stdout and a selected hash-bound graph are interpreted. Stderr presence is recorded as diagnostic context and its text is not rendered. Missing/truncated frames, damaged values, inconsistent state variables, absent temporal loops and cancellation refuse a chart. TLC values remain opaque text; large integers, intervals, sets and functions are never numerically converted or evaluated. The default limit is 50 states; `--max-nodes` can raise it to 200. States and counterexample paths are never silently clipped. Input receipts remain bounded to 1 MiB, selected stdout and graph input to 512 KiB each, and covered source observations to 16 MiB. Graphs permit at most 2,000 distinct transitions.

The output remains `authority: descriptive-context` and `verification: not-verified`. It visualizes recorded model evidence and does not authenticate that evidence, prove model/code equivalence, or satisfy a named correctness check. Reproduce a modeled product bug against real code through the selected verification recipe.

## Review artifacts and freshness

A successful creation returns an `id` and `artifacts` paths for `svg`, `html`, `receipt`, and `png` when `--png` was set. The text report prints the absolute SVG, HTML, receipt, and PNG paths, plus one line on how to open them. The default output is an immutable directory under `.harness/diagrams/<id>/`. Open the self-contained HTML or SVG and inspect labels, boundaries, crossings, and clipping. Use the PNG where a page cannot show SVG. Keep the source as the editable input; rendered output is a derived artifact.

```bash
ae diagrams status --receipt .harness/diagrams/<id>/receipt.json --json
```

Use the returned receipt path rather than constructing an identity. Status rechecks the retained artifacts and the relevant source bindings. Changed or missing evidence must remain visible; a successful old render is not evidence of current source. Open the canonical SVG or HTML path returned in `artifacts`; there is no diagram-specific output destination flag.

Report the view's purpose, input scope, authored versus extracted provenance, currentness, omissions, and artifact paths. If the diagram conflicts with accepted intent, preserve the finding and follow the ordinary amendment or defect workflow. Diagrams never accept requirements, grant mutation authority, satisfy correctness checks, or upgrade a descriptive statechart into TLA+ proof. Deep model checking remains in the selected product verification recipe.

## Human review tour

Use `ae review tour --packet <id> --file <file> --json` after current internal review and verification. Harness generates source-bound Mermaid Markdown and SVG from the authored context graph. Follow this schema 1 shape, replacing every example path, line, and symbol with inspected current code:

```json
{
  "schema": 1,
  "packet": "<current review packet ID>",
  "purpose": "Persist and return the request result.",
  "before": "The result was discarded.",
  "after": "The result is saved and returned.",
  "context": {
    "summary": "The request uses the existing storage boundary.",
    "components": [
      {"id":"request","label":"Request","role":"changed","source":{"path":"src.js","line":1,"symbol":"run"}},
      {"id":"store","label":"Store","role":"context","source":{"path":"store.js","line":1,"symbol":"save"}}
    ],
    "edges": [
      {"from":"request","to":"store","claim":"Saves result","kind":"observed","evidence":[{"path":"src.js","line":1,"symbol":"save"}]}
    ]
  },
  "readingOrder": [{"step":"Follow the request into storage, then inspect its assertion.","component":"request","code":[{"path":"src.js","line":1,"symbol":"run"}],"tests":[{"path":"test.js","line":1,"symbol":"assert.equal"}]}],
  "verification": [{"claim":"The assertion checks the returned value; execution evidence is recorded separately.","refs":[{"path":"test.js","line":1,"symbol":"assert.equal"}]}],
  "risks": ["Operational storage availability requires separate evidence."],
  "questions": ["Is the storage failure behavior acceptable?"]
}
```

Every component needs a unique ID, `changed|context` role, and regular product-source reference. Every edge names existing components, is `observed|inferred`, and cites evidence. The reading order must cover every changed source and test in the review packet. Optional `symbol` must occur at the stated line. Empty risks/questions arrays are allowed when justified. These references bind source bytes, not a claim that tests ran; use actual Harness verification receipts for that claim. Additional state or sequence views use the diagram operations above when they clarify the behavior.

Changed head, packet, context bytes, or tour artifacts invalidate freshness. Refresh after repairs. Present the returned Markdown/SVG alongside the code reading path for human review. A current tour helps explain a change; it cannot establish independent review, formal proof, human acceptance, merge, or release authority.
