# effect-gh

An Effect v4 SDK for the GitHub CLI (`gh`).

Repository scaffold only. Inspired by the Effect-native API in
[dmmulroy/herdr-ts-sdk](https://github.com/dmmulroy/herdr-ts-sdk), with tooling
based on [herdr-workflow-watch](https://github.com/timmo001/herdr-workflow-watch)
and [dotfiles](https://github.com/timmo001/dotfiles).

## Development

Use the tool versions pinned in `mise.toml` and Bun for dependencies.

```sh
mise run install
mise run check
mise run build
```

## TODO

- [ ] Define the SDK service, layers and typed errors.
- [ ] Add scoped `gh` subprocess execution with explicit working directory,
      arguments, environment, cancellation and timeouts.
- [ ] Reuse `gh` authentication and decode JSON responses with Effect Schema.
- [ ] Wrap `gh api`, including pagination and explicit request methods.
- [ ] Add repository, pull request, issue and workflow operations needed by consumers.
- [ ] Define streaming output and watch operations.
- [ ] Define retry behaviour without replaying unsafe mutations.
- [ ] Add focused contract tests and usage examples.
- [ ] Verify compatibility with dotfiles and Herdr Workflow Watch.
- [ ] Prepare package exports, releases and publication.
