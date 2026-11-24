---
title: Development
description: Run the checks, review gh and gh-stack tooling drift and release the package.
---

Use the tool versions pinned in `mise.toml` and Bun for dependencies.

```sh
mise run check ::: build
```

## Docs

```sh
mise run docs:dev
mise run docs:check
```

`docs:dev` runs the dev server, and `docs:check` checks the pages, links and types in an isolated folder so it doesn't clash with a running dev server. Run `bun run brand` in `docs` to regenerate the logo PNGs and the GitHub social preview from `src/assets/logo.svg`.

## Tooling drift

`tooling.yml` records the gh release the SDK was last reviewed against, and `tooling/gh` holds a snapshot of the help and `--json` fields of every wrapped command at that release. Upkeep's [`drift` job](https://upkeep.timmo.dev/running#drift) flags when a newer [cli/cli](https://github.com/cli/cli/releases) release appears.

To review a new release, run `mise run tooling:refresh <tag>`, review the diff against the wrappers in `src/`, then set `reviewed` in `tooling.yml` and push. Add a command to the list in `scripts/gh-contract.ts` when the SDK starts wrapping it.

The [gh-stack](https://github.com/github/gh-stack) extension behind `Stack` is tracked the same way, in `tooling/gh-stack`, refreshed with `mise run tooling:refresh:stack <tag>`. Besides the help of every `gh stack` command, its `source.txt` holds what no help page shows: the `view --json` structure, the exit codes and how `sync` reports its end. The refresh fails when that source no longer matches.

## Releases

Run `mise exec -- npm pack --dry-run` to inspect the package locally. For a release, set the package version, keep `bun.lock` in sync and pass `mise run check` and `mise run build`. Commit and push the reviewed version, then publish a GitHub release with a tag matching the version exactly. The release workflow validates and builds the package, then publishes to npm with provenance.
