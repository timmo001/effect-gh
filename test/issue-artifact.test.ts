import { expect, test } from "bun:test";
import * as IssueArtifact from "../src/issue-artifact.js";
import { scriptedSpawner } from "./helpers.js";

const artifact = {
  id: 9_007_199_254,
  number: 2,
  name: "Sign-in plan",
  type: "plan",
  description: "",
  body: "# Plan",
  bodyHtml: "<h1>Plan</h1>",
  url: "https://github.com/owner/repo/issues/142/artifacts/2",
  creator: { id: 1, login: "monalisa" },
  createdAt: "2026-10-01T12:00:00Z",
  updatedByActor: null,
  updatedAt: null,
} satisfies IssueArtifact.Artifact;

test("issue artifact view decodes deleted actors and missing times in the edit history", async () => {
  const versions = [
    {
      version: 2,
      name: "Sign-in plan",
      body: "# Plan",
      bodyHtml: "<h1>Plan</h1>",
      createdAt: null,
      actor: null,
    },
    {
      version: 1,
      name: "Plan",
      body: "",
      bodyHtml: "",
      createdAt: "2026-10-01T12:00:00Z",
      actor: { id: 1, login: "monalisa" },
    },
  ];

  const gh = scriptedSpawner([
    { stdout: JSON.stringify({ ...artifact, versions }) },
  ]);

  expect(
    await gh.run(IssueArtifact.view(142, 2, { repo: "owner/repo" })),
  ).toEqual({ ...artifact, versions });

  expect(gh.args()[0]).toEqual([
    "issue",
    "artifact",
    "view",
    "--json",
    "id,number,name,type,description,body,bodyHtml,url,creator,createdAt,updatedByActor,updatedAt,versions",
    "--repo",
    "owner/repo",
    "--",
    "142",
    "2",
  ]);
});

test("issue artifact results keep artifacts saved before gh failed", () => {
  expect(
    IssueArtifact.parseResults(
      [
        "created\t3\tplan.md\tdocs/plan.md\t",
        "created\t4\tnotes\tnotes.md\tcould not upload ./a.png",
        "failed\t\t\tmissing.md\tno such file",
        "",
      ].join("\n"),
    ),
  ).toEqual([
    {
      status: "created",
      number: 3,
      name: "plan.md",
      source: "docs/plan.md",
      reason: "",
    },
    {
      status: "created",
      number: 4,
      name: "notes",
      source: "notes.md",
      reason: "could not upload ./a.png",
    },
    {
      status: "failed",
      name: "",
      source: "missing.md",
      reason: "no such file",
    },
  ]);
});
