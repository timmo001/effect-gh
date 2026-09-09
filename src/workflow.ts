import { Effect, Schema, Stream } from "effect";
import { Gh, type GhOptions } from "./gh.js";

const positiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const repository = Schema.String.check(
  Schema.isPattern(
    /^(?:[a-zA-Z0-9.-]+(?::[0-9]+)?\/)?[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/,
  ),
);

export const Run = Schema.Struct({
  databaseId: positiveInteger,
  attempt: positiveInteger,
  headBranch: Schema.NullOr(Schema.String),
  headSha: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  url: Schema.String,
  workflowName: Schema.NullOr(Schema.String),
});
export interface Run extends Schema.Schema.Type<typeof Run> {}

const fields = Object.keys(Run.fields).join(",");

const listOptions = Schema.Struct({
  repo: repository,
  limit: Schema.optionalKey(positiveInteger),
  branch: Schema.optionalKey(Schema.NonEmptyString),
  commit: Schema.optionalKey(Schema.NonEmptyString),
  workflow: Schema.optionalKey(Schema.NonEmptyString),
  status: Schema.optionalKey(
    Schema.Literals([
      "queued",
      "completed",
      "in_progress",
      "requested",
      "waiting",
      "pending",
      "action_required",
      "cancelled",
      "failure",
      "neutral",
      "skipped",
      "stale",
      "startup_failure",
      "success",
      "timed_out",
    ]),
  ),
});
export interface ListOptions extends Schema.Schema.Type<typeof listOptions> {}

const viewOptions = Schema.Struct({
  repo: repository,
  runId: positiveInteger,
  attempt: Schema.optionalKey(positiveInteger),
});
export interface ViewOptions extends Schema.Schema.Type<typeof viewOptions> {}

const logsOptions = Schema.Struct({
  ...viewOptions.fields,
  failedOnly: Schema.optionalKey(Schema.Boolean),
  job: Schema.optionalKey(positiveInteger),
});
export interface LogsOptions extends Schema.Schema.Type<typeof logsOptions> {}

const watchOptions = Schema.Struct({
  repo: repository,
  runId: positiveInteger,
  interval: Schema.optionalKey(positiveInteger),
});
export interface WatchOptions extends Schema.Schema.Type<typeof watchOptions> {}

export class InvalidOptions extends Schema.TaggedError<InvalidOptions>()(
  "WorkflowInvalidOptions",
  { cause: Schema.Defect() },
) {}

const decodeOptions = Effect.fn("Workflow.decodeOptions")(function* <
  S extends Schema.Constraint,
>(schema: S, input: S["Type"]) {
  return yield* Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => new InvalidOptions({ cause })),
  );
});

/** Fetch at most `limit` recent runs (default 20), without unbounded pagination. */
export const list = Effect.fn("Workflow.list")(function* (
  input: ListOptions,
  options?: GhOptions,
) {
  const query = yield* decodeOptions(listOptions, input);
  const gh = yield* Gh;
  const args = [
    "run",
    "list",
    "--repo",
    query.repo,
    "--limit",
    String(query.limit ?? 20),
    "--json",
    fields,
  ];
  if (query.branch !== undefined) args.push("--branch", query.branch);
  if (query.commit !== undefined) args.push("--commit", query.commit);
  if (query.workflow !== undefined) args.push("--workflow", query.workflow);
  if (query.status !== undefined) args.push("--status", query.status);
  return yield* gh.json(args, Schema.Array(Run), options);
});

/** View the latest attempt unless an explicit attempt is supplied. */
export const view = Effect.fn("Workflow.view")(function* (
  input: ViewOptions,
  options?: GhOptions,
) {
  const query = yield* decodeOptions(viewOptions, input);
  const gh = yield* Gh;
  const args = [
    "run",
    "view",
    String(query.runId),
    "--repo",
    query.repo,
    "--json",
    fields,
  ];
  if (query.attempt !== undefined)
    args.push("--attempt", String(query.attempt));
  return yield* gh.json(args, Run, options);
});

/** Fetch full logs or failed steps, optionally for one attempt and job. */
export const logs = Effect.fn("Workflow.logs")(function* (
  input: LogsOptions,
  options?: GhOptions,
) {
  const query = yield* decodeOptions(logsOptions, input);
  const gh = yield* Gh;
  const args = [
    "run",
    "view",
    String(query.runId),
    "--repo",
    query.repo,
    query.failedOnly ? "--log-failed" : "--log",
  ];
  if (query.attempt !== undefined)
    args.push("--attempt", String(query.attempt));
  if (query.job !== undefined) args.push("--job", String(query.job));
  return (yield* gh.execute(args, options)).stdout;
});

/**
 * Stream native CLI progress, failing if the run fails. Requires gh with
 * `--compact` support; gh watch cannot authenticate with fine-grained PATs.
 * Inherits the core timeout; pass `{ timeout: null }` to disable it.
 */
export const watch = (input: WatchOptions, options?: GhOptions) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const query = yield* decodeOptions(watchOptions, input);
      const gh = yield* Gh;
      return gh.stream(
        [
          "run",
          "watch",
          String(query.runId),
          "--repo",
          query.repo,
          "--compact",
          "--exit-status",
          "--interval",
          String(query.interval ?? 3),
        ],
        options,
      );
    }),
  );
