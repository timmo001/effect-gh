import { Deferred, Effect, Layer, Predicate, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { layer, type Gh } from "../src/gh.js";

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

/** A spawner that answers each command with the next stdout, capturing argv and stdin. */
export const scriptedSpawner = (
  outputs: ReadonlyArray<{
    readonly stdout: string;
    readonly exitCode?: number;
  }>,
) => {
  const commands: Array<ChildProcess.Command> = [];
  const stdins: Array<string> = [];

  const spawn = (command: ChildProcess.Command) =>
    Effect.sync(() => {
      const index = commands.push(command) - 1;
      const output = outputs[index] ?? { stdout: "" };
      stdins[index] = "";

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(index + 1),
        exitCode: Effect.succeed(
          ChildProcessSpawner.ExitCode(output.exitCode ?? 0),
        ),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => {
            stdins[index] += new TextDecoder().decode(chunk);
          }),
        ),
        stdout: textStream(output.stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    });

  const provide = <A, E>(effect: Effect.Effect<A, E, Gh>) =>
    effect.pipe(
      Effect.provide(
        layer().pipe(
          Layer.provide(
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(spawn),
            ),
          ),
        ),
      ),
    );

  return {
    commands,
    stdins,
    args: () =>
      commands.map((command) =>
        Predicate.isTagged(command, "StandardCommand") ? command.args : [],
      ),
    /** Run an operation against these outputs. */
    run: <A, E>(effect: Effect.Effect<A, E, Gh>) =>
      Effect.runPromise(provide(effect)),
    /** Run an operation expected to fail and return its error. */
    fail: <A, E>(effect: Effect.Effect<A, E, Gh>) =>
      Effect.runPromise(provide(effect).pipe(Effect.flip)),
  };
};
