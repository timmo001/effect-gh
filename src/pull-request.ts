import { Effect, Schema, Stream } from "effect";
import { GhDecodeError } from "./errors.js";
import { Gh, type GhOptions } from "./gh.js";

export const Summary = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  isDraft: Schema.Boolean,
  headRefName: Schema.String,
  headRefOid: Schema.String,
});
export interface Summary extends Schema.Schema.Type<typeof Summary> {}

export const Check = Schema.Struct({
  name: Schema.String,
  state: Schema.String,
  bucket: Schema.Literals(["pass", "fail", "pending", "skipping", "cancel"]),
  link: Schema.NullOr(Schema.String),
  workflow: Schema.NullOr(Schema.String),
});
export interface Check extends Schema.Schema.Type<typeof Check> {}

export const ChecksResult = Schema.Struct({
  checks: Schema.Array(Check),
  status: Schema.Literals(["success", "failure", "pending"]),
  exitCode: Schema.Literals([0, 1, 8]),
});
export interface ChecksResult extends Schema.Schema.Type<typeof ChecksResult> {}

export interface Options extends GhOptions {
  readonly repository: string;
}

export interface ListOptions extends Options {
  readonly state?: "open" | "closed" | "merged" | "all";
  readonly limit?: number;
  readonly base?: string;
  readonly head?: string;
}

export interface ChecksOptions extends Options {
  readonly required?: boolean;
}

const fields = "number,title,url,state,isDraft,headRefName,headRefOid";

export const list = Effect.fn("PullRequest.list")(function* (
  options: ListOptions,
) {
  const gh = yield* Gh;
  const args = [
    "pr",
    "list",
    `--repo=${options.repository}`,
    `--state=${options.state ?? "open"}`,
    `--limit=${options.limit ?? 30}`,
    `--json=${fields}`,
  ];
  if (options.base !== undefined) args.push(`--base=${options.base}`);
  if (options.head !== undefined) args.push(`--head=${options.head}`);
  return yield* gh.json(args, Schema.Array(Summary), options);
});

export const view = Effect.fn("PullRequest.view")(function* (
  selector: number | string,
  options: Options,
) {
  const gh = yield* Gh;
  return yield* gh.json(
    [
      "pr",
      "view",
      `--repo=${options.repository}`,
      `--json=${fields}`,
      "--",
      String(selector),
    ],
    Summary,
    options,
  );
});

/** Failed and pending checks are data; invalid output retains the command error. */
export const checks = Effect.fn("PullRequest.checks")(function* (
  selector: number | string,
  options: ChecksOptions,
) {
  const gh = yield* Gh;
  const args = [
    "pr",
    "checks",
    `--repo=${options.repository}`,
    "--json=name,state,bucket,link,workflow",
  ];
  if (options.required) args.push("--required");
  args.push("--", String(selector));

  let stdout = "";
  const commandError = yield* gh.stream(args, options).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        if (chunk._tag === "Stdout") stdout += chunk.text;
      }),
    ),
    Effect.as(undefined),
    Effect.catchTag("GhCommandError", (error) =>
      error.exitCode === 1 || error.exitCode === 8
        ? Effect.succeed(error)
        : Effect.fail(error),
    ),
  );
  const decoded = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.Array(Check)),
  )(stdout).pipe(
    Effect.mapError((cause) => commandError ?? new GhDecodeError({ cause })),
  );
  const exitCode = commandError?.exitCode === 8 ? 8 : commandError ? 1 : 0;
  return ChecksResult.make({
    checks: decoded,
    status: exitCode === 8 ? "pending" : exitCode === 1 ? "failure" : "success",
    exitCode,
  });
});
