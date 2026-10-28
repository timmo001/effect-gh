import { expect, test } from "bun:test";
import * as Comment from "../src/comment.js";
import { scriptedSpawner } from "./helpers.js";

const rest = (id: number, body: string | null) => ({
  id,
  node_id: `IC_${id}`,
  user: { login: "octocat" },
  body,
  created_at: "2026-10-28T12:00:00Z",
  updated_at: "2026-10-28T12:30:00Z",
  html_url: `https://github.com/owner/repo/issues/1#issuecomment-${id}`,
});

const typed = (id: number, body: string) => ({
  id,
  nodeId: `IC_${id}`,
  author: { login: "octocat" },
  body,
  createdAt: "2026-10-28T12:00:00Z",
  updatedAt: "2026-10-28T12:30:00Z",
  url: `https://github.com/owner/repo/issues/1#issuecomment-${id}`,
});

test("list flattens every page of conversation comments", async () => {
  const fake = scriptedSpawner([
    { stdout: JSON.stringify([[rest(1, "One")], [rest(2, null)]]) },
  ]);

  expect(
    await fake.run(Comment.list({ repo: "owner/repo", number: 1 })),
  ).toEqual([typed(1, "One"), typed(2, "")]);
  expect(fake.args()[0]).toEqual([
    "api",
    "--method",
    "GET",
    "--paginate",
    "--slurp",
    "--",
    "repos/owner/repo/issues/1/comments?per_page=100",
  ]);
});

test("edit patches issue comments and remove deletes review comments", async () => {
  const fake = scriptedSpawner([
    { stdout: JSON.stringify(rest(5, "New")) },
    { stdout: "" },
  ]);

  expect(
    await fake.run(Comment.edit({ repo: "owner/repo", id: 5, body: "New" })),
  ).toEqual(typed(5, "New"));
  await fake.run(Comment.remove({ repo: "owner/repo", id: 6, kind: "review" }));

  expect(fake.args()).toEqual([
    [
      "api",
      "--method",
      "PATCH",
      "--input",
      "-",
      "--",
      "repos/owner/repo/issues/comments/5",
    ],
    [
      "api",
      "--method",
      "DELETE",
      "--allow-escape-sequences",
      "--",
      "repos/owner/repo/pulls/comments/6",
    ],
  ]);
  expect(JSON.parse(fake.stdins[0] ?? "")).toEqual({ body: "New" });
});
