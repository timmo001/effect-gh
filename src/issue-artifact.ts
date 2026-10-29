import { Effect, Schema } from "effect";
import { Gh, type GhOptions } from "./gh.js";
import { decodeOptions, positiveInteger, repository } from "./internal.js";

/**
 * Issue artifacts are in private preview: gh refuses them on repositories that
 * aren't enrolled.
 */
export const Type = Schema.Literals([
  "generic",
  "plan",
  "link",
  "embedded_html",
]);

export type Type = typeof Type.Type;

/** A user or app that created or changed an artifact; null when deleted. */
export const Actor = Schema.NullOr(
  Schema.Struct({ id: Schema.Int, login: Schema.String }),
);

export type Actor = typeof Actor.Type;

/** `gh issue artifact list --json` fields. */
export const Artifact = Schema.Struct({
  id: Schema.Int,
  number: positiveInteger,
  name: Schema.String,
  type: Type,
  description: Schema.String,
  /** Markdown or HTML for a document, the URL for a link. */
  body: Schema.String,
  bodyHtml: Schema.String,
  url: Schema.String,
  creator: Actor,
  createdAt: Schema.NullOr(Schema.String),
  updatedByActor: Actor,
  updatedAt: Schema.NullOr(Schema.String),
});

export interface Artifact extends Schema.Schema.Type<typeof Artifact> {}

/** One entry of an artifact's edit history. */
export const Version = Schema.Struct({
  version: positiveInteger,
  name: Schema.String,
  body: Schema.String,
  bodyHtml: Schema.String,
  createdAt: Schema.NullOr(Schema.String),
  actor: Actor,
});

export interface Version extends Schema.Schema.Type<typeof Version> {}

/** `gh issue artifact view --json` fields: an artifact and its edit history, newest first. */
export const ArtifactWithVersions = Schema.Struct({
  ...Artifact.fields,
  versions: Schema.Array(Version),
});

export interface ArtifactWithVersions extends Schema.Schema.Type<
  typeof ArtifactWithVersions
> {}

const artifactFields = Object.keys(Artifact.fields).join(",");

/** What gh did with one artifact, from a piped create, edit or download line. */
export interface Result {
  readonly status: "created" | "updated" | "restored" | "skipped" | "failed";
  /** Absent for a failure that never got a number, such as a create that failed. */
  readonly number?: number;
  /** The artifact's name, or the path a download wrote. */
  readonly name: string;
  /** The file or URL as given, empty when there was none. */
  readonly source: string;
  /** Why it was skipped or failed, or what else failed for a saved artifact; empty otherwise. */
  readonly reason: string;
}

const statuses: ReadonlyArray<Result["status"]> = [
  "created",
  "updated",
  "restored",
  "skipped",
  "failed",
];

const isStatus = (value: string): value is Result["status"] =>
  statuses.some((status) => status === value);

/**
 * Parse piped `gh issue artifact create`, `edit` and `download` output: one
 * tab-separated `status number name source reason` line per artifact. gh exits
 * 1 after any failure, so pass `GhCommandError.stdout` here to see which
 * artifacts were still saved.
 */
export const parseResults = (output: string): ReadonlyArray<Result> =>
  output.split("\n").flatMap((line): ReadonlyArray<Result> => {
    const [status = "", number = "", name = "", source = "", reason = ""] =
      line.split("\t");

    if (!isStatus(status)) return [];

    const parsed = Number(number);

    return [
      number !== "" && Number.isInteger(parsed)
        ? { status, number: parsed, name, source, reason }
        : { status, name, source, reason },
    ];
  });

const IssueReference = Schema.Union([positiveInteger, Schema.NonEmptyString]);

const repoArgs = (repo: string | undefined) =>
  repo === undefined ? [] : ["--repo", repo];

/** Options shared by every artifact command. */
export interface RepoOptions {
  /** Select [HOST/]OWNER/REPO instead of the working directory's repository. */
  readonly repo?: string;
}

const ListOptions = Schema.Struct({
  repo: Schema.optionalKey(repository),
  type: Schema.optionalKey(Type),
  limit: Schema.optionalKey(positiveInteger),
});

/** Options for {@link list}. */
export interface ListOptions extends RepoOptions {
  /** Only this type; `generic` and `plan` each list both kinds of document. */
  readonly type?: Type;
  /** Maximum artifacts; every artifact is listed without it. */
  readonly limit?: number;
}

/** List an issue's artifacts in number order. The issue is a number or URL. */
export const list = Effect.fn("IssueArtifact.list")(function* (
  issue: number | string,
  options: ListOptions = {},
  execution?: GhOptions,
) {
  const input = yield* decodeOptions(
    Schema.Struct({ issue: IssueReference, options: ListOptions }),
    { issue, options },
  );

  const gh = yield* Gh;

  return yield* gh.json(
    [
      "issue",
      "artifact",
      "list",
      "--json",
      artifactFields,
      ...repoArgs(input.options.repo),
      ...(input.options.type === undefined
        ? []
        : ["--type", input.options.type]),
      ...(input.options.limit === undefined
        ? []
        : ["--limit", String(input.options.limit)]),
      "--",
      String(input.issue),
    ],
    Schema.Array(Artifact),
    execution,
  );
});

const Target = Schema.Struct({
  issue: IssueReference,
  artifact: positiveInteger,
  repo: Schema.optionalKey(repository),
});

/** View an artifact with its edit history, newest version first. */
export const view = Effect.fn("IssueArtifact.view")(function* (
  issue: number | string,
  artifact: number,
  options: RepoOptions = {},
  execution?: GhOptions,
) {
  const target = yield* decodeOptions(Target, { ...options, issue, artifact });
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "issue",
      "artifact",
      "view",
      "--json",
      `${artifactFields},versions`,
      ...repoArgs(target.repo),
      "--",
      String(target.issue),
      String(target.artifact),
    ],
    ArtifactWithVersions,
    execution,
  );
});

/** Content shared by {@link create} and {@link edit}. */
export interface ContentInput {
  /** Text for a single document, or the URL of a link being edited. */
  readonly body?: string;
  /** Read the content from a file; `-` reads `GhOptions.stdin`. */
  readonly bodyFile?: string;
  /** Image or video files to upload and reference, as `<file>` or `<file>#<alt text>`. */
  readonly attachments?: ReadonlyArray<string>;
}

const contentArgs = (input: ContentInput) => [
  ...(input.body === undefined ? [] : ["--body", input.body]),
  ...(input.bodyFile === undefined ? [] : ["--body-file", input.bodyFile]),
  ...(input.attachments ?? []).flatMap((file) => ["--attach", file]),
];

/** Input for {@link create}. */
export interface CreateInput extends RepoOptions, ContentInput {
  /**
   * Files (`<file>` or `<file>#<name>`) and URLs, one artifact each. Leave
   * empty with `body` or `bodyFile`.
   */
  readonly sources?: ReadonlyArray<string>;
  /** Name for a single artifact. Required with `body`. */
  readonly name?: string;
  /** Type for every document, whatever its extension. Links can't take one. */
  readonly type?: Exclude<Type, "link">;
}

const CreateOptions = Schema.Struct({
  issue: IssueReference,
  repo: Schema.optionalKey(repository),
  type: Schema.optionalKey(
    Schema.Literals(["generic", "plan", "embedded_html"]),
  ),
});

/**
 * Create one artifact for each file or URL, or one from `body` or `bodyFile`,
 * and return a {@link Result} for each.
 */
export const create = Effect.fn("IssueArtifact.create")(function* (
  issue: number | string,
  input: CreateInput,
  execution?: GhOptions,
) {
  const checked = yield* decodeOptions(CreateOptions, { ...input, issue });

  const gh = yield* Gh;

  const output = yield* gh.execute(
    [
      "issue",
      "artifact",
      "create",
      ...repoArgs(checked.repo),
      ...contentArgs(input),
      ...(input.name === undefined ? [] : ["--name", input.name]),
      ...(checked.type === undefined ? [] : ["--type", checked.type]),
      "--",
      String(checked.issue),
      ...(input.sources ?? []),
    ],
    execution,
  );

  return parseResults(output.stdout);
});

/**
 * Input for {@link edit}. `restoreVersion` saves an earlier version as a new
 * one and can't be combined with the other changes.
 */
export interface EditInput extends RepoOptions, ContentInput {
  readonly name?: string;
  readonly restoreVersion?: number;
}

/** Rename an artifact, replace its content or restore an earlier version. */
export const edit = Effect.fn("IssueArtifact.edit")(function* (
  issue: number | string,
  artifact: number,
  input: EditInput,
  execution?: GhOptions,
) {
  const target = yield* decodeOptions(
    Schema.Struct({
      ...Target.fields,
      restoreVersion: Schema.optionalKey(positiveInteger),
    }),
    { ...input, issue, artifact },
  );

  const gh = yield* Gh;

  const output = yield* gh.execute(
    [
      "issue",
      "artifact",
      "edit",
      ...repoArgs(target.repo),
      ...contentArgs(input),
      ...(input.name === undefined ? [] : ["--name", input.name]),
      ...(target.restoreVersion === undefined
        ? []
        : ["--restore-version", String(target.restoreVersion)]),
      "--",
      String(target.issue),
      String(target.artifact),
    ],
    execution,
  );

  return parseResults(output.stdout);
});

const DownloadOptions = Schema.Struct({
  issue: IssueReference,
  repo: Schema.optionalKey(repository),
  artifacts: Schema.optionalKey(Schema.Array(positiveInteger)),
  version: Schema.optionalKey(positiveInteger),
});

/** Input for {@link download}. */
export interface DownloadInput extends RepoOptions {
  /** Artifact numbers; every artifact on the issue without them. */
  readonly artifacts?: ReadonlyArray<number>;
  /** Directory for `<number>-<name>` files, defaults to the working directory. */
  readonly directory?: string;
  /** Path for a single artifact instead of `directory`. */
  readonly output?: string;
  /** Overwrite existing files. */
  readonly clobber?: boolean;
  /** Leave existing files alone and report them as skipped. */
  readonly skipExisting?: boolean;
  /** An earlier version of a single artifact. */
  readonly version?: number;
}

const downloadArgs = (
  checked: typeof DownloadOptions.Type,
  input: Omit<DownloadInput, "artifacts" | "repo" | "version">,
) => [
  "issue",
  "artifact",
  "download",
  ...repoArgs(checked.repo),
  ...(input.directory === undefined ? [] : ["--dir", input.directory]),
  ...(input.output === undefined ? [] : ["--output", input.output]),
  ...(input.clobber ? ["--clobber"] : []),
  ...(input.skipExisting ? ["--skip-existing"] : []),
  ...(checked.version === undefined
    ? []
    : ["--version", String(checked.version)]),
  "--",
  String(checked.issue),
  ...(checked.artifacts ?? []).map(String),
];

const checkDownload = (issue: number | string, input: DownloadInput) =>
  decodeOptions(DownloadOptions, { ...input, issue });

/** Download artifacts to files and return a {@link Result} for each, named by the path written. */
export const download = Effect.fn("IssueArtifact.download")(function* (
  issue: number | string,
  input: DownloadInput = {},
  execution?: GhOptions,
) {
  const checked = yield* checkDownload(issue, input);
  const gh = yield* Gh;
  const output = yield* gh.execute(downloadArgs(checked, input), execution);

  return parseResults(output.stdout);
});

/**
 * Read one artifact's content, or an earlier version's, as gh would write it
 * to a file: a link becomes a `.url` Internet Shortcut.
 */
export const content = Effect.fn("IssueArtifact.content")(function* (
  issue: number | string,
  artifact: number,
  options: RepoOptions & { readonly version?: number } = {},
  execution?: GhOptions,
) {
  const checked = yield* checkDownload(issue, {
    ...options,
    artifacts: [artifact],
  });

  const gh = yield* Gh;

  const output = yield* gh.execute(
    downloadArgs(checked, { output: "-" }),
    execution,
  );

  return output.stdout;
});

/** Delete artifacts from an issue without a prompt. Deleted artifacts can't be restored. */
export const remove = Effect.fn("IssueArtifact.remove")(function* (
  issue: number | string,
  artifacts: ReadonlyArray<number>,
  options: RepoOptions = {},
  execution?: GhOptions,
) {
  const checked = yield* decodeOptions(
    Schema.Struct({
      issue: IssueReference,
      artifacts: Schema.Array(positiveInteger).check(Schema.isMinLength(1)),
      repo: Schema.optionalKey(repository),
    }),
    { ...options, issue, artifacts },
  );

  const gh = yield* Gh;

  yield* gh.execute(
    [
      "issue",
      "artifact",
      "delete",
      "--yes",
      ...repoArgs(checked.repo),
      "--",
      String(checked.issue),
      ...checked.artifacts.map(String),
    ],
    execution,
  );
});
