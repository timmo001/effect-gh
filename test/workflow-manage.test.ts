import { expect, test } from "bun:test";
import * as Workflow from "../src/workflow.js";
import { scriptedSpawner } from "./helpers.js";

test("run cancel, delete and download pass the run and flags", async () => {
  const gh = scriptedSpawner([]);
  const repo = "owner/repo";

  await gh.run(Workflow.cancel({ repo, runId: 5, force: true }));
  await gh.run(Workflow.remove({ repo, runId: 5 }));
  await gh.run(
    Workflow.download({
      repo,
      runId: 5,
      directory: "out",
      names: ["dist"],
      patterns: ["logs-*"],
    }),
  );
  expect(gh.args()).toEqual([
    ["run", "cancel", "5", "--repo", repo, "--force"],
    ["run", "delete", "5", "--repo", repo],
    [
      "run",
      "download",
      "5",
      "--repo",
      repo,
      "--dir",
      "out",
      "--name",
      "dist",
      "--pattern",
      "logs-*",
    ],
  ]);
});

test("listWorkflows decodes workflows and passes its flags", async () => {
  const workflow = {
    id: 161335,
    name: "CI",
    path: ".github/workflows/ci.yml",
    state: "active",
  };

  const gh = scriptedSpawner([{ stdout: JSON.stringify([workflow]) }]);

  expect(
    await gh.run(
      Workflow.listWorkflows({ repo: "owner/repo", limit: 10, all: true }),
    ),
  ).toEqual([workflow]);
  expect(gh.args()).toEqual([
    [
      "workflow",
      "list",
      "--repo",
      "owner/repo",
      "--limit",
      "10",
      "--json",
      "id,name,path,state",
      "--all",
    ],
  ]);
});

test("viewWorkflow, enable and disable put the selector after --", async () => {
  const gh = scriptedSpawner([{ stdout: "CI - ci.yml\n" }]);
  const repo = "owner/repo";

  expect(
    await gh.run(
      Workflow.viewWorkflow({
        repo,
        workflow: "ci.yml",
        ref: "main",
        yaml: true,
      }),
    ),
  ).toBe("CI - ci.yml\n");
  await gh.run(Workflow.enable({ repo, workflow: "ci.yml" }));
  await gh.run(Workflow.disable({ repo, workflow: "-odd" }));
  expect(gh.args()).toEqual([
    [
      "workflow",
      "view",
      "--repo",
      repo,
      "--ref",
      "main",
      "--yaml",
      "--",
      "ci.yml",
    ],
    ["workflow", "enable", "--repo", repo, "--", "ci.yml"],
    ["workflow", "disable", "--repo", repo, "--", "-odd"],
  ]);
});
