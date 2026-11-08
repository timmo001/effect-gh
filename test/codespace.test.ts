import { expect, test } from "bun:test";
import * as Codespace from "../src/codespace.js";
import { scriptedSpawner } from "./helpers.js";

const gitStatus = {
  ref: "main",
  ahead: 0,
  behind: 1,
  hasUncommittedChanges: false,
  hasUnpushedChanges: true,
};

const listed = {
  name: "octocat-repo-abc",
  displayName: "fuzzy space",
  state: "Available",
  owner: "octocat",
  repository: "octocat/repo",
  machineName: "basicLinux32gb",
  createdAt: "2026-10-01T10:00:00Z",
  lastUsedAt: "2026-11-01T10:00:00Z",
  gitStatus,
};

test("list and view select their fields and decode", async () => {
  const viewed = {
    name: listed.name,
    displayName: listed.displayName,
    state: listed.state,
    owner: listed.owner,
    repository: listed.repository,
    machineName: listed.machineName,
    machineDisplayName: "2 cores, 8 GB RAM",
    createdAt: listed.createdAt,
    lastUsedAt: listed.lastUsedAt,
    gitStatus,
    devcontainerPath: ".devcontainer/devcontainer.json",
    location: "WestEurope",
    idleTimeoutMinutes: 30,
    prebuild: false,
  };

  const gh = scriptedSpawner([
    { stdout: JSON.stringify([listed]) },
    { stdout: JSON.stringify(viewed) },
  ]);

  expect(
    await gh.run(Codespace.list({ repo: "octocat/repo", limit: 5 })),
  ).toEqual([listed]);
  expect(await gh.run(Codespace.view({ codespace: listed.name }))).toEqual(
    viewed,
  );
  expect(gh.args()).toEqual([
    [
      "codespace",
      "list",
      "--repo",
      "octocat/repo",
      "--limit",
      "5",
      "--json",
      "name,displayName,state,owner,repository,machineName,createdAt,lastUsedAt,gitStatus,vscsTarget",
    ],
    [
      "codespace",
      "view",
      "--codespace",
      "octocat-repo-abc",
      "--json",
      "name,displayName,state,owner,repository,machineName,machineDisplayName,createdAt,lastUsedAt,gitStatus,devcontainerPath,location,idleTimeoutMinutes,prebuild",
    ],
  ]);
});

test("create returns the name and the others build their argv", async () => {
  const gh = scriptedSpawner([{ stdout: "octocat-repo-abc\n" }]);

  expect(
    await gh.run(
      Codespace.create({
        repo: "octocat/repo",
        machine: "basicLinux32gb",
        branch: "main",
        defaultPermissions: true,
      }),
    ),
  ).toEqual({ name: "octocat-repo-abc" });
  await gh.run(Codespace.edit({ codespace: "cs", displayName: "new" }));
  await gh.run(Codespace.remove({ codespace: "cs" }));
  await gh.run(Codespace.remove({ days: 30, force: true }));
  await gh.run(Codespace.stop({ codespace: "cs", org: "org", user: "u" }));
  await gh.run(Codespace.rebuild({ codespace: "cs", full: true }));
  expect(gh.args()).toEqual([
    [
      "codespace",
      "create",
      "--repo",
      "octocat/repo",
      "--machine",
      "basicLinux32gb",
      "--branch",
      "main",
      "--default-permissions",
    ],
    ["codespace", "edit", "--codespace", "cs", "--display-name", "new"],
    ["codespace", "delete", "--codespace", "cs"],
    ["codespace", "delete", "--days", "30", "--force"],
    ["codespace", "stop", "--codespace", "cs", "--org", "org", "--user", "u"],
    ["codespace", "rebuild", "--codespace", "cs", "--full"],
  ]);
});

test("logs, cp and ports", async () => {
  const port = {
    sourcePort: 3000,
    visibility: "private",
    label: "",
    browseUrl: "https://cs-3000.app.github.dev",
  };

  const gh = scriptedSpawner([
    { stdout: "log line\n" },
    { stdout: "" },
    { stdout: JSON.stringify([port]) },
  ]);

  expect(await gh.run(Codespace.logs({ codespace: "cs" }))).toBe("log line\n");
  await gh.run(
    Codespace.cp({
      codespace: "cs",
      sources: ["a.txt", "remote:/tmp/b.txt"],
      destination: "remote:/workspaces/",
      recursive: true,
    }),
  );
  expect(await gh.run(Codespace.ports({ codespace: "cs" }))).toEqual([port]);
  await gh.run(
    Codespace.portsVisibility({
      codespace: "cs",
      ports: [
        { port: 80, visibility: "org" },
        { port: 3000, visibility: "public" },
      ],
    }),
  );
  expect(gh.args()).toEqual([
    ["codespace", "logs", "--codespace", "cs"],
    [
      "codespace",
      "cp",
      "--codespace",
      "cs",
      "--recursive",
      "a.txt",
      "remote:/tmp/b.txt",
      "remote:/workspaces/",
    ],
    [
      "codespace",
      "ports",
      "--codespace",
      "cs",
      "--json",
      "sourcePort,visibility,label,browseUrl",
    ],
    [
      "codespace",
      "ports",
      "visibility",
      "--codespace",
      "cs",
      "80:org",
      "3000:public",
    ],
  ]);
});
