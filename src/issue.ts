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
  /** Only issues of this issue type, by name. */
  readonly type?: string;
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

  if (options.type !== undefined) args.push("--type", options.type);
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

/**
 * A parent, sub-issue or blocking issue, which may be in another repository.
 * gh leaves its repository out of the JSON, so read that from the URL.
 */
export const LinkedIssue = Schema.Struct({
  id: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  state: Schema.String,
});

export interface LinkedIssue extends Schema.Schema.Type<typeof LinkedIssue> {}

const linkedIssues = Schema.Struct({
  nodes: Schema.Array(LinkedIssue),
  totalCount: Schema.Int,
});

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
  issueType: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      description: Schema.String,
      color: Schema.String,
    }),
  ),
  parent: Schema.NullOr(LinkedIssue),
  subIssues: linkedIssues,
  subIssuesSummary: Schema.Struct({
    total: Schema.Int,
    completed: Schema.Int,
    percentCompleted: Schema.Finite,
  }),
  blockedBy: linkedIssues,
  blocking: linkedIssues,
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

  if (input.type !== undefined) args.push("--type", input.type);
  const gh = yield* Gh;

  return yield* gh.json(args, Schema.Array(selection(input.fields)), execution);
});

/** An issue number or URL, as gh's relationship flags take them. */
type IssueReference = number | string;

const repeated = (flag: string, values: ReadonlyArray<IssueReference> = []) =>
  values.flatMap((value) => [flag, String(value)]);

/**
 * Image or video files to upload, as `<file>` or `<file>#<alt text>`. gh
 * appends them to the body, or points a body reference to the file at the
 * upload. When some fail, the rest are still saved and gh exits non-zero.
 */
export interface AttachmentInput {
  readonly attachments?: ReadonlyArray<string>;
}

const attachArgs = (input: AttachmentInput) =>
  repeated("--attach", input.attachments);

/** Input for {@link create}. */
export interface CreateInput extends AttachmentInput {
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly labels?: ReadonlyArray<string>;
  /** Issue type by name, such as `Bug`. */
  readonly type?: string;
  /** Make the new issue a sub-issue of this one. */
  readonly parent?: IssueReference;
  readonly blockedBy?: ReadonlyArray<IssueReference>;
  readonly blocking?: ReadonlyArray<IssueReference>;
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

  if (input.type !== undefined) args.push("--type", input.type);

  if (input.parent !== undefined) args.push("--parent", String(input.parent));
  args.push(
    ...repeated("--blocked-by", input.blockedBy),
    ...repeated("--blocking", input.blocking),
    ...attachArgs(input),
  );
  const output = yield* gh.execute(args, execution);

  return { url: output.stdout.trim().split("\n").at(-1) ?? "" };
});

/** Input for {@link edit}. */
export interface EditInput extends AttachmentInput {
  readonly repo: string;
  readonly title?: string;
  readonly body?: string;
  readonly addLabels?: ReadonlyArray<string>;
  readonly removeLabels?: ReadonlyArray<string>;
  /** Issue type by name, such as `Bug`. */
  readonly type?: string;
  readonly removeType?: boolean;
  readonly parent?: IssueReference;
  readonly removeParent?: boolean;
  readonly addSubIssues?: ReadonlyArray<IssueReference>;
  readonly removeSubIssues?: ReadonlyArray<IssueReference>;
  readonly addBlockedBy?: ReadonlyArray<IssueReference>;
  readonly removeBlockedBy?: ReadonlyArray<IssueReference>;
  readonly addBlocking?: ReadonlyArray<IssueReference>;
  readonly removeBlocking?: ReadonlyArray<IssueReference>;
}

/** Change an issue's title, body, labels, type or relationships. */
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

  if (input.type !== undefined) args.push("--type", input.type);

  if (input.removeType) args.push("--remove-type");

  if (input.parent !== undefined) args.push("--parent", String(input.parent));

  if (input.removeParent) args.push("--remove-parent");
  args.push(
    ...repeated("--add-sub-issue", input.addSubIssues),
    ...repeated("--remove-sub-issue", input.removeSubIssues),
    ...repeated("--add-blocked-by", input.addBlockedBy),
    ...repeated("--remove-blocked-by", input.removeBlockedBy),
    ...repeated("--add-blocking", input.addBlocking),
    ...repeated("--remove-blocking", input.removeBlocking),
    ...attachArgs(input),
    "--",
    String(issue),
  );
  yield* gh.execute(args, execution);
});

/** Add a comment to an issue. */
export const comment = Effect.fn("Issue.comment")(function* (
  issue: number | string,
  input: AttachmentInput & { readonly repo: string; readonly body: string },
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
      ...attachArgs(input),
      "--",
      String(issue),
    ],
    execution,
  );
});

/** Input for {@link close}. */
export interface CloseInput {
  readonly repo: string;
  /** Leave a closing comment. */
  readonly comment?: string;
  readonly reason?: "completed" | "not planned" | "duplicate";
  /** Close as a duplicate of this issue, by number or URL. */
  readonly duplicateOf?: IssueReference;
}

const commentArgs = (comment: string | undefined) =>
  comment === undefined ? [] : ["--comment", comment];

/** Close an issue, optionally with a comment, a reason or the issue it duplicates. */
export const close = Effect.fn("Issue.close")(function* (
  issue: number | string,
  input: CloseInput,
  execution?: GhOptions,
) {
  const gh = yield* Gh;
  const args = ["issue", "close", "--repo", input.repo];

  args.push(...commentArgs(input.comment));

  if (input.reason !== undefined) args.push("--reason", input.reason);

  if (input.duplicateOf !== undefined)
    args.push("--duplicate-of", String(input.duplicateOf));
  args.push("--", String(issue));
  yield* gh.execute(args, execution);
});

/** Reopen an issue, optionally with a comment. */
export const reopen = Effect.fn("Issue.reopen")(function* (
  issue: number | string,
  input: { readonly repo: string; readonly comment?: string },
  execution?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "issue",
      "reopen",
      "--repo",
      input.repo,
      ...commentArgs(input.comment),
      "--",
      String(issue),
    ],
    execution,
  );
});

/** Delete an issue without prompting. This cannot be undone. */
export const remove = Effect.fn("Issue.remove")(function* (
  issue: number | string,
  input: { readonly repo: string },
  execution?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    ["issue", "delete", "--repo", input.repo, "--yes", "--", String(issue)],
    execution,
  );
});

/** Why a conversation is locked. */
export type LockReason = "off_topic" | "resolved" | "spam" | "too_heated";

/** Lock an issue's conversation, optionally with a reason. */
export const lock = Effect.fn("Issue.lock")(function* (
  issue: number | string,
  input: { readonly repo: string; readonly reason?: LockReason },
  execution?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "issue",
      "lock",
      "--repo",
      input.repo,
      ...(input.reason === undefined ? [] : ["--reason", input.reason]),
      "--",
      String(issue),
    ],
    execution,
  );
});

/** Unlock an issue's conversation. */
export const unlock = Effect.fn("Issue.unlock")(function* (
  issue: number | string,
  input: { readonly repo: string },
  execution?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    ["issue", "unlock", "--repo", input.repo, "--", String(issue)],
    execution,
  );
});

/** Pin an issue to its repository. */
export const pin = Effect.fn("Issue.pin")(function* (
  issue: number | string,
  input: { readonly repo: string },
  execution?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    ["issue", "pin", "--repo", input.repo, "--", String(issue)],
    execution,
  );
});

/** Unpin an issue from its repository. */
export const unpin = Effect.fn("Issue.unpin")(function* (
  issue: number | string,
  input: { readonly repo: string },
  execution?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    ["issue", "unpin", "--repo", input.repo, "--", String(issue)],
    execution,
  );
});

/** Transfer an issue to another repository, and return the new issue's URL. */
export const transfer = Effect.fn("Issue.transfer")(function* (
  issue: number | string,
  input: {
    readonly repo: string;
    /** `[HOST/]OWNER/REPO` or its URL. */
    readonly destination: string;
  },
  execution?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    [
      "issue",
      "transfer",
      "--repo",
      input.repo,
      "--",
      String(issue),
      input.destination,
    ],
    execution,
  );

  return { url: output.stdout.trim().split("\n").at(-1) ?? "" };
});

/** A branch linked to an issue. */
export interface LinkedBranch {
  readonly name: string;
  readonly url: string;
}

/** List the branches linked to an issue. Empty when there are none. */
export const linkedBranches = Effect.fn("Issue.linkedBranches")(function* (
  issue: number | string,
  options: ViewOptions = {},
  execution?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    [
      "issue",
      "develop",
      "--list",
      ...repoArgs(options.repo),
      "--",
      String(issue),
    ],
    execution,
  );

  return output.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): LinkedBranch => {
      const [name = "", url = ""] = line.split("\t");

      return { name, url };
    });
});

/** Input for {@link develop}. */
export interface DevelopInput {
  readonly repo?: string;
  /** Remote branch to create the new branch from. */
  readonly base?: string;
  /** Name of the new branch. */
  readonly name?: string;
  /** Repository to create the branch in, when not the issue's. */
  readonly branchRepo?: string;
  /** Check the branch out in the working directory after creating it. */
  readonly checkout?: boolean;
  /** Check the branch out into a worktree at this path; needs `checkout`. */
  readonly worktree?: string;
}

/** Create a branch linked to an issue, and return its URL. */
export const develop = Effect.fn("Issue.develop")(function* (
  issue: number | string,
  input: DevelopInput = {},
  execution?: GhOptions,
) {
  const gh = yield* Gh;
  const args = ["issue", "develop", ...repoArgs(input.repo)];

  if (input.base !== undefined) args.push("--base", input.base);

  if (input.name !== undefined) args.push("--name", input.name);

  if (input.branchRepo !== undefined)
    args.push("--branch-repo", input.branchRepo);

  if (input.checkout) args.push("--checkout");

  if (input.worktree !== undefined) args.push("--worktree", input.worktree);
  args.push("--", String(issue));
  const output = yield* gh.execute(args, execution);

  return { url: output.stdout.trim().split("\n")[0] ?? "" };
});

/** An issue in {@link status}. */
export const StatusIssue = Schema.Struct({
  ...IssueSummary.fields,
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
});

export interface StatusIssue extends Schema.Schema.Type<typeof StatusIssue> {}

/** The issues relevant to the current user in a repository. */
export const Status = Schema.Struct({
  createdBy: Schema.Array(StatusIssue),
  assigned: Schema.Array(StatusIssue),
  mentioned: Schema.Array(StatusIssue),
});

export interface Status extends Schema.Schema.Type<typeof Status> {}

/** Open issues the current user created, is assigned or is mentioned in. */
export const status = Effect.fn("Issue.status")(function* (
  options: ViewOptions = {},
  execution?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "issue",
      "status",
      "--json",
      Object.keys(StatusIssue.fields).join(","),
      ...repoArgs(options.repo),
    ],
    Status,
    execution,
  );
});
