import { Effect, Schema } from "effect";
import { Api, Workflow } from "../src/index.js";

const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));

export const Run = Schema.Struct({
  id: Schema.Int,
  run_attempt: Schema.Int,
  name: Schema.NullOr(Schema.String),
  display_title: Schema.String,
  head_branch: Schema.NullOr(Schema.String),
  head_sha: Sha,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.String,
});

export interface Run extends Schema.Schema.Type<typeof Run> {}

const RunPage = Schema.Struct({
  total_count: Schema.Int,
  workflow_runs: Schema.Array(Run),
});

const Job = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  steps: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        number: Schema.Int,
        name: Schema.String,
        conclusion: Schema.NullOr(Schema.String),
      }),
    ),
  ),
});

export const listBranchRuns = Effect.fn("WorkflowRuns.listBranchRuns")(
  function* (repo: string, branch: string, sha: string) {
    const pages = yield* Api.pages(
      {
        endpoint: `repos/${repo}/actions/runs`,
        method: "GET",
        hostname: "github.com",
        query: { branch, head_sha: sha, per_page: 100 },
      },
      RunPage,
    );

    // Retain envelopes for callers that check completeness or reconcile attempts.
    return {
      pages,
      runs: pages
        .flatMap((page) => page.workflow_runs)
        .filter((run) => run.head_branch === branch && run.head_sha === sha),
    };
  },
);

export const listAttemptJobs = Effect.fn("WorkflowRuns.listAttemptJobs")(
  function* (repo: string, run: Run) {
    const pages = yield* Api.pages(
      {
        endpoint: `repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
        method: "GET",
        hostname: "github.com",
        query: { per_page: 100 },
      },
      Schema.Struct({ jobs: Schema.Array(Job) }),
    );

    return { pages, jobs: pages.flatMap((page) => page.jobs) };
  },
);

export const failedLogs = Effect.fn("WorkflowRuns.failedLogs")(function* (
  repo: string,
  run: Run,
) {
  return yield* Workflow.logs({
    repo: `github.com/${repo}`,
    runId: run.id,
    attempt: run.run_attempt,
    failedOnly: true,
  });
});
