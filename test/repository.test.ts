import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { GhDecodeError } from "../src/errors.js";
import { layer } from "../src/gh.js";
import * as Repository from "../src/repository.js";
import { fakeSpawner, textStream } from "./helpers.js";

const repository = {
  nameWithOwner: "owner/repo",
  url: "https://github.com/owner/repo",
  defaultBranchRef: { name: "main" },
  isPrivate: false,
};

test.each([undefined, "enterprise.example/owner/repo", "--help", "owner/a b"])(
  "repository view keeps selector literal: %s",
  async (repo) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* fakeSpawner({
          stdout: textStream(JSON.stringify(repository)),
        });

        const operation = Repository.view(repo, {
          executable: "custom-gh",
          cwd: "/workspace",
          env: { CUSTOM: "value" },
        }).pipe(Effect.provide(layer().pipe(Layer.provide(fake.layer))));

        expect(fake.commands).toHaveLength(0);
        expect(yield* operation).toEqual(repository);
        expect(fake.commands).toHaveLength(1);
        const command = fake.commands[0];

        if (command?._tag !== "StandardCommand")
          throw new Error("Expected a standard command");
        expect(command.command).toBe("custom-gh");
        expect(command.args).toEqual([
          "repo",
          "view",
          "--json",
          "nameWithOwner,url,defaultBranchRef,isPrivate",
          ...(repo === undefined ? [] : ["--", repo]),
        ]);
        expect(command.options).toMatchObject({
          cwd: "/workspace",
          shell: false,
          env: { CUSTOM: "value" },
        });
      }),
    );
  },
);

test("repository view accepts a null default branch", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const empty = { ...repository, defaultBranchRef: null };

      const fake = yield* fakeSpawner({
        stdout: textStream(JSON.stringify(empty)),
      });

      expect(
        yield* Repository.view().pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
        ),
      ).toEqual(empty);
    }),
  );
});

test.each([
  "not json",
  JSON.stringify({ ...repository, isPrivate: "false" }),
  JSON.stringify({ ...repository, defaultBranchRef: {} }),
])("repository view rejects invalid output: %s", async (stdout) => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({ stdout: textStream(stdout) });
      expect(
        yield* Repository.view().pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
          Effect.flip,
        ),
      ).toBeInstanceOf(GhDecodeError);
    }),
  );
});

test("repository view propagates command failure before decoding", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({
        stderr: textStream("repository not found"),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
      });

      const error = yield* Repository.view("owner/missing").pipe(
        Effect.provide(layer().pipe(Layer.provide(fake.layer))),
        Effect.flip,
      );

      expect(error._tag).toBe("GhCommandError");
      expect(error).toMatchObject({
        exitCode: 1,
        stderr: "repository not found",
      });
    }),
  );
});
