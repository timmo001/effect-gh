import { Deferred, Effect, Layer, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export const fakeSpawner = Effect.fn("test.fakeSpawner")(function* (
  overrides: Partial<ChildProcessSpawner.ChildProcessHandle> = {},
) {
  const spawned = yield* Deferred.make<void>();
  const commands: Array<ChildProcess.Command> = [];
  let releases = 0;
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
    ...overrides,
  });
  const spawn = Effect.fn("test.spawn")(function* (
    command: ChildProcess.Command,
  ) {
    return yield* Effect.acquireRelease(
      Effect.sync(() => {
        commands.push(command);
        return handle;
      }).pipe(Effect.tap(() => Deferred.succeed(spawned, undefined))),
      () =>
        Effect.sync(() => {
          releases++;
        }),
    );
  });
  return {
    commands,
    spawned,
    releases: () => releases,
    layer: Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(spawn),
    ),
  };
});

export const textStream = (text: string) =>
  Stream.succeed(new TextEncoder().encode(text));
