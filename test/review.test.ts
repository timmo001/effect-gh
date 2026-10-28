import { expect, test } from "bun:test";
import { Effect } from "effect";
import { GhInvalidOptionsError } from "../src/errors.js";
import * as Review from "../src/review.js";
import { scriptedSpawner } from "./helpers.js";

const comment = {
  id: "PRRC_1",
  databaseId: 11,
  author: { login: "octocat" },
  body: "Fix this",
  createdAt: "2026-10-28T12:00:00Z",
  url: "https://github.com/owner/repo/pull/1#discussion_r11",
};

const thread = (id: string, isResolved: boolean) => ({
  id,
  isResolved,
  isOutdated: false,
  path: "src/a.ts",
  line: 4,
  startLine: null,
  diffSide: "RIGHT" as const,
  comments: { nodes: [comment] },
});

const threadsPage = (
  nodes: ReadonlyArray<ReturnType<typeof thread>>,
  endCursor: string | null,
) =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes,
            pageInfo: { hasNextPage: endCursor !== null, endCursor },
          },
        },
      },
    },
  });

test("threads follow the cursor, flatten comments and filter resolved ones", async () => {
  const fake = scriptedSpawner([
    { stdout: threadsPage([thread("T1", true)], "c1") },
    { stdout: threadsPage([thread("T2", false)], null) },
  ]);

  const result = await fake.run(
    Review.threads({
      repo: "github.example/owner/repo",
      number: 7,
      unresolvedOnly: true,
    }),
  );

  expect(result).toEqual([{ ...thread("T2", false), comments: [comment] }]);
  expect(fake.args()[0]).toContain("--hostname=github.example");
  expect(fake.stdins.map((stdin) => JSON.parse(stdin).variables)).toEqual([
    { owner: "owner", name: "repo", number: 7, after: null },
    { owner: "owner", name: "repo", number: 7, after: "c1" },
  ]);
});

test("list returns reviews with pending ones' null submittedAt", async () => {
  const review = {
    id: "PRR_1",
    databaseId: 1,
    author: null,
    state: "PENDING",
    body: "",
    submittedAt: null,
    url: "https://github.com/owner/repo/pull/1#pullrequestreview-1",
  };

  const fake = scriptedSpawner([
    {
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviews: {
                nodes: [review],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
    },
  ]);

  expect(
    await fake.run(Review.list({ repo: "owner/repo", number: 1 })),
  ).toEqual([review]);
});

test("reply, resolve and unresolve send their mutations", async () => {
  const fake = scriptedSpawner([
    {
      stdout: JSON.stringify({
        data: {
          addPullRequestReviewThreadReply: {
            comment: { id: "PRRC_2", url: "https://example/2" },
          },
        },
      }),
    },
    {
      stdout: JSON.stringify({
        data: {
          resolveReviewThread: { thread: { id: "T1", isResolved: true } },
        },
      }),
    },
    {
      stdout: JSON.stringify({
        data: {
          unresolveReviewThread: { thread: { id: "T1", isResolved: false } },
        },
      }),
    },
  ]);

  expect(
    await fake.run(Review.reply({ threadId: "T1", body: "Done" })),
  ).toEqual({ id: "PRRC_2", url: "https://example/2" });
  expect(await fake.run(Review.resolve({ threadId: "T1" }))).toEqual({
    id: "T1",
    isResolved: true,
  });
  expect(await fake.run(Review.unresolve({ threadId: "T1" }))).toEqual({
    id: "T1",
    isResolved: false,
  });

  const requests = fake.stdins.map((stdin) => JSON.parse(stdin));
  expect(requests[0].variables).toEqual({ threadId: "T1", body: "Done" });
  expect(requests[1].query).toContain("resolveReviewThread(");
  expect(requests[2].query).toContain("unresolveReviewThread(");
});

test("submit posts inline comments with sides and multi-line ranges", async () => {
  const fake = scriptedSpawner([
    {
      stdout: JSON.stringify({
        id: 5,
        node_id: "PRR_5",
        state: "CHANGES_REQUESTED",
        html_url: "https://github.com/owner/repo/pull/3#pullrequestreview-5",
      }),
    },
  ]);

  expect(
    await fake.run(
      Review.submit({
        repo: "owner/repo",
        number: 3,
        event: "REQUEST_CHANGES",
        body: "See inline",
        comments: [
          { path: "a.ts", line: 4, body: "One" },
          { path: "b.ts", line: 9, startLine: 7, side: "LEFT", body: "Range" },
        ],
      }),
    ),
  ).toEqual({
    id: 5,
    nodeId: "PRR_5",
    state: "CHANGES_REQUESTED",
    url: "https://github.com/owner/repo/pull/3#pullrequestreview-5",
  });
  expect(fake.args()[0]).toEqual([
    "api",
    "--method",
    "POST",
    "--input",
    "-",
    "--",
    "repos/owner/repo/pulls/3/reviews",
  ]);
  expect(JSON.parse(fake.stdins[0] ?? "")).toEqual({
    event: "REQUEST_CHANGES",
    body: "See inline",
    comments: [
      { path: "a.ts", line: 4, side: "RIGHT", body: "One" },
      {
        path: "b.ts",
        line: 9,
        side: "LEFT",
        start_line: 7,
        start_side: "LEFT",
        body: "Range",
      },
    ],
  });
});

test("invalid selectors fail before spawning", async () => {
  const fake = scriptedSpawner([]);

  for (const request of [
    Review.threads({ repo: "--help", number: 1 }).pipe(Effect.asVoid),
    Review.list({ repo: "owner/repo", number: 0 }).pipe(Effect.asVoid),
    Review.resolve({ threadId: "" }).pipe(Effect.asVoid),
  ])
    expect(await fake.fail(request)).toBeInstanceOf(GhInvalidOptionsError);

  expect(fake.commands).toHaveLength(0);
});
