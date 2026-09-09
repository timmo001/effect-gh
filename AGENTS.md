# effect-gh

Effect v4 SDK for the GitHub CLI. The README documents usage and development.

## Tooling

- Use mise-pinned tools and Bun. Keep `bun.lock` in sync with `package.json`.
- Use `mise run format`, `mise run check` and `mise run build` for validation.
- `src/index.ts` is the package entrypoint; `dist/` is generated and untracked.
- Use lowercase filenames, with kebab-case for multiword names.
- Use the shared `@timmo001/oxlint-rules/configs/recommended-effect` preset and
  its supported Oxlint peers.

## SDK conventions

- Use Effect v4 services and layers, Schema at JSON boundaries and typed errors.
- Keep effects lazy; consumers own the runtime and platform layers.
- Scope subprocess resources and cancellation. Pass arguments without a shell.
- Keep dependencies explicit and avoid unsafe assertions and `any`.
- Add modules and tests when real behaviour needs them.
