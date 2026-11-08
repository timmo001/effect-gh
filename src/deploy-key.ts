import { Effect, Schema } from "effect";
import { GhDecodeError } from "./errors.js";
import { Gh, type GhOptions } from "./gh.js";

/** A deploy key as `gh repo deploy-key list --json` returns it. */
export const DeployKey = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  key: Schema.String,
  readOnly: Schema.Boolean,
  createdAt: Schema.String,
});

export interface DeployKey extends Schema.Schema.Type<typeof DeployKey> {}

/** `--repo` arguments; gh selects the working directory's repository without them. */
const repoArgs = (repo: string | undefined) =>
  repo === undefined ? [] : ["--repo", repo];

/** Input for {@link add}. */
export interface AddInput {
  /** [HOST/]OWNER/REPO; the working directory's repository without it. */
  readonly repo?: string;
  /** Path to the public key file. */
  readonly keyFile: string;
  readonly title?: string;
  /** Allow write access for the key. */
  readonly allowWrite?: boolean;
}

/** Add a deploy key to a repository. */
export const add = Effect.fn("DeployKey.add")(function* (
  input: AddInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "repo",
      "deploy-key",
      "add",
      ...repoArgs(input.repo),
      ...(input.title === undefined ? [] : ["--title", input.title]),
      ...(input.allowWrite ? ["--allow-write"] : []),
      "--",
      input.keyFile,
    ],
    options,
  );
});

/** Delete a deploy key. */
export const remove = Effect.fn("DeployKey.remove")(function* (
  input: { readonly repo?: string; readonly id: number },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "repo",
      "deploy-key",
      "delete",
      ...repoArgs(input.repo),
      "--",
      String(input.id),
    ],
    options,
  );
});

/** Every deploy key on a repository. */
export const list = Effect.fn("DeployKey.list")(function* (
  input: { readonly repo?: string } = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    [
      "repo",
      "deploy-key",
      "list",
      ...repoArgs(input.repo),
      "--json",
      Object.keys(DeployKey.fields).join(","),
    ],
    options,
  );

  // gh prints nothing, not `[]`, when the repository has no deploy keys.
  if (output.stdout.trim() === "") return [];

  return yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.Array(DeployKey)),
  )(output.stdout).pipe(
    Effect.mapError((cause) => new GhDecodeError({ cause })),
  );
});
