import { Effect, Schema, Struct } from "effect";
import { Gh, type GhOptions } from "./gh.js";

/** Every `gh release view --json` field the typed read can select. */
export const Fields = Schema.Struct({
  id: Schema.String,
  databaseId: Schema.Int,
  tagName: Schema.String,
  name: Schema.String,
  url: Schema.String,
  apiUrl: Schema.String,
  uploadUrl: Schema.String,
  tarballUrl: Schema.String,
  zipballUrl: Schema.String,
  body: Schema.String,
  author: Schema.Struct({ id: Schema.String, login: Schema.String }),
  isDraft: Schema.Boolean,
  isPrerelease: Schema.Boolean,
  isImmutable: Schema.Boolean,
  targetCommitish: Schema.String,
  createdAt: Schema.String,
  publishedAt: Schema.NullOr(Schema.String),
  assets: Schema.Array(
    Schema.Struct({ name: Schema.String, url: Schema.String }),
  ),
});

export interface Fields extends Schema.Schema.Type<typeof Fields> {}

export type Field = keyof typeof Fields.fields;

/** The selected fields of a release. */
export type Selected<F extends ReadonlyArray<Field>> = Pick<Fields, F[number]>;

/** `--repo` arguments; gh selects the working directory's repository without them. */
const repoArgs = (repo: string | undefined) =>
  repo === undefined ? [] : ["--repo", repo];

/** View a release, or the latest release when `tag` is omitted, decoding exactly the selected fields. */
export const view = Effect.fn("Release.view")(function* <
  const F extends ReadonlyArray<Field>,
>(
  input: { readonly repo?: string; readonly tag?: string; readonly fields: F },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "release",
      "view",
      ...(input.tag === undefined ? [] : [input.tag]),
      ...repoArgs(input.repo),
      "--json",
      input.fields.join(","),
    ],
    Fields.mapFields(Struct.pick(input.fields)),
    options,
  );
});

/** Whether a release exists for the tag. Other failures stay failures. */
export const exists = Effect.fn("Release.exists")(function* (
  input: { readonly repo?: string; readonly tag: string },
  options?: GhOptions,
) {
  return yield* view({ ...input, fields: ["tagName"] }, options).pipe(
    Effect.as(true),
    Effect.catchTag("GhCommandError", (error) =>
      /release not found/i.test(error.stderr)
        ? Effect.succeed(false)
        : Effect.fail(error),
    ),
  );
});

/** A release as `gh release list` returns it. */
export const ListItem = Schema.Struct({
  tagName: Schema.String,
  /** Empty when the release has no title. */
  name: Schema.String,
  isDraft: Schema.Boolean,
  isPrerelease: Schema.Boolean,
  isLatest: Schema.Boolean,
  isImmutable: Schema.Boolean,
  createdAt: Schema.String,
  /** A zero time (`0001-01-01T00:00:00Z`) for drafts. */
  publishedAt: Schema.String,
});

export interface ListItem extends Schema.Schema.Type<typeof ListItem> {}

/** Input for {@link list}. */
export interface ListInput {
  readonly repo?: string;
  /** At most this many releases, 30 by default. */
  readonly limit?: number;
  readonly excludeDrafts?: boolean;
  readonly excludePrereleases?: boolean;
  /** By creation time, newest first (`desc`) by default. */
  readonly order?: "asc" | "desc";
}

/** List a repository's releases. */
export const list = Effect.fn("Release.list")(function* (
  input: ListInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "release",
      "list",
      ...repoArgs(input.repo),
      ...(input.limit === undefined ? [] : ["--limit", String(input.limit)]),
      ...(input.excludeDrafts ? ["--exclude-drafts"] : []),
      ...(input.excludePrereleases ? ["--exclude-pre-releases"] : []),
      ...(input.order === undefined ? [] : ["--order", input.order]),
      "--json",
      Object.keys(ListItem.fields).join(","),
    ],
    Schema.Array(ListItem),
    options,
  );
});

/** Delete a release without prompting, and its tag too with `cleanupTag`. */
export const remove = Effect.fn("Release.remove")(function* (
  input: {
    readonly repo?: string;
    readonly tag: string;
    readonly cleanupTag?: boolean;
  },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "release",
      "delete",
      input.tag,
      ...repoArgs(input.repo),
      ...(input.cleanupTag ? ["--cleanup-tag"] : []),
      "--yes",
    ],
    options,
  );
});

/** Delete one asset from a release without prompting. */
export const removeAsset = Effect.fn("Release.removeAsset")(function* (
  input: {
    readonly repo?: string;
    readonly tag: string;
    readonly asset: string;
  },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "release",
      "delete-asset",
      input.tag,
      input.asset,
      ...repoArgs(input.repo),
      "--yes",
    ],
    options,
  );
});

/** Settings shared by {@link create} and {@link edit}. */
export interface ReleaseSettings {
  readonly title?: string;
  readonly notes?: string;
  /** Read notes from a file instead of `notes`. */
  readonly notesFile?: string;
  /** Branch or commit SHA the tag is created from. */
  readonly target?: string;
  readonly prerelease?: boolean;
  readonly draft?: boolean;
}

const settingArgs = (settings: ReleaseSettings) => [
  ...(settings.title === undefined ? [] : ["--title", settings.title]),
  ...(settings.notes === undefined ? [] : ["--notes", settings.notes]),
  ...(settings.notesFile === undefined
    ? []
    : ["--notes-file", settings.notesFile]),
  ...(settings.target === undefined ? [] : ["--target", settings.target]),
  ...(settings.prerelease === undefined
    ? []
    : [`--prerelease=${settings.prerelease}`]),
  ...(settings.draft === undefined ? [] : [`--draft=${settings.draft}`]),
];

/** Input for {@link create}. */
export interface CreateInput extends ReleaseSettings {
  readonly repo?: string;
  readonly tag: string;
  /** Asset file paths to upload with the release. */
  readonly assets?: ReadonlyArray<string>;
  /** Fail unless the tag already exists on the remote. */
  readonly verifyTag?: boolean;
  /** Generate notes from merged pull requests. */
  readonly generateNotes?: boolean;
  /** Start generated notes after this tag instead of the previous release. */
  readonly notesStartTag?: string;
}

/** Create a release and return its URL. */
export const create = Effect.fn("Release.create")(function* (
  input: CreateInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    [
      "release",
      "create",
      input.tag,
      ...(input.assets ?? []),
      ...repoArgs(input.repo),
      ...settingArgs(input),
      ...(input.verifyTag ? ["--verify-tag"] : []),
      ...(input.generateNotes ? ["--generate-notes"] : []),
      ...(input.notesStartTag === undefined
        ? []
        : ["--notes-start-tag", input.notesStartTag]),
    ],
    options,
  );

  return { url: output.stdout.trim().split("\n").at(-1) ?? "" };
});

/** Change an existing release. */
export const edit = Effect.fn("Release.edit")(function* (
  input: ReleaseSettings & { readonly repo?: string; readonly tag: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "release",
      "edit",
      input.tag,
      ...repoArgs(input.repo),
      ...settingArgs(input),
    ],
    options,
  );
});

/** Upload assets to a release, replacing assets with the same name when `clobber` is set. */
export const upload = Effect.fn("Release.upload")(function* (
  input: {
    readonly repo?: string;
    readonly tag: string;
    readonly assets: ReadonlyArray<string>;
    readonly clobber?: boolean;
  },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "release",
      "upload",
      input.tag,
      ...input.assets,
      ...repoArgs(input.repo),
      ...(input.clobber ? ["--clobber"] : []),
    ],
    options,
  );
});

/** Download release assets matching glob patterns into a directory. */
export const download = Effect.fn("Release.download")(function* (
  input: {
    readonly repo?: string;
    readonly tag: string;
    readonly patterns: ReadonlyArray<string>;
    readonly directory: string;
  },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "release",
      "download",
      input.tag,
      ...repoArgs(input.repo),
      ...input.patterns.flatMap((pattern) => ["--pattern", pattern]),
      "--dir",
      input.directory,
    ],
    options,
  );
});
