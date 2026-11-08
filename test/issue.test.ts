import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { GhDecodeError } from "../src/errors.js";
import { layer } from "../src/gh.js";
import * as Issue from "../src/issue.js";
import { fakeSpawner, scriptedSpawner, textStream } from "./helpers.js";

const summary = {
  number: 42,
  title: "An issue",
  url: "https://github.com/owner/repo/issues/42",
  state: "OPEN",
  updatedAt: "2026-09-09T12:00:00Z",
} satisfies Issue.IssueSummary;

test("issue list leaves default open state and limit 30 to gh", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({
        stdout: textStream(JSON.stringify([summary])),
      });

      const operation = Issue.list().pipe(
        Effect.provide(layer().pipe(Layer.provide(fake.layer))),
      );

      expect(fake.commands).toHaveLength(0);
      expect(yield* operation).toEqual([summary]);
      expect(fake.commands).toHaveLength(1);
      const command = fake.commands[0];

      if (command?._tag !== "StandardCommand")
        throw new Error("Expected a standard command");
      expect(command.args).toEqual([
        "issue",
        "list",
        "--json",
        "number,title,url,state,updatedAt",
      ]);
    }),
  );
});

test.each(["open", "closed", "all"] as const)(
  "issue list passes optional filters and execution overrides: %s",
  async (state) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* fakeSpawner({ stdout: textStream("[]") });
        expect(
          yield* Issue.list(
            {
              repo: "enterprise.example/owner/repo",
              state,
              limit: 75,
              labels: ["help wanted", "--label-value"],
              assignee: "@me",
              search: "-label:bug sort:updated-desc $(literal)",
            },
            {
              executable: "custom-gh",
              cwd: "/workspace",
              env: { CUSTOM: "value" },
            },
          ).pipe(Effect.provide(layer().pipe(Layer.provide(fake.layer)))),
        ).toEqual([]);
        const command = fake.commands[0];

        if (command?._tag !== "StandardCommand")
          throw new Error("Expected a standard command");
        expect(command.command).toBe("custom-gh");
        expect(command.args).toEqual([
          "issue",
          "list",
          "--json",
          "number,title,url,state,updatedAt",
          "--repo",
          "enterprise.example/owner/repo",
          "--state",
          state,
          "--limit",
          "75",
          "--label",
          "help wanted",
          "--label",
          "--label-value",
          "--assignee",
          "@me",
          "--search",
          "-label:bug sort:updated-desc $(literal)",
        ]);
        expect(command.options).toMatchObject({
          cwd: "/workspace",
          shell: false,
          env: { CUSTOM: "value" },
        });
      }),
    );
  },
);

test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "issue list rejects invalid limit before spawning: %s",
  async (limit) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* fakeSpawner();
        expect(
          yield* Issue.list({ limit }).pipe(
            Effect.provide(layer().pipe(Layer.provide(fake.layer))),
            Effect.flip,
          ),
        ).toBeInstanceOf(Issue.InvalidInput);
        expect(fake.commands).toHaveLength(0);
      }),
    );
  },
);

test.each([42, summary.url, "--web", "a b"])(
  "issue view protects the positional selector: %s",
  async (selector) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const issue = { ...summary, body: "" };

        const fake = yield* fakeSpawner({
          stdout: textStream(JSON.stringify(issue)),
        });

        expect(
          yield* Issue.view(
            selector,
            { repo: "enterprise.example/owner/repo" },
            {
              executable: "custom-gh",
              cwd: "/workspace",
            },
          ).pipe(Effect.provide(layer().pipe(Layer.provide(fake.layer)))),
        ).toEqual(issue);
        const command = fake.commands[0];

        if (command?._tag !== "StandardCommand")
          throw new Error("Expected a standard command");
        expect(command.command).toBe("custom-gh");
        expect(command.args).toEqual([
          "issue",
          "view",
          "--json",
          "number,title,url,state,updatedAt,body",
          "--repo",
          "enterprise.example/owner/repo",
          "--",
          String(selector),
        ]);
        expect(command.options).toMatchObject({
          cwd: "/workspace",
          shell: false,
        });
      }),
    );
  },
);

test("issue view defaults to the current repository", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const issue: Issue.Issue = {
        ...summary,
        state: "CLOSED",
        body: "Body\nwith text",
      };

      const fake = yield* fakeSpawner({
        stdout: textStream(JSON.stringify(issue)),
      });

      expect(
        yield* Issue.view(42).pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
        ),
      ).toEqual(issue);
      const command = fake.commands[0];

      if (command?._tag !== "StandardCommand")
        throw new Error("Expected a standard command");
      expect(command.args).toEqual([
        "issue",
        "view",
        "--json",
        "number,title,url,state,updatedAt,body",
        "--",
        "42",
      ]);
    }),
  );
});

test.each(["list", "view"] as const)(
  "issue %s rejects invalid output and propagates nonzero exits",
  async (operation) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        for (const invalid of [
          "not JSON",
          JSON.stringify(
            operation === "list"
              ? [{ ...summary, state: "unknown" }]
              : { ...summary, body: null },
          ),
        ]) {
          const fake = yield* fakeSpawner({ stdout: textStream(invalid) });
          expect(
            yield* (
              operation === "list"
                ? Effect.asVoid(Issue.list())
                : Effect.asVoid(Issue.view(42))
            ).pipe(
              Effect.provide(layer().pipe(Layer.provide(fake.layer))),
              Effect.flip,
            ),
          ).toBeInstanceOf(GhDecodeError);
        }

        const fake = yield* fakeSpawner({
          stderr: textStream("not found"),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        });

        const error = yield* (
          operation === "list"
            ? Effect.asVoid(Issue.list())
            : Effect.asVoid(Issue.view(42))
        ).pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
          Effect.flip,
        );

        expect(error._tag).toBe("GhCommandError");
        expect(error).toMatchObject({
          exitCode: 1,
          stderr: "not found",
        });
      }),
    );
  },
);

test("issue view rejects a negative numeric selector before spawning", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner();
      expect(
        yield* Issue.view(-1).pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
          Effect.flip,
        ),
      ).toBeInstanceOf(Issue.InvalidInput);
      expect(fake.commands).toHaveLength(0);
    }),
  );
});

test("close and reopen pass comments, reasons and duplicates before the issue", async () => {
  const gh = scriptedSpawner([]);

  await gh.run(Issue.close(1, { repo: "owner/repo" }));
  await gh.run(
    Issue.close("--web", {
      repo: "owner/repo",
      comment: "Done",
      reason: "duplicate",
      duplicateOf: 2,
    }),
  );
  await gh.run(Issue.reopen(1, { repo: "owner/repo", comment: "Again" }));
  expect(gh.args()).toEqual([
    ["issue", "close", "--repo", "owner/repo", "--", "1"],
    [
      "issue",
      "close",
      "--repo",
      "owner/repo",
      "--comment",
      "Done",
      "--reason",
      "duplicate",
      "--duplicate-of",
      "2",
      "--",
      "--web",
    ],
    [
      "issue",
      "reopen",
      "--repo",
      "owner/repo",
      "--comment",
      "Again",
      "--",
      "1",
    ],
  ]);
});

test("remove, lock, unlock, pin, unpin and transfer pass exact argv", async () => {
  const gh = scriptedSpawner([
    { stdout: "" },
    { stdout: "" },
    { stdout: "" },
    { stdout: "" },
    { stdout: "" },
    { stdout: "https://github.com/owner/other/issues/3\n" },
  ]);

  const input = { repo: "owner/repo" };

  await gh.run(Issue.remove(1, input));
  await gh.run(Issue.lock(2, { ...input, reason: "too_heated" }));
  await gh.run(Issue.unlock(2, input));
  await gh.run(Issue.pin("--web", input));
  await gh.run(Issue.unpin(4, input));

  expect(
    await gh.run(Issue.transfer(5, { ...input, destination: "owner/other" })),
  ).toEqual({ url: "https://github.com/owner/other/issues/3" });
  expect(gh.args()).toEqual([
    ["issue", "delete", "--repo", "owner/repo", "--yes", "--", "1"],
    [
      "issue",
      "lock",
      "--repo",
      "owner/repo",
      "--reason",
      "too_heated",
      "--",
      "2",
    ],
    ["issue", "unlock", "--repo", "owner/repo", "--", "2"],
    ["issue", "pin", "--repo", "owner/repo", "--", "--web"],
    ["issue", "unpin", "--repo", "owner/repo", "--", "4"],
    ["issue", "transfer", "--repo", "owner/repo", "--", "5", "owner/other"],
  ]);
});

test("develop lists linked branches and creates one", async () => {
  const gh = scriptedSpawner([
    {
      stdout:
        "fix-1\thttps://github.com/owner/repo/tree/fix-1\nfix-2\thttps://github.com/owner/repo/tree/fix-2\n",
    },
    { stdout: "github.com/owner/repo/tree/42-new\n" },
  ]);

  expect(
    await gh.run(Issue.linkedBranches(42, { repo: "owner/repo" })),
  ).toEqual([
    { name: "fix-1", url: "https://github.com/owner/repo/tree/fix-1" },
    { name: "fix-2", url: "https://github.com/owner/repo/tree/fix-2" },
  ]);
  expect(
    await gh.run(
      Issue.develop(42, {
        repo: "owner/repo",
        base: "main",
        name: "42-new",
        checkout: true,
      }),
    ),
  ).toEqual({ url: "github.com/owner/repo/tree/42-new" });
  expect(gh.args()).toEqual([
    ["issue", "develop", "--list", "--repo", "owner/repo", "--", "42"],
    [
      "issue",
      "develop",
      "--repo",
      "owner/repo",
      "--base",
      "main",
      "--name",
      "42-new",
      "--checkout",
      "--",
      "42",
    ],
  ]);
});

test("status selects its fields and decodes the three groups", async () => {
  const item = { ...summary, labels: [{ name: "bug" }] };

  const gh = scriptedSpawner([
    {
      stdout: JSON.stringify({
        createdBy: [item],
        assigned: [],
        mentioned: [item],
      }),
    },
  ]);

  expect(await gh.run(Issue.status({ repo: "owner/repo" }))).toEqual({
    createdBy: [item],
    assigned: [],
    mentioned: [item],
  });
  expect(gh.args()).toEqual([
    [
      "issue",
      "status",
      "--json",
      "number,title,url,state,updatedAt,labels",
      "--repo",
      "owner/repo",
    ],
  ]);
});
