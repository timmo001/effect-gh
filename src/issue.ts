import { Effect, Predicate, Schema, Struct } from "effect";
import { Gh, type GhOptions } from "./gh.js";

export const IssueSummary = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED"]),
  updatedAt: Schema.String,
});

export interface IssueSummary extends Schema.Schema.Type<typeof IssueSummary> {}

export const Issue = Schema.Struct({
  ...IssueSummary.fields,
  body: Schema.String,
});

export interface Issue extends Schema.Schema.Type<typeof Issue> {}

export interface ViewOptions {
  /** Select [HOST/]OWNER/REPO instead of the working directory's repository. */
  readonly repo?: string;
}

export interface ListOptions extends ViewOptions {
  /** Defaults to open. */
  readonly state?: "open" | "closed" | "all";
  /** Maximum issues to fetch, defaults to gh's 30; not an unbounded list. */
  readonly limit?: number;
  /** Repeated gh label filters; comma-separated values follow gh's label syntax. */
  readonly labels?: ReadonlyArray<string>;
  readonly assignee?: string;
  readonly search?: string;
}

export class InvalidInput extends Schema.TaggedError<InvalidInput>()(
  "IssueInvalidInput",
  { cause: Schema.Defect() },
) {}

const positiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

const summaryFields = "number,title,url,state,updatedAt";

/** Fetch a bounded list using gh's default state and limit unless overridden. */
export const list = Effect.fn("Issue.list")(function* (
  options: ListOptions = {},
  execution?: GhOptions,
) {
  const args = ["issue", "list", "--json", summaryFields];

  if (options.repo !== undefined) args.push("--repo", options.repo);

  if (options.state !== undefined) args.push("--state", options.state);

  if (options.limit !== undefined) {
    const limit = yield* Schema.decodeEffect(positiveInteger)(
      options.limit,
    ).pipe(Effect.mapError((cause) => new InvalidInput({ cause })));

    args.push("--limit", String(limit));
  }

  for (const label of options.labels ?? []) args.push("--label", label);

  if (options.assignee !== undefined) args.push("--assignee", options.assignee);

  if (options.search !== undefined) args.push("--search", options.search);
  const gh = yield* Gh;

  return yield* gh.json(args, Schema.Array(IssueSummary), execution);
});

/** View an issue by number or URL, including its body. */
export const view = Effect.fn("Issue.view")(function* (
  issue: number | string,
  options: ViewOptions = {},
  execution?: GhOptions,
) {
  if (Predicate.isNumber(issue)) {
    yield* Schema.decodeEffect(positiveInteger)(issue).pipe(
      Effect.mapError((cause) => new InvalidInput({ cause })),
    );
  }

  const gh = yield* Gh;
  const args = ["issue", "view", "--json", `${summaryFields},body`];

  if (options.repo !== undefined) args.push("--repo", options.repo);
  args.push("--", String(issue));

  return yield* gh.json(args, Issue, execution);
});

const Author = Schema.Struct({ login: Schema.String });

/** Every `gh issue --json` field the typed reads can select. */
export const Fields = Schema.Struct({
  ...Issue.fields,
  author: Author,
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  comments: Schema.Array(
    Schema.Struct({
      author: Author,
      body: Schema.String,
      createdAt: Schema.String,
    }),
  ),
});

export interface Fields extends Schema.Schema.Type<typeof Fields> {}

export type Field = keyof typeof Fields.fields;

/** The selected fields of an issue. */
export type Selected<F extends ReadonlyArray<Field>> = Pick<Fields, F[number]>;

const selection = <const F extends ReadonlyArray<Field>>(fields: F) =>
  Fields.mapFields(Struct.pick(fields));

const repoArgs = (repo: string | undefined) =>
  repo === undefined ? [] : ["--repo", repo];

/** View one issue, decoding exactly the selected fields. */
export const get = Effect.fn("Issue.get")(function* <
  const F extends ReadonlyArray<Field>,
>(
  issue: number | string,
  input: ViewOptions & { readonly fields: F },
  execution?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "issue",
      "view",
      "--json",
      input.fields.join(","),
      ...repoArgs(input.repo),
      "--",
      String(issue),
    ],
    selection(input.fields),
    execution,
  );
});

/** List issues, decoding exactly the selected fields. Uses gh's default state and limit unless overridden. */
export const query = Effect.fn("Issue.query")(function* <
  const F extends ReadonlyArray<Field>,
>(input: ListOptions & { readonly fields: F }, execution?: GhOptions) {
  const args = [
    "issue",
    "list",
    "--json",
    input.fields.join(","),
    ...repoArgs(input.repo),
  ];

  if (input.state !== undefined) args.push("--state", input.state);

  if (input.limit !== undefined) {
    const limit = yield* Schema.decodeEffect(positiveInteger)(input.limit).pipe(
      Effect.mapError((cause) => new InvalidInput({ cause })),
    );

    args.push("--limit", String(limit));
  }

  for (const label of input.labels ?? []) args.push("--label", label);

  if (input.assignee !== undefined) args.push("--assignee", input.assignee);

  if (input.search !== undefined) args.push("--search", input.search);
  const gh = yield* Gh;

  return yield* gh.json(args, Schema.Array(selection(input.fields)), execution);
});

/** Input for {@link create}. */
export interface CreateInput {
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly labels?: ReadonlyArray<string>;
}

/** Open an issue and return its URL. */
export const create = Effect.fn("Issue.create")(function* (
  input: CreateInput,
  execution?: GhOptions,
) {
  const gh = yield* Gh;

  const args = [
    "issue",
    "create",
    "--repo",
    input.repo,
    "--title",
    input.title,
    "--body",
    input.body,
  ];

  for (const label of input.labels ?? []) args.push("--label", label);
  const output = yield* gh.execute(args, execution);

  return { url: output.stdout.trim().split("\n").at(-1) ?? "" };
});

/** Input for {@link edit}. */
export interface EditInput {
  readonly repo: string;
  readonly title?: string;
  readonly body?: string;
  readonly addLabels?: ReadonlyArray<string>;
  readonly removeLabels?: ReadonlyArray<string>;
}

/** Change an issue's title, body or labels. */
export const edit = Effect.fn("Issue.edit")(function* (
  issue: number | string,
  input: EditInput,
  execution?: GhOptions,
) {
  const gh = yield* Gh;
  const args = ["issue", "edit", "--repo", input.repo];

  if (input.title !== undefined) args.push("--title", input.title);

  if (input.body !== undefined) args.push("--body", input.body);

  for (const label of input.addLabels ?? []) args.push("--add-label", label);

  for (const label of input.removeLabels ?? [])
    args.push("--remove-label", label);
  args.push("--", String(issue));
  yield* gh.execute(args, execution);
});

/** Add a comment to an issue. */
export const comment = Effect.fn("Issue.comment")(function* (
  issue: number | string,
  input: { readonly repo: string; readonly body: string },
  execution?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "issue",
      "comment",
      "--repo",
      input.repo,
      "--body",
      input.body,
      "--",
      String(issue),
    ],
    execution,
  );
});

/** Close an issue. */
export const close = Effect.fn("Issue.close")(function* (
  issue: number | string,
  input: { readonly repo: string },
  execution?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    ["issue", "close", "--repo", input.repo, "--", String(issue)],
    execution,
  );
});
