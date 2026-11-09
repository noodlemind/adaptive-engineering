# Bundled runtime libraries

AE distributes the following unmodified libraries inside its npm archive. Their
complete license and notice files remain in the corresponding dependency folder.

| Library | Version | License | Shipped license and notices |
| --- | --- | --- | --- |
| [Pele](https://github.com/obsidianmd/pele) | 1.8.0 | MIT | `node_modules/pele/LICENSE` |
| [D2 JavaScript/WASM](https://github.com/d2lang/d2) | 0.1.34 | MPL-2.0 | `node_modules/@d2lang/d2/LICENSE.txt`, `node_modules/@d2lang/d2/THIRD_PARTY_NOTICES.txt` |
| [resvg-wasm](https://github.com/yisibl/resvg-js) | 2.6.2 | MPL-2.0 | `node_modules/@resvg/resvg-wasm/package.json`, `node_modules/@resvg/resvg-wasm/README.md` |
| [Source Sans 3](https://github.com/adobe-fonts/source-sans) | 3.052 | SIL OFL 1.1 | `lib/diagrams/fonts/LICENSE.md` |
| [yaml](https://github.com/eemeli/yaml) | See bundled package manifest | ISC | `node_modules/yaml/LICENSE` |

The D2 package includes its upstream worker, WebAssembly, runtime and third-party
notices. Source for the bundled release is available from the D2 upstream project
and its published npm package. AE does not modify those library files.

resvg-wasm is the pure WebAssembly build used to write optional PNG files. It
does not load system fonts. Source Sans 3 Regular, Bold, and Italic are shipped
unmodified for Mermaid text. D2 SVGs also carry their own subset faces, which
AE decodes from the SVG before rasterizing. AE does not modify those font files.
The reserved font name Source stays with Adobe.

Optional tree-sitter packages retain their own upstream licenses. They are not
required for the bundled diagram renderers.

## pstack design reference

Lauren Tan's pstack `/statechart` skill informed the reader-facing report of AE's
own Node-only state-model checker: a shortest path for each broken rule, a chart
that marks where a rule breaks, and plain-word state labels. AE does not bundle
any pstack source, TLC runner, tool installer or view code.

Upstream reference:
<https://github.com/cursor/plugins/tree/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe/pstack/skills/statechart>
