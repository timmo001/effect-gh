---
title: Install
description: Install effect-gh with Bun or Node and authenticate the GitHub CLI.
---

## Requirements

- Effect matching `peerDependencies.effect` in the package's `package.json`, with a compatible platform adapter of your choosing.
- GitHub CLI 2.97.0 or later, installed and authenticated through `gh auth login` or its standard token environment variables.
- An ESM consumer. Bun runs the TypeScript source directly; Node uses the compiled JavaScript in a built package.

## Bun

Run from your application directory:

```sh
bun add github:timmo001/effect-gh
bun add "effect@$(bun -p 'require("@timmo001/effect-gh/package.json").peerDependencies.effect')" \
  "@effect/platform-node@$(bun -p 'require("@timmo001/effect-gh/package.json").devDependencies["@effect/platform-node"]')"
```

Commit `package.json` and `bun.lock` to keep the resolved GitHub revision and dependency versions. The `bun` export resolves to `src/index.ts`, so a GitHub install needs no build step.

## Node

Build a package from source with the [mise](https://mise.jdx.dev/getting-started.html)-pinned tools:

```sh
git clone https://github.com/timmo001/effect-gh.git .effect-gh
(
  cd .effect-gh &&
    mise install &&
    mise run install &&
    mise exec -- npm pack --pack-destination ..
)
bun add ./timmo001-effect-gh-*.tgz
```

Keep the archive with your application for repeatable installs.

## GitHub authentication

Install [GitHub CLI](https://cli.github.com/) separately, then authenticate:

```sh
gh auth login
gh auth status
```

For automation, supply `GH_TOKEN` or another gh-supported configuration through the environment. The SDK uses it without a separate login.
