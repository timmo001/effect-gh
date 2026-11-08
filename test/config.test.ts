import { expect, test } from "bun:test";
import * as Alias from "../src/alias.js";
import * as Config from "../src/config.js";
import { scriptedSpawner } from "./helpers.js";

test("config commands pass the host and put the key after --", async () => {
  const gh = scriptedSpawner([
    { stdout: "ssh\n" },
    { stdout: "" },
    { stdout: "git_protocol=https\neditor=\nprompt=enabled\n" },
    { stdout: "" },
  ]);

  expect(
    await gh.run(Config.get({ key: "git_protocol", host: "github.com" })),
  ).toBe("ssh");
  await gh.run(Config.set({ key: "editor", value: "vim" }));

  expect(await gh.run(Config.list())).toEqual([
    { key: "git_protocol", value: "https" },
    { key: "editor", value: "" },
    { key: "prompt", value: "enabled" },
  ]);
  await gh.run(Config.clearCache());
  expect(gh.args()).toEqual([
    ["config", "get", "--host", "github.com", "--", "git_protocol"],
    ["config", "set", "--", "editor", "vim"],
    ["config", "list"],
    ["config", "clear-cache"],
  ]);
});

test("alias commands send expansions and YAML on stdin", async () => {
  const gh = scriptedSpawner([]);

  await gh.run(Alias.set({ name: "pv", expansion: "pr view", clobber: true }));
  await gh.run(Alias.remove({ name: "pv" }));
  await gh.run(Alias.remove({ all: true }));
  await gh.run(Alias.importAliases({ file: "aliases.yml" }));
  await gh.run(Alias.importAliases({ yaml: "bugs: issue list\n" }));
  expect(gh.args()).toEqual([
    ["alias", "set", "--clobber", "--", "pv", "-"],
    ["alias", "delete", "--", "pv"],
    ["alias", "delete", "--all"],
    ["alias", "import", "--", "aliases.yml"],
    ["alias", "import", "-"],
  ]);
  expect(gh.stdins[0]).toBe("pr view");
  expect(gh.stdins[4]).toBe("bugs: issue list\n");
});
