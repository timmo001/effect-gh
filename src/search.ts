import { Effect, Schema } from "effect";
import { Gh, type GhOptions } from "./gh.js";

export const CodeResult = Schema.Struct({
  path: Schema.String,
  url: Schema.String,
  repository: Schema.Struct({ nameWithOwner: Schema.String }),
});

export interface CodeResult extends Schema.Schema.Type<typeof CodeResult> {}

/** Input for {@link code}. */
export interface CodeInput {
  readonly query: string;
  readonly owner?: string;
  readonly repo?: string;
  readonly filename?: string;
  /** Defaults to gh's 30; the search API caps results at 1000. */
  readonly limit?: number;
}

/** Search code with GitHub's code search. */
export const code = Effect.fn("Search.code")(function* (
  input: CodeInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const args = ["search", "code", "--json", "path,url,repository"];

  if (input.owner !== undefined) args.push("--owner", input.owner);

  if (input.repo !== undefined) args.push("--repo", input.repo);

  if (input.filename !== undefined) args.push("--filename", input.filename);

  if (input.limit !== undefined) args.push("--limit", String(input.limit));
  args.push("--", input.query);

  return yield* gh.json(args, Schema.Array(CodeResult), options);
});

/** Filters shared by {@link commits}, {@link issues}, {@link prs} and {@link repos}. */
export interface SearchInput {
  readonly query?: string;
  /** Repository owners to search within. */
  readonly owner?: ReadonlyArray<string>;
  readonly visibility?: ReadonlyArray<"public" | "private" | "internal">;
  /** Defaults to gh's 30; the search API caps results at 1000. */
  readonly limit?: number;
  readonly order?: "asc" | "desc";
}

const common = (input: SearchInput) => [
  ...(input.owner ?? []).flatMap((owner) => ["--owner", owner]),
  ...(input.visibility ?? []).flatMap((value) => ["--visibility", value]),
  ...(input.limit === undefined ? [] : ["--limit", String(input.limit)]),
  ...(input.order === undefined ? [] : ["--order", input.order]),
];

const tail = (query: string | undefined) =>
  query === undefined ? [] : ["--", query];

const User = Schema.Struct({ login: Schema.String });

export const CommitResult = Schema.Struct({
  sha: Schema.String,
  url: Schema.String,
  commit: Schema.Struct({
    message: Schema.String,
    author: Schema.Struct({ name: Schema.String, date: Schema.String }),
  }),
  author: Schema.NullOr(User),
  repository: Schema.Struct({
    fullName: Schema.String,
    isPrivate: Schema.Boolean,
  }),
});

export interface CommitResult extends Schema.Schema.Type<typeof CommitResult> {}

/** Input for {@link commits}. */
export interface CommitsInput extends SearchInput {
  readonly repo?: string;
  readonly author?: string;
  readonly committer?: string;
  readonly hash?: string;
  readonly merge?: boolean;
  readonly sort?: "author-date" | "committer-date";
}

/** Search commits. */
export const commits = Effect.fn("Search.commits")(function* (
  input: CommitsInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "search",
      "commits",
      "--json",
      Object.keys(CommitResult.fields).join(","),
      ...common(input),
      ...(input.repo === undefined ? [] : ["--repo", input.repo]),
      ...(input.author === undefined ? [] : ["--author", input.author]),
      ...(input.committer === undefined
        ? []
        : ["--committer", input.committer]),
      ...(input.hash === undefined ? [] : ["--hash", input.hash]),
      ...(input.merge === true ? ["--merge"] : []),
      ...(input.sort === undefined ? [] : ["--sort", input.sort]),
      ...tail(input.query),
    ],
    Schema.Array(CommitResult),
    options,
  );
});

export const IssueResult = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  url: Schema.String,
  body: Schema.String,
  isPullRequest: Schema.Boolean,
  commentsCount: Schema.Int,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  closedAt: Schema.String,
  author: User,
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  repository: Schema.Struct({ nameWithOwner: Schema.String }),
});

export interface IssueResult extends Schema.Schema.Type<typeof IssueResult> {}

export const PullRequestResult = Schema.Struct({
  ...IssueResult.fields,
  isDraft: Schema.Boolean,
});

export interface PullRequestResult extends Schema.Schema.Type<
  typeof PullRequestResult
> {}

/** Filters shared by {@link issues} and {@link prs}. */
export interface ThreadSearchInput extends SearchInput {
  readonly repo?: string;
  readonly author?: string;
  readonly assignee?: string;
  readonly label?: ReadonlyArray<string>;
  readonly language?: string;
  readonly state?: "open" | "closed";
  readonly archived?: boolean;
  readonly sort?:
    "comments" | "created" | "interactions" | "reactions" | "updated";
}

const threadArgs = (input: ThreadSearchInput) => [
  ...common(input),
  ...(input.repo === undefined ? [] : ["--repo", input.repo]),
  ...(input.author === undefined ? [] : ["--author", input.author]),
  ...(input.assignee === undefined ? [] : ["--assignee", input.assignee]),
  ...(input.label ?? []).flatMap((label) => ["--label", label]),
  ...(input.language === undefined ? [] : ["--language", input.language]),
  ...(input.state === undefined ? [] : ["--state", input.state]),
  ...(input.archived === undefined ? [] : [`--archived=${input.archived}`]),
  ...(input.sort === undefined ? [] : ["--sort", input.sort]),
];

/** Input for {@link issues}. */
export interface IssuesInput extends ThreadSearchInput {
  /** Include pull requests in the results. */
  readonly includePrs?: boolean;
}

/** Search issues. */
export const issues = Effect.fn("Search.issues")(function* (
  input: IssuesInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "search",
      "issues",
      "--json",
      Object.keys(IssueResult.fields).join(","),
      ...threadArgs(input),
      ...(input.includePrs === true ? ["--include-prs"] : []),
      ...tail(input.query),
    ],
    Schema.Array(IssueResult),
    options,
  );
});

/** Input for {@link prs}. */
export interface PrsInput extends ThreadSearchInput {
  readonly draft?: boolean;
  readonly merged?: boolean;
  readonly base?: string;
  readonly head?: string;
  readonly review?: "none" | "required" | "approved" | "changes_requested";
  readonly checks?: "pending" | "success" | "failure";
}

/** Search pull requests. */
export const prs = Effect.fn("Search.prs")(function* (
  input: PrsInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "search",
      "prs",
      "--json",
      Object.keys(PullRequestResult.fields).join(","),
      ...threadArgs(input),
      ...(input.draft === undefined ? [] : [`--draft=${input.draft}`]),
      ...(input.merged === undefined ? [] : [`--merged=${input.merged}`]),
      ...(input.base === undefined ? [] : ["--base", input.base]),
      ...(input.head === undefined ? [] : ["--head", input.head]),
      ...(input.review === undefined ? [] : ["--review", input.review]),
      ...(input.checks === undefined ? [] : ["--checks", input.checks]),
      ...tail(input.query),
    ],
    Schema.Array(PullRequestResult),
    options,
  );
});

export const RepositoryResult = Schema.Struct({
  fullName: Schema.String,
  name: Schema.String,
  description: Schema.String,
  url: Schema.String,
  language: Schema.String,
  stargazersCount: Schema.Int,
  forksCount: Schema.Int,
  openIssuesCount: Schema.Int,
  isArchived: Schema.Boolean,
  isFork: Schema.Boolean,
  isPrivate: Schema.Boolean,
  visibility: Schema.String,
  defaultBranch: Schema.String,
  pushedAt: Schema.String,
  updatedAt: Schema.String,
  owner: User,
});

export interface RepositoryResult extends Schema.Schema.Type<
  typeof RepositoryResult
> {}

/** Input for {@link repos}. */
export interface ReposInput extends SearchInput {
  readonly language?: string;
  readonly topic?: ReadonlyArray<string>;
  readonly license?: ReadonlyArray<string>;
  readonly archived?: boolean;
  readonly includeForks?: "false" | "true" | "only";
  readonly sort?: "forks" | "help-wanted-issues" | "stars" | "updated";
}

/** Search repositories. */
export const repos = Effect.fn("Search.repos")(function* (
  input: ReposInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "search",
      "repos",
      "--json",
      Object.keys(RepositoryResult.fields).join(","),
      ...common(input),
      ...(input.language === undefined ? [] : ["--language", input.language]),
      ...(input.topic ?? []).flatMap((topic) => ["--topic", topic]),
      ...(input.license ?? []).flatMap((license) => ["--license", license]),
      ...(input.archived === undefined ? [] : [`--archived=${input.archived}`]),
      ...(input.includeForks === undefined
        ? []
        : ["--include-forks", input.includeForks]),
      ...(input.sort === undefined ? [] : ["--sort", input.sort]),
      ...tail(input.query),
    ],
    Schema.Array(RepositoryResult),
    options,
  );
});
