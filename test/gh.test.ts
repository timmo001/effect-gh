import { expect, test } from "bun:test";
import { NodeServices } from "@effect/platform-node";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  PlatformError,
  Predicate,
  Schema,
  SchemaTransformation,
  Sink,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  Gh,
  GhChunk,
  GhDecodeError,
  GhTimeoutError,
  layer,
  type GhError,
} from "../src/index.js";
import { fakeSpawner, textStream } from "./helpers.js";

test("construction is lazy, captures the spawner and passes literal argv and options", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner();

      const gh = yield* Gh.pipe(
        Effect.provide(
          layer({
            executable: "custom-gh",
            cwd: "/default",
            env: { GH_TOKEN: "test-token", KEEP: "yes" },
          }).pipe(Layer.provide(fake.layer)),
        ),
      );

      const args = [
        "api",
        "$(touch nope)",
        "a b",
        ";",
        "--raw-field",
        "body=hello\nworld",
      ];

      const execute = gh.execute(args, {
        cwd: "/override",
        env: { OTHER: "yes", GH_PROMPT_DISABLED: "0" },
      });

      const stream = gh.stream(args);
      expect(fake.commands).toHaveLength(0);
      yield* execute;
      yield* Stream.runDrain(stream);
      expect(fake.commands).toHaveLength(2);
      const command = fake.commands[0];

      if (command?._tag !== "StandardCommand")
        throw new Error("Expected a standard command");
      expect(command.command).toBe("custom-gh");
      expect(command.args).toEqual(args);
      expect(command.options).toMatchObject({
        cwd: "/override",
        shell: false,
        extendEnv: true,
        stdin: "ignore",
        env: {
          GH_TOKEN: "test-token",
          KEEP: "yes",
          OTHER: "yes",
          GH_PROMPT_DISABLED: "1",
        },
      });
      expect(fake.releases()).toBe(2);
    }),
  );
});

test("nonzero exit follows both pipes and retains bounded trailing stderr", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({
        stdout: textStream("output"),
        stderr: textStream("e".repeat(70_000) + "end"),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(7)),
      });

      const gh = yield* Gh.pipe(
        Effect.provide(layer().pipe(Layer.provide(fake.layer))),
      );

      const chunks: Array<string> = [];

      const error = yield* gh.stream([]).pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            chunks.push(chunk.text);
          }),
        ),
        Effect.flip,
      );

      expect(chunks).toContain("output");
      expect(chunks.join("")).toContain("end");
      expect(error._tag).toBe("GhCommandError");

      if (!Predicate.isTagged(error, "GhCommandError"))
        throw new Error("Expected command failure");
      expect(error.exitCode).toBe(7);
      expect(error.stderr).toHaveLength(65_536);
      expect(error.stderr.endsWith("end")).toBe(true);
      expect(error.stderrTruncated).toBe(true);
      expect(fake.releases()).toBe(1);
    }),
  );
});

test("JSON decodes through Schema, preserving decoding services", async () => {
  class Prefix extends Context.Service<Prefix, { readonly value: string }>()(
    "test/Prefix",
  ) {}

  const schema = Schema.String.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect({
        decode: (value) => Effect.map(Prefix, (prefix) => prefix.value + value),
        encode: (value) => Effect.succeed(value),
      }),
    ),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({ stdout: textStream('"value"') });

      const gh = yield* Gh.pipe(
        Effect.provide(layer().pipe(Layer.provide(fake.layer))),
      );

      const decoded: Effect.Effect<string, GhError, Prefix> = gh.json(
        [],
        schema,
      );

      expect(
        yield* decoded.pipe(
          Effect.provideService(Prefix, { value: "prefix-" }),
        ),
      ).toBe("prefix-value");
    }),
  );
});

test.each(["not JSON", '{"name":42}'])(
  "JSON rejects malformed or mismatched output: %s",
  async (stdout) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* fakeSpawner({ stdout: textStream(stdout) });

        const gh = yield* Gh.pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
        );

        expect(
          yield* gh
            .json([], Schema.Struct({ name: Schema.String }))
            .pipe(Effect.flip),
        ).toBeInstanceOf(GhDecodeError);
      }),
    );
  },
);

test.each(["execute", "stream"] as const)(
  "%s timeout closes the child scope",
  async (method) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* fakeSpawner({
          stdout: Stream.never,
          exitCode: Effect.never,
        });

        const gh = yield* Gh.pipe(
          Effect.provide(
            layer({ timeout: "5 seconds" }).pipe(Layer.provide(fake.layer)),
          ),
        );

        const run =
          method === "execute"
            ? gh.execute([]).pipe(Effect.asVoid)
            : Stream.runDrain(gh.stream([]));

        const fiber = yield* run.pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(fake.spawned);
        yield* TestClock.adjust("5 seconds");
        expect(yield* Fiber.join(fiber)).toBeInstanceOf(GhTimeoutError);
        expect(fake.releases()).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  },
);

test("interruption and early stream termination finalise the child", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({
        stdout: textStream("ready").pipe(Stream.concat(Stream.never)),
        exitCode: Effect.never,
      });

      const gh = yield* Gh.pipe(
        Effect.provide(layer().pipe(Layer.provide(fake.layer))),
      );

      const fiber = yield* gh.execute([]).pipe(Effect.forkChild);
      yield* Deferred.await(fake.spawned);
      yield* Fiber.interrupt(fiber);
      expect(fake.releases()).toBe(1);

      const chunks = yield* gh
        .stream([])
        .pipe(Stream.take(1), Stream.runCollect);

      expect(chunks).toEqual([GhChunk.cases.Stdout.make({ text: "ready" })]);
      expect(fake.releases()).toBe(2);
    }),
  );
});

test("platform failures stay typed", async () => {
  const cause = PlatformError.systemError({
    module: "ChildProcess",
    method: "spawn",
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- systemError requires the reason tag in its options.
    _tag: "NotFound",
    description: "missing executable",
  });

  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.fail(cause)),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const gh = yield* Gh;
      const error = yield* gh.execute([]).pipe(Effect.flip);
      expect(error._tag).toBe("GhPlatformError");
      expect(error.cause).toEqual(cause);
    }).pipe(Effect.provide(layer().pipe(Layer.provide(spawner)))),
  );
});

test.each(["stdout", "stderr", "stdin", "exitCode"] as const)(
  "%s failures remain typed and finalise the child",
  async (operation) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const cause = PlatformError.systemError({
          module: "ChildProcess",
          method: operation,
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- systemError requires the reason tag in its options.
          _tag: "Unknown",
        });

        const output = operation === "exitCode" ? Stream.empty : Stream.never;

        const fake = yield* fakeSpawner({
          stdout: operation === "stdout" ? Stream.fail(cause) : output,
          stderr: operation === "stderr" ? Stream.fail(cause) : Stream.empty,
          stdin: operation === "stdin" ? Sink.fail(cause) : Sink.drain,
          exitCode:
            operation === "exitCode"
              ? Effect.fail(cause)
              : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        });

        const gh = yield* Gh.pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
        );

        const error = yield* gh
          .execute([], { stdin: "input" })
          .pipe(Effect.flip);

        expect(error._tag).toBe("GhPlatformError");
        expect(error.cause).toEqual(cause);
        expect(fake.releases()).toBe(1);
      }),
    );
  },
);

test("UTF-8 decoding keeps split characters intact and waits for exit after EOF", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const drained = yield* Deferred.make<void>();
      const encoded = new TextEncoder().encode("世界");

      const fake = yield* fakeSpawner({
        stdout: Stream.make(
          encoded.slice(0, 1),
          encoded.slice(1, 4),
          encoded.slice(4),
        ),
        exitCode: Deferred.await(exit),
      });

      const gh = yield* Gh.pipe(
        Effect.provide(layer().pipe(Layer.provide(fake.layer))),
      );

      let text = "";

      const fiber = yield* gh.stream([]).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            text += chunk.text;

            if (text === "世界") yield* Deferred.succeed(drained, undefined);
          }),
        ),
        Effect.forkChild,
      );

      yield* Deferred.await(drained);
      expect(fake.releases()).toBe(0);
      yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0));
      yield* Fiber.join(fiber);
      expect(text).toBe("世界");
      expect(fake.releases()).toBe(1);
    }),
  );
});

test("stream timeout is total elapsed time, even when output arrives", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const emitted = yield* Deferred.make<void>();

      const fake = yield* fakeSpawner({
        stdout: Stream.fromEffect(
          Effect.sleep("3 seconds").pipe(
            Effect.as(new TextEncoder().encode("progress")),
          ),
        ).pipe(Stream.concat(Stream.never)),
        exitCode: Effect.never,
      });

      const gh = yield* Gh.pipe(
        Effect.provide(
          layer({ timeout: "5 seconds" }).pipe(Layer.provide(fake.layer)),
        ),
      );

      const fiber = yield* gh.stream([]).pipe(
        Stream.runForEach(() => Deferred.succeed(emitted, undefined)),
        Effect.flip,
        Effect.forkChild,
      );

      yield* Deferred.await(fake.spawned);
      yield* TestClock.adjust("3 seconds");
      yield* Deferred.await(emitted);
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(fiber)).toBeInstanceOf(GhTimeoutError);
      expect(fake.releases()).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("per-call timeout overrides the layer and null disables it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const fake = yield* fakeSpawner({ exitCode: Deferred.await(exit) });

      const gh = yield* Gh.pipe(
        Effect.provide(
          layer({ timeout: "1 second" }).pipe(Layer.provide(fake.layer)),
        ),
      );

      const unlimited = yield* gh
        .execute([], { timeout: null })
        .pipe(Effect.forkChild);

      yield* Deferred.await(fake.spawned);
      yield* TestClock.adjust("10 seconds");
      expect(fake.releases()).toBe(0);
      yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0));
      expect((yield* Fiber.join(unlimited)).exitCode).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

const fixture = new URL("./fixtures/child.ts", import.meta.url).pathname;

const native = layer({ executable: process.execPath }).pipe(
  Layer.provide(NodeServices.layer),
);

test("real subprocess inherits environment and receives literal argv, cwd and stdin", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const gh = yield* Gh;

      const result = yield* gh.json(
        [fixture, "inspect", "a b", "$(no-shell)", ";"],
        Schema.Struct({
          args: Schema.Array(Schema.String),
          cwd: Schema.String,
          token: Schema.String,
          path: Schema.NonEmptyString,
          prompt: Schema.String,
          pager: Schema.String,
          tty: Schema.Null,
          stdin: Schema.String,
        }),
        {
          cwd: import.meta.dir,
          env: { GH_TOKEN: "fixture-token" },
          stdin: "hello\n世界",
        },
      );

      expect(result).toMatchObject({
        args: ["a b", "$(no-shell)", ";"],
        cwd: import.meta.dir,
        token: "fixture-token",
        prompt: "1",
        pager: "cat",
        tty: null,
        stdin: "hello\n世界",
      });
    }).pipe(Effect.provide(native)),
  );
});

test("real subprocess drains both full pipes and trailing output", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const gh = yield* Gh;

      const output = yield* gh.execute([fixture, "pipes"], {
        timeout: "5 seconds",
      });

      expect(output).toEqual({
        stdout: "o".repeat(32 * 8192) + "trailing output",
        stderr: "e".repeat(32 * 8192) + "trailing error",
        exitCode: 0,
      });
    }).pipe(Effect.provide(native)),
  );
});

test("early stream cancellation terminates the real child before returning", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handles: Array<ChildProcessSpawner.ChildProcessHandle> = [];

      const observed = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          spawner.spawn(command).pipe(
            Effect.tap((handle) =>
              Effect.sync(() => {
                handles.push(handle);
              }),
            ),
          ),
        ),
      );

      const gh = yield* Gh.pipe(
        Effect.provide(
          layer({ executable: process.execPath }).pipe(Layer.provide(observed)),
        ),
      );

      const chunks = yield* gh
        .stream([fixture, "wait"])
        .pipe(Stream.take(1), Stream.runCollect);

      expect(chunks).toEqual([GhChunk.cases.Stdout.make({ text: "ready" })]);
      expect(handles).toHaveLength(1);

      for (const handle of handles) expect(yield* handle.isRunning).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

test.each(["interruption", "timeout"] as const)(
  "real execute %s terminates the child before returning",
  async (operation) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const handles: Array<ChildProcessSpawner.ChildProcessHandle> = [];

        const observed = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            spawner.spawn(command).pipe(
              Effect.map((handle) => {
                handles.push(handle);

                return ChildProcessSpawner.makeHandle({
                  ...handle,
                  stdout: handle.stdout.pipe(
                    Stream.tap(() => Deferred.succeed(ready, undefined)),
                  ),
                });
              }),
            ),
          ),
        );

        const gh = yield* Gh.pipe(
          Effect.provide(
            layer({ executable: process.execPath }).pipe(
              Layer.provide(observed),
            ),
          ),
        );

        const fiber = yield* gh
          .execute([fixture, "wait"], { timeout: "5 seconds" })
          .pipe(Effect.flip, Effect.forkChild);

        yield* Deferred.await(ready);

        if (operation === "interruption") {
          yield* Fiber.interrupt(fiber);
        } else {
          yield* TestClock.adjust("5 seconds");
          expect(yield* Fiber.join(fiber)).toBeInstanceOf(GhTimeoutError);
        }

        expect(handles).toHaveLength(1);

        for (const handle of handles)
          expect(yield* handle.isRunning).toBe(false);
      }).pipe(
        Effect.provide(Layer.merge(NodeServices.layer, TestClock.layer())),
      ),
    );
  },
);
