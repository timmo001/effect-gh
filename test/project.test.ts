import { expect, test } from "bun:test";
import * as Project from "../src/project.js";
import { scriptedSpawner } from "./helpers.js";

const project = {
  number: 3,
  url: "https://github.com/users/octocat/projects/3",
  shortDescription: "",
  public: false,
  closed: false,
  title: "Roadmap",
  id: "PVT_1",
  readme: "",
  items: { totalCount: 2 },
  fields: { totalCount: 4 },
  owner: { type: "User", login: "octocat" },
};

const item = {
  id: "PVTI_1",
  title: "Task",
  body: "",
  type: "DraftIssue",
};

test("project commands pass the number first and decode their JSON", async () => {
  const gh = scriptedSpawner([
    { stdout: JSON.stringify(project) },
    { stdout: JSON.stringify({ projects: [project], totalCount: 1 }) },
    { stdout: JSON.stringify(project) },
    { stdout: JSON.stringify({ ...project, closed: true }) },
    { stdout: JSON.stringify(project) },
  ]);

  expect(await gh.run(Project.view({ number: 3, owner: "@me" }))).toEqual(
    project,
  );
  expect(
    await gh.run(Project.list({ owner: "octocat", limit: 5, closed: true })),
  ).toEqual({ projects: [project], totalCount: 1 });
  await gh.run(
    Project.edit({ number: 3, title: "Roadmap", visibility: "PRIVATE" }),
  );
  expect(
    (await gh.run(Project.close({ number: 3, owner: "octocat" }))).closed,
  ).toBe(true);
  await gh.run(
    Project.copy({
      number: 3,
      title: "Copy",
      targetOwner: "org",
      drafts: true,
    }),
  );
  expect(gh.args()).toEqual([
    ["project", "view", "3", "--owner", "@me", "--format", "json"],
    [
      "project",
      "list",
      "--owner",
      "octocat",
      "--limit",
      "5",
      "--closed",
      "--format",
      "json",
    ],
    [
      "project",
      "edit",
      "3",
      "--title",
      "Roadmap",
      "--visibility",
      "PRIVATE",
      "--format",
      "json",
    ],
    ["project", "close", "3", "--owner", "octocat", "--format", "json"],
    [
      "project",
      "copy",
      "3",
      "--title",
      "Copy",
      "--target-owner",
      "org",
      "--drafts",
      "--format",
      "json",
    ],
  ]);
});

test("project create, delete, template, link and unlink build their argv", async () => {
  const gh = scriptedSpawner([
    { stdout: JSON.stringify(project) },
    { stdout: JSON.stringify(project) },
    { stdout: JSON.stringify(project) },
  ]);

  await gh.run(Project.create({ title: "Roadmap", owner: "@me" }));
  await gh.run(Project.remove({ number: 3 }));
  await gh.run(Project.markTemplate({ number: 3, owner: "org", undo: true }));
  await gh.run(Project.link({ number: 3, repo: "owner/repo" }));
  await gh.run(Project.unlink({ number: 3, team: "team" }));
  expect(gh.args()).toEqual([
    [
      "project",
      "create",
      "--title",
      "Roadmap",
      "--owner",
      "@me",
      "--format",
      "json",
    ],
    ["project", "delete", "3", "--format", "json"],
    [
      "project",
      "mark-template",
      "3",
      "--owner",
      "org",
      "--undo",
      "--format",
      "json",
    ],
    ["project", "link", "3", "--repo", "owner/repo"],
    ["project", "unlink", "3", "--team", "team"],
  ]);
});

test("fields decode options and build their argv", async () => {
  const select = {
    id: "PVTSSF_1",
    name: "Status",
    type: "ProjectV2SingleSelectField",
    options: [{ id: "a", name: "Todo" }],
  };

  const gh = scriptedSpawner([
    { stdout: JSON.stringify(select) },
    { stdout: JSON.stringify(select) },
    {
      stdout: JSON.stringify({
        fields: [select, { id: "f", name: "Title", type: "ProjectV2Field" }],
        totalCount: 2,
      }),
    },
  ]);

  await gh.run(
    Project.fieldCreate({
      number: 3,
      name: "Status",
      dataType: "SINGLE_SELECT",
      singleSelectOptions: ["Todo", "Done"],
    }),
  );
  await gh.run(Project.fieldDelete({ id: "PVTSSF_1" }));
  expect(
    (await gh.run(Project.fieldList({ number: 3, limit: 10 }))).fields,
  ).toHaveLength(2);
  expect(gh.args()).toEqual([
    [
      "project",
      "field-create",
      "3",
      "--name",
      "Status",
      "--data-type",
      "SINGLE_SELECT",
      "--single-select-options",
      "Todo,Done",
      "--format",
      "json",
    ],
    ["project", "field-delete", "--id", "PVTSSF_1", "--format", "json"],
    ["project", "field-list", "3", "--limit", "10", "--format", "json"],
  ]);
});

test("items decode and build their argv", async () => {
  const listed = {
    items: [
      {
        id: "PVTI_1",
        content: {
          type: "Issue",
          title: "Bug",
          body: "",
          number: 1,
          repository: "owner/repo",
          url: "https://github.com/owner/repo/issues/1",
        },
        status: "Todo",
      },
      { id: "PVTI_2", content: null },
    ],
    totalCount: 2,
  };

  const gh = scriptedSpawner([
    { stdout: JSON.stringify(item) },
    { stdout: JSON.stringify(item) },
    { stdout: JSON.stringify(item) },
    { stdout: JSON.stringify({ id: "PVTI_1" }) },
    { stdout: JSON.stringify({ title: "New", body: "", type: "DraftIssue" }) },
    { stdout: JSON.stringify(listed) },
  ]);

  await gh.run(
    Project.itemAdd({
      number: 3,
      url: "https://github.com/owner/repo/issues/1",
    }),
  );
  await gh.run(Project.itemCreate({ number: 3, title: "Task", body: "Body" }));
  await gh.run(Project.itemArchive({ number: 3, id: "PVTI_1", undo: true }));
  expect(await gh.run(Project.itemDelete({ number: 3, id: "PVTI_1" }))).toEqual(
    {
      id: "PVTI_1",
    },
  );
  await gh.run(
    Project.itemEdit({
      id: "PVTI_1",
      fieldId: "F1",
      projectId: "PVT_1",
      numberValue: 2.5,
    }),
  );
  expect(
    (await gh.run(Project.itemList({ number: 3, query: "-status:Done" })))
      .items,
  ).toHaveLength(2);
  expect(gh.args()).toEqual([
    [
      "project",
      "item-add",
      "3",
      "--url",
      "https://github.com/owner/repo/issues/1",
      "--format",
      "json",
    ],
    [
      "project",
      "item-create",
      "3",
      "--title",
      "Task",
      "--body",
      "Body",
      "--format",
      "json",
    ],
    [
      "project",
      "item-archive",
      "3",
      "--id",
      "PVTI_1",
      "--undo",
      "--format",
      "json",
    ],
    ["project", "item-delete", "3", "--id", "PVTI_1", "--format", "json"],
    [
      "project",
      "item-edit",
      "--id",
      "PVTI_1",
      "--field-id",
      "F1",
      "--project-id",
      "PVT_1",
      "--number",
      "2.5",
      "--format",
      "json",
    ],
    [
      "project",
      "item-list",
      "3",
      "--query",
      "-status:Done",
      "--format",
      "json",
    ],
  ]);
});
