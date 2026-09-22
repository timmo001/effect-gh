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
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  GhCommandError,
  GhDecodeError,
  GhPlatformError,
  GhTimeoutError,
  type GhError,
} from "./errors.js";

export interface GhOptions {
  readonly executable?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Explicit undefined clears stdin inherited from the layer. */
  readonly stdin?: string | Uint8Array | undefined;
  /** Total subprocess duration, including output draining. Null disables a layer timeout. */
  readonly timeout?: Duration.Input | null;
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
}

export class Gh extends Context.Service<Gh, Interface>()(
  "@timmo001/effect-gh/Gh",
) {}

const stderrLimit = 65_536;

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

        let stderr = "";
        let stderrTruncated = false;

        const output = Stream.merge(
          handle.stdout.pipe(
            Stream.decodeText(),
            Stream.map((text) => GhChunk.cases.Stdout.make({ text })),
          ),
          handle.stderr.pipe(
            Stream.decodeText(),
            Stream.map((text) => {
              stderrTruncated ||= stderr.length + text.length > stderrLimit;
              stderr = (stderr + text).slice(-stderrLimit);

              return GhChunk.cases.Stderr.make({ text });
            }),
          ),
        ).pipe(
          Stream.mapError(
            (cause) => new GhPlatformError({ executable, cause }),
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
              stderr,
              stderrTruncated,
            });
          }
        });

        const completed = output.pipe(
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

      return Gh.of({ execute, json, stream });
    }),
  );
