import { expect, test } from "bun:test";
import type { Schema } from "effect";
import * as Discussion from "../src/discussion.js";
import { scriptedSpawner } from "./helpers.js";

const author = { login: "octocat" };

const summary = (number: number) => ({
  id: `D_${number}`,
  number,
  title: `Discussion ${number}`,
  url: `https://github.com/owner/repo/discussions/${number}`,
  author,
  category: { name: "Q&A" },
  closed: false,
  isAnswered: null,
  createdAt: "2026-10-28T12:00:00Z",
  updatedAt: "2026-10-28T12:00:00Z",
});

const reply = {
  id: "DC_2",
  databaseId: 2,
  author,
  body: "Thanks",
  createdAt: "2026-10-28T12:00:00Z",
  url: "https://github.com/owner/repo/discussions/1#discussioncomment-2",
};

const data = (value: Schema.Json) => JSON.stringify({ data: value });

test("list stops at the limit and maps state to DiscussionState", async () => {
  const fake = scriptedSpawner([
    {
      stdout: data({
        repository: {
          discussions: {
            nodes: [summary(1), summary(2)],
            pageInfo: { hasNextPage: true, endCursor: "c1" },
          },
        },
      }),
    },
  ]);

  expect(
    await fake.run(
      Discussion.list({ repo: "owner/repo", state: "closed", limit: 2 }),
    ),
  ).toEqual([summary(1), summary(2)]);
  expect(fake.commands).toHaveLength(1);
  expect(JSON.parse(fake.stdins[0] ?? "").variables).toEqual({
    owner: "owner",
    name: "repo",
    states: ["CLOSED"],
    first: 2,
    after: null,
  });
});

test("comments flatten their replies", async () => {
  const fake = scriptedSpawner([
    {
      stdout: data({
        repository: {
          discussion: {
            comments: {
              nodes: [
                {
                  ...reply,
                  id: "DC_1",
                  isAnswer: true,
                  replies: { nodes: [reply] },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    },
  ]);

  expect(
    await fake.run(Discussion.comments({ repo: "owner/repo", number: 1 })),
  ).toEqual([{ ...reply, id: "DC_1", isAnswer: true, replies: [reply] }]);
});

test("comment looks up the discussion ID, and reply the comment's discussion", async () => {
  const added = data({
    addDiscussionComment: { comment: { id: "DC_3", url: "https://example/3" } },
  });

  const fake = scriptedSpawner([
    { stdout: data({ repository: { discussion: { id: "D_1" } } }) },
    { stdout: added },
    { stdout: data({ node: { discussion: { id: "D_1" } } }) },
    { stdout: added },
  ]);

  expect(
    await fake.run(
      Discussion.comment({ repo: "owner/repo", number: 1, body: "Hi" }),
    ),
  ).toEqual({ id: "DC_3", url: "https://example/3" });
  expect(
    await fake.run(Discussion.reply({ commentId: "DC_1", body: "Hi again" })),
  ).toEqual({ id: "DC_3", url: "https://example/3" });

  const variables = fake.stdins.map((stdin) => JSON.parse(stdin).variables);
  expect(variables[1]).toEqual({
    discussionId: "D_1",
    body: "Hi",
    replyToId: null,
  });
  expect(variables[2]).toEqual({ id: "DC_1" });
  expect(variables[3]).toEqual({
    discussionId: "D_1",
    body: "Hi again",
    replyToId: "DC_1",
  });
});
