# effect-gh

An Effect v4 SDK for the GitHub CLI (`gh`).

Inspired by the Effect-native API in
[dmmulroy/herdr-ts-sdk](https://github.com/dmmulroy/herdr-ts-sdk), with tooling
based on [herdr-workflow-watch](https://github.com/timmo001/herdr-workflow-watch)
and [dotfiles](https://github.com/timmo001/dotfiles).

## Core SDK

`Gh` is the service tag. `layer(options?)` captures the consumer-provided
`ChildProcessSpawner` and starts no processes until an operation runs. Consumers
choose their platform layer and runtime. For example, with `@effect/platform-node`:

```ts
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
import { Gh, layer } from "@timmo001/effect-gh";

const ghLayer = layer({ timeout: "30 seconds" }).pipe(
  Layer.provide(NodeServices.layer),
);

const program = Effect.gen(function* () {
  const gh = yield* Gh;
  return yield* gh.json(
    ["api", "user"],
    Schema.Struct({ login: Schema.String }),
  );
}).pipe(Effect.provide(ghLayer));
```

- `execute(args, options?)` returns `{ stdout, stderr, exitCode }` on exit zero.
  It buffers both UTF-8 outputs in memory, so use `stream` for large output.
- `json(args, schema, options?)` decodes stdout as JSON through the supplied
  Schema, preserving its decoding service requirements. Supply any `--json`
  fields required by the selected `gh` command yourself.
- `stream(args, options?)` emits `{ _tag: "Stdout" | "Stderr", text }` chunks.
  It drains both pipes concurrently with backpressure and preserves order within
  each pipe, with no ordering guarantee between pipes. Chunk boundaries are not
  line boundaries. Completion waits for both pipes and a successful exit.

`GhOptions` accepts `executable` (default `gh`), `cwd`, `env`, `stdin` (string or
`Uint8Array`) and `timeout` (an Effect duration). Call options override layer
defaults; environment entries merge. `timeout: null` disables a layer timeout.
Timeouts cover spawning, execution and output draining, rather than idle time.
There is no timeout by default. Schema decoding runs after the subprocess timeout.

Commands pass literal argv without a shell. The platform inherits the environment,
including existing `gh` authentication and configuration. Supplied environment
entries override inherited values; `undefined` removes a value. The SDK always
disables prompts, colour, forced TTY and spinners, and selects `cat` as the pager.
Stdin is closed unless supplied explicitly. No operation is automatically retried.

Errors are tagged `GhCommandError` (nonzero exit with exit code and stderr),
`GhPlatformError` (spawn or pipe failure), `GhTimeoutError`, or `GhDecodeError`
(invalid JSON or a schema mismatch). Command errors retain only the last 65,536
UTF-16 code units of stderr and flag truncation with `stderrTruncated`.
The stream emits trailing output before reporting a nonzero exit.

Interruption, timeout and early stream termination close the child scope. The
platform terminates the child, escalating after one second if needed. An early
consumer stop does not validate the final exit code. Interruptions remain Effect
interruptions rather than being converted into SDK errors.

## API requests

`Api.raw(request)` returns buffered output, including empty or non-JSON responses.
`Api.json(request, schema)` decodes one JSON response. Every request specifies a
method, which the SDK passes explicitly to `gh api`.

```ts
import { Api } from "@timmo001/effect-gh";
import { Schema } from "effect";

const viewer = Api.json(
  { endpoint: "user", method: "GET" },
  Schema.Struct({ login: Schema.String }),
);

const subscription = Api.raw({
  endpoint: "notifications/threads/123/subscription",
  method: "PUT",
  body: { ignored: true },
});
```

Requests accept `hostname`, `headers`, `query`, a JSON `body`, and core overrides
under `options`. Query values are URL-encoded; arrays repeat the key. JSON bodies
go through stdin rather than CLI field interpolation. Bodyless calls clear any
layer-level stdin.

`Api.pages(request, pageSchema)` runs a bodyless REST GET with
`--paginate --slurp`. The result is an array of decoded **pages**, not flattened
items: use an array schema for array endpoints, or an object schema for envelopes
such as `{ workflow_runs: [...] }`. It buffers all pages and does not provide a
snapshot-consistency guarantee. GraphQL cursor pagination remains available
through the raw `Gh` interface.

### Retries

No SDK operation retries automatically. Mutations can have taken effect even
when the CLI times out or loses the connection. Consumers can apply Effect
`Schedule` and `Effect.retry` to known-idempotent reads with a bounded policy and
their own transient-error classification. Decode errors, authentication failures
and check-status exits are not transient errors. Do not transparently replay a
stream after it has emitted output.

## Development

Use the tool versions pinned in `mise.toml` and Bun for dependencies.

```sh
mise run install
mise run check
mise run build
```

## TODO

- [x] Define the SDK service, layers and typed errors.
- [x] Add scoped `gh` subprocess execution with explicit working directory,
      arguments, environment, cancellation and timeouts.
- [x] Reuse `gh` authentication and decode JSON responses with Effect Schema.
- [x] Wrap `gh api`, including pagination and explicit request methods.
- [ ] Add repository, pull request, issue and workflow operations needed by consumers.
- [ ] Define streaming output and watch operations.
- [x] Define retry behaviour without replaying unsafe mutations.
- [ ] Add focused contract tests and usage examples.
- [ ] Verify compatibility with dotfiles and Herdr Workflow Watch.
- [ ] Prepare package exports, releases and publication.
