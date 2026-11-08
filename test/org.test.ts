import { expect, test } from "bun:test";
import * as Org from "../src/org.js";
import * as Status from "../src/status.js";
import { scriptedSpawner } from "./helpers.js";

test("org list returns logins and status passes its filters", async () => {
  const gh = scriptedSpawner([
    { stdout: "cli\nnode\n" },
    { stdout: "Assigned Issues\n" },
  ]);

  expect(await gh.run(Org.list({ limit: 100 }))).toEqual(["cli", "node"]);
  expect(
    await gh.run(Status.get({ exclude: ["cli/cli", "cli/go-gh"], org: "cli" })),
  ).toBe("Assigned Issues\n");
  expect(gh.args()).toEqual([
    ["org", "list", "--limit", "100"],
    ["status", "--exclude", "cli/cli,cli/go-gh", "--org", "cli"],
  ]);
});
