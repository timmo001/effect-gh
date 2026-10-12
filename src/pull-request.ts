import { Effect, Match, Predicate, Schema, Stream, Struct } from "effect";
import { GhDecodeError } from "./errors.js";
import { Gh, type GhOptions } from "./gh.js";

const Author = Schema.Struct({ login: Schema.String });

/** Every `gh pr --json` field the typed reads can select. */
export const Fields = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  isDraft: Schema.Boolean,
  headRefName: Schema.String,
  headRefOid: Schema.String,
  baseRefName: Schema.String,
  body: Schema.String,
  author: Author,
  mergeStateStatus: Schema.String,
  reviewDecision: Schema.String,
  comments: Schema.Array(
    Schema.Struct({
      author: Author,
      body: Schema.String,
      createdAt: Schema.String,
    }),
  ),
  reviews: Schema.Array(
    Schema.Struct({
      author: Author,
      state: Schema.String,
      body: Schema.String,
      submittedAt: Schema.String,
    }),
  ),
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  assignees: Schema.Array(Author),
  mergedAt: Schema.NullOr(Schema.String),
  autoMergeRequest: Schema.NullOr(
    Schema.Struct({ mergeMethod: Schema.String }),
  ),
  commits: Schema.Array(
    Schema.Struct({ oid: Schema.String, messageHeadline: Schema.String }),
  ),
});

export interface Fields extends Schema.Schema.Type<typeof Fields> {}

export type Field = keyof typeof Fields.fields;

/** The selected fields of a pull request. */
export type Selected<F extends ReadonlyArray<Field>> = Pick<Fields, F[number]>;

const selection = <const F extends ReadonlyArray<Field>>(fields: F) =>
  Fields.mapFields(Struct.pick(fields));

const repoArgs = (repository: string | undefined) =>
  repository === undefined ? [] : [`--repo=${repository}`];

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
        if (Predicate.isTagged(chunk, "Stdout")) stdout += chunk.text;
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
    status: Match.value(exitCode).pipe(
      Match.when(8, () => "pending" as const),
      Match.when(1, () => "failure" as const),
      Match.when(0, () => "success" as const),
      Match.exhaustive,
    ),
    exitCode,
  });
});

/** Input for {@link get}. */
export interface GetInput<F extends ReadonlyArray<Field>> {
  /** Number, URL or branch. Defaults to the working directory's current branch. */
  readonly selector?: number | string;
  /** [HOST/]OWNER/REPO. Defaults to the working directory's repository. */
  readonly repository?: string;
  readonly fields: F;
}

/** View one pull request, decoding exactly the selected fields. */
export const get = Effect.fn("PullRequest.get")(function* <
  const F extends ReadonlyArray<Field>,
>(input: GetInput<F>, options?: GhOptions) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "pr",
      "view",
      ...repoArgs(input.repository),
      `--json=${input.fields.join(",")}`,
      ...(input.selector === undefined ? [] : ["--", String(input.selector)]),
    ],
    selection(input.fields),
    options,
  );
});

/** Input for {@link query}. */
export interface QueryInput<F extends ReadonlyArray<Field>> {
  readonly repository?: string;
  readonly fields: F;
  readonly state?: "open" | "closed" | "merged" | "all";
  readonly limit?: number;
  readonly base?: string;
  readonly head?: string;
  readonly search?: string;
}

/** List pull requests, decoding exactly the selected fields. Defaults to 30 open pull requests. */
export const query = Effect.fn("PullRequest.query")(function* <
  const F extends ReadonlyArray<Field>,
>(input: QueryInput<F>, options?: GhOptions) {
  const gh = yield* Gh;

  const args = [
    "pr",
    "list",
    ...repoArgs(input.repository),
    `--state=${input.state ?? "open"}`,
    `--limit=${input.limit ?? 30}`,
    `--json=${input.fields.join(",")}`,
  ];

  if (input.base !== undefined) args.push(`--base=${input.base}`);

  if (input.head !== undefined) args.push(`--head=${input.head}`);

  if (input.search !== undefined) args.push(`--search=${input.search}`);

  return yield* gh.json(args, Schema.Array(selection(input.fields)), options);
});

/** Input for {@link create}. */
export interface CreateInput {
  readonly repository: string;
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string;
  readonly assignees?: ReadonlyArray<string>;
  readonly draft?: boolean;
}

/** Open a pull request and return its URL. */
export const create = Effect.fn("PullRequest.create")(function* (
  input: CreateInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const args = [
    "pr",
    "create",
    `--repo=${input.repository}`,
    `--base=${input.base}`,
    `--head=${input.head}`,
    `--title=${input.title}`,
    `--body=${input.body}`,
  ];

  for (const assignee of input.assignees ?? [])
    args.push(`--assignee=${assignee}`);

  if (input.draft) args.push("--draft");
  const output = yield* gh.execute(args, options);

  return { url: output.stdout.trim().split("\n").at(-1) ?? "" };
});

/** Input for {@link edit}. */
export interface EditInput {
  readonly repository: string;
  readonly title?: string;
  readonly body?: string;
  readonly addAssignees?: ReadonlyArray<string>;
  readonly addLabels?: ReadonlyArray<string>;
  readonly removeLabels?: ReadonlyArray<string>;
}

/** Change a pull request's title, body, assignees or labels. */
export const edit = Effect.fn("PullRequest.edit")(function* (
  selector: number | string,
  input: EditInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const args = ["pr", "edit", `--repo=${input.repository}`];

  if (input.title !== undefined) args.push(`--title=${input.title}`);

  if (input.body !== undefined) args.push(`--body=${input.body}`);

  for (const assignee of input.addAssignees ?? [])
    args.push(`--add-assignee=${assignee}`);

  for (const label of input.addLabels ?? []) args.push(`--add-label=${label}`);

  for (const label of input.removeLabels ?? [])
    args.push(`--remove-label=${label}`);
  args.push("--", String(selector));
  yield* gh.execute(args, options);
});

/** Input for {@link merge}. */
export interface MergeInput {
  readonly repository: string;
  readonly method: "merge" | "squash" | "rebase";
  /** Enable auto-merge instead of merging now. */
  readonly auto?: boolean;
}

/** Merge a pull request, or enable auto-merge with `auto`. */
export const merge = Effect.fn("PullRequest.merge")(function* (
  selector: number | string,
  input: MergeInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "pr",
      "merge",
      `--repo=${input.repository}`,
      `--${input.method}`,
      ...(input.auto ? ["--auto"] : []),
      "--",
      String(selector),
    ],
    options,
  );
});

/** Turn off auto-merge for a pull request. */
export const disableAutoMerge = Effect.fn("PullRequest.disableAutoMerge")(
  function* (selector: number | string, input: Options) {
    const gh = yield* Gh;

    yield* gh.execute(
      [
        "pr",
        "merge",
        `--repo=${input.repository}`,
        "--disable-auto",
        "--",
        String(selector),
      ],
      input,
    );
  },
);

/** The pull request's unified diff, verbatim. Needs gh 2.97.0 or later. */
export const diff = Effect.fn("PullRequest.diff")(function* (
  selector: number | string,
  options: Options,
) {
  const gh = yield* Gh;

  return (yield* gh.execute(
    [
      "pr",
      "diff",
      `--repo=${options.repository}`,
      "--color=never",
      // Piped gh refuses a diff carrying escape sequences without this.
      "--allow-escape-sequences",
      "--",
      String(selector),
    ],
    options,
  )).stdout;
});
