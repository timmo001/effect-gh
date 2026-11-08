import { expect, test } from "bun:test";
import * as AgentTask from "../src/agent-task.js";
import * as Attestation from "../src/attestation.js";
import * as Discussion from "../src/discussion.js";
import * as Extension from "../src/extension.js";
import * as Release from "../src/release.js";
import * as Search from "../src/search.js";
import * as Skill from "../src/skill.js";
import { scriptedSpawner } from "./helpers.js";

const user = { login: "octocat" };

const issue = {
  number: 1,
  title: "Bug",
  state: "open",
  url: "https://github.com/o/r/issues/1",
  body: "",
  isPullRequest: false,
  commentsCount: 0,
  createdAt: "2026-10-28T12:00:00Z",
  updatedAt: "2026-10-28T12:00:00Z",
  closedAt: "0001-01-01T00:00:00Z",
  author: user,
  labels: [{ name: "bug" }],
  repository: { nameWithOwner: "o/r" },
};

test("search commits, issues, prs and repos pass filters and decode results", async () => {
  const commit = {
    sha: "abc",
    url: "https://github.com/o/r/commit/abc",
    commit: { message: "fix", author: { name: "A", date: "2026-10-28" } },
    author: null,
    repository: { fullName: "o/r", isPrivate: false },
  };

  const repo = {
    fullName: "o/r",
    name: "r",
    description: "",
    url: "https://github.com/o/r",
    language: "TypeScript",
    stargazersCount: 3,
    forksCount: 1,
    openIssuesCount: 0,
    isArchived: false,
    isFork: false,
    isPrivate: false,
    visibility: "public",
    defaultBranch: "main",
    pushedAt: "2026-10-28T12:00:00Z",
    updatedAt: "2026-10-28T12:00:00Z",
    owner: user,
  };

  const gh = scriptedSpawner([
    { stdout: JSON.stringify([commit]) },
    { stdout: JSON.stringify([issue]) },
    { stdout: JSON.stringify([{ ...issue, isDraft: false }]) },
    { stdout: JSON.stringify([repo]) },
  ]);

  expect(
    await gh.run(
      Search.commits({ query: "fix", owner: ["o"], hash: "abc", limit: 5 }),
    ),
  ).toEqual([commit]);
  expect(
    await gh.run(Search.issues({ query: "bug", includePrs: true })),
  ).toEqual([issue]);
  expect(
    await gh.run(Search.prs({ query: "x", draft: false, review: "approved" })),
  ).toEqual([{ ...issue, isDraft: false }]);
  expect(
    await gh.run(
      Search.repos({ query: "q", topic: ["a", "b"], sort: "stars" }),
    ),
  ).toEqual([repo]);

  const [commits, issues, prs, repos] = gh.args();
  expect(commits?.slice(0, 2)).toEqual(["search", "commits"]);
  expect(commits?.slice(-2)).toEqual(["--", "fix"]);
  expect(commits).toContain("--hash");
  expect(issues).toContain("--include-prs");
  expect(prs).toContain("--draft=false");
  expect(prs).toContain("approved");
  expect(repos).toContain("--sort");
  expect(repos?.filter((arg) => arg === "--topic")).toHaveLength(2);
});

test("release verify and verifyAsset pass the tag and file after --", async () => {
  const gh = scriptedSpawner([{ stdout: "" }, { stdout: "" }]);

  await gh.run(Release.verify({ repo: "o/r", tag: "v1" }));
  await gh.run(Release.verifyAsset({ repo: "o/r", file: "a.tgz" }));
  expect(gh.args()).toEqual([
    ["release", "verify", "--repo", "o/r", "--", "v1"],
    ["release", "verify-asset", "--repo", "o/r", "--", "a.tgz"],
  ]);
});

test("attestation download, verify and trustedRoot build their argv", async () => {
  const result = [{ attestation: { a: 1 }, verificationResult: { b: 2 } }];

  const gh = scriptedSpawner([
    { stdout: "" },
    { stdout: JSON.stringify(result) },
    { stdout: '{"mediaType":"x"}\n' },
  ]);

  await gh.run(
    Attestation.download({ owner: "o", artifact: "a.tgz", limit: 3 }),
  );
  expect(
    await gh.run(
      Attestation.verify({
        repo: "o/r",
        artifact: "oci://img",
        signerWorkflow: "o/r/.github/workflows/x.yml",
        denySelfHostedRunners: true,
      }),
    ),
  ).toEqual(result);
  expect(await gh.run(Attestation.trustedRoot({ tufUrl: "https://t" }))).toBe(
    '{"mediaType":"x"}\n',
  );
  expect(gh.args()).toEqual([
    ["attestation", "download", "--owner", "o", "--limit", "3", "--", "a.tgz"],
    [
      "attestation",
      "verify",
      "--format",
      "json",
      "--repo",
      "o/r",
      "--deny-self-hosted-runners",
      "--signer-workflow",
      "o/r/.github/workflows/x.yml",
      "--",
      "oci://img",
    ],
    ["attestation", "trusted-root", "--tuf-url", "https://t"],
  ]);
});

test("extension search, exec and create build their argv", async () => {
  const found = {
    fullName: "o/gh-x",
    name: "gh-x",
    description: "",
    url: "https://github.com/o/gh-x",
    stargazersCount: 2,
    updatedAt: "2026-10-28T12:00:00Z",
  };

  const gh = scriptedSpawner([
    { stdout: JSON.stringify([found]) },
    { stdout: "out" },
    { stdout: "" },
  ]);

  expect(
    await gh.run(Extension.search({ query: "dash", owner: ["o"], limit: 2 })),
  ).toEqual([found]);
  expect(await gh.run(Extension.exec("x", ["--help"]))).toBe("out");
  await gh.run(Extension.create({ name: "gh-y", precompiled: "go" }));

  const [search, exec, create] = gh.args();
  expect(search?.slice(-2)).toEqual(["--", "dash"]);
  expect(search).toContain("--owner");
  expect(exec).toEqual(["extension", "exec", "x", "--help"]);
  expect(create).toEqual([
    "extension",
    "create",
    "--precompiled=go",
    "--",
    "gh-y",
  ]);
});

test("discussion create and edit use gh discussion", async () => {
  const gh = scriptedSpawner([
    { stdout: "https://github.com/o/r/discussions/9\n" },
    { stdout: "" },
  ]);

  expect(
    await gh.run(
      Discussion.create({
        repo: "o/r",
        title: "T",
        body: "B",
        category: "General",
        labels: ["x"],
      }),
    ),
  ).toEqual({ url: "https://github.com/o/r/discussions/9" });
  await gh.run(
    Discussion.edit({ discussion: 9, title: "N", addLabels: ["y"] }),
  );
  expect(gh.args()).toEqual([
    [
      "discussion",
      "create",
      "--repo",
      "o/r",
      "--title",
      "T",
      "--body",
      "B",
      "--category",
      "General",
      "--label",
      "x",
    ],
    ["discussion", "edit", "--title", "N", "--add-label", "y", "--", "9"],
  ]);
});

test("agent-task create, list and view build argv and decode tasks", async () => {
  const task = {
    id: "78368e89",
    name: "Review",
    state: "completed",
    repository: "o/r",
    user: "octocat",
    pullRequestNumber: 5,
    pullRequestState: "MERGED",
    pullRequestTitle: "Title",
    pullRequestUrl: "https://github.com/o/r/pull/5",
    createdAt: "2026-11-06T15:29:11.359502963Z",
    updatedAt: "2026-11-06T15:29:42.870537414Z",
    completedAt: "2026-11-06T15:29:41Z",
  };

  const gh = scriptedSpawner([
    { stdout: "https://github.com/o/r/pull/5\n" },
    { stdout: JSON.stringify([task]) },
    { stdout: JSON.stringify(task) },
  ]);

  expect(
    await gh.run(AgentTask.create({ description: "build", repo: "o/r" })),
  ).toBe("https://github.com/o/r/pull/5");
  expect(await gh.run(AgentTask.list({ limit: 1 }))).toEqual([task]);
  expect(await gh.run(AgentTask.view({ task: 5 }))).toEqual(task);

  const [create, list, view] = gh.args();
  expect(create).toEqual([
    "agent-task",
    "create",
    "--repo",
    "o/r",
    "--",
    "build",
  ]);
  expect(list?.slice(0, 2)).toEqual(["agent-task", "list"]);
  expect(view?.slice(-2)).toEqual(["--", "5"]);
});

test("skill commands build argv and decode list and search", async () => {
  const installed = {
    skillName: "x",
    agentHosts: ["codex"],
    scope: "user",
    sourceURL: "",
    version: "",
    pinned: false,
    path: "/home/a/.agents/skills/x",
  };

  const found = {
    repo: "o/r",
    skillName: "x",
    namespace: "",
    description: "d",
    stars: 4,
    path: "skills/x",
  };

  const gh = scriptedSpawner([
    { stdout: JSON.stringify([installed]) },
    { stdout: JSON.stringify([found]) },
    { stdout: "" },
    { stdout: "" },
    { stdout: "# x" },
    { stdout: "" },
  ]);

  expect(await gh.run(Skill.list({ scope: "user" }))).toEqual([installed]);
  expect(await gh.run(Skill.search({ query: "x", owner: "o" }))).toEqual([
    found,
  ]);
  await gh.run(
    Skill.install({
      source: "o/r",
      skill: "x",
      agent: "codex",
      scope: "user",
      force: true,
    }),
  );
  await gh.run(Skill.update({ skills: ["x"], dryRun: true }));
  expect(await gh.run(Skill.preview({ repository: "o/r", skill: "x" }))).toBe(
    "# x",
  );
  await gh.run(Skill.publish({ tag: "v1", dryRun: true }));

  const [, , install, update, preview, publish] = gh.args();
  expect(install).toEqual([
    "skill",
    "install",
    "--force",
    "--agent",
    "codex",
    "--scope",
    "user",
    "--",
    "o/r",
    "x",
  ]);
  expect(update).toEqual(["skill", "update", "--dry-run", "--", "x"]);
  expect(preview).toEqual(["skill", "preview", "--", "o/r", "x"]);
  expect(publish).toEqual(["skill", "publish", "--dry-run", "--tag", "v1"]);
});
