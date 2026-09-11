import { Effect, Predicate, Schema } from "effect";
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
