import { Effect, Schema } from "effect";
import { Gh, type GhOptions } from "./gh.js";

/** Input for {@link create}: files on disk, or `content` sent on stdin. */
export type CreateInput = (
  | {
      /** Paths, or patterns gh expands. */
      readonly files: ReadonlyArray<string>;
    }
  | {
      readonly content: string;
      /** Name of the file the content becomes. */
      readonly filename?: string;
    }
) & {
  readonly description?: string;
  /** List the gist publicly; gists are secret by default. */
  readonly public?: boolean;
};

/** Create a gist and return its URL. */
export const create = Effect.fn("Gist.create")(function* (
  input: CreateInput,
  options?: Omit<GhOptions, "stdin">,
) {
  const gh = yield* Gh;
  const args = ["gist", "create"];

  if (input.description !== undefined) args.push("--desc", input.description);

  if (input.public) args.push("--public");

  if ("files" in input) {
    args.push("--", ...input.files);
    const output = yield* gh.execute(args, options);

    return { url: output.stdout.trim().split("\n").at(-1) ?? "" };
  }

  if (input.filename !== undefined) args.push("--filename", input.filename);
  args.push("-");

  const output = yield* gh.execute(args, { ...options, stdin: input.content });

  return { url: output.stdout.trim().split("\n").at(-1) ?? "" };
});

/** Delete a gist by ID or URL without prompting. */
export const remove = Effect.fn("Gist.remove")(function* (
  gist: string,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(["gist", "delete", "--yes", "--", gist], options);
});

/** Input for {@link edit}. */
export interface EditInput {
  /** Gist ID or URL. */
  readonly gist: string;
  readonly description?: string;
  /** Local file to add to the gist. */
  readonly add?: string;
  /** Name of a file to remove from the gist. */
  readonly remove?: string;
  /** Gist file to replace with the contents of `file`. */
  readonly filename?: string;
  /** Local file whose contents replace `filename`. */
  readonly file?: string;
}

/**
 * Change a gist's description or files. Pass at least one change: gh would
 * otherwise open an editor.
 */
export const edit = Effect.fn("Gist.edit")(function* (
  input: EditInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const args = ["gist", "edit"];

  if (input.description !== undefined) args.push("--desc", input.description);

  if (input.add !== undefined) args.push("--add", input.add);

  if (input.remove !== undefined) args.push("--remove", input.remove);

  if (input.filename !== undefined) args.push("--filename", input.filename);
  args.push("--", input.gist);

  if (input.file !== undefined) args.push(input.file);
  yield* gh.execute(args, options);
});

/** A gist as a `gh gist list` row. */
export const Gist = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  /** Number of files. */
  files: Schema.Finite,
  public: Schema.Boolean,
  updatedAt: Schema.String,
});

export interface Gist extends Schema.Schema.Type<typeof Gist> {}

/** Parse `gh gist list`, which has no JSON output: tab-separated id, description, file count, visibility and update time. */
export const parseList = (output: string): ReadonlyArray<Gist> =>
  output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [
        id = "",
        description = "",
        files = "",
        visibility = "",
        updated = "",
      ] = line.split("\t").map((field) => field.trim());

      return Gist.make({
        id,
        description,
        files: Number.parseInt(files, 10) || 0,
        public: visibility === "public",
        updatedAt: updated,
      });
    });

/** Your gists, up to `limit` (10 by default). */
export const list = Effect.fn("Gist.list")(function* (
  input: {
    readonly limit?: number;
    /** Only gists whose description or file names match this regular expression. */
    readonly filter?: string;
    readonly visibility?: "public" | "secret";
  } = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const args = ["gist", "list"];

  if (input.limit !== undefined) args.push("--limit", String(input.limit));

  if (input.filter !== undefined) args.push("--filter", input.filter);

  if (input.visibility !== undefined) args.push(`--${input.visibility}`);

  return parseList((yield* gh.execute(args, options)).stdout);
});

/** Rename a file in a gist. */
export const rename = Effect.fn("Gist.rename")(function* (
  input: {
    /** Gist ID or URL. */
    readonly gist: string;
    readonly oldFilename: string;
    readonly newFilename: string;
  },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    ["gist", "rename", "--", input.gist, input.oldFilename, input.newFilename],
    options,
  );
});

/** The raw contents of a gist, or of one file with `filename`. */
export const view = Effect.fn("Gist.view")(function* (
  input: { readonly gist: string; readonly filename?: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const args = ["gist", "view", "--raw"];

  if (input.filename !== undefined) args.push("--filename", input.filename);
  args.push("--", input.gist);

  return (yield* gh.execute(args, options)).stdout;
});

/** The file names in a gist. */
export const viewFiles = Effect.fn("Gist.viewFiles")(function* (
  gist: string,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    ["gist", "view", "--files", "--", gist],
    options,
  );

  return output.stdout.split("\n").filter((line) => line.trim() !== "");
});

/** Clone a gist by ID or URL into `directory`, or a directory named for it. */
export const clone = Effect.fn("Gist.clone")(function* (
  input: { readonly gist: string; readonly directory?: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "gist",
      "clone",
      input.gist,
      ...(input.directory === undefined ? [] : [input.directory]),
    ],
    options,
  );
});
