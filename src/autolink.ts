import { Effect, Schema } from "effect";
import { GhDecodeError } from "./errors.js";
import { Gh, type GhOptions } from "./gh.js";

/** An autolink reference as `gh repo autolink list --json` returns it. */
export const Autolink = Schema.Struct({
  id: Schema.Int,
  isAlphanumeric: Schema.Boolean,
  keyPrefix: Schema.String,
  urlTemplate: Schema.String,
});

export interface Autolink extends Schema.Schema.Type<typeof Autolink> {}

const fields = Object.keys(Autolink.fields).join(",");

/** `--repo` arguments; gh selects the working directory's repository without them. */
const repoArgs = (repo: string | undefined) =>
  repo === undefined ? [] : ["--repo", repo];

/** Input for {@link create}. */
export interface CreateInput {
  /** [HOST/]OWNER/REPO; the working directory's repository without it. */
  readonly repo?: string;
  /** The prefix that generates a link, such as `TICKET-`. */
  readonly keyPrefix: string;
  /** The target URL, containing `<num>` for the reference number. */
  readonly urlTemplate: string;
  /** Match digits only, instead of letters, digits and `-`. */
  readonly numeric?: boolean;
}

/** Create an autolink reference. */
export const create = Effect.fn("Autolink.create")(function* (
  input: CreateInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "repo",
      "autolink",
      "create",
      ...repoArgs(input.repo),
      ...(input.numeric ? ["--numeric"] : []),
      "--",
      input.keyPrefix,
      input.urlTemplate,
    ],
    options,
  );
});

/** Delete an autolink reference without prompting. */
export const remove = Effect.fn("Autolink.remove")(function* (
  input: { readonly repo?: string; readonly id: number },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "repo",
      "autolink",
      "delete",
      ...repoArgs(input.repo),
      "--yes",
      "--",
      String(input.id),
    ],
    options,
  );
});

/** Every autolink reference on a repository. Only administrators can read them. */
export const list = Effect.fn("Autolink.list")(function* (
  input: { readonly repo?: string } = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    ["repo", "autolink", "list", ...repoArgs(input.repo), "--json", fields],
    options,
  );

  // gh prints nothing, not `[]`, when the repository has no autolinks.
  if (output.stdout.trim() === "") return [];

  return yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.Array(Autolink)),
  )(output.stdout).pipe(
    Effect.mapError((cause) => new GhDecodeError({ cause })),
  );
});

/** View one autolink reference. */
export const view = Effect.fn("Autolink.view")(function* (
  input: { readonly repo?: string; readonly id: number },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "repo",
      "autolink",
      "view",
      ...repoArgs(input.repo),
      "--json",
      fields,
      "--",
      String(input.id),
    ],
    Autolink,
    options,
  );
});
