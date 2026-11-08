# effect-gh

Effect v4 SDK for the GitHub CLI. The README documents usage and development.

## Tooling

- Use mise-pinned tools and Bun. Keep `bun.lock` in sync with `package.json`.
- Use `mise run format`, `mise run check` and `mise run build` for validation.
- `src/index.ts` is the package entrypoint; `dist/` is generated and untracked.
- `tooling.yml` records the reviewed gh release and `tooling/gh/` its command snapshot.
  Upkeep's [`drift` job](https://upkeep.timmo.dev/running#drift) checks for new
  releases. Regenerate the snapshot with `mise run tooling:refresh <tag>`, never by
  hand, record a review by setting `reviewed` in `tooling.yml` and pushing, and add
  new wrapped commands to `scripts/gh-contract.ts`.
- Use lowercase filenames, with kebab-case for multiword names.
- Use the shared `@timmo001/oxlint-rules/configs/recommended-effect` preset and
  its supported Oxlint peers.

## SDK conventions

- Use Effect v4 services and layers, Schema at JSON boundaries and typed errors.
- Keep effects lazy; consumers own the runtime and platform layers.
- Scope subprocess resources and cancellation. Pass arguments without a shell.
- Keep dependencies explicit and avoid unsafe assertions and `any`.
- Add modules and tests when real behaviour needs them.

## OpenCode plugin

- `opencode-plugin/` ships the SDK as OpenCode's `gh` Code Mode namespace. It is
  private, kept out of the npm and JSR packages, and installs on its own with the
  `effect` version `@opencode/plugin` pins, against a published SDK release.
  OpenCode installs plugins with its bundled npm, which can't prepare git
  dependencies, so never depend on the SDK from GitHub. A plugin tool for a new
  SDK command waits for the release that ships it.
- When the SDK wraps a new command, consider a tool for it in
  `opencode-plugin/src/gh.ts`. Keep the namespace and existing tool names stable.
