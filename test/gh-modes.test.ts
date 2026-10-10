import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { Gh, GhCommandError, GhOutputLimitError, layer } from "../src/index.js";
import { fakeSpawner, textStream } from "./helpers.js";

test("maxOutputBytes stops a command whose stdout passes the limit", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({ stdout: textStream("x".repeat(11)) });
      const provide = Effect.provide(layer().pipe(Layer.provide(fake.layer)));

      const error = yield* Gh.pipe(
        Effect.flatMap((gh) =>
          gh.execute(["api", "big"], { maxOutputBytes: 10 }),
        ),
        provide,
        Effect.flip,
      );

      expect(error).toBeInstanceOf(GhOutputLimitError);
      expect(error).toMatchObject({ limitBytes: 10 });
      expect(
        (yield* Gh.pipe(
          Effect.flatMap((gh) =>
            gh.execute(["api", "big"], { maxOutputBytes: 11 }),
          ),
          provide,
        )).stdout,
      ).toHaveLength(11);
    }),
  );
});

test("interactive inherits stdio, allows prompts and fails on a non-zero exit", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const ok = yield* fakeSpawner();

      const failing = yield* fakeSpawner({
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(2)),
      });

      yield* Gh.pipe(
        Effect.flatMap((gh) =>
          gh.interactive(["repo", "clone", "owner/repo", "dir"], {
            env: { GIT_TERMINAL_PROMPT: "1" },
          }),
        ),
        Effect.provide(layer().pipe(Layer.provide(ok.layer))),
      );

      const command = ok.commands[0];

      if (command?._tag !== "StandardCommand")
        throw new Error("Expected a standard command");
      expect(command.options).toMatchObject({
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: { GIT_TERMINAL_PROMPT: "1" },
      });
      expect(command.options.env).not.toHaveProperty("GH_PROMPT_DISABLED");

      const error = yield* Gh.pipe(
        Effect.flatMap((gh) =>
          gh.interactive(["extension", "upgrade", "--all"]),
        ),
        Effect.provide(layer().pipe(Layer.provide(failing.layer))),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(GhCommandError);
      expect(error).toMatchObject({ exitCode: 2 });
    }),
  );
});
