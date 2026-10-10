import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { layer } from "../src/gh.js";
import * as Release from "../src/release.js";
import { fakeSpawner, textStream } from "./helpers.js";

const failing = (stderr: string) =>
  fakeSpawner({
    stderr: textStream(stderr),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
  });

test("exists is true for a release and false only when gh reports it missing", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const found = yield* fakeSpawner({
        stdout: textStream(JSON.stringify({ tagName: "v1" })),
      });

      const missing = yield* failing("release not found");
      const denied = yield* failing("HTTP 403: Resource not accessible");
      const input = { repo: "owner/repo", tag: "v1" };

      expect(
        yield* Release.exists(input).pipe(
          Effect.provide(layer().pipe(Layer.provide(found.layer))),
        ),
      ).toBe(true);
      expect(
        yield* Release.exists(input).pipe(
          Effect.provide(layer().pipe(Layer.provide(missing.layer))),
        ),
      ).toBe(false);
      expect(
        (yield* Release.exists(input).pipe(
          Effect.provide(layer().pipe(Layer.provide(denied.layer))),
          Effect.flip,
        ))._tag,
      ).toBe("GhCommandError");
    }),
  );
});

test("create passes assets after the tag and settings as flags", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({
        stdout: textStream("https://github.com/owner/repo/releases/tag/v1\n"),
      });

      expect(
        yield* Release.create({
          repo: "owner/repo",
          tag: "v1",
          assets: ["dist/a.tar.gz"],
          title: "v1",
          target: "abc123",
          prerelease: true,
        }).pipe(Effect.provide(layer().pipe(Layer.provide(fake.layer)))),
      ).toEqual({ url: "https://github.com/owner/repo/releases/tag/v1" });
      expect(fake.commands[0]).toMatchObject({
        args: [
          "release",
          "create",
          "v1",
          "dist/a.tar.gz",
          "--repo",
          "owner/repo",
          "--title",
          "v1",
          "--target",
          "abc123",
          "--prerelease=true",
        ],
      });
    }),
  );
});
