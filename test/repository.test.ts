import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { GhDecodeError } from "../src/errors.js";
import { layer } from "../src/gh.js";
import * as Repository from "../src/repository.js";
import { fakeSpawner, scriptedSpawner, textStream } from "./helpers.js";

const repository = {
  nameWithOwner: "owner/repo",
  url: "https://github.com/owner/repo",
  defaultBranchRef: { name: "main" },
  isPrivate: false,
};

test.each([undefined, "enterprise.example/owner/repo", "--help", "owner/a b"])(
  "repository view keeps selector literal: %s",
  async (repo) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* fakeSpawner({
          stdout: textStream(JSON.stringify(repository)),
        });

        const operation = Repository.view(repo, {
          executable: "custom-gh",
          cwd: "/workspace",
          env: { CUSTOM: "value" },
        }).pipe(Effect.provide(layer().pipe(Layer.provide(fake.layer))));

        expect(fake.commands).toHaveLength(0);
        expect(yield* operation).toEqual(repository);
        expect(fake.commands).toHaveLength(1);
        const command = fake.commands[0];

        if (command?._tag !== "StandardCommand")
          throw new Error("Expected a standard command");
        expect(command.command).toBe("custom-gh");
        expect(command.args).toEqual([
          "repo",
          "view",
          "--json",
          "nameWithOwner,url,defaultBranchRef,isPrivate",
          ...(repo === undefined ? [] : ["--", repo]),
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

test("repository view accepts a null default branch", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const empty = { ...repository, defaultBranchRef: null };

      const fake = yield* fakeSpawner({
        stdout: textStream(JSON.stringify(empty)),
      });

      expect(
        yield* Repository.view().pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
        ),
      ).toEqual(empty);
    }),
  );
});

test.each([
  "not json",
  JSON.stringify({ ...repository, isPrivate: "false" }),
  JSON.stringify({ ...repository, defaultBranchRef: {} }),
])("repository view rejects invalid output: %s", async (stdout) => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({ stdout: textStream(stdout) });
      expect(
        yield* Repository.view().pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
          Effect.flip,
        ),
      ).toBeInstanceOf(GhDecodeError);
    }),
  );
});

test("repository view propagates command failure before decoding", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({
        stderr: textStream("repository not found"),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
      });

      const error = yield* Repository.view("owner/missing").pipe(
        Effect.provide(layer().pipe(Layer.provide(fake.layer))),
        Effect.flip,
      );

      expect(error._tag).toBe("GhCommandError");
      expect(error).toMatchObject({
        exitCode: 1,
        stderr: "repository not found",
      });
    }),
  );
});

test("create passes the visibility and the name after --, and returns the URL", async () => {
  const gh = scriptedSpawner([{ stdout: "https://github.com/owner/new\n" }]);

  expect(
    await gh.run(
      Repository.create({
        name: "owner/new",
        visibility: "private",
        description: "A repo",
        addReadme: true,
        license: "mit",
      }),
    ),
  ).toEqual({ url: "https://github.com/owner/new" });
  expect(gh.args()).toEqual([
    [
      "repo",
      "create",
      "--private",
      "--description",
      "A repo",
      "--add-readme",
      "--license",
      "mit",
      "--",
      "owner/new",
    ],
  ]);
});

test("edit writes booleans as --flag=value and accepts the visibility consequences", async () => {
  const gh = scriptedSpawner([]);

  await gh.run(
    Repository.edit({
      repo: "owner/repo",
      visibility: "public",
      addTopics: ["a", "b"],
      enableWiki: false,
      deleteBranchOnMerge: true,
    }),
  );
  expect(gh.args()).toEqual([
    [
      "repo",
      "edit",
      "--visibility",
      "public",
      "--accept-visibility-change-consequences",
      "--add-topic",
      "a",
      "--add-topic",
      "b",
      "--delete-branch-on-merge=true",
      "--enable-wiki=false",
      "--",
      "owner/repo",
    ],
  ]);
});

test("remove, archive, unarchive and rename skip the prompt", async () => {
  const gh = scriptedSpawner([]);

  await gh.run(Repository.remove({ repo: "owner/repo" }));
  await gh.run(Repository.archive({ repo: "owner/repo" }));
  await gh.run(Repository.unarchive());
  await gh.run(Repository.rename({ repo: "owner/repo", newName: "other" }));
  expect(gh.args()).toEqual([
    ["repo", "delete", "--yes", "--", "owner/repo"],
    ["repo", "archive", "--yes", "--", "owner/repo"],
    ["repo", "unarchive", "--yes"],
    ["repo", "rename", "--yes", "--repo", "owner/repo", "--", "other"],
  ]);
});

test("fork never prompts and keeps git flags after --", async () => {
  const gh = scriptedSpawner([]);

  await gh.run(
    Repository.fork({
      repo: "owner/repo",
      org: "team",
      clone: true,
      gitArgs: ["--depth", "1"],
    }),
  );
  await gh.run(Repository.fork());
  expect(gh.args()).toEqual([
    [
      "repo",
      "fork",
      "owner/repo",
      "--org",
      "team",
      "--clone=true",
      "--remote=false",
      "--",
      "--depth",
      "1",
    ],
    ["repo", "fork", "--clone=false", "--remote=false"],
  ]);
});

test("list selects its fields and passes filters as flags", async () => {
  const item = {
    name: "repo",
    nameWithOwner: "owner/repo",
    description: "",
    url: "https://github.com/owner/repo",
    visibility: "PUBLIC",
    isPrivate: false,
    isFork: false,
    isArchived: false,
    updatedAt: "2026-10-26T18:02:47Z",
  };

  const gh = scriptedSpawner([{ stdout: JSON.stringify([item]) }]);

  expect(
    await gh.run(
      Repository.list({
        owner: "owner",
        limit: 5,
        fork: false,
        archived: false,
        topics: ["effect"],
      }),
    ),
  ).toEqual([item]);
  expect(gh.args()).toEqual([
    [
      "repo",
      "list",
      "--limit",
      "5",
      "--source",
      "--no-archived",
      "--topic",
      "effect",
      "--json",
      "name,nameWithOwner,description,url,visibility,isPrivate,isFork,isArchived,updatedAt",
      "--",
      "owner",
    ],
  ]);
});

test("setDefault, unsetDefault, viewDefault and sync pass their flags", async () => {
  const gh = scriptedSpawner([
    { stdout: "" },
    { stdout: "" },
    { stdout: "owner/repo\n" },
    { stdout: "" },
  ]);

  await gh.run(Repository.setDefault({ repo: "owner/repo" }));
  await gh.run(Repository.unsetDefault());
  expect(await gh.run(Repository.viewDefault())).toBe("owner/repo");
  await gh.run(
    Repository.sync({
      repo: "owner/fork",
      source: "owner/repo",
      branch: "main",
      force: true,
    }),
  );
  expect(gh.args()).toEqual([
    ["repo", "set-default", "--", "owner/repo"],
    ["repo", "set-default", "--unset"],
    ["repo", "set-default", "--view"],
    [
      "repo",
      "sync",
      "--source",
      "owner/repo",
      "--branch",
      "main",
      "--force",
      "--",
      "owner/fork",
    ],
  ]);
});
