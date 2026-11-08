import { expect, test } from "bun:test";
import * as Template from "../src/template.js";
import { scriptedSpawner } from "./helpers.js";

test("template commands pass the expected argv and return stdout", async () => {
  const gh = scriptedSpawner([
    { stdout: "Go\nNode\n" },
    { stdout: "*.exe\n" },
    { stdout: "mit\tMIT\n" },
    { stdout: "MIT License\n" },
  ]);

  expect(await gh.run(Template.gitignoreList())).toBe("Go\nNode\n");
  expect(await gh.run(Template.gitignoreView({ name: "Go" }))).toBe("*.exe\n");
  expect(await gh.run(Template.licenseList())).toBe("mit\tMIT\n");
  expect(await gh.run(Template.licenseView({ license: "mit" }))).toBe(
    "MIT License\n",
  );
  expect(gh.args()).toEqual([
    ["repo", "gitignore", "list"],
    ["repo", "gitignore", "view", "--", "Go"],
    ["repo", "license", "list"],
    ["repo", "license", "view", "--", "mit"],
  ]);
});
