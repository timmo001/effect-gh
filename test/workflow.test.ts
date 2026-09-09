import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  GhCommandError,
  GhDecodeError,
  GhTimeoutError,
} from "../src/errors.js";
import { layer, type GhChunk } from "../src/gh.js";
import * as Workflow from "../src/workflow.js";
import { fakeSpawner, textStream } from "./helpers.js";

const fields =
  "databaseId,attempt,headBranch,headSha,status,conclusion,url,workflowName";
const run = {
  databaseId: 123,
  attempt: 2,
  headBranch: "main",
  headSha: "abc123",
  status: "in_progress",
  conclusion: "",
  url: "https://github.com/owner/repo/actions/runs/123",
  workflowName: "Build",
};

test("list is lazy and sends bounded branch and commit filters literally", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({
        stdout: textStream(JSON.stringify([run])),
      });
      const request = Workflow.list({
        repo: "github.example/owner/repo",
        branch: "feature/$(literal)",
        commit: "abc123",
        workflow: "build.yml",
        status: "in_progress",
        limit: 5,
      });
      expect(fake.commands).toHaveLength(0);
      expect(
        yield* request.pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
        ),
      ).toEqual([run]);
      expect(fake.commands[0]).toMatchObject({
        args: [
          "run",
          "list",
          "--repo",
          "github.example/owner/repo",
          "--limit",
          "5",
          "--json",
          fields,
          "--branch",
          "feature/$(literal)",
          "--commit",
          "abc123",
          "--workflow",
          "build.yml",
          "--status",
          "in_progress",
        ],
      });
    }),
  );
});

test("list defaults to twenty runs and accepts empty results", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({ stdout: textStream("[]") });
      expect(
        yield* Workflow.list({ repo: "owner/repo" }).pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
        ),
      ).toEqual([]);
      expect(fake.commands[0]).toMatchObject({
        args: [
          "run",
          "list",
          "--repo",
          "owner/repo",
          "--limit",
          "20",
          "--json",
          fields,
        ],
      });
    }),
  );
});

test("view decodes nullable fields and selects an explicit attempt", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const nullable = {
        ...run,
        headBranch: null,
        conclusion: null,
        workflowName: null,
      };
      const fake = yield* fakeSpawner({
        stdout: textStream(JSON.stringify(nullable)),
      });
      expect(
        yield* Workflow.view({
          repo: "owner/repo",
          runId: 123,
          attempt: 2,
        }).pipe(Effect.provide(layer().pipe(Layer.provide(fake.layer)))),
      ).toEqual(nullable);
      expect(fake.commands[0]).toMatchObject({
        args: [
          "run",
          "view",
          "123",
          "--repo",
          "owner/repo",
          "--json",
          fields,
          "--attempt",
          "2",
        ],
      });
    }),
  );
});

test.each([false, true])(
  "logs preserve attempt and job selection with failedOnly=%s",
  async (failedOnly) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* fakeSpawner({
          stdout: textStream("build\tstep\tfailed\n"),
          stderr: textStream("diagnostic"),
        });
        expect(
          yield* Workflow.logs({
            repo: "owner/repo",
            runId: 123,
            attempt: 2,
            failedOnly,
            job: 456,
          }).pipe(Effect.provide(layer().pipe(Layer.provide(fake.layer)))),
        ).toBe("build\tstep\tfailed\n");
        expect(fake.commands[0]).toMatchObject({
          args: [
            "run",
            "view",
            "123",
            "--repo",
            "owner/repo",
            failedOnly ? "--log-failed" : "--log",
            "--attempt",
            "2",
            "--job",
            "456",
          ],
        });
      }),
    );
  },
);

test.each([
  "not json",
  JSON.stringify({ ...run, attempt: "2" }),
  JSON.stringify({ ...run, databaseId: -1 }),
])("invalid run output remains a decode failure: %s", async (stdout) => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({ stdout: textStream(stdout) });
      const error = yield* Workflow.view({
        repo: "owner/repo",
        runId: 123,
      }).pipe(
        Effect.provide(layer().pipe(Layer.provide(fake.layer))),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(GhDecodeError);
    }),
  );
});

test("nonzero list, view and logs exits propagate without decoding", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({
        stdout: textStream("not json"),
        stderr: textStream("forbidden"),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(4)),
      });
      const provided = layer().pipe(Layer.provide(fake.layer));
      for (const request of [
        Workflow.list({ repo: "owner/repo" }).pipe(Effect.asVoid),
        Workflow.view({ repo: "owner/repo", runId: 123 }).pipe(Effect.asVoid),
        Workflow.logs({ repo: "owner/repo", runId: 123 }).pipe(Effect.asVoid),
      ]) {
        const error = yield* request.pipe(
          Effect.provide(provided),
          Effect.flip,
        );
        expect(error).toBeInstanceOf(GhCommandError);
        expect(error).toMatchObject({ exitCode: 4, stderr: "forbidden" });
      }
      expect(fake.commands).toHaveLength(3);
      expect(fake.releases()).toBe(3);
    }),
  );
});

test.each([
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
])("invalid numeric options fail before spawning: %s", async (invalid) => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner();
      const provided = layer().pipe(Layer.provide(fake.layer));
      const requests = [
        Workflow.list({ repo: "owner/repo", limit: invalid }),
        Workflow.view({ repo: "owner/repo", runId: invalid }),
        Workflow.view({ repo: "owner/repo", runId: 123, attempt: invalid }),
        Workflow.logs({ repo: "owner/repo", runId: 123, job: invalid }),
        Stream.runDrain(Workflow.watch({ repo: "owner/repo", runId: invalid })),
        Stream.runDrain(
          Workflow.watch({ repo: "owner/repo", runId: 123, interval: invalid }),
        ),
      ];
      for (const request of requests) {
        expect(
          yield* request.pipe(Effect.provide(provided), Effect.flip),
        ).toBeInstanceOf(Workflow.InvalidOptions);
      }
      expect(fake.commands).toHaveLength(0);
    }),
  );
});

test("option-like run IDs and implicit repositories are rejected at runtime", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner();
      // @ts-expect-error Exercise callers that bypass the TypeScript contract.
      const invalidId = Workflow.view({ repo: "owner/repo", runId: "--web" });
      for (const request of [
        invalidId.pipe(Effect.asVoid),
        Workflow.list({ repo: "" }).pipe(Effect.asVoid),
        Workflow.list({ repo: "--help" }).pipe(Effect.asVoid),
      ]) {
        expect(
          yield* request.pipe(
            Effect.provide(layer().pipe(Layer.provide(fake.layer))),
            Effect.flip,
          ),
        ).toBeInstanceOf(Workflow.InvalidOptions);
      }
      expect(fake.commands).toHaveLength(0);
    }),
  );
});

test("watch emits both tagged pipes before failed exit, without retrying", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({
        stdout: textStream("building"),
        stderr: textStream("failed"),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
      });
      const chunks: Array<GhChunk> = [];
      const stream = Workflow.watch({
        repo: "owner/repo",
        runId: 123,
        interval: 5,
      });
      expect(fake.commands).toHaveLength(0);
      const error = yield* stream.pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            chunks.push(chunk);
          }),
        ),
        Effect.provide(layer().pipe(Layer.provide(fake.layer))),
        Effect.flip,
      );
      expect(chunks).toContainEqual({ _tag: "Stdout", text: "building" });
      expect(chunks).toContainEqual({ _tag: "Stderr", text: "failed" });
      expect(error).toBeInstanceOf(GhCommandError);
      expect(error).toMatchObject({ exitCode: 1, stderr: "failed" });
      expect(fake.commands).toHaveLength(1);
      expect(fake.commands[0]).toMatchObject({
        args: [
          "run",
          "watch",
          "123",
          "--repo",
          "owner/repo",
          "--compact",
          "--exit-status",
          "--interval",
          "5",
        ],
      });
      expect(fake.releases()).toBe(1);
    }),
  );
});

test("early watch cancellation finalises the child and defaults to a three-second interval", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({
        stdout: textStream("ready").pipe(Stream.concat(Stream.never)),
        exitCode: Effect.never,
      });
      const chunks = yield* Workflow.watch({
        repo: "owner/repo",
        runId: 123,
      }).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.provide(layer().pipe(Layer.provide(fake.layer))),
      );
      expect(chunks).toEqual([{ _tag: "Stdout", text: "ready" }]);
      expect(fake.commands[0]).toMatchObject({
        args: [
          "run",
          "watch",
          "123",
          "--repo",
          "owner/repo",
          "--compact",
          "--exit-status",
          "--interval",
          "3",
        ],
      });
      expect(fake.releases()).toBe(1);
    }),
  );
});

test.each([false, true])(
  "watch inherits the core timeout unless disabled=%s",
  async (disabled) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const fake = yield* fakeSpawner({ exitCode: Deferred.await(exit) });
        const fiber = yield* Workflow.watch(
          { repo: "owner/repo", runId: 123 },
          disabled ? { timeout: null } : undefined,
        ).pipe(
          Stream.runDrain,
          Effect.provide(
            layer({ timeout: "1 second" }).pipe(Layer.provide(fake.layer)),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(fake.spawned);
        yield* TestClock.adjust("2 seconds");
        if (disabled) {
          expect(fake.releases()).toBe(0);
          yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0));
          yield* Fiber.join(fiber);
        } else {
          expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toBeInstanceOf(
            GhTimeoutError,
          );
        }
        expect(fake.releases()).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  },
);
