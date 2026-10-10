import {
  Context,
  Duration,
  Effect,
  Layer,
  Match,
  Predicate,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  GhCommandError,
  GhDecodeError,
  GhOutputLimitError,
  GhPlatformError,
  GhTimeoutError,
  type GhError,
} from "./errors.js";
import { retryTransient } from "./transient.js";

export interface GhOptions {
  readonly executable?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Explicit undefined clears stdin inherited from the layer. */
  readonly stdin?: string | Uint8Array | undefined;
  /** Total subprocess duration, including output draining. Null disables a layer timeout. */
  readonly timeout?: Duration.Input | null;
  /** Stop the command with GhOutputLimitError once stdout passes this many bytes. */
  readonly maxOutputBytes?: number;
}

export const GhOutput = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Int,
});

export interface GhOutput extends Schema.Schema.Type<typeof GhOutput> {}

export const GhChunk = Schema.TaggedUnion({
  Stdout: { text: Schema.String },
  Stderr: { text: Schema.String },
});

export type GhChunk = typeof GhChunk.Type;

export interface Interface {
  readonly execute: (
    args: ReadonlyArray<string>,
    options?: GhOptions,
  ) => Effect.Effect<GhOutput, GhError>;
  readonly json: <S extends Schema.Constraint>(
    args: ReadonlyArray<string>,
    schema: S,
    options?: GhOptions,
  ) => Effect.Effect<S["Type"], GhError, S["DecodingServices"]>;
  readonly stream: (
    args: ReadonlyArray<string>,
    options?: GhOptions,
  ) => Stream.Stream<GhChunk, GhError>;
  /**
   * Run with the terminal's stdin, stdout and stderr so gh and git can prompt.
   * Output is not captured; a non-zero exit fails with GhCommandError.
   */
  readonly interactive: (
    args: ReadonlyArray<string>,
    options?: Omit<GhOptions, "stdin" | "maxOutputBytes">,
  ) => Effect.Effect<void, GhError>;
}

export class Gh extends Context.Service<Gh, Interface>()(
  "@timmo001/effect-gh/Gh",
) {
  /** Retries transient `gh` failures with bounded, jittered backoff. See {@link retryTransient}. */
  static readonly retryTransient = retryTransient;
}

const outputLimit = 65_536;

export const layer = (
  defaults: GhOptions = {},
): Layer.Layer<Gh, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(
    Gh,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const open = Effect.fn("Gh.stream")(function* (
        args: ReadonlyArray<string>,
        options: GhOptions,
      ) {
        const executable = options.executable ?? "gh";

        const handle = yield* spawner
          .spawn(
            ChildProcess.make(executable, args, {
              cwd: options.cwd,
              env: {
                ...defaults.env,
                ...options.env,
                GH_PROMPT_DISABLED: "1",
                GH_PAGER: "cat",
                PAGER: "cat",
                NO_COLOR: "1",
                CLICOLOR: "0",
                CLICOLOR_FORCE: "0",
                GH_FORCE_TTY: undefined,
                GH_SPINNER_DISABLED: "1",
              },
              extendEnv: true,
              shell: false,
              stdin: options.stdin === undefined ? "ignore" : "pipe",
              stdout: "pipe",
              stderr: "pipe",
              forceKillAfter: "1 second",
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) => new GhPlatformError({ executable, cause }),
            ),
          );

        let stdout = "";
        let stdoutTruncated = false;
        let stderr = "";
        let stderrTruncated = false;

        const output = Stream.merge(
          handle.stdout.pipe(
            Stream.decodeText(),
            Stream.map((text) => {
              stdoutTruncated ||= stdout.length + text.length > outputLimit;
              stdout = (stdout + text).slice(-outputLimit);

              return GhChunk.cases.Stdout.make({ text });
            }),
          ),
          handle.stderr.pipe(
            Stream.decodeText(),
            Stream.map((text) => {
              stderrTruncated ||= stderr.length + text.length > outputLimit;
              stderr = (stderr + text).slice(-outputLimit);

              return GhChunk.cases.Stderr.make({ text });
            }),
          ),
        ).pipe(
          Stream.mapError(
            (cause) => new GhPlatformError({ executable, cause }),
          ),
        );

        const limitBytes = options.maxOutputBytes;

        const limited =
          limitBytes === undefined
            ? output
            : output.pipe(
                Stream.mapAccumEffect(
                  () => 0,
                  (bytes, chunk) => {
                    const total = Predicate.isTagged(chunk, "Stdout")
                      ? bytes + new TextEncoder().encode(chunk.text).byteLength
                      : bytes;

                    return total > limitBytes
                      ? Effect.fail(
                          new GhOutputLimitError({ executable, limitBytes }),
                        )
                      : Effect.succeed([total, [chunk]] as const);
                  },
                ),
              );

        const completion = Effect.gen(function* () {
          const exitCode = yield* handle.exitCode.pipe(
            Effect.mapError(
              (cause) => new GhPlatformError({ executable, cause }),
            ),
          );

          if (exitCode !== 0) {
            return yield* new GhCommandError({
              executable,
              exitCode,
              stdout,
              stdoutTruncated,
              stderr,
              stderrTruncated,
            });
          }
        });

        const completed = limited.pipe(
          Stream.concat(Stream.fromEffect(completion).pipe(Stream.drain)),
        );

        if (options.stdin === undefined) return completed;

        const input = Predicate.isString(options.stdin)
          ? new TextEncoder().encode(options.stdin)
          : options.stdin;

        return completed.pipe(
          Stream.mergeEffect(
            Stream.run(Stream.succeed(input), handle.stdin).pipe(
              Effect.mapError(
                (cause) => new GhPlatformError({ executable, cause }),
              ),
            ),
          ),
        );
      });

      const stream: Interface["stream"] = (args, overrides) =>
        Stream.suspend(() => {
          const options = { ...defaults, ...overrides };
          const output = Stream.unwrap(open(args, options));

          if (options.timeout == null) return output;

          if (!Duration.isFinite(Duration.fromInputUnsafe(options.timeout)))
            return output;
          const timeoutMs = Duration.toMillis(options.timeout);

          return output.pipe(
            Stream.mergeEffect(
              Effect.sleep(options.timeout).pipe(
                Effect.andThen(
                  Effect.fail(
                    new GhTimeoutError({
                      executable: options.executable ?? "gh",
                      timeoutMs,
                    }),
                  ),
                ),
              ),
            ),
          );
        });

      const execute = Effect.fn("Gh.execute")(function* (
        args: ReadonlyArray<string>,
        options?: GhOptions,
      ) {
        return yield* stream(args, options).pipe(
          Stream.runFold(
            () => ({ stdout: "", stderr: "", exitCode: 0 }) satisfies GhOutput,
            (output, chunk) =>
              Match.value(chunk).pipe(
                Match.tag("Stdout", ({ text }) => ({
                  ...output,
                  stdout: output.stdout + text,
                })),
                Match.tag("Stderr", ({ text }) => ({
                  ...output,
                  stderr: output.stderr + text,
                })),
                Match.exhaustive,
              ),
          ),
        );
      });

      const json = Effect.fn("Gh.json")(function* <S extends Schema.Constraint>(
        args: ReadonlyArray<string>,
        schema: S,
        options?: GhOptions,
      ) {
        const output = yield* execute(args, options);

        return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
          output.stdout,
        ).pipe(Effect.mapError((cause) => new GhDecodeError({ cause })));
      });

      const interactive = Effect.fn("Gh.interactive")(function* (
        args: ReadonlyArray<string>,
        overrides?: Omit<GhOptions, "stdin" | "maxOutputBytes">,
      ) {
        const options = { ...defaults, ...overrides };
        const executable = options.executable ?? "gh";

        const run = Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(executable, args, {
                cwd: options.cwd,
                env: { ...defaults.env, ...options.env },
                extendEnv: true,
                shell: false,
                stdin: "inherit",
                stdout: "inherit",
                stderr: "inherit",
                forceKillAfter: "1 second",
              }),
            );

            return yield* handle.exitCode;
          }),
        ).pipe(
          Effect.mapError(
            (cause) => new GhPlatformError({ executable, cause }),
          ),
          Effect.flatMap((exitCode) =>
            exitCode === 0
              ? Effect.void
              : Effect.fail(
                  new GhCommandError({
                    executable,
                    exitCode,
                    stdout: "",
                    stdoutTruncated: false,
                    stderr: "",
                    stderrTruncated: false,
                  }),
                ),
          ),
        );

        if (
          options.timeout == null ||
          !Duration.isFinite(Duration.fromInputUnsafe(options.timeout))
        )
          return yield* run;

        const timeoutMs = Duration.toMillis(options.timeout);

        return yield* run.pipe(
          Effect.timeoutOrElse({
            duration: options.timeout,
            orElse: () =>
              Effect.fail(new GhTimeoutError({ executable, timeoutMs })),
          }),
        );
      });

      return Gh.of({ execute, json, stream, interactive });
    }),
  );
