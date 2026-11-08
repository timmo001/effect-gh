import { expect, test } from "bun:test";
import * as DeployKey from "../src/deploy-key.js";
import { scriptedSpawner } from "./helpers.js";

const key = {
  id: 7,
  title: "ci",
  key: "ssh-ed25519 AAAA",
  readOnly: true,
  createdAt: "2026-10-26T18:02:47Z",
};

test("add, remove and list pass the expected argv", async () => {
  const gh = scriptedSpawner([
    { stdout: "" },
    { stdout: "" },
    { stdout: JSON.stringify([key]) },
  ]);

  await gh.run(
    DeployKey.add({
      repo: "owner/repo",
      keyFile: "key.pub",
      title: "ci",
      allowWrite: true,
    }),
  );
  await gh.run(DeployKey.remove({ repo: "owner/repo", id: 7 }));
  expect(await gh.run(DeployKey.list({ repo: "owner/repo" }))).toEqual([key]);
  expect(gh.args()).toEqual([
    [
      "repo",
      "deploy-key",
      "add",
      "--repo",
      "owner/repo",
      "--title",
      "ci",
      "--allow-write",
      "--",
      "key.pub",
    ],
    ["repo", "deploy-key", "delete", "--repo", "owner/repo", "--", "7"],
    [
      "repo",
      "deploy-key",
      "list",
      "--repo",
      "owner/repo",
      "--json",
      "id,title,key,readOnly,createdAt",
    ],
  ]);
});

test("list returns no keys when gh prints nothing", async () => {
  const gh = scriptedSpawner([{ stdout: "" }]);

  expect(await gh.run(DeployKey.list({ repo: "owner/repo" }))).toEqual([]);
});
