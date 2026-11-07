# Repository binding and investigation scope

`ae orient` reports the Git root actually bound to the command and the project
store selected by AE's existing home and storage-alias resolver. It does not
discover saved workspaces, inspect neighboring repositories, or prepare a domain
draft. This behavior also applies to the session-start orientation slice.

```json
{
  "boundRoot": "/work/repo-a",
  "projectStore": "/home/user/.ae/projects/github.com-team-repo-a-01234567",
  "kind": "monorepo",
  "markers": ["pnpm-workspace.yaml"],
  "workspaceType": "none",
  "workspaceFile": null,
  "roots": [],
  "domainSuggestion": null
}
```

The existing layout keys remain available for clients. `workspaceType: none`
means AE has not observed an editor workspace; it does not assert that the
editor has only one folder. `boundRoot` is the canonical Git toplevel of the
explicit `--workspace` directory or command cwd. `projectStore` names the actual
selected store, including a preserved storage alias. It is null when storage
identity is unavailable. Reporting a path does not create the directory or
grant authority to read or write its records. A non-repository has an unknown
root and classification.

## Local classification

`kind` is `monorepo` or `product-repo`. Classification reads only bounded marker
files at the bound root. Markers include package workspaces, pnpm, Lerna, Nx,
Turborepo, Bazel, multiple Gradle includes, and Maven modules. These are layout
signals, not a complete build graph. A one-module Gradle project remains a
product repo; `includeBuild` does not turn another Git checkout into task scope.

Packages inside one Git root share its project identity. Classification does
not create one store per package or select an unrelated repository.

## Select the scope of the task

The user request and demonstrated dependencies determine which repositories
need investigation. A saved `.code-workspace`, `.idea/vcs.xml`, directory
neighbor, or monorepo marker does not establish that relevance. When another
repository is needed, inspect its actual path and use the existing explicit
`--workspace` selection. Delegate a narrow question when separate expertise or
coverage is useful; there is no researcher-per-folder rule.

The current hooks do not supply an authenticated live editor folder array.
Unsaved editor folders therefore remain unknown. A future adapter must expose
what it actually observes; filesystem heuristics cannot substitute for that
host contract.

An authored multi-repo domain remains the explicit mechanism for shared intent
and delivery. Use the existing domain commands and reviewed configuration.
Discovery does not create membership, share stores, approve trust, or permit
mutations in another checkout. Plans stay on their bound repository unless an
accepted domain plan supplies the existing separate authority.

## Why implicit discovery was removed

PR #104 recorded an earlier choice to report layout, read saved workspace files,
and print a domain draft. That feature addressed confusion about which
repository an editor session used. Its implementation searched the bound root
and parent, picked the saved workspace containing the most other Git roots,
and directed the Engineer to investigate each root with a researcher.

An inactive saved workspace can contain more folders than the current one.
That selection rule cannot identify the active editor or the repositories
relevant to a task. Caching and caps reduced repeated Git observations but did
not repair the inference. The current design reports the actual binding and
keeps cross-repo work explicit, following the user's reassessment of that
earlier choice.

Regression coverage exercises inactive saved files, unchanged task-context
identity, absence of neighboring probes, selected-home storage aliases, and
installed orientation/adapter output. These checks establish the deterministic
binding behavior. They do not replace a trial in the actual editor host.
