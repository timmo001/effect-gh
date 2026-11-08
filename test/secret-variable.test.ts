import { expect, test } from "bun:test";
import * as Secret from "../src/secret.js";
import * as Variable from "../src/variable.js";
import { scriptedSpawner } from "./helpers.js";

test("secret list decodes names and selects the level", async () => {
  const secret = {
    name: "TOKEN",
    visibility: "selected",
    numSelectedRepos: 2,
    selectedReposURL:
      "https://api.github.com/orgs/acme/actions/secrets/TOKEN/repositories",
    updatedAt: "2026-10-26T18:02:47Z",
  };

  const gh = scriptedSpawner([{ stdout: JSON.stringify([secret]) }]);

  expect(
    await gh.run(Secret.list({ organization: "acme", app: "dependabot" })),
  ).toEqual([secret]);
  expect(gh.args()).toEqual([
    [
      "secret",
      "list",
      "--org",
      "acme",
      "--app",
      "dependabot",
      "--json",
      "name,visibility,numSelectedRepos,selectedReposURL,updatedAt",
    ],
  ]);
});

test("secret set sends the value through stdin, not argv", async () => {
  const gh = scriptedSpawner([]);

  await gh.run(
    Secret.set({
      organization: "acme",
      name: "TOKEN",
      value: "s3cret",
      visibility: "selected",
      repos: ["a", "b"],
    }),
  );
  await gh.run(
    Secret.set({
      repo: "owner/repo",
      environment: "prod",
      name: "T",
      value: "v",
    }),
  );
  expect(gh.args()).toEqual([
    [
      "secret",
      "set",
      "--org",
      "acme",
      "--visibility",
      "selected",
      "--repos",
      "a,b",
      "--",
      "TOKEN",
    ],
    ["secret", "set", "--repo", "owner/repo", "--env", "prod", "--", "T"],
  ]);
  expect(gh.stdins).toEqual(["s3cret", "v"]);
});

test("secret remove targets the user level", async () => {
  const gh = scriptedSpawner([]);

  await gh.run(Secret.remove({ user: true, name: "TOKEN" }));
  expect(gh.args()).toEqual([["secret", "delete", "--user", "--", "TOKEN"]]);
});

const variable = {
  name: "MODE",
  value: "fast",
  visibility: "",
  numSelectedRepos: 0,
  selectedReposURL: "",
  createdAt: "2026-10-26T18:02:47Z",
  updatedAt: "2026-10-27T18:02:47Z",
};

const variableFields =
  "name,value,visibility,numSelectedRepos,selectedReposURL,createdAt,updatedAt";

test("variable list and get decode variables", async () => {
  const gh = scriptedSpawner([
    { stdout: JSON.stringify([variable]) },
    { stdout: JSON.stringify(variable) },
  ]);

  expect(await gh.run(Variable.list({ repo: "owner/repo" }))).toEqual([
    variable,
  ]);
  expect(
    await gh.run(Variable.get({ environment: "prod", name: "MODE" })),
  ).toEqual(variable);
  expect(gh.args()).toEqual([
    ["variable", "list", "--repo", "owner/repo", "--json", variableFields],
    [
      "variable",
      "get",
      "--env",
      "prod",
      "--json",
      variableFields,
      "--",
      "MODE",
    ],
  ]);
});

test("variable set uses stdin and remove deletes by name", async () => {
  const gh = scriptedSpawner([]);

  await gh.run(
    Variable.set({
      organization: "acme",
      name: "MODE",
      value: "fast",
      visibility: "all",
    }),
  );
  await gh.run(Variable.remove({ organization: "acme", name: "MODE" }));
  expect(gh.args()).toEqual([
    ["variable", "set", "--org", "acme", "--visibility", "all", "--", "MODE"],
    ["variable", "delete", "--org", "acme", "--", "MODE"],
  ]);
  expect(gh.stdins[0]).toBe("fast");
});
