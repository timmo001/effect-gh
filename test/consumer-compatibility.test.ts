import { expect, test } from "bun:test";
import { Effect, Layer, Sink } from "effect";
import { ChildProcess } from "effect/unstable/process";
import {
  listNotifications,
  markDone,
  markRead,
  setIgnored,
  type Notification,
} from "../examples/notifications.js";
import {
  failedLogs,
  listAttemptJobs,
  listBranchRuns,
  type Run,
} from "../examples/workflow-runs.js";
import { GhDecodeError, layer } from "../src/index.js";
import { fakeSpawner, textStream } from "./helpers.js";

const firstCommand = (commands: ReadonlyArray<ChildProcess.Command>) => {
  const command = commands[0];

  if (command?._tag !== "StandardCommand")
    throw new Error("Expected a standard command");

  return command;
};

const notification = {
  id: "123",
  unread: true,
  reason: "subscribed",
  updated_at: "2026-09-09T12:00:00Z",
  last_read_at: null,
  url: "https://api.github.com/notifications/threads/123",
  repository: {
    full_name: "owner/repo",
    html_url: "https://github.com/owner/repo",
  },
  subject: {
    title: "CI",
    type: "WorkflowRun",
    url: null,
    latest_comment_url: null,
  },
} satisfies Notification;

const sha = "a".repeat(40);

const run = {
  id: 42,
  run_attempt: 2,
  name: null,
  display_title: "Check changes",
  head_branch: "feature/sdk",
  head_sha: sha,
  status: "in_progress",
  conclusion: null,
  html_url: "https://github.com/owner/repo/actions/runs/42",
} satisfies Run;

test("notification lists preserve nullable URLs and report only the fetched page count", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const threads = Array.from({ length: 50 }, (_, index) => ({
        ...notification,
        id: String(index),
      }));

      const fake = yield* fakeSpawner({
        stdout: textStream(JSON.stringify(threads)),
      });

      const result = yield* listNotifications({
        all: true,
        participating: true,
        since: "2026-09-09T12:00:00Z",
      }).pipe(Effect.provide(layer().pipe(Layer.provide(fake.layer))));

      expect(result).toEqual({ threads, fetchedCount: 50, mayHaveMore: true });
      expect(firstCommand(fake.commands).args).toEqual([
        "api",
        "--method",
        "GET",
        "--",
        "notifications?per_page=50&all=true&participating=true&since=2026-09-09T12%3A00%3A00Z",
      ]);
    }),
  );
});

test("notification schemas reject non-string subject URLs at the Gh boundary", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({
        stdout: textStream(
          JSON.stringify([
            {
              ...notification,
              subject: { ...notification.subject, url: 42 },
            },
          ]),
        ),
      });

      const error = yield* listNotifications().pipe(
        Effect.provide(layer().pipe(Layer.provide(fake.layer))),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(GhDecodeError);
    }),
  );
});

test.each([
  { method: "PATCH", action: markRead },
  { method: "DELETE", action: markDone },
])(
  "notification $method accepts empty 204-style output without decoding JSON",
  async ({ method, action }) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* fakeSpawner();
        const request = action("thread/123");
        expect(fake.commands).toHaveLength(0);
        expect(
          yield* request.pipe(
            Effect.provide(
              layer({ stdin: "unused body" }).pipe(Layer.provide(fake.layer)),
            ),
          ),
        ).toEqual({ stdout: "", stderr: "", exitCode: 0 });
        expect(fake.commands).toHaveLength(1);
        const command = firstCommand(fake.commands);
        expect(command.args).toEqual([
          "api",
          "--method",
          method,
          "--",
          "notifications/threads/thread%2F123",
        ]);
        expect(command.options.stdin).toBe("ignore");
      }),
    );
  },
);

test.each([true, false])(
  "notification ignored=%s sends a boolean JSON body and accepts empty output",
  async (ignored) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let stdin = "";

        const fake = yield* fakeSpawner({
          stdin: Sink.forEach((chunk: Uint8Array) =>
            Effect.sync(() => {
              stdin += new TextDecoder().decode(chunk);
            }),
          ),
        });

        const request = setIgnored("123", ignored);
        expect(fake.commands).toHaveLength(0);
        expect(
          yield* request.pipe(
            Effect.provide(layer().pipe(Layer.provide(fake.layer))),
          ),
        ).toEqual({ stdout: "", stderr: "", exitCode: 0 });
        expect(stdin).toBe(JSON.stringify({ ignored }));
        expect(fake.commands).toHaveLength(1);
        expect(firstCommand(fake.commands).args).toEqual([
          "api",
          "--method",
          "PUT",
          "--input",
          "-",
          "--",
          "notifications/threads/123/subscription",
        ]);
      }),
    );
  },
);

test("workflow pages preserve envelopes and attempts while selecting both branch and SHA", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const previousAttempt = { ...run, run_attempt: 1 };

      const pages = [
        {
          total_count: 6,
          workflow_runs: [
            previousAttempt,
            { ...run, id: 43, head_sha: "b".repeat(40) },
          ],
        },
        {
          total_count: 6,
          workflow_runs: [
            run,
            { ...run, id: 44, head_branch: null },
            { ...run, id: 45, head_branch: "main" },
          ],
        },
      ];

      const fake = yield* fakeSpawner({
        stdout: textStream(JSON.stringify(pages)),
      });

      const result = yield* listBranchRuns(
        "owner/repo",
        "feature/sdk",
        sha,
      ).pipe(Effect.provide(layer().pipe(Layer.provide(fake.layer))));

      expect(result).toEqual({ pages, runs: [previousAttempt, run] });
      expect(firstCommand(fake.commands).args).toEqual([
        "api",
        "--method",
        "GET",
        "--hostname=github.com",
        "--paginate",
        "--slurp",
        "--",
        `repos/owner/repo/actions/runs?branch=feature%2Fsdk&head_sha=${sha}&per_page=100`,
      ]);
    }),
  );
});

test("attempt jobs retain page shapes, optional steps and nullable conclusions", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const job = {
        id: 10,
        name: "Build",
        conclusion: null,
        html_url: `${run.html_url}/job/10`,
      };

      const failed = {
        ...job,
        id: 11,
        conclusion: "failure",
        steps: [
          { number: 1, name: "Compile", conclusion: "failure" },
          { number: 2, name: "Upload", conclusion: null },
        ],
      };

      const pages = [{ jobs: [job] }, { jobs: [failed] }];

      const fake = yield* fakeSpawner({
        stdout: textStream(JSON.stringify(pages)),
      });

      expect(
        yield* listAttemptJobs("owner/repo", run).pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
        ),
      ).toEqual({ pages, jobs: [job, failed] });
      expect(firstCommand(fake.commands).args).toEqual([
        "api",
        "--method",
        "GET",
        "--hostname=github.com",
        "--paginate",
        "--slurp",
        "--",
        "repos/owner/repo/actions/runs/42/attempts/2/jobs?per_page=100",
      ]);
    }),
  );
});

test("failed logs select the same run attempt and preserve plain text", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const logs = "Build\tCompile\terror: check failed\n";
      const fake = yield* fakeSpawner({ stdout: textStream(logs) });
      expect(
        yield* failedLogs("owner/repo", run).pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
        ),
      ).toBe(logs);
      expect(firstCommand(fake.commands).args).toEqual([
        "run",
        "view",
        "42",
        "--repo",
        "github.com/owner/repo",
        "--log-failed",
        "--attempt",
        "2",
      ]);
    }),
  );
});
