# Documentation site

The Markdown files are the only source. `scripts/build-docs.mjs` copies the published pages into a Jekyll site and rewrites their relative links: a link to another published page becomes a site link, and any other repository link points to the file on GitHub. The repository identity and base path come from the workflow context.

To add a page, list it in `scripts/build-docs.mjs` and in the pull-request paths of `.github/workflows/docs.yml`, and add it to the navigation in `_layouts/default.html` if it should appear there. CI checks that the two lists match.

Pull requests build a site artifact. To publish, enable Pages with the GitHub Actions source and run the **Documentation** workflow with publication selected. See [GitHub's custom workflow instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Releasing the package

The **AE package candidate** workflow keeps the exact archive, npm integrity record and SHA-256 for each operating system. Qualify one archive, then publish those same bytes with `npm publish <archive.tgz> --access public`; do not repack between qualification and publication. Create the matching version tag and GitHub release with the same archive and checksum, and state native platform gaps. `npm view ae-harness@<version> dist.integrity` must match the packed integrity.

Publication needs a chosen license (the package is `UNLICENSED` until then), control of the `ae-harness` npm name, and npm publishing credentials or a trusted publisher for this repository.
