import { expect, test } from "bun:test";
import * as Ruleset from "../src/ruleset.js";
import { scriptedSpawner } from "./helpers.js";

test("list, view and check pass the expected argv and return stdout", async () => {
  const gh = scriptedSpawner([
    { stdout: "1\tmain\n" },
    { stdout: "Main\n" },
    { stdout: "no rules\n" },
  ]);

  expect(
    await gh.run(
      Ruleset.list({ repo: "owner/repo", limit: 5, parents: false }),
    ),
  ).toBe("1\tmain\n");
  expect(
    await gh.run(Ruleset.view({ repo: "owner/repo", id: 1, org: "team" })),
  ).toBe("Main\n");
  expect(
    await gh.run(Ruleset.check({ repo: "owner/repo", branch: "dev" })),
  ).toBe("no rules\n");
  await gh.run(Ruleset.check({ default: true }));
  expect(gh.args()).toEqual([
    [
      "ruleset",
      "list",
      "--repo",
      "owner/repo",
      "--limit",
      "5",
      "--parents=false",
    ],
    ["ruleset", "view", "--repo", "owner/repo", "--org", "team", "--", "1"],
    ["ruleset", "check", "--repo", "owner/repo", "--", "dev"],
    ["ruleset", "check", "--default"],
  ]);
});
