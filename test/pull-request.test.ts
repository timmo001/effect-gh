import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Layer, PlatformError, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  GhCommandError,
  GhDecodeError,
  GhTimeoutError,
} from "../src/errors.js";
import { layer } from "../src/gh.js";
import * as PullRequest from "../src/pull-request.js";
import { fakeSpawner, textStream } from "./helpers.js";

const summary: PullRequest.Summary = {
  number: 42,
  title: "Fix checks",
  url: "https://github.com/owner/repo/pull/42",
  state: "OPEN",
  isDraft: false,
  headRefName: "fix/checks",
  headRefOid: "1234567890abcdef",
};

test("list uses fixed fields and defaults, with literal repository and filter values", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({
        stdout: textStream(JSON.stringify([summary])),
      });
      const ghLayer = layer().pipe(Layer.provide(fake.layer));
      const listing = PullRequest.list({ repository: "owner/repo" });
      expect(fake.commands).toHaveLength(0);
      expect(yield* listing.pipe(Effect.provide(ghLayer))).toEqual([summary]);
      yield* PullRequest.list({
        repository: "--help",
        state: "all",
        limit: 10,
        base: "--web",
        head: "$(touch nope); branch",
        cwd: "/checkout",
        env: { GH_HOST: "github.example.com" },
      }).pipe(Effect.provide(ghLayer));
      const first = fake.commands[0];
      const second = fake.commands[1];
      if (
        first?._tag !== "StandardCommand" ||
        second?._tag !== "StandardCommand"
      )
        throw new Error("Expected standard commands");
      expect(first.args).toEqual([
        "pr",
        "list",
        "--repo=owner/repo",
        "--state=open",
        "--limit=30",
        "--json=number,title,url,state,isDraft,headRefName,headRefOid",
      ]);
      expect(second.args).toEqual([
        "pr",
        "list",
        "--repo=--help",
        "--state=all",
        "--limit=10",
        "--json=number,title,url,state,isDraft,headRefName,headRefOid",
        "--base=--web",
        "--head=$(touch nope); branch",
      ]);
      expect(second.options).toMatchObject({
        shell: false,
        cwd: "/checkout",
        env: { GH_HOST: "github.example.com" },
      });
    }),
  );
});

test.each([
  42,
  "--web",
  "$(touch nope); branch",
  "https://github.com/owner/repo/pull/42",
])("view passes selector %s after the option terminator", async (selector) => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({
        stdout: textStream(JSON.stringify(summary)),
      });
      expect(
        yield* PullRequest.view(selector, { repository: "owner/repo" }).pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
        ),
      ).toEqual(summary);
      const command = fake.commands[0];
      if (command?._tag !== "StandardCommand")
        throw new Error("Expected a standard command");
      expect(command.args).toEqual([
        "pr",
        "view",
        "--repo=owner/repo",
        "--json=number,title,url,state,isDraft,headRefName,headRefOid",
        "--",
        String(selector),
      ]);
      expect(command.options.shell).toBe(false);
    }),
  );
});

test.each([
  { exitCode: 0, bucket: "pass", state: "SUCCESS", status: "success" },
  { exitCode: 1, bucket: "fail", state: "FAILURE", status: "failure" },
  { exitCode: 8, bucket: "pending", state: "IN_PROGRESS", status: "pending" },
] as const)(
  "checks returns structured $status data for exit $exitCode without re-executing",
  async ({ exitCode, bucket, state, status }) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const checks: ReadonlyArray<PullRequest.Check> = [
          {
            name: "build",
            bucket,
            state,
            link: "https://example.com/check",
            workflow: "CI",
          },
          {
            name: "external",
            bucket: "skipping",
            state: "SKIPPED",
            link: null,
            workflow: null,
          },
          {
            name: "cancelled",
            bucket: "cancel",
            state: "CANCELLED",
            link: "",
            workflow: "",
          },
        ];
        const json = JSON.stringify(checks);
        const fake = yield* fakeSpawner({
          stdout: textStream(json.slice(0, 17)).pipe(
            Stream.concat(textStream(json.slice(17))),
          ),
          stderr: textStream("diagnostic output"),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        });
        const result = yield* PullRequest.checks("--web", {
          repository: "owner/repo",
          required: true,
          executable: "custom-gh",
        }).pipe(Effect.provide(layer().pipe(Layer.provide(fake.layer))));
        expect(result).toEqual({ checks, status, exitCode });
        expect(fake.commands).toHaveLength(1);
        const command = fake.commands[0];
        if (command?._tag !== "StandardCommand")
          throw new Error("Expected a standard command");
        expect(command.command).toBe("custom-gh");
        expect(command.args).toEqual([
          "pr",
          "checks",
          "--repo=owner/repo",
          "--json=name,state,bucket,link,workflow",
          "--required",
          "--",
          "--web",
        ]);
        expect(command.options.shell).toBe(false);
        expect(fake.releases()).toBe(1);
      }),
    );
  },
);

test.each(["", "not JSON", '{"message":"Bad credentials"}', '[{"name":42}]'])(
  "checks preserves genuine exit 1 failures for invalid output: %s",
  async (stdout) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* fakeSpawner({
          stdout: textStream(stdout),
          stderr: textStream("authentication failed"),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        });
        const error = yield* PullRequest.checks(42, {
          repository: "owner/repo",
        }).pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
          Effect.flip,
        );
        expect(error).toBeInstanceOf(GhCommandError);
        expect(error).toMatchObject({
          exitCode: 1,
          stderr: "authentication failed",
          stderrTruncated: false,
        });
        expect(fake.commands).toHaveLength(1);
      }),
    );
  },
);

test.each([
  "not JSON",
  '[{"name":42}]',
  '[{"name":"CI","state":"SUCCESS","bucket":"unknown","link":null,"workflow":null}]',
])(
  "checks rejects malformed or invalid successful output: %s",
  async (stdout) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* fakeSpawner({ stdout: textStream(stdout) });
        expect(
          yield* PullRequest.checks(42, { repository: "owner/repo" }).pipe(
            Effect.provide(layer().pipe(Layer.provide(fake.layer))),
            Effect.flip,
          ),
        ).toBeInstanceOf(GhDecodeError);
      }),
    );
  },
);

test("checks preserves unexpected exits and their stderr even with valid JSON", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({
        stdout: textStream("[]"),
        stderr: textStream("unexpected failure"),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(4)),
      });
      expect(
        yield* PullRequest.checks(42, { repository: "owner/repo" }).pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
          Effect.flip,
        ),
      ).toMatchObject({
        _tag: "GhCommandError",
        exitCode: 4,
        stderr: "unexpected failure",
      });
      expect(fake.commands).toHaveLength(1);
    }),
  );
});

test("checks preserves platform errors after valid output", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const cause = PlatformError.systemError({
        module: "ChildProcess",
        method: "exitCode",
        _tag: "Unknown",
      });
      const fake = yield* fakeSpawner({
        stdout: textStream("[]"),
        exitCode: Effect.fail(cause),
      });
      expect(
        yield* PullRequest.checks(42, { repository: "owner/repo" }).pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
          Effect.flip,
        ),
      ).toMatchObject({ _tag: "GhPlatformError", cause });
      expect(fake.releases()).toBe(1);
    }),
  );
});

test.each(["timeout", "interruption"] as const)(
  "checks preserves %s and closes the child",
  async (operation) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* fakeSpawner({
          stdout: textStream("[]"),
          exitCode: Effect.never,
        });
        const fiber = yield* PullRequest.checks(42, {
          repository: "owner/repo",
          timeout: "5 seconds",
        }).pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
          Effect.flip,
          Effect.forkChild,
        );
        yield* Deferred.await(fake.spawned);
        if (operation === "timeout") {
          yield* TestClock.adjust("5 seconds");
          expect(yield* Fiber.join(fiber)).toBeInstanceOf(GhTimeoutError);
        } else {
          yield* Fiber.interrupt(fiber);
        }
        expect(fake.releases()).toBe(1);
        expect(fake.commands).toHaveLength(1);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  },
);
