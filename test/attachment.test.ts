import { expect, test } from "bun:test";
import { GhInvalidOptionsError } from "../src/errors.js";
import * as Attachment from "../src/attachment.js";
import { scriptedSpawner } from "./helpers.js";

test("upload looks up the repository ID and posts the file through gh", async () => {
  const fake = scriptedSpawner([
    { stdout: JSON.stringify({ id: 42, private: false }) },
    {
      stdout: JSON.stringify({
        url: "https://github.com/user-attachments/assets/abc",
      }),
    },
  ]);

  expect(
    await fake.run(
      Attachment.upload({
        repository: "owner/repo",
        path: "/tmp/shots/Before Fix.PNG",
      }),
    ),
  ).toBe("https://github.com/user-attachments/assets/abc");
  expect(fake.args()).toEqual([
    ["api", "--method", "GET", "--", "repos/owner/repo"],
    [
      "api",
      "--method",
      "POST",
      "--header=Content-Type: application/octet-stream",
      "--input",
      "/tmp/shots/Before Fix.PNG",
      "--",
      "https://uploads.github.com/user-attachments/assets?name=Before+Fix.PNG&content_type=image%2Fpng&repository_id=42",
    ],
  ]);
});

test("upload refuses private repositories before posting", async () => {
  const fake = scriptedSpawner([
    { stdout: JSON.stringify({ id: 42, private: true }) },
  ]);

  const error = await fake.fail(
    Attachment.upload({ repository: "owner/private", path: "a.png" }),
  );

  expect(error).toBeInstanceOf(Attachment.PrivateRepositoryError);
  expect(fake.commands).toHaveLength(1);
});

test("upload rejects stdin and host-qualified repositories", async () => {
  const fake = scriptedSpawner([]);

  for (const input of [
    { repository: "owner/repo", path: "-" },
    { repository: "github.example/owner/repo", path: "a.png" },
  ])
    expect(await fake.fail(Attachment.upload(input))).toBeInstanceOf(
      GhInvalidOptionsError,
    );

  expect(fake.commands).toHaveLength(0);
});

test("contentType falls back to octet-stream", () => {
  expect(Attachment.contentType("clip.webm")).toBe("video/webm");
  expect(Attachment.contentType("notes")).toBe("application/octet-stream");
});
