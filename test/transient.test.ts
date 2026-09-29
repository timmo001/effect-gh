import { expect, test } from "bun:test";
import { Cache, Effect, Layer, Option, Schedule } from "effect";
import { ChildProcessSpawner } from "effect/process";
import {
  GhCommandError,
  GhDecodeError,
  GhPlatformError,
  GhTimeoutError,
  type GhError,
} from "../src/errors.js";
import { Gh, layer } from "../src/gh.js";
import * as RateLimit from "../src/rate-limit.js";
import { httpStatus, isRateLimited, isTransient } from "../src/transient.js";
import { fakeSpawner, textStream } from "./helpers.js";

const commandError = (stderr: string, stdout = "") =>
  new GhCommandError({
    executable: "gh",
    exitCode: 1,
    stdout,
    stdoutTruncated: false,
    stderr,
    stderrTruncated: false,
  });

test("classifies transient and permanent gh failures", () => {
  const cases: ReadonlyArray<readonly [GhError, boolean]> = [
    [commandError("gh: Server Error (HTTP 502)"), true],
    [commandError("gh: Service Unavailable (HTTP 503)"), true],
    [commandError("gh: Too Many Requests (HTTP 429)"), true],
    [
      commandError(
        "gh: API rate limit exceeded for user ID 1. (HTTP 403)",
        '{"message":"API rate limit exceeded"}',
      ),
      true,
    ],
    [
      commandError(
        "error connecting to api.github.com\ncheck your internet connection",
      ),
      true,
    ],
    [commandError("dial tcp: lookup api.github.com: no such host"), true],
    [commandError("net/http: TLS handshake timeout"), true],
    [commandError("gh: Not Found (HTTP 404)"), false],
    [commandError("gh: Bad credentials (HTTP 401)"), false],
    [commandError("gh: Forbidden (HTTP 403)", '{"id":502,"timeout":1}'), false],
    [new GhTimeoutError({ executable: "gh", timeoutMs: 1000 }), true],
    [
      new GhPlatformError({ executable: "gh", cause: new Error("ENOENT") }),
      false,
    ],
    [new GhDecodeError({ cause: new Error("bad json") }), false],
  ];

  for (const [error, expected] of cases) {
    expect([error, isTransient(error)]).toEqual([error, expected]);
  }

  expect(isRateLimited(commandError("gh: Too Many Requests (HTTP 429)"))).toBe(
    true,
  );
  expect(isRateLimited(commandError("gh: Server Error (HTTP 502)"))).toBe(
    false,
  );
  expect(httpStatus(commandError("gh: Not Found (HTTP 404)"))).toEqual(
    Option.some(404),
  );
  expect(httpStatus(commandError("plain failure"))).toEqual(Option.none());
});

test("retryTransient retries transient failures up to the limit and stops on permanent ones", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const immediate = { schedule: Schedule.spaced("0 millis"), times: 2 };
      let transientAttempts = 0;

      const transient = yield* Effect.suspend(() => {
        transientAttempts++;

        return Effect.fail(commandError("gh: Bad Gateway (HTTP 502)"));
      }).pipe(Gh.retryTransient(immediate), Effect.flip);

      expect(transient._tag).toBe("GhCommandError");
      expect(transientAttempts).toBe(3);

      let permanentAttempts = 0;

      yield* Effect.suspend(() => {
        permanentAttempts++;

        return Effect.fail(commandError("gh: Not Found (HTTP 404)"));
      }).pipe(Gh.retryTransient(immediate), Effect.flip);

      expect(permanentAttempts).toBe(1);

      let recoveredAttempts = 0;

      const recovered = yield* Effect.suspend(() => {
        recoveredAttempts++;

        return recoveredAttempts < 2
          ? Effect.fail(new GhTimeoutError({ executable: "gh", timeoutMs: 1 }))
          : Effect.succeed("ok");
      }).pipe(Gh.retryTransient(immediate));

      expect(recovered).toBe("ok");
    }),
  );
});

const rateLimitBody = JSON.stringify({
  resources: {
    core: { limit: 5000, used: 10, remaining: 4990, reset: 1_790_000_000 },
    graphql: { limit: 5000, used: 0, remaining: 5000, reset: 1_790_000_000 },
    search: { limit: 30, used: 1, remaining: 29, reset: 1_790_000_000 },
  },
});

test("RateLimit.cached reads the selected quota once and does not keep failures", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const ok = yield* fakeSpawner({ stdout: textStream(rateLimitBody) });

      const cache = yield* RateLimit.cached("1 minute").pipe(
        Effect.provide(layer().pipe(Layer.provide(ok.layer))),
      );

      expect((yield* Cache.get(cache, "core")).remaining).toBe(4990);
      expect((yield* Cache.get(cache, "core")).remaining).toBe(4990);
      expect((yield* Cache.get(cache, "search")).remaining).toBe(29);
      expect(ok.commands).toHaveLength(2);

      yield* Cache.invalidate(cache, "core");
      yield* Cache.get(cache, "core");
      expect(ok.commands).toHaveLength(3);

      const failing = yield* fakeSpawner({
        stderr: textStream("gh: Server Error (HTTP 500)"),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
      });

      const failingCache = yield* RateLimit.cached("1 minute").pipe(
        Effect.provide(layer().pipe(Layer.provide(failing.layer))),
      );

      yield* Cache.get(failingCache, "core").pipe(Effect.flip);
      yield* Cache.get(failingCache, "core").pipe(Effect.flip);
      expect(failing.commands).toHaveLength(2);
    }),
  );
});
