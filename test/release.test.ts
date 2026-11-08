import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { layer } from "../src/gh.js";
import * as Release from "../src/release.js";
import { fakeSpawner, scriptedSpawner, textStream } from "./helpers.js";

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

test("list selects its fields and passes filters as flags", async () => {
  const release = {
    tagName: "v1",
    name: "",
    isDraft: true,
    isPrerelease: false,
    isLatest: false,
    isImmutable: false,
    createdAt: "2026-10-26T18:02:47Z",
    publishedAt: "0001-01-01T00:00:00Z",
  };

  const gh = scriptedSpawner([{ stdout: JSON.stringify([release]) }]);

  expect(
    await gh.run(
      Release.list({
        repo: "owner/repo",
        limit: 5,
        excludePrereleases: true,
        order: "asc",
      }),
    ),
  ).toEqual([release]);
  expect(gh.args()).toEqual([
    [
      "release",
      "list",
      "--repo",
      "owner/repo",
      "--limit",
      "5",
      "--exclude-pre-releases",
      "--order",
      "asc",
      "--json",
      "tagName,name,isDraft,isPrerelease,isLatest,isImmutable,createdAt,publishedAt",
    ],
  ]);
});

test("remove and removeAsset skip the prompt", async () => {
  const gh = scriptedSpawner([]);

  await gh.run(Release.remove({ tag: "v1", cleanupTag: true }));
  await gh.run(
    Release.removeAsset({ repo: "owner/repo", tag: "v1", asset: "a.tar.gz" }),
  );
  expect(gh.args()).toEqual([
    ["release", "delete", "v1", "--cleanup-tag", "--yes"],
    [
      "release",
      "delete-asset",
      "v1",
      "a.tar.gz",
      "--repo",
      "owner/repo",
      "--yes",
    ],
  ]);
});
