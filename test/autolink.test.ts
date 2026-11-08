import { expect, test } from "bun:test";
import * as Autolink from "../src/autolink.js";
import { scriptedSpawner } from "./helpers.js";

const autolink = {
  id: 1,
  isAlphanumeric: true,
  keyPrefix: "TICKET-",
  urlTemplate: "https://example.com/TICKET?query=<num>",
};

test("list returns no autolinks when gh prints nothing", async () => {
  const gh = scriptedSpawner([{ stdout: "" }]);

  expect(await gh.run(Autolink.list({ repo: "owner/repo" }))).toEqual([]);
});

test("create, remove, list and view pass the expected argv", async () => {
  const gh = scriptedSpawner([
    { stdout: "" },
    { stdout: "" },
    { stdout: JSON.stringify([autolink]) },
    { stdout: JSON.stringify(autolink) },
  ]);

  await gh.run(
    Autolink.create({
      repo: "owner/repo",
      keyPrefix: "TICKET-",
      urlTemplate: autolink.urlTemplate,
      numeric: true,
    }),
  );
  await gh.run(Autolink.remove({ repo: "owner/repo", id: 1 }));
  expect(await gh.run(Autolink.list({ repo: "owner/repo" }))).toEqual([
    autolink,
  ]);
  expect(await gh.run(Autolink.view({ id: 1 }))).toEqual(autolink);
  expect(gh.args()).toEqual([
    [
      "repo",
      "autolink",
      "create",
      "--repo",
      "owner/repo",
      "--numeric",
      "--",
      "TICKET-",
      "https://example.com/TICKET?query=<num>",
    ],
    ["repo", "autolink", "delete", "--repo", "owner/repo", "--yes", "--", "1"],
    [
      "repo",
      "autolink",
      "list",
      "--repo",
      "owner/repo",
      "--json",
      "id,isAlphanumeric,keyPrefix,urlTemplate",
    ],
    [
      "repo",
      "autolink",
      "view",
      "--json",
      "id,isAlphanumeric,keyPrefix,urlTemplate",
      "--",
      "1",
    ],
  ]);
});
