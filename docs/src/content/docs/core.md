---
title: Core SDK
description: The Gh service, its layer, options, errors and cancellation.
---

`Gh` is the service tag. `layer(options?)` captures the consumer-provided `ChildProcessSpawner` and starts no processes until an operation runs. You choose the platform layer and the runtime.

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

## Raw methods

- `execute(args, options?)` returns `{ stdout, stderr, exitCode }` on exit zero, buffering both outputs in memory.
- `json(args, schema, options?)` decodes stdout as JSON through the Schema you supply.
- `stream(args, options?)` emits `{ _tag: "Stdout" | "Stderr", text }` chunks with backpressure. Chunk boundaries are not line boundaries.
- `interactive(args, options?)` runs on the terminal's stdin, stdout and stderr, so gh and git can show progress and ask for credentials.

Prefer the typed operations. Reach for the raw methods only for a command the SDK doesn't cover yet.

## Options

`GhOptions` accepts `executable` (default `gh`), `cwd`, `env`, `stdin`, `timeout` and `maxOutputBytes`. Call options override layer defaults, and environment entries merge. There is no timeout by default, and `timeout: null` disables a layer timeout.

Commands pass literal argv without a shell. The SDK always disables prompts, colour, forced TTY and spinners, and selects `cat` as the pager. Stdin is closed unless you supply it. No operation retries automatically.

## Errors

Errors are tagged:

| Error                   | When                                            |
| ----------------------- | ----------------------------------------------- |
| `GhCommandError`        | Nonzero exit, with exit code, stdout and stderr |
| `GhPlatformError`       | Spawn or pipe failure                           |
| `GhTimeoutError`        | The timeout passed                              |
| `GhOutputLimitError`    | Stdout passed `maxOutputBytes`                  |
| `GhDecodeError`         | Invalid JSON or a Schema mismatch               |
| `GhInvalidOptionsError` | Operation options rejected before spawning      |

Command errors keep the last 65,536 UTF-16 code units of each output and flag truncation with `stdoutTruncated` and `stderrTruncated`.

## Cancellation

Interruption, timeout and early stream termination close the child scope. The platform terminates the child, escalating after one second if needed. Interruptions stay Effect interruptions rather than becoming SDK errors.
