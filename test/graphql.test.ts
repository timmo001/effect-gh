import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { GhCommandError, GhDecodeError } from "../src/errors.js";
import * as Graphql from "../src/graphql.js";
import { scriptedSpawner } from "./helpers.js";

test("query posts the document and variables on stdin and decodes data", async () => {
  const fake = scriptedSpawner([
    { stdout: JSON.stringify({ data: { viewer: { login: "octocat" } } }) },
  ]);

  const result = await fake.run(
    Graphql.query(
      "query($a: Int) { viewer { login } }",
      { a: 1 },
      Schema.Struct({ viewer: Schema.Struct({ login: Schema.String }) }),
      { hostname: "github.example" },
    ),
  );

  expect(result).toEqual({ viewer: { login: "octocat" } });
  expect(fake.args()[0]).toEqual([
    "api",
    "--method",
    "POST",
    "--hostname=github.example",
    "--input",
    "-",
    "--allow-escape-sequences",
    "--",
    "graphql",
  ]);
  expect(JSON.parse(fake.stdins[0] ?? "")).toEqual({
    query: "query($a: Int) { viewer { login } }",
    variables: { a: 1 },
  });
});

test("GraphQL errors fail with ResponseError even though gh exits non-zero", async () => {
  const fake = scriptedSpawner([
    {
      stdout: JSON.stringify({
        data: { repository: null },
        errors: [
          { type: "NOT_FOUND", path: ["repository"], message: "Not found" },
        ],
      }),
      exitCode: 1,
    },
  ]);

  const error = await fake.fail(
    Graphql.query("{ x }", undefined, Schema.Unknown),
  );

  expect(error).toBeInstanceOf(Graphql.ResponseError);
  expect(error).toMatchObject({
    errors: [{ type: "NOT_FOUND", path: ["repository"], message: "Not found" }],
  });
});

test("non-JSON failures keep the command error and data mismatches are decode errors", async () => {
  const failed = scriptedSpawner([{ stdout: "", exitCode: 1 }]);

  const mismatch = scriptedSpawner([
    { stdout: JSON.stringify({ data: { x: 1 } }) },
  ]);

  expect(
    await failed.fail(Graphql.query("{ x }", undefined, Schema.Unknown)),
  ).toBeInstanceOf(GhCommandError);
  expect(
    await mismatch.fail(
      Graphql.query("{ x }", undefined, Schema.Struct({ x: Schema.String })),
    ),
  ).toBeInstanceOf(GhDecodeError);
});

test("operations reports kinds and top-level fields through aliases and fragments", async () => {
  const result = await Effect.runPromise(
    Graphql.operations(`
      query Read { viewer { login } ... on Query { rateLimit { remaining } } }
      mutation {
        done: resolveReviewThread(input: { threadId: "1" }) { thread { id } }
        ...More
      }
      subscription { ping }
      fragment More on Mutation { addComment(input: {}) { clientMutationId } ...More }
    `),
  );

  expect(result).toEqual([
    { kind: "query", name: "Read", fields: ["viewer", "rateLimit"] },
    {
      kind: "mutation",
      name: null,
      fields: ["resolveReviewThread", "addComment"],
    },
    { kind: "subscription", name: null, fields: ["ping"] },
  ]);
});

test("operations fails with ParseError on invalid syntax", async () => {
  expect(
    await Effect.runPromise(Graphql.operations("mutation {").pipe(Effect.flip)),
  ).toBeInstanceOf(Graphql.ParseError);
});
