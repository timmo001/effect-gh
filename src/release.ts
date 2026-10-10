import { Effect, Schema, Struct } from "effect";
import { Gh, type GhOptions } from "./gh.js";

/** Every `gh release view --json` field the typed read can select. */
export const Fields = Schema.Struct({
  tagName: Schema.String,
  name: Schema.String,
  url: Schema.String,
  body: Schema.String,
  isDraft: Schema.Boolean,
  isPrerelease: Schema.Boolean,
  targetCommitish: Schema.String,
  publishedAt: Schema.NullOr(Schema.String),
  assets: Schema.Array(
    Schema.Struct({ name: Schema.String, url: Schema.String }),
  ),
});

export interface Fields extends Schema.Schema.Type<typeof Fields> {}

export type Field = keyof typeof Fields.fields;

/** The selected fields of a release. */
export type Selected<F extends ReadonlyArray<Field>> = Pick<Fields, F[number]>;

/** View a release, or the latest release when `tag` is omitted, decoding exactly the selected fields. */
export const view = Effect.fn("Release.view")(function* <
  const F extends ReadonlyArray<Field>,
>(
  input: { readonly repo: string; readonly tag?: string; readonly fields: F },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "release",
      "view",
      ...(input.tag === undefined ? [] : [input.tag]),
      "--repo",
      input.repo,
      "--json",
      input.fields.join(","),
    ],
    Fields.mapFields(Struct.pick(input.fields)),
    options,
  );
});

/** Whether a release exists for the tag. Other failures stay failures. */
export const exists = Effect.fn("Release.exists")(function* (
  input: { readonly repo: string; readonly tag: string },
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
  readonly repo: string;
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
      "--repo",
      input.repo,
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
  input: ReleaseSettings & { readonly repo: string; readonly tag: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    ["release", "edit", input.tag, "--repo", input.repo, ...settingArgs(input)],
    options,
  );
});

/** Upload assets to a release, replacing assets with the same name when `clobber` is set. */
export const upload = Effect.fn("Release.upload")(function* (
  input: {
    readonly repo: string;
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
      "--repo",
      input.repo,
      ...(input.clobber ? ["--clobber"] : []),
    ],
    options,
  );
});

/** Download release assets matching glob patterns into a directory. */
export const download = Effect.fn("Release.download")(function* (
  input: {
    readonly repo: string;
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
      "--repo",
      input.repo,
      ...input.patterns.flatMap((pattern) => ["--pattern", pattern]),
      "--dir",
      input.directory,
    ],
    options,
  );
});
