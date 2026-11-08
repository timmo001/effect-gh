import { expect, test } from "bun:test";
import * as Cache from "../src/cache.js";
import { scriptedSpawner } from "./helpers.js";

test("list decodes caches and passes filters as flags", async () => {
  const cache = {
    id: 1234,
    key: "node-modules-abc",
    ref: "refs/heads/main",
    version: "0a1b",
    sizeInBytes: 4096,
    createdAt: "2026-10-26T18:02:47Z",
    lastAccessedAt: "2026-11-01T09:00:00Z",
  };

  const gh = scriptedSpawner([{ stdout: JSON.stringify([cache]) }]);

  expect(
    await gh.run(
      Cache.list({
        repo: "owner/repo",
        limit: 5,
        key: "node-",
        sort: "size_in_bytes",
        order: "asc",
      }),
    ),
  ).toEqual([cache]);
  expect(gh.args()).toEqual([
    [
      "cache",
      "list",
      "--repo",
      "owner/repo",
      "--limit",
      "5",
      "--key",
      "node-",
      "--sort",
      "size_in_bytes",
      "--order",
      "asc",
      "--json",
      "id,key,ref,version,sizeInBytes,createdAt,lastAccessedAt",
    ],
  ]);
});

test("remove deletes by id, by key and ref, or all", async () => {
  const gh = scriptedSpawner([]);

  await gh.run(Cache.remove({ repo: "owner/repo", id: 1234 }));
  await gh.run(Cache.remove({ key: "--all", ref: "refs/heads/main" }));
  await gh.run(Cache.remove({ all: true, succeedOnNoCaches: true }));
  expect(gh.args()).toEqual([
    ["cache", "delete", "--repo", "owner/repo", "--", "1234"],
    ["cache", "delete", "--ref", "refs/heads/main", "--", "--all"],
    ["cache", "delete", "--all", "--succeed-on-no-caches"],
  ]);
});
