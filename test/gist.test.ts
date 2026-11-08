import { expect, test } from "bun:test";
import * as Gist from "../src/gist.js";
import { scriptedSpawner } from "./helpers.js";

test("create sends content on stdin or files after --, and returns the URL", async () => {
  const url = "https://gist.github.com/octocat/abc123";
  const gh = scriptedSpawner([{ stdout: `${url}\n` }, { stdout: `${url}\n` }]);

  expect(
    await gh.run(
      Gist.create({
        content: "hello",
        filename: "hello.txt",
        description: "greeting",
        public: true,
      }),
    ),
  ).toEqual({ url });
  expect(await gh.run(Gist.create({ files: ["a.md", "b.md"] }))).toEqual({
    url,
  });
  expect(gh.args()).toEqual([
    [
      "gist",
      "create",
      "--desc",
      "greeting",
      "--public",
      "--filename",
      "hello.txt",
      "-",
    ],
    ["gist", "create", "--", "a.md", "b.md"],
  ]);
  expect(gh.stdins[0]).toBe("hello");
});

test("list parses the table and passes filters as flags", async () => {
  const gh = scriptedSpawner([
    {
      stdout:
        "abc123\tmy notes\t2 files\tsecret\t2026-10-26T18:02:47Z\n" +
        "def456\t\t1 file\tpublic\t2026-10-27T09:00:00Z\n",
    },
  ]);

  expect(
    await gh.run(
      Gist.list({ limit: 5, filter: "notes", visibility: "secret" }),
    ),
  ).toEqual([
    {
      id: "abc123",
      description: "my notes",
      files: 2,
      public: false,
      updatedAt: "2026-10-26T18:02:47Z",
    },
    {
      id: "def456",
      description: "",
      files: 1,
      public: true,
      updatedAt: "2026-10-27T09:00:00Z",
    },
  ]);
  expect(gh.args()).toEqual([
    ["gist", "list", "--limit", "5", "--filter", "notes", "--secret"],
  ]);
});

test("remove, edit, rename, view and clone build their argv", async () => {
  const gh = scriptedSpawner([
    { stdout: "" },
    { stdout: "" },
    { stdout: "" },
    { stdout: "print('hi')\n" },
    { stdout: "a.py\nb.py\n" },
  ]);

  await gh.run(Gist.remove("abc123"));
  await gh.run(
    Gist.edit({
      gist: "abc123",
      description: "new",
      filename: "a.py",
      file: "local.py",
    }),
  );
  await gh.run(
    Gist.rename({ gist: "abc123", oldFilename: "a.py", newFilename: "b.py" }),
  );
  expect(await gh.run(Gist.view({ gist: "abc123", filename: "a.py" }))).toBe(
    "print('hi')\n",
  );
  expect(await gh.run(Gist.viewFiles("abc123"))).toEqual(["a.py", "b.py"]);
  await gh.run(Gist.clone({ gist: "abc123", directory: "work" }));
  expect(gh.args()).toEqual([
    ["gist", "delete", "--yes", "--", "abc123"],
    [
      "gist",
      "edit",
      "--desc",
      "new",
      "--filename",
      "a.py",
      "--",
      "abc123",
      "local.py",
    ],
    ["gist", "rename", "--", "abc123", "a.py", "b.py"],
    ["gist", "view", "--raw", "--filename", "a.py", "--", "abc123"],
    ["gist", "view", "--files", "--", "abc123"],
    ["gist", "clone", "abc123", "work"],
  ]);
});
